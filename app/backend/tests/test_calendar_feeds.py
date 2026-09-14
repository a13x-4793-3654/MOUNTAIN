import io
import multiprocessing
import socket
import ssl
import threading
import time
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch
from uuid import UUID

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import calendar_feeds as feeds, crypto, db
from app.auth import CurrentUser, get_current_user
from app.config import settings
from app.routers import calendar_feeds as routes
from test_calendar_feeds_worker_helpers import (
    oversized_parser_worker, parser_import_probe, sleeping_parser_worker,
)

USER_ID = "11111111-1111-4111-8111-111111111111"
OTHER_ID = "22222222-2222-4222-8222-222222222222"
START = datetime.fromisoformat("2026-09-01T00:00:00+09:00")
END = datetime.fromisoformat("2026-10-01T00:00:00+09:00")
SECRET = "subscription-secret-never-show"


def actor(user_id=USER_ID, admin=False):
    return CurrentUser(user_id, "Calendar test", "test@example.invalid", None, 0, admin)


def event(*lines):
    return "\r\n".join(("BEGIN:VEVENT", *lines, "END:VEVENT"))


def ics(*events, extra=""):
    return "\r\n".join(("BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MOUNTAIN Test//EN", extra, *events, "END:VCALENDAR", ""))


SIMPLE = ics(event(
    "UID:simple", "DTSTART:20260914T090000", "DTEND:20260914T100000", "SUMMARY:会議",
))


