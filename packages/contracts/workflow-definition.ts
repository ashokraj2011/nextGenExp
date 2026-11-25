import { z } from "zod";
import { recommendationDomainSchema } from "./recommendation-provider";

export const workflowConditionOpSchema = z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "truthy", "falsy", "contains"]);
export type WorkflowConditionOp = z.infer<typeof workflowConditionOpSchema>;

export const workflowConditionSchema = z.object({
  field: z.string().trim().min(1).max(64),
  op: workflowConditionOpSchema,
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
}).strict();
export type WorkflowCondition = z.infer<typeof workflowConditionSchema>;

export const workflowFieldSchema = z.object({
  id: z.string().trim().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/),
  label: z.string().trim().min(1).max(64),
  type: z.enum(["text", "number", "currency", "select", "checkbox"]),
  required: z.boolean().optional(),
  placeholder: z.string().trim().max(80).optional(),
  options: z.array(z.string().trim().min(1).max(56)).max(10).optional(),
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
}).strict();
export type WorkflowField = z.infer<typeof workflowFieldSchema>;

const baseStep = {
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,47}$/),
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(220).optional(),
  when: workflowConditionSchema.optional(),
};

export const collectInputStepSchema = z.object({
  ...baseStep,
  type: z.literal("collect_input"),
  submitLabel: z.string().trim().min(1).max(40).default("Continue"),
  fields: z.array(workflowFieldSchema).min(1).max(8),
}).strict();

export const computeStepSchema = z.object({
  ...baseStep,
  type: z.literal("compute"),
  evaluator: z.enum(["ofac_velocity_screen", "loan_underwriting", "template_summary"]),
  outputTemplate: z.string().trim().min(1).max(400),
}).strict();

export const hitlApprovalStepSchema = z.object({
  ...baseStep,
  type: z.literal("hitl_approval"),
  riskLevel: z.enum(["low", "medium", "high"]).default("high"),
  dualControl: z.boolean().default(false),
  approvalTitleTemplate: z.string().trim().min(1).max(120),
  approvalSummaryTemplate: z.string().trim().min(1).max(320),
  approveLabel: z.string().trim().min(1).max(40).default("Approve & Continue"),
  rejectLabel: z.string().trim().min(1).max(40).default("Reject & Abort"),
}).strict();

export const connectorCallStepSchema = z.object({
  ...baseStep,
  type: z.literal("connector_call"),
  connectorId: z.string().trim().min(1).max(64),
  action: z.string().trim().min(1).max(64),
  noteTemplate: z.string().trim().max(240).optional(),
}).strict();

export const asyncJobStepSchema = z.object({
  ...baseStep,
  type: z.literal("async_job"),
  durationSeconds: z.number().int().min(2).max(15).default(4),
  cancellable: z.boolean().default(true),
  runningLabel: z.string().trim().min(1).max(120),
  completedTemplate: z.string().trim().min(1).max(260),
}).strict();

export const emitHostEventStepSchema = z.object({
  ...baseStep,
  type: z.literal("emit_host_event"),
  eventName: z.string().trim().min(1).max(64).default("cep:workflow_completed"),
  messageTemplate: z.string().trim().min(1).max(240),
}).strict();

export const workflowStepSchema = z.discriminatedUnion("type", [
  collectInputStepSchema,
  computeStepSchema,
  hitlApprovalStepSchema,
  connectorCallStepSchema,
  asyncJobStepSchema,
  emitHostEventStepSchema,
]);
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

export const workflowDefinitionSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,47}$/),
  name: z.string().trim().min(1).max(80),
  domain: recommendationDomainSchema,
  version: z.string().trim().min(1).max(20).default("1.0.0"),
  description: z.string().trim().min(1).max(260),
  triggerPhrases: z.array(z.string().trim().min(3).max(120)).min(1).max(10),
  steps: z.array(workflowStepSchema).min(1).max(12),
  enabled: z.boolean().default(true),
  isBuiltIn: z.boolean().optional(),
  updatedAt: z.string().trim().min(1).max(64),
}).strict();
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export const workflowDefinitionUpsertSchema = workflowDefinitionSchema.omit({
  updatedAt: true,
  isBuiltIn: true,
});
export type WorkflowDefinitionUpsertInput = z.input<typeof workflowDefinitionUpsertSchema>;

export const workflowStepRunStatusSchema = z.enum([
  "pending",
  "active",
  "waiting_input",
  "waiting_approval",
  "running_job",
  "completed",
  "skipped",
  "failed",
  "cancelled",
]);
export type WorkflowStepRunStatus = z.infer<typeof workflowStepRunStatusSchema>;

export const workflowStepRunSchema = z.object({
  stepId: z.string(),
  title: z.string(),
  type: z.enum(["collect_input", "compute", "hitl_approval", "connector_call", "async_job", "emit_host_event"]),
  status: workflowStepRunStatusSchema,
  summary: z.string().optional(),
  approvalId: z.string().optional(),
  payloadDigest: z.string().optional(),
  dualControl: z.boolean().optional(),
  jobStartedAt: z.string().optional(),
  jobEndsAt: z.string().optional(),
  durationSeconds: z.number().int().optional(),
  emittedEvent: z.object({
    eventName: z.string(),
    payload: z.record(z.string(), z.unknown()),
  }).optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});
export type WorkflowStepRun = z.infer<typeof workflowStepRunSchema>;

export const workflowRunStatusSchema = z.enum([
  "waiting_input",
  "waiting_approval",
  "running_job",
  "completed",
  "cancelled",
  "failed",
]);
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;

export const workflowRunSchema = z.object({
  runId: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  workflowVersion: z.string(),
  domain: recommendationDomainSchema,
  personaId: z.string(),
  actorName: z.string(),
  conversationId: z.string().optional(),
  status: workflowRunStatusSchema,
  currentStepIndex: z.number().int().nonnegative(),
  inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  computed: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  steps: z.array(workflowStepRunSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

export interface WorkflowsAdminView {
  definitions: WorkflowDefinition[];
  recentRuns: WorkflowRun[];
}
