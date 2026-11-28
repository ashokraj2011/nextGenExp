import { CapabilityStudio } from "./capability-studio";
import { DomainToolsAndModelPanel } from "./domain-tools-model";
import { McpDiscoveryCard } from "./mcp-discovery-card";
import { McpServerPanel } from "./mcp-server-panel";
import "./agentic.css";
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, FlaskConical, Layers, MessageSquare, Play, Plug, Plus, Trash2 } from "lucide-react";
import { DOMAIN_PACKS, getDomainPack, type DomainPackId } from "../../packages/contracts/domain-packs";
import type { RecommendationProviderDescriptor } from "../../packages/contracts/recommendation-provider";
import type { ConnectorEffect, ConnectorKind, ConnectorTestResult, ExternalConnector } from "../../packages/contracts/connector";
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
import { api, isPublicationReview, toolSetupErrorMessage as messageFor } from "./api";
import { RoutingFlowSetup } from "./routing-flow-setup";
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
      <p>Check funding status and Funding options are required before the agent lists funding methods.</p>
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
      if (isPublicationReview(persisted)) {
        setSaveNotice("Submitted for approval.");
        return false;
      }
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
  async function openInChat() {
    if (!personaId || startingChat) return;
    setStartingChat(true);
    setChatError("");
    try {
      if (invalidDraft) {
        setChatError("Complete the tool settings before testing.");
        return;
      }
      const conversation = await api.testToolSetup(setup, personaId, scenarioId);
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
        <h2>Wealth tools</h2>
        <p>Save settings publishes the rules and workflow to Wealth chats. Open in chat uses a private copy of these settings.</p>
      </div>
      <div className="admin-save">
        <p role="status">{saveNotice || saveHint}</p>
        {data.privateDraft && !dirty && JSON.stringify(data.privateDraft) !== JSON.stringify(saved.setup) &&
          <button type="button" className="secondary-button" onClick={() => edit(data.privateDraft!)}>Load private draft</button>}
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
          rules={ccreRules} defaults={data.defaultCcreRules} personas={personas} content={data.content} glossary={data.glossary} limitReached={allCcreRules.length >= MAX_CCRE_RULES}
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
              aria-describedby="open-chat-note" onClick={() => void openInChat()}>
              <MessageSquare size={16} aria-hidden="true" />{startingChat ? "Opening chat…" : dirty ? "Open draft in chat" : "Open in chat"}
            </button>
          </div>
          <p id="open-chat-note" className="admin-test-note">Open in chat opens a new chat with this profile and scenario.</p>
          {chatError && <p className="admin-error" role="alert">{chatError}</p>}
          {previewResult && ("error" in previewResult
            ? <p className="admin-error" role="alert">{previewResult.error}</p>
            : <TreatmentPreviewResult result={previewResult.result} />)}
        </div>
      </section>
    </fieldset>
  </form>;
}

function domainPackToRecommendationDomain(domainId: DomainPackId): RecommendationDomain {
  if (domainId === "it_ops") return "operations";
  if (domainId === "sales_revops") return "sales";
  return "wealth";
}

function initialDomainFromUrl(): DomainPackId {
  if (typeof window === "undefined") return "wealth";
  const param = new URLSearchParams(window.location.search).get("domain");
  if (param === "it_ops" || param === "sales_revops" || param === "wealth") return param;
  return "wealth";
}

function RecommendationProvidersCard({ domainId }: { domainId: DomainPackId }) {
  const [info, setInfo] = useState<{ toolRef: string; providers: RecommendationProviderDescriptor[] } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const pack = getDomainPack(domainId);
  const targetDomain = domainPackToRecommendationDomain(domainId);
  useEffect(() => {
    let mounted = true;
    void api.recommendationProviders()
      .then((res) => { if (mounted) setInfo(res); })
      .catch(() => undefined);
    return () => { mounted = false; };
  }, []);
  if (!info || info.providers.length === 0) return null;
  const scoped = info.providers.filter((p) => p.domains.includes(targetDomain) || p.domains.includes("general"));
  const visible = showAll ? info.providers : scoped;
  const hiddenCount = info.providers.length - scoped.length;
  return (
    <section className="admin-card" aria-labelledby="rec-providers-title" style={{ marginTop: "18px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "10px", flexWrap: "wrap" }}>
        <div>
          <h2 id="rec-providers-title" style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <Layers size={18} aria-hidden="true" />
            {pack.shortLabel} Recommendation Providers (sfield)
          </h2>
          <p>
            Domain engines registered behind <code>{info.toolRef}</code> for <strong>{pack.label}</strong> (<code>{targetDomain}</code>).
          </p>
        </div>
        {hiddenCount > 0 && (
          <button type="button" className="secondary-button" onClick={() => setShowAll((v) => !v)}>
            {showAll ? `Show ${pack.shortLabel} only` : `Show all domains (+${hiddenCount})`}
          </button>
        )}
      </div>
      {visible.length === 0 ? (
        <p className="admin-muted" style={{ marginTop: "10px" }}>
          No recommendation providers scoped to {pack.shortLabel} yet.
        </p>
      ) : (
        <ul className="admin-tools" style={{ marginTop: "12px" }}>
          {visible.map((provider) => (
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
      )}
    </section>
  );
}

function ExternalConnectorsCard({ domainId, onUpdated }: { domainId: DomainPackId; onUpdated: () => void }) {
  const pack = getDomainPack(domainId);
  const targetDomain = domainPackToRecommendationDomain(domainId);
  const [connectors, setConnectors] = useState<ExternalConnector[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [draftOpen, setDraftOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ConnectorKind>("rest_action");
  const [effect, setEffect] = useState<ConnectorEffect>("write");
  const [url, setUrl] = useState("");
  const [authEnvVar, setAuthEnvVar] = useState("");
  const [requiresApproval, setRequiresApproval] = useState(true);
  const [dualControl, setDualControl] = useState(false);
  const [domain, setDomain] = useState<RecommendationDomain>(targetDomain);
  const [description, setDescription] = useState("");
  const [testResults, setTestResults] = useState<Record<string, ConnectorTestResult>>({});
  const [invokeResults, setInvokeResults] = useState<Record<string, { ok: boolean; text: string; approvalId?: string }>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setDomain(targetDomain);
  }, [targetDomain]);

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
      if (isPublicationReview(res)) return;
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

  async function invokeConn(conn: ExternalConnector) {
    setBusyId(conn.id);
    setError("");
    try {
      const res = await api.invokeConnector({
        connectorId: conn.id,
        action: conn.kind === "rest_action" ? "trigger_incident_webhook" : "invoke_connector",
        actor: "CEP Admin",
        note: `Admin invocation from Tool setup for ${conn.name}`,
        payload: { source: "admin_tool_setup", connectorId: conn.id },
      });
      if (res.status === "pending_approval" && res.approval) {
        setInvokeResults((prev) => ({
          ...prev,
          [conn.id]: {
            ok: true,
            approvalId: res.approval!.id,
            text: `HITL Approval queued (${res.approval!.id}) · Approve in Chat ("show pending approvals") or /admin/logs?source=approvals.`,
          },
        }));
      } else if (res.execution) {
        setInvokeResults((prev) => ({
          ...prev,
          [conn.id]: {
            ok: true,
            text: `Executed via sfield (${res.execution!.sfieldRunId ?? "ok"}) · ${res.execution!.summary}`,
          },
        }));
      }
    } catch (err) {
      setInvokeResults((prev) => ({
        ...prev,
        [conn.id]: { ok: false, text: messageFor(err) },
      }));
    } finally {
      setBusyId(null);
    }
  }

  async function removeConn(id: string) {
    setBusyId(id);
    try {
      const res = await api.deleteConnector(id);
      if (isPublicationReview(res)) return;
      setConnectors(res.connectors);
      onUpdated();
    } finally {
      setBusyId(null);
    }
  }

  async function createConnector(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !url.trim()) {
      setError("Connector name and valid URL (https:// or sandbox://) are required.");
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
        ...(authEnvVar.trim() ? { authHeaderName: "Authorization", authEnvVar: authEnvVar.trim().toUpperCase() } : {}),
        effect,
        requiresApproval,
        dualControl,
        sandboxMode: url.trim().startsWith("sandbox://"),
        description: description.trim() || `External ${kind} connector`,
      });
      if (isPublicationReview(res)) return;
      setConnectors(res.connectors);
      setName("");
      setUrl("");
      setAuthEnvVar("");
      setDescription("");
      setDraftOpen(false);
      onUpdated();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusyId(null);
    }
  }

  const scoped = connectors.filter((c) => c.domains.includes(targetDomain) || c.domains.includes("general"));
  const visible = showAll ? connectors : scoped;
  const hiddenCount = connectors.length - scoped.length;

  return (
    <section className="admin-card" aria-labelledby="ext-connectors-title" style={{ marginTop: "18px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <div>
          <h2 id="ext-connectors-title" style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <Plug size={18} aria-hidden="true" />
            {pack.shortLabel} External REST &amp; MCP Connectors
          </h2>
          <p>
            Connectors scoped to <strong>{pack.label}</strong> (<code>{targetDomain}</code>). Executed via <code>cep.connector.invoke@1.0.0</code> with server-side secret resolution, HITL approval gating, and immutable Write Audit logging.
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {hiddenCount > 0 && (
            <button type="button" className="secondary-button" onClick={() => setShowAll((v) => !v)}>
              {showAll ? `Show ${pack.shortLabel} only` : `Show all domains (+${hiddenCount})`}
            </button>
          )}
          <a className="secondary-button" href="/integrations" style={{ textDecoration: "none" }}>Open /integrations</a>
          <button type="button" className="secondary-button" onClick={() => setDraftOpen((v) => !v)}>
            <Plus size={15} aria-hidden="true" />{draftOpen ? "Cancel" : `Add ${pack.shortLabel} connector`}
          </button>
        </div>
      </div>
      {error && <p className="admin-error" role="alert" style={{ marginTop: "10px" }}>{error}</p>}
      {draftOpen && (
        <form className="admin-rule-draft" onSubmit={(e) => void createConnector(e)}>
          <div className="admin-fields">
            <div className="setup-field">
              <label htmlFor="conn-name">Connector name</label>
              <input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., ServiceNow Change Webhook" required />
            </div>
            <div className="setup-field">
              <label htmlFor="conn-kind">Type</label>
              <select id="conn-kind" value={kind} onChange={(e) => {
                const nextKind = e.target.value as ConnectorKind;
                setKind(nextKind);
                if (nextKind === "rest_action") { setEffect("write"); setRequiresApproval(true); }
                else { setEffect("read"); setRequiresApproval(false); }
              }}>
                <option value="rest_action">REST Action Tool (sfield)</option>
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
          <div className="admin-fields">
            <div className="setup-field">
              <label htmlFor="conn-url">Endpoint URL (https:// or sandbox://)</label>
              <input id="conn-url" type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="sandbox://servicenow/change/create" required />
            </div>
            <div className="setup-field">
              <label htmlFor="conn-effect">sfield Effect</label>
              <select id="conn-effect" value={effect} onChange={(e) => setEffect(e.target.value as ConnectorEffect)}>
                <option value="write">write (audited)</option>
                <option value="read">read</option>
              </select>
            </div>
            <div className="setup-field">
              <label htmlFor="conn-env">Auth Secret Env Var (optional)</label>
              <input id="conn-env" value={authEnvVar} onChange={(e) => setAuthEnvVar(e.target.value)} placeholder="e.g., SERVICENOW_API_KEY" />
            </div>
          </div>
          <div className="setup-field">
            <label htmlFor="conn-desc">Description</label>
            <input id="conn-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this connector executes or provides" />
          </div>
          <div style={{ display: "flex", gap: "18px", flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "0.86rem" }}>
              <input type="checkbox" checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} />
              Require HITL approval before execution
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "0.86rem" }}>
              <input type="checkbox" checked={dualControl} onChange={(e) => setDualControl(e.target.checked)} />
              Require separate approver (4-eyes)
            </label>
          </div>
          <div>
            <button type="submit" className="send-button" disabled={busyId === "new"}>
              {busyId === "new" ? "Saving…" : "Register connector"}
            </button>
          </div>
        </form>
      )}
      {visible.length === 0 ? (
        <p className="admin-muted" style={{ marginTop: "12px" }}>
          No external connectors registered for {pack.shortLabel} yet. Click <strong>Add {pack.shortLabel} connector</strong> above to connect an external REST or MCP endpoint.
        </p>
      ) : (
        <ul className="admin-tools" style={{ marginTop: "12px" }}>
          {visible.map((conn) => {
            const test = testResults[conn.id];
            const invoke = invokeResults[conn.id];
            return (
              <li key={conn.id}>
                <div className="admin-tool" style={{ cursor: "default", alignItems: "flex-start" }}>
                  <span>
                    <strong>{conn.name}</strong>
                    <code>
                      {conn.kind} · {conn.effect} · {conn.method} {conn.url} · domains: {conn.domains.join(", ")}
                      {conn.requiresApproval ? " · HITL approval" : ""}
                      {conn.dualControl ? " · 4-eyes" : ""}
                      {conn.authEnvVar ? ` · env:${conn.authEnvVar}` : ""}
                    </code>
                    <small>{conn.description}</small>
                    {test && (
                      <small style={{ color: test.ok ? "var(--teal-dark)" : "#b91c1c", fontWeight: 600 }}>
                        Test ({test.elapsedMs}ms): {test.message}
                      </small>
                    )}
                    {invoke && (
                      <small style={{ color: invoke.ok ? "var(--teal-dark)" : "#b91c1c", fontWeight: 600 }}>
                        {invoke.text}{" "}
                        {invoke.approvalId && (
                          <a href={`${adminPaths.logs}?source=approvals`} style={{ textDecoration: "underline" }}>Open Approval Queue</a>
                        )}
                      </small>
                    )}
                    <div style={{ display: "flex", gap: "8px", marginTop: "8px", flexWrap: "wrap" }}>
                      <button type="button" className="secondary-button" disabled={busyId === conn.id} onClick={() => void testConn(conn.id)}>
                        <FlaskConical size={13} aria-hidden="true" />Test connection
                      </button>
                      <button type="button" className="secondary-button" disabled={busyId === conn.id || !conn.enabled} onClick={() => void invokeConn(conn)}>
                        <Play size={13} aria-hidden="true" />Invoke via sfield
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
      )}
    </section>
  );
}

export function AdminPage() {
  const [domainId, setDomainId] = useState<DomainPackId>(initialDomainFromUrl);
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof api.toolSetup>>>();
  const [error, setError] = useState("");
  const [providerTick, setProviderTick] = useState(0);
  const activePack = getDomainPack(domainId);

  useEffect(() => {
    let mounted = true;
    void api.toolSetup().then((setup) => { if (mounted) setLoaded(setup); })
      .catch((error: unknown) => { if (mounted) setError(messageFor(error)); });
    return () => { mounted = false; };
  }, []);

  function selectDomain(next: DomainPackId) {
    setDomainId(next);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("domain", next);
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    }
  }

  return <div className="admin-page">
    <main className="admin-main">
      <header className="admin-heading">
        <div>
          <h1>Tool setup</h1>
          <p>
            Select a domain to connect <code>sfield</code> tools to closed JSON Schemas, evolve its <code>smass</code> data model, and configure domain connectors and workflows.
          </p>
        </div>
      </header>

      <nav className="admin-domain-bar" aria-label="Domain workspace">
        <div className="admin-domain-tabs" role="tablist" aria-label="Domains">
          {DOMAIN_PACKS.map((pack) => (
            <button
              key={pack.id}
              type="button"
              role="tab"
              aria-selected={domainId === pack.id}
              className={`admin-domain-tab${domainId === pack.id ? " active" : ""}`}
              onClick={() => selectDomain(pack.id)}
            >
              {pack.shortLabel}
            </button>
          ))}
        </div>
        <div className="admin-domain-meta">
          <span><strong>{activePack.label}</strong> · {activePack.subtitle}</span>
          <span>Source: <code>{activePack.dataSourceLabel}</code></span>
        </div>
      </nav>

      {/* 1. Core Domain-Specific Tools -> Closed Schemas -> Evolved smass Data Model -> sphoton UI Catalog */}
      <DomainToolsAndModelPanel domainId={domainId} />

      {/* 2. Wealth-specific workflows & Treatment Selector rules (only shown on Wealth domain) */}
      {domainId === "wealth" && (
        <div style={{ marginTop: "22px" }}>
          {loaded ? <ToolSetupForm {...loaded} /> : <div className="admin-heading">
            {error ? <p role="status">{error}</p> : <p role="status">Loading Wealth tools…</p>}
          </div>}
        </div>
      )}

      {/* 3. Domain-scoped Recommendation Providers & External Connectors */}
      {loaded && <RecommendationProvidersCard key={`rp-${domainId}-${providerTick}`} domainId={domainId} />}
      {loaded && <ExternalConnectorsCard key={`ec-${domainId}-${providerTick}`} domainId={domainId} onUpdated={() => setProviderTick((n) => n + 1)} />}

      {/* 4. Platform-wide Routing, Capability Studio & MCP Protocol */}
      <section className="admin-section-divider" aria-labelledby="platform-controls-title">
        <h2 id="platform-controls-title">Routing, Capabilities &amp; MCP Protocol</h2>
        <p>Tenant-level chat routing flows, capability governance, and MCP federation across all domains.</p>
        <RoutingFlowSetup />
        {loaded && domainId === "wealth" && <CapabilityStudio />}
        {loaded && (
          <details className="admin-collapsible">
            <summary>
              <span>MCP Server &amp; External MCP Discovery (Protocol Plumbing)</span>
              <ChevronDown size={16} aria-hidden="true" />
            </summary>
            <div className="admin-collapsible-body">
              <McpServerPanel />
              <McpDiscoveryCard onImported={() => setProviderTick((n) => n + 1)} />
            </div>
          </details>
        )}
      </section>
    </main>
  </div>;
}
