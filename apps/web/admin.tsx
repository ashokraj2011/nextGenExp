import { CapabilityStudio } from "./capability-studio";
import "./agentic.css";
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, FlaskConical, MessageSquare, Trash2 } from "lucide-react";
import {
  defaultAgentFundingWorkflow, defaultFundingWorkflow, fundingAgentToolLimit, fundingToolKey, fundingToolKeys,
  fundingToolRef, fundingTools, fundingWorkflowIssue,
  type FundingStepRef, type FundingWorkflowDefinition,
} from "../../packages/contracts/funding-workflow";
import {
  MAX_CCRE_RULES, sfieldTools, toolKeys, toolVersion, treatmentOverride,
  type MockCcreRule, type MockOutput, type ToolSetup, type ToolSetupView, type TreatmentPreview, type TreatmentPreviewInput,
} from "../../packages/contracts/tool-setup";
import { api, toolSetupErrorMessage as messageFor } from "./api";
import { CcreRuleEditor } from "./ccre-rule-editor";
import { rememberActiveConversation } from "./conversation-storage";
import { adminPaths } from "../../packages/contracts/admin-paths";
import { TreatmentPreviewResult } from "./treatment-preview";
import "./admin.css";

function RankedList<Id extends string>({ ids, label, titleFor, change }: {
  ids: Id[]; label: string; titleFor: (id: Id) => string; change: (ids: Id[]) => void;
}) {
  function move(index: number, destination: number) {
    const next = [...ids];
    [next[index], next[destination]] = [next[destination], next[index]];
    change(next);
  }

  return <ol className="rank-list" aria-label={label}>
    {ids.map((id, index) => <li key={id}>
      <span className="rank-number" aria-hidden="true">{index + 1}</span>
      <span className="rank-item"><strong>{titleFor(id)}</strong><code>{id}</code></span>
      <span className="rank-actions">
        <button type="button" className="icon-button" aria-label={"Move " + id + " up"} disabled={index === 0}
          onClick={() => move(index, index - 1)}><ArrowUp size={16} /></button>
        <button type="button" className="icon-button" aria-label={"Move " + id + " down"} disabled={index === ids.length - 1}
          onClick={() => move(index, index + 1)}><ArrowDown size={16} /></button>
        <button type="button" className="icon-button" aria-label={"Remove " + id} onClick={() => change(ids.filter((value) => value !== id))}><Trash2 size={16} /></button>
      </span>
    </li>)}
  </ol>;
}

function RankedContent({ ids, content, change }: {
  ids: string[]; content: ToolSetupView["content"]; change: (ids: string[]) => void;
}) {
  const choices = content.filter(({ contentId }) => !ids.includes(contentId));
  return <div className="rank-editor">
    <div className="setup-field">
      <label htmlFor="mock-content">Add content</label>
      <select id="mock-content" value="" disabled={!choices.length} onChange={(event) => change([...ids, event.target.value])}>
        <option value="" disabled>{choices.length ? "Choose a demo item" : "All demo items added"}</option>
        {choices.map(({ contentId, title }) => <option key={contentId} value={contentId}>{title}</option>)}
      </select>
    </div>
    {ids.length ? <RankedList ids={ids} label="Content order" change={change}
      titleFor={(id) => content.find(({ contentId }) => contentId === id)?.title ?? id} />
      : <p className="admin-muted">Add at least one item, or choose Return no content.</p>}
  </div>;
}

