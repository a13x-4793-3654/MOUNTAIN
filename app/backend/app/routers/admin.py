import re

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from ..config import settings
from ..db import engine
from ..mock_reset import get_status as mock_reset_status
from ..mock_reset import reset_mock_data

router = APIRouter(prefix="/api", tags=["admin"])

# 認証未実装のデモ環境のため、着信拒否の登録者は既定で管理者とする
ADMIN_USER_ID = "00000000-0000-0000-0000-000000000001"


def _norm_phone(v: str) -> str:
    return re.sub(r"\D", "", v or "")

USERS_SQL = text(
    """
    SELECT id, display_name, user_principal_name, mail, status,
           notify_channel, discord_user_id, discord_linked_at, last_signed_in_at,
           cti_ext_num,
           (cti_password IS NOT NULL AND cti_password <> '') AS has_cti_password
    FROM users
    ORDER BY display_name
    """
)

MASTERS_SQL = text(
    """
    SELECT id, category, code, label, sort_order, is_active
    FROM code_masters
    ORDER BY category, sort_order, code
    """
)

DENY_SQL = text(
    """
    SELECT d.id, d.phone_number, d.reason_code, d.reason_note, d.is_active,
           d.approval_status, d.reject_note, d.requested_at, d.approved_at,
           d.created_at, d.company_id, co.company_name,
           u.display_name AS created_by_name,
           ap.display_name AS approved_by_name
    FROM call_deny_list d
    LEFT JOIN companies co ON co.id = d.company_id
    LEFT JOIN users u ON u.id = d.created_by
    LEFT JOIN users ap ON ap.id = d.approved_by
    ORDER BY d.approval_status, d.is_active DESC, d.created_at DESC
    """
)

AUDIT_SQL = text(
    """
    SELECT a.id, a.entity_type, a.entity_id, a.action, a.before_json, a.after_json,
           a.acted_at, u.display_name AS actor_name
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_user_id
    ORDER BY a.acted_at DESC
    LIMIT 100
    """
)

NOTIF_SQL = text(
    """
    SELECT id, notification_type, payload_json, posted_at, status, created_at
    FROM teams_notifications
    ORDER BY COALESCE(posted_at, created_at) DESC
    LIMIT 100
    """
)

ROLES_SQL = text(
    """
    SELECT r.id, r.role_key, r.role_name, r.description, r.is_builtin,
           (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS user_count,
           COALESCE(
               (SELECT array_agg(rp.perm_key ORDER BY rp.perm_key)
                  FROM role_permissions rp WHERE rp.role_id = r.id),
               ARRAY[]::text[]
           ) AS permissions
    FROM roles r
    ORDER BY r.is_builtin DESC, r.id
    """
)

PERMISSIONS_SQL = text(
    """
    SELECT perm_key, perm_name, category, sort_order
    FROM permissions
    ORDER BY category, sort_order, perm_key
    """
)

GROUP_MAPS_SQL = text(
    """
    SELECT m.entra_group_id, m.entra_group_name, m.role_id,
           r.role_key, r.role_name
    FROM entra_group_role_maps m
    JOIN roles r ON r.id = m.role_id
    ORDER BY m.entra_group_name NULLS LAST, m.entra_group_id, r.id
    """
)


@router.get("/admin")
def get_admin():
    with engine.connect() as cn:
        users = cn.execute(USERS_SQL).mappings().all()
        masters = cn.execute(MASTERS_SQL).mappings().all()
        deny = cn.execute(DENY_SQL).mappings().all()
        audit = cn.execute(AUDIT_SQL).mappings().all()
        notif = cn.execute(NOTIF_SQL).mappings().all()
        roles = cn.execute(ROLES_SQL).mappings().all()
        permissions = cn.execute(PERMISSIONS_SQL).mappings().all()
        group_maps = cn.execute(GROUP_MAPS_SQL).mappings().all()
    return {
        "users": [dict(r) for r in users],
        "code_masters": [dict(r) for r in masters],
        "deny_list": [dict(r) for r in deny],
        "audit": [dict(r) for r in audit],
        "notifications": [dict(r) for r in notif],
        "roles": [dict(r) for r in roles],
        "permissions": [dict(r) for r in permissions],
        "group_role_maps": [dict(r) for r in group_maps],
        "mock_reset": mock_reset_status(),
    }


