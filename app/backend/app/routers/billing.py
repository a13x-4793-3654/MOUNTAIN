from typing import Optional, List
import json

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text

from ..db import engine

router = APIRouter(prefix="/api", tags=["billing"])

KPI_SQL = text(
    """
    WITH pay_agg AS (
      SELECT contract_id,
             COALESCE(SUM(amount),0) AS pay_net,
             COALESCE(SUM(amount) FILTER (
               WHERE date_trunc('month',received_at)=date_trunc('month',now())),0) AS month_paid,
             COALESCE(SUM(amount) FILTER (WHERE received_at::date=CURRENT_DATE),0) AS today_paid,
             COUNT(*) FILTER (WHERE received_at::date=CURRENT_DATE) AS today_cnt
      FROM payments GROUP BY contract_id
    ),
    claim_calc AS (
      SELECT cl.contract_id, cl.claim_total_amount, cl.due_at, cl.status,
        CASE WHEN cl.status='canceled' THEN 0
             ELSE GREATEST(0, LEAST(cl.claim_total_amount,
                  COALESCE(pa.pay_net,0)
                  - COALESCE(SUM(CASE WHEN cl.status<>'canceled' THEN cl.claim_total_amount ELSE 0 END)
                      OVER (PARTITION BY cl.contract_id
                            ORDER BY cl.occurred_on ASC, cl.created_at ASC, cl.id ASC
                            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)))
        END AS paid_amount
      FROM claims cl
      LEFT JOIN pay_agg pa ON pa.contract_id = cl.contract_id
    ),
    claim_rem AS (
      SELECT due_at, status, (claim_total_amount - paid_amount) AS remaining
      FROM claim_calc
    ),
    contract_bal AS (
      SELECT c.id AS contract_id,
             COALESCE(pa.pay_net,0) AS pay_net,
             COALESCE((SELECT SUM(claim_total_amount) FROM claims x
                       WHERE x.contract_id=c.id AND x.status<>'canceled'),0) AS claim_active
      FROM contracts c LEFT JOIN pay_agg pa ON pa.contract_id=c.id
    )
    SELECT
      (SELECT count(*) FROM claims) AS claims_count,
      (SELECT COALESCE(SUM(remaining),0) FROM claim_rem
         WHERE status<>'canceled' AND remaining > 0) AS unpaid_amount,
      (SELECT count(*) FROM claim_rem
         WHERE status<>'canceled' AND remaining > 0 AND due_at < now()) AS overdue_count,
      (SELECT COALESCE(SUM(remaining),0) FROM claim_rem
         WHERE status<>'canceled' AND remaining > 0 AND due_at < now()) AS overdue_amount,
      (SELECT count(*) FROM payments) AS payments_count,
      (SELECT COALESCE(SUM(month_paid),0) FROM pay_agg) AS month_paid,
      (SELECT COALESCE(SUM(today_paid),0) FROM pay_agg) AS today_paid,
      (SELECT COALESCE(SUM(today_cnt),0) FROM pay_agg) AS today_count,
      (SELECT COALESCE(SUM(GREATEST(pay_net - claim_active,0)),0) FROM contract_bal) AS advance_total,
      (SELECT count(*) FROM contract_bal WHERE pay_net - claim_active > 0) AS advance_contracts
    """
)

