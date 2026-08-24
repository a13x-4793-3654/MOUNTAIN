from fastapi import APIRouter
from sqlalchemy import text

from ..db import engine

router = APIRouter(prefix="/api", tags=["meta"])


@router.get("/masters/{category}")
def list_master(category: str):
    sql = text(
        """
        SELECT code, label
        FROM code_masters
        WHERE category = :category AND is_active = TRUE
        ORDER BY sort_order, code
        """
    )
    with engine.connect() as cn:
        rows = cn.execute(sql, {"category": category}).mappings().all()
    return [dict(r) for r in rows]
