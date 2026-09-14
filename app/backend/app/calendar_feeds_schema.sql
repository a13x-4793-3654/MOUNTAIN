-- Private, display-only calendar subscriptions. Never synchronized to Outlook.
CREATE TABLE IF NOT EXISTS calendar_feeds (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    kind            VARCHAR(4) NOT NULL CHECK (kind IN ('url', 'file')),
    color           VARCHAR(7) NOT NULL DEFAULT '#2563eb' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
    visible         BOOLEAN NOT NULL DEFAULT TRUE,
    filename        VARCHAR(255),
    url_enc         BYTEA,
    content_enc     BYTEA,
    last_fetched_at TIMESTAMPTZ,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (kind = 'url' AND url_enc IS NOT NULL AND content_enc IS NULL AND filename IS NULL)
        OR (kind = 'file' AND content_enc IS NOT NULL AND url_enc IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_calendar_feeds_owner ON calendar_feeds (owner_id, created_at);

-- One encrypted source snapshot and one bounded expanded range per source.
CREATE TABLE IF NOT EXISTS calendar_feed_snapshots (
    feed_id      UUID PRIMARY KEY REFERENCES calendar_feeds(id) ON DELETE CASCADE,
    version      UUID NOT NULL,
    content_enc  BYTEA NOT NULL,
    result_enc   BYTEA NOT NULL,
    range_start  TIMESTAMPTZ NOT NULL,
    range_end    TIMESTAMPTZ NOT NULL,
    saved_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (range_end > range_start AND range_end - range_start <= INTERVAL '62 days')
);

CREATE TABLE IF NOT EXISTS calendar_preferences (
    owner_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    show_personal BOOLEAN NOT NULL DEFAULT TRUE,
    show_group    BOOLEAN NOT NULL DEFAULT TRUE,
    show_tentative BOOLEAN NOT NULL DEFAULT FALSE,
    view          VARCHAR(5) NOT NULL DEFAULT 'month' CHECK (view IN ('day', 'week', 'month')),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE calendar_preferences ADD COLUMN IF NOT EXISTS show_tentative BOOLEAN NOT NULL DEFAULT FALSE;
