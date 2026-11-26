import { useEffect, useState } from "react";
import { CheckCircle2, Headphones, MessageSquare, RotateCw, Send, UserCheck } from "lucide-react";
import type { HandoffInboxView, HandoffTicket } from "../../packages/contracts/handoff";
import { api, toolSetupErrorMessage } from "./api";
import { MultiplayerCoBrowseCard } from "./nextgen-chat-features";

export function HandoffInboxPanel() {
  const [data, setData] = useState<HandoffInboxView>();
  const [replyById, setReplyById] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    void api.handoffs().then(
      (res) => { if (active) setData(res); },
      (err: unknown) => { if (active) setError(toolSetupErrorMessage(err)); },
    );
    return () => { active = false; };
  }, [tick]);

  async function claim(id: string) {
    setBusyId(id); setError(""); setNotice("");
    try {
      const res = await api.claimHandoff(id);
      setData(res.view);
      setNotice(`Claimed handoff ${id}.`);
    } catch (e) { setError(toolSetupErrorMessage(e)); } finally { setBusyId(null); }
  }

  async function reply(id: string) {
    const text = (replyById[id] ?? "").trim();
    if (!text) return;
    setBusyId(id); setError(""); setNotice("");
    try {
      const res = await api.replyHandoff(id, text);
      setData(res.view);
      setReplyById((prev) => ({ ...prev, [id]: "" }));
      setNotice(`Sent advisor reply on ${id}.`);
    } catch (e) { setError(toolSetupErrorMessage(e)); } finally { setBusyId(null); }
  }

  async function resolve(id: string) {
    setBusyId(id); setError(""); setNotice("");
    try {
      const res = await api.resolveHandoff(id);
      setData(res.view);
      setNotice(`Resolved handoff ${id}.`);
    } catch (e) { setError(toolSetupErrorMessage(e)); } finally { setBusyId(null); }
  }

  return (
    <section className="admin-card" aria-labelledby="handoff-inbox-title">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <div>
          <h2 id="handoff-inbox-title" style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <Headphones size={18} aria-hidden="true" />
            Live Human Agent Warm Handoff Inbox
          </h2>
          <p>
            Customer conversations escalated to a human advisor arrive here with a structured AI brief, Customer 360 snapshot, and recent transcript so the specialist can pick up seamlessly.
          </p>
        </div>
        <button className="secondary-button" type="button" onClick={() => setTick((t) => t + 1)}>
          <RotateCw size={15} aria-hidden="true" />Refresh
        </button>
      </div>

      {data && (
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginTop: "12px", fontSize: "0.84rem" }}>
          <span>Queued: <strong>{data.queuedCount}</strong></span>
          <span>Active (Claimed): <strong>{data.claimedCount}</strong></span>
          <span>Resolved: <strong>{data.resolvedCount}</strong></span>
        </div>
      )}

      {notice && <p role="status" style={{ marginTop: "10px", color: "var(--teal-dark)", fontWeight: 600 }}>{notice}</p>}
      {error && <p className="request-notice" role="alert" style={{ marginTop: "10px" }}>{error}</p>}
      {!data && !error && <p className="workspace-loading" role="status">Loading handoff queue…</p>}

      {data && data.tickets.length === 0 && (
        <p className="admin-muted" style={{ marginTop: "14px" }}>
          No live escalations yet. Customers can ask <em>&quot;talk to a human advisor&quot;</em> in chat (or POST <code>/api/handoffs</code>) to open a warm handoff.
        </p>
      )}

      {data && data.tickets.length > 0 && (
        <div style={{ display: "grid", gap: "14px", marginTop: "14px" }}>
          {data.tickets.map((t) => (
            <article key={t.handoffId} style={{ border: "1px solid var(--line)", borderRadius: "10px", padding: "14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "10px", flexWrap: "wrap" }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: "1rem" }}>
                    {t.customerName} · <code style={{ fontSize: "0.8rem" }}>{t.handoffId}</code>
                  </h3>
                  <small className="admin-muted">
                    Domain: {t.domain} · Priority: <strong>{t.priority}</strong> · Status: <strong>{t.status}</strong>
                    {t.assignedAgent ? ` · Specialist: ${t.assignedAgent}` : ""}
                  </small>
                </div>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  {t.status === "queued" && (
                    <button type="button" className="send-button" disabled={busyId === t.handoffId} onClick={() => void claim(t.handoffId)}>
                      <UserCheck size={14} aria-hidden="true" />Claim
                    </button>
                  )}
                  {t.status !== "resolved" && (
                    <button type="button" className="secondary-button" disabled={busyId === t.handoffId} onClick={() => void resolve(t.handoffId)}>
                      <CheckCircle2 size={14} aria-hidden="true" />Resolve
                    </button>
                  )}
                </div>
              </div>

              <p style={{ marginTop: "10px", fontSize: "0.88rem" }}><strong>AI Brief:</strong> {t.aiBrief}</p>

              {Object.keys(t.customerSnapshot).length > 0 && (
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "8px" }}>
                  {Object.entries(t.customerSnapshot).map(([k, v]) => (
                    <span key={k} style={{ padding: "3px 8px", borderRadius: "6px", border: "1px solid var(--line)", fontSize: "0.78rem" }}>
                      {k}: <strong>{v}</strong>
                    </span>
                  ))}
                </div>
              )}

              {t.status !== "resolved" && (
                <MultiplayerCoBrowseCard
                  ticket={t}
                  role="advisor"
                  onTicketUpdated={(nextTicket: HandoffTicket) => {
                    setData((prev) => prev ? {
                      ...prev,
                      tickets: prev.tickets.map((x) => (x.handoffId === nextTicket.handoffId ? nextTicket : x)),
                    } : prev);
                  }}
                />
              )}

              {t.notes.length > 0 && (
                <div style={{ marginTop: "10px", paddingTop: "8px", borderTop: "1px solid var(--line)", display: "grid", gap: "6px" }}>
                  {t.notes.map((n) => (
                    <div key={n.id} style={{ fontSize: "0.82rem" }}>
                      <MessageSquare size={12} aria-hidden="true" style={{ verticalAlign: "middle", marginRight: "5px" }} />
                      <strong>{n.author}</strong> <span className="admin-muted">({n.role})</span>: {n.text}
                    </div>
                  ))}
                </div>
              )}

              {t.status !== "resolved" && (
                <form
                  style={{ display: "flex", gap: "8px", marginTop: "10px" }}
                  onSubmit={(e) => { e.preventDefault(); void reply(t.handoffId); }}
                >
                  <input
                    style={{ flex: 1, padding: "7px 10px", borderRadius: "6px", border: "1px solid var(--line)", background: "transparent", color: "inherit" }}
                    placeholder="Reply to customer as live specialist…"
                    value={replyById[t.handoffId] ?? ""}
                    onChange={(e) => setReplyById((prev) => ({ ...prev, [t.handoffId]: e.target.value }))}
                  />
                  <button type="submit" className="send-button" disabled={busyId === t.handoffId || !(replyById[t.handoffId] ?? "").trim()}>
                    <Send size={13} aria-hidden="true" />Send
                  </button>
                </form>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
