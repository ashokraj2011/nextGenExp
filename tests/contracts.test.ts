import { test } from "node:test";
import assert from "node:assert/strict";
import type { BalanceProof, CatalogSnapshot, ContentDecision, ContextSelectionProposal, ExperienceProposal, RouteDecision, Scope } from "../packages/contracts/domain";
import { leavingWorkQuestion } from "../packages/contracts/routing-intents";
import { validatePznSurface } from "../packages/contracts/surface";
import { contentCatalog, resolveCandidates } from "../packages/experience/content";
import { compileExperience } from "../packages/experience/compile";
import { verifyContextProposal, verifyExperience, verifyRoute } from "../packages/experience/verify";
import { activeContextCatalog } from "../packages/ts-adapter";

const scope: Scope = { principalId: "principal", personaId: "demo-learner", conversationId: "conversation", turnId: "turn" };
const now = 100_000;
const intent = { topic: "balances", task: "compare", summary: "Diagnostic intent" } as const;
const life = { issuedAt: now - 50, expiresAt: now + 300_000 };
const catalog: CatalogSnapshot = { ...life, scope, catalog: activeContextCatalog, snapshotId: "catalog_current" };
const route: RouteDecision = {
  ...life, scope, routeDecisionId: "route_current", contextId: "balance", catalogSnapshotId: catalog.snapshotId, catalogVersion: activeContextCatalog.catalogVersion,
  routerRunId: "router_run", intent,
};
const decision: ContentDecision = {
  ...life, scope, routeDecisionId: route.routeDecisionId, contextId: "balance", decisionId: "decision_current",
  catalogVersion: contentCatalog.catalogVersion, composerRunId: "composer_run", selectionMode: "semantic_rerank", partial: false,
  candidates: resolveCandidates(["balance_available_definition", "balance_current_definition", "portfolio_explanation", "balance_metric_template"]).candidates,
};

const contextProposal: ContextSelectionProposal = {
  schemaVersion: "1.1", status: "selected", intentId: "compare_balances", catalogSnapshotId: catalog.snapshotId,
  catalogVersion: activeContextCatalog.catalogVersion, summary: intent.summary,
  clarificationQuestion: null,
};
const proposal: ExperienceProposal = {
  schemaVersion: "1.0", decisionId: decision.decisionId, status: "ready", intent, introKey: "comparison", clarificationQuestion: null,
  blocks: [{ blockId: "b1", component: "PznComparison", candidateIds: [decision.candidates[1].candidateId, decision.candidates[0].candidateId], variant: "expanded" }],
  followUpIds: ["fu_compare_balances"],
};

test("routing rejects foreign, stale and inactive catalog decisions and run substitutions", () => {
  const verified = verifyContextProposal(contextProposal, catalog, scope, now);
  assert.equal(verified.status, "selected");
  assert.equal(verified.contextId, "balance");
  assert.equal(verified.intent.task, "compare");
  const inactive = { ...catalog, catalog: { ...catalog.catalog, contexts: catalog.catalog.contexts.filter(({ contextId }) => contextId !== "balance") } };
  assert.throws(() => verifyContextProposal(contextProposal, inactive, scope, now), /CONTEXT_NOT_ACTIVE/);
  assert.throws(() => verifyContextProposal({ ...contextProposal, intentId: "unlisted_intent" }, catalog, scope, now), /ROUTE_SCHEMA_INVALID/);
  assert.throws(() => verifyContextProposal({ ...contextProposal, catalogVersion: "old" }, catalog, scope, now), /CATALOG_MISMATCH/);
  assert.throws(() => verifyContextProposal(contextProposal, catalog, { ...scope, conversationId: "foreign" }, now), /SCOPE_MISMATCH/);
  assert.throws(() => verifyContextProposal(contextProposal, { ...catalog, expiresAt: now }, scope, now), /DECISION_EXPIRED/);
  assert.throws(() => verifyRoute(route, catalog, scope, "compose_run", now), /ROUTER_RUN_MISMATCH/);
});

test("rule creation requires the enabled host capability and a matching router intent", () => {
  const create = { ...contextProposal, status: "create_rule", intentId: "create_rule" };
  assert.equal(verifyContextProposal(create, catalog, scope, now, true).status, "create_rule");
  assert.throws(() => verifyContextProposal(create, catalog, scope, now), /RULE_CREATION_UNAVAILABLE/);
  assert.throws(() => verifyContextProposal({ ...create, clarificationQuestion: "Which rule?" }, catalog, scope, now, true), /ROUTE_STATUS_SHAPE_INVALID/);
  assert.throws(() => verifyContextProposal({ ...create, status: "no_match" }, catalog, scope, now, true), /ROUTE_INTENT_MISMATCH/);
});

