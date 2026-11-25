import type { DataBindingValues } from "../contracts/data-bindings";
import type { IncidentRecord } from "../contracts/ops";
import type { DealRecord } from "../contracts/sales";
import { formatPortfolioAmount } from "../contracts/portfolio";
import { findProfileById } from "./registry";

function centsToPlainDollars(cents: number): string {
  const val = Math.max(0, cents) / 100;
  return Number.isInteger(val) ? String(val) : val.toFixed(2);
}

export function resolveCustomerBindings(
  personaId: string,
  effectiveFundingStatus?: "funded" | "unfunded",
): DataBindingValues | undefined {
  const profile = findProfileById(personaId);
  if (!profile) return undefined;

  const funding = effectiveFundingStatus ?? profile.accountFundingStatus;
  const totalCents = profile.cashCents + profile.equityCents + profile.fixedIncomeCents;
  const investedCents = profile.equityCents + profile.fixedIncomeCents;
  const cashPct = totalCents > 0 ? Math.round((profile.cashCents / totalCents) * 100) : 0;
  const equitiesPct = totalCents > 0 ? Math.round((profile.equityCents / totalCents) * 100) : 0;
  const fixedIncomePct = totalCents > 0 ? Math.max(0, 100 - cashPct - equitiesPct) : 0;
  const goalRemainingCents = Math.max(0, profile.homeGoalTargetCents - profile.homeGoalSavedCents);
  const goalPct = profile.homeGoalTargetCents > 0
    ? Math.min(100, Math.round((profile.homeGoalSavedCents / profile.homeGoalTargetCents) * 100))
    : 0;

  const result: DataBindingValues = {
    "customer.displayName": { display: profile.displayName, rawInput: profile.displayName },
    "customer.segment": { display: profile.segment || "Advisory Client", rawInput: profile.segment || "Advisory Client" },
    "customer.fundingStatus": {
      display: funding === "funded" ? "Funded" : "Awaiting first deposit",
      rawInput: funding,
    },
    "customer.beneficiaryStatus": {
      display: profile.beneficiaryStatus === "on_file" ? "On file" : "Missing",
      rawInput: profile.beneficiaryStatus,
    },
    "balances.available": {
      display: formatPortfolioAmount(profile.availableBalanceCents),
      rawInput: centsToPlainDollars(profile.availableBalanceCents),
    },
    "balances.current": {
      display: formatPortfolioAmount(profile.currentBalanceCents),
      rawInput: centsToPlainDollars(profile.currentBalanceCents),
    },
    "portfolio.total": {
      display: formatPortfolioAmount(totalCents),
      rawInput: centsToPlainDollars(totalCents),
    },
    "portfolio.invested": {
      display: formatPortfolioAmount(investedCents),
      rawInput: centsToPlainDollars(investedCents),
    },
    "portfolio.cash": {
      display: formatPortfolioAmount(profile.cashCents),
      rawInput: centsToPlainDollars(profile.cashCents),
    },
    "portfolio.equities": {
      display: formatPortfolioAmount(profile.equityCents),
      rawInput: centsToPlainDollars(profile.equityCents),
    },
    "portfolio.fixedIncome": {
      display: formatPortfolioAmount(profile.fixedIncomeCents),
      rawInput: centsToPlainDollars(profile.fixedIncomeCents),
    },
    "portfolio.cashPct": { display: `${cashPct}%`, rawInput: String(cashPct), percent: cashPct },
    "portfolio.equitiesPct": { display: `${equitiesPct}%`, rawInput: String(equitiesPct), percent: equitiesPct },
    "portfolio.fixedIncomePct": { display: `${fixedIncomePct}%`, rawInput: String(fixedIncomePct), percent: fixedIncomePct },
    "goal.target": {
      display: formatPortfolioAmount(profile.homeGoalTargetCents),
      rawInput: centsToPlainDollars(profile.homeGoalTargetCents),
    },
    "goal.saved": {
      display: formatPortfolioAmount(profile.homeGoalSavedCents),
      rawInput: centsToPlainDollars(profile.homeGoalSavedCents),
    },
    "goal.remaining": {
      display: formatPortfolioAmount(goalRemainingCents),
      rawInput: centsToPlainDollars(goalRemainingCents),
    },
    "goal.percentFunded": { display: `${goalPct}%`, rawInput: String(goalPct), percent: goalPct },
  };

  for (const attr of profile.customAttributes ?? []) {
    const key = `custom.${attr.key}`;
    const raw = attr.value.trim();
    if (attr.type === "currency") {
      const numeric = Number(raw.replace(/[^0-9.-]/g, ""));
      const valid = Number.isFinite(numeric);
      result[key] = {
        display: valid ? formatPortfolioAmount(Math.round(Math.max(0, numeric) * 100)) : (raw || "$0"),
        rawInput: valid ? String(numeric) : raw,
      };
    } else if (attr.type === "percent") {
      const numeric = Number(raw.replace(/[^0-9.-]/g, ""));
      const pct = Number.isFinite(numeric) ? Math.min(100, Math.max(0, Math.round(numeric))) : 0;
      result[key] = { display: `${pct}%`, rawInput: String(pct), percent: pct };
    } else if (attr.type === "number") {
      const numeric = Number(raw.replace(/[^0-9.-]/g, ""));
      result[key] = {
        display: Number.isFinite(numeric) ? numeric.toLocaleString("en-US") : (raw || "0"),
        rawInput: Number.isFinite(numeric) ? String(numeric) : raw,
      };
    } else {
      result[key] = { display: raw || "—", rawInput: raw };
    }
  }

  return result;
}

