import type { AppliedUiLayout, UiDesign, UiLayoutCatalog, UiLayoutChange, UiLayoutRecord } from "../../packages/contracts/ui-layout";
import type { DomainPackId } from "../../packages/contracts/domain-packs";
import type { SmassModelSummary } from "../../packages/smass/contracts";
import type { SphotonBindingCatalog, SphotonFormat } from "../../packages/sphoton/contracts";
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
  PublicationReview,
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
import type { VerticalPacksView } from "../../packages/contracts/vertical-pack";
import type { PiiFirewallConfig, PiiFirewallView, PiiRedactionTrace } from "../../packages/contracts/pii-firewall";
import type { UxEvolutionView, UxProposal } from "../../packages/contracts/ux-evolution";
import type { Customer360AdminRecord, Customer360ProfileInput } from "../../packages/contracts/customer-360";
import type {
  ExperienceRegistryScopes,
  ExperienceRegistryView,
  RecordWorkspaceRegistry,
  ManagedContentInput,
  ManagedIntentInput,
  ManagedNbaRuleInput,
} from "../../packages/contracts/experience-registry";
import type { DisplayExperience } from "../../packages/contracts/surface";
import type { CapabilityManifest, CapabilityRef, OutputKind } from "../../packages/contracts/agentic";
import type { AgenticTrace } from "./decision-trace";
import type { EvaluationRow } from "../../packages/contracts/evaluation";
import type { ActionMessage } from "@a2ui/web_core/v1_0";
import type { RecordUpdate, Bootstrap, ProfileChoice, Conversation, ConversationChange, ConversationFolder, ConversationView, DomainWriteAuditEntry, EngagementAnalyticsView, TurnAccepted, TurnView } from "../../packages/contracts/api";
import { pendingActionsContext, type PortalFundingView, type WorkspaceActionLog, type WorkspaceActionState, type WorkspaceNextStep,
  type WorkspacePendingAction, type WorkspacePin, type WorkspaceTodoCommand } from "../../packages/contracts/workspace";
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

export const publicationReviewEvent = "publication-review-requested";

export function isPublicationReview(value: unknown): value is PublicationReview {
  return typeof value === "object" && value !== null && "status" in value && value.status === "pending_approval"
    && "approval" in value && typeof value.approval === "object" && value.approval !== null;
}

