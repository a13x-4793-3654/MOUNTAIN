import os
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

from fastapi import HTTPException, Request
from sqlalchemy import create_engine, text

from app import calendar
from app.routers import contracts
from test_calendar import COMM_ID, CONTRACT_ID, USER_ID, actor, enabled_config, schedule_data


class CalendarPersistenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        url = os.environ.get("TEST_DATABASE_URL")
        if not url:
            raise unittest.SkipTest("Set TEST_DATABASE_URL to a PostgreSQL test database")
        cls.engine = create_engine(url)
        cls.addClassCleanup(cls.engine.dispose)

    def setUp(self):
        self.cn = self.engine.connect()
        self.addCleanup(self.cn.close)
        transaction = self.cn.begin()
        self.addCleanup(transaction.rollback)
        self.cn.execute(text("SET LOCAL search_path TO pg_temp"))
        for statement in (
            "CREATE TEMP TABLE users (id uuid PRIMARY KEY)",
            "CREATE TEMP TABLE contracts (id uuid PRIMARY KEY, contract_no text)",
            """CREATE TEMP TABLE communications (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
                occurred_at timestamptz NOT NULL, channel text, direction text,
                summary text, details text, updated_at timestamptz DEFAULT now()
            )""",
        ):
            self.cn.execute(text(statement))
        schema = (Path(calendar.__file__).with_name("calendar_schema.sql")).read_text(encoding="utf-8")
        self.cn.execute(text(schema.replace("CREATE TABLE IF NOT EXISTS", "CREATE TEMP TABLE")))
        self.cn.execute(text("INSERT INTO users VALUES (:id)"), {"id": UUID(USER_ID)})
        self.cn.execute(
            text("INSERT INTO contracts VALUES (:id, 'CALENDAR-TEST')"), {"id": UUID(CONTRACT_ID)}
        )
        for module in (contracts, calendar):
            patched = patch.object(module, "engine")
            self.addCleanup(patched.stop)
            mocked = patched.start()
            mocked.begin.side_effect = lambda: nullcontext(self.cn)
        config = enabled_config()
        config.__enter__()
        self.addCleanup(config.__exit__, None, None, None)
        self.user = actor()
        self.request = Request({"type": "http", "headers": [(b"authorization", b"Bearer test-api-token")]})

    def create(self, schedule=True):
        body = contracts.CommunicationCreateIn(
            direction="in", summary="Follow up", details="Original memo",
            calendar=calendar.CalendarIn(**schedule_data()) if schedule else None,
        )
        return contracts.add_communication(UUID(CONTRACT_ID), body, self.request, self.user)

    def count(self, table):
        self.assertIn(table, ("communications", "communication_calendar_events"))
        return self.cn.execute(text(f"SELECT count(*) FROM {table}")).scalar_one()

    def test_unchecked_creates_only_history_with_default_timestamp(self):
        with patch("app.calendar.create_group_event") as graph:
            result = self.create(schedule=False)
        self.assertIsNone(result["calendar"])
        self.assertEqual(self.count("communications"), 1)
        self.assertEqual(self.count("communication_calendar_events"), 0)
        self.assertIsNotNone(self.cn.execute(text("SELECT occurred_at FROM communications")).scalar_one())
        graph.assert_not_called()

    def test_replay_and_retry_do_not_duplicate_created_event_or_history(self):
        with patch("app.calendar.create_group_event", return_value="graph-event") as graph:
            first = self.create()
            second = self.create()
            retry = contracts.retry_communication_calendar(UUID(first["id"]), self.request, self.user)
        self.assertEqual(first, second)
        self.assertEqual(first["calendar"], retry)
        self.assertEqual(self.count("communications"), 1)
        self.assertEqual(self.count("communication_calendar_events"), 1)
        graph.assert_called_once()
        self.assertEqual(
            self.cn.execute(text("SELECT event_id FROM communication_calendar_events")).scalar_one(),
            "graph-event",
        )
        row = self.cn.execute(contracts.COMMUNICATIONS_SQL, {"id": CONTRACT_ID}).mappings().one()
        self.assertEqual(row["calendar"]["status"], "created")
        self.assertEqual(row["calendar"]["calendar_name"], "Group calendar")

    def test_failed_event_keeps_history_and_retries_immutable_snapshot(self):
        with patch("app.calendar.create_group_event", side_effect=calendar.CalendarError("Permission denied")):
            with self.assertLogs("app.calendar", level="WARNING"):
                first = self.create()
        self.assertEqual(first["calendar"]["status"], "failed")
        self.assertEqual(self.count("communications"), 1)
        contracts.update_communication(UUID(first["id"]), contracts.CommunicationCreateIn(
            direction="in", summary="Edited history", details="Edited memo",
        ), self.request, self.user)
        with patch("app.calendar.create_group_event", return_value="graph-event") as graph:
            result = contracts.retry_communication_calendar(UUID(first["id"]), self.request, self.user)
        self.assertEqual(result["status"], "created")
        payload = graph.call_args.args[2]
        self.assertIn("Original memo", payload["body"]["content"])
        self.assertNotIn("Edited memo", payload["body"]["content"])
        self.assertEqual(payload["start"]["dateTime"], "2026-09-14T06:00:00")
        self.assertEqual(self.count("communications"), 1)

    def test_missing_request_and_other_actor_cannot_register_events(self):
        with self.assertRaises(HTTPException) as missing:
            contracts.retry_communication_calendar(UUID(COMM_ID), self.request, self.user)
        self.assertEqual(missing.exception.status_code, 404)
        with patch("app.calendar.create_group_event", return_value="graph-event"):
            result = self.create()
        self.user.id = COMM_ID
        with patch("app.calendar.create_group_event") as graph:
            with self.assertRaises(HTTPException) as forbidden:
                contracts.retry_communication_calendar(UUID(result["id"]), self.request, self.user)
        self.assertEqual(forbidden.exception.status_code, 403)
        graph.assert_not_called()

    def test_schedule_from_edit_is_unique_and_replay_does_not_undo_later_edits(self):
        first = self.create(schedule=False)
        comm_id = UUID(first["id"])
        scheduled = contracts.CommunicationCreateIn(
            direction="out", summary="Scheduled edit", details="Calendar snapshot",
            calendar=calendar.CalendarIn(**schedule_data()),
        )
        with patch("app.calendar.create_group_event", return_value="graph-event") as graph:
            result = contracts.update_communication(comm_id, scheduled, self.request, self.user)
            self.assertEqual(result["calendar"]["status"], "created")
            contracts.update_communication(
                comm_id, contracts.CommunicationCreateIn(direction="in", summary="Later edit"),
                self.request, self.user,
            )
            replay = contracts.update_communication(comm_id, scheduled, self.request, self.user)
            self.assertEqual(replay, result)
        graph.assert_called_once()
        self.assertEqual(self.cn.execute(text("SELECT summary FROM communications")).scalar_one(), "Later edit")
        self.assertEqual(self.count("communications"), 1)
        self.assertEqual(self.count("communication_calendar_events"), 1)
        new_request = scheduled.model_copy(update={
            "calendar": calendar.CalendarIn(**{**schedule_data(), "request_id": USER_ID}),
        })
        with patch("app.calendar.create_group_event") as graph:
            with self.assertRaises(HTTPException) as conflict:
                contracts.update_communication(comm_id, new_request, self.request, self.user)
        self.assertEqual(conflict.exception.status_code, 409)
        graph.assert_not_called()
        payload = self.cn.execute(text("SELECT graph_payload FROM communication_calendar_events")).scalar_one()
        self.assertIn("Calendar snapshot", payload["body"]["content"])
        self.assertIn(f"#communication-{comm_id}", payload["body"]["content"])

    def test_edit_cannot_reuse_request_for_another_history(self):
        with patch("app.calendar.create_group_event", return_value="graph-event"):
            self.create()
        second = self.create(schedule=False)
        body = contracts.CommunicationCreateIn(
            direction="out", summary="Should not be saved", calendar=calendar.CalendarIn(**schedule_data()),
        )
        with patch("app.calendar.create_group_event") as graph, self.assertRaises(HTTPException) as conflict:
            contracts.update_communication(UUID(second["id"]), body, self.request, self.user)
        self.assertEqual(conflict.exception.status_code, 409)
        graph.assert_not_called()
        self.assertEqual(self.cn.execute(
            text("SELECT summary FROM communications WHERE id=:id"), {"id": UUID(second["id"])}
        ).scalar_one(), "Follow up")

    def test_failed_schedule_from_edit_preserves_history_and_original_request(self):
        first = self.create(schedule=False)
        body = contracts.CommunicationCreateIn(
            direction="out", summary="Saved edited history",
            calendar=calendar.CalendarIn(**schedule_data()),
        )
        with patch(
            "app.calendar.create_group_event", side_effect=calendar.CalendarError("Temporary failure")
        ), self.assertLogs("app.calendar", level="WARNING"):
            result = contracts.update_communication(UUID(first["id"]), body, self.request, self.user)
        self.assertEqual(result["calendar"]["status"], "failed")
        self.assertEqual(self.cn.execute(text("SELECT summary FROM communications")).scalar_one(), body.summary)
        self.assertEqual(self.count("communications"), 1)
        self.assertEqual(self.count("communication_calendar_events"), 1)
        with patch("app.calendar.create_group_event", return_value="graph-event") as graph:
            replay = contracts.update_communication(UUID(first["id"]), body, self.request, self.user)
        self.assertEqual(replay["calendar"]["status"], "created")
        self.assertEqual(graph.call_args.args[2]["transactionId"], schedule_data()["request_id"])


if __name__ == "__main__":
    unittest.main()
