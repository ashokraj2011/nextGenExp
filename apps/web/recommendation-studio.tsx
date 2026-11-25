import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  CheckCircle2,
  FileText,
  Layers,
  MessageSquare,
  Play,
  Plus,
  Rocket,
  SlidersHorizontal,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  pznDataTypes,
  pznOperatorLabels,
  pznOperators,
  pznSourceSystems,
  type PznAttribute,
  type PznAttributeInput,
  type PznContext,
  type PznContextInput,
  type PznDataType,
  type PznNamespaceInput,
  type PznOperator,
  type PznRule,
  type PznRuleClause,
  type PznRuleEvalResult,
  type PznRuleInput,
  type PznRuleValue,
  type PznSourceSystem,
  type PznStudioWorkspaceState,
  type PznTextContent,
  type PznTextContentInput,
  type PznTsEvaluationResult,
} from "../../packages/contracts/self-service-pzn";
import { api, toolSetupErrorMessage } from "./api";
import { RecommendationChatExperience } from "./recommendation-chat";
import "./recommendation-studio.css";

type StudioTab = "contexts" | "contents" | "rules" | "dictionary" | "simulator";

function slugify(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^[^a-z]+/, "");
  return cleaned.slice(0, 60) || "item_1";
}

function defaultOperatorsForType(dataType: PznDataType): PznOperator[] {
  switch (dataType) {
    case "enum": return ["eq", "ne", "in", "not_in"];
    case "boolean": return ["eq", "ne"];
    case "number":
    case "currency_usd": return ["eq", "ne", "gt", "gte", "lt", "lte"];
    case "string_list": return ["contains", "exists"];
    default: return ["eq", "ne", "contains", "in", "not_in", "exists"];
  }
}

function defaultClauseValue(attr?: PznAttribute): PznRuleValue {
  if (!attr) return "";
  if (attr.dataType === "boolean") return true;
  if (attr.dataType === "number" || attr.dataType === "currency_usd") return Number(attr.sampleValue) || 0;
  if (attr.dataType === "enum") return attr.enumOptions[0]?.value ?? "";
  return attr.sampleValue || "";
}

function blankContext(): PznContextInput {
  return {
    contextId: "",
    displayName: "",
    description: "",
    channel: "all",
    contextRuleIds: [],
    attachments: [],
  };
}

function blankContent(): PznTextContentInput {
  return {
    contentId: "",
    title: "",
    headline: "",
    body: "",
    ctaLabel: "",
    ctaPrompt: "",
    disclosureText: "",
    tags: [],
    status: "published",
  };
}

function blankRule(firstNs = "portfolio", firstAttr = "cash_usd", firstOp: PznOperator = "gt", firstVal: PznRuleValue = 10000): PznRuleInput {
  return {
    ruleId: "",
    name: "",
    businessDescription: "",
    effect: "include_when_true",
    status: "published",
    rootGroup: {
      id: "grp_root",
      kind: "group",
      combinator: "AND",
      children: [
        { id: "cl_1", kind: "clause", namespaceId: firstNs, attributeId: firstAttr, operator: firstOp, value: firstVal },
      ],
    },
  };
}

