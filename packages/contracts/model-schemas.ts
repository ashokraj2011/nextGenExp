import type { JsonObject } from "@sfield/core";
import { fundingAgentOutcomes } from "./funding-workflow";
import { goalMonthPattern, goalProjectionMonths, homeDownPaymentGoalId } from "./goal-progress";
import { glossaryOperators, glossaryValueTypes } from "./rule-glossary";
import { routingIntents } from "./routing-intents";
import contextSchema from "./schemas/context-selection-proposal.schema.json";
import experienceSchema from "./schemas/experience-proposal.schema.json";

export const contextProposalSchema = {
  ...contextSchema,
  properties: {
    ...contextSchema.properties,
    intentId: { ...contextSchema.properties.intentId, enum: [...routingIntents.map(({ intentId }) => intentId), null] },
  },
} as JsonObject;
export const routingOutputSchema = {
  ...contextProposalSchema,
  required: [...contextSchema.required, "replyText"],
} as JsonObject;

// The runtime schema subset disallows the standalone contract's URI identifier.
const { $id: _experienceSchemaId, ...runtimeExperienceSchema } = experienceSchema;
export const compositionOutputSchema = {
  ...runtimeExperienceSchema,
  required: [...runtimeExperienceSchema.required, "replyText"],
} as JsonObject;

const string = { type: "string" } as const;
const score = { type: ["number", "null"], minimum: 0, maximum: 1 };
function closed(properties: JsonObject, optional: readonly string[] = []): JsonObject {
  return { type: "object", properties, required: Object.keys(properties).filter((key) => !optional.includes(key)), additionalProperties: false };
}
function array(items: JsonObject, maxItems: number): JsonObject {
  return { type: "array", items, maxItems };
}

export const turnInputSchema = closed({ turnRef: string });
export const propensityInputSchema = closed({ turnRef: string, catalogSnapshotId: string });
export const treatmentInputSchema = closed({ turnRef: string, routeDecisionId: string });
export const glossaryInputSchema = closed({ turnRef: string, routerRunId: string });
export const portfolioInputSchema = closed({ turnRef: string, routeDecisionId: string });
export const goalProgressInputSchema = closed({ turnRef: string, routeDecisionId: string });
export const balanceInputSchema = closed({});
export const contextResultSchema = closed({
  schemaVersion: { type: "string", enum: ["1.0"] },
  catalogVersion: string,
  contexts: array(closed({ contextId: string, displayName: string, description: string, active: { type: "boolean" } }), 24),
});
export const propensityResultSchema = closed({
  version: string,
  classification: { type: "string", enum: ["synthetic_advisory"] },
  status: { type: "string", enum: ["available", "unavailable"] },
  scores: array(closed({ contextId: string, score }), 24),
});
export const treatmentResultSchema = array(string, 12);
// The registry accepts a flat item schema. Chat validates each kind with its exact Zod contract.
function recommendationsResult(version: string, kinds: string[]) {
  return closed({
    schemaVersion: { type: "string", enum: [version] },
    recommendations: array({
      ...closed({ kind: { type: "string", enum: kinds }, id: string, version: string, forContentIds: array(string, 12) }),
      required: ["kind", "id"],
    }, 24),
  });
}
export const treatmentRecommendationsResultSchema = recommendationsResult("2.0", ["content", "workflow"]);
export const treatmentDecisionResultSchema = recommendationsResult("2.1", ["content", "action", "workflow"]);
const fundingMethodResult = closed({ methodId: string, label: string, from: string, to: string });
const fundingAmounts = { amountCents: { type: "integer", minimum: 1 }, currency: { type: "string", enum: ["USD"] } };
export const fundingOptionsResultSchema = closed({ methods: { ...array(fundingMethodResult, 4), minItems: 1 }, ...fundingAmounts });
export const fundingStatusResultSchema = closed({ accountFundingStatus: { type: "string", enum: ["funded", "unfunded"] } });
export const fundingReadInputSchema = { ...turnInputSchema, required: [] };
export const fundingPreviewInputSchema = { ...closed({ turnRef: string, methodId: string }), required: ["methodId"] };
export const fundingAgentReadInputSchema = closed({});
export const fundingAgentPreviewInputSchema = closed({ methodId: string });
export const fundingPreviewResultSchema = closed({
  status: { type: "string", enum: ["preview"] }, method: fundingMethodResult, ...fundingAmounts,
});
export const fundingAgentResultSchema = closed({
  outcome: { type: "string", enum: [...fundingAgentOutcomes] },
  methodId: { type: ["string", "null"] },
});
const cents = { type: "integer", minimum: 0, maximum: 1_000_000_000_000 };
export const retirementAccountsResultSchema = closed({
  title: string, accounts: array(closed({ id: string, label: string }), 12),
  selected: { anyOf: [closed({ id: string, label: string, beneficiary: { type: ["string", "null"] } }), { type: "null" }] },
});
export const portfolioResultSchema = closed({
  fixtureVersion: string, asOf: string, currency: { type: "string", enum: ["USD"] },
  cashCents: cents, equityCents: cents, fixedIncomeCents: cents,
});
export const goalProgressResultSchema = closed({
  fixtureVersion: { ...string, minLength: 1 },
  goalId: { type: "string", enum: [homeDownPaymentGoalId] },
  currency: { type: "string", enum: ["USD"] },
  targetCents: { ...cents, minimum: 1 },
  monthlyContributionCents: { ...cents, maximum: 100_000_000 },
  history: {
    ...array(closed({ month: { ...string, pattern: goalMonthPattern.source }, savedCents: cents }), 12),
    minItems: 2,
  },
}, ["monthlyContributionCents"]);
const goalMonth = { ...string, pattern: goalMonthPattern.source };
const extraMonthlyCents = { ...cents, minimum: 1, maximum: 500_000 };
const targetMonth = { anyOf: [goalMonth, { type: "null" }] };
const projectedCents = { ...cents, maximum: 1_100_000_000_000 };
export const goalSavingsInputSchema = closed({ turnRef: string, sourceTurnId: string, startMonth: goalMonth, extraMonthlyCents });
export const goalSavingsResultSchema = closed({
  currentMonthlyCents: { ...cents, maximum: 100_000_000 }, extraMonthlyCents, startMonth: goalMonth,
  currentTargetMonth: targetMonth, projectedTargetMonth: targetMonth,
  points: { ...array(closed({ month: goalMonth, currentCents: projectedCents, projectedCents }), goalProjectionMonths + 2), minItems: 2 },
});
const glossaryAttributeResultSchema = closed({
  id: string,
  label: string,
  description: string,
  valueType: { type: "string", enum: [...glossaryValueTypes] },
  operators: array({ type: "string", enum: [...glossaryOperators] }, glossaryOperators.length),
  options: array(closed({ value: string, label: string }), 16),
  minimum: { type: ["integer", "null"] },
});
export const glossaryResultSchema = closed({
  version: string,
  namespaces: array(closed({ id: string, label: string, attributes: array(glossaryAttributeResultSchema, 8) }), 8),
});
export const balanceResultSchema = closed({
  fixtureVersion: string,
  observedAt: string,
  values: array(closed({ metricKey: string, displayValue: string, unit: string }), 2),
});
