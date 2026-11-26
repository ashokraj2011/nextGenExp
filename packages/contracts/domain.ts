import { z } from "zod";
import { pznSlugSchema } from "./self-service-pzn";
import type { ActionRecommendation, WorkflowCandidate } from "./funding-workflow";
import type { RoutingIntentId } from "./routing-intents";

export const componentNames = ["PznContentCard", "PznComparison", "PznStepList", "PznMetricSummary", "PznGoalProgress"] as const;
export type ComponentName = typeof componentNames[number];
export type Variant = "compact" | "expanded";
export type SelectionMode = "semantic_rerank" | "preserve_ts_rank";
export type IntroKey = "explanation" | "comparison" | "steps" | "summary" | "next_step" | "clarification" | "no_match";

export type Intent = { topic: string; task: "explain" | "compare" | "guide" | "show" | "unknown"; summary: string };
export type ContextSelectionProposal = {
  schemaVersion: "1.1";
  catalogSnapshotId: string;
  catalogVersion: string;
  status: "selected" | "create_rule" | "clarify" | "reply" | "no_match";
  intentId: RoutingIntentId | null;
  clarificationQuestion: string | null;
  replyText?: string | null;
  summary: string;
};
export type ProposalBlock = { blockId: string; component: ComponentName; candidateIds: string[]; variant: Variant };
export type ExperienceProposal = {
  schemaVersion: "1.0";
  decisionId: string;
  status: "ready" | "clarify" | "no_match";
  intent: Intent;
  introKey: IntroKey;
  clarificationQuestion: string | null;
  replyText?: string | null;
  blocks: ProposalBlock[];
  followUpIds: string[];
};

export const contextEntrySchema = z.object({
  contextId: pznSlugSchema,
  displayName: z.string().min(1),
  description: z.string().min(1),
  active: z.boolean(),
}).strict();
export const contextCatalogSchema = z.object({
  schemaVersion: z.literal("1.0"),
  catalogVersion: z.string().min(1),
  contexts: z.array(contextEntrySchema).min(1).max(24),
}).strict();
export type ContextCatalog = z.infer<typeof contextCatalogSchema>;
export const propensitySchema = z.object({
  version: z.string().min(1),
  classification: z.literal("synthetic_advisory"),
  status: z.enum(["available", "unavailable"]),
  scores: z.array(z.object({
    contextId: z.string(),
    score: z.number().min(0).max(1).nullable(),
  }).strict()),
}).strict();
export type PropensityResult = z.infer<typeof propensitySchema>;

export const comparisonFieldSchema = z.object({ fieldId: z.string(), label: z.string(), value: z.string() }).strict();
export const stepSchema = z.object({ stepId: z.string(), title: z.string(), body: z.string() }).strict();
export const followUpSchema = z.object({ followUpId: z.string(), label: z.string(), userMessage: z.string() }).strict();
export const disclosureSchema = z.object({ disclosureId: z.string(), text: z.string() }).strict();
export const metricValueSchema = z.object({
  metricKey: z.enum(["available", "current"]),
  displayValue: z.string().regex(/^\d+\.\d{2}$/),
  unit: z.literal("DEMO_UNITS"),
}).strict();
export const metricReadingSchema = z.object({
  fixtureVersion: z.string(),
  observedAt: z.string().datetime(),
  values: z.array(metricValueSchema).min(1).max(2),
}).strict();
export type MetricReading = z.infer<typeof metricReadingSchema>;
export const contentEntrySchema = z.object({
  contentId: z.string(),
  version: z.string(),
  publicationStatus: z.enum(["published", "withdrawn"]),
  kind: z.enum(["education", "promotion", "metric_template"]),
  title: z.string().min(1),
  description: z.string().min(1),
  body: z.string().min(1),
  allowedComponents: z.array(z.enum(componentNames)).min(1),
  comparisonGroup: z.string().nullable(),
  comparisonFields: z.array(comparisonFieldSchema),
  steps: z.array(stepSchema),
  metricSpec: z.object({
    toolId: z.literal("demo.balance.read"),
    metricKeys: z.array(metricValueSchema.shape.metricKey).min(1).max(2),
  }).strict().nullable(),
  portfolioData: z.literal("cash").optional(),
  recommendation: z.literal(true).optional(),
  followUps: z.array(followUpSchema),
  sourceRef: z.string().startsWith("fixture:"),
  sourceLabel: z.string().min(1),
  requiredDisclosures: z.array(disclosureSchema).min(1),
}).strict();

export type ContentEntry = z.infer<typeof contentEntrySchema>;
export type Scope = {
  userId?: string;
  tenantId?: string;
  domainId?: import("./domain-packs").DomainPackId;
  principalId: string;
  personaId: string;
  conversationId: string;
  turnId: string;
};
export type Dated = { issuedAt: number; expiresAt: number };
export type CatalogSnapshot = Dated & {
  snapshotId: string;
  scope: Scope;
  catalog: ContextCatalog;
};
export type RouteDecision = Dated & {
  routeDecisionId: string;
  scope: Scope;
  catalogSnapshotId: string;
  catalogVersion: string;
  contextId: string;
  routerRunId: string;
  intent: Intent;
};
export type Candidate = { candidateId: string; contentId: string; contentVersion: string; tsRank: number; publishedEntry?: ContentEntry };
export type ContentDecision = Dated & {
  decisionId: string;
  scope: Scope;
  routeDecisionId: string;
  contextId: string;
  catalogVersion: string;
  selectionMode: SelectionMode;
  partial: boolean;
  candidates: Candidate[];
  workflowRecommendations?: WorkflowCandidate[];
  actionRecommendations?: ActionRecommendation[];
  composerRunId: string | null;
};
export type BalanceProof = MetricReading & {
  toolId: "demo.balance.read";
  scope: Scope;
  decisionId: string;
  routeDecisionId: string;
  contextId: string;
  composerRunId: string;
  callId: string;
  expiresAt: number;
};

export const DECISION_TTL = 300_000;
export const TURN_DEADLINE = 45_000;
export const MAX_MESSAGE_LENGTH = 1600;
