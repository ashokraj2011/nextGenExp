import { useEffect, useState } from "react";
import {
  Brain, Check, CheckCircle2, ChevronLeft, ChevronRight, Copy, Download, Ellipsis, GitBranch, Headphones, Lock, PanelRightOpen,
  Pin, Plus, Search, Send, Sparkles, Table2, Trash2, UserCheck, X,
} from "lucide-react";
import type { TurnView } from "../../packages/contracts/api";
import type { HandoffTicket } from "../../packages/contracts/handoff";
import type { KnowledgeCitation } from "../../packages/contracts/knowledge-base";
import type { DisplayExperience } from "../../packages/contracts/surface";
import { api, toolSetupErrorMessage } from "./api";
import { ExperienceCanvasView } from "./surface";
import "./chat-rich-ux.css";
import "./immersive-ux.css";

/* ============================================================================
 * 1. Slash-Command Palette
 * ========================================================================== */

export type SlashCommand = {
  command: string;
  label: string;
  hint: string;
  action: "prompt" | "advisor" | "memory" | "upload" | "futures" | "watch" | "delegate" | string;
  prompt?: string;
  domain?: string;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { command: "/portfolio", label: "Portfolio summary", hint: "Show balances & allocation mix", action: "prompt", prompt: "Let me know my portfolio summary." },
  { command: "/goal", label: "Home-buying goal", hint: "Track savings progress & target", action: "prompt", prompt: "Show my home-buying goal and savings progress." },
  { command: "/plan", label: "2-year savings plan", hint: "Interactive contribution simulator", action: "prompt", prompt: "I want to buy a house in two years. Show me how close I am and help me explore a savings plan." },
  { command: "/retirement", label: "Retirement accounts", hint: "Review accounts & beneficiary status", action: "prompt", prompt: "Show my retirement accounts." },
  { command: "/compare", label: "Compare balances", hint: "Available vs. current balance side by side", action: "prompt", prompt: "Compare available and current balance." },
  { command: "/futures", label: "Parallel Futures simulator", hint: "Compare Scenario A vs B side-by-side & commit", action: "futures" },
  { command: "/watch", label: "Create Living Watchcard", hint: "Autonomous sentinel that wakes up when reality changes", action: "watch" },
  { command: "/delegate", label: "Personal AI (A2A) Delegation", hint: "Mint a scoped pass for your personal AI to negotiate", action: "delegate" },
  { command: "/advisor", label: "Talk to a live advisor", hint: "Multiplayer Live Glass handoff with AI brief", action: "advisor" },
  { command: "/memory", label: "Manage personal memory", hint: "View, save, or forget your preferences", action: "memory" },
  { command: "/upload", label: "Attach document", hint: "Upload invoice, CSV, log, or image", action: "upload" },
];

export function matchSlashCommands(draft: string, commands: readonly SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  const trimmed = draft.trimStart();
  if (!trimmed.startsWith("/") || trimmed.includes(" ")) return [];
  const q = trimmed.toLowerCase();
  return commands.filter((c) => c.command.startsWith(q) || c.label.toLowerCase().includes(q.slice(1)));
}

export function SlashCommandMenu({ commands, activeIndex, onPick }: {
  commands: SlashCommand[];
  activeIndex: number;
  onPick: (cmd: SlashCommand) => void;
}) {
  if (!commands.length) return null;
  return (
    <div className="slash-menu" role="listbox" aria-label="Quick slash commands">
      <div className="slash-menu-head">
        <span>Tenant commands ({commands.length})</span>
        <span className="slash-menu-kbd">
          <kbd>↑↓</kbd> <kbd>↵</kbd> select · <kbd>Esc</kbd>
        </span>
      </div>
      {commands.map((cmd, idx) => (
        <button
          key={cmd.command}
          type="button"
          role="option"
          aria-selected={idx === activeIndex}
          className={"slash-menu-item" + (idx === activeIndex ? " is-active" : "")}
          onMouseDown={(e) => { e.preventDefault(); onPick(cmd); }}
        >
          <code>{cmd.command}</code>
          <span className="slash-menu-label">
            {cmd.label}
            {cmd.domain && <span className="slash-menu-domain">{cmd.domain}</span>}
          </span>
          <small className="slash-menu-hint">{cmd.hint}</small>
        </button>
      ))}
    </div>
  );
}

