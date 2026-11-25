import { useCallback, useEffect, useState } from "react";
import { Activity, Database, RotateCcw, ShieldAlert, TrendingUp } from "lucide-react";
import {
  domainPackFromPath,
  domainPackPath,
  getDomainPack,
  type DomainPack,
  type DomainPackId,
} from "../../packages/contracts/domain-packs";
import type { OpsIncidentsView } from "../../packages/contracts/ops";
import type { SalesDealsView } from "../../packages/contracts/sales";
import { api } from "./api";

const STORAGE_KEY = "cep-domain-pack";
const CHANGE_EVENT = "cep-domain-change";
const DATA_EVENT = "cep-domain-data-updated";

export function readStoredDomainPack(): DomainPackId {
  const fromPath = typeof window !== "undefined" ? domainPackFromPath(window.location.pathname) : null;
  if (fromPath) return fromPath;
  if (typeof window !== "undefined" && window.location.pathname === "/embed") {
    const embedded = new URLSearchParams(window.location.search).get("domain");
    if (embedded === "it_ops" || embedded === "sales_revops" || embedded === "wealth") return embedded;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "it_ops" || raw === "sales_revops" || raw === "wealth") return raw;
  } catch { /* ignore */ }
  return "wealth";
}

export function setStoredDomainPack(id: DomainPackId) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent<DomainPackId>(CHANGE_EVENT, { detail: id }));
}

export function notifyDomainDataUpdated() {
  window.dispatchEvent(new CustomEvent(DATA_EVENT));
}

export function useDomainPack(): [DomainPack, (id: DomainPackId) => void] {
  const isEmbed = typeof window !== "undefined" && window.location.pathname === "/embed";
  const [packId, setPackId] = useState<DomainPackId>(() => readStoredDomainPack());

  useEffect(() => {
    if (!isEmbed) return;
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<DomainPackId>).detail;
      if (next === "wealth" || next === "it_ops" || next === "sales_revops") setPackId(next);
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, [isEmbed]);

  const select = useCallback((id: DomainPackId) => {
    if (isEmbed) {
      setStoredDomainPack(id);
      setPackId(id);
      return;
    }
    const targetPath = domainPackPath(id);
    if (window.location.pathname !== targetPath) {
      window.location.assign(targetPath);
    }
  }, [isEmbed]);

  return [getDomainPack(packId), select];
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function DomainLiveHud({
  domainId,
  disabled,
  onPrompt,
}: {
  domainId: "it_ops" | "sales_revops";
  disabled: boolean;
  onPrompt: (prompt: string) => void;
}) {
  const [ops, setOps] = useState<OpsIncidentsView | null>(null);
  const [sales, setSales] = useState<SalesDealsView | null>(null);
  const [resetting, setResetting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      if (domainId === "it_ops") setOps(await api.opsIncidents());
      else setSales(await api.salesDeals());
    } catch { /* ignore transient network failure */ }
  }, [domainId]);

  useEffect(() => {
    void refresh();
    const onData = () => void refresh();
    window.addEventListener(DATA_EVENT, onData);
    return () => window.removeEventListener(DATA_EVENT, onData);
  }, [refresh]);

  async function resetDemo() {
    if (resetting) return;
    setResetting(true);
    try {
      if (domainId === "it_ops") setOps(await api.resetOpsIncidents());
      else setSales(await api.resetSalesDeals());
      notifyDomainDataUpdated();
    } finally {
      setResetting(false);
    }
  }

  if (domainId === "it_ops") {
    const primary = ops?.incidents.find((i) => i.id === "INC-4821") ?? ops?.incidents[0];
    const isResolved = primary && (primary.status === "rolled_back" || primary.status === "resolved");
    return (
      <section className="allocation-arch-card domain-live-hud" aria-label="Live IT Operations telemetry">
        <div className="domain-hud-top">
          <div className="domain-hud-title-group">
            <span className="domain-hud-kicker">
              <ShieldAlert size={13} aria-hidden="true" />
              LIVE IT INCIDENT COMMAND
            </span>
            <span className="dyn-live-badge">
              <Database size={11} aria-hidden="true" />
              incidents.json
            </span>
          </div>
          <div className="domain-hud-actions">
            <button type="button" className="hud-action" disabled={disabled} onClick={() => onPrompt("Build an IT incident triage dashboard for our active P1 alert")}>
              Open P1 Triage
            </button>
            <button type="button" className="hud-action" disabled={resetting} onClick={() => void resetDemo()} title="Reset incidents.json to active P1 demo state">
              <RotateCcw size={12} aria-hidden="true" />
              {resetting ? "Resetting…" : "Reset"}
            </button>
          </div>
        </div>
        {primary && ops ? (
          <div className="domain-hud-metrics">
            <span><strong>{primary.id}</strong> · {primary.service}</span>
            <span className={isResolved ? "domain-pill-ok" : "legend-badge-warn"}>
              {primary.severity} · {primary.status.replace("_", " ").toUpperCase()}
            </span>
            <span>Error rate <strong>{primary.errorRatePct}%</strong></span>
            <span>p95 <strong>{primary.p95LatencyMs}ms</strong></span>
            <span>Open queue <strong>{ops.summary.totalOpen}</strong></span>
          </div>
        ) : (
          <p className="domain-hud-loading">Connecting to live incident store…</p>
        )}
      </section>
    );
  }

  const primaryDeal = sales?.deals.find((d) => d.id === "DEAL-904") ?? sales?.deals[0];
  const dealApproved = primaryDeal?.discountStatus === "approved";
  return (
    <section className="allocation-arch-card domain-live-hud" aria-label="Live Q4 Sales Pipeline telemetry">
      <div className="domain-hud-top">
        <div className="domain-hud-title-group">
          <span className="domain-hud-kicker">
            <TrendingUp size={13} aria-hidden="true" />
            LIVE Q4 PIPELINE &amp; DEAL DESK
          </span>
          <span className="dyn-live-badge">
            <Database size={11} aria-hidden="true" />
            deals.json
          </span>
        </div>
        <div className="domain-hud-actions">
          <button type="button" className="hud-action" disabled={disabled} onClick={() => onPrompt("Build a Q4 deal desk and discount approval dashboard for DEAL-904")}>
            Open Deal Desk
          </button>
          <button type="button" className="hud-action" disabled={resetting} onClick={() => void resetDemo()} title="Reset deals.json to pending approval demo state">
            <RotateCcw size={12} aria-hidden="true" />
            {resetting ? "Resetting…" : "Reset"}
          </button>
        </div>
      </div>
      {primaryDeal && sales ? (
        <div className="domain-hud-metrics">
          <span>Pipeline <strong>{usd.format(sales.summary.totalPipelineUsd)}</strong></span>
          <span>Forecast <strong>{usd.format(sales.summary.weightedForecastUsd)}</strong></span>
          <span><strong>{primaryDeal.id}</strong> · {primaryDeal.accountName} ({usd.format(primaryDeal.arrUsd)})</span>
          <span className={dealApproved ? "domain-pill-ok" : "legend-badge-warn"}>
            {primaryDeal.stage} · {primaryDeal.discountPct}% {primaryDeal.discountStatus}
          </span>
          <span>Prob. <strong>{primaryDeal.winProbabilityPct}%</strong></span>
        </div>
      ) : (
        <p className="domain-hud-loading">Connecting to live CRM deal store…</p>
      )}
    </section>
  );
}

