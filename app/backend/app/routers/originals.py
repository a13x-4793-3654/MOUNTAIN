from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from ..db import engine

router = APIRouter(prefix="/api", tags=["originals"])

# 認証未実装のデモ環境のため、貸出者は既定で管理者とする
ADMIN_USER_ID = "00000000-0000-0000-0000-000000000001"

KPI_SQL = text(
    """
    SELECT
      (SELECT count(*) FROM original_documents) AS docs_count,
      (SELECT count(*) FROM original_documents WHERE status='保管中') AS stored_count,
      (SELECT count(*) FROM original_documents WHERE status='貸出中') AS lent_count,
      (SELECT count(*) FROM storage_files) AS files_count,
      (SELECT count(*) FROM storage_locations) AS locations_count
    """
)

DOCS_SQL = text(
    """
    SELECT od.id, od.doc_type, od.contract_id, c.contract_no,
           od.received_on, od.status, od.note, od.storage_file_id,
           od.disposed_at, du.display_name AS disposed_by_name,
           sf.file_code, sf.title AS file_title,
           u.display_name AS borrowed_by_name, od.borrowed_at
    FROM original_documents od
    LEFT JOIN contracts c ON c.id = od.contract_id
    LEFT JOIN storage_files sf ON sf.id = od.storage_file_id
    LEFT JOIN users u ON u.id = od.borrowed_by
    LEFT JOIN users du ON du.id = od.disposed_by
    ORDER BY od.received_on DESC NULLS LAST, od.id
    """
)

FILES_SQL = text(
    """
    SELECT sf.id, sf.file_code, sf.title, sf.category, sf.note,
           sf.location_id, sl.name AS location_name,
           (SELECT count(*) FROM original_documents od WHERE od.storage_file_id=sf.id) AS doc_count
    FROM storage_files sf
    LEFT JOIN storage_locations sl ON sl.id = sf.location_id
    ORDER BY sf.file_code
    """
)

LOCS_SQL = text(
    """
    SELECT sl.id, sl.name, sl.detail, sl.note,
           (SELECT count(*) FROM storage_files sf WHERE sf.location_id=sl.id) AS file_count
    FROM storage_locations sl
    ORDER BY sl.name
    """
)


@router.get("/originals")
def get_originals():
    with engine.connect() as cn:
        kpis = cn.execute(KPI_SQL).mappings().first()
        documents = cn.execute(DOCS_SQL).mappings().all()
        storage_files = cn.execute(FILES_SQL).mappings().all()
        locations = cn.execute(LOCS_SQL).mappings().all()
    return {
        "kpis": dict(kpis),
        "documents": [dict(r) for r in documents],
        "storage_files": [dict(r) for r in storage_files],
        "locations": [dict(r) for r in locations],
    }


@router.post("/originals/{doc_id}/lend")
def lend_original(doc_id: str):
    with engine.begin() as cn:
        row = cn.execute(
            text("SELECT status FROM original_documents WHERE id = CAST(:id AS uuid)"),
            {"id": doc_id},
        ).mappings().first()
        if not row:
            raise HTTPException(404, "対象の原本が見つかりません")
        if row["status"] == "貸出中":
            raise HTTPException(409, "すでに貸出中です")
        if row["status"] == "廃棄済":
            raise HTTPException(409, "廃棄済みのため貸出できません")
        cn.execute(
            text(
                """
                UPDATE original_documents
                   SET status = '貸出中', borrowed_by = CAST(:u AS uuid),
                       borrowed_at = now(), returned_at = NULL, updated_at = now()
                 WHERE id = CAST(:id AS uuid)
                """
            ),
            {"id": doc_id, "u": ADMIN_USER_ID},
        )
    return {"ok": True, "status": "貸出中"}


@router.post("/originals/{doc_id}/return")
def return_original(doc_id: str):
    with engine.begin() as cn:
        row = cn.execute(
            text("SELECT status FROM original_documents WHERE id = CAST(:id AS uuid)"),
            {"id": doc_id},
        ).mappings().first()
        if not row:
            raise HTTPException(404, "対象の原本が見つかりません")
        if row["status"] != "貸出中":
            raise HTTPException(409, "貸出中ではありません")
        cn.execute(
            text(
                """
                UPDATE original_documents
                   SET status = '保管中', returned_at = now(), updated_at = now()
                 WHERE id = CAST(:id AS uuid)
                """
            ),
            {"id": doc_id},
        )
    return {"ok": True, "status": "保管中"}


