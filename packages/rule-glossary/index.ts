import host from "../../fixtures/host.json";
import { glossaryAllowsCondition, ruleGlossarySchema, type GlossaryAttribute, type GlossaryCondition, type RuleGlossary } from "../contracts/rule-glossary";
import { findProfileById } from "../customer-profiles/registry";

type RuleInput = {
  personaId: string;
  ordinal: number;
  beneficiaryStatus?: "missing" | "on_file";
  portfolioCashCents?: number;
  fundingStatus?: "funded" | "unfunded";
  extraAttributes?: Readonly<Record<string, string | number | boolean>>;
};
type AttributeDefinition = GlossaryAttribute & { read: (input: RuleInput) => GlossaryCondition["value"] | undefined };

const namespaces = [
  {
    id: "customer", label: "Customer",
    attributes: [
      {
        id: "persona", label: "Demo profile", description: "The demo customer used for the preview or chat message.",
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
        read: ({ personaId, beneficiaryStatus }) => beneficiaryStatus ?? findProfileById(personaId)?.beneficiaryStatus ?? host.personas.find((persona) => persona.personaId === personaId)?.beneficiaryStatus,
      },
    ],
  },
  {
    id: "account", label: "Account",
    attributes: [
      {
        id: "funding_status", label: "Funding status", description: "Whether the demo account has received its first deposit.",
        valueType: "enum", operators: ["eq", "ne"], minimum: null,
        options: [{ value: "unfunded", label: "Unfunded" }, { value: "funded", label: "Funded" }],
        read: ({ personaId, fundingStatus }) => fundingStatus ?? findProfileById(personaId)?.accountFundingStatus ?? host.personas.find((persona) => persona.personaId === personaId)?.accountFundingStatus,
      },
    ],
  },
  {
    id: "conversation", label: "Conversation",
    attributes: [
      {
        id: "turn_number", label: "Message number", description: "The first request is 1, the next is 2, and so on.",
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

export function buildDynamicRuleGlossary(extraNamespaces: RuleGlossary["namespaces"] = []): RuleGlossary {
  if (extraNamespaces.length === 0) return mockRuleGlossary;
  const seen = new Set(mockRuleGlossary.namespaces.map((n) => n.id));
  const merged = [...mockRuleGlossary.namespaces];
  for (const ns of extraNamespaces) {
    if (seen.has(ns.id) || ns.attributes.length === 0) continue;
    seen.add(ns.id);
    merged.push(ns);
  }
  return ruleGlossarySchema.parse({
    version: mockRuleGlossary.version,
    namespaces: merged.slice(0, 24),
  });
}

export function matchesGlossaryCondition(
  condition: GlossaryCondition,
  input: RuleInput,
  glossary: RuleGlossary = mockRuleGlossary,
) {
  const effectiveGlossary = glossary;
  const { namespaceId, attributeId, operator, value } = condition;
  const staticRead = namespaces.find(({ id }) => id === namespaceId)?.attributes.find(({ id }) => id === attributeId)?.read;
  if (staticRead) {
    if (!glossaryAllowsCondition(effectiveGlossary, condition)) return false;
    const actual = staticRead(input);
    if (actual === undefined) return false;
    return compareGlossaryValues(actual, operator, value);
  }
  // Dynamic attribute (e.g. projected from a published smass virtual model)
  const extraKey = `${namespaceId}.${attributeId}`;
  const actual = input.extraAttributes?.[extraKey];
  if (actual === undefined) return false;
  if (effectiveGlossary !== mockRuleGlossary && !glossaryAllowsCondition(effectiveGlossary, condition)) return false;
  return compareGlossaryValues(actual, operator, value);
}

function compareGlossaryValues(
  actual: string | number | boolean,
  operator: GlossaryCondition["operator"],
  value: GlossaryCondition["value"],
): boolean {
  switch (operator) {
    case "eq": return actual === value;
    case "ne": return actual !== value;
    case "gt": return typeof actual === "number" && typeof value === "number" && actual > value;
    case "gte": return typeof actual === "number" && typeof value === "number" && actual >= value;
    case "lte": return typeof actual === "number" && typeof value === "number" && actual <= value;
  }
}
