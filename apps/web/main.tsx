import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useAui, useAuiState, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { CreateSurfaceMessageSchema, type ActionMessage } from "@a2ui/web_core/v1_0";
import { BookOpenText, Columns2, ListChecks, Menu, MessageSquare, PanelRight, Plus, RotateCcw, Square, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { failureCopy, progressLabels, type Bootstrap, type Conversation, type ConversationView, type TurnView, type TurnAccepted, type Progress } from "../../packages/contracts/api";
import { MAX_MESSAGE_LENGTH } from "../../packages/contracts/domain";
import { api } from "./api";
import { Inspector } from "./inspector";
import { BasicSmoke, ExperienceControls, ExperienceDataUI, installA2uiStyles } from "./surface";
import "@fontsource-variable/inter/wght.css";
import "./styles.css";

const starters = [
  { Icon: BookOpenText, label: "Explain a concept", message: "Explain the demo balance labels." },
  { Icon: Columns2, label: "Compare two terms", message: "Compare available and current balance." },
  { Icon: ListChecks, label: "Guide me through a task", message: "Walk me through the demo transfer steps." },
];
type ConversationOperations = {
  latest?: TurnView;
  pending: boolean;
  retry: (id: string) => void;
  anchorTurn: (id: string, message: HTMLElement) => void;
  feedback: (turnId: string, experienceId: string, value: "helpful" | "unhelpful") => void;
};
const ConversationControls = createContext<ConversationOperations>({ pending: false, retry: () => undefined, feedback: () => undefined, anchorTurn: () => undefined });
function LabMark({ small = false }: { small?: boolean }) {
  return <span aria-hidden="true" className={"lab-mark" + (small ? " small" : "")}><i /><i /><i /><i /></span>;
}

function Welcome({ testMode, configured, disabled }: { testMode: boolean; configured: boolean; disabled: boolean }) {
  const aui = useAui();
  return <section className="welcome">
    <div className="welcome-mark"><LabMark /></div>
    <h2>What would you like to explore?</h2>
    <p className="welcome-subtitle">Ask about demo balances, portfolio terms, or the transfer preview.</p>
    <div className="starters">
      {starters.map(({ Icon, label, message }) => (
        <button key={label} type="button" className="starter" disabled={disabled} onClick={() => aui.thread().append(message)}>
          <span className="starter-icon"><Icon size={20} aria-hidden="true" /></span>
          <strong>{label}</strong><span>{message}</span>
        </button>
      ))}
    </div>
    {!testMode && !configured && <p className="gateway-status" role="status">Model gateway setup is required to generate responses.</p>}
  </section>;
}

function UserMessage() {
  return <MessagePrimitive.Root className="user-message"><div className="user-bubble"><MessagePrimitive.Parts /></div></MessagePrimitive.Root>;
}
function AssistantMessage() {
  const turn = useAuiState((state) => state.message.metadata.custom?.turn as TurnView | undefined);
  const { latest, pending, retry, feedback, anchorTurn } = useContext(ConversationControls);
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (element.current && turn && latest?.id === turn.id) anchorTurn(turn.id, element.current);
  }, [anchorTurn, latest?.id, turn?.id]);
  if (!turn) return null;
  const experience = turn.experience;
  return <MessagePrimitive.Root ref={element} className="assistant-message">
    <LabMark small />
    <div className="assistant-content">
      {turn.status === "working"
        ? <div role="status" aria-live="polite" className="working-status"><span className="working-indicator" />{progressLabels[turn.progress]}…</div>
        : <MessagePrimitive.Parts />}
      {turn.status === "completed" && latest?.id === turn.id && <span className="sr-only" role="status">Response ready.</span>}
      {(turn.status === "failed" || turn.status === "cancelled") && latest?.id === turn.id && (
        <button type="button" disabled={pending} className="secondary-button retry" onClick={() => retry(turn.id)}><RotateCcw size={15} />Retry</button>
      )}
      {experience?.status === "ready" && <div className="feedback-controls" aria-label="Response feedback">
        <span>Was this helpful?</span>
        <button className="icon-button" type="button" aria-label="Helpful" aria-pressed={turn.feedback === "helpful"}
          onClick={() => feedback(turn.id, experience.experienceId, "helpful")}><ThumbsUp size={16} /></button>
        <button className="icon-button" type="button" aria-label="Unhelpful" aria-pressed={turn.feedback === "unhelpful"}
          onClick={() => feedback(turn.id, experience.experienceId, "unhelpful")}><ThumbsDown size={16} /></button>
      </div>}
    </div>
  </MessagePrimitive.Root>;
}

