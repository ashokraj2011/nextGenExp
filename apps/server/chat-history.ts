import type { ChatHarness, ChatThread, JsonObject, MessageRecord } from "@sfield/core";
import type { TurnView } from "../../packages/contracts/api";
import {
  ROUTING_HISTORY_TURNS, ROUTING_HISTORY_REQUEST_LENGTH, ROUTING_HISTORY_REPLY_LENGTH,
  type RoutingHistoryEntry, type RoutingIntentId,
} from "../../packages/contracts/routing-intents";
import { displayedRecordChoices } from "./record-context";
import { dynamicCanvasSchema } from "../../packages/contracts/dynamic-canvas";
import type { DisplayBlock } from "../../packages/contracts/surface";
import type { ConversationRecord, Store, TurnRecord } from "./store";

function displayTitle({ component, props }: DisplayBlock) {
  if ("title" in props) return props.title;
  switch (component) {
    case "PznFundingOptions": return "Funding options";
    case "PznFundingPreview": return "Funding preview";
    case "PznPortfolioSnapshot": return "Portfolio snapshot";
    case "PznRuleCreation": return "Rule editor";
  }
}

function messageId(turnId: string, role: "user" | "assistant") {
  return turnId + ":" + role;
}

function transcriptMessage(
  messages: Map<string, MessageRecord>, turnId: string, role: "user" | "assistant",
): { text: string; data: JsonObject } {
  const message = messages.get(messageId(turnId, role));
  const content = message?.content;
  if (message?.role !== role || !content || typeof content !== "object" || Array.isArray(content) || typeof content.text !== "string") {
    throw new Error("The chat transcript is incomplete.");
  }
  const { text, data } = content;
  return { text, data: data && typeof data === "object" && !Array.isArray(data) ? data : {} };
}

export type PendingClarificationState = {
  turnId: string;
  originalPrompt: string;
  question: string;
  choices: Array<{ id: string; label: string; prompt?: string }>;
};

export function resolveClarificationReply(
  reply: string,
  pending: PendingClarificationState | null | undefined,
): { matchedPrompt: string; matchedLabel: string } | null {
  if (!pending || !pending.choices.length) return null;
  const clean = reply.trim().toLowerCase().replace(/[.!?]+$/, "");
  if (!clean || clean.length > 90) return null;

  const ordinalWords: Record<string, number> = {
    "1": 0, "first": 0, "first one": 0, "1st": 0, "option 1": 0, "the first": 0, "the first one": 0, "yes": 0,
    "2": 1, "second": 1, "second one": 1, "2nd": 1, "option 2": 1, "the second": 1, "the second one": 1,
    "3": 2, "third": 2, "third one": 2, "3rd": 2, "option 3": 2, "the third": 2, "the third one": 2,
    "4": 3, "fourth": 3, "fourth one": 3, "4th": 3, "option 4": 3, "the fourth": 3, "the fourth one": 3,
  };
  if (clean in ordinalWords) {
    const choice = pending.choices[ordinalWords[clean]!];
    if (choice) return { matchedPrompt: choice.prompt ?? choice.label, matchedLabel: choice.label };
  }

  // Match concise keyword reply against one of the offered choices (e.g. "stocks", "pie chart", "home goal", "table")
  const tokens = clean.split(/\s+/).filter((t) => t.length >= 3 && !["the", "show", "just", "only", "please", "want", "one", "that", "this", "for", "with"].includes(t));
  if (tokens.length === 0 || tokens.length > 5) return null;
  let best: { choice: PendingClarificationState["choices"][number]; score: number } | null = null;
  for (const choice of pending.choices) {
    const hay = `${choice.label} ${choice.prompt ?? ""} ${choice.id}`.toLowerCase();
    const score = tokens.reduce((acc, tok) => {
      const stem = tok.length >= 4 && tok.endsWith("s") ? tok.slice(0, -1) : tok;
      return acc + (hay.includes(tok) || hay.includes(stem) ? 1 : 0);
    }, 0);
    if (score > 0 && (!best || score > best.score)) best = { choice, score };
  }
  if (best && best.score >= Math.min(tokens.length, 1) && best.score / tokens.length >= 0.5) {
    return { matchedPrompt: best.choice.prompt ?? best.choice.label, matchedLabel: best.choice.label };
  }
  return null;
}

/** Maps PZN's authenticated profile and browser session onto a durable sfield thread. */
export class PznChatHistory {
  constructor(private readonly store: Store, private readonly harness: ChatHarness) {}

  private async sync(conversation: ConversationRecord, turns: TurnRecord[]) {
    const thread = await this.harness.open({
      tenantId: conversation.tenantId, domainId: conversation.legacyTranscript ? undefined : conversation.domainId,
      userId: conversation.legacyTranscript ? conversation.personaId : conversation.userId, sessionId: conversation.principalId, threadId: conversation.id,
    });
    for (const turn of turns) {
      if (turn.historyStatus === turn.public.status) continue;
      await this.record(thread, turn);
      this.store.markHistoryStatus(turn.public.id, turn.public.status);
    }
    return thread;
  }

  private async record(thread: ChatThread, turn: TurnRecord) {
    const { id, message, createdAt, status, experience } = turn.public;
    await thread.append({
      id: messageId(id, "user"), role: "user", text: message, createdAt: new Date(createdAt).toISOString(),
      data: { turnId: id, sessionId: turn.requestSessionId ?? turn.scope.principalId },
    });
    if (status !== "completed" || !experience) return;
    await thread.append({
      id: messageId(id, "assistant"), role: "assistant",
      text: experience.question ?? (experience.intro || experience.blocks.map(displayTitle).find(Boolean) || ""),
      createdAt: new Date(turn.trace.markers.terminal ?? createdAt).toISOString(),
      data: {
        turnId: id, question: experience.question, intro: experience.intro,
        ...(turn.public.interactiveExperience && { interactiveExperience: JSON.parse(JSON.stringify(turn.public.interactiveExperience)) }),
        contextId: turn.route?.contextId ?? null, intentId: turn.trace.intentId ?? null,
        displayedChoices: displayedRecordChoices(experience.blocks),
        displayedContent: experience.blocks.flatMap((block) => {
          const title = displayTitle(block);
          return title ? [title] : [];
        }),
      },
    });
  }

