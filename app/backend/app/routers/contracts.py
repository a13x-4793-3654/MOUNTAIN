from datetime import datetime
import csv
import hashlib
import io
import json
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text

from ..auth import CurrentUser, get_current_user
from ..calendar import CalendarIn, event_payload, require_calendar_token, save_calendar_request, sync_calendar
from ..contract_parties import contractor_person_sql
from ..db import engine

router = APIRouter(prefix="/api", tags=["contracts"])

# 認証未実装のデモ環境のため、新規契約の登録者は既定ユーザー（管理者 太郎）を内部で使用する。
DEFAULT_CREATED_BY = "00000000-0000-0000-0000-000000000001"


def _none(v):
    """空文字・空白のみを NULL 扱いに正規化する（CAST(:x AS date/uuid) 用）。"""
    if isinstance(v, str):
        v = v.strip()
    return v or None


def _code_exists(cn, category: str, code: str) -> bool:
    """コードマスタ (category, code) の存在確認。契約区分・業務ステータス等の妥当性検証に使う。
    ハードコードの固定集合ではなく、管理→コードマスタで追加された区分も許可するため DB を参照する。"""
    if not code:
        return False
    return cn.execute(
        text("SELECT 1 FROM code_masters WHERE category = :cat AND code = :code LIMIT 1"),
        {"cat": category, "code": code},
    ).first() is not None

# 一覧本体（会社名・契約者名・担当・各コードの日本語ラベルを結合）
_LIST_BODY = f"""
FROM contracts c
LEFT JOIN code_masters cat ON cat.category='contract_category' AND cat.code=c.contract_category
LEFT JOIN code_masters st  ON st.category='contract_status'    AND st.code=c.contract_status
LEFT JOIN code_masters rv  ON rv.category='review_status'      AND rv.code=c.review_status
LEFT JOIN LATERAL (
    SELECT co2.company_name
    FROM contract_company_links l JOIN companies co2 ON co2.id=l.company_id
    WHERE l.contract_id=c.id ORDER BY l.id LIMIT 1
) co ON TRUE
LEFT JOIN LATERAL (
    {contractor_person_sql("c.id")}
) pe ON TRUE
LEFT JOIN users u ON u.id=c.assignee_user_id
WHERE (CAST(:q AS text) IS NULL
       OR c.contract_no ILIKE CAST(:qq AS text)
       OR c.contract_summary ILIKE CAST(:qq AS text)
       OR co.company_name ILIKE CAST(:qq AS text)
       OR pe.full_name ILIKE CAST(:qq AS text))
  AND (CAST(:status AS text)   IS NULL OR c.contract_status  = :status)
  AND (CAST(:category AS text) IS NULL OR c.contract_category = :category)
"""

LIST_SQL = text(
    """
    SELECT
      c.id, c.contract_no, c.contract_summary,
      c.contract_category, c.contract_status, c.review_status,
      c.started_at, c.ended_at,
      cat.label AS category_label,
      st.label  AS status_label,
      rv.label  AS review_label,
      co.company_name,
      pe.full_name AS person_name,
      u.display_name AS assignee_name
    """
    + _LIST_BODY
    + """
    ORDER BY c.ended_at NULLS LAST, c.contract_no
    LIMIT :limit OFFSET :offset
    """
)

COUNT_SQL = text("SELECT count(*) " + _LIST_BODY)

# CSV出力（一覧と同じ絞り込み・並び。件数上限なしで全件を書き出す）
CSV_SQL = text(
    """
    SELECT
      c.contract_no, c.contract_summary,
      cat.label AS category_label, c.contract_category,
      st.label  AS status_label,   c.contract_status,
      rv.label  AS review_label,   c.review_status,
      co.company_name,
      pe.full_name AS person_name,
      u.display_name AS assignee_name,
      c.started_at, c.ended_at
    """
    + _LIST_BODY
    + """
    ORDER BY c.ended_at NULLS LAST, c.contract_no
    """
)

CONTRACT_SQL = text(
    """
    SELECT c.*,
           cat.label AS category_label,
           st.label  AS status_label,
           rv.label  AS review_label,
           u.display_name  AS assignee_name,
           cb.display_name AS created_by_name
    FROM contracts c
    LEFT JOIN code_masters cat ON cat.category='contract_category' AND cat.code=c.contract_category
    LEFT JOIN code_masters st  ON st.category='contract_status'    AND st.code=c.contract_status
    LEFT JOIN code_masters rv  ON rv.category='review_status'      AND rv.code=c.review_status
    LEFT JOIN users u  ON u.id=c.assignee_user_id
    LEFT JOIN users cb ON cb.id=c.created_by
    WHERE c.id = CAST(:id AS uuid)
    """
)

COMPANIES_SQL = text(
    """
    SELECT co.id, l.id AS link_id, co.company_name, co.company_name_kana,
           co.prefecture, co.city, co.address1,
           l.link_category, lm.label AS link_label,
           (SELECT p.phone_number FROM company_phones p
             WHERE p.company_id=co.id AND p.is_primary=TRUE
             ORDER BY p.id LIMIT 1) AS phone
    FROM contract_company_links l
    JOIN companies co ON co.id=l.company_id
    LEFT JOIN code_masters lm ON lm.category='link_category' AND lm.code=l.link_category
    WHERE l.contract_id = CAST(:id AS uuid)
    ORDER BY l.id
    """
)