function Composer({ draft, onDraft, running, pending, disabled, notice, input }: {
  draft: string; onDraft: (value: string) => void; running: boolean; pending: boolean; disabled: boolean; notice: string;
  input: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const aui = useAui();
  const send = () => {
    if (!running && !pending && !disabled && draft.trim()) aui.thread().append(draft.trim());
  };
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }
  return <div className="composer-area">
    <div className="composer-inner">
      {notice && <div className="request-notice" role="status">{notice}</div>}
      {pending && !running && !notice && <div className="submit-status" role="status">Sending your request…</div>}
      <form className="composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
        <div className="composer-field">
          <label htmlFor="composer-input">Your question</label>
          <textarea id="composer-input" ref={input} rows={1} value={draft} maxLength={MAX_MESSAGE_LENGTH}
            placeholder="Type your question…" onChange={(event) => onDraft(event.target.value)} onKeyDown={onKeyDown} />
        </div>
        {running ? <button className="send-button stop-button" type="button" disabled={pending} onClick={() => aui.thread().cancelRun()}>
          <Square size={13} aria-hidden="true" />Stop
        </button> : <button className="send-button" type="submit" disabled={disabled || pending || !draft.trim()}>Send</button>}
      </form>
      <p className="composer-hint">Enter to send <span aria-hidden="true">·</span> Shift+Enter for a new line</p>
    </div>
  </div>;
}

function visibleMessages(turns: TurnView[]): ThreadMessageLike[] {
  return turns.flatMap((turn): ThreadMessageLike[] => {
    const { id, experience, status, failureCode } = turn;
    return [
      { id: id + "_user", role: "user", content: turn.message, createdAt: new Date(turn.createdAt) },
      {
        id: experience?.messageId ?? id + "_assistant",
        role: "assistant", createdAt: new Date(turn.createdAt),
        content: experience ? [{ type: "data", name: "experience-surface", data: experience }]
          : status === "failed" ? failureCopy[failureCode ?? "internal_error"]
          : status === "cancelled" ? "Response stopped." : "",
        status: status === "working" ? { type: "running" } : { type: "complete", reason: "stop" },
        metadata: { custom: { turn } },
      },
    ];
  });
}

