import logging
from datetime import datetime
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator
from sqlalchemy import text
from starlette.exceptions import HTTPException as StarletteHTTPException

from ..auth import CurrentUser, get_current_user
from ..calendar_feeds import (
    MAX_ICS_BYTES, FeedError, fetch_ics, parse_ics, require_feed_key, validate_feed_url, validate_ics,
)
from ..calendar_types import validate_window
from ..calendar_snapshots import decode_result, encode_result, filter_result
from ..crypto import decrypt_bytes, encrypt_str
from ..db import engine

NO_CACHE = {"Cache-Control": "private, no-store"}
DEFAULT_PREFERENCES = {"show_personal": True, "show_group": True, "show_tentative": False, "view": "month"}
FEED_FIELDS = "id, name, kind, color, visible, filename, last_fetched_at, last_error"
MAX_FEEDS = 100
MAX_JSON_BYTES = 6 * MAX_ICS_BYTES + 8192
logger = logging.getLogger(__name__)


def private_response(response: Response) -> None:
    response.headers.update(NO_CACHE)


def _private_error_headers(exc: StarletteHTTPException) -> None:
    exc.headers = {
        key: value for key, value in (exc.headers or {}).items()
        if key.lower() != "cache-control"
    } | NO_CACHE


class PrivateFeedRoute(APIRoute):
    async def handle(self, scope, receive, send):
        try:
            await super().handle(scope, receive, send)
        except StarletteHTTPException as exc:
            _private_error_headers(exc)
            raise

    def get_route_handler(self):
        handler = super().get_route_handler()

        async def private_handler(request: Request):
            try:
                response = await handler(request)
            except StarletteHTTPException as exc:
                # Dependency/authentication errors bypass the injected Response.
                _private_error_headers(exc)
                raise
            except RequestValidationError:
                raise HTTPException(
                    422, "入力内容・予定ID・表示期間の形式を確認してください。", headers=NO_CACHE,
                ) from None
            except Exception as exc:
                # Do not log exception details: driver/library diagnostics may contain secrets.
                logger.error("Private calendar request failed (%s)", type(exc).__name__)
                return JSONResponse(
                    status_code=500,
                    content={"detail": "カレンダー情報を処理できませんでした。時間をおいて再試行してください。"},
                    headers=NO_CACHE,
                )
            response.headers.update(NO_CACHE)
            return response

        return private_handler


router = APIRouter(
    prefix="/api/calendar", tags=["calendar"],
    dependencies=[Depends(private_response)],
    route_class=PrivateFeedRoute,
)


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class FeedCreate(StrictInput):
    name: str = Field(min_length=1, max_length=100)
    kind: Literal["url", "file"]
    color: str = Field(default="#2563eb", max_length=7, pattern=r"^#[0-9a-fA-F]{6}$")
    visible: bool = True
    url: str | None = Field(default=None, max_length=2048)
    content: str | None = None
    filename: str | None = Field(default=None, max_length=255)

    @field_validator("name")
    @classmethod
    def nonempty_name(cls, value):
        if not value.strip() or "\0" in value:
            raise ValueError("name")
        return value

    @field_validator("filename")
    @classmethod
    def valid_filename(cls, value):
        if value is not None and "\0" in value:
            raise ValueError("filename")
        return value

    @model_validator(mode="after")
    def source_fields(self):
        if self.kind == "url":
            if not self.url or "content" in self.model_fields_set or "filename" in self.model_fields_set:
                raise ValueError("source")
        elif self.content is None or "url" in self.model_fields_set:
            raise ValueError("source")
        if self.content is not None and len(self.content.encode("utf-8")) > MAX_ICS_BYTES:
            raise ValueError("size")
        return self


class FeedUpdate(StrictInput):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    color: str | None = Field(default=None, max_length=7, pattern=r"^#[0-9a-fA-F]{6}$")
    visible: bool | None = None

    @model_validator(mode="after")
    def non_null(self):
        if not self.model_fields_set or any(getattr(self, key) is None for key in self.model_fields_set):
            raise ValueError("update")
        if self.name is not None and (not self.name.strip() or "\0" in self.name):
            raise ValueError("name")
        return self


