import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_DEFAULTS,
  AgenticHarness,
  ConversationCompactor,
  InMemoryArtifactStore,
  InMemoryMemoryRepository,
  MemoryService,
  formatRollingSummary,
  type AuditRecord,
  type HarnessStageRecord,
} from "@sfield/core";
import { resolveClarificationReply } from "../apps/server/chat-history";
import { startApp } from "./operator-fixture";
import { testClient, testProject } from "./client";
import { startFixtureGateway } from "./gateway-fixture";

test("@sfield/core defaults prioritize summary, preferences, and facts ahead of raw history", () => {
  assert.deepEqual(
    [...AGENT_DEFAULTS.context.priority],
    ["summary", "preferences", "facts", "history", "retrieval"],
  );
});

test("@sfield/core ConversationCompactor compacts older turns into sfield.memory and supersedes cleanly", async () => {
  const audits: AuditRecord[] = [];
  const memory = new MemoryService({
    repository: new InMemoryMemoryRepository(),
    artifacts: new InMemoryArtifactStore(),
    caps: { preferences: 50, facts: 100 },
    retentionDays: { preferences: 365, facts: 30, conversation: 30 },
    audit: async (records) => { audits.push(...records); },
  });
  const compactor = new ConversationCompactor(memory);
  const principal = { tenantId: "t1", subjectId: "alice", roles: ["customer"], attributes: {} };
  const conversationId = "conv_compact_test";

  const makeTurns = (count: number) => Array.from({ length: count }, (_, idx) => {
    const ordinal = idx + 1;
    return {
      ordinal,
      turnId: `turn_${ordinal}`,
      userMessage: ordinal === 1
        ? "Show my portfolio as a pie chart"
        : ordinal === 2
          ? "Check my AAPL and MSFT stock holdings"
          : `Follow up question ${ordinal} about my $120,304 balance`,
      assistantReply: ordinal === 1
        ? "Your portfolio is $120,304 total (62% stocks, 8.3% fixed income, 29.7% cash)."
        : `Handled turn ${ordinal} with live balances ($35,738.20 cash).`,
      displayedContent: ordinal === 1 ? ["Portfolio Allocation Pie Chart"] : [`Card ${ordinal}`],
    };
  });

  // Below threshold (4 turns <= verbatimWindow 4): should not compact
  const skipped = await compactor.compactIfNeeded({
    principal,
    conversationId,
    turns: makeTurns(4),
    verbatimWindow: 4,
    compactEveryTurns: 3,
  });
  assert.equal(skipped.compacted, false);
  assert.equal(skipped.summary, null);

  // At 7 turns (3 older turns outside verbatimWindow=4): compacts & persists in sfield.memory
  const first = await compactor.compactIfNeeded({
    principal,
    conversationId,
    turns: makeTurns(7),
    verbatimWindow: 4,
    compactEveryTurns: 3,
  });
  assert.equal(first.compacted, true);
  assert.equal(first.summary?.coveredThroughOrdinal, 3);
  assert.ok(first.summary?.establishedFacts.some((f) => f.includes("$120,304")));
  assert.ok(first.summary?.userPreferences.some((p) => /pie chart/i.test(p)));
  assert.match(formatRollingSummary(first.summary!), /ROLLING CONVERSATION SUMMARY \(through turn 3\)/);

  // Reading back via getSummary returns the stored structured summary
  const loaded = await compactor.getSummary(principal, conversationId);
  assert.equal(loaded?.coveredThroughOrdinal, 3);

  // At 10 turns (3 more newly compactable turns): supersedes the previous summary cleanly
  const second = await compactor.compactIfNeeded({
    principal,
    conversationId,
    turns: makeTurns(10),
    verbatimWindow: 4,
    compactEveryTurns: 3,
  });
  assert.equal(second.compacted, true);
  assert.equal(second.summary?.coveredThroughOrdinal, 6);
  assert.ok(second.memoryItem?.supersedes, "expected MemoryService supersession of prior summary");
  assert.ok(audits.some((a) => a.type === "memory_write"));
});

