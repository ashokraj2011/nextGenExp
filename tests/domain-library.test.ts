import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generateWidgetFromText } from "../apps/server/widget-library";
import { Store } from "../apps/server/store";
import type { Bootstrap, ConversationView } from "../packages/contracts/api";
import type { UiDesign, UiLayoutCatalog, UiLayoutRecord } from "../packages/contracts/ui-layout";
import { author, operatorHeader, reviewer, testOperators } from "./operator-fixture";
import { testClient, testProject } from "./client";

const path = "/api/admin/ui-layouts";
const design: UiDesign = {
  name: "Personal balance card", description: "Compare the two balances for the current customer.",
  targets: [{ kind: "intent", id: "compare_balances" }], layout: "stack",
  slots: [{ id: "welcome", kind: "widget", title: "Balances for {{customer.displayName}}", badge: "Balances",
    body: "", accentTop: true, metrics: [{ id: "available", label: "Available", binding: "balances.available",
      staticValue: "", subtext: "", tone: "default" }] }],
};
const grants = {
  wealth: { owners: [author.username], users: [reviewer.username, "demo-learner", "demo-returning"] },
  it_ops: { owners: [author.username] },
  sales_revops: { owners: [reviewer.username] },
};

async function startTenant(base: string, tenantId: string) {
  const script = `
    import { startApp } from "./apps/server/http.ts";
    import { startFixtureGateway } from "./tests/gateway-fixture.ts";
    const gateway = await startFixtureGateway();
    const app = await startApp({ projectRoot: process.cwd(), dataDir: process.env.PZN_DATA_DIR,
      operators: JSON.parse(process.env.PZN_OPERATORS_JSON), mode: "test", gateway: gateway.settings });
    process.on("disconnect", async () => { await app.close(); await gateway.close(); });
    process.send(app.url);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: fileURLToPath(testProject), stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: { ...process.env, PZN_TENANT_ID: tenantId, PZN_DATA_DIR: base, PZN_OPERATORS_JSON: JSON.stringify(testOperators),
      PZN_TENANT_ADMINS_JSON: "[]", PZN_DOMAIN_MEMBERSHIPS_JSON: JSON.stringify(grants) },
  });
  const exited = once(child, "exit");
  const url = await Promise.race([
    once(child, "message").then(([message]) => String(message)),
    exited.then(([code]) => { throw new Error("Tenant server ended during startup with code " + code); }),
  ]);
  return { url, close: async () => { child.disconnect(); await exited; } };
}

test("a published domain design reaches independent members with their own data and is isolated on a shared deployment volume", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sfield-tenant-domains-"));
  const north = await startTenant(base, "north");
  let south: Awaited<ReturnType<typeof startTenant>> | undefined;
  t.after(async () => { await Promise.all([north.close(), south?.close()]); await rm(base, { recursive: true, force: true }); });
  south = await startTenant(base, "south");
  const owner = await testClient(north.url);
  const published = await owner.request<UiLayoutRecord>(path, { operation: "publish", domainId: "wealth", design });
  await owner.request(path, { operation: "draft", id: published.id, revision: published.revision, design: { ...design, name: "Unreleased design" } });
  await owner.request(path, { operation: "publish", domainId: "it_ops", design: {
    ...design, name: "Incident status", targets: [{ kind: "capability", id: "ops_incident" }],
    slots: [{ ...design.slots[0], title: "{{incident.id}}", metrics: [] }],
  } });
  const reader = await testClient(north.url);
  const readerHeaders = { Authorization: operatorHeader(reviewer) };
  const catalog = await reader.request<UiLayoutCatalog>(path, undefined, 200, readerHeaders);
  assert.equal(catalog.tenantId, "north");
  assert.deepEqual(catalog.domains, ["sales_revops"]);
  assert.deepEqual(catalog.layouts, []);
  assert.deepEqual((await reader.request<Bootstrap>("/api/bootstrap", undefined, 200, readerHeaders)).personas, []);
  assert.deepEqual(catalog.library.map((item) => [item.domainId, item.design.name]), [["wealth", design.name]]);
  await reader.request(path, { operation: "publish", domainId: "wealth", design }, 403, readerHeaders);
  await reader.request(path, { operation: "publish", domainId: "sales_revops", design }, 400, readerHeaders);
  await reader.request(path, { operation: "draft", domainId: "sales_revops", design }, 200, readerHeaders);

  const values = [];
  for (const [userId, name] of [["demo-learner", "Alice Morgan"], ["demo-returning", "Jordan Lee"]]) {
    const customer = await testClient(north.url, undefined, "customer");
    await customer.request("/api/profile-session", { personaId: userId });
    const thread = await customer.conversation("normal", userId);
    assert.deepEqual([thread.tenantId, thread.domainId, thread.userId], ["north", "wealth", userId]);
    const turn = await customer.submit(thread.id, "Compare available and current balances.");
    await (await customer.response(turn.eventsUrl)).text();
    const card = (await customer.turn(turn.turnId)).experience?.blocks.find((block) => block.component === "PznBoundWidget");
    assert.equal(card?.props.title, "Balances for " + name);
    values.push(card?.props.metrics[0].value);
  }
  assert.notEqual(values[0], values[1]);
  const publicChat = await testClient(north.url, undefined, "customer");
  const accounts = await publicChat.request<Bootstrap>("/api/bootstrap");
  assert.equal(accounts.requiresProfile, true);
  assert.deepEqual(accounts.personas, []);
  const choices = await publicChat.request<{ profiles: { personaId: string }[] }>("/api/profile-options");
  assert.deepEqual(choices.profiles.map(({ personaId }) => personaId).sort(), ["demo-learner", "demo-returning"]);
  await publicChat.request("/api/profile-session", { personaId: "demo-learner" });
  const aliceThread = await publicChat.conversation();
  await publicChat.request("/api/profile-session", { personaId: "demo-returning" });
  await publicChat.request("/api/conversations/" + aliceThread.id, undefined, 403);
  assert.deepEqual((await publicChat.request<Bootstrap>("/api/bootstrap")).conversations, []);
  await publicChat.request("/api/profile-session", { personaId: null });
  assert.deepEqual((await publicChat.request<Bootstrap>("/api/bootstrap")).personas, []);

  const ops = await owner.request<ConversationView>("/api/conversations", { domainId: "it_ops" }, 201);
  assert.equal(ops.userId, author.username);
  const incident = await owner.ask(ops.id, "Build an IT incident triage dashboard for our active P1 alert");
  assert.deepEqual(incident.trace.chatScope, { tenantId: "north", domainId: "it_ops", userId: author.username, threadId: ops.id });
  const incidentCard = incident.turn.experience?.blocks.find((block) => block.component === "PznBoundWidget");
  assert.match(incidentCard?.props.title ?? "", /INC-/);
  assert.equal(incidentCard?.props.hydratedFor, undefined);
  const opsHome = await owner.request<Bootstrap>("/api/bootstrap?domain=it_ops");
  assert.equal(opsHome.personas[0].displayName, author.username);
  assert.equal(opsHome.personas[0].overview, undefined);
  assert.equal(opsHome.personas[0].profile, undefined);
  assert.deepEqual(opsHome.conversations.map(({ id }) => id), [ops.id]);
  assert.ok(!(await owner.request<Bootstrap>("/api/bootstrap?domain=wealth")).conversations.some(({ id }) => id === ops.id));
  const widget = generateWidgetFromText("Incident recovery checklist");
  const opsWidgets = "/api/admin/widgets?domain=it_ops";
  const saved = await owner.request<{ widget: { id: string } }>(opsWidgets, { operation: "save", widget: { ...widget, availableForConsumption: true } });
  const sameOperator = await testClient(north.url);
  assert.deepEqual((await sameOperator.request<{ widgets: { id: string }[] }>(opsWidgets)).widgets.map(({ id }) => id), [saved.widget.id]);
  assert.ok(!(await owner.request<{ widgets: { id: string }[] }>("/api/admin/widgets?domain=wealth")).widgets.some(({ id }) => id === saved.widget.id));
  await reader.request(opsWidgets, undefined, 403, readerHeaders);
  await reader.request("/api/conversations", { personaId: "demo-learner", scenarioId: "normal", domainId: "it_ops" }, 403, readerHeaders);
  const southOwner = await testClient(south.url);
  assert.deepEqual((await southOwner.request<UiLayoutCatalog>(path)).library, []);
  await southOwner.request("/api/conversations/" + ops.id, undefined, 404);
  await southOwner.request(path, { operation: "publish", domainId: "wealth", design });
  const southChat = await southOwner.conversation();
  assert.equal(southChat.tenantId, "south");
});

test("migration preserves legacy owners and resolves conflicting publications deterministically", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sfield-layout-upgrade-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "app.sqlite");
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE ui_layouts (id TEXT PRIMARY KEY, principal_id TEXT, updated_at INTEGER, record TEXT)");
  for (const [i, owner] of ["old-browser", "recent-browser"].entries()) {
    const id = "ui_" + String(i + 1).repeat(32);
    const record = { id, revision: 1, updatedAt: i + 1, draft: design, published: { id, revision: 1, design } };
    old.prepare("INSERT INTO ui_layouts VALUES (?, ?, ?, ?)").run(id, owner, i + 1, JSON.stringify(record));
  }
  old.close();
  const store = new Store(file);
  try {
    assert.equal(store.publishedUiLayouts("wealth").length, 1);
    assert.equal(store.publishedUiLayouts("wealth")[0].id, "ui_" + "2".repeat(32));
    const older = store.listUiLayouts("old-browser", "first owner")[0];
    assert.deepEqual(older.draft, design);
    assert.equal(older.published, undefined);
    store.changeUiLayout("old-browser", "first owner", ["wealth"], { operation: "draft", id: older.id, revision: older.revision, design }, 3);
    assert.equal(store.listUiLayouts("new-browser", "first owner")[0].id, older.id);
  } finally { store.close(); }
});
