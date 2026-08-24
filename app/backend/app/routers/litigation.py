from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from ..db import engine

router = APIRouter(prefix="/api", tags=["litigation"])

LIST_SQL = text(
    """
    SELECT ls.id, ls.contract_id, c.contract_no, ls.proc_type, ls.case_name,
           ls.case_number, ls.court_name, ls.our_side_role, ls.status,
           ls.claim_amount, ls.filed_or_received_on,
           op.display_name_snapshot AS opponent_name,
           nx.scheduled_at AS next_schedule_at,
           nx.schedule_type AS next_schedule_type
    FROM lawsuits ls
    JOIN contracts c ON c.id = ls.contract_id
    LEFT JOIN LATERAL (
        SELECT display_name_snapshot FROM lawsuit_parties p
        WHERE p.lawsuit_id=ls.id AND p.party_role LIKE '%相手方%'
        ORDER BY p.id LIMIT 1
    ) op ON TRUE
    LEFT JOIN LATERAL (
        SELECT scheduled_at, schedule_type FROM lawsuit_schedules s
        WHERE s.lawsuit_id=ls.id AND s.scheduled_at >= now()
        ORDER BY s.scheduled_at LIMIT 1
    ) nx ON TRUE
    WHERE (CAST(:status AS text) IS NULL OR ls.status = :status)
      AND (CAST(:q AS text) IS NULL
           OR c.contract_no ILIKE CAST(:qq AS text)
           OR ls.case_number ILIKE CAST(:qq AS text)
           OR ls.court_name ILIKE CAST(:qq AS text)
           OR ls.case_name ILIKE CAST(:qq AS text))
    ORDER BY ls.filed_or_received_on DESC NULLS LAST, ls.id
    """
)

ONE_SQL = text(
    """
    SELECT ls.*, c.contract_no, c.contract_summary
    FROM lawsuits ls
    JOIN contracts c ON c.id = ls.contract_id
    WHERE ls.id = CAST(:id AS uuid)
    """
)
PARTIES_SQL = text(
    """
    SELECT id, party_role, display_name_snapshot, agent_note, company_id, person_id
    FROM lawsuit_parties WHERE lawsuit_id = CAST(:id AS uuid) ORDER BY id
    """
)
SCHED_SQL = text(
    """
    SELECT id, schedule_type, scheduled_at, place, attendee, result, completed_at
    FROM lawsuit_schedules WHERE lawsuit_id = CAST(:id AS uuid)
    ORDER BY scheduled_at
    """
)
DOCS_SQL = text(
    """
    SELECT id, doc_name, side, due_on, filed_on, state
    FROM lawsuit_documents WHERE lawsuit_id = CAST(:id AS uuid) ORDER BY id
    """
)
MEMOS_SQL = text(
    """
    SELECT id, memo_on, note FROM lawsuit_memos
    WHERE lawsuit_id = CAST(:id AS uuid) ORDER BY memo_on DESC, id DESC
    """
)


@router.get("/lawsuits")
def list_lawsuits(q: Optional[str] = None, status: Optional[str] = Query(None)):
    params = {"q": q, "qq": f"%{q}%" if q else None, "status": status}
    with engine.connect() as cn:
        rows = cn.execute(LIST_SQL, params).mappings().all()
    return {"total": len(rows), "items": [dict(r) for r in rows]}


@router.get("/lawsuits/{lawsuit_id}")
def get_lawsuit(lawsuit_id: str):
    params = {"id": lawsuit_id}
    with engine.connect() as cn:
        one = cn.execute(ONE_SQL, params).mappings().first()
        if one is None:
            raise HTTPException(status_code=404, detail="lawsuit not found")
        parties = cn.execute(PARTIES_SQL, params).mappings().all()
        schedules = cn.execute(SCHED_SQL, params).mappings().all()
        documents = cn.execute(DOCS_SQL, params).mappings().all()
        memos = cn.execute(MEMOS_SQL, params).mappings().all()
    return {
        "lawsuit": dict(one),
        "parties": [dict(r) for r in parties],
        "schedules": [dict(r) for r in schedules],
        "documents": [dict(r) for r in documents],
        "memos": [dict(r) for r in memos],
    }


# =========================
# 訴訟の書き込み（Wave B）
# =========================
DEFAULT_ROLE = "被告（当方）"


def _v(x: Optional[str]) -> Optional[str]:
    if x is None:
        return None
    x = str(x).strip()
    return x or None


def _require_lawsuit(cn, lawsuit_id: str):
    if not cn.execute(
        text("SELECT 1 FROM lawsuits WHERE id=CAST(:id AS uuid)"), {"id": lawsuit_id}
    ).first():
        raise HTTPException(404, "対象の訴訟が見つかりません")


