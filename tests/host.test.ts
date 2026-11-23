import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gatewayFromEnv } from "../apps/server/gateway";
import type { IncomingHttpHeaders } from "node:http";
import { startApp } from "../apps/server/http";
import type { Bootstrap, TurnAccepted, TurnView, ConversationView } from "../packages/contracts/api";
import type { TurnPayloads } from "../packages/contracts/inspector";
import type { GlossaryCondition } from "../packages/contracts/rule-glossary";
import { demoExperiencesQuestion, leavingWorkQuestion, portfolioSummaryQuestion, retirementQuestion } from "../packages/contracts/routing-intents";
import {
  defaultToolSetup, type MockCcreRule, type ToolSetup, type ToolSetupView, type TreatmentPreview, type TreatmentPreviewInput,
} from "../packages/contracts/tool-setup";
import { actionFor, testClient, testProject } from "./client";
import { startFixtureGateway, type TestInterceptor } from "./gateway-fixture";
import { mockRuleGlossary } from "../packages/rule-glossary";
import { fixturePortfolioSnapshotProvider, type PortfolioSnapshotProvider } from "../packages/portfolio-snapshot";
import { fixtureGoalProgressProvider, type GoalProgressProvider } from "../packages/goal-progress";

async function fixture(intercept?: TestInterceptor, opts: {
  noGateway?: boolean;
  inspectorEnabled?: boolean;
  preserve?: boolean;
  gatewayEnv?: NodeJS.ProcessEnv;
  authorize?: (headers: IncomingHttpHeaders) => boolean;
  portfolioSnapshots?: PortfolioSnapshotProvider;
  goalProgressProvider?: GoalProgressProvider;
  openAiProfile?: boolean;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pzn-host-test-"));
  const gateway = await startFixtureGateway(intercept, opts.authorize);
  const settings = opts.gatewayEnv ? gatewayFromEnv({
    LLM_BASE_URL: gateway.settings.baseUrl, LLM_MODEL: gateway.settings.model,
    LLM_API_KEY: gateway.settings.apiKey, ...opts.gatewayEnv,
  }) : gateway.settings;
  const options = {
    projectRoot: fileURLToPath(testProject), dataDir: dir,
    gateway: opts.noGateway || !settings ? null : opts.openAiProfile ? { ...settings, profile: "openai" as const } : settings, mode: "test",
    selectionMode: opts.preserve ? "preserve_ts_rank" : "semantic_rerank",
    inspectorEnabled: opts.inspectorEnabled,
    portfolioSnapshots: opts.portfolioSnapshots,
    goalProgressProvider: opts.goalProgressProvider,
  } as const;
  let app = await startApp(options);
  const client = await testClient(app.url);
  return {
    gateway, client, dataDir: dir,
    async restart(prepare?: (dir: string) => void, overrides: { inspectorEnabled?: boolean } = {}) {
      await app.close();
      prepare?.(dir);
      app = await startApp({ ...options, ...overrides });
      return testClient(app.url, client.cookie);
    },
    async close() {
      await app.close();
      await gateway.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("tool setup previews built-in and configured Treatment Selector responses without a gateway", async (t) => {
  const f = await fixture(undefined, { noGateway: true });
  t.after(() => f.close());
  const { client } = f;
  const settings = await client.request<ToolSetupView>("/api/admin/tools");
  assert.deepEqual(settings.setup, defaultToolSetup);
  assert.ok(!JSON.stringify(settings).includes("DEMO-MID"));
  const previewPath = "/api/admin/treatment-preview";
  const input: TreatmentPreviewInput = {
    scenarioId: "cross-turn-change", contextId: "app-home", personaId: "demo-returning", ordinal: 2, enabled: true, output: null,
  };
  assert.deepEqual(await client.request(previewPath, input), {
    status: "ranked", source: "fixture", contentIds: ["portfolio_explanation"],
  });
  assert.deepEqual(await client.request(previewPath, { ...input, output: { mode: "empty" } }), {
    status: "empty", source: "override", contentIds: [],
  });
  assert.deepEqual(await client.request(previewPath, { ...input, output: { mode: "timeout" } }), {
    status: "timeout", source: "override",
  });
  assert.deepEqual(await client.request(previewPath, { ...input, enabled: false }), { status: "disabled" });
  await client.request(previewPath, { ...input, contextId: "archived-help" }, 400);
  await client.request(previewPath, { ...input, personaId: "demo-learner" }, 400);
  const invalid: ToolSetup = {
    ...defaultToolSetup,
    treatmentOverrides: [{
      scenarioId: "normal", contextId: "balance", output: { mode: "ranked", contentIds: ["withdrawn_education"] },
    }],
  };
  await client.request("/api/admin/tools", invalid, 400);
  await client.request("/api/admin/tools", { ...invalid, treatmentOverrides: [invalid.treatmentOverrides[0], invalid.treatmentOverrides[0]] }, 400);
  assert.equal((await client.response("/api/admin/tools", defaultToolSetup, { Origin: "https://outside.invalid" })).status, 403);
  assert.deepEqual((await client.request<ToolSetupView>("/api/admin/tools")).setup, defaultToolSetup);
});

test("saved tool settings are isolated by browser and take effect on subsequent sfield turns", async (t) => {
  const f = await fixture(({ envelope }) => envelope.inputType === "PznContextRoutingInput" ? { delayMs: 240 } : undefined);
  t.after(() => f.close());
  const { client } = f;
  const path = "/api/admin/tools";
  const conversation = await client.conversation();
  const message = "Compare available and current balance.";
  const contentIds = ["balance_current_definition", "balance_available_definition"];
  const rank: ToolSetup = {
    enabled: { ...defaultToolSetup.enabled, propensity: false },
    treatmentOverrides: [{ scenarioId: "normal", contextId: "balance", output: { mode: "ranked", contentIds } }],
  };
  await client.request(path, rank);
  const accepted = await client.submit(conversation.id, message);
  const timeout: ToolSetup = {
    ...rank, treatmentOverrides: [{ scenarioId: "normal", contextId: "balance", output: { mode: "timeout" } }],
  };
  await client.request(path, timeout);
  const ranked = await client.wait(accepted);
  assert.equal(ranked.turn.status, "completed");
  assert.equal(ranked.trace.propensity?.status, "unavailable");
  const rankedPayloads = await client.request<TurnPayloads>("/api/debug/payloads/" + ranked.turn.id);
  assert.equal(rankedPayloads.topicScores, null);
  assert.equal(ranked.trace.ts?.source, "override");
  assert.deepEqual(ranked.trace.ts?.baseline, contentIds);
  assert.ok(ranked.trace.tsScopeId);

  const unrelated = await client.ask(conversation.id, "Explain the fictional portfolio view.");
  assert.equal(unrelated.trace.ts?.source, "fixture");
  const failed = await client.ask(conversation.id, message);
  assert.equal(failed.turn.failureCode, "ts_unavailable");
  assert.ok(failed.trace.failures.some(({ code }) => code === "TS_TIMEOUT"));
  const failedPayloads = await client.request<TurnPayloads>("/api/debug/payloads/" + failed.turn.id);
  assert.deepEqual(failedPayloads.treatment?.mockInput?.data, { mid: "DEMO-MID-1001", context: "balance" });
  assert.match(JSON.stringify(failedPayloads.treatment?.error?.data), /TS_TIMEOUT/);
  assert.equal(failedPayloads.composer, null);

  const restored = await f.restart();
  assert.deepEqual((await restored.request<ToolSetupView>(path)).setup, timeout);
  const other = await restored.response(path, undefined, { Cookie: "" });
  assert.deepEqual((await other.json() as ToolSetupView).setup, defaultToolSetup);
  await restored.request(path, rank);
  const retried = await restored.request<TurnAccepted>("/api/turns/" + failed.turn.id + "/retry", { clientRequestId: randomUUID() }, 202);
  assert.deepEqual((await restored.wait(retried)).trace.ts?.baseline, contentIds);

  await restored.request(path, { ...defaultToolSetup, enabled: { ...defaultToolSetup.enabled, selection: false } });
  const disabled = await restored.ask(conversation.id, message);
  assert.equal(disabled.turn.failureCode, "ts_unavailable");
  assert.ok(disabled.trace.failures.some(({ code }) => code === "TOOL_DISABLED"));

  await restored.request(path, { ...defaultToolSetup, enabled: { ...defaultToolSetup.enabled, balances: false } });
  const metric = await restored.ask(conversation.id, "Show my synthetic demo balance summary.");
  assert.equal(metric.turn.failureCode, "metric_unavailable");
  assert.equal(metric.trace.metricReadSucceeded, false);

  await restored.request(path, { ...defaultToolSetup, enabled: { ...defaultToolSetup.enabled, catalog: false } });
  const missing = await restored.ask(conversation.id, message);
  assert.equal(missing.turn.failureCode, "catalog_unavailable");
});

test("CCRE mock rules filter ranked treatments the same way in preview and chat", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { client } = f;
  const contentIds = ["balance_current_definition", "balance_available_definition"];
  const rule: MockCcreRule = {
    scenarioId: "normal", contextId: "balance", contentId: contentIds[1], name: "Available definition for learners",
    source: "Opaque CCRE source kept for integration.",
    condition: { kind: "persona_is", personaId: "demo-learner" },
  };
  const output = { mode: "ranked", contentIds } as const;
  const input: TreatmentPreviewInput = {
    scenarioId: "normal", contextId: "balance", personaId: "demo-learner", ordinal: 1, enabled: true, output, ccreRules: [rule],
  };
  const preview = "/api/admin/treatment-preview";
  const matched = await client.request<TreatmentPreview>(preview, input);
  assert.ok(matched.status === "ranked");
  assert.deepEqual(matched.contentIds, contentIds);
  assert.equal(matched.ccre?.results[0].outcome, "matched");

  const excluded = await client.request<TreatmentPreview>(preview, { ...input, personaId: "demo-returning" });
  assert.ok(excluded.status === "ranked");
  assert.deepEqual(excluded.contentIds, [contentIds[0]]);
  assert.deepEqual(excluded.ccre, {
    beforeRules: contentIds,
    results: [{ contentId: rule.contentId, name: rule.name, outcome: "excluded" }],
  });
  const outsideList = await client.request<TreatmentPreview>(preview, {
    ...input, output: { mode: "ranked", contentIds: [contentIds[0]] },
  });
  assert.ok(outsideList.status === "ranked");
  assert.deepEqual(outsideList.contentIds, [contentIds[0]]);
  assert.equal(outsideList.ccre?.results[0].outcome, "outside_list");

  const secondTurnRule: MockCcreRule = { ...rule, condition: { kind: "from_turn", ordinal: 2 } };
  for (const ordinal of [1, 2]) {
    const response = await client.request<TreatmentPreview>(preview, { ...input, ordinal, ccreRules: [secondTurnRule] });
    assert.ok(response.status === "ranked");
    assert.equal(response.contentIds.includes(rule.contentId), ordinal === 2);
  }

  const path = "/api/admin/tools";
  const setup: ToolSetup = { ...defaultToolSetup, treatmentOverrides: [{ scenarioId: "normal", contextId: "balance", output }], ccreRules: [rule] };
  await client.request(path, { ...setup, ccreRules: [rule, rule] }, 400);
  await client.request(path, { ...setup, ccreRules: [{ ...rule, contentId: "promotion_blocked" }] }, 400);
  await client.request(path, { ...setup, ccreRules: [{ ...rule, scenarioId: "cross-turn-change" }] }, 400);
  await client.request(preview, { ...input, ccreRules: [{ ...rule, contextId: "portsum" }] }, 400);
  assert.deepEqual(await client.request<ToolSetup>(path, setup), setup);

  const message = "Compare available and current balance.";
  const learner = await client.conversation("normal", "demo-learner");
  const passing = await client.ask(learner.id, message);
  assert.equal(passing.turn.experience?.blocks[0].component, "PznComparison");
  assert.deepEqual(passing.trace.ts?.baseline, contentIds);

  const returning = await client.conversation("normal", "demo-returning");
  const failing = await client.ask(returning.id, message);
  assert.equal(failing.turn.experience?.outcome, "no_match");
  assert.deepEqual(failing.trace.ts?.baseline, excluded.contentIds);
  assert.ok(failing.trace.ts?.rejections.some(({ contentId, reasonCode }) => contentId === rule.contentId && reasonCode === "RULE_FALSE"));
  const payloads = await client.request<TurnPayloads>("/api/debug/payloads/" + failing.turn.id);
  assert.deepEqual(payloads.treatment?.result?.data, excluded.contentIds);
  assert.deepEqual(payloads.treatment?.ccre?.data, excluded.ccre);
  assert.ok(!JSON.stringify(payloads).includes(rule.source!));
  const composer = f.gateway.calls.at(-1)?.envelope.eligible;
  assert.deepEqual(composer?.candidates.map(({ title }) => title), ["Current balance: demo definition"]);

  const restarted = await f.restart();
  assert.deepEqual((await restarted.request<ToolSetupView>(path)).setup.ccreRules, [rule]);
  const restored = await restarted.request<TurnPayloads>("/api/debug/payloads/" + failing.turn.id);
  assert.deepEqual(restored.treatment?.ccre?.data, excluded.ccre);
});

test("the inspector setting also closes the tool setup page, API, and chat editor", async (t) => {
  const f = await fixture(undefined, { inspectorEnabled: false });
  t.after(() => f.close());
  const { client, gateway } = f;
  assert.equal((await client.response("/admin")).status, 404);
  assert.equal((await client.response("/api/admin/tools")).status, 404);
  assert.equal((await client.response("/api/admin/tools", defaultToolSetup)).status, 404);
  assert.equal((await client.response("/api/admin/treatment-preview", {})).status, 404);
  assert.equal((await client.response("/api/admin/ccre-rules", {})).status, 404);
  const conversation = await client.conversation();
  const accepted = await client.submit(conversation.id, "Create rule");
  await (await client.response(accepted.eventsUrl)).text();
  assert.equal((await client.turn(accepted.turnId)).experience?.outcome, "no_match");
  assert.equal(gateway.calls[0].envelope.canCreateRule, false);
});

test("create rule reads the sfield glossary and uses its attributes for preview and treatment selection", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { client, gateway } = f;
  const conversation = await client.conversation("normal", "demo-returning");
  const toolsPath = "/api/admin/tools";
  const output = { mode: "ranked" as const, contentIds: ["balance_current_definition", "balance_available_definition"] };
  const { glossary: _glossary, ...oldEnabledSettings } = defaultToolSetup.enabled;
  const setup: ToolSetup = { enabled: oldEnabledSettings, treatmentOverrides: [{ scenarioId: "normal", contextId: "balance", output }] };
  await client.request(toolsPath, setup);

  const { turn, trace, events } = await client.ask(conversation.id, "Create rule");
  assert.equal(turn.experience?.outcome, "create_rule");
  const block = { component: "PznRuleCreation", props: { scenarioId: "normal", personaId: "demo-returning", glossary: mockRuleGlossary } };
  assert.deepEqual(turn.experience?.blocks, [block]);
  assert.deepEqual(turn.experience?.messages[0].createSurface.components?.[1], {
    id: "block_1", component: block.component, ...block.props,
  });
  assert.match(events, /event: experience\.ready/);
  assert.match(events, /"progress":"glossary"/);
  assert.equal(trace.routeOutcome, "create_rule");
  assert.deepEqual(trace.components, ["PznRuleCreation"]);
  assert.ok(trace.glossaryScopeId && trace.glossaryScopeId !== trace.catalogScopeId);
  assert.equal(trace.glossaryVersion, mockRuleGlossary.version);
  assert.equal(trace.tsScopeId, null);
  assert.equal(trace.composerRunId, null);
  assert.equal(gateway.calls.length, 1);
  assert.equal(gateway.calls[0].envelope.canCreateRule, true);
  const payloads = await client.request<TurnPayloads>("/api/debug/payloads/" + turn.id);
  assert.match(JSON.stringify(payloads.router?.attempts[0].exchange?.response?.data), /create_rule/);
  assert.equal(payloads.glossary?.tool, "ccre.glossary.get@1.0.0");
  assert.equal(payloads.glossary?.status, "succeeded");
  assert.deepEqual(payloads.glossary?.registryInput.data, { turnRef: turn.id, routerRunId: trace.routerRunId });
  assert.deepEqual(payloads.glossary?.result?.data, mockRuleGlossary);
  assert.equal(payloads.treatment, null);
  assert.equal(payloads.composer, null);

  const before = await client.response(toolsPath);
  const revision = before.headers.get("etag");
  assert.ok(revision);
  assert.deepEqual((await before.json()).setup, setup);
  const rulesPath = "/api/admin/ccre-rules";
  const condition: GlossaryCondition = {
    kind: "attribute", glossaryVersion: mockRuleGlossary.version, namespaceId: "customer", attributeId: "persona",
    operator: "eq", value: "demo-learner",
  };
  const rule: MockCcreRule = {
    scenarioId: "normal", contextId: "balance", contentId: output.contentIds[1], name: "Available balance for learners",
    condition,
  };
  const preview: TreatmentPreviewInput = {
    scenarioId: rule.scenarioId, contextId: rule.contextId, output, personaId: "demo-returning", enabled: true, ordinal: 1,
    ccreRules: [rule],
  };
  const previewPath = "/api/admin/treatment-preview";
  const returningPreview = await client.request<TreatmentPreview>(previewPath, preview);
  assert.ok(returningPreview.status === "ranked");
  assert.equal(returningPreview.ccre?.results[0].outcome, "excluded");
  const onSecondTurn = { ...condition, namespaceId: "conversation", attributeId: "turn_number", operator: "gte" as const, value: 2 };
  for (const ordinal of [1, 2]) {
    const response = await client.request<TreatmentPreview>(previewPath, { ...preview, ordinal, ccreRules: [{ ...rule, condition: onSecondTurn }] });
    assert.ok(response.status === "ranked");
    assert.equal(response.contentIds.includes(rule.contentId), ordinal === 2);
  }
  const returningCondition = { ...condition, attributeId: "is_returning", value: true };
  const returningResult = await client.request<TreatmentPreview>(previewPath, { ...preview, ccreRules: [{ ...rule, condition: returningCondition }] });
  assert.ok(returningResult.status === "ranked");
  assert.equal(returningResult.ccre?.results[0].outcome, "matched");

  await client.request(rulesPath, { ...rule, contextId: "archived-help" }, 400);
  await client.request(rulesPath, { ...rule, condition: { ...condition, attributeId: "unlisted" } }, 400);
  await client.request(rulesPath, { ...rule, condition: { ...condition, operator: "gte" } }, 400);
  await client.request(rulesPath, { ...rule, condition: { ...condition, value: true } }, 400);
  await client.request(rulesPath, { ...rule, condition: { ...condition, glossaryVersion: "stale" } }, 400);
  assert.deepEqual(await client.request(rulesPath, rule), rule);
  assert.deepEqual(await client.request(rulesPath, rule), rule);
  await client.request(rulesPath, { ...rule, name: "Overwriting the rule" }, 409);
  assert.equal((await client.response(toolsPath, { ...setup, treatmentOverrides: [] }, { "If-Match": revision })).status, 412);
  assert.deepEqual((await client.request<ToolSetupView>(toolsPath)).setup, { ...setup, ccreRules: [rule] });

  const after = await client.ask(conversation.id, "Compare available and current balance.");
  assert.deepEqual(after.trace.ts?.baseline, returningPreview.contentIds);
  assert.equal(after.turn.experience?.outcome, "no_match");
  const afterPayloads = await client.request<TurnPayloads>("/api/debug/payloads/" + after.turn.id);
  assert.equal(afterPayloads.glossary, null);

  const restored = await f.restart();
  const savedPayloads = await restored.request<TurnPayloads>("/api/debug/payloads/" + turn.id);
  assert.deepEqual(savedPayloads.glossary, payloads.glossary);
  await restored.request(toolsPath, { ...setup, enabled: { ...setup.enabled, glossary: false }, ccreRules: [rule] });
  const unavailable = await restored.ask(conversation.id, "Create rule");
  assert.equal(unavailable.turn.failureCode, "glossary_unavailable");
  assert.equal(unavailable.turn.experience, undefined);
  assert.equal(unavailable.trace.composerRunId, null);
  const failedPayloads = await restored.request<TurnPayloads>("/api/debug/payloads/" + unavailable.turn.id);
  assert.equal(failedPayloads.glossary?.status, "failed");
});

test("two-stage completion persists source-rich comparison, scopes, SSE replay, and a rerouted follow-up", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { client, gateway } = f;
  const original = await client.conversation("conflicting-propensity");
  const response = await client.ask(original.id, "Compare available and current balance.");
  const { turn, trace, events } = response;
  assert.equal(turn.status, "completed");
  assert.equal(gateway.calls.length, 2);
  assert.equal(trace.selectedContextId, "balance");
  assert.equal(trace.propensity?.scores.find(({ contextId }) => contextId === "portsum")?.score, 0.97);
  assert.equal(new Set([trace.catalogScopeId, trace.routerRunId, trace.tsScopeId, trace.composerRunId]).size, 4);
  assert.equal(trace.routeRun?.tokensReported, true);
  assert.equal(gateway.calls.at(0)?.body.response_format.json_schema?.strict, true);
  assert.equal(gateway.calls.at(0)?.body.tools, undefined);
  assert.equal(gateway.calls.at(1)?.body.tools?.length, 1);
  assert.match(events, /event: experience\.ready/);
  assert.doesNotMatch(events, /Deterministic test intent|DEMO-MID|text_delta|routeDecisionId/);
  const payloadPath = "/api/debug/payloads/" + turn.id;
  const payloads = await client.request<TurnPayloads>(payloadPath);
  const router = payloads.router?.attempts[0].exchange;
  const composer = payloads.composer?.attempts[0].exchange;
  assert.equal(router?.source, "recorded");
  assert.equal(composer?.source, "recorded");
  assert.deepEqual(router?.request.data, gateway.calls[0].body);
  assert.deepEqual(composer?.request.data, gateway.calls[1].body);
  assert.match(JSON.stringify(router?.response?.data), /balance/);
  assert.match(JSON.stringify(composer?.response?.data), /PznComparison/);
  assert.deepEqual(payloads.treatment?.mockInput?.data, { mid: "DEMO-MID-1001", context: "balance" });
  assert.deepEqual(payloads.treatment?.registryInput.data, { turnRef: turn.id, routeDecisionId: trace.routeDecisionId });
  assert.deepEqual(payloads.treatment?.result?.data, trace.ts?.baseline);
  assert.equal((await client.response(payloadPath, undefined, { Cookie: "" })).status, 404);
  const exp = turn.experience!;
  assert.equal(exp.messages[0].version, "1.0");
  const [block] = exp.blocks;
  assert.equal(block.component, "PznComparison");
  assert.equal(block.props.sources.length, 2);
  assert.ok(block.props.disclosures[0].includes("Fictional demonstration only"));
  const seq = events.match(/id: (\d+)\nevent: turn\.accepted/)![1];
  const replay = await (await client.response("/api/turns/" + turn.id + "/events", undefined, { "Last-Event-ID": seq })).text();
  assert.doesNotMatch(replay, /event: turn\.accepted/);
  assert.match(replay, /event: experience\.ready/);
  assert.match(await (await client.response("/api/turns/" + turn.id + "/events?after=9999999")).text(), /event: gap/);

  const portfolio = await client.ask(original.id, "Explain the fictional portfolio view.");
  assert.equal(portfolio.trace.selectedContextId, "portsum");
  assert.notEqual(portfolio.trace.routeDecisionId, trace.routeDecisionId);
  const stale = await client.response("/api/experiences/" + exp.experienceId + "/actions", {
    clientRequestId: randomUUID(), envelope: actionFor(exp),
  });
  assert.equal(stale.status, 409);

  const picked = portfolio.turn.experience!;
  const envelope = actionFor(picked);
  envelope.action.userMessage = "Use forged user text.";
  const path = "/api/experiences/" + picked.experienceId + "/actions";
  const forgedSource = await client.response(path, { clientRequestId: randomUUID(), envelope: {
    ...envelope, action: { ...envelope.action, sourceComponentId: "forged" },
  } });
  assert.equal(forgedSource.status, 400);
  const request = { clientRequestId: randomUUID(), envelope };
  const accepted = await client.request<TurnAccepted>(path, request, 202);
  const fed = await client.wait(accepted);
  assert.equal(fed.trace.selectedContextId, "balance");
  assert.match(fed.turn.message, /available-balance term/);
  assert.equal((await client.request<TurnAccepted>(path, request, 202)).turnId, accepted.turnId);
  const restoredClient = await f.restart();
  const restored = await restoredClient.request<ConversationView>("/api/conversations/" + original.id);
  assert.deepEqual(restored.turns.map((entry) => entry.experience?.experienceId), [exp.experienceId, picked.experienceId, fed.turn.experience?.experienceId]);
  assert.deepEqual(await restoredClient.request<TurnPayloads>(payloadPath), payloads);
});

test("older comparison payloads are verified from the saved run without reissuing either model call", async (t) => {
  const f = await fixture(undefined, { inspectorEnabled: false });
  t.after(() => f.close());
  const conversation = await f.client.conversation();
  const accepted = await f.client.submit(conversation.id, "Compare available and current balance.");
  await (await f.client.response(accepted.eventsUrl)).text();
  assert.equal((await f.client.turn(accepted.turnId)).status, "completed");
  const path = "/api/debug/payloads/" + accepted.turnId;
  assert.equal((await f.client.response(path)).status, 404);
  const client = await f.restart(undefined, { inspectorEnabled: true });
  const payloads = await client.request<TurnPayloads>(path);
  const router = payloads.router?.attempts[0].exchange;
  const composer = payloads.composer?.attempts[0].exchange;
  assert.equal(router?.source, "verified");
  assert.equal(composer?.source, "verified");
  assert.equal(f.gateway.calls.length, 2);
  assert.deepEqual(router?.request.data, f.gateway.calls[0].body);
  assert.deepEqual(composer?.request.data, f.gateway.calls[1].body);
  assert.deepEqual(payloads.treatment?.mockInput?.data, { mid: "DEMO-MID-1001", context: "balance" });
});

test("scenario outcomes distinguish intent-only routing, empty eligibility, partial resolution, and outages", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const cases = [
    { scenario: "normal", message: "Can you help me?", expected: "clarify", route: null },
    { scenario: "normal", message: "Give me the weather forecast.", expected: "no_match", route: null },
    { scenario: "missing-propensity", message: "Explain the balance labels.", expected: "ready", route: "balance" },
    { scenario: "propensity-unavailable", message: "Explain portfolio allocation.", expected: "ready", route: "portsum" },
    { scenario: "empty", message: "Explain balances.", expected: "eligible_empty", route: "balance" },
    { scenario: "ts-unavailable", message: "Explain balances.", expected: "ts_unavailable", route: "balance" },
    { scenario: "catalog-unavailable", message: "Explain balances.", expected: "catalog_unavailable", route: null },
    { scenario: "relevant-blocked", message: "Show the transfer offer.", expected: "ready", route: "app-home" },
  ];
  for (const scenario of cases) {
    const conv = await f.client.conversation(scenario.scenario);
    const result = await f.client.ask(conv.id, scenario.message);
    assert.equal(result.turn.experience?.outcome ?? result.turn.failureCode, scenario.expected);
    assert.equal(result.trace.selectedContextId, scenario.route);
    if (!scenario.route) assert.equal(result.trace.tsScopeId, null);
    if (scenario.scenario === "missing-propensity") {
      assert.equal(result.trace.propensity?.scores.find(({ contextId }) => contextId === "balance")?.score, null);
      assert.equal(result.trace.propensity?.scores.find(({ contextId }) => contextId === "app-home")?.score, 0);
    }
    if (scenario.scenario === "propensity-unavailable") assert.equal(result.trace.propensity?.status, "unavailable");
    if (scenario.scenario === "relevant-blocked") {
      const input = JSON.stringify(f.gateway.calls.at(-1)?.envelope);
      assert.doesNotMatch(input, /promotion_blocked|RULE_FALSE|restricted transfer offer/);
      assert.match(JSON.stringify(result.trace.ts?.rejections), /promotion_blocked/);
      assert.doesNotMatch(JSON.stringify(result.turn.experience), /promotion_blocked|RULE_FALSE/);
    }
  }

  const resolution = await f.client.conversation("catalog-resolution");
  const partial = await f.client.ask(resolution.id, "Explain demo balances.");
  assert.equal(partial.turn.experience?.partial, true);
  assert.equal(partial.trace.ts?.rejections.length, 2);
  const missing = await f.client.ask(resolution.id, "Explain balance labels again.");
  assert.equal(missing.turn.failureCode, "content_unavailable");
  const retry = await f.client.request<TurnAccepted>("/api/turns/" + missing.turn.id + "/retry", { clientRequestId: randomUUID() }, 202);
  const retried = await f.client.wait(retry);
  assert.equal(retried.trace.ordinal, 2);
  assert.equal(retried.turn.failureCode, "content_unavailable");

  const change = await f.client.conversation("cross-turn-change", "demo-returning");
  const first = await f.client.ask(change.id, "Walk me through the demo transfer steps.");
  const second = await f.client.ask(change.id, "Show that transfer guide again.");
  assert.equal(first.turn.experience?.blocks[0]?.component, "PznStepList");
  assert.equal(second.turn.experience?.status, "no_match");
  assert.notEqual(second.trace.contentDecisionId, first.trace.contentDecisionId);
  assert.ok(second.trace.ts?.baseline.every((id) => !id.startsWith("transfer")));
});

