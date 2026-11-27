/**
 * PostgreSQL ExecutionPersistence for @sfield/core (`deployment: "service"`).
 *
 * Driver-agnostic: works with `pg.Pool` (via `createPgPoolAdapter`), `postgres.js`,
 * Neon, or Supabase, AND ships `createServiceMemoryPersistence()` for fast multi-replica
 * `deployment: "service"` testing without requiring a local Postgres daemon.
 */
import {
  EphemeralPersistence,
  SFieldError,
  newId,
  nowIso,
  type AcceptRequestInput,
  type AcceptRequestResult,
  type Actor,
  type ApprovalRecord,
  type ArtifactStore,
  type AuditRecord,
  type BudgetScopeRequest,
  type CallRecord,
  type Checkpoint,
  type CommitResultInput,
  type ContextExplanation,
  type ConversationRecord,
  type EvalReportRecord,
  type ExecutionPersistence,
  type InputRequestRecord,
  type JsonObject,
  type JsonValue,
  type LockApprovalRecord,
  type MemoryRepository,
  type MessageRecord,
  type ModelAttemptRecord,
  type OwnershipClaim,
  type ReservationRecord,
  type ReservationState,
  type RunEvent,
  type RunRecord,
  type RunState,
} from "@sfield/core";
import { POSTGRES_SCHEMA_SQL } from "./schema.js";

export { POSTGRES_SCHEMA_SQL };

export interface PostgresQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount?: number | null;
}

/** Minimal driver-agnostic Postgres client contract (matches `pg.Pool` / `pg.Client`). */
export interface PostgresSqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<PostgresQueryResult<T>>;
  close?(): Promise<void>;
}

/** Adapts a standard `node-postgres` (`pg.Pool` or `pg.Client`) instance to `PostgresSqlClient`. */
export function createPgPoolAdapter(pool: {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
  end?: () => Promise<void>;
}): PostgresSqlClient {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<PostgresQueryResult<T>> {
      const res = await pool.query(sql, params ? [...params] : undefined);
      return { rows: res.rows as T[], rowCount: res.rowCount };
    },
    async close() {
      await pool.end?.();
    },
  };
}

export interface PostgresPersistenceOptions {
  /** Driver-agnostic SQL client (e.g., `createPgPoolAdapter(pool)`). */
  client: PostgresSqlClient;
  /** Whether to execute `POSTGRES_SCHEMA_SQL` automatically during `init()`. Defaults to `true`. */
  autoMigrate?: boolean;
  memory?: MemoryRepository;
  artifacts?: ArtifactStore;
}

/**
 * Multi-replica PostgreSQL persistence backend (`deployment: "service"`).
 * Uses parameterized `$1..$N` SQL and atomic lease ownership checks.
 */
export class PostgresPersistence implements ExecutionPersistence {
  readonly mode = "service" as const;
  readonly memory?: MemoryRepository;
  readonly artifacts?: ArtifactStore;
  private namespace = "default";
  private readonly autoMigrate: boolean;
  private readonly sql: PostgresSqlClient;

  constructor(options: PostgresPersistenceOptions) {
    this.sql = options.client;
    this.autoMigrate = options.autoMigrate ?? true;
    this.memory = options.memory;
    this.artifacts = options.artifacts;
  }

  async init(ctx: { namespace: string; ownerId: string }): Promise<void> {
    this.namespace = ctx.namespace || "default";
    if (this.autoMigrate) {
      await this.sql.query(POSTGRES_SCHEMA_SQL);
    }
  }

