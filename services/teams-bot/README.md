# MOUNTAIN Teams Bot

Dokploy 上で動かす、接続確認と個人チャットでの契約検索に対応した Teams Bot です。
Microsoft 365 Agents Toolkit の `bot` テンプレートを基に、Teams SDK と Node.js 24 を使用しています。
Azure App Service や Azure のデータベースへアプリを配置する構成ではありません。

契約検索は任意設定です。利用者本人の OAuth トークンで既存の MOUNTAIN API を呼び、
既存の Entra 認証・グループ・RBAC をそのまま適用します。業務 API、DB、RBAC 自体は変更していません。
ALPS の Power Automate 通知の移行と、業務データの登録・変更・削除は未実装です。

## 公開経路

```text
Microsoft Teams
  -> Microsoft の Bot 接続サービス
  -> Cloudflare（オレンジ雲、HTTPS/443）
  -> 開放済みの経路
  -> Dokploy / Traefik（HTTPS/443、証明書あり）
  -> Bot コンテナ（HTTP/3978、/api/messages）
```

公開ホスト名は **`mountain-bot-prod-reg-jpn.hdk-atom.jp`**、
Microsoft 側に登録する Messaging endpoint は次の URL です。

```text
https://mountain-bot-prod-reg-jpn.hdk-atom.jp/api/messages
```

外向けの 3978/TCP 開放や Cloudflare Tunnel の追加は不要です。
コンテナの HTTP は、Dokploy 内部の Traefik から受ける通信にのみ使用します。

## 実装済みの機能

| 入力 / エンドポイント | 動作 |
| --- | --- |
| `ping` / `/ping` | `pong` を返す |
| `help` / `/help` | 接続確認・契約検索の案内を返す |
| `契約検索 キーワード` / `search キーワード` | 個人チャットで、本人の権限による契約検索。先頭の `/` にも対応。要接続設定 |
| `ログアウト` / `signout` | 個人チャットで MOUNTAIN 連携からサインアウト |
| その他のテキスト | プレーンテキストで返信。最大 2,000 Unicode コードポイント |
| `GET /healthz` | `{"status":"ok"}` を返す。プロセスの稼働確認のみ |
| `GET /`、`/privacy`、`/terms` | Bot の案内、契約検索を含むプライバシー・利用条件 |
| `POST /api/messages` | SDK の JWT 検証を通過した Teams アクティビティのみ受け付ける |

個人チャット、チームのチャネル、グループチャットに対応します。
チャネル・グループチャットでは Bot を追加し、`@MOUNTAIN Bot ping` のようにメンションしてください。
チャネルでは元のスレッドに応答します。添付ファイルの処理、AI/LLM、会話本文の永続化はありません。
単一テナント構成に加え、受信アクティビティの Teams テナント ID を照合します。
契約検索の結果は個人チャットにだけ返します。チャネルやグループでは OAuth の開始・検索を行いません。
サインインしたユーザーと Teams の送信者の Entra Object ID、テナント ID が一致することも確認します。

## 1. Microsoft 側の登録

**実行基盤が Dokploy でも、Teams と接続する Bot の登録・認証は Microsoft 側に必要です。**
このサービスには Bot 専用の Entra アプリを使用し、既存の SPA/API アプリの資格情報は流用しません。

1. Microsoft Entra ID に Bot 専用のアプリを登録します。
   サポートするアカウントは **この組織ディレクトリのみ（シングルテナント）** とします。
2. アプリの Application (client) ID と Directory (tenant) ID を控えます。
   アプリのサービスプリンシパル（Enterprise application）も存在することを確認します。
3. クライアントシークレットを作成し、**Value** を安全に保管します。Secret ID ではありません。
   有効期限の監視と更新は運用側で行います。
4. Azure Bot リソースを作成し、アプリの種類を **Single Tenant**、
   Microsoft App ID と Tenant ID を上記の登録と一致させます。
   これは Bot の接続登録であり、Azure にアプリの実行環境を作る手順ではありません。
