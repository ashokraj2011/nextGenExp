import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowUp,
  BookOpen,
  CheckCircle2,
  FileText,
  Layers,
  MessageSquare,
  Play,
  Plus,
  Rocket,
  SlidersHorizontal,
  Sparkles,
  XCircle,
} from "lucide-react";
import type {
  PznCopilotActionLog,
  PznCopilotCard,
  PznRuleClause,
  PznStudioWorkspaceState,
} from "../../packages/contracts/self-service-pzn";
import { pznOperatorLabels } from "../../packages/contracts/self-service-pzn";
import { api, toolSetupErrorMessage } from "./api";
import { ContextMatrixWidget, RuleBuilderWidget, RulesCatalogWidget } from "./recommendation-widgets";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  generatedBy?: "copilot_llm" | "deterministic";
  actionsExecuted?: PznCopilotActionLog[];
  cards?: PznCopilotCard[];
  suggestedPrompts?: string[];
  error?: boolean;
};

const STARTER_PROMPTS = [
  {
    icon: Rocket,
    title: "Create, Rule & Publish End-to-End",
    subtitle: "Define context, attach text content, create Data Dictionary rule, and publish v1",
    prompt: "Create a Treasury Ladder text offer for customers with cash over $20,000, attach it to a new context treasury-nudge, and publish it",
  },
  {
    icon: Play,
    title: "Run Live Treatment Selector (MID)",
    subtitle: "Send Alice Morgan & Jordan Lee MIDs to TS and compare Rule Engine outputs",
    prompt: "Test wealth-next-best-offers for Alice Morgan and Jordan Lee",
  },
  {
    icon: BookOpen,
    title: "Inspect Data Dictionary",
    subtitle: "Browse namespaces, attributes, business definitions, and live resolvers",
    prompt: "Show all Data Dictionary namespaces, attributes, and business definitions",
  },
  {
    icon: SlidersHorizontal,
    title: "Extend Data Dictionary",
    subtitle: "Add a custom business attribute and bind it to Customer 360",
    prompt: "Add custom attribute loyalty.vip_tier (gold/platinum) to the Data Dictionary",
  },
];

function formatRichText(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={idx} className="pzn-code">{part.slice(1, -1)}</code>;
    }
    return <span key={idx}>{part}</span>;
  });
}

