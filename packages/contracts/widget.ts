import { z } from "zod";
import { layoutComponents, type LayoutComponent } from "./ui-layout";

export const widgetKinds = ["kpi", "calculator", "goal", "comparison", "checklist", "advisory"] as const;
export type WidgetKind = typeof widgetKinds[number];

export const widgetKindLabels: Record<WidgetKind, string> = {
  kpi: "KPI & Metrics",
  calculator: "Interactive Calculator",
  goal: "Goal Progress",
  comparison: "Side-by-Side Comparison",
  checklist: "Step Checklist",
  advisory: "Advisory Callout",
};

const componentIds = layoutComponents.map(({ id }) => id) as [LayoutComponent, ...LayoutComponent[]];

export const widgetMetricSchema = z.object({
  label: z.string().trim().min(1).max(48),
  value: z.string().trim().min(1).max(32),
  delta: z.string().trim().max(24).optional(),
}).strict();

export const widgetSliderSchema = z.object({
  id: z.string().trim().min(1).max(32),
  label: z.string().trim().min(1).max(48),
  min: z.number(),
  max: z.number(),
  step: z.number().positive(),
  value: z.number(),
  unit: z.enum(["usd", "percent", "years", "months"]),
}).strict();

export const widgetColumnSchema = z.object({
  title: z.string().trim().min(1).max(48),
  points: z.array(z.string().trim().min(1).max(120)).min(1).max(5),
}).strict();

export const widgetDraftSchema = z.object({
  name: z.string().trim().min(1).max(72),
  kind: z.enum(widgetKinds),
  prompt: z.string().trim().max(600),
  badge: z.string().trim().max(40),
  title: z.string().trim().min(1).max(90),
  body: z.string().trim().max(320),
  ctaLabel: z.string().trim().max(48),
  accentTop: z.boolean(),
  availableForConsumption: z.boolean().optional(),
  recommendedComponent: z.enum(componentIds),
  metrics: z.array(widgetMetricSchema).max(4).optional(),
  sliders: z.array(widgetSliderSchema).max(3).optional(),
  goal: z.object({
    saved: z.number().nonnegative(),
    target: z.number().positive(),
    unitLabel: z.string().trim().max(32).optional(),
  }).strict().optional(),
  columns: z.array(widgetColumnSchema).max(2).optional(),
  steps: z.array(z.string().trim().min(1).max(140)).max(6).optional(),
}).strict();

export type WidgetDraft = z.infer<typeof widgetDraftSchema>;

export const savedWidgetSchema = widgetDraftSchema.extend({
  id: z.string().regex(/^wdg_[a-z0-9]{12,32}$/),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
});

export type SavedWidget = z.infer<typeof savedWidgetSchema>;

export const widgetGenerateRequestSchema = z.object({
  prompt: z.string().trim().min(2).max(600),
}).strict();

export const widgetLibraryChangeSchema = z.union([
  z.object({ operation: z.literal("save"), id: z.string().regex(/^wdg_[a-z0-9]{12,32}$/).optional(), widget: widgetDraftSchema }).strict(),
  z.object({ operation: z.literal("set_availability"), id: z.string().regex(/^wdg_[a-z0-9]{12,32}$/), availableForConsumption: z.boolean() }).strict(),
  z.object({ operation: z.literal("delete"), id: z.string().regex(/^wdg_[a-z0-9]{12,32}$/) }).strict(),
]);

export type WidgetLibraryChange = z.infer<typeof widgetLibraryChangeSchema>;