# ============================================================
#  着信拒否リスト（申請 → 承認／却下 → 解除・編集・削除）
#  approval_status: '1'=申請中 / '2'=承認済 / '3'=却下
#  is_active: 現在その番号を実際に拒否しているか（承認かつ有効のときTRUE）
# ============================================================


class DenyIn(BaseModel):
    phone_number: str
    reason_code: str
    reason_note: str | None = None
    company_id: str | None = None


class RejectIn(BaseModel):
    note: str | None = None


INSERT_DENY_SQL = text(
    """
    INSERT INTO call_deny_list
        (phone_number, phone_number_normalized, company_id, reason_code, reason_note,
         approval_status, is_active, requested_by, requested_at, created_by)
    VALUES
        (:phone_number, :normalized, CAST(:company_id AS uuid), :reason_code, :reason_note,
         '1', FALSE, CAST(:actor AS uuid), NOW(), CAST(:actor AS uuid))
    RETURNING id
    """
)


def _deny_reason_ok(code: str) -> None:
    if code not in ("1", "2", "3"):
        raise HTTPException(422, "拒否理由を選択してください（総合的判断／間違い電話／一時的）")


@router.post("/deny")
def post_deny(body: DenyIn):
    """着信拒否を申請する（承認待ち・まだ拒否は有効化されない）"""
    _deny_reason_ok(body.reason_code)
    phone = (body.phone_number or "").strip()
    normalized = _norm_phone(phone)
    if not normalized:
        raise HTTPException(422, "電話番号を入力してください")
    params = {
        "phone_number": phone,
        "normalized": normalized,
        "company_id": (body.company_id or "").strip() or None,
        "reason_code": body.reason_code,
        "reason_note": (body.reason_note or "").strip() or None,
        "actor": ADMIN_USER_ID,
    }
    with engine.begin() as cn:
        new_id = cn.execute(INSERT_DENY_SQL, params).scalar_one()
    return {"id": new_id}


@router.put("/deny/{deny_id}")
def edit_deny(deny_id: int, body: DenyIn):
    """着信拒否の内容（番号・理由・補足・会社）を編集する"""
    _deny_reason_ok(body.reason_code)
    phone = (body.phone_number or "").strip()
    normalized = _norm_phone(phone)
    if not normalized:
        raise HTTPException(422, "電話番号を入力してください")
    params = {
        "id": deny_id,
        "phone_number": phone,
        "normalized": normalized,
        "company_id": (body.company_id or "").strip() or None,
        "reason_code": body.reason_code,
        "reason_note": (body.reason_note or "").strip() or None,
    }
    with engine.begin() as cn:
        res = cn.execute(
            text(
                """
                UPDATE call_deny_list
                SET phone_number = :phone_number,
                    phone_number_normalized = :normalized,
                    company_id = CAST(:company_id AS uuid),
                    reason_code = :reason_code,
                    reason_note = :reason_note
                WHERE id = :id
                """
            ),
            params,
        )
        if res.rowcount == 0:
            raise HTTPException(404, "対象の着信拒否設定が見つかりません")
    return {"ok": True}


@router.post("/deny/{deny_id}/approve")
def approve_deny(deny_id: int):
    """申請を承認し、着信拒否を有効化する"""
    with engine.begin() as cn:
        res = cn.execute(
            text(
                """
                UPDATE call_deny_list
                SET approval_status = '2', is_active = TRUE,
                    approved_by = CAST(:actor AS uuid), approved_at = NOW(),
                    reject_note = NULL
                WHERE id = :id
                """
            ),
            {"id": deny_id, "actor": ADMIN_USER_ID},
        )
        if res.rowcount == 0:
            raise HTTPException(404, "対象の着信拒否設定が見つかりません")
    return {"ok": True}


