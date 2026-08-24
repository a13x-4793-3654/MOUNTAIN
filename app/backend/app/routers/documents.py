"""差し込み印刷：文書テンプレート（.docx / .xlsx）の登録・一覧・詳細・削除・原本ダウンロード。

テンプレートは Word(.docx) または Excel(.xlsx) を丸ごと BYTEA でDBに保持し、
アップロード時に差し込み項目（{MOUNTAIN_...} プレースホルダ）を解析して
fields_json に格納する。種別は拡張子（file_name）で判別する。
"""
from __future__ import annotations

import json
from datetime import date
from typing import Dict, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy import text

from ..auth import CurrentUser, get_current_user
from ..db import engine
from ..docmerge import (
    catalog_as_list,
    parse_template_fields,
    parse_template_fields_xlsx,
    fill_docx,
    fill_xlsx,
    docx_to_pdf,
    xlsx_to_pdf,
)
from ..docmerge.core import ENTITY_LABELS, RESTRICT_TYPES
from ..docmerge.resolve import resolve_values

router = APIRouter(prefix="/api", tags=["documents"])

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
PDF_MIME = "application/pdf"


def _is_xlsx(file_name: Optional[str]) -> bool:
    """テンプレートが Excel(.xlsx) かどうかを拡張子で判定する。"""
    return (file_name or "").strip().lower().endswith(".xlsx")


# ==========================================================================
# 連携項目カタログ（テンプレート作成時の参照用）
# ==========================================================================
@router.get("/doc-merge/catalog")
def doc_merge_catalog():
    """テンプレートに書ける差し込み項目の一覧（会社名・郵便番号など）を返す。"""
    return {
        "entities": [{"key": k, "label": v} for k, v in ENTITY_LABELS.items()],
        "restricts": [{"key": k, "label": v} for k, v in RESTRICT_TYPES.items()],
        "fields": catalog_as_list(),
    }


# ==========================================================================
# テンプレート一覧
# ==========================================================================
LIST_SQL = text(
    """
    SELECT t.id, t.name, t.description, t.file_name, t.is_active, t.created_at,
           u.display_name AS created_by_name,
           jsonb_array_length(t.fields_json) AS field_count,
           (SELECT count(*) FROM doc_generated g WHERE g.template_id = t.id) AS generated_count
    FROM doc_templates t
    LEFT JOIN users u ON u.id = t.created_by
    ORDER BY t.created_at DESC NULLS LAST, t.id
    LIMIT 300
    """
)


@router.get("/doc-templates")
def list_templates():
    with engine.connect() as cn:
        rows = cn.execute(LIST_SQL).mappings().all()
    return {"items": [dict(r) for r in rows]}


# ==========================================================================
# テンプレート詳細（差し込み項目つき）
# ==========================================================================
DETAIL_SQL = text(
    """
    SELECT t.id, t.name, t.description, t.file_name, t.fields_json,
           t.is_active, t.created_at, t.updated_at,
           u.display_name AS created_by_name
    FROM doc_templates t
    LEFT JOIN users u ON u.id = t.created_by
    WHERE t.id = CAST(:id AS uuid)
    """
)


def _fields_of(fields_json) -> list:
    """JSONB カラムの値（psycopg は list を返すが、環境により str のこともある）を list に正規化。"""
    if fields_json is None:
        return []
    if isinstance(fields_json, str):
        try:
            return json.loads(fields_json)
        except json.JSONDecodeError:
            return []
    return list(fields_json)


@router.get("/doc-templates/{tid}")
def get_template(tid: str):
    with engine.connect() as cn:
        row = cn.execute(DETAIL_SQL, {"id": tid}).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="テンプレートが見つかりません。")
    data = dict(row)
    fields = _fields_of(data.pop("fields_json"))
    data["fields"] = fields
    data["field_count"] = len(fields)
    data["unknown_count"] = sum(1 for f in fields if not f.get("known"))
    return data


# ==========================================================================
# テンプレート登録（Word ファイルのアップロード）
# ==========================================================================
INSERT_SQL = text(
    """
    INSERT INTO doc_templates (name, description, file_name, content, fields_json, created_by)
    VALUES (:name, :description, :file_name, :content,
            CAST(:fields AS jsonb), CAST(:created_by AS uuid))
    RETURNING id, created_at
    """
)


