import os
import subprocess
import unittest
from contextlib import contextmanager, nullcontext
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DataError, ProgrammingError

from app import company_categories, mock_reset
from app.routers import admin, companies, meta


class CompanyCategoryTests(unittest.TestCase):
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
        schema = (Path(__file__).resolve().parents[2] / "db" / "schema.sql").read_text(encoding="utf-8")
        for table in ("code_masters", "app_data_migrations", "companies", "company_phones", "company_categories"):
            prefix = "CREATE TABLE IF NOT EXISTS" if table == "app_data_migrations" else "CREATE TABLE"
            start = schema.index(f"{prefix} {table} (")
            end = schema.index("\n);", start) + len("\n);")
            self.cn.execute(text(schema[start:end].replace(prefix, "CREATE TEMP TABLE", 1)))
        self.cn.execute(text("""
            CREATE TEMP TABLE contracts (
                id uuid PRIMARY KEY, contract_no text, contract_summary text, contract_status text
            );
            CREATE TEMP TABLE contract_company_links (
                contract_id uuid, company_id uuid, link_category text
            )
        """))

        @contextmanager
        def begin():
            with self.cn.begin_nested():
                yield self.cn

        for module in (company_categories, companies, admin, meta):
            patched = patch.object(module, "engine")
            self.addCleanup(patched.stop)
            mocked = patched.start()
            mocked.begin.side_effect = begin
            mocked.connect.side_effect = lambda: nullcontext(self.cn)
        company_categories.ensure_company_category_master()

    def create(self, name="分類テスト会社", **kwargs):
        return companies.create_company(companies.CompanyIn(company_name=name, **kwargs))["id"]

    def update(self, company_id, name="編集済み会社", **kwargs):
        return companies.update_company(
            company_id, companies.CompanyIn(company_name=name, **kwargs)
        )

    def categories(self, company_id):
        return companies.get_company(company_id)["company"]["categories"]

    def codes(self, company_id):
        return [item["code"] for item in self.categories(company_id)]

    def master_id(self, code):
        return self.cn.execute(text("""
            SELECT id FROM code_masters WHERE category = 'company_category' AND code = :code
        """), {"code": code}).scalar_one()

    def master(self, code, label=None, **kwargs):
        return admin.create_master(admin.MasterIn(
            category="company_category", code=code, label=label or code, **kwargs
        ))["id"]

    def assert_http_error(self, status, action):
        with self.assertRaises(HTTPException) as caught:
            action()
        self.assertEqual(caught.exception.status_code, status)

    def test_default_masters_and_empty_company_are_independent_of_contract_roles(self):
        cid = self.create()
        self.assertEqual(self.codes(cid), [])
        self.assertEqual(meta.list_master("company_category"), [
            {"code": "lawyer", "label": "弁護士・法律事務所"},
            {"code": "servicer", "label": "債権回収業者（サービサー）"},
        ])
        self.assertEqual(meta.list_master("link_category"), [])

    def test_initialization_preserves_existing_masters_and_does_not_classify_companies(self):
        cid = self.create()
        self.cn.execute(text("DELETE FROM app_data_migrations"))
        self.cn.execute(text("DELETE FROM code_masters"))
        self.master("lawyer", "既存の弁護士分類", is_active=False, sort_order=99)
        self.master("custom", "独自分類")
        company_categories.ensure_company_category_master()
        company_categories.ensure_company_category_master()
        masters = self.cn.execute(admin.MASTERS_SQL).mappings().all()
        self.assertEqual(len(masters), 3)
        lawyer = next(row for row in masters if row["code"] == "lawyer")
        self.assertEqual(lawyer["label"], "既存の弁護士分類")
        self.assertEqual(lawyer["sort_order"], 99)
        self.assertFalse(lawyer["is_active"])
        self.assertEqual(self.codes(cid), [])
        self.assertEqual(self.cn.execute(text("SELECT count(*) FROM app_data_migrations")).scalar_one(), 1)

    def test_deleted_or_renamed_defaults_are_not_recreated_on_restart(self):
        admin.delete_master(self.master_id("servicer"))
        admin.update_master(self.master_id("lawyer"), admin.MasterIn(
            category="company_category", code="legal_office", label="法務事務所"
        ))
        company_categories.ensure_company_category_master()
        self.assertEqual(meta.list_master("company_category"), [
            {"code": "legal_office", "label": "法務事務所"},
        ])

    def test_failed_initialization_does_not_record_success(self):
        self.cn.execute(text("DELETE FROM app_data_migrations"))
        self.cn.execute(text("ALTER TABLE code_masters RENAME TO unavailable_masters"))
        with self.assertRaises(ProgrammingError):
            company_categories.ensure_company_category_master()
        self.assertEqual(self.cn.execute(text("SELECT count(*) FROM app_data_migrations")).scalar_one(), 0)
        self.cn.execute(text("ALTER TABLE unavailable_masters RENAME TO code_masters"))
        company_categories.ensure_company_category_master()
        self.assertEqual(self.cn.execute(text("SELECT count(*) FROM app_data_migrations")).scalar_one(), 1)
        self.assertEqual(len(meta.list_master("company_category")), 2)

    def test_create_multiple_and_duplicate_codes_with_phone(self):
        cid = self.create(category_codes=["servicer", "lawyer", "lawyer"], phone="03-1234-5678")
        result = companies.get_company(cid)
        self.assertEqual(self.codes(cid), ["lawyer", "servicer"])
        self.assertTrue(all(item["is_active"] for item in self.categories(cid)))
        self.assertEqual(result["phones"][0]["phone_number"], "03-1234-5678")
        self.assertEqual(result["contracts"], [])

    def test_omitted_codes_preserve_assignments_and_explicit_empty_clears(self):
        cid = self.create(category_codes=["lawyer", "servicer"])
        self.update(cid)
        self.assertEqual(self.codes(cid), ["lawyer", "servicer"])
        self.update(cid, category_codes=["servicer"])
        self.assertEqual(self.codes(cid), ["servicer"])
        self.update(cid, category_codes=[])
        self.assertEqual(self.codes(cid), [])
        self.assertEqual(self.codes(self.create(category_codes=[])), [])

    def test_unknown_or_other_master_category_cannot_be_assigned(self):
        admin.create_master(admin.MasterIn(category="link_category", code="creditor", label="債権者"))
        for code in ("unknown", "creditor", " lawyer"):
            with self.subTest(code=code):
                self.assert_http_error(422, lambda: self.create(category_codes=[code], phone="03-1234-5678"))
        self.assertEqual(self.cn.execute(text("SELECT count(*) FROM companies")).scalar_one(), 0)
        self.assertEqual(self.cn.execute(text("SELECT count(*) FROM company_categories")).scalar_one(), 0)
        self.assertEqual(self.cn.execute(text("SELECT count(*) FROM company_phones")).scalar_one(), 0)

    def test_invalid_update_rolls_back_basic_fields_and_assignments(self):
        cid = self.create(category_codes=["lawyer"], status_flag=1)
        self.assert_http_error(422, lambda: self.update(cid, category_codes=["servicer", "invalid"]))
        company = companies.get_company(cid)["company"]
        self.assertEqual(company["company_name"], "分類テスト会社")
        self.assertEqual(company["status_flag"], 1)
        self.assertEqual(self.codes(cid), ["lawyer"])

    def test_phone_insert_failure_rolls_back_company_and_categories(self):
        with self.assertRaises(DataError):
            self.create(category_codes=["lawyer"], phone="1" * 21)
        self.assertEqual(self.cn.execute(text("SELECT count(*) FROM companies")).scalar_one(), 0)
        self.assertEqual(self.cn.execute(text("SELECT count(*) FROM company_categories")).scalar_one(), 0)

    def test_custom_master_is_available_and_relabeling_changes_display(self):
        mid = self.master("custom", "追加した分類", sort_order=0)
        cid = self.create(category_codes=["lawyer", "custom"])
        self.assertEqual(self.codes(cid), ["custom", "lawyer"])
        admin.update_master(mid, admin.MasterIn(
            category="company_category", code="custom", label="変更後の表示名", sort_order=10
        ))
        self.assertEqual(self.codes(cid), ["lawyer", "custom"])
        self.assertEqual(self.categories(cid)[1]["label"], "変更後の表示名")
        self.assertEqual(meta.list_master("company_category")[-1]["label"], "変更後の表示名")

    def test_inactive_assignment_can_be_preserved_or_removed_but_not_added(self):
        cid = self.create(category_codes=["lawyer"])
        admin.update_master(self.master_id("lawyer"), admin.MasterIn(
            category="company_category", code="lawyer", label="旧分類", is_active=False
        ))
        self.assertEqual(self.categories(cid), [
            {"code": "lawyer", "label": "旧分類", "is_active": False},
        ])
        self.assertNotIn("lawyer", [row["code"] for row in meta.list_master("company_category")])
        self.update(cid, category_codes=["lawyer", "servicer"])
        self.assertEqual(self.codes(cid), ["lawyer", "servicer"])
        self.assert_http_error(422, lambda: self.create(category_codes=["lawyer"]))
        self.update(cid, category_codes=[])
        self.assert_http_error(422, lambda: self.update(cid, category_codes=["lawyer"]))
        self.assertEqual(self.codes(cid), [])

    def test_unregistered_legacy_codes_are_visible_and_preserved_exactly(self):
        cid = self.create()
        self.cn.execute(text("""
            INSERT INTO company_categories VALUES (CAST(:id AS uuid), 'legacy,category')
        """), {"id": cid})
        self.assertEqual(self.categories(cid), [
            {"code": "legacy,category", "label": "legacy,category", "is_active": False},
        ])
        self.update(cid)
        self.update(cid, category_codes=["legacy,category", "servicer"])
        self.assertEqual(self.codes(cid), ["servicer", "legacy,category"])
        self.assert_http_error(422, lambda: self.create(category_codes=["legacy,category"]))
        self.update(cid, category_codes=["servicer"])
        self.assertEqual(self.codes(cid), ["servicer"])

    def test_list_and_detail_share_labels_without_duplicate_rows_or_count(self):
        cids = [self.create(name=f"会社{n}", category_codes=["servicer", "lawyer"]) for n in range(3)]
        admin.create_master(admin.MasterIn(category="link_category", code="lawyer", label="契約上の立場"))
        first = companies.list_companies(limit=2, offset=0)
        last = companies.list_companies(limit=2, offset=2)
        self.assertEqual(first["total"], 3)
        self.assertEqual(last["total"], 3)
        self.assertEqual(len(first["items"]), 2)
        self.assertEqual(len(last["items"]), 1)
        all_rows = first["items"] + last["items"]
        self.assertEqual({str(row["id"]) for row in all_rows}, set(cids))
        for row in all_rows:
            self.assertEqual(row["categories"], self.categories(str(row["id"])))
            self.assertEqual(row["categories"][0]["label"], "弁護士・法律事務所")
        filtered = companies.list_companies(q="会社1", status=0, limit=20, offset=0)
        self.assertEqual(filtered["total"], 1)
        self.assertEqual(str(filtered["items"][0]["id"]), cids[1])

    def test_classification_edit_does_not_change_contract_link_role(self):
        cid = self.create()
        contract_id = UUID(int=101)
        self.cn.execute(text("INSERT INTO contracts VALUES (:id, 'TEST-101', '概要', 'active')"),
                        {"id": contract_id})
        self.cn.execute(text("INSERT INTO contract_company_links VALUES (:contract, CAST(:company AS uuid), 'creditor')"),
                        {"contract": contract_id, "company": cid})
        self.update(cid, category_codes=["lawyer", "servicer"])
        linked = companies.get_company(cid)["contracts"]
        self.assertEqual(linked[0]["link_category"], "creditor")
        self.assertEqual(companies.list_companies(limit=20, offset=0)["items"][0]["contract_count"], 1)
        self.assert_http_error(409, lambda: companies.delete_company(cid))
        self.assertEqual(self.codes(cid), ["lawyer", "servicer"])

    def test_used_master_cannot_be_deleted_or_rekeyed_but_can_be_disabled(self):
        cid = self.create(category_codes=["lawyer"])
        mid = self.master_id("lawyer")
        self.assert_http_error(409, lambda: admin.delete_master(mid))
        for category, code in (("company_category", "legal"), ("link_category", "lawyer")):
            self.assert_http_error(409, lambda: admin.update_master(mid, admin.MasterIn(
                category=category, code=code, label="変更"
            )))
        self.assertEqual(self.codes(cid), ["lawyer"])
        admin.update_master(mid, admin.MasterIn(
            category="company_category", code="lawyer", label="残す分類", is_active=False
        ))
        self.assertEqual(self.categories(cid)[0]["label"], "残す分類")
        self.assertFalse(self.categories(cid)[0]["is_active"])

    def test_master_can_be_deleted_after_last_assignment_is_removed(self):
        cid = self.create(category_codes=["lawyer"])
        self.update(cid, category_codes=[])
        admin.delete_master(self.master_id("lawyer"))
        company_categories.ensure_company_category_master()
        self.assertEqual([item["code"] for item in meta.list_master("company_category")], ["servicer"])

    def test_delete_company_cascades_categories_and_phones(self):
        cid = self.create(category_codes=["lawyer"], phone="03-1234-5678")
        companies.delete_company(cid)
        self.assertEqual(self.cn.execute(text("SELECT count(*) FROM company_categories")).scalar_one(), 0)
        self.assertEqual(self.cn.execute(text("SELECT count(*) FROM company_phones")).scalar_one(), 0)
        self.assertEqual(len(meta.list_master("company_category")), 2)

    def test_master_limits_and_duplicates_return_client_errors(self):
        for code, label in (("", "分類"), ("X" * 51, "分類"), ("ok", ""), ("ok", "X" * 201)):
            self.assert_http_error(422, lambda: self.master(code, label=" " if label == "" else label))
        self.assert_http_error(409, lambda: self.master("lawyer"))
        self.assertEqual(len(meta.list_master("company_category")), 2)

    def test_other_master_edit_and_delete_behavior_is_unchanged(self):
        mid = admin.create_master(admin.MasterIn(category="link_category", code="other", label="立場"))["id"]
        admin.update_master(mid, admin.MasterIn(category="link_category", code="changed", label="別の立場"))
        admin.delete_master(mid)
        self.assertEqual(meta.list_master("link_category"), [])

    def test_missing_company_and_master_return_404_without_mutation(self):
        missing = str(UUID(int=999))
        self.assert_http_error(404, lambda: self.update(missing, category_codes=["lawyer"]))
        self.assert_http_error(404, lambda: admin.delete_master(999))
        self.assert_http_error(404, lambda: admin.update_master(999, admin.MasterIn(
            category="company_category", code="new", label="分類"
        )))
        self.assertEqual(self.cn.execute(text("SELECT count(*) FROM company_categories")).scalar_one(), 0)

    def test_http_payload_validation_and_omit_clear_round_trip(self):
        app = FastAPI()
        app.include_router(companies.router)
        client = TestClient(app)
        self.addCleanup(client.close)
        response = client.post("/api/companies", json={
            "company_name": "HTTP会社", "category_codes": ["lawyer", "servicer"],
        })
        self.assertEqual(response.status_code, 200)
        cid = response.json()["id"]
        for value in (None, "lawyer", [None], [""], ["X" * 51], [123]):
            with self.subTest(value=value):
                response = client.put(f"/api/companies/{cid}", json={
                    "company_name": "不正な変更", "category_codes": value,
                })
                self.assertEqual(response.status_code, 422)
        response = client.put(f"/api/companies/{cid}", json={"company_name": "通常編集"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual([row["code"] for row in client.get(f"/api/companies/{cid}").json()["company"]["categories"]],
                         ["lawyer", "servicer"])
        response = client.put(f"/api/companies/{cid}", json={"company_name": "分類解除", "category_codes": []})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(client.get(f"/api/companies/{cid}").json()["company"]["categories"], [])


class CompanyCategoryResetTests(unittest.TestCase):
    def test_mock_restore_initializes_masters_in_the_same_transaction(self):
        scripts = []

        def restore(command, **kwargs):
            scripts.append(Path(command[-1]).read_text(encoding="utf-8"))
            self.assertIn("--single-transaction", command)
            self.assertIn("ON_ERROR_STOP=1", command)
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        with (
            patch.object(mock_reset.settings, "mock_reset_enabled", True),
            patch.object(mock_reset, "baseline_present", return_value=True),
            patch.object(mock_reset, "_baseline_path", return_value=Path("fixture.sql")),
            patch.object(mock_reset, "_all_public_tables", return_value=["code_masters", "app_data_migrations"]),
            patch.object(mock_reset, "_counts", return_value={}),
            patch.object(mock_reset, "_psql_conn_args", return_value=({}, [])),
            patch.object(mock_reset, "_LAST_RUN", None),
            patch.object(mock_reset, "engine"),
            patch.object(mock_reset.subprocess, "run", side_effect=restore),
        ):
            self.assertTrue(mock_reset.reset_mock_data()["ok"])
        self.assertEqual(len(scripts), 1)
        migration = Path(company_categories.__file__).with_name("company_category_master.sql").as_posix()
        self.assertIn('TRUNCATE public."code_masters", public."app_data_migrations" RESTART IDENTITY CASCADE;', scripts[0])
        self.assertIn(f"SET session_replication_role = DEFAULT;\n\\i {migration}\n", scripts[0])
        self.assertLess(scripts[0].index("\\i fixture.sql"), scripts[0].index(f"\\i {migration}"))


if __name__ == "__main__":
    unittest.main()