/* ============================================================================
 * 2. Personal Memory Drawer (sfield MemoryService — /api/memory)
 * ========================================================================== */

export type MemoryEntry = {
  id: string;
  kind: "preference" | "fact" | "summary";
  content: string;
  createdAt: string;
  structured?: { key: string; value: unknown };
};

export function MemoryDrawer({ open, items, loading, error, onClose, onSave, onForget }: {
  open: boolean;
  items: MemoryEntry[];
  loading: boolean;
  error: string;
  onClose: () => void;
  onSave: (kind: "preference" | "fact", content: string) => Promise<void>;
  onForget: (id: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<"preference" | "fact">("preference");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim() || busy) return;
    setBusy(true);
    setLocalError("");
    try {
      await onSave(kind, content.trim());
      setContent("");
    } catch (err) {
      setLocalError(toolSetupErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rich-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="memory-drawer-title">
      <div className="rich-drawer">
        <header className="rich-drawer-head">
          <div>
            <span className="rich-kicker"><Brain size={13} aria-hidden="true" /> PERSONAL MEMORY (sfield)</span>
            <h2 id="memory-drawer-title">What your assistant remembers</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Close memory drawer" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <p className="rich-drawer-sub">
          Scoped to your session and enforced by <code>sfield</code> MemoryService — secrets (keys/passwords) are blocked automatically and you can forget any item with a deletion receipt.
        </p>

        <form className="memory-add-form" onSubmit={(e) => void submit(e)}>
          <select aria-label="Memory type" value={kind} onChange={(e) => setKind(e.target.value as "preference" | "fact")}>
            <option value="preference">Preference</option>
            <option value="fact">Fact</option>
          </select>
          <input
            aria-label="New preference or fact"
            placeholder="e.g. Prefer concise tax-aware summaries"
            value={content}
            maxLength={300}
            onChange={(e) => setContent(e.target.value)}
          />
          <button type="submit" className="rich-btn-primary" disabled={busy || content.trim().length < 2}>
            <Plus size={14} aria-hidden="true" />Save
          </button>
        </form>

        {(localError || error) && <p className="rich-error" role="alert">{localError || error}</p>}

        <div className="memory-list">
          {loading && <p className="rich-muted">Loading saved memory…</p>}
          {!loading && items.length === 0 && (
            <p className="rich-muted">Nothing saved yet. Add a communication preference or goal fact above.</p>
          )}
          {items.map((item) => (
            <div key={item.id} className="memory-item">
              <div className="memory-item-copy">
                <span className={"memory-pill is-" + item.kind}>{item.kind}</span>
                <span>{item.content}</span>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label={`Forget ${item.content}`}
                title="Forget this memory"
                onClick={() => void onForget(item.id)}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * 3. Live Human Agent Warm Handoff Card (/api/handoffs)
 * ========================================================================== */

const HANDOFF_PHRASE_RE = /\b(talk to (a |an )?(human|person|advisor|agent|representative|someone)|speak (to|with) (a |an )?(human|person|advisor|agent|representative)|live (agent|advisor|support|human)|escalate (to|this to) (a |an )?(human|advisor|agent)|transfer (me )?to (a |an )?(human|advisor|agent))\b/i;

export function isHandoffPhrase(text: string): boolean {
  return HANDOFF_PHRASE_RE.test(text);
}

export function LiveHandoffCard({ ticket: initialTicket, onDismiss }: {
  ticket: HandoffTicket;
  onDismiss: () => void;
}) {
  const [ticket, setTicket] = useState<HandoffTicket>(initialTicket);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => { setTicket(initialTicket); }, [initialTicket]);

  // Subscribe to real-time SSE updates (instant live co-browse sliders, advisor proposals, and specialist replies).
  useEffect(() => {
    if (ticket.status === "resolved") return;
    let alive = true;
    const stream = new EventSource(`/api/handoffs/${encodeURIComponent(ticket.handoffId)}/stream`);
    stream.addEventListener("handoff.update", (evt) => {
      if (!alive) return;
      try {
        setTicket(JSON.parse((evt as MessageEvent).data) as HandoffTicket);
      } catch { /* ignore */ }
    });
    return () => { alive = false; stream.close(); };
  }, [ticket.handoffId, ticket.status]);

  async function sendReply(e: React.FormEvent) {
    e.preventDefault();
    const text = reply.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const res = await api.handoffCustomerReply(ticket.handoffId, text);
      setTicket(res.ticket);
      setReply("");
    } finally {
      setSending(false);
    }
  }

  const sharedExp = ticket.coBrowse?.sharedCard?.experience as DisplayExperience | undefined;

  return (
    <section className={"live-handoff-card is-" + ticket.status} aria-label="Live human advisor handoff">
      <div className="live-handoff-head">
        <div className="live-handoff-title">
          <Headphones size={16} aria-hidden="true" />
          <div>
            <strong>
              {ticket.status === "queued" && "Connecting you to a live advisor…"}
              {ticket.status === "claimed" && `Live session with ${ticket.assignedAgent ?? "Your Advisor"}`}
              {ticket.status === "resolved" && "Advisor session ended"}
            </strong>
            <small>{sharedExp ? "You and your advisor are viewing the exact same card" : `Room ${ticket.handoffId}`}</small>
          </div>
        </div>
        <div className="live-handoff-badges">
          <span className={"handoff-status-pill is-" + ticket.status}>
            {ticket.status === "claimed" ? <UserCheck size={12} /> : ticket.status === "resolved" ? <CheckCircle2 size={12} /> : <Sparkles size={12} />}
            {ticket.status === "claimed" ? "live" : ticket.status}
          </span>
          <button type="button" className="icon-button" aria-label="Dismiss handoff card" onClick={onDismiss}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      {sharedExp && (
        <div className="shared-live-card-box" role="region" aria-label="Shared Live A2UI Card">
          <div className="shared-live-card-head">
            <span className="cobrowse-live-pill">
              <Sparkles size={11} aria-hidden="true" />
              SHARED LIVE CARD · {ticket.assignedAgent ?? ticket.coBrowse?.sharedCard?.sharedByName} &amp; {ticket.customerName}
            </span>
            <small>&ldquo;{ticket.coBrowse?.sharedCard?.prompt.slice(0, 72)}&rdquo;</small>
          </div>
          <ExperienceCanvasView data={sharedExp} />
        </div>
      )}

      {ticket.notes.filter((n) => n.role !== "system").length > 0 && (
        <div className="live-handoff-messages">
          {ticket.notes.filter((n) => n.role !== "system").slice(-4).map((n) => (
            <div key={n.id} className={"handoff-msg is-" + n.role}>
              <strong>{n.author}:</strong>
              <span>{n.text}</span>
            </div>
          ))}
        </div>
      )}

      {ticket.status !== "resolved" && (
        <form className="live-handoff-reply" onSubmit={(e) => void sendReply(e)}>
          <input
            aria-label="Message live advisor"
            placeholder="Message your advisor…"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
          />
          <button type="submit" className="rich-btn-primary" disabled={sending || !reply.trim()}>
            <Send size={13} aria-hidden="true" />Send
          </button>
        </form>
      )}
    </section>
  );
}

/* ============================================================================
 * 4. Policy citations
 * ========================================================================== */

function PolicyCitations({ userMessage }: { userMessage: string }) {
  const [ragOpen, setRagOpen] = useState(false);
  const [ragLoading, setRagLoading] = useState(false);
  const [ragHits, setRagHits] = useState<KnowledgeCitation[] | null>(null);

  async function togglePolicyCheck() {
    if (ragOpen) { setRagOpen(false); return; }
    setRagOpen(true);
    if (ragHits !== null) return;
    setRagLoading(true);
    try {
      const res = await api.publicKnowledgeSearch(userMessage.slice(0, 240));
      setRagHits(res.citations);
    } catch {
      setRagHits([]);
    } finally {
      setRagLoading(false);
    }
  }

  return (
    <div className="policy-citations">
      <button
        type="button"
        className={"rich-action-chip" + (ragOpen ? " is-active" : "")}
        aria-expanded={ragOpen}
        onClick={() => void togglePolicyCheck()}
      >
        <Search size={11} aria-hidden="true" />
        Policy citations
      </button>

      {ragOpen && (
        <div className="citation-popover" role="region" aria-label="Related policy references">
          <div className="citation-popover-head">
            <strong>Related policy references</strong>
            <button type="button" className="icon-button" aria-label="Close policy citations" onClick={() => setRagOpen(false)}>
              <X size={13} aria-hidden="true" />
            </button>
          </div>
          {ragLoading && <p className="rich-muted">Searching verified policy knowledge base…</p>}
          {!ragLoading && ragHits && ragHits.length === 0 && <p className="rich-muted">No related policy references found.</p>}
          {!ragLoading && ragHits && ragHits.length > 0 && (
            <ul className="rag-hit-list">
              {ragHits.map((hit) => (
                <li key={`${hit.docId}-${hit.chunkIndex}`}>
                  <div className="rag-hit-top">
                    <strong>{hit.docTitle}</strong>
                    <span>Version {hit.version}</span>
                  </div>
                  <p>{hit.excerpt}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * 5. Turn Rich Actions (Open in Canvas, Copy/Export Brief, Quick Re-frame)
 * ========================================================================== */

function buildTurnBriefMarkdown(turn: TurnView): string {
  const lines = [
    `# Advisory brief`,
    `Date: ${new Date(turn.createdAt).toLocaleString()}`,
    ``,
    `## Question`,
    turn.message,
    ``,
    `## Response`,
    turn.experience?.intro ?? "",
  ];
  if (turn.experience?.question) lines.push("", turn.experience.question);
  for (const b of turn.experience?.blocks ?? []) {
    const props = b.props as { title?: string; body?: string; description?: string };
    if (props.title) lines.push("", `### ${props.title}`);
    if (props.description) lines.push(props.description);
    if (props.body) lines.push(props.body);
  }
  return lines.filter((l, i, arr) => l !== "" || arr[i - 1] !== "").join("\n");
}

export function TurnRichActions({ turn, pending, pinnedInCanvas, onPinCanvas, onReframe, onBranch, children }: {
  turn: TurnView;
  pending: boolean;
  pinnedInCanvas: boolean;
  onPinCanvas: (turn: TurnView) => void;
  onReframe: (prompt: string) => void;
  onBranch?: (turn: TurnView) => void;
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const hasBlocks = (turn.experience?.blocks.length ?? 0) > 0;

  function copyBrief() {
    void navigator.clipboard?.writeText(buildTurnBriefMarkdown(turn));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  function downloadBrief() {
    const blob = new Blob([buildTurnBriefMarkdown(turn)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cep-brief-${turn.id.slice(0, 8)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <details className="response-more">
      <summary aria-label="More response options"><Ellipsis size={16} aria-hidden="true" />More</summary>
      <div className="turn-rich-actions" aria-label="Response tools">
        {hasBlocks && (
          <button
            type="button"
            className={"rich-action-chip" + (pinnedInCanvas ? " is-active" : "")}
            onClick={() => onPinCanvas(turn)}
          >
            <PanelRightOpen size={12} aria-hidden="true" />
            {pinnedInCanvas ? "In Canvas" : "Open in Canvas"}
          </button>
        )}
        <button type="button" className="rich-action-chip" onClick={copyBrief}>
          {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
          {copied ? "Copied" : "Copy brief"}
        </button>
        <button type="button" className="rich-action-chip" onClick={downloadBrief}>
          <Download size={12} aria-hidden="true" />Export
        </button>
        <button
          type="button"
          className="rich-action-chip is-subtle"
          disabled={pending}
          onClick={() => onReframe(`Summarize your last answer about "${turn.message.slice(0, 80)}" in 3 bullet points.`)}
        >
          <Sparkles size={11} aria-hidden="true" />Summarize
        </button>
        <button
          type="button"
          className="rich-action-chip is-subtle"
          disabled={pending}
          onClick={() => onReframe(`Show your last answer about "${turn.message.slice(0, 80)}" as a clear comparison table.`)}
        >
          <Table2 size={11} aria-hidden="true" />As table
        </button>
        {onBranch && (
          <button
            type="button"
            className="rich-action-chip is-subtle"
            disabled={pending}
            title="Branch a new conversation from this message"
            onClick={() => onBranch(turn)}
          >
            <GitBranch size={11} aria-hidden="true" />Branch
          </button>
        )}
      </div>
      <PolicyCitations userMessage={turn.message} />
      {children}
    </details>
  );
}

/* ============================================================================
 * 6. Split-Pane Live Canvas Drawer
 * ========================================================================== */

export function LiveCanvasPane({
  turn,
  onClose,
  autoFollow = true,
  onToggleAutoFollow,
  cardIndex = 0,
  totalCards = 1,
  onSelectOffset,
  onRefine,
  onClipToMenu,
  pinnedToMenu = false,
  pending = false,
}: {
  turn: TurnView;
  onClose: () => void;
  autoFollow?: boolean;
  onToggleAutoFollow?: () => void;
  cardIndex?: number;
  totalCards?: number;
  onSelectOffset?: (delta: -1 | 1) => void;
  onRefine?: (prompt: string) => void;
  onClipToMenu?: (turn: TurnView) => void;
  pinnedToMenu?: boolean;
  pending?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [refineText, setRefineText] = useState("");
  if (!turn.experience) return null;

  function submitRefine(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = refineText.trim();
    if (!trimmed || !onRefine || pending) return;
    onRefine(trimmed);
    setRefineText("");
  }

  return (
    <aside className="live-canvas-pane" aria-label="Interactive live canvas">
      <header className="live-canvas-head">
        <div className="live-canvas-title">
          <span className="rich-kicker"><PanelRightOpen size={12} aria-hidden="true" /> LIVING CANVAS</span>
          <strong title={turn.message}>{turn.message.slice(0, 64)}{turn.message.length > 64 ? "…" : ""}</strong>
        </div>
        <div className="live-canvas-controls">
          {onClipToMenu && (
            <button
              type="button"
              className={"rich-action-chip" + (pinnedToMenu ? " is-active" : "")}
              title="Keep this live card permanently in your Main Menu"
              onClick={() => onClipToMenu(turn)}
            >
              {pinnedToMenu ? <Check size={12} /> : <Pin size={12} />}
              {pinnedToMenu ? "Pinned" : "Pin to Menu"}
            </button>
          )}
          <button
            type="button"
            className="rich-action-chip"
            onClick={() => {
              void navigator.clipboard?.writeText(buildTurnBriefMarkdown(turn));
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="icon-button" aria-label="Close live canvas" onClick={onClose}>
            <X size={17} aria-hidden="true" />
          </button>
        </div>
      </header>

      {(onToggleAutoFollow || totalCards > 1) && (
        <div className="living-canvas-bar">
          {onToggleAutoFollow ? (
            <button
              type="button"
              className={"living-sync-btn" + (autoFollow ? " is-live" : "")}
              aria-pressed={autoFollow}
              onClick={onToggleAutoFollow}
              title={autoFollow ? "Canvas automatically updates with each new chat reply" : "Canvas locked to this card — click to re-enable Live Sync"}
            >
              {autoFollow ? <span className="living-sync-dot" aria-hidden="true" /> : <Lock size={11} aria-hidden="true" />}
              {autoFollow ? "Live Sync ON · follows chat" : "Locked to this card"}
            </button>
          ) : <span />}
          {totalCards > 1 && onSelectOffset && (
            <div className="living-canvas-stepper" role="group" aria-label="Switch canvas card">
              <button
                type="button"
                aria-label="Previous card"
                disabled={cardIndex <= 0}
                onClick={() => onSelectOffset(-1)}
              >
                <ChevronLeft size={14} aria-hidden="true" />
              </button>
              <span>{cardIndex + 1} / {totalCards}</span>
              <button
                type="button"
                aria-label="Next card"
                disabled={cardIndex >= totalCards - 1}
                onClick={() => onSelectOffset(1)}
              >
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      )}

      <div className="live-canvas-body">
        <ExperienceCanvasView data={turn.experience} />
      </div>

      {onRefine && (
        <form className="living-canvas-refine" onSubmit={submitRefine}>
          <input
            aria-label="Refine this canvas"
            placeholder="Refine this visual (e.g. 'add $500/mo' or 'as table')…"
            value={refineText}
            disabled={pending}
            onChange={(e) => setRefineText(e.target.value)}
          />
          <button type="submit" disabled={pending || !refineText.trim()}>
            <Sparkles size={13} aria-hidden="true" />
            Refine
          </button>
        </form>
      )}
    </aside>
  );
}
