import { randomUUID } from "node:crypto";
import { domainPackIds, type DomainPackId } from "../../packages/contracts/domain-packs";
import { createPinnedCardSchema, type PinnedLiveCard } from "../../packages/contracts/pinned-cards";
import { inferPinnedCardToolRefs, refreshPinnedCardLive } from "./pinned-cards-live";
import { ExperienceComposerEngine } from "./experience-composer";
import { PznDecisionPlane } from "./pzn-decision-plane";
import { runSketchToUi, sketchToUiRequestSchema } from "./sketch-to-ui";
import { createStudioHandler } from "@sfield/studio";
import { handleAdminStudioRoutes, isExperienceRegistryEndpoint } from "./routes/admin-studio";
import { handleCollaborationAndProtocolRoutes } from "./routes/collaboration";
import { handleDomainsOpsSalesRoutes } from "./routes/domains-ops-sales";
import { handleIntegrationsAndPznRoutes } from "./routes/integrations-pzn";
import { handleWorkflowsAndConnectorsRoutes } from "./routes/workflows-connectors";
import { domainMemberships, serverTenantId, tenantCookie, tenantDataDirectory } from "./tenant";
import { flowOverridesSchema, flowScopeSchema, type FlowScope } from "../../packages/contracts/routing-flows";
import { recordIntentOption, layoutTargetDomain, uiDesignSchema, uiLayoutChangeSchema } from "../../packages/contracts/ui-layout";
import { widgetGenerateRequestSchema, widgetLibraryChangeSchema } from "../../packages/contracts/widget";
import { previewUiLayout, uiTargetOptions, validateUiDesign } from "./ui-layouts";
import { SphotonCatalogService } from "./sphoton-catalog";
import { Customer360Service } from "./customer-360";
import { dataBindingKeySchema } from "../../packages/smass";
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
import { PublicationReviews, type PublicationResult } from "./publication-reviews";
import { studioPublicationPlans } from "./studio-publications";
import { approvalDecisionInputSchema, approvalPolicySettingsSchema, type ApprovalRecord } from "../../packages/contracts/approval";
import { TradeStore, type SettlementCallback } from "./trade-store";
import { taxHarvestPreviewInputSchema, tradeJobCreateInputSchema, type TradeLegInput } from "../../packages/contracts/trading";
import { ActionFlowStore } from "./action-flow-store";
import { actionFlowUpsertSchema } from "../../packages/contracts/action-flow";
import { WorkflowEngine } from "./workflow-engine";
import { workflowDefinitionUpsertSchema } from "../../packages/contracts/workflow-definition";
import { generateWorkflowWithLlm } from "./workflow-generator";
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
import { HandoffStore } from "./handoff-store";
import { coBrowseSlidersSchema, createHandoffInputSchema } from "../../packages/contracts/handoff";
import { buildA2aAgentCard, cepMcpExtensionStore, handleCepMcpRequest } from "./cep-mcp-server";
import { McpExposureStore, mcpExposureConfigSchema, STANDALONE_SFIELD_MCP_TOOLS } from "./mcp-exposure-store";
import { agUiRunInputSchema, streamAgUiRun } from "./ag-ui";
import { WatchcardStore } from "./watchcard-store";
import { CustomerGoalStore } from "./goal-store";
import { AgentDelegationStore } from "./agent-delegation";
import {
  createDelegationPassInputSchema,
  createWatchcardInputSchema,
  runNegotiationInputSchema,
  scenarioPlanInputSchema,
} from "../../packages/contracts/nextgen-chat";
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
import { ChatHarness, digestJson, newId } from "@sfield/core";
import { SqlitePersistence } from "@sfield/store-sqlite";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, extname, sep } from "node:path";
import type { AddressInfo } from "node:net";
import type { ViteDevServer } from "vite";
import { z } from "zod";
import demo from "../../fixtures/host.json";
import type { Bootstrap, Conversation, TurnView } from "../../packages/contracts/api";
import { contentComponentCatalog, type SelectionMode } from "../../packages/contracts/domain";
import { actionBody, conversationChangeBody, createBody, eventBody, folderCreateBody, folderRenameBody, folderUpdateBody, forkBody, idPattern, messageBody, previewFundingBody, retryBody } from "../../packages/contracts/http-inputs";
import { accountPortalPath, pendingActionsContext, workspacePinsSchema, type PortalFundingView, type WorkspaceActionState } from "../../packages/contracts/workspace";
import { adminPaths, isAdminPath } from "../../packages/contracts/admin-paths";
import { mockCcreRuleSchema, toolSetupSchema, treatmentPreviewSchema } from "../../packages/contracts/tool-setup";
import { createDefaultTsAdapterFactory, createTreatmentSelectorRecommendationProvider, tsFixtures, type TsAdapterFactory } from "../../packages/ts-adapter";
import type { RecommendationProvider } from "../../packages/contracts/recommendation-provider";
import { RecommendationProviderRegistry } from "../../packages/recommendations";
import { fixturePortfolioHistory, fixturePortfolioSnapshotProvider, type PortfolioSnapshotProvider } from "../../packages/portfolio-snapshot";
import { fixtureGoalProgressProvider, type GoalProgressProvider } from "../../packages/goal-progress";
import type { GatewaySettings } from "./gateway";
import { ApiError, Store, presentConversation } from "./store";
import { ExperienceService } from "./service";
import { addCcreRule, previewTreatmentSelector, toolSetupTag, toolSetupView, validateToolSetup } from "./tool-setup";
import { readWorkspacePendingActions } from "./workspace-actions";

import { operatorAccess } from "./operator-access";
import { configDigest, GatewayConfigStore, gatewayConfigSchema, mergeStoredKey, testGatewayConfig, type GatewayConfig } from "./gateway-config";

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
  /**
   * Optional pluggable RecommendationProviders (e.g. Treatment Selector, custom REST/MCP
   * recommenders, or `[]` to run CEP without any built-in TS provider).
   * When omitted, registers the default Treatment Selector provider.
   */
  recommendationProviders?: RecommendationProvider[];
  /** @deprecated Prefer `recommendationProviders: [createTreatmentSelectorRecommendationProvider(factory)]`. */
  tsAdapterFactory?: TsAdapterFactory;
  goalBudget?: ExecutionBudget;
};
const beneficiaryStatusSchema = z.enum(["missing", "on_file"]);
const accountFundingStatusSchema = z.enum(["funded", "unfunded"]);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
};
const pagePaths = new Set(["/", "/chat", "/wealth", "/advisor", "/it-ops", "/revops", "/recommendations", "/integrations", "/embed", "/login", "/planning", accountPortalPath, ...Object.values(adminPaths)]);