class Preferences(StrictInput):
    show_personal: bool
    show_group: bool
    show_tentative: bool = False
    view: Literal["day", "week", "month"]


async def _safe_body(request: Request, model):
    # FastAPI's default validation response echoes input, including URL tokens/content.
    # Read a bounded JSON body and deliberately return only a fixed safe diagnostic.
    try:
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > MAX_JSON_BYTES:
                raise HTTPException(413, "登録データがサイズ上限を超えています。", headers=NO_CACHE)
            body.extend(chunk)
        return model.model_validate_json(body)
    except HTTPException:
        raise
    except (ValidationError, ValueError, UnicodeError):
        raise HTTPException(
            422, "入力内容を確認してください。必須項目・文字数・形式または未対応の項目があります。",
            headers=NO_CACHE,
        ) from None


async def create_body(request: Request) -> FeedCreate:
    return await _safe_body(request, FeedCreate)


async def update_body(request: Request) -> FeedUpdate:
    return await _safe_body(request, FeedUpdate)


async def preferences_body(request: Request) -> Preferences:
    return await _safe_body(request, Preferences)


def _http_error(exc: FeedError) -> HTTPException:
    return HTTPException(exc.status_code, str(exc), headers=NO_CACHE)


def _metadata(row) -> dict:
    result = {key: row[key] for key in (
        "id", "name", "kind", "color", "visible", "filename", "last_fetched_at", "last_error",
    )}
    result["id"] = str(result["id"])
    if result["last_fetched_at"] is not None:
        result["last_fetched_at"] = result["last_fetched_at"].isoformat()
    return result


def _owned(cn, feed_id: UUID, owner_id: str, *, secret=False, lock=False):
    columns = FEED_FIELDS + (", url_enc, content_enc" if secret else "")
    row = cn.execute(text(
        f"SELECT {columns} FROM calendar_feeds WHERE id=:id AND owner_id=:owner_id"
        + (" FOR UPDATE" if lock else "")
    ), {"id": feed_id, "owner_id": owner_id}).mappings().first()
    if row is None:
        raise HTTPException(404, "ICS ソースが見つかりません。", headers=NO_CACHE)
    return row


@router.get("/feeds")
def list_feeds(user: CurrentUser = Depends(get_current_user)):
    with engine.begin() as cn:
        rows = cn.execute(text(
            f"SELECT {FEED_FIELDS} FROM calendar_feeds WHERE owner_id=:owner_id ORDER BY created_at, id"
        ), {"owner_id": user.id}).mappings().all()
    return {"items": [_metadata(row) for row in rows]}


@router.post("/feeds")
def create_feed(body: FeedCreate = Depends(create_body), user: CurrentUser = Depends(get_current_user)):
    try:
        require_feed_key()
        if body.kind == "url":
            validate_feed_url(body.url)
        else:
            validate_ics(body.content)
        values = {
            "owner_id": user.id, "name": body.name, "kind": body.kind,
            "color": body.color.lower(), "visible": body.visible, "filename": body.filename,
            "url_enc": encrypt_str(body.url) if body.url is not None else None,
            "content_enc": encrypt_str(body.content) if body.content is not None else None,
        }
    except FeedError as exc:
        raise _http_error(exc) from None
    with engine.begin() as cn:
        cn.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:owner_id, 649))"), {"owner_id": user.id})
        count = cn.execute(text(
            "SELECT count(*) FROM calendar_feeds WHERE owner_id=:owner_id"
        ), {"owner_id": user.id}).scalar_one()
        if count >= MAX_FEEDS:
            raise HTTPException(422, "ICS ソースは利用者ごとに100件まで登録できます。", headers=NO_CACHE)
        row = cn.execute(text(f"""
            INSERT INTO calendar_feeds (owner_id, name, kind, color, visible, filename, url_enc, content_enc)
            VALUES (:owner_id, :name, :kind, :color, :visible, :filename, :url_enc, :content_enc)
            RETURNING {FEED_FIELDS}
        """), values).mappings().one()
    return _metadata(row)


