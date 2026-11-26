import { serverTenantId } from "./tenant";
import type { EvaluationRow } from "../../packages/contracts/evaluation";
import { axeBudget, experienceAgentId, type ExecutionBudget } from "../../packages/contracts/agentic";
import { availableFundingOptions, fundingPreviewFrom } from "../../packages/capabilities";
import { AgenticExecution } from "./agentic-execution";
import { axeAgentConfig } from "./agentic-model";
import { axeToolAction, ExperienceAgent } from "./experience-agent";
import { dirname, resolve } from "node:path";
import { ASK_USER, defineTool, digestJson, estimateJsonTokens, estimateTokens, SField, ToolError } from "@sfield/core";
import type { ConfigDocument, DefineToolInput, JsonObject, JsonValue, Principal, RunRecord, RunResult, ToolHandlerContext, Verifier } from "@sfield/core";
import { SqlitePersistence } from "@sfield/store-sqlite";
import host from "../../fixtures/host.json";
import { findProfileById, type PersonaRecord } from "../../packages/customer-profiles";
import { MAX_MESSAGE_LENGTH, metricReadingSchema, TURN_DEADLINE, type BalanceProof, type Scope } from "../../packages/contracts/domain";
import {
  fundingAgentId, fundingAgentToolLimit, fundingOptionsSchema, fundingToolRef, fundingToolVersion,
  treatmentRecommendationsVersion, treatmentDecisionVersion,
} from "../../packages/contracts/funding-workflow";
import { readRetirementView } from "../../packages/retirement-accounts";
import { retirementListIntent, retirementBeneficiaryIntent } from "../../packages/contracts/retirement-accounts";
import { retirementAccountsResultSchema } from "../../packages/contracts/model-schemas";
import { goalProgressSchema, isHomeGoalSummary } from "../../packages/contracts/goal-progress";
import {
  balanceInputSchema, balanceResultSchema, compositionOutputSchema, contextResultSchema, portfolioInputSchema, portfolioResultSchema,
  glossaryInputSchema, glossaryResultSchema, goalProgressInputSchema, goalProgressResultSchema,
  fundingAgentResultSchema, fundingOptionsResultSchema, fundingReadInputSchema, fundingStatusResultSchema, fundingPreviewInputSchema,
  fundingPreviewResultSchema, treatmentRecommendationsResultSchema, treatmentDecisionResultSchema,
  propensityInputSchema, propensityResultSchema, routingOutputSchema,
  treatmentInputSchema, treatmentResultSchema, turnInputSchema,
} from "../../packages/contracts/model";
import { isPortfolioSummary } from "../../packages/contracts/portfolio";
import {
  leavingWorkQuestion, portfolioSummaryQuestion, routingIntents, routingQuestions,
  ROUTING_HISTORY_TURNS, ROUTING_HISTORY_REQUEST_LENGTH, ROUTING_HISTORY_REPLY_LENGTH,
} from "../../packages/contracts/routing-intents";
import { sfieldTools, toolKeys, toolVersion, type MockCcreEvaluation, type ToolKey, type ToolSetup } from "../../packages/contracts/tool-setup";
import {
  recommendationArbitrateInputJsonSchema,
  recommendationArbitrateInputSchema,
  recommendationArbitrateResultJsonSchema,
  recommendationArbitrateResultSchema,
  recommendationArbitrateToolId,
  recommendationArbitrateToolRef,
  recommendationArbitrateToolVersion,
  type RecommendationArbitrateResult,
  type RecommendationDomain,
  type RecommendationProvider,
  type RecommendationProviderDescriptor,
} from "../../packages/contracts/recommendation-provider";
import {
  createCustomer360NbaProvider,
  createOpsRunbookProvider,
  createSalesDealDeskProvider,
  createTreatmentSelectorProvider,
  RecommendationArbitrator,
} from "../../packages/recommendations";
import type { Customer360Service } from "./customer-360";
import type { OpsIncidentStore } from "./ops-store";
import type { SalesDealStore } from "./sales-store";
import type { ConnectorStore } from "./connector-store";
import type { WriteAuditStore } from "./write-audit";
import type { SelfServicePznStore } from "./self-service-pzn-store";
import { canonicalJson, type ApprovalStore } from "./approval-store";
import { rehydrateObjectStrings, scrubNeutralModelRequest, type PiiFirewallStore } from "./pii-firewall";
import type { CepTelemetry } from "./telemetry";
import { PznApprovalError, splitApprovalId, verifyPznApproval } from "./pzn-approvals";
import { needsApproval, TaskCallExecutor, taskToolId, type IntegrationTaskRuntime, type IntegrationTaskStore } from "./integration-tasks";
import { taskEnvelopeJsonSchema, type TaskContract } from "../../packages/contracts/integration-task";
import { SFieldError, sharedValidator, type ExecutionScope } from "@sfield/core";
import {
  pznDataDictionaryToolId,
  pznDataDictionaryToolInputJsonSchema,
  pznGenericToolResultJsonSchema,
  pznRuleMetadataToolId,
  pznRuleMetadataToolInputJsonSchema,
  pznSfieldToolRefs,
  pznSfieldToolVersion,
  pznTreatmentSelectorToolId,
  pznTreatmentSelectorToolInputJsonSchema,
} from "../../packages/contracts/self-service-pzn";
import type { CustomerProfileStore } from "../../packages/customer-profiles";
import type { DomainWriteAuditEntry } from "../../packages/contracts/api";
import { compileComposerInstructions, compileRouterInstructions } from "../../packages/experience/prompt-compiler";

export const domainWriteToolId = "cep.domain.execute_write";
export const domainWriteToolVersion = "1.0.0";
export const domainWriteToolRef = `${domainWriteToolId}@${domainWriteToolVersion}`;

export const connectorInvokeToolId = "cep.connector.invoke";
export const connectorInvokeToolVersion = "1.0.0";
export const connectorInvokeToolRef = `${connectorInvokeToolId}@${connectorInvokeToolVersion}`;

const connectorInvokeInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["connectorId", "action", "actor"],
  properties: {
    connectorId: { type: "string", minLength: 1, maxLength: 64 },
    action: { type: "string", minLength: 1, maxLength: 64 },
    actor: { type: "string", minLength: 1, maxLength: 80 },
    payloadJson: { type: "string", maxLength: 4000 },
  },
} as const;

const connectorInvokeResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "connectorId", "connectorName", "statusCode", "elapsedMs", "summary", "responsePreview", "sandbox"],
  properties: {
    ok: { type: "boolean" },
    connectorId: { type: "string", minLength: 1, maxLength: 64 },
    connectorName: { type: "string", minLength: 1, maxLength: 100 },
    statusCode: { type: "integer" },
    elapsedMs: { type: "integer" },
    summary: { type: "string", minLength: 1, maxLength: 320 },
    responsePreview: { type: "string", maxLength: 600 },
    sandbox: { type: "boolean" },
  },
} as const;

const domainWriteInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["domain", "recordId", "action", "actor"],
  properties: {
    domain: { type: "string", enum: ["ops_incident", "sales_deal", "customer360"] },
    recordId: { type: "string", minLength: 1, maxLength: 64 },
    action: { type: "string", minLength: 1, maxLength: 64 },
    actor: { type: "string", minLength: 1, maxLength: 80 },
    note: { type: "string", maxLength: 240 },
    updatesJson: { type: "string", maxLength: 4000 },
  },
} as const;

const domainWriteResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "recordId", "summary"],
  properties: {
    ok: { type: "boolean" },
    updatedFields: { type: "array", items: { type: "string" } },
    recordId: { type: "string", minLength: 1, maxLength: 64 },
    summary: { type: "string", minLength: 1, maxLength: 320 },
  },
} as const;
import { activeContextCatalog, fixtureEligibleSets, FixtureTsAdapter, type ContextScoresRequest, type FixtureState } from "../../packages/ts-adapter";
import { nextStepContext, workspaceFundingContext, type WorkspaceNextStep } from "../../packages/contracts/workspace";
import { beneficiaryReviewWorkflow, workflowDefinition } from "../../packages/contracts/customer-workflows";
import { nextStepRecommendation, workflowOfferSource } from "./funding-offer";
import { mockRuleGlossary } from "../../packages/rule-glossary";
import { fixturePortfolioSnapshotProvider, type PortfolioSnapshotProvider } from "../../packages/portfolio-snapshot";
import { fixtureGoalProgressProvider, type GoalProgressProvider } from "../../packages/goal-progress";
import { contentCatalog, lookupContent, modelBundle, readDemoBalance, resolveCandidates } from "../../packages/experience/content";
import { checkFresh, Rejected, requireCheck, verifyContextProposal, verifyExperience, verifyRoute } from "../../packages/experience/verify";
import { makeId } from "../../packages/experience/compile";
import type { GatewayExchange, TurnExchangeStage } from "../../packages/contracts/inspector";
import { configureCopilotAcp } from "./copilot-acp";
import { configureGateway, type GatewaySettings } from "./gateway";
import { FundingAgent, fundingAgentInstructions } from "./funding-agent";
import { ApiError, stageAgent, type ConversationRecord, type Stage, type StageAttempt, type Store, type TurnRecord } from "./store";
import { readTurnPayloads } from "./turn-payloads";

const toolRefs = {
  catalog: `${sfieldTools.catalog.id}@${toolVersion}`,
  propensity: `${sfieldTools.propensity.id}@${toolVersion}`,
  selection: `${sfieldTools.selection.id}@${toolVersion}`,
  recommendations: `${sfieldTools.selection.id}@${treatmentRecommendationsVersion}`,
  decisions: `${sfieldTools.selection.id}@${treatmentDecisionVersion}`,
  balances: `${sfieldTools.balances.id}@${toolVersion}`,
  glossary: `${sfieldTools.glossary.id}@${toolVersion}`,
  retirementAccounts: `${sfieldTools.retirementAccounts.id}@${toolVersion}`,
  portfolio: `${sfieldTools.portfolio.id}@${toolVersion}`,
  goal: `${sfieldTools.goal.id}@${toolVersion}`,
  fundingOptions: fundingToolRef("fundingOptions"),
  fundingStatus: fundingToolRef("fundingStatus"),
  fundingPreview: fundingToolRef("fundingPreview"),
  arbitrateRecommendations: recommendationArbitrateToolRef,
} as const;
const registryPurposes = {
  catalogScopeId: "pzn-context-discovery",
  tsScopeId: "pzn-treatment-selection",
  glossaryScopeId: "pzn-ccre-glossary",
  retirementScopeId: "pzn-retirement-accounts",
  portfolioScopeId: "pzn-portfolio-snapshot",
  goalScopeId: "pzn-goal-progress",
  workflowScopeId: "pzn-customer-workflow",
} as const;
const registryBoundaries = {
  catalog: "catalogScopeId", propensity: "catalogScopeId", selection: "tsScopeId", glossary: "glossaryScopeId", portfolio: "portfolioScopeId",
  retirementAccounts: "retirementScopeId", goal: "goalScopeId", fundingOptions: "workflowScopeId", fundingStatus: "workflowScopeId", fundingPreview: "workflowScopeId",
} as const;
export function principalFor(id: string, scope?: Pick<Scope, "userId" | "personaId" | "domainId">): Principal {
  return { tenantId: serverTenantId, subjectId: id, roles: ["pzn-demo", "pzn-developer"], attributes: scope?.domainId ? { domainId: scope.domainId, userId: scope.userId ?? scope.personaId } : {} };
}
const actions = new Set<string>([
  ...toolKeys.map((key) => sfieldTools[key].id),
  recommendationArbitrateToolId,
  pznTreatmentSelectorToolId,
]);
export const sfieldNamespace = "pzn-experience-runtime";

function requireToolEnabled(turn: TurnRecord, key: ToolKey) {
  if (turn.toolSetup?.enabled[key] === false) throw new ToolError("TOOL_DISABLED");
}

