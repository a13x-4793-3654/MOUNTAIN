SELECT pg_advisory_xact_lock(918273650);

CREATE TABLE IF NOT EXISTS app_data_migrations (
    migration_key TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

WITH first_run AS (
    INSERT INTO app_data_migrations (migration_key)
    VALUES ('company-category-master-v1')
    ON CONFLICT (migration_key) DO NOTHING
    RETURNING migration_key
)
INSERT INTO code_masters (category, code, label, sort_order)
SELECT 'company_category', defaults.code, defaults.label, defaults.sort_order
FROM (VALUES
    ('lawyer', '弁護士・法律事務所', 1),
    ('servicer', '債権回収業者（サービサー）', 2)
) AS defaults(code, label, sort_order)
WHERE EXISTS (SELECT 1 FROM first_run)
ON CONFLICT (category, code) DO NOTHING;
