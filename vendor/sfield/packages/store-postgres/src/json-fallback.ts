/**
 * Durable JSON-file ExecutionPersistence & automatic Postgres-with-JSON-fallback store.
 *
 * `JsonFilePersistence` implements the full @sfield/core `ExecutionPersistence` contract
 * (passing the official conformance suite) with atomic temp-file swaps (`writeFileSync` +
 * `renameSync`) on every mutation, paired with `FilesystemArtifactStore` and durable JSON
 * `MemoryRepository`.
 *
 * `createPostgresOrJsonPersistence()` attempts PostgreSQL first during `init()` and
 * automatically falls back to `JsonFilePersistence` when Postgres is unconfigured or unreachable.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  EphemeralPersistence,
  FilesystemArtifactStore,
  InMemoryMemoryRepository,
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
  type DeploymentMode,
  type EvalReportRecord,
  type ExecutionPersistence,
  type InputRequestRecord,
  type JsonObject,
  type JsonValue,
  type LockApprovalRecord,
  type MemoryFilter,
  type MemoryItem,
  type MemoryKind,
  type MemoryOutboxEvent,
  type MemoryRepository,
  type MemoryScope,
  type MessageRecord,
  type ModelAttemptRecord,
  type OwnershipClaim,
  type Page,
  type PageRequest,
  type ReservationRecord,
  type ReservationState,
  type RunEvent,
  type RunRecord,
  type RunState,
} from "@sfield/core";
import { PostgresPersistence, type PostgresSqlClient } from "./index.js";

export interface JsonFilePersistenceOptions {
  /** Path to the durable JSON state file (parent directories are created automatically). */
  path: string;
  /** Optional directory for durable filesystem artifacts. Defaults to `<path>.artifacts`. */
  artifactsDir?: string;
  /** Deployment mode advertised by this store. Defaults to `"service"` (drop-in Postgres fallback). */
  mode?: DeploymentMode;
  eventRetention?: number;
}

class PersistingMemoryRepository implements MemoryRepository {
  constructor(
    private readonly inner: InMemoryMemoryRepository,
    private readonly flush: () => void,
  ) {}

  get(tenantId: string, id: string): Promise<MemoryItem | null> {
    return this.inner.get(tenantId, id);
  }
  list(tenantId: string, filter: MemoryFilter, page?: PageRequest): Promise<Page<MemoryItem>> {
    return this.inner.list(tenantId, filter, page);
  }
  async create(tenantId: string, item: MemoryItem, idempotencyKey: string): Promise<{ item: MemoryItem; created: boolean }> {
    const res = await this.inner.create(tenantId, item, idempotencyKey);
    if (res.created) this.flush();
    return res;
  }
  async update(tenantId: string, id: string, ifVersion: string, next: MemoryItem): Promise<MemoryItem> {
    const res = await this.inner.update(tenantId, id, ifVersion, next);
    this.flush();
    return res;
  }
  async delete(tenantId: string, ids: string[], idempotencyKey: string): Promise<{ generation: number; count: number }> {
    const res = await this.inner.delete(tenantId, ids, idempotencyKey);
    if (res.count > 0) this.flush();
    return res;
  }
  generation(tenantId: string, scopeKey: string): Promise<number> {
    return this.inner.generation(tenantId, scopeKey);
  }
  countActive(tenantId: string, scope: MemoryScope, kind: MemoryKind): Promise<number> {
    return this.inner.countActive(tenantId, scope, kind);
  }
  drainOutbox(max: number): Promise<MemoryOutboxEvent[]> {
    return this.inner.drainOutbox(max);
  }
  async ackOutbox(ids: string[]): Promise<void> {
    await this.inner.ackOutbox(ids);
    if (ids.length > 0) this.flush();
  }
}

export class JsonFilePersistence implements ExecutionPersistence {
  readonly mode: DeploymentMode;
  readonly artifacts: ArtifactStore;
  readonly memory: MemoryRepository;
  private readonly filePath: string;
  private readonly memInner: InMemoryMemoryRepository;
  private readonly inner: EphemeralPersistence;
  private closed = false;

  constructor(options: JsonFilePersistenceOptions) {
    this.filePath = resolve(options.path);
    this.mode = options.mode ?? "service";
    this.artifacts = new FilesystemArtifactStore({ rootDir: options.artifactsDir ?? `${this.filePath}.artifacts` });
    this.memInner = new InMemoryMemoryRepository();
    this.memory = new PersistingMemoryRepository(this.memInner, () => this.persistToDisk());
    this.inner = new EphemeralPersistence({
      eventRetention: options.eventRetention,
      memory: this.memory,
      artifacts: this.artifacts,
    });
  }

