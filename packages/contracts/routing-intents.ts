import host from "../../fixtures/host.json";
import type { ContextCatalog, Intent } from "./domain";

type IntentDefinition = { intentId: string; label: string; description: string } & (
  | { contextId: string; task: Exclude<Intent["task"], "unknown"> }
  | { contextId: null; task: "create_rule" }
);

export const routingIntents = [
  { intentId: "explain_balance", label: "Understand balances", contextId: "balance", task: "explain", description: "Learn what an available, current, or ledger balance means." },
  { intentId: "compare_balances", label: "Compare balances", contextId: "balance", task: "compare", description: "Compare what available balance and current balance mean." },
  { intentId: "show_balance", label: "Show balances", contextId: "balance", task: "show", description: "Show the available or current balance amounts." },
  { intentId: "explain_portfolio", label: "Understand portfolios", contextId: "portsum", task: "explain", description: "Learn what the portfolio view, holdings, or allocation labels mean." },
  { intentId: "show_portfolio", label: "Show portfolio summary", contextId: "portsum", task: "show", description: "Show the customer's portfolio value, cash, holdings, or allocation." },
  { intentId: "show_home_goal", label: "Show home-buying goal", contextId: "goals", task: "show", description: "Show the home down payment target, current savings, remaining gap, or savings history. Includes short requests such as 'goals' and questions about the status of the existing goal." },
  { intentId: "retirement_learning", label: "Learn about retirement", contextId: "learning", task: "explain", description: "Learn about retirement planning or beneficiary designations, including a confirmed interest in retirement when leaving work." },
  { intentId: "beneficiary_update_steps", label: "Review beneficiary update steps", contextId: "learning", task: "guide", description: "See the steps to review or add a beneficiary." },
  { intentId: "update_address", label: "Update mailing address", contextId: "address-update", task: "guide", description: "Walk through a mailing or residential address change, including when a customer has moved or needs account correspondence sent to a new address." },
  { intentId: "learn_transfers", label: "Learn about the app", contextId: "app-home", task: "explain", description: "Get app help or learn how transfers work." },
  { intentId: "guide_transfer", label: "Walk through a transfer", contextId: "app-home", task: "guide", description: "See the steps for a transfer preview." },
  { intentId: "suggest_next_step", label: "Suggest a next step", contextId: "next-step", task: "guide", description: "Find a personalized next action for the account. Includes open-ended requests such as 'what is next' and 'what should I do now?'." },
  { intentId: "create_rule", label: "Create an eligibility rule", contextId: null, task: "create_rule", description: "An explicit request to create or add a Treatment Selector rule." },
] as const satisfies readonly IntentDefinition[];

export type RoutingIntent = typeof routingIntents[number];
export type RoutingIntentId = RoutingIntent["intentId"];

export function availableRoutingIntents(catalog: ContextCatalog, canCreateRule: boolean) {
  const contexts = new Set(catalog.contexts.filter(({ active }) => active).map(({ contextId }) => contextId));
  return routingIntents.filter(({ contextId }) => contextId === null ? canCreateRule : contexts.has(contextId));
}

export const retirementQuestion = "Are you looking for general retirement planning information?";
export const leavingWorkQuestion = "Would you like general retirement planning information as you leave your job?";
export const portfolioSummaryQuestion = "Did you mean your portfolio summary?";
export const demoExperiencesQuestion = host.clarificationQuestions[0];
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
    ? intents.find((intent): intent is Extract<RoutingIntent, { intentId: "compare_balances" }> => intent.intentId === "compare_balances") : undefined;
}

export function isSubjectlessSummaryRequest(request: string) {
  const text = request.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "")
    .replace(/^(?:please,? |(?:can|could|would) (?:you|i) )/, "").replace(/,? please$/, "");
  return /^(?:(?:show|see|give|view|display|get|pull up)(?: me)? )?(?:(?:the|my|a|that) )?summary$/.test(text);
}

export function resolveSummaryFollowUp(request: string, recent: RoutingHistoryEntry[], intents: readonly RoutingIntent[]) {
  if (!isSubjectlessSummaryRequest(request)) return;
  const previousTopic = recent.findLast(({ contextId, clarificationQuestion, intentId }) => (
    contextId !== null || clarificationQuestion !== null || intentId === "create_rule"
  ));
  if (!previousTopic?.contextId || previousTopic.clarificationQuestion) return;
  return intents.find((intent): intent is Extract<RoutingIntent, { task: "show" }> => (
    intent.task === "show" && intent.contextId === previousTopic.contextId
  ));
}
