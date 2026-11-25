import type { EvaluationRow } from "../../packages/contracts/evaluation";
import { axeBudget, experienceAgentId, type ExecutionBudget } from "../../packages/contracts/agentic";
import { availableFundingOptions, fundingPreviewFrom } from "../../packages/capabilities";
import { AgenticExecution } from "./agentic-execution";
import { axeAgentConfig } from "./agentic-model";
import { axeToolAction, ExperienceAgent } from "./experience-agent";
import { dirname, resolve } from "node:path";
import { ASK_USER, defineTool, estimateJsonTokens, estimateTokens, SField, ToolError } from "@sfield/core";
import type { ConfigDocument, DefineToolInput, JsonObject, JsonValue, Principal, RunRecord, RunResult, ToolHandlerContext, Verifier } from "@sfield/core";
import { SqlitePersistence } from "@sfield/store-sqlite";
import host from "../../fixtures/host.json";
import { findProfileById, type PersonaRecord } from "../../packages/customer-profiles";
import { MAX_MESSAGE_LENGTH, metricReadingSchema, TURN_DEADLINE, type BalanceProof, type Scope } from "../../packages/contracts/domain";
import {
  fundingAgentId, fundingAgentToolLimit, fundingOptionsSchema, fundingToolRef, fundingToolVersion,
  resolveFundingWorkflow, treatmentRecommendationsVersion,
} from "../../packages/contracts/funding-workflow";
import { goalProgressSchema, isHomeGoalSummary } from "../../packages/contracts/goal-progress";
import {
  balanceInputSchema, balanceResultSchema, compositionOutputSchema, contextResultSchema, portfolioInputSchema, portfolioResultSchema,
  glossaryInputSchema, glossaryResultSchema, goalProgressInputSchema, goalProgressResultSchema,
  fundingAgentResultSchema, fundingOptionsResultSchema, fundingReadInputSchema, fundingStatusResultSchema, fundingPreviewInputSchema,
  fundingPreviewResultSchema, treatmentRecommendationsResultSchema,
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
    recordId: { type: "string", minLength: 1, maxLength: 64 },
    summary: { type: "string", minLength: 1, maxLength: 320 },
  },
} as const;
import { activeContextCatalog, fixtureEligibleSets, FixtureTsAdapter, type ContextScoresRequest, type FixtureState } from "../../packages/ts-adapter";
import { nextStepContext, workspaceFundingContext, type WorkspaceNextStep } from "../../packages/contracts/workspace";
import { nextStepRecommendation } from "./funding-offer";
import { mockRuleGlossary } from "../../packages/rule-glossary";
import { fixturePortfolioSnapshotProvider, type PortfolioSnapshotProvider } from "../../packages/portfolio-snapshot";
import { fixtureGoalProgressProvider, type GoalProgressProvider } from "../../packages/goal-progress";
import { contentCatalog, lookupContent, modelBundle, readDemoBalance, resolveCandidates } from "../../packages/experience/content";
import { checkFresh, Rejected, requireCheck, verifyContextProposal, verifyExperience, verifyRoute } from "../../packages/experience/verify";
import { makeId } from "../../packages/experience/compile";
import type { GatewayExchange } from "../../packages/contracts/inspector";
import { configureCopilotAcp } from "./copilot-acp";
import { configureGateway, type GatewaySettings } from "./gateway";
import { FundingAgent, fundingAgentInstructions } from "./funding-agent";
import { stageAgent, type ConversationRecord, type Stage, type StageAttempt, type Store, type TurnRecord } from "./store";
import { readTurnPayloads } from "./turn-payloads";

