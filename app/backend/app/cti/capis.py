"""FreePBX 自作API（capis_api.php）クライアント。

在席（プレゼンス）変更と着信アナウンス（音声ガイダンス）を、実際の FreePBX（Asterisk）に反映する。

■ DF≡Prod
アプリ本体・DB・API・画面はすべて共通。接続情報（CTI_API_URL / CTI_API_KEY）だけが環境差。
接続情報が未設定なら本モジュールは何もしない（no-op）＝安全側にフォールバック。

■ capis_api.php の契約（参考実装 var_www_html/cti_apis/capis_api.php より）
- 認証: HTTPヘッダ ``X-API-KEY``（``ping`` のみ認証不要）。
- set_presence   : POST(JSON) action=set_presence, exten, status(available|busy|dnd|away)。
- upload_greeting: POST(multipart) action=upload_greeting, exten, type(busy|dnd|away), file。
                   サーバ側で sox により 8kHz/mono/16bit WAV に変換し各内線の greeting に保存。
- get_greeting   : GET action=get_greeting, exten, type → audio/wav をストリーム（未登録は404）。
- delete_greeting: POST(JSON) action=delete_greeting, exten, type。
- lookup_extension: GET action=lookup_extension, exten → 内線情報＋greeting 状態（読み取り専用）。
- ping           : GET action=ping（認証不要）→ {status: ok}。
"""
from __future__ import annotations

import logging
from typing import Optional, Tuple

import httpx

from ..config import settings

logger = logging.getLogger("mountain.cti.capis")

# アプリの在席値（available/busy/dnd/away）は capis の status と同一。翻訳不要。
VALID_STATUS = ("available", "busy", "dnd", "away")
VALID_GREETING_TYPE = ("busy", "dnd", "away")

# アプリのアナウンス種別（call_announcements.ann_key）→ capis の greeting type。
#   busy    → busy   （busy.wav：取り込み中）
#   dnd     → dnd    （dnd.wav：通話中・応答不可）
#   unavail → away   （unavail.wav：不在）
ANN_KEY_TO_TYPE = {"busy": "busy", "dnd": "dnd", "unavail": "away"}


class CapisError(Exception):
    """capis 呼び出しの失敗（接続情報の未設定は含まない）。"""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


# ---------------------------------------------------------------------------
# 設定・低レベルヘルパ
# ---------------------------------------------------------------------------
def enabled() -> bool:
    """接続情報（URL）が設定されていれば True。未設定なら no-op（DF 未構成・本番既定）。"""
    return bool((settings.cti_api_url or "").strip())


def _base_url() -> str:
    return (settings.cti_api_url or "").strip()


def _auth_headers() -> dict:
    key = (settings.cti_api_key or "").strip()
    return {"X-API-KEY": key} if key else {}


def _verify() -> bool:
    # PBX が自己署名の場合に備え既定は検証しない（社内閉域・CTI_API_VERIFY_TLS で切替）。
    return bool(settings.cti_api_verify_tls)


# ---------------------------------------------------------------------------
# 公開API（失敗時は CapisError を送出）
# ---------------------------------------------------------------------------
def ping(timeout: float = 6.0) -> dict:
    """疎通確認（認証不要）。{status: ok} を期待。"""
    url = _base_url()
    if not url:
        raise CapisError("接続先が未設定です")
    try:
        r = httpx.get(url, params={"action": "ping"}, verify=_verify(), timeout=timeout)
        r.raise_for_status()
        body = r.json()
        return {"ok": body.get("status") == "ok", "detail": body}
    except (httpx.HTTPError, ValueError) as e:
        raise CapisError(f"FreePBX への疎通に失敗しました: {e}") from e


def set_presence(exten: str, status: str, timeout: float = 8.0) -> dict:
    """在席状況を FreePBX に反映（POST set_presence）。"""
    exten = (exten or "").strip()
    status = (status or "").strip()
    if not exten:
        raise CapisError("内線番号が未設定です")
    if status not in VALID_STATUS:
        raise CapisError(f"在席状況の値が不正です: {status}")
    try:
        r = httpx.post(
            _base_url(),
            params={"action": "set_presence"},
            json={"action": "set_presence", "exten": exten, "status": status},
            headers=_auth_headers(),
            verify=_verify(),
            timeout=timeout,
        )
        r.raise_for_status()
        body = r.json()
        if body.get("status") != "success":
            raise CapisError(f"FreePBX が在席変更を受理しませんでした: {body}")
        return {"ok": True, "detail": body}
    except (httpx.HTTPError, ValueError) as e:
        raise CapisError(f"FreePBX への在席反映に失敗しました: {_describe(e)}") from e


