import uuid
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import text

from ..auth import CurrentUser, get_current_user
from ..config import settings
from ..cti import capis, get_provider
from ..cti.base import OPERATOR_ID, norm
from ..db import engine

# アップロードできるアナウンス音声の上限（10MB）。
MAX_GREETING_BYTES = 10 * 1024 * 1024

router = APIRouter(prefix="/api", tags=["cti"])


LIST_SQL = text(
    """
    SELECT ch.id, ch.call_id, ch.direction,
           ch.from_number, ch.to_number,
           ch.started_at, ch.duration_seconds,
           ch.call_result, ch.has_recording,
           c.id AS contract_id, c.contract_no,
           u.display_name AS operator_name
    FROM call_histories ch
    LEFT JOIN contracts c ON c.id = ch.linked_contract_id
    LEFT JOIN users u ON u.id = ch.operator_user_id
    WHERE (CAST(:q AS text) IS NULL
           OR ch.from_number ILIKE CAST(:qq AS text)
           OR ch.to_number ILIKE CAST(:qq AS text)
           OR ch.call_id ILIKE CAST(:qq AS text)
           OR c.contract_no ILIKE CAST(:qq AS text))
      AND (CAST(:direction AS text) IS NULL OR ch.direction = CAST(:direction AS text))
      AND (CAST(:result AS text) IS NULL OR ch.call_result = CAST(:result AS text))
    ORDER BY ch.started_at DESC
    LIMIT :limit OFFSET :offset
    """
)

COUNT_SQL = text(
    """
    SELECT count(*)
    FROM call_histories ch
    LEFT JOIN contracts c ON c.id = ch.linked_contract_id
    WHERE (CAST(:q AS text) IS NULL
           OR ch.from_number ILIKE CAST(:qq AS text)
           OR ch.to_number ILIKE CAST(:qq AS text)
           OR ch.call_id ILIKE CAST(:qq AS text)
           OR c.contract_no ILIKE CAST(:qq AS text))
      AND (CAST(:direction AS text) IS NULL OR ch.direction = CAST(:direction AS text))
      AND (CAST(:result AS text) IS NULL OR ch.call_result = CAST(:result AS text))
    """
)

DETAIL_SQL = text(
    """
    SELECT ch.id, ch.call_id, ch.direction,
           ch.from_number, ch.to_number,
           ch.started_at, ch.ended_at, ch.duration_seconds,
           ch.call_result, ch.has_recording, ch.recording_file, ch.recording_url,
           c.id AS contract_id, c.contract_no, c.contract_summary,
           c.contract_status, st.label AS contract_status_label,
           u.display_name AS operator_name
    FROM call_histories ch
    LEFT JOIN contracts c ON c.id = ch.linked_contract_id
    LEFT JOIN code_masters st ON st.category='contract_status' AND st.code=c.contract_status
    LEFT JOIN users u ON u.id = ch.operator_user_id
    WHERE ch.id = CAST(:id AS uuid)
    """
)

OPS_SQL = text(
    """
    SELECT o.seq_no, o.offset_seconds, o.operation_type, o.detail,
           o.operated_at, u.display_name AS operated_by_name
    FROM call_operation_logs o
    LEFT JOIN users u ON u.id = o.operated_by
    WHERE o.call_history_id = CAST(:id AS uuid)
    ORDER BY o.seq_no
    """
)


