<?php
/**
 * CTI API 共通設定テンプレート
 * =============================================================================
 * このファイルを同じディレクトリに `config.php` としてコピーし、
 * 実際の値を設定してください。`config.php` は Git 管理外です。
 *
 *   $ cp config.example.php config.php
 *   $ chmod 640 config.php
 *   $ chown root:apache config.php      # Web サーバー実行ユーザーのみ読める状態にする
 *
 * ※ このファイル自体には実際の資格情報を書き込まないでください。
 * =============================================================================
 */

// -----------------------------------------------------------------------------
// API 認証キー
// -----------------------------------------------------------------------------
// CTI クライアントが HTTP ヘッダー `X-API-KEY` で送信するキー。
// 生成例: openssl rand -base64 48 | tr -d '/+=' | cut -c1-50
define('CAPIS_API_SECRET_KEY', 'CHANGE_ME_capis_api_key');

// Brew (Vodka) からの一時アクセスパス発信リクエストを認証するキー。
// 環境変数 BREW_FREEPBX_API_KEY が設定されている場合はそちらが優先されます。
define('BREW_TAP_API_SECRET_KEY', 'CHANGE_ME_brew_tap_api_key');

// -----------------------------------------------------------------------------
// Asterisk AMI (Asterisk Manager Interface)
// -----------------------------------------------------------------------------
// AMI は localhost からの接続のみ許可する専用ユーザーを作成してください。
// /etc/asterisk/manager_custom.conf の設定例:
//
//   [cti_api]
//   secret = <強力なランダム文字列>
//   deny   = 0.0.0.0/0.0.0.0
//   permit = 127.0.0.1/255.255.255.255
//   read   = system,call,user
//   write  = system,call,originate
//
define('AMI_HOST', '127.0.0.1');
define('AMI_PORT', 5038);
define('AMI_USERNAME', 'CHANGE_ME_ami_user');
define('AMI_SECRET', 'CHANGE_ME_ami_secret');
define('AMI_TIMEOUT', 3);

// -----------------------------------------------------------------------------
// 留守電 (Voicemail)
// -----------------------------------------------------------------------------
define('VOICEMAIL_CONTEXT', 'default');
define('VOICEMAIL_BASE_DIR', '/var/spool/asterisk/voicemail/' . VOICEMAIL_CONTEXT);

// 'file': 従来のファイルベース (/INBOX/msgXXXX.txt をスキャン)
// 'db'  : FreePBX 15+ の ODBC ストレージ (voicemail_messages テーブルをスキャン)
define('VOICEMAIL_STORAGE_MODE', 'file');

// -----------------------------------------------------------------------------
// 通話録音
// -----------------------------------------------------------------------------
define('RECORDING_BASE_DIR', '/var/spool/asterisk/monitor');

// -----------------------------------------------------------------------------
// FreePBX データベース (VOICEMAIL_STORAGE_MODE = 'db' の場合のみ使用)
// -----------------------------------------------------------------------------
// DB の資格情報は FreePBX の設定ファイルから読み込むため、ここには記載しません。
define('FREEPBX_CONF_PATH', '/etc/freepbx.conf');
define('DB_HOST', '127.0.0.1');
define('DB_DATABASE', 'asterisk');
define('DB_CHARSET', 'utf8mb4');

// -----------------------------------------------------------------------------
// CORS
// -----------------------------------------------------------------------------
// 完全一致で許可するオリジン。
define('CORS_ALLOWED_ORIGINS', json_encode([
    'http://localhost:8080',
    'http://localhost:3000',
]));

// 正規表現で許可するオリジン（社内ドメインなど）。
// 不要な場合は空文字 '' を設定してください。
// 例: '#^https?://[a-zA-Z0-9\-]+\.intra\.example\.com(:\d+)?$#'
define('CORS_ALLOWED_ORIGIN_PATTERN', '');

// -----------------------------------------------------------------------------
// Brew TAP (一時アクセスパスの音声案内コール)
// -----------------------------------------------------------------------------
define('TAP_CONTEXT', 'brew-tap-otp');
define('TAP_PRIORITY', 1);
define('TAP_DEFAULT_CALLER_ID', 'Brew TAP');

// 一時アクセスパスの既定有効期間（秒）。expires_at が未指定/不正な場合に使用。
define('TAP_DEFAULT_TTL_SECONDS', 600);
