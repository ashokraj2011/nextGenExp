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
import type { ScheduledJobExecution, ScheduledJobsView, ScheduledJobUpsertInput } from "../../packages/contracts/scheduled-jobs";
import type { VerticalPackRecord, VerticalPacksView } from "../../packages/contracts/vertical-pack";
import type { PiiFirewallConfig, PiiFirewallView, PiiRedactionTrace } from "../../packages/contracts/pii-firewall";
import type { UxEvolutionView, UxProposal } from "../../packages/contracts/ux-evolution";
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
import type { RecordUpdate, Bootstrap, ProfileChoice, Conversation, ConversationChange, ConversationView, DomainWriteAuditEntry, EngagementAnalyticsView, TurnAccepted, TurnView } from "../../packages/contracts/api";
import { pendingActionsContext, type PortalFundingView, type WorkspaceActionLog, type WorkspaceNextStep, type WorkspacePendingAction, type WorkspacePin } from "../../packages/contracts/workspace";
import type { TreatmentRun, TurnPayloads } from "../../packages/contracts/inspector";
import type { ContextCatalog, PropensityResult, SelectionMode } from "../../packages/contracts/domain";
import type { DraftCheck, Integration, IntegrationCopilotRequest, IntegrationCopilotResponse, IntegrationTasksView, McpImportCandidate, TaskContract, TaskContractInput, TaskRun } from "../../packages/contracts/integration-task";
import type { MockCcreRule, ToolSetup, ToolSetupView, TreatmentPreview, TreatmentPreviewInput, TreatmentSource } from "../../packages/contracts/tool-setup";
import type { FlowCatalogSetup, FlowOverrides, FlowScope } from "../../packages/contracts/routing-flows";
import type {
  PznAttribute,
  PznAttributeInput,
  PznContext,
  PznContextInput,
  PznContextPublication,
  PznCopilotRequest,
  PznCopilotResponse,
  PznNamespace,
  PznNamespaceInput,
  PznRule,
  PznRuleEvalResult,
  PznRuleInput,
  PznRuleValue,
  PznStudioWorkspaceState,
  PznTextContent,
  PznTextContentInput,
  PznTsEvaluateRequest,
  PznTsEvaluationResult,
} from "../../packages/contracts/self-service-pzn";

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
  chatScope?: Pick<Conversation, "tenantId" | "domainId" | "userId"> & { threadId: string };
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
  profileOptions: () => request<{ profiles: ProfileChoice[] }>("/api/profile-options"),
  selectProfile: (personaId: string | null) => request<{ personaId: string | null }>("/api/profile-session", { personaId }),
  bootstrap: (domainId: Conversation["domainId"] = "wealth") => request<Bootstrap>("/api/bootstrap?domain=" + domainId),
  adminBootstrap: (domainId?: Conversation["domainId"]) => request<Bootstrap>("/api/admin/bootstrap" + (domainId ? "?domain=" + domainId : "")),
  evaluation: () => request<{ mode: "live"; rows: EvaluationRow[] }>("/api/admin/evaluation"),
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
  testUiLayout: (domain: Conversation["domainId"], design: UiDesign, message: string, personaId?: string) =>
    request<TurnAccepted & { layoutId: string }>("/api/admin/ui-layout-test?domain=" + domain, { design, message, personaId }),
  saveUiLayout: (change: UiLayoutChange) => request<UiLayoutRecord>("/api/admin/ui-layouts", change),
  previewUiLayout: (design: UiDesign, personaId?: string, domainId: Conversation["domainId"] = "wealth") => request<DisplayExperience>(
    "/api/admin/ui-layout-preview?domain=" + domainId,
    personaId ? { design, personaId } : design,
  ),
  generateUiLayout: (prompt: string, domainId: Conversation["domainId"] = "wealth") => request<{
    design: UiDesign;
    generatedBy: "copilot_llm" | "synthesizer";
    boundKeys: string[];
    summary: string;
  }>("/api/admin/ui-layout-generate?domain=" + domainId, { prompt }),
  widgets: (domainId: Conversation["domainId"] = "wealth") => request<{ widgets: SavedWidget[] }>("/api/admin/widgets?domain=" + domainId),
  generateWidget: (input: string | {
    prompt?: string;
    imageDataUrl?: string;
    imageName?: string;
    figmaUrl?: string;
    figmaToken?: string;
  }, domainId: Conversation["domainId"] = "wealth") => request<{
    widget: WidgetDraft;
    source?: "copilot_vision" | "figma_api" | "copilot_llm" | "synthesizer";
    sourceSummary?: string;
  }>("/api/admin/widget-generate?domain=" + domainId, typeof input === "string" ? { prompt: input } : input),
  saveWidgetLibrary: (change: WidgetLibraryChange, domainId: Conversation["domainId"] = "wealth") => request<{ widget?: SavedWidget; widgets: SavedWidget[] }>("/api/admin/widgets?domain=" + domainId, change),
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
  routingFlows: (scope?: FlowScope) => requestJson<FlowCatalogSetup>("/api/admin/routing-flows" + (scope ? "?scope=" + scope : "")),
  saveRoutingFlows: (scope: FlowScope, changes: FlowOverrides, revision?: string) =>
    requestJson<FlowCatalogSetup>("/api/admin/routing-flows?scope=" + scope, changes, revision),
  saveToolSetup: (setup: ToolSetup, revision?: string) => requestJson<ToolSetup>("/api/admin/tools", setup, revision),
  testToolSetup: (setup: ToolSetup, personaId: string, scenarioId: string) => request<ConversationView>(
    "/api/admin/conversations?scope=preview", { setup, conversation: { personaId, scenarioId } },
  ),
  createCcreRule: (rule: MockCcreRule) => request<MockCcreRule>("/api/admin/ccre-rules", rule),
  previewTreatmentSelector: (input: TreatmentPreviewInput) => request<TreatmentPreview>("/api/admin/treatment-preview", input),
  recordUpdates: (id: string) => request<RecordUpdate[]>("/api/conversations/" + id + "/updates"),
  conversation: (id: string) => request<ConversationView>("/api/conversations/" + id),
  changeConversation: (id: string, change: ConversationChange) => request<Conversation>("/api/conversations/" + id + "/settings", change),
  nextStep: (personaId: string) => request<WorkspaceNextStep | null>("/api/workspace/" + personaId + "/next-step"),
  pendingActions: (personaId: string) => request<WorkspacePendingAction[]>("/api/workspace/" + personaId + "/" + pendingActionsContext),
  portalFunding: () => request<PortalFundingView>("/api/account-portal/funding"),
  confirmPortalFunding: (personaId: string) => request<PortalFundingView>("/api/account-portal/funding", { personaId }),
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
  decideApproval: (approvalId: string, input: Omit<ApprovalDecisionInput, "actor"> & { actor?: string }) => request<{
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
  startTradeJob: (input: TradeJobCreateInput) => request<TradeJob | { status: "pending_approval"; approval: ApprovalRecord; approvalsView?: ApprovalsView }>("/api/trading/jobs", input),
  tradeJobStatus: (jobId: string) => request<TradeJob>("/api/trading/" + jobId + "/status"),
  cancelTradeJob: (jobId: string) => request<TradeJob>("/api/trading/" + jobId + "/cancel", {}),
  writeAudit: () => request<{ toolRef: string; entries: DomainWriteAuditEntry[] }>("/api/admin/write-audit"),
  engagementAnalytics: () => request<EngagementAnalyticsView>("/api/admin/engagement-analytics"),
  omnichannel: () => request<OmnichannelView>("/api/admin/omnichannel"),
  saveOmnichannel: (config: Partial<OmnichannelConfig>) => request<OmnichannelView>("/api/admin/omnichannel", config),
  testOmnichannel: () => request<{ delivery: OmnichannelDelivery; view: OmnichannelView }>("/api/admin/omnichannel-test", {}),
  evals: () => request<EvalSuiteView>("/api/admin/evals"),
  runEvals: () => request<{ report: EvalRunReport; runs: EvalRunReport[] }>("/api/admin/eval-run", {}),
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
  scheduledJobs: () => request<ScheduledJobsView>("/api/admin/scheduled-jobs"),
  saveScheduledJob: (input: ScheduledJobUpsertInput) => request<ScheduledJobsView>("/api/admin/scheduled-jobs", input),
  runScheduledJob: (id: string) => request<{ execution: ScheduledJobExecution; view: ScheduledJobsView }>("/api/admin/scheduled-jobs-run", { id }),
  verticalPacks: () => request<VerticalPacksView>("/api/admin/vertical-packs"),
  generateVerticalPack: (prompt: string) => request<{ pack: VerticalPackRecord; embedDemoUrl: string; view: VerticalPacksView }>("/api/admin/vertical-packs-generate", { prompt }),
  deleteVerticalPack: (id: string) => request<VerticalPacksView>("/api/admin/vertical-packs-delete", { id }),
  piiFirewall: () => request<PiiFirewallView>("/api/admin/pii-firewall"),
  savePiiFirewall: (patch: Partial<PiiFirewallConfig>) => request<PiiFirewallView>("/api/admin/pii-firewall", patch),
  testPiiFirewall: (prompt: string, contextSummary?: string) => request<{ trace: PiiRedactionTrace }>("/api/admin/pii-firewall-test", { prompt, ...(contextSummary ? { contextSummary } : {}) }),
  uxEvolution: () => request<UxEvolutionView>("/api/admin/ux-evolution"),
  scanUxEvolution: (includeSampleTraffic = false) => request<{ created: UxProposal[]; view: UxEvolutionView }>("/api/admin/ux-evolution-scan", { includeSampleTraffic }),
  approveUxProposal: (id: string) => request<{ proposal: UxProposal; view: UxEvolutionView }>("/api/admin/ux-evolution-approve", { id }),
  dismissUxProposal: (id: string) => request<UxEvolutionView>("/api/admin/ux-evolution-dismiss", { id }),
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
  newConversation: (personaId: string, scenarioId: string, domainId: Conversation["domainId"] = "wealth") => request<ConversationView>("/api/conversations", domainId === "wealth" ? { personaId, scenarioId, domainId } : { domainId }),
  newAdminConversation: (personaId: string, scenarioId: string, domainId: Conversation["domainId"] = "wealth") => request<ConversationView>("/api/admin/conversations", domainId === "wealth" ? { personaId, scenarioId, domainId } : { domainId }),
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
  treatmentRuns: (personaId: string, context: string, turn?: string) =>
    request<TreatmentRun[]>("/api/admin/treatment-runs?" + new URLSearchParams({ personaId, context, ...(turn && { turn }) })),
  pendingActionLogs: () => request<WorkspaceActionLog[]>("/api/admin/pending-action-logs"),
  pznWorkspace: () => request<PznStudioWorkspaceState>("/api/pzn/workspace"),
  pznSaveNamespace: (input: PznNamespaceInput) => request<{ status?: "pending_approval"; approval?: ApprovalRecord; namespace?: PznNamespace; workspace: PznStudioWorkspaceState }>("/api/pzn/namespaces", input),
  pznDeleteNamespace: (id: string) => request<{ status?: "pending_approval"; approval?: ApprovalRecord; workspace: PznStudioWorkspaceState }>("/api/pzn/namespaces/delete", { id }),
  pznSaveAttribute: (input: PznAttributeInput) => request<{ status?: "pending_approval"; approval?: ApprovalRecord; attribute?: PznAttribute; workspace: PznStudioWorkspaceState }>("/api/pzn/attributes", input),
  pznDeleteAttribute: (namespaceId: string, attributeId: string) => request<{ status?: "pending_approval"; approval?: ApprovalRecord; workspace: PznStudioWorkspaceState }>("/api/pzn/attributes/delete", { namespaceId, attributeId }),
  pznSaveContent: (input: PznTextContentInput) => request<{ content: PznTextContent; workspace: PznStudioWorkspaceState }>("/api/pzn/contents", input),
  pznDeleteContent: (contentId: string) => request<{ status?: "pending_approval"; approval?: ApprovalRecord; workspace: PznStudioWorkspaceState }>("/api/pzn/contents/delete", { contentId }),
  pznSaveRule: (input: PznRuleInput) => request<{ rule: PznRule; workspace: PznStudioWorkspaceState }>("/api/pzn/rules", input),
  pznDeleteRule: (ruleId: string) => request<{ status?: "pending_approval"; approval?: ApprovalRecord; workspace: PznStudioWorkspaceState }>("/api/pzn/rules/delete", { ruleId }),
  pznTestRule: (mid: string, rule: PznRuleInput, attributeOverrides?: Record<string, PznRuleValue>) => (
    request<{ mid: string; customerDisplayName: string; resolvedAttributes: Record<string, unknown>; evaluation: PznRuleEvalResult }>(
      "/api/pzn/rules/test",
      { mid, rule, ...(attributeOverrides ? { attributeOverrides } : {}) },
    )
  ),
  pznSaveContext: (input: PznContextInput) => request<{ context: PznContext; workspace: PznStudioWorkspaceState }>("/api/pzn/contexts", input),
  pznPublishContext: (contextId: string, notes?: string, publishedBy?: string) => (
    request<{ status?: "pending_approval"; approval?: ApprovalRecord; publication?: PznContextPublication; workspace: PznStudioWorkspaceState }>(
      "/api/pzn/contexts/publish",
      { contextId, ...(notes ? { notes } : {}), ...(publishedBy ? { publishedBy } : {}) },
    )
  ),
  pznUnpublishContext: (contextId: string) => request<{ status?: "pending_approval"; approval?: ApprovalRecord; context?: PznContext; workspace: PznStudioWorkspaceState }>("/api/pzn/contexts/unpublish", { contextId }),
  pznDeleteContext: (contextId: string) => request<{ status?: "pending_approval"; approval?: ApprovalRecord; workspace: PznStudioWorkspaceState }>("/api/pzn/contexts/delete", { contextId }),
  pznEvaluateTs: (input: PznTsEvaluateRequest) => request<PznTsEvaluationResult>("/api/pzn/ts/evaluate", input),
  pznCopilot: (input: PznCopilotRequest) => request<PznCopilotResponse>("/api/pzn/copilot", input),
  integrations: () => request<IntegrationTasksView>("/api/integrations"),
  integrationCopilot: (input: IntegrationCopilotRequest) => request<IntegrationCopilotResponse>("/api/integrations/copilot", input),
  runIntegrationTask: (input: { toolRef: string; input: Record<string, unknown>; requestedBy?: string; provenance?: Record<string, string> }) => (
    request<{ run: TaskRun; approval?: ApprovalRecord }>("/api/integrations/tasks/run", input)
  ),
  saveIntegration: (integration: Partial<Integration>) => request<{ integration: Integration; view: IntegrationTasksView }>("/api/integrations/integrations", integration),
  validateIntegrationDraft: (draft: TaskContractInput) => request<DraftCheck>("/api/integrations/contracts/validate", { draft }),
  saveIntegrationDraft: (draft: TaskContractInput) => request<{ contract: TaskContract; view: IntegrationTasksView }>("/api/integrations/contracts", draft),
  publishIntegrationTask: (ref: string) => request<{ contract: TaskContract; breaking: string[]; sfieldRegistered: boolean; sfieldRoute: "dedicated" | "dispatcher" | "unavailable"; registrationNote?: string; view: IntegrationTasksView }>("/api/integrations/contracts/publish", { ref }),
  gatewayConfig: () => request<import("./gateway-admin").GatewayView>("/api/admin/gateway"),
  testGateway: (config: unknown) => request<import("./gateway-admin").GatewayTest>("/api/admin/gateway/test", { config }),
  activateGateway: (config: unknown) => request<{ activated: boolean; restarting: boolean; view: import("./gateway-admin").GatewayView }>("/api/admin/gateway/activate", { config }),
  resetGateway: () => request<{ reset: boolean; restarting: boolean; view: import("./gateway-admin").GatewayView }>("/api/admin/gateway/reset", {}),
  discoverIntegrationMcp: (integrationId: string) => request<{ integrationId: string; candidates: McpImportCandidate[] }>("/api/integrations/mcp/discover", { integrationId }),
};
