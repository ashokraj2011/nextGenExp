import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  equityHoldingSchema,
  tradeJobCreateInputSchema,
  type EquityHolding,
  type PortfolioBalanceSnapshot,
  type TaxHarvestAnalysis,
  type TaxHarvestRecommendation,
  type TradeDraftState,
  type TradeFillReceipt,
  type TradeJob,
  type TradeJobCreateInput,
  type TradeLegInput,
  type TradeSide,
  type WashSaleLedgerEntry,
} from "../../packages/contracts/trading";
import type { CustomerProfileStore } from "../../packages/customer-profiles";
import { makeId } from "../../packages/experience/compile";

// Calibrated so default Alice Morgan equity portfolio equals exactly $27,500.00 (2,750,000 cents):
// 50*228 + 12*425 + 25*140 + 120*22.50 + 15*160 + 96*25 = 11400 + 5100 + 3500 + 2700 + 2400 + 2400 = $27,500.00
const BASE_EQUITY_CENTS = 2_750_000;
const WASH_SALE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DRAFT_TTL_MS = 15 * 60 * 1000;

const DEFAULT_HOLDINGS: EquityHolding[] = [
  { symbol: "AAPL", name: "Apple Inc.", sector: "Technology", shares: 50, avgCostCents: 14800, priceCents: 22800, holdingPeriod: "long_term" },
  { symbol: "MSFT", name: "Microsoft Corp.", sector: "Technology", shares: 12, avgCostCents: 34000, priceCents: 42500, holdingPeriod: "long_term" },
  { symbol: "NVDA", name: "NVIDIA Corp.", sector: "Semiconductors", shares: 25, avgCostCents: 9600, priceCents: 14000, holdingPeriod: "short_term" },
  { symbol: "INTC", name: "Intel Corp.", sector: "Semiconductors", shares: 120, avgCostCents: 3450, priceCents: 2250, holdingPeriod: "long_term" },
  { symbol: "BA", name: "Boeing Co.", sector: "Aerospace & Defense", shares: 15, avgCostCents: 21400, priceCents: 16000, holdingPeriod: "short_term" },
  { symbol: "PFE", name: "Pfizer Inc.", sector: "Healthcare", shares: 96, avgCostCents: 3350, priceCents: 2500, holdingPeriod: "long_term" },
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
];

export function parseStockPositionPrompt(prompt: string): string | undefined {
  const message = prompt.trim();
  const selection = message.match(/^Show details and analysis for (\S+) · /)?.[1]
    ?? message.match(/^Show full details for (\S+) in my portfolio$/)?.[1]
    ?? message.match(/^(?:show|view) my (.+?) (?:stock )?(?:position|holding)[.!?]?$/i)?.[1];
  if (!selection) return undefined;
  const ticker = selection.startsWith("$") ? selection.slice(1).toUpperCase() : selection;
  if (ticker.length <= 12 && /^[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*$/.test(ticker)) return ticker;
  return NAME_TO_SYMBOL.find(([alias]) => alias.exec(selection)?.[0] === selection)?.[1];
}

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
    ?? prompt.match(/\b(?:sell|buy|purchase|trim)\s+(\d{1,5})\s+(?:of\s+)?(?:aapl|apple|msft|microsoft|nvda|nvidia|intc|intel|ba|boeing|pfe|pfizer)\b/i);
  const shares = !percent && sharesMatch ? Math.max(1, Number(sharesMatch[1])) : undefined;

  return {
    side,
    symbol,
    ...(percent ? { percent } : {}),
    ...(shares ? { shares } : {}),
  };
}

export type SettlementCallback = (settlement: {
  personaId: string;
  actor: string;
  cashDeltaCents: number;
  equityDeltaCents: number;
  nextCashCents: number;
  nextEquityCents: number;
  summary: string;
  approvalId?: string;
}) => Promise<{ sfieldRunId: string; auditId?: string }>;

interface PersistedTradeState {
  byPersona: Record<string, EquityHolding[]>;
  jobs: TradeJob[];
  washSaleLedger: WashSaleLedgerEntry[];
  drafts: Record<string, TradeDraftState>;
}

export class TradeStore {
  private readonly filePath: string;
  private state: PersistedTradeState;
  private readonly jobTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
  private readonly jobListeners = new Map<string, Set<(job: TradeJob) => void>>();

