/**
 * Saved LLM gateway configuration for the sfield runtime: edit, test, and activate without editing .env.
 * The active saved configuration (if any) wins over environment variables at startup. Activating one restarts the
 * app in-process so sfield re-binds its model (pending approvals survive restarts by design).
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { gatewayFromEnv, type GatewaySettings } from "./gateway";
import { runCopilotPrompt } from "./copilot-acp-client";

export const gatewayQuirks = ["system_as_user", "no_stream_usage", "no_strict", "json_mode_only", "tool_choice_unsupported"] as const;

export const gatewayConfigSchema = z.object({
  provider: z.enum(["openai_compatible", "openai", "copilot_acp"]),
  label: z.string().trim().max(60).optional(),
  baseUrl: z.string().trim().max(300).optional(),
  model: z.string().trim().min(1).max(120),
  /** stored: kept in this server's data directory (mode 600, never returned); env: read from an env var; none: headers only. */
  apiKeyMode: z.enum(["stored", "env", "none"]).default("none"),
  apiKey: z.string().max(400).optional(),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional(),
  headers: z.record(z.string(), z.string().max(2000)).default({}),
  bodyFields: z.record(z.string(), z.unknown()).default({}),
  contextWindow: z.number().int().min(4096).max(2_000_000).default(16_384),
  maxOutputTokens: z.number().int().min(512).max(200_000).default(1_500),
  quirks: z.array(z.enum(gatewayQuirks)).max(5).default([]),
  copilotCommand: z.string().trim().max(200).optional(),
}).strict();
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
export type GatewayConfigInput = z.input<typeof gatewayConfigSchema>;

export type GatewayTestResult = {
  ok: boolean;
  testedAt: string;
  latencyMs: number;
  provider: GatewayConfig["provider"];
  model: string;
  steps: { name: string; ok: boolean; detail: string }[];
  /** Digest of the tested configuration; activation requires a passing test of the same configuration. */
  configDigest: string;
};

type Saved = {
  active?: GatewayConfig & { activatedAt: string; activatedBy: string };
  lastTest?: GatewayTestResult;
};

/** What the admin UI sees: secrets masked. */
export type GatewayConfigView = {
  source: "saved" | "environment" | "none";
  running: { provider: string; model: string; baseUrl?: string } | null;
  active?: Omit<GatewayConfig, "apiKey"> & { apiKeySet: boolean; apiKeyHint?: string; activatedAt: string; activatedBy: string };
  lastTest?: GatewayTestResult;
  restartSupported: boolean;
};

const mask = (key?: string) => (key ? `••••${key.slice(-4)}` : undefined);

export class GatewayConfigStore {
  private readonly path: string;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, "llm-gateway.json");
  }
  read(): Saved {
    if (!existsSync(this.path)) return {};
    try { return JSON.parse(readFileSync(this.path, "utf8")) as Saved; } catch { return {}; }
  }
  private write(state: Saved) {
    writeFileSync(this.path, JSON.stringify(state, null, 2), { mode: 0o600 });
    try { chmodSync(this.path, 0o600); } catch { /* best effort */ }
  }
  active() { return this.read().active; }
  saveTest(result: GatewayTestResult) { this.write({ ...this.read(), lastTest: result }); }
  activate(config: GatewayConfig, by: string) {
    this.write({ ...this.read(), active: { ...config, activatedAt: new Date().toISOString(), activatedBy: by } });
  }
  reset() {
    const { active: _a, ...rest } = this.read();
    if (Object.keys(rest).length) this.write(rest); else rmSync(this.path, { force: true });
  }
  view(running: GatewaySettings | null, restartSupported: boolean): GatewayConfigView {
    const state = this.read();
    const runningView = running
      ? { provider: running.profile === "copilot_acp" ? "copilot_acp" : running.profile === "openai" ? "openai" : "openai_compatible", model: running.model, ...("baseUrl" in running ? { baseUrl: running.baseUrl } : {}) }
      : null;
    const active = state.active;
    return {
      source: active ? "saved" : running ? "environment" : "none",
      running: runningView,
      ...(active ? { active: { ...withoutKey(active), apiKeySet: Boolean(active.apiKey), ...(active.apiKey ? { apiKeyHint: mask(active.apiKey) } : {}), activatedAt: active.activatedAt, activatedBy: active.activatedBy } } : {}),
      ...(state.lastTest ? { lastTest: state.lastTest } : {}),
      restartSupported,
    };
  }
}

