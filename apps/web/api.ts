import type { AppliedUiLayout, UiDesign, UiLayoutCatalog, UiLayoutChange, UiLayoutRecord } from "../../packages/contracts/ui-layout";
import type { DisplayExperience } from "../../packages/contracts/surface";
import type { CapabilityManifest, CapabilityRef, OutputKind } from "../../packages/contracts/agentic";
import type { AgenticTrace } from "./decision-trace";
import type { EvaluationRow } from "../../packages/contracts/evaluation";
import type { ActionMessage } from "@a2ui/web_core/v1_0";
import type { Bootstrap, Conversation, ConversationChange, ConversationView, TurnAccepted, TurnView } from "../../packages/contracts/api";
import { pendingActionsContext, type WorkspaceActionLog, type WorkspaceNextStep, type WorkspacePendingAction, type WorkspacePin } from "../../packages/contracts/workspace";
import type { TurnPayloads } from "../../packages/contracts/inspector";
import type { ContextCatalog, PropensityResult, SelectionMode } from "../../packages/contracts/domain";
import type { MockCcreRule, ToolSetup, ToolSetupView, TreatmentPreview, TreatmentPreviewInput, TreatmentSource } from "../../packages/contracts/tool-setup";

export class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function toolSetupErrorMessage(error: unknown) {
  return error instanceof RequestError ? error.message : "Couldn’t reach the local server. Try again.";
}
async function requestJson<T>(path: string, payload?: unknown, revision?: string) {
  const response = await fetch(path, payload === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json", ...(revision && { "If-Match": revision }) },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new RequestError(response.status, error.code ?? "request_failed", error.message ?? "This request couldn’t be completed.");
  }
  return { data: await response.json() as T, revision: response.headers.get("ETag") ?? undefined };
}
async function request<T>(path: string, payload?: unknown) {
  return (await requestJson<T>(path, payload)).data;
}

type Stage = { state: string; elapsedMs: number; modelCalls: number; totalTokens: number; tokensReported: boolean; errorCode?: string };
export type Trace = {
  agentic?: AgenticTrace;
  uiLayout?: AppliedUiLayout;
  turnId: string;
  ordinal: number;
  surface: string;
  sourcePageContext: string | null;
  selectedContextId: string | null;
  routeDecisionId: string | null;
  contentDecisionId: string | null;
  catalogScopeId: string | null;
  glossaryScopeId: string | null;
  portfolioScopeId: string | null;
  goalScopeId: string | null;
  tsScopeId: string | null;
  routerRunId: string | null;
  composerRunId: string | null;
  catalog: (ContextCatalog & { id: string }) | null;
  propensity: PropensityResult | null;
  selectionMode: SelectionMode;
  routeOutcome?: string;
  intentId?: string | null;
  possibleIntentId?: string;
  glossaryVersion?: string;
  finalOrder?: string[];
  components?: string[];
  metricReadSucceeded: boolean;
  portfolioReadSucceeded: boolean;
  goalReadSucceeded: boolean;
  ts?: { baseline: string[]; fixtureVersion: string; partial: boolean; source?: TreatmentSource; rejections: { contentId: string; stage: string; reasonCode: string }[] };
  routeRun?: Stage;
  composeRun?: Stage;
  markers: Record<string, number>;
  failures: { stage: string; code: string }[];
};
export const api = {
  bootstrap: () => request<Bootstrap>("/api/bootstrap"),
  adminBootstrap: () => request<Bootstrap>("/api/admin/bootstrap"),
  evaluation: () => request<{ mode: "live" | "test"; rows: EvaluationRow[] }>("/api/admin/evaluation"),
  capabilities: () => request<{ manifests: CapabilityManifest[]; tools: { ref: string; label: string; output: OutputKind; invariant: string }[] }>("/api/admin/capabilities"),
  publishCapability: (manifest: unknown, validate: boolean) => request<CapabilityManifest>(
    "/api/admin/" + (validate ? "capability-validation" : "capabilities"), manifest,
  ),
  previewCapability: (capability: CapabilityRef, personaId: string, message: string) => request<TurnAccepted>(
    "/api/admin/capability-preview", { capability, personaId, message },
  ),
  simulateFirstDeposit: (personaId: string, eventId: string) => request<{ accepted: boolean; fundingStatus: "funded" }>(
    "/api/admin/customer-events", { personaId, eventId, type: "account.first_deposit.completed" },
  ),
  uiLayouts: () => request<UiLayoutCatalog>("/api/admin/ui-layouts"),
  saveUiLayout: (change: UiLayoutChange) => request<UiLayoutRecord>("/api/admin/ui-layouts", change),
  previewUiLayout: (design: UiDesign) => request<DisplayExperience>("/api/admin/ui-layout-preview", design),
  toolSetup: () => requestJson<ToolSetupView>("/api/admin/tools"),
  saveToolSetup: (setup: ToolSetup, revision?: string) => requestJson<ToolSetup>("/api/admin/tools", setup, revision),
  createCcreRule: (rule: MockCcreRule) => request<MockCcreRule>("/api/admin/ccre-rules", rule),
  previewTreatmentSelector: (input: TreatmentPreviewInput) => request<TreatmentPreview>("/api/admin/treatment-preview", input),
  conversation: (id: string) => request<ConversationView>("/api/conversations/" + id),
  changeConversation: (id: string, change: ConversationChange) => request<Conversation>("/api/conversations/" + id + "/settings", change),
  nextStep: (personaId: string) => request<WorkspaceNextStep | null>("/api/workspace/" + personaId + "/next-step"),
  pendingActions: (personaId: string) => request<WorkspacePendingAction[]>("/api/workspace/" + personaId + "/" + pendingActionsContext),
  savePins: (personaId: string, pins: WorkspacePin[]) => request<WorkspacePin[]>("/api/workspace/" + personaId + "/preferences", { pins }),
  previewFunding: (conversationId: string, clientRequestId: string, source?: typeof pendingActionsContext) => request<TurnAccepted>(
    "/api/conversations/" + conversationId + "/preview-funding", { clientRequestId, source },
  ),
  newConversation: (personaId: string, scenarioId: string) => request<ConversationView>("/api/conversations", { personaId, scenarioId }),
  newAdminConversation: (personaId: string, scenarioId: string) => request<ConversationView>("/api/admin/conversations", { personaId, scenarioId }),
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
  debug: (id: string) => request<Trace>("/api/admin/inspector/" + id),
  payloads: (id: string) => request<TurnPayloads>("/api/admin/logs/" + id),
  pendingActionLogs: () => request<WorkspaceActionLog[]>("/api/admin/pending-action-logs"),
};
