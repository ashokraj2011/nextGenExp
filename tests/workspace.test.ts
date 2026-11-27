import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Bootstrap, Conversation, ConversationView, TurnAccepted } from "../packages/contracts/api";
import { fundingPreviewWorkflow } from "../packages/contracts/funding-workflow";
import { decodeChatInput, type TurnPayloads } from "../packages/contracts/inspector";
import { defaultToolSetup, type TreatmentPreview } from "../packages/contracts/tool-setup";
import { defaultWorkspacePins, pendingActionsContext, type PortalFundingView, type WorkspaceActionLog, type WorkspaceActionState, type WorkspaceNextStep, type WorkspacePendingAction } from "../packages/contracts/workspace";
import { testClient } from "./client";
import { startTestPreview } from "./preview";

test("pending actions use each customer's MID and save the actual Treatment Selector exchange", async (t) => {
  const preview = await startTestPreview();
  t.after(() => preview.close());
  const client = await testClient(preview.url);
  const actions = (personaId: string) => client.request<WorkspacePendingAction[]>("/api/workspace/" + personaId + "/" + pendingActionsContext);
  const logPath = "/api/admin/pending-action-logs";

  assert.deepEqual((await actions("demo-learner")).map(({ contentId }) => contentId), ["beneficiary_update"]);
  assert.deepEqual((await actions("demo-new-account")).map(({ contentId }) => contentId), ["fund_account"]);
  assert.deepEqual(await actions("demo-returning"), []);
  const logs = (await client.request<WorkspaceActionLog[]>(logPath)).reverse();
  assert.deepEqual(logs.map(({ request }) => request), ["1001", "1003", "1002"].map((suffix) => ({
    mid: "DEMO-MID-" + suffix, context: pendingActionsContext,
  })));
  assert.deepEqual(logs.map((log) => log.status === "succeeded" ? log.response : log.error), [
    { schemaVersion: "2.0", recommendations: [{ kind: "content", id: "beneficiary_update" }] },
    { schemaVersion: "2.0", recommendations: [{ kind: "content", id: "fund_account" }, { ...fundingPreviewWorkflow.recommendation, forContentIds: ["fund_account"] }] },
    { schemaVersion: "2.0", recommendations: [] },
  ]);
  assert.deepEqual((await client.request<Bootstrap>("/api/bootstrap")).conversations, []);
  assert.deepEqual(await (await testClient(preview.url)).request(logPath), []);

  const marcus = await client.conversation("normal", "demo-new-account");
  const previewFunding = () => client.request<TurnAccepted>("/api/conversations/" + marcus.id + "/preview-funding", {
    clientRequestId: randomUUID(), source: pendingActionsContext,
  }, 202);
  const funding = await client.wait(await previewFunding());
  assert.equal(funding.turn.experience?.blocks[0]?.component, "PznFundingOptions");
  const fundingLogs = await client.request<TurnPayloads>("/api/admin/logs/" + funding.turn.id);
  assert.deepEqual(fundingLogs.treatment?.mockInput?.data, { mid: "DEMO-MID-1003", context: pendingActionsContext });

  await client.request("/api/admin/tools", {
    ...defaultToolSetup,
    ccreRules: [{
      scenarioId: "normal", contextId: pendingActionsContext, contentId: "beneficiary_update", name: "Pause reminder", condition: { kind: "never" },
    }],
  });
  assert.deepEqual(await actions("demo-learner"), []);
  const [filtered] = await client.request<WorkspaceActionLog[]>(logPath);
  assert.ok(filtered.status === "succeeded");
  assert.equal(filtered.ccre?.results.find(({ contentId }) => contentId === "beneficiary_update")?.outcome, "excluded");

  await client.request("/api/admin/customer-events", {
    eventId: "event_pending_actions_first_deposit", personaId: "demo-new-account", type: "account.first_deposit.completed",
  });
  assert.deepEqual(await actions("demo-new-account"), []);
  assert.match((await client.wait(await previewFunding())).turn.experience?.intro ?? "", /no longer available/);
});

