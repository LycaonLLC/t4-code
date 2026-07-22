CREATE TABLE IF NOT EXISTS t4_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE IF NOT EXISTS t4_commands (
 command_id text PRIMARY KEY, principal_id text NOT NULL, operation text NOT NULL, target_scope text NOT NULL,
 idempotency_key text NOT NULL, fingerprint text NOT NULL, lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('accepted','completed','failed')),
 response_status integer NOT NULL, response_body jsonb, error_body jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (principal_id, operation, target_scope, idempotency_key)
);
CREATE TABLE IF NOT EXISTS t4_workspace_intents (
 workspace_id text PRIMARY KEY, principal_id text NOT NULL, name text NOT NULL, labels jsonb NOT NULL DEFAULT '{}'::jsonb,
 state text NOT NULL CHECK (state IN ('accepted','provisioning','ready','deleting','deleted','failed','unavailable','indeterminate')),
 revision bigint NOT NULL CHECK (revision > 0), generation bigint NOT NULL CHECK (generation > 0), deletion_requested boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS t4_workspace_intents_principal_page ON t4_workspace_intents (principal_id, workspace_id);
CREATE TABLE IF NOT EXISTS t4_session_intents (
 session_id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES t4_workspace_intents(workspace_id), principal_id text NOT NULL,
 title text NOT NULL, labels jsonb NOT NULL DEFAULT '{}'::jsonb,
 state text NOT NULL CHECK (state IN ('accepted','provisioning','ready','cancelling','cancelled','failed','unavailable','indeterminate')),
 revision bigint NOT NULL CHECK (revision > 0), generation bigint NOT NULL CHECK (generation > 0), cancellation_requested boolean NOT NULL DEFAULT false,
 deletion_requested boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS t4_session_intents_principal_workspace_page ON t4_session_intents (principal_id, workspace_id, session_id);
CREATE TABLE IF NOT EXISTS t4_events (
 sequence bigserial PRIMARY KEY, principal_id text NOT NULL, session_id text, event_type text NOT NULL CHECK (event_type IN ('session','command')),
 payload jsonb NOT NULL, owner_epoch bigint NOT NULL DEFAULT 0 CHECK (owner_epoch >= 0), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS t4_events_session_sequence ON t4_events (principal_id, session_id, sequence);
CREATE TABLE IF NOT EXISTS t4_event_retention (
 principal_id text NOT NULL, session_id text NOT NULL, first_retained_sequence bigint NOT NULL CHECK (first_retained_sequence >= 0),
 latest_sequence bigint NOT NULL CHECK (latest_sequence >= 0), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (principal_id, session_id)
);
CREATE TABLE IF NOT EXISTS t4_snapshot_entries (
 principal_id text NOT NULL, session_id text NOT NULL, entry_sequence bigint NOT NULL CHECK (entry_sequence >= 0),
 kind text NOT NULL CHECK (kind IN ('input','output','status')), text_value text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (principal_id, session_id, entry_sequence)
);
CREATE TABLE IF NOT EXISTS t4_owner_leases (
 lease_name text PRIMARY KEY, owner_id text NOT NULL, epoch bigint NOT NULL CHECK (epoch > 0), expires_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS t4_outbox (
 outbox_id bigserial PRIMARY KEY, command_id text NOT NULL UNIQUE REFERENCES t4_commands(command_id), principal_id text NOT NULL,
 idempotency_key text NOT NULL, mutation_kind text NOT NULL CHECK (mutation_kind IN ('workspace.create','workspace.patch','workspace.delete','session.create','session.patch','session.cancel','session.delete','command.submit')),
 target_id text NOT NULL, target_revision bigint NOT NULL CHECK (target_revision > 0), mutation jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','applied','skipped','failed')), owner_id text, owner_epoch bigint,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(), claimed_at timestamptz,
 terminal_result jsonb, last_error text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS t4_outbox_ready ON t4_outbox (state, next_attempt_at, outbox_id);
INSERT INTO t4_schema_migrations(version) VALUES (1) ON CONFLICT (version) DO NOTHING;
