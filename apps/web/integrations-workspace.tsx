import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, ChevronDown, ChevronRight, Clock, Download, FileCode2, FilePlus2, PanelLeft, PanelLeftClose, Plug, Plus, Search, Settings2, ShieldCheck, Sparkles, Ticket, X } from "lucide-react";
import { adminPaths } from "../../packages/contracts/admin-paths";
import type { ApprovalRecord } from "../../packages/contracts/approval";
import type { IntegrationCopilotCard, IntegrationCopilotResponse, TaskRun } from "../../packages/contracts/integration-task";
import { api, toolSetupErrorMessage } from "./api";
import { LabMark } from "./lab-mark";
import { ApprovalRequestCard } from "./recommendation-approvals";
import { CatalogCard, ContractCard, IntegrationApprovalsCard, RunsCard, TaskFormCard, TaskRunCard } from "./integrations-cards";
import { DraftsCard, IntegrationFormCard, McpImportCard, PublishReviewCard, TaskDraftCard } from "./integrations-authoring-cards";
import { ThemeToggle } from "./theme";
import "./customer-workbench.css";
import "./recommendation-studio.css";
import "./recommendation-workspace.css";

type Card = IntegrationCopilotCard | { kind: "approval"; approval: ApprovalRecord };
type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  cards?: Card[];
  actions?: IntegrationCopilotResponse["actions"];
  generatedBy?: IntegrationCopilotResponse["generatedBy"];
  suggestions?: string[];
  error?: boolean;
};
type Thread = { id: string; title: string; updatedAt: number; messages: Message[] };

const STORAGE_KEY = "cep-integrations-threads-v1";
const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const STARTERS = [
  { Icon: Ticket, title: "Create a ticket", subtitle: "Draft from plain English, confirm, and run. P1 needs approval.", prompt: "Create a P1 ticket for checkout outage on payments" },
  { Icon: FileCode2, title: "Generate a schema", subtitle: "Turn a JSON sample into a validated schema artifact.", prompt: "Generate a schema for Order from {\"id\": 42, \"items\": [{\"sku\": \"A1\", \"qty\": 2}], \"paid\": true}" },
  { Icon: Download, title: "Connect an MCP server", subtitle: "Connect, import its tools as task drafts, review and publish.", prompt: "Connect an MCP server" },
  { Icon: FilePlus2, title: "Create a task", subtitle: "Describe it in plain English; edit the drafted contract; publish.", prompt: "Create a task to look up an order by orderId" },
  { Icon: Plug, title: "Browse integrations", subtitle: "See every task, its effect, approval rule, and contract.", prompt: "Show integrations and tasks" },
  { Icon: ShieldCheck, title: "Pending approvals", subtitle: "Approve or deny calls that sfield is holding.", prompt: "Show pending approvals" },
];

const QUICK = [
  { label: "Integrations & tasks", prompt: "Show integrations and tasks", Icon: Plug },
  { label: "Create a ticket", prompt: "Create a P3 ticket for disk alert on database", Icon: Ticket },
  { label: "Generate a schema", prompt: STARTERS[1].prompt, Icon: FileCode2 },
  { label: "Recent runs", prompt: "Show recent task runs", Icon: Clock },
  { label: "Unknown outcomes", prompt: "Reconcile unknown outcomes", Icon: Search },
  { label: "Pending approvals", prompt: "Show pending approvals", Icon: ShieldCheck },
  { label: "Create a task", prompt: "Create a new task", Icon: FilePlus2 },
  { label: "Connect MCP server", prompt: "Connect an MCP server", Icon: Download },
  { label: "Drafts", prompt: "Show drafts", Icon: FileCode2 },
];

function load(): Thread[] {
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? (JSON.parse(raw) as Thread[]).slice(0, 20) : []; } catch { return []; }
}

function rich(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i} className="pzn-code">{part.slice(1, -1)}</code>;
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>;
    return <span key={i}>{part}</span>;
  });
}