@router.post("/deny/{deny_id}/reject")
def reject_deny(deny_id: int, body: RejectIn):
    """申請を却下する（拒否は有効化されない）"""
    with engine.begin() as cn:
        res = cn.execute(
            text(
                """
                UPDATE call_deny_list
                SET approval_status = '3', is_active = FALSE,
                    approved_by = CAST(:actor AS uuid), approved_at = NOW(),
                    reject_note = :note
                WHERE id = :id
                """
            ),
            {"id": deny_id, "actor": ADMIN_USER_ID, "note": (body.note or "").strip() or None},
        )
        if res.rowcount == 0:
            raise HTTPException(404, "対象の着信拒否設定が見つかりません")
    return {"ok": True}


@router.post("/deny/{deny_id}/lift")
def lift_deny(deny_id: int):
    """承認済みの着信拒否を解除する（履歴は残す）"""
    with engine.begin() as cn:
        res = cn.execute(
            text("UPDATE call_deny_list SET is_active = FALSE WHERE id = :id"),
            {"id": deny_id},
        )
        if res.rowcount == 0:
            raise HTTPException(404, "対象の着信拒否設定が見つかりません")
    return {"ok": True}


@router.delete("/deny/{deny_id}")
def delete_deny(deny_id: int):
    """着信拒否の記録を削除する"""
    with engine.begin() as cn:
        res = cn.execute(
            text("DELETE FROM call_deny_list WHERE id = :id"),
            {"id": deny_id},
        )
        if res.rowcount == 0:
            raise HTTPException(404, "対象の着信拒否設定が見つかりません")
    return {"ok": True}


# ============================================================
#  ユーザー管理（新規・編集・削除）
#  status: 0=有効 / 1=停止 / 2=退職
#  entra_object_id は必須(UNIQUE)のため作成時に自動採番する
# ============================================================


class UserIn(BaseModel):
    display_name: str
    user_principal_name: str
    mail: str | None = None
    status: int = 0
    # CTI 内線（ソフトフォン用）。管理者が各担当へFreePBX内線を割り当てる。
    cti_ext_num: str | None = None
    cti_password: str | None = None


def _user_validate(body: UserIn) -> dict:
    name = (body.display_name or "").strip()
    upn = (body.user_principal_name or "").strip()
    if not name:
        raise HTTPException(422, "氏名を入力してください")
    if not upn:
        raise HTTPException(422, "ユーザー名（UPN）を入力してください")
    if body.status not in (0, 1, 2):
        raise HTTPException(422, "状態を選択してください（有効／停止／退職）")
    return {
        "display_name": name,
        "upn": upn,
        "mail": (body.mail or "").strip() or None,
        "status": body.status,
        "cti_ext_num": (body.cti_ext_num or "").strip() or None,
        "cti_password": (body.cti_password or "").strip() or None,
    }


@router.post("/admin/users")
def create_user(body: UserIn):
    params = _user_validate(body)
    try:
        with engine.begin() as cn:
            new_id = cn.execute(
                text(
                    """
                    INSERT INTO users
                        (entra_object_id, display_name, user_principal_name, mail,
                         status, notify_channel, cti_ext_num, cti_password)
                    VALUES
                        (gen_random_uuid(), :display_name, :upn, :mail,
                         :status, 'teams', :cti_ext_num, :cti_password)
                    RETURNING id
                    """
                ),
                params,
            ).scalar_one()
    except IntegrityError:
        raise HTTPException(409, "このユーザー名（UPN）は既に登録されています")
    return {"id": str(new_id)}


@router.put("/admin/users/{user_id}")
def update_user(user_id: str, body: UserIn):
    params = _user_validate(body)
    params["id"] = user_id
    try:
        with engine.begin() as cn:
            res = cn.execute(
                text(
                    """
                    UPDATE users
                    SET display_name = :display_name,
                        user_principal_name = :upn,
                        mail = :mail,
                        status = :status,
                        cti_ext_num = :cti_ext_num,
                        cti_password = COALESCE(:cti_password, cti_password),
                        updated_at = NOW()
                    WHERE id = CAST(:id AS uuid)
                    """
                ),
                params,
            )
    except IntegrityError:
        raise HTTPException(409, "このユーザー名（UPN）は既に登録されています")
    if res.rowcount == 0:
        raise HTTPException(404, "対象のユーザーが見つかりません")
    return {"ok": True}