@router.put("/feeds/{feed_id}")
def update_feed(
    feed_id: UUID, body: FeedUpdate = Depends(update_body), user: CurrentUser = Depends(get_current_user),
):
    updates = body.model_dump(exclude_unset=True)
    if "color" in updates:
        updates["color"] = updates["color"].lower()
    with engine.begin() as cn:
        assignments = ", ".join(f"{key}=:{key}" for key in updates)
        row = cn.execute(text(f"""
            UPDATE calendar_feeds SET {assignments}, updated_at=now()
            WHERE id=:id AND owner_id=:owner_id RETURNING {FEED_FIELDS}
        """), {**updates, "id": feed_id, "owner_id": user.id}).mappings().first()
        if row is None:
            raise HTTPException(404, "ICS ソースが見つかりません。", headers=NO_CACHE)
    return _metadata(row)


@router.delete("/feeds/{feed_id}")
def delete_feed(feed_id: UUID, user: CurrentUser = Depends(get_current_user)):
    with engine.begin() as cn:
        row = cn.execute(text(
            "DELETE FROM calendar_feeds WHERE id=:id AND owner_id=:owner_id RETURNING id"
        ), {"id": feed_id, "owner_id": user.id}).first()
        if row is None:
            raise HTTPException(404, "ICS ソースが見つかりません。", headers=NO_CACHE)
    return {"ok": True}


def _set_fetch_status(cn, feed_id: UUID, owner_id: str, error: str | None) -> None:
    cn.execute(text("""
            UPDATE calendar_feeds SET last_error=CAST(:error AS text), updated_at=now(),
                last_fetched_at=CASE WHEN CAST(:error AS text) IS NULL THEN now() ELSE last_fetched_at END
            WHERE id=:id AND owner_id=:owner_id
    """), {"id": feed_id, "owner_id": owner_id, "error": error})


def _record_fetch(feed_id: UUID, owner_id: str, error: str | None) -> None:
    with engine.begin() as cn:
        _set_fetch_status(cn, feed_id, owner_id, error)


def _snapshot(cn, feed_id: UUID, owner_id: str):
    return cn.execute(text("""
        SELECT snapshot.* FROM calendar_feed_snapshots snapshot
        JOIN calendar_feeds feed ON feed.id=snapshot.feed_id
        WHERE feed.id=:id AND feed.owner_id=:owner_id
    """), {"id": feed_id, "owner_id": owner_id}).mappings().first()


def _version(snapshot):
    return snapshot["version"] if snapshot is not None else None


def _save_snapshot(feed_id, owner_id, previous, content, result, start, end):
    values = {
        "id": feed_id, "version": uuid4(), "content": encrypt_str(content),
        "result": encode_result(result), "start": start, "end": end,
    }
    # Never hold a DB connection/lock during URL retrieval or subprocess parsing.
    with engine.begin() as cn:
        _owned(cn, feed_id, owner_id, lock=True)
        if _version(_snapshot(cn, feed_id, owner_id)) != _version(previous):
            return None
        saved = cn.execute(text("""
            INSERT INTO calendar_feed_snapshots
                (feed_id, version, content_enc, result_enc, range_start, range_end)
            VALUES (:id, :version, :content, :result, :start, :end)
            ON CONFLICT (feed_id) DO UPDATE SET
                version=excluded.version, content_enc=excluded.content_enc,
                result_enc=excluded.result_enc, range_start=excluded.range_start,
                range_end=excluded.range_end, saved_at=now()
            RETURNING saved_at
        """), values).scalar_one()
        _set_fetch_status(cn, feed_id, owner_id, None)
        return saved


def _cached_response(feed_id, owner_id, snapshot, start, end, error=None):
    if snapshot["range_start"] <= start and end <= snapshot["range_end"]:
        result = filter_result(decode_result(snapshot["result_enc"]), start, end)
    else:
        try:
            content = decrypt_bytes(snapshot["content_enc"])
        except Exception:
            raise FeedError("ICS の保存データを復号できません。「更新」で再取得してください。", 503) from None
        result = parse_ics(content, start, end, str(feed_id))
        encrypted = encode_result(result)
        with engine.begin() as cn:
            _owned(cn, feed_id, owner_id, lock=True)
            # A slow expansion of an old source must not replace a manual refresh.
            cn.execute(text("""
                UPDATE calendar_feed_snapshots SET result_enc=:result,
                    range_start=:start, range_end=:end
                WHERE feed_id=:id AND version=:version
            """), {"id": feed_id, "version": snapshot["version"],
                   "result": encrypted, "start": start, "end": end})
    return result | {"cache": {
        "saved_at": snapshot["saved_at"].isoformat(), "from_cache": True, "refresh_error": error,
    }}


