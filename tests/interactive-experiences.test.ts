import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ConversationView, RecordUpdate, TurnAccepted, TurnView } from "../packages/contracts/api";
import type { TaskContractInput } from "../packages/contracts/integration-task";
import type { TurnPayloads } from "../packages/contracts/inspector";
import type { UiDesign, UiLayoutRecord } from "../packages/contracts/ui-layout";
import { orderExperienceTemplate } from "../apps/web/interactive-experience-editor";
import { startFixtureGateway } from "./gateway-fixture";
import { actionFor, testClient, testProject } from "./client";
import { startApp } from "./operator-fixture";

function canvas(turn: TurnView) {
  assert.equal(turn.status, "completed", JSON.stringify(turn));
  const block = turn.experience?.blocks.find((node) => node.component === "PznDynamicCanvas");
  assert.ok(block, turn.experience?.intro);
  return block.props;
}

test("a customer click uses the originally published action and restoring the thread reports the updated delivery", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "interactive-order-"));
  const gateway = await startFixtureGateway();
  const open = () => startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, inspectorEnabled: true });
  let app = await open();
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const admin = await testClient(app.url);
  const customer = await testClient(app.url, admin.cookie, "customer");
  const design: UiDesign = { name: "Order tracking", description: "Track a delivery.", layout: "stack", targets: [], slots: [], experience: orderExperienceTemplate() };
  const saved = await admin.request<UiLayoutRecord>("/api/admin/ui-layouts", { operation: "publish", domainId: "wealth", design });
  const chat = await admin.conversation();
  const other = await admin.conversation("normal", "demo-returning");
  const customerWait = async (accepted: TurnAccepted) => {
    await (await customer.response(accepted.eventsUrl)).text();
    return customer.turn(accepted.turnId);
  };
  const order = await customerWait(await customer.submit(chat.id, "Track shipment ORD-1001"));
  assert.equal(canvas(order).title, "Order summary");
  assert.equal(order.interactiveExperience?.publication.revision, saved.revision);
  assert.equal(order.interactiveExperience?.recordId, "ORD-1001");
  assert.doesNotMatch(JSON.stringify(order), /DEMO-MID/);

  // Keep the original action usable after editing the published definition.
  const revision = structuredClone(design);
  revision.experience!.actions[1].title = "Updated tracking";
  const next = await admin.request<UiLayoutRecord>("/api/admin/ui-layouts", { operation: "publish", id: saved.id, revision: saved.revision, design: revision });
  const envelope = actionFor(order.experience!);
  const request = { envelope, clientRequestId: randomUUID() };
  const path = "/api/experiences/" + order.experience!.experienceId + "/actions";
  await customer.request(path, { ...request, envelope: { ...envelope, action: {
    ...envelope.action, context: { ...envelope.action.context, values: { orderId: "ORD-1002" } },
  } } }, 400);
  const accepted = await customer.request<TurnAccepted>(path, request, 202);
  const clicked = await customerWait(accepted);
  assert.equal((await customer.request<TurnAccepted>(path, request, 202)).turnId, clicked.id);
  assert.equal(clicked.message, "Show my delivery details");
  assert.equal(canvas(clicked).title, "Delivery tracking");
  assert.equal(clicked.interactiveExperience?.sourceTurnId, order.id);
  assert.equal(clicked.interactiveExperience?.publication.revision, saved.revision);
  assert.equal(clicked.interactiveExperience?.state, "watching");

  const forked = await customer.request<ConversationView>("/api/conversations/" + chat.id + "/fork", { turnId: order.id }, 201);
  const copied = forked.turns[0].experience!;
  assert.notEqual(copied.experienceId, order.experience!.experienceId);
  const branch = await customer.request<TurnAccepted>("/api/experiences/" + copied.experienceId + "/actions",
    { envelope: actionFor(copied), clientRequestId: randomUUID() }, 202);
  assert.equal((await customerWait(branch)).conversationId, forked.id);

  const typed = await customerWait(await customer.submit(chat.id, "Track delivery ORD-1001"));
  assert.equal(canvas(typed).title, "Updated tracking");
  assert.equal(typed.interactiveExperience?.publication.revision, next.revision);
  const log = (id: string) => admin.request<TurnPayloads>("/api/admin/logs/" + id);
  const [clickLog, typeLog] = await Promise.all([log(clicked.id), log(typed.id)]);
  assert.equal(clickLog.interactiveExperience?.call?.tool, "int.commerce_sandbox.lookup_order@1.0.0");
  assert.deepEqual(clickLog.interactiveExperience?.call?.registryInput.data, typeLog.interactiveExperience?.call?.registryInput.data);
  assert.equal(clickLog.router, null);
  assert.equal(clickLog.treatment, null);
  assert.equal(clickLog.interactiveExperience?.call?.status, "succeeded");
  const denied = await customerWait(await customer.submit(other.id, "Track delivery ORD-1001"));
  assert.equal(denied.interactiveExperience?.state, "failed");
  assert.doesNotMatch(JSON.stringify(denied), /shipped/);

  await app.close();
  const file = join(dir, "commerce-orders.json");
  const data = JSON.parse(await readFile(file, "utf8"));
  data[0].status = "delivered";
  await writeFile(file, JSON.stringify(data));
  app = await open();
  const reopened = await testClient(app.url, admin.cookie, "customer");
  const thread = "/api/conversations/" + chat.id;
  let updates: RecordUpdate[] = [];
  for (let i = 0; i < 8; i++) {
    updates = await reopened.request<RecordUpdate[]>(thread + "/updates");
    if (updates.length === 1 && updates.every(({ state }) => state === "reached")) break;
    await wait(800);
  }
  assert.equal(updates.length, 1);
  assert.ok(updates.every(({ recordId, state, value }) => recordId === "ORD-1001" && state === "reached" && value === "delivered"));
  const stored = await reopened.request<ConversationView>(thread);
  const restored = stored.turns.find(({ id }) => id === typed.id)!;
  assert.deepEqual(restored.experience, typed.experience);
  assert.equal(restored.interactiveExperience?.runId, typed.interactiveExperience?.runId);
  assert.equal(restored.interactiveExperience?.state, "reached");
  assert.equal(restored.interactiveExperience?.completion?.value, "delivered");
  const follow = await reopened.submit(chat.id, "Check delivery again");
  await (await reopened.response(follow.eventsUrl)).text();
  assert.equal((await reopened.turn(follow.turnId)).interactiveExperience?.recordId, "ORD-1001");
  assert.deepEqual(await reopened.request("/api/conversations/" + other.id + "/updates"), []);
});

