import { canOfferWorkflow, customerWorkflow } from "../../packages/contracts/customer-workflows";
import { fundingPreviewApplies, fundingPreviewWorkflow, type WorkflowCandidate, type WorkflowRecommendation,
  type TreatmentRecommendations, type WorkflowLaunch } from "../../packages/contracts/funding-workflow";
import type { ToolSetup } from "../../packages/contracts/tool-setup";
import { nextStepContext, pendingActionsContext, workspaceFundingContext } from "../../packages/contracts/workspace";
import { lookupContent, resolveCandidates } from "../../packages/experience/content";
import { requireCheck } from "../../packages/experience/verify";
import type { Store, TurnRecord } from "./store";

function offeredByContent(item: WorkflowCandidate, contextId: string, displayed: readonly string[]) {
  return item.forContentIds ? item.forContentIds.some((id) => displayed.includes(id))
    : item.id === fundingPreviewWorkflow.recommendation.id && fundingPreviewApplies(contextId, displayed);
}

export function offeredWorkflows(turn: TurnRecord, displayed: readonly string[]): WorkflowRecommendation[] {
  const decision = turn.decision;
  if (!decision) return [];
  return (decision.workflowRecommendations ?? []).flatMap((item) => {
    if (!offeredByContent(item, decision.contextId, displayed)
      || !canOfferWorkflow(item, turn.toolSetup?.fundingWorkflow, turn.toolSetup?.enabled)) return [];
    const registered = customerWorkflow(item);
    return registered ? [registered.recommendation] : [];
  });
}

export function workflowOfferSource(store: Store, turn: TurnRecord, launch: WorkflowLaunch, now: number) {
  const source = launch.sourceExperienceId !== undefined
    ? store.experience(launch.sourceExperienceId, turn.scope.principalId).turn
    : store.turn(launch.sourceOverviewTurnId);
  const expiry = launch.sourceOverviewTurnId
    ? source && workspaceFundingContext(source.origin) ? source.decision?.expiresAt : undefined
    : source?.public.experience?.expiresAt;
  requireCheck(source && source.scope.principalId === turn.scope.principalId
    && source.scope.conversationId === turn.scope.conversationId && source.scope.personaId === turn.scope.personaId
    && expiry !== undefined && expiry > now, "FUNDING_OFFER_EXPIRED");
  requireCheck(offeredWorkflows(source, source.trace.finalOrder ?? []).some((item) =>
    item.id === launch.recommendation.id && item.version === launch.recommendation.version), "WORKFLOW_NOT_OFFERED");
  return { source, expiry };
}

export function nextStepRecommendation(response: TreatmentRecommendations, setup: ToolSetup | undefined, contextId: string = nextStepContext, renderedEntries?: Parameters<typeof resolveCandidates>[1]) {
  const ids = response.recommendations.flatMap((item) => item.kind === "content" ? [item.id] : []);
  const { candidates, rejections } = resolveCandidates(ids, renderedEntries);
  const content = candidates.map(lookupContent).find((entry) => entry?.allowedComponents.includes("PznContentCard")
    && entry.kind !== "promotion" && !entry.portfolioData && !entry.metricSpec
    && (contextId !== pendingActionsContext || entry.contentId === "fund_account"));
  const workflow = content && response.recommendations.find((item) =>
    item.kind === "workflow" && item.id === fundingPreviewWorkflow.recommendation.id
    && offeredByContent(item, contextId, [content.contentId]) && canOfferWorkflow(item, setup?.fundingWorkflow, setup?.enabled));
  return { ids, candidates, rejections, content, workflow: workflow?.kind === "workflow" ? workflow : undefined };
}
