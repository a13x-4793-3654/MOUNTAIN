import json
import unittest
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError

from app import calendar
from app.auth import CurrentUser, enforce_action, get_current_user, require_screen
from app.config import settings
from app.routers import contracts

GROUP_ID = "10000000-0000-0000-0000-000000000001"
REQUEST_ID = "20000000-0000-0000-0000-000000000001"
COMM_ID = "30000000-0000-0000-0000-000000000001"
CONTRACT_ID = "40000000-0000-0000-0000-000000000001"
USER_ID = "50000000-0000-0000-0000-000000000001"


def actor():
    return CurrentUser(
        id=USER_ID, display_name="Test user", user_principal_name="test@example.invalid",
        mail=None, status=0, is_admin=False,
        permissions=["screen.contracts", "action.contract.link"],
    )


def schedule_data():
    return {
        "request_id": REQUEST_ID,
        "starts_at": "2026-09-14T15:00:00+09:00",
        "ends_at": "2026-09-14T16:00:00+09:00",
    }


def saved_row(status="pending"):
    return {
        "communication_id": UUID(COMM_ID), "request_id": UUID(REQUEST_ID),
        "requested_by": UUID(USER_ID), "request_hash": "hash",
        "group_id": UUID(GROUP_ID), "calendar_name": "Group calendar",
        "starts_at": datetime.fromisoformat(schedule_data()["starts_at"]),
        "ends_at": datetime.fromisoformat(schedule_data()["ends_at"]),
        "graph_payload": {"transactionId": REQUEST_ID},
        "status": status, "last_error": None,
        "event_id": "event" if status == "created" else None,
    }


@contextmanager
def enabled_config():
    with patch.multiple(
        settings,
        auth_mode="entra", calendar_enabled=True, calendar_group_id=GROUP_ID,
        calendar_name="Group calendar", entra_tenant_id=GROUP_ID, entra_api_client_id=GROUP_ID,
        entra_api_client_secret=SecretStr("test-only-secret"),
    ):
        yield


class CalendarInputTests(unittest.TestCase):
    def test_explicit_timezone_and_valid_range_required(self):
        for overrides in (
            {"starts_at": "2026-09-14T15:00"},
            {"starts_at": "2026-02-30T15:00:00+09:00"},
            {"ends_at": schedule_data()["starts_at"]},
            {"ends_at": "2026-09-14T14:00:00+09:00"},
            {"starts_at": 1700000000},
            {"request_id": "not-a-uuid"},
            {"group_id": GROUP_ID},
        ):
            with self.subTest(overrides=overrides), self.assertRaises(ValidationError):
                calendar.CalendarIn(**{**schedule_data(), **overrides})

    def test_payload_uses_utc_plain_text_and_stable_transaction(self):
        schedule = calendar.CalendarIn(**schedule_data())
        payload = calendar.event_payload(schedule, "C-001", "<b>Summary</b>", "Memo", actor())
        self.assertEqual(payload["start"], {"dateTime": "2026-09-14T06:00:00", "timeZone": "UTC"})
        self.assertEqual(payload["end"]["dateTime"], "2026-09-14T07:00:00")
        self.assertEqual(payload["transactionId"], REQUEST_ID)
        self.assertEqual(payload["body"]["contentType"], "text")
        self.assertIn("Memo", payload["body"]["content"])
        self.assertIn("Test user", payload["body"]["content"])
        self.assertNotIn("attendees", payload)

    def test_configuration_fails_closed_without_disclosing_secret(self):
        with enabled_config():
            self.assertEqual(calendar.calendar_config(), {
                "enabled": True, "name": "Group calendar", "unavailable_reason": None,
            })
            for overrides in (
                {"calendar_enabled": False},
                {"auth_mode": "dev"},
                {"calendar_group_id": "../me"},
                {"entra_tenant_id": ""},
                {"entra_api_client_secret": SecretStr("")},
            ):
                with self.subTest(overrides=overrides), patch.multiple(settings, **overrides):
                    config = calendar.calendar_config()
                    self.assertFalse(config["enabled"])
                    self.assertTrue(config["unavailable_reason"])
                    self.assertNotIn("test-only-secret", json.dumps(config))

    def test_fresh_schema_matches_upgrade(self):
        backend = Path(__file__).resolve().parents[1]
        migration = (backend / "app" / "calendar_schema.sql").read_text(encoding="utf-8")
        schema = (backend.parent / "db" / "schema.sql").read_text(encoding="utf-8")
        self.assertIn(migration.strip(), schema)

    def test_snapshot_persists_original_destination_and_body_without_tokens(self):
        cn = MagicMock()
        schedule = calendar.CalendarIn(**schedule_data())
        payload = calendar.event_payload(schedule, "C-001", "Summary", "Memo", actor())
        with enabled_config():
            calendar.save_calendar_request(cn, COMM_ID, schedule, "request-hash", payload, actor())
        params = cn.execute.call_args.args[1]
        self.assertEqual(params["group_id"], GROUP_ID)
        self.assertEqual(params["request_id"], REQUEST_ID)
        self.assertEqual(params["user_id"], USER_ID)
        self.assertEqual(json.loads(params["payload"]), payload)
        self.assertNotIn("test-only-secret", str(params))