CLAIMS_SQL = text(
    """
    WITH pay_agg AS (
      SELECT contract_id, COALESCE(SUM(amount),0) AS pay_net
      FROM payments GROUP BY contract_id
    ),
    claim_calc AS (
      SELECT cl.id, cl.contract_id, cl.claim_category, cl.occurred_on,
             cl.claim_total_amount, cl.due_at, cl.status, cl.payment_method_json,
        CASE WHEN cl.status='canceled' THEN 0
             ELSE GREATEST(0, LEAST(cl.claim_total_amount,
                  COALESCE(pa.pay_net,0)
                  - COALESCE(SUM(CASE WHEN cl.status<>'canceled' THEN cl.claim_total_amount ELSE 0 END)
                      OVER (PARTITION BY cl.contract_id
                            ORDER BY cl.occurred_on ASC, cl.created_at ASC, cl.id ASC
                            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)))
        END AS paid_amount
      FROM claims cl
      LEFT JOIN pay_agg pa ON pa.contract_id = cl.contract_id
    )
    SELECT cc.id, cc.contract_id, c.contract_no, cc.claim_category,
           cc.occurred_on, cc.claim_total_amount, cc.paid_amount,
           (cc.claim_total_amount - cc.paid_amount) AS remaining_balance,
           cc.due_at,
           CASE
             WHEN cc.status='canceled' THEN 'canceled'
             WHEN cc.paid_amount >= cc.claim_total_amount THEN 'paid'
             WHEN cc.paid_amount > 0 THEN 'partial'
             WHEN cc.due_at < now() THEN 'delinquent'
             ELSE 'open'
           END AS status,
           CASE WHEN jsonb_typeof(cc.payment_method_json->'methods')='array'
                THEN (SELECT string_agg(t.v, ',' ORDER BY t.ord)
                      FROM jsonb_array_elements_text(cc.payment_method_json->'methods')
                           WITH ORDINALITY AS t(v, ord))
                ELSE NULL END AS methods_csv,
           co.company_name
    FROM claim_calc cc
    JOIN contracts c ON c.id = cc.contract_id
    LEFT JOIN LATERAL (
        SELECT co2.company_name FROM contract_company_links l
        JOIN companies co2 ON co2.id=l.company_id
        WHERE l.contract_id=c.id ORDER BY l.id LIMIT 1
    ) co ON TRUE
    WHERE (CAST(:status AS text) IS NULL OR cc.status = :status)
      AND (CAST(:q AS text) IS NULL
           OR c.contract_no ILIKE CAST(:qq AS text)
           OR co.company_name ILIKE CAST(:qq AS text))
    ORDER BY cc.due_at DESC NULLS LAST, cc.id
    LIMIT 200
    """
)

PAYMENTS_SQL = text(
    """
    WITH claim_agg AS (
      SELECT contract_id,
             COALESCE(SUM(claim_total_amount) FILTER (WHERE status<>'canceled'),0) AS claim_active
      FROM claims GROUP BY contract_id
    ),
    pay_calc AS (
      SELECT p.id, p.contract_id, p.received_at, p.amount, p.received_method,
             p.source_type, p.receipt_type, p.has_receipt,
             COALESCE(SUM(p.amount) OVER (PARTITION BY p.contract_id
                 ORDER BY p.received_at ASC, p.created_at ASC, p.id ASC
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS prev_pay,
             COALESCE(ca.claim_active,0) AS claim_active
      FROM payments p
      LEFT JOIN claim_agg ca ON ca.contract_id = p.contract_id
    )
    SELECT pc.id, pc.contract_id, c.contract_no, pc.received_at, pc.amount,
           pc.received_method, pc.source_type, pc.receipt_type, pc.has_receipt,
           GREATEST(0, LEAST(pc.amount, pc.claim_active - pc.prev_pay)) AS allocated_amount,
           CASE
             WHEN pc.amount < 0 THEN '返金'
             WHEN GREATEST(0, LEAST(pc.amount, pc.claim_active - pc.prev_pay)) <= 0 THEN '預り金'
             WHEN GREATEST(0, LEAST(pc.amount, pc.claim_active - pc.prev_pay)) >= pc.amount THEN '消込済'
             ELSE '一部充当'
           END AS alloc_status,
           co.company_name
    FROM pay_calc pc
    JOIN contracts c ON c.id = pc.contract_id
    LEFT JOIN LATERAL (
        SELECT co2.company_name FROM contract_company_links l
        JOIN companies co2 ON co2.id=l.company_id
        WHERE l.contract_id=c.id ORDER BY l.id LIMIT 1
    ) co ON TRUE
    WHERE (CAST(:q AS text) IS NULL
           OR c.contract_no ILIKE CAST(:qq AS text)
           OR co.company_name ILIKE CAST(:qq AS text))
    ORDER BY pc.received_at DESC NULLS LAST, pc.id
    LIMIT 200
    """
)


