import { customerOrderTask, orderSource } from "./commerce-orders";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { digestJson, sharedValidator, type JsonObject, type ToolResult } from "@sfield/core";
import {
  integrationSchema,
  taskContractInputSchema,
  taskContractSchema,
  taskRunSchema,
  type DraftCheck,
  type FieldProvenance,
  type Integration,
  type IntegrationTasksView,
  type TaskContract,
  type TaskContractInput,
  type TaskErrorKind,
  type TaskRun,
} from "../../packages/contracts/integration-task";
import type { ApprovalRecord } from "../../packages/contracts/approval";
import type { ApprovalStore } from "./approval-store";
import type { ConnectorStore } from "./connector-store";
import { callMcpTool, discoverMcpTools, McpTransportError } from "./integration-mcp";

/* ============================================================================
 * Identity and digests
 * ========================================================================== */

export const taskToolId = (integrationId: string, taskId: string) => `int.${integrationId}.${taskId}`;
export const taskToolRef = (c: Pick<TaskContract, "integrationId" | "taskId" | "version">) => `${taskToolId(c.integrationId, c.taskId)}@${c.version}`;

function contractDigestOf(c: TaskContractInputParsed): string {
  const { binding: _binding, ...contract } = c;
  return digestJson(contract as unknown as JsonObject);
}

function bindingDigestOf(c: TaskContractInputParsed, integration: Integration): string {
  return digestJson({ transport: integration.transport, baseUrl: integration.baseUrl, binding: c.binding } as unknown as JsonObject);
}

type TaskContractInputParsed = ReturnType<typeof taskContractInputSchema.parse>;

/* ============================================================================
 * Schema guards (contracts and generated artifacts)
 * ========================================================================== */

const MAX_SCHEMA_BYTES = 24_000;
const MAX_SCHEMA_DEPTH = 12;

function depthOf(value: unknown, depth = 0): number {
  if (depth > MAX_SCHEMA_DEPTH + 1 || value === null || typeof value !== "object") return depth;
  return Math.max(depth, ...Object.values(value as Record<string, unknown>).map((v) => depthOf(v, depth + 1)));
}

/** Size, depth, local-only $ref, closed objects, and compilability with the same validator sfield uses. */
export function schemaIssues(schema: unknown, label: string): string[] {
  const issues: string[] = [];
  const raw = JSON.stringify(schema ?? null);
  if (raw.length > MAX_SCHEMA_BYTES) issues.push(`${label} is larger than ${MAX_SCHEMA_BYTES} bytes`);
  if (depthOf(schema) > MAX_SCHEMA_DEPTH) issues.push(`${label} is nested deeper than ${MAX_SCHEMA_DEPTH} levels`);
  if (/"\$ref"\s*:\s*"(?!#)/.test(raw)) issues.push(`${label} uses a non-local $ref (only "#/..." is allowed)`);
  if (!schema || typeof schema !== "object" || (schema as { type?: unknown }).type !== "object") issues.push(`${label} must be an object schema`);
  if (issues.length) return issues;
  for (const issue of sharedValidator().check(schema, { path: label, requireClosedObjects: true })) {
    issues.push(`${issue.path}: ${issue.message}`);
  }
  return issues;
}

/* ============================================================================
 * Versioning: breaking-change detection and semver enforcement
 * ========================================================================== */

type SchemaLike = { properties?: Record<string, { type?: unknown; enum?: unknown[] }>; required?: string[] };

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function breakingChanges(prev: Pick<TaskContract, "inputSchema" | "outputSchema" | "effect">, next: Pick<TaskContract, "inputSchema" | "outputSchema" | "effect">): string[] {
  const out: string[] = [];
  const pIn = (prev.inputSchema as SchemaLike).properties ?? {};
  const nIn = (next.inputSchema as SchemaLike).properties ?? {};
  const pReq = new Set((prev.inputSchema as SchemaLike).required ?? []);
  for (const field of (next.inputSchema as SchemaLike).required ?? []) {
    if (!pReq.has(field)) out.push(`input adds required field "${field}"`);
  }
  for (const [field, def] of Object.entries(pIn)) {
    const nextDef = nIn[field];
    if (!nextDef) { out.push(`input removes field "${field}"`); continue; }
    if (JSON.stringify(def.type) !== JSON.stringify(nextDef.type)) out.push(`input changes the type of "${field}"`);
    if (Array.isArray(def.enum) && Array.isArray(nextDef.enum) && def.enum.some((v) => !nextDef.enum!.includes(v))) {
      out.push(`input narrows the allowed values of "${field}"`);
    }
  }
  const pOut = (prev.outputSchema as SchemaLike).properties ?? {};
  const nOut = (next.outputSchema as SchemaLike).properties ?? {};
  for (const [field, def] of Object.entries(pOut)) {
    if (!nOut[field]) out.push(`output removes field "${field}"`);
    else if (JSON.stringify(def.type) !== JSON.stringify(nOut[field].type)) out.push(`output changes the type of "${field}"`);
  }
  if (prev.effect !== next.effect) out.push(`effect changes from ${prev.effect} to ${next.effect}`);
  return out;
}

/* ============================================================================
 * Approval policy evaluation
 * ========================================================================== */

export function needsApproval(contract: Pick<TaskContract, "effect" | "approvalPolicy">, input: Record<string, unknown>): boolean {
  if (contract.effect === "destructive") return true;
  if (contract.effect === "read") return false;
  const policy = contract.approvalPolicy;
  if (policy.mode === "none") return false;
  if (policy.mode === "always") return true;
  return policy.when.some(({ field, op, value }) => {
    const actual = input[field];
    switch (op) {
      case "eq": return actual === value;
      case "ne": return actual !== value;
      case "gt": return typeof actual === "number" && typeof value === "number" && actual > value;
      case "gte": return typeof actual === "number" && typeof value === "number" && actual >= value;
      case "lt": return typeof actual === "number" && typeof value === "number" && actual < value;
      case "lte": return typeof actual === "number" && typeof value === "number" && actual <= value;
      case "in": return Array.isArray(value) && value.includes(actual as string | number);
    }
  });
}

/* ============================================================================
 * Transports
 * ========================================================================== */

type TransportResponse = { status: number; body: Record<string, unknown> };
export class TransportTimeout extends Error {}
export class TransportFailure extends Error {
  constructor(message: string, readonly requestSent: boolean) { super(message); }
}

type SandboxHandler = (input: Record<string, unknown>) => Promise<TransportResponse>;

/** Deterministic sandbox systems used by the seeded demo integration and the tests. */
function createSandboxHandlers(orders?: ReturnType<typeof orderSource>): Record<string, SandboxHandler> {
  const tickets = new Map<string, { ticketId: string; status: string }>();
  let seq = 4800;
  return {
    "commerce.lookup_order": async (input) => {
      const order = orders?.(input.orderId, input.memberId);
      return { status: 200, body: order ? { ...order, found: true } : { found: false } };
    },
    "itsm.create_ticket": async (input) => {
      const key = String(input.idempotencyKey ?? "");
      const existing = key ? tickets.get(key) : undefined;
      if (existing) return { status: 200, body: { ...existing, duplicate: true } };
      const title = String(input.title ?? "");
      if (title.includes("[reject]")) return { status: 422, body: { error: "Unknown service" } };
      const ticket = { ticketId: `TCK-${++seq}`, status: "open" };
      if (key) tickets.set(key, ticket);
      // The ticket is created upstream, but the response is lost: the caller cannot know.
      if (title.includes("[timeout]")) throw new TransportTimeout("Upstream did not respond within the timeout");
      if (title.includes("[bad-output]")) return { status: 201, body: { ticket: ticket.ticketId } };
      return { status: 201, body: ticket };
    },
    "itsm.find_ticket": async (input) => {
      const found = tickets.get(String(input.idempotencyKey ?? ""));
      return { status: 200, body: found ? { found: true, ...found } : { found: false } };
    },
    "schema.generate_mapping": async (input) => {
      let sample: unknown;
      try {
        sample = JSON.parse(String(input.sampleJson ?? ""));
      } catch {
        return { status: 400, body: { error: "sampleJson is not valid JSON" } };
      }
      const infer = (value: unknown): Record<string, unknown> => {
        if (Array.isArray(value)) return { type: "array", items: value.length ? infer(value[0]) : {} };
        if (value === null) return { type: "null" };
        if (typeof value === "object") {
          const entries = Object.entries(value as Record<string, unknown>);
          return {
            type: "object",
            additionalProperties: false,
            required: entries.map(([k]) => k),
            properties: Object.fromEntries(entries.map(([k, v]) => [k, infer(v)])),
          };
        }
        return { type: typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value };
      };
      const schema = { title: String(input.entityName ?? "Entity"), ...infer(sample) };
      return { status: 200, body: { entityName: String(input.entityName ?? "Entity"), schema: JSON.stringify(schema) } };
    },
  };
}

async function callHttp(integration: Integration, contract: TaskContract, input: Record<string, unknown>, signal: AbortSignal): Promise<TransportResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = integration.secretRef ? process.env[integration.secretRef] : undefined;
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const timeout = AbortSignal.timeout(integration.timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  let response: Response;
  try {
    response = await fetch(integration.baseUrl.replace(/\/$/, "") + contract.binding.target, {
      method: contract.binding.method,
      headers,
      ...(contract.binding.method === "GET" ? {} : { body: JSON.stringify(input) }),
      signal: combined,
    });
  } catch (err) {
    if (timeout.aborted) throw new TransportTimeout(`No response within ${integration.timeoutMs}ms`);
    const code = (err as { cause?: { code?: string } }).cause?.code;
    // Connection refused / DNS failure: the request was never delivered.
    throw new TransportFailure(err instanceof Error ? err.message : "transport error", !(code === "ECONNREFUSED" || code === "ENOTFOUND"));
  }
  let body: Record<string, unknown> = {};
  try { body = (await response.json()) as Record<string, unknown>; } catch { /* non-JSON body */ }
  return { status: response.status, body };
}

/* ============================================================================
 * One governed call: transport → outcome mapping → output validation → artifact
 * ========================================================================== */

export type TaskCallResult = {
  state: "succeeded" | "succeeded_unverified_output" | "outcome_unknown" | "failed";
  outcome?: { code: string; success: boolean; retryable: boolean; meaning: string };
  error?: { kind: TaskErrorKind; retryable: boolean; message: string };
  output?: unknown;
  artifact?: TaskRun["artifact"];
};

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), value);
}

