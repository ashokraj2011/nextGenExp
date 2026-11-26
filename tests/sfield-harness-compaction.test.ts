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

  // Turn 2: User replies tersely with "1" -> resolves to Portfolio Pie Chart!
  const t2 = (await client.ask(chat.id, "1")).turn;
  assert.equal(t2.status, "completed");
  const c2 = t2.experience?.blocks.find((b) => b.component === "PznDynamicCanvas");
  assert.ok(c2 && c2.component === "PznDynamicCanvas");
  assert.ok(c2.props.nodes.some((n) => n.type === "piechart"), "expected piechart after replying '1'");
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
