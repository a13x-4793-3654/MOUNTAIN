"""シミュレータ・ドライバ（DF既定）。

実際の電話交換機の代わりに、発信→接続→保留/転送/プッシュ→切電 の状態遷移を
サーバ側で再現する。記録（通話履歴・操作ログ・録音有無）は **本物のDB** に残るため、
本番PBXドライバに切り替えても画面・データ構造はそのまま使える。

スレッドやタイマーは使わず、開始時刻からの経過秒で状態を導出する（HTTPの読み取り時に
「発信中→通話中」へ自動遷移）。単一オペレーター前提で、同時アクティブ通話は1件。
"""
from __future__ import annotations

import random
import secrets
from datetime import datetime
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import text

from ..config import settings
from ..db import engine
from .base import ACTIVE_STATES, OPERATOR_ID, OUR_NUMBER, CTIProvider, norm

_DEMO_INBOUND = [
    ("090-1234-5678", "田中 太郎"),
    ("080-5555-1212", ""),
    ("06-2345-6789", "さくら商事株式会社"),
    ("03-1111-2222", ""),
]

_STATE_LABEL = {"dialing": "発信中…", "connected": "通話中", "held": "保留中"}

_ACTIVE_SQL = text(
    """
    SELECT ch.id, ch.call_id, ch.direction, ch.from_number, ch.to_number,
           ch.contact_name, ch.call_status,
           GREATEST(0, EXTRACT(EPOCH FROM (NOW() - ch.started_at))::int) AS elapsed,
           c.id AS contract_id, c.contract_no
    FROM call_histories ch
    LEFT JOIN contracts c ON c.id = ch.linked_contract_id
    WHERE ch.operator_user_id = CAST(:uid AS uuid)
      AND ch.call_status IN ('dialing','connected','held')
    ORDER BY ch.started_at DESC
    LIMIT 1
    """
)

_REQUIRE_SQL = text(
    """
    SELECT id, call_id, direction, from_number, to_number, contact_name, call_status,
           GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::int) AS elapsed
    FROM call_histories
    WHERE id = CAST(:id AS uuid)
      AND operator_user_id = CAST(:uid AS uuid)
      AND call_status IN ('dialing','connected','held')
    """
)

_INSERT_CALL = text(
    """
    INSERT INTO call_histories
        (call_id, direction, from_number, from_number_normalized,
         to_number, to_number_normalized, started_at, call_status,
         provider, has_recording, operator_user_id, contact_name, linked_contract_id)
    VALUES
        (:call_id, :direction, :from_number, :from_norm,
         :to_number, :to_norm, NOW(), :status,
         :provider, FALSE, CAST(:uid AS uuid), :contact_name,
         CAST(:contract_id AS uuid))
    RETURNING id
    """
)

_ADD_OP = text(
    """
    INSERT INTO call_operation_logs
        (call_history_id, seq_no, offset_seconds, operation_type, detail, operated_by, operated_at)
    VALUES (
        CAST(:id AS uuid),
        (SELECT COALESCE(MAX(seq_no),0)+1 FROM call_operation_logs WHERE call_history_id = CAST(:id AS uuid)),
        (SELECT GREATEST(0, EXTRACT(EPOCH FROM (NOW()-started_at))::int) FROM call_histories WHERE id = CAST(:id AS uuid)),
        :otype, :detail, CAST(:uid AS uuid), NOW()
    )
    """
)

_SET_STATUS = text(
    "UPDATE call_histories SET call_status = :status WHERE id = CAST(:id AS uuid)"
)

_FINALIZE = text(
    """
    UPDATE call_histories SET
        ended_at = NOW(),
        duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (NOW()-started_at))::int),
        call_status = 'ended',
        call_result = :result,
        has_recording = :rec,
        recording_file = CASE WHEN :rec THEN 'recordings/'||call_id||'.mp3' ELSE recording_file END
    WHERE id = CAST(:id AS uuid)
    """
)


def _gen_call_id() -> str:
    return "CALL-%s-%s" % (
        datetime.now().strftime("%Y%m%d-%H%M%S"),
        secrets.token_hex(2),
    )