class LawsuitIn(BaseModel):
    proc_type: str
    case_number: str
    court_name: str
    status: str
    our_side_role: Optional[str] = None
    case_name: Optional[str] = None
    court_clerk: Optional[str] = None
    our_lawyer: Optional[str] = None
    claim_amount: Optional[float] = None
    suit_value: Optional[float] = None
    filed_or_received_on: Optional[str] = None
    demand: Optional[str] = None
    cause: Optional[str] = None


def _lawsuit_params(body: LawsuitIn) -> dict:
    proc = _v(body.proc_type)
    case_no = _v(body.case_number)
    court = _v(body.court_name)
    status = _v(body.status)
    if not proc:
        raise HTTPException(422, "手続の種類を選択してください")
    if not case_no:
        raise HTTPException(422, "事件番号を入力してください")
    if not court:
        raise HTTPException(422, "裁判所名を入力してください")
    if not status:
        raise HTTPException(422, "状態を選択してください")
    return {
        "proc_type": proc,
        "case_number": case_no,
        "court_name": court,
        "status": status,
        "our_side_role": _v(body.our_side_role) or DEFAULT_ROLE,
        "case_name": _v(body.case_name),
        "court_clerk": _v(body.court_clerk),
        "our_lawyer": _v(body.our_lawyer),
        "claim_amount": body.claim_amount,
        "suit_value": body.suit_value,
        "filed_or_received_on": _v(body.filed_or_received_on),
        "demand": _v(body.demand),
        "cause": _v(body.cause),
    }


INSERT_LAWSUIT_SQL = text(
    """
    INSERT INTO lawsuits
      (contract_id, proc_type, case_number, court_name, status, our_side_role,
       case_name, court_clerk, our_lawyer, claim_amount, suit_value,
       filed_or_received_on, demand, cause)
    VALUES
      (CAST(:contract_id AS uuid), :proc_type, :case_number, :court_name, :status,
       :our_side_role, :case_name, :court_clerk, :our_lawyer,
       CAST(:claim_amount AS numeric), CAST(:suit_value AS numeric),
       CAST(:filed_or_received_on AS date), :demand, :cause)
    RETURNING id
    """
)
UPDATE_LAWSUIT_SQL = text(
    """
    UPDATE lawsuits SET
      proc_type=:proc_type, case_number=:case_number, court_name=:court_name,
      status=:status, our_side_role=:our_side_role, case_name=:case_name,
      court_clerk=:court_clerk, our_lawyer=:our_lawyer,
      claim_amount=CAST(:claim_amount AS numeric), suit_value=CAST(:suit_value AS numeric),
      filed_or_received_on=CAST(:filed_or_received_on AS date),
      demand=:demand, cause=:cause, updated_at=NOW()
    WHERE id=CAST(:id AS uuid)
    """
)


@router.post("/contracts/{contract_id}/lawsuits")
def create_lawsuit(contract_id: str, body: LawsuitIn):
    params = _lawsuit_params(body)
    params["contract_id"] = contract_id
    with engine.begin() as cn:
        if not cn.execute(
            text("SELECT 1 FROM contracts WHERE id=CAST(:id AS uuid)"), {"id": contract_id}
        ).first():
            raise HTTPException(404, "対象の契約が見つかりません")
        try:
            new_id = cn.execute(INSERT_LAWSUIT_SQL, params).scalar_one()
        except IntegrityError:
            raise HTTPException(409, "同じ裁判所・事件番号の訴訟がすでに登録されています")
    return {"id": str(new_id)}


@router.put("/lawsuits/{lawsuit_id}")
def update_lawsuit(lawsuit_id: str, body: LawsuitIn):
    params = _lawsuit_params(body)
    params["id"] = lawsuit_id
    with engine.begin() as cn:
        try:
            res = cn.execute(UPDATE_LAWSUIT_SQL, params)
        except IntegrityError:
            raise HTTPException(409, "同じ裁判所・事件番号の訴訟がすでに登録されています")
        if res.rowcount == 0:
            raise HTTPException(404, "対象の訴訟が見つかりません")
    return {"ok": True}


@router.delete("/lawsuits/{lawsuit_id}")
def delete_lawsuit(lawsuit_id: str):
    with engine.begin() as cn:
        res = cn.execute(
            text("DELETE FROM lawsuits WHERE id=CAST(:id AS uuid)"), {"id": lawsuit_id}
        )
        if res.rowcount == 0:
            raise HTTPException(404, "対象の訴訟が見つかりません")
    return {"ok": True}


# ---- 当事者 ----
class PartyIn(BaseModel):
    party_role: str
    company_id: Optional[str] = None
    person_id: Optional[str] = None
    agent_note: Optional[str] = None


