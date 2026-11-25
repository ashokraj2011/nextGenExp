import { useEffect, useState } from "react";
import { Activity, ArrowUpRight, Briefcase, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import type { IncidentRecord, IncidentUpsertInput, OpsIncidentsView } from "../../packages/contracts/ops";
import type { DealRecord, DealUpsertInput, SalesDealsView } from "../../packages/contracts/sales";
import { api } from "./api";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function emptyIncident(): IncidentUpsertInput {
  return {
    title: "",
    severity: "P1",
    status: "open",
    service: "Checkout API",
    environment: "Production · US-East",
    errorRatePct: 3.5,
    baselineErrorRatePct: 0.2,
    p95LatencyMs: 520,
    affectedUsers: 850,
    currentRelease: "v2.15.0",
    previousRelease: "v2.14.9",
    slaMinutes: 30,
    owner: "On-Call SRE",
    summary: "",
    rollbackStatus: "pending",
  };
}

function incidentToInput(item: IncidentRecord): IncidentUpsertInput {
  return {
    id: item.id,
    title: item.title,
    severity: item.severity,
    status: item.status,
    service: item.service,
    environment: item.environment,
    errorRatePct: item.errorRatePct,
    baselineErrorRatePct: item.baselineErrorRatePct,
    p95LatencyMs: item.p95LatencyMs,
    affectedUsers: item.affectedUsers,
    currentRelease: item.currentRelease,
    previousRelease: item.previousRelease,
    slaMinutes: item.slaMinutes,
    owner: item.owner,
    summary: item.summary,
    rollbackStatus: item.rollbackStatus,
  };
}

export function OpsIncidentsEditor() {
  const [view, setView] = useState<OpsIncidentsView | null>(null);
  const [selectedId, setSelectedId] = useState<string>("new");
  const [form, setForm] = useState<IncidentUpsertInput>(() => emptyIncident());
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    let active = true;
    void api.opsIncidents().then((res) => {
      if (!active) return;
      setView(res);
      if (res.incidents[0]) {
        setSelectedId(res.incidents[0].id);
        setForm(incidentToInput(res.incidents[0]));
      }
    }).catch(() => {
      if (active) setNotice({ tone: "error", text: "Could not load live incidents." });
    });
    return () => { active = false; };
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim() || !form.summary.trim()) {
      setNotice({ tone: "error", text: "Title and summary are required." });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const res = await api.saveOpsIncident({
        ...form,
        ...(selectedId === "new" ? { id: undefined } : { id: selectedId }),
      });
      setView(res.view);
      setSelectedId(res.incident.id);
      setForm(incidentToInput(res.incident));
      setNotice({ tone: "ok", text: `Saved ${res.incident.id} to incidents.json — IT Ops HUD & triage updated live.` });
    } catch {
      setNotice({ tone: "error", text: "Could not save incident." });
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    setSaving(true);
    try {
      const res = await api.deleteOpsIncident(id);
      setView(res.view);
      const first = res.view.incidents[0];
      if (first) {
        setSelectedId(first.id);
        setForm(incidentToInput(first));
      }
      setNotice({ tone: "ok", text: `Removed ${id} from incidents.json.` });
    } finally {
      setSaving(false);
    }
  }

  async function resetAll() {
    setSaving(true);
    try {
      const res = await api.resetOpsIncidents();
      setView(res);
      if (res.incidents[0]) {
        setSelectedId(res.incidents[0].id);
        setForm(incidentToInput(res.incidents[0]));
      }
      setNotice({ tone: "ok", text: "Reset incidents.json to default active P1 demo state." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="c360-header" style={{ marginBottom: "14px" }}>
        <div>
          <p className="c360-eyebrow"><Activity size={15} aria-hidden="true" />Live IT Operations Store (incidents.json)</p>
          <h1>IT Incidents &amp; Alerts</h1>
          <p className="c360-subtitle">
            Create or edit live P1/P2/P3 incidents. Changes flow immediately into the IT Ops Chat HUD, Dynamic Triage Dashboard, and <code>cep.recommendations.arbitrate@1.0.0</code>.
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button type="button" className="secondary-button" disabled={saving} onClick={() => void resetAll()}>
            <RotateCcw size={14} aria-hidden="true" />Reset defaults
          </button>
          <button type="button" className="c360-primary-btn" onClick={() => { setSelectedId("new"); setForm(emptyIncident()); setNotice(null); }}>
            <Plus size={16} aria-hidden="true" />New incident
          </button>
        </div>
      </div>

      {notice && <p className={"c360-notice " + (notice.tone === "error" ? "is-error" : "is-ok")} role="status">{notice.text}</p>}

      <div className="c360-grid">
        <section className="c360-directory" aria-label="Live incidents">
          <div className="c360-directory-head">
            <h2>Incidents ({view?.incidents.length ?? 0})</h2>
          </div>
          <div className="c360-list">
            {(view?.incidents ?? []).map((inc) => (
              <button
                key={inc.id}
                type="button"
                className={"c360-list-item" + (selectedId === inc.id ? " is-active" : "")}
                onClick={() => { setSelectedId(inc.id); setForm(incidentToInput(inc)); setNotice(null); }}
              >
                <div className="c360-list-meta">
                  <div className="c360-list-title-row">
                    <strong>{inc.id}</strong>
                    <span className="c360-tag tag-edited">{inc.severity} · {inc.status.replace("_", " ")}</span>
                  </div>
                  <span className="c360-list-sub">{inc.title}</span>
                  <div className="c360-list-stats">
                    <span>{inc.errorRatePct}% err</span>
                    <span>·</span>
                    <span>p95 {inc.p95LatencyMs}ms</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="c360-editor-column" aria-label="Incident editor">
          <form className="c360-card c360-form" onSubmit={(e) => void save(e)}>
            <div className="c360-form-header">
              <div>
                <h2>{selectedId === "new" ? "Create new incident" : `Edit ${selectedId}`}</h2>
                <p className="c360-id-line">Source: <code>incidents.json</code></p>
              </div>
              <button
                type="button"
                className="secondary-button c360-launch-btn"
                onClick={() => { location.assign("/it-ops"); }}
              >
                Open IT Ops workspace <ArrowUpRight size={14} aria-hidden="true" />
              </button>
            </div>

            <div className="c360-field-grid">
              <label className="c360-field c360-span-2">
                <span>Incident title</span>
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g., Payment Gateway 5xx Spike" required />
              </label>
              <label className="c360-field">
                <span>Severity</span>
                <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as IncidentUpsertInput["severity"] })}>
                  <option value="P1">P1 · Critical</option>
                  <option value="P2">P2 · High</option>
                  <option value="P3">P3 · Standard</option>
                </select>
              </label>
              <label className="c360-field">
                <span>Status</span>
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as IncidentUpsertInput["status"] })}>
                  <option value="open">open</option>
                  <option value="mitigating">mitigating</option>
                  <option value="rolled_back">rolled_back</option>
                  <option value="resolved">resolved</option>
                  <option value="escalated">escalated</option>
                </select>
              </label>
              <label className="c360-field">
                <span>Service</span>
                <input value={form.service} onChange={(e) => setForm({ ...form, service: e.target.value })} required />
              </label>
              <label className="c360-field">
                <span>Environment</span>
                <input value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })} required />
              </label>
              <label className="c360-field">
                <span>Error rate (%)</span>
                <input type="number" step="0.1" min="0" max="100" value={form.errorRatePct} onChange={(e) => setForm({ ...form, errorRatePct: Number(e.target.value) })} />
              </label>
              <label className="c360-field">
                <span>p95 Latency (ms)</span>
                <input type="number" step="1" min="0" value={form.p95LatencyMs} onChange={(e) => setForm({ ...form, p95LatencyMs: Number(e.target.value) })} />
              </label>
              <label className="c360-field">
                <span>Current release</span>
                <input value={form.currentRelease} onChange={(e) => setForm({ ...form, currentRelease: e.target.value })} />
              </label>
              <label className="c360-field">
                <span>Previous healthy release</span>
                <input value={form.previousRelease} onChange={(e) => setForm({ ...form, previousRelease: e.target.value })} />
              </label>
              <label className="c360-field">
                <span>Rollback approval status</span>
                <select value={form.rollbackStatus} onChange={(e) => setForm({ ...form, rollbackStatus: e.target.value as IncidentUpsertInput["rollbackStatus"] })}>
                  <option value="pending">pending</option>
                  <option value="approved">approved</option>
                  <option value="rejected">rejected</option>
                  <option value="not_applicable">not_applicable</option>
                </select>
              </label>
              <label className="c360-field">
                <span>Owner</span>
                <input value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} />
              </label>
              <label className="c360-field c360-span-2">
                <span>Operational summary</span>
                <textarea rows={3} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} required />
              </label>
            </div>

            <div className="c360-form-actions">
              <button type="submit" className="c360-primary-btn" disabled={saving}>
                <Save size={15} aria-hidden="true" />{saving ? "Saving…" : "Save incident"}
              </button>
              {selectedId !== "new" && (
                <button type="button" className="secondary-button" disabled={saving} onClick={() => void remove(selectedId)}>
                  <Trash2 size={14} aria-hidden="true" />Delete
                </button>
              )}
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

