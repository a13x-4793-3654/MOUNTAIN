# MOUNTAIN 設定値リファレンス

MOUNTAIN 配下の各コンポーネントで使用する設定値を一覧化したものです。

> **資格情報の取り扱い**
> 実際の値を書き込むファイル（`.env` / `config.php` / `alps_config.py`）はすべて
> `.gitignore` 済みです。リポジトリにはテンプレート（`*.sample` / `*.example.*`）のみを
> 収録しています。実値は Vault などで別管理してください。

## 目次

- [MOUNTAIN アプリ（app/）](#mountain-アプリapp)
  - [データベース / CORS](#データベース--cors)
  - [認証（Entra ID）](#認証entra-id)
  - [共通カレンダー連携](#共通カレンダー連携)
  - [SIP / WebRTC ソフトフォン](#sip--webrtc-ソフトフォン)
  - [capis 連携（FreePBX 自作 API）](#capis-連携freepbx-自作-api)
  - [CTI ドライバ](#cti-ドライバ)
  - [機微情報の暗号化](#機微情報の暗号化)
  - [入力補助（外部公開 API）](#入力補助外部公開-api)
  - [モックデータ自動初期化（DF 専用）](#モックデータ自動初期化df-専用)
  - [土台データの自動セットアップ](#土台データの自動セットアップ)
  - [Docker Compose 用](#docker-compose-用)
- [ALPS（services/alps/）](#alpsservicesalps)
  - [CTI API 設定（config.php）](#cti-api-設定configphp)
  - [AGI スクリプト設定（alps_config.py）](#agi-スクリプト設定alps_configpy)
- [環境ごとの設定方針](#環境ごとの設定方針)

---

## MOUNTAIN アプリ（app/）

バックエンドは pydantic-settings を使用し、`app/backend/app/config.py` で定義されています。
環境変数名は**設定名の大文字**です（例: `auth_mode` → `AUTH_MODE`）。
`app/.env.sample` をコピーして `.env` を作成してください。

### データベース / CORS

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `DATABASE_URL` | Compose の `db:5432/mountain` | 接続先 PostgreSQL。Compose 既定のまま使う場合は設定不要 |
| `POSTGRES_USER` | `mountain` | DB ユーザー。**本番では必ず変更** |
| `POSTGRES_PASSWORD` | `mountain` | DB パスワード。**本番では必ず変更** |
| `POSTGRES_DB` | `mountain` | データベース名 |
| `CORS_ORIGINS` | `*` | 許可オリジン（カンマ区切り）。本番はリバースプロキシ同一オリジンのため制限する |

### 認証（Entra ID）

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `AUTH_MODE` | `dev` | `entra` = 本番（トークン検証あり） / `dev` = 検証なしで既定ユーザーとして動作 |
| `ENTRA_TENANT_ID` | 空 | Entra テナント ID |
| `ENTRA_API_CLIENT_ID` | 空 | API アプリのクライアント ID。トークンの `aud` を検証する |
| `ENTRA_SPA_CLIENT_ID` | 空 | フロント（SPA）のクライアント ID。ブラウザの MSAL が使用 |
| `ENTRA_API_SCOPE` | 空 | API スコープ。未設定なら `api://<ENTRA_API_CLIENT_ID>/access_as_user` |
| `ENTRA_GROUP_USERS` | 空 | ログインを許可する M365 グループ。空なら制限なし |
| `ENTRA_GROUP_ADMINS` | 空 | 管理操作を許可するグループ（`is_admin` 判定に使用） |
| `ENTRA_ADMIN_UPNS` | 空 | 管理者扱いにする UPN のカンマ区切り。グループを使わない構成向け |
| `ENTRA_AUTO_PROVISION` | `True` | 初回サインイン時に未登録ユーザーを自動登録するか |
| `DEV_USER_ID` | `00000000-...-000000000001` | `dev` モードで操作者として扱う既定ユーザー |

> `AUTH_MODE=dev` は**認証を行いません**。検証環境以外では必ず `entra` にしてください。

### 共通カレンダー連携

やり取り履歴の新規登録・未連携履歴の編集時に、チェックした場合だけ管理者指定の Microsoft 365 グループの
既定予定表へ予定を作成します。Teams を利用する場合は、そのチームの背後にある
Microsoft 365 グループを指定します。チャネル ID や共有メールボックスのアドレスは指定できません。
Teams のチャネル会議やオンライン会議リンクを作成する機能ではありません。

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `CALENDAR_ENABLED` | `False` | 連携を有効にする。`AUTH_MODE=entra` と下記の設定がそろった場合のみ利用可能 |
| `CALENDAR_GROUP_ID` | 空 | 登録先の Microsoft 365 グループ Object ID（UUID）。全ユーザー共通、サーバー側で固定 |
| `CALENDAR_NAME` | `共通カレンダー` | 画面に表示する登録先の名前 |
| `APP_PUBLIC_URL` | 空 | 履歴リンクに使う HTTPS オリジン（例 `https://mountain.example.com`）。パス・クエリ・フラグメント・資格情報は禁止。未設定時は新規の予定登録を無効化 |
| `ENTRA_API_CLIENT_SECRET` | 空 | `ENTRA_API_CLIENT_ID` の **API アプリ**で発行したクライアントシークレットの値。シークレット ID や SPA アプリの資格情報ではない |

**Entra 管理者による設定**

1. 既存の SPA → MOUNTAIN API のサインインを構成する（`AUTH_MODE=entra`、テナント・API・SPA の各 ID、
   `access_as_user` スコープ）。SPA のリダイレクト URI は HTTPS の実際の公開 URL にする。
2. **API アプリ登録**の「API のアクセス許可」に Microsoft Graph の
   **委任されたアクセス許可 `Group.ReadWrite.All`** を追加し、テナントの管理者同意を付与する。
   この権限はグループ全般への広い委任権限なので、組織の承認を得てから有効にする。
   グループ予定の作成は `Calendars.ReadWrite` やアプリケーション権限だけでは実行できない。
   「カレンダー」で個人予定表の本文も読むため、**委任された `Calendars.Read`** も追加して管理者同意を付与する。
   読み取り機能に `Calendars.ReadWrite` は不要。権限追加後は再サインインする。
3. API アプリの「証明書とシークレット」でクライアントシークレットを発行し、
   値を `ENTRA_API_CLIENT_SECRET` に安全に配置する。有効期限を監視し、期限前にローテーションする。
   ブラウザ設定・ソースコード・ログに値を含めない。
4. 登録先グループのメンバーとして、利用者が予定を作成できることを確認する。
   MOUNTAIN 側でも契約画面等の閲覧権限と `action.contract.link` 権限が必要。
5. `CALENDAR_GROUP_ID` / `CALENDAR_NAME` / `APP_PUBLIC_URL` を指定し、`CALENDAR_ENABLED=True` にして API を再作成する。
   Compose の場合は `docker compose up -d --build api web`。

バックエンドは検証済みの MOUNTAIN API 用アクセストークンを
[On-Behalf-Of フロー](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-on-behalf-of-flow)
で Graph 用の委任トークンに交換し、
[`POST /groups/{id}/events`](https://learn.microsoft.com/en-us/graph/api/group-post-events?view=graph-rest-1.0)
を呼び出します。API 用トークンをそのまま Graph へ転送しません。
クライアントシークレット・アクセストークンは DB や公開 `/api/config` に保存・公開しません。
利用者のトークンを保存しないため、バックグラウンドでの無人再試行は行いません。

**動作と障害時の扱い**

予定の開始・終了はやり取り日時とは別に日本時間で入力し、明示的な UTC に変換して Graph に渡します。
件名に契約番号と概要、本文に概要・詳細メモ・登録者・履歴への URL を転記します。グループの共有範囲を確認してください。
リンクは設定済みの `APP_PUBLIC_URL` から作成し、アクセス時は MOUNTAIN のサインイン・契約閲覧権限が必要です。
既に作成済みの予定の本文は一括更新しません。
明示的な出席者は追加しませんが、グループ側の購読・通知設定に基づく動作は Microsoft 365 に従います。

履歴と予定登録要求は同一 DB トランザクションで先に保存します。
Graph への通信・権限・認証エラーでも履歴は残り、画面に予定の失敗理由を表示します。
元の登録ユーザーが履歴一覧から予定だけを再試行してください。
タイムアウト等で結果不明の場合も同じ要求 ID / 保存済みペイロード / `transactionId` を再利用します。
すでに登録済みの要求では Graph を再呼び出ししません。同じ履歴への別の登録要求も画面と API の両方で拒否します。
未連携の履歴は「編集」から初回登録できます。登録要求が存在する履歴は失敗・処理中を含めて新規登録できず、
元の要求の再試行のみ可能です。通常の履歴編集は引き続き可能で、確定済み要求の再送が後続の編集を巻き戻すこともありません。
予定を再試行する前に `CALENDAR_GROUP_ID` が変更されていた場合は、別の予定表に誤登録しないよう拒否します。
履歴の編集・削除は予定表に同期しません。予定を変更・削除する場合は Outlook で操作してください。

無効・未設定・dev 認証の場合はチェックボックスを無効表示しますが、履歴のみの登録は通常どおり可能です。
既存 DB には API 起動時に `communication_calendar_events` を冪等に追加します（DDL 実行権限が必要）。
移行失敗時は起動を失敗させるので、DB 権限と API の起動ログを確認してください。
モック初期化は外部の予定を削除しないため、`MOCK_RESET_ENABLED=True` の環境で本番予定表を使用しないでください。

設定後はテスト用グループで、未チェック時は予定が作成されないこと、日本時間の開始・終了が正しいこと、
権限不足が履歴と区別して表示されること、同じ要求の再試行で予定が重複しないことを確認してください。

**カレンダー表示**

メニューの「カレンダー」はサインインしたユーザーが利用できる読み取り専用画面です。
自分の既定 Outlook 予定表と、設定されたグループの既定予定表を日・週・月の表示で重ね合わせます。
表示は日本時間で、終日の終了日は排他的です。ドラッグによる日時変更や予定の編集は行いません。
個人の予定はユーザー本人の OBO トークンで
[`calendarView`](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0)、
グループの予定は
[`group calendarView`](https://learn.microsoft.com/en-us/graph/api/group-list-calendarview?view=graph-rest-1.0)
から繰り返し予定・例外を含めて取得します。別ユーザーのメールボックス ID は指定できません。
個人の読み取りに失敗しても、グループ・ICS は別々に表示し、失敗した予定表を明示します。
個人予定を共通 DB・共有キャッシュに保存しません。Graph 連携が無効でも ICS は利用できます。

1 回の表示期間は最大 62 日、各予定表は最大 5,000 件です。Graph はページングを追跡し、
最大 20 ページ・1 ページ 4 MiB・合計 16 MiB・取得 60 秒を超える場合はエラーにします。
黙って一部だけを表示せず、期間を短くするよう案内します。

**ユーザー別 ICS**

URL 購読と UTF-8 の `.ics` ファイル（最大 1 MiB）を登録できます。
ソース・色・表示選択・表示形式はユーザー別に保存され、管理者を含めて他ユーザーのソースは参照できません。
URL はカレンダー画面を開く／表示を更新する際に取得し、ファイルは保存したスナップショットを表示します。
ファイル内容や URL を差し替える場合は、そのソースを削除して追加し直してください。
ICS は表示専用で、Outlook への取り込み・予定作成は一切行いません。

購読 URL とファイル内容は `SENSITIVE_ENC_KEY` で暗号化保存します。
`AUTH_MODE=entra` ではキー未設定時に機能を拒否します。キーは既存の機微情報と共通のため、
既存暗号化データの移行なしに変更しないでください。URL に含まれる購読用トークンをログや問い合わせに貼らないでください。
購読先は公開 HTTPS の標準ポートのみ対応し、社内アドレス・localhost・メタデータサービス等は拒否します。
DNS・リダイレクトを検査し、検査済み IP に接続して元のホスト名による TLS 検証を行います。
取得・解析の失敗はそのソースのエラーとして表示し、古いキャッシュを最新情報として代用しません。

ソース数は 1 ユーザー 100 件までです。購読取得は最大 3 リダイレクト・全体 20 秒、
DNS／接続／TLS は各 4 秒、読み取りは 5 秒で制限し、圧縮応答は拒否します。
解析は分離プロセスで実行し、API ワーカー当たり同時 2 件・待ち時間 1 秒・実行 8 秒までです。
混雑時はそのソースに再試行可能なエラーを表示します。Linux ではメモリ 512 MiB と CPU 時間も制限します。
解析結果は最大 8 MiB です。

終日・複数日・UTC・TZID／VTIMEZONE・日本時間として扱う浮動日時を読み取ります。
繰り返しは DAILY／WEEKLY／MONTHLY／YEARLY、RDATE／EXDATE、個別の変更・キャンセルに対応します。
同一 UID／RECURRENCE-ID は SEQUENCE 等を考慮して重複排除します。
サブデイリー、複数 RRULE、EXRULE、RANGE、期間形式 RDATE、BYHOUR／BYMINUTE／BYSECOND／
BYYEARDAY／BYWEEKNO、COUNT と UNTIL の併記などは明示的に拒否します。
アラーム・添付は実行／取得せず警告します。

ICS は VCALENDAR 2.0／VEVENT を対象に、最大 6,000 コンポーネント・深さ 4・
30,000 展開行・1 行 16 KiB、予定の長さ 366 日までです。
RRULE は INTERVAL 1–366、COUNT 1–50,000、展開全体を 100,000 走査日／50,000 候補に制限します。
古すぎる開始日時などで予算を超える場合も空の成功結果にはせず、対象ソースの調整を案内します。
独自タイムゾーンは最大 16 件・64 遷移・512 RDATE・2,000,000 走査日、
YEARLY 規則（COUNT なし）に制限します。

### SIP / WebRTC ソフトフォン

ブラウザ内ソフトフォンから PBX へ接続するための設定です。

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `SIP_WSS_URL` | 空 | 交換機の WebSocket。例: `wss://sbc.intra.example.com:6968/ws` |
| `SIP_REALM` | 空 | SIP ドメイン（realm）。例: `sbc.intra.example.com` |
| `SIP_STUN` | `stun:stun.l.google.com:19302` | NAT 越え用 STUN サーバー |
| `SIP_OUTBOUND_PREFIXES` | 空 | 外線発信プレフィックス。`9101:026-...,9102:026-...` 形式 |

### capis 連携（FreePBX 自作 API）

在席・留守電・録音・内線照会のために、ALPS の CTI API を呼び出します。

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `CTI_API_URL` | 空 | CTI API のエンドポイント URL |
| `CTI_API_KEY` | 空 | `X-API-KEY` に送る値。**ALPS 側の `CAPIS_API_SECRET_KEY` と一致させる** |
| `CTI_CALLBACK_TOKEN` | 空 | PBX からのコールバックを検証するトークン |
| `CTI_API_VERIFY_TLS` | `False` | PBX が自己署名証明書のため既定で検証しない（社内閉域前提） |

### CTI ドライバ

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `CTI_PROVIDER` | `simulator` | `simulator` = 検証用 / `pbx` = 本番の交換機接続 |
| `CTI_RING_SECONDS` | `2` | シミュレータの呼び出し音の秒数 |
| `CTI_PBX_HOST` | 空 | PBX ホスト（`pbx` のとき必須） |
| `CTI_PBX_PORT` | `0` | PBX ポート |
| `CTI_PBX_USERNAME` | 空 | PBX 接続ユーザー |
| `CTI_PBX_SECRET` | 空 | PBX 接続シークレット |
| `CTI_RECORDING_DIR` | `/var/mountain/recordings` | 通話録音の保管場所 |

> 未設定のまま `CTI_PROVIDER=pbx` にすると、pbx ドライバは 503 を返します。

### 機微情報の暗号化

口座番号・カード番号は BYTEA に暗号化して保存し、
権限 `action.sensitive.reveal` の保持者のみが復号表示できます。

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `SENSITIVE_ENC_KEY` | 空 | 任意の文字列。内部で SHA-256 から Fernet 鍵を導出する |

> ⚠️ 未設定の場合は**開発用の既定鍵**にフォールバックします。
> **本番では必ず環境変数で上書きしてください。**
> この値を変更すると既存の暗号化データは復号できなくなります。

### 入力補助（外部公開 API）

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `GBIZ_API_TOKEN` | 空 | gBizINFO の API トークン（法人番号→企業情報）。<https://info.gbiz.go.jp/> で無料登録して取得 |

郵便番号→住所（zipcloud）と銀行・支店（bank.teraren.com）は**認証不要**のため設定は不要です。
`GBIZ_API_TOKEN` が空の場合、法人番号検索のみ 503 を返し、他の入力補助は通常どおり動作します。

### モックデータ自動初期化（DF 専用）

毎日決まった時刻に、その日に登録・編集・削除したデータを元に戻し、
同梱のモックデータだけの状態へ自動復元します。

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `MOCK_RESET_ENABLED` | `False` | `true` で有効。**本番は必ず空（無効）にする** |
| `MOCK_RESET_AT` | `00:00` | 実行時刻（JST・`HH:MM`） |
| `MOCK_RESET_BASELINE_PATH` | 空 | 復元元ファイル。空なら同梱の `app/mock_baseline.sql` |

### 土台データの自動セットアップ

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `AUTO_PROVISION_ENABLED` | `True` | 空の DB に初回接続したとき、区分マスタ・権限・ロール・着信アナウンス定義・システム利用者 2 件を `app/baseline.sql` から自動生成する（冪等） |

有効にしておくと、本番は「空のデータベースを用意して起動するだけ」で初期化が完了します。
既にデモ seed が入っている環境では「導入済み」と判定して何もしません。

### Docker Compose 用

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `WEB_PORT` | `8080` | フロント（nginx）を公開するホストポート |

---

## ALPS（services/alps/）

### CTI API 設定（config.php）

`services/alps/var_www_html/cti_apis/config.example.php` をコピーして `config.php` を作成します。

```bash
cp config.example.php config.php
chmod 640 config.php && chown root:apache config.php
```

#### API 認証キー

| 定数 | 説明 |
| --- | --- |
| `CAPIS_API_SECRET_KEY` | CTI API の `X-API-KEY`。**MOUNTAIN アプリの `CTI_API_KEY` と一致させる**<br>生成例: `openssl rand -base64 48 \| tr -d '/+=' \| cut -c1-50` |
| `BREW_TAP_API_SECRET_KEY` | Brew TAP API の `X-API-KEY`。環境変数 `BREW_FREEPBX_API_KEY` があればそちらが優先 |

#### Asterisk AMI

| 定数 | 既定値 | 説明 |
| --- | --- | --- |
| `AMI_HOST` | `127.0.0.1` | AMI ホスト。**localhost 固定を推奨** |
| `AMI_PORT` | `5038` | AMI ポート |
| `AMI_USERNAME` | — | AMI 専用ユーザー名 |
| `AMI_SECRET` | — | AMI パスワード |
| `AMI_TIMEOUT` | `3` | 接続タイムアウト（秒） |

`/etc/asterisk/manager_custom.conf` の設定例:

```ini
[cti_api]
secret = <強力なランダム文字列>
deny   = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
read   = system,call,user
write  = system,call,originate
```

#### 留守電・録音

| 定数 | 既定値 | 説明 |
| --- | --- | --- |
| `VOICEMAIL_CONTEXT` | `default` | Asterisk の voicemail コンテキスト |
| `VOICEMAIL_BASE_DIR` | `/var/spool/asterisk/voicemail/<context>` | 留守電の格納先 |
| `VOICEMAIL_STORAGE_MODE` | `file` | `file` = ファイルベース / `db` = FreePBX 15+ の ODBC ストレージ |
| `RECORDING_BASE_DIR` | `/var/spool/asterisk/monitor` | 通話録音の格納先 |

#### FreePBX データベース

DB の資格情報は FreePBX 自身の設定ファイルから読み込むため、直接記載しません。

| 定数 | 既定値 | 説明 |
| --- | --- | --- |
| `FREEPBX_CONF_PATH` | `/etc/freepbx.conf` | `$amp_conf['AMPDBUSER']` / `['AMPDBPASS']` の読み込み元 |
| `DB_HOST` | `127.0.0.1` | DB ホスト |
| `DB_DATABASE` | `asterisk` | データベース名 |
| `DB_CHARSET` | `utf8mb4` | 文字コード |

#### CORS

| 定数 | 既定値 | 説明 |
| --- | --- | --- |
| `CORS_ALLOWED_ORIGINS` | localhost:8080 / :3000 | 完全一致で許可するオリジン（JSON 配列） |
| `CORS_ALLOWED_ORIGIN_PATTERN` | 空 | 正規表現で許可するオリジン。社内ドメインなどを指定。不要なら空文字 |

#### Brew TAP

| 定数 | 既定値 | 説明 |
| --- | --- | --- |
| `TAP_CONTEXT` | `brew-tap-otp` | 発信先の dialplan コンテキスト |
| `TAP_PRIORITY` | `1` | dialplan の優先度 |
| `TAP_DEFAULT_CALLER_ID` | `Brew TAP` | 発信者番号表示 |
| `TAP_DEFAULT_TTL_SECONDS` | `600` | 一時アクセスパスの既定有効期間（秒） |

### AGI スクリプト設定（alps_config.py）

`services/alps/agi-bin/alps_config.example.py` をコピーして `alps_config.py` を作成します。

```bash
cp alps_config.example.py alps_config.py
chmod 640 alps_config.py && chown root:asterisk alps_config.py
```

#### 顧客情報 API

| 設定 | 環境変数での上書き | 説明 |
| --- | --- | --- |
| `API_KEY` | `VODKA_API_KEY` | 顧客情報 API の `X-API-KEY` |
| `SEARCH_API_TEMPLATE` | `VODKA_SEARCH_API_TEMPLATE` | 検索エンドポイント。`{caller}` が発信元番号に置換される |
| `API_TIMEOUT` | — | タイムアウト（秒）。既定 `5` |

#### Teams 通知ルーティング

| 設定 | 説明 |
| --- | --- |
| `TEAMS_ROUTES` | 着信番号（DID）ごとの通知先。`'<DID>': ('<Webhook URL>', '<表示用番号>', '<折り返しプレフィックス>')` |
| `DEFAULT_TEAMS_ROUTE` | `TEAMS_ROUTES` に一致しない場合の既定ルート |
| `TEAMS_TIMEOUT` | 通知のタイムアウト（秒）。既定 `5` |

> ⚠️ Power Automate の Webhook URL は末尾に署名（`sig=`）を含むため、**URL 自体が認証情報**です。
> URL を知っている人は誰でもフローを起動できます。設定ファイル以外に記載しないでください。

#### 音声ファイル

Asterisk の sounds ディレクトリからの相対パス（拡張子なし）で指定します。

| 設定 | 既定値 | 再生タイミング |
| --- | --- | --- |
| `SOUND_START_BGM` | `custom/ALPS_Started_BGM` | 応答直後 |
| `SOUND_START_ANNOUNCE` | `custom/ALPS_Start_Announce` | 照会開始の案内 |
| `SOUND_ALLOWED_BGM` | `custom/ALPS_Allowed_BGM` | 許可時 |
| `SOUND_END_ALLOWED` | `custom/ALPS_End_Allowed` | 許可時の終了案内 |
| `SOUND_DENIED_BGM` | `custom/ALPS_Denied_BGM` | 拒否時 |
| `SOUND_DENIED_INTRO` | `custom/ALPS_Denied_1` | 拒否案内の冒頭 |
| `SOUND_DENIED_OUTRO` | `custom/ALPS_Denied_99` | 拒否案内の末尾 |
| `SOUND_DENIED_ANONYMOUS` | `custom/ALPS_End_Anonymouns` | 非通知拒否時 |
| `SOUND_ERROR` | `custom/ALPS_Error_Announce` | 想定外エラー時 |

#### 拒否理由コード

`SOUND_DENY_REASONS` と `DENY_REASON_LABELS` の 2 つで、音声と Teams カードの表示文言を対応付けます。

| コード | 既定の表示文言 | 音声 |
| --- | --- | --- |
| `1` | 総合的判断による拒否 | `custom/ALPS_Denied_GeneralReason` |
| `2` | 複数回の間違い電話による拒否 | `custom/ALPS_Denied_ManyInvalidCall` |
| `3` | 一時的な拒否 | `custom/ALPS_Denied_Timeout` |

---

## 環境ごとの設定方針

コードは全環境で同一とし、**環境変数のみで差し替える**方針です（DF ≡ Prod）。

| 設定 | DF（開発・テスト・検証） | 本番 |
| --- | --- | --- |
| `AUTH_MODE` | `dev`（Entra 登録が整うまで） | `entra` |
| `CTI_PROVIDER` | `simulator` | `pbx` |
| `MOCK_RESET_ENABLED` | `true` | **空（無効）** |
| `AUTO_PROVISION_ENABLED` | `True`（seed 済みなら no-op） | `True`（空 DB から土台生成） |
| `CORS_ORIGINS` | `*` | 同一オリジンに制限 |
| `SENSITIVE_ENC_KEY` | 開発用の値 | **専用の値を必ず設定** |
| `POSTGRES_PASSWORD` | 開発用の値 | **強固な値へ変更** |

### 本番で必ず確認すること

- [ ] `SENSITIVE_ENC_KEY` を設定した（既定鍵のままにしない）
- [ ] `POSTGRES_PASSWORD` を変更した
- [ ] `AUTH_MODE=entra` にした
- [ ] `MOCK_RESET_ENABLED` が空である
- [ ] `CORS_ORIGINS` を同一オリジンに制限した
- [ ] `CTI_API_KEY` と ALPS 側 `CAPIS_API_SECRET_KEY` が一致している
- [ ] `.env` / `config.php` / `alps_config.py` のパーミッションを絞った
