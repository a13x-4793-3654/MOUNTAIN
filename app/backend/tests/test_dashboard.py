import os
import unittest
from contextlib import nullcontext
from datetime import timedelta
from unittest.mock import patch
from uuid import UUID

from sqlalchemy import create_engine, text

from app.routers import billing, contracts, dashboard


TEST_SCHEMA = """
CREATE TEMP TABLE contracts (
    id uuid PRIMARY KEY, contract_no text, contract_summary text,
    contract_status text DEFAULT 'active', review_status text DEFAULT 'approved',
    created_at timestamptz DEFAULT now()
);
CREATE TEMP TABLE claims (
    id uuid PRIMARY KEY, contract_id uuid, claim_category text DEFAULT 'lump',
    occurred_on date, claim_total_amount numeric(18,2), due_at timestamptz,
    status text, payment_method_json jsonb, remaining_balance numeric DEFAULT 0,
    created_at timestamptz
);
CREATE TEMP TABLE payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid,
    amount numeric(18,2), received_at timestamptz DEFAULT now(),
    received_method text, received_place text, source_type text,
    receipt_type text, has_receipt boolean,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE TEMP TABLE lawsuits (status text);
CREATE TEMP TABLE call_histories (
    id uuid, linked_contract_id uuid, from_number text, started_at timestamptz,
    direction text, duration_seconds integer, call_result text
);
CREATE TEMP TABLE communications (
    contract_id uuid, occurred_at timestamptz, channel text,
    direction text, summary text
);
CREATE TEMP TABLE companies (id uuid, company_name text);
CREATE TEMP TABLE contract_company_links (id integer, contract_id uuid, company_id uuid);
"""


