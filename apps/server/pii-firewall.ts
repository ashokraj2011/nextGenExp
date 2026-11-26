import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  piiFirewallConfigSchema,
  type PiiAuditEvent,
  type PiiCategory,
  type PiiFirewallConfig,
  type PiiFirewallView,
  type PiiRedactionTrace,
  type PiiTokenEntry,
} from "../../packages/contracts/pii-firewall";

const DEFAULT_CONFIG: PiiFirewallConfig = {
  enabled: true,
  redactNames: true,
  redactAmounts: true,
  redactAccountIds: true,
  redactEmailsPhones: true,
};

interface PersistedFirewallState {
  config: PiiFirewallConfig;
  stats: {
    totalTurnsInspected: number;
    totalTurnsProtected: number;
    totalTokensRedacted: number;
  };
  recentEvents: PiiAuditEvent[];
}

function maskValue(value: string, category: PiiCategory): string {
  if (category === "email") {
    const [u, domain] = value.split("@");
    return `${(u ?? "").slice(0, 2)}***@${domain ?? "***"}`;
  }
  if (category === "amount") return "$•••";
  if (category === "ssn") return "***-**-" + value.slice(-4);
  if (category === "phone") return "***-***-" + value.replace(/\D/g, "").slice(-4);
  if (category === "account_id") return value.slice(0, 3) + "•••" + value.slice(-2);
  return value
    .split(/\s+/)
    .map((part) => (part.length <= 1 ? "•" : part[0] + "•".repeat(Math.min(5, part.length - 1))))
    .join(" ");
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scrubWithPiiFirewall(input: {
  prompt: string;
  contextSummary?: string;
  knownNames?: string[];
  config: PiiFirewallConfig;
}): {
  scrubbedPrompt: string;
  scrubbedContextSummary?: string;
  tokenMap: Map<string, string>;
  trace: PiiRedactionTrace;
} {
  const { prompt, contextSummary, knownNames = [], config } = input;
  const timestamp = new Date().toISOString();
  const tokenMap = new Map<string, string>();

  if (!config.enabled) {
    return {
      scrubbedPrompt: prompt,
      scrubbedContextSummary: contextSummary,
      tokenMap,
      trace: {
        firewallEnabled: false,
        redactedCount: 0,
        originalPrompt: prompt,
        scrubbedPrompt: prompt,
        ...(contextSummary !== undefined ? { originalContextSummary: contextSummary, scrubbedContextSummary: contextSummary } : {}),
        tokens: [],
        rehydratedLocally: false,
        timestamp,
      },
    };
  }

  const valueToToken = new Map<string, PiiTokenEntry>();
  const counters: Record<PiiCategory, number> = {
    person: 0,
    amount: 0,
    account_id: 0,
    email: 0,
    phone: 0,
    ssn: 0,
  };
  const prefixes: Record<PiiCategory, string> = {
    person: "PERSON",
    amount: "AMOUNT",
    account_id: "ACCT",
    email: "EMAIL",
    phone: "PHONE",
    ssn: "SSN",
  };

  function getOrCreateToken(raw: string, category: PiiCategory): string {
    const key = `${category}:${raw.toLowerCase()}`;
    const existing = valueToToken.get(key);
    if (existing) return existing.token;
    counters[category] += 1;
    const token = `«${prefixes[category]}_${counters[category]}»`;
    const entry: PiiTokenEntry = {
      token,
      category,
      original: raw,
      masked: maskValue(raw, category),
    };
    valueToToken.set(key, entry);
    tokenMap.set(token, raw);
    return token;
  }

  function scrubString(text: string): string {
    let out = text;

    if (config.redactEmailsPhones) {
      // SSN
      out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, (m) => getOrCreateToken(m, "ssn"));
      // Emails
      out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (m) => getOrCreateToken(m, "email"));
      // US-style phones
      out = out.replace(/(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\b\d{3})[-.\s]\d{3}[-.\s]\d{4}\b/g, (m) => getOrCreateToken(m, "phone"));
    }

    if (config.redactNames) {
      // Sort longest names first so "Alice Morgan" matches before "Alice"
      const uniqueNames = [...new Set(
        knownNames
          .flatMap((n) => [n.trim(), ...n.trim().split(/\s+/)])
          .filter((n) => n.length >= 3),
      )].sort((a, b) => b.length - a.length);
      for (const name of uniqueNames) {
        const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, "gi");
        out = out.replace(re, (m) => getOrCreateToken(m, "person"));
      }
    }

    if (config.redactAccountIds) {
      // Account IDs, invoice IDs, case IDs, long numeric IDs
      out = out.replace(/\b(?:acct|acc|inv|case|deal|inc|mid|mrn)[-_#]?[a-z0-9]{3,16}\b/gi, (m) => getOrCreateToken(m, "account_id"));
      out = out.replace(/\b\d{8,16}\b/g, (m) => getOrCreateToken(m, "account_id"));
    }

    if (config.redactAmounts) {
      out = out.replace(/\$\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?[kKmM]\b)?/g, (m) => getOrCreateToken(m, "amount"));
    }

    return out;
  }

  const scrubbedPrompt = scrubString(prompt);
  const scrubbedContextSummary = contextSummary !== undefined ? scrubString(contextSummary) : undefined;
  const tokens = [...valueToToken.values()];

  return {
    scrubbedPrompt,
    scrubbedContextSummary,
    tokenMap,
    trace: {
      firewallEnabled: true,
      redactedCount: tokens.length,
      originalPrompt: prompt,
      scrubbedPrompt,
      ...(contextSummary !== undefined
        ? { originalContextSummary: contextSummary, scrubbedContextSummary }
        : {}),
      tokens,
      rehydratedLocally: tokens.length > 0,
      timestamp,
    },
  };
}

