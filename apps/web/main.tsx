import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useAui, useAuiState, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { CreateSurfaceMessageSchema, type ActionMessage } from "@a2ui/web_core/v1_0";
import {
  ArrowLeft, ArrowUp, ArrowUpRight, BookOpenText, ChevronDown, ChevronRight, Columns2, GraduationCap, House, LayoutDashboard,
  ListChecks, LogIn, LogOut, MapPin, MessageSquare, Mic, MicOff, PanelLeft, PanelLeftClose, Paperclip, Plus, RotateCcw, Sparkles,
  Square, ThumbsDown, ThumbsUp, Wallet, X,
} from "lucide-react";
import {
  failureCopy, progressLabels, type Bootstrap, type Conversation, type ConversationChange, type ConversationView,
  type DemoPersona, type NextBestActionCard, type Progress, type TurnAccepted, type TurnView,
} from "../../packages/contracts/api";
import { MAX_MESSAGE_LENGTH } from "../../packages/contracts/domain";
import { formatPortfolioAmount } from "../../packages/contracts/portfolio";
import { defaultWorkspacePins, pendingActionsContext, type WorkspacePin } from "../../packages/contracts/workspace";
import { adminPaths } from "../../packages/contracts/admin-paths";
import { api } from "./api";
import { AdminNavigation } from "./admin-navigation";
import { readActiveConversation, readProfileSession, rememberActiveConversation, saveProfileSession } from "./conversation-storage";
import {
  AttachmentChipList, composeMessageWithAttachments, computeNextSuggestions, NextSuggestionChips,
  readAttachmentFile, SpeakButton, useVoiceInput, type ComposerAttachment, type NextSuggestion,
} from "./composer-extras";
import { DemoProfiles, ProfileAvatar } from "./demo-profiles";
import { DomainLiveHud, DomainPackSwitcher, DomainWelcomeHome, useDomainPack } from "./domain-pack-ui";
import type { DomainPack } from "../../packages/contracts/domain-packs";
import { LabMark } from "./lab-mark";
import { LiveMetricsHud } from "./live-metrics-rail";
import { planningTopics } from "./planning-topics";
import { ReasoningPanel } from "./reasoning-panel";
import { applyTheme, readStoredTheme, ThemeToggle } from "./theme";
import { BasicSmoke, ExperienceControls, ExperienceDataUI, installA2uiStyles } from "./surface";
import { CEP_EMBED_PROTOCOL } from "../../packages/embed-sdk";
import type { ProactiveAlert } from "../../packages/contracts/proactive-events";
import { usePendingActions, WorkspaceHome, WorkspaceOverview, type PendingActions } from "./workspace-overview";
import { WorkspaceCustomization, WorkspaceMenu, type WorkspaceSection } from "./workspace-menu";
import { ThreadList, ThreadSettings } from "./thread-list";
import "./customer-workbench.css";

const homeGoalPrompt = "Show my home-buying goal and savings progress.";
const portfolioPrompt = planningTopics.find(({ id }) => id === "portfolio")!.prompt;
const adminChat = location.pathname === adminPaths.chat;
const embedMode = location.pathname === "/embed";
const createConversation = adminChat ? api.newAdminConversation : api.newConversation;
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function applyEmbedAccent(accent: string | null) {
  const root = document.documentElement.style;
  if (!accent || !/^#[0-9a-fA-F]{3,8}$/.test(accent.trim())) return;
  const color = accent.trim();
  root.setProperty("--embed-accent", color);
  root.setProperty("--embed-accent-pale", `color-mix(in srgb, ${color} 11%, transparent)`);
  root.setProperty("--embed-accent-border", `color-mix(in srgb, ${color} 34%, transparent)`);
}

function postEmbedEvent(type: string, payload: Record<string, unknown>) {
  if (!embedMode || window.parent === window) return;
  try {
    window.parent.postMessage({ protocol: CEP_EMBED_PROTOCOL, type, payload }, "*");
  } catch { /* ignore cross-origin restrictions */ }
}

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
  activeProfile?: DemoPersona;
  progressHistory: Record<string, Progress[]>;
  retry: (id: string) => void;
  anchorTurn: (id: string, message: HTMLElement) => void;
  feedback: (turnId: string, experienceId: string, value: "helpful" | "unhelpful") => void;
  runPrompt: (prompt: string) => void;
  previewFunding: () => void;
};

const ConversationControls = createContext<ConversationOperations>({
  pending: false,
  progressHistory: {},
  retry: () => undefined,
  feedback: () => undefined,
  anchorTurn: () => undefined,
  runPrompt: () => undefined,
  previewFunding: () => undefined,
});

