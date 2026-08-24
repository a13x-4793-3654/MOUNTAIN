"""差し込み印刷のコア：プレースホルダ書式の解析と Word(.docx) への差し込み。

プレースホルダ書式（テンプレート著者が Word 文中に記述）:
    {MOUNTAIN_<項目名>_<連携項目>_<入力制限>_<文字制限>}

  - 項目名     : フォームに表示するラベル（アンダースコア `_` は使用不可）
  - 連携項目   : "<ENTITY>|<Field>"（DBから自動引き込み）。自由入力は "NONE"
  - 入力制限   : TEXT / NUM / KANA / DATE / ZIP / TEL
  - 文字制限   : 最大文字数（数字）

  例) {MOUNTAIN_郵便番号_COMPANY|PostalCode_NUM_8}
      {MOUNTAIN_送付日_NONE_DATE_10}
"""

from __future__ import annotations

import io
import re
from typing import Dict, List, Optional

from docx import Document


# ---- 入力制限の種類（フォームの検証ヒント） ----
RESTRICT_TYPES: Dict[str, str] = {
    "TEXT": "文字（制限なし）",
    "NUM": "数字のみ",
    "KANA": "カナ",
    "DATE": "日付",
    "ZIP": "郵便番号",
    "TEL": "電話番号",
}

# ---- エンティティ（差し込み元）の日本語名 ----
ENTITY_LABELS: Dict[str, str] = {
    "CONTRACT": "契約",
    "COMPANY": "会社",
    "PERSON": "契約者（個人）",
    "ACCOUNT": "口座",
    "AMOUNT": "金額",
    "ASSIGNEE": "担当",
    "SYSTEM": "システム",
}

# ---- 連携項目カタログ： ENTITY -> { Field -> (日本語ラベル, 推奨入力制限) } ----
FIELD_CATALOG: Dict[str, Dict[str, Dict[str, str]]] = {
    "CONTRACT": {
        "ContractNo": {"label": "契約番号", "restrict": "TEXT"},
        "ManagementNo": {"label": "管理番号（外部管理番号の主番号）", "restrict": "TEXT"},
        "Summary": {"label": "契約概要", "restrict": "TEXT"},
        "Category": {"label": "契約区分", "restrict": "TEXT"},
        "Status": {"label": "契約状態", "restrict": "TEXT"},
        "StartedAt": {"label": "契約開始日", "restrict": "DATE"},
        "EndedAt": {"label": "契約終了日", "restrict": "DATE"},
        "SignedAt": {"label": "契約締結日", "restrict": "DATE"},
    },
    "COMPANY": {
        "Name": {"label": "会社名", "restrict": "TEXT"},
        "NameKana": {"label": "会社名カナ", "restrict": "KANA"},
        "PostalCode": {"label": "郵便番号", "restrict": "ZIP"},
        "Prefecture": {"label": "都道府県", "restrict": "TEXT"},
        "City": {"label": "市区町村", "restrict": "TEXT"},
        "Address1": {"label": "住所（番地）", "restrict": "TEXT"},
        "Address2": {"label": "建物・部屋", "restrict": "TEXT"},
        "FullAddress": {"label": "住所（都道府県〜建物）", "restrict": "TEXT"},
        "Phone": {"label": "電話番号（代表）", "restrict": "TEL"},
    },
    "PERSON": {
        "FullName": {"label": "氏名", "restrict": "TEXT"},
        "FullNameKana": {"label": "氏名カナ", "restrict": "KANA"},
        "PostalCode": {"label": "郵便番号", "restrict": "ZIP"},
        "Prefecture": {"label": "都道府県", "restrict": "TEXT"},
        "City": {"label": "市区町村", "restrict": "TEXT"},
        "Address1": {"label": "住所（番地）", "restrict": "TEXT"},
        "Address2": {"label": "建物・部屋", "restrict": "TEXT"},
        "FullAddress": {"label": "住所（都道府県〜建物）", "restrict": "TEXT"},
    },
    "ACCOUNT": {
        "BankName": {"label": "銀行名", "restrict": "TEXT"},
        "BranchName": {"label": "支店名", "restrict": "TEXT"},
        "AccountNoMasked": {"label": "口座番号（下4桁）", "restrict": "TEXT"},
        "HolderKana": {"label": "口座名義カナ", "restrict": "KANA"},
    },
    "AMOUNT": {
        "Balance": {"label": "残債", "restrict": "NUM"},
        "Deposit": {"label": "預り金", "restrict": "NUM"},
    },
    "ASSIGNEE": {
        "Name": {"label": "担当者名", "restrict": "TEXT"},
    },
    "SYSTEM": {
        "Today": {"label": "発行日（YYYY-MM-DD）", "restrict": "DATE"},
        "TodayJp": {"label": "発行日（YYYY年M月D日）", "restrict": "TEXT"},
        "TodayWareki": {"label": "発行日（和暦：令和◯年◯月◯日）", "restrict": "TEXT"},
    },
}

