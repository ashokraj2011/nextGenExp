import host from "../../fixtures/host.json";
import type { ContextCatalog, Intent } from "./domain";
import { getActiveExperienceRegistryLookup } from "../experience-registry/registry";

export type IntentDefinition = { intentId: string; label: string; description: string } & (
  | { contextId: string; task: Exclude<Intent["task"], "unknown"> }
  | { contextId: null; task: "create_rule" }
);

export const routingIntents = [
  { intentId: "explain_balance", label: "Understand balances", contextId: "balance", task: "explain", description: "Learn what an available, current, or ledger balance means." },
  { intentId: "compare_balances", label: "Compare balances", contextId: "balance", task: "compare", description: "Compare what available balance and current balance mean." },
  { intentId: "show_balance", label: "Show balances", contextId: "balance", task: "show", description: "Show the available or current balance amounts." },
  { intentId: "explain_portfolio", label: "Understand portfolios", contextId: "portsum", task: "explain", description: "Learn what the portfolio view, holdings, or allocation labels mean." },
  { intentId: "show_portfolio", label: "Show portfolio summary", contextId: "portsum", task: "show", description: "Show the customer's portfolio value, cash, holdings, allocation, or investing options for deploying idle cash and investing more." },
  { intentId: "show_home_goal", label: "Show home-buying goal", contextId: "goals", task: "show", description: "Show the home down payment target, current savings, remaining gap, or savings history. Includes short requests such as 'goals' and questions about the status of the existing goal." },
  { intentId: "list_retirement_accounts", label: "Show my retirement accounts", contextId: "learning", task: "show", description: "List the retirement accounts this customer holds, including workplace plans and IRAs. Use for a personal account inventory." },
  { intentId: "show_account_beneficiary", label: "Check an account beneficiary", contextId: "learning", task: "show", description: "Look up the actual beneficiary designation on one retirement account. Resolve references such as the second one or an account ending from the accounts displayed in recent chat." },
  { intentId: "retirement_learning", label: "Learn about retirement", contextId: "learning", task: "explain", description: "Learn about retirement planning or beneficiary designations, including a confirmed interest in retirement when leaving work." },
  { intentId: "beneficiary_update_steps", label: "Review beneficiary update steps", contextId: "learning", task: "guide", description: "See the steps to review or add a beneficiary." },
  { intentId: "update_address", label: "Update mailing address", contextId: "address-update", task: "guide", description: "Walk through a mailing or residential address change, including when a customer has moved or needs account correspondence sent to a new address." },
  { intentId: "learn_transfers", label: "Learn about the app", contextId: "app-home", task: "explain", description: "Get app help or learn how transfers work." },
  { intentId: "guide_transfer", label: "Walk through a transfer", contextId: "app-home", task: "guide", description: "See the steps for a transfer preview." },
  { intentId: "suggest_next_step", label: "Suggest a next step", contextId: "next-step", task: "guide", description: "Find a personalized next action for the account, including funding or adding money to an account, 'what is next', and 'what should I do now?'." },
  { intentId: "create_rule", label: "Create an eligibility rule", contextId: null, task: "create_rule", description: "An explicit request to create or add a Treatment Selector rule." },
] as const satisfies readonly IntentDefinition[];

export type RoutingIntent = IntentDefinition;
export type RoutingIntentId = string;

export function allRoutingIntents(): RoutingIntent[] {
  const overrides = getActiveExperienceRegistryLookup()?.getIntentOverrides();
  if (!overrides || overrides.size === 0) return [...routingIntents];
  const merged: RoutingIntent[] = [];
  const seen = new Set<string>();
  for (const base of routingIntents) {
    seen.add(base.intentId);
    if (base.contextId === null) {
      merged.push(base);
      continue;
    }
    const override = overrides.get(base.intentId);
    if (override) {
      if (!override.enabled) continue;
      const sampleText = override.samplePhrases.length ? ` Examples: ${override.samplePhrases.join("; ")}.` : "";
      merged.push({
        intentId: override.intentId,
        label: override.label,
        contextId: override.contextId,
        task: override.task,
        description: override.description + sampleText,
      });
    } else {
      merged.push(base);
    }
  }
  for (const custom of overrides.values()) {
    if (seen.has(custom.intentId) || !custom.enabled) continue;
    const sampleText = custom.samplePhrases.length ? ` Examples: ${custom.samplePhrases.join("; ")}.` : "";
    merged.push({
      intentId: custom.intentId,
      label: custom.label,
      contextId: custom.contextId,
      task: custom.task,
      description: custom.description + sampleText,
    });
  }
  return merged;
}

export function availableRoutingIntents(catalog: ContextCatalog, canCreateRule: boolean) {
  const contexts = new Set(catalog.contexts.filter(({ active }) => active).map(({ contextId }) => contextId));
  return allRoutingIntents().filter(({ contextId }) => contextId === null ? canCreateRule : contexts.has(contextId));
}

