import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperienceComposerEngine } from "../apps/server/experience-composer";
import { startTestPreview } from "./preview";

test("ExperienceComposerEngine arbitrates 5 UI classes across subject areas and channel budgets, promotes NBA after task completion, and syncs dismissals", async () => {
  const engine = new ExperienceComposerEngine("composer-test-secret");
  const bootstrap = engine.getBootstrap();
  assert.equal(bootstrap.subjectAreas.length, 3);
  assert.equal(bootstrap.channels.length, 4);
  assert.equal(bootstrap.experiences.length, 4);

  // 1. On AI Chat Turn (companion budget = 1), Task outranks NBA for Wealth Portfolio Summary
  const chatView = await engine.compose({ experienceId: "wealth-portfolio-summary", channel: "chat_turn" });
  assert.equal(chatView.dataAggCalls, 1);
  assert.equal(chatView.zones.main.uiClass, "main");
  assert.equal(chatView.zones.tasks.length, 1);
  assert.equal(chatView.zones.nba.length, 0);
  assert.equal(chatView.suppressed.length, 1);
  assert.equal(chatView.suppressed[0]?.id, "nba_invest_excess_cash");
  assert.equal(chatView.zones.chrome.followUps.length, 3);
  assert.equal(chatView.zones.chrome.disclosures.length, 1);

  // 2. On Web Portal Dashboard (companion budget = 4), BOTH Task and NBA render simultaneously from the SAME smass snapshot
  const webView = await engine.compose({ experienceId: "wealth-portfolio-summary", channel: "web_dashboard" });
  assert.equal(webView.zones.tasks.length, 1);
  assert.equal(webView.zones.nba.length, 1);
  assert.equal(webView.zones.nba[0]?.snapshotId, webView.snapshotId);

  // 3. On Mobile Compact, follow-ups clamp to 1 and Task outranks NBA
  const mobileView = await engine.compose({ experienceId: "banking-cashflow-summary", channel: "mobile_compact" });
  assert.equal(mobileView.subjectArea, "banking");
  assert.equal(mobileView.zones.tasks.length, 1);
  assert.equal(mobileView.zones.nba.length, 0);
  assert.equal(mobileView.zones.chrome.followUps.length, 1);

  // 4. Signed sfield action execution works & forged tokens are rejected
  const validToken = chatView.zones.tasks[0]!.signedActionToken;
  const forged = await engine.executeAction({
    experienceId: "wealth-portfolio-summary",
    channel: "chat_turn",
    signedActionToken: validToken.slice(0, -4) + "ZZZZ",
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.status, 403);

  const executed = await engine.executeAction({
    experienceId: "wealth-portfolio-summary",
    channel: "chat_turn",
    signedActionToken: validToken,
  });
  assert.equal(executed.ok, true);
  assert.equal(executed.execution.steps.length, 3);

  // 5. Completing the Task emits revision 2, clears the Task live, and PROMOTES the waiting NBA into the freed AI Chat slot!
  const afterComplete = await engine.completeTaskEvent({
    experienceId: "wealth-portfolio-summary",
    channel: "chat_turn",
  });
  assert.equal(afterComplete.revision, 2);
  assert.equal(afterComplete.zones.tasks.length, 0);
  assert.equal(afterComplete.zones.nba.length, 1);
  assert.equal(afterComplete.zones.nba[0]?.id, "nba_invest_excess_cash");
  assert.ok(afterComplete.arbitrationLog.some((entry) => entry.outcome === "promoted"));

  // 6. Dismissing the NBA suppresses it across EVERY channel (AI Chat, Web Portal, Mobile, Advisor)
  const afterDismiss = await engine.dismissNba({
    experienceId: "wealth-portfolio-summary",
    channel: "chat_turn",
    nbaId: "nba_invest_excess_cash",
  });
  assert.equal(afterDismiss.zones.nba.length, 0);
  const advisorAfterDismiss = await engine.compose({
    experienceId: "wealth-portfolio-summary",
    channel: "advisor_desktop",
  });
  assert.equal(advisorAfterDismiss.zones.nba.length, 0);
  assert.ok(advisorAfterDismiss.suppressed.some((s) => s.id === "nba_invest_excess_cash"));
});

test("HTTP /api/experience-composer/* composes Retirement 401(k) across channels and executes workflows", async (t) => {
  const server = await startTestPreview();
  t.after(() => server.close());

  const composeRes = await fetch(`${server.url}/api/experience-composer/compose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ experienceId: "retirement-readiness", channel: "advisor_desktop" }),
  });
  assert.equal(composeRes.status, 200);
  const data = (await composeRes.json()) as {
    composed: {
      subjectArea: string;
      zones: { tasks: Array<{ signedActionToken: string }>; nba: Array<{ id: string }> };
    };
  };
  assert.equal(data.composed.subjectArea, "retirement");
  assert.equal(data.composed.zones.tasks.length, 1);
  assert.equal(data.composed.zones.nba[0]?.id, "nba_capture_employer_match");

  const completeRes = await fetch(`${server.url}/api/experience-composer/complete-task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ experienceId: "retirement-readiness", channel: "mobile_compact" }),
  });
  assert.equal(completeRes.status, 200);
  const refreshed = (await completeRes.json()) as {
    composed: { revision: number; zones: { tasks: unknown[]; nba: Array<{ id: string }> } };
  };
  assert.equal(refreshed.composed.revision, 2);
  assert.equal(refreshed.composed.zones.tasks.length, 0);
  assert.equal(refreshed.composed.zones.nba[0]?.id, "nba_capture_employer_match");

  // Create a custom Subject Area (compiles live smass model), custom Experience, and custom Channel Budget
  const subRes = await fetch(`${server.url}/api/experience-composer/create-subject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label: "Insurance & Protection",
      tagline: "Policies & renewals",
      smassModelId: "insurance_policy_360",
      channel: "chat_turn",
    }),
  });
  assert.equal(subRes.status, 201);
  const subData = (await subRes.json()) as {
    subjectArea: { id: string; smassModelId: string };
    bootstrap: { smassGraphs: Record<string, { entities: Array<{ id: string }> }> };
    composed: { subjectArea: string; zones: { tasks: unknown[]; nba: unknown[] } };
  };
  assert.equal(subData.subjectArea.smassModelId, "insurance_policy_360");
  assert.equal(subData.bootstrap.smassGraphs[subData.subjectArea.id]?.entities[0]?.id, "insurance_policy_360");
  assert.equal(subData.composed.zones.tasks.length, 1);

  const chRes = await fetch(`${server.url}/api/experience-composer/create-channel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label: "Watch Glance",
      shortLabel: "Watch",
      frameMode: "mobile",
      maxTasks: 0,
      maxNba: 0,
      maxCompanionTotal: 0,
      maxFollowUps: 0,
      experienceId: "wealth-portfolio-summary",
    }),
  });
  assert.equal(chRes.status, 201);
  const chData = (await chRes.json()) as {
    composed: { zones: { main: { title: string }; tasks: unknown[]; nba: unknown[]; chrome: { followUps: unknown[]; disclosures: unknown[] } } };
  };
  assert.equal(chData.composed.zones.main.title, "Portfolio summary");
  assert.equal(chData.composed.zones.tasks.length, 0);
  assert.equal(chData.composed.zones.nba.length, 0);
  assert.equal(chData.composed.zones.chrome.followUps.length, 0);
  assert.equal(chData.composed.zones.chrome.disclosures.length, 1); // Disclosures stay immutable!

  // Test UI Binding & Runtime Resolution modes (Pinned UI Registry/Widget Studio vs Runtime PZN vs Runtime sphoton A2UI)
  const bootRes = await fetch(`${server.url}/api/experience-composer/bootstrap`);
  const boot = (await bootRes.json()) as { uiCatalog: Array<{ id: string; source: string }> };
  assert.ok(boot.uiCatalog.some((c) => c.source === "ui_registry"));
  assert.ok(boot.uiCatalog.some((c) => c.source === "widget_studio"));

  const sphotonRes = await fetch(`${server.url}/api/experience-composer/ui-binding`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      experienceId: "wealth-portfolio-summary",
      channel: "chat_turn",
      uiResolutionMode: "runtime_sphoton_generative",
    }),
  });
  assert.equal(sphotonRes.status, 200);
  const sphotonData = (await sphotonRes.json()) as {
    composed: { zones: { main: { uiResolution: { mode: string; a2uiNodes?: string[] } } } };
  };
  assert.equal(sphotonData.composed.zones.main.uiResolution.mode, "runtime_sphoton_generative");
  assert.ok((sphotonData.composed.zones.main.uiResolution.a2uiNodes?.length ?? 0) >= 3);
});