@router.get("/billing")
def get_billing(q: Optional[str] = None, status: Optional[str] = Query(None)):
    params = {"q": q, "qq": f"%{q}%" if q else None, "status": status}
    with engine.connect() as cn:
        kpis = cn.execute(KPI_SQL).mappings().first()
        claims = cn.execute(CLAIMS_SQL, params).mappings().all()
        payments = cn.execute(PAYMENTS_SQL, params).mappings().all()
    claims_out = []
    for r in claims:
        d = dict(r)
        csv = d.pop("methods_csv", None)
        d["methods"] = [m for m in (csv or "").split(",") if m]
        claims_out.append(d)
    return {
        "kpis": dict(kpis),
        "claims": claims_out,
        "payments": [dict(r) for r in payments],
    }


class PaymentIn(BaseModel):
    contract_id: str
    received_at: str
    amount: float
    received_method: Optional[str] = None
    received_place: Optional[str] = None
    source_type: Optional[str] = "通常"
    receipt_type: Optional[str] = None
    has_receipt: Optional[bool] = None


INSERT_PAYMENT_SQL = text(
    """
    INSERT INTO payments
        (contract_id, received_at, amount, received_method, received_place,
         source_type, receipt_type, has_receipt)
    VALUES
        (CAST(:contract_id AS uuid), CAST(:received_at AS timestamptz), CAST(:amount AS numeric),
         :received_method, :received_place, COALESCE(:source_type, '通常'),
         :receipt_type, :has_receipt)
    RETURNING id
    """
)


@router.post("/payments")
def post_payment(body: PaymentIn):
    if body.amount is None:
        raise HTTPException(422, "入金額を入力してください")
    if not body.received_at:
        raise HTTPException(422, "入金日を入力してください")
    params = body.model_dump()
    params["received_method"] = (params.get("received_method") or "").strip() or None
    params["received_place"] = (params.get("received_place") or "").strip() or None
    params["receipt_type"] = (params.get("receipt_type") or "").strip() or None
    # 証票種別が指定されていれば証票ありとして扱う
    if params.get("has_receipt") is None:
        params["has_receipt"] = bool(params.get("receipt_type"))
    with engine.begin() as cn:
        exists = cn.execute(
            text("SELECT 1 FROM contracts WHERE id = CAST(:id AS uuid)"),
            {"id": body.contract_id},
        ).first()
        if not exists:
            raise HTTPException(404, "対象の契約が見つかりません")
        new_id = cn.execute(INSERT_PAYMENT_SQL, params).scalar_one()
    return {"id": str(new_id)}


# =========================
# 入金の編集・削除（Phase 2 第4弾）
# =========================
class PaymentUpdateIn(BaseModel):
    received_at: str
    amount: float
    received_method: Optional[str] = None
    received_place: Optional[str] = None
    source_type: Optional[str] = "通常"
    receipt_type: Optional[str] = None
    has_receipt: Optional[bool] = None


UPDATE_PAYMENT_SQL = text(
    """
    UPDATE payments SET
      received_at=CAST(:received_at AS timestamptz), amount=CAST(:amount AS numeric),
      received_method=:received_method, received_place=:received_place,
      source_type=COALESCE(:source_type, '通常'), receipt_type=:receipt_type,
      has_receipt=:has_receipt, updated_at=NOW()
    WHERE id=CAST(:id AS uuid)
    """
)
DELETE_PAYMENT_SQL = text("DELETE FROM payments WHERE id=CAST(:id AS uuid)")


@router.put("/payments/{payment_id}")
def update_payment(payment_id: str, body: PaymentUpdateIn):
    if body.amount is None:
        raise HTTPException(422, "入金額を入力してください")
    if not body.received_at:
        raise HTTPException(422, "入金日を入力してください")
    params = body.model_dump()
    params["id"] = payment_id
    params["received_method"] = (params.get("received_method") or "").strip() or None
    params["received_place"] = (params.get("received_place") or "").strip() or None
    params["receipt_type"] = (params.get("receipt_type") or "").strip() or None
    if params.get("has_receipt") is None:
        params["has_receipt"] = bool(params.get("receipt_type"))
    with engine.begin() as cn:
        res = cn.execute(UPDATE_PAYMENT_SQL, params)
        if res.rowcount == 0:
            raise HTTPException(404, "対象の入金が見つかりません")
    return {"ok": True}


