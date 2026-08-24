from typing import Optional
import uuid
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy import text

from ..auth import CurrentUser, get_current_user
from ..db import engine

router = APIRouter(prefix="/api", tags=["files"])

DEFAULT_CREATED_BY = "00000000-0000-0000-0000-000000000001"

# アップロード上限（nginx 側は 50MB。DB保持のため 30MB を上限にする）。
MAX_UPLOAD_BYTES = 30 * 1024 * 1024

# プレビュー時にブラウザへ inline 表示してよい安全な種別。
# （HTML/SVG などはスクリプト実行の恐れがあるため inline 許可せず、常にダウンロード扱いにする）
_INLINE_SAFE = {
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "text/plain",
    "text/csv",
}

LIST_SQL = text(
    """
    SELECT f.id, f.contract_id, c.contract_no, f.file_name, f.content_type,
           f.file_size_bytes, f.tag_text, f.is_password_protected, f.created_at,
           u.display_name AS created_by_name,
           co.company_name,
           EXISTS (SELECT 1 FROM file_blobs b WHERE b.file_id = f.id) AS has_content
    FROM files f
    LEFT JOIN contracts c ON c.id = f.contract_id
    LEFT JOIN users u ON u.id = f.created_by
    LEFT JOIN LATERAL (
        SELECT co2.company_name FROM contract_company_links l
        JOIN companies co2 ON co2.id=l.company_id
        WHERE l.contract_id=c.id ORDER BY l.id LIMIT 1
    ) co ON TRUE
    WHERE (CAST(:q AS text) IS NULL
           OR f.file_name ILIKE CAST(:qq AS text)
           OR f.tag_text ILIKE CAST(:qq AS text)
           OR c.contract_no ILIKE CAST(:qq AS text)
           OR co.company_name ILIKE CAST(:qq AS text))
    ORDER BY f.created_at DESC NULLS LAST, f.id
    LIMIT 300
    """
)

KPI_SQL = text(
    """
    SELECT
      (SELECT count(*) FROM files) AS files_count,
      (SELECT count(*) FROM files WHERE is_password_protected) AS protected_count,
      (SELECT COALESCE(sum(file_size_bytes),0) FROM files) AS total_bytes
    """
)


@router.get("/files")
def list_files(q: Optional[str] = None):
    params = {"q": q, "qq": f"%{q}%" if q else None}
    with engine.connect() as cn:
        kpis = cn.execute(KPI_SQL).mappings().first()
        rows = cn.execute(LIST_SQL, params).mappings().all()
    return {"kpis": dict(kpis), "total": len(rows), "items": [dict(r) for r in rows]}


# =========================
# ファイルの登録・編集・削除（Phase 2 第4弾）
#   ※メタデータのみ登録する経路（後方互換）と、実バイナリを保存する経路の両方を持つ。
# =========================
_CONTENT_TYPE_BY_EXT = {
    "pdf": "application/pdf",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "bmp": "image/bmp",
    "txt": "text/plain",
    "csv": "text/csv",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls": "application/vnd.ms-excel",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "ppt": "application/vnd.ms-powerpoint",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "zip": "application/zip",
}


def _guess_content_type(file_name: str) -> Optional[str]:
    if "." in file_name:
        ext = file_name.rsplit(".", 1)[-1].lower()
        return _CONTENT_TYPE_BY_EXT.get(ext)
    return None


class FileCreateIn(BaseModel):
    file_name: str
    tag_text: Optional[str] = None
    is_password_protected: bool = False
    file_size_bytes: Optional[int] = None


class FileUpdateIn(BaseModel):
    file_name: str
    tag_text: Optional[str] = None
    is_password_protected: bool = False


INSERT_FILE_SQL = text(
    """
    INSERT INTO files
      (contract_id, file_name, content_type, file_size_bytes, storage_backend,
       storage_key, tag_text, is_password_protected, created_by)
    VALUES
      (CAST(:contract_id AS uuid), :file_name, :content_type, :file_size_bytes, :storage_backend,
       :storage_key, :tag_text, :is_password_protected, CAST(:created_by AS uuid))
    RETURNING id
    """
)
UPDATE_FILE_SQL = text(
    """
    UPDATE files SET
      file_name=:file_name, content_type=:content_type, tag_text=:tag_text,
      is_password_protected=:is_password_protected, updated_at=NOW()
    WHERE id=CAST(:id AS uuid)
    """
)
DELETE_FILE_SQL = text("DELETE FROM files WHERE id=CAST(:id AS uuid)")

# 実体（BYTEA）の upsert / 取得 / 付随メタの更新
_UPSERT_BLOB_SQL = text(
    """
    INSERT INTO file_blobs (file_id, content)
    VALUES (CAST(:id AS uuid), :content)
    ON CONFLICT (file_id) DO UPDATE SET content = EXCLUDED.content
    """
)
_UPDATE_FILE_META_ON_UPLOAD_SQL = text(
    """
    UPDATE files SET
      content_type = COALESCE(:content_type, content_type),
      file_size_bytes = :file_size_bytes,
      storage_backend = 'db',
      updated_at = NOW()
    WHERE id = CAST(:id AS uuid)
    """
)
_BLOB_FETCH_SQL = text(
    """
    SELECT f.file_name, f.content_type, b.content
    FROM files f
    JOIN file_blobs b ON b.file_id = f.id
    WHERE f.id = CAST(:id AS uuid)
    """
)


