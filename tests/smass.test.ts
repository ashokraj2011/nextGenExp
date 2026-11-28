import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { LOCAL_DEV_PRINCIPAL, SField } from "@sfield/core";
import {
  createSmassRegistry,
  createTurnSnapshotCache,
  defineStoreBackedModel,
  defineToolBackedModel,
  evaluateSmassComputedExpression,
  SmassSnapshotValidationError,
  type SmassModelSummary,
} from "../packages/smass";
import { testClient } from "./client";
import { startTestPreview } from "./preview";

test("smass architecture boundary: packages/smass has zero UI, sphoton, contract, or server imports", () => {
  const smassDir = join(process.cwd(), "packages/smass");
  for (const file of readdirSync(smassDir).filter((name) => name.endsWith(".ts"))) {
    const imports = readFileSync(join(smassDir, file), "utf8")
      .split("\n")
      .filter((line) => /^\s*(?:import|export)\b/.test(line))
      .join("\n");
    assert.equal(
      /\.\.\/sphoton|\.\.\/contracts\/|\.\.\/experience\/|apps\/server|apps\/web/.test(imports),
      false,
      `Unexpected UI/host import in packages/smass/${file}`,
    );
  }
});

test("smass compiles store-backed models into live closed-schema @sfield/core tools and validates tool-backed models", async () => {
  const tickets = new Map<string, { id: string; title: string; priority: string; slaMinutes: number }>([
    ["TKT-101", { id: "TKT-101", title: "Checkout timeout", priority: "P1", slaMinutes: 15 }],
  ]);

  const TicketModel = defineStoreBackedModel({
    id: "support.ticket",
    version: "1.0.0",
    domain: "support",
    label: "Support Ticket",
    primaryKey: "id",
    fields: {
      id: { type: "string", label: "Ticket ID", required: true },
      title: { type: "string", label: "Ticket title", required: true },
      priority: { type: "string", label: "Priority", required: true },
      slaMinutes: { type: "integer", label: "SLA remaining (min)", format: "number", required: true },
    },
    source: {
      read(inputs) {
        const key = typeof inputs.id === "string" ? inputs.id : "TKT-101";
        return tickets.get(key) ?? null;
      },
    },
    actions: [
      {
        id: "escalate-preview",
        toolRef: "support.ticket.escalate.preview@1.0.0",
        label: "Preview escalation",
        effect: "read",
        inputs: { id: { type: "string", required: true }, tier: { type: "string", required: true } },
        outputs: { id: { type: "string", required: true }, nextTier: { type: "string", required: true } },
        fixedInputFields: { tier: "string" },
        handler(inputs) {
          return { id: String(inputs.id), nextTier: `Escalated to ${String(inputs.tier)}` };
        },
      },
    ],
  });

  const ToolBackedSummary = defineToolBackedModel({
    id: "support.ticket_view",
    version: "1.0.0",
    domain: "support",
    label: "Ticket Summary",
    sources: {
      ticket: { toolRef: "support.ticket.read@1.0.0" },
    },
    fields: {
      title: { from: "ticket.title", label: "Subject" },
      missingPath: { from: "ticket.nonExistentField", label: "Broken" },
    },
  });

  const registry = createSmassRegistry([TicketModel, ToolBackedSummary]);
  const generatedTools = registry.toSfieldTools("support");
  assert.equal(generatedTools.length, 2);

  // Execute the smass-generated tools inside a real headless SField runtime
  const sf = await SField.create({
    config: { version: 1, models: {}, agents: {} },
    preset: "memory",
    tools: generatedTools,
  });
  try {
    const scope = await sf.executions.open({ principal: LOCAL_DEV_PRINCIPAL, preset: "read_only", purpose: "smass-test" });
    try {
      const readRes = await scope.registry.execute("support.ticket.read@1.0.0", { id: "TKT-101" });
      assert.equal(readRes.status, "succeeded");
      assert.deepEqual(readRes.output, { id: "TKT-101", title: "Checkout timeout", priority: "P1", slaMinutes: 15 });

      // Closed schema rejects undeclared input properties automatically
      await assert.rejects(
        () => scope.registry.execute("support.ticket.read@1.0.0", { id: "TKT-101", injected: true }),
        (err: { code?: string; message?: string }) => err.code === "INVALID_INPUT" && /injected/.test(err.message ?? ""),
      );

      // Generated action tool executes through sfield cleanly
      const actionRes = await scope.registry.execute("support.ticket.escalate.preview@1.0.0", { id: "TKT-101", tier: "L3" });
      assert.equal(actionRes.status, "succeeded");
      assert.deepEqual(actionRes.output, { id: "TKT-101", nextTier: "Escalated to L3" });
    } finally {
      await scope.close();
    }
  } finally {
    await sf.close();
  }

  // Tool-backed model validation catches broken field paths against generated schemas
  const descriptors = new Map(registry.describeGeneratedTools("support").map((d) => [d.ref, d]));
  const issues = registry.validateAgainstTools(descriptors);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, "missingPath");

  // Data model graph compiles Mermaid ER + Draft 2020-12 JSON Schema and validates relations/lifecycles
  const brokenRegistry = createSmassRegistry([
    defineStoreBackedModel({
      id: "broken.entity",
      version: "1.0.0",
      domain: "broken",
      label: "Broken Entity",
      primaryKey: "id",
      fields: {
        id: { type: "string", label: "ID", primaryKey: true, required: true },
        parentId: { type: "string", label: "Parent", foreignKey: { modelId: "missing.parent", field: "id" } },
        total: { type: "integer", label: "Total", computed: { expression: "a + b", dependsOn: ["missingField"] } },
      },
      relations: [
        { name: "belongs_to", targetModelId: "missing.parent", cardinality: "many_to_one", localField: "parentId", foreignField: "id" },
      ],
      lifecycle: {
        stateField: "missingState",
        states: ["open", "closed"],
        transitions: [{ from: "open", to: "invalid_state", actionId: "unknown_action" }],
      },
      source: { read: (): Record<string, unknown> | null => null },
    }),
  ]);
  const graphIssues = brokenRegistry.validateAgainstTools(new Map());
  assert.ok(graphIssues.some((i) => /unknown target model "missing\.parent"/.test(i.message)));
  assert.ok(graphIssues.some((i) => /Foreign key on "parentId"/.test(i.message)));
  assert.ok(graphIssues.some((i) => /undeclared field "missingField"/.test(i.message)));
  assert.ok(graphIssues.some((i) => /Lifecycle stateField "missingState"/.test(i.message)));
  assert.ok(graphIssues.some((i) => /unknown action "unknown_action"/.test(i.message)));
});