test("@sfield/core AgenticHarness streams live stages via onStage observer", async () => {
  const streamed: HarnessStageRecord[] = [];
  const harness = new AgenticHarness({});
  const result = await harness.run({
    kind: "stream_test",
    onStage: (entry) => { streamed.push(entry); },
    plan: async () => ({
      status: "ready",
      plan: { topic: "portfolio" },
      resolvedGoal: "Render portfolio pie chart",
      thinking: "User requested pie chart of portfolio allocation.",
      summary: "Planned portfolio_snapshot fetch",
      targets: ["piechart"],
    }),
    gather: async () => ({
      evidence: { total: 120304 },
      sources: ["Live Portfolio Snapshot"],
      thinking: "Loaded $120,304 live balance.",
      summary: "Fetched snapshot",
    }),
    synthesize: async () => ({
      candidate: { ok: true },
      summary: "Composed pie chart",
    }),
    verify: () => ({
      ok: true,
      output: { rendered: true },
      summary: "Verified piechart node",
    }),
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(streamed.map((s) => s.stage), ["plan", "fetch", "compose", "verify"]);
  assert.equal(streamed[0].thinking, "User requested pie chart of portfolio allocation.");
});

test("Clarification resolution handles terse replies ('1', 'second one', 'stocks') and ignores topic shifts", () => {
  const pending = {
    turnId: "t_clarify",
    originalPrompt: "as bubble chart",
    question: "What would you like shown?",
    choices: [
      { id: "portfolio_pie", label: "Portfolio allocation as a Pie Chart", prompt: "Show my portfolio allocation as a pie chart" },
      { id: "holdings_bar", label: "Stock holdings by value as a Bar Chart", prompt: "Show my stock holdings as a bar chart" },
      { id: "portfolio_table", label: "Portfolio & balances as a Comparison Table", prompt: "Show my portfolio summary as a comparison table" },
    ],
  };

  assert.equal(resolveClarificationReply("1", pending)?.matchedPrompt, "Show my portfolio allocation as a pie chart");
  assert.equal(resolveClarificationReply("second one", pending)?.matchedPrompt, "Show my stock holdings as a bar chart");
  assert.equal(resolveClarificationReply("just stocks", pending)?.matchedPrompt, "Show my stock holdings as a bar chart");
  assert.equal(resolveClarificationReply("table please", pending)?.matchedPrompt, "Show my portfolio summary as a comparison table");
  assert.equal(resolveClarificationReply("How do I update my mailing address?", pending), null);
});

test("CEP end-to-end: clarification reply '1' resolves paused clarification and /context exposes thread state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-clarify-ctx-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);
  const chat = await client.conversation();

  // Turn 1: Ambiguous visual request pauses with clarifying question
  const t1 = (await client.ask(chat.id, "as bubble chart")).turn;
  assert.equal(t1.status, "completed");
  const c1 = t1.experience?.blocks.find((b) => b.component === "PznDynamicCanvas");
  assert.ok(c1 && c1.component === "PznDynamicCanvas");
  assert.equal(c1.props.title, "Quick clarification");

  // Inspect /context -> pendingClarification is live!
  const ctx1 = await client.request<{ pendingClarification: { choices: unknown[] } | null; completedTurnCount: number }>(
    `/api/conversations/${chat.id}/context`,
  );
  assert.equal(ctx1.completedTurnCount, 1);
  assert.ok(ctx1.pendingClarification && ctx1.pendingClarification.choices.length >= 3);

  // Turn 2: User replies tersely with "1" -> resolves to Portfolio Bubble Chart!
  const t2 = (await client.ask(chat.id, "1")).turn;
  assert.equal(t2.status, "completed");
  const c2 = t2.experience?.blocks.find((b) => b.component === "PznDynamicCanvas");
  assert.ok(c2 && c2.component === "PznDynamicCanvas");
  assert.ok(c2.props.nodes.some((n) => n.type === "bubblechart"), "expected bubblechart after replying '1'");
  assert.ok((t2.harnessStages?.length ?? 0) >= 3, "expected live harnessStages recorded on TurnView");
});

test("Concurrent turns in same thread AND cross-thread status answers in chat + /api/threads/status", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-concurrent-threads-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);

  // Thread A: submit TWO messages back-to-back without waiting for the first turn to finish!
  const threadA = await client.conversation();
  await client.request(`/api/conversations/${threadA.id}/settings`, { operation: "rename", title: "Portfolio Analysis" });
  const firstAccepted = await client.submit(threadA.id, "Show my portfolio summary.");
  const secondAccepted = await client.submit(threadA.id, "Show my portfolio as a pie chart");
  assert.notEqual(firstAccepted.turnId, secondAccepted.turnId);

  const [firstDone, secondDone] = await Promise.all([client.wait(firstAccepted), client.wait(secondAccepted)]);
  assert.equal(firstDone.turn.status, "completed");
  assert.equal(secondDone.turn.status, "completed");

  // Thread B: ask chat for the live status of other threads!
  const threadB = await client.conversation();
  await client.request(`/api/conversations/${threadB.id}/settings`, { operation: "rename", title: "Status Check" });
  const statusTurn = (await client.ask(threadB.id, "What is the status of my other threads?")).turn;
  assert.equal(statusTurn.status, "completed");
  const statusCard = statusTurn.experience?.blocks.find((b) => b.component === "PznDynamicCanvas");
  assert.ok(statusCard && statusCard.component === "PznDynamicCanvas");
  assert.equal(statusCard.props.badge, "Live Thread Monitor");
  assert.match(JSON.stringify(statusCard.props.nodes), /Portfolio Analysis/);
  assert.ok(statusCard.props.harnessTrace?.stages.some((s) => s.stage === "fetch"));

  // Direct API endpoint /api/threads/status matches
  const apiStatus = await client.request<{ otherThreads: Array<{ title: string; totalTurns: number }> }>(
    `/api/threads/status?conversationId=${encodeURIComponent(threadB.id)}`,
  );
  assert.ok(apiStatus.otherThreads.some((row) => row.title === "Portfolio Analysis" && row.totalTurns === 2));
});

