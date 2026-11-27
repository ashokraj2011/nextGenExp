import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown, ArrowRight, ArrowUp, BookOpen, GitBranch, Layers, Plus, RotateCcw, Save, Sparkles, Trash2, Zap,
} from "lucide-react";
import { ActionFlowsPanel } from "./action-flows-panel";
import { WorkflowStudioPanel } from "./workflow-studio-panel";
import { KnowledgeBasePanel } from "./knowledge-base-panel";
import { adminPaths } from "../../packages/contracts/admin-paths";
import { componentNames, type ComponentName } from "../../packages/contracts/domain";
import { getDomainPack } from "../../packages/contracts/domain-packs";
import type { FlowScope } from "../../packages/contracts/routing-flows";
import type {
  ExperienceRegistryScopes,
  ExperienceRegistryView,
  RecordWorkspaceRegistry,
  ManagedContentInput,
  ManagedContentRecord,
  ManagedIntentInput,
  ManagedIntentRecord,
  ManagedNbaRuleInput,
  ManagedNbaRuleRecord,
  NbaConditionKind,
} from "../../packages/contracts/experience-registry";
import { api } from "./api";
import "./experience-registry-admin.css";

type RegistryTab = "intents" | "content" | "nba";
type TenantTab = "flows" | "workflows" | "kb";
const workspaceName = (scope: FlowScope) => scope === "tenant" ? "Tenant tools" : getDomainPack(scope).label;