export class TaskCallExecutor {
  private readonly sandbox;
  constructor(orders?: ReturnType<typeof orderSource>, private readonly connectorStore?: ConnectorStore) { this.sandbox = createSandboxHandlers(orders); }

  async execute(integration: Integration, contract: TaskContract, input: Record<string, unknown>, signal: AbortSignal): Promise<TaskCallResult> {
    const writes = contract.effect !== "read";
    let response: TransportResponse;
    try {
      if (integration.transport === "sandbox") {
        if (contract.binding.target.startsWith("legacy_connector:") && this.connectorStore) {
          const connectorId = contract.binding.target.slice("legacy_connector:".length);
          const exec = await this.connectorStore.invokeConnector(connectorId, {
            action: String(input.action ?? contract.taskId),
            actor: "integration_task",
            payload: input,
          }, signal);
          response = {
            status: exec.statusCode,
            body: { summary: exec.summary, statusCode: exec.statusCode, connectorId: exec.connectorId, sandboxMode: exec.sandbox },
          };
        } else {
          const handler = this.sandbox[contract.binding.target];
          if (!handler) return { state: "failed", error: { kind: "transport", retryable: false, message: `No sandbox handler "${contract.binding.target}"` } };
          response = await handler(input);
        }
      } else if (integration.transport === "mcp") {
        try {
          response = await callMcpTool(integration, contract, input, signal);
        } catch (err) {
          if (err instanceof McpTransportError) {
            if (err.kind === "timeout") throw new TransportTimeout(err.message);
            throw new TransportFailure(err.message, err.kind === "sent");
          }
          throw err;
        }
      } else {
        response = await callHttp(integration, contract, input, signal);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "transport error";
      if (err instanceof TransportTimeout) {
        return writes
          ? { state: "outcome_unknown", error: { kind: "timeout", retryable: false, message: `${message}. The change may have been applied; reconcile before retrying.` } }
          : { state: "failed", error: { kind: "timeout", retryable: true, message } };
      }
      const sent = err instanceof TransportFailure ? err.requestSent : true;
      return writes && sent
        ? { state: "outcome_unknown", error: { kind: "transport", retryable: false, message: `${message}. The request may have reached the system; reconcile before retrying.` } }
        : { state: "failed", error: { kind: "transport", retryable: true, message } };
    }

    const { status, body } = response;
    if (status === 429) return { state: "failed", error: { kind: "rate_limited", retryable: true, message: "Rate limited by the integration" } };
    if (status === 401 || status === 403) return { state: "failed", error: { kind: "auth", retryable: false, message: `Authorization failed (${status})` } };
    if (status >= 500) {
      return writes
        ? { state: "outcome_unknown", error: { kind: "upstream_5xx", retryable: false, message: `Upstream error ${status}; the change may have been applied. Reconcile before retrying.` } }
        : { state: "failed", error: { kind: "upstream_5xx", retryable: true, message: `Upstream error ${status}` } };
    }

    const rule = contract.outcomeMapping.find((r) => r.statusIn.includes(status) && (r.field === undefined || readPath(body, r.field) === r.equals));
    const def = rule ? contract.outcomeCodes.find((c) => c.code === rule.code) : undefined;
    if (!def) {
      return status >= 200 && status < 300 && writes
        ? { state: "succeeded_unverified_output", output: body, error: { kind: "unmapped", retryable: false, message: `HTTP ${status} did not match any outcome rule; the write likely applied. Not retried.` } }
        : { state: "failed", error: { kind: "unmapped", retryable: false, message: `HTTP ${status} did not match any outcome rule` } };
    }
    const outcome = { code: def.code, success: def.success, retryable: def.retryable, meaning: def.meaning };
    if (!def.success) {
      return { state: "failed", outcome, error: { kind: status >= 400 ? "upstream_4xx" : "unknown", retryable: def.retryable, message: def.meaning } };
    }

    const validation = sharedValidator().validate(contract.outputSchema as JsonObject, body);
    if (!validation.ok) {
      const message = `Output did not match the contract: ${validation.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join("; ")}`;
      return writes
        ? { state: "succeeded_unverified_output", outcome, output: body, error: { kind: "validation_output", retryable: false, message: `${message}. The write succeeded upstream; not retried.` } }
        : { state: "failed", outcome, error: { kind: "validation_output", retryable: false, message } };
    }

    const result: TaskCallResult = { state: "succeeded", outcome, output: body };
    if (contract.resultKind === "artifact" && contract.artifact) {
      const content = readPath(body, contract.artifact.contentPath);
      const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
      const errors: string[] = [];
      if (text.length > 32_000) errors.push("artifact is larger than 32KB");
      if (contract.artifact.type === "json_schema" && !errors.length) {
        try {
          errors.push(...schemaIssues(JSON.parse(text), "artifact"));
        } catch {
          errors.push("artifact is not valid JSON");
        }
      }
      // Generated code is review-only: it is size-checked and stored, never evaluated.
      const uiUri = typeof readPath(body, "uiUri") === "string" ? String(readPath(body, "uiUri")) : undefined;
      if (contract.artifact.type === "mcp_app_ui") {
        if (uiUri && !uiUri.startsWith("ui://")) errors.push("MCP App URI must use the ui:// scheme");
        if (!text.trim().startsWith("<")) errors.push("MCP App UI content must be HTML markup");
      }
      result.artifact = {
        type: contract.artifact.type,
        ...(contract.artifact.language ? { language: contract.artifact.language } : {}),
        ...(uiUri ? { uri: uiUri } : {}),
        content: text.slice(0, 32_000),
        digest: digestJson({ text } as JsonObject),
        validation: { ok: errors.length === 0, errors },
      };
    }
    return result;
  }
}

/* ============================================================================
 * Store
 * ========================================================================== */

type Persisted = { integrations: Integration[]; contracts: TaskContract[]; runs: TaskRun[] };

export class IntegrationTaskStore {
  private readonly filePath: string;
  private state: Persisted;