type ChatProps = {
  conversation?: ConversationView; configuration?: Bootstrap; pending: boolean; notice: string;
  draft: string; onDraft: (value: string) => void; onSend: (text: string) => Promise<void>; onStop: () => Promise<void>;
  onRetry: (id: string) => void;
  onFollowUp: (id: string, envelope: ActionMessage) => void;
  onFeedback: ConversationOperations["feedback"];
};
const noTurns: TurnView[] = [];
function Chat({ conversation, configuration, pending, draft, onDraft, onSend, onStop, onRetry, onFollowUp, onFeedback, notice }: ChatProps) {
  const turns = conversation?.turns ?? noTurns;
  const latest = turns.at(-1);
  const running = latest?.status === "working";
  const messages = useMemo(() => visibleMessages(turns), [turns]);
  const runtime = useExternalStoreRuntime({
    messages, convertMessage: (message) => message, isRunning: running, activeRunId: running ? latest?.id : undefined,
    onNew: async (message) => {
      const text = message.content.find((part) => part.type === "text")?.text?.trim();
      if (text) await onSend(text);
    },
    onCancel: onStop,
  });
  const input = useRef<HTMLTextAreaElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const lastAnchor = useRef<string | undefined>(undefined);
  const anchorTurn = useCallback((id: string, message: HTMLElement) => {
    const scroll = viewport.current;
    if (!scroll || lastAnchor.current === id) return;
    lastAnchor.current = id;
    const user = message.previousElementSibling ?? message;
    const top = user.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
    scroll.scrollTop = Math.max(0, top - 18);
  }, []);
  const rendered = useCallback((experienceId: string, fallback?: boolean) => {
    void api.event(experienceId, fallback ? "render_fallback" : "rendered").catch(() => undefined);
  }, []);
  const activeExperienceId = pending || running ? undefined : latest?.experience?.experienceId;

  return <AssistantRuntimeProvider runtime={runtime}>
    <ExperienceControls.Provider value={{ activeExperienceId, followUp: onFollowUp, rendered }}>
      <ConversationControls.Provider value={{ latest, pending, retry: onRetry, feedback: onFeedback, anchorTurn }}>
        <ExperienceDataUI />
        <ThreadPrimitive.Root className="thread">
          <ThreadPrimitive.Viewport className="thread-scroll" ref={viewport}
            autoScroll={false} scrollToBottomOnInitialize={false} scrollToBottomOnRunStart={false} scrollToBottomOnThreadSwitch={false}
            aria-label="Conversation">
            {turns.length ? <div className="messages">
              <ThreadPrimitive.Messages>{({ message }) => message.role === "user" ? <UserMessage /> : <AssistantMessage />}</ThreadPrimitive.Messages>
            </div> : <Welcome testMode={configuration?.mode === "test"} configured={configuration?.gatewayConfigured ?? true} disabled={!configuration || pending} />}
          </ThreadPrimitive.Viewport>
          <Composer draft={draft} onDraft={onDraft} running={running} pending={pending} disabled={!configuration} input={input} notice={notice} />
        </ThreadPrimitive.Root>
      </ConversationControls.Provider>
    </ExperienceControls.Provider>
  </AssistantRuntimeProvider>;
}

function localRead() {
  try { return localStorage.getItem("pzn-active-conversation"); } catch { return null; }
}
function localWrite(id: string) {
  try { localStorage.setItem("pzn-active-conversation", id); } catch { /* Storage may be restricted. */ }
}
function messageFor(error: unknown) {
  return error instanceof Error && error.name !== "TypeError" ? error.message : "Couldn’t reach the demo. Your draft is still here.";
}

