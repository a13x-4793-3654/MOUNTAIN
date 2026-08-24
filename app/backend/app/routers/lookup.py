"""入力補助（外部公開API）のサーバー側プロキシ。

画面から直接外部サイトを叩かず、必ずこのAPIを経由させる。理由:
  - 法人番号API(gBizINFO)のトークンをブラウザに晒さず、サーバー内に保管できる
  - 社内PCが直接インターネットに出られなくても、サーバーが代理取得できる
  - タイムアウト・整形・エラーメッセージを一元管理できる

利用する外部サービス（いずれも公開API）:
  - zipcloud            郵便番号 → 住所            （認証不要）
  - bank.teraren.com    銀行・支店 の コード⇔名称   （認証不要）
  - gBizINFO            法人番号 → 企業情報         （無料登録のAPIトークンが必要）

このルーターは main.py 側で「ログイン必須（get_current_user）」でゲートする。
"""

from typing import Optional
import re
import threading
import time

import httpx
from fastapi import APIRouter, HTTPException, Query

from ..config import settings

router = APIRouter(prefix="/api/lookup", tags=["lookup"])

_TIMEOUT = 8.0
_ZIPCLOUD = "https://zipcloud.ibsnet.co.jp/api/search"
_BANK_BASE = "https://bank.teraren.com"
_GBIZ = "https://api.info.gbiz.go.jp/hojin/v2/hojin"

# 都道府県（47）の先頭一致。北海道・東京都・京都府・大阪府 と、残り43県（県名2〜3文字＋県）。
_PREF_RE = re.compile(r"^(北海道|東京都|(?:京都|大阪)府|.{2,3}?県)")


def _split_location(loc: Optional[str]) -> tuple[str, str, str]:
    """gBizINFOの住所文字列（例: 愛知県豊田市トヨタ町１番地）を
    都道府県／市区町村／それ以降 の3つに best-effort で分割する。
    郵便番号検索(zipcloud)の粒度（prefecture/city/town）に合わせるための処置。
    """
    s = (loc or "").strip()
    if not s:
        return "", "", ""
    m = _PREF_RE.match(s)
    pref = m.group(1) if m else ""
    rest = s[len(pref):]
    cm = re.match(r"^(.+?[市区町村])", rest)
    city = cm.group(1) if cm else ""
    addr = rest[len(city):]
    # 政令指定都市（例: 名古屋市中区）は「○○市」の直後の「△区」を市側へ寄せる
    if city.endswith("市"):
        am = re.match(r"^(.+?区)", addr)
        if am:
            city += am.group(1)
            addr = addr[len(am.group(1)):]
    return pref, city, addr


def _digits(s: Optional[str]) -> str:
    return "".join(ch for ch in (s or "") if ch.isdigit())


def _bank_name(j: dict) -> str:
    """正式名称（例: みずほ→みずほ銀行）。normalize.name を優先。"""
    norm = j.get("normalize") or {}
    return norm.get("name") or j.get("name") or ""


# ------------------------------------------------------------
# 銀行・支店の「名前での検索」実装メモ:
#   teraren の一覧API(/banks.json, /branches.json)は name 等の検索語を無視して
#   全件（ページ単位）を返す。そのため「全件取得→サーバー側で部分一致フィルタ」
#   で検索を実現する。取得結果はプロセス内に一定時間キャッシュし、毎回の外部
#   アクセスを避ける（銀行約1,146件・支店は銀行ごと。データはほぼ不変）。
# ------------------------------------------------------------
_CACHE_TTL = 6 * 3600  # 6時間
_bank_cache: dict = {"data": None, "at": 0.0}
_branch_cache: dict = {}  # code -> {"data": [...], "at": float}
_bank_lock = threading.Lock()
_branch_lock = threading.Lock()


def _fetch_all(url: str) -> list:
    """teraren のリストを per/page でページングして全件取得する。"""
    out: list = []
    per = 1000
    for page in range(1, 12):  # 安全上限（最大11,000件）
        r = httpx.get(url, params={"per": per, "page": page}, timeout=_TIMEOUT)
        r.raise_for_status()
        arr = r.json()
        if not isinstance(arr, list):
            arr = (arr.get("banks") or arr.get("branches") or []) if isinstance(arr, dict) else []
        out.extend(arr)
        if len(arr) < per:
            break
    return out


def _all_banks() -> list:
    now = time.monotonic()
    with _bank_lock:
        if _bank_cache["data"] is not None and now - _bank_cache["at"] < _CACHE_TTL:
            return _bank_cache["data"]
    data = _fetch_all(f"{_BANK_BASE}/banks.json")
    with _bank_lock:
        _bank_cache["data"] = data
        _bank_cache["at"] = now
    return data


def _all_branches(code: str) -> list:
    now = time.monotonic()
    with _branch_lock:
        ent = _branch_cache.get(code)
        if ent and now - ent["at"] < _CACHE_TTL:
            return ent["data"]
    data = _fetch_all(f"{_BANK_BASE}/banks/{code}/branches.json")
    with _branch_lock:
        _branch_cache[code] = {"data": data, "at": now}
    return data


def _norm(s: Optional[str]) -> str:
    """比較用に正規化（小文字化・空白/「銀行」表記を除去）。"""
    t = (s or "").lower().replace(" ", "").replace("　", "")
    for w in ("銀行", "ぎんこう", "ギンコウ"):
        t = t.replace(w, "")
    return t


