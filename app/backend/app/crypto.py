"""機微情報（口座番号・カード番号・CVV）の暗号化ヘルパー。

方針（DF≡Prod）:
- 実番号は DB の BYTEA 列に Fernet で暗号化して保存する。
- 通常表示はマスク（例: ********1234）のみ。復号表示は権限
  ``action.sensitive.reveal`` を持つ利用者だけがエンドポイント経由で行う。
- 暗号鍵は環境変数 ``SENSITIVE_ENC_KEY`` から取得する。任意の文字列でよく、
  内部で SHA-256 → urlsafe base64 で 32byte の Fernet 鍵に変換する。
- 鍵が未設定なら開発用の既定鍵にフォールバックする（本番は必ず上書きすること）。
  コードは df/prod で同一、鍵（環境変数）だけが環境ごとに異なる。
"""

from __future__ import annotations

import base64
import hashlib
import sys
from functools import lru_cache
from typing import Optional

from cryptography.fernet import Fernet

from .config import settings

# 開発（DF）用の既定パスフレーズ。本番では環境変数で必ず上書きする。
_DEV_KEY_PHRASE = "mountain-dev-sensitive-key-v1"


def _derive_key(phrase: str) -> bytes:
    """任意の文字列から Fernet 用の 32byte urlsafe base64 鍵を導出する。"""
    digest = hashlib.sha256(phrase.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    raw = (settings.sensitive_enc_key or "").strip()
    if raw:
        # 既に正規の Fernet 鍵（44文字 base64）ならそのまま、それ以外は導出する。
        try:
            return Fernet(raw.encode("utf-8"))
        except Exception:
            return Fernet(_derive_key(raw))
    # 未設定 → 開発用の既定鍵（本番運用では厳禁）。
    print(
        "[crypto] WARNING: SENSITIVE_ENC_KEY 未設定のため開発用の既定鍵を使用します。"
        "本番では必ず環境変数で鍵を設定してください。",
        file=sys.stderr,
    )
    return Fernet(_derive_key(_DEV_KEY_PHRASE))


def encrypt_str(plain: str) -> bytes:
    """平文文字列を暗号化してバイト列（Fernet トークン）を返す。"""
    return _fernet().encrypt(plain.encode("utf-8"))


def decrypt_bytes(token: object) -> str:
    """暗号化バイト列（BYTEA/memoryview/bytes/str）を復号して平文文字列を返す。"""
    if token is None:
        raise ValueError("暗号化データがありません。")
    if isinstance(token, memoryview):
        token = token.tobytes()
    elif isinstance(token, str):
        token = token.encode("utf-8")
    return _fernet().decrypt(bytes(token)).decode("utf-8")


def mask_account_no(full: Optional[str], category: str) -> Optional[str]:
    """実番号から表示用マスクを作る（末尾4桁のみ残す）。

    銀行は先頭8個、カードは先頭12個の ``*`` を付ける（既存シードの体裁に合わせる）。
    """
    if not full:
        return None
    digits = "".join(ch for ch in full if ch.isdigit())
    if not digits:
        return None
    last4 = digits[-4:]
    stars = 12 if category == "credit" else 8
    return ("*" * stars) + last4
