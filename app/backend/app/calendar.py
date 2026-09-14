from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping
from uuid import UUID

import httpx
from fastapi import HTTPException, Request
from pydantic import AwareDatetime, BaseModel, ConfigDict, field_validator, model_validator
from sqlalchemy import text

from .auth import CurrentUser
from .config import settings
from .db import engine

logger = logging.getLogger(__name__)


class CalendarIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: UUID
    starts_at: AwareDatetime
    ends_at: AwareDatetime

    @field_validator("starts_at", "ends_at", mode="before")
    @classmethod
    def require_datetime(cls, value):
        if not isinstance(value, (str, datetime)):
            raise ValueError("予定日時はタイムゾーン付きの日時で指定してください")
        return value

    @model_validator(mode="after")
    def validate_range(self):
        if self.ends_at <= self.starts_at:
            raise ValueError("終了日時は開始日時より後にしてください")
        return self


def calendar_config() -> dict:
    reason = None
    if not settings.calendar_enabled:
        reason = "共通カレンダー連携は無効です。管理者に設定を依頼してください。"
    elif settings.auth_mode != "entra":
        reason = "共通カレンダー連携には Microsoft 365 でのサインインが必要です。"
    elif not settings.entra_api_client_secret.get_secret_value():
        reason = "共通カレンダー連携の API 資格情報が未設定です。管理者に確認してください。"
    else:
        try:
            for value in (
                settings.calendar_group_id,
                settings.entra_tenant_id,
                settings.entra_api_client_id,
            ):
                UUID(value)
        except ValueError:
            reason = "共通カレンダー連携のグループ ID または Entra ID 設定が不正です。"
    return {
        "enabled": reason is None,
        "name": settings.calendar_name.strip() or "共通カレンダー",
        "unavailable_reason": reason,
    }


def require_calendar_token(request: Request) -> str:
    config = calendar_config()
    if not config["enabled"]:
        raise HTTPException(503, config["unavailable_reason"])
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer ") or not header[7:].strip():
        raise HTTPException(401, "Microsoft 365 に再サインインしてください。")
    return header[7:]


def ensure_calendar_schema() -> None:
    # schema.sql は新規DB専用。既存DBも同じ追加テーブルへ冪等に移行する。
    with engine.begin() as cn:
        cn.execute(text("SELECT pg_advisory_xact_lock(918273647)"))
        cn.execute(text(Path(__file__).with_name("calendar_schema.sql").read_text(encoding="utf-8")))


def event_payload(
    schedule: CalendarIn, contract_no: str, summary: str, details: str | None, user: CurrentUser
) -> dict:
    def graph_datetime(value: datetime) -> dict:
        return {
            "dateTime": value.astimezone(timezone.utc).replace(tzinfo=None).isoformat(),
            "timeZone": "UTC",
        }

    return {
        "subject": f"[{contract_no}] {summary}"[:255],
        "body": {
            "contentType": "text",
            "content": (
                f"契約番号: {contract_no}\n概要: {summary}\n"
                f"詳細メモ: {details or ''}\n登録者: {user.display_name}"
            ),
        },
        "start": graph_datetime(schedule.starts_at),
        "end": graph_datetime(schedule.ends_at),
        # 応答喪失後の再送でも同じ識別子と内容を使い、Graph 側の重複作成を防ぐ。
        "transactionId": str(schedule.request_id),
    }


def save_calendar_request(
    cn, comm_id: str, schedule: CalendarIn, request_hash: str, payload: dict, user: CurrentUser
) -> None:
    cn.execute(
        text("""
            INSERT INTO communication_calendar_events
              (communication_id, request_id, requested_by, request_hash, group_id,
               calendar_name, starts_at, ends_at, graph_payload)
            VALUES (CAST(:comm_id AS uuid), CAST(:request_id AS uuid), CAST(:user_id AS uuid),
                    :request_hash, CAST(:group_id AS uuid), :calendar_name,
                    :starts_at, :ends_at, CAST(:payload AS jsonb))
        """),
        {
            "comm_id": comm_id,
            "request_id": str(schedule.request_id),
            "user_id": user.id,
            "request_hash": request_hash,
            "group_id": settings.calendar_group_id,
            "calendar_name": calendar_config()["name"],
            "starts_at": schedule.starts_at,
            "ends_at": schedule.ends_at,
            "payload": json.dumps(payload, ensure_ascii=False),
        },
    )


class CalendarError(Exception):
    """利用者に表示可能なメッセージのみを保持する外部連携エラー。"""


