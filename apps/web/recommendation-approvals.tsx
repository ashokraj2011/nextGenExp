import { useEffect, useState } from "react";
import { CheckCircle2, Clock, Play, ShieldCheck, ShieldAlert, XCircle } from "lucide-react";
import type { ApprovalPolicySettings, ApprovalRecord, ApprovalsView, PznDualControlMode } from "../../packages/contracts/approval";
import type { PznStudioWorkspaceState } from "../../packages/contracts/self-service-pzn";
import { api, toolSetupErrorMessage } from "./api";

const operationNames: Record<string, string> = {
  publish_context: "Publish",
  unpublish_context: "Unpublish",
  delete_rule: "Delete rule",
  delete_content: "Delete content",
  delete_context: "Delete context",
  delete_namespace: "Delete namespace",
  delete_attribute: "Delete attribute",
  upsert_namespace: "Dictionary namespace change",
  upsert_attribute: "Dictionary attribute change",
};

function minutesLeft(expiresAt: string) {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000));
}

/* ============================================================================
 * APPROVAL REQUEST CARD — rendered inline in chat and in the approval queue
 * ========================================================================== */
export function ApprovalRequestCard({
  approval: initial,
  onWorkspaceChange,
  onRunPrompt,
  onDecided,
}: {
  approval: ApprovalRecord;
  onWorkspaceChange?: (ws: PznStudioWorkspaceState) => void;
  onRunPrompt?: (prompt: string) => void;
  onDecided?: (record: ApprovalRecord) => void;
}) {
  const [record, setRecord] = useState(initial);
  const [approver, setApprover] = useState(initial.dualControl ? "Recommendation Approver" : initial.requester);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  useEffect(() => {
    // Refresh status so a card rendered earlier in the thread reflects decisions made elsewhere (queue, Slack, Logs).
    let alive = true;
    void api.approvals().then((view) => {
      const fresh = view.approvals.find((a) => a.id === initial.id);
      if (alive && fresh) setRecord(fresh);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [initial.id]);

  async function decide(decision: "approve" | "deny") {
    setBusy(true);
    setError("");
    try {
      const res = await api.decideApproval(record.id, { decision, actor: approver.trim() || "Recommendation Approver", ...(comment.trim() ? { comment: comment.trim() } : {}) });
      setRecord(res.approval);
      setResult(res.execution?.summary ?? (decision === "deny" ? "Change denied. Nothing was applied." : "Approved."));
      onDecided?.(res.approval);
      if (onWorkspaceChange) onWorkspaceChange(await api.pznWorkspace());
    } catch (e) {
      setError(toolSetupErrorMessage(e));
      void api.approvals().then((view) => {
        const fresh = view.approvals.find((a) => a.id === record.id);
        if (fresh) setRecord(fresh);
      }).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const statusClass = record.status === "executed" || record.status === "approved"
    ? "is-pass"
    : record.status === "pending" ? "is-warn" : "is-fail";
  const contextId = typeof record.payload.args === "object" && record.payload.args !== null
    ? (record.payload.args as Record<string, unknown>).contextId
    : undefined;

  return (
    <section className={"content-card pzn-widget-card pzn-approval-card is-" + record.status} aria-label="Approval request">
      <div className="pzn-widget-head">
        <div>
          <span className="pzn-stage-kicker">
            {record.status === "pending" ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />} APPROVAL REQUEST · {record.sfieldToolRef}
          </span>
          <h3>{record.title}</h3>
        </div>
        <div className="pzn-btn-row">
          <span className={"pzn-badge " + statusClass}>{record.status.toUpperCase()}</span>
          <span className={"pzn-badge " + (record.riskLevel === "high" ? "is-fail" : record.riskLevel === "medium" ? "is-warn" : "")}>
            {record.riskLevel} risk
          </span>
          <span className="pzn-badge">{record.dualControl ? "4-eyes: second approver" : "Self-approval allowed"}</span>
        </div>
      </div>

      <p className="pzn-subtitle" style={{ fontSize: "0.85rem", color: "var(--text)" }}>{record.summary}</p>

      <div className="pzn-attr-kv-grid">
        {record.details.map((d) => (
          <div key={d.label} className="pzn-attr-kv">
            <span>{d.label}</span>
            <strong>{d.value}</strong>
          </div>
        ))}
      </div>

      <div className="pzn-list-meta" style={{ fontSize: "0.74rem" }}>
        <span>Requested by <strong>{record.requester}</strong></span>
        <span>Payload digest <code className="pzn-code">{record.payloadDigest.slice(0, 12)}</code></span>
        {record.status === "pending" && <span><Clock size={11} /> Expires in {minutesLeft(record.expiresAt)} min</span>}
        {record.decidedBy && <span>Decided by <strong>{record.decidedBy}</strong></span>}
      </div>

      {error && <p className="pzn-error" role="alert">{error}</p>}

      {record.status === "pending" ? (
        <div className="pzn-form-grid">
          <div className="pzn-field">
            <label>Approver name</label>
            <input aria-label="Approver name" value={approver} onChange={(e) => setApprover(e.target.value)} />
          </div>
          <div className="pzn-field">
            <label>Comment (optional)</label>
            <input aria-label="Approval comment" value={comment} placeholder="Reason or note…" onChange={(e) => setComment(e.target.value)} />
          </div>
          <div className="pzn-btn-row is-full" style={{ gridColumn: "1 / -1" }}>
            <button type="button" className="pzn-btn pzn-btn-primary pzn-btn-sm" disabled={busy} onClick={() => void decide("approve")}>
              <CheckCircle2 size={13} /> {busy ? "Applying…" : `Approve & ${operationNames[record.action] ?? "apply"}`}
            </button>
            <button type="button" className="pzn-btn pzn-btn-sm pzn-btn-danger" disabled={busy} onClick={() => void decide("deny")}>
              <XCircle size={13} /> Deny
            </button>
            {record.dualControl && (
              <span className="pzn-subtitle" style={{ fontSize: "0.75rem" }}>
                Approver must differ from “{record.requester}”.
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="pzn-btn-row">
          {(result || record.executionResult?.summary) && (
            <span className={"pzn-badge " + statusClass}>{result || record.executionResult?.summary}</span>
          )}
          {record.executionResult?.sfieldRunId && <span className="pzn-badge">sfield run {record.executionResult.sfieldRunId.slice(0, 18)}</span>}
          {record.status === "executed" && typeof contextId === "string" && onRunPrompt && (
            <button type="button" className="pzn-btn pzn-btn-sm" onClick={() => onRunPrompt(`Test ${contextId} for Alice Morgan and Jordan Lee`)}>
              <Play size={12} /> Run Live TS
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/* ============================================================================
 * APPROVAL QUEUE + CONFIGURABLE POLICY WIDGET
 * ========================================================================== */
export function ApprovalQueueWidget({
  onWorkspaceChange,
  onRunPrompt,
}: {
  onWorkspaceChange?: (ws: PznStudioWorkspaceState) => void;
  onRunPrompt?: (prompt: string) => void;
}) {
  const [view, setView] = useState<ApprovalsView | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = () => api.approvals().then(setView, (e) => setError(toolSetupErrorMessage(e)));
  useEffect(() => { void load(); }, []);

  async function savePolicy(patch: Partial<ApprovalPolicySettings>) {
    setSaving(true);
    setError("");
    try {
      const res = await api.saveApprovalPolicy(patch);
      setView(res.view);
      setNotice("Approval policy saved. New requests use the updated settings.");
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (!view) {
    return (
      <section className="content-card pzn-widget-card" aria-label="Approval queue">
        {error ? <p className="pzn-error">{error}</p> : <p className="pzn-subtitle">Loading approval queue…</p>}
      </section>
    );
  }

  const policy = view.policy;
  const pznApprovals = view.approvals.filter((a) => a.domain === "pzn_self_service");
  const pending = pznApprovals.filter((a) => a.status === "pending");
  const recent = pznApprovals.filter((a) => a.status !== "pending").slice(0, 5);

  return (
    <section className="content-card pzn-widget-card" aria-label="Approval queue">
      <div className="pzn-widget-head">
        <div>
          <span className="pzn-stage-kicker"><ShieldCheck size={13} /> APPROVALS · RECOMMENDATION CHANGES</span>
          <h3>Approval Policy &amp; Queue ({pending.length} pending)</h3>
        </div>
        <button type="button" className="pzn-btn pzn-btn-sm" onClick={() => void load()}>Refresh</button>
      </div>

      {notice && <p className="pzn-notice" role="status">{notice}</p>}
      {error && <p className="pzn-error" role="alert">{error}</p>}

      <div className="pzn-attachment-card" aria-label="Approval policy">
        <span className="pzn-stage-kicker">Configurable policy</span>
        <div className="pzn-rule-chips">
          {([
            ["gatePznPublish", "Require approval to publish a context"],
            ["gatePznDestructive", "Require approval to unpublish / delete"],
            ["gatePznDictionaryChanges", "Require approval for Data Dictionary edits"],
          ] as const).map(([key, label]) => (
            <label key={key} className={"pzn-rule-chip" + (policy[key] ? " is-checked" : "")} style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={policy[key]}
                disabled={saving}
                onChange={(e) => void savePolicy({ [key]: e.target.checked })}
                style={{ marginRight: 4 }}
              />
              {label}
            </label>
          ))}
        </div>
        <div className="pzn-form-grid">
          <div className="pzn-field">
            <label htmlFor="pzn-dual-control">Second approver (4-eyes)</label>
            <select
              id="pzn-dual-control"
              value={policy.pznDualControl}
              disabled={saving}
              onChange={(e) => void savePolicy({ pznDualControl: e.target.value as PznDualControlMode })}
            >
              <option value="off">Never — requester can self-approve</option>
              <option value="high_risk">High-risk only (unpublish &amp; delete)</option>
              <option value="always">Always — every gated change</option>
            </select>
          </div>
          <div className="pzn-field">
            <label htmlFor="pzn-approval-expiry">Request expiry (minutes)</label>
            <input
              id="pzn-approval-expiry"
              type="number"
              min={5}
              max={1440}
              defaultValue={policy.pznApprovalExpiryMinutes}
              disabled={saving}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 5 && n <= 1440 && n !== policy.pznApprovalExpiryMinutes) void savePolicy({ pznApprovalExpiryMinutes: Math.round(n) });
              }}
            />
          </div>
        </div>
        <p className="pzn-subtitle" style={{ fontSize: "0.76rem" }}>
          Drafts, rule tests, and Treatment Selector runs never need approval. Gated changes are enforced inside the sfield tools, so they can’t be bypassed through the API.
        </p>
      </div>

      {pending.length === 0 ? (
        <p className="pzn-subtitle">No pending recommendation changes.</p>
      ) : (
        <div className="pzn-list">
          {pending.map((a) => (
            <ApprovalRequestCard
              key={a.id}
              approval={a}
              onWorkspaceChange={onWorkspaceChange}
              onRunPrompt={onRunPrompt}
              onDecided={() => void load()}
            />
          ))}
        </div>
      )}

      {recent.length > 0 && (
        <div className="pzn-list">
          <span className="pzn-stage-kicker">Recent decisions</span>
          {recent.map((a) => (
            <div key={a.id} className="pzn-attr-card">
              <div className="pzn-attr-head">
                <strong style={{ fontSize: "0.84rem" }}>{a.title}</strong>
                <span className={"pzn-badge " + (a.status === "executed" || a.status === "approved" ? "is-pass" : "is-fail")}>{a.status}</span>
              </div>
              <span className="pzn-subtitle" style={{ fontSize: "0.76rem" }}>
                {a.decidedBy ? `by ${a.decidedBy}` : ""}{a.executionResult?.summary ? ` · ${a.executionResult.summary}` : ""}{a.comment ? ` · “${a.comment}”` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
