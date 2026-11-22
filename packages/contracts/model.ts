import Ajv2020 from "ajv/dist/2020.js";
import type { JsonObject } from "@sfield/core";
import type { ContextSelectionProposal, ExperienceProposal } from "./domain";
import { glossaryOperators, glossaryValueTypes } from "./rule-glossary";
import contextSchema from "./schemas/context-selection-proposal.schema.json";
import experienceSchema from "./schemas/experience-proposal.schema.json";

const ajv = new Ajv2020({ strict: true, validateFormats: false });
export const isContextProposal = ajv.compile<ContextSelectionProposal>(contextSchema);
export const isExperienceProposal = ajv.compile<ExperienceProposal>(experienceSchema);

// The runtime schema subset disallows the standalone contract's URI identifier.
const { $id: _experienceSchemaId, ...runtimeExperienceSchema } = experienceSchema;
export const routingOutputSchema = contextSchema as JsonObject;
export const compositionOutputSchema = runtimeExperienceSchema as JsonObject;

const string = { type: "string" } as const;
const score = { type: ["number", "null"], minimum: 0, maximum: 1 };
function closed(properties: JsonObject): JsonObject {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
function array(items: JsonObject, maxItems: number): JsonObject {
  return { type: "array", items, maxItems };
}

export const turnInputSchema = closed({ turnRef: string });
export const propensityInputSchema = closed({ turnRef: string, catalogSnapshotId: string });
export const treatmentInputSchema = closed({ turnRef: string, routeDecisionId: string });
export const glossaryInputSchema = closed({ turnRef: string, routerRunId: string });
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