test("synthetic metrics require a successful real sfield tool call before display", async (t) => {
  const f = await fixture((call) => ({ omitUsage: call.body.messages.some((message) => message.role === "tool") }));
  t.after(() => f.close());
  const conv = await f.client.conversation();
  const result = await f.client.ask(conv.id, "Show my synthetic demo balance summary.");
  assert.equal(result.turn.status, "completed", JSON.stringify(result.trace));
  assert.equal(result.trace.metricReadSucceeded, true);
  const block = result.turn.experience!.blocks[0];
  assert.equal(block.component, "PznMetricSummary");
  assert.deepEqual(block.props.values.map((item) => item.displayValue), ["1250.00", "1500.00"]);
  assert.equal(f.gateway.calls.length, 3);
  assert.ok(f.gateway.calls.at(-1)?.body.messages.some((message) => message.role === "tool"));
  assert.equal(result.trace.composeRun?.tokensReported, false);
  assert.doesNotMatch(result.events, /invocation|proofType|modelCalls/);
  const payloads = await f.client.request<TurnPayloads>("/api/debug/payloads/" + result.turn.id);
  const attempts = payloads.composer?.attempts ?? [];
  assert.equal(attempts.length, 2);
  assert.match(JSON.stringify(attempts[0].exchange?.response?.data), /toolCalls/);
  assert.deepEqual(attempts[1].exchange?.request.data, f.gateway.calls[2].body);
  assert.match(JSON.stringify(attempts[1].exchange?.response?.data), /PznMetricSummary/);
});