test("Conversation folders: CRUD, bootstrap, move/unfile, delete unfiles chats, and user isolation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-folders-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);
  const otherClient = await testClient(app.url);

  // 1. Create a folder and verify it appears in /api/bootstrap and /api/folders
  const created = await client.request<{ folder: { id: string; name: string; domainId: string } }>("/api/folders", {
    name: "Tax Planning",
    domainId: "wealth",
  }, 201);
  assert.equal(created.folder.name, "Tax Planning");
  assert.equal(created.folder.domainId, "wealth");

  const boot = await client.request<{ folders?: Array<{ id: string; name: string }>; defaultPersonaId: string; defaultScenarioId: string }>(
    "/api/bootstrap?domain=wealth",
  );
  assert.ok(boot.folders?.some((f) => f.id === created.folder.id && f.name === "Tax Planning"));

  // 2. Create a conversation directly inside the folder
  const inFolder = await client.request<{ id: string; folderId?: string }>("/api/conversations", {
    personaId: boot.defaultPersonaId,
    scenarioId: boot.defaultScenarioId,
    domainId: "wealth",
    folderId: created.folder.id,
  }, 201);
  assert.equal(inFolder.folderId, created.folder.id);

  // 3. Create an unfiled conversation, then move it into the folder, then unfile it
  const unfiled = await client.conversation();
  assert.equal(unfiled.folderId, undefined);
  const movedIn = await client.request<{ id: string; folderId?: string }>(`/api/conversations/${unfiled.id}/settings`, {
    operation: "move",
    folderId: created.folder.id,
  });
  assert.equal(movedIn.folderId, created.folder.id);

  const movedOut = await client.request<{ id: string; folderId?: string }>(`/api/conversations/${unfiled.id}/settings`, {
    operation: "move",
    folderId: null,
  });
  assert.equal(movedOut.folderId, undefined);

  // 4. Rename folder
  const renamed = await client.request<{ folder: { id: string; name: string } }>(`/api/folders/${created.folder.id}/rename`, {
    name: "Taxes & Year-End",
  });
  assert.equal(renamed.folder.name, "Taxes & Year-End");

  // 5. Cross-user isolation: another user cannot rename, delete, or move into this folder
  const otherChat = await otherClient.conversation();
  await otherClient.request(`/api/folders/${created.folder.id}/rename`, { name: "Hijacked" }, 404);
  await otherClient.request(`/api/folders/${created.folder.id}/delete`, {}, 404);
  await otherClient.request(`/api/conversations/${otherChat.id}/settings`, { operation: "move", folderId: created.folder.id }, 404);

  // 6. Delete folder -> folder is removed, conversation inside it is kept and cleanly unfiled
  const del = await client.request<{ deleted: boolean; id: string }>(`/api/folders/${created.folder.id}/delete`, {});
  assert.equal(del.deleted, true);

  const afterBoot = await client.request<{ folders?: Array<{ id: string }>; conversations: Array<{ id: string; folderId?: string }> }>(
    "/api/bootstrap?domain=wealth",
  );
  assert.equal(afterBoot.folders?.some((f) => f.id === created.folder.id), false);
  const surviving = afterBoot.conversations.find((c) => c.id === inFolder.id);
  assert.ok(surviving, "conversation inside deleted folder should still exist");
  assert.equal(surviving.folderId, undefined, "conversation inside deleted folder should be unfiled");
});

