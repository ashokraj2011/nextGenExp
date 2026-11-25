import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "../apps/server/http";
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
      /idempotency key or a reconcile task/);

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
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, mode: "test", inspectorEnabled: true });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);
  const run = (input: Record<string, unknown>, expected = 200, toolRef = CREATE, provenance?: Record<string, string>) =>
    client.request<{ run: TaskRun; approval?: ApprovalRecord }>("/api/integrations/tasks/run", { toolRef, input, requestedBy: "Author A", ...(provenance ? { provenance } : {}) }, expected);

  const view = await client.request<IntegrationTasksView>("/api/integrations");
  assert.deepEqual(view.contracts.filter((c) => c.sfieldRegistered).map((c) => c.ref).sort(), [
    "int.itsm_sandbox.create_ticket@1.0.0", "int.itsm_sandbox.find_ticket@1.0.0", "int.itsm_sandbox.generate_mapping_schema@1.0.0",
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
  const decided = await client.request<{ approval: ApprovalRecord; taskRun: TaskRun }>(`/api/approvals/${p1.approval!.id}/decide`, { decision: "approve", actor: "On-call Lead" });
  assert.equal(decided.approval.status, "executed");
  assert.equal(decided.taskRun.state, "succeeded");
  assert.equal(decided.taskRun.outcome?.code, "CREATED");
  await client.request(`/api/approvals/${p1.approval!.id}/decide`, { decision: "approve", actor: "On-call Lead" }, 409);

  // 4. Denial: sfield's approval is denied too, nothing is sent.
  const p1b = await run({ title: "Payments degraded", priority: "P1", service: "payments" }, 202);
  await client.request(`/api/approvals/${p1b.approval!.id}/decide`, { decision: "deny", actor: "On-call Lead", comment: "Duplicate of INC" });
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

  // 10. A version published after startup is not silently executable: it needs sfield registration first.
  const current = view.contracts.find((c) => c.ref === CREATE)!;
  const { ref: _r, status: _s, contractDigest: _c, bindingDigest: _b, updatedAt: _u, publishedAt: _p, sfieldRegistered: _reg, ...input } = current;
  await client.request("/api/integrations/contracts", { ...input, version: "1.1.0", description: "Create a ticket (minor wording change)." });
  const published = await client.request<{ sfieldRegistered: boolean }>("/api/integrations/contracts/publish", { ref: "int.itsm_sandbox.create_ticket@1.1.0" });
  assert.equal(published.sfieldRegistered, false);
  await client.request("/api/integrations/tasks/run", { toolRef: "int.itsm_sandbox.create_ticket@1.1.0", input: { title: "x x x", priority: "P3", service: "db" } }, 409);
});