test("portfolio summaries combine the scoped snapshot with the cash treatment only when eligible", async (t) => {
  const reads: string[] = [];
  const f = await fixture(undefined, { portfolioSnapshots: {
    async read(mid, signal) {
      reads.push(mid);
      return fixturePortfolioSnapshotProvider.read(mid, signal);
    },
  } });
  t.after(() => f.close());
  const { client, gateway } = f;
  const question = "Let me know my portfolio summary.";
  const offer = "portfolio_cash_investing";

  const { personas } = await client.request<Bootstrap>("/api/bootstrap");
  assert.doesNotMatch(JSON.stringify(personas), /DEMO-MID/);
  assert.deepEqual(personas.map(({ displayName, profile }) => ({
    displayName, cashCents: profile.cashCents, beneficiaries: profile.beneficiaryStatus,
  })), [
    { displayName: "Alice Morgan", cashCents: 1_250_000, beneficiaries: "missing" },
    { displayName: "Jordan Lee", cashCents: 1_000_000, beneficiaries: "on_file" },
    { displayName: "Marcus Reed", cashCents: 0, beneficiaries: "on_file" },
  ]);

  for (const [personaId, mid, cashCents, matched] of [
    ["demo-learner", "DEMO-MID-1001", 1_250_000, true],
    ["demo-returning", "DEMO-MID-1002", 1_000_000, false],
  ] as const) {
    const conversation = await client.conversation("normal", personaId);
    const { turn, trace } = await client.ask(conversation.id, question);
    assert.equal(turn.status, "completed", JSON.stringify(trace));
    assert.equal(trace.selectedContextId, "portsum");
    assert.equal(trace.portfolioReadSucceeded, true);
    assert.deepEqual(trace.components, matched ? ["PznPortfolioSnapshot", "PznContentCard"] : ["PznPortfolioSnapshot"]);
    const [snapshot, recommendation] = turn.experience!.blocks;
    assert.equal(snapshot.component, "PznPortfolioSnapshot");
    assert.equal(snapshot.props.cashCents, cashCents);
    if (matched) {
      assert.equal(recommendation.component, "PznContentCard");
      assert.match(recommendation.props.body, /You have \$12,500 in cash/);
    }
    const payloads = await client.request<TurnPayloads>("/api/debug/payloads/" + turn.id);
    assert.deepEqual(payloads.treatment?.mockInput?.data, { mid, context: "portsum" });
    assert.deepEqual(payloads.treatment?.result?.data, matched ? ["portfolio_explanation", offer] : ["portfolio_explanation"]);
    assert.match(JSON.stringify(payloads.treatment?.ccre?.data), matched ? /"outcome":"matched"/ : /"outcome":"excluded"/);
    assert.equal(payloads.portfolio?.tool, "portfolio.snapshot.read@1.0.0");
    assert.equal(payloads.portfolio?.status, "succeeded");
    assert.deepEqual(payloads.portfolio?.registryInput.data, { turnRef: turn.id, routeDecisionId: trace.routeDecisionId });
    assert.deepEqual(payloads.portfolio?.result?.data, snapshot.props);
    if (matched) {
      const composer = gateway.calls.at(-1)?.envelope;
      assert.equal(composer?.portfolioSnapshotIncluded, true);
      assert.deepEqual(composer?.eligible?.candidates.map((candidate) => candidate.title), ["Explore investing options"]);
      assert.doesNotMatch(JSON.stringify(composer), /cashCents|1250000|DEMO-MID/);
    } else {
      assert.equal(trace.composerRunId, null);
    }
  }
  assert.deepEqual(reads, ["DEMO-MID-1001", "DEMO-MID-1002"]);

  const empty = await client.conversation("empty");
  const summary = await client.ask(empty.id, question);
  assert.deepEqual(summary.trace.components, ["PznPortfolioSnapshot"]);
  assert.equal(summary.trace.composerRunId, null);
  assert.equal(summary.turn.experience?.status, "ready");

  await client.request("/api/admin/tools", { ...defaultToolSetup, enabled: { ...defaultToolSetup.enabled, portfolio: false } });
  const missing = await client.ask(empty.id, question);
  assert.equal(missing.turn.failureCode, "portfolio_unavailable");
  assert.equal(missing.turn.experience, undefined);
});

