import host from "../../fixtures/host.json";
import type {
  BalanceProof, CatalogSnapshot, ContentDecision, ContentEntry, Dated, ExperienceProposal, ProposalBlock, RouteDecision, Scope,
} from "../contracts/domain";
import { isContextProposal, isExperienceProposal } from "../contracts/model";
import { isHomeGoalSummary, type GoalProgress } from "../contracts/goal-progress";
import { isPortfolioSummary, type PortfolioSnapshot } from "../contracts/portfolio";
import { availableRoutingIntents, routingQuestions } from "../contracts/routing-intents";
import { contentCatalog, lookupContent, retirementReminderCandidate } from "./content";

export class Rejected extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function requireCheck(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Rejected(code);
}

function sameScope(a: Scope, b: Scope): boolean {
  return a.principalId === b.principalId && a.personaId === b.personaId && a.conversationId === b.conversationId && a.turnId === b.turnId;
}

export function checkFresh(value: Dated & { scope: Scope }, scope: Scope, now: number) {
  requireCheck(sameScope(value.scope, scope), "SCOPE_MISMATCH");
  requireCheck(value.issuedAt <= now && value.expiresAt > now, "DECISION_EXPIRED");
}

export function verifyContextProposal(value: unknown, catalog: CatalogSnapshot, scope: Scope, now: number, canCreateRule = false) {
  requireCheck(isContextProposal(value), "ROUTE_SCHEMA_INVALID");
  checkFresh(catalog, scope, now);
  requireCheck(
    value.catalogSnapshotId === catalog.snapshotId && value.catalogVersion === catalog.catalog.catalogVersion,
    "CATALOG_MISMATCH",
  );
  const replyText = value.replyText?.trim();
  if (value.status === "reply") {
    requireCheck(value.clarificationQuestion === null, "ROUTE_STATUS_SHAPE_INVALID");
    requireCheck(replyText, "CHAT_REPLY_REQUIRED");
    return { status: "reply" as const, intentId: null, replyText };
  }
  requireCheck((value.intentId === "create_rule") === (value.status === "create_rule"), "ROUTE_INTENT_MISMATCH");
  if (value.status === "create_rule") {
    requireCheck(canCreateRule, "RULE_CREATION_UNAVAILABLE");
    requireCheck(value.clarificationQuestion === null, "ROUTE_STATUS_SHAPE_INVALID");
    return { status: "create_rule" as const, intentId: "create_rule" as const };
  }
  if (value.status === "no_match") {
    requireCheck(value.intentId === null && value.clarificationQuestion === null, "ROUTE_STATUS_SHAPE_INVALID");
    return { status: "no_match" as const, intentId: null, replyText };
  }
  const definition = availableRoutingIntents(catalog.catalog, canCreateRule).find(({ intentId }) => intentId === value.intentId);
  if (value.intentId) requireCheck(definition && definition.contextId !== null, "CONTEXT_NOT_ACTIVE");
  if (value.status === "clarify" || value.clarificationQuestion !== null) {
    const question = value.clarificationQuestion;
    requireCheck(question && routingQuestions.includes(question), "CLARIFICATION_NOT_ALLOWED");
    return { status: "clarify" as const, intentId: null, possibleIntentId: definition?.intentId, clarificationQuestion: question };
  }
  requireCheck(definition && definition.contextId !== null, "ROUTE_STATUS_SHAPE_INVALID");
  return {
    status: "selected" as const,
    intentId: definition.intentId,
    contextId: definition.contextId,
    intent: { topic: definition.label, task: definition.task, summary: value.summary },
  };
}

