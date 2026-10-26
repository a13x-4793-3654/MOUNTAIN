# MOUNTAIN Teams Bot

Dokploy 上で動かす、独立した Teams 応答 Bot の土台です。
Microsoft 365 Agents Toolkit の `bot` テンプレートを基に、Teams SDK と Node.js 24 を使用しています。
Azure App Service や Azure のデータベースへアプリを配置する構成ではありません。

現段階は **A: 接続確認** までです。
ALPS の Power Automate 通知、MOUNTAIN の業務 API、DB、RBAC は変更・接続していません。
通知移行（B）と検索・操作（C）は後続の実装です。

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
| `help` / `/help` | 接続確認用の案内を返す |
| その他のテキスト | プレーンテキストで返信。最大 2,000 Unicode コードポイント |
| `GET /healthz` | `{"status":"ok"}` を返す。プロセスの稼働確認のみ |
| `GET /`、`/privacy`、`/terms` | Bot の案内と、接続検証段階のプライバシー・利用条件 |
| `POST /api/messages` | SDK の JWT 検証を通過した Teams アクティビティのみ受け付ける |

個人チャット、チームのチャネル、グループチャットに対応します。
チャネル・グループチャットでは Bot を追加し、`@MOUNTAIN Bot ping` のようにメンションしてください。
チャネルでは元のスレッドに応答します。添付ファイルの処理、AI/LLM、会話本文の永続化はありません。
単一テナント構成に加え、受信アクティビティの Teams テナント ID を照合します。
MOUNTAIN の業務権限との連携はまだありません。

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
この段階の Bot は Microsoft Graph の権限やユーザー SSO を要求しません。
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
対象は **Teams アプリの ZIP と組織内アプリカタログ** です。
Docker イメージの GHCR への push、Dokploy の更新、利用者・チームへの自動インストールは行いません。
Bot サーバーの稼働と公開 URL は、前述の Dokploy の手順で別途準備してください。

| タイミング | 実行内容 |
| --- | --- |
| `main` 向け PR | Bot のビルド・テスト、ZIP 検証とカタログ更新ロジックのテスト。テナントには接続しない |
| 対象ファイルの `main` への push | 検証済み ZIP を生成し、Actions 成果物へ保存してから組織カタログに登録・更新 |
| Actions の `Run workflow` | `main` 選択時に同じ配備を実行。`version` で今回のパッケージのバージョンを指定可能 |

成果物は `mountain-teams-bot.zip` と、その ZIP から読み出した `manifest.json` です。
公開ジョブは同じ実行の成果物を取得して使い、公開時にパッケージを作り直しません。
初回は `New-TeamsApp`、更新時は `Set-TeamsApp` を使用します。
更新先のカタログ ID は固定の `TEAMS_APP_ID`（manifest ID / external ID）から検索するため、
カタログ内部の ID を GitHub に設定する必要はありません。

### GitHub 側で設定するもの

設定操作は運用者が行ってください。このリポジトリのスクリプトは、
GitHub の設定、Entra のアプリ登録、権限付与、管理者の同意を変更しません。

#### 1. Repository と Environment の使い分け

**この手順では、Variable 5 項目をすべて Repository variables に登録し、
Secret 1 項目だけを `teams-app-production` の Environment secrets に登録します。**
Environment variables と Repository secrets には、このワークフロー用の値を登録しません。
対象はこのワークフロー用の設定だけで、他用途の既存 Variables / Secrets は変更不要です。

| 登録場所 | 今回の登録数 | 内容 |
| --- | --- | --- |
| Repository variables | **5** | 次の表の公開設定値 |
| Environment variables | **0** | 今回は使用しない |
| Repository secrets | **0** | 今回は使用しない |
| Environment secrets | **1** | `TEAMS_PUBLISHER_CLIENT_SECRET` |

