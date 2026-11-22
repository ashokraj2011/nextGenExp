import { z } from "zod";

export const glossaryOperators = ["eq", "ne", "gt", "gte", "lte"] as const;
export const glossaryValueTypes = ["enum", "boolean", "integer"] as const;
export const glossaryOperatorLabels = { eq: "Equals", ne: "Does not equal", gt: "Greater than", gte: "At least", lte: "At most" } as const;
const operatorSymbols = { eq: "==", ne: "!=", gt: ">", gte: ">=", lte: "<=" } as const;

const key = z.string().regex(/^[a-z][a-z0-9_-]*$/).max(64);
const label = z.string().min(1).max(100);
const version = z.string().min(1).max(64);
const integer = z.number().int().safe();
const attributeSchema = z.object({
  id: key,
  label,
  description: z.string().min(1).max(240),
  valueType: z.enum(glossaryValueTypes),
  operators: z.array(z.enum(glossaryOperators)).min(1).max(glossaryOperators.length),
  options: z.array(z.object({ value: key, label }).strict()).max(16),
  minimum: integer.nullable(),
}).strict();

export const ruleGlossarySchema = z.object({
  version,
  namespaces: z.array(z.object({
    id: key,
    label,
    attributes: z.array(attributeSchema).min(1).max(8),
  }).strict()).min(1).max(8),
}).strict();
export type RuleGlossary = z.infer<typeof ruleGlossarySchema>;
export type GlossaryAttribute = z.infer<typeof attributeSchema>;
export type GlossaryOperator = typeof glossaryOperators[number];

export const glossaryConditionSchema = z.object({
  kind: z.literal("attribute"),
  glossaryVersion: version,
  namespaceId: key,
  attributeId: key,
  operator: z.enum(glossaryOperators),
  value: z.union([key, integer, z.boolean()]),
}).strict();
export type GlossaryCondition = z.infer<typeof glossaryConditionSchema>;

export function glossaryAllowsCondition(glossary: RuleGlossary, condition: GlossaryCondition) {
  const { glossaryVersion, namespaceId, attributeId, operator, value } = condition;
  if (glossaryVersion !== glossary.version) return false;
  const attribute = glossary.namespaces.find(({ id }) => id === namespaceId)?.attributes.find(({ id }) => id === attributeId);
  if (!attribute?.operators.includes(operator)) return false;
  switch (attribute.valueType) {
    case "enum": return attribute.options.some((option) => option.value === value);
    case "boolean": return typeof value === "boolean";
    case "integer": return typeof value === "number" && Number.isSafeInteger(value) && (attribute.minimum === null || value >= attribute.minimum);
  }
}

export function formatGlossaryCondition({ namespaceId, attributeId, operator, value }: GlossaryCondition) {
  return `${namespaceId}.${attributeId} ${operatorSymbols[operator]} ${JSON.stringify(value)}`;
}
