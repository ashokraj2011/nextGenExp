import { z } from "zod";

/**
 * Integration → Task model.
 * An Integration is a connection to an external system. It exposes versioned Tasks.
 * A Task contract (schemas, effect, outcomes, approval policy) is immutable once published;
 * the binding (how input maps to the real call) is a separate, digested object.
 */

export const slugSchema = z.string().trim().regex(/^[a-z][a-z0-9_]{1,47}$/, "lowercase letters, digits, underscore");
export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/, "semver x.y.z");

export const taskEffectSchema = z.enum(["read", "write", "destructive"]);
export const taskResultKindSchema = z.enum(["data", "code", "artifact"]);
export const taskTransportSchema = z.enum(["sandbox", "http", "mcp"]);
export const taskExecutionModeSchema = z.enum(["sync", "async"]);

/** Run lifecycle. `outcome_unknown` and `succeeded_unverified_output` exist so uncertain writes are never retried blindly; `accepted` tracks async jobs. */
export const taskRunStateSchema = z.enum([
  "pending_approval",
  "executing",
  "accepted",
  "succeeded",
  "succeeded_unverified_output",
  "outcome_unknown",
  "failed",
  "denied",
  "expired",
]);

/** Platform/transport error taxonomy — separate from the task's business outcome codes. */
export const taskErrorKindSchema = z.enum([
  "transport",
  "timeout",
  "auth",
  "rate_limited",
  "circuit_open",
  "validation_input",
  "validation_output",
  "policy_denied",
  "upstream_4xx",
  "upstream_5xx",
  "unmapped",
  "unknown",
]);

export const integrationRateLimitSchema = z.object({
  requestsPerMinute: z.number().int().min(1).max(60_000),
  burst: z.number().int().min(1).max(1_000).optional(),
}).strict();

export const integrationCircuitBreakerSchema = z.object({
  failureThreshold: z.number().int().min(1).max(50).default(5),
  resetTimeoutMs: z.number().int().min(500).max(600_000).default(30_000),
}).strict();

export const taskAsyncConfigSchema = z.object({
  /** Published read task on the same integration used to poll an accepted async job. */
  statusTaskId: slugSchema.optional(),
  /** Dotted path in the 202 response body holding the external job id (defaults to "jobId"). */
  jobIdPath: z.string().trim().min(1).max(64).default("jobId"),
  /** Env var name holding the HMAC-SHA256 secret for signed completion webhooks. */
  callbackSecretRef: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional(),
  pollIntervalMs: z.number().int().min(500).max(300_000).default(5_000),
}).strict();

const jsonSchemaObject = z.record(z.string(), z.unknown());

export const integrationSchema = z.object({
  id: slugSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(240).default(""),
  transport: taskTransportSchema,
  baseUrl: z.string().trim().max(320).default(""),
  /** Reference to a secret (env var name), never the secret itself. */
  secretRef: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional(),
  timeoutMs: z.number().int().min(200).max(30_000).default(5_000),
  enabled: z.boolean().default(true),
  rateLimit: integrationRateLimitSchema.optional(),
  circuitBreaker: integrationCircuitBreakerSchema.optional(),
}).strict();

export const outcomeCodeSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),
  meaning: z.string().trim().min(1).max(160),
  success: z.boolean(),
  retryable: z.boolean().default(false),
}).strict();

/** Explicit response → outcome-code rules. First match wins; no match = `unmapped` error, never a silent success. */
export const outcomeMappingSchema = z.object({
  statusIn: z.array(z.number().int().min(100).max(599)).min(1).max(10),
  field: z.string().max(64).optional(),
  equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),
}).strict();

export const approvalConditionSchema = z.object({
  field: z.string().min(1).max(64),
  op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "in"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
}).strict();

export const taskApprovalPolicySchema = z.object({
  /** none: never; always: every call; conditional: when any condition matches the input. Destructive tasks always require approval. */
  mode: z.enum(["none", "always", "conditional"]),
  when: z.array(approvalConditionSchema).max(8).default([]),
  dualControl: z.boolean().default(false),
  expiresInMinutes: z.number().int().min(5).max(1440).default(30),
}).strict();

export const taskIdempotencySchema = z.object({
  supported: z.boolean(),
  /** Input field that carries the idempotency key. The engine fills it before approval so retries reuse it. */
  keyField: z.string().max(64).optional(),
}).strict();

const slugField = () => z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,47}$/);