ZIP を生成する `package` ジョブには `environment:` の指定がありません。
そのため、`TEAMS_APP_ID`、`BOT_CLIENT_ID`、`BOT_DOMAIN` を Environment variables にだけ置いても、
このジョブからは参照できません。
公開時だけ使う残り 2 項目も、設定場所を統一するため Repository variables に置きます。
同じ名前を Repository と Environment の両方に重複登録しないでください。

YAML 内の `env:` は「ジョブやコマンドへ渡す環境変数」の指定です。
GitHub の Settings にある Environment variables という保存先を意味するものではありません。

#### 2. Repository variables に 5 項目を登録する

1. GitHub で `a13x-4793-3654/MOUNTAIN` を開き、**Settings** を選択します。
2. 左側の **Secrets and variables → Actions** を選択します。
3. **Variables** タブを開きます。**Secrets** タブではありません。
4. **Repository variables** の **New repository variable** を選択します。
5. 次の表の Name と Value を 1 項目ずつ入力し、**Add variable** で保存します。
6. 保存後、Repository variables の一覧に 5 項目があることを確認します。

| Name | Value の取得元・入力内容 | 使うジョブ |
| --- | --- | --- |
| `TEAMS_APP_ID` | 既存アプリなら、配布済み ZIP 内の `manifest.json` の `id`。新規なら一度だけ生成した GUID。`services/teams-bot/.env` に保存済みの場合も、既存アプリの ID と一致することを確認して使う | ZIP 生成・公開 |
| `BOT_CLIENT_ID` | Entra の「アプリの登録」→ **Bot 本体のアプリ** →「概要」→ **アプリケーション (クライアント) ID**。Dokploy の `CLIENT_ID` と同じ値 | ZIP 生成 |
| `BOT_DOMAIN` | **`mountain-bot-prod-reg-jpn.hdk-atom.jp`**。`https://`、ポート番号、末尾の `/` は付けない | ZIP 生成 |
| `TEAMS_TENANT_ID` | Entra の「概要」などにある **ディレクトリ (テナント) ID**。公開先の組織の GUID | 公開 |
| `TEAMS_PUBLISHER_CLIENT_ID` | Entra の「アプリの登録」→ **CI 公開専用アプリ** →「概要」→ **アプリケーション (クライアント) ID** | 公開 |

ID の欄には GUID の値だけを入力し、引用符、`NAME=`、説明文は付けません。
Entra の **オブジェクト ID** を client ID の代わりに使わないでください。
`TEAMS_APP_ID` は Bot の client ID やカタログ内部 ID ではなく、
Teams アプリパッケージ自体の ID です。更新時も同じ値を保持します。
新規作成時に限り、PowerShell の `[guid]::NewGuid()` で生成して保存できます。
ワークフロー実行のたびに生成してはいけません。

既に Environment variables にだけ登録していた場合は、同じ値を Repository variables に登録します。
Environment 側の同名設定を整理する際は、他のワークフローが利用していないことを確認してください。

#### 3. 公開用 Environment を作成する

1. Repository の **Settings → Environments** を開きます。
2. **New environment** を選択します。既にある場合は既存の Environment を開きます。
3. 名前に **`teams-app-production`** を入力し、**Configure environment** を選択します。
4. **Deployment branches and tags** で **Selected branches and tags** を選択します。
5. **Add deployment branch or tag rule** を選び、Ref type は **Branch**、名前のパターンは **`main`** にします。
6. **Add rule** で保存します。名前が `main` の Tag を許可する設定とは異なります。

Required reviewers は運用方針に応じて設定します。
設定した場合、公開ジョブは **Review deployments** から承認されるまで待機します。
これはエラーではありません。承認を入れるかどうかと、承認可能な人を事前に決めてください。
**Environment variables の Add variable は今回は使いません。**

Environments や一部の保護ルールが表示されない場合は、Repository の管理権限と GitHub プランを確認してください。
Private Repository の Environment 利用には、個人アカウントでは GitHub Pro、
組織では GitHub Team / Enterprise などの対応プランが必要です。