@router.get("/calls")
def list_calls(
    q: Optional[str] = None,
    direction: Optional[str] = None,
    result: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    params = {
        "q": q,
        "qq": f"%{q}%" if q else None,
        "direction": direction,
        "result": result,
        "limit": limit,
        "offset": offset,
    }
    with engine.connect() as cn:
        rows = cn.execute(LIST_SQL, params).mappings().all()
        total = cn.execute(COUNT_SQL, params).scalar_one()
    return {"total": total, "items": [dict(r) for r in rows]}


@router.get("/calls/{call_id}")
def get_call(call_id: str):
    params = {"id": call_id}
    with engine.connect() as cn:
        call = cn.execute(DETAIL_SQL, params).mappings().first()
        if call is None:
            raise HTTPException(status_code=404, detail="call not found")
        ops = cn.execute(OPS_SQL, params).mappings().all()
    return {
        "call": dict(call),
        "operations": [dict(r) for r in ops],
    }


# =====================================================================
# 発信・在席・通話操作（ドライバ経由：simulator / pbx を設定で切替）
# =====================================================================


class PresenceIn(BaseModel):
    status: str


class OriginateIn(BaseModel):
    number: str
    contact_name: Optional[str] = None
    contract_id: Optional[str] = None


class DtmfIn(BaseModel):
    digit: str


class TransferIn(BaseModel):
    destination: str


class IncomingIn(BaseModel):
    number: Optional[str] = None
    contact_name: Optional[str] = None
    contract_id: Optional[str] = None


@router.get("/cti/presence")
def get_presence():
    return get_provider().get_presence(OPERATOR_ID)


@router.put("/cti/presence")
def put_presence(body: PresenceIn, user: CurrentUser = Depends(get_current_user)):
    status = (body.status or "").strip()
    # アプリ内の在席表示は従来どおり OPERATOR_ID に保存（GET と対で使用）。
    result = get_provider().set_presence(status, OPERATOR_ID)
    # 実 FreePBX（capis）へも反映。対象はサインイン利用者の内線番号。
    # 接続情報が未設定 or 内線未割当なら skipped（DB保存は妨げない）。
    pbx = capis.push_presence_safe(getattr(user, "cti_ext_num", None), status)
    if isinstance(result, dict):
        return {**result, "pbx": pbx}
    return {"status": status, "pbx": pbx}


@router.get("/cti/active")
def get_active_call():
    return {"active": get_provider().get_active(OPERATOR_ID)}


@router.post("/cti/originate")
def post_originate(body: OriginateIn):
    return get_provider().originate(
        body.number, body.contact_name, body.contract_id, OPERATOR_ID
    )


@router.post("/cti/calls/{call_id}/hold")
def post_hold(call_id: str):
    return get_provider().hold(call_id, OPERATOR_ID)


@router.post("/cti/calls/{call_id}/unhold")
def post_unhold(call_id: str):
    return get_provider().unhold(call_id, OPERATOR_ID)


@router.post("/cti/calls/{call_id}/dtmf")
def post_dtmf(call_id: str, body: DtmfIn):
    return get_provider().send_dtmf(call_id, body.digit, OPERATOR_ID)


@router.post("/cti/calls/{call_id}/transfer")
def post_transfer(call_id: str, body: TransferIn):
    return get_provider().transfer(call_id, body.destination, OPERATOR_ID)


@router.post("/cti/calls/{call_id}/hangup")
def post_hangup(call_id: str):
    return get_provider().hangup(call_id, OPERATOR_ID)


@router.post("/cti/calls/{call_id}/answer")
def post_answer(call_id: str):
    return get_provider().answer(call_id, OPERATOR_ID)


@router.post("/cti/simulate-incoming")
def post_simulate_incoming(body: IncomingIn):
    return get_provider().simulate_incoming(
        body.number, body.contact_name, body.contract_id, OPERATOR_ID
    )


# =====================================================================
# クリック発信の連絡先（会社の電話番号）
# =====================================================================

CONTACTS_SQL = text(
    """
    SELECT c.company_name AS name, cp.phone_number AS number,
           cp.phone_type AS label, cp.is_primary,
           EXISTS (
               SELECT 1 FROM call_deny_list d
               WHERE d.phone_number_normalized = cp.phone_number_normalized
                 AND d.is_active = TRUE
           ) AS is_blocked
    FROM company_phones cp
    JOIN companies c ON c.id = cp.company_id
    WHERE cp.phone_number IS NOT NULL AND cp.phone_number <> ''
    ORDER BY c.company_name, cp.is_primary DESC, cp.id
    LIMIT 300
    """
)


@router.get("/cti/contacts")
def list_contacts():
    with engine.connect() as cn:
        rows = cn.execute(CONTACTS_SQL).mappings().all()
    return {"items": [dict(r) for r in rows]}


# =====================================================================
# ブラウザ・ソフトフォン（本番PBX直結）用：着信照会（スクリーンポップ）＋通話ログ記録
#   - 通話制御そのものはブラウザ（JsSIP）が実施し、交換機と直接やり取りする。
#   - バックエンドの役割は「発信元の照会」と「終話後の履歴記録」。
# =====================================================================

LOOKUP_SQL = text(
    """
    SELECT co.id AS company_id, co.company_name,
           ct.contract_id, ct.contract_no
    FROM company_phones cp
    JOIN companies co ON co.id = cp.company_id
    LEFT JOIN LATERAL (
        SELECT c.id AS contract_id, c.contract_no
        FROM contract_company_links l
        JOIN contracts c ON c.id = l.contract_id
        WHERE l.company_id = co.id
        ORDER BY c.created_at DESC
        LIMIT 1
    ) ct ON TRUE
    WHERE cp.phone_number_normalized = :norm
    ORDER BY co.company_name
    LIMIT 10
    """
)

DENY_CHECK_SQL = text(
    """
    SELECT EXISTS (
        SELECT 1 FROM call_deny_list d
        WHERE d.phone_number_normalized = :norm AND d.is_active = TRUE
    )
    """
)


@router.get("/cti/lookup")
def lookup_number(number: str = Query(..., min_length=1)):
    """着信/発信番号から会社・契約を照会（スクリーンポップ）。着信拒否も判定。"""
    n = norm(number)
    if not n:
        return {"number": number, "normalized": "", "is_blocked": False, "matches": []}
    with engine.connect() as cn:
        rows = cn.execute(LOOKUP_SQL, {"norm": n}).mappings().all()
        blocked = cn.execute(DENY_CHECK_SQL, {"norm": n}).scalar_one()
    matches = [
        {
            "kind": "company",
            "company_id": str(r["company_id"]),
            "name": r["company_name"],
            "contract_id": str(r["contract_id"]) if r["contract_id"] else None,
            "contract_no": r["contract_no"],
        }
        for r in rows
    ]
    return {"number": number, "normalized": n, "is_blocked": bool(blocked), "matches": matches}


class CallLogIn(BaseModel):
    direction: str  # in / out（inbound / outbound も可）
    from_number: Optional[str] = None
    to_number: Optional[str] = None
    started_at: Optional[str] = None  # ISO8601
    answered_at: Optional[str] = None
    ended_at: Optional[str] = None
    ring_sec: Optional[int] = None
    talk_sec: Optional[int] = None
    hold_sec: Optional[int] = None
    result: Optional[str] = None
    contact_name: Optional[str] = None
    contract_id: Optional[str] = None


_INSERT_LOG_SQL = text(
    """
    INSERT INTO call_histories
        (call_id, direction, from_number, from_number_normalized,
         to_number, to_number_normalized, started_at, ended_at,
         duration_seconds, call_result, call_status, provider,
         contact_name, linked_contract_id, operator_user_id)
    VALUES
        (:call_id, :direction, :from_number, :from_norm,
         :to_number, :to_norm,
         CAST(:started_at AS timestamptz), CAST(:ended_at AS timestamptz),
         :duration_seconds, :call_result, 'ended', :provider,
         :contact_name, CAST(:contract_id AS uuid), CAST(:operator_id AS uuid))
    RETURNING id, call_id
    """
)


@router.post("/cti/logs")
def create_call_log(
    body: CallLogIn,
    user: CurrentUser = Depends(get_current_user),
):
    """ブラウザ・ソフトフォンの終話イベントを通話履歴として記録する。
    発信元番号から会社・契約を自動照会して紐づける（契約IDが未指定の場合）。"""
    direction = "out" if (body.direction or "").lower().startswith("out") else "in"
    from_number = (body.from_number or "").strip() or None
    to_number = (body.to_number or "").strip() or None
    remote = to_number if direction == "out" else from_number

    contract_id = (body.contract_id or "").strip() or None
    contact_name = (body.contact_name or "").strip() or None

    # 契約/会社の自動照会（未指定時のみ）
    if remote and (contract_id is None or contact_name is None):
        with engine.connect() as cn:
            row = cn.execute(LOOKUP_SQL, {"norm": norm(remote)}).mappings().first()
        if row:
            if contact_name is None:
                contact_name = row["company_name"]
            if contract_id is None and row["contract_id"]:
                contract_id = str(row["contract_id"])

    # 通話結果の導出（明示指定を優先）
    if body.result:
        call_result = body.result
    elif body.answered_at:
        call_result = "answered"
    elif direction == "in":
        call_result = "missed"
    else:
        call_result = "no_answer"

    duration = body.talk_sec if body.talk_sec is not None else 0

    params = {
        "call_id": f"web-{uuid.uuid4().hex[:16]}",
        "direction": direction,
        "from_number": from_number,
        "from_norm": norm(from_number) or None,
        "to_number": to_number,
        "to_norm": norm(to_number) or None,
        "started_at": body.started_at,
        "ended_at": body.ended_at,
        "duration_seconds": duration,
        "call_result": call_result,
        "provider": settings.cti_provider,
        "contact_name": contact_name,
        "contract_id": contract_id,
        "operator_id": user.id or OPERATOR_ID,
    }
    with engine.begin() as cn:
        res = cn.execute(_INSERT_LOG_SQL, params).mappings().first()
    return {
        "id": str(res["id"]),
        "call_id": res["call_id"],
        "call_result": call_result,
        "linked_contract_id": contract_id,
        "contact_name": contact_name,
    }


# =====================================================================
# 留守電（ボイスメール）
# =====================================================================

VM_LIST_SQL = text(
    """
    SELECT v.id, v.from_number, v.contact_name, v.received_at,
           v.duration_seconds, v.mailbox, v.is_heard, v.recording_file,
           c.id AS contract_id, c.contract_no
    FROM call_voicemails v
    LEFT JOIN contracts c ON c.id = v.linked_contract_id
    ORDER BY v.received_at DESC
    LIMIT 200
    """
)


@router.get("/cti/voicemails")
def list_voicemails():
    with engine.connect() as cn:
        rows = cn.execute(VM_LIST_SQL).mappings().all()
    return {"items": [dict(r) for r in rows]}


@router.post("/cti/voicemails/{vm_id}/heard")
def mark_voicemail_heard(vm_id: str):
    with engine.begin() as cn:
        res = cn.execute(
            text(
                "UPDATE call_voicemails SET is_heard = TRUE WHERE id = CAST(:id AS uuid)"
            ),
            {"id": vm_id},
        )
        if res.rowcount == 0:
            raise HTTPException(404, "留守電が見つかりません")
    return {"ok": True}


@router.delete("/cti/voicemails/{vm_id}", status_code=204)
def delete_voicemail(vm_id: str):
    with engine.begin() as cn:
        res = cn.execute(
            text("DELETE FROM call_voicemails WHERE id = CAST(:id AS uuid)"),
            {"id": vm_id},
        )
        if res.rowcount == 0:
            raise HTTPException(404, "留守電が見つかりません")
    return None


# =====================================================================
# 着信アナウンス（ガイダンス）
# =====================================================================


class AnnouncementIn(BaseModel):
    file_name: str
    label: Optional[str] = None


@router.get("/cti/announcements")
def list_announcements():
    with engine.connect() as cn:
        rows = cn.execute(
            text(
                """
                SELECT ann_key, label, file_name, updated_at
                FROM call_announcements
                ORDER BY ann_key
                """
            )
        ).mappings().all()
    return {"items": [dict(r) for r in rows]}


@router.put("/cti/announcements/{ann_key}")
def update_announcement(ann_key: str, body: AnnouncementIn):
    fn = (body.file_name or "").strip()
    if not fn:
        raise HTTPException(422, "音声ファイル名を入力してください")
    with engine.begin() as cn:
        res = cn.execute(
            text(
                """
                UPDATE call_announcements SET
                    file_name = :fn,
                    label = COALESCE(:label, label),
                    updated_at = NOW(),
                    updated_by = CAST(:uid AS uuid)
                WHERE ann_key = :key
                """
            ),
            {
                "fn": fn,
                "label": (body.label or "").strip() or None,
                "uid": OPERATOR_ID,
                "key": ann_key,
            },
        )
        if res.rowcount == 0:
            raise HTTPException(404, "アナウンスが見つかりません")
    return {"ok": True}


@router.post("/cti/announcements/{ann_key}/audio")
def upload_announcement_audio(
    ann_key: str,
    file: UploadFile = File(...),
    user: CurrentUser = Depends(get_current_user),
):
    """アナウンス音声を実 FreePBX（capis）へ登録し、DBのファイル名も更新する。

    - ann_key: busy（取り込み中）/     dnd（通話中・応答不可）/ unavail（離席中）。
    - 接続情報が未設定（DF未構成・本番既定）なら capis は skipped ＝ DB のファイル名だけ更新。
    - 対象内線＝サインイン利用者の内線番号。
    """
    gtype = capis.ANN_KEY_TO_TYPE.get(ann_key)
    if not gtype:
        raise HTTPException(404, "アナウンスの種別が不正です")

    # 音声本体を読み込み（同期エンドポイント＝スレッドプールで実行されるためブロックOK）。
    content = file.file.read()
    if not content:
        raise HTTPException(422, "音声ファイルが空です")
    if len(content) > MAX_GREETING_BYTES:
        raise HTTPException(422, "音声ファイルが大きすぎます（上限10MB）")

    filename = (file.filename or "greeting.wav").strip() or "greeting.wav"

    # まず実 FreePBX へ反映（ベストエフォート。未設定なら skipped）。
    pbx = capis.push_greeting_safe(
        getattr(user, "cti_ext_num", None),
        gtype,
        content,
        filename,
        file.content_type,
    )

    # DB のメタデータ（最後に登録した音声ファイル名）も更新。
    with engine.begin() as cn:
        res = cn.execute(
            text(
                """
                UPDATE call_announcements SET
                    file_name = :fn,
                    updated_at = NOW(),
                    updated_by = CAST(:uid AS uuid)
                WHERE ann_key = :key
                """
            ),
            {"fn": filename, "uid": OPERATOR_ID, "key": ann_key},
        )
        if res.rowcount == 0:
            raise HTTPException(404, "アナウンスが見つかりません")
    return {"ok": True, "file_name": filename, "pbx": pbx}


@router.get("/cti/announcements/{ann_key}/audio")
def get_announcement_audio(ann_key: str, user: CurrentUser = Depends(get_current_user)):
    """登録済みアナウンス音声を実 FreePBX から取得して試聴用に返す。"""
    gtype = capis.ANN_KEY_TO_TYPE.get(ann_key)
    if not gtype:
        raise HTTPException(404, "アナウンスの種別が不正です")
    if not capis.enabled():
        raise HTTPException(404, "電話交換機に接続していないため試聴できません")
    exten = getattr(user, "cti_ext_num", None)
    if not (exten or "").strip():
        raise HTTPException(404, "内線番号が割り当てられていません")
    try:
        content, ct = capis.get_greeting(exten, gtype)
    except capis.CapisError as e:
        raise HTTPException(404, str(e))
    return Response(content=content, media_type=ct or "audio/wav")
