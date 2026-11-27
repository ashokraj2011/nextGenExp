import assert from "node:assert/strict";
import test from "node:test";
import {
  createMcpClient,
  createPrincipal,
  defineTool,
  MCP_EXTENSION_ELICITATION,
  MCP_EXTENSION_TASKS,
  MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_2026,
  requestElicitation,
  SField,
  type Principal,
} from "@sfield/core";

function makeAllowAllTenantAuthorizer() {
  return {
    authorize: async (req: { resource: { id: string } }) => ({
      decision: "allow" as const,
      evidenceId: `ev_${req.resource.id}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  };
}

test("@sfield/core MCP 2026: version negotiation, stateless server/discover, Elicitation (sync + validation + decline), Async Tasks + mid-flight Elicitation, cancellation, and tenant isolation", async () => {
  const wireTransferTool = defineTool({
    id: "bank.wire.send",
    version: "1.0.0",
    description: "Send a wire transfer; elicits confirmation reason if missing.",
    inputs: {
      type: "object",
      additionalProperties: false,
      required: ["amountUsd"],
      properties: {
        amountUsd: { type: "number" },
        reason: { type: "string" },
        confirm: { type: "boolean" },
      },
    },
    outputs: {
      type: "object",
      additionalProperties: false,
      required: ["status", "amountUsd", "reason", "subjectId"],
      properties: {
        status: { type: "string" },
        amountUsd: { type: "number" },
        reason: { type: "string" },
        subjectId: { type: "string" },
      },
    },
    policy: { effect: "read", classification: "internal" },
    handler: async (raw, ctx) => {
      const amountUsd = Number(raw["amountUsd"]);
      const reason = typeof raw["reason"] === "string" ? raw["reason"].trim() : "";
      const confirm = raw["confirm"] === true;
      if (!reason || !confirm) {
        requestElicitation({
          message: `Please confirm sending $${amountUsd} and provide a wire reason.`,
          requestedSchema: {
            type: "object",
            additionalProperties: false,
            required: ["confirm", "reason"],
            properties: {
              confirm: { type: "boolean" },
              reason: { type: "string", minLength: 3 },
            },
          },
        });
      }
      return {
        status: "sent",
        amountUsd,
        reason,
        subjectId: ctx.principal.subjectId,
      };
    },
  });

  let slowAborted = false;
  const slowReportTool = defineTool({
    id: "analytics.report.build",
    version: "1.0.0",
    description: "Build an async analytics report with optional delay and abort handling.",
    inputs: {
      type: "object",
      additionalProperties: false,
      required: ["reportName"],
      properties: {
        reportName: { type: "string" },
        delayMs: { type: "number" },
      },
    },
    outputs: {
      type: "object",
      additionalProperties: false,
      required: ["reportName", "rows"],
      properties: {
        reportName: { type: "string" },
        rows: { type: "number" },
      },
    },
    policy: { effect: "read", classification: "internal" },
    handler: async (raw, ctx) => {
      const delayMs = typeof raw["delayMs"] === "number" ? raw["delayMs"] : 40;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        ctx.signal.addEventListener("abort", () => {
          slowAborted = true;
          clearTimeout(timer);
          reject(new Error("aborted"));
        }, { once: true });
      });
      return { reportName: String(raw["reportName"]), rows: 42 };
    },
  });

  const sf = await SField.create({
    config: { version: 1, models: {}, agents: {} },
    preset: "memory",
    tools: [wireTransferTool, slowReportTool],
    authorizer: makeAllowAllTenantAuthorizer(),
    quiet: true,
  });

  const tenantA: Principal = createPrincipal({ tenantId: "tenant-a", subjectId: "alice", roles: ["analyst"] });
  const tenantB: Principal = createPrincipal({ tenantId: "tenant-b", subjectId: "mallory", roles: ["analyst"] });

  const mcpServer = sf.createMcpServer({
    serverInfo: { name: "sfield-mcp-2026-test", version: "2.0.0" },
    allowTools: ["bank.wire.send@1.0.0", "analytics.report.build@1.0.0"],
  });

  const clientA = createMcpClient({
    inProcessHandler: (req) => mcpServer.handleRequest(req, { principal: tenantA }),
  });
  const clientB = createMcpClient({
    inProcessHandler: (req) => mcpServer.handleRequest(req, { principal: tenantB }),
  });

  try {
    // 1. Stateless 2026 server/discover & version negotiation (2026 vs 2025 backward compat)
    const discovered = await clientA.discover();
    assert.ok(discovered.protocolVersions.includes(MCP_PROTOCOL_VERSION_2026));
    assert.ok(discovered.protocolVersions.includes(MCP_PROTOCOL_VERSION));
    const exts = discovered.capabilities["extensions"] as Record<string, unknown>;
    assert.ok(exts[MCP_EXTENSION_ELICITATION]);
    assert.ok(exts[MCP_EXTENSION_TASKS]);

    const init2026 = await clientA.initialize(undefined, MCP_PROTOCOL_VERSION_2026);
    assert.equal(init2026.protocolVersion, MCP_PROTOCOL_VERSION_2026);
    const init2025 = await clientB.initialize(undefined, MCP_PROTOCOL_VERSION);
    assert.equal(init2025.protocolVersion, MCP_PROTOCOL_VERSION);

    // 2. Synchronous Elicitation: tools/call -> input_required -> invalid schema rejected -> accept completes
    const firstCall = await clientA.callTool("bank.wire.send@1.0.0", { amountUsd: 5000 });
    const structured = firstCall.structuredContent as {
      status: string;
      elicitation: { elicitationId: string; mode: string; message: string; requestedSchema: Record<string, unknown> };
    };
    assert.equal(structured.status, "input_required");
    assert.equal(structured.elicitation.mode, "form");
    assert.match(structured.elicitation.message, /\$5000/);

    const pendingList = await clientA.listElicitations();
    assert.ok(pendingList.some((e) => e.elicitationId === structured.elicitation.elicitationId));

    // Cross-tenant elicitation hijack is blocked
    await assert.rejects(
      () => clientB.respondElicitation({
        elicitationId: structured.elicitation.elicitationId,
        action: "accept",
        content: { confirm: true, reason: "hijack" },
      }),
      /Access denied/,
    );

    // Schema validation rejects bad elicitation content (missing required `reason`)
    await assert.rejects(
      () => clientA.respondElicitation({
        elicitationId: structured.elicitation.elicitationId,
        action: "accept",
        content: { confirm: true },
      }),
      /schema validation/,
    );

    // Valid elicitation accept resumes and executes under original Principal
    const accepted = await clientA.respondElicitation({
      elicitationId: structured.elicitation.elicitationId,
      action: "accept",
      content: { confirm: true, reason: "Vendor invoice #882" },
    }) as { structuredContent: { status: string; output: { status: string; amountUsd: number; reason: string; subjectId: string } } };
    assert.equal(accepted.structuredContent.status, "succeeded");
    assert.equal(accepted.structuredContent.output.status, "sent");
    assert.equal(accepted.structuredContent.output.amountUsd, 5000);
    assert.equal(accepted.structuredContent.output.reason, "Vendor invoice #882");
    assert.equal(accepted.structuredContent.output.subjectId, "alice");

    // 3. Elicitation decline flow
    const declineCall = await clientA.callTool("bank.wire.send@1.0.0", { amountUsd: 900 });
    const declineId = (declineCall.structuredContent as { elicitation: { elicitationId: string } }).elicitation.elicitationId;
    const declined = await clientA.respondElicitation({ elicitationId: declineId, action: "decline" });
    assert.equal(declined["status"], "declined");

    // 4. Async Tasks Extension: callToolAsync -> tasks/list -> waitForTask -> tasks/result
    const asyncTask = await clientA.callToolAsync("analytics.report.build@1.0.0", { reportName: "Q4 Revenue", delayMs: 30 });
    assert.ok(asyncTask.taskId.startsWith("mcptask_"));
    assert.equal(asyncTask.status, "working");

    // Cross-tenant task access is blocked
    await assert.rejects(() => clientB.getTask(asyncTask.taskId), /Access denied/);
    const tenantBTasks = await clientB.listTasks();
    assert.equal(tenantBTasks.length, 0);

    const finished = await clientA.waitForTask(asyncTask.taskId, { pollIntervalMs: 15, timeoutMs: 5_000 });
    assert.equal(finished.task.status, "completed");
    const reportOut = (finished.result?.structuredContent as { output: { reportName: string; rows: number } }).output;
    assert.equal(reportOut.reportName, "Q4 Revenue");
    assert.equal(reportOut.rows, 42);

    // 5. Combined Async Task + Mid-Flight Elicitation via waitForTask({ onElicitation })
    const hybridTask = await clientA.callToolAsync("bank.wire.send@1.0.0", { amountUsd: 12500 });
    let elicitedMessage = "";
    const hybridDone = await clientA.waitForTask(hybridTask.taskId, {
      pollIntervalMs: 15,
      timeoutMs: 5_000,
      onElicitation: async (req) => {
        elicitedMessage = req.message;
        return { action: "accept", content: { confirm: true, reason: "Escrow closing" } };
      },
    });
    assert.match(elicitedMessage, /\$12500/);
    assert.equal(hybridDone.task.status, "completed");
    const wireOut = (hybridDone.result?.structuredContent as { output: { status: string; reason: string } }).output;
    assert.equal(wireOut.status, "sent");
    assert.equal(wireOut.reason, "Escrow closing");

    // 6. Async Task Cancellation aborts in-flight tool via AbortSignal
    slowAborted = false;
    const cancelTask = await clientA.callToolAsync("analytics.report.build@1.0.0", { reportName: "Huge Export", delayMs: 5_000 });
    await new Promise((r) => setTimeout(r, 25));
    const cancelled = await clientA.cancelTask(cancelTask.taskId);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(slowAborted, true);
  } finally {
    await sf.close();
  }
});