def _match_rank(item: dict, qn: str) -> int:
    """qn（正規化済みキーワード）がヒットすれば 1=前方一致 / 2=部分一致、なければ 0。"""
    if not qn:
        return 0
    norm = item.get("normalize") or {}
    fields = [
        item.get("name"), item.get("kana"), item.get("hira"), item.get("roma"),
        norm.get("name"), norm.get("kana"), norm.get("hira"), norm.get("roma"),
    ]
    best = 0
    for f in fields:
        fn = _norm(f)
        if not fn:
            continue
        if fn.startswith(qn):
            return 1
        if qn in fn:
            best = 2
    return best


def _search(items: list, q: str, limit: int = 50) -> list:
    qn = _norm(q)
    scored = []
    for x in items:
        m = _match_rank(x, qn)
        if m:
            scored.append((m, x))
    scored.sort(key=lambda t: t[0])  # 前方一致(1)を先、部分一致(2)を後
    return [
        {"code": x.get("code") or "", "name": _bank_name(x), "kana": x.get("kana") or ""}
        for _, x in scored
    ][:limit]


# ============================================================
# 郵便番号 → 住所
# ============================================================
@router.get("/postal")
def postal(zip: str = Query(..., description="郵便番号（7桁・ハイフン可）")):
    z = _digits(zip)
    if len(z) != 7:
        raise HTTPException(status_code=422, detail="郵便番号は7桁で入力してください")
    try:
        r = httpx.get(_ZIPCLOUD, params={"zipcode": z}, timeout=_TIMEOUT)
        r.raise_for_status()
        j = r.json()
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="住所検索サービスに接続できませんでした")
    results = (j or {}).get("results") or []
    candidates = [
        {
            "postal_code": (x.get("zipcode") or "").replace("-", ""),
            "prefecture": x.get("address1") or "",
            "city": x.get("address2") or "",
            "town": x.get("address3") or "",
        }
        for x in results
    ]
    return {"found": bool(candidates), "candidates": candidates}


# ============================================================
# 銀行・支店（コード⇔名称、名前での逆引き）
# ============================================================
@router.get("/bank/search")
def bank_search(name: str = Query(..., min_length=1, description="銀行名キーワード")):
    try:
        banks = _all_banks()
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="銀行検索サービスに接続できませんでした")
    return {"items": _search(banks, name)}


@router.get("/bank/{code}")
def bank_get(code: str):
    c = _digits(code)
    try:
        r = httpx.get(f"{_BANK_BASE}/banks/{c}.json", timeout=_TIMEOUT)
        if r.status_code == 404:
            return {"found": False}
        r.raise_for_status()
        j = r.json()
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="銀行検索サービスに接続できませんでした")
    return {"found": True, "code": j.get("code") or c, "name": _bank_name(j), "kana": j.get("kana") or ""}


@router.get("/bank/{code}/branch/search")
def branch_search(code: str, name: str = Query(..., min_length=1, description="支店名キーワード")):
    c = _digits(code)
    try:
        branches = _all_branches(c)
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="支店検索サービスに接続できませんでした")
    return {"items": _search(branches, name)}


@router.get("/bank/{code}/branch/{branch}")
def branch_get(code: str, branch: str):
    c = _digits(code)
    b = _digits(branch)
    try:
        r = httpx.get(f"{_BANK_BASE}/banks/{c}/branches/{b}.json", timeout=_TIMEOUT)
        if r.status_code == 404:
            return {"found": False}
        r.raise_for_status()
        j = r.json()
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="支店検索サービスに接続できませんでした")
    return {"found": True, "code": j.get("code") or b, "name": _bank_name(j), "kana": j.get("kana") or ""}


# ============================================================
# 法人番号 → 企業情報（gBizINFO）
# ============================================================
@router.get("/corporate")
def corporate(number: str = Query(..., description="法人番号（13桁）")):
    n = _digits(number)
    if len(n) != 13:
        raise HTTPException(status_code=422, detail="法人番号は13桁で入力してください")
    if not settings.gbiz_api_token:
        raise HTTPException(
            status_code=503,
            detail="法人番号検索は未設定です（gBizINFOのAPIトークンが登録されていません）",
        )
    try:
        r = httpx.get(
            f"{_GBIZ}/{n}",
            params={"metadata_flg": "false"},
            headers={
                "X-hojinInfo-api-token": settings.gbiz_api_token,
                "Accept": "application/json",
            },
            timeout=_TIMEOUT,
        )
        if r.status_code == 404:
            return {"found": False}
        r.raise_for_status()
        j = r.json()
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="法人情報サービスに接続できませんでした")
    infos = (j or {}).get("hojin-infos") or []
    h = infos[0] if infos else (j if isinstance(j, dict) else {})
    if not h or not h.get("name"):
        return {"found": False}
    pref, city, addr = _split_location(h.get("location"))
    return {
        "found": True,
        "corporate_number": n,
        "name": h.get("name") or "",
        "kana": h.get("kana") or h.get("name_kana") or "",
        "postal_code": (h.get("postal_code") or "").replace("-", ""),
        "prefecture": pref,
        "city": city,
        "street_number": addr,
        "business_summary": h.get("business_summary") or "",
    }
