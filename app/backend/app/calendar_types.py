from datetime import datetime, timedelta, timezone

MAX_CALENDAR_EVENTS = 5000
MAX_CALENDAR_DAYS = 62


def validate_window(start: datetime, end: datetime) -> tuple[datetime, datetime]:
    if start.tzinfo is None or end.tzinfo is None:
        reason = "表示期間はタイムゾーン付きの日時で指定してください。"
    else:
        start, end = start.astimezone(timezone.utc), end.astimezone(timezone.utc)
        if start < end and end - start <= timedelta(days=MAX_CALENDAR_DAYS):
            return start, end
        reason = f"表示期間は開始より後、{MAX_CALENDAR_DAYS}日以内で指定してください。"
    # Valid parser workers must not load the web framework.
    from fastapi import HTTPException

    raise HTTPException(422, reason)
