import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, operatorHeader, reviewer } from "./operator-fixture";
import { testClient, testProject } from "./client";
import { startFixtureGateway } from "./gateway-fixture";
import type { ApprovalRecord, ApprovalsView } from "../packages/contracts/approval";
import type { EvalRunReport } from "../packages/contracts/eval-suite";
import type { HandoffInboxView, HandoffTicket } from "../packages/contracts/handoff";
import type { IntegrationTasksView, TaskContract, TaskRun } from "../packages/contracts/integration-task";
import type { KnowledgeSearchResult } from "../packages/contracts/knowledge-base";

const FIND_REF = "int.itsm_sandbox.find_ticket@1.0.0";
const CREATE_REF = "int.itsm_sandbox.create_ticket@1.0.0";

function makeReadDraft(version: string) {
  return {
    integrationId: "itsm_sandbox",
    taskId: "lookup_ticket_status",
    version,
    description: "Look up an ITSM ticket (draft for roadmap test).",
    effect: "read" as const,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ticketId"],
      properties: { ticketId: { type: "string", minLength: 1, maxLength: 64 } },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ticketId: { type: "string" }, status: { type: "string" } },
    },
    outcomeCodes: [{ code: "FOUND", meaning: "Ticket found", success: true }],
    outcomeMapping: [{ statusIn: [200], code: "FOUND" }],
    idempotency: { supported: false },
    approvalPolicy: { mode: "none" as const, when: [], dualControl: false, expiresInMinutes: 30 },
    binding: { method: "GET" as const, target: "find_ticket" },
    resultKind: "data" as const,
  };
}

