# MOUNTAIN アプリ（最初の1機能：契約の一覧・詳細）

設計書（ワークブック v42）の DDL をもとに作った、実際に動くアプリの土台です。
「契約一覧」→「契約詳細（基本情報・紐付：会社／名義／口座）」までを、実データベースで動く形で用意しています。

## 構成

```
app/
├─ docker-compose.yml     … db + api + web を一括起動
├─ .env.sample            … 環境変数のサンプル（コピーして .env に）
├─ db/
│  ├─ schema.sql          … 49テーブルの PostgreSQL スキーマ（設計 DDL 由来）
│  └─ seed.sql            … 動作確認用のデモデータ（本番データではありません）
├─ backend/               … FastAPI（Python）REST API
│  └─ app/
│     ├─ main.py          … /api/health ＋ ルーター登録
│     └─ routers/
│        ├─ contracts.py  … GET /api/contracts, GET /api/contracts/{id}
│        └─ meta.py       … GET /api/masters/{category}（区分・状態の選択肢）
└─ frontend/              … React + TypeScript + Fluent UI（Azure/D365 風）
   └─ src/
      ├─ components/Layout.tsx     … 上部バー＋左ナビ
      ├─ pages/ContractsList.tsx   … 契約一覧（検索・絞り込み）
      └─ pages/ContractDetail.tsx  … 契約詳細（タブ：基本情報／紐付…）
```

## 技術スタック

- フロント：React 18 + TypeScript + Vite + Fluent UI v9（Microsoft デザイン）
- API：Python FastAPI + SQLAlchemy（psycopg3）
- DB：PostgreSQL 16（pgcrypto / pg_trgm）

## 起動方法（Docker がある環境。例：mountain-df）

```bash
cp .env.sample .env          # 必要に応じてパスワード等を変更
docker compose up -d --build
```

- 初回起動時、`db/schema.sql`（テーブル作成）→ `db/seed.sql`（デモデータ）が自動で流し込まれます。
- 画面：`http://<ホスト>:8080/`
- API：`http://<ホスト>:8080/api/contracts`（web コンテナの nginx が /api を api コンテナへ中継）

## 主な API

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/health` | 稼働確認（DB 接続可否も返す） |
| GET | `/api/contracts?q=&status=&category=` | 契約一覧（検索・絞り込み）。既定は終了日が近い順 |
| GET | `/api/contracts/{id}` | 契約詳細（会社・名義・口座の紐付、外部管理番号、フラグ） |
| GET | `/api/masters/{category}` | 選択肢マスタ（例：`contract_status` / `contract_category`） |

## 開発（ローカル・Docker なしでも可）

- フロント：`cd frontend && npm install && npm run dev`（`http://localhost:5173`、`/api` は 8000 へプロキシ）
- API：`cd backend && pip install -r requirements.txt && uvicorn app.main:app --reload`
  - DB は別途 PostgreSQL が必要。`DATABASE_URL` 環境変数で接続先を指定。

## メモ

### やり取り履歴から共通カレンダーに予定を登録

契約詳細の「やり取り履歴」→「記録」で「スケジュール登録」をチェックすると、
やり取り日時とは別の開始・終了日時（日本時間）を指定できます。
登録先は管理者が指定した **Microsoft 365 グループの既定予定表**です。
個人の Outlook・共有メールボックス・Teams のチャネル会議作成には対応しません。

履歴と予定登録要求を先に一緒に保存し、その後サインインユーザーの委任権限で
予定を作成します。件名には契約番号と概要、本文には概要・詳細メモ・登録者を転記するため、
グループ内の共有範囲に注意してください。未チェック時は従来どおり履歴のみを保存します。

予定表への登録に失敗した場合は履歴一覧にエラーを表示し、同じユーザーが予定のみを
再試行できます。要求 ID と Graph の `transactionId` を保持して重複を防ぎます。
通信エラー時に新しい履歴を作り直すのではなく、同じ登録の再試行を使用してください。
履歴の編集・削除は Outlook 側の予定に同期しません。予定の変更・削除は Outlook で行ってください。

初期状態では無効です。Entra の委任権限への管理者同意と環境変数の設定については
[設定値リファレンス](../docs/CONFIGURATION.md#共通カレンダー連携)を参照してください。
追加テーブル `communication_calendar_events` は新規 DB の `schema.sql` と
API 起動時の冪等な移行処理の両方で作成されます。既存 DB の再初期化は不要です。

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/api/contracts/{contract_id}/communications` | `calendar` 未指定なら履歴のみ。指定時は `{request_id, starts_at, ends_at}` を追加 |
| POST | `/api/communications/{comm_id}/calendar/retry` | 保存済みの予定登録要求のみを再試行。元の登録ユーザーと `action.contract.link` 権限が必要 |

予定連携時の応答には `calendar.status`（`pending` / `created` / `failed`）と `error` を含みます。
HTTP 200 でも `failed` は予定登録の成功を意味しません。履歴は保存済みです。
同じ `request_id` の再送は同じ履歴を返し、異なる内容や別ユーザーによる再利用は 409 で拒否します。
登録先・件名・本文・日時は初回の内容を保持し、再試行で書き換えません。

バックエンドの回帰テスト: `cd backend` → `python -m unittest discover -s tests -v`。
Graph 通信はモック化しており、テストでは実際の予定を作成しません。

### 既存機能の補足

- `person_phones` テーブルは Q54（名義の電話番号は保持しない）方針によりコメントで無効化しています（有効テーブルは 49）。
- 口座番号・カード番号は本スライスでは「マスク済み表示」のみを扱います（暗号化した実値の開示は今後のフェーズ）。
- 本番のリバースプロキシ（mountain-proxy）配下に載せる場合は、外側 nginx から web コンテナへ proxy_pass する構成に切り替えます。