test("Multi-goal creator, native bubble chart, on-demand compaction, and recent-turns live replay API", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-goals-compact-replay-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, operatorAuth: "off" });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);
  const chat = await client.conversation();

  // 1. "I want to set up another goal" opens the interactive goal_creator card
  const goalTurn = (await client.ask(chat.id, "I want to set up another goal")).turn;
  assert.equal(goalTurn.status, "completed");
  const goalCard = goalTurn.experience?.blocks.find((b) => b.component === "PznDynamicCanvas");
  assert.ok(goalCard && goalCard.component === "PznDynamicCanvas");
  assert.ok(goalCard.props.nodes.some((n) => n.type === "goal_creator"), "expected goal_creator node");

  // 2. Goal CRUD API persists goals through governed write
  const createdGoal = await client.request<{ goal: { id: string; name: string }; goals: Array<{ id: string; name: string }>; auditId?: string }>(
    "/api/goals",
    { personaId: "demo-learner", name: "College 529 Fund", category: "education", targetCents: 8_000_000, savedCents: 1_200_000, monthlyContributionCents: 65_000 },
    201,
  );
  assert.equal(createdGoal.goal.name, "College 529 Fund");
  assert.ok(createdGoal.goals.some((g) => g.id === createdGoal.goal.id));
  assert.ok(createdGoal.auditId, "expected write audit receipt");

  const updatedGoal = await client.request<{ goal: { id: string; savedCents: number } }>(
    `/api/goals/${createdGoal.goal.id}/update`,
    { personaId: "demo-learner", savedCents: 1_500_000 },
  );
  assert.equal(updatedGoal.goal.savedCents, 1_500_000);

  // 3. Native bubble chart in chat
  const bubbleTurn = (await client.ask(chat.id, "Show my stock holdings as a bubble chart")).turn;
  assert.equal(bubbleTurn.status, "completed");
  const bubbleCard = bubbleTurn.experience?.blocks.find((b) => b.component === "PznDynamicCanvas");
  assert.ok(bubbleCard && bubbleCard.component === "PznDynamicCanvas");
  assert.ok(bubbleCard.props.nodes.some((n) => n.type === "bubblechart"), "expected native bubblechart node");

  // 4. Add a 3rd turn, then check context health metrics & trigger on-demand compaction!
  await client.ask(chat.id, "Show my portfolio allocation as a pie chart");
  const ctxBefore = await client.request<{ completedTurnCount: number; estimatedContextTokens: number; tokenBudget: number; utilizationPct: number }>(
    `/api/conversations/${chat.id}/context`,
  );
  assert.equal(ctxBefore.completedTurnCount, 3);
  assert.ok(ctxBefore.estimatedContextTokens > 0);
  assert.equal(ctxBefore.tokenBudget, 24_000);

  const compacted = await client.request<{ compacted: boolean; context: { rollingSummary: { coveredThroughOrdinal: number } | null; rollingSummaryText: string | null } }>(
    `/api/conversations/${chat.id}/compact`,
    {},
  );
  assert.equal(compacted.compacted, true);
  assert.ok(compacted.context.rollingSummary && compacted.context.rollingSummary.coveredThroughOrdinal >= 1);
  assert.ok(compacted.context.rollingSummaryText && compacted.context.rollingSummaryText.length > 10);

  // 5. /api/admin/recent-turns exposes recorded turns for Live Turn Replay
  const recent = await client.request<{ turns: Array<{ turnId: string; mode: string; message: string }> }>("/api/admin/recent-turns");
  assert.ok(recent.turns.length >= 3);
  assert.ok(recent.turns.some((row) => row.turnId === bubbleTurn.id && row.mode === "harness"));

  // 6. Delete custom goal cleans up cleanly
  const deletedGoal = await client.request<{ deleted: boolean; goals: Array<{ id: string }> }>(
    `/api/goals/${createdGoal.goal.id}/delete`,
    { personaId: "demo-learner" },
  );
  assert.equal(deletedGoal.deleted, true);
  assert.equal(deletedGoal.goals.some((g) => g.id === createdGoal.goal.id), false);
});

