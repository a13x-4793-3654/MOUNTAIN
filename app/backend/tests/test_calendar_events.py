import json
import subprocess
import sys
import unittest
from contextlib import nullcontext
from datetime import datetime, timedelta
from unittest.mock import patch
from urllib.parse import parse_qs

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import get_current_user
from app.calendar import CalendarError
from app.calendar_events import calendar_availability, read_calendar_events
from app.calendar_types import validate_window
from app.config import settings
from app.routers import calendar_events
from test_calendar import GROUP_ID, actor, enabled_config

START = datetime.fromisoformat("2026-09-01T00:00:00+09:00")
END = datetime.fromisoformat("2026-10-01T00:00:00+09:00")


def event(identifier="event-1", **overrides):
    return {
        "id": identifier, "subject": "Calendar event", "isAllDay": False,
        "start": {"dateTime": "2026-09-14T06:00:00.0000000", "timeZone": "UTC"},
        "end": {"dateTime": "2026-09-14T07:00:00.0000000", "timeZone": "UTC"},
        "location": {"displayName": "Room"}, "body": {"contentType": "text", "content": "Memo"},
        "webLink": "https://outlook.office.com/calendar/item/event-1",
        **overrides,
    }


class CalendarViewTests(unittest.TestCase):
    def read(self, handler, source="personal", **limits):
        self.calls = []

        def transport(request):
            self.calls.append(request)
            if request.url.host == "login.microsoftonline.com":
                return httpx.Response(200, json={"access_token": "test-graph-token"})
            return handler(request)

        client = httpx.Client(transport=httpx.MockTransport(transport))
        with enabled_config(), patch("app.calendar_events.httpx.Client", return_value=client), patch.multiple(
            "app.calendar_events", **limits
        ) if limits else nullcontext():
            return read_calendar_events("test-api-token", source, START, END)

    def test_personal_view_uses_obo_and_read_only_me_endpoint(self):
        result = self.read(lambda request: httpx.Response(200, json={"value": [event()]}))
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(result["events"][0]["start"], "2026-09-14T06:00:00+00:00")
        self.assertEqual(result["events"][0]["source"], "personal")
        token, graph = self.calls
        self.assertEqual(parse_qs(token.content.decode())["assertion"], ["test-api-token"])
        self.assertEqual(graph.method, "GET")
        self.assertEqual(graph.url.path, "/v1.0/me/calendar/calendarView")
        self.assertEqual(graph.headers["Authorization"], "Bearer test-graph-token")
        self.assertIn('outlook.body-content-type="text"', graph.headers["Prefer"])
        self.assertEqual(graph.url.params["startDateTime"], "2026-08-31T15:00:00+00:00")
        self.assertEqual(result["warnings"], [])

    def test_group_view_follows_pages_and_uses_only_configured_group(self):
        def handler(request):
            if "page" in request.url.params:
                return httpx.Response(200, json={"value": [event("event-2")]})
            return httpx.Response(200, json={
                "value": [event()],
                "@odata.nextLink": f"https://graph.microsoft.com/v1.0/groups/{GROUP_ID}/calendarView?page=2",
            })
        result = self.read(handler, source="group")
        self.assertEqual(len(result["events"]), 2)
        self.assertEqual(len(self.calls), 3)
        self.assertTrue(all(request.method == "GET" for request in self.calls[1:]))
        self.assertTrue(all(item["source"] == "group" for item in result["events"]))

    def test_all_day_exclusive_dates_html_text_and_cancelled_events(self):
        all_day = event(
            "all-day", isAllDay=True,
            start={"dateTime": "2026-09-13T15:00:00", "timeZone": "UTC"},
            end={"dateTime": "2026-09-15T15:00:00", "timeZone": "UTC"},
            body={"contentType": "html", "content": "<p>Hello &amp; world</p><script>bad()</script><div>Memo</div>"},
            webLink="javascript:alert(1)",
        )
        result = self.read(lambda request: httpx.Response(200, json={
            "value": [all_day, event("cancelled", isCancelled=True)],
        }))
        self.assertEqual(len(result["events"]), 1)
        actual = result["events"][0]
        self.assertEqual((actual["start"], actual["end"]), ("2026-09-14", "2026-09-16"))
        self.assertIn("Hello & world", actual["description"])
        self.assertNotIn("bad()", actual["description"])
        self.assertNotIn("<", actual["description"])
        self.assertIsNone(actual["web_url"])

    def test_invalid_or_external_paging_never_receives_token(self):
        for next_link in (
            "https://example.invalid/private", "http://graph.microsoft.com/v1.0/me/calendar/calendarView",
            "https://graph.microsoft.com/v1.0/users/other/calendar/calendarView",
            "https://user:password@graph.microsoft.com/v1.0/me/calendar/calendarView",
            "https://graph.microsoft.com:8443/v1.0/me/calendar/calendarView",
            "https://graph.microsoft.com/v1.0/me/calendar/calendarView#fragment",
            {"url": "invalid"},
        ):
            with self.subTest(next_link=next_link), self.assertRaises(CalendarError):
                self.read(lambda request: httpx.Response(200, json={"value": [], "@odata.nextLink": next_link}))
            self.assertEqual(len(self.calls), 2)

    def test_http_errors_do_not_expose_upstream_private_data(self):
        for status in (401, 403, 404, 429, 500, 302):
            with self.subTest(status=status), self.assertRaises(CalendarError) as exc:
                self.read(lambda request: httpx.Response(status, json={"error": "private-upstream-data"}))
            self.assertNotIn("private-upstream-data", str(exc.exception))
            if status == 403:
                self.assertIn("Calendars.Read", str(exc.exception))

    def test_malformed_page_or_event_is_not_empty_success(self):
        for body in (
            [], {"value": {}}, {"value": [None]}, {"value": [event(start={})]},
            {"value": [event(start={"dateTime": "2026-09-14T15:00", "timeZone": "Unknown"})]},
            {"value": [event(subject={"private": "data"})]},
            {"value": [event(body={"content": "memo", "contentType": 123})]},
        ):
            with self.subTest(body=body), self.assertRaises(CalendarError):
                self.read(lambda request: httpx.Response(200, json=body))

    def test_large_pages_and_event_counts_fail_instead_of_truncating(self):
        for limits in ({"MAX_PAGE_BYTES": 10}, {"MAX_TOTAL_BYTES": 10}, {"MAX_CALENDAR_EVENTS": 1}):
            with self.subTest(limits=limits), self.assertRaises(CalendarError):
                self.read(lambda request: httpx.Response(200, json={"value": [event(), event("other")]}), **limits)

    def test_circular_and_excessive_pages_are_bounded(self):
        def handler(request):
            page = int(request.url.params.get("page", "0")) + 1
            return httpx.Response(200, json={
                "value": [], "@odata.nextLink": f"https://graph.microsoft.com/v1.0/me/calendar/calendarView?page={page}",
            })
        with self.assertRaises(CalendarError):
            self.read(handler, MAX_PAGES=2)
        self.assertEqual(len(self.calls), 3)
        with self.assertRaises(CalendarError):
            self.read(lambda request: httpx.Response(200, json={
                "value": [], "@odata.nextLink": str(request.url),
            }))
        self.assertEqual(len(self.calls), 2)

    def test_window_requires_timezone_and_is_bounded(self):
        self.assertEqual(
            validate_window(START, START + timedelta(days=62))[1]
            - validate_window(START, START + timedelta(days=62))[0],
            timedelta(days=62),
        )
        for start, end in (
            (START.replace(tzinfo=None), END), (START, START),
            (END, START), (START, datetime.fromisoformat("2027-01-01T00:00:00+09:00")),
            (START, START + timedelta(days=62, microseconds=1)),
        ):
            with self.subTest(start=start, end=end), self.assertRaises(calendar_events.HTTPException):
                validate_window(start, end)

    def test_valid_window_keeps_parser_process_independent_of_web_framework(self):
        subprocess.run([
            sys.executable, "-c",
            "import sys; from datetime import datetime; from app.calendar_types import validate_window; "
            "validate_window(datetime.fromisoformat('2026-09-01T00:00:00+09:00'), "
            "datetime.fromisoformat('2026-09-02T00:00:00+09:00')); "
            "assert 'fastapi' not in sys.modules",
        ], check=True, capture_output=True, timeout=10)

    def test_view_does_not_require_public_history_url_or_group_for_personal_calendar(self):
        with enabled_config(), patch.multiple(settings, app_public_url="", calendar_group_id=""):
            config = calendar_availability()
        self.assertTrue(config["personal"]["enabled"])
        self.assertFalse(config["group"]["enabled"])
        self.assertNotIn("test-only-secret", json.dumps(config))


