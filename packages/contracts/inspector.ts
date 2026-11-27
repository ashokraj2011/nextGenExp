import type { JsonValue } from "@sfield/core";
import type { WorkflowRecommendation } from "./funding-workflow";
import type { TurnFlowCatalog } from "./routing-flows";
import type { CepCapabilityId } from "./capabilities-catalog";

export type InspectorPayload = {
  bytes: number;
  data?: JsonValue;
};

export type CallTiming = { startedAt: number; durationMs: number };
export type TimedCall = CallTiming & { status: string };
export type TurnExchange = { operation: string; request: InspectorPayload; response: InspectorPayload; timing?: TimedCall };
export type TurnExchangeStage = "submission" | "flowRouting" | "compiler";
export type TurnHandoffs = {
  flowRouting?: TurnExchange;
  submission?: TurnExchange;
  compiler?: TurnExchange;
  acceptedInput?: InspectorPayload;
  acceptedEvent?: InspectorPayload;
  readyEvent?: InspectorPayload;
  renderReceipt?: InspectorPayload;
  settings?: InspectorPayload;
};

export type GatewayExchange = {
  source: "recorded" | "verified";
  method: "POST" | "JSON-RPC";
  path?: string;
  request: InspectorPayload;
  response?: InspectorPayload;
};

function object(value: JsonValue | undefined) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function parseJson(text: JsonValue | undefined): JsonValue | undefined {
  if (typeof text !== "string") return undefined;
  try { return JSON.parse(text) as JsonValue; }
  catch { return undefined; }
}

/** Decode the chat envelope from the recorded HTTP or ACP request. */
export function decodeChatInput(exchange: GatewayExchange) {
  const body = object(exchange.request.data);
  const prompt = object(body?.params)?.prompt;
  const messages = exchange.method === "JSON-RPC" && Array.isArray(prompt)
    ? object(parseJson(object(prompt[0])?.text))?.messages : body?.messages;
  const user = Array.isArray(messages) ? messages.map(object).find((message) => message?.role === "user") : undefined;
  if (Array.isArray(user?.parts)) return parseJson(user.parts.map(object).find((part) => part?.type === "text")?.text);
  return parseJson(user?.content);
}

export type ModelStagePayloads = {
  session?: { request: InspectorPayload; output?: InspectorPayload };
  attempts: {
    id: string;
    model: string;
    status: string;
    timing?: CallTiming;
    exchange?: GatewayExchange;
    error?: InspectorPayload;
  }[];
  saved?: { input: InspectorPayload; responses: InspectorPayload[] };
};

export type RegistryToolPayloads = {
  tool: string;
  status: string;
  timing?: CallTiming;
  registryInput: InspectorPayload;
  result?: InspectorPayload;
  error?: InspectorPayload;
};

export type OfferClick = {
  turnId: string; label: string; kind: "action" | "workflow"; id: string; version: string;
};

export type TreatmentRun = {
  turnId: string; threadId: string; createdAt: number; message: string; clicks: OfferClick[];
};

export type TreatmentPayloads = RegistryToolPayloads & {
  fundingCheck?: import("./tool-setup").MockCcreEvaluation["fundingCheck"];
  mockInput?: InspectorPayload;
  inputReconstructed?: true;
  ccre?: InspectorPayload;
  comparison?: {
    legacy: InspectorPayload; workflows: InspectorPayload; returned: "legacy" | "workflows" | "decisions";
    contentReasons?: { id: string; source: string; matchingRules: string[] }[];
    reasons?: { kind: "action" | "workflow"; id: string; version: string; name: string; context: string;
      condition?: import("./tool-setup").MockCcreCondition; contentIds: string[] }[];
    rules: { name: string; contentId: string; workflowId: string }[];
  };
};

export type WorkflowPayloads = {
  recommendation: WorkflowRecommendation;
  definition?: InspectorPayload;
  calls: (RegistryToolPayloads & { label: string })[];
  agent?: {
    runId: string;
    outcome?: string;
    answer?: InspectorPayload;
    model: ModelStagePayloads;
  };
};

export type AgenticPayloads = {
  runId: string;
  model: ModelStagePayloads | null;
  calls: RegistryToolPayloads[];
};
export type TurnPayloads = {
  timing?: {
    acceptedAt: number;
    snapshotReadyAt?: number;
    snapshotDisplayedAt?: number;
    finishedAt?: number;
    displayedAt?: number;
    calls: (TimedCall & { label: string; parentLabel?: string })[];
  };
  sentFlowList?: Pick<TurnFlowCatalog, "tenantId" | "domainId" | "audience"> & { flowIds: CepCapabilityId[] };
  handoffs?: TurnHandoffs;
  verifiedIntent?: { intentId: string; contextId: string };
  catalogLookup?: RegistryToolPayloads;
  customerLookup?: RegistryToolPayloads;
  agentic?: AgenticPayloads;
  turnId: string;
  topicScores: TreatmentPayloads | null;
  router: ModelStagePayloads | null;
  glossary: RegistryToolPayloads | null;
  treatment: TreatmentPayloads | null;
  retirementAccounts?: RegistryToolPayloads;
  portfolio: RegistryToolPayloads | null;
  goal: RegistryToolPayloads | null;
  composer: ModelStagePayloads | null;
  workflow: WorkflowPayloads | null;
  sourceDecision?: { turnId: string; message: string; treatment: TreatmentPayloads };
  workflowClicks?: { id: string; label: string }[];
};
