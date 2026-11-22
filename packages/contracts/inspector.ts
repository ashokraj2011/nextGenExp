import type { JsonValue } from "@sfield/core";

export type InspectorPayload = {
  bytes: number;
  data?: JsonValue;
};

export type GatewayExchange = {
  source: "recorded" | "verified";
  method: "POST";
  path?: string;
  request: InspectorPayload;
  response?: InspectorPayload;
};

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

export type TurnPayloads = {
  turnId: string;
  router: ModelStagePayloads | null;
  glossary: RegistryToolPayloads | null;
  treatment: TreatmentPayloads | null;
  composer: ModelStagePayloads | null;
};