export function resolveMultiDomainBindings(
  personaId: string,
  options?: {
    effectiveFundingStatus?: "funded" | "unfunded";
    incident?: IncidentRecord;
    deal?: DealRecord;
  },
): DataBindingValues | undefined {
  const base = resolveCustomerBindings(personaId, options?.effectiveFundingStatus);
  if (!base && !options?.incident && !options?.deal) return undefined;
  const result: DataBindingValues = { ...(base ?? {}) };

  if (options?.incident) {
    const inc = options.incident;
    result["incident.id"] = { display: inc.id, rawInput: inc.id };
    result["incident.title"] = { display: inc.title, rawInput: inc.title };
    result["incident.severity"] = { display: inc.severity, rawInput: inc.severity };
    result["incident.status"] = { display: inc.status.replace("_", " ").toUpperCase(), rawInput: inc.status };
    result["incident.service"] = { display: inc.service, rawInput: inc.service };
    result["incident.environment"] = { display: inc.environment, rawInput: inc.environment };
    result["incident.errorRate"] = { display: `${inc.errorRatePct}%`, rawInput: String(inc.errorRatePct), percent: Math.min(100, Math.round(inc.errorRatePct)) };
    result["incident.p95Latency"] = { display: `${inc.p95LatencyMs}ms`, rawInput: String(inc.p95LatencyMs) };
    result["incident.currentRelease"] = { display: inc.currentRelease, rawInput: inc.currentRelease };
    result["incident.previousRelease"] = { display: inc.previousRelease, rawInput: inc.previousRelease };
    result["incident.rollbackStatus"] = { display: inc.rollbackStatus, rawInput: inc.rollbackStatus };
  }

  if (options?.deal) {
    const deal = options.deal;
    const usdFmt = `$${deal.arrUsd.toLocaleString("en-US")}`;
    result["deal.id"] = { display: deal.id, rawInput: deal.id };
    result["deal.accountName"] = { display: deal.accountName, rawInput: deal.accountName };
    result["deal.title"] = { display: deal.title, rawInput: deal.title };
    result["deal.stage"] = { display: deal.stage, rawInput: deal.stage };
    result["deal.arr"] = { display: usdFmt, rawInput: String(deal.arrUsd) };
    result["deal.discountPct"] = { display: `${deal.discountPct}%`, rawInput: String(deal.discountPct), percent: Math.min(100, Math.round(deal.discountPct)) };
    result["deal.discountStatus"] = { display: deal.discountStatus, rawInput: deal.discountStatus };
    result["deal.winProbability"] = { display: `${deal.winProbabilityPct}%`, rawInput: String(deal.winProbabilityPct), percent: deal.winProbabilityPct };
    result["deal.closeDate"] = { display: deal.closeDate, rawInput: deal.closeDate };
    result["deal.owner"] = { display: deal.owner, rawInput: deal.owner };
  }

  return result;
}