test("ExperienceComposerEngine persists custom subject areas, channels, experiences, UI bindings, and dismissals across SQLite restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sphoton-composer-sqlite-"));
  try {
    const engine1 = new ExperienceComposerEngine("persist-secret", undefined, dir);
    const createdSub = engine1.createSubjectArea({
      label: "Insurance & Protection",
      tagline: "Policies & claims",
      smassModelId: "insurance_360",
    });
    const createdCh = engine1.createChannel({
      label: "Branch Kiosk",
      shortLabel: "Kiosk",
      frameMode: "web",
      maxTasks: 2,
      maxNba: 1,
      maxCompanionTotal: 3,
      maxFollowUps: 2,
    });
    engine1.updateUiBinding({
      experienceId: createdSub.experienceId,
      uiResolutionMode: "runtime_sphoton_generative",
    });
    const preClose = await engine1.compose({ experienceId: createdSub.experienceId, channel: createdCh.id });
    assert.equal(preClose.zones.nba.length, 1);
    await engine1.dismissNba({
      experienceId: createdSub.experienceId,
      channel: createdCh.id,
      nbaId: preClose.zones.nba[0]!.id,
    });
    engine1.close();

    // Reopen fresh instance from the same SQLite directory
    const engine2 = new ExperienceComposerEngine("persist-secret", undefined, dir);
    try {
      const boot = engine2.getBootstrap();
      assert.ok(boot.subjectAreas.some((s) => s.id === createdSub.subjectArea.id && s.smassModelId === "insurance_360"));
      assert.ok(boot.channels.some((c) => c.id === createdCh.id && c.shortLabel === "Kiosk"));
      assert.ok(boot.smassGraphs[createdSub.subjectArea.id]?.entities[0]?.id === "insurance_360");

      const rehydrated = await engine2.compose({ experienceId: createdSub.experienceId, channel: createdCh.id });
      assert.equal(rehydrated.zones.main.uiResolution.mode, "runtime_sphoton_generative");
      assert.equal(rehydrated.zones.nba.length, 0);
      assert.ok(rehydrated.suppressed.some((s) => s.reason.includes("dismissed")));
    } finally {
      engine2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