  readonly orders: ReturnType<typeof orderSource>;
  constructor(dataDir: string) {
    this.orders = orderSource(dataDir);
    this.filePath = join(dataDir, "integration-tasks.json");
    this.state = this.load();
    if (this.state.integrations.length === 0) this.seed();
    if (!this.integration("commerce_sandbox")) {
      this.upsertIntegration({ id: "commerce_sandbox", name: "Order fulfillment", transport: "sandbox" });
      this.publish(this.upsertDraft(customerOrderTask).ref);
    }
  }

  private load(): Persisted {
    if (existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<Persisted>;
        return {
          integrations: (raw.integrations ?? []).flatMap((i) => { const r = integrationSchema.safeParse(i); return r.success ? [r.data] : []; }),
          contracts: (raw.contracts ?? []).flatMap((c) => { const r = taskContractSchema.safeParse(c); return r.success ? [r.data] : []; }),
          runs: (raw.runs ?? []).flatMap((c) => { const r = taskRunSchema.safeParse(c); return r.success ? [r.data] : []; }),
        };
      } catch { /* fall through to empty */ }
    }
    return { integrations: [], contracts: [], runs: [] };
  }

  private save() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  view(registeredRefs: ReadonlySet<string>, dispatchAvailable = false): IntegrationTasksView {
    return {
      integrations: this.state.integrations,
      contracts: this.state.contracts.map((c) => {
        const sfieldRegistered = registeredRefs.has(c.ref);
        const sfieldRoute = sfieldRegistered ? "dedicated" as const
          : c.status === "published" && dispatchAvailable ? "dispatcher" as const : "unavailable" as const;
        return { ...c, sfieldRegistered, sfieldRoute };
      }),
      runs: this.state.runs.slice(0, 50),
    };
  }

  integration(id: string) { return this.state.integrations.find((i) => i.id === id); }
  contract(ref: string) { return this.state.contracts.find((c) => c.ref === ref); }
  published() { return this.state.contracts.filter((c) => c.status === "published"); }
  latestPublished(integrationId: string, taskId: string) {
    return this.published()
      .filter((c) => c.integrationId === integrationId && c.taskId === taskId)
      .sort((a, b) => compareSemver(b.version, a.version))[0];
  }

