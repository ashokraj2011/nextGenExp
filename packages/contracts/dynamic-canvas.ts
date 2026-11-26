import { z } from "zod";

const shortText = z.string().trim().min(1).max(160);
const bodyText = z.string().trim().min(1).max(600);

export const dynamicMetricsNodeSchema = z.object({
  type: z.literal("metrics"),
  items: z.array(z.object({
    label: z.string().trim().min(1).max(48),
    value: z.string().trim().min(1).max(36),
    delta: z.string().trim().max(32).optional(),
  }).strict()).min(1).max(4),
}).strict();

export const dynamicTableNodeSchema = z.object({
  type: z.literal("table"),
  caption: z.string().trim().max(90).optional(),
  columns: z.array(z.string().trim().min(1).max(40)).min(2).max(5),
  rows: z.array(z.array(z.string().trim().max(80)).min(2).max(5)).min(1).max(10),
}).strict();

export const dynamicBarChartNodeSchema = z.object({
  type: z.literal("barchart"),
  title: z.string().trim().max(90).optional(),
  unit: z.enum(["usd", "percent", "number"]).optional(),
  bars: z.array(z.object({
    label: z.string().trim().min(1).max(48),
    value: z.number().min(0),
    displayValue: z.string().trim().min(1).max(32),
    highlight: z.boolean().optional(),
  }).strict()).min(2).max(8),
}).strict();

export const dynamicPieChartNodeSchema = z.object({
  type: z.literal("piechart"),
  title: z.string().trim().max(90).optional(),
  centerLabel: z.string().trim().max(32).optional(),
  centerValue: z.string().trim().max(32).optional(),
  slices: z.array(z.object({
    label: z.string().trim().min(1).max(48),
    value: z.number().min(0),
    displayValue: z.string().trim().min(1).max(32),
    color: z.string().trim().max(24).optional(),
    highlight: z.boolean().optional(),
  }).strict()).min(2).max(8),
}).strict();

export const dynamicProgressNodeSchema = z.object({
  type: z.literal("progress"),
  label: shortText,
  current: z.number().min(0),
  target: z.number().positive(),
  currentDisplay: z.string().trim().min(1).max(32),
  targetDisplay: z.string().trim().min(1).max(32),
}).strict();

export const dynamicSliderCalcNodeSchema = z.object({
  type: z.literal("sliders"),
  title: z.string().trim().max(90).optional(),
  formula: z.enum(["compound_monthly", "annual_yield", "simple_total"]),
  resultLabel: z.string().trim().min(1).max(48),
  inputs: z.array(z.object({
    id: z.enum(["amount", "monthly", "rate", "years"]),
    label: z.string().trim().min(1).max(48),
    min: z.number(),
    max: z.number(),
    step: z.number().positive(),
    value: z.number(),
    unit: z.enum(["usd", "percent", "years"]),
  }).strict()).min(1).max(3),
}).strict();

export const dynamicComparisonNodeSchema = z.object({
  type: z.literal("comparison"),
  columns: z.array(z.object({
    title: z.string().trim().min(1).max(56),
    points: z.array(shortText).min(1).max(6),
  }).strict()).length(2),
}).strict();

export const dynamicChecklistNodeSchema = z.object({
  type: z.literal("checklist"),
  title: z.string().trim().max(90).optional(),
  items: z.array(shortText).min(1).max(8),
}).strict();

export const dynamicCalloutNodeSchema = z.object({
  type: z.literal("callout"),
  tone: z.enum(["info", "highlight", "caution"]),
  title: z.string().trim().max(90).optional(),
  body: bodyText,
}).strict();

export const dynamicFormNodeSchema = z.object({
  type: z.literal("form"),
  title: z.string().trim().max(90).optional(),
  submitLabel: z.string().trim().min(1).max(48),
  fields: z.array(z.object({
    id: z.string().trim().min(1).max(40),
    label: z.string().trim().min(1).max(60),
    type: z.enum(["text", "number", "currency", "select", "date", "checkbox"]),
    placeholder: z.string().trim().max(80).optional(),
    required: z.boolean().optional(),
    options: z.array(z.string().trim().min(1).max(50)).max(8).optional(),
    defaultValue: z.string().trim().max(80).optional(),
  }).strict()).min(1).max(8),
}).strict();

export const dynamicApprovalNodeSchema = z.object({
  type: z.literal("approval"),
  title: z.string().trim().min(1).max(120),
  summary: bodyText,
  requester: z.string().trim().max(80).optional(),
  riskLevel: z.enum(["low", "medium", "high"]).optional(),
  details: z.array(z.object({
    label: z.string().trim().min(1).max(64),
    value: z.string().trim().min(1).max(160),
  }).strict()).min(1).max(8),
  approveLabel: z.string().trim().min(1).max(40),
  rejectLabel: z.string().trim().min(1).max(40),
  recordId: z.string().trim().max(64).optional(),
  domain: z.enum(["ops_incident", "sales_deal", "external_connector", "stock_trade", "workflow", "generic"]).optional(),
  expectedUpdatedAt: z.string().max(64).optional(),
  approvalId: z.string().trim().max(64).optional(),
  payloadDigest: z.string().trim().max(128).optional(),
  dualControl: z.boolean().optional(),
  sfieldToolRef: z.string().trim().max(80).optional(),
  initialDecision: z.enum(["pending", "approved", "rejected"]).optional(),
  decisionNote: z.string().trim().max(240).optional(),
}).strict();