function StarterPrompts({ disabled, activeProfile }: { disabled: boolean; activeProfile?: DemoPersona }) {
  const aui = useAui();
  const dynamicStarters = useMemo(() => {
    if (adminChat || !activeProfile) return [];
    const items: { Icon: typeof Sparkles; label: string; message: string; personalized: true }[] = [];
    const cashCents = activeProfile.overview?.portfolio?.cashCents ?? 0;
    if (activeProfile.profile.accountFundingStatus === "unfunded") {
      items.push({
        Icon: Wallet,
        label: "Deposit $500 to start",
        message: "I want to deposit $500 into my investment account.",
        personalized: true,
      });
    } else if (cashCents > 10_000_00) {
      items.push({
        Icon: Sparkles,
        label: `Review ${formatPortfolioAmount(cashCents)} cash`,
        message: "Let me know my portfolio summary.",
        personalized: true,
      });
    }
    if (activeProfile.overview?.homeGoal) {
      items.push({
        Icon: Sparkles,
        label: "Simulate 2-year home plan",
        message: "I want to buy a house in two years. Show me how close I am and help me explore a savings plan.",
        personalized: true,
      });
    }
    return items;
  }, [activeProfile]);

  return <div className="composer-starters" role="group" aria-label="Suggested questions">
    {dynamicStarters.map(({ Icon, label, message }) => (
      <button key={label} type="button" className="starter starter-personalized" disabled={disabled} onClick={() => aui.thread().append(message)}>
        <Icon size={14} aria-hidden="true" />{label}
      </button>
    ))}
    {starters.map(({ Icon, label, message }) => (
      <button key={label} type="button" className="starter" disabled={disabled} onClick={() => aui.thread().append(message)}>
        <Icon size={14} aria-hidden="true" />{label}
      </button>
    ))}
  </div>;
}

