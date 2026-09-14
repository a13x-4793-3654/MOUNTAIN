from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from .config import settings
from .calendar import calendar_config, ensure_calendar_schema
from .auth import get_current_user, require_admin, require_screen, enforce_action
from .db import engine
from .routers import (
    auth,
    contracts,
    meta,
    companies,
    persons,
    accounts,
    cti,
    dashboard,
    billing,
    review,
    litigation,
    files,
    originals,
    household,
    admin,
    documents,
    lookup,
)

app = FastAPI(title="MOUNTAIN API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    db_ok = True
    try:
        with engine.connect() as cn:
            cn.execute(text("SELECT 1"))
    except Exception:
        db_ok = False
    return {"status": "ok", "db": db_ok}


@app.get("/api/config")
def public_config():
    """フロントが起動時に読む公開設定（機密を含まない）。
    同一の web イメージを DF/本番で使い回し、差異はバックエンドの環境変数だけにする。"""
    scope = settings.entra_api_scope or (
        f"api://{settings.entra_api_client_id}/access_as_user" if settings.entra_api_client_id else ""
    )
    return {
        "auth_enabled": settings.auth_mode == "entra",
        "entra": {
            "tenant_id": settings.entra_tenant_id,
            "client_id": settings.entra_spa_client_id,
            "api_scope": scope,
        },
        "sip": {
            "wss_url": settings.sip_wss_url,
            "realm": settings.sip_realm,
            "stun": settings.sip_stun,
            "prefixes": settings.sip_outbound_prefixes,
        },
        "cti_provider": settings.cti_provider,
        "calendar": calendar_config(),
    }


# 認証（ログイン記録・自分情報）。ゲートは各エンドポイント内で解決。
app.include_router(auth.router)

# --- 認証のみ（全画面共通で使うため画面権限では絞らない） ---
# meta: 各画面のプルダウン等で使う共通の区分マスタ
# cti : 画面下の共通ダイヤルバー（発着信・プレゼンス）を全員が使用
auth_only = [Depends(get_current_user)]
app.include_router(meta.router, dependencies=auth_only)
app.include_router(cti.router, dependencies=auth_only)
# lookup: 入力補助（郵便番号→住所／銀行・支店／法人番号→企業情報）。
# 各フォームで使う共通機能のため、画面権では絞らずログインのみで許可する。
app.include_router(lookup.router, dependencies=auth_only)

# --- 画面アクセス権（RBAC）でルーターをゲート ---
# 画面の表示可否は require_screen、書き込みの細かな操作権は enforce_action（ACTION_MAP で
# APIごとに必要な操作権を判定）で行う。両者は独立して評価される。
_act = Depends(enforce_action)

# ホーム（ダッシュボード）
app.include_router(dashboard.router, dependencies=[Depends(require_screen("screen.home"))])

# 契約はハブ画面。契約詳細は請求・審査・訴訟の各タブからも参照されるため、関連画面権のいずれかで読み取りを許可。
# 書き込みは新規登録／編集／削除／関連付けごとに操作権を分けて enforce_action で判定。
app.include_router(
    contracts.router,
    dependencies=[
        Depends(require_screen("screen.contracts", "screen.billing", "screen.review", "screen.litigation")),
        _act,
    ],
)
app.include_router(
    companies.router,
    dependencies=[Depends(require_screen("screen.companies", "screen.contracts")), _act],
)
app.include_router(
    persons.router,
    dependencies=[Depends(require_screen("screen.persons", "screen.contracts")), _act],
)
app.include_router(
    accounts.router,
    dependencies=[Depends(require_screen("screen.accounts", "screen.contracts")), _act],
)
# 請求・入金：閲覧は請求/契約画面権、書き込みは請求(claim)・入金(payment)の操作権で判定
app.include_router(
    billing.router,
    dependencies=[Depends(require_screen("screen.billing", "screen.contracts")), _act],
)
# 審査：閲覧は審査/契約画面権。承認と差し戻し・否決は review.py 内で操作権を個別判定。
app.include_router(
    review.router,
    dependencies=[Depends(require_screen("screen.review", "screen.contracts")), _act],
)
app.include_router(
    litigation.router,
    dependencies=[Depends(require_screen("screen.litigation", "screen.contracts")), _act],
)
app.include_router(
    files.router,
    dependencies=[Depends(require_screen("screen.files", "screen.contracts")), _act],
)
app.include_router(
    originals.router,
    dependencies=[Depends(require_screen("screen.originals", "screen.contracts")), _act],
)
app.include_router(
    documents.router,
    dependencies=[Depends(require_screen("screen.documents", "screen.contracts")), _act],
)
app.include_router(
    household.router,
    dependencies=[Depends(require_screen("screen.household")), _act],
)
# 管理画面は管理者のみ（ユーザー・ロール・区分・監査ログの管理）
app.include_router(admin.router, dependencies=[Depends(require_admin)])


@app.on_event("startup")
async def _startup_provision_and_scheduler() -> None:
    """起動時：①本番導入用の土台データを自動セットアップ（空DBのみ・冪等）
    ②DF専用のモックデータ自動初期化スケジューラを開始（無効時は何もしない）。"""
    ensure_calendar_schema()
    # ① 土台データ（区分・権限・アナウンス定義・システム利用者）を必要なら流し込む。
    #    失敗してもアプリは止めない（内部で例外を捕捉しログ出力）。
    try:
        from .bootstrap import ensure_baseline

        ensure_baseline()
    except Exception as e:  # 念のための二重ガード（ここで落とさない）
        print(f"[bootstrap] startup hook 例外（継続）: {e}", flush=True)

    # ② スケジューラ開始（DF専用のモックデータ自動初期化）。
    from .scheduler import start_scheduler

    start_scheduler()
