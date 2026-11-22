import host from "../../fixtures/host.json";
import type { ContextCatalog, Intent } from "./domain";

type IntentDefinition = { intentId: string; label: string; description: string } & (
  | { contextId: string; task: Exclude<Intent["task"], "unknown"> }
  | { contextId: null; task: "create_rule" }
);

export const routingIntents = [
  { intentId: "explain_balance", label: "Understand balances", contextId: "balance", task: "explain", description: "Learn what an available, current, or ledger balance means." },
  { intentId: "compare_balances", label: "Compare balances", contextId: "balance", task: "compare", description: "Compare the meaning of two demo balance labels." },
  { intentId: "show_balance", label: "Show demo balances", contextId: "balance", task: "show", description: "Retrieve the actual synthetic available or current balance amounts." },
  { intentId: "explain_portfolio", label: "Understand portfolios", contextId: "portsum", task: "explain", description: "Learn what the portfolio view, holdings, or allocation labels mean." },
  { intentId: "show_portfolio", label: "Show portfolio summary", contextId: "portsum", task: "show", description: "Show the customer's synthetic portfolio value, cash, holdings, or allocation." },
  { intentId: "retirement_learning", label: "Learn about retirement", contextId: "learning", task: "explain", description: "Learn about retirement planning or beneficiary designations, including a confirmed interest in retirement when leaving work." },
  { intentId: "beneficiary_update_steps", label: "Review beneficiary update steps", contextId: "learning", task: "guide", description: "See the demo steps to review or add a beneficiary." },
  { intentId: "learn_transfers", label: "Learn about the demo app", contextId: "app-home", task: "explain", description: "Get explicit demo app help or learn about the fictional transfer flow." },
  { intentId: "guide_transfer", label: "Walk through a transfer", contextId: "app-home", task: "guide", description: "See the steps for the fictional transfer preview." },
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
export const routingQuestions = [...host.clarificationQuestions, retirementQuestion, leavingWorkQuestion];
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