  async flush(conversation: ConversationRecord) {
    await this.sync(conversation, this.store.conversationTurns(conversation.id));
  }

  private async read(conversation: ConversationRecord) {
    const turns = this.store.conversationTurns(conversation.id);
    const thread = await this.sync(conversation, turns);
    const messages = new Map((await thread.history()).map((message) => [message.id, message]));
    return { turns, messages };
  }

  async turns(conversation: ConversationRecord): Promise<TurnView[]> {
    const { turns, messages } = await this.read(conversation);
    const watches = new Map(this.store.watches(conversation).map((watch) => [watch.id, watch]));
    return turns.map(({ public: stored, interactiveWatchId }): TurnView => {
      const watch = interactiveWatchId && watches.get(interactiveWatchId);
      const state = stored.interactiveExperience;
      const turn: TurnView = watch && state?.completion ? {
        ...stored, interactiveExperience: { ...state, state: watch.state, completion: { label: state.completion.label, value: watch.value } },
      } : stored;
      const request = transcriptMessage(messages, turn.id, "user");
      if (!turn.experience) return { ...turn, message: request.text };
      const { text, data } = transcriptMessage(messages, turn.id, "assistant");
      const question = typeof data.question === "string" ? text : null;
      const intro = typeof data.intro === "string" ? data.intro : text;
      const [surface] = turn.experience.messages;
      return {
        ...turn, message: request.text,
        experience: {
          ...turn.experience, intro, question,
          messages: [{
            ...surface,
            createSurface: {
              ...surface.createSurface,
              dataModel: { ...surface.createSurface.dataModel, intro },
              components: surface.createSurface.components?.map((node) => (
                node.id === "root" && node.component === "PznExperience" ? { ...node, question } : node
              )),
            },
          }],
        },
      };
    });
  }

  async recent(conversation: ConversationRecord, beforeOrdinal: number): Promise<RoutingHistoryEntry[]> {
    const { turns, messages } = await this.read(conversation);
    return turns
      .filter(({ public: turn, ordinal }) => turn.status === "completed" && turn.experience && ordinal < beforeOrdinal)
      .slice(-ROUTING_HISTORY_TURNS)
      .map(({ public: turn }) => {
        const request = transcriptMessage(messages, turn.id, "user");
        const { text, data } = transcriptMessage(messages, turn.id, "assistant");
        const clarificationQuestion = typeof data.question === "string" ? text : null;
        const displayedContent = Array.isArray(data.displayedContent) ? data.displayedContent.filter(
          (title): title is string => typeof title === "string",
        ) : [];
        const stored = dynamicCanvasSchema.shape.choices.safeParse(data.displayedChoices);
        const choices = (stored.success && stored.data) || displayedRecordChoices(turn.experience?.blocks);
        const context = [...displayedContent, ...choices.map(({ id, label }, index) => `${index + 1}. ${id} · ${label}`)];
        return {
          request: request.text.slice(0, ROUTING_HISTORY_REQUEST_LENGTH),
          contextId: typeof data.contextId === "string" ? data.contextId : null,
          intentId: typeof data.intentId === "string" ? data.intentId as RoutingIntentId : null,
          clarificationQuestion,
          assistantReply: clarificationQuestion ? undefined : text.slice(0, ROUTING_HISTORY_REPLY_LENGTH),
          displayedContent: context.length ? context : undefined,
        };
      });
  }

  async pendingClarification(conversation: ConversationRecord, beforeOrdinal: number): Promise<PendingClarificationState | null> {
    const turns = this.store.conversationTurns(conversation.id)
      .filter(({ public: turn, ordinal }) => turn.status === "completed" && turn.experience && ordinal < beforeOrdinal);
    const prev = turns[turns.length - 1];
    if (!prev?.public.experience) return null;
    const canvasBlock = prev.public.experience.blocks.find((b) => b.component === "PznDynamicCanvas");
    if (!canvasBlock || canvasBlock.component !== "PznDynamicCanvas") return null;
    const choices = canvasBlock.props.choices;
    if (!choices?.length || !choices.some((c) => Boolean(c.prompt))) return null;
    return {
      turnId: prev.public.id,
      originalPrompt: prev.public.message,
      question: prev.public.experience.intro,
      choices,
    };
  }

  async allCompletedForCompaction(conversation: ConversationRecord, upToOrdinal?: number) {
    const { turns, messages } = await this.read(conversation);
    return turns
      .filter(({ public: turn, ordinal }) => turn.status === "completed" && turn.experience && (upToOrdinal === undefined || ordinal <= upToOrdinal))
      .map(({ public: turn, ordinal }) => {
        const request = transcriptMessage(messages, turn.id, "user");
        const { text, data } = transcriptMessage(messages, turn.id, "assistant");
        const displayedContent = Array.isArray(data.displayedContent) ? data.displayedContent.filter(
          (title): title is string => typeof title === "string",
        ) : undefined;
        return {
          ordinal,
          turnId: turn.id,
          userMessage: request.text,
          assistantReply: text,
          intentId: typeof data.intentId === "string" ? data.intentId : null,
          displayedContent,
          clarificationQuestion: typeof data.question === "string" ? text : null,
        };
      });
  }
}
