PAY_AGG_CTE = """
    pay_agg AS (
      SELECT contract_id, COALESCE(SUM(amount),0) AS pay_net
      FROM payments GROUP BY contract_id
    )
"""

# Requires pay_agg(contract_id, pay_net); canceled claims do not consume payments.
CLAIM_CALC_CTE = """
    claim_calc AS (
      SELECT cl.id, cl.contract_id, cl.claim_category, cl.occurred_on,
             cl.claim_total_amount, cl.due_at, cl.status, cl.payment_method_json,
        CASE WHEN cl.status='canceled' THEN 0
             ELSE GREATEST(0, LEAST(cl.claim_total_amount,
                  COALESCE(pa.pay_net,0)
                  - COALESCE(SUM(CASE WHEN cl.status<>'canceled' THEN cl.claim_total_amount ELSE 0 END)
                      OVER (PARTITION BY cl.contract_id
                            ORDER BY cl.occurred_on ASC, cl.created_at ASC, cl.id ASC
                            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)))
        END AS paid_amount
      FROM claims cl
      LEFT JOIN pay_agg pa ON pa.contract_id = cl.contract_id
    )
"""
