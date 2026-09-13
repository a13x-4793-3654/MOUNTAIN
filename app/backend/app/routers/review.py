from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy import text

from ..db import engine
from ..auth import CurrentUser, get_current_user, ensure_can

router = APIRouter(prefix="/api", tags=["review"])

# 認証未実装のデモ環境のため、審査操作は既定で審査担当（審査 花子）が行ったものとして記録する
REVIEWER_USER_ID = "00000000-0000-0000-0000-000000000002"

# 審査操作 → 契約の審査状況（review_status）への写像
ACTION_TO_STATUS = {
    "approved": "approved",   # 承認
    "returned": "rejected",   # 差し戻し（審査状況コードは差戻を流用）
    "rejected": "rejected",   # 否決
}

_SIMILAR_FLAGS_JOIN = """
    CROSS JOIN LATERAL (
      SELECT
        EXISTS (
          SELECT 1 FROM contract_company_links a
          JOIN contract_company_links b ON a.company_id = b.company_id
          WHERE a.contract_id = c.id AND b.contract_id = c2.id
        ) AS same_company,
        EXISTS (
          SELECT 1 FROM contract_person_links a
          JOIN contract_person_links b ON a.person_id = b.person_id
          WHERE a.contract_id = c.id AND b.contract_id = c2.id
        ) AS same_person,
        EXISTS (
          SELECT 1 FROM contract_identifiers a
          JOIN contract_identifiers b
            ON lower(btrim(a.identifier_value)) = lower(btrim(b.identifier_value))
          WHERE a.contract_id = c.id AND b.contract_id = c2.id
            AND NULLIF(btrim(a.identifier_value), '') IS NOT NULL
        ) AS same_identifier
    ) sim_match
"""

_SIMILAR_CONDITION = """
    ((sim_match.same_company AND sim_match.same_person) OR sim_match.same_identifier)
"""

_SIMILAR_COUNT_JOIN = f"""
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS n FROM contracts c2
      {_SIMILAR_FLAGS_JOIN}
      WHERE c2.id <> c.id AND {_SIMILAR_CONDITION}
    ) sim ON TRUE
"""

PENDING_SQL = text(
    f"""
    SELECT c.id, c.contract_no, c.contract_summary, c.contract_category,
           c.created_at, c.review_reason,
           cat.label AS category_label,
           u.display_name AS assignee_name,
           co.company_name,
           pe.full_name AS person_name,
           COALESCE(sim.n, 0) AS similar_count
    FROM contracts c
    LEFT JOIN code_masters cat ON cat.category='contract_category' AND cat.code=c.contract_category
    LEFT JOIN users u ON u.id=c.assignee_user_id
    LEFT JOIN LATERAL (
        SELECT co2.company_name FROM contract_company_links l
        JOIN companies co2 ON co2.id=l.company_id
        WHERE l.contract_id=c.id ORDER BY l.id LIMIT 1
    ) co ON TRUE
    LEFT JOIN LATERAL (
        SELECT pe2.full_name FROM contract_person_links l
        JOIN persons pe2 ON pe2.id=l.person_id
        WHERE l.contract_id=c.id ORDER BY l.id LIMIT 1
    ) pe ON TRUE
    {_SIMILAR_COUNT_JOIN}
    WHERE c.review_status='pending'
    ORDER BY c.created_at
    """
)

HISTORY_SQL = text(
    """
    SELECT r.id, r.contract_id, c.contract_no, r.action,
           r.comment, r.created_at,
           u.display_name AS actor_name
    FROM contract_reviews r
    JOIN contracts c ON c.id = r.contract_id
    LEFT JOIN users u ON u.id = r.actor_user_id
    ORDER BY r.created_at DESC
    LIMIT 100
    """
)


@router.get("/reviews")
def get_reviews():
    with engine.connect() as cn:
        pending = cn.execute(PENDING_SQL).mappings().all()
        history = cn.execute(HISTORY_SQL).mappings().all()
    return {
        "pending": [dict(r) for r in pending],
        "history": [dict(r) for r in history],
    }