export function verifyRoute(route: RouteDecision, catalog: CatalogSnapshot, scope: Scope, routerRunId: string | null, now: number) {
  checkFresh(route, scope, now);
  checkFresh(catalog, scope, now);
  requireCheck(
    route.catalogSnapshotId === catalog.snapshotId && route.catalogVersion === catalog.catalog.catalogVersion,
    "CATALOG_MISMATCH",
  );
  requireCheck(route.routerRunId === routerRunId, "ROUTER_RUN_MISMATCH");
  requireCheck(catalog.catalog.contexts.some((context) => context.active && context.contextId === route.contextId), "CONTEXT_NOT_ACTIVE");
}

export type ResolvedBlock = { proposal: ProposalBlock; content: ContentEntry[] };
export type VerifiedExperience = {
  proposal: ExperienceProposal;
  blocks: ResolvedBlock[];
  followUps: ContentEntry["followUps"];
  contentOrder: string[];
};

const readyIntros = new Set(["explanation", "comparison", "steps", "summary"]);
export function verifyExperience(
  value: unknown, decision: ContentDecision, route: RouteDecision, scope: Scope, composerRunId: string,
  proof: BalanceProof | null, now: number, portfolio?: PortfolioSnapshot, goalProgress?: GoalProgress,
): VerifiedExperience {
  requireCheck(isExperienceProposal(value), "SCHEMA_INVALID");
  checkFresh(decision, scope, now);
  checkFresh(route, scope, now);
  requireCheck(value.decisionId === decision.decisionId, "DECISION_MISMATCH");
  requireCheck(decision.routeDecisionId === route.routeDecisionId && decision.contextId === route.contextId, "ROUTE_MISMATCH");
  requireCheck(decision.composerRunId === composerRunId, "COMPOSER_RUN_MISMATCH");
  requireCheck(decision.catalogVersion === contentCatalog.catalogVersion, "CATALOG_VERSION_MISMATCH");

  const { status, blocks, clarificationQuestion, introKey, followUpIds } = value;
  if (goalProgress && isHomeGoalSummary(route)) {
    requireCheck(status === "ready" && blocks.some(({ component }) => component === "PznGoalProgress"), "GOAL_PROGRESS_CARD_REQUIRED");
  }
  if (status === "ready") {
    requireCheck(blocks.length && clarificationQuestion === null && readyIntros.has(introKey), "STATUS_SHAPE_INVALID");
  } else {
    requireCheck(!blocks.length && !followUpIds.length && introKey === (status === "clarify" ? "clarification" : "no_match"), "STATUS_SHAPE_INVALID");
    requireCheck(status === "no_match" ? clarificationQuestion === null
      : clarificationQuestion && host.clarificationQuestions.includes(clarificationQuestion), "CLARIFICATION_NOT_ALLOWED");
  }

  const candidateById = new Map(decision.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const selected = new Set<string>();
  const blockIds = new Set<string>();
  const ranks: number[] = [];
  const resolved = blocks.map((block) => {
    const { component, candidateIds } = block;
    requireCheck(!blockIds.has(block.blockId), "DUPLICATE_BLOCK_ID");
    blockIds.add(block.blockId);
    requireCheck(candidateIds.length === (component === "PznComparison" ? 2 : 1), component === "PznComparison"
      ? "COMPARISON_CARDINALITY" : "COMPONENT_CARDINALITY");
    const content = candidateIds.map((id) => {
      const candidate = candidateById.get(id);
      requireCheck(candidate, "CANDIDATE_NOT_ELIGIBLE");
      requireCheck(!selected.has(id), "DUPLICATE_CANDIDATE");
      selected.add(id);
      ranks.push(candidate.tsRank);
      const entry = lookupContent(candidate);
      requireCheck(entry, "CONTENT_MISSING_WITHDRAWN_OR_REVISED");
      requireCheck(entry.allowedComponents.includes(component), "COMPONENT_NOT_ALLOWED");
      if (entry.portfolioData) requireCheck(portfolio && isPortfolioSummary(route), "PORTFOLIO_SNAPSHOT_REQUIRED");
      return entry;
    });

    if (component === "PznComparison") {
      const [left, right] = content;
      requireCheck(left.comparisonGroup && left.comparisonGroup === right.comparisonGroup, "COMPARISON_GROUP_MISMATCH");
      requireCheck(left.comparisonFields.length && left.comparisonFields.length === right.comparisonFields.length
        && left.comparisonFields.every(({ fieldId, label }, index) => {
          const counterpart = right.comparisonFields[index];
          return fieldId === counterpart.fieldId && label === counterpart.label;
        }), "COMPARISON_FIELDS_MISMATCH");
    }
    if (component === "PznStepList") requireCheck(content[0].steps.length, "STEPS_UNAVAILABLE");
    if (component === "PznGoalProgress") requireCheck(goalProgress && isHomeGoalSummary(route), "GOAL_PROGRESS_REQUIRED");
    if (component === "PznMetricSummary") {
      requireCheck(proof, "METRIC_PROOF_REQUIRED");
      requireCheck(sameScope(proof.scope, scope) && proof.toolId === content[0].metricSpec?.toolId
        && proof.composerRunId === composerRunId && proof.decisionId === decision.decisionId
        && proof.routeDecisionId === route.routeDecisionId && proof.contextId === route.contextId
        && Date.parse(proof.observedAt) >= decision.issuedAt && Date.parse(proof.observedAt) <= now
        && proof.expiresAt > now, "METRIC_PROOF_INVALID");
      const actual = new Set(proof.values.map((value) => value.metricKey));
      requireCheck(actual.size === proof.values.length
        && content[0].metricSpec.metricKeys.every((key) => actual.has(key)), "METRIC_VALUES_INCOMPLETE");
    }
    return { proposal: block, content };
  });

  if (decision.selectionMode === "preserve_ts_rank") {
    requireCheck(ranks.every((rank, index) => index === 0 || ranks[index - 1] < rank), "TS_ORDER_VIOLATION");
  }
  const permittedFollowUps = new Map(resolved.flatMap((block) => block.content).flatMap((entry) => (
    entry.followUps.map((followUp) => [followUp.followUpId, followUp] as const)
  )));
  const showsBeneficiaryGuide = resolved.some(({ proposal, content }) => (
    proposal.component === "PznStepList" && content[0].contentId === "beneficiary_update"
  ));
  const followUps = followUpIds.map((id) => {
    const followUp = permittedFollowUps.get(id);
    requireCheck(followUp, "FOLLOW_UP_NOT_ALLOWED");
    return followUp;
  }).filter(({ followUpId }) => !showsBeneficiaryGuide || followUpId !== "fu_beneficiary_steps");

  const showsRetirementLesson = resolved.some(({ content }) => content.some(({ contentId }) => contentId === "retirement_learning"));
  const reminder = showsRetirementLesson ? retirementReminderCandidate(decision, route) : undefined;
  if (reminder) {
    const entry = lookupContent(reminder);
    requireCheck(entry && entry.allowedComponents.includes("PznContentCard"), "BENEFICIARY_REMINDER_UNAVAILABLE");
    if (!selected.has(reminder.candidateId)) {
      const insertBefore = decision.selectionMode === "preserve_ts_rank" ? resolved.findIndex(({ proposal }) => (
        candidateById.get(proposal.candidateIds[0])!.tsRank > reminder.tsRank
      )) : -1;
      resolved.splice(insertBefore < 0 ? resolved.length : insertBefore, 0, {
        proposal: { blockId: "beneficiary_reminder", component: "PznContentCard", candidateIds: [reminder.candidateId], variant: "compact" },
        content: [entry],
      });
    }
    const actions = new Map([...entry.followUps, ...followUps].map((action) => [action.followUpId, action]));
    followUps.splice(0, followUps.length, ...[...actions.values()].slice(0, 3));
  }
  const contentOrder = resolved.flatMap(({ content }) => content.map(({ contentId }) => contentId));
  return { proposal: value, blocks: resolved, followUps, contentOrder };
}