test("1.4 & 1.5: Pre-publish eval gate, task publish approval, safe draft/integration delete, and Copilot eval cases", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-roadmap-14-15-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, inspectorEnabled: true });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);

  // 1.5 Safe Delete: cannot delete published contract; CAN delete unused draft.
  await client.request("/api/integrations/contracts/delete", { ref: FIND_REF }, 409);
  const savedDraft = await client.request<{ contract: TaskContract }>("/api/integrations/contracts", makeReadDraft("1.0.1"));
  assert.equal(savedDraft.contract.status, "draft");
  const deleted = await client.request<{ deleted: boolean; ref: string }>("/api/integrations/contracts/delete", { ref: savedDraft.contract.ref });
  assert.equal(deleted.deleted, true);

  // 1.5 Safe Delete Integration: cannot delete integration with published tasks; CAN delete draft-only/empty integration.
  await client.request("/api/integrations/integrations/delete", { id: "itsm_sandbox" }, 409);
  await client.request("/api/integrations/integrations", {
    id: "temp_sandbox",
    name: "Temporary Sandbox",
    transport: "sandbox",
    baseUrl: "sandbox://temp",
    timeoutMs: 3000,
  });
  const delInt = await client.request<{ deleted: boolean; id: string }>("/api/integrations/integrations/delete", { id: "temp_sandbox" });
  assert.equal(delInt.deleted, true);

  // 1.4 Pre-publish Compliance & Eval Gate: blocks publish until eval passes.
  await client.request("/api/approvals/policy", { requireEvalBeforePublish: true });
  const draft2 = await client.request<{ contract: TaskContract }>("/api/integrations/contracts", makeReadDraft("1.0.2"));
  const blocked = await client.request<{ code: string }>("/api/integrations/contracts/publish", { ref: draft2.contract.ref }, 409);
  assert.equal(blocked.code, "eval_gate_failed");

  // Run the Guardrail Eval Suite (also verifies 1.5 copilot_authoring eval cases).
  const evalOut = await client.request<{ report: EvalRunReport }>("/api/admin/eval-run", {});
  assert.equal(evalOut.report.releaseGate, "ready_to_publish", JSON.stringify(evalOut.report.results.filter((r) => !r.passed)));
  assert.ok(
    evalOut.report.categorySummary.some((c) => c.category === "copilot_authoring" && c.total >= 2 && c.passed === c.total),
    "eval suite includes passing copilot_authoring category",
  );

  // 1.4 Task Publish Approval Gate: queues task_publish approval, publishes upon 4-eyes approval.
  await client.request("/api/approvals/policy", { gateTaskPublish: true, defaultDualControl: true });
  const pendingPub = await client.request<{ status: string; approval: ApprovalRecord }>(
    "/api/integrations/contracts/publish",
    { ref: draft2.contract.ref },
    202,
  );
  assert.equal(pendingPub.status, "pending_approval");
  assert.equal(pendingPub.approval.targetKind, "task_publish");

  // Approve as second operator (reviewer) -> publishes the task!
  const approveRes = await fetch(`${app.url}/api/approvals/${pendingPub.approval.id}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: operatorHeader(reviewer) },
    body: JSON.stringify({ decision: "approve", comment: "Compliance sign-off" }),
  });
  assert.equal(approveRes.status, 200, await approveRes.clone().text());
  const approveBody = (await approveRes.json()) as { approval: ApprovalRecord; view: ApprovalsView };
  assert.equal(approveBody.approval.status, "executed");

  const intView = await client.request<IntegrationTasksView>("/api/integrations");
  const published = intView.contracts.find((c) => c.ref === draft2.contract.ref);
  assert.equal(published?.status, "published");
});

test("2.6: Live Human Agent Warm Handoff escalation, advisor claim, reply, and resolve", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-roadmap-26-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, inspectorEnabled: true });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);

  // Customer (unauthenticated session) creates a warm handoff escalation.
  const createRes = await fetch(`${app.url}/api/handoffs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId: "conv_handoff_demo_1",
      personaId: "demo-learner",
      domain: "wealth",
      reason: "Urgent question about wire transfer and beneficiary designation",
    }),
  });
  assert.equal(createRes.status, 201, await createRes.clone().text());
  const { ticket } = (await createRes.json()) as { ticket: HandoffTicket };
  assert.equal(ticket.status, "queued");
  assert.equal(ticket.priority, "urgent");
  assert.ok(ticket.aiBrief.includes("wire transfer"));
  assert.ok(Object.keys(ticket.customerSnapshot).length >= 2);

  // Advisor lists inbox, claims, sends reply, and resolves.
  const inbox = await client.request<HandoffInboxView>("/api/admin/handoffs");
  assert.equal(inbox.queuedCount, 1);

  const claimed = await client.request<{ ticket: HandoffTicket; view: HandoffInboxView }>("/api/admin/handoffs/claim", { handoffId: ticket.handoffId });
  assert.equal(claimed.ticket.status, "claimed");
  assert.equal(claimed.view.claimedCount, 1);

  const replied = await client.request<{ ticket: HandoffTicket }>("/api/admin/handoffs/reply", {
    handoffId: ticket.handoffId,
    text: "Hi! I see your account snapshot and can help complete your beneficiary update right away.",
  });
  assert.ok(replied.ticket.notes.some((n) => n.role === "agent" && n.text.includes("beneficiary update")));

  // Customer polls handoff status & sends a live follow-up reply directly from chat.
  const statusRes = await fetch(`${app.url}/api/handoffs/${ticket.handoffId}`);
  assert.equal(statusRes.status, 200);
  const statusBody = (await statusRes.json()) as { ticket: HandoffTicket };
  assert.equal(statusBody.ticket.status, "claimed");

  const custReplyRes = await fetch(`${app.url}/api/handoffs/${ticket.handoffId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Thanks! Please add my spouse as primary beneficiary." }),
  });
  assert.equal(custReplyRes.status, 200);
  const custReplyBody = (await custReplyRes.json()) as { ticket: HandoffTicket };
  assert.ok(custReplyBody.ticket.notes.some((n) => n.role === "customer" && n.text.includes("primary beneficiary")));

  // Customer-safe hybrid policy citations lookup works without operator auth.
  const pubKbRes = await fetch(`${app.url}/api/knowledge-search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "wash sales tax harvesting" }),
  });
  assert.equal(pubKbRes.status, 200);
  const pubKb = (await pubKbRes.json()) as KnowledgeSearchResult;
  assert.equal(pubKb.retrievalMode, "hybrid_bm25_vector");
  assert.ok(pubKb.citations.length > 0);

  const resolved = await client.request<{ ticket: HandoffTicket; view: HandoffInboxView }>("/api/admin/handoffs/resolve", {
    handoffId: ticket.handoffId,
    resolutionNote: "Completed beneficiary review with customer.",
  });
  assert.equal(resolved.ticket.status, "resolved");
  assert.equal(resolved.view.resolvedCount, 1);
});

