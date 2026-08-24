<?php
/**
 * FreePBX CTI Custom API Endpoint
 *
 * このスクリプトは、CTI システムからの HTTP リクエストを受け取り、
 * FreePBX (Asterisk) の操作（プレゼンス変更、留守電管理）を実行します。
 *
 * 変更履歴:
 * - v2.0: 留守電管理を `INBOX` と `Old` フォルダの両対応に変更。
 * - v2.0: FreePBX 15+ (ODBC) のDBストレージモード (`VOICEMAIL_STORAGE_MODE = 'db'`) に対応。
 *
 * セキュリティに関する重要な注意:
 * 1. [必須] 同ディレクトリの `config.example.php` を `config.php` にコピーし、
 *    'CAPIS_API_SECRET_KEY' に強力な秘密鍵を設定してください。
 * 2. [必須] この API には必ず HTTPS (SSL) 経由でアクセスしてください。
 * 3. [必須] 'AMI_USERNAME' と 'AMI_SECRET' を FreePBX で設定した
 * AMI ユーザー（localhostからの接続のみ許可）の情報に置き換えてください。
 * 4. [必須] Apache 実行ユーザー (例: www-data, apache) を 'asterisk' グループに追加してください。
 * $ sudo usermod -aG asterisk www-data
 * $ sudo systemctl restart apache2 (または httpd)
 * 5. [DBモード時] PHP の 'pdo_mysql' 拡張モジュールが必須です。
 */

// -----------------------------------------------------------------------------
// --- 設定 (SETTING) ---
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

// FreePBX の DB 資格情報は FreePBX 自身の設定ファイルから読み込む。
// 内線情報の照会で常に使用するため、留守電の保存モードに関わらず読み込む。
if (is_readable(FREEPBX_CONF_PATH)) {
    include_once(FREEPBX_CONF_PATH);
}
define('DB_USERNAME', $amp_conf['AMPDBUSER'] ?? '');
define('DB_PASSWORD', $amp_conf['AMPDBPASS'] ?? '');

// -----------------------------------------------------------------------------
// --- グローバル変数・初期化 ---
// -----------------------------------------------------------------------------

// HTTP レスポンス用の配列
$response = ['status' => 'error', 'message' => 'Invalid Request'];

