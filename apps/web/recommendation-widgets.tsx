import { useMemo, useState } from "react";
import {
  BookOpen,
  Check,
  CheckCircle2,
  FileText,
  Layers,
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
  type PznAttribute,
  type PznDataType,
  type PznOperator,
  type PznRule,
  type PznRuleClause,
  type PznRuleEvalResult,
  type PznRuleInput,
  type PznRuleValue,
  type PznStudioWorkspaceState,
  type PznTsEvaluationResult,
} from "../../packages/contracts/self-service-pzn";
import { api, toolSetupErrorMessage } from "./api";
import type { ApprovalRecord } from "../../packages/contracts/approval";
import { ApprovalRequestCard } from "./recommendation-approvals";

function slugify(value: string, fallback = "item_1"): string {
  const s = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+/g, "_");
  return s.slice(0, 56) || fallback;
}

function defaultClauseVal(attr?: PznAttribute): PznRuleValue {
  if (!attr) return "";
  if (attr.dataType === "boolean") return true;
  if (attr.dataType === "number" || attr.dataType === "currency_usd") return Number(attr.sampleValue) || 0;
  if (attr.dataType === "enum") return attr.enumOptions[0]?.value ?? "";
  return attr.sampleValue || "";
}

function defaultOps(dataType: PznDataType): PznOperator[] {
  if (dataType === "enum") return ["eq", "ne", "in", "not_in"];
  if (dataType === "boolean") return ["eq", "ne"];
  if (dataType === "number" || dataType === "currency_usd") return ["eq", "ne", "gt", "gte", "lt", "lte"];
  return ["eq", "ne", "contains", "exists"];
}

/* ============================================================================
 * 1. INTERACTIVE RULE BUILDER WIDGET (Usable in Workspace & Inline in Chat!)
 * ========================================================================== */