test("3.1 & 3.2: A2A Agent Card, Streamable HTTP MCP Server, AG-UI SSE protocol, and Sandboxed MCP Apps", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-roadmap-31-32-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, inspectorEnabled: true });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);

  // 3.1 A2A Agent Card at /.well-known/agent.json
  const cardRes = await fetch(`${app.url}/.well-known/agent.json`);
  assert.equal(cardRes.status, 200);
  const agentCard = (await cardRes.json()) as {
    name: string;
    endpoints: { agUi: string; mcp: string };
    skills: Array<{ id: string }>;
  };
  assert.match(agentCard.name, /CEP/);
  assert.equal(agentCard.endpoints.mcp, `${app.url}/api/mcp`);
  assert.equal(agentCard.endpoints.agUi, `${app.url}/api/ag-ui`);
  assert.ok(agentCard.skills.some((s) => s.id === CREATE_REF));

  // 3.1 Streamable HTTP MCP Server at POST /api/mcp
  const mcpCall = async (method: string, params?: Record<string, unknown>) =>
    client.request<{ jsonrpc: string; id: number; result?: Record<string, any>; error?: { code: number; message: string } }>(
      "/api/mcp",
      { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) },
    );

  const init = await mcpCall("initialize");
  assert.equal(init.result?.serverInfo?.name, "cep-governed-mcp-server");

  const listed = await mcpCall("tools/list");
  const toolNames = (listed.result?.tools as Array<{ name: string }>).map((x) => x.name);
  assert.ok(toolNames.includes(CREATE_REF));
  assert.ok(toolNames.includes("cep.knowledge.search@1.0.0"));

  const resources = await mcpCall("resources/list");
  assert.ok((resources.result?.resources as Array<{ uri: string }>).some((r) => r.uri === "cep://catalog/tasks"));
  const readCatalog = await mcpCall("resources/read", { uri: "cep://catalog/tasks" });
  assert.ok(readCatalog.result?.contents?.[0]?.text?.includes(CREATE_REF));

  // Call Knowledge Base RAG tool via MCP
  const kbCall = await mcpCall("tools/call", { name: "cep.knowledge.search@1.0.0", arguments: { query: "trade approval threshold" } });
  assert.equal(kbCall.result?.structuredContent?.retrievalMode, "hybrid_bm25_vector");

  // Call P1 ITSM write task via MCP -> held for HITL approval by sfield!
  const p1Mcp = await mcpCall("tools/call", {
    name: CREATE_REF,
    arguments: { title: "MCP P1 Outage", priority: "P1", service: "checkout" },
  });
  assert.equal(p1Mcp.result?.structuredContent?.status, "pending_approval");
  assert.match(p1Mcp.result?.structuredContent?.approvalId ?? "", /^apr_/);

  // 3.2 AG-UI SSE transport adapter at POST /api/ag-ui
  const agUiRes = await fetch(`${app.url}/api/ag-ui`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: operatorHeader() },
    body: JSON.stringify({
      threadId: "thr_agui_1",
      messages: [{ role: "user", content: "Show integrations and tasks" }],
    }),
  });
  assert.equal(agUiRes.status, 200);
  assert.match(agUiRes.headers.get("content-type") ?? "", /text\/event-stream/);
  const sseText = await agUiRes.text();
  const events = sseText
    .split("\n\n")
    .map((block) => block.replace(/^data:\s*/, "").trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; [k: string]: unknown });
  const types = events.map((e) => e.type);
  assert.equal(types[0], "RUN_STARTED");
  assert.ok(types.includes("TEXT_MESSAGE_START"));
  assert.ok(types.includes("TEXT_MESSAGE_CONTENT"));
  assert.ok(types.includes("TEXT_MESSAGE_END"));
  assert.ok(types.includes("STATE_SNAPSHOT"));
  assert.ok(types.includes("CUSTOM"));
  assert.equal(types.at(-1), "RUN_FINISHED");

  // 3.2 Sandboxed MCP App UI widget: connect demo MCP, import order_tracker_widget, publish & execute.
  await client.request("/api/integrations/integrations", {
    id: "demo_mcp_apps",
    name: "Demo MCP Apps",
    transport: "mcp",
    baseUrl: `${app.url}/api/integrations/demo-mcp`,
    timeoutMs: 5000,
  });
  const disc = await client.request<{ candidates: Array<{ toolName: string; draft: Record<string, unknown> }> }>(
    "/api/integrations/mcp/discover",
    { integrationId: "demo_mcp_apps" },
  );
  const widgetCand = disc.candidates.find((c) => c.toolName === "order_tracker_widget");
  assert.ok(widgetCand, "demo MCP server exposes order_tracker_widget");
  assert.equal(widgetCand.draft.resultKind, "artifact");
  assert.equal((widgetCand.draft.artifact as { type?: string })?.type, "mcp_app_ui");

  const savedWidget = await client.request<{ contract: TaskContract }>("/api/integrations/contracts", widgetCand.draft);
  await client.request("/api/integrations/contracts/publish", { ref: savedWidget.contract.ref });
  const widgetRun = await client.request<{ run: TaskRun }>("/api/integrations/tasks/run", {
    toolRef: savedWidget.contract.ref,
    input: { orderId: "ORD-9001" },
    requestedBy: "Author A",
  });
  assert.equal(widgetRun.run.state, "succeeded");
  assert.equal(widgetRun.run.artifact?.type, "mcp_app_ui");
  assert.equal(widgetRun.run.artifact?.uri, "ui://demo-commerce/order-tracker");
  assert.equal(widgetRun.run.artifact?.validation.ok, true);
  assert.match(widgetRun.run.artifact?.content ?? "", /ORD-9001/);
});

