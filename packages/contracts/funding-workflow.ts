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

export function isFundingPreviewWorkflow({ id, version }: WorkflowRecommendation) {
  return id === fundingPreviewWorkflow.recommendation.id && version === fundingPreviewWorkflow.recommendation.version;
}

export type WorkflowLaunch = { recommendation: WorkflowRecommendation; sourceExperienceId: string };

const fundingMethodSchema = z.object({
  methodId: z.string().min(1), label: z.string().min(1), from: z.string().min(1), to: z.string().min(1),
}).strict();
const amounts = { amountCents: z.number().int().positive(), currency: z.literal("USD") };
export const fundingOptionsSchema = z.object({
  methods: z.array(fundingMethodSchema).min(1).max(4),
  ...amounts,
}).strict();
export const fundingPreviewSchema = z.object({
  status: z.literal("preview"), method: fundingMethodSchema, ...amounts,
}).strict();
export type FundingPreview = z.infer<typeof fundingPreviewSchema>;
