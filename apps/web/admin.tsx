import { useEffect, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, FlaskConical, Trash2 } from "lucide-react";
import {
  sfieldTools, toolKeys, toolVersion, treatmentOverride,
  type MockOutput, type ToolSetup, type ToolSetupView, type TreatmentPreview, type TreatmentPreviewInput,
} from "../../packages/contracts/tool-setup";
import { api, RequestError } from "./api";
import "./admin.css";

function messageFor(error: unknown) {
  return error instanceof RequestError ? error.message : "Couldn’t reach the local server. Try again.";
}

function RankedContent({ ids, content, change }: {
  ids: string[]; content: ToolSetupView["content"]; change: (ids: string[]) => void;
}) {
  const choices = content.filter(({ contentId }) => !ids.includes(contentId));
  function move(index: number, destination: number) {
    const next = [...ids];
    [next[index], next[destination]] = [next[destination], next[index]];
    change(next);
  }

  return <div className="rank-editor">
    <div className="admin-field">
      <label htmlFor="mock-content">Add eligible content</label>
      <select id="mock-content" value="" disabled={!choices.length} onChange={(event) => change([...ids, event.target.value])}>
        <option value="" disabled>{choices.length ? "Choose a demo item" : "All demo items added"}</option>
        {choices.map(({ contentId, title }) => <option key={contentId} value={contentId}>{title}</option>)}
      </select>
    </div>
    {ids.length ? <ol className="rank-list" aria-label="Ranked content">
      {ids.map((id, index) => <li key={id}>
        <span className="rank-number" aria-hidden="true">{index + 1}</span>
        <span className="rank-item"><strong>{content.find(({ contentId }) => contentId === id)?.title ?? id}</strong><code>{id}</code></span>
        <span className="rank-actions">
          <button type="button" className="icon-button" aria-label={"Move " + id + " up"} disabled={index === 0}
            onClick={() => move(index, index - 1)}><ArrowUp size={16} /></button>
          <button type="button" className="icon-button" aria-label={"Move " + id + " down"} disabled={index === ids.length - 1}
            onClick={() => move(index, index + 1)}><ArrowDown size={16} /></button>
          <button type="button" className="icon-button" aria-label={"Remove " + id} onClick={() => change(ids.filter((value) => value !== id))}><Trash2 size={16} /></button>
        </span>
      </li>)}
    </ol> : <p className="admin-muted">Add at least one item, or choose Empty result.</p>}
  </div>;
}

function PreviewResult({ result }: { result: TreatmentPreview }) {
  if (result.status === "disabled") return <p>Treatment Selector is disabled in this setup.</p>;
  const source = result.source === "override" ? "Configured response" : "Built-in fixture";
  return <>
    <strong>{result.status === "timeout" ? "Simulated timeout" : result.status === "empty" ? "No eligible content" : "Ranked eligible content"}</strong>
    <p>{source}</p>
    {result.status === "ranked" && <ol>{result.contentIds.map((id) => <li key={id}><code>{id}</code></li>)}</ol>}
  </>;
}

