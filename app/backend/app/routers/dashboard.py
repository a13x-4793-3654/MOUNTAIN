from fastapi import APIRouter
from sqlalchemy import text

from ..claim_calculation import CLAIM_CALC_CTE, PAY_AGG_CTE
from ..db import engine

router = APIRouter(prefix="/api", tags=["dashboard"])

_OVERDUE_CTES = f"""
    {PAY_AGG_CTE},
    {CLAIM_CALC_CTE},
    overdue_claims AS (
      SELECT id, contract_id, due_at,
             (claim_total_amount - paid_amount) AS remaining_balance
      FROM claim_calc
      WHERE status<>'canceled' AND claim_total_amount > paid_amount AND due_at < now()
    )
"""

KPI_SQL = text(
    f"""
    WITH {_OVERDUE_CTES}
    SELECT
      (SELECT count(*) FROM contracts) AS contracts_total,
      (SELECT count(*) FROM contracts WHERE contract_status='delinquent') AS contracts_delinquent,
      (SELECT count(*) FROM contracts WHERE contract_status='litigation') AS contracts_litigation,
      (SELECT count(*) FROM contracts WHERE contract_status='active') AS contracts_active,
      (SELECT count(*) FROM contracts WHERE review_status='pending') AS reviews_pending,
      (SELECT count(*) FROM overdue_claims) AS overdue_count,
      (SELECT COALESCE(sum(remaining_balance),0) FROM overdue_claims) AS overdue_amount,
      (SELECT count(*) FROM lawsuits WHERE status = '係争中') AS lawsuits_active,
      (SELECT count(*) FROM call_histories
         WHERE call_result IN ('missed','voicemail')) AS calls_missed
    """
)

REVIEWS_SQL = text(
    """
    SELECT id, contract_no, contract_summary
    FROM contracts
    WHERE review_status='pending'
    ORDER BY created_at
    LIMIT 5
    """
)

OVERDUE_SQL = text(
    f"""
    WITH {_OVERDUE_CTES}
    SELECT cl.id, cl.contract_id, c.contract_no,
           cl.remaining_balance, cl.due_at
    FROM overdue_claims cl
    JOIN contracts c ON c.id = cl.contract_id
    ORDER BY cl.due_at ASC
    LIMIT 5
    """
)

MISSED_SQL = text(
    """
    SELECT ch.id, ch.from_number, ch.started_at,
           ch.call_result, ch.linked_contract_id, c.contract_no
    FROM call_histories ch
    LEFT JOIN contracts c ON c.id = ch.linked_contract_id
    WHERE ch.call_result IN ('missed','voicemail')
    ORDER BY ch.started_at DESC
    LIMIT 5
    """
)

RECENT_COMMS_SQL = text(
    """
    SELECT c.contract_id, co.contract_no, c.occurred_at,
           c.channel, c.direction, c.summary
    FROM communications c
    JOIN contracts co ON co.id = c.contract_id
    ORDER BY c.occurred_at DESC
    LIMIT 8
    """
)

RECENT_CALLS_SQL = text(
    """
    SELECT ch.id, ch.linked_contract_id, c.contract_no,
           ch.started_at, ch.direction, ch.duration_seconds, ch.call_result
    FROM call_histories ch
    LEFT JOIN contracts c ON c.id = ch.linked_contract_id
    ORDER BY ch.started_at DESC
    LIMIT 8
    """
)

RECENT_PAYS_SQL = text(
    """
    SELECT p.contract_id, co.contract_no, p.received_at, p.amount, p.received_method
    FROM payments p
    JOIN contracts co ON co.id = p.contract_id
    ORDER BY p.received_at DESC
    LIMIT 8
    """
)


def _fmt_yen(v) -> str:
    try:
        return "¥{:,}".format(int(v))
    except Exception:
        return "¥0"


@router.get("/dashboard")
def get_dashboard():
    with engine.connect() as cn:
        kpi = cn.execute(KPI_SQL).mappings().first()
        reviews = cn.execute(REVIEWS_SQL).mappings().all()
        overdue = cn.execute(OVERDUE_SQL).mappings().all()
        missed = cn.execute(MISSED_SQL).mappings().all()
        comms = cn.execute(RECENT_COMMS_SQL).mappings().all()
        calls = cn.execute(RECENT_CALLS_SQL).mappings().all()
        pays = cn.execute(RECENT_PAYS_SQL).mappings().all()

    tasks = []
    for r in reviews:
        tasks.append({
            "kind": "review",
            "severity": "warning",
            "title": "新規契約の登録審査",
            "detail": f"{r['contract_no']}　{r['contract_summary'] or ''}",
            "to": f"/contracts/{r['id']}",
        })
    for r in overdue:
        tasks.append({
            "kind": "claim",
            "severity": "danger",
            "title": "期日超過の請求",
            "detail": f"{r['contract_no']}　{_fmt_yen(r['remaining_balance'])}",
            "due_at": r["due_at"],
            "to": f"/contracts/{r['contract_id']}",
        })
    for r in missed:
        tasks.append({
            "kind": "call",
            "severity": "info",
            "title": "留守電" if r["call_result"] == "voicemail" else "折り返し電話",
            "detail": f"{r['from_number'] or '番号不明'}"
                      + (f"　{r['contract_no']}" if r["contract_no"] else ""),
            "occurred_at": r["started_at"],
            "to": f"/cti/{r['id']}",
        })

    recent = []
    for r in comms:
        recent.append({
            "kind": "comm",
            "occurred_at": r["occurred_at"],
            "title": f"{r['channel'] or 'やり取り'}／{r['contract_no']}",
            "detail": r["summary"] or "",
            "to": f"/contracts/{r['contract_id']}",
        })
    for r in calls:
        recent.append({
            "kind": "call",
            "occurred_at": r["started_at"],
            "title": ("着信" if r["direction"] == "in" else "発信")
                     + (f"／{r['contract_no']}" if r["contract_no"] else ""),
            "detail": f"通話 {r['duration_seconds'] or 0} 秒",
            "to": f"/cti/{r['id']}",
        })
    for r in pays:
        recent.append({
            "kind": "payment",
            "occurred_at": r["received_at"],
            "title": f"入金／{_fmt_yen(r['amount'])}",
            "detail": f"{r['received_method'] or ''}　{r['contract_no']}",
            "to": f"/contracts/{r['contract_id']}",
        })
    recent = [x for x in recent if x["occurred_at"] is not None]
    recent.sort(key=lambda x: x["occurred_at"], reverse=True)
    recent = recent[:8]

    return {
        "kpis": dict(kpi),
        "tasks": tasks,
        "recent": recent,
    }
