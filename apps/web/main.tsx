import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useAui, useAuiState, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { CreateSurfaceMessageSchema, type ActionMessage } from "@a2ui/web_core/v1_0";
import { ArrowLeft, ArrowUp, BookOpenText, ChevronDown, ChevronRight, Columns2, GraduationCap, House, LayoutDashboard, ListChecks, LogIn, LogOut, MapPin, MessageSquare, PanelLeft, Plus, RotateCcw, Square, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { failureCopy, progressLabels, type Bootstrap, type Conversation, type ConversationChange, type ConversationView, type DemoPersona, type TurnView, type TurnAccepted, type Progress } from "../../packages/contracts/api";
import { MAX_MESSAGE_LENGTH } from "../../packages/contracts/domain";
import { defaultWorkspacePins, pendingActionsContext, type WorkspacePin } from "../../packages/contracts/workspace";
import { adminPaths } from "../../packages/contracts/admin-paths";
import { api } from "./api";
import { AdminNavigation } from "./admin-navigation";
import { readActiveConversation, readProfileSession, rememberActiveConversation, saveProfileSession } from "./conversation-storage";
import { DemoProfiles, ProfileAvatar } from "./demo-profiles";
import { LabMark } from "./lab-mark";
import { planningTopics } from "./planning-topics";
import { BasicSmoke, ExperienceControls, ExperienceDataUI, installA2uiStyles } from "./surface";
import { usePendingActions, WorkspaceHome, WorkspaceOverview, type PendingActions } from "./workspace-overview";
import { WorkspaceCustomization, WorkspaceMenu, type WorkspaceSection } from "./workspace-menu";
import { ThreadList, ThreadSettings } from "./thread-list";
import "./customer-workbench.css";

const homeGoalPrompt = "Show my home-buying goal and savings progress.";
const portfolioPrompt = planningTopics.find(({ id }) => id === "portfolio")!.prompt;
const adminChat = location.pathname === adminPaths.chat;
const createConversation = adminChat ? api.newAdminConversation : api.newConversation;
const starters = [
  ...(adminChat ? [{ Icon: BookOpenText, label: "Create a rule", message: "Create a rule" }] : []),
  { Icon: BookOpenText, label: "Explain a concept", message: "Explain the balance labels." },
  { Icon: Columns2, label: "Compare two terms", message: "Compare available and current balance." },
  { Icon: ListChecks, label: "Guide me through a task", message: "Walk me through the transfer steps." },
  { Icon: GraduationCap, label: "Learn about retirement", message: "I'd like to learn about retirement." },
  { Icon: House, label: "Home-buying goal", message: homeGoalPrompt },
  { Icon: MapPin, label: "Update mailing address", message: "I need to update my mailing address." },
];
type ConversationOperations = {
  latest?: TurnView;
  pending: boolean;
  retry: (id: string) => void;
  anchorTurn: (id: string, message: HTMLElement) => void;
  feedback: (turnId: string, experienceId: string, value: "helpful" | "unhelpful") => void;
};
const ConversationControls = createContext<ConversationOperations>({ pending: false, retry: () => undefined, feedback: () => undefined, anchorTurn: () => undefined });
function StarterPrompts({ disabled }: { disabled: boolean }) {
  const aui = useAui();
  return <div className="composer-starters" role="group" aria-label="Suggested questions">
    {starters.map(({ Icon, label, message }) => (
      <button key={label} type="button" className="starter" disabled={disabled} onClick={() => aui.thread().append(message)}>
        <Icon size={15} aria-hidden="true" />{label}
      </button>
    ))}
  </div>;
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
      {experience?.status === "ready" && experience.outcome !== "create_rule" && <div className="feedback-controls" aria-label="Response feedback">
        <span>Was this helpful?</span>
        <button className="icon-button" type="button" aria-label="Helpful" aria-pressed={turn.feedback === "helpful"}
          onClick={() => feedback(turn.id, experience.experienceId, "helpful")}><ThumbsUp size={16} /></button>
        <button className="icon-button" type="button" aria-label="Unhelpful" aria-pressed={turn.feedback === "unhelpful"}
          onClick={() => feedback(turn.id, experience.experienceId, "unhelpful")}><ThumbsDown size={16} /></button>
      </div>}
    </div>
  </MessagePrimitive.Root>;
}

function Composer({ draft, onDraft, running, pending, disabled, notice, input, showStarters }: {
  draft: string; onDraft: (value: string) => void; running: boolean; pending: boolean; disabled: boolean; notice: string;
  input: React.RefObject<HTMLTextAreaElement | null>;
  showStarters: boolean;
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
      {showStarters && <StarterPrompts disabled={disabled || pending} />}
      {notice && <div className="request-notice" role="status">{notice}</div>}
      {pending && !running && !notice && <div className="submit-status" role="status">Sending your request…</div>}
      <form className="composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
        <MessageSquare size={19} className="composer-icon" aria-hidden="true" />
        <div className="composer-field">
          <label className="sr-only" htmlFor="composer-input">Your question</label>
          <textarea id="composer-input" ref={input} rows={1} value={draft} maxLength={MAX_MESSAGE_LENGTH}
            placeholder="Ask a question…" onChange={(event) => onDraft(event.target.value)} onKeyDown={onKeyDown} />
        </div>
        {running ? <button className="send-button stop-button" type="button" disabled={pending} onClick={() => aui.thread().cancelRun()}>
          <Square size={13} aria-hidden="true" />Stop
        </button> : <button className="send-button" type="submit" disabled={disabled || pending || !draft.trim()}>
          Send <ArrowUp size={15} aria-hidden="true" />
        </button>}
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
  activeProfile?: DemoPersona; pendingActions: PendingActions; section: WorkspaceSection; pins: WorkspacePin[];
  onSelect: (section: WorkspaceSection) => void; onCustomize: () => void; customizeTrigger: React.RefObject<HTMLButtonElement | null>;
  onPreviewFunding: (source?: typeof pendingActionsContext) => void; onRestore: () => void;
  draft: string; onDraft: (value: string) => void; onSend: (text: string) => Promise<void>; onStop: () => Promise<void>;
  onRetry: (id: string) => void;
  onFollowUp: (id: string, envelope: ActionMessage) => void;
  onFeedback: ConversationOperations["feedback"];
};
const noTurns: TurnView[] = [];
function Chat({
  conversation, configuration, activeProfile, pendingActions, pending, draft, onDraft, onSend, onStop, onRetry, onFollowUp, onFeedback, notice,
  section, pins, onSelect, onCustomize, customizeTrigger, onPreviewFunding, onRestore,
}: ChatProps) {
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
  const archived = conversation?.archivedAt !== undefined;
  const activeExperienceId = pending || running || archived ? undefined : latest?.experience?.experienceId;
  const canWrite = Boolean(configuration) && !pending && !running && !archived;
  const showWelcomeCards = !adminChat && !turns.length && section === "summary";
  const showOverview = adminChat || section !== "summary";
  const overviewProps = {
    activeProfile, pins, onSelect, disabled: !canWrite,
    modelUnavailable: Boolean(configuration && !configuration.gatewayConfigured),
    onReviewGoal: () => void onSend(homeGoalPrompt),
    onReviewPortfolio: () => void onSend(portfolioPrompt),
    onPreviewFunding: () => onPreviewFunding(),
  };
  const composer = archived ? <div className="composer-area archived-conversation"><p>This conversation is archived.</p>
    <button className="secondary-button" type="button" disabled={pending} onClick={onRestore}>Restore conversation</button>
  </div> : <Composer draft={draft} onDraft={onDraft} running={running} pending={pending} disabled={!configuration} input={input}
    notice={notice} showStarters={turns.length === 0} />;

  return <AssistantRuntimeProvider runtime={runtime}>
    <ExperienceControls.Provider value={{ activeExperienceId, allowRuleCreation: adminChat, followUp: onFollowUp, rendered }}>
      <ConversationControls.Provider value={{ latest, pending, retry: onRetry, feedback: onFeedback, anchorTurn }}>
        <ExperienceDataUI />
        <ThreadPrimitive.Root className={adminChat ? "thread" : "thread customer-workbench"}>
          <WorkspaceMenu pins={pins} section={section} onCustomize={onCustomize} trigger={customizeTrigger} disabled={!configuration}
            onSelect={(next) => {
              onSelect(next);
              viewport.current?.scrollTo(0, 0);
            }} />
          <ThreadPrimitive.Viewport className="thread-scroll" ref={viewport}
            autoScroll={false} scrollToBottomOnInitialize={false} scrollToBottomOnRunStart={false} scrollToBottomOnThreadSwitch={false}
            aria-label="Conversation">
            {showWelcomeCards && <WorkspaceHome {...overviewProps} pendingActions={pendingActions}
              onReviewGuide={(message) => void onSend(message)} onPreviewFunding={() => onPreviewFunding(pendingActionsContext)} />}
            {showOverview && <WorkspaceOverview {...overviewProps} section={section} showNextStep={!turns.length} />}
            {turns.length > 0 && <div className="messages">
              <ThreadPrimitive.Messages>{({ message }) => message.role === "user" ? <UserMessage /> : <AssistantMessage />}</ThreadPrimitive.Messages>
            </div>}
          </ThreadPrimitive.Viewport>
          {composer}
        </ThreadPrimitive.Root>
      </ConversationControls.Provider>
    </ExperienceControls.Provider>
  </AssistantRuntimeProvider>;
}

function messageFor(error: unknown) {
  return error instanceof Error && error.name !== "TypeError" ? error.message : "Couldn’t connect. Your draft is still here.";
}

type Panel = { kind: "profiles" } | { kind: "pins" } | { kind: "thread"; id: string };
const narrowNavigation = "(max-width: 850px)";

function App() {
  const [entry] = useState(() => {
    const query = new URLSearchParams(location.search);
    return {
      topic: planningTopics.find(({ id }) => id === query.get("topic")),
      showProfiles: query.get("view") === "profiles",
      showOverview: query.get("view") === "overview",
      profileId: adminChat ? null : readProfileSession(),
    };
  });
  const [signedInProfileId, setSignedInProfileId] = useState(entry.profileId);
  const [configuration, setConfiguration] = useState<Bootstrap>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversation, setConversation] = useState<ConversationView>();
  const [overviewOpen, setOverviewOpen] = useState(entry.showOverview);
  const [section, setSection] = useState<WorkspaceSection>("summary");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [panel, setPanel] = useState<Panel | undefined>(entry.showProfiles ? { kind: "profiles" } : undefined);
  const inFlight = useRef(false);
  const previousAttempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const profilesTrigger = useRef<HTMLButtonElement>(null);
  const customizeTrigger = useRef<HTMLButtonElement>(null);
  const threadTrigger = useRef<HTMLButtonElement | null>(null);
  const newThreadTrigger = useRef<HTMLButtonElement>(null);
  const railTrigger = useRef<HTMLButtonElement>(null);
  const railClose = useRef<HTMLButtonElement>(null);
  const previousPanel = useRef<Panel["kind"] | undefined>(undefined);
  const profilesById = new Map(configuration?.personas.map((persona) => [persona.personaId, persona]));
  const activeProfile = profilesById.get(conversation?.personaId ?? signedInProfileId ?? configuration?.defaultPersonaId ?? "");
  const pins = activeProfile?.pins ?? defaultWorkspacePins;
  const activeSection = section === "summary" || pins.includes(section) ? section : "summary";
  const chat = overviewOpen ? undefined : conversation;
  const pendingActions = usePendingActions(!adminChat && !chat?.turns.length ? activeProfile?.personaId : undefined);
  const draftKey = chat?.id ?? "new:" + (conversation?.personaId ?? signedInProfileId ?? "");
  const latest = chat?.turns.at(-1);
  const activeTurnId = latest?.status === "working" ? latest.id : undefined;
  const visibleConversations = signedInProfileId ? conversations.filter((row) => row.personaId === signedInProfileId) : conversations;
  const remember = (row: Conversation) => setConversations((list) => (
    [row, ...list.filter((item) => item.id !== row.id)].sort((a, b) => b.updatedAt - a.updatedAt)
  ));
  const choose = (row: ConversationView, showOverview = false) => {
    setConversation(row);
    setOverviewOpen(showOverview);
    remember(row);
    rememberActiveConversation(row.id, adminChat);
    setRailOpen(false);
  };

  useEffect(() => {
    let mounted = true;
    void (adminChat ? api.adminBootstrap() : api.bootstrap()).then(async (data) => {
      if (!mounted) return;
      if (entry.profileId && !data.personas.some(({ personaId }) => personaId === entry.profileId)) {
        location.replace("/login");
        return;
      }
      const threads = data.conversations.filter(({ audience }) => (audience === "admin") === adminChat);
      setConversations(threads);
      const matching = entry.profileId ? threads.filter((row) => row.personaId === entry.profileId) : threads;
      const preferred = matching.find((row) => row.id === readActiveConversation(adminChat))
        ?? matching.find(({ archivedAt }) => archivedAt === undefined);
      if (preferred) {
        const restored = await api.conversation(preferred.id);
        if (!mounted) return;
        choose(restored, entry.showOverview);
      }
      const prompt = entry.topic?.prompt;
      if (prompt) {
        const key = preferred?.id ?? "new:" + (entry.profileId ?? "");
        setDrafts((all) => ({ ...all, [key]: all[key] ?? prompt }));
      }
      if (entry.topic || entry.showProfiles || entry.showOverview) history.replaceState(history.state, "", location.pathname + location.hash);
      setConfiguration(data);
    }).catch((error: unknown) => { if (mounted) setNotice(messageFor(error)); });
    return () => { mounted = false; };
  }, [entry]);

  useEffect(() => {
    if (adminChat) return;
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && readProfileSession() !== signedInProfileId) location.reload();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [signedInProfileId]);

  useEffect(() => {
    if (!railOpen) return;
    const trigger = railTrigger.current;
    railClose.current?.focus();
    const handle = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setRailOpen(false); };
    const layout = window.matchMedia(narrowNavigation);
    const onLayout = () => { if (!layout.matches) setRailOpen(false); };
    window.addEventListener("keydown", handle);
    layout.addEventListener("change", onLayout);
    return () => {
      window.removeEventListener("keydown", handle);
      layout.removeEventListener("change", onLayout);
      if (layout.matches) trigger?.focus();
    };
  }, [railOpen]);

  useLayoutEffect(() => {
    const closed = previousPanel.current;
    previousPanel.current = panel?.kind;
    if (panel || !closed) return;
    const triggers = { profiles: profilesTrigger, pins: customizeTrigger, thread: threadTrigger };
    const isNavigationPanel = closed !== "pins";
    if (isNavigationPanel && window.matchMedia(narrowNavigation).matches) railTrigger.current?.focus();
    else if (triggers[closed].current?.isConnected) triggers[closed].current?.focus();
    else newThreadTrigger.current?.focus();
  }, [panel]);

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
  const accept = ({ turn, conversation: row }: TurnAccepted) => {
    previousAttempt.current = null;
    upsert(turn);
    remember(row);
    setConversation((current) => current?.id === row.id ? { ...current, ...row } : current);
  };

  const send = async (message: string) => {
    if (!configuration) return;
    await exclusive(async () => {
      const target = chat ?? await createConversation(activeProfile?.personaId ?? configuration.defaultPersonaId, configuration.defaultScenarioId);
      if (!chat) choose(target);
      try {
        accept(await api.send(target.id, message, requestId(target.id + ":" + message)));
        setDrafts((all) => ({ ...all, [draftKey]: all[draftKey]?.trim() === message ? "" : all[draftKey] }));
      } catch (error) {
        if (!chat) setDrafts((all) => ({ ...all, [target.id]: all[draftKey] ?? message }));
        throw error;
      }
    });
  };
  const previewFunding = (source?: typeof pendingActionsContext) => {
    if (!configuration || !activeProfile) return;
    void exclusive(async () => {
      const target = chat && !chat.turns.length && chat.scenarioId === configuration.defaultScenarioId
        ? chat : await createConversation(activeProfile.personaId, configuration.defaultScenarioId);
      choose(target);
      accept(await api.previewFunding(target.id, requestId(target.id + ":preview-funding:" + (source ?? "overview")), source));
    });
  };
  const revealChat = (row: ConversationView) => {
    setSection("summary");
    choose(row);
    if (!adminChat && !row.turns.length) pendingActions.refresh();
  };
  const startConversation = async (personaId: string, scenarioId: string) => exclusive(async () => {
    const row = await createConversation(personaId, scenarioId);
    if (signedInProfileId && signedInProfileId !== row.personaId) {
      if (!saveProfileSession(row.personaId)) throw new Error("Couldn’t switch profiles in this tab. Please try again.");
      setSignedInProfileId(row.personaId);
    }
    revealChat(row);
  });
  const changeConversation = async (id: string, change: ConversationChange) => exclusive(async () => {
    const updated = await api.changeConversation(id, change);
    remember(updated);
    setConversation((current) => current?.id === id ? { ...current, ...updated, archivedAt: updated.archivedAt } : current);
    if (change.operation === "archive" && readActiveConversation(adminChat) === id) {
      rememberActiveConversation(null, adminChat);
      setOverviewOpen(true);
      setSection("summary");
    }
  });
  const savePins = async (next: WorkspacePin[]) => {
    if (!activeProfile) return false;
    return exclusive(async () => {
      const updated = await api.savePins(activeProfile.personaId, next);
      setConfiguration((current) => current && {
        ...current, personas: current.personas.map((profile) => profile.personaId === activeProfile.personaId ? { ...profile, pins: updated } : profile),
      });
      if (section !== "summary" && !updated.includes(section)) setSection("summary");
    });
  };
  const signOut = () => {
    if (saveProfileSession(null)) location.replace("/login");
    else setNotice("Couldn’t sign out in this tab. Please try again.");
  };
  const openPanel = (next: Panel) => {
    setRailOpen(false);
    if (next.kind === "thread" || next.kind === "pins") setNotice("");
    setPanel(next);
  };
  const closePanel = () => setPanel(undefined);
  const modelStatus = configuration?.mode === "test" ? "Test mode" : configuration?.gatewayConfigured ? "Model connected" : "Model offline";
  const managedThread = panel?.kind === "thread" ? visibleConversations.find(({ id }) => id === panel.id) : undefined;

  return <div className="app-layout">
    {railOpen && <button className="rail-scrim" aria-label="Close conversations" onClick={() => setRailOpen(false)} />}
    <aside className={"rail" + (railOpen ? " rail-open" : "")} id="conversation-rail" aria-label="Workspace navigation">
      <div className="rail-header">
        <a className="rail-home" href={adminChat ? adminPaths.tools : "/"}><LabMark />{adminChat ? "Administration" : "PZN Lab"}</a>
        <button className="icon-button rail-close" ref={railClose} aria-label="Close conversation navigation" onClick={() => setRailOpen(false)}><X size={20} /></button>
      </div>
      <button ref={newThreadTrigger} type="button" className="new-conversation" disabled={pending || !configuration} onClick={() => {
        if (configuration) void startConversation(conversation?.personaId ?? signedInProfileId ?? configuration.defaultPersonaId, conversation?.scenarioId ?? configuration.defaultScenarioId);
      }}><Plus size={18} aria-hidden="true" />New conversation</button>
      <button type="button" className="rail-link rail-overview" aria-current={!chat ? "page" : undefined} disabled={pending}
        onClick={() => {
          setOverviewOpen(true);
          setSection("summary");
          setRailOpen(false);
          setNotice("");
          if (!adminChat) pendingActions.refresh();
        }}>
        <LayoutDashboard size={17} aria-hidden="true" />Overview
      </button>
      <ThreadList threads={visibleConversations} profiles={profilesById} activeId={chat?.id}
        showNames={!signedInProfileId} pending={pending || !configuration}
        open={(id) => void exclusive(async () => revealChat(await api.conversation(id)))}
        manage={(id, trigger) => { threadTrigger.current = trigger; openPanel({ kind: "thread", id }); }} />
      {adminChat && <section className="rail-section rail-tools"><AdminNavigation thread={chat?.id} /></section>}
      <div className="rail-footer">
        {activeProfile && <button ref={profilesTrigger} className="rail-profile" type="button" aria-haspopup="dialog"
          aria-label={"Profiles, current profile " + activeProfile.displayName}
          onClick={() => openPanel({ kind: "profiles" })}>
          <ProfileAvatar name={activeProfile.displayName} />
          <span className="rail-profile-copy"><strong>{activeProfile.displayName}</strong><small>Switch profile</small></span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>}
        {adminChat ? <a className="rail-account" href="/chat"><ArrowLeft size={16} aria-hidden="true" />Customer view</a> : signedInProfileId
          ? <button type="button" className="rail-account" onClick={signOut}><LogOut size={16} aria-hidden="true" />Sign out</button>
          : <a className="rail-account" href="/login"><LogIn size={16} aria-hidden="true" />Sign in</a>}
      </div>
    </aside>
    <main className="workspace" inert={railOpen}>
      <header className="topbar">
        <div className="topbar-left">
          <button className="icon-button rail-menu" ref={railTrigger} type="button" aria-label="Show conversations" aria-expanded={railOpen}
            aria-controls="conversation-rail" onClick={() => setRailOpen((open) => !open)}><PanelLeft size={20} aria-hidden="true" /></button>
          <span className="workspace-crumb">{adminChat ? "Test chat" : "Workspace"} <ChevronRight size={14} aria-hidden="true" /></span>
          <h1>{chat?.title ?? "Overview"}</h1>
        </div>
        {adminChat && configuration && <span className="model-status" data-connected={configuration.gatewayConfigured}>
          <span aria-hidden="true" />{modelStatus}
        </span>}
      </header>
      <Chat key={draftKey} conversation={chat} configuration={configuration} activeProfile={activeProfile}
        pendingActions={pendingActions} pending={pending} section={activeSection} pins={pins}
        onSelect={setSection} customizeTrigger={customizeTrigger} onCustomize={() => openPanel({ kind: "pins" })}
        onPreviewFunding={previewFunding} onRestore={() => { if (chat) void changeConversation(chat.id, { operation: "restore" }); }}
        draft={drafts[draftKey] ?? ""} onDraft={(value) => setDrafts((all) => ({ ...all, [draftKey]: value }))} notice={notice}
        onSend={send} onStop={async () => {
          if (activeTurnId) await exclusive(async () => upsert(await api.cancel(activeTurnId)));
        }}
        onRetry={(id) => {
          if (chat) void exclusive(async () => accept(await api.retry(id, requestId("retry:" + id))));
        }}
        onFollowUp={(id, envelope) => {
          if (chat) void exclusive(async () => accept(await api.followUp(id, envelope, requestId("action:" + String(envelope.action.context.actionId) + ":" + JSON.stringify(envelope.action.context.values ?? null)))));
        }}
        onFeedback={(turnId, expId, value) => {
          void api.event(expId, value).then(() => api.turn(turnId)).then(upsert).catch((error) => setNotice(messageFor(error)));
        }} />
    </main>
    {configuration && activeProfile && panel?.kind === "profiles" && <DemoProfiles personas={configuration.personas}
      activePersonaId={activeProfile.personaId} pending={pending} close={closePanel}
      startChat={(personaId) => startConversation(personaId, configuration.defaultScenarioId)} />}
    {panel?.kind === "pins" && <WorkspaceCustomization key={activeProfile?.personaId} initial={pins} pending={pending} notice={notice} close={closePanel} save={savePins} />}
    {managedThread && <ThreadSettings key={managedThread.id} thread={managedThread} pending={pending} notice={notice} close={closePanel}
      change={(input) => changeConversation(managedThread.id, input)} />}
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
  document.title = (adminChat ? "Test chat" : "Assistant") + " · PZN Lab";
  root.render(<App />);
}