test("the address guide includes the funding suggestion only when Treatment Selector returns it", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { client, gateway } = f;
  const prompt = "I moved and need to update my address.";
  const contextId = "address-update";
  const guide = "address_update_guide";
  const suggestion = "fund_account";
  const { personas } = await client.request<Bootstrap>("/api/bootstrap");
  assert.equal(personas.find(({ personaId }) => personaId === "demo-new-account")?.profile.accountFundingStatus, "unfunded");

  for (const [personaId, mid, matched] of [
    ["demo-new-account", "DEMO-MID-1003", true],
    ["demo-returning", "DEMO-MID-1002", false],
  ] as const) {
    const chat = await client.conversation("normal", personaId);
    const { turn, trace } = await client.ask(chat.id, prompt);
    const experience = turn.experience!;
    assert.equal(turn.status, "completed", JSON.stringify(trace.failures));
    assert.equal(trace.intentId, "update_address");
    assert.equal(trace.selectedContextId, contextId);
    const expected = matched ? [guide, suggestion] : [guide];
    assert.deepEqual(trace.finalOrder, expected);
    const [primary, funding] = experience.blocks;
    assert.equal(primary.component, "PznStepList");
    assert.equal(primary.props.title, "Update your mailing address");
    if (matched) {
      assert.equal(funding.component, "PznContentCard");
      assert.equal(funding.props.title, "Fund your account");
      assert.equal(funding.props.recommendation, true);
    }
    const ccre = {
      beforeRules: [guide, suggestion],
      results: [{ name: "Account is unfunded", contentId: suggestion, outcome: matched ? "matched" : "excluded" }],
    };
    const logs = await client.request<TurnPayloads>("/api/debug/payloads/" + turn.id);
    assert.deepEqual(logs.topicScores?.mockInput?.data, {
      mid, contextIds: trace.catalog!.contexts.map(({ contextId: id }) => id),
    });
    assert.deepEqual(logs.topicScores?.result?.data, trace.propensity);
    assert.deepEqual(gateway.calls.at(-2)?.envelope.propensity, trace.propensity);
    assert.equal(trace.propensity?.scores.find(({ contextId: id }) => id === contextId)?.score, matched ? 0.78 : null);
    assert.deepEqual(logs.treatment?.mockInput?.data, { mid, context: contextId });
    assert.deepEqual(logs.treatment?.result?.data, expected);
    assert.deepEqual(logs.treatment?.ccre?.data, ccre);
    assert.deepEqual(gateway.calls.at(-1)?.envelope.eligible?.candidates.map(({ title }) => title),
      ["Update your mailing address"]);
    const preview = await client.request<TreatmentPreview>("/api/admin/treatment-preview", {
      scenarioId: "normal", contextId, personaId, ordinal: 1, enabled: true, output: null,
    } satisfies TreatmentPreviewInput);
    assert.deepEqual(preview, { status: "ranked", source: "fixture", contentIds: expected, ccre });

    assert.deepEqual(experience.actions.map(({ label }) => label), matched ? ["See demo transfer steps"] : []);
    if (matched) {
      const transfer = await client.request<TurnAccepted>("/api/experiences/" + experience.experienceId + "/actions", {
        clientRequestId: randomUUID(), envelope: actionFor(experience),
      }, 202);
      const next = await client.wait(transfer);
      assert.equal(next.trace.intentId, "guide_transfer");
      assert.deepEqual(next.trace.finalOrder, ["transfer_checklist"]);
    }
  }

  await client.request("/api/admin/tools", {
    ...defaultToolSetup,
    ccreRules: [{ scenarioId: "normal", contextId, contentId: suggestion, name: "Pause first deposit suggestion", condition: { kind: "never" } }],
  } satisfies ToolSetup);
  const chat = await client.conversation("normal", "demo-new-account");
  const excluded = await client.ask(chat.id, prompt);
  assert.deepEqual(excluded.trace.finalOrder, [guide]);
  assert.deepEqual(excluded.turn.experience?.actions, []);
});

