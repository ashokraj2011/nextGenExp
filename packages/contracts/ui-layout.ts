import { z } from "zod";
import { capabilityIdSchema } from "./agentic";
import { routingIntents, type RoutingIntentId } from "./routing-intents";

export const layoutComponents = [
  { id: "PznComparison", label: "Balance comparison", description: "Compare definitions in two columns." },
  { id: "PznMetricSummary", label: "Balance figures", description: "Show the available and current amounts." },
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
const intents = routingIntents.map(({ intentId }) => intentId) as [RoutingIntentId, ...RoutingIntentId[]];
export const uiTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("intent"), id: z.enum(intents) }).strict(),
  z.object({ kind: z.literal("capability"), id: capabilityIdSchema }).strict(),
]);
export type UiTarget = z.infer<typeof uiTargetSchema>;
export const targetKey = (target: UiTarget) => target.kind + ":" + target.id;

export const layoutTextSchema = z.object({
  heading: z.string().trim().max(90),
  body: z.string().trim().max(320),
  tone: z.enum(["plain", "accent"]),
}).strict();
const slotId = z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/);
export const layoutSlotSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("block"), id: slotId, component: z.enum(ids) }).strict(),
  layoutTextSchema.extend({ kind: z.literal("text"), id: slotId }),
]);
export type LayoutSlot = z.infer<typeof layoutSlotSchema>;
export const uiDesignSchema = z.object({
  name: z.string().trim().min(1).max(72),
  description: z.string().trim().max(maxLayoutDescription),
  layout: z.enum(["stack", "dashboard"]),
  slots: z.array(layoutSlotSchema).max(maxLayoutSlots).refine((slots) => new Set(slots.map(({ id }) => id)).size === slots.length),
  targets: z.array(uiTargetSchema).max(maxLayoutTargets).refine((targets) => new Set(targets.map(targetKey)).size === targets.length),
}).strict();
export type UiDesign = z.infer<typeof uiDesignSchema>;
export type UiPublication = { id: string; revision: number; design: UiDesign };
export type UiLayoutRecord = {
  id: string;
  revision: number;
  updatedAt: number;
  draft: UiDesign;
  published?: UiPublication;
};
export type UiTargetOption = { target: UiTarget; label: string; description: string };
export type UiLayoutCatalog = { layouts: UiLayoutRecord[]; targets: UiTargetOption[] };
export type AppliedUiLayout = { id: string; revision: number; name: string; target: UiTarget };

const recordId = z.string().regex(/^ui_[a-f0-9]{32}$/);
const revision = z.number().int().positive();
export const uiLayoutChangeSchema = z.union([
  z.object({ operation: z.enum(["draft", "publish"]), design: uiDesignSchema }).strict(),
  z.object({ operation: z.enum(["draft", "publish"]), id: recordId, revision, design: uiDesignSchema }).strict(),
  z.object({ operation: z.literal("unpublish"), id: recordId, revision }).strict(),
]);
export type UiLayoutChange = z.infer<typeof uiLayoutChangeSchema>;

export function uiIntentHints(layouts: UiPublication[] | undefined, activeIntents: readonly RoutingIntentId[]) {
  return (layouts ?? []).flatMap(({ design }) => design.targets.flatMap((target) => (
    target.kind === "intent" && activeIntents.includes(target.id) ? [{ intentId: target.id, description: design.description.slice(0, maxUiHintLength) }] : []
  ))).slice(0, maxUiIntentHints);
}
