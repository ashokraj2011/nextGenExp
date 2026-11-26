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
import { AgenticHarness, type AuditRecord } from "@sfield/core";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { deterministicCapabilityRoute } from "../apps/server/semantic-router";

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

test("4-Stage Dynamic UI Harness: handles pie chart typos, follow-up corrections, auto-repair, and unconnected-source guards", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-dyn-ui-"));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  // 1. Typo "show the protfolio as pie chart" routes to custom_dynamic_ui and renders a real piechart with harnessTrace
  const pieRoute = deterministicCapabilityRoute("show the protfolio as pie chart");
  assert.equal(pieRoute.capabilityId, "custom_dynamic_ui");
  assert.ok(pieRoute.confidence >= 0.93);

  const pieOut = await generateDynamicUi({
    prompt: "show the protfolio as pie chart",
    personaId: "demo-learner",
    dataDir: dir,
  });
  assert.ok(pieOut.canvas.nodes.some((n) => n.type === "piechart"), "expected piechart node");
  assert.ok(pieOut.canvas.harnessTrace, "expected harnessTrace");
  assert.deepEqual(
    pieOut.canvas.harnessTrace.stages.map((s) => s.stage),
    ["plan", "fetch", "compose", "verify"],
  );

  // 2. Follow-up visual correction ("this is not a pie chart") resolves prior portfolio context instead of "Data source needed"
  const fixRoute = deterministicCapabilityRoute("this is not a pie chart");
  assert.equal(fixRoute.capabilityId, "custom_dynamic_ui");
  const fixOut = await generateDynamicUi({
    prompt: "this is not a pie chart",
    personaId: "demo-learner",
    dataDir: dir,
    recentContext: JSON.stringify({ message: "show the protfolio as pie chart", reply: "Here's your summary." }),
  });
  assert.notEqual(fixOut.canvas.title, "Data source needed");
  assert.ok(fixOut.canvas.nodes.some((n) => n.type === "piechart"), "expected piechart node on follow-up correction");

  // 3. Comparison table ('As table' button) & 3-bullet summary ('Summarize' button)
  const tableOut = await generateDynamicUi({
    prompt: 'Show your last answer about "Let me know my portfolio summary." as a clear comparison table.',
    personaId: "demo-learner",
    dataDir: dir,
    recentContext: JSON.stringify({ message: "Let me know my portfolio summary.", reply: "Here's your summary." }),
  });
  assert.notEqual(tableOut.canvas.title, "Data source needed");
  assert.ok(tableOut.canvas.nodes.some((n) => n.type === "table"), "expected dynamic table node");
  assert.ok(tableOut.canvas.nodes.some((n) => n.type === "metrics"), "expected metrics node");

  const summaryOut = await generateDynamicUi({
    prompt: 'Summarize your last answer about "Let me know my portfolio summary." in 3 bullet points.',
    personaId: "demo-learner",
    dataDir: dir,
  });
  assert.ok(summaryOut.canvas.nodes.some((n) => n.type === "checklist"), "expected checklist summary node");

  // 4. Multi-step LLM auto-repair: if Stage 3 LLM returns a barchart instead of piechart, Stage 4 catches it and repairs!
  let callCount = 0;
  const mockLlm = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      callCount += 1;
      let content = "";
      if (callCount === 1) {
        // Stage 1: Planner
        content = JSON.stringify({
          resolvedGoal: "Show Alice Morgan's live portfolio breakdown as a pie chart",
          neededSources: ["portfolio_snapshot", "customer_balances"],
          requiredVisuals: ["piechart", "metrics"],
        });
      } else if (callCount === 2) {
        // Stage 3: Composer intentionally violates contract by returning a barchart instead of piechart
        content = JSON.stringify({
          intro: "Here is your breakdown.",
          canvas: {
            title: "Portfolio Breakdown",
            badge: "Chart",
            generatedBy: "llm",
            nodes: [{ type: "barchart", bars: [{ label: "Stocks", value: 27500, displayValue: "$27,500" }, { label: "Cash", value: 12500, displayValue: "$12,500" }] }],
            disclaimer: "Grounded in Customer 360.",
          },
        });
      } else {
        // Stage 4: Repair fixes violation with a real piechart
        content = JSON.stringify({
          intro: "Here is your live portfolio as a pie chart.",
          canvas: {
            title: "Portfolio Allocation Pie Chart",
            badge: "Pie Chart",
            generatedBy: "llm",
            nodes: [{
              type: "piechart",
              title: "Allocation",
              centerLabel: "Total",
              centerValue: "$50,000",
              slices: [
                { label: "Stocks", value: 27500, displayValue: "$27,500" },
                { label: "Cash", value: 12500, displayValue: "$12,500" },
                { label: "Fixed Income", value: 10000, displayValue: "$10,000" },
              ],
            }],
            disclaimer: "Grounded in Customer 360.",
          },
        });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((resolve) => mockLlm.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => mockLlm.close(() => resolve())));
  const port = (mockLlm.address() as AddressInfo).port;

  const repairedOut = await generateDynamicUi({
    prompt: "show the protfolio as pie chart",
    personaId: "demo-learner",
    dataDir: dir,
    gateway: {
      profile: "openai",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "mock-harness",
      contextWindow: 32_000,
      maxOutputTokens: 1200,
      apiKey: "test",
    },
  });
  assert.equal(callCount, 3, "expected 3 LLM calls: plan -> compose -> repair");
  assert.ok(repairedOut.canvas.nodes.some((n) => n.type === "piechart"), "expected repaired piechart node");
  assert.equal(repairedOut.canvas.harnessTrace?.repaired, true);
  assert.ok(repairedOut.canvas.harnessTrace?.stages.some((s) => s.stage === "repair"));

  // 5. Unconnected external data source still stops cleanly at Stage 2 with zero fabricated numbers
  const jiraOut = await generateDynamicUi({
    prompt: "Show all my Jira tickets as a table",
    personaId: "demo-learner",
    dataDir: dir,
  });
  assert.equal(jiraOut.canvas.title, "Data source needed");
  assert.equal(jiraOut.canvas.harnessTrace?.stages.some((s) => s.status === "needs_data"), true);
  assert.match(jiraOut.canvas.harnessTrace?.harnessRunId ?? "", /^hrn_/);
});

