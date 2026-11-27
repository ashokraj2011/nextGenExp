import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SField,
  FilesystemArtifactStore,
  VectorMemoryIndex,
  HashEmbeddingProvider,
  defineTool,
  scopeKey,
  type MemoryItem,
} from "@sfield/core";
import { persistenceConformance } from "@sfield/testing";
import {
  JsonFilePersistence,
  PostgresMemoryRepository,
  createPgPoolAdapter,
  createPostgresOrJsonPersistence,
} from "@sfield/store-postgres";
import { sqlitePersistence } from "@sfield/store-sqlite";
import { runCli } from "@sfield/cli";
import { configureGateway, gatewayFromEnv } from "../apps/server/gateway";
import { CepTelemetry } from "../apps/server/telemetry";
import { IntegrationResilience } from "../apps/server/integration-resilience";
import type { Integration } from "../packages/contracts/integration-task";

test("@sfield/preset-memory and @sfield/preset-local boot with zero boilerplate and refuse production", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sfield-presets-test-"));
  try {
    const echoTool = defineTool({
      id: "preset.echo",
      version: "1.0.0",
      description: "Echo input",
      inputs: { type: "object", properties: { v: { type: "string" } }, required: ["v"], additionalProperties: false },
      outputs: { type: "object", properties: { v: { type: "string" } }, required: ["v"], additionalProperties: false },
      policy: { effect: "read", classification: "public" },
      handler: async ({ v }) => ({ v: String(v) }),
    });

    // 1. preset: "memory"
    const sfMem = await SField.create({
      config: { version: 1, models: {}, agents: {} },
      preset: "memory",
      tools: [echoTool],
      quiet: true,
    });
    try {
      const res = await sfMem.registry.execute({ toolRef: "preset.echo@1.0.0", inputs: { v: "mem-ok" } });
      assert.equal(res.status, "succeeded");
      assert.deepEqual(res.output, { v: "mem-ok" });
    } finally {
      await sfMem.close();
    }

    // 2. preset: "local" (SQLite + FilesystemArtifactStore under SFIELD_LOCAL_DIR)
    const sfLocal = await SField.create({
      config: { version: 1, models: {}, agents: {} },
      preset: "local",
      env: { SFIELD_LOCAL_DIR: dir },
      tools: [echoTool],
      quiet: true,
    });
    try {
      const att = await sfLocal.attachments.put({
        bytes: new TextEncoder().encode("hello-local-artifact"),
        mediaType: "text/plain",
        name: "note.txt",
      });
      assert.ok(att.id.startsWith("art_"));
      assert.equal(existsSync(join(dir, "state.sqlite")), true);
    } finally {
      await sfLocal.close();
    }

    // 3. Refuses NODE_ENV=production
    await assert.rejects(
      () =>
        SField.create({
          config: { version: 1, models: {}, agents: {} },
          preset: "memory",
          env: { NODE_ENV: "production" },
          quiet: true,
        }),
      /PRESET_REFUSED|refuses to load/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("@sfield/cli eval runs guardrail suite, persists EvalReportRecord in SQLite, and enforces release gate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sfield-cli-eval-"));
  try {
    const cfgPath = join(dir, "sfield.config.yaml");
    writeFileSync(cfgPath, "version: 1\nmodels: {}\nagents: {}\n", "utf8");

    const passSuitePath = join(dir, "pass-suite.mjs");
    writeFileSync(
      passSuitePath,
      `export const suite = "safety-v1";
export const cases = [
  { id: "c1", name: "ok-1", run: async () => 42, verify: (n) => ({ pass: n === 42 }) },
  { id: "c2", name: "ok-2", run: async () => "safe", verify: (s) => ({ pass: s === "safe" }) },
];
`,
      "utf8",
    );

    const failSuitePath = join(dir, "fail-suite.mjs");
    writeFileSync(
      failSuitePath,
      `export const cases = [
  { id: "f1", name: "fails", run: async () => "bad", verify: () => ({ pass: false, reason: "guardrail violated" }) },
];
`,
      "utf8",
    );

    const dbPath = join(dir, "eval.sqlite");
    const run = async (argv: string[]) => {
      let stdout = "";
      let stderr = "";
      const code = await runCli(argv, {
        cwd: dir,
        stdout: (s) => { stdout += s; },
        stderr: (s) => { stderr += s; },
      });
      return { code, stdout, stderr };
    };

    const passRes = await run(["eval", passSuitePath, "--db", dbPath, "--config", cfgPath, "--gate-min-pass", "0.95", "--json"]);
    assert.equal(passRes.code, 0, passRes.stderr);
    const passJson = JSON.parse(passRes.stdout) as { ok: boolean; reportId: string; passRate: number; gate: { decision: string } };
    assert.equal(passJson.ok, true);
    assert.equal(passJson.passRate, 1);
    assert.equal(passJson.gate.decision, "ready_to_publish");

    // Verify persisted in SQLite
    const store = sqlitePersistence({ path: dbPath });
    await store.init({ namespace: "sfield-cli", ownerId: "test" });
    try {
      const saved = await store.evalReports.get(passJson.reportId);
      assert.ok(saved);
      assert.equal(saved.suite, "safety-v1");
    } finally {
      await store.close();
    }

    const failRes = await run(["eval", failSuitePath, "--db", dbPath, "--config", cfgPath, "--gate-min-pass", "0.9", "--json"]);
    assert.equal(failRes.code, 1);
    const failJson = JSON.parse(failRes.stdout) as { ok: boolean; gate: { decision: string } };
    assert.equal(failJson.ok, false);
    assert.equal(failJson.gate.decision, "blocked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("@sfield/core FilesystemArtifactStore and VectorMemoryIndex support durability, tenant isolation, and semantic search", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sfield-art-vec-"));
  try {
    // 1. FilesystemArtifactStore
    const store = new FilesystemArtifactStore({ rootDir: dir });
    const bytes = new TextEncoder().encode("confidential-portfolio-report");
    const committed = await store.put({ bytes, mediaType: "text/plain", classification: "confidential", tenantId: "t1", runId: "r1" });
    await store.commit(committed, { tenantId: "t1" });

    const uncommitted = await store.put({ bytes: new TextEncoder().encode("temp"), mediaType: "text/plain", classification: "public", tenantId: "t1" });

    const loaded = await store.get(committed, { tenantId: "t1", maxBytes: 1024 });
    assert.equal(new TextDecoder().decode(loaded), "confidential-portfolio-report");

    // Cross-tenant access denied
    await assert.rejects(() => store.get(committed, { tenantId: "t2", maxBytes: 1024 }), /not available/i);

    // GC removes uncommitted blob but preserves committed blob
    const gcRemoved = await store.gcUncommitted(0);
    assert.equal(gcRemoved, 1);
    await assert.rejects(() => store.get(uncommitted, { tenantId: "t1", maxBytes: 1024 }), /not available/i);
    assert.equal(new TextDecoder().decode(await store.get(committed, { tenantId: "t1", maxBytes: 1024 })), "confidential-portfolio-report");

    // 2. VectorMemoryIndex with HashEmbeddingProvider
    const index = new VectorMemoryIndex({ embedder: new HashEmbeddingProvider(128) });
    const scope = { kind: "subject" as const, tenantId: "t1", subjectId: "u1" };
    const sk = scopeKey(scope);
    const now = new Date().toISOString();
    const exp = new Date(Date.now() + 86_400_000).toISOString();
    const makeItem = (id: string, content: string): MemoryItem => ({
      id,
      version: "v1",
      scope,
      kind: "fact",
      content,
      origin: "user_explicit",
      provenance: [{ sourceType: "message", sourceId: "m1", observedAt: now }],
      classification: "internal",
      expiresAt: exp,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    await index.upsert("t1", makeItem("m-retire", "Planning early retirement savings and rollover IRA beneficiary update"), 1);
    await index.upsert("t1", makeItem("m-weather", "Prefers sunny mountain vacations in summer"), 1);

    const hits = await index.search("t1", sk, "retiring rollover account", 2);
    assert.ok(hits.length >= 1);
    assert.equal(hits[0]?.id, "m-retire");

    // Deletion raises generation and blocks stale upsert resurrection
    await index.delete("t1", "m-retire", 5);
    await index.upsert("t1", makeItem("m-retire", "stale resurrection"), 2);
    const afterDelete = await index.search("t1", sk, "retirement rollover", 5);
    assert.equal(afterDelete.some((h) => h.id === "m-retire"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("@sfield/store-postgres JsonFilePersistence passes official conformance suite and survives restart + Postgres fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sfield-pg-json-"));
  try {
    // 1. Run official @sfield/testing persistenceConformance suite against JsonFilePersistence
    let idx = 0;
    const cases = persistenceConformance(async () => {
      const store = new JsonFilePersistence({ path: join(dir, `conformance-${++idx}.json`) });
      await store.init({ namespace: "conf", ownerId: "test" });
      return store;
    });
    assert.ok(cases.length >= 4);
    for (const c of cases) {
      await c.run();
    }

    // 2. Automatic Postgres -> JSON fallback when Postgres client fails to connect
    const fallbackReasons: string[] = [];
    const brokenPgClient = createPgPoolAdapter({
      async query() {
        throw new Error("ECONNREFUSED 127.0.0.1:5432");
      },
    });

    const jsonPath = join(dir, "service-fallback.json");
    const store1 = createPostgresOrJsonPersistence({
      client: brokenPgClient,
      jsonPath,
      onFallback: (reason) => fallbackReasons.push(reason),
    });
    await store1.init({ namespace: "prod", ownerId: "node-1" });
    assert.equal(store1.activeBackend(), "json");
    assert.equal(fallbackReasons.length, 1);
    assert.match(fallbackReasons[0]!, /ECONNREFUSED/);

    await store1.lockApprovals.put({
      digest: "sha256:fallback-test",
      approver: "ops@example.com",
      decidedAt: new Date().toISOString(),
    });
    await store1.memory!.create(
      "t1",
      {
        id: "mem-1",
        version: "v1",
        scope: { kind: "subject", tenantId: "t1", subjectId: "u1" },
        kind: "fact",
        content: "Persisted across JSON fallback restart",
        origin: "user_explicit",
        provenance: [{ sourceType: "host", sourceId: "test", observedAt: new Date().toISOString() }],
        classification: "internal",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      "idem-mem-1",
    );
    await store1.close();

    // Reopen fresh instance from the same JSON file — lock approval & memory must survive!
    const store2 = createPostgresOrJsonPersistence({ jsonPath });
    await store2.init({ namespace: "prod", ownerId: "node-2" });
    assert.equal(store2.activeBackend(), "json");
    const reloadedLock = await store2.lockApprovals.get("sha256:fallback-test");
    assert.equal(reloadedLock?.approver, "ops@example.com");
    const reloadedMem = await store2.memory!.get("t1", "mem-1");
    assert.equal(reloadedMem?.content, "Persisted across JSON fallback restart");
    await store2.close();

    // 3. PostgresMemoryRepository parameterized SQL execution
    const memRows = new Map<string, MemoryItem>();
    const pgMem = new PostgresMemoryRepository(
      createPgPoolAdapter({
        async query(sql: string, values?: unknown[]) {
          if (sql.startsWith("SELECT doc FROM sfield_memory WHERE namespace = $1 AND tenant_id = $2 AND idempotency_key")) {
            return { rows: [], rowCount: 0 };
          }
          if (sql.startsWith("INSERT INTO sfield_memory ")) {
            const doc = JSON.parse(String(values?.[9])) as MemoryItem;
            memRows.set(`${values?.[0]}:${values?.[1]}`, doc);
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith("SELECT doc FROM sfield_memory WHERE namespace = $1 AND tenant_id = $2 AND id = $3")) {
            const doc = memRows.get(`${values?.[1]}:${values?.[2]}`);
            return { rows: doc ? [{ doc }] : [], rowCount: doc ? 1 : 0 };
          }
          return { rows: [], rowCount: 0 };
        },
      }),
      () => "prod",
    );
    const created = await pgMem.create(
      "t1",
      {
        id: "pg-mem-1",
        version: "v1",
        scope: { kind: "subject", tenantId: "t1", subjectId: "u1" },
        kind: "preference",
        content: "Prefers concise summaries",
        origin: "user_explicit",
        provenance: [{ sourceType: "host", sourceId: "test", observedAt: new Date().toISOString() }],
        classification: "internal",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      "pg-idem-1",
    );
    assert.equal(created.created, true);
    assert.equal((await pgMem.get("t1", "pg-mem-1"))?.content, "Prefers concise summaries");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CEP dogfoods @sfield/core GeminiProvider, @sfield/telemetry-otel, and TokenBucket/CircuitBreaker resilience", () => {
  const dir = mkdtempSync(join(tmpdir(), "cep-dogfood-"));
  try {
    // 1. Gemini gateway configuration via @sfield/core GeminiProvider
    const settings = gatewayFromEnv({
      LLM_PROVIDER: "gemini",
      GEMINI_API_KEY: "test-gemini-key",
      GEMINI_MODEL: "gemini-2.5-flash",
    });
    assert.ok(settings && settings.profile === "gemini");
    assert.equal(settings.model, "gemini-2.5-flash");
    const cfg = configureGateway(settings);
    assert.ok(cfg.options.bindings?.models?.["pzn_chat_gateway"]);

    // 2. CepTelemetry delegates into @sfield/telemetry-otel OtelTelemetrySink
    const telemetry = new CepTelemetry(dir);
    telemetry.metric("sfield.tool.duration_ms", 18, { tool: "demo.read@1.0.0", status: "succeeded" });
    telemetry.recordModelCall({
      operation: "chat",
      provider: "gemini",
      model: "gemini-2.5-flash",
      durationMs: 120,
      status: "ok",
      inputTokens: 100,
      outputTokens: 40,
    });
    const sdkSnap = telemetry.sdkOtelSnapshot();
    assert.ok(sdkSnap.spanCount >= 1);
    assert.ok(sdkSnap.metricCount >= 4);

    // 3. IntegrationResilience delegates into @sfield/core TokenBucketRateLimiter & CircuitBreaker
    let clock = 1_000_000;
    const resilience = new IntegrationResilience(() => clock);
    const integration = {
      id: "int-test",
      name: "Test API",
      rateLimit: { requestsPerMinute: 60, burst: 2 },
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 5_000 },
    } as unknown as Integration;

    assert.equal(resilience.checkBeforeCall(integration).ok, true);
    assert.equal(resilience.checkBeforeCall(integration).ok, true);
    const rl = resilience.checkBeforeCall(integration);
    assert.equal(rl.ok, false);
    if (!rl.ok) assert.equal(rl.kind, "rate_limited");

    resilience.recordFailure(integration);
    resilience.recordFailure(integration);
    const cb = resilience.checkBeforeCall(integration);
    assert.equal(cb.ok, false);
    if (!cb.ok) assert.equal(cb.kind, "circuit_open");

    clock += 5_001;
    assert.equal(resilience.snapshot(integration).circuitState, "half_open");
    resilience.recordSuccess(integration);
    assert.equal(resilience.snapshot(integration).circuitState, "closed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
