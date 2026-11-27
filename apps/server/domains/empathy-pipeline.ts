/**
 * Empathy & life-event detection pipeline for wealth conversations.
 * Runs `cep.empathy.assess@1.0.0` via sfield and persists newly disclosed major life events
 * to both Customer 360 notes and `sfield.memory`.
 */
import type { EmotionalAssessment } from "../../../packages/contracts/empathy";
import { findProfileById, type CustomerProfileStore } from "../../../packages/customer-profiles";
import type { Runtime } from "../runtime";
import type { ConversationRecord, Store, TurnRecord } from "../store";

export interface RecentHistoryEntry {
  request: string;
  assistantReply?: string | null;
  clarificationQuestion?: string | null;
}

export async function runEmpathyAssessmentPipeline(args: {
  turnId: string;
  initialTurn: TurnRecord;
  conversation: ConversationRecord;
  scopedPrompt: string;
  recentForRoute: RecentHistoryEntry[];
  hasRetirementHistory: boolean;
  runtime: Runtime;
  store: Store;
  profileStore?: CustomerProfileStore;
  signal: AbortSignal;
}): Promise<EmotionalAssessment | undefined> {
  const {
    turnId, initialTurn, conversation, scopedPrompt, recentForRoute,
    hasRetirementHistory, runtime, store, profileStore, signal,
  } = args;

  if (conversation.domainId !== "wealth") return undefined;

  try {
    const liveProfile = profileStore?.findByPersonaId(conversation.personaId) ?? findProfileById(conversation.personaId);
    const shortRecent = recentForRoute
      .slice(-2)
      .map((entry) => `${entry.request} -> ${entry.assistantReply ?? entry.clarificationQuestion ?? ""}`)
      .join(" | ");

    const emotionalState = await runtime.assessEmotionalState(
      initialTurn.scope.principalId,
      initialTurn.scope,
      {
        personaId: conversation.personaId,
        userMessage: scopedPrompt,
        ordinal: initialTurn.ordinal,
        ...(shortRecent ? { recentSummary: shortRecent } : {}),
        ...(liveProfile?.notes ? { customerNotes: liveProfile.notes } : {}),
        hasRetirementHistory,
      },
      signal,
    );

    store.update(turnId, (row) => {
      row.public.emotionalState = emotionalState;
    });

    if (emotionalState.fromCurrentMessage && emotionalState.customerNoteToSave) {
      const savedNote = profileStore?.appendNote(conversation.personaId, emotionalState.customerNoteToSave);
      if (savedNote?.added) {
        void runtime.rememberMemory(initialTurn.scope.principalId, {
          kind: "fact",
          content: emotionalState.customerNoteToSave,
          key: `life_event:${emotionalState.lifeEvent}`,
          origin: "trusted_source",
        }).catch(() => undefined);
      }
    }
    return emotionalState;
  } catch {
    // Emotional assessment is best-effort and must never fail a turn.
    return undefined;
  }
}
