import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowUp,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Eye,
  FileText,
  Layers,
  LayoutDashboard,
  PanelLeft,
  PanelLeftClose,
  Play,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { wealthRecommendationsTopic } from "../../packages/contracts/self-service-pzn";
import { adminPaths } from "../../packages/contracts/admin-paths";
import type {
  PznCopilotActionLog,
  PznCopilotCard,
  PznStudioWorkspaceState,
} from "../../packages/contracts/self-service-pzn";
import { api, toolSetupErrorMessage } from "./api";
import { ProfileAvatar } from "./demo-profiles";
import { LabMark } from "./lab-mark";
import { InlineCard } from "./recommendation-chat";
import { ApprovalQueueWidget } from "./recommendation-approvals";
import {
  ContentLibraryWidget,
  ContextMatrixWidget,
  DictionaryWidget,
  LiveTsRunnerWidget,
  RuleBuilderWidget,
  RulesCatalogWidget,
} from "./recommendation-widgets";
import { ThemeToggle } from "./theme";
import "./customer-workbench.css";
import "./recommendation-studio.css";
import "./recommendation-workspace.css";

type WorkspaceSection = "summary" | "contexts" | "rules" | "dictionary" | "live_ts" | "approvals";

type RecMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  generatedBy?: "copilot_llm" | "deterministic";
  actionsExecuted?: PznCopilotActionLog[];
  cards?: PznCopilotCard[];
  suggestedPrompts?: string[];
  feedback?: "up" | "down";
  error?: boolean;
};

type RecThread = {
  id: string;
  title: string;
  updatedAt: number;
  activeContextId?: string;
  messages: RecMessage[];
};

const STORAGE_KEY = "cep-rec-workspace-threads-v1";
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function loadStoredThreads(): RecThread[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, 20) : [];
  } catch {
    return [];
  }
}

function saveStoredThreads(threads: RecThread[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(threads.slice(0, 20)));
  } catch { /* ignore storage quota */ }
}

function formatRichText(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={idx}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={idx} className="pzn-code">{part.slice(1, -1)}</code>;
    return <span key={idx}>{part}</span>;
  });
}

const SECTION_TABS: { id: WorkspaceSection; label: string; Icon: typeof LayoutDashboard }[] = [
  { id: "summary", label: "Summary", Icon: LayoutDashboard },
  { id: "contexts", label: "Contexts & Contents", Icon: Layers },
  { id: "rules", label: "Rules", Icon: SlidersHorizontal },
  { id: "dictionary", label: "Dictionary", Icon: BookOpen },
  { id: "live_ts", label: "Live TS", Icon: Play },
  { id: "approvals", label: "Approvals", Icon: ShieldCheck },
];

const RAIL_TOPICS = [
  { id: "approvals", label: "Pending Approvals", prompt: "Show pending approvals", Icon: ShieldCheck },
  { id: "define_rule", label: "Define a Rule (Widget)", prompt: "Open the interactive rule builder widget", Icon: SlidersHorizontal },
  { id: "context_matrix", label: "Contexts & Attached Contents", prompt: "Show all contexts with attached contents and rules", Icon: Layers },
  { id: "rules_list", label: "All Rules Catalog", prompt: "Show all rules", Icon: FileText },
  { id: "dictionary", label: "Data Dictionary", prompt: "Show all Data Dictionary namespaces and business definitions", Icon: BookOpen },
  { id: "live_ts", label: "Run Live TS (Alice & Jordan)", prompt: `Test ${wealthRecommendationsTopic.displayName} for Alice Morgan and Jordan Lee`, Icon: Play },
];

