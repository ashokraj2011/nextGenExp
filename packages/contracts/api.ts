import type { SelectionMode } from "./domain";
import type { GoalProgress } from "./goal-progress";
import type { PortfolioHistoryPoint, PortfolioSnapshot } from "./portfolio";
import type { DisplayExperience } from "./surface";
import type { WorkspacePin } from "./workspace";

export type Progress = "accepted" | "catalog" | "routing" | "glossary" | "eligibility" | "portfolio" | "goal" | "composition" | "verifying" | "workflow" | "planning";
export const progressLabels: Record<Progress, string> = {
  planning: "Putting your request together",
  accepted: "Getting your request ready",
  catalog: "Checking available topics",
  routing: "Finding the right topic",
  glossary: "Loading the rule fields",
  eligibility: "Finding matching content",
  portfolio: "Loading your portfolio",
  goal: "Reading your home-buying goal",
  composition: "Preparing your response",
  verifying: "Checking the response",
  workflow: "Preparing your funding preview",
};
export const failureCopy = {
  experience_unavailable: "I couldn’t finish this plan. Try again to refresh it.",
  catalog_unavailable: "We couldn’t load the available topics. Please try again.",
  route_rejected: "We couldn’t confirm the topic for this request. Please try again.",
  glossary_unavailable: "We couldn’t load the rule fields. Check CCRE glossary in Tool setup and try again.",
  ts_unavailable: "We couldn’t check which content fits this request. Please try again.",
  portfolio_unavailable: "We couldn’t load your portfolio snapshot. Please try again.",
  goal_unavailable: "We couldn’t load your home-buying goal. Please try again.",
  workflow_unavailable: "We couldn’t prepare your funding preview. Please try again.",
  content_unavailable: "I couldn’t load the matching content. You can try again or ask another question.",
  gateway_unavailable: "The assistant is temporarily unavailable. Please try again.",
  verification_failed: "We couldn’t check the reply. Please try again.",
  metric_unavailable: "We couldn’t load your balances. Please try again.",
  turn_timeout: "This request took too long. Please try again.",
  restarted: "The app restarted during your request. Please try again.",
  internal_error: "Something went wrong while preparing your response. Please try again.",
} as const;
export type FailureCode = keyof typeof failureCopy;
export type TurnStatus = "working" | "completed" | "failed" | "cancelled";
export type TurnView = {
  id: string;
  conversationId: string;
  message: string;
  createdAt: number;
  status: TurnStatus;
  progress: Progress;
  experience?: DisplayExperience;
  failureCode?: FailureCode;
  retryOf?: string;
  feedback?: "helpful" | "unhelpful";
};
export type Conversation = {
  id: string; title: string; personaId: string; scenarioId: string; updatedAt: number;
  archivedAt?: number;
  audience?: "admin";
};
export type ConversationChange = { operation: "rename"; title: string } | { operation: "archive" | "restore" };
export type ConversationView = Conversation & { turns: TurnView[] };
export type DemoPersona = {
  personaId: string;
  displayName: string;
  allowedScenarios: string[];
  profile: {
    beneficiaryStatus: "missing" | "on_file";
    accountFundingStatus: "funded" | "unfunded";
    cashCents: number | null;
  };
  overview?: {
    portfolio: PortfolioSnapshot | null;
    portfolioHistory?: PortfolioHistoryPoint[];
    homeGoal: GoalProgress | null;
  };
  pins?: WorkspacePin[];
};
export type Bootstrap = {
  conversations: Conversation[];
  personas: DemoPersona[];
  scenarios: { scenarioId: string; label: string }[];
  defaultPersonaId: string;
  defaultScenarioId: string;
  mode: "live" | "test";
  gatewayConfigured: boolean;
  openAiModel?: string;
  copilotModel?: string;
  selectionMode: SelectionMode;
  inspectorEnabled: boolean;
};
export type TurnAccepted = { turnId: string; eventsUrl: string; turn: TurnView; conversation: Conversation };
export type PublicEventType = "turn.accepted" | "turn.status" | "experience.ready" | "turn.failed" | "turn.cancelled";
export type PublicEvent = {
  eventId: string;
  sequence: number;
  conversationId: string;
  turnId: string;
  type: PublicEventType;
  payload: Record<string, unknown>;
};