test("home-buying progress reads the eligible member's target and history through sfield", async (t) => {
  const reads: string[] = [];
  const f = await fixture(undefined, { goalProgressProvider: {
    async read(mid, signal) {
      reads.push(mid);
      return fixtureGoalProgressProvider.read(mid, signal);
    },
  } });
  t.after(() => f.close());
  const { client, gateway } = f;

  for (const [persona, mid, target, saved, message] of [
    ["demo-learner", "DEMO-MID-1001", 5_000_000, 2_600_000, "Show my home-buying goal and savings progress."],
    ["demo-returning", "DEMO-MID-1002", 6_000_000, 3_360_000, "How close am I to buying a house?"],
  ] as const) {
    const chat = await client.conversation("normal", persona);
    const { turn, trace } = await client.ask(chat.id, message);
    assert.equal(turn.status, "completed", JSON.stringify(trace));
    assert.equal(trace.intentId, "show_home_goal");
    assert.equal(trace.selectedContextId, "goals");
    assert.equal(trace.goalReadSucceeded, true);
    assert.deepEqual(trace.finalOrder, ["home_down_payment_progress"]);
    const block = turn.experience?.blocks[0];
    assert.equal(block?.component, "PznGoalProgress");
    assert.equal(block.props.goal.targetCents, target);
    assert.equal(block.props.goal.history.length, 6);
    assert.equal(block.props.goal.history.at(-1)?.savedCents, saved);

    const logs = await client.request<TurnPayloads>("/api/debug/payloads/" + turn.id);
    assert.deepEqual(logs.treatment?.mockInput?.data, { context: "goals", mid });
    assert.deepEqual(logs.treatment?.result?.data, ["home_down_payment_progress"]);
    assert.equal(logs.goal?.tool, "goal.progress.read@1.0.0");
    assert.deepEqual(logs.goal?.registryInput.data, { turnRef: turn.id, routeDecisionId: trace.routeDecisionId });
    assert.deepEqual(logs.goal?.result?.data, block.props.goal);
    const composer = gateway.calls.at(-1)?.envelope;
    assert.equal(composer?.goalProgressIncluded, true);
    assert.doesNotMatch(JSON.stringify(composer), /targetCents|savedCents|DEMO-MID/);
  }

  const empty = await client.conversation("empty");
  const excluded = await client.ask(empty.id, "Show my mortgage goal.");
  assert.equal(excluded.turn.experience?.outcome, "eligible_empty");
  assert.equal(excluded.trace.goalScopeId, null);

  await client.request("/api/admin/tools", { ...defaultToolSetup, enabled: { ...defaultToolSetup.enabled, goal: false } });
  const chat = await client.conversation();
  const disabled = await client.ask(chat.id, "Show my mortgage goal.");
  assert.equal(disabled.turn.failureCode, "goal_unavailable");
  assert.equal(disabled.turn.experience, undefined);
  assert.deepEqual(reads, ["DEMO-MID-1001", "DEMO-MID-1002"]);
});

test("goal shorthand and a misspelled status request open the home down payment goal", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { client } = f;
  const chat = await client.conversation();

  for (const message of ["goals", "what happend to goals", "Can I see my goals?"]) {
    const { turn, trace } = await client.ask(chat.id, message);
    assert.equal(trace.intentId, "show_home_goal");
    assert.equal(trace.selectedContextId, "goals");
    assert.equal(turn.experience?.blocks[0]?.component, "PznGoalProgress");
  }

  const specific = await client.ask(chat.id, "I want to learn about retirement goals.");
  assert.equal(specific.trace.intentId, "retirement_learning");
  const unclear = await client.ask(chat.id, "Show me something.");
  assert.equal(unclear.trace.routeOutcome, "clarify");
  assert.equal(unclear.turn.experience?.question, demoExperiencesQuestion);
  assert.equal(unclear.trace.goalScopeId, null);
});

test("vague and unsupported questions show the available demo experiences", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { client } = f;
  const chat = await client.conversation();
  const goal = await client.ask(chat.id, "Show my home-buying goal and savings progress.");
  assert.equal(goal.turn.experience?.blocks[0]?.component, "PznGoalProgress");
  const vague = await client.ask(chat.id, "how can i improve this");
  assert.equal(vague.trace.routeOutcome, "clarify");
  assert.equal(vague.turn.experience?.question, demoExperiencesQuestion);
  assert.equal(vague.trace.tsScopeId, null);

  const unsupported = await client.ask(chat.id, "What is the weather tomorrow?");
  assert.equal(unsupported.trace.routeOutcome, "no_match");
  assert.equal(unsupported.turn.experience?.intro, demoExperiencesQuestion);
  assert.equal(unsupported.trace.tsScopeId, null);
});