# 審査専用画面（1件）の要点を返す。一覧と同じ形に審査状況ラベルを加える。
DETAIL_SQL = text(
    f"""
    SELECT c.id, c.contract_no, c.contract_summary, c.contract_category,
           c.created_at, c.review_reason, c.review_status,
           cat.label AS category_label,
           rv.label  AS review_label,
           u.display_name AS assignee_name,
           co.company_name,
           pe.full_name AS person_name,
           COALESCE(sim.n, 0) AS similar_count
    FROM contracts c
    LEFT JOIN code_masters cat ON cat.category='contract_category' AND cat.code=c.contract_category
    LEFT JOIN code_masters rv  ON rv.category='review_status'      AND rv.code=c.review_status
    LEFT JOIN users u ON u.id=c.assignee_user_id
    LEFT JOIN LATERAL (
        SELECT co2.company_name FROM contract_company_links l
        JOIN companies co2 ON co2.id=l.company_id
        WHERE l.contract_id=c.id ORDER BY l.id LIMIT 1
    ) co ON TRUE
    LEFT JOIN LATERAL (
        SELECT pe2.full_name FROM contract_person_links l
        JOIN persons pe2 ON pe2.id=l.person_id
        WHERE l.contract_id=c.id ORDER BY l.id LIMIT 1
    ) pe ON TRUE
    {_SIMILAR_COUNT_JOIN}
    WHERE c.id = CAST(:id AS uuid)
    """
)


@router.get("/reviews/{contract_id}")
def get_review_detail(contract_id: str):
    with engine.connect() as cn:
        row = cn.execute(DETAIL_SQL, {"id": contract_id}).mappings().first()
    if not row:
        raise HTTPException(404, "対象の契約が見つかりません")
    return dict(row)


class ReviewActionIn(BaseModel):
    action: str
    comment: Optional[str] = None


INSERT_REVIEW_SQL = text(
    """
    INSERT INTO contract_reviews (contract_id, action, actor_user_id, comment)
    VALUES (CAST(:contract_id AS uuid), :action, CAST(:actor AS uuid), :comment)
    RETURNING id
    """
)

UPDATE_CONTRACT_REVIEW_SQL = text(
    """
    UPDATE contracts
       SET review_status = :status,
           review_reason = :reason,
           updated_at = now()
     WHERE id = CAST(:contract_id AS uuid)
    """
)


@router.post("/reviews/{contract_id}/action")
def post_review_action(
    contract_id: str,
    body: ReviewActionIn,
    user: CurrentUser = Depends(get_current_user),
):
    action = (body.action or "").strip()
    if action not in ACTION_TO_STATUS:
        raise HTTPException(422, "操作の種類が正しくありません（承認／差し戻し／否決 のいずれかを指定してください）")
    # 操作権（RBAC）を審査の種類ごとに判定：承認と、差し戻し・否決で別々の権限を要求する
    if action == "approved":
        ensure_can(user, "action.review.approve")
    else:  # returned / rejected
        ensure_can(user, "action.review.reject")
    comment = (body.comment or "").strip() or None
    if action in ("returned", "rejected") and not comment:
        raise HTTPException(422, "差し戻し・否決の場合は理由を入力してください")
    status = ACTION_TO_STATUS[action]
    with engine.begin() as cn:
        exists = cn.execute(
            text("SELECT 1 FROM contracts WHERE id = CAST(:id AS uuid)"),
            {"id": contract_id},
        ).first()
        if not exists:
            raise HTTPException(404, "対象の契約が見つかりません")
        new_id = cn.execute(
            INSERT_REVIEW_SQL,
            {"contract_id": contract_id, "action": action, "actor": REVIEWER_USER_ID, "comment": comment},
        ).scalar_one()
        cn.execute(
            UPDATE_CONTRACT_REVIEW_SQL,
            {"contract_id": contract_id, "status": status, "reason": comment},
        )
    return {"id": new_id, "review_status": status, "action": action}


