import { useEffect, useState } from "react";
import { Code2, GitBranch, Layers, Play, Plus, RotateCcw, Save, Sparkles, Trash2 } from "lucide-react";
import type {
  WorkflowDefinition,
  WorkflowDefinitionUpsertInput,
  WorkflowRun,
  WorkflowStep,
} from "../../packages/contracts/workflow-definition";
import { api } from "./api";
import { WorkflowDagView } from "./workflow-dag";

function makeBlankWorkflow(): WorkflowDefinitionUpsertInput {
  return {
    id: `custom_workflow_${Date.now().toString(36).slice(-4)}`,
    name: "Custom Approval Workflow",
    domain: "wealth",
    version: "1.0.0",
    description: "Collect user parameters, gate high-value requests with SHA-256 HITL approval, and execute an async settlement job.",
    triggerPhrases: ["run custom workflow", "start custom approval"],
    enabled: true,
    steps: [
      {
        id: "collect_request",
        type: "collect_input",
        title: "Collect Request Inputs",
        submitLabel: "Submit Request",
        fields: [
          { id: "subject", label: "Request Subject", type: "text", required: true, defaultValue: "Portfolio Rebalance" },
          { id: "amountUsd", label: "Amount ($ USD)", type: "currency", required: true, defaultValue: 12000 },
        ],
      },
      {
        id: "compliance_gate",
        type: "hitl_approval",
        title: "Compliance Gate (> $10k)",
        when: { field: "inputs.amountUsd", op: "gt", value: 10000 },
        riskLevel: "high",
        dualControl: false,
        approvalTitleTemplate: "Approve {{inputs.subject}} (${{inputs.amountUsd}})",
        approvalSummaryTemplate: "Amount ${{inputs.amountUsd}} exceeds $10,000 automated limit.",
        approveLabel: "Approve & Execute",
        rejectLabel: "Reject",
      },
      {
        id: "execute_job",
        type: "async_job",
        title: "Execute Processing Job",
        durationSeconds: 3,
        cancellable: true,
        runningLabel: "Executing {{inputs.subject}}...",
        completedTemplate: "Completed {{inputs.subject}} (${{inputs.amountUsd}}).",
      },
      {
        id: "notify_host",
        type: "emit_host_event",
        title: "Emit Host Portal Event",
        eventName: "cep:workflow_completed",
        messageTemplate: "Sent cep:workflow_completed to host portal.",
      },
    ],
  };
}

