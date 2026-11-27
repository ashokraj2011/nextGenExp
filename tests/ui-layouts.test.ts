import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { TurnAccepted } from "../packages/contracts/api";
import type { TurnPayloads } from "../packages/contracts/inspector";
import { decodeChatInput } from "../packages/contracts/inspector";
import type { DisplayExperience } from "../packages/contracts/surface";
import type { EvalRunReport } from "../packages/contracts/eval-suite";
import type { UxProposal } from "../packages/contracts/ux-evolution";
import type { UiDesign, UiLayoutCatalog, UiLayoutRecord } from "../packages/contracts/ui-layout";
import { operatorHeader, reviewer, startApp } from "./operator-fixture";
import { testClient, testProject } from "./client";
import { startFixtureGateway } from "./gateway-fixture";
import { startTestPreview } from "./preview";

const settingsPath = "/api/admin/ui-layouts";
const previewPath = "/api/admin/ui-layout-preview";
const compare = "Compare available and current balances.";
const design: UiDesign = {
  name: "Comparison overview", description: "Use for a side-by-side explanation of the two balance definitions.",
  layout: "dashboard",
  targets: [{ kind: "intent", id: "compare_balances" }],
  slots: [
    { kind: "text", id: "header", heading: "Two ways to read your balance", body: "See the meanings side by side.", tone: "accent" },
    { kind: "block", id: "compare", component: "PznComparison" },
  ],
};

test("layout generation sends only the selected workspace fields and returns a previewable draft", async (t) => {
  const incident: UiDesign = {
    name: "Incident triage", description: "Show the current incident.", layout: "stack",
    targets: [{ kind: "intent", id: "it_ops_detail" }],
    slots: [{
      kind: "widget", id: "incident", title: "{{incident.id}}", badge: "{{incident.severity}}", body: "", accentTop: true,
      metrics: [{ id: "status", label: "Status", binding: "incident.status", staticValue: "", subtext: "", tone: "default" }],
    }],
  };
  const invalidBinding = structuredClone(incident);
  const widget = invalidBinding.slots[0];
  assert.ok(widget.kind === "widget");
  widget.metrics[0].binding = "portfolio.total";
  const listView = { ...incident, targets: [{ kind: "intent", id: "it_ops_list" }] };
  const seenPrompts: string[] = [];
  const model = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const { messages } = JSON.parse(Buffer.concat(chunks).toString());
    const candidate = [incident, invalidBinding, listView][seenPrompts.length];
    seenPrompts.push(messages[0].content);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(candidate) } }],
    }));
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => model.close(() => resolve())));
  const dataDir = await mkdtemp(join(tmpdir(), "ui-domain-generation-"));
  const app = await startApp({
    projectRoot: fileURLToPath(testProject), dataDir,
    gateway: { baseUrl: "http://127.0.0.1:" + (model.address() as AddressInfo).port, model: "ui-generator-test", contextWindow: 16384, maxOutputTokens: 1500 },
  });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const client = await testClient(app.url);
  const mismatch = await client.request<{ message: string }>(previewPath, { ...incident, targets: [] }, 400);
  assert.match(mismatch.message, /incident\.severity belongs to IT Ops.*Design domain/);

  for (const generatedBy of ["copilot_llm", "synthesizer", "synthesizer"]) {
    const generated = await client.request<{ design: UiDesign; generatedBy: string; boundKeys: string[] }>(
      "/api/admin/ui-layout-generate?domain=it_ops", { prompt: "Build an incident triage card with current severity and status" },
    );
    assert.equal(generated.generatedBy, generatedBy);
    assert.ok(generated.boundKeys.every((key) => key.startsWith("incident.")));
    assert.ok(generated.boundKeys.includes("incident.severity"));
    const preview = await client.request<DisplayExperience>(previewPath + "?domain=it_ops", generated.design);
    const card = preview.blocks.find((block) => block.component === "PznBoundWidget");
    assert.ok(card?.component === "PznBoundWidget");
    assert.match(card.props.title, /INC-4821/);
  }
  assert.equal(seenPrompts.length, 3);
  for (const prompt of seenPrompts) {
    assert.match(prompt, /IT Operations.*listed fields/);
    assert.match(prompt, /incident\.severity/);
    assert.doesNotMatch(prompt, /portfolio\.total|customer\.displayName|deal\.id/);
  }
});