5. Azure Bot の Configuration に上記の Messaging endpoint を設定します。
6. Channels で **Microsoft Teams** を有効にします。

新規の Multi Tenant Bot は選択しません。Managed Identity は Azure 上の実行基盤を
前提とするため、この Dokploy 構成ではクライアントシークレットを使用します。
接続確認だけなら Microsoft Graph の権限やユーザー OAuth は不要です。
契約検索を有効にする場合は、後述の MOUNTAIN API 向け OAuth 接続を追加します。
Azure Portal の「Test in Web Chat」は Teams 以外のチャネルなので、この実装では拒否します。

## 2. Cloudflare

対象ホスト名に限って設定します。既存の他サービスやゾーン全体の防御を無効化しないでください。

| 項目 | 設定 |
| --- | --- |
| DNS | 開放済み経路の公開 IP を向く A/AAAA、または既存の公開ホストへの CNAME |
| Proxy status | **Proxied（オレンジ雲）** |
| SSL/TLS | **Full (strict)**。Dokploy 側にもホスト名に合う有効な証明書を配置 |
| キャッシュ | Bot ホストのキャッシュをバイパス。API 応答をキャッシュしない |
| `/api/messages` | `POST`、JSON 本文、`Authorization: Bearer ...` を変更せず Dokploy に渡す |
| Access / Challenge | `/api/messages` に対話ログイン、CAPTCHA、JavaScript Challenge を要求しない |

Microsoft の Bot 接続サービスはブラウザ用のログイン画面や Challenge を完了できません。
WAF 等が誤検知する場合は、対象ホスト・パスと該当ルールに絞って調整します。
Cloudflare の防御を調整しても、Bot 側の JWT 検証は無効にしません。
**Flexible は使わないでください。** TLS の検証エラーを回避するために暗号化を弱めないでください。
Cloudflare Origin CA を使う場合は、証明書と秘密鍵を Dokploy の証明書管理へ登録し、
Git や Docker イメージには含めません。

## 3. Dokploy

既存リポジトリを参照する **Application** として追加し、Build Type に **Dockerfile** を選択します。
リポジトリのルートを Build Path にする場合の値です（Dokploy は Linux のパス表記）。

| 項目 | 設定 |
| --- | --- |
| Build Path | `/`（リポジトリルート） |
| Dockerfile Path | `services/teams-bot/Dockerfile` |
| Docker Context Path | `services/teams-bot` |
| Docker Build Stage | 空（最終の `runtime` ステージ） |
| Start command | 上書きしない。イメージの `node dist/index.js` を使用 |
| Host | `mountain-bot-prod-reg-jpn.hdk-atom.jp` |
| Path | `/` |
| Internal Path | 空 |
| Strip Path | 無効。`/api/messages` を保持 |
| Container Port | `3978` |
| HTTPS | 有効。Let's Encrypt または有効なカスタム証明書 |
| Advanced → Ports | Bot のポートは追加しない（ホストへ直接公開しない） |

Environment の **実行時環境変数** に、実際の値で以下を登録します。
`.env.example` は項目の確認用であり、空欄のままでは起動しません。

| 環境変数 | 値 |
| --- | --- |
| `CLIENT_ID` | Bot 専用 Entra アプリの Application (client) ID |
| `CLIENT_SECRET` | 同アプリのクライアントシークレットの **Value** |
| `TENANT_ID` | 同アプリの Directory (tenant) ID |
| `PORT` | `3978` |
| `NODE_ENV` | `production`（イメージの既定値） |

シークレットを Build Args、Dockerfile、Git、チャットへ貼らないでください。
イメージのビルドには認証情報は必要ありません。
`.dockerignore` はビルドに必要なソースと依存定義だけを許可し、`.env` 等を送りません。

コンテナは非 root ユーザーで動作し、ヘルスチェックは `/healthz` を確認します。
必須の認証情報が未設定なら、認証なしに切り替えることなく起動に失敗します。
本番エントリーポイントでは SDK の認証省略オプションを明示的に無効化しています。
本番で `npm run playground` を起動しないでください。