@router.post("/contracts/{contract_id}/files")
def create_file(contract_id: str, body: FileCreateIn):
    name = (body.file_name or "").strip()
    if not name:
        raise HTTPException(422, "ファイル名を入力してください")
    params = {
        "contract_id": contract_id,
        "file_name": name,
        "content_type": _guess_content_type(name),
        "file_size_bytes": body.file_size_bytes,
        "storage_backend": "manual",
        "storage_key": f"manual/{uuid.uuid4()}",
        "tag_text": (body.tag_text or "").strip() or None,
        "is_password_protected": bool(body.is_password_protected),
        "created_by": DEFAULT_CREATED_BY,
    }
    with engine.begin() as cn:
        if not cn.execute(
            text("SELECT 1 FROM contracts WHERE id=CAST(:id AS uuid)"), {"id": contract_id}
        ).first():
            raise HTTPException(404, "対象の契約が見つかりません")
        new_id = cn.execute(INSERT_FILE_SQL, params).scalar_one()
    return {"id": str(new_id)}


@router.post("/contracts/{contract_id}/files/upload")
async def upload_file(
    contract_id: str,
    file: UploadFile = File(...),
    tag_text: Optional[str] = Form(None),
    is_password_protected: bool = Form(False),
    user: CurrentUser = Depends(get_current_user),
):
    """実ファイルをアップロードして、メタデータと実体（BYTEA）を保存する。"""
    name = (file.filename or "").strip()
    if not name:
        raise HTTPException(422, "ファイル名を取得できませんでした")
    content = await file.read()
    if not content:
        raise HTTPException(422, "空のファイルはアップロードできません")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            413, f"ファイルが大きすぎます（上限 {MAX_UPLOAD_BYTES // (1024 * 1024)}MB）"
        )
    content_type = (file.content_type or "").strip() or _guess_content_type(name)
    params = {
        "contract_id": contract_id,
        "file_name": name,
        "content_type": content_type,
        "file_size_bytes": len(content),
        "storage_backend": "db",
        "storage_key": f"db/{uuid.uuid4()}",
        "tag_text": (tag_text or "").strip() or None,
        "is_password_protected": bool(is_password_protected),
        "created_by": DEFAULT_CREATED_BY,
    }
    with engine.begin() as cn:
        if not cn.execute(
            text("SELECT 1 FROM contracts WHERE id=CAST(:id AS uuid)"), {"id": contract_id}
        ).first():
            raise HTTPException(404, "対象の契約が見つかりません")
        new_id = cn.execute(INSERT_FILE_SQL, params).scalar_one()
        cn.execute(_UPSERT_BLOB_SQL, {"id": str(new_id), "content": content})
    return {"id": str(new_id)}


@router.post("/files/{file_id}/content")
async def set_file_content(
    file_id: str,
    file: UploadFile = File(...),
    user: CurrentUser = Depends(get_current_user),
):
    """既存のファイルレコードに実体（バイナリ）を追加／差し替えする。"""
    content = await file.read()
    if not content:
        raise HTTPException(422, "空のファイルはアップロードできません")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            413, f"ファイルが大きすぎます（上限 {MAX_UPLOAD_BYTES // (1024 * 1024)}MB）"
        )
    name = (file.filename or "").strip()
    content_type = (file.content_type or "").strip() or _guess_content_type(name)
    with engine.begin() as cn:
        if not cn.execute(
            text("SELECT 1 FROM files WHERE id=CAST(:id AS uuid)"), {"id": file_id}
        ).first():
            raise HTTPException(404, "対象のファイルが見つかりません")
        cn.execute(_UPSERT_BLOB_SQL, {"id": file_id, "content": content})
        cn.execute(
            _UPDATE_FILE_META_ON_UPLOAD_SQL,
            {"id": file_id, "content_type": content_type, "file_size_bytes": len(content)},
        )
    return {"ok": True}


@router.get("/files/{file_id}/content")
def get_file_content(
    file_id: str,
    dl: int = 0,
    user: CurrentUser = Depends(get_current_user),
):
    """ファイルの実体を返す。dl=1 でダウンロード、既定はプレビュー(inline)。"""
    with engine.connect() as cn:
        row = cn.execute(_BLOB_FETCH_SQL, {"id": file_id}).first()
    if row is None:
        raise HTTPException(404, "この環境では実ファイルが未登録のため表示できません")
    file_name, content_type, content = row[0], row[1] or "application/octet-stream", bytes(row[2])
    # inline を許可するのは安全な種別のみ。それ以外は必ずダウンロードにする。
    inline = dl != 1 and content_type in _INLINE_SAFE
    disposition = "inline" if inline else "attachment"
    ascii_fallback = "file"
    cd = (
        f"{disposition}; filename=\"{ascii_fallback}\"; "
        f"filename*=UTF-8''{quote(file_name or ascii_fallback)}"
    )
    headers = {
        "Content-Disposition": cd,
        "X-Content-Type-Options": "nosniff",
        # inline 表示時のスクリプト実行を抑止（多層防御）
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    }
    return Response(content=content, media_type=content_type, headers=headers)


@router.put("/files/{file_id}")
def update_file(file_id: str, body: FileUpdateIn):
    name = (body.file_name or "").strip()
    if not name:
        raise HTTPException(422, "ファイル名を入力してください")
    params = {
        "id": file_id,
        "file_name": name,
        "content_type": _guess_content_type(name),
        "tag_text": (body.tag_text or "").strip() or None,
        "is_password_protected": bool(body.is_password_protected),
    }
    with engine.begin() as cn:
        res = cn.execute(UPDATE_FILE_SQL, params)
        if res.rowcount == 0:
            raise HTTPException(404, "対象のファイルが見つかりません")
    return {"ok": True}


@router.delete("/files/{file_id}")
def delete_file(file_id: str):
    with engine.begin() as cn:
        res = cn.execute(DELETE_FILE_SQL, {"id": file_id})
        if res.rowcount == 0:
            raise HTTPException(404, "対象のファイルが見つかりません")
    return {"ok": True}
