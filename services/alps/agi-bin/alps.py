#!/opt/my-agi-venv/bin/python3
# -*- coding: utf-8 -*-
# Python AGI Script for DenyCall Checker

# 必要なライブラリ
# pip install requests pyst2

import os
import sys
from datetime import datetime
from typing import Dict, Tuple

import requests
from asterisk.agi import AGI, AGIHangup

# AGI環境のセットアップ
try:
    agi = AGI()
except AGIHangup:
    # チャンネルが既にハングアップしている場合の処理
    sys.exit(0)
except Exception as e:
    # その他のAGI初期化エラー
    sys.stderr.write(f"AGI Initialization Error: {e}\n")
    sys.exit(1)

# 資格情報・環境依存値はすべて alps_config.py に外出ししている。
# alps_config.py は Git 管理外のため、alps_config.example.py をコピーして作成すること。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import alps_config as config
except ModuleNotFoundError:
    sys.stderr.write(
        'alps_config.py が見つかりません。'
        'alps_config.example.py をコピーして作成してください。\n'
    )
    sys.exit(1)

# 環境変数が設定されていればそちらを優先する
API_KEY = os.environ.get('VODKA_API_KEY') or config.API_KEY
SEARCH_API_TEMPLATE = (
    os.environ.get('VODKA_SEARCH_API_TEMPLATE') or config.SEARCH_API_TEMPLATE
)

# Teams Webhook routing table: incoming_number_pre -> (webhook, formatted_number, recall_prefix)
TEAMS_ROUTES: Dict[str, Tuple[str, str, str]] = config.TEAMS_ROUTES

DEFAULT_TEAMS_ROUTE = config.DEFAULT_TEAMS_ROUTE


def normalize_bool(value) -> bool:
    if isinstance(value, str):
        return value not in {'0', '', 'false', 'False', 'None', 'none'}
    return bool(value)


def resolve_teams_route(incoming_number_pre: str, caller_id: str) -> Tuple[str, str, str]:
    route = TEAMS_ROUTES.get(incoming_number_pre)
    webhook_url, formatted_number, recall_prefix = route if route else DEFAULT_TEAMS_ROUTE
    display_number = formatted_number or incoming_number_pre
    recall_url = f"{recall_prefix}{caller_id}"
    return webhook_url, display_number, recall_url


def build_adaptive_card(
    incoming_number: str,
    caller_id: str,
    matched_type: str,
    matched_name: str,
    incoming_date: str,
    result_deny: str,
    result_deny_reason: str,
    recall_url: str,
) -> Dict:
    matched_label = f"{matched_type}：{matched_name}" if matched_type else matched_name
    return {
        'type': 'message',
        'attachments': [
            {
                'contentType': 'application/vnd.microsoft.card.adaptive',
                'content': {
                    '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json',
                    'version': '1.4',
                    'type': 'AdaptiveCard',
                    'body': [
                        {'type': 'TextBlock', 'size': 'Medium', 'weight': 'Bolder', 'text': '着信通知'},
                        {'type': 'TextBlock', 'text': '以下の内容で着信がありました。', 'wrap': True},
                        {
                            'type': 'FactSet',
                            'facts': [
                                {'title': '着信番号', 'value': incoming_number},
                                {'title': '発信元', 'value': caller_id},
                                {'title': 'Vodka 登録情報', 'value': matched_label},
                                {'title': '着信日時', 'value': incoming_date},
                                {'title': '着拒判定', 'value': result_deny},
                                {'title': '拒否理由', 'value': result_deny_reason},
                            ],
                        },
                    ],
                    'actions': [
                        {
                            'type': 'Action.OpenUrl',
                            'title': '掛けなおす',
                            'url': f'https://teams.microsoft.com/l/call/0/0?users=4:{recall_url}',
                        },
                        {
                            'type': 'Action.OpenUrl',
                            'title': '番号を検索する',
                            'url': f'https://www.google.com/search?q={caller_id}',
                        },
                    ],
                },
            }
        ],
    }


