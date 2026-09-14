"""Private ICS display only: no Microsoft Graph calls, imports, or synchronization.

Floating dates/times use Asia/Tokyo. Recurrence supports DAILY/WEEKLY/MONTHLY/
YEARLY, one RRULE, RDATE/EXDATE and individual overrides (not RANGE/EXRULE or
RDATE periods). Subdaily expansion is intentionally rejected. Input is limited
to 1 MiB, 6,000 components, 16 KiB unfolded lines, 366-day event durations,
100,000 aggregate recurrence scan-days and 50,000 candidates per request.
Custom timezones have a separate 2,000,000 scan-day / 512 RDATE-value budget.
All untrusted parsing runs in a spawned, supervised process (8-second deadline,
two concurrent parsers per web worker, 1-second queue wait). Linux additionally
limits parser CPU/address space; event output is capped at 8 MiB.
"""

from __future__ import annotations

import hashlib
import http.client
import ipaddress
import json
import logging
import multiprocessing
import re
import socket
import ssl
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from datetime import date, datetime, time as daytime, timedelta, timezone
from itertools import islice
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from zoneinfo import ZoneInfo

from dateutil import rrule
from icalendar import Calendar, vRecur
from icalendar.timezone import tzp
from .calendar_types import MAX_CALENDAR_EVENTS, validate_window

MAX_ICS_BYTES = 1024 * 1024
MAX_COMPONENTS = 6000
MAX_LINE_BYTES = 16384
MAX_SCAN_DAYS = 100000
MAX_CANDIDATES = 50000
MAX_TIMEZONE_SCAN_DAYS = 2000000
MAX_EVENT_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_PARSER_MESSAGE_BYTES = 9 * 1024 * 1024
PARSER_SECONDS = 8
PARSER_PROCESSES = 2
MAX_DURATION = timedelta(days=366)
FETCH_SECONDS = 20
CONNECT_SECONDS = 4
READ_SECONDS = 5
MAX_REDIRECTS = 3
JST = ZoneInfo("Asia/Tokyo")
UTC = timezone.utc
# Keep the SSRF policy consistent on older container Python/ipaddress releases.
_SPECIAL_USE_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    "192.0.0.0/24", "192.88.99.0/24", "2001::/23", "3fff::/20",
))

INVALID_ICS = "有効な ICS カレンダーを読み込めません。形式・日時・文字コードを確認してください。"
UNSUPPORTED_ICS = "この ICS の繰り返し設定または期間は表示に対応していません。"
TOO_LARGE = "ICS のサイズまたは予定件数が表示上限を超えています。"
UNSAFE_URL = "公開インターネットの HTTPS（標準ポート）URL のみ利用できます。"
FETCH_FAILED = "ICS を取得できませんでした。購読先の公開設定と接続状態を確認してください。"
PARSER_LIMIT = "ICS の解析が処理時間またはメモリ上限に達しました。時間をおいて再試行してください。"
_PARSER_FAILURE = json.dumps(
    {"ok": False, "message": PARSER_LIMIT, "status_code": 422},
    ensure_ascii=False,
).encode("utf-8")
logger = logging.getLogger(__name__)


class FeedError(Exception):
    """Only fixed, non-sensitive messages may cross this boundary."""

    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


def require_feed_key() -> None:
    from .config import settings

    if settings.auth_mode == "entra" and not (settings.sensitive_enc_key or "").strip():
        raise FeedError("ICS の暗号化キーが未設定です。管理者に連絡してください。", 503)


def ensure_calendar_feeds_schema() -> None:
    from sqlalchemy import text
    from .db import engine

    with engine.begin() as cn:
        cn.execute(text("SELECT pg_advisory_xact_lock(918273649)"))
        cn.execute(text(Path(__file__).with_name("calendar_feeds_schema.sql").read_text(encoding="utf-8")))


def _public_ip(value: str):
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        raise FeedError(UNSAFE_URL) from None
    mapped = getattr(address, "ipv4_mapped", None)
    if mapped is not None:
        _public_ip(str(mapped))
    if (
        not address.is_global or address.is_multicast or address.is_reserved
        or address.is_loopback or address.is_link_local or address.is_unspecified
        or getattr(address, "is_site_local", False)
        or any(address in network for network in _SPECIAL_USE_NETWORKS)
        or getattr(address, "sixtofour", None) is not None
        or getattr(address, "teredo", None) is not None
        or str(address) == "168.63.129.16"
    ):
        raise FeedError(UNSAFE_URL)
    return address