export function ExperienceRegistryAdmin() {
  const [scopes, setScopes] = useState<ExperienceRegistryScopes>();
  const [scope, setScope] = useState<FlowScope>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api.experienceRegistryScopes().then((data) => {
      if (!active) return;
      const allowed: FlowScope[] = [...data.domains, ...(data.tenantTools ? ["tenant" as const] : [])];
      const requested = new URLSearchParams(location.search).get("domain");
      setScope(allowed.find((item) => item === requested) ?? allowed[0]);
      setScopes(data);
    }, (reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, []);

  function switchWorkspace(next: FlowScope) {
    setScope(next);
    const url = new URL(location.href);
    url.searchParams.set("domain", next);
    history.replaceState(history.state, "", url);
  }

  return <main className="admin-page reg-page">
    <header className="reg-header">
      <h1>Intents, Catalog &amp; NBA Rules</h1>
      <p className="reg-subtitle">See what chat can recognize, show, and recommend in each workspace.</p>
    </header>
    {scopes && <div className="reg-scope-row">
      <p>Tenant <strong>{scopes.tenantId}</strong></p>
      {scope && <div className="reg-workspace-picker">
        <label htmlFor="registry-workspace">Workspace</label>
        <select id="registry-workspace" value={scope} onChange={(event) => switchWorkspace(event.target.value as FlowScope)}>
          {scopes.domains.map((id) => <option value={id} key={id}>{workspaceName(id)}</option>)}
          {scopes.tenantTools && <option value="tenant">{workspaceName("tenant")}</option>}
        </select>
      </div>}
    </div>}
    {error && <p className="reg-notice is-error" role="alert">{error}</p>}
    {!scopes && !error && <p className="workspace-loading" role="status">Loading workspaces…</p>}
    {scopes && !scope && <p>No workspaces are available to manage for this account.</p>}
    {scope === "wealth" && <WealthRegistry />}
    {scope === "tenant" && <TenantRegistryTools />}
    {(scope === "it_ops" || scope === "sales_revops") && <RecordRegistry key={scope} domain={scope} />}
  </main>;
}

function TenantRegistryTools() {
  const [tab, setTab] = useState<TenantTab>("flows");
  return <>
    <div className="reg-tabs" role="tablist" aria-label="Tenant tool sections">
      <button type="button" role="tab" aria-selected={tab === "flows"} className={"reg-tab" + (tab === "flows" ? " is-active" : "")}
        onClick={() => setTab("flows")}><Zap size={15} aria-hidden="true" />Action flows</button>
      <button type="button" role="tab" aria-selected={tab === "workflows"} className={"reg-tab" + (tab === "workflows" ? " is-active" : "")}
        onClick={() => setTab("workflows")}><Layers size={15} aria-hidden="true" />Workflows</button>
      <button type="button" role="tab" aria-selected={tab === "kb"} className={"reg-tab" + (tab === "kb" ? " is-active" : "")}
        onClick={() => setTab("kb")}><BookOpen size={15} aria-hidden="true" />Knowledge base</button>
    </div>
    {tab === "flows" && <ActionFlowsPanel />}
    {tab === "workflows" && <WorkflowStudioPanel />}
    {tab === "kb" && <KnowledgeBasePanel />}
  </>;
}

function RecordRegistry({ domain }: { domain: RecordWorkspaceRegistry["domainId"] }) {
  const [tab, setTab] = useState<RegistryTab>("intents");
  const [view, setView] = useState<RecordWorkspaceRegistry>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api.recordWorkspaceRegistry(domain).then((data) => { if (active) setView(data); },
      (reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [domain]);
  const builder = adminPaths.builder + "?domain=" + domain;

  return <>
    <div className="reg-tabs" role="tablist" aria-label="Workspace registry sections">
      <button type="button" role="tab" aria-selected={tab === "intents"} className={"reg-tab" + (tab === "intents" ? " is-active" : "")}
        onClick={() => setTab("intents")}><GitBranch size={15} aria-hidden="true" />Intents {view && `(${view.intents.length})`}</button>
      <button type="button" role="tab" aria-selected={tab === "content"} className={"reg-tab" + (tab === "content" ? " is-active" : "")}
        onClick={() => setTab("content")}><BookOpen size={15} aria-hidden="true" />Content Catalog {view && `(${view.catalog.length})`}</button>
      <button type="button" role="tab" aria-selected={tab === "nba"} className={"reg-tab" + (tab === "nba" ? " is-active" : "")}
        onClick={() => setTab("nba")}><Sparkles size={15} aria-hidden="true" />Next Best Actions</button>
    </div>
    {error && <p className="reg-notice is-error" role="alert">{error}</p>}
    {!view && !error && <p className="workspace-loading" role="status">Loading workspace catalog…</p>}
    {view && tab === "intents" && <section className="reg-card" aria-labelledby="workspace-intents-title">
      <div className="reg-card-head">
        <h2 id="workspace-intents-title">Chat intents</h2>
        <a href={builder}>Manage in UI Builder <ArrowRight size={14} aria-hidden="true" /></a>
      </div>
      <ul className="reg-scope-items">{view.intents.map(({ id, label, description, phrases, layoutName }) => <li key={id}>
        <h3>{label}</h3>
        {description && <p>{description}</p>}
        {phrases?.length ? <p>Example phrases <strong>{phrases.join(" · ")}</strong></p> : null}
        {layoutName && <p>Published design <strong>{layoutName}</strong></p>}
      </li>)}</ul>
    </section>}
    {view && tab === "content" && <section className="reg-card" aria-labelledby="workspace-catalog-title">
      <div className="reg-card-head">
        <h2 id="workspace-catalog-title">Published content</h2>
        <div className="reg-scope-links">
          <a href={builder + "&view=library"}>Design library <ArrowRight size={14} aria-hidden="true" /></a>
          <a href={builder + "&view=widgets"}>Widget library <ArrowRight size={14} aria-hidden="true" /></a>
        </div>
      </div>
      {view.catalog.length ? <ul className="reg-scope-items">{view.catalog.map(({ id, kind, title, description, revision }) => <li key={id}>
        <h3>{title}</h3>
        <p>{kind === "layout" ? `UI design · Revision ${revision}` : "Published widget"}</p>
        {description && <p>{description}</p>}
      </li>)}</ul> : <p>No published designs or widgets in this workspace.</p>}
    </section>}
    {view && tab === "nba" && <section className="reg-card" aria-labelledby="workspace-providers-title">
      <div className="reg-card-head"><h2 id="workspace-providers-title">Recommendation providers</h2></div>
      {view.providers.length ? <ul className="reg-scope-items">{view.providers.map(({ id, label, description }) => <li key={id}>
        <h3>{label}</h3><p>{description}</p>
      </li>)}</ul> : <p>No recommendation providers are connected for this workspace.</p>}
    </section>}
  </>;
}

const conditionLabels: Record<NbaConditionKind, string> = {
  unfunded_account: "Account is unfunded",
  cash_above_usd: "Cash reserve exceeds threshold ($)",
  beneficiary_missing: "Beneficiary is missing",
  has_home_goal: "Active home-buying goal exists",
  always: "Always eligible (fallback)",
};

function newIntentForm(defaultContextId: string): ManagedIntentInput {
  return {
    intentId: "",
    label: "",
    contextId: defaultContextId,
    task: "explain",
    description: "",
    samplePhrases: [],
    enabled: true,
  };
}

function newContentForm(): ManagedContentInput {
  return {
    contentId: "",
    publicationStatus: "published",
    kind: "education",
    title: "",
    description: "",
    body: "",
    allowedComponents: ["PznContentCard"],
    sourceLabel: "Content catalog",
    disclosureText: "Educational guidance for illustration only.",
  };
}

function newNbaForm(): ManagedNbaRuleInput {
  return {
    id: "nba_",
    enabled: true,
    priority: "opportunity",
    conditionKind: "cash_above_usd",
    thresholdUsd: 15000,
    kicker: "Next Best Action · Advisory Opportunity",
    title: "Explore tax-efficient investing for {cash}",
    body: "You have {cash} in cash ({cashPct}% of your portfolio). Review options to align with your long-term plan.",
    reason: "Cash reserve ({cash}) exceeds {threshold}.",
    ctaLabel: "Review portfolio",
    actionKind: "prompt",
    prompt: "Let me know my portfolio summary.",
    dedupeKeywords: [],
    respectsPromotionExclusion: true,
  };
}

function WealthRegistry() {
  const [tab, setTab] = useState<RegistryTab>("intents");
  const [view, setView] = useState<ExperienceRegistryView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  // Intent selection & form
  const [selectedIntentId, setSelectedIntentId] = useState<string | "new">("");
  const [intentForm, setIntentForm] = useState<ManagedIntentInput>(() => newIntentForm("balance"));
  const [samplePhrasesText, setSamplePhrasesText] = useState("");

  // Content selection & form
  const [selectedContentId, setSelectedContentId] = useState<string | "new">("");
  const [contentForm, setContentForm] = useState<ManagedContentInput>(newContentForm);

  // NBA selection & form
  const [selectedNbaId, setSelectedNbaId] = useState<string | "new">("");
  const [nbaForm, setNbaForm] = useState<ManagedNbaRuleInput>(newNbaForm);
  const [dedupeText, setDedupeText] = useState("");

  function hydrateSelections(next: ExperienceRegistryView, keepIntent?: string, keepContent?: string, keepNba?: string) {
    setView(next);
    const intent = (keepIntent && next.intents.find((i) => i.intentId === keepIntent)) ?? next.intents[0];
    if (intent) {
      setSelectedIntentId(intent.intentId);
      setIntentForm({
        intentId: intent.intentId,
        label: intent.label,
        contextId: intent.contextId,
        task: intent.task,
        description: intent.description,
        samplePhrases: intent.samplePhrases,
        enabled: intent.enabled,
      });
      setSamplePhrasesText(intent.samplePhrases.join("\n"));
    }
    const content = (keepContent && next.content.find((c) => c.contentId === keepContent)) ?? next.content[0];
    if (content) {
      setSelectedContentId(content.contentId);
      setContentForm({
        contentId: content.contentId,
        publicationStatus: content.publicationStatus,
        kind: content.kind,
        title: content.title,
        description: content.description,
        body: content.body,
        allowedComponents: [...content.allowedComponents],
        sourceLabel: content.sourceLabel,
        disclosureText: content.disclosureText,
      });
    }
    const nba = (keepNba && next.nbaRules.find((r) => r.id === keepNba)) ?? next.nbaRules[0];
    if (nba) {
      setSelectedNbaId(nba.id);
      setNbaForm({
        id: nba.id,
        enabled: nba.enabled,
        priority: nba.priority,
        conditionKind: nba.conditionKind,
        ...(nba.thresholdUsd !== undefined ? { thresholdUsd: nba.thresholdUsd } : {}),
        kicker: nba.kicker,
        title: nba.title,
        body: nba.body,
        reason: nba.reason,
        ctaLabel: nba.ctaLabel,
        actionKind: nba.actionKind,
        ...(nba.prompt ? { prompt: nba.prompt } : {}),
        dedupeKeywords: [...nba.dedupeKeywords],
        respectsPromotionExclusion: nba.respectsPromotionExclusion,
      });
      setDedupeText(nba.dedupeKeywords.join(", "));
    }
  }

  useEffect(() => {
    let active = true;
    void api.experienceRegistry().then((data) => {
      if (!active) return;
      hydrateSelections(data);
      setLoading(false);
    }).catch((error: unknown) => {
      if (!active) return;
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not load Experience Registry." });
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const selectedIntent: ManagedIntentRecord | undefined = useMemo(
    () => (view && selectedIntentId !== "new" ? view.intents.find((i) => i.intentId === selectedIntentId) : undefined),
    [view, selectedIntentId],
  );
  const selectedContent: ManagedContentRecord | undefined = useMemo(
    () => (view && selectedContentId !== "new" ? view.content.find((c) => c.contentId === selectedContentId) : undefined),
    [view, selectedContentId],
  );
  const selectedNba: ManagedNbaRuleRecord | undefined = useMemo(
    () => (view && selectedNbaId !== "new" ? view.nbaRules.find((r) => r.id === selectedNbaId) : undefined),
    [view, selectedNbaId],
  );

  function pickIntent(item: ManagedIntentRecord) {
    setSelectedIntentId(item.intentId);
    setIntentForm({
      intentId: item.intentId,
      label: item.label,
      contextId: item.contextId,
      task: item.task,
      description: item.description,
      samplePhrases: item.samplePhrases,
      enabled: item.enabled,
    });
    setSamplePhrasesText(item.samplePhrases.join("\n"));
    setNotice(null);
  }

  function pickContent(item: ManagedContentRecord) {
    setSelectedContentId(item.contentId);
    setContentForm({
      contentId: item.contentId,
      publicationStatus: item.publicationStatus,
      kind: item.kind,
      title: item.title,
      description: item.description,
      body: item.body,
      allowedComponents: [...item.allowedComponents],
      sourceLabel: item.sourceLabel,
      disclosureText: item.disclosureText,
    });
    setNotice(null);
  }

  function pickNba(item: ManagedNbaRuleRecord) {
    setSelectedNbaId(item.id);
    setNbaForm({
      id: item.id,
      enabled: item.enabled,
      priority: item.priority,
      conditionKind: item.conditionKind,
      ...(item.thresholdUsd !== undefined ? { thresholdUsd: item.thresholdUsd } : {}),
      kicker: item.kicker,
      title: item.title,
      body: item.body,
      reason: item.reason,
      ctaLabel: item.ctaLabel,
      actionKind: item.actionKind,
      ...(item.prompt ? { prompt: item.prompt } : {}),
      dedupeKeywords: [...item.dedupeKeywords],
      respectsPromotionExclusion: item.respectsPromotionExclusion,
    });
    setDedupeText(item.dedupeKeywords.join(", "));
    setNotice(null);
  }

  async function saveIntent(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setNotice(null);
    const samplePhrases = samplePhrasesText.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 8);
    const payload: ManagedIntentInput = {
      ...intentForm,
      intentId: intentForm.intentId.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_"),
      label: intentForm.label.trim(),
      description: intentForm.description.trim(),
      samplePhrases,
    };
    try {
      const next = await api.saveRegistryIntent(payload);
      hydrateSelections(next, payload.intentId, selectedContentId === "new" ? undefined : selectedContentId, selectedNbaId === "new" ? undefined : selectedNbaId);
      setNotice({ tone: "ok", text: `Saved intent "${payload.intentId}" → TS context "${payload.contextId}". Live in Context Router & UI Builder.` });
    } catch (error: unknown) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not save intent." });
    } finally {
      setSaving(false);
    }
  }

  async function deleteOrResetIntent() {
    if (!selectedIntent) return;
    setSaving(true);
    setNotice(null);
    try {
      const next = await api.deleteOrResetRegistryIntent(selectedIntent.intentId);
      hydrateSelections(next, selectedIntent.isBuiltIn ? selectedIntent.intentId : undefined);
      setNotice({ tone: "ok", text: selectedIntent.isBuiltIn ? `Reset intent "${selectedIntent.intentId}" to defaults.` : `Deleted custom intent "${selectedIntent.intentId}".` });
    } catch (error: unknown) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not update intent." });
    } finally {
      setSaving(false);
    }
  }

  async function saveContent(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setNotice(null);
    const payload: ManagedContentInput = {
      ...contentForm,
      contentId: contentForm.contentId.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_"),
      title: contentForm.title.trim(),
      description: contentForm.description.trim(),
      body: contentForm.body.trim(),
      sourceLabel: contentForm.sourceLabel.trim(),
      disclosureText: contentForm.disclosureText.trim(),
    };
    try {
      const next = await api.saveRegistryContent(payload);
      hydrateSelections(next, selectedIntentId === "new" ? undefined : selectedIntentId, payload.contentId, selectedNbaId === "new" ? undefined : selectedNbaId);
      setNotice({ tone: "ok", text: `Saved content "${payload.contentId}". Available immediately in Treatment Selector & Tool setup.` });
    } catch (error: unknown) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not save content." });
    } finally {
      setSaving(false);
    }
  }

  async function deleteOrResetContent() {
    if (!selectedContent) return;
    setSaving(true);
    setNotice(null);
    try {
      const next = await api.deleteOrResetRegistryContent(selectedContent.contentId);
      hydrateSelections(next, undefined, selectedContent.isBuiltIn ? selectedContent.contentId : undefined);
      setNotice({ tone: "ok", text: selectedContent.isBuiltIn ? `Reset "${selectedContent.contentId}" to defaults.` : `Deleted custom content "${selectedContent.contentId}".` });
    } catch (error: unknown) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not update content." });
    } finally {
      setSaving(false);
    }
  }

  async function saveNba(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setNotice(null);
    const dedupeKeywords = dedupeText.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 6);
    const normalizedId = nbaForm.id.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
    const payload: ManagedNbaRuleInput = {
      id: normalizedId.startsWith("nba_") ? normalizedId : `nba_${normalizedId}`,
      enabled: nbaForm.enabled,
      priority: nbaForm.priority,
      conditionKind: nbaForm.conditionKind,
      ...(nbaForm.conditionKind === "cash_above_usd" ? { thresholdUsd: nbaForm.thresholdUsd ?? 10000 } : {}),
      kicker: nbaForm.kicker.trim(),
      title: nbaForm.title.trim(),
      body: nbaForm.body.trim(),
      reason: nbaForm.reason.trim(),
      ctaLabel: nbaForm.ctaLabel.trim(),
      actionKind: nbaForm.actionKind,
      ...(nbaForm.actionKind === "prompt" && nbaForm.prompt?.trim() ? { prompt: nbaForm.prompt.trim() } : {}),
      dedupeKeywords,
      respectsPromotionExclusion: nbaForm.respectsPromotionExclusion,
    };
    try {
      const next = await api.saveRegistryNba(payload);
      hydrateSelections(next, selectedIntentId === "new" ? undefined : selectedIntentId, selectedContentId === "new" ? undefined : selectedContentId, payload.id);
      setNotice({ tone: "ok", text: `Saved NBA rule "${payload.id}". Customer 360 arbitration updated live.` });
    } catch (error: unknown) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not save NBA rule." });
    } finally {
      setSaving(false);
    }
  }

  async function moveNba(index: number, delta: -1 | 1) {
    if (!view) return;
    const target = index + delta;
    if (target < 0 || target >= view.nbaRules.length) return;
    const ids = view.nbaRules.map((r) => r.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setSaving(true);
    try {
      const next = await api.reorderRegistryNba(ids);
      hydrateSelections(next, undefined, undefined, selectedNbaId === "new" ? undefined : selectedNbaId);
      setNotice({ tone: "ok", text: "Updated Next Best Action priority order." });
    } catch (error: unknown) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not reorder rules." });
    } finally {
      setSaving(false);
    }
  }

  async function deleteOrResetNba() {
    if (!selectedNba) return;
    setSaving(true);
    setNotice(null);
    try {
      const next = await api.deleteOrResetRegistryNba(selectedNba.id);
      hydrateSelections(next, undefined, undefined, selectedNba.isBuiltIn ? selectedNba.id : undefined);
      setNotice({ tone: "ok", text: selectedNba.isBuiltIn ? `Reset NBA rule "${selectedNba.id}" to defaults.` : `Deleted custom NBA rule "${selectedNba.id}".` });
    } catch (error: unknown) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not update NBA rule." });
    } finally {
      setSaving(false);
    }
  }

  function toggleComponent(component: ComponentName) {
    setContentForm((prev) => {
      const exists = prev.allowedComponents.includes(component);
      if (exists && prev.allowedComponents.length === 1) return prev;
      return {
        ...prev,
        allowedComponents: exists
          ? prev.allowedComponents.filter((c) => c !== component)
          : [...prev.allowedComponents, component],
      };
    });
  }

  const contextForForm = view?.contexts.find((c) => c.contextId === intentForm.contextId);

  return (
    <>
      <div className="reg-tabs" role="tablist" aria-label="Master data sections">
        <button type="button" role="tab" aria-selected={tab === "intents"} className={"reg-tab" + (tab === "intents" ? " is-active" : "")} onClick={() => { setTab("intents"); setNotice(null); }}>
          <GitBranch size={15} aria-hidden="true" />Intents &amp; TS Mapping {view ? `(${view.intents.length})` : ""}
        </button>
        <button type="button" role="tab" aria-selected={tab === "content"} className={"reg-tab" + (tab === "content" ? " is-active" : "")} onClick={() => { setTab("content"); setNotice(null); }}>
          <BookOpen size={15} aria-hidden="true" />Content Catalog {view ? `(${view.content.length})` : ""}
        </button>
        <button type="button" role="tab" aria-selected={tab === "nba"} className={"reg-tab" + (tab === "nba" ? " is-active" : "")} onClick={() => { setTab("nba"); setNotice(null); }}>
          <Sparkles size={15} aria-hidden="true" />NBA Priority Rules {view ? `(${view.nbaRules.length})` : ""}
        </button>
      </div>

      {notice && (
        <p className={"reg-notice " + (notice.tone === "error" ? "is-error" : "is-ok")} role="status">{notice.text}</p>
      )}

      {loading ? (
        <p className="workspace-loading" role="status">Loading Wealth catalog…</p>
      ) : !view ? null : tab === "intents" ? (
        <div className="reg-grid">
          <section className="reg-rail" aria-label="Routing intents">
            <div className="reg-rail-head">
              <h2>Intents</h2>
              <button type="button" className="reg-mini-btn" onClick={() => {
                setSelectedIntentId("new");
                setIntentForm(newIntentForm(view.contexts[0]?.contextId ?? "balance"));
                setSamplePhrasesText("");
                setNotice(null);
              }}><Plus size={14} aria-hidden="true" />New</button>
            </div>
            <div className="reg-list">
              {view.intents.map((item) => (
                <button
                  key={item.intentId}
                  type="button"
                  className={"reg-list-item" + (selectedIntentId === item.intentId ? " is-active" : "") + (!item.enabled ? " is-muted" : "")}
                  onClick={() => pickIntent(item)}
                >
                  <div className="reg-item-top">
                    <strong>{item.label}</strong>
                    {!item.isBuiltIn && <span className="reg-tag tag-custom">Custom</span>}
                    {item.isBuiltIn && item.isCustomized && <span className="reg-tag tag-edited">Edited</span>}
                    {!item.enabled && <span className="reg-tag tag-off">Off</span>}
                  </div>
                  <div className="reg-item-flow">
                    <code>{item.intentId}</code>
                    <ArrowRight size={12} aria-hidden="true" />
                    <span className="reg-ctx-pill">{item.contextId}</span>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="reg-editor-col">
            <form className="reg-card" onSubmit={(e) => void saveIntent(e)}>
              <div className="reg-card-head">
                <h2>{selectedIntentId === "new" ? "Create new routing intent" : `Edit intent: ${intentForm.label}`}</h2>
                <label className="reg-toggle">
                  <input type="checkbox" checked={intentForm.enabled} onChange={(e) => setIntentForm((p) => ({ ...p, enabled: e.target.checked }))} />
                  <span>Active in router</span>
                </label>
              </div>

              <div className="reg-fields reg-fields-2">
                <label className="reg-field">
                  <span>Intent ID (snake_case)</span>
                  <input
                    type="text"
                    value={intentForm.intentId}
                    disabled={selectedIntentId !== "new"}
                    placeholder="e.g. tax_loss_harvesting"
                    required
                    onChange={(e) => setIntentForm((p) => ({ ...p, intentId: e.target.value }))}
                  />
                </label>
                <label className="reg-field">
                  <span>Display label</span>
                  <input
                    type="text"
                    value={intentForm.label}
                    placeholder="e.g. Tax-loss harvesting guide"
                    required
                    onChange={(e) => setIntentForm((p) => ({ ...p, label: e.target.value }))}
                  />
                </label>
                <label className="reg-field">
                  <span>TS Rule Group (Context)</span>
                  <select value={intentForm.contextId} onChange={(e) => setIntentForm((p) => ({ ...p, contextId: e.target.value }))}>
                    {view.contexts.map((ctx) => (
                      <option key={ctx.contextId} value={ctx.contextId}>{ctx.displayName} ({ctx.contextId})</option>
                    ))}
                  </select>
                </label>
                <label className="reg-field">
                  <span>Task type</span>
                  <select value={intentForm.task} onChange={(e) => setIntentForm((p) => ({ ...p, task: e.target.value as ManagedIntentInput["task"] }))}>
                    <option value="show">Show (data / summary)</option>
                    <option value="explain">Explain (education)</option>
                    <option value="compare">Compare (side-by-side)</option>
                    <option value="guide">Guide (step-by-step / workflow)</option>
                  </select>
                </label>
              </div>

              <label className="reg-field">
                <span>LLM Context Router description</span>
                <textarea
                  rows={3}
                  value={intentForm.description}
                  placeholder="Describe clearly when the LLM Context Router should classify a user prompt into this intent..."
                  required
                  onChange={(e) => setIntentForm((p) => ({ ...p, description: e.target.value }))}
                />
              </label>

              <label className="reg-field">
                <span>Sample customer utterances (one per line)</span>
                <textarea
                  rows={3}
                  value={samplePhrasesText}
                  placeholder={"How does tax-loss harvesting work?\nCan I offset capital gains?"}
                  onChange={(e) => setSamplePhrasesText(e.target.value)}
                />
              </label>

              <div className="reg-hop-box">
                <span className="reg-hop-kicker"><Layers size={13} aria-hidden="true" />Execution Trace</span>
                <div className="reg-hop-chain">
                  <span><strong>1. Customer 360</strong><code>Live profile signals</code></span>
                  <ArrowRight size={14} aria-hidden="true" />
                  <span><strong>2. High-Level Intent</strong><code>{intentForm.intentId || "(new)"}</code></span>
                  <ArrowRight size={14} aria-hidden="true" />
                  <span><strong>3. TS + CCRE Rules</strong><code>{intentForm.contextId} → {contextForForm?.baseContentIds.join(", ") || "Tool setup"}</code></span>
                  <ArrowRight size={14} aria-hidden="true" />
                  <span><strong>4. Experience UI</strong><code>{selectedIntent?.hasPublishedLayout ? "Published UI Builder layout" : "Default A2UI surface"}</code></span>
                </div>
                <div className="reg-hop-links">
                  <a href={adminPaths.tools}>Edit TS ranking &amp; CCRE rules in Tool setup →</a>
                  <a href={adminPaths.builder + "?domain=wealth"}>Customize layout in UI Builder →</a>
                </div>
              </div>

              <div className="reg-actions">
                <button type="submit" className="reg-primary-btn" disabled={saving}>
                  <Save size={15} aria-hidden="true" />{saving ? "Saving…" : selectedIntentId === "new" ? "Create intent" : "Save intent"}
                </button>
                {selectedIntent && !selectedIntent.isBuiltIn && (
                  <button type="button" className="secondary-button reg-danger-btn" disabled={saving} onClick={() => void deleteOrResetIntent()}>
                    <Trash2 size={15} aria-hidden="true" />Delete intent
                  </button>
                )}
                {selectedIntent && selectedIntent.isBuiltIn && selectedIntent.isCustomized && (
                  <button type="button" className="secondary-button" disabled={saving} onClick={() => void deleteOrResetIntent()}>
                    <RotateCcw size={15} aria-hidden="true" />Reset to default
                  </button>
                )}
              </div>
            </form>
          </section>
        </div>
      ) : tab === "content" ? (
        <div className="reg-grid">
          <section className="reg-rail" aria-label="Content catalog">
            <div className="reg-rail-head">
              <h2>Treatments</h2>
              <button type="button" className="reg-mini-btn" onClick={() => {
                setSelectedContentId("new");
                setContentForm(newContentForm());
                setNotice(null);
              }}><Plus size={14} aria-hidden="true" />New</button>
            </div>
            <div className="reg-list">
              {view.content.map((item) => (
                <button
                  key={item.contentId}
                  type="button"
                  className={"reg-list-item" + (selectedContentId === item.contentId ? " is-active" : "") + (item.publicationStatus === "withdrawn" ? " is-muted" : "")}
                  onClick={() => pickContent(item)}
                >
                  <div className="reg-item-top">
                    <strong>{item.title}</strong>
                    {!item.isBuiltIn && <span className="reg-tag tag-custom">Custom</span>}
                    {item.isBuiltIn && item.isCustomized && <span className="reg-tag tag-edited">Edited</span>}
                    {item.publicationStatus === "withdrawn" && <span className="reg-tag tag-off">Withdrawn</span>}
                  </div>
                  <div className="reg-item-flow">
                    <code>{item.contentId}</code>
                    <span className="reg-ctx-pill">{item.kind}</span>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="reg-editor-col">
            <form className="reg-card" onSubmit={(e) => void saveContent(e)}>
              <div className="reg-card-head">
                <h2>{selectedContentId === "new" ? "Create new governed treatment" : `Edit treatment: ${contentForm.title}`}</h2>
                <span className="reg-ctx-pill">{selectedContent ? `v${selectedContent.version}` : "v1"}</span>
              </div>

              <div className="reg-fields reg-fields-3">
                <label className="reg-field">
                  <span>Content ID (snake_case)</span>
                  <input
                    type="text"
                    value={contentForm.contentId}
                    disabled={selectedContentId !== "new"}
                    placeholder="e.g. roth_ira_guide"
                    required
                    onChange={(e) => setContentForm((p) => ({ ...p, contentId: e.target.value }))}
                  />
                </label>
                <label className="reg-field">
                  <span>Category / Kind</span>
                  <select value={contentForm.kind} onChange={(e) => setContentForm((p) => ({ ...p, kind: e.target.value as ManagedContentInput["kind"] }))}>
                    <option value="education">Education</option>
                    <option value="promotion">Promotional recommendation</option>
                    <option value="metric_template">Metric Template</option>
                  </select>
                </label>
                <label className="reg-field">
                  <span>Publication status</span>
                  <select value={contentForm.publicationStatus} onChange={(e) => setContentForm((p) => ({ ...p, publicationStatus: e.target.value as ManagedContentInput["publicationStatus"] }))}>
                    <option value="published">Published (eligible)</option>
                    <option value="withdrawn">Withdrawn (hidden)</option>
                  </select>
                </label>
              </div>

              <label className="reg-field">
                <span>Title</span>
                <input type="text" value={contentForm.title} required onChange={(e) => setContentForm((p) => ({ ...p, title: e.target.value }))} />
              </label>

              <label className="reg-field">
                <span>Short description (shown to Composer)</span>
                <input type="text" value={contentForm.description} required onChange={(e) => setContentForm((p) => ({ ...p, description: e.target.value }))} />
              </label>

              <label className="reg-field">
                <span>Approved body copy</span>
                <textarea rows={4} value={contentForm.body} required onChange={(e) => setContentForm((p) => ({ ...p, body: e.target.value }))} />
              </label>

              <div className="reg-field">
                <span>Allowed A2UI Components</span>
                <div className="reg-comp-checks">
                  {componentNames.map((comp) => (
                    <label key={comp} className={"reg-comp-pill" + (contentForm.allowedComponents.includes(comp) ? " is-checked" : "")}>
                      <input type="checkbox" checked={contentForm.allowedComponents.includes(comp)} onChange={() => toggleComponent(comp)} />
                      <span>{comp}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="reg-fields reg-fields-2">
                <label className="reg-field">
                  <span>Source citation label</span>
                  <input type="text" value={contentForm.sourceLabel} required onChange={(e) => setContentForm((p) => ({ ...p, sourceLabel: e.target.value }))} />
                </label>
                <label className="reg-field">
                  <span>Required disclosure</span>
                  <input type="text" value={contentForm.disclosureText} required onChange={(e) => setContentForm((p) => ({ ...p, disclosureText: e.target.value }))} />
                </label>
              </div>

              {selectedContent && (
                <div className="reg-hop-box">
                  <span className="reg-hop-kicker">Treatment Selector Linkage</span>
                  <p className="reg-link-note">
                    {selectedContent.linkedContexts.length > 0
                      ? <>Default base treatment in TS contexts: {selectedContent.linkedContexts.map((c) => <code key={c}>{c}</code>)}</>
                      : <>Not yet in a default TS context. Add <code>{selectedContent.contentId}</code> to any context in <a href={adminPaths.tools}>Tool setup → Treatment Selector overrides</a>.</>}
                  </p>
                </div>
              )}

              <div className="reg-actions">
                <button type="submit" className="reg-primary-btn" disabled={saving}>
                  <Save size={15} aria-hidden="true" />{saving ? "Saving…" : selectedContentId === "new" ? "Create treatment" : "Save treatment"}
                </button>
                {selectedContent && !selectedContent.isBuiltIn && (
                  <button type="button" className="secondary-button reg-danger-btn" disabled={saving} onClick={() => void deleteOrResetContent()}>
                    <Trash2 size={15} aria-hidden="true" />Delete treatment
                  </button>
                )}
                {selectedContent && selectedContent.isBuiltIn && selectedContent.isCustomized && (
                  <button type="button" className="secondary-button" disabled={saving} onClick={() => void deleteOrResetContent()}>
                    <RotateCcw size={15} aria-hidden="true" />Reset to default
                  </button>
                )}
              </div>
            </form>
          </section>
        </div>
      ) : (
        <div className="reg-grid">
          <section className="reg-rail" aria-label="NBA priority rules">
            <div className="reg-rail-head">
              <h2>Arbitration Order</h2>
              <button type="button" className="reg-mini-btn" onClick={() => {
                setSelectedNbaId("new");
                setNbaForm(newNbaForm());
                setDedupeText("");
                setNotice(null);
              }}><Plus size={14} aria-hidden="true" />New</button>
            </div>
            <div className="reg-list">
              {view.nbaRules.map((rule, index) => (
                <div key={rule.id} className={"reg-nba-row" + (selectedNbaId === rule.id ? " is-active" : "") + (!rule.enabled ? " is-muted" : "")}>
                  <div className="reg-rank-btns">
                    <button type="button" className="icon-button" aria-label={`Move ${rule.id} up`} disabled={index === 0 || saving} onClick={() => void moveNba(index, -1)}>
                      <ArrowUp size={14} />
                    </button>
                    <span className="reg-rank-num">#{rule.rank}</span>
                    <button type="button" className="icon-button" aria-label={`Move ${rule.id} down`} disabled={index === view.nbaRules.length - 1 || saving} onClick={() => void moveNba(index, 1)}>
                      <ArrowDown size={14} />
                    </button>
                  </div>
                  <button type="button" className="reg-nba-select" onClick={() => pickNba(rule)}>
                    <div className="reg-item-top">
                      <strong>{rule.title}</strong>
                      {!rule.enabled && <span className="reg-tag tag-off">Off</span>}
                      {!rule.isBuiltIn && <span className="reg-tag tag-custom">Custom</span>}
                      {rule.isBuiltIn && rule.isCustomized && <span className="reg-tag tag-edited">Edited</span>}
                    </div>
                    <div className="reg-item-flow">
                      <span className="reg-ctx-pill">
                        {rule.conditionKind === "cash_above_usd" ? `Cash > $${(rule.thresholdUsd ?? 10000).toLocaleString()}` : conditionLabels[rule.conditionKind]}
                      </span>
                    </div>
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="reg-editor-col">
            <form className="reg-card" onSubmit={(e) => void saveNba(e)}>
              <div className="reg-card-head">
                <h2>{selectedNbaId === "new" ? "Create Next Best Action rule" : `Edit NBA rule: ${nbaForm.id}`}</h2>
                <label className="reg-toggle">
                  <input type="checkbox" checked={nbaForm.enabled} onChange={(e) => setNbaForm((p) => ({ ...p, enabled: e.target.checked }))} />
                  <span>Rule active</span>
                </label>
              </div>

              <div className="reg-fields reg-fields-3">
                <label className="reg-field">
                  <span>Rule ID (nba_...)</span>
                  <input
                    type="text"
                    value={nbaForm.id}
                    disabled={selectedNbaId !== "new"}
                    placeholder="nba_tax_review"
                    required
                    onChange={(e) => setNbaForm((p) => ({ ...p, id: e.target.value }))}
                  />
                </label>
                <label className="reg-field">
                  <span>Priority tier</span>
                  <select value={nbaForm.priority} onChange={(e) => setNbaForm((p) => ({ ...p, priority: e.target.value as ManagedNbaRuleInput["priority"] }))}>
                    <option value="urgent">Urgent</option>
                    <option value="opportunity">Opportunity</option>
                    <option value="goal">Goal momentum</option>
                  </select>
                </label>
                <label className="reg-field">
                  <span>Trigger condition</span>
                  <select value={nbaForm.conditionKind} onChange={(e) => setNbaForm((p) => ({ ...p, conditionKind: e.target.value as NbaConditionKind }))}>
                    {(Object.keys(conditionLabels) as NbaConditionKind[]).map((key) => (
                      <option key={key} value={key}>{conditionLabels[key]}</option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="reg-fields reg-fields-2">
                {nbaForm.conditionKind === "cash_above_usd" && (
                  <label className="reg-field">
                    <span>Cash threshold ($ USD)</span>
                    <input
                      type="number"
                      min="0"
                      step="500"
                      value={nbaForm.thresholdUsd ?? 10000}
                      onChange={(e) => setNbaForm((p) => ({ ...p, thresholdUsd: Math.max(0, Math.round(Number(e.target.value) || 0)) }))}
                    />
                  </label>
                )}
                <label className="reg-field">
                  <span>Kicker label</span>
                  <input type="text" value={nbaForm.kicker} required onChange={(e) => setNbaForm((p) => ({ ...p, kicker: e.target.value }))} />
                </label>
              </div>

              <label className="reg-field">
                <span>Card headline (supports <code>{"{cash}"}</code>, <code>{"{threshold}"}</code>, <code>{"{cashPct}"}</code>, <code>{"{goalPct}"}</code>, <code>{"{name}"}</code>)</span>
                <input type="text" value={nbaForm.title} required onChange={(e) => setNbaForm((p) => ({ ...p, title: e.target.value }))} />
              </label>

              <label className="reg-field">
                <span>Card body copy</span>
                <textarea rows={3} value={nbaForm.body} required onChange={(e) => setNbaForm((p) => ({ ...p, body: e.target.value }))} />
              </label>

              <label className="reg-field">
                <span>Explainability reason (&ldquo;Why you&rsquo;re seeing this&rdquo;)</span>
                <input type="text" value={nbaForm.reason} required onChange={(e) => setNbaForm((p) => ({ ...p, reason: e.target.value }))} />
              </label>

              <div className="reg-fields reg-fields-2">
                <label className="reg-field">
                  <span>CTA button label</span>
                  <input type="text" value={nbaForm.ctaLabel} required onChange={(e) => setNbaForm((p) => ({ ...p, ctaLabel: e.target.value }))} />
                </label>
                <label className="reg-field">
                  <span>CTA action type</span>
                  <select value={nbaForm.actionKind} onChange={(e) => setNbaForm((p) => ({ ...p, actionKind: e.target.value as ManagedNbaRuleInput["actionKind"] }))}>
                    <option value="prompt">Send follow-up chat prompt</option>
                    <option value="preview_funding">Launch funding preview workflow</option>
                  </select>
                </label>
              </div>

              {nbaForm.actionKind === "prompt" && (
                <label className="reg-field">
                  <span>Follow-up prompt triggered by CTA</span>
                  <input type="text" value={nbaForm.prompt ?? ""} placeholder="Let me know my portfolio summary." onChange={(e) => setNbaForm((p) => ({ ...p, prompt: e.target.value }))} />
                </label>
              )}

              <div className="reg-fields reg-fields-2">
                <label className="reg-field">
                  <span>De-duplication keywords (comma-separated)</span>
                  <input type="text" value={dedupeText} placeholder="investing options, cash" onChange={(e) => setDedupeText(e.target.value)} />
                </label>
                <label className="reg-toggle reg-toggle-inline">
                  <input
                    type="checkbox"
                    checked={nbaForm.respectsPromotionExclusion}
                    onChange={(e) => setNbaForm((p) => ({ ...p, respectsPromotionExclusion: e.target.checked }))}
                  />
                  <span>Respect customer promotion opt-out</span>
                </label>
              </div>

              <div className="reg-actions">
                <button type="submit" className="reg-primary-btn" disabled={saving}>
                  <Save size={15} aria-hidden="true" />{saving ? "Saving…" : selectedNbaId === "new" ? "Create NBA rule" : "Save NBA rule"}
                </button>
                {selectedNba && !selectedNba.isBuiltIn && (
                  <button type="button" className="secondary-button reg-danger-btn" disabled={saving} onClick={() => void deleteOrResetNba()}>
                    <Trash2 size={15} aria-hidden="true" />Delete rule
                  </button>
                )}
                {selectedNba && selectedNba.isBuiltIn && selectedNba.isCustomized && (
                  <button type="button" className="secondary-button" disabled={saving} onClick={() => void deleteOrResetNba()}>
                    <RotateCcw size={15} aria-hidden="true" />Reset to default
                  </button>
                )}
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