  upsertIntegration(raw: unknown): Integration {
    const integration = integrationSchema.parse(raw);
    if (integration.transport !== "sandbox") {
      let url: URL | null = null;
      try { url = new URL(integration.baseUrl); } catch { /* invalid */ }
      const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && local))) {
        throw new IntegrationTaskError("invalid_integration", `${integration.transport} integrations need an https:// URL (http:// only for localhost).`);
      }
    }
    // Where calls go is part of every published version's binding digest: it cannot change underneath them.
    const before = this.integration(integration.id);
    if (before && (before.transport !== integration.transport || before.baseUrl !== integration.baseUrl)
      && this.state.contracts.some((c) => c.integrationId === integration.id && c.status !== "draft")) {
      throw new IntegrationTaskError("integration_in_use", `${integration.id} has published tasks, so its transport and URL are fixed. Create a new integration for a different endpoint.`);
    }
    this.state.integrations = [integration, ...this.state.integrations.filter((i) => i.id !== integration.id)];
    this.save();
    return integration;
  }

  /** Creates or edits a draft. Published versions are immutable; change them by drafting a new version. */
  private contractIssues(input: TaskContractInputParsed): string[] {
    const issues = [...schemaIssues(input.inputSchema, "inputSchema"), ...schemaIssues(input.outputSchema, "outputSchema")];
    if (input.effect === "read" && input.approvalPolicy.mode !== "none") issues.push("read tasks cannot require approval (they have no side effects)");
    if (input.effect !== "read" && !input.idempotency.supported && input.reconcileTaskId === undefined && input.manualReconcile !== true) {
      issues.push("write tasks need an idempotency key, a reconcile task, or an explicit manual-reconcile acknowledgement so uncertain outcomes can be resolved");
    }
    if (input.idempotency.supported && !input.idempotency.keyField) issues.push("idempotency is on but no key field is chosen");
    if (input.idempotency.supported && input.idempotency.keyField
      && !((input.inputSchema as SchemaLike).properties ?? {})[input.idempotency.keyField]) {
      issues.push(`idempotency key field "${input.idempotency.keyField}" is not in the input schema`);
    }
    const props = (input.inputSchema as SchemaLike).properties ?? {};
    for (const cond of input.approvalPolicy.when) if (!props[cond.field]) issues.push(`approval condition uses "${cond.field}", which is not an input field`);
    if (input.approvalPolicy.mode === "conditional" && input.approvalPolicy.when.length === 0) issues.push("conditional approval needs at least one condition");
    if (input.resourceIdField && !props[input.resourceIdField]) issues.push(`resource field "${input.resourceIdField}" is not an input field`);
    const binding = input.customerExperience;
    if (binding) {
      const out = (input.outputSchema as SchemaLike).properties ?? {};
      if (input.effect !== "read" || input.resultKind !== "data" || input.approvalPolicy.mode !== "none") issues.push("Customer chat requires an ungated read returning data.");
      if (!input.resourceIdField || input.resourceIdField === binding.memberField || [binding.memberField, input.resourceIdField].some((k) => props[k]?.type !== "string" || out[k]?.type !== "string")) issues.push("Input and output must declare distinct string record and member ID fields.");
      if (((input.inputSchema as SchemaLike).required ?? []).some((k) => k !== binding.memberField && k !== input.resourceIdField)) issues.push("Chat supplies only the member ID and record ID.");
      for (const { key } of binding.fields) if (key === binding.memberField || !["string", "boolean", "number", "integer"].includes(String(out[key]?.type))) issues.push("Choose a public scalar output field: " + key);
      if (binding.watch && !binding.fields.some((f) => f.key === binding.watch!.field)) issues.push("Watch a displayed field.");
    }
    const codes = new Set(input.outcomeCodes.map((c) => c.code));
    for (const rule of input.outcomeMapping) if (!codes.has(rule.code)) issues.push(`mapping references undeclared outcome code ${rule.code}`);
    if (!input.outcomeCodes.some((c) => c.success)) issues.push("declare at least one success outcome code");
    if (input.resultKind === "artifact" && !input.artifact) issues.push("artifact tasks must declare artifact.type and artifact.contentPath");
    return issues;
  }

  /** Every version of one task, newest first. */
  allVersions(integrationId: string, taskId: string) {
    return this.state.contracts.filter((c) => c.integrationId === integrationId && c.taskId === taskId)
      .sort((a, b) => compareSemver(b.version, a.version));
  }

  drafts() { return this.state.contracts.filter((c) => c.status === "draft"); }

  digestOf(raw: TaskContractInput): string | undefined {
    const parsed = taskContractInputSchema.safeParse(raw);
    return parsed.success ? contractDigestOf(parsed.data) : undefined;
  }

  /** Dry run of saving and publishing a draft: same guards, nothing stored. */
  validateDraft(raw: unknown): DraftCheck {
    const parsed = taskContractInputSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, issues: parsed.error.issues.slice(0, 12).map((i) => `${i.path.join(".") || "draft"}: ${i.message}`), breaking: [], publishBlockers: [] };
    }
    const input = parsed.data;
    const ref = taskToolRef(input);
    const issues = this.contractIssues(input);
    if (!this.integration(input.integrationId)) issues.unshift(`integration "${input.integrationId}" does not exist`);
    const existing = this.contract(ref);
    if (existing && existing.status !== "draft") issues.push(`${ref} is already ${existing.status}; use a newer version`);
    const previous = this.latestPublished(input.integrationId, input.taskId);
    const publishBlockers: string[] = [];
    let breaking: string[] = [];
    if (previous && previous.ref !== ref) {
      if (compareSemver(input.version, previous.version) <= 0) publishBlockers.push(`version ${input.version} must be newer than published ${previous.version}`);
      breaking = breakingChanges(previous, input as unknown as TaskContract);
      if (breaking.length && Number(input.version.split(".")[0]) <= Number(previous.version.split(".")[0])) {
        publishBlockers.push(`breaking changes need a major version (e.g. ${Number(previous.version.split(".")[0]) + 1}.0.0)`);
      }
    }
    if (input.reconcileTaskId) {
      const reconcile = this.latestPublished(input.integrationId, input.reconcileTaskId);
      if (!reconcile || reconcile.effect !== "read") publishBlockers.push(`reconcile task "${input.reconcileTaskId}" must be a published read task`);
    }
    return { ok: issues.length === 0, ref, issues, breaking, publishBlockers, ...(previous && previous.ref !== ref ? { previousVersion: previous.version } : {}) };
  }

  upsertDraft(raw: TaskContractInput | unknown): TaskContract {
    const input = taskContractInputSchema.parse(raw);
    const integration = this.integration(input.integrationId);
    if (!integration) throw new IntegrationTaskError("integration_not_found", `Integration "${input.integrationId}" does not exist.`);
    const issues = this.contractIssues(input);
    if (issues.length) throw new IntegrationTaskError("invalid_contract", issues.join("; "));

    const ref = taskToolRef(input);
    const existing = this.contract(ref);
    if (existing && existing.status !== "draft") {
      throw new IntegrationTaskError("version_immutable", `${ref} is ${existing.status}. Draft a new version instead.`);
    }
    const now = new Date().toISOString();
    const contract: TaskContract = {
      ...input,
      ref,
      status: "draft",
      contractDigest: contractDigestOf(input),
      bindingDigest: bindingDigestOf(input, integration),
      updatedAt: now,
    };
    this.state.contracts = [contract, ...this.state.contracts.filter((c) => c.ref !== ref)];
    this.save();
    return contract;
  }

  /** Publishes a draft. Breaking changes against the latest published version require a major version bump. */
  /** Deletes a draft contract. Published and deprecated versions are immutable and cannot be deleted. */
  deleteDraft(ref: string): { deleted: boolean; ref: string } {
    const existing = this.contract(ref);
    if (!existing) throw new IntegrationTaskError("contract_not_found", `${ref} not found.`);
    if (existing.status !== "draft") {
      throw new IntegrationTaskError("version_immutable", `${ref} is ${existing.status} and cannot be deleted. Published versions are immutable.`);
    }
    this.state.contracts = this.state.contracts.filter((c) => c.ref !== ref);
    this.save();
    return { deleted: true, ref };
  }

  /** Deletes an integration only if it has zero published/deprecated tasks (drafts are removed with it). */
  deleteIntegration(id: string): { deleted: boolean; id: string; removedDrafts: number } {
    const existing = this.integration(id);
    if (!existing) throw new IntegrationTaskError("integration_not_found", `Integration "${id}" not found.`);
    if (this.state.contracts.some((c) => c.integrationId === id && c.status !== "draft")) {
      throw new IntegrationTaskError("integration_in_use", `Integration "${id}" has published tasks and cannot be deleted.`);
    }
    const removedDrafts = this.state.contracts.filter((c) => c.integrationId === id).length;
    this.state.contracts = this.state.contracts.filter((c) => c.integrationId !== id);
    this.state.integrations = this.state.integrations.filter((i) => i.id !== id);
    this.save();
    return { deleted: true, id, removedDrafts };
  }

  publish(ref: string): { contract: TaskContract; breaking: string[] } {
    const draft = this.contract(ref);
    if (!draft) throw new IntegrationTaskError("contract_not_found", `${ref} not found.`);
    if (draft.status !== "draft") throw new IntegrationTaskError("not_a_draft", `${ref} is already ${draft.status}.`);
    const previous = this.latestPublished(draft.integrationId, draft.taskId);
    let breaking: string[] = [];
    if (previous) {
      if (compareSemver(draft.version, previous.version) <= 0) {
        throw new IntegrationTaskError("version_not_newer", `${draft.version} must be newer than published ${previous.version}.`);
      }
      breaking = breakingChanges(previous, draft);
      if (breaking.length && Number(draft.version.split(".")[0]) <= Number(previous.version.split(".")[0])) {
        throw new IntegrationTaskError("major_bump_required", `Breaking changes need a major version bump: ${breaking.join("; ")}`);
      }
    }
    if (draft.reconcileTaskId) {
      const reconcile = this.latestPublished(draft.integrationId, draft.reconcileTaskId);
      if (!reconcile || reconcile.effect !== "read") {
        throw new IntegrationTaskError("reconcile_task_invalid", `Reconcile task "${draft.reconcileTaskId}" must be a published read task.`);
      }
    }
    const published: TaskContract = { ...draft, status: "published", publishedAt: new Date().toISOString() };
    this.state.contracts = this.state.contracts.map((c) => (c.ref === ref ? published : c));
    this.save();
    return { contract: published, breaking };
  }

  saveRun(run: TaskRun): TaskRun {
    const parsed = taskRunSchema.parse({ ...run, updatedAt: new Date().toISOString() });
    this.state.runs = [parsed, ...this.state.runs.filter((r) => r.runId !== parsed.runId)].slice(0, 200);
    this.save();
    return parsed;
  }

  run(runId: string) { return this.state.runs.find((r) => r.runId === runId); }
  runByApproval(approvalId: string) { return this.state.runs.find((r) => r.approvalId === approvalId); }

  private seed() {
    const now = new Date().toISOString();
    this.state.integrations = [integrationSchema.parse({
      id: "itsm_sandbox",
      name: "ITSM Sandbox",
      description: "Sandbox service-management system for demonstrating governed tasks, approvals, reconciliation, and artifacts.",
      transport: "sandbox",
    })];
    this.save();
    const seeds: TaskContractInput[] = [
      {
        integrationId: "itsm_sandbox", taskId: "find_ticket", version: "1.0.0",
        description: "Look up a ticket by the idempotency key it was created with. Used to reconcile uncertain creates.",
        effect: "read",
        inputSchema: { type: "object", additionalProperties: false, required: ["idempotencyKey"], properties: { idempotencyKey: { type: "string", minLength: 1, maxLength: 80 } } },
        outputSchema: { type: "object", additionalProperties: false, required: ["found"], properties: { found: { type: "boolean" }, ticketId: { type: "string" }, status: { type: "string" } } },
        outcomeCodes: [
          { code: "FOUND", meaning: "Ticket exists", success: true },
          { code: "NOT_FOUND", meaning: "No ticket for this key", success: true },
        ],
        outcomeMapping: [
          { statusIn: [200], field: "found", equals: true, code: "FOUND" },
          { statusIn: [200], field: "found", equals: false, code: "NOT_FOUND" },
        ],
        approvalPolicy: { mode: "none", when: [], dualControl: false, expiresInMinutes: 30 },
        idempotency: { supported: false },
        binding: { target: "itsm.find_ticket", method: "GET" },
      },
      {
        integrationId: "itsm_sandbox", taskId: "create_ticket", version: "1.0.0",
        description: "Create a service ticket. P1 tickets page on-call staff, so they require approval.",
        effect: "write",
        inputSchema: {
          type: "object", additionalProperties: false, required: ["title", "priority", "service"],
          properties: {
            title: { type: "string", minLength: 3, maxLength: 160 },
            priority: { type: "string", enum: ["P1", "P2", "P3", "P4"] },
            service: { type: "string", minLength: 2, maxLength: 64 },
            idempotencyKey: { type: "string", maxLength: 80 },
          },
        },
        outputSchema: {
          type: "object", additionalProperties: false, required: ["ticketId", "status"],
          properties: { ticketId: { type: "string" }, status: { type: "string" }, duplicate: { type: "boolean" } },
        },
        outcomeCodes: [
          { code: "CREATED", meaning: "Ticket created", success: true },
          { code: "DUPLICATE", meaning: "A ticket already exists for this idempotency key", success: true },
          { code: "REJECTED", meaning: "The system rejected the ticket", success: false },
        ],
        outcomeMapping: [
          { statusIn: [201], code: "CREATED" },
          { statusIn: [200], field: "duplicate", equals: true, code: "DUPLICATE" },
          { statusIn: [400, 422], code: "REJECTED" },
        ],
        approvalPolicy: { mode: "conditional", when: [{ field: "priority", op: "eq", value: "P1" }], dualControl: false, expiresInMinutes: 30 },
        idempotency: { supported: true, keyField: "idempotencyKey" },
        reconcileTaskId: "find_ticket",
        resourceIdField: "service",
        binding: { target: "itsm.create_ticket", method: "POST" },
      },
      {
        integrationId: "itsm_sandbox", taskId: "generate_mapping_schema", version: "1.0.0",
        description: "Generate a JSON Schema from a sample payload. Returns a schema artifact for review; it is never applied automatically.",
        effect: "read",
        resultKind: "artifact",
        artifact: { type: "json_schema", language: "json", contentPath: "schema" },
        inputSchema: {
          type: "object", additionalProperties: false, required: ["entityName", "sampleJson"],
          properties: { entityName: { type: "string", minLength: 1, maxLength: 64 }, sampleJson: { type: "string", minLength: 2, maxLength: 8000 } },
        },
        outputSchema: {
          type: "object", additionalProperties: false, required: ["entityName", "schema"],
          properties: { entityName: { type: "string" }, schema: { type: "string" } },
        },
        outcomeCodes: [
          { code: "GENERATED", meaning: "Schema generated", success: true },
          { code: "INVALID_SAMPLE", meaning: "The sample is not valid JSON", success: false },
        ],
        outcomeMapping: [{ statusIn: [200], code: "GENERATED" }, { statusIn: [400], code: "INVALID_SAMPLE" }],
        approvalPolicy: { mode: "none", when: [], dualControl: false, expiresInMinutes: 30 },
        idempotency: { supported: false },
        binding: { target: "schema.generate_mapping", method: "POST" },
      },
    ];
    for (const seed of seeds) this.publish(this.upsertDraft(seed).ref);
    void now;
  }
}