サーバーからは Microsoft のトークン発行、署名鍵の取得、Teams への返信に必要な
外向き HTTPS 通信が必要です。Cloudflare は受信経路であり、返信の送信先ではありません。
`/healthz` の成功だけでは、この外向き通信や Microsoft 側の登録の成功までは確認できません。

## 4. Teams アプリパッケージ

Node.js 24 がある開発端末で、このディレクトリに移動します。
`.env` は Git 管理外です。**既存の `.env` は上書きしないでください。**

```powershell
Set-Location .\services\teams-bot
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

`.env` にパッケージ用の実値を設定します。
`CLIENT_SECRET` と `TENANT_ID` はパッケージの生成には不要です。

| 変数 | 値 |
| --- | --- |
| `BOT_DOMAIN` | `mountain-bot-prod-reg-jpn.hdk-atom.jp`。スキーム・パス・ポートなし |
| `CLIENT_ID` | Azure Bot に関連付けた Bot 専用 Entra アプリの ID |
| `TEAMS_APP_ID` | Teams アプリ自体の GUID。Entra の ID とは別。初回に一度生成し、更新時も保持 |

新しい環境で Teams アプリ ID がまだ無ければ、PowerShell の `[guid]::NewGuid()` で生成し、
その値を `.env` の `TEAMS_APP_ID` に保存します。架空の Bot ID で配布用パッケージを作らないでください。

```powershell
$env:ATK_CLI_SKILL = "true"
npx --yes --package @microsoft/m365agentstoolkit-cli@1.1.18 atk package `
  --manifest-file .\appPackage\manifest.json `
  --env-file .\.env `
  --output-package-file .\appPackage\build\mountain-teams-bot.zip `
  --output-folder .\appPackage\build `
  -i false --telemetry false
```

`appPackage\build\mountain-teams-bot.zip` を Teams の「カスタムアプリをアップロード」から追加します。
組織側のカスタムアプリ利用ポリシーで許可が必要です。
パッケージに入るのは解決済みの `manifest.json` とアイコンで、シークレットは含めません。
`m365agents.yml` はパッケージ生成だけの最小設定です。
Azure リソースの作成・アプリの配備・Teams への公開を自動実行する定義は含みません。
組織内配布を拡大する前に `/privacy` と `/terms` の内容を社内方針に照らして確認してください。

## 5. 動作確認

まず公開 URL の稼働と JWT 検証を確認します。

```powershell
Invoke-RestMethod https://mountain-bot-prod-reg-jpn.hdk-atom.jp/healthz
curl.exe -i -X POST https://mountain-bot-prod-reg-jpn.hdk-atom.jp/api/messages `
  -H "Content-Type: application/json" --data '{}'
