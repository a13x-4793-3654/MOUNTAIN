from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text

from ..db import engine

router = APIRouter(prefix="/api", tags=["companies"])


def _norm_phone(s: Optional[str]) -> str:
    return "".join(ch for ch in (s or "") if ch.isdigit())

LIST_SQL = text(
    """
    SELECT co.id, co.company_name, co.company_name_kana,
           co.prefecture, co.city, co.status_flag,
           (SELECT p.phone_number FROM company_phones p
             WHERE p.company_id=co.id AND p.is_primary=TRUE
             ORDER BY p.id LIMIT 1) AS phone,
           (SELECT count(*) FROM contract_company_links l
             WHERE l.company_id=co.id) AS contract_count
    FROM companies co
    WHERE (CAST(:q AS text) IS NULL
           OR co.company_name ILIKE CAST(:qq AS text)
           OR co.company_name_kana ILIKE CAST(:qq AS text)
           OR co.city ILIKE CAST(:qq AS text))
      AND (CAST(:status AS int) IS NULL OR co.status_flag = CAST(:status AS int))
    ORDER BY co.company_name_kana NULLS LAST, co.company_name
    LIMIT :limit OFFSET :offset
    """
)

COUNT_SQL = text(
    """
    SELECT count(*)
    FROM companies co
    WHERE (CAST(:q AS text) IS NULL
           OR co.company_name ILIKE CAST(:qq AS text)
           OR co.company_name_kana ILIKE CAST(:qq AS text)
           OR co.city ILIKE CAST(:qq AS text))
      AND (CAST(:status AS int) IS NULL OR co.status_flag = CAST(:status AS int))
    """
)

DETAIL_SQL = text(
    """
    SELECT id, company_name, company_name_kana, corporate_number, postal_code,
           prefecture, city, address1, address2, status_flag, status_reason,
           created_at, updated_at
    FROM companies
    WHERE id = CAST(:id AS uuid)
    """
)

PHONES_SQL = text(
    """
    SELECT id, phone_number, phone_type, is_primary
    FROM company_phones
    WHERE company_id = CAST(:id AS uuid)
    ORDER BY is_primary DESC, id
    """
)

CONTRACTS_SQL = text(
    """
    SELECT c.id, c.contract_no, c.contract_summary,
           c.contract_status, st.label AS status_label,
           l.link_category, lm.label AS link_label
    FROM contract_company_links l
    JOIN contracts c ON c.id = l.contract_id
    LEFT JOIN code_masters st ON st.category='contract_status' AND st.code=c.contract_status
    LEFT JOIN code_masters lm ON lm.category='link_category'   AND lm.code=l.link_category
    WHERE l.company_id = CAST(:id AS uuid)
    ORDER BY c.contract_no
    """
)


@router.get("/companies")
def list_companies(
    q: Optional[str] = None,
    status: Optional[int] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    params = {
        "q": q,
        "qq": f"%{q}%" if q else None,
        "status": status,
        "limit": limit,
        "offset": offset,
    }
    with engine.connect() as cn:
        rows = cn.execute(LIST_SQL, params).mappings().all()
        total = cn.execute(COUNT_SQL, params).scalar_one()
    return {"total": total, "items": [dict(r) for r in rows]}


@router.get("/companies/{company_id}")
def get_company(company_id: str):
    params = {"id": company_id}
    with engine.connect() as cn:
        company = cn.execute(DETAIL_SQL, params).mappings().first()
        if company is None:
            raise HTTPException(status_code=404, detail="company not found")
        phones = cn.execute(PHONES_SQL, params).mappings().all()
        contracts = cn.execute(CONTRACTS_SQL, params).mappings().all()
    return {
        "company": dict(company),
        "phones": [dict(r) for r in phones],
        "contracts": [dict(r) for r in contracts],
    }


# ===== 書き込み（新規・編集・削除） =====
class CompanyIn(BaseModel):
    company_name: str
    company_name_kana: Optional[str] = None
    corporate_number: Optional[str] = None
    postal_code: Optional[str] = None
    prefecture: Optional[str] = None
    city: Optional[str] = None
    address1: Optional[str] = None
    address2: Optional[str] = None
    status_flag: int = 0
    status_reason: Optional[str] = None
    phone: Optional[str] = None


INSERT_SQL = text(
    """
    INSERT INTO companies
      (company_name, company_name_kana, corporate_number, postal_code, prefecture, city,
       address1, address2, status_flag, status_reason)
    VALUES
      (:company_name, :company_name_kana, :corporate_number, :postal_code, :prefecture, :city,
       :address1, :address2, :status_flag, :status_reason)
    RETURNING id
    """
)

UPDATE_SQL = text(
    """
    UPDATE companies SET
      company_name=:company_name, company_name_kana=:company_name_kana,
      corporate_number=:corporate_number,
      postal_code=:postal_code, prefecture=:prefecture, city=:city,
      address1=:address1, address2=:address2, status_flag=:status_flag,
      status_reason=:status_reason, updated_at=NOW()
    WHERE id = CAST(:id AS uuid)
    """
)

INSERT_PHONE_SQL = text(
    """
    INSERT INTO company_phones
      (company_id, phone_number, phone_number_normalized, phone_type, is_primary)
    VALUES (CAST(:cid AS uuid), :ph, :norm, 'main', TRUE)
    """
)


@router.post("/companies")
def create_company(body: CompanyIn):
    if not body.company_name.strip():
        raise HTTPException(status_code=422, detail="会社名は必須です")
    data = body.model_dump(exclude={"phone"})
    with engine.begin() as cn:
        cid = cn.execute(INSERT_SQL, data).scalar_one()
        if body.phone and body.phone.strip():
            cn.execute(INSERT_PHONE_SQL,
                       {"cid": str(cid), "ph": body.phone.strip(),
                        "norm": _norm_phone(body.phone)})
    return {"id": str(cid)}


@router.put("/companies/{company_id}")
def update_company(company_id: str, body: CompanyIn):
    if not body.company_name.strip():
        raise HTTPException(status_code=422, detail="会社名は必須です")
    data = body.model_dump(exclude={"phone"})
    data["id"] = company_id
    with engine.begin() as cn:
        res = cn.execute(UPDATE_SQL, data)
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="company not found")
    # 電話番号は「電話番号」パネル側で個別管理するため、ここでは変更しない
    return {"ok": True}


