"""差し込み値の解決：選択されたレコード（契約・会社・名義・口座）から
各プレースホルダ（{MOUNTAIN_...}）の値を DB より引き当てる。

- 契約を選ぶと、その契約に紐づく会社・名義・口座を自動で引き当てる（上書き可）。
- 金額（残債・預り金）と担当者は契約から自動計算する。
- 自由入力（NONE）と、引き当てできなかった項目は空文字にしておき、画面側で入力/修正する。
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Dict, List, Optional

from sqlalchemy import text

# ---- 参照SQL（既存ルーターと同じ列名・結合方針） ----
_CONTRACT_SQL = text(
    """
    SELECT c.contract_no, c.contract_summary,
           c.contract_category, c.contract_status,
           c.signed_at, c.started_at, c.ended_at,
           cat.label AS category_label,
           st.label  AS status_label,
           u.display_name AS assignee_name
    FROM contracts c
    LEFT JOIN code_masters cat ON cat.category='contract_category' AND cat.code=c.contract_category
    LEFT JOIN code_masters st  ON st.category='contract_status'    AND st.code=c.contract_status
    LEFT JOIN users u ON u.id=c.assignee_user_id
    WHERE c.id = CAST(:id AS uuid)
    """
)

_FIRST_COMPANY_SQL = text(
    """
    SELECT company_id FROM contract_company_links
    WHERE contract_id = CAST(:id AS uuid) ORDER BY id LIMIT 1
    """
)
_FIRST_PERSON_SQL = text(
    """
    SELECT person_id FROM contract_person_links
    WHERE contract_id = CAST(:id AS uuid) ORDER BY id LIMIT 1
    """
)
_DEFAULT_ACCOUNT_SQL = text(
    """
    SELECT account_id FROM contract_account_links
    WHERE contract_id = CAST(:id AS uuid)
    ORDER BY is_default DESC, id LIMIT 1
    """
)

# 管理番号：外部管理番号（識別子）のうち主番号を優先、無ければ最初に登録されたもの。
_MGMT_NO_SQL = text(
    """
    SELECT identifier_value FROM contract_identifiers
    WHERE contract_id = CAST(:id AS uuid)
    ORDER BY is_primary DESC, id ASC LIMIT 1
    """
)

_COMPANY_SQL = text(
    """
    SELECT co.company_name, co.company_name_kana, co.postal_code,
           co.prefecture, co.city, co.address1, co.address2,
           (SELECT p.phone_number FROM company_phones p
             WHERE p.company_id=co.id AND p.is_primary=TRUE
             ORDER BY p.id LIMIT 1) AS phone
    FROM companies co WHERE co.id = CAST(:id AS uuid)
    """
)
_PERSON_SQL = text(
    """
    SELECT full_name, full_name_kana, postal_code,
           prefecture, city, address1, address2
    FROM persons WHERE id = CAST(:id AS uuid)
    """
)
_ACCOUNT_SQL = text(
    """
    SELECT bank_name, branch_name, account_no_masked, account_holder_kana
    FROM accounts WHERE id = CAST(:id AS uuid)
    """
)

# 残債 = 請求合計 − 入金合計、預り金 = 入金合計 − 請求合計（それぞれ 0 未満は 0）
_AMOUNT_SQL = text(
    """
    SELECT
      COALESCE((SELECT SUM(claim_total_amount) FROM claims   WHERE contract_id = CAST(:id AS uuid)), 0) AS claims_total,
      COALESCE((SELECT SUM(amount)             FROM payments WHERE contract_id = CAST(:id AS uuid)), 0) AS payments_total
    """
)


def _fmt_date(v) -> str:
    if v is None:
        return ""
    if isinstance(v, (date, datetime)):
        return v.strftime("%Y-%m-%d")
    s = str(v)
    return s[:10]


# 和暦（元号）変換：各元号の開始日と表記を新しい順に並べる。
_ERAS = [
    (date(2019, 5, 1), "令和"),
    (date(1989, 1, 8), "平成"),
    (date(1926, 12, 25), "昭和"),
    (date(1912, 7, 30), "大正"),
    (date(1868, 1, 25), "明治"),
]


def _to_wareki(d: date) -> str:
    """日付を和暦（例：令和8年7月23日、元年は「元年」表記）に変換する。"""
    for start, name in _ERAS:
        if d >= start:
            yr = d.year - start.year + 1
            y = "元" if yr == 1 else str(yr)
            return f"{name}{y}年{d.month}月{d.day}日"
    return f"{d.year}年{d.month}月{d.day}日"  # 明治より前は西暦で表記


def _fmt_yen(v) -> str:
    try:
        n = int(Decimal(str(v)))
    except Exception:
        return ""
    return f"{n:,}"


def _join_address(row, keys) -> str:
    parts = [str(row[k]).strip() for k in keys if row.get(k)]
    return "".join(parts)


def _first(cn, sql, cid) -> Optional[str]:
    r = cn.execute(sql, {"id": cid}).first()
    return str(r[0]) if r and r[0] is not None else None


def resolve_values(cn, fields: List[dict], sel: Dict[str, Optional[str]]) -> dict:
    """fields（テンプレの項目定義）と sel（選択レコードID）から各トークンの値を解決する。

    sel: {"contract_id","company_id","person_id","account_id"}（未指定は None）
    戻り値: {"values": {token: str}, "selection": {...effective...},
             "labels": {contract/company/person/account: 表示名}}
    """
    contract_id = sel.get("contract_id") or None
    company_id = sel.get("company_id") or None
    person_id = sel.get("person_id") or None
    account_id = sel.get("account_id") or None

    entities = {f.get("entity") for f in fields if f.get("entity")}
    needs_contract = bool(entities & {"CONTRACT", "AMOUNT", "ASSIGNEE"})

    contract_row = None
    if contract_id and (needs_contract or company_id is None or person_id is None or account_id is None):
        contract_row = cn.execute(_CONTRACT_SQL, {"id": contract_id}).mappings().first()
        # 契約から会社・名義・口座を自動引き当て（明示選択が無いときのみ）
        if company_id is None and "COMPANY" in entities:
            company_id = _first(cn, _FIRST_COMPANY_SQL, contract_id)
        if person_id is None and "PERSON" in entities:
            person_id = _first(cn, _FIRST_PERSON_SQL, contract_id)
        if account_id is None and "ACCOUNT" in entities:
            account_id = _first(cn, _DEFAULT_ACCOUNT_SQL, contract_id)

    company_row = cn.execute(_COMPANY_SQL, {"id": company_id}).mappings().first() if company_id else None
    person_row = cn.execute(_PERSON_SQL, {"id": person_id}).mappings().first() if person_id else None
    account_row = cn.execute(_ACCOUNT_SQL, {"id": account_id}).mappings().first() if account_id else None

    balance = deposit = None
    if contract_id and "AMOUNT" in entities:
        amt = cn.execute(_AMOUNT_SQL, {"id": contract_id}).mappings().first()
        claims_total = Decimal(str(amt["claims_total"]))
        payments_total = Decimal(str(amt["payments_total"]))
        diff = claims_total - payments_total
        balance = diff if diff > 0 else Decimal(0)
        deposit = (-diff) if diff < 0 else Decimal(0)

    today = date.today()
    today_jp = f"{today.year}年{today.month}月{today.day}日"
    today_wareki = _to_wareki(today)

    # 管理番号（外部管理番号の主番号）を契約から引き当てる。
    mgmt_no = ""
    if contract_row is not None and contract_id:
        r = cn.execute(_MGMT_NO_SQL, {"id": contract_id}).first()
        mgmt_no = str(r[0]) if r and r[0] is not None else ""

    def contract_val(src):
        if contract_row is None:
            return ""
        m = {
            "ContractNo": contract_row["contract_no"] or "",
            "ManagementNo": mgmt_no,
            "Summary": contract_row["contract_summary"] or "",
            "Category": contract_row["category_label"] or contract_row["contract_category"] or "",
            "Status": contract_row["status_label"] or contract_row["contract_status"] or "",
            "SignedAt": _fmt_date(contract_row["signed_at"]),
            "StartedAt": _fmt_date(contract_row["started_at"]),
            "EndedAt": _fmt_date(contract_row["ended_at"]),
        }
        return str(m.get(src, ""))

    def company_val(src):
        if company_row is None:
            return ""
        m = {
            "Name": company_row["company_name"] or "",
            "NameKana": company_row["company_name_kana"] or "",
            "PostalCode": company_row["postal_code"] or "",
            "Prefecture": company_row["prefecture"] or "",
            "City": company_row["city"] or "",
            "Address1": company_row["address1"] or "",
            "Address2": company_row["address2"] or "",
            "FullAddress": _join_address(company_row, ["prefecture", "city", "address1", "address2"]),
            "Phone": company_row["phone"] or "",
        }
        return str(m.get(src, ""))

    def person_val(src):
        if person_row is None:
            return ""
        m = {
            "FullName": person_row["full_name"] or "",
            "FullNameKana": person_row["full_name_kana"] or "",
            "PostalCode": person_row["postal_code"] or "",
            "Prefecture": person_row["prefecture"] or "",
            "City": person_row["city"] or "",
            "Address1": person_row["address1"] or "",
            "Address2": person_row["address2"] or "",
            "FullAddress": _join_address(person_row, ["prefecture", "city", "address1", "address2"]),
        }
        return str(m.get(src, ""))

    def account_val(src):
        if account_row is None:
            return ""
        m = {
            "BankName": account_row["bank_name"] or "",
            "BranchName": account_row["branch_name"] or "",
            "AccountNoMasked": account_row["account_no_masked"] or "",
            "HolderKana": account_row["account_holder_kana"] or "",
        }
        return str(m.get(src, ""))

    def amount_val(src):
        if src == "Balance":
            return _fmt_yen(balance) if balance is not None else ""
        if src == "Deposit":
            return _fmt_yen(deposit) if deposit is not None else ""
        return ""

    def assignee_val(src):
        if contract_row is None:
            return ""
        if src == "Name":
            return contract_row["assignee_name"] or ""
        return ""

    def system_val(src):
        if src == "Today":
            return today.isoformat()
        if src == "TodayJp":
            return today_jp
        if src == "TodayWareki":
            return today_wareki
        return ""

    dispatch = {
        "CONTRACT": contract_val,
        "COMPANY": company_val,
        "PERSON": person_val,
        "ACCOUNT": account_val,
        "AMOUNT": amount_val,
        "ASSIGNEE": assignee_val,
        "SYSTEM": system_val,
    }

    values: Dict[str, str] = {}
    for f in fields:
        token = f["token"]
        if f.get("free_input"):
            values[token] = ""  # 自由入力は画面で入力
            continue
        ent, src = f.get("entity"), f.get("source")
        fn = dispatch.get(ent)
        values[token] = fn(src) if fn else ""

    labels = {
        "contract": (contract_row["contract_no"] if contract_row else None),
        "company": (company_row["company_name"] if company_row else None),
        "person": (person_row["full_name"] if person_row else None),
        "account": (
            f"{account_row['bank_name'] or ''} {account_row['account_no_masked'] or ''}".strip()
            if account_row else None
        ),
    }
    selection = {
        "contract_id": contract_id,
        "company_id": company_id,
        "person_id": person_id,
        "account_id": account_id,
    }
    return {"values": values, "selection": selection, "labels": labels}
