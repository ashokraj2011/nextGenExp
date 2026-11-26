import { domainPackIds } from "../../packages/contracts/domain-packs";
import { domainMemberships, serverTenantId, tenantCookie, tenantDataDirectory } from "./tenant";
import { flowOverridesSchema, flowScopeSchema, type FlowScope } from "../../packages/contracts/routing-flows";
import { recordIntentOption, layoutTargetDomain, uiDesignSchema, uiLayoutChangeSchema } from "../../packages/contracts/ui-layout";
import { widgetGenerateRequestSchema, widgetLibraryChangeSchema } from "../../packages/contracts/widget";
import { previewUiLayout, uiTargetOptions, validateUiDesign } from "./ui-layouts";
import { Customer360Service } from "./customer-360";
import { dataBindingKeySchema } from "../../packages/contracts/data-bindings";
import { customer360ProfileInputSchema, type Customer360AdminRecord } from "../../packages/contracts/customer-360";
import {
  managedContentInputSchema,
  managedIntentInputSchema,
  managedNbaRuleInputSchema,
  type ExperienceRegistryView,
} from "../../packages/contracts/experience-registry";
import {
  CustomerProfileStore,
  getActiveCustomerProfileStore,
  getActiveEquityLedger,
  setActiveCustomerProfileStore,
  setActiveEquityLedger,
} from "../../packages/customer-profiles";
import {
  ExperienceRegistryStore,
  getActiveExperienceRegistryStore,
  setActiveExperienceRegistryStore,
} from "../../packages/experience-registry";
import { activeContexts } from "../../packages/ts-adapter";
import { compileDynamicCanvas } from "../../packages/experience/compile";
import { generateWidgetFromMultimodal } from "./dynamic-ui-generator";
import { generateBoundUiLayoutWithLlm } from "./ui-layout-generator";
import { OpsIncidentStore } from "./ops-store";
import { incidentDecisionInputSchema, incidentUpsertInputSchema } from "../../packages/contracts/ops";
import { SalesDealStore } from "./sales-store";
import { dealDecisionInputSchema, dealUpsertInputSchema } from "../../packages/contracts/sales";
import { ConnectorStore } from "./connector-store";
import { connectorInvokeInputSchema, connectorUpsertSchema } from "../../packages/contracts/connector";
import { ApprovalStore } from "./approval-store";
import { approvalDecisionInputSchema, approvalPolicySettingsSchema, type ApprovalRecord } from "../../packages/contracts/approval";
import { TradeStore, type SettlementCallback } from "./trade-store";
import { taxHarvestPreviewInputSchema, tradeJobCreateInputSchema, type TradeLegInput } from "../../packages/contracts/trading";
import { ActionFlowStore } from "./action-flow-store";
import { actionFlowUpsertSchema } from "../../packages/contracts/action-flow";
import { WorkflowEngine } from "./workflow-engine";
import { workflowDefinitionUpsertSchema } from "../../packages/contracts/workflow-definition";
import { generateWorkflowWithLlm } from "./workflow-generator";
import { discoverMcpServer, importMcpToolAsConnector } from "./mcp-discovery";
import { mcpDiscoverRequestSchema, mcpImportRequestSchema } from "../../packages/contracts/mcp-discovery";
import { ProactiveEventStore } from "./proactive-engine";
import { proactiveTriggerInputSchema } from "../../packages/contracts/proactive-events";
import { KnowledgeBaseStore } from "./knowledge-base";
import { knowledgeDocumentUpsertSchema } from "../../packages/contracts/knowledge-base";
import { ScheduledJobStore } from "./scheduled-jobs";
import { scheduledJobUpsertSchema } from "../../packages/contracts/scheduled-jobs";
import { VerticalPackStore } from "./vertical-factory";
import { PiiFirewallStore, registerLlmEgressContext, scrubWithPiiFirewall, unregisterLlmEgressContext } from "./pii-firewall";
import { CepTelemetry } from "./telemetry";
import { migrateLegacyConnectors } from "./connector-migration";
import { HandoffStore } from "./handoff-store";
import { createHandoffInputSchema } from "../../packages/contracts/handoff";
import { buildA2aAgentCard, handleCepMcpRequest } from "./cep-mcp-server";
import { agUiRunInputSchema, streamAgUiRun } from "./ag-ui";
import { piiFirewallConfigSchema } from "../../packages/contracts/pii-firewall";
import { UxEvolutionStore } from "./ux-evolution";
import { extractDocumentAction } from "./document-extractor";
import { OmnichannelStore } from "./omnichannel-store";
import { omnichannelConfigSchema } from "../../packages/contracts/omnichannel";
import { EvalRunnerStore } from "./eval-runner";
import { renderCepEmbedSdkScript, renderHostPortalDemoHtml } from "./embed-sdk";
import { WriteAuditStore } from "./write-audit";
import { recommendationArbitrateToolRef } from "../../packages/contracts/recommendation-provider";
import { checkGatewayCapacity, connectorInvokeToolRef, domainWriteToolRef, Runtime, sfieldNamespace } from "./runtime";
import { WidgetLibraryStore } from "./widget-library";
import { SelfServicePznStore } from "./self-service-pzn-store";
import { IntegrationTaskError, IntegrationTaskService, IntegrationTaskStore } from "./integration-tasks";
import { createDemoMcpServer } from "./integration-mcp";
import { draftValidateRequestSchema, integrationCopilotRequestSchema, integrationMcpDiscoverRequestSchema, runTaskRequestSchema } from "../../packages/contracts/integration-task";
import { runIntegrationCopilot } from "./integration-copilot";
import { runSelfServicePznCopilot } from "./self-service-pzn-copilot";
import { applyPznOperationDirect, PznApprovalError, pznGateFor, pznToolRefForOperation, requestPznApproval, verifyPznApproval } from "./pzn-approvals";
import {
  pznAttributeInputSchema,
  pznContextInputSchema,
  pznCopilotRequestSchema,
  pznNamespaceInputSchema,
  pznRegisteredSfieldTools,
  pznRuleInputSchema,
  pznRuleTestRequestSchema,
  pznSfieldToolRefs,
  pznSlugSchema,
  pznTextContentInputSchema,
  pznTsEvaluateRequestSchema,
} from "../../packages/contracts/self-service-pzn";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { capabilityIdSchema, capabilityRef, customerEventSchema, versionSchema, type ExecutionBudget } from "../../packages/contracts/agentic";
import { capabilityTools } from "../../packages/capabilities";
import { CapabilityRegistry } from "./capability-registry";
import { simulateCustomerEvent } from "./event-simulator";
import { makeId } from "../../packages/experience/compile";
import { ChatHarness, newId } from "@sfield/core";
import { SqlitePersistence } from "@sfield/store-sqlite";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, extname, sep } from "node:path";
import type { AddressInfo } from "node:net";
import type { ViteDevServer } from "vite";
import { z } from "zod";
import demo from "../../fixtures/host.json";
import type { Bootstrap, Conversation, TurnView } from "../../packages/contracts/api";
import type { SelectionMode } from "../../packages/contracts/domain";
import { actionBody, conversationChangeBody, createBody, eventBody, idPattern, messageBody, previewFundingBody, retryBody } from "../../packages/contracts/http-inputs";
import { accountPortalPath, pendingActionsContext, workspacePinsSchema, type PortalFundingView } from "../../packages/contracts/workspace";
import { adminPaths, isAdminPath } from "../../packages/contracts/admin-paths";
import { mockCcreRuleSchema, toolSetupSchema, treatmentPreviewSchema } from "../../packages/contracts/tool-setup";
import { tsFixtures } from "../../packages/ts-adapter";
import { fixturePortfolioHistory, fixturePortfolioSnapshotProvider, type PortfolioSnapshotProvider } from "../../packages/portfolio-snapshot";
import { fixtureGoalProgressProvider, type GoalProgressProvider } from "../../packages/goal-progress";
import type { GatewaySettings } from "./gateway";
import { ApiError, Store, presentConversation } from "./store";
import { ExperienceService } from "./service";
import { addCcreRule, previewTreatmentSelector, toolSetupTag, toolSetupView, validateToolSetup } from "./tool-setup";
import { readWorkspacePendingActions } from "./workspace-actions";

import { operatorAccess } from "./operator-access";
import { configDigest, GatewayConfigStore, gatewayConfigSchema, mergeStoredKey, testGatewayConfig } from "./gateway-config";

type Options = {
  operators?: Record<string, string>;
  /**
   * "off" skips the operator sign-in prompt for local demos: requests without credentials act as `local-operator`.
   * The server only answers on 127.0.0.1/localhost, and a signed-in operator still wins (so dual control can be tested).
   */
  operatorAuth?: "on" | "off";
  /** Called after a gateway configuration is activated or reset; main.ts restarts the app in-process. */
  onGatewayActivated?: () => void;
  launchGatewaySource?: "environment" | "default";
  dataDir: string;
  gateway: GatewaySettings | null;
  projectRoot: string;
  port?: number;
  dev?: boolean;
  startScheduledJobs?: boolean;
  piiEnabledByDefault?: boolean;
  selectionMode?: SelectionMode;
  inspectorEnabled?: boolean;
  portfolioSnapshots?: PortfolioSnapshotProvider;
  goalProgressProvider?: GoalProgressProvider;
  goalBudget?: ExecutionBudget;
};
const beneficiaryStatusSchema = z.enum(["missing", "on_file"]);
const accountFundingStatusSchema = z.enum(["funded", "unfunded"]);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
};
const pagePaths = new Set(["/", "/chat", "/wealth", "/it-ops", "/revops", "/recommendations", "/integrations", "/embed", "/login", "/planning", accountPortalPath, ...Object.values(adminPaths)]);

function visibleTurn(turn: TurnView, operator?: string): TurnView {
  if (operator) return turn;
  const { semanticRoute, customerLookup, providerArbitration, piiRedaction, ...customerTurn } = turn;
  return customerTurn;
}

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body<S extends z.ZodTypeAny>(req: IncomingMessage, schema: S, limit = 12 * 1024): Promise<z.output<S>> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
    throw new ApiError(415, "unsupported_content_type", "Send an application/json request.");
  }

  if (Number(req.headers["content-length"]) > limit) throw new ApiError(413, "request_too_large", "This request is too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw new ApiError(413, "request_too_large", "This request is too large.");
    }
    chunks.push(chunk);
  }

  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
    throw new ApiError(400, "invalid_json", "The request could not be read.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_input", "Check the request fields and try again.");
  return parsed.data;
}

async function serveAsset(pathname: string, root: string, res: ServerResponse) {
  if (!pagePaths.has(pathname) && !pathname.startsWith("/assets/")) {
    throw new ApiError(404, "not_found", "This page is unavailable.");
  }
  const path = resolve(root, "." + (pathname.startsWith("/assets/") ? decodeURIComponent(pathname) : "/index.html"));
  if (!path.startsWith(root + sep)) throw new ApiError(404, "not_found", "This file is unavailable.");
  if (!await stat(path).then((entry) => entry.isFile(), () => false)) {
    throw new ApiError(503, "build_unavailable", "Build the web app before starting this server.");
  }
  const framePolicy = pathname === "/embed"
    ? "frame-ancestors 'self' http://127.0.0.1:* http://localhost:* https:"
    : "frame-ancestors 'none'";
  res.writeHead(200, {
    "Content-Type": MIME[extname(path)] ?? "application/octet-stream",
    "Cache-Control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store",
    "Content-Security-Policy": `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; ${framePolicy}`,
  });
  res.end(await readFile(path));
}