export function InlineCard({
  card,
  workspace,
  activeMid,
  busy,
  onWorkspaceChange,
  onSendPrompt,
}: {
  card: PznCopilotCard;
  workspace: PznStudioWorkspaceState;
  activeMid?: string;
  busy: boolean;
  onWorkspaceChange?: (ws: PznStudioWorkspaceState) => void;
  onSendPrompt: (prompt: string) => void;
}) {
  const effectiveMid = activeMid ?? workspace.customers[0]?.syntheticMid ?? "DEMO-MID-1001";

  if (card.kind === "rule_builder_widget") {
    return (
      <RuleBuilderWidget
        workspace={workspace}
        activeMid={effectiveMid}
        initialNamespaceId={card.initialNamespaceId}
        initialAttributeId={card.initialAttributeId}
        onWorkspaceChange={(ws) => onWorkspaceChange?.(ws)}
        onRunPrompt={onSendPrompt}
      />
    );
  }

  if (card.kind === "rules_catalog_widget") {
    return (
      <RulesCatalogWidget
        workspace={workspace}
        activeMid={effectiveMid}
        onRunPrompt={onSendPrompt}
      />
    );
  }

  if (card.kind === "context_matrix_widget") {
    return (
      <ContextMatrixWidget
        workspace={workspace}
        activeMid={effectiveMid}
        onWorkspaceChange={(ws) => onWorkspaceChange?.(ws)}
        onRunPrompt={onSendPrompt}
      />
    );
  }

  if (card.kind === "dictionary") {
    return (
      <div className="pzn-chat-card">
        <div className="pzn-chat-card-head">
          <span className="pzn-stage-kicker"><BookOpen size={13} /> Data Dictionary &amp; Business Definitions</span>
          <span className="pzn-badge">{card.namespaces.length} namespace(s)</span>
        </div>
        <div className="pzn-list">
          {card.namespaces.map((ns) => (
            <div key={ns.id} className="pzn-chat-ns-block">
              <div className="pzn-attr-head">
                <div>
                  <strong>{ns.displayName}</strong> <span className="pzn-code">{ns.id}.*</span>
                </div>
                <span className="pzn-badge">Owner: {ns.owner}</span>
              </div>
              <p className="pzn-subtitle" style={{ fontSize: "0.82rem", margin: "2px 0 6px" }}>{ns.businessDefinition}</p>
              <div className="pzn-chat-attr-grid">
                {ns.attributes.map((attr) => {
                  const fullKey = `${ns.id}.${attr.id}`;
                  const isHighlight = card.highlightKey === fullKey;
                  return (
                    <div key={attr.id} className={"pzn-attr-card" + (isHighlight ? " is-highlight" : "")}>
                      <div className="pzn-attr-head">
                        <span className="pzn-code">{fullKey}</span>
                        <span className="pzn-badge">{attr.dataType}{attr.unit ? ` (${attr.unit})` : ""}</span>
                      </div>
                      <strong style={{ fontSize: "0.86rem" }}>{attr.displayName}</strong>
                      <p className="pzn-subtitle" style={{ fontSize: "0.79rem", color: "var(--text)" }}>{attr.businessDefinition}</p>
                      <div className="pzn-list-meta" style={{ fontSize: "0.73rem" }}>
                        <span>Ops: {attr.allowedOperators.join(", ")}</span>
                        <span>Resolver: {attr.resolverPath}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (card.kind === "content") {
    const c = card.content;
    return (
      <div className="pzn-exp-card">
        <div className="pzn-attr-head">
          <span className="pzn-stage-kicker"><FileText size={13} /> Text Content · Experience Preview</span>
          <div className="pzn-btn-row">
            <span className="pzn-code">{c.contentId}</span>
            <span className="pzn-badge is-published">{c.status} v{c.version}</span>
          </div>
        </div>
        <h4>{c.title}</h4>
        {c.headline && <p className="pzn-exp-headline">{c.headline}</p>}
        <p className="pzn-exp-body">{c.body}</p>
        {c.ctaLabel && (
          <div className="pzn-btn-row" style={{ marginTop: 4 }}>
            <span className="pzn-badge is-published">{c.ctaLabel}</span>
          </div>
        )}
        {c.disclosureText && <p className="pzn-exp-disclosure">{c.disclosureText}</p>}
      </div>
    );
  }

  if (card.kind === "rule") {
    const r = card.rule;
    const clauses = r.rootGroup.children.filter((ch): ch is PznRuleClause => ch.kind === "clause");
    const attrMap = new Map<string, (typeof workspace.dictionary.namespaces)[number]["attributes"][number]>(
      workspace.dictionary.namespaces.flatMap((ns) => ns.attributes.map((a) => [`${ns.id}.${a.id}`, a] as const)),
    );
    return (
      <div className="pzn-chat-card">
        <div className="pzn-chat-card-head">
          <span className="pzn-stage-kicker"><SlidersHorizontal size={13} /> Data Dictionary Rule ({r.rootGroup.combinator})</span>
          <div className="pzn-btn-row">
            <span className="pzn-code">{r.ruleId}</span>
            <span className={"pzn-badge " + (r.effect === "include_when_true" ? "is-published" : "is-warn")}>
              {r.effect === "include_when_true" ? "Include when TRUE" : "Suppress when TRUE"}
            </span>
          </div>
        </div>
        <strong>{r.name}</strong>
        <p className="pzn-subtitle" style={{ fontSize: "0.83rem" }}>{r.businessDescription}</p>
        <div className="pzn-list">
          {clauses.map((cl) => {
            const key = `${cl.namespaceId}.${cl.attributeId}`;
            const attr = attrMap.get(key);
            return (
              <div key={cl.id} className="pzn-biz-def">
                <strong>{key}</strong> {pznOperatorLabels[cl.operator]} <strong>{String(cl.value ?? "")}</strong>
                {attr && <span> — {attr.businessDefinition}</span>}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (card.kind === "context") {
    const ctx = card.context;
    const contentMap = new Map(card.contents.map((c) => [c.contentId, c]));
    const ruleMap = new Map(card.rules.map((r) => [r.ruleId, r]));
    return (
      <div className="pzn-chat-card">
        <div className="pzn-chat-card-head">
          <span className="pzn-stage-kicker"><Layers size={13} /> Context Definition</span>
          <div className="pzn-btn-row">
            <span className="pzn-code">{ctx.contextId}</span>
            <span className={"pzn-badge " + (ctx.status === "published" ? "is-published" : "is-draft")}>
              {ctx.status === "published" ? `Published v${ctx.publishedVersion}` : "Draft"}
            </span>
          </div>
        </div>
        <strong>{ctx.displayName}</strong>
        <p className="pzn-subtitle" style={{ fontSize: "0.83rem" }}>{ctx.description}</p>
        <div className="pzn-list">
          {ctx.attachments.map((att) => {
            const c = contentMap.get(att.contentId);
            return (
              <div key={att.contentId} className="pzn-attr-card">
                <div className="pzn-attr-head">
                  <div className="pzn-btn-row">
                    <span className="pzn-rank-pill">#{att.rank}</span>
                    <strong>{c?.title ?? att.contentId}</strong>
                  </div>
                  <span className="pzn-badge">{att.ruleIds.length ? `${att.ruleIds.length} rule(s) (${att.ruleMatchMode.toUpperCase()})` : "Always eligible"}</span>
                </div>
                {att.ruleIds.length > 0 && (
                  <div className="pzn-list-meta" style={{ fontSize: "0.78rem" }}>
                    Rules: {att.ruleIds.map((rId) => ruleMap.get(rId)?.name ?? rId).join(", ")}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="pzn-btn-row" style={{ marginTop: 4 }}>
          {ctx.status !== "published" || ctx.hasUnpublishedChanges ? (
            <button type="button" className="pzn-btn pzn-btn-primary pzn-btn-sm" disabled={busy} onClick={() => onSendPrompt(`Publish ${ctx.contextId}`)}>
              <Rocket size={13} /> Publish to Treatment Selector
            </button>
          ) : (
            <button type="button" className="pzn-btn pzn-btn-sm" disabled={busy} onClick={() => onSendPrompt(`Unpublish ${ctx.contextId}`)}>
              Unpublish
            </button>
          )}
          <button type="button" className="pzn-btn pzn-btn-sm" disabled={busy} onClick={() => onSendPrompt(`Test ${ctx.contextId} for Alice Morgan and Jordan Lee`)}>
            <Play size={13} /> Run Live TS (Alice &amp; Jordan)
          </button>
        </div>
      </div>
    );
  }

  if (card.kind === "ts_evaluation") {
    const ev = card.evaluation;
    return (
      <div className="pzn-chat-card pzn-ts-trace-card">
        <div className="pzn-chat-card-head">
          <span className="pzn-stage-kicker"><Play size={13} /> Live Treatment Selector Run</span>
          <div className="pzn-btn-row">
            <strong>{ev.customerDisplayName}</strong>
            <span className="pzn-code">{ev.mid}</span>
            <span className="pzn-badge is-published">
              {ev.sourceMode === "published" ? `Published v${ev.publicationVersion}` : "Draft Preview"}
            </span>
            <span className="pzn-badge">{ev.durationMs}ms</span>
          </div>
        </div>

        {/* Rule Engine Results */}
        {ev.ruleResults.length > 0 && (
          <div className="pzn-list">
            {ev.ruleResults.map((r) => (
              <div key={r.ruleId} className="pzn-attr-card">
                <div className="pzn-attr-head">
                  <strong style={{ fontSize: "0.86rem" }}>Rule Engine · {r.ruleName}</strong>
                  <span className={"pzn-badge " + (r.effectiveAllow ? "is-pass" : "is-fail")}>
                    {r.matched ? "TRUE" : "FALSE"} → {r.effectiveAllow ? "ALLOW" : "FILTER OUT"}
                  </span>
                </div>
                {r.clauses.map((cl) => (
                  <div key={cl.clauseId} className="pzn-biz-def" style={{ fontSize: "0.78rem" }}>
                    {cl.passed ? "✓" : "✗"} {cl.reason}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* Experience Layer Eligible vs Filtered Out */}
        <div className="pzn-pipeline-grid">
          <div className="pzn-list">
            <span className="pzn-stage-kicker" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <CheckCircle2 size={14} /> Eligible → Experience Layer ({ev.eligibleContents.length})
            </span>
            {ev.eligibleContents.length === 0 ? (
              <p className="pzn-subtitle" style={{ fontSize: "0.82rem" }}>0 eligible contents returned — Experience Layer suppresses placement.</p>
            ) : (
              ev.eligibleContents.map((item) => (
                <article key={item.contentId} className="pzn-exp-card">
                  <div className="pzn-attr-head">
                    <span className="pzn-rank-pill">#{item.rank}</span>
                    <span className="pzn-badge is-pass">ELIGIBLE</span>
                  </div>
                  <h4>{item.title}</h4>
                  {item.headline && <p className="pzn-exp-headline">{item.headline}</p>}
                  <p className="pzn-exp-body">{item.renderedBody}</p>
                  {item.ctaLabel && (
                    <div className="pzn-btn-row"><span className="pzn-badge is-published">{item.ctaLabel}</span></div>
                  )}
                </article>
              ))
            )}
          </div>

          <div className="pzn-list">
            <span className="pzn-stage-kicker" style={{ color: "#b45309", display: "inline-flex", alignItems: "center", gap: 5 }}>
              <XCircle size={14} /> Filtered Out ({ev.filteredOutContents.length})
            </span>
            {ev.filteredOutContents.length === 0 ? (
              <p className="pzn-subtitle" style={{ fontSize: "0.82rem" }}>All attached contents passed rule evaluation.</p>
            ) : (
              ev.filteredOutContents.map((item) => (
                <div key={item.contentId} className="pzn-filtered-card">
                  <div className="pzn-attr-head">
                    <strong style={{ fontSize: "0.86rem" }}>{item.title}</strong>
                    <span className="pzn-badge is-fail">{item.reasonCode}</span>
                  </div>
                  <p className="pzn-subtitle" style={{ fontSize: "0.78rem", color: "var(--text)" }}>{item.reason}</p>
                </div>
              ))
            )}
          </div>
        </div>

        <details>
          <summary style={{ cursor: "pointer", fontSize: "0.78rem", fontWeight: 600, color: "var(--muted)" }}>
            Inspect Hydrated Attributes &amp; Experience JSON Payload
          </summary>
          <div className="pzn-attr-kv-grid" style={{ marginTop: 8 }}>
            {Object.entries(ev.resolvedAttributes)
              .filter(([, v]) => v !== undefined && v !== null)
              .map(([k, v]) => (
                <div key={k} className="pzn-attr-kv">
                  <span>{k}</span>
                  <strong>{String(v)}</strong>
                </div>
              ))}
          </div>
          <pre style={{ fontSize: "0.73rem", overflowX: "auto", padding: 10, borderRadius: 8, background: "var(--surface-2)", marginTop: 8 }}>
            {JSON.stringify(ev.experiencePayload, null, 2)}
          </pre>
        </details>

        <div className="pzn-btn-row">
          <button
            type="button"
            className="pzn-btn pzn-btn-sm"
            disabled={busy}
            onClick={() => onSendPrompt(`Simulate ${ev.contextId} for ${ev.customerDisplayName} with portfolio.cash_usd = 5000`)}
          >
            What-if: Cash = $5,000
          </button>
          {workspace.customers
            .filter((c) => c.syntheticMid !== ev.mid)
            .slice(0, 2)
            .map((c) => (
              <button
                key={c.syntheticMid}
                type="button"
                className="pzn-btn pzn-btn-sm"
                disabled={busy}
                onClick={() => onSendPrompt(`Test ${ev.contextId} for ${c.displayName}`)}
              >
                Run for {c.displayName}
              </button>
            ))}
        </div>
      </div>
    );
  }

  // catalog_summary
  return (
    <div className="pzn-chat-card">
      <div className="pzn-chat-card-head">
        <span className="pzn-stage-kicker"><Layers size={13} /> Recommendation Self-Service Catalog</span>
        <span className="pzn-badge">{card.contexts.length} Contexts · {card.contentsCount} Contents · {card.rulesCount} Rules · {card.attrCount} Dictionary Attrs</span>
      </div>
      <div className="pzn-list">
        {card.contexts.map((ctx) => (
          <div key={ctx.contextId} className="pzn-attr-card">
            <div className="pzn-attr-head">
              <div className="pzn-btn-row">
                <strong>{ctx.displayName}</strong>
                <span className="pzn-code">{ctx.contextId}</span>
                <span className={"pzn-badge " + (ctx.status === "published" ? "is-published" : "is-draft")}>
                  {ctx.status === "published" ? `Published v${ctx.publishedVersion}` : "Draft"}
                </span>
              </div>
              <div className="pzn-btn-row">
                {ctx.status !== "published" && (
                  <button type="button" className="pzn-btn pzn-btn-primary pzn-btn-sm" disabled={busy} onClick={() => onSendPrompt(`Publish ${ctx.contextId}`)}>
                    Publish
                  </button>
                )}
                <button type="button" className="pzn-btn pzn-btn-sm" disabled={busy} onClick={() => onSendPrompt(`Test ${ctx.contextId} for Alice Morgan and Jordan Lee`)}>
                  <Play size={12} /> Run TS
                </button>
              </div>
            </div>
            <p className="pzn-subtitle" style={{ fontSize: "0.8rem" }}>{ctx.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RecommendationChatExperience({
  workspace,
  onWorkspaceChange,
  onOpenClassic,
}: {
  workspace: PznStudioWorkspaceState;
  onWorkspaceChange: (ws: PznStudioWorkspaceState) => void;
  onOpenClassic: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeContextId, setActiveContextId] = useState<string | undefined>(workspace.contexts[0]?.contextId);
  const scrollEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(textOverride?: string) {
    const trimmed = (textOverride ?? input).trim();
    if (!trimmed || busy) return;
    setInput("");
    const userMsg: ChatMessage = { id: "u_" + Date.now(), role: "user", text: trimmed };
    const nextHistory = [...messages, userMsg].slice(-10).map((m) => ({ role: m.role, text: m.text }));
    setMessages((prev) => [...prev, userMsg]);
    setBusy(true);
    try {
      const res = await api.pznCopilot({
        message: trimmed,
        history: nextHistory,
        ...(activeContextId ? { activeContextId } : {}),
      });
      onWorkspaceChange(res.workspace);
      if (res.activeContextId) setActiveContextId(res.activeContextId);
      setMessages((prev) => [
        ...prev,
        {
          id: "a_" + Date.now(),
          role: "assistant",
          text: res.reply,
          generatedBy: res.generatedBy,
          actionsExecuted: res.actionsExecuted,
          cards: res.cards,
          suggestedPrompts: res.suggestedPrompts,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: "e_" + Date.now(),
          role: "assistant",
          text: toolSetupErrorMessage(err),
          error: true,
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const publishedCount = workspace.contexts.filter((c) => c.status === "published" && c.publishedVersion > 0).length;
  const totalAttrs = workspace.dictionary.namespaces.reduce((acc, ns) => acc + ns.attributes.length, 0);

  return (
    <div className="pzn-chat-shell">
      <header className="pzn-chat-topbar">
        <div className="pzn-chat-topbar-left">
          <div className="pzn-chat-title-row">
            <Sparkles size={18} className="pzn-chat-spark" aria-hidden="true" />
            <h1>Recommendation Self-Service Copilot</h1>
          </div>
          <div className="pzn-chat-stat-pills">
            <span className="pzn-badge is-published">{publishedCount} Published Contexts</span>
            <span className="pzn-badge">{workspace.contents.length} Contents</span>
            <span className="pzn-badge">{workspace.rules.length} Rules</span>
            <span className="pzn-badge">{totalAttrs} Dictionary Attrs</span>
          </div>
        </div>
        <div className="pzn-btn-row">
          {messages.length > 0 && (
            <button type="button" className="pzn-btn pzn-btn-sm" onClick={() => setMessages([])}>
              <Plus size={13} /> New Chat
            </button>
          )}
          <a href="/recommendations" className="pzn-btn pzn-btn-sm" style={{ textDecoration: "none" }}>
            <Layers size={13} /> Open Full Workspace
          </a>
          <div className="pzn-mode-switch" role="group" aria-label="Studio mode">
            <button type="button" className="is-active" aria-pressed="true">
              <MessageSquare size={13} /> Chat Studio
            </button>
            <button type="button" onClick={onOpenClassic} aria-pressed="false">
              <Layers size={13} /> Classic Forms
            </button>
          </div>
        </div>
      </header>

      <div className="pzn-chat-scroll">
        <div className="pzn-chat-thread">
          {messages.length === 0 ? (
            <div className="pzn-chat-welcome">
              <div className="pzn-chat-welcome-badge">
                <Sparkles size={14} /> End-to-End Self-Service Personalization in One Conversation
              </div>
              <h2>Define contexts, text content, Data Dictionary rules, publish, and test live MIDs — just by chatting.</h2>
              <p>
                Every action runs against the live SQLite Recommendation Platform, validates rules strictly against your Data Dictionary business definitions, and executes real Treatment Selector evaluations.
              </p>

              <div className="pzn-starter-grid">
                {STARTER_PROMPTS.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.title}
                      type="button"
                      className="pzn-starter-card"
                      disabled={busy}
                      onClick={() => void send(item.prompt)}
                    >
                      <div className="pzn-starter-head">
                        <Icon size={16} />
                        <strong>{item.title}</strong>
                      </div>
                      <span>{item.subtitle}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            messages.map((msg, idx) => (
              <div key={msg.id} className={"pzn-msg pzn-msg-" + msg.role}>
                {msg.role === "user" ? (
                  <div className="pzn-user-bubble">{msg.text}</div>
                ) : (
                  <div className={"pzn-assistant-bubble" + (msg.error ? " is-error" : "")}>
                    {msg.actionsExecuted && msg.actionsExecuted.length > 0 && (
                      <div className="pzn-action-pills">
                        <span className="pzn-badge">
                          {msg.generatedBy === "copilot_llm" ? "Copilot ACP" : "Self-Service Engine"}
                        </span>
                        {msg.actionsExecuted.map((a, aIdx) => (
                          <span key={aIdx} className={"pzn-badge " + (a.status === "ok" ? "is-pass" : "is-fail")}>
                            {a.status === "ok" ? "✓" : "✗"} {a.tool}
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="pzn-assistant-text">{formatRichText(msg.text)}</p>
                    {msg.cards && msg.cards.length > 0 && (
                      <div className="pzn-chat-cards">
                        {msg.cards.map((card, cIdx) => (
                          <InlineCard
                            key={cIdx}
                            card={card}
                            workspace={workspace}
                            busy={busy}
                            onWorkspaceChange={onWorkspaceChange}
                            onSendPrompt={(p) => void send(p)}
                          />
                        ))}
                      </div>
                    )}
                    {idx === messages.length - 1 && msg.suggestedPrompts && msg.suggestedPrompts.length > 0 && (
                      <div className="pzn-followups">
                        {msg.suggestedPrompts.map((sp) => (
                          <button key={sp} type="button" className="pzn-followup-chip" disabled={busy} onClick={() => void send(sp)}>
                            <Sparkles size={12} /> {sp}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
          {busy && (
            <div className="pzn-msg pzn-msg-assistant">
              <div className="pzn-assistant-bubble">
                <span className="pzn-subtitle">Running Self-Service tools, Data Dictionary checks, and Treatment Selector…</span>
              </div>
            </div>
          )}
          <div ref={scrollEndRef} />
        </div>
      </div>

      <footer className="pzn-chat-composer-wrap">
        <form
          className="pzn-chat-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            id="pzn-copilot-input"
            rows={1}
            value={input}
            disabled={busy}
            onKeyDown={onKeyDown}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Describe a context, text content, Data Dictionary rule, publish action, or live MID test…"
            aria-label="Ask Recommendation Self-Service Copilot"
          />
          <button type="submit" className="pzn-send-btn" disabled={busy || !input.trim()} aria-label="Send message">
            <ArrowUp size={17} />
          </button>
        </form>
      </footer>
    </div>
  );
}