@router.delete("/admin/users/{user_id}")
def delete_user(user_id: str):
    try:
        with engine.begin() as cn:
            res = cn.execute(
                text("DELETE FROM users WHERE id = CAST(:id AS uuid)"),
                {"id": user_id},
            )
    except IntegrityError:
        raise HTTPException(
            409,
            "このユーザーは契約や履歴に紐づいているため削除できません。状態を「退職」にしてください。",
        )
    if res.rowcount == 0:
        raise HTTPException(404, "対象のユーザーが見つかりません")
    return {"ok": True}


# ============================================================
#  コードマスタ（分類・区分）の管理（追加・編集・削除）
#  category はアプリ内で使う分類キー。想定外のキーは受け付けない。
# ============================================================

MASTER_CATEGORIES = {
    "contract_category",
    "contract_status",
    "review_status",
    "link_category",
    "contract_flag",
}


class MasterIn(BaseModel):
    category: str
    code: str
    label: str
    sort_order: int = 0
    is_active: bool = True


def _master_validate(body: MasterIn) -> dict:
    category = (body.category or "").strip()
    code = (body.code or "").strip()
    label = (body.label or "").strip()
    if category not in MASTER_CATEGORIES:
        raise HTTPException(422, "分類の種別を選択してください")
    if not code:
        raise HTTPException(422, "コード（英数字の識別子）を入力してください")
    if not label:
        raise HTTPException(422, "表示名を入力してください")
    return {
        "category": category,
        "code": code,
        "label": label,
        "sort_order": int(body.sort_order or 0),
        "is_active": bool(body.is_active),
    }


@router.post("/admin/masters")
def create_master(body: MasterIn):
    """分類・区分（コードマスタ）を追加する"""
    params = _master_validate(body)
    try:
        with engine.begin() as cn:
            new_id = cn.execute(
                text(
                    """
                    INSERT INTO code_masters (category, code, label, sort_order, is_active)
                    VALUES (:category, :code, :label, :sort_order, :is_active)
                    RETURNING id
                    """
                ),
                params,
            ).scalar_one()
    except IntegrityError:
        raise HTTPException(409, "同じ分類の中に、そのコードは既に登録されています")
    return {"id": int(new_id)}


@router.put("/admin/masters/{master_id}")
def update_master(master_id: int, body: MasterIn):
    """分類・区分の内容（表示名・並び順・有効/無効など）を編集する"""
    params = _master_validate(body)
    params["id"] = master_id
    try:
        with engine.begin() as cn:
            res = cn.execute(
                text(
                    """
                    UPDATE code_masters
                    SET category = :category, code = :code, label = :label,
                        sort_order = :sort_order, is_active = :is_active
                    WHERE id = :id
                    """
                ),
                params,
            )
    except IntegrityError:
        raise HTTPException(409, "同じ分類の中に、そのコードは既に登録されています")
    if res.rowcount == 0:
        raise HTTPException(404, "対象の分類が見つかりません")
    return {"ok": True}


@router.delete("/admin/masters/{master_id}")
def delete_master(master_id: int):
    """分類・区分を削除する（すでに設定済みの契約などのデータには影響しない）"""
    with engine.begin() as cn:
        res = cn.execute(
            text("DELETE FROM code_masters WHERE id = :id"),
            {"id": master_id},
        )
        if res.rowcount == 0:
            raise HTTPException(404, "対象の分類が見つかりません")
    return {"ok": True}


# ============================================================
#  ロール・権限（RBAC）：Entra セキュリティグループ → ロール の対応管理
#  サインイン時に、利用者が所属するグループに紐づくロールが自動付与される。
# ============================================================

