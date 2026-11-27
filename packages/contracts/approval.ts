import { z } from "zod";

export const approvalRiskLevelSchema = z.enum(["low", "medium", "high"]);
export const approvalStatusSchema = z.enum(["pending", "approved", "executing", "denied", "executed", "expired"]);
export const approvalTargetKindSchema = z.enum(["domain_write", "external_connector", "stock_trade", "workflow_step", "pzn_change", "integration_task", "task_publish", "publication"]);
export const approvalDomainSchema = z.enum(["ops_incident", "sales_deal", "customer360", "external_connector", "stock_trade", "workflow", "pzn_self_service", "integration", "publication"]);
export const pznDualControlModeSchema = z.enum(["off", "high_risk", "always"]);
export type PznDualControlMode = z.infer<typeof pznDualControlModeSchema>;

export const approvalDetailSchema = z.object({
  label: z.string().trim().min(1).max(64),
  value: z.string().trim().min(1).max(160),
}).strict();

export const approvalExecutionResultSchema = z.object({
  summary: z.string().trim().min(1).max(320),
  sfieldRunId: z.string().trim().min(1).max(80),
  auditId: z.string().trim().max(80).optional(),
  jobId: z.string().trim().max(80).optional(),
  statusCode: z.number().int().optional(),
  responsePreview: z.string().max(600).optional(),
}).strict();

export const approvalRecordSchema = z.object({
  id: z.string().trim().min(1).max(64),
  status: approvalStatusSchema,
  riskLevel: approvalRiskLevelSchema,
  targetKind: approvalTargetKindSchema,
  sfieldToolRef: z.string().trim().min(1).max(80),
  domain: approvalDomainSchema,
  recordId: z.string().trim().min(1).max(64),
  action: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(400),
  payloadDigest: z.string().trim().min(16).max(128),
  payload: z.record(z.string(), z.unknown()),
  details: z.array(approvalDetailSchema).min(1).max(8),
  requester: z.string().trim().min(1).max(80),
  dualControl: z.boolean(),
  createdAt: z.string().trim().min(1).max(64),
  expiresAt: z.string().trim().min(1).max(64),
  decidedBy: z.string().trim().max(80).optional(),
  decidedAt: z.string().trim().max(64).optional(),
  comment: z.string().trim().max(240).optional(),
  executionResult: approvalExecutionResultSchema.optional(),
}).strict();

export const approvalPolicySettingsSchema = z.object({
  gateHighRiskOpsRollbacks: z.boolean().default(true),
  gateHighRiskSalesDiscounts: z.boolean().default(true),
  gateExternalConnectorWrites: z.boolean().default(true),
  gateHighRiskTrades: z.boolean().default(true),
  highRiskTradeThresholdUsd: z.number().int().min(1000).max(1_000_000).default(10_000),
  defaultDualControl: z.boolean().default(false),
  gatePznPublish: z.boolean().default(true),
  gatePznDestructive: z.boolean().default(true),
  gatePznDictionaryChanges: z.boolean().default(false),
  pznDualControl: pznDualControlModeSchema.default("high_risk"),
  pznApprovalExpiryMinutes: z.number().int().min(5).max(1440).default(30),
  requireEvalBeforePublish: z.boolean().default(false),
  gateTaskPublish: z.boolean().default(true),
}).strict();

export const approvalDecisionInputSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  actor: z.string().trim().min(1).max(80),
  comment: z.string().trim().max(240).optional(),
}).strict();

export type ApprovalRiskLevel = z.infer<typeof approvalRiskLevelSchema>;
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;
export type ApprovalTargetKind = z.infer<typeof approvalTargetKindSchema>;
export type ApprovalDomain = z.infer<typeof approvalDomainSchema>;
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;
export type ApprovalPolicySettings = z.infer<typeof approvalPolicySettingsSchema>;
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionInputSchema>;

export type PublicationReview = { status: "pending_approval"; approval: ApprovalRecord };

export interface ApprovalsView {
  policy: ApprovalPolicySettings;
  approvals: ApprovalRecord[];
  pendingCount: number;
}