@router.post("/doc-templates")
async def create_template(
    file: UploadFile = File(...),
    name: str = Form(...),
    description: str = Form(""),
    user: CurrentUser = Depends(get_current_user),
):
    fname = (file.filename or "").strip()
    lower = fname.lower()
    is_xlsx = lower.endswith(".xlsx")
    is_docx = lower.endswith(".docx")
    if not (is_xlsx or is_docx):
        raise HTTPException(
            status_code=422,
            detail="Word（.docx）または Excel（.xlsx）ファイルを選んでください。古い .doc / .xls は非対応です。",
        )
    content = await file.read()
    if not content:
        raise HTTPException(status_code=422, detail="ファイルの中身が空です。")

    try:
        if is_xlsx:
            fields = parse_template_fields_xlsx(content)
        else:
            fields = parse_template_fields(content)
    except Exception:
        kind = "Excel（.xlsx）" if is_xlsx else "Word（.docx）"
        raise HTTPException(
            status_code=422,
            detail=f"{kind}ファイルとして読み込めませんでした。形式を確認して保存し直してください。",
        )

    display_name = (name or "").strip() or fname
    with engine.begin() as cn:
        row = cn.execute(
            INSERT_SQL,
            {
                "name": display_name,
                "description": (description or "").strip() or None,
                "file_name": fname,
                "content": content,
                "fields": json.dumps(fields, ensure_ascii=False),
                "created_by": user.id,
            },
        ).mappings().first()

    return {
        "id": str(row["id"]),
        "name": display_name,
        "file_name": fname,
        "field_count": len(fields),
        "unknown_count": sum(1 for f in fields if not f.get("known")),
        "fields": fields,
    }


# ==========================================================================
# テンプレート更新（名称・説明・有効/無効）
# ==========================================================================
class TemplateUpdate(BaseModel):
    name: str
    description: str | None = None
    is_active: bool = True


UPDATE_SQL = text(
    """
    UPDATE doc_templates
       SET name = :name, description = :description,
           is_active = :is_active, updated_at = NOW()
     WHERE id = CAST(:id AS uuid)
    """
)


@router.put("/doc-templates/{tid}")
def update_template(tid: str, body: TemplateUpdate):
    nm = (body.name or "").strip()
    if not nm:
        raise HTTPException(status_code=422, detail="テンプレート名を入力してください。")
    with engine.begin() as cn:
        res = cn.execute(
            UPDATE_SQL,
            {
                "id": tid,
                "name": nm,
                "description": (body.description or "").strip() or None,
                "is_active": body.is_active,
            },
        )
    if res.rowcount == 0:
        raise HTTPException(status_code=404, detail="テンプレートが見つかりません。")
    return {"ok": True}


# ==========================================================================
# テンプレート削除
# ==========================================================================
@router.delete("/doc-templates/{tid}")
def delete_template(tid: str):
    with engine.begin() as cn:
        res = cn.execute(
            text("DELETE FROM doc_templates WHERE id = CAST(:id AS uuid)"),
            {"id": tid},
        )
    if res.rowcount == 0:
        raise HTTPException(status_code=404, detail="テンプレートが見つかりません。")
    return {"ok": True}


# ==========================================================================
# 原本（Word ファイル）のダウンロード
# ==========================================================================
FILE_SQL = text(
    "SELECT file_name, content FROM doc_templates WHERE id = CAST(:id AS uuid)"
)


@router.get("/doc-templates/{tid}/file")
def download_template_file(tid: str):
    with engine.connect() as cn:
        row = cn.execute(FILE_SQL, {"id": tid}).first()
    if row is None:
        raise HTTPException(status_code=404, detail="テンプレートが見つかりません。")
    file_name, content = row[0], row[1]
    if _is_xlsx(file_name):
        mime, ascii_fallback = XLSX_MIME, "template.xlsx"
    else:
        mime, ascii_fallback = DOCX_MIME, "template.docx"
    disposition = (
        f"attachment; filename=\"{ascii_fallback}\"; "
        f"filename*=UTF-8''{quote(file_name)}"
    )
    return Response(
        content=bytes(content),
        media_type=mime,
        headers={"Content-Disposition": disposition},
    )


