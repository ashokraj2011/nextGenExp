import { z } from "zod";

export const recommendationArbitrateToolId = "cep.recommendations.arbitrate";
export const recommendationArbitrateToolVersion = "1.0.0";
export const recommendationArbitrateToolRef = `${recommendationArbitrateToolId}@${recommendationArbitrateToolVersion}`;

export const recommendationDomainSchema = z.enum(["wealth", "operations", "sales", "general"]);
export type RecommendationDomain = z.infer<typeof recommendationDomainSchema>;

export const normalizedRecommendationSchema = z.object({
  id: z.string().trim().min(1).max(120),
  providerId: z.string().trim().min(1).max(64),
  providerLabel: z.string().trim().min(1).max(80),
  kind: z.enum(["content", "workflow", "nba", "action"]),
  priority: z.number().int().min(1).max(1000),
  title: z.string().trim().min(1).max(140),
  body: z.string().trim().max(400).optional(),
  ctaLabel: z.string().trim().max(64).optional(),
  ctaPrompt: z.string().trim().max(240).optional(),
  contentId: z.string().trim().max(80).optional(),
  workflow: z.object({
    capabilityId: z.string().trim().min(1).max(80),
    version: z.string().trim().min(1).max(32),
  }).strict().optional(),
  reason: z.string().trim().max(240).optional(),
  badge: z.string().trim().max(48).optional(),
}).strict();

export const providerExecutionTraceSchema = z.object({
  providerId: z.string().trim().min(1).max(64),
  providerLabel: z.string().trim().min(1).max(80),
  status: z.enum(["ok", "skipped", "error"]),
  candidateCount: z.number().int().min(0),
  elapsedMs: z.number().min(0),
  note: z.string().trim().max(200).optional(),
}).strict();

export const recommendationArbitrateInputSchema = z.object({
  turnRef: z.string().trim().min(1).max(128),
  contextId: z.string().trim().min(1).max(80),
  domain: recommendationDomainSchema.default("wealth"),
  existingBlockTitles: z.array(z.string().trim().max(120)).max(12).optional(),
}).strict();

export const recommendationArbitrateResultSchema = z.object({
  decisionId: z.string().trim().min(1).max(128),
  toolRef: z.string().trim().min(1).max(128),
  providers: z.array(providerExecutionTraceSchema),
  recommendations: z.array(normalizedRecommendationSchema),
  topNba: normalizedRecommendationSchema.optional(),
}).strict();

/** Closed JSON Schema objects matching sfield's strict JsonSchema subset. */
export const recommendationArbitrateInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["turnRef", "contextId"],
  properties: {
    turnRef: { type: "string", minLength: 1, maxLength: 128 },
    contextId: { type: "string", minLength: 1, maxLength: 80 },
    domain: { type: "string", enum: ["wealth", "operations", "sales", "general"] },
    existingBlockTitles: {
      type: "array",
      maxItems: 12,
      items: { type: "string", maxLength: 120 },
    },
  },
} as const;

const normalizedRecJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "providerId", "providerLabel", "kind", "priority", "title"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 120 },
    providerId: { type: "string", minLength: 1, maxLength: 64 },
    providerLabel: { type: "string", minLength: 1, maxLength: 80 },
    kind: { type: "string", enum: ["content", "workflow", "nba", "action"] },
    priority: { type: "integer", minimum: 1, maximum: 1000 },
    title: { type: "string", minLength: 1, maxLength: 140 },
    body: { type: "string", maxLength: 400 },
    ctaLabel: { type: "string", maxLength: 64 },
    ctaPrompt: { type: "string", maxLength: 240 },
    contentId: { type: "string", maxLength: 80 },
    workflow: {
      type: "object",
      additionalProperties: false,
      required: ["capabilityId", "version"],
      properties: {
        capabilityId: { type: "string", minLength: 1, maxLength: 80 },
        version: { type: "string", minLength: 1, maxLength: 32 },
      },
    },
    reason: { type: "string", maxLength: 240 },
    badge: { type: "string", maxLength: 48 },
  },
} as const;

export const recommendationArbitrateResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decisionId", "toolRef", "providers", "recommendations"],
  properties: {
    decisionId: { type: "string", minLength: 1, maxLength: 128 },
    toolRef: { type: "string", minLength: 1, maxLength: 128 },
    providers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["providerId", "providerLabel", "status", "candidateCount", "elapsedMs"],
        properties: {
          providerId: { type: "string", minLength: 1, maxLength: 64 },
          providerLabel: { type: "string", minLength: 1, maxLength: 80 },
          status: { type: "string", enum: ["ok", "skipped", "error"] },
          candidateCount: { type: "integer", minimum: 0 },
          elapsedMs: { type: "number", minimum: 0 },
          note: { type: "string", maxLength: 200 },
        },
      },
    },
    recommendations: { type: "array", items: normalizedRecJsonSchema },
    topNba: normalizedRecJsonSchema,
  },
} as const;

export type NormalizedRecommendation = z.infer<typeof normalizedRecommendationSchema>;
export type ProviderExecutionTrace = z.infer<typeof providerExecutionTraceSchema>;
export type RecommendationArbitrateInput = z.infer<typeof recommendationArbitrateInputSchema>;
export type RecommendationArbitrateResult = z.infer<typeof recommendationArbitrateResultSchema>;

export interface RecommendationProviderDescriptor {
  id: string;
  label: string;
  description: string;
  domains: RecommendationDomain[];
  sfieldToolRef: string;
}

export interface RecommendationProviderContext {
  principalId: string;
  personaId: string;
  syntheticMid: string;
  contextId: string;
  domain: RecommendationDomain;
  fundingStatus: "funded" | "unfunded";
  excludePromotions: boolean;
  existingBlockTitles?: string[];
}

export interface RecommendationProvider {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly domains: RecommendationDomain[];
  evaluate(ctx: RecommendationProviderContext, signal: AbortSignal): Promise<NormalizedRecommendation[]>;
}