  constructor(dataDir: string, private readonly profileStore: CustomerProfileStore) {
    this.filePath = join(dataDir, "trades-portfolio.json");
    this.state = this.load();
  }

  private load(): PersistedTradeState {
    if (existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PersistedTradeState>;
        const cleanHoldings: Record<string, EquityHolding[]> = {};
        if (raw.byPersona && typeof raw.byPersona === "object") {
          for (const [personaId, list] of Object.entries(raw.byPersona)) {
            if (Array.isArray(list)) {
              const valid = list
                .map((h) => equityHoldingSchema.safeParse(h))
                .filter((r): r is { success: true; data: EquityHolding } => r.success)
                .map((r) => r.data);
              if (valid.length > 0) cleanHoldings[personaId] = valid;
            }
          }
        }
        return {
          byPersona: cleanHoldings,
          jobs: Array.isArray(raw.jobs) ? raw.jobs.slice(0, 100) : [],
          washSaleLedger: Array.isArray(raw.washSaleLedger) ? raw.washSaleLedger.slice(0, 200) : [],
          drafts: raw.drafts && typeof raw.drafts === "object" ? raw.drafts : {},
        };
      } catch { /* fall through */ }
    }
    return { byPersona: {}, jobs: [], washSaleLedger: [], drafts: {} };
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  private seedHoldingsForPersona(personaId: string): EquityHolding[] {
    const profile = this.profileStore.findByPersonaId(personaId);
    const targetEquity = profile?.equityCents ?? BASE_EQUITY_CENTS;
    if (targetEquity <= 0) {
      return DEFAULT_HOLDINGS.map((h) => ({ ...h, shares: 0 }));
    }
    if (targetEquity === BASE_EQUITY_CENTS) {
      return DEFAULT_HOLDINGS.map((h) => ({ ...h }));
    }
    const factor = targetEquity / BASE_EQUITY_CENTS;
    return DEFAULT_HOLDINGS.map((h) => ({
      ...h,
      shares: Math.max(1, Math.round(h.shares * factor)),
    }));
  }

  equityMarketValueCents(personaId: string): number | null {
    const existing = this.state.byPersona[personaId];
    if (!existing) return null;
    return existing.reduce((sum, h) => sum + h.shares * h.priceCents, 0);
  }

  holdingsFor(personaId: string): EquityHolding[] {
    if (!this.state.byPersona[personaId]) {
      this.state.byPersona[personaId] = this.seedHoldingsForPersona(personaId);
      this.save();
    }
    return this.state.byPersona[personaId].map((h) => ({ ...h }));
  }

  snapshotFor(personaId: string): PortfolioBalanceSnapshot {
    const profile = this.profileStore.findByPersonaId(personaId);
    const holdings = this.holdingsFor(personaId);
    const equityCents = holdings.reduce((sum, h) => sum + h.shares * h.priceCents, 0);
    const cashCents = profile?.cashCents ?? 12_500_00;
    const fixedIncomeCents = profile?.fixedIncomeCents ?? 10_000_00;
    return {
      cashCents,
      equityCents,
      fixedIncomeCents,
      totalCents: cashCents + equityCents + fixedIncomeCents,
      holdings,
    };
  }

  estimateGrossCents(personaId: string, legs: TradeLegInput[]): number {
    const holdings = this.holdingsFor(personaId);
    return legs.reduce((sum, leg) => {
      const h = holdings.find((item) => item.symbol === leg.symbol.toUpperCase());
      return sum + (h ? h.priceCents * leg.shares : 0);
    }, 0);
  }

