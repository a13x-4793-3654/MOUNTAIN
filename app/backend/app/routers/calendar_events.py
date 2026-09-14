from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from ..auth import get_current_user
from ..calendar import CalendarError, require_graph_token
from ..calendar_events import Source, calendar_availability, read_calendar_events
from ..calendar_types import validate_window


def private_response(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(
    prefix="/api/calendar", tags=["calendar"],
    dependencies=[Depends(get_current_user), Depends(private_response)],
)


@router.get("/availability")
def availability():
    return calendar_availability()


@router.get("/events")
def events(source: Source, start: datetime, end: datetime, request: Request):
    start, end = validate_window(start, end)
    assertion = require_graph_token(request, group=source == "group")
    try:
        return read_calendar_events(assertion, source, start, end)
    except CalendarError as exc:
        raise HTTPException(502, str(exc), headers={"Cache-Control": "private, no-store"}) from exc