test("approved feedback replays the original request and detects when its card is unpublished", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "layout-corrections-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir, gateway: gateway.settings });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dataDir, { recursive: true, force: true }); });
  const client = await testClient(app.url);
  const { created } = await client.request<{ created: UxProposal[] }>("/api/admin/ux-evolution-scan", { includeSampleTraffic: true });
  assert.ok(created.length);
  const { proposal } = await client.request<{ proposal: UxProposal }>("/api/admin/ux-evolution-approve", { id: created[0].id });
  assert.equal(proposal.regression?.prompt, created[0].samplePrompts[0]);
  const check = async () => (await client.request<{ report: EvalRunReport }>("/api/admin/eval-run", {}))
    .report.results.find((r) => r.id === "correction_" + proposal.shippedWidgetId);
  assert.equal((await check())?.passed, true);
  await client.request("/api/admin/widgets", { operation: "set_availability", id: proposal.shippedWidgetId, availableForConsumption: false });
  assert.equal((await check())?.passed, false);
});

test("publishes layouts for scoped chat intents and preserves drafts, snapshots and attachments on restart", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pzn-ui-layouts-"));
  const gateway = await startFixtureGateway(() => ({ delayMs: 30 }));
  const start = () => startApp({ projectRoot: fileURLToPath(testProject), dataDir, gateway: gateway.settings });
  let app = await start();
  t.after(async () => { await app.close(); await gateway.close(); await rm(dataDir, { recursive: true, force: true }); });
  let client = await testClient(app.url);
  const cookie = client.cookie;
  const sample = await client.request<DisplayExperience>(previewPath, design);
  assert.deepEqual(sample.blocks.map(({ component }) => component), ["PznLayoutText", "PznComparison"]);
  assert.equal(sample.actions.length, 0);
  const first = await client.request<UiLayoutRecord>(settingsPath, { operation: "draft", design });
  const conversation = await client.conversation();
  const unstyled = await client.ask(conversation.id, compare);
  assert.equal(unstyled.turn.experience?.theme, undefined);

  const published = await client.request<UiLayoutRecord>(settingsPath, { operation: "publish", id: first.id, revision: first.revision, design });
  assert.equal(published.published?.revision, published.revision);
  const turn = await client.submit(conversation.id, compare);
  const other = await testClient(app.url);
  const reviewerAuth = { Authorization: operatorHeader(reviewer) };
  const sameOwner = await other.request<UiLayoutCatalog>(settingsPath);
  assert.equal(sameOwner.layouts[0].id, published.id);
  await other.request(settingsPath, { operation: "unpublish", id: published.id, revision: published.revision }, 404, reviewerAuth);
  const shared = await other.request<UiLayoutCatalog>(settingsPath, undefined, 200, reviewerAuth);
  assert.deepEqual(shared.layouts, []);
  assert.deepEqual(shared.library[0], { ...published.published, domainId: "wealth" });
  await client.request(settingsPath, { operation: "publish", design: { ...design, name: "Conflicting layout" } }, 409);

  const nextDesign: UiDesign = {
    ...design, slots: [
      { kind: "text", id: "new", heading: "Compare your balances", body: "", tone: "plain" },
      design.slots[1],
    ],
  };
  const edited = await client.request<UiLayoutRecord>(settingsPath, {
    operation: "draft", id: published.id, revision: published.revision, design: nextDesign,
  });
  assert.equal(edited.published?.revision, published.revision);
  await client.request(settingsPath, { operation: "publish", id: published.id, revision: published.revision, design: nextDesign }, 409);
  const ready = await client.wait(turn);
  assert.equal(ready.turn.experience?.theme, "evergreen");
  assert.equal(ready.turn.experience?.blocks.find((block) => block.component === "PznLayoutText")?.props.heading, "Two ways to read your balance");
  assert.deepEqual(ready.trace.uiLayout, {
    id: published.id, revision: published.revision, name: design.name, target: { kind: "intent", id: "compare_balances" },
  });
  const logs = await client.request<TurnPayloads>("/api/debug/payloads/" + ready.turn.id);
  assert.deepEqual((decodeChatInput(logs.router!.attempts[0].exchange!) as Record<string, unknown>).uiDescriptions, [
    { intentId: "compare_balances", description: design.description },
  ]);

  await app.close();
  app = await start();
  client = await testClient(app.url, cookie);
  const current = (await client.request<UiLayoutCatalog>(settingsPath)).layouts[0];
  assert.deepEqual(current.draft, nextDesign);
  assert.deepEqual(current.published?.design, design);
  await client.request(settingsPath, { operation: "unpublish", id: current.id, revision: current.revision });
  assert.equal((await client.ask(conversation.id, compare)).turn.experience?.theme, undefined);
  assert.equal((await client.turn(ready.turn.id)).experience?.theme, "evergreen");
});

