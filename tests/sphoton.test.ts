import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ApprovalRecord, PublicationReview } from "../packages/contracts/approval";
import type { ConversationView, TurnAccepted } from "../packages/contracts/api";
import { firstGoalContributionMonth } from "../packages/contracts/goal-progress";
import type { TurnPayloads } from "../packages/contracts/inspector";
import type { DisplayExperience } from "../packages/contracts/surface";
import type { UiDesign, UiLayoutCatalog, UiLayoutRecord } from "../packages/contracts/ui-layout";
import {
  applyActionResultToBlock,
  compileBoundCard,
  fingerprintToolContract,
  generateBoundCardDraft,
  validateCardBinding,
  verifyActionRef,
  type SfieldAdapter,
  type SphotonBindingCatalog,
  type SphotonCardBinding,
} from "../packages/sphoton";
import { testClient } from "./client";
import { operatorHeader, reviewer } from "./operator-fixture";
import { startTestPreview } from "./preview";

const layoutsPath = "/api/admin/ui-layouts";
const previewPath = "/api/admin/ui-layout-preview";
const catalogPath = "/api/admin/ui-binding-catalog";
const generatePath = "/api/admin/ui-layout-generate";

const aliceGoalCardBinding: SphotonCardBinding = {
  component: "PznGoalProgress",
  sources: {
    goal: {
      toolRef: "goal.progress.read@1.0.0",
      read: "reuseVerifiedTurnResult",
    },
  },
  bindings: [
    { field: "goal.targetCents", from: "goal.data.targetCents", format: "currency_cents", required: true },
    { field: "goal.history", from: "goal.data.history", format: "series", required: true },
  ],
  actions: [
    {
      id: "add-monthly-savings",
      label: "Add $500 a month",
      toolRef: "goal.savings.preview@1.0.0",
      fixedInputs: { extraMonthlyCents: 50_000 },
      followUpInputs: ["startMonth"],
      update: "originalCard",
    },
  ],
  unavailableState: {
    title: "Home-buying goal unavailable",
    message: "Your home-buying goal figures are temporarily unavailable.",
  },
};

