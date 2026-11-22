import host from "../../fixtures/host.json";
import { glossaryAllowsCondition, ruleGlossarySchema, type GlossaryAttribute, type GlossaryCondition } from "../contracts/rule-glossary";

type RuleInput = { personaId: string; ordinal: number; portfolioCashCents?: number };
type AttributeDefinition = GlossaryAttribute & { read: (input: RuleInput) => GlossaryCondition["value"] | undefined };

const namespaces = [
  {
    id: "customer", label: "Customer",
    attributes: [
      {
        id: "persona", label: "Demo persona", description: "The synthetic persona used for the preview or chat turn.",
        valueType: "enum", operators: ["eq", "ne"], minimum: null,
        options: host.personas.map(({ personaId, displayName }) => ({ value: personaId, label: displayName })),
        read: ({ personaId }) => personaId,
      },
      {
        id: "is_returning", label: "Returning visitor", description: "Whether the demo customer has visited before.",
        valueType: "boolean", operators: ["eq", "ne"], options: [], minimum: null,
        read: ({ personaId }) => personaId === "demo-returning",
      },
      {
        id: "beneficiary_status", label: "Beneficiary status", description: "Whether the demo account has beneficiary details on file.",
        valueType: "enum", operators: ["eq", "ne"], minimum: null,
        options: [{ value: "missing", label: "Missing" }, { value: "on_file", label: "On file" }],
        read: ({ personaId }) => host.personas.find((persona) => persona.personaId === personaId)?.beneficiaryStatus,
      },
    ],
  },
  {
    id: "conversation", label: "Conversation",
    attributes: [
      {
        id: "turn_number", label: "Turn number", description: "The position of the request in this conversation, starting at one.",
        valueType: "integer", operators: ["eq", "ne", "gte", "lte"], options: [], minimum: 1,
        read: ({ ordinal }) => ordinal,
      },
    ],
  },
  {
    id: "portfolio", label: "Portfolio",
    attributes: [
      {
        id: "cash_usd", label: "Cash balance (USD)", description: "The cash in the demo portfolio. Enter the threshold in whole US dollars.",
        valueType: "integer", operators: ["eq", "ne", "gt", "gte", "lte"], options: [], minimum: 0,
        read: ({ portfolioCashCents }) => portfolioCashCents === undefined ? undefined : portfolioCashCents / 100,
      },
    ],
  },
] satisfies { id: string; label: string; attributes: AttributeDefinition[] }[];

export const mockRuleGlossary = ruleGlossarySchema.parse({
  version: "pzn-ccre-mock-v1",
  namespaces: namespaces.map(({ attributes, ...namespace }) => ({
    ...namespace, attributes: attributes.map(({ read, ...attribute }) => attribute),
  })),
});

export function matchesGlossaryCondition(condition: GlossaryCondition, input: RuleInput) {
  if (!glossaryAllowsCondition(mockRuleGlossary, condition)) return false;
  const { namespaceId, attributeId, operator, value } = condition;
  const read = namespaces.find(({ id }) => id === namespaceId)?.attributes.find(({ id }) => id === attributeId)?.read;
  if (!read) return false;
  const actual = read(input);
  if (actual === undefined) return false;
  switch (operator) {
    case "eq": return actual === value;
    case "ne": return actual !== value;
    case "gt": return typeof actual === "number" && typeof value === "number" && actual > value;
    case "gte": return typeof actual === "number" && typeof value === "number" && actual >= value;
    case "lte": return typeof actual === "number" && typeof value === "number" && actual <= value;
  }
}