```

前者は `status: ok`、後者は **401** が正常です。
後者が 200 になることを成功条件にしないでください。
403 の HTML / Challenge、302 のログイン画面、404、502、526 はそれぞれ
Cloudflare ルール、Access、パス設定、コンテナへの接続、オリジン証明書を確認します。
`GET /api/messages` は送受信用の確認には使えません。

その後、Teams の個人チャットで `ping` → `pong`、`help` → 案内、通常のテキスト → 返信を確認します。
チャネルでは Bot を追加してメンションし、同じスレッドに返ることを確認します。
Teams からの呼び出しだけが 401 になる場合は Azure Bot の App ID / Tenant ID、
シークレットの Value と有効期限、Cloudflare が Authorization を転送しているかを確認します。
401 を回避するために JWT 検証を無効にしないでください。

## 6. GitHub Actions による Teams アプリパッケージの配備

ワークフローは [`.github/workflows/teams-app-package.yml`](../../.github/workflows/teams-app-package.yml) です。
現在は **Teams アプリの ZIP の検証・生成・Actions 成果物への保存まで**を自動化します。
**組織内アプリカタログへの自動公開は無効**にしており、管理者が ZIP を手動アップロードします。
Docker イメージの GHCR への push、Dokploy の更新、利用者・チームへの自動インストールは行いません。
Bot サーバーの稼働と公開 URL は、前述の Dokploy の手順で別途準備してください。

| タイミング | 実行内容 |
| --- | --- |
| `main` 向け PR | Bot のビルド・テスト、ZIP 検証とカタログ更新ロジックのテスト。テナントには接続しない |
| 対象ファイルの `main` への push | 検証済み ZIP を生成し、Actions 成果物へ保存。カタログには公開しない |
| Actions の `Run workflow` | `main` 選択時に同じ ZIP 生成を実行。`version` で今回のパッケージのバージョンを指定可能 |

成果物は `mountain-teams-bot.zip` と、その ZIP から読み出した `manifest.json` です。
CI の `publish` ジョブはワークフローから外しています。
公開用 Secret の取得、Environment の承認待ち、Entra への接続、カタログの登録・更新は行いません。

MicrosoftTeams 8.0.0 の `New-TeamsApp` が呼び出す
[Graph 公開 API](https://learn.microsoft.com/en-us/graph/api/teamsapp-publish?view=graph-rest-1.0) は、
アプリ専用認証（`client_credentials`）に対応していません。
権限を追加したり、旧公開ジョブをそのまま戻したりせず、自動公開の再開前に認証方式を再設計してください。

### GitHub 側で設定するもの

設定操作は運用者が行ってください。このリポジトリのスクリプトは、
GitHub の設定、Entra のアプリ登録、権限付与、管理者の同意を変更しません。

#### 1. Repository と Environment の使い分け

**この手順では、Variable 3 項目をすべて Repository variables に登録します。**
現在の CI の実行には Environment と Secrets は不要です。
対象はこのワークフロー用の設定だけで、他用途の既存 Variables / Secrets は変更不要です。

| 登録場所 | 今回の登録数 | 内容 |
| --- | --- | --- |
| Repository variables | **3** | 次の表のパッケージ設定値 |
| Environment variables | **0** | 今回は使用しない |
| Repository secrets | **0** | 今回は使用しない |
| Environment secrets | **0** | 今回は使用しない |

ZIP を生成する `package` ジョブには `environment:` の指定がありません。
そのため、`TEAMS_APP_ID`、`BOT_CLIENT_ID`、`BOT_DOMAIN` を Environment variables にだけ置いても、
このジョブからは参照できません。
同じ名前を Repository と Environment の両方に重複登録しないでください。

YAML 内の `env:` は「ジョブやコマンドへ渡す環境変数」の指定です。
GitHub の Settings にある Environment variables という保存先を意味するものではありません。

#### 2. Repository variables に 3 項目を登録する

1. GitHub で `a13x-4793-3654/MOUNTAIN` を開き、**Settings** を選択します。
2. 左側の **Secrets and variables → Actions** を選択します。
3. **Variables** タブを開きます。**Secrets** タブではありません。
4. **Repository variables** の **New repository variable** を選択します。
5. 次の表の Name と Value を 1 項目ずつ入力し、**Add variable** で保存します。
6. 保存後、Repository variables の一覧に次の 3 項目があることを確認します。

| Name | Value の取得元・入力内容 | 使うジョブ |
| --- | --- | --- |
| `TEAMS_APP_ID` | 既存アプリなら、配布済み ZIP 内の `manifest.json` の `id`。新規なら一度だけ生成した GUID。`services/teams-bot/.env` に保存済みの場合も、既存アプリの ID と一致することを確認して使う | ZIP 生成 |
| `BOT_CLIENT_ID` | Entra の「アプリの登録」→ **Bot 本体のアプリ** →「概要」→ **アプリケーション (クライアント) ID**。Dokploy の `CLIENT_ID` と同じ値 | ZIP 生成 |
| `BOT_DOMAIN` | **`mountain-bot-prod-reg-jpn.hdk-atom.jp`**。`https://`、ポート番号、末尾の `/` は付けない | ZIP 生成 |

