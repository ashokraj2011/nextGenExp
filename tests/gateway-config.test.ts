import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "./operator-fixture";
import { gatewayConfigSchema, settingsFromConfig } from "../apps/server/gateway-config";
import { testClient, testProject } from "./client";
import { startFixtureGateway } from "./gateway-fixture";

/** A minimal OpenAI-compatible Chat Completions endpoint that requires one API key. */
async function fakeGateway(key: string) {
  const seen: { auth?: string; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(raw || "{}") });
      if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
      if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "invalid api key" } })); return; }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ model: "fake-model-1", choices: [{ message: { role: "assistant", content: '{"ok": true, "word": "ready"}' } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("gateway settings reuse the environment validation rules", () => {
  const base = gatewayConfigSchema.parse({ provider: "openai_compatible", model: "m", baseUrl: "https://gw.example.com/v1", apiKeyMode: "stored", apiKey: "sk-test-123456" });
  const s = settingsFromConfig(base);
  assert.equal("baseUrl" in s && s.baseUrl, "https://gw.example.com/v1");
  assert.throws(() => settingsFromConfig({ ...base, baseUrl: "http://gw.example.com/v1" }), /HTTPS or a loopback/);
  assert.throws(() => settingsFromConfig({ ...base, apiKey: undefined }), /Enter the API key/);
  assert.throws(() => settingsFromConfig({ ...base, apiKeyMode: "env", apiKeyEnv: "NOT_SET_ANYWHERE_X" }, {}), /NOT_SET_ANYWHERE_X is not set/);
  assert.equal(settingsFromConfig({ ...base, apiKeyMode: "env", apiKeyEnv: "MY_KEY" }, { MY_KEY: "k-from-env-1" }).model, "m");
  assert.throws(() => settingsFromConfig({ ...base, contextWindow: 4096, maxOutputTokens: 3000 }), /insufficient space/);
});

test("model gateway admin: test, activate (restart hook), mask the key, reset", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-gw-"));
  const fixture = await startFixtureGateway();
  const gw = await fakeGateway("sk-good-key-0001");
  let restarts = 0;
  const app = await startApp({
    projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: fixture.settings, inspectorEnabled: true,
    onGatewayActivated: () => { restarts++; },
  });
  t.after(async () => { await app.close(); await fixture.close(); await gw.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);
  type View = { source: string; running: { model: string } | null; active?: { model: string; apiKeySet: boolean; apiKeyHint?: string; activatedBy: string }; restartSupported: boolean };
  type Test = { ok: boolean; steps: { name: string; ok: boolean; detail: string }[] };

  const initial = await client.request<View>("/api/admin/gateway");
  assert.equal(initial.source, "environment");
  assert.equal(initial.restartSupported, true);

  const good = { provider: "openai_compatible", label: "Fake gateway", baseUrl: gw.url, model: "fake-model-1", apiKeyMode: "stored", apiKey: "sk-good-key-0001", contextWindow: 16384, maxOutputTokens: 1500 };

  // Activation without a passing test of the same configuration is refused.
  await client.request("/api/admin/gateway/activate", { config: good }, 409);

  // A wrong key fails at the model call, and the key never appears in the result.
  const bad = await client.request<Test>("/api/admin/gateway/test", { config: { ...good, apiKey: "sk-wrong-key-9999" } });
  assert.equal(bad.ok, false);
  assert.equal(bad.steps.find((s) => s.name === "Model call")?.ok, false);
  assert.match(bad.steps.find((s) => s.name === "Model call")!.detail, /401/);
  assert.ok(!JSON.stringify(bad).includes("sk-wrong-key-9999"));

  // Too-small context window fails the sfield capacity check before any call.
  const small = await client.request<Test>("/api/admin/gateway/test", { config: { ...good, contextWindow: 4096, maxOutputTokens: 512 } });
  assert.equal(small.ok, false);
  assert.ok(small.steps.some((s) => s.name === "sfield capacity" && !s.ok) || small.steps.some((s) => s.name === "Settings" && !s.ok));

  // A good test passes all steps; the request carried the key.
  const calls = gw.seen.length;
  const ok = await client.request<Test>("/api/admin/gateway/test", { config: good });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.steps.map((s) => s.name), ["Settings", "sfield capacity", "Model", "Model call"]);
  assert.equal(gw.seen.at(-1)?.auth, "Bearer sk-good-key-0001");
  assert.equal(gw.seen.length, calls + 1);

  // A changed configuration needs its own test.
  await client.request("/api/admin/gateway/activate", { config: { ...good, model: "other-model" } }, 409);

  // Activate: saved, restart hook called, key stored only on the server and masked in the view.
  const activated = await client.request<{ activated: boolean; restarting: boolean; view: View }>("/api/admin/gateway/activate", { config: good });
  assert.equal(activated.restarting, true);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(restarts, 1);
  const view = await client.request<View>("/api/admin/gateway");
  assert.equal(view.source, "saved");
  assert.equal(view.active?.model, "fake-model-1");
  assert.equal(view.active?.apiKeySet, true);
  assert.equal(view.active?.apiKeyHint, "••••0001");
  assert.ok(!JSON.stringify(view).includes("sk-good-key-0001"), "the key is never returned");
  const file = await readFile(join(dir, "llm-gateway.json"), "utf8");
  assert.ok(file.includes("sk-good-key-0001"), "stored on the server");

  // Re-testing with a blank key keeps the stored one.
  const kept = await client.request<Test>("/api/admin/gateway/test", { config: { ...good, apiKey: undefined } });
  assert.equal(kept.ok, true);

  // Reset returns to the environment settings and restarts again.
  const reset = await client.request<{ reset: boolean; view: View }>("/api/admin/gateway/reset", {});
  assert.equal(reset.reset, true);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(restarts, 2);
  assert.equal((await client.request<View>("/api/admin/gateway")).source, "environment");
});
