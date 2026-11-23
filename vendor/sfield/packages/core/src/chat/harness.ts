import { SFieldError } from "../errors.js";
import type { JsonObject } from "../types/common.js";
import type { ExecutionPersistence, MessageRecord } from "../types/persistence.js";
import { digestJson, nowIso } from "../util/digest.js";

/** The host supplies these identifiers from its authenticated user, session, and thread. */
export interface ChatScope {
  tenantId: string;
  userId: string;
  sessionId: string;
  threadId: string;
}

export interface ChatMessageInput {
  /** Reuse this ID when retrying an append of the same message. */
  id?: string;
  role: "user" | "assistant";
  text: string;
  data?: JsonObject;
  createdAt?: string;
  expiresAt?: string;
}

export interface ChatThread {
  id: string;
  append(message: ChatMessageInput): Promise<MessageRecord>;
  history(options?: { limit?: number; before?: number }): Promise<MessageRecord[]>;
}

const chatAgent = "sfield-chat";
const retained = "9999-12-31T23:59:59.999Z";

/** Stores the customer-facing transcript over the same persistence used by the agent runtime. */
export class ChatHarness {
  constructor(private readonly persistence: Pick<ExecutionPersistence, "createConversation" | "appendMessage" | "listMessages">) {}

  async open(scope: ChatScope): Promise<ChatThread> {
    const { tenantId, userId, sessionId, threadId } = scope;
    if (![tenantId, userId, sessionId, threadId].every((value) => typeof value === "string" && value.trim())) {
      throw new SFieldError("INVALID_INPUT", "Chat scope requires a tenant, user, session, and thread.");
    }
    const subjectId = digestJson([chatAgent, userId, sessionId]);
    const id = "chat_" + digestJson([tenantId, subjectId, threadId]).slice("sha256:".length);
    const at = nowIso();
    const thread = await this.persistence.createConversation({
      id, tenantId, subjectId, agentId: chatAgent, createdAt: at, updatedAt: at, messageCount: 0,
    });
    if (thread.deletedAt || thread.subjectId !== subjectId || thread.tenantId !== tenantId || thread.agentId !== chatAgent) {
      throw new SFieldError("NOT_FOUND", "This chat thread is unavailable.");
    }
    return {
      id,
      append: (message) => this.persistence.appendMessage({
        id: message.id, conversationId: id, tenantId, role: message.role,
        content: { text: message.text, ...(message.data && { data: message.data }) },
        createdAt: message.createdAt ?? nowIso(), expiresAt: message.expiresAt ?? retained,
      }),
      history: (options = {}) => this.persistence.listMessages(id, options),
    };
  }
}
