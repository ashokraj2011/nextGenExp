import { z } from "zod";
import { domainPackIds, type DomainPackId } from "./domain-packs";
import { capabilityIdSchema } from "./agentic";
import { dataBindingKeySchema } from "./data-bindings";
import type { RoutingIntentId } from "./routing-intents";

export const layoutComponents = [
  { id: "PznComparison", label: "Balance comparison", description: "Compare definitions in two columns." },
  { id: "PznMetricSummary", label: "Balance figures", description: "Show the available and current amounts." },
  { id: "PznRetirementAccounts", label: "Retirement accounts", description: "Show the customer’s accounts or the beneficiary on the selected account." },
  { id: "PznPortfolioSnapshot", label: "Portfolio snapshot", description: "Show portfolio value, cash, and holdings." },
  { id: "PznGoalProgress", label: "Goal progress", description: "Show savings history and progress toward a target." },
  { id: "PznSavingsChart", label: "Savings projection", description: "Chart projected savings over time." },
  { id: "PznSavingsMetric", label: "Required contribution", description: "Show the monthly amount needed to reach a goal." },
  { id: "PznContentCard", label: "Information card", description: "Display an explanation or eligible recommendation." },
  { id: "PznStepList", label: "Step-by-step guide", description: "Display the approved steps for a task." },
  { id: "PznFundingOptions", label: "Funding methods", description: "Show the available funding methods." },
  { id: "PznFundingPreview", label: "Funding review", description: "Show an amount and method for review." },
  { id: "PznCapabilityForm", label: "Input form", description: "Show inputs supplied by a capability, such as dates and amounts." },
  { id: "PznFactSummary", label: "Result summary", description: "Display the status of a completed or outstanding step." },
  { id: "PznDynamicCanvas", label: "Record view", description: "Show the selected record, timeline, or list of choices." },
  { id: "PznRuleCreation", label: "Rule editor", description: "Show the rule-building controls." },
] as const;
export type LayoutComponent = typeof layoutComponents[number]["id"];
export const maxLayouts = 24;
export const maxLayoutSlots = 8;
export const maxLayoutTargets = 6;
export const maxLayoutDescription = 200;
export const maxUiIntentHints = 6;
export const maxUiHintLength = 120;
const ids = layoutComponents.map(({ id }) => id) as [LayoutComponent, ...LayoutComponent[]];
export const recordLayoutCapabilities = ["ops_incident", "sales_deal_desk"] as const;
const intentIdSchema = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);
export const uiTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("intent"), id: intentIdSchema }).strict(),
  z.object({ kind: z.literal("capability"), id: capabilityIdSchema.or(z.enum(recordLayoutCapabilities)) }).strict(),
]);
export type UiTarget = z.infer<typeof uiTargetSchema>;
export const recordCapabilities = { it_ops: "ops_incident", sales_revops: "sales_deal_desk" } as const;
export const recordViews = ["list", "detail", "timeline"] as const;
export type RecordDomain = keyof typeof recordCapabilities;
export type RecordView = typeof recordViews[number];
export const recordIntentId = (domain: RecordDomain, view: RecordView) => domain + "_" + view;
export function layoutTargetDomain(target: UiTarget): DomainPackId {
  if (target.kind === "intent") {
    if (target.id.startsWith("it_ops_")) return "it_ops";
    if (target.id.startsWith("sales_revops_")) return "sales_revops";
  }
  if (target.kind === "capability" && target.id === "ops_incident") return "it_ops";
  if (target.kind === "capability" && target.id === "sales_deal_desk") return "sales_revops";
  return "wealth";
}
export const targetKey = (target: UiTarget) => target.kind + ":" + target.id;

export const layoutTextSchema = z.object({
  heading: z.string().trim().max(90),
  body: z.string().trim().max(320),
  tone: z.enum(["plain", "accent"]),
}).strict();
export function bindingDomain(key: string): DomainPackId {
  if (key.startsWith("incident.")) return "it_ops";
  if (key.startsWith("deal.")) return "sales_revops";
  return "wealth";
}

const slotId = z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/);
export const customFormFieldTypeSchema = z.enum(["text", "number", "currency", "select", "date", "checkbox"]);
export type CustomFormFieldType = z.infer<typeof customFormFieldTypeSchema>;
export const customFormFieldSchema = z.object({
  id: slotId,
  label: z.string().trim().min(1).max(80),
  type: customFormFieldTypeSchema,
  placeholder: z.string().trim().max(100),
  required: z.boolean(),
  options: z.array(z.string().trim().min(1).max(60)).max(10),
  defaultBinding: dataBindingKeySchema.optional(),
  initialValue: z.string().max(120).optional(),
}).strict();
export type CustomFormField = z.infer<typeof customFormFieldSchema>;
export const layoutFormSchema = z.object({
  title: z.string().trim().max(90),
  description: z.string().trim().max(240),
  submitLabel: z.string().trim().max(48),
  writeBack: z.boolean().optional(),
  fields: z.array(customFormFieldSchema).max(10),
}).strict();
export type LayoutFormProps = z.infer<typeof layoutFormSchema>;

export const boundWidgetMetricSchema = z.object({
  id: slotId,
  label: z.string().trim().min(1).max(60),
  binding: dataBindingKeySchema.optional(),
  staticValue: z.string().trim().max(60),
  subtext: z.string().trim().max(80),
  tone: z.enum(["default", "positive", "caution"]),
}).strict();
export type BoundWidgetMetric = z.infer<typeof boundWidgetMetricSchema>;

