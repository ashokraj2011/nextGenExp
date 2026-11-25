import { useState } from "react";
import { ArrowUpRight, ChevronDown, ChevronUp, Sparkles, Wallet } from "lucide-react";
import type { DemoPersona } from "../../packages/contracts/api";
import { formatPortfolioAmount } from "../../packages/contracts/portfolio";
import type { PendingActions } from "./workspace-overview";

const asOfFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

export function LiveMetricsHud({
  activeProfile,
  pendingActions,
  disabled,
  onReviewPortfolio,
  onReviewGoal,
  onPreviewFunding,
  onReviewGuide,
}: {
  activeProfile?: DemoPersona;
  pendingActions: PendingActions;
  disabled: boolean;
  onReviewPortfolio: () => void;
  onReviewGoal: () => void;
  onPreviewFunding: () => void;
  onReviewGuide: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!activeProfile) return null;

  const { overview, profile } = activeProfile;
  const portfolio = overview?.portfolio;
  const goal = overview?.homeGoal;
  const totalCents = portfolio ? portfolio.cashCents + portfolio.equityCents + portfolio.fixedIncomeCents : 0;
  const stocksPct = totalCents > 0 && portfolio ? Math.round((portfolio.equityCents / totalCents) * 100) : 0;
  const fixedPct = totalCents > 0 && portfolio ? Math.round((portfolio.fixedIncomeCents / totalCents) * 100) : 0;
  const cashPct = totalCents > 0 && portfolio ? Math.max(0, 100 - stocksPct - fixedPct) : 0;

  const unfunded = profile.accountFundingStatus === "unfunded";
  const highCash = cashPct >= 20 && totalCents > 0;
  const latestGoal = goal?.history.at(-1);
  const goalPercent = goal && latestGoal ? Math.min(100, Math.round((latestGoal.savedCents / goal.targetCents) * 100)) : undefined;

  return (
    <section className="allocation-arch-card" aria-label="Target allocation overview">
      <div className="allocation-arch-head">
        <span className="allocation-arch-kicker">Target Allocation Architecture</span>
        <div className="allocation-arch-meta">
          <span>
            {portfolio
              ? `${formatPortfolioAmount(totalCents)} · As of ${asOfFormat.format(new Date(portfolio.asOf))}`
              : (unfunded ? "Awaiting first deposit" : "Active profile")}
          </span>
          <button
            type="button"
            className="allocation-expand-btn"
            aria-expanded={expanded}
            aria-label={expanded ? "Hide quick actions" : "Show quick actions"}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          </button>
        </div>
      </div>

      {portfolio && totalCents > 0 && (
        <>
          <div className="allocation-arch-bar" aria-hidden="true">
            {stocksPct > 0 && <span className="seg-stocks" style={{ width: `${stocksPct}%` }} />}
            {fixedPct > 0 && <span className="seg-fixed" style={{ width: `${fixedPct}%` }} />}
            {cashPct > 0 && <span className="seg-cash" style={{ width: `${cashPct}%` }} />}
          </div>
          <div className="allocation-arch-legend">
            <span className="legend-item"><i className="seg-stocks" aria-hidden="true" />Stocks <strong>{stocksPct}%</strong></span>
            <span className="legend-item"><i className="seg-fixed" aria-hidden="true" />Fixed income <strong>{fixedPct}%</strong></span>
            <span className="legend-item"><i className="seg-cash" aria-hidden="true" />Cash <strong>{cashPct}%</strong></span>
            {highCash && <span className="legend-badge-warn">High cash ({formatPortfolioAmount(portfolio.cashCents)})</span>}
            {goalPercent !== undefined && <span className="legend-badge-ok">Home goal {goalPercent}%</span>}
          </div>
        </>
      )}

      {expanded && (
        <div className="allocation-arch-actions">
          <button type="button" className="hud-action" disabled={disabled} onClick={() => {
            setExpanded(false);
            if (unfunded) onPreviewFunding();
            else onReviewPortfolio();
          }}>
            {unfunded ? <Wallet size={13} aria-hidden="true" /> : <Sparkles size={13} aria-hidden="true" />}
            {unfunded ? "Preview funding" : "Analyze portfolio"}
            <ArrowUpRight size={13} aria-hidden="true" />
          </button>
          {goal && (
            <button type="button" className="hud-action" disabled={disabled} onClick={() => {
              setExpanded(false);
              onReviewGoal();
            }}>
              Explore home goal <ArrowUpRight size={13} aria-hidden="true" />
            </button>
          )}
          {pendingActions.items?.map(({ contentId, title, action }) => (
            <button
              key={contentId}
              type="button"
              className="hud-action"
              disabled={disabled}
              onClick={() => {
                setExpanded(false);
                if (action.kind === "guide") onReviewGuide(action.message);
                else onPreviewFunding();
              }}
            >
              {title} <ArrowUpRight size={13} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