  private loadFromDisk(): void {
    if (!existsSync(this.filePath)) return;
    const raw = readFileSync(this.filePath, "utf8").trim();
    if (!raw) return;
    const parsed = JSON.parse(raw) as { execution?: Record<string, unknown>; memory?: Record<string, unknown> };
    if (parsed.execution) this.inner.importSnapshot(parsed.execution);
    if (parsed.memory) this.memInner.importSnapshot(parsed.memory);
  }

  private persistToDisk(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const payload = JSON.stringify(
      {
        version: 1,
        savedAt: new Date().toISOString(),
        execution: this.inner.exportSnapshot(),
        memory: this.memInner.exportSnapshot(),
      },
      null,
      2,
    );
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, payload, "utf8");
    renameSync(tmp, this.filePath);
  }

  async init(ctx: { namespace: string; ownerId: string }): Promise<void> {
    this.closed = false;
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.loadFromDisk();
    await this.inner.init(ctx);
    if (!existsSync(this.filePath)) this.persistToDisk();
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.persistToDisk();
      this.closed = true;
    }
    await this.inner.close();
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: !this.closed, detail: this.closed ? "closed" : `json-file:${this.filePath}` };
  }

  async acceptRequest(input: AcceptRequestInput): Promise<AcceptRequestResult> {
    const res = await this.inner.acceptRequest(input);
    if (res.created) this.persistToDisk();
    return res;
  }
  getRun(runId: string): Promise<RunRecord | null> { return this.inner.getRun(runId); }
  listRuns(filter: { tenantId?: string; conversationId?: string; state?: RunState[]; limit?: number }): Promise<RunRecord[]> { return this.inner.listRuns(filter); }
  async updateRun(runId: string, epoch: number, patch: Partial<RunRecord>): Promise<RunRecord> {
    const res = await this.inner.updateRun(runId, epoch, patch);
    this.persistToDisk();
    return res;
  }
  listWakeups(): Promise<RunRecord[]> { return this.inner.listWakeups(); }
  async requestCancel(runId: string, reason?: string): Promise<void> {
    await this.inner.requestCancel(runId, reason);
    this.persistToDisk();
  }

  async claim(scopeId: string, ownerId: string, leaseMs: number): Promise<OwnershipClaim | null> {
    const res = await this.inner.claim(scopeId, ownerId, leaseMs);
    if (res) this.persistToDisk();
    return res;
  }
  async renew(claim: OwnershipClaim, leaseMs: number): Promise<OwnershipClaim | null> {
    const res = await this.inner.renew(claim, leaseMs);
    if (res) this.persistToDisk();
    return res;
  }
  async release(claim: OwnershipClaim): Promise<void> {
    await this.inner.release(claim);
    this.persistToDisk();
  }
  currentOwner(scopeId: string): Promise<OwnershipClaim | null> { return this.inner.currentOwner(scopeId); }

  async createConversation(rec: ConversationRecord): Promise<ConversationRecord> {
    const res = await this.inner.createConversation(rec);
    this.persistToDisk();
    return res;
  }
  getConversation(id: string): Promise<ConversationRecord | null> { return this.inner.getConversation(id); }
  async setActiveRun(conversationId: string, runId: string | null, expectedActive?: string | null): Promise<boolean> {
    const res = await this.inner.setActiveRun(conversationId, runId, expectedActive);
    if (res) this.persistToDisk();
    return res;
  }
  async appendMessage(msg: Omit<MessageRecord, "index" | "id"> & { id?: string }): Promise<MessageRecord> {
    const res = await this.inner.appendMessage(msg);
    this.persistToDisk();
    return res;
  }
  listMessages(conversationId: string, opts: { limit?: number; before?: number; includeExpired?: boolean }): Promise<MessageRecord[]> { return this.inner.listMessages(conversationId, opts); }
  async deleteConversation(id: string): Promise<{ messages: number }> {
    const res = await this.inner.deleteConversation(id);
    this.persistToDisk();
    return res;
  }

  async prepareBatch(runId: string, epoch: number, calls: CallRecord[]): Promise<void> {
    await this.inner.prepareBatch(runId, epoch, calls);
    this.persistToDisk();
  }
  getCall(callId: string): Promise<CallRecord | null> { return this.inner.getCall(callId); }
  listCalls(runId: string): Promise<CallRecord[]> { return this.inner.listCalls(runId); }
  async updateCall(runId: string, epoch: number, callId: string, patch: Partial<CallRecord>): Promise<CallRecord> {
    const res = await this.inner.updateCall(runId, epoch, callId, patch);
    this.persistToDisk();
    return res;
  }
  async authorizeDispatch(input: {
    runId: string;
    epoch: number;
    callId: string;
    approvalId?: string;
    reservation: Omit<ReservationRecord, "id" | "state" | "createdAt" | "updatedAt">;
    scopes: BudgetScopeRequest[];
  }): Promise<{ ok: true; reservationId: string } | { ok: false; code: string; reason: string }> {
    const res = await this.inner.authorizeDispatch(input);
    if (res.ok) this.persistToDisk();
    return res;
  }
  async recordIntent(runId: string, epoch: number, callId: string, intent: NonNullable<CallRecord["intent"]>): Promise<void> {
    await this.inner.recordIntent(runId, epoch, callId, intent);
    this.persistToDisk();
  }
  async commitResult(input: CommitResultInput): Promise<void> {
    await this.inner.commitResult(input);
    this.persistToDisk();
  }
  async recordLateObservation(callId: string, observation: JsonObject, actor?: string): Promise<void> {
    await this.inner.recordLateObservation(callId, observation, actor);
    this.persistToDisk();
  }

  async createApproval(rec: ApprovalRecord): Promise<ApprovalRecord> {
    const res = await this.inner.createApproval(rec);
    this.persistToDisk();
    return res;
  }
  getApproval(id: string): Promise<ApprovalRecord | null> { return this.inner.getApproval(id); }
  listApprovals(filter: { tenantId?: string; runId?: string; status?: ApprovalRecord["status"][] }): Promise<ApprovalRecord[]> { return this.inner.listApprovals(filter); }
  async decideApproval(input: { id: string; actor: Actor; decision: "approve" | "deny"; comment?: string; now: string }): Promise<{ approval: ApprovalRecord; changed: boolean }> {
    const res = await this.inner.decideApproval(input);
    if (res.changed) this.persistToDisk();
    return res;
  }
  async consumeApproval(id: string, runId: string, epoch: number): Promise<ApprovalRecord> {
    const res = await this.inner.consumeApproval(id, runId, epoch);
    this.persistToDisk();
    return res;
  }

  async createInputRequest(rec: InputRequestRecord): Promise<InputRequestRecord> {
    const res = await this.inner.createInputRequest(rec);
    this.persistToDisk();
    return res;
  }
  getInputRequest(id: string): Promise<InputRequestRecord | null> { return this.inner.getInputRequest(id); }
  listInputRequests(filter: { tenantId?: string; runId?: string; status?: InputRequestRecord["status"][] }): Promise<InputRequestRecord[]> { return this.inner.listInputRequests(filter); }
  async answerInput(input: { id: string; actor: Actor; value: JsonValue; now: string }): Promise<{ request: InputRequestRecord; changed: boolean }> {
    const res = await this.inner.answerInput(input);
    if (res.changed) this.persistToDisk();
    return res;
  }

  async saveCheckpoint(runId: string, epoch: number, checkpoint: Checkpoint): Promise<void> {
    await this.inner.saveCheckpoint(runId, epoch, checkpoint);
    this.persistToDisk();
  }
  getCheckpoint(runId: string): Promise<Checkpoint | null> { return this.inner.getCheckpoint(runId); }

  async appendEvents(runId: string, epoch: number | null, events: RunEvent[]): Promise<RunEvent[]> {
    const res = await this.inner.appendEvents(runId, epoch, events);
    this.persistToDisk();
    return res;
  }
  readEvents(runId: string, afterSeq: number, limit?: number): Promise<{ events: RunEvent[]; gap: boolean; lastSeq: number }> { return this.inner.readEvents(runId, afterSeq, limit); }

  async appendAudit(records: AuditRecord[]): Promise<void> {
    await this.inner.appendAudit(records);
    this.persistToDisk();
  }
  readAudit(filter: { tenantId?: string; runId?: string; type?: string; limit?: number }): Promise<AuditRecord[]> { return this.inner.readAudit(filter); }

  async reserve(input: Omit<ReservationRecord, "id" | "state" | "createdAt" | "updatedAt">, scopes: BudgetScopeRequest[]): Promise<{ ok: true; id: string } | { ok: false; code: string; reason: string }> {
    const res = await this.inner.reserve(input, scopes);
    if (res.ok) this.persistToDisk();
    return res;
  }
  async settle(id: string, actualMicroUsd: number, state: Exclude<ReservationState, "held">): Promise<void> {
    await this.inner.settle(id, actualMicroUsd, state);
    this.persistToDisk();
  }
  getReservation(id: string): Promise<ReservationRecord | null> { return this.inner.getReservation(id); }
  scopeUsage(scopeKey: string): Promise<{ heldMicroUsd: number; settledMicroUsd: number }> { return this.inner.scopeUsage(scopeKey); }

  async recordModelAttempt(runId: string, rec: ModelAttemptRecord): Promise<void> {
    await this.inner.recordModelAttempt(runId, rec);
    this.persistToDisk();
  }
  listModelAttempts(runId: string): Promise<ModelAttemptRecord[]> { return this.inner.listModelAttempts(runId); }

  async saveContextExplanation(rec: ContextExplanation): Promise<void> {
    await this.inner.saveContextExplanation(rec);
    this.persistToDisk();
  }
  getContextExplanation(id: string): Promise<ContextExplanation | null> { return this.inner.getContextExplanation(id); }

  readonly lockApprovals = {
    get: (digest: string): Promise<LockApprovalRecord | null> => this.inner.lockApprovals.get(digest),
    put: async (rec: LockApprovalRecord): Promise<{ record: LockApprovalRecord; changed: boolean }> => {
      const res = await this.inner.lockApprovals.put(rec);
      if (res.changed) this.persistToDisk();
      return res;
    },
    latest: (suite?: string): Promise<LockApprovalRecord | null> => this.inner.lockApprovals.latest(suite),
  };

  readonly evalReports = {
    get: (id: string): Promise<EvalReportRecord | null> => this.inner.evalReports.get(id),
    put: async (rec: EvalReportRecord): Promise<void> => {
      await this.inner.evalReports.put(rec);
      this.persistToDisk();
    },
    list: (filter: { suite?: string; candidateDigest?: string }): Promise<EvalReportRecord[]> => this.inner.evalReports.list(filter),
  };
}

