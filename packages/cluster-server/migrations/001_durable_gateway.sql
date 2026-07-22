CREATE TABLE IF NOT EXISTS t4_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE IF NOT EXISTS t4_commands (
 command_id text PRIMARY KEY, principal_id text NOT NULL, operation text NOT NULL, target_scope text NOT NULL,
 idempotency_key text NOT NULL, fingerprint text NOT NULL, lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('accepted','projected','dispatching','running','succeeded','failed','cancelling','cancelled','rejected','unavailable','indeterminate')),
 response_status integer NOT NULL, response_body jsonb, error_body jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (principal_id, operation, target_scope, idempotency_key)
);
ALTER TABLE t4_commands DROP CONSTRAINT IF EXISTS t4_commands_lifecycle_state_check;
UPDATE t4_commands SET lifecycle_state = 'projected', updated_at = clock_timestamp() WHERE lifecycle_state = 'completed';
ALTER TABLE t4_commands ADD CONSTRAINT t4_commands_lifecycle_state_check CHECK (lifecycle_state IN ('accepted','projected','dispatching','running','succeeded','failed','cancelling','cancelled','rejected','unavailable','indeterminate')) NOT VALID;
ALTER TABLE t4_commands VALIDATE CONSTRAINT t4_commands_lifecycle_state_check;
CREATE TABLE IF NOT EXISTS t4_workspace_intents (
 workspace_id text PRIMARY KEY, principal_id text NOT NULL, name text NOT NULL, labels jsonb NOT NULL DEFAULT '{}'::jsonb,
 state text NOT NULL CHECK (state IN ('accepted','provisioning','ready','deleting','deleted','failed','unavailable','indeterminate')),
 revision bigint NOT NULL CHECK (revision > 0), generation bigint NOT NULL CHECK (generation > 0), deletion_requested boolean NOT NULL DEFAULT false,
 kube_uid text, kube_resource_version text, kube_generation bigint, kube_observed_generation bigint,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE t4_workspace_intents ADD COLUMN IF NOT EXISTS kube_uid text;
ALTER TABLE t4_workspace_intents ADD COLUMN IF NOT EXISTS kube_resource_version text;
ALTER TABLE t4_workspace_intents ADD COLUMN IF NOT EXISTS kube_generation bigint;
ALTER TABLE t4_workspace_intents ADD COLUMN IF NOT EXISTS kube_observed_generation bigint;
UPDATE t4_workspace_intents SET kube_uid = NULL, kube_resource_version = NULL, kube_generation = NULL, kube_observed_generation = NULL
 WHERE NOT ((kube_uid IS NULL AND kube_resource_version IS NULL AND kube_generation IS NULL AND kube_observed_generation IS NULL)
  OR (kube_uid IS NOT NULL AND octet_length(kube_uid) BETWEEN 1 AND 256 AND kube_resource_version IS NOT NULL AND octet_length(kube_resource_version) BETWEEN 1 AND 256 AND kube_generation IS NOT NULL AND kube_generation > 0 AND kube_observed_generation IS NOT NULL AND kube_observed_generation >= 0));
ALTER TABLE t4_workspace_intents DROP CONSTRAINT IF EXISTS t4_workspace_intents_kube_identity_check;
ALTER TABLE t4_workspace_intents ADD CONSTRAINT t4_workspace_intents_kube_identity_check CHECK ((kube_uid IS NULL AND kube_resource_version IS NULL AND kube_generation IS NULL AND kube_observed_generation IS NULL) OR (kube_uid IS NOT NULL AND octet_length(kube_uid) BETWEEN 1 AND 256 AND kube_resource_version IS NOT NULL AND octet_length(kube_resource_version) BETWEEN 1 AND 256 AND kube_generation IS NOT NULL AND kube_generation > 0 AND kube_observed_generation IS NOT NULL AND kube_observed_generation >= 0)) NOT VALID;
ALTER TABLE t4_workspace_intents VALIDATE CONSTRAINT t4_workspace_intents_kube_identity_check;
CREATE INDEX IF NOT EXISTS t4_workspace_intents_principal_page ON t4_workspace_intents (principal_id, workspace_id);
CREATE TABLE IF NOT EXISTS t4_session_intents (
 session_id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES t4_workspace_intents(workspace_id), principal_id text NOT NULL,
 title text NOT NULL, labels jsonb NOT NULL DEFAULT '{}'::jsonb,
 state text NOT NULL CHECK (state IN ('accepted','provisioning','ready','cancelling','cancelled','failed','unavailable','indeterminate')),
 revision bigint NOT NULL CHECK (revision > 0), generation bigint NOT NULL CHECK (generation > 0), cancellation_requested boolean NOT NULL DEFAULT false,
 deletion_requested boolean NOT NULL DEFAULT false, kube_uid text, kube_resource_version text, kube_generation bigint, kube_observed_generation bigint,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE t4_session_intents ADD COLUMN IF NOT EXISTS kube_uid text;
ALTER TABLE t4_session_intents ADD COLUMN IF NOT EXISTS kube_resource_version text;
ALTER TABLE t4_session_intents ADD COLUMN IF NOT EXISTS kube_generation bigint;
ALTER TABLE t4_session_intents ADD COLUMN IF NOT EXISTS kube_observed_generation bigint;
UPDATE t4_session_intents SET kube_uid = NULL, kube_resource_version = NULL, kube_generation = NULL, kube_observed_generation = NULL
 WHERE NOT ((kube_uid IS NULL AND kube_resource_version IS NULL AND kube_generation IS NULL AND kube_observed_generation IS NULL)
  OR (kube_uid IS NOT NULL AND octet_length(kube_uid) BETWEEN 1 AND 256 AND kube_resource_version IS NOT NULL AND octet_length(kube_resource_version) BETWEEN 1 AND 256 AND kube_generation IS NOT NULL AND kube_generation > 0 AND kube_observed_generation IS NOT NULL AND kube_observed_generation >= 0));
ALTER TABLE t4_session_intents DROP CONSTRAINT IF EXISTS t4_session_intents_kube_identity_check;
ALTER TABLE t4_session_intents ADD CONSTRAINT t4_session_intents_kube_identity_check CHECK ((kube_uid IS NULL AND kube_resource_version IS NULL AND kube_generation IS NULL AND kube_observed_generation IS NULL) OR (kube_uid IS NOT NULL AND octet_length(kube_uid) BETWEEN 1 AND 256 AND kube_resource_version IS NOT NULL AND octet_length(kube_resource_version) BETWEEN 1 AND 256 AND kube_generation IS NOT NULL AND kube_generation > 0 AND kube_observed_generation IS NOT NULL AND kube_observed_generation >= 0)) NOT VALID;
ALTER TABLE t4_session_intents VALIDATE CONSTRAINT t4_session_intents_kube_identity_check;
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
UPDATE t4_outbox SET state = 'pending', owner_id = NULL, owner_epoch = NULL, claimed_at = NULL, next_attempt_at = clock_timestamp(), updated_at = clock_timestamp() WHERE state = 'claimed' AND (owner_id IS NULL OR btrim(owner_id) = '' OR owner_epoch IS NULL OR owner_epoch <= 0 OR claimed_at IS NULL);
UPDATE t4_outbox SET owner_id = NULL, owner_epoch = NULL, claimed_at = NULL, updated_at = clock_timestamp() WHERE state <> 'claimed' AND (owner_id IS NOT NULL OR owner_epoch IS NOT NULL OR claimed_at IS NOT NULL);
ALTER TABLE t4_outbox DROP CONSTRAINT IF EXISTS t4_outbox_owner_tuple_check;
ALTER TABLE t4_outbox DROP CONSTRAINT IF EXISTS t4_outbox_claimed_identity_check;
ALTER TABLE t4_outbox DROP CONSTRAINT IF EXISTS t4_outbox_nonclaimed_identity_check;
ALTER TABLE t4_outbox ADD CONSTRAINT t4_outbox_owner_tuple_check CHECK ((owner_id IS NULL AND owner_epoch IS NULL) OR (owner_id IS NOT NULL AND btrim(owner_id) <> '' AND owner_epoch IS NOT NULL AND owner_epoch > 0)) NOT VALID;
ALTER TABLE t4_outbox ADD CONSTRAINT t4_outbox_claimed_identity_check CHECK (state <> 'claimed' OR (owner_id IS NOT NULL AND btrim(owner_id) <> '' AND owner_epoch IS NOT NULL AND owner_epoch > 0 AND claimed_at IS NOT NULL)) NOT VALID;
ALTER TABLE t4_outbox ADD CONSTRAINT t4_outbox_nonclaimed_identity_check CHECK (state = 'claimed' OR (owner_id IS NULL AND owner_epoch IS NULL AND claimed_at IS NULL)) NOT VALID;
ALTER TABLE t4_outbox VALIDATE CONSTRAINT t4_outbox_owner_tuple_check;
ALTER TABLE t4_outbox VALIDATE CONSTRAINT t4_outbox_claimed_identity_check;
ALTER TABLE t4_outbox VALIDATE CONSTRAINT t4_outbox_nonclaimed_identity_check;
CREATE INDEX IF NOT EXISTS t4_outbox_ready ON t4_outbox (state, next_attempt_at, outbox_id);
CREATE TABLE IF NOT EXISTS t4_kubernetes_status_cursors (
 collection text PRIMARY KEY CHECK (collection IN ('t4workspaces','t4sessions')), resource_version text NOT NULL CHECK (octet_length(resource_version) BETWEEN 1 AND 256),
 owner_epoch bigint NOT NULL CHECK (owner_epoch > 0), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS t4_stale_create_cleanups (
 cleanup_id bigserial PRIMARY KEY, outbox_id bigint NOT NULL REFERENCES t4_outbox(outbox_id),
 resource_type text NOT NULL CHECK (resource_type IN ('t4workspaces','t4sessions')), target_id text NOT NULL,
 uid text NOT NULL CHECK (octet_length(uid) BETWEEN 1 AND 256), resource_version text NOT NULL CHECK (octet_length(resource_version) BETWEEN 1 AND 256),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','applied')), owner_id text, owner_epoch bigint,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(), claimed_at timestamptz,
 last_error text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (outbox_id, uid)
);
UPDATE t4_stale_create_cleanups cleanup SET state = 'applied', owner_id = NULL, owner_epoch = NULL, claimed_at = NULL, last_error = NULL, updated_at = clock_timestamp()
 WHERE cleanup.state <> 'applied' AND EXISTS (SELECT 1 FROM t4_outbox item WHERE item.outbox_id = cleanup.outbox_id AND item.state = 'applied');
UPDATE t4_stale_create_cleanups SET state = 'pending', owner_id = NULL, owner_epoch = NULL, claimed_at = NULL, next_attempt_at = clock_timestamp(), updated_at = clock_timestamp() WHERE state = 'claimed' AND (owner_id IS NULL OR btrim(owner_id) = '' OR owner_epoch IS NULL OR owner_epoch <= 0 OR claimed_at IS NULL);
UPDATE t4_stale_create_cleanups SET owner_id = NULL, owner_epoch = NULL, claimed_at = NULL, updated_at = clock_timestamp() WHERE state <> 'claimed' AND (owner_id IS NOT NULL OR owner_epoch IS NOT NULL OR claimed_at IS NOT NULL);
ALTER TABLE t4_stale_create_cleanups DROP CONSTRAINT IF EXISTS t4_stale_create_cleanups_claim_check;
ALTER TABLE t4_stale_create_cleanups DROP CONSTRAINT IF EXISTS t4_stale_create_cleanups_nonclaimed_check;
ALTER TABLE t4_stale_create_cleanups ADD CONSTRAINT t4_stale_create_cleanups_claim_check CHECK (state <> 'claimed' OR (owner_id IS NOT NULL AND btrim(owner_id) <> '' AND owner_epoch IS NOT NULL AND owner_epoch > 0 AND claimed_at IS NOT NULL)) NOT VALID;
ALTER TABLE t4_stale_create_cleanups ADD CONSTRAINT t4_stale_create_cleanups_nonclaimed_check CHECK (state = 'claimed' OR (owner_id IS NULL AND owner_epoch IS NULL AND claimed_at IS NULL)) NOT VALID;
ALTER TABLE t4_stale_create_cleanups VALIDATE CONSTRAINT t4_stale_create_cleanups_claim_check;
ALTER TABLE t4_stale_create_cleanups VALIDATE CONSTRAINT t4_stale_create_cleanups_nonclaimed_check;
CREATE INDEX IF NOT EXISTS t4_stale_create_cleanups_ready ON t4_stale_create_cleanups (state, next_attempt_at, cleanup_id);
INSERT INTO t4_schema_migrations(version) VALUES (1) ON CONFLICT (version) DO NOTHING;
