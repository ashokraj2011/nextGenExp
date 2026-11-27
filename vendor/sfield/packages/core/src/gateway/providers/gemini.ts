/** Google Gemini API (v1beta streamGenerateContent) adapter over fetch + SSE. */
import type { JsonObject, JsonValue } from "../../types/common.js";
import type { SecretResolver } from "../../types/options.js";
import type {
  CompiledModelRequest,
  ModelBinding,
  ModelCapabilities,
  ModelProvider,
  ModelStreamEvent,
  NeutralMessage,
  NeutralModelRequest,
  NeutralPart,
  StopReason,
  Usage,
} from "../../types/model.js";
import { parseSSE, SSEByteLimitError } from "../../util/sse.js";
import { estimateTokens } from "../../util/tokens.js";
import {
  MAX_PROVIDER_STREAM_BYTES,
  bodyDigest,
  classifyHttpError,
  estimateRequestTokens,
  networkError,
  parseRetryAfter,
  readErrorBody,
  safeJson,
  sortedTools,
  stableBody,
  toolResultText,
} from "./shared.js";

export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const STOP_MAP: Record<string, StopReason> = {
  STOP: "end_turn",
  MAX_TOKENS: "max_tokens",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  BLOCKLIST: "content_filter",
  PROHIBITED_CONTENT: "refusal",
  SPII: "refusal",
};

function sanitizeGeminiSchema(schema: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "additionalProperties" || k === "$schema") continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = sanitizeGeminiSchema(v as JsonObject);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function compileContents(messages: readonly NeutralMessage[]): JsonValue[] {
  const out: JsonValue[] = [];
  for (const msg of messages) {
    if (msg.role === "tool_results") {
      const parts: JsonValue[] = msg.results.map((r) => ({
        functionResponse: {
          name: r.alias,
          response: {
            output: toolResultText(r.content),
            isError: r.isError,
          },
        },
      }));
      out.push({ role: "user", parts });
      continue;
    }
    const role = msg.role === "assistant" ? "model" : "user";
    const parts: JsonValue[] = [];
    for (const part of msg.parts) {
      if (part.type === "text") {
        parts.push({ text: part.text });
      } else if (part.type === "tool_call") {
        parts.push({
          functionCall: {
            name: part.alias,
            args: part.arguments,
          },
        });
      } else if (part.type === "media" && part.text) {
        parts.push({ text: part.text });
      }
    }
    if (parts.length > 0) {
      out.push({ role, parts });
    }
  }
  return out;
}

export class GeminiProvider implements ModelProvider {
  readonly id = "gemini";
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async describe(binding: ModelBinding): Promise<ModelCapabilities> {
    return {
      inputLimit: binding.limits.contextWindow,
      outputLimit: binding.limits.maxOutputTokens,
      toolUse: true,
      structuredOutput: "json_schema",
      strictTools: false,
      streamingUsage: true,
      media: ["image/png", "image/jpeg", "image/webp", "application/pdf", "audio/mp3", "video/mp4"],
      opaqueContinuation: false,
      tokenCounting: "estimated",
      continueStopReason: false,
    };
  }

  async compile(request: NeutralModelRequest): Promise<CompiledModelRequest> {
    const binding = request.binding;
    const tools = sortedTools(request.tools);
    const aliasMap: Record<string, string> = {};
    const functionDeclarations: JsonValue[] = [];
    for (const t of tools) {
      aliasMap[t.alias] = t.ref;
      functionDeclarations.push({
        name: t.alias,
        description: t.description,
        parameters: sanitizeGeminiSchema(t.inputSchema as JsonObject),
      });
    }

    const generationConfig: JsonObject = {
      maxOutputTokens: request.params.maxOutputTokens,
    };
    if (request.params.temperature !== undefined) generationConfig["temperature"] = request.params.temperature;
    if (request.params.topP !== undefined) generationConfig["topP"] = request.params.topP;
    if (request.params.stopSequences?.length) generationConfig["stopSequences"] = request.params.stopSequences;
    if (request.outputSchema) {
      generationConfig["responseMimeType"] = "application/json";
      generationConfig["responseSchema"] = sanitizeGeminiSchema(request.outputSchema as JsonObject);
    }

    const body: JsonObject = {
      contents: compileContents(request.messages),
      generationConfig,
    };
    if (request.instructions.length > 0) {
      body["systemInstruction"] = {
        parts: request.instructions.map((text) => ({ text })),
      };
    }
    if (functionDeclarations.length > 0) {
      body["tools"] = [{ functionDeclarations }];
      body["toolConfig"] = {
        functionCallingConfig: {
          mode: request.toolChoice === "none" ? "NONE" : "AUTO",
        },
      };
    }

    const serialized = stableBody(body);
    const base = (binding.baseUrl ?? GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, "");
    const url = `${base}/models/${encodeURIComponent(binding.model)}:streamGenerateContent?alt=sse`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(binding.headers ?? {}),
    };