export function rehydratePiiText(text: string, tokenMap: Map<string, string>): string {
  if (!text || tokenMap.size === 0) return text;
  let out = text;
  for (const [token, original] of tokenMap.entries()) {
    if (out.includes(token)) {
      out = out.split(token).join(original);
    }
  }
  return out;
}

export function rehydrateObjectStrings<T>(value: T, tokenMap: Map<string, string>): T {
  if (tokenMap.size === 0) return value;
  if (typeof value === "string") return rehydratePiiText(value, tokenMap) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => rehydrateObjectStrings(item, tokenMap)) as unknown as T;
  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      next[k] = rehydrateObjectStrings(v, tokenMap);
    }
    return next as T;
  }
  return value;
}

export class PiiFirewallStore {
  private readonly filePath: string;
  private state: PersistedFirewallState;

  constructor(dataDir: string, defaultEnabled = true) {
    this.filePath = join(dataDir, "pii-firewall.json");
    this.state = this.load(defaultEnabled);
  }

  private load(defaultEnabled: boolean): PersistedFirewallState {
    if (existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PersistedFirewallState>;
        const cfg = piiFirewallConfigSchema.safeParse(parsed.config);
        return {
          config: cfg.success ? cfg.data : { ...DEFAULT_CONFIG, enabled: defaultEnabled },
          stats: {
            totalTurnsInspected: parsed.stats?.totalTurnsInspected ?? 0,
            totalTurnsProtected: parsed.stats?.totalTurnsProtected ?? 0,
            totalTokensRedacted: parsed.stats?.totalTokensRedacted ?? 0,
          },
          recentEvents: Array.isArray(parsed.recentEvents) ? parsed.recentEvents.slice(0, 30) : [],
        };
      } catch { /* fall through */ }
    }
    return {
      config: { ...DEFAULT_CONFIG, enabled: defaultEnabled },
      stats: { totalTurnsInspected: 0, totalTurnsProtected: 0, totalTokensRedacted: 0 },
      recentEvents: [],
    };
  }

  private save() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  getConfig(): PiiFirewallConfig {
    return { ...this.state.config };
  }

  updateConfig(patch: Partial<PiiFirewallConfig>): PiiFirewallView {
    this.state.config = piiFirewallConfigSchema.parse({ ...this.state.config, ...patch });
    this.save();
    return this.view();
  }

  inspectAndRecord(input: {
    turnId?: string;
    prompt: string;
    contextSummary?: string;
    knownNames?: string[];
    personaName?: string;
  }) {
    const result = scrubWithPiiFirewall({
      prompt: input.prompt,
      contextSummary: input.contextSummary,
      knownNames: input.knownNames,
      config: this.state.config,
    });
    this.state.stats.totalTurnsInspected += 1;
    if (result.trace.firewallEnabled && result.trace.redactedCount > 0) {
      this.state.stats.totalTurnsProtected += 1;
      this.state.stats.totalTokensRedacted += result.trace.redactedCount;
    }
    const categories = [...new Set(result.trace.tokens.map((t) => t.category))];
    const evt: PiiAuditEvent = {
      id: `pii_${randomUUID().slice(0, 8)}`,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.personaName ? { personaName: input.personaName } : {}),
      firewallEnabled: result.trace.firewallEnabled,
      redactedCount: result.trace.redactedCount,
      categories,
      scrubbedPreview: result.trace.scrubbedPrompt.slice(0, 140),
      timestamp: result.trace.timestamp,
    };
    this.state.recentEvents = [evt, ...this.state.recentEvents].slice(0, 30);
    this.save();
    return result;
  }

  recordEgressEvent(input: {
    turnId?: string;
    personaName?: string;
    tokens: PiiTokenEntry[];
    scrubbedPreview: string;
  }) {
    this.state.stats.totalTurnsInspected += 1;
    if (this.state.config.enabled && input.tokens.length > 0) {
      this.state.stats.totalTurnsProtected += 1;
      this.state.stats.totalTokensRedacted += input.tokens.length;
    }
    const categories = [...new Set(input.tokens.map((t) => t.category))];
    const evt: PiiAuditEvent = {
      id: `pii_${randomUUID().slice(0, 8)}`,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.personaName ? { personaName: input.personaName } : {}),
      firewallEnabled: this.state.config.enabled,
      redactedCount: input.tokens.length,
      categories,
      scrubbedPreview: input.scrubbedPreview.slice(0, 140),
      timestamp: new Date().toISOString(),
    };
    this.state.recentEvents = [evt, ...this.state.recentEvents].slice(0, 30);
    this.save();
  }

  view(): PiiFirewallView {
    return {
      config: { ...this.state.config },
      stats: { ...this.state.stats },
      recentEvents: this.state.recentEvents.slice(0, 20),
    };
  }
}