export const layoutBoundWidgetSchema = z.object({
  badge: z.string().trim().max(48),
  title: z.string().trim().max(110),
  body: z.string().trim().max(320),
  accentTop: z.boolean(),
  metrics: z.array(boundWidgetMetricSchema).max(6),
  progressLabel: z.string().trim().max(60).optional(),
  progressBinding: dataBindingKeySchema.optional(),
  ctaLabel: z.string().trim().max(48).optional(),
  ctaPrompt: z.string().trim().max(200).optional(),
}).strict();
export type LayoutBoundWidget = z.infer<typeof layoutBoundWidgetSchema>;

export const resolvedBoundWidgetSchema = z.object({
  badge: z.string().max(48),
  title: z.string().max(160),
  body: z.string().max(420),
  accentTop: z.boolean(),
  hydratedFor: z.string().max(80).optional(),
  metrics: z.array(z.object({
    id: slotId,
    label: z.string().max(60),
    value: z.string().max(80),
    subtext: z.string().max(100),
    tone: z.enum(["default", "positive", "caution"]),
    boundKey: dataBindingKeySchema.optional(),
  }).strict()).max(6),
  progressLabel: z.string().max(80).optional(),
  progressPercent: z.number().min(0).max(100).optional(),
  progressDisplay: z.string().max(40).optional(),
  ctaLabel: z.string().max(48).optional(),
  ctaPrompt: z.string().max(200).optional(),
}).strict();
export type ResolvedBoundWidgetProps = z.infer<typeof resolvedBoundWidgetSchema>;

export const layoutSlotSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("block"), id: slotId, component: z.enum(ids) }).strict(),
  layoutTextSchema.extend({ kind: z.literal("text"), id: slotId }),
  layoutFormSchema.extend({ kind: z.literal("form"), id: slotId }),
  layoutBoundWidgetSchema.extend({ kind: z.literal("widget"), id: slotId }),
]);
export type LayoutSlot = z.infer<typeof layoutSlotSchema>;
const recordIntentSchema = z.object({
  id: z.string().regex(/^(it_ops|sales_revops)_intent_[a-z0-9_]{1,35}$/),
  label: z.string().trim().min(1).max(60),
  view: z.enum(recordViews),
  phrases: z.array(z.string().trim().min(3).max(120)).min(1).max(8),
}).strict();
export type RecordIntent = z.infer<typeof recordIntentSchema>;
export const normalizedIntentPhrase = (phrase: string) => phrase.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export function recordIntentOption(intent: RecordIntent): UiTargetOption {
  return { target: { kind: "intent", id: intent.id }, label: intent.label, description: intent.phrases.join(" · "), components: ["PznDynamicCanvas"] };
}
export const uiDesignSchema = z.object({
  recordIntent: recordIntentSchema.optional(),
  name: z.string().trim().min(1).max(72),
  description: z.string().trim().max(maxLayoutDescription),
  layout: z.enum(["stack", "dashboard"]),
  slots: z.array(layoutSlotSchema).max(maxLayoutSlots).refine((slots) => new Set(slots.map(({ id }) => id)).size === slots.length),
  targets: z.array(uiTargetSchema).max(maxLayoutTargets).refine((targets) => new Set(targets.map(targetKey)).size === targets.length),
}).strict();
export type UiDesign = z.infer<typeof uiDesignSchema>;
export type UiPublication = { id: string; revision: number; design: UiDesign };
export type LibraryDesign = UiPublication & { domainId: DomainPackId };
export type UiLayoutRecord = {
  id: string;
  domainId: DomainPackId;
  revision: number;
  updatedAt: number;
  draft: UiDesign;
  published?: UiPublication;
};
export type UiTargetOption = { target: UiTarget; label: string; description: string; components?: LayoutComponent[] };
export type UiLayoutCatalog = { tenantId: string; domains: readonly DomainPackId[]; layouts: UiLayoutRecord[]; library: LibraryDesign[]; targets: UiTargetOption[] };
export type AppliedUiLayout = { id: string; revision: number; name: string; target: UiTarget };

const recordId = z.string().regex(/^ui_[a-f0-9]{32}$/);
const revision = z.number().int().positive();
const domainId = z.enum(domainPackIds).optional();
export const uiLayoutChangeSchema = z.union([
  z.object({ operation: z.enum(["draft", "publish"]), domainId, design: uiDesignSchema }).strict(),
  z.object({ operation: z.enum(["draft", "publish"]), id: recordId, revision, domainId, design: uiDesignSchema }).strict(),
  z.object({ operation: z.literal("unpublish"), id: recordId, revision }).strict(),
]);
export type UiLayoutChange = z.infer<typeof uiLayoutChangeSchema>;

export function uiIntentHints(layouts: UiPublication[] | undefined, activeIntents: readonly RoutingIntentId[]) {
  return (layouts ?? []).flatMap(({ design }) => design.targets.flatMap((target) => (
    target.kind === "intent" && activeIntents.includes(target.id) ? [{ intentId: target.id, description: design.description.slice(0, maxUiHintLength) }] : []
  ))).slice(0, maxUiIntentHints);
}
