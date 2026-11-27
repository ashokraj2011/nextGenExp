import { digestJson, EnvSecretResolver, GEMINI_DEFAULT_BASE_URL, GeminiProvider, OpenAICompatibleProvider, Scrubber, stableBody } from "@sfield/core";
import type { JsonObject, JsonValue, ModelBinding, ModelProvider, ModelStreamEvent, OpenAIQuirk, SFieldOptions, SFieldPlugin } from "@sfield/core";
import type { GatewayExchange } from "../../packages/contracts/inspector";
import { copilotEnvironment, type CopilotAcpSettings } from "./copilot-acp-client";
import { createPayloadCapture } from "./payload-capture";

export type HttpGatewaySettings = {
  profile?: "openai" | "gemini";
  baseUrl: string;
  model: string;
  apiKey?: string;
  contextWindow: number;
  maxOutputTokens: number;
  quirks?: OpenAIQuirk[];
  headers?: Record<string, string>;
  bodyFields?: JsonObject;
};

export type GatewaySettings = HttpGatewaySettings | CopilotAcpSettings;

const headerVariable = "LLM_GATEWAY_HEADERS_JSON";
const bodyVariable = "LLM_GATEWAY_BODY_JSON";
const openAiBaseUrl = "https://api.openai.com/v1";
const transportHeaders = new Set(["host", "content-length", "transfer-encoding", "connection", "upgrade"]);
const managedBodyFields = new Set([
  "model", "messages", "stream", "stream_options", "tools", "tool_choice", "functions", "function_call",
  "parallel_tool_calls", "response_format", "n", "max_tokens", "max_completion_tokens", "max_output_tokens",
  "temperature", "top_p", "stop", "seed", "presence_penalty", "frequency_penalty",
  "__proto__", "constructor", "prototype",
]);
const supportedQuirks: OpenAIQuirk[] = ["system_as_user", "no_stream_usage", "no_strict", "json_mode_only", "tool_choice_unsupported"];

function readObject(variable: string, text?: string): JsonObject {
  if (!text?.trim()) return {};
  try {
    const value = JSON.parse(text) as JsonValue;
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // JSON parser messages can contain the configured value.
  }
  throw new Error(variable + " must be a JSON object.");
}

function readHeaders(text?: string): Record<string, string> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(readObject(headerVariable, text))) {
    if (transportHeaders.has(name.toLowerCase())) {
      throw new Error(headerVariable + " cannot set HTTP transport headers.");
    }
    try {
      if (headers.has(name)) throw new Error("duplicate header");
      headers.set(name, typeof value === "string" ? value : JSON.stringify(value));
    } catch {
      throw new Error(headerVariable + " contains an invalid or duplicate header.");
    }
  }
  return Object.fromEntries(headers.entries());
}

function modelLimits(contextSetting?: string, outputSetting?: string) {
  const contextWindow = Number(contextSetting || 16_384);
  const maxOutputTokens = Number(outputSetting || 1_500);
  if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxOutputTokens)
    || maxOutputTokens < 512 || contextWindow - maxOutputTokens < 2_048) {
    throw new Error("The configured model limits leave insufficient space for routing and composition.");
  }
  return { contextWindow, maxOutputTokens };
}