ID の欄には GUID の値だけを入力し、引用符、`NAME=`、説明文は付けません。
Entra の **オブジェクト ID** を client ID の代わりに使わないでください。
`TEAMS_APP_ID` は Bot の client ID やカタログ内部 ID ではなく、
Teams アプリパッケージ自体の ID です。更新時も同じ値を保持します。
新規作成時に限り、PowerShell の `[guid]::NewGuid()` で生成して保存できます。
ワークフロー実行のたびに生成してはいけません。

既に Environment variables にだけ登録していた場合は、同じ値を Repository variables に登録します。
Environment 側の同名設定を整理する際は、他のワークフローが利用していないことを確認してください。

#### 3. Actions の実行を許可する

1. Repository の **Settings → Actions → General** を開きます。
2. **Actions permissions** で、このワークフローの実行を許可します。
   組織の許可リストを使う場合は `actions/checkout`、`actions/setup-node`、
   `actions/upload-artifact` を対象にします。
3. 組織で追加の実行承認が必要な場合は、そのポリシーに従ってください。

Actions はコミット SHA で固定しています。
`GITHUB_TOKEN` は `contents: read` のみで動作し、GitHub への書き込み権限や GHCR 用 Secret は不要です。
`GITHUB_TOKEN` を手動で作成・登録する必要もありません。
この用途のために Workflow permissions を書き込み可能へ広げたり、
**Allow GitHub Actions to create and approve pull requests** を有効にしたりする必要はありません。
パスフィルターで起動対象を限定しているため、このワークフローを全 PR 共通の必須チェックにする場合は、
無関係なファイルだけを変更した PR でチェック待ちにならないようルールを設計してください。

#### 4. `main` へ反映し、生成した ZIP を取得する

ZIP 生成のために CI 公開用の Entra アプリ、API 許可、管理者同意、ディレクトリロールを追加する必要はありません。
**既存アプリを更新する場合は、アップロードする ZIP の `version` を既存より増やしておきます。**
push による自動実行では、手動実行の `version` 入力はなく、リポジトリの manifest の値が使われます。

1. このワークフローを含む変更を `main` に反映します。対象ファイルの push により、自動実行が始まります。
2. Repository の **Actions → Teams app package** を開き、最新の実行を選択します。
3. 手動実行する場合は **Run workflow** を選択し、Branch は **`main`** にします。
4. `version` は、新規登録なら空欄で manifest の値を使用できます。
   更新なら、既存カタログより新しい `major.minor.patch` を指定します。
   例えば既存が `0.1.0` なら `0.1.1` です。
5. 実行画面で次のジョブと Artifacts を確認します。

| ジョブ / 表示 | 確認する内容 |
| --- | --- |
| `Validate Teams app package` | Bot とパッケージ・公開ロジックのテストが成功している。公開ロジックはモックで検証し、テナントには接続しない |
| `Build deployable Teams ZIP` | manifest のスキーマ検証と ZIP 生成が成功している |
| Artifacts | ZIP と解決済み manifest を含む `teams-app-...` が保存されている |

6. Artifacts の **`teams-app-...`** をダウンロードします。保存期間は 14 日です。
7. ダウンロードした Artifact の ZIP を展開し、**中にある `mountain-teams-bot.zip`** を取り出します。
   このファイルが Teams に渡すアプリパッケージです。外側の Artifact の ZIP や、
   単体の `manifest.json` をアップロードしないでください。

ワークフローがまだ `main` にない間は、手動実行用の **Run workflow** が表示されないことがあります。
PR の実行や `main` 以外の手動実行では、ZIP 生成ジョブも `Skipped` になります。
公開ジョブは定義していないため、実行一覧に表示されません。
**無効化前の失敗した実行を再実行すると旧定義が使われるため、変更反映後の `main` から新しく実行してください。**

### Teams 管理センターで手動公開する

