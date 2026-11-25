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
export const taskTransportSchema = z.enum(["sandbox", "http"]);

/** Run lifecycle. `outcome_unknown` and `succeeded_unverified_output` exist so uncertain writes are never retried blindly. */
export const taskRunStateSchema = z.enum([
  "pending_approval",
  "executing",
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
  "validation_input",
  "validation_output",
  "policy_denied",
  "upstream_4xx",
  "upstream_5xx",
  "unmapped",
  "unknown",
]);

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
    type: z.enum(["json_schema", "code"]),
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
  /** Input field naming the business entity the call acts on (sfield resource). */
  resourceIdField: z.string().max(64).optional(),
  binding: z.object({
    /** sandbox: handler name; http: path appended to integration.baseUrl. */
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
    content: z.string(),
    digest: z.string(),
    validation: z.object({ ok: z.boolean(), errors: z.array(z.string()) }),
  }).optional(),
  reconciledFrom: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

export type Integration = z.infer<typeof integrationSchema>;
export type TaskContractInput = z.input<typeof taskContractInputSchema>;
export type TaskContract = z.infer<typeof taskContractSchema>;
export type TaskRun = z.infer<typeof taskRunSchema>;
export type TaskRunState = z.infer<typeof taskRunStateSchema>;
export type TaskErrorKind = z.infer<typeof taskErrorKindSchema>;
export type FieldProvenance = z.infer<typeof fieldProvenanceSchema>;

/** The closed envelope every task tool returns to sfield. Task output travels as JSON text so sfield's output schema stays fixed. */
export const taskEnvelopeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["state", "outcomeCode", "success", "retryable", "message", "outputJson"],
  properties: {
    state: { type: "string", enum: ["succeeded", "succeeded_unverified_output", "outcome_unknown"] },
    outcomeCode: { type: "string", maxLength: 40 },
    success: { type: "boolean" },
    retryable: { type: "boolean" },
    message: { type: "string", maxLength: 400 },
    outputJson: { type: "string", maxLength: 40000 },
    artifactJson: { type: "string", maxLength: 40000 },
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
};

/* ============================================================================
 * Integrations chat (copilot) contracts
 * ========================================================================== */

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
  | { kind: "approvals" };

export type IntegrationCopilotResponse = {
  reply: string;
  generatedBy: "copilot_llm" | "deterministic";
  cards: IntegrationCopilotCard[];
  suggestedPrompts: string[];
  actions: { tool: string; summary: string; status: "ok" | "error" | "pending" }[];
};