class GraphTests(unittest.TestCase):
    def run_graph(self, graph_status=201, graph_body=None, token_status=200, token_body=None,
                  network_failure=False):
        calls = []

        def handler(request):
            calls.append(request)
            if "login.microsoftonline.com" in str(request.url):
                return httpx.Response(
                    token_status,
                    json=token_body if token_body is not None else {"access_token": "test-graph-token"},
                )
            if network_failure:
                raise httpx.ReadTimeout("test timeout", request=request)
            return httpx.Response(
                graph_status, json=graph_body if graph_body is not None else {"id": "event-id"},
            )

        client = httpx.Client(transport=httpx.MockTransport(handler))
        with enabled_config(), patch("app.calendar.httpx.Client", return_value=client):
            result = calendar.create_group_event("test-api-token", GROUP_ID, {"transactionId": REQUEST_ID})
        return result, calls

    def test_obo_exchanges_api_token_and_only_posts_to_configured_group(self):
        event_id, calls = self.run_graph()
        self.assertEqual(event_id, "event-id")
        self.assertEqual(len(calls), 2)
        token_request = parse_qs(calls[0].content.decode())
        self.assertEqual(token_request["assertion"], ["test-api-token"])
        self.assertEqual(token_request["requested_token_use"], ["on_behalf_of"])
        self.assertEqual(token_request["scope"], ["https://graph.microsoft.com/.default"])
        self.assertEqual(str(calls[1].url), f"https://graph.microsoft.com/v1.0/groups/{GROUP_ID}/events")
        self.assertEqual(calls[1].headers["Authorization"], "Bearer test-graph-token")
        self.assertEqual(json.loads(calls[1].content)["transactionId"], REQUEST_ID)

    def test_graph_and_obo_errors_are_explicit_and_sanitized(self):
        for arguments in (
            {"graph_status": 401}, {"graph_status": 403}, {"graph_status": 404},
            {"graph_status": 429}, {"graph_status": 500}, {"graph_status": 302},
            {"graph_body": {}}, {"graph_body": []},
            {"token_status": 400, "token_body": {"error_description": "private data"}},
            {"token_body": {}}, {"network_failure": True},
        ):
            with self.subTest(arguments=arguments), self.assertRaises(calendar.CalendarError) as ctx:
                self.run_graph(**arguments)
            self.assertNotIn("private data", str(ctx.exception))
            self.assertNotIn("test-only-secret", str(ctx.exception))
            self.assertNotIn("test-api-token", str(ctx.exception))

    def test_non_json_response_is_explicit(self):
        with self.assertRaises(calendar.CalendarError):
            calendar._json_object(httpx.Response(200, content=b"not json"))


