import { retirementAccountRequest, retirementBeneficiaryIntent, retirementListIntent, retirementViewSchema } from "../../packages/contracts/retirement-accounts";
import { compileRetirementView } from "../../packages/experience/retirement-accounts";
import { getDomainPack } from "../../packages/contracts/domain-packs";
import { uiIntentHints } from "../../packages/contracts/ui-layout";
import { capabilityRef, inputValuesSchema, type AgentLaunch } from "../../packages/contracts/agentic";
import { fieldValueValid } from "./agentic-inputs";
import { digestJson, type ChatHarness, type RunResult } from "@sfield/core";
import demo from "../../fixtures/host.json";
import { type Conversation, type FailureCode, type TurnAccepted } from "../../packages/contracts/api";
import { findProfileById } from "../../packages/customer-profiles";
import { DECISION_TTL, TURN_DEADLINE, contextCatalogSchema, propensitySchema, type SelectionMode, type PropensityResult } from "../../packages/contracts/domain";
import {
  fundingOptionsSchema, fundingPreviewSchema, fundingPreviewWorkflow, fundingStatusSchema, fundingToolKey,
  fundingWorkflowIssue, resolveFundingWorkflow, chatTreatmentSchema, treatmentRecommendationsSchema, type WorkflowLaunch,
} from "../../packages/contracts/funding-workflow";
import { goalProgressSchema, isHomeGoalSummary } from "../../packages/contracts/goal-progress";
import type { ContextRoutingInput, ExperienceCompositionInput } from "../../packages/contracts/model-inputs";
import { isPortfolioSummary, portfolioSnapshotSchema } from "../../packages/contracts/portfolio";
import { ruleGlossarySchema } from "../../packages/contracts/rule-glossary";
import {
  availableRoutingIntents, demoExperiencesQuestion, explicitBalanceComparison, formatUnsupportedReply, resolveInvestMoreFallback, resolveSummaryFollowUp, routingQuestions,
} from "../../packages/contracts/routing-intents";
import { FOLLOW_UP_EVENT, type DisplayExperience } from "../../packages/contracts/surface";
import { normalizedIdsSchema, treatmentOverride } from "../../packages/contracts/tool-setup";
import { overviewFundingOrigin, pendingActionsContext, pendingActionsFundingOrigin, workspaceFundingContext } from "../../packages/contracts/workspace";
import { activeContextCatalog, fixtureRejections, tsFixtures } from "../../packages/ts-adapter";
import { contentCatalog, lookupContent, modelBundle, resolveCandidates } from "../../packages/experience/content";
import { compileChatReply, compileDynamicCanvas, compileExperience, compileFundingOptions, compileFundingPreview, compileRuleCreation, makeId } from "../../packages/experience/compile";
import { verifyContextProposal, verifyRoute, requireCheck, Rejected } from "../../packages/experience/verify";
import { ApiError, presentConversation, Store, type ConversationRecord, type Stage, type TurnRecord } from "./store";
import type { IntegrationTaskService } from "./integration-tasks";
import type { StoredWatch } from "./store";
import { answerCustomerLookup, watchRequest } from "./customer-record-chat";
import { normalizedIntentPhrase, recordIntentId } from "../../packages/contracts/ui-layout";
import { isRecordTimeline } from "./dynamic-ui-generator";
import { displayedRecordChoices, matchingDeals, recordChoiceIndex, recordPrompt } from "./record-context";
import { generateDynamicUi, isApprovalQueuePrompt, isConnectorActionPrompt, isDynamicUiRequest, isOpsIncidentPrompt, isSalesDealPrompt } from "./dynamic-ui-generator";
import { routeCapabilityUnified } from "./semantic-router";
import type { CepCapabilityId } from "../../packages/contracts/capabilities-catalog";
import { recommendationArbitrateToolRef } from "../../packages/contracts/recommendation-provider";
import type { ProviderArbitrationTrace } from "../../packages/contracts/api";
import { createOpsRunbookProvider, createSalesDealDeskProvider, RecommendationArbitrator } from "../../packages/recommendations";
import type { OpsIncidentStore } from "./ops-store";
import type { SalesDealStore } from "./sales-store";
import type { ConnectorStore } from "./connector-store";
import type { WorkflowEngine } from "./workflow-engine";
import { buildPolicyRagCanvas, isPolicyQuestion, type KnowledgeBaseStore } from "./knowledge-base";
import { extractDocumentAction, hasAttachedDocumentBlock } from "./document-extractor";
import type { ApprovalStore } from "./approval-store";
import type { SettlementCallback, TradeStore } from "./trade-store";
import type { ActionFlowStore } from "./action-flow-store";
import { type WidgetLibraryStore } from "./widget-library";
import { rehydrateObjectStrings, rehydratePiiText, type PiiFirewallStore } from "./pii-firewall";
import type { Customer360Service } from "./customer-360";
import type { GatewaySettings } from "./gateway";
import type { GoalProgressProvider } from "../../packages/goal-progress";
import type { PortfolioSnapshotProvider } from "../../packages/portfolio-snapshot";
import { beneficiaryReviewWorkflow } from "../../packages/contracts/customer-workflows";
import { workflowOfferSource, offeredWorkflows, nextStepRecommendation } from "./funding-offer";
import type { ActionMessage } from "@a2ui/web_core/v1_0";
import { principalFor, type Runtime } from "./runtime";
import { PznChatHistory } from "./chat-history";

class TurnFailure extends Error {
  constructor(readonly code: FailureCode) { super(code); }
}
const asRef = (turn: TurnRecord) => ({ turnRef: turn.public.id });
const CONVERSATIONAL_REPLY_TIMEOUT = 6_000;
const completed = (result: RunResult, stage: Stage) => {
  if (result.state === "completed") return;
  if (result.state === "verification_failed") throw new TurnFailure(stage === "route" ? "route_rejected" : "verification_failed");
  if (result.state === "budget_exhausted" || result.state === "expired") throw new TurnFailure("turn_timeout");
  throw new TurnFailure("gateway_unavailable");
};
function traceFor(result: RunResult) {
  const { elapsedMs, modelCalls, providerAttempts, toolCalls, totalTokens, tokensReported } = result.usage;
  return { state: result.state, errorCode: result.error?.code, elapsedMs, modelCalls, providerAttempts, toolCalls, totalTokens, tokensReported };
}

