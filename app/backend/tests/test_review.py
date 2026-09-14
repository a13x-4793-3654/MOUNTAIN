import os
import unittest
from contextlib import nullcontext
from datetime import timedelta
from unittest.mock import patch
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import create_engine, text

from app.routers import review


TEST_SCHEMA = """
CREATE TEMP TABLE contracts (
    id uuid PRIMARY KEY, contract_no text, contract_summary text,
    contract_category text DEFAULT 'service', contract_status text DEFAULT 'active',
    review_status text, review_reason text, assignee_user_id uuid, created_at timestamptz
);
CREATE TEMP TABLE companies (id uuid PRIMARY KEY, company_name text);
CREATE TEMP TABLE persons (id uuid PRIMARY KEY, full_name text);
CREATE TEMP TABLE contract_company_links (
    id bigserial PRIMARY KEY, contract_id uuid, company_id uuid
);
CREATE TEMP TABLE contract_person_links (
    id bigserial PRIMARY KEY, contract_id uuid, person_id uuid,
    link_category text NOT NULL DEFAULT 'contractor'
);
CREATE TEMP TABLE contract_identifiers (
    id bigserial PRIMARY KEY, contract_id uuid, identifier_value text
);
CREATE TEMP TABLE code_masters (category text, code text, label text);
CREATE TEMP TABLE users (id uuid, display_name text);
CREATE TEMP TABLE contract_reviews (
    id bigint, contract_id uuid, action text, comment text,
    created_at timestamptz, actor_user_id uuid
);
"""


