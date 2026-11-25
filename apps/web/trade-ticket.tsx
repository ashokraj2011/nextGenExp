import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Calculator,
  CheckCircle2,
  Clock,
  Play,
  ShieldAlert,
  Sparkles,
  Timer,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import type { DynamicCanvasNode } from "../../packages/contracts/dynamic-canvas";
import type { TaxHarvestAnalysis, TradeJob, TradeLegInput, TradeSide } from "../../packages/contracts/trading";
import { api } from "./api";
import { notifyDomainDataUpdated } from "./domain-pack-ui";

type TradeTicketProps = Extract<DynamicCanvasNode, { type: "trade_ticket" }>;

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function fmtCents(cents: number): string {
  return usd.format(cents / 100);
}

export function TradeTicketNode({
  node,
  onFollowUp,
}: {
  node: TradeTicketProps;
  onFollowUp?: (prompt: string) => void;
}) {
  const [side, setSide] = useState<TradeSide>(node.side);
  const [symbol, setSymbol] = useState(node.symbol);

  const selectedHolding = useMemo(
    () => node.holdings.find((h) => h.symbol === symbol) ?? node.holdings[0],
    [node.holdings, symbol],
  );

  const initialShares = useMemo(() => {
    if (node.suggestedShares) return Math.min(node.suggestedShares, Math.max(1, node.existingShares || node.suggestedShares));
    if (node.suggestedPercent && node.existingShares > 0) {
      return Math.max(1, Math.round((node.existingShares * node.suggestedPercent) / 100));
    }
    return node.side === "sell" ? Math.max(1, Math.round(node.existingShares * 0.25)) : 10;
  }, [node.existingShares, node.side, node.suggestedPercent, node.suggestedShares]);

  const [shares, setShares] = useState<number>(initialShares);
  const [phase, setPhase] = useState<"configure" | "tax_analysis" | "running" | "completed">("configure");
  const [taxLoading, setTaxLoading] = useState(false);
  const [analysis, setAnalysis] = useState<TaxHarvestAnalysis | null>(null);
  const [selectedHarvest, setSelectedHarvest] = useState<Record<string, { included: boolean; shares: number }>>({});
  const [job, setJob] = useState<TradeJob | null>(null);
  const [error, setError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const grossCents = shares * selectedHolding.priceCents;
  const estGainCents = side === "sell"
    ? (selectedHolding.priceCents - selectedHolding.avgCostCents) * shares
    : 0;
  const pctOfHolding = selectedHolding.shares > 0
    ? Math.min(100, Math.round((shares / selectedHolding.shares) * 100))
    : 0;

  function selectHolding(nextSymbol: string) {
    setSymbol(nextSymbol);
    const next = node.holdings.find((h) => h.symbol === nextSymbol);
    if (next) {
      setShares(side === "sell" ? Math.max(1, Math.round(next.shares * 0.25)) : 10);
    }
    setAnalysis(null);
    setPhase("configure");
    setError("");
  }

  function applyPercent(pct: number) {
    if (selectedHolding.shares <= 0) return;
    const computed = Math.max(1, Math.min(selectedHolding.shares, Math.round((selectedHolding.shares * pct) / 100)));
    setShares(computed);
    setAnalysis(null);
    setPhase("configure");
    setError("");
  }

  async function runTaxHarvestAnalysis() {
    if (shares <= 0 || shares > selectedHolding.shares) {
      setError(`Enter a valid quantity between 1 and ${selectedHolding.shares} shares.`);
      return;
    }
    setTaxLoading(true);
    setError("");
    try {
      const res = await api.taxHarvestPreview({
        personaId: node.personaId,
        symbol: selectedHolding.symbol,
        shares,
      });
      setAnalysis(res);
      setSelectedHarvest(
        Object.fromEntries(
          res.recommendations.map((rec) => [
            rec.symbol,
            { included: true, shares: rec.recommendedShares },
          ]),
        ),
      );
      setPhase("tax_analysis");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not analyze tax-loss harvesting.");
    } finally {
      setTaxLoading(false);
    }
  }

  const harvestTotals = useMemo(() => {
    if (!analysis) return { count: 0, totalLossCents: 0, netGainCents: 0, taxSavedCents: 0 };
    let totalLossCents = 0;
    let count = 0;
    for (const rec of analysis.recommendations) {
      const pick = selectedHarvest[rec.symbol];
      if (pick?.included && pick.shares > 0) {
        count += 1;
        totalLossCents += pick.shares * rec.lossPerShareCents;
      }
    }
    const netGainCents = Math.max(0, analysis.realizedGainCents - totalLossCents);
    const taxAfter = Math.round((netGainCents * analysis.effectiveTaxRatePct) / 100);
    const taxSavedCents = Math.max(0, analysis.estimatedTaxBeforeCents - taxAfter);
    return { count, totalLossCents, netGainCents, taxSavedCents };
  }, [analysis, selectedHarvest]);

  async function executeTrade(includeHarvestLegs: boolean) {
    setError("");
    if (shares <= 0) {
      setError("Quantity must be at least 1 share.");
      return;
    }
    if (side === "sell" && shares > selectedHolding.shares) {
      setError(`Only ${selectedHolding.shares} shares of ${selectedHolding.symbol} are available to sell.`);
      return;
    }
    if (side === "buy" && grossCents > node.cashBalanceCents) {
      setError(`Insufficient cash: ${fmtCents(grossCents)} required, ${fmtCents(node.cashBalanceCents)} available.`);
      return;
    }

    const legs: TradeLegInput[] = [
      { symbol: selectedHolding.symbol, side, shares, reason: "primary" },
    ];
    if (includeHarvestLegs && analysis) {
      for (const rec of analysis.recommendations) {
        const pick = selectedHarvest[rec.symbol];
        if (pick?.included && pick.shares > 0) {
          legs.push({
            symbol: rec.symbol,
            side: "sell",
            shares: Math.min(rec.availableShares, pick.shares),
            reason: "tax_harvest",
          });
        }
      }
    }

    try {
      const started = await api.startTradeJob({
        personaId: node.personaId,
        actor: node.actorName,
        legs,
        taxHarvestAnalyzed: Boolean(analysis),
        durationSeconds: 5,
      });
      setJob(started);
      setPhase("running");

      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => {
        void api.tradeJobStatus(started.jobId).then((latest) => {
          setJob(latest);
          if (latest.status === "completed") {
            if (pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
            setPhase("completed");
            notifyDomainDataUpdated();
          } else if (latest.status === "failed") {
            if (pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
            setError(latest.error ?? "Trade job failed.");
            setPhase("configure");
          }
        }).catch(() => undefined);
      }, 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not launch trade job.");
    }
  }

  return (
    <div className="dyn-trade-ticket">
      {/* Position & Balance Overview Strip */}
      <dl className="dyn-metrics-grid">
        <div>
          <dt>Existing {selectedHolding.symbol} Position</dt>
          <dd>
            <strong>{selectedHolding.shares} shares</strong>
            <span>{fmtCents(selectedHolding.shares * selectedHolding.priceCents)} market value</span>
          </dd>
        </div>
        <div>
          <dt>Live Price / Avg Cost</dt>
          <dd>
            <strong>{fmtCents(selectedHolding.priceCents)}</strong>
            <span>Avg basis {fmtCents(selectedHolding.avgCostCents)}</span>
          </dd>
        </div>
        <div>
          <dt>Available Cash</dt>
          <dd>
            <strong>{fmtCents(job?.afterSnapshot?.cashCents ?? node.cashBalanceCents)}</strong>
            <span>{job?.afterSnapshot ? "Settled live balance" : "Pre-trade balance"}</span>
          </dd>
        </div>
        <div>
          <dt>Est. {side === "sell" ? "Proceeds & Gain" : "Order Cost"}</dt>
          <dd>
            <strong>{fmtCents(grossCents)}</strong>
            <span>
              {side === "sell"
                ? `${estGainCents >= 0 ? "+" : ""}${fmtCents(estGainCents)} unrealized P/L`
                : `${shares} × ${fmtCents(selectedHolding.priceCents)}`}
            </span>
          </dd>
        </div>
      </dl>

      {error && <p className="dyn-form-error" role="alert">{error}</p>}

      {/* STEP 1 & 2: Configure Order + Tax-Loss Harvesting Question */}
      {(phase === "configure" || phase === "tax_analysis") && (
        <div className="dyn-trade-builder">
          <div className="dyn-trade-controls">
            <label className="dyn-form-field">
              <span>Order Side</span>
              <select
                value={side}
                onChange={(e) => {
                  const nextSide = e.target.value as TradeSide;
                  setSide(nextSide);
                  setAnalysis(null);
                  setPhase("configure");
                }}
              >
                <option value="sell">Sell shares</option>
                <option value="buy">Buy shares</option>
              </select>
            </label>
            <label className="dyn-form-field">
              <span>Stock Holding</span>
              <select value={symbol} onChange={(e) => selectHolding(e.target.value)}>
                {node.holdings.map((h) => (
                  <option key={h.symbol} value={h.symbol}>
                    {h.symbol} — {h.name} ({h.shares} sh @ {fmtCents(h.priceCents)})
                  </option>
                ))}
              </select>
            </label>
            <label className="dyn-form-field">
              <span>Quantity (shares){side === "sell" ? ` · ${pctOfHolding}% of ${selectedHolding.shares}` : ""}</span>
              <input
                type="number"
                min={1}
                max={side === "sell" ? Math.max(1, selectedHolding.shares) : 10000}
                value={shares}
                onChange={(e) => {
                  setShares(Math.max(1, Number(e.target.value) || 1));
                  setAnalysis(null);
                  setPhase("configure");
                }}
              />
            </label>
          </div>

          {side === "sell" && selectedHolding.shares > 0 && (
            <div className="dyn-trade-chips" role="group" aria-label="Quick percentage of holding">
              <span className="dyn-trade-chips-label">Quick % of {selectedHolding.symbol}:</span>
              {[10, 25, 40, 50, 75, 100].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  className={"dyn-trade-chip" + (pctOfHolding === pct ? " is-active" : "")}
                  onClick={() => applyPercent(pct)}
                >
                  {pct}% ({Math.max(1, Math.round((selectedHolding.shares * pct) / 100))} sh)
                </button>
              ))}
            </div>
          )}

          {phase === "configure" && (
            <div className="dyn-trade-question">
              <div>
                <strong>
                  {side === "sell"
                    ? "Step 2 · Run Tax-Loss Harvesting analysis before executing?"
                    : "Step 2 · Ready to launch simulated execution job"}
                </strong>
                <p>
                  {side === "sell"
                    ? `Selling ${shares} shares of ${selectedHolding.symbol} (${pctOfHolding}% of your ${selectedHolding.shares}-share position) creates an estimated ${estGainCents >= 0 ? `capital gain of ${fmtCents(estGainCents)}` : `capital loss of ${fmtCents(Math.abs(estGainCents))}`}. We can scan your other holdings for offsetting loss lots, or skip straight to the timed trade execution job.`
                    : `Buying ${shares} shares of ${selectedHolding.symbol} for ${fmtCents(grossCents)} will execute as a timed settlement job and update your live cash and equity portfolio.`}
                </p>
              </div>
              <div className="dyn-approval-actions">
                {side === "sell" && (
                  <button
                    type="button"
                    className="axe-primary-button"
                    disabled={taxLoading}
                    onClick={() => void runTaxHarvestAnalysis()}
                  >
                    <Calculator size={14} aria-hidden="true" />
                    {taxLoading ? "Analyzing tax lots…" : "Yes — Analyze tax harvesting"}
                  </button>
                )}
                <button
                  type="button"
                  className={side === "sell" ? "secondary-button" : "axe-primary-button"}
                  disabled={taxLoading}
                  onClick={() => void executeTrade(false)}
                >
                  <Play size={14} aria-hidden="true" />
                  {side === "sell" ? "No — Execute trade job now" : "Execute buy order job"}
                </button>
              </div>
            </div>
          )}

          {/* Tax-Loss Harvesting Feedback & Recommended Loss Trades */}
          {phase === "tax_analysis" && analysis && (
            <div className="dyn-tax-panel">
              <div className="dyn-tax-head">
                <div>
                  <h4>
                    <Sparkles size={15} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: "6px" }} />
                    Tax-Loss Harvesting Analysis &amp; Recommended Offset Trades
                  </h4>
                  <p>{analysis.feedbackSummary}</p>
                </div>
                <span className="dyn-risk-pill risk-low">
                  Est. Tax Saved: {fmtCents(harvestTotals.taxSavedCents)}
                </span>
              </div>

              <dl className="dyn-approval-details">
                <div>
                  <dt>{analysis.primarySymbol} Realized Gain</dt>
                  <dd>{analysis.realizedGainCents >= 0 ? "+" : ""}{fmtCents(analysis.realizedGainCents)}</dd>
                </div>
                <div>
                  <dt>Est. Tax Before ({analysis.effectiveTaxRatePct}%)</dt>
                  <dd>{fmtCents(analysis.estimatedTaxBeforeCents)}</dd>
                </div>
                <div>
                  <dt>Selected Harvest Loss</dt>
                  <dd>-{fmtCents(harvestTotals.totalLossCents)}</dd>
                </div>
                <div>
                  <dt>Net Taxable Gain</dt>
                  <dd>{fmtCents(harvestTotals.netGainCents)}</dd>
                </div>
              </dl>

              {analysis.recommendations.length > 0 && (
                <div className="dyn-table-wrap">
                  <h4>Recommended Loss-Offset Trades (editable quantities)</h4>
                  <table className="dyn-table">
                    <thead>
                      <tr>
                        <th>Include</th>
                        <th>Ticker</th>
                        <th>Held / Cost → Price</th>
                        <th>Sell Qty</th>
                        <th>Est. Loss Booked</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analysis.recommendations.map((rec) => {
                        const pick = selectedHarvest[rec.symbol] ?? { included: true, shares: rec.recommendedShares };
                        const lineLoss = pick.included ? pick.shares * rec.lossPerShareCents : 0;
                        return (
                          <tr key={rec.symbol}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Include ${rec.symbol} tax-loss trade`}
                                checked={pick.included}
                                onChange={(e) => setSelectedHarvest((prev) => ({
                                  ...prev,
                                  [rec.symbol]: { ...pick, included: e.target.checked },
                                }))}
                              />
                            </td>
                            <td>
                              <strong>{rec.symbol}</strong>
                              <br />
                              <small>{rec.name}</small>
                            </td>
                            <td>
                              {rec.availableShares} sh · {fmtCents(rec.avgCostCents)} → {fmtCents(rec.priceCents)}
                            </td>
                            <td>
                              <input
                                type="number"
                                className="dyn-tax-qty-input"
                                aria-label={`${rec.symbol} harvest quantity`}
                                min={1}
                                max={rec.availableShares}
                                disabled={!pick.included}
                                value={pick.shares}
                                onChange={(e) => setSelectedHarvest((prev) => ({
                                  ...prev,
                                  [rec.symbol]: {
                                    ...pick,
                                    shares: Math.max(1, Math.min(rec.availableShares, Number(e.target.value) || 1)),
                                  },
                                }))}
                              />
                            </td>
                            <td>
                              <strong style={{ color: "#b91c1c" }}>
                                {pick.included ? `-${fmtCents(lineLoss)}` : "$0.00"}
                              </strong>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <p className="dyn-tax-washsale">
                <ShieldAlert size={14} aria-hidden="true" />
                {analysis.washSaleNotice}
              </p>

              <div className="dyn-approval-actions">
                {analysis.recommendations.length > 0 && harvestTotals.count > 0 && (
                  <button
                    type="button"
                    className="axe-primary-button"
                    onClick={() => void executeTrade(true)}
                  >
                    <Play size={14} aria-hidden="true" />
                    Execute bundle ({selectedHolding.symbol} + {harvestTotals.count} tax-loss {harvestTotals.count === 1 ? "trade" : "trades"})
                  </button>
                )}
                <button
                  type="button"
                  className={harvestTotals.count > 0 ? "secondary-button" : "axe-primary-button"}
                  onClick={() => void executeTrade(false)}
                >
                  <Play size={14} aria-hidden="true" />
                  Execute {selectedHolding.symbol} only
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* STEP 3: Live Timed Job Progress */}
      {phase === "running" && job && (
        <div className="dyn-trade-timer" role="status" aria-live="polite">
          <div className="dyn-trade-timer-head">
            <div>
              <h4>
                <Timer size={16} aria-hidden="true" style={{ verticalAlign: "-3px", marginRight: "6px" }} />
                Executing Trade Job <code>{job.jobId}</code>
              </h4>
              <p>{job.stageLabel}</p>
            </div>
            <span className="dyn-trade-countdown">
              <Clock size={14} aria-hidden="true" />
              {job.remainingSeconds}s remaining
            </span>
          </div>
          <div className="dyn-bar-track" aria-hidden="true">
            <span className="is-highlight" style={{ width: `${job.progressPct}%`, transition: "width 0.4s ease" }} />
          </div>
          <div className="dyn-trade-timer-foot">
            <span>Status: <strong>{job.status}</strong> ({job.progressPct}%)</span>
            <span>{job.legs.map((l) => `${l.side.toUpperCase()} ${l.shares} ${l.symbol}`).join(" · ")}</span>
          </div>
        </div>
      )}

      {/* STEP 4: Completed Trade Settlement Receipt & Live Balance/Portfolio Diff */}
      {phase === "completed" && job && job.afterSnapshot && job.beforeSnapshot && (
        <div className="dyn-trade-settled" role="status">
          <div className="dyn-approval-result">
            <CheckCircle2 size={16} aria-hidden="true" />
            <span>
              <strong>Trade Job Completed ({job.jobId})</strong> — {job.summary}
              {job.sfieldRunId ? ` · sfield run ${job.sfieldRunId}` : ""}
              {job.auditId ? ` · audit ${job.auditId}` : ""}
            </span>
          </div>

          <div className="dyn-trade-diff">
            <div>
              <span>Cash Balance</span>
              <strong>
                {fmtCents(job.beforeSnapshot.cashCents)} <ArrowRight size={13} aria-hidden="true" /> {fmtCents(job.afterSnapshot.cashCents)}
              </strong>
              <small>
                {job.afterSnapshot.cashCents >= job.beforeSnapshot.cashCents ? <TrendingUp size={12} aria-hidden="true" /> : <TrendingDown size={12} aria-hidden="true" />}
                {" "}
                {job.afterSnapshot.cashCents >= job.beforeSnapshot.cashCents ? "+" : ""}
                {fmtCents(job.afterSnapshot.cashCents - job.beforeSnapshot.cashCents)}
              </small>
            </div>
            <div>
              <span>Equities Portfolio</span>
              <strong>
                {fmtCents(job.beforeSnapshot.equityCents)} <ArrowRight size={13} aria-hidden="true" /> {fmtCents(job.afterSnapshot.equityCents)}
              </strong>
              <small>
                {job.afterSnapshot.equityCents >= job.beforeSnapshot.equityCents ? "+" : ""}
                {fmtCents(job.afterSnapshot.equityCents - job.beforeSnapshot.equityCents)}
              </small>
            </div>
            <div>
              <span>Total Portfolio Value</span>
              <strong>{fmtCents(job.afterSnapshot.totalCents)}</strong>
              <small>Synced to Customer 360 &amp; Overview</small>
            </div>
          </div>

          {job.receipts && job.receipts.length > 0 && (
            <div className="dyn-table-wrap">
              <h4>Execution Fill &amp; Position Update Receipt</h4>
              <table className="dyn-table">
                <thead>
                  <tr>
                    <th>Stock</th>
                    <th>Side / Type</th>
                    <th>Filled Qty</th>
                    <th>Fill Price</th>
                    <th>Realized P/L</th>
                    <th>Position Change</th>
                  </tr>
                </thead>
                <tbody>
                  {job.receipts.map((r) => (
                    <tr key={`${r.symbol}-${r.reason}`}>
                      <td><strong>{r.symbol}</strong> · {r.name}</td>
                      <td><code>{r.side.toUpperCase()}</code> {r.reason === "tax_harvest" ? "(Tax Harvest)" : "(Primary)"}</td>
                      <td>{r.shares} sh</td>
                      <td>{fmtCents(r.fillPriceCents)}</td>
                      <td>
                        {r.side === "sell"
                          ? `${r.realizedGainLossCents >= 0 ? "+" : ""}${fmtCents(r.realizedGainLossCents)}`
                          : "—"}
                      </td>
                      <td><strong>{r.previousShares} → {r.newShares} sh</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {onFollowUp && (
            <div className="dyn-approval-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => onFollowUp("Show my portfolio summary")}
              >
                Verify updated portfolio summary
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => onFollowUp(`Simulate another trade in my stock holdings`)}
              >
                Simulate another stock trade
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
