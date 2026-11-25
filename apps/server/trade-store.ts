import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  equityHoldingSchema,
  tradeJobCreateInputSchema,
  type EquityHolding,
  type PortfolioBalanceSnapshot,
  type TaxHarvestAnalysis,
  type TaxHarvestRecommendation,
  type TradeFillReceipt,
  type TradeJob,
  type TradeJobCreateInput,
  type TradeSide,
} from "../../packages/contracts/trading";
import type { CustomerProfileStore } from "../../packages/customer-profiles";
import { makeId } from "../../packages/experience/compile";

const DEFAULT_HOLDINGS: EquityHolding[] = [
  { symbol: "AAPL", name: "Apple Inc.", sector: "Technology", shares: 120, avgCostCents: 14850, priceCents: 22840, holdingPeriod: "long_term" },
  { symbol: "MSFT", name: "Microsoft Corp.", sector: "Technology", shares: 45, avgCostCents: 34200, priceCents: 42680, holdingPeriod: "long_term" },
  { symbol: "NVDA", name: "NVIDIA Corp.", sector: "Semiconductors", shares: 60, avgCostCents: 9640, priceCents: 13820, holdingPeriod: "short_term" },
  { symbol: "VOO", name: "Vanguard S&P 500 ETF", sector: "Broad Market ETF", shares: 55, avgCostCents: 46200, priceCents: 54800, holdingPeriod: "long_term" },
  { symbol: "INTC", name: "Intel Corp.", sector: "Semiconductors", shares: 180, avgCostCents: 3420, priceCents: 2240, holdingPeriod: "long_term" },
  { symbol: "BA", name: "Boeing Co.", sector: "Aerospace & Defense", shares: 28, avgCostCents: 21400, priceCents: 16250, holdingPeriod: "short_term" },
  { symbol: "PFE", name: "Pfizer Inc.", sector: "Healthcare", shares: 160, avgCostCents: 3380, priceCents: 2610, holdingPeriod: "long_term" },
];

const REPLACEMENT_HINTS: Record<string, string> = {
  INTC: "Avoid repurchasing INTC for 30 days (IRS wash-sale rule); optionally rotate proceeds into SOXX or SMH.",
  BA: "Avoid repurchasing BA for 30 days (wash-sale rule); optionally rotate into ITA (Aerospace ETF).",
  PFE: "Avoid repurchasing PFE for 30 days (wash-sale rule); optionally rotate into XLV (Healthcare ETF).",
  AAPL: "Avoid repurchasing AAPL for 30 days if realizing a loss; optionally park in XLK or QQQ.",
};

const NAME_TO_SYMBOL: [RegExp, string][] = [
  [/\b(apple|aapl)\b/i, "AAPL"],
  [/\b(microsoft|msft)\b/i, "MSFT"],
  [/\b(nvidia|nvda)\b/i, "NVDA"],
  [/\b(intel|intc)\b/i, "INTC"],
  [/\b(boeing|\bba\b)\b/i, "BA"],
  [/\b(pfizer|pfe)\b/i, "PFE"],
  [/\b(voo|s&p\s*500|vanguard)\b/i, "VOO"],
];

export interface ParsedStockTradePrompt {
  side: TradeSide;
  symbol: string;
  percent?: number;
  shares?: number;
}

export function parseStockTradePrompt(prompt: string): ParsedStockTradePrompt {
  const side: TradeSide = /\b(buy|purchase|acquire|add\s+to)\b/i.test(prompt) && !/\b(sell|trim|liquidate|reduce|exit)\b/i.test(prompt)
    ? "buy"
    : "sell";

  let symbol = "AAPL";
  for (const [pattern, sym] of NAME_TO_SYMBOL) {
    if (pattern.test(prompt)) {
      symbol = sym;
      break;
    }
  }

  const pctMatch = prompt.match(/\b(\d{1,3})\s*(?:%|percent\b)/i);
  const percent = pctMatch ? Math.min(100, Math.max(1, Number(pctMatch[1]))) : undefined;

  const sharesMatch = prompt.match(/\b(\d{1,5})\s*(?:shares?|sh\b|units?)\b/i)
    ?? prompt.match(/\b(?:sell|buy|purchase|trim)\s+(\d{1,5})\s+(?:of\s+)?(?:aapl|apple|msft|microsoft|nvda|nvidia|intc|intel|ba|boeing|pfe|pfizer|voo)\b/i);
  const shares = !percent && sharesMatch ? Math.max(1, Number(sharesMatch[1])) : undefined;

  return {
    side,
    symbol,
    ...(percent ? { percent } : {}),
    ...(shares ? { shares } : {}),
  };
}

