from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.engine import Connection

from .db import engine


# The company alias is shared by the list and detail queries.
CATEGORIES_SQL = """
    COALESCE((
        SELECT jsonb_agg(
            jsonb_build_object(
                'code', cc.category_code,
                'label', COALESCE(cm.label, cc.category_code),
                'is_active', COALESCE(cm.is_active, FALSE)
            ) ORDER BY cm.sort_order NULLS LAST, cc.category_code
        )
        FROM company_categories cc
        LEFT JOIN code_masters cm
          ON cm.category = 'company_category' AND cm.code = cc.category_code
        WHERE cc.company_id = co.id
    ), '[]'::jsonb) AS categories
"""


def ensure_company_category_master() -> None:
    with engine.begin() as cn:
        cn.execute(text(
            Path(__file__).with_name("company_category_master.sql").read_text(encoding="utf-8")
        ))


def sync_company_categories(cn: Connection, company_id: str, codes: list[str]) -> None:
    """The caller holds the company row lock and owns the transaction."""
    selected = set(codes)
    existing = set(cn.execute(text(
        "SELECT category_code FROM company_categories WHERE company_id = CAST(:id AS uuid)"
    ), {"id": company_id}).scalars())
    added = sorted(selected - existing)
    if added:
        # Prevent master deletion/deactivation between validation and assignment.
        masters = cn.execute(text("""
            SELECT code, is_active FROM code_masters
            WHERE category = 'company_category' AND code = ANY(CAST(:codes AS text[]))
            FOR SHARE
        """), {"codes": added}).mappings().all()
        active = {row["code"] for row in masters if row["is_active"]}
        if any(code not in active for code in added):
            raise HTTPException(
                422, "会社分類は有効なマスターから選択してください。選択肢を再読み込みしてください。"
            )

    cn.execute(text("""
        DELETE FROM company_categories
        WHERE company_id = CAST(:id AS uuid)
          AND NOT (category_code = ANY(CAST(:codes AS text[])))
    """), {"id": company_id, "codes": sorted(selected)})
    if added:
        cn.execute(text("""
            INSERT INTO company_categories (company_id, category_code)
            VALUES (CAST(:id AS uuid), :code)
        """), [{"id": company_id, "code": code} for code in added])
