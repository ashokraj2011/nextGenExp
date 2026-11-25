import { z } from "zod";
import { recommendationDomainSchema } from "./recommendation-provider";

export const verticalScreenContextSchema = z.object({
  id: z.string().trim().min(1).max(48),
  label: z.string().trim().min(1).max(72),
  viewType: z.string().trim().min(1).max(48),
  summary: z.string().trim().min(1).max(240),
  metrics: z.array(z.object({
    label: z.string().trim().min(1).max(40),
    value: z.string().trim().min(1).max(48),
  })).max(4),
  suggestedActions: z.array(z.object({
    label: z.string().trim().min(1).max(56),
    prompt: z.string().trim().min(2).max(220),
  })).min(1).max(4),
  dataAttributes: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
}).strict();
export type VerticalScreenContext = z.infer<typeof verticalScreenContextSchema>;

export const verticalPackRecordSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,47}$/),
  name: z.string().trim().min(2).max(80),
  industry: z.string().trim().min(2).max(60),
  brandTitle: z.string().trim().min(2).max(60),
  portalName: z.string().trim().min(2).max(80),
  portalSubtitle: z.string().trim().min(2).max(160),
  accentColor: z.string().trim().regex(/^#[0-9a-fA-F]{3,8}$/),
  domain: recommendationDomainSchema,
  guardrailLabel: z.string().trim().min(2).max(90),
  composerPlaceholder: z.string().trim().min(2).max(120),
  policyDocId: z.string(),
  policyTitle: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  workflowTriggerPhrase: z.string(),
  screenViews: z.array(verticalScreenContextSchema).min(1).max(4),
  quickPrompts: z.array(z.object({
    label: z.string().trim().min(1).max(64),
    prompt: z.string().trim().min(2).max(220),
  })).min(1).max(5),
  generatedBy: z.enum(["copilot_llm", "synthesizer", "builtin"]),
  createdAt: z.string(),
}).strict();
export type VerticalPackRecord = z.infer<typeof verticalPackRecordSchema>;

export interface VerticalPacksView {
  packs: VerticalPackRecord[];
}
