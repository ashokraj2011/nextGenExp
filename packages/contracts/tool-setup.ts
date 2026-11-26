import { z } from "zod";
import { fundingTools, fundingWorkflowDefinitionSchema, workflowRecommendationSchema, type ActionRecommendation, type WorkflowCandidate } from "./funding-workflow";
import { glossaryConditionSchema, type RuleGlossary } from "./rule-glossary";

export const toolVersion = "1.0.0";
export const sfieldTools = {
  catalog: {
    id: "contexts.list",
    label: "Context catalog",
    description: "Lists the demo placements the router can choose.",
  },
  propensity: {
    id: "propensity.context.score",
    label: "Topic relevance scores",
    description: "Gets advisory topic scores from Treatment Selector.",
  },
  selection: {
    id: "treatments.eligible",
    label: "Treatment Selector",
    description: "Returns the eligible treatments for the selected topic.",
  },
  balances: {
    id: "demo.balance.read",
    label: "Demo balance",
    description: "Reads synthetic values for an eligible balance summary.",
  },
  glossary: {
    id: "ccre.glossary.get",
    label: "CCRE glossary",
    description: "Lists the demo namespaces, attributes and operators available for authoring rules in chat.",
  },
  retirementAccounts: { id: "retirement.accounts.read", label: "Retirement accounts", description: "Reads the member’s retirement accounts and the designation for a selected account." },
  portfolio: {
    id: "portfolio.snapshot.read",
    label: "Portfolio Snapshot",
    description: "Reads the scoped demo member’s portfolio values for a portfolio-summary request.",
  },
  goal: {
    id: "goal.progress.read",
    label: "Goal Progress",
    description: "Reads the scoped demo member’s down payment target and savings history for an eligible home-buying goal.",
  },
  ...fundingTools,
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
export const mockCcreConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("always") }).strict(),
  z.object({ kind: z.literal("never") }).strict(),
  z.object({ kind: z.literal("persona_is"), personaId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("from_turn"), ordinal: ordinalSchema }).strict(),
  glossaryConditionSchema,
]);
export const mockCcreRuleSchema = mockScopeSchema.extend({
  name: z.string().trim().min(1).max(MAX_CCRE_RULE_NAME),
  contentId: z.string().min(1),
  source: z.string().max(MAX_CCRE_SOURCE_LENGTH).optional(),
  condition: mockCcreConditionSchema,
  workflow: workflowRecommendationSchema.nullable().optional(),
  workflowRequiresContentIds: normalizedIdsSchema.optional(),
});
const mockCcreRulesSchema = z.array(mockCcreRuleSchema).max(MAX_CCRE_RULES).refine((rules) => (
  new Set(rules.map(({ scenarioId, contextId, contentId }) => JSON.stringify([scenarioId, contextId, contentId]))).size === rules.length
), "Each scenario, context and content item can have one mock rule");
export type MockCcreCondition = z.infer<typeof mockCcreConditionSchema>;
export type MockCcreRule = z.infer<typeof mockCcreRuleSchema>;
export function effectiveCcreRules(scenarioId: string, contextId: string,
  defaults: readonly Omit<MockCcreRule, "scenarioId">[], configured: readonly MockCcreRule[] = []): MockCcreRule[] {
  const base = defaults.filter((rule) => rule.contextId === contextId);
  const custom = configured.filter((rule) => rule.scenarioId === scenarioId && rule.contextId === contextId);
  // A saved rule from before workflow attachments inherits its original offer. An explicit null detaches it.
  return [...custom.map((rule) => {
    const original = base.find((r) => r.contentId === rule.contentId);
    return { ...rule, workflow: rule.workflow === undefined ? original?.workflow : rule.workflow,
      workflowRequiresContentIds: rule.workflowRequiresContentIds ?? original?.workflowRequiresContentIds };
  }),
    ...base.filter((rule) => !custom.some((r) => r.contentId === rule.contentId)).map((rule) => ({ ...rule, scenarioId }))];
}

export type MockCcreEvaluation = {
  beforeRules: string[];
  results: { name: string; contentId: string; outcome: "matched" | "excluded" | "outside_list"; reason?: string; cashAboveCents?: number }[];
};
export const toolSetupSchema = z.object({
  enabled: z.object({
    catalog: z.boolean(), propensity: z.boolean(), selection: z.boolean(), balances: z.boolean(),
    glossary: z.boolean().optional(), portfolio: z.boolean().optional(), goal: z.boolean().optional(), retirementAccounts: z.boolean().optional(),
    fundingOptions: z.boolean().optional(), fundingStatus: z.boolean().optional(), fundingPreview: z.boolean().optional(),
  }).strict(),
  treatmentOverrides: z.array(treatmentOverrideSchema).max(64).refine((rules) => (
    new Set(rules.map(({ scenarioId, contextId }) => JSON.stringify([scenarioId, contextId]))).size === rules.length
  ), "Each scenario and context can have one override"),
  ccreRules: mockCcreRulesSchema.optional(),
  fundingWorkflow: fundingWorkflowDefinitionSchema.optional(),
}).strict();
export type ToolSetup = z.infer<typeof toolSetupSchema>;
export type TreatmentOverride = z.infer<typeof treatmentOverrideSchema>;
export type MockOutput = z.infer<typeof mockOutputSchema>;
export const defaultToolSetup: ToolSetup = {
  enabled: {
    catalog: true, propensity: true, selection: true, balances: true, glossary: true, portfolio: true, goal: true, retirementAccounts: true,
    fundingOptions: true, fundingStatus: true, fundingPreview: true,
  },
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
  | { status: "ranked" | "empty"; source: TreatmentSource; contentIds: string[]; ccre?: MockCcreEvaluation; workflows?: WorkflowCandidate[]; actions?: ActionRecommendation[] }
  | { status: "timeout"; source: TreatmentSource }
  | { status: "disabled" };

export type ToolSetupView = {
  setup: ToolSetup;
  privateDraft?: ToolSetup;
  defaultCcreRules: Omit<MockCcreRule, "scenarioId">[];
  glossary: RuleGlossary;
  defaultPersonaId: string;
  defaultScenarioId: string;
  personas: { personaId: string; displayName: string; allowedScenarios: string[] }[];
  scenarios: { scenarioId: string; label: string }[];
  contexts: { contextId: string; displayName: string }[];
  content: { contentId: string; title: string }[];
};