def send_teams_notification(
    agi: AGI,
    incoming_number_pre: str,
    caller_id: str,
    matched_type: str,
    matched_name: str,
    incoming_date: str,
    result_deny: str,
    result_deny_reason: str,
) -> None:
    webhook_url, incoming_number, recall_url = resolve_teams_route(incoming_number_pre, caller_id)
    if not incoming_number or incoming_number in {'unknown', 'unknown_did', None}:
        incoming_number = incoming_number_pre

    payload = build_adaptive_card(
        incoming_number=incoming_number or '不明',
        caller_id=caller_id,
        matched_type=matched_type,
        matched_name=matched_name,
        incoming_date=incoming_date,
        result_deny=result_deny,
        result_deny_reason=result_deny_reason,
        recall_url=recall_url,
    )

    headers = {'Content-Type': 'application/json'}
    try:
        response = requests.post(
            webhook_url, json=payload, headers=headers, timeout=config.TEAMS_TIMEOUT
        )
        if response.status_code >= 400:
            agi.verbose(f"Teams notification failed: {response.status_code} {response.text}")
        else:
            agi.verbose("Teams notification sent successfully")
    except requests.RequestException as exc:
        agi.verbose(f"Teams notification error: {exc}")
    except Exception as exc:
        # フェイルオーバー: 通知処理での想定外エラーでも通話処理を止めない
        agi.verbose(f"Teams notification unexpected error: {exc}")


def fetch_vodka_call_metadata(agi: AGI, caller_id: str) -> Tuple[str, str, bool, str]:
    matched_type = '非該当'
    matched_name = 'なし'
    deny_call_flag = False
    deny_reason_code = '0'

    search_url = SEARCH_API_TEMPLATE.format(caller=caller_id)
    headers = {'X-API-KEY': API_KEY}

    try:
        response = requests.get(search_url, headers=headers, timeout=config.API_TIMEOUT)
        response.raise_for_status()
        search_result = response.json() if response.content else {}
    except requests.RequestException as exc:
        agi.verbose(f"Vodka API Error: {exc}")
        return matched_type, matched_name, deny_call_flag, deny_reason_code
    except Exception as exc:
        # フェイルオーバー: JSONデコード失敗などの想定外エラーでも既定値(許可)を返して通話を継続
        agi.verbose(f"Vodka API unexpected error: {exc}")
        return matched_type, matched_name, deny_call_flag, deny_reason_code

    if isinstance(search_result, dict):
        if 'company_name' in search_result:
            matched_type = '契約会社'
            matched_name = search_result.get('company_name', 'なし')
            deny_call_flag = normalize_bool(search_result.get('deny_call_flag', 0))
            deny_reason_code = str(search_result.get('deny_reason_code', '0'))
        elif 'lawyers_name' in search_result:
            matched_type = '弁護士'
            matched_name = search_result.get('lawyers_name', 'なし')
            deny_call_flag = normalize_bool(search_result.get('deny_call_flag', 0))
            deny_reason_code = str(search_result.get('deny_reason_code', '0'))
        else:
            matched_type = '非該当'
            deny_call_flag = False
            deny_reason_code = '0'

    return matched_type, matched_name, deny_call_flag, deny_reason_code


def evaluate_deny_result(caller_id: str, deny_call_flag: bool, deny_reason_code: str) -> Tuple[str, str]:
    if caller_id == 'anonymous':
        return '❌', '非通知電話のため拒否'

    if not deny_call_flag:
        return '✅', '拒否されていません'

    return '❌', config.DENY_REASON_LABELS.get(deny_reason_code, '拒否理由未設定')