test("a portal deposit follows Marcus's MID across sign-ins and TS captures the reason at decision time", async (t) => {
  const preview = await startTestPreview();
  t.after(() => preview.close());
  const client = await testClient(preview.url);
  const personaId = "demo-new-account";
  const portal = "/api/account-portal/funding";
  const workspace = "/api/workspace/" + personaId + "/";
  const actions = workspace + pendingActionsContext;
  const saveFunding = { operation: "save", contentId: "fund_account" };
  const state = () => client.request<WorkspaceActionState>(workspace + "action-state");
  await client.request(portal, { personaId }, 403);
  await client.request(workspace + "todos", saveFunding, 403);
  await client.request("/api/profile-session", { personaId });
  assert.ok((await client.request<WorkspacePendingAction[]>(actions)).some((item) => item.action.kind === "funding"));
  await client.request(workspace + "todos", { ...saveFunding, contentId: "beneficiary_update" }, 409);
  const [saved, duplicate] = await Promise.all([
    client.request<WorkspacePendingAction[]>(workspace + "todos", saveFunding),
    client.request<WorkspacePendingAction[]>(workspace + "todos", saveFunding),
  ]);
  assert.deepEqual(saved, duplicate);
  assert.deepEqual(saved.map(({ contentId }) => contentId), ["fund_account"]);
  assert.deepEqual(await state(), { funding: null, todos: saved });
  const thread = await client.conversation("normal", personaId);
  const previewTurn = await client.wait(await client.request<TurnAccepted>("/api/conversations/" + thread.id + "/preview-funding",
    { clientRequestId: randomUUID(), source: pendingActionsContext }, 202));
  assert.equal(previewTurn.turn.experience?.blocks[0]?.component, "PznFundingOptions");
  assert.deepEqual(await state(), { funding: { status: "in_progress", conversationId: thread.id }, todos: saved });
  assert.equal((await client.request<PortalFundingView>(portal)).fundingStatus, "unfunded");
  const [first, retry] = await Promise.all([client.request<PortalFundingView>(portal, { personaId }), client.request<PortalFundingView>(portal, { personaId })]);
  assert.deepEqual(first.confirmation, retry.confirmation);
  assert.equal(first.confirmation?.mid, "DEMO-MID-1003");
  assert.equal(first.confirmation?.source, "mock-account-portal");
  await client.request("/api/profile-session", { personaId: null });
  const fresh = await testClient(preview.url);
  await fresh.request("/api/profile-session", { personaId });
  assert.deepEqual(await fresh.request<PortalFundingView>(portal), first);
  assert.deepEqual(await fresh.request<WorkspaceActionState>(workspace + "action-state"), {
    funding: { status: "completed", conversationId: thread.id, confirmedAt: first.confirmation?.occurredAt }, todos: saved,
  });
  assert.deepEqual(await fresh.request(actions), []);
  const [lookup] = await fresh.request<WorkspaceActionLog[]>("/api/admin/pending-action-logs");
  assert.ok(lookup.status === "succeeded");
  assert.equal(lookup.ccre?.fundingCheck?.eligible, false);
  assert.deepEqual(lookup.ccre?.fundingCheck?.confirmation, first.confirmation);
  const rulePreview = await fresh.request<TreatmentPreview>("/api/admin/treatment-preview", {
    scenarioId: "normal", contextId: pendingActionsContext, personaId, ordinal: 1, enabled: true, output: null,
  });
  assert.ok(rulePreview.status === "empty");
  assert.deepEqual(rulePreview.ccre?.fundingCheck, lookup.ccre?.fundingCheck);
  const after = await fresh.ask((await fresh.conversation("normal", personaId)).id, "what is next");
  assert.ok(after.turn.experience?.blocks.some((b) => b.component === "PznContentCard" && b.props.title === "Your first deposit is on file"));
  assert.ok(!after.turn.experience?.actions.some((a) => a.label === "Preview funding"));
  const log = await fresh.request<TurnPayloads>("/api/admin/logs/" + after.turn.id);
  const exchange = log.router?.attempts[0]?.exchange;
  assert.ok(exchange);
  const routerInput = decodeChatInput(exchange) as { customerContext: { fundingStatus: string; segment: string; notes: string } };
  assert.equal(routerInput.customerContext.fundingStatus, "funded");
  assert.doesNotMatch([routerInput.customerContext.segment, routerInput.customerContext.notes].join(" "), /unfunded|awaiting/i);
  assert.deepEqual(log.treatment?.fundingCheck, lookup.ccre?.fundingCheck);
  assert.equal(log.treatment?.fundingCheck?.actual, "funded");
  assert.equal(log.treatment?.fundingCheck?.condition, 'account.funding_status == "unfunded"');
  assert.deepEqual(log.treatment?.mockInput?.data, { mid: "DEMO-MID-1003", context: "next-step" });
  const original = await fresh.request<TurnPayloads>("/api/admin/logs/" + previewTurn.turn.id);
  assert.equal(original.treatment?.fundingCheck, undefined);
  assert.deepEqual(await fresh.request(workspace + "todos", { operation: "remove", contentId: "fund_account" }), []);
  await fresh.request("/api/profile-session", { personaId: "demo-learner" });
  assert.deepEqual(await fresh.request<WorkspaceActionState>("/api/workspace/demo-learner/action-state"), { funding: null, todos: [] });
  await fresh.request(workspace + "todos", saveFunding, 403);
  await fresh.request(portal, { personaId }, 409);
  assert.equal((await fresh.request<PortalFundingView>(portal)).confirmation, undefined);
  assert.deepEqual((await fresh.request<WorkspacePendingAction[]>("/api/workspace/demo-learner/pending-actions")).map((a) => a.contentId), ["beneficiary_update"]);
});

