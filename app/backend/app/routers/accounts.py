import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text

from ..auth import CurrentUser, ensure_can, get_current_user
from ..crypto import decrypt_bytes, encrypt_str, mask_account_no
from ..db import engine

router = APIRouter(prefix="/api", tags=["accounts"])

LIST_SQL = text(
    """
    SELECT a.id, a.account_category, a.account_type, a.account_role,
           a.bank_name, a.branch_name, a.account_no_masked,
           a.account_holder_kana, a.expiry_mm_yy, a.is_active,
           (SELECT count(*) FROM contract_account_links l
             WHERE l.account_id=a.id) AS contract_count
    FROM accounts a
    WHERE (CAST(:q AS text) IS NULL
           OR a.bank_name ILIKE CAST(:qq AS text)
           OR a.branch_name ILIKE CAST(:qq AS text)
           OR a.account_holder_kana ILIKE CAST(:qq AS text))
      AND (CAST(:category AS text) IS NULL OR a.account_category = :category)
    ORDER BY a.account_category, a.bank_name NULLS LAST, a.id
    LIMIT :limit OFFSET :offset
    """
)

COUNT_SQL = text(
    """
    SELECT count(*)
    FROM accounts a
    WHERE (CAST(:q AS text) IS NULL
           OR a.bank_name ILIKE CAST(:qq AS text)
           OR a.branch_name ILIKE CAST(:qq AS text)
           OR a.account_holder_kana ILIKE CAST(:qq AS text))
      AND (CAST(:category AS text) IS NULL OR a.account_category = :category)
    """
)

DETAIL_SQL = text(
    """
    SELECT id, account_category, account_type, account_role,
           bank_code, branch_code, bank_name, branch_name,
           account_no_masked, account_holder_kana, expiry_mm_yy,
           incident_code, is_active, created_at, updated_at
    FROM accounts
    WHERE id = CAST(:id AS uuid)
    """
)

CONTRACTS_SQL = text(
    """
    SELECT c.id, c.contract_no, c.contract_summary,
           c.contract_status, st.label AS status_label,
           l.link_category, lm.label AS link_label, l.is_default
    FROM contract_account_links l
    JOIN contracts c ON c.id = l.contract_id
    LEFT JOIN code_masters st ON st.category='contract_status' AND st.code=c.contract_status
    LEFT JOIN code_masters lm ON lm.category='link_category'   AND lm.code=l.link_category
    WHERE l.account_id = CAST(:id AS uuid)
    ORDER BY c.contract_no
    """
)


