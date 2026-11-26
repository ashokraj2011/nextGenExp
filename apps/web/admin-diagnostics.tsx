import { useEffect, useId, useState } from "react";
import { BarChart3, CheckCircle2, Clock, RotateCw, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
import { adminPaths } from "../../packages/contracts/admin-paths";
import type { Bootstrap, ConversationView, DomainWriteAuditEntry, EngagementAnalyticsView } from "../../packages/contracts/api";
import type { ApprovalPolicySettings, ApprovalsView } from "../../packages/contracts/approval";
import { pendingActionsContext } from "../../packages/contracts/workspace";
import { api, toolSetupErrorMessage } from "./api";
import { diagnosticHref } from "./admin-navigation";
import { CallLogs, PendingActionLogs } from "./call-logs";
import { EvalRunnerPanel } from "./eval-runner-panel";
import { PiiFirewallPanel } from "./pii-firewall-panel";
import { UxEvolutionPanel } from "./ux-evolution-panel";
import { Inspector } from "./inspector";
import { readActiveConversation, rememberActiveConversation } from "./conversation-storage";

function ApprovalQueuePanel() {
  const [data, setData] = useState<ApprovalsView>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actorById, setActorById] = useState<Record<string, string>>({});
  const [commentById, setCommentById] = useState<Record<string, string>>({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    void api.approvals().then((res) => {
      if (active) setData(res);
    }, (err: unknown) => {
      if (active) setError(toolSetupErrorMessage(err));
    });
    return () => { active = false; };
  }, [tick]);

  async function togglePolicy(patch: Partial<ApprovalPolicySettings>) {
    setError("");
    setNotice("");
    try {
      const res = await api.saveApprovalPolicy(patch);
      setData(res.view);
      setNotice("Approval policy updated.");
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    }
  }

  async function decide(id: string, decision: "approve" | "deny", defaultActor: string) {
    setBusyId(id);
    setError("");
    setNotice("");
    try {
      const actor = (actorById[id] ?? defaultActor).trim() || "Duty Approver";
      const comment = (commentById[id] ?? "").trim();
      const res = await api.decideApproval(id, {
        decision,
        actor,
        ...(comment ? { comment } : {}),
      });
      setData(res.view);
      setNotice(
        decision === "approve"
          ? `Approved & executed ${id} via sfield (${res.approval.executionResult?.sfieldRunId ?? "ok"}).`
          : `Denied approval ${id}.`,
      );
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="admin-card" aria-labelledby="hitl-approvals-title">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <div>
          <h2 id="hitl-approvals-title" style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <ShieldAlert size={18} aria-hidden="true" />
            Human-in-the-Loop Approval Queue (sfield)
          </h2>
          <p>
            High-risk domain writes (<code>cep.domain.execute_write@1.0.0</code>) and external connectors (<code>cep.connector.invoke@1.0.0</code>) pause here and in Chat (type <em>"show pending approvals"</em>) until a human verifies the SHA-256 payload digest.
          </p>
        </div>
        <button className="secondary-button" type="button" onClick={() => setTick((t) => t + 1)}>
          <RotateCw size={15} aria-hidden="true" />Refresh
        </button>
      </div>

      {data && (
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", marginTop: "14px", padding: "12px 14px", border: "1px solid var(--line)", borderRadius: "10px" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "0.85rem", fontWeight: 550 }}>
            <input
              type="checkbox"
              checked={data.policy.defaultDualControl}
              onChange={(e) => void togglePolicy({ defaultDualControl: e.target.checked })}
            />
            Require separate approver (4-eyes dual control)
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "0.85rem" }}>
            <input
              type="checkbox"
              checked={data.policy.gateExternalConnectorWrites}
              onChange={(e) => void togglePolicy({ gateExternalConnectorWrites: e.target.checked })}
            />
            Gate external connector writes
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "0.85rem" }}>
            <input
              type="checkbox"
              checked={data.policy.gateHighRiskOpsRollbacks}
              onChange={(e) => void togglePolicy({ gateHighRiskOpsRollbacks: e.target.checked })}
            />
            Gate P1 Ops rollbacks
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "0.85rem" }}>
            <input
              type="checkbox"
              checked={data.policy.gateHighRiskSalesDiscounts}
              onChange={(e) => void togglePolicy({ gateHighRiskSalesDiscounts: e.target.checked })}
            />
            Gate Deal Desk discounts (&gt;15%)
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "0.85rem" }}>
            <input
              type="checkbox"
              checked={data.policy.gateHighRiskTrades}
              onChange={(e) => void togglePolicy({ gateHighRiskTrades: e.target.checked })}
            />
            Gate high-value stock trades (&gt;${data.policy.highRiskTradeThresholdUsd.toLocaleString("en-US")})
          </label>
        </div>
      )}

      {notice && <p role="status" style={{ marginTop: "12px", color: "var(--teal-dark)", fontWeight: 600 }}>{notice}</p>}
      {error && <p className="request-notice" role="alert" style={{ marginTop: "12px" }}>{error}</p>}
      {!data && !error && <p className="workspace-loading" role="status">Loading approval queue…</p>}

      {data && data.approvals.length === 0 && (
        <p className="admin-muted" style={{ marginTop: "14px" }}>
          No approvals queued yet. Click <strong>Invoke via sfield</strong> on a connector in <a href={adminPaths.tools}>Tool setup</a> or ask Chat to <em>"invoke PagerDuty connector"</em> to see live HITL approval gating.
        </p>
      )}

      {data && data.approvals.length > 0 && (
        <div style={{ display: "grid", gap: "12px", marginTop: "14px" }}>
          {data.approvals.map((apr) => {
            const defaultActor = apr.dualControl ? "Duty Approver" : "CEP Admin";
            const actorVal = actorById[apr.id] ?? defaultActor;
            const commentVal = commentById[apr.id] ?? "";
            const isPending = apr.status === "pending";
            return (
              <article key={apr.id} className={"dyn-approval is-" + (apr.status === "executed" || apr.status === "approved" ? "approved" : apr.status === "denied" ? "rejected" : "pending")}>
                <div className="dyn-approval-head">
                  <div>
                    <h4>{apr.title}</h4>
                    <span className="dyn-approval-req">
                      Requested by {apr.requester} · {new Date(apr.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "4px", fontSize: "0.75rem", opacity: 0.85 }}>
                      <code>{apr.id}</code>
                      <code>{apr.sfieldToolRef}</code>
                      <code>sha256:{apr.payloadDigest.slice(0, 12)}</code>
                      {apr.dualControl && <strong>4-eyes required</strong>}
                    </div>
                  </div>
                  <span className={"dyn-risk-pill risk-" + apr.riskLevel}>
                    {apr.status} · {apr.riskLevel} risk
                  </span>
                </div>
                <p className="dyn-approval-summary">{apr.summary}</p>
                <dl className="dyn-approval-details">
                  {apr.details.map((d) => (
                    <div key={d.label}><dt>{d.label}</dt><dd>{d.value}</dd></div>
                  ))}
                </dl>
                {isPending ? (
                  <div style={{ display: "grid", gap: "10px" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.4fr)", gap: "8px" }}>
                      <label className="dyn-form-field">
                        <span>Approver</span>
                        <input value={actorVal} onChange={(e) => setActorById((p) => ({ ...p, [apr.id]: e.target.value }))} />
                      </label>
                      <label className="dyn-form-field">
                        <span>Comment (optional)</span>
                        <input value={commentVal} onChange={(e) => setCommentById((p) => ({ ...p, [apr.id]: e.target.value }))} placeholder="Approval note or change ticket" />
                      </label>
                    </div>
                    <div className="dyn-approval-actions">
                      <button type="button" className="send-button" disabled={busyId === apr.id} onClick={() => void decide(apr.id, "approve", defaultActor)}>
                        <CheckCircle2 size={14} aria-hidden="true" />{busyId === apr.id ? "Executing…" : "Approve & Execute"}
                      </button>
                      <button type="button" className="secondary-button" disabled={busyId === apr.id} onClick={() => void decide(apr.id, "deny", defaultActor)}>
                        <XCircle size={14} aria-hidden="true" />Deny
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="dyn-approval-result" role="status">
                    {apr.status === "executed" || apr.status === "approved" ? (
                      <>
                        <CheckCircle2 size={15} aria-hidden="true" />
                        <span>
                          <strong>Executed</strong> by {apr.decidedBy ?? "Approver"}
                          {apr.executionResult ? ` — ${apr.executionResult.summary} (run ${apr.executionResult.sfieldRunId}${apr.executionResult.auditId ? `, audit ${apr.executionResult.auditId}` : ""})` : ""}
                        </span>
                      </>
                    ) : (
                      <>
                        <Clock size={15} aria-hidden="true" />
                        <span><strong>{apr.status}</strong>{apr.decidedBy ? ` by ${apr.decidedBy}` : ""}{apr.comment ? ` — ${apr.comment}` : ""}</span>
                      </>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

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
            Every operator-confirmed write-back (IT rollbacks, Sales discount approvals, Customer 360 updates, and External Connector actions) executed through{" "}
            <code>{data?.toolRef ?? "cep.domain.execute_write@1.0.0"}</code> and <code>cep.connector.invoke@1.0.0</code>.
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
          No governed write actions recorded yet. Approve a rollback in IT Ops, approve a discount in RevOps, invoke an external connector, or submit a Customer 360 form to see immutable sfield audit entries here.
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
                <th>Approval / sfield Run</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((entry) => (
                <tr key={entry.auditId}>
                  <td>{new Date(entry.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td>
                  <td><code>{entry.domain}</code></td>
                  <td><strong>{entry.recordId}</strong></td>
                  <td><code>{entry.action}</code> ({entry.status}) — {entry.summary}</td>
                  <td>{entry.actor}</td>
                  <td>
                    {entry.approvalId && <><code>{entry.approvalId}</code><br /></>}
                    <code>{entry.sfieldRunId}</code>
                  </td>
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
          <p>Live platform telemetry aggregating chat turns, rendered surfaces, customer feedback, NBA dismissals, HITL approvals, and governed sfield write-backs.</p>
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
              <dd>
                <strong>{data.governedWritesTotal}</strong>
                <span>
                  Ops {data.writesByDomain.opsIncident} · RevOps {data.writesByDomain.salesDeal} · C360 {data.writesByDomain.customer360} · Ext {data.writesByDomain.externalConnector}
                </span>
              </dd>
            </div>
            <div className="analytics-kpi-tile">
              <dt>Surfaces &amp; Feedback</dt>
              <dd><strong>{data.surfacesRendered} rendered</strong><span>{satPct !== null ? `${satPct}% helpful (${data.feedbackHelpful}/${totalFeedback})` : "No ratings yet"}</span></dd>
            </div>
            <div className="analytics-kpi-tile">
              <dt>NBA Dismissals &amp; HITL</dt>
              <dd><strong>{data.nbaDismissals} dismissed</strong><span>{data.pendingApprovalsCount ?? 0} approvals pending</span></dd>
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
  const approvalsView = view === "logs" && query.get("source") === "approvals";
  const writeAuditView = view === "logs" && query.get("source") === "write_audit";
  const analyticsView = view === "logs" && query.get("source") === "analytics";
  const evalsView = view === "logs" && query.get("source") === "evals";
  const piiView = view === "logs" && query.get("source") === "pii";
  const uxEvolutionView = view === "logs" && query.get("source") === "ux-evolution";

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
    if (!selectedId || pendingActionView || approvalsView || writeAuditView || analyticsView || evalsView || piiView || uxEvolutionView) return;
    let active = true;
    void api.conversation(selectedId).then((row) => {
      if (active) setConversation(row);
    }, (error: unknown) => { if (active) setNotice(toolSetupErrorMessage(error)); });
    return () => { active = false; };
  }, [selectedId, refresh, pendingActionView, approvalsView, writeAuditView, analyticsView, evalsView, piiView, uxEvolutionView]);

  const loaded = conversation?.id === selectedId ? conversation : undefined;
  const requestedTurn = loaded?.id === query.get("thread") ? query.get("turn") ?? undefined : undefined;
  const pendingQuery = new URLSearchParams({ source: pendingActionsContext });
  const approvalsQuery = new URLSearchParams({ source: "approvals" });
  const writeAuditQuery = new URLSearchParams({ source: "write_audit" });
  const analyticsQuery = new URLSearchParams({ source: "analytics" });
  const evalsQuery = new URLSearchParams({ source: "evals" });
  const piiQuery = new URLSearchParams({ source: "pii" });
  const uxEvolutionQuery = new URLSearchParams({ source: "ux-evolution" });
  if (selectedId) {
    pendingQuery.set("thread", selectedId);
    approvalsQuery.set("thread", selectedId);
    writeAuditQuery.set("thread", selectedId);
    analyticsQuery.set("thread", selectedId);
    evalsQuery.set("thread", selectedId);
    piiQuery.set("thread", selectedId);
    uxEvolutionQuery.set("thread", selectedId);
  }
  const isChatCallsView = !pendingActionView && !approvalsView && !writeAuditView && !analyticsView && !evalsView && !piiView && !uxEvolutionView;
  return <main className="admin-main admin-diagnostics" aria-labelledby="diagnostics-title">
    <header className="admin-heading"><h1 id="diagnostics-title">{title}</h1></header>
    {view === "logs" && <nav className="log-sources" aria-label="Log sources">
      <a className="rail-link" aria-current={isChatCallsView ? "page" : undefined}
        href={diagnosticHref(adminPaths.logs, selectedId, requestedTurn)}>Chat calls</a>
      <a className="rail-link" aria-current={pendingActionView ? "page" : undefined}
        href={adminPaths.logs + "?" + pendingQuery}>Pending actions</a>
      <a className="rail-link" aria-current={approvalsView ? "page" : undefined}
        href={adminPaths.logs + "?" + approvalsQuery}>Approvals (HITL)</a>
      <a className="rail-link" aria-current={writeAuditView ? "page" : undefined}
        href={adminPaths.logs + "?" + writeAuditQuery}>Write audit (sfield)</a>
      <a className="rail-link" aria-current={analyticsView ? "page" : undefined}
        href={adminPaths.logs + "?" + analyticsQuery}>Engagement analytics</a>
      <a className="rail-link" aria-current={evalsView ? "page" : undefined}
        href={adminPaths.logs + "?" + evalsQuery}>Guardrail Evals &amp; Audit</a>
      <a className="rail-link" aria-current={piiView ? "page" : undefined}
        href={adminPaths.logs + "?" + piiQuery}>PII Firewall &amp; X-Ray</a>
      <a className="rail-link" aria-current={uxEvolutionView ? "page" : undefined}
        href={adminPaths.logs + "?" + uxEvolutionQuery}>Self-Evolving UX</a>
    </nav>}
    {pendingActionView ? <PendingActionLogs profiles={configuration?.personas ?? []} />
      : approvalsView ? <ApprovalQueuePanel />
      : writeAuditView ? <WriteAuditLogs />
      : analyticsView ? <EngagementAnalyticsPanel />
      : evalsView ? <EvalRunnerPanel />
      : piiView ? <PiiFirewallPanel />
      : uxEvolutionView ? <UxEvolutionPanel />
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
              {audience === "admin" ? " · Admin chat" : ""}{archivedAt !== undefined ? " · Archived" : ""}
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