import type { NeutralModelRequest } from "@sfield/core";
import type { CepTelemetry } from "./telemetry";

/** Keys in structured JSON envelopes that carry schema/protocol IDs and must stay verbatim. */
const STRUCTURAL_KEYS = new Set([
  "inputType", "contextId", "intentId", "component", "toolRef", "ref", "catalogSnapshotId", "catalogVersion",
  "type", "role", "id", "runId", "callId", "turnId", "conversationId", "scenarioId", "personaId", "domain",
  "status", "effect", "action", "contractDigest", "bindingDigest", "version", "method", "target", "blockId",
  "candidateId", "candidateIds", "contentId", "introKey", "variant", "followUpIds", "selectedContextId",
  "selectedIntentId", "summaryFollowUpIntentId", "requestId", "idempotencyKey", "approvalId", "workflowId",
]);

/**
 * Scrubs a string that may be either plain text or a JSON envelope.
 * For JSON envelopes, only non-structural string leaf values are scrubbed so JSON syntax and protocol IDs stay intact.
 */
export function scrubJsonSafeText(
  text: string,
  knownNames: string[],
  config: PiiFirewallConfig,
): { scrubbed: string; tokenMap: Map<string, string>; tokens: PiiTokenEntry[] } {
  const tokenMap = new Map<string, string>();
  const tokens: PiiTokenEntry[] = [];
  if (!config.enabled || !text) return { scrubbed: text, tokenMap, tokens };

  const seenTokens = new Set<string>();
  const recordTokens = (subMap: Map<string, string>, subTokens: PiiTokenEntry[]) => {
    for (const [k, v] of subMap.entries()) tokenMap.set(k, v);
    for (const t of subTokens) {
      if (!seenTokens.has(t.token)) {
        seenTokens.add(t.token);
        tokens.push(t);
      }
    }
  };

  const trimmed = text.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const walk = (node: unknown, key?: string): unknown => {
        if (typeof node === "string") {
          if (key && STRUCTURAL_KEYS.has(key)) return node;
          const res = scrubWithPiiFirewall({ prompt: node, knownNames, config });
          recordTokens(res.tokenMap, res.trace.tokens);
          return res.scrubbedPrompt;
        }
        if (Array.isArray(node)) return node.map((item) => walk(item, key));
        if (node && typeof node === "object") {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            out[k] = walk(v, k);
          }
          return out;
        }
        return node;
      };
      return { scrubbed: JSON.stringify(walk(parsed)), tokenMap, tokens };
    } catch {
      // Not valid JSON — scrub as plain text below.
    }
  }

  const res = scrubWithPiiFirewall({ prompt: text, knownNames, config });
  recordTokens(res.tokenMap, res.trace.tokens);
  return { scrubbed: res.scrubbedPrompt, tokenMap, tokens };
}