    return {
      provider: this.id,
      url,
      method: "POST",
      headers,
      body: serialized,
      aliasMap,
      overheadTokens: 0,
      degradations: [],
      equivalence: { toolsExact: true, schemaExact: true, notes: [] },
      digest: bodyDigest(serialized),
    };
  }

  async *stream(
    request: CompiledModelRequest,
    opts: { signal: AbortSignal; attemptId: string; secrets: SecretResolver; binding: ModelBinding },
  ): AsyncIterable<ModelStreamEvent> {
    const headers: Record<string, string> = { ...request.headers };
    if (opts.binding.credential) {
      headers["x-goog-api-key"] = await opts.secrets.resolve(opts.binding.credential);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(request.url, {
        method: "POST",
        headers,
        body: request.body,
        signal: opts.signal,
      });
    } catch (err) {
      yield { type: "error", error: networkError(err, opts.signal.aborted) };
      return;
    }

    if (!response.ok || !response.body) {
      const text = await readErrorBody(response);
      const parsedErr = safeJson(text);
      const errObj = parsedErr?.["error"] as JsonObject | undefined;
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      yield {
        type: "error",
        error: classifyHttpError(
          { status: response.status, body: text, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
          typeof errObj?.["message"] === "string" ? errObj["message"] : undefined,
          typeof errObj?.["status"] === "string" ? errObj["status"] : undefined,
        ),
      };
      return;
    }

    const textParts: string[] = [];
    const toolCalls: Array<Extract<NeutralPart, { type: "tool_call" }>> = [];
    let finishReason = "STOP";
    let inputTokens = Math.ceil(request.body.length / 4);
    let outputTokens = 0;
    let reported = false;
    let callCounter = 0;

    try {
      for await (const frame of parseSSE(response.body, { maxBytes: MAX_PROVIDER_STREAM_BYTES, signal: opts.signal })) {
        const raw = frame.data.trim();
        if (!raw || raw === "[DONE]") continue;
        const parsed = safeJson(raw) as {
          candidates?: Array<{
            content?: {
              parts?: Array<{
                text?: string;
                functionCall?: { name: string; args?: JsonObject };
              }>;
            };
            finishReason?: string;
          }>;
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
          error?: { code?: number; message?: string };
        } | null;
        if (!parsed) continue;
        if (parsed.error) {
          yield {
            type: "error",
            error: { code: "GEMINI_STREAM_ERROR", message: parsed.error.message ?? "Gemini error", retryable: false, status: parsed.error.code },
          };
          return;
        }
        if (parsed.usageMetadata) {
          if (typeof parsed.usageMetadata.promptTokenCount === "number") {
            inputTokens = parsed.usageMetadata.promptTokenCount;
            reported = true;
          }
          if (typeof parsed.usageMetadata.candidatesTokenCount === "number") {
            outputTokens = parsed.usageMetadata.candidatesTokenCount;
            reported = true;
          }
        }
        const cand = parsed.candidates?.[0];
        if (!cand) continue;
        if (cand.finishReason) finishReason = cand.finishReason;
        for (const p of cand.content?.parts ?? []) {
          if (typeof p.text === "string" && p.text.length > 0) {
            textParts.push(p.text);
            yield { type: "text_delta", text: p.text };
          }
          if (p.functionCall?.name) {
            const idx = callCounter++;
            const alias = p.functionCall.name;
            const callId = `gem_call_${opts.attemptId}_${idx}`;
            const args = (p.functionCall.args && typeof p.functionCall.args === "object")
              ? p.functionCall.args
              : {};
            yield { type: "tool_call_start", index: idx, alias, providerCallId: callId };
            yield { type: "tool_call_delta", index: idx, argumentsDelta: JSON.stringify(args) };
            toolCalls.push({
              type: "tool_call",
              callId,
              toolRef: request.aliasMap[alias] ?? alias,
              alias,
              arguments: args,
              providerCallId: callId,
            });
          }
        }
      }
    } catch (err) {
      if (err instanceof SSEByteLimitError) {
        yield { type: "error", error: { code: "STREAM_TOO_LARGE", message: err.message, retryable: false } };
        return;
      }
      yield { type: "error", error: networkError(err, opts.signal.aborted) };
      return;
    }

    const fullText = textParts.join("");
    if (!reported) outputTokens = estimateTokens(fullText);
    const parts: NeutralPart[] = [];
    if (fullText) parts.push({ type: "text", text: fullText });
    parts.push(...toolCalls);

    const stopReason: StopReason = toolCalls.length > 0 ? "tool_use" : (STOP_MAP[finishReason] ?? "end_turn");
    const usage: Usage = { inputTokens, outputTokens, reported };
    yield {
      type: "done",
      message: { role: "assistant", parts },
      stopReason,
      usage,
    };
  }
}
