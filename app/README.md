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

## 請求残額とダッシュボード

ホームの「期日超過の請求」と「対応が必要なこと」は、請求・入金画面と同じく、
契約ごとの入金合計（返金はマイナス）を古い請求から充当した**未入金の残額**で判定します。
充当順は発生日、作成日時、請求 ID の昇順です。取消済みの請求には充当しません。

- 支払期限を過ぎ、残額が正の請求だけを対象にします。入金済み・取消済みは含みません。
- 一部入金の場合、期日超過の合計金額と対応項目の表示金額は請求総額ではなく残額です。
- 対応項目には期日の古い請求を最大 5 件表示しますが、集計値は対象の全件を含みます。
- 入金の登録・編集・削除後は、次回の画面読み込み時に再計算します。保存済みの請求状態や残額を書き換える必要はありません。

### 回帰テスト

バックエンドの依存関係をインストールし、PostgreSQL のテスト用データベースを用意して実行します。
テストは専用接続内の一時テーブルだけを使用し、各ケース終了時にロールバックします。
`TEST_DATABASE_URL` 未設定時はスキップします。

```powershell
cd backend
$env:TEST_DATABASE_URL = "postgresql+psycopg://localhost/mountain_test"
python -m unittest discover -s tests -v
```

## メモ

- `person_phones` テーブルは Q54（名義の電話番号は保持しない）方針によりコメントで無効化しています（有効テーブルは 49）。
- 口座番号・カード番号は本スライスでは「マスク済み表示」のみを扱います（暗号化した実値の開示は今後のフェーズ）。
- 本番のリバースプロキシ（mountain-proxy）配下に載せる場合は、外側 nginx から web コンテナへ proxy_pass する構成に切り替えます。
