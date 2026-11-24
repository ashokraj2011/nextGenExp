import { defaultAgentFundingWorkflow, fundingPreviewApplies, fundingToolKey, fundingWorkflowIssue, resolveFundingWorkflow,
  type TreatmentRecommendations, type WorkflowLaunch } from "../../packages/contracts/funding-workflow";
import type { ToolSetup } from "../../packages/contracts/tool-setup";
import { nextStepContext, pendingActionsContext, workspaceFundingContext } from "../../packages/contracts/workspace";
import { lookupContent, resolveCandidates } from "../../packages/experience/content";
import { requireCheck } from "../../packages/experience/verify";
import type { Store, TurnRecord } from "./store";

export function fundingRecommendation(turn: TurnRecord, contentOrder: readonly string[]) {
  const contextId = turn.decision?.contextId;
  if (contextId && fundingPreviewApplies(contextId, contentOrder)) {
    return turn.decision?.workflowRecommendations?.find((item) => resolveFundingWorkflow(item, turn.toolSetup?.fundingWorkflow));
  }
}

export function fundingOfferExpiry(store: Store, turn: TurnRecord, launch: WorkflowLaunch, now: number) {
  const source = launch.sourceExperienceId !== undefined
    ? store.experience(launch.sourceExperienceId, turn.scope.principalId).turn
    : store.turn(launch.sourceOverviewTurnId);
  const expiry = launch.sourceOverviewTurnId
    ? source && workspaceFundingContext(source.origin) ? source.decision?.expiresAt : undefined
    : source?.public.experience?.expiresAt;
  requireCheck(source && source.scope.principalId === turn.scope.principalId
    && source.scope.conversationId === turn.scope.conversationId && source.scope.personaId === turn.scope.personaId
    && expiry !== undefined && expiry > now, "FUNDING_OFFER_EXPIRED");
  const recommendation = fundingRecommendation(source, source.trace.finalOrder ?? []);
  requireCheck(recommendation?.id === launch.recommendation.id && recommendation.version === launch.recommendation.version,
    "FUNDING_WORKFLOW_NOT_OFFERED");
  return expiry;
}

export function nextStepRecommendation(response: TreatmentRecommendations, setup: ToolSetup | undefined, contextId: string = nextStepContext) {
  const ids = response.recommendations.flatMap((item) => item.kind === "content" ? [item.id] : []);
  const { candidates, rejections } = resolveCandidates(ids);
  const content = candidates.map(lookupContent).find((entry) => entry?.allowedComponents.includes("PznContentCard")
    && entry.kind !== "promotion" && !entry.portfolioData && !entry.metricSpec
    && (contextId !== pendingActionsContext || entry.contentId === "fund_account"));
  const workflow = content && fundingPreviewApplies(contextId, [content.contentId])
    ? response.recommendations.find((item) => {
      if (item.kind !== "workflow") return false;
      const definition = resolveFundingWorkflow(item, setup?.fundingWorkflow ?? defaultAgentFundingWorkflow);
      return definition && !fundingWorkflowIssue(definition)
        && definition.steps.every((step) => {
          const key = fundingToolKey(step);
          return key && setup?.enabled[key] !== false;
        });
    })
    : undefined;
  return { ids, candidates, rejections, content, workflow: workflow?.kind === "workflow" ? workflow : undefined };
}
