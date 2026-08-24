from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text

from ..db import engine

router = APIRouter(prefix="/api", tags=["household"])

KPI_SQL = text(
    """
    SELECT
      COALESCE(sum(amount) FILTER (WHERE entry_type='income'),0)  AS income_total,
      COALESCE(sum(amount) FILTER (WHERE entry_type='expense'),0) AS expense_total,
      count(*) AS entries_count
    FROM household_entries
    """
)

LIST_SQL = text(
    """
    SELECT h.id, h.contract_id, c.contract_no, h.used_on, h.used_place,
           h.amount, h.category_code, h.entry_type
    FROM household_entries h
    LEFT JOIN contracts c ON c.id = h.contract_id
    WHERE (CAST(:etype AS text) IS NULL OR h.entry_type = :etype)
      AND (CAST(:q AS text) IS NULL
           OR h.used_place ILIKE CAST(:qq AS text)
           OR h.category_code ILIKE CAST(:qq AS text))
    ORDER BY h.used_on DESC, h.id DESC
    LIMIT 300
    """
)


@router.get("/household")
def get_household(q: Optional[str] = None, entry_type: Optional[str] = Query(None)):
    params = {"q": q, "qq": f"%{q}%" if q else None, "etype": entry_type}
    with engine.connect() as cn:
        kpis = cn.execute(KPI_SQL).mappings().first()
        entries = cn.execute(LIST_SQL, params).mappings().all()
    k = dict(kpis)
    try:
        k["balance"] = float(k["income_total"]) - float(k["expense_total"])
    except Exception:
        k["balance"] = 0
    return {"kpis": k, "entries": [dict(r) for r in entries]}


class HouseholdIn(BaseModel):
    used_on: str
    amount: float
    category_code: str
    entry_type: Optional[str] = "expense"
    used_place: Optional[str] = None
    contract_id: Optional[str] = None


INSERT_HH_SQL = text(
    """
    INSERT INTO household_entries
        (contract_id, used_on, used_place, amount, category_code, entry_type)
    VALUES
        (CAST(:contract_id AS uuid), CAST(:used_on AS date), :used_place,
         CAST(:amount AS numeric), :category_code, :entry_type)
    RETURNING id
    """
)


def _hh_params(body: HouseholdIn) -> dict:
    if not body.used_on:
        raise HTTPException(422, "利用日を入力してください")
    if body.amount is None:
        raise HTTPException(422, "金額を入力してください")
    category = (body.category_code or "").strip()
    if not category:
        raise HTTPException(422, "費目（カテゴリ）を入力してください")
    entry_type = body.entry_type if body.entry_type in ("income", "expense") else "expense"
    return {
        "contract_id": (body.contract_id or "").strip() or None,
        "used_on": body.used_on,
        "used_place": (body.used_place or "").strip() or None,
        "amount": body.amount,
        "category_code": category,
        "entry_type": entry_type,
    }


@router.post("/household")
def post_household(body: HouseholdIn):
    params = _hh_params(body)
    with engine.begin() as cn:
        new_id = cn.execute(INSERT_HH_SQL, params).scalar_one()
    return {"id": str(new_id)}


UPDATE_HH_SQL = text(
    """
    UPDATE household_entries SET
        contract_id = CAST(:contract_id AS uuid),
        used_on = CAST(:used_on AS date),
        used_place = :used_place,
        amount = CAST(:amount AS numeric),
        category_code = :category_code,
        entry_type = :entry_type,
        updated_at = NOW()
    WHERE id = CAST(:id AS uuid)
    """
)


@router.put("/household/{entry_id}")
def put_household(entry_id: str, body: HouseholdIn):
    params = _hh_params(body)
    params["id"] = entry_id
    with engine.begin() as cn:
        res = cn.execute(UPDATE_HH_SQL, params)
        if res.rowcount == 0:
            raise HTTPException(404, "対象の項目が見つかりません")
    return {"ok": True}


@router.delete("/household/{entry_id}")
def delete_household(entry_id: str):
    with engine.begin() as cn:
        res = cn.execute(
            text("DELETE FROM household_entries WHERE id = CAST(:id AS uuid)"),
            {"id": entry_id},
        )
        if res.rowcount == 0:
            raise HTTPException(404, "対象の項目が見つかりません")
    return {"ok": True}
