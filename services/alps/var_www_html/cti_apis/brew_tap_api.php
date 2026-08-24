<?php
/**
 * Brew TAP FreePBX API Endpoint
 *
 * このエンドポイントは Brew (Vodka) からのリクエストを受け、
 * FreePBX/Asterisk に対して一時アクセスパスの音声案内コールを起動します。
 */

// -----------------------------------------------------------------------------
// 設定値
// -----------------------------------------------------------------------------

// 資格情報・環境依存値はすべて config.php に外出ししている。
// config.php は Git 管理外のため、config.example.php をコピーして作成すること。
$config_path = __DIR__ . '/config.php';
if (!is_readable($config_path)) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode([
        'status' => 'error',
        'message' => 'config.php not found. Copy config.example.php to config.php and set your values.',
    ]);
    exit;
}
require_once $config_path;

// 環境変数が設定されていればそちらを優先する
define('API_SECRET_KEY', getenv('BREW_FREEPBX_API_KEY') ?: BREW_TAP_API_SECRET_KEY);
define('DEFAULT_CALLER_ID', TAP_DEFAULT_CALLER_ID);

$response = ['status' => 'error', 'message' => 'Invalid Request'];

try {
    authenticate();
    $payload = get_json_payload();

    $action = $payload['action'] ?? null;
    if ($action !== 'tap_otp_call') {
        throw new Exception('Unsupported action', 400);
    }

    $exten = sanitize_extension($payload['exten'] ?? '');
    $otp = sanitize_otp($payload['otp'] ?? '');
    $expires_at = sanitize_string($payload['expires_at'] ?? '');
    $caller_id = sanitize_string($payload['caller_id'] ?? DEFAULT_CALLER_ID);

    originate_tap_call($exten, $otp, $expires_at, $caller_id);

    $response = ['status' => 'success', 'message' => 'Call initiated'];
} catch (Exception $ex) {
    $code = $ex->getCode();
    if ($code < 400 || $code > 599) {
        $code = 400;
    }
    http_response_code($code);
    $response = ['status' => 'error', 'message' => $ex->getMessage()];
}

if (!headers_sent()) {
    header('Content-Type: application/json');
    echo json_encode($response);
}

// -----------------------------------------------------------------------------
// ヘルパー
// -----------------------------------------------------------------------------
function authenticate() {
    $headers = getallheaders();
    $api_key = $headers['X-API-KEY'] ?? $headers['x-api-key'] ?? null;
    // タイミング攻撃を避けるため hash_equals で比較する
    if (!is_string($api_key) || !hash_equals(API_SECRET_KEY, $api_key)) {
        throw new Exception('Authentication Failed', 401);
    }
}

function get_json_payload(): array {
    $raw = file_get_contents('php://input');
    if (!$raw) {
        return $_POST ?: [];
    }
    $data = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        throw new Exception('Invalid JSON payload', 400);
    }
    return $data;
}

function sanitize_extension($exten): string {
    $value = preg_replace('/[^0-9]/', '', (string)$exten);
    if ($value === '') {
        throw new Exception('Extension is required', 400);
    }
    return $value;
}

function sanitize_otp($otp): string {
    $value = preg_replace('/[^0-9]/', '', (string)$otp);
    if ($value === '') {
        throw new Exception('OTP is required', 400);
    }
    return $value;
}

function sanitize_string($value): string {
    return trim((string)$value);
}

function originate_tap_call(string $exten, string $otp, string $expires_at, string $caller_id): void {
    $socket = ami_connect();

    // デフォルトの有効期限（現在時刻 + TAP_DEFAULT_TTL_SECONDS）
    $fallback_time = time() + TAP_DEFAULT_TTL_SECONDS;

    // ISO 8601文字列を Unix Timestamp (整数) に変換
    if ($expires_at) {
        $timestamp = strtotime($expires_at);
        // 変換失敗時はデフォルト（+10分）を使用
        if ($timestamp === false) {
            $timestamp = $fallback_time;
        }
    } else {
        // 空の場合もデフォルト（+10分）を使用
        $timestamp = $fallback_time;
    }

    $variables = [
        'TAP_CODE' => $otp,
        // 【重要】ここで計算済みの整数 $timestamp を渡す
        'TAP_EXPIRES' => $timestamp,
    ];

    $payload = "Action: Originate\r\n" .
        "Channel: Local/{$exten}@from-internal\r\n" .
        "CallerID: {$caller_id}\r\n" .
        "Context: " . TAP_CONTEXT . "\r\n" .
        "Exten: s\r\n" .
        "Priority: " . TAP_PRIORITY . "\r\n" .
        "Async: true\r\n";

    foreach ($variables as $key => $value) {
        $payload .= "Variable: {$key}={$value}\r\n";
    }
    $payload .= "\r\n";

    fwrite($socket, $payload);
    if (!ami_expect($socket, 'Success')) {
        fclose($socket);
        throw new Exception('AMI originate failed', 503);
    }

    ami_logoff($socket);
}

function ami_connect() {
    $socket = @fsockopen(AMI_HOST, AMI_PORT, $errno, $errstr, AMI_TIMEOUT);
    if (!$socket) {
        throw new Exception("AMI Connection Failed: {$errstr}", 503);
    }
    stream_set_timeout($socket, AMI_TIMEOUT);
    fwrite($socket, "Action: Login\r\n");
    fwrite($socket, "Username: " . AMI_USERNAME . "\r\n");
    fwrite($socket, "Secret: " . AMI_SECRET . "\r\n\r\n");
    if (!ami_expect($socket, 'Success')) {
        fclose($socket);
        throw new Exception('AMI Login Failed', 503);
    }
    return $socket;
}

function ami_expect($socket, string $expected): bool {
    $buffer = '';
    $start = time();
    while (!feof($socket)) {
        $line = fgets($socket, 256);
        if ($line === false) {
            break;
        }
        $buffer .= $line;
        if (stripos($buffer, $expected) !== false) {
            return true;
        }
        if (stripos($buffer, 'Error') !== false) {
            return false;
        }
        if ((time() - $start) > AMI_TIMEOUT) {
            break;
        }
    }
    return false;
}

function ami_logoff($socket): void {
    fwrite($socket, "Action: Logoff\r\n\r\n");
    fclose($socket);
}

if (!function_exists('getallheaders')) {
    function getallheaders() {
        $headers = [];
        foreach ($_SERVER as $name => $value) {
            if (substr($name, 0, 5) == 'HTTP_') {
                $headers[str_replace(' ', '-', ucwords(strtolower(str_replace('_', ' ', substr($name, 5)))))] = $value;
            }
        }
        return $headers;
    }
}
?>