@router.get("/accounts")
def list_accounts(
    q: Optional[str] = None,
    category: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    params = {
        "q": q,
        "qq": f"%{q}%" if q else None,
        "category": category,
        "limit": limit,
        "offset": offset,
    }
    with engine.connect() as cn:
        rows = cn.execute(LIST_SQL, params).mappings().all()
        total = cn.execute(COUNT_SQL, params).scalar_one()
    return {"total": total, "items": [dict(r) for r in rows]}


@router.get("/accounts/{account_id}")
def get_account(account_id: str):
    params = {"id": account_id}
    with engine.connect() as cn:
        account = cn.execute(DETAIL_SQL, params).mappings().first()
        if account is None:
            raise HTTPException(status_code=404, detail="account not found")
        contracts = cn.execute(CONTRACTS_SQL, params).mappings().all()
    return {
        "account": dict(account),
        "contracts": [dict(r) for r in contracts],
    }


# ===== 書き込み（新規・編集・削除） =====
import re


class AccountIn(BaseModel):
    account_category: str = "bank"          # bank / credit
    account_type: str = "普通"
    account_role: str = "self"              # self / other
    bank_code: Optional[str] = None
    branch_code: Optional[str] = None
    bank_name: Optional[str] = None
    branch_name: Optional[str] = None
    account_no_masked: Optional[str] = None
    # 実番号（口座番号・カード番号）。入力があれば暗号化保存し、マスクを自動生成する。
    # 編集時に空のままなら既存の番号・マスクは保持する（上書きしない）。
    account_no: Optional[str] = None
    cvv2: Optional[str] = None              # カードのセキュリティコード（任意）
    account_holder_kana: Optional[str] = None
    expiry_mm_yy: Optional[str] = None
    incident_code: str = "00"
    is_active: bool = True


ACCOUNT_INSERT_SQL = text(
    """
    INSERT INTO accounts
      (account_category, account_type, account_role, bank_code, branch_code,
       bank_name, branch_name, account_no_masked, account_no_encrypted,
       cvv2_encrypted, account_holder_kana,
       expiry_mm_yy, incident_code, is_active)
    VALUES
      (:account_category, :account_type, :account_role, :bank_code, :branch_code,
       :bank_name, :branch_name, :account_no_masked, :account_no_encrypted,
       :cvv2_encrypted, :account_holder_kana,
       :expiry_mm_yy, :incident_code, :is_active)
    RETURNING id
    """
)

ACCOUNT_UPDATE_SQL = text(
    """
    UPDATE accounts SET
      account_category=:account_category, account_type=:account_type,
      account_role=:account_role, bank_code=:bank_code, branch_code=:branch_code,
      bank_name=:bank_name, branch_name=:branch_name,
      account_no_masked = COALESCE(:account_no_masked, account_no_masked),
      account_no_encrypted = COALESCE(:account_no_encrypted, account_no_encrypted),
      cvv2_encrypted = COALESCE(:cvv2_encrypted, cvv2_encrypted),
      account_holder_kana=:account_holder_kana,
      expiry_mm_yy=:expiry_mm_yy, incident_code=:incident_code,
      is_active=:is_active, updated_at=NOW()
    WHERE id = CAST(:id AS uuid)
    """
)


def _apply_real_number(params: dict, body: "AccountIn") -> None:
    """実番号・CVVの入力があれば暗号化し、マスクを自動生成して params に反映する。

    入力が空のときは None のままにして、SQL 側の COALESCE で既存値を保持する。
    """
    params["account_no_encrypted"] = None
    params["cvv2_encrypted"] = None
    raw = (body.account_no or "").strip()
    if raw:
        digits = re.sub(r"[\s\-]", "", raw)
        if not digits.isdigit():
            raise HTTPException(
                status_code=422,
                detail="口座番号・カード番号は数字で入力してください（ハイフン・空白は自動で除去します）。",
            )
        params["account_no_encrypted"] = encrypt_str(digits)
        params["account_no_masked"] = mask_account_no(digits, params["account_category"])
    cvv = (body.cvv2 or "").strip()
    if cvv:
        if not cvv.isdigit() or not (3 <= len(cvv) <= 4):
            raise HTTPException(
                status_code=422,
                detail="セキュリティコードは3〜4桁の数字で入力してください。",
            )
        params["cvv2_encrypted"] = encrypt_str(cvv)


def _account_params(body: "AccountIn") -> dict:
    d = body.model_dump()
    if d.get("account_category") not in ("bank", "credit"):
        raise HTTPException(status_code=422, detail="区分は bank / credit のいずれかです")
    if d.get("account_role") not in ("self", "other"):
        raise HTTPException(status_code=422, detail="名義区分が不正です")
    exp = (d.get("expiry_mm_yy") or "").strip()
    if exp == "":
        d["expiry_mm_yy"] = None
    elif not re.match(r"^(0[1-9]|1[0-2])/\d{2}$", exp):
        raise HTTPException(status_code=422, detail="有効期限は MM/YY 形式で入力してください")
    else:
        d["expiry_mm_yy"] = exp
    if not (d.get("incident_code") or "").strip():
        d["incident_code"] = "00"
    for k in ("bank_code", "branch_code", "bank_name", "branch_name",
              "account_no_masked", "account_holder_kana"):
        v = d.get(k)
        d[k] = v.strip() if isinstance(v, str) and v.strip() else (None if not v else v)
    return d


@router.post("/accounts")
def create_account(body: AccountIn):
    params = _account_params(body)
    _apply_real_number(params, body)
    with engine.begin() as cn:
        aid = cn.execute(ACCOUNT_INSERT_SQL, params).scalar_one()
    return {"id": str(aid)}


@router.put("/accounts/{account_id}")
def update_account(account_id: str, body: AccountIn):
    params = _account_params(body)
    _apply_real_number(params, body)
    params["id"] = account_id
    with engine.begin() as cn:
        res = cn.execute(ACCOUNT_UPDATE_SQL, params)
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="account not found")
    return {"ok": True}


