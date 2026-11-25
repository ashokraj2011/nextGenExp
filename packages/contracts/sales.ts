import { z } from "zod";

export const dealStageSchema = z.enum(["Discovery", "Proposal", "Security Review", "Negotiation", "Commit", "Closed Won"]);
export const discountStatusSchema = z.enum(["pending", "approved", "rejected", "none"]);

export const dealTimelineEventSchema = z.object({
  time: z.string().trim().min(1).max(36),
  title: z.string().trim().min(1).max(80),
  detail: z.string().trim().max(180).optional(),
  owner: z.string().trim().max(48).optional(),
  status: z.enum(["done", "active", "pending", "blocked"]),
}).strict();

export const dealRecordSchema = z.object({
  id: z.string().trim().min(1).max(40),
  accountName: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(120),
  stage: dealStageSchema,
  arrUsd: z.number().int().min(0),
  discountPct: z.number().min(0).max(60),
  discountStatus: discountStatusSchema,
  discountNote: z.string().trim().max(240).optional(),
  winProbabilityPct: z.number().int().min(0).max(100),
  closeDate: z.string().trim().min(1).max(32),
  owner: z.string().trim().min(1).max(80),
  segment: z.string().trim().min(1).max(48),
  summary: z.string().trim().min(1).max(400),
  timeline: z.array(dealTimelineEventSchema).min(1).max(12),
  updatedAt: z.string().trim().min(1).max(64),
}).strict();

export const dealDecisionInputSchema = z.object({
  decision: z.enum(["approve_discount", "reject_discount", "advance_stage"]),
  actor: z.string().trim().max(80).optional(),
  note: z.string().trim().max(240).optional(),
}).strict();

export type DealRecord = z.infer<typeof dealRecordSchema>;
export type DealTimelineEvent = z.infer<typeof dealTimelineEventSchema>;
export type DealDecisionInput = z.infer<typeof dealDecisionInputSchema>;

export interface SalesSummary {
  totalPipelineUsd: number;
  weightedForecastUsd: number;
  pendingApprovals: number;
  activeDeals: number;
  sourceLabel: string;
}

export interface SalesDealsView {
  summary: SalesSummary;
  deals: DealRecord[];
}