export function RecommendationWorkspace() {
  const [workspace, setWorkspace] = useState<PznStudioWorkspaceState | null>(null);
  const [error, setError] = useState("");
  const [threads, setThreads] = useState<RecThread[]>(() => loadStoredThreads());
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [section, setSection] = useState<WorkspaceSection>("summary");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeMid, setActiveMid] = useState("DEMO-MID-1001");
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [ambientDismissed, setAmbientDismissed] = useState(false);
  const [expandedReasoning, setExpandedReasoning] = useState<Record<string, boolean>>({});
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void api.pznWorkspace().then((ws) => {
      if (!alive) return;
      setWorkspace(ws);
      if (ws.customers[0]) setActiveMid(ws.customers[0].syntheticMid);
    }, (err) => {
      if (alive) setError(toolSetupErrorMessage(err));
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    saveStoredThreads(threads);
  }, [threads]);

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );

  useEffect(() => {
    if (activeThread) {
      scrollEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [activeThread?.messages.length, busy]);

  const activeCustomer = useMemo(
    () => workspace?.customers.find((c) => c.syntheticMid === activeMid) ?? workspace?.customers[0],
    [workspace, activeMid],
  );

  const visibleThreads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return q ? threads.filter((t) => t.title.toLowerCase().includes(q)) : threads;
  }, [threads, searchQuery]);

  async function sendPrompt(overrideText?: string) {
    const trimmed = (overrideText ?? input).trim();
    if (!trimmed || busy || !workspace) return;
    setInput("");
    setRailOpen(false);

    const nowTs = timeFormat.format(new Date());
    const userMsg: RecMessage = { id: "u_" + Date.now(), role: "user", text: trimmed, timestamp: nowTs };

    let targetThreadId = activeThreadId;
    let historyForApi: { role: "user" | "assistant"; text: string }[] = [];
    let activeCtx = activeThread?.activeContextId ?? workspace.contexts[0]?.contextId;

    if (!targetThreadId) {
      const newId = "rec_" + Date.now().toString(36);
      const created: RecThread = {
        id: newId,
        title: trimmed.length > 42 ? trimmed.slice(0, 42) + "…" : trimmed,
        updatedAt: Date.now(),
        activeContextId: activeCtx,
        messages: [userMsg],
      };
      targetThreadId = newId;
      historyForApi = [{ role: "user", text: trimmed }];
      setThreads((prev) => [created, ...prev]);
      setActiveThreadId(newId);
    } else {
      const existing = threads.find((t) => t.id === targetThreadId);
      historyForApi = [...(existing?.messages ?? []), userMsg].slice(-10).map((m) => ({ role: m.role, text: m.text }));
      activeCtx = existing?.activeContextId ?? activeCtx;
      setThreads((prev) => prev.map((t) => (
        t.id === targetThreadId ? { ...t, updatedAt: Date.now(), messages: [...t.messages, userMsg] } : t
      )));
    }

    setBusy(true);
    try {
      const res = await api.pznCopilot({
        message: trimmed,
        history: historyForApi,
        ...(activeCtx ? { activeContextId: activeCtx } : {}),
      });
      setWorkspace(res.workspace);
      const assistantMsg: RecMessage = {
        id: "a_" + Date.now(),
        role: "assistant",
        text: res.reply,
        timestamp: timeFormat.format(new Date()),
        generatedBy: res.generatedBy,
        actionsExecuted: res.actionsExecuted,
        cards: res.cards,
        suggestedPrompts: res.suggestedPrompts,
      };
      setThreads((prev) => prev.map((t) => (
        t.id === targetThreadId
          ? {
              ...t,
              updatedAt: Date.now(),
              activeContextId: res.activeContextId ?? t.activeContextId,
              messages: [...t.messages, assistantMsg],
            }
          : t
      )));
    } catch (err) {
      const errMsg: RecMessage = {
        id: "e_" + Date.now(),
        role: "assistant",
        text: toolSetupErrorMessage(err),
        timestamp: timeFormat.format(new Date()),
        error: true,
      };
      setThreads((prev) => prev.map((t) => (
        t.id === targetThreadId ? { ...t, updatedAt: Date.now(), messages: [...t.messages, errMsg] } : t
      )));
    } finally {
      setBusy(false);
    }
  }

  function onComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendPrompt();
    }
  }

  function setFeedback(msgId: string, val: "up" | "down") {
    if (!activeThreadId) return;
    setThreads((prev) => prev.map((t) => (
      t.id === activeThreadId
        ? { ...t, messages: t.messages.map((m) => (m.id === msgId ? { ...m, feedback: val } : m)) }
        : t
    )));
  }

  const publishedCount = workspace?.contexts.filter((c) => c.status === "published" && c.publishedVersion > 0).length ?? 0;
  const totalAttrs = workspace?.dictionary.namespaces.reduce((acc, ns) => acc + ns.attributes.length, 0) ?? 0;

  const latestAssistant = activeThread
    ? [...activeThread.messages].reverse().find((m) => m.role === "assistant")
    : undefined;

  const recommendedActions = useMemo(() => {
    if (latestAssistant?.suggestedPrompts?.length) {
      return latestAssistant.suggestedPrompts.slice(0, 3).map((p) => ({ label: p.length > 44 ? p.slice(0, 44) + "…" : p, prompt: p }));
    }
    return [
      { label: "Open Rule Builder Widget", prompt: "Open the interactive rule builder widget" },
      { label: "Contexts & Attached Contents", prompt: "Show all contexts with attached contents and rules" },
      { label: `Run Live TS for ${activeCustomer?.displayName ?? "Alice"}`, prompt: `Test ${wealthRecommendationsTopic.displayName} for ${activeCustomer?.displayName ?? "Alice Morgan"} and Jordan Lee` },
    ];
  }, [latestAssistant, activeCustomer]);

  const ambientActions = useMemo(() => {
    switch (section) {
      case "rules":
        return [
          { label: "Open Rule Builder in Chat", prompt: "Open the interactive rule builder widget" },
          { label: "Show All Governed Rules", prompt: "Show all rules" },
          { label: "Inspect Data Dictionary", prompt: "Show all Data Dictionary namespaces and business definitions" },
        ];
      case "contexts":
        return [
          { label: "Create & Publish Treasury Recommendation", prompt: "Create a Treasury Ladder recommendation for cash over $20,000, attach to context treasury_nudge, and publish it" },
          { label: "Show Contexts & Attachments", prompt: "Show all contexts with attached contents and rules" },
          { label: "Compare Alice vs Jordan TS", prompt: `Test ${wealthRecommendationsTopic.displayName} for Alice Morgan and Jordan Lee` },
        ];
      case "dictionary":
        return [
          { label: "Add loyalty.vip_tier Attribute", prompt: "Add custom attribute loyalty.vip_tier (gold/platinum) to the Data Dictionary" },
          { label: "Show Full Data Dictionary", prompt: "Show all Data Dictionary namespaces and business definitions" },
          { label: "Open Rule Builder Widget", prompt: "Open the interactive rule builder widget" },
        ];
      case "live_ts":
        return [
          { label: "Compare Alice & Jordan MIDs", prompt: `Test ${wealthRecommendationsTopic.displayName} for Alice Morgan and Jordan Lee` },
          { label: "What-if Alice Cash = $5,000", prompt: `Simulate ${wealthRecommendationsTopic.displayName} for Alice Morgan with portfolio.cash_usd = 5000` },
          { label: "Show Context Matrix", prompt: "Show all contexts with attached contents and rules" },
        ];
      case "approvals":
        return [
          { label: "Show Pending Approvals", prompt: "Show pending approvals" },
          { label: `Publish ${wealthRecommendationsTopic.displayName}`, prompt: `Publish ${wealthRecommendationsTopic.displayName}` },
          { label: "Show Context Matrix", prompt: "Show all contexts with attached contents and rules" },
        ];
      default:
        return [
          { label: "Define a Rule (Widget)", prompt: "Open the interactive rule builder widget" },
          { label: "Contexts & Attached Contents", prompt: "Show all contexts with attached contents and rules" },
          { label: "Run Live TS (Alice & Jordan)", prompt: `Test ${wealthRecommendationsTopic.displayName} for Alice Morgan and Jordan Lee` },
        ];
    }
  }, [section]);

  return (
    <div className={"app-layout rec-ws-layout" + (railCollapsed ? " rail-collapsed" : "")}>
      {railOpen && <button className="rail-scrim" aria-label="Close navigation" onClick={() => setRailOpen(false)} />}

      {/* ======== LEFT SIDEBAR (Matches Wealth Chat Rail) ======== */}
      <aside className={"rail" + (railOpen ? " rail-open" : "")} id="rec-rail" aria-label="Recommendations workspace navigation">
        <div className="rail-header">
          <a className="rail-home" href="/recommendations">
            <LabMark />
            <span className="rail-brand-text">
              <strong>CEP</strong>
              <small>Recommendations</small>
            </span>
          </a>
          <button
            className="icon-button rail-collapse-desktop"
            type="button"
            aria-label="Collapse sidebar"
            onClick={() => setRailCollapsed(true)}
          >
            <PanelLeftClose size={17} aria-hidden="true" />
          </button>
          <button className="icon-button rail-close" type="button" aria-label="Close navigation" onClick={() => setRailOpen(false)}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <button
          type="button"
          className="new-conversation"
          disabled={busy}
          onClick={() => {
            setActiveThreadId(null);
            setSection("summary");
            setRailOpen(false);
          }}
        >
          <Plus size={17} aria-hidden="true" />New conversation
        </button>

        <div className="rail-section rail-workbench-nav">
          <button
            type="button"
            className="rail-link rail-overview"
            aria-current={!activeThread ? "page" : undefined}
            onClick={() => {
              setActiveThreadId(null);
              setSection("summary");
              setRailOpen(false);
            }}
          >
            <LayoutDashboard size={16} aria-hidden="true" />Overview
          </button>
        </div>

        <section className="rail-section rec-threads-section" aria-label="Chat threads">
          <h2>Chat Threads</h2>
          <div className="rec-search-box">
            <Search size={13} aria-hidden="true" />
            <input
              type="search"
              placeholder="Search threads"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search recommendation threads"
            />
          </div>
          <nav className="rec-thread-list">
            {visibleThreads.length === 0 ? (
              <p className="rec-empty-threads">Start a chat below or pick a widget action.</p>
            ) : (
              visibleThreads.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="rail-link"
                  aria-current={activeThreadId === t.id ? "page" : undefined}
                  onClick={() => {
                    setActiveThreadId(t.id);
                    setRailOpen(false);
                  }}
                >
                  <Sparkles size={13} aria-hidden="true" />
                  <span className="rec-thread-title">{t.title}</span>
                </button>
              ))
            )}
          </nav>
        </section>

        <section className="rail-section rail-topics" aria-label="Recommendation widgets and actions">
          <h2>Widgets &amp; Topics</h2>
          <nav>
            {RAIL_TOPICS.map(({ id, label, prompt, Icon }) => (
              <button
                key={id}
                type="button"
                className="rail-link"
                disabled={busy || !workspace}
                onClick={() => void sendPrompt(prompt)}
              >
                <Icon size={15} aria-hidden="true" />{label}
              </button>
            ))}
          </nav>
        </section>

        <div className="rail-footer">
          {workspace && activeCustomer && (
            <div className="rec-profile-switcher-wrap">
              <button
                className="rail-profile"
                type="button"
                onClick={() => setProfileMenuOpen((v) => !v)}
                aria-expanded={profileMenuOpen}
              >
                <ProfileAvatar name={activeCustomer.displayName} />
                <span className="rail-profile-copy">
                  <strong>{activeCustomer.displayName}</strong>
                  <small>MID: {activeCustomer.syntheticMid}</small>
                </span>
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              {profileMenuOpen && (
                <div className="rec-profile-menu" role="menu">
                  <div className="rec-profile-menu-label">Test MID Persona</div>
                  {workspace.customers.map((c) => (
                    <button
                      key={c.syntheticMid}
                      type="button"
                      className={"rec-profile-option" + (c.syntheticMid === activeMid ? " is-active" : "")}
                      onClick={() => {
                        setActiveMid(c.syntheticMid);
                        setProfileMenuOpen(false);
                      }}
                    >
                      <strong>{c.displayName}</strong>
                      <span>{c.syntheticMid} · {c.segment}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <a className="rail-account" href={adminPaths.recommendations}>
            <Settings2 size={16} aria-hidden="true" />Admin Studio
          </a>
        </div>
      </aside>

      {/* ======== MAIN WORKSPACE (Matches Wealth Topbar + Ambient Bar + Chat) ======== */}
      <main className="workspace rec-ws-main">
        <header className="topbar unified-topbar">
          <div className="topbar-left">
            <button className="icon-button rail-menu" type="button" aria-label="Show navigation" onClick={() => setRailOpen((o) => !o)}>
              <PanelLeft size={19} aria-hidden="true" />
            </button>
            {railCollapsed && (
              <button className="icon-button rail-expand-desktop" type="button" aria-label="Expand sidebar" onClick={() => setRailCollapsed(false)}>
                <PanelLeft size={18} aria-hidden="true" />
              </button>
            )}
            <span className="workspace-crumb">
              {activeCustomer?.displayName ?? "Recommendations"}
              <ChevronRight size={13} aria-hidden="true" />
            </span>
            <h1>{activeThread?.title ?? SECTION_TABS.find((t) => t.id === section)?.label ?? "Summary"}</h1>
          </div>

          <div className="topbar-center">
            <nav className="rec-topbar-tabs" aria-label="Recommendation workspace views">
              {SECTION_TABS.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  className={"rec-topbar-tab" + (!activeThread && section === id ? " is-active" : "")}
                  onClick={() => {
                    setActiveThreadId(null);
                    setSection(id);
                    setAmbientDismissed(false);
                  }}
                >
                  <Icon size={14} aria-hidden="true" /> {label}
                </button>
              ))}
            </nav>
          </div>

          <div className="topbar-actions">
            <ThemeToggle compact />
            <span className="model-status" data-connected="true">
              <span aria-hidden="true" />Live · auto
            </span>
          </div>
        </header>

        {/* ======== AMBIENT WORKSPACE CONTEXT BAR (Identical to Wealth) ======== */}
        {workspace && !ambientDismissed && (
          <section className="embed-ambient-bar" aria-label="Ambient Recommendation Workspace Context">
            <div className="embed-ambient-top">
              <div className="embed-ambient-title">
                <span className="embed-ambient-pill">
                  <Eye size={12} aria-hidden="true" />
                  Ambient Workspace Context
                </span>
                <strong>
                  Viewing: {activeThread ? "Live Self-Service Chat" : (SECTION_TABS.find((t) => t.id === section)?.label ?? "Summary")} · MID: {activeMid}
                </strong>
              </div>
              <div className="embed-ambient-right">
                <div className="embed-ambient-metrics">
                  <span className="embed-ambient-metric">Published: <b>{publishedCount}/{workspace.contexts.length}</b></span>
                  <span className="embed-ambient-metric">Contents: <b>{workspace.contents.length}</b></span>
                  <span className="embed-ambient-metric">Rules: <b>{workspace.rules.length}</b></span>
                  <span className="embed-ambient-metric">Dictionary: <b>{totalAttrs} attrs</b></span>
                </div>
                <button
                  type="button"
                  className="icon-button embed-ambient-close"
                  aria-label="Hide ambient context bar"
                  onClick={() => setAmbientDismissed(true)}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            </div>
            <p className="embed-ambient-summary">
              Active test persona: {activeCustomer?.displayName} ({activeMid} · {activeCustomer?.segment}). Switch tabs or click a recommended action to build rules, inspect contexts &amp; attached contents, or evaluate Live Treatment Selector.
            </p>
            <div className="embed-ambient-actions">
              {ambientActions.map((act) => (
                <button key={act.label} type="button" className="embed-ambient-action" disabled={busy} onClick={() => void sendPrompt(act.prompt)}>
                  <Sparkles size={12} aria-hidden="true" /> {act.label}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* ======== MAIN SCROLL CANVAS (OVERVIEW WIDGETS OR WEALTH-STYLE CHAT) ======== */}
        <div className="rec-ws-scroll pzn-studio">
          {error && <p className="pzn-error" role="alert">{error}</p>}
          {!workspace ? (
            <p className="pzn-subtitle" role="status">Loading Recommendations Workspace…</p>
          ) : !activeThread ? (
            <div className="rec-overview-canvas">
              {section === "summary" && (
                <>
                  <div className="rec-overview-banner">
                    <h2>Recommendations Self-Service Workspace</h2>
                    <p>
                      Author Data Dictionary rules, manage contexts &amp; attached text contents, publish immutable snapshots, and test live Treatment Selector runs for <strong>{activeCustomer?.displayName}</strong> ({activeMid}) — powered by registered <code>sfield</code> tools.
                    </p>
                    <div className="pzn-rule-chips" style={{ marginTop: 10 }}>
                      {(workspace.registeredSfieldTools ?? []).map((t) => (
                        <span key={t.ref} className="pzn-badge is-published" title={t.description}>
                          sfield · {t.ref} ({t.label})
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="rec-widgets-stack">
                    <ContextMatrixWidget
                      workspace={workspace}
                      activeMid={activeMid}
                      onWorkspaceChange={setWorkspace}
                      onRunPrompt={(p) => void sendPrompt(p)}
                    />
                    <RuleBuilderWidget
                      workspace={workspace}
                      activeMid={activeMid}
                      onWorkspaceChange={setWorkspace}
                      onRunPrompt={(p) => void sendPrompt(p)}
                    />
                    <LiveTsRunnerWidget workspace={workspace} activeMid={activeMid} />
                  </div>
                </>
              )}

              {section === "contexts" && (
                <div className="rec-widgets-stack">
                  <ContextMatrixWidget
                    workspace={workspace}
                    activeMid={activeMid}
                    onWorkspaceChange={setWorkspace}
                    onRunPrompt={(p) => void sendPrompt(p)}
                  />
                  <ContentLibraryWidget workspace={workspace} onWorkspaceChange={setWorkspace} />
                </div>
              )}

              {section === "rules" && (
                <div className="rec-widgets-stack">
                  <RuleBuilderWidget
                    workspace={workspace}
                    activeMid={activeMid}
                    onWorkspaceChange={setWorkspace}
                    onRunPrompt={(p) => void sendPrompt(p)}
                  />
                  <RulesCatalogWidget
                    workspace={workspace}
                    activeMid={activeMid}
                    onRunPrompt={(p) => void sendPrompt(p)}
                  />
                </div>
              )}

              {section === "dictionary" && (
                <div className="rec-widgets-stack">
                  <DictionaryWidget workspace={workspace} onWorkspaceChange={setWorkspace} />
                  <ContentLibraryWidget workspace={workspace} onWorkspaceChange={setWorkspace} />
                </div>
              )}

              {section === "live_ts" && (
                <div className="rec-widgets-stack">
                  <LiveTsRunnerWidget workspace={workspace} activeMid={activeMid} />
                  <RulesCatalogWidget
                    workspace={workspace}
                    activeMid={activeMid}
                    onRunPrompt={(p) => void sendPrompt(p)}
                  />
                </div>
              )}

              {section === "approvals" && (
                <div className="rec-widgets-stack">
                  <ApprovalQueueWidget onWorkspaceChange={setWorkspace} onRunPrompt={(p) => void sendPrompt(p)} />
                </div>
              )}
            </div>
          ) : (
            <div className="rec-chat-stream" aria-label="Recommendation conversation">
              {activeThread.messages.map((msg) => (
                <article key={msg.id} className={"rec-turn rec-turn-" + msg.role}>
                  {msg.role === "user" ? (
                    <div className="rec-wealth-user-row">
                      <ProfileAvatar name={activeCustomer?.displayName ?? "Operator"} />
                      <div className="rec-wealth-msg-col">
                        <div className="rec-wealth-meta">
                          <strong>{activeCustomer?.displayName ?? "Operator"}</strong>
                          <span>{msg.timestamp}</span>
                        </div>
                        <div className="rec-wealth-user-bubble">{msg.text}</div>
                      </div>
                    </div>
                  ) : (
                    <div className="rec-wealth-assistant-row">
                      <div className="rec-assistant-avatar" aria-hidden="true"><LabMark /></div>
                      <div className="rec-wealth-msg-col">
                        <div className="rec-wealth-meta">
                          <strong>CEP Assistant</strong>
                          <span>{msg.timestamp}</span>
                        </div>

                        {msg.actionsExecuted && msg.actionsExecuted.length > 0 && (
                          <div className="rec-reasoning-wrap">
                            <button
                              type="button"
                              className="rec-reasoning-pill"
                              onClick={() => setExpandedReasoning((p) => ({ ...p, [msg.id]: !p[msg.id] }))}
                              aria-expanded={Boolean(expandedReasoning[msg.id])}
                            >
                              <Sparkles size={13} aria-hidden="true" />
                              <strong>Advisory Reasoning</strong>
                              <span className="rec-reasoning-tag">
                                {msg.generatedBy === "copilot_llm" ? "Copilot ACP" : "Verified PZN Engine"}
                              </span>
                              <span className="rec-reasoning-count">
                                {msg.actionsExecuted.length} governed tool{msg.actionsExecuted.length === 1 ? "" : "s"} completed
                              </span>
                              <ChevronDown size={13} aria-hidden="true" />
                            </button>
                            {expandedReasoning[msg.id] && (
                              <ul className="rec-reasoning-list">
                                {msg.actionsExecuted.map((a, i) => (
                                  <li key={i} className={a.status === "ok" ? "is-ok" : a.status === "pending" ? "is-pending" : "is-err"}>
                                    <span className="pzn-code">{a.sfieldToolRef ?? a.tool}</span>
                                    {a.sfieldRunId && <span className="pzn-badge" style={{ marginLeft: 6 }}>{a.sfieldRunId.slice(0, 14)}</span>}{" "}
                                    {a.summary}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}

                        <div className={"rec-wealth-assistant-card" + (msg.error ? " is-error" : "")}>
                          <p className="pzn-assistant-text">{formatRichText(msg.text)}</p>
                        </div>

                        {msg.cards && msg.cards.length > 0 && (
                          <div className="pzn-chat-cards">
                            {msg.cards.map((card, cIdx) => (
                              <InlineCard
                                key={cIdx}
                                card={card}
                                workspace={workspace}
                                activeMid={activeMid}
                                busy={busy}
                                onWorkspaceChange={setWorkspace}
                                onSendPrompt={(p) => void sendPrompt(p)}
                              />
                            ))}
                          </div>
                        )}

                        <div className="rec-feedback-row">
                          <span>Was this helpful?</span>
                          <button
                            type="button"
                            className={"rec-fb-btn" + (msg.feedback === "up" ? " is-active" : "")}
                            aria-label="Helpful"
                            onClick={() => setFeedback(msg.id, "up")}
                          >
                            <ThumbsUp size={13} />
                          </button>
                          <button
                            type="button"
                            className={"rec-fb-btn" + (msg.feedback === "down" ? " is-active" : "")}
                            aria-label="Not helpful"
                            onClick={() => setFeedback(msg.id, "down")}
                          >
                            <ThumbsDown size={13} />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </article>
              ))}
              {busy && (
                <div className="rec-wealth-assistant-row">
                  <div className="rec-assistant-avatar" aria-hidden="true"><LabMark /></div>
                  <div className="rec-wealth-msg-col">
                    <div className="rec-wealth-meta"><strong>CEP Assistant</strong><span>Evaluating…</span></div>
                    <div className="rec-wealth-assistant-card">
                      <span className="pzn-subtitle">Running Data Dictionary checks, Rule Engine, and Treatment Selector…</span>
                    </div>
                  </div>
                </div>
              )}
              <div ref={scrollEndRef} />
            </div>
          )}
        </div>

        {/* ======== WEALTH-STYLE RECOMMENDED ACTIONS + COMPOSER FOOTER ======== */}
        <footer className="rec-composer-dock">
          <div className="rec-recommended-actions" aria-label="Recommended actions">
            {recommendedActions.map((act) => (
              <button
                key={act.label}
                type="button"
                className="rec-action-chip"
                disabled={busy || !workspace}
                onClick={() => void sendPrompt(act.prompt)}
              >
                <Sparkles size={13} aria-hidden="true" /> {act.label}
              </button>
            ))}
          </div>

          <form
            className="rec-composer-form"
            onSubmit={(e) => {
              e.preventDefault();
              void sendPrompt();
            }}
          >
            <textarea
              id="rec-workspace-composer"
              rows={1}
              value={input}
              disabled={busy || !workspace}
              onKeyDown={onComposerKeyDown}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask to define a rule, view contexts & attached contents, publish to TS, or test any MID..."
              aria-label="Ask Recommendation Self-Service Assistant"
            />
            <button type="submit" className="rec-send-button" disabled={busy || !input.trim()}>
              Send <ArrowUp size={14} aria-hidden="true" />
            </button>
          </form>

          <div className="rec-composer-meta">
            <span>CEP Recommendation Guardrails Active</span>
            <span>Enter to send · Shift+Enter for a new line</span>
          </div>
        </footer>
      </main>
    </div>
  );
}