export class IntegrationTaskError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/* ============================================================================
 * Service: request → (sfield native approval) → execute → TaskRun; resume; reconcile
 * ========================================================================== */

/** What the service needs from the sfield runtime. Implemented by Runtime. */
type ExecOutcome =
  | { kind: "result"; result: ToolResult; sfieldRunId: string }
  | { kind: "pending"; sfieldApprovalId: string; callId: string; sfieldRunId: string };

export interface IntegrationTaskRuntime {
  registeredIntegrationTools(): ReadonlySet<string>;
  dispatcherRef(effect: "read" | "write" | "destructive"): string;
  executeIntegrationTask(principalId: string, sfieldToolRef: string, toolInputs: JsonObject, gated: boolean): Promise<ExecOutcome>;
  registerPublishedTask(contract: TaskContract): Promise<{ route: "dedicated" | "dispatcher"; reason?: string }>;
  resumeIntegrationTask(
    call: { sfieldApprovalId: string; sfieldRunId: string; callId: string; sfieldToolRef: string; toolInputs: JsonObject },
    approver: string, decision: "approve" | "deny", principalId: string,
  ): Promise<{ kind: "result"; result: ToolResult; sfieldRunId: string; resumed: boolean } | { kind: "denied"; resumed: boolean }>;
}

