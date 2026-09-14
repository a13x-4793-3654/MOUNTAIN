"""Encrypted, bounded ICS snapshots; never shared across source owners."""

import json
import logging
from datetime import datetime

from cryptography.fernet import InvalidToken

from .calendar_feeds import FeedError, JST, MAX_EVENT_OUTPUT_BYTES
from .crypto import decrypt_bytes, encrypt_str

MAX_SNAPSHOT_RESULT_BYTES = MAX_EVENT_OUTPUT_BYTES + 65536
SNAPSHOT_INVALID = "ICS の保存済みデータを読み込めません。「更新」で再取得してください。"
logger = logging.getLogger(__name__)


def encode_result(result: dict) -> bytes:
    value = json.dumps(result, ensure_ascii=False)
    if len(value.encode("utf-8")) > MAX_SNAPSHOT_RESULT_BYTES:
        raise FeedError("ICS の保存対象がサイズ上限を超えています。")
    return encrypt_str(value)


def decode_result(value) -> dict:
    try:
        if len(value) > 2 * MAX_SNAPSHOT_RESULT_BYTES:
            raise ValueError
        plain = decrypt_bytes(value)
        if len(plain.encode("utf-8")) > MAX_SNAPSHOT_RESULT_BYTES:
            raise ValueError
        result = json.loads(plain)
        if not isinstance(result, dict) or set(result) != {"events", "warnings"}:
            raise ValueError
        if not isinstance(result["events"], list) or not isinstance(result["warnings"], list):
            raise ValueError
        return result
    except (InvalidToken, ValueError, TypeError, UnicodeError) as exc:
        logger.warning("ICS snapshot could not be decoded (type=%s)", type(exc).__name__)
        raise FeedError(SNAPSHOT_INVALID, 503) from None


def filter_result(result: dict, start: datetime, end: datetime) -> dict:
    def overlaps(event):
        event_start = datetime.fromisoformat(event["start"])
        event_end = datetime.fromisoformat(event["end"])
        if event["all_day"]:
            event_start = event_start.replace(tzinfo=JST)
            event_end = event_end.replace(tzinfo=JST)
        return event_start < end and (event_end > start or event_start == event_end >= start)

    return {"events": [event for event in result["events"] if overlaps(event)], "warnings": result["warnings"]}