function App() {
  const [configuration, setConfiguration] = useState<Bootstrap>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversation, setConversation] = useState<ConversationView>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [inspector, setInspector] = useState(false);
  const inFlight = useRef(false);
  const previousAttempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const inspectorTrigger = useRef<HTMLButtonElement>(null);
  const railTrigger = useRef<HTMLButtonElement>(null);
  const railClose = useRef<HTMLButtonElement>(null);
  const draftKey = conversation?.id ?? "new";
  const latest = conversation?.turns.at(-1);
  const activeTurnId = latest?.status === "working" ? latest.id : undefined;
  const remember = (row: Conversation) => setConversations((list) => (
    [row, ...list.filter((item) => item.id !== row.id)].sort((a, b) => b.updatedAt - a.updatedAt)
  ));
  const choose = (row: ConversationView) => {
    setConversation(row);
    remember(row);
    localWrite(row.id);
    setRailOpen(false);
  };

  useEffect(() => {
    let mounted = true;
    void api.bootstrap().then(async (data) => {
      if (!mounted) return;
      setConversations(data.conversations);
      const preferred = data.conversations.find((row) => row.id === localRead()) ?? data.conversations[0];
      if (preferred) {
        const restored = await api.conversation(preferred.id);
        if (mounted) choose(restored);
      }
      if (mounted) setConfiguration(data);
    }).catch((error: unknown) => { if (mounted) setNotice(messageFor(error)); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!railOpen) return;
    const trigger = railTrigger.current;
    railClose.current?.focus();
    const handle = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setRailOpen(false); };
    const layout = window.matchMedia("(max-width: 850px)");
    const onLayout = () => { if (!layout.matches) setRailOpen(false); };
    window.addEventListener("keydown", handle);
    layout.addEventListener("change", onLayout);
    return () => {
      window.removeEventListener("keydown", handle);
      layout.removeEventListener("change", onLayout);
      if (layout.matches) trigger?.focus();
    };
  }, [railOpen]);

  const upsert = useCallback((turn: TurnView) => {
    setConversation((previous) => {
      if (!previous || previous.id !== turn.conversationId) return previous;
      const existing = previous.turns.find((item) => item.id === turn.id);
      if (existing) {
        if (existing.status !== "working" && turn.status === "working") return previous;
        return { ...previous, turns: previous.turns.map((item) => item.id === turn.id ? turn : item) };
      }
      return { ...previous, turns: [...previous.turns, turn] };
    });
  }, []);

  useEffect(() => {
    if (!activeTurnId) return;
    const id = activeTurnId;
    let alive = true;
    let seen = 0;
    const stream = new EventSource("/api/turns/" + id + "/events");
    const refresh = () => void api.turn(id).then((snapshot) => {
      if (!alive) return;
      upsert(snapshot);
      if (snapshot.status !== "working") stream.close();
    }).catch(() => { /* EventSource reconnects with the last event ID. */ });
    stream.addEventListener("turn.status", (event) => {
      const sequence = Number(event.lastEventId);
      if (sequence <= seen) return;
      seen = sequence;
      const { progress } = JSON.parse(event.data).payload as { progress: Progress };
      if (!Object.hasOwn(progressLabels, progress)) return;
      setConversation((previous) => previous ? {
        ...previous, turns: previous.turns.map((turn) => turn.id === id && turn.status === "working" ? { ...turn, progress } : turn),
      } : previous);
    });
    for (const type of ["experience.ready", "turn.failed", "turn.cancelled", "gap", "error"]) stream.addEventListener(type, refresh);
    const recoveryPoll = setInterval(refresh, 4000);
    return () => { alive = false; stream.close(); clearInterval(recoveryPoll); };
  }, [activeTurnId, upsert]);

  const exclusive = async (task: () => Promise<void>) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setPending(true);
    setNotice("");
    try { await task(); return true; } catch (error) {
      setNotice(messageFor(error));
      return false;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const requestId = (fingerprint: string) => {
    if (previousAttempt.current?.fingerprint === fingerprint) return previousAttempt.current.id;
    const id = crypto.randomUUID();
    previousAttempt.current = { fingerprint, id };
    return id;
  };
  const accept = ({ turn }: TurnAccepted, target: ConversationView) => {
    previousAttempt.current = null;
    upsert(turn);
    remember({
      id: target.id, title: target.turns.length ? target.title : [...turn.message.replace(/\s+/g, " ")].slice(0, 54).join(""),
      personaId: target.personaId, scenarioId: target.scenarioId, updatedAt: turn.createdAt,
    });
    if (!target.turns.length) setConversation((row) => row?.id === target.id ? {
      ...row, title: [...turn.message.replace(/\s+/g, " ")].slice(0, 54).join(""), updatedAt: turn.createdAt,
    } : row);
  };

  const send = async (message: string) => {
    if (!configuration) return;
    await exclusive(async () => {
      const target = conversation ?? await api.newConversation(configuration.defaultPersonaId, configuration.defaultScenarioId);
      if (!conversation) choose(target);
      try {
        accept(await api.send(target.id, message, requestId(target.id + ":" + message)), target);
        setDrafts((all) => ({ ...all, [draftKey]: all[draftKey]?.trim() === message ? "" : all[draftKey] }));
      } catch (error) {
        if (!conversation) setDrafts((all) => ({ ...all, [target.id]: all[draftKey] ?? message }));
        throw error;
      }
    });
  };
  const startConversation = async (personaId: string, scenarioId: string) => exclusive(async () => {
    choose(await api.newConversation(personaId, scenarioId));
  });
  const closeInspector = () => {
    setInspector(false);
    inspectorTrigger.current?.focus();
  };

  return <div className="app-layout">
    {railOpen && <button className="rail-scrim" aria-label="Close conversations" onClick={() => setRailOpen(false)} />}
    <aside className={"rail" + (railOpen ? " rail-open" : "")} id="conversation-rail" aria-label="Conversation navigation">
      <div className="brand"><LabMark /><span><strong>PZN Lab</strong><small>Intent to experience</small></span>
        <button className="icon-button rail-close" ref={railClose} aria-label="Close conversation navigation" onClick={() => setRailOpen(false)}><X size={20} /></button>
      </div>
      <button className="new-conversation" disabled={pending || !configuration} onClick={() => {
        if (configuration) void startConversation(conversation?.personaId ?? configuration.defaultPersonaId, conversation?.scenarioId ?? configuration.defaultScenarioId);
      }}><Plus size={18} aria-hidden="true" />New conversation</button>
      <div className="rail-section">
        <h2>Conversations</h2>
        <nav aria-label="Recent conversations">
          {conversations.length ? conversations.map((row) => (
            <button className="conversation-link" key={row.id} aria-current={conversation?.id === row.id ? "page" : undefined} disabled={pending}
              title={row.title} onClick={() => void exclusive(async () => choose(await api.conversation(row.id)))}>
              <MessageSquare size={16} aria-hidden="true" /><span>{row.title}</span>
            </button>
          )) : <p>New conversations appear here.</p>}
        </nav>
      </div>
      <div className="rail-footer"><span className="demo-dot" />Fictional demo workspace</div>
    </aside>
    <main className="workspace" inert={railOpen}>
      <header className="topbar">
        <div className="topbar-left">
          <button className="icon-button rail-menu" ref={railTrigger} type="button" aria-label="Show conversations" aria-expanded={railOpen}
            aria-controls="conversation-rail" onClick={() => setRailOpen((open) => !open)}><Menu size={21} /></button>
          <h1>Your assistant</h1>
        </div>
        <div className="topbar-actions">
          {configuration?.mode === "test" && <span className="test-label" title="Deterministic automated test gateway">Test mode</span>}
          <span className="demo-badge"><span className="demo-dot" />Demo data</span>
          {configuration?.inspectorEnabled && <button className="inspector-trigger icon-button" ref={inspectorTrigger} type="button" aria-label="Open developer inspector"
            onClick={() => setInspector(true)}><PanelRight size={18} /><span>Inspector</span></button>}
        </div>
      </header>
      <Chat key={conversation?.id ?? "new"} conversation={conversation} configuration={configuration} pending={pending}
        draft={drafts[draftKey] ?? ""} onDraft={(value) => setDrafts((all) => ({ ...all, [draftKey]: value }))} notice={notice}
        onSend={send} onStop={async () => {
          if (activeTurnId) await exclusive(async () => upsert(await api.cancel(activeTurnId)));
        }}
        onRetry={(id) => {
          if (conversation) void exclusive(async () => accept(await api.retry(id, requestId("retry:" + id)), conversation));
        }}
        onFollowUp={(id, envelope) => {
          if (conversation) void exclusive(async () => accept(await api.followUp(id, envelope, requestId("action:" + String(envelope.action.context.actionId))), conversation));
        }}
        onFeedback={(turnId, expId, value) => {
          void api.event(expId, value).then(() => api.turn(turnId)).then(upsert).catch((error) => setNotice(messageFor(error)));
        }} />
    </main>
    {configuration && inspector && <Inspector configuration={configuration} conversation={conversation} latest={latest} close={closeInspector} create={startConversation} />}
  </div>;
}

installA2uiStyles();
const root = createRoot(document.getElementById("root")!);
if (location.pathname === "/__test/a2ui") {
  void api.bootstrap().then(async (data) => {
    if (data.mode !== "test") { root.render(<App />); return; }
    const { default: message } = await import("../../fixtures/a2ui-v1-basic-smoke.json");
    root.render(<BasicSmoke input={CreateSurfaceMessageSchema.parse(message)} />);
  });
} else {
  root.render(<App />);
}