export function RecommendationStudio() {
  const [workspace, setWorkspace] = useState<PznStudioWorkspaceState | null>(null);
  const [studioMode, setStudioMode] = useState<"chat" | "classic">("chat");
  const [tab, setTab] = useState<StudioTab>("contexts");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  // Context tab state
  const [selectedContextId, setSelectedContextId] = useState<string>("");
  const [contextForm, setContextForm] = useState<PznContextInput>(blankContext);
  const [attachContentPick, setAttachContentPick] = useState<string>("");
  const [publishNotes, setPublishNotes] = useState("");

  // Content tab state
  const [selectedContentId, setSelectedContentId] = useState<string>("");
  const [contentForm, setContentForm] = useState<PznTextContentInput>(blankContent);
  const [contentTagsInput, setContentTagsInput] = useState("");

  // Rule tab state
  const [selectedRuleId, setSelectedRuleId] = useState<string>("");
  const [ruleForm, setRuleForm] = useState<PznRuleInput>(() => blankRule());
  const [ruleTestMid, setRuleTestMid] = useState("");
  const [ruleTestResult, setRuleTestResult] = useState<{ customerDisplayName: string; evaluation: PznRuleEvalResult } | null>(null);

  // Dictionary tab state
  const [selectedNsId, setSelectedNsId] = useState<string>("portfolio");
  const [nsForm, setNsForm] = useState<PznNamespaceInput>({
    id: "", displayName: "", businessDefinition: "", owner: "Personalization Team", sourceSystem: "custom_attribute",
  });
  const [showNewNs, setShowNewNs] = useState(false);
  const [attrForm, setAttrForm] = useState<PznAttributeInput>({
    id: "",
    namespaceId: "portfolio",
    displayName: "",
    businessDefinition: "",
    dataType: "string",
    allowedOperators: ["eq", "ne", "contains"],
    enumOptions: [],
    unit: "",
    sampleValue: "",
    resolverPath: "customAttributes.",
    piiClassification: "none",
  });
  const [enumLinesInput, setEnumLinesInput] = useState("");

  // Simulator tab state
  const [simMid, setSimMid] = useState("");
  const [simCustomMid, setSimCustomMid] = useState("");
  const [simContextId, setSimContextId] = useState("");
  const [simUseDraft, setSimUseDraft] = useState(false);
  const [simOverrideKey, setSimOverrideKey] = useState("");
  const [simOverrideVal, setSimOverrideVal] = useState("");
  const [simOverrides, setSimOverrides] = useState<Record<string, PznRuleValue>>({});
  const [simResult, setSimResult] = useState<PznTsEvaluationResult | null>(null);

  const allAttrsByKey = useMemo(() => {
    const map = new Map<string, PznAttribute>();
    if (!workspace) return map;
    for (const ns of workspace.dictionary.namespaces) {
      for (const attr of ns.attributes) {
        map.set(`${ns.id}.${attr.id}`, attr);
      }
    }
    return map;
  }, [workspace]);

  function hydrateSelection(ws: PznStudioWorkspaceState) {
    setWorkspace(ws);
    if (!selectedContextId && ws.contexts[0]) {
      loadContextIntoForm(ws.contexts[0]);
    }
    if (!selectedContentId && ws.contents[0]) {
      loadContentIntoForm(ws.contents[0]);
    }
    if (!selectedRuleId && ws.rules[0]) {
      loadRuleIntoForm(ws.rules[0]);
    }
    if (!ruleTestMid && ws.customers[0]) {
      setRuleTestMid(ws.customers[0].syntheticMid);
    }
    if (!simMid && ws.customers[0]) {
      setSimMid(ws.customers[0].syntheticMid);
    }
    if (!simContextId && ws.contexts[0]) {
      setSimContextId(ws.contexts[0].contextId);
    }
    if (!ws.dictionary.namespaces.some((n) => n.id === selectedNsId) && ws.dictionary.namespaces[0]) {
      setSelectedNsId(ws.dictionary.namespaces[0].id);
    }
  }

  useEffect(() => {
    let active = true;
    void api.pznWorkspace().then((ws) => {
      if (active) hydrateSelection(ws);
    }, (err) => {
      if (active) setError(toolSetupErrorMessage(err));
    });
    return () => { active = false; };
  }, []);

  function loadContextIntoForm(ctx: PznContext) {
    setSelectedContextId(ctx.contextId);
    setContextForm({
      contextId: ctx.contextId,
      displayName: ctx.displayName,
      description: ctx.description,
      channel: ctx.channel,
      contextRuleIds: [...ctx.contextRuleIds],
      attachments: ctx.attachments.map((a) => ({ ...a, ruleIds: [...a.ruleIds] })),
    });
    setPublishNotes("");
  }

  function loadContentIntoForm(c: PznTextContent) {
    setSelectedContentId(c.contentId);
    setContentForm({
      contentId: c.contentId,
      title: c.title,
      headline: c.headline,
      body: c.body,
      ctaLabel: c.ctaLabel,
      ctaPrompt: c.ctaPrompt,
      disclosureText: c.disclosureText,
      tags: [...c.tags],
      status: c.status,
    });
    setContentTagsInput(c.tags.join(", "));
  }

  function loadRuleIntoForm(r: PznRule) {
    setSelectedRuleId(r.ruleId);
    setRuleForm({
      ruleId: r.ruleId,
      name: r.name,
      businessDescription: r.businessDescription,
      effect: r.effect,
      status: r.status,
      rootGroup: JSON.parse(JSON.stringify(r.rootGroup)),
    });
    setRuleTestResult(null);
  }

  async function runAction<T>(fn: () => Promise<T>, successMessage: string, onDone?: (res: T) => void) {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const res = await fn();
      onDone?.(res);
      if (successMessage) setNotice(successMessage);
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!workspace) {
    return (
      <main className="pzn-studio">
        <h1>Recommendation Self-Service Studio</h1>
        {error ? <p className="pzn-error" role="alert">{error}</p> : <p role="status">Loading self-service catalog…</p>}
      </main>
    );
  }

  const publishedContextCount = workspace.contexts.filter((c) => c.status === "published" && c.publishedVersion > 0).length;
  const totalAttrCount = workspace.dictionary.namespaces.reduce((acc, ns) => acc + ns.attributes.length, 0);
  const activeContextRecord = workspace.contexts.find((c) => c.contextId === selectedContextId);
  const activePublications = selectedContextId ? (workspace.publicationsByContext[selectedContextId] ?? []) : [];
  const activeNamespace = workspace.dictionary.namespaces.find((ns) => ns.id === selectedNsId) ?? workspace.dictionary.namespaces[0];
  const ruleClauses = ruleForm.rootGroup.children.filter((c): c is PznRuleClause => c.kind === "clause");

  function updateClause(clauseId: string, patch: Partial<PznRuleClause>) {
    setRuleForm((prev) => ({
      ...prev,
      rootGroup: {
        ...prev.rootGroup,
        children: prev.rootGroup.children.map((child) => (
          child.kind === "clause" && child.id === clauseId ? { ...child, ...patch } : child
        )),
      },
    }));
  }

  function addClause() {
    const firstNs = workspace!.dictionary.namespaces[0];
    const firstAttr = firstNs?.attributes[0];
    if (!firstNs || !firstAttr) return;
    const nextId = `cl_${Date.now().toString(36).slice(-4)}`;
    setRuleForm((prev) => ({
      ...prev,
      rootGroup: {
        ...prev.rootGroup,
        children: [
          ...prev.rootGroup.children,
          {
            id: nextId,
            kind: "clause",
            namespaceId: firstNs.id,
            attributeId: firstAttr.id,
            operator: firstAttr.allowedOperators[0] ?? "eq",
            value: defaultClauseValue(firstAttr),
          },
        ],
      },
    }));
  }

  function removeClause(clauseId: string) {
    if (ruleClauses.length <= 1) return;
    setRuleForm((prev) => ({
      ...prev,
      rootGroup: {
        ...prev.rootGroup,
        children: prev.rootGroup.children.filter((c) => c.id !== clauseId),
      },
    }));
  }

  function addOverride() {
    const key = simOverrideKey.trim();
    if (!key) return;
    const attr = allAttrsByKey.get(key);
    let parsed: PznRuleValue = simOverrideVal;
    if (attr?.dataType === "number" || attr?.dataType === "currency_usd") {
      const n = Number(simOverrideVal);
      if (Number.isFinite(n)) parsed = n;
    } else if (attr?.dataType === "boolean") {
      parsed = simOverrideVal.toLowerCase() === "true";
    }
    setSimOverrides((prev) => ({ ...prev, [key]: parsed }));
    setSimOverrideVal("");
  }

  if (studioMode === "chat") {
    return (
      <div className="pzn-studio pzn-studio-chat-mode">
        <RecommendationChatExperience
          workspace={workspace}
          onWorkspaceChange={(ws) => hydrateSelection(ws)}
          onOpenClassic={() => setStudioMode("classic")}
        />
      </div>
    );
  }

  return (
    <main className="pzn-studio">
      <header className="pzn-header">
        <div>
          <h1>Recommendation Self-Service Studio</h1>
          <p className="pzn-subtitle">
            Define contexts, attach text contents, author Data Dictionary rules, publish immutable snapshots, and run live MID Treatment Selector evaluations.
          </p>
        </div>
        <div className="pzn-btn-row" style={{ alignItems: "center" }}>
          <div className="pzn-mode-switch" role="group" aria-label="Studio mode">
            <button type="button" onClick={() => setStudioMode("chat")} aria-pressed="false">
              <MessageSquare size={13} /> Chat Studio
            </button>
            <button type="button" className="is-active" aria-pressed="true">
              <Layers size={13} /> Classic Forms
            </button>
          </div>
        </div>
        <div className="pzn-kpi-strip">
          <div className="pzn-kpi-pill">
            <strong>{publishedContextCount} / {workspace.contexts.length}</strong>
            <span>Published Contexts</span>
          </div>
          <div className="pzn-kpi-pill">
            <strong>{workspace.contents.length}</strong>
            <span>Text Contents</span>
          </div>
          <div className="pzn-kpi-pill">
            <strong>{workspace.rules.length}</strong>
            <span>Rules</span>
          </div>
          <div className="pzn-kpi-pill">
            <strong>{totalAttrCount}</strong>
            <span>Dictionary Attrs ({workspace.dictionary.namespaces.length} NS)</span>
          </div>
        </div>
      </header>

      <nav className="pzn-tabs" role="tablist" aria-label="Recommendation Self-Service sections">
        <button type="button" role="tab" aria-selected={tab === "contexts"} className={"pzn-tab" + (tab === "contexts" ? " is-active" : "")} onClick={() => setTab("contexts")}>
          <Layers size={15} /> 1. Contexts &amp; Publish
        </button>
        <button type="button" role="tab" aria-selected={tab === "contents"} className={"pzn-tab" + (tab === "contents" ? " is-active" : "")} onClick={() => setTab("contents")}>
          <FileText size={15} /> 2. Text Contents
        </button>
        <button type="button" role="tab" aria-selected={tab === "rules"} className={"pzn-tab" + (tab === "rules" ? " is-active" : "")} onClick={() => setTab("rules")}>
          <SlidersHorizontal size={15} /> 3. Rules Builder
        </button>
        <button type="button" role="tab" aria-selected={tab === "dictionary"} className={"pzn-tab" + (tab === "dictionary" ? " is-active" : "")} onClick={() => setTab("dictionary")}>
          <BookOpen size={15} /> 4. Data Dictionary
        </button>
        <button type="button" role="tab" aria-selected={tab === "simulator"} className={"pzn-tab" + (tab === "simulator" ? " is-active" : "")} onClick={() => setTab("simulator")}>
          <Play size={15} /> 5. Live TS Simulator
        </button>
      </nav>

      {notice && <p className="pzn-notice" role="status">{notice}</p>}
      {error && <p className="pzn-error" role="alert">{error}</p>}

      {/* ============ TAB 1: CONTEXTS & PUBLISH ============ */}
      {tab === "contexts" && (
        <div className="pzn-split">
          <section className="pzn-panel" aria-label="Contexts list">
            <div className="pzn-panel-head">
              <h2>Contexts</h2>
              <button
                type="button"
                className="pzn-btn pzn-btn-sm pzn-btn-primary"
                onClick={() => {
                  setSelectedContextId("");
                  setContextForm(blankContext());
                }}
              >
                <Plus size={14} /> New Context
              </button>
            </div>
            <div className="pzn-list">
              {workspace.contexts.map((ctx) => (
                <button
                  key={ctx.contextId}
                  type="button"
                  className={"pzn-list-item" + (selectedContextId === ctx.contextId ? " is-selected" : "")}
                  onClick={() => loadContextIntoForm(ctx)}
                >
                  <div className="pzn-list-top">
                    <strong>{ctx.displayName}</strong>
                    <span className={"pzn-badge " + (ctx.status === "published" ? "is-published" : "is-draft")}>
                      {ctx.status === "published" ? `Published v${ctx.publishedVersion}` : "Draft"}
                    </span>
                  </div>
                  <div className="pzn-list-meta">
                    <span className="pzn-code">{ctx.contextId}</span>
                    <span>{ctx.attachments.length} content(s)</span>
                    {ctx.hasUnpublishedChanges && ctx.publishedVersion > 0 && <span className="pzn-badge is-warn">Unpublished edits</span>}
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="pzn-panel" aria-label="Context editor">
            <div className="pzn-panel-head">
              <h2>{selectedContextId ? `Context: ${contextForm.displayName || selectedContextId}` : "Create New Context"}</h2>
              {activeContextRecord && (
                <span className={"pzn-badge " + (activeContextRecord.status === "published" ? "is-published" : "is-draft")}>
                  {activeContextRecord.status === "published"
                    ? `Live v${activeContextRecord.publishedVersion}${activeContextRecord.hasUnpublishedChanges ? " (draft ahead)" : ""}`
                    : "Draft (not live in TS)"}
                </span>
              )}
            </div>

            <div className="pzn-form-grid">
              <div className="pzn-field">
                <label htmlFor="pzn-ctx-name">Context Display Name</label>
                <input
                  id="pzn-ctx-name"
                  value={contextForm.displayName}
                  placeholder="e.g. High-Yield Cash Banner"
                  onChange={(e) => {
                    const displayName = e.target.value;
                    setContextForm((p) => ({
                      ...p,
                      displayName,
                      contextId: selectedContextId ? p.contextId : slugify(displayName),
                    }));
                  }}
                />
              </div>
              <div className="pzn-field">
                <label htmlFor="pzn-ctx-id">Context ID (TS Slug)</label>
                <input
                  id="pzn-ctx-id"
                  value={contextForm.contextId}
                  disabled={Boolean(selectedContextId)}
                  placeholder="e.g. high_yield_cash_banner"
                  onChange={(e) => setContextForm((p) => ({ ...p, contextId: e.target.value }))}
                />
              </div>
              <div className="pzn-field">
                <label htmlFor="pzn-ctx-channel">Channel</label>
                <select
                  id="pzn-ctx-channel"
                  value={contextForm.channel}
                  onChange={(e) => setContextForm((p) => ({ ...p, channel: e.target.value as PznContextInput["channel"] }))}
                >
                  <option value="all">All Channels (Chat + Web + Mobile)</option>
                  <option value="chat">Chat Experience Layer</option>
                  <option value="web">Web Banner / Card</option>
                  <option value="mobile">Mobile App</option>
                </select>
              </div>
              <div className="pzn-field is-full">
                <label htmlFor="pzn-ctx-desc">Business Description (also guides Live Chat routing)</label>
                <textarea
                  id="pzn-ctx-desc"
                  rows={2}
                  value={contextForm.description}
                  placeholder="Describe when this context should serve recommendations..."
                  onChange={(e) => setContextForm((p) => ({ ...p, description: e.target.value }))}
                />
              </div>
            </div>

            <div className="pzn-field">
              <label>Optional Context-Wide Gate Rules (must pass for any content in this context)</label>
              <div className="pzn-rule-chips">
                {workspace.rules.map((rule) => {
                  const checked = contextForm.contextRuleIds.includes(rule.ruleId);
                  return (
                    <button
                      key={rule.ruleId}
                      type="button"
                      className={"pzn-rule-chip" + (checked ? " is-checked" : "")}
                      onClick={() => setContextForm((p) => ({
                        ...p,
                        contextRuleIds: checked ? p.contextRuleIds.filter((r) => r !== rule.ruleId) : [...p.contextRuleIds, rule.ruleId],
                      }))}
                    >
                      {checked && <Check size={13} />} {rule.name}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="pzn-panel-head" style={{ marginTop: 4 }}>
              <h3>Attached Text Contents &amp; Filtering Rules ({contextForm.attachments.length})</h3>
              <div className="pzn-btn-row">
                <select
                  aria-label="Choose text content to attach"
                  value={attachContentPick}
                  onChange={(e) => setAttachContentPick(e.target.value)}
                  style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)" }}
                >
                  <option value="">Select text content…</option>
                  {workspace.contents
                    .filter((c) => !contextForm.attachments.some((a) => a.contentId === c.contentId))
                    .map((c) => (
                      <option key={c.contentId} value={c.contentId}>{c.title} ({c.contentId})</option>
                    ))}
                </select>
                <button
                  type="button"
                  className="pzn-btn pzn-btn-sm"
                  disabled={!attachContentPick}
                  onClick={() => {
                    if (!attachContentPick) return;
                    setContextForm((p) => ({
                      ...p,
                      attachments: [
                        ...p.attachments,
                        { contentId: attachContentPick, rank: p.attachments.length + 1, ruleIds: [], ruleMatchMode: "all" },
                      ],
                    }));
                    setAttachContentPick("");
                  }}
                >
                  <Plus size={13} /> Attach Content
                </button>
              </div>
            </div>

            {contextForm.attachments.length === 0 ? (
              <p className="pzn-subtitle">No text contents attached yet. Attach one or more contents above, bind rules, save, and publish.</p>
            ) : (
              <div className="pzn-list">
                {contextForm.attachments.map((att, idx) => {
                  const content = workspace.contents.find((c) => c.contentId === att.contentId);
                  return (
                    <div key={att.contentId} className="pzn-attachment-card">
                      <div className="pzn-attachment-head">
                        <div className="pzn-btn-row">
                          <span className="pzn-rank-pill">Rank #{idx + 1}</span>
                          <strong>{content?.title ?? att.contentId}</strong>
                          <span className="pzn-code">{att.contentId}</span>
                        </div>
                        <div className="pzn-btn-row">
                          <button
                            type="button"
                            className="pzn-btn pzn-btn-sm"
                            disabled={idx === 0}
                            aria-label="Move up"
                            onClick={() => {
                              const next = contextForm.attachments.slice();
                              [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                              setContextForm((p) => ({ ...p, attachments: next.map((x, i) => ({ ...x, rank: i + 1 })) }));
                            }}
                          >
                            <ArrowUp size={13} />
                          </button>
                          <button
                            type="button"
                            className="pzn-btn pzn-btn-sm"
                            disabled={idx === contextForm.attachments.length - 1}
                            aria-label="Move down"
                            onClick={() => {
                              const next = contextForm.attachments.slice();
                              [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                              setContextForm((p) => ({ ...p, attachments: next.map((x, i) => ({ ...x, rank: i + 1 })) }));
                            }}
                          >
                            <ArrowDown size={13} />
                          </button>
                          <button
                            type="button"
                            className="pzn-btn pzn-btn-sm pzn-btn-danger"
                            onClick={() => setContextForm((p) => ({
                              ...p,
                              attachments: p.attachments.filter((x) => x.contentId !== att.contentId).map((x, i) => ({ ...x, rank: i + 1 })),
                            }))}
                          >
                            <Trash2 size={13} /> Detach
                          </button>
                        </div>
                      </div>
                      {content && <p className="pzn-subtitle" style={{ fontSize: "0.82rem" }}>{content.body.slice(0, 180)}{content.body.length > 180 ? "…" : ""}</p>}
                      <div className="pzn-btn-row" style={{ justifyContent: "space-between" }}>
                        <span style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--muted)" }}>
                          ATTACHED RULES ({att.ruleIds.length === 0 ? "Always eligible" : `${att.ruleIds.length} rule(s)`})
                        </span>
                        <select
                          aria-label={`Rule match mode for ${att.contentId}`}
                          value={att.ruleMatchMode}
                          onChange={(e) => setContextForm((p) => ({
                            ...p,
                            attachments: p.attachments.map((x) => x.contentId === att.contentId ? { ...x, ruleMatchMode: e.target.value as "all" | "any" } : x),
                          }))}
                          style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border)", fontSize: "0.78rem" }}
                        >
                          <option value="all">Match ALL attached rules</option>
                          <option value="any">Match ANY attached rule</option>
                        </select>
                      </div>
                      <div className="pzn-rule-chips">
                        {workspace.rules.map((rule) => {
                          const checked = att.ruleIds.includes(rule.ruleId);
                          return (
                            <button
                              key={rule.ruleId}
                              type="button"
                              className={"pzn-rule-chip" + (checked ? " is-checked" : "")}
                              onClick={() => setContextForm((p) => ({
                                ...p,
                                attachments: p.attachments.map((x) => (
                                  x.contentId === att.contentId
                                    ? { ...x, ruleIds: checked ? x.ruleIds.filter((r) => r !== rule.ruleId) : [...x.ruleIds, rule.ruleId] }
                                    : x
                                )),
                              }))}
                            >
                              {checked && <Check size={13} />} {rule.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="pzn-form-grid" style={{ marginTop: 4 }}>
              <div className="pzn-field is-full">
                <label htmlFor="pzn-pub-notes">Release Notes (optional, saved on Publish)</label>
                <input
                  id="pzn-pub-notes"
                  value={publishNotes}
                  placeholder="e.g. Attached Q4 VIP cash offer and threshold rule"
                  onChange={(e) => setPublishNotes(e.target.value)}
                />
              </div>
            </div>

            <div className="pzn-btn-row">
              <button
                type="button"
                className="pzn-btn"
                disabled={busy || !contextForm.contextId.trim() || !contextForm.displayName.trim()}
                onClick={() => void runAction(
                  () => api.pznSaveContext(contextForm),
                  `Saved draft for context "${contextForm.contextId}".`,
                  (res) => {
                    setWorkspace(res.workspace);
                    loadContextIntoForm(res.context);
                  },
                )}
              >
                Save Draft
              </button>
              <button
                type="button"
                className="pzn-btn pzn-btn-primary"
                disabled={busy || !contextForm.contextId.trim() || !contextForm.displayName.trim() || contextForm.attachments.length === 0}
                onClick={() => void runAction(
                  async () => {
                    await api.pznSaveContext(contextForm);
                    return api.pznPublishContext(contextForm.contextId, publishNotes || "Published from Self-Service Studio");
                  },
                  `Published "${contextForm.contextId}" to Treatment Selector!`,
                  (res) => {
                    setWorkspace(res.workspace);
                    const updated = res.workspace.contexts.find((c) => c.contextId === contextForm.contextId);
                    if (updated) loadContextIntoForm(updated);
                    setSimContextId(contextForm.contextId);
                  },
                )}
              >
                <Rocket size={14} /> Save &amp; Publish to TS
              </button>
              {activeContextRecord?.status === "published" && (
                <button
                  type="button"
                  className="pzn-btn"
                  disabled={busy}
                  onClick={() => void runAction(
                    () => api.pznUnpublishContext(activeContextRecord.contextId),
                    `Unpublished "${activeContextRecord.contextId}".`,
                    (res) => {
                      setWorkspace(res.workspace);
                      if (res.context) loadContextIntoForm(res.context);
                      if (res.approval) setNotice(`Unpublishing needs approval (${res.approval.id}). Review it under /recommendations → Approvals.`);
                    },
                  )}
                >
                  Unpublish
                </button>
              )}
              {activeContextRecord && (
                <button
                  type="button"
                  className="pzn-btn"
                  onClick={() => {
                    setSimContextId(activeContextRecord.contextId);
                    setSimUseDraft(activeContextRecord.status !== "published");
                    setTab("simulator");
                  }}
                >
                  <Play size={14} /> Test in Live TS Simulator
                </button>
              )}
              {activeContextRecord && !activeContextRecord.builtIn && (
                <button
                  type="button"
                  className="pzn-btn pzn-btn-danger"
                  disabled={busy}
                  onClick={() => void runAction(
                    () => api.pznDeleteContext(activeContextRecord.contextId),
                    `Deleted context "${activeContextRecord.contextId}".`,
                    (res) => {
                      setWorkspace(res.workspace);
                      if (res.workspace.contexts[0]) loadContextIntoForm(res.workspace.contexts[0]);
                      else { setSelectedContextId(""); setContextForm(blankContext()); }
                    },
                  )}
                >
                  <Trash2 size={14} /> Delete
                </button>
              )}
            </div>

            {activePublications.length > 0 && (
              <div className="pzn-field" style={{ marginTop: 8 }}>
                <label>Immutable Publication History ({activePublications.length})</label>
                <div className="pzn-list">
                  {activePublications.slice(0, 4).map((pub) => (
                    <div key={pub.id} className="pzn-attr-card">
                      <div className="pzn-attr-head">
                        <strong>v{pub.version} · {pub.publishedBy}</strong>
                        <span className="pzn-badge is-published">{pub.contents.length} content(s) · {pub.rules.length} rule(s) · {pub.dictionaryVersion}</span>
                      </div>
                      <span className="pzn-subtitle" style={{ fontSize: "0.78rem" }}>
                        {new Date(pub.publishedAt).toLocaleString()} {pub.notes ? `— ${pub.notes}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ============ TAB 2: TEXT CONTENTS ============ */}
      {tab === "contents" && (
        <div className="pzn-split">
          <section className="pzn-panel" aria-label="Text contents list">
            <div className="pzn-panel-head">
              <h2>Text Contents</h2>
              <button
                type="button"
                className="pzn-btn pzn-btn-sm pzn-btn-primary"
                onClick={() => {
                  setSelectedContentId("");
                  setContentForm(blankContent());
                  setContentTagsInput("");
                }}
              >
                <Plus size={14} /> New Content
              </button>
            </div>
            <div className="pzn-list">
              {workspace.contents.map((item) => (
                <button
                  key={item.contentId}
                  type="button"
                  className={"pzn-list-item" + (selectedContentId === item.contentId ? " is-selected" : "")}
                  onClick={() => loadContentIntoForm(item)}
                >
                  <div className="pzn-list-top">
                    <strong>{item.title}</strong>
                    <span className={"pzn-badge " + (item.status === "published" ? "is-published" : "is-draft")}>{item.status}</span>
                  </div>
                  <div className="pzn-list-meta">
                    <span className="pzn-code">{item.contentId}</span>
                    <span>v{item.version}</span>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="pzn-panel" aria-label="Text content editor">
            <div className="pzn-panel-head">
              <h2>{selectedContentId ? `Edit Content: ${selectedContentId}` : "Create Text Content"}</h2>
            </div>

            <div className="pzn-form-grid">
              <div className="pzn-field">
                <label htmlFor="pzn-cnt-title">Title</label>
                <input
                  id="pzn-cnt-title"
                  value={contentForm.title}
                  placeholder="e.g. Exclusive Private Client Cash Yield Offer"
                  onChange={(e) => {
                    const title = e.target.value;
                    setContentForm((p) => ({
                      ...p,
                      title,
                      contentId: selectedContentId ? p.contentId : slugify(title),
                    }));
                  }}
                />
              </div>
              <div className="pzn-field">
                <label htmlFor="pzn-cnt-id">Content ID</label>
                <input
                  id="pzn-cnt-id"
                  value={contentForm.contentId}
                  disabled={Boolean(selectedContentId)}
                  placeholder="e.g. vip_cash_yield_text"
                  onChange={(e) => setContentForm((p) => ({ ...p, contentId: e.target.value }))}
                />
              </div>
              <div className="pzn-field is-full">
                <label htmlFor="pzn-cnt-headline">Headline (supports {"{{namespace.attribute}}"} tokens)</label>
                <input
                  id="pzn-cnt-headline"
                  value={contentForm.headline}
                  placeholder="e.g. You currently have {{portfolio.cash_usd}} in core cash."
                  onChange={(e) => setContentForm((p) => ({ ...p, headline: e.target.value }))}
                />
              </div>
              <div className="pzn-field is-full">
                <label htmlFor="pzn-cnt-body">Body Text</label>
                <textarea
                  id="pzn-cnt-body"
                  rows={4}
                  value={contentForm.body}
                  placeholder="Write the recommendation text returned by Treatment Selector to the Experience Layer..."
                  onChange={(e) => setContentForm((p) => ({ ...p, body: e.target.value }))}
                />
                <div className="pzn-token-bar">
                  <span>Insert live attribute token:</span>
                  {["portfolio.cash_usd", "portfolio.cash_share_pct", "goals.home_funded_pct", "customer.segment"].map((tok) => (
                    <button
                      key={tok}
                      type="button"
                      className="pzn-token-btn"
                      onClick={() => setContentForm((p) => ({ ...p, body: `${p.body}${p.body && !p.body.endsWith(" ") ? " " : ""}{{${tok}}}` }))}
                    >
                      +{`{{${tok}}}`}
                    </button>
                  ))}
                </div>
              </div>
              <div className="pzn-field">
                <label htmlFor="pzn-cnt-cta">CTA Label (optional)</label>
                <input id="pzn-cnt-cta" value={contentForm.ctaLabel} placeholder="e.g. Explore Cash Sweep" onChange={(e) => setContentForm((p) => ({ ...p, ctaLabel: e.target.value }))} />
              </div>
              <div className="pzn-field">
                <label htmlFor="pzn-cnt-prompt">CTA Follow-up Prompt (optional)</label>
                <input id="pzn-cnt-prompt" value={contentForm.ctaPrompt} placeholder="e.g. Show me cash sweep options" onChange={(e) => setContentForm((p) => ({ ...p, ctaPrompt: e.target.value }))} />
              </div>
              <div className="pzn-field">
                <label htmlFor="pzn-cnt-tags">Tags (comma separated)</label>
                <input
                  id="pzn-cnt-tags"
                  value={contentTagsInput}
                  placeholder="cash, wealth, promo"
                  onChange={(e) => {
                    setContentTagsInput(e.target.value);
                    setContentForm((p) => ({
                      ...p,
                      tags: e.target.value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 12),
                    }));
                  }}
                />
              </div>
              <div className="pzn-field">
                <label htmlFor="pzn-cnt-status">Status</label>
                <select id="pzn-cnt-status" value={contentForm.status} onChange={(e) => setContentForm((p) => ({ ...p, status: e.target.value as PznTextContentInput["status"] }))}>
                  <option value="published">Published (eligible)</option>
                  <option value="draft">Draft</option>
                  <option value="archived">Archived (suppressed)</option>
                </select>
              </div>
              <div className="pzn-field is-full">
                <label htmlFor="pzn-cnt-disc">Disclosure Text (optional)</label>
                <input id="pzn-cnt-disc" value={contentForm.disclosureText} placeholder="Compliance / legal disclosure..." onChange={(e) => setContentForm((p) => ({ ...p, disclosureText: e.target.value }))} />
              </div>
            </div>

            <div className="pzn-exp-card" aria-label="Experience card preview">
              <span className="pzn-stage-kicker">Experience Layer Preview</span>
              <h4>{contentForm.title || "Untitled text content"}</h4>
              {contentForm.headline && <p className="pzn-exp-headline">{contentForm.headline}</p>}
              <p className="pzn-exp-body">{contentForm.body || "Enter body text above to preview the recommendation card."}</p>
              {contentForm.ctaLabel && (
                <div className="pzn-btn-row" style={{ marginTop: 4 }}>
                  <span className="pzn-badge is-published">{contentForm.ctaLabel}</span>
                </div>
              )}
              {contentForm.disclosureText && <p className="pzn-exp-disclosure">{contentForm.disclosureText}</p>}
            </div>

            <div className="pzn-btn-row">
              <button
                type="button"
                className="pzn-btn pzn-btn-primary"
                disabled={busy || !contentForm.contentId.trim() || !contentForm.title.trim() || !contentForm.body.trim()}
                onClick={() => void runAction(
                  () => api.pznSaveContent(contentForm),
                  `Saved text content "${contentForm.contentId}".`,
                  (res) => {
                    setWorkspace(res.workspace);
                    loadContentIntoForm(res.content);
                  },
                )}
              >
                Save Text Content
              </button>
              {selectedContentId && (
                <button
                  type="button"
                  className="pzn-btn pzn-btn-danger"
                  disabled={busy}
                  onClick={() => void runAction(
                    () => api.pznDeleteContent(selectedContentId),
                    `Deleted content "${selectedContentId}".`,
                    (res) => {
                      setWorkspace(res.workspace);
                      if (res.workspace.contents[0]) loadContentIntoForm(res.workspace.contents[0]);
                      else { setSelectedContentId(""); setContentForm(blankContent()); }
                    },
                  )}
                >
                  <Trash2 size={14} /> Delete
                </button>
              )}
            </div>
          </section>
        </div>
      )}

      {/* ============ TAB 3: RULES BUILDER ============ */}
      {tab === "rules" && (
        <div className="pzn-split">
          <section className="pzn-panel" aria-label="Rules list">
            <div className="pzn-panel-head">
              <h2>Eligibility Rules</h2>
              <button
                type="button"
                className="pzn-btn pzn-btn-sm pzn-btn-primary"
                onClick={() => {
                  setSelectedRuleId("");
                  const firstNs = workspace.dictionary.namespaces[0];
                  const firstAttr = firstNs?.attributes[0];
                  setRuleForm(blankRule(
                    firstNs?.id ?? "portfolio",
                    firstAttr?.id ?? "cash_usd",
                    firstAttr?.allowedOperators[0] ?? "gt",
                    defaultClauseValue(firstAttr),
                  ));
                  setRuleTestResult(null);
                }}
              >
                <Plus size={14} /> New Rule
              </button>
            </div>
            <div className="pzn-list">
              {workspace.rules.map((rule) => (
                <button
                  key={rule.ruleId}
                  type="button"
                  className={"pzn-list-item" + (selectedRuleId === rule.ruleId ? " is-selected" : "")}
                  onClick={() => loadRuleIntoForm(rule)}
                >
                  <div className="pzn-list-top">
                    <strong>{rule.name}</strong>
                    <span className={"pzn-badge " + (rule.effect === "include_when_true" ? "is-published" : "is-warn")}>
                      {rule.effect === "include_when_true" ? "Include" : "Suppress"}
                    </span>
                  </div>
                  <div className="pzn-list-meta">
                    <span className="pzn-code">{rule.ruleId}</span>
                    <span>{rule.rootGroup.combinator} · {rule.rootGroup.children.length} clause(s)</span>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="pzn-panel" aria-label="Rule builder">
            <div className="pzn-panel-head">
              <h2>{selectedRuleId ? `Edit Rule: ${ruleForm.name || selectedRuleId}` : "Create Data Dictionary Rule"}</h2>
              <span className="pzn-badge">Dictionary: {workspace.dictionary.version}</span>
            </div>

            <div className="pzn-form-grid">
              <div className="pzn-field">
                <label htmlFor="pzn-rule-name">Rule Name</label>
                <input
                  id="pzn-rule-name"
                  value={ruleForm.name}
                  placeholder="e.g. High Cash & Missing Beneficiary"
                  onChange={(e) => {
                    const name = e.target.value;
                    setRuleForm((p) => ({ ...p, name, ruleId: selectedRuleId ? p.ruleId : slugify(name) }));
                  }}
                />
              </div>
              <div className="pzn-field">
                <label htmlFor="pzn-rule-id">Rule ID</label>
                <input
                  id="pzn-rule-id"
                  value={ruleForm.ruleId}
                  disabled={Boolean(selectedRuleId)}
                  placeholder="e.g. high_cash_missing_bene"
                  onChange={(e) => setRuleForm((p) => ({ ...p, ruleId: e.target.value }))}
                />
              </div>
              <div className="pzn-field">
                <label htmlFor="pzn-rule-effect">Rule Action</label>
                <select
                  id="pzn-rule-effect"
                  value={ruleForm.effect}
                  onChange={(e) => setRuleForm((p) => ({ ...p, effect: e.target.value as PznRuleInput["effect"] }))}
                >
                  <option value="include_when_true">Include content when Rule returns TRUE</option>
                  <option value="exclude_when_true">Suppress / Exclude content when Rule returns TRUE</option>
                </select>
              </div>
              <div className="pzn-field">
                <label htmlFor="pzn-rule-comb">Clause Logic</label>
                <select
                  id="pzn-rule-comb"
                  value={ruleForm.rootGroup.combinator}
                  onChange={(e) => setRuleForm((p) => ({
                    ...p,
                    rootGroup: { ...p.rootGroup, combinator: e.target.value as "AND" | "OR" },
                  }))}
                >
                  <option value="AND">ALL conditions must be TRUE (AND)</option>
                  <option value="OR">ANY condition may be TRUE (OR)</option>
                </select>
              </div>
              <div className="pzn-field is-full">
                <label htmlFor="pzn-rule-desc">Business Definition / Intent</label>
                <textarea
                  id="pzn-rule-desc"
                  rows={2}
                  value={ruleForm.businessDescription}
                  placeholder="Explain the business eligibility intent of this rule..."
                  onChange={(e) => setRuleForm((p) => ({ ...p, businessDescription: e.target.value }))}
                />
              </div>
            </div>

            <div className="pzn-panel-head">
              <h3>Conditions ({ruleClauses.length})</h3>
              <button type="button" className="pzn-btn pzn-btn-sm" onClick={addClause}>
                <Plus size={13} /> Add Condition
              </button>
            </div>

            <div className="pzn-list">
              {ruleClauses.map((clause) => {
                const nsObj = workspace.dictionary.namespaces.find((n) => n.id === clause.namespaceId) ?? workspace.dictionary.namespaces[0];
                const attrObj = nsObj?.attributes.find((a) => a.id === clause.attributeId) ?? nsObj?.attributes[0];
                return (
                  <div key={clause.id} className="pzn-clause-card">
                    <div className="pzn-clause-row">
                      <select
                        aria-label="Namespace"
                        value={clause.namespaceId}
                        onChange={(e) => {
                          const nextNs = workspace.dictionary.namespaces.find((n) => n.id === e.target.value);
                          const nextAttr = nextNs?.attributes[0];
                          updateClause(clause.id, {
                            namespaceId: e.target.value,
                            attributeId: nextAttr?.id ?? "",
                            operator: nextAttr?.allowedOperators[0] ?? "eq",
                            value: defaultClauseValue(nextAttr),
                          });
                        }}
                      >
                        {workspace.dictionary.namespaces.map((ns) => (
                          <option key={ns.id} value={ns.id}>{ns.displayName} ({ns.id})</option>
                        ))}
                      </select>

                      <select
                        aria-label="Attribute"
                        value={clause.attributeId}
                        onChange={(e) => {
                          const nextAttr = nsObj?.attributes.find((a) => a.id === e.target.value);
                          updateClause(clause.id, {
                            attributeId: e.target.value,
                            operator: nextAttr?.allowedOperators[0] ?? "eq",
                            value: defaultClauseValue(nextAttr),
                          });
                        }}
                      >
                        {(nsObj?.attributes ?? []).map((a) => (
                          <option key={a.id} value={a.id}>{a.displayName} ({a.id})</option>
                        ))}
                      </select>

                      <select
                        aria-label="Operator"
                        value={clause.operator}
                        onChange={(e) => {
                          const op = e.target.value as PznOperator;
                          updateClause(clause.id, {
                            operator: op,
                            value: op === "exists" ? undefined : (op === "in" || op === "not_in")
                              ? (Array.isArray(clause.value) ? clause.value : [String(clause.value ?? "")])
                              : defaultClauseValue(attrObj),
                          });
                        }}
                      >
                        {(attrObj?.allowedOperators ?? ["eq"]).map((op) => (
                          <option key={op} value={op}>{pznOperatorLabels[op]}</option>
                        ))}
                      </select>

                      {clause.operator === "exists" ? (
                        <span className="pzn-subtitle" style={{ fontSize: "0.8rem" }}>Checks non-empty</span>
                      ) : (clause.operator === "in" || clause.operator === "not_in") ? (
                        <input
                          aria-label="Comma separated list"
                          value={Array.isArray(clause.value) ? clause.value.join(", ") : String(clause.value ?? "")}
                          placeholder="val1, val2"
                          onChange={(e) => updateClause(clause.id, { value: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                        />
                      ) : attrObj?.dataType === "enum" && attrObj.enumOptions.length > 0 ? (
                        <select
                          aria-label="Enum value"
                          value={String(clause.value ?? "")}
                          onChange={(e) => updateClause(clause.id, { value: e.target.value })}
                        >
                          {attrObj.enumOptions.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label} ({opt.value})</option>
                          ))}
                        </select>
                      ) : attrObj?.dataType === "boolean" ? (
                        <select
                          aria-label="Boolean value"
                          value={String(Boolean(clause.value))}
                          onChange={(e) => updateClause(clause.id, { value: e.target.value === "true" })}
                        >
                          <option value="true">True</option>
                          <option value="false">False</option>
                        </select>
                      ) : attrObj?.dataType === "number" || attrObj?.dataType === "currency_usd" ? (
                        <input
                          type="number"
                          aria-label="Numeric threshold"
                          value={typeof clause.value === "number" ? clause.value : Number(clause.value ?? 0)}
                          onChange={(e) => updateClause(clause.id, { value: Number(e.target.value) })}
                        />
                      ) : (
                        <input
                          aria-label="Text value"
                          value={String(clause.value ?? "")}
                          onChange={(e) => updateClause(clause.id, { value: e.target.value })}
                        />
                      )}

                      <button
                        type="button"
                        className="pzn-btn pzn-btn-sm pzn-btn-danger"
                        disabled={ruleClauses.length <= 1}
                        aria-label="Remove clause"
                        onClick={() => removeClause(clause.id)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>

                    {attrObj && (
                      <div className="pzn-biz-def">
                        <strong>{nsObj.id}.{attrObj.id}</strong> ({attrObj.dataType}{attrObj.unit ? `, ${attrObj.unit}` : ""}) — {attrObj.businessDefinition}
                        {attrObj.enumOptions.length > 0 && (
                          <span> Options: {attrObj.enumOptions.map((o) => `${o.value} (${o.definition || o.label})`).join(" · ")}</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="pzn-btn-row">
              <button
                type="button"
                className="pzn-btn pzn-btn-primary"
                disabled={busy || !ruleForm.ruleId.trim() || !ruleForm.name.trim() || !ruleForm.businessDescription.trim()}
                onClick={() => void runAction(
                  () => api.pznSaveRule(ruleForm),
                  `Saved rule "${ruleForm.name}".`,
                  (res) => {
                    setWorkspace(res.workspace);
                    loadRuleIntoForm(res.rule);
                  },
                )}
              >
                Save Rule
              </button>
              {selectedRuleId && (
                <button
                  type="button"
                  className="pzn-btn pzn-btn-danger"
                  disabled={busy}
                  onClick={() => void runAction(
                    () => api.pznDeleteRule(selectedRuleId),
                    `Deleted rule "${selectedRuleId}".`,
                    (res) => {
                      setWorkspace(res.workspace);
                      if (res.workspace.rules[0]) loadRuleIntoForm(res.workspace.rules[0]);
                      else setSelectedRuleId("");
                    },
                  )}
                >
                  <Trash2 size={14} /> Delete
                </button>
              )}
            </div>

            {/* Instant Rule Engine Test Bar */}
            <div className="pzn-stage-card" style={{ marginTop: 6 }}>
              <span className="pzn-stage-kicker">Rule Engine Instant Test</span>
              <div className="pzn-btn-row">
                <select
                  aria-label="Test Customer MID"
                  value={ruleTestMid}
                  onChange={(e) => setRuleTestMid(e.target.value)}
                  style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border)", flex: 1 }}
                >
                  {workspace.customers.map((c) => (
                    <option key={c.syntheticMid} value={c.syntheticMid}>
                      {c.displayName} · MID: {c.syntheticMid} ({c.segment})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="pzn-btn"
                  disabled={busy || !ruleTestMid}
                  onClick={() => void runAction(
                    () => api.pznTestRule(ruleTestMid, {
                      ...ruleForm,
                      ruleId: ruleForm.ruleId.trim() || "preview_rule",
                      name: ruleForm.name.trim() || "Preview Rule",
                      businessDescription: ruleForm.businessDescription.trim() || "Ad-hoc rule evaluation",
                    }),
                    "",
                    (res) => setRuleTestResult({ customerDisplayName: res.customerDisplayName, evaluation: res.evaluation }),
                  )}
                >
                  <Play size={14} /> Test Rule Against MID
                </button>
              </div>
              {ruleTestResult && (
                <div className="pzn-list">
                  <div className="pzn-btn-row">
                    <strong>{ruleTestResult.customerDisplayName}</strong>
                    <span className={"pzn-badge " + (ruleTestResult.evaluation.matched ? "is-pass" : "is-fail")}>
                      Rule Returned: {ruleTestResult.evaluation.matched ? "TRUE" : "FALSE"}
                    </span>
                    <span className="pzn-subtitle" style={{ fontSize: "0.82rem" }}>{ruleTestResult.evaluation.summary}</span>
                  </div>
                  {ruleTestResult.evaluation.clauses.map((cl) => (
                    <div key={cl.clauseId} className="pzn-biz-def">
                      {cl.passed ? "✓" : "✗"} {cl.reason}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {/* ============ TAB 4: DATA DICTIONARY ============ */}
      {tab === "dictionary" && (
        <div className="pzn-split">
          <section className="pzn-panel" aria-label="Namespaces">
            <div className="pzn-panel-head">
              <h2>Namespaces</h2>
              <button type="button" className="pzn-btn pzn-btn-sm pzn-btn-primary" onClick={() => setShowNewNs((v) => !v)}>
                <Plus size={14} /> {showNewNs ? "Close" : "New Namespace"}
              </button>
            </div>

            {showNewNs && (
              <div className="pzn-attachment-card">
                <div className="pzn-field">
                  <label htmlFor="pzn-ns-name">Display Name</label>
                  <input
                    id="pzn-ns-name"
                    value={nsForm.displayName}
                    placeholder="e.g. Loyalty & Rewards"
                    onChange={(e) => setNsForm((p) => ({ ...p, displayName: e.target.value, id: slugify(e.target.value) }))}
                  />
                </div>
                <div className="pzn-field">
                  <label htmlFor="pzn-ns-id">Namespace ID</label>
                  <input id="pzn-ns-id" value={nsForm.id} placeholder="e.g. loyalty" onChange={(e) => setNsForm((p) => ({ ...p, id: e.target.value }))} />
                </div>
                <div className="pzn-field">
                  <label htmlFor="pzn-ns-def">Business Definition</label>
                  <textarea id="pzn-ns-def" rows={2} value={nsForm.businessDefinition} placeholder="Business domain owned by this namespace..." onChange={(e) => setNsForm((p) => ({ ...p, businessDefinition: e.target.value }))} />
                </div>
                <div className="pzn-field">
                  <label htmlFor="pzn-ns-owner">Data Owner</label>
                  <input id="pzn-ns-owner" value={nsForm.owner} onChange={(e) => setNsForm((p) => ({ ...p, owner: e.target.value }))} />
                </div>
                <div className="pzn-field">
                  <label htmlFor="pzn-ns-src">Source System</label>
                  <select id="pzn-ns-src" value={nsForm.sourceSystem} onChange={(e) => setNsForm((p) => ({ ...p, sourceSystem: e.target.value as PznSourceSystem }))}>
                    {pznSourceSystems.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <button
                  type="button"
                  className="pzn-btn pzn-btn-primary pzn-btn-sm"
                  disabled={busy || !nsForm.id.trim() || !nsForm.displayName.trim() || !nsForm.businessDefinition.trim()}
                  onClick={() => void runAction(
                    () => api.pznSaveNamespace(nsForm),
                    `Saved namespace "${nsForm.id}".`,
                    (res) => {
                      setWorkspace(res.workspace);
                      const nsId = res.namespace?.id ?? nsForm.id;
                      setSelectedNsId(nsId);
                      setAttrForm((a) => ({ ...a, namespaceId: nsId }));
                      setShowNewNs(false);
                      setNsForm({ id: "", displayName: "", businessDefinition: "", owner: "Personalization Team", sourceSystem: "custom_attribute" });
                    },
                  )}
                >
                  Save Namespace
                </button>
              </div>
            )}

            <div className="pzn-list">
              {workspace.dictionary.namespaces.map((ns) => (
                <button
                  key={ns.id}
                  type="button"
                  className={"pzn-list-item" + (selectedNsId === ns.id ? " is-selected" : "")}
                  onClick={() => {
                    setSelectedNsId(ns.id);
                    setAttrForm((a) => ({ ...a, namespaceId: ns.id }));
                  }}
                >
                  <div className="pzn-list-top">
                    <strong>{ns.displayName}</strong>
                    <span className="pzn-badge">{ns.attributes.length} attr</span>
                  </div>
                  <div className="pzn-list-meta">
                    <span className="pzn-code">{ns.id}.*</span>
                    <span>{ns.owner}</span>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="pzn-panel" aria-label="Namespace attributes">
            {activeNamespace && (
              <>
                <div className="pzn-panel-head">
                  <div>
                    <h2>{activeNamespace.displayName} (<span className="pzn-code">{activeNamespace.id}</span>)</h2>
                    <p className="pzn-subtitle" style={{ marginTop: 4 }}>{activeNamespace.businessDefinition}</p>
                  </div>
                  <div className="pzn-btn-row">
                    <span className="pzn-badge">Owner: {activeNamespace.owner}</span>
                    <span className="pzn-badge">Source: {activeNamespace.sourceSystem}</span>
                    {!activeNamespace.builtIn && (
                      <button
                        type="button"
                        className="pzn-btn pzn-btn-sm pzn-btn-danger"
                        disabled={busy}
                        onClick={() => void runAction(
                          () => api.pznDeleteNamespace(activeNamespace.id),
                          `Deleted namespace "${activeNamespace.id}".`,
                          (res) => {
                            setWorkspace(res.workspace);
                            setSelectedNsId(res.workspace.dictionary.namespaces[0]?.id ?? "");
                          },
                        )}
                      >
                        <Trash2 size={13} /> Delete NS
                      </button>
                    )}
                  </div>
                </div>

                <div className="pzn-list">
                  {activeNamespace.attributes.map((attr) => (
                    <div key={attr.id} className="pzn-attr-card">
                      <div className="pzn-attr-head">
                        <div className="pzn-btn-row">
                          <span className="pzn-code">{attr.namespaceId}.{attr.id}</span>
                          <strong>{attr.displayName}</strong>
                          <span className="pzn-badge">{attr.dataType}{attr.unit ? ` (${attr.unit})` : ""}</span>
                          <span className="pzn-badge">Resolver: {attr.resolverPath}</span>
                        </div>
                        {!attr.builtIn && (
                          <button
                            type="button"
                            className="pzn-btn pzn-btn-sm pzn-btn-danger"
                            disabled={busy}
                            onClick={() => void runAction(
                              () => api.pznDeleteAttribute(attr.namespaceId, attr.id),
                              `Deleted attribute "${attr.namespaceId}.${attr.id}".`,
                              (res) => setWorkspace(res.workspace),
                            )}
                          >
                            <Trash2 size={12} /> Remove
                          </button>
                        )}
                      </div>
                      <p className="pzn-subtitle" style={{ color: "var(--text)", fontSize: "0.85rem" }}>{attr.businessDefinition}</p>
                      <div className="pzn-list-meta">
                        <span>Operators: {attr.allowedOperators.join(", ")}</span>
                        {attr.sampleValue && <span>Sample: <strong>{attr.sampleValue}</strong></span>}
                        {attr.enumOptions.length > 0 && (
                          <span>Values: {attr.enumOptions.map((o) => `${o.value} (${o.definition || o.label})`).join(" | ")}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="pzn-stage-card">
                  <span className="pzn-stage-kicker">Add / Update Attribute in {activeNamespace.id}.*</span>
                  <div className="pzn-form-grid">
                    <div className="pzn-field">
                      <label htmlFor="pzn-attr-name">Display Name</label>
                      <input
                        id="pzn-attr-name"
                        value={attrForm.displayName}
                        placeholder="e.g. Risk Tolerance Tier"
                        onChange={(e) => {
                          const displayName = e.target.value;
                          const nextId = slugify(displayName);
                          setAttrForm((p) => ({
                            ...p,
                            namespaceId: activeNamespace.id,
                            displayName,
                            id: nextId,
                            resolverPath: `customAttributes.${nextId}`,
                          }));
                        }}
                      />
                    </div>
                    <div className="pzn-field">
                      <label htmlFor="pzn-attr-id">Attribute ID</label>
                      <input id="pzn-attr-id" value={attrForm.id} placeholder="e.g. risk_tolerance" onChange={(e) => setAttrForm((p) => ({ ...p, id: e.target.value }))} />
                    </div>
                    <div className="pzn-field">
                      <label htmlFor="pzn-attr-type">Data Type</label>
                      <select
                        id="pzn-attr-type"
                        value={attrForm.dataType}
                        onChange={(e) => {
                          const dt = e.target.value as PznDataType;
                          setAttrForm((p) => ({ ...p, dataType: dt, allowedOperators: defaultOperatorsForType(dt) }));
                        }}
                      >
                        {pznDataTypes.map((dt) => <option key={dt} value={dt}>{dt}</option>)}
                      </select>
                    </div>
                    <div className="pzn-field">
                      <label htmlFor="pzn-attr-resolver">Live Resolver Path (Customer 360 / Custom Attr)</label>
                      <input
                        id="pzn-attr-resolver"
                        value={attrForm.resolverPath}
                        placeholder="customAttributes.risk_tolerance"
                        onChange={(e) => setAttrForm((p) => ({ ...p, resolverPath: e.target.value }))}
                      />
                    </div>
                    <div className="pzn-field">
                      <label htmlFor="pzn-attr-unit">Unit (optional)</label>
                      <input id="pzn-attr-unit" value={attrForm.unit} placeholder="USD, %, pts" onChange={(e) => setAttrForm((p) => ({ ...p, unit: e.target.value }))} />
                    </div>
                    <div className="pzn-field">
                      <label htmlFor="pzn-attr-sample">Sample Value</label>
                      <input id="pzn-attr-sample" value={attrForm.sampleValue} placeholder="e.g. aggressive" onChange={(e) => setAttrForm((p) => ({ ...p, sampleValue: e.target.value }))} />
                    </div>
                    <div className="pzn-field is-full">
                      <label htmlFor="pzn-attr-def">Business Definition (shown inline inside Rule Builder)</label>
                      <textarea
                        id="pzn-attr-def"
                        rows={2}
                        value={attrForm.businessDefinition}
                        placeholder="Precise business meaning, calculation logic, and governance notes..."
                        onChange={(e) => setAttrForm((p) => ({ ...p, businessDefinition: e.target.value }))}
                      />
                    </div>
                    {attrForm.dataType === "enum" && (
                      <div className="pzn-field is-full">
                        <label htmlFor="pzn-attr-enums">Enum Values (one per line: value:Label:Business definition)</label>
                        <textarea
                          id="pzn-attr-enums"
                          rows={3}
                          value={enumLinesInput}
                          placeholder={"conservative:Conservative:Capital preservation focus\nmoderate:Moderate:Balanced growth and income\naggressive:Aggressive:Long-term equity growth"}
                          onChange={(e) => setEnumLinesInput(e.target.value)}
                        />
                      </div>
                    )}
                    <div className="pzn-field is-full">
                      <label>Allowed Operators</label>
                      <div className="pzn-rule-chips">
                        {pznOperators.map((op) => {
                          const checked = attrForm.allowedOperators.includes(op);
                          return (
                            <button
                              key={op}
                              type="button"
                              className={"pzn-rule-chip" + (checked ? " is-checked" : "")}
                              onClick={() => setAttrForm((p) => ({
                                ...p,
                                allowedOperators: checked
                                  ? (p.allowedOperators.length > 1 ? p.allowedOperators.filter((x) => x !== op) : p.allowedOperators)
                                  : [...p.allowedOperators, op],
                              }))}
                            >
                              {checked && <Check size={12} />} {pznOperatorLabels[op]}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="pzn-btn pzn-btn-primary"
                    disabled={busy || !attrForm.id.trim() || !attrForm.displayName.trim() || !attrForm.businessDefinition.trim()}
                    onClick={() => {
                      const enumOptions = attrForm.dataType === "enum"
                        ? enumLinesInput.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
                            const [value, label, ...rest] = line.split(":");
                            return { value: value.trim(), label: (label ?? value).trim(), definition: rest.join(":").trim() };
                          })
                        : [];
                      void runAction(
                        () => api.pznSaveAttribute({ ...attrForm, namespaceId: activeNamespace.id, enumOptions }),
                        `Saved Data Dictionary attribute "${activeNamespace.id}.${attrForm.id}".`,
                        (res) => {
                          setWorkspace(res.workspace);
                          setAttrForm((p) => ({
                            ...p,
                            id: "",
                            displayName: "",
                            businessDefinition: "",
                            sampleValue: "",
                            resolverPath: "customAttributes.",
                          }));
                          setEnumLinesInput("");
                        },
                      );
                    }}
                  >
                    <Plus size={14} /> Save Attribute to Data Dictionary
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {/* ============ TAB 5: LIVE TS SIMULATOR ============ */}
      {tab === "simulator" && (
        <div className="pzn-list" style={{ gap: 16 }}>
          <section className="pzn-panel" aria-label="Treatment Selector request controls">
            <div className="pzn-panel-head">
              <h2>Live Treatment Selector Evaluation (MID + Context → Rule Engine → Experience Layer)</h2>
            </div>

            <div className="pzn-form-grid">
              <div className="pzn-field">
                <label htmlFor="pzn-sim-mid">Customer MID</label>
                <select id="pzn-sim-mid" value={simMid} onChange={(e) => setSimMid(e.target.value)}>
                  {workspace.customers.map((c) => (
                    <option key={c.syntheticMid} value={c.syntheticMid}>
                      {c.displayName} · MID: {c.syntheticMid} ({c.segment})
                    </option>
                  ))}
                  <option value="__custom__">Custom MID…</option>
                </select>
                {simMid === "__custom__" && (
                  <input
                    placeholder="Enter any MID (e.g. mid_demo_custom_01)"
                    value={simCustomMid}
                    onChange={(e) => setSimCustomMid(e.target.value)}
                  />
                )}
              </div>

              <div className="pzn-field">
                <label htmlFor="pzn-sim-ctx">Target Context</label>
                <select id="pzn-sim-ctx" value={simContextId} onChange={(e) => setSimContextId(e.target.value)}>
                  {workspace.contexts.map((ctx) => (
                    <option key={ctx.contextId} value={ctx.contextId}>
                      {ctx.displayName} ({ctx.contextId}) — {ctx.status === "published" ? `Published v${ctx.publishedVersion}` : "Draft"}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="pzn-btn-row" style={{ justifyContent: "space-between" }}>
              <div className="pzn-btn-row">
                <select
                  aria-label="What-if attribute override"
                  value={simOverrideKey}
                  onChange={(e) => setSimOverrideKey(e.target.value)}
                  style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", fontSize: "0.82rem" }}
                >
                  <option value="">+ What-if attribute override…</option>
                  {workspace.dictionary.namespaces.flatMap((ns) => ns.attributes.map((a) => (
                    <option key={`${ns.id}.${a.id}`} value={`${ns.id}.${a.id}`}>{ns.id}.{a.id} ({a.dataType})</option>
                  )))}
                </select>
                {simOverrideKey && (
                  <>
                    <input
                      aria-label="Override value"
                      placeholder="Value (e.g. 5000)"
                      value={simOverrideVal}
                      onChange={(e) => setSimOverrideVal(e.target.value)}
                      style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", fontSize: "0.82rem", width: 150 }}
                    />
                    <button type="button" className="pzn-btn pzn-btn-sm" onClick={addOverride}>Apply Override</button>
                  </>
                )}
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "0.82rem", color: "var(--muted)" }}>
                  <input type="checkbox" checked={simUseDraft} onChange={(e) => setSimUseDraft(e.target.checked)} />
                  Evaluate Draft (include unpublished edits)
                </label>
              </div>

              <button
                type="button"
                className="pzn-btn pzn-btn-primary"
                disabled={busy || !simContextId || !(simMid === "__custom__" ? simCustomMid.trim() : simMid)}
                onClick={() => {
                  const targetMid = simMid === "__custom__" ? simCustomMid.trim() : simMid;
                  void runAction(
                    () => api.pznEvaluateTs({
                      mid: targetMid,
                      contextId: simContextId,
                      useDraft: simUseDraft,
                      ...(Object.keys(simOverrides).length > 0 ? { attributeOverrides: simOverrides } : {}),
                    }),
                    "",
                    (res) => setSimResult(res),
                  );
                }}
              >
                <Play size={14} /> Run Live Treatment Selector
              </button>
            </div>

            {Object.keys(simOverrides).length > 0 && (
              <div className="pzn-rule-chips">
                <span className="pzn-subtitle" style={{ fontSize: "0.78rem" }}>Active Overrides:</span>
                {Object.entries(simOverrides).map(([k, v]) => (
                  <button
                    key={k}
                    type="button"
                    className="pzn-rule-chip is-checked"
                    onClick={() => setSimOverrides((p) => {
                      const next = { ...p };
                      delete next[k];
                      return next;
                    })}
                  >
                    {k} = {String(v)} ×
                  </button>
                ))}
              </div>
            )}
          </section>

          {simResult && (
            <>
              <div className="pzn-pipeline-grid">
                {/* Stage 1 & 2: TS Lookup + Hydrated Attributes */}
                <section className="pzn-stage-card">
                  <span className="pzn-stage-kicker">Stage 1 &amp; 2 · Treatment Selector &amp; Hydrated Attributes</span>
                  <div className="pzn-btn-row">
                    <strong>{simResult.customerDisplayName}</strong>
                    <span className="pzn-code">{simResult.mid}</span>
                    <span className="pzn-badge is-published">
                      {simResult.sourceMode === "published" ? `Published v${simResult.publicationVersion}` : "Draft Preview"}
                    </span>
                    <span className="pzn-badge">{simResult.durationMs}ms</span>
                  </div>
                  <div className="pzn-attr-kv-grid">
                    {Object.entries(simResult.resolvedAttributes)
                      .filter(([, val]) => val !== undefined && val !== null)
                      .map(([key, val]) => (
                        <div key={key} className="pzn-attr-kv">
                          <span>{key}</span>
                          <strong>{String(val)}</strong>
                        </div>
                      ))}
                  </div>
                </section>

                {/* Stage 3: Rule Engine Output */}
                <section className="pzn-stage-card">
                  <span className="pzn-stage-kicker">Stage 3 · Rule Engine Execution ({simResult.ruleResults.length} Rules)</span>
                  {simResult.ruleResults.length === 0 ? (
                    <p className="pzn-subtitle">No filtering rules attached to this context — all attached contents pass through.</p>
                  ) : (
                    <div className="pzn-list">
                      {simResult.ruleResults.map((r) => (
                        <div key={r.ruleId} className="pzn-attr-card">
                          <div className="pzn-attr-head">
                            <strong>{r.ruleName}</strong>
                            <span className={"pzn-badge " + (r.effectiveAllow ? "is-pass" : "is-fail")}>
                              {r.matched ? "TRUE" : "FALSE"} → {r.effectiveAllow ? "ALLOW" : "FILTER OUT"}
                            </span>
                          </div>
                          {r.clauses.map((cl) => (
                            <div key={cl.clauseId} className="pzn-biz-def">
                              {cl.passed ? "✓" : "✗"} {cl.reason}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>

              {/* Stage 4: Filtered Eligibility & Experience Layer Output */}
              <div className="pzn-pipeline-grid">
                <section className="pzn-stage-card" aria-label="Eligible content returned to Experience Layer">
                  <div className="pzn-panel-head">
                    <span className="pzn-stage-kicker" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <CheckCircle2 size={15} /> Stage 4A · Eligible Content → Experience Layer ({simResult.eligibleContents.length})
                    </span>
                  </div>
                  {simResult.eligibleContents.length === 0 ? (
                    <p className="pzn-subtitle">Zero eligible contents returned for this MID. The Experience Layer will suppress this placement cleanly.</p>
                  ) : (
                    <div className="pzn-list">
                      {simResult.eligibleContents.map((item) => (
                        <article key={item.contentId} className="pzn-exp-card">
                          <div className="pzn-attr-head">
                            <span className="pzn-rank-pill">Rank #{item.rank}</span>
                            <span className="pzn-code">{item.contentId}</span>
                            <span className="pzn-badge is-pass">ELIGIBLE</span>
                          </div>
                          <h4>{item.title}</h4>
                          {item.headline && <p className="pzn-exp-headline">{item.headline}</p>}
                          <p className="pzn-exp-body">{item.renderedBody}</p>
                          {item.ctaLabel && (
                            <div className="pzn-btn-row" style={{ marginTop: 4 }}>
                              <span className="pzn-badge is-published">{item.ctaLabel}</span>
                            </div>
                          )}
                          <p className="pzn-exp-disclosure">{item.reason}</p>
                        </article>
                      ))}
                    </div>
                  )}
                </section>

                <section className="pzn-stage-card" aria-label="Filtered out content">
                  <div className="pzn-panel-head">
                    <span className="pzn-stage-kicker" style={{ color: "#b45309", display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <XCircle size={15} /> Stage 4B · Filtered Out by Rule Engine ({simResult.filteredOutContents.length})
                    </span>
                  </div>
                  {simResult.filteredOutContents.length === 0 ? (
                    <p className="pzn-subtitle">All attached contents passed rule evaluation for this customer.</p>
                  ) : (
                    <div className="pzn-list">
                      {simResult.filteredOutContents.map((item) => (
                        <div key={item.contentId} className="pzn-filtered-card">
                          <div className="pzn-attr-head">
                            <strong>{item.title}</strong>
                            <span className="pzn-badge is-fail">{item.reasonCode}</span>
                          </div>
                          <span className="pzn-code">{item.contentId}</span>
                          <p className="pzn-subtitle" style={{ marginTop: 4, color: "var(--text)", fontSize: "0.82rem" }}>{item.reason}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ cursor: "pointer", fontSize: "0.8rem", fontWeight: 600, color: "var(--muted)" }}>
                      View Experience Layer JSON Payload ({simResult.experiencePayload.eligibleContentIds.length} eligible)
                    </summary>
                    <pre style={{ fontSize: "0.75rem", overflowX: "auto", padding: 10, borderRadius: 8, background: "var(--surface-2)" }}>
                      {JSON.stringify(simResult.experiencePayload, null, 2)}
                    </pre>
                  </details>
                </section>
              </div>
            </>
          )}
        </div>
      )}
    </main>
  );
}