type ApprovalPayload = {
  runId?: string; taskRef?: string; sfieldToolRef?: string; contractDigest?: string; bindingDigest?: string;
  input?: Record<string, unknown>; toolInputs?: JsonObject; sfieldApprovalId?: string;
};

export class IntegrationTaskService {
  constructor(
    private readonly store: IntegrationTaskStore,
    private readonly approvals: ApprovalStore,
    private readonly runtime: () => IntegrationTaskRuntime | null,
  ) {}

  view() {
    const runtime = this.runtime();
    return this.store.view(runtime?.registeredIntegrationTools() ?? new Set(), runtime !== null);
  }

  customerReads() {
    return this.store.published().filter((c) => c.customerExperience && c.effect === "read" && c.approvalPolicy.mode === "none"
      && this.store.integration(c.integrationId)?.enabled && this.store.latestPublished(c.integrationId, c.taskId)?.ref === c.ref);
  }

  async customerRead(principal: string, mid: string, ref: string, id: string) {
    const contract = this.customerReads().find((c) => c.ref === ref);
    if (!contract?.customerExperience || !contract.resourceIdField) return;
    const binding = contract.customerExperience;
    const key = contract.resourceIdField;
    const { run } = await this.run(principal, { toolRef: ref, requestedBy: principal,
      input: { [key]: id, [binding.memberField]: mid }, provenance: { [key]: "user_confirmed", [binding.memberField]: "system_resolved" } });
    const output = run.output as Record<string, unknown> | undefined;
    if (run.state !== "succeeded" || !run.outcome?.success || !output || output[key] !== id || output[binding.memberField] !== mid) return;
    const fields = binding.fields.flatMap(({ key, label }) => Object.hasOwn(output, key) && ["string", "number", "boolean"].includes(typeof output[key])
      ? [{ label, value: String(output[key]).slice(0, 90) }] : []);
    if (!fields.length) return;
    const watchValue = binding.watch && Object.hasOwn(output, binding.watch.field) ? String(output[binding.watch.field]) : undefined;
    return { fields, watchValue, runId: run.runId, sfieldRunId: run.sfieldRunId, sfieldCallId: run.sfieldCallId };
  }

  /** Dedicated tool if the version was registered at startup; otherwise the effect's dispatcher (no restart needed). */
  private route(runtime: IntegrationTaskRuntime, contract: TaskContract, input: Record<string, unknown>, approvalId?: string) {
    if (runtime.registeredIntegrationTools().has(contract.ref)) {
      return { sfieldToolRef: contract.ref, toolInputs: { input, ...(approvalId ? { approvalId } : {}) } as unknown as JsonObject };
    }
    return {
      sfieldToolRef: runtime.dispatcherRef(contract.effect),
      toolInputs: {
        taskRef: contract.ref, contractDigest: contract.contractDigest, bindingDigest: contract.bindingDigest,
        inputJson: JSON.stringify(input), ...(approvalId ? { approvalId } : {}),
      } as JsonObject,
    };
  }

