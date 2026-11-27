/**
 * First-class PII Egress Firewall & Local Rehydration plugin for @sfield/core.
 *
 * Scrubs sensitive identifiers (SSN, email, phone, credit cards, account IDs, known names,
 * and custom regex rules) at the `beforeModelDispatch` hook boundary into deterministic
 * reversible tokens, then rehydrates model outputs locally using a bounded per-run token vault.
 */
import type { RegisteredHook } from "../types/options.js";
import type { NeutralMessage, NeutralModelRequest, NeutralPart, NeutralToolResult } from "../types/model.js";
import type { JsonValue } from "../types/common.js";

export type PiiCategory = "ssn" | "email" | "phone" | "credit_card" | "account_id" | "person_name" | (string & {});

export interface PiiRedactionToken {
  token: string;
  category: PiiCategory;
  original: string;
  masked: string;
}

export interface PiiCustomRule {
  category: string;
  pattern: RegExp;
}

export interface PiiFirewallOptions {
  enabled?: boolean;
  /** Built-in detectors enabled by default. */
  detectSsn?: boolean;
  detectEmail?: boolean;
  detectPhone?: boolean;
  detectCreditCard?: boolean;
  detectAccountId?: boolean;
  detectKnownNames?: boolean;
  /** Dynamic or static list of known customer/person names to tokenize. */
  knownNames?: readonly string[] | (() => readonly string[]);
  /** Additional domain-specific regex detectors. */
  customRules?: readonly PiiCustomRule[];
  /** Maximum number of per-run token maps retained in memory. Defaults to 200. */
  maxRetainedRuns?: number;
}

export interface PiiScrubResult {
  scrubbed: string;
  tokenMap: Map<string, string>;
  tokens: PiiRedactionToken[];
}

const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;
const CARD_RE = /\b(?:\d{4}[-\s]?){3}\d{4}\b/g;
const ACCOUNT_ID_RE = /\b(?:DEMO-MID-\d{3,8}|ACCT-[A-Z0-9-]{4,16}|MID-\d{3,10})\b/g;