test("a misspelled retirement request reaches Learning and shows the beneficiary action only when eligible", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { client } = f;
  const question = "i want to know about retierment";

  for (const [personaId, mid, missing] of [
    ["demo-learner", "DEMO-MID-1001", true],
    ["demo-returning", "DEMO-MID-1002", false],
  ] as const) {
    const conversation = await client.conversation("normal", personaId);
    const { turn, trace } = await client.ask(conversation.id, question);
    assert.equal(turn.status, "completed", JSON.stringify(trace));
    assert.equal(trace.selectedContextId, "learning");
    const ids = missing ? ["retirement_learning", "beneficiary_update"] : ["retirement_learning"];
    assert.deepEqual(trace.finalOrder, ids);
    const experience = turn.experience!;
    const titles = experience.blocks.map((block) => {
      assert.equal(block.component, "PznContentCard");
      return block.props.title;
    });
    assert.deepEqual(titles, missing
      ? ["Retirement planning basics", "Update your beneficiaries"] : ["Retirement planning basics"]);
    assert.deepEqual(experience.actions.map(({ label }) => label), missing ? ["See beneficiary update steps"] : []);

    const payloads = await client.request<TurnPayloads>("/api/debug/payloads/" + turn.id);
    assert.deepEqual(payloads.treatment?.mockInput?.data, { mid, context: "learning" });
    assert.deepEqual(payloads.treatment?.result?.data, ids);
    const expectedCcre = {
      beforeRules: ["retirement_learning", "beneficiary_update"],
      results: [{ name: "Beneficiary details are missing", contentId: "beneficiary_update", outcome: missing ? "matched" : "excluded" }],
    };
    assert.deepEqual(payloads.treatment?.ccre?.data, expectedCcre);
    const preview = await client.request<TreatmentPreview>("/api/admin/treatment-preview", {
      personaId, scenarioId: "normal", contextId: "learning", enabled: true, output: null, ordinal: 1,
    } satisfies TreatmentPreviewInput);
    assert.deepEqual(preview, { status: "ranked", source: "fixture", contentIds: ids, ccre: expectedCcre });

    if (missing) {
      const next = await client.request<TurnAccepted>("/api/experiences/" + experience.experienceId + "/actions", {
        clientRequestId: randomUUID(), envelope: actionFor(experience),
      }, 202);
      const steps = await client.wait(next);
      assert.equal(steps.turn.status, "completed", JSON.stringify(steps.trace));
      assert.equal(steps.trace.selectedContextId, "learning");
      assert.deepEqual(steps.trace.components, ["PznStepList"]);
      assert.deepEqual(steps.trace.finalOrder, ["beneficiary_update"]);
      assert.deepEqual(steps.turn.experience?.actions, []);
    }
  }
});

test("a summary request uses the established portfolio topic or asks for confirmation", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { client } = f;
  const chat = await client.conversation();
  const message = "show me the summary";
  await client.ask(chat.id, "Hi");

  const clarification = await client.ask(chat.id, message);
  assert.equal(clarification.turn.experience?.question, portfolioSummaryQuestion);
  assert.equal(clarification.trace.routeOutcome, "clarify");
  assert.equal(clarification.trace.intentId, null);
  assert.equal(clarification.trace.possibleIntentId, "show_portfolio");
  const logs = await client.request<TurnPayloads>("/api/debug/payloads/" + clarification.turn.id);
  assert.equal(logs.treatment, null);
  assert.equal(logs.portfolio, null);
  assert.equal(logs.composer, null);

  for (const followUp of ["yes", message]) {
    const summary = await client.ask(chat.id, followUp);
    assert.equal(summary.trace.intentId, "show_portfolio");
    assert.equal(summary.trace.selectedContextId, "portsum");
    assert.equal(summary.turn.experience?.blocks[0]?.component, "PznPortfolioSnapshot");
  }

  const otherChat = await client.conversation();
  assert.equal((await client.ask(otherChat.id, message)).turn.experience?.question, portfolioSummaryQuestion);
  const balances = await client.ask(otherChat.id, "No, show my balance summary.");
  assert.equal(balances.trace.intentId, "show_balance");
  assert.equal(balances.trace.selectedContextId, "balance");
  assert.equal(balances.turn.experience?.blocks[0]?.component, "PznMetricSummary");
});

test("a balance summary follow-up keeps the verified topic when the model asks about the portfolio", async (t) => {
  const message = "show me the summary";
  const f = await fixture(({ envelope }) => {
    if (envelope.inputType !== "PznContextRoutingInput" || envelope.request !== message) return;
    return { json: {
      schemaVersion: "1.1", catalogSnapshotId: envelope.catalogSnapshotId!, catalogVersion: envelope.catalog!.catalogVersion,
      status: "clarify", intentId: "show_portfolio", clarificationQuestion: portfolioSummaryQuestion,
      replyText: null, summary: "The model proposed a portfolio clarification.",
    } };
  });
  t.after(() => f.close());
  const { client, gateway } = f;
  const chat = await client.conversation();
  const comparison = await client.ask(chat.id, "Compare available and current balance.");
  assert.equal(comparison.trace.intentId, "compare_balances");
  assert.equal(comparison.turn.experience?.blocks[0]?.component, "PznComparison");

  const summary = await client.ask(chat.id, message);
  assert.equal(summary.trace.intentId, "show_balance");
  assert.equal(summary.trace.selectedContextId, "balance");
  assert.ok(summary.trace.markers.summaryReferenceApplied !== undefined);
  assert.equal(summary.trace.metricReadSucceeded, true);
  const block = summary.turn.experience?.blocks[0];
  assert.equal(block?.component, "PznMetricSummary");
  assert.deepEqual(block.props.values.map(({ displayValue }) => displayValue), ["1250.00", "1500.00"]);
  const routing = gateway.calls.find(({ envelope }) => envelope.inputType === "PznContextRoutingInput" && envelope.request === message)?.envelope;
  assert.equal(routing?.recent?.at(-1)?.intentId, "compare_balances");
  assert.equal(routing?.summaryFollowUpIntentId, "show_balance");
  assert.equal(gateway.calls.at(-1)?.envelope.selectedIntentId, "show_balance");

  const paraphrase = await client.ask(chat.id, "Could I see that summary, please?");
  assert.equal(paraphrase.trace.intentId, "show_balance");
  assert.equal(paraphrase.trace.metricReadSucceeded, true);

  const portfolio = await client.ask(chat.id, "Show me my portfolio summary.");
  assert.equal(portfolio.trace.intentId, "show_portfolio");
  assert.equal(portfolio.turn.experience?.blocks[0]?.component, "PznPortfolioSnapshot");

  const ambiguous = await client.ask(chat.id, "Show my balance and walk me through a transfer.");
  assert.equal(ambiguous.trace.routeOutcome, "clarify");
  const clarification = await client.ask(chat.id, message);
  assert.equal(clarification.trace.routeOutcome, "clarify");
  assert.equal(clarification.trace.tsScopeId, null);
  assert.equal(gateway.calls.at(-1)?.envelope.summaryFollowUpIntentId, undefined);
});

test("recent retirement clues prompt for clarification until the user confirms the goal", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { client, gateway } = f;
  const chat = await client.conversation();
  const age = "i will be 62";
  const lastDay = "last day of job is next week";

  for (const [message, question] of [[age, retirementQuestion], [lastDay, leavingWorkQuestion]]) {
    const { turn, trace } = await client.ask(chat.id, message);
    assert.equal(turn.experience?.outcome, "clarify");
    assert.equal(turn.experience?.question, question);
    assert.equal(trace.intentId, null);
    assert.equal(trace.possibleIntentId, "retirement_learning");
    assert.equal(trace.tsScopeId, null);
    assert.equal(trace.composerRunId, null);
  }
  const { turn, trace } = await client.ask(chat.id, "yes");
  assert.equal(turn.experience?.outcome, "ready");
  assert.equal(trace.intentId, "retirement_learning");
  assert.equal(trace.selectedContextId, "learning");
  assert.deepEqual(trace.finalOrder, ["retirement_learning", "beneficiary_update"]);
  const routing = gateway.calls.find(({ envelope }) => envelope.inputType === "PznContextRoutingInput" && envelope.request === "yes")!.envelope;
  assert.deepEqual(routing.recent, [
    { request: age, contextId: null, intentId: null, clarificationQuestion: retirementQuestion },
    { request: lastDay, contextId: null, intentId: null, clarificationQuestion: leavingWorkQuestion },
  ]);
  assert.ok(routing.intentCatalog?.some(({ intentId, contextId }) => intentId === "retirement_learning" && contextId === "learning"));
  assert.equal(gateway.calls.at(-1)?.envelope.selectedIntentId, "retirement_learning");
  assert.deepEqual(gateway.calls.at(-1)?.envelope.eligible?.candidates.map(({ title }) => title), ["Retirement planning basics"]);

  const otherGoal = await client.ask(chat.id, "No, I'm looking for a new job.");
  assert.equal(otherGoal.trace.routeOutcome, "no_match");
  assert.equal(otherGoal.trace.tsScopeId, null);
  const newChat = await client.conversation();
  const outsideDemo = await client.ask(newChat.id, "I'm looking for a new job.");
  await client.ask(newChat.id, lastDay);
  assert.deepEqual(gateway.calls.at(-1)?.envelope.recent, [
    {
      request: "I'm looking for a new job.", contextId: null, intentId: null, clarificationQuestion: null,
      assistantReply: outsideDemo.turn.experience?.intro,
    },
  ]);
});

