import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "./operator-fixture";
import { startFixtureGateway } from "./gateway-fixture";
import { startTestPreview } from "./preview";
import { testClient, testProject } from "./client";
import { fixturePortfolioSnapshotProvider } from "../packages/portfolio-snapshot";
import { generateWidgetFromText } from "../apps/server/widget-library";
import { defaultToolSetup } from "../packages/contracts/tool-setup";
import type { Bootstrap, ConversationView, TurnAccepted } from "../packages/contracts/api";
import type { TurnPayloads } from "../packages/contracts/inspector";
import type { DisplayExperience } from "../packages/contracts/surface";
import type { UiDesign, UiLayoutCatalog } from "../packages/contracts/ui-layout";

const layouts = "/api/admin/ui-layouts";
const preview = "/api/admin/ui-layout-preview";
const portfolioQuestion = "Let me know my portfolio summary.";
const compare = "Compare available and current balances.";
const cashDesign: UiDesign = {
  name: "Portfolio with cash", description: "Show the value of the account and its cash.", layout: "stack",
  targets: [{ kind: "intent", id: "show_portfolio" }],
  slots: [
    { kind: "widget", id: "cash", title: "Cash on hand", body: "", badge: "", accentTop: false,
      metrics: [{ id: "cash", label: "Cash", binding: "portfolio.cash", staticValue: "", subtext: "", tone: "default" }] },
    { kind: "block", id: "summary", component: "PznPortfolioSnapshot" },
  ],
};

test("published cards and preview use the connected snapshot and a matching widget preserves portfolio routing", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "domain-snapshot-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir, gateway: gateway.settings,
    portfolioSnapshots: { async read(mid, signal) {
      const snapshot = await fixturePortfolioSnapshotProvider.read(mid, signal);
      return snapshot && { ...snapshot, cashCents: 3_200_000 };
    } },
  });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dataDir, { recursive: true, force: true }); });
  const admin = await testClient(app.url);
  const trial = await admin.request<TurnAccepted & { layoutId: string }>("/api/admin/ui-layout-test", { design: cashDesign, message: portfolioQuestion }, 202);
  assert.equal((await admin.wait(trial)).trace.uiLayout?.id, trial.layoutId);
  assert.deepEqual((await admin.request<UiLayoutCatalog>(layouts)).library, []);
  assert.equal((await admin.request<{ code: string }>(preview, { design: cashDesign, personaId: "missing-customer" }, 404)).code, "preview_profile_unavailable");
  await admin.request(layouts, { operation: "publish", design: cashDesign });
  await admin.request("/api/admin/widgets", { operation: "save", widget: { ...generateWidgetFromText(portfolioQuestion), availableForConsumption: true } });
  const customer = await testClient(app.url);
  const conversation = await customer.conversation();
  const { turn } = await customer.ask(conversation.id, portfolioQuestion);
  const sample = await admin.request<DisplayExperience>(preview, { design: cashDesign, personaId: "demo-learner" });
  for (const experience of [sample, turn.experience]) {
    assert.equal(experience?.blocks.find((b) => b.component === "PznBoundWidget")?.props.metrics[0].value, "$32,000");
    assert.equal(experience?.blocks.find((b) => b.component === "PznPortfolioSnapshot")?.props.cashCents, 3_200_000);
  }
  const log = await customer.request<TurnPayloads>("/api/debug/payloads/" + turn.id);
  assert.ok(log.router && log.treatment && log.portfolio && log.composer);

  const wrong = { ...cashDesign, targets: [{ kind: "intent", id: "compare_balances" }] };
  for (const [url, body] of [[preview, { design: wrong }], [layouts, { operation: "publish", design: wrong }]] as const) {
    const error = await admin.request<{ code: string }>(url, body, 400);
    assert.equal(error.code, "ui_component_unavailable");
  }
});

test("published eligibility is shared by MID and an admin preview exercises its own tool settings", async (t) => {
  const app = await startTestPreview(); t.after(() => app.close());
  const owner = await testClient(app.url);
  const other = await testClient(app.url);
  const setup = { ...defaultToolSetup, treatmentOverrides: [{ scenarioId: "normal", contextId: "balance",
    output: { mode: "ranked", contentIds: ["balance_current_definition", "balance_available_definition"] } }],
    ccreRules: [{ scenarioId: "normal", contextId: "balance", name: "Learner only", source: "Learners", contentId: "balance_available_definition",
      condition: { kind: "persona_is", personaId: "demo-learner" } }] };
  await owner.request("/api/admin/tools", setup);
  await owner.request("/api/admin/tools?scope=preview", defaultToolSetup);
  assert.deepEqual((await owner.request<{ privateDraft: unknown }>("/api/admin/tools")).privateDraft, defaultToolSetup);
  for (const session of [owner, other]) {
    const conversation = await session.conversation("normal", "demo-returning");
    const { trace } = await session.ask(conversation.id, compare);
    assert.deepEqual(trace.ts?.baseline, ["balance_current_definition"]);
  }
  const testChat = await owner.request<ConversationView>("/api/admin/conversations?scope=preview", {
    setup: defaultToolSetup, conversation: { personaId: "demo-returning", scenarioId: "normal" },
  }, 201);
  const regular = await owner.request<ConversationView>("/api/admin/conversations", { personaId: "demo-returning", scenarioId: "normal" }, 201);
  assert.deepEqual((await owner.ask(regular.id, compare)).trace.ts?.baseline, ["balance_current_definition"]);
  assert.ok((await owner.ask(testChat.id, compare)).trace.ts?.baseline?.includes("balance_available_definition"));
});