export const dynamicTimelineNodeSchema = z.object({
  type: z.literal("timeline"),
  title: z.string().trim().max(90).optional(),
  events: z.array(z.object({
    time: z.string().trim().min(1).max(36),
    title: z.string().trim().min(1).max(80),
    detail: z.string().trim().max(160).optional(),
    owner: z.string().trim().max(48).optional(),
    status: z.enum(["done", "active", "pending", "blocked"]),
  }).strict()).min(2).max(8),
}).strict();

export const dynamicTradeTicketNodeSchema = z.object({
  type: z.literal("trade_ticket"),
  personaId: z.string().trim().min(1).max(64),
  actorName: z.string().trim().min(1).max(80),
  side: z.enum(["buy", "sell"]),
  symbol: z.string().trim().min(1).max(12),
  companyName: z.string().trim().min(1).max(64),
  existingShares: z.number().int().nonnegative(),
  avgCostCents: z.number().int().nonnegative(),
  priceCents: z.number().int().positive(),
  holdingPeriod: z.enum(["long_term", "short_term"]),
  cashBalanceCents: z.number().int().nonnegative(),
  equityTotalCents: z.number().int().nonnegative(),
  fixedIncomeCents: z.number().int().nonnegative(),
  suggestedPercent: z.number().min(1).max(100).optional(),
  suggestedShares: z.number().int().positive().optional(),
  askTaxHarvest: z.boolean(),
  initialStage: z.enum(["configure", "tax_analysis", "running"]).optional(),
  initialJobId: z.string().trim().max(80).optional(),
  washSaleWarnings: z.array(z.string().max(240)).max(6).optional(),
  holdings: z.array(z.object({
    symbol: z.string().trim().min(1).max(12),
    name: z.string().trim().min(1).max(64),
    shares: z.number().int().nonnegative(),
    avgCostCents: z.number().int().nonnegative(),
    priceCents: z.number().int().positive(),
  }).strict()).min(1).max(12),
}).strict();

export const dynamicWorkflowRunnerNodeSchema = z.object({
  type: z.literal("workflow_runner"),
  runId: z.string().trim().min(1).max(80),
  workflowId: z.string().trim().min(1).max(64),
  workflowName: z.string().trim().min(1).max(80),
}).strict();

export const dynamicNodeSchema = z.discriminatedUnion("type", [
  dynamicMetricsNodeSchema,
  dynamicTableNodeSchema,
  dynamicBarChartNodeSchema,
  dynamicPieChartNodeSchema,
  dynamicProgressNodeSchema,
  dynamicSliderCalcNodeSchema,
  dynamicComparisonNodeSchema,
  dynamicChecklistNodeSchema,
  dynamicCalloutNodeSchema,
  dynamicFormNodeSchema,
  dynamicApprovalNodeSchema,
  dynamicTimelineNodeSchema,
  dynamicTradeTicketNodeSchema,
  dynamicWorkflowRunnerNodeSchema,
]);

export type DynamicCanvasNode = z.infer<typeof dynamicNodeSchema>;

export const harnessTraceStepSchema = z.object({
  stage: z.enum(["plan", "fetch", "compose", "verify", "repair"]),
  status: z.enum(["ok", "repaired", "skipped", "needs_data"]),
  summary: z.string().trim().min(1).max(200),
  durationMs: z.number().int().min(0).optional(),
}).strict();

export const harnessTraceSchema = z.object({
  resolvedGoal: z.string().trim().min(1).max(220),
  fetchedSources: z.array(z.string().trim().min(1).max(64)).max(8),
  visualTargets: z.array(z.string().trim().min(1).max(32)).max(6),
  repaired: z.boolean(),
  stages: z.array(harnessTraceStepSchema).min(1).max(8),
}).strict();

export type DynamicHarnessTrace = z.infer<typeof harnessTraceSchema>;

export const dynamicCanvasSchema = z.object({
  title: z.string().trim().min(1).max(96),
  badge: z.string().trim().min(1).max(44),
  subtitle: z.string().trim().max(260).optional(),
  generatedBy: z.enum(["llm", "synthesizer"]),
  dataSource: z.string().trim().max(120).optional(),
  recordId: z.string().trim().max(64).optional(),
  prompt: z.string().trim().max(600).optional(),
  nodes: z.array(dynamicNodeSchema).min(1).max(6),
  disclaimer: z.string().trim().min(1).max(240),
  choices: z.array(z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(120) }).strict()).max(12).optional(),
  suggestedFollowUp: z.string().trim().max(160).optional(),
  harnessTrace: harnessTraceSchema.optional(),
}).strict();

export type DynamicCanvasProps = z.infer<typeof dynamicCanvasSchema>;
