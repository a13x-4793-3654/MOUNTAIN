from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text

from ..db import engine

router = APIRouter(prefix="/api", tags=["persons"])

LIST_SQL = text(
    """
    SELECT pe.id, pe.full_name, pe.full_name_kana, pe.birth_date,
           pe.prefecture, pe.city,
           (SELECT count(*) FROM contract_person_links l
             WHERE l.person_id=pe.id) AS contract_count
    FROM persons pe
    WHERE (CAST(:q AS text) IS NULL
           OR pe.full_name ILIKE CAST(:qq AS text)
           OR pe.full_name_kana ILIKE CAST(:qq AS text)
           OR pe.city ILIKE CAST(:qq AS text))
    ORDER BY pe.full_name_kana NULLS LAST, pe.full_name, pe.id
    LIMIT :limit OFFSET :offset
    """
)

COUNT_SQL = text(
    """
    SELECT count(*)
    FROM persons pe
    WHERE (CAST(:q AS text) IS NULL
           OR pe.full_name ILIKE CAST(:qq AS text)
           OR pe.full_name_kana ILIKE CAST(:qq AS text)
           OR pe.city ILIKE CAST(:qq AS text))
    """
)

DETAIL_SQL = text(
    """
    SELECT id, full_name, full_name_kana, birth_date, postal_code,
           prefecture, city, address1, address2, created_at, updated_at
    FROM persons
    WHERE id = CAST(:id AS uuid)
    """
)

CONTRACTS_SQL = text(
    """
    SELECT c.id, c.contract_no, c.contract_summary,
           c.contract_status, st.label AS status_label,
           l.link_category, lm.label AS link_label
    FROM contract_person_links l
    JOIN contracts c ON c.id = l.contract_id
    LEFT JOIN code_masters st ON st.category='contract_status' AND st.code=c.contract_status
    LEFT JOIN code_masters lm ON lm.category='link_category'   AND lm.code=l.link_category
    WHERE l.person_id = CAST(:id AS uuid)
    ORDER BY c.contract_no
    """
)


@router.get("/persons")
def list_persons(
    q: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    params = {
        "q": q,
        "qq": f"%{q}%" if q else None,
        "limit": limit,
        "offset": offset,
    }
    with engine.connect() as cn:
        rows = cn.execute(LIST_SQL, params).mappings().all()
        total = cn.execute(COUNT_SQL, params).scalar_one()
    return {"total": total, "items": [dict(r) for r in rows]}


@router.get("/persons/{person_id}")
def get_person(person_id: str):
    params = {"id": person_id}
    with engine.connect() as cn:
        person = cn.execute(DETAIL_SQL, params).mappings().first()
        if person is None:
            raise HTTPException(status_code=404, detail="person not found")
        contracts = cn.execute(CONTRACTS_SQL, params).mappings().all()
    return {
        "person": dict(person),
        "contracts": [dict(r) for r in contracts],
    }


# ===== 書き込み（新規・編集・削除） =====
class PersonIn(BaseModel):
    full_name: str
    full_name_kana: Optional[str] = None
    birth_date: Optional[str] = None
    postal_code: Optional[str] = None
    prefecture: Optional[str] = None
    city: Optional[str] = None
    address1: Optional[str] = None
    address2: Optional[str] = None


PERSON_INSERT_SQL = text(
    """
    INSERT INTO persons
      (full_name, full_name_kana, birth_date, postal_code,
       prefecture, city, address1, address2)
    VALUES
      (:full_name, :full_name_kana, CAST(:birth_date AS date), :postal_code,
       :prefecture, :city, :address1, :address2)
    RETURNING id
    """
)

PERSON_UPDATE_SQL = text(
    """
    UPDATE persons SET
      full_name=:full_name, full_name_kana=:full_name_kana,
      birth_date=CAST(:birth_date AS date), postal_code=:postal_code,
      prefecture=:prefecture, city=:city, address1=:address1,
      address2=:address2, updated_at=NOW()
    WHERE id = CAST(:id AS uuid)
    """
)


def _person_params(body: "PersonIn") -> dict:
    d = body.model_dump()
    d["birth_date"] = (d.get("birth_date") or None) or None
    if d["birth_date"] == "":
        d["birth_date"] = None
    return d


@router.post("/persons")
def create_person(body: PersonIn):
    if not body.full_name.strip():
        raise HTTPException(status_code=422, detail="氏名は必須です")
    with engine.begin() as cn:
        pid = cn.execute(PERSON_INSERT_SQL, _person_params(body)).scalar_one()
    return {"id": str(pid)}


@router.put("/persons/{person_id}")
def update_person(person_id: str, body: PersonIn):
    if not body.full_name.strip():
        raise HTTPException(status_code=422, detail="氏名は必須です")
    params = _person_params(body)
    params["id"] = person_id
    with engine.begin() as cn:
        res = cn.execute(PERSON_UPDATE_SQL, params)
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="person not found")
    return {"ok": True}


@router.delete("/persons/{person_id}")
def delete_person(person_id: str):
    with engine.begin() as cn:
        n = cn.execute(text(
            "SELECT count(*) FROM contract_person_links WHERE person_id=CAST(:id AS uuid)"
        ), {"id": person_id}).scalar_one()
        if n > 0:
            raise HTTPException(
                status_code=409,
                detail=f"契約に紐づいているため削除できません（契約数: {n}）",
            )
        res = cn.execute(text(
            "DELETE FROM persons WHERE id=CAST(:id AS uuid)"
        ), {"id": person_id})
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="person not found")
    return {"ok": True}
