import { z } from "zod";
import { recommendationDomainSchema } from "./recommendation-provider";

export const handoffStatusSchema = z.enum(["queued", "claimed", "resolved"]);
export type HandoffStatus = z.infer<typeof handoffStatusSchema>;

export const handoffPrioritySchema = z.enum(["normal", "high", "urgent"]);
export type HandoffPriority = z.infer<typeof handoffPrioritySchema>;

export const handoffNoteSchema = z.object({
  id: z.string(),
  author: z.string().trim().min(1).max(80),
  role: z.enum(["customer", "agent", "system"]),
  text: z.string().trim().min(1).max(2000),
  createdAt: z.string(),
}).strict();
export type HandoffNote = z.infer<typeof handoffNoteSchema>;

export const coBrowseSlidersSchema = z.object({
  monthlyContributionUsd: z.number().min(0).max(50_000).default(1500),
  horizonMonths: z.number().int().min(6).max(360).default(24),
  expectedReturnPct: z.number().min(0).max(15).default(6.5),
  equityAllocationPct: z.number().int().min(0).max(100).default(65),
}).strict();
export type CoBrowseSliders = z.infer<typeof coBrowseSlidersSchema>;

export const advisorProposalSchema = z.object({
  id: z.string(),
  title: z.string().trim().min(2).max(120),
  summary: z.string().trim().min(2).max(400),
  actionLabel: z.string().trim().min(2).max(60).default("Review & Sign"),
  updates: z.record(z.string(), z.string()),
  proposedBy: z.string().trim().min(1).max(80),
  status: z.enum(["pending", "accepted", "declined"]),
  auditId: z.string().optional(),
  createdAt: z.string(),
  decidedAt: z.string().optional(),
}).strict();
export type AdvisorProposal = z.infer<typeof advisorProposalSchema>;

export const sharedCardSchema = z.object({
  id: z.string(),
  turnId: z.string().optional(),
  prompt: z.string().trim().min(1).max(600),
  sharedBy: z.enum(["advisor", "customer"]),
  sharedByName: z.string().trim().min(1).max(80),
  sharedAt: z.string(),
  /** Exact A2UI v1.0 DisplayExperience payload rendered identically on both advisor & customer screens. */
  experience: z.record(z.string(), z.unknown()),
}).strict();
export type SharedCard = z.infer<typeof sharedCardSchema>;

export const coBrowseStateSchema = z.object({
  active: z.boolean().default(true),
  title: z.string().trim().min(1).max(120).default("Shared Planning Canvas"),
  updatedBy: z.enum(["advisor", "customer"]).default("advisor"),
  updatedAt: z.string(),
  sliders: coBrowseSlidersSchema,
  proposal: advisorProposalSchema.optional(),
  sharedCard: sharedCardSchema.optional(),
}).strict();
export type CoBrowseState = z.infer<typeof coBrowseStateSchema>;

export const handoffTicketSchema = z.object({
  handoffId: z.string(),
  conversationId: z.string(),
  personaId: z.string(),
  customerName: z.string(),
  domain: recommendationDomainSchema,
  reason: z.string().trim().min(1).max(400),
  priority: handoffPrioritySchema.default("normal"),
  status: handoffStatusSchema,
  assignedAgent: z.string().optional(),
  aiBrief: z.string(),
  customerSnapshot: z.record(z.string(), z.string()),
  recentTranscript: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() }).strict()).max(12),
  notes: z.array(handoffNoteSchema).default([]),
  coBrowse: coBrowseStateSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  claimedAt: z.string().optional(),
  resolvedAt: z.string().optional(),
}).strict();
export type HandoffTicket = z.infer<typeof handoffTicketSchema>;

export const createHandoffInputSchema = z.object({
  conversationId: z.string().trim().min(1).max(80),
  personaId: z.string().trim().min(1).max(80).default("demo-learner"),
  domain: recommendationDomainSchema.default("wealth"),
  reason: z.string().trim().min(1).max(400),
  priority: handoffPrioritySchema.optional(),
  assignedAgent: z.string().trim().min(1).max(80).optional(),
}).strict();
export type CreateHandoffInput = z.input<typeof createHandoffInputSchema>;

export interface HandoffInboxView {
  tickets: HandoffTicket[];
  queuedCount: number;
  claimedCount: number;
  resolvedCount: number;
}