Teams Administrator ロールを持つ管理者が操作します。CI 用サービスプリンシパルへの
権限付与は、この手動公開を行う管理者自身の権限の代わりにはなりません。

1. [Teams 管理センター](https://admin.teams.microsoft.com/policies/manage-apps) の
   **Teams のアプリ → アプリを管理**を開きます。
2. 初回は **新しいアプリをアップロード**、または **操作 → 新しいアプリをアップロード**を選択し、
   取得した **`mountain-teams-bot.zip`** をアップロードします。
3. 更新時は既存の MOUNTAIN アプリの詳細画面を開き、**ファイルをアップロード**から
   同じ `TEAMS_APP_ID` を持つ新しいバージョンの ZIP をアップロードします。
4. 管理画面でアプリ ID・バージョン・利用可能状態を確認します。
   対象ユーザーへのアプリの利用許可も、組織のポリシーに従って確認してください。

CI の成功は **ZIP 生成の成功**であり、カタログ公開の成功ではありません。
CI は既存カタログとのバージョン比較や公開状態の確認を行いません。
組織のストアや Teams クライアントへの反映には時間がかかる場合があります。
カタログへの公開と、利用者のクライアントへの反映・インストールは別です。

### バージョン

更新時は `appPackage/manifest.json` の **`version` を増やしてから** `main` に反映します。
または `Run workflow` の `version` に新しい `major.minor.patch` を指定します。
後者は今回の ZIP にだけ適用され、リポジトリ上の manifest を書き換えません。
`TEAMS_APP_ID` は変更しません。

`manifestVersion` はスキーマの版で、アプリの `version` とは別です。
この Bot は `manifestVersion: "1.30"` で `team` スコープを宣言するため、
ルートに **`"supportsChannelFeatures": "tier1"`** を指定します。
`bots` の中に入れたり、boolean の `true` を指定したりしないでください。
スキーマ検証だけではカタログの追加ルールを検出できない場合があるため、
テンプレート解決時と生成 ZIP の読み取り時にも、この宣言を検証します。
この宣言に伴う追加の Graph 権限やメンバー情報の取得は行いません。

手動アップロードの前に、管理者が既存カタログより新しいバージョンであることを確認してください。
未解決のテンプレート変数、アプリ ID の不一致、想定外の ZIP エントリーはビルド時にエラーにします。
GitHub 設定が不足していても、架空の ID で ZIP を作ることはありません。

### 設定済みの公開用資格情報

`TEAMS_TENANT_ID`、`TEAMS_PUBLISHER_CLIENT_ID`、`TEAMS_PUBLISHER_CLIENT_SECRET`、
`teams-app-production` は、現在の CI の実行には不要です。
既存の Variables / Secrets / Environment、公開用 Entra アプリの資格情報・API 許可・
ディレクトリロールは、この変更では削除・失効・解除しません。
他の利用がないことを確認したうえで、管理者が別途整理してください。
Bot 本体の Dokploy 用 `CLIENT_ID`、`CLIENT_SECRET`、`TENANT_ID` は引き続き必要です。

公開用 PowerShell スクリプトとモックテストは残していますが、CI から公開スクリプトは呼び出しません。
現在のスクリプトを手動実行することも、管理センターでの手動アップロードの代わりにはなりません。

### 設定を間違えた場合の見分け方

| 症状 | 最初に確認する場所 |
| --- | --- |
| GUID が必須というエラーが出る | Repository **Variables** の名前と値。Environment variables や Secrets にだけ登録していないか |
| `BOT_DOMAIN` のエラーが出る | ホスト名だけを入力しているか。スキーム・ポート・パスを除く |
| ZIP 生成ジョブが `Skipped` | PR または `main` 以外の実行では正常。ZIP が必要なら `main` を選択する |
| 公開ジョブが実行される、またはカタログ操作のエラーが出る | 無効化前のコミット・実行を再実行していないか。変更反映後の `main` から新しい実行を起動する |
| `team` スコープに `supportsChannelFeatures` が必要というアップロードエラー | ルートの値が文字列 `"tier1"` になっているか。修正後の Artifact の ZIP を取得し直し、旧 ZIP を再利用しない |
| アップロード時に manifest が見つからない | Artifact の外側の ZIP ではなく、中の `mountain-teams-bot.zip` を選んでいるか |
| 既存以下のバージョンで更新できない | manifest または手動実行の `version` を既存より新しくして ZIP を作り直す |

## 7. MOUNTAIN 契約検索（任意設定）

### 検索対象と利用範囲

個人チャットで `契約検索 キーワード`、または `search キーワード` を送信します。
検索対象は既存の契約一覧と同じ **契約番号・概要・会社名・契約者名**です。
キーワードは 1〜200 Unicode コードポイント、結果は最大 5 件です。
契約番号・概要・会社・契約者・状態と、MOUNTAIN の契約詳細画面へのリンクだけを返します。
口座・カード番号、CTI パスワード、契約詳細の各種情報は取得・返信しません。
6 件以上は、案内された MOUNTAIN の契約一覧で追加の絞り込みを行ってください。

検索には本人のサインインが必要です。初回は OAuth カードを表示します。
サインイン完了後は検索語を保存・自動再送せず、もう一度検索コマンドを入力してもらいます。
`ログアウト` または `signout` は、この Bot の MOUNTAIN OAuth 接続だけをサインアウトします。
MOUNTAIN Web や Teams 全体のサインアウトではありません。

Bot のアプリケーショントークン、共有管理者、開発用ユーザーでは検索しません。
既存の `/api/contracts` に本人のトークンを渡すため、既存の画面権限
`screen.contracts` / `screen.billing` / `screen.review` / `screen.litigation` の判定を継承します。
API 呼び出しは `GET /api/config` と `GET /api/contracts` のみです。
`AUTH_MODE=dev` または別テナントの API では、業務データを要求する前に停止します。
401・403・接続失敗を「検索結果なし」へ置き換えたり、別の認証方法で再試行したりしません。

### Azure Bot の OAuth 接続

**Azure Bot の登録・Teams チャネルとは別に OAuth Connection Settings が必要です。**
既存の API スコープを利用します。Graph のアプリケーション権限や Teams 管理者ロールの追加は不要です。
以下は管理者が行う設定で、Bot の起動時に Entra や Azure の設定を自動変更することはありません。

1. サインイン用 Entra アプリに **Web** のリダイレクト URI
   `https://token.botframework.com/.auth/web/redirect` を登録します。
   既存の SPA のリダイレクト URI は削除・変更しません。
2. Azure Bot → **Configuration → OAuth Connection Settings** で接続を追加します。
   接続名は例として **`mountain-api`**、サービスプロバイダーは **Azure Active Directory v2** を選択します。
3. OAuth クライアントの client ID、同じアプリの有効な client secret の **Value**、対象テナント ID を設定します。
   シークレットは Azure の入力欄にだけ入力し、チャット・Git・Variables に貼らないでください。
   API 用アプリと OAuth クライアントを分離している場合は、OAuth クライアントに API の委任アクセスと
   必要な管理者同意を設定します。Bot 用のアプリケーショントークンを代わりに渡してはいけません。
4. スコープを `openid profile offline_access` と **MOUNTAIN API の `access_as_user` スコープ**にします。
   `/api/config` に公開される `entra.api_scope` と同じ API スコープを使用します。
   既存環境では `api://9e7ad576-132c-42b8-8c25-731e852212a7/access_as_user` です。
5. 本実装はサインインカードを使う対話型 OAuth です。サイレント SSO 用の Token Exchange URL、
   `webApplicationInfo`、Teams クライアントの事前承認は、この構成のために追加しません。
6. 保存後、Azure Portal の接続テストを行います。実際の検索は Teams と同じアカウントでサインインします。
   `validDomains` の `token.botframework.com` を含む新しいアプリパッケージも手動公開してください。

OAuth 接続のシークレットは Azure Bot 側で管理され、Bot のアプリコードには保存しません。
取得したユーザートークンは API 呼び出しにだけ使用し、アプリログや独自ストレージに記録しません。
SDK の OAuth フローは既定でプロセス内の一時状態を使うため、**この構成は Bot を単一インスタンスで実行**します。
複数レプリカへ増やす場合は、その前に SDK の OAuth 状態ストレージを共有化してください。

### Dokploy の環境変数と再配備

| 名前 | 値 |
| --- | --- |
| `MOUNTAIN_API_BASE_URL` | MOUNTAIN の HTTPS origin。既存環境は `https://mountain-prod.intra.hdk-atom.jp` |
| `MOUNTAIN_OAUTH_CONNECTION_NAME` | Azure Bot に保存した OAuth 接続名。上記の例では `mountain-api` |

両方を空にすると契約検索は無効で、既存の接続確認・テキスト応答だけが動作します。
片方だけの設定、不正な URL、認証情報・パス・query・fragment を含む URL は起動時に拒否します。
API は Bot と同じ `TENANT_ID` の Entra 認証を有効にし、TLS が正常でなければなりません。
社内 DNS・証明書・経路の問題を、HTTP への切替や TLS 検証の無効化で回避しないでください。

新しいコードで Dokploy の Bot コンテナを再ビルド・再配備します。
GitHub Actions の ZIP 生成だけでは、Bot の実行コードや Dokploy の環境変数は更新されません。
OAuth 未設定・配備前の状態を、検索可能な状態とは扱わないでください。
検索結果は Teams の会話履歴に残ります。API・プロキシ・SDK の診断ログの保管方針も管理者が確認します。

## ローカル開発

```powershell
Set-Location .\services\teams-bot
npm ci
npm test
npm run playground
```

`npm run playground` は **127.0.0.1 のみ**で待ち受ける認証省略の開発用エントリーポイントです。
`.env` は読み込まず、Microsoft の資格情報を使いません。
`NODE_ENV=production` では起動を拒否します。
非推奨になった `@microsoft/teams.dev` は同梱せず、独立した Microsoft 365 Agents Playground を使用します。

別の端末から次を起動し、ローカルで Bot と対話します。
Bot と Playground の両方を終了すれば待ち受けも終了します。

```powershell
npx --yes --package @microsoft/m365agentsplayground agentsplayground `
  -e http://127.0.0.1:3978/api/messages -c msteams
```

開発用のエントリーポイントを Dokploy、トンネル、公開リバースプロキシへ接続しないでください。
本番と同じ JWT 認証でローカル起動する場合は、実際の資格情報を安全に `.env` へ設定して
`npm run build` → `npm start` を使用します。

## 認証ライブラリの固定

Teams SDK 2.1.1 が依存する MSAL Node 5.x は
[CVE-2026-109461 / GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5) の対象です。
`package.json` の `overrides` で、同 SDK 配下の `@azure/msal-node` を修正済みの `7.1.1` に固定しています。
この Bot が使用するクライアント資格情報フローの SDK 連携を回帰テストに含めています。
SDK 自体が修正版へ対応した際に、この固定の解除を検討してください。

## 参考

- [Microsoft: Teams SDK のクイックスタート](https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/quickstart-create-agent-teams-sdk)
- [Microsoft: 外部ホストの Bot を Azure Bot に登録](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration)
- [Microsoft: カスタムアプリのアップロードと更新](https://learn.microsoft.com/en-us/microsoftteams/teams-custom-app-policies-and-settings)
- [Microsoft: Graph の Teams アプリ公開 API](https://learn.microsoft.com/en-us/graph/api/teamsapp-publish?view=graph-rest-1.0)
- [Microsoft: Bot のユーザー認証を追加](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/authentication/add-authentication)
- [Dokploy: Dockerfile の設定](https://docs.dokploy.com/docs/core/applications/build-type#dockerfile)
- [Dokploy: ドメインとコンテナポート](https://docs.dokploy.com/docs/core/domains)
- [Cloudflare: Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)
