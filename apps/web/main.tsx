import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useAui, useAuiState, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import type { ActionMessage } from "@a2ui/web_core/v1_0";
import {
  ArrowLeft, ArrowUp, ArrowUpRight, BookOpenText, ChevronDown, ChevronRight, Columns2, Eye, GraduationCap, House, LayoutDashboard,
  ListChecks, LogIn, LogOut, MapPin, MessageSquare, Mic, MicOff, PanelLeft, PanelLeftClose, Paperclip, Plus, RotateCcw, Sparkles,
  Square, ThumbsDown, ThumbsUp, X,
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
  AttachmentChipList, composeMessageWithAttachments, computeNextSuggestions, createSampleAttachment,
  NextSuggestionChips, readAttachmentFile, SAMPLE_UPLOAD_DOCUMENTS, SpeakButton, useVoiceInput,
  type ComposerAttachment, type NextSuggestion,
} from "./composer-extras";
import { DemoProfiles, ProfileAvatar } from "./demo-profiles";
import { DomainLiveHud, DomainWelcomeHome, useDomainPack } from "./domain-pack-ui";
import type { DomainPack } from "../../packages/contracts/domain-packs";
import { LabMark } from "./lab-mark";
import { planningTopics } from "./planning-topics";
import { ReasoningPanel } from "./reasoning-panel";
import { applyTheme, readStoredTheme, ThemeToggle } from "./theme";
import { ExperienceControls, ExperienceDataUI, installA2uiStyles } from "./surface";
import { CEP_EMBED_PROTOCOL, type CepEmbedScreenContext } from "../../packages/embed-sdk";
import type { ProactiveAlert } from "../../packages/contracts/proactive-events";
import { usePendingActions, WorkspaceHome, WorkspaceOverview, type PendingActions } from "./workspace-overview";
import { WorkspaceCustomization, WorkspaceMenu, type WorkspaceSection } from "./workspace-menu";
import { ThreadList, ThreadSettings } from "./thread-list";
import type { HandoffTicket } from "../../packages/contracts/handoff";
import {
  CitationsStrip, isHandoffPhrase, LiveCanvasPane, LiveHandoffCard, matchSlashCommands,
  MemoryDrawer, SlashCommandMenu, TurnRichActions, type MemoryEntry, type SlashCommand,
} from "./chat-rich-ux";
import type { ExpertiseMode, Watchcard } from "../../packages/contracts/nextgen-chat";
import {
  ChatToolsMenu, ConsumerA2aDrawer, ExpertiseTurnBanner, LivingWatchcardsStrip, ParallelFuturesPane,
} from "./nextgen-chat-features";
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
  { Icon: ListChecks, label: "My retirement accounts", message: "Show my retirement accounts." },
  { Icon: GraduationCap, label: "Learn about retirement", message: "I'd like to learn about retirement." },
  { Icon: House, label: "Home-buying goal", message: homeGoalPrompt },
  { Icon: House, label: "Explore a savings plan", message: "I want to buy a house in two years. Show me how close I am and help me explore a savings plan." },
  { Icon: MapPin, label: "Update mailing address", message: "I need to update my mailing address." },
];

type ConversationOperations = {
  latest?: TurnView;
  pending: boolean;
  activeProfile?: DemoPersona;
  progressHistory: Record<string, Progress[]>;
  expertiseMode: ExpertiseMode;
  pinnedTurnId?: string;
  pinCanvas: (turn: TurnView) => void;
  retry: (id: string) => void;
  anchorTurn: (id: string, message: HTMLElement) => void;
  feedback: (turnId: string, experienceId: string, value: "helpful" | "unhelpful") => void;
  runPrompt: (prompt: string) => void;
  previewFunding: () => void;
};

const ConversationControls = createContext<ConversationOperations>({
  pending: false,
  progressHistory: {},
  expertiseMode: "standard",
  pinCanvas: () => undefined,
  retry: () => undefined,
  feedback: () => undefined,
  anchorTurn: () => undefined,
  runPrompt: () => undefined,
  previewFunding: () => undefined,
});