def main():
    # ★ 修正: AGI環境変数から発信者番号を取得
    caller_id = agi.env.get('agi_callerid', 'unknown')
    
    # ★ 修正: AGI環境変数から着信番号（DID）を取得
    # agi_extensionは 's' になる可能性が高いため、DNID (Dialed Number ID) も参照
    incoming_number_pre = agi.get_variable('DID_NUMBER') or agi.env.get('agi_dnid') or agi.env.get('agi_extension') or 'unknown'
    
    # Caller IDが未取得の場合のフォールバック処理は削除（AGIが最善を尽くすため）
    if not caller_id or caller_id == 'unknown':
        caller_id = 'anonymous' # 強制的に 'anonymous' に設定
    
    # ★ 修正: 現在時刻を取得（System()の引数に頼らない）
    incoming_date = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    # ★ フェイルオーバー対策（通話切断防止）:
    #   先にコールへ応答(Answer)し開始アナウンスを再生してから外部HTTP通信を行う。
    #   こうすることで Vodka API / Power Automate の応答に時間がかかっても
    #   発信側へは音声が返り続けるため、キャリア側のタイムアウトによる CANCEL を防ぐ。
    try:
        agi.verbose('DenyCall Checker Started')
        agi.answer()
        agi.exec_command('Playback', config.SOUND_START_BGM)
        agi.exec_command('Playback', config.SOUND_START_ANNOUNCE)
    except AGIHangup:
        agi.verbose('Channel hung up before processing.')
        return
    except Exception as e:
        # 応答/アナウンスで想定外エラーが出ても後続処理は試みる
        agi.verbose(f'Error during initial announcement: {e}')

    # ★ フェイルオーバー: HTTP接続エラー等が発生しても通話を継続させる
    # Vodka検索が失敗した場合は「許可(拒否しない)」を既定値として通話を継続する
    try:
        matched_type, matched_name, deny_call_flag, deny_reason_code = fetch_vodka_call_metadata(agi, caller_id)
    except Exception as exc:
        agi.verbose(f'Vodka metadata fetch failed, defaulting to allow: {exc}')
        matched_type, matched_name, deny_call_flag, deny_reason_code = '非該当', 'なし', False, '0'

    result_deny, result_deny_reason = evaluate_deny_result(caller_id, deny_call_flag, deny_reason_code)

    # ★ フェイルオーバー: Power Automate への送信を試行するが、失敗しても通話は継続する
    try:
        send_teams_notification(
            agi=agi,
            incoming_number_pre=incoming_number_pre,
            caller_id=caller_id,
            matched_type=matched_type,
            matched_name=matched_name,
            incoming_date=incoming_date,
            result_deny=result_deny,
            result_deny_reason=result_deny_reason,
        )
    except Exception as exc:
        agi.verbose(f'Teams notification dispatch failed, continuing call: {exc}')

    try:
        # ★ ここで着信判定結果に応じた音声を再生する（チャネルは既に応答済み）
        agi.exec_command('WAIT', '1')

        agi.verbose(f'Incoming DID: {incoming_number_pre}')
        agi.verbose(f'Check Caller ID: {caller_id}')

        if caller_id == 'anonymous':
            agi.exec_command('Playback', config.SOUND_DENIED_BGM)
            agi.exec_command('Playback', config.SOUND_DENIED_ANONYMOUS)
            agi.verbose(f'Caller ID {caller_id} is denied')
            agi.exec_command('Hangup')
            return

        if deny_call_flag:
            agi.exec_command('Playback', config.SOUND_DENIED_BGM)
            agi.exec_command('Playback', config.SOUND_DENIED_INTRO)
            agi.verbose(f'Caller ID {caller_id} is denied with reason code: {deny_reason_code}')

            reason_sound = config.SOUND_DENY_REASONS.get(deny_reason_code)
            if reason_sound:
                agi.exec_command('Playback', reason_sound)

            agi.exec_command('Playback', config.SOUND_DENIED_OUTRO)
            agi.exec_command('Hangup')
        else:
            agi.exec_command('Playback', config.SOUND_ALLOWED_BGM)
            agi.verbose(f'Caller ID {caller_id} is allowed')
            agi.exec_command('Playback', config.SOUND_END_ALLOWED)

    except AGIHangup:
        agi.verbose('Channel hung up during script execution.')
    except Exception as e:
        agi.verbose(f'Unexpected Error: {e}')
        agi.exec_command('Playback', config.SOUND_ERROR)
        agi.exec_command('Hangup')


if __name__ == '__main__':
    main()
