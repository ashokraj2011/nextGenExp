import rawContent from "../../fixtures/content-catalog.json";
import { contentEntrySchema, type ContentEntry } from "../contracts/domain";
import type { ManagedIntentInput, ManagedNbaRuleInput } from "../contracts/experience-registry";

export type EffectiveRoutingIntent = {
  intentId: string;
  label: string;
  contextId: string | null;
  task: "explain" | "compare" | "guide" | "show" | "create_rule";
  description: string;
  samplePhrases?: string[];
  enabled?: boolean;
};

export const builtInContentEntries: ContentEntry[] = rawContent.entries.map((entry) => contentEntrySchema.parse(entry));
export const builtInContentById = new Map(builtInContentEntries.map((entry) => [entry.contentId, entry]));

export const builtInNbaRules: ManagedNbaRuleInput[] = [
  {
    id: "nba_fund_account",
    enabled: true,
    priority: "urgent",
    conditionKind: "unfunded_account",
    kicker: "Next Best Action · Account Readiness",
    title: "Fund your account to start investing",
    body: "Your account is open and ready for its first deposit. Preview a linked bank or cash management transfer in seconds.",
    reason: "Account funding status is currently unfunded.",
    ctaLabel: "Preview first deposit",
    actionKind: "preview_funding",
    dedupeKeywords: ["fund your account", "funding"],
    respectsPromotionExclusion: false,
  },
  {
    id: "nba_deploy_cash",
    enabled: true,
    priority: "opportunity",
    conditionKind: "cash_above_usd",
    thresholdUsd: 10000,
    kicker: "Next Best Action · Cash Optimization",
    title: "Put your {cash} cash reserve to work",
    body: "Your cash balance is above {threshold} ({cashPct}% of your portfolio). Explore investing options or simulate deploying part of it.",
    reason: "Cash balance ({cash}) exceeds the {threshold} threshold.",
    ctaLabel: "Review portfolio & simulate",
    actionKind: "prompt",
    prompt: "Let me know my portfolio summary.",
    dedupeKeywords: ["investing options"],
    respectsPromotionExclusion: true,
  },
  {
    id: "nba_update_beneficiaries",
    enabled: true,
    priority: "urgent",
    conditionKind: "beneficiary_missing",
    kicker: "Next Best Action · Account Protection",
    title: "Add a beneficiary to your account",
    body: "No beneficiary designation is currently on file. Reviewing or adding one takes just a few guided steps.",
    reason: "Beneficiary status on file is currently missing.",
    ctaLabel: "Review beneficiary steps",
    actionKind: "prompt",
    prompt: "I'd like to learn about retirement.",
    dedupeKeywords: ["beneficiar"],
    respectsPromotionExclusion: false,
  },
  {
    id: "nba_home_goal",
    enabled: true,
    priority: "goal",
    conditionKind: "has_home_goal",
    kicker: "Next Best Action · Goal Momentum",
    title: "Home down payment is {goalPct}% funded",
    body: "You have saved {goalSaved} toward your {goalTarget} goal. Explore how adjusting your monthly savings changes your timeline.",
    reason: "Active home-buying goal has {goalRemaining} remaining.",
    ctaLabel: "Model savings timeline",
    actionKind: "prompt",
    prompt: "I want to buy a house in two years. Show me how close I am and help me explore a savings plan.",
    dedupeKeywords: ["home down payment", "projected savings"],
    respectsPromotionExclusion: false,
  },
];

export type ExperienceRegistryLookup = {
  getIntentOverrides(): Map<string, ManagedIntentInput>;
  getContentEntries(): ContentEntry[];
  findContentById(contentId: string): ContentEntry | undefined;
  getNbaRules(): ManagedNbaRuleInput[];
};

let activeLookup: ExperienceRegistryLookup | null = null;

export function registerExperienceRegistryLookup(lookup: ExperienceRegistryLookup | null) {
  activeLookup = lookup;
}

export function getActiveExperienceRegistryLookup(): ExperienceRegistryLookup | null {
  return activeLookup;
}

export function getEffectiveContentEntries(): ContentEntry[] {
  return activeLookup ? activeLookup.getContentEntries() : builtInContentEntries;
}

export function findEffectiveContentById(contentId: string): ContentEntry | undefined {
  return activeLookup ? activeLookup.findContentById(contentId) : builtInContentById.get(contentId);
}

export function getEffectiveNbaRules(): ManagedNbaRuleInput[] {
  return activeLookup ? activeLookup.getNbaRules() : builtInNbaRules;
}