class IcsTests(unittest.TestCase):
    def parse(self, content, start=START, end=END):
        return feeds._parse_ics_content(content, start, end, USER_ID)

    def test_valid_empty_calendar_has_no_events(self):
        self.assertEqual(self.parse(ics()), {"events": [], "warnings": []})

    def test_floating_jst_folded_utf8_escaped_text_and_safe_urls(self):
        content = ics(event(
            "UID:folded", "DTSTART:20260914T090000", "DURATION:PT1H",
            "SUMMARY:日本語の", " 続き\\,会議", "DESCRIPTION:line1\\nline2\\;text\\\\end",
            "LOCATION:東京", "URL:javascript:alert(1)",
        ))
        result = self.parse(content)["events"][0]
        self.assertEqual(result["title"], "日本語の続き,会議")
        self.assertEqual(result["description"], "line1\nline2;text\\end")
        self.assertEqual(result["start"], "2026-09-14T00:00:00+00:00")
        self.assertEqual(result["end"], "2026-09-14T01:00:00+00:00")
        self.assertFalse(result["all_day"])
        self.assertIsNone(result["web_url"])
        self.assertEqual(result["source"], "feed:" + USER_ID)
        for url in ("https://example.com/event", "http://example.com/event#details"):
            self.assertEqual(feeds._web_url(url), url)
        for url in ("data:text/html,x", "//example.com", "https://a:b@example.com", "https://example.com/\nx"):
            self.assertIsNone(feeds._web_url(url))

    def test_all_day_exclusive_multiday_overlap_and_default_end(self):
        content = ics(
            event("UID:overlap", "DTSTART;VALUE=DATE:20260830", "DTEND;VALUE=DATE:20260903"),
            event("UID:one", "DTSTART;VALUE=DATE:20260914"),
            event("UID:exclusive", "DTSTART;VALUE=DATE:20260830", "DTEND;VALUE=DATE:20260901"),
        )
        results = self.parse(content)["events"]
        self.assertEqual(len(results), 2)
        self.assertEqual((results[0]["start"], results[0]["end"]), ("2026-08-30", "2026-09-03"))
        self.assertEqual((results[1]["start"], results[1]["end"]), ("2026-09-14", "2026-09-15"))
        self.assertTrue(all(item["all_day"] for item in results))

    def test_timezone_utc_and_custom_vtimezone(self):
        custom = "\r\n".join((
            "BEGIN:VTIMEZONE", "TZID:Custom/Test", "BEGIN:STANDARD", "DTSTART:19700101T000000",
            "TZOFFSETFROM:+0530", "TZOFFSETTO:+0530", "TZNAME:TEST", "END:STANDARD", "END:VTIMEZONE",
        ))
        results = self.parse(ics(
            event("UID:utc", "DTSTART:20260914T090000Z", "DTEND:20260914T100000Z"),
            event("UID:ny", "DTSTART;TZID=America/New_York:20260914T090000", "DURATION:PT1H"),
            event("UID:custom", "DTSTART;TZID=Custom/Test:20260914T090000", "DURATION:PT1H"),
            extra=custom,
        ))["events"]
        self.assertEqual({item["start"] for item in results}, {
            "2026-09-14T03:30:00+00:00", "2026-09-14T09:00:00+00:00", "2026-09-14T13:00:00+00:00",
        })
        with self.assertRaises(feeds.FeedError):
            self.parse(ics(event("UID:bad", "DTSTART;TZID=Never/Known:20260914T090000")))
        second = self.parse(ics(
            event("UID:custom", "DTSTART;TZID=Custom/Test:20260914T090000"),
            extra=custom.replace("+0530", "+0300"),
        ))["events"][0]
        self.assertEqual(second["start"], "2026-09-14T06:00:00+00:00")

    def test_recurrence_rdate_exdate_sequence_exceptions_and_cancellations(self):
        base = ("UID:series", "DTSTART:20260914T090000", "DURATION:PT1H", "RRULE:FREQ=DAILY;COUNT=4")
        content = ics(
            event(*base, "SEQUENCE:0", "SUMMARY:obsolete"),
            event(*base, "SEQUENCE:1", "SUMMARY:current", "RDATE:20260920T090000,20260914T090000", "EXDATE:20260916T090000"),
            event("UID:series", "RECURRENCE-ID:20260915T090000", "DTSTART:20260915T120000", "SUMMARY:old override", "SEQUENCE:1"),
            event("UID:series", "RECURRENCE-ID:20260915T090000", "DTSTART:20260915T140000", "SUMMARY:moved", "SEQUENCE:2"),
            event("UID:series", "RECURRENCE-ID:20260917T090000", "STATUS:CANCELLED", "SEQUENCE:3"),
        )
        results = self.parse(content)["events"]
        self.assertEqual(len(results), 3)
        self.assertEqual([item["title"] for item in results], ["current", "moved", "current"])
        self.assertEqual(results[1]["start"], "2026-09-15T05:00:00+00:00")
        self.assertEqual(results[1]["end"], "2026-09-15T06:00:00+00:00")
        self.assertEqual(len({item["id"] for item in results}), 3)
        self.assertEqual(results, self.parse(content)["events"])

    def test_exception_moved_into_window_and_cancelled_calendar(self):
        content = ics(
            event("UID:series", "DTSTART:20260701T090000", "RRULE:FREQ=DAILY;COUNT=2"),
            event("UID:series", "RECURRENCE-ID:20260701T090000", "DTSTART:20260914T090000"),
        )
        self.assertEqual(len(self.parse(content)["events"]), 1)
        cancelled = ics(event("UID:series", "STATUS:CANCELLED", "SEQUENCE:1"), extra="METHOD:CANCEL")
        self.assertEqual(self.parse(cancelled)["events"], [])

    def test_tentative_status_is_preserved_and_inherited_by_recurrence_overrides(self):
        content = ics(
            event("UID:series", "DTSTART:20260914T090000", "RRULE:FREQ=DAILY;COUNT=3", "STATUS:TENTATIVE"),
            event("UID:series", "RECURRENCE-ID:20260915T090000", "DTSTART:20260915T100000"),
            event("UID:series", "RECURRENCE-ID:20260916T090000", "DTSTART:20260916T100000", "STATUS:CONFIRMED"),
            event("UID:default", "DTSTART:20260917T090000", "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:test@example.invalid"),
        )
        self.assertEqual([item["tentative"] for item in self.parse(content)["events"]], [True, True, False, False])

    def test_all_day_weekly_monthly_yearly_until_and_dst_recurrence(self):
        for rule, expected in (
            ("FREQ=WEEKLY;BYDAY=MO,WE", 10),
            ("FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2", 2),  # DTSTART plus second Monday.
            ("FREQ=YEARLY;BYMONTH=9;BYMONTHDAY=14", 2),
            ("FREQ=DAILY;UNTIL=20260903", 3),
        ):
            with self.subTest(rule=rule):
                result = self.parse(ics(event("UID:rule", "DTSTART;VALUE=DATE:20260901", "RRULE:" + rule)))
                self.assertEqual(len(result["events"]), expected)
        dst = self.parse(
            ics(event("UID:dst", "DTSTART;TZID=America/New_York:20261031T090000", "RRULE:FREQ=DAILY;COUNT=3")),
            datetime.fromisoformat("2026-10-30T00:00:00Z"), datetime.fromisoformat("2026-11-04T00:00:00Z"),
        )["events"]
        self.assertEqual([item["start"][11:16] for item in dst], ["13:00", "14:00", "14:00"])

    def test_explicit_unsupported_and_invalid_inputs(self):
        for rule in (
            "FREQ=SECONDLY", "FREQ=MINUTELY", "FREQ=HOURLY", "FREQ=DAILY;BYSECOND=1",
            "FREQ=DAILY;COUNT=999999999", "FREQ=DAILY;INTERVAL=0", "FREQ=MONTHLY;BYSETPOS=0",
            "FREQ=DAILY;COUNT=2;UNTIL=20260930T000000Z",
        ):
            with self.subTest(rule=rule), self.assertRaises(feeds.FeedError):
                self.parse(ics(event("UID:bad", "DTSTART:20260914T090000Z", "RRULE:" + rule)))
        for content in (
            "arbitrary " + SECRET, "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
            ics(event("DTSTART:20260914T090000")),
            ics(event("UID:bad", "DTSTART:garbage" + SECRET)),
            ics(event("UID:bad", "DTSTART;VALUE=DATE:20260914", "DTEND:20260915T090000Z")),
            ics(event("UID:bad", "DTSTART:20260914T090000Z", "DTEND:20260913T090000Z")),
            ics(event("UID:bad", "DTSTART:20260914T090000", "RECURRENCE-ID;RANGE=THISANDFUTURE:20260914T090000")),
            ics(event("UID:bad", "DTSTART:20260914T090000", "RDATE;VALUE=PERIOD:20260914T090000/20260914T100000")),
            ics(event("UID:bad", "DTSTART:20260914T090000", "EXRULE:FREQ=DAILY")),
        ):
            with self.subTest(content=content[:30]), self.assertRaises(feeds.FeedError) as caught:
                self.parse(content)
            self.assertNotIn(SECRET, str(caught.exception))

    def test_bounded_input_components_events_and_recurrence_work(self):
        with self.assertRaises(feeds.FeedError):
            feeds.validate_ics("あ" * (feeds.MAX_ICS_BYTES // 3 + 1))
        with patch.object(feeds, "MAX_COMPONENTS", 1), self.assertRaises(feeds.FeedError):
            self.parse(SIMPLE)
        with patch.object(feeds, "MAX_LINE_BYTES", 20), self.assertRaises(feeds.FeedError):
            self.parse(SIMPLE)
        recurrence = ics(event("UID:bounded", "DTSTART:20260101T090000", "RRULE:FREQ=DAILY"))
        with patch.object(feeds, "MAX_SCAN_DAYS", 10), self.assertRaises(feeds.FeedError):
            self.parse(recurrence)
        with patch.object(feeds, "MAX_CANDIDATES", 3), self.assertRaises(feeds.FeedError):
            self.parse(recurrence)
        with patch.object(feeds, "MAX_CALENDAR_EVENTS", 2), self.assertRaises(feeds.FeedError):
            self.parse(recurrence)
        with patch.object(feeds, "MAX_EVENT_OUTPUT_BYTES", 128), self.assertRaises(feeds.FeedError):
            self.parse(SIMPLE)
        with patch.object(feeds, "MAX_TIMEZONE_SCAN_DAYS", 100), self.assertRaises(feeds.FeedError):
            feeds._bound_timezone_work([
                "BEGIN:STANDARD", "DTSTART:19000101T000000", "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30",
                "END:STANDARD", 'DTSTART;TZID="Custom:Timezone":99990101T090000',
            ])

    def test_warning_for_ignored_alarms_attachments_and_orphan_overrides(self):
        content = ics(event(
            "UID:alarm", "DTSTART:20260914T090000", "ATTACH:https://example.invalid/not-fetched",
            "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT5M", "DESCRIPTION:test", "END:VALARM",
        ), event("UID:orphan", "RECURRENCE-ID:20260914T090000", "DTSTART:20260915T090000"))
        result = self.parse(content)
        self.assertEqual(len(result["events"]), 2)
        self.assertEqual(len(result["warnings"]), 3)


class ParserIsolationTests(unittest.TestCase):
    def test_valid_workers_do_not_import_web_configuration_or_database_modules(self):
        with patch.object(feeds, "_parser_worker", parser_import_probe):
            self.assertEqual(feeds._run_parser("validate", SIMPLE), [])
            self.assertEqual(feeds._run_parser("events", SIMPLE, START, END, USER_ID), [])

    def test_repeated_cold_original_workers_accept_valid_content(self):
        for attempt in range(3):
            with self.subTest(attempt=attempt):
                feeds.validate_ics(SIMPLE)
                self.assertEqual(len(feeds.parse_ics(SIMPLE, START, END, USER_ID)["events"]), 1)

    def test_supervised_worker_handles_valid_data_and_safe_errors(self):
        feeds.validate_ics(SIMPLE)
        result = feeds.parse_ics(SIMPLE, START, END, USER_ID)
        self.assertEqual(len(result["events"]), 1)
        with self.assertRaises(feeds.FeedError) as caught:
            feeds.validate_ics("invalid " + SECRET)
        self.assertNotIn(SECRET, str(caught.exception))
        with self.assertRaises(feeds.FeedError):
            feeds.parse_ics(ics(event(
                "UID:ancient", "DTSTART:00010101T090000Z", "RRULE:FREQ=DAILY",
            )), START, END, USER_ID)

    def test_watchdog_kills_and_reaps_stalled_parser(self):
        existing = {child.pid for child in multiprocessing.active_children()}
        started = time.monotonic()
        with patch.object(feeds, "PARSER_SECONDS", 0.1), patch.object(feeds, "_parser_worker", sleeping_parser_worker):
            with self.assertRaises(feeds.FeedError) as caught:
                feeds.validate_ics(SIMPLE)
        self.assertEqual(str(caught.exception), feeds.PARSER_LIMIT)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual({child.pid for child in multiprocessing.active_children()}, existing)

    def test_oversized_worker_result_is_rejected_and_reaped(self):
        existing = {child.pid for child in multiprocessing.active_children()}
        with patch.object(feeds, "_parser_worker", oversized_parser_worker), self.assertRaises(feeds.FeedError):
            feeds.validate_ics(SIMPLE)
        self.assertEqual({child.pid for child in multiprocessing.active_children()}, existing)

    def test_parser_concurrency_has_no_unbounded_queue(self):
        with patch.object(feeds, "_parser_slots") as slots, patch.object(feeds.multiprocessing, "get_context") as context:
            slots.acquire.return_value = False
            with self.assertRaises(feeds.FeedError) as caught:
                feeds.validate_ics(SIMPLE)
            self.assertEqual(caught.exception.status_code, 503)
            context.assert_not_called()

    def test_ancient_daily_rules_are_rejected_before_any_event_iteration(self):
        content = ics(*(event(
            f"UID:ancient-{i}", "DTSTART:00010101T090000Z", "RRULE:FREQ=DAILY",
        ) for i in range(1000)))
        self.assertLess(len(content.encode("utf-8")), feeds.MAX_ICS_BYTES)
        with patch.object(feeds.rrule, "rrule") as expand:
            with self.assertRaises(feeds.FeedError):
                feeds._parse_ics_content(content, START, END, USER_ID)
            expand.assert_not_called()
        with patch.object(feeds.rrule, "rrule") as expand:
            with self.assertRaises(feeds.FeedError):
                feeds._parse_ics_content(ics(event(
                    "UID:subdaily", "DTSTART:00010101T090000Z", "RRULE:FREQ=SECONDLY",
                )), START, END, USER_ID)
            expand.assert_not_called()

    def test_pathological_timezone_is_rejected_before_timezone_library_parsing(self):
        timezone = "\r\n".join((
            "BEGIN:VTIMEZONE", "TZID:Custom/Pathological", "BEGIN:STANDARD",
            "DTSTART:00010101T000000", "TZOFFSETFROM:+0000", "TZOFFSETTO:+0100",
            "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30",
            "END:STANDARD", "END:VTIMEZONE",
        ))
        content = ics(event(
            "UID:far-future", "DTSTART;TZID=Custom/Pathological:99990101T090000",
        ), extra=timezone)
        with patch.object(feeds.Calendar, "from_ical") as parse:
            with self.assertRaises(feeds.FeedError):
                feeds._validate_ics_content(content)
            parse.assert_not_called()


class Response:
    def __init__(self, body=SIMPLE.encode(), status=200, headers=None):
        self.status = status
        self.headers = headers or {}
        self.stream = io.BytesIO(body)

    def getheader(self, key, default=None):
        return self.headers.get(key, default)

    def read1(self, size):
        return self.stream.read(size)

    def close(self):
        self.stream.close()


class FetchTests(unittest.TestCase):
    def addresses(self, *addresses):
        return [(socket.AF_INET6 if ":" in value else socket.AF_INET, socket.SOCK_STREAM, 6, "", (value, 443)) for value in addresses]

    def test_url_and_ip_policy_including_mapped_transition_and_metadata_addresses(self):
        for url in (
            "http://example.com/a", "https://user:pass@example.com/a", "https://example.com/a#fragment",
            "https://example.com:8443/a", "https://127.0.0.1/a", "https://[::1]/a",
            "https://169.254.169.254/a", "https://[::ffff:127.0.0.1]/a",
            "https://[2002:7f00:1::]/a", "https://168.63.129.16/a",
            "https://example.com/\r\n" + SECRET, "https://example.com\\@127.0.0.1/a",
        ):
            with self.subTest(url=url), self.assertRaises(feeds.FeedError) as caught:
                feeds.validate_feed_url(url)
            self.assertNotIn(SECRET, str(caught.exception))
        for address in (
            "10.0.0.1", "172.16.0.1", "192.168.1.1", "100.64.0.1", "224.0.0.1", "240.0.0.1",
            "192.0.0.8", "192.88.99.1", "::", "fc00::1", "fe80::1", "fec0::1", "ff02::1", "3fff::1",
        ):
            with self.subTest(address=address), self.assertRaises(feeds.FeedError):
                feeds._public_ip(address)
        self.assertEqual(feeds.validate_feed_url("https://calendar.example.com:443/a?" + SECRET), ("calendar.example.com", "/a?" + SECRET))

    def test_all_dns_answers_are_checked_including_rebinding_and_encoded_loopback(self):
        for answers in (self.addresses("93.184.216.34", "10.0.0.1"), self.addresses("127.0.0.1")):
            with patch.object(socket, "getaddrinfo", return_value=answers), self.assertRaises(feeds.FeedError):
                feeds._resolve("calendar.example.com", time.monotonic() + 5)
        with patch.object(socket, "getaddrinfo", return_value=self.addresses("127.0.0.1")), self.assertRaises(feeds.FeedError):
            feeds.fetch_ics("https://2130706433/a")
        with patch.object(socket, "getaddrinfo", side_effect=[
            self.addresses("93.184.216.34"), self.addresses("127.0.0.1"),
        ]), patch.object(feeds, "_PinnedHTTPSConnection") as connection:
            connection.return_value.getresponse.return_value = Response(status=302, headers={"Location": "/redirect"})
            with self.assertRaises(feeds.FeedError):
                feeds.fetch_ics("https://calendar.example.com/a?" + SECRET)
            connection.assert_called_once()

    def test_actual_socket_is_pinned_with_strict_original_host_tls(self):
        context = MagicMock(spec=ssl.SSLContext)
        raw, tls = MagicMock(), MagicMock()
        context.wrap_socket.return_value = tls
        with patch.object(ssl, "create_default_context", return_value=context), patch.object(socket, "socket", return_value=raw), patch.object(socket, "getaddrinfo") as dns:
            connection = feeds._PinnedHTTPSConnection("calendar.example.com", (socket.AF_INET, "93.184.216.34"), time.monotonic() + 5)
            connection.connect()
            raw.connect.assert_called_once_with(("93.184.216.34", 443))
            context.wrap_socket.assert_called_once_with(raw, server_hostname="calendar.example.com")
            dns.assert_not_called()
        self.assertEqual(ssl.create_default_context().verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(ssl.create_default_context().check_hostname)

    def fetch_with(self, responses):
        connections = []
        for response in responses:
            connection = MagicMock()
            connection.getresponse.return_value = response
            connections.append(connection)
        dns = patch.object(feeds, "_resolve", return_value=[(socket.AF_INET, "93.184.216.34")])
        connect = patch.object(feeds, "_PinnedHTTPSConnection", side_effect=connections)
        return dns, connect, connections

    def test_fresh_stream_cookie_free_redirect_and_no_forwarded_secrets(self):
        dns, connect, connections = self.fetch_with([
            Response(status=302, headers={"Location": "https://other.example.com/calendar", "Set-Cookie": SECRET}),
            Response(headers={"Content-Length": str(len(SIMPLE.encode()))}),
        ])
        with dns as resolver, connect:
            self.assertEqual(feeds.fetch_ics("https://calendar.example.com/calendar?" + SECRET), SIMPLE)
        self.assertEqual(resolver.call_count, 2)
        second = connections[1].request.call_args
        self.assertEqual(second.args, ("GET", "/calendar"))
        self.assertNotIn(SECRET, str(second))
        self.assertEqual(set(second.kwargs["headers"]), {"Accept", "Accept-Encoding", "User-Agent", "Connection"})
        for connection in connections:
            connection.close.assert_called_once()

    def test_private_redirect_never_connects_and_redirect_limit(self):
        dns, connect, connections = self.fetch_with([Response(status=302, headers={"Location": "https://127.0.0.1/" + SECRET})])
        with dns, connect as factory, self.assertRaises(feeds.FeedError) as caught:
            feeds.fetch_ics("https://calendar.example.com/a")
        factory.assert_called_once()
        self.assertNotIn(SECRET, str(caught.exception))
        dns, connect, _ = self.fetch_with([Response(status=302, headers={"Location": "/again"})] * 4)
        with dns, connect as factory, self.assertRaises(feeds.FeedError):
            feeds.fetch_ics("https://calendar.example.com/a")
        self.assertEqual(factory.call_count, 4)

    def test_stream_size_compression_status_encoding_and_truncation_fail_safely(self):
        for response in (
            Response(b"x" * (feeds.MAX_ICS_BYTES + 1)),
            Response(headers={"Content-Length": str(feeds.MAX_ICS_BYTES + 1)}),
            Response(headers={"Content-Encoding": "gzip"}),
            Response(status=403), Response(b"\xff"), Response(b"short", headers={"Content-Length": "100"}),
        ):
            dns, connect, _ = self.fetch_with([response])
            with dns, connect, self.assertRaises(feeds.FeedError) as caught:
                feeds.fetch_ics("https://calendar.example.com/a?" + SECRET)
            self.assertNotIn(SECRET, str(caught.exception))

        with patch.object(feeds, "_resolve", side_effect=socket.gaierror(SECRET)), self.assertRaises(feeds.FeedError) as caught:
            feeds.fetch_ics("https://calendar.example.com/a?" + SECRET)
        self.assertNotIn(SECRET, str(caught.exception))

    def test_network_unfolds_inside_multibyte_utf8_before_decoding(self):
        folded = SIMPLE.encode().replace("会".encode(), b"\xe4\r\n \xbc\x9a")
        dns, connect, _ = self.fetch_with([Response(folded)])
        with dns, connect:
            self.assertEqual(feeds.fetch_ics("https://calendar.example.com/feed"), SIMPLE)

    def test_timeout_and_socket_abort_are_finite(self):
        with patch.object(feeds, "_resolver_slots") as slots:
            slots.acquire.return_value = False
            with self.assertRaises(feeds.FeedError):
                feeds._resolve("example.com", time.monotonic() + 5)
        with self.assertRaises(feeds.FeedError):
            feeds._remaining(time.monotonic() - 1)
        connection = feeds._PinnedHTTPSConnection("example.com", (socket.AF_INET, "93.184.216.34"), time.monotonic() + 5)
        connection.sock = MagicMock()
        connection.abort()
        connection.sock.shutdown.assert_called_once_with(socket.SHUT_RDWR)
        connection.sock.close.assert_called_once()
        transport = connection.sock
        connection._transport = transport
        connection.sock = None
        connection.abort()
        self.assertEqual(transport.shutdown.call_count, 2)


class ApiValidationTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(routes, "_snapshot", return_value=None))
        self.enterContext(patch.object(routes, "_save_snapshot", return_value=START))
        application = FastAPI()
        application.include_router(routes.router)
        self.assertEqual(application.router.on_startup, [])
        application.dependency_overrides[get_current_user] = actor
        self.client = TestClient(application)
        self.client.event_hooks["response"] = [
            lambda response: self.assertEqual(response.headers.get("Cache-Control"), "private, no-store")
        ]
        self.addCleanup(self.client.close)

    def test_upload_input_errors_never_echo_secret_content_and_unknown_fields_rejected(self):
        for data in (
            {"name": "url", "kind": "url", "url": "https://example.com/" + SECRET, "extra": SECRET},
            {"name": "file", "kind": "file", "content": SIMPLE, "url": SECRET},
            {"name": "file", "kind": "file", "content": "あ" * (feeds.MAX_ICS_BYTES // 3 + 1)},
            {"name": "n" * 101, "kind": "url", "url": SECRET},
            {"name": "url", "kind": "url", "url": SECRET, "visible": "true"},
        ):
            with self.subTest(keys=list(data)), patch.object(routes, "engine") as engine:
                response = self.client.post("/api/calendar/feeds", json=data)
                self.assertEqual(response.status_code, 422)
                self.assertNotIn(SECRET, response.text)
                engine.begin.assert_not_called()
        response = self.client.post("/api/calendar/feeds", content='{"content":"' + SECRET)
        self.assertEqual(response.status_code, 422)
        self.assertNotIn(SECRET, response.text)
        with patch.object(routes, "MAX_JSON_BYTES", 10):
            response = self.client.post("/api/calendar/feeds", content=SECRET)
            self.assertEqual(response.status_code, 413)

    def test_metadata_and_preferences_validation(self):
        for data in ({}, {"url": SECRET}, {"visible": None}, {"name": " "}, {"color": "#123"}):
            response = self.client.put("/api/calendar/feeds/" + USER_ID, json=data)
            self.assertEqual(response.status_code, 422)
            self.assertNotIn(SECRET, response.text)
        for data in (
            {"show_personal": True, "show_group": False},
            {"show_personal": True, "show_group": False, "view": "agenda"},
            {"show_personal": True, "show_group": False, "view": "month", "owner_id": OTHER_ID},
        ):
            self.assertEqual(self.client.put("/api/calendar/preferences", json=data).status_code, 422)

    def test_entra_refuses_storing_secrets_without_explicit_key(self):
        with patch.object(settings, "auth_mode", "entra"), patch.object(settings, "sensitive_enc_key", ""), patch.object(routes, "engine") as engine, patch.object(routes, "encrypt_str") as encrypt:
            response = self.client.post("/api/calendar/feeds", json={"name": "private", "kind": "file", "content": SIMPLE})
            self.assertEqual(response.status_code, 503)
            engine.begin.assert_not_called()
            encrypt.assert_not_called()

    def test_all_success_routes_are_private_and_not_cacheable(self):
        row = {
            "id": UUID(USER_ID), "name": "private", "kind": "file", "color": "#2563eb",
            "visible": True, "filename": "test.ics", "last_fetched_at": None, "last_error": None,
            "url_enc": None, "content_enc": b"encrypted",
        }
        preferences = routes.DEFAULT_PREFERENCES
        with patch.object(routes, "engine") as engine, patch.object(routes, "require_feed_key"), patch.object(routes, "encrypt_str", return_value=b"encrypted"), patch.object(routes, "decrypt_bytes", return_value=SIMPLE):
            result = engine.begin.return_value.__enter__.return_value.execute.return_value
            result.scalar_one.return_value = 0
            result.first.return_value = (USER_ID,)
            result.mappings.return_value.all.return_value = [row]
            cases = (
                ("GET", "/feeds", {}),
                ("POST", "/feeds", {"json": {"name": "private", "kind": "file", "content": SIMPLE}}),
                ("PUT", "/feeds/" + USER_ID, {"json": {"visible": False}}),
                ("DELETE", "/feeds/" + USER_ID, {}),
                ("GET", "/feeds/" + USER_ID + "/events", {"params": {"start": START.isoformat(), "end": END.isoformat()}}),
                ("GET", "/preferences", {}),
                ("PUT", "/preferences", {"json": preferences}),
            )
            for method, path, options in cases:
                with self.subTest(method=method, path=path):
                    result.mappings.return_value.one.return_value = preferences if path == "/preferences" else row
                    result.mappings.return_value.first.return_value = preferences if path == "/preferences" else row
                    response = self.client.request(method, "/api/calendar" + path, **options)
                    self.assertEqual(response.status_code, 200)

    def test_repeated_real_parser_calls_from_fastapi_worker_threads(self):
        row = {
            "id": UUID(USER_ID), "name": "thread test", "kind": "file", "color": "#2563eb",
            "visible": True, "filename": "test.ics", "last_fetched_at": None, "last_error": None,
            "url_enc": None, "content_enc": b"encrypted",
        }
        threads = []
        original_run = feeds._run_parser

        def record_thread(*args, **kwargs):
            threads.append(threading.get_ident())
            return original_run(*args, **kwargs)

        with patch.object(routes, "engine") as engine, patch.object(routes, "require_feed_key"), patch.object(routes, "encrypt_str", return_value=b"encrypted"), patch.object(routes, "decrypt_bytes", return_value=SIMPLE), patch.object(feeds, "_run_parser", side_effect=record_thread):
            result = engine.begin.return_value.__enter__.return_value.execute.return_value
            result.scalar_one.return_value = 0
            result.mappings.return_value.one.return_value = row
            result.mappings.return_value.first.return_value = row
            for attempt in range(3):
                with self.subTest(attempt=attempt):
                    created = self.client.post("/api/calendar/feeds", json={
                        "name": "thread test", "kind": "file", "content": SIMPLE,
                    })
                    self.assertEqual(created.status_code, 200)
                    response = self.client.get("/api/calendar/feeds/" + USER_ID + "/events", params={
                        "start": START.isoformat(), "end": END.isoformat(),
                    })
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(len(response.json()["events"]), 1)
        self.assertEqual(len(threads), 6)
        self.assertNotIn(threading.get_ident(), threads)

    def test_authentication_framework_and_unexpected_errors_are_not_cacheable(self):
        def denied():
            raise HTTPException(401, "サインインしてください。", headers={"WWW-Authenticate": "Bearer"})

        self.client.app.dependency_overrides[get_current_user] = denied
        response = self.client.get("/api/calendar/feeds")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.headers["WWW-Authenticate"], "Bearer")
        self.client.app.dependency_overrides[get_current_user] = actor
        response = self.client.get("/api/calendar/feeds/invalid/events")
        self.assertEqual(response.status_code, 422)
        response = self.client.patch("/api/calendar/preferences")
        self.assertEqual(response.status_code, 405)
        with patch.object(routes, "engine") as engine:
            engine.begin.side_effect = RuntimeError(SECRET)
            with self.assertLogs(routes.logger, level="ERROR") as logs:
                response = self.client.get("/api/calendar/preferences")
        self.assertEqual(response.status_code, 500)
        self.assertNotIn(SECRET, response.text)
        self.assertNotIn(SECRET, str(logs.output))

    def test_window_validation_precedes_secret_read(self):
        with patch.object(routes, "engine") as engine:
            for start, end in (
                ("2026-09-01T00:00:00", END.isoformat()),
                (END.isoformat(), START.isoformat()),
                (START.isoformat(), "2027-01-01T00:00:00+09:00"),
            ):
                response = self.client.get("/api/calendar/feeds/" + USER_ID + "/events", params={"start": start, "end": end})
                self.assertEqual(response.status_code, 422)
            engine.begin.assert_not_called()

    def test_schema_matches_fresh_schema_and_migration_uses_transaction_lock(self):
        migration = Path(feeds.__file__).with_name("calendar_feeds_schema.sql").read_text(encoding="utf-8").strip()
        fresh = (Path(__file__).resolve().parents[2] / "db" / "schema.sql").read_text(encoding="utf-8")
        self.assertIn(migration, fresh)
        with patch.object(db, "engine") as engine:
            feeds.ensure_calendar_feeds_schema()
            calls = engine.begin.return_value.__enter__.return_value.execute.call_args_list
            self.assertIn("pg_advisory_xact_lock", str(calls[0].args[0]))
            self.assertEqual(str(calls[1].args[0]).strip(), migration)


class OwnershipAndStatusTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(routes, "_snapshot", return_value=None))
        mocked = patch.object(routes, "engine")
        self.addCleanup(mocked.stop)
        self.engine = mocked.start()
        self.context = self.engine.begin.return_value
        self.cn = self.context.__enter__.return_value
        self.user = actor(USER_ID, admin=True)
        self.feed_id = UUID(OTHER_ID)
        self.row = {
            "id": self.feed_id, "name": "Private feed", "kind": "url", "color": "#2563eb",
            "visible": True, "filename": None, "last_fetched_at": None, "last_error": None,
            "url_enc": b"encrypted-url", "content_enc": None,
        }
        self.cn.execute.return_value.mappings.return_value.first.return_value = self.row

    def assert_owner_queries(self):
        for call in self.cn.execute.call_args_list:
            sql, parameters = str(call.args[0]), call.args[1]
            self.assertIn("owner_id=:owner_id", sql)
            self.assertEqual(parameters["owner_id"], USER_ID)

    def test_explicit_refresh_reads_fresh_and_never_creates_outlook_events(self):
        with patch.object(routes, "_save_snapshot", return_value=START), patch.object(routes, "require_feed_key"), patch.object(routes, "decrypt_bytes", return_value="https://example.com/?" + SECRET), patch.object(routes, "fetch_ics", return_value=SIMPLE) as fetch, patch("app.calendar.create_group_event") as graph:
            first = routes.feed_events(self.feed_id, START, END, self.user, refresh=True)
            second = routes.feed_events(self.feed_id, START, END, self.user, refresh=True)
        self.assertEqual(first, second)
        self.assertEqual(fetch.call_count, 2)
        graph.assert_not_called()
        self.assert_owner_queries()
        self.assertEqual(self.engine.begin.call_count, 2)

    def test_failure_status_transaction_finishes_before_http_error(self):
        with patch.object(routes, "require_feed_key"), patch.object(routes, "decrypt_bytes", return_value="https://example.com/?" + SECRET), patch.object(routes, "fetch_ics", side_effect=feeds.FeedError(feeds.FETCH_FAILED, 502)), self.assertRaises(HTTPException) as caught:
            routes.feed_events(self.feed_id, START, END, self.user)
        self.assertEqual(caught.exception.status_code, 502)
        self.assertNotIn(SECRET, str(caught.exception))
        self.assert_owner_queries()
        updates = [call for call in self.cn.execute.call_args_list if str(call.args[0]).lstrip().startswith("UPDATE ")]
        self.assertEqual(updates[0].args[1]["error"], feeds.FETCH_FAILED)
        self.assertEqual(self.context.__exit__.call_count, 2)
        self.assertEqual(self.context.__exit__.call_args.args, (None, None, None))

    def test_fetch_status_uses_explicit_text_cast_for_null_and_error_values(self):
        for error in (None, feeds.FETCH_FAILED):
            routes._record_fetch(self.feed_id, self.user.id, error)
            call = self.cn.execute.call_args
            self.assertEqual(str(call.args[0]).count("CAST(:error AS text)"), 2)
            self.assertEqual(call.args[1]["error"], error)
        self.assert_owner_queries()

    def test_missing_owned_row_blocks_admin_reads_mutations_and_fetch(self):
        self.cn.execute.return_value.mappings.return_value.first.return_value = None
        self.cn.execute.return_value.first.return_value = None
        with patch.object(routes, "decrypt_bytes") as decrypt, patch.object(routes, "fetch_ics") as fetch:
            for operation in (
                lambda: routes.feed_events(self.feed_id, START, END, self.user),
                lambda: routes.update_feed(self.feed_id, routes.FeedUpdate(visible=False), self.user),
                lambda: routes.delete_feed(self.feed_id, self.user),
            ):
                with self.assertRaises(HTTPException) as caught:
                    operation()
                self.assertEqual(caught.exception.status_code, 404)
            decrypt.assert_not_called()
            fetch.assert_not_called()
        self.assert_owner_queries()

    def test_entra_read_without_key_never_decrypts_or_downloads(self):
        with patch.object(settings, "auth_mode", "entra"), patch.object(settings, "sensitive_enc_key", ""), patch.object(routes, "decrypt_bytes") as decrypt, patch.object(routes, "fetch_ics") as fetch, self.assertRaises(HTTPException) as caught:
            routes.feed_events(self.feed_id, START, END, self.user)
        self.assertEqual(caught.exception.status_code, 503)
        decrypt.assert_not_called()
        fetch.assert_not_called()
        self.assert_owner_queries()

    def test_warm_crypto_cache_cannot_bypass_production_key_guard(self):
        crypto._fernet.cache_clear()
        self.addCleanup(crypto._fernet.cache_clear)
        with patch.object(settings, "sensitive_enc_key", "calendar-test-cache-key"):
            crypto.encrypt_str("cache warmup")
        self.assertEqual(crypto._fernet.cache_info().currsize, 1)
        cached = crypto._fernet.cache_info()
        with patch.object(settings, "auth_mode", "entra"), patch.object(settings, "sensitive_enc_key", ""), patch.object(routes, "encrypt_str", wraps=crypto.encrypt_str) as encrypt, patch.object(routes, "decrypt_bytes", wraps=crypto.decrypt_bytes) as decrypt:
            for operation in (
                lambda: routes.create_feed(routes.FeedCreate(name="private", kind="file", content=SIMPLE), self.user),
                lambda: routes.feed_events(self.feed_id, START, END, self.user),
            ):
                with self.assertRaises(HTTPException) as caught:
                    operation()
                self.assertEqual(caught.exception.status_code, 503)
            encrypt.assert_not_called()
            decrypt.assert_not_called()
        self.assertEqual(crypto._fernet.cache_info(), cached)

    def test_lists_preferences_and_upserts_are_owner_scoped(self):
        self.cn.execute.return_value.mappings.return_value.all.return_value = [self.row]
        result = routes.list_feeds(self.user)
        self.assertNotIn("url_enc", result["items"][0])
        self.assertNotIn("content_enc", result["items"][0])
        self.cn.execute.return_value.mappings.return_value.first.return_value = None
        self.assertEqual(routes.get_preferences(self.user), routes.DEFAULT_PREFERENCES)
        self.cn.execute.return_value.mappings.return_value.one.return_value = routes.DEFAULT_PREFERENCES
        routes.put_preferences(routes.Preferences(**routes.DEFAULT_PREFERENCES), self.user)
        self.assert_owner_queries()


if __name__ == "__main__":
    unittest.main()