function maskValue(category: string, raw: string): string {
  if (category === "ssn") return `***-**-${raw.slice(-4)}`;
  if (category === "email") {
    const [u, d] = raw.split("@");
    return `${(u ?? "").slice(0, 2)}***@${d ?? "***"}`;
  }
  if (category === "credit_card") return `****-****-****-${raw.replace(/\D/g, "").slice(-4)}`;
  if (category === "phone") return `(***) ***-${raw.replace(/\D/g, "").slice(-4)}`;
  if (raw.length <= 4) return "****";
  return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class PiiFirewall {
  private readonly opts: Required<Omit<PiiFirewallOptions, "knownNames" | "customRules">> & {
    knownNames?: PiiFirewallOptions["knownNames"];
    customRules: readonly PiiCustomRule[];
  };
  private readonly runVault = new Map<string, Map<string, string>>();

  constructor(options: PiiFirewallOptions = {}) {
    this.opts = {
      enabled: options.enabled ?? true,
      detectSsn: options.detectSsn ?? true,
      detectEmail: options.detectEmail ?? true,
      detectPhone: options.detectPhone ?? true,
      detectCreditCard: options.detectCreditCard ?? true,
      detectAccountId: options.detectAccountId ?? true,
      detectKnownNames: options.detectKnownNames ?? true,
      maxRetainedRuns: options.maxRetainedRuns ?? 200,
      knownNames: options.knownNames,
      customRules: options.customRules ?? [],
    };
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  private resolveKnownNames(): readonly string[] {
    if (!this.opts.knownNames) return [];
    return typeof this.opts.knownNames === "function" ? this.opts.knownNames() : this.opts.knownNames;
  }

  scrubText(text: string, existingTokenMap?: Map<string, string>): PiiScrubResult {
    const tokenMap = existingTokenMap ?? new Map<string, string>();
    const reverse = new Map<string, string>();
    for (const [tok, orig] of tokenMap.entries()) reverse.set(orig, tok);

    const tokens: PiiRedactionToken[] = [];
    if (!this.opts.enabled || !text) {
      return { scrubbed: text, tokenMap, tokens };
    }

    const counters = new Map<string, number>();
    const nextToken = (category: string, original: string): string => {
      const existing = reverse.get(original);
      if (existing) return existing;
      const idx = (counters.get(category) ?? 0) + 1;
      counters.set(category, idx);
      const tag = category.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      let token = `[PII_${tag}_${idx}]`;
      while (tokenMap.has(token)) {
        const nextIdx = (counters.get(category) ?? 0) + 1;
        counters.set(category, nextIdx);
        token = `[PII_${tag}_${nextIdx}]`;
      }
      tokenMap.set(token, original);
      reverse.set(original, token);
      tokens.push({ token, category, original, masked: maskValue(category, original) });
      return token;
    };

    const applyRule = (input: string, category: string, pattern: RegExp): string => {
      const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
      const rx = new RegExp(pattern.source, flags);
      return input.replace(rx, (match) => {
        if (match.startsWith("[PII_")) return match;
        return nextToken(category, match);
      });
    };

    let out = text;
    if (this.opts.detectSsn) out = applyRule(out, "ssn", SSN_RE);
    if (this.opts.detectCreditCard) out = applyRule(out, "credit_card", CARD_RE);
    if (this.opts.detectEmail) out = applyRule(out, "email", EMAIL_RE);
    if (this.opts.detectPhone) out = applyRule(out, "phone", PHONE_RE);
    if (this.opts.detectAccountId) out = applyRule(out, "account_id", ACCOUNT_ID_RE);
    for (const rule of this.opts.customRules) {
      out = applyRule(out, rule.category, rule.pattern);
    }
    if (this.opts.detectKnownNames) {
      const names = [...new Set(this.resolveKnownNames().map((n) => n.trim()).filter((n) => n.length >= 2))]
        .sort((a, b) => b.length - a.length);
      for (const name of names) {
        out = applyRule(out, "person_name", new RegExp(`\\b${escapeRegExp(name)}\\b`, "gi"));
      }
    }

    return { scrubbed: out, tokenMap, tokens };
  }

  rehydrateText(text: string, tokenMap: ReadonlyMap<string, string>): string {
    if (!text || tokenMap.size === 0) return text;
    let out = text;
    for (const [token, original] of tokenMap.entries()) {
      if (out.includes(token)) out = out.split(token).join(original);
    }
    return out;
  }

  rehydrateObject<T>(value: T, tokenMap: ReadonlyMap<string, string>): T {
    if (tokenMap.size === 0 || value === null || value === undefined) return value;
    if (typeof value === "string") return this.rehydrateText(value, tokenMap) as unknown as T;
    if (Array.isArray(value)) return value.map((item) => this.rehydrateObject(item, tokenMap)) as unknown as T;
    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.rehydrateObject(v, tokenMap);
      }
      return out as T;
    }
    return value;
  }

  scrubModelRequest(request: NeutralModelRequest, runId?: string): {
    request: NeutralModelRequest;
    tokenMap: Map<string, string>;
    tokens: PiiRedactionToken[];
  } {
    const tokenMap = (runId && this.runVault.get(runId)) ? new Map(this.runVault.get(runId)!) : new Map<string, string>();
    const allTokens: PiiRedactionToken[] = [];

    const scrubPart = (part: NeutralPart): NeutralPart => {
      if (part.type === "text") {
        const res = this.scrubText(part.text, tokenMap);
        allTokens.push(...res.tokens);
        return res.scrubbed === part.text ? part : { ...part, text: res.scrubbed };
      }
      if (part.type === "media" && part.text) {
        const res = this.scrubText(part.text, tokenMap);
        allTokens.push(...res.tokens);
        return res.scrubbed === part.text ? part : { ...part, text: res.scrubbed };
      }
      return part;
    };

    const scrubToolResult = (tr: NeutralToolResult): NeutralToolResult => {
      const serialized = typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content);
      const res = this.scrubText(serialized, tokenMap);
      allTokens.push(...res.tokens);
      if (res.scrubbed === serialized) return tr;
      try {
        const nextContent: JsonValue = typeof tr.content === "string" ? res.scrubbed : (JSON.parse(res.scrubbed) as JsonValue);
        return { ...tr, content: nextContent };
      } catch {
        return { ...tr, content: res.scrubbed };
      }
    };

    const messages: NeutralMessage[] = request.messages.map((msg): NeutralMessage => {
      if (msg.role === "tool_results") {
        return { ...msg, results: msg.results.map(scrubToolResult) };
      }
      return { ...msg, parts: msg.parts.map(scrubPart) };
    });

    const instructions = request.instructions.map((inst) => {
      const res = this.scrubText(inst, tokenMap);
      allTokens.push(...res.tokens);
      return res.scrubbed;
    });

    if (runId && tokenMap.size > 0) {
      this.rememberRunTokens(runId, tokenMap);
    }

    return {
      request: {
        ...request,
        instructions,
        messages,
      },
      tokenMap,
      tokens: allTokens,
    };
  }

  rememberRunTokens(runId: string, tokenMap: Map<string, string>): void {
    const merged = new Map(this.runVault.get(runId) ?? []);
    for (const [k, v] of tokenMap.entries()) merged.set(k, v);
    this.runVault.set(runId, merged);
    while (this.runVault.size > this.opts.maxRetainedRuns) {
      const oldest = this.runVault.keys().next().value;
      if (!oldest) break;
      this.runVault.delete(oldest);
    }
  }

  /** Rehydrates any PII tokens in a completed run's output and optionally clears the run's token map. */
  rehydrateRunOutput<T>(runId: string, value: T, consume = true): T {
    const map = this.runVault.get(runId);
    if (!map) return value;
    if (consume) this.runVault.delete(runId);
    return this.rehydrateObject(value, map);
  }
}

export function createPiiFirewall(options: PiiFirewallOptions = {}): PiiFirewall {
  return new PiiFirewall(options);
}

/**
 * Returns a ready-to-register `beforeModelDispatch` hook for `SField.create({ hooks: [...] })`
 * that enforces zero-leakage PII tokenization across every model call.
 */
export function createPiiFirewallHook(
  firewall: PiiFirewall,
  opts: {
    id?: string;
    onRedaction?: (info: { runId: string; tokens: PiiRedactionToken[] }) => void;
  } = {},
): RegisteredHook {
  return {
    id: opts.id ?? "sfield-pii-egress-firewall",
    point: "beforeModelDispatch",
    timeoutMs: 1_000,
    onFailure: "fail",
    seesProtectedContent: true,
    buildIdentity: "sfield-pii-firewall-v1",
    async beforeModelDispatch({ request, runId }) {
      if (!firewall.enabled) return;
      const scrubbed = firewall.scrubModelRequest(request, runId);
      if (scrubbed.tokens.length > 0) {
        opts.onRedaction?.({ runId, tokens: scrubbed.tokens });
        return { request: scrubbed.request };
      }
    },
  };
}
