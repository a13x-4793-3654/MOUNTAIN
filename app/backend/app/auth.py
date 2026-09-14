"""
Microsoft 365 / Azure Entra ID ログイン（JWT 検証）。

OneCore の実装（operators/authentication.py）を FastAPI 向けに移植したもの。

フロー（auth_mode="entra"）:
  1. Authorization: Bearer <token> を取得
  2. Entra の JWKS で RS256 署名を検証（iss / aud / exp）
  3. groups クレームで ENTRA_GROUP_USERS 所属を確認
  4. oid クレームで users テーブルを検索（未登録かつ管理グループ所属なら自動登録）
  5. status==0（有効）を確認し、操作者（CurrentUser）として返す

auth_mode="dev" のときは検証を行わず、既定ユーザー（dev_user_id）で動作する。
Entra 登録が整うまで DF の画面を壊さず維持するためのフォールバック。
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import List, Optional

import httpx
import jwt
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import text

from .config import settings
from .db import engine


@dataclass
class CurrentUser:
    id: str
    display_name: str
    user_principal_name: str
    mail: Optional[str]
    status: int
    is_admin: bool
    roles: List[str] = field(default_factory=list)
    permissions: List[str] = field(default_factory=list)
    cti_ext_num: Optional[str] = None
    cti_password: Optional[str] = None


# ---- JWKS キャッシュ（プロセス内・TTL 1時間）----
_jwks_cache: dict = {}
_jwks_lock = threading.Lock()
_JWKS_TTL = 3600


def _get_jwks() -> dict:
    now = time.monotonic()
    with _jwks_lock:
        if _jwks_cache and now - _jwks_cache.get("_fetched_at", 0) < _JWKS_TTL:
            return _jwks_cache["keys"]
        tenant = settings.entra_tenant_id
        if not tenant:
            raise HTTPException(status_code=500, detail="ENTRA_TENANT_ID が設定されていません。")
        uri = f"https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys"
        try:
            resp = httpx.get(uri, timeout=10)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=503, detail="Entra ID との通信に失敗しました。") from exc
        jwks = resp.json()
        _jwks_cache["keys"] = jwks
        _jwks_cache["_fetched_at"] = now
        return jwks


def _verify_token(token: str) -> dict:
    tenant = settings.entra_tenant_id
    client_id = settings.entra_api_client_id
    if not tenant or not client_id:
        raise HTTPException(status_code=500, detail="Entra ID の設定が不足しています。")

    jwks = _get_jwks()
    try:
        keyset = jwt.PyJWKSet.from_dict(jwks).keys
        kid = jwt.get_unverified_header(token).get("kid")
        matched = next((k.key for k in keyset if k.key_id == kid), None)
        if matched is None:
            raise HTTPException(status_code=401, detail="トークンの署名キーが見つかりません。")
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="トークンの解析に失敗しました。") from exc

    issuers = [
        f"https://login.microsoftonline.com/{tenant}/v2.0",
        f"https://sts.windows.net/{tenant}/",
    ]
    audiences = [client_id, f"api://{client_id}"]
    for issuer in issuers:
        for aud in audiences:
            try:
                return jwt.decode(
                    token,
                    matched,
                    algorithms=["RS256"],
                    audience=aud,
                    issuer=issuer,
                    options={"require": ["exp", "iat", "iss", "aud"]},
                )
            except jwt.ExpiredSignatureError:
                raise HTTPException(status_code=401, detail="トークンの有効期限が切れています。")
            except (jwt.InvalidAudienceError, jwt.InvalidIssuerError):
                continue
            except jwt.PyJWTError:
                continue
    raise HTTPException(status_code=401, detail="トークンの検証に失敗しました。")


def check_group_membership(token: str, payload: dict, group_id: str) -> bool:
    """groups クレームで所属確認。多グループ省略時は Graph でフォールバック。"""
    if not group_id:
        return False
    groups = payload.get("groups")
    if groups is not None:
        return group_id in groups
    if "groups" in (payload.get("_claim_names") or {}):
        try:
            resp = httpx.get(
                f"https://graph.microsoft.com/v1.0/me/transitiveMemberOf/{group_id}/$ref",
                headers={"Authorization": f"******"},
                timeout=10,
            )
            return resp.status_code == 204
        except httpx.HTTPError:
            return False
    return False


def _claim_email(p: dict) -> str:
    oid = p.get("oid", "unknown")
    return (
        p.get("upn")
        or p.get("unique_name")
        or p.get("preferred_username")
        or p.get("email")
        or f"{oid}@unknown"
    )


def _claim_name(p: dict) -> str:
    oid = p.get("oid", "unknown")
    email_like = (
        p.get("upn") or p.get("unique_name") or p.get("preferred_username") or p.get("email") or ""
    )
    return p.get("name") or (email_like.split("@")[0] if email_like else "") or oid


def _user_group_ids(token: str, payload: dict) -> List[str]:
    """トークンの groups クレームから、利用者が所属する全グループの Object ID を取得する。
    グループ数が多くクレームが省略された場合は Graph の transitiveMemberOf で補完する。"""
    groups = payload.get("groups")
    if isinstance(groups, list):
        return [str(g) for g in groups]
    # 省略時（overage）：Graph でグループ一覧を取得
    if "groups" in (payload.get("_claim_names") or {}):
        ids: List[str] = []
        url = (
            "https://graph.microsoft.com/v1.0/me/transitiveMemberOf/microsoft.graph.group"
            "?$select=id&$top=999"
        )
        try:
            while url:
                resp = httpx.get(
                    url, headers={"Authorization": f"******"}, timeout=10
                )
                if resp.status_code != 200:
                    break
                body = resp.json()
                ids.extend(str(v["id"]) for v in body.get("value", []) if v.get("id"))
                url = body.get("@odata.nextLink")
        except (httpx.HTTPError, ValueError, KeyError):
            return ids
        return ids
    return []


def _sync_roles_from_groups(cn, user_id, group_ids: List[str]) -> None:
    """Entra セキュリティグループに紐づいたロールを、利用者に付与し直す（グループ由来を正とする）。"""
    role_ids: List[int] = []
    if group_ids:
        rows = cn.execute(
            text(
                "SELECT DISTINCT role_id FROM entra_group_role_maps "
                "WHERE entra_group_id = ANY(CAST(:gids AS uuid[]))"
            ),
            {"gids": group_ids},
        ).all()
        role_ids = [int(r.role_id) for r in rows]
    # グループ由来のロールで置き換える（サインインごとに最新化）
    cn.execute(text("DELETE FROM user_roles WHERE user_id = :uid"), {"uid": user_id})
    for rid in role_ids:
        cn.execute(
            text(
                "INSERT INTO user_roles (user_id, role_id) VALUES (:uid, :rid) "
                "ON CONFLICT DO NOTHING"
            ),
            {"uid": user_id, "rid": rid},
        )


def _load_role_keys(cn, user_id) -> List[str]:
    rows = cn.execute(
        text(
            "SELECT r.role_key FROM user_roles ur "
            "JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = :uid "
            "ORDER BY r.id"
        ),
        {"uid": user_id},
    ).all()
    return [r.role_key for r in rows]


def _load_permissions(cn, user_id) -> List[str]:
    """利用者の全ロールから、割り当てられた権限（画面・操作）キーの一覧を集約する。"""
    rows = cn.execute(
        text(
            "SELECT DISTINCT rp.perm_key FROM role_permissions rp "
            "JOIN user_roles ur ON ur.role_id = rp.role_id "
            "WHERE ur.user_id = :uid"
        ),
        {"uid": user_id},
    ).all()
    return [r.perm_key for r in rows]


def _row_to_user(
    row,
    is_admin: bool,
    roles: Optional[List[str]] = None,
    permissions: Optional[List[str]] = None,
) -> CurrentUser:
    return CurrentUser(
        id=str(row.id),
        display_name=row.display_name,
        user_principal_name=row.user_principal_name,
        mail=row.mail,
        status=int(row.status),
        is_admin=is_admin,
        roles=roles or [],
        permissions=permissions or [],
        cti_ext_num=row.cti_ext_num,
        cti_password=row.cti_password,
    )


_USER_SELECT = """
    SELECT id, display_name, user_principal_name, mail, status,
           cti_ext_num, cti_password
    FROM users
