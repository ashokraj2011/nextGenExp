import { Catalog, ChildListSchema, CreateSurfaceMessageSchema, DynamicStringSchema, PayloadValidator } from "@a2ui/web_core/v1_0";
import type { CreateSurfaceMessage } from "@a2ui/web_core/v1_0";
import { z } from "zod";
import { comparisonFieldSchema, metricValueSchema, stepSchema } from "./domain";
import { portfolioSnapshotSchema } from "./portfolio";
import { ruleGlossarySchema } from "./rule-glossary";

export const PZN_CATALOG_ID = "https://pzn.example.invalid/catalogs/v1.0/experience";
export const MAX_SURFACE_BYTES = 256 * 1024;
export const MAX_SURFACE_NODES = 80;
export const FOLLOW_UP_EVENT = "request_follow_up";
const limitedText = z.string().min(1).max(6000);
const id = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).max(128);
const sourceSchema = z.object({ title: limitedText, label: limitedText, version: limitedText, ref: z.string().startsWith("fixture:") }).strict();
const shared = {
  variant: z.enum(["compact", "expanded"]),
  title: limitedText,
  sources: z.array(sourceSchema).min(1).max(2),
  disclosures: z.array(limitedText).min(1).max(8),
};
export const contentCard = { name: "PznContentCard", schema: z.object({
  ...shared, description: limitedText, body: limitedText, recommendation: z.literal(true).optional(),
}).strict() } as const;
export const comparison = { name: "PznComparison", schema: z.object({
  ...shared, columns: z.array(z.object({ title: limitedText, fields: z.array(comparisonFieldSchema).min(1).max(12) }).strict()).length(2),
}).strict() } as const;
export const stepList = { name: "PznStepList", schema: z.object({
  ...shared, body: limitedText, steps: z.array(stepSchema).min(1).max(12),
}).strict() } as const;
export const metricSummary = { name: "PznMetricSummary", schema: z.object({
  ...shared, observedAt: z.string().datetime(), values: z.array(metricValueSchema).min(1).max(2),
}).strict() } as const;
export const experienceRoot = { name: "PznExperience", schema: z.object({
  children: ChildListSchema,
  actionCount: z.number().int().min(0).max(3),
  intro: DynamicStringSchema,
  question: limitedText.nullable(),
  partial: z.boolean(),
}).strict() } as const;
export const followUpButton = { name: "PznFollowUp", schema: z.object({ actionId: id, label: limitedText }).strict() } as const;
const demoKey = z.string().regex(/^[a-z][a-z0-9-]*$/).max(128);
export const ruleCreation = { name: "PznRuleCreation", schema: z.object({
  scenarioId: demoKey, personaId: demoKey, glossary: ruleGlossarySchema.optional(),
}).strict() } as const;
export type RuleCreationProps = z.infer<typeof ruleCreation.schema>;
export const portfolioSnapshot = { name: "PznPortfolioSnapshot", schema: portfolioSnapshotSchema } as const;

export const catalogApis = [experienceRoot, contentCard, comparison, stepList, metricSummary, portfolioSnapshot, followUpButton, ruleCreation] as const;
type BlockApi = typeof contentCard | typeof comparison | typeof stepList | typeof metricSummary | typeof portfolioSnapshot;
type ShapeFor<T extends BlockApi> = T extends BlockApi ? { component: T["name"]; props: z.infer<T["schema"]> } : never;
export type DisplayBlock = ShapeFor<BlockApi> | { component: typeof ruleCreation.name; props: RuleCreationProps };
export type DisplayAction = { actionId: string; componentId: string; label: string };
export type DisplayExperience = {
  experienceId: string;
  messageId: string;
  status: "ready" | "clarify" | "no_match";
  outcome: "ready" | "clarify" | "no_match" | "eligible_empty" | "create_rule";
  intro: string;
  question: string | null;
  partial: boolean;
  blocks: DisplayBlock[];
  actions: DisplayAction[];
  expiresAt: number;
  a2uiVersion: "1.0";
  messages: [CreateSurfaceMessage];
};

const payloadValidator = new PayloadValidator(new Catalog(PZN_CATALOG_ID, "1.0", catalogApis), { allowUnknownElements: false });
const componentEnvelope = z.object({ id, component: z.enum(catalogApis.map((api) => api.name) as [string, ...string[]]) }).passthrough();
const model = z.object({ intro: limitedText }).strict();

export function validatePznSurface(value: unknown, experienceId: string): CreateSurfaceMessage {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_SURFACE_BYTES) throw new Error("Surface payload exceeds limit");
  const message = CreateSurfaceMessageSchema.parse(value);
  const { surfaceId, catalogId, dataModel, components, sendDataModel, metadata } = message.createSurface;
  if (surfaceId !== experienceId || catalogId !== PZN_CATALOG_ID || sendDataModel || metadata || !components?.length
    || components.length > MAX_SURFACE_NODES) throw new Error("Invalid experience surface envelope");
  model.parse(dataModel);
  const nodes = components.map((value) => {
    const node = componentEnvelope.parse(value);
    payloadValidator.validateComponent(node);
    return node;
  });
  const root = nodes[0];
  const actionCount = root.actionCount;
  const referenced = Array.isArray(root.children) ? root.children : [];
  const leafNodes = new Map(nodes.slice(1).map((node) => [node.id, node.component]));
  const uniqueReferences = new Set(referenced);
  if (root.id !== "root" || root.component !== "PznExperience" || nodes.slice(1).some((node) => node.component === "PznExperience" || node.id === "root")
    || leafNodes.size !== nodes.length - 1 || referenced.length !== leafNodes.size
    || uniqueReferences.size !== referenced.length || typeof actionCount !== "number" || actionCount > referenced.length
    || referenced.some((ref, index) => !leafNodes.has(ref)
      || (leafNodes.get(ref) === "PznFollowUp") !== (index >= referenced.length - actionCount))) {
    throw new Error("Invalid experience component references");
  }
  if (JSON.stringify(root.intro) !== JSON.stringify({ "@path": "/intro" })) throw new Error("Invalid experience data binding");
  return message;
}