# ============================================================
#  原本（original_documents）の新規・編集・削除・廃棄
# ============================================================


class OriginalIn(BaseModel):
    doc_type: str
    contract_id: str | None = None
    storage_file_id: str | None = None
    received_on: str | None = None
    note: str | None = None


def _original_params(body: OriginalIn) -> dict:
    doc_type = (body.doc_type or "").strip()
    if not doc_type:
        raise HTTPException(422, "原本の種別を入力してください")
    return {
        "doc_type": doc_type,
        "contract_id": (body.contract_id or "").strip() or None,
        "storage_file_id": (body.storage_file_id or "").strip() or None,
        "received_on": (body.received_on or "").strip() or None,
        "note": (body.note or "").strip() or None,
    }


@router.post("/originals")
def create_original(body: OriginalIn):
    params = _original_params(body)
    try:
        with engine.begin() as cn:
            new_id = cn.execute(
                text(
                    """
                    INSERT INTO original_documents
                        (doc_type, contract_id, storage_file_id, received_on, status, note)
                    VALUES
                        (:doc_type, CAST(:contract_id AS uuid), CAST(:storage_file_id AS uuid),
                         CAST(:received_on AS date), '保管中', :note)
                    RETURNING id
                    """
                ),
                params,
            ).scalar_one()
    except IntegrityError:
        raise HTTPException(409, "指定された契約または保管ファイルが見つかりません")
    return {"id": str(new_id)}


@router.put("/originals/{doc_id}")
def update_original(doc_id: str, body: OriginalIn):
    params = _original_params(body)
    params["id"] = doc_id
    try:
        with engine.begin() as cn:
            res = cn.execute(
                text(
                    """
                    UPDATE original_documents
                    SET doc_type = :doc_type,
                        contract_id = CAST(:contract_id AS uuid),
                        storage_file_id = CAST(:storage_file_id AS uuid),
                        received_on = CAST(:received_on AS date),
                        note = :note,
                        updated_at = NOW()
                    WHERE id = CAST(:id AS uuid)
                    """
                ),
                params,
            )
    except IntegrityError:
        raise HTTPException(409, "指定された契約または保管ファイルが見つかりません")
    if res.rowcount == 0:
        raise HTTPException(404, "対象の原本が見つかりません")
    return {"ok": True}


@router.delete("/originals/{doc_id}")
def delete_original(doc_id: str):
    with engine.begin() as cn:
        res = cn.execute(
            text("DELETE FROM original_documents WHERE id = CAST(:id AS uuid)"),
            {"id": doc_id},
        )
        if res.rowcount == 0:
            raise HTTPException(404, "対象の原本が見つかりません")
    return {"ok": True}


@router.post("/originals/{doc_id}/dispose")
def dispose_original(doc_id: str):
    with engine.begin() as cn:
        row = cn.execute(
            text("SELECT status FROM original_documents WHERE id = CAST(:id AS uuid)"),
            {"id": doc_id},
        ).mappings().first()
        if not row:
            raise HTTPException(404, "対象の原本が見つかりません")
        if row["status"] == "廃棄済":
            raise HTTPException(409, "すでに廃棄済みです")
        if row["status"] == "貸出中":
            raise HTTPException(409, "貸出中のため廃棄できません。先に返却してください")
        cn.execute(
            text(
                """
                UPDATE original_documents
                   SET status = '廃棄済', disposed_at = CURRENT_DATE,
                       disposed_by = CAST(:u AS uuid), updated_at = NOW()
                 WHERE id = CAST(:id AS uuid)
                """
            ),
            {"id": doc_id, "u": ADMIN_USER_ID},
        )
    return {"ok": True, "status": "廃棄済"}


# ============================================================
#  保管ファイル（storage_files）の新規・編集・削除
# ============================================================


class StorageFileIn(BaseModel):
    file_code: str
    title: str
    category: str | None = None
    location_id: str | None = None
    note: str | None = None


def _sfile_params(body: StorageFileIn) -> dict:
    code = (body.file_code or "").strip()
    title = (body.title or "").strip()
    if not code:
        raise HTTPException(422, "ファイルコードを入力してください")
    if not title:
        raise HTTPException(422, "ファイルのタイトルを入力してください")
    return {
        "file_code": code,
        "title": title,
        "category": (body.category or "").strip() or None,
        "location_id": (body.location_id or "").strip() or None,
        "note": (body.note or "").strip() or None,
    }


