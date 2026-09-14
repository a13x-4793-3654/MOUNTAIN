from typing import Literal


def contractor_person_sql(
    contract_id_sql: Literal["c.id", "c2.id", "CAST(:id AS uuid)"],
) -> str:
    """Select the earliest person explicitly linked as contractor, without fallback."""
    return f"""
        SELECT p.id AS person_id, p.full_name
        FROM contract_person_links l
        JOIN persons p ON p.id = l.person_id
        WHERE l.contract_id = {contract_id_sql}
          AND l.link_category = 'contractor'
        ORDER BY l.id
        LIMIT 1
    """