def _party_snapshot(cn, company_id: Optional[str], person_id: Optional[str]) -> str:
    if company_id:
        nm = cn.execute(
            text("SELECT company_name FROM companies WHERE id=CAST(:id AS uuid)"),
            {"id": company_id},
        ).scalar()
        if nm is None:
            raise HTTPException(404, "対象の会社が見つかりません")
        return str(nm)
    nm = cn.execute(
        text("SELECT full_name FROM persons WHERE id=CAST(:id AS uuid)"),
        {"id": person_id},
    ).scalar()
    if nm is None:
        raise HTTPException(404, "対象の名義人が見つかりません")
    return str(nm)


def _party_params(cn, body: PartyIn) -> dict:
    role = _v(body.party_role)
    company_id = _v(body.company_id)
    person_id = _v(body.person_id)
    if not role:
        raise HTTPException(422, "立場を選択してください")
    if not company_id and not person_id:
        raise HTTPException(422, "会社または名義人を選択してください")
    snapshot = _party_snapshot(cn, company_id, person_id)
    return {
        "party_role": role,
        "company_id": company_id,
        "person_id": person_id,
        "agent_note": _v(body.agent_note),
        "display_name_snapshot": snapshot,
    }


@router.post("/lawsuits/{lawsuit_id}/parties")
def add_party(lawsuit_id: str, body: PartyIn):
    with engine.begin() as cn:
        _require_lawsuit(cn, lawsuit_id)
        params = _party_params(cn, body)
        params["lawsuit_id"] = lawsuit_id
        new_id = cn.execute(
            text(
                """
                INSERT INTO lawsuit_parties
                  (lawsuit_id, party_role, company_id, person_id, agent_note, display_name_snapshot)
                VALUES
                  (CAST(:lawsuit_id AS uuid), :party_role, CAST(:company_id AS uuid),
                   CAST(:person_id AS uuid), :agent_note, :display_name_snapshot)
                RETURNING id
                """
            ),
            params,
        ).scalar_one()
    return {"id": int(new_id)}


@router.put("/lawsuit-parties/{party_id}")
def update_party(party_id: int, body: PartyIn):
    with engine.begin() as cn:
        params = _party_params(cn, body)
        params["id"] = party_id
        res = cn.execute(
            text(
                """
                UPDATE lawsuit_parties SET
                  party_role=:party_role, company_id=CAST(:company_id AS uuid),
                  person_id=CAST(:person_id AS uuid), agent_note=:agent_note,
                  display_name_snapshot=:display_name_snapshot
                WHERE id=:id
                """
            ),
            params,
        )
        if res.rowcount == 0:
            raise HTTPException(404, "対象の当事者が見つかりません")
    return {"ok": True}


@router.delete("/lawsuit-parties/{party_id}")
def delete_party(party_id: int):
    with engine.begin() as cn:
        res = cn.execute(text("DELETE FROM lawsuit_parties WHERE id=:id"), {"id": party_id})
        if res.rowcount == 0:
            raise HTTPException(404, "対象の当事者が見つかりません")
    return {"ok": True}


# ---- 期日 ----
class ScheduleIn(BaseModel):
    schedule_type: str
    scheduled_at: str
    place: Optional[str] = None
    attendee: Optional[str] = None
    result: Optional[str] = None


def _schedule_params(body: ScheduleIn) -> dict:
    stype = _v(body.schedule_type)
    at = _v(body.scheduled_at)
    if not stype:
        raise HTTPException(422, "期日の種別を選択してください")
    if not at:
        raise HTTPException(422, "日時を入力してください")
    return {
        "schedule_type": stype,
        "scheduled_at": at,
        "place": _v(body.place),
        "attendee": _v(body.attendee),
        "result": _v(body.result) or "予定",
    }


@router.post("/lawsuits/{lawsuit_id}/schedules")
def add_schedule(lawsuit_id: str, body: ScheduleIn):
    with engine.begin() as cn:
        _require_lawsuit(cn, lawsuit_id)
        params = _schedule_params(body)
        params["lawsuit_id"] = lawsuit_id
        new_id = cn.execute(
            text(
                """
                INSERT INTO lawsuit_schedules
                  (lawsuit_id, schedule_type, scheduled_at, place, attendee, result)
                VALUES
                  (CAST(:lawsuit_id AS uuid), :schedule_type, CAST(:scheduled_at AS timestamptz),
                   :place, :attendee, :result)
                RETURNING id
                """
            ),
            params,
        ).scalar_one()
    return {"id": int(new_id)}


@router.put("/lawsuit-schedules/{schedule_id}")
def update_schedule(schedule_id: int, body: ScheduleIn):
    with engine.begin() as cn:
        params = _schedule_params(body)
        params["id"] = schedule_id
        res = cn.execute(
            text(
                """
                UPDATE lawsuit_schedules SET
                  schedule_type=:schedule_type, scheduled_at=CAST(:scheduled_at AS timestamptz),
                  place=:place, attendee=:attendee, result=:result
                WHERE id=:id
                """
            ),
            params,
        )
        if res.rowcount == 0:
            raise HTTPException(404, "対象の期日が見つかりません")
    return {"ok": True}