class CalendarViewApiTests(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(calendar_events.router)
        user = actor()
        user.permissions = []
        self.app.dependency_overrides[get_current_user] = lambda: user
        self.client = TestClient(self.app)

    def get(self, source="personal", token=True):
        return self.client.get("/api/calendar/events", params={
            "source": source, "start": START.isoformat(), "end": END.isoformat(),
        }, headers={"Authorization": "Bearer test-api-token"} if token else {})

    def test_authenticated_utility_does_not_need_contract_permission_and_is_not_cached(self):
        expected = {"events": [], "warnings": []}
        with enabled_config(), patch("app.routers.calendar_events.read_calendar_events", return_value=expected) as read:
            response = self.get()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), expected)
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        self.assertEqual(read.call_args.args[0:2], ("test-api-token", "personal"))

    def test_invalid_source_and_missing_bearer_never_call_graph(self):
        with enabled_config(), patch("app.routers.calendar_events.read_calendar_events") as read:
            self.assertEqual(self.get("other").status_code, 422)
            self.assertEqual(self.get(token=False).status_code, 401)
        read.assert_not_called()

    def test_read_errors_are_reported_not_empty_success(self):
        with enabled_config(), patch(
            "app.routers.calendar_events.read_calendar_events", side_effect=CalendarError("Permission refused")
        ):
            response = self.get()
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"], "Permission refused")


if __name__ == "__main__":
    unittest.main()
