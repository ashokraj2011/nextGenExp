import { useEffect, useState } from "react";
import { Radio, Send, Trash2 } from "lucide-react";
import type { ProactiveAlert, ProactiveEventType } from "../../packages/contracts/proactive-events";
import { api } from "./api";

const EVENT_PRESETS: { eventType: ProactiveEventType; label: string; detail: string }[] = [
  { eventType: "market.price_alert", label: "AAPL +8.4% Tax-Harvest Alert", detail: "Pushes Wealth tax-loss harvest opportunity to Chat & /embed" },
  { eventType: "portfolio.large_deposit", label: "$25k Wire Deposit Landed", detail: "Pushes idle-cash allocation opportunity card" },
  { eventType: "ops.latency_spike", label: "P1 Edge Latency Spike (442ms)", detail: "Pushes critical IT Ops rollback triage alert" },
  { eventType: "sales.deal_at_risk", label: "Acme Deal At Risk ($420k ARR)", detail: "Pushes Sales RevOps Deal Desk approval prompt" },
];

export function ProactiveEventsCard() {
  const [alerts, setAlerts] = useState<ProactiveAlert[]>([]);
  const [busyType, setBusyType] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let alive = true;
    void api.proactiveAlerts().then((view) => {
      if (alive) setAlerts(view.alerts);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  async function fire(eventType: ProactiveEventType) {
    setBusyType(eventType);
    setNotice("");
    try {
      const res = await api.triggerProactiveEvent({ eventType, personaId: "demo-learner" });
      setAlerts(res.view.alerts);
      setNotice(`Broadcasted "${res.alert.title}" live over SSE (/api/proactive/stream) to connected Chat & /embed sessions.`);
    } catch (err: unknown) {
      setNotice(err instanceof Error ? err.message : "Could not fire proactive event.");
    } finally {
      setBusyType(null);
    }
  }

  async function dismiss(id: string) {
    try {
      const view = await api.dismissProactiveAlert(id);
      setAlerts(view.alerts);
    } catch { /* ignore */ }
  }

  return (
    <section className="embed-card proactive-admin-card" aria-labelledby="proactive-events-title">
      <div className="embed-omni-head">
        <div>
          <h2 id="proactive-events-title"><Radio size={16} aria-hidden="true" /> 4. Proactive Event-Driven Engagement (Live SSE Push)</h2>
          <p className="embed-card-sub">
            Simulate external market, deposit, SRE, or CRM webhook events (<code>POST /api/proactive/trigger</code>).
            CEP immediately pushes an actionable alert banner into live <code>/chat</code> and <code>/embed</code> workspaces and emits <code>cep:proactive_alert</code> to embedding host portals.
          </p>
        </div>
      </div>

      {notice && <div className="embed-notice" role="status">{notice}</div>}

      <div className="proactive-trigger-grid">
        {EVENT_PRESETS.map((preset) => (
          <button
            key={preset.eventType}
            type="button"
            className="proactive-trigger-btn"
            disabled={busyType === preset.eventType}
            onClick={() => void fire(preset.eventType)}
          >
            <div>
              <strong>{preset.label}</strong>
              <small>{preset.detail}</small>
            </div>
            <Send size={14} aria-hidden="true" />
          </button>
        ))}
      </div>

      <div className="embed-delivery-log" style={{ marginTop: "14px" }}>
        <h3>Broadcasted Proactive Alerts ({alerts.length})</h3>
        {alerts.length === 0 ? (
          <p className="embed-empty-note">No proactive events fired yet. Open <code>/embed-demo</code> or <code>/chat</code> in another tab and click any trigger above to see instant SSE push.</p>
        ) : (
          <div className="embed-delivery-list">
            {alerts.slice(0, 6).map((a) => (
              <div key={a.id} className="embed-delivery-row">
                <div className="embed-delivery-top">
                  <span className={`embed-status-pill is-${a.dismissed ? "sandbox_preview" : "delivered"}`}>
                    {a.dismissed ? "dismissed" : a.severity}
                  </span>
                  <strong>{a.title}</strong>
                  <span className="embed-delivery-meta">{a.domain} · {a.metricValue}</span>
                  {!a.dismissed && (
                    <button type="button" className="wf-icon-del" title="Dismiss" onClick={() => void dismiss(a.id)}>
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  )}
                </div>
                <small>{a.summary}</small>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