  sectorBreakdownFor(personaId: string): Array<{
    sector: string;
    symbols: string[];
    marketValueCents: number;
    unrealizedPlCents: number;
    sharePct: number;
  }> {
    const sectorMap: Record<string, string> = {
      AAPL: "Technology",
      MSFT: "Technology",
      NVDA: "Semiconductors",
      INTC: "Semiconductors",
      BA: "Industrials & Aerospace",
      PFE: "Healthcare & Pharma",
    };
    const active = this.holdingsFor(personaId).filter((h) => h.shares > 0);
    const total = Math.max(1, active.reduce((sum, h) => sum + h.shares * h.priceCents, 0));
    const grouped = new Map<string, { symbols: string[]; marketValueCents: number; unrealizedPlCents: number }>();
    for (const h of active) {
      const sector = sectorMap[h.symbol.toUpperCase()] ?? "Diversified Equities";
      const mv = h.shares * h.priceCents;
      const pl = (h.priceCents - h.avgCostCents) * h.shares;
      const cur = grouped.get(sector);
      if (cur) {
        cur.symbols.push(h.symbol);
        cur.marketValueCents += mv;
        cur.unrealizedPlCents += pl;
      } else {
        grouped.set(sector, { symbols: [h.symbol], marketValueCents: mv, unrealizedPlCents: pl });
      }
    }
    return [...grouped.entries()]
      .map(([sector, v]) => ({
        sector,
        symbols: v.symbols,
        marketValueCents: v.marketValueCents,
        unrealizedPlCents: v.unrealizedPlCents,
        sharePct: Math.round((v.marketValueCents / total) * 1000) / 10,
      }))
      .sort((a, b) => b.marketValueCents - a.marketValueCents);
  }

  recentlyBoughtSymbols(personaId: string): Set<string> {
    const cutoff = Date.now() - WASH_SALE_WINDOW_MS;
    const symbols = new Set<string>();
    for (const entry of this.state.washSaleLedger) {
      if (entry.personaId === personaId && entry.side === "buy" && Date.parse(entry.executedAt) >= cutoff) {
        symbols.add(entry.symbol.toUpperCase());
      }
    }
    for (const job of this.state.jobs) {
      if (job.personaId !== personaId || job.status === "cancelled" || job.status === "failed") continue;
      if (Date.parse(job.createdAt) < cutoff) continue;
      for (const leg of job.legs) {
        if (leg.side === "buy") symbols.add(leg.symbol.toUpperCase());
      }
    }
    return symbols;
  }

  washSaleWarningsFor(personaId: string, rawSymbol: string, side: TradeSide): string[] {
    const symbol = rawSymbol.toUpperCase();
    const cutoff = Date.now() - WASH_SALE_WINDOW_MS;
    const recent = this.state.washSaleLedger.filter(
      (entry) => entry.personaId === personaId && entry.symbol === symbol && Date.parse(entry.executedAt) >= cutoff,
    );
    const warnings: string[] = [];
    if (side === "buy") {
      const priorLossSell = recent.find((e) => e.side === "sell" && e.realizedGainLossCents < 0);
      if (priorLossSell) {
        const daysAgo = Math.max(0, Math.floor((Date.now() - Date.parse(priorLossSell.executedAt)) / (24 * 60 * 60 * 1000)));
        warnings.push(
          `Wash-Sale Conflict (${symbol}): You harvested a $${(Math.abs(priorLossSell.realizedGainLossCents) / 100).toFixed(2)} loss on ${symbol} ${daysAgo === 0 ? "today" : `${daysAgo}d ago`}. Repurchasing within 30 days disallows that tax loss.`,
        );
      }
    } else {
      const priorBuy = recent.find((e) => e.side === "buy");
      if (priorBuy) {
        warnings.push(
          `Wash-Sale Warning (${symbol}): You purchased ${priorBuy.shares} shares of ${symbol} within the past 30 days. Selling ${symbol} at a loss may trigger an IRS wash sale.`,
        );
      }
    }
    return warnings;
  }

  setDraft(draft: TradeDraftState): void {
    this.state.drafts[draft.conversationId] = draft;
    this.save();
  }

  getDraft(conversationId: string): TradeDraftState | undefined {
    const found = this.state.drafts[conversationId];
    if (!found) return undefined;
    if (Date.now() - found.updatedAt > DRAFT_TTL_MS || found.stage === "completed") {
      return undefined;
    }
    return { ...found };
  }