@router.get("/feeds/{feed_id}/events")
def feed_events(
    feed_id: UUID, start: datetime, end: datetime, user: CurrentUser = Depends(get_current_user),
    refresh: bool = False,
):
    start, end = validate_window(start, end)
    with engine.begin() as cn:
        row = _owned(cn, feed_id, user.id, secret=True)
        previous = _snapshot(cn, feed_id, user.id)
    try:
        require_feed_key()
        if previous is not None and not refresh:
            return _cached_response(feed_id, user.id, previous, start, end, row["last_error"])
        try:
            secret = decrypt_bytes(row["url_enc"] if row["kind"] == "url" else row["content_enc"])
        except Exception:
            raise FeedError("ICS の保存データを復号できません。管理者に連絡してください。", 503) from None
        content = fetch_ics(secret) if row["kind"] == "url" else secret
        result = parse_ics(content, start, end, str(feed_id))
        saved = _save_snapshot(feed_id, user.id, previous, content, result, start, end)
        if saved is not None:
            return result | {"cache": {
                "saved_at": saved.isoformat(), "from_cache": False, "refresh_error": None,
            }}
        # A concurrent successful refresh won; return that saved version instead.
        with engine.begin() as cn:
            current = _owned(cn, feed_id, user.id)
            latest = _snapshot(cn, feed_id, user.id)
        if latest is not None:
            return _cached_response(feed_id, user.id, latest, start, end, current["last_error"])
        raise FeedError("ICS が別の画面で変更されました。もう一度更新してください。", 409)
    except FeedError as exc:
        if previous is not None and not refresh:
            raise _http_error(exc) from None
        # Do not fall back to decrypting snapshots when the key policy failed.
        try:
            require_feed_key()
        except FeedError:
            raise _http_error(exc) from None
        with engine.begin() as cn:
            current = _owned(cn, feed_id, user.id, lock=True)
            latest = _snapshot(cn, feed_id, user.id)
            error = current["last_error"]
            if _version(latest) == _version(previous):
                error = str(exc)
                _set_fetch_status(cn, feed_id, user.id, error)
        if latest is not None:
            try:
                return _cached_response(feed_id, user.id, latest, start, end, error)
            except FeedError as fallback:
                raise _http_error(fallback) from None
        raise _http_error(exc) from None


@router.get("/preferences")
def get_preferences(user: CurrentUser = Depends(get_current_user)):
    with engine.begin() as cn:
        row = cn.execute(text("""
            SELECT show_personal, show_group, show_tentative, view FROM calendar_preferences WHERE owner_id=:owner_id
        """), {"owner_id": user.id}).mappings().first()
    return dict(row) if row is not None else DEFAULT_PREFERENCES.copy()


@router.put("/preferences")
def put_preferences(
    body: Preferences = Depends(preferences_body), user: CurrentUser = Depends(get_current_user),
):
    with engine.begin() as cn:
        row = cn.execute(text("""
            INSERT INTO calendar_preferences (owner_id, show_personal, show_group, show_tentative, view)
            VALUES (:owner_id, :show_personal, :show_group, :show_tentative, :view)
            ON CONFLICT (owner_id) DO UPDATE SET
                show_personal=EXCLUDED.show_personal, show_group=EXCLUDED.show_group,
                show_tentative=CASE WHEN :set_tentative THEN excluded.show_tentative
                    ELSE calendar_preferences.show_tentative END,
                view=excluded.view, updated_at=now()
            WHERE calendar_preferences.owner_id=:owner_id
            RETURNING show_personal, show_group, show_tentative, view
        """), {"owner_id": user.id, "set_tentative": "show_tentative" in body.model_fields_set,
               **body.model_dump()}).mappings().one()
    return dict(row)
