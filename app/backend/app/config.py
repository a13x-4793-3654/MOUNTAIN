from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # 接続先DB（既定は Compose の postgres サービス）
    database_url: str = "postgresql+psycopg://mountain:mountain@db:5432/mountain"
    # CORS 許可オリジン（カンマ区切り）。開発は "*"、本番はリバースプロキシ同一オリジン。
    cors_origins: str = "*"

    # ---- 認証（Microsoft 365 / Entra ID ログイン）----
    # auth_mode: "entra"（本番＝Entra IDトークン検証）/ "dev"（検証なし・既定ユーザーで動作）。
    # DFも本番も最終的に entra。Entra登録が整うまでは dev で画面を維持できる。
    auth_mode: str = "dev"
    # Entra テナントID（例: 5e695010-...）。
    entra_tenant_id: str = ""
    # 受け入れるトークンの対象（API アプリの クライアントID）。トークンの aud を検証する。
    entra_api_client_id: str = ""
    # フロント(SPA)のクライアントID（ブラウザのMSALが使用）。
    entra_spa_client_id: str = ""
    # APIスコープ（未設定なら api://<entra_api_client_id>/access_as_user を使用）。
    entra_api_scope: str = ""
    # 利用可能なM365グループ（このグループ所属のみログイン可）。空なら無効。
    entra_group_users: str = ""
    # 管理操作が可能なグループ（is_admin 判定・未登録ユーザーの自動登録可否）。
    entra_group_admins: str = ""
    # 管理者扱いにするユーザー（UPN のカンマ区切り）。グループを使わない構成向け。
    entra_admin_upns: str = ""
    # 初回サインイン時に未登録ユーザーを自動登録するか（既定 True）。
    # Azure 側で「割り当て必須」にしておけば、割り当てた人だけがサインインできる。
    entra_auto_provision: bool = True
    # dev モードで操作者として扱う既定ユーザー（seedの管理者）。
    dev_user_id: str = "00000000-0000-0000-0000-000000000001"

    # ---- やり取り履歴から Microsoft 365 グループ予定表へ登録 ----
    calendar_enabled: bool = False
    calendar_group_id: str = ""
    calendar_name: str = "共通カレンダー"
    # API アプリの資格情報。ブラウザには渡さず、委任 OBO トークン交換にのみ使用する。
    entra_api_client_secret: SecretStr = SecretStr("")

    # ---- SIP / WebRTC（ブラウザ内ソフトフォン：本番PBXへ接続）----
    # 交換機のWebSocket(WSS)。例: wss://sbc.intra.example.com:6968/ws
    sip_wss_url: str = ""
    # SIPドメイン（realm）。例: sbc.intra.example.com
    sip_realm: str = ""
    # STUNサーバ（NAT越え）。
    sip_stun: str = "stun:stun.l.google.com:19302"
    # 外線発信プレフィックス（"9101:026-...,9102:026-..." 形式）。
    sip_outbound_prefixes: str = ""

    # ---- capis（FreePBX 自作API：在席/留守電/録音/内線照会）----
    cti_api_url: str = ""
    cti_api_key: str = ""
    cti_callback_token: str = ""
    # PBXが自己署名証明書のため既定でTLS検証しない（社内閉域）。
    cti_api_verify_tls: bool = False

    # ---- CTI（電話交換機連携）----
    # 電話まわりのドライバ選択：simulator（DF既定）/ pbx（本番）。
    # 本番で交換機を接続したら pbx に切替え、CTI_PBX_* を構成する。画面・DBは共通。
    cti_provider: str = "simulator"
    # シミュレータの呼び出し音（発信中→通話中）に要する秒数。
    cti_ring_seconds: int = 2
    # 本番PBX接続設定（未設定なら pbx ドライバは 503 を返す）。
    cti_pbx_host: str = ""
    cti_pbx_port: int = 0
    cti_pbx_username: str = ""
    cti_pbx_secret: str = ""
    # 通話録音の保管場所（本番はAIMS等が引き継ぐ場所を指す）。
    cti_recording_dir: str = "/var/mountain/recordings"

    # ---- 機微情報（口座・カード番号）の暗号化キー ----
    # 実番号は BYTEA に暗号化保存し、権限（action.sensitive.reveal）保持者のみ復号表示する。
    # 任意の文字列を指定可（内部で SHA-256 から Fernet 鍵を導出）。
    # 未設定の場合は開発用の既定鍵にフォールバックする（本番は必ず環境変数で上書きすること）。
    # DF≡Prod：コードは同一、鍵は環境変数 SENSITIVE_ENC_KEY のみで差し替える。
    sensitive_enc_key: str = ""

    # ---- 入力補助（外部公開API）----
    # 郵便番号→住所（zipcloud）と 銀行・支店（bank.teraren.com）は認証不要のため設定不要。
    # 法人番号→企業情報（gBizINFO）だけは無料の利用登録で得るAPIトークンが必要。
    # 未設定なら法人番号検索のみ 503（未設定）を返し、他の入力補助は通常動作する。
    # DF≡Prod：コードは同一。トークンは環境変数 GBIZ_API_TOKEN でのみ差し替える。
    gbiz_api_token: str = ""

    # ---- モックデータの自動初期化（DF専用機能）----
    # 毎日決まった時刻に、その日に登録・編集・削除したデータをすべて元に戻し、
    # もともとのモックデータ（=同梱のスナップショット）だけの状態へ自動で戻す。
    # DF≡Prod：コードは同一。DFのみ MOCK_RESET_ENABLED=true で有効化し、本番は未設定＝無効。
    # 既定は無効。有効化しない限りスケジューラも手動APIも一切動作しない（安全側）。
    mock_reset_enabled: bool = False
    # 初期化を実行する時刻（日本時間 JST=UTC+9、"HH:MM" 表記）。既定は深夜0時。
    mock_reset_at: str = "00:00"
    # 復元の“お手本”ファイル。空なら app/mock_baseline.sql（イメージ同梱）を使用する。
    mock_reset_baseline_path: str = ""

    # ---- 本番導入用の土台データ 自動セットアップ ----
    # 空のデータベースに最初に接続したとき、業務の土台（区分マスタ・権限・着信アナウンス
    # 定義・システム利用者2件）をアプリ自身が自動で用意する（app/baseline.sql・冪等）。
    # 既にデモseedが入っている DF では「導入済み」と判定して何もしない（no-op）。
    # DF≡Prod：コードは同一。既定 True で DF・本番とも同じ挙動（本番は空DBから土台生成）。
    # 何らかの事情で自動セットアップを止めたいときのみ AUTO_PROVISION_ENABLED=false。
    auto_provision_enabled: bool = True


settings = Settings()
