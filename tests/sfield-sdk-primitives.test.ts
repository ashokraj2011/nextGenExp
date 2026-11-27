import test from "node:test";
import assert from "node:assert/strict";
import {
  SField,
  SFieldError,
  EphemeralPersistence,
  defineTool,
  digestJson,
  shorthandIdentity,
  createDevAuthorizer,
  LOCAL_DEV_PRINCIPAL,
  createPiiFirewall,
  createPiiFirewallHook,
  createToolResilienceGuard,
  createMcpClient,
  createMcpProxyTools,
  formatRunStreamSse,
  type ModelBinding,
  type ModelProvider,
  type ModelStreamEvent,
  type Principal,
  type SFieldPlugin,
} from "@sfield/core";

function createEchoModelPlugin(onRequest?: (text: string) => void): { plugin: SFieldPlugin; binding: ModelBinding } {
  const provider: ModelProvider = {
    id: "mock-sdk-provider",
    async describe() {
      return {
        inputLimit: 32_000,
        outputLimit: 2048,
        toolUse: true,
        structuredOutput: "none",
        strictTools: false,
        streamingUsage: true,
        media: [],
        opaqueContinuation: false,
        tokenCounting: "estimated",
        continueStopReason: false,
      };
    },
    async compile(req) {
      const userText = req.messages
        .flatMap((m) => (m.role === "tool_results" ? [] : m.parts))
        .filter((p) => p.type === "text")
        .map((p) => (p.type === "text" ? p.text : ""))
        .join(" ");
      const body = JSON.stringify({ userText });
      return {
        provider: "mock-sdk-provider",
        url: "mock://echo",
        method: "POST",
        headers: {},
        body,
        aliasMap: {},
        overheadTokens: 0,
        degradations: [],
        equivalence: { toolsExact: true, schemaExact: true, notes: [] },
        digest: digestJson({ body }),
      };
    },
    async *stream(compiled): AsyncIterable<ModelStreamEvent> {
      const { userText } = JSON.parse(compiled.body) as { userText: string };
      onRequest?.(userText);
      const reply = `Echo: ${userText}`;
      yield { type: "text_delta", text: reply.slice(0, 8) };
      yield { type: "text_delta", text: reply.slice(8) };
      yield {
        type: "done",
        message: { role: "assistant", parts: [{ type: "text", text: reply }] },
        stopReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 10, reported: true },
      };
    },
  };

  const plugin: SFieldPlugin = {
    manifest: {
      id: "mock-provider-plugin",
      version: "1.0.0",
      apiVersion: 1,
      coreCompatibility: "0.1.0",
      buildDigest: "sha256:mock-provider-plugin-v1",
      requires: [],
    },
    register(registrar) {
      registrar.provider(provider);
    },
  };

  const binding: ModelBinding = {
    identity: shorthandIdentity("model", "default", ["mock-sdk-provider", "echo-1"], "restricted"),
    provider: "mock-sdk-provider",
    model: "echo-1",
    acceptsClassification: "restricted",
    limits: { contextWindow: 32_000, maxOutputTokens: 2048 },
    supportedParams: [],
  };

  return { plugin, binding };
}

