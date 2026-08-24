"""本番導入用の「土台データ」自動セットアップ（初回アクセス時に自動実行）。

空のデータベースにアプリが最初に接続したとき、業務の土台（区分マスタ・権限・
着信アナウンス定義・システム利用者2件）を自動で用意する。手作業のセットアップは不要。

安全設計：
- 冪等：土台データ(app/baseline.sql)は ON CONFLICT で既存行を壊さない。
  既にデモseedが入っている DF では実質「何もしない」。空の本番だけが土台で満たされる。
- スキップ判定：区分マスタ・権限・システム利用者2件がそろっていれば「導入済み」として
  何もしない（毎回の起動で無駄に流し込まない）。
- 二重起動防止：PostgreSQL のアドバイザリロック（mock_reset とは別キー）。
- 失敗してもアプリは止めない：例外は握りつぶさずログに大きく出すが、起動は継続する
  （土台が無ければ各画面が個別に分かりやすく失敗する方が、全停止より安全）。
- settings.auto_provision_enabled が False のときは一切動作しない。

DF≡Prod：コードは同一。DF は導入済みのため no-op、本番は空DBから土台を自動生成する。
"""
from __future__ import annotations

import subprocess
import time
from pathlib import Path

from sqlalchemy import text

from .config import settings
from .db import engine
from .mock_reset import _psql_conn_args  # 同一パッケージ：接続引数を共用

# 二重起動防止のアドバイザリロック用キー（mock_reset の 918273645 とは別値）。
_ADVISORY_KEY = 918273646

# システム利用者（参照整合用の固定ID）。この2件がそろって初めて「導入済み」とみなす。
_SYS_USER_IDS = (
    "00000000-0000-0000-0000-000000000001",
    "00000000-0000-0000-0000-000000000002",
)


def _baseline_path() -> Path:
    return Path(__file__).with_name("baseline.sql")


def baseline_present() -> bool:
    p = _baseline_path()
    try:
        return p.exists() and p.stat().st_size > 0
    except OSError:
        return False


def _is_provisioned(cn) -> bool:
    """土台データがそろっているか（区分マスタ・権限・システム利用者2件）。"""
    try:
        row = cn.execute(
            text(
                "SELECT "
                " (SELECT count(*) FROM code_masters) AS cm, "
                " (SELECT count(*) FROM permissions) AS perms, "
                " (SELECT count(*) FROM users "
                "   WHERE id IN (CAST(:u1 AS uuid), CAST(:u2 AS uuid))) AS sysusers"
            ),
            {"u1": _SYS_USER_IDS[0], "u2": _SYS_USER_IDS[1]},
        ).mappings().first()
    except Exception:
        # テーブルが無い等（通常は初期化時に schema.sql が先に作るため起きない）。
        return False
    if not row:
        return False
    return (row["cm"] or 0) > 0 and (row["perms"] or 0) > 0 and (row["sysusers"] or 0) >= 2


def foundation_status() -> dict:
    """土台データの件数サマリ（監視・デバッグ用）。"""
    out: dict = {"enabled": bool(settings.auto_provision_enabled),
                 "baseline_present": baseline_present()}
    tables = ["code_masters", "roles", "permissions", "role_permissions",
              "call_announcements", "users"]
    try:
        with engine.connect() as cn:
            counts: dict = {}
            for t in tables:
                try:
                    counts[t] = cn.execute(
                        text(f'SELECT count(*) FROM "{t}"')
                    ).scalar()
                except Exception:
                    counts[t] = None
            out["counts"] = counts
            out["provisioned"] = _is_provisioned(cn)
    except Exception as e:  # DB未到達など
        out["error"] = str(e)[:200]
    return out


def ensure_baseline() -> dict:
    """必要なら土台データを流し込む。アプリ起動時に1回呼ぶ想定。

    戻り値は {status: "disabled"|"already"|"provisioned"|"skipped"|"error", ...}。
    例外は投げない（起動を止めないため、内部で捕捉してログ出力する）。
    """
    if not settings.auto_provision_enabled:
        print("[bootstrap] auto provision disabled (AUTO_PROVISION_ENABLED)", flush=True)
        return {"status": "disabled"}

    if not baseline_present():
        print(
            f"[bootstrap] baseline.sql が見つかりません: {_baseline_path()} "
            "（土台の自動セットアップをスキップ）",
            flush=True,
        )
        return {"status": "error", "reason": "baseline_missing"}

    t0 = time.monotonic()
    lock_conn = None
    try:
        # 二重起動防止：専用接続でアドバイザリロックを取得。
        lock_conn = engine.connect()
        got = lock_conn.execute(
            text("SELECT pg_try_advisory_lock(:k)"), {"k": _ADVISORY_KEY}
        ).scalar()
        if not got:
            print("[bootstrap] 別プロセスがセットアップ中のためスキップ", flush=True)
            return {"status": "skipped", "reason": "locked"}

        # 既に導入済みなら何もしない（DF はここで抜ける＝no-op）。
        with engine.connect() as cn:
            if _is_provisioned(cn):
                print("[bootstrap] 土台データは導入済み（何もしません）", flush=True)
                return {"status": "already"}

        # 空DB：土台データを 1 トランザクションで流し込む（失敗時は丸ごと巻き戻り）。
        base = _baseline_path()
        env, conn_args = _psql_conn_args()
        cmd = [
            "psql", *conn_args,
            "-v", "ON_ERROR_STOP=1",
            "--single-transaction",
            "-q", "-f", str(base),
        ]
        proc = subprocess.run(
            cmd, env=env, capture_output=True, text=True, timeout=300
        )
        if proc.returncode != 0:
            msg = (proc.stderr or proc.stdout or "").strip()
            print(
                "[bootstrap] ★土台データのセットアップに失敗しました（アプリは継続）: "
                f"{msg[:800]}",
                flush=True,
            )
            return {"status": "error", "reason": msg[:800]}

        dur_ms = int((time.monotonic() - t0) * 1000)
        with engine.connect() as cn:
            provisioned = _is_provisioned(cn)
        print(
            f"[bootstrap] 土台データを自動セットアップしました "
            f"(duration_ms={dur_ms}, provisioned={provisioned})",
            flush=True,
        )
        return {"status": "provisioned", "duration_ms": dur_ms,
                "provisioned": provisioned}
    except Exception as e:
        # 何があっても起動は止めない。
        print(f"[bootstrap] ★セットアップ処理で例外（アプリは継続）: {e}", flush=True)
        return {"status": "error", "reason": str(e)[:500]}
    finally:
        if lock_conn is not None:
            try:
                lock_conn.execute(
                    text("SELECT pg_advisory_unlock(:k)"), {"k": _ADVISORY_KEY}
                )
            except Exception:
                pass
            lock_conn.close()
