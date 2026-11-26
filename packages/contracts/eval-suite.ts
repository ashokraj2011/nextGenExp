import { z } from "zod";
import type { ApprovalPolicySettings, ApprovalRecord } from "./approval";
import type { DomainWriteAuditEntry } from "./api";
import type { OmnichannelDelivery } from "./omnichannel";
import type { WorkflowRun } from "./workflow-definition";

export const evalCategorySchema = z.enum([
  "routing",
  "compliance_hitl",
  "adversarial",
  "financial_grounding",
  "workflow_engine",
  "a2ui_schema",
  "copilot_authoring",
]);
export type EvalCategory = z.infer<typeof evalCategorySchema>;

export const evalCaseResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: evalCategorySchema,
  severity: z.enum(["critical", "high", "medium"]),
  prompt: z.string(),
  expected: z.string(),
  actual: z.string(),
  passed: z.boolean(),
  durationMs: z.number().nonnegative(),
  details: z.string(),
});
export type EvalCaseResult = z.infer<typeof evalCaseResultSchema>;

export const evalCategorySummarySchema = z.object({
  category: evalCategorySchema,
  label: z.string(),
  passed: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  passRatePct: z.number().min(0).max(100),
});
export type EvalCategorySummary = z.infer<typeof evalCategorySummarySchema>;

export const evalRunReportSchema = z.object({
  runId: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number().nonnegative(),
  mode: z.enum(["deterministic", "live_llm"]),
  modelLabel: z.string(),
  totalCases: z.number().int().positive(),
  passedCases: z.number().int().nonnegative(),
  failedCases: z.number().int().nonnegative(),
  passRatePct: z.number().min(0).max(100),
  criticalFailures: z.number().int().nonnegative(),
  releaseGate: z.enum(["ready_to_publish", "blocked"]),
  reportDigest: z.string(),
  categorySummary: z.array(evalCategorySummarySchema),
  results: z.array(evalCaseResultSchema),
});
export type EvalRunReport = z.infer<typeof evalRunReportSchema>;

export interface EvalSuiteView {
  runs: EvalRunReport[];
  latest: EvalRunReport | null;
}

export interface ComplianceAuditPacket {
  packetId: string;
  generatedAt: string;
  platform: string;
  packetDigest: string;
  summary: {
    totalApprovals: number;
    pendingApprovals: number;
    executedApprovals: number;
    deniedApprovals: number;
    governedWrites: number;
    omnichannelDeliveries: number;
    workflowRuns: number;
    latestEvalPassRatePct: number | null;
    latestReleaseGate: "ready_to_publish" | "blocked" | "not_run";
  };
  approvalPolicy: ApprovalPolicySettings;
  approvals: ApprovalRecord[];
  writeAudit: DomainWriteAuditEntry[];
  omnichannelDeliveries: OmnichannelDelivery[];
  recentWorkflowRuns: WorkflowRun[];
  latestEvalRun: EvalRunReport | null;
}
