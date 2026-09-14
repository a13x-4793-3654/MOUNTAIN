import os
import unittest
from contextlib import contextmanager
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import create_engine, text

from app import calendar_feeds as feeds, calendar_snapshots as snapshots, db
from app.config import settings
from app.crypto import decrypt_bytes
from app.routers import calendar_feeds as routes
from test_calendar_feeds import END, OTHER_ID, SECRET, SIMPLE, START, USER_ID, actor, event, ics


class FeedPersistenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        url = os.environ.get("TEST_DATABASE_URL")
        if not url:
            raise unittest.SkipTest("Set TEST_DATABASE_URL to an isolated PostgreSQL test database")
        cls.engine = create_engine(url)
        cls.addClassCleanup(cls.engine.dispose)

    def setUp(self):
        self.cn = self.engine.connect()
        self.addCleanup(self.cn.close)
        transaction = self.cn.begin()
        self.addCleanup(transaction.rollback)
        self.cn.execute(text("SET LOCAL search_path TO pg_temp"))
        self.cn.execute(text("CREATE TEMP TABLE users (id uuid PRIMARY KEY)"))
        schema = Path(feeds.__file__).with_name("calendar_feeds_schema.sql").read_text(encoding="utf-8")
        for statement in schema.replace("CREATE TABLE IF NOT EXISTS", "CREATE TEMP TABLE").split(";"):
            if statement.strip():
                self.cn.execute(text(statement))
        for table in ("users", "calendar_feeds", "calendar_feed_snapshots", "calendar_preferences"):
            persistence = self.cn.execute(text(
                "SELECT relpersistence FROM pg_class WHERE oid=to_regclass(:table)"
            ), {"table": table}).scalar_one()
            self.assertEqual(persistence, "t", "Feed tests must use temporary tables only")
        self.cn.execute(text("INSERT INTO users VALUES (:id), (:other)"), {"id": UUID(USER_ID), "other": UUID(OTHER_ID)})
        for module in (routes, db):
            mocked = patch.object(module, "engine")
            self.addCleanup(mocked.stop)
            mocked.start().begin.side_effect = self.transaction_scope
        config = patch.object(settings, "auth_mode", "dev")
        config.start()
        self.addCleanup(config.stop)
        self.user = actor()
        self.other = actor(OTHER_ID, admin=True)

    @contextmanager
    def transaction_scope(self):
        # Exercise real commit/rollback boundaries without ever committing the
        # outer fixture transaction or touching persistent application tables.
        with self.cn.begin_nested():
            yield self.cn

    def create_file(self, user=None):
        return routes.create_feed(routes.FeedCreate(
            name="Uploaded calendar", kind="file", content=SIMPLE, filename="test.ics",
        ), user or self.user)

    def test_file_encryption_persistence_metadata_and_repeated_reads_never_write_graph(self):
        with patch("app.calendar.create_group_event") as write:
            result = self.create_file()
            feed_id = UUID(result["id"])
            row = self.cn.execute(text(
                "SELECT content_enc, url_enc FROM calendar_feeds WHERE owner_id=:owner_id AND id=:id"
            ), {"owner_id": USER_ID, "id": feed_id}).mappings().one()
            self.assertIsNone(row["url_enc"])
            self.assertNotIn(b"VCALENDAR", bytes(row["content_enc"]))
            self.assertEqual(decrypt_bytes(row["content_enc"]), SIMPLE)
            self.assertEqual(routes.list_feeds(self.user)["items"], [result])
            self.assertNotIn("content", result)
            self.assertNotIn("url", result)
            first = routes.feed_events(feed_id, START, END, self.user)
            second = routes.feed_events(feed_id, START, END, actor())
            self.assertEqual(first["events"], second["events"])
            self.assertFalse(first["cache"]["from_cache"])
            self.assertTrue(second["cache"]["from_cache"])
            self.assertEqual(first["cache"]["saved_at"], second["cache"]["saved_at"])
            self.assertEqual(len(first["events"]), 1)
            self.assertIsNotNone(routes.list_feeds(self.user)["items"][0]["last_fetched_at"])
            write.assert_not_called()
        self.assertEqual(self.cn.execute(text(
            "SELECT count(*) FROM calendar_feeds WHERE owner_id=:owner_id"
        ), {"owner_id": USER_ID}).scalar_one(), 1)

    def test_admin_cannot_list_read_update_delete_or_change_other_owner(self):
        first = self.create_file()
        feed_id = UUID(first["id"])
        self.assertEqual(routes.list_feeds(self.other), {"items": []})
        for operation in (
            lambda: routes.feed_events(feed_id, START, END, self.other),
            lambda: routes.update_feed(feed_id, routes.FeedUpdate(name="not mine"), self.other),
            lambda: routes.delete_feed(feed_id, self.other),
        ):
            with self.assertRaises(HTTPException) as caught:
                operation()
            self.assertEqual(caught.exception.status_code, 404)
        self.assertEqual(routes.list_feeds(self.user)["items"], [first])
        updated = routes.update_feed(feed_id, routes.FeedUpdate(color="#ABCDEF", visible=False), self.user)
        self.assertEqual(updated["color"], "#abcdef")
        self.assertFalse(updated["visible"])
        self.assertEqual(routes.delete_feed(feed_id, self.user), {"ok": True})
        self.assertEqual(routes.list_feeds(self.user), {"items": []})

    def test_url_is_saved_until_explicit_refresh_with_visible_failure_fallback(self):
        url = "https://calendar.example.com/feed?token=" + SECRET
        result = routes.create_feed(routes.FeedCreate(name="Subscription", kind="url", url=url), self.user)
        feed_id = UUID(result["id"])
        encrypted = self.cn.execute(text(
            "SELECT url_enc FROM calendar_feeds WHERE owner_id=:owner_id AND id=:id"
        ), {"owner_id": USER_ID, "id": feed_id}).scalar_one()
        self.assertNotIn(SECRET.encode(), bytes(encrypted))
        self.assertEqual(decrypt_bytes(encrypted), url)
        self.assertNotIn(SECRET, str(result))
        with patch.object(routes, "fetch_ics", return_value=SIMPLE) as fetch:
            initial = routes.feed_events(feed_id, START, END, self.user)
            with patch.object(routes, "parse_ics") as parse:
                cached = routes.feed_events(feed_id, START, END, self.user)
                parse.assert_not_called()
            self.assertEqual(fetch.call_count, 1)
            fetch.assert_called_with(url)
        self.assertEqual(cached["events"], initial["events"])
        stored = self.cn.execute(text(
            "SELECT * FROM calendar_feed_snapshots WHERE feed_id=:id"
        ), {"id": feed_id}).mappings().one()
        self.assertEqual(decrypt_bytes(stored["content_enc"]), SIMPLE)
        self.assertNotIn(b"VCALENDAR", bytes(stored["content_enc"]))
        self.assertNotIn("会議".encode(), bytes(stored["result_enc"]))
        self.assertEqual(snapshots.decode_result(stored["result_enc"])["events"], initial["events"])
        previous = routes.list_feeds(self.user)["items"][0]["last_fetched_at"]
        with patch.object(routes, "fetch_ics", side_effect=feeds.FeedError(feeds.FETCH_FAILED, 502)):
            failed_read = routes.feed_events(feed_id, START, END, self.user, refresh=True)
        self.assertEqual(failed_read["events"], initial["events"])
        self.assertEqual(failed_read["cache"]["refresh_error"], feeds.FETCH_FAILED)
        self.assertTrue(failed_read["cache"]["from_cache"])
        failed = routes.list_feeds(self.user)["items"][0]
        self.assertEqual(failed["last_error"], feeds.FETCH_FAILED)
        self.assertEqual(failed["last_fetched_at"], previous)
        self.assertNotIn(SECRET, str(failed))
        replacement = SIMPLE.replace("会議", "updated")
        with patch.object(routes, "fetch_ics", return_value=replacement):
            updated = routes.feed_events(feed_id, START, END, self.user, refresh=True)
        self.assertEqual(updated["events"][0]["title"], "updated")
        self.assertIsNone(updated["cache"]["refresh_error"])
        self.assertIsNone(routes.list_feeds(self.user)["items"][0]["last_error"])
        self.assertEqual(self.cn.execute(text("SELECT count(*) FROM calendar_feed_snapshots")).scalar_one(), 1)
        with patch.object(routes, "fetch_ics", return_value=ics()):
            emptied = routes.feed_events(feed_id, START, END, self.user, refresh=True)
        self.assertEqual(emptied["events"], [])
        self.assertIsNone(emptied["cache"]["refresh_error"])

    def test_cached_subranges_keep_exclusive_all_day_and_zero_duration_boundaries(self):
        content = ics(
            event("UID:all", "DTSTART;VALUE=DATE:20260914", "DTEND;VALUE=DATE:20260916"),
            event("UID:point", "DTSTART:20260915T000000", "SUMMARY:point"),
            event("UID:ended", "DTSTART:20260914T230000", "DTEND:20260915T000000"),
            event("UID:later", "DTSTART:20260916T000000"),
        )
        created = routes.create_feed(routes.FeedCreate(name="bounds", kind="file", content=content), self.user)
        feed_id = UUID(created["id"])
        routes.feed_events(feed_id, START, END, self.user)
        with patch.object(routes, "parse_ics") as parse, patch.object(routes, "fetch_ics") as fetch:
            day = routes.feed_events(feed_id, START + timedelta(days=14), START + timedelta(days=15), self.user)
            parse.assert_not_called()
            fetch.assert_not_called()
        self.assertEqual(len(day["events"]), 2)
        self.assertTrue(any(item["all_day"] for item in day["events"]))
        self.assertTrue(any(item["title"] == "point" for item in day["events"]))

    def test_new_ranges_expand_saved_source_without_refetch_or_growing_snapshot_rows(self):
        created = routes.create_feed(routes.FeedCreate(
            name="range", kind="url", url="https://calendar.example.com/ics",
        ), self.user)
        feed_id = UUID(created["id"])
        content = ics(event("UID:repeat", "DTSTART:20260901T090000", "RRULE:FREQ=DAILY;COUNT=60"))
        with patch.object(routes, "fetch_ics", return_value=content) as fetch:
            initial = routes.feed_events(feed_id, START, END, self.user)
            future = routes.feed_events(feed_id, END, END + timedelta(days=20), self.user)
            self.assertEqual(fetch.call_count, 1)
        self.assertEqual(len(future["events"]), 20)
        self.assertEqual(future["cache"]["saved_at"], initial["cache"]["saved_at"])
        self.assertTrue(future["cache"]["from_cache"])
        self.assertEqual(self.cn.execute(text("SELECT count(*) FROM calendar_feed_snapshots")).scalar_one(), 1)

    def test_failed_first_fetch_has_no_snapshot_and_parser_failure_does_not_replace_success(self):
        created = routes.create_feed(routes.FeedCreate(
            name="failure", kind="url", url="https://calendar.example.com/ics",
        ), self.user)
        feed_id = UUID(created["id"])
        with patch.object(routes, "fetch_ics", side_effect=feeds.FeedError(feeds.FETCH_FAILED, 502)):
            with self.assertRaises(HTTPException) as caught:
                routes.feed_events(feed_id, START, END, self.user)
        self.assertEqual(caught.exception.status_code, 502)
        self.assertEqual(self.cn.execute(text("SELECT count(*) FROM calendar_feed_snapshots")).scalar_one(), 0)
        with patch.object(routes, "fetch_ics", return_value=SIMPLE):
            initial = routes.feed_events(feed_id, START, END, self.user)
            with patch.object(routes, "parse_ics", side_effect=feeds.FeedError(feeds.PARSER_LIMIT)):
                failed = routes.feed_events(feed_id, START, END, self.user, refresh=True)
        self.assertEqual(failed["events"], initial["events"])
        self.assertEqual(failed["cache"]["refresh_error"], feeds.PARSER_LIMIT)
        with patch.object(routes, "fetch_ics") as fetch, patch.object(routes, "parse_ics") as parse:
            saved = routes.feed_events(feed_id, START, END, self.user)
            fetch.assert_not_called()
            parse.assert_not_called()
        self.assertEqual(saved["cache"]["refresh_error"], feeds.PARSER_LIMIT)

    def test_cached_data_remains_owner_only_requires_key_and_cascades_on_delete(self):
        feed_id = UUID(self.create_file()["id"])
        routes.feed_events(feed_id, START, END, self.user)
        with self.assertRaises(HTTPException) as caught:
            routes.feed_events(feed_id, START, END, self.other, refresh=True)
        self.assertEqual(caught.exception.status_code, 404)
        with patch.object(settings, "auth_mode", "entra"), patch.object(settings, "sensitive_enc_key", ""):
            with self.assertRaises(HTTPException) as caught:
                routes.feed_events(feed_id, START, END, self.user, refresh=True)
        self.assertEqual(caught.exception.status_code, 503)
        routes.delete_feed(feed_id, self.user)
        self.assertEqual(self.cn.execute(text("SELECT count(*) FROM calendar_feed_snapshots")).scalar_one(), 0)

    def test_corrupt_saved_result_fails_explicitly_and_manual_refresh_repairs_it(self):
        feed_id = UUID(self.create_file()["id"])
        initial = routes.feed_events(feed_id, START, END, self.user)
        self.cn.execute(text(
            "UPDATE calendar_feed_snapshots SET result_enc=:broken WHERE feed_id=:id"
        ), {"id": feed_id, "broken": SECRET.encode()})
        with self.assertRaises(HTTPException) as caught:
            routes.feed_events(feed_id, START, END, self.user)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertNotIn(SECRET, str(caught.exception))
        repaired = routes.feed_events(feed_id, START, END, self.user, refresh=True)
        self.assertEqual(repaired["events"], initial["events"])
        self.assertIsNone(repaired["cache"]["refresh_error"])

    def test_concurrent_refresh_guards_snapshot_and_failure_status(self):
        feed_id = UUID(self.create_file()["id"])
        initial = routes.feed_events(feed_id, START, END, self.user)
        previous = routes._snapshot(self.cn, feed_id, self.user.id)
        new_content = SIMPLE.replace("会議", "newer")
        newer = feeds._parse_ics_content(new_content, START, END, str(feed_id))
        routes._save_snapshot(feed_id, self.user.id, previous, new_content, newer, START, END)
        self.assertIsNone(routes._save_snapshot(
            feed_id, self.user.id, previous, SIMPLE,
            {"events": initial["events"], "warnings": initial["warnings"]}, START, END,
        ))
        with patch.object(routes, "_snapshot", side_effect=[
            previous, routes._snapshot(self.cn, feed_id, self.user.id),
        ]), patch.object(routes, "parse_ics", side_effect=feeds.FeedError(feeds.PARSER_LIMIT)):
            result = routes.feed_events(feed_id, START, END, self.user, refresh=True)
        self.assertEqual(result["events"][0]["title"], "newer")
        self.assertIsNone(result["cache"]["refresh_error"])
        self.assertIsNone(routes.list_feeds(self.user)["items"][0]["last_error"])

    def test_preferences_are_full_persistent_per_user_with_defaults(self):
        self.assertEqual(routes.get_preferences(self.user), routes.DEFAULT_PREFERENCES)
        preferences = routes.Preferences(show_personal=False, show_group=True, view="week")
        self.assertEqual(routes.put_preferences(preferences, self.user), preferences.model_dump())
        self.assertEqual(routes.get_preferences(actor()), preferences.model_dump())
        self.assertEqual(routes.get_preferences(self.other), routes.DEFAULT_PREFERENCES)
        second = routes.Preferences(show_personal=True, show_group=False, view="day")
        routes.put_preferences(second, self.other)
        self.assertEqual(routes.get_preferences(self.user), preferences.model_dump())
        self.assertEqual(routes.get_preferences(self.other), second.model_dump())
        routes.put_preferences(second, self.user)
        self.assertEqual(routes.get_preferences(self.user), second.model_dump())

    def test_tentative_preference_defaults_hidden_and_legacy_updates_preserve_it(self):
        self.assertFalse(routes.get_preferences(self.user)["show_tentative"])
        enabled = routes.Preferences(show_personal=True, show_group=True, show_tentative=True, view="month")
        routes.put_preferences(enabled, self.user)
        self.assertTrue(routes.get_preferences(self.user)["show_tentative"])
        self.assertFalse(routes.get_preferences(self.other)["show_tentative"])
        routes.put_preferences(routes.Preferences(show_personal=True, show_group=False, view="week"), self.user)
        self.assertTrue(routes.get_preferences(self.user)["show_tentative"])
        routes.put_preferences(routes.Preferences(
            show_personal=True, show_group=True, show_tentative=False, view="month",
        ), self.user)
        self.assertFalse(routes.get_preferences(self.user)["show_tentative"])

    def test_migration_preserves_existing_preferences_and_hides_tentative_by_default(self):
        self.cn.execute(text("ALTER TABLE calendar_preferences DROP COLUMN show_tentative"))
        self.cn.execute(text("""
            INSERT INTO calendar_preferences (owner_id,show_personal,show_group,view)
            VALUES (:id,false,false,'week')
        """), {"id": self.user.id})
        feeds.ensure_calendar_feeds_schema()
        self.assertEqual(routes.get_preferences(self.user), {
            "show_personal": False, "show_group": False, "view": "week", "show_tentative": False,
        })

    def test_missing_key_and_decryption_errors_are_safe_and_recorded(self):
        feed_id = UUID(self.create_file()["id"])
        with patch.object(settings, "auth_mode", "entra"), patch.object(settings, "sensitive_enc_key", ""):
            with self.assertRaises(HTTPException) as caught:
                routes.feed_events(feed_id, START, END, self.user)
            self.assertEqual(caught.exception.status_code, 503)
        with patch.object(routes, "decrypt_bytes", side_effect=ValueError(SECRET)):
            with self.assertRaises(HTTPException) as caught:
                routes.feed_events(feed_id, START, END, self.user)
            self.assertEqual(caught.exception.status_code, 503)
        self.assertNotIn(SECRET, str(caught.exception))
        self.assertNotIn(SECRET, str(routes.list_feeds(self.user)))

    def test_schema_is_idempotent_and_sources_are_bounded_per_user(self):
        feeds.ensure_calendar_feeds_schema()
        feeds.ensure_calendar_feeds_schema()
        self.create_file()
        with patch.object(routes, "MAX_FEEDS", 1), self.assertRaises(HTTPException) as caught:
            self.create_file()
        self.assertEqual(caught.exception.status_code, 422)
        self.create_file(self.other)

    def test_fetch_status_accepts_null_and_text_binds_without_parser_dependency(self):
        created = routes.create_feed(routes.FeedCreate(
            name="Status regression", kind="url", url="https://calendar.example.com/feed",
        ), self.user)
        feed_id = UUID(created["id"])
        routes._record_fetch(feed_id, self.user.id, None)
        successful = routes.list_feeds(self.user)["items"][0]
        self.assertIsNotNone(successful["last_fetched_at"])
        self.assertIsNone(successful["last_error"])
        routes._record_fetch(feed_id, self.user.id, feeds.FETCH_FAILED)
        failed = routes.list_feeds(self.user)["items"][0]
        self.assertEqual(failed["last_error"], feeds.FETCH_FAILED)
        self.assertEqual(failed["last_fetched_at"], successful["last_fetched_at"])
        routes._record_fetch(feed_id, self.other.id, None)
        self.assertEqual(routes.list_feeds(self.user)["items"][0], failed)
        routes._record_fetch(feed_id, self.user.id, None)
        self.assertIsNone(routes.list_feeds(self.user)["items"][0]["last_error"])


if __name__ == "__main__":
    unittest.main()