# ==========================================================================
# 差し込み（生成）：レコード選択 → 値の解決 → PDF 生成・保存
# ==========================================================================
_TPL_FOR_MERGE_SQL = text(
    "SELECT name, file_name, content, fields_json FROM doc_templates WHERE id = CAST(:id AS uuid)"
)


def _load_template_for_merge(tid: str):
    with engine.connect() as cn:
        row = cn.execute(_TPL_FOR_MERGE_SQL, {"id": tid}).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="テンプレートが見つかりません。")
    return row["name"], row["file_name"], bytes(row["content"]), _fields_of(row["fields_json"])


def _pdf_filename(title: str) -> str:
    base = (title or "document").strip() or "document"
    return f"{base}.pdf"


def _content_disposition(filename: str, ascii_fallback: str) -> str:
    return (
        f"attachment; filename=\"{ascii_fallback}\"; "
        f"filename*=UTF-8''{quote(filename)}"
    )


class ResolveIn(BaseModel):
    template_id: str
    contract_id: Optional[str] = None
    company_id: Optional[str] = None
    person_id: Optional[str] = None
    account_id: Optional[str] = None


@router.post("/doc-merge/resolve")
def resolve_merge(body: ResolveIn):
    """選択された契約/会社/名義/口座から、各差し込み項目の値を引き当てて返す。"""
    _name, _fname, _content, fields = _load_template_for_merge(body.template_id)
    sel = {
        "contract_id": (body.contract_id or None),
        "company_id": (body.company_id or None),
        "person_id": (body.person_id or None),
        "account_id": (body.account_id or None),
    }
    with engine.connect() as cn:
        result = resolve_values(cn, fields, sel)
    return result


class GenerateIn(BaseModel):
    template_id: str
    title: Optional[str] = None
    values: Dict[str, str] = {}
    selection: Optional[Dict[str, Optional[str]]] = None


_INSERT_GEN_SQL = text(
    """
    INSERT INTO doc_generated (template_id, title, inputs_json, pdf_content, pdf_size, created_by)
    VALUES (CAST(:template_id AS uuid), :title, CAST(:inputs AS jsonb),
            :pdf_content, :pdf_size, CAST(:created_by AS uuid))
    RETURNING id, created_at
    """
)


def _make_pdf(content: bytes, fields: list, values: Dict[str, str], file_name: Optional[str]) -> bytes:
    # テンプレに存在するトークンのみを差し込む（未知キーは無視）
    token_map = {f["token"]: (values.get(f["token"], "") or "") for f in fields}
    try:
        if _is_xlsx(file_name):
            filled = fill_xlsx(content, token_map)
            return xlsx_to_pdf(filled)
        filled = fill_docx(content, token_map)
        return docx_to_pdf(filled)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"PDFの作成に失敗しました。{exc}")


@router.post("/doc-merge/generate")
def generate_document(body: GenerateIn, user: CurrentUser = Depends(get_current_user)):
    """差し込み値から PDF を生成し、履歴（再印刷・編集用）として保存する。"""
    name, file_name, content, fields = _load_template_for_merge(body.template_id)
    title = (body.title or "").strip() or f"{name}_{date.today().isoformat()}"
    pdf = _make_pdf(content, fields, body.values or {}, file_name)
    inputs = {
        "values": body.values or {},
        "selection": body.selection or {},
        "fields": fields,
        "template_name": name,
    }
    with engine.begin() as cn:
        row = cn.execute(
            _INSERT_GEN_SQL,
            {
                "template_id": body.template_id,
                "title": title,
                "inputs": json.dumps(inputs, ensure_ascii=False),
                "pdf_content": pdf,
                "pdf_size": len(pdf),
                "created_by": user.id,
            },
        ).mappings().first()
    return {"id": str(row["id"]), "title": title, "pdf_size": len(pdf)}


# ==========================================================================
# 生成済みドキュメント：一覧・詳細・PDF ダウンロード・再生成・削除
# ==========================================================================
_GEN_LIST_SQL = text(
    """
    SELECT g.id, g.title, g.pdf_size, g.created_at,
           g.template_id, t.name AS template_name,
           u.display_name AS created_by_name
    FROM doc_generated g
    LEFT JOIN doc_templates t ON t.id = g.template_id
    LEFT JOIN users u ON u.id = g.created_by
    ORDER BY g.created_at DESC NULLS LAST, g.id
    LIMIT 300
    """
)