test("@sfield/core built-in PII Firewall hook scrubs egress PII and rehydrates locally", async () => {
  const seenByModel: string[] = [];
  const redactions: Array<{ runId: string; count: number }> = [];
  const firewall = createPiiFirewall({ knownNames: ["Alice Morgan"] });

  const { plugin, binding } = createEchoModelPlugin((text) => seenByModel.push(text));
  const sf = await SField.create({
    deployment: "ephemeral",
    config: {
      version: 1,
      models: { default: { binding: "default" } },
      agents: {
        assistant: {
          instructions: "Echo the user.",
          tools: [],
          policy: { preset: "read_only" },
        },
      },
    },
    persistence: new EphemeralPersistence(),
    authorizer: createDevAuthorizer(),
    plugins: [plugin],
    bindings: { models: { default: binding } },
    hooks: [
      createPiiFirewallHook(firewall, {
        onRedaction: ({ runId, tokens }) => redactions.push({ runId, count: tokens.length }),
      }),
    ],
  });

  try {
    const session = await sf.sessions.open({ agent: "assistant", principal: LOCAL_DEV_PRINCIPAL });
    const handle = await session.send({
      message: { text: "Alice Morgan (alice@example.com, SSN 123-45-6789) account DEMO-MID-1001" },
    });
    const res = await handle.result();
    await session.close();

    assert.equal(res.state, "completed");
    assert.equal(seenByModel.length, 1);
    assert.doesNotMatch(seenByModel[0]!, /Alice Morgan|alice@example\.com|123-45-6789|DEMO-MID-1001/);
    assert.match(seenByModel[0]!, /\[PII_SSN_1\]/);
    assert.match(seenByModel[0]!, /\[PII_EMAIL_1\]/);
    assert.match(seenByModel[0]!, /\[PII_ACCOUNT_ID_1\]/);
    assert.match(seenByModel[0]!, /\[PII_PERSON_NAME_1\]/);
    assert.equal(redactions.length, 1);
    assert.equal(redactions[0]!.count, 4);

    const rehydrated = firewall.rehydrateRunOutput(res.runId, res.output);
    assert.match(String(rehydrated), /Alice Morgan/);
    assert.match(String(rehydrated), /123-45-6789/);
    assert.match(String(rehydrated), /DEMO-MID-1001/);
  } finally {
    await sf.close();
  }
});

test("@sfield/core ToolResilienceGuard enforces token-bucket rate limits and 3-state circuit breaker", async () => {
  let now = 1_000_000;
  const guard = createToolResilienceGuard({
    rateLimit: { capacity: 2, refillPerSecond: 1 },
    circuitBreaker: { failureThreshold: 2, cooldownMs: 5_000 },
    now: () => now,
  });

  // 1. Rate limiting: 2 calls allowed in burst, 3rd hits RATE_LIMITED
  assert.equal(await guard.execute("crm", async () => "ok1"), "ok1");
  assert.equal(await guard.execute("crm", async () => "ok2"), "ok2");
  await assert.rejects(
    () => guard.execute("crm", async () => "ok3"),
    (err: unknown) => err instanceof SFieldError && err.code === "RATE_LIMITED" && err.retryable,
  );

  // Advance clock 3s -> tokens refill
  now += 3_000;
  assert.equal(await guard.execute("crm", async () => "ok4"), "ok4");

  // 2. Circuit breaker: 2 consecutive failures trip to OPEN
  await assert.rejects(() => guard.execute("oms", async () => { throw new Error("upstream 503"); }));
  assert.equal(guard.status("oms").circuit, "closed");
  await assert.rejects(() => guard.execute("oms", async () => { throw new Error("upstream 503"); }));
  assert.equal(guard.status("oms").circuit, "open");

  await assert.rejects(
    () => guard.execute("oms", async () => "should not run"),
    (err: unknown) => err instanceof SFieldError && err.code === "CIRCUIT_OPEN" && err.retryable,
  );

  // Advance past cooldown -> half_open probe succeeds -> back to closed!
  now += 6_000;
  assert.equal(guard.status("oms").circuit, "half_open");
  assert.equal(await guard.execute("oms", async () => "recovered"), "recovered");
  assert.equal(guard.status("oms").circuit, "closed");
});