#### 4. Environment secret を 1 項目登録する

1. **Settings → Environments → teams-app-production** を開きます。
2. **Environment secrets** の **Add secret** を選択します。Environment variables ではありません。
3. Name に **`TEAMS_PUBLISHER_CLIENT_SECRET`** を入力します。
4. Value に、**CI 公開専用アプリ**のクライアントシークレットの **Value（値）**を貼り付けます。
5. **Add secret** で保存し、Environment secrets の一覧に名前が表示されることを確認します。

取得元は、Entra の「アプリの登録」→ CI 公開専用アプリ →
**証明書とシークレット → クライアントシークレット**です。
**シークレット ID ではなく Value** を使用します。
Value を再表示できなくなっている場合は、管理者が新しいシークレットを発行して登録します。
シークレットの値を Variables、Git、チャットへ貼らないでください。

Bot 本体の `CLIENT_SECRET` を GitHub に渡す必要はありません。
公開専用シークレットは `teams-app-production` を指定する `publish` ジョブにだけ渡します。
PR のテストや ZIP の生成には渡しません。
ユーザー名・パスワードによる認証や MFA の省略は使用しません。

#### 5. Actions の実行を許可する

1. Repository の **Settings → Actions → General** を開きます。
2. **Actions permissions** で、このワークフローの実行を許可します。
   組織の許可リストを使う場合は `actions/checkout`、`actions/setup-node`、
   `actions/upload-artifact`、`actions/download-artifact` を対象にします。
3. 組織で追加の実行承認が必要な場合は、そのポリシーに従ってください。

Actions はコミット SHA で固定しています。
`GITHUB_TOKEN` は `contents: read` のみで動作し、GitHub への書き込み権限や GHCR 用 Secret は不要です。
`GITHUB_TOKEN` を手動で作成・登録する必要もありません。
この用途のために Workflow permissions を書き込み可能へ広げたり、
**Allow GitHub Actions to create and approve pull requests** を有効にしたりする必要はありません。
パスフィルターで起動対象を限定しているため、このワークフローを全 PR 共通の必須チェックにする場合は、
無関係なファイルだけを変更した PR でチェック待ちにならないようルールを設計してください。

#### 6. 設定後に `main` へ反映し、初回実行を確認する

Entra / Teams 側の前提条件も先に準備してください。
必要な設定がないまま `main` に反映すると、公開ジョブが権限エラーなどで停止します。
**既存アプリを更新する場合は、`main` に反映する前に manifest の `version` を既存より増やしておきます。**
push による自動実行では、手動実行の `version` 入力はなく、リポジトリの manifest の値が使われます。

1. このワークフローを含む変更を `main` に反映します。対象ファイルの push により、自動実行が始まります。
2. Repository の **Actions → Teams app package** を開き、最新の実行を選択します。
3. 手動実行する場合は **Run workflow** を選択し、Branch は **`main`** にします。
4. `version` は、新規登録なら空欄で manifest の値を使用できます。
   更新なら、既存カタログより新しい `major.minor.patch` を指定します。
   例えば既存が `0.1.0` なら `0.1.1` です。
5. Environment に Required reviewers を設定した場合は、**Review deployments** から公開を承認します。
6. 実行画面で次のジョブと Summary、Artifacts を確認します。

| ジョブ / 表示 | 確認する内容 |
| --- | --- |
| `Validate Teams app package` | Bot とパッケージ・公開ロジックの検証が成功している |
| `Build deployable Teams ZIP` | manifest のスキーマ検証と ZIP 生成が成功している |
| Artifacts | ZIP と解決済み manifest を含む `teams-app-...` が保存されている |
| `Publish to organization app catalog` | 作成または更新と、対象バージョンの公開状態確認が成功している |
| Summary | `created` / `updated`、manifest ID、カタログ ID、公開バージョンが表示されている |

