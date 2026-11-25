import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startTestPreview } from "./preview";
import { startApp } from "./operator-fixture";
import { startFixtureGateway } from "./gateway-fixture";
import { testClient, testProject } from "./client";
import type { TurnPayloads } from "../packages/contracts/inspector";
import type { TurnView, RecordUpdate } from "../packages/contracts/api";

function canvas(turn: TurnView) {
  assert.equal(turn.status, "completed", JSON.stringify(turn));
  const block = turn.experience?.blocks.find((b) => b.component === "PznDynamicCanvas");
  assert.ok(block, turn.experience?.intro);
  return block.props;
}

test("deal and incident questions use the selected record and unavailable charts have no numbers", async (t) => {
  const app = await startTestPreview();
  t.after(() => app.close());
  const client = await testClient(app.url);
  const chat = await client.conversation();
  const ask = async (message: string) => (await client.ask(chat.id, message)).turn;
  const deals = canvas(await ask("Show my deals"));
  assert.ok(deals.choices?.some((r) => r.id === "DEAL-887"));
  const northstar = canvas(await ask("Show Northstar DEAL-887"));
  assert.equal(northstar.recordId, "DEAL-887");
  assert.ok(northstar.subtitle?.includes("Security Review"));
  assert.ok(!northstar.nodes.some((n) => n.type === "approval"));
  assert.equal(canvas(await ask("What is blocking this deal?")).recordId, "DEAL-887");
  assert.match((await ask("Tell me when I can send the quote")).experience!.intro, /DEAL-887.*Commit/);
  assert.equal(canvas(await ask("Show DEAL-00000")).recordId, undefined);
  assert.equal(canvas(await ask("Show INC-4821")).recordId, "INC-4821");
  const available = await ask("Show a chart of my portfolio allocation");
  assert.ok(available.experience?.blocks.some((b) => b.component === "PznPortfolioSnapshot"));
  const missing = await ask("Show a chart of warehouse shipments by region");
  assert.match(missing.experience!.intro, /data source/i);
  assert.doesNotMatch(JSON.stringify(missing.experience), /Core Equities|55%|barchart/);
});

test("customer reads use the scoped MID and a delivered order updates its original thread after restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "customer-orders-"));
  const gateway = await startFixtureGateway();
  const open = () => startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, mode: "test" });
  let app = await open();
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  let client = await testClient(app.url);
  const chat = await client.conversation(), other = await client.conversation("normal", "demo-returning");
  const customer = await testClient(app.url, client.cookie, "customer");
  const sent = await customer.submit(chat.id, "Where is my order ORD-1001?");
  await (await customer.response(sent.eventsUrl)).text();
  const lookup = await customer.turn(sent.turnId);
  const view = canvas(lookup);
  assert.equal(view.dataSource, "int.commerce_sandbox.lookup_order@1.0.0");
  assert.match(JSON.stringify(view.nodes), /shipped/);
  const { customerLookup } = await client.request<TurnPayloads>("/api/admin/logs/" + lookup.id);
  assert.equal(customerLookup?.tool, view.dataSource);
  assert.match(JSON.stringify(customerLookup.registryInput.data), /ORD-1001/);
  assert.match(JSON.stringify(customerLookup.result?.data), /shipped/);
  assert.doesNotMatch(JSON.stringify(view), /DEMO-MID/);
  const different = (await client.ask(other.id, "Where is my order ORD-1001?")).turn;
  assert.match(different.experience!.intro, /couldn’t verify/);
  const watching = (await client.ask(chat.id, "Tell me when it is delivered")).turn;
  assert.match(watching.experience!.intro, /this conversation.*ORD-1001.*delivered/);
  const cookie = client.cookie;
  await app.close();
  const path = join(dir, "commerce-orders.json");
  const orders = JSON.parse(await readFile(path, "utf8"));
  orders[0].status = "delivered";
  await writeFile(path, JSON.stringify(orders));
  app = await open();
  client = await testClient(app.url, cookie);
  const updates = (id: string) => client.request<RecordUpdate[]>("/api/conversations/" + id + "/updates");
  let original = await updates(chat.id);
  for (let i = 0; i < 7 && original[0]?.state !== "reached"; i++) { await delay(850); original = await updates(chat.id); }
  assert.deepEqual(original.map((u) => [u.recordId, u.state, u.value]), [["ORD-1001", "reached", "delivered"]]);
  assert.deepEqual(await updates(other.id), []);
  assert.equal((await updates(chat.id)).length, 1);
});
