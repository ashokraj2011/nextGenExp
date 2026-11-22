import { useEffect, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, FlaskConical, MessageSquare, Trash2 } from "lucide-react";
import {
  MAX_CCRE_RULES, sfieldTools, toolKeys, toolVersion, treatmentOverride,
  type MockCcreRule, type MockOutput, type ToolSetup, type ToolSetupView, type TreatmentPreview, type TreatmentPreviewInput,
} from "../../packages/contracts/tool-setup";
import { api, toolSetupErrorMessage as messageFor } from "./api";
import { CcreRuleEditor } from "./ccre-rule-editor";
import { rememberActiveConversation } from "./conversation-storage";
import { TreatmentPreviewResult } from "./treatment-preview";
import "./admin.css";

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
    <div className="setup-field">
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

function ToolSetupForm({ data, revision }: { data: ToolSetupView; revision?: string }) {
  const [saved, setSaved] = useState({ setup: data.setup, revision });
  const [setup, setSetup] = useState(data.setup);
  const [scenarioId, setScenario] = useState(data.defaultScenarioId);
  const [contextId, setContext] = useState(data.contexts[0].contextId);
  const [previewPersona, setPreviewPersona] = useState(data.defaultPersonaId);
  const [ordinal, setOrdinal] = useState("1");
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [startingChat, setStartingChat] = useState(false);
  const [saveNotice, setSaveNotice] = useState("");
  const [saveError, setSaveError] = useState("");
  const [chatError, setChatError] = useState("");
  const [preview, setPreview] = useState<{ key: string; result: TreatmentPreview } | { key: string; error: string }>();
  const personas = data.personas.filter((persona) => persona.allowedScenarios.includes(scenarioId));
  const personaId = personas.some((entry) => entry.personaId === previewPersona) ? previewPersona : personas[0]?.personaId;
  const rule = treatmentOverride(setup.treatmentOverrides, scenarioId, contextId);
  const output = rule?.output ?? null;
  const allCcreRules = setup.ccreRules ?? [];
  const inSelectedScope = (entry: MockCcreRule) => entry.scenarioId === scenarioId && entry.contextId === contextId;
  const ccreRules = allCcreRules.filter(inSelectedScope);
  const dirty = JSON.stringify(saved.setup) !== JSON.stringify(setup);
  const incompleteRankedResponse = setup.treatmentOverrides.some(({ output }) => output.mode === "ranked" && !output.contentIds.length);
  const previewInput: TreatmentPreviewInput = {
    personaId, scenarioId, contextId, ordinal: Number(ordinal), enabled: setup.enabled.selection, output, ccreRules,
  };
  const previewKey = JSON.stringify(previewInput);
  const previewResult = preview?.key === previewKey ? preview : undefined;
  const canPreview = personaId && Number.isSafeInteger(previewInput.ordinal) && previewInput.ordinal > 0
    && (output?.mode !== "ranked" || output.contentIds.length > 0);

  function edit(next: ToolSetup) {
    setSetup(next);
    setSaveNotice("");
    setSaveError("");
    setChatError("");
  }
  function changeOutput(next: MockOutput | null) {
    const remaining = setup.treatmentOverrides.filter((entry) => entry !== rule);
    edit({ ...setup, treatmentOverrides: next ? [...remaining, { scenarioId, contextId, output: next }] : remaining });
  }
  async function save() {
    if (incompleteRankedResponse || saving) return false;
    if (!dirty) return true;
    setSaving(true);
    setSaveError("");
    try {
      const { data: persisted, revision: updatedRevision } = await api.saveToolSetup(setup, saved.revision);
      setSaved({ setup: persisted, revision: updatedRevision });
      setSetup(persisted);
      setSaveNotice("Tool settings saved.");
      return true;
    } catch (error) {
      setSaveError(messageFor(error));
      return false;
    } finally {
      setSaving(false);
    }
  }
  async function testInChat() {
    if (!personaId || startingChat) return;
    setStartingChat(true);
    setChatError("");
    try {
      if (!await save()) {
        setChatError("Save the settings before starting a test chat.");
        return;
      }
      const conversation = await api.newConversation(personaId, scenarioId);
      rememberActiveConversation(conversation.id);
      location.assign("/chat");
    } catch (error) {
      setChatError(messageFor(error));
    } finally {
      setStartingChat(false);
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
        <p role="status">{saveNotice || (incompleteRankedResponse ? "Add content to each ranked response before saving." : dirty ? "Unsaved changes" : "")}</p>
        <button className="send-button" type="submit" disabled={!dirty || incompleteRankedResponse || saving || startingChat}>{saving ? "Saving…" : "Save settings"}</button>
      </div>
      {saveError && <p className="admin-error" role="alert">{saveError}</p>}
    </div>
    <fieldset className="admin-layout" disabled={saving || startingChat}>
      <section className="admin-card" aria-labelledby="sfield-tools-title">
        <h2 id="sfield-tools-title">sfield tools</h2>
        <p>Control which registered tools can run.</p>
        <ul className="admin-tools">
          {toolKeys.map((key) => {
            const tool = sfieldTools[key];
            return <li key={key}>
              <label className="admin-tool">
                <span><strong>{tool.label}</strong><code>{tool.id}@{toolVersion}</code><small>{tool.description}</small></span>
                <input type="checkbox" role="switch" aria-label={tool.label} checked={setup.enabled[key] !== false}
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
          <div className="setup-field">
            <label htmlFor="mock-scenario">Scenario</label>
            <select id="mock-scenario" value={scenarioId} onChange={(event) => setScenario(event.target.value)}>
              {data.scenarios.map(({ scenarioId, label }) => <option key={scenarioId} value={scenarioId}>{label}</option>)}
            </select>
          </div>
          <div className="setup-field">
            <label htmlFor="mock-context">Context</label>
            <select id="mock-context" value={contextId} onChange={(event) => setContext(event.target.value)}>
              {data.contexts.map(({ contextId, displayName }) => <option key={contextId} value={contextId}>{displayName}</option>)}
            </select>
          </div>
          <div className="setup-field">
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

        <CcreRuleEditor key={scenarioId + "/" + contextId} scope={{ scenarioId, contextId }}
          rules={ccreRules} personas={personas} content={data.content} glossary={data.glossary} limitReached={allCcreRules.length >= MAX_CCRE_RULES}
          change={(next) => edit({ ...setup, ccreRules: [...allCcreRules.filter((entry) => !inSelectedScope(entry)), ...next] })} />

        <div className="admin-preview">
          <h3>Preview response</h3>
          <p>Test the current settings without an LLM gateway.</p>
          <div className="admin-preview-fields">
            <div className="setup-field">
              <label htmlFor="mock-persona">Demo persona</label>
              <select id="mock-persona" value={personaId ?? ""} onChange={(event) => setPreviewPersona(event.target.value)}>
                {personas.map((persona) => <option key={persona.personaId} value={persona.personaId}>{persona.displayName}</option>)}
              </select>
            </div>
            <div className="setup-field">
              <label htmlFor="mock-turn">Turn number</label>
              <input id="mock-turn" type="number" min={1} step={1} value={ordinal} onChange={(event) => setOrdinal(event.target.value)} />
            </div>
          </div>
          <div className="admin-preview-actions">
            <button type="button" className="secondary-button" disabled={!canPreview || previewing} onClick={() => void runPreview()}>
              <FlaskConical size={16} aria-hidden="true" />{previewing ? "Testing…" : "Run preview"}
            </button>
            <button type="button" className="secondary-button" disabled={!personaId || incompleteRankedResponse || startingChat}
              aria-describedby="test-chat-note" onClick={() => void testInChat()}>
              <MessageSquare size={16} aria-hidden="true" />{startingChat ? "Opening chat…" : dirty ? "Save and test in chat" : "Test in chat"}
            </button>
          </div>
          <p id="test-chat-note" className="admin-test-note">Test in chat starts a new conversation at turn 1 with the selected persona and scenario.</p>
          {chatError && <p className="admin-error" role="alert">{chatError}</p>}
          {previewResult && ("error" in previewResult
            ? <p className="admin-error" role="alert">{previewResult.error}</p>
            : <TreatmentPreviewResult result={previewResult.result} />)}
        </div>
      </section>
    </fieldset>
  </form>;
}

export function AdminPage() {
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof api.toolSetup>>>();
  const [error, setError] = useState("");
  useEffect(() => {
    document.title = "Tool setup · Financial planning";
    let mounted = true;
    void api.toolSetup().then((setup) => { if (mounted) setLoaded(setup); })
      .catch((error: unknown) => { if (mounted) setError(messageFor(error)); });
    return () => { mounted = false; };
  }, []);

  return <div className="admin-page">
    <header className="admin-bar"><div>
      <span>Financial planning</span>
      <a className="icon-button" href="/chat"><ArrowLeft size={16} aria-hidden="true" />Back to chat</a>
    </div></header>
    <main className="admin-main">
      {loaded ? <ToolSetupForm {...loaded} /> : <div className="admin-heading">
        <h1>Tool setup</h1>
        {error ? <p role="alert">{error}</p> : <p role="status">Loading tool settings…</p>}
      </div>}
    </main>
  </div>;
}
