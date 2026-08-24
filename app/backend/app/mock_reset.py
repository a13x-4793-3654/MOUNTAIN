"""モックデータの自動初期化（DF専用機能）。

毎日決まった時刻に、その日に画面から登録・編集・削除したデータをすべて元に戻し、
同梱の“お手本”スナップショット（app/mock_baseline.sql）だけの状態へ戻す。

安全設計：
- settings.mock_reset_enabled が True のときだけ動作（既定 False＝本番は無効）。
- 復元は 1 本の psql（--single-transaction）で「全テーブルを空に→スナップショット流し込み」を
  ひとまとまりで実行。途中で失敗すれば丸ごと巻き戻り、DB が空のまま残らない。
- PostgreSQL のアドバイザリロックで二重起動を防止（スケジューラと手動実行の競合を防ぐ）。
- 冪等：何度実行しても同じ初期状態になる。
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.engine import make_url

from .config import settings
from .db import engine

# 日本には夏時間が無いため固定オフセットで扱う（tzdata 非依存で堅牢）。
JST = timezone(timedelta(hours=9))

# 二重起動防止のアドバイザリロック用キー（任意の定数）。
_ADVISORY_KEY = 918273645

# 直近の実行結果（コンテナ内メモリ。監査ログは初期化で消えるためDBには保持しない）。
_LAST_RUN: dict | None = None

# 実行結果サマリに件数を出すテーブル（存在しないものは None）。
_SUMMARY_TABLES = [
    "contracts", "accounts", "payments", "claims", "household_entries",
    "original_documents", "call_deny_list", "audit_logs",
    "roles", "permissions", "role_permissions", "code_masters", "users",
]


def _baseline_path() -> Path:
    override = (settings.mock_reset_baseline_path or "").strip()
    if override:
        return Path(override)
    return Path(__file__).with_name("mock_baseline.sql")


def baseline_present() -> bool:
    p = _baseline_path()
    try:
        return p.exists() and p.stat().st_size > 0
    except OSError:
        return False


def _parse_at(s: str) -> tuple[int, int]:
    try:
        hh, mm = (s or "00:00").split(":")[:2]
        return max(0, min(23, int(hh))), max(0, min(59, int(mm)))
    except (ValueError, TypeError):
        return 0, 0


def next_run_at(now: datetime | None = None) -> datetime:
    now = now or datetime.now(JST)
    hh, mm = _parse_at(settings.mock_reset_at)
    cand = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if cand <= now:
        cand = cand + timedelta(days=1)
    return cand


def seconds_until_next_run(now: datetime | None = None) -> float:
    now = now or datetime.now(JST)
    return max(1.0, (next_run_at(now) - now).total_seconds())


def _all_public_tables(cn) -> list[str]:
    return list(
        cn.execute(
            text(
                "SELECT tablename FROM pg_tables "
                "WHERE schemaname = 'public' ORDER BY tablename"
            )
        ).scalars().all()
    )


def _counts(cn) -> dict:
    out: dict = {}
    for t in _SUMMARY_TABLES:
        try:
            out[t] = cn.execute(text(f'SELECT count(*) FROM "{t}"')).scalar()
        except Exception:
            out[t] = None
    return out


def _psql_conn_args() -> tuple[dict, list[str]]:
    url = make_url(settings.database_url)
    env = dict(os.environ)
    if url.password:
        env["PGPASSWORD"] = str(url.password)
    args = [
        "-h", url.host or "db",
        "-p", str(url.port or 5432),
        "-U", url.username or "mountain",
        "-d", url.database or "mountain",
    ]
    return env, args


def reset_mock_data(trigger: str = "manual") -> dict:
    """全テーブルを空にしてスナップショットへ戻す。失敗時は RuntimeError。"""
    global _LAST_RUN

    if not settings.mock_reset_enabled:
        raise RuntimeError("モックデータの初期化は無効です（MOCK_RESET_ENABLED 未設定）。")
    base = _baseline_path()
    if not baseline_present():
        raise RuntimeError(f"初期化用のデータ（スナップショット）が見つかりません: {base}")

    t0 = time.monotonic()

    # 二重起動防止：専用接続でアドバイザリロックを取得（別プロセスの psql とは独立）。
    lock_conn = engine.connect()
    got = lock_conn.execute(
        text("SELECT pg_try_advisory_lock(:k)"), {"k": _ADVISORY_KEY}
    ).scalar()
    if not got:
        lock_conn.close()
        raise RuntimeError("初期化処理がすでに実行中です。少し待って再度お試しください。")

    try:
        with engine.connect() as cn:
            tables = _all_public_tables(cn)
            before = _counts(cn)
        if not tables:
            raise RuntimeError("初期化対象のテーブルが見つかりません。")

        truncate = (
            "TRUNCATE "
            + ", ".join(f'public."{t}"' for t in tables)
            + " RESTART IDENTITY CASCADE;"
        )

        # ラッパーSQL：FKトリガを止め→全消し→スナップショット流し込み。
        # psql --single-transaction が全体を 1 トランザクションに包む（失敗時は巻き戻し）。
        wrapper = None
        try:
            with tempfile.NamedTemporaryFile(
                "w", suffix=".sql", delete=False, encoding="utf-8"
            ) as wf:
                wf.write("SET session_replication_role = replica;\n")
                wf.write(truncate + "\n")
                wf.write(f"\\i {base.as_posix()}\n")
                wf.write("SET session_replication_role = DEFAULT;\n")
                wrapper = wf.name

            env, conn_args = _psql_conn_args()
            cmd = [
                "psql", *conn_args,
                "-v", "ON_ERROR_STOP=1",
                "--single-transaction",
                "-q", "-f", wrapper,
            ]
            proc = subprocess.run(
                cmd, env=env, capture_output=True, text=True, timeout=600
            )
            if proc.returncode != 0:
                msg = (proc.stderr or proc.stdout or "").strip()
                raise RuntimeError(f"復元に失敗しました: {msg[:500]}")
        finally:
            if wrapper:
                try:
                    os.unlink(wrapper)
                except OSError:
                    pass

        with engine.connect() as cn:
            after = _counts(cn)

        dur_ms = int((time.monotonic() - t0) * 1000)
        _LAST_RUN = {
            "at": datetime.now(JST).isoformat(),
            "trigger": trigger,
            "duration_ms": dur_ms,
            "tables": len(tables),
            "counts": after,
            "ok": True,
        }
        print(
            f"[mock_reset] OK trigger={trigger} duration_ms={dur_ms} "
            f"tables={len(tables)} contracts={after.get('contracts')} "
            f"accounts={after.get('accounts')} audit_logs={after.get('audit_logs')}",
            flush=True,
        )
        return {
            "ok": True,
            "trigger": trigger,
            "duration_ms": dur_ms,
            "tables": len(tables),
            "counts_before": before,
            "counts_after": after,
        }
    finally:
        try:
            lock_conn.execute(
                text("SELECT pg_advisory_unlock(:k)"), {"k": _ADVISORY_KEY}
            )
        except Exception:
            pass
        lock_conn.close()


def get_status() -> dict:
    enabled = bool(settings.mock_reset_enabled)
    return {
        "enabled": enabled,
        "baseline_present": baseline_present(),
        "at": settings.mock_reset_at,
        "timezone": "Asia/Tokyo (UTC+9)",
        "next_run": next_run_at().isoformat() if enabled else None,
        "last_run": _LAST_RUN,
    }
