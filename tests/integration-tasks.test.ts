import { reviewer, operatorHeader } from "./operator-fixture";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "./operator-fixture";
import { breakingChanges, IntegrationTaskStore, needsApproval, schemaIssues } from "../apps/server/integration-tasks";
import type { IntegrationTasksView, TaskRun } from "../packages/contracts/integration-task";
import type { ApprovalRecord } from "../packages/contracts/approval";
import { testClient, testProject } from "./client";
import { startFixtureGateway } from "./gateway-fixture";

const CREATE = "int.itsm_sandbox.create_ticket@1.0.0";
const SCHEMA_GEN = "int.itsm_sandbox.generate_mapping_schema@1.0.0";

test("contract guards: closed schemas, local refs, approval rules, and semver on breaking changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cep-int-unit-"));
  try {
    assert.ok(schemaIssues({ type: "object", properties: { a: { type: "string" } } }, "s").length > 0, "open objects are rejected");
    assert.ok(schemaIssues({ type: "object", additionalProperties: false, properties: { a: { $ref: "https://evil.example/x.json" } } }, "s")
      .some((i) => i.includes("non-local $ref")));
    assert.deepEqual(schemaIssues({ type: "object", additionalProperties: false, properties: { a: { type: "string" } } }, "s"), []);

    const store = new IntegrationTaskStore(dir);
    const create = store.contract(CREATE)!;
    assert.equal(create.status, "published");
    assert.equal(needsApproval(create, { priority: "P1" }), true);
    assert.equal(needsApproval(create, { priority: "P3" }), false);
    assert.equal(needsApproval({ ...create, effect: "destructive", approvalPolicy: { ...create.approvalPolicy, mode: "none" } }, {}), true,
      "destructive tasks always need approval");

    const { ref: _r, status: _s, contractDigest: _c, bindingDigest: _b, updatedAt: _u, publishedAt: _p, ...input } = create;
    assert.throws(() => store.upsertDraft({ ...input, version: "1.0.0" }), /published/, "published versions are immutable");
    assert.throws(() => store.upsertDraft({ ...input, version: "1.0.1", effect: "read", approvalPolicy: { mode: "always", when: [], dualControl: false, expiresInMinutes: 30 } }),
      /read tasks cannot require approval/);
    assert.throws(() => store.upsertDraft({ ...input, version: "1.0.1", idempotency: { supported: false }, reconcileTaskId: undefined }),
      /idempotency key, a reconcile task, or an explicit manual-reconcile/);

    const breakingInput = {
      ...input,
      inputSchema: {
        ...input.inputSchema,
        required: [...((input.inputSchema as { required: string[] }).required), "assignmentGroup"],
        properties: { ...((input.inputSchema as { properties: object }).properties), assignmentGroup: { type: "string" } },
      },
    };
    assert.ok(breakingChanges(create, store.upsertDraft({ ...breakingInput, version: "1.1.0" })).some((c) => c.includes("assignmentGroup")));
    assert.throws(() => store.publish("int.itsm_sandbox.create_ticket@1.1.0"), /major version bump/);
    assert.equal(store.publish(store.upsertDraft({ ...breakingInput, version: "2.0.0" }).ref).contract.status, "published");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("integration tasks run through sfield with native digest-bound approvals, reconciliation, and artifacts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-int-host-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, inspectorEnabled: true });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);
  const run = (input: Record<string, unknown>, expected = 200, toolRef = CREATE, provenance?: Record<string, string>) =>
    client.request<{ run: TaskRun; approval?: ApprovalRecord }>("/api/integrations/tasks/run", { toolRef, input, requestedBy: "Author A", ...(provenance ? { provenance } : {}) }, expected);

  const view = await client.request<IntegrationTasksView>("/api/integrations");
  assert.deepEqual(view.contracts.filter((c) => c.sfieldRegistered).map((c) => c.ref).sort(), [
    "int.commerce_sandbox.lookup_order@1.0.0", "int.itsm_sandbox.create_ticket@1.0.0", "int.itsm_sandbox.find_ticket@1.0.0", "int.itsm_sandbox.generate_mapping_schema@1.0.0",
  ]);

  // 1. Ungated write executes through an sfield run; the engine fills the idempotency key.
  const p3 = await run({ title: "Disk alert on db-2", priority: "P3", service: "database" });
  assert.equal(p3.run.state, "succeeded");
  assert.equal(p3.run.outcome?.code, "CREATED");
  assert.match(p3.run.sfieldRunId ?? "", /^run_/);
  assert.match(p3.run.idempotencyKey ?? "", /^idem_/);

  // 2. Same idempotency key → the system reports DUPLICATE instead of creating a second ticket.
  const again = await run({ title: "Disk alert on db-2", priority: "P3", service: "database", idempotencyKey: p3.run.idempotencyKey });
  assert.equal(again.run.outcome?.code, "DUPLICATE");
  assert.equal((again.run.output as { ticketId: string }).ticketId, (p3.run.output as { ticketId: string }).ticketId);

  // 3. P1 is gated: sfield holds the call; our approval shows provenance; approving runs it exactly once.
  const p1 = await run({ title: "Checkout outage", priority: "P1", service: "checkout" }, 202, CREATE, { title: "model_proposed", priority: "user_confirmed" });
  assert.equal(p1.run.state, "pending_approval");
  assert.ok(p1.run.sfieldApprovalId?.startsWith("apr_"));
  assert.ok(p1.approval?.details.some((d) => d.label === "Model-proposed fields" && d.value.includes("title")));
  const decided = await client.request<{ approval: ApprovalRecord; taskRun: TaskRun }>(`/api/approvals/${p1.approval!.id}/decide`, { decision: "approve", actor: "On-call Lead" }, 200, { Authorization: operatorHeader(reviewer) });
  assert.equal(decided.approval.status, "executed");
  assert.equal(decided.taskRun.state, "succeeded");
  assert.equal(decided.taskRun.outcome?.code, "CREATED");
  await client.request(`/api/approvals/${p1.approval!.id}/decide`, { decision: "approve", actor: "On-call Lead" }, 409, { Authorization: operatorHeader(reviewer) });

  // 4. Denial: sfield's approval is denied too, nothing is sent.
  const p1b = await run({ title: "Payments degraded", priority: "P1", service: "payments" }, 202);
  await client.request(`/api/approvals/${p1b.approval!.id}/decide`, { decision: "deny", actor: "On-call Lead", comment: "Duplicate of INC" }, 200, { Authorization: operatorHeader(reviewer) });
  const afterDeny = await client.request<IntegrationTasksView>("/api/integrations");
  assert.equal(afterDeny.runs.find((r) => r.runId === p1b.run.runId)?.state, "denied");

  // 5. Lost response on a write → outcome_unknown (never retried), then reconciled via the read task.
  const lost = await run({ title: "Queue backlog [timeout]", priority: "P2", service: "queue" });
  assert.equal(lost.run.state, "outcome_unknown");
  assert.equal(lost.run.error?.kind, "timeout");
  const reconciled = await client.request<{ run: TaskRun }>("/api/integrations/runs/reconcile", { runId: lost.run.runId });
  assert.equal(reconciled.run.state, "succeeded");
  assert.equal(reconciled.run.outcome?.code, "RECONCILED_APPLIED");

  // 6. Write succeeded but the response broke the contract → unverified, not failed (so it is not retried).
  const unverified = await run({ title: "Cert expiry [bad-output]", priority: "P3", service: "edge" });
  assert.equal(unverified.run.state, "succeeded_unverified_output");
  assert.equal(unverified.run.error?.kind, "validation_output");

  // 7. Business rejection → failed with the declared outcome code, separate from the error taxonomy.
  const rejected = await run({ title: "Bad ticket [reject]", priority: "P3", service: "nope" });
  assert.equal(rejected.run.state, "failed");
  assert.equal(rejected.run.outcome?.code, "REJECTED");
  assert.equal(rejected.run.error?.kind, "upstream_4xx");

  // 8. Input outside the contract is rejected by sfield before anything is sent.
  const invalid = await run({ title: "Bad", priority: "P9", service: "x" });
  assert.equal(invalid.run.state, "failed");
  assert.equal(invalid.run.error?.kind, "validation_input");

  // 9. Artifact task: generated schema is validated and returned for review, never applied.
  const artifact = await run({ entityName: "Order", sampleJson: JSON.stringify({ id: 1, items: [{ sku: "A", qty: 2 }] }) }, 200, SCHEMA_GEN);
  assert.equal(artifact.run.state, "succeeded");
  assert.equal(artifact.run.artifact?.type, "json_schema");
  assert.equal(artifact.run.artifact?.validation.ok, true);

  // 10. A version published after startup is registered as its own dedicated sfield tool via sfield.reload
  //     (candidate lock passes governance first) and runs immediately; approvals still apply.
  const current = view.contracts.find((c) => c.ref === CREATE)!;
  const { ref: _r, status: _s, contractDigest: _c, bindingDigest: _b, updatedAt: _u, publishedAt: _p, sfieldRegistered: _reg, sfieldRoute: _route, ...input } = current;
  await client.request("/api/integrations/contracts", { ...input, version: "1.1.0", description: "Create a ticket (minor wording change)." });
  const V11 = "int.itsm_sandbox.create_ticket@1.1.0";
  const published = await client.request<{ sfieldRegistered: boolean; sfieldRoute: string }>("/api/integrations/contracts/publish", { ref: V11 });
  assert.equal(published.sfieldRegistered, true);
  assert.equal(published.sfieldRoute, "dedicated");
  const viaDispatcher = await run({ title: "Cache misses on edge", priority: "P3", service: "edge" }, 200, V11);
  assert.equal(viaDispatcher.run.state, "succeeded", JSON.stringify(viaDispatcher.run));
  assert.equal(viaDispatcher.run.version, "1.1.0");
  assert.equal(viaDispatcher.run.outcome?.code, "CREATED");
  const badDispatch = await run({ title: "Bad", priority: "P9", service: "x" }, 200, V11);
  assert.equal(badDispatch.run.state, "failed");
  assert.equal(badDispatch.run.error?.kind, "validation_input");
  const p1v11 = await run({ title: "Edge outage", priority: "P1", service: "edge" }, 202, V11);
  assert.equal(p1v11.approval?.sfieldToolRef, V11);
  const decidedV11 = await client.request<{ approval: ApprovalRecord; taskRun: TaskRun }>(`/api/approvals/${p1v11.approval!.id}/decide`, { decision: "approve", actor: "On-call Lead" }, 200, { Authorization: operatorHeader(reviewer) });
  assert.equal(decidedV11.taskRun.state, "succeeded");
  assert.equal(decidedV11.approval.status, "executed");
  const viewAfter = await client.request<IntegrationTasksView>("/api/integrations");
  assert.equal(viewAfter.contracts.find((c) => c.ref === V11)?.sfieldRoute, "dedicated");
  assert.equal(viewAfter.contracts.find((c) => c.ref === CREATE)?.sfieldRoute, "dedicated");

  // 11. Chat: a write is drafted into a form (never run from text); every guessed field is marked model-proposed.
  type ChatOut = { reply: string; cards: { kind: string; prefill?: Record<string, unknown>; provenance?: Record<string, string>; run?: TaskRun }[] };
  const drafted = await client.request<ChatOut>("/api/integrations/copilot", { message: "Create a P1 ticket for checkout outage on payments" });
  const form = drafted.cards.find((c) => c.kind === "task_form");
  assert.ok(form, JSON.stringify(drafted));
  assert.equal(form.prefill?.priority, "P1");
  assert.equal(form.prefill?.service, "payments");
  assert.equal(form.provenance?.priority, "model_proposed");
  assert.equal(form.prefill?.idempotencyKey, undefined, "the model never supplies idempotency keys");

  // 12. Chat: a complete read task runs immediately and returns its artifact.
  const generated = await client.request<ChatOut>("/api/integrations/copilot", { message: "Generate a schema for Invoice from {\"id\": 7, \"total\": 12.5}" });
  const runCard = generated.cards.find((c) => c.kind === "task_run");
  assert.equal(runCard?.run?.state, "succeeded");
  assert.equal(runCard?.run?.artifact?.validation.ok, true);

  // 13. Chat: catalog, runs and approvals are all reachable by asking.
  assert.ok((await client.request<ChatOut>("/api/integrations/copilot", { message: "Show integrations and tasks" })).cards.some((c) => c.kind === "catalog"));
  assert.ok((await client.request<ChatOut>("/api/integrations/copilot", { message: "Show recent task runs" })).cards.some((c) => c.kind === "runs"));
  assert.ok((await client.request<ChatOut>("/api/integrations/copilot", { message: "Show pending approvals" })).cards.some((c) => c.kind === "approvals"));
});

