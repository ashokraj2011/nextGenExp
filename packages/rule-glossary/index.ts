import host from "../../fixtures/host.json";
import { glossaryAllowsCondition, ruleGlossarySchema, type GlossaryAttribute, type GlossaryCondition } from "../contracts/rule-glossary";

type RuleInput = { personaId: string; ordinal: number };
type AttributeDefinition = GlossaryAttribute & { read: (input: RuleInput) => GlossaryCondition["value"] };

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
        id: "is_returning", label: "Returning visitor", description: "True for the Demo returning visitor persona.",
        valueType: "boolean", operators: ["eq", "ne"], options: [], minimum: null,
        read: ({ personaId }) => personaId === "demo-returning",
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
  switch (operator) {
    case "eq": return actual === value;
    case "ne": return actual !== value;
    case "gte": return typeof actual === "number" && typeof value === "number" && actual >= value;
    case "lte": return typeof actual === "number" && typeof value === "number" && actual <= value;
  }
}