export function gatewayFromEnv(env: NodeJS.ProcessEnv = process.env, profile: "gateway" | "openai" = "gateway"): GatewaySettings | null {
  // An explicitly configured endpoint also selects the office gateway in older .env files.
  const provider = profile === "openai" ? "openai"
    : env.LLM_PROVIDER?.trim().toLowerCase() || (env.LLM_BASE_URL?.trim() ? "gateway" : "copilot_acp");
  if (provider === "openai") {
    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new Error("Set OPENAI_API_KEY in the server environment or .env.openai before using OpenAI API mode.");
    return {
      profile: "openai", baseUrl: openAiBaseUrl, apiKey, model: env.OPENAI_MODEL?.trim() || "gpt-4.1-mini",
      ...modelLimits(env.OPENAI_CONTEXT_WINDOW, env.OPENAI_MAX_OUTPUT_TOKENS),
    };
  }
  if (provider === "gemini") {
    const apiKey = env.GEMINI_API_KEY?.trim() || env.LLM_API_KEY?.trim();
    if (!apiKey) throw new Error("Set GEMINI_API_KEY in the server environment before using Gemini API mode.");
    return {
      profile: "gemini",
      baseUrl: env.GEMINI_BASE_URL?.trim() || GEMINI_DEFAULT_BASE_URL,
      apiKey,
      model: env.GEMINI_MODEL?.trim() || env.LLM_MODEL?.trim() || "gemini-2.5-flash",
      ...modelLimits(env.GEMINI_CONTEXT_WINDOW || env.LLM_CONTEXT_WINDOW, env.GEMINI_MAX_OUTPUT_TOKENS || env.LLM_MAX_OUTPUT_TOKENS),
    };
  }
  if (provider === "copilot_acp" || provider === "copilot-acp") {
    return {
      profile: "copilot_acp", model: env.LLM_MODEL?.trim() || "auto",
      command: env.COPILOT_ACP_COMMAND?.trim() || "copilot", env: copilotEnvironment(env),
      ...modelLimits(env.LLM_CONTEXT_WINDOW, env.LLM_MAX_OUTPUT_TOKENS),
    };
  }
  if (provider !== "gateway" && provider !== "openai_compatible") {
    throw new Error("LLM_PROVIDER must be gateway, openai, gemini, or copilot_acp.");
  }
  const baseUrl = env.LLM_BASE_URL?.trim();
  const model = env.LLM_MODEL?.trim();
  if (!baseUrl || !model) return null;

  const apiKey = env.LLM_API_KEY?.trim() || undefined;
  const headers = readHeaders(env[headerVariable]);
  const bodyFields = readObject(bodyVariable, env[bodyVariable]);
  if (Object.keys(bodyFields).some((field) => managedBodyFields.has(field))) {
    throw new Error(bodyVariable + " cannot set fields controlled by the Chat Completions adapter.");
  }
  if (apiKey && Object.hasOwn(headers, "authorization")) {
    throw new Error("Set Authorization through LLM_API_KEY or LLM_GATEWAY_HEADERS_JSON.");
  }
  if (!apiKey && Object.keys(headers).length === 0) return null;

  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error("LLM_BASE_URL must be a valid Chat Completions prefix."); }
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new Error("LLM_BASE_URL must use HTTPS or a loopback HTTP gateway, with a path prefix only.");
  }
  const limits = modelLimits(env.LLM_CONTEXT_WINDOW, env.LLM_MAX_OUTPUT_TOKENS);
  const quirks = (env.LLM_QUIRKS || "").split(",").map((quirk) => quirk.trim()).filter(Boolean) as OpenAIQuirk[];
  if (new Set(quirks).size !== quirks.length || quirks.some((quirk) => !supportedQuirks.includes(quirk))) {
    throw new Error("LLM_QUIRKS contains an unsupported or repeated adapter option.");
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), model, apiKey, ...limits, quirks, headers, bodyFields };
}

function headerSecrets(value: string): string[] {
  const secrets = [value];
  const token = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value)?.[1];
  if (token) secrets.push(token);
  if (value.startsWith("{") || value.startsWith("[")) {
    try {
      const pending: JsonValue[] = [JSON.parse(value) as JsonValue];
      while (pending.length) {
        const item = pending.pop();
        if (typeof item === "string") secrets.push(item);
        else if (item && typeof item === "object") pending.push(...Object.values(item));
      }
    } catch {
      // A literal header can start with a brace.
    }
  }
  return secrets;
}

function openAiRequestBody(compiledBody: string) {
  const { max_tokens, ...body } = JSON.parse(compiledBody) as JsonObject;
  const format = body.response_format as JsonObject | undefined;
  const output = format?.json_schema as JsonObject | undefined;
  if (output?.schema) {
    // The original schema still enforces uniqueness in sfield and the host verifier.
    const schema = JSON.stringify(output.schema, (key, value: unknown) => key === "uniqueItems" ? undefined : value);
    output.schema = JSON.parse(schema) as JsonObject;
  }
  return stableBody({ ...body, max_completion_tokens: max_tokens });
}

export type GatewayConfiguration = {
  model: JsonObject;
  options: Pick<SFieldOptions, "env" | "bindings" | "plugins" | "secrets">;
  inspection?: ReturnType<typeof createPayloadCapture> & { compile: ModelProvider["compile"] };
};