  clearDraft(conversationId: string): void {
    if (this.state.drafts[conversationId]) {
      delete this.state.drafts[conversationId];
      this.save();
    }
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

    const washSaleWarnings = this.washSaleWarningsFor(personaId, symbol, "sell");

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
      const candidateWarnings = this.washSaleWarningsFor(personaId, candidate.holding.symbol, "sell");
      washSaleWarnings.push(...candidateWarnings);
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
        ...(candidateWarnings[0] ? { washSaleConflict: candidateWarnings[0] } : {}),
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
      washSaleNotice: "IRS 30-Day Wash-Sale Rule: do not repurchase substantially identical securities within 30 days before or after harvesting a tax loss.",
      washSaleWarnings,
    };
  }

  private findJobMut(jobId: string): TradeJob | undefined {
    return this.state.jobs.find((j) => j.jobId === jobId);
  }

  private emitJob(jobId: string): void {
    const snap = this.getJob(jobId);
    if (!snap) return;
    const listeners = this.jobListeners.get(jobId);
    if (!listeners) return;
    for (const fn of listeners) {
      try { fn(snap); } catch { /* ignore listener errors */ }
    }
  }

  subscribeJob(jobId: string, listener: (job: TradeJob) => void): () => void {
    let set = this.jobListeners.get(jobId);
    if (!set) {
      set = new Set();
      this.jobListeners.set(jobId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.jobListeners.delete(jobId);
    };
  }

  getJob(jobId: string): TradeJob | undefined {
    const job = this.findJobMut(jobId);
    if (!job) return undefined;
    if (job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled") {
      const elapsedMs = Date.now() - Date.parse(job.createdAt);
      const elapsedSeconds = Math.min(job.durationSeconds, Math.max(0, Math.round(elapsedMs / 100) / 10));
      const remainingSeconds = Math.max(0, Math.ceil((job.durationSeconds * 1000 - elapsedMs) / 1000));
      return { ...job, elapsedSeconds, remainingSeconds };
    }
    return { ...job };
  }

  listJobs(personaId?: string): TradeJob[] {
    return this.state.jobs
      .filter((j) => !personaId || j.personaId === personaId)
      .map((j) => this.getJob(j.jobId) ?? j);
  }

  private clearJobTimers(jobId: string): void {
    const list = this.jobTimers.get(jobId);
    if (!list) return;
    for (const t of list) clearTimeout(t);
    this.jobTimers.delete(jobId);
  }

  cancelJob(jobId: string): { ok: true; job: TradeJob } | { ok: false; message: string } {
    const job = this.findJobMut(jobId);
    if (!job) return { ok: false, message: "Trade job not found." };
    if (job.status === "completed" || job.status === "settling") {
      return { ok: false, message: "Order is already settling or completed and cannot be cancelled." };
    }
    if (job.status === "cancelled" || job.status === "failed") {
      return { ok: true, job: this.getJob(jobId)! };
    }
    this.clearJobTimers(jobId);
    job.status = "cancelled";
    job.stageLabel = "Order cancelled before execution — no shares or balances changed";
    job.remainingSeconds = 0;
    job.completedAt = new Date().toISOString();
    this.save();
    this.emitJob(jobId);
    return { ok: true, job: this.getJob(jobId)! };
  }

  reconcilePendingJobs(onSettle: SettlementCallback): void {
    for (const job of this.state.jobs) {
      if (job.status === "queued" || job.status === "validating" || job.status === "routing" || job.status === "executing" || job.status === "settling") {
        void this.finalizeJob(job.jobId, onSettle);
      }
    }
  }

  startTradeJob(
    rawInput: TradeJobCreateInput,
    onSettle: SettlementCallback,
    approvalId?: string,
  ): TradeJob {
    const input = tradeJobCreateInputSchema.parse(rawInput);
    const holdings = this.holdingsFor(input.personaId);
    const beforeSnapshot = this.snapshotFor(input.personaId);

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
      ...(approvalId ? { approvalId } : {}),
      legs: input.legs.map((l) => ({ ...l, symbol: l.symbol.toUpperCase() })),
      beforeSnapshot,
    };
    this.state.jobs = [job, ...this.state.jobs].slice(0, 100);
    this.save();

    const timers: ReturnType<typeof setTimeout>[] = [];
    this.jobTimers.set(jobId, timers);

    const schedule = (delayMs: number, fn: () => void) => {
      const t = setTimeout(() => { fn(); }, delayMs);
      t.unref();
      timers.push(t);
    };

    const totalMs = durationSeconds * 1000;
    // Emit 1s countdown heartbeats for live SSE streams
    for (let sec = 1; sec < durationSeconds; sec += 1) {
      schedule(sec * 1000, () => {
        const cur = this.findJobMut(jobId);
        if (cur && cur.status !== "completed" && cur.status !== "failed" && cur.status !== "cancelled") {
          this.emitJob(jobId);
        }
      });
    }
    schedule(Math.round(totalMs * 0.2), () => {
      const cur = this.findJobMut(jobId);
      if (cur && cur.status === "queued") {
        cur.status = "validating";
        cur.stageLabel = "Validating share lots, cost basis & 30-day wash-sale ledger";
        cur.progressPct = 34;
        this.save();
        this.emitJob(jobId);
      }
    });
    schedule(Math.round(totalMs * 0.48), () => {
      const cur = this.findJobMut(jobId);
      if (cur && (cur.status === "queued" || cur.status === "validating")) {
        cur.status = "routing";
        cur.stageLabel = `Routing ${job.legs.length} order leg${job.legs.length === 1 ? "" : "s"} to simulated execution venue`;
        cur.progressPct = 60;
        this.save();
        this.emitJob(jobId);
      }
    });
    schedule(Math.round(totalMs * 0.76), () => {
      const cur = this.findJobMut(jobId);
      if (cur && (cur.status === "routing" || cur.status === "validating")) {
        cur.status = "executing";
        cur.stageLabel = "Fills matched — settling cash & portfolio positions via sfield";
        cur.progressPct = 84;
        this.save();
        this.emitJob(jobId);
      }
    });
    schedule(totalMs, () => {
      void this.finalizeJob(jobId, onSettle);
    });

    return this.getJob(jobId)!;
  }

  private async finalizeJob(jobId: string, onSettle: SettlementCallback): Promise<void> {
    const job = this.findJobMut(jobId);
    if (!job || job.status === "completed" || job.status === "failed" || job.status === "cancelled") return;
    this.clearJobTimers(jobId);
    job.status = "settling";
    job.stageLabel = "Persisting settled positions & updating Customer 360 balances";
    job.progressPct = 94;
    this.save();
    this.emitJob(jobId);

    try {
      const holdings = this.holdingsFor(job.personaId);
      const before = this.snapshotFor(job.personaId);
      const receipts: TradeFillReceipt[] = [];
      let cashDeltaCents = 0;
      let equityDeltaCents = 0;
      const settledIso = new Date().toISOString();

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
          this.state.washSaleLedger.unshift({
            id: makeId("ws"),
            personaId: job.personaId,
            symbol: holding.symbol,
            side: "sell",
            shares: leg.shares,
            realizedGainLossCents,
            executedAt: settledIso,
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
          this.state.washSaleLedger.unshift({
            id: makeId("ws"),
            personaId: job.personaId,
            symbol: holding.symbol,
            side: "buy",
            shares: leg.shares,
            realizedGainLossCents: 0,
            executedAt: settledIso,
          });
        }
      }
      this.state.washSaleLedger = this.state.washSaleLedger.slice(0, 200);

      const nextCashCents = Math.max(0, before.cashCents + cashDeltaCents);
      const nextEquityCents = holdings.reduce((sum, h) => sum + h.shares * h.priceCents, 0);
      const summary = receipts
        .map((r) => `${r.side.toUpperCase()} ${r.shares} ${r.symbol} @ $${(r.fillPriceCents / 100).toFixed(2)}${r.reason === "tax_harvest" ? " (TLH)" : ""}`)
        .join(" + ");

      this.state.byPersona[job.personaId] = holdings;
      this.save();

      const settlementResult = await onSettle({
        personaId: job.personaId,
        actor: job.actor,
        cashDeltaCents,
        equityDeltaCents,
        nextCashCents,
        nextEquityCents,
        summary,
        ...(job.approvalId ? { approvalId: job.approvalId } : {}),
      });

      const afterSnapshot = this.snapshotFor(job.personaId);
      job.status = "completed";
      job.stageLabel = "Trade settled — balance and portfolio updated";
      job.progressPct = 100;
      job.elapsedSeconds = job.durationSeconds;
      job.remainingSeconds = 0;
      job.completedAt = settledIso;
      job.receipts = receipts;
      job.beforeSnapshot = before;
      job.afterSnapshot = afterSnapshot;
      job.sfieldRunId = settlementResult.sfieldRunId;
      job.auditId = settlementResult.auditId;
      job.summary = summary;
      this.save();
      this.emitJob(jobId);
    } catch (err) {
      job.status = "failed";
      job.stageLabel = "Trade execution failed";
      job.error = err instanceof Error ? err.message : "Trade settlement failed.";
      job.remainingSeconds = 0;
      this.save();
      this.emitJob(jobId);
    }
  }

  close(): void {
    for (const id of [...this.jobTimers.keys()]) this.clearJobTimers(id);
    this.jobListeners.clear();
  }
}