test("retirement beneficiary follow-ups use the displayed account, its MID and the Treatment Selector rule", async (t) => {
  const unavailableComposerQuestion = "Check the beneficiary on my Rollover IRA ending in 6105.";
  const app = await startTestPreview(undefined, ({ envelope }) => {
    if (envelope.inputType === "PznExperienceCompositionInput" && envelope.request === unavailableComposerQuestion) return { status: 400 };
  });
  t.after(() => app.close());
  const first = await testClient(app.url);
  const ask = "Who’s the beneficiary on the second one?";
  for (const [persona, mid, secondId, expectedName] of [
    ["demo-learner", "DEMO-MID-1001", "RET-6105", null],
    ["demo-returning", "DEMO-MID-1002", "RET-9281", "Casey Lee"],
  ] as const) {
    await first.request("/api/profile-session", { personaId: persona });
    const thread = await first.conversation("normal", persona);
    const list = await first.ask(thread.id, "Show my retirement accounts.");
    const view = list.turn.experience?.blocks.find((b) => b.component === "PznRetirementAccounts");
    assert.equal(view?.props.accounts[1].id, secondId, JSON.stringify(list.trace.failures));
    const session = await testClient(app.url);
    await session.request("/api/profile-session", { personaId: persona });
    const answer = await session.ask(thread.id, ask);
    const blocks = answer.turn.experience?.blocks ?? [];
    const selected = blocks.find((b) => b.component === "PznRetirementAccounts")?.props.selected;
    assert.equal(selected?.id, secondId, JSON.stringify(answer.trace.failures));
    assert.equal(selected.beneficiary, expectedName);
    const missing = expectedName === null;
    assert.equal(blocks.some((b) => b.component === "PznContentCard" && b.props.title === "Update your beneficiaries"), missing);
    const logs = await session.request<TurnPayloads>("/api/admin/logs/" + answer.turn.id);
    assert.ok(logs.router && logs.retirementAccounts);
    assert.match(JSON.stringify(logs.router), new RegExp(secondId));
    assert.deepEqual(logs.treatment?.mockInput?.data, { mid, context: "learning", accountId: secondId });
    assert.equal((logs.treatment?.comparison?.legacy.data as string[]).includes("beneficiary_update"), missing);
    if (missing) {
      assert.ok(logs.composer);
      const steps = await session.ask(thread.id, "Show me the steps to update the beneficiary for my Rollover IRA ending in 6105.");
      assert.ok(steps.turn.experience?.blocks.some((b) => b.component === "PznStepList"));
      const covered = await session.ask(thread.id, "And the first one?");
      assert.equal(covered.turn.experience?.blocks.find((b) => b.component === "PznRetirementAccounts")?.props.selected?.beneficiary, "Jamie Morgan");
      assert.equal(covered.turn.experience?.blocks.some((b) => b.component === "PznContentCard"), false);
      const fallback = await session.ask(thread.id, unavailableComposerQuestion);
      assert.ok(fallback.trace.failures.some(({ stage }) => stage === "compose"));
      assert.equal(fallback.turn.experience?.blocks.find((b) => b.component === "PznRetirementAccounts")?.props.selected?.id, "RET-6105");
      assert.ok(fallback.turn.experience?.blocks.some((b) => b.component === "PznContentCard" && b.props.title === "Update your beneficiaries"));
    }
    const switched = await session.ask(thread.id, "Compare available and current balances.");
    assert.equal(switched.trace.intentId, "compare_balances");
    const unknown = await session.ask(thread.id, "Who's the beneficiary on account RET-9999?");
    assert.equal(unknown.turn.experience?.blocks.find((b) => b.component === "PznRetirementAccounts")?.props.selected, null);
    assert.equal((await session.request<TurnPayloads>("/api/admin/logs/" + unknown.turn.id)).treatment, null);
  }
  const thread = await first.conversation("normal", "demo-new-account");
  const empty = await first.ask(thread.id, "Show my retirement accounts.");
  assert.match(empty.turn.experience?.intro ?? "", /no retirement accounts on file/i);
});