# ===== 類似契約（重複チェック） =====
# 審査担当が承認する前に、会社と名義の両方、または外部管理番号が一致する既存契約を提示し、
# 二重登録でないかを確認（チェック）してもらうための機能。

_SIM_META_SQL = text(
    """
    SELECT c2.contract_no, c2.contract_summary,
           cat.label AS category_label,
           st.label  AS status_label,
           rv.label  AS review_label,
           c2.contract_status, c2.review_status,
           c2.created_at,
           co.company_name,
           pe.full_name AS person_name
    FROM contracts c2
    LEFT JOIN code_masters cat ON cat.category='contract_category' AND cat.code=c2.contract_category
    LEFT JOIN code_masters st  ON st.category='contract_status'    AND st.code=c2.contract_status
    LEFT JOIN code_masters rv  ON rv.category='review_status'      AND rv.code=c2.review_status
    LEFT JOIN LATERAL (
        SELECT co3.company_name FROM contract_company_links l
        JOIN companies co3 ON co3.id=l.company_id
        WHERE l.contract_id=c2.id ORDER BY l.id LIMIT 1
    ) co ON TRUE
    LEFT JOIN LATERAL (
        SELECT pe3.full_name FROM contract_person_links l
        JOIN persons pe3 ON pe3.id=l.person_id
        WHERE l.contract_id=c2.id ORDER BY l.id LIMIT 1
    ) pe ON TRUE
    WHERE c2.id = CAST(:cid AS uuid)
    """
)


SIMILAR_SQL = text(
    f"""
        SELECT c2.id, c2.contract_no, c2.contract_summary,
               cat.label AS category_label,
               st.label  AS status_label,
               rv.label  AS review_label,
               c2.review_status,
               c2.created_at,
               co.company_name,
               pe.full_name AS person_name,
               sim_match.same_company,
               sim_match.same_person,
               sim_match.same_identifier
        FROM contracts c
        JOIN contracts c2 ON c2.id <> c.id
        {_SIMILAR_FLAGS_JOIN}
        LEFT JOIN code_masters cat ON cat.category='contract_category' AND cat.code=c2.contract_category
        LEFT JOIN code_masters st  ON st.category='contract_status'    AND st.code=c2.contract_status
        LEFT JOIN code_masters rv  ON rv.category='review_status'      AND rv.code=c2.review_status
        LEFT JOIN LATERAL (
            SELECT co3.company_name FROM contract_company_links l
            JOIN companies co3 ON co3.id=l.company_id
            WHERE l.contract_id=c2.id ORDER BY l.id LIMIT 1
        ) co ON TRUE
        LEFT JOIN LATERAL (
            SELECT pe3.full_name FROM contract_person_links l
            JOIN persons pe3 ON pe3.id=l.person_id
            WHERE l.contract_id=c2.id ORDER BY l.id LIMIT 1
        ) pe ON TRUE
        WHERE c.id = CAST(:cid AS uuid) AND {_SIMILAR_CONDITION}
        ORDER BY c2.created_at DESC
        LIMIT 20
        """
)


def _similar_contracts(cn, contract_id: str):
    """会社と名義の両方、または外部管理番号が一致する他契約を返す。"""
    rows = cn.execute(SIMILAR_SQL, {"cid": contract_id}).mappings().all()
    out = []
    for r in rows:
        reasons = []
        if r["same_identifier"]:
            reasons.append("外部管理番号が一致")
        if r["same_company"]:
            reasons.append("会社が一致")
        if r["same_person"]:
            reasons.append("名義が一致")
        d = dict(r)
        d["id"] = str(d["id"])
        d["reasons"] = reasons
        out.append(d)
    return out


@router.get("/reviews/{contract_id}/similar")
def get_similar(contract_id: str):
    with engine.connect() as cn:
        base = cn.execute(_SIM_META_SQL, {"cid": contract_id}).mappings().first()
        if not base:
            raise HTTPException(404, "対象の契約が見つかりません")
        items = _similar_contracts(cn, contract_id)
    return {"base": dict(base), "items": items}
