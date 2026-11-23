import type { JsonValue } from "@sfield/core";
import type { WorkflowRecommendation } from "./funding-workflow";

export type InspectorPayload = {
  bytes: number;
  data?: JsonValue;
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
  attempts: {
    id: string;
    model: string;
    status: string;
    exchange?: GatewayExchange;
    error?: InspectorPayload;
  }[];
  saved?: { input: InspectorPayload; responses: InspectorPayload[] };
};

export type RegistryToolPayloads = {
  tool: string;
  status: string;
  registryInput: InspectorPayload;
  result?: InspectorPayload;
  error?: InspectorPayload;
};

export type TreatmentPayloads = RegistryToolPayloads & {
  mockInput?: InspectorPayload;
  ccre?: InspectorPayload;
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
  agentic?: AgenticPayloads;
  turnId: string;
  topicScores: TreatmentPayloads | null;
  router: ModelStagePayloads | null;
  glossary: RegistryToolPayloads | null;
  treatment: TreatmentPayloads | null;
  portfolio: RegistryToolPayloads | null;
  goal: RegistryToolPayloads | null;
  composer: ModelStagePayloads | null;
  workflow: WorkflowPayloads | null;
};