test("the router's conversational reply is shown as chat text and carried into the next turn", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { client, gateway } = f;
  const chat = await client.conversation();
  const clarification = await client.ask(chat.id, "i will be 62");
  assert.equal(clarification.turn.experience?.outcome, "clarify");
  const retirement = await client.ask(chat.id, "yes");
  assert.equal(retirement.trace.intentId, "retirement_learning");
  assert.deepEqual(retirement.trace.finalOrder, ["retirement_learning", "beneficiary_update"]);

  const { turn, trace } = await client.ask(chat.id, "thats nice");
  assert.equal(turn.experience?.outcome, "reply");
  assert.equal(turn.experience?.status, "ready");
  assert.deepEqual(turn.experience?.blocks, []);
  assert.deepEqual(turn.experience?.actions, []);
  assert.equal(trace.tsScopeId, null);
  assert.equal(trace.composerRunId, null);
  assert.deepEqual(gateway.calls.at(-1)?.envelope.recent?.at(-1)?.displayedContent, [
    "Retirement planning basics", "Update your beneficiaries",
  ]);
  const logs = await client.request<TurnPayloads>("/api/debug/payloads/" + turn.id);
  const output = logs.router?.attempts[0].exchange?.response?.data as { message: { content: string } };
  const modelReply = JSON.parse(output.message.content).replyText;
  assert.equal(turn.experience?.intro, modelReply);
  assert.deepEqual(turn.experience?.messages[0].createSurface.dataModel, { intro: modelReply });
  assert.equal(logs.treatment, null);
  assert.equal(logs.composer, null);

  const followUp = await client.ask(chat.id, "what did you just say?");
  assert.equal(followUp.turn.experience?.intro, modelReply);
  assert.equal(gateway.calls.at(-1)?.envelope.recent?.at(-1)?.assistantReply, modelReply);
});

test("retirement is inferred for age and job-transition follow-ups to an established retirement goal", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { client, gateway } = f;
  const chat = await client.conversation();
  const messages = ["i want to know about retierment", "am old", "i am going to loose my job", "i will be 62", "last day of job is next week"];
  for (const message of messages) {
    const { turn, trace } = await client.ask(chat.id, message);
    if (message === "i am going to loose my job") {
      assert.equal(turn.experience?.question, leavingWorkQuestion);
      assert.equal(trace.tsScopeId, null);
      continue;
    }
    assert.equal(turn.experience?.outcome, "ready");
    assert.equal(trace.intentId, "retirement_learning");
    assert.equal(trace.selectedContextId, "learning");
  }
  assert.deepEqual(gateway.calls.at(-2)?.envelope.recent?.map(({ request }) => request), messages.slice(0, -1));
  const change = await client.ask(chat.id, "Show my synthetic demo balance summary.");
  assert.equal(change.trace.intentId, "show_balance");
  assert.equal(change.trace.selectedContextId, "balance");
});

test("admission rejects invalid routing proposals, tampered input, duplicate payload changes, and foreign principals", async (t) => {
  const f = await fixture(({ envelope }) => envelope.inputType === "PznContextRoutingInput" ? {
    json: {
      schemaVersion: "1.1", catalogSnapshotId: envelope.catalogSnapshotId, catalogVersion: envelope.catalog?.catalogVersion,
      status: "no_match", intentId: "explain_balance", clarificationQuestion: null, replyText: null, summary: "Invalid test route.",
    },
  } : undefined);
  t.after(() => f.close());
  const { client } = f;
  const conv = await client.conversation();
  const path = "/api/conversations/" + conv.id + "/turns";
  const tampered = await client.response(path, { message: "Explain balances.", clientRequestId: randomUUID(), mid: "FORGED", context: "portsum" });
  assert.equal(tampered.status, 400);
  assert.equal((await client.response(path, { message: "Explain balances.", clientRequestId: randomUUID() }, { Origin: "https://outside.invalid" })).status, 403);
  const requestId = randomUUID();
  const accepted = await client.submit(conv.id, "Explain balances.", requestId);
  assert.equal((await client.submit(conv.id, "Explain balances.", requestId)).turnId, accepted.turnId);
  assert.equal((await client.response(path, { message: "Different message.", clientRequestId: requestId })).status, 409);
  const result = await client.wait(accepted);
  assert.equal(result.turn.failureCode, "route_rejected");
  assert.equal(result.trace.tsScopeId, null);
  assert.equal(result.trace.failures[0].code, "ROUTE_STATUS_SHAPE_INVALID");
  assert.equal(f.gateway.calls.length, 2);
  const foreign = await client.response("/api/turns/" + accepted.turnId, undefined, { Cookie: "" });
  assert.equal(foreign.status, 404);
});

test("cancelling an active router releases no late answer and permits a new turn", async (t) => {
  let routingStarted!: () => void;
  const started = new Promise<void>((resolve) => { routingStarted = resolve; });
  const f = await fixture(({ envelope }) => {
    if (envelope.request === "Stop this balance request.") { routingStarted(); return { delayMs: 4000 }; }
  });
  t.after(() => f.close());
  const conv = await f.client.conversation();
  const accepted = await f.client.submit(conv.id, "Stop this balance request.");
  await started;
  const cancel = await f.client.request<TurnView>("/api/turns/" + accepted.turnId + "/cancel", {});
  assert.equal(cancel.status, "cancelled");
  const result = await f.client.wait(accepted);
  assert.equal(result.turn.status, "cancelled");
  assert.equal(result.trace.tsScopeId, null);
  assert.doesNotMatch(result.events, /experience\.ready/);
  const fresh = await f.client.ask(conv.id, "Explain demo balances.");
  assert.equal(fresh.turn.status, "completed");
});

test("composer repair cannot publish drafts, old candidates, or text from a failed gateway", async (t) => {
  let oldCandidate: string | undefined;
  const f = await fixture(({ envelope }) => {
    if (envelope.inputType !== "PznExperienceCompositionInput") return;
    if (envelope.request === "Explain balances.") oldCandidate = envelope.eligible!.candidates[0].candidateId;
    if (envelope.request === "Explain balances again.") return { json: {
      schemaVersion: "1.0", decisionId: envelope.eligible!.decisionId, status: "ready", intent: envelope.intent,
      introKey: "explanation", clarificationQuestion: null,
      blocks: [{ blockId: "old", component: "PznContentCard", candidateIds: [oldCandidate], variant: "expanded" }], followUpIds: [],
    } };
    if (envelope.request === "A balance draft test.") return { draft: "DO NOT EXPOSE THIS UNVERIFIED DRAFT" };
    if (envelope.request === "Explain balance during the gateway outage.") return { status: 503 };
  });
  t.after(() => f.close());
  const conv = await f.client.conversation();
  const first = await f.client.ask(conv.id, "Explain balances.");
  assert.equal(first.turn.status, "completed");
  const second = await f.client.ask(conv.id, "Explain balances again.");
  assert.equal(second.turn.failureCode, "verification_failed");
  assert.ok(second.trace.failures.some(({ code }) => code === "CANDIDATE_NOT_ELIGIBLE"));
  assert.doesNotMatch(second.events, /experience\.ready/);
  const invalid = await f.client.ask(conv.id, "A balance draft test.");
  assert.equal(invalid.turn.failureCode, "verification_failed");
  assert.doesNotMatch(invalid.events, /DRAFT|experience\.ready/);
  const unavailable = await f.client.ask(conv.id, "Explain balance during the gateway outage.");
  assert.equal(unavailable.turn.failureCode, "gateway_unavailable");
  assert.doesNotMatch(unavailable.events, /experience\.ready/);
});

test("missing gateway has a controlled failure with no fixture or public model fallback", async (t) => {
  const f = await fixture(undefined, { noGateway: true });
  t.after(() => f.close());
  const conv = await f.client.conversation();
  assert.equal((await f.client.ask(conv.id, "Explain balances.")).turn.failureCode, "gateway_unavailable");
  assert.equal(f.gateway.calls.length, 0);
});

test("restart finalizes a completed unpublished composer run without repeating either decision", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const conv = await f.client.conversation();
  const completed = await f.client.ask(conv.id, "Compare available and current balance.");
  const id = completed.turn.id;
  const client = await f.restart((dir) => {
    const db = new DatabaseSync(join(dir, "app.sqlite"));
    try {
      const row = db.prepare("SELECT record FROM turns WHERE id = ?").get(id) as { record: string };
      const record = JSON.parse(row.record);
      record.public.status = "working";
      record.public.progress = "verifying";
      delete record.public.experience;
      delete record.trace.markers.terminal;
      delete record.trace.markers.compiled;
      db.exec("BEGIN IMMEDIATE");
      db.prepare("DELETE FROM experiences WHERE turn_id = ?").run(id);
      db.prepare("DELETE FROM public_events WHERE turn_id = ? AND type = 'experience.ready'").run(id);
      db.prepare("UPDATE turns SET status = 'working', record = ? WHERE id = ?").run(JSON.stringify(record), id);
      db.exec("COMMIT");
    } finally { db.close(); }
  });
  const recovered = await client.wait({ turnId: id, eventsUrl: "/api/turns/" + id + "/events", turn: completed.turn });
  assert.equal(recovered.turn.status, "completed");
  assert.equal(recovered.turn.experience?.blocks[0]?.component, "PznComparison");
  assert.equal(recovered.trace.composerRunId, completed.trace.composerRunId);
  assert.equal(recovered.trace.routerRunId, completed.trace.routerRunId);
  assert.equal(f.gateway.calls.length, 2);
  assert.equal(recovered.events.match(/event: experience\.ready/g)?.length, 1);
  assert.equal((await client.request<TurnView>("/api/turns/" + id + "/cancel", {})).status, "completed");
});