class SimulatorProvider(CTIProvider):
    name = "simulator"

    @property
    def ring_seconds(self) -> int:
        return max(0, int(settings.cti_ring_seconds or 0))

    # ---- 直列化 ----
    def _serialize(self, row) -> dict:
        status = row["call_status"]
        direction = row["direction"]
        connected = status in ("connected", "held")
        is_incoming = status == "dialing" and direction == "in"
        number = row["to_number"] if direction == "out" else row["from_number"]
        if status == "dialing":
            state_label = "着信中" if direction == "in" else "発信中…"
        else:
            state_label = _STATE_LABEL.get(status, status)
        return {
            "id": str(row["id"]),
            "call_id": row["call_id"],
            "direction": row["direction"],
            "number": number,
            "contact_name": row["contact_name"],
            "contract_id": str(row["contract_id"]) if row.get("contract_id") else None,
            "contract_no": row.get("contract_no"),
            "status": status,
            "is_connected": connected,
            "is_incoming": is_incoming,
            "is_on_hold": status == "held",
            "elapsed_seconds": int(row["elapsed"] or 0),
            "state_label": state_label,
            "provider": self.name,
        }

    def _add_op(self, cn, call_uuid: str, otype: str, detail: str, operator_id: str) -> None:
        cn.execute(
            _ADD_OP,
            {"id": call_uuid, "otype": otype, "detail": detail, "uid": operator_id},
        )

    # ---- 発信 ----
    def originate(
        self,
        to_number: str,
        contact_name: Optional[str] = None,
        contract_id: Optional[str] = None,
        operator_id: str = OPERATOR_ID,
    ) -> dict:
        num = (to_number or "").strip()
        if not num:
            raise HTTPException(422, "電話番号を入力してください")
        with engine.begin() as cn:
            if cn.execute(_ACTIVE_SQL, {"uid": operator_id}).mappings().first():
                raise HTTPException(409, "すでに通話中です。先に切電してください")
            call_id = _gen_call_id()
            new_id = cn.execute(
                _INSERT_CALL,
                {
                    "call_id": call_id,
                    "direction": "out",
                    "from_number": OUR_NUMBER,
                    "from_norm": norm(OUR_NUMBER),
                    "to_number": num,
                    "to_norm": norm(num),
                    "status": "dialing",
                    "provider": self.name,
                    "uid": operator_id,
                    "contact_name": (contact_name or "").strip() or None,
                    "contract_id": (contract_id or "").strip() or None,
                },
            ).scalar_one()
            self._add_op(cn, str(new_id), "start", "発信を開始", operator_id)
            row = cn.execute(_ACTIVE_SQL, {"uid": operator_id}).mappings().first()
        # 発信したら在席状況は自動で「取り込み中」
        self.set_presence("busy", operator_id)
        return self._serialize(row)

    # ---- アクティブ通話の取得（発信中→通話中の自動遷移つき） ----
    def get_active(self, operator_id: str = OPERATOR_ID) -> Optional[dict]:
        with engine.begin() as cn:
            row = cn.execute(_ACTIVE_SQL, {"uid": operator_id}).mappings().first()
            if row is None:
                return None
            if (
                row["call_status"] == "dialing"
                and row["direction"] == "out"
                and int(row["elapsed"] or 0) >= self.ring_seconds
            ):
                cn.execute(_SET_STATUS, {"id": str(row["id"]), "status": "connected"})
                self._add_op(cn, str(row["id"]), "connected", "通話がつながりました", operator_id)
                row = cn.execute(_ACTIVE_SQL, {"uid": operator_id}).mappings().first()
        return self._serialize(row)

    def _require(self, cn, call_uuid: str, operator_id: str):
        row = cn.execute(_REQUIRE_SQL, {"id": call_uuid, "uid": operator_id}).mappings().first()
        if row is None:
            raise HTTPException(404, "対象の通話が見つかりません")
        return row

    # ---- 保留 / 保留解除 ----
    def hold(self, call_uuid: str, operator_id: str = OPERATOR_ID) -> dict:
        with engine.begin() as cn:
            row = self._require(cn, call_uuid, operator_id)
            if row["call_status"] == "dialing":
                raise HTTPException(422, "通話がつながってから操作できます")
            cn.execute(_SET_STATUS, {"id": call_uuid, "status": "held"})
            self._add_op(cn, call_uuid, "hold", "保留にしました", operator_id)
        return self.get_active(operator_id)

    def unhold(self, call_uuid: str, operator_id: str = OPERATOR_ID) -> dict:
        with engine.begin() as cn:
            row = self._require(cn, call_uuid, operator_id)
            if row["call_status"] != "held":
                raise HTTPException(422, "保留中ではありません")
            cn.execute(_SET_STATUS, {"id": call_uuid, "status": "connected"})
            self._add_op(cn, call_uuid, "resume", "保留を解除しました", operator_id)
        return self.get_active(operator_id)

    # ---- 着信応答（受話） ----
    def answer(self, call_uuid: str, operator_id: str = OPERATOR_ID) -> dict:
        with engine.begin() as cn:
            row = self._require(cn, call_uuid, operator_id)
            # すでに通話中/保留中なら冪等に現状を返す
            if row["call_status"] in ("connected", "held"):
                return self.get_active(operator_id)
            if row["direction"] != "in" or row["call_status"] != "dialing":
                raise HTTPException(422, "応答できる着信がありません")
            cn.execute(_SET_STATUS, {"id": call_uuid, "status": "connected"})
            self._add_op(cn, call_uuid, "answer", "着信に応答（受話）", operator_id)
        return self.get_active(operator_id)

    # ---- プッシュ（DTMF） ----
    def send_dtmf(self, call_uuid: str, digit: str, operator_id: str = OPERATOR_ID) -> dict:
        d = (digit or "").strip()
        if d not in ("0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#"):
            raise HTTPException(422, "送信できるのは 0-9・*・# のみです")
        with engine.begin() as cn:
            row = self._require(cn, call_uuid, operator_id)
            if row["call_status"] == "dialing":
                raise HTTPException(422, "通話がつながってから操作できます")
            self._add_op(cn, call_uuid, "dtmf", "プッシュ送信：" + d, operator_id)
        return self.get_active(operator_id)

    # ---- 転送（転送後は通話終了） ----
    def transfer(self, call_uuid: str, destination: str, operator_id: str = OPERATOR_ID) -> dict:
        dest = (destination or "").strip()
        if not dest:
            raise HTTPException(422, "転送先を入力してください")
        with engine.begin() as cn:
            row = self._require(cn, call_uuid, operator_id)
            if row["call_status"] == "dialing":
                raise HTTPException(422, "通話がつながってから操作できます")
            self._add_op(cn, call_uuid, "transfer", "転送：→" + dest, operator_id)
            cn.execute(_FINALIZE, {"id": call_uuid, "result": "transferred", "rec": True})
        self.set_presence("available", operator_id)
        return {"ended": True, "call_id": row["call_id"], "result": "transferred"}

    # ---- 切電 ----
    def hangup(self, call_uuid: str, operator_id: str = OPERATOR_ID) -> dict:
        with engine.begin() as cn:
            row = self._require(cn, call_uuid, operator_id)
            was_connected = row["call_status"] in ("connected", "held")
            if row["direction"] == "in" and not was_connected:
                # 呼出中の着信を切った＝応答せず終了（不応答）
                self._add_op(cn, call_uuid, "reject", "着信を拒否（応答せず）", operator_id)
                result = "missed"
            else:
                self._add_op(cn, call_uuid, "hangup", "通話を終了", operator_id)
                result = "answered" if was_connected else "missed"
            cn.execute(_FINALIZE, {"id": call_uuid, "result": result, "rec": was_connected})
        self.set_presence("available", operator_id)
        return {"ended": True, "call_id": row["call_id"], "result": result}

    # ---- 着信のシミュレート（DF検証用） ----
    def simulate_incoming(
        self,
        from_number: Optional[str] = None,
        contact_name: Optional[str] = None,
        contract_id: Optional[str] = None,
        operator_id: str = OPERATOR_ID,
    ) -> dict:
        if from_number:
            num, name = from_number.strip(), (contact_name or "").strip() or None
        else:
            num, name = random.choice(_DEMO_INBOUND)
            name = name or None
        with engine.begin() as cn:
            if cn.execute(_ACTIVE_SQL, {"uid": operator_id}).mappings().first():
                raise HTTPException(409, "すでに通話中です。先に切電してください")
            call_id = _gen_call_id()
            new_id = cn.execute(
                _INSERT_CALL,
                {
                    "call_id": call_id,
                    "direction": "in",
                    "from_number": num,
                    "from_norm": norm(num),
                    "to_number": OUR_NUMBER,
                    "to_norm": norm(OUR_NUMBER),
                    "status": "dialing",
                    "provider": self.name,
                    "uid": operator_id,
                    "contact_name": name,
                    "contract_id": (contract_id or "").strip() or None,
                },
            ).scalar_one()
            self._add_op(cn, str(new_id), "start", "着信（呼出中）", operator_id)
            row = cn.execute(_ACTIVE_SQL, {"uid": operator_id}).mappings().first()
        self.set_presence("busy", operator_id)
        return self._serialize(row)