"""


def _admin_upn_set() -> set:
    return {u.strip().lower() for u in (settings.entra_admin_upns or "").split(",") if u.strip()}


def _resolve_entra_user(token: str, payload: dict) -> CurrentUser:
    oid = payload.get("oid")
    if not oid:
        raise HTTPException(status_code=401, detail="トークンに oid クレームがありません。")

    group_users = settings.entra_group_users
    if group_users and not check_group_membership(token, payload, group_users):
        raise HTTPException(
            status_code=403,
            detail="このシステムを利用する権限がありません。利用グループへの参加が必要です。",
        )

    # 管理者判定：管理グループ所属 または 管理UPNリストに一致
    is_admin = False
    if settings.entra_group_admins:
        is_admin = check_group_membership(token, payload, settings.entra_group_admins)
    upn = _claim_email(payload)
    if upn.lower() in _admin_upn_set():
        is_admin = True

    with engine.begin() as cn:
        row = cn.execute(
            text(_USER_SELECT + " WHERE entra_object_id = CAST(:oid AS uuid)"),
            {"oid": oid},
        ).first()

        if row is None:
            # 自動登録の可否：既定は許可（Azure側の割り当てで利用者を制御）。
            allow_new = settings.entra_auto_provision or is_admin or bool(group_users)
            if not allow_new:
                raise HTTPException(
                    status_code=403,
                    detail="システムに登録されていないユーザーのためログインできません。管理者にご連絡ください。",
                )
            row = cn.execute(
                text(
                    """
                    INSERT INTO users (entra_object_id, display_name, user_principal_name, mail, status)
                    VALUES (CAST(:oid AS uuid), :name, :upn, :mail, 0)
                    RETURNING id, display_name, user_principal_name, mail, status,
                              cti_ext_num, cti_password
                    """
                ),
                {"oid": oid, "name": _claim_name(payload), "upn": upn, "mail": upn},
            ).first()
        else:
            # 既存ユーザー：表示名・メール・最終サインインを更新（UPNは一意制約のため据え置き）。
            cn.execute(
                text(
                    "UPDATE users SET last_signed_in_at = NOW(), "
                    "display_name = :name, mail = :mail WHERE id = :id"
                ),
                {"id": row.id, "name": _claim_name(payload), "mail": upn},
            )

        # Entra セキュリティグループ → RBAC ロールをサインイン時に付与し直す
        group_ids = _user_group_ids(token, payload)
        _sync_roles_from_groups(cn, row.id, group_ids)
        roles = _load_role_keys(cn, row.id)
        permissions = _load_permissions(cn, row.id)

    # 管理者ロールを持っていれば管理者扱い（グループ／UPN 判定とあわせる）
    if "admin" in roles:
        is_admin = True

    if int(row.status) != 0:
        raise HTTPException(status_code=403, detail="アカウントが無効です。管理者にご連絡ください。")
    return _row_to_user(row, is_admin, roles, permissions)


def _resolve_dev_user() -> CurrentUser:
    with engine.connect() as cn:
        row = cn.execute(
            text(_USER_SELECT + " WHERE id = CAST(:id AS uuid)"),
            {"id": settings.dev_user_id},
        ).first()
        if row is None:
            raise HTTPException(status_code=500, detail="既定ユーザーが見つかりません。")
        roles = _load_role_keys(cn, row.id)
        permissions = _load_permissions(cn, row.id)
    return _row_to_user(row, is_admin=True, roles=roles, permissions=permissions)


def get_current_user(request: Request) -> CurrentUser:
    """FastAPI 依存性：現在の操作者を返す（entra モードでは未認証を 401 で拒否）。"""
    if settings.auth_mode != "entra":
        return _resolve_dev_user()

    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="ログインが必要です。",
            headers={"WWW-Authenticate": "Bearer"},
        )
    payload = _verify_token(header[len("Bearer "):])
    return _resolve_entra_user(header[len("Bearer "):], payload)


def require_admin(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="管理者権限が必要です。")
    return user


def require_role(*allowed: str):
    """指定ロールのいずれか（または管理者）を持つ利用者のみ許可する依存性を返す。"""

    def _dep(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if user.is_admin or any(r in user.roles for r in allowed):
            return user
        raise HTTPException(status_code=403, detail="この操作を行う権限がありません。")

    return _dep


# 書き込み系とみなす HTTP メソッド（読み取り=GET/HEAD/OPTIONS は画面アクセス権のみで許可）
_WRITE_METHODS = ("POST", "PUT", "PATCH", "DELETE")


def require_screen(*perm_keys: str):
    """指定した画面アクセス権のいずれか（または管理者）を持つ利用者のみ許可する依存性を返す。

    契約詳細のように複数のデータ源を束ねる画面のため、関連する画面権限を OR で受け付ける。
    """

    def _dep(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if user.is_admin or any(k in user.permissions for k in perm_keys):
            return user
        raise HTTPException(
            status_code=403,
            detail="この画面を表示する権限がありません。管理者にお問い合わせください。",
        )

    return _dep


def require_action(perm_key: str, methods: tuple = _WRITE_METHODS):
    """書き込み操作（既定：POST/PUT/PATCH/DELETE）に対して、指定の操作権限を要求する依存性を返す。

    読み取り（GET など）は画面アクセス権があれば通す。管理者は常に許可。
    """

    def _dep(request: Request, user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if request.method in methods and not (
            user.is_admin or perm_key in user.permissions
        ):
            raise HTTPException(
                status_code=403,
                detail="この操作を行う権限がありません。管理者にお問い合わせください。",
            )
        return user

    return _dep


def user_can(user: CurrentUser, perm_key: str) -> bool:
    """利用者が指定の権限を持つ（または管理者）かどうか。"""
    return bool(user.is_admin or perm_key in user.permissions)


def ensure_can(user: CurrentUser, perm_key: str) -> None:
    """権限が無ければ 403。エンドポイント内で個別に判定したいとき（審査の承認/却下など）に使う。"""
    if not user_can(user, perm_key):
        raise HTTPException(
            status_code=403,
            detail="この操作を行う権限がありません。管理者にお問い合わせください。",
        )


# =====================================================================
# 細分化された操作権限（RBAC）：書き込みAPIごとに必要な操作権を集中管理する。
# キー＝(HTTPメソッド, ルートパス※/api 込み) → 必要な権限キー。
# ここに無い書き込みAPIは画面アクセス権のみで許可（CTI 等の共通操作など）。
# 審査（POST /api/reviews/{contract_id}/action）は本文で承認/却下が分かれるため
# この表に入れず、エンドポイント内で ensure_can により判定する。
# =====================================================================
ACTION_MAP: dict = {
    # --- 契約 ---
    ("POST", "/api/contracts"): "action.contract.create",
    ("PUT", "/api/contracts/{contract_id}"): "action.contract.update",
    ("DELETE", "/api/contracts/{contract_id}"): "action.contract.delete",
    # 契約の関連付け（会社・名義・口座・外部番号・交渉履歴）
    ("POST", "/api/contracts/{contract_id}/company-links"): "action.contract.link",
    ("PUT", "/api/contract-company-links/{link_id}"): "action.contract.link",
    ("DELETE", "/api/contract-company-links/{link_id}"): "action.contract.link",
    ("POST", "/api/contracts/{contract_id}/person-links"): "action.contract.link",
    ("PUT", "/api/contract-person-links/{link_id}"): "action.contract.link",
    ("DELETE", "/api/contract-person-links/{link_id}"): "action.contract.link",
    ("POST", "/api/contracts/{contract_id}/account-links"): "action.contract.link",
    ("PUT", "/api/contract-account-links/{link_id}"): "action.contract.link",
    ("DELETE", "/api/contract-account-links/{link_id}"): "action.contract.link",
    ("POST", "/api/contracts/{contract_id}/identifiers"): "action.contract.link",
    ("PUT", "/api/identifiers/{ident_id}"): "action.contract.link",
    ("DELETE", "/api/identifiers/{ident_id}"): "action.contract.link",
    ("POST", "/api/contracts/{contract_id}/communications"): "action.contract.link",
    ("POST", "/api/communications/{comm_id}/calendar/retry"): "action.contract.link",
    ("PUT", "/api/communications/{comm_id}"): "action.contract.link",
    ("DELETE", "/api/communications/{comm_id}"): "action.contract.link",
    # --- 会社 ---
    ("POST", "/api/companies"): "action.company.manage",
    ("PUT", "/api/companies/{company_id}"): "action.company.manage",
    ("DELETE", "/api/companies/{company_id}"): "action.company.manage",
    ("POST", "/api/companies/{company_id}/phones"): "action.company.manage",
    ("PUT", "/api/company-phones/{phone_id}"): "action.company.manage",
    ("DELETE", "/api/company-phones/{phone_id}"): "action.company.manage",
    # --- 名義（個人）---
    ("POST", "/api/persons"): "action.person.manage",
    ("PUT", "/api/persons/{person_id}"): "action.person.manage",
    ("DELETE", "/api/persons/{person_id}"): "action.person.manage",
    # --- 口座・カード ---
    ("POST", "/api/accounts"): "action.account.manage",
    ("PUT", "/api/accounts/{account_id}"): "action.account.manage",
    ("DELETE", "/api/accounts/{account_id}"): "action.account.manage",
    # --- 請求・入金 ---
    ("POST", "/api/payments"): "action.billing.payment",
    ("PUT", "/api/payments/{payment_id}"): "action.billing.payment",
    ("DELETE", "/api/payments/{payment_id}"): "action.billing.payment",
    ("POST", "/api/contracts/{contract_id}/claims"): "action.billing.claim",
    ("PUT", "/api/claims/{claim_id}"): "action.billing.claim",
    ("DELETE", "/api/claims/{claim_id}"): "action.billing.claim",
    # --- 訴訟 ---
    ("POST", "/api/contracts/{contract_id}/lawsuits"): "action.litigation.manage",
    ("PUT", "/api/lawsuits/{lawsuit_id}"): "action.litigation.manage",
    ("DELETE", "/api/lawsuits/{lawsuit_id}"): "action.litigation.manage",
    ("POST", "/api/lawsuits/{lawsuit_id}/parties"): "action.litigation.manage",
    ("PUT", "/api/lawsuit-parties/{party_id}"): "action.litigation.manage",
    ("DELETE", "/api/lawsuit-parties/{party_id}"): "action.litigation.manage",
    ("POST", "/api/lawsuits/{lawsuit_id}/schedules"): "action.litigation.manage",
    ("PUT", "/api/lawsuit-schedules/{schedule_id}"): "action.litigation.manage",
    ("DELETE", "/api/lawsuit-schedules/{schedule_id}"): "action.litigation.manage",
    ("POST", "/api/lawsuits/{lawsuit_id}/documents"): "action.litigation.manage",
    ("PUT", "/api/lawsuit-documents/{document_id}"): "action.litigation.manage",
    ("DELETE", "/api/lawsuit-documents/{document_id}"): "action.litigation.manage",
    ("POST", "/api/lawsuits/{lawsuit_id}/memos"): "action.litigation.manage",
    ("PUT", "/api/lawsuit-memos/{memo_id}"): "action.litigation.manage",
    ("DELETE", "/api/lawsuit-memos/{memo_id}"): "action.litigation.manage",
    # --- ファイル ---
    ("POST", "/api/contracts/{contract_id}/files"): "action.file.manage",
    ("POST", "/api/contracts/{contract_id}/files/upload"): "action.file.manage",
    ("POST", "/api/files/{file_id}/content"): "action.file.manage",
    ("PUT", "/api/files/{file_id}"): "action.file.manage",
    ("DELETE", "/api/files/{file_id}"): "action.file.manage",
    # --- 原本管理 ---
    ("POST", "/api/originals"): "action.original.manage",
    ("PUT", "/api/originals/{doc_id}"): "action.original.manage",
    ("DELETE", "/api/originals/{doc_id}"): "action.original.manage",
    ("POST", "/api/originals/{doc_id}/lend"): "action.original.lend",
    ("POST", "/api/originals/{doc_id}/return"): "action.original.lend",
    ("POST", "/api/originals/{doc_id}/dispose"): "action.original.dispose",
    ("POST", "/api/storage-files"): "action.original.manage",
    ("PUT", "/api/storage-files/{file_id}"): "action.original.manage",
    ("DELETE", "/api/storage-files/{file_id}"): "action.original.manage",
    ("POST", "/api/storage-locations"): "action.original.manage",
    ("PUT", "/api/storage-locations/{loc_id}"): "action.original.manage",
    ("DELETE", "/api/storage-locations/{loc_id}"): "action.original.manage",
    # --- 差し込み印刷（テンプレート／実行）---
    ("POST", "/api/doc-templates"): "action.document.template",
    ("PUT", "/api/doc-templates/{tid}"): "action.document.template",
    ("DELETE", "/api/doc-templates/{tid}"): "action.document.template",
    ("POST", "/api/doc-merge/generate"): "action.document.generate",
    ("PUT", "/api/doc-generated/{gid}"): "action.document.generate",
    ("DELETE", "/api/doc-generated/{gid}"): "action.document.generate",
    # --- 家計簿 ---
    ("POST", "/api/household"): "action.household.manage",
    ("PUT", "/api/household/{entry_id}"): "action.household.manage",
    ("DELETE", "/api/household/{entry_id}"): "action.household.manage",
}


def enforce_action(request: Request, user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    """書き込みAPIに対して ACTION_MAP の権限を要求する集中ゲート（画面アクセス権とは別に判定）。

    - 読み取り（GET/HEAD/OPTIONS）や、表に無い書き込みAPIは素通し（画面アクセス権で管理）。
    - 管理者は常に許可。
    """
    if request.method not in _WRITE_METHODS or user.is_admin:
        return user
    route = request.scope.get("route")
    path = getattr(route, "path", None) or getattr(route, "path_format", None)
    if not path:
        return user
    perm = ACTION_MAP.get((request.method, path))
    if perm and perm not in user.permissions:
        raise HTTPException(
            status_code=403,
            detail="この操作を行う権限がありません。管理者にお問い合わせください。",
        )
    return user
