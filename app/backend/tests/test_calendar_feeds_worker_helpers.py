"""Lightweight child-process targets used only by parser-isolation tests."""

import json
import sys
import time


def parser_import_probe(channel, mode, content, start, end, feed_id):
    from app import calendar_feeds as feeds

    try:
        if mode == "validate":
            feeds._validate_ics_content(content)
        else:
            feeds._parse_ics_content(content, start, end, feed_id)
        forbidden = ("fastapi", "sqlalchemy", "app.config", "app.db", "app.main")
        loaded = [name for name in forbidden if name in sys.modules]
        channel.send_bytes(json.dumps({"ok": True, "result": loaded}).encode("utf-8"))
    finally:
        channel.close()


def sleeping_parser_worker(channel, *args):
    try:
        time.sleep(60)
    finally:
        channel.close()


def oversized_parser_worker(channel, *args):
    from app import calendar_feeds as feeds

    try:
        channel.send_bytes(b"x" * (feeds.MAX_PARSER_MESSAGE_BYTES + 1))
    except (OSError, EOFError):
        pass
    finally:
        channel.close()
