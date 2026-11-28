/**
 * Chat message primitives: StarterPrompts, UserMessage, NbaCompanionCard, AssistantMessage.
 * Extracted from `apps/web/main.tsx` for clean UI separation of concerns.
 */
import { useContext, useEffect, useRef, useState } from "react";
import { MessagePrimitive, useAui, useAuiState } from "@assistant-ui/react";
import {
  ArrowUpRight, BookOpenText, Check, Columns2, GraduationCap, House, ListChecks, MapPin,
  PanelRightOpen, Pin, RotateCcw, Sparkles, ThumbsDown, ThumbsUp,
} from "lucide-react";
import { progressLabels, type NextBestActionCard, type TurnView } from "../../../packages/contracts/api";
import { api } from "../api";
import { TurnRichActions } from "../chat-rich-ux";
import { SpeakButton } from "../composer-extras";
import { ProfileAvatar } from "../demo-profiles";
import { LabMark } from "../lab-mark";
import { LiveGroundingBar } from "../live-grounding";
import { ExpertiseTurnBanner } from "../nextgen-chat-features";
import { ReasoningPanel } from "../reasoning-panel";
import { LiveReplyContext } from "../surface";
import { ConversationControls, homeGoalPrompt, timeFormat } from "./chat-context";

export function StarterPrompts({ disabled, adminChat }: { disabled: boolean; adminChat: boolean }) {
  const aui = useAui();
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
  return (
    <div className="starter-strip">
      <div className="starter-strip-header">
        <span className="starter-strip-label">
          <Sparkles size={12} aria-hidden="true" />
          Suggested questions
        </span>
      </div>
      <div className="composer-starters" role="group" aria-label="Suggested questions">
        {starters.map(({ Icon, label, message }) => (
          <button key={label} type="button" className="starter" disabled={disabled} onClick={() => aui.thread().append(message)}>
            <Icon size={14} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function UserMessage() {
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

export function NbaCompanionCard({ nba, personaId, disabled, onRunPrompt, onPreviewFunding }: {
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

function ReplyIndicator({ label }: { label: string }) {
  return <div className="reply-indicator" role="status">
    <span className="sr-only">{label}</span>
    <span className="reply-dots" aria-hidden="true"><span /><span /><span /></span>
  </div>;
}

function ReplyLoading() {
  const [showPlaceholder, setShowPlaceholder] = useState(false);
  useEffect(() => {
    // A fast answer can replace the indicator without flashing a skeleton.
    const timer = setTimeout(() => setShowPlaceholder(true), 220);
    return () => clearTimeout(timer);
  }, []);
  return <div className="reply-loading">
    <ReplyIndicator label="Preparing your reply." />
    {showPlaceholder && <div className="reply-skeleton" aria-hidden="true">
      <span className="skeleton-title" />
      <span className="skeleton-value" />
      <div className="skeleton-detail"><span /><span /></div>
    </div>}
  </div>;
}

function ReplyText() {
  const text = useAuiState(({ part }) => part.type === "text" ? part.text : "");
  return text ? <p className="assistant-reply-text">{text}</p> : null;
}

const replyParts = { Text: ReplyText };

export function AssistantMessage() {
  const turn = useAuiState((state) => state.message.metadata.custom?.turn as TurnView | undefined);
  const {
    latest, pending, adminChat, activeProfile, progressHistory, expertiseMode, pinnedTurnId, pinnedMenuTurnIds,
    pinCanvas, clipToMenu, branchTurn, retry, feedback, followTurn, runPrompt, previewFunding,
  } = useContext(ConversationControls);
  const element = useRef<HTMLDivElement>(null);
  const [arrivedLive] = useState(turn?.status === "working");
  const turnId = turn?.id;
  const latestId = latest?.id;
  const replyReady = Boolean(turn && (turn.status !== "working" || turn.previewExperience));
  const goalSourceTurnId = turn?.goalScenario?.sourceTurnId;
  useEffect(() => {
    if (!element.current || !turnId || turnId !== latestId) return;
    return followTurn(turnId, element.current, replyReady, goalSourceTurnId);
  }, [followTurn, latestId, turnId, replyReady, goalSourceTurnId]);
  if (!turn) return null;
  const experience = turn.experience;
  const steps = progressHistory[turn.id] ?? [turn.progress];
  const recommendation = experience?.blocks.some((block) => block.component === "PznContentCard" && block.props.recommendation);
  const companion = !adminChat && turn.status === "completed" && turn.nextBestAction && (
    <NbaCompanionCard
      nba={turn.nextBestAction}
      personaId={activeProfile?.personaId}
      disabled={pending}
      onRunPrompt={runPrompt}
      onPreviewFunding={previewFunding}
    />
  );

  return (
    <MessagePrimitive.Root ref={element} className="assistant-message"
      data-live-reply={arrivedLive && (turn.previewExperience || turn.status === "completed") && !adminChat ? "" : undefined}>
      <div className="stream-assistant-row">
        <LabMark small />
        <div className="assistant-content">
          <header className="stream-meta-line">
            <strong>Your assistant</strong>
            <span className="turn-meta">{timeFormat.format(new Date(turn.createdAt))}</span>
          </header>

          {turn.status === "working" && (
            adminChat ? <>
              <span className="sr-only" role="status">{progressLabels[turn.progress]}</span>
              <ReasoningPanel status={turn.status} progress={turn.progress} history={steps} />
            </> : <>
              <LiveGroundingBar steps={steps} working={true} hasPreview={Boolean(turn.previewExperience)} />
              {!turn.previewExperience && <ReplyLoading />}
            </>
          )}
          {!adminChat && arrivedLive && turn.status === "completed" && steps.length > 1 && (
            <LiveGroundingBar steps={steps} working={false} />
          )}
          {adminChat && steps.length > 0 && turn.status === "completed" && (
            <ReasoningPanel
              status={turn.status}
              progress={turn.progress}
              history={steps}
              experience={experience}
              actionMode={turn.actionMode}
              semanticRoute={turn.semanticRoute}
              customerLookup={turn.customerLookup}
              emotionalState={turn.emotionalState}
              providerArbitration={turn.providerArbitration}
              piiRedaction={turn.piiRedaction}
            />
          )}
          {!adminChat && turn.status === "completed" && (
            <ExpertiseTurnBanner mode={expertiseMode} turn={turn} />
          )}
          <LiveReplyContext.Provider value={arrivedLive && !adminChat}>
            {(turn.status !== "working" || turn.previewExperience) && <MessagePrimitive.Parts components={replyParts} />}
          </LiveReplyContext.Provider>
          {!adminChat && turn.status === "working" && turn.previewExperience && <ReplyIndicator label="Checking for recommendations." />}
          {!recommendation && companion}

          {turn.status === "completed" && latest?.id === turn.id && <span className="sr-only" role="status">Response ready.</span>}
          {(turn.status === "failed" || turn.status === "cancelled") && latest?.id === turn.id && (
            <button type="button" disabled={pending} className="secondary-button retry" onClick={() => retry(turn.id)}>
              <RotateCcw size={15} />Retry
            </button>
          )}
          {experience?.status === "ready" && experience.outcome !== "create_rule" && (
            <footer className="reply-footer">
              <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                {experience.blocks.length > 0 && (
                  <>
                    <button
                      type="button"
                      className={"reply-canvas-btn" + (pinnedTurnId === turn.id ? " is-active" : "")}
                      aria-pressed={pinnedTurnId === turn.id}
                      onClick={() => pinCanvas(turn)}
                    >
                      <PanelRightOpen size={13} aria-hidden="true" />
                      {pinnedTurnId === turn.id ? "In Living Canvas" : "Open in Canvas"}
                    </button>
                    {!adminChat && clipToMenu && (() => {
                      const alreadyPinned = Boolean(pinnedMenuTurnIds?.has(turn.id));
                      return (
                        <button
                          type="button"
                          className={"reply-canvas-btn" + (alreadyPinned ? " is-active" : "")}
                          aria-pressed={alreadyPinned}
                          title={alreadyPinned ? "Pinned permanently in your Main Menu as a live card" : "Clip this UI card permanently to your Main Menu (stays live)"}
                          onClick={() => clipToMenu(turn)}
                        >
                          {alreadyPinned ? <Check size={13} aria-hidden="true" /> : <Pin size={13} aria-hidden="true" />}
                          {alreadyPinned ? "Pinned to Menu" : "Pin to Menu"}
                        </button>
                      );
                    })()}
                  </>
                )}
                <TurnRichActions
                  turn={turn}
                  pending={pending}
                  pinnedInCanvas={pinnedTurnId === turn.id}
                  onPinCanvas={pinCanvas}
                  onReframe={runPrompt}
                  onBranch={branchTurn}
                >{recommendation && companion}</TurnRichActions>
              </div>
              <div className="feedback-controls" role="group" aria-label="Response feedback">
                <SpeakButton text={experience.question ?? experience.intro} />
                <span className="feedback-label">Was this helpful?</span>
                <button className="icon-button" type="button" aria-label="Helpful" aria-pressed={turn.feedback === "helpful"}
                  onClick={() => feedback(turn.id, experience.experienceId, "helpful")}><ThumbsUp size={15} /></button>
                <button className="icon-button" type="button" aria-label="Unhelpful" aria-pressed={turn.feedback === "unhelpful"}
                  onClick={() => feedback(turn.id, experience.experienceId, "unhelpful")}><ThumbsDown size={15} /></button>
              </div>
            </footer>
          )}
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}