test("@sfield/core AgenticHarness: works generically for non-UI workflows (clarification pause, verify->repair loop, and sfield audit persistence)", async () => {
  const audits: AuditRecord[] = [];
  const harness = new AgenticHarness({
    persistence: {
      appendAudit: async (records) => { audits.push(...records); },
    },
    configDigest: () => "sha256:test-config",
  });

  // 1. Ambiguous action pauses cleanly with needs_clarification + clickable choices
  const clarified = await harness.run({
    kind: "action_plan",
    plan: async () => ({
      status: "needs_clarification",
      resolvedGoal: "Sell shares without specified ticker or quantity",
      question: "Which stock and how many shares would you like to sell?",
      choices: [{ id: "AAPL", label: "Apple (AAPL)" }, { id: "MSFT", label: "Microsoft (MSFT)" }],
      summary: "Missing required ticker and quantity",
    }),
    gather: async () => ({ evidence: {}, sources: [], summary: "unused" }),
    synthesize: async () => ({ candidate: null }),
    verify: () => ({ ok: true, output: null }),
  });
  assert.equal(clarified.status, "needs_clarification");
  assert.equal(clarified.choices?.length, 2);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].type, "agentic_harness_completed");
  assert.equal(audits[0].data.kind, "action_plan");
  assert.equal(audits[0].data.status, "needs_clarification");

  // 2. Non-UI multi-source Q&A with citation verification & automatic repair
  const qa = await harness.run<{ query: string }, { citations: string[] }, { answer: string; citations: string[] }, { answer: string; citations: string[] }>({
    kind: "policy_rag_qa",
    maxRepairs: 1,
    plan: async () => ({
      status: "ready",
      plan: { query: "wire transfer limit" },
      resolvedGoal: "Answer wire transfer threshold with policy citation",
      summary: "Selected policy_kb source",
      targets: ["citation_required"],
    }),
    gather: async () => ({
      evidence: { citations: ["POL-WIRE-01"] },
      sources: ["policy_kb"],
      summary: "Fetched POL-WIRE-01",
    }),
    synthesize: async () => ({
      // Intentionally omits required citation so Stage 4 triggers repair
      candidate: { answer: "Wires over $25,000 require dual control.", citations: [] },
      summary: "Drafted initial answer",
    }),
    verify: (cand, _plan, ev) => {
      if (!cand.citations.some((c) => ev.citations.includes(c))) {
        return { ok: false, violations: ["Missing grounded policy citation from Stage 2 evidence."] };
      }
      return { ok: true, output: cand, summary: "Verified policy citation" };
    },
    repair: async (_plan, ev, _violations, prev) => ({
      candidate: { answer: prev.answer, citations: ev.citations },
      summary: "Added missing grounded citation POL-WIRE-01",
    }),
  });
  assert.equal(qa.status, "completed");
  assert.deepEqual(qa.output.citations, ["POL-WIRE-01"]);
  assert.equal(qa.trace.repaired, true);
  assert.equal(audits.length, 2);
  assert.equal(audits[1].data.kind, "policy_rag_qa");
  assert.equal(audits[1].data.repaired, true);
});