export const taskContractInputSchema = z.object({
  integrationId: slugSchema,
  taskId: slugSchema,
  version: semverSchema,
  description: z.string().trim().min(1).max(400),
  effect: taskEffectSchema,
  inputSchema: jsonSchemaObject,
  outputSchema: jsonSchemaObject,
  resultKind: taskResultKindSchema.default("data"),
  artifact: z.object({
    type: z.enum(["json_schema", "code", "mcp_app_ui"]),
    language: z.string().max(24).optional(),
    /** Dotted path in the output that holds the artifact content (string). */
    contentPath: z.string().max(64),
  }).strict().optional(),
  outcomeCodes: z.array(outcomeCodeSchema).min(1).max(24),
  outcomeMapping: z.array(outcomeMappingSchema).min(1).max(24),
  approvalPolicy: taskApprovalPolicySchema,
  idempotency: taskIdempotencySchema,
  /** Read task of the same integration used to resolve `outcome_unknown` (looked up by idempotency key). */
  reconcileTaskId: slugSchema.optional(),
  /** Explicit acknowledgement for writes with neither an idempotency key nor a reconcile task: an operator checks uncertain outcomes by hand. */
  manualReconcile: z.boolean().optional(),
  /** Input field naming the business entity the call acts on (sfield resource). */
  resourceIdField: z.string().max(64).optional(),
  /** sync: single round-trip; async: returns 202 Accepted and completes via status polling or signed callback webhook. */
  executionMode: taskExecutionModeSchema.default("sync"),
  asyncConfig: taskAsyncConfigSchema.optional(),
  customerExperience: z.object({
    topic: z.string().trim().regex(/^[a-zA-Z][a-zA-Z -]{1,39}$/), idPrefix: z.string().regex(/^[A-Z]{2,12}$/),
    memberField: slugField(), fields: z.array(z.object({ key: slugField(), label: z.string().trim().min(1).max(48) }).strict()).min(1).max(4),
    watch: z.object({ field: slugField(), value: z.string().trim().min(1).max(50) }).strict().optional(),
  }).strict().optional(),
  binding: z.object({
    /** sandbox: handler name; http: path appended to integration.baseUrl; mcp: the MCP tool name. */
    target: z.string().trim().min(1).max(200),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  }).strict(),
}).strict();

export const taskContractSchema = taskContractInputSchema.extend({
  ref: z.string(),
  status: z.enum(["draft", "published", "deprecated"]),
  contractDigest: z.string(),
  bindingDigest: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string().optional(),
}).strict();

export const fieldProvenanceSchema = z.enum(["user_entered", "user_confirmed", "model_proposed", "system_resolved"]);