test("3.4: sfield MemoryService persistence + secret blocking + forget, and Hybrid BM25 + Semantic Vector RAG", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-roadmap-34-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, inspectorEnabled: true });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);

  // sfield MemoryService: save preference, list it, block secrets, forget with receipt.
  const saved = await client.request<{ item: { id: string; content: string; kind: string } }>(
    "/api/memory",
    { kind: "preference", content: "Prefer concise tax-aware portfolio summaries", key: "briefing_style" },
    201,
  );
  assert.match(saved.item.id, /^mem_/);

  const listed = await client.request<{ items: Array<{ id: string; content: string }> }>("/api/memory");
  assert.ok(listed.items.some((i) => i.id === saved.item.id));

  // Secret-like value must be rejected by sfield's looksLikeSecret guard!
  await client.request(
    "/api/memory",
    { kind: "fact", content: "My OpenAI key is sk-proj-1234567890abcdefghijklmnop" },
    400,
  );

  // Forget memory item -> returns deletion receipt and removes from active list.
  const forgotten = await client.request<{ receipt: { count: number }; items: Array<{ id: string }> }>(
    "/api/memory/forget",
    { id: saved.item.id },
  );
  assert.equal(forgotten.receipt.count, 1);
  assert.equal(forgotten.items.some((i) => i.id === saved.item.id), false);

  // Hybrid BM25 + Semantic Vector + RRF RAG search.
  const searchRes = await client.request<KnowledgeSearchResult>("/api/admin/knowledge-search", {
    query: "wash sales tax harvesting replacement securities",
  });
  assert.equal(searchRes.retrievalMode, "hybrid_bm25_vector");
  assert.ok(searchRes.citations.length > 0);
  const top = searchRes.citations[0]!;
  assert.equal(typeof top.bm25Score, "number");
  assert.equal(typeof top.vectorScore, "number");
  assert.ok(top.vectorScore! > 0, "semantic vector similarity score should be positive");
});
