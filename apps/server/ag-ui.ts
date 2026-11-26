/**
 * AG-UI (Agent-User Interaction Protocol) SSE transport adapter — item 3.2.
 *
 * Accepts a standard AG-UI RunAgentInput payload at POST /api/ag-ui and streams compliant AG-UI events:
 * RUN_STARTED -> TOOL_CALL_* -> TEXT_MESSAGE_START / CONTENT / END -> STATE_SNAPSHOT -> CUSTOM (cards/A2UI) -> RUN_FINISHED.
 */
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { GatewaySettings } from "./gateway";
import type { IntegrationTaskService } from "./integration-tasks";
import { runIntegrationCopilot } from "./integration-copilot";

export const agUiRunInputSchema = z.object({
  threadId: z.string().trim().min(1).max(120).optional(),
  runId: z.string().trim().min(1).max(120).optional(),
  state: z.record(z.string(), z.unknown()).optional(),
  messages: z.array(z.object({
    id: z.string().optional(),
    role: z.enum(["user", "assistant", "system", "tool"]),
    content: z.union([z.string(), z.array(z.unknown())]),
  })).min(1).max(50),
  agent: z.enum(["integrations"]).optional(),
}).passthrough();
export type AgUiRunInput = z.infer<typeof agUiRunInputSchema>;

function writeAgUiEvent(res: ServerResponse, event: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify({ timestamp: Date.now(), ...event })}\n\n`);
}

function extractText(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
    .join(" ")
    .trim();
}

export async function streamAgUiRun(
  res: ServerResponse,
  input: AgUiRunInput,
  deps: {
    integrationService: IntegrationTaskService;
    principalId: string;
    operatorName: string;
    gateway: GatewaySettings | null;
    dataDir: string;
  },
): Promise<void> {
  const threadId = input.threadId ?? `thr_${randomUUID().slice(0, 12)}`;
  const runId = input.runId ?? `agui_${randomUUID().slice(0, 12)}`;
  const messageId = `msg_${randomUUID().slice(0, 12)}`;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
  });

  writeAgUiEvent(res, { type: "RUN_STARTED", threadId, runId });

  try {
    const userMessages = input.messages.filter((m) => m.role === "user");
    const latestMessage = extractText(userMessages.at(-1)?.content ?? "");
    const history = input.messages
      .slice(0, -1)
      .filter((m): m is { role: "user" | "assistant"; content: string | unknown[] } => m.role === "user" || m.role === "assistant")
      .slice(-8)
      .map((m) => ({ role: m.role, text: extractText(m.content).slice(0, 1400) }));

    const result = await runIntegrationCopilot(
      { message: latestMessage || "Show integrations and tasks", history },
      deps.integrationService,
      deps.principalId,
      { operatorName: deps.operatorName, gateway: deps.gateway, dataDir: deps.dataDir },
    );

    // Emit AG-UI tool call lifecycle events for every governed step taken.
    for (const action of result.actions) {
      const toolCallId = `tc_${randomUUID().slice(0, 10)}`;
      writeAgUiEvent(res, { type: "TOOL_CALL_START", toolCallId, toolCallName: action.tool, parentMessageId: messageId });
      writeAgUiEvent(res, { type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify({ status: action.status }) });
      writeAgUiEvent(res, { type: "TOOL_CALL_END", toolCallId });
      writeAgUiEvent(res, { type: "TOOL_CALL_RESULT", toolCallId, messageId: `tr_${toolCallId}`, content: action.summary, role: "tool" });
    }

    // Stream assistant text message.
    writeAgUiEvent(res, { type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
    const reply = result.reply || "Done.";
    writeAgUiEvent(res, { type: "TEXT_MESSAGE_CONTENT", messageId, delta: reply });
    writeAgUiEvent(res, { type: "TEXT_MESSAGE_END", messageId });

    // Emit state snapshot & custom A2UI / card payload for AG-UI frontends (CopilotKit, custom renderers).
    writeAgUiEvent(res, {
      type: "STATE_SNAPSHOT",
      snapshot: {
        ...(input.state ?? {}),
        generatedBy: result.generatedBy,
        suggestedPrompts: result.suggestedPrompts,
        cardCount: result.cards.length,
      },
    });
    if (result.cards.length > 0) {
      writeAgUiEvent(res, {
        type: "CUSTOM",
        name: "cep.cards",
        value: { cards: result.cards },
      });
    }

    writeAgUiEvent(res, { type: "RUN_FINISHED", threadId, runId });
  } catch (err) {
    writeAgUiEvent(res, {
      type: "RUN_ERROR",
      message: err instanceof Error ? err.message : "AG-UI run failed.",
      code: "AG_UI_RUN_ERROR",
    });
  } finally {
    res.end();
  }
}
