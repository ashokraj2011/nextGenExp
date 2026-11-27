/**
 * Production PostgreSQL DDL for @sfield/store-postgres (`deployment: "service"`).
 *
 * Uses JSONB document columns with indexed scalar projections so schema evolution stays
 * backwards-compatible across rolling multi-replica upgrades, and enforces single-owner
 * distributed lease claims via atomic conditional UPDATEs (`expires_at <= $now`).
 */
export const POSTGRES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sfield_runs (
  run_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  conversation_id TEXT,
  idempotency_scope TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  wakeup_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  doc JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sfield_runs_tenant ON sfield_runs (namespace, tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sfield_runs_conv ON sfield_runs (namespace, conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sfield_runs_wakeup ON sfield_runs (namespace, wakeup_at) WHERE wakeup_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS sfield_leases (
  scope_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS sfield_conversations (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  active_run_id TEXT,
  doc JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS sfield_messages (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  msg_index INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  doc JSONB NOT NULL,
  UNIQUE (conversation_id, msg_index)
);

CREATE TABLE IF NOT EXISTS sfield_calls (
  call_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  run_id TEXT NOT NULL,
  doc JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sfield_calls_run ON sfield_calls (namespace, run_id);

CREATE TABLE IF NOT EXISTS sfield_approvals (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  doc JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS sfield_inputs (
  request_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  doc JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS sfield_checkpoints (
  run_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  doc JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS sfield_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  namespace TEXT NOT NULL,
  doc JSONB NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS sfield_audit (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  run_id TEXT,
  type TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  doc JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sfield_audit_run ON sfield_audit (namespace, run_id, at DESC);

CREATE TABLE IF NOT EXISTS sfield_reservations (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  state TEXT NOT NULL,
  doc JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS sfield_model_attempts (
  attempt_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  run_id TEXT NOT NULL,
  doc JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS sfield_context_explanations (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  doc JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS sfield_lock_approvals (
  digest TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  suite TEXT,
  decided_at TIMESTAMPTZ NOT NULL,
  doc JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS sfield_eval_reports (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  suite TEXT NOT NULL,
  candidate_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  doc JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS sfield_memory (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  doc JSONB NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_sfield_memory_scope ON sfield_memory (namespace, tenant_id, scope_key, kind, status);

CREATE TABLE IF NOT EXISTS sfield_memory_generations (
  namespace TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (namespace, tenant_id, scope_key)
);

CREATE TABLE IF NOT EXISTS sfield_memory_outbox (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  doc JSONB NOT NULL
);
`;