def _json_object(response: httpx.Response) -> dict:
    try:
        body = response.json()
    except ValueError as exc:
        raise CalendarError("Microsoft 365 から不正な応答が返されました。再試行してください。") from exc
    if not isinstance(body, dict):
        raise CalendarError("Microsoft 365 から不正な応答が返されました。再試行してください。")
    return body


def create_group_event(assertion: str, group_id: str, payload: dict) -> str:
    # API 用トークンを Graph に転送せず、検証済みユーザーの委任トークンに交換する。
    try:
        with httpx.Client(timeout=20, follow_redirects=False) as client:
            token_response = client.post(
                f"https://login.microsoftonline.com/{settings.entra_tenant_id}/oauth2/v2.0/token",
                data={
                    "client_id": settings.entra_api_client_id,
                    "client_secret": settings.entra_api_client_secret.get_secret_value(),
                    "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                    "requested_token_use": "on_behalf_of",
                    "assertion": assertion,
                    "scope": "https://graph.microsoft.com/.default",
                },
                timeout=10,
            )
            if token_response.status_code != 200:
                raise CalendarError(
                    "Microsoft 365 の予定表用認証に失敗しました。再サインインし、"
                    "解消しない場合は管理者に委任権限の同意・API 資格情報・条件付きアクセスを確認してください。"
                )
            token = _json_object(token_response).get("access_token")
            if not isinstance(token, str) or not token:
                raise CalendarError("Microsoft 365 の予定表用トークンを取得できませんでした。")
            response = client.post(
                f"https://graph.microsoft.com/v1.0/groups/{UUID(group_id)}/events",
                headers={"Authorization": f"Bearer {token}"},
                json=payload,
            )
    except httpx.HTTPError as exc:
        raise CalendarError(
            "Microsoft 365 との通信に失敗し、予定の登録を確認できませんでした。"
            "同じ履歴の「予定を再登録」から再試行してください。"
        ) from exc
    if response.status_code == 403:
        raise CalendarError(
            "共通カレンダーへの登録権限がありません。管理者にグループのメンバー資格と"
            " Group.ReadWrite.All の委任権限・管理者同意を確認してください。"
        )
    if response.status_code == 401:
        raise CalendarError("予定表用の認証が拒否されました。Microsoft 365 に再サインインしてください。")
    if response.status_code == 404:
        raise CalendarError("共通カレンダーが見つかりません。管理者にグループ ID を確認してください。")
    if response.status_code == 429:
        raise CalendarError("Microsoft 365 の要求上限に達しました。時間を置いて再試行してください。")
    if response.status_code != 201:
        raise CalendarError(f"共通カレンダーへの登録に失敗しました（HTTP {response.status_code}）。")
    event_id = _json_object(response).get("id")
    if not isinstance(event_id, str) or not event_id:
        raise CalendarError("予定 ID を取得できず、登録を確認できませんでした。再試行してください。")
    return event_id


def registration_result(row: Mapping) -> dict:
    return {
        "status": row["status"],
        "calendar_name": row["calendar_name"],
        "starts_at": row["starts_at"].isoformat(),
        "ends_at": row["ends_at"].isoformat(),
        "error": row["last_error"],
    }


def sync_calendar(comm_id: str, assertion: str, user: CurrentUser) -> dict:
    # ローカル履歴＋要求は既に確定済み。外部失敗では履歴を巻き戻さず状態を残す。
    with engine.begin() as cn:
        row = cn.execute(
            text("""
                SELECT * FROM communication_calendar_events
                WHERE communication_id = CAST(:comm_id AS uuid) FOR UPDATE
            """),
            {"comm_id": comm_id},
        ).mappings().first()
        if row is None:
            raise HTTPException(404, "この履歴には予定の登録要求がありません。")
        if str(row["requested_by"]) != user.id:
            raise HTTPException(403, "予定の再登録は、この予定を登録したユーザーが行ってください。")
        if row["status"] == "created":
            return registration_result(row)

        try:
            if UUID(settings.calendar_group_id) != row["group_id"]:
                raise CalendarError(
                    "共通カレンダーの設定が変更されています。元の登録先を管理者に確認してください。"
                )
            event_id = create_group_event(assertion, str(row["group_id"]), row["graph_payload"])
            status, error = "created", None
        except CalendarError as exc:
            event_id, status, error = None, "failed", str(exc)
            logger.warning("Calendar registration failed: communication_id=%s reason=%s", comm_id, error)

        cn.execute(
            text("""
                UPDATE communication_calendar_events
                SET status=:status, event_id=:event_id, last_error=:error, updated_at=NOW()
                WHERE communication_id=CAST(:comm_id AS uuid)
            """),
            {"comm_id": comm_id, "status": status, "event_id": event_id, "error": error},
        )
        return registration_result({**row, "status": status, "last_error": error})
