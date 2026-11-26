import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "./operator-fixture";
import { testClient, testProject } from "./client";
import { startFixtureGateway } from "./gateway-fixture";
import type { HandoffTicket } from "../packages/contracts/handoff";
import type { AgentDelegationPass, NegotiationSession, Watchcard } from "../packages/contracts/nextgen-chat";
import { generateDynamicUi } from "../apps/server/dynamic-ui-generator";

test("#1 Multiplayer Live Glass Co-Browse: SSE slider sync, Advisor-Proposed card, and customer cryptographic sign-off", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-ng-1-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, inspectorEnabled: true });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);

  // 1. Customer opens warm handoff.
  const createRes = await fetch(`${app.url}/api/handoffs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: "conv_cb_1", personaId: "demo-learner", domain: "wealth", reason: "Review home savings plan live" }),
  });
  assert.equal(createRes.status, 201);
  const { ticket } = (await createRes.json()) as { ticket: HandoffTicket };

  // 2. Customer opens SSE stream, then advisor drags sliders -> SSE receives instant handoff.update!
  const ac = new AbortController();
  const streamRes = await fetch(`${app.url}/api/handoffs/${ticket.handoffId}/stream`, { signal: ac.signal });
  assert.equal(streamRes.status, 200);
  const reader = streamRes.body!.getReader();
  const decoder = new TextDecoder();

  const firstChunk = decoder.decode((await reader.read()).value);
  assert.match(firstChunk, /event: handoff\.update/);

  // Advisor drags sliders via co-browse endpoint.
  await client.request(`/api/handoffs/${ticket.handoffId}/cobrowse`, {
    updatedBy: "advisor",
    sliders: { monthlyContributionUsd: 2400, horizonMonths: 36, equityAllocationPct: 70 },
  });
  const secondChunk = decoder.decode((await reader.read()).value);
  assert.match(secondChunk, /"monthlyContributionUsd":2400/);
  assert.match(secondChunk, /"horizonMonths":36/);
  ac.abort();

  // 3. Advisor pushes Advisor-Proposed action card.
  const propRes = await client.request<{ ticket: HandoffTicket }>("/api/admin/handoffs/propose", {
    handoffId: ticket.handoffId,
    title: "Raise Down-Payment Target to $120,000",
    summary: "Agreed during live co-browse session.",
    updates: { "goal.target": "120000" },
  });
  assert.equal(propRes.ticket.coBrowse?.proposal?.status, "pending");

  // 4. Customer reviews & signs the Advisor-Proposed card -> writes governed audit entry.
  const signRes = await fetch(`${app.url}/api/handoffs/${ticket.handoffId}/proposal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "accepted" }),
  });
  assert.equal(signRes.status, 200);
  const signed = (await signRes.json()) as { ticket: HandoffTicket; auditId?: string };
  assert.equal(signed.ticket.coBrowse?.proposal?.status, "accepted");
  assert.ok(signed.auditId, "governed auditId recorded on signature");

  // 5. Advisor shares an exact A2UI card live -> discovered via /api/handoffs/active & streamed over SSE to both views.
  const activeRes = await fetch(`${app.url}/api/handoffs/active?personaId=demo-learner`);
  assert.equal(activeRes.status, 200);
  const activeBody = (await activeRes.json()) as { ticket: HandoffTicket | null };
  assert.equal(activeBody.ticket?.handoffId, ticket.handoffId);

  const shareRes = await fetch(`${app.url}/api/handoffs/${ticket.handoffId}/share-card`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      turnId: "turn_adv_1",
      prompt: "Let me know my portfolio summary.",
      sharedBy: "advisor",
      sharedByName: "Priya Sharma, CFP®",
      experience: { experienceId: "exp_shared_1", status: "ready", intro: "Here is your synced portfolio summary.", blocks: [], actions: [] },
    }),
  });
  assert.equal(shareRes.status, 200);
  const shared = (await shareRes.json()) as { ticket: HandoffTicket };
  assert.equal(shared.ticket.coBrowse?.sharedCard?.sharedByName, "Priya Sharma, CFP®");
  assert.equal((shared.ticket.coBrowse?.sharedCard?.experience as { experienceId?: string })?.experienceId, "exp_shared_1");
});

test("#2 Parallel Futures Simulator + #4 Expertise Mode persistence in sfield Memory", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-ng-24-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, inspectorEnabled: true });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);

  // #2 Commit Scenario B -> produces SHA-256 digest-bound approval + audit receipt.
  const commitRes = await fetch(`${app.url}/api/chat/commit-scenario`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scenarioName: "Scenario B · Accelerated Growth",
      personaId: "demo-learner",
      monthlyDepositUsd: 2100,
      horizonMonths: 24,
      expectedReturnPct: 7.5,
      equityAllocationPct: 75,
      targetGoalUsd: 110_000,
      projectedEndingUsd: 108_420,
    }),
  });
  assert.equal(commitRes.status, 201, await commitRes.clone().text());
  const committed = (await commitRes.json()) as { committed: boolean; approvalId: string; auditId: string; payloadDigest: string };
  assert.equal(committed.committed, true);
  assert.match(committed.approvalId, /^apr_/);
  assert.ok(committed.auditId);
  assert.ok(committed.payloadDigest.length >= 16);

  // #4 Expertise Morph Dial persists preference into sfield MemoryService.
  const saved = await client.request<{ item: { id: string; content: string } }>(
    "/api/memory",
    { kind: "preference", key: "ui_expertise_mode", content: "Preferred chat complexity dial: pro" },
    201,
  );
  assert.match(saved.item.content, /pro/);
});

