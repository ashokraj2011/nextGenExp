import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SField,
  EphemeralPersistence,
  GeminiProvider,
  approveLock,
  createDevAuthorizer,
  LOCAL_DEV_PRINCIPAL,
  defineTool,
  type ModelBinding,
  type NeutralModelRequest,
} from "@sfield/core";
import { createOtelTelemetrySink } from "@sfield/telemetry-otel";
import { runEvalSuite, evaluateReleaseGate } from "@sfield/testing";
import {
  PostgresPersistence,
  POSTGRES_SCHEMA_SQL,
  createPgPoolAdapter,
  createServiceMemoryPersistence,
} from "@sfield/store-postgres";
import { sqlitePersistence } from "@sfield/store-sqlite";
import { runCli } from "@sfield/cli";

test("@sfield/telemetry-otel captures gen_ai spans/metrics and exports OTLP/HTTP JSON", async () => {
  const exportedRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    exportedRequests.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const sink = createOtelTelemetrySink({
    serviceName: "sfield-test-agent",
    serviceVersion: "1.0.0",
    otlpEndpoint: "http://otel-collector.local:4318",
    fetchImpl: mockFetch,
  });

  sink.event("sfield.tool.executed", { tool: "demo.lookup@1.0.0", durationMs: 42, status: "ok" });
  sink.recordModelCall({
    provider: "gemini",
    model: "gemini-2.5-flash",
    operation: "chat",
    durationMs: 185,
    inputTokens: 320,
    outputTokens: 96,
    costMicroUsd: 120,
    status: "ok",
  });

  const snap = sink.snapshot();
  assert.equal(snap.spanCount, 2);
  assert.ok(snap.metricCount >= 3);
  assert.equal(snap.spans[1]?.name, "gen_ai.chat");
  assert.equal(snap.spans[1]?.attributes["gen_ai.system"], "gemini");

  const payload = sink.buildOtlpTracePayload();
  assert.equal(payload.resourceSpans.length, 1);
  assert.equal(payload.resourceSpans[0]?.scopeSpans[0]?.spans.length, 2);

  const flush1 = await sink.flush();
  assert.equal(flush1.exportedSpans, 2);
  assert.equal(flush1.statusCode, 200);
  assert.equal(exportedRequests.length, 1);
  assert.equal(exportedRequests[0]?.url, "http://otel-collector.local:4318/v1/traces");

  // Second flush with no new spans is a no-op
  const flush2 = await sink.flush();
  assert.equal(flush2.exportedSpans, 0);
  assert.equal(exportedRequests.length, 1);
});

test("@sfield/testing runEvalSuite persists EvalReportRecord and evaluateReleaseGate gates release", async () => {
  const sf = await SField.create({
    config: { version: 1, models: {}, agents: {} },
    deployment: "ephemeral",
    persistence: new EphemeralPersistence(),
    authorizer: createDevAuthorizer(),
    devPrincipal: LOCAL_DEV_PRINCIPAL,
    quiet: true,
  });

  try {
    const digest = sf.config.digest();
    const passSuite = await runEvalSuite(
      [
        {
          id: "c1",
          name: "schema check",
          category: "safety",
          run: async () => ({ safe: true }),
          verify: (out) => ({ pass: (out as { safe: boolean }).safe === true }),
        },
        {
          id: "c2",
          name: "pii redaction check",
          category: "privacy",
          run: async () => "Email: [REDACTED_EMAIL_1]",
          verify: (out) => ({ pass: String(out).includes("[REDACTED_EMAIL_1]") }),
        },
      ],
      {
        suite: "release-guardrails",
        candidateDigest: digest,
        modelTargets: ["gemini-2.5-flash"],
        evalReports: sf.lock.evalReports(),
      },
    );

    assert.equal(passSuite.totalCases, 2);
    assert.equal(passSuite.passedCases, 2);
    assert.equal(passSuite.report.passRate, 1);

    const stored = await sf.lock.evalReports().get(passSuite.report.id);
    assert.ok(stored);
    assert.equal(stored.candidateDigest, digest);

    const readyVerdict = evaluateReleaseGate(passSuite.report, { minPassRate: 0.95 });
    assert.equal(readyVerdict.decision, "ready_to_publish");
    assert.equal(readyVerdict.reasons.length, 0);

    const failSuite = await runEvalSuite(
      [
        {
          id: "f1",
          name: "always fails",
          run: async () => "bad output",
          verify: () => ({ pass: false, reason: "policy violation" }),
        },
      ],
      {
        suite: "release-guardrails",
        candidateDigest: digest,
      },
    );
    const blockedVerdict = evaluateReleaseGate(failSuite.report, { minPassRate: 0.9 });
    assert.equal(blockedVerdict.decision, "blocked");
    assert.ok(blockedVerdict.reasons.some((r) => /pass/i.test(r)), JSON.stringify(blockedVerdict.reasons));
  } finally {
    await sf.close();
  }
});