function emptyDeal(): DealUpsertInput {
  return {
    accountName: "",
    title: "",
    stage: "Negotiation",
    arrUsd: 350000,
    discountPct: 16,
    discountStatus: "pending",
    winProbabilityPct: 70,
    closeDate: "2026-12-20",
    owner: "Jordan Blake · Enterprise AE",
    segment: "Enterprise · North America",
    summary: "",
  };
}

function dealToInput(deal: DealRecord): DealUpsertInput {
  return {
    id: deal.id,
    accountName: deal.accountName,
    title: deal.title,
    stage: deal.stage,
    arrUsd: deal.arrUsd,
    discountPct: deal.discountPct,
    discountStatus: deal.discountStatus,
    winProbabilityPct: deal.winProbabilityPct,
    closeDate: deal.closeDate,
    owner: deal.owner,
    segment: deal.segment,
    summary: deal.summary,
  };
}

export function SalesDealsEditor() {
  const [view, setView] = useState<SalesDealsView | null>(null);
  const [selectedId, setSelectedId] = useState<string>("new");
  const [form, setForm] = useState<DealUpsertInput>(() => emptyDeal());
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    let active = true;
    void api.salesDeals().then((res) => {
      if (!active) return;
      setView(res);
      if (res.deals[0]) {
        setSelectedId(res.deals[0].id);
        setForm(dealToInput(res.deals[0]));
      }
    }).catch(() => {
      if (active) setNotice({ tone: "error", text: "Could not load live CRM deals." });
    });
    return () => { active = false; };
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.accountName.trim() || !form.title.trim() || !form.summary.trim()) {
      setNotice({ tone: "error", text: "Account name, deal title, and summary are required." });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const res = await api.saveSalesDeal({
        ...form,
        ...(selectedId === "new" ? { id: undefined } : { id: selectedId }),
      });
      setView(res.view);
      setSelectedId(res.deal.id);
      setForm(dealToInput(res.deal));
      setNotice({ tone: "ok", text: `Saved ${res.deal.id} (${res.deal.accountName}) to deals.json — RevOps HUD updated live.` });
    } catch {
      setNotice({ tone: "error", text: "Could not save deal." });
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    setSaving(true);
    try {
      const res = await api.deleteSalesDeal(id);
      setView(res.view);
      const first = res.view.deals[0];
      if (first) {
        setSelectedId(first.id);
        setForm(dealToInput(first));
      }
      setNotice({ tone: "ok", text: `Removed ${id} from deals.json.` });
    } finally {
      setSaving(false);
    }
  }

  async function resetAll() {
    setSaving(true);
    try {
      const res = await api.resetSalesDeals();
      setView(res);
      if (res.deals[0]) {
        setSelectedId(res.deals[0].id);
        setForm(dealToInput(res.deals[0]));
      }
      setNotice({ tone: "ok", text: "Reset deals.json to default Q4 Deal Desk state." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="c360-header" style={{ marginBottom: "14px" }}>
        <div>
          <p className="c360-eyebrow"><Briefcase size={15} aria-hidden="true" />Live CRM Deal Store (deals.json)</p>
          <h1>Sales Deals &amp; Pricing Approvals</h1>
          <p className="c360-subtitle">
            {view
              ? `Live Q4 Pipeline: ${usd.format(view.summary.totalPipelineUsd)} · Weighted Forecast: ${usd.format(view.summary.weightedForecastUsd)} · Pending Approvals: ${view.summary.pendingApprovals}`
              : "Create or edit live enterprise deals feeding the RevOps HUD and Deal Desk."}
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button type="button" className="secondary-button" disabled={saving} onClick={() => void resetAll()}>
            <RotateCcw size={14} aria-hidden="true" />Reset defaults
          </button>
          <button type="button" className="c360-primary-btn" onClick={() => { setSelectedId("new"); setForm(emptyDeal()); setNotice(null); }}>
            <Plus size={16} aria-hidden="true" />New deal
          </button>
        </div>
      </div>

      {notice && <p className={"c360-notice " + (notice.tone === "error" ? "is-error" : "is-ok")} role="status">{notice.text}</p>}

      <div className="c360-grid">
        <section className="c360-directory" aria-label="Live CRM deals">
          <div className="c360-directory-head">
            <h2>Deals ({view?.deals.length ?? 0})</h2>
          </div>
          <div className="c360-list">
            {(view?.deals ?? []).map((deal) => (
              <button
                key={deal.id}
                type="button"
                className={"c360-list-item" + (selectedId === deal.id ? " is-active" : "")}
                onClick={() => { setSelectedId(deal.id); setForm(dealToInput(deal)); setNotice(null); }}
              >
                <div className="c360-list-meta">
                  <div className="c360-list-title-row">
                    <strong>{deal.accountName}</strong>
                    <span className="c360-tag tag-edited">{deal.stage}</span>
                  </div>
                  <span className="c360-list-sub">{deal.id} · {deal.title}</span>
                  <div className="c360-list-stats">
                    <span>{usd.format(deal.arrUsd)} ARR</span>
                    <span>·</span>
                    <span>{deal.discountPct}% ({deal.discountStatus})</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="c360-editor-column" aria-label="Deal editor">
          <form className="c360-card c360-form" onSubmit={(e) => void save(e)}>
            <div className="c360-form-header">
              <div>
                <h2>{selectedId === "new" ? "Create new deal" : `Edit ${form.accountName || selectedId}`}</h2>
                <p className="c360-id-line">Source: <code>deals.json</code></p>
              </div>
              <button
                type="button"
                className="secondary-button c360-launch-btn"
                onClick={() => { location.assign("/revops"); }}
              >
                Open RevOps workspace <ArrowUpRight size={14} aria-hidden="true" />
              </button>
            </div>

            <div className="c360-field-grid">
              <label className="c360-field">
                <span>Account name</span>
                <input value={form.accountName} onChange={(e) => setForm({ ...form, accountName: e.target.value })} placeholder="e.g., Meridian BioLabs" required />
              </label>
              <label className="c360-field">
                <span>Deal title</span>
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g., Enterprise Expansion" required />
              </label>
              <label className="c360-field">
                <span>Stage</span>
                <select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value as DealUpsertInput["stage"] })}>
                  <option value="Discovery">Discovery</option>
                  <option value="Proposal">Proposal</option>
                  <option value="Security Review">Security Review</option>
                  <option value="Negotiation">Negotiation</option>
                  <option value="Commit">Commit</option>
                  <option value="Closed Won">Closed Won</option>
                </select>
              </label>
              <label className="c360-field">
                <span>ARR (USD)</span>
                <input type="number" step="1000" min="0" value={form.arrUsd} onChange={(e) => setForm({ ...form, arrUsd: Math.round(Number(e.target.value)) })} />
              </label>
              <label className="c360-field">
                <span>Discount (%)</span>
                <input type="number" step="1" min="0" max="60" value={form.discountPct} onChange={(e) => setForm({ ...form, discountPct: Number(e.target.value) })} />
              </label>
              <label className="c360-field">
                <span>Discount approval status</span>
                <select value={form.discountStatus} onChange={(e) => setForm({ ...form, discountStatus: e.target.value as DealUpsertInput["discountStatus"] })}>
                  <option value="pending">pending</option>
                  <option value="approved">approved</option>
                  <option value="rejected">rejected</option>
                  <option value="none">none</option>
                </select>
              </label>
              <label className="c360-field">
                <span>Win probability (%)</span>
                <input type="number" step="1" min="0" max="100" value={form.winProbabilityPct} onChange={(e) => setForm({ ...form, winProbabilityPct: Math.round(Number(e.target.value)) })} />
              </label>
              <label className="c360-field">
                <span>Target close date</span>
                <input value={form.closeDate} onChange={(e) => setForm({ ...form, closeDate: e.target.value })} />
              </label>
              <label className="c360-field">
                <span>Owner</span>
                <input value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} />
              </label>
              <label className="c360-field">
                <span>Segment</span>
                <input value={form.segment} onChange={(e) => setForm({ ...form, segment: e.target.value })} />
              </label>
              <label className="c360-field c360-span-2">
                <span>Commercial summary</span>
                <textarea rows={3} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} required />
              </label>
            </div>

            <div className="c360-form-actions">
              <button type="submit" className="c360-primary-btn" disabled={saving}>
                <Save size={15} aria-hidden="true" />{saving ? "Saving…" : "Save deal"}
              </button>
              {selectedId !== "new" && (
                <button type="button" className="secondary-button" disabled={saving} onClick={() => void remove(selectedId)}>
                  <Trash2 size={14} aria-hidden="true" />Delete
                </button>
              )}
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