/** The same capacity rule the runtime applies at startup, for testing a gateway configuration before activating it. */
export function checkGatewayCapacity(settings: GatewaySettings) {
  checkModelCapacity(settings, compileRouterInstructions(), compileComposerInstructions());
}

function checkModelCapacity(settings: GatewaySettings, routerText: string, composerText: string) {
  const usable = Math.min(12_000, settings.contextWindow - settings.maxOutputTokens - 384);
  const questions = estimateJsonTokens(host.clarificationQuestions);
  const message = estimateTokens("X".repeat(MAX_MESSAGE_LENGTH));
  const history = Array.from({ length: ROUTING_HISTORY_TURNS }, () => ({
    request: "X".repeat(ROUTING_HISTORY_REQUEST_LENGTH), contextId: "learning",
    intentId: "beneficiary_update_steps", clarificationQuestion: leavingWorkQuestion,
    assistantReply: "X".repeat(ROUTING_HISTORY_REPLY_LENGTH),
    displayedContent: ["Retirement planning basics", "Update your beneficiaries"],
  }));
  const routing = estimateTokens(routerText) + estimateJsonTokens(activeContextCatalog) + estimateJsonTokens(routingOutputSchema)
    + estimateJsonTokens(routingIntents) + estimateJsonTokens(routingQuestions) + estimateJsonTokens(history) + message + 600;
  const largestBundle = Math.max(...fixtureEligibleSets.map((ids) => estimateJsonTokens(modelBundle({
    decisionId: "decision_capacity_check", scope: { principalId: "", personaId: "", conversationId: "", turnId: "" },
    routeDecisionId: "", contextId: "", catalogVersion: contentCatalog.catalogVersion,
    issuedAt: 0, expiresAt: 0, selectionMode: "preserve_ts_rank", partial: false, composerRunId: null,
    candidates: resolveCandidates(ids).candidates,
  }))));
  const composition = estimateTokens(composerText) + estimateJsonTokens(compositionOutputSchema)
    + Math.max(largestBundle, estimateJsonTokens(history))
    + questions + message + 1_450;
  if (Math.max(routing, composition) * 1.10 > usable) {
    throw new Error("The configured model context window cannot fit the complete demo catalog or candidate bundle.");
  }
}

function runtimeConfig(settings: GatewaySettings, model: JsonObject, budget: ExecutionBudget): ConfigDocument {
  const routerText = compileRouterInstructions();
  const composerText = compileComposerInstructions();
  checkModelCapacity(settings, routerText, composerText);
  const readOnly = { preset: "read_only" };
  const context = { output_reserve_tokens: settings.maxOutputTokens };
  const memory = { conversation: false, preferences: "off", facts: "off" };
  return {
    version: 1,
    models: { default: model },
    agents: {
      [experienceAgentId]: axeAgentConfig(context, memory, budget),
      "context-router": {
        instructions: routerText,
        tools: [], memory, context, policy: readOnly,
        budget: { max_model_calls: 2, max_provider_attempts: 2, max_tool_calls: 0, max_tool_attempts: 0, max_active_seconds: 42, max_elapsed_seconds: 45 },
        output: { stream: false, max_repairs: 1, verifier: "contextSelection", schema: routingOutputSchema },
      },
      "experience-composer": {
        instructions: composerText,
        tools: [toolRefs.balances], memory, context, policy: readOnly,
        budget: { max_model_calls: 4, max_provider_attempts: 4, max_tool_calls: 1, max_tool_attempts: 1, max_active_seconds: 42, max_elapsed_seconds: 45 },
        output: { stream: false, max_repairs: 1, verifier: "experience", schema: compositionOutputSchema },
      },
      [fundingAgentId]: {
        instructions: fundingAgentInstructions,
        tools: [toolRefs.fundingStatus, toolRefs.fundingOptions, toolRefs.fundingPreview],
        memory, context, policy: readOnly,
        budget: {
          max_tool_calls: fundingAgentToolLimit, max_tool_attempts: fundingAgentToolLimit,
          max_model_calls: fundingAgentToolLimit + 2, max_provider_attempts: fundingAgentToolLimit + 3,
          max_active_seconds: 85, max_elapsed_seconds: 345,
        },
        output: { stream: false, max_repairs: 1, verifier: "fundingPreview", schema: fundingAgentResultSchema },
      },
    },
  };
}

export class Runtime implements IntegrationTaskRuntime {
  private sf!: SField;
  readonly funding: FundingAgent;
  readonly experiences: ExperienceAgent;
  private constructor(
    private readonly store: Store,
    private readonly now: () => number,
    private readonly inspection: ReturnType<typeof configureGateway>["inspection"],
    private readonly portfolioSnapshots: PortfolioSnapshotProvider,
    private readonly goalProgressProvider: GoalProgressProvider,
    readonly goalBudget: ExecutionBudget,
    private readonly customer360?: Customer360Service,
    private readonly opsStore?: OpsIncidentStore,
    private readonly salesStore?: SalesDealStore,
    private readonly profileStore?: CustomerProfileStore,
    private readonly writeAudit?: WriteAuditStore,
    private readonly connectorStore?: ConnectorStore,
    private readonly selfServicePzn?: SelfServicePznStore,
    private readonly approvalStore?: ApprovalStore,
    private readonly integrationTasks?: IntegrationTaskStore,
    private readonly piiFirewall?: PiiFirewallStore,
    private readonly telemetry?: CepTelemetry,
    private readonly modelMeta?: { provider: string; model: string },
  ) {
    this.integrationExecutor = new TaskCallExecutor(integrationTasks?.orders, connectorStore);
    this.funding = new FundingAgent(store, () => this.sf, now);
    const execution = new AgenticExecution(store, () => this.sf, now, (turnId) => this.current(turnId), portfolioSnapshots, goalProgressProvider, goalBudget);
    this.experiences = new ExperienceAgent(execution, () => this.sf);
  }

  static async open(
    store: Store, path: string, settings: GatewaySettings, now: () => number,
    inspectorEnabled = false, portfolioSnapshots = fixturePortfolioSnapshotProvider, goalProgressProvider = fixtureGoalProgressProvider, goalBudget: ExecutionBudget = axeBudget,
    extraProviders?: {
      customer360?: Customer360Service;
      opsStore?: OpsIncidentStore;
      salesStore?: SalesDealStore;
      profileStore?: CustomerProfileStore;
      writeAudit?: WriteAuditStore;
      connectorStore?: ConnectorStore;
      selfServicePzn?: SelfServicePznStore;
      approvalStore?: ApprovalStore;
      integrationTasks?: IntegrationTaskStore;
      piiFirewall?: PiiFirewallStore;
      telemetry?: CepTelemetry;
    },
  ) {
    const record = inspectorEnabled ? (id: string, exchange: GatewayExchange) => store.saveGatewayExchange(id, exchange) : undefined;
    const gateway = settings.profile === "copilot_acp"
      ? await configureCopilotAcp(settings, resolve(dirname(path), "copilot-cli"), record)
      : configureGateway(settings, record);
    const runtime = new Runtime(
      store, now, gateway.inspection, portfolioSnapshots, goalProgressProvider, goalBudget,
      extraProviders?.customer360, extraProviders?.opsStore, extraProviders?.salesStore,
      extraProviders?.profileStore, extraProviders?.writeAudit, extraProviders?.connectorStore,
      extraProviders?.selfServicePzn,
      extraProviders?.approvalStore,
      extraProviders?.integrationTasks,
      extraProviders?.piiFirewall,
      extraProviders?.telemetry,
      { provider: settings.profile === "copilot_acp" ? "copilot_acp" : settings.profile === "openai" ? "openai" : "openai_compatible", model: settings.model },
    );
    const agentTools = [...runtime.experiences.tools(), ...runtime.experiences.execution.tools()];
    const agentActions = new Set(agentTools.map(({ ref }) => axeToolAction(ref)));
    runtime.sf = await SField.create({
      deployment: "durable_single", config: runtimeConfig(settings, gateway.model, goalBudget),
      persistence: new SqlitePersistence({ path }),
      namespace: sfieldNamespace,
      ...(extraProviders?.telemetry ? { telemetry: extraProviders.telemetry } : {}),
      ...gateway.options,
      authorizer: {
        async authorize({ principal, action, effect, agentId, resource, argumentsDigest, runId }) {
          const readAllowed = effect === "read" && (
            actions.has(action) || agentActions.has(action) || action.startsWith("int.")
            || ((agentId === fundingAgentId || agentId === experienceAgentId) && action === ASK_USER.policy.action)
          );
          const writeAllowed = (effect === "write" || effect === "destructive") && !agentId && (
            (effect === "write" && (
              action === domainWriteToolId
              || action === connectorInvokeToolId
              || action === pznDataDictionaryToolId
              || action === pznRuleMetadataToolId
            ))
            || action.startsWith("int.")
          );
          return principal.tenantId === serverTenantId && principal.roles.includes("pzn-demo") && (readAllowed || writeAllowed)
            ? {
              decision: "allow",
              // Deterministic per (run, principal, action, resource, arguments): sfield binds approvals to a prepared
              // invocation digest that includes this evidence id, so a random id would invalidate every approval on re-prepare.
              evidenceId: "auth_" + digestJson({ runId, tenantId: principal.tenantId, subjectId: principal.subjectId, action, effect, resourceType: resource.type, resourceId: String(resource.id), argumentsDigest } as JsonObject).replace(/^sha256:/, "").slice(0, 24),
              expiresAt: new Date(now() + axeBudget.activeSeconds * 1000).toISOString() }
            : { decision: "deny", code: "TOOL_DENIED", reason: "The demo permits scoped reads and host-governed domain writes." };
        },
      },
      input: { async request() { /* The chat turn renders the persisted input request. */ } },
      hooks: [
        {
          id: "pzn-funding-model-tools", point: "beforeModelDispatch", timeoutMs: 1_000, onFailure: "fail",
          seesProtectedContent: false, buildIdentity: "pzn-funding-tools-v1",
          async beforeModelDispatch({ request, runId }) {
            return { request: await runtime.experiences.narrow(request, runId) ?? await runtime.funding.narrow(request, runId) };
          },
        },
        {
          id: "cep-pii-egress-firewall", point: "beforeModelDispatch", timeoutMs: 1_000, onFailure: "fail",
          seesProtectedContent: true, buildIdentity: "cep-pii-firewall-v1",
          async beforeModelDispatch({ request, runId }) {
            if (!runtime.piiFirewall || !runtime.piiFirewall.getConfig().enabled) return;
            const knownNames = runtime.profileStore?.list().map((p) => p.displayName) ?? [];
            const scrubbed = scrubNeutralModelRequest(request, knownNames, runtime.piiFirewall, runId);
            if (scrubbed.redactedCount > 0) {
              runtime.rememberRunPiiTokens(runId, scrubbed.tokenMap);
              runtime.telemetry?.recordPiiRedaction(scrubbed.redactedCount, "sfield:beforeModelDispatch", runId);
              return { request: scrubbed.request };
            }
          },
        },
        {
          id: "pzn-funding-tool-input", point: "prepareTool", timeoutMs: 1_000, onFailure: "fail",
          seesProtectedContent: false, buildIdentity: "pzn-funding-input-v1",
          async prepareTool({ toolRef, inputs, runId, principal }) {
            return await runtime.experiences.prepare(toolRef, runId, principal) ?? runtime.funding.prepare(toolRef, inputs, runId);
          },
        },
      ],
      tools: [...runtime.tools(), ...agentTools, ...runtime.integrationTools()],
      verifiers: {
        contextSelection: runtime.verifier("contextSelection", "route"),
        experience: runtime.verifier("experience", "compose"),
        fundingPreview: {
          id: "fundingPreview", kind: "validator",
          async validate(output, { runId }) {
            try {
              await runtime.funding.verify(output, runId);
              return { ok: true };
            } catch (error) {
              return { ok: false, reason: error instanceof Rejected ? error.code : "FUNDING_RESULT_INVALID" };
            }
          },
        },
      },
      limits: {
        requestMaxBytes: 64 * 1024,
        inputExpirySeconds: 300,
        grants: { effects: ["read", "write"], autonomousWrites: true, interactionTools: ["ask_user"] },
      },
    });
    return runtime;
  }

