import { Scrubber } from "@sfield/core";
import type { CompiledModelRequest, JsonValue, ModelStreamEvent, NeutralMessage } from "@sfield/core";
import type { GatewayExchange, InspectorPayload } from "../../packages/contracts/inspector";

const payloadLimit = 96 * 1024;
type AssistantMessage = Extract<NeutralMessage, { role: "assistant" }>;
type ModelOutcome = Extract<ModelStreamEvent, { type: "done" | "error" }>;

export function assistantResponse(message: AssistantMessage): JsonValue {
  const text = message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
  const toolCalls = message.parts.flatMap((part) => part.type === "tool_call" ? [{
    id: part.providerCallId ?? part.callId,
    name: part.alias,
    arguments: part.arguments,
  }] : []);
  return { role: "assistant", content: text || null, ...(toolCalls.length ? { toolCalls } : {}) };
}

export function createPayloadCapture(secrets: string[], customFields: string[]) {
  const scrubber = new Scrubber(secrets.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]));

  function scrubNestedJson(value: JsonValue): JsonValue {
    if (typeof value === "string" && /^\s*[\[{]/.test(value)) {
      try {
        const decoded = JSON.parse(value) as JsonValue;
        const safe = JSON.stringify(scrubber.scrubValue(decoded));
        return safe === JSON.stringify(decoded) ? value : safe;
      } catch {
        return value;
      }
    }
    if (Array.isArray(value)) return value.map(scrubNestedJson);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, scrubNestedJson(child)]));
    }
    return value;
  }

  function payload(data: JsonValue): InspectorPayload {
    const bytes = Buffer.byteLength(JSON.stringify(data));
    return bytes > payloadLimit ? { bytes } : { bytes, data: scrubNestedJson(scrubber.scrubValue(data)) };
  }

  function exchange(request: CompiledModelRequest, outcome: ModelOutcome | undefined, source: GatewayExchange["source"]): GatewayExchange {
    const bytes = Buffer.byteLength(request.body);
    let capturedRequest: InspectorPayload = { bytes };
    if (bytes <= payloadLimit) {
      const body = JSON.parse(request.body);
      for (const field of customFields) if (Object.hasOwn(body, field)) body[field] = "[REDACTED]";
      capturedRequest = { ...payload(body), bytes };
    }
    const response: JsonValue | undefined = outcome?.type === "done" ? {
      message: assistantResponse(outcome.message),
      stopReason: outcome.stopReason,
      usage: { ...outcome.usage },
    } : outcome?.type === "error" ? { error: { ...outcome.error } } : undefined;
    return {
      source, method: request.method,
      path: source === "recorded" ? scrubber.scrubText(new URL(request.url).pathname) : undefined,
      request: capturedRequest,
      response: response === undefined ? undefined : payload(response),
    };
  }

  return { payload, exchange };
}
