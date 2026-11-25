import type { AppliedUiLayout, UiDesign, UiLayoutCatalog, UiLayoutChange, UiLayoutRecord } from "../../packages/contracts/ui-layout";
import type { SavedWidget, WidgetDraft, WidgetLibraryChange } from "../../packages/contracts/widget";
import type { IncidentDecisionInput, IncidentRecord, IncidentUpsertInput, OpsIncidentsView } from "../../packages/contracts/ops";
import type { DealDecisionInput, DealRecord, DealUpsertInput, SalesDealsView } from "../../packages/contracts/sales";
import type { RecommendationProviderDescriptor } from "../../packages/contracts/recommendation-provider";
import type {
  ConnectorInvokeExecution,
  ConnectorInvokeInput,
  ConnectorTestResult,
  ConnectorUpsertInput,
  ExternalConnector,
} from "../../packages/contracts/connector";
import type {
  ApprovalDecisionInput,
  ApprovalPolicySettings,
  ApprovalRecord,
  ApprovalsView,
} from "../../packages/contracts/approval";
import type {
  PortfolioBalanceSnapshot,
  TaxHarvestAnalysis,
  TaxHarvestPreviewInput,
  TradeJob,
  TradeJobCreateInput,
} from "../../packages/contracts/trading";
import type { ActionFlow, ActionFlowUpsertInput } from "../../packages/contracts/action-flow";
import type { WorkflowDefinition, WorkflowDefinitionUpsertInput, WorkflowRun, WorkflowsAdminView } from "../../packages/contracts/workflow-definition";
import type { OmnichannelConfig, OmnichannelDelivery, OmnichannelView } from "../../packages/contracts/omnichannel";
import type { ComplianceAuditPacket, EvalRunReport, EvalSuiteView } from "../../packages/contracts/eval-suite";
import type { McpDiscoveryResult } from "../../packages/contracts/mcp-discovery";
import type { ProactiveAlert, ProactiveTriggerInput, ProactiveView } from "../../packages/contracts/proactive-events";
import type { KnowledgeBaseView, KnowledgeDocumentUpsertInput, KnowledgeSearchResult } from "../../packages/contracts/knowledge-base";
import type { Customer360AdminRecord, Customer360ProfileInput } from "../../packages/contracts/customer-360";
import type {
  ExperienceRegistryView,
  ManagedContentInput,
  ManagedIntentInput,
  ManagedNbaRuleInput,
} from "../../packages/contracts/experience-registry";
import type { DisplayExperience } from "../../packages/contracts/surface";
import type { CapabilityManifest, CapabilityRef, OutputKind } from "../../packages/contracts/agentic";
import type { AgenticTrace } from "./decision-trace";
import type { EvaluationRow } from "../../packages/contracts/evaluation";
import type { ActionMessage } from "@a2ui/web_core/v1_0";
import type { Bootstrap, Conversation, ConversationChange, ConversationView, DomainWriteAuditEntry, EngagementAnalyticsView, TurnAccepted, TurnView } from "../../packages/contracts/api";
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
  previewUiLayout: (design: UiDesign, personaId?: string) => request<DisplayExperience>(
    "/api/admin/ui-layout-preview",
    personaId ? { design, personaId } : design,
  ),
  generateUiLayout: (prompt: string) => request<{
    design: UiDesign;
    generatedBy: "copilot_llm" | "synthesizer";
    boundKeys: string[];
    summary: string;
  }>("/api/admin/ui-layout-generate", { prompt }),
  widgets: () => request<{ widgets: SavedWidget[] }>("/api/admin/widgets"),
  generateWidget: (prompt: string) => request<{ widget: WidgetDraft }>("/api/admin/widget-generate", { prompt }),
  saveWidgetLibrary: (change: WidgetLibraryChange) => request<{ widget?: SavedWidget; widgets: SavedWidget[] }>("/api/admin/widgets", change),
  customers: () => request<{ customers: Customer360AdminRecord[] }>("/api/admin/customers"),
  saveCustomer: (input: Customer360ProfileInput) => request<{ customer?: Customer360AdminRecord; customers: Customer360AdminRecord[] }>("/api/admin/customers", input),
  deleteOrResetCustomer: (personaId: string) => request<{ deleted: boolean; reset: boolean; customers: Customer360AdminRecord[] }>("/api/admin/customer-delete", { personaId }),
  resetCustomerNba: (personaId: string) => request<{ customers: Customer360AdminRecord[] }>("/api/admin/customer-reset-nba", { personaId }),
  experienceRegistry: () => request<ExperienceRegistryView>("/api/admin/experience-registry"),
  saveRegistryIntent: (input: ManagedIntentInput) => request<ExperienceRegistryView>("/api/admin/registry-intent", input),
  deleteOrResetRegistryIntent: (intentId: string) => request<ExperienceRegistryView>("/api/admin/registry-intent-delete", { intentId }),
  saveRegistryContent: (input: ManagedContentInput) => request<ExperienceRegistryView>("/api/admin/registry-content", input),
  deleteOrResetRegistryContent: (contentId: string) => request<ExperienceRegistryView>("/api/admin/registry-content-delete", { contentId }),
  saveRegistryNba: (input: ManagedNbaRuleInput) => request<ExperienceRegistryView>("/api/admin/registry-nba", input),
  reorderRegistryNba: (orderedIds: string[]) => request<ExperienceRegistryView>("/api/admin/registry-nba-reorder", { orderedIds }),
  deleteOrResetRegistryNba: (id: string) => request<ExperienceRegistryView>("/api/admin/registry-nba-delete", { id }),
  toolSetup: () => requestJson<ToolSetupView>("/api/admin/tools"),
  saveToolSetup: (setup: ToolSetup, revision?: string) => requestJson<ToolSetup>("/api/admin/tools", setup, revision),
  createCcreRule: (rule: MockCcreRule) => request<MockCcreRule>("/api/admin/ccre-rules", rule),
  previewTreatmentSelector: (input: TreatmentPreviewInput) => request<TreatmentPreview>("/api/admin/treatment-preview", input),
  conversation: (id: string) => request<ConversationView>("/api/conversations/" + id),
  changeConversation: (id: string, change: ConversationChange) => request<Conversation>("/api/conversations/" + id + "/settings", change),
  nextStep: (personaId: string) => request<WorkspaceNextStep | null>("/api/workspace/" + personaId + "/next-step"),
  pendingActions: (personaId: string) => request<WorkspacePendingAction[]>("/api/workspace/" + personaId + "/" + pendingActionsContext),
  savePins: (personaId: string, pins: WorkspacePin[]) => request<WorkspacePin[]>("/api/workspace/" + personaId + "/preferences", { pins }),
  dismissNba: (personaId: string, nbaId: string) => request<{ dismissed: string[] }>("/api/workspace/" + personaId + "/dismiss-nba", { nbaId }),
  applyCustomerBindings: (personaId: string, updates: Record<string, string>) => request<{ updatedFields: string[] }>(
    "/api/workspace/" + personaId + "/apply-bindings", { updates },
  ),
  opsIncidents: () => request<OpsIncidentsView>("/api/ops/incidents"),
  saveOpsIncident: (input: IncidentUpsertInput) => request<{ incident: IncidentRecord; view: OpsIncidentsView }>("/api/ops/incidents", input),
  deleteOpsIncident: (incidentId: string) => request<{ deleted: boolean; view: OpsIncidentsView }>("/api/ops-incidents/" + incidentId + "/delete", {}),
  resetOpsIncidents: () => request<OpsIncidentsView>("/api/ops/incidents/reset", {}),
  decideIncident: (incidentId: string, input: IncidentDecisionInput & { queueForApproval?: boolean }) => request<{
    incident: IncidentRecord;
    view: OpsIncidentsView;
    status?: "pending_approval";
    approval?: ApprovalRecord;
    sfieldRunId?: string;
    auditId?: string;
  }>(
    "/api/ops-incidents/" + incidentId + "/decision", input,
  ),
  salesDeals: () => request<SalesDealsView>("/api/sales/deals"),
  saveSalesDeal: (input: DealUpsertInput) => request<{ deal: DealRecord; view: SalesDealsView }>("/api/sales/deals", input),
  deleteSalesDeal: (dealId: string) => request<{ deleted: boolean; view: SalesDealsView }>("/api/sales-deals/" + dealId + "/delete", {}),
  resetSalesDeals: () => request<SalesDealsView>("/api/sales/deals/reset", {}),
  decideDeal: (dealId: string, input: DealDecisionInput & { queueForApproval?: boolean }) => request<{
    deal: DealRecord;
    view: SalesDealsView;
    status?: "pending_approval";
    approval?: ApprovalRecord;
    sfieldRunId?: string;
    auditId?: string;
  }>(
    "/api/sales-deals/" + dealId + "/decision", input,
  ),
  recommendationProviders: () => request<{ toolRef: string; writeToolRef?: string; connectorToolRef?: string; providers: RecommendationProviderDescriptor[] }>("/api/admin/recommendation-providers"),
  connectors: () => request<{ connectors: ExternalConnector[] }>("/api/admin/connectors"),
  saveConnector: (input: ConnectorUpsertInput) => request<{ connector: ExternalConnector; connectors: ExternalConnector[] }>("/api/admin/connectors", input),
  deleteConnector: (id: string) => request<{ deleted: boolean; connectors: ExternalConnector[] }>("/api/admin/connector-delete", { id }),
  testConnector: (id: string) => request<ConnectorTestResult>("/api/admin/connector-test", { id }),
  invokeConnector: (input: ConnectorInvokeInput) => request<{
    status: "pending_approval" | "executed";
    approval?: ApprovalRecord;
    approvalsView?: ApprovalsView;
    execution?: ConnectorInvokeExecution;
  }>("/api/admin/connector-invoke", input),
  approvals: () => request<ApprovalsView>("/api/approvals"),
  saveApprovalPolicy: (policy: Partial<ApprovalPolicySettings>) => request<{ policy: ApprovalPolicySettings; view: ApprovalsView }>("/api/approvals/policy", policy),
  decideApproval: (approvalId: string, input: ApprovalDecisionInput) => request<{
    approval: ApprovalRecord;
    job?: TradeJob;
    execution?: { summary?: string; sfieldRunId?: string; audit?: DomainWriteAuditEntry; jobId?: string; statusCode?: number; responsePreview?: string };
    view: ApprovalsView;
  }>("/api/approvals/" + approvalId + "/decide", input),
  actionFlows: () => request<{ flows: ActionFlow[] }>("/api/admin/action-flows"),
  saveActionFlow: (input: ActionFlowUpsertInput) => request<{ flow: ActionFlow; flows: ActionFlow[] }>("/api/admin/action-flows", input),
  deleteActionFlow: (id: string) => request<{ deleted: boolean; flows: ActionFlow[] }>("/api/admin/action-flow-delete", { id }),
  tradingPortfolio: (personaId: string) => request<PortfolioBalanceSnapshot>("/api/trading/" + personaId + "/portfolio"),
  taxHarvestPreview: (input: TaxHarvestPreviewInput) => request<TaxHarvestAnalysis>("/api/trading/tax-harvest", input),
  startTradeJob: (input: TradeJobCreateInput) => request<TradeJob | { status: "pending_approval"; approval: ApprovalRecord; approvalsView: ApprovalsView }>("/api/trading/jobs", input),
  tradeJobStatus: (jobId: string) => request<TradeJob>("/api/trading/" + jobId + "/status"),
  cancelTradeJob: (jobId: string) => request<TradeJob>("/api/trading/" + jobId + "/cancel", {}),
  writeAudit: () => request<{ toolRef: string; entries: DomainWriteAuditEntry[] }>("/api/admin/write-audit"),
  engagementAnalytics: () => request<EngagementAnalyticsView>("/api/admin/engagement-analytics"),
  omnichannel: () => request<OmnichannelView>("/api/admin/omnichannel"),
  saveOmnichannel: (config: Partial<OmnichannelConfig>) => request<OmnichannelView>("/api/admin/omnichannel", config),
  testOmnichannel: () => request<{ delivery: OmnichannelDelivery; view: OmnichannelView }>("/api/admin/omnichannel-test", {}),
  evals: () => request<EvalSuiteView>("/api/admin/evals"),
  runEvals: (mode: "deterministic" | "live_llm" = "deterministic") => request<{ report: EvalRunReport; runs: EvalRunReport[] }>("/api/admin/eval-run", { mode }),
  compliancePacket: () => request<ComplianceAuditPacket>("/api/admin/compliance-packet"),
  workflows: () => request<WorkflowsAdminView>("/api/workflows"),
  generateWorkflow: (prompt: string) => request<{ definition: WorkflowDefinitionUpsertInput; generatedBy: "copilot_llm" | "synthesizer"; summary: string }>("/api/workflows/generate", { prompt }),
  saveWorkflow: (input: WorkflowDefinitionUpsertInput) => request<WorkflowsAdminView>("/api/workflows", input),
  deleteWorkflow: (id: string) => request<WorkflowsAdminView>("/api/workflows/" + id + "/delete", {}),
  discoverMcp: (input: { serverUrl: string; authHeaderName?: string; authEnvVar?: string }) => (
    request<McpDiscoveryResult>("/api/admin/mcp-discover", input)
  ),
  importMcpTool: (input: {
    serverUrl: string;
    toolName: string;
    description: string;
    effect: "read" | "write";
    domain: "wealth" | "operations" | "sales" | "general";
    requiresApproval?: boolean;
    dualControl?: boolean;
    authHeaderName?: string;
    authEnvVar?: string;
  }) => request<{ connector: ExternalConnector; connectors: ExternalConnector[] }>("/api/admin/mcp-import", input),
  proactiveAlerts: () => request<ProactiveView>("/api/proactive/alerts"),
  triggerProactiveEvent: (input: ProactiveTriggerInput) => request<{ alert: ProactiveAlert; view: ProactiveView }>("/api/proactive/trigger", input),
  dismissProactiveAlert: (id: string) => request<ProactiveView>("/api/proactive/" + id + "/dismiss", {}),
  knowledgeBase: () => request<KnowledgeBaseView>("/api/admin/knowledge-base"),
  saveKnowledgeDoc: (input: KnowledgeDocumentUpsertInput) => request<KnowledgeBaseView>("/api/admin/knowledge-base", input),
  deleteKnowledgeDoc: (id: string) => request<KnowledgeBaseView>("/api/admin/knowledge-base-delete", { id }),
  searchKnowledgeBase: (query: string) => request<KnowledgeSearchResult>("/api/admin/knowledge-search", { query }),
  startWorkflow: (id: string, input: { personaId?: string; actorName?: string; initialInputs?: Record<string, string | number | boolean> } = {}) => (
    request<{ run: WorkflowRun; definition: WorkflowDefinition }>("/api/workflows/" + id + "/start", input)
  ),
  workflowRun: (runId: string) => request<{ run: WorkflowRun; definition?: WorkflowDefinition }>("/api/workflow-runs/" + runId),
  submitWorkflowInput: (runId: string, inputs: Record<string, string | number | boolean>) => (
    request<{ run: WorkflowRun; definition?: WorkflowDefinition }>("/api/workflow-runs/" + runId + "/input", { inputs })
  ),
  cancelWorkflowRun: (runId: string) => request<{ run: WorkflowRun; definition?: WorkflowDefinition }>("/api/workflow-runs/" + runId + "/cancel", {}),
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