function withoutKey<T extends { apiKey?: string }>(c: T): Omit<T, "apiKey"> {
  const { apiKey: _k, ...rest } = c;
  return rest;
}

/** A blank stored key keeps the currently saved one, so the UI never has to see it. */
export function mergeStoredKey(input: GatewayConfig, saved?: GatewayConfig): GatewayConfig {
  if (input.apiKeyMode === "stored" && !input.apiKey && saved?.apiKeyMode === "stored" && saved.apiKey) return { ...input, apiKey: saved.apiKey };
  return input;
}

/** Builds runtime settings through the same validation as environment configuration (gatewayFromEnv). */
export function settingsFromConfig(config: GatewayConfig, env: NodeJS.ProcessEnv = process.env): GatewaySettings {
  const key = config.apiKeyMode === "stored" ? config.apiKey : config.apiKeyMode === "env" && config.apiKeyEnv ? env[config.apiKeyEnv] : undefined;
  if (config.apiKeyMode === "stored" && !key) throw new Error("Enter the API key (it is stored only on this server).");
  if (config.apiKeyMode === "env" && !key) throw new Error(`Environment variable ${config.apiKeyEnv ?? "(none)"} is not set on the server.`);
  const limits = { LLM_CONTEXT_WINDOW: String(config.contextWindow), LLM_MAX_OUTPUT_TOKENS: String(config.maxOutputTokens) };
  if (config.provider === "copilot_acp") {
    const settings = gatewayFromEnv({ ...env, LLM_PROVIDER: "copilot_acp", LLM_MODEL: config.model, ...(config.copilotCommand ? { COPILOT_ACP_COMMAND: config.copilotCommand } : {}), ...limits });
    if (!settings) throw new Error("Copilot settings are incomplete.");
    return settings;
  }
  if (config.provider === "openai") {
    if (!key) throw new Error("OpenAI needs an API key.");
    const settings = gatewayFromEnv({ OPENAI_API_KEY: key, OPENAI_MODEL: config.model, OPENAI_CONTEXT_WINDOW: limits.LLM_CONTEXT_WINDOW, OPENAI_MAX_OUTPUT_TOKENS: limits.LLM_MAX_OUTPUT_TOKENS }, "openai");
    if (!settings) throw new Error("OpenAI settings are incomplete.");
    return settings;
  }
  if (!config.baseUrl) throw new Error("Enter the gateway base URL (the Chat Completions prefix, e.g. https://gateway.example.com/v1).");
  const settings = gatewayFromEnv({
    LLM_PROVIDER: "gateway", LLM_BASE_URL: config.baseUrl, LLM_MODEL: config.model,
    ...(key ? { LLM_API_KEY: key } : {}),
    ...(Object.keys(config.headers).length ? { LLM_GATEWAY_HEADERS_JSON: JSON.stringify(config.headers) } : {}),
    ...(Object.keys(config.bodyFields).length ? { LLM_GATEWAY_BODY_JSON: JSON.stringify(config.bodyFields) } : {}),
    ...(config.quirks.length ? { LLM_QUIRKS: config.quirks.join(",") } : {}),
    ...limits,
  });
  if (!settings) throw new Error("Add an API key or an Authorization header for the gateway.");
  return settings;
}

