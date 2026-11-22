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
import type { TurnAccepted, TurnView, ConversationView } from "../packages/contracts/api";
import { actionFor, testClient, testProject } from "./client";
import { startFixtureGateway, type TestInterceptor } from "./gateway-fixture";

async function fixture(intercept?: TestInterceptor, opts: {
  noGateway?: boolean;
  preserve?: boolean;
  gatewayEnv?: NodeJS.ProcessEnv;
  authorize?: (headers: IncomingHttpHeaders) => boolean;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pzn-host-test-"));
  const gateway = await startFixtureGateway(intercept, opts.authorize);
  const settings = opts.gatewayEnv ? gatewayFromEnv({
    LLM_BASE_URL: gateway.settings.baseUrl, LLM_MODEL: gateway.settings.model,
    LLM_API_KEY: gateway.settings.apiKey, ...opts.gatewayEnv,
  }) : gateway.settings;
  const options = {
    projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: opts.noGateway ? null : settings, mode: "test",
    selectionMode: opts.preserve ? "preserve_ts_rank" : "semantic_rerank",
  } as const;
  let app = await startApp(options);
  const client = await testClient(app.url);
  return {
    gateway, client, dataDir: dir,
    async restart(prepare?: (dir: string) => void) {
      await app.close();
      prepare?.(dir);
      app = await startApp(options);
      return testClient(app.url, client.cookie);
    },
    async close() {
      await app.close();
      await gateway.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

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
});

test("admission rejects unknown contexts, tampered input, duplicate payload changes, and foreign principals", async (t) => {
  const f = await fixture(({ envelope }) => envelope.inputType === "PznContextRoutingInput" ? {
    json: {
      schemaVersion: "1.0", catalogSnapshotId: envelope.catalogSnapshotId, catalogVersion: envelope.catalog?.catalogVersion,
      status: "selected", contextId: "archived-help", clarificationQuestion: null,
      intent: { task: "explain", topic: "demo", summary: "Invalid test route." },
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
  assert.equal(result.trace.failures[0].code, "CONTEXT_NOT_ACTIVE");
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
  const service = new ExperienceService(store, runtime, "semantic_rerank", Date.now);
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
    assert.deepEqual(Object.fromEntries(Object.keys(fields).map((key) => [key, Reflect.get(call.body, key)])), fields);
  }
  assert.ok(!result.events.includes(key));
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
