CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_contacts (
    tenant_id UUID NOT NULL,
    whatsapp_id TEXT NOT NULL,
    uaepass_subject TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, whatsapp_id),
    UNIQUE (tenant_id, uaepass_subject)
);

CREATE TABLE IF NOT EXISTS whatsapp_channels (
    phone_number_id TEXT PRIMARY KEY,
    tenant_id UUID NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS inbound_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    whatsapp_message_id TEXT NOT NULL UNIQUE,
    whatsapp_id TEXT NOT NULL,
    message_type TEXT NOT NULL,
    body TEXT,
    provider_timestamp TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'INTAKE_PENDING_IDENTITY'
        CHECK (status IN ('INTAKE_PENDING_IDENTITY', 'IDENTITY_VERIFIED', 'TRIAGE_PENDING', 'CONVERTED')),
    UNIQUE (id, tenant_id)
);

CREATE TABLE IF NOT EXISTS tenant_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    whatsapp_id TEXT NOT NULL,
    uaepass_subject TEXT NOT NULL,
    issuer TEXT NOT NULL,
    assurance_level TEXT,
    authenticated_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, uaepass_subject, authenticated_at),
    UNIQUE (id, tenant_id),
    FOREIGN KEY (tenant_id, whatsapp_id)
        REFERENCES tenant_contacts (tenant_id, whatsapp_id),
    CHECK (expires_at > authenticated_at)
);

CREATE TABLE IF NOT EXISTS maintenance_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    inbound_message_id UUID NOT NULL,
    verification_id UUID NOT NULL,
    idempotency_key TEXT NOT NULL,
    property_reference TEXT NOT NULL,
    category TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PMS_SYNC_PENDING'
        CHECK (status IN (
            'PMS_SYNC_PENDING', 'PMS_SYNCED', 'PMS_SYNC_RETRY',
            'PMS_SYNC_REVIEW', 'DISPATCHED', 'COMPLETED'
        )),
    pms_work_order_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, idempotency_key),
    FOREIGN KEY (verification_id, tenant_id)
        REFERENCES tenant_verifications (id, tenant_id),
    FOREIGN KEY (inbound_message_id, tenant_id)
        REFERENCES inbound_messages (id, tenant_id)
);

CREATE TABLE IF NOT EXISTS outbox_events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    causation_id TEXT,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    published_at TIMESTAMPTZ,
    dead_lettered_at TIMESTAMPTZ,
    last_error TEXT
);

CREATE INDEX IF NOT EXISTS outbox_events_ready_idx
    ON outbox_events (available_at, created_at)
    WHERE published_at IS NULL AND dead_lettered_at IS NULL;

CREATE INDEX IF NOT EXISTS inbound_messages_tenant_time_idx
    ON inbound_messages (tenant_id, received_at DESC);

CREATE INDEX IF NOT EXISTS maintenance_requests_tenant_time_idx
    ON maintenance_requests (tenant_id, created_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('001_initial')
ON CONFLICT (version) DO NOTHING;
