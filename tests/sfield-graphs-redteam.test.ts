import assert from "node:assert/strict";
import test from "node:test";
import {
  createPrincipal,
  defineGraph,
  defineTool,
  GRAPH_END,
  SField,
} from "@sfield/core";
import { startStudioServer } from "@sfield/studio";

test("@sfield/core defineGraph & sf.graphs: parallel fan-out, conditional edges, governed tools, HITL interrupt/resume, tenant isolation, and Time-Travel fork/replay", async () => {
  const quoteTool = defineTool({
    id: "market.quote.read",
    version: "1.0.0",
    description: "Read current ticker price.",
    inputs: {
      type: "object",
      additionalProperties: false,
      required: ["symbol"],
      properties: { symbol: { type: "string" } },
    },
    outputs: {
      type: "object",
      additionalProperties: false,
      required: ["symbol", "priceUsd"],
      properties: { symbol: { type: "string" }, priceUsd: { type: "number" } },
    },
    policy: { effect: "read", classification: "public" },
    handler: async ({ symbol }) => ({ symbol: String(symbol), priceUsd: 210 }),
  });

  const sf = await SField.create({
    config: { version: 1, models: {}, agents: {} },
    preset: "memory",
    authorizer: { authorize: async () => ({ decision: "allow" as const, evidenceId: "ev_graph", expiresAt: new Date(Date.now() + 60_000).toISOString() }) },
    tools: [quoteTool],
  });

  type OrderState = {
    symbol: string;
    shares: number;
    priceUsd?: number;
    notionalUsd?: number;
    riskChecked?: boolean;
    complianceChecked?: boolean;
    approved?: boolean;
    summary?: string;
  };

  const orderGraph = defineGraph<OrderState>({
    id: "wealth.order.review",
    version: "1.0.0",
    entry: "price_lookup",
    nodes: {
      price_lookup: {
        preset: "read_only",
        handler: async (state, ctx) => {
          const res = await ctx.callTool("market.quote.read@1.0.0", { symbol: state.symbol });
          assert.equal(res.status, "succeeded");
          const priceUsd = Number((res.output as { priceUsd: number }).priceUsd);
          return { priceUsd, notionalUsd: priceUsd * state.shares };
        },
      },
      checks: {
        kind: "parallel",
        branches: ["risk_check", "compliance_check"],
      },
      risk_check: {
        preset: "read_only",
        handler: async () => ({ riskChecked: true }),
      },
      compliance_check: {
        preset: "read_only",
        handler: async () => ({ complianceChecked: true }),
      },
      hitl_gate: {
        preset: "supervised",
        handler: async (state, ctx) => {
          if (ctx.resumeValue && (ctx.resumeValue as { approved?: boolean }).approved) {
            return { approved: true };
          }
          return ctx.interrupt(`Order notional $${state.notionalUsd} requires approval`, { notionalUsd: state.notionalUsd });
        },
      },
      complete: {
        preset: "read_only",
        handler: async (state) => ({
          summary: `${state.shares} ${state.symbol} ($${state.notionalUsd}) -> ${state.approved ? "HITL approved" : "auto-cleared"}`,
        }),
      },
    },
    edges: {
      price_lookup: "checks",
      hitl_gate: "complete",
      complete: GRAPH_END,
    },
    conditionalEdges: {
      checks: (state) => ((state.notionalUsd ?? 0) >= 10_000 ? "hitl_gate" : "complete"),
    },
  });

  const alice = createPrincipal({ tenantId: "tenant-a", subjectId: "alice" });
  const bob = createPrincipal({ tenantId: "tenant-b", subjectId: "bob" });

  try {
    // 1. Run high-value order -> executes governed tool, parallel checks, and pauses at hitl_gate
    const run = await sf.graphs.run({
      graph: orderGraph,
      principal: alice,
      initialState: { symbol: "AAPL", shares: 100 }, // $21,000 -> triggers hitl_gate
    });
    assert.equal(run.status, "interrupted");
    assert.equal(run.interrupt?.nodeId, "hitl_gate");
    assert.equal(run.state.priceUsd, 210);
    assert.equal(run.state.riskChecked, true);
    assert.equal(run.state.complianceChecked, true);
    assert.equal(run.checkpoints.length, 3);
    assert.equal(run.checkpoints[0].toolCalls[0].toolRef, "market.quote.read@1.0.0");

    // 2. Cross-tenant resume & fork are blocked
    await assert.rejects(
      () => sf.graphs.resume({ runId: run.runId, principal: bob, resumeValue: { approved: true } }),
      /another tenant/,
    );
    await assert.rejects(
      () => sf.graphs.forkAndReplay({ runId: run.runId, checkpointId: run.checkpoints[0].checkpointId, principal: bob }),
      /another tenant/,
    );

    // 3. Time-Travel Fork & Replay from checkpoint #0 with smaller share count (10 shares = $2,100 -> auto-clears!)
    const forked = await sf.graphs.forkAndReplay<OrderState>({
      runId: run.runId,
      checkpointId: run.checkpoints[0].checkpointId,
      principal: alice,
      stateOverride: { shares: 10 },
    });
    assert.equal(forked.status, "completed");
    assert.equal(forked.parentRunId, run.runId);
    assert.equal(forked.forkedFromCheckpointId, run.checkpoints[0].checkpointId);
    assert.equal(forked.state.notionalUsd, 2100);
    assert.match(forked.state.summary ?? "", /auto-cleared/);

    // Original run is still interrupted and untouched
    assert.equal(sf.graphs.getRun(run.runId)?.status, "interrupted");

    // 4. Resume original run with HITL approval
    const resumed = await sf.graphs.resume<OrderState>({
      runId: run.runId,
      principal: alice,
      resumeValue: { approved: true },
    });
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.state.approved, true);
    assert.match(resumed.state.summary ?? "", /HITL approved/);
  } finally {
    await sf.close();
  }
});