test("@sfield/core GeminiProvider compiles requests, streams SSE text+tool calls, and passes SField.validate", async () => {
  // 1. Config validation accepts provider: "gemini" with top_k
  const validation = await SField.validate({
    config: {
      version: 1,
      models: {
        flash: {
          provider: "gemini",
          model: "gemini-2.5-flash",
          credential: { env: "GEMINI_API_KEY" },
          params: { temperature: 0.1, top_k: 40, max_output_tokens: 1024 },
        },
      },
      agents: {
        helper: {
          model: "flash",
          instructions: "Be concise.",
        },
      },
    },
    env: { GEMINI_API_KEY: "test-key" },
  });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));

  // 2. Compile & stream mock Gemini v1beta SSE frames
  const sseChunks = [
    `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Checking weather " }] } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      candidates: [{
        content: {
          parts: [
            { text: "now." },
            { functionCall: { name: "get_weather", args: { city: "Zurich" } } },
          ],
        },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 112, candidatesTokenCount: 28 },
    })}\n\n`,
  ];

  const encoder = new TextEncoder();
  const mockFetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of sseChunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  const provider = new GeminiProvider(mockFetch);
  const binding: ModelBinding = {
    identity: { id: "flash", revision: "1", accountScope: "test", classification: "internal" },
    provider: "gemini",
    model: "gemini-2.5-flash",
    credential: { env: "GEMINI_API_KEY" },
    acceptsClassification: "internal",
    limits: { contextWindow: 1_000_000, maxOutputTokens: 8192 },
    supportedParams: ["max_output_tokens", "temperature", "top_p", "top_k", "stop_sequences"],
    params: { temperature: 0.2, top_k: 32 },
  };
  const request: NeutralModelRequest = {
    binding,
    params: { maxOutputTokens: 1024, temperature: 0.2 },
    toolChoice: "auto",
    instructions: ["You are a helpful weather assistant."],
    messages: [{ role: "user", parts: [{ type: "text", text: "Weather in Zurich?" }] }],
    tools: [
      {
        ref: "weather.get@1.0.0",
        alias: "get_weather",
        description: "Get weather for a city",
        inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        effect: "read",
        requiresApproval: false,
        tokens: 24,
        builtin: false,
      },
    ],
    outputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
  };

  const compiled = await provider.compile(request);
  assert.ok(compiled.url.includes("/models/gemini-2.5-flash:streamGenerateContent?alt=sse"));
  const bodyObj = JSON.parse(compiled.body) as Record<string, unknown>;
  assert.ok(bodyObj["systemInstruction"]);
  assert.ok(Array.isArray(bodyObj["tools"]));
  assert.ok((bodyObj["generationConfig"] as Record<string, unknown>)?.["responseSchema"]);

  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const ev of provider.stream(compiled, {
    signal: new AbortController().signal,
    attemptId: "att-1",
    secrets: { resolve: async () => "fake-gemini-key" },
    binding,
  })) {
    events.push(ev as { type: string; [k: string]: unknown });
  }

  const deltas = events.filter((e) => e.type === "text_delta").map((e) => e["text"]).join("");
  assert.equal(deltas, "Checking weather now.");
  assert.ok(events.some((e) => e.type === "tool_call_start" && e["alias"] === "get_weather"));

  const done = events.find((e) => e.type === "done") as
    | { stopReason: string; usage: { inputTokens: number; outputTokens: number; reported: boolean }; message: { parts: unknown[] } }
    | undefined;
  assert.ok(done);
  assert.equal(done.stopReason, "tool_use");
  assert.equal(done.usage.inputTokens, 112);
  assert.equal(done.usage.outputTokens, 28);
  assert.equal(done.usage.reported, true);
});