const toolRefs = {
  catalog: `${sfieldTools.catalog.id}@${toolVersion}`,
  propensity: `${sfieldTools.propensity.id}@${toolVersion}`,
  selection: `${sfieldTools.selection.id}@${toolVersion}`,
  recommendations: `${sfieldTools.selection.id}@${treatmentRecommendationsVersion}`,
  balances: `${sfieldTools.balances.id}@${toolVersion}`,
  glossary: `${sfieldTools.glossary.id}@${toolVersion}`,
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
  portfolioScopeId: "pzn-portfolio-snapshot",
  goalScopeId: "pzn-goal-progress",
  workflowScopeId: "pzn-funding-preview",
} as const;
const registryBoundaries = {
  catalog: "catalogScopeId", propensity: "catalogScopeId", selection: "tsScopeId", glossary: "glossaryScopeId", portfolio: "portfolioScopeId",
  goal: "goalScopeId", fundingOptions: "workflowScopeId", fundingStatus: "workflowScopeId", fundingPreview: "workflowScopeId",
} as const;
export function principalFor(id: string): Principal {
  return { tenantId: "pzn-local", subjectId: id, roles: ["pzn-demo", "pzn-developer"], attributes: {} };
}
const actions = new Set<string>([...toolKeys.map((key) => sfieldTools[key].id), recommendationArbitrateToolId]);
export const sfieldNamespace = "pzn-experience-runtime";