test("CEP /api/admin/domain-models exposes tool-backed Wealth models, store-backed IT Ops & Sales models, and live schema evolution", async (t) => {
  const app = await startTestPreview();
  t.after(() => app.close());
  const client = await testClient(app.url);

  interface DomainWorkbenchResponse {
    domainId: string;
    models: SmassModelSummary[];
    dataModel: {
      domain: string;
      entities: SmassModelSummary[];
      relations: Array<{ sourceModelId: string; targetModelId: string; name: string; cardinality: string; localField: string; foreignField: string }>;
      mermaidEr: string;
      jsonSchema: { $schema: string; $id: string; $defs: Record<string, Record<string, unknown>> };
    };
    tools: {
      toolRef: string;
      role: "read" | "action";
      contractFingerprint: string;
      outputFields: { path: string; type: string; exposed: boolean; label: string }[];
    }[];
    catalog: {
      catalogFingerprint: string;
      fields: { toolRef: string; outputPath: string; label: string }[];
    };
  }

  const wealth = await client.request<DomainWorkbenchResponse>("/api/admin/domain-models?domain=wealth");
  assert.equal(wealth.domainId, "wealth");
  const goalModel = wealth.models.find((m) => m.id === "wealth.home_goal");
  assert.ok(goalModel);
  assert.equal(goalModel.mode, "tool_backed");
  assert.equal(goalModel.primaryKey, "goalId");
  assert.ok(goalModel.toolRefs.includes("goal.progress.read@1.0.0"));
  assert.ok(goalModel.toolRefs.includes("goal.savings.preview@1.0.0"));
  assert.ok(goalModel.fields.some((f) => f.outputPath === "targetCents" && f.type === "integer"));
  assert.ok(goalModel.fields.some((f) => f.key === "history" && f.items?.month?.type === "string" && f.items?.savedCents?.type === "integer"));

  // Canonical dataModel graph represents entities, PK/FK relations, Mermaid ER, and Draft 2020-12 JSON Schema
  assert.ok(wealth.dataModel.entities.some((e) => e.id === "wealth.customer" && e.primaryKey === "customerId"));
  assert.ok(wealth.dataModel.relations.some((r) => r.sourceModelId === "wealth.customer" && r.targetModelId === "wealth.home_goal" && r.cardinality === "one_to_many"));
  assert.match(wealth.dataModel.mermaidEr, /erDiagram/);
  assert.match(wealth.dataModel.mermaidEr, /WEALTH_CUSTOMER \|\|--o\{ WEALTH_HOME_GOAL/);
  assert.equal(wealth.dataModel.jsonSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.ok(wealth.dataModel.jsonSchema.$defs["wealth.home_goal"]);

  // Tool workbench exposes closed output schema fields including unexposed ones
  const goalTool = wealth.tools.find((tool) => tool.toolRef === "goal.progress.read@1.0.0");
  assert.ok(goalTool);
  const currencyBefore = goalTool.outputFields.find((f) => f.path === "currency");
  assert.ok(currencyBefore);
  assert.equal(currencyBefore.exposed, false);

  // Evolving an unexposed schema field immediately updates tools, smass dataModel (JSON Schema + ER), and sphoton catalog
  await client.request("/api/admin/ui-binding-catalog?domain=wealth", {
    toolRef: "goal.progress.read@1.0.0",
    outputPath: "currency",
    label: "Goal currency",
    exposed: true,
  });
  const wealthAfter = await client.request<DomainWorkbenchResponse>("/api/admin/domain-models?domain=wealth");
  const goalToolAfter = wealthAfter.tools.find((tool) => tool.toolRef === "goal.progress.read@1.0.0");
  assert.equal(goalToolAfter?.outputFields.find((f) => f.path === "currency")?.exposed, true);
  const goalModelAfter = wealthAfter.models.find((m) => m.id === "wealth.home_goal");
  assert.ok(goalModelAfter?.fields.some((f) => f.outputPath === "currency" && f.exposed && f.label === "Goal currency"));
  assert.ok(wealthAfter.catalog.fields.some((f) => f.toolRef === "goal.progress.read@1.0.0" && f.outputPath === "currency"));
  assert.match(wealthAfter.dataModel.mermaidEr, /string currency/);

  const ops = await client.request<DomainWorkbenchResponse>("/api/admin/domain-models?domain=it_ops");
  assert.equal(ops.domainId, "it_ops");
  const incidentModel = ops.models.find((m) => m.id === "ops.incident");
  assert.ok(incidentModel);
  assert.equal(incidentModel.mode, "store_backed");
  assert.ok(incidentModel.lifecycle && incidentModel.lifecycle.stateField === "rollbackStatus");
  assert.ok(ops.dataModel.relations.some((r) => r.sourceModelId === "ops.service" && r.targetModelId === "ops.incident" && r.cardinality === "one_to_many"));
  assert.ok(incidentModel.toolRefs.includes("ops.incident.read@1.0.0"));
  assert.ok(incidentModel.toolRefs.includes("ops.incident.rollback.preview@1.0.0"));
  assert.ok(ops.tools.some((tool) => tool.toolRef === "ops.incident.read@1.0.0" && tool.outputFields.length > 0));

  const sales = await client.request<DomainWorkbenchResponse>("/api/admin/domain-models?domain=sales_revops");
  assert.equal(sales.domainId, "sales_revops");
  const dealModel = sales.models.find((m) => m.id === "sales.deal");
  assert.ok(dealModel && dealModel.mode === "store_backed");
  assert.ok(dealModel.fields.some((f) => f.key === "netArrCents" && f.computed?.expression.includes("discountPct")));
  assert.ok(dealModel.lifecycle && dealModel.lifecycle.stateField === "discountStatus");
  assert.ok(sales.dataModel.relations.some((r) => r.sourceModelId === "sales.account" && r.targetModelId === "sales.deal" && r.cardinality === "one_to_many"));
  assert.ok(sales.tools.some((tool) => tool.toolRef === "sales.deal.read@1.0.0" && tool.outputFields.length > 0));
});

test("smass Virtual Data Model runtime: projection pushdown, computed fields, 1x turn cache, PII redaction, and minVersions guard", async () => {
  const customer360 = defineToolBackedModel({
    id: "wealth.customer_360",
    version: "1.0.0",
    domain: "wealth",
    label: "Customer 360 (Virtual)",
    primaryKey: "mid",
    sources: {
      account: { toolRef: "account.summary.read@1.0.0" },
      portfolio: { toolRef: "portfolio.summary.read@1.0.0" },
      retirement: { toolRef: "retirement.plan.read@1.0.0" },
    },
    fields: {
      mid: { type: "string", principalKey: "mid", primaryKey: true, label: "Member ID", required: true },
      email: { type: "string", from: "account.email", label: "Email", classification: "pii", required: true },
      fundingStatus: {
        type: "string",
        from: "account.fundingStatus",
        label: "Funding status",
        enumValues: ["unfunded", "pending", "funded"],
        required: true,
      },
      portfolioCashCents: { type: "integer", from: "portfolio.cashCents", label: "Portfolio cash", required: true },
      reserveTargetCents: { type: "integer", from: "portfolio.reserveTargetCents", label: "Reserve target", required: true },
      excessCashCents: {
        type: "integer",
        label: "Excess investable cash",
        computed: {
          expression: "max(0, portfolioCashCents - reserveTargetCents)",
          dependsOn: ["portfolioCashCents", "reserveTargetCents"],
        },
      },
      matchGapCents: { type: "integer", from: "retirement.matchGapCents", label: "401(k) match gap" },
    },
  });

  const salesDeal = defineStoreBackedModel({
    id: "sales.deal_vdm",
    version: "1.0.0",
    domain: "sales_revops",
    label: "Sales Deal",
    primaryKey: "dealId",
    fields: {
      dealId: { type: "string", label: "Deal ID", primaryKey: true, required: true },
      stage: { type: "string", label: "Stage", enumValues: ["discovery", "proposal", "closed_won"], required: true },
      arrCents: { type: "integer", label: "Gross ARR", required: true },
      discountPct: { type: "number", label: "Discount %", required: true },
      netArrCents: {
        type: "integer",
        label: "Net ARR",
        computed: {
          expression: "arrCents * (1 - discountPct / 100)",
          dependsOn: ["arrCents", "discountPct"],
        },
      },
    },
    source: {
      read(inputs) {
        if (inputs.badEnum) {
          return { dealId: "DEAL-9", stage: "bogus_stage", arrCents: 10000, discountPct: 10, version: 1 };
        }
        return { dealId: "DEAL-1", stage: "proposal", arrCents: 25_000_000, discountPct: 15, dealVersion: 3 };
      },
    },
  });

  const registry = createSmassRegistry([customer360, salesDeal]);
  const ctx = { tenantId: "t1", domainId: "wealth", principalId: "DEMO-MID-1003", customerId: "DEMO-MID-1003" };

  let accountVersion = 41;
  let fundingStatus = "unfunded";
  const toolCalls: string[] = [];

  const executeTool = async (toolRef: string): Promise<Record<string, unknown>> => {
    toolCalls.push(toolRef);
    if (toolRef === "account.summary.read@1.0.0") {
      return { email: "marcus@example.com", fundingStatus, accountVersion };
    }
    if (toolRef === "portfolio.summary.read@1.0.0") {
      return { cashCents: 1_250_000, reserveTargetCents: 250_000, balanceVersion: "bal_17" };
    }
    if (toolRef === "retirement.plan.read@1.0.0") {
      return { matchGapCents: 360_000, retirementVersion: 5 };
    }
    throw new Error(`Unexpected tool ${toolRef}`);
  };

  // 1. Projection pushdown: requesting fundingStatus + excessCashCents skips retirement source completely
  const projected = await registry.materializeSnapshot({
    modelId: "wealth.customer_360",
    ctx,
    requestedFields: ["fundingStatus", "excessCashCents"],
    executeTool,
  });
  assert.equal(projected.status, "ok");
  assert.deepEqual(projected.sourcesQueried, ["account", "portfolio"]);
  assert.deepEqual(projected.sourcesSkipped, ["retirement"]);
  assert.equal(projected.sourceCalls, 2);
  assert.equal(projected.data.fundingStatus, "unfunded");
  assert.equal(projected.data.excessCashCents, 1_000_000);
  assert.equal(projected.dataVersions.accountVersion, 41);
  assert.equal(projected.dataVersions.balanceVersion, "bal_17");
  assert.equal(toolCalls.includes("retirement.plan.read@1.0.0"), false);

  // 2. 1x turn-scoped snapshot cache: CCRE + Treatment Resolver + PII-scrubbed LLM share 1 physical fetch
  toolCalls.length = 0;
  const turnCache = createTurnSnapshotCache();
  const ccreSnap = await registry.materializeSnapshot({
    modelId: "wealth.customer_360",
    ctx,
    cache: turnCache,
    executeTool,
  });
  assert.equal(ccreSnap.status, "ok");
  assert.equal(ccreSnap.sourceCalls, 3);
  assert.equal(ccreSnap.cacheHit, false);

  const resolverSnap = await registry.materializeSnapshot({
    modelId: "wealth.customer_360",
    ctx,
    requestedFields: ["mid", "fundingStatus", "excessCashCents"],
    cache: turnCache,
    executeTool,
  });
  assert.equal(resolverSnap.status, "ok");
  assert.equal(resolverSnap.cacheHit, true);
  assert.equal(resolverSnap.sourceCalls, 0);
  assert.equal(resolverSnap.snapshotId, ccreSnap.snapshotId);
  assert.equal(toolCalls.length, 3); // Zero additional physical calls

  const llmSnap = await registry.materializeSnapshot({
    modelId: "wealth.customer_360",
    ctx,
    redactClassifications: ["pii"],
    cache: turnCache,
    executeTool,
  });
  assert.equal(llmSnap.status, "ok");
  assert.equal(llmSnap.cacheHit, true);
  assert.equal(llmSnap.sourceCalls, 0);
  assert.equal("email" in llmSnap.data, false);
  assert.deepEqual(llmSnap.redactedFields, ["email"]);

  // 3. minVersions freshness guard: stale backend returns stale_version_retry; updated backend refreshes live
  const stale = await registry.materializeSnapshot({
    modelId: "wealth.customer_360",
    ctx,
    requestedFields: ["fundingStatus"],
    minVersions: { accountVersion: 42 },
    cache: turnCache,
    executeTool,
  });
  assert.equal(stale.status, "stale_version_retry");
  assert.equal(stale.observedVersions.accountVersion, 41);
  assert.equal(stale.requiredVersions.accountVersion, 42);

  accountVersion = 42;
  fundingStatus = "funded";
  const fresh = await registry.materializeSnapshot({
    modelId: "wealth.customer_360",
    ctx,
    requestedFields: ["fundingStatus"],
    minVersions: { accountVersion: 42 },
    cache: turnCache,
    executeTool,
  });
  assert.equal(fresh.status, "ok");
  assert.equal(fresh.cacheHit, false);
  assert.equal(fresh.data.fundingStatus, "funded");
  assert.equal(fresh.dataVersions.accountVersion, 42);

  // 4. Store-backed VDM computed expression & strict enum runtime validation
  const dealSnap = await registry.materializeSnapshot({
    modelId: "sales.deal_vdm",
    ctx: { tenantId: "t1", domainId: "sales_revops", principalId: "rep_1" },
  });
  assert.equal(dealSnap.status, "ok");
  assert.equal(dealSnap.data.netArrCents, 21_250_000);
  assert.equal(dealSnap.dataVersions.dealVersion, 3);

  await assert.rejects(
    () =>
      registry.materializeSnapshot({
        modelId: "sales.deal_vdm",
        ctx: { tenantId: "t1", domainId: "sales_revops", principalId: "rep_1" },
        inputs: { badEnum: true },
      }),
    (err: unknown) => err instanceof SmassSnapshotValidationError && err.issues.some((i) => i.field === "stage"),
  );

  // Direct expression evaluator sanity check (zero eval, rejects unsupported chars)
  assert.equal(evaluateSmassComputedExpression("a + b * (2 - 1)", { a: 10, b: 5 }), 15);
  assert.throws(() => evaluateSmassComputedExpression("process.exit(1)", {}), /Unsupported function/);
});

test("CEP /api/admin/domain-models supports creating, testing live 1x snapshots, and deleting custom virtual models from tool JSON Schemas", async (t) => {
  const app = await startTestPreview();
  t.after(() => app.close());
  const client = await testClient(app.url);

  // Create a federated virtual model spanning two Wealth read tools + a computed field
  const created = await client.request<{
    customModelIds: string[];
    models: SmassModelSummary[];
    dataModel: {
      mermaidEr: string;
      jsonSchema: { $defs: Record<string, Record<string, unknown>> };
    };
  }>("/api/admin/domain-models?domain=wealth", {
    id: "wealth.advisor_brief",
    version: "1.0.0",
    label: "Advisor Brief",
    description: "Federated cash view composed via drag-and-drop from tool JSON Schemas.",
    principalKey: "mid",
    primaryKey: "mid",
    fields: [
      {
        kind: "mapped",
        key: "targetCents",
        label: "Down payment target",
        toolRef: "goal.progress.read@1.0.0",
        outputPath: "targetCents",
        format: "currency_cents",
        classification: "confidential",
        required: true,
        exposed: true,
      },
      {
        kind: "mapped",
        key: "cashCents",
        label: "Portfolio cash",
        toolRef: "portfolio.snapshot.read@1.0.0",
        outputPath: "cashCents",
        format: "currency_cents",
        classification: "confidential",
        required: true,
        exposed: true,
      },
      {
        kind: "computed",
        key: "remainingGapCents",
        label: "Remaining goal gap",
        expression: "max(0, targetCents - cashCents)",
        dependsOn: ["targetCents", "cashCents"],
        type: "integer",
        format: "currency_cents",
        classification: "confidential",
        exposed: true,
      },
    ],
  });

  assert.ok(created.customModelIds.includes("wealth.advisor_brief"));
  assert.ok(created.models.some((m) => m.id === "wealth.advisor_brief" && m.mode === "tool_backed"));
  assert.ok(created.dataModel.jsonSchema.$defs["wealth.advisor_brief"]);
  assert.match(created.dataModel.mermaidEr, /WEALTH_ADVISOR_BRIEF/);

  // Test live 1x virtual snapshot materialization across both real Wealth tools
  const snapRes = await client.request<{
    snapshot: {
      status: string;
      snapshotId: string;
      sourceCalls: number;
      sourcesQueried: string[];
      sourcesSkipped: string[];
      data: Record<string, unknown>;
    };
  }>("/api/admin/domain-models-test?domain=wealth", {
    modelId: "wealth.advisor_brief",
    customerId: "demo-learner",
  });
  assert.equal(snapRes.snapshot.status, "ok");
  assert.equal(snapRes.snapshot.sourceCalls, 2);
  assert.equal(snapRes.snapshot.sourcesQueried.length, 2);
  const target = Number(snapRes.snapshot.data.targetCents);
  const cash = Number(snapRes.snapshot.data.cashCents);
  assert.ok(target > 0 && cash > 0);
  assert.equal(snapRes.snapshot.data.remainingGapCents, Math.max(0, target - cash));

  // Projection pushdown: requesting only targetCents skips portfolio.snapshot.read@1.0.0
  const projectedRes = await client.request<{
    snapshot: {
      status: string;
      sourceCalls: number;
      sourcesQueried: string[];
      sourcesSkipped: string[];
      data: Record<string, unknown>;
    };
  }>("/api/admin/domain-models-test?domain=wealth", {
    modelId: "wealth.advisor_brief",
    customerId: "demo-learner",
    requestedFields: ["targetCents"],
  });
  assert.equal(projectedRes.snapshot.status, "ok");
  assert.equal(projectedRes.snapshot.sourceCalls, 1);
  assert.equal(projectedRes.snapshot.sourcesSkipped.length, 1);

  // Invalid tool schema path is rejected at save time
  await assert.rejects(
    () =>
      client.request("/api/admin/domain-models?domain=wealth", {
        id: "wealth.broken_vdm",
        label: "Broken",
        fields: [
          {
            kind: "mapped",
            key: "bogus",
            label: "Bogus",
            toolRef: "goal.progress.read@1.0.0",
            outputPath: "doesNotExist",
          },
        ],
      }),
    /doesNotExist|400|invalid/i,
  );

  // Delete custom virtual model cleanly
  const afterDelete = await client.request<{ customModelIds: string[]; models: SmassModelSummary[] }>(
    "/api/admin/domain-models-delete?domain=wealth",
    { modelId: "wealth.advisor_brief" },
  );
  assert.equal(afterDelete.customModelIds.includes("wealth.advisor_brief"), false);
  assert.equal(afterDelete.models.some((m) => m.id === "wealth.advisor_brief"), false);
});

test("smass VDM supports array & multi-column aggregates, derived columns over aggregates, and renaming virtual models", async (t) => {
  const app = await startTestPreview();
  t.after(() => app.close());
  const client = await testClient(app.url);

  // Create a virtual model with:
  // - renamed mapped columns (goalTargetCents <- targetCents, savingsHistory <- history, portfolioCashCents <- cashCents, equityHoldingsCents <- equityCents)
  // - array aggregates: count(savingsHistory), last(savingsHistory.savedCents), avg(savingsHistory.savedCents)
  // - multi-column aggregate: sum(portfolioCashCents, equityHoldingsCents)
  // - derived column referencing an aggregate: remainingGoalGapCents = max(0, goalTargetCents - latestSavedCents)
  const created = await client.request<{
    customModelIds: string[];
    dataModel: { mermaidEr: string; jsonSchema: { $defs: Record<string, Record<string, unknown>> } };
  }>("/api/admin/domain-models?domain=wealth", {
    id: "wealth.goal_analytics_v1",
    label: "Goal Analytics v1",
    principalKey: "mid",
    primaryKey: "mid",
    fields: [
      { kind: "mapped", key: "goalTargetCents", label: "Home Goal Target", toolRef: "goal.progress.read@1.0.0", outputPath: "targetCents", format: "currency_cents", required: true, exposed: true },
      { kind: "mapped", key: "savingsHistory", label: "Monthly History", toolRef: "goal.progress.read@1.0.0", outputPath: "history", format: "series", required: true, exposed: false },
      { kind: "mapped", key: "portfolioCashCents", label: "Cash", toolRef: "portfolio.snapshot.read@1.0.0", outputPath: "cashCents", format: "currency_cents", required: true, exposed: true },
      { kind: "mapped", key: "equityHoldingsCents", label: "Equities", toolRef: "portfolio.snapshot.read@1.0.0", outputPath: "equityCents", format: "currency_cents", required: true, exposed: true },
      { kind: "aggregate", key: "monthsTracked", label: "Months Tracked", op: "count", sourceField: "savingsHistory", type: "integer", exposed: true },
      { kind: "aggregate", key: "latestSavedCents", label: "Latest Saved", op: "last", sourceField: "savingsHistory", itemField: "savedCents", type: "integer", format: "currency_cents", exposed: true },
      { kind: "aggregate", key: "avgSavedCents", label: "Average Saved", op: "avg", sourceField: "savingsHistory", itemField: "savedCents", type: "integer", format: "currency_cents", exposed: true },
      { kind: "aggregate", key: "cashPlusEquityCents", label: "Cash + Equities", op: "sum", sourceFields: ["portfolioCashCents", "equityHoldingsCents"], type: "integer", format: "currency_cents", exposed: true },
      { kind: "computed", key: "remainingGoalGapCents", label: "Remaining Goal Gap", expression: "max(0, goalTargetCents - latestSavedCents)", dependsOn: ["goalTargetCents", "latestSavedCents"], type: "integer", format: "currency_cents", exposed: true },
    ],
  });

  assert.ok(created.customModelIds.includes("wealth.goal_analytics_v1"));
  assert.match(created.dataModel.mermaidEr, /agg: last\(savingsHistory\.savedCents\)/);
  assert.match(created.dataModel.mermaidEr, /agg: sum\(portfolioCashCents, equityHoldingsCents\)/);

  // Live 1x snapshot verifies array aggregates, multi-column aggregate, and derived column over aggregate
  const snap = await client.request<{
    snapshot: { status: string; sourceCalls: number; sourcesSkipped: string[]; data: Record<string, unknown> };
  }>("/api/admin/domain-models-test?domain=wealth", {
    modelId: "wealth.goal_analytics_v1",
    customerId: "demo-learner",
  });
  assert.equal(snap.snapshot.status, "ok");
  assert.equal(snap.snapshot.sourceCalls, 2);
  assert.ok(Number(snap.snapshot.data.monthsTracked) >= 3);
  const target = Number(snap.snapshot.data.goalTargetCents);
  const latestSaved = Number(snap.snapshot.data.latestSavedCents);
  const avgSaved = Number(snap.snapshot.data.avgSavedCents);
  const cash = Number(snap.snapshot.data.portfolioCashCents);
  const equities = Number(snap.snapshot.data.equityHoldingsCents);
  assert.ok(latestSaved > 0 && avgSaved > 0);
  assert.equal(snap.snapshot.data.cashPlusEquityCents, cash + equities);
  assert.equal(snap.snapshot.data.remainingGoalGapCents, Math.max(0, target - latestSaved));

  // Projection pushdown on an aggregate column skips the unused portfolio tool!
  const aggOnly = await client.request<{
    snapshot: { status: string; sourceCalls: number; sourcesSkipped: string[]; data: Record<string, unknown> };
  }>("/api/admin/domain-models-test?domain=wealth", {
    modelId: "wealth.goal_analytics_v1",
    customerId: "demo-learner",
    requestedFields: ["latestSavedCents"],
  });
  assert.equal(aggOnly.snapshot.status, "ok");
  assert.equal(aggOnly.snapshot.sourceCalls, 1);
  assert.equal(aggOnly.snapshot.sourcesSkipped.length, 1);
  assert.equal(aggOnly.snapshot.data.latestSavedCents, latestSaved);

  // Rename model ID cleanly via previousId (old ID unregistered, no duplicate)
  const renamed = await client.request<{ customModelIds: string[]; models: SmassModelSummary[] }>(
    "/api/admin/domain-models?domain=wealth",
    {
      id: "wealth.goal_analytics_renamed",
      previousId: "wealth.goal_analytics_v1",
      label: "Goal Analytics Renamed",
      principalKey: "mid",
      primaryKey: "mid",
      fields: [
        { kind: "mapped", key: "goalTargetCents", label: "Home Goal Target", toolRef: "goal.progress.read@1.0.0", outputPath: "targetCents", format: "currency_cents", required: true, exposed: true },
      ],
    },
  );
  assert.equal(renamed.customModelIds.includes("wealth.goal_analytics_v1"), false);
  assert.equal(renamed.customModelIds.includes("wealth.goal_analytics_renamed"), true);
  assert.equal(renamed.models.some((m) => m.id === "wealth.goal_analytics_v1"), false);
  assert.equal(renamed.models.some((m) => m.id === "wealth.goal_analytics_renamed"), true);

  await client.request("/api/admin/domain-models-delete?domain=wealth", { modelId: "wealth.goal_analytics_renamed" });
});

test("smass VDM handles hierarchical JSON via both Flatten (nested objects + array indexing) and Relational Normalization (1:N unnest rows)", async (t) => {
  const app = await startTestPreview();
  t.after(() => app.close());
  const client = await testClient(app.url);

  // 1. Option A: Flatten array-indexed paths (`values[0].displayValue`, `history[-1].*`) into flat scalar columns
  const flatModel = await client.request<{
    customModelIds: string[];
    catalog: { fields: Array<{ toolRef: string; outputPath: string; label: string }> };
  }>("/api/admin/domain-models?domain=wealth", {
    id: "wealth.flat_hierarchy",
    label: "Flattened Summary",
    principalKey: "mid",
    primaryKey: "mid",
    fields: [
      { kind: "mapped", key: "firstBalanceMetric", label: "First Balance Metric", toolRef: "demo.balance.read@1.0.0", outputPath: "values[0].metricKey", required: true, exposed: true },
      { kind: "mapped", key: "firstBalanceValue", label: "First Balance Value", toolRef: "demo.balance.read@1.0.0", outputPath: "values[0].displayValue", required: true, exposed: true },
      { kind: "mapped", key: "latestMonth", label: "Latest Month", toolRef: "goal.progress.read@1.0.0", outputPath: "history[-1].month", required: true, exposed: true },
      { kind: "mapped", key: "latestSavedCents", label: "Latest Saved", toolRef: "goal.progress.read@1.0.0", outputPath: "history[-1].savedCents", format: "currency_cents", required: true, exposed: true },
    ],
  });
  assert.ok(flatModel.customModelIds.includes("wealth.flat_hierarchy"));
  // Flattened array-indexed fields are immediately bindable in sphoton UI catalog
  assert.ok(flatModel.catalog.fields.some((f) => f.toolRef === "goal.progress.read@1.0.0" && f.outputPath === "history[-1].savedCents"));

  const flatSnap = await client.request<{
    snapshot: { status: string; data: Record<string, unknown> };
  }>("/api/admin/domain-models-test?domain=wealth", {
    modelId: "wealth.flat_hierarchy",
    customerId: "demo-learner",
  });
  assert.equal(flatSnap.snapshot.status, "ok");
  assert.ok(typeof flatSnap.snapshot.data.firstBalanceMetric === "string" && flatSnap.snapshot.data.firstBalanceMetric.length > 0);
  assert.ok(typeof flatSnap.snapshot.data.firstBalanceValue === "string" && flatSnap.snapshot.data.firstBalanceValue.length > 0);
  assert.ok(typeof flatSnap.snapshot.data.latestMonth === "string" && /\d{4}-\d{2}/.test(flatSnap.snapshot.data.latestMonth));
  assert.ok(Number(flatSnap.snapshot.data.latestSavedCents) > 0);

  // Also verify nested object flattening directly in smass VDM (`profile.address.city`, `profile.tier`)
  const nestedObjModel = defineToolBackedModel({
    id: "crm.customer_flat",
    version: "1.0.0",
    domain: "crm",
    label: "Flattened Customer",
    primaryKey: "mid",
    sources: { crm: { toolRef: "crm.profile.read@1.0.0" } },
    fields: {
      mid: { type: "string", principalKey: "mid", primaryKey: true, label: "MID", required: true },
      city: { type: "string", from: "crm.profile.address.city", label: "City", required: true },
      tier: { type: "string", from: "crm.profile.tier", label: "Tier", required: true },
    },
  });
  const nestedReg = createSmassRegistry([nestedObjModel]);
  const nestedSnap = await nestedReg.materializeSnapshot({
    modelId: "crm.customer_flat",
    ctx: { tenantId: "t1", domainId: "crm", principalId: "MID-1" },
    executeTool: async () => ({ profile: { tier: "Private", address: { city: "Seattle", zip: "98101" } }, version: 7 }),
  });
  assert.equal(nestedSnap.status, "ok");
  assert.equal(nestedSnap.data.city, "Seattle");
  assert.equal(nestedSnap.data.tier, "Private");

  // 2. Option B: Normalize nested 1:N array (`history[]`) into a relational child entity with PK, FK, ER relation & per-row derived column
  const childModel = await client.request<{
    customModelIds: string[];
    dataModel: { mermaidEr: string; jsonSchema: { $defs: Record<string, Record<string, unknown>> } };
  }>("/api/admin/domain-models?domain=wealth", {
    id: "wealth.goal_history_items",
    label: "Goal History Records",
    primaryKey: "rowIndex",
    principalKey: "mid",
    unnest: {
      toolRef: "goal.progress.read@1.0.0",
      path: "history",
      parentModelId: "wealth.home_goal",
      parentJoinField: "customerId",
      indexField: "rowIndex",
    },
    fields: [
      { kind: "mapped", key: "month", label: "Month", toolRef: "goal.progress.read@1.0.0", outputPath: "history[].month", format: "month", required: true, exposed: true },
      { kind: "mapped", key: "savedCents", label: "Saved (cents)", toolRef: "goal.progress.read@1.0.0", outputPath: "history[].savedCents", format: "currency_cents", required: true, exposed: true },
      { kind: "computed", key: "savedDollars", label: "Saved (USD)", expression: "savedCents / 100", dependsOn: ["savedCents"], type: "number", exposed: true },
    ],
    relations: [
      { name: "belongs_to_home_goal", targetModelId: "wealth.home_goal", cardinality: "many_to_one", localField: "mid", foreignField: "customerId" },
    ],
  });

  assert.ok(childModel.customModelIds.includes("wealth.goal_history_items"));
  assert.match(childModel.dataModel.mermaidEr, /WEALTH_GOAL_HISTORY_ITEMS \}o--\|\| WEALTH_HOME_GOAL : "belongs_to_home_goal"/);
  assert.ok(childModel.dataModel.jsonSchema.$defs["wealth.goal_history_items"]?.["x-smass-unnest"]);

  const relSnap = await client.request<{
    snapshot: { status: string; rowCount?: number; rows?: Array<Record<string, unknown>> };
  }>("/api/admin/domain-models-test?domain=wealth", {
    modelId: "wealth.goal_history_items",
    customerId: "demo-learner",
  });
  assert.equal(relSnap.snapshot.status, "ok");
  assert.ok((relSnap.snapshot.rowCount ?? 0) >= 3);
  assert.ok(Array.isArray(relSnap.snapshot.rows) && relSnap.snapshot.rows.length === relSnap.snapshot.rowCount);
  const firstRow = relSnap.snapshot.rows[0]!;
  assert.equal(firstRow.rowIndex, 0);
  assert.equal(firstRow.mid, "demo-learner");
  assert.equal(firstRow.savedDollars, Number(firstRow.savedCents) / 100);

  await client.request("/api/admin/domain-models-delete?domain=wealth", { modelId: "wealth.flat_hierarchy" });
  await client.request("/api/admin/domain-models-delete?domain=wealth", { modelId: "wealth.goal_history_items" });

  // 3. Persist and remove a custom ER relationship between any two entities (manual or auto-detected on ER Canvas)
  const linked = await client.request<{
    customRelations: Array<{ sourceModelId: string; targetModelId: string; name: string }>;
    dataModel: { mermaidEr: string; relations: Array<{ sourceModelId: string; targetModelId: string; name: string }> };
  }>("/api/admin/domain-models-relation?domain=wealth", {
    sourceModelId: "wealth.portfolio",
    targetModelId: "wealth.home_goal",
    name: "funds_goal",
    cardinality: "one_to_many",
    localField: "customerId",
    foreignField: "customerId",
  });
  assert.ok(linked.customRelations.some((r) => r.name === "funds_goal"));
  assert.ok(linked.dataModel.relations.some((r) => r.sourceModelId === "wealth.portfolio" && r.targetModelId === "wealth.home_goal" && r.name === "funds_goal"));
  assert.match(linked.dataModel.mermaidEr, /WEALTH_PORTFOLIO \|\|--o\{ WEALTH_HOME_GOAL : "funds_goal"/);

  const unlinked = await client.request<{
    customRelations: Array<{ name: string }>;
  }>("/api/admin/domain-models-relation-delete?domain=wealth", {
    sourceModelId: "wealth.portfolio",
    targetModelId: "wealth.home_goal",
    name: "funds_goal",
  });
  assert.equal(unlinked.customRelations.some((r) => r.name === "funds_goal"), false);
});

test("smass rich derived expressions (IF, COALESCE, CONCAT, UPPER/LOWER/LEN, ternary), WHERE aggregates, and cross-entity rollups", async () => {
  // 1. Rich expression evaluator (zero eval)
  assert.equal(
    evaluateSmassComputedExpression('IF(cashCents >= 1000000, "high_cash", "standard")', { cashCents: 1_500_000 }),
    "high_cash",
  );
  assert.equal(
    evaluateSmassComputedExpression('IF(cashCents >= 1000000, "high_cash", "standard")', { cashCents: 250_000 }),
    "standard",
  );
  assert.equal(evaluateSmassComputedExpression("COALESCE(nickname, firstName, 'Guest')", { nickname: null, firstName: "Alice" }), "Alice");
  assert.equal(evaluateSmassComputedExpression("COALESCE(missingVal, 42)", {}), 42);
  assert.equal(evaluateSmassComputedExpression('CONCAT(UPPER(tier), " - ", LOWER(status))', { tier: "private", status: "ACTIVE" }), "PRIVATE - active");
  assert.equal(evaluateSmassComputedExpression('LEN(tier)', { tier: "private" }), 7);
  assert.equal(evaluateSmassComputedExpression("a > 10 && b != 0 ? a + b : 0", { a: 20, b: 5 }), 25);
  assert.equal(evaluateSmassComputedExpression("!(a > 10) || b == 5", { a: 20, b: 5 }), true);
  assert.throws(() => evaluateSmassComputedExpression("eval('1+1')", {}), /Unsupported function/);

  // 2. Cross-entity rollup + WHERE filter sharing a single 1x turn cache
  const childOrders = defineToolBackedModel({
    id: "crm.order_items",
    version: "1.0.0",
    domain: "crm",
    label: "Order Items",
    primaryKey: "rowIndex",
    unnest: { slot: "orders", path: "items", indexField: "rowIndex" },
    sources: { orders: { toolRef: "crm.orders.read@1.0.0" } },
    fields: {
      rowIndex: { type: "integer", label: "Row #", primaryKey: true },
      status: { type: "string", from: "orders.items[].status", label: "Status" },
      amountCents: { type: "integer", from: "orders.items[].amountCents", label: "Amount" },
    },
  });

  const parentSummary = defineToolBackedModel({
    id: "crm.customer_rollup",
    version: "1.0.0",
    domain: "crm",
    label: "Customer Rollup",
    primaryKey: "mid",
    exposeAsTool: true,
    sources: { orders: { toolRef: "crm.orders.read@1.0.0" } },
    fields: {
      mid: { type: "string", principalKey: "mid", primaryKey: true, label: "MID" },
      items: { type: "array", from: "orders.items", label: "Items", exposed: false },
      paidItemsCount: {
        type: "integer",
        label: "Paid Items (WHERE)",
        aggregate: { op: "count", sourceField: "items", where: { field: "status", op: "==", value: "paid" } },
      },
      paidRollupTotalCents: {
        type: "integer",
        label: "Paid Rollup Total",
        aggregate: {
          op: "sum",
          targetModelId: "crm.order_items",
          itemField: "amountCents",
          where: { field: "status", op: "==", value: "paid" },
        },
      },
      tierLabel: {
        type: "string",
        label: "Customer Tier",
        computed: {
          expression: 'IF(paidRollupTotalCents >= 50000, "VIP", "STANDARD")',
          dependsOn: ["paidRollupTotalCents"],
        },
      },
    },
  });

  const reg = createSmassRegistry([childOrders, parentSummary]);
  let toolExecCount = 0;
  const cache = createTurnSnapshotCache();
  const snap = await reg.materializeSnapshot({
    modelId: "crm.customer_rollup",
    ctx: { tenantId: "t1", domainId: "crm", principalId: "C-1" },
    cache,
    executeTool: async () => {
      toolExecCount += 1;
      return {
        items: [
          { status: "paid", amountCents: 30_000 },
          { status: "pending", amountCents: 99_000 },
          { status: "paid", amountCents: 25_000 },
        ],
        ordersVersion: 2,
      };
    },
  });

  assert.equal(snap.status, "ok");
  assert.equal(snap.data.paidItemsCount, 2);
  assert.equal(snap.data.paidRollupTotalCents, 55_000);
  assert.equal(snap.data.tierLabel, "VIP");
  // Both parent and child entity used the same underlying tool; cache guarantees only 2 or fewer executions (1 for parent, 1 for child model)
  assert.ok(toolExecCount <= 2);
});

test("smass published virtual models compile into live sfield read tools, respect Draft/Published governance, and report lineage & drift", async (t) => {
  const app = await startTestPreview();
  t.after(() => app.close());
  const client = await testClient(app.url);

  // Create a published virtual model with IF() derived column + WHERE-filtered aggregate
  const created = await client.request<{
    customModelIds: string[];
    models: SmassModelSummary[];
    virtualTools: Array<{ toolRef: string; outputFields: Array<{ path: string; type: string }> }>;
    driftIssues: Array<{ modelId: string; message: string }>;
    lineage: Record<string, { uiLayouts: string[]; widgets: string[]; ccreRules: string[]; childModels: string[] }>;
    catalog: { fields: Array<{ toolRef: string; outputPath: string; label: string }> };
  }>("/api/admin/domain-models?domain=wealth", {
    id: "wealth.executive_tier",
    version: "1.0.0",
    status: "published",
    label: "Executive Tier View",
    principalKey: "mid",
    primaryKey: "mid",
    fields: [
      { kind: "mapped", key: "cashCents", label: "Cash", toolRef: "portfolio.snapshot.read@1.0.0", outputPath: "cashCents", format: "currency_cents", required: true, exposed: true },
      { kind: "mapped", key: "history", label: "History", toolRef: "goal.progress.read@1.0.0", outputPath: "history", format: "series", required: true, exposed: false },
      {
        kind: "aggregate",
        key: "strongMonths",
        label: "Strong Savings Months",
        op: "count",
        sourceField: "history",
        where: { field: "savedCents", op: ">=", value: 1_000_000 },
        type: "integer",
        exposed: true,
      },
      {
        kind: "computed",
        key: "cashTier",
        label: "Cash Tier",
        expression: 'IF(cashCents >= 1000000, "high_cash", "standard")',
        dependsOn: ["cashCents"],
        type: "string",
        exposed: true,
      },
    ],
  });

  const expectedToolRef = "smass.wealth.executive_tier.read@1.0.0";
  const modelSummary = created.models.find((m) => m.id === "wealth.executive_tier");
  assert.ok(modelSummary);
  assert.equal(modelSummary.status, "published");
  assert.equal(modelSummary.virtualReadToolRef, expectedToolRef);

  // Compiled live sfield virtual read tool is listed & its derived/aggregate columns are bindable in sphoton catalog!
  assert.ok(created.virtualTools.some((vt) => vt.toolRef === expectedToolRef));
  assert.ok(created.catalog.fields.some((f) => f.toolRef === expectedToolRef && f.outputPath === "cashTier"));
  assert.ok(created.catalog.fields.some((f) => f.toolRef === expectedToolRef && f.outputPath === "strongMonths"));
  assert.ok(Array.isArray(created.driftIssues));
  assert.ok(created.lineage["wealth.executive_tier"]);

  // Test live 1x snapshot across two Wealth personas
  const aliceSnap = await client.request<{ snapshot: { status: string; data: Record<string, unknown> } }>(
    "/api/admin/domain-models-test?domain=wealth",
    { modelId: "wealth.executive_tier", customerId: "demo-learner" },
  );
  assert.equal(aliceSnap.snapshot.status, "ok");
  assert.ok(aliceSnap.snapshot.data.cashTier === "high_cash" || aliceSnap.snapshot.data.cashTier === "standard");
  assert.equal(typeof aliceSnap.snapshot.data.strongMonths, "number");

  // Toggle status to Draft -> hides virtual tool & fields from sphoton catalog while remaining testable in Studio
  const drafted = await client.request<{
    models: SmassModelSummary[];
    virtualTools: Array<{ toolRef: string }>;
    catalog: { fields: Array<{ toolRef: string; outputPath: string }> };
  }>("/api/admin/domain-models-status?domain=wealth", {
    modelId: "wealth.executive_tier",
    status: "draft",
  });
  assert.equal(drafted.models.find((m) => m.id === "wealth.executive_tier")?.status, "draft");
  assert.equal(drafted.virtualTools.some((vt) => vt.toolRef === expectedToolRef), false);
  assert.equal(drafted.catalog.fields.some((f) => f.toolRef === expectedToolRef), false);

  // Draft model is still testable in Studio!
  const draftSnap = await client.request<{ snapshot: { status: string } }>(
    "/api/admin/domain-models-test?domain=wealth",
    { modelId: "wealth.executive_tier", customerId: "demo-learner" },
  );
  assert.equal(draftSnap.snapshot.status, "ok");

  // Re-publish -> restores live virtual tool & sphoton bindings
  const republished = await client.request<{
    virtualTools: Array<{ toolRef: string }>;
    catalog: { fields: Array<{ toolRef: string; outputPath: string }> };
  }>("/api/admin/domain-models-status?domain=wealth", {
    modelId: "wealth.executive_tier",
    status: "published",
  });
  assert.equal(republished.virtualTools.some((vt) => vt.toolRef === expectedToolRef), true);
  assert.equal(republished.catalog.fields.some((f) => f.toolRef === expectedToolRef && f.outputPath === "cashTier"), true);

  // Clean up
  await client.request("/api/admin/domain-models-delete?domain=wealth", { modelId: "wealth.executive_tier" });
});