  async close(): Promise<void> {
    await this.sql.close?.();
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.sql.query("SELECT 1 AS ok");
      return { ok: true, detail: "postgres connected" };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : "postgres unavailable" };
    }
  }

  async acceptRequest(input: AcceptRequestInput): Promise<AcceptRequestResult> {
    const existing = await this.sql.query<{ doc: RunRecord }>(
      "SELECT doc FROM sfield_runs WHERE namespace = $1 AND idempotency_scope = $2 LIMIT 1",
      [this.namespace, input.run.idempotencyScope],
    );
    if (existing.rows[0]) {
      return { run: existing.rows[0].doc, created: false };
    }
    const now = input.run.createdAt ?? nowIso();
    const run: RunRecord = { ...input.run, epoch: 0, lastEventSeq: 0, createdAt: now, updatedAt: now };
    await this.sql.query(
      `INSERT INTO sfield_runs (run_id, namespace, tenant_id, conversation_id, idempotency_scope, state, wakeup_at, updated_at, doc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [run.runId, this.namespace, run.tenantId, run.conversationId ?? null, run.idempotencyScope, run.state, run.wakeup?.at ?? null, now, JSON.stringify(run)],
    );
    if (input.message) {
      await this.appendMessage(input.message);
    }
    return { run, created: true };
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const res = await this.sql.query<{ doc: RunRecord }>(
      "SELECT doc FROM sfield_runs WHERE namespace = $1 AND run_id = $2",
      [this.namespace, runId],
    );
    return res.rows[0]?.doc ?? null;
  }

  async listRuns(filter: { tenantId?: string; conversationId?: string; state?: RunState[]; limit?: number }): Promise<RunRecord[]> {
    const clauses = ["namespace = $1"];
    const params: unknown[] = [this.namespace];
    if (filter.tenantId) { params.push(filter.tenantId); clauses.push(`tenant_id = $${params.length}`); }
    if (filter.conversationId) { params.push(filter.conversationId); clauses.push(`conversation_id = $${params.length}`); }
    if (filter.state?.length) { params.push(filter.state); clauses.push(`state = ANY($${params.length})`); }
    params.push(filter.limit ?? 100);
    const res = await this.sql.query<{ doc: RunRecord }>(
      `SELECT doc FROM sfield_runs WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map((r) => r.doc);
  }

  async updateRun(runId: string, epoch: number, patch: Partial<RunRecord>): Promise<RunRecord> {
    const cur = await this.getRun(runId);
    if (!cur) throw new SFieldError("NOT_FOUND", `run ${runId} not found`);
    const lease = await this.currentOwner(cur.scopeId);
    if (lease && lease.epoch !== epoch) throw new SFieldError("OWNERSHIP_LOST", `epoch ${epoch} no longer owns ${runId}`);
    const next: RunRecord = { ...cur, ...patch, updatedAt: nowIso() };
    await this.sql.query(
      "UPDATE sfield_runs SET state = $1, wakeup_at = $2, updated_at = $3, doc = $4::jsonb WHERE namespace = $5 AND run_id = $6",
      [next.state, next.wakeup?.at ?? null, next.updatedAt, JSON.stringify(next), this.namespace, runId],
    );
    return next;
  }

  async listWakeups(): Promise<RunRecord[]> {
    const res = await this.sql.query<{ doc: RunRecord }>(
      "SELECT doc FROM sfield_runs WHERE namespace = $1 AND wakeup_at IS NOT NULL ORDER BY wakeup_at ASC LIMIT 100",
      [this.namespace],
    );
    return res.rows.map((r) => r.doc);
  }

  async requestCancel(runId: string, reason?: string): Promise<void> {
    const cur = await this.getRun(runId);
    if (!cur) return;
    const next: RunRecord = { ...cur, cancelRequested: { at: nowIso(), ...(reason ? { reason } : {}) }, updatedAt: nowIso() };
    await this.sql.query(
      "UPDATE sfield_runs SET updated_at = $1, doc = $2::jsonb WHERE namespace = $3 AND run_id = $4",
      [next.updatedAt, JSON.stringify(next), this.namespace, runId],
    );
  }

  async claim(scopeId: string, ownerId: string, leaseMs: number): Promise<OwnershipClaim | null> {
    const now = nowIso();
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    const res = await this.sql.query<{ epoch: number }>(
      `INSERT INTO sfield_leases (scope_id, namespace, owner_id, epoch, expires_at)
       VALUES ($1, $2, $3, 1, $4::timestamptz)
       ON CONFLICT (scope_id) DO UPDATE
         SET owner_id = EXCLUDED.owner_id, epoch = sfield_leases.epoch + 1, expires_at = EXCLUDED.expires_at
         WHERE sfield_leases.expires_at <= $5::timestamptz OR sfield_leases.owner_id = $3
       RETURNING epoch`,
      [scopeId, this.namespace, ownerId, expiresAt, now],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { scopeId, ownerId, epoch: row.epoch, expiresAt };
  }

  async renew(claim: OwnershipClaim, leaseMs: number): Promise<OwnershipClaim | null> {
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    const res = await this.sql.query<{ epoch: number }>(
      `UPDATE sfield_leases SET expires_at = $1::timestamptz
       WHERE namespace = $2 AND scope_id = $3 AND owner_id = $4 AND epoch = $5
       RETURNING epoch`,
      [expiresAt, this.namespace, claim.scopeId, claim.ownerId, claim.epoch],
    );
    return res.rows[0] ? { ...claim, expiresAt } : null;
  }

  async release(claim: OwnershipClaim): Promise<void> {
    await this.sql.query(
      "DELETE FROM sfield_leases WHERE namespace = $1 AND scope_id = $2 AND owner_id = $3 AND epoch = $4",
      [this.namespace, claim.scopeId, claim.ownerId, claim.epoch],
    );
  }

  async currentOwner(scopeId: string): Promise<OwnershipClaim | null> {
    const res = await this.sql.query<{ scope_id: string; owner_id: string; epoch: number; expires_at: string }>(
      "SELECT scope_id, owner_id, epoch, expires_at FROM sfield_leases WHERE namespace = $1 AND scope_id = $2 AND expires_at > NOW()",
      [this.namespace, scopeId],
    );
    const r = res.rows[0];
    return r ? { scopeId: r.scope_id, ownerId: r.owner_id, epoch: r.epoch, expiresAt: String(r.expires_at) } : null;
  }

  async createConversation(rec: ConversationRecord): Promise<ConversationRecord> {
    await this.sql.query(
      "INSERT INTO sfield_conversations (id, namespace, tenant_id, active_run_id, doc) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [rec.id, this.namespace, rec.tenantId, rec.activeRunId ?? null, JSON.stringify(rec)],
    );
    return rec;
  }

  async getConversation(id: string): Promise<ConversationRecord | null> {
    const res = await this.sql.query<{ doc: ConversationRecord }>(
      "SELECT doc FROM sfield_conversations WHERE namespace = $1 AND id = $2",
      [this.namespace, id],
    );
    return res.rows[0]?.doc ?? null;
  }

  async setActiveRun(conversationId: string, runId: string | null, expectedActive?: string | null): Promise<boolean> {
    const conv = await this.getConversation(conversationId);
    if (!conv) return false;
    if (expectedActive !== undefined && (conv.activeRunId ?? null) !== expectedActive) return false;
    const next: ConversationRecord = { ...conv, activeRunId: runId ?? undefined, updatedAt: nowIso() };
    await this.sql.query(
      "UPDATE sfield_conversations SET active_run_id = $1, doc = $2::jsonb WHERE namespace = $3 AND id = $4",
      [runId, JSON.stringify(next), this.namespace, conversationId],
    );
    return true;
  }

  async appendMessage(msg: Omit<MessageRecord, "index" | "id"> & { id?: string }): Promise<MessageRecord> {
    const id = msg.id ?? newId("msg");
    const countRes = await this.sql.query<{ max_idx: number | null }>(
      "SELECT MAX(msg_index) AS max_idx FROM sfield_messages WHERE namespace = $1 AND conversation_id = $2",
      [this.namespace, msg.conversationId],
    );
    const index = (countRes.rows[0]?.max_idx ?? -1) + 1;
    const rec: MessageRecord = { ...msg, id, index };
    await this.sql.query(
      `INSERT INTO sfield_messages (id, namespace, conversation_id, msg_index, expires_at, doc)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [rec.id, this.namespace, rec.conversationId, rec.index, rec.expiresAt, JSON.stringify(rec)],
    );
    return rec;
  }

  async listMessages(conversationId: string, opts: { limit?: number; before?: number; includeExpired?: boolean }): Promise<MessageRecord[]> {
    const clauses = ["namespace = $1", "conversation_id = $2"];
    const params: unknown[] = [this.namespace, conversationId];
    if (!opts.includeExpired) clauses.push("expires_at > NOW()");
    if (opts.before !== undefined) { params.push(opts.before); clauses.push(`msg_index < $${params.length}`); }
    params.push(opts.limit ?? 200);
    const res = await this.sql.query<{ doc: MessageRecord }>(
      `SELECT doc FROM sfield_messages WHERE ${clauses.join(" AND ")} ORDER BY msg_index ASC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map((r) => r.doc);
  }

  async deleteConversation(id: string): Promise<{ messages: number }> {
    const delMsgs = await this.sql.query(
      "DELETE FROM sfield_messages WHERE namespace = $1 AND conversation_id = $2",
      [this.namespace, id],
    );
    await this.sql.query("DELETE FROM sfield_conversations WHERE namespace = $1 AND id = $2", [this.namespace, id]);
    return { messages: delMsgs.rowCount ?? 0 };
  }

  async prepareBatch(_runId: string, _epoch: number, calls: CallRecord[]): Promise<void> {
    for (const c of calls) {
      await this.sql.query(
        "INSERT INTO sfield_calls (call_id, namespace, run_id, doc) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (call_id) DO UPDATE SET doc = EXCLUDED.doc",
        [c.callId, this.namespace, c.runId, JSON.stringify(c)],
      );
    }
  }

  async getCall(callId: string): Promise<CallRecord | null> {
    const res = await this.sql.query<{ doc: CallRecord }>(
      "SELECT doc FROM sfield_calls WHERE namespace = $1 AND call_id = $2",
      [this.namespace, callId],
    );
    return res.rows[0]?.doc ?? null;
  }

  async listCalls(runId: string): Promise<CallRecord[]> {
    const res = await this.sql.query<{ doc: CallRecord }>(
      "SELECT doc FROM sfield_calls WHERE namespace = $1 AND run_id = $2",
      [this.namespace, runId],
    );
    return res.rows.map((r) => r.doc);
  }

  async updateCall(runId: string, _epoch: number, callId: string, patch: Partial<CallRecord>): Promise<CallRecord> {
    const cur = await this.getCall(callId);
    if (!cur || cur.runId !== runId) throw new SFieldError("NOT_FOUND", `call ${callId} not found`);
    const next: CallRecord = { ...cur, ...patch, updatedAt: nowIso() };
    await this.sql.query("UPDATE sfield_calls SET doc = $1::jsonb WHERE namespace = $2 AND call_id = $3", [JSON.stringify(next), this.namespace, callId]);
    return next;
  }

  async authorizeDispatch(input: {
    runId: string; epoch: number; callId: string; approvalId?: string;
    reservation: Omit<ReservationRecord, "id" | "state" | "createdAt" | "updatedAt">;
    scopes: BudgetScopeRequest[];
  }): Promise<{ ok: true; reservationId: string } | { ok: false; code: string; reason: string }> {
    const resv = await this.reserve(input.reservation, input.scopes);
    if (!resv.ok) return { ok: false, code: resv.code, reason: "Budget ceiling reached" };
    if (input.approvalId) {
      await this.consumeApproval(input.approvalId, input.runId, input.epoch);
    }
    return { ok: true, reservationId: resv.id };
  }

  async recordIntent(runId: string, epoch: number, callId: string, intent: NonNullable<CallRecord["intent"]>): Promise<void> {
    await this.updateCall(runId, epoch, callId, { intent, state: "intent_committed" });
  }

  async commitResult(input: CommitResultInput): Promise<void> {
    const cur = await this.getCall(input.callId);
    if (!cur) throw new SFieldError("NOT_FOUND", `call ${input.callId} not found`);
    const attempts = input.attempt ? [...cur.attempts, input.attempt] : cur.attempts;
    await this.updateCall(input.runId, input.epoch, input.callId, { result: input.result, state: input.state, attempts });
    if (input.reservation) {
      await this.settle(input.reservation.id, input.reservation.actualMicroUsd, input.reservation.state === "held" ? "settled" : input.reservation.state);
    }
    if (input.events.length) await this.appendEvents(input.runId, input.epoch, input.events);
    if (input.audit?.length) await this.appendAudit(input.audit);
  }

  async recordLateObservation(callId: string, observation: JsonObject, actor?: string): Promise<void> {
    const cur = await this.getCall(callId);
    if (!cur) return;
    const late = [...(cur.lateObservations ?? []), { at: nowIso(), observation, ...(actor ? { actor } : {}) }];
    await this.sql.query("UPDATE sfield_calls SET doc = $1::jsonb WHERE namespace = $2 AND call_id = $3", [JSON.stringify({ ...cur, lateObservations: late }), this.namespace, callId]);
  }

  async createApproval(rec: ApprovalRecord): Promise<ApprovalRecord> {
    await this.sql.query(
      "INSERT INTO sfield_approvals (id, namespace, tenant_id, run_id, status, doc) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
      [rec.id, this.namespace, rec.tenantId, rec.runId, rec.status, JSON.stringify(rec)],
    );
    return rec;
  }

  async getApproval(id: string): Promise<ApprovalRecord | null> {
    const res = await this.sql.query<{ doc: ApprovalRecord }>("SELECT doc FROM sfield_approvals WHERE namespace = $1 AND id = $2", [this.namespace, id]);
    return res.rows[0]?.doc ?? null;
  }

  async listApprovals(filter: { tenantId?: string; runId?: string; status?: ApprovalRecord["status"][] }): Promise<ApprovalRecord[]> {
    const clauses = ["namespace = $1"];
    const params: unknown[] = [this.namespace];
    if (filter.tenantId) { params.push(filter.tenantId); clauses.push(`tenant_id = $${params.length}`); }
    if (filter.runId) { params.push(filter.runId); clauses.push(`run_id = $${params.length}`); }
    if (filter.status?.length) { params.push(filter.status); clauses.push(`status = ANY($${params.length})`); }
    const res = await this.sql.query<{ doc: ApprovalRecord }>(`SELECT doc FROM sfield_approvals WHERE ${clauses.join(" AND ")}`, params);
    return res.rows.map((r) => r.doc);
  }

  async decideApproval(input: { id: string; actor: Actor; decision: "approve" | "deny"; comment?: string; now: string }): Promise<{ approval: ApprovalRecord; changed: boolean }> {
    const cur = await this.getApproval(input.id);
    if (!cur) throw new SFieldError("NOT_FOUND", `approval ${input.id} not found`);
    const targetStatus = input.decision === "approve" ? "approved" : "denied";
    if (cur.status !== "pending") {
      if (cur.status === targetStatus) return { approval: cur, changed: false };
      throw new SFieldError("APPROVAL_ALREADY_DECIDED", `approval ${input.id} is already ${cur.status}`);
    }
    const next: ApprovalRecord = {
      ...cur,
      status: targetStatus,
      decision: { actor: input.actor, decision: input.decision, ...(input.comment ? { comment: input.comment } : {}), decidedAt: input.now },
    };
    await this.sql.query("UPDATE sfield_approvals SET status = $1, doc = $2::jsonb WHERE namespace = $3 AND id = $4", [next.status, JSON.stringify(next), this.namespace, input.id]);
    return { approval: next, changed: true };
  }

  async consumeApproval(id: string, _runId: string, _epoch: number): Promise<ApprovalRecord> {
    const cur = await this.getApproval(id);
    if (!cur) throw new SFieldError("NOT_FOUND", `approval ${id} not found`);
    const next: ApprovalRecord = { ...cur, status: "consumed", consumedAt: nowIso() };
    await this.sql.query("UPDATE sfield_approvals SET status = 'consumed', doc = $1::jsonb WHERE namespace = $2 AND id = $3", [JSON.stringify(next), this.namespace, id]);
    return next;
  }

  async createInputRequest(rec: InputRequestRecord): Promise<InputRequestRecord> {
    await this.sql.query(
      "INSERT INTO sfield_inputs (request_id, namespace, tenant_id, run_id, status, doc) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
      [rec.requestId, this.namespace, rec.tenantId, rec.runId, rec.status, JSON.stringify(rec)],
    );
    return rec;
  }

  async getInputRequest(id: string): Promise<InputRequestRecord | null> {
    const res = await this.sql.query<{ doc: InputRequestRecord }>("SELECT doc FROM sfield_inputs WHERE namespace = $1 AND request_id = $2", [this.namespace, id]);
    return res.rows[0]?.doc ?? null;
  }

  async listInputRequests(filter: { tenantId?: string; runId?: string; status?: InputRequestRecord["status"][] }): Promise<InputRequestRecord[]> {
    const clauses = ["namespace = $1"];
    const params: unknown[] = [this.namespace];
    if (filter.tenantId) { params.push(filter.tenantId); clauses.push(`tenant_id = $${params.length}`); }
    if (filter.runId) { params.push(filter.runId); clauses.push(`run_id = $${params.length}`); }
    if (filter.status?.length) { params.push(filter.status); clauses.push(`status = ANY($${params.length})`); }
    const res = await this.sql.query<{ doc: InputRequestRecord }>(`SELECT doc FROM sfield_inputs WHERE ${clauses.join(" AND ")}`, params);
    return res.rows.map((r) => r.doc);
  }

  async answerInput(input: { id: string; actor: Actor; value: JsonValue; now: string }): Promise<{ request: InputRequestRecord; changed: boolean }> {
    const cur = await this.getInputRequest(input.id);
    if (!cur) throw new SFieldError("NOT_FOUND", `input request ${input.id} not found`);
    if (cur.status !== "pending") return { request: cur, changed: false };
    const next: InputRequestRecord = { ...cur, status: "answered", answer: { actor: input.actor, value: input.value, answeredAt: input.now } };
    await this.sql.query("UPDATE sfield_inputs SET status = 'answered', doc = $1::jsonb WHERE namespace = $2 AND request_id = $3", [JSON.stringify(next), this.namespace, input.id]);
    return { request: next, changed: true };
  }

  async saveCheckpoint(runId: string, _epoch: number, checkpoint: Checkpoint): Promise<void> {
    await this.sql.query(
      "INSERT INTO sfield_checkpoints (run_id, namespace, doc) VALUES ($1, $2, $3::jsonb) ON CONFLICT (run_id) DO UPDATE SET doc = EXCLUDED.doc",
      [runId, this.namespace, JSON.stringify(checkpoint)],
    );
  }

  async getCheckpoint(runId: string): Promise<Checkpoint | null> {
    const res = await this.sql.query<{ doc: Checkpoint }>("SELECT doc FROM sfield_checkpoints WHERE namespace = $1 AND run_id = $2", [this.namespace, runId]);
    return res.rows[0]?.doc ?? null;
  }

  async appendEvents(runId: string, _epoch: number | null, events: RunEvent[]): Promise<RunEvent[]> {
    const maxRes = await this.sql.query<{ max_seq: number | null }>("SELECT MAX(seq) AS max_seq FROM sfield_events WHERE namespace = $1 AND run_id = $2", [this.namespace, runId]);
    let seq = maxRes.rows[0]?.max_seq ?? 0;
    const out: RunEvent[] = [];
    for (const ev of events) {
      seq++;
      const stamped: RunEvent = { ...ev, seq };
      await this.sql.query(
        "INSERT INTO sfield_events (run_id, seq, namespace, doc) VALUES ($1, $2, $3, $4::jsonb)",
        [runId, seq, this.namespace, JSON.stringify(stamped)],
      );
      out.push(stamped);
    }
    return out;
  }

  async readEvents(runId: string, afterSeq: number, limit = 500): Promise<{ events: RunEvent[]; gap: boolean; lastSeq: number }> {
    const res = await this.sql.query<{ doc: RunEvent }>(
      "SELECT doc FROM sfield_events WHERE namespace = $1 AND run_id = $2 AND seq > $3 ORDER BY seq ASC LIMIT $4",
      [this.namespace, runId, afterSeq, limit],
    );
    const events = res.rows.map((r) => r.doc);
    const lastSeq = events.at(-1)?.seq ?? afterSeq;
    return { events, gap: false, lastSeq };
  }

  async appendAudit(records: AuditRecord[]): Promise<void> {
    for (const rec of records) {
      await this.sql.query(
        "INSERT INTO sfield_audit (id, namespace, tenant_id, run_id, type, at, doc) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb)",
        [rec.id, this.namespace, rec.tenantId, rec.runId ?? null, rec.type, rec.at, JSON.stringify(rec)],
      );
    }
  }

  async readAudit(filter: { tenantId?: string; runId?: string; type?: string; limit?: number }): Promise<AuditRecord[]> {
    const clauses = ["namespace = $1"];
    const params: unknown[] = [this.namespace];
    if (filter.tenantId) { params.push(filter.tenantId); clauses.push(`tenant_id = $${params.length}`); }
    if (filter.runId) { params.push(filter.runId); clauses.push(`run_id = $${params.length}`); }
    if (filter.type) { params.push(filter.type); clauses.push(`type = $${params.length}`); }
    params.push(filter.limit ?? 200);
    const res = await this.sql.query<{ doc: AuditRecord }>(
      `SELECT doc FROM sfield_audit WHERE ${clauses.join(" AND ")} ORDER BY at DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map((r) => r.doc);
  }

  async reserve(input: Omit<ReservationRecord, "id" | "state" | "createdAt" | "updatedAt">, scopes: BudgetScopeRequest[]): Promise<{ ok: true; id: string } | { ok: false; code: string; reason: string }> {
    for (const s of scopes) {
      const usage = await this.scopeUsage(s.key);
      if (usage.heldMicroUsd + usage.settledMicroUsd + input.estimateMicroUsd > s.ceilingMicroUsd) {
        return { ok: false, code: "BUDGET_EXHAUSTED", reason: `Budget scope ${s.key} exceeded` };
      }
    }
    const now = nowIso();
    const rec: ReservationRecord = { ...input, id: newId("res"), state: "held", createdAt: now, updatedAt: now };
    await this.sql.query("INSERT INTO sfield_reservations (id, namespace, state, doc) VALUES ($1, $2, $3, $4::jsonb)", [rec.id, this.namespace, rec.state, JSON.stringify(rec)]);
    return { ok: true, id: rec.id };
  }

  async settle(id: string, actualMicroUsd: number, state: Exclude<ReservationState, "held">): Promise<void> {
    const cur = await this.getReservation(id);
    if (!cur) return;
    const next: ReservationRecord = { ...cur, actualMicroUsd, state, updatedAt: nowIso() };
    await this.sql.query("UPDATE sfield_reservations SET state = $1, doc = $2::jsonb WHERE namespace = $3 AND id = $4", [state, JSON.stringify(next), this.namespace, id]);
  }

  async getReservation(id: string): Promise<ReservationRecord | null> {
    const res = await this.sql.query<{ doc: ReservationRecord }>("SELECT doc FROM sfield_reservations WHERE namespace = $1 AND id = $2", [this.namespace, id]);
    return res.rows[0]?.doc ?? null;
  }

  async scopeUsage(scopeKey: string): Promise<{ heldMicroUsd: number; settledMicroUsd: number }> {
    const res = await this.sql.query<{ doc: ReservationRecord }>(
      "SELECT doc FROM sfield_reservations WHERE namespace = $1 AND doc->'scopes' ? $2",
      [this.namespace, scopeKey],
    );
    let heldMicroUsd = 0;
    let settledMicroUsd = 0;
    for (const { doc } of res.rows) {
      if (doc.state === "held" || doc.state === "dispatched") heldMicroUsd += doc.estimateMicroUsd;
      else if (doc.state === "settled" || doc.state === "uncertain") settledMicroUsd += doc.actualMicroUsd ?? doc.estimateMicroUsd;
    }
    return { heldMicroUsd, settledMicroUsd };
  }

  async recordModelAttempt(runId: string, rec: ModelAttemptRecord): Promise<void> {
    await this.sql.query(
      "INSERT INTO sfield_model_attempts (attempt_id, namespace, run_id, doc) VALUES ($1, $2, $3, $4::jsonb)",
      [rec.attemptId, this.namespace, runId, JSON.stringify(rec)],
    );
  }

  async listModelAttempts(runId: string): Promise<ModelAttemptRecord[]> {
    const res = await this.sql.query<{ doc: ModelAttemptRecord }>("SELECT doc FROM sfield_model_attempts WHERE namespace = $1 AND run_id = $2", [this.namespace, runId]);
    return res.rows.map((r) => r.doc);
  }

  async saveContextExplanation(rec: ContextExplanation): Promise<void> {
    await this.sql.query(
      "INSERT INTO sfield_context_explanations (id, namespace, doc) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc",
      [rec.contextId, this.namespace, JSON.stringify(rec)],
    );
  }

  async getContextExplanation(id: string): Promise<ContextExplanation | null> {
    const res = await this.sql.query<{ doc: ContextExplanation }>("SELECT doc FROM sfield_context_explanations WHERE namespace = $1 AND id = $2", [this.namespace, id]);
    return res.rows[0]?.doc ?? null;
  }

  readonly lockApprovals = {
    get: async (digest: string): Promise<LockApprovalRecord | null> => {
      const res = await this.sql.query<{ doc: LockApprovalRecord }>("SELECT doc FROM sfield_lock_approvals WHERE namespace = $1 AND digest = $2", [this.namespace, digest]);
      return res.rows[0]?.doc ?? null;
    },
    put: async (rec: LockApprovalRecord): Promise<{ record: LockApprovalRecord; changed: boolean }> => {
      const existing = await this.lockApprovals.get(rec.digest);
      if (existing) return { record: existing, changed: false };
      await this.sql.query(
        "INSERT INTO sfield_lock_approvals (digest, namespace, suite, decided_at, doc) VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)",
        [rec.digest, this.namespace, rec.suite ?? null, rec.decidedAt, JSON.stringify(rec)],
      );
      return { record: rec, changed: true };
    },
    latest: async (suite?: string): Promise<LockApprovalRecord | null> => {
      const res = suite
        ? await this.sql.query<{ doc: LockApprovalRecord }>("SELECT doc FROM sfield_lock_approvals WHERE namespace = $1 AND suite = $2 ORDER BY decided_at DESC LIMIT 1", [this.namespace, suite])
        : await this.sql.query<{ doc: LockApprovalRecord }>("SELECT doc FROM sfield_lock_approvals WHERE namespace = $1 ORDER BY decided_at DESC LIMIT 1", [this.namespace]);
      return res.rows[0]?.doc ?? null;
    },
  };

  readonly evalReports = {
    get: async (id: string): Promise<EvalReportRecord | null> => {
      const res = await this.sql.query<{ doc: EvalReportRecord }>("SELECT doc FROM sfield_eval_reports WHERE namespace = $1 AND id = $2", [this.namespace, id]);
      return res.rows[0]?.doc ?? null;
    },
    put: async (rec: EvalReportRecord): Promise<void> => {
      await this.sql.query(
        "INSERT INTO sfield_eval_reports (id, namespace, suite, candidate_digest, created_at, doc) VALUES ($1, $2, $3, $4, $5::timestamptz, $6::jsonb)",
        [rec.id, this.namespace, rec.suite, rec.candidateDigest, rec.createdAt, JSON.stringify(rec)],
      );
    },
    list: async (filter: { suite?: string; candidateDigest?: string }): Promise<EvalReportRecord[]> => {
      const clauses = ["namespace = $1"];
      const params: unknown[] = [this.namespace];
      if (filter.suite) { params.push(filter.suite); clauses.push(`suite = $${params.length}`); }
      if (filter.candidateDigest) { params.push(filter.candidateDigest); clauses.push(`candidate_digest = $${params.length}`); }
      const res = await this.sql.query<{ doc: EvalReportRecord }>(`SELECT doc FROM sfield_eval_reports WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`, params);
      return res.rows.map((r) => r.doc);
    },
  };
}

/**
 * Creates a `deployment: "service"` in-memory persistence instance for fast local multi-node tests
 * without requiring a running PostgreSQL server.
 */
export function createServiceMemoryPersistence(): ExecutionPersistence {
  const inner = new EphemeralPersistence();
  return Object.assign(Object.create(Object.getPrototypeOf(inner)), inner, { mode: "service" as const });
}