  payloads(turn: TurnRecord, conversation: ConversationRecord) {
    return this.inspection && readTurnPayloads(this.sf, this.store, this.inspection, turn, conversation);
  }

  captureTurnExchange(turnId: string, stage: TurnExchangeStage, operation: string, request: unknown, response: unknown) {
    const inspection = this.inspection;
    if (!inspection) return;
    try {
      const safe = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) =>
        key === "principalId" || key === "requestSessionId" ? "[REDACTED]" : item)) as JsonValue;
      const captureRequest = stage === "flowRouting" ? inspection.requestPayload : inspection.payload;
      this.store.saveTurnExchange(turnId, stage, { operation, request: captureRequest(safe(request)), response: inspection.payload(safe(response)) });
    } catch { /* An unavailable trace must not change the chat result. */ }
  }

  async evaluation(principalId: string): Promise<EvaluationRow[]> {
    const turns = this.store.recentCompletedTurns(principalId);
    const items = await Promise.all(turns.map(async (turn) => {
      const ids = new Set([
        turn.agentRunId, ...turn.agentExecutionIds ?? [], ...Object.values(turn.attempts).map(({ runId }) => runId),
        turn.catalogScopeId, turn.tsScopeId, turn.retirementScopeId, turn.portfolioScopeId, turn.goalScopeId, turn.glossaryScopeId,
        turn.workflowScopeId, turn.fundingRun?.id,
      ].filter((id): id is string => Boolean(id)));
      const results = await Promise.all([...ids].map(async (id) => {
        const run = await this.sf.persistence.getRun(id);
        if (run?.subjectId !== principalId || run.tenantId !== serverTenantId) return;
        const calls = await this.sf.persistence.listCalls(id);
        const phases = turn.fundingRun?.id === id ? turn.fundingRun : undefined;
        const modelCalls = phases && phases.through ? phases.through.attempts - phases.after.attempts : run.usage.modelCalls;
        const toolCalls = phases ? calls.slice(phases.after.calls, phases.through?.calls).length : calls.length;
        const tokens = phases ? (await this.sf.persistence.listModelAttempts(id)).slice(phases.after.attempts, phases.through?.attempts)
          .reduce((sum, attempt) => sum + (attempt.usage?.inputTokens ?? 0) + (attempt.usage?.outputTokens ?? 0), 0) : run.usage.totalTokens;
        return { modelCalls, toolCalls, tokens };
      }));
      return {
        path: turn.agentRunId ? "goal" : "fast", completed: turn.public.status === "completed",
        ms: (turn.trace.markers.terminal ?? turn.public.createdAt) - turn.public.createdAt,
        modelCalls: results.reduce((sum, row) => sum + (row?.modelCalls ?? 0), 0),
        toolCalls: results.reduce((sum, row) => sum + (row?.toolCalls ?? 0), 0),
        tokens: results.reduce((sum, row) => sum + (row?.tokens ?? 0), 0),
      };
    }));
    return (["fast", "goal"] as const).map((path) => {
      const rows = items.filter((item) => item.path === path);
      const ordered = rows.map(({ ms }) => ms).sort((a, b) => a - b);
      return { path, turns: rows.length, completed: rows.filter(({ completed }) => completed).length, medianMs: ordered[Math.floor(ordered.length / 2)] ?? null,
        modelCalls: rows.reduce((sum, row) => sum + row.modelCalls, 0), toolCalls: rows.reduce((sum, row) => sum + row.toolCalls, 0),
        tokens: rows.reduce((sum, row) => sum + row.tokens, 0) };
    });
  }

  decisionTrace(turn: TurnRecord) {
    const events = this.store.axe.list("decision_trace_events", turn.scope, turn.public.id);
    const evidence = this.store.axe.list("evidence_records", turn.scope, turn.public.id);
    return this.inspection?.payload(JSON.parse(JSON.stringify({ events, evidence })) as JsonValue).data;
  }

  get chat() {
    return this.sf.chat;
  }

  current(id: string): TurnRecord {
    const turn = this.store.turn(id);
    requireCheck(turn?.public.status === "working" && this.store.latestTurn(turn.scope.conversationId)?.public.id === id, "TURN_INACTIVE");
    const deadline = this.experiences.shouldHandle(turn) ? this.goalBudget.activeSeconds * 1000 : TURN_DEADLINE;
    requireCheck(turn.public.createdAt <= this.now() && turn.public.createdAt + deadline > this.now(), "TURN_EXPIRED");
    return turn;
  }

  private scopedRegistryTurn(ref: unknown, ctx: ToolHandlerContext, key: keyof typeof registryBoundaries) {
    ctx.signal.throwIfAborted();
    requireCheck(typeof ref === "string", "TURN_REF_REQUIRED");
    const turn = this.current(ref);
    const boundary = key === "retirementAccounts" && ctx.runId === turn.workflowScopeId ? "workflowScopeId" : registryBoundaries[key];
    requireCheck(turn[boundary] === ctx.runId && ctx.principal.tenantId === serverTenantId
      && turn.scope.principalId === ctx.principal.subjectId && !ctx.agentId, "REGISTRY_SCOPE_MISMATCH");
    const conversation = this.store.conversation(turn.scope.conversationId, turn.scope.principalId);
    requireCheck(conversation.personaId === turn.scope.personaId, "PERSONA_MISMATCH");
    const persona = findProfileById(conversation.personaId);
    requireCheck(persona && persona.allowedScenarios.includes(conversation.scenarioId), "PERSONA_MISMATCH");
    if (boundary === "workflowScopeId") {
      const definition = turn.workflow && workflowDefinition(turn.workflow.recommendation, turn.toolSetup?.fundingWorkflow);
      requireCheck(definition?.steps.some((ref) => ref === toolRefs[key]), "FUNDING_WORKFLOW_STEP_REQUIRED");
    }
    requireToolEnabled(turn, key);
    return { turn, conversation, persona };
  }

  private async scopedFundingTurn(ref: unknown, ctx: ToolHandlerContext, key: "fundingOptions" | "fundingStatus" | "fundingPreview") {
    const turn = await this.funding.scopedTurn(ref, ctx);
    if (!turn) return { ...this.scopedRegistryTurn(ref, ctx, key), agentGuided: false };
    requireToolEnabled(turn, key);
    const persona = findProfileById(turn.scope.personaId);
    requireCheck(persona, "PERSONA_MISMATCH");
    return { persona, agentGuided: true };
  }

  private treatmentAdapter(state: FixtureState, setup: ToolSetup | undefined, scope: Pick<Scope, "principalId" | "personaId">) {
    return new FixtureTsAdapter(
      state, setup?.treatmentOverrides, setup?.ccreRules, this.portfolioSnapshots, this.store.axe.fundingFact(scope),
    );
  }

  private turnTreatmentAdapter(turn: TurnRecord, conversation: ConversationRecord) {
    return this.treatmentAdapter({ scenarioId: conversation.scenarioId, ordinal: turn.ordinal }, turn.toolSetup, turn.scope);
  }

  async workspaceNextStep(principalId: string, personaId: string): Promise<WorkspaceNextStep | null> {
    const persona = findProfileById(personaId);
    if (!persona) return null;
    const setup = this.store.toolSetup("wealth");
    if (!setup.enabled.selection) return null;
    const adapter = this.treatmentAdapter({ scenarioId: host.defaultScenarioId, ordinal: 1 }, setup, { principalId, personaId });
    const result = await adapter.selectEligibleContent({ mid: persona.syntheticMid, context: nextStepContext }, AbortSignal.timeout(5000));
    const { content, workflow } = nextStepRecommendation(result.recommendations, setup, nextStepContext, result.renderedEntries);
    if (!content) return null;
    const reason = content.contentId === "fund_account" && this.effectiveFundingStatus(persona, principalId) === "unfunded"
      ? "This account is awaiting its first deposit" : undefined;
    return { title: content.title, body: content.body, reason, canPreviewFunding: Boolean(workflow) };
  }

  private async selectTreatment({ turnRef, routeDecisionId }: JsonObject, ctx: ToolHandlerContext) {
    const { turn, conversation, persona } = this.scopedRegistryTurn(turnRef, ctx, "selection");
    let context: string | undefined = routeDecisionId === turn.public.id ? workspaceFundingContext(turn.origin) : undefined;
    if (!context) {
      requireCheck(turn.route?.routeDecisionId === routeDecisionId && turn.route && turn.catalog && turn.attempts.route, "ROUTE_REQUIRED");
      verifyRoute(turn.route, turn.catalog, turn.scope, turn.attempts.route.runId, this.now());
      context = turn.route.contextId;
    }
    const accountId = turn.retirementAccounts?.selected?.id;
    const input = { mid: persona.syntheticMid, context, ...(accountId && { accountId }) };
    let ccre: MockCcreEvaluation | undefined;
    let formats: TurnRecord["treatmentFormats"];
    try {
      const result = await this.turnTreatmentAdapter(turn, conversation).selectEligibleContent(input, ctx.signal);
      if (turn.route && isPortfolioSummary(turn.route)) {
        requireCheck(this.store.update(turn.public.id, (row) => { row.portfolioForRule = result.portfolio ?? undefined; }), "TURN_INACTIVE");
      }
      if (result.renderedEntries) {
        requireCheck(this.store.update(turn.public.id, (row) => { row.treatmentEntries = result.renderedEntries; }), "TURN_INACTIVE");
      }
      ccre = result.ccre;
      formats = { legacy: result.contentIds, workflows: result.recommendations, matches: result.workflowMatches, actionMatches: result.actionMatches };
      return result;
    } finally {
      if (this.inspection) {
        try {
          this.store.update(turn.public.id, (row) => {
            row.treatmentMockInput = input;
            row.treatmentCcre = ccre;
            row.treatmentFormats = formats;
          });
        } catch { /* Diagnostic storage cannot change the tool result. */ }
      }
    }
  }

  private effectiveFundingStatus(persona: Pick<PersonaRecord, "personaId" | "accountFundingStatus">, principalId: string) {
    return this.store.axe.fundingStatus({ principalId, personaId: persona.personaId }) ?? persona.accountFundingStatus;
  }

  private buildArbitrator(turn?: TurnRecord, conversation?: ConversationRecord): RecommendationArbitrator {
    const providers: RecommendationProvider[] = [
      createTreatmentSelectorProvider((mid, contextId, signal) => {
        const adapter = turn && conversation
          ? this.turnTreatmentAdapter(turn, conversation)
          : this.treatmentAdapter({ scenarioId: host.defaultScenarioId, ordinal: 1 }, undefined, { principalId: "preview", personaId: "demo-learner" });
        return adapter.selectEligibleContent({ mid, context: contextId }, signal);
      }),
    ];
    if (this.customer360) {
      providers.push(createCustomer360NbaProvider((input) => this.customer360!.evaluate(input)));
    }
    if (this.opsStore) {
      providers.push(createOpsRunbookProvider(() => this.opsStore!.list()));
    }
    if (this.salesStore) {
      providers.push(createSalesDealDeskProvider(() => this.salesStore!.list()));
    }
    if (this.connectorStore) {
      providers.push(...this.connectorStore.buildRecommendationProviders());
    }
    return new RecommendationArbitrator(providers);
  }

  recommendationProviderDescriptors(): RecommendationProviderDescriptor[] {
    return this.buildArbitrator().descriptors();
  }

  async arbitrateRecommendations(
    turn: TurnRecord,
    input: { contextId: string; domain?: RecommendationDomain; existingBlockTitles?: string[] },
    signal: AbortSignal,
  ): Promise<RecommendationArbitrateResult> {
    const result = await this.registry(turn, "tsScopeId", 1, signal, (execute) => execute("arbitrateRecommendations", {
      turnRef: turn.public.id,
      contextId: input.contextId,
      domain: input.domain ?? "wealth",
      ...(input.existingBlockTitles ? { existingBlockTitles: input.existingBlockTitles } : {}),
    }));
    return recommendationArbitrateResultSchema.parse(result.output);
  }

  async executeGovernedWrite(
    principalId: string,
    input: {
      domain: "ops_incident" | "sales_deal" | "customer360";
      recordId: string;
      action: string;
      actor: string;
      note?: string;
      updates?: Record<string, string>;
      approvalId?: string;
    },
    signal: AbortSignal,
  ): Promise<{ summary: string; sfieldRunId: string; audit?: DomainWriteAuditEntry; updatedFields?: string[] }> {
    const scope = await this.sf.executions.open({
      principal: principalFor(principalId),
      purpose: "cep-governed-write",
      preset: "bounded_auto",
      budget: { maxToolCalls: 1 },
    });
    try {
      const exec = await scope.registry.execute(
        domainWriteToolRef,
        {
          domain: input.domain,
          recordId: input.recordId,
          action: input.action,
          actor: input.actor,
          ...(input.note ? { note: input.note } : {}),
          ...(input.updates ? { updatesJson: JSON.stringify(input.updates) } : {}),
        },
        { signal },
      );
      if (exec.status !== "succeeded" || !exec.output || typeof exec.output !== "object") {
        const reason = exec.error?.message ?? "Governed write denied by sfield policy.";
        this.writeAudit?.record({
          sfieldRunId: scope.id,
          sfieldToolRef: domainWriteToolRef,
          domain: input.domain,
          recordId: input.recordId,
          action: input.action,
          actor: input.actor,
          summary: reason,
          status: "denied",
          ...(input.approvalId ? { approvalId: input.approvalId } : {}),
        });
        throw new Error(reason);
      }
      const out = exec.output as { summary?: string; updatedFields?: string[] };
      const rejected = input.domain === "customer360" && !out.updatedFields?.length;
      const summary = rejected ? "No profile fields were saved." : out.summary ?? `${input.action} applied to ${input.recordId}`;
      const audit = this.writeAudit?.record({
        sfieldRunId: scope.id,
        sfieldToolRef: domainWriteToolRef,
        domain: input.domain,
        recordId: input.recordId,
        action: input.action,
        actor: input.actor,
        summary,
        status: rejected ? "denied" : "succeeded",
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      });
      if (rejected) throw new ApiError(422, "fields_not_saved", "Check the fields and values, then save again.");
      return { summary, sfieldRunId: scope.id, audit, updatedFields: out.updatedFields };
    } finally {
      await scope.close();
    }
  }

  async executeConnectorInvoke(
    principalId: string,
    input: {
      connectorId: string;
      action: string;
      actor: string;
      payload?: Record<string, unknown>;
      approvalId?: string;
    },
    signal: AbortSignal,
  ): Promise<{
    ok: boolean;
    connectorId: string;
    connectorName: string;
    statusCode: number;
    elapsedMs: number;
    summary: string;
    responsePreview: string;
    sandbox: boolean;
    sfieldRunId: string;
    audit?: DomainWriteAuditEntry;
  }> {
    const scope = await this.sf.executions.open({
      principal: principalFor(principalId),
      purpose: "cep-connector-invoke",
      preset: "bounded_auto",
      budget: { maxToolCalls: 1 },
    });
    try {
      const exec = await scope.registry.execute(
        connectorInvokeToolRef,
        {
          connectorId: input.connectorId,
          action: input.action,
          actor: input.actor,
          ...(input.payload ? { payloadJson: JSON.stringify(input.payload) } : {}),
        },
        { signal },
      );
      if (exec.status !== "succeeded" || !exec.output || typeof exec.output !== "object") {
        const reason = exec.error?.message ?? "External connector invocation denied by sfield policy.";
        this.writeAudit?.record({
          sfieldRunId: scope.id,
          sfieldToolRef: connectorInvokeToolRef,
          domain: "external_connector",
          recordId: input.connectorId,
          action: input.action,
          actor: input.actor,
          summary: reason,
          status: "denied",
          ...(input.approvalId ? { approvalId: input.approvalId } : {}),
        });
        throw new Error(reason);
      }
      const out = exec.output as {
        ok: boolean;
        connectorId: string;
        connectorName: string;
        statusCode: number;
        elapsedMs: number;
        summary: string;
        responsePreview: string;
        sandbox: boolean;
      };
      const audit = this.writeAudit?.record({
        sfieldRunId: scope.id,
        sfieldToolRef: connectorInvokeToolRef,
        domain: "external_connector",
        recordId: out.connectorId,
        action: input.action,
        actor: input.actor,
        summary: out.summary,
        status: "succeeded",
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      });
      return { ...out, sfieldRunId: scope.id, audit };
    } finally {
      await scope.close();
    }
  }

  async executePznTool<T = unknown>(
    principalId: string,
    toolRef: string,
    operation: string,
    payload?: unknown,
    signal: AbortSignal = AbortSignal.timeout(10_000),
  ): Promise<{ data: T; summary: string; sfieldRunId: string; sfieldToolRef: string }> {
    const isReadOnly = toolRef === pznSfieldToolRefs.treatmentSelector;
    const scope = await this.sf.executions.open({
      principal: principalFor(principalId),
      purpose: `cep-pzn:${operation}`,
      preset: isReadOnly ? "read_only" : "bounded_auto",
      budget: { maxToolCalls: 1 },
    });
    try {
      const exec = await scope.registry.execute(
        toolRef,
        {
          operation,
          ...(payload !== undefined ? { payloadJson: JSON.stringify(payload) } : {}),
        },
        { signal },
      );
      if (exec.status !== "succeeded" || !exec.output || typeof exec.output !== "object") {
        const reason = exec.error?.message ?? `sfield tool ${toolRef} (${operation}) failed.`;
        throw new Error(reason);
      }
      const out = exec.output as { ok: boolean; operation: string; summary: string; resultJson: string };
      const data = JSON.parse(out.resultJson) as T;
      if (!isReadOnly && operation !== "get_dictionary" && operation !== "get_workspace" && !operation.startsWith("list_") && operation !== "test_rule") {
        const approvalId = payload && typeof payload === "object" && typeof (payload as { approvalId?: unknown }).approvalId === "string"
          ? (payload as { approvalId: string }).approvalId
          : undefined;
        this.writeAudit?.record({
          sfieldRunId: scope.id,
          sfieldToolRef: toolRef,
          domain: "pzn_self_service",
          recordId: operation,
          action: operation,
          actor: principalId,
          summary: out.summary,
          status: "succeeded",
          ...(approvalId ? { approvalId } : {}),
        });
      }
      return { data, summary: out.summary, sfieldRunId: scope.id, sfieldToolRef: toolRef };
    } finally {
      await scope.close();
    }
  }

  /* ---------------- Integration tasks: dedicated tool per task version + dispatcher tools ---------------- */

  private readonly integrationExecutor: TaskCallExecutor;
  private readonly piiRunTokens = new Map<string, Map<string, string>>();

  private rememberRunPiiTokens(runId: string, tokenMap: Map<string, string>) {
    if (tokenMap.size === 0) return;
    const existing = this.piiRunTokens.get(runId) ?? new Map<string, string>();
    for (const [k, v] of tokenMap.entries()) existing.set(k, v);
    this.piiRunTokens.set(runId, existing);
    if (this.piiRunTokens.size > 100) {
      const oldest = this.piiRunTokens.keys().next().value;
      if (oldest) this.piiRunTokens.delete(oldest);
    }
  }

  private rehydrateRunResult(res: RunResult): RunResult {
    const tokenMap = this.piiRunTokens.get(res.runId);
    if (!tokenMap) return res;
    this.piiRunTokens.delete(res.runId);
    if (res.output === undefined) return res;
    return { ...res, output: rehydrateObjectStrings(res.output, tokenMap) };
  }
  private readonly registeredIntegrationRefs = new Set<string>();
  private readonly pendingIntegrationCalls = new Map<string, {
    scope: ExecutionScope; callId: string; sfieldToolRef: string; toolInputs: JsonObject; timer: NodeJS.Timeout;
  }>();

  registeredIntegrationTools(): ReadonlySet<string> {
    return this.registeredIntegrationRefs;
  }

  /** Dispatcher tools exist from startup, so a task version published later runs without a restart. */
  dispatcherRef(effect: "read" | "write" | "destructive"): string {
    return `int.dispatch.${effect}@1.0.0`;
  }

  /**
   * One governed call. Approval is enforced here, inside the sfield tool, against our approval record
   * (status "executing" = approved and claimed once; exact task version, binding and input). sfield's own
   * digest-bound approval is layered on top whenever the original call is still open.
   */
  private async runTaskCall(contract: TaskContract, input: Record<string, unknown>, approvalId: string | undefined, signal: AbortSignal) {
    const store = this.integrationTasks!;
    const integration = store.integration(contract.integrationId);
    if (!integration?.enabled) {
      throw new ToolError("TASK_TRANSPORT", JSON.stringify({ error: { kind: "transport", retryable: false, message: `Integration "${contract.integrationId}" is unavailable.` } }), { effect: "none" });
    }
    if (needsApproval(contract, input)) {
      const record = approvalId ? this.approvalStore?.findById(approvalId) : undefined;
      const payload = (record?.payload ?? {}) as { taskRef?: string; contractDigest?: string; bindingDigest?: string; input?: unknown };
      const ok = record && record.targetKind === "integration_task" && record.status === "executing"
        && payload.taskRef === contract.ref && payload.contractDigest === contract.contractDigest
        && payload.bindingDigest === contract.bindingDigest && canonicalJson(payload.input ?? {}) === canonicalJson(input);
      if (!ok) {
        throw new ToolError("TASK_POLICY_DENIED", JSON.stringify({ error: {
          kind: "policy_denied", retryable: false,
          message: approvalId
            ? `Approval ${approvalId} does not authorize this exact call (it must be approved, claimed once, and match the task version, binding and input).`
            : `${contract.ref} requires an approved change request for this input.`,
        } }), { effect: "none" });
      }
    }
    const res = await this.integrationExecutor.execute(integration, contract, input, signal);
    if (res.state === "failed") {
      throw new ToolError(`TASK_${(res.error?.kind ?? "unknown").toUpperCase()}`, JSON.stringify({ outcome: res.outcome, error: res.error }), { effect: "none", retryable: res.error?.retryable ?? false });
    }
    if (res.state === "outcome_unknown") {
      throw new ToolError("TASK_OUTCOME_UNKNOWN", JSON.stringify({ error: res.error }), { effect: "unknown" });
    }
    return {
      state: res.state,
      outcomeCode: res.outcome?.code ?? "UNMAPPED",
      success: res.outcome?.success ?? true,
      retryable: res.outcome?.retryable ?? false,
      message: (res.error?.message ?? res.outcome?.meaning ?? "ok").slice(0, 400),
      outputJson: JSON.stringify(res.output ?? null).slice(0, 40_000),
      ...(res.artifact ? { artifactJson: JSON.stringify(res.artifact).slice(0, 40_000) } : {}),
    };
  }

  private integrationTools() {
    const store = this.integrationTasks;
    if (!store) return [];

    // 1. Dedicated tools for versions published before startup: per-task schema, policy, and lock digest.
    const dedicated = store.published().flatMap((contract) => {
      const tool = this.dedicatedTool(contract);
      if (!tool) return [];
      this.registeredIntegrationRefs.add(contract.ref);
      return [tool];
    });
    return [...dedicated, ...this.dispatcherTools()];
  }

  private integrationPolicy(action: string, effect: "read" | "write" | "destructive", timeoutMs: number) {
    return {
      action, effect,
      // Approval is decided per call (scope preset) and also enforced in the handler; see runTaskCall.
      requiresApproval: false, maxAttempts: 1, retrySafety: "never" as const, timeoutMs,
      classification: "public" as const, maxOutputBytes: 48_000,
    };
  }

  /** One sfield tool per published task version: its own input schema, policy, and lock-manifest digest. */
  private dedicatedTool(contract: TaskContract) {
    const store = this.integrationTasks!;
    const integration = store.integration(contract.integrationId);
    if (!integration) return null;
    const policyFor = this.integrationPolicy.bind(this);
    const id = taskToolId(contract.integrationId, contract.taskId);
    return defineTool({
        id,
        version: contract.version,
        description: contract.description,
        inputs: {
          type: "object", additionalProperties: false, required: ["input"],
          properties: { input: contract.inputSchema, approvalId: { type: "string", maxLength: 64 } },
        } as unknown as JsonObject,
        outputs: taskEnvelopeJsonSchema as unknown as JsonObject,
        ...(contract.effect !== "read" ? {
          resource: contract.resourceIdField
            ? { type: `${contract.integrationId}_record`, id: { ref: `inputs.input.${contract.resourceIdField}` } }
            : { type: `${contract.integrationId}_record`, id: { literal: contract.taskId } },
        } : {}),
        policy: policyFor(id, contract.effect, integration.timeoutMs + 1_000),
        handler: async (raw, ctx) => {
          const { input, approvalId } = raw as { input: Record<string, unknown>; approvalId?: string };
          const current = store.contract(contract.ref);
          if (!current || current.contractDigest !== contract.contractDigest || current.bindingDigest !== contract.bindingDigest) {
            throw new ToolError("TASK_DEFINITION_CHANGED", JSON.stringify({ error: { kind: "policy_denied", retryable: false, message: `${contract.ref} changed since it was registered.` } }), { effect: "none" });
          }
          return this.runTaskCall(current, input, approvalId, ctx.signal);
        },
      });
  }

  /**
   * Registers a version published after startup as its own dedicated sfield tool, through sfield.reload: the
   * candidate lock manifest (with the new tool) must pass lock governance before the tool exists. If it cannot be
   * registered, the version still runs through the effect's dispatcher tool.
   */
  async registerPublishedTask(contract: TaskContract): Promise<{ route: "dedicated" | "dispatcher"; reason?: string }> {
    if (this.registeredIntegrationRefs.has(contract.ref)) return { route: "dedicated" };
    const tool = this.dedicatedTool(contract);
    if (!tool) return { route: "dispatcher", reason: "integration not found" };
    try {
      const out = await this.sf.reload({ tools: [tool as unknown as DefineToolInput] });
      if (out.added.includes(contract.ref) || this.sf.registry.list().some((d) => d.ref === contract.ref)) {
        this.registeredIntegrationRefs.add(contract.ref);
        return { route: "dedicated" };
      }
      return { route: "dispatcher", reason: "sfield did not add the tool" };
    } catch (err) {
      return { route: "dispatcher", reason: `${(err as { code?: string }).code ?? "RELOAD_FAILED"}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
    }
  }

  private dispatcherTools() {
    const store = this.integrationTasks!;
    const policyFor = this.integrationPolicy.bind(this);
    // 2. Dispatchers (one per effect) for versions published after startup. Both digests are inputs, so the
    //    prepared-invocation digest (and therefore any sfield approval) is bound to the exact contract and binding.
    const dispatchers = (["read", "write", "destructive"] as const).map((effect) => defineTool({
      id: `int.dispatch.${effect}`,
      version: "1.0.0",
      description: `Runs a published ${effect} integration task by reference, validated against its stored contract.`,
      inputs: {
        type: "object", additionalProperties: false, required: ["taskRef", "contractDigest", "bindingDigest", "inputJson"],
        properties: {
          taskRef: { type: "string", minLength: 3, maxLength: 120 },
          contractDigest: { type: "string", minLength: 8, maxLength: 100 },
          bindingDigest: { type: "string", minLength: 8, maxLength: 100 },
          inputJson: { type: "string", maxLength: 32_000 },
          approvalId: { type: "string", maxLength: 64 },
        },
      } as unknown as JsonObject,
      outputs: taskEnvelopeJsonSchema as unknown as JsonObject,
      ...(effect !== "read" ? { resource: { type: "integration_task", id: { ref: "inputs.taskRef" } } } : {}),
      policy: policyFor(`int.dispatch.${effect}`, effect, 31_000),
      handler: async (raw, ctx) => {
        const { taskRef, contractDigest, bindingDigest, inputJson, approvalId } = raw as {
          taskRef: string; contractDigest: string; bindingDigest: string; inputJson: string; approvalId?: string;
        };
        const deny = (message: string) => new ToolError("TASK_POLICY_DENIED", JSON.stringify({ error: { kind: "policy_denied", retryable: false, message } }), { effect: "none" });
        const contract = store.contract(taskRef);
        if (!contract || contract.status !== "published") throw deny(`${taskRef} is not a published task.`);
        if (contract.effect !== effect) throw deny(`${taskRef} is a ${contract.effect} task, not ${effect}.`);
        if (contract.contractDigest !== contractDigest || contract.bindingDigest !== bindingDigest) throw deny(`${taskRef} changed since this call was prepared.`);
        let input: Record<string, unknown>;
        try { input = JSON.parse(inputJson) as Record<string, unknown>; } catch { throw deny("inputJson is not valid JSON."); }
        const valid = sharedValidator().validate(contract.inputSchema as JsonObject, input);
        if (!valid.ok) {
          throw new ToolError("TASK_VALIDATION_INPUT", JSON.stringify({ error: {
            kind: "validation_input", retryable: false,
            message: `Input does not match ${taskRef}: ${valid.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join("; ")}`,
          } }), { effect: "none" });
        }
        return this.runTaskCall(contract, input, approvalId, ctx.signal);
      },
    }));
    return dispatchers;
  }

  /**
   * Runs a task tool in a host execution scope. Gated calls use the "supervised" preset, so sfield itself also
   * requires an approval bound to the prepared invocation digest before dispatch.
   */
  async executeIntegrationTask(principalId: string, sfieldToolRef: string, toolInputs: JsonObject, gated: boolean) {
    const scope = await this.sf.executions.open({
      principal: principalFor(principalId),
      purpose: `cep-int:${sfieldToolRef}`,
      preset: gated ? "supervised" : "bounded_auto",
      budget: { maxToolCalls: 2 },
    });
    try {
      const result = await scope.registry.execute(sfieldToolRef, toolInputs, { signal: AbortSignal.timeout(35_000) });
      await scope.close();
      return { kind: "result" as const, result, sfieldRunId: scope.id };
    } catch (err) {
      const details = err instanceof SFieldError ? (err.details as { approvalId?: string; callId?: string } | undefined) : undefined;
      if (err instanceof SFieldError && err.code === "APPROVAL_REQUIRED" && details?.approvalId && details.callId) {
        // Keep the scope open while it waits: sfield binds its approval to this run and call. If the server
        // restarts, the approved call falls back to a fresh scope (enforced by runTaskCall).
        const approvalId = details.approvalId;
        const timer = setTimeout(() => {
          const pending = this.pendingIntegrationCalls.get(approvalId);
          this.pendingIntegrationCalls.delete(approvalId);
          void pending?.scope.close().catch(() => undefined);
        }, 24 * 60 * 60 * 1000);
        timer.unref();
        this.pendingIntegrationCalls.set(approvalId, { scope, callId: details.callId, sfieldToolRef, toolInputs, timer });
        return { kind: "pending" as const, sfieldApprovalId: approvalId, callId: details.callId, sfieldRunId: scope.id };
      }
      await scope.close().catch(() => undefined);
      throw err;
    }
  }

  /** sfield's own approval records for one run (audit / tests). */
  sfieldApprovals(runId: string) {
    return this.sf.approvals.list({ runId });
  }

  hasPendingIntegrationCall(sfieldApprovalId: string): boolean {
    return this.pendingIntegrationCalls.has(sfieldApprovalId);
  }

  /**
   * Decides sfield's own digest-bound approval and continues the exact waiting call (same run, call id, prepared
   * digest). If the server restarted, the original execution scope is resumed by id (sfield executions.resume), so
   * the approval the human decided is the one sfield checks: nothing is re-requested or re-granted.
   */
  async resumeIntegrationTask(
    call: { sfieldApprovalId: string; sfieldRunId: string; callId: string; sfieldToolRef: string; toolInputs: JsonObject },
    approver: string, decision: "approve" | "deny", principalId: string,
  ) {
    const pending = this.pendingIntegrationCalls.get(call.sfieldApprovalId);
    let scope: ExecutionScope;
    let resumed = false;
    if (pending) {
      this.pendingIntegrationCalls.delete(call.sfieldApprovalId);
      clearTimeout(pending.timer);
      scope = pending.scope;
    } else {
      scope = await this.sf.executions.resume({ runId: call.sfieldRunId, principal: principalFor(principalId), preset: "supervised", budget: { maxToolCalls: 2 } });
      resumed = true;
    }
    try {
      await this.sf.approvals.decide({
        approvalId: call.sfieldApprovalId, actor: { tenantId: serverTenantId, subjectId: approver.slice(0, 80) }, decision,
        ...(decision === "deny" ? { comment: "denied in CEP" } : {}),
      });
      if (decision === "deny") return { kind: "denied" as const, resumed };
      const result = await scope.registry.execute(call.sfieldToolRef, call.toolInputs, { callId: call.callId, signal: AbortSignal.timeout(35_000) });
      return { kind: "result" as const, result, sfieldRunId: scope.id, resumed };
    } finally {
      await scope.close().catch(() => undefined);
    }
  }

  /** Parses a PZN tool payload and enforces the configurable approval policy inside the sfield tool boundary. */
  private pznVerifiedPayload(operation: string, payloadJson?: string): Record<string, unknown> {
    let raw: Record<string, unknown> = {};
    if (payloadJson) {
      try {
        raw = JSON.parse(payloadJson) as Record<string, unknown>;
      } catch {
        throw new ToolError("INVALID_PAYLOAD", "payloadJson is not valid JSON.");
      }
    }
    if (!this.approvalStore || !this.selfServicePzn) return splitApprovalId(raw).args;
    try {
      return verifyPznApproval(this.approvalStore, this.selfServicePzn, operation, raw);
    } catch (err) {
      if (err instanceof PznApprovalError) throw new ToolError(err.code, err.message);
      throw err;
    }
  }

  private tools() {
    const read = (key: ToolKey, definition: Omit<DefineToolInput, "id" | "description" | "version" | "policy">, version: string = toolVersion) => {
      const { id, description } = sfieldTools[key];
      return defineTool({
        ...definition, id, description, version,
        policy: {
          action: id, effect: "read", requiresApproval: false, maxAttempts: 1, timeoutMs: 5_000,
          classification: "public", maxOutputBytes: 48_000,
        },
      });
    };
    return [
      read("catalog", {
        inputs: turnInputSchema, outputs: contextResultSchema,
        handler: ({ turnRef }, ctx) => {
          const { turn, conversation } = this.scopedRegistryTurn(turnRef, ctx, "catalog");
          return this.turnTreatmentAdapter(turn, conversation).listContexts(ctx.signal);
        },
      }),
      read("propensity", {
        inputs: propensityInputSchema, outputs: propensityResultSchema,
        handler: ({ turnRef, catalogSnapshotId }, ctx) => {
          const { turn, conversation, persona } = this.scopedRegistryTurn(turnRef, ctx, "propensity");
          requireCheck(turn.catalog?.snapshotId === catalogSnapshotId && turn.catalog, "CATALOG_MISMATCH");
          checkFresh(turn.catalog, turn.scope, this.now());
          const input: ContextScoresRequest = {
            mid: persona.syntheticMid,
            contextIds: turn.catalog.catalog.contexts.map(({ contextId }) => contextId),
          };
          if (this.inspection) {
            try {
              this.store.update(turn.public.id, (row) => { row.treatmentScores = { scopeId: ctx.runId, input }; });
            } catch { /* Diagnostic storage cannot change the tool result. */ }
          }
          return this.turnTreatmentAdapter(turn, conversation).getContextScores(input, ctx.signal);
        },
      }),
      read("selection", {
        inputs: treatmentInputSchema, outputs: treatmentResultSchema,
        handler: async (input, ctx) => (await this.selectTreatment(input, ctx)).contentIds,
      }),
      read("selection", {
        inputs: treatmentInputSchema, outputs: treatmentRecommendationsResultSchema,
        handler: async (input, ctx) => (await this.selectTreatment(input, ctx)).recommendations,
      }, treatmentRecommendationsVersion),
      read("selection", {
        inputs: treatmentInputSchema, outputs: treatmentDecisionResultSchema,
        handler: async (input, ctx) => (await this.selectTreatment(input, ctx)).decision,
      }, treatmentDecisionVersion),
      read("fundingOptions", {
        inputs: fundingReadInputSchema, outputs: fundingOptionsResultSchema,
        handler: async ({ turnRef }, ctx) => {
          const scoped = await this.scopedFundingTurn(turnRef, ctx, "fundingOptions");
          requireCheck(this.effectiveFundingStatus(scoped.persona, ctx.principal.subjectId) === "unfunded", "ACCOUNT_ALREADY_FUNDED");
          return availableFundingOptions(scoped.agentGuided);
        },
      }, fundingToolVersion),
      read("fundingStatus", {
        inputs: fundingReadInputSchema, outputs: fundingStatusResultSchema,
        handler: async ({ turnRef }, ctx) => {
          const { persona } = await this.scopedFundingTurn(turnRef, ctx, "fundingStatus");
          return { accountFundingStatus: this.effectiveFundingStatus(persona, ctx.principal.subjectId) };
        },
      }, fundingToolVersion),
      read("fundingPreview", {
        inputs: fundingPreviewInputSchema, outputs: fundingPreviewResultSchema,
        handler: async ({ turnRef, methodId }, ctx) => {
          const { persona } = await this.scopedFundingTurn(turnRef, ctx, "fundingPreview");
          requireCheck(this.effectiveFundingStatus(persona, ctx.principal.subjectId) === "unfunded", "ACCOUNT_ALREADY_FUNDED");
          const read = (await this.sf.persistence.listCalls(ctx.runId)).find((call) => (
            call.toolRef === toolRefs.fundingOptions && call.invocation?.normalizedInputs.turnRef === turnRef && call.result?.status === "succeeded"
          ));
          requireCheck(read, "FUNDING_OPTIONS_REQUIRED");
          const options = fundingOptionsSchema.parse(read.result?.output);
          const method = options.methods.find((item) => item.methodId === methodId);
          requireCheck(method, "FUNDING_METHOD_NOT_AVAILABLE");
          ctx.signal.throwIfAborted();
          return fundingPreviewFrom(options, method.methodId, options.amountCents);
        },
      }, fundingToolVersion),
      read("retirementAccounts", {
        inputs: portfolioInputSchema, outputs: retirementAccountsResultSchema,
        handler: async ({ turnRef, routeDecisionId }, ctx) => {
          const { turn, persona } = this.scopedRegistryTurn(turnRef, ctx, "retirementAccounts");
          if (ctx.runId === turn.workflowScopeId && turn.workflow) {
            const { source } = workflowOfferSource(this.store, turn, turn.workflow, this.now());
            requireCheck(turn.workflow.recommendation.id === beneficiaryReviewWorkflow.recommendation.id
              && source.route?.routeDecisionId === routeDecisionId, "WORKFLOW_SOURCE_REQUIRED");
            return readRetirementView(persona.syntheticMid, retirementBeneficiaryIntent, source.retirementAccounts?.selected?.id ?? "");
          }
          requireCheck(turn.route && turn.catalog && turn.route.routeDecisionId === routeDecisionId && turn.route.contextId === "learning"
            && [retirementListIntent, retirementBeneficiaryIntent, "beneficiary_update_steps"].includes(turn.trace.intentId ?? ""), "RETIREMENT_ROUTE_REQUIRED");
          verifyRoute(turn.route, turn.catalog, turn.scope, turn.attempts.route?.runId ?? null, this.now());
          const prior = this.store.previousCompletedTurn(turn.scope.conversationId, turn.ordinal);
          const displayed = prior?.public.experience?.blocks.find((block) => block.component === "PznRetirementAccounts");
          return readRetirementView(persona.syntheticMid, turn.trace.intentId!, turn.public.message, displayed?.props);
        },
      }),
      read("portfolio", {
        inputs: portfolioInputSchema, outputs: portfolioResultSchema,
        handler: async ({ turnRef, routeDecisionId }, ctx) => {
          const { turn, persona } = this.scopedRegistryTurn(turnRef, ctx, "portfolio");
          requireCheck(turn.route && turn.route.routeDecisionId === routeDecisionId && turn.catalog && turn.attempts.route
            && turn.decision?.routeDecisionId === routeDecisionId && isPortfolioSummary(turn.route), "PORTFOLIO_ROUTE_REQUIRED");
          verifyRoute(turn.route, turn.catalog, turn.scope, turn.attempts.route.runId, this.now());
          const snapshot = turn.portfolioForRule ?? await this.portfolioSnapshots.read(persona.syntheticMid, ctx.signal);
          if (!snapshot) throw new ToolError("PORTFOLIO_SNAPSHOT_UNAVAILABLE");
          ctx.signal.throwIfAborted();
          return snapshot;
        },
      }),
      read("goal", {
        inputs: goalProgressInputSchema, outputs: goalProgressResultSchema,
        handler: async ({ turnRef, routeDecisionId }, ctx) => {
          const { turn, persona } = this.scopedRegistryTurn(turnRef, ctx, "goal");
          requireCheck(turn.route && turn.route.routeDecisionId === routeDecisionId && turn.catalog && turn.attempts.route
            && turn.decision && turn.decision.routeDecisionId === routeDecisionId && isHomeGoalSummary(turn.route), "GOAL_ROUTE_REQUIRED");
          const now = this.now();
          verifyRoute(turn.route, turn.catalog, turn.scope, turn.attempts.route.runId, now);
          checkFresh(turn.decision, turn.scope, now);
          requireCheck(turn.decision.candidates.some((candidate) => lookupContent(candidate)?.allowedComponents.includes("PznGoalProgress")),
            "GOAL_NOT_ELIGIBLE");
          const reading = await this.goalProgressProvider.read(persona.syntheticMid, ctx.signal);
          ctx.signal.throwIfAborted();
          const progress = goalProgressSchema.safeParse(reading);
          if (!progress.success) throw new ToolError("GOAL_PROGRESS_UNAVAILABLE");
          return progress.data;
        },
      }),
      read("glossary", {
        inputs: glossaryInputSchema, outputs: glossaryResultSchema,
        handler: ({ turnRef, routerRunId }, ctx) => {
          const { turn } = this.scopedRegistryTurn(turnRef, ctx, "glossary");
          requireCheck(this.inspection && turn.trace.routeOutcome === "create_rule" && turn.attempts.route?.runId === routerRunId, "RULE_INTENT_REQUIRED");
          return mockRuleGlossary;
        },
      }),
      read("balances", {
        inputs: balanceInputSchema, outputs: balanceResultSchema,
        handler: async (_inputs, ctx) => {
          ctx.signal.throwIfAborted();
          const turn = await this.stageTurn(ctx.runId, ctx.principal, "compose");
          requireToolEnabled(turn, "balances");
          requireCheck(turn.decision && turn.route && turn.catalog && turn.attempts.route, "ROUTE_REQUIRED");
          verifyRoute(turn.route, turn.catalog, turn.scope, turn.attempts.route.runId, this.now());
          checkFresh(turn.decision, turn.scope, this.now());
          requireCheck(turn.trace.intentId === "show_balance" && turn.decision.routeDecisionId === turn.route.routeDecisionId && turn.decision.contextId === "balance"
            && turn.decision.candidates.some((candidate) => lookupContent(candidate)?.metricSpec?.toolId === sfieldTools.balances.id), "METRIC_NOT_ELIGIBLE");
          const persona = findProfileById(turn.scope.personaId);
          if (!persona) throw new ToolError("DEMO_BALANCE_UNAVAILABLE");
          ctx.signal.throwIfAborted();
          return readDemoBalance(persona.personaId, persona.syntheticMid, this.now());
        },
      }),
      defineTool({
        id: recommendationArbitrateToolId,
        version: recommendationArbitrateToolVersion,
        description: "Host-governed recommendation arbitrator that fans out across pluggable RecommendationProvider adapters (Treatment Selector + CCRE, Customer 360 NBA, IT Ops Runbooks) behind one normalized sfield boundary.",
        inputs: recommendationArbitrateInputJsonSchema,
        outputs: recommendationArbitrateResultJsonSchema,
        policy: {
          action: recommendationArbitrateToolId,
          effect: "read",
          requiresApproval: false,
          maxAttempts: 1,
          timeoutMs: 5_000,
          classification: "public",
          maxOutputBytes: 48_000,
        },
        handler: async (raw, ctx) => {
          const parsed = recommendationArbitrateInputSchema.parse(raw);
          const { turn, conversation, persona } = this.scopedRegistryTurn(parsed.turnRef, ctx, "selection");
          const funding = this.effectiveFundingStatus(persona, turn.scope.principalId) === "funded" ? "funded" : "unfunded";
          return this.buildArbitrator(turn, conversation).arbitrate({
            principalId: turn.scope.principalId,
            personaId: turn.scope.personaId,
            syntheticMid: persona.syntheticMid,
            contextId: parsed.contextId,
            domain: parsed.domain,
            fundingStatus: funding,
            excludePromotions: false,
            existingBlockTitles: parsed.existingBlockTitles,
          }, ctx.signal);
        },
      }),
      defineTool({
        id: domainWriteToolId,
        version: domainWriteToolVersion,
        description: "Host-governed domain write-back tool for operator-confirmed mutations across IT Incidents, Sales Deals, and Customer 360 bindings.",
        resource: { type: "domain_record", id: { ref: "inputs.recordId" } },
        inputs: domainWriteInputJsonSchema,
        outputs: domainWriteResultJsonSchema,
        policy: {
          action: domainWriteToolId,
          effect: "write",
          requiresApproval: false,
          maxAttempts: 1,
          timeoutMs: 5_000,
          classification: "public",
          maxOutputBytes: 16_000,
        },
        handler: async (raw): Promise<JsonObject> => {
          const inp = raw as {
            domain: "ops_incident" | "sales_deal" | "customer360";
            recordId: string;
            action: string;
            actor: string;
            note?: string;
            updatesJson?: string;
          };
          if (inp.domain === "ops_incident") {
            if (!this.opsStore) throw new ToolError("OPS_STORE_UNAVAILABLE");
            const decision = inp.action as "approve_rollback" | "reject_rollback" | "resolve" | "escalate";
            const updated = this.opsStore.decide(inp.recordId, { decision, actor: inp.actor, ...(inp.note ? { note: inp.note } : {}) });
            if (!updated) throw new ToolError("INCIDENT_NOT_FOUND");
            return {
              ok: true,
              recordId: updated.id,
              summary: `${updated.id} → ${updated.status} (error rate ${updated.errorRatePct}%, p95 ${updated.p95LatencyMs}ms)`,
            };
          }
          if (inp.domain === "sales_deal") {
            if (!this.salesStore) throw new ToolError("SALES_STORE_UNAVAILABLE");
            const decision = inp.action as "approve_discount" | "reject_discount" | "advance_stage";
            const updated = this.salesStore.decide(inp.recordId, { decision, actor: inp.actor, ...(inp.note ? { note: inp.note } : {}) });
            if (!updated) throw new ToolError("DEAL_NOT_FOUND");
            return {
              ok: true,
              recordId: updated.id,
              summary: `${updated.id} (${updated.accountName}) → ${updated.stage} (${updated.discountStatus}, ${updated.winProbabilityPct}% prob.)`,
            };
          }
          if (!this.profileStore) throw new ToolError("CUSTOMER_STORE_UNAVAILABLE");
          const updates = inp.updatesJson ? JSON.parse(inp.updatesJson) as Record<string, string> : {};
          const applied = this.profileStore.applyBindings(inp.recordId, updates, this.now());
          return {
            ok: applied.updatedFields.length > 0,
            recordId: inp.recordId,
            updatedFields: applied.updatedFields,
            summary: `Updated Customer 360 bindings: ${applied.updatedFields.join(", ") || "none"}`,
          };
        },
      }),
      defineTool({
        id: connectorInvokeToolId,
        version: connectorInvokeToolVersion,
        description: "Execute an enabled external REST or MCP connector action under sfield host governance, timeout controls, and write audit logging.",
        inputs: connectorInvokeInputJsonSchema,
        outputs: connectorInvokeResultJsonSchema,
        resource: { type: "external_connector", id: { ref: "inputs.connectorId" } },
        policy: {
          action: connectorInvokeToolId,
          effect: "write",
          requiresApproval: false,
          maxAttempts: 1,
          timeoutMs: 8_000,
          classification: "public",
          maxOutputBytes: 16_000,
        },
        handler: async (raw, ctx) => {
          if (!this.connectorStore) throw new ToolError("CONNECTOR_STORE_UNAVAILABLE");
          const inp = raw as { connectorId: string; action: string; actor: string; payloadJson?: string };
          let payload: Record<string, unknown> = {};
          if (inp.payloadJson) {
            try {
              const parsed = JSON.parse(inp.payloadJson) as unknown;
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                payload = parsed as Record<string, unknown>;
              }
            } catch {
              throw new ToolError("INVALID_PAYLOAD_JSON");
            }
          }
          try {
            const out = await this.connectorStore.invokeConnector(
              inp.connectorId,
              { action: inp.action, actor: inp.actor, payload },
              ctx.signal,
            );
            return {
              ok: out.ok,
              connectorId: out.connectorId,
              connectorName: out.connectorName,
              statusCode: out.statusCode,
              elapsedMs: out.elapsedMs,
              summary: out.summary,
              responsePreview: out.responsePreview,
              sandbox: out.sandbox,
            };
          } catch (err) {
            throw new ToolError("CONNECTOR_EXECUTION_FAILED", err instanceof Error ? err.message : "Connector failed");
          }
        },
      }),
      defineTool({
        id: pznDataDictionaryToolId,
        version: pznSfieldToolVersion,
        description: "Data Dictionary API registered with sfield: read and author governed namespaces, attributes, business definitions, operators, and live resolver paths.",
        resource: { type: "pzn_data_dictionary", id: { ref: "inputs.operation" } },
        inputs: pznDataDictionaryToolInputJsonSchema,
        outputs: pznGenericToolResultJsonSchema,
        policy: {
          action: pznDataDictionaryToolId,
          effect: "write",
          requiresApproval: false,
          maxAttempts: 1,
          timeoutMs: 5_000,
          classification: "public",
          maxOutputBytes: 48_000,
        },
        handler: async (raw) => {
          if (!this.selfServicePzn) throw new ToolError("PZN_STORE_UNAVAILABLE", "Self-service PZN store is not attached.");
          const inp = raw as { operation: string; payloadJson?: string };
          const payload = this.pznVerifiedPayload(inp.operation, inp.payloadJson);
          try {
            switch (inp.operation) {
              case "get_dictionary": {
                const dict = this.selfServicePzn.getDictionary();
                return { ok: true, operation: inp.operation, summary: `Read Data Dictionary (${dict.namespaces.length} namespaces)`, resultJson: JSON.stringify(dict) };
              }
              case "upsert_namespace": {
                const ns = this.selfServicePzn.upsertNamespace(payload);
                return { ok: true, operation: inp.operation, summary: `Saved namespace "${ns.id}" (${ns.displayName})`, resultJson: JSON.stringify(ns) };
              }
              case "delete_namespace": {
                this.selfServicePzn.deleteNamespace(String(payload.id ?? ""));
                return { ok: true, operation: inp.operation, summary: `Deleted namespace "${String(payload.id ?? "")}"`, resultJson: JSON.stringify({ deleted: true }) };
              }
              case "upsert_attribute": {
                const attr = this.selfServicePzn.upsertAttribute(payload);
                return { ok: true, operation: inp.operation, summary: `Saved Data Dictionary attribute "${attr.namespaceId}.${attr.id}"`, resultJson: JSON.stringify(attr) };
              }
              case "delete_attribute": {
                this.selfServicePzn.deleteAttribute(String(payload.namespaceId ?? ""), String(payload.attributeId ?? ""));
                return { ok: true, operation: inp.operation, summary: `Deleted attribute "${String(payload.namespaceId ?? "")}.${String(payload.attributeId ?? "")}"`, resultJson: JSON.stringify({ deleted: true }) };
              }
              default:
                throw new ToolError("INVALID_OPERATION", `Unsupported Data Dictionary operation: ${inp.operation}`);
            }
          } catch (err) {
            if (err instanceof ToolError) throw err;
            throw new ToolError("PZN_DICTIONARY_ERROR", err instanceof Error ? err.message : "Data Dictionary tool error");
          }
        },
      }),
      defineTool({
        id: pznRuleMetadataToolId,
        version: pznSfieldToolVersion,
        description: "Rule Metadata API registered with sfield: create/update/test Data Dictionary rules, text contents, contexts, content-rule attachments, and immutable publish snapshots.",
        resource: { type: "pzn_rule_metadata", id: { ref: "inputs.operation" } },
        inputs: pznRuleMetadataToolInputJsonSchema,
        outputs: pznGenericToolResultJsonSchema,
        policy: {
          action: pznRuleMetadataToolId,
          effect: "write",
          requiresApproval: false,
          maxAttempts: 1,
          timeoutMs: 5_000,
          classification: "public",
          maxOutputBytes: 48_000,
        },
        handler: async (raw) => {
          if (!this.selfServicePzn) throw new ToolError("PZN_STORE_UNAVAILABLE", "Self-service PZN store is not attached.");
          const inp = raw as { operation: string; payloadJson?: string };
          const payload = this.pznVerifiedPayload(inp.operation, inp.payloadJson);
          try {
            switch (inp.operation) {
              case "get_workspace": {
                const ws = this.selfServicePzn.getWorkspaceState();
                return { ok: true, operation: inp.operation, summary: `Loaded workspace (${ws.contexts.length} contexts, ${ws.rules.length} rules)`, resultJson: JSON.stringify(ws) };
              }
              case "list_rules": {
                const rules = this.selfServicePzn.listRules();
                return { ok: true, operation: inp.operation, summary: `Listed ${rules.length} governed rules`, resultJson: JSON.stringify(rules) };
              }
              case "upsert_rule": {
                const rule = this.selfServicePzn.upsertRule(payload);
                return { ok: true, operation: inp.operation, summary: `Saved rule "${rule.ruleId}" (${rule.name})`, resultJson: JSON.stringify(rule) };
              }
              case "delete_rule": {
                this.selfServicePzn.deleteRule(String(payload.ruleId ?? ""));
                return { ok: true, operation: inp.operation, summary: `Deleted rule "${String(payload.ruleId ?? "")}"`, resultJson: JSON.stringify({ deleted: true }) };
              }
              case "test_rule": {
                const testRes = this.selfServicePzn.testRule(payload);
                return { ok: true, operation: inp.operation, summary: `Tested rule on ${testRes.mid} → ${testRes.evaluation.matched ? "TRUE" : "FALSE"}`, resultJson: JSON.stringify(testRes) };
              }
              case "list_contents": {
                const contents = this.selfServicePzn.listContents();
                return { ok: true, operation: inp.operation, summary: `Listed ${contents.length} text contents`, resultJson: JSON.stringify(contents) };
              }
              case "upsert_content": {
                const content = this.selfServicePzn.upsertContent(payload);
                return { ok: true, operation: inp.operation, summary: `Saved text content "${content.contentId}" (${content.title})`, resultJson: JSON.stringify(content) };
              }
              case "delete_content": {
                this.selfServicePzn.deleteContent(String(payload.contentId ?? ""));
                return { ok: true, operation: inp.operation, summary: `Deleted text content "${String(payload.contentId ?? "")}"`, resultJson: JSON.stringify({ deleted: true }) };
              }
              case "list_contexts": {
                const contexts = this.selfServicePzn.listContexts();
                return { ok: true, operation: inp.operation, summary: `Listed ${contexts.length} contexts`, resultJson: JSON.stringify(contexts) };
              }
              case "upsert_context": {
                const ctx = this.selfServicePzn.upsertContext(payload);
                return { ok: true, operation: inp.operation, summary: `Saved context "${ctx.contextId}" (${ctx.attachments.length} attachments)`, resultJson: JSON.stringify(ctx) };
              }
              case "delete_context": {
                this.selfServicePzn.deleteContext(String(payload.contextId ?? ""));
                return { ok: true, operation: inp.operation, summary: `Deleted context "${String(payload.contextId ?? "")}"`, resultJson: JSON.stringify({ deleted: true }) };
              }
              case "publish_context": {
                const pub = this.selfServicePzn.publishContext(
                  String(payload.contextId ?? ""),
                  typeof payload.publishedBy === "string" ? payload.publishedBy : "Self-Service Studio",
                  typeof payload.notes === "string" ? payload.notes : "",
                );
                return { ok: true, operation: inp.operation, summary: `Published "${pub.contextId}" v${pub.version} to Treatment Selector`, resultJson: JSON.stringify(pub) };
              }
              case "unpublish_context": {
                const ctx = this.selfServicePzn.unpublishContext(String(payload.contextId ?? ""));
                return { ok: true, operation: inp.operation, summary: `Unpublished "${ctx.contextId}"`, resultJson: JSON.stringify(ctx) };
              }
              default:
                throw new ToolError("INVALID_OPERATION", `Unsupported Rule Metadata operation: ${inp.operation}`);
            }
          } catch (err) {
            if (err instanceof ToolError) throw err;
            throw new ToolError("PZN_RULE_METADATA_ERROR", err instanceof Error ? err.message : "Rule Metadata tool error");
          }
        },
      }),
      defineTool({
        id: pznTreatmentSelectorToolId,
        version: pznSfieldToolVersion,
        description: "Treatment Selector (TS) API registered with sfield: evaluates a Customer MID + published Context, hydrates Data Dictionary attributes, calls the Rule Engine, filters contents, and returns eligible recommendations.",
        inputs: pznTreatmentSelectorToolInputJsonSchema,
        outputs: pznGenericToolResultJsonSchema,
        policy: {
          action: pznTreatmentSelectorToolId,
          effect: "read",
          requiresApproval: false,
          maxAttempts: 1,
          timeoutMs: 5_000,
          classification: "public",
          maxOutputBytes: 48_000,
        },
        handler: async (raw) => {
          if (!this.selfServicePzn) throw new ToolError("PZN_STORE_UNAVAILABLE", "Self-service PZN store is not attached.");
          const inp = raw as { operation: string; payloadJson?: string };
          const payload = this.pznVerifiedPayload(inp.operation, inp.payloadJson);
          try {
            switch (inp.operation) {
              case "evaluate": {
                const evalRes = this.selfServicePzn.evaluateLiveTs(payload as Parameters<SelfServicePznStore["evaluateLiveTs"]>[0]);
                return {
                  ok: true,
                  operation: inp.operation,
                  summary: `TS(${evalRes.mid}, ${evalRes.contextId}) → ${evalRes.eligibleContents.length} eligible, ${evalRes.filteredOutContents.length} filtered out (${evalRes.durationMs}ms)`,
                  resultJson: JSON.stringify(evalRes),
                };
              }
              case "list_published_contexts": {
                const list = this.selfServicePzn.listPublishedContextSummaries();
                return { ok: true, operation: inp.operation, summary: `Listed ${list.length} published contexts`, resultJson: JSON.stringify(list) };
              }
              default:
                throw new ToolError("INVALID_OPERATION", `Unsupported Treatment Selector operation: ${inp.operation}`);
            }
          } catch (err) {
            if (err instanceof ToolError) throw err;
            throw new ToolError("PZN_TS_ERROR", err instanceof Error ? err.message : "Treatment Selector tool error");
          }
        },
      }),
    ];
  }

  private verifier(id: string, stage: Stage): Verifier {
    return {
      id, kind: "validator",
      validate: async (output, { runId, principal }) => {
        let turn: TurnRecord | undefined;
        try {
          turn = await this.stageTurn(runId, principal, stage);
          if (stage === "route") {
            requireCheck(turn.catalog, "CATALOG_REQUIRED");
            requireCheck(turn.catalog.catalog.catalogVersion === activeContextCatalog.catalogVersion, "CATALOG_MISMATCH");
            verifyContextProposal(output, turn.catalog, turn.scope, this.now(), Boolean(this.inspection));
          } else {
            await this.verifyComposition(output, turn, runId);
          }
          return { ok: true };
        } catch (error) {
          const code = error instanceof Rejected ? error.code : "VERIFIER_ERROR";
          if (turn) this.store.update(turn.public.id, (current) => { current.trace.failures.push({ stage, code }); });
          return { ok: false, reason: code };
        }
      },
    };
  }

  async verifyComposition(output: unknown, turn: TurnRecord, runId: string) {
    requireCheck(turn.catalog && turn.route && turn.decision && turn.attempts.route, "ROUTE_REQUIRED");
    verifyRoute(turn.route, turn.catalog, turn.scope, turn.attempts.route.runId, this.now());
    const calls = await this.sf.persistence.listCalls(runId);
    // A persisted successful tool result is the evidence. Handler output alone cannot authorize display.
    const read = calls.find((call) => call.toolRef === toolRefs.balances && call.state === "succeeded"
      && call.result?.status === "succeeded" && call.invocation?.principalIdentity.subjectId === turn.scope.principalId
      && call.invocation.principalIdentity.tenantId === serverTenantId && call.invocation.runId === runId);
    const reading = metricReadingSchema.safeParse(read?.result?.output);
    const proof: BalanceProof | null = read && reading.success ? {
      ...reading.data, toolId: sfieldTools.balances.id, callId: read.callId, scope: turn.scope,
      decisionId: turn.decision.decisionId, routeDecisionId: turn.route.routeDecisionId,
      contextId: turn.route.contextId, composerRunId: runId, expiresAt: turn.decision.expiresAt,
    } : null;
    if (proof) this.store.update(turn.public.id, (current) => { current.proof = proof; });
    const verify = (proposal: unknown) => verifyExperience(
      proposal, turn.decision!, turn.route!, turn.scope, runId, proof, this.now(), turn.portfolioSnapshot, turn.goalProgress,
    );
    let verified = verify(output);
    if (turn.trace.intentId === "compare_balances" && !verified.blocks.some(({ proposal }) => proposal.component === "PznComparison")) {
      const compare = turn.decision.candidates.filter((candidate) => lookupContent(candidate)?.allowedComponents.includes("PznComparison"));
      if (compare.length === 2) {
        const layout = {
          ...verified.proposal, status: "ready", introKey: "comparison", clarificationQuestion: null, replyText: null,
          blocks: [{ blockId: "balance_comparison", component: "PznComparison", candidateIds: compare.map(({ candidateId }) => candidateId), variant: "expanded" }],
          followUpIds: [],
        };
        verified = verify(layout);
        this.store.update(turn.public.id, (current) => { current.trace.markers.comparisonLayoutApplied = this.now(); });
      }
    }
    return { verified, proof, unsuccessfulRead: turn.trace.intentId === "show_balance" && !proof && calls.some((call) => call.toolRef === toolRefs.balances) };
  }

  private async stageTurn(runId: string, principal: Principal, stage: Stage) {
    const run = await this.sf.persistence.getRun(runId);
    requireCheck(run && typeof run.request.inputs?.turnRef === "string", "RUN_NOT_ADMITTED");
    const turn = this.current(run.request.inputs.turnRef);
    requireCheck(principal.subjectId === turn.scope.principalId && principal.tenantId === serverTenantId, "STAGE_SCOPE_MISMATCH");
    this.bindAttempt(turn, stage, run);
    return this.current(turn.public.id);
  }

  private bindAttempt(turn: TurnRecord, stage: Stage, run: RunRecord) {
    const attempt = turn.attempts[stage];
    const conversation = this.store.conversation(turn.scope.conversationId, turn.scope.principalId);
    const decisionRef = stage === "route" ? turn.catalog?.snapshotId : turn.decision?.decisionId;
    requireCheck(attempt && run.kind === "session" && run.tenantId === serverTenantId
      && run.subjectId === turn.scope.principalId && run.principal.subjectId === turn.scope.principalId
      && conversation.personaId === turn.scope.personaId && conversation.sessions[stage] === attempt.sessionId
      && run.conversationId === attempt.sessionId && run.agentId === stageAgent[stage] && attempt.stage === stage
      && run.idempotencyKey === attempt.idempotencyKey && run.request.inputs?.stageAttemptId === attempt.id
      && run.request.inputs?.turnRef === turn.public.id && attempt.decisionRef === decisionRef
      && (!attempt.runId || attempt.runId === run.runId), "STAGE_SCOPE_MISMATCH");
    requireCheck(this.store.update(turn.public.id, (current) => {
      const row = current.attempts[stage];
      requireCheck(row?.id === attempt.id && (!row.runId || row.runId === run.runId), "STAGE_SCOPE_MISMATCH");
      row.runId = run.runId;
      if (stage === "compose" && current.decision) current.decision.composerRunId = run.runId;
    }), "TURN_INACTIVE");
  }

  async registry<T>(
    turn: TurnRecord, boundary: keyof typeof registryPurposes, maxToolCalls: number, signal: AbortSignal,
    use: (execute: (tool: keyof typeof toolRefs, inputs: JsonObject) => ReturnType<SField["registry"]["execute"]>) => Promise<T>,
  ) {
    signal.throwIfAborted();
    const scope = await this.sf.executions.open({
      principal: principalFor(turn.scope.principalId, turn.scope), purpose: registryPurposes[boundary],
      preset: "read_only", budget: { maxToolCalls },
    });
    try {
      requireCheck(this.store.update(turn.public.id, (current) => { current[boundary] = scope.id; }), "TURN_INACTIVE");
      return await use((tool, inputs) => {
        signal.throwIfAborted();
        return scope.registry.execute(toolRefs[tool], inputs, { signal });
      });
    } finally {
      await scope.close();
    }
  }

  async model(
    stage: Stage, turn: TurnRecord, conversation: ConversationRecord, decisionRef: string, envelope: object,
    signal: AbortSignal, recovering: boolean,
  ): Promise<RunResult> {
    const principal = principalFor(turn.scope.principalId, turn.scope);
    let attempt: StageAttempt | undefined = turn.attempts[stage];
    if (attempt && recovering) {
      const stored = attempt.runId ? await this.sf.persistence.getRun(attempt.runId)
        : (await this.sf.persistence.listRuns({ conversationId: attempt.sessionId, limit: 12 }))
          .find((run) => run.request.inputs?.stageAttemptId === attempt!.id);
      if (stored) {
        this.bindAttempt(this.current(turn.public.id), stage, stored);
        const handle = await this.sf.runs.get({ runId: stored.runId, principal });
        if (stored.state === "completed" || stored.state === "verification_failed" || stored.state === "failed") return handle.result();
        await handle.cancel("Interrupted by application restart");
        const replacement = await this.sf.sessions.open({ agent: stageAgent[stage], principal });
        this.store.setSession(conversation, stage, replacement.conversationId);
        await replacement.close();
        throw new Rejected("RESTARTED");
      }
    }

    signal.throwIfAborted();
    const session = await this.sf.sessions.open({ agent: stageAgent[stage], principal, conversationId: conversation.sessions[stage] });
    try {
      signal.throwIfAborted();
      if (!conversation.sessions[stage]) this.store.setSession(conversation, stage, session.conversationId);
      if (!attempt) {
        attempt = {
          id: makeId("attempt"), stage, sessionId: session.conversationId, decisionRef,
          idempotencyKey: turn.public.id + ":" + stage, runId: null, startedAt: this.now(),
        };
        const prepared = attempt;
        requireCheck(this.store.update(turn.public.id, (current) => { current.attempts[stage] = prepared; }), "TURN_INACTIVE");
      }
      const message = JSON.stringify(envelope);
      requireCheck(Buffer.byteLength(message) <= 48_000, "MODEL_ENVELOPE_TOO_LARGE");
      const handle = await session.send({
        message: { text: message }, inputs: { turnRef: turn.public.id, stageAttemptId: attempt.id }, idempotencyKey: attempt.idempotencyKey,
      });
      const abort = () => { void handle.cancel("Application turn ended").catch(() => undefined); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted) abort();
        else {
          const run = await this.sf.persistence.getRun(handle.id);
          if (signal.aborted) abort();
          else {
            requireCheck(run, "RUN_NOT_ADMITTED");
            this.bindAttempt(this.current(turn.public.id), stage, run);
          }
        }
        const result = this.rehydrateRunResult(await handle.result());
        if (this.telemetry && this.modelMeta) {
          this.telemetry.recordModelCall({
            operation: `sfield:${stage}`,
            provider: this.modelMeta.provider,
            model: this.modelMeta.model,
            durationMs: result.usage.elapsedMs || result.usage.activeMs,
            status: result.state === "completed" ? "ok" : "error",
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            costMicroUsd: result.usage.costMicroUsd,
            runId: result.runId,
            ...(result.error ? { errorMessage: result.error.message } : {}),
          });
        }
        return result;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    } finally {
      await session.close();
    }
  }

  /** Lists active sfield memory items (preferences & facts) scoped to this principal. */
  async listMemory(principalId: string) {
    const handle = this.sf.memory.for(principalFor(principalId));
    const page = await handle.list({ status: "active" }, { limit: 50 });
    return page.items;
  }

  /** Persists a scoped preference or fact via sfield's MemoryService (blocks secrets, enforces caps & retention, audited). */
  async rememberMemory(
    principalId: string,
    input: { kind: "preference" | "fact"; content: string; key?: string; origin?: "user_explicit" | "trusted_source" },
  ) {
    const principal = principalFor(principalId);
    const handle = this.sf.memory.for(principal);
    return handle.put(
      {
        scope: { kind: "subject", tenantId: principal.tenantId, subjectId: principal.subjectId },
        kind: input.kind,
        content: input.content.trim(),
        origin: input.origin ?? "user_explicit",
        provenance: [{ sourceType: "message", sourceId: principalId, observedAt: new Date(this.now()).toISOString() }],
        ...(input.key ? { structured: { key: input.key, value: input.content.trim() } } : {}),
      },
      { idempotencyKey: `mem_${principalId}_${input.kind}_${digestJson({ content: input.content, key: input.key ?? null }).slice(0, 16)}` },
    );
  }

  /** Forgets a memory item via sfield's MemoryService and returns its deletion receipt. */
  async forgetMemory(principalId: string, memoryId: string) {
    const handle = this.sf.memory.for(principalFor(principalId));
    return handle.forget(
      { id: memoryId },
      { idempotencyKey: `forget_${principalId}_${memoryId}` },
    );
  }

  async close() {
    await this.sf.close();
  }
}