ワークフローがまだ `main` にない間は、手動実行用の **Run workflow** が表示されないことがあります。
また、PR の実行や `main` 以外の手動実行で ZIP 生成・公開ジョブが `Skipped` になるのは意図した動作です。

#### 設定を間違えた場合の見分け方

| 症状 | 最初に確認する場所 |
| --- | --- |
| GUID が必須というエラーが出る | Repository **Variables** の名前と値。Environment variables や Secrets にだけ登録していないか |
| `BOT_DOMAIN` のエラーが出る | ホスト名だけを入力しているか。スキーム・ポート・パスを除く |
| 公開用 secret が必須というエラーが出る | `teams-app-production` の **Environment secrets**。Environment variables ではない |
| シークレットが無効・期限切れという認証エラー | 公開専用アプリの Value と有効期限。Bot 用 secret やシークレット ID との取り違え |
| `Waiting` / 承認待ちで止まる | Environment の Required reviewers と実行画面の Review deployments |
| ブランチが公開を許可されない | Environment のルールが **Branch: main** になっているか |
| `Connect-MicrosoftTeams: Not supported tenant type.` | MicrosoftTeams 8.0.0 で `-AccessTokens` と `-TenantId` を併用していないか。接続時の `-TenantId` だけを省略し、`TEAMS_TENANT_ID` の設定は保持する |
| カタログ操作で権限エラーが出る | Entra のアプリケーション権限、管理者同意、公開用サービスプリンシパルの Teams 管理者ロール |
| 既存以下のバージョンというエラー | manifest または手動実行の `version` を既存より新しくする |

### Entra / Teams 側の前提