test("pending integration approvals survive a server restart and still execute exactly once", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-int-restart-"));
  const gateway = await startFixtureGateway();
  const start = () => startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, inspectorEnabled: true });
  let app = await start();
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  let client = await testClient(app.url);

  const pending = await client.request<{ run: TaskRun; approval: ApprovalRecord }>("/api/integrations/tasks/run",
    { toolRef: CREATE, input: { title: "Login outage", priority: "P1", service: "identity" }, requestedBy: "Author A" }, 202);
  assert.equal(pending.run.state, "pending_approval");
  assert.equal(pending.approval.payload.taskRef, CREATE);

  // Restart: the open sfield scope (and its native pending approval) is gone; our approval record is not.
  await app.close();
  app = await start();
  client = await testClient(app.url);
  const approvals = await client.request<{ approvals: ApprovalRecord[] } | ApprovalRecord[]>("/api/approvals");
  const list = Array.isArray(approvals) ? approvals : approvals.approvals;
  assert.ok(list.some((a) => a.id === pending.approval.id && a.status === "pending"), "approval is still pending after restart");

  const decided = await client.request<{ approval: ApprovalRecord; taskRun: TaskRun; execution: { summary: string } }>(
    `/api/approvals/${pending.approval.id}/decide`, { decision: "approve", actor: "On-call Lead" }, 200, { Authorization: operatorHeader(reviewer) });
  assert.equal(decided.taskRun.state, "succeeded", JSON.stringify(decided.taskRun));
  assert.equal(decided.taskRun.outcome?.code, "CREATED");
  assert.equal(decided.taskRun.idempotencyKey, pending.run.idempotencyKey, "the approved idempotency key is reused");
  assert.equal(decided.approval.status, "executed");
  assert.match(decided.execution.summary, /resumed after restart/);
  // sfield checked the original approval in the original run: same sfield run and approval ids, no re-grant.
  assert.equal(decided.taskRun.sfieldRunId, pending.run.sfieldRunId);
  const sfApprovals = await app.internals.runtime!.sfieldApprovals(pending.run.sfieldRunId!);
  assert.deepEqual(sfApprovals.map((a) => a.id), [pending.run.sfieldApprovalId], "exactly one sfield approval, the original");
  await client.request(`/api/approvals/${pending.approval.id}/decide`, { decision: "approve", actor: "On-call Lead" }, 409, { Authorization: operatorHeader(reviewer) });

  // Denial after a restart also works and sends nothing.
  const p1b = await client.request<{ run: TaskRun; approval: ApprovalRecord }>("/api/integrations/tasks/run",
    { toolRef: CREATE, input: { title: "Search slow", priority: "P1", service: "search" }, requestedBy: "Author A" }, 202);
  await app.close();
  app = await start();
  client = await testClient(app.url);
  await client.request(`/api/approvals/${p1b.approval.id}/decide`, { decision: "deny", actor: "On-call Lead" }, 200, { Authorization: operatorHeader(reviewer) });
  const view = await client.request<IntegrationTasksView>("/api/integrations");
  assert.equal(view.runs.find((r) => r.runId === p1b.run.runId)?.state, "denied");
});