export const retirementQuestion = "Are you looking for general retirement planning information?";
export const leavingWorkQuestion = "Would you like general retirement planning information as you leave your job?";
export const portfolioSummaryQuestion = "Did you mean your portfolio summary?";
export const demoExperiencesQuestion = host.clarificationQuestions[0];
export const unsupportedTopicsSummary = "reviewing your portfolio (including pie charts or comparison tables), tracking your home-buying goal, checking stock holdings or trades, comparing balances, learning about retirement, or walking through an address change or transfer";

export function formatUnsupportedReply(userMessage: string): string {
  const clean = userMessage.trim();
  if (/\b(?:set\s*up|setup|create|add|start|open|new)\b.*\bgoals?\b|\banother\s+goal\b/i.test(clean)) {
    return `I can’t set up a new goal right now — currently I can track your existing home-buying goal. Here are the things we can chat about: ${unsupportedTopicsSummary}. What would you like to explore?`;
  }
  if (/\b(?:weather|forecast|temperature)\b/i.test(clean)) {
    return `I can’t check live weather right now, but here are the things we can chat about: ${unsupportedTopicsSummary}. What would you like to explore?`;
  }
  if (/\b(?:stock\s+price|market\s+prediction|which\s+stock\s+should|pick\s+a\s+stock)\b/i.test(clean)) {
    return `I can’t give live market quotes or stock picks right now, but here are the things we can chat about: ${unsupportedTopicsSummary}. What would you like to explore?`;
  }
  if (/\b(?:mortgage\s+rate|loan\s+application|apply\s+for\s+a\s+loan)\b/i.test(clean)) {
    return `I can’t process loan applications or quote live mortgage rates right now, but here are the things we can chat about: ${unsupportedTopicsSummary}. What would you like to explore?`;
  }
  return `I can’t do that right now, but here are the things we can chat about: ${unsupportedTopicsSummary}. What would you like to explore?`;
}
export const routingQuestions = [...host.clarificationQuestions, retirementQuestion, leavingWorkQuestion, portfolioSummaryQuestion];
export const ROUTING_HISTORY_TURNS = 4;
export const ROUTING_HISTORY_REQUEST_LENGTH = 350;
export const ROUTING_HISTORY_REPLY_LENGTH = 1600;
export type RoutingHistoryEntry = {
  request: string;
  contextId: string | null;
  intentId: RoutingIntentId | null;
  clarificationQuestion: string | null;
  assistantReply?: string;
  displayedContent?: string[];
};

export function explicitBalanceComparison(request: string, intents: readonly RoutingIntent[]) {
  const text = request.toLowerCase();
  const asksToCompare = /\b(?:compare|difference|versus|vs)\b/.test(text);
  return asksToCompare && /\bavailable\b/.test(text) && /\bcurrent\b/.test(text) && /\bbalances?\b/.test(text)
    ? intents.find((intent) => intent.intentId === "compare_balances") : undefined;
}

export function isSubjectlessSummaryRequest(request: string) {
  const text = request.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "")
    .replace(/^(?:please,? |(?:can|could|would) (?:you|i) )/, "").replace(/,? please$/, "");
  return /^(?:(?:show|see|give|view|display|get|pull up)(?: me)? )?(?:(?:the|my|a|that) )?summary$/.test(text);
}

export function resolveInvestMoreFallback(request: string, intents: readonly RoutingIntent[], isUnfunded: boolean) {
  const text = request.toLowerCase();
  const asksSpecificStock = /\b(?:which|what)\s+(?:stock|stocks|etf|ticker|crypto|coin)|stock\s+price|buy\s+(?:aapl|tsla|nvda|msft|bitcoin)/i.test(text);
  if (asksSpecificStock) return undefined;
  const asksToInvestMore = /\b(?:how\s+(?:can|do|should)\s+i\s+invest|invest(?:ing)?\s+(?:more|my\s+cash|extra|additional|options)|put\s+(?:my\s+)?cash\s+to\s+work|deploy\s+(?:my\s+)?cash|options\s+for\s+(?:my\s+)?(?:\$[\d,]+\s+)?cash|add\s+more\s+(?:money|funds)\s+to\s+invest)\b/i.test(text);
  if (!asksToInvestMore) return undefined;
  if (isUnfunded) {
    return intents.find((intent) => intent.intentId === "suggest_next_step")
      ?? intents.find((intent) => intent.intentId === "show_portfolio");
  }
  return intents.find((intent) => intent.intentId === "show_portfolio");
}

export function resolveSummaryFollowUp(request: string, recent: RoutingHistoryEntry[], intents: readonly RoutingIntent[]) {
  if (!isSubjectlessSummaryRequest(request)) return;
  const previousTopic = recent.findLast(({ contextId, clarificationQuestion, intentId }) => (
    contextId !== null || clarificationQuestion !== null || intentId === "create_rule"
  ));
  if (!previousTopic?.contextId || previousTopic.clarificationQuestion) return;
  return intents.find((intent) => (
    intent.task === "show" && intent.contextId === previousTopic.contextId
  ));
}