export function RuleBuilderWidget({
  workspace,
  activeMid,
  initialNamespaceId,
  initialAttributeId,
  onWorkspaceChange,
  onRunPrompt,
}: {
  workspace: PznStudioWorkspaceState;
  activeMid: string;
  initialNamespaceId?: string;
  initialAttributeId?: string;
  onWorkspaceChange: (ws: PznStudioWorkspaceState) => void;
  onRunPrompt?: (prompt: string) => void;
}) {
  const initNs = workspace.dictionary.namespaces.find((n) => n.id === initialNamespaceId) ?? workspace.dictionary.namespaces[0];
  const initAttr = initNs?.attributes.find((a) => a.id === initialAttributeId) ?? initNs?.attributes[0];

  const [name, setName] = useState("");
  const [ruleId, setRuleId] = useState("");
  const [businessDescription, setBusinessDescription] = useState("");
  const [effect, setEffect] = useState<"include_when_true" | "exclude_when_true">("include_when_true");
  const [combinator, setCombinator] = useState<"AND" | "OR">("AND");
  const [clauses, setClauses] = useState<PznRuleClause[]>([
    {
      id: "cl_1",
      kind: "clause",
      namespaceId: initNs?.id ?? "portfolio",
      attributeId: initAttr?.id ?? "cash_usd",
      operator: initAttr?.allowedOperators[0] ?? "gt",
      value: defaultClauseVal(initAttr),
    },
  ]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState<{ customerDisplayName: string; evaluation: PznRuleEvalResult } | null>(null);

  const buildPayload = (): PznRuleInput => ({
    ruleId: ruleId.trim() || slugify(name || "custom_rule"),
    name: name.trim() || "Custom Eligibility Rule",
    businessDescription: businessDescription.trim() || `Evaluates ${clauses.map((c) => `${c.namespaceId}.${c.attributeId}`).join(` ${combinator} `)}`,
    effect,
    status: "published",
    rootGroup: { id: "grp_root", kind: "group", combinator, children: clauses },
  });

  async function handleTest() {
    setBusy(true);
    setError("");
    try {
      const res = await api.pznTestRule(activeMid, buildPayload());
      setTestResult({ customerDisplayName: res.customerDisplayName, evaluation: res.evaluation });
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    if (!name.trim()) {
      setError("Enter a rule name first.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await api.pznSaveRule(buildPayload());
      onWorkspaceChange(res.workspace);
      setNotice(`Saved rule "${res.rule.name}" (${res.rule.ruleId}) to the Rule Engine catalog.`);
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="content-card pzn-widget-card" aria-label="Rule Builder Widget">
      <div className="pzn-widget-head">
        <div>
          <span className="pzn-stage-kicker"><SlidersHorizontal size={13} /> INTERACTIVE RULE BUILDER WIDGET</span>
          <h3>Define a Data Dictionary Rule</h3>
        </div>
        <span className="pzn-badge">Dict: {workspace.dictionary.version}</span>
      </div>

      {notice && <p className="pzn-notice" role="status">{notice}</p>}
      {error && <p className="pzn-error" role="alert">{error}</p>}

      <div className="pzn-form-grid">
        <div className="pzn-field">
          <label>Rule Name</label>
          <input
            value={name}
            placeholder="e.g. High Cash Mass Affluent"
            onChange={(e) => {
              setName(e.target.value);
              setRuleId(slugify(e.target.value, "custom_rule"));
            }}
          />
        </div>
        <div className="pzn-field">
          <label>Rule ID</label>
          <input value={ruleId} placeholder="high_cash_mass_affluent" onChange={(e) => setRuleId(e.target.value)} />
        </div>
        <div className="pzn-field">
          <label>Rule Effect</label>
          <select value={effect} onChange={(e) => setEffect(e.target.value as "include_when_true" | "exclude_when_true")}>
            <option value="include_when_true">Include content when TRUE</option>
            <option value="exclude_when_true">Suppress content when TRUE</option>
          </select>
        </div>
        <div className="pzn-field">
          <label>Condition Logic</label>
          <select value={combinator} onChange={(e) => setCombinator(e.target.value as "AND" | "OR")}>
            <option value="AND">ALL conditions TRUE (AND)</option>
            <option value="OR">ANY condition TRUE (OR)</option>
          </select>
        </div>
        <div className="pzn-field is-full">
          <label>Business Description</label>
          <input value={businessDescription} placeholder="Describe the targeting or eligibility intent..." onChange={(e) => setBusinessDescription(e.target.value)} />
        </div>
      </div>

      <div className="pzn-list">
        {clauses.map((cl) => {
          const nsObj = workspace.dictionary.namespaces.find((n) => n.id === cl.namespaceId) ?? workspace.dictionary.namespaces[0];
          const attrObj = nsObj?.attributes.find((a) => a.id === cl.attributeId) ?? nsObj?.attributes[0];
          const patch = (next: Partial<PznRuleClause>) => setClauses((prev) => prev.map((c) => (c.id === cl.id ? { ...c, ...next } : c)));
          return (
            <div key={cl.id} className="pzn-clause-card">
              <div className="pzn-clause-row">
                <select
                  aria-label="Rule clause namespace"
                  value={cl.namespaceId}
                  onChange={(e) => {
                    const nextNs = workspace.dictionary.namespaces.find((n) => n.id === e.target.value);
                    const nextAttr = nextNs?.attributes[0];
                    patch({
                      namespaceId: e.target.value,
                      attributeId: nextAttr?.id ?? "",
                      operator: nextAttr?.allowedOperators[0] ?? "eq",
                      value: defaultClauseVal(nextAttr),
                    });
                  }}
                >
                  {workspace.dictionary.namespaces.map((n) => <option key={n.id} value={n.id}>{n.displayName} ({n.id})</option>)}
                </select>
                <select
                  aria-label="Rule clause attribute"
                  value={cl.attributeId}
                  onChange={(e) => {
                    const nextAttr = nsObj?.attributes.find((a) => a.id === e.target.value);
                    patch({
                      attributeId: e.target.value,
                      operator: nextAttr?.allowedOperators[0] ?? "eq",
                      value: defaultClauseVal(nextAttr),
                    });
                  }}
                >
                  {(nsObj?.attributes ?? []).map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}
                </select>
                <select
                  aria-label="Rule clause operator"
                  value={cl.operator}
                  onChange={(e) => {
                    const op = e.target.value as PznOperator;
                    patch({ operator: op, value: op === "exists" ? undefined : defaultClauseVal(attrObj) });
                  }}
                >
                  {(attrObj?.allowedOperators ?? ["eq"]).map((op) => <option key={op} value={op}>{pznOperatorLabels[op]}</option>)}
                </select>
                {cl.operator === "exists" ? (
                  <span className="pzn-subtitle" style={{ fontSize: "0.78rem" }}>Non-empty</span>
                ) : attrObj?.dataType === "enum" && attrObj.enumOptions.length > 0 ? (
                  <select aria-label="Rule clause value" value={String(cl.value ?? "")} onChange={(e) => patch({ value: e.target.value })}>
                    {attrObj.enumOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : attrObj?.dataType === "boolean" ? (
                  <select aria-label="Rule clause value" value={String(Boolean(cl.value))} onChange={(e) => patch({ value: e.target.value === "true" })}>
                    <option value="true">True</option>
                    <option value="false">False</option>
                  </select>
                ) : attrObj?.dataType === "number" || attrObj?.dataType === "currency_usd" ? (
                  <input type="number" aria-label="Rule clause value" value={typeof cl.value === "number" ? cl.value : Number(cl.value ?? 0)} onChange={(e) => patch({ value: Number(e.target.value) })} />
                ) : (
                  <input aria-label="Rule clause value" value={String(cl.value ?? "")} onChange={(e) => patch({ value: e.target.value })} />
                )}
                <button
                  type="button"
                  className="pzn-btn pzn-btn-sm pzn-btn-danger"
                  disabled={clauses.length <= 1}
                  aria-label="Remove condition"
                  onClick={() => setClauses((prev) => prev.filter((c) => c.id !== cl.id))}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              {attrObj && (
                <div className="pzn-biz-def">
                  <strong>{nsObj.id}.{attrObj.id}</strong> — {attrObj.businessDefinition}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="pzn-btn-row">
        <button
          type="button"
          className="pzn-btn pzn-btn-sm"
          onClick={() => {
            const ns = workspace.dictionary.namespaces[0];
            const attr = ns?.attributes[0];
            if (!ns || !attr) return;
            setClauses((prev) => [
              ...prev,
              { id: "cl_" + Date.now().toString(36).slice(-4), kind: "clause", namespaceId: ns.id, attributeId: attr.id, operator: attr.allowedOperators[0] ?? "eq", value: defaultClauseVal(attr) },
            ]);
          }}
        >
          <Plus size={13} /> Add Condition
        </button>
        <button type="button" className="pzn-btn pzn-btn-sm" disabled={busy} onClick={() => void handleTest()}>
          <Play size={13} /> Test on {activeMid}
        </button>
        <button type="button" className="pzn-btn pzn-btn-primary pzn-btn-sm" disabled={busy || !name.trim()} onClick={() => void handleSave()}>
          <Check size={13} /> Save Rule
        </button>
        {notice && onRunPrompt && (
          <button type="button" className="pzn-btn pzn-btn-sm" onClick={() => onRunPrompt("Show all contexts with attached contents and rules")}>
            Attach to a Context →
          </button>
        )}
      </div>

      {testResult && (
        <div className="pzn-attr-card">
          <div className="pzn-attr-head">
            <strong>Live Rule Engine Check · {testResult.customerDisplayName}</strong>
            <span className={"pzn-badge " + (testResult.evaluation.matched ? "is-pass" : "is-fail")}>
              {testResult.evaluation.matched ? "TRUE" : "FALSE"} → {testResult.evaluation.effectiveAllow ? "ALLOW" : "FILTER OUT"}
            </span>
          </div>
          {testResult.evaluation.clauses.map((cl) => (
            <div key={cl.clauseId} className="pzn-biz-def">{cl.passed ? "✓" : "✗"} {cl.reason}</div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ============================================================================
 * 2. RULES CATALOG WIDGET (Shows All Rules + Live MID Testing)
 * ========================================================================== */
export function RulesCatalogWidget({
  workspace,
  activeMid,
  onRunPrompt,
}: {
  workspace: PznStudioWorkspaceState;
  activeMid: string;
  onRunPrompt?: (prompt: string) => void;
}) {
  const [resultsByRule, setResultsByRule] = useState<Record<string, PznRuleEvalResult>>({});
  const [testingId, setTestingId] = useState<string>("");

  const attrMap = useMemo(() => {
    const map = new Map<string, PznAttribute>();
    for (const ns of workspace.dictionary.namespaces) {
      for (const a of ns.attributes) map.set(`${ns.id}.${a.id}`, a);
    }
    return map;
  }, [workspace]);

  async function testRuleNow(rule: PznRule) {
    setTestingId(rule.ruleId);
    try {
      const res = await api.pznTestRule(activeMid, {
        ruleId: rule.ruleId,
        name: rule.name,
        businessDescription: rule.businessDescription,
        effect: rule.effect,
        status: rule.status,
        rootGroup: rule.rootGroup,
      });
      setResultsByRule((prev) => ({ ...prev, [rule.ruleId]: res.evaluation }));
    } finally {
      setTestingId("");
    }
  }

  return (
    <section className="content-card pzn-widget-card" aria-label="Rules Catalog Widget">
      <div className="pzn-widget-head">
        <div>
          <span className="pzn-stage-kicker"><SlidersHorizontal size={13} /> GOVERNED RULES CATALOG ({workspace.rules.length})</span>
          <h3>Active Eligibility &amp; Suppression Rules</h3>
        </div>
        {onRunPrompt && (
          <button type="button" className="pzn-btn pzn-btn-sm pzn-btn-primary" onClick={() => onRunPrompt("Open the interactive rule builder widget")}>
            <Plus size={13} /> Define Rule
          </button>
        )}
      </div>

      <div className="pzn-list">
        {workspace.rules.map((rule) => {
          const clauses = rule.rootGroup.children.filter((c): c is PznRuleClause => c.kind === "clause");
          const evalRes = resultsByRule[rule.ruleId];
          const usedIn = workspace.contexts
            .filter((ctx) => ctx.contextRuleIds.includes(rule.ruleId) || ctx.attachments.some((a) => a.ruleIds.includes(rule.ruleId)))
            .map((ctx) => ctx.contextId);
          return (
            <div key={rule.ruleId} className="pzn-attr-card">
              <div className="pzn-attr-head">
                <div className="pzn-btn-row">
                  <strong>{rule.name}</strong>
                  <span className="pzn-code">{rule.ruleId}</span>
                  <span className={"pzn-badge " + (rule.effect === "include_when_true" ? "is-published" : "is-warn")}>
                    {rule.effect === "include_when_true" ? "Include" : "Suppress"} · {rule.rootGroup.combinator}
                  </span>
                </div>
                <button type="button" className="pzn-btn pzn-btn-sm" disabled={testingId === rule.ruleId} onClick={() => void testRuleNow(rule)}>
                  <Play size={12} /> {testingId === rule.ruleId ? "Testing…" : `Test (${activeMid})`}
                </button>
              </div>
              <p className="pzn-subtitle" style={{ fontSize: "0.82rem" }}>{rule.businessDescription}</p>
              <div className="pzn-list">
                {clauses.map((cl) => {
                  const key = `${cl.namespaceId}.${cl.attributeId}`;
                  const attr = attrMap.get(key);
                  return (
                    <div key={cl.id} className="pzn-biz-def" style={{ fontSize: "0.78rem" }}>
                      <strong>{key}</strong> {pznOperatorLabels[cl.operator]} <strong>{String(cl.value ?? "")}</strong>
                      {attr && <span> — {attr.businessDefinition}</span>}
                    </div>
                  );
                })}
              </div>
              {usedIn.length > 0 && (
                <div className="pzn-list-meta" style={{ fontSize: "0.75rem" }}>
                  Attached to contexts: {usedIn.map((c) => <span key={c} className="pzn-code">{c}</span>)}
                </div>
              )}
              {evalRes && (
                <div className="pzn-btn-row" style={{ marginTop: 4 }}>
                  <span className={"pzn-badge " + (evalRes.effectiveAllow ? "is-pass" : "is-fail")}>
                    {activeMid}: {evalRes.matched ? "TRUE" : "FALSE"} → {evalRes.effectiveAllow ? "ALLOW" : "FILTER OUT"}
                  </span>
                  <span className="pzn-subtitle" style={{ fontSize: "0.78rem" }}>{evalRes.summary}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ============================================================================
 * 3. CONTEXTS & ATTACHED CONTENTS / RULES MATRIX WIDGET
 * ========================================================================== */
export function ContextMatrixWidget({
  workspace,
  activeMid,
  onWorkspaceChange,
  onRunPrompt,
}: {
  workspace: PznStudioWorkspaceState;
  activeMid: string;
  onWorkspaceChange: (ws: PznStudioWorkspaceState) => void;
  onRunPrompt?: (prompt: string) => void;
}) {
  const [busyCtx, setBusyCtx] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pendingApproval, setPendingApproval] = useState<ApprovalRecord | null>(null);

  const contentMap = useMemo(() => new Map(workspace.contents.map((c) => [c.contentId, c])), [workspace.contents]);
  const ruleMap = useMemo(() => new Map(workspace.rules.map((r) => [r.ruleId, r])), [workspace.rules]);

  async function publish(contextId: string) {
    setBusyCtx(contextId);
    setError("");
    try {
      const res = await api.pznPublishContext(contextId, "Published from Recommendations Workspace widget");
      onWorkspaceChange(res.workspace);
      if (res.approval) {
        setPendingApproval(res.approval);
        setNotice(`Publishing "${contextId}" needs approval (${res.approval.id}) — ${res.approval.dualControl ? "a second approver must approve" : "you can approve it below"}.`);
      } else {
        setPendingApproval(null);
        setNotice(`Published "${contextId}" v${res.publication?.version ?? "?"} live to Treatment Selector.`);
      }
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setBusyCtx("");
    }
  }

  async function toggleRuleOnAttachment(contextId: string, contentId: string, ruleId: string) {
    const ctx = workspace.contexts.find((c) => c.contextId === contextId);
    if (!ctx) return;
    setBusyCtx(contextId);
    setError("");
    try {
      const nextAttachments = ctx.attachments.map((att) => {
        if (att.contentId !== contentId) return att;
        const has = att.ruleIds.includes(ruleId);
        return { ...att, ruleIds: has ? att.ruleIds.filter((r) => r !== ruleId) : [...att.ruleIds, ruleId] };
      });
      const res = await api.pznSaveContext({
        contextId: ctx.contextId,
        displayName: ctx.displayName,
        description: ctx.description,
        channel: ctx.channel,
        contextRuleIds: ctx.contextRuleIds,
        attachments: nextAttachments,
      });
      onWorkspaceChange(res.workspace);
      setNotice(`Updated rule bindings on "${contextId}" (draft — click Publish to push live).`);
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setBusyCtx("");
    }
  }

  return (
    <section className="content-card pzn-widget-card" aria-label="Contexts and Attached Contents Matrix">
      <div className="pzn-widget-head">
        <div>
          <span className="pzn-stage-kicker"><Layers size={13} /> CONTEXTS · ATTACHED CONTENTS &amp; RULES ({workspace.contexts.length})</span>
          <h3>Context Placements &amp; Rule Bindings</h3>
        </div>
        {onRunPrompt && (
          <button
            type="button"
            className="pzn-btn pzn-btn-sm pzn-btn-primary"
            onClick={() => onRunPrompt("Create a Treasury Ladder offer for cash over $20,000, attach to context treasury_nudge, and publish it")}
          >
            <Plus size={13} /> New Context via Chat
          </button>
        )}
      </div>

      {notice && <p className="pzn-notice" role="status">{notice}</p>}
      {error && <p className="pzn-error" role="alert">{error}</p>}
      {pendingApproval && (
        <ApprovalRequestCard
          key={pendingApproval.id}
          approval={pendingApproval}
          onWorkspaceChange={onWorkspaceChange}
          onRunPrompt={onRunPrompt}
        />
      )}

      <div className="pzn-list">
        {workspace.contexts.map((ctx) => (
          <div key={ctx.contextId} className="pzn-attachment-card">
            <div className="pzn-attr-head">
              <div className="pzn-btn-row">
                <strong>{ctx.displayName}</strong>
                <span className="pzn-code">{ctx.contextId}</span>
                <span className={"pzn-badge " + (ctx.status === "published" ? "is-published" : "is-draft")}>
                  {ctx.status === "published" ? `Published v${ctx.publishedVersion}` : "Draft"}
                </span>
                {ctx.hasUnpublishedChanges && ctx.publishedVersion > 0 && <span className="pzn-badge is-warn">Draft ahead</span>}
              </div>
              <div className="pzn-btn-row">
                {(ctx.status !== "published" || ctx.hasUnpublishedChanges) && (
                  <button type="button" className="pzn-btn pzn-btn-primary pzn-btn-sm" disabled={busyCtx === ctx.contextId} onClick={() => void publish(ctx.contextId)}>
                    <Rocket size={12} /> Publish to TS
                  </button>
                )}
                {onRunPrompt && (
                  <button
                    type="button"
                    className="pzn-btn pzn-btn-sm"
                    onClick={() => onRunPrompt(`Test ${ctx.contextId} for ${activeMid} and compare with Jordan Lee`)}
                  >
                    <Play size={12} /> Run Live TS
                  </button>
                )}
              </div>
            </div>
            <p className="pzn-subtitle" style={{ fontSize: "0.82rem" }}>{ctx.description}</p>

            <div className="pzn-list">
              {ctx.attachments.map((att) => {
                const c = contentMap.get(att.contentId);
                return (
                  <div key={att.contentId} className="pzn-attr-card">
                    <div className="pzn-attr-head">
                      <div className="pzn-btn-row">
                        <span className="pzn-rank-pill">#{att.rank}</span>
                        <strong>{c?.title ?? att.contentId}</strong>
                        <span className="pzn-code">{att.contentId}</span>
                      </div>
                      <span className="pzn-badge">{att.ruleIds.length ? `${att.ruleIds.length} rule(s) (${att.ruleMatchMode.toUpperCase()})` : "Always eligible"}</span>
                    </div>
                    {c && <p className="pzn-subtitle" style={{ fontSize: "0.78rem" }}>{c.body.slice(0, 140)}{c.body.length > 140 ? "…" : ""}</p>}
                    <div className="pzn-rule-chips">
                      {workspace.rules.map((r) => {
                        const attached = att.ruleIds.includes(r.ruleId);
                        return (
                          <button
                            key={r.ruleId}
                            type="button"
                            className={"pzn-rule-chip" + (attached ? " is-checked" : "")}
                            disabled={busyCtx === ctx.contextId}
                            title={r.businessDescription}
                            onClick={() => void toggleRuleOnAttachment(ctx.contextId, att.contentId, r.ruleId)}
                          >
                            {attached && <Check size={11} />} {ruleMap.get(r.ruleId)?.name ?? r.ruleId}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ============================================================================
 * 4. DATA DICTIONARY WIDGET (Namespaces + Business Defs + Quick Add)
 * ========================================================================== */
export function DictionaryWidget({
  workspace,
  onWorkspaceChange,
}: {
  workspace: PznStudioWorkspaceState;
  onWorkspaceChange: (ws: PznStudioWorkspaceState) => void;
}) {
  const [selectedNs, setSelectedNs] = useState<string>("all");
  const [showAdd, setShowAdd] = useState(false);
  const [nsId, setNsId] = useState(workspace.dictionary.namespaces[0]?.id ?? "customer");
  const [attrName, setAttrName] = useState("");
  const [bizDef, setBizDef] = useState("");
  const [dataType, setDataType] = useState<PznDataType>("string");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const visibleNs = selectedNs === "all"
    ? workspace.dictionary.namespaces
    : workspace.dictionary.namespaces.filter((n) => n.id === selectedNs);

  async function saveQuickAttr() {
    if (!attrName.trim() || !bizDef.trim()) return;
    setBusy(true);
    try {
      const id = slugify(attrName, "custom_attr");
      const res = await api.pznSaveAttribute({
        namespaceId: nsId,
        id,
        displayName: attrName.trim(),
        businessDefinition: bizDef.trim(),
        dataType,
        allowedOperators: defaultOps(dataType),
        enumOptions: [],
        unit: dataType === "currency_usd" ? "USD" : "",
        sampleValue: "",
        resolverPath: `customAttributes.${id}`,
        piiClassification: "none",
      });
      onWorkspaceChange(res.workspace);
      setNotice(`Added "${nsId}.${id}" to the Data Dictionary.`);
      setAttrName("");
      setBizDef("");
      setShowAdd(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="content-card pzn-widget-card" aria-label="Data Dictionary Widget">
      <div className="pzn-widget-head">
        <div>
          <span className="pzn-stage-kicker"><BookOpen size={13} /> DATA DICTIONARY &amp; BUSINESS DEFINITIONS</span>
          <h3>Namespaces &amp; Governed Attributes</h3>
        </div>
        <button type="button" className="pzn-btn pzn-btn-sm pzn-btn-primary" onClick={() => setShowAdd((v) => !v)}>
          <Plus size={13} /> {showAdd ? "Close" : "Add Attribute"}
        </button>
      </div>

      {notice && <p className="pzn-notice" role="status">{notice}</p>}

      {showAdd && (
        <div className="pzn-attachment-card">
          <div className="pzn-form-grid">
            <div className="pzn-field">
              <label>Namespace</label>
              <select value={nsId} onChange={(e) => setNsId(e.target.value)}>
                {workspace.dictionary.namespaces.map((n) => <option key={n.id} value={n.id}>{n.displayName} ({n.id})</option>)}
              </select>
            </div>
            <div className="pzn-field">
              <label>Attribute Name</label>
              <input value={attrName} placeholder="e.g. Risk Tolerance" onChange={(e) => setAttrName(e.target.value)} />
            </div>
            <div className="pzn-field">
              <label>Data Type</label>
              <select value={dataType} onChange={(e) => setDataType(e.target.value as PznDataType)}>
                {pznDataTypes.map((dt) => <option key={dt} value={dt}>{dt}</option>)}
              </select>
            </div>
            <div className="pzn-field is-full">
              <label>Business Definition</label>
              <input value={bizDef} placeholder="Clear business meaning used by authors in Rule Builder..." onChange={(e) => setBizDef(e.target.value)} />
            </div>
          </div>
          <button type="button" className="pzn-btn pzn-btn-primary pzn-btn-sm" disabled={busy || !attrName.trim() || !bizDef.trim()} onClick={() => void saveQuickAttr()}>
            Save Attribute
          </button>
        </div>
      )}

      <div className="pzn-rule-chips">
        <button type="button" className={"pzn-rule-chip" + (selectedNs === "all" ? " is-checked" : "")} onClick={() => setSelectedNs("all")}>
          All Namespaces ({workspace.dictionary.namespaces.length})
        </button>
        {workspace.dictionary.namespaces.map((ns) => (
          <button key={ns.id} type="button" className={"pzn-rule-chip" + (selectedNs === ns.id ? " is-checked" : "")} onClick={() => setSelectedNs(ns.id)}>
            {ns.id}.* ({ns.attributes.length})
          </button>
        ))}
      </div>

      <div className="pzn-list">
        {visibleNs.map((ns) => (
          <div key={ns.id} className="pzn-chat-ns-block">
            <div className="pzn-attr-head">
              <div><strong>{ns.displayName}</strong> <span className="pzn-code">{ns.id}.*</span></div>
              <span className="pzn-badge">Owner: {ns.owner}</span>
            </div>
            <p className="pzn-subtitle" style={{ fontSize: "0.8rem" }}>{ns.businessDefinition}</p>
            <div className="pzn-chat-attr-grid">
              {ns.attributes.map((a) => (
                <div key={a.id} className="pzn-attr-card">
                  <div className="pzn-attr-head">
                    <span className="pzn-code">{ns.id}.{a.id}</span>
                    <span className="pzn-badge">{a.dataType}</span>
                  </div>
                  <strong style={{ fontSize: "0.85rem" }}>{a.displayName}</strong>
                  <p className="pzn-subtitle" style={{ fontSize: "0.78rem", color: "var(--text)" }}>{a.businessDefinition}</p>
                  <span style={{ fontSize: "0.72rem", color: "var(--muted)" }}>Ops: {a.allowedOperators.join(", ")} · {a.resolverPath}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ============================================================================
 * 5. LIVE TREATMENT SELECTOR WIDGET (Quick MID + Context Run)
 * ========================================================================== */
export function LiveTsRunnerWidget({
  workspace,
  activeMid,
}: {
  workspace: PznStudioWorkspaceState;
  activeMid: string;
}) {
  const [contextId, setContextId] = useState(workspace.contexts[0]?.contextId ?? "wealth-next-best-offers");
  const [cashOverride, setCashOverride] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<PznTsEvaluationResult | null>(null);

  async function runTs() {
    setBusy(true);
    setError("");
    try {
      const ctx = workspace.contexts.find((c) => c.contextId === contextId);
      const numCash = cashOverride.trim() !== "" ? Number(cashOverride) : NaN;
      const res = await api.pznEvaluateTs({
        mid: activeMid,
        contextId,
        useDraft: ctx ? ctx.status !== "published" : false,
        ...(Number.isFinite(numCash) ? { attributeOverrides: { "portfolio.cash_usd": numCash } } : {}),
      });
      setResult(res);
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="content-card pzn-widget-card" aria-label="Live Treatment Selector Widget">
      <div className="pzn-widget-head">
        <div>
          <span className="pzn-stage-kicker"><Play size={13} /> LIVE TREATMENT SELECTOR · MID EVALUATOR</span>
          <h3>Test Context Filtering for {activeMid}</h3>
        </div>
      </div>

      {error && <p className="pzn-error" role="alert">{error}</p>}

      <div className="pzn-btn-row">
        <select
          aria-label="Context to evaluate"
          value={contextId}
          onChange={(e) => setContextId(e.target.value)}
          style={{ flex: 1, padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border)" }}
        >
          {workspace.contexts.map((c) => (
            <option key={c.contextId} value={c.contextId}>
              {c.displayName} ({c.contextId}) · {c.status === "published" ? `v${c.publishedVersion}` : "Draft"}
            </option>
          ))}
        </select>
        <input
          type="number"
          placeholder="What-if cash USD (optional)"
          value={cashOverride}
          onChange={(e) => setCashOverride(e.target.value)}
          style={{ width: 190, padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border)" }}
        />
        <button type="button" className="pzn-btn pzn-btn-primary pzn-btn-sm" disabled={busy} onClick={() => void runTs()}>
          <Play size={13} /> {busy ? "Running…" : "Evaluate TS"}
        </button>
      </div>

      {result && (
        <div className="pzn-pipeline-grid" style={{ marginTop: 4 }}>
          <div className="pzn-list">
            <span className="pzn-stage-kicker" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <CheckCircle2 size={14} /> Eligible → Experience Layer ({result.eligibleContents.length})
            </span>
            {result.eligibleContents.length === 0 ? (
              <p className="pzn-subtitle" style={{ fontSize: "0.82rem" }}>No eligible content returned for this MID.</p>
            ) : (
              result.eligibleContents.map((item) => (
                <article key={item.contentId} className="pzn-exp-card">
                  <div className="pzn-attr-head">
                    <span className="pzn-rank-pill">#{item.rank}</span>
                    <span className="pzn-badge is-pass">ELIGIBLE</span>
                  </div>
                  <h4>{item.title}</h4>
                  {item.headline && <p className="pzn-exp-headline">{item.headline}</p>}
                  <p className="pzn-exp-body">{item.renderedBody}</p>
                </article>
              ))
            )}
          </div>
          <div className="pzn-list">
            <span className="pzn-stage-kicker" style={{ color: "#b45309", display: "inline-flex", alignItems: "center", gap: 5 }}>
              <XCircle size={14} /> Filtered Out ({result.filteredOutContents.length})
            </span>
            {result.filteredOutContents.map((item) => (
              <div key={item.contentId} className="pzn-filtered-card">
                <div className="pzn-attr-head">
                  <strong style={{ fontSize: "0.85rem" }}>{item.title}</strong>
                  <span className="pzn-badge is-fail">{item.reasonCode}</span>
                </div>
                <p className="pzn-subtitle" style={{ fontSize: "0.78rem", color: "var(--text)" }}>{item.reason}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/* ============================================================================
 * 6. TEXT CONTENT LIBRARY WIDGET
 * ========================================================================== */
export function ContentLibraryWidget({
  workspace,
  onWorkspaceChange,
}: {
  workspace: PznStudioWorkspaceState;
  onWorkspaceChange: (ws: PznStudioWorkspaceState) => void;
}) {
  const [showNew, setShowNew] = useState(false);
  const [title, setTitle] = useState("");
  const [headline, setHeadline] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function saveContent() {
    if (!title.trim() || !body.trim()) return;
    setBusy(true);
    try {
      const contentId = slugify(title, "text_offer");
      const res = await api.pznSaveContent({
        contentId,
        title: title.trim(),
        headline: headline.trim(),
        body: body.trim(),
        ctaLabel: "Learn more",
        ctaPrompt: `Tell me more about ${title.trim()}`,
        disclosureText: "Personalized via CEP Recommendation Platform.",
        tags: ["self-service"],
        status: "published",
      });
      onWorkspaceChange(res.workspace);
      setNotice(`Saved text content "${res.content.contentId}".`);
      setTitle("");
      setHeadline("");
      setBody("");
      setShowNew(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="content-card pzn-widget-card" aria-label="Text Contents Widget">
      <div className="pzn-widget-head">
        <div>
          <span className="pzn-stage-kicker"><FileText size={13} /> TEXT CONTENT LIBRARY ({workspace.contents.length})</span>
          <h3>Published Recommendation Copy</h3>
        </div>
        <button type="button" className="pzn-btn pzn-btn-sm pzn-btn-primary" onClick={() => setShowNew((v) => !v)}>
          <Plus size={13} /> {showNew ? "Close" : "New Text Content"}
        </button>
      </div>

      {notice && <p className="pzn-notice" role="status">{notice}</p>}

      {showNew && (
        <div className="pzn-attachment-card">
          <div className="pzn-form-grid">
            <div className="pzn-field">
              <label>Title</label>
              <input value={title} placeholder="e.g. High-Yield Treasury Sweep" onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="pzn-field">
              <label>Headline (supports {"{{portfolio.cash_usd}}"})</label>
              <input value={headline} placeholder="e.g. You have {{portfolio.cash_usd}} ready to deploy" onChange={(e) => setHeadline(e.target.value)} />
            </div>
            <div className="pzn-field is-full">
              <label>Body Text</label>
              <textarea rows={2} value={body} placeholder="Recommendation copy rendered by the Experience Layer..." onChange={(e) => setBody(e.target.value)} />
            </div>
          </div>
          <button type="button" className="pzn-btn pzn-btn-primary pzn-btn-sm" disabled={busy || !title.trim() || !body.trim()} onClick={() => void saveContent()}>
            Save Text Content
          </button>
        </div>
      )}

      <div className="pzn-chat-attr-grid">
        {workspace.contents.map((c) => (
          <article key={c.contentId} className="pzn-exp-card">
            <div className="pzn-attr-head">
              <span className="pzn-code">{c.contentId}</span>
              <span className="pzn-badge is-published">{c.status} v{c.version}</span>
            </div>
            <h4>{c.title}</h4>
            {c.headline && <p className="pzn-exp-headline">{c.headline}</p>}
            <p className="pzn-exp-body">{c.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