PERSONS_SQL = text(
    """
    SELECT pe.id, l.id AS link_id, pe.full_name, pe.full_name_kana,
           pe.prefecture, pe.city, pe.address1,
           l.link_category, lm.label AS link_label
    FROM contract_person_links l
    JOIN persons pe ON pe.id=l.person_id
    LEFT JOIN code_masters lm ON lm.category='link_category' AND lm.code=l.link_category
    WHERE l.contract_id = CAST(:id AS uuid)
    ORDER BY l.id
    """
)

ACCOUNTS_SQL = text(
    """
    SELECT a.id, l.id AS link_id, a.account_category, a.account_type,
           a.bank_name, a.branch_name, a.account_no_masked,
           a.account_holder_kana, a.expiry_mm_yy,
           l.link_category, lm.label AS link_label, l.is_default
    FROM contract_account_links l
    JOIN accounts a ON a.id=l.account_id
    LEFT JOIN code_masters lm ON lm.category='link_category' AND lm.code=l.link_category
    WHERE l.contract_id = CAST(:id AS uuid)
    ORDER BY l.is_default DESC, l.id
    """
)

IDENTIFIERS_SQL = text(
    """
    SELECT i.id, i.identifier_type, i.identifier_value, i.is_primary,
           cm.label AS identifier_type_label
    FROM contract_identifiers i
    LEFT JOIN code_masters cm
      ON cm.category = 'identifier_type' AND cm.code = i.identifier_type
    WHERE i.contract_id = CAST(:id AS uuid)
    ORDER BY i.is_primary DESC, i.id
    """
)

FLAGS_SQL = text(
    """
    SELECT f.flag_code, COALESCE(fm.label, f.flag_code) AS label
    FROM contract_flags f
    LEFT JOIN code_masters fm ON fm.category='contract_flag' AND fm.code=f.flag_code
    WHERE f.contract_id = CAST(:id AS uuid)
    ORDER BY f.flag_code
    """
)

# やり取り履歴
COMMUNICATIONS_SQL = text(
    """
    SELECT c.id, c.occurred_at, c.channel, c.direction, c.summary, c.details,
           CASE WHEN ce.communication_id IS NULL THEN NULL ELSE json_build_object(
             'status', ce.status, 'calendar_name', ce.calendar_name,
             'starts_at', ce.starts_at, 'ends_at', ce.ends_at, 'error', ce.last_error
           ) END AS calendar
    FROM communications c
    LEFT JOIN communication_calendar_events ce ON ce.communication_id = c.id
    WHERE c.contract_id = CAST(:id AS uuid)
    ORDER BY c.occurred_at DESC
    """
)

# 請求
CLAIMS_SQL = text(
    """
    WITH pay_agg AS (
      SELECT COALESCE(SUM(amount),0) AS pay_net
      FROM payments WHERE contract_id = CAST(:id AS uuid)
    ),
    calc AS (
      SELECT cl.id, cl.claim_category, cl.occurred_on, cl.claim_total_amount,
             cl.due_at, cl.status, cl.payment_method_json,
        CASE WHEN cl.status='canceled' THEN 0
             ELSE GREATEST(0, LEAST(cl.claim_total_amount,
                  (SELECT pay_net FROM pay_agg)
                  - COALESCE(SUM(CASE WHEN cl.status<>'canceled' THEN cl.claim_total_amount ELSE 0 END)
                      OVER (ORDER BY cl.occurred_on ASC, cl.created_at ASC, cl.id ASC
                            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)))
        END AS paid_amount
      FROM claims cl WHERE cl.contract_id = CAST(:id AS uuid)
    )
    SELECT id, claim_category, occurred_on, claim_total_amount,
           (claim_total_amount - paid_amount) AS remaining_balance, paid_amount, due_at,
           CASE
             WHEN status='canceled' THEN 'canceled'
             WHEN paid_amount >= claim_total_amount THEN 'paid'
             WHEN paid_amount > 0 THEN 'partial'
             WHEN due_at < now() THEN 'delinquent'
             ELSE 'open'
           END AS status,
           CASE WHEN jsonb_typeof(payment_method_json->'methods')='array'
                THEN (SELECT string_agg(t.v, ',' ORDER BY t.ord)
                      FROM jsonb_array_elements_text(payment_method_json->'methods')
                           WITH ORDINALITY AS t(v, ord))
                ELSE NULL END AS methods_csv
    FROM calc
    ORDER BY occurred_on DESC, id
    """
)

# 入金
PAYMENTS_SQL = text(
    """
    WITH claim_agg AS (
      SELECT COALESCE(SUM(claim_total_amount) FILTER (WHERE status<>'canceled'),0) AS claim_active
      FROM claims WHERE contract_id = CAST(:id AS uuid)
    ),
    pcalc AS (
      SELECT p.id, p.received_at, p.amount, p.received_method, p.source_type,
             p.receipt_type, p.has_receipt,
             COALESCE(SUM(p.amount) OVER (ORDER BY p.received_at ASC, p.created_at ASC, p.id ASC
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS prev_pay
      FROM payments p WHERE p.contract_id = CAST(:id AS uuid)
    )
    SELECT id, received_at, amount, received_method, source_type,
           receipt_type, has_receipt,
           GREATEST(0, LEAST(amount, (SELECT claim_active FROM claim_agg) - prev_pay)) AS allocated_amount,
           CASE
             WHEN amount < 0 THEN '返金'
             WHEN GREATEST(0, LEAST(amount, (SELECT claim_active FROM claim_agg) - prev_pay)) <= 0 THEN '預り金'
             WHEN GREATEST(0, LEAST(amount, (SELECT claim_active FROM claim_agg) - prev_pay)) >= amount THEN '消込済'
             ELSE '一部充当'
           END AS alloc_status
    FROM pcalc
    ORDER BY received_at DESC, id
    """
)