export function IntegrationsWorkspace() {
  const [threads, setThreads] = useState<Thread[]>(load);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pendingCount, setPendingCount] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(threads.slice(0, 20))); } catch { /* quota */ } }, [threads]);
  const active = useMemo(() => threads.find((t) => t.id === activeId) ?? null, [threads, activeId]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [active?.messages.length, busy]);
  useEffect(() => {
    const refresh = () => void api.approvals().then((v) => setPendingCount(v.approvals.filter((a) => a.domain === "integration" && a.status === "pending").length)).catch(() => undefined);
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [active?.messages.length]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? threads.filter((t) => t.title.toLowerCase().includes(q)) : threads;
  }, [threads, search]);

  function ensureThread(firstText: string): string {
    if (activeId) return activeId;
    const id = "int_" + Date.now().toString(36);
    setThreads((prev) => [{ id, title: firstText.slice(0, 44) + (firstText.length > 44 ? "…" : ""), updatedAt: Date.now(), messages: [] }, ...prev]);
    setActiveId(id);
    return id;
  }

  function append(threadId: string, message: Message) {
    setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, updatedAt: Date.now(), messages: [...t.messages, message] } : t)));
  }

  async function send(text?: string) {
    const message = (text ?? input).trim();
    if (!message || busy) return;
    setInput("");
    setRailOpen(false);
    const threadId = ensureThread(message);
    const history = (threads.find((t) => t.id === threadId)?.messages ?? []).slice(-8).map((m) => ({ role: m.role, text: m.text.slice(0, 1400) }));
    append(threadId, { id: "u_" + Date.now(), role: "user", text: message, at: time.format(new Date()) });
    setBusy(true);
    try {
      const res = await api.integrationCopilot({ message, history });
      append(threadId, {
        id: "a_" + Date.now(), role: "assistant", text: res.reply, at: time.format(new Date()),
        cards: res.cards, actions: res.actions, generatedBy: res.generatedBy, suggestions: res.suggestedPrompts,
      });
    } catch (err) {
      append(threadId, { id: "e_" + Date.now(), role: "assistant", text: toolSetupErrorMessage(err), at: time.format(new Date()), error: true });
    } finally {
      setBusy(false);
    }
  }

  /** A confirmed form posts its result back into the same conversation. */
  function onSubmitted(threadId: string, run: TaskRun, approval?: ApprovalRecord) {
    const text = approval
      ? `Held for approval. sfield won't run this exact call until someone approves it${approval.dualControl ? " (a second approver is required)" : ""}.`
      : run.state === "succeeded" ? `Done: **${run.taskId}** ${run.outcome ? `returned ${run.outcome.code}` : "succeeded"}.`
      : run.state === "outcome_unknown" ? "The integration didn't answer reliably, so the outcome is unknown. Reconcile before retrying."
      : run.state === "succeeded_unverified_output" ? "It went through, but the response didn't match the contract. It won't be retried."
      : `It didn't go through: ${run.error?.message ?? run.state}.`;
    append(threadId, {
      id: "r_" + Date.now(), role: "assistant", text, at: time.format(new Date()),
      cards: approval ? [{ kind: "approval", approval }, { kind: "task_run", run }] : [{ kind: "task_run", run }],
      actions: [{ tool: run.toolRef, summary: approval ? `pending approval ${approval.id}` : run.state, status: approval ? "pending" : run.state === "failed" ? "error" : "ok" }],
    });
  }

  const refreshPending = () => void api.approvals()
    .then((v) => setPendingCount(v.approvals.filter((a) => a.domain === "integration" && a.status === "pending").length))
    .catch(() => undefined);

  /** An approve/deny decision posts the final task outcome back into the conversation. */
  async function afterDecision(threadId: string, record: ApprovalRecord) {
    refreshPending();
    const view = await api.integrations().catch(() => null);
    const run = view?.runs.find((r) => r.approvalId === record.id);
    const who = record.decidedBy ?? "the approver";
    const text = record.status === "denied"
      ? `Denied by ${who}. Nothing was sent to the integration.`
      : run ? `Approved by ${who}. **${run.taskId}** ${run.state === "succeeded" ? `returned ${run.outcome?.code ?? "success"}` : `ended as ${run.state.replaceAll("_", " ")}`}.`
      : `Approved by ${who}.`;
    append(threadId, {
      id: "d_" + Date.now(), role: "assistant", text, at: time.format(new Date()),
      ...(run ? { cards: [{ kind: "task_run" as const, run }] } : {}),
      actions: [{ tool: "approval.decision", summary: `${record.id} → ${record.status}`, status: record.status === "denied" ? "error" : "ok" }],
    });
  }

  function renderCard(card: Card, threadId: string, key: number) {
    const prompt = (p: string) => void send(p);
    const post = (text: string, opts?: { suggestions?: string[] }) => append(threadId, {
      id: "s_" + Date.now() + Math.random().toString(36).slice(2, 6), role: "assistant", text, at: time.format(new Date()),
      actions: [{ tool: "authoring", summary: text.replace(/\*\*/g, "").slice(0, 120), status: "ok" }],
      ...(opts?.suggestions ? { suggestions: opts.suggestions } : {}),
    });
    switch (card.kind) {
      case "integration_form": return <IntegrationFormCard key={key} prefill={card.prefill} existing={card.existing} onPrompt={prompt} post={post} />;
      case "task_draft": return <TaskDraftCard key={key} draft={card.draft} check={card.check} origin={card.origin} note={card.note} onPrompt={prompt} post={post} />;
      case "mcp_import": return <McpImportCard key={key} integrationId={card.integrationId} candidates={card.candidates} error={card.error} onPrompt={prompt} post={post} />;
      case "publish_review": return <PublishReviewCard key={key} contract={card.contract} check={card.check} onPrompt={prompt} post={post} />;
      case "drafts": return <DraftsCard key={key} drafts={card.drafts} onPrompt={prompt} />;
      case "catalog": return <CatalogCard key={key} view={card.view} onPrompt={prompt} />;
      case "contract": return <ContractCard key={key} contract={card.contract} onPrompt={prompt} />;
      case "task_form": return <TaskFormCard key={key} contract={card.contract} prefill={card.prefill} provenance={card.provenance} onSubmitted={(run, approval) => onSubmitted(threadId, run, approval)} />;
      case "task_run": return <TaskRunCard key={key} run={card.run} onPrompt={prompt} />;
      case "runs": return <RunsCard key={key} runs={card.runs} filter={card.filter} onPrompt={prompt} />;
      case "approvals": return <IntegrationApprovalsCard key={key} onPrompt={prompt} onDecided={(r) => void afterDecision(threadId, r)} />;
      case "approval": return <ApprovalRequestCard key={key} approval={card.approval} onRunPrompt={prompt} onDecided={(r) => void afterDecision(threadId, r)} />;
    }
  }

  const lastAssistant = active ? [...active.messages].reverse().find((m) => m.role === "assistant") : undefined;
  const chips = lastAssistant?.suggestions?.length ? lastAssistant.suggestions : ["Show integrations and tasks", "Show recent task runs", "Show pending approvals"];

  return (
    <div className={"app-layout rec-ws-layout" + (railCollapsed ? " rail-collapsed" : "")}>
      {railOpen && <button className="rail-scrim" aria-label="Close navigation" onClick={() => setRailOpen(false)} />}
      <aside className={"rail" + (railOpen ? " rail-open" : "")} aria-label="Integrations navigation">
        <div className="rail-header">
          <a className="rail-home" href="/integrations">
            <LabMark />
            <span className="rail-brand-text"><strong>CEP</strong><small>Integrations</small></span>
          </a>
          <button className="icon-button rail-collapse-desktop" type="button" aria-label="Collapse sidebar" onClick={() => setRailCollapsed(true)}><PanelLeftClose size={17} /></button>
          <button className="icon-button rail-close" type="button" aria-label="Close navigation" onClick={() => setRailOpen(false)}><X size={20} /></button>
        </div>
        <button type="button" className="new-conversation" disabled={busy} onClick={() => { setActiveId(null); setRailOpen(false); }}>
          <Plus size={17} />New conversation
        </button>
        <section className="rail-section rec-threads-section" aria-label="Chat threads">
          <h2>Chat Threads</h2>
          <div className="rec-search-box">
            <Search size={13} />
            <input type="search" placeholder="Search threads" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search threads" />
          </div>
          <nav className="rec-thread-list">
            {visible.length === 0 ? <p className="rec-empty-threads">Ask anything below to start.</p> : visible.map((t) => (
              <button key={t.id} type="button" className="rail-link" aria-current={activeId === t.id ? "page" : undefined} onClick={() => { setActiveId(t.id); setRailOpen(false); }}>
                <Sparkles size={13} /><span className="rec-thread-title">{t.title}</span>
              </button>
            ))}
          </nav>
        </section>
        <section className="rail-section rail-topics" aria-label="Quick actions">
          <h2>Ask about</h2>
          <nav>
            {QUICK.map(({ label, prompt, Icon }) => (
              <button key={label} type="button" className="rail-link" disabled={busy} onClick={() => void send(prompt)}>
                <Icon size={15} />{label}
                {label === "Pending approvals" && pendingCount > 0 && <span className="pzn-badge is-warn" style={{ marginLeft: "auto" }}>{pendingCount}</span>}
              </button>
            ))}
          </nav>
        </section>
        <div className="rail-footer">
          <a className="rail-account" href={adminPaths.tools}><Settings2 size={16} />Administration</a>
        </div>
      </aside>

      <main className="workspace rec-ws-main">
        <header className="topbar unified-topbar">
          <div className="topbar-left">
            <button className="icon-button rail-menu" type="button" aria-label="Show navigation" onClick={() => setRailOpen((o) => !o)}><PanelLeft size={19} /></button>
            {railCollapsed && <button className="icon-button rail-expand-desktop" type="button" aria-label="Expand sidebar" onClick={() => setRailCollapsed(false)}><PanelLeft size={18} /></button>}
            <span className="workspace-crumb">Integrations<ChevronRight size={13} /></span>
            <h1>{active?.title ?? "New conversation"}</h1>
          </div>
          <div className="topbar-actions">
            {pendingCount > 0 && (
              <button type="button" className="pzn-btn pzn-btn-sm" onClick={() => void send("Show pending approvals")}>
                <ShieldCheck size={13} /> {pendingCount} pending approval{pendingCount > 1 ? "s" : ""}
              </button>
            )}
            <ThemeToggle compact />
            <span className="model-status" data-connected="true"><span aria-hidden="true" />Live · sfield</span>
          </div>
        </header>

        <div className="rec-ws-scroll pzn-studio">
          {!active || active.messages.length === 0 ? (
            <div className="pzn-chat-welcome">
              <div className="pzn-chat-welcome-badge"><Sparkles size={14} /> Every task runs as a governed sfield tool</div>
              <h2>Build and run integration tasks by chatting.</h2>
              <p>Connect a system, import or describe tasks, review the drafted contract, and publish it, all from here. Reads run right away. Writes are drafted into a form for you to confirm, and calls that need approval are held by sfield until someone approves them.</p>
              <div className="pzn-starter-grid">
                {STARTERS.map(({ Icon, title, subtitle, prompt }) => (
                  <button key={title} type="button" className="pzn-starter-card" disabled={busy} onClick={() => void send(prompt)}>
                    <div className="pzn-starter-head"><Icon size={16} /><strong>{title}</strong></div>
                    <span>{subtitle}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="rec-chat-stream" aria-label="Integrations conversation">
              {active.messages.map((m) => (
                <article key={m.id} className={"rec-turn rec-turn-" + m.role}>
                  {m.role === "user" ? (
                    <div className="rec-wealth-user-row">
                      <div className="rec-assistant-avatar" aria-hidden="true" style={{ fontSize: "0.72rem", fontWeight: 700 }}>YOU</div>
                      <div className="rec-wealth-msg-col">
                        <div className="rec-wealth-meta"><strong>You</strong><span>{m.at}</span></div>
                        <div className="rec-wealth-user-bubble">{m.text}</div>
                      </div>
                    </div>
                  ) : (
                    <div className="rec-wealth-assistant-row">
                      <div className="rec-assistant-avatar" aria-hidden="true"><LabMark /></div>
                      <div className="rec-wealth-msg-col">
                        <div className="rec-wealth-meta"><strong>CEP Assistant</strong><span>{m.at}</span></div>
                        {m.actions && m.actions.length > 0 && (
                          <div className="rec-reasoning-wrap">
                            <button type="button" className="rec-reasoning-pill" onClick={() => setExpanded((p) => ({ ...p, [m.id]: !p[m.id] }))} aria-expanded={Boolean(expanded[m.id])}>
                              <Sparkles size={13} /><strong>Reasoning</strong>
                              <span className="rec-reasoning-tag">{m.generatedBy === "copilot_llm" ? "Copilot ACP" : "Task engine"}</span>
                              <span className="rec-reasoning-count">{m.actions.length} step{m.actions.length === 1 ? "" : "s"}</span>
                              <ChevronDown size={13} />
                            </button>
                            {expanded[m.id] && (
                              <ul className="rec-reasoning-list">
                                {m.actions.map((a, i) => (
                                  <li key={i} className={a.status === "ok" ? "is-ok" : a.status === "pending" ? "is-pending" : "is-err"}>
                                    <span className="pzn-code">{a.tool}</span> {a.summary}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                        <div className={"rec-wealth-assistant-card" + (m.error ? " is-error" : "")}>
                          <p className="pzn-assistant-text">{rich(m.text)}</p>
                        </div>
                        {m.cards && m.cards.length > 0 && <div className="pzn-chat-cards">{m.cards.map((c, i) => renderCard(c, active.id, i))}</div>}
                      </div>
                    </div>
                  )}
                </article>
              ))}
              {busy && (
                <div className="rec-wealth-assistant-row">
                  <div className="rec-assistant-avatar" aria-hidden="true"><LabMark /></div>
                  <div className="rec-wealth-msg-col">
                    <div className="rec-wealth-assistant-card"><span className="pzn-subtitle">Working on it…</span></div>
                  </div>
                </div>
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>

        <footer className="rec-composer-dock">
          <div className="rec-recommended-actions" aria-label="Suggested">
            {chips.map((c) => (
              <button key={c} type="button" className="rec-action-chip" disabled={busy} onClick={() => void send(c)}><Sparkles size={13} /> {c.length > 52 ? c.slice(0, 52) + "…" : c}</button>
            ))}
          </div>
          <form className="rec-composer-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <textarea
              id="integrations-composer"
              rows={1}
              value={input}
              disabled={busy}
              placeholder="e.g. Open a P2 ticket for login errors on auth, or paste JSON to generate a schema…"
              aria-label="Ask the integrations assistant"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
            />
            <button type="submit" className="rec-send-button" disabled={busy || !input.trim()}>Send <ArrowUp size={14} /></button>
          </form>
          <div className="rec-composer-meta">
            <span>Writes always need your confirmation · approvals enforced by sfield</span>
            <span>Enter to send · Shift+Enter for a new line</span>
          </div>
        </footer>
      </main>
    </div>
  );
}