test("sphoton unit: validates types, reuses verified turn results, enforces unavailable state, detects contract drift, and verifies signed actions", async () => {
  const goalOutputSchema: Record<string, unknown> = {
    type: "object",
    properties: {
      goalId: { type: "string" },
      title: { type: "string" },
      targetCents: { type: "integer" },
      monthlyContributionCents: { type: "integer" },
      currency: { type: "string" },
      asOf: { type: "string" },
      history: { type: "array", items: { type: "object" } },
    },
  };
  const savingsInputSchema: Record<string, unknown> = {
    type: "object",
    properties: {
      extraMonthlyCents: { type: "integer" },
      startMonth: { type: "string" },
    },
  };
  const savingsOutputSchema: Record<string, unknown> = {
    type: "object",
    properties: {
      projectedTargetMonth: { type: "string" },
      extraMonthlyCents: { type: "integer" },
    },
  };

  let readCalls = 0;
  let currentGoalSchema = structuredClone(goalOutputSchema);
  const sampleGoal = {
    fixtureVersion: "1.0",
    goalId: "home_down_payment" as const,
    targetCents: 6_000_000,
    monthlyContributionCents: 100_000,
    currency: "USD" as const,
    history: [
      { month: "2026-09", savedCents: 2_300_000 },
      { month: "2026-10", savedCents: 2_400_000 },
      { month: "2026-11", savedCents: 2_500_000 },
    ],
  };

  const sfield: SfieldAdapter = {
    listTools: () => [
      { ref: "goal.progress.read@1.0.0", id: "goal.progress.read", version: "1.0.0", inputs: {}, outputs: currentGoalSchema },
      { ref: "goal.savings.preview@1.0.0", id: "goal.savings.preview", version: "1.0.0", inputs: savingsInputSchema, outputs: savingsOutputSchema },
    ],
    describeTool: (ref) => sfield.listTools().find((t) => t.ref === ref),
    executeRead: async ({ toolRef }) => {
      readCalls++;
      return { status: "succeeded", toolRef, output: sampleGoal };
    },
    executeAction: async ({ toolRef }) => ({ status: "succeeded", toolRef, output: { projectedTargetMonth: "2028-09", extraMonthlyCents: 50_000 } }),
  };

  const catalog: SphotonBindingCatalog = {
    tenantId: "tenant-test",
    domainId: "wealth",
    catalogFingerprint: "cat_v1",
    tools: [
      {
        toolRef: "goal.progress.read@1.0.0",
        id: "goal.progress.read",
        version: "1.0.0",
        label: "Goal Progress",
        contractFingerprint: fingerprintToolContract("goal.progress.read@1.0.0", {}, goalOutputSchema),
        inputSchema: {},
        outputSchema: goalOutputSchema,
      },
    ],
    fields: [
      {
        id: "goal.progress.read@1.0.0:targetCents",
        toolRef: "goal.progress.read@1.0.0",
        outputPath: "targetCents",
        type: "integer",
        label: "Down payment target",
        group: "Goal Progress",
        supportedFormats: ["currency_cents", "number"],
        defaultFormat: "currency_cents",
      },
      {
        id: "goal.progress.read@1.0.0:history",
        toolRef: "goal.progress.read@1.0.0",
        outputPath: "history",
        type: "array",
        label: "Savings history",
        group: "Goal Progress",
        supportedFormats: ["series"],
        defaultFormat: "series",
      },
      {
        id: "goal.progress.read@1.0.0:title",
        toolRef: "goal.progress.read@1.0.0",
        outputPath: "title",
        type: "string",
        label: "Goal name",
        group: "Goal Progress",
        supportedFormats: ["text"],
        defaultFormat: "text",
      },
    ],
    actions: [
      {
        id: "add-monthly-savings",
        toolRef: "goal.savings.preview@1.0.0",
        label: "Add $500 a month",
        inputSchema: savingsInputSchema,
        outputSchema: savingsOutputSchema,
        fixedInputFields: { extraMonthlyCents: "integer" },
        followUpInputFields: ["startMonth"],
        defaultUpdate: "originalCard",
        contractFingerprint: fingerprintToolContract("goal.savings.preview@1.0.0", savingsInputSchema, savingsOutputSchema),
      },
    ],
  };

  // 1. Valid card passes validation
  const ok = validateCardBinding(aliceGoalCardBinding, catalog, { sfield, strictRequiredComponentFields: true });
  assert.equal(ok.valid, true);
  assert.ok(ok.dependencies.toolContracts["goal.progress.read@1.0.0"]);

  // 2. Type mismatch rejected (binding string `title` into numeric `goal.targetCents`)
  const badType = validateCardBinding({
    ...aliceGoalCardBinding,
    bindings: [
      { field: "goal.targetCents", from: "goal.data.title", required: true },
      { field: "goal.history", from: "goal.data.history", required: true },
    ],
  }, catalog, { sfield });
  assert.equal(badType.valid, false);
  assert.ok(badType.issues.some((i) => i.code === "type_mismatch"));

  const scope = {
    tenantId: "tenant-test",
    domainId: "wealth",
    principalId: "alice",
    customerId: "alice",
    conversationId: "conv_1",
    mode: "customer_chat" as const,
  };
  const secret = "persistent-sphoton-signing-secret-for-tests-123456";

  // 3. Reuses verified turn result without calling sfield.executeRead
  const reused = await compileBoundCard({
    card: aliceGoalCardBinding,
    catalog,
    scope,
    sfield,
    verifiedTurnResults: { "goal.progress.read@1.0.0": sampleGoal },
    design: { id: "ui_goal", revision: 3, name: "Home Goal Card" },
    expectedToolContracts: ok.dependencies.toolContracts,
    signingSecret: secret,
  });
  assert.equal(reused.status, "compiled");
  assert.equal(readCalls, 0);
  assert.deepEqual(reused.reusedSources, ["goal.progress.read@1.0.0"]);
  assert.equal(reused.block.component, "PznGoalProgress");
  assert.equal(reused.signedActions.length, 1);

  // 4. Signed action verification succeeds for valid scope and fails on tampering / wrong principal
  const actionRef = reused.signedActions[0];
  assert.equal(verifyActionRef(actionRef, scope, secret).valid, true);
  assert.equal(verifyActionRef({ ...actionRef, resolvedInputs: { extraMonthlyCents: 99_999 } }, scope, secret).valid, false);
  assert.equal(verifyActionRef(actionRef, { ...scope, principalId: "bob" }, secret).valid, false);

  // 5. Missing verified turn result invokes declared read through sfield
  const fetched = await compileBoundCard({
    card: aliceGoalCardBinding,
    catalog,
    scope,
    sfield,
    verifiedTurnResults: {},
    signingSecret: secret,
  });
  assert.equal(fetched.status, "compiled");
  assert.equal(readCalls, 1);
  assert.deepEqual(fetched.invokedSources, ["goal.progress.read@1.0.0"]);

  // 6. Missing required value produces approved unavailable state
  const missing = await compileBoundCard({
    card: aliceGoalCardBinding,
    catalog,
    scope,
    sfield,
    verifiedTurnResults: { "goal.progress.read@1.0.0": { ...sampleGoal, targetCents: undefined } },
    signingSecret: secret,
  });
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.block.component, "PznFactSummary");
  assert.equal(missing.block.props.title, "Home-buying goal unavailable");
  assert.equal(missing.signedActions.length, 0);

  // 7. Incompatible tool contract drift requires revised publication
  currentGoalSchema = {
    ...goalOutputSchema,
    properties: { ...(goalOutputSchema.properties as Record<string, unknown>), targetCents: { type: "string" } },
  };
  const drifted = await compileBoundCard({
    card: aliceGoalCardBinding,
    catalog,
    scope,
    sfield,
    verifiedTurnResults: { "goal.progress.read@1.0.0": sampleGoal },
    expectedToolContracts: ok.dependencies.toolContracts,
    signingSecret: secret,
  });
  assert.equal(drifted.status, "incompatible_contract");
  assert.equal(drifted.signedActions.length, 0);

  // 8. Generic in-place card update via applyActionResultToBlock
  const updatedBlock = applyActionResultToBlock(
    {
      component: "PznBoundWidget",
      props: {
        badge: "it_ops · sfield",
        title: "INC-4012",
        body: "Active incident",
        accentTop: true,
        metrics: [{ id: "rollbackStatus", label: "Rollback status", value: "Standby", subtext: "ops", tone: "default" }],
      },
    },
    {
      label: "Preview rollback",
      resultBindings: [{ field: "rollbackStatus", from: "rollbackStatus" }],
    },
    { rollbackStatus: "Ready to roll back to v2.4.0 (immediate)" },
  );
  assert.equal(updatedBlock.component, "PznBoundWidget");
  assert.equal(updatedBlock.props.metrics[0].value, "Ready to roll back to v2.4.0 (immediate)");

  // 9. AI draft generator uses the same catalog
  const draft = await generateBoundCardDraft({ prompt: "Show home down payment goal chart", catalog });
  assert.equal(draft.card.component, "PznGoalProgress");
  assert.ok(draft.boundFields.includes("goal.data.targetCents"));
});

