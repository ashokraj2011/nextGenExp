/**
 * Rolling conversation compaction & structured summarization service for sfield (§12.5).
 *
 * Keeps long conversations sharp without losing exact figures, user preferences, or active goals:
 * - Compacts older turns (outside the verbatim recent window) into a structured `RollingThreadSummary`
 * - Persists summaries as derived `MemoryItem` records (`kind: "summary"`, `origin: "derived"`)
 *   under the conversation scope, leveraging MemoryService supersession & audit logging
 * - Supports optional LLM compaction with a fast deterministic extractive fallback
 */
import type { JsonObject, Principal } from "../types/common.js";
import type { MemoryItem } from "../types/memory.js";
import type { MemoryService } from "../memory/service.js";
import { digestJson, nowIso } from "../util/digest.js";

export const ROLLING_SUMMARY_KEY = "rolling_thread_summary";

export interface CompactorTurnInput {
  ordinal: number;
  turnId: string;
  userMessage: string;
  assistantReply: string;
  intentId?: string | null;
  displayedContent?: string[];
  clarificationQuestion?: string | null;
}

export interface RollingThreadSummary {
  activeGoal: string;
  userPreferences: string[];
  establishedFacts: string[];
  decisionsAndActions: string[];
  openClarifications: string[];
  coveredThroughOrdinal: number;
  turnCountCovered: number;
  method: "llm" | "extractive";
  updatedAt: string;
}

export interface CompactThreadInput {
  principal: Principal;
  conversationId: string;
  turns: CompactorTurnInput[];
  /** Number of newest turns kept verbatim (excluded from compaction). Defaults to 4. */
  verbatimWindow?: number;
  /** Minimum new turns since last summary before triggering compaction. Defaults to 4. */
  compactEveryTurns?: number;
  /** Force compaction even if below threshold. */
  force?: boolean;
  /** Optional LLM summarizer callback returning a partial/full RollingThreadSummary JSON object. */
  summarizeFn?: (prompt: string) => Promise<Partial<RollingThreadSummary> | null>;
}

export interface CompactThreadResult {
  compacted: boolean;
  summary: RollingThreadSummary | null;
  memoryItem?: MemoryItem;
}

const FACT_SIGNAL = /(\$[\d,]+(?:\.\d{1,2})?|\b\d+(?:\.\d+)?%|\b(?:DEAL|INC|ORD)-[A-Z0-9]+\b|\b(?:AAPL|MSFT|NVDA|INTC|BA|PFE|VOO)\b)/i;
const PREF_SIGNAL = /\b(pie\s*chart|bar\s*chart|table|bullet\s*points?|prefer|guided|standard|pro\s+mode|concise|detailed)\b/i;

function dedupeStrings(items: string[], max: number, maxLen = 180): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const clean = raw.replace(/\s+/g, " ").trim().slice(0, maxLen);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

function parseStoredSummary(item: MemoryItem | undefined): RollingThreadSummary | null {
  if (!item?.structured?.value || typeof item.structured.value !== "object" || Array.isArray(item.structured.value)) {
    return null;
  }
  const v = item.structured.value as Record<string, unknown>;
  if (typeof v["coveredThroughOrdinal"] !== "number") return null;
  return {
    activeGoal: typeof v["activeGoal"] === "string" ? v["activeGoal"] : "Ongoing customer conversation",
    userPreferences: Array.isArray(v["userPreferences"]) ? v["userPreferences"].filter((x): x is string => typeof x === "string") : [],
    establishedFacts: Array.isArray(v["establishedFacts"]) ? v["establishedFacts"].filter((x): x is string => typeof x === "string") : [],
    decisionsAndActions: Array.isArray(v["decisionsAndActions"]) ? v["decisionsAndActions"].filter((x): x is string => typeof x === "string") : [],
    openClarifications: Array.isArray(v["openClarifications"]) ? v["openClarifications"].filter((x): x is string => typeof x === "string") : [],
    coveredThroughOrdinal: v["coveredThroughOrdinal"],
    turnCountCovered: typeof v["turnCountCovered"] === "number" ? v["turnCountCovered"] : v["coveredThroughOrdinal"],
    method: v["method"] === "llm" ? "llm" : "extractive",
    updatedAt: typeof v["updatedAt"] === "string" ? v["updatedAt"] : item.updatedAt,
  };
}