/**
 * Enforces PII redaction inside sfield's `beforeModelDispatch` hook on every outbound model message.
 */
export function scrubNeutralModelRequest(
  request: NeutralModelRequest,
  knownNames: string[],
  store: PiiFirewallStore,
  runId: string,
): { request: NeutralModelRequest; tokenMap: Map<string, string>; redactedCount: number } {
  const config = store.getConfig();
  const combinedMap = new Map<string, string>();
  const allTokens: PiiTokenEntry[] = [];
  if (!config.enabled) return { request, tokenMap: combinedMap, redactedCount: 0 };

  let changed = false;
  let samplePreview = "";
  const nextMessages = request.messages.map((msg) => {
    if (msg.role === "tool_results") return msg;
    const nextParts = msg.parts.map((part) => {
      if (part.type !== "text" || !part.text) return part;
      const res = scrubJsonSafeText(part.text, knownNames, config);
      if (res.tokens.length > 0) {
        changed = true;
        if (!samplePreview) samplePreview = res.scrubbed.slice(0, 140);
        for (const [k, v] of res.tokenMap.entries()) combinedMap.set(k, v);
        allTokens.push(...res.tokens);
        return { ...part, text: res.scrubbed };
      }
      return part;
    });
    return { ...msg, parts: nextParts };
  });

  if (allTokens.length > 0) {
    store.recordEgressEvent({
      turnId: runId,
      personaName: "sfield:beforeModelDispatch",
      tokens: allTokens,
      scrubbedPreview: samplePreview,
    });
  }

  return {
    request: changed ? { ...request, messages: nextMessages } : request,
    tokenMap: combinedMap,
    redactedCount: allTokens.length,
  };
}

/** Process-local registry keyed by dataDir so every callConfiguredLlmJson() shares the server's PII firewall & telemetry. */
export interface LlmEgressContext {
  piiFirewall?: PiiFirewallStore;
  telemetry?: CepTelemetry;
  getKnownNames?: () => string[];
}

const egressByDataDir = new Map<string, LlmEgressContext>();

export function registerLlmEgressContext(dataDir: string, ctx: LlmEgressContext) {
  egressByDataDir.set(dataDir, ctx);
}

export function getLlmEgressContext(dataDir: string): LlmEgressContext | undefined {
  return egressByDataDir.get(dataDir);
}

export function unregisterLlmEgressContext(dataDir: string) {
  egressByDataDir.delete(dataDir);
}