class CalendarSyncTests(unittest.TestCase):
    def setUp(self):
        self.engine = MagicMock()
        self.cn = self.engine.begin.return_value.__enter__.return_value
        self.row = saved_row()
        self.cn.execute.return_value.mappings.return_value.first.return_value = self.row

    def test_success_is_persisted_with_row_lock(self):
        with enabled_config(), patch("app.calendar.engine", self.engine), patch(
            "app.calendar.create_group_event", return_value="event-id"
        ) as create:
            result = calendar.sync_calendar(COMM_ID, "test-api-token", actor())
        self.assertEqual(result["status"], "created")
        self.assertIsNone(result["error"])
        self.assertIn("FOR UPDATE", str(self.cn.execute.call_args_list[0].args[0]))
        create.assert_called_once_with("test-api-token", GROUP_ID, self.row["graph_payload"])
        self.assertEqual(self.cn.execute.call_args.args[1]["event_id"], "event-id")

    def test_failure_persists_and_retry_uses_same_snapshot(self):
        with enabled_config(), patch("app.calendar.engine", self.engine), patch(
            "app.calendar.create_group_event", side_effect=calendar.CalendarError("Registration failed")
        ):
            with self.assertLogs("app.calendar", level="WARNING"):
                result = calendar.sync_calendar(COMM_ID, "test-api-token", actor())
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"], "Registration failed")
        self.assertEqual(self.cn.execute.call_args.args[1]["status"], "failed")
        self.row["status"] = "failed"
        with enabled_config(), patch("app.calendar.engine", self.engine), patch(
            "app.calendar.create_group_event", return_value="event-id"
        ) as create:
            result = calendar.sync_calendar(COMM_ID, "test-api-token", actor())
        self.assertEqual(result["status"], "created")
        self.assertEqual(create.call_args.args[2], self.row["graph_payload"])

    def test_already_created_never_calls_graph(self):
        self.row["status"] = "created"
        with patch("app.calendar.engine", self.engine), patch("app.calendar.create_group_event") as create:
            self.assertEqual(calendar.sync_calendar(COMM_ID, "token", actor())["status"], "created")
        create.assert_not_called()
        self.assertEqual(self.cn.execute.call_count, 1)

    def test_different_user_is_rejected_before_graph(self):
        self.row["requested_by"] = UUID(GROUP_ID)
        with patch("app.calendar.engine", self.engine), patch("app.calendar.create_group_event") as create:
            with self.assertRaises(calendar.HTTPException) as ctx:
                calendar.sync_calendar(COMM_ID, "token", actor())
        self.assertEqual(ctx.exception.status_code, 403)
        create.assert_not_called()

    def test_changed_destination_is_not_silently_used(self):
        self.row["group_id"] = UUID(REQUEST_ID)
        with enabled_config(), patch("app.calendar.engine", self.engine), patch(
            "app.calendar.create_group_event"
        ) as create, self.assertLogs("app.calendar", level="WARNING"):
            self.assertEqual(calendar.sync_calendar(COMM_ID, "token", actor())["status"], "failed")
        create.assert_not_called()


