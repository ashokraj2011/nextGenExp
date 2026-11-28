import assert from "node:assert/strict";
import test from "node:test";
import type { PinnedLiveCard } from "../packages/contracts/pinned-cards";
import { buildSurface } from "../packages/experience/compile";
import { testClient } from "./client";
import { startTestPreview } from "./preview";

test("Pinned live cards: clip UI from chat permanently to Main Menu, persist in SQLite, refresh live via sfield/smass, and unpin", async (t) => {
  const app = await startTestPreview();
  t.after(() => app.close());
  const client = await testClient(app.url);

  // 1. Clip a Wealth Portfolio Snapshot card with stale numbers
  const stalePortfolio = buildSurface(
    {
      status: "ready",
      outcome: "ready",
      intro: "Here is your portfolio snapshot.",
      question: null,
      partial: false,
      expiresAt: Date.now() + 60_000,
    },
    [
      {
        component: "PznPortfolioSnapshot",
        props: {
          fixtureVersion: "stale-v0",
          asOf: "2020-01-01T00:00:00.000Z",
          currency: "USD",
          cashCents: 100,
          equityCents: 200,
          fixedIncomeCents: 300,
        },
      },
    ],
    [],
  ).display;

  const pinned = await client.request<{ card: PinnedLiveCard; cards: PinnedLiveCard[] }>(
    "/api/pinned-cards",
    {
      domainId: "wealth",
      personaId: "demo-learner",
      title: "Alice Portfolio Snapshot",
      prompt: "Let me know my portfolio summary.",
      sourceTurnId: "turn_test_1",
      experience: stalePortfolio,
    },
    201,
  );
  assert.ok(pinned.card.id.startsWith("pin_"));
  assert.equal(pinned.card.liveBacked, true);
  assert.ok(pinned.card.toolRefs.includes("portfolio.snapshot.read@1.0.0"));

  // 2. Listing with ?live=1 automatically rehydrates the card with LIVE portfolio figures!
  const listed = await client.request<{ cards: PinnedLiveCard[] }>(
    "/api/pinned-cards?domain=wealth&personaId=demo-learner&live=1",
  );
  assert.equal(listed.cards.length, 1);
  const liveBlock = listed.cards[0].experience.blocks[0];
  assert.equal(liveBlock.component, "PznPortfolioSnapshot");
  assert.notEqual(liveBlock.props.cashCents, 100, "Expected live portfolio refresh to replace stale cashCents");
  assert.ok(liveBlock.props.equityCents > 200, "Expected live portfolio equityCents from provider");

  // 3. Clip an IT Ops Dynamic Canvas card and verify live refresh against opsStore
  const opsCanvas = buildSurface(
    {
      status: "ready",
      outcome: "ready",
      intro: "Active P1 Incident",
      question: null,
      partial: false,
      expiresAt: Date.now() + 60_000,
    },
    [
      {
        component: "PznDynamicCanvas",
        props: {
          title: "P1 Incident Triage",
          badge: "IT Ops SRE",
          dataSource: "Live Incident Store",
          generatedBy: "synthesizer",
          disclaimer: "Live telemetry",
          nodes: [
            {
              type: "metrics",
              items: [
                { label: "Error Rate", value: "99.9%" },
                { label: "Status", value: "stale-status" },
              ],
            },
          ],
        },
      },
    ],
    [],
  ).display;

  const pinnedOps = await client.request<{ card: PinnedLiveCard }>(
    "/api/pinned-cards",
    {
      domainId: "it_ops",
      title: "Active P1 Telemetry",
      prompt: "Build an IT incident triage dashboard for our active P1 alert",
      experience: opsCanvas,
    },
    201,
  );
  assert.ok(pinnedOps.card.toolRefs.includes("ops.incident.read@1.0.0"));

  const refreshedOps = await client.request<{ card: PinnedLiveCard }>(
    `/api/pinned-cards/${pinnedOps.card.id}/refresh`,
    { domainId: "it_ops" },
  );
  const opsBlock = refreshedOps.card.experience.blocks[0];
  assert.equal(opsBlock.component, "PznDynamicCanvas");
  const metricsNode = opsBlock.props.nodes[0];
  assert.equal(metricsNode.type, "metrics");
  assert.notEqual(metricsNode.items[0].value, "99.9%", "Expected live incident error rate");
  assert.notEqual(metricsNode.items[1].value, "stale-status", "Expected live incident status");

  // 4. Unpinning removes the card cleanly from the Main Menu
  const deleted = await client.request<{ deleted: boolean; cards: PinnedLiveCard[] }>(
    `/api/pinned-cards/${pinned.card.id}/delete`,
    { domainId: "wealth", personaId: "demo-learner" },
  );
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.cards.length, 0);
});