test("Chat Workspace & Folder Superpowers: shared folder instructions, cross-thread folder brief, and message branching", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-folder-superpowers-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);
  const boot = await client.request<{ defaultPersonaId: string; defaultScenarioId: string }>("/api/bootstrap?domain=wealth");

  // 1. Create folder with shared project instructions & update instructions
  const folderRes = await client.request<{ folder: { id: string; name: string; instructions?: string } }>("/api/folders", {
    name: "Home 2027",
    domainId: "wealth",
    instructions: "Target budget $650k; keep $40k liquid cash buffer.",
  }, 201);
  assert.equal(folderRes.folder.instructions, "Target budget $650k; keep $40k liquid cash buffer.");

  const updatedFolder = await client.request<{ folder: { id: string; name: string; instructions?: string } }>(
    `/api/folders/${folderRes.folder.id}/update`,
    { instructions: "Target budget $700k for 2027 home purchase; prefer conservative cash buffer." },
  );
  assert.match(updatedFolder.folder.instructions ?? "", /\$700k/);

  // 2. Create a conversation inside the folder and run 2 turns
  const thread1 = await client.request<{ id: string; folderId?: string }>("/api/conversations", {
    personaId: boot.defaultPersonaId,
    scenarioId: boot.defaultScenarioId,
    domainId: "wealth",
    folderId: folderRes.folder.id,
  }, 201);
  const turn1 = (await client.ask(thread1.id, "Show my portfolio allocation as a pie chart")).turn;
  const turn2 = (await client.ask(thread1.id, "Show my stock holdings as a bubble chart")).turn;
  assert.equal(turn1.status, "completed");
  assert.equal(turn2.status, "completed");

  // 3. Branch/fork from turn1 -> new thread stays in the same folder and has exactly 1 cloned turn!
  const forked = await client.request<{ id: string; folderId?: string; forkedFrom?: { conversationId: string; turnId?: string }; turns: Array<{ id: string; message: string }> }>(
    `/api/conversations/${thread1.id}/fork`,
    { turnId: turn1.id, title: "What-if Pie Branch" },
    201,
  );
  assert.equal(forked.folderId, folderRes.folder.id);
  assert.equal(forked.forkedFrom?.conversationId, thread1.id);
  assert.equal(forked.forkedFrom?.turnId, turn1.id);
  assert.equal(forked.turns.length, 1);
  assert.equal(forked.turns[0]!.message, "Show my portfolio allocation as a pie chart");

  // Forked thread can immediately continue chatting with its cloned sfield history!
  const branchFollowUp = (await client.ask(forked.id, "as bar chart")).turn;
  assert.equal(branchFollowUp.status, "completed");

  // 4. Folder summary API returns both threads inside the folder
  const summaryApi = await client.request<{ folder: { name: string }; threadCount: number; threads: Array<{ conversationId: string; completedTurns: number }> }>(
    `/api/folders/${folderRes.folder.id}/summary`,
  );
  assert.equal(summaryApi.folder.name, "Home 2027");
  assert.equal(summaryApi.threadCount, 2);

  // 5. Asking chat to "Summarize all threads in my Home 2027 folder" renders a Folder Project Brief card!
  const briefTurn = (await client.ask(thread1.id, "Summarize all threads in my Home 2027 folder")).turn;
  assert.equal(briefTurn.status, "completed");
  const briefCard = briefTurn.experience?.blocks.find((b) => b.component === "PznDynamicCanvas");
  assert.ok(briefCard && briefCard.component === "PznDynamicCanvas");
  assert.equal(briefCard.props.badge, "Folder Brief");
  assert.match(JSON.stringify(briefCard.props.nodes), /\$700k/);
  assert.match(JSON.stringify(briefCard.props.nodes), /What-if Pie Branch/);
});