@router.delete("/companies/{company_id}")
def delete_company(company_id: str):
    with engine.begin() as cn:
        n = cn.execute(text(
            "SELECT count(*) FROM contract_company_links WHERE company_id=CAST(:id AS uuid)"
        ), {"id": company_id}).scalar_one()
        if n > 0:
            raise HTTPException(
                status_code=409,
                detail=f"契約に紐づいているため削除できません（契約数: {n}）",
            )
        res = cn.execute(text(
            "DELETE FROM companies WHERE id=CAST(:id AS uuid)"
        ), {"id": company_id})
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="company not found")
    return {"ok": True}


# ===== 会社の電話番号（複数管理） =====
class CompanyPhoneIn(BaseModel):
    phone_number: str
    phone_type: Optional[str] = None
    is_primary: bool = False


def _phone_params(body: CompanyPhoneIn) -> dict:
    ph = (body.phone_number or "").strip()
    if not ph:
        raise HTTPException(status_code=422, detail="電話番号を入力してください")
    return {
        "ph": ph,
        "norm": _norm_phone(ph),
        "ptype": (body.phone_type or "").strip() or None,
        "primary": bool(body.is_primary),
    }


@router.post("/companies/{company_id}/phones")
def create_company_phone(company_id: str, body: CompanyPhoneIn):
    p = _phone_params(body)
    with engine.begin() as cn:
        if not cn.execute(
            text("SELECT 1 FROM companies WHERE id=CAST(:id AS uuid)"), {"id": company_id}
        ).first():
            raise HTTPException(status_code=404, detail="対象の会社が見つかりません")
        if p["primary"]:
            cn.execute(text(
                "UPDATE company_phones SET is_primary=FALSE WHERE company_id=CAST(:id AS uuid)"
            ), {"id": company_id})
        new_id = cn.execute(text(
            """
            INSERT INTO company_phones
              (company_id, phone_number, phone_number_normalized, phone_type, is_primary)
            VALUES (CAST(:id AS uuid), :ph, :norm, :ptype, :primary)
            RETURNING id
            """
        ), {**p, "id": company_id}).scalar_one()
    return {"id": int(new_id)}


@router.put("/company-phones/{phone_id}")
def update_company_phone(phone_id: int, body: CompanyPhoneIn):
    p = _phone_params(body)
    with engine.begin() as cn:
        cid = cn.execute(text(
            "SELECT company_id FROM company_phones WHERE id=:pid"
        ), {"pid": phone_id}).scalar()
        if cid is None:
            raise HTTPException(status_code=404, detail="対象の電話番号が見つかりません")
        if p["primary"]:
            cn.execute(text(
                "UPDATE company_phones SET is_primary=FALSE WHERE company_id=:cid"
            ), {"cid": str(cid)})
        cn.execute(text(
            """
            UPDATE company_phones
               SET phone_number=:ph, phone_number_normalized=:norm,
                   phone_type=:ptype, is_primary=:primary
             WHERE id=:pid
            """
        ), {**p, "pid": phone_id})
    return {"ok": True}


@router.delete("/company-phones/{phone_id}")
def delete_company_phone(phone_id: int):
    with engine.begin() as cn:
        res = cn.execute(text("DELETE FROM company_phones WHERE id=:pid"), {"pid": phone_id})
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="対象の電話番号が見つかりません")
    return {"ok": True}
