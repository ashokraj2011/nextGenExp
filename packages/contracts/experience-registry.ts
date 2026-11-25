import { z } from "zod";
import { componentNames, type ContentEntry } from "./domain";

export const managedIntentInputSchema = z.object({
  intentId: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, "Use lowercase snake_case (e.g. tax_planning)"),
  label: z.string().trim().min(1, "Label is required").max(80),
  contextId: z.string().regex(/^[a-z][a-z0-9-]*$/),
  task: z.enum(["explain", "compare", "guide", "show"]),
  description: z.string().trim().min(4, "Routing description is required").max(400),
  samplePhrases: z.array(z.string().trim().min(1).max(140)).max(8),
  enabled: z.boolean(),
}).strict();

export type ManagedIntentInput = z.infer<typeof managedIntentInputSchema>;

export type ManagedIntentRecord = ManagedIntentInput & {
  isBuiltIn: boolean;
  isCustomized: boolean;
  tsContentIds: string[];
  hasPublishedLayout: boolean;
};

export const managedContentInputSchema = z.object({
  contentId: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, "Use lowercase snake_case (e.g. roth_ira_guide)"),
  publicationStatus: z.enum(["published", "withdrawn"]),
  kind: z.enum(["education", "promotion", "metric_template"]),
  title: z.string().trim().min(1, "Title is required").max(120),
  description: z.string().trim().min(1, "Description is required").max(260),
  body: z.string().trim().min(1, "Body copy is required").max(2000),
  allowedComponents: z.array(z.enum(componentNames)).min(1, "Choose at least one component"),
  sourceLabel: z.string().trim().min(1).max(80),
  disclosureText: z.string().trim().min(1).max(300),
}).strict();

export type ManagedContentInput = z.infer<typeof managedContentInputSchema>;

export type ManagedContentRecord = ManagedContentInput & {
  version: string;
  isBuiltIn: boolean;
  isCustomized: boolean;
  linkedContexts: string[];
  rawEntry: ContentEntry;
};

export const nbaConditionKindSchema = z.enum([
  "unfunded_account",
  "cash_above_usd",
  "beneficiary_missing",
  "has_home_goal",
  "always",
]);

export type NbaConditionKind = z.infer<typeof nbaConditionKindSchema>;

export const managedNbaRuleInputSchema = z.object({
  id: z.string().regex(/^nba_[a-z0-9_]{3,40}$/, "Start with nba_ using lowercase snake_case"),
  enabled: z.boolean(),
  priority: z.enum(["urgent", "opportunity", "goal"]),
  conditionKind: nbaConditionKindSchema,
  thresholdUsd: z.number().int().min(0).max(10_000_000).optional(),
  kicker: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(240),
  ctaLabel: z.string().trim().min(1).max(60),
  actionKind: z.enum(["prompt", "preview_funding"]),
  prompt: z.string().trim().max(240).optional(),
  dedupeKeywords: z.array(z.string().trim().min(1).max(60)).max(6),
  respectsPromotionExclusion: z.boolean(),
}).strict();

export type ManagedNbaRuleInput = z.infer<typeof managedNbaRuleInputSchema>;

export type ManagedNbaRuleRecord = ManagedNbaRuleInput & {
  rank: number;
  isBuiltIn: boolean;
  isCustomized: boolean;
};

export type ExperienceRegistryView = {
  contexts: { contextId: string; displayName: string; description: string; active: boolean; baseContentIds: string[] }[];
  intents: ManagedIntentRecord[];
  content: ManagedContentRecord[];
  nbaRules: ManagedNbaRuleRecord[];
};
