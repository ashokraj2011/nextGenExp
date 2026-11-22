import { z } from "zod";

export const toolVersion = "1.0.0";
export const sfieldTools = {
  catalog: {
    id: "contexts.list",
    label: "Context catalog",
    description: "Lists the demo placements the router can choose.",
  },
  propensity: {
    id: "propensity.context.score",
    label: "Context propensity",
    description: "Provides advisory scores for the current contexts.",
  },
  selection: {
    id: "treatments.eligible",
    label: "Treatment Selector",
    description: "Returns ranked eligible content IDs for the selected context.",
  },
  balances: {
    id: "demo.balance.read",
    label: "Demo balance",
    description: "Reads synthetic values for an eligible balance summary.",
  },
} as const;
export type ToolKey = keyof typeof sfieldTools;
export const toolKeys = Object.keys(sfieldTools) as ToolKey[];

export const normalizedIdsSchema = z.array(z.string().min(1)).max(12).refine(
  (ids) => new Set(ids).size === ids.length,
  "Repeated eligible ID",
);
const mockOutputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("ranked"), contentIds: normalizedIdsSchema.refine((ids) => ids.length > 0) }).strict(),
  z.object({ mode: z.literal("empty") }).strict(),
  z.object({ mode: z.literal("timeout") }).strict(),
]);
const mockScopeSchema = z.object({
  scenarioId: z.string().min(1),
  contextId: z.string().min(1),
}).strict();
const treatmentOverrideSchema = mockScopeSchema.extend({ output: mockOutputSchema });
export const MAX_CCRE_RULES = 48;
export const MAX_CCRE_RULE_NAME = 80;
export const MAX_CCRE_SOURCE_LENGTH = 2_000;
const ordinalSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const mockCcreConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("always") }).strict(),
  z.object({ kind: z.literal("never") }).strict(),
  z.object({ kind: z.literal("persona_is"), personaId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("from_turn"), ordinal: ordinalSchema }).strict(),
]);
const mockCcreRuleSchema = mockScopeSchema.extend({
  name: z.string().trim().min(1).max(MAX_CCRE_RULE_NAME),
  contentId: z.string().min(1),
  source: z.string().max(MAX_CCRE_SOURCE_LENGTH).optional(),
  condition: mockCcreConditionSchema,
});
const mockCcreRulesSchema = z.array(mockCcreRuleSchema).max(MAX_CCRE_RULES).refine((rules) => (
  new Set(rules.map(({ scenarioId, contextId, contentId }) => JSON.stringify([scenarioId, contextId, contentId]))).size === rules.length
), "Each scenario, context and content item can have one mock rule");
export type MockCcreCondition = z.infer<typeof mockCcreConditionSchema>;
export type MockCcreRule = z.infer<typeof mockCcreRuleSchema>;
export type MockCcreEvaluation = {
  beforeRules: string[];
  results: { name: string; contentId: string; outcome: "matched" | "excluded" | "outside_list" }[];
};
export const toolSetupSchema = z.object({
  enabled: z.object({
    catalog: z.boolean(), propensity: z.boolean(), selection: z.boolean(), balances: z.boolean(),
  }).strict(),
  treatmentOverrides: z.array(treatmentOverrideSchema).max(64).refine((rules) => (
    new Set(rules.map(({ scenarioId, contextId }) => JSON.stringify([scenarioId, contextId]))).size === rules.length
  ), "Each scenario and context can have one override"),
  ccreRules: mockCcreRulesSchema.optional(),
}).strict();
export type ToolSetup = z.infer<typeof toolSetupSchema>;
export type TreatmentOverride = z.infer<typeof treatmentOverrideSchema>;
export type MockOutput = z.infer<typeof mockOutputSchema>;
export const defaultToolSetup: ToolSetup = {
  enabled: { catalog: true, propensity: true, selection: true, balances: true },
  treatmentOverrides: [],
};

export function treatmentOverride(overrides: readonly TreatmentOverride[], scenarioId: string, contextId: string) {
  return overrides.find((rule) => rule.scenarioId === scenarioId && rule.contextId === contextId);
}

export const treatmentPreviewSchema = mockScopeSchema.extend({
  personaId: z.string().min(1),
  ordinal: ordinalSchema,
  enabled: z.boolean(),
  output: mockOutputSchema.nullable(),
  ccreRules: mockCcreRulesSchema.optional(),
});
export type TreatmentPreviewInput = z.infer<typeof treatmentPreviewSchema>;
export type TreatmentSource = "fixture" | "override";
export type TreatmentPreview =
  | { status: "ranked" | "empty"; source: TreatmentSource; contentIds: string[]; ccre?: MockCcreEvaluation }
  | { status: "timeout"; source: TreatmentSource }
  | { status: "disabled" };

export type ToolSetupView = {
  setup: ToolSetup;
  defaultPersonaId: string;
  defaultScenarioId: string;
  personas: { personaId: string; displayName: string; allowedScenarios: string[] }[];
  scenarios: { scenarioId: string; label: string }[];
  contexts: { contextId: string; displayName: string }[];
  content: { contentId: string; title: string }[];
};
