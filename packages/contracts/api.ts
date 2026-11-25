import type { SelectionMode } from "./domain";
import type { GoalProgress } from "./goal-progress";
import type { PiiRedactionTrace } from "./pii-firewall";
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
export type ActionMode = "plain_chat" | "verified_experience" | "dynamic_ui" | "clarify";
export type CustomerLookupSummary = {
  personaName: string;
  fundingStatus: "funded" | "unfunded";
  highlights: string[];
  nbaSelected?: string;
};
export type NextBestActionCard = {
  id: string;
  priority: "urgent" | "opportunity" | "goal";
  kicker: string;
  title: string;
  body: string;
  reason: string;
  ctaLabel: string;
  actionKind: "prompt" | "preview_funding";
  prompt?: string;
};
export type ProviderArbitrationTrace = {
  toolRef: string;
  domain: "wealth" | "operations" | "sales" | "general";
  decisionId: string;
  winnerTitle?: string;
  providers: {
    providerId: string;
    providerLabel: string;
    status: "ok" | "skipped" | "error";
    candidateCount: number;
    elapsedMs: number;
    note?: string;
  }[];
};
export type DomainWriteAuditEntry = {
  auditId: string;
  sfieldRunId: string;
  sfieldToolRef: string;
  domain: "ops_incident" | "sales_deal" | "customer360" | "external_connector" | "stock_trade" | "workflow" | "pzn_self_service" | "integration";
  recordId: string;
  action: string;
  actor: string;
  summary: string;
  status: "succeeded" | "denied";
  approvalId?: string;
  createdAt: string;
};
export type EngagementAnalyticsView = {
  turnsTotal: number;
  turnsCompleted: number;
  modeBreakdown: {
    verifiedExperience: number;
    dynamicUi: number;
    plainChat: number;
    clarify: number;
  };
  surfacesRendered: number;
  feedbackHelpful: number;
  feedbackUnhelpful: number;
  nbaDismissals: number;
  governedWritesTotal: number;
  writesByDomain: {
    opsIncident: number;
    salesDeal: number;
    customer360: number;
    externalConnector: number;
  };
  pendingApprovalsCount?: number;
  recentWrites: DomainWriteAuditEntry[];
};
export type SemanticRouteTrace = {
  capabilityId: string;
  capabilityLabel: string;
  method: "llm_semantic" | "deterministic";
  confidence: number;
  reasoning: string;
};
export type TurnView = {
  id: string;
  conversationId: string;
  message: string;
  createdAt: number;
  status: TurnStatus;
  progress: Progress;
  actionMode?: ActionMode;
  semanticRoute?: SemanticRouteTrace;
  customerLookup?: CustomerLookupSummary;
  providerArbitration?: ProviderArbitrationTrace;
  piiRedaction?: PiiRedactionTrace;
  nextBestAction?: NextBestActionCard;
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
  intentPrompts?: { intentId: string; label: string; prompt: string; isCustom: boolean }[];
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