test("reorders an agentic layout while keeping verified results and signed form actions usable", async (t) => {
  const app = await startTestPreview();
  t.after(() => app.close());
  const client = await testClient(app.url);
  await client.request(settingsPath, {
    operation: "publish", design: {
      name: "Home savings controls", description: "Place the savings controls before the projection.",
      targets: [{ kind: "capability", id: "goal.savings.simulate" }], layout: "dashboard",
      slots: [
        { kind: "text", id: "savings", heading: "Explore a savings plan", body: "", tone: "accent" },
        { kind: "block", id: "input", component: "PznCapabilityForm" },
        { kind: "block", id: "projection", component: "PznSavingsChart" },
      ],
    },
  });
  const conversation = await client.conversation();
  const { turn, trace } = await client.ask(conversation.id, "I want to buy a house in two years. Show me how close I am and help me explore a savings plan.");
  const display = turn.experience!;
  assert.deepEqual(display.blocks.slice(0, 3).map(({ component }) => component), ["PznLayoutText", "PznCapabilityForm", "PznSavingsChart"]);
  assert.ok(display.blocks.some(({ component }) => component === "PznPortfolioSnapshot"));
  assert.ok(display.blocks.some(({ component }) => component === "PznGoalProgress"));
  assert.deepEqual(trace.uiLayout?.target, { kind: "capability", id: "goal.savings.simulate" });
  const form = display.blocks[1];
  assert.ok(form.component === "PznCapabilityForm");
  const accepted = await client.request<TurnAccepted>("/api/experiences/" + display.experienceId + "/actions", {
    clientRequestId: randomUUID(), envelope: { version: "1.0", action: {
      name: "request_follow_up", surfaceId: display.experienceId, sourceComponentId: "block_2", timestamp: new Date().toISOString(),
      context: { actionId: form.props.actionId, values: { months: 30, monthlyCents: 100_000 } },
    } },
  }, 202);
  const revised = await client.wait(accepted);
  const projection = revised.turn.experience!.blocks.find((block) => block.component === "PznSavingsChart");
  assert.equal(projection?.props.projectedCents, 5_600_000);
  assert.equal(revised.turn.experience?.theme, "evergreen");
});

test("layouts remain presentation-only when eligibility is empty and reject unregistered inputs", async (t) => {
  const app = await startTestPreview();
  t.after(() => app.close());
  const client = await testClient(app.url);
  await client.request(settingsPath, { operation: "publish", design });
  const empty = await client.conversation("empty");
  assert.equal((await client.ask(empty.id, compare)).turn.experience?.theme, undefined);
  await client.request(settingsPath, { operation: "publish", design: {
    ...design, targets: [{ kind: "capability", id: "unknown.operation" }],
  } }, 400);
  await client.request(previewPath, { ...design, slots: [{ kind: "block", id: "invalid", component: "script" }] }, 400);
  await client.request(previewPath, {
    ...design, slots: [{ kind: "text", id: "invalid", heading: "Your balance is $10,000", body: "", tone: "plain" }],
  }, 400);
  assert.equal((await client.response(settingsPath, { operation: "publish", design }, { Origin: "https://outside.invalid" })).status, 403);
});
