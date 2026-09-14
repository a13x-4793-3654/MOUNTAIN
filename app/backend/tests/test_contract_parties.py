import csv
import io
import os
import unittest
from contextlib import nullcontext
from unittest.mock import patch
from uuid import UUID

from sqlalchemy import create_engine, text

from app.docmerge.resolve import resolve_values
from app.routers import contracts, review


TEST_SCHEMA = """
CREATE TEMP TABLE contracts (
    id uuid PRIMARY KEY, contract_no text, contract_summary text,
    contract_category text DEFAULT 'service', contract_status text DEFAULT 'active',
    review_status text DEFAULT 'pending', review_reason text, assignee_user_id uuid,
    created_at timestamptz DEFAULT now(), signed_at date, started_at date, ended_at date
);
CREATE TEMP TABLE companies (id uuid PRIMARY KEY, company_name text);
CREATE TEMP TABLE persons (
    id uuid PRIMARY KEY, full_name text, full_name_kana text,
    postal_code text, prefecture text, city text, address1 text, address2 text
);
CREATE TEMP TABLE contract_company_links (
    id bigserial PRIMARY KEY, contract_id uuid, company_id uuid
);
CREATE TEMP TABLE contract_person_links (
    id bigint PRIMARY KEY, contract_id uuid, person_id uuid, link_category text NOT NULL
);
CREATE TEMP TABLE contract_identifiers (
    id bigserial PRIMARY KEY, contract_id uuid, identifier_value text,
    is_primary boolean DEFAULT FALSE
);
CREATE TEMP TABLE code_masters (category text, code text, label text);
CREATE TEMP TABLE users (id uuid, display_name text);
CREATE TEMP TABLE contract_reviews (
    id bigint, contract_id uuid, action text, comment text,
    created_at timestamptz, actor_user_id uuid
);
"""

PERSON_FIELDS = [{"token": "person", "entity": "PERSON", "source": "FullName"}]