export function buildExtractiveSummary(
  olderTurns: CompactorTurnInput[],
  prior: RollingThreadSummary | null,
): RollingThreadSummary {
  const facts = [...(prior?.establishedFacts ?? [])];
  const prefs = [...(prior?.userPreferences ?? [])];
  const decisions = [...(prior?.decisionsAndActions ?? [])];
  const clarifications: string[] = [];

  for (const t of olderTurns) {
    if (FACT_SIGNAL.test(t.assistantReply)) {
      facts.push(t.assistantReply.slice(0, 170));
    } else if (FACT_SIGNAL.test(t.userMessage)) {
      facts.push(`User mentioned: ${t.userMessage.slice(0, 150)}`);
    }
    if (PREF_SIGNAL.test(t.userMessage)) {
      prefs.push(`Requested: "${t.userMessage.slice(0, 100)}"`);
    }
    if (t.displayedContent?.length) {
      decisions.push(`Viewed ${t.displayedContent.slice(0, 2).join(", ")} (turn ${t.ordinal})`);
    } else if (t.intentId) {
      decisions.push(`Handled ${t.intentId} (turn ${t.ordinal})`);
    }
    if (t.clarificationQuestion) {
      clarifications.push(t.clarificationQuestion.slice(0, 150));
    }
  }

  const lastOlder = olderTurns[olderTurns.length - 1];
  const activeGoal = lastOlder
    ? `Discussing: ${lastOlder.userMessage.slice(0, 140)}`
    : (prior?.activeGoal ?? "General account engagement");

  const maxOrdinal = olderTurns.reduce((m, t) => Math.max(m, t.ordinal), prior?.coveredThroughOrdinal ?? 0);

  return {
    activeGoal,
    userPreferences: dedupeStrings(prefs, 6),
    establishedFacts: dedupeStrings(facts, 10),
    decisionsAndActions: dedupeStrings(decisions, 8),
    openClarifications: dedupeStrings(clarifications.slice(-2), 2),
    coveredThroughOrdinal: maxOrdinal,
    turnCountCovered: Math.max(prior?.turnCountCovered ?? 0, olderTurns.length),
    method: "extractive",
    updatedAt: nowIso(),
  };
}

export function formatRollingSummary(summary: RollingThreadSummary): string {
  const lines: string[] = [
    `ROLLING CONVERSATION SUMMARY (through turn ${summary.coveredThroughOrdinal}):`,
    `Active Goal: ${summary.activeGoal}`,
  ];
  if (summary.establishedFacts.length) {
    lines.push(`Established Facts:\n${summary.establishedFacts.map((f) => `- ${f}`).join("\n")}`);
  }
  if (summary.userPreferences.length) {
    lines.push(`User Preferences:\n${summary.userPreferences.map((p) => `- ${p}`).join("\n")}`);
  }
  if (summary.decisionsAndActions.length) {
    lines.push(`Completed Steps:\n${summary.decisionsAndActions.map((d) => `- ${d}`).join("\n")}`);
  }
  if (summary.openClarifications.length) {
    lines.push(`Open Questions:\n${summary.openClarifications.map((q) => `- ${q}`).join("\n")}`);
  }
  return lines.join("\n").slice(0, 3800);
}

export class ConversationCompactor {
  constructor(private readonly memory: MemoryService) {}

  async getSummary(principal: Principal, conversationId: string): Promise<RollingThreadSummary | null> {
    const scope = { kind: "conversation" as const, tenantId: principal.tenantId, conversationId };
    const items = await this.memory.listForContext(principal, scope, "summary", 5).catch(() => []);
    const target = items.find((i) => i.structured?.key === ROLLING_SUMMARY_KEY) ?? items[0];
    return parseStoredSummary(target);
  }

