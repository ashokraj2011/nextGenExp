import { CapabilityStudio } from "./capability-studio";
import "./agentic.css";
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, FlaskConical, Layers, MessageSquare, Plug, Plus, Trash2 } from "lucide-react";
import type { RecommendationProviderDescriptor } from "../../packages/contracts/recommendation-provider";
import type { ConnectorKind, ConnectorTestResult, ExternalConnector } from "../../packages/contracts/connector";
import type { RecommendationDomain } from "../../packages/contracts/recommendation-provider";
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

function RecommendationProvidersCard() {
  const [info, setInfo] = useState<{ toolRef: string; providers: RecommendationProviderDescriptor[] } | null>(null);
  useEffect(() => {
    let mounted = true;
    void api.recommendationProviders()
      .then((res) => { if (mounted) setInfo(res); })
      .catch(() => undefined);
    return () => { mounted = false; };
  }, []);
  if (!info || info.providers.length === 0) return null;
  return (
    <section className="admin-card" aria-labelledby="rec-providers-title" style={{ marginTop: "18px" }}>
      <h2 id="rec-providers-title" style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
        <Layers size={18} aria-hidden="true" />
        Recommendation Providers (sfield)
      </h2>
      <p>
        Pluggable domain engines registered behind the host-governed arbitrator tool <code>{info.toolRef}</code>.
        Add new domain or vendor adapters via <code>RecommendationProvider</code> without modifying LLM prompts.
      </p>
      <ul className="admin-tools" style={{ marginTop: "12px" }}>
        {info.providers.map((provider) => (
          <li key={provider.id}>
            <div className="admin-tool" style={{ cursor: "default" }}>
              <span>
                <strong>{provider.label}</strong>
                <code>{provider.id} · domains: {provider.domains.join(", ")}</code>
                <small>{provider.description}</small>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ExternalConnectorsCard({ onUpdated }: { onUpdated: () => void }) {
  const [connectors, setConnectors] = useState<ExternalConnector[]>([]);
  const [draftOpen, setDraftOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ConnectorKind>("rest_recommendation");
  const [url, setUrl] = useState("");
  const [domain, setDomain] = useState<RecommendationDomain>("operations");
  const [description, setDescription] = useState("");
  const [testResults, setTestResults] = useState<Record<string, ConnectorTestResult>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void api.connectors().then((res) => { if (active) setConnectors(res.connectors); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  async function toggleEnabled(conn: ExternalConnector) {
    setBusyId(conn.id);
    setError("");
    try {
      const res = await api.saveConnector({ ...conn, enabled: !conn.enabled });
      setConnectors(res.connectors);
      onUpdated();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusyId(null);
    }
  }

  async function testConn(id: string) {
    setBusyId(id);
    try {
      const result = await api.testConnector(id);
      setTestResults((prev) => ({ ...prev, [id]: result }));
    } finally {
      setBusyId(null);
    }
  }

  async function removeConn(id: string) {
    setBusyId(id);
    try {
      const res = await api.deleteConnector(id);
      setConnectors(res.connectors);
      onUpdated();
    } finally {
      setBusyId(null);
    }
  }

  async function createConnector(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !url.trim()) {
      setError("Connector name and valid URL are required.");
      return;
    }
    setBusyId("new");
    setError("");
    try {
      const res = await api.saveConnector({
        name: name.trim(),
        kind,
        url: url.trim(),
        method: "POST",
        domains: [domain],
        enabled: true,
        timeoutMs: 3000,
        description: description.trim() || `External ${kind} connector`,
      });
      setConnectors(res.connectors);
      setName("");
      setUrl("");
      setDescription("");
      setDraftOpen(false);
      onUpdated();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="admin-card" aria-labelledby="ext-connectors-title" style={{ marginTop: "18px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <div>
          <h2 id="ext-connectors-title" style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <Plug size={18} aria-hidden="true" />
            External REST &amp; MCP Connector Registry
          </h2>
          <p>
            Plug in external decisioning engines (Pega CDH, Adobe, ServiceNow, PagerDuty, Salesforce, or MCP bridges) with zero code.
            Enabled connectors mount live into <code>cep.recommendations.arbitrate@1.0.0</code>.
          </p>
        </div>
        <button type="button" className="secondary-button" onClick={() => setDraftOpen((v) => !v)}>
          <Plus size={15} aria-hidden="true" />{draftOpen ? "Cancel" : "Add connector"}
        </button>
      </div>
      {error && <p className="admin-error" role="alert" style={{ marginTop: "10px" }}>{error}</p>}
      {draftOpen && (
        <form className="admin-rule-draft" onSubmit={(e) => void createConnector(e)}>
          <div className="admin-fields">
            <div className="setup-field">
              <label htmlFor="conn-name">Connector name</label>
              <input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Salesforce Deal Ranker" required />
            </div>
            <div className="setup-field">
              <label htmlFor="conn-kind">Type</label>
              <select id="conn-kind" value={kind} onChange={(e) => setKind(e.target.value as ConnectorKind)}>
                <option value="rest_recommendation">REST Recommendation Provider</option>
                <option value="mcp_bridge">MCP Bridge</option>
                <option value="rest_data">REST Data Source</option>
              </select>
            </div>
            <div className="setup-field">
              <label htmlFor="conn-domain">Domain</label>
              <select id="conn-domain" value={domain} onChange={(e) => setDomain(e.target.value as RecommendationDomain)}>
                <option value="wealth">wealth</option>
                <option value="operations">operations</option>
                <option value="sales">sales</option>
                <option value="general">general</option>
              </select>
            </div>
          </div>
          <div className="setup-field">
            <label htmlFor="conn-url">Endpoint URL</label>
            <input id="conn-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.invalid/v1/recommend" required />
          </div>
          <div className="setup-field">
            <label htmlFor="conn-desc">Description</label>
            <input id="conn-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this connector provides" />
          </div>
          <div>
            <button type="submit" className="send-button" disabled={busyId === "new"}>
              {busyId === "new" ? "Saving…" : "Register connector"}
            </button>
          </div>
        </form>
      )}
      <ul className="admin-tools" style={{ marginTop: "12px" }}>
        {connectors.map((conn) => {
          const test = testResults[conn.id];
          return (
            <li key={conn.id}>
              <div className="admin-tool" style={{ cursor: "default", alignItems: "flex-start" }}>
                <span>
                  <strong>{conn.name}</strong>
                  <code>{conn.kind} · {conn.method} {conn.url} · domains: {conn.domains.join(", ")}</code>
                  <small>{conn.description}</small>
                  {test && (
                    <small style={{ color: test.ok ? "var(--teal-dark)" : "#b91c1c", fontWeight: 600 }}>
                      Test ({test.elapsedMs}ms): {test.message}
                    </small>
                  )}
                  <div style={{ display: "flex", gap: "8px", marginTop: "8px", flexWrap: "wrap" }}>
                    <button type="button" className="secondary-button" disabled={busyId === conn.id} onClick={() => void testConn(conn.id)}>
                      <FlaskConical size={13} aria-hidden="true" />Test connection
                    </button>
                    <button type="button" className="secondary-button" disabled={busyId === conn.id} onClick={() => void removeConn(conn.id)}>
                      <Trash2 size={13} aria-hidden="true" />Remove
                    </button>
                  </div>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={"Enable " + conn.name}
                  checked={conn.enabled}
                  disabled={busyId === conn.id}
                  onChange={() => void toggleEnabled(conn)}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function AdminPage() {
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof api.toolSetup>>>();
  const [error, setError] = useState("");
  const [providerTick, setProviderTick] = useState(0);
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
      {loaded && <RecommendationProvidersCard key={providerTick} />}
      {loaded && <ExternalConnectorsCard onUpdated={() => setProviderTick((n) => n + 1)} />}
      {loaded && <CapabilityStudio />}
    </main>
  </div>;
}
