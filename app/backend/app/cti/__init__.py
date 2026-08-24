"""CTI（電話交換機連携）のドライバ層。

本番／検証（DF）で **アプリ本体・DB・API・画面は共通** とし、
実際の電話まわりだけを差し替え式（ドライバ）にする。切替は設定 `CTI_PROVIDER` のみ。

- CTI_PROVIDER=simulator … 交換機の代わりにソフトで再現（DF既定）。記録は本物のDBに残る。
- CTI_PROVIDER=pbx       … 実際のPBX（本番）。接続設定 CTI_PBX_* を構成すると有効化。

get_provider() が設定に応じた実装を1つ返す。
"""
from functools import lru_cache

from ..config import settings
from .base import CTIProvider


@lru_cache(maxsize=1)
def get_provider() -> CTIProvider:
    name = (settings.cti_provider or "simulator").strip().lower()
    if name == "pbx":
        from .pbx import PbxProvider

        return PbxProvider()
    # 既定はシミュレータ（DF）
    from .simulator import SimulatorProvider

    return SimulatorProvider()


__all__ = ["CTIProvider", "get_provider"]