def validate_feed_url(value: str) -> tuple[str, str]:
    try:
        if (
            not isinstance(value, str) or not value or len(value) > 2048
            or any(ord(c) <= 32 or ord(c) == 127 for c in value) or "\\" in value
        ):
            raise ValueError
        parsed = urlsplit(value)
        if (
            parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or "#" in value or parsed.port not in (None, 443)
            or "%" in parsed.hostname
        ):
            raise ValueError
        host = parsed.hostname.encode("idna").decode("ascii").lower()
        if len(host) > 253:
            raise ValueError
        try:
            literal = ipaddress.ip_address(host)
        except ValueError:
            if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.?", host):
                raise ValueError
            if any(not label or len(label) > 63 for label in host.rstrip(".").split(".")):
                raise ValueError
        else:
            _public_ip(str(literal))
        target = parsed.path or "/"
        if parsed.query:
            target += "?" + parsed.query
        # Subscription URLs must be URI-encoded before storage; no implicit rewriting.
        target.encode("ascii")
        return host, target
    except FeedError:
        raise
    except (ValueError, UnicodeError):
        raise FeedError(UNSAFE_URL) from None


_resolver = ThreadPoolExecutor(max_workers=4, thread_name_prefix="calendar-dns")
_resolver_slots = threading.BoundedSemaphore(4)
_ical_lock = threading.Lock()
_parser_slots = threading.BoundedSemaphore(PARSER_PROCESSES)


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise FeedError(FETCH_FAILED, 502)
    return remaining


