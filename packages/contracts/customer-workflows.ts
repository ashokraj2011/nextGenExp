import {
  defaultAgentFundingWorkflow, fundingPreviewWorkflow, fundingToolKey, fundingWorkflowIssue, resolveFundingWorkflow,
  type FundingWorkflowDefinition, type WorkflowRecommendation,
} from "./funding-workflow";

import type { MockCcreCondition } from "./tool-setup";

export type RuleWorkflowMatch = { name: string; contentId: string; workflow: WorkflowRecommendation; condition?: MockCcreCondition; requiresContentIds?: string[] };

export const beneficiaryReviewWorkflow = {
  recommendation: { kind: "workflow", id: "retirement.beneficiary.review", version: "1.0.0" },
  label: "Review beneficiary", steps: ["retirement.accounts.read@1.0.0"],
} as const;

export const customerWorkflows = [fundingPreviewWorkflow, beneficiaryReviewWorkflow] as const;

export function customerWorkflow(ref: WorkflowRecommendation) {
  return customerWorkflows.find(({ recommendation }) => recommendation.id === ref.id && recommendation.version === ref.version);
}

export function workflowDefinition(ref: WorkflowRecommendation, funding: FundingWorkflowDefinition = defaultAgentFundingWorkflow) {
  const registered = customerWorkflow(ref);
  if (!registered) return;
  if (registered === beneficiaryReviewWorkflow) return {
    id: ref.id, version: ref.version, steps: [...beneficiaryReviewWorkflow.steps],
  };
  return resolveFundingWorkflow(ref, funding);
}

export function workflowToolKey(ref: string) {
  return ref === beneficiaryReviewWorkflow.steps[0] ? "retirementAccounts" : fundingToolKey(ref);
}

export function canOfferWorkflow(ref: WorkflowRecommendation, funding: FundingWorkflowDefinition | undefined, enabled?: Partial<Record<string, boolean>>) {
  const definition = workflowDefinition(ref, funding);
  if (!definition || (funding && ref.id === funding.id && fundingWorkflowIssue(funding))) return false;
  return definition.steps.every((step) => {
    const key = workflowToolKey(step);
    return key && enabled?.[key] !== false;
  });
}
