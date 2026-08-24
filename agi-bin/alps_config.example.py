# -*- coding: utf-8 -*-
"""
ALPS (DenyCall Checker) 設定テンプレート
=============================================================================
このファイルを同じディレクトリに `alps_config.py` としてコピーし、
実際の値を設定してください。`alps_config.py` は Git 管理外です。

    $ cp alps_config.example.py alps_config.py
    $ chmod 640 alps_config.py
    $ chown root:asterisk alps_config.py

※ このファイル自体には実際の資格情報を書き込まないでください。
※ 各値は環境変数でも上書きできます（環境変数が優先されます）。
=============================================================================
"""

# -----------------------------------------------------------------------------
# Vodka (顧客情報 API)
# -----------------------------------------------------------------------------
# 環境変数 VODKA_API_KEY で上書き可能
API_KEY = 'CHANGE_ME_vodka_api_key'

# 発信元番号から顧客情報を検索するエンドポイント。
# {caller} が発信元番号に置換されます。
# 環境変数 VODKA_SEARCH_API_TEMPLATE で上書き可能
SEARCH_API_TEMPLATE = 'https://vodka.example.com/aroma/api/search_by_phone/?phone={caller}'

# API 呼び出しのタイムアウト（秒）
API_TIMEOUT = 5

# -----------------------------------------------------------------------------
# Teams 通知ルーティング
# -----------------------------------------------------------------------------
# 着信番号 (DID) ごとに、通知先の Power Automate Webhook を切り替えます。
#
#   '<DIDの生番号>': (
#       '<Power Automate の HTTP トリガー URL>',
#       '<Teams カードに表示する整形済み番号>',
#       '<折り返し発信に使う内線プレフィックス>',
#   )
#
# ⚠ Power Automate の URL は末尾に署名 (sig=) を含むため、
#    URL そのものが認証情報です。絶対に公開しないでください。
TEAMS_ROUTES = {
    # '0000000000': (
    #     'https://<your-powerautomate-trigger-url>',
    #     '000-000-0000',
    #     '9101',
    # ),
}

# TEAMS_ROUTES に一致しない着信番号で使用する既定のルート。
#   (Webhook URL, 表示番号 or None, 折り返しプレフィックス)
DEFAULT_TEAMS_ROUTE = (
    'https://<your-default-powerautomate-trigger-url>',
    None,
    '9010',
)

# Teams 通知のタイムアウト（秒）
TEAMS_TIMEOUT = 5

# -----------------------------------------------------------------------------
# 音声ファイル
# -----------------------------------------------------------------------------
# Asterisk の sounds ディレクトリからの相対パス（拡張子なし）
SOUND_START_BGM = 'custom/ALPS_Started_BGM'
SOUND_START_ANNOUNCE = 'custom/ALPS_Start_Announce'
SOUND_ALLOWED_BGM = 'custom/ALPS_Allowed_BGM'
SOUND_END_ALLOWED = 'custom/ALPS_End_Allowed'
SOUND_DENIED_BGM = 'custom/ALPS_Denied_BGM'
SOUND_DENIED_INTRO = 'custom/ALPS_Denied_1'
SOUND_DENIED_OUTRO = 'custom/ALPS_Denied_99'
SOUND_DENIED_ANONYMOUS = 'custom/ALPS_End_Anonymouns'
SOUND_ERROR = 'custom/ALPS_Error_Announce'

# 拒否理由コード → 再生する音声ファイル
SOUND_DENY_REASONS = {
    '1': 'custom/ALPS_Denied_GeneralReason',
    '2': 'custom/ALPS_Denied_ManyInvalidCall',
    '3': 'custom/ALPS_Denied_Timeout',
}

# 拒否理由コード → Teams カードに表示する文言
DENY_REASON_LABELS = {
    '1': '総合的判断による拒否',
    '2': '複数回の間違い電話による拒否',
    '3': '一時的な拒否',
}