export async function startApp(options: Options) {
  options = { ...options, dataDir: tenantDataDirectory(options.dataDir) };
  const membership = domainMemberships();
  const now = Date.now;
  const widgetLibraries = {
    wealth: new WidgetLibraryStore(options.dataDir),
    it_ops: new WidgetLibraryStore(options.dataDir, "it_ops"),
    sales_revops: new WidgetLibraryStore(options.dataDir, "sales_revops"),
  };
  const widgetLibrary = widgetLibraries.wealth;
  const selfServicePzn = new SelfServicePznStore(options.dataDir);
  const integrationTasks = new IntegrationTaskStore(options.dataDir);
  const profileStore = new CustomerProfileStore(options.dataDir);
  setActiveCustomerProfileStore(profileStore);
  const experienceRegistry = new ExperienceRegistryStore(options.dataDir);
  setActiveExperienceRegistryStore(experienceRegistry);
  const customer360 = new Customer360Service(options.dataDir);
  const selectionMode = options.selectionMode ?? "semantic_rerank";
  const inspectorEnabled = options.inspectorEnabled ?? true;
  const identifyOperator = operatorAccess(options.dataDir, options.operators);
  if (options.operatorAuth === "off" && process.env.NODE_ENV === "production") {
    throw new Error("PZN_OPERATOR_AUTH=off is for local demos only and is refused under NODE_ENV=production.");
  }
  const localOperator = options.operatorAuth === "off" ? "local-operator" : undefined;
  const gatewayConfig = new GatewayConfigStore(options.dataDir);
  const profile = options.gateway?.profile;
  const providerCookie = profile === "openai" ? "pzn_openai_session" : profile === "copilot_acp" ? "pzn_copilot_session" : "pzn_session";
  const sessionCookie = tenantCookie(providerCookie);
  const sessionPattern = new RegExp("(?:^|;\\s*)" + sessionCookie + "=(local_[a-f0-9]{32})(?:;|$)");
  const portfolioSnapshots = options.portfolioSnapshots ?? fixturePortfolioSnapshotProvider;
  const goalProgressProvider = options.goalProgressProvider ?? fixtureGoalProgressProvider;
  async function loadBootstrapPersonas(principalId: string, allowed: (id: string) => boolean, selected?: string): Promise<Bootstrap["personas"]> {
    return Promise.all(profileStore.list().filter(({ personaId }) => allowed(personaId)).map(async ({
      personaId, displayName, allowedScenarios, beneficiaryStatus, accountFundingStatus, syntheticMid,
    }) => {
      const [portfolio, homeGoal] = await Promise.all([
        (personaId === selected ? portfolioSnapshots : fixturePortfolioSnapshotProvider).read(syntheticMid),
        (personaId === selected ? goalProgressProvider : fixtureGoalProgressProvider).read(syntheticMid),
      ]);
      const confirmation = store.axe.portalConfirmation(syntheticMid);
      return {
        personaId, displayName, allowedScenarios,
        pins: store.workspacePins(principalId, personaId),
        profile: {
          beneficiaryStatus: beneficiaryStatusSchema.parse(beneficiaryStatus),
          accountFundingStatus: accountFundingStatusSchema.parse(
            store.axe.fundingStatus({ principalId, personaId }) ?? accountFundingStatus,
          ),
          ...(confirmation && { firstDepositConfirmedAt: confirmation.occurredAt }),
          cashCents: portfolio?.cashCents ?? null,
        },
        overview: { portfolio, homeGoal, portfolioHistory: fixturePortfolioHistory(syntheticMid) },
      };
    }));
  }
  function listAdminCustomers(principalId: string): Customer360AdminRecord[] {
    return profileStore.list().map((entry) => {
      const effectiveFunding = store.axe.fundingStatus({ principalId, personaId: entry.personaId }) ?? entry.accountFundingStatus;
      const evaluated = customer360.evaluate({
        principalId,
        personaId: entry.personaId,
        fundingStatus: effectiveFunding === "funded" ? "funded" : "unfunded",
        excludePromotions: false,
      });
      return {
        ...entry,
        isBuiltIn: profileStore.isBuiltIn(entry.personaId),
        isCustomized: profileStore.isCustomized(entry.personaId),
        dismissedNbaIds: [...customer360.dismissedIds(principalId, entry.personaId)],
        lookup: evaluated.lookup,
        nba: evaluated.nba,
      };
    });
  }
  function buildExperienceRegistryView(): ExperienceRegistryView {
    const layouts = store.publishedUiLayouts("wealth");
    const publishedIntentIds = new Set(
      layouts.flatMap((l) => l.design.targets.filter((t) => t.kind === "intent").map((t) => t.id)),
    );
    const contexts = activeContexts.map((ctx) => ({
      contextId: ctx.contextId,
      displayName: ctx.displayName,
      description: ctx.description,
      active: ctx.active,
      baseContentIds: [...(tsFixtures.base[ctx.contextId] ?? [])],
    }));
    const intents = experienceRegistry.listIntents().map((item) => ({
      ...item,
      tsContentIds: [...(tsFixtures.base[item.contextId] ?? [])],
      hasPublishedLayout: publishedIntentIds.has(item.intentId),
    }));
    const content = experienceRegistry.listContent().map(({ input, rawEntry, isBuiltIn, isCustomized }) => ({
      ...input,
      version: rawEntry.version,
      isBuiltIn,
      isCustomized,
      linkedContexts: Object.entries(tsFixtures.base)
        .filter(([, ids]) => ids.includes(rawEntry.contentId))
        .map(([ctxId]) => ctxId),
      rawEntry,
    }));
    return {
      contexts,
      intents,
      content,
      nbaRules: experienceRegistry.listNbaRules(),
    };
  }
  const store = new Store(join(options.dataDir, "app.sqlite"));
  const opsStore = new OpsIncidentStore(options.dataDir);
  const salesStore = new SalesDealStore(options.dataDir);
  const connectorStore = new ConnectorStore(options.dataDir);
  const approvalStore = new ApprovalStore(options.dataDir);
  const omnichannelStore = new OmnichannelStore(options.dataDir);
  approvalStore.setOnCreated((record) => {
    const port = (server.address() as AddressInfo | null)?.port ?? options.port ?? 4180;
    omnichannelStore.notifyApprovalSync(record, `http://127.0.0.1:${port}`);
  });
  const actionFlowStore = new ActionFlowStore(options.dataDir);
  const workflowEngine = new WorkflowEngine(options.dataDir, { approvalStore, connectorStore });
  const proactiveStore = new ProactiveEventStore(options.dataDir);
  const knowledgeBase = new KnowledgeBaseStore(options.dataDir);
  const verticalFactory = new VerticalPackStore(options.dataDir);
  const piiFirewall = new PiiFirewallStore(options.dataDir, options.piiEnabledByDefault);
  const telemetry = new CepTelemetry(options.dataDir);
  registerLlmEgressContext(options.dataDir, {
    piiFirewall,
    telemetry,
    getKnownNames: () => profileStore.list().map((p) => p.displayName),
  });
  const uxEvolution = new UxEvolutionStore(options.dataDir);
  const evalRunner = new EvalRunnerStore(options.dataDir);
  const handoffStore = new HandoffStore(options.dataDir);
  const tradeStore = new TradeStore(options.dataDir, profileStore);
  const scheduledJobs = new ScheduledJobStore(options.dataDir, {
    profileStore, tradeStore, opsStore, salesStore, proactiveStore,
  });
  if (options.startScheduledJobs !== false) scheduledJobs.startTicker();
  setActiveEquityLedger(tradeStore);
  const writeAudit = new WriteAuditStore(options.dataDir);
  store.setDomainBindingContext((id) => ({ incident: opsStore.findById(id), deal: salesStore.list().find((deal) => deal.id === id) }));
  const registry = new CapabilityRegistry(store);
  const sfieldPath = join(options.dataDir, "sfield.sqlite");
  const offline = options.gateway ? undefined : new SqlitePersistence({ path: sfieldPath });
  let runtime: Runtime | null;
  try {
    runtime = options.gateway
      ? await Runtime.open(store, sfieldPath, options.gateway, now, inspectorEnabled, portfolioSnapshots, goalProgressProvider, options.goalBudget, {
          customer360, opsStore, salesStore, profileStore, writeAudit, connectorStore, selfServicePzn, approvalStore, integrationTasks, piiFirewall, telemetry,
        })
      : null;
    await offline?.init({ namespace: sfieldNamespace, ownerId: newId("owner") });
  } catch (error) {
    store.close();
    throw error;
  }
  const makeTradeSettler = (principalId: string): SettlementCallback => async (settlement) => {
    const toDollars = (cents: number) => (Math.max(0, cents) / 100).toFixed(2);
    const profile = profileStore.findByPersonaId(settlement.personaId);
    const nextAvailable = Math.max(0, (profile?.availableBalanceCents ?? settlement.nextCashCents) + settlement.cashDeltaCents);
    const nextCurrent = Math.max(0, (profile?.currentBalanceCents ?? settlement.nextCashCents) + settlement.cashDeltaCents);
    const updates: Record<string, string> = {
      "portfolio.cash": toDollars(settlement.nextCashCents),
      "portfolio.equities": toDollars(settlement.nextEquityCents),
      "balances.available": toDollars(nextAvailable),
      "balances.current": toDollars(nextCurrent),
    };
    if (runtime) {
      const governed = await runtime.executeGovernedWrite(principalId, {
        domain: "customer360",
        recordId: settlement.personaId,
        action: "settle_stock_trade",
        actor: settlement.actor,
        note: settlement.summary,
        updates,
        ...(settlement.approvalId ? { approvalId: settlement.approvalId } : {}),
      }, AbortSignal.timeout(5000));
      return { sfieldRunId: governed.sfieldRunId, auditId: governed.audit?.auditId };
    }
    profileStore.applyBindings(settlement.personaId, updates, now());
    const audit = writeAudit.record({
      sfieldRunId: "offline",
      sfieldToolRef: domainWriteToolRef,
      domain: "stock_trade",
      recordId: settlement.personaId,
      action: "settle_stock_trade",
      actor: settlement.actor,
      summary: settlement.summary,
      status: "succeeded",
      ...(settlement.approvalId ? { approvalId: settlement.approvalId } : {}),
    });
    return { sfieldRunId: "offline", auditId: audit.auditId };
  };
  tradeStore.reconcilePendingJobs(makeTradeSettler("system-reconcile"));

  const integrationService = new IntegrationTaskService(integrationTasks, approvalStore, () => runtime);
  workflowEngine.setIntegrationService(integrationService);
  const experience = new ExperienceService(store, runtime, selectionMode, now, inspectorEnabled, offline && {
    chat: new ChatHarness(offline), close: () => offline.close(),
  }, {
    isTenantAdmin: membership.isTenantAdmin,
    gateway: options.gateway, dataDir: options.dataDir, customer360, portfolioSnapshots, goalProgressProvider,
    opsStore, salesStore, connectorStore, approvalStore, tradeStore, actionFlowStore, workflowEngine, knowledgeBase, widgetLibraries, piiFirewall,
    integrationService, onTradeSettle: makeTradeSettler,
  });

  const demoMcp = createDemoMcpServer();

  function enforceEvalGate(actionLabel: string) {
    if (!approvalStore.getPolicy().requireEvalBeforePublish) return;
    const latest = evalRunner.view().latest;
    if (!latest) {
      throw new ApiError(409, "eval_gate_failed", `Pre-publish compliance eval gate is enabled. Run the Guardrail Eval Suite (/admin/logs?source=evals) and achieve 100% pass before ${actionLabel}.`);
    }
    if (latest.releaseGate !== "ready_to_publish") {
      throw new ApiError(409, "eval_gate_failed", `Latest Guardrail Eval (${latest.runId}) is blocked (${latest.passedCases}/${latest.totalCases} passed, ${latest.criticalFailures} critical). Fix failures before ${actionLabel}.`);
    }
  }

  async function executeApprovedRecord(principalId: string, record: ApprovalRecord) {
    if (record.targetKind === "task_publish") {
      const ref = typeof record.payload.ref === "string" ? record.payload.ref : record.recordId;
      const claim = approvalStore.claimForExecution(record.id);
      if (!claim.ok) throw new ApiError(409, claim.code, claim.message);
      try {
        const published = await integrationService.publish(ref);
        const summary = `Published integration task ${published.contract.ref} via ${published.sfieldRoute}`;
        const audit = writeAudit.record({
          sfieldRunId: "task_publish",
          sfieldToolRef: record.sfieldToolRef,
          domain: "integration",
          recordId: published.contract.ref,
          action: "publish_task",
          actor: record.decidedBy ?? record.requester,
          summary,
          status: "succeeded",
          approvalId: record.id,
        });
        const finalRecord = approvalStore.markExecuted(record.id, { summary, sfieldRunId: published.sfieldRoute, auditId: audit.auditId }) ?? record;
        return { approval: finalRecord, execution: { ...published, summary, auditId: audit.auditId } };
      } catch (err) {
        approvalStore.releaseClaim(record.id);
        const code = err instanceof IntegrationTaskError ? err.code : "task_publish_failed";
        throw new ApiError(409, code, err instanceof Error ? err.message : "Could not publish integration task.");
      }
    }
    if (record.targetKind === "integration_task") {
      try {
        const out = await integrationService.resume(record, principalId);
        await workflowEngine.resumeAfterTaskApproval(record.id, out.run, true, record.decidedBy ?? record.requester);
        return { approval: out.approval, execution: out.execution, taskRun: out.run };
      } catch (err) {
        const code = err instanceof IntegrationTaskError ? err.code : "integration_task_failed";
        throw new ApiError(409, code, err instanceof Error ? err.message : "Integration task failed");
      }
    }
    if (record.targetKind === "pzn_change") {
      const args = (record.payload.args && typeof record.payload.args === "object" ? record.payload.args : {}) as Record<string, unknown>;
      const operation = record.action;
      const claim = approvalStore.claimForExecution(record.id);
      if (!claim.ok) throw new ApiError(409, claim.code, claim.message);
      try {
        if (runtime) {
          const exec = await runtime.executePznTool(principalId, pznToolRefForOperation(operation), operation, { ...args, approvalId: record.id });
          const finalRecord = approvalStore.markExecuted(record.id, { summary: exec.summary, sfieldRunId: exec.sfieldRunId }) ?? record;
          return { approval: finalRecord, execution: { summary: exec.summary, sfieldRunId: exec.sfieldRunId } };
        }
        const verifiedArgs = verifyPznApproval(approvalStore, selfServicePzn, operation, { ...args, approvalId: record.id });
        const summary = applyPznOperationDirect(selfServicePzn, operation, verifiedArgs);
        const audit = writeAudit.record({
          sfieldRunId: "offline",
          sfieldToolRef: record.sfieldToolRef,
          domain: "pzn_self_service",
          recordId: record.recordId,
          action: operation,
          actor: record.decidedBy ?? record.requester,
          summary,
          status: "succeeded",
          approvalId: record.id,
        });
        const finalRecord = approvalStore.markExecuted(record.id, { summary, sfieldRunId: "offline", auditId: audit.auditId }) ?? record;
        return { approval: finalRecord, execution: { summary, sfieldRunId: "offline", auditId: audit.auditId } };
      } catch (err) {
        // Local store operations either commit or throw, so a failure here means nothing was applied; allow a retry.
        approvalStore.releaseClaim(record.id);
        const code = err instanceof PznApprovalError ? err.code : "pzn_change_failed";
        throw new ApiError(409, code, `Approved, but the change could not be applied: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }
    if (record.targetKind === "workflow_step") {
      const runId = typeof record.payload.runId === "string" ? record.payload.runId : record.recordId;
      const actor = record.decidedBy ?? record.requester;
      const resumed = await workflowEngine.resumeAfterApproval(runId, record.id, true, actor);
      const summary = `Approved workflow step "${record.action}" → run ${runId} is now ${resumed?.status ?? "resumed"}`;
      const audit = writeAudit.record({
        sfieldRunId: runId,
        sfieldToolRef: record.sfieldToolRef,
        domain: "workflow",
        recordId: runId,
        action: record.action,
        actor,
        summary,
        status: "succeeded",
        approvalId: record.id,
      });
      const finalRecord = approvalStore.markExecuted(record.id, {
        summary,
        sfieldRunId: runId,
        auditId: audit.auditId,
      }) ?? record;
      return { approval: finalRecord, workflowRun: resumed, execution: { summary, sfieldRunId: runId, auditId: audit.auditId } };
    }
    if (record.targetKind === "stock_trade") {
      const legs = Array.isArray(record.payload.legs) ? (record.payload.legs as TradeLegInput[]) : [];
      const personaId = typeof record.payload.personaId === "string" ? record.payload.personaId : record.recordId;
      const taxHarvestAnalyzed = Boolean(record.payload.taxHarvestAnalyzed);
      const actor = record.decidedBy ?? record.requester;
      const job = tradeStore.startTradeJob(
        { personaId, actor, legs, taxHarvestAnalyzed, durationSeconds: 5 },
        makeTradeSettler(principalId),
        record.id,
      );
      const summary = `Approved trade bundle queued as ${job.jobId} (${legs.map((l) => `${l.side.toUpperCase()} ${l.shares} ${l.symbol}`).join(" + ")})`;
      const finalRecord = approvalStore.markExecuted(record.id, {
        summary,
        sfieldRunId: job.jobId,
        jobId: job.jobId,
      }) ?? record;
      return { approval: finalRecord, job, execution: { summary, sfieldRunId: job.jobId, jobId: job.jobId } };
    }
    if (record.targetKind === "external_connector") {
      const action = record.action;
      const actor = record.decidedBy ?? record.requester;
      const payload = record.payload;
      if (runtime) {
        const exec = await runtime.executeConnectorInvoke(principalId, {
          connectorId: record.recordId,
          action,
          actor,
          payload,
          approvalId: record.id,
        }, AbortSignal.timeout(8000));
        const finalRecord = approvalStore.markExecuted(record.id, {
          summary: exec.summary,
          sfieldRunId: exec.sfieldRunId,
          ...(exec.audit?.auditId ? { auditId: exec.audit.auditId } : {}),
          statusCode: exec.statusCode,
          responsePreview: exec.responsePreview,
        }) ?? record;
        return { approval: finalRecord, execution: exec };
      }
      const exec = await connectorStore.invokeConnector(record.recordId, { action, actor, payload }, AbortSignal.timeout(8000));
      const audit = writeAudit.record({
        sfieldRunId: "offline",
        sfieldToolRef: connectorInvokeToolRef,
        domain: "external_connector",
        recordId: exec.connectorId,
        action,
        actor,
        summary: exec.summary,
        status: "succeeded",
        approvalId: record.id,
      });
      const finalRecord = approvalStore.markExecuted(record.id, {
        summary: exec.summary,
        sfieldRunId: "offline",
        auditId: audit.auditId,
        statusCode: exec.statusCode,
        responsePreview: exec.responsePreview,
      }) ?? record;
      return { approval: finalRecord, execution: { ...exec, sfieldRunId: "offline", auditId: audit.auditId } };
    }

    if (typeof record.payload.expectedUpdatedAt === "string") {
      const current = record.domain === "ops_incident" ? opsStore.findById(record.recordId) : salesStore.list().find((d) => d.id === record.recordId);
      if (current?.updatedAt !== record.payload.expectedUpdatedAt) throw new ApiError(409, "stale_approval", "The record changed. Review it again before approving.");
    }
    const domain = record.domain as "ops_incident" | "sales_deal" | "customer360";
    const actor = record.decidedBy ?? record.requester;
    const note = typeof record.payload.note === "string" ? record.payload.note : record.comment;
    const updates = record.payload.updates && typeof record.payload.updates === "object"
      ? (record.payload.updates as Record<string, string>)
      : undefined;
    if (runtime) {
      const governed = await runtime.executeGovernedWrite(principalId, {
        domain,
        recordId: record.recordId,
        action: record.action,
        actor,
        ...(note ? { note } : {}),
        ...(updates ? { updates } : {}),
        approvalId: record.id,
      }, AbortSignal.timeout(5000));
      const finalRecord = approvalStore.markExecuted(record.id, {
        summary: governed.summary,
        sfieldRunId: governed.sfieldRunId,
        ...(governed.audit?.auditId ? { auditId: governed.audit.auditId } : {}),
      }) ?? record;
      return { approval: finalRecord, execution: governed };
    }
    let summary = `${record.action} applied to ${record.recordId}`;
    if (domain === "ops_incident") {
      const updated = opsStore.decide(record.recordId, {
        decision: record.action as "approve_rollback" | "reject_rollback" | "resolve" | "escalate",
        actor,
        ...(note ? { note } : {}),
      });
      if (!updated) throw new ApiError(404, "not_found", "Incident not found.");
      summary = `${updated.id} → ${updated.status} (error rate ${updated.errorRatePct}%, p95 ${updated.p95LatencyMs}ms)`;
    } else if (domain === "sales_deal") {
      const updated = salesStore.decide(record.recordId, {
        decision: record.action as "approve_discount" | "reject_discount" | "advance_stage",
        actor,
        ...(note ? { note } : {}),
      });
      if (!updated) throw new ApiError(404, "not_found", "Deal not found.");
      summary = `${updated.id} (${updated.accountName}) → ${updated.stage} (${updated.discountStatus}, ${updated.winProbabilityPct}% prob.)`;
    } else if (updates) {
      const applied = profileStore.applyBindings(record.recordId, updates, now());
      if (!applied.updatedFields.length) throw new ApiError(422, "fields_not_saved", "Check the fields and values, then save again.");
      summary = `Updated Customer 360 bindings: ${applied.updatedFields.join(", ")}`;
    }
    const audit = writeAudit.record({
      sfieldRunId: "offline",
      sfieldToolRef: domainWriteToolRef,
      domain,
      recordId: record.recordId,
      action: record.action,
      actor,
      summary,
      status: "succeeded",
      approvalId: record.id,
    });
    const finalRecord = approvalStore.markExecuted(record.id, {
      summary,
      sfieldRunId: "offline",
      auditId: audit.auditId,
    }) ?? record;
    return { approval: finalRecord, execution: { summary, sfieldRunId: "offline", audit } };
  }
  let vite: ViteDevServer | undefined;
  const streams = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return res.end();
      const failure = error instanceof ApiError ? error : new ApiError(500, "server_error", "Something went wrong. Please try again.");
      json(res, { code: failure.code, message: failure.message }, failure.status);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const port = (server.address() as AddressInfo).port;
    const host = req.headers.host;
    if (host !== "127.0.0.1:" + port && host !== "localhost:" + port) {
      throw new ApiError(403, "origin_unavailable", "Use the local demo address.");
    }
    const origin = "http://" + host;
    const url = new URL(req.url ?? "/", origin);
    if (url.origin !== origin) throw new ApiError(403, "origin_unavailable", "Use the local demo address.");
    const { pathname } = url;
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const operator = inspectorEnabled ? identifyOperator(req, res) ?? localOperator : undefined;
    const requireOperator = () => {
      if (!inspectorEnabled) throw new ApiError(404, "not_found", "This page is unavailable.");
      if (!operator) {
        res.setHeader("WWW-Authenticate", 'Basic realm="Workspace administration", charset="UTF-8"');
        throw new ApiError(401, "operator_required", "Sign in with your operator account.");
      }
      return operator;
    };
    const customerSession = membership.restricted && !operator;
    let selectedProfile: string | undefined;
    const requireChatDomain = (domain: Conversation["domainId"], persona: string) => {
      if (domain !== "wealth") requireOperator();
      if (domain === "wealth" && customerSession && selectedProfile !== persona) throw new ApiError(403, "profile_required", "Choose this profile on the sign-in page.");
      if (!membership.chat(domain, persona, operator)) throw new ApiError(403, "domain_access_denied", "This user does not have access to the chat domain.");
    };
    const isThreadUser = (thread: Conversation) => thread.domainId === "wealth" ? (!customerSession || thread.userId === selectedProfile) : thread.userId === operator;
    const requireThread = (thread: Conversation) => {
      requireChatDomain(thread.domainId, thread.personaId);
      if (!isThreadUser(thread)) throw new ApiError(404, "not_found", "This chat is unavailable.");
    };
    const authoringDomain = () => {
      const parsed = z.enum(domainPackIds).safeParse(url.searchParams.get("domain") ?? "wealth");
      if (!parsed.success) throw new ApiError(400, "domain_invalid", "Choose an available domain.");
      const actor = requireOperator();
      if (!membership.authoring(actor).includes(parsed.data)) {
        throw new ApiError(403, "domain_access_denied", "This domain is unavailable for this account.");
      }
      return parsed.data;
    };
    if (pathname === "/.well-known/agent.json" && req.method === "GET") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return json(res, buildA2aAgentCard(origin, integrationService));
    }
    if (!pathname.startsWith("/api/")) {
      if (pathname === "/it-ops" || pathname === "/revops") requireChatDomain(pathname === "/it-ops" ? "it_ops" : "sales_revops", "");
      if (isAdminPath(pathname) || ["/integrations", "/recommendations", "/it-ops", "/revops"].includes(pathname)) requireOperator();
      if ((isAdminPath(pathname) || pathname === "/help") && !inspectorEnabled) throw new ApiError(404, "not_found", "This page is unavailable.");
      if (pathname === "/sdk/cep-embed.js" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(renderCepEmbedSdkScript(origin));
        return;
      }
      if (pathname === "/embed-demo" && req.method === "GET") {
        const verticalId = url.searchParams.get("vertical");
        const verticalPack = verticalId ? verticalFactory.getPack(verticalId) : undefined;
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(renderHostPortalDemoHtml(origin, url.searchParams, verticalPack));
        return;
      }
      if (pathname === "/help" && req.method === "GET") {
        res.writeHead(308, { Location: adminPaths.help + url.search, "Cache-Control": "no-store" });
        res.end();
        return;
      }
      if (vite) {
        vite.middlewares(req, res, () => { if (!res.headersSent) res.writeHead(404).end(); });
      } else if (req.method === "GET") {
        return serveAsset(pathname, join(options.projectRoot, "dist"), res);
      } else {
        throw new ApiError(405, "method_unavailable", "This request method is unavailable.");
      }
      return;
    }
    if (req.method !== "GET" && ((req.headers.origin && req.headers.origin !== origin) || req.headers["sec-fetch-site"] === "cross-site")) {
      throw new ApiError(403, "origin_unavailable", "Use the local demo address.");
    }

    const token = req.headers.cookie?.match(sessionPattern)?.[1];
    const { id: principalId, created } = store.session(token);
    selectedProfile = store.selectedProfile(principalId);
    const viewer = { customer: selectedProfile, operator };
    if (created) res.setHeader("Set-Cookie", sessionCookie + "=" + principalId + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000");

    const [resource, id, operation, extra] = pathname.slice(5).split("/");
    if (extra !== undefined || (id && !idPattern.test(id)) || (operation && !idPattern.test(operation))) {
      throw new ApiError(404, "not_found", "This item is unavailable.");
    }
    const method = req.method;
    if (resource === "profile-options" && !id && method === "GET") {
      const profiles = profileStore.list().filter(({ personaId }) => membership.chat("wealth", personaId))
        .map(({ personaId, displayName, accountFundingStatus, syntheticMid }) => ({
          personaId, displayName, ...(!membership.restricted && { fundingStatus: store.axe.portalConfirmation(syntheticMid) ? "funded" : accountFundingStatus }),
        }));
      return json(res, { profiles });
    }
    if (resource === "profile-session" && !id && method === "POST") {
      const { personaId } = await body(req, z.object({ personaId: z.string().regex(idPattern).nullable() }).strict());
      if (personaId && (!profileStore.findByPersonaId(personaId) || !membership.chat("wealth", personaId))) {
        throw new ApiError(403, "domain_access_denied", "This profile is unavailable.");
      }
      store.selectProfile(principalId, personaId);
      return json(res, { personaId });
    }
    if (resource === "account-portal" && id === "funding" && !operation && (method === "GET" || method === "POST")) {
      const member = selectedProfile ? profileStore.findByPersonaId(selectedProfile) : undefined;
      if (!member) throw new ApiError(403, "profile_required", "Sign in to open your account.");
      requireChatDomain("wealth", member.personaId);
      if (method === "POST") {
        const expected = await body(req, z.object({ personaId: z.string().regex(idPattern) }).strict());
        if (expected.personaId !== member.personaId) throw new ApiError(409, "profile_changed", "Your signed-in account changed. Reopen the account portal.");
        if (member.accountFundingStatus === "unfunded") store.axe.confirmPortalDeposit(member.personaId, member.syntheticMid, now());
      }
      const confirmation = store.axe.portalConfirmation(member.syntheticMid);
      return json(res, { personaId: member.personaId, displayName: member.displayName,
        fundingStatus: confirmation ? "funded" : member.accountFundingStatus, confirmation } satisfies PortalFundingView);
    }
    const createChat = async (audience?: "admin") => {
      const test = audience && url.searchParams.get("scope") === "preview" ? await body(req,
        z.object({ conversation: createBody, setup: toolSetupSchema }).strict(), 768 * 1024) : undefined;
      if (test) validateToolSetup(test.setup);
      const input = test?.conversation ?? await body(req, createBody);
      const personaId = input.domainId === "wealth" ? input.personaId : requireOperator();
      requireChatDomain(input.domainId, personaId);
      const thread = experience.createConversation(principalId, personaId, input.scenarioId ?? demo.defaultScenarioId, audience, input.domainId, operator, test && { tools: test.setup });
      return json(res, { ...presentConversation(thread), turns: [] }, 201);
    };
    const internalApi = ["admin", "debug", "pzn", "approvals", "connectors", "ops", "ops-incidents", "sales", "sales-deals", "workflows", "workflow-runs", "mcp", "ag-ui"].includes(resource)
      || (resource === "integrations" && id !== "demo-mcp" && id !== "callbacks")
      || (resource === "proactive" && id === "trigger");
    if (internalApi) {
      const actor = requireOperator();
      const domainAdmin = resource === "admin" && ["routing-flows", "ui-layouts", "ui-layout-preview", "ui-layout-test", "ui-layout-generate", "widgets", "widget-generate",
        "customers", "bootstrap", "conversations", "logs", "inspector", "tools", "ccre-rules", "treatment-preview", "treatment-runs"].includes(id);
      const domainApi = domainAdmin || ["debug", "ops", "ops-incidents", "sales", "sales-deals"].includes(resource);
      if (!domainApi && !membership.isTenantAdmin(actor)) throw new ApiError(403, "tenant_admin_required", "This setting requires a tenant administrator.");
    }
    if (["ops", "ops-incidents"].includes(resource)) requireChatDomain("it_ops", "");
    if (["sales", "sales-deals"].includes(resource)) requireChatDomain("sales_revops", "");
    const adminBootstrap = resource === "admin" && id === "bootstrap" && !operation && inspectorEnabled;
    if (method === "GET" && ((resource === "bootstrap" && !id) || adminBootstrap)) {
      const intentPrompts = experienceRegistry.listIntents()
        .filter((item) => item.enabled && item.samplePhrases.length > 0)
        .map((item) => ({
          intentId: item.intentId,
          label: item.label,
          prompt: item.samplePhrases[0],
          isCustom: !item.isBuiltIn || item.isCustomized,
        }));
      const domain = url.searchParams.get("domain");
      const parsedDomain = z.enum(domainPackIds).safeParse(domain ?? "wealth");
      if (!parsedDomain.success) throw new ApiError(400, "domain_invalid", "Choose an available domain.");
      const activeDomain = parsedDomain.data;
      const personas: Bootstrap["personas"] = activeDomain === "wealth"
        ? await loadBootstrapPersonas(principalId, (personaId) => (!customerSession || personaId === selectedProfile) && membership.chat("wealth", personaId, operator), selectedProfile)
        : operator && membership.chat(activeDomain, "", operator) ? [{
          personaId: operator, displayName: operator, allowedScenarios: [demo.defaultScenarioId],
        }] : [];
      const state: Bootstrap = {
        tenantId: serverTenantId,
        ...(activeDomain === "wealth" && customerSession && !personas.length && { requiresProfile: true }),
        conversations: store.conversations(principalId, Boolean(operator), viewer).filter((conversation) =>
          (adminBootstrap || conversation.audience !== "admin")
          && ((adminBootstrap && domain === null) || conversation.domainId === activeDomain)
          && isThreadUser(conversation) && membership.chat(conversation.domainId, conversation.personaId, operator)),
        personas,
        scenarios: tsFixtures.scenarios.map(({ scenarioId, label }) => ({ scenarioId, label })),
        intentPrompts,
        defaultPersonaId: personas.find((p) => p.personaId === demo.defaultPersonaId)?.personaId ?? personas[0]?.personaId ?? "", defaultScenarioId: demo.defaultScenarioId,
        gatewayConfigured: Boolean(runtime), mode: "live", selectionMode, inspectorEnabled,
        ...(options.gateway?.profile === "openai" && { openAiModel: options.gateway.model }),
        ...(options.gateway?.profile === "copilot_acp" && { copilotModel: options.gateway.model }),
      };
      return json(res, state);
    }
    const workspacePersona = resource === "workspace" && id ? profileStore.findByPersonaId(id) : undefined;
    if (workspacePersona) {
      const { personaId } = workspacePersona;
      requireChatDomain("wealth", personaId);
      if (operation === "next-step" && method === "GET") {
        return json(res, await runtime?.workspaceNextStep(principalId, personaId) ?? null);
      }
      if (operation === pendingActionsContext && method === "GET") {
        return json(res, await readWorkspacePendingActions(store, principalId, workspacePersona, portfolioSnapshots, inspectorEnabled, now()));
      }
      if (operation === "preferences" && method === "POST") {
        const { pins } = await body(req, z.object({ pins: workspacePinsSchema }).strict());
        return json(res, store.saveWorkspacePins(principalId, personaId, pins));
      }
      if (operation === "dismiss-nba" && method === "POST") {
        const { nbaId } = await body(req, z.object({ nbaId: z.string().regex(/^nba_[a-z0-9_]{3,40}$/) }).strict());
        return json(res, { dismissed: customer360.dismiss(principalId, personaId, nbaId) });
      }
      if (operation === "apply-bindings" && method === "POST") {
        const { updates } = await body(req, z.object({
          updates: z.record(dataBindingKeySchema, z.string().max(160)),
        }).strict());
        const actor = operator ?? workspacePersona.displayName;
        if (!operator && Object.keys(updates).some((key) => !["goal.target", "customer.displayName", "customer.beneficiaryStatus"].includes(key))) {
          throw new ApiError(403, "field_read_only", "This field can only be changed by an operator.");
        }
        if (runtime) {
          const governed = await runtime.executeGovernedWrite(principalId, {
            domain: "customer360",
            recordId: personaId,
            action: "apply_bindings",
            actor,
            updates,
          }, AbortSignal.timeout(5000));
          return json(res, {
            updatedFields: governed.updatedFields,
            sfieldRunId: governed.sfieldRunId,
            auditId: governed.audit?.auditId,
          });
        }
        const applied = profileStore.applyBindings(personaId, updates, now());
        if (!applied.updatedFields.length) throw new ApiError(422, "fields_not_saved", "Check the fields and values, then save again.");
        const audit = writeAudit.record({
          sfieldRunId: "offline",
          sfieldToolRef: domainWriteToolRef,
          domain: "customer360",
          recordId: personaId,
          action: "apply_bindings",
          actor,
          summary: `Updated Customer 360 bindings: ${applied.updatedFields.join(", ") || "none"}`,
          status: "succeeded",
        });
        return json(res, { updatedFields: applied.updatedFields, auditId: audit.auditId });
      }
    }
    if (resource === "admin" && id === "telemetry" && inspectorEnabled) {
      requireOperator();
      if (!operation && method === "GET") return json(res, telemetry.view());
      if (operation === "export" && method === "GET") return json(res, telemetry.toOtlpExport());
      if (operation === "reset" && method === "POST") return json(res, telemetry.reset());
      throw new ApiError(404, "not_found", "This item is unavailable.");
    }
    if (resource === "admin" && id === "handoffs" && inspectorEnabled) {
      const actor = requireOperator();
      if (!operation && method === "GET") return json(res, handoffStore.view());
      if (operation === "claim" && method === "POST") {
        const { handoffId } = await body(req, z.object({ handoffId: z.string().min(3).max(64) }).strict());
        const ticket = handoffStore.claim(handoffId, actor);
        if (!ticket) throw new ApiError(404, "handoff_not_found", "Handoff ticket not found.");
        return json(res, { ticket, view: handoffStore.view() });
      }
      if (operation === "reply" && method === "POST") {
        const { handoffId, text } = await body(req, z.object({ handoffId: z.string().min(3).max(64), text: z.string().trim().min(1).max(2000) }).strict());
        const ticket = handoffStore.addReply(handoffId, actor, text, "agent");
        if (!ticket) throw new ApiError(404, "handoff_not_found", "Handoff ticket not found.");
        return json(res, { ticket, view: handoffStore.view() });
      }
      if (operation === "resolve" && method === "POST") {
        const { handoffId, resolutionNote } = await body(req, z.object({ handoffId: z.string().min(3).max(64), resolutionNote: z.string().max(300).optional() }).strict());
        const ticket = handoffStore.resolve(handoffId, actor, resolutionNote);
        if (!ticket) throw new ApiError(404, "handoff_not_found", "Handoff ticket not found.");
        return json(res, { ticket, view: handoffStore.view() });
      }
      throw new ApiError(404, "not_found", "This item is unavailable.");
    }
    if (resource === "handoffs" && !id && method === "POST") {
      const input = await body(req, createHandoffInputSchema, 16 * 1024);
      const profile = profileStore.findByPersonaId(input.personaId);
      const customerSnapshot: Record<string, string> = profile ? {
        Customer: profile.displayName,
        Account: profile.accountFundingStatus,
        Beneficiary: profile.beneficiaryStatus,
        ...(profile.cashCents != null ? { Cash: `$${(profile.cashCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}` } : {}),
        ...(profile.equityCents != null ? { Equities: `$${(profile.equityCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}` } : {}),
      } : {};
      let recentTranscript: Array<{ role: "user" | "assistant"; text: string }> = [];
      try {
        const conv = store.conversation(input.conversationId, principalId, viewer);
        const turns = await experience.conversationTurns(conv);
        recentTranscript = turns.slice(-5).flatMap((t) => [
          { role: "user" as const, text: t.message },
          ...(t.experience?.intro ? [{ role: "assistant" as const, text: t.experience.intro }] : []),
        ]);
      } catch { /* conversation may be external or brand new */ }
      const ticket = handoffStore.create({
        conversationId: input.conversationId,
        personaId: input.personaId,
        customerName: profile?.displayName ?? input.personaId,
        domain: input.domain,
        reason: input.reason,
        priority: input.priority,
        customerSnapshot,
        recentTranscript,
      });
      return json(res, { ticket }, 201);
    }
    if (resource === "mcp" && !id && method === "POST") {
      const actor = requireOperator();
      const out = await handleCepMcpRequest(await body(req, z.unknown(), 64 * 1024), {
        integrationService,
        knowledgeBase,
        principalId,
        operatorName: actor,
      });
      res.writeHead(out.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...out.headers });
      res.end(out.body === undefined ? "" : JSON.stringify(out.body));
      return;
    }
    if (resource === "ag-ui" && !id && method === "POST") {
      const actor = requireOperator();
      const input = await body(req, agUiRunInputSchema, 48 * 1024);
      await streamAgUiRun(res, input, {
        integrationService,
        principalId,
        operatorName: actor,
        gateway: options.gateway,
        dataDir: options.dataDir,
      });
      return;
    }
    if (resource === "memory") {
      if (!runtime) throw new ApiError(503, "sfield_runtime_required", "Connect a model gateway to enable sfield MemoryService.");
      if (!id && method === "GET") {
        const items = await runtime.listMemory(principalId);
        return json(res, { items });
      }
      if (!id && method === "POST") {
        const input = await body(req, z.object({
          kind: z.enum(["preference", "fact"]).default("preference"),
          content: z.string().trim().min(2).max(500),
          key: z.string().trim().min(1).max(64).optional(),
        }).strict());
        try {
          const item = await runtime.rememberMemory(principalId, input);
          return json(res, { item, items: await runtime.listMemory(principalId) }, 201);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Could not save memory item.";
          throw new ApiError(400, "memory_rejected", msg);
        }
      }
      if (id === "forget" && !operation && method === "POST") {
        const { id: memoryId } = await body(req, z.object({ id: z.string().trim().min(2).max(120) }).strict());
        const receipt = await runtime.forgetMemory(principalId, memoryId);
        return json(res, { receipt, items: await runtime.listMemory(principalId) });
      }
    }
    if (resource === "admin" && id === "gateway" && inspectorEnabled) {
      const actor = requireOperator();
      const restartSupported = Boolean(options.onGatewayActivated);
      const view = () => gatewayConfig.view(options.gateway, restartSupported, options.launchGatewaySource);
      const parseConfig = async () => {
        const { config } = await body(req, z.object({ config: z.record(z.string(), z.unknown()) }).strict(), 32 * 1024);
        const parsed = gatewayConfigSchema.safeParse(config);
        if (!parsed.success) throw new ApiError(400, "invalid_gateway_config", parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ").slice(0, 400));
        return mergeStoredKey(parsed.data, gatewayConfig.active());
      };
      if (!operation && method === "GET") return json(res, view());
      if (operation === "test" && method === "POST") {
        const config = await parseConfig();
        const result = await testGatewayConfig(config, { dataDir: options.dataDir, capacityCheck: checkGatewayCapacity });
        gatewayConfig.saveTest(result);
        return json(res, result);
      }
      if (operation === "activate" && method === "POST") {
        enforceEvalGate("activating a new LLM Gateway configuration");
        const config = await parseConfig();
        const last = gatewayConfig.read().lastTest;
        if (!last?.ok || last.configDigest !== configDigest(config) || Date.now() - Date.parse(last.testedAt) > 30 * 60_000) {
          throw new ApiError(409, "test_required", "Test this exact configuration successfully (within the last 30 minutes) before activating it.");
        }
        gatewayConfig.activate(config, actor);
        json(res, { activated: true, restarting: restartSupported, view: view() });
        if (restartSupported) setTimeout(() => options.onGatewayActivated?.(), 250);
        return;
      }
      if (operation === "reset" && method === "POST") {
        gatewayConfig.reset();
        json(res, { reset: true, restarting: restartSupported, view: view() });
        if (restartSupported) setTimeout(() => options.onGatewayActivated?.(), 250);
        return;
      }
      throw new ApiError(404, "not_found", "This item is unavailable.");
    }
    if (resource === "admin" && inspectorEnabled && !operation) {
      const toolSetupLimit = 768 * 1024;
      if (id === "treatment-runs" && method === "GET") {
        const query = z.object({ personaId: z.string().regex(idPattern), context: z.string().regex(idPattern),
          turn: z.string().regex(idPattern).optional() }).safeParse(Object.fromEntries(url.searchParams));
        if (!query.success) throw new ApiError(400, "invalid_query", "Choose a customer and topic.");
        const { personaId, context, turn } = query.data;
        requireChatDomain("wealth", personaId);
        return json(res, store.treatmentRuns(principalId, viewer, personaId, context, turn));
      }
      if (id === "pending-action-logs" && method === "GET") return json(res, store.workspaceActionLogs(principalId));
      if (id === "conversations" && method === "POST") {
        return createChat("admin");
      }
      if (id === "ui-layouts" && method === "GET") {
        const actor = requireOperator();
        const domains = membership.authoring(actor);
        const visibleDomains = membership.library(actor);
        return json(res, {
          tenantId: serverTenantId, domains,
          layouts: store.listUiLayouts(principalId, actor).filter((layout) => domains.includes(layout.domainId)),
          library: store.publishedUiLayouts().filter((layout) => visibleDomains.includes(layout.domainId)),
          targets: [...uiTargetOptions(registry, principalId), ...store.publishedUiLayouts().flatMap(({ design }) =>
            design.recordIntent ? [recordIntentOption(design.recordIntent)] : [])].filter(({ target }) => visibleDomains.includes(layoutTargetDomain(target))),
        });
      }
      if (id === "ui-layouts" && method === "POST") {
        const change = await body(req, uiLayoutChangeSchema, 32 * 1024);
        const actor = requireOperator();
        if (change.operation !== "unpublish") {
          const domain = change.domainId ?? ("id" in change ? store.listUiLayouts(principalId, actor).find((layout) => layout.id === change.id)?.domainId : undefined) ?? "wealth";
          validateUiDesign(change.design, uiTargetOptions(registry, principalId), change.operation === "publish", change.operation === "publish" ? domain : undefined);
        }
        return json(res, store.changeUiLayout(principalId, actor, membership.authoring(actor), change, now()));
      }
      if (id === "ui-layout-preview" && method === "POST") {
        const previewBody = await body(req, z.union([
          z.object({ design: uiDesignSchema, personaId: z.string().regex(idPattern).optional() }).strict(),
          uiDesignSchema,
        ]), 32 * 1024);
        const design = "design" in previewBody ? previewBody.design : previewBody;
        const personaId = "design" in previewBody ? previewBody.personaId : undefined;
        const domainId = authoringDomain();
        validateUiDesign(design, uiTargetOptions(registry, principalId), false, domainId);
        return json(res, await previewUiLayout(design, personaId, {
          domainId,
          portfolioProvider: portfolioSnapshots, goalProvider: goalProgressProvider,
          opsStore: domainId === "it_ops" ? opsStore : undefined, salesStore: domainId === "sales_revops" ? salesStore : undefined,
          incident: domainId === "it_ops" ? opsStore.primaryIncident() : undefined,
          deal: domainId === "sales_revops" ? salesStore.primaryDeal() : undefined,
        }));
      }
      if (id === "ui-layout-test" && method === "POST") {
        const domainId = authoringDomain();
        const { design, message, personaId } = await body(req, z.object({
          design: uiDesignSchema, message: z.string().trim().min(1).max(1600), personaId: z.string().regex(idPattern).optional(),
        }).strict(), 32 * 1024);
        validateUiDesign(design, uiTargetOptions(registry, principalId), true, domainId);
        const draft = { id: makeId("ui"), revision: 1, design };
        const actor = requireOperator();
        const profile = domainId === "wealth" ? personaId ?? demo.defaultPersonaId : actor;
        requireChatDomain(domainId, profile);
        const thread = experience.createConversation(principalId, profile, demo.defaultScenarioId, "admin", domainId, actor, { layout: draft });
        const accepted = experience.submit(thread, message, makeId("request"), "layout_preview", undefined, undefined, undefined, actor);
        return json(res, { ...accepted, layoutId: draft.id }, 202);
      }
      if (id === "ui-layout-generate" && method === "POST") {
        const domainId = authoringDomain();
        const { prompt } = await body(req, z.object({ prompt: z.string().trim().min(4).max(800) }).strict(), 8 * 1024);
        const validTargets = uiTargetOptions(registry, principalId).filter(({ target }) => layoutTargetDomain(target) === domainId);
        const customKeys = domainId === "wealth" ? [...new Set(profileStore.list().flatMap((p) => (p.customAttributes ?? []).map((a) => `custom.${a.key}`)))] : [];
        const generated = await generateBoundUiLayoutWithLlm({
          prompt,
          gateway: options.gateway,
          dataDir: options.dataDir,
          validTargets,
          customAttributeKeys: customKeys,
        });
        validateUiDesign(generated.design, validTargets, false);
        return json(res, generated);
      }
      if (id === "widgets" && method === "GET") {
        const library = widgetLibraries[authoringDomain()];
        return json(res, { widgets: library.list(library.authorKey(principalId, requireOperator()), now()) });
      }
      if (id === "widget-generate" && method === "POST") {
        authoringDomain();
        const input = await body(req, widgetGenerateRequestSchema, 6 * 1024 * 1024);
        const generated = await generateWidgetFromMultimodal(input, options.gateway, options.dataDir);
        return json(res, generated);
      }
      if (id === "widgets" && method === "POST") {
        const change = await body(req, widgetLibraryChangeSchema, 32 * 1024);
        const library = widgetLibraries[authoringDomain()];
        return json(res, library.change(library.authorKey(principalId, requireOperator()), change, now()));
      }
      if (id === "customers" && method === "GET") {
        if (!membership.authoring(requireOperator()).includes("wealth")) throw new ApiError(403, "domain_access_denied", "This setting requires a Wealth owner.");
        return json(res, { customers: listAdminCustomers(principalId) });
      }
      if (id === "customers" && method === "POST") {
        if (!membership.authoring(requireOperator()).includes("wealth")) throw new ApiError(403, "domain_access_denied", "This setting requires a Wealth owner.");
        const input = await body(req, customer360ProfileInputSchema, 16 * 1024);
        const saved = profileStore.upsert(input, now());
        const customers = listAdminCustomers(principalId);
        return json(res, { customer: customers.find((c) => c.personaId === saved.personaId), customers });
      }
      if (id === "customer-delete" && method === "POST") {
        const { personaId } = await body(req, z.object({ personaId: z.string().regex(idPattern) }).strict());
        const result = profileStore.removeOrReset(personaId);
        return json(res, { ...result, customers: listAdminCustomers(principalId) });
      }
      if (id === "customer-reset-nba" && method === "POST") {
        const { personaId } = await body(req, z.object({ personaId: z.string().regex(idPattern) }).strict());
        customer360.resetDismissals(principalId, personaId);
        return json(res, { customers: listAdminCustomers(principalId) });
      }
      if (id === "experience-registry" && method === "GET") {
        return json(res, buildExperienceRegistryView());
      }
      if (id === "registry-intent" && method === "POST") {
        const input = await body(req, managedIntentInputSchema, 16 * 1024);
        if (!activeContexts.some((c) => c.contextId === input.contextId)) {
          throw new ApiError(400, "invalid_context", "Choose an active Treatment Selector context.");
        }
        experienceRegistry.upsertIntent(input);
        return json(res, buildExperienceRegistryView());
      }
      if (id === "registry-intent-delete" && method === "POST") {
        const { intentId } = await body(req, z.object({ intentId: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/) }).strict());
        experienceRegistry.deleteOrResetIntent(intentId);
        return json(res, buildExperienceRegistryView());
      }
      if (id === "registry-content" && method === "POST") {
        const input = await body(req, managedContentInputSchema, 32 * 1024);
        experienceRegistry.upsertContent(input);
        return json(res, buildExperienceRegistryView());
      }
      if (id === "registry-content-delete" && method === "POST") {
        const { contentId } = await body(req, z.object({ contentId: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/) }).strict());
        experienceRegistry.deleteOrResetContent(contentId);
        return json(res, buildExperienceRegistryView());
      }
      if (id === "registry-nba" && method === "POST") {
        const input = await body(req, managedNbaRuleInputSchema, 16 * 1024);
        experienceRegistry.upsertNbaRule(input);
        return json(res, buildExperienceRegistryView());
      }
      if (id === "registry-nba-reorder" && method === "POST") {
        const { orderedIds } = await body(req, z.object({ orderedIds: z.array(z.string().min(1)).min(1).max(30) }).strict());
        experienceRegistry.reorderNbaRules(orderedIds);
        return json(res, buildExperienceRegistryView());
      }
      if (id === "registry-nba-delete" && method === "POST") {
        const { id: ruleId } = await body(req, z.object({ id: z.string().regex(/^nba_[a-z0-9_]{3,40}$/) }).strict());
        experienceRegistry.deleteOrResetNbaRule(ruleId);
        return json(res, buildExperienceRegistryView());
      }
      if (id === "evaluation" && method === "GET") {
        return json(res, { mode: "live", rows: await runtime?.evaluation(principalId) ?? [] });
      }
      if (id === "capabilities" && method === "GET") {
        return json(res, { manifests: registry.list(principalId),
          tools: capabilityTools.map(({ ref, label, output, invariant }) => ({ ref, label, output, invariant })) });
      }
      if ((id === "capabilities" || id === "capability-validation") && method === "POST") {
        return json(res, registry.publish(principalId, await body(req, z.unknown(), 48 * 1024), id === "capability-validation"));
      }
      if (id === "capability-preview" && method === "POST") {
        if (!runtime) throw new ApiError(409, "model_unavailable", "Connect a model to run a capability preview.");
        const input = await body(req, z.object({
          capability: z.object({ id: capabilityIdSchema, version: versionSchema }).strict(),
          personaId: z.string().regex(idPattern), message: z.string().trim().min(1).max(1600),
        }).strict());
        if (!registry.get(principalId, capabilityRef(input.capability))) {
          throw new ApiError(404, "capability_unavailable", "Publish or select a known capability version.");
        }
        const conversation = experience.createConversation(principalId, input.personaId, demo.defaultScenarioId, "admin");
        const turn = experience.submit(conversation, input.message, makeId("request"), "capability_preview", undefined, undefined, { capability: input.capability });
        return json(res, turn, 202);
      }
      if (id === "customer-events" && method === "POST") {
        return json(res, simulateCustomerEvent(store, principalId, await body(req, customerEventSchema), now()));
      }
      if (id === "routing-flows" && (method === "GET" || method === "POST")) {
        const actor = requireOperator();
        const editableScopes: FlowScope[] = [...membership.authoring(actor)];
        if (membership.isTenantAdmin(actor)) editableScopes.push("tenant");
        const requested = url.searchParams.get("scope") ?? editableScopes[0];
        const scope = flowScopeSchema.safeParse(requested);
        if (!editableScopes.length || (scope.success && !editableScopes.includes(scope.data))) {
          throw new ApiError(403, "domain_access_denied", "Flow settings are unavailable for this scope.");
        }
        if (!scope.success) throw new ApiError(400, "domain_invalid", "Choose a valid settings scope.");
        const result = method === "GET" ? store.flowSetup(scope.data, editableScopes)
          : store.saveFlowSetup(scope.data, editableScopes, await body(req, flowOverridesSchema, 64 * 1024), req.headers["if-match"]);
        res.setHeader("ETag", result.revision);
        return json(res, result.data);
      }
      if (id === "tools" && method === "GET") {
        const domainId = authoringDomain();
        const preview = url.searchParams.get("scope") === "preview";
        const setup = store.toolSetup(domainId, preview ? principalId : undefined);
        const tag = toolSetupTag(setup);
        const draft = preview ? undefined : store.toolSetup(domainId, principalId);
        res.setHeader("ETag", tag);
        return json(res, { ...toolSetupView(setup), ...(draft && toolSetupTag(draft) !== tag && { privateDraft: draft }) });
      }
      if (id === "tools" && method === "POST") {
        const domainId = authoringDomain();
        const previewSession = url.searchParams.get("scope") === "preview" ? principalId : undefined;
        const setup = await body(req, toolSetupSchema, toolSetupLimit);
        validateToolSetup(setup);
        const tag = toolSetupTag(setup);
        const expected = req.headers["if-match"];
        if (expected !== undefined) {
          const current = toolSetupTag(store.toolSetup(domainId, previewSession));
          if (expected !== current && tag !== current) {
            throw new ApiError(412, "tool_setup_changed", "Tool settings changed. Reload Tool setup to review the latest settings.");
          }
        }
        store.saveToolSetup(domainId, setup, previewSession);
        res.setHeader("ETag", tag);
        return json(res, setup);
      }
      if (id === "treatment-preview" && method === "POST") {
        const input = await body(req, treatmentPreviewSchema, toolSetupLimit);
        const funding = store.axe.fundingFact({ principalId, personaId: input.personaId });
        return json(res, await previewTreatmentSelector(input, portfolioSnapshots, funding));
      }
      if (id === "ccre-rules" && method === "POST") {
        const rule = await body(req, mockCcreRuleSchema, toolSetupLimit);
        const domainId = authoringDomain();
        const current = store.toolSetup(domainId);
        const updated = addCcreRule(current, rule);
        if (updated !== current) store.saveToolSetup(domainId, updated);
        return json(res, rule);
      }
      if (id === "omnichannel" && method === "GET") {
        return json(res, omnichannelStore.view(origin));
      }
      if (id === "omnichannel" && method === "POST") {
        const nextConfig = await body(req, omnichannelConfigSchema.partial(), 8 * 1024);
        omnichannelStore.updateConfig(nextConfig);
        return json(res, omnichannelStore.view(origin));
      }
      if (id === "omnichannel-test" && method === "POST") {
        return json(res, await omnichannelStore.sendTestNotification(origin));
      }
      if (id === "evals" && method === "GET") {
        return json(res, evalRunner.view());
      }
      if (id === "eval-run" && method === "POST") {
        await body(req, z.object({ mode: z.literal("live_llm").optional() }).strict());
        if (!options.gateway) throw new ApiError(503, "gateway_unconfigured", "Connect a model provider to run evaluations.");
        return json(res, await evalRunner.runSuite({
          approvedCorrections: uxEvolution.view().proposals.flatMap((p) => p.status === "approved" && p.regression ? [p.regression] : []),
          replayCorrection: async (prompt) => {
            const widget = widgetLibrary.renderPublishedWidget(principalId, prompt);
            if (!widget) return {};
            const rendered = compileDynamicCanvas(widget.intro, widget.canvas, now() + 60_000).display.blocks.find((b) => b.component === "PznDynamicCanvas");
            return { recordId: rendered?.props.recordId, title: rendered?.props.title };
          },
          gateway: options.gateway,
          profileStore,
          tradeStore,
          approvalStore,
          connectorStore,
          workflowEngine,
        }));
      }
      if (id === "compliance-packet" && method === "GET") {
        return json(res, evalRunner.buildCompliancePacket({
          approvalStore,
          writeAudit,
          omnichannelStore,
          workflowEngine,
          baseUrl: origin,
        }));
      }
      if (id === "mcp-discover" && method === "POST") {
        const input = await body(req, mcpDiscoverRequestSchema, 8 * 1024);
        try {
          return json(res, await discoverMcpServer({
            serverUrl: input.serverUrl,
            authHeaderName: input.authHeaderName,
            authEnvVar: input.authEnvVar,
            connectorStore,
          }));
        } catch (err) {
          throw new ApiError(400, "mcp_discovery_failed", err instanceof Error ? err.message : "Could not discover MCP tools.");
        }
      }
      if (id === "mcp-import" && method === "POST") {
        const input = await body(req, mcpImportRequestSchema, 8 * 1024);
        return json(res, importMcpToolAsConnector({
          ...input,
          requiresApproval: input.requiresApproval ?? input.effect === "write",
          dualControl: input.dualControl ?? false,
          connectorStore,
        }));
      }
      if (id === "knowledge-base" && method === "GET") {
        return json(res, knowledgeBase.view());
      }
      if (id === "knowledge-base" && method === "POST") {
        const input = await body(req, knowledgeDocumentUpsertSchema, 32 * 1024);
        return json(res, knowledgeBase.upsert(input));
      }
      if (id === "knowledge-base-delete" && method === "POST") {
        const { id: docId } = await body(req, z.object({ id: z.string().regex(idPattern) }).strict());
        return json(res, knowledgeBase.deleteOrReset(docId));
      }
      if (id === "knowledge-search" && method === "POST") {
        const { query } = await body(req, z.object({ query: z.string().trim().min(2).max(400) }).strict());
        return json(res, knowledgeBase.search(query, 4));
      }
      if (id === "scheduled-jobs" && method === "GET") {
        return json(res, scheduledJobs.view());
      }
      if (id === "scheduled-jobs" && method === "POST") {
        const input = await body(req, scheduledJobUpsertSchema, 8 * 1024);
        return json(res, scheduledJobs.upsert(input, principalId));
      }
      if (id === "scheduled-jobs-run" && method === "POST") {
        const { id: jobId } = await body(req, z.object({ id: z.string().regex(idPattern) }).strict());
        try {
          return json(res, scheduledJobs.runJob(jobId, "manual", principalId));
        } catch (err) {
          throw new ApiError(404, "scheduled_job_not_found", err instanceof Error ? err.message : "Job not found.");
        }
      }
      if (id === "vertical-packs" && method === "GET") {
        return json(res, verticalFactory.view());
      }
      if (id === "vertical-packs-generate" && method === "POST") {
        const { prompt } = await body(req, z.object({ prompt: z.string().trim().min(5).max(600) }).strict(), 8 * 1024);
        return json(res, await verticalFactory.generateAndInstall({
          prompt,
          gateway: options.gateway,
          dataDir: options.dataDir,
          knowledgeBase,
          workflowEngine,
          connectors: connectorStore.list(),
        }), 201);
      }
      if (id === "vertical-packs-delete" && method === "POST") {
        const { id: packId } = await body(req, z.object({ id: z.string().regex(idPattern) }).strict());
        return json(res, verticalFactory.deletePack(packId));
      }
      if (id === "pii-firewall" && method === "GET") {
        return json(res, piiFirewall.view());
      }
      if (id === "pii-firewall" && method === "POST") {
        const patch = await body(req, piiFirewallConfigSchema.partial().strict());
        return json(res, piiFirewall.updateConfig(patch));
      }
      if (id === "pii-firewall-test" && method === "POST") {
        const { prompt, contextSummary } = await body(req, z.object({
          prompt: z.string().trim().min(1).max(1600),
          contextSummary: z.string().trim().max(800).optional(),
        }).strict());
        const knownNames = profileStore.list().map((p) => p.displayName);
        const result = scrubWithPiiFirewall({
          prompt,
          contextSummary,
          knownNames,
          config: piiFirewall.getConfig(),
        });
        return json(res, { trace: result.trace });
      }
      if (id === "ux-evolution" && method === "GET") {
        return json(res, uxEvolution.view());
      }
      if (id === "ux-evolution-scan" && method === "POST") {
        const input = await body(req, z.object({ includeSampleTraffic: z.boolean().optional() }).strict());
        const recentTurns = store.listAllCompletedTurns(200);
        const existingWidgets = widgetLibrary.list(widgetLibrary.authorKey(principalId, requireOperator()), now());
        return json(res, await uxEvolution.scanAndDraft({
          turns: recentTurns,
          existingWidgets,
          gateway: options.gateway,
          dataDir: options.dataDir,
          includeSampleTraffic: input.includeSampleTraffic,
        }));
      }
      if (id === "ux-evolution-approve" && method === "POST") {
        const { id: proposalId } = await body(req, z.object({ id: z.string().regex(idPattern) }).strict());
        try {
          return json(res, uxEvolution.approveProposal(proposalId, {
            principalId: widgetLibrary.authorKey(principalId, requireOperator()),
            widgetLibrary,
            knowledgeBase,
            now: now(),
          }));
        } catch (err) {
          throw new ApiError(404, "ux_proposal_not_found", err instanceof Error ? err.message : "Proposal not found.");
        }
      }
      if (id === "ux-evolution-dismiss" && method === "POST") {
        const { id: proposalId } = await body(req, z.object({ id: z.string().regex(idPattern) }).strict());
        return json(res, uxEvolution.dismissProposal(proposalId));
      }
    }
    if (resource === "conversations") {
      if (method === "POST" && !id) {
        return createChat();
      }
      if (id) {
        const conversation = store.conversation(id, principalId, viewer);
        requireThread(conversation);
        if (conversation.audience === "admin" || (!operator && store.hasOperatorContent(id))) requireOperator();
        if (method === "GET" && operation === "updates") return json(res, await experience.recordUpdates(conversation, Boolean(operator)));
        if (method === "GET" && !operation) {
          const turns = await experience.conversationTurns(conversation);
          return json(res, { ...presentConversation(conversation), turns: turns.map((turn) => visibleTurn(turn, operator)) });
        }
        if (method === "POST" && operation === "settings") {
          return json(res, store.changeConversation(id, conversation.principalId, await body(req, conversationChangeBody), now()));
        }
        if (method === "POST" && operation === "preview-funding") {
          const { clientRequestId, source } = await body(req, previewFundingBody);
          return json(res, experience.previewWorkspaceFunding(conversation, clientRequestId, source, principalId), 202);
        }
        if (method === "POST" && operation === "turns") {
          const input = await body(req, messageBody);
          const fresh = store.conversation(conversation.id, conversation.principalId);
          const accepted = experience.submit(fresh, input.message, input.clientRequestId, "message", undefined, undefined, undefined, operator, principalId);
          if (accepted.turn.status === "working" && accepted.turn.progress === "accepted") {
            runtime?.captureTurnExchange(accepted.turnId, "submission", "POST " + url.pathname, input, accepted);
          }
          return json(res, accepted, 202);
        }
      }
    }
    if (resource === "turns" && id) {
      const turn = store.ownTurn(id, principalId, viewer);
      const thread = store.conversation(turn.scope.conversationId, principalId, viewer);
      requireThread(thread);
      if (thread.audience === "admin" || (!operator && store.hasOperatorContent(thread.id))) requireOperator();
      if (method === "GET" && !operation) return json(res, visibleTurn(await experience.turnView(turn), operator));
      if (method === "POST" && operation === "cancel") return json(res, experience.cancel(turn));
      if (method === "POST" && operation === "retry") {
        const { clientRequestId } = await body(req, retryBody);
        return json(res, await experience.retry(turn, clientRequestId, operator, principalId), 202);
      }
      if (method === "GET" && operation === "events") {
        const rawCursor = req.headers["last-event-id"] ?? url.searchParams.get("after") ?? "0";
        let cursor = typeof rawCursor === "string" && /^\d{1,15}$/.test(rawCursor) ? Number(rawCursor) : -1;
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive", "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        streams.add(res);
        const flush = () => {
          if (res.writableEnded || res.destroyed) return;
          const live = store.ownTurn(id, principalId, viewer);
          const known = store.replay(live, cursor);
          if (!known) {
            res.end("event: gap\ndata: {}\n\n");
            return;
          }
          for (const event of known) {
            res.write("id: " + event.sequence + "\nevent: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
            cursor = event.sequence;
          }
          if (live.public.status !== "working") res.end();
        };
        const unsubscribe = store.subscribe(id, flush);
        const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": keepalive\n\n"); }, 12_000);
        heartbeat.unref();
        res.once("close", () => { unsubscribe(); clearInterval(heartbeat); streams.delete(res); });
        flush();
        return;
      }
    }
    if (resource === "experiences" && id && operation === "actions" && method === "POST") {
      const { turn } = store.experience(id, principalId, viewer);
      const thread = store.conversation(turn.scope.conversationId, principalId, viewer);
      requireThread(thread);
      if (thread.audience === "admin" || (!operator && store.hasOperatorContent(thread.id))) requireOperator();
      const input = await body(req, actionBody);
      const accepted = experience.followUp(thread.principalId, id, input.envelope, input.clientRequestId, operator, principalId);
      if (accepted.turn.status === "working" && accepted.turn.progress === "accepted"
        && Object.keys(input.envelope.action.context).every((key) => key === "actionId")) {
        runtime?.captureTurnExchange(accepted.turnId, "submission", "POST " + url.pathname, input, accepted);
      }
      return json(res, accepted, 202);
    }
    if (resource === "admin" && id === "recommendation-providers" && !operation && method === "GET" && inspectorEnabled) {
      return json(res, {
        toolRef: recommendationArbitrateToolRef,
        writeToolRef: domainWriteToolRef,
        connectorToolRef: connectorInvokeToolRef,
        providers: runtime?.recommendationProviderDescriptors() ?? [],
      });
    }
    if (resource === "admin" && id === "connectors" && !operation && method === "GET" && inspectorEnabled) {
      return json(res, { connectors: connectorStore.list() });
    }
    if (resource === "admin" && id === "connectors" && !operation && method === "POST" && inspectorEnabled) {
      const data = await body(req, connectorUpsertSchema);
      return json(res, connectorStore.upsert(data));
    }
    if (resource === "admin" && id === "connector-delete" && !operation && method === "POST" && inspectorEnabled) {
      const { id: connId } = await body(req, z.object({ id: z.string().regex(idPattern) }).strict());
      return json(res, connectorStore.remove(connId));
    }
    if (resource === "admin" && id === "connector-test" && !operation && method === "POST" && inspectorEnabled) {
      const { id: connId } = await body(req, z.object({ id: z.string().regex(idPattern) }).strict());
      return json(res, await connectorStore.testConnector(connId));
    }
    if (
      ((resource === "admin" && id === "connector-invoke" && !operation && inspectorEnabled)
        || (resource === "connectors" && id === "invoke" && !operation))
      && method === "POST"
    ) {
      const rawInput = await body(req, connectorInvokeInputSchema);
      const action = rawInput.action ?? "invoke";
      const actor = requireOperator();
      const payload = rawInput.payload ?? {};
      const conn = connectorStore.findById(rawInput.connectorId);
      if (!conn) throw new ApiError(404, "not_found", "Connector not found.");
      if (!conn.enabled) throw new ApiError(409, "connector_disabled", `Connector "${conn.name}" is disabled.`);
      if (approvalStore.shouldGateConnector(conn)) {
        const approval = approvalStore.createPending({
          targetKind: "external_connector",
          sfieldToolRef: connectorInvokeToolRef,
          domain: "external_connector",
          recordId: conn.id,
          action,
          title: `External Connector · ${conn.name}`,
          summary: rawInput.note?.trim() || `Execute "${action}" against ${conn.url} (${conn.method}) via ${connectorInvokeToolRef}.`,
          riskLevel: conn.effect === "write" ? "high" : "medium",
          payload,
          details: [
            { label: "Connector", value: conn.name },
            { label: "Endpoint", value: `${conn.method} ${conn.url}` },
            { label: "Action", value: action },
            { label: "sfield Effect", value: conn.effect },
            { label: "4-Eyes Dual Control", value: (conn.dualControl || approvalStore.getPolicy().defaultDualControl) ? "Required" : "Inline allowed" },
          ],
          requester: actor,
          dualControl: conn.dualControl || approvalStore.getPolicy().defaultDualControl,
        });
        return json(res, { status: "pending_approval", approval, approvalsView: approvalStore.view() }, 202);
      }
      if (runtime) {
        const execution = await runtime.executeConnectorInvoke(principalId, {
          connectorId: conn.id,
          action,
          actor,
          payload,
        }, AbortSignal.timeout(8000));
        return json(res, { status: "executed", execution });
      }
      const execution = await connectorStore.invokeConnector(conn.id, {
        action,
        actor,
        payload,
      }, AbortSignal.timeout(8000));
      const audit = writeAudit.record({
        sfieldRunId: "offline",
        sfieldToolRef: connectorInvokeToolRef,
        domain: "external_connector",
        recordId: conn.id,
        action,
        actor,
        summary: execution.summary,
        status: "succeeded",
      });
      return json(res, { status: "executed", execution: { ...execution, sfieldRunId: "offline", auditId: audit.auditId } });
    }
    if (resource === "admin" && id === "action-flows" && !operation && method === "GET" && inspectorEnabled) {
      return json(res, { flows: actionFlowStore.list() });
    }
    if (resource === "admin" && id === "action-flows" && !operation && method === "POST" && inspectorEnabled) {
      const input = await body(req, actionFlowUpsertSchema);
      return json(res, actionFlowStore.upsert(input));
    }
    if (resource === "admin" && id === "action-flow-delete" && !operation && method === "POST" && inspectorEnabled) {
      const { id: flowId } = await body(req, z.object({ id: z.string().regex(idPattern) }).strict());
      return json(res, actionFlowStore.remove(flowId));
    }
    if (resource === "workflows") {
      if (!id && method === "GET") {
        return json(res, workflowEngine.view());
      }
      if (id === "generate" && !operation && method === "POST" && inspectorEnabled) {
        const { prompt } = await body(req, z.object({ prompt: z.string().trim().min(4).max(800) }).strict(), 8 * 1024);
        return json(res, await generateWorkflowWithLlm({
          prompt,
          gateway: options.gateway,
          dataDir: options.dataDir,
          connectors: connectorStore.list(),
        }));
      }
      if (!id && method === "POST" && inspectorEnabled) {
        const input = await body(req, workflowDefinitionUpsertSchema, 48 * 1024);
        return json(res, workflowEngine.upsertDefinition(input));
      }
      if (id && operation === "delete" && method === "POST" && inspectorEnabled) {
        return json(res, workflowEngine.deleteOrResetDefinition(id));
      }
      if (id && operation === "start" && method === "POST") {
        const input = await body(req, z.object({
          personaId: z.string().regex(idPattern).optional(),
          actorName: z.string().trim().min(1).max(80).optional(),
          initialInputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        }).strict());
        const personaId = input.personaId ?? demo.defaultPersonaId;
        const profile = profileStore.findByPersonaId(personaId);
        try {
          const started = await workflowEngine.startRun(id, {
            personaId,
            actorName: input.actorName ?? profile?.displayName ?? "Customer",
            initialInputs: input.initialInputs,
          });
          return json(res, started, 201);
        } catch (err) {
          throw new ApiError(404, "workflow_not_found", err instanceof Error ? err.message : "Workflow not found.");
        }
      }
    }
    if (resource === "documents" && id === "extract" && !operation && method === "POST") {
      const input = await body(req, z.object({
        fileName: z.string().trim().min(1).max(120),
        content: z.string().trim().min(5).max(8000),
      }).strict(), 16 * 1024);
      const extracted = await extractDocumentAction({
        fileName: input.fileName,
        content: input.content,
        gateway: options.gateway,
        dataDir: options.dataDir,
      });
      return json(res, { extracted });
    }
    if (resource === "proactive") {
      if (id === "alerts" && !operation && method === "GET") {
        requireOperator();
        return json(res, proactiveStore.view());
      }
      if (id === "trigger" && !operation && method === "POST") {
        const input = await body(req, proactiveTriggerInputSchema, 8 * 1024);
        return json(res, proactiveStore.trigger(input, principalId), 201);
      }
      if (id && operation === "dismiss" && method === "POST") {
        const view = proactiveStore.dismiss(id, operator ? undefined : principalId);
        return json(res, operator ? view : { alerts: [], activeCount: 0 });
      }
      if (id === "stream" && !operation && method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        });
        streams.add(res);
        res.write(`event: proactive.connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
        const personaId = url.searchParams.get("personaId");
        const retailProfile = customerSession || Boolean(selectedProfile) || !operator;
        const unsubscribe = proactiveStore.subscribe((alert) => {
          if (alert.principalId === principalId && alert.personaId === personaId && (!retailProfile || (alert.domain === "wealth" && (!selectedProfile || selectedProfile === personaId))) && membership.chat(alert.domain, personaId ?? "", operator) && !res.writableEnded) {
            res.write(`event: proactive.alert\ndata: ${JSON.stringify(alert)}\n\n`);
          }
        });
        const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": keepalive\n\n"); }, 15_000);
        res.once("close", () => { unsubscribe(); clearInterval(heartbeat); streams.delete(res); });
        return;
      }
    }
    if (resource === "workflow-runs" && id) {
      if (!operation && method === "GET") {
        const run = workflowEngine.getRun(id);
        if (!run) throw new ApiError(404, "workflow_run_not_found", "Workflow run not found.");
        return json(res, { run, definition: workflowEngine.getDefinition(run.workflowId) });
      }
      if (operation === "input" && method === "POST") {
        const { inputs } = await body(req, z.object({
          inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
        }).strict());
        try {
          const run = await workflowEngine.submitInput(id, inputs);
          return json(res, { run, definition: workflowEngine.getDefinition(run.workflowId) });
        } catch (err) {
          throw new ApiError(400, "workflow_input_failed", err instanceof Error ? err.message : "Could not submit workflow input.");
        }
      }
      if (operation === "cancel" && method === "POST") {
        try {
          const run = workflowEngine.cancelRun(id);
          return json(res, { run, definition: workflowEngine.getDefinition(run.workflowId) });
        } catch (err) {
          throw new ApiError(404, "workflow_run_not_found", err instanceof Error ? err.message : "Workflow run not found.");
        }
      }
      if (operation === "events" && method === "GET") {
        const initialRun = workflowEngine.getRun(id);
        if (!initialRun) throw new ApiError(404, "workflow_run_not_found", "Workflow run not found.");
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        });
        streams.add(res);
        const sendSnapshot = (snapshot: typeof initialRun) => {
          if (res.writableEnded) return;
          res.write(`event: workflow.update\ndata: ${JSON.stringify(snapshot)}\n\n`);
          if (snapshot.status === "completed" || snapshot.status === "cancelled" || snapshot.status === "failed") {
            res.end();
          }
        };
        const unsubscribe = workflowEngine.subscribe(id, sendSnapshot);
        const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": keepalive\n\n"); }, 15_000);
        res.once("close", () => { unsubscribe(); clearInterval(heartbeat); streams.delete(res); });
        sendSnapshot(initialRun);
        return;
      }
    }
    if (resource === "trading") {
      if (id && operation && ["status", "cancel", "events"].includes(operation)) {
        const job = tradeStore.getJob(id);
        if (job) requireChatDomain("wealth", job.personaId);
      }
      if (id && operation === "portfolio" && method === "GET") {
        requireChatDomain("wealth", id);
        return json(res, tradeStore.snapshotFor(id));
      }
      if (id === "tax-harvest" && !operation && method === "POST") {
        const input = await body(req, taxHarvestPreviewInputSchema);
        requireChatDomain("wealth", input.personaId);
        try {
          return json(res, tradeStore.analyzeTaxHarvest(input.personaId, input.symbol, input.shares));
        } catch (err) {
          throw new ApiError(400, "tax_harvest_invalid", err instanceof Error ? err.message : "Could not run tax-loss harvesting analysis.");
        }
      }
      if (id === "jobs" && !operation && method === "POST") {
        const input = await body(req, tradeJobCreateInputSchema);
        requireChatDomain("wealth", input.personaId);
        const legs = input.legs.map((l) => ({ ...l, symbol: l.symbol.toUpperCase(), reason: l.reason ?? "primary" as const }));
        const grossCents = tradeStore.estimateGrossCents(input.personaId, legs);
        if (approvalStore.shouldGateTrade(grossCents)) {
          const policy = approvalStore.getPolicy();
          const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
          const approval = approvalStore.createPending({
            targetKind: "stock_trade",
            sfieldToolRef: domainWriteToolRef,
            domain: "stock_trade",
            recordId: input.personaId,
            action: "execute_trade_bundle",
            title: `High-Value Trade Approval · ${legs.map((l) => `${l.side.toUpperCase()} ${l.shares} ${l.symbol}`).join(" + ")}`.slice(0, 120),
            summary: `Gross trade value ${usd(grossCents)} exceeds the $${policy.highRiskTradeThresholdUsd.toLocaleString("en-US")} compliance threshold. Approve to launch the timed sfield settlement job.`,
            riskLevel: "high",
            payload: { personaId: input.personaId, legs, taxHarvestAnalyzed: Boolean(input.taxHarvestAnalyzed), grossCents },
            details: [
              { label: "Gross Order Value", value: usd(grossCents) },
              { label: "Threshold", value: `$${policy.highRiskTradeThresholdUsd.toLocaleString("en-US")}` },
              { label: "Order Legs", value: legs.map((l) => `${l.side.toUpperCase()} ${l.shares} ${l.symbol}`).join(", ") },
              { label: "Tax Harvesting", value: input.taxHarvestAnalyzed ? "Analyzed" : "Skipped" },
              { label: "4-Eyes Dual Control", value: policy.defaultDualControl ? "Required" : "Inline allowed" },
            ],
            requester: operator ?? principalId,
            dualControl: policy.defaultDualControl,
          });
          return json(res, { status: "pending_approval", approval, ...(operator && { approvalsView: approvalStore.view() }) }, 202);
        }
        try {
          const job = tradeStore.startTradeJob({ ...input, actor: operator ?? principalId }, makeTradeSettler(principalId));
          return json(res, job, 202);
        } catch (err) {
          throw new ApiError(400, "trade_rejected", err instanceof Error ? err.message : "Trade order could not be queued.");
        }
      }
      if (id && operation === "status" && method === "GET") {
        const job = tradeStore.getJob(id);
        if (!job) throw new ApiError(404, "job_not_found", "Trade job not found.");
        return json(res, job);
      }
      if (id && operation === "cancel" && method === "POST") {
        const result = tradeStore.cancelJob(id);
        if (!result.ok) throw new ApiError(409, "trade_cancel_failed", result.message);
        return json(res, result.job);
      }
      if (id && operation === "events" && method === "GET") {
        const currentJob = tradeStore.getJob(id);
        if (!currentJob) throw new ApiError(404, "job_not_found", "Trade job not found.");
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        streams.add(res);
        const send = (job: typeof currentJob) => {
          if (res.writableEnded || res.destroyed) return;
          res.write(`event: job.update\ndata: ${JSON.stringify(job)}\n\n`);
          if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
            res.end();
          }
        };
        const unsubscribe = tradeStore.subscribeJob(id, send);
        res.once("close", () => { unsubscribe(); streams.delete(res); });
        send(currentJob);
        return;
      }
    }
    if (resource === "approvals" && !id && method === "GET") {
      return json(res, approvalStore.view());
    }
    if (resource === "approvals" && id === "policy" && !operation && method === "POST" && inspectorEnabled) {
      const next = await body(req, approvalPolicySettingsSchema.partial());
      const policy = approvalStore.updatePolicy(next);
      return json(res, { policy, view: approvalStore.view() });
    }
    if (resource === "approvals" && id && operation === "decide" && method === "POST") {
      const decisionInput = { ...await body(req, approvalDecisionInputSchema.omit({ actor: true }).extend({ actor: z.string().optional() })), actor: requireOperator() };
      const outcome = approvalStore.decide(id, decisionInput);
      if (!outcome.ok) {
        throw new ApiError(outcome.status, outcome.code, outcome.message);
      }
      if (outcome.record.status === "denied") {
        if (outcome.record.targetKind === "integration_task") {
          await integrationService.deny(outcome.record, principalId);
          await workflowEngine.resumeAfterTaskApproval(outcome.record.id, undefined, false, decisionInput.actor, decisionInput.comment);
        }
        if (outcome.record.targetKind === "workflow_step") {
          const runId = typeof outcome.record.payload.runId === "string" ? outcome.record.payload.runId : outcome.record.recordId;
          await workflowEngine.resumeAfterApproval(runId, outcome.record.id, false, decisionInput.actor, decisionInput.comment);
        }
        writeAudit.record({
          sfieldRunId: "approval_denied",
          sfieldToolRef: outcome.record.sfieldToolRef,
          domain: outcome.record.domain,
          recordId: outcome.record.recordId,
          action: outcome.record.action,
          actor: decisionInput.actor,
          summary: `Denied by ${decisionInput.actor}${decisionInput.comment ? `: ${decisionInput.comment}` : ""}`,
          status: "denied",
          approvalId: outcome.record.id,
        });
        return json(res, { approval: outcome.record, view: approvalStore.view() });
      }
      const executed = await executeApprovedRecord(principalId, outcome.record);
      return json(res, {
        approval: executed.approval,
        execution: executed.execution,
        ...("taskRun" in executed ? { taskRun: executed.taskRun } : {}),
        view: approvalStore.view(),
      });
    }
    if (resource === "admin" && id === "write-audit" && !operation && method === "GET" && inspectorEnabled) {
      return json(res, {
        toolRef: domainWriteToolRef,
        entries: writeAudit.list(),
      });
    }
    if (resource === "admin" && id === "engagement-analytics" && !operation && method === "GET" && inspectorEnabled) {
      const base = store.engagementSummary();
      const writes = writeAudit.list();
      return json(res, {
        ...base,
        nbaDismissals: customer360.totalDismissalCount(),
        governedWritesTotal: writes.length,
        writesByDomain: {
          opsIncident: writes.filter((w) => w.domain === "ops_incident").length,
          salesDeal: writes.filter((w) => w.domain === "sales_deal").length,
          customer360: writes.filter((w) => w.domain === "customer360").length,
          externalConnector: writes.filter((w) => w.domain === "external_connector").length,
        },
        pendingApprovalsCount: approvalStore.pending().length,
        recentWrites: writes.slice(0, 15),
      });
    }
    if (resource === "ops" && id === "incidents" && !operation && method === "GET") {
      return json(res, opsStore.view());
    }
    if (resource === "ops" && id === "incidents" && !operation && method === "POST") {
      const data = await body(req, incidentUpsertInputSchema);
      return json(res, opsStore.upsert(data));
    }
    if (resource === "ops" && id === "incidents" && operation === "reset" && method === "POST") {
      return json(res, opsStore.reset());
    }
    if (resource === "ops-incidents" && id && operation === "delete" && method === "POST") {
      return json(res, opsStore.remove(id));
    }
    if (resource === "ops-incidents" && id && operation === "decision" && method === "POST") {
      const data = { ...await body(req, incidentDecisionInputSchema.extend({ queueForApproval: z.boolean().optional() })), actor: requireOperator() };
      const existingInc = opsStore.findById(id);
      if (!existingInc) throw new ApiError(404, "not_found", "Incident not found.");
      if ((data.expectedUpdatedAt && data.expectedUpdatedAt !== existingInc.updatedAt) || (data.decision.endsWith("_rollback") && existingInc.rollbackStatus !== "pending")) throw new ApiError(409, "decision_unavailable", "The incident changed or has no pending rollback. Reopen the incident to review it.");
      const policy = approvalStore.getPolicy();
      const shouldQueue = Boolean(data.queueForApproval) || (
        data.decision === "approve_rollback" && policy.gateHighRiskOpsRollbacks && policy.defaultDualControl
      );
      if (shouldQueue) {
        const approval = approvalStore.createPending({
          targetKind: "domain_write",
          sfieldToolRef: domainWriteToolRef,
          domain: "ops_incident",
          recordId: existingInc.id,
          action: data.decision,
          title: `Production Rollback · ${existingInc.id} (${existingInc.currentRelease} → ${existingInc.previousRelease})`,
          summary: existingInc.summary,
          riskLevel: existingInc.severity === "P1" ? "high" : "medium",
          payload: { decision: data.decision, expectedUpdatedAt: existingInc.updatedAt, ...(data.note ? { note: data.note } : {}) },
          details: [
            { label: "Incident", value: `${existingInc.id} (${existingInc.severity})` },
            { label: "Service", value: `${existingInc.service} · ${existingInc.environment}` },
            { label: "Release Change", value: `${existingInc.currentRelease} → ${existingInc.previousRelease}` },
            { label: "Error Rate", value: `${existingInc.errorRatePct}% (p95 ${existingInc.p95LatencyMs}ms)` },
          ],
          requester: data.actor?.trim() || "On-Call SRE Commander",
          dualControl: policy.defaultDualControl,
        });
        return json(res, { status: "pending_approval", approval, incident: existingInc, view: opsStore.view() }, 202);
      }
      if (runtime) {
        const governed = await runtime.executeGovernedWrite(principalId, {
          domain: "ops_incident",
          recordId: id,
          action: data.decision,
          actor: data.actor?.trim() || "On-Call SRE Commander",
          ...(data.note ? { note: data.note } : {}),
        }, AbortSignal.timeout(5000));
        const updated = opsStore.findById(id);
        if (!updated) throw new ApiError(404, "not_found", "Incident not found.");
        return json(res, { incident: updated, view: opsStore.view(), sfieldRunId: governed.sfieldRunId, auditId: governed.audit?.auditId });
      }
      const updated = opsStore.decide(id, data);
      if (!updated) throw new ApiError(404, "not_found", "Incident not found.");
      const audit = writeAudit.record({
        sfieldRunId: "offline",
        sfieldToolRef: domainWriteToolRef,
        domain: "ops_incident",
        recordId: updated.id,
        action: data.decision,
        actor: data.actor?.trim() || "On-Call SRE Commander",
        summary: `${updated.id} → ${updated.status} (error rate ${updated.errorRatePct}%, p95 ${updated.p95LatencyMs}ms)`,
        status: "succeeded",
      });
      return json(res, { incident: updated, view: opsStore.view(), auditId: audit.auditId });
    }
    if (resource === "sales" && id === "deals" && !operation && method === "GET") {
      return json(res, salesStore.view());
    }
    if (resource === "sales" && id === "deals" && !operation && method === "POST") {
      const data = await body(req, dealUpsertInputSchema);
      return json(res, salesStore.upsert(data));
    }
    if (resource === "sales" && id === "deals" && operation === "reset" && method === "POST") {
      return json(res, salesStore.reset());
    }
    if (resource === "sales-deals" && id && operation === "delete" && method === "POST") {
      return json(res, salesStore.remove(id));
    }
    if (resource === "sales-deals" && id && operation === "decision" && method === "POST") {
      const data = { ...await body(req, dealDecisionInputSchema.extend({ queueForApproval: z.boolean().optional() })), actor: requireOperator() };
      const existingDeal = salesStore.list().find((d) => d.id.toLowerCase() === id.toLowerCase());
      if (!existingDeal) throw new ApiError(404, "not_found", "Deal not found.");
      if ((data.expectedUpdatedAt && data.expectedUpdatedAt !== existingDeal.updatedAt) || (data.decision.endsWith("_discount") && existingDeal.discountStatus !== "pending")) throw new ApiError(409, "decision_unavailable", "The deal changed or has no pending discount. Reopen the deal to review it.");
      const policy = approvalStore.getPolicy();
      const shouldQueue = Boolean(data.queueForApproval) || (
        data.decision === "approve_discount" && existingDeal.discountPct > 15 && policy.gateHighRiskSalesDiscounts && policy.defaultDualControl
      );
      if (shouldQueue) {
        const approval = approvalStore.createPending({
          targetKind: "domain_write",
          sfieldToolRef: domainWriteToolRef,
          domain: "sales_deal",
          recordId: existingDeal.id,
          action: data.decision,
          title: `Deal Desk Discount · ${existingDeal.accountName} (${existingDeal.discountPct}% off)`,
          summary: existingDeal.summary,
          riskLevel: existingDeal.discountPct > 15 ? "high" : "medium",
          payload: { decision: data.decision, expectedUpdatedAt: existingDeal.updatedAt, ...(data.note ? { note: data.note } : {}) },
          details: [
            { label: "Deal ID", value: existingDeal.id },
            { label: "Account", value: existingDeal.accountName },
            { label: "ARR", value: `$${existingDeal.arrUsd.toLocaleString("en-US")}` },
            { label: "Discount", value: `${existingDeal.discountPct}% (Standard cap: 15%)` },
          ],
          requester: data.actor?.trim() || "VP Revenue Operations",
          dualControl: policy.defaultDualControl,
        });
        return json(res, { status: "pending_approval", approval, deal: existingDeal, view: salesStore.view() }, 202);
      }
      if (runtime) {
        const governed = await runtime.executeGovernedWrite(principalId, {
          domain: "sales_deal",
          recordId: id,
          action: data.decision,
          actor: data.actor?.trim() || "VP Revenue Operations",
          ...(data.note ? { note: data.note } : {}),
        }, AbortSignal.timeout(5000));
        const updated = salesStore.list().find((d) => d.id.toLowerCase() === id.toLowerCase());
        if (!updated) throw new ApiError(404, "not_found", "Deal not found.");
        return json(res, { deal: updated, view: salesStore.view(), sfieldRunId: governed.sfieldRunId, auditId: governed.audit?.auditId });
      }
      const updated = salesStore.decide(id, data);
      if (!updated) throw new ApiError(404, "not_found", "Deal not found.");
      const audit = writeAudit.record({
        sfieldRunId: "offline",
        sfieldToolRef: domainWriteToolRef,
        domain: "sales_deal",
        recordId: updated.id,
        action: data.decision,
        actor: data.actor?.trim() || "VP Revenue Operations",
        summary: `${updated.id} (${updated.accountName}) → ${updated.stage} (${updated.discountStatus}, ${updated.winProbabilityPct}% prob.)`,
        status: "succeeded",
      });
      return json(res, { deal: updated, view: salesStore.view(), auditId: audit.auditId });
    }
    if (resource === "integrations" && inspectorEnabled) {
      const guard = async <T>(fn: () => Promise<T> | T) => {
        try {
          return await fn();
        } catch (err) {
          if (err instanceof IntegrationTaskError) {
            const status = err.code === "sfield_runtime_required" ? 503
              : err.code === "invalid_callback_signature" ? 401
              : err.code.endsWith("not_found") ? 404
              : err.code === "invalid_contract" ? 400 : 409;
            throw new ApiError(status, err.code, err.message);
          }
          if (err instanceof z.ZodError) throw new ApiError(400, "invalid_input", err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 400));
          throw err;
        }
      };
      if (!id && method === "GET") return json(res, integrationService.view());
      if (id === "contracts" && !operation && method === "POST") {
        const raw = await body(req, z.record(z.string(), z.unknown()), 64 * 1024);
        return json(res, { contract: await guard(() => integrationTasks.upsertDraft(raw)), view: integrationService.view() });
      }
      if (id === "demo-mcp" && !operation && method === "POST") {
        const out = demoMcp(await body(req, z.unknown(), 64 * 1024));
        res.writeHead(out.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...out.headers });
        res.end(out.body === undefined ? "" : JSON.stringify(out.body));
        return;
      }
      if (id === "integrations" && !operation && method === "POST") {
        const raw = await body(req, z.record(z.string(), z.unknown()), 16 * 1024);
        return json(res, { integration: await guard(() => integrationTasks.upsertIntegration(raw)), view: integrationService.view() });
      }
      if (id === "contracts" && operation === "validate" && method === "POST") {
        const { draft } = await body(req, draftValidateRequestSchema, 64 * 1024);
        return json(res, integrationTasks.validateDraft(draft));
      }
      if (id === "mcp" && operation === "discover" && method === "POST") {
        const { integrationId } = await body(req, integrationMcpDiscoverRequestSchema);
        return json(res, await guard(() => integrationService.discoverMcp(integrationId)));
      }
      if (id === "contracts" && operation === "delete" && method === "POST") {
        const { ref } = await body(req, z.object({ ref: z.string().min(3).max(120) }).strict());
        const deleted = await guard(() => integrationTasks.deleteDraft(ref));
        return json(res, { ...deleted, view: integrationService.view() });
      }
      if (id === "integrations" && operation === "delete" && method === "POST") {
        const { id: integrationId } = await body(req, z.object({ id: z.string().min(2).max(64) }).strict());
        const deleted = await guard(() => integrationTasks.deleteIntegration(integrationId));
        return json(res, { ...deleted, view: integrationService.view() });
      }
      if (id === "contracts" && operation === "publish" && method === "POST") {
        enforceEvalGate("publishing an integration task contract");
        const { ref } = await body(req, z.object({ ref: z.string().min(3).max(120) }).strict());
        if (approvalStore.getPolicy().gateTaskPublish) {
          const contract = integrationTasks.contract(ref);
          if (!contract) throw new ApiError(404, "contract_not_found", `Unknown task contract ${ref}`);
          if (contract.status !== "draft") throw new ApiError(409, "not_draft", `${ref} is already ${contract.status}.`);
          const actor = requireOperator();
          const approval = approvalStore.createPending({
            targetKind: "task_publish",
            sfieldToolRef: contract.ref,
            domain: "integration",
            recordId: contract.ref,
            action: "publish_task",
            title: `Publish Integration Task · ${contract.ref}`,
            summary: `Publish ${contract.effect} task "${contract.description.slice(0, 140)}" into the live sfield runtime.`,
            riskLevel: contract.effect === "read" ? "low" : "high",
            payload: { ref: contract.ref, contractDigest: contract.contractDigest, bindingDigest: contract.bindingDigest },
            details: [
              { label: "Task Ref", value: contract.ref },
              { label: "Effect", value: contract.effect },
              { label: "Contract Digest", value: contract.contractDigest.slice(0, 22) },
              { label: "Binding Digest", value: contract.bindingDigest.slice(0, 22) },
            ],
            requester: actor,
            dualControl: approvalStore.getPolicy().defaultDualControl,
          });
          return json(res, { status: "pending_approval", approval, view: integrationService.view() }, 202);
        }
        const published = await guard(() => integrationService.publish(ref));
        return json(res, { ...published, view: integrationService.view() });
      }
      if (id === "tasks" && operation === "run" && method === "POST") {
        const data = await body(req, runTaskRequestSchema, 32 * 1024);
        const out = await guard(() => integrationService.run(principalId, { ...data, requestedBy: requireOperator() }));
        return json(res, out, out.approval || out.run.state === "accepted" ? 202 : 200);
      }
      if (id === "copilot" && !operation && method === "POST") {
        const data = await body(req, integrationCopilotRequestSchema, 48 * 1024);
        return json(res, await runIntegrationCopilot(data, integrationService, principalId, { operatorName: requireOperator(), gateway: options.gateway, dataDir: options.dataDir }));
      }
      if (id === "runs" && operation === "reconcile" && method === "POST") {
        const { runId } = await body(req, z.object({ runId: z.string().min(3).max(64) }).strict());
        return json(res, await guard(() => integrationService.reconcile(principalId, runId)));
      }
      if (id === "runs" && operation === "poll" && method === "POST") {
        const { runId } = await body(req, z.object({ runId: z.string().min(3).max(64) }).strict());
        return json(res, await guard(() => integrationService.pollAsyncRun(principalId, runId)));
      }
      if (id === "callbacks" && operation && method === "POST") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > 64 * 1024) {
            req.resume();
            throw new ApiError(413, "request_too_large", "Callback payload is too large.");
          }
          chunks.push(chunk);
        }
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const sigHeader = typeof req.headers["x-cep-signature"] === "string" ? req.headers["x-cep-signature"] : undefined;
        return json(res, await guard(() => integrationService.completeAsyncCallback(operation, rawBody, sigHeader)));
      }
      if (id === "resilience" && operation === "reset" && method === "POST") {
        const { integrationId } = await body(req, z.object({ integrationId: z.string().min(2).max(64) }).strict());
        return json(res, { view: await guard(() => integrationService.resetResilience(integrationId)) });
      }
      if (id === "migrate-connectors" && !operation && method === "POST") {
        requireOperator();
        const data = await body(req, z.object({ connectorId: z.string().min(1).max(64).optional() }).strict());
        const results = await guard(() => migrateLegacyConnectors(connectorStore, integrationTasks, integrationService, data.connectorId));
        return json(res, { results, view: integrationService.view() });
      }
    }
    if (resource === "pzn" && inspectorEnabled) {
      const invokePzn = async <T>(toolRef: string, opName: string, payload: unknown, fallback: () => T) => {
        if (runtime) {
          return runtime.executePznTool<T>(principalId, toolRef, opName, payload);
        }
        return { data: fallback(), summary: opName, sfieldRunId: "offline", sfieldToolRef: toolRef };
      };
      const pznGate = (operation: string, args: Record<string, unknown>, requester?: string) => (
        pznGateFor(approvalStore.getPolicy(), operation).gated
          ? requestPznApproval(approvalStore, selfServicePzn, { operation, args, requester: requireOperator() })
          : null
      );
      const pendingResponse = (approval: ApprovalRecord) => json(res, {
        status: "pending_approval", approval, workspace: selfServicePzn.getWorkspaceState(),
      }, 202);
      if (id === "sfield-tools" && !operation && method === "GET") {
        return json(res, { tools: pznRegisteredSfieldTools, runtimeConnected: Boolean(runtime) });
      }
      if (id === "workspace" && !operation && method === "GET") {
        const out = await invokePzn(pznSfieldToolRefs.ruleMetadata, "get_workspace", {}, () => selfServicePzn.getWorkspaceState());
        return json(res, out.data);
      }
      if (id === "namespaces" && !operation && method === "POST") {
        const data = await body(req, pznNamespaceInputSchema, 32 * 1024);
        const pendingNs = pznGate("upsert_namespace", data);
        if (pendingNs) return pendingResponse(pendingNs);
        const out = await invokePzn(pznSfieldToolRefs.dataDictionary, "upsert_namespace", data, () => selfServicePzn.upsertNamespace(data));
        return json(res, { namespace: out.data, sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      }
      if (id === "namespaces" && operation === "delete" && method === "POST") {
        const { id: nsId } = await body(req, z.object({ id: pznSlugSchema }).strict());
        const pendingNsDel = pznGate("delete_namespace", { id: nsId });
        if (pendingNsDel) return pendingResponse(pendingNsDel);
        const out = await invokePzn(pznSfieldToolRefs.dataDictionary, "delete_namespace", { id: nsId }, () => { selfServicePzn.deleteNamespace(nsId); return { deleted: true }; });
        return json(res, { sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      }
      if (id === "attributes" && !operation && method === "POST") {
        const data = await body(req, pznAttributeInputSchema, 32 * 1024);
        const pendingAttr = pznGate("upsert_attribute", data);
        if (pendingAttr) return pendingResponse(pendingAttr);
        const out = await invokePzn(pznSfieldToolRefs.dataDictionary, "upsert_attribute", data, () => selfServicePzn.upsertAttribute(data));
        return json(res, { attribute: out.data, sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      }
      if (id === "attributes" && operation === "delete" && method === "POST") {
        const { namespaceId, attributeId } = await body(req, z.object({ namespaceId: pznSlugSchema, attributeId: pznSlugSchema }).strict());
        const pendingAttrDel = pznGate("delete_attribute", { namespaceId, attributeId });
        if (pendingAttrDel) return pendingResponse(pendingAttrDel);
        const out = await invokePzn(pznSfieldToolRefs.dataDictionary, "delete_attribute", { namespaceId, attributeId }, () => { selfServicePzn.deleteAttribute(namespaceId, attributeId); return { deleted: true }; });
        return json(res, { sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      }
      if (id === "contents" && !operation && method === "POST") {
        const data = await body(req, pznTextContentInputSchema, 32 * 1024);
        const out = await invokePzn(pznSfieldToolRefs.ruleMetadata, "upsert_content", data, () => selfServicePzn.upsertContent(data));
        return json(res, { content: out.data, sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      }
      if (id === "contents" && operation === "delete" && method === "POST") {
        const { contentId } = await body(req, z.object({ contentId: pznSlugSchema }).strict());
        const pendingContentDel = pznGate("delete_content", { contentId });
        if (pendingContentDel) return pendingResponse(pendingContentDel);
        const out = await invokePzn(pznSfieldToolRefs.ruleMetadata, "delete_content", { contentId }, () => { selfServicePzn.deleteContent(contentId); return { deleted: true }; });
        return json(res, { sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      }
      if (id === "rules" && !operation && method === "POST") {
        const data = await body(req, pznRuleInputSchema, 32 * 1024);
        const out = await invokePzn(pznSfieldToolRefs.ruleMetadata, "upsert_rule", data, () => selfServicePzn.upsertRule(data));
        return json(res, { rule: out.data, sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      }
      if (id === "rules" && operation === "delete" && method === "POST") {
        const { ruleId } = await body(req, z.object({ ruleId: pznSlugSchema }).strict());
        const pendingRuleDel = pznGate("delete_rule", { ruleId });
        if (pendingRuleDel) return pendingResponse(pendingRuleDel);
        const out = await invokePzn(pznSfieldToolRefs.ruleMetadata, "delete_rule", { ruleId }, () => { selfServicePzn.deleteRule(ruleId); return { deleted: true }; });
        return json(res, { sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      }
      if (id === "rules" && operation === "test" && method === "POST") {
        const data = await body(req, pznRuleTestRequestSchema, 32 * 1024);
        const out = await invokePzn(pznSfieldToolRefs.ruleMetadata, "test_rule", data, () => selfServicePzn.testRule(data));
        return json(res, out.data);
      }
      if (id === "contexts" && !operation && method === "POST") {
        const data = await body(req, pznContextInputSchema, 32 * 1024);
        const out = await invokePzn(pznSfieldToolRefs.ruleMetadata, "upsert_context", data, () => selfServicePzn.upsertContext(data));
        return json(res, { context: out.data, sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      }
      if (id === "contexts" && operation === "publish" && method === "POST") {
        enforceEvalGate("publishing a PZN context");
        const data = await body(req, z.object({
          contextId: pznSlugSchema,
          publishedBy: z.string().max(80).optional(),
          notes: z.string().max(240).optional(),
        }).strict());
        const pendingPublish = pznGate("publish_context", data, data.publishedBy);
        if (pendingPublish) return pendingResponse(pendingPublish);
        const out = await invokePzn(pznSfieldToolRefs.ruleMetadata, "publish_context", data, () => selfServicePzn.publishContext(data.contextId, data.publishedBy, data.notes));
        return json(res, { publication: out.data, sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      }
      if (id === "contexts" && operation === "unpublish" && method === "POST") {
        const { contextId } = await body(req, z.object({ contextId: pznSlugSchema }).strict());
        const pendingCtx = pznGate("unpublish_context", { contextId });
        if (pendingCtx) return pendingResponse(pendingCtx);
        const out = await invokePzn(pznSfieldToolRefs.ruleMetadata, "unpublish_context", { contextId }, () => selfServicePzn.unpublishContext(contextId));
        return json(res, { context: out.data, sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      }
      if (id === "contexts" && operation === "delete" && method === "POST") {
        const { contextId } = await body(req, z.object({ contextId: pznSlugSchema }).strict());
        const pendingCtx = pznGate("delete_context", { contextId });
        if (pendingCtx) return pendingResponse(pendingCtx);
        const out = await invokePzn(pznSfieldToolRefs.ruleMetadata, "delete_context", { contextId }, () => { selfServicePzn.deleteContext(contextId); return { deleted: true }; });
        return json(res, { sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      }
      if (id === "ts" && operation === "evaluate" && method === "POST") {
        const data = await body(req, pznTsEvaluateRequestSchema, 32 * 1024);
        const out = await invokePzn(pznSfieldToolRefs.treatmentSelector, "evaluate", data, () => selfServicePzn.evaluateLiveTs(data));
        return json(res, out.data);
      }
      if (id === "copilot" && !operation && method === "POST") {
        const data = await body(req, pznCopilotRequestSchema, 48 * 1024);
        return json(res, await runSelfServicePznCopilot(data, selfServicePzn, {
          gateway: options.gateway,
          dataDir: options.dataDir,
          requestApproval: (operation: string, args: Record<string, unknown>) => pznGate(operation, args),
          ...(runtime ? {
            executeSfieldTool: <T>(toolRef: string, opName: string, payload?: unknown) => (
              runtime.executePznTool<T>(principalId, toolRef, opName, payload)
            ),
          } : {}),
        }));
      }
    }
    if (resource === "events" && !id && method === "POST") {
      const data = await body(req, eventBody);
      const { turn } = store.experience(data.experienceId, principalId, viewer);
      const thread = store.conversation(turn.scope.conversationId, principalId, viewer);
      requireThread(thread);
      if (thread.audience === "admin" || (!operator && store.hasOperatorContent(thread.id))) requireOperator();
      store.analytics(thread.principalId, data.experienceId, data.eventId, data.type, now());
      return json(res, { received: true });
    }
    const payloadRequest = (resource === "admin" && id === "logs") || (resource === "debug" && id === "payloads");
    const traceRequest = (resource === "admin" && id === "inspector") || (resource === "debug" && id === "turns");
    if (inspectorEnabled && (payloadRequest || traceRequest) && operation && method === "GET") {
      const turn = store.ownTurn(operation, principalId, viewer);
      const conversation = store.conversation(turn.scope.conversationId, principalId, viewer);
      requireThread(conversation);
      if (payloadRequest) {
        const payloads = await runtime?.payloads(turn, conversation);
        return json(res, payloads ?? {
          turnId: turn.public.id, topicScores: null, router: null, glossary: null, retirementAccounts: null, treatment: null,
          portfolio: null, goal: null, composer: null, workflow: null,
        });
      }
      return json(res, {
        turnId: turn.public.id, personaId: conversation.personaId, scenarioId: conversation.scenarioId, ordinal: turn.ordinal,
        chatScope: { tenantId: conversation.tenantId, domainId: conversation.domainId, userId: conversation.userId, threadId: conversation.id },
        catalog: turn.catalog ? { id: turn.catalog.snapshotId, ...turn.catalog.catalog } : null,
        propensity: turn.propensity ?? null,
        selectedContextId: turn.route?.contextId ?? turn.decision?.contextId ?? null, routeDecisionId: turn.route?.routeDecisionId ?? null,
        contentDecisionId: turn.decision?.decisionId ?? null,
        catalogScopeId: turn.catalogScopeId ?? null, tsScopeId: turn.tsScopeId ?? null,
        glossaryScopeId: turn.glossaryScopeId ?? null,
        portfolioScopeId: turn.portfolioScopeId ?? null,
        portfolioReadSucceeded: Boolean(turn.portfolioSnapshot),
        goalScopeId: turn.goalScopeId ?? null,
        goalReadSucceeded: Boolean(turn.goalProgress),
        routerRunId: turn.attempts.route?.runId ?? null, composerRunId: turn.attempts.compose?.runId ?? null,
        metricReadSucceeded: Boolean(turn.proof),
        ...(turn.agentRunId && { agentic: runtime?.decisionTrace(turn) }),
        ...turn.trace,
      });
    }
    throw new ApiError(404, "not_found", "This route is unavailable.");
  }

  try {
    if (options.dev) {
      const { createServer: createVite } = await import("vite");
      vite = await createVite({ root: options.projectRoot, server: { middlewareMode: true, hmr: { server } }, appType: "spa" });
    }
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); accept(); });
    });
    experience.reconcile();
    experience.startWatchChecks();
  } catch (error) {
    await vite?.close();
    await experience.close();
    throw error;
  }

  return {
    url: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    /** For tests: direct access to the sfield runtime and approval store (e.g. to call tools with forged approvals). */
    internals: { runtime, approvalStore, telemetry, piiFirewall, workflowEngine, connectorStore, integrationService, handoffStore, knowledgeBase, evalRunner },
    async close() {
      for (const stream of streams) stream.end();
      await vite?.close();
      await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
      await experience.close();
      tradeStore.close();
      workflowEngine.close();
      scheduledJobs.close();
      selfServicePzn.close();
      unregisterLlmEgressContext(options.dataDir);
      if (getActiveCustomerProfileStore() === profileStore) setActiveCustomerProfileStore(null);
      if (getActiveEquityLedger() === tradeStore) setActiveEquityLedger(null);
      if (getActiveExperienceRegistryStore() === experienceRegistry) setActiveExperienceRegistryStore(null);
    },
  };
}
