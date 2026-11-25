import { z } from "zod";

export const tradeSideSchema = z.enum(["buy", "sell"]);
export const holdingPeriodSchema = z.enum(["long_term", "short_term"]);

export const equityHoldingSchema = z.object({
  symbol: z.string().trim().min(1).max(12),
  name: z.string().trim().min(1).max(64),
  sector: z.string().trim().min(1).max(48),
  shares: z.number().int().nonnegative(),
  avgCostCents: z.number().int().nonnegative(),
  priceCents: z.number().int().positive(),
  holdingPeriod: holdingPeriodSchema,
}).strict();

export const tradeLegInputSchema = z.object({
  symbol: z.string().trim().min(1).max(12),
  side: tradeSideSchema,
  shares: z.number().int().positive().max(1_000_000),
  reason: z.enum(["primary", "tax_harvest"]).default("primary"),
}).strict();

export const taxHarvestPreviewInputSchema = z.object({
  personaId: z.string().trim().min(1).max(64),
  symbol: z.string().trim().min(1).max(12),
  shares: z.number().int().positive().max(1_000_000),
}).strict();

export const tradeJobCreateInputSchema = z.object({
  personaId: z.string().trim().min(1).max(64),
  actor: z.string().trim().min(1).max(80).default("Customer"),
  legs: z.array(tradeLegInputSchema).min(1).max(8),
  taxHarvestAnalyzed: z.boolean().default(false),
  durationSeconds: z.number().int().min(2).max(12).default(5),
}).strict();

export type TradeSide = z.infer<typeof tradeSideSchema>;
export type HoldingPeriod = z.infer<typeof holdingPeriodSchema>;
export type EquityHolding = z.infer<typeof equityHoldingSchema>;
export type TradeLegInput = z.infer<typeof tradeLegInputSchema>;
export type TaxHarvestPreviewInput = z.infer<typeof taxHarvestPreviewInputSchema>;
export type TradeJobCreateInput = z.input<typeof tradeJobCreateInputSchema>;

export interface TaxHarvestRecommendation {
  symbol: string;
  name: string;
  sector: string;
  availableShares: number;
  recommendedShares: number;
  avgCostCents: number;
  priceCents: number;
  lossPerShareCents: number;
  estimatedLossCents: number;
  holdingPeriod: HoldingPeriod;
  replacementHint: string;
}

export interface TaxHarvestAnalysis {
  personaId: string;
  primarySymbol: string;
  primaryName: string;
  primaryShares: number;
  primaryProceedsCents: number;
  primaryCostBasisCents: number;
  realizedGainCents: number;
  holdingPeriod: HoldingPeriod;
  effectiveTaxRatePct: number;
  estimatedTaxBeforeCents: number;
  recommendations: TaxHarvestRecommendation[];
  totalHarvestableLossCents: number;
  netTaxableGainCents: number;
  estimatedTaxAfterCents: number;
  estimatedTaxSavingsCents: number;
  feedbackSummary: string;
  washSaleNotice: string;
}

export interface TradeFillReceipt {
  symbol: string;
  name: string;
  side: TradeSide;
  reason: "primary" | "tax_harvest";
  shares: number;
  fillPriceCents: number;
  grossAmountCents: number;
  realizedGainLossCents: number;
  previousShares: number;
  newShares: number;
}

export interface PortfolioBalanceSnapshot {
  cashCents: number;
  equityCents: number;
  fixedIncomeCents: number;
  totalCents: number;
  holdings: EquityHolding[];
}

export type TradeJobStatus = "queued" | "validating" | "routing" | "executing" | "settling" | "completed" | "failed";

export interface TradeJob {
  jobId: string;
  personaId: string;
  actor: string;
  status: TradeJobStatus;
  stageLabel: string;
  progressPct: number;
  durationSeconds: number;
  elapsedSeconds: number;
  remainingSeconds: number;
  createdAt: string;
  completedAt?: string;
  taxHarvestAnalyzed: boolean;
  legs: TradeLegInput[];
  receipts?: TradeFillReceipt[];
  beforeSnapshot?: PortfolioBalanceSnapshot;
  afterSnapshot?: PortfolioBalanceSnapshot;
  sfieldRunId?: string;
  auditId?: string;
  summary?: string;
  error?: string;
}
