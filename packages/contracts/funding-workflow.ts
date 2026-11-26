import { z } from "zod";
import { pendingActionsContext } from "./workspace";

export const treatmentRecommendationsVersion = "2.0.0";
export const treatmentDecisionVersion = "2.1.0";
export const actionRecommendationSchema = z.object({
  kind: z.literal("action"), id: z.string().min(1), version: z.string().min(1),
}).strict();
export type ActionRecommendation = z.infer<typeof actionRecommendationSchema>;
export const workflowRecommendationSchema = z.object({
  kind: z.literal("workflow"), id: z.string().min(1), version: z.string().min(1),
}).strict();
export type WorkflowRecommendation = z.infer<typeof workflowRecommendationSchema>;
export const workflowCandidateSchema = workflowRecommendationSchema.extend({
  forContentIds: z.array(z.string().min(1)).min(1).max(12).optional(),
});
export type WorkflowCandidate = z.infer<typeof workflowCandidateSchema>;
export const treatmentRecommendationsSchema = z.object({
  schemaVersion: z.literal("2.0"),
  recommendations: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("content"), id: z.string().min(1) }).strict(),
    workflowCandidateSchema,
  ])).max(24),
}).strict();
export type TreatmentRecommendations = z.infer<typeof treatmentRecommendationsSchema>;

export const treatmentDecisionSchema = treatmentRecommendationsSchema.extend({
  schemaVersion: z.literal("2.1"),
  recommendations: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("content"), id: z.string().min(1) }).strict(),
    actionRecommendationSchema, workflowCandidateSchema,
  ])).max(24),
});
export type TreatmentDecision = z.infer<typeof treatmentDecisionSchema>;
export const chatTreatmentSchema = z.discriminatedUnion("schemaVersion", [treatmentRecommendationsSchema, treatmentDecisionSchema]);

export const fundingPreviewWorkflow = {
  recommendation: { kind: "workflow", id: "account.funding.preview", version: "1.0.0" },
  label: "Preview funding",
  contexts: [
    { contextId: "address-update", requiredContentIds: ["address_update_guide", "fund_account"] },
    { contextId: "next-step", requiredContentIds: ["fund_account"] },
    { contextId: pendingActionsContext, requiredContentIds: ["fund_account"] },
  ],
} as const;

export function fundingPreviewApplies(contextId: string, contentIds: readonly string[]) {
  return fundingPreviewWorkflow.contexts.some((context) => (
    context.contextId === contextId && context.requiredContentIds.every((id) => contentIds.includes(id))
  ));
}

export const fundingTools = {
  fundingOptions: {
    id: "funding.options.read",
    label: "Funding options",
    description: "Reads the eligible funding methods and sample amount for the approved funding preview.",
  },
  fundingStatus: {
    id: "funding.status.read",
    label: "Check funding status",
    description: "Checks whether the demo account is still waiting for its first deposit.",
  },
  fundingPreview: {
    id: "funding.preview.build",
    label: "Build funding preview",
    description: "Builds a preview from the funding options read for this turn.",
  },
} as const;
export const fundingToolVersion = "1.0.0";
type FundingToolKey = keyof typeof fundingTools;
export const fundingToolKeys = Object.keys(fundingTools) as FundingToolKey[];

export function fundingToolRef(key: FundingToolKey) {
  return `${fundingTools[key].id}@${fundingToolVersion}` as const;
}

export function fundingToolKey(ref: string) {
  return fundingToolKeys.find((key) => fundingToolRef(key) === ref);
}