@router.post("/storage-files")
def create_storage_file(body: StorageFileIn):
    params = _sfile_params(body)
    try:
        with engine.begin() as cn:
            new_id = cn.execute(
                text(
                    """
                    INSERT INTO storage_files (file_code, title, category, location_id, note)
                    VALUES (:file_code, :title, :category, CAST(:location_id AS uuid), :note)
                    RETURNING id
                    """
                ),
                params,
            ).scalar_one()
    except IntegrityError:
        raise HTTPException(409, "このファイルコードは既に使われています")
    return {"id": str(new_id)}


@router.put("/storage-files/{file_id}")
def update_storage_file(file_id: str, body: StorageFileIn):
    params = _sfile_params(body)
    params["id"] = file_id
    try:
        with engine.begin() as cn:
            res = cn.execute(
                text(
                    """
                    UPDATE storage_files
                    SET file_code = :file_code, title = :title, category = :category,
                        location_id = CAST(:location_id AS uuid), note = :note, updated_at = NOW()
                    WHERE id = CAST(:id AS uuid)
                    """
                ),
                params,
            )
    except IntegrityError:
        raise HTTPException(409, "このファイルコードは既に使われています")
    if res.rowcount == 0:
        raise HTTPException(404, "対象の保管ファイルが見つかりません")
    return {"ok": True}


@router.delete("/storage-files/{file_id}")
def delete_storage_file(file_id: str):
    with engine.begin() as cn:
        used = cn.execute(
            text("SELECT count(*) FROM original_documents WHERE storage_file_id = CAST(:id AS uuid)"),
            {"id": file_id},
        ).scalar_one()
        if used and int(used) > 0:
            raise HTTPException(409, "このファイルに収納された原本があるため削除できません")
        res = cn.execute(
            text("DELETE FROM storage_files WHERE id = CAST(:id AS uuid)"),
            {"id": file_id},
        )
        if res.rowcount == 0:
            raise HTTPException(404, "対象の保管ファイルが見つかりません")
    return {"ok": True}


# ============================================================
#  格納場所（storage_locations）の新規・編集・削除
# ============================================================


class StorageLocationIn(BaseModel):
    name: str
    detail: str | None = None
    note: str | None = None


def _sloc_params(body: StorageLocationIn) -> dict:
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(422, "格納場所の名称を入力してください")
    return {
        "name": name,
        "detail": (body.detail or "").strip() or None,
        "note": (body.note or "").strip() or None,
    }


@router.post("/storage-locations")
def create_storage_location(body: StorageLocationIn):
    params = _sloc_params(body)
    with engine.begin() as cn:
        new_id = cn.execute(
            text(
                """
                INSERT INTO storage_locations (name, detail, note)
                VALUES (:name, :detail, :note)
                RETURNING id
                """
            ),
            params,
        ).scalar_one()
    return {"id": str(new_id)}


@router.put("/storage-locations/{loc_id}")
def update_storage_location(loc_id: str, body: StorageLocationIn):
    params = _sloc_params(body)
    params["id"] = loc_id
    with engine.begin() as cn:
        res = cn.execute(
            text(
                """
                UPDATE storage_locations
                SET name = :name, detail = :detail, note = :note, updated_at = NOW()
                WHERE id = CAST(:id AS uuid)
                """
            ),
            params,
        )
        if res.rowcount == 0:
            raise HTTPException(404, "対象の格納場所が見つかりません")
    return {"ok": True}


@router.delete("/storage-locations/{loc_id}")
def delete_storage_location(loc_id: str):
    with engine.begin() as cn:
        used = cn.execute(
            text("SELECT count(*) FROM storage_files WHERE location_id = CAST(:id AS uuid)"),
            {"id": loc_id},
        ).scalar_one()
        if used and int(used) > 0:
            raise HTTPException(409, "この格納場所に紐づく保管ファイルがあるため削除できません")
        res = cn.execute(
            text("DELETE FROM storage_locations WHERE id = CAST(:id AS uuid)"),
            {"id": loc_id},
        )
        if res.rowcount == 0:
            raise HTTPException(404, "対象の格納場所が見つかりません")
    return {"ok": True}