test("All Dynamic Canvas recommendations come strictly from Recommendation Providers (never hardcoded sell Apple)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-rec-provider-only-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);
  const chat = await client.conversation();

  // Ask to view stock holdings -> must NOT show hardcoded "I want to sell 40% of my Apple shares"
  const holdingsTurn = (await client.ask(chat.id, "Show all my stocks")).turn;
  assert.equal(holdingsTurn.status, "completed");
  const card = holdingsTurn.experience?.blocks.find((b) => b.component === "PznDynamicCanvas");
  assert.ok(card && card.component === "PznDynamicCanvas");
  assert.doesNotMatch(card.props.suggestedFollowUp ?? "", /sell 40% of my Apple/i, "must never hardcode selling Apple");
  if (card.props.suggestedFollowUp) {
    assert.ok(card.props.recommendationSource, "any recommendation CTA must carry recommendationSource from a provider");
    assert.ok(holdingsTurn.providerArbitration?.providers.length, "provider arbitration trace must be recorded");
  }
});

test("Contextual personalization, empathetic job-loss support, and industry sector drill-down", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-personalize-empathy-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);

  // 1. Standard portfolio summary greets the customer by first name ("Hi Alice") instead of cold "Here's your summary."
  const chat1 = await client.conversation();
  const portTurn = (await client.ask(chat1.id, "Show my portfolio summary.")).turn;
  assert.equal(portTurn.status, "completed");
  assert.match(portTurn.experience?.intro ?? "", /\bAlice\b/i, "expected customer first name in intro");
  assert.notEqual(portTurn.experience?.intro, "Here’s your summary.");

  // 2. "I want to see drill down based on industry" renders grounded Industry & Sector Drill-Down card
  const drillTurn = (await client.ask(chat1.id, "i want to see drill down based on industry")).turn;
  assert.equal(drillTurn.status, "completed");
  const drillCard = drillTurn.experience?.blocks.find((b) => b.component === "PznDynamicCanvas");
  assert.ok(drillCard && drillCard.component === "PznDynamicCanvas");
  assert.equal(drillCard.props.badge, "Industry Drill-Down");
  assert.ok(drillCard.props.nodes.some((n) => n.type === "piechart"), "expected industry piechart");
  assert.ok(drillCard.props.nodes.some((n) => n.type === "table"), "expected industry breakdown table");
  assert.match(drillTurn.experience?.intro ?? "", /\bAlice\b/i);

  // 3. Standalone job loss -> warm empathy + first name + grounded Cash Runway & First-30-Days checklist!
  const chat2 = await client.conversation();
  const jobLossTurn = (await client.ask(chat2.id, "I just lost my job, what should I do?")).turn;
  assert.equal(jobLossTurn.status, "completed");
  assert.match(jobLossTurn.experience?.intro ?? "", /sorry to hear.*Alice/i, "expected empathetic job-loss opener with customer name");
  const supportCard = jobLossTurn.experience?.blocks.find((b) => b.component === "PznDynamicCanvas");
  assert.ok(supportCard && supportCard.component === "PznDynamicCanvas");
  assert.equal(supportCard.props.badge, "Life Event Support");
  assert.ok(supportCard.props.nodes.some((n) => n.type === "checklist"), "expected First-30-Days checklist");
});