test("the approval check inside the sfield tool rejects missing, forged, replayed, and mismatched approvals", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-int-forged-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, inspectorEnabled: true });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);
  const runtime = app.internals.runtime!;
  const approvals = app.internals.approvalStore;
  const view = await client.request<IntegrationTasksView>("/api/integrations");
  const create = view.contracts.find((c) => c.ref === CREATE)!;
  const p1 = { title: "Checkout outage", priority: "P1", service: "checkout", idempotencyKey: "idem_forged_test_1" };

  // Calls go straight to the tool in an ungated scope (bounded_auto lets writes through), so only the handler can stop them.
  const call = async (ref: string, inputs: Record<string, unknown>) => {
    const out = await runtime.executeIntegrationTask("attacker", ref, inputs as never, false);
    assert.equal(out.kind, "result");
    return (out as { result: { status: string; error?: { code: string; message: string } } }).result;
  };
  const denied = (r: { status: string; error?: { code: string } }, why: string) => {
    assert.equal(r.status, "failed", why);
    assert.equal(r.error?.code, "TASK_POLICY_DENIED", why);
  };
  const dispatch = (input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    taskRef: CREATE, contractDigest: create.contractDigest, bindingDigest: create.bindingDigest, inputJson: JSON.stringify(input), ...extra,
  });

  denied(await call(CREATE, { input: p1 }), "no approval id");
  denied(await call(CREATE, { input: p1, approvalId: "apr_forged000000000000" }), "forged approval id");
  denied(await call("int.dispatch.write@1.0.0", dispatch(p1, { approvalId: "apr_forged000000000000" })), "forged id via dispatcher");

  // A real request that is still pending (not approved) does not authorize anything.
  const pending = await client.request<{ run: TaskRun; approval: ApprovalRecord }>("/api/integrations/tasks/run",
    { toolRef: CREATE, input: p1, requestedBy: "Author A" }, 202);
  const id = pending.approval.id;
  denied(await call(CREATE, { input: p1, approvalId: id }), "pending approval");

  // Approved and claimed, but for different input / task / digests → still denied.
  approvals.decide(id, { decision: "approve", actor: "On-call Lead" } as never);
  assert.ok(approvals.claimForExecution(id).ok);
  denied(await call(CREATE, { input: { ...p1, service: "payments" }, approvalId: id }), "input changed after approval");
  denied(await call(CREATE, { input: { ...p1, priority: "P1", title: "Something else" }, approvalId: id }), "title changed after approval");
  denied(await call("int.dispatch.write@1.0.0", dispatch(p1, { approvalId: id, contractDigest: "sha256:stale0000000000" })), "stale contract digest");
  denied(await call("int.dispatch.read@1.0.0", { ...dispatch(p1, { approvalId: id }) }), "write task through the read dispatcher");

  // The exact approved call is the only one that runs.
  const ok = await call(CREATE, { input: p1, approvalId: id });
  assert.equal(ok.status, "succeeded", JSON.stringify(ok));
  approvals.markExecuted(id, { summary: "test", sfieldRunId: "run_test" });
  denied(await call(CREATE, { input: p1, approvalId: id }), "replay of an executed approval");

  // Ungated input needs no approval, through either route.
  assert.equal((await call(CREATE, { input: { ...p1, priority: "P3", idempotencyKey: "idem_forged_test_2" } })).status, "succeeded");
  assert.equal((await call("int.dispatch.write@1.0.0", dispatch({ ...p1, priority: "P3", idempotencyKey: "idem_forged_test_3" }))).status, "succeeded");
});

