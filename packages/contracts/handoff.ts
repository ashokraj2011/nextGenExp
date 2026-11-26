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
}).strict();
export type CreateHandoffInput = z.input<typeof createHandoffInputSchema>;

export interface HandoffInboxView {
  tickets: HandoffTicket[];
  queuedCount: number;
  claimedCount: number;
  resolvedCount: number;
}
