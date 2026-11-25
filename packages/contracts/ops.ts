import { z } from "zod";

export const incidentSeveritySchema = z.enum(["P1", "P2", "P3"]);
export const incidentStatusSchema = z.enum(["open", "mitigating", "rolled_back", "resolved", "escalated"]);
export const rollbackStatusSchema = z.enum(["pending", "approved", "rejected", "not_applicable"]);

export const incidentTimelineEventSchema = z.object({
  time: z.string().trim().min(1).max(36),
  title: z.string().trim().min(1).max(80),
  detail: z.string().trim().max(180).optional(),
  owner: z.string().trim().max(48).optional(),
  status: z.enum(["done", "active", "pending", "blocked"]),
}).strict();

export const incidentRecordSchema = z.object({
  id: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(120),
  severity: incidentSeveritySchema,
  status: incidentStatusSchema,
  service: z.string().trim().min(1).max(80),
  environment: z.string().trim().min(1).max(60),
  errorRatePct: z.number().min(0).max(100),
  baselineErrorRatePct: z.number().min(0).max(100),
  p95LatencyMs: z.number().min(0),
  affectedUsers: z.number().int().min(0),
  currentRelease: z.string().trim().min(1).max(40),
  previousRelease: z.string().trim().min(1).max(40),
  slaMinutes: z.number().int().min(1),
  owner: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(400),
  rollbackStatus: rollbackStatusSchema,
  rollbackNote: z.string().trim().max(240).optional(),
  timeline: z.array(incidentTimelineEventSchema).min(1).max(12),
  updatedAt: z.string().trim().min(1).max(64),
}).strict();

export const incidentDecisionInputSchema = z.object({
  decision: z.enum(["approve_rollback", "reject_rollback", "resolve", "escalate"]),
  actor: z.string().trim().max(80).optional(),
  note: z.string().trim().max(240).optional(),
}).strict();

export const incidentUpsertInputSchema = z.object({
  id: z.string().trim().min(2).max(40).optional(),
  title: z.string().trim().min(1).max(120),
  severity: incidentSeveritySchema,
  status: incidentStatusSchema,
  service: z.string().trim().min(1).max(80),
  environment: z.string().trim().min(1).max(60),
  errorRatePct: z.number().min(0).max(100),
  baselineErrorRatePct: z.number().min(0).max(100).default(0.2),
  p95LatencyMs: z.number().min(0),
  affectedUsers: z.number().int().min(0).default(0),
  currentRelease: z.string().trim().min(1).max(40),
  previousRelease: z.string().trim().min(1).max(40),
  slaMinutes: z.number().int().min(1).default(30),
  owner: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(400),
  rollbackStatus: rollbackStatusSchema.default("pending"),
}).strict();

export type IncidentRecord = z.infer<typeof incidentRecordSchema>;
export type IncidentTimelineEvent = z.infer<typeof incidentTimelineEventSchema>;
export type IncidentDecisionInput = z.infer<typeof incidentDecisionInputSchema>;
export type IncidentUpsertInput = z.infer<typeof incidentUpsertInputSchema>;

export interface OpsSummary {
  totalOpen: number;
  activeP1Count: number;
  pendingRollbacks: number;
  highestErrorRatePct: number;
  sourceLabel: string;
}

export interface OpsIncidentsView {
  summary: OpsSummary;
  incidents: IncidentRecord[];
}