class ReviewMatchingTests(unittest.TestCase):
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
        self.now = self.cn.execute(text("SELECT now()")).scalar_one()
        self.created_at = {}
        self.engine_patch = patch.object(review, "engine")
        bound_engine = self.engine_patch.start()
        self.addCleanup(self.engine_patch.stop)
        bound_engine.connect.side_effect = lambda: nullcontext(self.cn)

    def add_contract(
        self, number, *, companies=(), persons=(), identifiers=(), status="pending",
    ):
        contract_id = UUID(int=number)
        created_at = self.now + timedelta(seconds=number)
        self.created_at[contract_id] = created_at
        self.cn.execute(
            text("""
                INSERT INTO contracts
                    (id, contract_no, contract_summary, review_status, created_at)
                VALUES (:id, :no, :summary, :status, :created_at)
            """),
            {
                "id": contract_id, "no": f"TEST-{number:04d}",
                "summary": f"Contract {number}", "status": status, "created_at": created_at,
            },
        )
        for company in companies:
            self.cn.execute(
                text("""
                    INSERT INTO companies (id, company_name) VALUES (:id, :name)
                    ON CONFLICT (id) DO NOTHING
                """),
                {"id": UUID(int=company), "name": f"Company {company}"},
            )
            self.cn.execute(
                text("""
                    INSERT INTO contract_company_links (contract_id, company_id)
                    VALUES (:contract_id, :company_id)
                """),
                {"contract_id": contract_id, "company_id": UUID(int=company)},
            )
        for person in persons:
            self.cn.execute(
                text("""
                    INSERT INTO persons (id, full_name) VALUES (:id, :name)
                    ON CONFLICT (id) DO NOTHING
                """),
                {"id": UUID(int=person), "name": f"Person {person}"},
            )
            self.cn.execute(
                text("""
                    INSERT INTO contract_person_links (contract_id, person_id)
                    VALUES (:contract_id, :person_id)
                """),
                {"contract_id": contract_id, "person_id": UUID(int=person)},
            )
        for identifier in identifiers:
            self.cn.execute(
                text("""
                    INSERT INTO contract_identifiers (contract_id, identifier_value)
                    VALUES (:contract_id, :value)
                """),
                {"contract_id": contract_id, "value": identifier},
            )
        return contract_id

    def assert_matches(self, contract_id, expected):
        pending = review.get_reviews()
        self.assertEqual(pending["history"], [])
        base = next(row for row in pending["pending"] if row["id"] == contract_id)
        detail = review.get_review_detail(str(contract_id))
        self.assertEqual(base["similar_count"], len(expected))
        self.assertEqual(detail["similar_count"], len(expected))
        result = review.get_similar(str(contract_id))
        self.assertEqual(set(result), {"base", "items"})
        self.assertEqual(result["base"]["contract_no"], base["contract_no"])
        ordered = sorted(expected, key=self.created_at.get, reverse=True)[:20]
        self.assertEqual([item["id"] for item in result["items"]], [str(cid) for cid in ordered])
        for item, cid in zip(result["items"], ordered):
            company, person, identifier = expected[cid]
            self.assertEqual(
                (item["same_company"], item["same_person"], item["same_identifier"]),
                (company, person, identifier),
            )
            reasons = []
            if identifier:
                reasons.append("外部管理番号が一致")
            if company:
                reasons.append("会社が一致")
            if person:
                reasons.append("名義が一致")
            self.assertEqual(item["reasons"], reasons)
            self.assertEqual(item["created_at"], self.created_at[cid])
            self.assertNotEqual(cid, contract_id)

    def test_matching_truth_table_and_all_matching_reasons(self):
        base = self.add_contract(1, companies=(101,), persons=(201,), identifiers=("EXT-001",))
        expected = {}
        for mask in range(8):
            company = bool(mask & 1)
            person = bool(mask & 2)
            identifier = bool(mask & 4)
            candidate = self.add_contract(
                mask + 2,
                companies=(101 if company else 1000 + mask,),
                persons=(201 if person else 2000 + mask,),
                identifiers=("EXT-001" if identifier else f"OTHER-{mask}",),
            )
            if (company and person) or identifier:
                expected[candidate] = (company, person, identifier)
        self.assert_matches(base, expected)

    def test_two_matches_within_one_kind_are_not_two_distinct_items(self):
        base = self.add_contract(1, companies=(101, 102), persons=(201, 202))
        self.add_contract(2, companies=(101, 102))
        self.add_contract(3, persons=(201, 202))
        self.assert_matches(base, {})

    def test_company_and_person_must_match_the_same_candidate(self):
        base = self.add_contract(1, companies=(101,), persons=(201,))
        self.add_contract(2, companies=(101,), persons=(202,))
        self.add_contract(3, companies=(102,), persons=(201,))
        self.assert_matches(base, {})

    def test_all_party_links_are_checked_not_just_the_first(self):
        base = self.add_contract(1, companies=(101, 102), persons=(201, 202))
        candidate = self.add_contract(2, companies=(103, 102), persons=(203, 202))
        self.assert_matches(base, {candidate: (True, True, False)})

    def test_identifier_alone_matches_without_any_party_links(self):
        base = self.add_contract(1, identifiers=("EXT-001",))
        candidate = self.add_contract(2, identifiers=("EXT-001",))
        self.assert_matches(base, {candidate: (False, False, True)})

    def test_identifier_case_and_surrounding_spaces_match_consistently(self):
        base = self.add_contract(1, identifiers=("  ExT-001 ",))
        first = self.add_contract(2, identifiers=("ext-001",))
        second = self.add_contract(3, identifiers=(" EXT-001  ",))
        self.assert_matches(base, {
            first: (False, False, True), second: (False, False, True),
        })
        self.assert_matches(first, {
            base: (False, False, True), second: (False, False, True),
        })

    def test_empty_identifiers_are_not_matches(self):
        base = self.add_contract(1, identifiers=("", "   ", None))
        self.add_contract(2, identifiers=("", "   ", None))
        self.assert_matches(base, {})

    def test_repeated_links_and_identifiers_do_not_duplicate_candidates(self):
        base = self.add_contract(
            1, companies=(101, 101), persons=(201, 201), identifiers=("EXT-001", "EXT-001"),
        )
        candidate = self.add_contract(
            2, companies=(101, 101), persons=(201, 201), identifiers=("EXT-001", "EXT-001"),
        )
        self.assert_matches(base, {candidate: (True, True, True)})

    def test_self_is_excluded_even_when_all_items_match(self):
        base = self.add_contract(1, companies=(101,), persons=(201,), identifiers=("EXT-001",))
        self.assert_matches(base, {})

    def test_no_links_or_identifiers_have_no_candidates(self):
        base = self.add_contract(1)
        self.add_contract(2, companies=(101,), persons=(201,), identifiers=("EXT-001",))
        self.assert_matches(base, {})

    def test_approved_contracts_remain_candidates(self):
        base = self.add_contract(1, companies=(101,), persons=(201,))
        candidate = self.add_contract(2, companies=(101,), persons=(201,), status="approved")
        self.assert_matches(base, {candidate: (True, True, False)})

    def test_counts_include_all_candidates_before_the_twenty_item_limit(self):
        base = self.add_contract(1, companies=(101,), persons=(201,))
        expected = {}
        for number in range(2, 24):
            candidate = self.add_contract(number, companies=(101,), persons=(201,))
            expected[candidate] = (True, True, False)
        self.add_contract(24, persons=(201,))
        self.assert_matches(base, expected)

    def test_unknown_contract_still_returns_not_found(self):
        for endpoint in (review.get_review_detail, review.get_similar):
            with self.subTest(endpoint=endpoint.__name__):
                with self.assertRaises(HTTPException) as error:
                    endpoint(str(UUID(int=999)))
                self.assertEqual(error.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