function StarterPrompts({ disabled }: { disabled: boolean }) {
  const aui = useAui();
  return <details className="starter-disclosure">
    <summary>Explore suggested questions</summary>
    <div className="composer-starters" role="group" aria-label="Suggested questions">
      {starters.map(({ Icon, label, message }) => (
        <button key={label} type="button" className="starter" disabled={disabled} onClick={() => aui.thread().append(message)}>
          <Icon size={14} aria-hidden="true" />{label}
        </button>
      ))}
    </div>
  </details>;
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
  const { latest, pending, activeProfile, progressHistory, expertiseMode, pinnedTurnId, pinCanvas, retry, feedback, anchorTurn, runPrompt, previewFunding } = useContext(ConversationControls);
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
              <div role="status" aria-live="polite" className={adminChat ? "sr-only" : "customer-progress"}>{progressLabels[turn.progress]}…</div>
              {adminChat && <ReasoningPanel status={turn.status} progress={turn.progress} history={steps} />}
            </>
          ) : (
            <>
              {adminChat && steps.length > 0 && turn.status === "completed" && (
                <ReasoningPanel
                  status={turn.status}
                  progress={turn.progress}
                  history={steps}
                  experience={experience}
                  actionMode={turn.actionMode}
                  semanticRoute={turn.semanticRoute}
                  customerLookup={turn.customerLookup}
                  providerArbitration={turn.providerArbitration}
                  piiRedaction={turn.piiRedaction}
                />
              )}
              {!adminChat && turn.status === "completed" && (
                <ExpertiseTurnBanner mode={expertiseMode} turn={turn} />
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
            <>
              <CitationsStrip experience={experience} userMessage={turn.message} />
              <TurnRichActions
                turn={turn}
                pending={pending}
                pinnedInCanvas={pinnedTurnId === turn.id}
                onPinCanvas={pinCanvas}
                onReframe={runPrompt}
              />
              <footer className="feedback-controls" aria-label="Response feedback">
                <SpeakButton text={experience.question ?? experience.intro} />
                <span>Was this helpful?</span>
                <button className="icon-button" type="button" aria-label="Helpful" aria-pressed={turn.feedback === "helpful"}
                  onClick={() => feedback(turn.id, experience.experienceId, "helpful")}><ThumbsUp size={15} /></button>
                <button className="icon-button" type="button" aria-label="Unhelpful" aria-pressed={turn.feedback === "unhelpful"}
                  onClick={() => feedback(turn.id, experience.experienceId, "unhelpful")}><ThumbsDown size={15} /></button>
              </footer>
            </>
          )}
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

function Composer({ draft, onDraft, running, pending, disabled, notice, input, showStarters, hero, nextSuggestions, domainPack, onOpenAdvisor, onOpenMemory, onOpenFutures, onOpenWatch, onOpenDelegate }: {
  draft: string; onDraft: (value: string) => void; running: boolean; pending: boolean; disabled: boolean; notice: string;
  input: React.RefObject<HTMLTextAreaElement | null>;
  showStarters: boolean;
  hero?: boolean;
  nextSuggestions: NextSuggestion[];
  domainPack?: DomainPack;
  onOpenAdvisor?: () => void;
  onOpenMemory?: () => void;
  onOpenFutures?: () => void;
  onOpenWatch?: () => void;
  onOpenDelegate?: () => void;
}) {
  const aui = useAui();
  const fileInput = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [localNotice, setLocalNotice] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [sampleMenuOpen, setSampleMenuOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashCommands = useMemo(() => matchSlashCommands(draft), [draft]);
  useEffect(() => { setSlashIndex(0); }, [slashCommands.length, draft]);

  const runSlashCommand = (cmd: SlashCommand) => {
    onDraft("");
    if (cmd.action === "prompt" && cmd.prompt) {
      aui.thread().append(cmd.prompt);
    } else if (cmd.action === "advisor") {
      onOpenAdvisor?.();
    } else if (cmd.action === "memory") {
      onOpenMemory?.();
    } else if (cmd.action === "futures") {
      onOpenFutures?.();
    } else if (cmd.action === "watch") {
      onOpenWatch?.();
    } else if (cmd.action === "delegate") {
      onOpenDelegate?.();
    } else if (cmd.action === "upload") {
      fileInput.current?.click();
    }
  };

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
    if (slashCommands.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((i) => (i + 1) % slashCommands.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((i) => (i - 1 + slashCommands.length) % slashCommands.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onDraft("");
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        const picked = slashCommands[slashIndex] ?? slashCommands[0];
        if (picked) runSlashCommand(picked);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }
  const nearLimit = draft.length > MAX_MESSAGE_LENGTH * 0.8;
  const activeNotice = notice || localNotice;

  return <div className={hero ? "composer-area composer-hero" : "composer-area composer-dock"}>
    <div className="composer-inner">
      {!hero && showStarters && <StarterPrompts disabled={disabled || pending} />}
      {!hero && !showStarters && !running && (
        <NextSuggestionChips
          suggestions={nextSuggestions}
          disabled={disabled || pending}
          onPick={(prompt) => aui.thread().append(prompt)}
        />
      )}
      {activeNotice && <div className="request-notice" role="status">{activeNotice}</div>}
      {pending && !running && !activeNotice && <div className="submit-status" role="status">Sending your request…</div>}
      <div className="composer-slash-wrap">
      <SlashCommandMenu commands={slashCommands} activeIndex={slashIndex} onPick={runSlashCommand} />
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
              placeholder={voice.listening ? "Listening… speak your question" : (domainPack?.composerPlaceholder ? `${domainPack.composerPlaceholder} (or type / for commands)` : "Ask a question or type / for quick commands…")}
              onChange={(event) => onDraft(event.target.value)} onKeyDown={onKeyDown} />
          </div>
          <div className="composer-tools">
            <input
              ref={fileInput}
              type="file"
              multiple
              className="sr-only"
              accept=".pdf,.csv,.txt,.json,.md,.log,.png,.jpg,.jpeg,.webp"
              onChange={(event) => {
                void addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <div className="composer-attach-wrap">
              <button
                type="button"
                className="composer-tool-btn"
                aria-label="Attach file"
                title="Attach invoice, CSV, log, PDF, or pick a sample document"
                disabled={disabled || pending || running}
                onClick={() => setSampleMenuOpen((open) => !open)}
              >
                <Paperclip size={16} aria-hidden="true" />
              </button>
              {sampleMenuOpen && (
                <div className="composer-sample-menu" role="menu" aria-label="Document to Action upload">
                  <button
                    type="button"
                    className="composer-sample-item is-primary"
                    onClick={() => {
                      setSampleMenuOpen(false);
                      fileInput.current?.click();
                    }}
                  >
                    Upload file from computer…
                  </button>
                  <div className="composer-sample-divider">Or attach sample document:</div>
                  {SAMPLE_UPLOAD_DOCUMENTS.map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      className="composer-sample-item"
                      onClick={() => {
                        const att = createSampleAttachment(doc.id);
                        if (att) setAttachments((prev) => [...prev.slice(0, 3), att]);
                        setSampleMenuOpen(false);
                      }}
                    >
                      {doc.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
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
      </div>
      <div className="composer-footer-row">
        <span className="composer-guardrail">
          {voice.listening
            ? <span className="voice-live-badge"><span aria-hidden="true" />Listening via microphone…</span>
            : (adminChat ? "Admin test environment" : null)}
        </span>
        <div className="composer-footer-right">
          {nearLimit && <span className="composer-count">{draft.length}/{MAX_MESSAGE_LENGTH}</span>}
          <p className="composer-hint">Enter to send <span aria-hidden="true">·</span> Shift+Enter for a new line</p>
        </div>
      </div>
      {hero && showStarters && <StarterPrompts disabled={disabled || pending} />}
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
  activeHandoff: HandoffTicket | null;
  onStartHandoff: (reason?: string) => void;
  onDismissHandoff: () => void;
  onOpenMemory: () => void;
  expertiseMode: ExpertiseMode;
  futuresOpen: boolean;
  onToggleFutures: (open?: boolean) => void;
  watchcards: Watchcard[];
  onWatchcardsChange: (next: Watchcard[]) => void;
  watchCreatorOpen: boolean;
  onToggleWatchCreator: (open?: boolean) => void;
  onOpenDelegate: () => void;
};

const noTurns: TurnView[] = [];

function Chat({
  conversation, configuration, activeProfile, pendingActions, pending, draft, onDraft, onSend, onStop, onRetry, onFollowUp, onFeedback, notice,
  section, pins, progressHistory, domainPack, onSelect, onPreviewFunding, onRestore, onWriteBack,
  activeHandoff, onStartHandoff, onDismissHandoff, onOpenMemory,
  expertiseMode, futuresOpen, onToggleFutures, watchcards, onWatchcardsChange, watchCreatorOpen, onToggleWatchCreator, onOpenDelegate,
}: ChatProps) {
  const turns = conversation?.turns ?? noTurns;
  const latest = turns.at(-1);
  const running = latest?.status === "working";
  const [pinnedTurnId, setPinnedTurnId] = useState<string | undefined>(undefined);
  useEffect(() => { setPinnedTurnId(undefined); }, [conversation?.id]);
  const pinnedTurn = useMemo(() => turns.find((t) => t.id === pinnedTurnId && t.experience), [turns, pinnedTurnId]);
  const pinCanvas = useCallback((turn: TurnView) => {
    setPinnedTurnId((curr) => (curr === turn.id ? undefined : turn.id));
  }, []);
  const [updates, setUpdates] = useState<Awaited<ReturnType<typeof api.recordUpdates>>>([]);
  useEffect(() => {
    setUpdates([]);
    if (!conversation?.id || running) return;
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = await api.recordUpdates(conversation.id);
        if (closed) return;
        setUpdates(next);
        if (next.some((w) => w.state === "watching")) timer = setTimeout(read, 30_000);
      } catch { if (!closed) timer = setTimeout(read, 30_000); }
    };
    void read();
    return () => { closed = true; clearTimeout(timer); };
  }, [conversation?.id, latest?.id, running]);
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
    if (adminChat || latest?.nextBestAction || latest?.experience?.actions.length) return [];
    if (domainPack.id !== "wealth") return domainPack.quickPrompts;
    return computeNextSuggestions(latest, activeProfile, configuration?.intentPrompts);
  }, [adminChat, latest, activeProfile, configuration?.intentPrompts, domainPack]);

  const composerEl = archived ? <div className="composer-area archived-conversation"><p>This conversation is archived.</p>
    <button className="secondary-button" type="button" disabled={pending} onClick={onRestore}>Restore conversation</button>
  </div> : <Composer draft={draft} onDraft={onDraft} running={running} pending={pending} disabled={!configuration} input={input}
    notice={notice} showStarters={turns.length === 0 && domainPack.id === "wealth"} hero={useHeroComposer}
    nextSuggestions={nextSuggestions} domainPack={domainPack}
    onOpenAdvisor={() => onStartHandoff()} onOpenMemory={onOpenMemory}
    onOpenFutures={() => onToggleFutures(true)} onOpenWatch={() => onToggleWatchCreator(true)} onOpenDelegate={onOpenDelegate} />;

  return <AssistantRuntimeProvider runtime={runtime}>
    <ExperienceControls.Provider value={{
      activeExperienceId,
      allowRuleCreation: adminChat,
      accountPortalAvailable: !adminChat && conversation?.domainId === "wealth",
      askPrompt: canWrite ? (prompt) => void onSend(prompt) : undefined,
      onWriteBack,
      followUp: onFollowUp,
      rendered,
    }}>
      <ConversationControls.Provider value={{
        latest, pending, activeProfile, progressHistory, expertiseMode, pinnedTurnId, pinCanvas: (t) => { onToggleFutures(false); pinCanvas(t); }, retry: onRetry, feedback: onFeedback, anchorTurn,
        runPrompt: (prompt) => void onSend(prompt),
        previewFunding: () => onPreviewFunding(pendingActionsContext),
      }}>
        <ExperienceDataUI />
        <div className="chat-split-shell">
        <ThreadPrimitive.Root className={adminChat ? "thread" : "thread customer-workbench editorial-thread"}>
          <ThreadPrimitive.Viewport className="thread-scroll" ref={viewport}
            autoScroll={false} scrollToBottomOnInitialize={false} scrollToBottomOnRunStart={false} scrollToBottomOnThreadSwitch={false}
            aria-label="Conversation">
            {!adminChat && (
              <LivingWatchcardsStrip
                personaId={activeProfile?.personaId ?? configuration?.defaultPersonaId ?? "demo-learner"}
                conversationId={conversation?.id ?? "default"}
                watchcards={watchcards}
                onChange={onWatchcardsChange}
                showCreator={watchCreatorOpen}
                onCloseCreator={() => onToggleWatchCreator(false)}
              />
            )}
            {!adminChat && section === "summary" && domainPack.id !== "wealth" && (
              <DomainLiveHud
                domainId={domainPack.id}
                disabled={!canWrite}
                onPrompt={(prompt) => void onSend(prompt)}
              />
            )}
            {!adminChat && activeHandoff && (
              <LiveHandoffCard ticket={activeHandoff} onDismiss={onDismissHandoff} />
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
            {updates.length > 0 && <section className="thread-updates" aria-label="Record updates" aria-live="polite">{updates.map((w) => <p key={w.id}>{w.state === "reached" ? <strong>Update received</strong> : <strong>Watching</strong>} · {w.label} · Current status: {w.value}</p>)}</section>}
            {turns.length > 0 && <div className="messages">
              <ThreadPrimitive.Messages>{({ message }) => message.role === "user" ? <UserMessage /> : <AssistantMessage />}</ThreadPrimitive.Messages>
            </div>}
          </ThreadPrimitive.Viewport>
          {!useHeroComposer && composerEl}
        </ThreadPrimitive.Root>
        {futuresOpen ? (
          <ParallelFuturesPane
            persona={activeProfile}
            onClose={() => onToggleFutures(false)}
          />
        ) : (
          pinnedTurn && <LiveCanvasPane turn={pinnedTurn} onClose={() => setPinnedTurnId(undefined)} />
        )}
        </div>
      </ConversationControls.Provider>
    </ExperienceControls.Provider>
  </AssistantRuntimeProvider>;
}

function messageFor(error: unknown) {
  return error instanceof Error && error.name !== "TypeError" ? error.message : "Couldn’t connect. Your draft is still here.";
}

type Panel = { kind: "profiles" } | { kind: "pins" } | { kind: "thread"; id: string };
const narrowNavigation = "(max-width: 850px)";

/** What the customer sees above the chat: a plain-language snapshot of the screen they're on, plus a few next steps. */
function buildWealthDomContext(section: WorkspaceSection, profile?: DemoPersona): CepEmbedScreenContext | null {
  if (!profile) return null;
  const p = profile.overview?.portfolio;
  const totalCents = p ? p.cashCents + p.equityCents + p.fixedIncomeCents : 0;
  const cashLabel = p ? formatPortfolioAmount(p.cashCents) : "$0";
  const equityLabel = p ? formatPortfolioAmount(p.equityCents) : "$0";
  const fixedLabel = p ? formatPortfolioAmount(p.fixedIncomeCents) : "$0";
  const totalLabel = p ? formatPortfolioAmount(totalCents) : "$0";
  const goal = profile.overview?.homeGoal;
  const savedCents = goal?.history.at(-1)?.savedCents ?? 0;
  const goalPct = goal && goal.targetCents > 0 ? Math.floor((savedCents * 100) / goal.targetCents) : 0;
  const benMissing = profile.profile?.beneficiaryStatus === "missing";
  const unfunded = profile.profile?.accountFundingStatus === "unfunded";
  const firstName = profile.displayName.split(" ")[0] ?? profile.displayName;
  const addBeneficiary = { label: "Add a beneficiary", prompt: "How do I update my beneficiary designation?" };

  if (section === "portfolio") {
    return {
      id: "wealth-portfolio",
      label: `Your portfolio · ${totalLabel}`,
      viewType: "wealth_portfolio",
      summary: `You hold ${equityLabel} in stocks, ${fixedLabel} in bonds and ${cashLabel} in cash.`,
      metrics: [
        { label: "Stocks", value: equityLabel },
        { label: "Bonds", value: fixedLabel },
        { label: "Cash", value: cashLabel },
      ],
      suggestedActions: [
        { label: "Sell some Apple shares, tax-smart", prompt: "I want to sell 40% of my Apple shares" },
        { label: "What stocks do I own?", prompt: "whats in my equity book right now?" },
        { label: "How do wash-sale rules work?", prompt: "What is our policy on tax-loss harvesting and wash-sale rules?" },
      ],
    };
  }
  if (section === "savings") {
    const targetLabel = goal ? formatPortfolioAmount(goal.targetCents) : "$100,000";
    const savedLabel = formatPortfolioAmount(savedCents);
    return {
      id: "wealth-savings",
      label: `Home down payment · ${goalPct}% of your goal`,
      viewType: "wealth_savings_goal",
      summary: `You've saved ${savedLabel} toward your ${targetLabel} down payment. Keep going, ${firstName}.`,
      metrics: [
        { label: "Saved", value: savedLabel },
        { label: "Goal", value: targetLabel },
        { label: "Progress", value: `${goalPct}%` },
      ],
      suggestedActions: [
        { label: "Plan to buy a home in 2 years", prompt: "I want to buy a house in two years. Show me how close I am and help me explore a savings plan." },
        { label: "How am I tracking?", prompt: homeGoalPrompt },
        { label: "Send money to escrow", prompt: "I want to initiate a wire transfer" },
      ],
    };
  }
  if (section === "account") {
    const todo = (benMissing ? 1 : 0) + (unfunded ? 1 : 0);
    return {
      id: "wealth-account",
      label: todo ? `Your account · ${todo} thing${todo > 1 ? "s" : ""} to finish` : "Your account · all set",
      viewType: "wealth_account_status",
      summary: [
        unfunded ? "Your account is open and waiting for its first deposit." : "Your account is funded.",
        benMissing ? "You haven't named a beneficiary yet; it only takes a minute." : "Your beneficiaries are on file.",
      ].join(" "),
      metrics: [
        { label: "Deposit", value: unfunded ? "Waiting" : "Received" },
        { label: "Beneficiary", value: benMissing ? "Not added" : "On file" },
        { label: "Cash", value: cashLabel },
      ],
      suggestedActions: [
        ...(benMissing ? [addBeneficiary] : []),
        { label: "Update my mailing address", prompt: "I need to update my mailing address." },
        { label: "Wire limits & security", prompt: "What are the wire transfer approval limits and security rules?" },
      ],
    };
  }
  if (section === "next-step") {
    return {
      id: "wealth-next-step",
      label: `Your next step, ${firstName}`,
      viewType: "wealth_next_step",
      summary: unfunded
        ? "Make your first deposit to start investing. Here are a few things you can do now."
        : `You have ${cashLabel} in cash that isn't invested yet. Here are a few ideas.`,
      metrics: [
        { label: "Total", value: totalLabel },
        { label: "Cash", value: cashLabel },
      ],
      suggestedActions: [
        { label: "Review my portfolio", prompt: portfolioPrompt },
        { label: "What do my balances mean?", prompt: "Explain the balance labels." },
        { label: "Learn about retirement", prompt: "I'd like to learn about retirement." },
      ],
    };
  }
  return {
    id: "wealth-summary",
    label: `Your wealth · ${totalLabel}`,
    viewType: "wealth_summary",
    summary: `You have ${cashLabel} in cash and ${equityLabel} invested in stocks.${benMissing ? " One thing to finish: you haven't named a beneficiary yet." : ""}`,
    metrics: [
      { label: "Total", value: totalLabel },
      { label: "Cash", value: cashLabel },
      { label: "Stocks", value: equityLabel },
    ],
    suggestedActions: [
      { label: "Review my portfolio", prompt: portfolioPrompt },
      ...(benMissing ? [addBeneficiary] : []),
      { label: "Sell some Apple shares, tax-smart", prompt: "I want to sell 40% of my Apple shares" },
      { label: "Send a wire transfer", prompt: "I want to initiate a wire transfer" },
    ].slice(0, 4),
  };
}

function App() {
  const [entry] = useState(() => {
    const query = new URLSearchParams(location.search);
    return {
      topic: planningTopics.find(({ id }) => id === query.get("topic")),
      showProfiles: query.get("view") === "profiles",
      showOverview: query.get("view") === "overview",
      profileId: adminChat ? null : (embedMode ? (query.get("personaId") || readProfileSession() || "demo-learner") : readProfileSession()),
      embedBrand: query.get("brand")?.trim() || "CEP Assistant",
      embedAccent: query.get("accent")?.trim() || "",
      embedPrompt: query.get("prompt")?.trim() || "",
    };
  });
  const [embedBrand, setEmbedBrand] = useState(entry.embedBrand);
  const [embedAccent, setEmbedAccent] = useState(entry.embedAccent);
  const [screenContext, setScreenContext] = useState<CepEmbedScreenContext | null>(null);
  const [ambientDismissed, setAmbientDismissed] = useState(false);
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
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryItems, setMemoryItems] = useState<MemoryEntry[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState("");
  const [activeHandoff, setActiveHandoff] = useState<HandoffTicket | null>(null);
  const [expertiseMode, setExpertiseMode] = useState<ExpertiseMode>(() => {
    try {
      const saved = localStorage.getItem("cep_expertise_mode");
      return saved === "guided" || saved === "pro" ? saved : "standard";
    } catch { return "standard"; }
  });
  const [futuresOpen, setFuturesOpen] = useState(false);
  const [watchcards, setWatchcards] = useState<Watchcard[]>([]);
  const [watchCreatorOpen, setWatchCreatorOpen] = useState(false);
  const [delegateOpen, setDelegateOpen] = useState(false);
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
  const workspaceProfileId = domainPack.id === "wealth" ? signedInProfileId : undefined;
  const activeProfile = profilesById.get(conversation?.personaId ?? workspaceProfileId ?? configuration?.defaultPersonaId ?? "")
    ?? (domainPack.id !== "wealth" ? profilesById.get(configuration?.defaultPersonaId ?? "") : undefined);
  const pins = activeProfile?.pins ?? defaultWorkspacePins;
  const activeSection = section === "summary" || pins.includes(section) ? section : "summary";
  const wealthDomContextJson = useMemo(() => {
    if (adminChat || embedMode || domainPack.id !== "wealth") return undefined;
    const ctx = buildWealthDomContext(activeSection, activeProfile);
    return ctx ? JSON.stringify(ctx) : undefined;
  }, [activeSection, activeProfile, domainPack.id]);

  const chat = overviewOpen || conversation?.domainId !== domainPack.id ? undefined : conversation;
  const pendingActions = usePendingActions(!adminChat && domainPack.id === "wealth" ? activeProfile?.personaId : undefined);
  const draftKey = chat?.id ?? "new:" + (conversation?.personaId ?? signedInProfileId ?? "");
  const latest = chat?.turns.at(-1);
  const activeTurnId = latest?.status === "working" ? latest.id : undefined;
  const scopedPersonaId = adminChat ? null : (workspaceProfileId ?? activeProfile?.personaId ?? null);
  const visibleConversations = conversations.filter((row) => row.domainId === domainPack.id && (!scopedPersonaId || row.personaId === scopedPersonaId));

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
    rememberActiveConversation(row.id, adminChat, row.domainId);
    setRailOpen(false);
  };

  useEffect(() => {
    let mounted = true;
    setConversation(undefined);
    setConfiguration(undefined);
    void (adminChat ? api.adminBootstrap(domainPack.id) : api.bootstrap(domainPack.id)).then(async (data) => {
      if (!mounted) return;
      if (data.requiresProfile) {
        if (!embedMode) { location.replace("/login"); return; }
        setNotice("Select a profile on the sign-in page to open this workspace.");
      }
      if (domainPack.id === "wealth" && entry.profileId && !data.personas.some(({ personaId }) => personaId === entry.profileId)) {
        if (!embedMode) {
          location.replace("/login");
          return;
        }
        setSignedInProfileId(data.defaultPersonaId);
      }
      const threads = data.conversations.filter(({ audience, domainId }) => (audience === "admin") === adminChat && domainId === domainPack.id);
      setConversations(threads);
      const matching = domainPack.id === "wealth" && entry.profileId ? threads.filter((row) => row.personaId === entry.profileId) : threads;
      const preferred = matching.find((row) => row.id === readActiveConversation(adminChat, domainPack.id))
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
  }, [entry, domainPack.id]);

  useEffect(() => {
    const onDomainUpdate = () => {
      void (adminChat ? api.adminBootstrap(domainPack.id) : api.bootstrap(domainPack.id)).then((fresh) => {
        setConfiguration((prev) => (prev ? { ...prev, personas: fresh.personas } : fresh));
      }).catch(() => undefined);
    };
    window.addEventListener("cep-domain-data-updated", onDomainUpdate);
    return () => window.removeEventListener("cep-domain-data-updated", onDomainUpdate);
  }, [domainPack.id]);

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

  const startHandoff = useCallback(async (reason?: string) => {
    const convId = chat?.id ?? `conv_${crypto.randomUUID().slice(0, 10)}`;
    const personaId = activeProfile?.personaId ?? configuration?.defaultPersonaId ?? "demo-learner";
    const domain = domainPack.id === "it_ops" ? "operations" : domainPack.id === "sales_revops" ? "sales" : "wealth";
    try {
      const res = await api.createHandoff({
        conversationId: convId,
        personaId,
        domain,
        reason: (reason?.trim() || "Customer requested a live specialist from chat.").slice(0, 400),
      });
      setActiveHandoff(res.ticket);
      setOverviewOpen(false);
      setSection("summary");
    } catch (error) {
      setNotice(messageFor(error));
    }
  }, [activeProfile?.personaId, chat?.id, configuration?.defaultPersonaId, domainPack.id]);

  const loadMemory = useCallback(async () => {
    if (!configuration?.gatewayConfigured) return;
    setMemoryLoading(true);
    setMemoryError("");
    try {
      const res = await api.memoryList();
      setMemoryItems(res.items);
    } catch (error) {
      setMemoryError(messageFor(error));
    } finally {
      setMemoryLoading(false);
    }
  }, [configuration?.gatewayConfigured]);

  useEffect(() => {
    if (configuration?.gatewayConfigured) void loadMemory();
  }, [configuration?.gatewayConfigured, loadMemory]);

  const changeExpertiseMode = useCallback((next: ExpertiseMode) => {
    setExpertiseMode(next);
    try { localStorage.setItem("cep_expertise_mode", next); } catch { /* ignore */ }
    if (configuration?.gatewayConfigured) {
      void api.memorySave({ kind: "preference", key: "ui_expertise_mode", content: `Preferred chat complexity dial: ${next}` })
        .then((res) => setMemoryItems(res.items))
        .catch(() => undefined);
    }
  }, [configuration?.gatewayConfigured]);

  useEffect(() => {
    if (adminChat || !activeProfile) return;
    let alive = true;
    const syncActiveHandoff = () => {
      void api.activeHandoff(activeProfile.personaId).then((res) => {
        if (!alive) return;
        if (res.ticket) {
          setActiveHandoff((prev) => (prev?.handoffId === res.ticket!.handoffId && prev.updatedAt === res.ticket!.updatedAt ? prev : res.ticket));
        }
      }).catch(() => undefined);
    };
    syncActiveHandoff();
    const timer = setInterval(syncActiveHandoff, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [activeProfile?.personaId, adminChat]);

  useEffect(() => {
    if (adminChat || !activeProfile) return;
    let alive = true;
    void api.listWatchcards(activeProfile.personaId).then((res) => {
      if (alive) setWatchcards(res.watchcards);
    }).catch(() => undefined);
    const stream = new EventSource("/api/watchcards/stream?personaId=" + encodeURIComponent(activeProfile.personaId));
    stream.addEventListener("watchcard.update", (evt) => {
      if (!alive) return;
      try {
        const updated = JSON.parse((evt as MessageEvent).data) as Watchcard;
        setWatchcards((prev) => {
          if (updated.status === "dismissed") return prev.filter((c) => c.id !== updated.id);
          const exists = prev.some((c) => c.id === updated.id);
          return exists ? prev.map((c) => (c.id === updated.id ? updated : c)) : [updated, ...prev];
        });
      } catch { /* ignore */ }
    });
    return () => { alive = false; stream.close(); };
  }, [activeProfile?.personaId, adminChat]);

  const send = async (message: string) => {
    if (!configuration) return;
    if (!adminChat && isHandoffPhrase(message)) {
      void startHandoff(message);
    }
    await exclusive(async () => {
      const target = chat ?? await createConversation(activeProfile?.personaId ?? configuration.defaultPersonaId, configuration.defaultScenarioId, domainPack.id);
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
        ? chat : await createConversation(activeProfile.personaId, configuration.defaultScenarioId, domainPack.id);
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
    const row = await createConversation(personaId, scenarioId, domainPack.id);
    if (domainPack.id === "wealth" && signedInProfileId && signedInProfileId !== row.personaId) {
      if (!saveProfileSession(row.personaId)) throw new Error("Couldn’t switch profiles in this tab. Please try again.");
      setSignedInProfileId(row.personaId);
    }
    revealChat(row);
  });
  const changeConversation = async (id: string, change: ConversationChange) => exclusive(async () => {
    const updated = await api.changeConversation(id, change);
    remember(updated);
    setConversation((current) => current?.id === id ? { ...current, ...updated, archivedAt: updated.archivedAt } : current);
    if (change.operation === "archive" && readActiveConversation(adminChat, domainPack.id) === id) {
      rememberActiveConversation(null, adminChat, domainPack.id);
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
  const signOut = async () => {
    try { await api.selectProfile(null); }
    catch { setNotice("Couldn’t sign out. Please try again."); return; }
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
      } else if (data.type === "cep:screen_context" && typeof payload.label === "string" && payload.label.trim()) {
        setScreenContext({
          id: typeof payload.id === "string" ? payload.id : "screen",
          label: payload.label.trim(),
          viewType: typeof payload.viewType === "string" ? payload.viewType : "host_view",
          summary: typeof payload.summary === "string" ? payload.summary : "",
          metrics: Array.isArray(payload.metrics) ? (payload.metrics as { label: string; value: string }[]).slice(0, 4) : [],
          suggestedActions: Array.isArray(payload.suggestedActions)
            ? (payload.suggestedActions as { label: string; prompt: string }[]).slice(0, 4)
            : [],
        });
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
    setProactiveAlert(null);
    if (adminChat || !activeProfile) return;
    let alive = true;
    const stream = new EventSource("/api/proactive/stream?personaId=" + encodeURIComponent(activeProfile.personaId));
    stream.addEventListener("proactive.alert", (evt) => {
      if (!alive) return;
      try {
        const alert = JSON.parse((evt as MessageEvent).data) as ProactiveAlert;
        if (alert.domain !== domainPack.id) return;
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
  }, [activeProfile?.personaId, adminChat, domainPack.id]);

  const modelStatus = adminChat
    ? (configuration?.gatewayConfigured ? "Model connected" : "Model offline")
    : configuration?.gatewayConfigured ? (configuration.copilotModel || configuration.openAiModel
      ? `Live · ${configuration.copilotModel ?? configuration.openAiModel}` : "Live Advisory") : "Model offline";
  const managedThread = panel?.kind === "thread" ? visibleConversations.find(({ id }) => id === panel.id) : undefined;
  const canRunRailActions = Boolean(configuration) && !pending && latest?.status !== "working";

  return <div className={"app-layout" + (embedMode ? " embed-layout" : "") + (railCollapsed ? " rail-collapsed" : "")}>
    {!embedMode && railOpen && <button className="rail-scrim" aria-label="Close conversations" onClick={() => setRailOpen(false)} />}
    {!embedMode && <aside className={"rail" + (railOpen ? " rail-open" : "")} id="conversation-rail" aria-label="Workspace navigation">
      <div className="rail-header">
        <a className="rail-home" href={adminChat ? adminPaths.tools : domainPack.path}>
          <LabMark />
          <span className="rail-brand-text">
            <strong>{adminChat ? "Administration" : "CEP"}</strong>
            {!adminChat && <small>{domainPack.label}</small>}
          </span>
        </a>
        <button className="icon-button rail-collapse-desktop" type="button" aria-label="Collapse sidebar" title="Collapse sidebar"
          onClick={() => setRailCollapsed(true)}><PanelLeftClose size={17} aria-hidden="true" /></button>
        <button className="icon-button rail-close" ref={railClose} aria-label="Close conversation navigation" onClick={() => setRailOpen(false)}><X size={20} /></button>
      </div>
      <button ref={newThreadTrigger} type="button" className="new-conversation" disabled={pending || !configuration} onClick={startFreshChat}>
        <Plus size={17} aria-hidden="true" />New conversation
      </button>
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
    <main
      className="workspace"
      inert={railOpen}
      data-expertise={expertiseMode}
      data-cep-active={wealthDomContextJson ? "true" : undefined}
      data-cep-context={wealthDomContextJson}
    >
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
              {adminChat ? "Admin chat" : (domainPack.id === "wealth" ? (activeProfile?.displayName ?? "Workspace") : domainPack.label)}
              <ChevronRight size={13} aria-hidden="true" />
            </span>
            <h1>{chat?.title ?? "Overview"}</h1>
          </div>
          {domainPack.id === "wealth" && (
            <div className="topbar-center">
              <WorkspaceMenu pins={pins} section={activeSection} onSelect={setSection} onCustomize={() => openPanel({ kind: "pins" })}
                trigger={customizeTrigger} disabled={!configuration} />
            </div>
          )}
          <div className="topbar-actions">
            {!adminChat && (
              <ChatToolsMenu
                expertiseMode={expertiseMode}
                onChangeExpertise={changeExpertiseMode}
                futuresOpen={futuresOpen}
                onToggleFutures={() => setFuturesOpen((v) => !v)}
                watchCount={watchcards.length}
                watchTriggered={watchcards.some((w) => w.status === "triggered")}
                onToggleWatch={() => setWatchCreatorOpen((v) => !v)}
                onOpenDelegate={() => setDelegateOpen(true)}
                gatewayConfigured={Boolean(configuration?.gatewayConfigured)}
                memoryCount={memoryItems.length}
                onOpenMemory={() => { setMemoryOpen(true); void loadMemory(); }}
                handoffActive={Boolean(activeHandoff)}
                onStartHandoff={() => void startHandoff()}
              />
            )}
            <ThemeToggle compact />
            {adminChat && configuration && (
              <span className="model-status" data-connected={configuration.gatewayConfigured}>
                <span aria-hidden="true" />{modelStatus}
              </span>
            )}
          </div>
        </header>
      )}
      {embedMode && screenContext && !ambientDismissed && (
        <section className="embed-ambient-bar" aria-label="Your snapshot and suggestions">
          <div className="embed-ambient-top">
            <div className="embed-ambient-title">
              <span className="embed-ambient-pill">
                <Sparkles size={12} aria-hidden="true" />
                For you
              </span>
              <strong>{screenContext.label}</strong>
            </div>
            <div className="embed-ambient-right">
              {screenContext.metrics && screenContext.metrics.length > 0 && (
                <div className="embed-ambient-metrics">
                  {screenContext.metrics.map((m) => (
                    <span key={`${m.label}-${m.value}`} className="embed-ambient-metric">
                      {m.label}: <b>{m.value}</b>
                    </span>
                  ))}
                </div>
              )}
              {!embedMode && (
                <button
                  type="button"
                  className="icon-button embed-ambient-close"
                  aria-label="Hide suggestions"
                  title="Hide suggestions"
                  onClick={() => setAmbientDismissed(true)}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
          {screenContext.summary && <p className="embed-ambient-summary">{screenContext.summary}</p>}
          {screenContext.suggestedActions && screenContext.suggestedActions.length > 0 && (
            <div className="embed-ambient-actions">
              {screenContext.suggestedActions.map((act) => (
                <button
                  key={act.label}
                  type="button"
                  className="embed-ambient-action-btn"
                  disabled={pending || !configuration || latest?.status === "working"}
                  onClick={() => void send(act.prompt)}
                >
                  <Sparkles size={12} aria-hidden="true" />
                  {act.label}
                </button>
              ))}
            </div>
          )}
        </section>
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
            void (adminChat ? api.adminBootstrap(domainPack.id) : api.bootstrap(domainPack.id)).then((fresh) => {
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
        }}
        activeHandoff={activeHandoff}
        onStartHandoff={(reason) => void startHandoff(reason)}
        onDismissHandoff={() => setActiveHandoff(null)}
        onOpenMemory={() => { setMemoryOpen(true); void loadMemory(); }}
        expertiseMode={expertiseMode}
        futuresOpen={futuresOpen}
        onToggleFutures={(open) => setFuturesOpen((v) => (open === undefined ? !v : open))}
        watchcards={watchcards}
        onWatchcardsChange={setWatchcards}
        watchCreatorOpen={watchCreatorOpen}
        onToggleWatchCreator={(open) => setWatchCreatorOpen((v) => (open === undefined ? !v : open))}
        onOpenDelegate={() => setDelegateOpen(true)} />
    </main>
    <ConsumerA2aDrawer
      open={delegateOpen}
      personaId={activeProfile?.personaId ?? configuration?.defaultPersonaId ?? "demo-learner"}
      onClose={() => setDelegateOpen(false)}
    />
    <MemoryDrawer
      open={memoryOpen}
      items={memoryItems}
      loading={memoryLoading}
      error={memoryError}
      onClose={() => setMemoryOpen(false)}
      onSave={async (kind, content) => {
        const res = await api.memorySave({ kind, content });
        setMemoryItems(res.items);
      }}
      onForget={async (id) => {
        const res = await api.memoryForget(id);
        setMemoryItems(res.items);
      }}
    />
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
document.title = (adminChat ? "Admin chat" : "Assistant") + " · CEP";
root.render(<App />);