export interface PostgresOrJsonOptions {
  /** Optional PostgreSQL client. When omitted or unreachable at `init()`, falls back to JSON file persistence. */
  client?: PostgresSqlClient;
  /** Durable JSON file path used when Postgres is unconfigured or unavailable. */
  jsonPath: string;
  /** Optional durable filesystem artifact directory shared across both backends. */
  artifactsDir?: string;
  autoMigrate?: boolean;
  /** Optional callback invoked when Postgres is unavailable and JSON fallback activates. */
  onFallback?: (reason: string) => void;
}

/**
 * Resilient `deployment: "service"` persistence that prefers PostgreSQL and automatically
 * falls back to durable atomic JSON-file persistence when Postgres is unconfigured or unreachable.
 */
export class PostgresOrJsonPersistence implements ExecutionPersistence {
  readonly mode = "service" as const;
  readonly artifacts: ArtifactStore;
  private active: ExecutionPersistence;
  private backend: "postgres" | "json" = "json";
  private readonly pgStore: PostgresPersistence | null;
  private readonly jsonStore: JsonFilePersistence;
  private readonly onFallback?: (reason: string) => void;

  constructor(options: PostgresOrJsonOptions) {
    this.artifacts = new FilesystemArtifactStore({ rootDir: options.artifactsDir ?? `${resolve(options.jsonPath)}.artifacts` });
    this.jsonStore = new JsonFilePersistence({
      path: options.jsonPath,
      artifactsDir: options.artifactsDir ?? `${resolve(options.jsonPath)}.artifacts`,
      mode: "service",
    });
    this.pgStore = options.client
      ? new PostgresPersistence({
          client: options.client,
          autoMigrate: options.autoMigrate,
          artifacts: this.artifacts,
        })
      : null;
    this.active = this.jsonStore;
    this.onFallback = options.onFallback;
  }

