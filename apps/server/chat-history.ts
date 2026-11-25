import type { ChatHarness, ChatThread, JsonObject, MessageRecord } from "@sfield/core";
import type { TurnView } from "../../packages/contracts/api";
import {
  ROUTING_HISTORY_TURNS, ROUTING_HISTORY_REQUEST_LENGTH, ROUTING_HISTORY_REPLY_LENGTH,
  type RoutingHistoryEntry, type RoutingIntentId,
} from "../../packages/contracts/routing-intents";
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
      data: { turnId: id },
    });
    if (status !== "completed" || !experience) return;
    await thread.append({
      id: messageId(id, "assistant"), role: "assistant", text: experience.question ?? experience.intro,
      createdAt: new Date(turn.trace.markers.terminal ?? createdAt).toISOString(),
      data: {
        turnId: id, question: experience.question, intro: experience.intro,
        contextId: turn.route?.contextId ?? null, intentId: turn.trace.intentId ?? null,
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
    return turns.map(({ public: turn }): TurnView => {
      const request = transcriptMessage(messages, turn.id, "user");
      if (!turn.experience) return { ...turn, message: request.text };
      const { text, data } = transcriptMessage(messages, turn.id, "assistant");
      const question = typeof data.question === "string" ? text : null;
      const intro = question && typeof data.intro === "string" ? data.intro : text;
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
        return {
          request: request.text.slice(0, ROUTING_HISTORY_REQUEST_LENGTH),
          contextId: typeof data.contextId === "string" ? data.contextId : null,
          intentId: typeof data.intentId === "string" ? data.intentId as RoutingIntentId : null,
          clarificationQuestion,
          assistantReply: clarificationQuestion ? undefined : text.slice(0, ROUTING_HISTORY_REPLY_LENGTH),
          displayedContent: displayedContent.length ? displayedContent : undefined,
        };
      });
  }
}