# 訴訟
LAWSUITS_SQL = text(
    """
    SELECT id, proc_type, case_name, case_number, court_name,
           our_side_role, status, claim_amount, filed_or_received_on, demand
    FROM lawsuits
    WHERE contract_id = CAST(:id AS uuid)
    ORDER BY filed_or_received_on DESC NULLS LAST, id
    """
)

# ファイル
FILES_SQL = text(
    """
    SELECT id, file_name, content_type, file_size_bytes,
           tag_text, is_password_protected, created_at,
           EXISTS (SELECT 1 FROM file_blobs b WHERE b.file_id = files.id) AS has_content
    FROM files
    WHERE contract_id = CAST(:id AS uuid)
    ORDER BY created_at DESC, id
    """
)


@router.get("/contracts")
def list_contracts(
    q: Optional[str] = None,
    status: Optional[str] = None,
    category: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    params = {
        "q": q,
        "qq": f"%{q}%" if q else None,
        "status": status,
        "category": category,
        "limit": limit,
        "offset": offset,
    }
    with engine.connect() as cn:
        rows = cn.execute(LIST_SQL, params).mappings().all()
        total = cn.execute(COUNT_SQL, params).scalar_one()
    return {"total": total, "items": [dict(r) for r in rows]}


def _ymd(v) -> str:
    """日付/日時を YYYY-MM-DD 文字列に整形（NULL は空文字）。"""
    if not v:
        return ""
    s = str(v)
    return s[:10]


@router.get("/contracts.csv")
def export_contracts_csv(
    q: Optional[str] = None,
    status: Optional[str] = None,
    category: Optional[str] = None,
):
    """契約一覧を CSV で出力する（画面の絞り込みに連動、全件）。
    Excel で文字化けしないよう UTF-8 BOM 付き・CRLF 改行。"""
    params = {
        "q": q,
        "qq": f"%{q}%" if q else None,
        "status": status,
        "category": category,
    }
    with engine.connect() as cn:
        rows = cn.execute(CSV_SQL, params).mappings().all()

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n")
    writer.writerow(
        ["契約番号", "概要", "区分", "状態", "審査", "会社", "契約者", "担当", "開始日", "終了日"]
    )
    for r in rows:
        writer.writerow(
            [
                r["contract_no"] or "",
                r["contract_summary"] or "",
                r["category_label"] or r["contract_category"] or "",
                r["status_label"] or r["contract_status"] or "",
                r["review_label"] or r["review_status"] or "",
                r["company_name"] or "",
                r["person_name"] or "",
                r["assignee_name"] or "",
                _ymd(r["started_at"]),
                _ymd(r["ended_at"]),
            ]
        )
    data = "\ufeff" + buf.getvalue()
    filename = f"contracts_{datetime.now().strftime('%Y%m%d')}.csv"
    return Response(
        content=data.encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/contracts/{contract_id}")
def get_contract(contract_id: str):
    params = {"id": contract_id}
    with engine.connect() as cn:
        contract = cn.execute(CONTRACT_SQL, params).mappings().first()
        if contract is None:
            raise HTTPException(status_code=404, detail="contract not found")
        companies = cn.execute(COMPANIES_SQL, params).mappings().all()
        persons = cn.execute(PERSONS_SQL, params).mappings().all()
        accounts = cn.execute(ACCOUNTS_SQL, params).mappings().all()
        identifiers = cn.execute(IDENTIFIERS_SQL, params).mappings().all()
        flags = cn.execute(FLAGS_SQL, params).mappings().all()
        communications = cn.execute(COMMUNICATIONS_SQL, params).mappings().all()
        claims = cn.execute(CLAIMS_SQL, params).mappings().all()
        payments = cn.execute(PAYMENTS_SQL, params).mappings().all()
        lawsuits = cn.execute(LAWSUITS_SQL, params).mappings().all()
        files = cn.execute(FILES_SQL, params).mappings().all()
    claims_out = []
    for r in claims:
        d = dict(r)
        csv = d.pop("methods_csv", None)
        d["methods"] = [m for m in (csv or "").split(",") if m]
        claims_out.append(d)
    return {
        "contract": dict(contract),
        "companies": [dict(r) for r in companies],
        "persons": [dict(r) for r in persons],
        "accounts": [dict(r) for r in accounts],
        "identifiers": [dict(r) for r in identifiers],
        "flags": [dict(r) for r in flags],
        "communications": [dict(r) for r in communications],
        "claims": claims_out,
        "payments": [dict(r) for r in payments],
        "lawsuits": [dict(r) for r in lawsuits],
        "files": [dict(r) for r in files],
    }


# =========================
# 書き込み：契約の新規作成・編集（Phase 2 第3弾）
# =========================

# 契約番号の自動採番（MTN-西暦-6桁連番。連番は全体の最大値+1）
NEXT_NO_SQL = text(
    """
    SELECT COALESCE(MAX(CAST(split_part(contract_no,'-',3) AS integer)),0)
    FROM contracts
    WHERE contract_no ~ '^MTN-[0-9]+-[0-9]+$'
    """
)

INSERT_CONTRACT_SQL = text(
    """
    INSERT INTO contracts
      (contract_no, contract_category, contract_summary, contract_status, review_status,
       signed_at, started_at, ended_at, assignee_user_id, created_by)
    VALUES
      (:contract_no, :contract_category, :contract_summary, 'active', 'pending',
       CAST(:signed_at AS date), CAST(:started_at AS date), CAST(:ended_at AS date),
       CAST(:assignee_user_id AS uuid), CAST(:created_by AS uuid))
    RETURNING id
    """
)

INSERT_C_COMPANY_SQL = text(
    """
    INSERT INTO contract_company_links (contract_id, company_id, link_category)
    VALUES (CAST(:contract_id AS uuid), CAST(:company_id AS uuid), :link_category)
    """
)

INSERT_C_PERSON_SQL = text(
    """
    INSERT INTO contract_person_links (contract_id, person_id, link_category)
    VALUES (CAST(:contract_id AS uuid), CAST(:person_id AS uuid), :link_category)
    """
)

COMPANY_NAME_SQL = text("SELECT company_name FROM companies WHERE id = CAST(:id AS uuid)")
PERSON_NAME_SQL = text("SELECT full_name FROM persons WHERE id = CAST(:id AS uuid)")

UPDATE_CONTRACT_SQL = text(
    """
    UPDATE contracts SET
      contract_category     = :contract_category,
      contract_summary      = :contract_summary,
      contract_status       = :contract_status,
      signed_at             = CAST(:signed_at AS date),
      started_at            = CAST(:started_at AS date),
      ended_at              = CAST(:ended_at AS date),
      has_recurring_billing = :has_recurring_billing,
      assignee_user_id      = CAST(:assignee_user_id AS uuid),
      review_memo           = :review_memo,
      version_no            = version_no + 1,
      updated_at            = NOW()
    WHERE id = CAST(:id AS uuid)
    """
)

USERS_SQL = text("SELECT id, display_name FROM users ORDER BY display_name")

class PartyIn(BaseModel):
    # 契約の当事者（会社／個人）を1件表す。会社対名義・個人対個人・会社対会社など、
    # 会社と個人を任意の組み合わせ・任意の件数で登録できるようにするための入力。
    kind: str  # "company" または "person"
    id: str
    link_category: Optional[str] = None  # この契約での立場（債権者・債務者・貸主・借主 等）


class ContractCreateIn(BaseModel):
    contract_category: str
    contract_summary: Optional[str] = None
    signed_at: Optional[str] = None
    started_at: Optional[str] = None
    ended_at: Optional[str] = None
    assignee_user_id: Optional[str] = None
    # 当事者（新方式）。会社・個人を複数まとめて指定できる。指定があればこちらを優先。
    parties: Optional[List[PartyIn]] = None
    # 従来方式（後方互換）。単一の会社・名義。parties が空のときだけ使う。
    company_id: Optional[str] = None
    company_link_category: Optional[str] = "debtor"
    person_id: Optional[str] = None
    person_link_category: Optional[str] = "contractor"
    # 外部管理番号（識別子）。ウィザードの途中で任意入力される。
    identifier_type: Optional[str] = None
    identifier_value: Optional[str] = None
    identifier_is_primary: bool = False


class ContractUpdateIn(BaseModel):
    contract_category: str
    contract_summary: str
    contract_status: str
    signed_at: Optional[str] = None
    started_at: Optional[str] = None
    ended_at: Optional[str] = None
    has_recurring_billing: bool = False
    assignee_user_id: Optional[str] = None
    review_memo: Optional[str] = None


@router.get("/users")
def list_users():
    with engine.connect() as cn:
        rows = cn.execute(USERS_SQL).mappings().all()
    return [dict(r) for r in rows]


@router.post("/contracts")
def create_contract(body: ContractCreateIn):
    data = body.model_dump()
    category = (data.get("contract_category") or "").strip()

    # 当事者を正規化する。会社どうし・会社と個人・個人どうし いずれの契約にも対応するため、
    # 新方式 parties[]（会社・個人を任意の件数）を優先し、無ければ従来の単一 company_id/person_id を使う。
    norm_parties = []  # {kind, id, role}
    for p in data.get("parties") or []:
        kind = (p.get("kind") or "").strip()
        pid = _none(p.get("id"))
        if not pid:
            continue
        if kind not in ("company", "person"):
            raise HTTPException(status_code=422, detail="当事者の種別が正しくありません")
        role = (p.get("link_category") or "").strip()
        norm_parties.append({"kind": kind, "id": pid, "role": role})

    if not norm_parties:
        # 後方互換：単一の会社・名義から当事者を組み立てる。
        c_id = _none(data.get("company_id"))
        p_id = _none(data.get("person_id"))
        if c_id:
            norm_parties.append(
                {"kind": "company", "id": c_id, "role": _none(data.get("company_link_category")) or "debtor"}
            )
        if p_id:
            norm_parties.append(
                {"kind": "person", "id": p_id, "role": _none(data.get("person_link_category")) or "contractor"}
            )

    # 完全に同一（種別・相手・立場が全て同じ）の重複は取り除く。
    seen = set()
    deduped = []
    for p in norm_parties:
        key = (p["kind"], p["id"], p["role"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(p)
    norm_parties = deduped

    if not norm_parties:
        raise HTTPException(status_code=422, detail="会社または名義を1件以上指定してください")

    with engine.begin() as cn:
        if not _code_exists(cn, "contract_category", category):
            raise HTTPException(status_code=422, detail="契約区分を選択してください")

        # 各当事者の存在確認と、概要の自動生成に使う名称の収集。
        names = []
        for p in norm_parties:
            if p["kind"] == "company":
                nm = cn.execute(COMPANY_NAME_SQL, {"id": p["id"]}).scalar()
                if nm is None:
                    raise HTTPException(status_code=404, detail="指定された会社が見つかりません")
            else:
                nm = cn.execute(PERSON_NAME_SQL, {"id": p["id"]}).scalar()
                if nm is None:
                    raise HTTPException(status_code=404, detail="指定された名義が見つかりません")
            names.append(nm)

        summary = (data.get("contract_summary") or "").strip()
        if not summary:
            summary = "／".join([x for x in names if x]) or "（概要未設定）"

        nxt = cn.execute(NEXT_NO_SQL).scalar_one() + 1
        contract_no = f"MTN-{datetime.now().year}-{nxt:06d}"

        new_id = cn.execute(
            INSERT_CONTRACT_SQL,
            {
                "contract_no": contract_no,
                "contract_category": category,
                "contract_summary": summary,
                "signed_at": _none(data.get("signed_at")),
                "started_at": _none(data.get("started_at")),
                "ended_at": _none(data.get("ended_at")),
                "assignee_user_id": _none(data.get("assignee_user_id")),
                "created_by": DEFAULT_CREATED_BY,
            },
        ).scalar_one()

        for p in norm_parties:
            if p["kind"] == "company":
                cn.execute(
                    INSERT_C_COMPANY_SQL,
                    {
                        "contract_id": new_id,
                        "company_id": p["id"],
                        "link_category": p["role"] or "debtor",
                    },
                )
            else:
                cn.execute(
                    INSERT_C_PERSON_SQL,
                    {
                        "contract_id": new_id,
                        "person_id": p["id"],
                        "link_category": p["role"] or "contractor",
                    },
                )

        # 外部管理番号（識別子）。番号が入っていれば同時に登録する。
        ident_value = (data.get("identifier_value") or "").strip()
        if ident_value:
            ident_type = (data.get("identifier_type") or "").strip() or "other"
            cn.execute(
                INS_IDENT_SQL,
                {
                    "contract_id": new_id,
                    "identifier_type": ident_type,
                    "identifier_value": ident_value,
                    "is_primary": bool(data.get("identifier_is_primary")),
                },
            )

    return {"id": str(new_id), "contract_no": contract_no}


@router.put("/contracts/{contract_id}")
def update_contract(contract_id: str, body: ContractUpdateIn):
    data = body.model_dump()
    category = (data.get("contract_category") or "").strip()
    summary = (data.get("contract_summary") or "").strip()
    status = (data.get("contract_status") or "").strip()
    if not summary:
        raise HTTPException(status_code=422, detail="契約概要を入力してください")

    with engine.begin() as cn:
        if not _code_exists(cn, "contract_category", category):
            raise HTTPException(status_code=422, detail="契約区分を選択してください")
        if not _code_exists(cn, "contract_status", status):
            raise HTTPException(status_code=422, detail="業務ステータスを選択してください")
        res = cn.execute(
            UPDATE_CONTRACT_SQL,
            {
                "id": contract_id,
                "contract_category": category,
                "contract_summary": summary,
                "contract_status": status,
                "signed_at": _none(data.get("signed_at")),
                "started_at": _none(data.get("started_at")),
                "ended_at": _none(data.get("ended_at")),
                "has_recurring_billing": bool(data.get("has_recurring_billing")),
                "assignee_user_id": _none(data.get("assignee_user_id")),
                "review_memo": _none(data.get("review_memo")),
            },
        )
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="対象の契約が見つかりません")

    return {"ok": True}


# =========================
# 書き込み：契約の紐付（会社・名義・口座）・識別子・やり取り履歴・削除（Phase 2 第4弾）
# =========================

_CONTRACT_EXISTS_SQL = text("SELECT 1 FROM contracts WHERE id = CAST(:id AS uuid)")
_ACCOUNT_EXISTS_SQL = text("SELECT 1 FROM accounts WHERE id = CAST(:id AS uuid)")

# 紐付：会社
INS_COMPANY_LINK_SQL = text(
    """
    INSERT INTO contract_company_links (contract_id, company_id, link_category)
    VALUES (CAST(:contract_id AS uuid), CAST(:company_id AS uuid), :link_category)
    RETURNING id
    """
)
UPD_COMPANY_LINK_SQL = text(
    "UPDATE contract_company_links SET link_category=:link_category WHERE id=:link_id"
)
DEL_COMPANY_LINK_SQL = text("DELETE FROM contract_company_links WHERE id=:link_id")

# 紐付：名義（個人）
INS_PERSON_LINK_SQL = text(
    """
    INSERT INTO contract_person_links (contract_id, person_id, link_category)
    VALUES (CAST(:contract_id AS uuid), CAST(:person_id AS uuid), :link_category)
    RETURNING id
    """
)
UPD_PERSON_LINK_SQL = text(
    "UPDATE contract_person_links SET link_category=:link_category WHERE id=:link_id"
)
DEL_PERSON_LINK_SQL = text("DELETE FROM contract_person_links WHERE id=:link_id")

# 紐付：口座・カード
INS_ACCOUNT_LINK_SQL = text(
    """
    INSERT INTO contract_account_links (contract_id, account_id, link_category, is_default)
    VALUES (CAST(:contract_id AS uuid), CAST(:account_id AS uuid), :link_category, :is_default)
    RETURNING id
    """
)
UPD_ACCOUNT_LINK_SQL = text(
    "UPDATE contract_account_links SET link_category=:link_category, is_default=:is_default WHERE id=:link_id"
)
DEL_ACCOUNT_LINK_SQL = text("DELETE FROM contract_account_links WHERE id=:link_id")
CLEAR_ACCOUNT_DEFAULT_SQL = text(
    """
    UPDATE contract_account_links SET is_default=FALSE
    WHERE contract_id=:contract_id AND link_category=:link_category
      AND is_default=TRUE AND id <> COALESCE(:keep_id, -1)
    """
)
ACCOUNT_LINK_ROW_SQL = text(
    "SELECT contract_id, account_id FROM contract_account_links WHERE id=:link_id"
)

# 識別子
INS_IDENT_SQL = text(
    """
    INSERT INTO contract_identifiers (contract_id, identifier_type, identifier_value, is_primary)
    VALUES (CAST(:contract_id AS uuid), :identifier_type, :identifier_value, :is_primary)
    RETURNING id
    """
)
UPD_IDENT_SQL = text(
    "UPDATE contract_identifiers SET identifier_type=:identifier_type, identifier_value=:identifier_value, is_primary=:is_primary WHERE id=:ident_id"
)
DEL_IDENT_SQL = text("DELETE FROM contract_identifiers WHERE id=:ident_id")
IDENT_ROW_SQL = text("SELECT contract_id FROM contract_identifiers WHERE id=:ident_id")
CLEAR_IDENT_PRIMARY_SQL = text(
    """
    UPDATE contract_identifiers SET is_primary=FALSE
    WHERE contract_id=CAST(:contract_id AS uuid) AND identifier_type=:identifier_type
      AND is_primary=TRUE AND id <> COALESCE(:keep_id, -1)
    """
)

# やり取り履歴（問合履歴）
INS_COMM_SQL = text(
    """
    INSERT INTO communications (contract_id, occurred_at, channel, direction, summary, details)
    VALUES (CAST(:contract_id AS uuid), COALESCE(CAST(:occurred_at AS timestamptz), NOW()), :channel, :direction, :summary, :details)
    RETURNING id
    """
)
UPD_COMM_SQL = text(
    """
    UPDATE communications SET
      occurred_at=COALESCE(CAST(:occurred_at AS timestamptz), occurred_at), channel=:channel,
      direction=:direction, summary=:summary, details=:details, updated_at=NOW()
    WHERE id=CAST(:comm_id AS uuid)
    """
)
DEL_COMM_SQL = text("DELETE FROM communications WHERE id=CAST(:comm_id AS uuid)")

DEL_CONTRACT_SQL = text("DELETE FROM contracts WHERE id=CAST(:id AS uuid)")

_VALID_DIRECTION = {"in", "out"}


class LinkIn(BaseModel):
    entity_id: str
    link_category: str
    is_default: bool = False


class LinkCategoryIn(BaseModel):
    link_category: str
    is_default: bool = False


class IdentifierIn(BaseModel):
    identifier_type: str
    identifier_value: str
    is_primary: bool = False


class CommunicationIn(BaseModel):
    occurred_at: Optional[str] = None
    channel: Optional[str] = Field(default=None, max_length=30)
    direction: Optional[str] = None
    summary: str = Field(max_length=255)
    details: Optional[str] = None

    @field_validator("occurred_at")
    @classmethod
    def validate_occurred_at(cls, value):
        if value and value.strip():
            datetime.fromisoformat(value.strip())
        return value


class CommunicationCreateIn(CommunicationIn):
    calendar: Optional[CalendarIn] = None


def _require_contract(cn, contract_id: str):
    if not cn.execute(_CONTRACT_EXISTS_SQL, {"id": contract_id}).first():
        raise HTTPException(404, "対象の契約が見つかりません")


# ---- 会社リンク ----
@router.post("/contracts/{contract_id}/company-links")
def add_company_link(contract_id: str, body: LinkIn):
    company_id = _none(body.entity_id)
    category = (body.link_category or "").strip()
    if not company_id:
        raise HTTPException(422, "会社を選択してください")
    if not category:
        raise HTTPException(422, "立場を選択してください")
    with engine.begin() as cn:
        _require_contract(cn, contract_id)
        if not cn.execute(COMPANY_NAME_SQL, {"id": company_id}).first():
            raise HTTPException(404, "指定された会社が見つかりません")
        link_id = cn.execute(
            INS_COMPANY_LINK_SQL,
            {"contract_id": contract_id, "company_id": company_id, "link_category": category},
        ).scalar_one()
    return {"link_id": link_id}


@router.put("/contract-company-links/{link_id}")
def update_company_link(link_id: int, body: LinkCategoryIn):
    category = (body.link_category or "").strip()
    if not category:
        raise HTTPException(422, "立場を選択してください")
    with engine.begin() as cn:
        res = cn.execute(UPD_COMPANY_LINK_SQL, {"link_id": link_id, "link_category": category})
        if res.rowcount == 0:
            raise HTTPException(404, "対象の紐付が見つかりません")
    return {"ok": True}


@router.delete("/contract-company-links/{link_id}")
def delete_company_link(link_id: int):
    with engine.begin() as cn:
        res = cn.execute(DEL_COMPANY_LINK_SQL, {"link_id": link_id})
        if res.rowcount == 0:
            raise HTTPException(404, "対象の紐付が見つかりません")
    return {"ok": True}


# ---- 名義（個人）リンク ----
@router.post("/contracts/{contract_id}/person-links")
def add_person_link(contract_id: str, body: LinkIn):
    person_id = _none(body.entity_id)
    category = (body.link_category or "").strip()
    if not person_id:
        raise HTTPException(422, "名義を選択してください")
    if not category:
        raise HTTPException(422, "立場を選択してください")
    with engine.begin() as cn:
        _require_contract(cn, contract_id)
        if not cn.execute(PERSON_NAME_SQL, {"id": person_id}).first():
            raise HTTPException(404, "指定された名義が見つかりません")
        link_id = cn.execute(
            INS_PERSON_LINK_SQL,
            {"contract_id": contract_id, "person_id": person_id, "link_category": category},
        ).scalar_one()
    return {"link_id": link_id}


@router.put("/contract-person-links/{link_id}")
def update_person_link(link_id: int, body: LinkCategoryIn):
    category = (body.link_category or "").strip()
    if not category:
        raise HTTPException(422, "立場を選択してください")
    with engine.begin() as cn:
        res = cn.execute(UPD_PERSON_LINK_SQL, {"link_id": link_id, "link_category": category})
        if res.rowcount == 0:
            raise HTTPException(404, "対象の紐付が見つかりません")
    return {"ok": True}


@router.delete("/contract-person-links/{link_id}")
def delete_person_link(link_id: int):
    with engine.begin() as cn:
        res = cn.execute(DEL_PERSON_LINK_SQL, {"link_id": link_id})
        if res.rowcount == 0:
            raise HTTPException(404, "対象の紐付が見つかりません")
    return {"ok": True}


# ---- 口座・カードリンク ----
@router.post("/contracts/{contract_id}/account-links")
def add_account_link(contract_id: str, body: LinkIn):
    account_id = _none(body.entity_id)
    category = (body.link_category or "").strip()
    if not account_id:
        raise HTTPException(422, "口座・カードを選択してください")
    if not category:
        raise HTTPException(422, "紐づけ種別を選択してください")
    with engine.begin() as cn:
        _require_contract(cn, contract_id)
        if not cn.execute(_ACCOUNT_EXISTS_SQL, {"id": account_id}).first():
            raise HTTPException(404, "指定された口座・カードが見つかりません")
        if body.is_default:
            cn.execute(
                CLEAR_ACCOUNT_DEFAULT_SQL,
                {"contract_id": contract_id, "link_category": category, "keep_id": None},
            )
        link_id = cn.execute(
            INS_ACCOUNT_LINK_SQL,
            {
                "contract_id": contract_id,
                "account_id": account_id,
                "link_category": category,
                "is_default": bool(body.is_default),
            },
        ).scalar_one()
    return {"link_id": link_id}


@router.put("/contract-account-links/{link_id}")
def update_account_link(link_id: int, body: LinkCategoryIn):
    category = (body.link_category or "").strip()
    if not category:
        raise HTTPException(422, "紐づけ種別を選択してください")
    with engine.begin() as cn:
        row = cn.execute(ACCOUNT_LINK_ROW_SQL, {"link_id": link_id}).mappings().first()
        if not row:
            raise HTTPException(404, "対象の紐付が見つかりません")
        if body.is_default:
            cn.execute(
                CLEAR_ACCOUNT_DEFAULT_SQL,
                {"contract_id": str(row["contract_id"]), "link_category": category, "keep_id": link_id},
            )
        cn.execute(
            UPD_ACCOUNT_LINK_SQL,
            {"link_id": link_id, "link_category": category, "is_default": bool(body.is_default)},
        )
    return {"ok": True}


@router.delete("/contract-account-links/{link_id}")
def delete_account_link(link_id: int):
    with engine.begin() as cn:
        res = cn.execute(DEL_ACCOUNT_LINK_SQL, {"link_id": link_id})
        if res.rowcount == 0:
            raise HTTPException(404, "対象の紐付が見つかりません")
    return {"ok": True}


# ---- 識別子（外部管理番号） ----
@router.post("/contracts/{contract_id}/identifiers")
def add_identifier(contract_id: str, body: IdentifierIn):
    itype = (body.identifier_type or "").strip()
    ivalue = (body.identifier_value or "").strip()
    if not itype:
        raise HTTPException(422, "種別を入力してください")
    if not ivalue:
        raise HTTPException(422, "番号を入力してください")
    with engine.begin() as cn:
        _require_contract(cn, contract_id)
        if body.is_primary:
            cn.execute(
                CLEAR_IDENT_PRIMARY_SQL,
                {"contract_id": contract_id, "identifier_type": itype, "keep_id": None},
            )
        ident_id = cn.execute(
            INS_IDENT_SQL,
            {
                "contract_id": contract_id,
                "identifier_type": itype,
                "identifier_value": ivalue,
                "is_primary": bool(body.is_primary),
            },
        ).scalar_one()
    return {"id": ident_id}


@router.put("/identifiers/{ident_id}")
def update_identifier(ident_id: int, body: IdentifierIn):
    itype = (body.identifier_type or "").strip()
    ivalue = (body.identifier_value or "").strip()
    if not itype:
        raise HTTPException(422, "種別を入力してください")
    if not ivalue:
        raise HTTPException(422, "番号を入力してください")
    with engine.begin() as cn:
        row = cn.execute(IDENT_ROW_SQL, {"ident_id": ident_id}).mappings().first()
        if not row:
            raise HTTPException(404, "対象の識別子が見つかりません")
        if body.is_primary:
            cn.execute(
                CLEAR_IDENT_PRIMARY_SQL,
                {"contract_id": str(row["contract_id"]), "identifier_type": itype, "keep_id": ident_id},
            )
        cn.execute(
            UPD_IDENT_SQL,
            {
                "ident_id": ident_id,
                "identifier_type": itype,
                "identifier_value": ivalue,
                "is_primary": bool(body.is_primary),
            },
        )
    return {"ok": True}


@router.delete("/identifiers/{ident_id}")
def delete_identifier(ident_id: int):
    with engine.begin() as cn:
        res = cn.execute(DEL_IDENT_SQL, {"ident_id": ident_id})
        if res.rowcount == 0:
            raise HTTPException(404, "対象の識別子が見つかりません")
    return {"ok": True}


# ---- やり取り履歴（問合履歴） ----
@router.post("/contracts/{contract_id}/communications")
def add_communication(
    contract_id: UUID,
    body: CommunicationCreateIn,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
):
    direction = (body.direction or "").strip()
    summary = (body.summary or "").strip()
    if direction not in _VALID_DIRECTION:
        raise HTTPException(422, "方向を選択してください")
    if not summary:
        raise HTTPException(422, "結果・要点を入力してください")
    params = {
        "contract_id": str(contract_id),
        "occurred_at": _none(body.occurred_at),
        "channel": (body.channel or "").strip() or "その他",
        "direction": direction,
        "summary": summary,
        "details": _none(body.details),
    }
    assertion = require_calendar_token(request) if body.calendar else None
    request_hash = hashlib.sha256(
        json.dumps(
            {**params, "calendar": body.calendar.model_dump(mode="json") if body.calendar else None},
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    with engine.begin() as cn:
        _require_contract(cn, str(contract_id))
        existing = None
        if body.calendar:
            # 同時リクエストも直列化し、履歴と予定登録要求を必ず一緒に確定する。
            request_id = str(body.calendar.request_id)
            cn.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:request_id, 0))"),
                {"request_id": f"communication-calendar:{request_id}"},
            )
            existing = cn.execute(
                text("SELECT * FROM communication_calendar_events WHERE request_id=CAST(:request_id AS uuid)"),
                {"request_id": request_id},
            ).mappings().first()
            if existing and (
                str(existing["requested_by"]) != user.id or existing["request_hash"] != request_hash
            ):
                raise HTTPException(409, "この登録要求は既に使用されています。履歴を確認してください。")
        if existing:
            comm_id = str(existing["communication_id"])
        else:
            comm_id = str(cn.execute(INS_COMM_SQL, params).scalar_one())
            if body.calendar:
                contract_no = cn.execute(
                    text("SELECT contract_no FROM contracts WHERE id=CAST(:id AS uuid)"),
                    {"id": str(contract_id)},
                ).scalar_one()
                payload = event_payload(body.calendar, contract_no, summary, params["details"], user)
                save_calendar_request(cn, comm_id, body.calendar, request_hash, payload, user)
    result = sync_calendar(comm_id, assertion, user) if assertion else None
    return {"id": comm_id, "calendar": result}


@router.post("/communications/{comm_id}/calendar/retry")
def retry_communication_calendar(
    comm_id: UUID, request: Request, user: CurrentUser = Depends(get_current_user)
):
    assertion = require_calendar_token(request)
    return sync_calendar(str(comm_id), assertion, user)


@router.put("/communications/{comm_id}")
def update_communication(comm_id: str, body: CommunicationIn):
    direction = (body.direction or "").strip()
    summary = (body.summary or "").strip()
    if direction not in _VALID_DIRECTION:
        raise HTTPException(422, "方向を選択してください")
    if not summary:
        raise HTTPException(422, "結果・要点を入力してください")
    with engine.begin() as cn:
        res = cn.execute(
            UPD_COMM_SQL,
            {
                "comm_id": comm_id,
                "occurred_at": _none(body.occurred_at),
                "channel": (body.channel or "").strip() or "その他",
                "direction": direction,
                "summary": summary,
                "details": _none(body.details),
            },
        )
        if res.rowcount == 0:
            raise HTTPException(404, "対象の履歴が見つかりません")
    return {"ok": True}


@router.delete("/communications/{comm_id}")
def delete_communication(comm_id: str):
    with engine.begin() as cn:
        res = cn.execute(DEL_COMM_SQL, {"comm_id": comm_id})
        if res.rowcount == 0:
            raise HTTPException(404, "対象の履歴が見つかりません")
    return {"ok": True}


# ---- 契約の削除 ----
@router.delete("/contracts/{contract_id}")
def delete_contract(contract_id: str):
    with engine.begin() as cn:
        res = cn.execute(DEL_CONTRACT_SQL, {"id": contract_id})
        if res.rowcount == 0:
            raise HTTPException(404, "対象の契約が見つかりません")
    return {"ok": True}