  get memory(): MemoryRepository | undefined {
    return this.active.memory;
  }

  activeBackend(): "postgres" | "json" {
    return this.backend;
  }

  async init(ctx: { namespace: string; ownerId: string }): Promise<void> {
    if (this.pgStore) {
      try {
        await this.pgStore.init(ctx);
        const h = await this.pgStore.health();
        if (h.ok) {
          this.active = this.pgStore;
          this.backend = "postgres";
          return;
        }
        this.onFallback?.(h.detail ?? "postgres health check returned not ok");
      } catch (err) {
        this.onFallback?.(err instanceof Error ? err.message : String(err));
      }
    } else {
      this.onFallback?.("no postgres client configured");
    }
    this.active = this.jsonStore;
    this.backend = "json";
    await this.jsonStore.init(ctx);
  }

  close(): Promise<void> { return this.active.close(); }
  async health(): Promise<{ ok: boolean; detail?: string }> {
    const h = await this.active.health();
    return { ok: h.ok, detail: `${this.backend}:${h.detail ?? "ok"}` };
  }

  acceptRequest(input: AcceptRequestInput): Promise<AcceptRequestResult> { return this.active.acceptRequest(input); }
  getRun(runId: string): Promise<RunRecord | null> { return this.active.getRun(runId); }
  listRuns(filter: { tenantId?: string; conversationId?: string; state?: RunState[]; limit?: number }): Promise<RunRecord[]> { return this.active.listRuns(filter); }
  updateRun(runId: string, epoch: number, patch: Partial<RunRecord>): Promise<RunRecord> { return this.active.updateRun(runId, epoch, patch); }
  listWakeups(): Promise<RunRecord[]> { return this.active.listWakeups(); }
  requestCancel(runId: string, reason?: string): Promise<void> { return this.active.requestCancel(runId, reason); }
  claim(scopeId: string, ownerId: string, leaseMs: number): Promise<OwnershipClaim | null> { return this.active.claim(scopeId, ownerId, leaseMs); }
  renew(claim: OwnershipClaim, leaseMs: number): Promise<OwnershipClaim | null> { return this.active.renew(claim, leaseMs); }
  release(claim: OwnershipClaim): Promise<void> { return this.active.release(claim); }
  currentOwner(scopeId: string): Promise<OwnershipClaim | null> { return this.active.currentOwner(scopeId); }
  createConversation(rec: ConversationRecord): Promise<ConversationRecord> { return this.active.createConversation(rec); }
  getConversation(id: string): Promise<ConversationRecord | null> { return this.active.getConversation(id); }
  setActiveRun(conversationId: string, runId: string | null, expectedActive?: string | null): Promise<boolean> { return this.active.setActiveRun(conversationId, runId, expectedActive); }
  appendMessage(msg: Omit<MessageRecord, "index" | "id"> & { id?: string }): Promise<MessageRecord> { return this.active.appendMessage(msg); }
  listMessages(conversationId: string, opts: { limit?: number; before?: number; includeExpired?: boolean }): Promise<MessageRecord[]> { return this.active.listMessages(conversationId, opts); }
  deleteConversation(id: string): Promise<{ messages: number }> { return this.active.deleteConversation(id); }
  prepareBatch(runId: string, epoch: number, calls: CallRecord[]): Promise<void> { return this.active.prepareBatch(runId, epoch, calls); }
  getCall(callId: string): Promise<CallRecord | null> { return this.active.getCall(callId); }
  listCalls(runId: string): Promise<CallRecord[]> { return this.active.listCalls(runId); }
  updateCall(runId: string, epoch: number, callId: string, patch: Partial<CallRecord>): Promise<CallRecord> { return this.active.updateCall(runId, epoch, callId, patch); }
  authorizeDispatch(input: {
    runId: string;
    epoch: number;
    callId: string;
    approvalId?: string;
    reservation: Omit<ReservationRecord, "id" | "state" | "createdAt" | "updatedAt">;
    scopes: BudgetScopeRequest[];
  }): Promise<{ ok: true; reservationId: string } | { ok: false; code: string; reason: string }> { return this.active.authorizeDispatch(input); }
  recordIntent(runId: string, epoch: number, callId: string, intent: NonNullable<CallRecord["intent"]>): Promise<void> { return this.active.recordIntent(runId, epoch, callId, intent); }
  commitResult(input: CommitResultInput): Promise<void> { return this.active.commitResult(input); }
  recordLateObservation(callId: string, observation: JsonObject, actor?: string): Promise<void> { return this.active.recordLateObservation(callId, observation, actor); }
  createApproval(rec: ApprovalRecord): Promise<ApprovalRecord> { return this.active.createApproval(rec); }
  getApproval(id: string): Promise<ApprovalRecord | null> { return this.active.getApproval(id); }
  listApprovals(filter: { tenantId?: string; runId?: string; status?: ApprovalRecord["status"][] }): Promise<ApprovalRecord[]> { return this.active.listApprovals(filter); }
  decideApproval(input: { id: string; actor: Actor; decision: "approve" | "deny"; comment?: string; now: string }): Promise<{ approval: ApprovalRecord; changed: boolean }> { return this.active.decideApproval(input); }
  consumeApproval(id: string, runId: string, epoch: number): Promise<ApprovalRecord> { return this.active.consumeApproval(id, runId, epoch); }
  createInputRequest(rec: InputRequestRecord): Promise<InputRequestRecord> { return this.active.createInputRequest(rec); }
  getInputRequest(id: string): Promise<InputRequestRecord | null> { return this.active.getInputRequest(id); }
  listInputRequests(filter: { tenantId?: string; runId?: string; status?: InputRequestRecord["status"][] }): Promise<InputRequestRecord[]> { return this.active.listInputRequests(filter); }
  answerInput(input: { id: string; actor: Actor; value: JsonValue; now: string }): Promise<{ request: InputRequestRecord; changed: boolean }> { return this.active.answerInput(input); }
  saveCheckpoint(runId: string, epoch: number, checkpoint: Checkpoint): Promise<void> { return this.active.saveCheckpoint(runId, epoch, checkpoint); }
  getCheckpoint(runId: string): Promise<Checkpoint | null> { return this.active.getCheckpoint(runId); }
  appendEvents(runId: string, epoch: number | null, events: RunEvent[]): Promise<RunEvent[]> { return this.active.appendEvents(runId, epoch, events); }
  readEvents(runId: string, afterSeq: number, limit?: number): Promise<{ events: RunEvent[]; gap: boolean; lastSeq: number }> { return this.active.readEvents(runId, afterSeq, limit); }
  appendAudit(records: AuditRecord[]): Promise<void> { return this.active.appendAudit(records); }
  readAudit(filter: { tenantId?: string; runId?: string; type?: string; limit?: number }): Promise<AuditRecord[]> { return this.active.readAudit(filter); }
  reserve(input: Omit<ReservationRecord, "id" | "state" | "createdAt" | "updatedAt">, scopes: BudgetScopeRequest[]): Promise<{ ok: true; id: string } | { ok: false; code: string; reason: string }> { return this.active.reserve(input, scopes); }
  settle(id: string, actualMicroUsd: number, state: Exclude<ReservationState, "held">): Promise<void> { return this.active.settle(id, actualMicroUsd, state); }
  getReservation(id: string): Promise<ReservationRecord | null> { return this.active.getReservation(id); }
  scopeUsage(scopeKey: string): Promise<{ heldMicroUsd: number; settledMicroUsd: number }> { return this.active.scopeUsage(scopeKey); }
  recordModelAttempt(runId: string, rec: ModelAttemptRecord): Promise<void> { return this.active.recordModelAttempt(runId, rec); }
  listModelAttempts(runId: string): Promise<ModelAttemptRecord[]> { return this.active.listModelAttempts(runId); }
  saveContextExplanation(rec: ContextExplanation): Promise<void> { return this.active.saveContextExplanation(rec); }
  getContextExplanation(id: string): Promise<ContextExplanation | null> { return this.active.getContextExplanation(id); }

  readonly lockApprovals = {
    get: (digest: string): Promise<LockApprovalRecord | null> => this.active.lockApprovals.get(digest),
    put: (rec: LockApprovalRecord): Promise<{ record: LockApprovalRecord; changed: boolean }> => this.active.lockApprovals.put(rec),
    latest: (suite?: string): Promise<LockApprovalRecord | null> => this.active.lockApprovals.latest(suite),
  };

  readonly evalReports = {
    get: (id: string): Promise<EvalReportRecord | null> => this.active.evalReports.get(id),
    put: (rec: EvalReportRecord): Promise<void> => this.active.evalReports.put(rec),
    list: (filter: { suite?: string; candidateDigest?: string }): Promise<EvalReportRecord[]> => this.active.evalReports.list(filter),
  };
}

export function createPostgresOrJsonPersistence(options: PostgresOrJsonOptions): PostgresOrJsonPersistence {
  return new PostgresOrJsonPersistence(options);
}