export const taskRunSchema = z.object({
  runId: z.string(),
  toolRef: z.string(),
  integrationId: z.string(),
  taskId: z.string(),
  version: z.string(),
  bindingDigest: z.string(),
  state: taskRunStateSchema,
  requestedBy: z.string(),
  input: z.record(z.string(), z.unknown()),
  provenance: z.record(z.string(), fieldProvenanceSchema).default({}),
  idempotencyKey: z.string().optional(),
  approvalId: z.string().optional(),
  sfieldApprovalId: z.string().optional(),
  sfieldRunId: z.string().optional(),
  sfieldCallId: z.string().optional(),
  outcome: z.object({ code: z.string(), success: z.boolean(), retryable: z.boolean(), meaning: z.string() }).optional(),
  error: z.object({ kind: taskErrorKindSchema, retryable: z.boolean(), message: z.string() }).optional(),
  output: z.unknown().optional(),
  artifact: z.object({
    type: z.string(),
    language: z.string().optional(),
    uri: z.string().optional(),
    content: z.string(),
    digest: z.string(),
    validation: z.object({ ok: z.boolean(), errors: z.array(z.string()) }),
  }).optional(),
  reconciledFrom: z.string().optional(),
  externalJobId: z.string().optional(),
  callbackToken: z.string().optional(),
  lastPolledAt: z.string().optional(),
  pollAttempts: z.number().int().min(0).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

export type IntegrationResilienceSnapshot = {
  integrationId: string;
  circuitState: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  failureThreshold: number;
  resetTimeoutMs: number;
  openedAt?: string;
  nextAttemptAt?: string;
  rateLimit?: {
    requestsPerMinute: number;
    burst: number;
    tokensRemaining: number;
  };
  rejectedRateLimitCount: number;
  rejectedCircuitCount: number;
};

export type Integration = z.infer<typeof integrationSchema>;
export type TaskContractInput = z.input<typeof taskContractInputSchema>;
export type TaskContract = z.infer<typeof taskContractSchema>;
export type TaskRun = z.infer<typeof taskRunSchema>;
export type TaskEffect = z.infer<typeof taskEffectSchema>;
export type TaskRunState = z.infer<typeof taskRunStateSchema>;
export type TaskErrorKind = z.infer<typeof taskErrorKindSchema>;
export type FieldProvenance = z.infer<typeof fieldProvenanceSchema>;

/** The closed envelope every task tool returns to sfield. Task output travels as JSON text so sfield's output schema stays fixed. */
export const taskEnvelopeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["state", "outcomeCode", "success", "retryable", "message", "outputJson"],
  properties: {
    state: { type: "string", enum: ["succeeded", "succeeded_unverified_output", "outcome_unknown", "accepted"] },
    outcomeCode: { type: "string", maxLength: 40 },
    success: { type: "boolean" },
    retryable: { type: "boolean" },
    message: { type: "string", maxLength: 400 },
    outputJson: { type: "string", maxLength: 40000 },
    artifactJson: { type: "string", maxLength: 40000 },
    externalJobId: { type: "string", maxLength: 160 },
  },
} as const;

export const runTaskRequestSchema = z.object({
  toolRef: z.string().min(3).max(120),
  input: z.record(z.string(), z.unknown()),
  requestedBy: z.string().trim().min(1).max(80).default("CEP Operator"),
  provenance: z.record(z.string(), fieldProvenanceSchema).optional(),
}).strict();

/** How a published version reaches sfield: its own tool (registered at startup) or an effect-specific dispatcher. */
export type ViewContract = TaskContract & { sfieldRegistered: boolean; sfieldRoute: "dedicated" | "dispatcher" | "unavailable" };

export type IntegrationTasksView = {
  integrations: Integration[];
  contracts: ViewContract[];
  runs: TaskRun[];
  resilience?: Record<string, IntegrationResilienceSnapshot>;
};

/* ============================================================================
 * Integrations chat (copilot) contracts
 * ========================================================================== */

export const draftValidateRequestSchema = z.object({ draft: z.record(z.string(), z.unknown()) }).strict();
export const integrationMcpDiscoverRequestSchema = z.object({ integrationId: slugSchema }).strict();

export const integrationCopilotRequestSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(1500) }).strict()).max(12).optional(),
}).strict();
export type IntegrationCopilotRequest = z.infer<typeof integrationCopilotRequestSchema>;

export type IntegrationCopilotCard =
  | { kind: "catalog"; view: IntegrationTasksView }
  | { kind: "contract"; contract: ViewContract }
  /** Writes are never run from chat text: the model prefills a form, a person confirms it. */
  | { kind: "task_form"; contract: ViewContract; prefill: Record<string, unknown>; provenance: Record<string, FieldProvenance> }
  | { kind: "task_run"; run: TaskRun; approvalId?: string }
  | { kind: "runs"; runs: TaskRun[]; filter?: string }
  | { kind: "approvals" }
  /** Authoring: everything below is saved or published only by an explicit click on the card. */
  | { kind: "integration_form"; prefill: Partial<Integration>; existing: boolean }
  | { kind: "task_draft"; draft: TaskContractInput; check: DraftCheck; origin: DraftOrigin; note?: string }
  | { kind: "mcp_import"; integrationId: string; candidates: McpImportCandidate[]; error?: string }
  | { kind: "publish_review"; contract: ViewContract; check: DraftCheck }
  | { kind: "drafts"; drafts: ViewContract[] };

/** Where an editable draft came from (shown to the author so model-written contracts get reviewed). */
export type DraftOrigin = "assistant" | "template" | "new_version" | "existing_draft" | "mcp_import";

/** Dry-run validation of a draft: the same guards as saving and publishing, without saving. */
export type DraftCheck = {
  ok: boolean;
  ref?: string;
  issues: string[];
  /** Breaking changes against the latest published version of the same task. */
  breaking: string[];
  previousVersion?: string;
  /** Publishing would be refused (e.g. a breaking change without a major bump). */
  publishBlockers: string[];
};

export type McpImportCandidate = {
  toolName: string;
  description: string;
  draft: TaskContractInput;
  check: DraftCheck;
  /** What the importer tightened or assumed (closed schemas, effect from annotations, default approval). */
  notes: string[];
  alreadyImported: boolean;
};

export type IntegrationCopilotResponse = {
  reply: string;
  generatedBy: "copilot_llm" | "deterministic";
  cards: IntegrationCopilotCard[];
  suggestedPrompts: string[];
  actions: { tool: string; summary: string; status: "ok" | "error" | "pending" }[];
};
