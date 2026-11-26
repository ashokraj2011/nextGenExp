import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gatewayFromEnv } from "../apps/server/gateway";
import { startApp } from "./operator-fixture";
import type { Bootstrap } from "../packages/contracts/api";
import type { TurnPayloads } from "../packages/contracts/inspector";
import { testClient, testProject } from "./client";

test("Copilot ACP is the default and explicit providers take precedence", () => {
  const defaultGateway = gatewayFromEnv({});
  assert.equal(defaultGateway?.profile, "copilot_acp");
  assert.equal(defaultGateway.model, "auto");
  assert.equal(defaultGateway.command, "copilot");
  assert.equal(gatewayFromEnv({ LLM_PROVIDER: "  ", LLM_MODEL: "my-model" })?.model, "my-model");
  const gateway = gatewayFromEnv({
    LLM_PROVIDER: "copilot_acp", LLM_BASE_URL: "invalid", LLM_GATEWAY_HEADERS_JSON: "invalid",
    OPENAI_API_KEY: "unused", COPILOT_ALLOW_ALL: "1",
  });
  assert.equal(gateway?.profile, "copilot_acp");
  assert.equal(gateway.model, "auto");
  assert.equal(gateway.command, "copilot");
  assert.deepEqual(gateway.env, {});
  assert.equal(gatewayFromEnv({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "test-secret" })?.profile, "openai");
  assert.equal(gatewayFromEnv({ LLM_PROVIDER: "copilot_acp", OPENAI_API_KEY: "test-secret" }, "openai")?.profile, "openai");
  assert.equal(gatewayFromEnv({ LLM_PROVIDER: "gateway" }), null);
  assert.throws(() => gatewayFromEnv({ LLM_PROVIDER: "unknown" }), /LLM_PROVIDER/);
});

test("Copilot ACP drives routing, sfield tools, and rendering", { skip: process.platform === "win32" }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pzn-acp-test-"));
  const gateway = gatewayFromEnv({
    ...process.env, LLM_PROVIDER: undefined, LLM_BASE_URL: undefined, LLM_MODEL: "acp-fixture",
    COPILOT_ACP_COMMAND: fileURLToPath(new URL("./copilot-acp-fixture.mjs", import.meta.url)),
    COPILOT_GITHUB_TOKEN: "copilot-acp-fixture-token", OPENAI_API_KEY: "unused", COPILOT_ALLOW_ALL: "1",
  });
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  t.after(async () => {
    try { await app?.close(); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  app = await startApp({ dataDir, gateway, projectRoot: fileURLToPath(testProject) });
  const client = await testClient(app.url);
  const boot = await client.request<Bootstrap>("/api/bootstrap");
  assert.equal(boot.copilotModel, "acp-fixture");
  assert.match(client.cookie, /^pzn_copilot_session=/);

  const conversation = await client.conversation();
  const { turn, trace } = await client.ask(conversation.id, "Show my balance summary.");
  const logs = await client.request<TurnPayloads>("/api/debug/payloads/" + turn.id);
  const composer = logs.composer?.attempts ?? [];
  assert.equal(turn.status, "completed", JSON.stringify({
    failures: trace.failures, composer: composer.map(({ exchange, error }) => exchange?.response ?? error),
  }));
  assert.equal(turn.experience?.blocks[0]?.component, "PznMetricSummary");
  assert.equal(trace.metricReadSucceeded, true);
  assert.equal(trace.composeRun?.tokensReported, false);

  const router = logs.router?.attempts[0]?.exchange;
  assert.equal(router?.method, "JSON-RPC");
  assert.equal(router.path, "session/prompt");
  assert.match(JSON.stringify(router.request.data), /PznContextRoutingInput/);
  assert.match(JSON.stringify(router.response?.data), /show_balance/);
  assert.equal(logs.treatment?.status, "succeeded");
  assert.equal(composer.length, 2);
  assert.match(JSON.stringify(composer[0].exchange?.response?.data), /toolCalls/);
  assert.match(JSON.stringify(composer[1].exchange?.request.data), /tool_results/);
  assert.match(JSON.stringify(composer[1].exchange?.response?.data), /PznMetricSummary/);
  assert.doesNotMatch(JSON.stringify(logs), /copilot-acp-fixture-token|Unrelated reply|Unrelated reasoning|Info: Disabled tools/);
});
