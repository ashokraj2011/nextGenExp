import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { defineTool, ToolError } from "@sfield/core";
import { baseConfig, createHarness } from "@sfield/testing";

const goalId = "home_down_payment";
const readTarget = defineTool({
  id: "savings.target.read",
  version: "1.0.0",
  description: "Read the savings target for a goal in this local example.",
  inputs: {
    type: "object", required: ["goalId"], additionalProperties: false,
    properties: { goalId: { type: "string" } },
  },
  outputs: {
    type: "object", required: ["targetCents"], additionalProperties: false,
    properties: { targetCents: { type: "integer", minimum: 0 } },
  },
  policy: { action: "savings.target.read", effect: "read", maxAttempts: 1 },
  handler({ goalId: requested }, ctx) {
    ctx.signal.throwIfAborted();
    if (requested !== goalId) throw new ToolError("GOAL_NOT_FOUND");
    return { targetCents: 6_000_000 };
  },
});

const { sf, principal, dir } = await createHarness({ config: baseConfig(), tools: [readTarget] });
try {
  const scope = await sf.executions.open({ principal, purpose: "read-savings-target", preset: "read_only", budget: { maxToolCalls: 2 } });
  try {
    for (const requested of [goalId, "unknown_goal"]) {
      const result = await scope.registry.execute(readTarget.ref, { goalId: requested });
      console.log(JSON.stringify(result, null, 2));
      if (requested === goalId) {
        assert.equal(result.status, "succeeded");
        assert.equal(result.output.targetCents, 6_000_000);
      } else {
        assert.equal(result.status, "failed");
        assert.equal(result.error.code, "GOAL_NOT_FOUND");
      }
    }
  } finally {
    await scope.close();
  }
} finally {
  await sf.close();
  await rm(dir, { recursive: true, force: true });
}