test("@sfield/store-postgres executes DDL & parameterized SQL and supports deployment:'service' lock gating", async () => {
  // 1. Verify DDL & parameterized queries through createPgPoolAdapter
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const lockDocs = new Map<string, Record<string, unknown>>();
  const fakePool = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, params: values });
      if (sql.startsWith("INSERT INTO sfield_lock_approvals")) {
        lockDocs.set(String(values?.[0]), JSON.parse(String(values?.[4])) as Record<string, unknown>);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("SELECT doc FROM sfield_lock_approvals WHERE namespace = $1 AND digest = $2")) {
        const doc = lockDocs.get(String(values?.[1]));
        return { rows: doc ? [{ doc }] : [], rowCount: doc ? 1 : 0 };
      }
      if (sql === "SELECT 1") return { rows: [{ "?column?": 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };

  assert.ok(POSTGRES_SCHEMA_SQL.includes("CREATE TABLE IF NOT EXISTS sfield_runs"));
  const pgStore = new PostgresPersistence({ client: createPgPoolAdapter(fakePool) });
  assert.equal(pgStore.mode, "service");
  await pgStore.init({ namespace: "prod", ownerId: "pod-1" });
  assert.ok(queries.some((q) => q.sql.includes("CREATE TABLE IF NOT EXISTS sfield_runs")));

  const health = await pgStore.health();
  assert.equal(health.ok, true);

  const putRes = await pgStore.lockApprovals.put({
    digest: "sha256:abc123",
    approver: "alice@example.com",
    decidedAt: new Date().toISOString(),
  });
  assert.equal(putRes.changed, true);
  const loaded = await pgStore.lockApprovals.get("sha256:abc123");
  assert.equal(loaded?.approver, "alice@example.com");
  await pgStore.close();

  // 2. Verify deployment: "service" enforces lock approval with createServiceMemoryPersistence()
  const svcStore = createServiceMemoryPersistence();
  assert.equal(svcStore.mode, "service");
  const config = { version: 1, models: {}, agents: {} };
  const val = await SField.validate({ config });
  assert.ok(val.ok && val.digest);

  const allowAll = {
    authorize: async () => ({
      decision: "allow" as const,
      evidenceId: "ev-test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  };

  // Without approval, SField.create in service mode must fail with LOCK_MANIFEST_UNAPPROVED
  await assert.rejects(
    () =>
      SField.create({
        config,
        deployment: "service",
        persistence: svcStore,
        authorizer: allowAll,
      }),
    /LOCK_MANIFEST_UNAPPROVED|approval record/i,
  );

  // Approve the lock digest in the service persistence store, then boot cleanly
  await svcStore.init({ namespace: "default", ownerId: "bootstrap" });
  await approveLock(
    { digest: val.digest, approver: "release-bot", comment: "CI gate passed" },
    undefined,
    { lockApprovals: svcStore.lockApprovals, evalReports: svcStore.evalReports },
  );

  const sf = await SField.create({
    config,
    deployment: "service",
    persistence: svcStore,
    authorizer: allowAll,
  });
  try {
    const status = await sf.lock.status();
    assert.equal(status.required, true);
    assert.equal(status.approved?.approver, "release-bot");
  } finally {
    await sf.close();
  }
});

test("@sfield/cli runs init, validate, lock approve/status, and inspect end-to-end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sfield-cli-test-"));
  try {
    const capture = async (argv: string[]) => {
      let stdout = "";
      let stderr = "";
      const code = await runCli(argv, {
        cwd: dir,
        stdout: (s) => { stdout += s; },
        stderr: (s) => { stderr += s; },
      });
      return { code, stdout, stderr };
    };

    // 1. init
    const initRes = await capture(["init", ".", "--json"]);
    assert.equal(initRes.code, 0, initRes.stderr);
    assert.equal(existsSync(join(dir, "sfield.config.yaml")), true);
    assert.equal(existsSync(join(dir, "agent.mjs")), true);

    // 2. validate (with env unset -> validate runs with checkCredentials: false)
    const valRes = await capture(["validate", "sfield.config.yaml", "--json"]);
    assert.equal(valRes.code, 0, valRes.stderr);
    const valJson = JSON.parse(valRes.stdout) as { ok: boolean; digest: string; agents: string[]; models: string[] };
    assert.equal(valJson.ok, true);
    assert.ok(valJson.digest.length > 10);
    assert.deepEqual(valJson.agents, ["assistant"]);
    assert.deepEqual(valJson.models, ["primary"]);

    // 3. lock status (unapproved) -> lock approve -> lock status (approved)
    const dbPath = join(dir, "state.sqlite");
    const statusBefore = await capture(["lock", "status", "--db", dbPath, "--config", "sfield.config.yaml", "--json"]);
    assert.equal(statusBefore.code, 0, statusBefore.stderr);
    assert.equal((JSON.parse(statusBefore.stdout) as { approved: boolean }).approved, false);

    const approveRes = await capture([
      "lock",
      "approve",
      "--db",
      dbPath,
      "--config",
      "sfield.config.yaml",
      "--approver",
      "sec-lead",
      "--comment",
      "Verified for prod",
      "--json",
    ]);
    assert.equal(approveRes.code, 0, approveRes.stderr);
    assert.equal((JSON.parse(approveRes.stdout) as { changed: boolean }).changed, true);

    const statusAfter = await capture(["lock", "status", "--db", dbPath, "--config", "sfield.config.yaml", "--json"]);
    assert.equal(statusAfter.code, 0, statusAfter.stderr);
    const afterJson = JSON.parse(statusAfter.stdout) as { approved: boolean; record: { approver: string } };
    assert.equal(afterJson.approved, true);
    assert.equal(afterJson.record.approver, "sec-lead");

    // 4. Seed a real execution scope run in SQLite and inspect it via CLI
    const sf = await SField.create({
      config: { version: 1, models: {}, agents: {} },
      deployment: "durable_single",
      persistence: sqlitePersistence({ path: dbPath }),
      tools: [
        defineTool({
          id: "cli.ping",
          version: "1.0.0",
          description: "Ping test tool",
          inputs: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"], additionalProperties: false },
          outputs: { type: "object", properties: { pong: { type: "string" } }, required: ["pong"], additionalProperties: false },
          policy: { effect: "read", classification: "internal" },
          handler: async ({ msg }) => ({ pong: String(msg) }),
        }),
      ],
      authorizer: createDevAuthorizer(),
      devPrincipal: LOCAL_DEV_PRINCIPAL,
      quiet: true,
    });

    const scope = await sf.executions.open({ purpose: "cli-inspect-test", preset: "read_only" });
    await scope.registry.execute("cli.ping@1.0.0", { msg: "hello" });
    const runId = scope.id;
    await scope.close();
    await sf.close();

    const inspectRes = await capture(["inspect", runId, "--db", dbPath, "--json"]);
    assert.equal(inspectRes.code, 0, inspectRes.stderr);
    const inspected = JSON.parse(inspectRes.stdout) as {
      ok: boolean;
      run: { runId: string; state: string };
      calls: Array<{ toolRef: string; state: string }>;
    };
    assert.equal(inspected.ok, true);
    assert.equal(inspected.run.runId, runId);
    assert.equal(inspected.calls.length, 1);
    assert.equal(inspected.calls[0]?.toolRef, "cli.ping@1.0.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