import uuid as _uuid


class GroupRoleMapIn(BaseModel):
    entra_group_id: str
    entra_group_name: str | None = None
    role_id: int


class GroupRenameIn(BaseModel):
    entra_group_name: str | None = None


def _valid_group_id(v: str) -> str:
    s = (v or "").strip()
    try:
        return str(_uuid.UUID(s))
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(422, "セキュリティグループの ID（GUID）の形式が正しくありません")


@router.post("/admin/group-role-maps")
def create_group_role_map(body: GroupRoleMapIn):
    """Entra セキュリティグループとロールの対応を追加する"""
    gid = _valid_group_id(body.entra_group_id)
    name = (body.entra_group_name or "").strip() or None
    with engine.begin() as cn:
        role = cn.execute(
            text("SELECT 1 FROM roles WHERE id = :rid"), {"rid": body.role_id}
        ).first()
        if role is None:
            raise HTTPException(422, "ロールを選択してください")
        try:
            cn.execute(
                text(
                    """
                    INSERT INTO entra_group_role_maps (entra_group_id, entra_group_name, role_id)
                    VALUES (CAST(:gid AS uuid), :name, :rid)
                    """
                ),
                {"gid": gid, "name": name, "rid": body.role_id},
            )
        except IntegrityError:
            raise HTTPException(409, "このグループには、そのロールがすでに割り当てられています")
    return {"ok": True}


@router.put("/admin/group-role-maps/{entra_group_id}")
def rename_group_role_map(entra_group_id: str, body: GroupRenameIn):
    """グループの表示名（分かりやすい名前）をまとめて変更する"""
    gid = _valid_group_id(entra_group_id)
    name = (body.entra_group_name or "").strip() or None
    with engine.begin() as cn:
        res = cn.execute(
            text(
                "UPDATE entra_group_role_maps SET entra_group_name = :name "
                "WHERE entra_group_id = CAST(:gid AS uuid)"
            ),
            {"gid": gid, "name": name},
        )
    if res.rowcount == 0:
        raise HTTPException(404, "対象のグループが見つかりません")
    return {"ok": True}


@router.delete("/admin/group-role-maps/{entra_group_id}/{role_id}")
def delete_group_role_map(entra_group_id: str, role_id: int):
    """Entra セキュリティグループとロールの対応を1件解除する"""
    gid = _valid_group_id(entra_group_id)
    with engine.begin() as cn:
        res = cn.execute(
            text(
                "DELETE FROM entra_group_role_maps "
                "WHERE entra_group_id = CAST(:gid AS uuid) AND role_id = :rid"
            ),
            {"gid": gid, "rid": role_id},
        )
    if res.rowcount == 0:
        raise HTTPException(404, "対象の対応が見つかりません")
    return {"ok": True}


# ============================================================
#  ロール（RBAC）：カスタムロールの作成・編集・削除＋権限（画面/操作）の割り当て
#  標準ロール（is_builtin=true）は削除・role_key 変更を不可とし、名前・説明・権限は編集可。
# ============================================================

_ROLE_KEY_RE = re.compile(r"^[a-z][a-z0-9_.-]{1,49}$")


class RoleIn(BaseModel):
    role_key: str | None = None          # 作成時のみ使用（英小文字で始まる識別子）
    role_name: str
    description: str | None = None
    permissions: list[str] = []          # 割り当てる権限キー（画面/操作）


def _validate_perm_keys(cn, keys) -> list:
    """重複を除いたうえで、実在する権限キーだけに絞る（存在しないキーがあれば 422）。"""
    uniq = list(dict.fromkeys([k.strip() for k in (keys or []) if k and k.strip()]))
    if not uniq:
        return []
    rows = cn.execute(
        text("SELECT perm_key FROM permissions WHERE perm_key = ANY(:keys)"),
        {"keys": uniq},
    ).all()
    found = {r.perm_key for r in rows}
    missing = [k for k in uniq if k not in found]
    if missing:
        raise HTTPException(422, "存在しない権限が含まれています：" + ", ".join(missing))
    return uniq