class ContractorDisplayTests(unittest.TestCase):
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
        for statement in TEST_SCHEMA.split(";"):
            if statement.strip():
                self.cn.execute(text(statement))
        for module in (contracts, review):
            patched = patch.object(module, "engine")
            self.addCleanup(patched.stop)
            patched.start().connect.side_effect = lambda: nullcontext(self.cn)
        self.contract_numbers = {}
        self.next_link_id = 0

    def add_contract(self, number):
        contract_id = UUID(int=number)
        contract_no = f"PARTY-{number:04d}"
        self.contract_numbers[contract_id] = contract_no
        self.cn.execute(text("""
            INSERT INTO contracts (id, contract_no, contract_summary)
            VALUES (:id, :no, 'Display fixture')
        """), {"id": contract_id, "no": contract_no})
        return contract_id

    def add_person_link(self, contract_id, number, role, *, link_id=None):
        person_id = UUID(int=number)
        self.cn.execute(text("""
            INSERT INTO persons (id, full_name) VALUES (:id, :name)
            ON CONFLICT (id) DO NOTHING
        """), {"id": person_id, "name": f"Person {number}"})
        if link_id is None:
            link_id = self.next_link_id + 1
        self.next_link_id = max(self.next_link_id, link_id)
        self.cn.execute(text("""
            INSERT INTO contract_person_links (id, contract_id, person_id, link_category)
            VALUES (:id, :contract_id, :person_id, :role)
        """), {"id": link_id, "contract_id": contract_id, "person_id": person_id, "role": role})
        return person_id

    def add_company_link(self, contract_id, number):
        company_id = UUID(int=number)
        self.cn.execute(text("""
            INSERT INTO companies (id, company_name) VALUES (:id, :name)
            ON CONFLICT (id) DO NOTHING
        """), {"id": company_id, "name": f"Company {number}"})
        self.cn.execute(text("""
            INSERT INTO contract_company_links (contract_id, company_id)
            VALUES (:contract_id, :company_id)
        """), {"contract_id": contract_id, "company_id": company_id})

    def csv_rows(self, **params):
        response = contracts.export_contracts_csv(**params)
        return list(csv.DictReader(io.StringIO(response.body.decode("utf-8-sig"))))

    def assert_displays(self, contract_id, expected_person):
        expected_name = f"Person {expected_person}" if expected_person is not None else None
        query = self.contract_numbers[contract_id]
        listing = contracts.list_contracts(q=query, limit=50, offset=0)
        self.assertEqual(listing["total"], 1)
        self.assertEqual(len(listing["items"]), 1)
        self.assertEqual(listing["items"][0]["person_name"], expected_name)
        exported = self.csv_rows(q=query)
        self.assertEqual(len(exported), 1)
        self.assertEqual(exported[0]["契約者"], expected_name or "")
        pending = [row for row in review.get_reviews()["pending"] if row["id"] == contract_id]
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["person_name"], expected_name)
        self.assertEqual(review.get_review_detail(str(contract_id))["person_name"], expected_name)
        self.assertEqual(review.get_similar(str(contract_id))["base"]["person_name"], expected_name)
        resolved = resolve_values(self.cn, PERSON_FIELDS, {"contract_id": str(contract_id)})
        self.assertEqual(resolved["values"]["person"], expected_name or "")
        self.assertEqual(resolved["labels"]["person"], expected_name)
        self.assertEqual(
            resolved["selection"]["person_id"],
            str(UUID(int=expected_person)) if expected_person is not None else None,
        )

    def test_non_contractor_registered_first_is_not_displayed(self):
        contract_id = self.add_contract(1)
        self.add_person_link(contract_id, 201, "contractor2")
        self.add_person_link(contract_id, 202, "contractor")
        self.assert_displays(contract_id, 202)
        roles = list(self.cn.execute(text(
            "SELECT link_category FROM contract_person_links ORDER BY id"
        )).scalars())
        self.assertEqual(roles, ["contractor2", "contractor"])

    def test_missing_contractor_never_falls_back(self):
        empty = self.add_contract(1)
        others = self.add_contract(2)
        for number, role in enumerate(("contractor2", "guarantor", "debtor"), start=201):
            self.add_person_link(others, number, role)
        self.assert_displays(empty, None)
        self.assert_displays(others, None)
        self.assertEqual(contracts.list_contracts(limit=50, offset=0)["total"], 2)

    def test_multiple_contractors_use_link_order_within_each_contract(self):
        first = self.add_contract(1)
        second = self.add_contract(2)
        self.add_person_link(second, 203, "contractor", link_id=1)
        self.add_person_link(first, 201, "contractor2", link_id=2)
        self.add_person_link(first, 204, "contractor", link_id=10)
        self.add_person_link(first, 202, "contractor", link_id=5)
        self.assert_displays(first, 202)
        self.assert_displays(second, 203)
        page = contracts.list_contracts(limit=1, offset=1)
        self.assertEqual(page["total"], 2)
        self.assertEqual([row["id"] for row in page["items"]], [second])

    def test_search_csv_and_existing_filters_use_the_displayed_contractor(self):
        first = self.add_contract(1)
        second = self.add_contract(2)
        self.add_person_link(first, 201, "contractor2")
        self.add_person_link(first, 202, "contractor")
        self.add_person_link(second, 203, "contractor")
        self.add_company_link(first, 101)
        self.cn.execute(text(
            "UPDATE contracts SET contract_category='loan', contract_status='closed' WHERE id=:id"
        ), {"id": second})
        for query, expected in (("Person 202", [first]), ("Person 201", []), ("Company 101", [first])):
            with self.subTest(query=query):
                result = contracts.list_contracts(q=query, limit=1, offset=0)
                self.assertEqual(result["total"], len(expected))
                self.assertEqual([row["id"] for row in result["items"]], expected)
                exported = self.csv_rows(q=query)
                self.assertEqual([row["契約番号"] for row in exported],
                                 [self.contract_numbers[cid] for cid in expected])
        result = contracts.list_contracts(status="closed", category="loan", limit=50, offset=0)
        self.assertEqual(result["total"], 1)
        self.assertEqual([row["id"] for row in result["items"]], [second])
        self.assertEqual(self.csv_rows(status="closed", category="loan")[0]["契約者"], "Person 203")

    def test_similarity_still_checks_non_displayed_parties(self):
        first = self.add_contract(1)
        second = self.add_contract(2)
        for cid, contractor in ((first, 202), (second, 203)):
            self.add_company_link(cid, 101)
            self.add_person_link(cid, 201, "contractor2")
            self.add_person_link(cid, contractor, "contractor")
        self.assert_displays(first, 202)
        self.assert_displays(second, 203)
        for cid, other, name in ((first, second, "Person 203"), (second, first, "Person 202")):
            with self.subTest(contract_id=cid):
                self.assertEqual(review.get_review_detail(str(cid))["similar_count"], 1)
                result = review.get_similar(str(cid))
                self.assertEqual(len(result["items"]), 1)
                item = result["items"][0]
                self.assertEqual(item["id"], str(other))
                self.assertEqual(item["person_name"], name)
                self.assertEqual(
                    (item["same_company"], item["same_person"], item["same_identifier"]),
                    (True, True, False),
                )

    def test_role_changes_are_reflected_without_replacing_links(self):
        cid = self.add_contract(1)
        self.add_person_link(cid, 201, "contractor2")
        self.add_person_link(cid, 202, "contractor")
        self.assert_displays(cid, 202)
        self.cn.execute(text("UPDATE contract_person_links SET link_category='guarantor' WHERE id=2"))
        self.assert_displays(cid, None)
        self.cn.execute(text("UPDATE contract_person_links SET link_category='contractor' WHERE id=1"))
        self.assert_displays(cid, 201)

    def test_document_explicit_person_selection_is_preserved(self):
        cid = self.add_contract(1)
        other = self.add_person_link(cid, 201, "contractor2")
        self.add_person_link(cid, 202, "contractor")
        self.assert_displays(cid, 202)
        resolved = resolve_values(self.cn, PERSON_FIELDS, {
            "contract_id": str(cid), "person_id": str(other),
        })
        self.assertEqual(resolved["selection"]["person_id"], str(other))
        self.assertEqual(resolved["values"]["person"], "Person 201")

    def test_selection_uses_exact_role_code_not_an_editable_label(self):
        cid = self.add_contract(1)
        self.add_person_link(cid, 201, "contractor2")
        self.add_person_link(cid, 202, "contractor")
        self.cn.execute(text("""
            INSERT INTO code_masters (category, code, label) VALUES
                ('link_category', 'contractor2', '契約者'),
                ('link_category', 'contractor', 'Renamed label')
        """))
        self.assert_displays(cid, 202)


if __name__ == "__main__":
    unittest.main()