test("@sfield/core federation: Principal RBAC SFieldMcpServer <-> McpClient + createMcpProxyTools", async () => {
  const analystPrincipal: Principal = { tenantId: "t1", subjectId: "analyst-1", roles: ["analyst"], attributes: {} };
  const adminPrincipal: Principal = { tenantId: "t1", subjectId: "admin-1", roles: ["admin"], attributes: {} };

  const lookupTool = defineTool({
    id: "ledger.balance.read",
    version: "1.0.0",
    description: "Reads a ledger balance by accountId.",
    inputs: {
      type: "object",
      additionalProperties: false,
      required: ["accountId"],
      properties: { accountId: { type: "string", minLength: 1, maxLength: 32 } },
    },
    outputs: {
      type: "object",
      additionalProperties: false,
      required: ["accountId", "cents"],
      properties: { accountId: { type: "string" }, cents: { type: "integer" } },
    },
    policy: { action: "ledger.balance.read", effect: "read", requiresApproval: false, timeoutMs: 2_000, maxAttempts: 1, classification: "public", maxOutputBytes: 4096 },
    handler: async (raw) => ({ accountId: String((raw as { accountId: string }).accountId), cents: 425_000 }),
  });

  const adminWriteTool = defineTool({
    id: "ledger.freeze.write",
    version: "1.0.0",
    description: "Freezes an account (admin role only).",
    resource: { type: "account", id: { ref: "inputs.accountId" } },
    inputs: {
      type: "object",
      additionalProperties: false,
      required: ["accountId"],
      properties: { accountId: { type: "string", minLength: 1, maxLength: 32 } },
    },
    outputs: {
      type: "object",
      additionalProperties: false,
      required: ["frozen"],
      properties: { frozen: { type: "boolean" } },
    },
    policy: { action: "ledger.freeze.write", effect: "write", requiresApproval: false, timeoutMs: 2_000, maxAttempts: 1, classification: "public", maxOutputBytes: 4096 },
    handler: async () => ({ frozen: true }),
  });

  const tenantAuthorizer = {
    async authorize({ principal }: { principal: Principal }) {
      return principal.tenantId === "t1"
        ? { decision: "allow" as const, evidenceId: `ev_${principal.subjectId}`, expiresAt: new Date(Date.now() + 60_000).toISOString() }
        : { decision: "deny" as const, code: "ACCESS_DENIED", reason: "wrong tenant" };
    },
  };

  // Server SField runtime
  const serverSf = await SField.create({
    deployment: "ephemeral",
    config: { version: 1, models: {}, agents: {} },
    persistence: new EphemeralPersistence(),
    authorizer: tenantAuthorizer,
    tools: [lookupTool, adminWriteTool],
  });

  const serverMcp = serverSf.createMcpServer({
    serverInfo: { name: "ledger-sfield-mcp", version: "1.0.0" },
    authenticate: (headers) => {
      if (headers.authorization === "Bearer tok-analyst") return analystPrincipal;
      if (headers.authorization === "Bearer tok-admin") return adminPrincipal;
      return null;
    },
    allowTools: (tool, principal) => {
      if (tool.policy.effect === "read") return true;
      return Boolean(principal?.roles.includes("admin"));
    },
  });

  try {
    // 1. Unauthorized header rejected
    const unauth = await serverMcp.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { headers: { authorization: "Bearer bad" } });
    assert.equal((unauth.body as { error?: { code: number } }).error?.code, -32001);

    // 2. Analyst sees ONLY read tool; Admin sees BOTH read + write tools
    const analystList = await serverMcp.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { headers: { authorization: "Bearer tok-analyst" } });
    assert.deepEqual(
      ((analystList.body as { result: { tools: Array<{ name: string }> } }).result.tools).map((t) => t.name),
      ["ledger.balance.read@1.0.0"],
    );
    const adminList = await serverMcp.handleRequest({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { headers: { authorization: "Bearer tok-admin" } });
    assert.deepEqual(
      ((adminList.body as { result: { tools: Array<{ name: string }> } }).result.tools).map((t) => t.name).sort(),
      ["ledger.balance.read@1.0.0", "ledger.freeze.write@1.0.0"],
    );

    // 3. Client SField runtime discovers & mounts Server SField's tools via createMcpProxyTools!
    const mcpClient = createMcpClient({
      inProcessHandler: (req) => serverMcp.handleRequest(req, { headers: { authorization: "Bearer tok-analyst" } }),
    });
    const resilience = createToolResilienceGuard({ rateLimit: { capacity: 10, refillPerSecond: 5 } });
    const proxyTools = await createMcpProxyTools(mcpClient, { namespace: "remote_ledger", resilience });
    assert.equal(proxyTools.length, 1);
    assert.equal(proxyTools[0]!.id, "remote_ledger.ledger.balance.read");
    assert.equal(proxyTools[0]!.policy.effect, "read");

    const clientSf = await SField.create({
      deployment: "ephemeral",
      config: { version: 1, models: {}, agents: {} },
      persistence: new EphemeralPersistence(),
      authorizer: tenantAuthorizer,
      tools: proxyTools,
    });
    try {
      const scope = await clientSf.executions.open({ principal: analystPrincipal, purpose: "federated-read", preset: "read_only" });
      const res = await scope.registry.execute(proxyTools[0]!.ref, { accountId: "ACCT-99" });
      await scope.close();
      assert.equal(res.status, "succeeded");
      const out = res.output as { remoteTool: string; ok: boolean; resultJson: string };
      assert.equal(out.remoteTool, "ledger.balance.read@1.0.0");
      assert.equal(out.ok, true);
      const parsedRemote = JSON.parse(out.resultJson) as { sfieldRunId: string; output: { accountId: string; cents: number } };
      assert.ok(parsedRemote.sfieldRunId.startsWith("run_"));
      assert.deepEqual(parsedRemote.output, { accountId: "ACCT-99", cents: 425_000 });
    } finally {
      await clientSf.close();
    }
  } finally {
    await serverSf.close();
  }
});

