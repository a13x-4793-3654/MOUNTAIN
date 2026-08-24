# MOUNTAIN

FreePBX / Asterisk 上で動作する CTI 連携コンポーネント群です。
着信時の自動着信拒否判定と Teams 通知を行う AGI スクリプトと、
内線プレゼンス・留守電・通話録音を外部から操作する REST API を収録しています。

---

## 構成

| パス | 役割 |
| --- | --- |
| `agi-bin/alps.py` | **ALPS (DenyCall Checker)** — 着信時に顧客情報 API を照会し、着信拒否判定と音声応答を行う AGI スクリプト。判定結果を Teams へ Adaptive Card で通知します |
| `var_www_html/cti_apis/capis_api.php` | **CTI API** — 内線プレゼンス変更、留守電の一覧・再生・削除、通話録音の一覧・再生、アナウンスの登録・取得・削除 |
| `var_www_html/cti_apis/brew_tap_api.php` | **Brew TAP API** — 一時アクセスパス (OTP) を音声で案内するコールを AMI 経由で発信 |

リポジトリのディレクトリ構成は、PBX 上の実際の配置パスに対応しています。

```
agi-bin/                     →  /var/lib/asterisk/agi-bin/
var_www_html/cti_apis/       →  /var/www/html/cti_apis/
```

---

## 動作の流れ

### ALPS (着信拒否判定)

```mermaid
sequenceDiagram
    participant C as 発信者
    participant A as Asterisk (AGI)
    participant V as 顧客情報 API
    participant T as Power Automate / Teams

    C->>A: 着信
    A->>C: 応答 + 開始アナウンス再生
    A->>V: 発信元番号で照会 (X-API-KEY)
    V-->>A: 契約会社 / 弁護士 / 非該当 + 拒否フラグ
    A->>T: Adaptive Card で着信通知
    alt 拒否対象 または 非通知
        A->>C: 拒否理由アナウンス → 切断
    else 許可
        A->>C: 許可アナウンス → 通常の着信処理へ
    end
```

**フェイルオーバー設計**: 外部 API への通信前に必ず `Answer` して音声を流します。
これにより顧客情報 API や Power Automate の応答が遅延しても、キャリア側のタイムアウトによる
呼の CANCEL を防ぎます。API 照会が失敗した場合は「許可」を既定値として通話を継続します。

### CTI API の主なエンドポイント

いずれも HTTP ヘッダー `X-API-KEY` による認証が必要です。

| action | 説明 |
| --- | --- |
| `set_presence` | 内線のプレゼンス（DND / 転送）を変更 |
| `lookup_extension` | 内線情報の取得 |
| `list_voicemail` / `play_voicemail` / `delete_voicemail` | 留守電の一覧・再生・削除 |
| `list_recordings` / `play_recording` | 通話録音の一覧・ストリーミング再生 |
| `upload_greeting` / `get_greeting` / `delete_greeting` | アナウンス音声の登録・取得・削除 |

留守電は FreePBX のストレージ方式に応じて、ファイルベース (`file`) と
ODBC/DB ベース (`db`) の両方に対応しています。

---

## セットアップ

### 1. 設定ファイルの作成

**資格情報はすべて設定ファイルに外出ししており、リポジトリには含まれていません。**
テンプレートをコピーして、実際の値を設定してください。

```bash
# PHP API
cd var_www_html/cti_apis
cp config.example.php config.php
vi config.php

# AGI スクリプト
cd agi-bin
cp alps_config.example.py alps_config.py
vi alps_config.py
```

### 2. 権限の設定

設定ファイルには API キーと AMI シークレットが含まれるため、読み取り権限を絞ってください。

```bash
chmod 640 /var/www/html/cti_apis/config.php
chown root:apache /var/www/html/cti_apis/config.php

chmod 640 /var/lib/asterisk/agi-bin/alps_config.py
chown root:asterisk /var/lib/asterisk/agi-bin/alps_config.py
chmod 755 /var/lib/asterisk/agi-bin/alps.py
```

### 3. AMI 専用ユーザーの作成

`/etc/asterisk/manager_custom.conf` に、localhost からのみ接続できるユーザーを追加します。

```ini
[cti_api]
secret = <強力なランダム文字列>
deny   = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
read   = system,call,user
write  = system,call,originate
```

```bash
asterisk -rx "manager reload"
```

### 4. Apache 実行ユーザーを asterisk グループへ追加

留守電・録音ファイルの読み取りに必要です。

```bash
sudo usermod -aG asterisk apache      # Debian 系は www-data
sudo systemctl restart httpd          # Debian 系は apache2
```

### 5. Python 実行環境

```bash
python3 -m venv /opt/my-agi-venv
/opt/my-agi-venv/bin/pip install requests pyst2
```

`alps.py` の shebang は `/opt/my-agi-venv/bin/python3` を指しています。
別のパスに作成した場合は 1 行目を修正してください。

---

## セキュリティ上の注意

- **この API は必ず HTTPS 経由で公開してください。** API キーが平文で流れます。
- **AMI は localhost 限定にしてください。** AMI は任意の発信・通話操作が可能な強力な権限を持ちます。
- **Power Automate の Webhook URL は認証情報です。** 末尾の `sig=` パラメータが署名を兼ねているため、
  URL を知っている人は誰でもフローを起動できます。設定ファイル以外に記載しないでください。
- `config.php` と `alps_config.py` は `.gitignore` 済みです。誤ってコミットしないよう注意してください。
- 資格情報が漏洩した可能性がある場合は、API キーと AMI シークレットを速やかにローテーションしてください。

---

## 動作環境

- FreePBX 15 以降 / Asterisk 16 以降
- PHP 7.4 以降（`db` モード使用時は `pdo_mysql` 拡張が必須）
- Python 3.8 以降（`requests`、`pyst2`）
