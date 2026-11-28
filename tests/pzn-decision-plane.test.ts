import test from "node:test";
import assert from "node:assert/strict";
import { PznDecisionPlane } from "../apps/server/pzn-decision-plane";
import { startTestPreview } from "./preview";

test("PznDecisionPlane enforces smass schema validation, single-snapshot reuse, shared rules, signed sfield workflows, and live revision 2 refresh", async () => {
  const plane = new PznDecisionPlane("test-pzn-secret");
  const initialState = plane.getState();

  // 1. smass closed-schema Customer 360 graph validates cleanly & rejects invalid CCRE rules
  assert.equal(initialState.smassValidationIssues, 0);
  assert.equal(initialState.smassGraph.entities[0]?.id, "customer_360");
  const badEnum = plane.updateSharedRule("first_deposit", { value: "bogus_status" });
  assert.equal(badEnum.ok, false);
  assert.match(badEnum.error, /violates smass enum/i);

  // 2. Alice balance summary & portfolio cash reuse a SINGLE smass snapshot (Zero Drift)
  const aliceBalance = await plane.evaluateDecision({ mid: "DEMO-MID-1001", context: "balance" });
  assert.equal(aliceBalance.dataAggCalls, 1);
  assert.equal(aliceBalance.snapshotReusedByResolver, true);
  assert.equal(aliceBalance.dataVersions.balanceVersion, "bal_17");
  assert.equal(aliceBalance.placements.primary?.kind, "content");
  assert.equal(aliceBalance.placements.primary.card.availableCents, 125_000);
  assert.equal(aliceBalance.placements.primary.card.currentCents, 150_000);
  assert.equal(aliceBalance.placements.nextAction, null);

  const alicePortsum = await plane.evaluateDecision({ mid: "DEMO-MID-1001", context: "portsum" });
  assert.equal(alicePortsum.dataAggCalls, 1);
  assert.equal(alicePortsum.placements.nextAction?.kind, "workflow");
  assert.equal(alicePortsum.placements.nextAction.recommendationId, "cash_above_10k");
  assert.equal(alicePortsum.placements.nextAction.enrichedFromSnapshotId, alicePortsum.snapshotId);

  // 3. Marcus address-update returns dual placement + shared first_deposit workflow
  const marcusAddr = await plane.evaluateDecision({ mid: "DEMO-MID-1003", context: "address-update" });
  assert.equal(marcusAddr.revision, 1);
  assert.equal(marcusAddr.placements.primary?.kind, "action");
  assert.equal(marcusAddr.placements.primary.id, "account.address.prepare");
  assert.equal(marcusAddr.placements.nextAction?.kind, "workflow");
  assert.equal(marcusAddr.placements.nextAction.id, "account.funding.preview");
  const validToken = marcusAddr.placements.nextAction.signedActionToken;

  // Forged & cross-member tokens are blocked by sfield
  const forged = await plane.executeSignedAction({
    decisionId: marcusAddr.decisionId,
    mid: "DEMO-MID-1003",
    signedActionToken: validToken.slice(0, -4) + "XXXX",
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.status, 403);

  const crossMember = await plane.executeSignedAction({
    decisionId: marcusAddr.decisionId,
    mid: "DEMO-MID-1001",
    signedActionToken: validToken,
  });
  assert.equal(crossMember.ok, false);
  assert.equal(crossMember.status, 403);

  // Valid signed token runs 3 deterministic sfield tools linked to decisionId
  const exec = await plane.executeSignedAction({
    decisionId: marcusAddr.decisionId,
    mid: "DEMO-MID-1003",
    signedActionToken: validToken,
  });
  assert.equal(exec.ok, true);
  assert.equal(exec.execution.steps.length, 3);
  assert.equal(exec.execution.steps[0]?.toolRef, "funding.status.read@1.0.0");
  assert.equal(exec.execution.steps[1]?.toolRef, "funding.options.read@1.0.0");
  assert.equal(exec.execution.steps[2]?.toolRef, "funding.preview.build@1.0.0");
  assert.equal(exec.execution.preview.amountCents, 25_000);

  // 4. Stale Data Agg version triggers retry_required; real funding.confirmed emits revision 2 & clears nextAction
  const stale = await plane.confirmFundingAndRefresh({
    decisionId: marcusAddr.decisionId,
    mid: "DEMO-MID-1003",
    simulateStaleVersion: true,
  });
  assert.equal(stale.ok, true);
  assert.equal(stale.status, "retry_required");

  const outcomesBefore = plane.getState().rankingMetrics.find((r) => r.contentId === "fund_account")!.verifiedOutcomes;
  const refreshed = await plane.confirmFundingAndRefresh({
    decisionId: marcusAddr.decisionId,
    mid: "DEMO-MID-1003",
  });
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.status, "refreshed");
  assert.equal(refreshed.decision.revision, 2);
  assert.equal(refreshed.decision.dataVersions.accountVersion, 42);
  assert.equal(refreshed.decision.placements.nextAction, null);
  const outcomesAfter = plane.getState().rankingMetrics.find((r) => r.contentId === "fund_account")!.verifiedOutcomes;
  assert.equal(outcomesAfter, outcomesBefore + 1);

  // 5. Shared rule edit once updates BOTH address-update and pending-actions
  plane.reset();
  const disabled = plane.updateSharedRule("first_deposit", { enabled: false });
  assert.equal(disabled.ok, true);
  const marcusAddrDisabled = await plane.evaluateDecision({ mid: "DEMO-MID-1003", context: "address-update" });
  const marcusPendingDisabled = await plane.evaluateDecision({ mid: "DEMO-MID-1003", context: "pending-actions" });
  assert.equal(marcusAddrDisabled.placements.nextAction, null);
  assert.equal(marcusPendingDisabled.placements.nextAction, null);
});

test("HTTP /api/pzn-demo/* serves interactive PZN + smass + sfield flow end to end", async (t) => {
  const server = await startTestPreview();
  t.after(() => server.close());
  const decideRes = await fetch(`${server.url}/api/pzn-demo/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mid: "DEMO-MID-1003", context: "address-update" }),
  });
  assert.equal(decideRes.status, 201);
  const decided = (await decideRes.json()) as {
    decision: { decisionId: string; revision: number; placements: { nextAction: { signedActionToken: string } } };
  };
  assert.equal(decided.decision.revision, 1);

  const execRes = await fetch(`${server.url}/api/pzn-demo/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      decisionId: decided.decision.decisionId,
      mid: "DEMO-MID-1003",
      signedActionToken: decided.decision.placements.nextAction.signedActionToken,
    }),
  });
  assert.equal(execRes.status, 200);

  const confirmRes = await fetch(`${server.url}/api/pzn-demo/confirm-funding`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decisionId: decided.decision.decisionId, mid: "DEMO-MID-1003" }),
  });
  assert.equal(confirmRes.status, 200);
  const confirmed = (await confirmRes.json()) as {
    status: string;
    decision: { revision: number; placements: { nextAction: unknown } };
  };
  assert.equal(confirmed.status, "refreshed");
  assert.equal(confirmed.decision.revision, 2);
  assert.equal(confirmed.decision.placements.nextAction, null);
});
