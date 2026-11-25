import { z } from "zod";
import { widgetDraftSchema, type WidgetDraft } from "./widget";

export const uxFrictionReasonSchema = z.enum(["plain_chat_miss", "unhelpful_feedback", "repeated_ask"]);
export type UxFrictionReason = z.infer<typeof uxFrictionReasonSchema>;

export const uxProposalStatusSchema = z.enum(["pending", "approved", "dismissed"]);
export type UxProposalStatus = z.infer<typeof uxProposalStatusSchema>;

export const uxPolicyDraftSchema = z.object({
  title: z.string().trim().min(3).max(96),
  category: z.string().trim().min(2).max(48),
  body: z.string().trim().min(20).max(2000),
}).strict();

export const uxProposalSchema = z.object({
  id: z.string().trim().min(3).max(64),
  status: uxProposalStatusSchema,
  topicKey: z.string().trim().min(2).max(64),
  detectedPattern: z.string().trim().min(2).max(120),
  frictionReason: uxFrictionReasonSchema,
  samplePrompts: z.array(z.string().trim().min(1).max(240)).min(1).max(5),
  occurrenceCount: z.number().int().min(1),
  title: z.string().trim().min(2).max(96),
  summary: z.string().trim().min(4).max(320),
  generatedBy: z.enum(["copilot_llm", "synthesizer"]),
  widgetDraft: widgetDraftSchema,
  policyDraft: uxPolicyDraftSchema.optional(),
  createdAt: z.string(),
  regression: z.object({ prompt: z.string(), widgetId: z.string(), title: z.string() }).optional(),
  shippedWidgetId: z.string().optional(),
  shippedPolicyDocId: z.string().optional(),
  shippedAt: z.string().optional(),
}).strict();
export type UxProposal = z.infer<typeof uxProposalSchema>;

export interface UxEvolutionView {
  proposals: UxProposal[];
  stats: {
    scannedTurns: number;
    plainChatMisses: number;
    unhelpfulTurns: number;
    pendingCount: number;
    shippedCount: number;
  };
  lastScannedAt?: string;
}

export type UxProposalWidgetDraft = WidgetDraft;
