import { CheckCircle2, Clock, FastForward, GitBranch, PlayCircle, Radio, ShieldAlert, XCircle, Zap } from "lucide-react";
import type { WorkflowDefinitionUpsertInput, WorkflowRun, WorkflowStep, WorkflowStepRun } from "../../packages/contracts/workflow-definition";

type DagStep = WorkflowDefinitionUpsertInput["steps"][number];

function stepKindLabel(type: DagStep["type"]) {
  if (type === "collect_input") return "Collect Form Input";
  if (type === "compute") return "Deterministic Compute";
  if (type === "hitl_approval") return "SHA-256 HITL Gate";
  if (type === "connector_call") return "External Connector";
  if (type === "async_job") return "Async Settlement Timer";
  return "Emit Host Portal Event";
}

function stepMetaText(step: DagStep): string {
  if (step.type === "collect_input") return `${step.fields.length} input field(s): ${step.fields.map((f) => f.id).join(", ")}`;
  if (step.type === "compute") return `Evaluator: ${step.evaluator}`;
  if (step.type === "hitl_approval") return `${(step.riskLevel ?? "high").toUpperCase()} risk · ${step.dualControl ? "4-Eyes Dual Control" : "Inline Sign-Off"}`;
  if (step.type === "connector_call") return `Connector: ${step.connectorId} (${step.action})`;
  if (step.type === "async_job") return `${step.durationSeconds ?? 4}s timer · ${step.cancellable !== false ? "Cancellable" : "Locked"}`;
  return `postMessage event: ${step.eventName ?? "cep:workflow_completed"}`;
}

function StatusIcon({ status }: { status?: WorkflowStepRun["status"] }) {
  if (status === "completed") return <CheckCircle2 size={15} aria-hidden="true" />;
  if (status === "skipped") return <FastForward size={14} aria-hidden="true" />;
  if (status === "waiting_approval") return <ShieldAlert size={15} aria-hidden="true" />;
  if (status === "failed" || status === "cancelled") return <XCircle size={15} aria-hidden="true" />;
  if (status === "running_job") return <Zap size={14} aria-hidden="true" />;
  return <Clock size={14} aria-hidden="true" />;
}

export function WorkflowDagView({
  definition,
  replayRun,
  onClearReplay,
}: {
  definition: WorkflowDefinitionUpsertInput;
  replayRun?: WorkflowRun | null;
  onClearReplay?: () => void;
}) {
  const runStepsById = new Map((replayRun?.steps ?? []).map((s) => [s.stepId, s]));

  return (
    <div className="wf-dag-wrap" aria-label="Visual Workflow DAG Diagram">
      <div className="wf-dag-banner">
        <div className="wf-dag-banner-left">
          <GitBranch size={15} aria-hidden="true" />
          <strong>
            {replayRun
              ? `Live Execution Replay · ${replayRun.runId} (${replayRun.status.toUpperCase()})`
              : `Declarative DAG Blueprint · ${definition.steps.length} Executable Nodes`}
          </strong>
        </div>
        {replayRun && onClearReplay && (
          <button type="button" className="reg-mini-btn" onClick={onClearReplay}>
            Exit Replay
          </button>
        )}
      </div>

      <div className="wf-dag-canvas">
        {/* Trigger Start Node */}
        <div className="wf-dag-node is-trigger">
          <div className="wf-dag-node-top">
            <span className="wf-dag-chip is-trigger"><PlayCircle size={13} aria-hidden="true" /> TRIGGER</span>
            <strong>{definition.name}</strong>
          </div>
          <div className="wf-dag-node-meta">
            Phrases: {definition.triggerPhrases.map((p) => `"${p}"`).join(" · ")}
          </div>
        </div>

        {definition.steps.map((step, idx) => {
          const exec = runStepsById.get(step.id);
          const statusClass = exec ? `is-run-${exec.status}` : "";
          const condText = step.when
            ? `${step.when.field} ${step.when.op}${step.when.value !== undefined ? ` ${String(step.when.value)}` : ""}`
            : null;

          return (
            <div key={`${step.id}-${idx}`} className="wf-dag-stage">
              <div className="wf-dag-connector" aria-hidden="true">
                <div className="wf-dag-line" />
                <div className="wf-dag-arrow" />
              </div>

              {condText && (
                <div className={"wf-dag-branch-row " + (exec?.status === "skipped" ? "is-skipped-branch" : exec ? "is-taken-branch" : "")}>
                  <div className="wf-dag-diamond">
                    <span>IF <code>{condText}</code></span>
                  </div>
                  <div className="wf-dag-branch-paths">
                    <span className="wf-branch-true">TRUE → Execute Step {idx + 1}</span>
                    <span className="wf-branch-false">FALSE → Skip to Step {idx + 2 <= definition.steps.length ? idx + 2 : "End"}</span>
                  </div>
                </div>
              )}

              <div className={`wf-dag-node is-kind-${step.type} ${statusClass}`}>
                <div className="wf-dag-node-top">
                  <span className="wf-dag-step-idx">#{idx + 1}</span>
                  <span className={`wf-dag-chip is-${step.type}`}>{stepKindLabel(step.type)}</span>
                  <strong>{step.title}</strong>
                  {exec && (
                    <span className={`wf-status-badge is-${exec.status}`} style={{ marginLeft: "auto" }}>
                      <StatusIcon status={exec.status} /> {exec.status.replace("_", " ")}
                    </span>
                  )}
                </div>
                <div className="wf-dag-node-meta">{stepMetaText(step)}</div>
                {exec?.summary && (
                  <div className="wf-dag-replay-note">
                    {exec.summary}
                    {exec.payloadDigest && <span> · SHA-256: <code>{exec.payloadDigest.slice(0, 12)}…</code></span>}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        <div className="wf-dag-connector" aria-hidden="true">
          <div className="wf-dag-line" />
          <div className="wf-dag-arrow" />
        </div>

        <div className={"wf-dag-node is-terminal " + (replayRun?.status === "completed" ? "is-run-completed" : "")}>
          <div className="wf-dag-node-top">
            <span className="wf-dag-chip is-terminal"><Radio size={13} aria-hidden="true" /> COMPLETE</span>
            <strong>Durable Run Settled &amp; Audited</strong>
          </div>
          <div className="wf-dag-node-meta">
            Persisted in workflow-runs.json · Audit proof included in Signed Compliance Packet
          </div>
        </div>
      </div>
    </div>
  );
}
