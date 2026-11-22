import type { ActionMessage } from "@a2ui/web_core/v1_0";
import type { Bootstrap, ConversationView, TurnAccepted, TurnView } from "../../packages/contracts/api";
import type { ContextCatalog, PropensityResult, SelectionMode } from "../../packages/contracts/domain";
import type { ToolSetup, ToolSetupView, TreatmentPreview, TreatmentPreviewInput, TreatmentSource } from "../../packages/contracts/tool-setup";

export class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
async function request<T>(path: string, payload?: unknown): Promise<T> {
  const response = await fetch(path, payload === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new RequestError(response.status, error.code ?? "request_failed", error.message ?? "This request couldn’t be completed.");
  }
  return response.json() as Promise<T>;
}

type Stage = { state: string; elapsedMs: number; modelCalls: number; totalTokens: number; tokensReported: boolean; errorCode?: string };
export type Trace = {
  turnId: string;
  ordinal: number;
  surface: string;
  sourcePageContext: string | null;
  selectedContextId: string | null;
  routeDecisionId: string | null;
  contentDecisionId: string | null;
  catalogScopeId: string | null;
  tsScopeId: string | null;
  routerRunId: string | null;
  composerRunId: string | null;
  catalog: (ContextCatalog & { id: string }) | null;
  propensity: PropensityResult | null;
  selectionMode: SelectionMode;
  routeOutcome?: string;
  finalOrder?: string[];
  components?: string[];
  metricReadSucceeded: boolean;
  ts?: { baseline: string[]; fixtureVersion: string; partial: boolean; source?: TreatmentSource; rejections: { contentId: string; stage: string; reasonCode: string }[] };
  routeRun?: Stage;
  composeRun?: Stage;
  markers: Record<string, number>;
  failures: { stage: string; code: string }[];
};
export const api = {
  bootstrap: () => request<Bootstrap>("/api/bootstrap"),
  toolSetup: () => request<ToolSetupView>("/api/admin/tools"),
  saveToolSetup: (setup: ToolSetup) => request<ToolSetup>("/api/admin/tools", setup),
  previewTreatmentSelector: (input: TreatmentPreviewInput) => request<TreatmentPreview>("/api/admin/treatment-preview", input),
  conversation: (id: string) => request<ConversationView>("/api/conversations/" + id),
  newConversation: (personaId: string, scenarioId: string) => request<ConversationView>("/api/conversations", { personaId, scenarioId }),
  turn: (id: string) => request<TurnView>("/api/turns/" + id),
  send: (id: string, message: string, clientRequestId: string) => (
    request<TurnAccepted>("/api/conversations/" + id + "/turns", { message, clientRequestId })
  ),
  cancel: (id: string) => request<TurnView>("/api/turns/" + id + "/cancel", {}),
  retry: (id: string, clientRequestId: string) => request<TurnAccepted>("/api/turns/" + id + "/retry", { clientRequestId }),
  followUp: (id: string, envelope: ActionMessage, clientRequestId: string) => (
    request<TurnAccepted>("/api/experiences/" + id + "/actions", { envelope, clientRequestId })
  ),
  event: (experienceId: string, type: "rendered" | "render_fallback" | "helpful" | "unhelpful") => (
    request("/api/events", {
      eventId: type === "rendered" || type === "render_fallback" ? experienceId + "_" + type : crypto.randomUUID(),
      experienceId, type,
    })
  ),
  debug: (id: string) => request<Trace>("/api/debug/turns/" + id),
};
