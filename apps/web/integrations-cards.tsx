import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Copy, FileCode2, ListChecks, Play, Plug, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import type { ApprovalRecord } from "../../packages/contracts/approval";
import type { FieldProvenance, IntegrationTasksView, TaskContract, TaskRun } from "../../packages/contracts/integration-task";
import { api, toolSetupErrorMessage } from "./api";
import { ApprovalRequestCard } from "./recommendation-approvals";

type Contract = TaskContract & { sfieldRegistered: boolean };
type SchemaProp = { type?: string | string[]; enum?: (string | number)[]; maxLength?: number; minLength?: number; minimum?: number; maximum?: number; description?: string };

const STATE_INFO: Record<TaskRun["state"], { label: string; tone: "pass" | "warn" | "fail"; hint: string }> = {
  succeeded: { label: "Succeeded", tone: "pass", hint: "The integration confirmed the result and it matched the contract." },
  succeeded_unverified_output: { label: "Applied · output unverified", tone: "warn", hint: "The change went through, but the response didn't match the contract. It will not be retried." },
  outcome_unknown: { label: "Outcome unknown", tone: "warn", hint: "No reliable response. The change may or may not have been applied. Reconcile before retrying." },
  pending_approval: { label: "Waiting for approval", tone: "warn", hint: "sfield is holding this exact call until it is approved." },
  executing: { label: "Running", tone: "warn", hint: "In progress." },
  failed: { label: "Failed", tone: "fail", hint: "Nothing was applied, or the system rejected it." },
  denied: { label: "Denied", tone: "fail", hint: "An approver denied it. Nothing was sent." },
  expired: { label: "Expired", tone: "fail", hint: "The approval window passed or the pending call was lost. Request it again." },
};

const toneClass = (tone: "pass" | "warn" | "fail") => (tone === "pass" ? "is-pass" : tone === "warn" ? "is-warn" : "is-fail");

function latest(view: IntegrationTasksView): Contract[] {
  const map = new Map<string, Contract>();
  for (const c of view.contracts.filter((x) => x.status === "published")) {
    const key = `${c.integrationId}.${c.taskId}`;
    const prev = map.get(key);
    if (!prev || (c.sfieldRegistered && !prev.sfieldRegistered) || (c.sfieldRegistered === prev.sfieldRegistered && c.version.localeCompare(prev.version, undefined, { numeric: true }) > 0)) map.set(key, c);
  }
  return [...map.values()];
}

function approvalLabel(c: TaskContract) {
  if (c.effect === "destructive") return "Approval: always (destructive)";
  if (c.approvalPolicy.mode === "none") return "No approval";
  if (c.approvalPolicy.mode === "always") return "Approval: always";
  return `Approval: when ${c.approvalPolicy.when.map((w) => `${w.field} ${w.op} ${Array.isArray(w.value) ? w.value.join("/") : String(w.value)}`).join(" or ")}`;
}

