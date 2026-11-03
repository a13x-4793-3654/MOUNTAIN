import unittest
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool

from app.routers import contracts


LONG_CATEGORY = "degitalinflastructure"
CONTRACT_ID = "00000000-0000-0000-0000-000000000002"
COMPANY_ID = "00000000-0000-0000-0000-000000000003"


class ContractCategoryTests(unittest.TestCase):
    def setUp(self):
        self.master_engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        self.addCleanup(self.master_engine.dispose)
        with self.master_engine.begin() as cn:
            cn.execute(
                text(
                    "CREATE TABLE code_masters "
                    "(category TEXT, code TEXT, is_active BOOLEAN)"
                )
            )
            cn.execute(
                text(
                    "INSERT INTO code_masters (category, code, is_active) "
                    "VALUES (:category, :code, :is_active)"
                ),
                [
                    {"category": "contract_category", "code": code, "is_active": True}
                    for code in ("loan", "lease", "sales", "service", LONG_CATEGORY, "x" * 50)
                ]
                + [
                    {
                        "category": "contract_category",
                        "code": "inactive_category",
                        "is_active": False,
                    },
                    {
                        "category": "contract_status",
                        "code": "other_master_category",
                        "is_active": True,
                    },
                ],
            )

        self.current_category = "loan"
        self.update_rowcount = 1
        self.connection = MagicMock()
        self.connection.execute.side_effect = self.execute
        self.engine = MagicMock()
        self.engine.begin.return_value.__enter__.return_value = self.connection
        patcher = patch.object(contracts, "engine", self.engine)
        patcher.start()
        self.addCleanup(patcher.stop)

        app = FastAPI()
        app.include_router(contracts.router)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def execute(self, statement, params=None):
        result = MagicMock()
        if statement is contracts.ACTIVE_CATEGORY_SQL:
            with self.master_engine.connect() as cn:
                result.scalar.return_value = cn.execute(statement, params).scalar()
        elif statement is contracts.CURRENT_CATEGORY_SQL:
            result.scalar.return_value = self.current_category
        elif statement is contracts.COMPANY_NAME_SQL:
            result.scalar.return_value = "Example Company"
        elif statement is contracts.NEXT_NO_SQL:
            result.scalar_one.return_value = 0
        elif statement is contracts.INSERT_CONTRACT_SQL:
            result.scalar_one.return_value = CONTRACT_ID
        elif statement is contracts.UPDATE_CONTRACT_SQL:
            result.rowcount = self.update_rowcount
        elif statement is not contracts.INSERT_C_COMPANY_SQL:
            self.fail(f"Unexpected SQL statement: {statement}")
        return result

    def request(self, method, category):
        self.connection.reset_mock()
        self.engine.begin.reset_mock()
        if method == "post":
            return self.client.post(
                "/api/contracts",
                json={"contract_category": category, "company_id": COMPANY_ID},
            )
        return self.client.put(
            f"/api/contracts/{CONTRACT_ID}",
            json={
                "contract_category": category,
                "contract_summary": "Example contract",
                "contract_status": "active",
            },
        )

    def write_params(self, method):
        statement = (
            contracts.INSERT_CONTRACT_SQL
            if method == "post"
            else contracts.UPDATE_CONTRACT_SQL
        )
        return [
            call.args[1]
            for call in self.connection.execute.call_args_list
            if call.args[0] is statement
        ]

    def test_accepts_builtin_and_custom_categories_through_50_characters(self):
        self.assertEqual(len(LONG_CATEGORY), 21)
        for method in ("post", "put"):
            for category in ("loan", "lease", "sales", "service", LONG_CATEGORY, "x" * 50):
                with self.subTest(method=method, category=category):
                    response = self.request(method, category)
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(self.write_params(method)[0]["contract_category"], category)

    def test_trims_category_before_lookup_and_storage(self):
        for method in ("post", "put"):
            with self.subTest(method=method):
                response = self.request(method, f" {LONG_CATEGORY} ")
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(self.write_params(method)[0]["contract_category"], LONG_CATEGORY)

    def test_rejects_51_characters_before_database_access(self):
        for method in ("post", "put"):
            with self.subTest(method=method):
                response = self.request(method, "x" * 51)
                self.assertEqual(response.status_code, 422)
                error = response.json()["detail"][0]
                self.assertEqual(error["type"], "string_too_long")
                self.assertEqual(error["loc"], ["body", "contract_category"])
                self.assertEqual(error["ctx"]["max_length"], 50)
                self.engine.begin.assert_not_called()

    def test_rejects_blank_categories_before_database_access(self):
        for method in ("post", "put"):
            for category in ("", "   "):
                with self.subTest(method=method, category=category):
                    response = self.request(method, category)
                    self.assertEqual(response.status_code, 422)
                    self.engine.begin.assert_not_called()

    def test_rejects_unregistered_inactive_and_other_master_categories(self):
        for method in ("post", "put"):
            for category in ("missing_category", "inactive_category", "other_master_category"):
                with self.subTest(method=method, category=category):
                    response = self.request(method, category)
                    self.assertEqual(response.status_code, 422)
                    self.assertEqual(self.write_params(method), [])

    def test_update_can_retain_an_inactive_or_deleted_category(self):
        for category in ("inactive_category", "deleted_category"):
            with self.subTest(category=category):
                self.current_category = category
                response = self.request("put", category)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(self.write_params("put")[0]["contract_category"], category)

    def test_update_of_missing_contract_remains_not_found(self):
        self.update_rowcount = 0
        response = self.request("put", LONG_CATEGORY)
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