def _resolve(host: str, deadline: float) -> list[tuple[int, str]]:
    # getaddrinfo has no timeout. Bound both outstanding DNS jobs and caller wait.
    if not _resolver_slots.acquire(blocking=False):
        raise FeedError(FETCH_FAILED, 502)
    try:
        future = _resolver.submit(socket.getaddrinfo, host, 443, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except Exception:
        _resolver_slots.release()
        raise FeedError(FETCH_FAILED, 502) from None
    future.add_done_callback(lambda _: _resolver_slots.release())
    try:
        answers = future.result(timeout=min(CONNECT_SECONDS, _remaining(deadline)))
    except (OSError, FutureTimeout):
        raise FeedError(FETCH_FAILED, 502) from None
    addresses = []
    for family, socktype, proto, canonname, sockaddr in answers:
        if family not in (socket.AF_INET, socket.AF_INET6):
            raise FeedError(UNSAFE_URL)
        address = str(_public_ip(sockaddr[0]))
        if (family, address) not in addresses:
            addresses.append((family, address))
    if not addresses:
        raise FeedError(FETCH_FAILED, 502)
    return addresses


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Connect to an already validated IP; verify TLS against the original host."""

    def __init__(self, host: str, address: tuple[int, str], deadline: float):
        super().__init__(host, port=443, context=ssl.create_default_context())
        self.address = address
        self.deadline = deadline
        self._transport = None

    def connect(self):
        family, ip = self.address
        raw = socket.socket(family, socket.SOCK_STREAM)
        self.sock = raw
        self._transport = raw
        raw.settimeout(min(CONNECT_SECONDS, _remaining(self.deadline)))
        try:
            raw.connect((ip, 443) if family == socket.AF_INET else (ip, 443, 0, 0))
            raw.settimeout(min(CONNECT_SECONDS, _remaining(self.deadline)))
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
            self._transport = self.sock
            self.sock.settimeout(min(READ_SECONDS, _remaining(self.deadline)))
        except Exception:
            raw.close()
            raise

    def abort(self):
        # shutdown, not just close: response.makefile() otherwise retains the FD.
        # HTTPConnection drops .sock for Connection: close responses, while the
        # HTTPResponse still holds a live socket file. Retain that transport.
        sock = self._transport if self._transport is not None else self.sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()


def fetch_ics(value: str) -> str:
    """Fresh, cookie-free HTTPS fetch. No environment proxies or hostname reconnect."""
    deadline = time.monotonic() + FETCH_SECONDS
    try:
        for redirect in range(MAX_REDIRECTS + 1):
            host, target = validate_feed_url(value)
            addresses = _resolve(host, deadline)  # Validate ALL answers, not just the selected one.
            connection = _PinnedHTTPSConnection(host, addresses[0], deadline)
            timer = threading.Timer(_remaining(deadline), connection.abort)
            timer.daemon = True
            timer.start()
            response = None
            try:
                connection.request("GET", target, headers={
                    "Accept": "text/calendar, text/plain, application/octet-stream",
                    "Accept-Encoding": "identity",
                    "User-Agent": "MOUNTAIN-Calendar/1.0",
                    "Connection": "close",
                })
                response = connection.getresponse()
                if response.status in (301, 302, 303, 307, 308):
                    location = response.getheader("Location")
                    if redirect == MAX_REDIRECTS or not location or len(location) > 2048:
                        raise FeedError(FETCH_FAILED, 502)
                    value = urljoin(value, location)
                    continue
                if response.status != 200:
                    raise FeedError(FETCH_FAILED, 502)
                if response.getheader("Content-Encoding", "identity").strip().lower() != "identity":
                    raise FeedError("圧縮された ICS 応答には対応していません。", 502)
                length = response.getheader("Content-Length")
                if length is not None and (not length.isdigit() or int(length) > MAX_ICS_BYTES):
                    raise FeedError(TOO_LARGE, 502)
                body = bytearray()
                while True:
                    _remaining(deadline)
                    chunk = response.read1(min(65536, MAX_ICS_BYTES + 1 - len(body)))
                    if not chunk:
                        break
                    body.extend(chunk)
                    if len(body) > MAX_ICS_BYTES:
                        raise FeedError(TOO_LARGE, 502)
                _remaining(deadline)
                if length is not None and len(body) != int(length):
                    raise FeedError(FETCH_FAILED, 502)
                # Unfold bytes first: some producers fold inside a UTF-8 sequence.
                unfolded = bytes(body).replace(b"\r\n ", b"").replace(b"\r\n\t", b"")
                return unfolded.decode("utf-8-sig", errors="strict")
            finally:
                timer.cancel()
                if response is not None:
                    response.close()
                connection.close()
        raise FeedError(FETCH_FAILED, 502)
    except FeedError:
        raise
    except (OSError, ValueError, UnicodeError, http.client.HTTPException):
        raise FeedError(FETCH_FAILED, 502) from None


def _unfold(content: str) -> list[str]:
    try:
        if len(content.encode("utf-8")) > MAX_ICS_BYTES:
            raise FeedError(TOO_LARGE)
    except UnicodeError:
        raise FeedError(INVALID_ICS) from None
    lines: list[str] = []
    for line in content.lstrip("\ufeff").splitlines():
        if line.startswith((" ", "\t")) and lines:
            lines[-1] += line[1:]
        else:
            lines.append(line)
        if len(lines) > 30000 or len(lines[-1].encode("utf-8")) > MAX_LINE_BYTES:
            raise FeedError(TOO_LARGE)
    return lines


def _datetime(value, prop=None) -> datetime:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            if prop is not None and prop.params.get("TZID"):
                raise FeedError("ICS のタイムゾーンを解釈できません。")
            value = value.replace(tzinfo=JST)
        if value.utcoffset() is None:
            raise FeedError(INVALID_ICS)
        return value
    if isinstance(value, date):
        return datetime.combine(value, daytime.min, JST)
    raise FeedError(INVALID_ICS)


def _stamp(component, name: str):
    prop = component.get(name)
    if prop is None or not hasattr(prop, "dt"):
        raise FeedError(INVALID_ICS)
    return prop.dt, _datetime(prop.dt, prop)


def _key(value) -> str:
    if isinstance(value, datetime):
        return _datetime(value).astimezone(UTC).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    raise FeedError(INVALID_ICS)


def _duration(component, fallback=None) -> tuple[datetime, timedelta, bool]:
    raw, start = _stamp(component, "DTSTART")
    all_day = not isinstance(raw, datetime)
    if component.get("DTEND") is not None:
        raw_end, end = _stamp(component, "DTEND")
        if all_day != (not isinstance(raw_end, datetime)) or component.get("DURATION") is not None:
            raise FeedError(INVALID_ICS)
        duration = end - start
    elif component.get("DURATION") is not None:
        duration = component.decoded("DURATION")
    else:
        duration = fallback if fallback is not None else timedelta(days=1 if all_day else 0)
    if (
        not isinstance(duration, timedelta) or duration < timedelta(0) or duration > MAX_DURATION
        or (all_day and (duration < timedelta(days=1) or duration.seconds or duration.microseconds))
    ):
        raise FeedError(UNSUPPORTED_ICS)
    try:
        start + duration
    except OverflowError:
        raise FeedError(INVALID_ICS) from None
    return start, duration, all_day


_FREQUENCIES = {name: getattr(rrule, name) for name in ("DAILY", "WEEKLY", "MONTHLY", "YEARLY")}
_WEEKDAYS = {name: getattr(rrule, name) for name in ("MO", "TU", "WE", "TH", "FR", "SA", "SU")}
_RULE_KEYS = {"FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTH", "BYMONTHDAY", "BYSETPOS", "WKST"}


def _rule_options(rule, start: datetime, all_day: bool) -> dict:
    if not hasattr(rule, "keys") or set(rule.keys()) - _RULE_KEYS:
        raise FeedError(UNSUPPORTED_ICS)
    if len(rule.get("FREQ", [])) != 1 or str(rule["FREQ"][0]) not in _FREQUENCIES:
        raise FeedError(UNSUPPORTED_ICS)
    frequency = str(rule["FREQ"][0])
    options = {"freq": _FREQUENCIES[frequency], "dtstart": start}
    for key, maximum in (("INTERVAL", 366), ("COUNT", MAX_CANDIDATES)):
        if key in rule:
            if len(rule[key]) != 1 or not 1 <= int(rule[key][0]) <= maximum:
                raise FeedError(UNSUPPORTED_ICS)
            options[key.lower()] = int(rule[key][0])
    if "UNTIL" in rule:
        if len(rule["UNTIL"]) != 1 or "COUNT" in rule:
            raise FeedError(UNSUPPORTED_ICS)
        until = rule["UNTIL"][0]
        if all_day != (not isinstance(until, datetime)):
            raise FeedError(UNSUPPORTED_ICS)
        options["until"] = _datetime(until)
    for key, limit, low, high in (
        ("BYMONTH", 12, 1, 12), ("BYMONTHDAY", 62, -31, 31), ("BYSETPOS", 31, -366, 366),
    ):
        if key in rule:
            values = [int(v) for v in rule[key]]
            if not values or len(values) > limit or any(v == 0 or not low <= v <= high for v in values):
                raise FeedError(UNSUPPORTED_ICS)
            options[key.lower()] = values
    if "BYSETPOS" in rule and not ({"BYDAY", "BYMONTH", "BYMONTHDAY"} & set(rule.keys())):
        raise FeedError(UNSUPPORTED_ICS)
    if frequency == "WEEKLY" and "BYMONTHDAY" in rule:
        raise FeedError(UNSUPPORTED_ICS)
    if "BYDAY" in rule:
        if not 1 <= len(rule["BYDAY"]) <= 31:
            raise FeedError(UNSUPPORTED_ICS)
        weekdays = []
        for value in rule["BYDAY"]:
            match = re.fullmatch(r"([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)", str(value))
            if not match:
                raise FeedError(UNSUPPORTED_ICS)
            ordinal, day = match.groups()
            weekday = _WEEKDAYS[day]
            if ordinal is not None:
                number = int(ordinal)
                if frequency not in ("MONTHLY", "YEARLY") or not -53 <= number <= 53 or number == 0:
                    raise FeedError(UNSUPPORTED_ICS)
                weekday = weekday(number)
            weekdays.append(weekday)
        options["byweekday"] = weekdays
    if "WKST" in rule:
        if len(rule["WKST"]) != 1 or str(rule["WKST"][0]) not in _WEEKDAYS:
            raise FeedError(UNSUPPORTED_ICS)
        options["wkst"] = _WEEKDAYS[str(rule["WKST"][0])]
    return options


def _dates(component, name: str, all_day: bool) -> list[datetime]:
    props = component.get(name, [])
    if not isinstance(props, list):
        props = [props]
    dates = []
    for prop in props:
        if not hasattr(prop, "dts"):
            raise FeedError(UNSUPPORTED_ICS)
        for item in prop.dts:
            if isinstance(item.dt, tuple) or all_day != (not isinstance(item.dt, datetime)):
                raise FeedError(UNSUPPORTED_ICS)
            dates.append(_datetime(item.dt, prop))
            if len(dates) > MAX_CALENDAR_EVENTS:
                raise FeedError(TOO_LARGE)
    return dates


def _bound_timezone_work(lines: list[str]) -> None:
    starts = []
    years = []
    transition_start = None
    in_transition = has_rule = False
    rdates = 0
    for line in lines:
        upper = line.upper()
        if upper in ("BEGIN:STANDARD", "BEGIN:DAYLIGHT"):
            in_transition, has_rule, transition_start = True, False, None
        elif upper in ("END:STANDARD", "END:DAYLIGHT"):
            if has_rule:
                if transition_start is None:
                    raise FeedError(INVALID_ICS)
                starts.append(transition_start)
            in_transition = False
        key = re.split(r"[:;]", upper, maxsplit=1)[0]
        if key in ("DTSTART", "DTEND", "RECURRENCE-ID", "RDATE", "EXDATE", "RRULE"):
            found = [int(year) for year in re.findall(r"(?<!\d)(\d{4})\d{4}(?:T\d{6}Z?)?(?!\d)", upper)]
            years.extend(found)
            if key == "RDATE" and in_transition:
                rdates += len(found)
                if rdates > 512:
                    raise FeedError(TOO_LARGE)
            if key == "DTSTART" and in_transition and found:
                transition_start = min(found)
        if key == "RRULE" and in_transition:
            if has_rule:
                raise FeedError(UNSUPPORTED_ICS)
            has_rule = True
    # tzical uses dateutil recurrence internally during UTC-offset lookup, before
    # event expansion. Budget its historical scans separately, including invalid
    # sparse rules, rather than relying only on the visible event count.
    latest_year = max(years, default=1)
    if sum(max(0, latest_year - year + 1) * 366 for year in starts) > MAX_TIMEZONE_SCAN_DAYS:
        raise FeedError(UNSUPPORTED_ICS)


def _load_ics(content: str) -> tuple[list, list[str]]:
    lines = _unfold(content)
    if not lines or lines[0].upper() != "BEGIN:VCALENDAR" or lines[-1].upper() != "END:VCALENDAR":
        raise FeedError(INVALID_ICS)
    stack = []
    components = timezones = transitions = 0
    for line in lines:
        upper = line.upper()
        if upper.startswith("BEGIN:"):
            name = upper[6:]
            parent = stack[-1] if stack else None
            if (
                (name == "VCALENDAR" and parent is not None)
                or (name in ("VEVENT", "VTIMEZONE") and parent != "VCALENDAR")
                or (name in ("STANDARD", "DAYLIGHT") and parent != "VTIMEZONE")
                or (name == "VALARM" and parent != "VEVENT")
            ):
                raise FeedError(INVALID_ICS)
            stack.append(name)
            components += 1
            timezones += stack[-1] == "VTIMEZONE"
            transitions += stack[-1] in ("STANDARD", "DAYLIGHT")
            if len(stack) > 4 or components > MAX_COMPONENTS or timezones > 16 or transitions > 64:
                raise FeedError(TOO_LARGE)
        elif upper.startswith("END:"):
            if not stack or stack.pop() != upper[4:]:
                raise FeedError(INVALID_ICS)
        elif upper.startswith("RRULE") and "VTIMEZONE" in stack:
            # Custom timezone definitions are parsed by icalendar, never unbounded subdaily rules.
            if not re.search(r"(?:^|[:;])FREQ=YEARLY(?:;|$)", upper) or any(
                item in upper for item in ("BYSECOND", "BYMINUTE", "BYHOUR", "COUNT=")
            ):
                raise FeedError(UNSUPPORTED_ICS)
            _rule_options(vRecur.from_ical(line.split(":", 1)[1]), datetime(2000, 1, 1, tzinfo=JST), False)
    if stack:
        raise FeedError(INVALID_ICS)
    _bound_timezone_work(lines)
    # icalendar 6 caches custom TZIDs globally. Isolate each parse so one user's
    # VTIMEZONE neither changes another feed nor accumulates an unbounded cache.
    with _ical_lock:
        tzp.use_default()
        try:
            calendar = Calendar.from_ical("\r\n".join(lines) + "\r\n")
        finally:
            tzp.use_default()
    if calendar.name != "VCALENDAR" or str(calendar.get("VERSION", "")) != "2.0":
        raise FeedError(INVALID_ICS)
    warnings = set()
    for component in calendar.walk():
        if component.errors:
            raise FeedError(INVALID_ICS)
        if component.name not in ("VCALENDAR", "VEVENT", "VTIMEZONE", "STANDARD", "DAYLIGHT"):
            warnings.add("予定以外の要素（通知・タスク等）は表示しません。")
    events = calendar.walk("VEVENT")
    if str(calendar.get("METHOD", "")).upper() == "CANCEL":
        for component in events:
            component["STATUS"] = "CANCELLED"
    versions = {}
    single = (
        "UID", "DTSTART", "DTEND", "DURATION", "RECURRENCE-ID", "RRULE", "SEQUENCE",
        "SUMMARY", "DESCRIPTION", "LOCATION", "URL", "STATUS", "DTSTAMP", "LAST-MODIFIED",
    )
    for component in events:
        if any(isinstance(component.get(key), list) for key in single):
            raise FeedError(UNSUPPORTED_ICS)
        uid = str(component.get("UID", ""))
        if not uid or len(uid) > 1024 or component.get("EXRULE") is not None:
            raise FeedError(UNSUPPORTED_ICS)
        if component.get("ATTACH") is not None:
            warnings.add("ICS の添付ファイルは読み込みません。")
        if component.get("RECURRENCE-ID") is not None:
            prop = component["RECURRENCE-ID"]
            if prop.params.get("RANGE") or component.get("RRULE") is not None:
                raise FeedError(UNSUPPORTED_ICS)
            raw, normalized = _stamp(component, "RECURRENCE-ID")
            recurrence_id = _key(normalized if isinstance(raw, datetime) else raw)
        else:
            recurrence_id = ""
        status = str(component.get("STATUS", "")).upper()
        if status not in ("", "CANCELLED", "CONFIRMED", "TENTATIVE"):
            raise FeedError(INVALID_ICS)
        if status != "CANCELLED":
            start, duration, all_day = _duration(component)
            if component.get("RRULE") is not None:
                _rule_options(component["RRULE"], start, all_day)
            _dates(component, "RDATE", all_day)
            _dates(component, "EXDATE", all_day)
        sequence = int(component.get("SEQUENCE", 0))
        if not 0 <= sequence <= 2147483647:
            raise FeedError(INVALID_ICS)
        revision = datetime.min.replace(tzinfo=UTC)
        for name in ("LAST-MODIFIED", "DTSTAMP"):
            if component.get(name) is not None:
                revision = max(revision, _stamp(component, name)[1].astimezone(UTC))
        key = (uid, recurrence_id)
        rank = (sequence, revision)
        if key not in versions or rank >= versions[key][0]:
            versions[key] = (rank, component)
    return [value[1] for value in versions.values()], sorted(warnings)


def _validate_ics_content(content: str) -> None:
    try:
        _load_ics(content)
    except FeedError:
        raise
    except Exception:
        # Library diagnostics can contain entire lines, URLs and subscription secrets.
        raise FeedError(INVALID_ICS) from None


def _web_url(value) -> str | None:
    value = str(value or "")
    try:
        parsed = urlsplit(value)
        if (
            len(value) <= 2048 and parsed.scheme in ("http", "https") and parsed.hostname
            and parsed.username is None and parsed.password is None
            and not any(ord(c) <= 32 or ord(c) == 127 for c in value) and "\\" not in value
        ):
            return value
    except ValueError:
        pass
    return None


def _parse_ics_content(content: str, start: datetime, end: datetime, feed_id: str) -> dict:
    start, end = validate_window(start, end)
    try:
        components, warnings = _load_ics(content)
        series = {}
        for component in components:
            series.setdefault(str(component["UID"]), []).append(component)
        output = []
        output_bytes = 0
        scan_days = candidates = 0
        for uid, members in series.items():
            master = next((item for item in members if item.get("RECURRENCE-ID") is None), None)
            overrides = [item for item in members if item.get("RECURRENCE-ID") is not None]
            if master is not None and str(master.get("STATUS", "")).upper() == "CANCELLED":
                continue
            duration = None
            excluded = set()
            occurrences = {}
            if master is not None:
                master_start, duration, all_day = _duration(master)
                excluded = {_key(v.date() if all_day else v) for v in _dates(master, "EXDATE", all_day)}
                occurrences[_key(master_start.date() if all_day else master_start)] = (master_start, master)
                for value in _dates(master, "RDATE", all_day):
                    occurrences[_key(value.date() if all_day else value)] = (value, master)
                rule = master.get("RRULE")
                if rule is not None and master_start < end:
                    options = _rule_options(rule, master_start, all_day)
                    # Do not first convert a distant end into a custom timezone:
                    # that offset lookup itself can expand historical transitions.
                    until = min(end, options.get("until", end))
                    scan_days += max(0, (until - master_start).days + 1)
                    if scan_days > MAX_SCAN_DAYS:
                        raise FeedError(UNSUPPORTED_ICS)
                    options["until"] = until
                    count = options.pop("count", None)
                    instances = rrule.rrule(**options)
                    if count is not None:
                        instances = islice(instances, count)
                    for value in instances:
                        candidates += 1
                        if candidates > MAX_CANDIDATES:
                            raise FeedError(TOO_LARGE)
                        occurrences[_key(value.date() if all_day else value)] = (value, master)
            elif overrides:
                warnings.append("元の繰り返し予定がない変更予定は単独で表示します。")
            for override in overrides:
                raw, recurrence = _stamp(override, "RECURRENCE-ID")
                recurrence_id = _key(raw if not isinstance(raw, datetime) else recurrence)
                if master is not None and all_day != (not isinstance(raw, datetime)):
                    raise FeedError(UNSUPPORTED_ICS)
                occurrences.pop(recurrence_id, None)
                if str(override.get("STATUS", "")).upper() != "CANCELLED":
                    replacement, override_duration, override_all_day = _duration(override, duration)
                    if master is not None and all_day != override_all_day:
                        raise FeedError(UNSUPPORTED_ICS)
                    # A detached update can move into the window from any original date.
                    occurrences[recurrence_id] = (replacement, override)
                    excluded.discard(recurrence_id)
            for recurrence_id, (event_start, component) in occurrences.items():
                if recurrence_id in excluded:
                    continue
                _, event_duration, event_all_day = _duration(component, duration)
                event_end = event_start + event_duration
                if not (event_start < end and (event_end > start or event_start == event_end >= start)):
                    continue
                def field(name):
                    return component.get(name, master.get(name) if master is not None else None)
                stable_id = hashlib.sha256(f"{uid}\0{recurrence_id}".encode("utf-8")).hexdigest()
                item = {
                    "id": f"feed:{feed_id}:{stable_id}",
                    "title": str(field("SUMMARY") or "（無題）"),
                    "start": event_start.date().isoformat() if event_all_day else event_start.astimezone(UTC).isoformat(),
                    "end": event_end.date().isoformat() if event_all_day else event_end.astimezone(UTC).isoformat(),
                    "all_day": event_all_day,
                    "location": str(field("LOCATION")) if field("LOCATION") is not None else None,
                    "description": str(field("DESCRIPTION")) if field("DESCRIPTION") is not None else None,
                    "web_url": _web_url(field("URL")),
                    "source": f"feed:{feed_id}",
                    "tentative": str(field("STATUS") or "").upper() == "TENTATIVE",
                }
                output_bytes += len(json.dumps(item, ensure_ascii=False).encode("utf-8"))
                if output_bytes > MAX_EVENT_OUTPUT_BYTES:
                    raise FeedError(TOO_LARGE)
                output.append(item)
                if len(output) > MAX_CALENDAR_EVENTS:
                    raise FeedError(TOO_LARGE)
        output.sort(key=lambda item: (item["start"], item["id"]))
        return {"events": output, "warnings": sorted(set(warnings))}
    except FeedError:
        raise
    except Exception:
        raise FeedError(INVALID_ICS) from None


def _parser_worker(channel, mode: str, content: str, start, end, feed_id: str) -> None:
    """No network/database operations; this process only parses bounded text."""
    stage = "limits"
    try:
        try:
            import resource
        except ImportError:
            pass  # Windows is still supervised by the parent's hard wall-clock deadline.
        else:
            cpu_hard = resource.getrlimit(resource.RLIMIT_CPU)[1]
            cpu_limit = PARSER_SECONDS + 1 if cpu_hard == resource.RLIM_INFINITY else min(PARSER_SECONDS + 1, cpu_hard)
            resource.setrlimit(resource.RLIMIT_CPU, (min(PARSER_SECONDS, cpu_limit), cpu_limit))
            hard_limit = resource.getrlimit(resource.RLIMIT_AS)[1]
            memory_limit = 512 * 1024 * 1024
            if hard_limit != resource.RLIM_INFINITY:
                memory_limit = min(memory_limit, hard_limit)
            resource.setrlimit(resource.RLIMIT_AS, (memory_limit, memory_limit))
        stage = "parse"
        if mode == "validate":
            result = _validate_ics_content(content)
        else:
            result = _parse_ics_content(content, start, end, feed_id)
        stage = "serialize"
        payload = json.dumps({"ok": True, "result": result}, ensure_ascii=False).encode("utf-8")
        if len(payload) > MAX_PARSER_MESSAGE_BYTES:
            payload = _PARSER_FAILURE
    except FeedError as exc:
        payload = json.dumps({
            "ok": False, "message": str(exc), "status_code": exc.status_code,
        }, ensure_ascii=False).encode("utf-8")
    except BaseException as exc:
        try:
            logger.warning("ICS parser worker failed (stage=%s; type=%s)", stage, type(exc).__name__)
        except BaseException:
            pass
        payload = _PARSER_FAILURE
    try:
        channel.send_bytes(payload)
    finally:
        channel.close()


def _run_parser(mode: str, content: str, start=None, end=None, feed_id: str = ""):
    try:
        if len(content.encode("utf-8")) > MAX_ICS_BYTES:
            raise FeedError(TOO_LARGE)
    except UnicodeError:
        raise FeedError(INVALID_ICS) from None
    if not _parser_slots.acquire(timeout=1):
        raise FeedError("ICS の解析が混み合っています。時間をおいて再試行してください。", 503)
    parent = child = process = timer = None
    expired = threading.Event()
    started = time.monotonic()

    def kill_parser():
        expired.set()
        if process is not None:
            try:
                if process.is_alive():
                    process.kill()
            except (OSError, ValueError, AssertionError):
                pass

    try:
        # Spawn rather than fork: never inherit a web worker's connections or locks.
        context = multiprocessing.get_context("spawn")
        parent, child = context.Pipe(duplex=False)
        process = context.Process(
            target=_parser_worker, args=(child, mode, content, start, end, feed_id), daemon=True,
        )
        process.start()
        child.close()
        timer = threading.Timer(PARSER_SECONDS, kill_parser)
        timer.daemon = True
        timer.start()
        if not parent.poll(PARSER_SECONDS):
            raise FeedError(PARSER_LIMIT)
        # The watchdog also kills a worker that stalls halfway through sending.
        message = parent.recv_bytes(MAX_PARSER_MESSAGE_BYTES)
        if expired.is_set():
            raise FeedError(PARSER_LIMIT)
        reply = json.loads(message)
        if not reply["ok"]:
            raise FeedError(reply["message"], reply["status_code"])
        return reply["result"]
    except FeedError as exc:
        if str(exc) == PARSER_LIMIT:
            logger.warning(
                "ICS parser limit (mode=%s; exit=%s; deadline=%s; elapsed=%.3fs)",
                mode, process.exitcode if process is not None else None,
                expired.is_set(), time.monotonic() - started,
            )
        raise
    except (OSError, EOFError, ValueError, RuntimeError) as exc:
        logger.warning(
            "ICS parser IPC failed (type=%s; exit=%s; deadline=%s; elapsed=%.3fs)",
            type(exc).__name__, process.exitcode if process is not None else None,
            expired.is_set(), time.monotonic() - started,
        )
        raise FeedError(PARSER_LIMIT) from None
    finally:
        reusable_slot = True
        if timer is not None:
            timer.cancel()
        if process is not None and process.pid is not None:
            process.join(timeout=0.1)
            if process.is_alive():
                kill_parser()
                process.join(timeout=1)
            if not process.is_alive():
                process.close()
            else:
                # If the OS cannot reap a killed process yet, retain its slot
                # rather than permit unbounded replacement processes.
                reusable_slot = False
        if parent is not None:
            parent.close()
        if child is not None:
            child.close()
        if reusable_slot:
            _parser_slots.release()


def validate_ics(content: str) -> None:
    _run_parser("validate", content)


def parse_ics(content: str, start: datetime, end: datetime, feed_id: str) -> dict:
    start, end = validate_window(start, end)
    return _run_parser("events", content, start, end, feed_id)
