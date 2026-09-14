from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

import httpx

from .calendar import CalendarError, acquire_graph_token, calendar_connection_reason
from .calendar_types import MAX_CALENDAR_EVENTS, validate_window
from .config import settings

JST = timezone(timedelta(hours=9))
MAX_PAGE_BYTES = 4 * 1024 * 1024
MAX_TOTAL_BYTES = 16 * 1024 * 1024
MAX_PAGES = 20
FETCH_SECONDS = 60
Source = Literal["personal", "group"]


def calendar_availability() -> dict:
    personal_reason = calendar_connection_reason(group=False)
    group_reason = calendar_connection_reason(group=True)
    return {
        "personal": {"enabled": personal_reason is None, "reason": personal_reason},
        "group": {
            "enabled": group_reason is None, "reason": group_reason,
            "name": settings.calendar_name.strip() or "共通カレンダー",
        },
    }


class _BodyText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.hidden += 1
        if not self.hidden and tag in ("br", "p", "div", "li", "tr"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.hidden:
            self.hidden -= 1
        if not self.hidden and tag in ("p", "div", "li", "tr"):
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def _event_datetime(value: object) -> datetime:
    if not isinstance(value, dict) or not isinstance(value.get("dateTime"), str):
        raise ValueError("Invalid event date")
    parsed = datetime.fromisoformat(value["dateTime"])
    if parsed.tzinfo is None:
        if value.get("timeZone") not in ("UTC", "Etc/UTC"):
            raise ValueError("Unexpected event timezone")
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _optional_text(value: object) -> str | None:
    if value is not None and not isinstance(value, str):
        raise ValueError("Invalid event text")
    return value or None


def _normalize_event(item: object, source: Source) -> dict | None:
    if not isinstance(item, dict):
        raise ValueError("Invalid event")
    if item.get("isCancelled") is True:
        return None
    identifier = item.get("id")
    if not isinstance(identifier, str) or not identifier:
        raise ValueError("Missing event id")
    start, end = _event_datetime(item.get("start")), _event_datetime(item.get("end"))
    if end < start:
        raise ValueError("Invalid event range")
    all_day = item.get("isAllDay", False)
    if not isinstance(all_day, bool):
        raise ValueError("Invalid all-day value")
    location = item.get("location") or {}
    body = item.get("body") or {}
    if not isinstance(location, dict) or not isinstance(body, dict):
        raise ValueError("Invalid event detail")
    description = _optional_text(body.get("content"))
    if description and (_optional_text(body.get("contentType")) or "").lower() == "html":
        parser = _BodyText()
        parser.feed(description)
        description = "".join(parser.parts).strip()
    web_url = _optional_text(item.get("webLink"))
    if web_url:
        parsed_url = urlsplit(web_url)
        if (
            parsed_url.scheme != "https" or not parsed_url.hostname
            or parsed_url.username or parsed_url.password
        ):
            web_url = None
    if all_day:
        start_value, end_value = start.astimezone(JST).date(), end.astimezone(JST).date()
        if end_value <= start_value:
            raise ValueError("Invalid all-day range")
    else:
        start_value, end_value = start, end
    return {
        "id": identifier, "source": source,
        "title": _optional_text(item.get("subject")) or "(件名なし)",
        "start": start_value.isoformat(), "end": end_value.isoformat(), "all_day": all_day,
        "location": _optional_text(location.get("displayName")),
        "description": description, "web_url": web_url,
        "tentative": (_optional_text(item.get("showAs")) or "").lower() == "tentative",
    }


def _page_url(value: object, expected_path: str) -> httpx.URL:
    if not isinstance(value, str):
        raise CalendarError("Microsoft 365 のページ情報が不正です。再試行してください。")
    try:
        url = httpx.URL(value)
    except httpx.InvalidURL as exc:
        raise CalendarError("Microsoft 365 のページ情報が不正です。再試行してください。") from exc
    if (
        url.scheme != "https" or url.host != "graph.microsoft.com" or url.port not in (None, 443)
        or url.userinfo or url.fragment or url.path != expected_path
    ):
        raise CalendarError("Microsoft 365 のページ情報が不正です。再試行してください。")
    return url


def _check_graph_status(status: int, source: Source) -> None:
    if status == 200:
        return
    if status == 403:
        permission = "Calendars.Read" if source == "personal" else "Group.ReadWrite.All"
        raise CalendarError(
            f"予定表の読み取りが拒否されました。管理者に {permission} の委任権限・"
            "管理者同意と、対象予定表へのアクセス権を確認してください。"
        )
    if status == 401:
        raise CalendarError("予定表用の認証が拒否されました。Microsoft 365 に再サインインしてください。")
    if status == 404:
        raise CalendarError("予定表が見つかりません。メールボックスまたはグループ設定を確認してください。")
    if status == 429:
        raise CalendarError("Microsoft 365 の要求上限に達しました。時間を置いて再試行してください。")
    raise CalendarError(f"予定表を取得できませんでした（HTTP {status}）。")


def read_calendar_events(assertion: str, source: Source, start: datetime, end: datetime) -> dict:
    start, end = validate_window(start, end)
    path = (
        f"/v1.0/groups/{UUID(settings.calendar_group_id)}/calendarView"
        if source == "group" else "/v1.0/me/calendar/calendarView"
    )
    url = httpx.URL(f"https://graph.microsoft.com{path}", params={
        "startDateTime": start.isoformat(), "endDateTime": end.isoformat(), "$top": "500",
        "$select": "id,subject,start,end,isAllDay,isCancelled,location,body,webLink,showAs",
    })
    deadline = time.monotonic() + FETCH_SECONDS
    seen: set[str] = set()
    events: dict[str, dict] = {}
    total_bytes = 0
    total_events = 0
    try:
        with httpx.Client(timeout=20, follow_redirects=False, trust_env=False) as client:
            token = acquire_graph_token(client, assertion)
            headers = {
                "Authorization": f"Bearer {token}",
                "Prefer": 'outlook.timezone="UTC", outlook.body-content-type="text"',
            }
            for _ in range(MAX_PAGES):
                if str(url) in seen:
                    raise CalendarError("予定表のページが循環しています。再試行してください。")
                seen.add(str(url))
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise CalendarError("予定表の取得が時間上限を超えました。表示期間を短くしてください。")
                with client.stream("GET", url, headers=headers, timeout=min(20, remaining)) as response:
                    _check_graph_status(response.status_code, source)
                    chunks = bytearray()
                    for chunk in response.iter_bytes(chunk_size=65536):
                        total_bytes += len(chunk)
                        chunks.extend(chunk)
                        if len(chunks) > MAX_PAGE_BYTES or total_bytes > MAX_TOTAL_BYTES:
                            raise CalendarError("予定表のデータ量が上限を超えました。表示期間を短くしてください。")
                        if time.monotonic() > deadline:
                            raise CalendarError("予定表の取得が時間上限を超えました。表示期間を短くしてください。")
                page = json.loads(chunks)
                if not isinstance(page, dict) or not isinstance(page.get("value"), list):
                    raise ValueError("Invalid calendar page")
                total_events += len(page["value"])
                if total_events > MAX_CALENDAR_EVENTS:
                    raise CalendarError(
                        f"予定が {MAX_CALENDAR_EVENTS} 件を超えています。表示期間を短くしてください。"
                    )
                for item in page["value"]:
                    event = _normalize_event(item, source)
                    if event:
                        events[event["id"]] = event
                next_link = page.get("@odata.nextLink")
                if not next_link:
                    return {
                        "events": sorted(events.values(), key=lambda event: (event["start"], event["id"])),
                        "warnings": [],
                    }
                url = _page_url(next_link, path)
    except httpx.HTTPError as exc:
        raise CalendarError("Microsoft 365 の予定表を取得できませんでした。時間を置いて再試行してください。") from exc
    except (ValueError, TypeError, OverflowError, RecursionError) as exc:
        raise CalendarError("Microsoft 365 の予定データが不正です。表示を更新してください。") from exc
    raise CalendarError("予定表のページ数が上限を超えました。表示期間を短くしてください。")
