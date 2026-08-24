"""CTIドライバの共通インターフェイスと、交換機に依らない共通処理（在席状況）。"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import text

from ..db import engine

# 自社代表番号（発信元）
OUR_NUMBER = "03-6000-0000"
# 認証は未実装のため、操作者は管理ユーザー固定（他ルーターと同じ既定）
OPERATOR_ID = "00000000-0000-0000-0000-000000000001"

# 在席状況（モックの PRES キーに対応）
VALID_PRESENCE = ("available", "busy", "dnd", "away")
PRESENCE_LABEL = {
    "available": "在席中",
    "busy": "取り込み中",
    "dnd": "通話中（応答不可）",
    "away": "離席中",
}

# 通話状態
ACTIVE_STATES = ("dialing", "connected", "held")


def norm(p: Optional[str]) -> str:
    """電話番号を数字のみに正規化（照合・重複判定用）。"""
    return "".join(ch for ch in (p or "") if ch.isdigit())


_GET_PRESENCE = text(
    "SELECT presence_status FROM user_presence WHERE user_id = CAST(:uid AS uuid)"
)
_UPSERT_PRESENCE = text(
    """
    INSERT INTO user_presence (user_id, presence_status, updated_at)
    VALUES (CAST(:uid AS uuid), :status, NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET presence_status = EXCLUDED.presence_status, updated_at = NOW()
    """
)


def _presence_dict(status: str) -> dict:
    return {"status": status, "label": PRESENCE_LABEL.get(status, status)}


def read_presence(user_id: str = OPERATOR_ID) -> dict:
    with engine.connect() as cn:
        row = cn.execute(_GET_PRESENCE, {"uid": user_id}).first()
    return _presence_dict(row[0] if row else "available")


def write_presence(status: str, user_id: str = OPERATOR_ID) -> dict:
    if status not in VALID_PRESENCE:
        raise HTTPException(422, "在席状況の値が不正です")
    with engine.begin() as cn:
        cn.execute(_UPSERT_PRESENCE, {"uid": user_id, "status": status})
    return _presence_dict(status)


class CTIProvider(ABC):
    """電話交換機ドライバの共通インターフェイス。

    telephony 系メソッド（発信・保留・転送・切電…）は実装ごとに異なるが、
    在席状況（プレゼンス）は交換機に依らずアプリ側のDBで保持する。
    """

    name = "base"

    # ---- 発信・通話操作（実装必須） ----
    @abstractmethod
    def originate(
        self,
        to_number: str,
        contact_name: Optional[str] = None,
        contract_id: Optional[str] = None,
        operator_id: str = OPERATOR_ID,
    ) -> dict:
        ...

    @abstractmethod
    def hold(self, call_uuid: str, operator_id: str = OPERATOR_ID) -> dict:
        ...

    @abstractmethod
    def unhold(self, call_uuid: str, operator_id: str = OPERATOR_ID) -> dict:
        ...

    @abstractmethod
    def send_dtmf(self, call_uuid: str, digit: str, operator_id: str = OPERATOR_ID) -> dict:
        ...

    @abstractmethod
    def transfer(self, call_uuid: str, destination: str, operator_id: str = OPERATOR_ID) -> dict:
        ...

    @abstractmethod
    def hangup(self, call_uuid: str, operator_id: str = OPERATOR_ID) -> dict:
        ...

    @abstractmethod
    def answer(self, call_uuid: str, operator_id: str = OPERATOR_ID) -> dict:
        ...

    @abstractmethod
    def get_active(self, operator_id: str = OPERATOR_ID) -> Optional[dict]:
        ...

    @abstractmethod
    def simulate_incoming(
        self,
        from_number: Optional[str] = None,
        contact_name: Optional[str] = None,
        contract_id: Optional[str] = None,
        operator_id: str = OPERATOR_ID,
    ) -> dict:
        ...

    # ---- 在席状況（共通実装。必要なら実装側で交換機へも反映） ----
    def get_presence(self, operator_id: str = OPERATOR_ID) -> dict:
        return read_presence(operator_id)

    def set_presence(self, status: str, operator_id: str = OPERATOR_ID) -> dict:
        return write_presence(status, operator_id)