interface PersistedTradeState {
  byPersona: Record<string, EquityHolding[]>;
}

export class TradeStore {
  private readonly filePath: string;
  private state: PersistedTradeState;
  private readonly jobs = new Map<string, TradeJob>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(dataDir: string, private readonly profileStore: CustomerProfileStore) {
    this.filePath = join(dataDir, "trades-portfolio.json");
    this.state = this.load();
  }

  private load(): PersistedTradeState {
    if (existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PersistedTradeState>;
        if (raw && raw.byPersona && typeof raw.byPersona === "object") {
          const clean: Record<string, EquityHolding[]> = {};
          for (const [personaId, list] of Object.entries(raw.byPersona)) {
            if (Array.isArray(list)) {
              const valid = list
                .map((h) => equityHoldingSchema.safeParse(h))
                .filter((r): r is { success: true; data: EquityHolding } => r.success)
                .map((r) => r.data);
              if (valid.length > 0) clean[personaId] = valid;
            }
          }
          return { byPersona: clean };
        }
      } catch { /* fall through */ }
    }
    return { byPersona: {} };
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  holdingsFor(personaId: string): EquityHolding[] {
    if (!this.state.byPersona[personaId]) {
      this.state.byPersona[personaId] = DEFAULT_HOLDINGS.map((h) => ({ ...h }));
      this.save();
    }
    return this.state.byPersona[personaId].map((h) => ({ ...h }));
  }

  snapshotFor(personaId: string): PortfolioBalanceSnapshot {
    const profile = this.profileStore.findByPersonaId(personaId);
    const holdings = this.holdingsFor(personaId);
    const holdingsEquityCents = holdings.reduce((sum, h) => sum + h.shares * h.priceCents, 0);
    const cashCents = profile?.cashCents ?? 25_000_00;
    const equityCents = profile ? Math.max(profile.equityCents, 0) : holdingsEquityCents;
    const fixedIncomeCents = profile?.fixedIncomeCents ?? 15_000_00;
    return {
      cashCents,
      equityCents,
      fixedIncomeCents,
      totalCents: cashCents + equityCents + fixedIncomeCents,
      holdings,
    };
  }