class CommunicationApiTests(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(
            contracts.router,
            dependencies=[Depends(require_screen("screen.contracts")), Depends(enforce_action)],
        )
        self.user = actor()
        self.app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(self.app)
        self.engine = MagicMock()
        self.cn = self.engine.begin.return_value.__enter__.return_value
        self.existing = None
        self.inserts = 0

        def execute(statement, params=None):
            result = MagicMock()
            sql = str(statement)
            if "INSERT INTO communications " in sql:
                self.inserts += 1
                result.scalar_one.return_value = UUID(COMM_ID)
            elif "SELECT contract_no" in sql:
                result.scalar_one.return_value = "C-001"
            elif "SELECT * FROM communication_calendar_events" in sql:
                result.mappings.return_value.first.return_value = self.existing
            return result

        self.cn.execute.side_effect = execute
        self.body = {"occurred_at": None, "channel": None, "direction": "in", "summary": "Summary"}

    def post(self, body):
        return self.client.post(
            f"/api/contracts/{CONTRACT_ID}/communications", json=body,
            headers={"Authorization": "Bearer test-api-token"},
        )

    def test_unchecked_keeps_existing_path_without_calendar_calls(self):
        with patch("app.routers.contracts.engine", self.engine), patch(
            "app.routers.contracts._require_contract"
        ), patch("app.routers.contracts.require_calendar_token") as token, patch(
            "app.routers.contracts.sync_calendar"
        ) as sync:
            response = self.post(self.body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"id": COMM_ID, "calendar": None})
        self.assertEqual(self.inserts, 1)
        token.assert_not_called()
        sync.assert_not_called()

    def test_checked_disabled_or_invalid_dates_save_nothing(self):
        with patch("app.routers.contracts.engine", self.engine), enabled_config():
            with patch.object(settings, "calendar_enabled", False):
                self.assertEqual(self.post({**self.body, "calendar": schedule_data()}).status_code, 503)
            bad = {**schedule_data(), "ends_at": schedule_data()["starts_at"]}
            self.assertEqual(self.post({**self.body, "calendar": bad}).status_code, 422)
        self.engine.begin.assert_not_called()

    def test_checked_request_replay_never_duplicates_history(self):
        def persist(cn, comm_id, schedule, request_hash, payload, user):
            self.existing = {
                **saved_row(), "request_hash": request_hash, "communication_id": comm_id,
            }

        failed = {
            "status": "failed", "calendar_name": "Group calendar",
            "starts_at": schedule_data()["starts_at"], "ends_at": schedule_data()["ends_at"],
            "error": "Retry required",
        }
        body = {**self.body, "calendar": schedule_data()}
        with enabled_config(), patch("app.routers.contracts.engine", self.engine), patch(
            "app.routers.contracts._require_contract"
        ), patch("app.routers.contracts.save_calendar_request", side_effect=persist) as save, patch(
            "app.routers.contracts.sync_calendar", return_value=failed
        ) as sync:
            first = self.post(body)
            self.assertEqual(first.status_code, 200, first.text)
            self.assertEqual(first.json()["calendar"]["status"], "failed")
            second = self.post(body)
            self.assertEqual(second.json(), first.json())
            self.assertEqual(self.inserts, 1)
            save.assert_called_once()
            self.assertEqual(sync.call_count, 2)
            conflict = self.post({**body, "summary": "Changed"})
            self.assertEqual(conflict.status_code, 409)
            self.assertEqual(self.inserts, 1)
            self.user.id = GROUP_ID
            self.assertEqual(self.post(body).status_code, 409)
            self.assertEqual(self.inserts, 1)

    def test_missing_bearer_does_not_save_schedule(self):
        with enabled_config(), patch("app.routers.contracts.engine", self.engine):
            response = self.client.post(
                f"/api/contracts/{CONTRACT_ID}/communications",
                json={**self.body, "calendar": schedule_data()},
            )
        self.assertEqual(response.status_code, 401)
        self.engine.begin.assert_not_called()

    def test_retry_route_and_create_require_link_permission(self):
        self.user.permissions = ["screen.contracts"]
        with patch("app.routers.contracts.engine", self.engine):
            self.assertEqual(self.post(self.body).status_code, 403)
            response = self.client.post(f"/api/communications/{COMM_ID}/calendar/retry")
            self.assertEqual(response.status_code, 403)
        self.engine.begin.assert_not_called()

    def test_retry_route_only_synchronizes_saved_schedule(self):
        expected = calendar.registration_result(saved_row("created"))
        with enabled_config(), patch("app.routers.contracts.engine", self.engine), patch(
            "app.routers.contracts.sync_calendar", return_value=expected
        ) as sync:
            response = self.client.post(
                f"/api/communications/{COMM_ID}/calendar/retry",
                headers={"Authorization": "Bearer test-api-token"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), expected)
        sync.assert_called_once_with(COMM_ID, "test-api-token", self.user)
        self.engine.begin.assert_not_called()


if __name__ == "__main__":
    unittest.main()