test("#3 Living Threads Autonomous Watchcards: create, simulate live trigger, and 1-tap governed execute", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-ng-3-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, inspectorEnabled: true });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });

  // 1. Create a Living Watchcard.
  const createRes = await fetch(`${app.url}/api/watchcards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId: "conv_watch_1",
      personaId: "demo-learner",
      title: "High-Yield Cash Sweep Sentinel",
      metric: "cash_balance",
      operator: "gte",
      thresholdUsd: 25_000,
      actionSummary: "Stage a $5,000 sweep into Treasury Money Market",
    }),
  });
  assert.equal(createRes.status, 201);
  const { watchcard } = (await createRes.json()) as { watchcard: Watchcard };
  assert.equal(watchcard.status, "watching");

  // 2. Simulate condition crossing threshold -> stages real approval & transitions to triggered.
  const trigRes = await fetch(`${app.url}/api/watchcards/${watchcard.id}/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(trigRes.status, 200);
  const triggered = (await trigRes.json()) as { watchcard: Watchcard };
  assert.equal(triggered.watchcard.status, "triggered");
  assert.match(triggered.watchcard.approvalId ?? "", /^apr_/);

  // 3. Customer 1-tap Approve & Execute -> transitions to executed with auditId.
  const execRes = await fetch(`${app.url}/api/watchcards/${watchcard.id}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(execRes.status, 200);
  const executed = (await execRes.json()) as { watchcard: Watchcard; auditId: string };
  assert.equal(executed.watchcard.status, "executed");
  assert.ok(executed.auditId);
});

test("#6 Consumer A2A Delegated Negotiation: scoped pass, live A2A/MCP negotiation, sfield HITL pause, customer sign-off, and revocation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-ng-6-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, inspectorEnabled: true });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });

  // 1. Mint scoped Delegation Pass with $5,000 autonomous cap.
  const mintRes = await fetch(`${app.url}/api/agent-delegation/pass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      personaId: "demo-learner",
      agentName: "Personal Claude",
      allowedScopes: ["read_balances", "search_policies", "stage_drafts", "request_actions"],
      maxTransactionUsd: 5_000,
      expiresInHours: 24,
    }),
  });
  assert.equal(mintRes.status, 201);
  const { pass } = (await mintRes.json()) as { pass: AgentDelegationPass };
  assert.equal(pass.status, "active");

  // 2. Run negotiation exceeding cap ($8,500 > $5,000) -> discovers A2A card, runs live MCP RAG check, pauses at sfield HITL!
  const negRes = await fetch(`${app.url}/api/agent-delegation/negotiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      passId: pass.passId,
      goal: "Negotiate an $8,500 home deposit transfer and verify wash-sale & wire policy compliance",
      requestedAmountUsd: 8_500,
    }),
  });
  assert.equal(negRes.status, 202);
  const { session } = (await negRes.json()) as { session: NegotiationSession };
  assert.equal(session.status, "paused_for_approval");
  assert.match(session.approvalId ?? "", /^apr_/);
  assert.ok(session.transcript.some((m) => m.protocol === "A2A"));
  assert.ok(session.transcript.some((m) => m.protocol === "MCP"));
  assert.ok(session.transcript.some((m) => m.protocol === "sfield-HITL"));

  // 3. Customer approves paused negotiation -> completed + audited.
  const approveRes = await fetch(`${app.url}/api/agent-delegation/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: session.sessionId }),
  });
  assert.equal(approveRes.status, 200);
  const approved = (await approveRes.json()) as { session: NegotiationSession };
  assert.equal(approved.session.status, "completed");
  assert.ok(approved.session.auditId);

  // 4. Revoke pass -> subsequent negotiation is immediately denied by sfield_guard!
  await fetch(`${app.url}/api/agent-delegation/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passId: pass.passId }),
  });
  const deniedRes = await fetch(`${app.url}/api/agent-delegation/negotiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passId: pass.passId, goal: "Try another transfer", requestedAmountUsd: 1000 }),
  });
  const denied = (await deniedRes.json()) as { session: NegotiationSession };
  assert.equal(denied.session.status, "denied");
});

test("Grounded Dynamic UI: generates live comparison table & 3-point summary from Customer 360 while guarding unconnected external sources", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-dyn-ui-"));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  // 1. Comparison table for portfolio summary (exact prompt sent by 'As table' button)
  const tableOut = await generateDynamicUi({
    prompt: 'Show your last answer about "Let me know my portfolio summary." as a clear comparison table.',
    personaId: "demo-learner",
    dataDir: dir,
    recentContext: JSON.stringify({ message: "Let me know my portfolio summary.", reply: "Here's your summary." }),
  });
  assert.notEqual(tableOut.canvas.title, "Data source needed");
  assert.ok(tableOut.canvas.nodes.some((n) => n.type === "table"), "expected dynamic table node");
  assert.ok(tableOut.canvas.nodes.some((n) => n.type === "metrics"), "expected metrics node");
  assert.match(tableOut.canvas.dataSource ?? "", /Customer 360/i);

  // 2. 3-bullet summary ('Summarize' button)
  const summaryOut = await generateDynamicUi({
    prompt: 'Summarize your last answer about "Let me know my portfolio summary." in 3 bullet points.',
    personaId: "demo-learner",
    dataDir: dir,
  });
  assert.ok(summaryOut.canvas.nodes.some((n) => n.type === "checklist"), "expected checklist summary node");

  // 3. Unconnected external data source still honestly asks for a data source
  const jiraOut = await generateDynamicUi({
    prompt: "Show all my Jira tickets as a table",
    personaId: "demo-learner",
    dataDir: dir,
  });
  assert.equal(jiraOut.canvas.title, "Data source needed");
});