function visibleTurn(turn: TurnView, operator?: string): TurnView {
  if (operator) return turn;
  const { semanticRoute, customerLookup, emotionalState, providerArbitration, piiRedaction, ...customerTurn } = turn;
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
  const isStandaloneDoc = pathname === "/sfield-sdk.html";
  if (!pagePaths.has(pathname) && !pathname.startsWith("/assets/") && !isStandaloneDoc) {
    throw new ApiError(404, "not_found", "This page is unavailable.");
  }
  const path = resolve(root, "." + (pathname.startsWith("/assets/") || isStandaloneDoc ? decodeURIComponent(pathname) : "/index.html"));
  if (!path.startsWith(root + sep)) throw new ApiError(404, "not_found", "This file is unavailable.");
  if (!await stat(path).then((entry) => entry.isFile(), () => false)) {
    throw new ApiError(503, "build_unavailable", "Build the web app before starting this server.");
  }
  const framePolicy = pathname === "/embed"
    ? "frame-ancestors 'self' http://127.0.0.1:* http://localhost:* https:"
    : "frame-ancestors 'none'";
  const scriptPolicy = isStandaloneDoc ? " script-src 'self' 'unsafe-inline';" : "";
  res.writeHead(200, {
    "Content-Type": MIME[extname(path)] ?? "application/octet-stream",
    "Cache-Control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store",
    "Content-Security-Policy": `default-src 'self';${scriptPolicy} style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; ${framePolicy}`,
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
  const pznDecisionPlane = new PznDecisionPlane();
  const experienceComposer = new ExperienceComposerEngine(
    undefined,
    () => [
      ...widgetLibraries.wealth.list("default-workspace", Date.now()),
      ...widgetLibraries.it_ops.list("default-workspace", Date.now()),
      ...widgetLibraries.sales_revops.list("default-workspace", Date.now()),
    ],
    options.dataDir,
  );
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
  const recommendationRegistry = new RecommendationProviderRegistry(
    options.recommendationProviders ?? [
      createTreatmentSelectorRecommendationProvider(options.tsAdapterFactory ?? createDefaultTsAdapterFactory()),
    ],
  );
  async function loadBootstrapPersonas(principalId: string, allowed: (id: string) => boolean, selected?: string): Promise<Bootstrap["personas"]> {
    return Promise.all(profileStore.list().filter(({ personaId }) => allowed(personaId)).map(async ({
      personaId, displayName, allowedScenarios, beneficiaryStatus, accountFundingStatus, syntheticMid, notes,
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
          ...(notes ? { notes } : {}),
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
    const contentLayouts = new Map(layouts.flatMap(({ id, revision, design }) => design.targets.flatMap((target) =>
      target.kind === "content" ? [[target.id, { id, revision, name: design.name }] as const] : [])));
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
      publishedLayout: contentLayouts.get(rawEntry.contentId),
      linkedContexts: Object.entries(tsFixtures.base)
        .filter(([, ids]) => ids.includes(rawEntry.contentId))
        .map(([ctxId]) => ctxId),
      rawEntry,
    }));
    return {
      tenantId: serverTenantId, domainId: "wealth", componentOptions: contentComponentCatalog, contexts, intents, content,
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
  const mcpExposure = new McpExposureStore(options.dataDir);
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
  const watchcardStore = new WatchcardStore(options.dataDir);
  const agentDelegation = new AgentDelegationStore(options.dataDir);
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
          customer360, opsStore, salesStore, profileStore, writeAudit, connectorStore, selfServicePzn, approvalStore, integrationTasks, piiFirewall, telemetry, recommendationRegistry,
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
  const sphotonCatalog = new SphotonCatalogService({
    tenantId: serverTenantId,
    dataDir: options.dataDir,
    getRuntime: () => runtime,
    integrationService,
    goalProgressProvider,
    portfolioSnapshots,
    opsStore,
    salesStore,
  });
  const goalStore = new CustomerGoalStore(tenantDataDirectory(options.dataDir));
  workflowEngine.setIntegrationService(integrationService);
  const gatewayView = () => gatewayConfig.view(options.gateway, Boolean(options.onGatewayActivated), options.launchGatewaySource);
  const restartGateway = () => {
    if (options.onGatewayActivated) setTimeout(() => options.onGatewayActivated?.(), 250);
  };
  const requireGatewayTest = (config: GatewayConfig) => {
    const last = gatewayConfig.read().lastTest;
    if (!last?.ok || last.configDigest !== configDigest(config) || Date.now() - Date.parse(last.testedAt) > 30 * 60_000) {
      throw new ApiError(409, "test_required", "Test this exact configuration successfully (within the last 30 minutes) before activating it.");
    }
  };
  const publicationReviews = new PublicationReviews(
    approvalStore,
    {
      ...studioPublicationPlans({ store, registry, widgetLibraries, experienceRegistry, integrationService, integrationTasks, workflowEngine,
        actionFlowStore, connectorStore, knowledgeBase, uxEvolution, verticalFactory, sphotonCatalog, now }),
      "gateway-activate"(candidate) {
        const { id } = z.object({ id: z.string().length(64) }).strict().parse(candidate);
        const state = gatewayConfig.read();
        if (!state.pending || state.pending.id !== id) {
          throw new ApiError(409, "publication_changed", "The prepared gateway configuration changed. Submit a new review.");
        }
        const { config } = state.pending;
        requireGatewayTest(config);
        return {
          recordId: "model-gateway", title: `Activate model gateway · ${config.model}`, current: state.active,
          details: [{ label: "Provider", value: config.provider }, { label: "Model", value: config.model.slice(0, 160) }],
          apply: (actor) => {
            gatewayConfig.activate(config, actor);
            restartGateway();
            return { summary: `Activated model gateway ${config.model}.`, value: { activated: true, restarting: Boolean(options.onGatewayActivated), view: gatewayView() } };
          },
        };
      },
      "gateway-reset"() {
        return {
          recordId: "model-gateway", title: "Restore launcher gateway settings", current: gatewayConfig.active(),
          apply: () => {
            gatewayConfig.reset();
            restartGateway();
            return { summary: "Restored the gateway settings from the app launcher.", value: { reset: true, restarting: Boolean(options.onGatewayActivated), view: gatewayView() } };
          },
        };
      },
      "sfield-lock"(candidate) {
        const input = z.object({ digest: z.string().min(1).max(128), comment: z.string().max(240).optional() }).strict().parse(candidate);
        const sf = runtime?.sfieldInstance;
        if (!sf || sf.config.digest() !== input.digest) {
          throw new ApiError(409, "publication_changed", "The active sfield configuration changed. Submit a new review.");
        }
        return {
          recordId: "sfield-config", title: "Approve sfield configuration", current: sf.config.digest(),
          details: [{ label: "Configuration fingerprint", value: input.digest }],
          preview: sf.config.lock(),
          apply: async (actor) => {
            await sf.lock.approve({ ...input, approver: actor, noBaseline: true });
            return { summary: "Recorded approval for this sfield configuration." };
          },
        };
      },
    },
    (actor) => [
      ...membership.authoring(actor),
      ...(membership.isTenantAdmin(actor) ? ["tenant" as const] : []),
    ],
    enforceEvalGate,
  );
  const experience = new ExperienceService(store, runtime, selectionMode, now, inspectorEnabled, offline && {
    chat: new ChatHarness(offline), close: () => offline.close(),
  }, {
    isTenantAdmin: membership.isTenantAdmin,
    gateway: options.gateway, dataDir: options.dataDir, customer360, profileStore, portfolioSnapshots, goalProgressProvider,
    opsStore, salesStore, connectorStore, approvalStore, tradeStore, actionFlowStore, workflowEngine, knowledgeBase, widgetLibraries, piiFirewall,
    goalStore, integrationService, onTradeSettle: makeTradeSettler,
    mayReviewApproval: (actor, record) => publicationReviews.mayReview(actor, record),
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
    if (record.targetKind === "publication") {
      const actor = record.decidedBy ?? record.requester;
      const plan = publicationReviews.planForApproval(record, actor);
      const claim = approvalStore.claimForExecution(record.id);
      if (!claim.ok) throw new ApiError(409, claim.code, claim.message);
      let applied: PublicationResult;
      try {
        applied = await plan.apply(actor);
      } catch (err) {
        approvalStore.releaseClaim(record.id);
        throw err;
      }
      const summary = applied.summary.slice(0, 320);
      const audit = writeAudit.record({
        sfieldRunId: "offline", sfieldToolRef: record.sfieldToolRef, domain: record.domain,
        recordId: record.recordId, action: record.action, actor, summary, status: "succeeded", approvalId: record.id,
      });
      const execution = { summary, sfieldRunId: "offline", auditId: audit.auditId };
      return { approval: approvalStore.markExecuted(record.id, execution) ?? record, execution: { ...execution, value: applied.value } };
    }
    if (record.targetKind === "task_publish") {
      const ref = typeof record.payload.ref === "string" ? record.payload.ref : record.recordId;
      enforceEvalGate("publishing an integration task contract");
      const candidate = integrationTasks.contract(ref);
      if (!candidate || candidate.status !== "draft" || candidate.contractDigest !== record.payload.contractDigest
        || candidate.bindingDigest !== record.payload.bindingDigest
        || digestJson(integrationTasks.integration(candidate.integrationId) ?? null) !== record.payload.integrationDigest) {
        throw new ApiError(409, "publication_changed", "The task or its connection changed. Submit a new review.");
      }
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
  const sfieldStudioHandler = createStudioHandler({
    runtime: runtime?.sfieldInstance,
    telemetry: telemetry.otelSink,
    mcpExtensionStore: cepMcpExtensionStore,
    title: "sfield Studio · CEP",
    basePath: "/admin/sfield-studio",
    approvalChatPath: adminPaths.chat,
    plugins: [
      { id: "pzn-studio", label: "Self-Service PZN Studio", description: "Treatment Selector & CCRE rule authoring", badge: "CEP", href: "/recommendations" },
      { id: "customer-360", label: "Customer 360 Admin", description: "Wealth profiles, balances, goals & NBA preview", badge: "Wealth", href: adminPaths.customers },
      { id: "ui-builder", label: "UI Builder & Widgets", description: "Bind custom A2UI layouts & Copilot widgets", badge: "A2UI", href: adminPaths.builder },
      { id: "integrations", label: "Integrations Workspace", description: "Task contracts, connectors & MCP discovery", badge: "MCP", href: "/integrations" },
      { id: "cep-logs", label: "CEP Admin Logs", description: "Turn-level payloads, TS decisions & inspector", badge: "CEP", href: adminPaths.logs },
    ],
  });
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
    if (pathname === "/admin/sfield-studio" || pathname.startsWith("/admin/sfield-studio/")) {
      requireOperator();
      if (req.method !== "GET" && ((req.headers.origin && req.headers.origin !== origin) || req.headers["sec-fetch-site"] === "cross-site")) {
        throw new ApiError(403, "origin_unavailable", "Use the local demo address.");
      }
      if (pathname === "/admin/sfield-studio/api/locks/approve" && req.method === "POST") {
        const data = await body(req, z.object({ digest: z.string().min(1).max(128), comment: z.string().max(240).optional() }));
        return json(res, publicationReviews.request("sfield-lock", data, {
          scope: "tenant", principalId: "sfield-studio", operator: requireOperator(),
        }), 202);
      }
      await sfieldStudioHandler(req, res);
      return;
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
      const thread = experience.createConversation(principalId, personaId, input.scenarioId ?? demo.defaultScenarioId, audience, input.domainId, operator, test && { tools: test.setup }, input.folderId);
      return json(res, { ...presentConversation(thread), turns: [] }, 201);
    };
    const internalApi = ["admin", "debug", "pzn", "approvals", "connectors", "ops", "ops-incidents", "sales", "sales-deals", "workflows", "workflow-runs", "mcp", "ag-ui"].includes(resource)
      || (resource === "integrations" && id !== "demo-mcp" && id !== "callbacks")
      || (resource === "proactive" && id === "trigger");
    if (internalApi) {
      const actor = requireOperator();
      const domainAdmin = resource === "admin" && (isExperienceRegistryEndpoint(id) || ["routing-flows", "ui-layouts", "ui-binding-catalog", "domain-models", "ui-layout-preview", "ui-layout-test", "ui-layout-generate", "widgets", "widget-generate",
        "customers", "bootstrap", "conversations", "logs", "inspector", "tools", "ccre-rules", "treatment-preview", "treatment-runs"].includes(id));
      const domainApproval = resource === "approvals" && id !== "policy";
      const domainApi = domainAdmin || domainApproval || ["debug", "ops", "ops-incidents", "sales", "sales-deals"].includes(resource);
      if (!domainApi && !membership.isTenantAdmin(actor)) throw new ApiError(403, "tenant_admin_required", "This setting requires a tenant administrator.");
    }
    if (["ops", "ops-incidents"].includes(resource)) requireChatDomain("it_ops", "");
    if (["sales", "sales-deals"].includes(resource)) requireChatDomain("sales_revops", "");
    const adminBootstrap = resource === "admin" && id === "bootstrap" && !operation && inspectorEnabled;
    if (method === "GET" && ((resource === "bootstrap" && !id) || adminBootstrap)) {
      const domain = url.searchParams.get("domain");
      const parsedDomain = z.enum(domainPackIds).safeParse(domain ?? "wealth");
      if (!parsedDomain.success) throw new ApiError(400, "domain_invalid", "Choose an available domain.");
      const activeDomain = parsedDomain.data;
      const intentPrompts = activeDomain === "wealth" && (!operator || membership.library(operator).includes("wealth"))
        ? experienceRegistry.listIntents().filter((item) => item.enabled && item.samplePhrases.length > 0).map((item) => ({
          intentId: item.intentId,
          label: item.label,
          prompt: item.samplePhrases[0],
          isCustom: !item.isBuiltIn || item.isCustomized,
        }))
        : [];
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
        folders: store.listFolders(principalId, adminBootstrap && domain === null ? undefined : activeDomain),
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
        return json(res, await readWorkspacePendingActions(store, principalId, workspacePersona, portfolioSnapshots, inspectorEnabled, now(), recommendationRegistry));
      }
      if (operation === "action-state" && method === "GET") {
        const conversationId = store.workspaceFundingConversation(principalId, personaId, viewer, Boolean(operator));
        const fact = store.axe.fundingFact({ principalId, personaId });
        const completed = fact || (conversationId && workspacePersona.accountFundingStatus === "funded");
        return json(res, {
          funding: completed ? { status: "completed", conversationId, confirmedAt: typeof fact === "object" ? fact.occurredAt : undefined }
            : conversationId ? { status: "in_progress", conversationId } : null,
          todos: selectedProfile === personaId ? store.workspaceTodos(personaId) : null,
        } satisfies WorkspaceActionState);
      }
      if (operation === "todos" && method === "POST") {
        if (selectedProfile !== personaId) throw new ApiError(403, "profile_required", "Sign in to manage your to-do list.");
        const { operation: command, contentId } = await body(req, z.object({
          operation: z.enum(["save", "remove"]), contentId: z.string().regex(idPattern),
        }).strict());
        if (command === "remove") store.removeWorkspaceTodo(personaId, contentId);
        else if (!store.workspaceTodos(personaId).some((item) => item.contentId === contentId)) {
          const items = await readWorkspacePendingActions(store, principalId, workspacePersona, portfolioSnapshots, inspectorEnabled, now(), recommendationRegistry);
          const item = items.find((action) => action.contentId === contentId);
          if (!item) throw new ApiError(409, "pending_action_unavailable", "This action is no longer available to save.");
          store.saveWorkspaceTodo(personaId, item);
        }
        return json(res, store.workspaceTodos(personaId));
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
    if (await handleCollaborationAndProtocolRoutes({
      req, res, url, origin, resource, id, operation, method, principalId, operator, viewer,
      inspectorEnabled, streams, store, runtime, gateway: options.gateway ?? null, dataDir: options.dataDir,
      experience, profileStore, approvalStore, writeAudit, handoffStore, watchcardStore,
      agentDelegation, knowledgeBase, integrationService, mcpExposure, sphotonCatalog, now, json, body, requireOperator,
    })) return;
    if (resource === "admin" && id === "gateway" && inspectorEnabled) {
      const actor = requireOperator();
      const parseConfig = async () => {
        const { config } = await body(req, z.object({ config: z.record(z.string(), z.unknown()) }).strict(), 32 * 1024);
        const parsed = gatewayConfigSchema.safeParse(config);
        if (!parsed.success) throw new ApiError(400, "invalid_gateway_config", parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ").slice(0, 400));
        return mergeStoredKey(parsed.data, gatewayConfig.active());
      };
      if (!operation && method === "GET") return json(res, gatewayView());
      if (operation === "test" && method === "POST") {
        const config = await parseConfig();
        const result = await testGatewayConfig(config, { dataDir: options.dataDir, capacityCheck: checkGatewayCapacity });
        gatewayConfig.saveTest(result);
        return json(res, result);
      }
      if (operation === "activate" && method === "POST") {
        if (!membership.isTenantAdmin(actor)) throw new ApiError(403, "domain_access_denied", "Tenant settings access is required.");
        enforceEvalGate("activating a new LLM Gateway configuration");
        const config = await parseConfig();
        requireGatewayTest(config);
        const id = gatewayConfig.stage(config);
        return json(res, publicationReviews.request("gateway-activate", { id }, { scope: "tenant", principalId, operator: actor }), 202);
      }
      if (operation === "reset" && method === "POST") {
        return json(res, publicationReviews.request("gateway-reset", {}, { scope: "tenant", principalId, operator: actor }), 202);
      }
      throw new ApiError(404, "not_found", "This item is unavailable.");
    }
    if (await handleAdminStudioRoutes({
      req, res, url, origin, resource, id, operation, method, principalId, viewer, inspectorEnabled,
      store, runtime, gateway: options.gateway ?? null, dataDir: options.dataDir, experience,
      registry, membership, portfolioSnapshots, goalProgressProvider, recommendationRegistry, opsStore, salesStore,
      profileStore, customer360, publicationReviews, widgetLibrary, widgetLibraries,
      omnichannelStore, evalRunner, uxEvolution, tradeStore, approvalStore, connectorStore,
      workflowEngine, writeAudit, mcpExposure, integrationService, knowledgeBase, scheduledJobs,
      verticalFactory, piiFirewall, sphotonCatalog, now, json, body, requireOperator, requireChatDomain,
      authoringDomain, createChat, listAdminCustomers, buildExperienceRegistryView,
    })) return;
    if (resource === "goals") {
      const goalPersona = url.searchParams.get("personaId") || demo.defaultPersonaId;
      if (method === "GET" && !id) {
        return json(res, { goals: goalStore.list(goalPersona) });
      }
      if (method === "POST" && !id) {
        const input = await body(req, z.object({
          personaId: z.string().trim().min(1).max(64).default(demo.defaultPersonaId),
          name: z.string().trim().min(1).max(64),
          category: z.enum(["home", "retirement", "education", "emergency", "travel", "custom"]).default("custom"),
          targetCents: z.number().int().positive(),
          savedCents: z.number().int().nonnegative().default(0),
          monthlyContributionCents: z.number().int().nonnegative().default(50_000),
          targetDate: z.string().trim().max(32).optional(),
        }).strict());
        let sfieldRunId: string | undefined;
        let auditId: string | undefined;
        const actor = profileStore.list().find((p) => p.personaId === input.personaId)?.displayName ?? "Customer";
        if (runtime) {
          try {
            const governed = await runtime.executeGovernedWrite(principalId, {
              domain: "customer360",
              recordId: input.personaId,
              action: "create_financial_goal",
              actor,
              note: `Created goal "${input.name}" ($${Math.round(input.targetCents / 100).toLocaleString("en-US")} target)`,
              updates: { [`goal.${input.category}`]: `${input.name} ($${Math.round(input.targetCents / 100)})` },
            }, AbortSignal.timeout(4000));
            sfieldRunId = governed.sfieldRunId;
            auditId = governed.audit?.auditId;
          } catch {
            // Fall back to direct audit if runtime is unavailable
          }
        }
        const goal = goalStore.create({ ...input, sfieldRunId }, now());
        if (!auditId) {
          const audit = writeAudit.record({
            sfieldRunId: sfieldRunId ?? "local",
            sfieldToolRef: domainWriteToolRef,
            domain: "customer360",
            recordId: goal.id,
            action: "create_financial_goal",
            actor,
            summary: `Created goal "${goal.name}" ($${Math.round(goal.targetCents / 100).toLocaleString("en-US")})`,
            status: "succeeded",
          });
          auditId = audit.auditId;
        }
        return json(res, { goal, goals: goalStore.list(input.personaId), sfieldRunId, auditId }, 201);
      }
      if (id && method === "POST" && operation === "update") {
        const input = await body(req, z.object({
          personaId: z.string().trim().min(1).max(64).default(demo.defaultPersonaId),
          name: z.string().trim().min(1).max(64).optional(),
          targetCents: z.number().int().positive().optional(),
          savedCents: z.number().int().nonnegative().optional(),
          monthlyContributionCents: z.number().int().nonnegative().optional(),
          targetDate: z.string().trim().max(32).optional(),
        }).strict());
        const updated = goalStore.update(id, input.personaId, input, now());
        if (!updated) throw new ApiError(404, "goal_not_found", "Goal not found.");
        return json(res, { goal: updated, goals: goalStore.list(input.personaId) });
      }
      if (id && method === "POST" && operation === "delete") {
        const input = await body(req, z.object({
          personaId: z.string().trim().min(1).max(64).default(demo.defaultPersonaId),
        }).strict());
        const deleted = goalStore.delete(id, input.personaId);
        if (!deleted) throw new ApiError(404, "goal_not_found", "Goal not found.");
        return json(res, { deleted: true, goals: goalStore.list(input.personaId) });
      }
    }
    if (resource === "pinned-cards") {
      const resolveOwnerKey = (domainId: DomainPackId, personaId?: string) =>
        domainId === "wealth" ? `persona:${personaId || demo.defaultPersonaId}` : `domain:${domainId}`;
      const parseDomainParam = (raw?: string | null): DomainPackId =>
        raw === "it_ops" || raw === "sales_revops" || raw === "wealth" ? raw : "wealth";
      const refreshDeps = {
        portfolioSnapshots,
        goalProgressProvider,
        opsStore,
        salesStore,
        now,
      };
      if (method === "GET" && !id) {
        const domainId = parseDomainParam(url.searchParams.get("domain"));
        const personaId = url.searchParams.get("personaId") || undefined;
        const ownerKey = resolveOwnerKey(domainId, personaId);
        const live = url.searchParams.get("live") !== "0";
        const stored = store.listPinnedCards(ownerKey, domainId);
        const cards = live
          ? await Promise.all(stored.map(async (c) => {
              const fresh = await refreshPinnedCardLive(c, refreshDeps);
              store.savePinnedCard(ownerKey, fresh);
              return fresh;
            }))
          : stored;
        return json(res, { cards });
      }
      if (method === "POST" && !id) {
        const input = await body(req, createPinnedCardSchema, 192 * 1024);
        const ownerKey = resolveOwnerKey(input.domainId, input.personaId);
        const exp = input.experience as unknown as import("../../packages/contracts/surface").DisplayExperience;
        const toolRefs = input.toolRefs?.length ? input.toolRefs : inferPinnedCardToolRefs(exp, input.domainId);
        const timestamp = now();
        const card: PinnedLiveCard = {
          id: "pin_" + randomUUID().replace(/-/g, "").slice(0, 14),
          domainId: input.domainId,
          ...(input.personaId ? { personaId: input.personaId } : {}),
          title: input.title,
          prompt: input.prompt,
          ...(input.sourceTurnId ? { sourceTurnId: input.sourceTurnId } : {}),
          toolRefs,
          experience: exp,
          createdAt: timestamp,
          refreshedAt: timestamp,
          liveBacked: toolRefs.length > 0,
        };
        store.savePinnedCard(ownerKey, card);
        return json(res, { card, cards: store.listPinnedCards(ownerKey, input.domainId) }, 201);
      }
      if (id && method === "POST" && operation === "refresh") {
        const input = await body(req, z.object({
          domainId: z.enum(domainPackIds).default("wealth"),
          personaId: z.string().trim().min(1).max(80).optional(),
        }).strict());
        const ownerKey = resolveOwnerKey(input.domainId, input.personaId);
        const existing = store.getPinnedCard(id, ownerKey);
        if (!existing) throw new ApiError(404, "pinned_card_not_found", "Pinned card not found.");
        const refreshed = await refreshPinnedCardLive(existing, refreshDeps);
        store.savePinnedCard(ownerKey, refreshed);
        return json(res, { card: refreshed, cards: store.listPinnedCards(ownerKey, input.domainId) });
      }
      if (id && ((method === "POST" && operation === "delete") || method === "DELETE")) {
        const input = method === "POST"
          ? await body(req, z.object({
              domainId: z.enum(domainPackIds).default("wealth"),
              personaId: z.string().trim().min(1).max(80).optional(),
            }).strict())
          : {
              domainId: parseDomainParam(url.searchParams.get("domain")),
              personaId: url.searchParams.get("personaId") || undefined,
            };
        const ownerKey = resolveOwnerKey(input.domainId, input.personaId);
        const deleted = store.deletePinnedCard(id, ownerKey);
        if (!deleted) throw new ApiError(404, "pinned_card_not_found", "Pinned card not found.");
        return json(res, { deleted: true, cards: store.listPinnedCards(ownerKey, input.domainId) });
      }
    }
    if (resource === "sketch-to-ui" && !id && method === "POST") {
      const input = await body(req, sketchToUiRequestSchema, 5_500_000);
      const personaId = input.personaId ?? demo.defaultPersonaId;
      const result = await runSketchToUi(
        { ...input, personaId },
        {
          gateway: options.gateway ?? null,
          dataDir: options.dataDir,
          portfolioSnapshots,
          goalProgressProvider,
          opsStore,
          salesStore,
          now,
        },
      );
      let conv = input.conversationId
        ? (() => {
            try { return store.conversation(input.conversationId, principalId, viewer); } catch { return undefined; }
          })()
        : undefined;
      if (!conv) {
        const userId = input.domainId === "wealth" ? personaId : (operator ?? principalId);
        conv = store.createConversation(
          principalId,
          personaId,
          demo.defaultScenarioId,
          now(),
          undefined,
          input.domainId,
          userId,
        );
      }
      const userMessage = input.prompt?.trim()
        ? `Sketch to Dashboard (${input.imageName || "drawing.png"}): ${input.prompt.trim()}`
        : `Sketch to Dashboard (${input.imageName || "drawing.png"})`;
      const accepted = store.accept({
        conversation: conv,
        message: userMessage,
        requestId: "sketch_" + randomUUID().replace(/-/g, "").slice(0, 16),
        origin: "message",
        selectionMode: "semantic_rerank",
        now: now(),
      });
      store.update(accepted.turn.public.id, (row) => {
        row.public.actionMode = "dynamic_ui";
        row.trace.components = result.compiled.display.blocks.map(({ component }) => component);
      });
      const finished = store.finish(accepted.turn.public.id, { type: "completed", result: result.compiled }, now());
      const freshConv = store.conversation(conv.id, conv.principalId);
      const turns = await experience.conversationTurns(freshConv);
      return json(res, {
        conversation: { ...presentConversation(freshConv), turns: turns.map((turn) => visibleTurn(turn, operator)) },
        turn: finished?.public ?? accepted.turn.public,
        experience: result.compiled.display,
        widget: result.widget,
        source: result.source,
        sourceSummary: result.sourceSummary,
      }, 201);
    }
    if (resource === "admin" && id === "recent-turns" && !operation && method === "GET" && inspectorEnabled) {
      const recent = store.listAllCompletedTurns(25).map((turn) => {
        const dynBlock = turn.public.experience?.blocks.find((b) => b.component === "PznDynamicCanvas");
        const harnessTrace = dynBlock && dynBlock.component === "PznDynamicCanvas" ? dynBlock.props.harnessTrace : undefined;
        const mode: "intent" | "experience" | "funding" | "harness" = harnessTrace
          ? "harness"
          : turn.agentRunId
            ? "experience"
            : turn.fundingRun || turn.workflow
              ? "funding"
              : "intent";
        return {
          turnId: turn.public.id,
          conversationId: turn.scope.conversationId,
          personaId: turn.scope.personaId,
          domainId: turn.scope.domainId,
          message: turn.public.message,
          createdAt: turn.public.createdAt,
          actionMode: turn.public.actionMode ?? null,
          mode,
          semanticRoute: turn.public.semanticRoute ?? null,
          selectedContextId: turn.route?.contextId ?? turn.decision?.contextId ?? null,
          components: turn.trace.components ?? [],
          routerRunId: turn.attempts.route?.runId ?? null,
          composerRunId: turn.attempts.compose?.runId ?? null,
          agentRunId: turn.agentRunId ?? null,
          routeRun: turn.trace.routeRun ?? null,
          composeRun: turn.trace.composeRun ?? null,
          portfolioReadSucceeded: Boolean(turn.portfolioSnapshot),
          goalReadSucceeded: Boolean(turn.goalProgress),
          metricReadSucceeded: Boolean(turn.proof),
          tsSource: turn.trace.ts?.source ?? null,
          harnessTrace: harnessTrace ?? null,
        };
      });
      return json(res, { turns: recent });
    }
    if (resource === "folders") {
      if (method === "GET" && !id) {
        const domain = url.searchParams.get("domain");
        const parsedDomain = domain ? z.enum(domainPackIds).safeParse(domain) : null;
        return json(res, { folders: store.listFolders(principalId, parsedDomain?.success ? parsedDomain.data : undefined) });
      }
      if (method === "POST" && !id) {
        const input = await body(req, folderCreateBody);
        return json(res, { folder: store.createFolder(principalId, input.domainId, input.name, now(), input.instructions) }, 201);
      }
      if (id && ((method === "POST" && operation === "rename") || (method === "PATCH" && !operation))) {
        const input = await body(req, folderRenameBody);
        return json(res, { folder: store.renameFolder(id, principalId, input.name, now()) });
      }
      if (id && method === "POST" && operation === "update") {
        const input = await body(req, folderUpdateBody);
        return json(res, { folder: store.updateFolder(id, principalId, input, now()) });
      }
      if (id && method === "GET" && operation === "summary") {
        const folder = store.getFolder(id, principalId);
        if (!folder) throw new ApiError(404, "folder_not_found", "Folder not found.");
        const convs = store.folderConversations(id, principalId);
        const threads = convs.map((c) => {
          const turns = store.conversationTurns(c.id);
          const completed = turns.filter((t) => t.public.status === "completed");
          const running = turns.filter((t) => t.public.status === "working");
          const last = turns.at(-1);
          return {
            conversationId: c.id,
            title: c.title,
            updatedAt: c.updatedAt,
            totalTurns: turns.length,
            completedTurns: completed.length,
            runningTurns: running.length,
            lastPrompt: last?.public.message ?? null,
            lastSummary: last?.public.experience?.intro ?? last?.public.experience?.question ?? null,
          };
        });
        return json(res, { folder, threadCount: threads.length, threads });
      }
      if (id && ((method === "POST" && operation === "delete") || (method === "DELETE" && !operation))) {
        return json(res, store.deleteFolder(id, principalId));
      }
    }
    if (resource === "threads" && id === "status" && method === "GET") {
      const personaId = url.searchParams.get("personaId") || demo.defaultPersonaId;
      const currentConversationId = url.searchParams.get("conversationId") || undefined;
      return json(res, await experience.threadStatusOverview({
        principalId,
        personaId,
        viewer,
        operator: Boolean(operator),
        currentConversationId,
      }));
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
        if (method === "GET" && operation === "context") return json(res, await experience.conversationContext(conversation, conversation.principalId));
        if (method === "POST" && operation === "compact") return json(res, await experience.compactConversation(conversation, conversation.principalId));
        if (method === "GET" && !operation) {
          const turns = await experience.conversationTurns(conversation);
          return json(res, { ...presentConversation(conversation), turns: turns.map((turn) => visibleTurn(turn, operator)) });
        }
        if (method === "POST" && operation === "settings") {
          return json(res, store.changeConversation(id, conversation.principalId, await body(req, conversationChangeBody), now()));
        }
        if (method === "POST" && operation === "fork") {
          const input = await body(req, forkBody);
          const forked = store.forkConversation(conversation, conversation.principalId, now(), input.turnId, input.title);
          const turns = await experience.conversationTurns(forked);
          return json(res, { ...presentConversation(forked), turns: turns.map((turn) => visibleTurn(turn, operator)) }, 201);
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
      if (method === "POST" && operation === "portfolio-displayed") {
        store.recordPortfolioDisplay(id, now());
        return json(res, { recorded: true });
      }
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
    if (await handleWorkflowsAndConnectorsRoutes({
      req, res, url, resource, id, operation, method, principalId, operator, selectedProfile,
      customerSession, inspectorEnabled, streams, runtime, gateway: options.gateway ?? null,
      dataDir: options.dataDir, membership, connectorStore, approvalStore, actionFlowStore, publicationReviews,
      workflowEngine, proactiveStore, profileStore, writeAudit, json, body, requireOperator,
    })) return;
    if (await handleDomainsOpsSalesRoutes({
      req, res, resource, id, operation, method, principalId, operator, inspectorEnabled,
      streams, store, runtime, tradeStore, approvalStore, writeAudit, customer360,
      opsStore, salesStore, integrationService, workflowEngine,
      json, body, requireOperator, requireChatDomain, makeTradeSettler, executeApprovedRecord, publicationReviews,
    })) return;
    if (await handleIntegrationsAndPznRoutes({
      req, res, resource, id, operation, method, principalId, inspectorEnabled,
      runtime, gateway: options.gateway ?? null, dataDir: options.dataDir, approvalStore,
      publicationReviews, integrationTasks, integrationService, selfServicePzn, demoMcp,
      json, body, requireOperator, enforceEvalGate,
    })) return;
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
        emotionalState: turn.public.emotionalState ?? null,
        ...(turn.agentRunId && { agentic: runtime?.decisionTrace(turn) }),
        ...turn.trace,
      });
    }
    if (resource === "experience-composer") {
      const channelIdSchema = z.string().min(1).max(64);
      if (id === "bootstrap" && !operation && method === "GET") {
        return json(res, experienceComposer.getBootstrap());
      }
      if (id === "compose" && !operation && method === "POST") {
        const input = await body(
          req,
          z.object({
            experienceId: z.string().min(1).max(80),
            channel: channelIdSchema,
          }).strict(),
        );
        const composed = await experienceComposer.compose(input);
        return json(res, { composed, bootstrap: experienceComposer.getBootstrap() });
      }
      if (id === "create-subject" && !operation && method === "POST") {
        const input = await body(
          req,
          z.object({
            label: z.string().min(2).max(60),
            tagline: z.string().max(160).optional().default(""),
            smassModelId: z.string().max(64).optional(),
            channel: channelIdSchema.optional(),
          }).strict(),
        );
        const created = experienceComposer.createSubjectArea(input);
        const composed = await experienceComposer.compose({
          experienceId: created.experienceId,
          channel: input.channel ?? "chat_turn",
        });
        return json(res, { ...created, composed, bootstrap: experienceComposer.getBootstrap() }, 201);
      }
      if (id === "create-experience" && !operation && method === "POST") {
        const input = await body(
          req,
          z.object({
            subjectArea: z.string().min(1).max(64),
            channel: channelIdSchema.optional(),
            memberName: z.string().min(1).max(80),
            segment: z.string().max(100).optional(),
            label: z.string().min(2).max(80),
            userPrompt: z.string().min(2).max(240),
            mainTitle: z.string().min(2).max(120),
            mainSubtitle: z.string().max(220).optional(),
            primaryMetricLabel: z.string().min(1).max(60),
            primaryMetricDollars: z.number().min(0).max(100_000_000),
            secondaryMetricLabel: z.string().min(1).max(60),
            secondaryMetricDollars: z.number().min(0).max(100_000_000),
            tertiaryMetricLabel: z.string().min(1).max(60),
            tertiaryMetricDollars: z.number().min(0).max(100_000_000),
            taskRuleId: z.string().min(1).max(64),
            taskTitle: z.string().min(2).max(120),
            taskSummary: z.string().min(2).max(260),
            taskCtaLabel: z.string().min(2).max(60),
            taskWorkflowId: z.string().min(2).max(80),
            taskEventName: z.string().min(2).max(80),
            nbaRuleId: z.string().min(1).max(64),
            nbaTitle: z.string().min(2).max(120),
            nbaSummary: z.string().min(2).max(260),
            nbaScore: z.number().min(0.5).max(0.99),
            nbaEstimatedValue: z.string().min(1).max(80),
            nbaCtaLabel: z.string().min(2).max(60),
            nbaWorkflowId: z.string().min(2).max(80),
            followUps: z.array(z.string().max(80)).max(6),
            disclosure: z.string().min(2).max(260),
            uiResolutionMode: z.enum(["pinned_widget", "runtime_tool_selected", "runtime_pzn_selected", "runtime_sphoton_generative"]).optional(),
            attachedUiId: z.string().min(1).max(100).optional(),
          }).strict(),
        );
        const created = experienceComposer.createExperience(input);
        const composed = await experienceComposer.compose({
          experienceId: created.id,
          channel: input.channel ?? "chat_turn",
        });
        return json(res, { experience: created, composed, bootstrap: experienceComposer.getBootstrap() }, 201);
      }
      if (id === "ui-binding" && !operation && method === "POST") {
        const input = await body(
          req,
          z.object({
            experienceId: z.string().min(1).max(80),
            channel: channelIdSchema,
            uiResolutionMode: z.enum(["pinned_widget", "runtime_tool_selected", "runtime_pzn_selected", "runtime_sphoton_generative"]),
            attachedUiId: z.string().min(1).max(100).optional(),
          }).strict(),
        );
        experienceComposer.updateUiBinding(input);
        const composed = await experienceComposer.compose({ experienceId: input.experienceId, channel: input.channel });
        return json(res, { composed, bootstrap: experienceComposer.getBootstrap() });
      }
      if (id === "create-channel" && !operation && method === "POST") {
        const input = await body(
          req,
          z.object({
            label: z.string().min(2).max(60),
            shortLabel: z.string().max(24).optional(),
            description: z.string().max(220).optional(),
            frameMode: z.enum(["chat", "web", "mobile", "advisor"]),
            maxTasks: z.number().int().min(0).max(5),
            maxNba: z.number().int().min(0).max(5),
            maxCompanionTotal: z.number().int().min(0).max(8),
            maxFollowUps: z.number().int().min(0).max(5),
            experienceId: z.string().min(1).max(80).optional(),
          }).strict(),
        );
        const created = experienceComposer.createChannel(input);
        const composed = await experienceComposer.compose({
          experienceId: input.experienceId ?? "wealth-portfolio-summary",
          channel: created.id,
        });
        return json(res, { channel: created, composed, bootstrap: experienceComposer.getBootstrap() }, 201);
      }
      if (id === "execute" && !operation && method === "POST") {
        const input = await body(
          req,
          z.object({
            experienceId: z.string().min(1).max(80),
            channel: channelIdSchema,
            signedActionToken: z.string().min(1).max(2048),
          }).strict(),
        );
        const result = await experienceComposer.executeAction(input);
        if (!result.ok) throw new ApiError(result.status, "composer_action_rejected", result.error);
        return json(res, { composed: result.composed, execution: result.execution, bootstrap: experienceComposer.getBootstrap() });
      }
      if (id === "complete-task" && !operation && method === "POST") {
        const input = await body(
          req,
          z.object({
            experienceId: z.string().min(1).max(80),
            channel: channelIdSchema,
          }).strict(),
        );
        const composed = await experienceComposer.completeTaskEvent(input);
        return json(res, { composed, bootstrap: experienceComposer.getBootstrap() });
      }
      if (id === "dismiss-nba" && !operation && method === "POST") {
        const input = await body(
          req,
          z.object({
            experienceId: z.string().min(1).max(80),
            channel: channelIdSchema,
            nbaId: z.string().min(1).max(80),
          }).strict(),
        );
        const composed = await experienceComposer.dismissNba(input);
        return json(res, { composed, bootstrap: experienceComposer.getBootstrap() });
      }
      if (id === "reset" && !operation && method === "POST") {
        const input = await body(
          req,
          z.object({
            experienceId: z.string().min(1).max(80).optional(),
            channel: channelIdSchema.optional(),
          }).strict(),
        );
        const composed = await experienceComposer.reset(input.experienceId, input.channel);
        return json(res, { composed, bootstrap: experienceComposer.getBootstrap() });
      }
    }
    if (resource === "pzn-demo") {
      if (id === "state" && !operation && method === "GET") {
        return json(res, pznDecisionPlane.getState());
      }
      if (id === "decide" && !operation && method === "POST") {
        const input = await body(
          req,
          z.object({
            mid: z.string().min(1).max(64),
            context: z.enum(["balance", "portsum", "address-update", "pending-actions"]),
            trigger: z.string().min(1).max(64).optional(),
          }).strict(),
        );
        const decision = await pznDecisionPlane.evaluateDecision(input);
        return json(res, { decision, state: pznDecisionPlane.getState() }, 201);
      }
      if (id === "execute" && !operation && method === "POST") {
        const input = await body(
          req,
          z.object({
            decisionId: z.string().min(1).max(120),
            mid: z.string().min(1).max(64),
            signedActionToken: z.string().min(1).max(2048),
          }).strict(),
        );
        const result = await pznDecisionPlane.executeSignedAction(input);
        if (!result.ok) throw new ApiError(result.status, "pzn_action_rejected", result.error);
        return json(res, { decision: result.decision, execution: result.execution, state: pznDecisionPlane.getState() });
      }
      if (id === "confirm-funding" && !operation && method === "POST") {
        const input = await body(
          req,
          z.object({
            decisionId: z.string().min(1).max(120),
            mid: z.string().min(1).max(64),
            simulateStaleVersion: z.boolean().optional(),
          }).strict(),
        );
        const result = await pznDecisionPlane.confirmFundingAndRefresh(input);
        if (!result.ok) throw new ApiError(result.status, "pzn_refresh_failed", result.error);
        return json(res, { ...result, state: pznDecisionPlane.getState() });
      }
      if (id === "rule" && !operation && method === "POST") {
        const input = await body(
          req,
          z.object({
            ruleId: z.string().min(1).max(64),
            enabled: z.boolean().optional(),
            value: z.union([z.string(), z.number()]).optional(),
          }).strict(),
        );
        const result = pznDecisionPlane.updateSharedRule(input.ruleId, {
          ...(input.enabled !== undefined && { enabled: input.enabled }),
          ...(input.value !== undefined && { value: input.value }),
        });
        if (!result.ok) throw new ApiError(400, "smass_rule_validation_failed", result.error);
        return json(res, { rule: result.rule, state: pznDecisionPlane.getState() });
      }
      if (id === "reset" && !operation && method === "POST") {
        return json(res, { state: pznDecisionPlane.reset() });
      }
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
      experienceComposer.close();
      unregisterLlmEgressContext(options.dataDir);
      if (getActiveCustomerProfileStore() === profileStore) setActiveCustomerProfileStore(null);
      if (getActiveEquityLedger() === tradeStore) setActiveEquityLedger(null);
      if (getActiveExperienceRegistryStore() === experienceRegistry) setActiveExperienceRegistryStore(null);
    },
  };
}