export function WorkflowStudioPanel() {
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [recentRuns, setRecentRuns] = useState<WorkflowRun[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [draft, setDraft] = useState<WorkflowDefinitionUpsertInput | null>(null);
  const [editMode, setEditMode] = useState<"dag" | "visual" | "json">("dag");
  const [replayRun, setReplayRun] = useState<WorkflowRun | null>(null);
  const [jsonText, setJsonText] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiSource, setAiSource] = useState<"" | "copilot_llm" | "synthesizer">("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = async (keepId?: string) => {
    try {
      const view = await api.workflows();
      setDefinitions(view.definitions);
      setRecentRuns(view.recentRuns);
      const target = (keepId && view.definitions.find((d) => d.id === keepId)) ?? view.definitions[0];
      if (target) pickDefinition(target);
    } catch (err: unknown) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not load workflows." });
    }
  };

  useEffect(() => { void load(); }, []);

  const pickDefinition = (def: WorkflowDefinition) => {
    setSelectedId(def.id);
    setReplayRun(null);
    const clean: WorkflowDefinitionUpsertInput = {
      id: def.id,
      name: def.name,
      domain: def.domain,
      version: def.version,
      description: def.description,
      triggerPhrases: [...def.triggerPhrases],
      steps: structuredClone(def.steps),
      enabled: def.enabled,
    };
    setDraft(clean);
    setJsonText(JSON.stringify(clean, null, 2));
    setNotice(null);
  };

  const syncDraft = (next: WorkflowDefinitionUpsertInput) => {
    setDraft(next);
    setJsonText(JSON.stringify(next, null, 2));
  };

  const addStep = (type: WorkflowStep["type"]) => {
    if (!draft) return;
    const stepId = `step_${draft.steps.length + 1}_${type.slice(0, 6)}`;
    let nextStep: WorkflowStep;
    if (type === "collect_input") {
      nextStep = {
        id: stepId,
        type: "collect_input",
        title: "Collect User Input",
        submitLabel: "Continue",
        fields: [{ id: "note", label: "Details", type: "text", required: true, defaultValue: "" }],
      };
    } else if (type === "compute") {
      nextStep = {
        id: stepId,
        type: "compute",
        title: "Deterministic Evaluation",
        evaluator: "template_summary",
        outputTemplate: "Evaluated inputs successfully.",
      };
    } else if (type === "hitl_approval") {
      nextStep = {
        id: stepId,
        type: "hitl_approval",
        title: "Human Approval Gate",
        riskLevel: "high",
        dualControl: false,
        approvalTitleTemplate: "Approval Required · {{inputs.subject}}",
        approvalSummaryTemplate: "Review workflow parameters before execution.",
        approveLabel: "Approve & Continue",
        rejectLabel: "Reject",
      };
    } else if (type === "connector_call") {
      nextStep = {
        id: stepId,
        type: "connector_call",
        title: "Invoke External Connector",
        connectorId: "pagerduty_incident_webhook",
        action: "workflow_dispatch",
        noteTemplate: "Triggered from workflow",
      };
    } else if (type === "integration_task") {
      nextStep = {
        id: stepId,
        type: "integration_task",
        title: "Run Governed Integration Task",
        toolRef: "int.itsm_sandbox.create_ticket@1.0.0",
        inputMapping: { title: "{{inputs.title}}", priority: "P3", service: "platform" },
      };
    } else if (type === "async_job") {
      nextStep = {
        id: stepId,
        type: "async_job",
        title: "Async Settlement Timer",
        durationSeconds: 4,
        cancellable: true,
        runningLabel: "Processing workflow job...",
        completedTemplate: "Async job completed.",
      };
    } else {
      nextStep = {
        id: stepId,
        type: "emit_host_event",
        title: "Emit Host Portal Event",
        eventName: "cep:workflow_completed",
        messageTemplate: "Broadcasted cep:workflow_completed to embedding host app.",
      };
    }
    syncDraft({ ...draft, steps: [...draft.steps, nextStep] });
  };

  const removeStep = (index: number) => {
    if (!draft || draft.steps.length <= 1) return;
    syncDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) });
  };

  const saveWorkflow = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const payload = editMode === "json"
        ? (JSON.parse(jsonText) as WorkflowDefinitionUpsertInput)
        : draft!;
      const view = await api.saveWorkflow(payload);
      setDefinitions(view.definitions);
      setRecentRuns(view.recentRuns);
      const saved = view.definitions.find((d) => d.id === payload.id);
      if (saved) pickDefinition(saved);
      setNotice({ tone: "ok", text: `Saved workflow "${payload.name}" (${payload.steps.length} steps). Live in Chat & Embed SDK immediately.` });
    } catch (err: unknown) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Validation failed — check JSON schema and fields." });
    } finally {
      setSaving(false);
    }
  };

  const deleteOrReset = async () => {
    if (!draft) return;
    setSaving(true);
    setNotice(null);
    try {
      const view = await api.deleteWorkflow(draft.id);
      setDefinitions(view.definitions);
      setRecentRuns(view.recentRuns);
      const next = view.definitions.find((d) => d.id === draft.id) ?? view.definitions[0];
      if (next) pickDefinition(next);
      setNotice({ tone: "ok", text: `Updated workflow "${draft.id}".` });
    } catch (err: unknown) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not update workflow." });
    } finally {
      setSaving(false);
    }
  };

  const runDryTest = async () => {
    if (!draft) return;
    setSaving(true);
    setNotice(null);
    try {
      const started = await api.startWorkflow(draft.id, {});
      await load(draft.id);
      setNotice({ tone: "ok", text: `Launched live workflow run ${started.run.runId} (status: ${started.run.status}). Try typing "${draft.triggerPhrases[0]}" in Chat or /embed-demo!` });
    } catch (err: unknown) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not launch workflow." });
    } finally {
      setSaving(false);
    }
  };

  const generateWithCopilot = async (overridePrompt?: string) => {
    const text = (overridePrompt ?? aiPrompt).trim();
    if (text.length < 4) return;
    if (overridePrompt) setAiPrompt(overridePrompt);
    setAiBusy(true);
    setNotice(null);
    try {
      const res = await api.generateWorkflow(text);
      setSelectedId(res.definition.id);
      syncDraft(res.definition);
      setAiSource(res.generatedBy);
      setNotice({ tone: "ok", text: `${res.summary} Click "Save Workflow" to publish live.` });
    } catch (err: unknown) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not generate workflow." });
    } finally {
      setAiBusy(false);
    }
  };

  const selectedDef = definitions.find((d) => d.id === selectedId);

  return (
    <div className="wf-studio-layout">
      <aside className="reg-rail wf-rail">
        <div className="reg-rail-head">
          <h2>Workflow Definitions ({definitions.length})</h2>
          <button
            type="button"
            className="reg-mini-btn"
            onClick={() => {
              const blank = makeBlankWorkflow();
              setSelectedId(blank.id);
              syncDraft(blank);
              setNotice(null);
            }}
          >
            <Plus size={14} aria-hidden="true" />New
          </button>
        </div>
        <div className="reg-list">
          {definitions.map((def) => (
            <button
              key={def.id}
              type="button"
              className={"reg-list-item" + (selectedId === def.id ? " is-active" : "")}
              onClick={() => pickDefinition(def)}
            >
              <div className="reg-item-top">
                <strong>{def.name}</strong>
                <span className="reg-tag">{def.steps.length} steps</span>
              </div>
              <span className="reg-item-sub">{def.domain} · Trigger: "{def.triggerPhrases[0]}"</span>
            </button>
          ))}
        </div>

        <div className="wf-recent-runs">
          <h3>Recent Durable Runs ({recentRuns.length})</h3>
          {recentRuns.length === 0 ? (
            <p className="wf-muted-note">No runs yet. Trigger a workflow in Chat, /embed-demo, or click Test Run.</p>
          ) : (
            <div className="wf-runs-list">
              {recentRuns.slice(0, 6).map((r) => (
                <button
                  key={r.runId}
                  type="button"
                  className={"wf-run-mini is-clickable" + (replayRun?.runId === r.runId ? " is-active" : "")}
                  title="Click to replay this run on the Visual DAG"
                  onClick={() => {
                    const matchedDef = definitions.find((d) => d.id === r.workflowId);
                    if (matchedDef) pickDefinition(matchedDef);
                    setReplayRun(r);
                    setEditMode("dag");
                  }}
                >
                  <div>
                    <strong>{r.workflowName}</strong>
                    <small>{r.runId} · {r.actorName} · Replay DAG</small>
                  </div>
                  <span className={`wf-status-badge is-${r.status}`}>{r.status.replace("_", " ")}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      <section className="reg-editor wf-editor">
        <div className="wf-copilot-bar">
          <div className="wf-copilot-head">
            <strong><Sparkles size={15} aria-hidden="true" /> Generate Multi-Step Workflow with Copilot</strong>
            {aiSource && (
              <span className="reg-tag">{aiSource === "copilot_llm" ? "Generated by Copilot ACP" : "Synthesized DAG"}</span>
            )}
          </div>
          <form
            className="wf-copilot-form"
            onSubmit={(e) => {
              e.preventDefault();
              void generateWithCopilot();
            }}
          >
            <input
              value={aiPrompt}
              disabled={aiBusy || saving}
              placeholder="e.g. Build an insurance claim workflow: collect policy & amount, require 4-eyes HITL above $2,500, run 4s payout timer, and notify host app"
              onChange={(e) => setAiPrompt(e.target.value)}
            />
            <button type="submit" className="reg-save-btn" disabled={aiBusy || saving || aiPrompt.trim().length < 4}>
              <Sparkles size={14} aria-hidden="true" />
              {aiBusy ? "Generating…" : "Generate Workflow"}
            </button>
          </form>
          <div className="wf-copilot-chips">
            <span>Examples:</span>
            {[
              { label: "Insurance Claim Payout (>$2.5k HITL)", prompt: "Build an insurance claim payout workflow: collect policy number, claim type, and amount; run automated fraud check; require HITL approval above $2,500; settle payout in 4s; and emit host portal event" },
              { label: "Vendor Onboarding (>$10k 4-Eyes)", prompt: "Create a vendor onboarding workflow: collect vendor name, annual spend, and data tier; run SOC2 screening; require 4-eyes approval over $10,000; provision in ERP; and notify host portal" },
              { label: "Cloud Emergency Rollback", prompt: "Build an SRE cloud rollback workflow: collect service and impact, gate high-impact changes with HITL approval, invoke PagerDuty connector, verify canary in 4s, and notify host" },
            ].map((ex) => (
              <button
                key={ex.label}
                type="button"
                className="reg-mini-btn"
                disabled={aiBusy || saving}
                onClick={() => void generateWithCopilot(ex.prompt)}
              >
                {ex.label}
              </button>
            ))}
          </div>
        </div>

        {notice && <p className={"reg-notice " + (notice.tone === "error" ? "is-error" : "is-ok")} role="status">{notice.text}</p>}

        {draft && (
          <>
            <div className="wf-editor-head">
              <div>
                <h2>{draft.name}</h2>
                <p className="wf-editor-sub">
                  Declarative multi-step state machine stored in <code>workflows.json</code>. Supports conditional <code>when</code> branches, SHA-256 HITL gates, connectors, async timers, and host <code>postMessage</code> events.
                </p>
              </div>
              <div className="wf-editor-actions">
                <div className="wf-mode-toggle">
                  <button type="button" className={editMode === "dag" ? "is-active" : ""} onClick={() => setEditMode("dag")}>
                    <GitBranch size={14} aria-hidden="true" />DAG Graph
                  </button>
                  <button type="button" className={editMode === "visual" ? "is-active" : ""} onClick={() => setEditMode("visual")}>
                    <Layers size={14} aria-hidden="true" />Editor
                  </button>
                  <button type="button" className={editMode === "json" ? "is-active" : ""} onClick={() => { setJsonText(JSON.stringify(draft, null, 2)); setEditMode("json"); }}>
                    <Code2 size={14} aria-hidden="true" />JSON Spec
                  </button>
                </div>
                <button type="button" className="reg-mini-btn" disabled={saving} onClick={runDryTest}>
                  <Play size={14} aria-hidden="true" />Test Run
                </button>
                <button type="button" className="reg-save-btn" disabled={saving} onClick={saveWorkflow}>
                  <Save size={14} aria-hidden="true" />Save Workflow
                </button>
                {selectedDef && (
                  <button type="button" className="reg-mini-btn" disabled={saving} onClick={deleteOrReset}>
                    {selectedDef.isBuiltIn ? <><RotateCcw size={14} aria-hidden="true" />Reset</> : <><Trash2 size={14} aria-hidden="true" />Delete</>}
                  </button>
                )}
              </div>
            </div>

            {editMode === "dag" ? (
              <WorkflowDagView
                definition={draft}
                replayRun={replayRun?.workflowId === draft.id ? replayRun : null}
                onClearReplay={() => setReplayRun(null)}
              />
            ) : editMode === "json" ? (
              <div className="wf-json-pane">
                <textarea
                  className="wf-json-editor"
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  spellCheck={false}
                  rows={24}
                  aria-label="Workflow JSON Definition"
                />
              </div>
            ) : (
              <div className="wf-visual-pane">
                <div className="wf-meta-grid">
                  <label>
                    <span>Workflow ID</span>
                    <input value={draft.id} onChange={(e) => syncDraft({ ...draft, id: e.target.value })} />
                  </label>
                  <label>
                    <span>Display Name</span>
                    <input value={draft.name} onChange={(e) => syncDraft({ ...draft, name: e.target.value })} />
                  </label>
                  <label>
                    <span>Domain</span>
                    <select value={draft.domain} onChange={(e) => syncDraft({ ...draft, domain: e.target.value as WorkflowDefinition["domain"] })}>
                      <option value="wealth">Wealth</option>
                      <option value="operations">Operations / SRE</option>
                      <option value="sales">Sales / RevOps</option>
                      <option value="general">General</option>
                    </select>
                  </label>
                  <label>
                    <span>Version</span>
                    <input value={draft.version ?? "1.0.0"} onChange={(e) => syncDraft({ ...draft, version: e.target.value })} />
                  </label>
                </div>

                <label className="wf-wide-field">
                  <span>Trigger Phrases (comma-separated — matched automatically in Chat &amp; Embed SDK)</span>
                  <input
                    value={draft.triggerPhrases.join(", ")}
                    onChange={(e) => syncDraft({
                      ...draft,
                      triggerPhrases: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                    })}
                  />
                </label>

                <label className="wf-wide-field">
                  <span>Description</span>
                  <input value={draft.description} onChange={(e) => syncDraft({ ...draft, description: e.target.value })} />
                </label>

                <div className="wf-steps-header">
                  <h3>Workflow Steps ({draft.steps.length})</h3>
                  <div className="wf-add-step-bar">
                    {(["collect_input", "compute", "hitl_approval", "connector_call", "integration_task", "async_job", "emit_host_event"] as const).map((st) => (
                      <button key={st} type="button" className="reg-mini-btn" onClick={() => addStep(st)}>
                        + {st.replace("_", " ")}
                      </button>
                    ))}
                  </div>
                </div>

                <ol className="wf-def-step-list">
                  {draft.steps.map((step, idx) => (
                    <li key={`${step.id}-${idx}`} className="wf-def-step-card">
                      <div className="wf-def-step-top">
                        <span className="wf-step-num">{idx + 1}</span>
                        <input
                          className="wf-step-title-input"
                          value={step.title}
                          onChange={(e) => {
                            const nextSteps = draft.steps.map((s, i) => (i === idx ? { ...s, title: e.target.value } : s));
                            syncDraft({ ...draft, steps: nextSteps });
                          }}
                        />
                        <span className="wf-step-type">{step.type}</span>
                        {step.when && (
                          <span className="wf-when-pill">
                            when {step.when.field} {step.when.op} {step.when.value !== undefined ? String(step.when.value) : ""}
                          </span>
                        )}
                        <button type="button" className="wf-icon-del" onClick={() => removeStep(idx)} title="Remove step">
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </div>
                      <div className="wf-def-step-detail">
                        {step.type === "collect_input" && (
                          <span>Fields: {step.fields.map((f) => `${f.id} (${f.type})`).join(", ")}</span>
                        )}
                        {step.type === "compute" && (
                          <span>Evaluator: <code>{step.evaluator}</code> · Output: {step.outputTemplate}</span>
                        )}
                        {step.type === "hitl_approval" && (
                          <span>Risk: <strong>{step.riskLevel}</strong> · {step.dualControl ? "4-Eyes Dual Control" : "Inline Approval"} · {step.approvalTitleTemplate}</span>
                        )}
                        {step.type === "integration_task" && (
                          <span>Governed Task: <code>{step.toolRef}</code>{step.outputPrefix ? ` · output prefix: ${step.outputPrefix}` : ""}</span>
                        )}
                        {step.type === "connector_call" && (
                          <span>Connector: <code>{step.connectorId}</code> · Action: <code>{step.action}</code></span>
                        )}
                        {step.type === "async_job" && (
                          <span>Timer: <strong>{step.durationSeconds}s</strong> · Cancellable: {step.cancellable ? "Yes" : "No"}</span>
                        )}
                        {step.type === "emit_host_event" && (
                          <span>Host Event: <code>{step.eventName}</code></span>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