export function DomainWelcomeHome({
  domainId,
  disabled,
  onPrompt,
}: {
  domainId: "it_ops" | "sales_revops";
  disabled: boolean;
  onPrompt: (prompt: string) => void;
}) {
  const pack = getDomainPack(domainId);
  return (
    <>
      <div className="overview-banner">
        <h1>{domainId === "it_ops" ? "IT Operations Command." : "Revenue Operations Hub."}</h1>
      </div>
      <section className="content-card domain-welcome-card">
        <span className="dyn-live-badge"><Database size={12} aria-hidden="true" />{pack.dataSourceLabel}</span>
        <h2>{domainId === "it_ops" ? "Active Incident & SRE Actions" : "Q4 Deal Desk & Pipeline"}</h2>
        <p>{pack.subtitle}. Ask a question above or launch a live grounded workspace below.</p>
        <div className="domain-welcome-pills">
          {pack.quickPrompts.map((item) => (
            <button key={item.label} type="button" className="hud-action" disabled={disabled} onClick={() => onPrompt(item.prompt)}>
              {item.label}
            </button>
          ))}
        </div>
      </section>
      <section className="content-card domain-welcome-card">
        <span className="dyn-live-badge"><Activity size={12} aria-hidden="true" />sfield · cep.recommendations.arbitrate@1.0.0</span>
        <h2>{domainId === "it_ops" ? "Governed Change Control" : "Governed Pricing Approvals"}</h2>
        <p>
          {domainId === "it_ops"
            ? "Approving or holding a rollback persists immediately to incidents.json, updates live error rate & latency telemetry, and logs the decision."
            : "Approving or holding a discount persists immediately to deals.json, advances the deal stage to Commit, and recalculates Q4 weighted forecast."}
        </p>
        <div className="domain-welcome-pills">
          {pack.topics.slice(0, 2).map((t) => (
            <button key={t.id} type="button" className="overview-action" disabled={disabled} onClick={() => onPrompt(t.prompt)}>
              {t.name}
            </button>
          ))}
        </div>
      </section>
    </>
  );
}
