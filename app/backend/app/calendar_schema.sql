CREATE TABLE IF NOT EXISTS communication_calendar_events (
    communication_id UUID PRIMARY KEY REFERENCES communications(id) ON DELETE CASCADE,
    request_id UUID NOT NULL UNIQUE,
    requested_by UUID NOT NULL REFERENCES users(id),
    request_hash VARCHAR(64) NOT NULL,
    group_id UUID NOT NULL,
    calendar_name TEXT NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    graph_payload JSONB NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'pending',
    event_id TEXT,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_communication_calendar_time CHECK (ends_at > starts_at),
    CONSTRAINT ck_communication_calendar_status CHECK (status IN ('pending', 'created', 'failed')),
    CONSTRAINT ck_communication_calendar_event CHECK ((status = 'created') = (event_id IS NOT NULL))
);
