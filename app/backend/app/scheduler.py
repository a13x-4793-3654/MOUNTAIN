"""モックデータ自動初期化のスケジューラ（DF専用）。

アプリ起動時、MOCK_RESET_ENABLED=true のときだけ常駐タスクを開始し、
毎日 mock_reset_at（既定 0:00 JST）に reset_mock_data() を実行する。
本番は無効（何も起動しない）。
"""
from __future__ import annotations

import asyncio

from .config import settings
from .mock_reset import (
    baseline_present,
    next_run_at,
    reset_mock_data,
    seconds_until_next_run,
)

_task: asyncio.Task | None = None


async def _loop() -> None:
    while True:
        try:
            delay = seconds_until_next_run()
        except Exception:
            delay = 3600.0
        await asyncio.sleep(delay)
        try:
            # ブロッキング処理（psql）はスレッドに逃がしてイベントループを止めない。
            await asyncio.to_thread(reset_mock_data, "scheduler")
        except Exception as e:  # noqa: BLE001 - スケジューラは落とさない
            print(f"[mock_reset] scheduler run failed: {e}", flush=True)
        # 同一分内での二重発火を避けるための小休止。
        await asyncio.sleep(2)


def start_scheduler() -> None:
    global _task
    if not settings.mock_reset_enabled:
        print("[mock_reset] disabled (MOCK_RESET_ENABLED not set) — scheduler not started", flush=True)
        return
    if not baseline_present():
        print("[mock_reset] WARNING: baseline snapshot missing — scheduler not started", flush=True)
        return
    if _task is not None and not _task.done():
        return
    _task = asyncio.create_task(_loop())
    print(
        f"[mock_reset] scheduler started; next run at {next_run_at().isoformat()} (JST)",
        flush=True,
    )
