import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Clock, FastForward, Loader2, ShieldAlert, Sparkles, XCircle } from "lucide-react";
import type { DynamicCanvasNode } from "../../packages/contracts/dynamic-canvas";
import type { WorkflowDefinition, WorkflowRun, WorkflowStep } from "../../packages/contracts/workflow-definition";
import { CEP_EMBED_PROTOCOL } from "../../packages/embed-sdk";
import { api } from "./api";
import { notifyDomainDataUpdated } from "./domain-pack-ui";

type WorkflowRunnerNodeProps = {
  node: Extract<DynamicCanvasNode, { type: "workflow_runner" }>;
};

export function WorkflowRunnerNode({ node }: WorkflowRunnerNodeProps) {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [def, setDef] = useState<WorkflowDefinition | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const emittedEventsRef = useRef<Set<string>>(new Set());

  const hydrateDefaults = (nextRun: WorkflowRun, nextDef?: WorkflowDefinition | null) => {
    const activeStep = nextDef?.steps[nextRun.currentStepIndex];
    if (!activeStep || activeStep.type !== "collect_input") return;
    setFormValues((prev) => {
      const next = { ...prev };
      for (const f of activeStep.fields) {
        if (next[f.id] === undefined) {
          const prefilled = nextRun.inputs[f.id];
          const sourceVal = prefilled !== undefined ? prefilled : f.defaultValue;
          if (f.type === "checkbox") next[f.id] = Boolean(sourceVal);
          else if (f.type === "select") next[f.id] = String(sourceVal ?? f.options?.[0] ?? "");
          else next[f.id] = sourceVal !== undefined ? String(sourceVal) : "";
        }
      }
      return next;
    });
  };

  useEffect(() => {
    let alive = true;
    void api.workflowRun(node.runId).then((res) => {
      if (!alive) return;
      setRun(res.run);
      if (res.definition) setDef(res.definition);
      hydrateDefaults(res.run, res.definition);
    }).catch((err: unknown) => {
      if (alive) setError(err instanceof Error ? err.message : "Could not load workflow run.");
    });
    return () => { alive = false; };
  }, [node.runId]);

  // Live SSE push while running async job or waiting for external approval
  useEffect(() => {
    if (!run || (run.status !== "running_job" && run.status !== "waiting_approval")) return;
    let alive = true;
    const stream = new EventSource(`/api/workflow-runs/${run.runId}/events`);
    stream.addEventListener("workflow.update", (evt) => {
      if (!alive) return;
      try {
        const updated = JSON.parse((evt as MessageEvent).data) as WorkflowRun;
        setRun(updated);
        hydrateDefaults(updated, def);
        if (updated.status === "completed") notifyDomainDataUpdated();
      } catch { /* ignore parse errors */ }
    });
    const tick = setInterval(() => setNowMs(Date.now()), 250);
    return () => {
      alive = false;
      stream.close();
      clearInterval(tick);
    };
  }, [run?.runId, run?.status, def]);

  // Emit host postMessage events when emit_host_event steps complete
  useEffect(() => {
    if (!run) return;
    for (const step of run.steps) {
      if (step.status === "completed" && step.emittedEvent && !emittedEventsRef.current.has(step.stepId)) {
        emittedEventsRef.current.add(step.stepId);
        if (window.parent !== window) {
          try {
            window.parent.postMessage(
              { protocol: CEP_EMBED_PROTOCOL, type: step.emittedEvent.eventName, payload: step.emittedEvent.payload },
              "*",
            );
          } catch { /* ignore */ }
        }
      }
    }
  }, [run]);

  const activeStepDef: WorkflowStep | undefined = useMemo(() => {
    if (!run || !def) return undefined;
    return def.steps[run.currentStepIndex];
  }, [run, def]);

  const submitStepInput = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!run || !activeStepDef || activeStepDef.type !== "collect_input") return;
    setBusy(true);
    setError("");
    try {
      const payload: Record<string, string | number | boolean> = {};
      for (const f of activeStepDef.fields) {
        const v = formValues[f.id];
        if (f.type === "checkbox") payload[f.id] = Boolean(v);
        else if (f.type === "number" || f.type === "currency") payload[f.id] = Number(String(v ?? "0").replace(/[^0-9.-]/g, "")) || 0;
        else payload[f.id] = String(v ?? "");
      }
      const res = await api.submitWorkflowInput(run.runId, payload);
      setRun(res.run);
      if (res.definition) setDef(res.definition);
      hydrateDefaults(res.run, res.definition ?? def);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to submit workflow input.");
    } finally {
      setBusy(false);
    }
  };

  const decideApproval = async (approvalId: string, decision: "approve" | "deny") => {
    if (!run) return;
    setBusy(true);
    setError("");
    try {
      await api.decideApproval(approvalId, {
        decision,
        actor: run.actorName,
      });
      const fresh = await api.workflowRun(run.runId);
      setRun(fresh.run);
      if (fresh.definition) setDef(fresh.definition);
      if (fresh.run.status === "completed") notifyDomainDataUpdated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not process approval.");
    } finally {
      setBusy(false);
    }
  };

  const cancelRun = async () => {
    if (!run) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.cancelWorkflowRun(run.runId);
      setRun(res.run);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not cancel workflow.");
    } finally {
      setBusy(false);
    }
  };

  if (!run) {
    return (
      <div className="wf-runner-card">
        <div className="wf-loading"><Loader2 size={15} className="wf-spin" /> Loading workflow run {node.runId}…</div>
      </div>
    );
  }

  const activeStepRun = run.steps[run.currentStepIndex];

  return (
    <div className="wf-runner-card">
      <div className="wf-runner-head">
        <div>
          <span className="wf-run-id">{run.workflowId} · v{run.workflowVersion} · {run.runId}</span>
        </div>
        <span className={`wf-status-badge is-${run.status}`}>
          {run.status.replace("_", " ")}
        </span>
      </div>

      <ol className="wf-step-list">
        {run.steps.map((step, idx) => {
          const stepDef = def?.steps[idx];
          const isCurrent = idx === run.currentStepIndex && !["completed", "cancelled", "failed"].includes(run.status);
          const remainingMs = step.status === "running_job" && step.jobEndsAt
            ? Math.max(0, new Date(step.jobEndsAt).getTime() - nowMs)
            : 0;
          const totalMs = (step.durationSeconds ?? 4) * 1000;
          const pct = step.status === "running_job"
            ? Math.min(100, Math.max(5, Math.round(((totalMs - remainingMs) / Math.max(totalMs, 1)) * 100)))
            : 100;

          return (
            <li key={step.stepId} className={`wf-step-item is-${step.status}` + (isCurrent ? " is-current" : "")}>
              <div className="wf-step-icon" aria-hidden="true">
                {step.status === "completed" && <CheckCircle2 size={16} />}
                {step.status === "skipped" && <FastForward size={15} />}
                {(step.status === "failed" || step.status === "cancelled") && <XCircle size={16} />}
                {step.status === "running_job" && <Loader2 size={15} className="wf-spin" />}
                {step.status === "waiting_approval" && <ShieldAlert size={15} />}
                {(step.status === "waiting_input" || step.status === "pending" || step.status === "active") && <Clock size={15} />}
              </div>
              <div className="wf-step-body">
                <div className="wf-step-top">
                  <strong>{idx + 1}. {step.title}</strong>
                  <span className="wf-step-type">{step.type.replace("_", " ")}</span>
                </div>
                {step.summary && <p className="wf-step-summary">{step.summary}</p>}
                {step.type === "integration_task" && (step.toolRef || step.outcomeCode || step.taskRunId) && (
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", fontSize: "0.75rem", opacity: 0.85, marginTop: "4px" }}>
                    {step.toolRef && <code>{step.toolRef}</code>}
                    {step.outcomeCode && <span>Outcome: <strong>{step.outcomeCode}</strong></span>}
                    {step.taskRunId && <code>{step.taskRunId}</code>}
                  </div>
                )}

                {/* Interactive Form for collect_input */}
                {isCurrent && step.status === "waiting_input" && stepDef?.type === "collect_input" && (
                  <form className="wf-inline-form" onSubmit={submitStepInput}>
                    <div className="wf-form-grid">
                      {stepDef.fields.map((f) => (
                        <label key={f.id} className={f.type === "checkbox" ? "wf-check-field" : "wf-input-field"}>
                          {f.type === "checkbox" ? (
                            <>
                              <input
                                type="checkbox"
                                checked={Boolean(formValues[f.id])}
                                onChange={(e) => setFormValues((prev) => ({ ...prev, [f.id]: e.target.checked }))}
                              />
                              <span>{f.label}</span>
                            </>
                          ) : (
                            <>
                              <span>{f.label}</span>
                              {f.type === "select" ? (
                                <select
                                  value={String(formValues[f.id] ?? f.options?.[0] ?? "")}
                                  onChange={(e) => setFormValues((prev) => ({ ...prev, [f.id]: e.target.value }))}
                                >
                                  {(f.options ?? []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                                </select>
                              ) : (
                                <input
                                  type={f.type === "number" || f.type === "currency" ? "number" : "text"}
                                  required={f.required}
                                  placeholder={f.placeholder}
                                  value={String(formValues[f.id] ?? "")}
                                  onChange={(e) => setFormValues((prev) => ({ ...prev, [f.id]: e.target.value }))}
                                />
                              )}
                            </>
                          )}
                        </label>
                      ))}
                    </div>
                    <div className="wf-form-actions">
                      <button type="submit" className="wf-primary-btn" disabled={busy}>
                        {busy ? "Processing…" : stepDef.submitLabel}
                      </button>
                      <button type="button" className="wf-ghost-btn" disabled={busy} onClick={cancelRun}>
                        Cancel
                      </button>
                    </div>
                  </form>
                )}

                {/* Inline SHA-256 HITL Approval Gate */}
                {isCurrent && step.status === "waiting_approval" && step.approvalId && (stepDef?.type === "hitl_approval" || stepDef?.type === "integration_task") && (
                  <div className="wf-approval-box">
                    <div className="wf-approval-meta">
                      <span>SHA-256 Digest: <code>{step.payloadDigest?.slice(0, 16)}…</code></span>
                      <span>Approval ID: <code>{step.approvalId}</code></span>
                      {step.dualControl && <span className="wf-dual-pill">4-Eyes Dual Control</span>}
                    </div>
                    <div className="wf-form-actions">
                      <button
                        type="button"
                        className="wf-primary-btn"
                        disabled={busy}
                        onClick={() => void decideApproval(step.approvalId!, "approve")}
                      >
                        {stepDef.type === "hitl_approval" ? stepDef.approveLabel : "Approve & Run Task"}
                      </button>
                      <button
                        type="button"
                        className="wf-danger-btn"
                        disabled={busy}
                        onClick={() => void decideApproval(step.approvalId!, "deny")}
                      >
                        {stepDef.type === "hitl_approval" ? stepDef.rejectLabel : "Deny & Abort"}
                      </button>
                    </div>
                  </div>
                )}

                {/* Live Countdown Progress Bar for async_job */}
                {isCurrent && step.status === "running_job" && (
                  <div className="wf-job-progress">
                    <div className="wf-progress-track">
                      <div className="wf-progress-fill" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="wf-job-foot">
                      <span>Settling… {(remainingMs / 1000).toFixed(1)}s remaining</span>
                      {stepDef?.type === "async_job" && stepDef.cancellable && (
                        <button type="button" className="wf-danger-btn" disabled={busy} onClick={cancelRun}>
                          Cancel Job
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {run.status === "completed" && (
        <div className="wf-done-banner">
          <Sparkles size={15} aria-hidden="true" />
          <span>Workflow completed cleanly ({run.steps.filter((s) => s.status === "completed").length} steps executed, {run.steps.filter((s) => s.status === "skipped").length} skipped).</span>
        </div>
      )}

      {error && <p className="wf-error" role="alert">{error}</p>}
      {activeStepRun?.status === "failed" && run.errorMessage && <p className="wf-error">{run.errorMessage}</p>}
    </div>
  );
}
