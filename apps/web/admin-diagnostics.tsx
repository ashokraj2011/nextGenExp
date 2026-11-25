import { useEffect, useId, useState } from "react";
import { BarChart3, RotateCw, ShieldCheck } from "lucide-react";
import { adminPaths } from "../../packages/contracts/admin-paths";
import type { Bootstrap, ConversationView, DomainWriteAuditEntry, EngagementAnalyticsView } from "../../packages/contracts/api";
import { pendingActionsContext } from "../../packages/contracts/workspace";
import { api, toolSetupErrorMessage } from "./api";
import { diagnosticHref } from "./admin-navigation";
import { CallLogs, PendingActionLogs } from "./call-logs";
import { Inspector } from "./inspector";
import { readActiveConversation, rememberActiveConversation } from "./conversation-storage";

function WriteAuditLogs() {
  const [data, setData] = useState<{ toolRef: string; entries: DomainWriteAuditEntry[] }>();
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    void api.writeAudit().then((res) => {
      if (active) setData(res);
    }, (err: unknown) => {
      if (active) setError(toolSetupErrorMessage(err));
    });
    return () => { active = false; };
  }, [tick]);

  return (
    <section className="admin-card" aria-labelledby="write-audit-title">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <div>
          <h2 id="write-audit-title" style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <ShieldCheck size={18} aria-hidden="true" />
            Governed sfield Write Audit Log
          </h2>
          <p>
            Every operator-confirmed write-back (IT rollbacks, Sales discount approvals, Customer 360 form updates) executed through{" "}
            <code>{data?.toolRef ?? "cep.domain.execute_write@1.0.0"}</code>.
          </p>
        </div>
        <button className="secondary-button" type="button" onClick={() => setTick((t) => t + 1)}>
          <RotateCw size={15} aria-hidden="true" />Refresh
        </button>
      </div>
      {error && <p className="request-notice" role="alert" style={{ marginTop: "12px" }}>{error}</p>}
      {!data && !error && <p className="workspace-loading" role="status">Loading audit log…</p>}
      {data && data.entries.length === 0 && (
        <p className="admin-muted" style={{ marginTop: "14px" }}>
          No governed write actions recorded yet. Approve a rollback in IT Ops, approve a discount in RevOps, or submit a Customer 360 form to see immutable sfield audit entries here.
        </p>
      )}
      {data && data.entries.length > 0 && (
        <div className="dyn-table-wrap" style={{ marginTop: "14px" }}>
          <table className="dyn-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Domain</th>
                <th>Record</th>
                <th>Action &amp; Summary</th>
                <th>Actor</th>
                <th>sfield Run ID</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((entry) => (
                <tr key={entry.auditId}>
                  <td>{new Date(entry.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td>
                  <td><code>{entry.domain}</code></td>
                  <td><strong>{entry.recordId}</strong></td>
                  <td><code>{entry.action}</code> — {entry.summary}</td>
                  <td>{entry.actor}</td>
                  <td><code>{entry.sfieldRunId}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function EngagementAnalyticsPanel() {
  const [data, setData] = useState<EngagementAnalyticsView>();
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    void api.engagementAnalytics().then((res) => {
      if (active) setData(res);
    }, (err: unknown) => {
      if (active) setError(toolSetupErrorMessage(err));
    });
    return () => { active = false; };
  }, [tick]);

  const totalFeedback = (data?.feedbackHelpful ?? 0) + (data?.feedbackUnhelpful ?? 0);
  const satPct = totalFeedback > 0 ? Math.round(((data?.feedbackHelpful ?? 0) / totalFeedback) * 100) : null;

  return (
    <section className="admin-card" aria-labelledby="engagement-analytics-title">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <div>
          <h2 id="engagement-analytics-title" style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <BarChart3 size={18} aria-hidden="true" />
            Closed-Loop Engagement &amp; Conversion Analytics
          </h2>
          <p>Live platform telemetry aggregating chat turns, rendered surfaces, customer feedback, NBA dismissals, and governed sfield write-backs.</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => setTick((t) => t + 1)}>
          <RotateCw size={15} aria-hidden="true" />Refresh
        </button>
      </div>
      {error && <p className="request-notice" role="alert" style={{ marginTop: "12px" }}>{error}</p>}
      {!data && !error && <p className="workspace-loading" role="status">Loading engagement metrics…</p>}
      {data && (
        <div style={{ display: "grid", gap: "18px", marginTop: "16px" }}>
          <dl className="analytics-kpi-grid">
            <div className="analytics-kpi-tile">
              <dt>Completed Turns</dt>
              <dd><strong>{data.turnsCompleted}</strong><span>of {data.turnsTotal} total</span></dd>
            </div>
            <div className="analytics-kpi-tile">
              <dt>Governed sfield Writes</dt>
              <dd><strong>{data.governedWritesTotal}</strong><span>IT Ops {data.writesByDomain.opsIncident} · RevOps {data.writesByDomain.salesDeal} · C360 {data.writesByDomain.customer360}</span></dd>
            </div>
            <div className="analytics-kpi-tile">
              <dt>Surfaces &amp; Feedback</dt>
              <dd><strong>{data.surfacesRendered} rendered</strong><span>{satPct !== null ? `${satPct}% helpful (${data.feedbackHelpful}/${totalFeedback})` : "No ratings yet"}</span></dd>
            </div>
            <div className="analytics-kpi-tile">
              <dt>NBA Dismissals</dt>
              <dd><strong>{data.nbaDismissals}</strong><span>Honored across sessions</span></dd>
            </div>
          </dl>

          <div>
            <h3 style={{ marginBottom: "8px" }}>Stage 0 Action Gate Distribution</h3>
            <dl className="analytics-kpi-grid">
              <div className="analytics-kpi-tile"><dt>Verified Experience</dt><dd><strong>{data.modeBreakdown.verifiedExperience}</strong></dd></div>
              <div className="analytics-kpi-tile"><dt>Dynamic UI Canvas</dt><dd><strong>{data.modeBreakdown.dynamicUi}</strong></dd></div>
              <div className="analytics-kpi-tile"><dt>Plain Chat</dt><dd><strong>{data.modeBreakdown.plainChat}</strong></dd></div>
              <div className="analytics-kpi-tile"><dt>Clarification</dt><dd><strong>{data.modeBreakdown.clarify}</strong></dd></div>
            </dl>
          </div>

          {data.recentWrites.length > 0 && (
            <div>
              <h3 style={{ marginBottom: "8px" }}>Recent Governed Outcomes</h3>
              <div className="dyn-table-wrap">
                <table className="dyn-table">
                  <thead>
                    <tr><th>Domain</th><th>Record</th><th>Action &amp; Outcome</th><th>Actor</th><th>sfield Run</th></tr>
                  </thead>
                  <tbody>
                    {data.recentWrites.map((w) => (
                      <tr key={w.auditId}>
                        <td><code>{w.domain}</code></td>
                        <td><strong>{w.recordId}</strong></td>
                        <td><code>{w.action}</code> — {w.summary}</td>
                        <td>{w.actor}</td>
                        <td><code>{w.sfieldRunId}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function AdminDiagnostics({ view, selectThread }: { view: "logs" | "inspector"; selectThread: (id: string) => void }) {
  const selectId = useId();
  const [query] = useState(() => new URLSearchParams(location.search));
  const [configuration, setConfiguration] = useState<Bootstrap>();
  const [selectedId, setSelectedId] = useState("");
  const [conversation, setConversation] = useState<ConversationView>();
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const path = adminPaths[view];
  const title = view === "logs" ? "Call logs" : "Developer inspector";
  const pendingActionView = view === "logs" && query.get("source") === pendingActionsContext;
  const writeAuditView = view === "logs" && query.get("source") === "write_audit";
  const analyticsView = view === "logs" && query.get("source") === "analytics";

  useEffect(() => {
    let active = true;
    void api.adminBootstrap().then((data) => {
      if (!active) return;
      const ids = [query.get("thread"), readActiveConversation(), readActiveConversation(true)];
      const preferred = ids.find((id) => data.conversations.some((item) => item.id === id));
      const id = preferred ?? data.conversations[0]?.id ?? "";
      setSelectedId(id);
      selectThread(id);
      setConfiguration(data);
    }, (error: unknown) => { if (active) setNotice(toolSetupErrorMessage(error)); });
    return () => { active = false; };
  }, [query, selectThread]);

  useEffect(() => {
    if (!selectedId || pendingActionView || writeAuditView || analyticsView) return;
    let active = true;
    void api.conversation(selectedId).then((row) => {
      if (active) setConversation(row);
    }, (error: unknown) => { if (active) setNotice(toolSetupErrorMessage(error)); });
    return () => { active = false; };
  }, [selectedId, refresh, pendingActionView, writeAuditView, analyticsView]);

  const loaded = conversation?.id === selectedId ? conversation : undefined;
  const requestedTurn = loaded?.id === query.get("thread") ? query.get("turn") ?? undefined : undefined;
  const pendingQuery = new URLSearchParams({ source: pendingActionsContext });
  const writeAuditQuery = new URLSearchParams({ source: "write_audit" });
  const analyticsQuery = new URLSearchParams({ source: "analytics" });
  if (selectedId) {
    pendingQuery.set("thread", selectedId);
    writeAuditQuery.set("thread", selectedId);
    analyticsQuery.set("thread", selectedId);
  }
  const isChatCallsView = !pendingActionView && !writeAuditView && !analyticsView;
  return <main className="admin-main admin-diagnostics" aria-labelledby="diagnostics-title">
    <header className="admin-heading"><h1 id="diagnostics-title">{title}</h1></header>
    {view === "logs" && <nav className="log-sources" aria-label="Log sources">
      <a className="rail-link" aria-current={isChatCallsView ? "page" : undefined}
        href={diagnosticHref(adminPaths.logs, selectedId, requestedTurn)}>Chat calls</a>
      <a className="rail-link" aria-current={pendingActionView ? "page" : undefined}
        href={adminPaths.logs + "?" + pendingQuery}>Pending actions</a>
      <a className="rail-link" aria-current={writeAuditView ? "page" : undefined}
        href={adminPaths.logs + "?" + writeAuditQuery}>Write audit (sfield)</a>
      <a className="rail-link" aria-current={analyticsView ? "page" : undefined}
        href={adminPaths.logs + "?" + analyticsQuery}>Engagement analytics</a>
    </nav>}
    {pendingActionView ? <PendingActionLogs profiles={configuration?.personas ?? []} />
      : writeAuditView ? <WriteAuditLogs />
      : analyticsView ? <EngagementAnalyticsPanel />
      : <section className="admin-card diagnostics-picker">
      <label htmlFor={selectId}>Conversation</label>
      <div>
        <select id={selectId} value={selectedId} disabled={!configuration?.conversations.length} onChange={(event) => {
          const id = event.target.value;
          setNotice("");
          setSelectedId(id);
          selectThread(id);
          history.replaceState(history.state, "", diagnosticHref(path, id));
        }}>
          {!configuration?.conversations.length && <option value="">No conversations</option>}
          {configuration?.conversations.map(({ id, title: name, personaId, audience, archivedAt }) => (
            <option key={id} value={id}>
              {name} · {configuration.personas.find((profile) => profile.personaId === personaId)?.displayName ?? personaId}
              {audience === "admin" ? " · Test chat" : ""}{archivedAt !== undefined ? " · Archived" : ""}
            </option>
          ))}
        </select>
        <button className="secondary-button" type="button" disabled={!selectedId} onClick={() => { setNotice(""); setRefresh(refresh + 1); }}>
          <RotateCw size={15} aria-hidden="true" />Refresh
        </button>
      </div>
    </section>}
    {notice && <p className="request-notice" role="alert">{notice}</p>}
    {isChatCallsView && selectedId && !loaded && !notice && <p className="workspace-loading" role="status">Loading conversation…</p>}
    {view === "logs" && isChatCallsView && (!selectedId || loaded) && <CallLogs key={loaded?.id} turns={loaded?.turns ?? []} turnId={requestedTurn} />}
    {view === "inspector" && configuration && (!selectedId || loaded) && <Inspector key={loaded?.id} configuration={configuration}
      conversation={loaded} turnId={requestedTurn} create={async (personaId, scenarioId) => {
        setNotice("");
        try {
          const row = await api.newAdminConversation(personaId, scenarioId);
          rememberActiveConversation(row.id, true);
          location.assign(adminPaths.chat);
          return true;
        } catch (error) {
          setNotice(toolSetupErrorMessage(error));
          return false;
        }
      }} />}
  </main>;
}
