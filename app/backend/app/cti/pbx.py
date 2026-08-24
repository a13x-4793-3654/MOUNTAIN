"""本番PBXドライバ（実際の電話交換機と連携）。

DFのシミュレータと **同じインターフェイス** を実装する。実運用では本メソッド内で
交換機（Asterisk AMI / SIP / ベンダーAPI 等）へコマンドを送り、Webhook/イベントで
受け取った結果を（シミュレータと同じ）DBテーブルに記録する。

現時点では交換機が物理接続されていないため、telephony 系メソッドは接続設定
（CTI_PBX_*）の有無に応じて明確なエラーを返す。**在席状況はアプリ側で保持** するため
本番でも動作する。交換機を接続したら CTI_PBX_* を構成し、本ファイルの各メソッドに
実際の連携処理を実装するだけでよい（画面・API・DBは変更不要）。
"""
from __future__ import annotations

from typing import Optional

from fastapi import HTTPException

from ..config import settings
from .base import OPERATOR_ID, CTIProvider


class PbxProvider(CTIProvider):
    name = "pbx"

    @property
    def configured(self) -> bool:
        return bool((settings.cti_pbx_host or "").strip())

    def _telephony_guard(self) -> None:
        if not self.configured:
            raise HTTPException(
                503,
                "電話交換機（PBX）が未接続です。本番環境の接続設定（CTI_PBX_HOST など）を構成してください。",
            )
        # 接続設定はあるが、実際のPBX連携（AMI/SIP）は交換機接続時に有効化する
        raise HTTPException(
            501,
            "PBX接続設定は構成済みです。交換機連携（発着信・録音）の有効化は本番接続時に行います。",
        )

    def originate(
        self,
        to_number: str,
        contact_name: Optional[str] = None,
        contract_id: Optional[str] = None,
        operator_id: str = OPERATOR_ID,
    ) -> dict:
        self._telephony_guard()

    def hold(self, call_uuid: str, operator_id: str = OPERATOR_ID) -> dict:
        self._telephony_guard()

    def unhold(self, call_uuid: str, operator_id: str = OPERATOR_ID) -> dict:
        self._telephony_guard()

    def send_dtmf(self, call_uuid: str, digit: str, operator_id: str = OPERATOR_ID) -> dict:
        self._telephony_guard()

    def transfer(self, call_uuid: str, destination: str, operator_id: str = OPERATOR_ID) -> dict:
        self._telephony_guard()

    def hangup(self, call_uuid: str, operator_id: str = OPERATOR_ID) -> dict:
        self._telephony_guard()

    def answer(self, call_uuid: str, operator_id: str = OPERATOR_ID) -> dict:
        self._telephony_guard()

    def get_active(self, operator_id: str = OPERATOR_ID) -> Optional[dict]:
        # 交換機からのイベント連携が有効になるまではアクティブ通話なし
        return None

    def simulate_incoming(
        self,
        from_number: Optional[str] = None,
        contact_name: Optional[str] = None,
        contract_id: Optional[str] = None,
        operator_id: str = OPERATOR_ID,
    ) -> dict:
        raise HTTPException(400, "着信のシミュレートは検証環境（simulator）専用です。")