test("@sfield/studio exposes Graphs & Time-Travel API and 1-Click 5/5 Red-Team Security Proof Suite", async () => {
  const sf = await SField.create({
    config: { version: 1, models: {}, agents: {} },
    preset: "memory",
  });
  const studio = await startStudioServer({ runtime: sf, port: 0 });
  try {
    // 1. HTML includes both new tabs
    const html = await (await fetch(studio.url)).text();
    assert.match(html, /Graphs & Time-Travel/);
    assert.match(html, /Red-Team Proofs/);

    // 2. Run Studio demo graph ($25,000 -> interrupts at hitl_review)
    const demoRes = await fetch(`${studio.url}/api/graphs/demo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountUsd: 25000 }),
    });
    assert.equal(demoRes.status, 201);
    const { run } = await demoRes.json() as {
      run: { runId: string; status: string; checkpoints: Array<{ checkpointId: string; nodeId: string }> };
    };
    assert.equal(run.status, "interrupted");
    assert.equal(run.checkpoints[0].nodeId, "assess_risk");

    // 3. Time-Travel fork from checkpoint #0 with amountUsd: 5000 -> auto-clears
    const forkRes = await fetch(`${studio.url}/api/graphs/runs/${encodeURIComponent(run.runId)}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checkpointId: run.checkpoints[0].checkpointId, stateOverride: { amountUsd: 5000 } }),
    });
    assert.equal(forkRes.status, 201);
    const forked = await forkRes.json() as { run: { status: string; state: { decision?: string } } };
    assert.equal(forked.run.status, "completed");
    assert.match(forked.run.state.decision ?? "", /Auto-cleared/);

    // 4. Resume original interrupted run
    const resumeRes = await fetch(`${studio.url}/api/graphs/runs/${encodeURIComponent(run.runId)}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resumeValue: { approved: true } }),
    });
    assert.equal(resumeRes.status, 200);
    const resumed = await resumeRes.json() as { run: { status: string; state: { decision?: string } } };
    assert.equal(resumed.run.status, "completed");
    assert.match(resumed.run.state.decision ?? "", /HITL verified/);

    // 5. 1-Click Red-Team Security Proof Suite (all 5/5 attacks blocked)
    const rtRes = await fetch(`${studio.url}/api/redteam/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(rtRes.status, 200);
    const rt = await rtRes.json() as { passed: number; total: number; allPassed: boolean; proofs: Array<{ id: string; passed: boolean }> };
    assert.equal(rt.total, 5);
    assert.equal(rt.passed, 5);
    assert.equal(rt.allPassed, true);
  } finally {
    await studio.close();
    await sf.close();
  }
});