test("record views, named intents and ordered choices survive publishing and reopening", async (t) => {
  const app = await startTestPreview(); t.after(() => app.close());
  const owner = await testClient(app.url);
  const catalog = await owner.request<UiLayoutCatalog>(layouts);
  assert.ok(catalog.targets.some(({ target }) => target.id === "sales_revops_list"));
  for (const view of ["detail", "timeline"]) {
    const design = { ...cashDesign, name: "Incident " + view, targets: [{ kind: "intent", id: "it_ops_" + view }],
      slots: [{ kind: "block", id: "record", component: "PznDynamicCanvas" }] };
    await owner.request(layouts, { operation: "publish", domainId: "it_ops", design });
    assert.equal((await owner.request<DisplayExperience>(preview + "?domain=it_ops", design)).blocks[0].component, "PznDynamicCanvas");
  }
  const bad = { ...cashDesign, targets: [{ kind: "intent", id: "it_ops_detail" }], slots: [cashDesign.slots[0]] };
  assert.equal((await owner.request<{ code: string }>(layouts, { operation: "publish", domainId: "it_ops", design: bad }, 400)).code, "ui_binding_unavailable");
  const unsupported = { ...bad, slots: [{ kind: "form", id: "status", title: "Change status", description: "", submitLabel: "Save", writeBack: true,
    fields: [{ id: "status", type: "text", label: "Status", placeholder: "", required: true, options: [], defaultBinding: "incident.status" }] }] };
  assert.equal((await owner.request<{ code: string }>(preview + "?domain=it_ops", unsupported, 400)).code, "ui_field_read_only");
  const custom = { id: "it_ops_intent_handover", label: "Shift handover", view: "timeline", phrases: ["Prepare my shift handover"] };
  const handover = { ...cashDesign, slots: [{ kind: "block", id: "timeline", component: "PznDynamicCanvas" }],
    targets: [{ kind: "intent", id: custom.id }], recordIntent: custom };
  await owner.request(layouts, { operation: "publish", domainId: "it_ops", design: handover });
  const ops = await owner.request<ConversationView>("/api/conversations", { domainId: "it_ops" }, 201);
  const inc = await owner.ask(ops.id, "Prepare my shift handover INC-4821");
  assert.equal(inc.trace.uiLayout?.target.id, custom.id);
  assert.equal(inc.turn.experience?.blocks.find((b) => b.component === "PznDynamicCanvas")?.props.recordId, "INC-4821");

  const deals = await owner.request<ConversationView>("/api/conversations", { domainId: "sales_revops" }, 201);
  const list = await owner.ask(deals.id, "Show my deals");
  const second = list.turn.experience?.blocks.find((b) => b.component === "PznDynamicCanvas")?.props.choices?.[1].id;
  assert.equal(second, "DEAL-887");
  const reopened = await testClient(app.url);
  const bootstrap = await reopened.request<Bootstrap>("/api/bootstrap?domain=sales_revops");
  assert.ok(bootstrap.conversations.some((chat) => chat.id === deals.id));
  await reopened.request("/api/conversations/" + deals.id);
  const invalid = await reopened.ask(deals.id, "Show the twelfth one");
  assert.match(invalid.turn.experience?.intro ?? "", /choose one of/i);
  const selection = await reopened.ask(deals.id, "Show the second one");
  assert.equal(selection.trace.intentId, "sales_revops_detail");
  assert.equal(selection.turn.experience?.blocks.find((b) => b.component === "PznDynamicCanvas")?.props.recordId, second);
  assert.equal((await reopened.ask(deals.id, "Who owns it?")).turn.experience?.blocks.find((b) => b.component === "PznDynamicCanvas")?.props.recordId, second);
});

test("a signed-in customer can resume a balance thread in a new session and continue the same history", async (t) => {
  const app = await startTestPreview(); t.after(() => app.close());
  const first = await testClient(app.url, undefined, "customer");
  const second = await testClient(app.url, undefined, "customer");
  await first.request("/api/profile-session", { personaId: "demo-learner" });
  const thread = await first.conversation();
  await (await first.response((await first.submit(thread.id, compare)).eventsUrl)).text();
  await second.request("/api/profile-session", { personaId: "demo-learner" });
  assert.ok((await second.request<Bootstrap>("/api/bootstrap")).conversations.some((c) => c.id === thread.id));
  const pending = await second.submit(thread.id, "Show me the summary");
  await (await second.response(pending.eventsUrl)).text();
  const reply = await second.turn(pending.turnId);
  assert.ok(reply.experience?.blocks.some((block) => block.component === "PznMetricSummary"));
  const restored = await second.request<ConversationView>("/api/conversations/" + thread.id);
  assert.equal(restored.turns.length, 2);
  await second.request("/api/profile-session", { personaId: "demo-returning" });
  await second.request("/api/conversations/" + thread.id, undefined, 404);
});