test("chat authoring: connect an MCP server, import tools, publish, run, and draft tasks — nothing saved without a click", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-int-author-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, inspectorEnabled: true });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);
  type Card = { kind: string; [k: string]: unknown };
  const chat = async (message: string) => (await client.request<{ reply: string; cards: Card[] }>("/api/integrations/copilot", { message }));
  const card = <T,>(out: { cards: Card[] }, kind: string) => out.cards.find((c) => c.kind === kind) as unknown as T;
  const mcpUrl = `${app.url}/api/integrations/demo-mcp`;

  // 1. Connect: chat drafts the integration form; nothing exists until it is saved.
  const connect = card<{ prefill: { transport: string; baseUrl: string; name: string; id: string } }>(await chat(`Connect an MCP server at ${mcpUrl} as Demo Commerce`), "integration_form");
  assert.equal(connect.prefill.transport, "mcp");
  assert.equal(connect.prefill.baseUrl, mcpUrl);
  assert.equal(connect.prefill.name, "Demo Commerce");
  assert.equal((await client.request<IntegrationTasksView>("/api/integrations")).integrations.some((i) => i.id === "demo_commerce"), false);
  await client.request("/api/integrations/integrations", { id: "demo_commerce", name: "Demo Commerce", transport: "mcp", baseUrl: mcpUrl, timeoutMs: 5000 });
  await client.request("/api/integrations/integrations", { id: "remote_plain", name: "x", transport: "mcp", baseUrl: "http://example.com/mcp" }, 409);

  // 2. Import: tools/list becomes reviewable drafts with closed schemas, effect from annotations, safe defaults.
  type Candidate = { toolName: string; draft: Record<string, any>; check: { ok: boolean; issues: string[] }; notes: string[] };
  const imported = card<{ candidates: Candidate[] }>(await chat("Import tools from demo_commerce"), "mcp_import");
  const byName = Object.fromEntries(imported.candidates.map((c) => [c.toolName, c]));
  assert.deepEqual(Object.keys(byName).sort(), ["cancel_subscription", "lookup_order", "order_tracker_widget", "refund_order"]);
  for (const c of imported.candidates) assert.equal(c.check.ok, true, `${c.toolName}: ${c.check.issues.join("; ")}`);
  assert.equal(byName.lookup_order!.draft.effect, "read");
  assert.equal(byName.lookup_order!.draft.outputSchema.additionalProperties, false, "server output schema is closed");
  assert.equal(byName.refund_order!.draft.effect, "write");
  assert.equal(byName.refund_order!.draft.idempotency.keyField, "requestId");
  assert.equal(byName.refund_order!.draft.approvalPolicy.mode, "always");
  assert.equal(byName.refund_order!.draft.inputSchema.additionalProperties, false);
  assert.equal(byName.cancel_subscription!.draft.effect, "destructive", "MCP default without annotations");
  assert.equal(byName.cancel_subscription!.draft.manualReconcile, true);
  assert.equal((await client.request<IntegrationTasksView>("/api/integrations")).contracts.some((c) => c.integrationId === "demo_commerce"), false, "import saved nothing");
  for (const c of imported.candidates) await client.request("/api/integrations/contracts", c.draft);
  assert.equal(card<{ drafts: unknown[] }>(await chat("Show drafts"), "drafts").drafts.length, 4);

  // 3. Publish from chat: a review card first; publishing registers a dedicated sfield tool (no restart).
  const LOOKUP = "int.demo_commerce.lookup_order@1.0.0";
  const review = card<{ contract: { ref: string }; check: { ok: boolean; publishBlockers: string[] } }>(await chat(`Publish ${LOOKUP}`), "publish_review");
  assert.equal(review.contract.ref, LOOKUP);
  assert.equal(review.check.ok, true);
  const published = await client.request<{ sfieldRoute: string }>("/api/integrations/contracts/publish", { ref: LOOKUP });
  assert.equal(published.sfieldRoute, "dedicated");
  const found = await client.request<{ run: TaskRun }>("/api/integrations/tasks/run", { toolRef: LOOKUP, input: { orderId: "ORD-1001" } });
  assert.equal(found.run.state, "succeeded", JSON.stringify(found.run));
  assert.deepEqual(found.run.output, { found: true, orderId: "ORD-1001", status: "shipped", total: 129.5 });

  // 4. An imported write: approval always, idempotency key filled into the MCP tool's requestId, tool errors mapped.
  const REFUND = "int.demo_commerce.refund_order@1.0.0";
  await client.request("/api/integrations/contracts/publish", { ref: REFUND });
  const refund = await client.request<{ run: TaskRun; approval: ApprovalRecord }>("/api/integrations/tasks/run", { toolRef: REFUND, input: { orderId: "ORD-1001", amount: 10 } }, 202);
  assert.match(String(refund.run.input.requestId), /^idem_/);
  const approved = await client.request<{ taskRun: TaskRun }>(`/api/approvals/${refund.approval.id}/decide`, { decision: "approve", actor: "Finance Lead" }, 200, { Authorization: operatorHeader(reviewer) });
  assert.equal(approved.taskRun.state, "succeeded", JSON.stringify(approved.taskRun));
  assert.match(String((approved.taskRun.output as { refundId: string }).refundId), /^RF-/);
  const tooMuch = await client.request<{ run: TaskRun; approval: ApprovalRecord }>("/api/integrations/tasks/run", { toolRef: REFUND, input: { orderId: "ORD-1002", amount: 9999 } }, 202);
  const rejected = await client.request<{ taskRun: TaskRun }>(`/api/approvals/${tooMuch.approval.id}/decide`, { decision: "approve", actor: "Finance Lead" }, 200, { Authorization: operatorHeader(reviewer) });
  assert.equal(rejected.taskRun.state, "failed");
  assert.equal(rejected.taskRun.outcome?.code, "TOOL_ERROR");

  // 5. Describe a task in plain English → an editable draft, validated, not saved.
  const described = card<{ draft: Record<string, any>; check: { ok: boolean; issues: string[] }; origin: string }>(
    await chat("Create a task to look up a customer by customerId and email on demo_commerce"), "task_draft");
  assert.equal(described.origin, "template");
  assert.equal(described.draft.integrationId, "demo_commerce");
  assert.equal(described.draft.effect, "read");
  assert.deepEqual(Object.keys(described.draft.inputSchema.properties).sort(), ["customerId", "email"]);
  assert.equal(described.check.ok, true, described.check.issues.join("; "));
  assert.equal((await client.request<IntegrationTasksView>("/api/integrations")).contracts.some((c) => c.taskId === described.draft.taskId), false);

  // 6. New version from chat; a breaking change is flagged before publishing.
  const next = card<{ draft: Record<string, any>; origin: string }>(await chat("Create a new version of lookup_order"), "task_draft");
  assert.equal(next.origin, "new_version");
  assert.equal(next.draft.version, "1.1.0");
  const breakingDraft = { ...next.draft, inputSchema: { ...next.draft.inputSchema, required: [...next.draft.inputSchema.required, "region"], properties: { ...next.draft.inputSchema.properties, region: { type: "string" } } } };
  const check = await client.request<{ ok: boolean; breaking: string[]; publishBlockers: string[] }>("/api/integrations/contracts/validate", { draft: breakingDraft });
  assert.equal(check.ok, true);
  assert.ok(check.breaking.some((b) => b.includes("region")));
  assert.ok(check.publishBlockers.some((b) => b.includes("major")));
  const open = await client.request<{ ok: boolean; issues: string[] }>("/api/integrations/contracts/validate", { draft: { ...next.draft, inputSchema: { type: "object", properties: { a: { type: "string" } } } } });
  assert.equal(open.ok, false, "open schemas are rejected");

  // 7. Where calls go is fixed once tasks are published.
  await client.request("/api/integrations/integrations", { id: "demo_commerce", name: "Demo Commerce", transport: "mcp", baseUrl: "https://elsewhere.example/mcp" }, 409);
});

test("operator sign-in can be switched off for local demos; it stays on by default", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-op-auth-"));
  const gateway = await startFixtureGateway();
  const on = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: join(dir, "on"), gateway: gateway.settings, inspectorEnabled: true });
  const off = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: join(dir, "off"), gateway: gateway.settings, inspectorEnabled: true, operatorAuth: "off" });
  t.after(async () => { await on.close(); await off.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });

  assert.equal((await fetch(`${on.url}/api/integrations`)).status, 401, "default: sign-in required");
  assert.equal((await fetch(`${on.url}/integrations`)).status, 401);
  assert.equal((await fetch(`${off.url}/api/integrations`)).status, 200, "off: no prompt");
  assert.equal((await fetch(`${off.url}/integrations`)).status, 200);

  // Actions are attributed to local-operator when nobody signed in.
  const customer = await testClient(off.url, undefined, "customer");
  const p1 = await customer.request<{ run: TaskRun; approval: ApprovalRecord }>("/api/integrations/tasks/run",
    { toolRef: CREATE, input: { title: "Checkout outage", priority: "P1", service: "checkout" } }, 202);
  assert.equal(p1.approval.requester, "local-operator");
});