@router.delete("/accounts/{account_id}")
def delete_account(account_id: str):
    with engine.begin() as cn:
        n = cn.execute(text(
            "SELECT count(*) FROM contract_account_links WHERE account_id=CAST(:id AS uuid)"
        ), {"id": account_id}).scalar_one()
        if n > 0:
            raise HTTPException(
                status_code=409,
                detail=f"契約に紐づいているため削除できません（契約数: {n}）",
            )
        res = cn.execute(text(
            "DELETE FROM accounts WHERE id=CAST(:id AS uuid)"
        ), {"id": account_id})
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="account not found")
    return {"ok": True}


# ===== 機微情報の開示（JIT reveal：権限保持者のみ・監査ログ記録） =====

REVEAL_SELECT_SQL = text(
    """
    SELECT id, account_category, account_no_masked,
           account_no_encrypted, cvv2_encrypted, expiry_mm_yy
    FROM accounts
    WHERE id = CAST(:id AS uuid)
    """
)

AUDIT_INSERT_SQL = text(
    """
    INSERT INTO audit_logs (entity_type, entity_id, action, after_json, actor_user_id)
    VALUES ('account', CAST(:id AS uuid), 'reveal',
            CAST(:after AS jsonb), CAST(:uid AS uuid))
    """
)


class RevealIn(BaseModel):
    reason: Optional[str] = None            # 開示理由（監査ログに記録・任意）


@router.post("/accounts/{account_id}/reveal")
def reveal_account_no(
    account_id: str,
    body: Optional[RevealIn] = None,
    user: CurrentUser = Depends(get_current_user),
):
    """口座番号・カード番号（実番号）を復号して返す。

    権限 ``action.sensitive.reveal`` を持つ利用者（または管理者）のみ実行できる。
    開示のたびに監査ログ（audit_logs）へ記録する。
    """
    ensure_can(user, "action.sensitive.reveal")

    with engine.connect() as cn:
        row = cn.execute(REVEAL_SELECT_SQL, {"id": account_id}).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="口座・カードが見つかりません。")
    if not row["account_no_encrypted"]:
        raise HTTPException(
            status_code=409,
            detail="この口座・カードには実番号が登録されていません。編集画面から実番号を登録してください。",
        )
    try:
        full = decrypt_bytes(row["account_no_encrypted"])
    except Exception:
        raise HTTPException(
            status_code=500,
            detail="実番号の復号に失敗しました。暗号鍵の設定を管理者にご確認ください。",
        )
    cvv2: Optional[str] = None
    if row["account_category"] == "credit" and row["cvv2_encrypted"]:
        try:
            cvv2 = decrypt_bytes(row["cvv2_encrypted"])
        except Exception:
            cvv2 = None

    # 監査ログは best-effort（記録に失敗しても開示自体は妨げない）。
    try:
        after = json.dumps(
            {
                "field": "account_no",
                "masked": row["account_no_masked"],
                "reason": (body.reason if body and body.reason else None),
            },
            ensure_ascii=False,
        )
        with engine.begin() as cn:
            cn.execute(AUDIT_INSERT_SQL, {"id": account_id, "after": after, "uid": user.id})
    except Exception:
        pass

    return {"account_no": full, "cvv2": cvv2, "expiry_mm_yy": row["expiry_mm_yy"]}