def _set_role_permissions(cn, role_id: int, keys) -> None:
    cn.execute(text("DELETE FROM role_permissions WHERE role_id = :rid"), {"rid": role_id})
    for k in keys:
        cn.execute(
            text("INSERT INTO role_permissions (role_id, perm_key) VALUES (:rid, :k)"),
            {"rid": role_id, "k": k},
        )


@router.post("/admin/roles")
def create_role(body: RoleIn):
    """カスタムロールを新規作成する（権限もあわせて設定）"""
    key = (body.role_key or "").strip().lower()
    if not _ROLE_KEY_RE.match(key):
        raise HTTPException(
            422,
            "ロールID は英小文字で始まる 2〜50 文字（英小文字・数字・_ . -）で入力してください",
        )
    name = (body.role_name or "").strip()
    if not name:
        raise HTTPException(422, "ロール名を入力してください")
    with engine.begin() as cn:
        keys = _validate_perm_keys(cn, body.permissions)
        try:
            row = cn.execute(
                text(
                    """
                    INSERT INTO roles (role_key, role_name, description, is_builtin)
                    VALUES (:key, :name, :desc, FALSE)
                    RETURNING id
                    """
                ),
                {"key": key, "name": name, "desc": (body.description or "").strip() or None},
            ).first()
        except IntegrityError:
            raise HTTPException(409, "同じロールID がすでに存在します")
        _set_role_permissions(cn, row.id, keys)
    return {"ok": True, "id": row.id}


@router.put("/admin/roles/{role_id}")
def update_role(role_id: int, body: RoleIn):
    """ロールの名前・説明・権限を更新する（標準ロールも権限の調整は可能。role_key は変更不可）"""
    name = (body.role_name or "").strip()
    if not name:
        raise HTTPException(422, "ロール名を入力してください")
    with engine.begin() as cn:
        role = cn.execute(text("SELECT id FROM roles WHERE id = :id"), {"id": role_id}).first()
        if role is None:
            raise HTTPException(404, "対象のロールが見つかりません")
        keys = _validate_perm_keys(cn, body.permissions)
        cn.execute(
            text("UPDATE roles SET role_name = :name, description = :desc WHERE id = :id"),
            {"id": role_id, "name": name, "desc": (body.description or "").strip() or None},
        )
        _set_role_permissions(cn, role_id, keys)
    return {"ok": True}


@router.delete("/admin/roles/{role_id}")
def delete_role(role_id: int):
    """カスタムロールを削除する（標準ロールは削除不可）。割り当て済みの利用者・グループ対応も自動で解除される。"""
    with engine.begin() as cn:
        role = cn.execute(
            text("SELECT is_builtin FROM roles WHERE id = :id"), {"id": role_id}
        ).first()
        if role is None:
            raise HTTPException(404, "対象のロールが見つかりません")
        if role.is_builtin:
            raise HTTPException(409, "標準ロールは削除できません")
        cn.execute(text("DELETE FROM roles WHERE id = :id"), {"id": role_id})
    return {"ok": True}


# ============================================================
#  モックデータの自動初期化（DF専用機能）
#  MOCK_RESET_ENABLED=true のときだけ有効。本番は無効（404）。
#  毎日決まった時刻に自動実行されるが、ここでは手動実行も提供する。
# ============================================================


@router.get("/admin/mock-reset/status")
def get_mock_reset_status():
    """初期化機能の状態（有効か／次回実行予定／直近の実行結果）を返す。"""
    return mock_reset_status()


@router.post("/admin/mock-reset")
async def run_mock_reset_now():
    """いますぐモックデータを初期状態へ戻す（管理者・DFのみ）。"""
    if not settings.mock_reset_enabled:
        raise HTTPException(404, "この環境ではモックデータの初期化は無効です。")
    try:
        # ブロッキング処理（psql）はスレッドに逃がす。
        return await run_in_threadpool(reset_mock_data, "manual")
    except RuntimeError as e:
        raise HTTPException(409, str(e))