function UserMessage() {
  const createdAt = useAuiState((state) => state.message.createdAt);
  const { activeProfile } = useContext(ConversationControls);
  const displayName = activeProfile?.displayName ?? "You";
  return (
    <MessagePrimitive.Root className="user-message">
      <div className="stream-user-row">
        <ProfileAvatar name={displayName} />
        <div className="stream-user-body">
          <div className="stream-meta-line">
            <strong>{displayName}</strong>
            <span className="turn-meta">{createdAt ? timeFormat.format(createdAt) : "Just now"}</span>
          </div>
          <div className="user-bubble"><MessagePrimitive.Parts /></div>
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

function NbaCompanionCard({ nba, personaId, disabled, onRunPrompt, onPreviewFunding }: {
  nba: NextBestActionCard;
  personaId?: string;
  disabled: boolean;
  onRunPrompt: (prompt: string) => void;
  onPreviewFunding: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  if (dismissed) {
    return (
      <p className="nba-dismissed-note" role="status">
        Dismissed — we&rsquo;ll prioritize other recommendations next time.
      </p>
    );
  }

  async function dismiss() {
    if (!personaId || dismissing) return;
    setDismissing(true);
    try {
      await api.dismissNba(personaId, nba.id);
      setDismissed(true);
    } catch {
      setDismissed(true);
    } finally {
      setDismissing(false);
    }
  }

  return (
    <section className="content-card nba-companion-card" aria-label="Next best action">
      <div className="nba-companion-top">
        <span className="nba-companion-kicker"><Sparkles size={13} aria-hidden="true" />{nba.kicker}</span>
      </div>
      <h3>{nba.title}</h3>
      <p className="content-body">{nba.body}</p>
      <p className="nba-companion-reason">Why you&rsquo;re seeing this: {nba.reason}</p>
      <div className="nba-companion-actions">
        <button
          type="button"
          className="axe-primary-button"
          disabled={disabled}
          onClick={() => {
            if (nba.actionKind === "preview_funding") onPreviewFunding();
            else if (nba.prompt) onRunPrompt(nba.prompt);
          }}
        >
          {nba.ctaLabel} <ArrowUpRight size={14} aria-hidden="true" />
        </button>
        <button type="button" className="secondary-button" disabled={dismissing} onClick={() => void dismiss()}>
          Not now
        </button>
      </div>
    </section>
  );
}

function AssistantMessage() {
  const turn = useAuiState((state) => state.message.metadata.custom?.turn as TurnView | undefined);
  const { latest, pending, activeProfile, progressHistory, retry, feedback, anchorTurn, runPrompt, previewFunding } = useContext(ConversationControls);
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (element.current && turn && latest?.id === turn.id) anchorTurn(turn.id, element.current);
  }, [anchorTurn, latest?.id, turn?.id]);
  if (!turn) return null;
  const experience = turn.experience;
  const steps = progressHistory[turn.id] ?? [turn.progress];

  return (
    <MessagePrimitive.Root ref={element} className="assistant-message">
      <div className="stream-assistant-row">
        <LabMark small />
        <div className="assistant-content">
          <header className="stream-meta-line">
            <strong>CEP Assistant</strong>
            <span className="turn-meta">{timeFormat.format(new Date(turn.createdAt))}</span>
          </header>

          {turn.status === "working" ? (
            <>
              <div role="status" aria-live="polite" className="sr-only">{progressLabels[turn.progress]}…</div>
              <ReasoningPanel status={turn.status} progress={turn.progress} history={steps} />
            </>
          ) : (
            <>
              {steps.length > 0 && turn.status === "completed" && (
                <ReasoningPanel
                  status={turn.status}
                  progress={turn.progress}
                  history={steps}
                  experience={experience}
                  actionMode={turn.actionMode}
                  semanticRoute={turn.semanticRoute}
                  customerLookup={turn.customerLookup}
                  providerArbitration={turn.providerArbitration}
                />
              )}
              <MessagePrimitive.Parts />
              {!adminChat && turn.nextBestAction && (
                <NbaCompanionCard
                  nba={turn.nextBestAction}
                  personaId={activeProfile?.personaId}
                  disabled={pending}
                  onRunPrompt={runPrompt}
                  onPreviewFunding={previewFunding}
                />
              )}
            </>
          )}

          {turn.status === "completed" && latest?.id === turn.id && <span className="sr-only" role="status">Response ready.</span>}
          {(turn.status === "failed" || turn.status === "cancelled") && latest?.id === turn.id && (
            <button type="button" disabled={pending} className="secondary-button retry" onClick={() => retry(turn.id)}>
              <RotateCcw size={15} />Retry
            </button>
          )}
          {experience?.status === "ready" && experience.outcome !== "create_rule" && (
            <footer className="feedback-controls" aria-label="Response feedback">
              <SpeakButton text={experience.question ?? experience.intro} />
              <span>Was this helpful?</span>
              <button className="icon-button" type="button" aria-label="Helpful" aria-pressed={turn.feedback === "helpful"}
                onClick={() => feedback(turn.id, experience.experienceId, "helpful")}><ThumbsUp size={15} /></button>
              <button className="icon-button" type="button" aria-label="Unhelpful" aria-pressed={turn.feedback === "unhelpful"}
                onClick={() => feedback(turn.id, experience.experienceId, "unhelpful")}><ThumbsDown size={15} /></button>
            </footer>
          )}
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

function Composer({ draft, onDraft, running, pending, disabled, notice, input, showStarters, hero, activeProfile, nextSuggestions, domainPack }: {
  draft: string; onDraft: (value: string) => void; running: boolean; pending: boolean; disabled: boolean; notice: string;
  input: React.RefObject<HTMLTextAreaElement | null>;
  showStarters: boolean;
  hero?: boolean;
  activeProfile?: DemoPersona;
  nextSuggestions: NextSuggestion[];
  domainPack?: DomainPack;
}) {
  const aui = useAui();
  const fileInput = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [localNotice, setLocalNotice] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const voice = useVoiceInput({
    onTranscript: (text) => {
      setLocalNotice("");
      onDraft(text);
    },
    onError: (msg) => setLocalNotice(msg),
  });

  useEffect(() => () => {
    for (const item of attachments) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
  }, [attachments]);

  const addFiles = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    setLocalNotice("");
    const incoming = Array.from(fileList).slice(0, Math.max(0, 4 - attachments.length));
    if (!incoming.length) {
      setLocalNotice("You can attach up to 4 files per message.");
      return;
    }
    const parsed = await Promise.all(incoming.map((file) => readAttachmentFile(file)));
    setAttachments((prev) => [...prev, ...parsed]);
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
  };

  const canSubmit = !running && !pending && !disabled && (Boolean(draft.trim()) || attachments.length > 0);
  const send = () => {
    if (!canSubmit) return;
    if (voice.listening) voice.stop();
    const payload = composeMessageWithAttachments(draft, attachments);
    setAttachments([]);
    setLocalNotice("");
    aui.thread().append(payload);
  };

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }
  const nearLimit = draft.length > MAX_MESSAGE_LENGTH * 0.8;
  const activeNotice = notice || localNotice;

  return <div className={hero ? "composer-area composer-hero" : "composer-area composer-dock"}>
    <div className="composer-inner">
      {!hero && showStarters && <StarterPrompts disabled={disabled || pending} activeProfile={activeProfile} />}
      {!hero && !showStarters && !running && (
        <NextSuggestionChips
          suggestions={nextSuggestions}
          disabled={disabled || pending}
          onPick={(prompt) => aui.thread().append(prompt)}
        />
      )}
      {activeNotice && <div className="request-notice" role="status">{activeNotice}</div>}
      {pending && !running && !activeNotice && <div className="submit-status" role="status">Sending your request…</div>}
      <form
        className={"composer" + (dragOver ? " is-drag-over" : "") + (attachments.length ? " has-attachments" : "")}
        onSubmit={(event) => { event.preventDefault(); send(); }}
        onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          void addFiles(event.dataTransfer.files);
        }}
      >
        <AttachmentChipList attachments={attachments} onRemove={removeAttachment} />
        <div className="composer-input-row">
          <MessageSquare size={18} className="composer-icon" aria-hidden="true" />
          <div className="composer-field">
            <label className="sr-only" htmlFor="composer-input">Your question</label>
            <textarea id="composer-input" ref={input} rows={hero ? 2 : 1} value={draft} maxLength={MAX_MESSAGE_LENGTH}
              placeholder={voice.listening ? "Listening… speak your question" : (domainPack?.composerPlaceholder ?? "Ask a question…")}
              onChange={(event) => onDraft(event.target.value)} onKeyDown={onKeyDown} />
          </div>
          <div className="composer-tools">
            <input
              ref={fileInput}
              type="file"
              multiple
              className="sr-only"
              accept=".pdf,.csv,.txt,.json,.md,.png,.jpg,.jpeg,.webp"
              onChange={(event) => {
                void addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className="composer-tool-btn"
              aria-label="Attach file"
              title="Attach statement, CSV, PDF, or image"
              disabled={disabled || pending || running}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={"composer-tool-btn" + (voice.listening ? " is-listening" : "")}
              aria-label={voice.listening ? "Stop voice input" : "Voice input"}
              aria-pressed={voice.listening}
              title={voice.listening ? "Stop voice dictation" : "Dictate with microphone"}
              disabled={disabled || pending || running}
              onClick={() => voice.toggle(draft)}
            >
              {voice.listening ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
            </button>
            {running ? <button className="send-button stop-button" type="button" disabled={pending} onClick={() => aui.thread().cancelRun()}>
              <Square size={13} aria-hidden="true" />Stop
            </button> : <button className="send-button" type="submit" disabled={!canSubmit}>
              Send <ArrowUp size={15} aria-hidden="true" />
            </button>}
          </div>
        </div>
      </form>
      <div className="composer-footer-row">
        <span className="composer-guardrail">
          {voice.listening
            ? <span className="voice-live-badge"><span aria-hidden="true" />Listening via microphone…</span>
            : (adminChat ? "Admin test environment" : (domainPack?.guardrailLabel ?? "CEP Advisory Guardrails Active"))}
        </span>
        <div className="composer-footer-right">
          {nearLimit && <span className="composer-count">{draft.length}/{MAX_MESSAGE_LENGTH}</span>}
          <p className="composer-hint">Enter to send <span aria-hidden="true">·</span> Shift+Enter for a new line</p>
        </div>
      </div>
      {hero && showStarters && <StarterPrompts disabled={disabled || pending} activeProfile={activeProfile} />}
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
  progressHistory: Record<string, Progress[]>;
  domainPack: DomainPack;
  onSelect: (section: WorkspaceSection) => void;
  onPreviewFunding: (source?: typeof pendingActionsContext) => void; onRestore: () => void;
  onWriteBack?: (updates: Record<string, string>) => Promise<string[]>;
  draft: string; onDraft: (value: string) => void; onSend: (text: string) => Promise<void>; onStop: () => Promise<void>;
  onRetry: (id: string) => void;
  onFollowUp: (id: string, envelope: ActionMessage) => void;
  onFeedback: ConversationOperations["feedback"];
};

const noTurns: TurnView[] = [];

function Chat({
  conversation, configuration, activeProfile, pendingActions, pending, draft, onDraft, onSend, onStop, onRetry, onFollowUp, onFeedback, notice,
  section, pins, progressHistory, domainPack, onSelect, onPreviewFunding, onRestore, onWriteBack,
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
    scroll.scrollTop = Math.max(0, top - 24);
  }, []);
  const rendered = useCallback((experienceId: string, fallback?: boolean) => {
    void api.event(experienceId, fallback ? "render_fallback" : "rendered").catch(() => undefined);
  }, []);
  const archived = conversation?.archivedAt !== undefined;
  const activeExperienceId = pending || running || archived ? undefined : latest?.experience?.experienceId;
  const canWrite = Boolean(configuration) && !pending && !running && !archived;
  const showWelcomeCards = !adminChat && !turns.length && section === "summary";
  const showOverview = adminChat || section !== "summary";
  const useHeroComposer = !archived && !turns.length && section === "summary" && !adminChat;

  const overviewProps = {
    activeProfile, pins, onSelect, disabled: !canWrite,
    modelUnavailable: Boolean(configuration && !configuration.gatewayConfigured),
    onReviewGoal: () => void onSend(homeGoalPrompt),
    onReviewPortfolio: () => void onSend(portfolioPrompt),
    onPreviewFunding: () => onPreviewFunding(),
  };

  const nextSuggestions = useMemo(() => {
    if (adminChat) return [];
    if (domainPack.id !== "wealth") return domainPack.quickPrompts;
    return computeNextSuggestions(latest, activeProfile, configuration?.intentPrompts);
  }, [latest, activeProfile, configuration?.intentPrompts, domainPack]);

  const composerEl = archived ? <div className="composer-area archived-conversation"><p>This conversation is archived.</p>
    <button className="secondary-button" type="button" disabled={pending} onClick={onRestore}>Restore conversation</button>
  </div> : <Composer draft={draft} onDraft={onDraft} running={running} pending={pending} disabled={!configuration} input={input}
    notice={notice} showStarters={turns.length === 0 && domainPack.id === "wealth"} hero={useHeroComposer} activeProfile={activeProfile}
    nextSuggestions={nextSuggestions} domainPack={domainPack} />;

  return <AssistantRuntimeProvider runtime={runtime}>
    <ExperienceControls.Provider value={{
      activeExperienceId,
      allowRuleCreation: adminChat,
      askPrompt: canWrite ? (prompt) => void onSend(prompt) : undefined,
      onWriteBack,
      followUp: onFollowUp,
      rendered,
    }}>
      <ConversationControls.Provider value={{
        latest, pending, activeProfile, progressHistory, retry: onRetry, feedback: onFeedback, anchorTurn,
        runPrompt: (prompt) => void onSend(prompt),
        previewFunding: () => onPreviewFunding(pendingActionsContext),
      }}>
        <ExperienceDataUI />
        <ThreadPrimitive.Root className={adminChat ? "thread" : "thread customer-workbench editorial-thread"}>
          <ThreadPrimitive.Viewport className="thread-scroll" ref={viewport}
            autoScroll={false} scrollToBottomOnInitialize={false} scrollToBottomOnRunStart={false} scrollToBottomOnThreadSwitch={false}
            aria-label="Conversation">
            {!adminChat && section === "summary" && domainPack.id !== "wealth" && (
              <DomainLiveHud
                domainId={domainPack.id}
                disabled={!canWrite}
                onPrompt={(prompt) => void onSend(prompt)}
              />
            )}
            {!adminChat && turns.length > 0 && section === "summary" && domainPack.id === "wealth" && (
              <LiveMetricsHud
                activeProfile={activeProfile}
                pendingActions={pendingActions}
                disabled={!canWrite}
                onReviewPortfolio={() => void onSend(portfolioPrompt)}
                onReviewGoal={() => void onSend(homeGoalPrompt)}
                onPreviewFunding={() => onPreviewFunding(pendingActionsContext)}
                onReviewGuide={(message) => void onSend(message)}
              />
            )}
            {useHeroComposer && (
              <div className="editorial-hero-stage">
                {domainPack.id === "wealth"
                  ? <WorkspaceHome {...overviewProps} pendingActions={pendingActions}
                      onReviewGuide={(message) => void onSend(message)} onPreviewFunding={() => onPreviewFunding(pendingActionsContext)} />
                  : <DomainWelcomeHome domainId={domainPack.id} disabled={!canWrite} onPrompt={(prompt) => void onSend(prompt)} />}
                {composerEl}
              </div>
            )}
            {!useHeroComposer && showWelcomeCards && (
              domainPack.id === "wealth"
                ? <WorkspaceHome {...overviewProps} pendingActions={pendingActions}
                    onReviewGuide={(message) => void onSend(message)} onPreviewFunding={() => onPreviewFunding(pendingActionsContext)} />
                : <DomainWelcomeHome domainId={domainPack.id} disabled={!canWrite} onPrompt={(prompt) => void onSend(prompt)} />
            )}
            {showOverview && <WorkspaceOverview {...overviewProps} section={section} showNextStep={!turns.length} />}
            {turns.length > 0 && <div className="messages">
              <ThreadPrimitive.Messages>{({ message }) => message.role === "user" ? <UserMessage /> : <AssistantMessage />}</ThreadPrimitive.Messages>
            </div>}
          </ThreadPrimitive.Viewport>
          {!useHeroComposer && composerEl}
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
      profileId: adminChat ? null : (embedMode ? (query.get("personaId") || readProfileSession() || "persona_new_investor") : readProfileSession()),
      embedBrand: query.get("brand")?.trim() || "CEP Assistant",
      embedAccent: query.get("accent")?.trim() || "",
      embedPrompt: query.get("prompt")?.trim() || "",
    };
  });
  const [embedBrand, setEmbedBrand] = useState(entry.embedBrand);
  const [embedAccent, setEmbedAccent] = useState(entry.embedAccent);
  const [proactiveAlert, setProactiveAlert] = useState<ProactiveAlert | null>(null);
  const [signedInProfileId, setSignedInProfileId] = useState(entry.profileId);
  const [domainPack, setDomainPack] = useDomainPack();
  const [configuration, setConfiguration] = useState<Bootstrap>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversation, setConversation] = useState<ConversationView>();
  const [overviewOpen, setOverviewOpen] = useState(entry.showOverview);
  const [section, setSection] = useState<WorkspaceSection>("summary");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [progressHistory, setProgressHistory] = useState<Record<string, Progress[]>>({});
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
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
  const pendingActions = usePendingActions(!adminChat ? activeProfile?.personaId : undefined);
  const draftKey = chat?.id ?? "new:" + (conversation?.personaId ?? signedInProfileId ?? "");
  const latest = chat?.turns.at(-1);
  const activeTurnId = latest?.status === "working" ? latest.id : undefined;
  const scopedPersonaId = adminChat ? null : (signedInProfileId ?? activeProfile?.personaId ?? null);
  const visibleConversations = scopedPersonaId
    ? conversations.filter((row) => row.personaId === scopedPersonaId)
    : conversations;

  const recordProgress = useCallback((turnId: string, progress: Progress) => {
    setProgressHistory((prev) => {
      const current = prev[turnId] ?? [];
      if (current.includes(progress)) return prev;
      return { ...prev, [turnId]: [...current, progress] };
    });
  }, []);

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
        if (!embedMode) {
          location.replace("/login");
          return;
        }
        setSignedInProfileId(data.defaultPersonaId);
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
    const onDomainUpdate = () => {
      void (adminChat ? api.adminBootstrap() : api.bootstrap()).then((fresh) => {
        setConfiguration((prev) => (prev ? { ...prev, personas: fresh.personas } : fresh));
      }).catch(() => undefined);
    };
    window.addEventListener("cep-domain-data-updated", onDomainUpdate);
    return () => window.removeEventListener("cep-domain-data-updated", onDomainUpdate);
  }, []);

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
    recordProgress(turn.id, turn.progress);
    setConversation((previous) => {
      if (!previous || previous.id !== turn.conversationId) return previous;
      const existing = previous.turns.find((item) => item.id === turn.id);
      if (existing) {
        if (existing.status !== "working" && turn.status === "working") return previous;
        return { ...previous, turns: previous.turns.map((item) => item.id === turn.id ? turn : item) };
      }
      return { ...previous, turns: [...previous.turns, turn] };
    });
  }, [recordProgress]);

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
      recordProgress(id, progress);
      setConversation((previous) => previous ? {
        ...previous, turns: previous.turns.map((turn) => turn.id === id && turn.status === "working" ? { ...turn, progress } : turn),
      } : previous);
    });
    for (const type of ["experience.ready", "turn.failed", "turn.cancelled", "gap", "error"]) stream.addEventListener(type, refresh);
    const recoveryPoll = setInterval(refresh, 4000);
    return () => { alive = false; stream.close(); clearInterval(recoveryPoll); };
  }, [activeTurnId, upsert, recordProgress]);

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
      setSection("summary");
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
      setSection("summary");
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
  const startFreshChat = () => {
    if (configuration) void startConversation(conversation?.personaId ?? signedInProfileId ?? configuration.defaultPersonaId, conversation?.scenarioId ?? configuration.defaultScenarioId);
  };

  const sendRef = useRef(send);
  sendRef.current = send;
  const startConversationRef = useRef(startConversation);
  startConversationRef.current = startConversation;
  const embedReadyPosted = useRef(false);
  const lastBalanceSig = useRef("");
  const lastTurnPosted = useRef("");

  useEffect(() => {
    if (!embedMode) return;
    applyEmbedAccent(embedAccent);
  }, [embedAccent]);

  useEffect(() => {
    if (!embedMode) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { protocol?: string; type?: string; payload?: Record<string, unknown> } | null;
      if (!data || data.protocol !== CEP_EMBED_PROTOCOL || typeof data.type !== "string") return;
      const payload = data.payload ?? {};
      if (data.type === "cep:send_prompt" && typeof payload.prompt === "string" && payload.prompt.trim()) {
        void sendRef.current(payload.prompt.trim());
      } else if (data.type === "cep:set_theme" && (payload.theme === "dark" || payload.theme === "light")) {
        applyTheme(payload.theme);
      } else if (data.type === "cep:set_domain" && (payload.domain === "wealth" || payload.domain === "it_ops" || payload.domain === "sales_revops")) {
        setDomainPack(payload.domain);
      } else if (data.type === "cep:set_brand") {
        if (typeof payload.brand === "string" && payload.brand.trim()) setEmbedBrand(payload.brand.trim());
        if (typeof payload.accent === "string" && payload.accent.trim()) setEmbedAccent(payload.accent.trim());
      } else if (data.type === "cep:set_persona" && typeof payload.personaId === "string" && configuration) {
        void startConversationRef.current(payload.personaId, configuration.defaultScenarioId);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [configuration, setDomainPack]);

  useEffect(() => {
    if (!embedMode || !configuration || !activeProfile || embedReadyPosted.current) return;
    embedReadyPosted.current = true;
    postEmbedEvent("cep:ready", {
      personaId: activeProfile.personaId,
      displayName: activeProfile.displayName,
      domain: domainPack.id,
      theme: readStoredTheme(),
    });
    if (entry.embedPrompt) {
      void sendRef.current(entry.embedPrompt);
    }
  }, [configuration, activeProfile, domainPack.id, entry.embedPrompt]);

  useEffect(() => {
    if (!embedMode || !activeProfile?.overview?.portfolio) return;
    const p = activeProfile.overview.portfolio;
    const totalCents = p.cashCents + p.equityCents + p.fixedIncomeCents;
    const sig = `${activeProfile.personaId}:${p.cashCents}:${p.equityCents}:${totalCents}`;
    if (sig === lastBalanceSig.current) return;
    lastBalanceSig.current = sig;
    postEmbedEvent("cep:balance_updated", {
      personaId: activeProfile.personaId,
      displayName: activeProfile.displayName,
      cashCents: p.cashCents,
      equityCents: p.equityCents,
      totalCents,
    });
  }, [activeProfile]);

  useEffect(() => {
    if (!embedMode || !latest || latest.status === "working") return;
    const key = `${latest.id}:${latest.status}`;
    if (key === lastTurnPosted.current) return;
    lastTurnPosted.current = key;
    const intro = (latest.experience?.messages?.[0]?.createSurface?.dataModel as { intro?: string } | undefined)?.intro;
    postEmbedEvent("cep:turn_completed", {
      turnId: latest.id,
      message: latest.message,
      status: latest.status,
      ...(intro ? { summary: intro } : {}),
    });
  }, [latest]);

  useEffect(() => {
    if (adminChat) return;
    let alive = true;
    const stream = new EventSource("/api/proactive/stream");
    stream.addEventListener("proactive.alert", (evt) => {
      if (!alive) return;
      try {
        const alert = JSON.parse((evt as MessageEvent).data) as ProactiveAlert;
        setProactiveAlert(alert);
        postEmbedEvent("cep:proactive_alert", {
          id: alert.id,
          eventType: alert.eventType,
          severity: alert.severity,
          domain: alert.domain,
          title: alert.title,
          metricValue: alert.metricValue,
        });
      } catch { /* ignore */ }
    });
    return () => {
      alive = false;
      stream.close();
    };
  }, []);

  const modelStatus = adminChat
    ? (configuration?.mode === "test" ? "Test mode" : configuration?.gatewayConfigured ? "Model connected" : "Model offline")
    : (configuration?.copilotModel ? `Live · ${configuration.copilotModel}` : "Live Advisory");
  const managedThread = panel?.kind === "thread" ? visibleConversations.find(({ id }) => id === panel.id) : undefined;
  const canRunRailActions = Boolean(configuration) && !pending && latest?.status !== "working";

  return <div className={"app-layout" + (embedMode ? " embed-layout" : "") + (railCollapsed ? " rail-collapsed" : "")}>
    {!embedMode && railOpen && <button className="rail-scrim" aria-label="Close conversations" onClick={() => setRailOpen(false)} />}
    {!embedMode && <aside className={"rail" + (railOpen ? " rail-open" : "")} id="conversation-rail" aria-label="Workspace navigation">
      <div className="rail-header">
        <a className="rail-home" href={adminChat ? adminPaths.tools : "/"}>
          <LabMark />
          <span className="rail-brand-text">
            <strong>{adminChat ? "Administration" : "CEP"}</strong>
            {!adminChat && <small>Customer Engagement Platform</small>}
          </span>
        </a>
        <button className="icon-button rail-collapse-desktop" type="button" aria-label="Collapse sidebar" title="Collapse sidebar"
          onClick={() => setRailCollapsed(true)}><PanelLeftClose size={17} aria-hidden="true" /></button>
        <button className="icon-button rail-close" ref={railClose} aria-label="Close conversation navigation" onClick={() => setRailOpen(false)}><X size={20} /></button>
      </div>
      <button ref={newThreadTrigger} type="button" className="new-conversation" disabled={pending || !configuration} onClick={startFreshChat}>
        <Plus size={17} aria-hidden="true" />New conversation
      </button>
      {!adminChat && <DomainPackSwitcher activeId={domainPack.id} onSelect={setDomainPack} />}
      <div className="rail-section rail-workbench-nav">
        <button type="button" className="rail-link rail-overview" aria-current={!chat ? "page" : undefined} disabled={pending}
          onClick={() => {
            setOverviewOpen(true);
            setSection("summary");
            setRailOpen(false);
            setNotice("");
            if (!adminChat) pendingActions.refresh();
          }}>
          <LayoutDashboard size={16} aria-hidden="true" />Overview
        </button>
      </div>
      <ThreadList threads={visibleConversations} profiles={profilesById} activeId={chat?.id}
        showNames={adminChat} pending={pending || !configuration}
        open={(id) => void exclusive(async () => revealChat(await api.conversation(id)))}
        manage={(id, trigger) => { threadTrigger.current = trigger; openPanel({ kind: "thread", id }); }} />
      {!adminChat && (
        <section className="rail-section rail-topics" aria-label="Quick planning topics">
          <h2>{domainPack.id === "wealth" ? "Topics" : `${domainPack.shortLabel} Actions`}</h2>
          <nav>
            {domainPack.id === "wealth"
              ? planningTopics.map(({ id, name, prompt, Icon }) => (
                  <button key={id} type="button" className="rail-link" disabled={!canRunRailActions} onClick={() => {
                    setRailOpen(false);
                    void send(prompt);
                  }}>
                    <Icon size={15} aria-hidden="true" />{name}
                  </button>
                ))
              : domainPack.topics.map(({ id, name, prompt }) => (
                  <button key={id} type="button" className="rail-link" disabled={!canRunRailActions} onClick={() => {
                    setRailOpen(false);
                    void send(prompt);
                  }}>
                    <Sparkles size={14} aria-hidden="true" />{name}
                  </button>
                ))}
          </nav>
        </section>
      )}
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
    </aside>}
    <main className="workspace" inert={railOpen}>
      {embedMode ? (
        <header className="topbar embed-topbar">
          <div className="embed-topbar-brand">
            <span className="embed-brand-dot" aria-hidden="true" />
            <div className="embed-brand-copy">
              <strong>{embedBrand}</strong>
              <small>{activeProfile?.displayName ?? "Client"} · {domainPack.label}</small>
            </div>
          </div>
          <div className="embed-topbar-actions">
            <button type="button" className="embed-new-btn" disabled={pending || !configuration} onClick={startFreshChat} title="Start new conversation">
              <Plus size={14} aria-hidden="true" />New
            </button>
            <ThemeToggle compact />
          </div>
        </header>
      ) : (
        <header className="topbar unified-topbar">
          <div className="topbar-left">
            <button className="icon-button rail-menu" ref={railTrigger} type="button" aria-label="Show conversations" aria-expanded={railOpen}
              aria-controls="conversation-rail" onClick={() => setRailOpen((open) => !open)}><PanelLeft size={19} aria-hidden="true" /></button>
            {railCollapsed && (
              <button className="icon-button rail-expand-desktop" type="button" aria-label="Expand sidebar" title="Expand sidebar"
                onClick={() => setRailCollapsed(false)}><PanelLeft size={18} aria-hidden="true" /></button>
            )}
            <span className="workspace-crumb">
              {adminChat ? "Test chat" : (activeProfile?.displayName ?? "Workspace")}
              <ChevronRight size={13} aria-hidden="true" />
            </span>
            <h1>{chat?.title ?? "Overview"}</h1>
          </div>
          <div className="topbar-center">
            <WorkspaceMenu pins={pins} section={activeSection} onSelect={setSection} onCustomize={() => openPanel({ kind: "pins" })}
              trigger={customizeTrigger} disabled={!configuration} />
          </div>
          <div className="topbar-actions">
            <ThemeToggle compact />
            {configuration && (
              <span className="model-status" data-connected={configuration.gatewayConfigured}>
                <span aria-hidden="true" />{modelStatus}
              </span>
            )}
          </div>
        </header>
      )}
      {proactiveAlert && (
        <div className={`proactive-banner is-${proactiveAlert.severity}`} role="status">
          <div className="proactive-banner-copy">
            <span className="proactive-badge">{proactiveAlert.metricLabel}: <strong>{proactiveAlert.metricValue}</strong></span>
            <div>
              <strong>{proactiveAlert.title}</strong>
              <p>{proactiveAlert.summary}</p>
            </div>
          </div>
          <div className="proactive-banner-actions">
            <button
              type="button"
              className="proactive-cta-btn"
              onClick={() => {
                const target = proactiveAlert;
                setProactiveAlert(null);
                void api.dismissProactiveAlert(target.id).catch(() => undefined);
                if (target.domain !== domainPack.id) setDomainPack(target.domain);
                void send(target.ctaPrompt);
              }}
            >
              <Sparkles size={13} aria-hidden="true" />
              {proactiveAlert.ctaLabel}
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss proactive alert"
              onClick={() => {
                const id = proactiveAlert.id;
                setProactiveAlert(null);
                void api.dismissProactiveAlert(id).catch(() => undefined);
              }}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
      <Chat key={draftKey} conversation={chat} configuration={configuration} activeProfile={activeProfile}
        pendingActions={pendingActions} pending={pending} section={activeSection} pins={pins} progressHistory={progressHistory}
        domainPack={domainPack}
        onSelect={setSection} onPreviewFunding={previewFunding}
        onRestore={() => { if (chat) void changeConversation(chat.id, { operation: "restore" }); }}
        onWriteBack={activeProfile ? async (updates) => {
          const { updatedFields } = await api.applyCustomerBindings(activeProfile.personaId, updates);
          if (updatedFields.length > 0) {
            void (adminChat ? api.adminBootstrap() : api.bootstrap()).then((fresh) => {
              setConfiguration(fresh);
            }).catch(() => undefined);
          }
          return updatedFields;
        } : undefined}
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
  document.title = (adminChat ? "Test chat" : "Assistant") + " · CEP";
  root.render(<App />);
}
