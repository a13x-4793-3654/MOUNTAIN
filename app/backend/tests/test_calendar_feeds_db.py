import os
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import create_engine, text

from app import calendar_feeds as feeds, db
from app.config import settings
from app.crypto import decrypt_bytes
from app.routers import calendar_feeds as routes
from test_calendar_feeds import END, OTHER_ID, SECRET, SIMPLE, START, USER_ID, actor


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
        for table in ("users", "calendar_feeds", "calendar_preferences"):
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
            self.assertEqual(first, second)
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

    def test_url_encrypted_fresh_each_time_failure_status_persists_and_no_stale_success(self):
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
            routes.feed_events(feed_id, START, END, self.user)
            routes.feed_events(feed_id, START, END, self.user)
            self.assertEqual(fetch.call_count, 2)
            fetch.assert_called_with(url)
        previous = routes.list_feeds(self.user)["items"][0]["last_fetched_at"]
        with patch.object(routes, "fetch_ics", side_effect=feeds.FeedError(feeds.FETCH_FAILED, 502)):
            with self.assertRaises(HTTPException) as caught:
                routes.feed_events(feed_id, START, END, self.user)
        self.assertEqual(caught.exception.status_code, 502)
        failed = routes.list_feeds(self.user)["items"][0]
        self.assertEqual(failed["last_error"], feeds.FETCH_FAILED)
        self.assertEqual(failed["last_fetched_at"], previous)
        self.assertNotIn(SECRET, str(failed))
        with patch.object(routes, "fetch_ics", return_value=SIMPLE):
            routes.feed_events(feed_id, START, END, self.user)
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