  analyzeTaxHarvest(personaId: string, rawSymbol: string, shares: number): TaxHarvestAnalysis {
    const symbol = rawSymbol.toUpperCase();
    const holdings = this.holdingsFor(personaId);
    const primary = holdings.find((h) => h.symbol === symbol);
    if (!primary) throw new Error(`Holding "${symbol}" not found in portfolio.`);
    if (shares > primary.shares) {
      throw new Error(`Requested ${shares} shares of ${symbol}, but only ${primary.shares} shares are currently held.`);
    }

    const primaryProceedsCents = shares * primary.priceCents;
    const primaryCostBasisCents = shares * primary.avgCostCents;
    const realizedGainCents = primaryProceedsCents - primaryCostBasisCents;
    const effectiveTaxRatePct = primary.holdingPeriod === "short_term" ? 24 : 15;
    const estimatedTaxBeforeCents = realizedGainCents > 0
      ? Math.round((realizedGainCents * effectiveTaxRatePct) / 100)
      : 0;

    const lossCandidates = holdings
      .filter((h) => h.symbol !== symbol && h.shares > 0 && h.priceCents < h.avgCostCents)
      .map((h) => ({
        holding: h,
        lossPerShareCents: h.avgCostCents - h.priceCents,
        totalLossCents: (h.avgCostCents - h.priceCents) * h.shares,
      }))
      .sort((a, b) => b.totalLossCents - a.totalLossCents);

    const recommendations: TaxHarvestRecommendation[] = [];
    let remainingGainToOffset = Math.max(0, realizedGainCents);

    for (const candidate of lossCandidates) {
      if (remainingGainToOffset <= 0) break;
      const neededShares = Math.min(
        candidate.holding.shares,
        Math.ceil(remainingGainToOffset / candidate.lossPerShareCents),
      );
      if (neededShares <= 0) continue;
      const estimatedLossCents = neededShares * candidate.lossPerShareCents;
      recommendations.push({
        symbol: candidate.holding.symbol,
        name: candidate.holding.name,
        sector: candidate.holding.sector,
        availableShares: candidate.holding.shares,
        recommendedShares: neededShares,
        avgCostCents: candidate.holding.avgCostCents,
        priceCents: candidate.holding.priceCents,
        lossPerShareCents: candidate.lossPerShareCents,
        estimatedLossCents,
        holdingPeriod: candidate.holding.holdingPeriod,
        replacementHint: REPLACEMENT_HINTS[candidate.holding.symbol]
          ?? `Avoid repurchasing ${candidate.holding.symbol} within 30 days to comply with the IRS wash-sale rule.`,
      });
      remainingGainToOffset = Math.max(0, remainingGainToOffset - estimatedLossCents);
    }

    const totalHarvestableLossCents = recommendations.reduce((sum, r) => sum + r.estimatedLossCents, 0);
    const netTaxableGainCents = Math.max(0, realizedGainCents - totalHarvestableLossCents);
    const estimatedTaxAfterCents = Math.round((netTaxableGainCents * effectiveTaxRatePct) / 100);
    const estimatedTaxSavingsCents = Math.max(0, estimatedTaxBeforeCents - estimatedTaxAfterCents);

    const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const feedbackSummary = realizedGainCents <= 0
      ? `Selling ${shares} shares of ${symbol} realizes a loss of ${usd(Math.abs(realizedGainCents))} — no capital gains tax is triggered, so no additional loss-harvest trades are required.`
      : recommendations.length > 0
        ? `Selling ${shares} shares of ${symbol} triggers an estimated ${usd(realizedGainCents)} ${primary.holdingPeriod === "short_term" ? "short-term" : "long-term"} capital gain (~${usd(estimatedTaxBeforeCents)} tax at ${effectiveTaxRatePct}%). Harvesting ${recommendations.map((r) => `${r.recommendedShares} ${r.symbol}`).join(" + ")} books ${usd(totalHarvestableLossCents)} in realized losses, reducing estimated tax to ${usd(estimatedTaxAfterCents)} (saving ~${usd(estimatedTaxSavingsCents)}).`
        : `Selling ${shares} shares of ${symbol} triggers an estimated ${usd(realizedGainCents)} capital gain (~${usd(estimatedTaxBeforeCents)} tax), and no eligible unrealized-loss positions remain to harvest.`;

    return {
      personaId,
      primarySymbol: primary.symbol,
      primaryName: primary.name,
      primaryShares: shares,
      primaryProceedsCents,
      primaryCostBasisCents,
      realizedGainCents,
      holdingPeriod: primary.holdingPeriod,
      effectiveTaxRatePct,
      estimatedTaxBeforeCents,
      recommendations,
      totalHarvestableLossCents,
      netTaxableGainCents,
      estimatedTaxAfterCents,
      estimatedTaxSavingsCents,
      feedbackSummary,
      washSaleNotice: "IRS Wash-Sale Rule: do not repurchase substantially identical securities within 30 days before or after harvesting a tax loss.",
    };
  }

