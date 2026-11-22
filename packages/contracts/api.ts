import type { SelectionMode } from "./domain";
import type { DisplayExperience } from "./surface";

export type Progress = "accepted" | "catalog" | "routing" | "glossary" | "eligibility" | "portfolio" | "goal" | "composition" | "verifying";
export const progressLabels: Record<Progress, string> = {
  accepted: "Getting your request ready",
  catalog: "Checking available demo topics",
  routing: "Finding the right demo topic",
  glossary: "Loading the rule glossary",
  eligibility: "Finding eligible demo content",
  portfolio: "Reading your demo portfolio",
  goal: "Reading your home-buying goal",
  composition: "Preparing your response",
  verifying: "Checking the response",
};
export const failureCopy = {
  catalog_unavailable: "The demo topic catalog is unavailable. Please try again.",
  route_rejected: "We couldn’t verify a demo topic for this request. Please try again.",
  glossary_unavailable: "The rule glossary is unavailable. Check CCRE glossary in Tool setup and try again.",
  ts_unavailable: "We couldn’t retrieve eligible demo content. Please try again.",
  portfolio_unavailable: "The demo portfolio snapshot is unavailable. Please try again.",
  goal_unavailable: "The demo home-buying goal is unavailable. Please try again.",
  content_unavailable: "The eligible items are currently unavailable in the demo catalog. Please try again.",
  gateway_unavailable: "The model gateway is unavailable. Please try again.",
  verification_failed: "We couldn’t verify a response for this request. Please try again.",
  metric_unavailable: "The synthetic balance summary is unavailable. Please try again.",
  turn_timeout: "This request took too long. Please try again.",
  restarted: "This request was interrupted by a server restart. Please try again.",
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
};
export type ConversationView = Conversation & { turns: TurnView[] };
export type DemoPersona = {
  personaId: string;
  displayName: string;
  allowedScenarios: string[];
  profile: {
    focus: string;
    summary: string;
    beneficiaryStatus: "missing" | "on_file";
    cashCents: number | null;
  };
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
  selectionMode: SelectionMode;
  inspectorEnabled: boolean;
};
export type TurnAccepted = { turnId: string; eventsUrl: string; turn: TurnView };
export type PublicEventType = "turn.accepted" | "turn.status" | "experience.ready" | "turn.failed" | "turn.cancelled";
export type PublicEvent = {
  eventId: string;
  sequence: number;
  conversationId: string;
  turnId: string;
  type: PublicEventType;
  payload: Record<string, unknown>;
};
