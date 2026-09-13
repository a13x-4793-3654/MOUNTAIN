import os
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

from sqlalchemy import create_engine, text

from app.routers import accounts, companies, persons


TEST_SCHEMA = """
CREATE TEMP TABLE companies (
    id uuid PRIMARY KEY, company_name text, company_name_kana text,
    prefecture text, city text, status_flag int
);
CREATE TEMP TABLE company_phones (
    id bigint, company_id uuid, phone_number text, is_primary boolean
);
CREATE TEMP TABLE persons (
    id uuid PRIMARY KEY, full_name text, full_name_kana text,
    birth_date date, prefecture text, city text
);
CREATE TEMP TABLE accounts (
    id uuid PRIMARY KEY, account_category text, account_type text, account_role text,
    bank_name text, branch_name text, account_no_masked text, account_holder_kana text,
    expiry_mm_yy text, is_active boolean,
    account_no_encrypted bytea, cvv2_encrypted bytea
);
CREATE TEMP TABLE contract_company_links (company_id uuid);
CREATE TEMP TABLE contract_person_links (person_id uuid);
CREATE TEMP TABLE contract_account_links (account_id uuid);
"""


class RecordListSearchTests(unittest.TestCase):
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
        for statement in TEST_SCHEMA.split(";"):
            if statement.strip():
                self.cn.execute(text(statement))
        for module in (companies, persons, accounts):
            patched = patch.object(module, "engine")
            self.addCleanup(patched.stop)
            mocked = patched.start()
            mocked.connect.side_effect = lambda: nullcontext(self.cn)
            mocked.begin.side_effect = lambda: nullcontext(self.cn)
        # Reverse insertion order and identical names exercise the UUID pagination tie-breaker.
        for number in range(65, 0, -1):
            params = {"id": UUID(int=number), "city": f"市区町村{number}"}
            self.cn.execute(text("""
                INSERT INTO companies (id, company_name, company_name_kana, prefecture, city)
                VALUES (:id, '同名会社', 'ドウメイ', '東京都', :city)
            """), params)
            self.cn.execute(text("""
                INSERT INTO persons (id, full_name, full_name_kana, birth_date, prefecture, city)
                VALUES (:id, '同姓同名', 'ドウメイ', '1980-01-02', '大阪府', :city)
            """), params)
            self.cn.execute(text("""
                INSERT INTO accounts (
                    id, account_category, account_type, bank_name, branch_name,
                    account_holder_kana, account_no_masked, is_active,
                    account_no_encrypted, cvv2_encrypted
                )
                VALUES (:id, 'bank', 'ordinary', 'テスト銀行', '本店',
                        :city, '****1234', TRUE, '\\x0102', '\\x0304')
            """), params)

    def test_search_reaches_records_beyond_the_first_page(self):
        for endpoint in (companies.list_companies, persons.list_persons, accounts.list_accounts):
            with self.subTest(endpoint=endpoint.__name__):
                first = endpoint(limit=20, offset=0)
                self.assertEqual(first["total"], 65)
                self.assertEqual([row["id"] for row in first["items"]], [UUID(int=n) for n in range(1, 21)])
                later = endpoint(limit=20, offset=60)
                self.assertEqual(later["total"], 65)
                self.assertEqual([row["id"] for row in later["items"]], [UUID(int=n) for n in range(61, 66)])
                filtered = endpoint(q="市区町村61", limit=20, offset=0)
                self.assertEqual(filtered["total"], 1)
                self.assertEqual([row["id"] for row in filtered["items"]], [UUID(int=61)])
                self.assertEqual(endpoint(q="該当なし", limit=20, offset=0), {"total": 0, "items": []})

    def test_initial_schema_preserves_company_phone_notes_and_freeform_types(self):
        schema = (Path(__file__).resolve().parents[2] / "db" / "schema.sql").read_text(encoding="utf-8")
        start = schema.index("CREATE TABLE company_phones (")
        end = schema.index("\n);", start) + len("\n);")
        phone_table = schema[start:end].replace("CREATE TABLE", "CREATE TEMP TABLE", 1)
        self.cn.execute(text("DROP TABLE pg_temp.company_phones"))
        self.cn.execute(text(phone_table))
        company_id = str(UUID(int=1))
        companies.create_company_phone(company_id, companies.CompanyPhoneIn(
            phone_number="03-0000-0000", phone_type="T" * 60,
            is_primary=True, note="N" * 300,
        ))
        row = self.cn.execute(companies.PHONES_SQL, {"id": company_id}).mappings().one()
        self.assertEqual(row["phone_type"], "T" * 50)
        self.assertEqual(row["note"], "N" * 255)
        self.assertTrue(row["is_primary"])

    def test_account_list_contains_only_safe_display_fields(self):
        result = accounts.list_accounts(q="市区町村61", limit=20, offset=0)
        row = result["items"][0]
        self.assertEqual(row["account_no_masked"], "****1234")
        self.assertNotIn("account_no_encrypted", row)
        self.assertNotIn("cvv2_encrypted", row)
        self.assertNotIn("account_no", row)


if __name__ == "__main__":
    unittest.main()