  getJob(jobId: string): TradeJob | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    if (job.status !== "completed" && job.status !== "failed") {
      const elapsedMs = Date.now() - Date.parse(job.createdAt);
      const elapsedSeconds = Math.min(job.durationSeconds, Math.max(0, Math.round(elapsedMs / 100) / 10));
      const remainingSeconds = Math.max(0, Math.ceil((job.durationSeconds * 1000 - elapsedMs) / 1000));
      return { ...job, elapsedSeconds, remainingSeconds };
    }
    return { ...job };
  }

  listJobs(personaId?: string): TradeJob[] {
    const list = [...this.jobs.values()]
      .filter((j) => !personaId || j.personaId === personaId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return list.map((j) => this.getJob(j.jobId) ?? j);
  }

  startTradeJob(
    rawInput: TradeJobCreateInput,
    onSettle: (settlement: {
      personaId: string;
      actor: string;
      cashDeltaCents: number;
      equityDeltaCents: number;
      nextCashCents: number;
      nextEquityCents: number;
      summary: string;
    }) => Promise<{ sfieldRunId: string; auditId?: string }>,
  ): TradeJob {
    const input = tradeJobCreateInputSchema.parse(rawInput);
    const holdings = this.holdingsFor(input.personaId);
    const beforeSnapshot = this.snapshotFor(input.personaId);

    // Pre-validate every leg against current holdings and available cash
    let projectedCashCents = beforeSnapshot.cashCents;
    const sharesBySymbol = new Map(holdings.map((h) => [h.symbol, h.shares]));

    for (const leg of input.legs) {
      const sym = leg.symbol.toUpperCase();
      const holding = holdings.find((h) => h.symbol === sym);
      if (!holding) throw new Error(`Unknown ticker "${sym}".`);
      const currentShares = sharesBySymbol.get(sym) ?? 0;
      const gross = leg.shares * holding.priceCents;
      if (leg.side === "sell") {
        if (leg.shares > currentShares) {
          throw new Error(`Insufficient shares for ${sym}: requested ${leg.shares}, available ${currentShares}.`);
        }
        sharesBySymbol.set(sym, currentShares - leg.shares);
        projectedCashCents += gross;
      } else {
        if (gross > projectedCashCents) {
          throw new Error(`Insufficient cash to buy ${leg.shares} ${sym} ($${(gross / 100).toFixed(2)} needed, $${(projectedCashCents / 100).toFixed(2)} available).`);
        }
        sharesBySymbol.set(sym, currentShares + leg.shares);
        projectedCashCents -= gross;
      }
    }

    const jobId = makeId("job");
    const durationSeconds = input.durationSeconds ?? 5;
    const job: TradeJob = {
      jobId,
      personaId: input.personaId,
      actor: input.actor ?? "Customer",
      status: "queued",
      stageLabel: "Order ticket queued & pre-trade compliance check started",
      progressPct: 12,
      durationSeconds,
      elapsedSeconds: 0,
      remainingSeconds: durationSeconds,
      createdAt: new Date().toISOString(),
      taxHarvestAnalyzed: input.taxHarvestAnalyzed ?? false,
      legs: input.legs.map((l) => ({ ...l, symbol: l.symbol.toUpperCase() })),
      beforeSnapshot,
    };
    this.jobs.set(jobId, job);

    const schedule = (delayMs: number, fn: () => void) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        fn();
      }, delayMs);
      t.unref();
      this.timers.add(t);
    };

    const totalMs = durationSeconds * 1000;
    schedule(Math.round(totalMs * 0.2), () => {
      const cur = this.jobs.get(jobId);
      if (cur && cur.status !== "completed" && cur.status !== "failed") {
        cur.status = "validating";
        cur.stageLabel = "Validating share lots, cost basis & wash-sale guardrails";
        cur.progressPct = 34;
      }
    });
    schedule(Math.round(totalMs * 0.48), () => {
      const cur = this.jobs.get(jobId);
      if (cur && cur.status !== "completed" && cur.status !== "failed") {
        cur.status = "routing";
        cur.stageLabel = `Routing ${job.legs.length} order leg${job.legs.length === 1 ? "" : "s"} to simulated execution venue`;
        cur.progressPct = 60;
      }
    });
    schedule(Math.round(totalMs * 0.76), () => {
      const cur = this.jobs.get(jobId);
      if (cur && cur.status !== "completed" && cur.status !== "failed") {
        cur.status = "executing";
        cur.stageLabel = "Fills matched — settling cash & portfolio positions via sfield";
        cur.progressPct = 84;
      }
    });
    schedule(totalMs, () => {
      void this.finalizeJob(jobId, onSettle);
    });

    return this.getJob(jobId)!;
  }

  private async finalizeJob(
    jobId: string,
    onSettle: (settlement: {
      personaId: string;
      actor: string;
      cashDeltaCents: number;
      equityDeltaCents: number;
      nextCashCents: number;
      nextEquityCents: number;
      summary: string;
    }) => Promise<{ sfieldRunId: string; auditId?: string }>,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.status === "completed" || job.status === "failed") return;
    job.status = "settling";
    job.stageLabel = "Persisting settled positions & updating Customer 360 balances";
    job.progressPct = 94;

    try {
      const holdings = this.holdingsFor(job.personaId);
      const before = this.snapshotFor(job.personaId);
      const receipts: TradeFillReceipt[] = [];
      let cashDeltaCents = 0;
      let equityDeltaCents = 0;

      for (const leg of job.legs) {
        const holding = holdings.find((h) => h.symbol === leg.symbol);
        if (!holding) throw new Error(`Holding ${leg.symbol} unavailable at settlement.`);
        const previousShares = holding.shares;
        const fillPriceCents = holding.priceCents;
        const grossAmountCents = leg.shares * fillPriceCents;
        if (leg.side === "sell") {
          if (leg.shares > holding.shares) throw new Error(`Insufficient ${leg.symbol} shares at settlement.`);
          const realizedGainLossCents = (fillPriceCents - holding.avgCostCents) * leg.shares;
          holding.shares -= leg.shares;
          cashDeltaCents += grossAmountCents;
          equityDeltaCents -= grossAmountCents;
          receipts.push({
            symbol: holding.symbol,
            name: holding.name,
            side: "sell",
            reason: leg.reason,
            shares: leg.shares,
            fillPriceCents,
            grossAmountCents,
            realizedGainLossCents,
            previousShares,
            newShares: holding.shares,
          });
        } else {
          const totalOldCost = holding.shares * holding.avgCostCents;
          const totalNewShares = holding.shares + leg.shares;
          holding.avgCostCents = totalNewShares > 0 ? Math.round((totalOldCost + grossAmountCents) / totalNewShares) : fillPriceCents;
          holding.shares = totalNewShares;
          cashDeltaCents -= grossAmountCents;
          equityDeltaCents += grossAmountCents;
          receipts.push({
            symbol: holding.symbol,
            name: holding.name,
            side: "buy",
            reason: leg.reason,
            shares: leg.shares,
            fillPriceCents,
            grossAmountCents,
            realizedGainLossCents: 0,
            previousShares,
            newShares: holding.shares,
          });
        }
      }

      const nextCashCents = Math.max(0, before.cashCents + cashDeltaCents);
      const nextEquityCents = Math.max(0, before.equityCents + equityDeltaCents);
      const summary = receipts
        .map((r) => `${r.side.toUpperCase()} ${r.shares} ${r.symbol} @ $${(r.fillPriceCents / 100).toFixed(2)}${r.reason === "tax_harvest" ? " (TLH)" : ""}`)
        .join(" + ");

      const settlementResult = await onSettle({
        personaId: job.personaId,
        actor: job.actor,
        cashDeltaCents,
        equityDeltaCents,
        nextCashCents,
        nextEquityCents,
        summary,
      });

      this.state.byPersona[job.personaId] = holdings;
      this.save();

      const afterSnapshot = this.snapshotFor(job.personaId);
      job.status = "completed";
      job.stageLabel = "Trade settled — balance and portfolio updated";
      job.progressPct = 100;
      job.elapsedSeconds = job.durationSeconds;
      job.remainingSeconds = 0;
      job.completedAt = new Date().toISOString();
      job.receipts = receipts;
      job.beforeSnapshot = before;
      job.afterSnapshot = afterSnapshot;
      job.sfieldRunId = settlementResult.sfieldRunId;
      job.auditId = settlementResult.auditId;
      job.summary = summary;
    } catch (err) {
      job.status = "failed";
      job.stageLabel = "Trade execution failed";
      job.error = err instanceof Error ? err.message : "Trade settlement failed.";
      job.remainingSeconds = 0;
    }
  }

  close(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