@router.delete("/lawsuit-schedules/{schedule_id}")
def delete_schedule(schedule_id: int):
    with engine.begin() as cn:
        res = cn.execute(text("DELETE FROM lawsuit_schedules WHERE id=:id"), {"id": schedule_id})
        if res.rowcount == 0:
            raise HTTPException(404, "対象の期日が見つかりません")
    return {"ok": True}


# ---- 提出書類 ----
class DocumentIn(BaseModel):
    doc_name: str
    side: str
    due_on: Optional[str] = None
    filed_on: Optional[str] = None
    state: Optional[str] = None


def _document_params(body: DocumentIn) -> dict:
    name = _v(body.doc_name)
    side = _v(body.side)
    if not name:
        raise HTTPException(422, "書類名を入力してください")
    if not side:
        raise HTTPException(422, "提出側を選択してください")
    return {
        "doc_name": name,
        "side": side,
        "due_on": _v(body.due_on),
        "filed_on": _v(body.filed_on),
        "state": _v(body.state) or "未提出",
    }


@router.post("/lawsuits/{lawsuit_id}/documents")
def add_document(lawsuit_id: str, body: DocumentIn):
    with engine.begin() as cn:
        _require_lawsuit(cn, lawsuit_id)
        params = _document_params(body)
        params["lawsuit_id"] = lawsuit_id
        new_id = cn.execute(
            text(
                """
                INSERT INTO lawsuit_documents
                  (lawsuit_id, doc_name, side, due_on, filed_on, state)
                VALUES
                  (CAST(:lawsuit_id AS uuid), :doc_name, :side,
                   CAST(:due_on AS date), CAST(:filed_on AS date), :state)
                RETURNING id
                """
            ),
            params,
        ).scalar_one()
    return {"id": int(new_id)}


@router.put("/lawsuit-documents/{document_id}")
def update_document(document_id: int, body: DocumentIn):
    with engine.begin() as cn:
        params = _document_params(body)
        params["id"] = document_id
        res = cn.execute(
            text(
                """
                UPDATE lawsuit_documents SET
                  doc_name=:doc_name, side=:side, due_on=CAST(:due_on AS date),
                  filed_on=CAST(:filed_on AS date), state=:state
                WHERE id=:id
                """
            ),
            params,
        )
        if res.rowcount == 0:
            raise HTTPException(404, "対象の書類が見つかりません")
    return {"ok": True}


@router.delete("/lawsuit-documents/{document_id}")
def delete_document(document_id: int):
    with engine.begin() as cn:
        res = cn.execute(text("DELETE FROM lawsuit_documents WHERE id=:id"), {"id": document_id})
        if res.rowcount == 0:
            raise HTTPException(404, "対象の書類が見つかりません")
    return {"ok": True}


# ---- 経過メモ ----
class MemoIn(BaseModel):
    memo_on: str
    note: str


def _memo_params(body: MemoIn) -> dict:
    on = _v(body.memo_on)
    note = _v(body.note)
    if not on:
        raise HTTPException(422, "日付を入力してください")
    if not note:
        raise HTTPException(422, "内容を入力してください")
    return {"memo_on": on, "note": note}


@router.post("/lawsuits/{lawsuit_id}/memos")
def add_memo(lawsuit_id: str, body: MemoIn):
    with engine.begin() as cn:
        _require_lawsuit(cn, lawsuit_id)
        params = _memo_params(body)
        params["lawsuit_id"] = lawsuit_id
        new_id = cn.execute(
            text(
                """
                INSERT INTO lawsuit_memos (lawsuit_id, memo_on, note)
                VALUES (CAST(:lawsuit_id AS uuid), CAST(:memo_on AS date), :note)
                RETURNING id
                """
            ),
            params,
        ).scalar_one()
    return {"id": int(new_id)}


@router.put("/lawsuit-memos/{memo_id}")
def update_memo(memo_id: int, body: MemoIn):
    with engine.begin() as cn:
        params = _memo_params(body)
        params["id"] = memo_id
        res = cn.execute(
            text("UPDATE lawsuit_memos SET memo_on=CAST(:memo_on AS date), note=:note WHERE id=:id"),
            params,
        )
        if res.rowcount == 0:
            raise HTTPException(404, "対象のメモが見つかりません")
    return {"ok": True}


@router.delete("/lawsuit-memos/{memo_id}")
def delete_memo(memo_id: int):
    with engine.begin() as cn:
        res = cn.execute(text("DELETE FROM lawsuit_memos WHERE id=:id"), {"id": memo_id})
        if res.rowcount == 0:
            raise HTTPException(404, "対象のメモが見つかりません")
    return {"ok": True}
