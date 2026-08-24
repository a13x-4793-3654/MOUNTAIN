from fastapi import APIRouter, Depends
from sqlalchemy import text

from ..auth import CurrentUser, get_current_user
from ..db import engine

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("/me")
def me(user: CurrentUser = Depends(get_current_user)):
    """ログイン中のユーザー情報＋CTI内線（ソフトフォン自動登録に使用）を返す。"""
    return {
        "id": user.id,
        "display_name": user.display_name,
        "user_principal_name": user.user_principal_name,
        "mail": user.mail,
        "status": user.status,
        "is_admin": user.is_admin,
        "roles": user.roles,
        "permissions": user.permissions,
        "cti_ext_num": user.cti_ext_num,
        "cti_password": user.cti_password,
    }


@router.post("/login")
def login(user: CurrentUser = Depends(get_current_user)):
    """ログイン記録（最終サインイン日時を更新）。"""
    with engine.begin() as cn:
        cn.execute(
            text("UPDATE users SET last_signed_in_at = NOW() WHERE id = CAST(:id AS uuid)"),
            {"id": user.id},
        )
    return {"status": "ok"}