test("a separate domain binds a row’s stable ID into the same versioned task used by a typed request", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "interactive-expense-"));
  const gateway = await startFixtureGateway();
  const sample = { reference: "ER-412", amount: 85.75, currency: "USD", status: "Awaiting review", label: "Team travel" };
  const received: unknown[] = [];
  const backend = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(input);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/queue" ? { records: [sample] } : { expense: sample }));
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, inspectorEnabled: true });
  t.after(async () => {
    await app.close(); await gateway.close(); backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const client = await testClient(app.url);
  await client.request("/api/integrations/integrations", {
    id: "expenses", name: "Expense service", transport: "http", baseUrl: "http://127.0.0.1:" + (backend.address() as AddressInfo).port,
  });
  const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, required, properties });
  const string = { type: "string" };
  const expense = object({ reference: string, amount: { type: "number" }, currency: string, status: string, label: string });
  async function publish(taskId: string, inputSchema: Record<string, unknown>, outputSchema: Record<string, unknown>, target: string, resourceIdField?: string) {
    const contract: TaskContractInput = {
      integrationId: "expenses", taskId, version: "1.0.0", effect: "read", description: "Read approved expense data.",
      inputSchema, outputSchema, binding: { target, method: "POST" }, resourceIdField, approvalPolicy: { mode: "none" },
      idempotency: { supported: false }, outcomeCodes: [{ code: "OK", meaning: "Read complete", success: true }],
      outcomeMapping: [{ code: "OK", statusIn: [200] }],
    };
    const { contract: draft } = await client.request<{ contract: { ref: string } }>("/api/integrations/contracts", contract);
    await client.request("/api/integrations/contracts/publish", { ref: draft.ref });
    return draft.ref;
  }
  const queue = await publish("queue", object({}), object({ records: { type: "array", items: expense } }), "/queue");
  const detail = await publish("detail", object({ reference: string }), object({ expense }), "/detail", "reference");
  const design: UiDesign = {
    name: "Expense review", layout: "stack", description: "Find a queued expense.", slots: [], targets: [],
    experience: { audience: "operator", actions: [
      { id: "queue", taskRef: queue, title: "Expense review queue", phrases: ["Show the expense queue"], metrics: [],
        table: { rows: "records", columns: [{ label: "Expense", path: "label" }, { label: "Status", path: "status" }],
          onClick: { action: "detail", prompt: "Open this expense", label: "Review expense", inputs: { reference: "reference" } } } },
      { id: "detail", taskRef: detail, title: "Expense details", phrases: ["Review expense {{reference}}"],
        metrics: [{ label: "Status", path: "expense.status" }, { label: "Amount", path: "expense.amount" }] },
    ] },
  };
  const broken = structuredClone(design);
  broken.experience!.actions[0].table!.onClick!.inputs.reference = "amount";
  await client.request("/api/admin/ui-layouts", { operation: "publish", domainId: "it_ops", design: broken }, 400);
  await client.request("/api/admin/ui-layouts", { operation: "publish", domainId: "it_ops", design });
  const chat = await client.request<ConversationView>("/api/conversations", { domainId: "it_ops" }, 201);
  const listed = (await client.ask(chat.id, "Show the expense queue")).turn;
  const table = canvas(listed).nodes.find((node) => node.type === "table");
  assert.ok(table?.type === "table" && table.rowActionIds?.[0]);
  assert.equal(table.rows[0][0], "Team travel");
  assert.equal(listed.experience!.actions.length, 0);
  const envelope = {
    version: "1.0", action: { name: "request_follow_up", surfaceId: listed.experience!.experienceId, sourceComponentId: "block_1",
      timestamp: new Date().toISOString(), context: { actionId: table.rowActionIds![0] } },
  };
  const click = await client.request<TurnAccepted>("/api/experiences/" + listed.experience!.experienceId + "/actions", { envelope, clientRequestId: randomUUID() }, 202);
  const clicked = (await client.wait(click)).turn;
  const typed = (await client.ask(chat.id, "Review expense ER-412")).turn;
  assert.equal(clicked.message, "Open this expense");
  assert.deepEqual(canvas(clicked), canvas(typed));
  assert.equal(clicked.interactiveExperience?.recordId, "ER-412");
  assert.deepEqual(received, [{}, { reference: "ER-412" }, { reference: "ER-412" }]);
  const wealth = await client.conversation();
  const outside = (await client.ask(wealth.id, "Show the expense queue")).turn;
  assert.equal(outside.interactiveExperience, undefined);
  assert.equal(received.length, 3);
});