const optionsRef = fundingToolRef("fundingOptions");
const statusRef = fundingToolRef("fundingStatus");
const previewRef = fundingToolRef("fundingPreview");
const fundingStepRefs = [optionsRef, statusRef, previewRef] as const;
export type FundingStepRef = (typeof fundingStepRefs)[number];
export const fundingWorkflowDefinitionSchema = z.object({
  id: z.literal(fundingPreviewWorkflow.recommendation.id),
  version: z.literal(fundingPreviewWorkflow.recommendation.version),
  steps: z.array(z.enum(fundingStepRefs)).max(fundingStepRefs.length),
  mode: z.enum(["agent", "ordered"]).optional(),
  goal: z.string().trim().min(1).max(320).optional(),
  maxToolCalls: z.number().int().min(4).max(8).optional(),
}).strict();
export type FundingWorkflowDefinition = z.infer<typeof fundingWorkflowDefinitionSchema>;
export const defaultFundingWorkflow: FundingWorkflowDefinition = {
  id: fundingPreviewWorkflow.recommendation.id,
  version: fundingPreviewWorkflow.recommendation.version,
  steps: [optionsRef, previewRef],
};
export const fundingAgentId = "funding-preview";
export const fundingAgentGoal = "Help the customer choose and preview an eligible funding method.";
export const fundingAgentToolLimit = 8;
export const defaultFundingAgentToolCalls = 5;
export const defaultAgentFundingWorkflow: FundingWorkflowDefinition = {
  ...defaultFundingWorkflow,
  mode: "agent",
  goal: fundingAgentGoal,
  maxToolCalls: defaultFundingAgentToolCalls,
  steps: [statusRef, optionsRef, previewRef],
};

export function resolveFundingWorkflow(recommendation: WorkflowRecommendation, definition = defaultFundingWorkflow) {
  if (recommendation.kind === "workflow" && recommendation.id === definition.id && recommendation.version === definition.version) {
    return definition;
  }
}

export function fundingWorkflowIssue({ steps, mode, goal, maxToolCalls }: FundingWorkflowDefinition) {
  if (new Set(steps).size !== steps.length) return "Include each workflow tool once.";
  if (mode === "agent") {
    if (!steps.includes(statusRef) || !steps.includes(optionsRef)) return "Include Check funding status and Funding options.";
    if (goal !== undefined && !goal.trim()) return "Enter a goal for the funding agent.";
    if (maxToolCalls !== undefined && (!Number.isInteger(maxToolCalls) || maxToolCalls < 4 || maxToolCalls > fundingAgentToolLimit)) {
      return "Choose a tool call limit from 4 to 8.";
    }
    return;
  }
  const options = steps.indexOf(optionsRef);
  const preview = steps.indexOf(previewRef);
  if (options < 0 || preview < 0) return "Add both Funding options and Build funding preview.";
  if (options > preview) return "Move Funding options before Build funding preview.";
  if (preview !== steps.length - 1) return "Place Build funding preview last.";
}

export type WorkflowLaunch = { recommendation: WorkflowRecommendation } & (
  { sourceExperienceId: string; sourceOverviewTurnId?: never } |
  { sourceOverviewTurnId: string; sourceExperienceId?: never }
);

const fundingMethodSchema = z.object({
  methodId: z.string().min(1), label: z.string().min(1), from: z.string().min(1), to: z.string().min(1),
}).strict();
const amounts = { amountCents: z.number().int().positive(), currency: z.literal("USD") };
export const fundingStatusSchema = z.object({ accountFundingStatus: z.enum(["funded", "unfunded"]) }).strict();
export const fundingOptionsSchema = z.object({
  methods: z.array(fundingMethodSchema).min(1).max(4),
  ...amounts,
}).strict();
export type FundingOptions = z.infer<typeof fundingOptionsSchema>;
export const fundingPreviewSchema = z.object({
  status: z.literal("preview"), method: fundingMethodSchema, ...amounts,
}).strict();
export type FundingPreview = z.infer<typeof fundingPreviewSchema>;

export const fundingAgentOutcomes = ["preview", "options", "already_funded", "unavailable", "cancelled", "other_topic"] as const;
export const fundingAgentOutputSchema = z.object({
  outcome: z.enum(fundingAgentOutcomes),
  methodId: z.string().min(1).nullable(),
}).strict();
export const fundingChoiceQuestion = "Which funding method would you like to preview?";

export function asksAboutFunding(message: string) {
  return /\bfund(?:ing|ed)?\b|\b(?:first deposit|add money)\b/i.test(message)
    || /^(?:what are|show me|show) (?:my|the) options[.!?]*$/i.test(message.trim());
}