// --- CORS ヘッダー ---
// Web ブラウザ (Flutter Web 含む) からの直接アクセスを許可する
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$allowed_origins = json_decode(CORS_ALLOWED_ORIGINS, true) ?: [];
if (in_array($origin, $allowed_origins, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
} elseif ($origin !== '' && CORS_ALLOWED_ORIGIN_PATTERN !== '') {
    // 社内ネットワークなど、パターンに合致するオリジンも許可
    if (preg_match(CORS_ALLOWED_ORIGIN_PATTERN, $origin)) {
        header('Access-Control-Allow-Origin: ' . $origin);
    }
}
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-API-KEY, Authorization');
header('Access-Control-Max-Age: 86400');

// OPTIONS プリフライトリクエストはここで終了
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// --- [追加] DB接続インスタンス (遅延初期化) ---
$pdo = null;
// --- [追加] FreePBXコアDB接続インスタンス (遅延初期化) ---
$corePdo = null;

// -----------------------------------------------------------------------------
// --- メイン処理 (ROUTING) ---
// -----------------------------------------------------------------------------

// ヘルスチェック (認証不要) - CTI サーバーへの疎通確認のみ
if (($_REQUEST['action'] ?? null) === 'ping') {
    header('Content-Type: application/json');
    echo json_encode(['status' => 'ok']);
    exit;
}

try {
    // 1. 認証チェック
    authenticate();

    // 2. リクエストの振り分け
    $action = $_REQUEST['action'] ?? null;
    $method = $_SERVER['REQUEST_METHOD'];

    // POST (JSON) の場合はデコード
    $json_input = file_get_contents('php://input');
    $data = json_decode($json_input, true);
    if (json_last_error() === JSON_ERROR_NONE && isset($data['action'])) {
        $action = $data['action'];
    }

    // サニタイズされた内線番号を取得 (必須)
    $exten = null;
    if (isset($_REQUEST['exten'])) {
        $exten = sanitizeExten($_REQUEST['exten']);
    } elseif (isset($data['exten'])) {
        $exten = sanitizeExten($data['exten']);
    }

    switch ($action) {
        // [要件1] プレゼンス変更 (変更なし)
        case 'set_presence':
            if ($method === 'POST' && $exten && isset($data['status'])) {
                $response = handleSetPresence($exten, $data['status']);
            } else {
                throw new Exception('Invalid set_presence request', 400);
            }
            break;

        // [要件2] アナウンスのアップロード (変更なし)
        case 'upload_greeting':
            if ($method === 'POST' && $exten && isset($_POST['type']) && isset($_FILES['file'])) {
                $response = handleUploadGreeting($exten, $_POST['type'], $_FILES['file']);
            } else {
                throw new Exception('Invalid upload_greeting request', 400);
            }
            break;

        // [要件3] 留守電一覧 (変更なし、内部でDB/Fileモード分岐)
        case 'list_voicemail':
            if ($method === 'GET' && $exten) {
                $response = handleListVoicemail($exten);
            } else {
                throw new Exception('Invalid list_voicemail request', 400);
            }
            break;

        // [要件3] 留守電再生 (ストリーミング)
        case 'play_voicemail':
            // --- [変更] folder パラメータを必須化 ---
            if ($method === 'GET' && $exten && isset($_GET['msg']) && isset($_GET['folder'])) {
                handlePlayVoicemail(
                    $exten, 
                    sanitizeMsgId($_GET['msg']),
                    sanitizeFolder($_GET['folder']) // フォルダをサニタイズ
                );
            } else {
                throw new Exception('Invalid play_voicemail request. "msg" and "folder" are required.', 400);
            }
            break;

        // [要件3] 留守電削除
        case 'delete_voicemail':
            // --- [変更] folder パラメータを必須化 ---
            if ($method === 'POST' && $exten && isset($data['msg']) && isset($data['folder'])) {
                $response = handleDeleteVoicemail(
                    $exten,
                    sanitizeMsgId($data['msg']),
                    sanitizeFolder($data['folder']),
                    $data // DBモードの場合、追加のIDが必要なため
                );
            } else {
                throw new Exception('Invalid delete_voicemail request. "msg" and "folder" are required.', 400);
            }
            break;

        // [要件2-確認] アナウンス再生 (変更なし)
        case 'get_greeting':
            if ($method === 'GET' && $exten && isset($_GET['type'])) {
                handleGetGreeting($exten, $_GET['type']);
            } else {
                throw new Exception('Invalid get_greeting request', 400);
            }
            break;

        case 'lookup_extension':
            if ($method === 'GET' && $exten) {
                $response = handleLookupExtension($exten);
            } else {
                throw new Exception('Invalid lookup_extension request', 400);
            }
            break;

        // [追加] 通話録音一覧 (日付指定で monitor ディレクトリを山査)
        case 'list_recordings':
            if ($method === 'GET' && isset($_GET['date'])) {
                $response = handleListRecordings(
                    sanitizeDate($_GET['date']),
                    $exten // null 可、指定した場合は内線番号で絞り込み
                );
            } else {
                throw new Exception('Invalid list_recordings request. "date" is required.', 400);
            }
            break;

        // [追加] 通話録音再生 (ストリーミング)
        case 'play_recording':
            if ($method === 'GET' && isset($_GET['date']) && isset($_GET['filename'])) {
                handlePlayRecording(
                    sanitizeDate($_GET['date']),
                    sanitizeFilename($_GET['filename'])
                );
            } else {
                throw new Exception('Invalid play_recording request. "date" and "filename" are required.', 400);
            }
            break;

        // [追加] アナウンス削除
        case 'delete_greeting':
            if ($method === 'POST' && $exten && isset($data['type'])) {
                $response = handleDeleteGreeting($exten, $data['type']);
            } else {
                throw new Exception('Invalid delete_greeting request', 400);
            }
            break;

        default:
            throw new Exception('Invalid action specified', 400);
    }

} catch (Exception $e) {
    // エラーハンドリング (ストリーミング再生の失敗も含む)
    $code = $e->getCode();
    // 既知の HTTP エラーコードか確認
    if ($code < 400 || $code > 599) {
        $code = 400; // 不明な場合は 400 Bad Request
    }
    // [変更] DB接続エラーも考慮 (503 Service Unavailable)
    if ($e->getMessage() === 'DB Connection Failed') {
        $code = 503;
    }
    http_response_code($code);
    $response = ['status' => 'error', 'message' => $e->getMessage()];
}

// 最終的な JSON レスポンスを送信 (ストリーミング再生成功時以外)
if (!headers_sent()) {
    header('Content-Type: application/json');
    echo json_encode($response);
}

// -----------------------------------------------------------------------------
// --- 認証関数 (変更なし) ---
// -----------------------------------------------------------------------------
function authenticate() {
    $headers = getallheaders();
    $api_key = $headers['X-API-KEY'] ?? $headers['x-api-key'] ?? null;
    // タイミング攻撃を避けるため hash_equals で比較する
    if (!is_string($api_key) || !hash_equals(CAPIS_API_SECRET_KEY, $api_key)) {
        throw new Exception('Authentication Failed', 401);
    }
}

// -----------------------------------------------------------------------------
// --- [要件1] プレゼンス処理 (変更なし) ---
// -----------------------------------------------------------------------------
function handleSetPresence($exten, $status) {
    sendAmiCommand("database del DND {$exten}");
    sendAmiCommand("database del CF {$exten}");
    sendAmiCommand("database del CFU {$exten}");
    $message = "Status set to '{$status}'";
    switch ($status) {
        case 'available':
            break;
        case 'busy':
            // AGI (check_action.py) が VOICEMAIL_BUSY にルーティングするため DND は設定しない。
            // リンググループ着信も引き続き受け付け、通話できない場合はボイスメールへ誘導する。
            break;
        case 'dnd':
            sendAmiCommand("database put DND {$exten} YES");
            break;
        case 'away':
            // CF は設定しない。AGI (check_action.py) がプレゼンス DB を参照して
            // VOICEMAIL_AWAY としてルーティングするため、CF による割り込みは不要。
            break;
        default:
            throw new Exception("Unknown status: {$status}", 400);
    }
    return ['status' => 'success', 'message' => $message];
}

// -----------------------------------------------------------------------------
// --- [要件2] アナウンスアップロード処理 (変更なし) ---
// -----------------------------------------------------------------------------
function handleUploadGreeting($exten, $type, $file) {
    if ($file['error'] !== UPLOAD_ERR_OK) {
        throw new Exception('File upload error', 400);
    }
    $voicemail_dir = VOICEMAIL_BASE_DIR . '/' . $exten;
    if (!is_dir($voicemail_dir)) {
        if (!mkdir($voicemail_dir, 0775, true) && !is_dir($voicemail_dir)) {
             throw new Exception("Failed to create voicemail directory: {$voicemail_dir}", 500);
        }
        chown($voicemail_dir, 'asterisk');
        chgrp($voicemail_dir, 'asterisk');
    }
    $target_filename = '';
    switch ($type) {
        case 'busy': $target_filename = 'busy.wav'; break;
        case 'dnd': $target_filename = 'dnd.wav'; break;
        case 'away': $target_filename = 'unavail.wav'; break;
        default:
            throw new Exception("Invalid greeting type: {$type}", 400);
    }
    $temp_file = $file['tmp_name'];
    $final_path = $voicemail_dir . '/' . $target_filename;
    $sox_command = sprintf(
        "sox %s -r 8000 -c 1 -b 16 %s",
        escapeshellarg($temp_file),
        escapeshellarg($final_path)
    );
    $sox_output = shell_exec($sox_command . " 2>&1");
    if (!file_exists($final_path) || filesize($final_path) === 0) {
        throw new Exception("Failed to convert audio file using sox. Output: {$sox_output}", 500);
    }
    chown($final_path, 'asterisk');
    chgrp($final_path, 'asterisk');
    chmod($final_path, 0664);
    return ['status' => 'success', 'message' => "{$target_filename} uploaded successfully."];
}

// -----------------------------------------------------------------------------
// --- [要件2-確認] アナウンス再生 (変更なし) ---
// -----------------------------------------------------------------------------
function handleGetGreeting($exten, $type) {
    $voicemail_dir = VOICEMAIL_BASE_DIR . '/' . $exten;
    $target_filename = '';
    switch ($type) {
        case 'busy': $target_filename = 'busy.wav'; break;
        case 'dnd': $target_filename = 'dnd.wav'; break;
        case 'away': $target_filename = 'unavail.wav'; break;
        default:
            throw new Exception("Invalid greeting type: '{$type}'", 400);
    }
    $file_path = $voicemail_dir . '/' . $target_filename;
    if (!file_exists($file_path)) {
        throw new Exception("Greeting file '{$target_filename}' not found for exten '{$exten}'.", 404);
    }
    if (!is_readable($file_path)) {
        throw new Exception("Permission denied: Cannot read greeting '{$target_filename}'. Check Apache permissions.", 403);
    }
    header('Content-Type: audio/wav');
    header('Content-Length: ' . filesize($file_path));
    header('Accept-Ranges: bytes');
    readfile($file_path);
    exit;
}

// --- [追加] 内線情報の参照 (FreePBX DB) ---
function handleLookupExtension($exten) {
    $pdo = getFreepbxPdo();

    try {
        $stmt = $pdo->prepare('SELECT extension, name, voicemail FROM users WHERE extension = ? LIMIT 1');
        $stmt->execute([$exten]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
    } catch (PDOException $e) {
        throw new Exception('Database query failed: ' . $e->getMessage(), 500);
    }

    if (!$user) {
        throw new Exception("Extension '{$exten}' not found", 404);
    }

    $device = null;
    try {
        $stmt = $pdo->prepare('SELECT id, tech, devicetype, description FROM devices WHERE id = ? LIMIT 1');
        $stmt->execute([$exten]);
        $device = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
    } catch (PDOException $e) {
        // デバイス情報は必須ではないため、エラーはログ目的で例外として扱わず通知のみ
        error_log('Device lookup failed: ' . $e->getMessage());
    }

    $voicemail_box = $user['voicemail'] ?? '';
    $mailbox_parts = explode('@', $voicemail_box);
    $mailbox = $mailbox_parts[0] ?? '';
    $mailbox_context = $mailbox_parts[1] ?? VOICEMAIL_CONTEXT;

    $voicemail_dir = VOICEMAIL_BASE_DIR . '/' . $exten;
    $greeting_files = [
        'busy' => 'busy.wav',
        'away' => 'unavail.wav',
        'dnd'  => 'dnd.wav'
    ];

    $greetings = [];
    foreach ($greeting_files as $key => $filename) {
        $path = $voicemail_dir . '/' . $filename;
        $greetings[$key] = [
            'exists' => file_exists($path),
            'filename' => $filename,
            'updated_at' => file_exists($path) ? date('c', filemtime($path)) : null
        ];
    }

    return [
        'status' => 'success',
        'extension' => $user['extension'],
        'display_name' => $user['name'] ?? '',
        'voicemail' => $voicemail_box,
        'voicemail_box' => $mailbox,
        'voicemail_context' => $mailbox_context,
        'voicemail_directory_exists' => is_dir($voicemail_dir),
        'greetings' => $greetings,
        'device' => $device
    ];
}

// -----------------------------------------------------------------------------
// --- [要件3] 留守電管理 (DB / File 分岐) ---
// -----------------------------------------------------------------------------

/**
 * [変更] 留守電一覧のメインハンドラ (モードによって分岐)
 */
function handleListVoicemail($exten) {
    if (VOICEMAIL_STORAGE_MODE === 'db') {
        return handleListVoicemail_DB($exten);
    } else {
        return handleListVoicemail_File($exten);
    }
}

/**
 * [変更] 留守電削除のメインハンドラ (モードによって分岐)
 */
function handleDeleteVoicemail($exten, $msg_id, $folder, $data) {
    if (VOICEMAIL_STORAGE_MODE === 'db') {
        // [追加] DBモードでは、削除に DB の Primary Key (id) が必要
        if (!isset($data['db_id'])) {
            throw new Exception("db_id is required for delete in DB mode.", 400);
        }
        $db_id = filter_var($data['db_id'], FILTER_VALIDATE_INT);
        if ($db_id === false) {
             throw new Exception("Invalid db_id.", 400);
        }
        return handleDeleteVoicemail_DB($exten, $msg_id, $folder, $db_id);
    } else {
        return handleDeleteVoicemail_File($exten, $msg_id, $folder);
    }
}

/**
 * [変更] 留守電の音声ファイル (wav) をストリーミング再生 (INBOX/Old 対応)
 * (DB/File モード共通)
 */
function handlePlayVoicemail($exten, $msg_id, $folder) {
    // $msg_id と $folder は既にサニタイズ済み
    
    // 1. ファイルパスの構築
    $file_path = VOICEMAIL_BASE_DIR . '/' . $exten . '/' . $folder . '/' . $msg_id . '.wav';
    
    // .wav がない場合、 .WAV も試す
    if (!file_exists($file_path)) {
        $file_path = VOICEMAIL_BASE_DIR . '/' . $exten . '/' . $folder . '/' . $msg_id . '.WAV';
    }

    // 2. 存在チェック
    if (!file_exists($file_path)) {
        throw new Exception("Voicemail message '{$msg_id}' not found in '{$folder}'.", 404);
    }

    // 3. 読み取り権限チェック
    if (!is_readable($file_path)) {
        throw new Exception("Permission denied: Cannot read message '{$msg_id}'. Check Apache permissions.", 403);
    }

    // 4. 成功: ストリーミング
    header('Content-Type: audio/wav');
    header('Content-Length: ' . filesize($file_path));
    header('Accept-Ranges: bytes');
    
    readfile($file_path);
    exit;
}

// --- [追加] DBモード: 留守電一覧 ---
function handleListVoicemail_DB($exten) {
    $pdo = getDbConnection();
    $messages = [];
    
    // DBモードでは、dir カラムにフルパス (INBOX/Old 含む) が格納されている
    $path_inbox = VOICEMAIL_BASE_DIR . '/' . $exten . '/INBOX';
    $path_old = VOICEMAIL_BASE_DIR . '/' . $exten . '/Old';

    // `voicemail_messages` テーブルから検索
    $sql = "SELECT id, dir, msgnum, callerid, origtime, duration 
            FROM voicemail_messages 
            WHERE dir = ? OR dir = ? 
            ORDER BY msgnum";
            
    try {
        $stmt = $pdo->prepare($sql);
        $stmt->execute([$path_inbox, $path_old]);
        
        while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
            $messages[] = [
                // [変更] CTIが使うID (msgXXXX) と DBのPK (id) を両方返す
                'id'       => sprintf('msg%04d', $row['msgnum']), // "msg0001"
                'db_id'    => (int)$row['id'], // データベースの Primary Key (削除時に必須)
                'folder'   => basename($row['dir']), // "INBOX" または "Old"
                'callerid' => $row['callerid'] ?? 'Unknown',
                'origtime' => (int)($row['origtime'] ?? 0),
                'duration' => (int)($row['duration'] ?? 0)
            ];
        }
    } catch (PDOException $e) {
        throw new Exception("Database query failed: " . $e->getMessage(), 500);
    }

    return ['status' => 'success', 'messages' => $messages];
}

// --- [追加] DBモード: 留守電削除 ---
function handleDeleteVoicemail_DB($exten, $msg_id, $folder, $db_id) {
    $pdo = getDbConnection();
    
    // 1. DBからメタデータを削除
    try {
        $stmt = $pdo->prepare("DELETE FROM voicemail_messages WHERE id = ?");
        $stmt->execute([$db_id]);
        
        if ($stmt->rowCount() === 0) {
            // DBに行が存在しなかった場合（ファイルは残っているかもしれない）
            // 404 を投げるか、ファイル削除に進むか選択できるが、ここではファイル削除も試みる
        }
        
    } catch (PDOException $e) {
        throw new Exception("Database delete failed: " . $e->getMessage(), 500);
    }
    
    // 2. 関連するファイルも削除 (Fileモードの削除ロジックを流用)
    // (DBから消えてもファイルが残っている場合があるため)
    try {
        $file_response = handleDeleteVoicemail_File($exten, $msg_id, $folder);
        // file_response は成功か404を投げる
        
    } catch (Exception $file_e) {
        // DBからは消したが、ファイルの削除に失敗した場合
        if ($file_e->getCode() === 404) {
             // ファイルは元々なかった (DBだけ残っていた) -> 正常終了
             return ['status' => 'success', 'message' => "Message {$msg_id} (db_id: {$db_id}) deleted from DB. Files not found (already deleted)."];
        } else {
            // 権限エラーなど
            throw $file_e;
        }
    }

    return ['status' => 'success', 'message' => "Message {$msg_id} (db_id: {$db_id}) deleted from DB and filesystem."];
}


// --- [変更] Fileモード: 留守電一覧 (INBOX/Old 対応) ---
function handleListVoicemail_File($exten) {
    $messages = [];
    
    // [変更] 検索対象フォルダ
    $folders_to_scan = [
        'INBOX' => VOICEMAIL_BASE_DIR . '/' . $exten . '/INBOX/',
        'Old'   => VOICEMAIL_BASE_DIR . '/' . $exten . '/Old/'
    ];
    
    $all_meta_files = [];

    foreach ($folders_to_scan as $folder_name => $dir_path) {
        if (!is_dir($dir_path)) {
            continue; // フォルダがなくてもエラーにしない
        }
        
        $meta_files = glob($dir_path . 'msg*.txt');
        if ($meta_files === false) {
            throw new Exception("Failed to read directory: {$dir_path}", 500);
        }
        
        // [変更] どのフォルダのファイルか情報を付与
        foreach ($meta_files as $file) {
            $all_meta_files[] = ['path' => $file, 'folder' => $folder_name];
        }
    }
    
    // ファイル名 (msgXXXX) でソート
    sort($all_meta_files, SORT_STRING);
    
    foreach ($all_meta_files as $file_info) {
        $data = parse_ini_file($file_info['path']);
        if ($data) {
            $messages[] = [
                'id'       => basename($file_info['path'], '.txt'), // "msg0001"
                'folder'   => $file_info['folder'], // [追加] "INBOX" または "Old"
                'callerid' => $data['callerid'] ?? 'Unknown',
                'origtime' => (int)($data['origtime'] ?? 0),
                'duration' => (int)($data['duration'] ?? 0)
            ];
        }
    }

    return ['status' => 'success', 'messages' => $messages];
}

// --- [変更] Fileモード: 留守電削除 (INBOX/Old 対応) ---
function handleDeleteVoicemail_File($exten, $msg_id, $folder) {
    // $msg_id と $folder は既にサニタイズ済み

    // 1. パス構築
    $base_path = VOICEMAIL_BASE_DIR . '/' . $exten . '/' . $folder . '/' . $msg_id;
    
    $files_to_delete = [
        $base_path . '.txt',
        $base_path . '.wav',
        $base_path . '.WAV',
        $base_path . '.gsm',
        $base_path . '.GSM' // 大文字小文字を考慮
    ];

    $deleted_count = 0;
    $found_count = 0;
    foreach ($files_to_delete as $file) {
        if (file_exists($file)) {
            $found_count++;
            if (is_writable($file)) {
                if (unlink($file)) {
                    $deleted_count++;
                } else {
                     throw new Exception("Failed to delete '{$file}'.", 500);
                }
            } else {
                throw new Exception("Permission denied: Cannot delete '{$file}'.", 403);
            }
        }
    }

    if ($found_count > 0 && $deleted_count > 0) {
        return ['status' => 'success', 'message' => "Message {$msg_id} deleted from {$folder}."];
    } else {
        throw new Exception("Message {$msg_id} not found in {$folder}.", 404);
    }
}


// -----------------------------------------------------------------------------
// --- ヘルパー関数 ---
// -----------------------------------------------------------------------------

// --- [追加] FreePBXコアDB接続ヘルパー ---
function getFreepbxPdo() {
    global $corePdo;
    if ($corePdo !== null) {
        return $corePdo;
    }

    if (!extension_loaded('pdo_mysql')) {
        throw new Exception("PDO MySQL extension is not loaded.", 500);
    }

    if (DB_USERNAME === '') {
        throw new Exception(
            'FreePBX DB credentials are unavailable. Check FREEPBX_CONF_PATH in config.php.',
            500
        );
    }

    $dsn = "mysql:host=" . DB_HOST . ";dbname=" . DB_DATABASE . ";charset=" . DB_CHARSET;
    $options = [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ];

    try {
        $corePdo = new PDO($dsn, DB_USERNAME, DB_PASSWORD, $options);
        return $corePdo;
    } catch (PDOException $e) {
        throw new Exception("DB Connection Failed", 503);
    }
}

// --- [追加] DB接続ヘルパー ---
function getDbConnection() {
    global $pdo;
    if ($pdo !== null) {
        return $pdo;
    }

    if (VOICEMAIL_STORAGE_MODE !== 'db') {
        throw new Exception("DB mode is not enabled.", 500);
    }
    
    if (!extension_loaded('pdo_mysql')) {
         throw new Exception("PDO MySQL extension is not loaded.", 500);
    }

    $dsn = "mysql:host=" . DB_HOST . ";dbname=" . DB_DATABASE . ";charset=" . DB_CHARSET;
    $options = [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ];

    try {
        $pdo = new PDO($dsn, DB_USERNAME, DB_PASSWORD, $options);
        return $pdo;
    } catch (PDOException $e) {
        // DB接続失敗は 503 Service Unavailable を返すのが適切
        throw new Exception("DB Connection Failed", 503);
    }
}


// --- AMI コマンド (変更なし) ---
function sendAmiCommand($command) {
    $socket = @fsockopen(AMI_HOST, AMI_PORT, $errno, $errstr, AMI_TIMEOUT);
    if (!$socket) {
        throw new Exception("AMI Connection Failed: $errstr", 503);
    }
    stream_set_timeout($socket, AMI_TIMEOUT);
    fputs($socket, "Action: Login\r\n");
    fputs($socket, "Username: " . AMI_USERNAME . "\r\n");
    fputs($socket, "Secret: " . AMI_SECRET . "\r\n\r\n");
    if (!checkAmiResponse($socket, 'Success')) {
        fclose($socket);
        throw new Exception('AMI Login Failed', 503);
    }
    fputs($socket, "Action: Command\r\n");
    fputs($socket, "Command: {$command}\r\n\r\n");
    fputs($socket, "Action: Logoff\r\n\r\n");
    for ($i = 0; $i < 5; $i++) {
        @fgets($socket, 256);
    }
    fclose($socket);
    return true;
}

// --- AMI レスポンスチェック (変更なし) ---
function checkAmiResponse($socket, $wait_for) {
    $response = '';
    $start_time = time();
    while (true) {
        if (feof($socket)) break;
        $line = fgets($socket, 256);
        if ($line === false) break;
        $response .= $line;
        if (strpos($response, $wait_for) !== false) return true;
        if (strpos($response, 'Error') !== false) return false;
        if (time() - $start_time > AMI_TIMEOUT) break;
    }
    return false;
}

// --- 内線番号サニタイズ (変更なし) ---
function sanitizeExten($exten) {
    $sanitized = preg_replace('/[^a-zA-Z0-9]/', '', $exten);
    if (empty($sanitized) || $sanitized !== $exten) {
        throw new Exception("Invalid extension format: '{$exten}'", 400);
    }
    return $sanitized;
}

// --- メッセージIDサニタイズ (変更なし) ---
function sanitizeMsgId($msg_id) {
    $sanitized = preg_replace('/[^a-zA-Z0-9]/', '', $msg_id);
    if (strpos($sanitized, 'msg') !== 0 || $sanitized !== $msg_id) {
        throw new Exception("Invalid message ID format: '{$msg_id}'", 400);
    }
    return $sanitized;
}

// --- [追加] フォルダ サニタイズ ---
function sanitizeFolder($folder) {
    // INBOX と Old のみ許可
    if ($folder === 'INBOX' || $folder === 'Old') {
        return $folder;
    }
    throw new Exception("Invalid folder specified: '{$folder}'. Must be 'INBOX' or 'Old'.", 400);
}


// -----------------------------------------------------------------------------
// --- [追加] 通話録音管理
// -----------------------------------------------------------------------------

/**
 * 特定日付の録音ファイル一覧を返す。
 *
 * ファイル名形式: {in|out}-{from}-{to}-{YYYYMMDD}-{HHMMSS}-{uniqueid}.wav
 * 内線番号指定時: to または from が $exten と一致するもののみ返す。
 */
function handleListRecordings($date_str, $exten = null) {
    // date_str = 'YYYYMMDD' → パスに変換
    $year  = substr($date_str, 0, 4);
    $month = substr($date_str, 4, 2);
    $day   = substr($date_str, 6, 2);
    $dir   = RECORDING_BASE_DIR . "/{$year}/{$month}/{$day}/";

    if (!is_dir($dir)) {
        return ['status' => 'success', 'recordings' => []];
    }

    $files = glob($dir . '*.wav');
    if ($files === false) {
        throw new Exception("Failed to read recording directory: {$dir}", 500);
    }

    $recordings = [];
    foreach ($files as $filepath) {
        $filename = basename($filepath);
        // パターン: {direction}-{from}-{to}-{YYYYMMDD}-{HHMMSS}-{uniqueid}.wav
        if (!preg_match('/^(in|out)-([^-]+)-([^-]+)-(\d{8})-(\d{6})-(.+)\.wav$/i', $filename, $m)) {
            continue; // 命名規則に一致しないファイルはスキップ
        }
        $direction   = strtolower($m[1]); // 'in' or 'out'
        $from_number = $m[2];
        $to_number   = $m[3];
        $file_date   = $m[4]; // YYYYMMDD
        $file_time   = $m[5]; // HHMMSS
        $uniqueid    = $m[6];

        // 内線番号フィルター: to または from が一致するもののみ
        if ($exten !== null) {
            if ($to_number !== $exten && $from_number !== $exten) {
                continue;
            }
        }

        // ファイル大きさ 0 は録音失敗とみなす
        $filesize = filesize($filepath);
        if ($filesize === 0) continue;

        // 通話日時文字列を構築 (ISO 8601 形式)
        $datetime_str = substr($file_date, 0, 4) . '-' . substr($file_date, 4, 2) . '-' . substr($file_date, 6, 2)
            . 'T' . substr($file_time, 0, 2) . ':' . substr($file_time, 2, 2) . ':' . substr($file_time, 4, 2) . '+09:00';

        $recordings[] = [
            'filename'    => $filename,
            'direction'   => $direction,  // 'in' or 'out'
            'from_number' => $from_number,
            'to_number'   => $to_number,
            'datetime'    => $datetime_str,
            'date'        => $file_date,
            'filesize'    => (int)$filesize,
        ];
    }

    // 日時順にソート
    usort($recordings, fn($a, $b) => strcmp($a['datetime'], $b['datetime']));

    return ['status' => 'success', 'recordings' => $recordings];
}

/**
 * 録音ファイルをストリーミング再生する。
 * $date_str = 'YYYYMMDD', $filename = サニタイズ済ファイル名
 */
function handlePlayRecording($date_str, $filename) {
    $year  = substr($date_str, 0, 4);
    $month = substr($date_str, 4, 2);
    $day   = substr($date_str, 6, 2);
    $filepath = RECORDING_BASE_DIR . "/{$year}/{$month}/{$day}/{$filename}";

    // パストラバーサル防止: 必ず monitor ディレクトリ配下にあることを確認
    $realpath = realpath($filepath);
    $base_realpath = realpath(RECORDING_BASE_DIR);
    if ($realpath === false || $base_realpath === false
        || strpos($realpath, $base_realpath . DIRECTORY_SEPARATOR) !== 0) {
        throw new Exception('Invalid recording path.', 400);
    }

    if (!file_exists($realpath)) {
        throw new Exception("Recording file not found: {$filename}", 404);
    }
    if (!is_readable($realpath)) {
        throw new Exception("Permission denied: Cannot read recording {$filename}.", 403);
    }

    header('Content-Type: audio/wav');
    header('Content-Length: ' . filesize($realpath));
    header('Accept-Ranges: bytes');
    header('Content-Disposition: inline; filename="' . $filename . '"');
    readfile($realpath);
    exit;
}

/**
 * アナウンスファイルを削除する。
 */
function handleDeleteGreeting($exten, $type) {
    $voicemail_dir = VOICEMAIL_BASE_DIR . '/' . $exten;
    $target_filename = '';
    switch ($type) {
        case 'busy': $target_filename = 'busy.wav'; break;
        case 'dnd':  $target_filename = 'dnd.wav';  break;
        case 'away': $target_filename = 'unavail.wav'; break;
        default:
            throw new Exception("Invalid greeting type: '{$type}'", 400);
    }
    $file_path = $voicemail_dir . '/' . $target_filename;
    if (!file_exists($file_path)) {
        throw new Exception("Greeting file '{$target_filename}' not found for exten '{$exten}'.", 404);
    }
    if (!is_writable($file_path)) {
        throw new Exception("Permission denied: Cannot delete greeting '{$target_filename}'.", 403);
    }
    if (!unlink($file_path)) {
        throw new Exception("Failed to delete greeting '{$target_filename}'.", 500);
    }
    return ['status' => 'success', 'message' => "{$target_filename} deleted successfully."];
}

// -----------------------------------------------------------------------------
// --- [追加] 入力値サニタイズヘルパー
// -----------------------------------------------------------------------------

// 日付サニタイズ: YYYYMMDD 形式のみ許可
function sanitizeDate($date) {
    if (!preg_match('/^\d{8}$/', $date)) {
        throw new Exception("Invalid date format: '{$date}'. Expected YYYYMMDD.", 400);
    }
    return $date;
}

// 録音ファイル名サニタイズ: {in|out}-..-..-........-......-....wav のみ許可 (ディレクトリトラバーサル防止)
function sanitizeFilename($filename) {
    // スラッシュ・ドット普通パスを禁止
    if (strpos($filename, '/') !== false || strpos($filename, '\\') !== false
        || strpos($filename, '..') !== false) {
        throw new Exception("Invalid filename: '{$filename}'.", 400);
    }
    // ファイル名は .wav または .WAV で終わること
    if (!preg_match('/\.wav$/i', $filename)) {
        throw new Exception("Only .wav files are allowed.", 400);
    }
    return basename($filename); // basename でディレクトリ部分を除去
}

// --- getallheaders() ポリフィル (変更なし) ---
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