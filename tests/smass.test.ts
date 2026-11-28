import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { LOCAL_DEV_PRINCIPAL, SField } from "@sfield/core";
import {
  createSmassRegistry,
  defineStoreBackedModel,
  defineToolBackedModel,
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
});

test("CEP /api/admin/domain-models exposes tool-backed Wealth models and store-backed IT Ops & Sales models", async (t) => {
  const app = await startTestPreview();
  t.after(() => app.close());
  const client = await testClient(app.url);

  const wealth = await client.request<{ domainId: string; models: SmassModelSummary[] }>("/api/admin/domain-models?domain=wealth");
  assert.equal(wealth.domainId, "wealth");
  const goalModel = wealth.models.find((m) => m.id === "wealth.home_goal");
  assert.ok(goalModel);
  assert.equal(goalModel.mode, "tool_backed");
  assert.ok(goalModel.toolRefs.includes("goal.progress.read@1.0.0"));
  assert.ok(goalModel.toolRefs.includes("goal.savings.preview@1.0.0"));
  assert.ok(goalModel.fields.some((f) => f.outputPath === "targetCents" && f.type === "integer"));

  const ops = await client.request<{ domainId: string; models: SmassModelSummary[] }>("/api/admin/domain-models?domain=it_ops");
  assert.equal(ops.domainId, "it_ops");
  const incidentModel = ops.models.find((m) => m.id === "ops.incident");
  assert.ok(incidentModel);
  assert.equal(incidentModel.mode, "store_backed");
  assert.ok(incidentModel.toolRefs.includes("ops.incident.read@1.0.0"));
  assert.ok(incidentModel.toolRefs.includes("ops.incident.rollback.preview@1.0.0"));

  const sales = await client.request<{ domainId: string; models: SmassModelSummary[] }>("/api/admin/domain-models?domain=sales_revops");
  assert.equal(sales.domainId, "sales_revops");
  assert.ok(sales.models.some((m) => m.id === "sales.deal" && m.mode === "store_backed"));
});