export function configureGateway(
  settings: HttpGatewaySettings, record?: (attemptId: string, exchange: GatewayExchange) => void,
): GatewayConfiguration {
  const env = { LLM_API_KEY: settings.apiKey };
  const directOpenAi = settings.profile === "openai";
  const directGemini = settings.profile === "gemini";
  const headers = directOpenAi || directGemini ? {} : settings.headers ?? {};
  const bodyFields = directOpenAi || directGemini ? {} : settings.bodyFields ?? {};
  const headerNames = Object.keys(headers);
  const bodyFieldNames = Object.keys(bodyFields);
  const hasOverrides = headerNames.length > 0 || bodyFieldNames.length > 0;
  if (!hasOverrides && !record && !directOpenAi && !directGemini) {
    return {
      model: {
        provider: "openai_compatible", model: settings.model, base_url: settings.baseUrl,
        credential: { env: "LLM_API_KEY" },
        limits: { context_window: settings.contextWindow, max_output_tokens: settings.maxOutputTokens },
        quirks: settings.quirks ?? [],
      },
      options: { env },
    };
  }

  const id = "pzn_chat_gateway";
  const credentialValues = [...Object.values(headers).flatMap(headerSecrets), ...(settings.apiKey ? [settings.apiKey] : [])];
  const scrubber = new Scrubber(credentialValues);
  const adapter: ModelProvider = directGemini
    ? new GeminiProvider()
    : new OpenAICompatibleProvider(hasOverrides || directOpenAi ? (input, init) => {
        const outgoing = new Headers(init?.headers);
        for (const [name, value] of Object.entries(headers)) outgoing.set(name, value);
        return fetch(input, { ...init, headers: outgoing, redirect: "error" });
      } : undefined);
  const capture = record && createPayloadCapture([...credentialValues, ...headerSecrets(JSON.stringify(bodyFields))], bodyFieldNames);
  const provider: ModelProvider = {
    id,
    describe: (binding) => adapter.describe(binding),
    async compile(request) {
      const compiled = await adapter.compile(request);
      let body = compiled.body;
      if (directOpenAi) {
        body = openAiRequestBody(compiled.body);
      } else if (bodyFieldNames.length) {
        body = stableBody({ ...bodyFields, ...JSON.parse(compiled.body) as JsonObject });
      }
      return { ...compiled, provider: id, body, digest: digestJson(body) };
    },
    async *stream(request, options) {
      let outcome: Extract<ModelStreamEvent, { type: "done" | "error" }> | undefined;
      try {
        for await (const event of adapter.stream(request, options)) {
          if (event.type === "error") {
            outcome = { ...event, error: { ...event.error, message: scrubber.scrubText(event.error.message) } };
            yield outcome;
          } else {
            if (event.type === "done") outcome = event;
            yield event;
          }
        }
      } finally {
        if (record && capture) {
          try { record(options.attemptId, capture.exchange(request, outcome, "recorded")); }
          catch { /* A diagnostic write cannot change the model result. */ }
        }
      }
    },
  };
  const plugin: SFieldPlugin = {
    manifest: { id, version: "1.0.0", apiVersion: 1, coreCompatibility: "0.1.0", buildDigest: digestJson([id, 1]), requires: [] },
    register: (registrar) => registrar.provider(provider),
  };
  const binding: ModelBinding = {
    identity: {
      id: "model:default",
      revision: digestJson([id, settings.model, settings.baseUrl, settings.contextWindow, settings.maxOutputTokens,
        settings.quirks ?? [], headerNames.sort(), bodyFieldNames.sort(), Boolean(settings.apiKey), ...(directOpenAi ? ["openai"] : [])]),
      accountScope: id, classification: "restricted",
    },
    model: settings.model, baseUrl: settings.baseUrl, provider: id,
    credential: settings.apiKey ? { env: "LLM_API_KEY" } : undefined,
    acceptsClassification: "restricted", supportedParams: ["max_output_tokens"],
    quirks: settings.quirks,
    limits: { contextWindow: settings.contextWindow, maxOutputTokens: settings.maxOutputTokens },
  };
  const resolver = new EnvSecretResolver(env);
  return {
    model: { binding: id },
    inspection: capture && { ...capture, compile: (request) => provider.compile(request) },
    options: {
      env, bindings: { models: { [id]: binding } }, plugins: [plugin],
      secrets: {
        resolve: (ref) => resolver.resolve(ref),
        inspect: (ref) => resolver.inspect(ref),
        knownValues: () => credentialValues,
      },
    },
  };
}
