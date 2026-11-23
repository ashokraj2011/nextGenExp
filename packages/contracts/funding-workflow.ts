import { z } from "zod";

export const treatmentRecommendationsVersion = "2.0.0";
export const workflowRecommendationSchema = z.object({
  kind: z.literal("workflow"), id: z.string().min(1), version: z.string().min(1),
}).strict();
export type WorkflowRecommendation = z.infer<typeof workflowRecommendationSchema>;
export const treatmentRecommendationsSchema = z.object({
  schemaVersion: z.literal("2.0"),
  recommendations: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("content"), id: z.string().min(1) }).strict(),
    workflowRecommendationSchema,
  ])).max(24),
}).strict();
export type TreatmentRecommendations = z.infer<typeof treatmentRecommendationsSchema>;

export const fundingPreviewWorkflow = {
  recommendation: { kind: "workflow", id: "account.funding.preview", version: "1.0.0" },
  label: "Preview funding",
  contextId: "address-update",
  requiredContentIds: ["address_update_guide", "fund_account"],
} as const;

export const fundingTools = {
  fundingOptions: {
    id: "funding.options.read",
    label: "Funding options",
    description: "Reads the sample transfer method and amount for the approved funding preview.",
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
}).strict();
export type FundingWorkflowDefinition = z.infer<typeof fundingWorkflowDefinitionSchema>;
export const defaultFundingWorkflow: FundingWorkflowDefinition = {
  id: fundingPreviewWorkflow.recommendation.id,
  version: fundingPreviewWorkflow.recommendation.version,
  steps: [optionsRef, previewRef],
};

export function resolveFundingWorkflow(recommendation: WorkflowRecommendation, definition = defaultFundingWorkflow) {
  if (recommendation.kind === "workflow" && recommendation.id === definition.id && recommendation.version === definition.version) {
    return definition;
  }
}

export function fundingWorkflowIssue(steps: readonly FundingStepRef[]) {
  if (new Set(steps).size !== steps.length) return "Include each workflow tool once.";
  const options = steps.indexOf(optionsRef);
  const preview = steps.indexOf(previewRef);
  if (options < 0 || preview < 0) return "Add both Funding options and Build funding preview.";
  if (options > preview) return "Move Funding options before Build funding preview.";
  if (preview !== steps.length - 1) return "Place Build funding preview last.";
}

export type WorkflowLaunch = { recommendation: WorkflowRecommendation; sourceExperienceId: string };

const fundingMethodSchema = z.object({
  methodId: z.string().min(1), label: z.string().min(1), from: z.string().min(1), to: z.string().min(1),
}).strict();
const amounts = { amountCents: z.number().int().positive(), currency: z.literal("USD") };
export const fundingStatusSchema = z.object({ accountFundingStatus: z.enum(["funded", "unfunded"]) }).strict();
export const fundingOptionsSchema = z.object({
  methods: z.array(fundingMethodSchema).min(1).max(4),
  ...amounts,
}).strict();
export const fundingPreviewSchema = z.object({
  status: z.literal("preview"), method: fundingMethodSchema, ...amounts,
}).strict();
export type FundingPreview = z.infer<typeof fundingPreviewSchema>;
