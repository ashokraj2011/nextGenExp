import { z } from "zod";
import { recommendationDomainSchema } from "./recommendation-provider";

export const scheduledJobKindSchema = z.enum([
  "tax_harvest_scan",
  "idle_cash_sweep",
  "p1_slo_monitor",
  "deal_risk_audit",
]);
export type ScheduledJobKind = z.infer<typeof scheduledJobKindSchema>;

export const scheduledJobSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,47}$/),
  name: z.string().trim().min(2).max(90),
  domain: recommendationDomainSchema,
  kind: scheduledJobKindSchema,
  scheduleLabel: z.string().trim().min(2).max(48),
  intervalMinutes: z.number().int().min(1).max(10_080).default(60),
  personaId: z.string().trim().min(1).max(64).default("demo-learner"),
  thresholdUsd: z.number().nonnegative().optional(),
  enabled: z.boolean().default(true),
  autoPushProactive: z.boolean().default(true),
  deliveryPrincipal: z.string().optional(),
  lastRunAt: z.string().optional(),
  lastStatus: z.enum(["alert_pushed", "no_action", "error"]).optional(),
  lastSummary: z.string().optional(),
  runCount: z.number().int().nonnegative().default(0),
}).strict();
export type ScheduledJob = z.infer<typeof scheduledJobSchema>;

export const scheduledJobUpsertSchema = scheduledJobSchema.omit({
  deliveryPrincipal: true,
  lastRunAt: true,
  lastStatus: true,
  lastSummary: true,
  runCount: true,
});
export type ScheduledJobUpsertInput = z.input<typeof scheduledJobUpsertSchema>;

export const scheduledJobExecutionSchema = z.object({
  executionId: z.string(),
  jobId: z.string(),
  jobName: z.string(),
  domain: recommendationDomainSchema,
  triggeredBy: z.enum(["scheduler", "manual"]),
  ranAt: z.string(),
  status: z.enum(["alert_pushed", "no_action", "error"]),
  summary: z.string(),
  metricValue: z.string(),
  alertId: z.string().optional(),
});
export type ScheduledJobExecution = z.infer<typeof scheduledJobExecutionSchema>;

export interface ScheduledJobsView {
  jobs: ScheduledJob[];
  executions: ScheduledJobExecution[];
}