function ToolSetupForm({ data }: { data: ToolSetupView }) {
  const [saved, setSaved] = useState(data.setup);
  const [setup, setSetup] = useState(data.setup);
  const [scenarioId, setScenario] = useState(data.defaultScenarioId);
  const [contextId, setContext] = useState(data.contexts[0].contextId);
  const [previewPersona, setPreviewPersona] = useState(data.defaultPersonaId);
  const [ordinal, setOrdinal] = useState("1");
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [saveNotice, setSaveNotice] = useState("");
  const [saveError, setSaveError] = useState("");
  const [preview, setPreview] = useState<{ key: string; result: TreatmentPreview } | { key: string; error: string }>();
  const personas = data.personas.filter((persona) => persona.allowedScenarios.includes(scenarioId));
  const personaId = personas.some((entry) => entry.personaId === previewPersona) ? previewPersona : personas[0]?.personaId;
  const rule = treatmentOverride(setup.treatmentOverrides, scenarioId, contextId);
  const output = rule?.output ?? null;
  const dirty = JSON.stringify(saved) !== JSON.stringify(setup);
  const incompleteRule = setup.treatmentOverrides.some(({ output }) => output.mode === "ranked" && !output.contentIds.length);
  const previewInput: TreatmentPreviewInput = {
    personaId, scenarioId, contextId, ordinal: Number(ordinal), enabled: setup.enabled.selection, output,
  };
  const previewKey = JSON.stringify(previewInput);
  const previewResult = preview?.key === previewKey ? preview : undefined;
  const canPreview = personaId && Number.isSafeInteger(previewInput.ordinal) && previewInput.ordinal > 0
    && (output?.mode !== "ranked" || output.contentIds.length > 0);

  function edit(next: ToolSetup) {
    setSetup(next);
    setSaveNotice("");
    setSaveError("");
  }
  function changeOutput(next: MockOutput | null) {
    const remaining = setup.treatmentOverrides.filter((entry) => entry !== rule);
    edit({ ...setup, treatmentOverrides: next ? [...remaining, { scenarioId, contextId, output: next }] : remaining });
  }
  async function save() {
    if (!dirty || incompleteRule || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      const persisted = await api.saveToolSetup(setup);
      setSaved(persisted);
      setSetup(persisted);
      setSaveNotice("Tool settings saved.");
    } catch (error) {
      setSaveError(messageFor(error));
    } finally {
      setSaving(false);
    }
  }
  async function runPreview() {
    if (!canPreview || previewing) return;
    setPreviewing(true);
    setPreview(undefined);
    try {
      setPreview({ key: previewKey, result: await api.previewTreatmentSelector(previewInput) });
    } catch (error) {
      setPreview({ key: previewKey, error: messageFor(error) });
    } finally {
      setPreviewing(false);
    }
  }

  return <form noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <div className="admin-heading">
      <div>
        <h1>Tool setup</h1>
        <p>Saved settings apply to new chat requests in this browser.</p>
      </div>
      <div className="admin-save">
        <p role="status">{saveNotice || (incompleteRule ? "Add content to each ranked response before saving." : dirty ? "Unsaved changes" : "")}</p>
        <button className="send-button" type="submit" disabled={!dirty || incompleteRule || saving}>{saving ? "Saving…" : "Save settings"}</button>
      </div>
      {saveError && <p className="admin-error" role="alert">{saveError}</p>}
    </div>
    <fieldset className="admin-layout" disabled={saving}>
      <section className="admin-card" aria-labelledby="sfield-tools-title">
        <h2 id="sfield-tools-title">sfield tools</h2>
        <p>Control which registered tools can run.</p>
        <ul className="admin-tools">
          {toolKeys.map((key) => {
            const tool = sfieldTools[key];
            return <li key={key}>
              <label className="admin-tool">
                <span><strong>{tool.label}</strong><code>{tool.id}@{toolVersion}</code><small>{tool.description}</small></span>
                <input type="checkbox" role="switch" aria-label={tool.label} checked={setup.enabled[key]}
                  onChange={(event) => edit({ ...setup, enabled: { ...setup.enabled, [key]: event.target.checked } })} />
              </label>
            </li>;
          })}
        </ul>
      </section>

      <section className="admin-card" aria-labelledby="treatment-mock-title">
        <h2 id="treatment-mock-title">Treatment Selector mock</h2>
        <p>Set the eligible response for a scenario and context.</p>
        <div className="admin-fields">
          <div className="admin-field">
            <label htmlFor="mock-scenario">Scenario</label>
            <select id="mock-scenario" value={scenarioId} onChange={(event) => setScenario(event.target.value)}>
              {data.scenarios.map(({ scenarioId, label }) => <option key={scenarioId} value={scenarioId}>{label}</option>)}
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="mock-context">Context</label>
            <select id="mock-context" value={contextId} onChange={(event) => setContext(event.target.value)}>
              {data.contexts.map(({ contextId, displayName }) => <option key={contextId} value={contextId}>{displayName}</option>)}
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="mock-response">Response</label>
            <select id="mock-response" value={output?.mode ?? "fixture"} onChange={(event) => {
              const mode = event.target.value;
              if (mode === "ranked") changeOutput({ mode, contentIds: [] });
              else if (mode === "empty" || mode === "timeout") changeOutput({ mode });
              else changeOutput(null);
            }}>
              <option value="fixture">Built-in fixture</option>
              <option value="ranked">Ranked content</option>
              <option value="empty">Empty result</option>
              <option value="timeout">Simulate timeout</option>
            </select>
          </div>
        </div>
        {output?.mode === "ranked" && <RankedContent ids={output.contentIds} content={data.content}
          change={(contentIds) => changeOutput({ mode: "ranked", contentIds })} />}

        <div className="admin-preview">
          <h3>Preview response</h3>
          <p>Test the current settings without an LLM gateway.</p>
          <div className="admin-preview-fields">
            <div className="admin-field">
              <label htmlFor="mock-persona">Demo persona</label>
              <select id="mock-persona" value={personaId ?? ""} onChange={(event) => setPreviewPersona(event.target.value)}>
                {personas.map((persona) => <option key={persona.personaId} value={persona.personaId}>{persona.displayName}</option>)}
              </select>
            </div>
            <div className="admin-field">
              <label htmlFor="mock-turn">Turn number</label>
              <input id="mock-turn" type="number" min={1} step={1} value={ordinal} onChange={(event) => setOrdinal(event.target.value)} />
            </div>
            <button type="button" className="secondary-button" disabled={!canPreview || previewing} onClick={() => void runPreview()}>
              <FlaskConical size={16} aria-hidden="true" />{previewing ? "Testing…" : "Run preview"}
            </button>
          </div>
          {previewResult && ("error" in previewResult
            ? <p className="admin-error" role="alert">{previewResult.error}</p>
            : <div className="admin-result" role="status"><PreviewResult result={previewResult.result} /></div>)}
        </div>
      </section>
    </fieldset>
  </form>;
}

export function AdminPage() {
  const [data, setData] = useState<ToolSetupView>();
  const [error, setError] = useState("");
  useEffect(() => {
    document.title = "Tool setup · PZN Lab";
    let mounted = true;
    void api.toolSetup().then((setup) => { if (mounted) setData(setup); })
      .catch((error: unknown) => { if (mounted) setError(messageFor(error)); });
    return () => { mounted = false; };
  }, []);

  return <div className="admin-page">
    <header className="admin-bar"><div>
      <span>PZN Lab</span>
      <a className="icon-button" href="/"><ArrowLeft size={16} aria-hidden="true" />Back to chat</a>
    </div></header>
    <main className="admin-main">
      {data ? <ToolSetupForm data={data} /> : <div className="admin-heading">
        <h1>Tool setup</h1>
        {error ? <p role="alert">{error}</p> : <p role="status">Loading tool settings…</p>}
      </div>}
    </main>
  </div>;
}