/* ============================================================================ CATALOG */
export function CatalogCard({ view, onPrompt }: { view: IntegrationTasksView; onPrompt: (p: string) => void }) {
  const tasks = latest(view);
  return (
    <section className="content-card pzn-widget-card" aria-label="Integration catalog">
      <div className="pzn-widget-head">
        <div>
          <span className="pzn-stage-kicker"><Plug size={13} /> INTEGRATIONS &amp; TASKS</span>
          <h3>{view.integrations.length} integration(s) · {tasks.length} task(s)</h3>
        </div>
      </div>
      {view.integrations.map((integration) => (
        <div key={integration.id} className="pzn-attachment-card">
          <div className="pzn-attr-head">
            <div className="pzn-btn-row"><strong>{integration.name}</strong><span className="pzn-code">{integration.id}</span></div>
            <span className="pzn-badge">{integration.transport}{integration.enabled ? "" : " · disabled"}</span>
          </div>
          <p className="pzn-subtitle" style={{ fontSize: "0.8rem" }}>{integration.description}</p>
          <div className="pzn-list">
            {tasks.filter((t) => t.integrationId === integration.id).map((t) => (
              <div key={t.ref} className="pzn-attr-card">
                <div className="pzn-attr-head">
                  <div className="pzn-btn-row">
                    <strong>{t.taskId}</strong>
                    <span className="pzn-badge">v{t.version}</span>
                    <span className={"pzn-badge " + (t.effect === "read" ? "" : t.effect === "write" ? "is-warn" : "is-fail")}>{t.effect}</span>
                    {t.resultKind !== "data" && <span className="pzn-badge">returns {t.artifact?.type ?? t.resultKind}</span>}
                    <span className={"pzn-badge " + (t.sfieldRegistered ? "is-pass" : "is-warn")}>{t.sfieldRegistered ? "sfield tool" : "restart to activate"}</span>
                  </div>
                  <div className="pzn-btn-row">
                    <button type="button" className="pzn-btn pzn-btn-sm pzn-btn-primary" disabled={!t.sfieldRegistered} onClick={() => onPrompt(`Run ${t.ref}`)}>
                      <Play size={12} /> Run
                    </button>
                    <button type="button" className="pzn-btn pzn-btn-sm" onClick={() => onPrompt(`Show the contract for ${t.ref}`)}>Contract</button>
                  </div>
                </div>
                <p className="pzn-subtitle" style={{ fontSize: "0.8rem" }}>{t.description}</p>
                <span className="pzn-subtitle" style={{ fontSize: "0.74rem" }}>{approvalLabel(t)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

/* ============================================================================ CONTRACT */
export function ContractCard({ contract, onPrompt }: { contract: Contract; onPrompt: (p: string) => void }) {
  const props = ((contract.inputSchema as { properties?: Record<string, SchemaProp> }).properties) ?? {};
  const required = new Set((contract.inputSchema as { required?: string[] }).required ?? []);
  const outProps = ((contract.outputSchema as { properties?: Record<string, SchemaProp> }).properties) ?? {};
  return (
    <section className="content-card pzn-widget-card" aria-label="Task contract">
      <div className="pzn-widget-head">
        <div>
          <span className="pzn-stage-kicker"><FileCode2 size={13} /> TASK CONTRACT</span>
          <h3>{contract.ref}</h3>
        </div>
        <div className="pzn-btn-row">
          <span className={"pzn-badge " + (contract.status === "published" ? "is-pass" : "is-warn")}>{contract.status}</span>
          <span className="pzn-badge">{contract.effect}</span>
        </div>
      </div>
      <p className="pzn-subtitle" style={{ fontSize: "0.84rem", color: "var(--text)" }}>{contract.description}</p>
      <div className="pzn-pipeline-grid">
        <div className="pzn-list">
          <span className="pzn-stage-kicker">Input</span>
          {Object.entries(props).map(([name, p]) => (
            <div key={name} className="pzn-biz-def">
              <strong>{name}</strong>{required.has(name) ? " *" : ""} · {Array.isArray(p.type) ? p.type.join("|") : p.type}
              {p.enum ? ` · one of ${p.enum.join(", ")}` : ""}{contract.idempotency.keyField === name ? " · idempotency key (auto-filled)" : ""}
            </div>
          ))}
        </div>
        <div className="pzn-list">
          <span className="pzn-stage-kicker">Output</span>
          {Object.entries(outProps).map(([name, p]) => (
            <div key={name} className="pzn-biz-def"><strong>{name}</strong> · {Array.isArray(p.type) ? p.type.join("|") : p.type}</div>
          ))}
          {contract.artifact && <div className="pzn-biz-def">Artifact: <strong>{contract.artifact.type}</strong> at <code>{contract.artifact.contentPath}</code> (validated, never applied)</div>}
        </div>
      </div>
      <div className="pzn-list">
        <span className="pzn-stage-kicker">Outcome codes</span>
        <div className="pzn-rule-chips">
          {contract.outcomeCodes.map((o) => (
            <span key={o.code} className={"pzn-badge " + (o.success ? "is-pass" : "is-fail")} title={o.meaning}>{o.code} · {o.meaning}</span>
          ))}
        </div>
      </div>
      <div className="pzn-list-meta" style={{ fontSize: "0.76rem" }}>
        <span>{approvalLabel(contract)}{contract.approvalPolicy.dualControl ? " · second approver" : ""}</span>
        <span>Idempotency: {contract.idempotency.supported ? `yes (${contract.idempotency.keyField})` : "no"}</span>
        {contract.reconcileTaskId && <span>Reconcile with: {contract.reconcileTaskId}</span>}
        <span>Binding <code className="pzn-code">{contract.bindingDigest.replace(/^sha256:/, "").slice(0, 10)}</code></span>
      </div>
      {contract.sfieldRegistered && (
        <div className="pzn-btn-row">
          <button type="button" className="pzn-btn pzn-btn-sm pzn-btn-primary" onClick={() => onPrompt(`Run ${contract.ref}`)}><Play size={12} /> Run this task</button>
        </div>
      )}
    </section>
  );
}

/* ============================================================================ FORM (writes are confirmed here) */
export function TaskFormCard({
  contract, prefill, provenance: initialProvenance, onSubmitted,
}: {
  contract: Contract;
  prefill: Record<string, unknown>;
  provenance: Record<string, FieldProvenance>;
  onSubmitted: (run: TaskRun, approval?: ApprovalRecord) => void;
}) {
  const props = ((contract.inputSchema as { properties?: Record<string, SchemaProp> }).properties) ?? {};
  const required = new Set((contract.inputSchema as { required?: string[] }).required ?? []);
  const keyField = contract.idempotency.keyField;
  const fields = Object.entries(props).filter(([name]) => name !== keyField);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(([name]) => [name, prefill[name] === undefined ? "" : String(prefill[name])])));
  const [provenance, setProvenance] = useState<Record<string, FieldProvenance>>(initialProvenance);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const aiFields = Object.entries(provenance).filter(([, p]) => p === "model_proposed").map(([k]) => k);
  const needsReview = aiFields.length > 0 && contract.effect !== "read";

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const input: Record<string, unknown> = {};
      for (const [name, p] of fields) {
        const raw = values[name]?.trim() ?? "";
        if (raw === "") continue;
        const type = Array.isArray(p.type) ? p.type[0] : p.type;
        input[name] = type === "integer" || type === "number" ? Number(raw) : type === "boolean" ? raw === "true" : raw;
      }
      const finalProvenance: Record<string, string> = {};
      for (const name of Object.keys(input)) {
        const p = provenance[name] ?? "user_entered";
        finalProvenance[name] = p === "model_proposed" && reviewed ? "user_confirmed" : p;
      }
      const out = await api.runIntegrationTask({ toolRef: contract.ref, input, requestedBy: "Integrations Chat", provenance: finalProvenance });
      setSubmitted(true);
      onSubmitted(out.run, out.approval);
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const missing = [...required].filter((k) => k !== keyField && !(values[k] ?? "").trim());
  return (
    <section className="content-card pzn-widget-card" aria-label="Task form">
      <div className="pzn-widget-head">
        <div>
          <span className="pzn-stage-kicker"><ListChecks size={13} /> {contract.effect === "read" ? "RUN TASK" : "CONFIRM BEFORE RUNNING"}</span>
          <h3>{contract.taskId} <span className="pzn-badge">v{contract.version}</span></h3>
        </div>
        <span className="pzn-badge">{approvalLabel(contract)}</span>
      </div>
      <div className="pzn-form-grid">
        {fields.map(([name, p]) => {
          const ai = provenance[name] === "model_proposed";
          const set = (v: string) => {
            setValues((prev) => ({ ...prev, [name]: v }));
            setProvenance((prev) => ({ ...prev, [name]: "user_entered" }));
          };
          const long = (p.maxLength ?? 0) > 200;
          return (
            <div key={name} className={"pzn-field" + (long ? " is-full" : "")}>
              <label>
                {name}{required.has(name) ? " *" : ""}{" "}
                {ai && <span className="pzn-badge is-warn" title="Filled by the assistant — check it">AI-filled</span>}
              </label>
              {p.enum ? (
                <select aria-label={name} value={values[name] ?? ""} disabled={submitted} onChange={(e) => set(e.target.value)}>
                  <option value="">Select…</option>
                  {p.enum.map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
                </select>
              ) : long ? (
                <textarea aria-label={name} rows={4} value={values[name] ?? ""} disabled={submitted} onChange={(e) => set(e.target.value)} />
              ) : (
                <input
                  aria-label={name}
                  type={p.type === "integer" || p.type === "number" ? "number" : "text"}
                  value={values[name] ?? ""}
                  disabled={submitted}
                  onChange={(e) => set(e.target.value)}
                />
              )}
            </div>
          );
        })}
      </div>
      {keyField && <p className="pzn-subtitle" style={{ fontSize: "0.75rem" }}>An idempotency key is added automatically, so a retry can never create a duplicate.</p>}
      {needsReview && !submitted && (
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: "0.82rem" }}>
          <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
          I reviewed the AI-filled fields ({aiFields.join(", ")})
        </label>
      )}
      {error && <p className="pzn-error" role="alert">{error}</p>}
      {!submitted ? (
        <div className="pzn-btn-row">
          <button
            type="button"
            className="pzn-btn pzn-btn-primary pzn-btn-sm"
            disabled={busy || missing.length > 0 || (needsReview && !reviewed)}
            onClick={() => void submit()}
          >
            <Play size={12} /> {busy ? "Submitting…" : contract.effect === "read" ? "Run" : "Submit"}
          </button>
          {missing.length > 0 && <span className="pzn-subtitle" style={{ fontSize: "0.76rem" }}>Required: {missing.join(", ")}</span>}
        </div>
      ) : (
        <span className="pzn-badge is-pass">Submitted — result below</span>
      )}
    </section>
  );
}

/* ============================================================================ RUN RESULT */
export function TaskRunCard({ run, onPrompt }: { run: TaskRun; onPrompt: (p: string) => void }) {
  const info = STATE_INFO[run.state];
  const [copied, setCopied] = useState(false);
  const outputEntries = run.output && typeof run.output === "object" && !Array.isArray(run.output)
    ? Object.entries(run.output as Record<string, unknown>).filter(([k]) => k !== run.artifact?.type && k !== "schema")
    : [];
  return (
    <section className={"content-card pzn-widget-card pzn-approval-card is-" + (info.tone === "pass" ? "executed" : info.tone === "warn" ? "pending" : "denied")} aria-label="Task run">
      <div className="pzn-widget-head">
        <div>
          <span className="pzn-stage-kicker">
            {info.tone === "pass" ? <CheckCircle2 size={13} /> : info.tone === "warn" ? <AlertTriangle size={13} /> : <XCircle size={13} />} TASK RUN · {run.toolRef}
          </span>
          <h3>{info.label}{run.outcome ? ` · ${run.outcome.code}` : ""}</h3>
        </div>
        <span className={"pzn-badge " + toneClass(info.tone)}>{run.state.replaceAll("_", " ")}</span>
      </div>
      <p className="pzn-subtitle" style={{ fontSize: "0.82rem" }}>{run.outcome?.meaning ? `${run.outcome.meaning}. ` : ""}{info.hint}</p>
      {run.error && (
        <div className="pzn-biz-def" style={{ fontSize: "0.8rem" }}>
          <strong>{run.error.kind.replaceAll("_", " ")}</strong>{run.error.retryable ? " · retryable" : " · do not retry blindly"} — {run.error.message}
        </div>
      )}
      {outputEntries.length > 0 && (
        <div className="pzn-attr-kv-grid">
          {outputEntries.slice(0, 8).map(([k, v]) => (
            <div key={k} className="pzn-attr-kv"><span>{k}</span><strong>{typeof v === "string" ? v : JSON.stringify(v)}</strong></div>
          ))}
        </div>
      )}
      {run.artifact && (
        <div className="pzn-attachment-card">
          <div className="pzn-attr-head">
            <span className="pzn-stage-kicker"><FileCode2 size={13} /> Generated {run.artifact.type.replaceAll("_", " ")} (review only)</span>
            <div className="pzn-btn-row">
              <span className={"pzn-badge " + (run.artifact.validation.ok ? "is-pass" : "is-fail")}>{run.artifact.validation.ok ? "Valid" : "Invalid"}</span>
              <button type="button" className="pzn-btn pzn-btn-sm" onClick={() => { void navigator.clipboard?.writeText(run.artifact!.content); setCopied(true); }}>
                <Copy size={12} /> {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
          {!run.artifact.validation.ok && <p className="pzn-error">{run.artifact.validation.errors.join("; ")}</p>}
          <pre style={{ fontSize: "0.74rem", maxHeight: 260, overflow: "auto", margin: 0, padding: 10, borderRadius: 8, background: "var(--surface-2)" }}>
            {(() => { try { return JSON.stringify(JSON.parse(run.artifact.content), null, 2); } catch { return run.artifact.content; } })()}
          </pre>
        </div>
      )}
      <div className="pzn-list-meta" style={{ fontSize: "0.74rem" }}>
        <span>Run <code className="pzn-code">{run.runId}</code></span>
        {run.sfieldRunId && <span>sfield {run.sfieldRunId.slice(0, 16)}…</span>}
        {run.idempotencyKey && <span>Key {run.idempotencyKey}</span>}
        {run.reconciledFrom && <span>Reconciled via {run.reconciledFrom}</span>}
        {Object.entries(run.provenance).length > 0 && (
          <span>Inputs: {Object.entries(run.provenance).map(([k, p]) => `${k} (${p.replaceAll("_", " ")})`).join(", ")}</span>
        )}
      </div>
      <div className="pzn-btn-row">
        {run.state === "outcome_unknown" && (
          <button type="button" className="pzn-btn pzn-btn-sm pzn-btn-primary" onClick={() => onPrompt(`Reconcile ${run.runId}`)}>
            <RefreshCw size={12} /> Reconcile
          </button>
        )}
        {run.state === "pending_approval" && (
          <button type="button" className="pzn-btn pzn-btn-sm" onClick={() => onPrompt("Show pending approvals")}><ShieldCheck size={12} /> Open approvals</button>
        )}
        {(run.state === "failed" || run.state === "expired") && run.error?.retryable && (
          <button type="button" className="pzn-btn pzn-btn-sm" onClick={() => onPrompt(`Run ${run.toolRef}`)}><Play size={12} /> Try again</button>
        )}
      </div>
    </section>
  );
}

/* ============================================================================ RUN HISTORY */
export function RunsCard({ runs, filter, onPrompt }: { runs: TaskRun[]; filter?: string; onPrompt: (p: string) => void }) {
  const [open, setOpen] = useState<string>("");
  return (
    <section className="content-card pzn-widget-card" aria-label="Task runs">
      <div className="pzn-widget-head">
        <div>
          <span className="pzn-stage-kicker"><Clock size={13} /> TASK RUNS{filter ? ` · ${filter.replaceAll("_", " ")}` : ""}</span>
          <h3>{runs.length} run(s)</h3>
        </div>
      </div>
      {runs.length === 0 ? <p className="pzn-subtitle">Nothing here yet.</p> : (
        <div className="pzn-list">
          {runs.map((r) => {
            const info = STATE_INFO[r.state];
            return (
              <div key={r.runId} className="pzn-attr-card">
                <div className="pzn-attr-head">
                  <div className="pzn-btn-row">
                    <span className={"pzn-badge " + toneClass(info.tone)}>{info.label}</span>
                    <strong style={{ fontSize: "0.84rem" }}>{r.taskId}</strong>
                    {r.outcome && <span className="pzn-badge">{r.outcome.code}</span>}
                    <span className="pzn-subtitle" style={{ fontSize: "0.74rem" }}>{new Date(r.createdAt).toLocaleTimeString()}</span>
                  </div>
                  <div className="pzn-btn-row">
                    {r.state === "outcome_unknown" && (
                      <button type="button" className="pzn-btn pzn-btn-sm pzn-btn-primary" onClick={() => onPrompt(`Reconcile ${r.runId}`)}><RefreshCw size={12} /> Reconcile</button>
                    )}
                    <button type="button" className="pzn-btn pzn-btn-sm" onClick={() => setOpen(open === r.runId ? "" : r.runId)}>{open === r.runId ? "Hide" : "Details"}</button>
                  </div>
                </div>
                {open === r.runId && <TaskRunCard run={r} onPrompt={onPrompt} />}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ============================================================================ APPROVALS */
export function IntegrationApprovalsCard({ onPrompt, onDecided }: { onPrompt: (p: string) => void; onDecided?: (record: ApprovalRecord) => void }) {
  const [approvals, setApprovals] = useState<ApprovalRecord[] | null>(null);
  const [error, setError] = useState("");
  const load = () => api.approvals().then((v) => setApprovals(v.approvals.filter((a) => a.domain === "integration")), (e) => setError(toolSetupErrorMessage(e)));
  useEffect(() => { void load(); }, []);
  const pending = useMemo(() => (approvals ?? []).filter((a) => a.status === "pending"), [approvals]);
  const recent = useMemo(() => (approvals ?? []).filter((a) => a.status !== "pending").slice(0, 4), [approvals]);
  return (
    <section className="content-card pzn-widget-card" aria-label="Task approvals">
      <div className="pzn-widget-head">
        <div>
          <span className="pzn-stage-kicker"><ShieldCheck size={13} /> TASK APPROVALS</span>
          <h3>{approvals ? `${pending.length} pending` : "Loading…"}</h3>
        </div>
        <button type="button" className="pzn-btn pzn-btn-sm" onClick={() => void load()}><RefreshCw size={12} /> Refresh</button>
      </div>
      {error && <p className="pzn-error">{error}</p>}
      {approvals && pending.length === 0 && <p className="pzn-subtitle">No task is waiting for approval.</p>}
      <div className="pzn-list">
        {pending.map((a) => <ApprovalRequestCard key={a.id} approval={a} onRunPrompt={onPrompt} onDecided={(r) => { void load(); onDecided?.(r); }} />)}
      </div>
      {recent.length > 0 && (
        <div className="pzn-list">
          <span className="pzn-stage-kicker">Recent decisions</span>
          {recent.map((a) => (
            <div key={a.id} className="pzn-attr-card">
              <div className="pzn-attr-head">
                <strong style={{ fontSize: "0.82rem" }}>{a.title}</strong>
                <span className={"pzn-badge " + (a.status === "executed" ? "is-pass" : a.status === "denied" || a.status === "expired" ? "is-fail" : "is-warn")}>{a.status}</span>
              </div>
              {a.executionResult?.summary && <span className="pzn-subtitle" style={{ fontSize: "0.76rem" }}>{a.executionResult.summary}</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