  async compactIfNeeded(input: CompactThreadInput): Promise<CompactThreadResult> {
    const verbatimWindow = Math.max(1, input.verbatimWindow ?? 4);
    const compactEveryTurns = Math.max(1, input.compactEveryTurns ?? 4);
    const ordered = [...input.turns].sort((a, b) => a.ordinal - b.ordinal);
    const prior = await this.getSummary(input.principal, input.conversationId);

    const compactableCount = ordered.length - verbatimWindow;
    if (!input.force && compactableCount <= 0) {
      return { compacted: false, summary: prior };
    }
    const olderTurns = compactableCount > 0 ? ordered.slice(0, compactableCount) : ordered;
    const latestCompactableOrdinal = olderTurns[olderTurns.length - 1]?.ordinal ?? 0;
    const priorCovered = prior?.coveredThroughOrdinal ?? 0;
    const newlyCompactable = olderTurns.filter((t) => t.ordinal > priorCovered);

    if (!input.force && newlyCompactable.length < compactEveryTurns) {
      return { compacted: false, summary: prior };
    }
    if (newlyCompactable.length === 0 && prior) {
      return { compacted: false, summary: prior };
    }

    let nextSummary = buildExtractiveSummary(newlyCompactable.length ? newlyCompactable : olderTurns, prior);

    if (input.summarizeFn) {
      try {
        const prompt = [
          prior ? `PRIOR SUMMARY:\n${formatRollingSummary(prior)}` : "PRIOR SUMMARY: (none)",
          "NEW TURNS TO FOLD INTO SUMMARY:",
          ...(newlyCompactable.length ? newlyCompactable : olderTurns).map(
            (t) => `Turn ${t.ordinal} | User: ${t.userMessage.slice(0, 220)} | Assistant: ${t.assistantReply.slice(0, 320)}${t.displayedContent?.length ? ` | Cards: ${t.displayedContent.join(", ")}` : ""}`,
          ),
          "Return ONLY JSON: { activeGoal, userPreferences: string[], establishedFacts: string[], decisionsAndActions: string[], openClarifications: string[] }. Preserve exact numbers and entity IDs.",
        ].join("\n");
        const llmOut = await input.summarizeFn(prompt);
        if (llmOut && typeof llmOut.activeGoal === "string" && llmOut.activeGoal.trim()) {
          nextSummary = {
            activeGoal: llmOut.activeGoal.trim().slice(0, 200),
            userPreferences: dedupeStrings([...(llmOut.userPreferences ?? []), ...nextSummary.userPreferences], 6),
            establishedFacts: dedupeStrings([...(llmOut.establishedFacts ?? []), ...nextSummary.establishedFacts], 10),
            decisionsAndActions: dedupeStrings([...(llmOut.decisionsAndActions ?? []), ...nextSummary.decisionsAndActions], 8),
            openClarifications: dedupeStrings(llmOut.openClarifications ?? nextSummary.openClarifications, 3),
            coveredThroughOrdinal: Math.max(latestCompactableOrdinal, priorCovered),
            turnCountCovered: olderTurns.length,
            method: "llm",
            updatedAt: nowIso(),
          };
        }
      } catch {
        // Keep extractive summary on LLM failure.
      }
    }

    const content = formatRollingSummary(nextSummary);
    const scope = { kind: "conversation" as const, tenantId: input.principal.tenantId, conversationId: input.conversationId };
    const idempotencyKey = `compact:${input.conversationId}:${nextSummary.coveredThroughOrdinal}:${digestJson(nextSummary).slice(7, 15)}`;
    const provenance = (newlyCompactable.length ? newlyCompactable : olderTurns).slice(-6).map((t) => ({
      sourceType: "message" as const,
      sourceId: t.turnId,
      observedAt: nextSummary.updatedAt,
    }));

    const memoryItem = await this.memory.put(
      input.principal,
      {
        scope,
        kind: "summary",
        origin: "derived",
        content,
        structured: { key: ROLLING_SUMMARY_KEY, value: nextSummary as unknown as JsonObject },
        provenance: provenance.length ? provenance : [{ sourceType: "host", sourceId: input.conversationId, observedAt: nextSummary.updatedAt }],
      },
      { idempotencyKey },
    );

    return { compacted: true, summary: nextSummary, memoryItem };
  }
}