function requireToolEnabled(turn: TurnRecord, key: ToolKey) {
  if (turn.toolSetup?.enabled[key] === false) throw new ToolError("TOOL_DISABLED");
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

export class Runtime {
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
  ) {
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
    );
    const agentTools = [...runtime.experiences.tools(), ...runtime.experiences.execution.tools()];
    const agentActions = new Set(agentTools.map(({ ref }) => axeToolAction(ref)));
    runtime.sf = await SField.create({
      deployment: "durable_single", config: runtimeConfig(settings, gateway.model, goalBudget),
      persistence: new SqlitePersistence({ path }),
      namespace: sfieldNamespace,
      ...gateway.options,
      authorizer: {
        async authorize({ principal, action, effect, agentId }) {
          const readAllowed = effect === "read" && (
            actions.has(action) || agentActions.has(action)
            || ((agentId === fundingAgentId || agentId === experienceAgentId) && action === ASK_USER.policy.action)
          );
          const writeAllowed = effect === "write" && (action === domainWriteToolId || action === connectorInvokeToolId) && !agentId;
          return principal.tenantId === "pzn-local" && principal.roles.includes("pzn-demo") && (readAllowed || writeAllowed)
            ? { decision: "allow", evidenceId: makeId("auth"), expiresAt: new Date(now() + axeBudget.activeSeconds * 1000).toISOString() }
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
          id: "pzn-funding-tool-input", point: "prepareTool", timeoutMs: 1_000, onFailure: "fail",
          seesProtectedContent: false, buildIdentity: "pzn-funding-input-v1",
          async prepareTool({ toolRef, inputs, runId, principal }) {
            return await runtime.experiences.prepare(toolRef, runId, principal) ?? runtime.funding.prepare(toolRef, inputs, runId);
          },
        },
      ],
      tools: [...runtime.tools(), ...agentTools],
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

  async evaluation(principalId: string): Promise<EvaluationRow[]> {
    const turns = this.store.recentCompletedTurns(principalId);
    const items = await Promise.all(turns.map(async (turn) => {
      const ids = new Set([
        turn.agentRunId, ...turn.agentExecutionIds ?? [], ...Object.values(turn.attempts).map(({ runId }) => runId),
        turn.catalogScopeId, turn.tsScopeId, turn.portfolioScopeId, turn.goalScopeId, turn.glossaryScopeId,
        turn.workflowScopeId, turn.fundingRun?.id,
      ].filter((id): id is string => Boolean(id)));
      const results = await Promise.all([...ids].map(async (id) => {
        const run = await this.sf.persistence.getRun(id);
        if (run?.subjectId !== principalId || run.tenantId !== "pzn-local") return;
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
    const boundary = registryBoundaries[key];
    requireCheck(turn[boundary] === ctx.runId && ctx.principal.tenantId === "pzn-local"
      && turn.scope.principalId === ctx.principal.subjectId && !ctx.agentId, "REGISTRY_SCOPE_MISMATCH");
    const conversation = this.store.conversation(turn.scope.conversationId, turn.scope.principalId);
    requireCheck(conversation.personaId === turn.scope.personaId, "PERSONA_MISMATCH");
    const persona = findProfileById(conversation.personaId);
    requireCheck(persona && persona.allowedScenarios.includes(conversation.scenarioId), "PERSONA_MISMATCH");
    if (boundary === "workflowScopeId") {
      const definition = turn.workflow && resolveFundingWorkflow(turn.workflow.recommendation, turn.toolSetup?.fundingWorkflow);
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
      state, setup?.treatmentOverrides, setup?.ccreRules, this.portfolioSnapshots, this.store.axe.fundingStatus(scope),
    );
  }

  private turnTreatmentAdapter(turn: TurnRecord, conversation: ConversationRecord) {
    return this.treatmentAdapter({ scenarioId: conversation.scenarioId, ordinal: turn.ordinal }, turn.toolSetup, turn.scope);
  }

  async workspaceNextStep(principalId: string, personaId: string): Promise<WorkspaceNextStep | null> {
    const persona = findProfileById(personaId);
    if (!persona) return null;
    const setup = this.store.toolSetup(principalId);
    if (!setup.enabled.selection) return null;
    const adapter = this.treatmentAdapter({ scenarioId: host.defaultScenarioId, ordinal: 1 }, setup, { principalId, personaId });
    const result = await adapter.selectEligibleContent({ mid: persona.syntheticMid, context: nextStepContext }, AbortSignal.timeout(5000));
    const { content, workflow } = nextStepRecommendation(result.recommendations, setup);
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
    const input = { mid: persona.syntheticMid, context };
    let ccre: MockCcreEvaluation | undefined;
    try {
      const result = await this.turnTreatmentAdapter(turn, conversation).selectEligibleContent(input, ctx.signal);
      if (turn.route && isPortfolioSummary(turn.route)) {
        requireCheck(this.store.update(turn.public.id, (row) => { row.portfolioForRule = result.portfolio ?? undefined; }), "TURN_INACTIVE");
      }
      ccre = result.ccre;
      return result;
    } finally {
      if (this.inspection) {
        try {
          this.store.update(turn.public.id, (row) => {
            row.treatmentMockInput = input;
            row.treatmentCcre = ccre;
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
  ): Promise<{ summary: string; sfieldRunId: string; audit?: DomainWriteAuditEntry }> {
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
      const out = exec.output as { summary?: string };
      const summary = out.summary ?? `${input.action} applied to ${input.recordId}`;
      const audit = this.writeAudit?.record({
        sfieldRunId: scope.id,
        sfieldToolRef: domainWriteToolRef,
        domain: input.domain,
        recordId: input.recordId,
        action: input.action,
        actor: input.actor,
        summary,
        status: "succeeded",
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      });
      return { summary, sfieldRunId: scope.id, audit };
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
        handler: async (raw) => {
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
            ok: true,
            recordId: inp.recordId,
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
      && call.invocation.principalIdentity.tenantId === "pzn-local" && call.invocation.runId === runId);
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
    requireCheck(principal.subjectId === turn.scope.principalId && principal.tenantId === "pzn-local", "STAGE_SCOPE_MISMATCH");
    this.bindAttempt(turn, stage, run);
    return this.current(turn.public.id);
  }

  private bindAttempt(turn: TurnRecord, stage: Stage, run: RunRecord) {
    const attempt = turn.attempts[stage];
    const conversation = this.store.conversation(turn.scope.conversationId, turn.scope.principalId);
    const decisionRef = stage === "route" ? turn.catalog?.snapshotId : turn.decision?.decisionId;
    requireCheck(attempt && run.kind === "session" && run.tenantId === "pzn-local"
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
      principal: principalFor(turn.scope.principalId), purpose: registryPurposes[boundary],
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
    const principal = principalFor(turn.scope.principalId);
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
        return await handle.result();
      } finally {
        signal.removeEventListener("abort", abort);
      }
    } finally {
      await session.close();
    }
  }

  async close() {
    await this.sf.close();
  }
}