# エンティティのうち、対象レコードを検索して選ぶ必要があるもの。
PICKABLE_ENTITIES = ["CONTRACT", "COMPANY", "PERSON", "ACCOUNT"]
# 契約から自動的に決まる（専用の選択が不要な）エンティティ。
CONTRACT_DERIVED_ENTITIES = ["AMOUNT", "ASSIGNEE"]


def catalog_as_list() -> List[dict]:
    """連携項目カタログをフラットな一覧で返す（テンプレ作成時の参照用）。"""
    out: List[dict] = []
    for entity, fields in FIELD_CATALOG.items():
        for field, meta in fields.items():
            out.append(
                {
                    "entity": entity,
                    "entity_label": ENTITY_LABELS.get(entity, entity),
                    "field": field,
                    "link": f"{entity}|{field}",
                    "label": meta["label"],
                    "restrict": meta["restrict"],
                }
            )
    return out


# {MOUNTAIN_項目名_連携項目_入力制限_文字制限}
# 各パートは `_` `{` `}` を含まない（連携項目の `|` は許可）。
PLACEHOLDER_RE = re.compile(r"\{MOUNTAIN_([^_{}]+)_([^_{}]+)_([^_{}]+)_([^_{}]+)\}")


def _build_field(match: "re.Match") -> dict:
    label, link, restrict, maxlen_s = (
        match.group(1),
        match.group(2),
        match.group(3),
        match.group(4),
    )
    entity: Optional[str] = None
    source: Optional[str] = None
    if link.upper() != "NONE" and "|" in link:
        entity, source = link.split("|", 1)
    try:
        maxlen = int(maxlen_s)
    except ValueError:
        maxlen = 0
    known = False
    if link.upper() == "NONE":
        known = True
    elif entity in FIELD_CATALOG and source in FIELD_CATALOG.get(entity, {}):
        known = True
    return {
        "token": match.group(0),
        "label": label,
        "link": link,
        "entity": entity,
        "source": source,
        "restrict": restrict.upper(),
        "maxlen": maxlen,
        "free_input": link.upper() == "NONE",
        "known": known,
    }


# ---- docx の全段落を走査（本文・表・ヘッダ・フッタ、ネスト表も対象） ----
def _iter_block_paragraphs(container):
    for p in getattr(container, "paragraphs", []):
        yield p
    for tbl in getattr(container, "tables", []):
        for row in tbl.rows:
            for cell in row.cells:
                yield from _iter_block_paragraphs(cell)


def iter_all_paragraphs(doc):
    yield from _iter_block_paragraphs(doc)
    for section in doc.sections:
        for hf in (
            section.header,
            section.footer,
            section.first_page_header,
            section.first_page_footer,
            section.even_page_header,
            section.even_page_footer,
        ):
            if hf is not None:
                yield from _iter_block_paragraphs(hf)


def parse_template_fields(docx_bytes: bytes) -> List[dict]:
    """.docx を解析し、含まれる差し込み項目（重複除去・出現順）を返す。"""
    doc = Document(io.BytesIO(docx_bytes))
    seen: Dict[str, dict] = {}
    order: List[str] = []
    for p in iter_all_paragraphs(doc):
        text = "".join(r.text for r in p.runs)
        if "{MOUNTAIN" not in text:
            continue
        for m in PLACEHOLDER_RE.finditer(text):
            token = m.group(0)
            if token in seen:
                continue
            seen[token] = _build_field(m)
            order.append(token)
    return [seen[t] for t in order]


def _replace_in_paragraph(paragraph, token_to_value: Dict[str, str]) -> None:
    """段落内のプレースホルダを置換する。
    Word はプレースホルダ文字列を複数の run に分割することがあるため、
    段落全体のテキストを合成してから置換し、先頭 run にまとめて書き戻す。"""
    runs = paragraph.runs
    if not runs:
        return
    full = "".join(r.text for r in runs)
    if "{MOUNTAIN" not in full:
        return
    new = full
    for token, value in token_to_value.items():
        if token in new:
            new = new.replace(token, value)
    # 値が渡されなかった残りの MOUNTAIN タグは空文字にして生タグの印字を防ぐ。
    new = PLACEHOLDER_RE.sub("", new)
    if new == full:
        return
    runs[0].text = new
    for r in runs[1:]:
        r.text = ""


def fill_docx(docx_bytes: bytes, token_to_value: Dict[str, str]) -> bytes:
    """.docx にプレースホルダの値を差し込み、新しい .docx バイト列を返す。"""
    doc = Document(io.BytesIO(docx_bytes))
    for p in iter_all_paragraphs(doc):
        _replace_in_paragraph(p, token_to_value)
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()