def upload_greeting(
    exten: str,
    greeting_type: str,
    content: bytes,
    filename: str = "greeting.wav",
    content_type: Optional[str] = None,
    timeout: float = 45.0,
) -> dict:
    """アナウンス音声を FreePBX に登録（POST upload_greeting・multipart）。"""
    exten = (exten or "").strip()
    if not exten:
        raise CapisError("内線番号が未設定です")
    if greeting_type not in VALID_GREETING_TYPE:
        raise CapisError(f"アナウンス種別が不正です: {greeting_type}")
    if not content:
        raise CapisError("音声ファイルが空です")
    # multipart 本体は JSON ではないため action は query に付ける。
    files = {"file": (filename or "greeting.wav", content, content_type or "application/octet-stream")}
    data = {"action": "upload_greeting", "exten": exten, "type": greeting_type}
    try:
        r = httpx.post(
            _base_url(),
            params={"action": "upload_greeting"},
            data=data,
            files=files,
            headers=_auth_headers(),
            verify=_verify(),
            timeout=timeout,
        )
        r.raise_for_status()
        body = r.json()
        if body.get("status") != "success":
            raise CapisError(f"FreePBX がアナウンス登録を受理しませんでした: {body}")
        return {"ok": True, "detail": body}
    except (httpx.HTTPError, ValueError) as e:
        raise CapisError(f"FreePBX へのアナウンス登録に失敗しました: {_describe(e)}") from e


def get_greeting(exten: str, greeting_type: str, timeout: float = 15.0) -> Tuple[bytes, str]:
    """登録済みアナウンス音声を取得（GET get_greeting）。戻り値 (bytes, content_type)。"""
    exten = (exten or "").strip()
    if not exten:
        raise CapisError("内線番号が未設定です")
    if greeting_type not in VALID_GREETING_TYPE:
        raise CapisError(f"アナウンス種別が不正です: {greeting_type}")
    try:
        r = httpx.get(
            _base_url(),
            params={"action": "get_greeting", "exten": exten, "type": greeting_type},
            headers=_auth_headers(),
            verify=_verify(),
            timeout=timeout,
        )
        if r.status_code == 404:
            raise CapisError("この内線には、まだ音声が登録されていません")
        r.raise_for_status()
        ct = r.headers.get("content-type", "audio/wav")
        return r.content, ct
    except httpx.HTTPError as e:
        raise CapisError(f"FreePBX からの音声取得に失敗しました: {_describe(e)}") from e


def delete_greeting(exten: str, greeting_type: str, timeout: float = 10.0) -> dict:
    """登録済みアナウンス音声を削除（POST delete_greeting）。"""
    exten = (exten or "").strip()
    if not exten:
        raise CapisError("内線番号が未設定です")
    if greeting_type not in VALID_GREETING_TYPE:
        raise CapisError(f"アナウンス種別が不正です: {greeting_type}")
    try:
        r = httpx.post(
            _base_url(),
            params={"action": "delete_greeting"},
            json={"action": "delete_greeting", "exten": exten, "type": greeting_type},
            headers=_auth_headers(),
            verify=_verify(),
            timeout=timeout,
        )
        r.raise_for_status()
        body = r.json()
        return {"ok": body.get("status") == "success", "detail": body}
    except (httpx.HTTPError, ValueError) as e:
        raise CapisError(f"FreePBX でのアナウンス削除に失敗しました: {_describe(e)}") from e


def lookup_extension(exten: str, timeout: float = 8.0) -> dict:
    """内線情報＋greeting 状態を取得（GET lookup_extension・読み取り専用）。"""
    exten = (exten or "").strip()
    if not exten:
        raise CapisError("内線番号が未設定です")
    try:
        r = httpx.get(
            _base_url(),
            params={"action": "lookup_extension", "exten": exten},
            headers=_auth_headers(),
            verify=_verify(),
            timeout=timeout,
        )
        if r.status_code == 404:
            raise CapisError(f"内線 {exten} は見つかりませんでした")
        r.raise_for_status()
        return r.json()
    except (httpx.HTTPError, ValueError) as e:
        raise CapisError(f"FreePBX からの内線照会に失敗しました: {_describe(e)}") from e


def _describe(e: Exception) -> str:
    """HTTPStatusError なら本文メッセージも含めて短く整形。"""
    if isinstance(e, httpx.HTTPStatusError):
        detail = ""
        try:
            body = e.response.json()
            detail = body.get("message") or body.get("status") or ""
        except Exception:
            detail = (e.response.text or "")[:120]
        return f"HTTP {e.response.status_code} {detail}".strip()
    return str(e)


# ---------------------------------------------------------------------------
# ベストエフォート・ラッパ（例外を投げず状態を返す。DB書き込みを妨げないため）
#   state: 'ok'（反映）/ 'skipped'（未設定 or 内線なし）/ 'error'（失敗）
# ---------------------------------------------------------------------------
def push_presence_safe(exten: Optional[str], status: str) -> dict:
    if not enabled():
        return {"state": "skipped", "reason": "unconfigured"}
    if not (exten or "").strip():
        return {"state": "skipped", "reason": "no_extension"}
    try:
        set_presence(exten, status)  # type: ignore[arg-type]
        return {"state": "ok"}
    except CapisError as e:
        logger.warning("capis set_presence failed: %s", e)
        return {"state": "error", "detail": str(e)}


def push_greeting_safe(
    exten: Optional[str],
    greeting_type: str,
    content: bytes,
    filename: str,
    content_type: Optional[str],
) -> dict:
    if not enabled():
        return {"state": "skipped", "reason": "unconfigured"}
    if not (exten or "").strip():
        return {"state": "skipped", "reason": "no_extension"}
    try:
        upload_greeting(exten, greeting_type, content, filename, content_type)  # type: ignore[arg-type]
        return {"state": "ok"}
    except CapisError as e:
        logger.warning("capis upload_greeting failed: %s", e)
        return {"state": "error", "detail": str(e)}