export function configDigest(config: GatewayConfig): string {
  const { label: _l, ...rest } = config;
  return createHash("sha256").update(JSON.stringify(sortKeys(rest))).digest("hex").slice(0, 24);
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

function scrub(text: string, secrets: (string | undefined)[]) {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("••••");
  return out.slice(0, 400);
}

/**
 * Tests a configuration end to end: settings validation (same rules as the environment), sfield capacity check
 * (the router/composer prompts must fit the context window), and a real model call that must return JSON.
 */
export async function testGatewayConfig(
  config: GatewayConfig, opts: { dataDir: string; capacityCheck: (s: GatewaySettings) => void; env?: NodeJS.ProcessEnv },
): Promise<GatewayTestResult> {
  const started = Date.now();
  const steps: GatewayTestResult["steps"] = [];
  const secrets = [config.apiKey, ...(config.apiKeyEnv ? [opts.env?.[config.apiKeyEnv] ?? process.env[config.apiKeyEnv]] : []), ...Object.values(config.headers)];
  const done = (ok: boolean) => ({ ok, testedAt: new Date().toISOString(), latencyMs: Date.now() - started, provider: config.provider, model: config.model, steps, configDigest: configDigest(config) });
  let settings: GatewaySettings;
  try {
    settings = settingsFromConfig(config, opts.env);
    steps.push({ name: "Settings", ok: true, detail: config.provider === "openai_compatible" ? `Chat Completions at ${config.baseUrl}` : config.provider === "openai" ? "OpenAI API" : `Copilot ACP (${config.copilotCommand || "copilot"})` });
  } catch (err) {
    steps.push({ name: "Settings", ok: false, detail: scrub(err instanceof Error ? err.message : String(err), secrets) });
    return done(false);
  }
  try {
    opts.capacityCheck(settings);
    steps.push({ name: "sfield capacity", ok: true, detail: `Context ${config.contextWindow.toLocaleString()} tokens, output ${config.maxOutputTokens.toLocaleString()}: router and composer prompts fit.` });
  } catch (err) {
    steps.push({ name: "sfield capacity", ok: false, detail: scrub(err instanceof Error ? err.message : String(err), secrets) });
    return done(false);
  }
  const callStarted = Date.now();
  const prompt = 'Reply with exactly this JSON object and nothing else: {"ok": true, "word": "ready"}';
  try {
    let text = "";
    if (settings.profile === "copilot_acp") {
      const home = resolve(opts.dataDir, "copilot-cli");
      mkdirSync(home, { recursive: true, mode: 0o700 });
      text = (await runCopilotPrompt(settings, home, [{ type: "text", text: prompt }], AbortSignal.timeout(60_000), () => undefined)).text;
    } else {
      const res = await fetch(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { "Content-Type": "application/json", ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}), ...(settings.headers ?? {}) },
        body: JSON.stringify({
          ...(settings.bodyFields ?? {}), model: settings.model,
          ...(settings.profile === "openai" ? { max_completion_tokens: 200 } : { max_tokens: 60 }),
          messages: [{ role: settings.quirks?.includes("system_as_user") ? "user" : "system", content: "You reply with JSON only." }, { role: "user", content: prompt }],
        }),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      const payload = JSON.parse(body) as { model?: string; choices?: { message?: { content?: string } }[] };
      text = payload.choices?.[0]?.message?.content ?? "";
      if (payload.model) steps.push({ name: "Model", ok: true, detail: `Gateway answered as ${payload.model}` });
    }
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    let parsed: { ok?: unknown } | null = null;
    try { parsed = json ? JSON.parse(json) as { ok?: unknown } : null; } catch { parsed = null; }
    if (!parsed) {
      steps.push({ name: "Model call", ok: false, detail: `Replied in ${Date.now() - callStarted} ms but not with JSON: "${scrub(text, secrets).slice(0, 120)}"` });
      return done(false);
    }
    steps.push({ name: "Model call", ok: true, detail: `Replied with valid JSON in ${Date.now() - callStarted} ms.` });
    return done(true);
  } catch (err) {
    const message = err instanceof Error ? (err.name === "TimeoutError" ? "No reply within the time limit" : err.message) : String(err);
    steps.push({ name: "Model call", ok: false, detail: scrub(message, secrets) });
    return done(false);
  }
}