  async run(principalId: string, req: { toolRef: string; input: Record<string, unknown>; requestedBy: string; provenance?: Record<string, FieldProvenance> }) {
    const runtime = this.runtime();
    if (!runtime) throw new IntegrationTaskError("sfield_runtime_required", "Integration tasks only run through the sfield runtime; configure a model gateway.");
    const contract = this.store.contract(req.toolRef);
    if (!contract || contract.status !== "published") throw new IntegrationTaskError("contract_not_published", `${req.toolRef} is not a published task.`);
    const integration = this.store.integration(contract.integrationId);
    if (!integration?.enabled) throw new IntegrationTaskError("integration_disabled", `Integration "${contract.integrationId}" is disabled.`);

    // Fill the idempotency key before approval, so the approved request and any retry carry the same key.
    const input = { ...req.input };
    const keyField = contract.idempotency.supported ? contract.idempotency.keyField : undefined;
    if (keyField && typeof input[keyField] !== "string") input[keyField] = `idem_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const gated = needsApproval(contract, input);
    // The approval id is part of the tool input, so sfield's digest-bound approval and our record name each other.
    const approvalId = gated ? `apr_${randomUUID().replaceAll("-", "").slice(0, 20)}` : undefined;
    const { sfieldToolRef, toolInputs } = this.route(runtime, contract, input, approvalId);
    const now = new Date().toISOString();
    let run: TaskRun = this.store.saveRun({
      runId: `trun_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      toolRef: contract.ref,
      integrationId: contract.integrationId,
      taskId: contract.taskId,
      version: contract.version,
      bindingDigest: contract.bindingDigest,
      state: "executing",
      requestedBy: req.requestedBy,
      input,
      provenance: req.provenance ?? {},
      ...(keyField ? { idempotencyKey: String(input[keyField]) } : {}),
      createdAt: now,
      updatedAt: now,
    });

    let exec: ExecOutcome;
    try {
      exec = await runtime.executeIntegrationTask(principalId, sfieldToolRef, toolInputs, gated);
    } catch (err) {
      // sfield rejected before dispatch (input validation, policy). Nothing was sent to the integration.
      const code = (err as { code?: string }).code ?? "UNKNOWN";
      const kind: TaskErrorKind = code === "INVALID_INPUT" ? "validation_input"
        : code.startsWith("APPROVAL") || code === "ACCESS_DENIED" || code === "TOOL_DENIED" ? "policy_denied" : "unknown";
      run = this.store.saveRun({ ...run, state: "failed", error: { kind, retryable: false, message: `${code}: ${err instanceof Error ? err.message : "rejected"}`.slice(0, 400) } });
      return { run };
    }
    if (exec.kind === "pending") {
      const modelProposed = Object.entries(run.provenance).filter(([, p]) => p === "model_proposed").map(([f]) => f);
      const approval = this.approvals.createPending({
        id: approvalId,
        targetKind: "integration_task",
        sfieldToolRef,
        domain: "integration",
        recordId: run.runId,
        action: contract.taskId,
        title: `${integration.name} · ${contract.taskId} v${contract.version}`.slice(0, 120),
        summary: `${contract.description} Approval is bound to this exact task version, binding and input, and survives a server restart.`.slice(0, 400),
        riskLevel: contract.effect === "destructive" ? "high" : "medium",
        payload: {
          runId: run.runId, taskRef: contract.ref, sfieldToolRef, contractDigest: contract.contractDigest,
          bindingDigest: contract.bindingDigest, input, toolInputs,
          sfieldApprovalId: exec.sfieldApprovalId, sfieldCallId: exec.callId, sfieldRunId: exec.sfieldRunId,
        },
        details: [
          { label: "Task", value: contract.ref.slice(0, 160) },
          { label: "Effect", value: contract.effect },
          { label: "Route", value: sfieldToolRef === contract.ref ? "dedicated sfield tool" : `sfield dispatcher ${sfieldToolRef}` },
          ...Object.entries(input).slice(0, 4).map(([k, v]) => ({
            label: `Input · ${k}`.slice(0, 64),
            value: `${String(typeof v === "string" ? v : JSON.stringify(v)).slice(0, 140)}${run.provenance[k] ? ` (${run.provenance[k]})` : ""}`.slice(0, 160),
          })),
          ...(modelProposed.length ? [{ label: "Model-proposed fields", value: modelProposed.join(", ").slice(0, 160) }] : []),
        ].slice(0, 8),
        requester: req.requestedBy,
        dualControl: contract.approvalPolicy.dualControl || contract.effect === "destructive",
        ttlMs: contract.approvalPolicy.expiresInMinutes * 60_000,
      });
      run = this.store.saveRun({
        ...run, state: "pending_approval", approvalId: approval.id,
        sfieldApprovalId: exec.sfieldApprovalId, sfieldCallId: exec.callId, sfieldRunId: exec.sfieldRunId,
      });
      return { run, approval };
    }
    run = this.store.saveRun(this.applyResult(run, exec.result, exec.sfieldRunId));
    return { run };
  }

  /* ---------------- authoring (used by the chat copilot and the authoring routes) ---------------- */

  validateDraft(raw: unknown) { return this.store.validateDraft(raw); }
  integration(id: string) { return this.store.integration(id); }
  allVersions(integrationId: string, taskId: string) { return this.store.allVersions(integrationId, taskId); }

  async discoverMcp(integrationId: string) {
    const integration = this.store.integration(integrationId);
    if (!integration) throw new IntegrationTaskError("integration_not_found", `Integration "${integrationId}" does not exist.`);
    try {
      return { integrationId, candidates: await discoverMcpTools(integration, this.store) };
    } catch (err) {
      throw new IntegrationTaskError("mcp_discovery_failed", `Could not list tools from ${integration.baseUrl || integrationId}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400));
    }
  }

  /** Publishes a draft and, when possible, registers it as a dedicated sfield tool right away (no restart). */
  async publish(ref: string) {
    const published = this.store.publish(ref);
    const runtime = this.runtime();
    const registration = runtime ? await runtime.registerPublishedTask(published.contract) : { route: "unavailable" as const, reason: "sfield runtime not configured" };
    return { ...published, sfieldRegistered: registration.route === "dedicated", sfieldRoute: registration.route, ...(registration.reason ? { registrationNote: registration.reason } : {}) };
  }

  /**
   * Called after our approval store approved (and enforced dual control). Claims the record (execute-once), then
   * decides sfield's own digest-bound approval and continues the exact waiting call. After a restart, sfield resumes
   * the original execution scope by id, so the approval the human decided is the one sfield checks at dispatch.
   * The tool handler additionally requires this record to be claimed and to match version, binding and input.
   */
  async resume(record: ApprovalRecord, principalId = "cep-operator") {
    const run = this.store.runByApproval(record.id);
    if (!run || run.state !== "pending_approval") throw new IntegrationTaskError("run_not_found", `No pending task run for approval ${record.id}.`);
    const payload = record.payload as ApprovalPayload;
    const runtime = this.runtime();
    if (!runtime) throw new IntegrationTaskError("sfield_runtime_required", "The sfield runtime is not available.");
    const contract = this.store.contract(run.toolRef);
    if (!contract || contract.status !== "published" || contract.contractDigest !== payload.contractDigest || contract.bindingDigest !== payload.bindingDigest) {
      this.store.saveRun({ ...run, state: "failed", error: { kind: "policy_denied", retryable: false, message: "The task definition changed after approval was requested. Request it again." } });
      throw new IntegrationTaskError("definition_changed", `${run.toolRef} changed after approval was requested.`);
    }
    const call = this.pendingCall(run, payload);
    if (!call) throw new IntegrationTaskError("approval_payload_incomplete", `Approval ${record.id} predates resumable approvals; request the task again.`);
    const claim = this.approvals.claimForExecution(record.id);
    if (!claim.ok) throw new IntegrationTaskError(claim.code, claim.message);
    const approver = record.decidedBy ?? record.requester;
    let out: Awaited<ReturnType<IntegrationTaskRuntime["resumeIntegrationTask"]>>;
    try {
      out = await runtime.resumeIntegrationTask(call, approver, "approve", principalId);
    } catch (err) {
      // Rejected before dispatch: release the claim so the approval can be retried.
      this.approvals.releaseClaim(record.id);
      const code = (err as { code?: string }).code ?? "";
      if (code === "OWNERSHIP_UNAVAILABLE") {
        throw new IntegrationTaskError("retry_shortly", "The previous server instance still holds this call's lease (it did not shut down cleanly). Approve again in about 30 seconds.");
      }
      if (code === "NOT_FOUND" || code === "STATE_UNAVAILABLE" || code === "APPROVAL_EXPIRED" || code === "APPROVAL_DENIED") {
        this.store.saveRun({ ...run, state: "expired", error: { kind: "policy_denied", retryable: true, message: `The waiting sfield call can no longer run (${code}). Request the task again.` } });
        throw new IntegrationTaskError("approval_context_expired", `The waiting sfield call can no longer run (${code}). Request the task again.`);
      }
      throw err;
    }
    if (out.kind === "denied") {
      this.approvals.releaseClaim(record.id);
      throw new IntegrationTaskError("approval_denied", "sfield denied the approval.");
    }
    const finished = this.store.saveRun(this.applyResult({ ...run, state: "executing" }, out.result, out.sfieldRunId));
    const summary = `${finished.toolRef} → ${finished.state}${finished.outcome ? ` (${finished.outcome.code})` : ""}${finished.error ? `: ${finished.error.message}` : ""}${out.resumed ? " [resumed after restart]" : ""}`.slice(0, 320);
    const approval = this.approvals.markExecuted(record.id, { summary, sfieldRunId: out.sfieldRunId }) ?? record;
    return { approval, run: finished, execution: { summary, sfieldRunId: out.sfieldRunId, resumed: out.resumed } };
  }

  async deny(record: ApprovalRecord, principalId = "cep-operator") {
    const run = this.store.runByApproval(record.id);
    if (!run) return;
    const call = this.pendingCall(run, record.payload as ApprovalPayload);
    if (call) {
      await this.runtime()?.resumeIntegrationTask(call, record.decidedBy ?? "approver", "deny", principalId).catch(() => undefined);
    }
    this.store.saveRun({ ...run, state: "denied", error: { kind: "policy_denied", retryable: false, message: `Denied by ${record.decidedBy ?? "approver"}${record.comment ? `: ${record.comment}` : ""}` } });
  }

  private pendingCall(run: TaskRun, payload: ApprovalPayload) {
    if (!run.sfieldApprovalId || !run.sfieldRunId || !run.sfieldCallId || !payload.sfieldToolRef || !payload.toolInputs) return null;
    return { sfieldApprovalId: run.sfieldApprovalId, sfieldRunId: run.sfieldRunId, callId: run.sfieldCallId, sfieldToolRef: payload.sfieldToolRef, toolInputs: payload.toolInputs };
  }

  /** Resolves an `outcome_unknown` write by calling the contract's read-only reconcile task with the same idempotency key. */
  async reconcile(principalId: string, runId: string) {
    const run = this.store.run(runId);
    if (!run) throw new IntegrationTaskError("run_not_found", `Run ${runId} not found.`);
    if (run.state !== "outcome_unknown") throw new IntegrationTaskError("not_unknown", `Run ${runId} is ${run.state}; only outcome_unknown runs can be reconciled.`);
    const contract = this.store.contract(run.toolRef);
    const keyField = contract?.idempotency.keyField;
    if (!contract?.reconcileTaskId || !keyField || !run.idempotencyKey) {
      throw new IntegrationTaskError("no_reconcile_path", `${run.toolRef} has no reconcile task with an idempotency key; resolve it manually.`);
    }
    const reconcile = this.store.latestPublished(contract.integrationId, contract.reconcileTaskId);
    if (!reconcile) throw new IntegrationTaskError("reconcile_task_missing", `Reconcile task ${contract.reconcileTaskId} is not published.`);
    const check = await this.run(principalId, { toolRef: reconcile.ref, input: { [keyField]: run.idempotencyKey }, requestedBy: "reconciler" });
    const found = check.run.state === "succeeded" && (check.run.output as { found?: unknown } | undefined)?.found === true;
    const resolved = this.store.saveRun({
      ...run,
      state: found ? "succeeded" : "failed",
      reconciledFrom: check.run.runId,
      ...(found
        ? { outcome: { code: "RECONCILED_APPLIED", success: true, retryable: false, meaning: "Reconciled: the change was applied" }, output: check.run.output, error: undefined }
        : { error: { kind: "transport" as const, retryable: true, message: "Reconciled: the change was not applied. Safe to retry with the same idempotency key." } }),
    });
    return { run: resolved, reconcileRun: check.run };
  }

  private applyResult(run: TaskRun, result: ToolResult, sfieldRunId: string): TaskRun {
    const base = { ...run, sfieldRunId, sfieldCallId: result.callId };
    if (result.status === "succeeded") {
      const env = (result.output ?? {}) as { state?: string; outcomeCode?: string; success?: boolean; retryable?: boolean; message?: string; outputJson?: string; artifactJson?: string };
      const contract = this.store.contract(run.toolRef);
      const def = contract?.outcomeCodes.find((c) => c.code === env.outcomeCode);
      const parse = (text?: string) => { try { return text ? JSON.parse(text) : undefined; } catch { return undefined; } };
      return {
        ...base,
        state: env.state === "succeeded_unverified_output" ? "succeeded_unverified_output" : "succeeded",
        ...(env.outcomeCode && env.outcomeCode !== "UNMAPPED"
          ? { outcome: { code: env.outcomeCode, success: env.success ?? true, retryable: env.retryable ?? false, meaning: def?.meaning ?? env.outcomeCode } }
          : {}),
        output: parse(env.outputJson),
        ...(env.artifactJson ? { artifact: parse(env.artifactJson) } : {}),
        ...(env.state === "succeeded_unverified_output" ? { error: { kind: "validation_output" as const, retryable: false, message: env.message ?? "Output did not match the contract" } } : {}),
      };
    }
    // Failed or unknown: the handler encodes its classification as JSON in the ToolError message.
    let detail: { outcome?: TaskRun["outcome"]; error?: TaskRun["error"] } = {};
    try { detail = JSON.parse(result.error?.message ?? "{}"); } catch { /* sfield-level error */ }
    const sfieldCode = result.error?.code ?? "UNKNOWN";
    const kind: TaskErrorKind = detail.error?.kind
      ?? (sfieldCode === "INVALID_INPUT" ? "validation_input" : sfieldCode.startsWith("APPROVAL") || sfieldCode === "TOOL_DENIED" ? "policy_denied" : "unknown");
    return {
      ...base,
      state: result.status === "outcome_unknown" ? "outcome_unknown" : "failed",
      ...(detail.outcome ? { outcome: detail.outcome } : {}),
      error: detail.error ?? { kind, retryable: false, message: `${sfieldCode}: ${result.error?.message ?? "failed"}`.slice(0, 400) },
    };
  }
}