function FundingWorkflowEditor({ definition, issue, change }: {
  definition: FundingWorkflowDefinition; issue?: string; change: (definition: FundingWorkflowDefinition) => void;
}) {
  const { id, version, steps } = definition;
  const guided = definition.mode === "agent";
  const choices = fundingToolKeys.filter((key) => !steps.includes(fundingToolRef(key)));
  function setSteps(next: FundingStepRef[]) {
    change({ ...definition, steps: next });
  }
  function add(ref: string) {
    const key = choices.find((item) => fundingToolRef(item) === ref);
    if (!key) return;
    const next = [...steps];
    const previewIndex = next.indexOf(fundingToolRef("fundingPreview"));
    next.splice(previewIndex < 0 || key === "fundingPreview" ? next.length : previewIndex, 0, fundingToolRef(key));
    setSteps(next);
  }

  return <section className="admin-card" aria-labelledby="funding-workflow-title">
    <h2 id="funding-workflow-title">Funding preview workflow</h2>
    <p className="admin-workflow-ref"><code>{id}@{version}</code></p>
    <div className="setup-field">
      <label htmlFor="funding-workflow-mode">How to run funding preview</label>
      <select id="funding-workflow-mode" value={guided ? "agent" : "ordered"} onChange={(event) => (
        change(event.target.value === "agent" ? defaultAgentFundingWorkflow : defaultFundingWorkflow)
      )}>
        <option value="agent">Agent-guided</option>
        <option value="ordered">Saved tool order</option>
      </select>
    </div>
    {guided ? <div className="rank-editor">
      <div className="setup-field">
        <label htmlFor="funding-workflow-goal">Goal</label>
        <input id="funding-workflow-goal" maxLength={320} value={definition.goal ?? defaultAgentFundingWorkflow.goal}
          onChange={(event) => change({ ...definition, goal: event.target.value })} />
      </div>
      <div className="setup-field">
        <label htmlFor="funding-workflow-limit">Tool call limit</label>
        <input id="funding-workflow-limit" type="number" min={4} max={fundingAgentToolLimit}
          value={definition.maxToolCalls ?? defaultAgentFundingWorkflow.maxToolCalls}
          onChange={(event) => change({ ...definition, maxToolCalls: event.target.valueAsNumber || undefined })} />
      </div>
      <p>Check funding status and Funding options are required before the agent offers a method.</p>
      <label className="admin-tool">
        <strong>Allow building a funding preview</strong>
        <input type="checkbox" role="switch" checked={steps.includes(fundingToolRef("fundingPreview"))}
          onChange={(event) => setSteps(event.target.checked ? [...steps, fundingToolRef("fundingPreview")]
            : steps.filter((ref) => ref !== fundingToolRef("fundingPreview")))} />
      </label>
      {issue && <p className="admin-error" role="status">{issue}</p>}
    </div> : <div className="rank-editor">
      <RankedList ids={steps} label="Funding workflow tool order" change={setSteps} titleFor={(ref) => {
        const key = fundingToolKey(ref);
        return key ? fundingTools[key].label : ref;
      }} />
      <div className="setup-field">
        <label htmlFor="funding-workflow-tool">Add workflow tool</label>
        <select id="funding-workflow-tool" value="" disabled={!choices.length} onChange={(event) => add(event.target.value)}>
          <option value="" disabled>{choices.length ? "Choose a tool" : "All workflow tools added"}</option>
          {choices.map((key) => <option key={key} value={fundingToolRef(key)}>{fundingTools[key].label}</option>)}
        </select>
      </div>
      {issue ? <p className="admin-error" role="status">{issue}</p>
        : <p>Build funding preview uses the funding options and runs last.</p>}
    </div>}
  </section>;
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
  const fundingWorkflow = setup.fundingWorkflow ?? defaultAgentFundingWorkflow;
  const workflowIssue = fundingWorkflowIssue(fundingWorkflow);
  const invalidDraft = incompleteRankedResponse || Boolean(workflowIssue);
  const saveHint = workflowIssue ? "Fix the funding workflow before saving."
    : incompleteRankedResponse ? "Add at least one item to each custom response before saving."
    : dirty ? "Unsaved changes" : "";
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
    if (invalidDraft || saving) return false;
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
      const conversation = await api.newAdminConversation(personaId, scenarioId);
      rememberActiveConversation(conversation.id, true);
      location.assign(adminPaths.chat);
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
        <p role="status">{saveNotice || saveHint}</p>
        <button className="send-button" type="submit" disabled={!dirty || invalidDraft || saving || startingChat}>{saving ? "Saving…" : "Save settings"}</button>
      </div>
      {saveError && <p className="admin-error" role="alert">{saveError}</p>}
    </div>
    <fieldset className="admin-layout" disabled={saving || startingChat}>
      <div className="admin-tool-sections">
        <FundingWorkflowEditor definition={fundingWorkflow} issue={workflowIssue}
          change={(definition) => edit({ ...setup, fundingWorkflow: definition })} />
        <section className="admin-card" aria-labelledby="sfield-tools-title">
          <h2 id="sfield-tools-title">sfield tools</h2>
          <p>Turn tools on or off.</p>
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
      </div>

      <section className="admin-card" aria-labelledby="treatment-mock-title">
        <h2 id="treatment-mock-title">Treatment Selector test settings</h2>
        <p>Choose what Treatment Selector returns for a topic and test case.</p>
        <div className="admin-fields">
          <div className="setup-field">
            <label htmlFor="mock-scenario">Test case</label>
            <select id="mock-scenario" value={scenarioId} onChange={(event) => setScenario(event.target.value)}>
              {data.scenarios.map(({ scenarioId, label }) => <option key={scenarioId} value={scenarioId}>{label}</option>)}
            </select>
          </div>
          <div className="setup-field">
            <label htmlFor="mock-context">Topic</label>
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
              <option value="fixture">Default response</option>
              <option value="ranked">Choose content order</option>
              <option value="empty">Return no content</option>
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
          <p>See what Treatment Selector would return before trying it in chat.</p>
          <div className="admin-preview-fields">
            <div className="setup-field">
              <label htmlFor="mock-persona">Demo profile</label>
              <select id="mock-persona" value={personaId ?? ""} onChange={(event) => setPreviewPersona(event.target.value)}>
                {personas.map((persona) => <option key={persona.personaId} value={persona.personaId}>{persona.displayName}</option>)}
              </select>
            </div>
            <div className="setup-field">
              <label htmlFor="mock-turn">Message number</label>
              <input id="mock-turn" type="number" min={1} step={1} value={ordinal} onChange={(event) => setOrdinal(event.target.value)} />
            </div>
          </div>
          <div className="admin-preview-actions">
            <button type="button" className="secondary-button" disabled={!canPreview || previewing} onClick={() => void runPreview()}>
              <FlaskConical size={16} aria-hidden="true" />{previewing ? "Testing…" : "Run preview"}
            </button>
            <button type="button" className="secondary-button" disabled={!personaId || invalidDraft || startingChat}
              aria-describedby="test-chat-note" onClick={() => void testInChat()}>
              <MessageSquare size={16} aria-hidden="true" />{startingChat ? "Opening chat…" : dirty ? "Save and test in chat" : "Test in chat"}
            </button>
          </div>
          <p id="test-chat-note" className="admin-test-note">Test in chat opens a new chat with this profile and test case.</p>
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
    let mounted = true;
    void api.toolSetup().then((setup) => { if (mounted) setLoaded(setup); })
      .catch((error: unknown) => { if (mounted) setError(messageFor(error)); });
    return () => { mounted = false; };
  }, []);

  return <div className="admin-page">
    <main className="admin-main">
      {loaded ? <ToolSetupForm {...loaded} /> : <div className="admin-heading">
        <h1>Tool setup</h1>
        {error ? <p role="alert">{error}</p> : <p role="status">Loading tool settings…</p>}
      </div>}
      {loaded && <CapabilityStudio />}
    </main>
  </div>;
}
