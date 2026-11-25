import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  XCircle,
} from "lucide-react";
import type { ApprovalRecord } from "../../packages/contracts/approval";
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
  const [phase, setPhase] = useState<"configure" | "tax_analysis" | "pending_approval" | "running" | "completed" | "cancelled">(
    node.initialStage === "running" && node.initialJobId ? "running" : "configure",
  );
  const [taxLoading, setTaxLoading] = useState(false);
  const [analysis, setAnalysis] = useState<TaxHarvestAnalysis | null>(null);
  const [selectedHarvest, setSelectedHarvest] = useState<Record<string, { included: boolean; shares: number }>>({});
  const [pendingApproval, setPendingApproval] = useState<ApprovalRecord | null>(null);
  const [approverName, setApproverName] = useState(node.actorName || "Compliance Approver");
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [job, setJob] = useState<TradeJob | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const streamRef = useRef<EventSource | null>(null);
  const didAutoInitRef = useRef(false);

  const attachJobStream = useCallback((jobId: string) => {
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }
    setPhase("running");
    const source = new EventSource(`/api/trading/${jobId}/events`);
    streamRef.current = source;
    source.addEventListener("job.update", (ev: Event) => {
      try {
        const latest = JSON.parse((ev as MessageEvent).data) as TradeJob;
        setJob(latest);
        if (latest.status === "completed") {
          source.close();
          streamRef.current = null;
          setPhase("completed");
          notifyDomainDataUpdated();
        } else if (latest.status === "cancelled") {
          source.close();
          streamRef.current = null;
          setPhase("cancelled");
        } else if (latest.status === "failed") {
          source.close();
          streamRef.current = null;
          setError(latest.error ?? "Trade execution job failed.");
          setPhase("configure");
        }
      } catch { /* ignore malformed event */ }
    });
    source.onerror = () => {
      // Fallback one-shot status read if SSE closes early
      void api.tradeJobStatus(jobId).then((latest) => {
        setJob(latest);
        if (latest.status === "completed") {
          source.close();
          streamRef.current = null;
          setPhase("completed");
          notifyDomainDataUpdated();
        } else if (latest.status === "cancelled") {
          source.close();
          streamRef.current = null;
          setPhase("cancelled");
        }
      }).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (streamRef.current) streamRef.current.close();
    };
  }, []);

  const runTaxHarvestAnalysis = useCallback(async (targetSymbol = selectedHolding.symbol, targetShares = shares) => {
    if (targetShares <= 0 || targetShares > selectedHolding.shares) {
      setError(`Enter a valid quantity between 1 and ${selectedHolding.shares} shares.`);
      return;
    }
    setTaxLoading(true);
    setError("");
    try {
      const res = await api.taxHarvestPreview({
        personaId: node.personaId,
        symbol: targetSymbol,
        shares: targetShares,
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
  }, [node.personaId, selectedHolding.shares, selectedHolding.symbol, shares]);

  useEffect(() => {
    if (didAutoInitRef.current) return;
    didAutoInitRef.current = true;
    if (node.initialStage === "tax_analysis") {
      void runTaxHarvestAnalysis(node.symbol, initialShares);
    } else if (node.initialStage === "running" && node.initialJobId) {
      attachJobStream(node.initialJobId);
    }
  }, [attachJobStream, initialShares, node.initialJobId, node.initialStage, node.symbol, runTaxHarvestAnalysis]);

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
      if ("approval" in started && started.status === "pending_approval") {
        setPendingApproval(started.approval);
        setApproverName(started.approval.dualControl ? "Compliance Approver" : node.actorName);
        setPhase("pending_approval");
        return;
      }
      const startedJob = started as TradeJob;
      setJob(startedJob);
      attachJobStream(startedJob.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not launch trade job.");
    }
  }

  async function decideTradeApproval(decision: "approve" | "deny") {
    if (!pendingApproval || approvalBusy) return;
    setApprovalBusy(true);
    setError("");
    try {
      const res = await api.decideApproval(pendingApproval.id, {
        decision,
        actor: approverName.trim() || "Compliance Approver",
      });
      if (decision === "deny") {
        setPendingApproval(null);
        setPhase("cancelled");
        return;
      }
      const nextJobId = res.job?.jobId ?? res.execution?.jobId ?? res.approval.executionResult?.jobId;
      if (res.job) setJob(res.job);
      if (nextJobId) {
        setPendingApproval(null);
        attachJobStream(nextJobId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approval decision failed.");
    } finally {
      setApprovalBusy(false);
    }
  }

  async function cancelActiveJob() {
    if (!job || cancelling) return;
    setCancelling(true);
    setError("");
    try {
      const cancelled = await api.cancelTradeJob(job.jobId);
      setJob(cancelled);
      setPhase("cancelled");
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Order could not be cancelled.");
    } finally {
      setCancelling(false);
    }
  }

  const allWashSaleWarnings = [
    ...(node.washSaleWarnings ?? []),
    ...(analysis?.washSaleWarnings ?? []),
  ].filter((msg, idx, arr) => arr.indexOf(msg) === idx);

  return (
    <div className="dyn-trade-ticket">
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

      {allWashSaleWarnings.map((warn) => (
        <p key={warn} className="dyn-tax-washsale" role="alert">
          <ShieldAlert size={14} aria-hidden="true" />
          {warn}
        </p>
      ))}

      {error && <p className="dyn-form-error" role="alert">{error}</p>}

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
                    ? `Selling ${shares} shares of ${selectedHolding.symbol} (${pctOfHolding}% of your ${selectedHolding.shares}-share position) creates an estimated ${estGainCents >= 0 ? `capital gain of ${fmtCents(estGainCents)}` : `capital loss of ${fmtCents(Math.abs(estGainCents))}`}. Click below or reply "yes" / "execute now" in Chat.`
                    : `Buying ${shares} shares of ${selectedHolding.symbol} for ${fmtCents(grossCents)} will execute as a durable SSE-streamed settlement job and update your live cash and equity portfolio.`}
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

      {/* High-Value Trade HITL Compliance Gate */}
      {phase === "pending_approval" && pendingApproval && (
        <div className="dyn-approval is-pending" role="status">
          <div className="dyn-approval-head">
            <div>
              <h4>{pendingApproval.title}</h4>
              <span className="dyn-approval-req">Requested by {pendingApproval.requester}</span>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "4px", fontSize: "0.74rem", opacity: 0.85 }}>
                <code>{pendingApproval.id}</code>
                <code>{pendingApproval.sfieldToolRef}</code>
                <code>sha256:{pendingApproval.payloadDigest.slice(0, 12)}</code>
                {pendingApproval.dualControl && <strong>4-eyes dual control</strong>}
              </div>
            </div>
            <span className="dyn-risk-pill risk-high">
              <ShieldAlert size={12} aria-hidden="true" />HITL Gate
            </span>
          </div>
          <p className="dyn-approval-summary">{pendingApproval.summary}</p>
          <dl className="dyn-approval-details">
            {pendingApproval.details.map((d) => (
              <div key={d.label}><dt>{d.label}</dt><dd>{d.value}</dd></div>
            ))}
          </dl>
          <label className="dyn-form-field">
            <span>Approver</span>
            <input value={approverName} onChange={(e) => setApproverName(e.target.value)} />
          </label>
          <div className="dyn-approval-actions">
            <button type="button" className="axe-primary-button" disabled={approvalBusy} onClick={() => void decideTradeApproval("approve")}>
              <CheckCircle2 size={14} aria-hidden="true" />{approvalBusy ? "Approving…" : "Approve & launch trade job"}
            </button>
            <button type="button" className="secondary-button" disabled={approvalBusy} onClick={() => void decideTradeApproval("deny")}>
              <XCircle size={14} aria-hidden="true" />Deny trade
            </button>
          </div>
        </div>
      )}

      {/* Live SSE Timed Job Progress + Cancel Order */}
      {phase === "running" && (
        <div className="dyn-trade-timer" role="status" aria-live="polite">
          <div className="dyn-trade-timer-head">
            <div>
              <h4>
                <Timer size={16} aria-hidden="true" style={{ verticalAlign: "-3px", marginRight: "6px" }} />
                Executing Trade Job <code>{job?.jobId ?? node.initialJobId}</code> (Live SSE)
              </h4>
              <p>{job?.stageLabel ?? "Connecting to live execution stream…"}</p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span className="dyn-trade-countdown">
                <Clock size={14} aria-hidden="true" />
                {job?.remainingSeconds ?? 5}s remaining
              </span>
              {job && (job.status === "queued" || job.status === "validating" || job.status === "routing") && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={cancelling}
                  onClick={() => void cancelActiveJob()}
                >
                  <XCircle size={13} aria-hidden="true" />{cancelling ? "Cancelling…" : "Cancel order"}
                </button>
              )}
            </div>
          </div>
          <div className="dyn-bar-track" aria-hidden="true">
            <span className="is-highlight" style={{ width: `${job?.progressPct ?? 12}%`, transition: "width 0.35s ease" }} />
          </div>
          <div className="dyn-trade-timer-foot">
            <span>Status: <strong>{job?.status ?? "queued"}</strong> ({job?.progressPct ?? 12}%)</span>
            <span>{(job?.legs ?? []).map((l) => `${l.side.toUpperCase()} ${l.shares} ${l.symbol}`).join(" · ")}</span>
          </div>
        </div>
      )}

      {/* Cancelled state */}
      {phase === "cancelled" && (
        <div className="dyn-approval-result" role="status">
          <XCircle size={16} aria-hidden="true" />
          <span>
            <strong>Order Cancelled</strong> — {job?.stageLabel ?? "Trade order cancelled before execution. No shares or balances were modified."}
          </span>
        </div>
      )}

      {/* Completed Settlement Receipt */}
      {phase === "completed" && job && job.afterSnapshot && job.beforeSnapshot && (
        <div className="dyn-trade-settled" role="status">
          <div className="dyn-approval-result">
            <CheckCircle2 size={16} aria-hidden="true" />
            <span>
              <strong>Trade Job Completed ({job.jobId})</strong> — {job.summary}
              {job.sfieldRunId ? ` · sfield run ${job.sfieldRunId}` : ""}
              {job.auditId ? ` · audit ${job.auditId}` : ""}
              {job.approvalId ? ` · approval ${job.approvalId}` : ""}
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
              <small>Synced penny-for-penny to Customer 360</small>
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
              <button type="button" className="secondary-button" onClick={() => onFollowUp("Show all my stocks")}>
                View updated stock holdings
              </button>
              <button type="button" className="secondary-button" onClick={() => onFollowUp("Show my portfolio summary")}>
                Verify portfolio snapshot
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