test("an approved clarification keeps a possible intent from authorizing a route", () => {
  const uncertain = { ...contextProposal, intentId: "retirement_learning", clarificationQuestion: leavingWorkQuestion };
  for (const status of ["selected", "clarify"]) {
    assert.deepEqual(verifyContextProposal({ ...uncertain, status }, catalog, scope, now), {
      status: "clarify", intentId: null, possibleIntentId: "retirement_learning", clarificationQuestion: leavingWorkQuestion,
    });
  }
  assert.throws(() => verifyContextProposal({ ...uncertain, clarificationQuestion: "An unapproved question?" }, catalog, scope, now),
    /CLARIFICATION_NOT_ALLOWED/);
});

test("a conversational reply requires text and cannot select an intent", () => {
  const reply = { ...contextProposal, status: "reply", intentId: null, replyText: "Glad that helped." };
  const expected = { status: "reply", intentId: null, replyText: reply.replyText };
  assert.deepEqual(verifyContextProposal(reply, catalog, scope, now), expected);
  assert.deepEqual(verifyContextProposal({ ...reply, intentId: "show_balance" }, catalog, scope, now), expected);
  assert.throws(() => verifyContextProposal({ ...reply, replyText: "  " }, catalog, scope, now), /CHAT_REPLY_REQUIRED/);
});

test("selection mode controls order and canonical compiler publishes mandatory evidence", () => {
  const run = "composer_run";
  const verified = verifyExperience(proposal, decision, route, scope, run, null, now);
  assert.deepEqual(verified.contentOrder, ["balance_current_definition", "balance_available_definition"]);
  assert.throws(() => verifyExperience(proposal, { ...decision, selectionMode: "preserve_ts_rank" }, route, scope, run, null, now), /TS_ORDER_VIOLATION/);
  assert.throws(() => verifyExperience(proposal, decision, { ...route, contextId: "portsum" }, scope, run, null, now), /ROUTE_MISMATCH/);
  assert.throws(() => verifyExperience(proposal, decision, route, scope, "router_run", null, now), /COMPOSER_RUN_MISMATCH/);
  assert.throws(() => verifyExperience({
    ...proposal, blocks: [{ ...proposal.blocks[0], candidateIds: [decision.candidates[0].candidateId, decision.candidates[2].candidateId] }],
  }, decision, route, scope, run, null, now), /COMPARISON_GROUP_MISMATCH/);
  assert.throws(() => verifyExperience({
    ...proposal, blocks: [{ ...proposal.blocks[0], candidateIds: [decision.candidates[0].candidateId, "promotion_blocked"] }],
  }, decision, route, scope, run, null, now), /CANDIDATE_NOT_ELIGIBLE/);
  const compiled = compileExperience({
    status: "ready", outcome: "ready", introKey: "comparison", question: null, partial: false, expiresAt: life.expiresAt, approved: verified,
  }).display;
  const [comparison] = compiled.blocks;
  assert.equal(comparison.component, "PznComparison");
  assert.equal(comparison.props.sources.length, 2);
  assert.ok(comparison.props.disclosures.length);
  assert.doesNotMatch(JSON.stringify(compiled), /Diagnostic intent/);
  const surface = structuredClone(compiled.messages[0]);
  surface.createSurface.components![0].children.push("dangling");
  assert.throws(() => validatePznSurface(surface, compiled.experienceId), /Invalid experience component references/);
});

test("metric proof requires current run and turn scope before canonical values can be compiled", () => {
  const proof: BalanceProof = {
    scope, toolId: "demo.balance.read", composerRunId: "composer_run", decisionId: decision.decisionId,
    routeDecisionId: route.routeDecisionId, contextId: "balance", callId: "call", fixtureVersion: "fixture",
    observedAt: new Date(now).toISOString(), expiresAt: now + 1000,
    values: [{ metricKey: "available", displayValue: "1250.00", unit: "DEMO_UNITS" }, { metricKey: "current", displayValue: "1500.00", unit: "DEMO_UNITS" }],
  };
  const metricProposal: ExperienceProposal = {
    ...proposal, introKey: "summary", blocks: [{ blockId: "metric", component: "PznMetricSummary", candidateIds: [decision.candidates[3].candidateId], variant: "compact" }],
  };
  assert.throws(() => verifyExperience(metricProposal, decision, route, scope, proof.composerRunId, null, now), /METRIC_PROOF_REQUIRED/);
  assert.throws(() => verifyExperience(metricProposal, decision, route, scope, proof.composerRunId, { ...proof, scope: { ...scope, turnId: "old" } }, now), /METRIC_PROOF_INVALID/);
  assert.throws(() => verifyExperience(metricProposal, decision, route, scope, proof.composerRunId, { ...proof, expiresAt: now }, now), /METRIC_PROOF_INVALID/);
  const approved = verifyExperience(metricProposal, decision, route, scope, proof.composerRunId, proof, now);
  const block = compileExperience({ status: "ready", outcome: "ready", introKey: "summary", question: null, partial: false, expiresAt: life.expiresAt, approved, proof }).display.blocks[0];
  assert.equal(block.component, "PznMetricSummary");
  assert.equal(block.props.values[0].displayValue, "1250.00");
});