test("stop after route commitment prevents treatment dispatch and composer admission", async (t) => {
  const { Store } = await import("../apps/server/store");
  const { Runtime } = await import("../apps/server/runtime");
  const { ExperienceService } = await import("../apps/server/service");
  const dir = await mkdtemp(join(tmpdir(), "pzn-stage-boundary-"));
  const gateway = await startFixtureGateway();
  const store = new Store(join(dir, "app.sqlite"));
  const runtime = await Runtime.open(store, join(dir, "sfield.sqlite"), gateway.settings, Date.now);
  const service = new ExperienceService(store, runtime, "semantic_rerank", Date.now, true);
  t.after(async () => {
    await service.close();
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  });

  let selectionReached!: () => void;
  let continueSelection!: () => void;
  const reached = new Promise<void>((resolve) => { selectionReached = resolve; });
  const gate = new Promise<void>((resolve) => { continueSelection = resolve; });
  const registry = runtime.registry.bind(runtime);
  runtime.registry = async (turn, boundary, budget, signal, use) => {
    if (boundary === "tsScopeId") {
      selectionReached();
      await gate;
    }
    return registry(turn, boundary, budget, signal, use);
  };

  const conversation = service.createConversation(store.session().id, "demo-learner", "normal");
  const admitted = service.submit(conversation, "Explain demo balances.", randomUUID());
  await reached;
  try {
    const stopped = store.ownTurn(admitted.turnId, conversation.principalId);
    assert.equal(stopped.route?.contextId, "balance");
    assert.equal(stopped.tsScopeId, undefined);
    assert.equal(service.cancel(stopped).status, "cancelled");
  } finally { continueSelection(); }
  await new Promise<void>((resolve) => setImmediate(resolve));
  const state = store.ownTurn(admitted.turnId, conversation.principalId);
  assert.equal(state.tsScopeId, undefined);
  assert.equal(state.attempts.compose, undefined);
  assert.equal(gateway.calls.length, 1);
});

test("custom gateway headers and body fields reach every request, including tool calls", async (t) => {
  const key = "pzn-header-only-test-key";
  const context = { client: "pzn-lab", tier: "demo" };
  const fields = { metadata: { purpose: "pzn-lab" }, region: "demo-east" };
  const f = await fixture(undefined, {
    gatewayEnv: {
      LLM_API_KEY: "",
      LLM_GATEWAY_HEADERS_JSON: JSON.stringify({ "X-Api-Key": key, "X-Gateway-Context": context }),
      LLM_GATEWAY_BODY_JSON: JSON.stringify(fields),
    },
    authorize: (headers) => headers["x-api-key"] === key && headers.authorization === undefined,
  });
  t.after(() => f.close());
  const conversation = await f.client.conversation();
  const result = await f.client.ask(conversation.id, "Show my synthetic demo balance summary.");
  assert.equal(result.turn.status, "completed", JSON.stringify(result.trace));
  assert.equal(result.trace.metricReadSucceeded, true);
  assert.equal(f.gateway.calls.length, 3);
  for (const call of f.gateway.calls) {
    assert.equal(call.headers["x-gateway-context"], JSON.stringify(context));
    assert.equal(call.headers["content-type"], "application/json");
    assert.equal(call.body.stream, true);
    assert.equal(call.body.response_format.type, "json_schema");
    assert.ok(Reflect.get(call.body, "max_tokens") > 0);
    assert.deepEqual(Object.fromEntries(Object.keys(fields).map((key) => [key, Reflect.get(call.body, key)])), fields);
  }
  assert.ok(!result.events.includes(key));
  const payloads = await f.client.request<TurnPayloads>("/api/debug/payloads/" + result.turn.id);
  const body = payloads.router?.attempts[0].exchange?.request.data;
  assert.deepEqual(body, { ...f.gateway.calls[0].body, metadata: "[REDACTED]", region: "[REDACTED]" });
  assert.doesNotMatch(JSON.stringify(payloads), /pzn-header-only-test-key|demo-east|x-gateway-context/i);
});

test("direct OpenAI and office gateway use their own credentials and request settings", () => {
  const env = {
    OPENAI_API_KEY: "openai-example-key",
    OPENAI_MODEL: "gpt-4.1-mini",
    OPENAI_MAX_OUTPUT_TOKENS: "2048",
    LLM_BASE_URL: "https://office.example.invalid/api",
    LLM_MODEL: "office-model",
    LLM_API_KEY: "office-example-key",
    LLM_GATEWAY_HEADERS_JSON: '{"X-Office-Context":{"project":"demo"}}',
    LLM_GATEWAY_BODY_JSON: '{"region":"office"}',
  };
  const direct = gatewayFromEnv(env, "openai");
  assert.deepEqual(direct, {
    profile: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", apiKey: "openai-example-key",
    contextWindow: 16384, maxOutputTokens: 2048,
  });
  const office = gatewayFromEnv(env);
  assert.equal(office?.baseUrl, env.LLM_BASE_URL);
  assert.equal(office?.apiKey, env.LLM_API_KEY);
  assert.equal(office?.model, env.LLM_MODEL);
  assert.deepEqual(office?.headers, { "x-office-context": '{"project":"demo"}' });
  assert.deepEqual(office?.bodyFields, { region: "office" });
  assert.throws(() => gatewayFromEnv({ ...env, OPENAI_API_KEY: "" }, "openai"), /Set OPENAI_API_KEY/);
  assert.equal(gatewayFromEnv({ OPENAI_API_KEY: env.OPENAI_API_KEY }), null);
});

test("the direct profile uses OpenAI completion parameters and a separate browser session", async (t) => {
  const f = await fixture(undefined, { openAiProfile: true });
  t.after(() => f.close());
  const { client, gateway } = f;
  assert.match(client.cookie, /^pzn_openai_session=/);
  const boot = await client.request<{ openAiModel: string }>("/api/bootstrap");
  assert.equal(boot.openAiModel, gateway.settings.model);
  const conversation = await client.conversation();
  const result = await client.ask(conversation.id, "Compare available and current balance.");
  assert.equal(result.turn.experience?.blocks[0]?.component, "PznComparison");
  assert.equal(gateway.calls.length, 2);
  for (const { body } of gateway.calls) {
    assert.ok(Reflect.get(body, "max_completion_tokens") > 0);
    assert.equal(Reflect.has(body, "max_tokens"), false);
  }
  assert.doesNotMatch(JSON.stringify(gateway.calls[1].body.response_format), /"uniqueItems"/);
});

test("gateway configuration rejects ambiguous auth and attempts to replace adapter fields", () => {
  const env = {
    LLM_BASE_URL: "https://gateway.example.com/v1",
    LLM_MODEL: "pzn-demo-model",
    LLM_API_KEY: "gateway-test-bearer-token",
  };
  assert.throws(() => gatewayFromEnv({ ...env, LLM_GATEWAY_HEADERS_JSON: "[]" }), /must be a JSON object/);
  assert.throws(() => gatewayFromEnv({
    ...env, LLM_GATEWAY_HEADERS_JSON: JSON.stringify({ Authorization: "Basic example" }),
  }), /Set Authorization/);
  assert.throws(() => gatewayFromEnv({
    ...env, LLM_GATEWAY_HEADERS_JSON: JSON.stringify({ "X-Client": "a\r\nX-Extra: b" }),
  }), /invalid or duplicate header/);
  assert.throws(() => gatewayFromEnv({
    ...env, LLM_GATEWAY_BODY_JSON: JSON.stringify({ tools: [] }),
  }), /cannot set fields controlled/);
});

test("gateway error reflection redacts credentials from a JSON-valued header", async (t) => {
  const reflected = "pzn-json-token-never-persist";
  const f = await fixture(
    () => ({ status: 401, errorMessage: "Unknown credential " + reflected }),
    { gatewayEnv: { LLM_GATEWAY_HEADERS_JSON: JSON.stringify({ "X-Gateway-Context": { token: reflected } }) } },
  );
  t.after(() => f.close());
  const conversation = await f.client.conversation();
  const result = await f.client.ask(conversation.id, "Explain demo balances.");
  assert.equal(result.turn.failureCode, "gateway_unavailable");
  assert.ok(!result.events.includes(reflected));
  const payloads = await f.client.request<TurnPayloads>("/api/debug/payloads/" + result.turn.id);
  const failed = payloads.router?.attempts[0];
  assert.equal(failed?.status, "failed");
  assert.match(JSON.stringify(failed?.exchange?.response?.data), /\[REDACTED\]/);
  assert.ok(!JSON.stringify(payloads).includes(reflected));
  assert.equal(payloads.treatment, null);
  assert.equal(payloads.composer, null);
  const database = new DatabaseSync(join(f.dataDir, "sfield.sqlite"), { readOnly: true });
  try {
    const attempts = database.prepare("SELECT body FROM model_attempts WHERE run_id = ?").all(result.trace.routerRunId!);
    assert.ok(attempts.length);
    const stored = JSON.stringify(attempts);
    assert.ok(stored.includes("[REDACTED]"));
    assert.ok(!stored.includes(reflected));
  } finally {
    database.close();
  }
});
