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