test("@sfield/core DelegationService (parent->child audit, depth guard, identity lock) and streamRun()", async () => {
  const { plugin, binding } = createEchoModelPlugin();
  const sf = await SField.create({
    deployment: "ephemeral",
    config: {
      version: 1,
      models: { default: { binding: "default" } },
      agents: {
        parent: { instructions: "Parent coordinator.", tools: [], policy: { preset: "read_only" } },
        specialist: { instructions: "Child specialist.", tools: [], policy: { preset: "read_only" } },
      },
    },
    persistence: new EphemeralPersistence(),
    authorizer: createDevAuthorizer(),
    plugins: [plugin],
    bindings: { models: { default: binding } },
  });

  try {
    // 1. Run a parent session & verify streamRun() yields typed chunks + SSE frames
    const parentSession = await sf.sessions.open({ agent: "parent", principal: LOCAL_DEV_PRINCIPAL });
    const parentHandle = await parentSession.send({ message: { text: "Coordinate analysis" } });
    const chunks = [];
    for await (const chunk of sf.streamRun(parentHandle)) {
      chunks.push(chunk);
    }
    const parentRes = await parentHandle.result();
    await parentSession.close();
    assert.equal(parentRes.state, "completed");
    assert.ok(chunks.some((c) => c.kind === "run_finished"), "expected run_finished chunk from streamRun()");
    assert.match(formatRunStreamSse(chunks.at(-1)!), /event: run_finished\ndata: /);

    // 2. Delegate from parent -> specialist under same Principal
    const del = await sf.delegation.delegate({
      parentRunId: parentRes.runId,
      agent: "specialist",
      message: "Check compliance clause 4",
      principal: LOCAL_DEV_PRINCIPAL,
    });
    assert.equal(del.result.state, "completed");
    assert.equal(del.depth, 1);
    assert.match(String(del.result.output), /Check compliance clause 4/);

    // 3. Delegation audit tree links parent -> child cleanly
    const tree = await sf.delegation.tree(parentRes.runId, LOCAL_DEV_PRINCIPAL.tenantId);
    assert.equal(tree.length, 1);
    assert.equal(tree[0]!.childRunId, del.childRunId);
    assert.equal(tree[0]!.agent, "specialist");
    assert.equal(tree[0]!.state, "completed");

    // 4. Delegation blocks identity escalation (different subjectId than parent)
    await assert.rejects(
      () => sf.delegation.delegate({
        parentRunId: parentRes.runId,
        agent: "specialist",
        message: "Escalate!",
        principal: { tenantId: LOCAL_DEV_PRINCIPAL.tenantId, subjectId: "other-user", roles: ["admin"], attributes: {} },
      }),
      (err: unknown) => err instanceof SFieldError && err.code === "ACCESS_DENIED",
    );

    // 5. Delegation blocks exceeding maxDepth
    await assert.rejects(
      () => sf.delegation.delegate({
        parentRunId: parentRes.runId,
        agent: "specialist",
        message: "Too deep",
        principal: LOCAL_DEV_PRINCIPAL,
        depth: 3,
        maxDepth: 3,
      }),
      (err: unknown) => err instanceof SFieldError && err.code === "LOOP_DETECTED",
    );
  } finally {
    await sf.close();
  }
});