export class ExperienceService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly history: PznChatHistory;
  private closing = false;
  private watchTimer?: ReturnType<typeof setInterval>;
  private watchReads = new Map<string, Promise<void>>();

  startWatchChecks() {
    this.watchTimer = setInterval(() => {
      for (const w of this.store.dueWatches()) void this.refreshWatch(w);
    }, 60_000);
    this.watchTimer.unref();
  }

  private refreshWatch(w: StoredWatch) {
    const running = this.watchReads.get(w.id);
    if (running) return running;
    const read = (async () => {
      let value: string | undefined;
      try {
        if (w.kind === "deal") {
          const deal = this.dynamicUi?.salesStore?.list().find((d) => d.id === w.recordId);
          value = deal && (["Commit", "Closed Won"].includes(deal.stage) ? "ready" : deal.stage);
        } else {
          const mid = findProfileById(w.personaId)?.syntheticMid;
          if (mid) value = (await this.dynamicUi?.integrationService?.customerRead(w.principalId, mid, w.ref, w.recordId))?.watchValue;
        }
      } catch { /* A failed read keeps the watch pending until the next check. */ }
      this.store.observeWatch(w, value);
    })().finally(() => this.watchReads.delete(w.id));
    this.watchReads.set(w.id, read);
    return read;
  }

  async recordUpdates(conversation: ConversationRecord, operator: boolean) {
    const visible = () => this.store.watches(conversation).filter((w) => w.kind === "task" || operator);
    await Promise.all(visible().filter((w) => w.state === "watching" && this.store.watchDue(w.id)).map((w) => this.refreshWatch(w)));
    return visible().map(({ id, recordId, label, state, value, updatedAt }) => ({ id, recordId, label, state, value, updatedAt }));
  }

  constructor(
    readonly store: Store, private readonly runtime: Runtime | null, readonly selectionMode: SelectionMode, private readonly now: () => number,
    private readonly canCreateRule: boolean, private readonly offlineHistory?: { chat: ChatHarness; close(): Promise<void> },
    private readonly dynamicUi?: {
      isTenantAdmin?: (operatorName: string) => boolean;
      gateway?: GatewaySettings | null;
      dataDir: string;
      integrationService?: IntegrationTaskService;
      customer360?: Customer360Service;
      portfolioSnapshots?: PortfolioSnapshotProvider;
      goalProgressProvider?: GoalProgressProvider;
      opsStore?: OpsIncidentStore;
      salesStore?: SalesDealStore;
      connectorStore?: ConnectorStore;
      approvalStore?: ApprovalStore;
      tradeStore?: TradeStore;
      actionFlowStore?: ActionFlowStore;
      workflowEngine?: WorkflowEngine;
      knowledgeBase?: KnowledgeBaseStore;
      widgetLibraries?: Record<Conversation["domainId"], WidgetLibraryStore>;
      piiFirewall?: PiiFirewallStore;
      onTradeSettle?: (principalId: string) => SettlementCallback;
    },
  ) {
    const chat = runtime?.chat ?? offlineHistory?.chat;
    if (!chat) throw new Error("sfield chat persistence is required.");
    this.history = new PznChatHistory(store, chat);
  }

  createConversation(principalId: string, personaId: string, scenarioId: string, audience?: Conversation["audience"], domainId: Conversation["domainId"] = "wealth", operatorName?: string, preview?: ConversationRecord["preview"]) {
    const allowed = domainId === "wealth" ? findProfileById(personaId)?.allowedScenarios.includes(scenarioId) : Boolean(operatorName) && scenarioId === demo.defaultScenarioId;
    if (!allowed) throw new ApiError(400, "demo_scope_invalid", "Select an available profile and scenario.");
    return this.store.createConversation(principalId, personaId, scenarioId, this.now(), audience, domainId, domainId === "wealth" ? personaId : operatorName, preview);
  }

  conversationTurns(conversation: ConversationRecord) {
    return this.history.turns(conversation);
  }

  async turnView(turn: TurnRecord) {
    const conversation = this.store.conversation(turn.scope.conversationId, turn.scope.principalId);
    const views = await this.history.turns(conversation);
    const current = views.find(({ id }) => id === turn.public.id);
    requireCheck(current, "TURN_UNAVAILABLE");
    return current;
  }

  submit(conversation: ConversationRecord, message: string, requestId: string, origin = "message", retry?: TurnRecord, workflow?: WorkflowLaunch, agentLaunch?: AgentLaunch, operatorName?: string, requestSessionId?: string) {
    if (conversation.audience === "admin" && !this.canCreateRule) {
      throw new ApiError(404, "not_found", "This conversation is unavailable.");
    }
    const actor = conversation.domainId === "wealth" && conversation.audience !== "admin" ? undefined : operatorName;
    const { turn, created } = this.store.accept({
      conversation, message, requestId, origin, retry, workflow, agentLaunch, operatorName: actor, requestSessionId,
      tenantOperator: Boolean(actor && this.dynamicUi?.isTenantAdmin?.(actor)), selectionMode: this.selectionMode, now: this.now(),
    });
    if (created) this.schedule(turn);
    return this.accepted(turn);
  }

  async retry(turn: TurnRecord, requestId: string, currentOperator?: string, requestSessionId?: string) {
    const conversation = this.store.conversation(turn.scope.conversationId, turn.scope.principalId);
    const { message } = await this.turnView(turn);
    const origin = workspaceFundingContext(turn.origin) ? turn.origin : "retry:" + turn.public.id;
    return this.submit(conversation, message, requestId, origin, turn, undefined, undefined, currentOperator, requestSessionId);
  }

  previewWorkspaceFunding(conversation: ConversationRecord, requestId: string, source?: typeof pendingActionsContext, requestSessionId?: string) {
    if (!this.runtime) throw new ApiError(409, "model_unavailable", "Connect a model to preview funding in chat.");
    if (conversation.scenarioId !== demo.defaultScenarioId) {
      throw new ApiError(409, "workspace_scope_invalid", "Open Overview to start a funding preview.");
    }
    if (conversation.domainId !== "wealth") throw new ApiError(403, "domain_access_denied", "Funding belongs to the Wealth workspace.");
    const origin = source === pendingActionsContext ? pendingActionsFundingOrigin : overviewFundingOrigin;
    return this.submit(conversation, fundingPreviewWorkflow.label, requestId, origin, undefined, undefined, undefined, undefined, requestSessionId);
  }

  followUp(principalId: string, experienceId: string, envelope: ActionMessage, requestId: string, operatorName?: string, requestSessionId?: string) {
    const { action } = envelope;
    const { turn, actions } = this.store.experience(experienceId, principalId);
    const signed = actions.find((entry) => entry.actionId === action.context.actionId && entry.componentId === action.sourceComponentId);
    if (!signed || action.name !== FOLLOW_UP_EVENT || action.surfaceId !== experienceId) {
      throw new ApiError(400, "action_invalid", "This follow-up is unavailable.");
    }
    const conversation = this.store.conversation(turn.scope.conversationId, principalId);
    if (!operatorName && (conversation.audience === "admin" || this.store.hasOperatorContent(conversation.id))) {
      throw new ApiError(403, "operator_required", "Sign in with your operator account to continue this turn.");
    }
    const origin = (signed.standaloneAction ? "standalone_action:" : signed.agentAction ? "experience_action:" : signed.workflow ? "workflow:" : "follow_up:") + signed.actionId;
    const submit = (launch?: AgentLaunch, actionOrigin = origin) => this.submit(conversation, signed.userMessage, requestId, actionOrigin, undefined,
      signed.workflow && { recommendation: signed.workflow, sourceExperienceId: signed.offerSourceId ?? experienceId }, launch, operatorName, requestSessionId);
    const agentAction = signed.agentAction;
    const standalone = signed.standaloneAction;
    if (agentAction || standalone) {
      const values = inputValuesSchema.safeParse(action.context.values);
      const manifest = this.runtime?.experiences.registry.get(principalId, standalone ? capabilityRef(standalone) : agentAction!.capability);
      const fields = agentAction?.fieldIds ?? manifest?.inputs.map(({ id }) => id) ?? [];
      if (!values.success || !manifest || Object.keys(values.data).some((key) => !fields.includes(key))) {
        throw new ApiError(400, "action_input_invalid", "Review the form values and try again.");
      }
      const invalidField = manifest.inputs.some((field) => field.type !== "choice"
        && !fieldValueValid(field, values.data[field.id]));
      const malformedChoice = manifest.inputs.some((field) => field.type === "choice"
        && (field.required || values.data[field.id] !== undefined) && typeof values.data[field.id] !== "string");
      if (invalidField || malformedChoice) throw new ApiError(400, "action_input_invalid", "Review the form values and try again.");
      const digest = digestJson(values.data);
      const actionOrigin = origin + ":" + digest;
      const existing = this.store.existingRequest(conversation.id, requestId, signed.userMessage, actionOrigin);
      if (existing) return this.accepted(existing);
      if (standalone) {
        if (this.store.latestTurn(conversation.id)?.public.id !== turn.public.id || (turn.public.experience?.expiresAt ?? 0) <= this.now()) {
          throw new ApiError(409, "action_stale", "Ask again to get an updated response.");
        }
        return submit({ capability: { id: standalone.id, version: standalone.version },
          sourceExperienceId: signed.offerSourceId ?? experienceId, values: values.data }, actionOrigin);
      }
      if (!agentAction) throw new ApiError(400, "action_invalid", "This follow-up is unavailable.");
      const journey = this.store.axe.get("journeys", turn.scope, agentAction.journeyId);
      if (turn.public.experience?.expiresAt === undefined || turn.public.experience.expiresAt <= this.now()
        || this.store.latestTurn(conversation.id)?.public.id !== turn.public.id || journey?.threadId !== conversation.id
        || journey.revision !== agentAction.revision || journey.turnId !== turn.public.id) {
        throw new ApiError(409, "action_stale", "Open the latest plan to make this change.");
      }
      return submit({ action: agentAction, values: values.data, sourceExperienceId: experienceId }, actionOrigin);
    }
    const existing = this.store.existingRequest(conversation.id, requestId, signed.userMessage, origin);
    if (existing) return this.accepted(existing);
    const latest = this.store.latestTurn(conversation.id);
    if (latest?.public.id !== turn.public.id || conversation.personaId !== turn.scope.personaId
      || !turn.public.experience || turn.public.experience.expiresAt <= this.now()
      || turn.decision?.routeDecisionId !== turn.route?.routeDecisionId) {
      throw new ApiError(409, "action_stale", "Ask again to get an updated response.");
    }
    return submit();
  }

  cancel(turn: TurnRecord) {
    const id = turn.public.id;
    const stopped = this.store.finish(id, { type: "cancelled" }, this.now());
    if (stopped) this.controllers.get(id)?.abort(new Error("Stopped"));
    return (stopped ?? this.store.ownTurn(id, turn.scope.principalId)).public;
  }

  reconcile() {
    for (const turn of this.store.workingTurns()) this.schedule(turn, true);
  }

  private accepted(turn: TurnRecord): TurnAccepted {
    const { id } = turn.public;
    const conversation = this.store.conversation(turn.scope.conversationId, turn.scope.principalId);
    return { turnId: id, eventsUrl: "/api/turns/" + id + "/events", turn: turn.public, conversation: presentConversation(conversation) };
  }

  private schedule(turn: TurnRecord, recovering = false) {
    const { id, conversationId } = turn.public;
    const earlier = this.jobs.get(conversationId) ?? Promise.resolve();
    const promise = earlier.catch(() => undefined).then(async () => {
      const conversation = this.store.conversation(conversationId, turn.scope.principalId);
      try {
        await this.history.flush(conversation);
      } catch {
        this.store.finish(id, { type: "failed", code: "internal_error" }, this.now());
        return;
      }
      try {
        await this.execute(id, recovering);
      } finally {
        // The committed app snapshot lets refresh or restart finish an interrupted history write.
        await this.history.flush(conversation);
      }
    });
    this.jobs.set(conversationId, promise);
    void promise.finally(() => {
      if (this.jobs.get(conversationId) === promise) this.jobs.delete(conversationId);
    }).catch(() => undefined);
  }

  private async execute(id: string, recovering: boolean) {
    const initial = this.store.turn(id);
    if (this.closing || initial?.public.status !== "working") return;
    const workspaceContext = workspaceFundingContext(initial.origin);
    const domain = initial.scope.domainId ?? "wealth";
    const tenantTools = Boolean(initial.operatorName && this.dynamicUi?.isTenantAdmin?.(initial.operatorName));
    const flowCatalog = initial.flowCatalog ?? this.store.routingFlows(this.store.conversation(initial.scope.conversationId, initial.scope.principalId), tenantTools);
    if (!initial.flowCatalog) this.store.update(id, (row) => { row.flowCatalog = flowCatalog; });
    const capabilities = flowCatalog.flows;
    const allows = (id: CepCapabilityId) => capabilities.some((flow) => flow.id === id);
    const accountHelp = allows("verified_experience");
    const priorAccountView = domain === "wealth" && this.store.previousCompletedTurn(initial.scope.conversationId, initial.ordinal)?.retirementAccounts;
    const accountRequest = accountHelp && domain === "wealth" && retirementAccountRequest(initial.public.message, Boolean(priorAccountView));
    const domainTools = this.dynamicUi && {
      ...this.dynamicUi,
      opsStore: allows("ops_incident") ? this.dynamicUi.opsStore : undefined,
      salesStore: allows("sales_deal_desk") ? this.dynamicUi.salesStore : undefined,
      tradeStore: allows("stock_holdings") || allows("stock_trade") ? this.dynamicUi.tradeStore : undefined,
      connectorStore: allows("external_connector") ? this.dynamicUi.connectorStore : undefined,
      approvalStore: allows("hitl_approvals") || allows("external_connector") || allows("stock_trade") ? this.dynamicUi.approvalStore : undefined,
      workflowEngine: allows("external_connector") ? this.dynamicUi.workflowEngine : undefined,
      actionFlowStore: allows("external_connector") ? this.dynamicUi.actionFlowStore : undefined,
      knowledgeBase: tenantTools && accountHelp ? this.dynamicUi.knowledgeBase : undefined,
    };
    const goalTurn = accountHelp && domain === "wealth" && !accountRequest && !workspaceContext && !initial.workflow && this.runtime?.experiences.shouldHandle(initial);
    const deadline = initial.public.createdAt + (goalTurn ? this.runtime!.goalBudget.activeSeconds * 1_000 : TURN_DEADLINE);
    const remains = deadline - this.now();
    if (remains <= 0) {
      this.store.finish(id, { type: "failed", code: recovering ? "restarted" : "turn_timeout" }, this.now());
      return;
    }
    const runtime = this.runtime;
    if (!runtime) {
      this.store.finish(id, { type: "failed", code: "gateway_unavailable" }, this.now());
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    this.controllers.set(id, controller);
    const timer = setTimeout(() => controller.abort(new TurnFailure("turn_timeout")), remains);
    timer.unref();
    let stage: "catalog" | "route" | "glossary" | "ts" | "portfolio" | "goal" | "compose" | "workflow" | "experience" = "catalog";
    let emptyEligibility = false;
    const current = () => {
      signal.throwIfAborted();
      return runtime.current(id);
    };
    const done = (status: DisplayExperience["status"], outcome: DisplayExperience["outcome"], question: string | null) => {
      current();
      const result = compileExperience({
        status, outcome, introKey: status === "clarify" ? "clarification" : "no_match", question,
        partial: false, expiresAt: this.now(),
      });
      this.store.update(id, (row) => { row.public.actionMode = status === "clarify" ? "clarify" : "plain_chat"; });
      this.store.finish(id, { type: "completed", result }, this.now());
    };
    const showSavedWidget = (exactOnly = true) => {
      if (!allows("custom_dynamic_ui")) return false;
      const name = domain === "wealth" ? findProfileById(initial.scope.personaId)?.displayName : undefined;
      const match = domainTools?.widgetLibraries?.[domain].renderPublishedWidget(initial.scope.principalId, initial.public.message, name, exactOnly);
      if (!match) return false;
      current();
      stage = "compose";
      const now = this.now();
      const result = compileDynamicCanvas(match.intro, match.canvas, now + DECISION_TTL);
      this.store.update(id, (row) => {
        row.public.actionMode = "dynamic_ui";
        row.trace.components = result.display.blocks.map((block) => block.component);
      });
      this.store.finish(id, { type: "completed", result }, now);
      return true;
    };
    try {
      if (!capabilities.length && !initial.workflow && !workspaceContext && !initial.agentLaunch) {
        const reply = `There are no chat flows available in ${getDomainPack(domain).label} right now.`;
        this.store.finish(id, { type: "completed", result: compileChatReply(reply, "reply", this.now() + DECISION_TTL) }, this.now());
        return;
      }
      runtime.experiences.execution.world.rememberPreference(initial);
      if (workspaceContext) {
        stage = "ts";
        const launch = initial.workflow ?? await this.authorizeWorkspaceFunding(runtime, current(), workspaceContext, signal);
        if (!launch) {
          const now = this.now();
          const result = compileChatReply("This funding preview is no longer available. Check Overview for your current next step.", "reply", now);
          this.store.finish(id, { type: "completed", result }, now);
          return;
        }
        stage = "workflow";
        if (!await this.runCustomerWorkflow(runtime, current(), launch, signal)) throw new TurnFailure("workflow_unavailable");
        return;
      }
      if (goalTurn && !hasAttachedDocumentBlock(initial.public.message)) {
        stage = "experience";
        this.store.progress(id, "planning", this.now());
        const conversation = this.store.conversation(initial.scope.conversationId, initial.scope.principalId);
        const recent = await this.history.recent(conversation, initial.ordinal);
        const result = await runtime.experiences.respond(current(), principalFor(initial.scope.principalId, initial.scope), recent, signal);
        if (result) {
          this.store.update(id, (row) => {
            row.public.actionMode = "verified_experience";
            row.trace.components = result.display.blocks.map(({ component }) => component);
          });
          this.store.finish(id, { type: "completed", result }, this.now());
          return;
        }
        stage = "catalog";
      }
      if (!initial.workflow && !initial.route && domainTools && !accountRequest) {
        const conversation = this.store.conversation(initial.scope.conversationId, initial.scope.principalId);
        const persona = domain === "wealth" ? findProfileById(conversation.personaId) : undefined;

        const previous = this.store.previousCompletedTurn(conversation.id, initial.ordinal);
        const message = initial.public.message;
        const lookup = persona && domainTools.integrationService && await answerCustomerLookup(
          domainTools.integrationService, conversation.principalId, persona.syntheticMid, message, previous?.customerTask,
        );
        if (lookup) {
          current();
          if (lookup.watch) this.store.watch(conversation, lookup.watch, lookup.watch.value);
          const expires = this.now() + DECISION_TTL;
          const result = lookup.canvas ? compileDynamicCanvas(lookup.text, lookup.canvas, expires) : compileChatReply(lookup.text, "reply", expires);
          this.store.update(id, (row) => {
            row.customerTask = lookup.subject;
            row.public.actionMode = lookup.canvas ? "dynamic_ui" : "plain_chat";
            row.trace.components = result.display.blocks.map((b) => b.component);
            if (lookup.subject) row.trace.customerRead = { toolRef: lookup.subject.ref, runId: lookup.subject.runId };
          });
          this.store.finish(id, { type: "completed", result }, this.now());
          return;
        }
        const choices = displayedRecordChoices(previous?.public.experience?.blocks);
        const choice = recordChoiceIndex(message, choices.length);
        const displayed = previous?.public.experience?.blocks.find((block) => block.component === "PznDynamicCanvas");
        if (choice !== undefined && !choices[choice] && displayed) {
          this.store.update(id, (row) => {
            row.requestedRecordIntent = previous?.requestedRecordIntent;
            row.trace.intentId = previous?.trace.intentId;
          });
          const answer = compileDynamicCanvas(`Choose one of the ${choices.length} records listed here.`, displayed.props, this.now() + DECISION_TTL);
          this.store.finish(id, { type: "completed", result: answer }, this.now());
          return;
        }
        const picked = choice === undefined ? undefined : choices[choice];
        const referenceMessage = picked ? message + " (" + picked.id + ")" : message;
        const phrase = normalizedIntentPhrase(message.replace(/\b(?:DEAL|INC)-[\w-]+\b/gi, ""));
        const declaredIntents = initial.uiLayouts?.flatMap(({ design }) => design.recordIntent ? [design.recordIntent] : []) ?? [];
        const namedIntent = domain !== "wealth" ? declaredIntents.find((item) => item.phrases.some((example) => normalizedIntentPhrase(example) === phrase)
          || (choice !== undefined && item.id === previous?.requestedRecordIntent)) : undefined;
        const subject = domain === "it_ops" ? "incident" : "deal";
        const request = namedIntent ? "Show " + subject + (namedIntent.view === "timeline" ? " timeline " : " ") +
          (referenceMessage.match(/\b(?:DEAL|INC)-[\w-]+\b/gi)?.join(" ") ?? (namedIntent.view === "list" ? "list" : previous?.recordId ?? "details")) : referenceMessage;
        const scopedPrompt = recordPrompt(request, previous?.recordId, initial.operatorName ? domainTools.salesStore?.list() ?? [] : [], initial.operatorName ? domainTools.opsStore?.list() ?? [] : []);
        if (domainTools.salesStore && watchRequest.test(message) && initial.operatorName && /\bquote\b/i.test(message)) {
          const matches = matchingDeals(scopedPrompt, domainTools.salesStore?.list() ?? []);
          if (matches.length !== 1) {
            const question = "Which deal should I watch? Include its deal ID with your request.";
            this.store.finish(id, { type: "completed", result: compileChatReply(question, "reply", this.now() + DECISION_TTL) }, this.now());
            return;
          }
          const [deal] = matches;
          const ready = ["Commit", "Closed Won"].includes(deal.stage);
          if (!ready) {
            this.store.watch(conversation, {
              kind: "deal", ref: "deal.stage", recordId: deal.id, target: "ready", label: deal.id + " reaches Commit",
            }, deal.stage);
          }
          this.store.update(id, (row) => { row.recordId = deal.id; });
          const reply = ready ? `${deal.id} has reached ${deal.stage}.`
            : `I’ll post an update here when ${deal.id} reaches Commit. Its current stage is ${deal.stage}.`;
          this.store.finish(id, { type: "completed", result: compileChatReply(reply, "reply", this.now() + DECISION_TTL) }, this.now());
          return;
        }

        // Run Visual PII Firewall inspection (toggleable ON/OFF in Admin)
        let activePiiTokenMap = new Map<string, string>();
        let scrubbedProfileSummaryOverride: string | undefined;
        if (domainTools.piiFirewall) {
          const contextSeed = persona
            ? `${persona.displayName} (Account ${persona.syntheticMid}, Cash $${((persona.cashCents ?? 0) / 100).toLocaleString("en-US")}, Equities $${((persona.equityCents ?? 0) / 100).toLocaleString("en-US")})`
            : undefined;
          const piiResult = domainTools.piiFirewall.inspectAndRecord({
            turnId: id,
            prompt: initial.public.message,
            contextSummary: contextSeed,
            knownNames: persona ? [persona.displayName, "Alice Morgan", "Jordan Lee", "Marcus Reed"] : ["Alice Morgan", "Jordan Lee", "Marcus Reed"],
            personaName: persona?.displayName,
          });
          activePiiTokenMap = piiResult.tokenMap;
          if (piiResult.trace.firewallEnabled && piiResult.scrubbedContextSummary) {
            scrubbedProfileSummaryOverride = piiResult.scrubbedContextSummary;
          }
          this.store.update(id, (row) => {
            row.public.piiRedaction = piiResult.trace;
          });
        }

        // 0. Multimodal Document-to-Action interception ([Attached: ...])
        const attachedDoc = hasAttachedDocumentBlock(initial.public.message);
        if (attachedDoc && domain === "wealth") {
          const extracted = await extractDocumentAction({
            fileName: attachedDoc.fileName,
            content: attachedDoc.body,
            gateway: domainTools.gateway,
            dataDir: domainTools.dataDir,
            signal,
          });
          if (extracted) {
            stage = "compose";
            this.store.progress(id, "composition", this.now());
            const now = this.now();
            if (extracted.actionType === "wire_workflow" && initial.operatorName && domainTools.workflowEngine) {
              const started = await domainTools.workflowEngine.startRun("wire_transfer_governed", {
                personaId: conversation.personaId,
                actorName: persona?.displayName ?? "Customer",
                conversationId: conversation.id,
                initialInputs: extracted.extractedFields,
              });
              const canvas = {
                title: `Document-to-Action · ${started.definition.name}`,
                badge: `Extracted from ${extracted.fileName}`,
                subtitle: extracted.summary,
                generatedBy: "synthesizer" as const,
                dataSource: `Document Extractor (${extracted.fileName}) → Workflow Engine`,
                recordId: started.run.runId,
                prompt: initial.public.message,
                nodes: [
                  {
                    type: "callout" as const,
                    tone: "highlight" as const,
                    title: `Auto-Extracted Fields from ${extracted.fileName}`,
                    body: `Recipient: ${extracted.extractedFields.recipientName} · Amount: $${extracted.extractedFields.amountUsd.toLocaleString("en-US")} · Rail: ${extracted.extractedFields.rail}. Pre-populated below for verification.`,
                  },
                  {
                    type: "workflow_runner" as const,
                    runId: started.run.runId,
                    workflowId: started.definition.id,
                    workflowName: started.definition.name,
                  },
                ],
                disclaimer: "Document fields extracted automatically. Review pre-filled inputs before continuing through compliance gates.",
              };
              const dynamicResult = compileDynamicCanvas(
                `Extracted wire payment details from **${extracted.fileName}** and pre-populated the **Governed Wire Transfer Pipeline** below.`,
                canvas,
                now + DECISION_TTL,
              );
              this.store.update(id, (row) => {
                row.public.actionMode = "dynamic_ui";
                row.public.semanticRoute = {
                  capabilityId: "external_connector",
                  capabilityLabel: `Document-to-Action · Wire Workflow`,
                  method: "deterministic",
                  confidence: extracted.confidence,
                  reasoning: extracted.summary,
                };
                row.trace.components = dynamicResult.display.blocks.map((block) => block.component);
              });
              this.store.finish(id, { type: "completed", result: dynamicResult }, now);
              return;
            }
            if (extracted.actionType === "stock_trade" && allows("stock_trade") && domainTools.tradeStore) {
              const syntheticPrompt = `${extracted.extractedFields.side} ${
                extracted.extractedFields.percent ? `${extracted.extractedFields.percent}%` : `${extracted.extractedFields.shares ?? 10} shares`
              } of ${extracted.extractedFields.symbol}`;
              const generated = await generateDynamicUi({
                prompt: syntheticPrompt,
                gateway: domainTools.gateway,
                dataDir: domainTools.dataDir,
                tradeStore: domainTools.tradeStore,
                approvalStore: domainTools.approvalStore,
                personaId: conversation.personaId,
                conversationId: conversation.id,
                principalId: initial.scope.principalId,
                onTradeSettle: domainTools.onTradeSettle,
                requesterName: initial.operatorName ?? persona?.displayName,
                semanticRoute: {
                  capabilityId: "stock_trade",
                  capabilityLabel: "Document-to-Action · Equity Order",
                  method: "deterministic",
                  confidence: extracted.confidence,
                  reasoning: extracted.summary,
                  extractedParams: extracted.extractedFields,
                },
                signal,
              });
              const dynamicResult = compileDynamicCanvas(
                `Extracted order instruction from **${extracted.fileName}**: ${extracted.summary}`,
                generated.canvas,
                now + DECISION_TTL,
              );
              this.store.update(id, (row) => {
                row.public.actionMode = "dynamic_ui";
                row.public.semanticRoute = {
                  capabilityId: "stock_trade",
                  capabilityLabel: "Document-to-Action · Equity Order",
                  method: "deterministic",
                  confidence: extracted.confidence,
                  reasoning: extracted.summary,
                };
                row.trace.components = dynamicResult.display.blocks.map((block) => block.component);
              });
              this.store.finish(id, { type: "completed", result: dynamicResult }, now);
              return;
            }
            if (extracted.actionType === "ops_incident" && allows("ops_incident")) {
              const canvas = {
                title: `Document-to-Action · Outage Log Triage (${extracted.extractedFields.serviceName})`,
                badge: `Parsed ${extracted.fileName}`,
                subtitle: extracted.summary,
                generatedBy: "synthesizer" as const,
                dataSource: `Log Extractor (${extracted.fileName}) + Live Incident Store`,
                prompt: initial.public.message,
                nodes: [
                  {
                    type: "metrics" as const,
                    items: [
                      { label: "Service", value: extracted.extractedFields.serviceName },
                      { label: "5xx Error Rate", value: `${extracted.extractedFields.errorRatePct}%`, delta: "Above 2.0% P1 threshold" },
                      { label: "p95 Latency", value: `${extracted.extractedFields.p95LatencyMs}ms`, delta: "Above 350ms SLO" },
                      { label: "Release", value: extracted.extractedFields.releaseTag },
                    ],
                  },
                  {
                    type: "callout" as const,
                    tone: "caution" as const,
                    title: `Extracted Log Evidence (${extracted.fileName})`,
                    body: extracted.extractedFields.logExcerpt,
                  },
                ],
                disclaimer: "Parsed from uploaded diagnostic log. Trigger the P1 rollback workflow or PagerDuty connector for governed remediation.",
                suggestedFollowUp: "Build an IT incident triage dashboard for our active P1 alert",
              };
              const dynamicResult = compileDynamicCanvas(
                `Analyzed **${extracted.fileName}** and extracted live P1 outage telemetry for **${extracted.extractedFields.serviceName}** (${extracted.extractedFields.releaseTag}).`,
                canvas,
                now + DECISION_TTL,
              );
              this.store.update(id, (row) => {
                row.public.actionMode = "dynamic_ui";
                row.public.semanticRoute = {
                  capabilityId: "ops_incident",
                  capabilityLabel: "Document-to-Action · Outage Log Triage",
                  method: "deterministic",
                  confidence: extracted.confidence,
                  reasoning: extracted.summary,
                };
                row.trace.components = dynamicResult.display.blocks.map((block) => block.component);
              });
              this.store.finish(id, { type: "completed", result: dynamicResult }, now);
              return;
            }
          }
        }

        // 0b. Policy & Knowledge Base RAG interception
        if (domainTools.knowledgeBase && !/\b(?:DEAL|INC)-[A-Z0-9]+\b/i.test(scopedPrompt) && isPolicyQuestion(initial.public.message)) {
          const ragResult = domainTools.knowledgeBase.search(initial.public.message, 3);
          if (ragResult.citations.length > 0) {
            stage = "compose";
            this.store.progress(id, "composition", this.now());
            const now = this.now();
            const built = buildPolicyRagCanvas(ragResult);
            const dynamicResult = compileDynamicCanvas(built.intro, built.canvas, now + DECISION_TTL);
            this.store.update(id, (row) => {
              row.public.actionMode = "dynamic_ui";
              row.public.semanticRoute = {
                capabilityId: "verified_experience",
                capabilityLabel: `Policy RAG · ${ragResult.citations[0].docTitle}`,
                method: "deterministic",
                confidence: 0.96,
                reasoning: `Retrieved ${ragResult.citations.length} verified clause(s) from CEP Policy Knowledge Base.`,
              };
              row.trace.components = dynamicResult.display.blocks.map((block) => block.component);
            });
            this.store.finish(id, { type: "completed", result: dynamicResult }, now);
            return;
          }
        }

        const activeDraft = domainTools.tradeStore?.getDraft(conversation.id);
        const matchedWorkflow = initial.operatorName && domainTools.workflowEngine?.matchPrompt(initial.public.message);
        const matchedActionFlow = initial.operatorName && domainTools.actionFlowStore?.matchPrompt(initial.public.message);

        // 1. Conversational continuation for an active stock trade draft in this thread
        if (activeDraft && allows("stock_trade") && domainTools.tradeStore) {
          const msg = initial.public.message.trim();
          const wantsTax = /^(?:yes|yeah|yep|sure|ok|please)\b/i.test(msg)
            || /\b(?:analyze|run|check|do|show)\s+(?:tax|tlh|loss|harvest)/i.test(msg);
          const wantsExec = /\b(?:execute|confirm|place|submit|run\s+(?:the\s+)?(?:trade|order|bundle)|go\s+ahead|proceed)\b/i.test(msg)
            || /^no\b/i.test(msg);
          const pctAdjust = msg.match(/\b(\d{1,3})\s*(?:%|percent\b)/i);
          const shareAdjust = !pctAdjust ? msg.match(/\b(\d{1,5})\s*(?:shares?|sh\b)\b/i) : null;

          if (wantsTax || wantsExec || pctAdjust || shareAdjust) {
            stage = "compose";
            this.store.progress(id, "composition", this.now());
            const generated = await generateDynamicUi({
              prompt: msg,
              gateway: domainTools.gateway,
              dataDir: domainTools.dataDir,
              opsStore: domainTools.opsStore,
              salesStore: domainTools.salesStore,
              connectorStore: domainTools.connectorStore,
              approvalStore: domainTools.approvalStore,
              tradeStore: domainTools.tradeStore,
              actionFlowStore: domainTools.actionFlowStore,
              personaId: conversation.personaId,
              conversationId: conversation.id,
              principalId: initial.scope.principalId,
              onTradeSettle: domainTools.onTradeSettle,
              requesterName: initial.operatorName ?? persona?.displayName,
              tradeContinuation: {
                draft: activeDraft,
                intent: wantsExec ? "execute" : wantsTax ? "tax_analysis" : "adjust_qty",
                ...(pctAdjust ? { percent: Math.min(100, Math.max(1, Number(pctAdjust[1]))) } : {}),
                ...(shareAdjust ? { shares: Math.max(1, Number(shareAdjust[1])) } : {}),
                includeHarvest: wantsExec && (Boolean(activeDraft.taxAnalysis) || /\b(?:bundle|harvest|tax|all)\b/i.test(msg)),
              },
              signal,
            });
            current();
            const now = this.now();
            const dynamicResult = compileDynamicCanvas(generated.intro, generated.canvas, now + DECISION_TTL);
            this.store.update(id, (row) => {
              row.public.actionMode = "dynamic_ui";
              row.public.semanticRoute = {
                capabilityId: "stock_trade",
                capabilityLabel: "Conversational Trade Continuation",
                method: "deterministic",
                confidence: 0.96,
                reasoning: `Continued active ${activeDraft.side.toUpperCase()} ${activeDraft.symbol} trade draft conversationally.`,
              };
              row.trace.components = dynamicResult.display.blocks.map((block) => block.component);
            });
            this.store.finish(id, { type: "completed", result: dynamicResult }, now);
            return;
          }
        }

        // 1b. Declarative Multi-Step Workflow match
        if (matchedWorkflow && domainTools.workflowEngine) {
          stage = "compose";
          this.store.progress(id, "composition", this.now());
          const started = await domainTools.workflowEngine.startRun(matchedWorkflow.id, {
            personaId: conversation.personaId,
            actorName: persona?.displayName ?? "Customer",
            conversationId: conversation.id,
          });
          current();
          const now = this.now();
          const canvas = {
            title: matchedWorkflow.name,
            badge: `Declarative Workflow · v${matchedWorkflow.version}`,
            subtitle: matchedWorkflow.description,
            generatedBy: "synthesizer" as const,
            dataSource: `Workflow Engine (workflows.json · ${matchedWorkflow.steps.length} steps)`,
            recordId: started.run.runId,
            prompt: initial.public.message,
            nodes: [
              {
                type: "workflow_runner" as const,
                runId: started.run.runId,
                workflowId: matchedWorkflow.id,
                workflowName: matchedWorkflow.name,
              },
            ],
            disclaimer: "Executed by CEP's declarative multi-step workflow engine with SHA-256 HITL gates and durable run state.",
          };
          const intro = `Started **${matchedWorkflow.name}** (\`${started.run.runId}\`). Complete the guided steps below — conditional branches, HITL compliance gates, and async timers execute automatically.`;
          const dynamicResult = compileDynamicCanvas(intro, canvas, now + DECISION_TTL);
          this.store.update(id, (row) => {
            row.public.actionMode = "dynamic_ui";
            row.public.semanticRoute = {
              capabilityId: "external_connector",
              capabilityLabel: `Declarative Workflow · ${matchedWorkflow.name}`,
              method: "deterministic",
              confidence: 0.98,
              reasoning: `Matched declarative multi-step workflow "${matchedWorkflow.id}" (${matchedWorkflow.steps.length} steps).`,
            };
            row.trace.components = dynamicResult.display.blocks.map((block) => block.component);
          });
          this.store.finish(id, { type: "completed", result: dynamicResult }, now);
          return;
        }

        // 2. Admin-authored No-Code Action Flow match
        if (matchedActionFlow) {
          stage = "compose";
          this.store.progress(id, "composition", this.now());
          const generated = await generateDynamicUi({
            prompt: initial.public.message,
            gateway: domainTools.gateway,
            dataDir: domainTools.dataDir,
            connectorStore: domainTools.connectorStore,
            approvalStore: domainTools.approvalStore,
            actionFlowStore: domainTools.actionFlowStore,
            matchedActionFlow,
            personaId: conversation.personaId,
            conversationId: conversation.id,
            requesterName: initial.operatorName ?? persona?.displayName,
            signal,
          });
          current();
          const now = this.now();
          const dynamicResult = compileDynamicCanvas(generated.intro, generated.canvas, now + DECISION_TTL);
          this.store.update(id, (row) => {
            row.public.actionMode = "dynamic_ui";
            row.public.semanticRoute = {
              capabilityId: "external_connector",
              capabilityLabel: `No-Code Flow · ${matchedActionFlow.name}`,
              method: "deterministic",
              confidence: 0.97,
              reasoning: `Matched admin-authored No-Code Action Flow "${matchedActionFlow.name}" (${matchedActionFlow.approvalMode}).`,
            };
            row.trace.components = dynamicResult.display.blocks.map((block) => block.component);
          });
          this.store.finish(id, { type: "completed", result: dynamicResult }, now);
          return;
        }

        const recentForRoute = await this.history.recent(conversation, initial.ordinal);
        const recentSummary = recentForRoute.slice(-2).map((turn) => JSON.stringify({
          message: turn.request, intent: turn.intentId ?? turn.contextId,
          reply: turn.clarificationQuestion ?? turn.assistantReply,
          displayed: turn.displayedContent,
        })).join("\n");
        const semanticRoute = await routeCapabilityUnified({
          capabilities,
          prompt: scopedPrompt,
          gateway: domainTools.gateway,
          onExchange: (operation, request, response) => runtime.captureTurnExchange(id, "flowRouting", operation, request, response),
          dataDir: domainTools.dataDir,
          recentSummary,
          signal,
        });
        current();
        if (!allows(semanticRoute.capabilityId)) {
          if (semanticRoute.capabilityId === "verified_experience" && showSavedWidget()) return;
          const example = capabilities.find((flow) => flow.examples.length)?.examples[0];
          const reply = `You're in ${getDomainPack(domain).label}. This request is outside its available chat flows.` + (example ? ` Try asking “${example}”.` : "");
          this.store.finish(id, { type: "completed", result: compileChatReply(reply, "reply", this.now() + DECISION_TTL) }, this.now());
          return;
        }
        this.store.update(id, (row) => {
          row.public.semanticRoute = {
            capabilityId: semanticRoute.capabilityId,
            capabilityLabel: semanticRoute.capabilityLabel,
            method: semanticRoute.method,
            confidence: semanticRoute.confidence,
            reasoning: semanticRoute.reasoning,
          };
        });
        if (semanticRoute.capabilityId === "custom_dynamic_ui" && showSavedWidget(false)) return;
        if (!initial.operatorName && ["hitl_approvals", "external_connector", "ops_incident", "sales_deal_desk"].includes(semanticRoute.capabilityId)) {
          this.store.finish(id, { type: "completed", result: compileChatReply("That workspace requires an operator sign-in.", "reply", this.now() + DECISION_TTL) }, this.now());
          return;
        }
        if (semanticRoute.capabilityId !== "verified_experience") {
        stage = "compose";
        this.store.progress(id, "composition", this.now());
        const lookupInfo = domainTools.customer360 && persona
          ? domainTools.customer360.evaluate({
              principalId: initial.scope.principalId,
              personaId: conversation.personaId,
              fundingStatus: (this.store.axe.fundingStatus(initial.scope) ?? persona.accountFundingStatus) === "funded" ? "funded" : "unfunded",
              excludePromotions: runtime.experiences.execution.world.exclusions(initial),
            })
          : undefined;
        const profileSummary = scrubbedProfileSummaryOverride ?? (lookupInfo
          ? `${lookupInfo.lookup.personaName} (${lookupInfo.lookup.highlights.join(", ")})`
          : undefined);
        const generatedRaw = await generateDynamicUi({
          prompt: scopedPrompt,
          profileSummary,
          recentContext: recentSummary,
          gateway: domainTools.gateway,
          dataDir: domainTools.dataDir,
          harness: runtime.harness,
          portfolioSnapshots: domainTools.portfolioSnapshots,
          goalProgressProvider: domainTools.goalProgressProvider,
          opsStore: domainTools.opsStore,
          salesStore: domainTools.salesStore,
          connectorStore: domainTools.connectorStore,
          approvalStore: domainTools.approvalStore,
          tradeStore: domainTools.tradeStore,
          actionFlowStore: domainTools.actionFlowStore,
          personaId: conversation.personaId,
          conversationId: conversation.id,
          principalId: initial.scope.principalId,
          onTradeSettle: domainTools.onTradeSettle,
          requesterName: initial.operatorName ?? persona?.displayName,
          semanticRoute,
          signal,
        });
        const generated = activePiiTokenMap.size > 0
          ? {
              intro: rehydratePiiText(generatedRaw.intro, activePiiTokenMap),
              canvas: rehydrateObjectStrings(generatedRaw.canvas, activePiiTokenMap),
            }
          : generatedRaw;
        current();
        const now = this.now();
        const dynamicResult = compileDynamicCanvas(generated.intro, generated.canvas, now + DECISION_TTL);
        const arbDomain: ProviderArbitrationTrace["domain"] = semanticRoute.capabilityId === "ops_incident"
          ? "operations"
          : semanticRoute.capabilityId === "sales_deal_desk"
            ? "sales"
            : "wealth";
        let providerArbitration: ProviderArbitrationTrace | undefined;
        try {
          if (arbDomain === "operations" && domainTools.opsStore) {
            const opsArb = await new RecommendationArbitrator([
              createOpsRunbookProvider(() => domainTools!.opsStore!.list().filter((r) => r.id === generated.canvas.recordId)),
            ]).arbitrate({
              principalId: initial.scope.principalId,
              personaId: conversation.personaId,
              syntheticMid: persona?.syntheticMid ?? "ops",
              contextId: "it_ops",
              domain: "operations",
              fundingStatus: "funded",
              excludePromotions: false,
            }, signal);
            providerArbitration = {
              toolRef: recommendationArbitrateToolRef,
              domain: "operations",
              decisionId: opsArb.decisionId,
              winnerTitle: opsArb.topNba?.title,
              providers: [
                ...opsArb.providers,
                { providerId: "treatment_selector", providerLabel: "Treatment Selector (TS + CCRE)", status: "skipped", candidateCount: 0, elapsedMs: 0, note: 'Domain "operations" outside wealth scope' },
                { providerId: "customer360_nba", providerLabel: "Customer 360 NBA Engine", status: "skipped", candidateCount: 0, elapsedMs: 0, note: 'Domain "operations" outside customer scope' },
                { providerId: "sales_deal_desk", providerLabel: "Sales Deal Desk Recommender", status: "skipped", candidateCount: 0, elapsedMs: 0, note: 'Domain "operations" outside sales scope' },
              ],
            };
          } else if (arbDomain === "sales" && domainTools.salesStore) {
            const salesArb = await new RecommendationArbitrator([
              createSalesDealDeskProvider(() => domainTools!.salesStore!.list().filter((r) => r.id === generated.canvas.recordId)),
            ]).arbitrate({
              principalId: initial.scope.principalId,
              personaId: conversation.personaId,
              syntheticMid: persona?.syntheticMid ?? "sales",
              contextId: "sales_revops",
              domain: "sales",
              fundingStatus: "funded",
              excludePromotions: false,
            }, signal);
            providerArbitration = {
              toolRef: recommendationArbitrateToolRef,
              domain: "sales",
              decisionId: salesArb.decisionId,
              winnerTitle: salesArb.topNba?.title,
              providers: [
                ...salesArb.providers,
                { providerId: "treatment_selector", providerLabel: "Treatment Selector (TS + CCRE)", status: "skipped", candidateCount: 0, elapsedMs: 0, note: 'Domain "sales" outside wealth scope' },
                { providerId: "customer360_nba", providerLabel: "Customer 360 NBA Engine", status: "skipped", candidateCount: 0, elapsedMs: 0, note: 'Domain "sales" outside customer scope' },
                { providerId: "ops_runbook", providerLabel: "IT Ops Runbook Recommender", status: "skipped", candidateCount: 0, elapsedMs: 0, note: 'Domain "sales" outside operations scope' },
              ],
            };
          } else {
            providerArbitration = {
              toolRef: recommendationArbitrateToolRef,
              domain: "wealth",
              decisionId: makeId("rec_arb"),
              winnerTitle: lookupInfo?.nba?.title,
              providers: [
                { providerId: "customer360_nba", providerLabel: "Customer 360 NBA Engine", status: "ok", candidateCount: lookupInfo?.nba ? 1 : 0, elapsedMs: 1 },
                { providerId: "treatment_selector", providerLabel: "Treatment Selector (TS + CCRE)", status: "skipped", candidateCount: 0, elapsedMs: 0, note: "Bypassed for Stage 0 Dynamic UI Canvas" },
                { providerId: "ops_runbook", providerLabel: "IT Ops Runbook Recommender", status: "skipped", candidateCount: 0, elapsedMs: 0, note: 'Domain "wealth" outside operations scope' },
                { providerId: "sales_deal_desk", providerLabel: "Sales Deal Desk Recommender", status: "skipped", candidateCount: 0, elapsedMs: 0, note: 'Domain "wealth" outside sales scope' },
              ],
            };
          }
        } catch { /* Telemetry trace must never fail turn completion. */ }
        this.store.update(id, (row) => {
          row.public.actionMode = "dynamic_ui";
          if (lookupInfo) row.public.customerLookup = lookupInfo.lookup;
          row.recordId = generated.canvas.recordId;
          if ((domain === "it_ops" && semanticRoute.capabilityId === "ops_incident") || (domain === "sales_revops" && semanticRoute.capabilityId === "sales_deal_desk")) {
            const view = generated.canvas.choices ? "list" : isRecordTimeline(scopedPrompt, semanticRoute.capabilityId) ? "timeline" : "detail";
            row.requestedRecordIntent = namedIntent?.id;
            row.trace.intentId = namedIntent?.view === view ? namedIntent.id : recordIntentId(domain, view);
          }
          if (providerArbitration) row.public.providerArbitration = providerArbitration;
          row.trace.components = dynamicResult.display.blocks.map((block) => block.component);
        });
        this.store.finish(id, { type: "completed", result: dynamicResult }, now);
        return;
        }
      }
      if (initial.workflow) {
        stage = "workflow";
        if (await this.runCustomerWorkflow(runtime, current(), initial.workflow, signal)) return;
        stage = "catalog";
      }
      if (!initial.catalog || !initial.propensity) await this.discover(runtime, current(), signal);
      const catalog = current().catalog!;
      const conversation = this.store.conversation(initial.scope.conversationId, initial.scope.principalId);
      const canCreateRule = this.canCreateRule && conversation.audience === "admin";

      stage = "route";
      requireCheck(catalog.catalog.catalogVersion === activeContextCatalog.catalogVersion, "CATALOG_MISMATCH");
      if (!current().route) {
        this.store.progress(id, "routing", this.now());
        const turn = current();
        const recent = await this.history.recent(conversation, turn.ordinal);
        current();
        const intentCatalog = availableRoutingIntents(catalog.catalog, canCreateRule);
        const summaryFollowUp = resolveSummaryFollowUp(turn.public.message, recent, intentCatalog);
        const uiDescriptions = uiIntentHints(turn.uiLayouts, intentCatalog.map(({ intentId }) => intentId));
        const personaForRoute = findProfileById(conversation.personaId);
        const effectiveFundingForRoute: "funded" | "unfunded" = personaForRoute
          ? ((this.store.axe.fundingStatus(turn.scope) ?? personaForRoute.accountFundingStatus) === "funded" ? "funded" : "unfunded")
          : "funded";
        const customerContext = personaForRoute ? {
          ...(personaForRoute.segment ? { segment: personaForRoute.segment } : {}),
          fundingStatus: effectiveFundingForRoute,
          beneficiaryStatus: personaForRoute.beneficiaryStatus,
          hasElevatedCash: personaForRoute.cashCents > 10_000_00,
          hasActiveHomeGoal: personaForRoute.homeGoalTargetCents > 0,
          ...(personaForRoute.notes ? { notes: personaForRoute.notes } : {}),
        } : undefined;
        const routeLookup = personaForRoute && domainTools?.customer360
          ? domainTools.customer360.evaluate({
              principalId: turn.scope.principalId,
              personaId: conversation.personaId,
              fundingStatus: effectiveFundingForRoute,
              excludePromotions: runtime.experiences.execution.world.exclusions(turn),
            }).lookup
          : undefined;
        const result = await runtime.model("route", turn, conversation, catalog.snapshotId, {
          inputType: "PznContextRoutingInput",
          catalogSnapshotId: catalog.snapshotId,
          catalog: catalog.catalog,
          intentCatalog,
          ...(customerContext && { customerContext }),
          ...(uiDescriptions.length && { uiDescriptions }),
          propensity: turn.propensity,
          allowedQuestions: routingQuestions,
          canCreateRule,
          recent,
          summaryFollowUpIntentId: summaryFollowUp?.intentId,
          request: turn.public.message,
        } satisfies ContextRoutingInput, signal, recovering);
        current();
        this.store.update(id, (row) => {
          row.trace.routeRun = traceFor(result);
          if (routeLookup) row.public.customerLookup = routeLookup;
        });
        completed(result, "route");
        const modelProposal = verifyContextProposal(result.output, catalog, turn.scope, this.now(), canCreateRule);
        const literalComparison = explicitBalanceComparison(turn.public.message, intentCatalog);
        const isUnfundedAccount = effectiveFundingForRoute !== "funded";
        const investMoreFallback = (modelProposal.status === "no_match" || modelProposal.status === "clarify")
          ? resolveInvestMoreFallback(turn.public.message, intentCatalog, isUnfundedAccount)
          : undefined;
        const established = summaryFollowUp ?? literalComparison ?? investMoreFallback;
        const applyEstablished = established && established.contextId !== null && modelProposal.intentId !== established.intentId;
        const proposal = applyEstablished ? {
          status: "selected" as const,
          intentId: established.intentId,
          contextId: established.contextId,
          intent: { topic: established.label, task: established.task,
            summary: summaryFollowUp ? "Show the summary of the established conversation topic."
              : literalComparison ? "Compare the requested balance definitions."
              : "Show governed investing and funding options for the customer's account." },
        } : modelProposal;
        this.store.update(id, (row) => {
          row.trace.routeOutcome = proposal.status;
          row.trace.intentId = proposal.intentId;
          if (proposal.status === "clarify") row.trace.possibleIntentId = proposal.possibleIntentId;
          if (applyEstablished) row.trace.markers[summaryFollowUp ? "summaryReferenceApplied" : "comparisonReferenceApplied"] = this.now();
          row.trace.markers.routeValidated = this.now();
        });
        if (proposal.status === "create_rule") {
          stage = "glossary";
          this.store.progress(id, "glossary", this.now());
          const read = await runtime.registry(current(), "glossaryScopeId", 1, signal, async (call) => (
            call("glossary", { ...asRef(turn), routerRunId: result.runId })
          ));
          current();
          if (read.status !== "succeeded") {
            this.store.update(id, (row) => { row.trace.failures.push({ stage: "glossary", code: read.error?.code ?? "GLOSSARY_UNAVAILABLE" }); });
            throw new TurnFailure("glossary_unavailable");
          }
          const glossary = ruleGlossarySchema.parse(read.output);
          const { personaId, scenarioId } = conversation;
          const now = this.now();
          const editor = compileRuleCreation({ personaId, scenarioId, glossary }, now + DECISION_TTL);
          this.store.update(id, (row) => {
            row.public.actionMode = "verified_experience";
            row.trace.glossaryVersion = glossary.version;
            row.trace.markers.glossaryResolved = now;
            row.trace.components = editor.display.blocks.map((block) => block.component);
          });
          this.store.finish(id, { type: "completed", result: editor }, now);
          return;
        }
        if ((proposal.status === "reply" || proposal.status === "no_match"
          || (proposal.status === "clarify" && !proposal.possibleIntentId)) && showSavedWidget()) return;
        if (proposal.status === "reply" || proposal.status === "no_match") {
          const activeTurn = current();
          if (allows("custom_dynamic_ui") && domainTools && isDynamicUiRequest(activeTurn.public.message) && (initial.operatorName || (!isSalesDealPrompt(activeTurn.public.message) && !isOpsIncidentPrompt(activeTurn.public.message) && !isApprovalQueuePrompt(activeTurn.public.message) && !isConnectorActionPrompt(activeTurn.public.message)))) {
            this.store.progress(id, "composition", this.now());
            const persona = personaForRoute;
            const profileSummary = persona
              ? `${persona.displayName} (${effectiveFundingForRoute} account, beneficiaries ${persona.beneficiaryStatus === "on_file" ? "on file" : "missing"})`
              : undefined;
            const generated = await generateDynamicUi({
              prompt: activeTurn.public.message,
              profileSummary,
              gateway: domainTools.gateway,
              dataDir: domainTools.dataDir,
              harness: runtime.harness,
              portfolioSnapshots: domainTools.portfolioSnapshots,
              goalProgressProvider: domainTools.goalProgressProvider,
              opsStore: domainTools.opsStore,
              salesStore: domainTools.salesStore,
              connectorStore: domainTools.connectorStore,
              approvalStore: domainTools.approvalStore,
              tradeStore: domainTools.tradeStore,
              personaId: conversation.personaId,
              principalId: initial.scope.principalId,
              requesterName: initial.operatorName ?? persona?.displayName,
              signal,
            });
            current();
            const now = this.now();
            const dynamicResult = compileDynamicCanvas(generated.intro, generated.canvas, now + DECISION_TTL);
            this.store.update(id, (row) => {
              row.public.actionMode = "dynamic_ui";
              row.trace.components = dynamicResult.display.blocks.map((block) => block.component);
            });
            this.store.finish(id, { type: "completed", result: dynamicResult }, now);
            return;
          }
          const now = this.now();
          const text = proposal.status === "reply"
            ? proposal.replyText
            : formatUnsupportedReply(initial.public.message);
          const result = compileChatReply(text, proposal.status, now);
          this.store.update(id, (row) => {
            row.public.actionMode = proposal.status === "reply" ? "plain_chat" : "clarify";
          });
          this.store.finish(id, { type: "completed", result }, now);
          return;
        }
        if (proposal.status === "clarify") {
          done(proposal.status, proposal.status, proposal.clarificationQuestion);
          return;
        }
        const now = this.now();
        this.store.update(id, (row) => {
          row.route = {
            routeDecisionId: makeId("route"), scope: row.scope, catalogSnapshotId: catalog.snapshotId, catalogVersion: catalog.catalog.catalogVersion,
            contextId: proposal.contextId, routerRunId: result.runId, intent: proposal.intent, issuedAt: now, expiresAt: now + DECISION_TTL,
          };
        });
      }

      stage = "ts";
      let turn = current();
      const route = turn.route!;
      verifyRoute(route, catalog, turn.scope, turn.attempts.route?.runId ?? null, this.now());
      const intentId = turn.trace.intentId ?? "";
      const accountTurn = domain === "wealth" && (intentId === retirementListIntent || intentId === retirementBeneficiaryIntent
        || (intentId === "beneficiary_update_steps" && Boolean(accountRequest)));
      if (accountTurn && !turn.retirementAccounts) {
        this.store.progress(id, "retirementAccounts", this.now());
        const read = await runtime.registry(turn, "retirementScopeId", 1, signal, (call) =>
          call("retirementAccounts", { ...asRef(turn), routeDecisionId: route.routeDecisionId }));
        current();
        if (read.status !== "succeeded") throw new TurnFailure("retirement_accounts_unavailable");
        const view = retirementViewSchema.parse(read.output);
        this.store.update(id, (row) => { row.retirementAccounts = view; });
        turn = current();
      }
      const accounts = turn.retirementAccounts;
      const finishAccounts = (answer: ReturnType<typeof compileRetirementView>) => {
        this.store.update(id, (row) => {
          row.public.actionMode = "verified_experience";
          row.trace.components = answer.display.blocks.map((block) => block.component);
        });
        this.store.finish(id, { type: "completed", result: answer }, this.now());
      };
      if (accounts && !accounts.selected) {
        finishAccounts(compileRetirementView(accounts, intentId, route.expiresAt));
        return;
      }
      const showBalance = turn.trace.intentId === "show_balance";
      const showPortfolio = isPortfolioSummary(route);
      const showGoal = isHomeGoalSummary(route);
      if (!turn.decision) {
        this.store.progress(id, "eligibility", this.now());
        const result = await runtime.registry(turn, "tsScopeId", 1, signal, (call) =>
          call("decisions", { ...asRef(turn), routeDecisionId: route.routeDecisionId }));
        current();
        if (result.status !== "succeeded") {
          this.store.update(id, (row) => { row.trace.failures.push({ stage: "ts", code: result.error?.code ?? "TS_UNAVAILABLE" }); });
          if (accounts) {
            finishAccounts(compileRetirementView(accounts, intentId, route.expiresAt, { recommendationsUnavailable: true }));
            return;
          }
          throw new TurnFailure("ts_unavailable");
        }

        const { recommendations } = chatTreatmentSchema.parse(result.output);
        const ids = normalizedIdsSchema.parse(recommendations.flatMap((item) => item.kind === "content" ? [item.id] : []));
        const { candidates: resolved, rejections } = resolveCandidates(ids, current().treatmentEntries);
        const noPromotions = runtime.experiences.execution.world.exclusions(turn);
        const candidates = resolved.filter((candidate) => {
          const content = lookupContent(candidate);
          if (accounts?.selected) return accounts.selected.beneficiary === null && content?.contentId === "beneficiary_update";
          return (!noPromotions || content?.kind !== "promotion") && Boolean(content?.portfolioData) === showPortfolio
            && Boolean(content?.allowedComponents.includes("PznGoalProgress")) === showGoal
            && (!content?.metricSpec || showBalance);
        });
        const partial = Boolean((candidates.length || showPortfolio) && rejections.length);
        const now = this.now();
        this.store.update(id, (row) => {
          const override = treatmentOverride(row.toolSetup?.treatmentOverrides ?? [], conversation.scenarioId, route.contextId);
          const simulatedRejections = override ? [] : fixtureRejections({ scenarioId: conversation.scenarioId, ordinal: row.ordinal }, route.contextId);
          const mockRuleRejections = row.treatmentCcre?.results.flatMap(({ contentId, outcome }) => outcome === "excluded"
            ? [{ contentId, stage: "simulated_ccre" as const, reasonCode: "RULE_FALSE" }] : []) ?? [];
          row.trace.ts = {
            contextId: route.contextId, fixtureVersion: tsFixtures.fixtureVersion, baseline: ids,
            source: override ? "override" : "fixture", rejections: [...simulatedRejections, ...mockRuleRejections, ...rejections],
            partial,
          };
          row.trace.markers.tsResolved = now;
          row.trace.markers.candidatesReady = now;
          row.decision = {
            decisionId: makeId("decision"), scope: row.scope, routeDecisionId: route.routeDecisionId, contextId: route.contextId,
            catalogVersion: contentCatalog.catalogVersion, issuedAt: now, expiresAt: now + DECISION_TTL,
            selectionMode: row.selectionMode, partial, candidates, composerRunId: null,
            workflowRecommendations: recommendations.flatMap((item) => item.kind === "workflow" ? [item] : []),
            actionRecommendations: recommendations.flatMap((item) => item.kind === "action" ? [item] : []),
          };
        });
      }
      turn = current();
      const decision = turn.decision!;
      const expiresAt = Math.min(decision.expiresAt, route.expiresAt);
      if (accounts && !decision.candidates.length) {
        finishAccounts(compileRetirementView(accounts, intentId, expiresAt));
        return;
      }
      if (showPortfolio && !turn.portfolioSnapshot) {
        stage = "portfolio";
        this.store.progress(id, "portfolio", this.now());
        const result = await runtime.registry(turn, "portfolioScopeId", 1, signal, async (call) => (
          call("portfolio", { ...asRef(turn), routeDecisionId: route.routeDecisionId })
        ));
        current();
        if (result.status !== "succeeded") {
          this.store.update(id, (row) => { row.trace.failures.push({ stage: "portfolio", code: result.error?.code ?? "PORTFOLIO_UNAVAILABLE" }); });
          throw new TurnFailure("portfolio_unavailable");
        }
        const snapshot = portfolioSnapshotSchema.parse(result.output);
        this.store.update(id, (row) => {
          row.portfolioSnapshot = snapshot;
          row.trace.markers.portfolioResolved = this.now();
        });
        turn = current();
      }
      const portfolio = showPortfolio ? turn.portfolioSnapshot : undefined;
      emptyEligibility = decision.candidates.length === 0;
      const standaloneActions = (decision.actionRecommendations ?? []).flatMap((recommendation) => {
        const manifest = runtime.experiences.registry.get(turn.scope.principalId, capabilityRef(recommendation));
        return manifest?.eligibility.kind === "capability" && manifest.discovery.contexts.includes(route.contextId)
          && manifest.inputs.length > 0 && manifest.inputs.every((field) => field.type !== "choice") ? [{ recommendation, manifest }] : [];
      });
      if (emptyEligibility && (portfolio || standaloneActions.length)) {
        const result = compileExperience({
          status: "ready", outcome: "ready", introKey: standaloneActions.length ? "next_step" : "summary", question: null, portfolio, standaloneActions, expiresAt, partial: decision.partial,
        });
        this.store.update(id, (row) => { row.trace.components = result.display.blocks.map((block) => block.component); });
        this.store.finish(id, { type: "completed", result }, this.now());
        return;
      }
      if (emptyEligibility && turn.trace.ts?.baseline.length && !runtime.experiences.execution.world.exclusions(turn)) throw new TurnFailure("content_unavailable");
      if (showGoal && !emptyEligibility && !turn.goalProgress) {
        stage = "goal";
        this.store.progress(id, "goal", this.now());
        const result = await runtime.registry(turn, "goalScopeId", 1, signal, async (call) => (
          call("goal", { ...asRef(turn), routeDecisionId: route.routeDecisionId })
        ));
        current();
        if (result.status !== "succeeded") {
          this.store.update(id, (row) => { row.trace.failures.push({ stage, code: result.error?.code ?? "GOAL_PROGRESS_UNAVAILABLE" }); });
          throw new TurnFailure("goal_unavailable");
        }
        const progress = goalProgressSchema.parse(result.output);
        this.store.update(id, (row) => {
          row.goalProgress = progress;
          row.trace.markers.goalResolved = this.now();
        });
        turn = current();
      }
      const goalProgress = showGoal ? turn.goalProgress : undefined;

      stage = "compose";
      this.store.progress(id, "composition", this.now());
      const composeSignal = emptyEligibility
        ? AbortSignal.any([signal, AbortSignal.timeout(CONVERSATIONAL_REPLY_TIMEOUT)])
        : signal;
      const result = await runtime.model("compose", turn, conversation, decision.decisionId, {
        inputType: "PznExperienceCompositionInput",
        request: turn.public.message, intent: route.intent,
        selectedIntentId: turn.trace.intentId ?? undefined, selectedContextId: route.contextId, eligible: modelBundle(decision, route),
        ...(portfolio && { portfolioSnapshotIncluded: true }),
        ...(goalProgress && { goalProgressIncluded: true }),
        ...(emptyEligibility && { recent: await this.history.recent(conversation, turn.ordinal) }),
        allowedQuestions: demo.clarificationQuestions,
      } satisfies ExperienceCompositionInput, composeSignal, recovering);

      const latest = current();
      this.store.update(id, (row) => { row.trace.composeRun = traceFor(result); });
      if (result.state === "verification_failed" && latest.trace.failures.at(-1)?.code.startsWith("METRIC_")) {
        throw new TurnFailure("metric_unavailable");
      }
      completed(result, "compose");
      this.store.progress(id, "verifying", this.now());
      const { verified, proof, unsuccessfulRead } = await runtime.verifyComposition(result.output, latest, result.runId);
      if (unsuccessfulRead) throw new TurnFailure("metric_unavailable");
      current();
      const { status } = verified.proposal;
      const compilerInput = {
        status, outcome: emptyEligibility && status === "no_match" ? "eligible_empty" : status, introKey: verified.proposal.introKey,
        question: verified.proposal.clarificationQuestion, partial: decision.partial && Boolean(portfolio || status === "ready"),
        expiresAt, approved: verified, proof, portfolio, goalProgress,
        workflows: offeredWorkflows(latest, verified.contentOrder), standaloneActions,
      } satisfies Parameters<typeof compileExperience>[0];
      const composed = compileExperience(compilerInput);
      runtime.captureTurnExchange(id, "compiler", "compileExperience", compilerInput, composed);
      const resultForDisplay = accounts ? compileRetirementView(accounts, intentId, expiresAt, {
        composed, reminder: decision.candidates.map(lookupContent).find((entry) => entry?.contentId === "beneficiary_update"),
        steps: /\bsteps?\b/i.test(turn.public.message),
      }) : composed;
      let lookupSummary: typeof latest.public.customerLookup;
      let companionNba: typeof latest.public.nextBestAction;
      if (domainTools?.customer360) {
        const persona = findProfileById(conversation.personaId);
        if (persona) {
          const existingBlockTitles = resultForDisplay.display.blocks.flatMap((block) => (
            "title" in block.props && typeof block.props.title === "string" ? [block.props.title] : []
          ));
          const evaluated = domainTools.customer360.evaluate({
            principalId: latest.scope.principalId,
            personaId: conversation.personaId,
            fundingStatus: (this.store.axe.fundingStatus(latest.scope) ?? persona.accountFundingStatus) === "funded" ? "funded" : "unfunded",
            excludePromotions: runtime.experiences.execution.world.exclusions(latest),
            existingBlockTitles,
          });
          lookupSummary = evaluated.lookup;
          if ((showBalance || showPortfolio) && resultForDisplay.display.status === "ready") {
            companionNba = evaluated.nba;
          }
        }
      }
      this.store.update(id, (row) => {
        row.public.actionMode = resultForDisplay.display.status === "clarify"
          ? "clarify"
          : resultForDisplay.display.blocks.length > 0
            ? "verified_experience"
            : "plain_chat";
        if (lookupSummary) row.public.customerLookup = lookupSummary;
        if (companionNba) row.public.nextBestAction = companionNba;
        const tsElapsed = Math.max(1, (row.trace.markers.tsResolved ?? this.now()) - (row.trace.markers.routeCommitted ?? row.trace.markers.tsResolved ?? this.now()));
        row.public.providerArbitration = {
          toolRef: recommendationArbitrateToolRef,
          domain: "wealth",
          decisionId: decision.decisionId,
          winnerTitle: companionNba?.title ?? verified.blocks[0]?.proposal.candidateIds[0],
          providers: [
            {
              providerId: "treatment_selector",
              providerLabel: "Treatment Selector (TS + CCRE)",
              status: "ok",
              candidateCount: decision.candidates.length,
              elapsedMs: tsElapsed,
            },
            {
              providerId: "customer360_nba",
              providerLabel: "Customer 360 NBA Engine",
              status: "ok",
              candidateCount: companionNba ? 1 : 0,
              elapsedMs: 1,
              ...(companionNba ? { note: `Winner: ${companionNba.title}` } : { note: "No higher-priority NBA required" }),
            },
            {
              providerId: "ops_runbook",
              providerLabel: "IT Ops Runbook Recommender",
              status: "skipped",
              candidateCount: 0,
              elapsedMs: 0,
              note: 'Domain "wealth" outside operations scope',
            },
            {
              providerId: "sales_deal_desk",
              providerLabel: "Sales Deal Desk Recommender",
              status: "skipped",
              candidateCount: 0,
              elapsedMs: 0,
              note: 'Domain "wealth" outside sales scope',
            },
          ],
        };
        row.trace.markers.proposalValidated = this.now();
        row.trace.finalOrder = verified.contentOrder;
        row.trace.components = resultForDisplay.display.blocks.map((block) => block.component);
      });
      this.store.finish(id, { type: "completed", result: resultForDisplay }, this.now());
    } catch (error) {
      if (this.closing || this.store.turn(id)?.public.status !== "working") return;
      const mapped = signal.reason instanceof TurnFailure ? signal.reason.code
        : error instanceof TurnFailure ? error.code
        : error instanceof Rejected && ["TURN_EXPIRED", "DECISION_EXPIRED"].includes(error.code) ? (recovering ? "restarted" : "turn_timeout")
        : error instanceof Rejected && error.code === "RESTARTED" ? "restarted"
        : stage === "catalog" ? "catalog_unavailable"
        : stage === "glossary" ? "glossary_unavailable"
        : stage === "ts" ? "ts_unavailable"
        : stage === "portfolio" ? "portfolio_unavailable"
        : stage === "goal" ? "goal_unavailable"
        : stage === "workflow" ? "workflow_unavailable"
        : stage === "experience" ? "experience_unavailable"
        : error instanceof Rejected ? (stage === "route" ? "route_rejected" : "verification_failed")
        : "internal_error";
      this.store.update(id, (row) => { row.trace.failures.push({ stage, code: error instanceof Rejected ? error.code : mapped }); });
      const now = this.now();
      if (stage === "experience" && mapped === "turn_timeout") {
        const partial = runtime.experiences.partial(this.store.turn(id)!);
        if (partial) {
          this.store.finish(id, { type: "completed", result: partial }, now);
          return;
        }
      }
      const saved = this.store.turn(id);
      if (stage === "compose" && (mapped === "gateway_unavailable" || mapped === "verification_failed")
        && saved?.retirementAccounts?.selected && saved.route && saved.decision && !signal.aborted) {
        const expiresAt = Math.min(saved.route.expiresAt, saved.decision.expiresAt);
        if (now < Math.min(deadline, expiresAt)) {
          const reminder = saved.decision.candidates.map(lookupContent).find((entry) => entry?.contentId === "beneficiary_update");
          const answer = compileRetirementView(saved.retirementAccounts, saved.trace.intentId ?? "", expiresAt, {
            reminder, steps: /\bsteps?\b/i.test(saved.public.message),
          });
          this.store.update(id, (row) => {
            row.public.actionMode = "verified_experience";
            row.trace.components = answer.display.blocks.map((block) => block.component);
          });
          this.store.finish(id, { type: "completed", result: answer }, now);
          return;
        }
      }
      if (emptyEligibility && stage === "compose" && !signal.aborted && now < deadline) {
        const result = compileChatReply(demo.introCopy.no_match, "eligible_empty", now);
        this.store.finish(id, { type: "completed", result }, now);
      } else {
        this.store.finish(id, { type: "failed", code: mapped }, now);
      }
    } finally {
      clearTimeout(timer);
      this.controllers.delete(id);
    }
  }

  private async authorizeWorkspaceFunding(runtime: Runtime, turn: TurnRecord, contextId: string, signal: AbortSignal): Promise<WorkflowLaunch | undefined> {
    const id = turn.public.id;
    this.store.progress(id, "eligibility", this.now());
    const result = await runtime.registry(turn, "tsScopeId", 1, signal, (call) => call("recommendations", {
      turnRef: id, routeDecisionId: id,
    }));
    runtime.current(id);
    if (result.status !== "succeeded") {
      this.store.update(id, (row) => { row.trace.failures.push({ stage: "ts", code: result.error?.code ?? "TS_UNAVAILABLE" }); });
      throw new TurnFailure("ts_unavailable");
    }
    const { ids, candidates, rejections, content, workflow } = nextStepRecommendation(
      treatmentRecommendationsSchema.parse(result.output), turn.toolSetup, contextId, runtime.current(id).treatmentEntries,
    );
    const current = runtime.current(id);
    const now = this.now();
    const launch = workflow && { recommendation: fundingPreviewWorkflow.recommendation, sourceOverviewTurnId: id };
    this.store.update(id, (row) => {
      row.trace.intentId = "suggest_next_step";
      row.trace.ts = {
        contextId, fixtureVersion: tsFixtures.fixtureVersion, baseline: ids,
        source: treatmentOverride(row.toolSetup?.treatmentOverrides ?? [], demo.defaultScenarioId, contextId) ? "override" : "fixture",
        partial: Boolean(rejections.length),
        rejections: [
          ...current.treatmentCcre?.results.flatMap(({ contentId, outcome }) => outcome === "excluded"
            ? [{ contentId, stage: "simulated_ccre" as const, reasonCode: "RULE_FALSE" }] : []) ?? [],
          ...rejections,
        ],
      };
      row.trace.markers.tsResolved = now;
      row.trace.finalOrder = content ? [content.contentId] : [];
      row.decision = {
        decisionId: makeId("decision"), scope: row.scope, contextId, routeDecisionId: id,
        catalogVersion: contentCatalog.catalogVersion, issuedAt: now, expiresAt: now + DECISION_TTL,
        selectionMode: row.selectionMode, partial: Boolean(rejections.length), candidates,
        composerRunId: null, workflowRecommendations: workflow ? [workflow] : [],
      };
      row.workflow = launch;
    });
    return launch;
  }

  private async runCustomerWorkflow(runtime: Runtime, turn: TurnRecord, launch: WorkflowLaunch, signal: AbortSignal) {
    const { source, expiry } = workflowOfferSource(this.store, turn, launch, this.now());
    const id = turn.public.id;
    this.store.progress(id, "workflow", this.now());
    if (launch.recommendation.id === beneficiaryReviewWorkflow.recommendation.id) {
      const routeDecisionId = source.route?.routeDecisionId;
      requireCheck(routeDecisionId, "WORKFLOW_SOURCE_REQUIRED");
      const read = await runtime.registry(turn, "workflowScopeId", 1, signal, (call) =>
        call("retirementAccounts", { ...asRef(turn), routeDecisionId }));
      requireCheck(read.status === "succeeded", "RETIREMENT_ACCOUNTS_UNAVAILABLE");
      const view = retirementViewSchema.parse(read.output);
      runtime.current(id);
      const now = this.now();
      const result = compileRetirementView(view, retirementBeneficiaryIntent, now + DECISION_TTL);
      this.store.update(id, (row) => { row.retirementAccounts = view; row.trace.components = result.display.blocks.map(({ component }) => component); });
      this.store.finish(id, { type: "completed", result }, now);
      return true;
    }
    const definition = resolveFundingWorkflow(launch.recommendation, turn.toolSetup?.fundingWorkflow);
    requireCheck(definition && !fundingWorkflowIssue(definition), "FUNDING_WORKFLOW_NOT_OFFERED");
    if (definition.mode === "agent") {
      const conversation = this.store.conversation(turn.scope.conversationId, turn.scope.principalId);
      const recent = await this.history.recent(conversation, turn.ordinal);
      const result = await runtime.funding.execute(
        turn, definition, principalFor(turn.scope.principalId, turn.scope), recent, expiry, signal,
      );
      if (result.outcome === "other_topic") return false;
      const now = this.now();
      const expiresAt = now + DECISION_TTL;
      const display = result.outcome === "preview" ? compileFundingPreview(result.preview, expiresAt)
        : result.outcome === "waiting_input" ? compileFundingOptions(result.options, result.expiresAt, result.question)
        : result.outcome === "options" ? compileFundingOptions(result.options, expiresAt)
        : compileChatReply(
          result.outcome === "already_funded" ? "Your account is already funded."
            : result.outcome === "cancelled" ? "I’ve closed the funding preview." : "I couldn’t prepare your funding preview. Please try again.",
          "reply", expiresAt,
        );
      runtime.current(id);
      this.store.update(id, (row) => { row.trace.components = display.display.blocks.map(({ component }) => component); });
      this.store.finish(id, { type: "completed", result: display }, now);
      return true;
    }
    const preview = await runtime.registry(turn, "workflowScopeId", definition.steps.length, signal, async (call) => {
      const outputs = new Map<string, unknown>();
      for (const ref of definition.steps) {
        const tool = fundingToolKey(ref);
        requireCheck(tool, "UNKNOWN_FUNDING_WORKFLOW_TOOL");
        const input = tool === "fundingPreview"
          ? { ...asRef(turn), methodId: fundingOptionsSchema.parse(outputs.get("fundingOptions")).methods[0].methodId }
          : asRef(turn);
        const result = await call(tool, input);
        if (result.status !== "succeeded") throw new Rejected(result.error?.code ?? "FUNDING_STEP_UNAVAILABLE");
        if (tool === "fundingStatus") {
          requireCheck(fundingStatusSchema.parse(result.output).accountFundingStatus === "unfunded", "ACCOUNT_ALREADY_FUNDED");
        }
        outputs.set(tool, result.output);
      }
      return fundingPreviewSchema.parse(outputs.get("fundingPreview"));
    });
    signal.throwIfAborted();
    runtime.current(id);
    const now = this.now();
    const result = compileFundingPreview(preview, now + DECISION_TTL);
    runtime.captureTurnExchange(id, "compiler", "compileFundingPreview", { preview, expiresAt: now + DECISION_TTL }, result);
    this.store.update(id, (row) => { row.trace.components = result.display.blocks.map(({ component }) => component); });
    this.store.finish(id, { type: "completed", result }, now);
    return true;
  }

  private async discover(runtime: Runtime, turn: TurnRecord, signal: AbortSignal) {
    const id = turn.public.id;
    this.store.progress(id, "catalog", this.now());
    await runtime.registry(turn, "catalogScopeId", turn.catalog ? 1 : 2, signal, async (call) => {
      let snapshot = turn.catalog;
      if (!snapshot) {
        const result = await call("catalog", asRef(turn));
        signal.throwIfAborted();
        if (result.status !== "succeeded") throw new TurnFailure("catalog_unavailable");
        const catalog = contextCatalogSchema.parse(result.output);
        const now = this.now();
        snapshot = { snapshotId: makeId("catalog"), scope: turn.scope, catalog, issuedAt: now, expiresAt: now + DECISION_TTL };
        this.store.update(id, (row) => { row.catalog = snapshot; row.trace.markers.catalogReady = now; });
      }

      const contextIds = snapshot.catalog.contexts.map((context) => context.contextId);
      let propensity: PropensityResult | undefined;
      try {
        const result = await call("propensity", { ...asRef(turn), catalogSnapshotId: snapshot.snapshotId });
        if (result.status === "succeeded") {
          const scored = propensitySchema.parse(result.output);
          const scoreIds = new Set(scored.scores.map(({ contextId }) => contextId));
          if (scoreIds.size === scored.scores.length && scoreIds.size === contextIds.length && contextIds.every((contextId) => scoreIds.has(contextId))
            && (scored.status === "available" || scored.scores.every(({ score }) => score === null))) propensity = scored;
        }
      } catch {
        signal.throwIfAborted();
      }
      signal.throwIfAborted();
      this.store.update(id, (row) => {
        row.propensity = propensity ?? {
          version: "unavailable", classification: "synthetic_advisory", status: "unavailable",
          scores: contextIds.map((contextId) => ({ contextId, score: null })),
        };
        row.trace.markers.propensityReady = this.now();
      });
    });
  }

  async close() {
    this.closing = true;
    clearInterval(this.watchTimer);
    await Promise.allSettled(this.watchReads.values());
    for (const controller of this.controllers.values()) controller.abort(new Error("Shutting down"));
    await Promise.allSettled(this.jobs.values());
    try {
      if (this.runtime) await this.runtime.close();
      else await this.offlineHistory?.close();
    } finally {
      this.store.close();
    }
  }
}