**公開用の資格情報は、Bot 本体や MOUNTAIN の SPA/API の資格情報と分離してください。**
公開専用のシングルテナントアプリとサービスプリンシパルを用意し、
Microsoft Teams PowerShell の[アプリ認証の公式手順](https://learn.microsoft.com/en-us/microsoftteams/teams-powershell-application-authentication)
に従って管理者が設定します。

#### 公開用アプリの API 許可

この CI は `Get-TeamsApp`、`New-TeamsApp`、`Set-TeamsApp` を使うため、
公式手順では **All** と **Non `*-Cs` cmdlets** の区分に該当します。
Microsoft の公式前提条件に合わせる場合、次の Microsoft Graph 権限セットが案内されています。
**すべて「アプリケーションの許可」で、委任されたアクセス許可ではありません。**

| Microsoft Graph のアプリケーション権限 | 公式手順の対象 |
| --- | --- |
| `Organization.Read.All` | 全コマンド共通 |
| `User.Read.All` | 非 `*-Cs` コマンド向け |
| `Group.ReadWrite.All` | 非 `*-Cs` コマンド向け |
| `AppCatalog.ReadWrite.All` | 非 `*-Cs` コマンド向け。アプリカタログ管理 |
| `TeamSettings.ReadWrite.All` | 非 `*-Cs` コマンド向け |
| `Channel.Delete.All` | 非 `*-Cs` コマンド向け |
| `ChannelSettings.ReadWrite.All` | 非 `*-Cs` コマンド向け |
| `ChannelMember.ReadWrite.All` | 非 `*-Cs` コマンド向け |

1. Entra の **アプリの登録 → CI 公開専用アプリ → API のアクセス許可** を開きます。
2. **アクセス許可の追加 → Microsoft Graph → アプリケーションの許可** を選びます。
3. 採用する権限を追加し、管理者が **テナントに管理者の同意を与える** を実行します。
4. 一覧で、権限の種類が Application で、管理者の同意が付与済みであることを確認します。

これはモジュール共通の広い公式セットであり、この CI の厳密な最小権限を示したものではありません。
実装自体はアプリカタログの操作だけを行い、ユーザー・グループ・チャネルを変更しません。
以前記載していた `Organization.Read.All` と `AppCatalog.ReadWrite.All` の
2 項目だけで実テナント動作を確認できているわけではありません。
権限を絞る場合は、管理者がテナント上で対象コマンドの動作を確認してください。
範囲が広いため、Bot 本体や MOUNTAIN の SPA/API ではなく、公開専用アプリを対象に管理者が承認します。

Administrative Units を使わないこの構成では、公式表の同機能向け追加権限
`RoleManagement.Read.Directory` と `GroupMember.Read.All` は追加対象にしていません。

#### API 許可とは別に必要なロールとポリシー

- 公開専用の**サービスプリンシパルに Teams 管理者のディレクトリロール**を割り当てます。
  アプリの所有者にするだけでは、このロールの代わりにはなりません。
- 「Skype and Teams Tenant Admin API」に API 権限を追加する必要はありません。
  スクリプトは公式手順どおり、同じ client ID / secret で Graph と Teams 管理 API の
  2 つのアクセストークンを取得して接続します。
- カスタムアプリの公開と利用をテナントの Teams アプリ管理ポリシーで許可してください。
  シークレットの有効期限と失効は運用側で監視・更新します。

これらは組織の管理権限を伴うため、必ずテナント管理者が確認してください。
直接の Graph `teamsApp` 公開・更新 API はアプリ単独認証をサポートしていないため、
このワークフローは Microsoft Teams PowerShell 8.0.0 のアプリ認証経路を使用します。
権限不足や接続失敗時に、対話ログインや弱い認証へフォールバックすることはありません。

MicrosoftTeams 8.0.0 のアクセストークン方式では、`Connect-MicrosoftTeams` に
`-TenantId` を指定せず、発行済みトークンからテナントを取得させます。
`TEAMS_TENANT_ID` は引き続き必須で、Graph と Teams 管理 API の両トークンの取得先を
指定テナントに固定するために使います。この引数の併用によるエラーへの対処として、
Entra アプリのシングルテナント設定や API 許可、シークレットを変更する必要はありません。

### バージョンと公開結果

更新時は `appPackage/manifest.json` の **`version` を増やしてから** `main` に反映します。
または `Run workflow` の `version` に新しい `major.minor.patch` を指定します。
後者は今回の ZIP にだけ適用され、リポジトリ上の manifest を書き換えません。
`TEAMS_APP_ID` は変更しません。

既存以下のバージョン、アプリ ID の不一致、複数候補、未解決のテンプレート変数、
想定外の ZIP エントリーはエラーで停止し、別アプリの更新や同じバージョンの上書きは行いません。
GitHub 設定が不足していても、架空の ID を埋めて配備することはありません。

公開後はカタログから対象バージョンの `published` 状態を確認し、
結果・カタログ ID・バージョンを Actions の Summary に記録します。
管理者レビュー待ちや拒否を公開成功とは扱いません。
アップロード後の状態を約 1 分以内に確認できない場合もエラーにし、
実際に受理されていないと決めつけて再アップロードすることはありません。
その場合は Teams 管理センターを確認してから再実行してください。
カタログの更新確認と、利用者の Teams クライアントへの反映・インストールは別です。

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
- [Microsoft: Teams PowerShell のアプリ認証](https://learn.microsoft.com/en-us/microsoftteams/teams-powershell-application-authentication)
- [Microsoft: New-TeamsApp](https://learn.microsoft.com/en-us/powershell/module/microsoftteams/new-teamsapp)
- [Microsoft: Set-TeamsApp](https://learn.microsoft.com/en-us/powershell/module/microsoftteams/set-teamsapp)
- [Dokploy: Dockerfile の設定](https://docs.dokploy.com/docs/core/applications/build-type#dockerfile)
- [Dokploy: ドメインとコンテナポート](https://docs.dokploy.com/docs/core/domains)
- [Cloudflare: Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)
