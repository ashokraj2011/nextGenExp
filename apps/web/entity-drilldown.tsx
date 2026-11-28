import { ArrowRight, ArrowUpRight, GitBranch, Link2, ShieldAlert, TrendingUp, X } from "lucide-react";
import type { IncidentRecord } from "../../packages/contracts/ops";
import type { DealRecord } from "../../packages/contracts/sales";
import "./immersive-ux.css";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const ROLLBACK_STATES = ["not_started", "previewed", "pending_approval", "approved", "rolled_back"] as const;
const DISCOUNT_STATES = ["none", "pending_approval", "approved"] as const;

function normalizeRollbackState(incident: IncidentRecord): string {
  const raw = (incident.rollbackStatus || "").toLowerCase();
  if (incident.status === "rolled_back" || raw.includes("rolled_back") || raw.includes("completed")) return "rolled_back";
  if (raw.includes("approved")) return "approved";
  if (raw.includes("pending")) return "pending_approval";
  if (raw.includes("preview") || raw.includes("ready")) return "previewed";
  return "not_started";
}

/**
 * smass Entity Drill-Down: ops.service (1:N) -> ops.incident + rollbackStatus lifecycle stepper.
 */
export function ServiceIncidentDrilldown({
  serviceName,
  incidents,
  disabled,
  onPrompt,
  onClose,
}: {
  serviceName: string;
  incidents: IncidentRecord[];
  disabled: boolean;
  onPrompt: (prompt: string) => void;
  onClose: () => void;
}) {
  const scoped = incidents.filter((inc) => inc.service === serviceName);
  const display = scoped.length ? scoped : incidents;

  return (
    <section className="smass-drilldown-panel" aria-label={`Service drill-down for ${serviceName}`}>
      <header className="smass-drilldown-head">
        <div>
          <span className="smass-rel-kicker">
            <Link2 size={12} aria-hidden="true" />
            <code>smass</code> · <code>ops.service</code> (1:N) <ArrowRight size={11} aria-hidden="true" /> <code>ops.incident</code>
          </span>
          <h4>
            <ShieldAlert size={15} aria-hidden="true" />
            {serviceName} · {display.length} {display.length === 1 ? "incident" : "incidents"}
          </h4>
        </div>
        <button type="button" className="icon-button" aria-label="Close service drill-down" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      <ul className="smass-drilldown-list">
        {display.map((inc) => {
          const currentState = normalizeRollbackState(inc);
          const currentIdx = Math.max(0, ROLLBACK_STATES.indexOf(currentState as typeof ROLLBACK_STATES[number]));
          return (
            <li key={inc.id} className="smass-drilldown-item">
              <div className="smass-drilldown-item-top">
                <div>
                  <strong>{inc.id}</strong> · {inc.title}
                  <small>
                    {inc.severity} · release <code>{inc.currentRelease}</code> → prev <code>{inc.previousRelease}</code> · error <strong>{inc.errorRatePct}%</strong> · p95 <strong>{inc.p95LatencyMs}ms</strong>
                  </small>
                </div>
                <div className="smass-drilldown-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={disabled}
                    onClick={() => onPrompt(`Show the production rollback approval card for ${inc.id}`)}
                  >
                    Rollback Card <ArrowUpRight size={12} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className="lifecycle-stepper" aria-label={`Rollback lifecycle for ${inc.id}`}>
                <span className="lifecycle-label"><GitBranch size={11} aria-hidden="true" /> rollbackStatus:</span>
                {ROLLBACK_STATES.map((state, idx) => (
                  <span
                    key={state}
                    className={
                      "lifecycle-step"
                      + (idx < currentIdx ? " is-done" : idx === currentIdx ? " is-current" : "")
                    }
                  >
                    {state.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * smass Entity Drill-Down: sales.account (1:N) -> sales.deal with aggregate Pipeline ARR & discount lifecycle.
 */
export function AccountDealsDrilldown({
  accountName,
  deals,
  disabled,
  onPrompt,
  onClose,
}: {
  accountName: string;
  deals: DealRecord[];
  disabled: boolean;
  onPrompt: (prompt: string) => void;
  onClose: () => void;
}) {
  const accountDeals = deals.filter((d) => d.accountName === accountName);
  const totalArr = accountDeals.reduce((sum, d) => sum + d.arrUsd, 0);
  const weightedArr = accountDeals.reduce((sum, d) => sum + Math.round(d.arrUsd * (d.winProbabilityPct / 100)), 0);
  const allAccounts = [...new Set(deals.map((d) => d.accountName))];

  return (
    <section className="smass-drilldown-panel" aria-label={`Account drill-down for ${accountName}`}>
      <header className="smass-drilldown-head">
        <div>
          <span className="smass-rel-kicker">
            <Link2 size={12} aria-hidden="true" />
            <code>smass</code> · <code>sales.account</code> (1:N) <ArrowRight size={11} aria-hidden="true" /> <code>sales.deal</code>
          </span>
          <h4>
            <TrendingUp size={15} aria-hidden="true" />
            {accountName} · Aggregate ARR <strong>{usd.format(totalArr)}</strong> (Weighted {usd.format(weightedArr)})
          </h4>
        </div>
        <button type="button" className="icon-button" aria-label="Close account drill-down" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      <ul className="smass-drilldown-list">
        {accountDeals.map((deal) => {
          const stateIdx = Math.max(0, DISCOUNT_STATES.indexOf(deal.discountStatus as typeof DISCOUNT_STATES[number]));
          const netArr = Math.round(deal.arrUsd * (1 - deal.discountPct / 100));
          return (
            <li key={deal.id} className="smass-drilldown-item">
              <div className="smass-drilldown-item-top">
                <div>
                  <strong>{deal.id}</strong> · {deal.title}
                  <small>
                    Stage <strong>{deal.stage}</strong> · ARR <strong>{usd.format(deal.arrUsd)}</strong> · Net ({deal.discountPct}% off) <strong>{usd.format(netArr)}</strong> · Prob <strong>{deal.winProbabilityPct}%</strong>
                  </small>
                </div>
                <div className="smass-drilldown-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={disabled}
                    onClick={() => onPrompt(`Build a Q4 deal desk and discount approval dashboard for ${deal.id}`)}
                  >
                    Open Deal Desk <ArrowUpRight size={12} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className="lifecycle-stepper" aria-label={`Discount lifecycle for ${deal.id}`}>
                <span className="lifecycle-label"><GitBranch size={11} aria-hidden="true" /> discountStatus:</span>
                {DISCOUNT_STATES.map((state, idx) => (
                  <span
                    key={state}
                    className={
                      "lifecycle-step"
                      + (idx < stateIdx ? " is-done" : idx === stateIdx ? " is-current" : "")
                    }
                  >
                    {state.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            </li>
          );
        })}
      </ul>

      {allAccounts.length > 1 && (
        <div className="smass-drilldown-foot">
          <span>Other accounts in pipeline ({allAccounts.length - 1}):</span>
          <button
            type="button"
            className="secondary-button"
            disabled={disabled}
            onClick={() => onPrompt("Show a live sales pipeline breakdown and deal table")}
          >
            View full Q4 pipeline ({deals.length} deals) <ArrowUpRight size={12} aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  );
}