@router.get("/doc-generated")
def list_generated():
    with engine.connect() as cn:
        rows = cn.execute(_GEN_LIST_SQL).mappings().all()
    return {"items": [dict(r) for r in rows]}


_GEN_DETAIL_SQL = text(
    """
    SELECT g.id, g.title, g.pdf_size, g.created_at, g.updated_at,
           g.template_id, t.name AS template_name, t.is_active AS template_active,
           g.inputs_json, u.display_name AS created_by_name
    FROM doc_generated g
    LEFT JOIN doc_templates t ON t.id = g.template_id
    LEFT JOIN users u ON u.id = g.created_by
    WHERE g.id = CAST(:id AS uuid)
    """
)


@router.get("/doc-generated/{gid}")
def get_generated(gid: str):
    with engine.connect() as cn:
        row = cn.execute(_GEN_DETAIL_SQL, {"id": gid}).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="生成した文書が見つかりません。")
    data = dict(row)
    inputs = data.pop("inputs_json")
    if isinstance(inputs, str):
        try:
            inputs = json.loads(inputs)
        except json.JSONDecodeError:
            inputs = {}
    data["inputs"] = inputs or {}
    return data


_GEN_PDF_SQL = text(
    "SELECT title, pdf_content FROM doc_generated WHERE id = CAST(:id AS uuid)"
)


@router.get("/doc-generated/{gid}/pdf")
def download_generated_pdf(gid: str):
    with engine.connect() as cn:
        row = cn.execute(_GEN_PDF_SQL, {"id": gid}).first()
    if row is None or row[1] is None:
        raise HTTPException(status_code=404, detail="PDFが見つかりません。")
    title, pdf = row[0], row[1]
    fname = _pdf_filename(title)
    return Response(
        content=bytes(pdf),
        media_type=PDF_MIME,
        headers={"Content-Disposition": _content_disposition(fname, "document.pdf")},
    )


class RegenerateIn(BaseModel):
    title: Optional[str] = None
    values: Dict[str, str] = {}
    selection: Optional[Dict[str, Optional[str]]] = None


_GEN_TEMPLATE_SQL = text(
    "SELECT template_id, inputs_json FROM doc_generated WHERE id = CAST(:id AS uuid)"
)
_UPDATE_GEN_SQL = text(
    """
    UPDATE doc_generated
       SET title = :title, inputs_json = CAST(:inputs AS jsonb),
           pdf_content = :pdf_content, pdf_size = :pdf_size, updated_at = NOW()
     WHERE id = CAST(:id AS uuid)
    """
)


@router.put("/doc-generated/{gid}")
def regenerate_document(gid: str, body: RegenerateIn):
    """保存済みの差し込み文書を、修正した値で作り直して上書き保存する。"""
    with engine.connect() as cn:
        head = cn.execute(_GEN_TEMPLATE_SQL, {"id": gid}).mappings().first()
    if head is None:
        raise HTTPException(status_code=404, detail="生成した文書が見つかりません。")
    name, file_name, content, fields = _load_template_for_merge(str(head["template_id"]))
    title = (body.title or "").strip() or f"{name}_{date.today().isoformat()}"
    pdf = _make_pdf(content, fields, body.values or {}, file_name)
    inputs = {
        "values": body.values or {},
        "selection": body.selection or {},
        "fields": fields,
        "template_name": name,
    }
    with engine.begin() as cn:
        cn.execute(
            _UPDATE_GEN_SQL,
            {
                "id": gid,
                "title": title,
                "inputs": json.dumps(inputs, ensure_ascii=False),
                "pdf_content": pdf,
                "pdf_size": len(pdf),
            },
        )
    return {"id": gid, "title": title, "pdf_size": len(pdf)}


@router.delete("/doc-generated/{gid}")
def delete_generated(gid: str):
    with engine.begin() as cn:
        res = cn.execute(
            text("DELETE FROM doc_generated WHERE id = CAST(:id AS uuid)"),
            {"id": gid},
        )
    if res.rowcount == 0:
        raise HTTPException(status_code=404, detail="生成した文書が見つかりません。")
    return {"ok": True}
