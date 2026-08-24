"""LibreOffice(headless) を使って .docx / .xlsx を PDF へ変換する。

- api コンテナには LibreOffice + fonts-noto-cjk を導入済み（日本語フォント必須）。
- 変換は使い捨ての作業ディレクトリで行い、プロファイルの競合を避けるため
  UserInstallation を作業ディレクトリ配下に固定する。
- Excel(.xlsx) は Calc の PDF エクスポートを使う。印刷範囲や用紙設定は
  テンプレート側（Excel の「ページレイアウト」）の指定に従う。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

SOFFICE = os.environ.get("SOFFICE_BIN", "soffice")


def _to_pdf(data: bytes, in_ext: str, export_filter: str, timeout: int = 120) -> bytes:
    work = tempfile.mkdtemp(prefix="dm_")
    try:
        infile = os.path.join(work, f"in.{in_ext}")
        with open(infile, "wb") as f:
            f.write(data)
        profile_uri = "file://" + os.path.join(work, "profile").replace("\\", "/")
        env = dict(os.environ)
        env["HOME"] = work  # LibreOffice はプロファイル用に書き込み可能な HOME を要求する
        cmd = [
            SOFFICE,
            "--headless",
            "--nologo",
            "--nofirststartwizard",
            "--norestore",
            f"-env:UserInstallation={profile_uri}",
            "--convert-to",
            f"pdf:{export_filter}",
            "--outdir",
            work,
            infile,
        ]
        proc = subprocess.run(cmd, env=env, capture_output=True, timeout=timeout)
        pdf = os.path.join(work, "in.pdf")
        if not os.path.exists(pdf):
            err = proc.stderr.decode("utf-8", "replace")[:500]
            raise RuntimeError(f"PDF変換に失敗しました。{err}")
        with open(pdf, "rb") as f:
            return f.read()
    finally:
        shutil.rmtree(work, ignore_errors=True)


def docx_to_pdf(docx_bytes: bytes, timeout: int = 120) -> bytes:
    return _to_pdf(docx_bytes, "docx", "writer_pdf_Export", timeout)


def xlsx_to_pdf(xlsx_bytes: bytes, timeout: int = 120) -> bytes:
    return _to_pdf(xlsx_bytes, "xlsx", "calc_pdf_Export", timeout)
