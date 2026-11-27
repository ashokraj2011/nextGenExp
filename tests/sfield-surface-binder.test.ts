import assert from "node:assert/strict";
import test from "node:test";
import {
  createPrincipal,
  defineTool,
  resolveIdentifier,
  SField,
  type Principal,
} from "@sfield/core";
import { startTestPreview } from "./preview";

test("@sfield/core SurfaceBinder: auto-discovers tool schemas, stitches $ref + $repeat + formatters, enforces schema validation, and seals tamper-proof actions", async () => {
  const holdingsTool = defineTool({
    id: "wealth.holdings.read",
    version: "1.0.0",
    description: "Read customer cash and equity holdings.",
    inputs: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    outputs: {
      type: "object",
      additionalProperties: false,
      required: ["accountId", "cashCents", "positions"],
      properties: {
        accountId: { type: "string" },
        cashCents: { type: "integer" },
        positions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["symbol", "shares", "gainPct"],
            properties: {
              symbol: { type: "string" },
              shares: { type: "integer" },
              gainPct: { type: "number" },
            },
          },
        },
      },
    },
    policy: { effect: "read", classification: "confidential" },
    handler: async (_raw, ctx) => ({
      accountId: resolveIdentifier(ctx.principal, "mid") ?? "MID-000",
      cashCents: 1245050,
      positions: [
        { symbol: "aapl", shares: 40, gainPct: 0.145 },
        { symbol: "msft", shares: 15, gainPct: 0.221 },
      ],
    }),
  });

  const updatedGoals: Array<{ accountId: string; targetUsd: number; by: string }> = [];
  const updateGoalTool = defineTool({
    id: "wealth.goal.update",
    version: "1.0.0",
    description: "Update a savings goal target.",
    resource: { type: "savings_goal", id: { ref: "inputs.accountId" } },
    inputs: {
      type: "object",
      additionalProperties: false,
      required: ["accountId", "targetUsd"],
      properties: {
        accountId: { type: "string" },
        targetUsd: { type: "number" },
      },
    },
    outputs: {
      type: "object",
      additionalProperties: false,
      required: ["saved", "accountId", "targetUsd"],
      properties: {
        saved: { type: "boolean" },
        accountId: { type: "string" },
        targetUsd: { type: "number" },
      },
    },
    policy: { effect: "write", requiresApproval: false, classification: "confidential" },
    handler: async (raw, ctx) => {
      const accountId = String(raw["accountId"]);
      const targetUsd = Number(raw["targetUsd"]);
      updatedGoals.push({ accountId, targetUsd, by: ctx.principal.subjectId });
      return { saved: true, accountId, targetUsd };
    },
  });

  const wireApprovalTool = defineTool({
    id: "wealth.wire.initiate",
    version: "1.0.0",
    description: "Initiate a high-value wire requiring HITL approval.",
    resource: { type: "wire", id: { ref: "inputs.accountId" } },
    inputs: {
      type: "object",
      additionalProperties: false,
      required: ["accountId", "amountUsd"],
      properties: {
        accountId: { type: "string" },
        amountUsd: { type: "number" },
      },
    },
    outputs: {
      type: "object",
      additionalProperties: false,
      required: ["queued"],
      properties: { queued: { type: "boolean" } },
    },
    policy: { effect: "write", requiresApproval: true, classification: "restricted" },
    handler: async () => ({ queued: true }),
  });

  const sf = await SField.create({
    config: { version: 1, models: {}, agents: {} },
    preset: "memory",
    limits: { grants: { autonomousWrites: true } },
    tools: [holdingsTool, updateGoalTool, wireApprovalTool],
    authorizer: {
      authorize: async (req) => ({
        decision: "allow",
        evidenceId: `auth_${req.resource.id}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    },
    quiet: true,
  });

  const alice: Principal = createPrincipal({
    tenantId: "acme-wealth",
    subjectId: "alice",
    kind: "human",
    identifiers: { mid: "MID-9001" },
  });
  const mallory: Principal = createPrincipal({
    tenantId: "acme-wealth",
    subjectId: "mallory",
    kind: "human",
    identifiers: { mid: "MID-9999" },
  });

  try {
    // 1. Auto-discover bindable schema fields
    const schemas = sf.surfaces.inspectSchemas();
    const holdingsSchema = schemas.find((s) => s.toolRef === "wealth.holdings.read@1.0.0");
    assert.ok(holdingsSchema);
    const outPaths = holdingsSchema.outputFields.map((f) => f.path);
    assert.ok(outPaths.includes("cashCents"));
    assert.ok(outPaths.includes("positions[].symbol"));
    assert.ok(outPaths.includes("positions[].gainPct"));

    // 2. Stitch surface declaratively with $ref, formatters, $repeat, principal.* & sealed actions
    const stitched = await sf.surfaces.stitch({
      principal: alice,
      sources: {
        holdings: { toolRef: "wealth.holdings.read@1.0.0", inputs: {} },
      },
      template: {
        component: "PortfolioCard",
        props: {
          title: "Portfolio Overview",
          memberMid: { $ref: "principal.identifiers.mid" },
          cashFormatted: { $ref: "holdings.data.cashCents", format: "usd_cents" },
          topTicker: { $ref: "holdings.data.positions[0].symbol", format: "upper" },
          rows: {
            $repeat: "holdings.data.positions",
            template: {
              ticker: { $ref: "$item.symbol", format: "upper" },
              shares: { $ref: "$item.shares", format: "integer" },
              gain: { $ref: "$item.gainPct", format: "percent_0_1" },
            },
          },
        },
        actions: [
          {
            id: "save-goal",
            label: "Update Goal",
            toolRef: "wealth.goal.update@1.0.0",
            preset: "bounded_auto",
            inputs: {
              accountId: { $ref: "holdings.data.accountId" },
              targetUsd: { $input: "targetUsd" },
            },
          },
          {
            id: "send-wire",
            label: "Send Wire",
            toolRef: "wealth.wire.initiate@1.0.0",
            preset: "supervised",
            inputs: {
              accountId: { $ref: "holdings.data.accountId" },
              amountUsd: { $input: "amountUsd" },
            },
          },
        ],
      },
      strictSchemaValidation: true,
    });

    assert.equal(stitched.component, "PortfolioCard");
    assert.equal(stitched.props["memberMid"], "MID-9001");
    assert.equal(stitched.props["cashFormatted"], "$12,450.50");
    assert.equal(stitched.props["topTicker"], "AAPL");
    assert.deepEqual(stitched.props["rows"], [
      { ticker: "AAPL", shares: "40", gain: "14.5%" },
      { ticker: "MSFT", shares: "15", gain: "22.1%" },
    ]);
    assert.deepEqual(stitched.schemaWarnings, []);
    assert.equal(stitched.actions.length, 2);

    // 3. Strict schema validation catches typos in $ref paths
    await assert.rejects(
      () => sf.surfaces.stitch({
        principal: alice,
        sources: { holdings: { toolRef: "wealth.holdings.read@1.0.0", inputs: {} } },
        template: { component: "BadCard", props: { broken: { $ref: "holdings.data.cashCentz" } } },
        strictSchemaValidation: true,
      }),
      /cashCentz/,
    );

    // 4. Tampered sealed action is rejected (client tries to mutate accountId)
    const saveGoalAction = stitched.actions[0]!;
    const tampered = {
      ...saveGoalAction,
      resolvedInputs: { ...saveGoalAction.resolvedInputs, accountId: "MID-HACKED" },
    };
    const tamperedRes = await sf.surfaces.dispatchAction({
      principal: alice,
      action: tampered,
      formInputs: { targetUsd: 75000 },
    });
    assert.equal(tamperedRes.status, "denied");
    assert.equal(tamperedRes.error?.code, "INVALID_ACTION_SEAL");

    // 5. Cross-principal replay of Alice's sealed action by Mallory is rejected
    const hijackRes = await sf.surfaces.dispatchAction({
      principal: mallory,
      action: saveGoalAction,
      formInputs: { targetUsd: 75000 },
    });
    assert.equal(hijackRes.status, "denied");
    assert.equal(hijackRes.error?.code, "INVALID_ACTION_SEAL");

    // 6. Legitimate sealed action dispatch succeeds & runs under Alice's Principal
    const okRes = await sf.surfaces.dispatchAction({
      principal: alice,
      action: saveGoalAction,
      formInputs: { targetUsd: 85000 },
    });
    assert.equal(okRes.status, "succeeded");
    assert.deepEqual(okRes.output, { saved: true, accountId: "MID-9001", targetUsd: 85000 });
    assert.deepEqual(updatedGoals, [{ accountId: "MID-9001", targetUsd: 85000, by: "alice" }]);

    // 7. Sealed action requiring HITL approval suspends cleanly as pending_approval
    const wireAction = stitched.actions[1]!;
    const wireRes = await sf.surfaces.dispatchAction({
      principal: alice,
      action: wireAction,
      formInputs: { amountUsd: 25000 },
    });
    assert.equal(wireRes.status, "pending_approval");
    assert.ok(wireRes.approvalId);
  } finally {
    await sf.close();
  }
});

test("CEP blind pass-through /api/surfaces/schemas and /api/surfaces/stitch execute sfield tools and stitch UI with zero custom server glue", async () => {
  const preview = await startTestPreview();
  try {
    // 1. Discover schemas blindly from CEP's live sfield runtime
    const schemasRes = await fetch(`${preview.url}/api/surfaces/schemas`);
    assert.equal(schemasRes.status, 200);
    const schemasBody = await schemasRes.json() as { tools: Array<{ toolRef: string; outputFields: Array<{ path: string }> }> };
    assert.ok(schemasBody.tools.some((t) => t.toolRef === "cep.empathy.assess@1.0.0"));

    // 2. Blindly stitch a declarative UI template directly against cep.empathy.assess@1.0.0
    const stitchRes = await fetch(`${preview.url}/api/surfaces/stitch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: {
          empathy: {
            toolRef: "cep.empathy.assess@1.0.0",
            inputs: {
              personaId: "demo-learner",
              userMessage: "I just got laid off from work and need to plan my cash.",
              ordinal: 1,
            },
          },
        },
        template: {
          component: "EmpathySupportBanner",
          props: {
            tone: { $ref: "empathy.data.tone", format: "upper" },
            lifeEvent: { $ref: "empathy.data.lifeEvent" },
            suppressPromos: { $ref: "empathy.data.suppressPromotions" },
          },
        },
      }),
    });
    const stitchText = await stitchRes.text();
    assert.equal(stitchRes.status, 200, stitchText);
    const stitched = JSON.parse(stitchText) as {
      component: string;
      sfieldRunId: string;
      props: { tone: string; lifeEvent: string; suppressPromos: boolean };
    };
    assert.equal(stitched.component, "EmpathySupportBanner");
    assert.ok(stitched.sfieldRunId);
    assert.equal(stitched.props.lifeEvent, "job_loss");
    assert.equal(stitched.props.suppressPromos, true);
  } finally {
    await preview.close();
  }
});