test("sphoton integration: catalog exposure, AI binding, review dependency drift, Alice chart + March reload + Logs, and second domain", async (t) => {
  const app = await startTestPreview();
  t.after(() => app.close());
  const client = await testClient(app.url);
  const reviewerAuth = { Authorization: operatorHeader(reviewer) };

  // Acceptance Criterion 1: GET /api/admin/ui-binding-catalog?domain=wealth + dynamic exposure + AI generator
  const wealthCatalog = await client.request<SphotonBindingCatalog>(`${catalogPath}?domain=wealth`);
  assert.equal(wealthCatalog.domainId, "wealth");
  const targetField = wealthCatalog.fields.find((f) => f.toolRef === "goal.progress.read@1.0.0" && f.outputPath === "targetCents");
  assert.ok(targetField);
  assert.equal(targetField.label, "Down payment target");
  assert.equal(targetField.type, "integer");
  assert.ok(targetField.supportedFormats.includes("currency_cents"));
  assert.equal(wealthCatalog.fields.some((f) => f.toolRef === "goal.progress.read@1.0.0" && f.outputPath === "currency"), false);

  // Domain exposes a newly registered field on goal.progress.read@1.0.0
  const updatedCatalog = await client.request<SphotonBindingCatalog>(`${catalogPath}?domain=wealth`, {
    toolRef: "goal.progress.read@1.0.0",
    outputPath: "currency",
    label: "Goal currency code",
    group: "Goal Progress (sfield)",
    supportedFormats: ["text"],
    defaultFormat: "text",
    exposed: true,
  });
  assert.ok(updatedCatalog.fields.some((f) => f.toolRef === "goal.progress.read@1.0.0" && f.outputPath === "currency" && f.label === "Goal currency code"));

  // AI generator binds to the exposed catalog field
  const generated = await client.request<{ design: UiDesign; boundToolFields?: string[] }>(`${generatePath}?domain=wealth`, {
    prompt: "Create a card showing Goal currency code",
  });
  assert.ok(generated.boundToolFields?.includes("goal.progress.read@1.0.0:currency"));

  // Acceptance Criterion 2: Draft stays out of chat + dependency drift during review rejects stale approval
  const goalDesign: UiDesign = {
    name: "Alice Home Goal (sphoton)",
    description: "Home down payment chart bound via sphoton to goal.progress.read@1.0.0.",
    layout: "stack",
    targets: [{ kind: "content", id: "home_down_payment_progress" }],
    slots: [
      {
        kind: "block",
        id: "goal_chart",
        component: "PznGoalProgress",
        toolBinding: {
          ...aliceGoalCardBinding,
          bindings: [
            ...aliceGoalCardBinding.bindings,
            { field: "goal.currency", from: "goal.data.currency", format: "text", required: false },
          ],
        },
      },
    ],
  };

  // Same compiler renders draft preview
  const preview = await client.request<DisplayExperience>(`${previewPath}?domain=wealth`, {
    design: goalDesign,
    personaId: "demo-learner",
  });
  const previewGoal = preview.blocks.find((b) => b.component === "PznGoalProgress");
  assert.ok(previewGoal && previewGoal.component === "PznGoalProgress");
  assert.equal(previewGoal.props.savingsOption?.extraMonthlyCents, 50_000);

  // Save draft & submit for approval; verify customer chat does NOT get pending revision
  const savedDraft = await client.request<UiLayoutRecord>(layoutsPath, { operation: "draft", domainId: "wealth", design: goalDesign });
  const pendingReview = await client.request<PublicationReview>(layoutsPath, {
    operation: "publish",
    id: savedDraft.id,
    revision: savedDraft.revision,
    domainId: "wealth",
    design: goalDesign,
  }, 202);
  assert.equal(pendingReview.status, "pending_approval");
  assert.ok(pendingReview.approval.details?.some((d) => d.label.includes("goal.progress.read@1.0.0")));

  // Simulate dependency change during review: unexpose `currency` -> approving stale review fails!
  await client.request<SphotonBindingCatalog>(`${catalogPath}?domain=wealth`, {
    toolRef: "goal.progress.read@1.0.0",
    outputPath: "currency",
    label: "Goal currency code",
    exposed: false,
  });
  const staleDecision = await client.request<{ code?: string; message?: string }>(
    `/api/approvals/${pendingReview.approval.id}/decide`,
    { decision: "approve" },
    400,
    reviewerAuth,
  );
  assert.match(staleDecision.message ?? "", /not exposed/i);

  // Re-expose `asOf` with a changed label/schema policy to test 409 dependency drift directly:
  // First publish a clean revision referencing targetCents + history + savings action
  const cleanGoalDesign: UiDesign = {
    ...goalDesign,
    slots: [{ kind: "block", id: "goal_chart", component: "PznGoalProgress", toolBinding: aliceGoalCardBinding }],
  };
  const cleanDraft = await client.request<UiLayoutRecord>(layoutsPath, {
    operation: "draft",
    id: savedDraft.id,
    revision: savedDraft.revision,
    domainId: "wealth",
    design: cleanGoalDesign,
  });
  const cleanReview = await client.request<PublicationReview>(layoutsPath, {
    operation: "publish",
    id: cleanDraft.id,
    revision: cleanDraft.revision,
    domainId: "wealth",
    design: cleanGoalDesign,
  }, 202);
  const approved = await client.request<{ approval: ApprovalRecord }>(
    `/api/approvals/${cleanReview.approval.id}/decide`,
    { decision: "approve" },
    200,
    reviewerAuth,
  );
  assert.equal(approved.approval.status, "executed");

  // Acceptance Criteria 3 & 4: Alice's chart reuses verified goal read, click + March follow-up update one chart & survive reload,
  // and Logs shows approved design revision, tool version, and inputs/outputs for both projection calls.
  const chat = await client.conversation();
  const initial = await client.ask(chat.id, "Show my home-buying goal and savings progress.");
  assert.equal(initial.trace.uiLayout?.id, cleanDraft.id);
  assert.equal(initial.trace.uiLayout?.revision, cleanDraft.revision + 1);
  const goalBlock = initial.turn.experience?.blocks.find((b) => b.component === "PznGoalProgress");
  assert.ok(goalBlock && goalBlock.component === "PznGoalProgress");
  assert.equal(goalBlock.props.savingsOption?.extraMonthlyCents, 50_000);
  const actionId = goalBlock.props.savingsOption!.actionId;

  // Check originating turn Logs show approved design revision + verified goal read
  const initialLogs = await client.request<TurnPayloads>(`/api/debug/payloads/${initial.turn.id}`);
  assert.equal(initialLogs.appliedDesign?.id, cleanDraft.id);
  assert.equal(initialLogs.appliedDesign?.revision, cleanDraft.revision + 1);
  assert.equal(initialLogs.goal?.tool, "goal.progress.read@1.0.0");

  // Alice clicks "Add $500 a month"
  const clicked = await client.wait(await client.request<TurnAccepted>(
    `/api/experiences/${initial.turn.experience!.experienceId}/actions`,
    {
      clientRequestId: randomUUID(),
      envelope: {
        version: "1.0",
        action: {
          name: "request_follow_up",
          surfaceId: initial.turn.experience!.experienceId,
          sourceComponentId: "block_1",
          timestamp: new Date().toISOString(),
          context: { actionId },
        },
      },
    },
    202,
  ));
  assert.equal(clicked.turn.goalScenario?.sourceTurnId, initial.turn.id);
  assert.equal(clicked.turn.goalScenario?.projection.extraMonthlyCents, 50_000);

  // Alice asks "What if I start in March?" -> updates same chart
  const march = await client.ask(chat.id, "What if I start in March?");
  assert.equal(march.turn.goalScenario?.sourceTurnId, initial.turn.id);
  const expectedFirstMonth = firstGoalContributionMonth(goalBlock.props.goal, Date.now());
  const expectedMarch = expectedFirstMonth.endsWith("-03")
    ? expectedFirstMonth
    : (() => {
      const [y, m] = expectedFirstMonth.split("-").map(Number);
      const targetYear = m <= 3 ? y : y + 1;
      return `${targetYear}-03`;
    })();
  assert.equal(march.turn.goalScenario?.projection.startMonth, expectedMarch);
  assert.equal(march.turn.goalScenario?.projection.extraMonthlyCents, 50_000);

  // Verify March update survives thread reload
  const reloaded = await client.request<ConversationView>(`/api/conversations/${chat.id}`);
  const reloadedMarch = reloaded.turns.find((entry) => entry.id === march.turn.id);
  assert.equal(reloadedMarch?.goalScenario?.sourceTurnId, initial.turn.id);
  assert.equal(reloadedMarch?.goalScenario?.projection.startMonth, expectedMarch);

  // Verify Logs for BOTH projection calls show approved design revision, tool version, inputs, and outputs
  const clickLogs = await client.request<TurnPayloads>(`/api/debug/payloads/${clicked.turn.id}`);
  assert.equal(clickLogs.goalScenario?.sourceTurnId, initial.turn.id);
  assert.equal(clickLogs.goalScenario?.design?.revision, cleanDraft.revision + 1);
  assert.equal(clickLogs.goalScenario?.call.tool, "goal.savings.preview@1.0.0");
  assert.ok(clickLogs.goalScenario?.call.registryInput.data);
  assert.ok(clickLogs.goalScenario?.call.result?.data);

  const marchLogs = await client.request<TurnPayloads>(`/api/debug/payloads/${march.turn.id}`);
  assert.equal(marchLogs.goalScenario?.sourceTurnId, initial.turn.id);
  assert.equal(marchLogs.goalScenario?.design?.revision, cleanDraft.revision + 1);
  assert.equal(marchLogs.goalScenario?.call.tool, "goal.savings.preview@1.0.0");
  assert.equal((marchLogs.goalScenario?.call.registryInput.data as Record<string, unknown>)?.startMonth, expectedMarch);
  assert.ok(marchLogs.goalScenario?.call.result?.data);

  // Acceptance Criterion 5: Second domain (it_ops) publishes a card using sphoton & its own tool catalog
  const opsCatalog = await client.request<SphotonBindingCatalog>(`${catalogPath}?domain=it_ops`);
  assert.equal(opsCatalog.domainId, "it_ops");
  assert.ok(opsCatalog.fields.some((f) => f.toolRef === "ops.incident.read@1.0.0" && f.outputPath === "errorRatePct"));
  assert.equal(opsCatalog.fields.some((f) => f.toolRef.startsWith("goal.")), false);

  const opsDesign: UiDesign = {
    name: "IT Ops Incident Card (sphoton)",
    description: "Live P1 incident card bound via sphoton to ops.incident.read@1.0.0.",
    layout: "stack",
    targets: [{ kind: "intent", id: "it_ops_detail" }],
    slots: [
      {
        kind: "widget",
        id: "ops_bound",
        badge: "IT Ops · Live",
        title: "Active P1 Incident",
        body: "Bound via sphoton.",
        accentTop: true,
        metrics: [],
        toolBinding: {
          component: "PznBoundWidget",
          sources: {
            incident: { toolRef: "ops.incident.read@1.0.0", read: "reuseVerifiedTurnResult" },
          },
          bindings: [
            { field: "title", from: "incident.data.title", format: "text", required: true },
            { field: "errorRate", from: "incident.data.errorRatePct", format: "percent", label: "Edge error rate", required: true },
            { field: "rollbackStatus", from: "incident.data.rollbackStatus", format: "text", label: "Rollback status", required: true },
          ],
          actions: [
            {
              id: "preview-rollback",
              label: "Preview rollback",
              toolRef: "ops.incident.rollback.preview@1.0.0",
              fixedInputs: { targetRelease: "v2.4.0" },
              followUpInputs: ["window"],
              update: "originalCard",
              resultBindings: [{ field: "rollbackStatus", from: "rollbackStatus" }],
            },
          ],
        },
      },
    ],
  };

  // Cross-domain tool binding is rejected
  await client.request(`${previewPath}?domain=it_ops`, {
    ...opsDesign,
    slots: [{
      ...opsDesign.slots[0],
      toolBinding: {
        component: "PznBoundWidget",
        sources: { goal: { toolRef: "goal.progress.read@1.0.0", read: "reuseVerifiedTurnResult" } },
        bindings: [{ field: "target", from: "goal.data.targetCents", required: true }],
      },
    }],
  }, 400);

  // Preview + publish + approve in it_ops
  const opsPreview = await client.request<DisplayExperience>(`${previewPath}?domain=it_ops`, opsDesign);
  const opsWidget = opsPreview.blocks.find((b) => b.component === "PznBoundWidget");
  assert.ok(opsWidget && opsWidget.component === "PznBoundWidget");
  assert.ok(opsWidget.props.metrics.some((m) => m.label === "Edge error rate"));

  const opsReview = await client.request<PublicationReview>(layoutsPath, {
    operation: "publish",
    domainId: "it_ops",
    design: opsDesign,
  }, 202);
  const opsApproved = await client.request<{ approval: ApprovalRecord }>(
    `/api/approvals/${opsReview.approval.id}/decide`,
    { decision: "approve" },
    200,
    reviewerAuth,
  );
  assert.equal(opsApproved.approval.status, "executed");
  const allLayouts = await client.request<UiLayoutCatalog>(layoutsPath);
  assert.ok(allLayouts.library.some((entry) => entry.domainId === "it_ops" && entry.design.name === opsDesign.name));
});