test("a workspace funding preview confirms eligibility then continues the existing funding workflow", async (t) => {
  const preview = await startTestPreview();
  t.after(() => preview.close());
  const client = await testClient(preview.url);
  const hostPath = "/api/workspace/demo-new-account/next-step";
  const next = await client.request<WorkspaceNextStep>(hostPath);
  assert.equal(next.title, "Fund your account");
  assert.equal(next.reason, "This account is awaiting its first deposit");
  assert.equal(next.canPreviewFunding, true);
  assert.equal(await client.request("/api/workspace/demo-learner/next-step"), null);

  const marcus = await client.conversation("normal", "demo-new-account");
  const path = "/api/conversations/" + marcus.id + "/preview-funding";
  const request = { clientRequestId: randomUUID() };
  const accepted = await client.request<TurnAccepted>(path, request, 202);
  assert.equal((await client.request<TurnAccepted>(path, request, 202)).turnId, accepted.turnId);
  const waiting = await client.wait(accepted);
  assert.equal(waiting.trace.sourcePageContext, "Overview");
  assert.equal(waiting.trace.selectedContextId, "next-step");
  assert.equal(waiting.turn.experience?.blocks[0]?.component, "PznFundingOptions");
  const logs = await client.request<TurnPayloads>("/api/debug/payloads/" + accepted.turnId);
  assert.deepEqual(logs.treatment?.mockInput?.data, { mid: "DEMO-MID-1003", context: "next-step" });
  assert.equal(logs.router, null);
  assert.equal(logs.composer, null);
  assert.deepEqual(logs.workflow?.calls.map(({ tool }) => tool), ["funding.status.read@1.0.0", "funding.options.read@1.0.0", "ask_user@1.0.0"]);
  const resumed = await client.ask(marcus.id, "Use the linked bank account.");
  assert.equal(resumed.turn.experience?.blocks[0]?.component, "PznFundingPreview");
  const resumedLogs = await client.request<TurnPayloads>("/api/debug/payloads/" + resumed.turn.id);
  assert.equal(resumedLogs.workflow?.agent?.runId, logs.workflow?.agent?.runId);

  await client.request("/api/admin/customer-events", {
    eventId: "event_workspace_first_deposit", personaId: "demo-new-account", type: "account.first_deposit.completed",
  });
  assert.equal((await client.request<WorkspaceNextStep>(hostPath)).canPreviewFunding, false);
  const stale = await client.wait(await client.request<TurnAccepted>(path, { clientRequestId: randomUUID() }, 202));
  assert.match(stale.turn.experience?.intro ?? "", /no longer available/);
  assert.equal((await client.request<TurnPayloads>("/api/debug/payloads/" + stale.turn.id)).workflow, null);
});

test("workspace pins and chat management are scoped to the customer and session", async (t) => {
  const preview = await startTestPreview();
  t.after(() => preview.close());
  const client = await testClient(preview.url);
  const other = await testClient(preview.url);
  const settings = "/api/workspace/demo-learner/preferences";
  const pins = ["next-step", "portfolio"];
  assert.deepEqual(await client.request(settings, { pins }), pins);
  await client.request(settings, { pins: ["portfolio", "portfolio"] }, 400);
  const bootstrap = await client.request<Bootstrap>("/api/bootstrap");
  const alice = bootstrap.personas.find(({ personaId }) => personaId === "demo-learner");
  assert.deepEqual(alice?.pins, pins);
  const end = alice?.overview?.portfolioHistory?.at(-1);
  assert.deepEqual(end, { date: "2026-11-22", totalCents: 5_000_000 });
  assert.deepEqual(bootstrap.personas.find(({ personaId }) => personaId === "demo-new-account")?.pins, defaultWorkspacePins);
  assert.deepEqual((await other.request<Bootstrap>("/api/bootstrap")).personas.find(({ personaId }) => personaId === "demo-learner")?.pins, defaultWorkspacePins);

  const thread = await client.conversation();
  const path = "/api/conversations/" + thread.id;
  await other.request(path + "/settings", { operation: "rename", title: "Foreign" }, 404);
  await client.request(path + "/settings", { operation: "rename", title: "Home savings" });
  const accepted = await client.submit(thread.id, "Show my home-buying goal.");
  assert.equal(accepted.conversation.title, "Home savings");
  await client.wait(accepted);
  const archived = await client.request<Conversation>(path + "/settings", { operation: "archive" });
  assert.equal(typeof archived.archivedAt, "number");
  assert.equal((await client.request<ConversationView>(path)).turns.length, 1);
  await client.request(path + "/turns", { message: "Show me the summary", clientRequestId: randomUUID() }, 409);
  assert.equal((await client.request<Conversation>(path + "/settings", { operation: "restore" })).archivedAt, undefined);
});