@router.delete("/payments/{payment_id}")
def delete_payment(payment_id: str):
    with engine.begin() as cn:
        res = cn.execute(DELETE_PAYMENT_SQL, {"id": payment_id})
        if res.rowcount == 0:
            raise HTTPException(404, "対象の入金が見つかりません")
    return {"ok": True}


# =========================
# 請求（claims）の発行・編集・削除（Phase 2 第4弾）
# =========================
class ClaimIn(BaseModel):
    claim_category: str
    occurred_on: str
    due_at: Optional[str] = None
    new_amount: float = 0
    carry_over_amount: float = 0
    status: str = "open"
    methods: Optional[List[str]] = None
    memo: Optional[str] = None


INSERT_CLAIM_SQL = text(
    """
    INSERT INTO claims
      (contract_id, claim_category, occurred_on, new_amount, carry_over_amount,
       claim_total_amount, due_at, payment_method_json, status)
    VALUES
      (CAST(:contract_id AS uuid), :claim_category, CAST(:occurred_on AS date),
       CAST(:new_amount AS numeric), CAST(:carry_over_amount AS numeric),
       CAST(:total AS numeric), CAST(:due_at AS timestamptz),
       CAST(:methods_json AS jsonb), :status)
    RETURNING id
    """
)
UPDATE_CLAIM_SQL = text(
    """
    UPDATE claims SET
      claim_category=:claim_category, occurred_on=CAST(:occurred_on AS date),
      new_amount=CAST(:new_amount AS numeric), carry_over_amount=CAST(:carry_over_amount AS numeric),
      claim_total_amount=CAST(:total AS numeric), due_at=CAST(:due_at AS timestamptz),
      payment_method_json=CAST(:methods_json AS jsonb), status=:status,
      version_no=version_no+1, updated_at=NOW()
    WHERE id=CAST(:id AS uuid)
    """
)
DELETE_CLAIM_SQL = text("DELETE FROM claims WHERE id=CAST(:id AS uuid)")


def _claim_params(body: "ClaimIn"):
    category = (body.claim_category or "").strip()
    status = (body.status or "").strip() or "open"
    if not category:
        raise HTTPException(422, "請求区分を選択してください")
    if not body.occurred_on:
        raise HTTPException(422, "計上日を入力してください")
    new_amt = float(body.new_amount or 0)
    carry = float(body.carry_over_amount or 0)
    total = new_amt + carry
    methods_json = json.dumps(
        {"methods": body.methods or [], "memo": (body.memo or "").strip()},
        ensure_ascii=False,
    )
    return {
        "claim_category": category,
        "occurred_on": (body.occurred_on or "").strip() or None,
        "new_amount": new_amt,
        "carry_over_amount": carry,
        "total": total,
        "due_at": (body.due_at or "").strip() or None,
        "methods_json": methods_json,
        "status": status,
    }


@router.post("/contracts/{contract_id}/claims")
def create_claim(contract_id: str, body: ClaimIn):
    params = _claim_params(body)
    params["contract_id"] = contract_id
    with engine.begin() as cn:
        if not cn.execute(
            text("SELECT 1 FROM contracts WHERE id=CAST(:id AS uuid)"), {"id": contract_id}
        ).first():
            raise HTTPException(404, "対象の契約が見つかりません")
        new_id = cn.execute(INSERT_CLAIM_SQL, params).scalar_one()
    return {"id": str(new_id)}


@router.put("/claims/{claim_id}")
def update_claim(claim_id: str, body: ClaimIn):
    params = _claim_params(body)
    params["id"] = claim_id
    with engine.begin() as cn:
        res = cn.execute(UPDATE_CLAIM_SQL, params)
        if res.rowcount == 0:
            raise HTTPException(404, "対象の請求が見つかりません")
    return {"ok": True}


@router.delete("/claims/{claim_id}")
def delete_claim(claim_id: str):
    with engine.begin() as cn:
        res = cn.execute(DELETE_CLAIM_SQL, {"id": claim_id})
        if res.rowcount == 0:
            raise HTTPException(404, "対象の請求が見つかりません")
    return {"ok": True}
