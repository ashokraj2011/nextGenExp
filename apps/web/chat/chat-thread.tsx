/**
 * Main Chat thread view (assistant-ui runtime, hero/welcome stage, split live canvas / futures pane).
 * Extracted from `apps/web/main.tsx` so the root entry file owns only app shell & session state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import type { ActionMessage } from "@a2ui/web_core/v1_0";
import type { Bootstrap, ConversationView, DemoPersona, Progress, TurnView } from "../../../packages/contracts/api";
import type { DomainPack } from "../../../packages/contracts/domain-packs";
import type { HandoffTicket } from "../../../packages/contracts/handoff";
import type { ExpertiseMode, Watchcard } from "../../../packages/contracts/nextgen-chat";
import { pendingActionsContext, type WorkspacePin } from "../../../packages/contracts/workspace";
import { api } from "../api";
import { LiveCanvasPane, LiveHandoffCard } from "../chat-rich-ux";
import { computeNextSuggestions } from "../composer-extras";
import { DomainLiveHud, DomainWelcomeHome } from "../domain-pack-ui";
import { LivingWatchcardsStrip, ParallelFuturesPane } from "../nextgen-chat-features";
import { ExperienceControls, ExperienceDataUI } from "../surface";
import type { WorkspaceSection } from "../workspace-menu";
import { WorkspaceHome, WorkspaceOverview, type PendingActions } from "../workspace-overview";
import { Composer } from "./chat-composer";
import {
  ConversationControls, homeGoalPrompt, portfolioPrompt, visibleMessages,
  type ConversationOperations,
} from "./chat-context";
import { AssistantMessage, UserMessage } from "./chat-messages";

export type ChatProps = {
  adminChat: boolean;
  conversation?: ConversationView;
  configuration?: Bootstrap;
  pending: boolean;
  notice: string;
  activeProfile?: DemoPersona;
  pendingActions: PendingActions;
  section: WorkspaceSection;
  pins: WorkspacePin[];
  progressHistory: Record<string, Progress[]>;
  domainPack: DomainPack;
  onSelect: (section: WorkspaceSection) => void;
  onPreviewFunding: (source?: typeof pendingActionsContext) => void;
  onRestore: () => void;
  onWriteBack?: (updates: Record<string, string>) => Promise<string[]>;
  draft: string;
  onDraft: (value: string) => void;
  onSend: (text: string) => Promise<void>;
  onStop: () => Promise<void>;
  onRetry: (id: string) => void;
  onBranch: (turn: TurnView) => void;
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

export function Chat({
  adminChat, conversation, configuration, activeProfile, pendingActions, pending, draft, onDraft, onSend, onStop, onRetry,
  onBranch, onFollowUp, onFeedback, notice, section, pins, progressHistory, domainPack, onSelect, onPreviewFunding,
  onRestore, onWriteBack, activeHandoff, onStartHandoff, onDismissHandoff, onOpenMemory, expertiseMode, futuresOpen,
  onToggleFutures, watchcards, onWatchcardsChange, watchCreatorOpen, onToggleWatchCreator, onOpenDelegate,
}: ChatProps) {
  const turns = conversation?.turns ?? noTurns;
  const latest = turns.at(-1);
  const running = turns.some((t) => t.status === "working");
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
  const lastScrolledConvId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const convId = conversation?.id;
    if (!convId || turns.length === 0) return;
    if (lastScrolledConvId.current === convId) return;
    lastScrolledConvId.current = convId;
    lastAnchor.current = latest?.id;
    const scrollToEnd = () => {
      const scroll = viewport.current;
      if (!scroll) return;
      scroll.scrollTo({ top: scroll.scrollHeight, behavior: "smooth" });
    };
    const raf1 = requestAnimationFrame(() => requestAnimationFrame(scrollToEnd));
    const timer = setTimeout(scrollToEnd, 140);
    return () => {
      cancelAnimationFrame(raf1);
      clearTimeout(timer);
    };
  }, [conversation?.id, turns.length, latest?.id]);
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
  </div> : <Composer draft={draft} onDraft={onDraft} running={running} pending={pending} disabled={!configuration} adminChat={adminChat} input={input}
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
        latest, pending, adminChat, activeProfile, progressHistory, expertiseMode, pinnedTurnId,
        pinCanvas: (t) => { onToggleFutures(false); pinCanvas(t); },
        branchTurn: onBranch, retry: onRetry, feedback: onFeedback, anchorTurn,
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