class DashboardOverdueTests(unittest.TestCase):
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
        # Only temporary tables are visible; never read or modify application data.
        self.cn.execute(text("SET LOCAL search_path TO pg_temp"))
        for statement in TEST_SCHEMA.split(";"):
            if statement.strip():
                self.cn.execute(text(statement))
        self.now = self.cn.execute(text("SELECT now()")).scalar_one()
        self.contract_numbers = {}
        self.claims = {}

    def add_contract(self, number):
        contract_id = UUID(int=number)
        contract_no = f"TEST-{number:04d}"
        self.cn.execute(
            text("INSERT INTO contracts (id, contract_no) VALUES (:id, :no)"),
            {"id": contract_id, "no": contract_no},
        )
        self.contract_numbers[contract_id] = contract_no
        return contract_id

    def add_claim(
        self, number, contract_id, amount, *, status="open", due_days=-1,
        occurred_on="2026-07-12", created_at="2026-07-12T00:00:00+00:00",
    ):
        claim_id = UUID(int=number)
        due_at = self.now + timedelta(days=due_days) if due_days is not None else None
        self.cn.execute(
            text("""
                INSERT INTO claims
                    (id, contract_id, claim_total_amount, status, due_at,
                     occurred_on, created_at, payment_method_json)
                VALUES (:id, :contract_id, :amount, :status, :due_at,
                        :occurred_on, :created_at, '{"methods":["bank"]}')
            """),
            {
                "id": claim_id, "contract_id": contract_id, "amount": amount,
                "status": status, "due_at": due_at, "occurred_on": occurred_on,
                "created_at": created_at,
            },
        )
        self.claims[claim_id] = {"contract_id": contract_id, "due_at": due_at}
        return claim_id

    def add_payment(self, contract_id, amount):
        return self.cn.execute(
            text("""
                INSERT INTO payments (contract_id, amount)
                VALUES (:contract_id, :amount) RETURNING id
            """),
            {"contract_id": contract_id, "amount": amount},
        ).scalar_one()

    def assert_claim_balances(self, contract_id, expected):
        detail_rows = self.cn.execute(
            contracts.CLAIMS_SQL, {"id": str(contract_id)}
        ).mappings().all()
        billing_rows = self.cn.execute(
            billing.CLAIMS_SQL, {"q": None, "qq": None, "status": None}
        ).mappings().all()
        for rows in (
            detail_rows,
            [r for r in billing_rows if r["contract_id"] == contract_id],
        ):
            actual = {
                r["id"]: (r["status"], r["paid_amount"], r["remaining_balance"])
                for r in rows
            }
            self.assertEqual(actual, expected)
            self.assertTrue(all(r["methods_csv"] == "bank" for r in rows))

    def assert_overdue(self, expected):
        with patch.object(dashboard, "engine") as engine:
            engine.connect.return_value = nullcontext(self.cn)
            result = dashboard.get_dashboard()
        self.assertEqual(set(result), {"kpis", "tasks", "recent"})
        kpis = result["kpis"]
        billing_kpis = self.cn.execute(billing.KPI_SQL).mappings().one()
        for actual in (kpis, billing_kpis):
            self.assertEqual(actual["overdue_count"], len(expected))
            self.assertEqual(actual["overdue_amount"], sum(expected.values()))
        self.assertEqual(kpis["contracts_total"], len(self.contract_numbers))
        self.assertEqual(kpis["contracts_active"], len(self.contract_numbers))
        for key in (
            "contracts_delinquent", "contracts_litigation", "reviews_pending",
            "lawsuits_active", "calls_missed",
        ):
            self.assertEqual(kpis[key], 0)

        expected_tasks = []
        ordered = sorted(expected, key=lambda claim_id: self.claims[claim_id]["due_at"])
        for claim_id in ordered[:5]:
            claim = self.claims[claim_id]
            contract_id = claim["contract_id"]
            expected_tasks.append({
                "kind": "claim",
                "severity": "danger",
                "title": "期日超過の請求",
                "detail": f"{self.contract_numbers[contract_id]}　¥{expected[claim_id]:,}",
                "due_at": claim["due_at"],
                "to": f"/contracts/{contract_id}",
            })
        self.assertEqual(result["tasks"], expected_tasks)
        return result

    def test_empty_database(self):
        result = self.assert_overdue({})
        self.assertEqual(result["recent"], [])

    def test_settled_and_overpaid_claims_ignore_stored_open_status(self):
        for number, status, payment in ((1, "open", 12500), (2, "delinquent", 17500)):
            with self.subTest(status=status, payment=payment):
                contract_id = self.add_contract(number)
                claim_id = self.add_claim(number, contract_id, 12500, status=status)
                self.add_payment(contract_id, payment)
                self.assert_claim_balances(contract_id, {claim_id: ("paid", 12500, 0)})
                self.assert_overdue({})
        result = self.assert_overdue({})
        self.assertEqual(len(result["recent"]), 2)
        self.assertTrue(all(item["kind"] == "payment" for item in result["recent"]))

    def test_unpaid_and_partial_claims_count_only_the_remaining_amount(self):
        expected = {}
        for number, status, payment in (
            (1, "open", 0), (2, "delinquent", 2500), (3, "partial", 5000),
            (4, "paid", 10000),
        ):
            contract_id = self.add_contract(number)
            claim_id = self.add_claim(number, contract_id, 12500, status=status, due_days=-number)
            if payment:
                self.add_payment(contract_id, payment)
            expected[claim_id] = 12500 - payment
            self.assert_claim_balances(contract_id, {
                claim_id: ("partial" if payment else "delinquent", payment, 12500 - payment),
            })
        self.assert_overdue(expected)

    def test_canceled_claims_neither_count_nor_consume_payments(self):
        contract_id = self.add_contract(1)
        canceled = self.add_claim(1, contract_id, 50000, status="canceled")
        paid = self.add_claim(2, contract_id, 12500)
        unpaid = self.add_claim(3, contract_id, 5000)
        self.add_payment(contract_id, 12500)
        self.assert_claim_balances(contract_id, {
            canceled: ("canceled", 0, 50000),
            paid: ("paid", 12500, 0),
            unpaid: ("delinquent", 0, 5000),
        })
        self.assert_overdue({unpaid: 5000})

    def test_all_claims_participate_in_fifo_before_filtering_by_due_date(self):
        contract_id = self.add_contract(1)
        future = self.add_claim(1, contract_id, 5000, due_days=10, occurred_on="2026-07-01")
        no_due = self.add_claim(2, contract_id, 3000, due_days=None, occurred_on="2026-07-02")
        overdue = self.add_claim(3, contract_id, 10000, occurred_on="2026-07-03")
        self.add_payment(contract_id, 10000)
        self.assert_claim_balances(contract_id, {
            future: ("paid", 5000, 0),
            no_due: ("paid", 3000, 0),
            overdue: ("partial", 2000, 8000),
        })
        self.assert_overdue({overdue: 8000})

    def test_fifo_ties_use_created_at_then_id_not_insertion_order(self):
        contract_id = self.add_contract(1)
        last = self.add_claim(3, contract_id, 10000, created_at="2026-07-12T01:00:00+00:00")
        middle = self.add_claim(2, contract_id, 7500, created_at="2026-07-12T01:00:00+00:00")
        first = self.add_claim(4, contract_id, 5000)
        self.add_payment(contract_id, 17500)
        self.assert_claim_balances(contract_id, {
            first: ("paid", 5000, 0),
            middle: ("paid", 7500, 0),
            last: ("partial", 5000, 5000),
        })
        self.assert_overdue({last: 5000})

    def test_overpayment_is_not_applied_to_another_contract(self):
        first = self.add_contract(1)
        second = self.add_contract(2)
        self.add_claim(1, first, 12500)
        unpaid = self.add_claim(2, second, 12500)
        self.add_payment(first, 17500)
        self.assert_claim_balances(second, {unpaid: ("delinquent", 0, 12500)})
        self.assert_overdue({unpaid: 12500})

    def test_refunds_restore_overdue_balance_without_negative_allocations(self):
        contract_id = self.add_contract(1)
        claim_id = self.add_claim(1, contract_id, 12500)
        self.add_payment(contract_id, 12500)
        self.add_payment(contract_id, -2500)
        self.assert_claim_balances(contract_id, {claim_id: ("partial", 10000, 2500)})
        self.assert_overdue({claim_id: 2500})
        self.add_payment(contract_id, -15000)
        self.assert_claim_balances(contract_id, {claim_id: ("delinquent", 0, 12500)})
        self.assert_overdue({claim_id: 12500})

    def test_zero_amount_future_missing_and_exact_due_dates_are_excluded(self):
        contract_id = self.add_contract(1)
        self.add_claim(1, contract_id, 0)
        self.add_claim(2, contract_id, 1000, due_days=1)
        self.add_claim(3, contract_id, 2000, due_days=None)
        self.add_claim(4, contract_id, 3000, due_days=0)
        self.assert_overdue({})

    def test_task_limit_does_not_limit_kpi_totals(self):
        contract_id = self.add_contract(1)
        expected = {}
        for number in range(8, 0, -1):
            claim_id = self.add_claim(number, contract_id, number * 1000, due_days=-number)
            expected[claim_id] = number * 1000
        self.assert_overdue(expected)

    def test_payment_creation_editing_and_deletion_recalculate_overdue(self):
        contract_id = self.add_contract(1)
        claim_id = self.add_claim(1, contract_id, 12500)
        self.assert_overdue({claim_id: 12500})
        with patch.object(billing, "engine") as engine:
            engine.begin.side_effect = lambda: nullcontext(self.cn)
            payment = billing.post_payment(billing.PaymentIn(
                contract_id=str(contract_id), received_at=self.now.isoformat(), amount=17500,
            ))
            self.assert_overdue({})
            billing.update_payment(payment["id"], billing.PaymentUpdateIn(
                received_at=self.now.isoformat(), amount=10000,
            ))
            self.assert_overdue({claim_id: 2500})
            billing.delete_payment(payment["id"])
            self.assert_overdue({claim_id: 12500})


if __name__ == "__main__":
    unittest.main()