type Reviewable<T> = T | PublicationReview;

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
  const data = await response.json() as T;
  if (typeof window !== "undefined" && isPublicationReview(data)
    && ["publication", "task_publish", "pzn_change"].includes(data.approval.targetKind)) {
    window.dispatchEvent(new CustomEvent(publicationReviewEvent, { detail: data.approval }));
  }
  return { data, revision: response.headers.get("ETag") ?? undefined };
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
  emotionalState?: import("../../packages/contracts/empathy").EmotionalAssessment | null;
  ts?: { baseline: string[]; fixtureVersion: string; partial: boolean; source?: TreatmentSource; rejections: { contentId: string; stage: string; reasonCode: string }[] };
  routeRun?: Stage;
  composeRun?: Stage;
  markers: Record<string, number>;
  failures: { stage: string; code: string }[];
};
export const api = {
  pinnedCards: (domainId: DomainPackId, personaId?: string, live = true) =>
    request<{ cards: import("../../packages/contracts/pinned-cards").PinnedLiveCard[] }>(
      `/api/pinned-cards?domain=${encodeURIComponent(domainId)}${personaId ? `&personaId=${encodeURIComponent(personaId)}` : ""}${live ? "&live=1" : ""}`,
    ),
  pinCardToMenu: (input: import("../../packages/contracts/pinned-cards").CreatePinnedCardInput) =>
    request<{ card: import("../../packages/contracts/pinned-cards").PinnedLiveCard; cards: import("../../packages/contracts/pinned-cards").PinnedLiveCard[] }>(
      "/api/pinned-cards",
      input,
    ),
  refreshPinnedCard: (cardId: string, domainId: DomainPackId, personaId?: string) =>
    request<{ card: import("../../packages/contracts/pinned-cards").PinnedLiveCard; cards: import("../../packages/contracts/pinned-cards").PinnedLiveCard[] }>(
      `/api/pinned-cards/${encodeURIComponent(cardId)}/refresh`,
      { domainId, ...(personaId ? { personaId } : {}) },
    ),
  unpinCardFromMenu: (cardId: string, domainId: DomainPackId, personaId?: string) =>
    request<{ deleted: boolean; cards: import("../../packages/contracts/pinned-cards").PinnedLiveCard[] }>(
      `/api/pinned-cards/${encodeURIComponent(cardId)}/delete`,
      { domainId, ...(personaId ? { personaId } : {}) },
    ),
  sketchToUi: (input: {
    conversationId?: string;
    domainId: DomainPackId;
    personaId?: string;
    prompt?: string;
    imageDataUrl: string;
    imageName?: string;
  }) =>
    request<{
      conversation: ConversationView;
      turn: TurnView;
      experience: DisplayExperience;
      widget: WidgetDraft;
      source: "copilot_vision" | "figma_api" | "copilot_llm" | "synthesizer";
      sourceSummary: string;
    }>("/api/sketch-to-ui", input),
  profileOptions: () => request<{ profiles: ProfileChoice[] }>("/api/profile-options"),
  selectProfile: (personaId: string | null) => request<{ personaId: string | null }>("/api/profile-session", { personaId }),
  bootstrap: (domainId: Conversation["domainId"] = "wealth") => request<Bootstrap>("/api/bootstrap?domain=" + domainId),
  adminBootstrap: (domainId?: Conversation["domainId"]) => request<Bootstrap>("/api/admin/bootstrap" + (domainId ? "?domain=" + domainId : "")),
  evaluation: () => request<{ mode: "live"; rows: EvaluationRow[] }>("/api/admin/evaluation"),
  capabilities: () => request<{ manifests: CapabilityManifest[]; tools: { ref: string; label: string; output: OutputKind; invariant: string }[] }>("/api/admin/capabilities"),
  publishCapability: (manifest: unknown, validate: boolean) => request<Reviewable<CapabilityManifest>>(
    "/api/admin/" + (validate ? "capability-validation" : "capabilities"), manifest,
  ),
  previewCapability: (capability: CapabilityRef, personaId: string, message: string) => request<TurnAccepted>(
    "/api/admin/capability-preview", { capability, personaId, message },
  ),
  simulateFirstDeposit: (personaId: string, eventId: string) => request<{ accepted: boolean; fundingStatus: "funded" }>(
    "/api/admin/customer-events", { personaId, eventId, type: "account.first_deposit.completed" },
  ),
  uiLayouts: () => request<UiLayoutCatalog>("/api/admin/ui-layouts"),
  uiBindingCatalog: (domainId: DomainPackId) =>
    request<SphotonBindingCatalog>("/api/admin/ui-binding-catalog?domain=" + domainId),
  domainModels: (domainId: DomainPackId) =>
    request<{
      tenantId: string;
      domainId: DomainPackId;
      models: SmassModelSummary[];
      customModelIds: string[];
      customRelations: Array<{
        sourceModelId: string;
        targetModelId: string;
        name: string;
        cardinality: import("../../packages/smass").SmassRelationCardinality;
        localField: string;
        foreignField: string;
      }>;
      customModels: Array<{
        id: string;
        version: string;
        status?: import("../../packages/smass").SmassModelStatus;
        label: string;
        description?: string;
        primaryKey?: string;
        principalKey?: string;
        unnest?: {
          toolRef: string;
          path: string;
          parentModelId?: string;
          parentJoinField?: string;
          indexField?: string;
        };
        relations?: Array<{
          name: string;
          targetModelId: string;
          cardinality: import("../../packages/smass").SmassRelationCardinality;
          localField: string;
          foreignField: string;
        }>;
        fields: Array<
          | {
              kind: "mapped";
              key: string;
              label: string;
              toolRef: string;
              outputPath: string;
              format?: import("../../packages/smass").SmassFieldFormat;
              classification: import("../../packages/smass").SmassClassification;
              required: boolean;
              exposed: boolean;
            }
          | {
              kind: "computed";
              key: string;
              label: string;
              expression: string;
              dependsOn: string[];
              type: import("../../packages/smass").SmassFieldType;
              format?: import("../../packages/smass").SmassFieldFormat;
              classification: import("../../packages/smass").SmassClassification;
              exposed: boolean;
            }
          | {
              kind: "aggregate";
              key: string;
              label: string;
              op: import("../../packages/smass").SmassAggregateOp;
              sourceField?: string;
              itemField?: string;
              sourceFields?: string[];
              targetModelId?: string;
              where?: import("../../packages/smass").SmassAggregateFilterSpec;
              type: import("../../packages/smass").SmassFieldType;
              format?: import("../../packages/smass").SmassFieldFormat;
              classification: import("../../packages/smass").SmassClassification;
              exposed: boolean;
            }
        >;
      }>;
      driftIssues: Array<{ modelId: string; field?: string; toolRef?: string; message: string }>;
      lineage: Record<
        string,
        { uiLayouts: string[]; widgets: string[]; ccreRules: string[]; childModels: string[]; virtualToolRef?: string }
      >;
      virtualTools: Array<{ toolRef: string; id: string; version: string; description: string; contractFingerprint: string }>;
      dataModel: import("../../packages/smass").SmassDataModelGraph;
      tools: Array<{
        toolRef: string;
        id: string;
        version: string;
        role: "read" | "action";
        description: string;
        contractFingerprint: string;
        modelIds: string[];
        inputFields: Array<{ path: string; type: string }>;
        outputFields: Array<{ path: string; type: string; exposed: boolean; label: string; format?: SphotonFormat }>;
      }>;
      catalog: SphotonBindingCatalog;
    }>("/api/admin/domain-models?domain=" + domainId),
  saveDomainModel: (
    domainId: DomainPackId,
    input: {
      id: string;
      previousId?: string;
      version?: string;
      status?: import("../../packages/smass").SmassModelStatus;
      label: string;
      description?: string;
      primaryKey?: string;
      principalKey?: string;
      unnest?: {
        toolRef: string;
        path: string;
        parentModelId?: string;
        parentJoinField?: string;
        indexField?: string;
      };
      relations?: Array<{
        name: string;
        targetModelId: string;
        cardinality: import("../../packages/smass").SmassRelationCardinality;
        localField: string;
        foreignField: string;
      }>;
      fields: Array<
        | {
            kind: "mapped";
            key: string;
            label: string;
            toolRef: string;
            outputPath: string;
            format?: import("../../packages/smass").SmassFieldFormat;
            classification?: import("../../packages/smass").SmassClassification;
            required?: boolean;
            exposed?: boolean;
          }
        | {
            kind: "computed";
            key: string;
            label: string;
            expression: string;
            dependsOn: string[];
            type?: import("../../packages/smass").SmassFieldType;
            format?: import("../../packages/smass").SmassFieldFormat;
            classification?: import("../../packages/smass").SmassClassification;
            exposed?: boolean;
          }
        | {
            kind: "aggregate";
            key: string;
            label: string;
            op: import("../../packages/smass").SmassAggregateOp;
            sourceField?: string;
            itemField?: string;
            sourceFields?: string[];
            targetModelId?: string;
            where?: import("../../packages/smass").SmassAggregateFilterSpec;
            type?: import("../../packages/smass").SmassFieldType;
            format?: import("../../packages/smass").SmassFieldFormat;
            classification?: import("../../packages/smass").SmassClassification;
            exposed?: boolean;
          }
      >;
    },
  ) => request<Awaited<ReturnType<typeof api.domainModels>>>("/api/admin/domain-models?domain=" + domainId, input),
  setDomainModelStatus: (
    domainId: DomainPackId,
    input: { modelId: string; status: import("../../packages/smass").SmassModelStatus },
  ) => request<Awaited<ReturnType<typeof api.domainModels>>>("/api/admin/domain-models-status?domain=" + domainId, input),
  deleteDomainModel: (domainId: DomainPackId, modelId: string) =>
    request<Awaited<ReturnType<typeof api.domainModels>>>("/api/admin/domain-models-delete?domain=" + domainId, { modelId }),
  testDomainModelSnapshot: (
    domainId: DomainPackId,
    input: { modelId: string; customerId?: string; requestedFields?: string[]; redactPii?: boolean },
  ) =>
    request<{ snapshot: import("../../packages/smass").SmassVirtualSnapshotResult }>(
      "/api/admin/domain-models-test?domain=" + domainId,
      input,
    ),
  saveDomainRelation: (
    domainId: DomainPackId,
    input: {
      sourceModelId: string;
      targetModelId: string;
      name: string;
      cardinality: import("../../packages/smass").SmassRelationCardinality;
      localField: string;
      foreignField: string;
    },
  ) => request<Awaited<ReturnType<typeof api.domainModels>>>("/api/admin/domain-models-relation?domain=" + domainId, input),
  deleteDomainRelation: (
    domainId: DomainPackId,
    input: { sourceModelId: string; targetModelId: string; name: string },
  ) => request<Awaited<ReturnType<typeof api.domainModels>>>("/api/admin/domain-models-relation-delete?domain=" + domainId, input),
  setBindingFieldExposure: (
    domainId: DomainPackId,
    input: { toolRef: string; outputPath: string; label: string; exposed: boolean; defaultFormat?: SphotonFormat },
  ) => request<SphotonBindingCatalog>("/api/admin/ui-binding-catalog?domain=" + domainId, input),
  testUiLayout: (domain: Conversation["domainId"], design: UiDesign, message: string, personaId?: string) =>
    request<TurnAccepted & { layoutId: string }>("/api/admin/ui-layout-test?domain=" + domain, { design, message, personaId }),
  saveUiLayout: (change: UiLayoutChange) => request<Reviewable<UiLayoutRecord>>("/api/admin/ui-layouts", change),
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
  saveWidgetLibrary: (change: WidgetLibraryChange, domainId: Conversation["domainId"] = "wealth") => request<Reviewable<{ widget?: SavedWidget; widgets: SavedWidget[] }>>("/api/admin/widgets?domain=" + domainId, change),
  customers: () => request<{ customers: Customer360AdminRecord[] }>("/api/admin/customers"),
  saveCustomer: (input: Customer360ProfileInput) => request<{ customer?: Customer360AdminRecord; customers: Customer360AdminRecord[] }>("/api/admin/customers", input),
  deleteOrResetCustomer: (personaId: string) => request<{ deleted: boolean; reset: boolean; customers: Customer360AdminRecord[] }>("/api/admin/customer-delete", { personaId }),
  resetCustomerNba: (personaId: string) => request<{ customers: Customer360AdminRecord[] }>("/api/admin/customer-reset-nba", { personaId }),
  experienceRegistryScopes: () => request<ExperienceRegistryScopes>("/api/admin/experience-registry?view=scopes"),
  experienceRegistry: () => request<ExperienceRegistryView>("/api/admin/experience-registry?domain=wealth"),
  recordWorkspaceRegistry: (domain: RecordWorkspaceRegistry["domainId"]) =>
    request<RecordWorkspaceRegistry>("/api/admin/experience-registry?domain=" + domain),
  saveRegistryIntent: (input: ManagedIntentInput) => request<Reviewable<ExperienceRegistryView>>("/api/admin/registry-intent", input),
  deleteOrResetRegistryIntent: (intentId: string) => request<Reviewable<ExperienceRegistryView>>("/api/admin/registry-intent-delete", { intentId }),
  saveRegistryContent: (input: ManagedContentInput) => request<Reviewable<ExperienceRegistryView>>("/api/admin/registry-content", input),
  deleteOrResetRegistryContent: (contentId: string) => request<Reviewable<ExperienceRegistryView>>("/api/admin/registry-content-delete", { contentId }),
  saveRegistryNba: (input: ManagedNbaRuleInput) => request<Reviewable<ExperienceRegistryView>>("/api/admin/registry-nba", input),
  reorderRegistryNba: (orderedIds: string[]) => request<Reviewable<ExperienceRegistryView>>("/api/admin/registry-nba-reorder", { orderedIds }),
  deleteOrResetRegistryNba: (id: string) => request<Reviewable<ExperienceRegistryView>>("/api/admin/registry-nba-delete", { id }),
  toolSetup: () => requestJson<ToolSetupView>("/api/admin/tools"),
  mcpServerConfig: () => request<{
    endpoint: string;
    protocolVersion: string;
    stdioCommand: string;
    config: { enabledToolRefs: string[]; includeKnowledgeSearch: boolean; includePublishedTasks: boolean };
    sfieldTools: Array<{ ref: string; label: string; description: string; effect: "read"; enabled: boolean; sampleArgs: Record<string, unknown> }>;
    publishedTaskCount: number;
  }>("/api/admin/mcp-server"),
  saveMcpServerConfig: (input: { enabledToolRefs: string[]; includeKnowledgeSearch: boolean; includePublishedTasks: boolean }) => request<{
    endpoint: string;
    protocolVersion: string;
    stdioCommand: string;
    config: { enabledToolRefs: string[]; includeKnowledgeSearch: boolean; includePublishedTasks: boolean };
    sfieldTools: Array<{ ref: string; label: string; description: string; effect: "read"; enabled: boolean; sampleArgs: Record<string, unknown> }>;
    publishedTaskCount: number;
  }>("/api/admin/mcp-server", input),
  callMcpRpc: (method: string, params?: Record<string, unknown>) => request<{
    jsonrpc: string;
    id: number;
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  }>("/api/mcp", { jsonrpc: "2.0", id: Date.now(), method, ...(params ? { params } : {}) }),
  routingFlows: (scope?: FlowScope) => requestJson<FlowCatalogSetup>("/api/admin/routing-flows" + (scope ? "?scope=" + scope : "")),
  saveRoutingFlows: (scope: FlowScope, changes: FlowOverrides, revision?: string) =>
    requestJson<Reviewable<FlowCatalogSetup>>("/api/admin/routing-flows?scope=" + scope, changes, revision),
  saveToolSetup: (setup: ToolSetup, revision?: string) => requestJson<Reviewable<ToolSetup>>("/api/admin/tools", setup, revision),
  testToolSetup: (setup: ToolSetup, personaId: string, scenarioId: string) => request<ConversationView>(
    "/api/admin/conversations?scope=preview", { setup, conversation: { personaId, scenarioId } },
  ),
  createCcreRule: (rule: MockCcreRule) => request<Reviewable<MockCcreRule>>("/api/admin/ccre-rules", rule),
  previewTreatmentSelector: (input: TreatmentPreviewInput) => request<TreatmentPreview>("/api/admin/treatment-preview", input),
  recordUpdates: (id: string) => request<RecordUpdate[]>("/api/conversations/" + id + "/updates"),
  conversation: (id: string) => request<ConversationView>("/api/conversations/" + id),
  conversationContext: (id: string) => request<{
    conversationId: string;
    completedTurnCount: number;
    rollingSummary: { activeGoal: string; establishedFacts: string[]; coveredThroughOrdinal: number; turnCountCovered: number; method: string; updatedAt: string } | null;
    rollingSummaryText: string | null;
    pendingClarification: { question: string; choices: Array<{ id: string; label: string; prompt?: string }> } | null;
    memoryCount: number;
    estimatedContextTokens: number;
    tokenBudget: number;
    utilizationPct: number;
  }>("/api/conversations/" + id + "/context"),
  compactConversation: (id: string) => request<{
    compacted: boolean;
    reason: string;
    context: {
      conversationId: string;
      completedTurnCount: number;
      rollingSummary: { activeGoal: string; establishedFacts: string[]; coveredThroughOrdinal: number; turnCountCovered: number; method: string; updatedAt: string } | null;
      rollingSummaryText: string | null;
      pendingClarification: { question: string; choices: Array<{ id: string; label: string; prompt?: string }> } | null;
      memoryCount: number;
      estimatedContextTokens: number;
      tokenBudget: number;
      utilizationPct: number;
    };
  }>("/api/conversations/" + id + "/compact", {}),
  goals: (personaId: string) => request<{ goals: Array<{ id: string; personaId: string; name: string; category: "home" | "retirement" | "education" | "emergency" | "travel" | "custom"; targetCents: number; savedCents: number; monthlyContributionCents: number; targetDate: string; builtIn?: boolean; sfieldRunId?: string }> }>("/api/goals?personaId=" + encodeURIComponent(personaId)),
  createGoal: (input: { personaId: string; name: string; category: "home" | "retirement" | "education" | "emergency" | "travel" | "custom"; targetCents: number; savedCents?: number; monthlyContributionCents?: number; targetDate?: string }) => request<{ goal: { id: string; name: string; targetCents: number; savedCents: number; monthlyContributionCents: number; targetDate: string; category: "home" | "retirement" | "education" | "emergency" | "travel" | "custom" }; goals: Array<{ id: string; personaId: string; name: string; category: "home" | "retirement" | "education" | "emergency" | "travel" | "custom"; targetCents: number; savedCents: number; monthlyContributionCents: number; targetDate: string; builtIn?: boolean }>; sfieldRunId?: string; auditId?: string }>("/api/goals", input),
  updateGoal: (id: string, input: { personaId: string; name?: string; targetCents?: number; savedCents?: number; monthlyContributionCents?: number; targetDate?: string }) => request<{ goal: { id: string; name: string }; goals: Array<{ id: string; personaId: string; name: string; category: "home" | "retirement" | "education" | "emergency" | "travel" | "custom"; targetCents: number; savedCents: number; monthlyContributionCents: number; targetDate: string; builtIn?: boolean }> }>("/api/goals/" + id + "/update", input),
  deleteGoal: (id: string, personaId: string) => request<{ deleted: boolean; goals: Array<{ id: string; personaId: string; name: string; category: "home" | "retirement" | "education" | "emergency" | "travel" | "custom"; targetCents: number; savedCents: number; monthlyContributionCents: number; targetDate: string; builtIn?: boolean }> }>("/api/goals/" + id + "/delete", { personaId }),
  recentTurns: () => request<{ turns: Array<{
    turnId: string;
    conversationId: string;
    personaId: string;
    domainId: string;
    message: string;
    createdAt: number;
    actionMode: string | null;
    mode: "intent" | "experience" | "funding" | "harness";
    semanticRoute: { capabilityId: string; capabilityLabel: string; method: string; confidence: number; reasoning: string } | null;
    selectedContextId: string | null;
    components: string[];
    routerRunId: string | null;
    composerRunId: string | null;
    agentRunId: string | null;
    routeRun: Stage | null;
    composeRun: Stage | null;
    portfolioReadSucceeded: boolean;
    goalReadSucceeded: boolean;
    metricReadSucceeded: boolean;
    tsSource: string | null;
    harnessTrace: import("../../packages/contracts/dynamic-canvas").DynamicHarnessTrace | null;
  }> }>("/api/admin/recent-turns"),
  changeConversation: (id: string, change: ConversationChange) => request<Conversation>("/api/conversations/" + id + "/settings", change),
  folders: (domainId?: Conversation["domainId"]) => request<{ folders: ConversationFolder[] }>("/api/folders" + (domainId ? "?domain=" + domainId : "")),
  createFolder: (name: string, domainId: Conversation["domainId"] = "wealth", instructions?: string) => request<{ folder: ConversationFolder }>("/api/folders", { name, domainId, ...(instructions ? { instructions } : {}) }),
  renameFolder: (id: string, name: string) => request<{ folder: ConversationFolder }>("/api/folders/" + id + "/rename", { name }),
  updateFolder: (id: string, patch: { name?: string; instructions?: string | null }) => request<{ folder: ConversationFolder }>("/api/folders/" + id + "/update", patch),
  folderSummary: (id: string) => request<{ folder: ConversationFolder; threadCount: number; threads: Array<{ conversationId: string; title: string; updatedAt: number; totalTurns: number; completedTurns: number; runningTurns: number; lastPrompt: string | null; lastSummary: string | null }> }>("/api/folders/" + id + "/summary"),
  deleteFolder: (id: string) => request<{ deleted: boolean; id: string }>("/api/folders/" + id + "/delete", {}),
  forkConversation: (id: string, input: { turnId?: string; title?: string } = {}) => request<ConversationView>("/api/conversations/" + id + "/fork", input),
  threadStatus: (personaId: string, conversationId?: string) => request<{
    otherThreads: Array<{ conversationId: string; title: string; runningTurns: number; completedTurns: number; totalTurns: number; status: string }>;
    currentThread?: { conversationId: string; runningTurns: number; completedTurns: number; totalTurns: number };
    activeTradeJobs: Array<{ jobId: string; status: string }>;
    activeWorkflowRuns: Array<{ runId: string; status: string }>;
  }>("/api/threads/status?" + new URLSearchParams({ personaId, ...(conversationId ? { conversationId } : {}) })),
  nextStep: (personaId: string) => request<WorkspaceNextStep | null>("/api/workspace/" + personaId + "/next-step"),
  pendingActions: (personaId: string) => request<WorkspacePendingAction[]>("/api/workspace/" + personaId + "/" + pendingActionsContext),
  workspaceActionState: (personaId: string) => request<WorkspaceActionState>("/api/workspace/" + personaId + "/action-state"),
  changeWorkspaceTodo: (personaId: string, command: WorkspaceTodoCommand) => request<WorkspacePendingAction[]>("/api/workspace/" + personaId + "/todos", command),
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
  saveConnector: (input: ConnectorUpsertInput) => request<Reviewable<{ connector: ExternalConnector; connectors: ExternalConnector[] }>>("/api/admin/connectors", input),
  deleteConnector: (id: string) => request<Reviewable<{ deleted: boolean; connectors: ExternalConnector[] }>>("/api/admin/connector-delete", { id }),
  testConnector: (id: string) => request<ConnectorTestResult>("/api/admin/connector-test", { id }),
  invokeConnector: (input: ConnectorInvokeInput) => request<{
    status: "pending_approval" | "executed";
    approval?: ApprovalRecord;
    approvalsView?: ApprovalsView;
    execution?: ConnectorInvokeExecution;
  }>("/api/admin/connector-invoke", input),
  approvals: () => request<ApprovalsView>("/api/approvals"),
  approval: (id: string) => request<ApprovalRecord>("/api/approvals/" + encodeURIComponent(id)),
  saveApprovalPolicy: (policy: Partial<ApprovalPolicySettings>) => request<{ policy: ApprovalPolicySettings; view: ApprovalsView }>("/api/approvals/policy", policy),
  decideApproval: (approvalId: string, input: Omit<ApprovalDecisionInput, "actor"> & { actor?: string }) => request<{
    approval: ApprovalRecord;
    job?: TradeJob;
    execution?: { summary?: string; sfieldRunId?: string; audit?: DomainWriteAuditEntry; jobId?: string; statusCode?: number; responsePreview?: string };
    view: ApprovalsView;
  }>("/api/approvals/" + approvalId + "/decide", input),
  actionFlows: () => request<{ flows: ActionFlow[] }>("/api/admin/action-flows"),
  saveActionFlow: (input: ActionFlowUpsertInput) => request<Reviewable<{ flow: ActionFlow; flows: ActionFlow[] }>>("/api/admin/action-flows", input),
  deleteActionFlow: (id: string) => request<Reviewable<{ deleted: boolean; flows: ActionFlow[] }>>("/api/admin/action-flow-delete", { id }),
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
  saveWorkflow: (input: WorkflowDefinitionUpsertInput) => request<Reviewable<WorkflowsAdminView>>("/api/workflows", input),
  deleteWorkflow: (id: string) => request<Reviewable<WorkflowsAdminView>>("/api/workflows/" + id + "/delete", {}),
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
  }) => request<Reviewable<{ connector: ExternalConnector; connectors: ExternalConnector[] }>>("/api/admin/mcp-import", input),
  proactiveAlerts: () => request<ProactiveView>("/api/proactive/alerts"),
  triggerProactiveEvent: (input: ProactiveTriggerInput) => request<{ alert: ProactiveAlert; view: ProactiveView }>("/api/proactive/trigger", input),
  dismissProactiveAlert: (id: string) => request<ProactiveView>("/api/proactive/" + id + "/dismiss", {}),
  knowledgeBase: () => request<KnowledgeBaseView>("/api/admin/knowledge-base"),
  saveKnowledgeDoc: (input: KnowledgeDocumentUpsertInput) => request<Reviewable<KnowledgeBaseView>>("/api/admin/knowledge-base", input),
  deleteKnowledgeDoc: (id: string) => request<Reviewable<KnowledgeBaseView>>("/api/admin/knowledge-base-delete", { id }),
  searchKnowledgeBase: (query: string) => request<KnowledgeSearchResult>("/api/admin/knowledge-search", { query }),
  scheduledJobs: () => request<ScheduledJobsView>("/api/admin/scheduled-jobs"),
  saveScheduledJob: (input: ScheduledJobUpsertInput) => request<ScheduledJobsView>("/api/admin/scheduled-jobs", input),
  runScheduledJob: (id: string) => request<{ execution: ScheduledJobExecution; view: ScheduledJobsView }>("/api/admin/scheduled-jobs-run", { id }),
  verticalPacks: () => request<VerticalPacksView>("/api/admin/vertical-packs"),
  generateVerticalPack: (prompt: string) => request<PublicationReview>("/api/admin/vertical-packs-generate", { prompt }),
  deleteVerticalPack: (id: string) => request<PublicationReview>("/api/admin/vertical-packs-delete", { id }),
  piiFirewall: () => request<PiiFirewallView>("/api/admin/pii-firewall"),
  savePiiFirewall: (patch: Partial<PiiFirewallConfig>) => request<PiiFirewallView>("/api/admin/pii-firewall", patch),
  testPiiFirewall: (prompt: string, contextSummary?: string) => request<{ trace: PiiRedactionTrace }>("/api/admin/pii-firewall-test", { prompt, ...(contextSummary ? { contextSummary } : {}) }),
  uxEvolution: () => request<UxEvolutionView>("/api/admin/ux-evolution"),
  scanUxEvolution: (includeSampleTraffic = false) => request<{ created: UxProposal[]; view: UxEvolutionView }>("/api/admin/ux-evolution-scan", { includeSampleTraffic }),
  approveUxProposal: (id: string) => request<Reviewable<{ proposal: UxProposal; view: UxEvolutionView }>>("/api/admin/ux-evolution-approve", { id }),
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
  newConversation: (personaId: string, scenarioId: string, domainId: Conversation["domainId"] = "wealth", folderId?: string) => request<ConversationView>(
    "/api/conversations",
    domainId === "wealth"
      ? { personaId, scenarioId, domainId, ...(folderId ? { folderId } : {}) }
      : { domainId, ...(folderId ? { folderId } : {}) },
  ),
  newAdminConversation: (personaId: string, scenarioId: string, domainId: Conversation["domainId"] = "wealth", folderId?: string) => request<ConversationView>(
    "/api/admin/conversations",
    domainId === "wealth"
      ? { personaId, scenarioId, domainId, ...(folderId ? { folderId } : {}) }
      : { domainId, ...(folderId ? { folderId } : {}) },
  ),
  turn: (id: string) => request<TurnView>("/api/turns/" + id),
  portfolioDisplayed: (id: string) => request("/api/turns/" + id + "/portfolio-displayed", {}),
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
  saveIntegration: (integration: Partial<Integration>) => request<Reviewable<{ integration: Integration; view: IntegrationTasksView }>>("/api/integrations/integrations", integration),
  importCurlIntegration: (input: { curl: string; sampleOutput?: string; integrationId?: string; taskId?: string }) => (
    request<import("../../packages/contracts/integration-task").CurlImportResult>("/api/integrations/import/curl", input)
  ),
  validateIntegrationDraft: (draft: TaskContractInput) => request<DraftCheck>("/api/integrations/contracts/validate", { draft }),
  saveIntegrationDraft: (draft: TaskContractInput) => request<{ contract: TaskContract; view: IntegrationTasksView }>("/api/integrations/contracts", draft),
  publishIntegrationTask: (ref: string) => request<{ status?: "pending_approval"; approval?: ApprovalRecord; contract?: TaskContract; breaking?: string[]; sfieldRegistered?: boolean; sfieldRoute?: "dedicated" | "dispatcher" | "unavailable"; registrationNote?: string; view: IntegrationTasksView }>("/api/integrations/contracts/publish", { ref }),
  pollIntegrationRun: (runId: string) => request<{ run: TaskRun; pollRun: TaskRun; terminal: boolean }>("/api/integrations/runs/poll", { runId }),
  resetIntegrationResilience: (integrationId: string) => request<{ view: IntegrationTasksView }>("/api/integrations/resilience/reset", { integrationId }),
  deleteIntegrationDraft: (ref: string) => request<{ deleted: true; ref: string; view: IntegrationTasksView }>("/api/integrations/contracts/delete", { ref }),
  deleteIntegration: (id: string) => request<{ deleted: true; id: string; view: IntegrationTasksView }>("/api/integrations/integrations/delete", { id }),
  handoffs: () => request<import("../../packages/contracts/handoff").HandoffInboxView>("/api/admin/handoffs"),
  activeHandoff: (personaId: string) => request<{ ticket: import("../../packages/contracts/handoff").HandoffTicket | null }>(`/api/handoffs/active?personaId=${encodeURIComponent(personaId)}`),
  createHandoff: (input: import("../../packages/contracts/handoff").CreateHandoffInput) => request<{ ticket: import("../../packages/contracts/handoff").HandoffTicket }>("/api/handoffs", input),
  handoffStatus: (handoffId: string) => request<{ ticket: import("../../packages/contracts/handoff").HandoffTicket }>(`/api/handoffs/${handoffId}`),
  handoffCustomerReply: (handoffId: string, text: string, role?: "customer" | "agent", author?: string) => request<{ ticket: import("../../packages/contracts/handoff").HandoffTicket }>(`/api/handoffs/${handoffId}/reply`, { text, ...(role ? { role } : {}), ...(author ? { author } : {}) }),
  closeHandoff: (handoffId: string) => request<{ ticket: import("../../packages/contracts/handoff").HandoffTicket }>(`/api/handoffs/${handoffId}/close`, {}),
  shareHandoffCard: (handoffId: string, input: { turnId?: string; prompt: string; sharedBy: "advisor" | "customer"; sharedByName: string; experience: Record<string, unknown> }) => request<{ ticket: import("../../packages/contracts/handoff").HandoffTicket }>(`/api/handoffs/${handoffId}/share-card`, input),
  updateHandoffCoBrowse: (handoffId: string, input: { updatedBy?: "advisor" | "customer"; active?: boolean; title?: string; sliders?: Partial<import("../../packages/contracts/handoff").CoBrowseSliders> }) => request<{ ticket: import("../../packages/contracts/handoff").HandoffTicket }>(`/api/handoffs/${handoffId}/cobrowse`, input),
  pushAdvisorProposal: (input: { handoffId: string; title: string; summary: string; actionLabel?: string; updates: Record<string, string> }) => request<{ ticket: import("../../packages/contracts/handoff").HandoffTicket; view: import("../../packages/contracts/handoff").HandoffInboxView }>("/api/admin/handoffs/propose", input),
  decideAdvisorProposal: (handoffId: string, decision: "accepted" | "declined") => request<{ ticket: import("../../packages/contracts/handoff").HandoffTicket; auditId?: string }>(`/api/handoffs/${handoffId}/proposal`, { decision }),
  commitParallelScenario: (input: import("../../packages/contracts/nextgen-chat").ScenarioPlanInput) => request<{ committed: boolean; summary: string; approvalId: string; auditId: string; payloadDigest: string }>("/api/chat/commit-scenario", input),
  listWatchcards: (personaId?: string) => request<{ watchcards: import("../../packages/contracts/nextgen-chat").Watchcard[] }>(`/api/watchcards${personaId ? `?personaId=${encodeURIComponent(personaId)}` : ""}`),
  createWatchcard: (input: import("../../packages/contracts/nextgen-chat").CreateWatchcardInput) => request<{ watchcard: import("../../packages/contracts/nextgen-chat").Watchcard; watchcards: import("../../packages/contracts/nextgen-chat").Watchcard[] }>("/api/watchcards", input),
  simulateWatchcard: (id: string) => request<{ watchcard: import("../../packages/contracts/nextgen-chat").Watchcard; watchcards: import("../../packages/contracts/nextgen-chat").Watchcard[] }>(`/api/watchcards/${id}/simulate`, {}),
  executeWatchcard: (id: string) => request<{ watchcard: import("../../packages/contracts/nextgen-chat").Watchcard; auditId: string; watchcards: import("../../packages/contracts/nextgen-chat").Watchcard[] }>(`/api/watchcards/${id}/execute`, {}),
  dismissWatchcard: (id: string) => request<{ watchcard: import("../../packages/contracts/nextgen-chat").Watchcard; watchcards: import("../../packages/contracts/nextgen-chat").Watchcard[] }>(`/api/watchcards/${id}/dismiss`, {}),
  agentDelegationView: (personaId?: string) => request<import("../../packages/contracts/nextgen-chat").AgentDelegationView>(`/api/agent-delegation${personaId ? `?personaId=${encodeURIComponent(personaId)}` : ""}`),
  mintDelegationPass: (input: import("../../packages/contracts/nextgen-chat").CreateDelegationPassInput) => request<{ pass: import("../../packages/contracts/nextgen-chat").AgentDelegationPass; view: import("../../packages/contracts/nextgen-chat").AgentDelegationView }>("/api/agent-delegation/pass", input),
  revokeDelegationPass: (passId: string) => request<{ pass: import("../../packages/contracts/nextgen-chat").AgentDelegationPass; view: import("../../packages/contracts/nextgen-chat").AgentDelegationView }>("/api/agent-delegation/revoke", { passId }),
  runAgentNegotiation: (input: import("../../packages/contracts/nextgen-chat").RunNegotiationInput) => request<{ session: import("../../packages/contracts/nextgen-chat").NegotiationSession; view: import("../../packages/contracts/nextgen-chat").AgentDelegationView }>("/api/agent-delegation/negotiate", input),
  approveAgentNegotiation: (sessionId: string) => request<{ session: import("../../packages/contracts/nextgen-chat").NegotiationSession; view: import("../../packages/contracts/nextgen-chat").AgentDelegationView }>("/api/agent-delegation/approve", { sessionId }),
  claimHandoff: (handoffId: string) => request<{ ticket: import("../../packages/contracts/handoff").HandoffTicket; view: import("../../packages/contracts/handoff").HandoffInboxView }>("/api/admin/handoffs/claim", { handoffId }),
  replyHandoff: (handoffId: string, text: string) => request<{ ticket: import("../../packages/contracts/handoff").HandoffTicket; view: import("../../packages/contracts/handoff").HandoffInboxView }>("/api/admin/handoffs/reply", { handoffId, text }),
  resolveHandoff: (handoffId: string, resolutionNote?: string) => request<{ ticket: import("../../packages/contracts/handoff").HandoffTicket; view: import("../../packages/contracts/handoff").HandoffInboxView }>("/api/admin/handoffs/resolve", { handoffId, ...(resolutionNote ? { resolutionNote } : {}) }),
  memoryList: () => request<{ items: Array<{ id: string; kind: "preference" | "fact" | "summary"; content: string; createdAt: string; structured?: { key: string; value: unknown } }> }>("/api/memory"),
  memorySave: (input: { kind: "preference" | "fact"; content: string; key?: string }) => request<{ item: { id: string; kind: "preference" | "fact" | "summary"; content: string; createdAt: string }; items: Array<{ id: string; kind: "preference" | "fact" | "summary"; content: string; createdAt: string; structured?: { key: string; value: unknown } }> }>("/api/memory", input),
  memoryForget: (id: string) => request<{ receipt: { count: number }; items: Array<{ id: string; kind: "preference" | "fact" | "summary"; content: string; createdAt: string; structured?: { key: string; value: unknown } }> }>("/api/memory/forget", { id }),
  publicKnowledgeSearch: (query: string) => request<import("../../packages/contracts/knowledge-base").KnowledgeSearchResult>("/api/knowledge-search", { query }),
  gatewayConfig: () => request<import("./gateway-admin").GatewayView>("/api/admin/gateway"),
  testGateway: (config: unknown) => request<import("./gateway-admin").GatewayTest>("/api/admin/gateway/test", { config }),
  activateGateway: (config: unknown) => request<Reviewable<{ activated: boolean; restarting: boolean; view: import("./gateway-admin").GatewayView }>>("/api/admin/gateway/activate", { config }),
  resetGateway: () => request<Reviewable<{ reset: boolean; restarting: boolean; view: import("./gateway-admin").GatewayView }>>("/api/admin/gateway/reset", {}),
  discoverIntegrationMcp: (integrationId: string) => request<{ integrationId: string; candidates: McpImportCandidate[] }>("/api/integrations/mcp/discover", { integrationId }),
  migrateLegacyConnectors: (connectorId?: string) => request<PublicationReview>("/api/integrations/migrate-connectors", connectorId ? { connectorId } : {}),
  telemetry: () => request<import("../../packages/contracts/telemetry").TelemetryView>("/api/admin/telemetry"),
  exportOtlpTelemetry: () => request<Record<string, unknown>>("/api/admin/telemetry/export"),
  resetTelemetry: () => request<import("../../packages/contracts/telemetry").TelemetryView>("/api/admin/telemetry/reset", {}),
};
