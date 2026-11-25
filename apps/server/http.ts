import { uiDesignSchema, uiLayoutChangeSchema } from "../../packages/contracts/ui-layout";
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
import { PiiFirewallStore, scrubWithPiiFirewall } from "./pii-firewall";
import { piiFirewallConfigSchema } from "../../packages/contracts/pii-firewall";
import { UxEvolutionStore } from "./ux-evolution";
import { extractDocumentAction } from "./document-extractor";
import { OmnichannelStore } from "./omnichannel-store";
import { omnichannelConfigSchema } from "../../packages/contracts/omnichannel";
import { EvalRunnerStore } from "./eval-runner";
import { renderCepEmbedSdkScript, renderHostPortalDemoHtml } from "./embed-sdk";
import { WriteAuditStore } from "./write-audit";
import { recommendationArbitrateToolRef } from "../../packages/contracts/recommendation-provider";
import { connectorInvokeToolRef, domainWriteToolRef, Runtime, sfieldNamespace } from "./runtime";
import { WidgetLibraryStore } from "./widget-library";
import { SelfServicePznStore } from "./self-service-pzn-store";
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
import { type Bootstrap } from "../../packages/contracts/api";
import type { SelectionMode } from "../../packages/contracts/domain";
import { actionBody, conversationChangeBody, createBody, eventBody, idPattern, messageBody, previewFundingBody, retryBody } from "../../packages/contracts/http-inputs";
import { pendingActionsContext, workspacePinsSchema } from "../../packages/contracts/workspace";
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

type Options = {
  dataDir: string;
  gateway: GatewaySettings | null;
  projectRoot: string;
  port?: number;
  dev?: boolean;
  mode?: "live" | "test";
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
const pagePaths = new Set(["/", "/chat", "/wealth", "/it-ops", "/revops", "/recommendations", "/embed", "/login", "/planning", "/__test/a2ui", ...Object.values(adminPaths)]);

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body<T>(req: IncomingMessage, schema: z.ZodType<T>, limit = 12 * 1024): Promise<T> {
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
  const now = Date.now;
  const widgetLibrary = new WidgetLibraryStore(options.dataDir);
  const selfServicePzn = new SelfServicePznStore(options.dataDir);
  const profileStore = new CustomerProfileStore(options.dataDir);
  setActiveCustomerProfileStore(profileStore);
  const experienceRegistry = new ExperienceRegistryStore(options.dataDir);
  setActiveExperienceRegistryStore(experienceRegistry);
  const customer360 = new Customer360Service(options.dataDir);
  const selectionMode = options.selectionMode ?? "semantic_rerank";
  const inspectorEnabled = options.inspectorEnabled ?? true;
  const profile = options.gateway?.profile;
  const sessionCookie = profile === "openai" ? "pzn_openai_session" : profile === "copilot_acp" ? "pzn_copilot_session" : "pzn_session";
  const sessionPattern = new RegExp("(?:^|;\\s*)" + sessionCookie + "=(local_[a-f0-9]{32})(?:;|$)");
  const portfolioSnapshots = options.portfolioSnapshots ?? fixturePortfolioSnapshotProvider;
  const goalProgressProvider = options.goalProgressProvider ?? fixtureGoalProgressProvider;
  async function loadBootstrapPersonas(principalId: string): Promise<Bootstrap["personas"]> {
    return Promise.all(profileStore.list().map(async ({
      personaId, displayName, allowedScenarios, beneficiaryStatus, accountFundingStatus, syntheticMid,
    }) => {
      const [portfolio, homeGoal] = await Promise.all([
        fixturePortfolioSnapshotProvider.read(syntheticMid),
        fixtureGoalProgressProvider.read(syntheticMid),
      ]);
      return {
        personaId, displayName, allowedScenarios,
        pins: store.workspacePins(principalId, personaId),
        profile: {
          beneficiaryStatus: beneficiaryStatusSchema.parse(beneficiaryStatus),
          accountFundingStatus: accountFundingStatusSchema.parse(
            store.axe.fundingStatus({ principalId, personaId }) ?? accountFundingStatus,
          ),
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
  function buildExperienceRegistryView(principalId: string): ExperienceRegistryView {
    const layouts = store.listUiLayouts(principalId);
    const publishedIntentIds = new Set(
      layouts.flatMap((l) => (l.published ? l.published.design.targets.filter((t) => t.kind === "intent").map((t) => t.id) : [])),
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
  const piiFirewall = new PiiFirewallStore(options.dataDir, (options.mode ?? "live") !== "test");
  const uxEvolution = new UxEvolutionStore(options.dataDir);
  const evalRunner = new EvalRunnerStore(options.dataDir);
  const tradeStore = new TradeStore(options.dataDir, profileStore);
  const scheduledJobs = new ScheduledJobStore(options.dataDir, {
    profileStore, tradeStore, opsStore, salesStore, proactiveStore,
  });
  if ((options.mode ?? "live") !== "test") scheduledJobs.startTicker();
  setActiveEquityLedger(tradeStore);
  const writeAudit = new WriteAuditStore(options.dataDir);
  store.setDomainBindingContext(() => ({ incident: opsStore.primaryIncident(), deal: salesStore.primaryDeal() }));
  const registry = new CapabilityRegistry(store);
  const sfieldPath = join(options.dataDir, "sfield.sqlite");
  const offline = options.gateway ? undefined : new SqlitePersistence({ path: sfieldPath });
  let runtime: Runtime | null;
  try {
    runtime = options.gateway
      ? await Runtime.open(store, sfieldPath, options.gateway, now, inspectorEnabled, portfolioSnapshots, goalProgressProvider, options.goalBudget, {
          customer360, opsStore, salesStore, profileStore, writeAudit, connectorStore, selfServicePzn, approvalStore,
        })
      : null;
    await offline?.init({ namespace: sfieldNamespace, ownerId: newId("owner") });
  } catch (error) {
    store.close();
    throw error;
  }
  const mode = options.mode ?? "live";
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

  const experience = new ExperienceService(store, runtime, selectionMode, now, inspectorEnabled, offline && {
    chat: new ChatHarness(offline), close: () => offline.close(),
  }, {
    mode, gateway: options.gateway, dataDir: options.dataDir, customer360, portfolioSnapshots, goalProgressProvider,
    opsStore, salesStore, connectorStore, approvalStore, tradeStore, actionFlowStore, workflowEngine, knowledgeBase, widgetLibrary, piiFirewall,
    onTradeSettle: makeTradeSettler,
  });

  async function executeApprovedRecord(principalId: string, record: ApprovalRecord) {
    if (record.targetKind === "pzn_change") {
      const args = (record.payload.args && typeof record.payload.args === "object" ? record.payload.args : {}) as Record<string, unknown>;
      const operation = record.action;
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
      summary = `Updated Customer 360 bindings: ${applied.updatedFields.join(", ") || "none"}`;
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
    if (!pathname.startsWith("/api/")) {
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
    if (created) res.setHeader("Set-Cookie", sessionCookie + "=" + principalId + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000");

    const [resource, id, operation, extra] = pathname.slice(5).split("/");
    if (extra !== undefined || (id && !idPattern.test(id)) || (operation && !idPattern.test(operation))) {
      throw new ApiError(404, "not_found", "This item is unavailable.");
    }
    const method = req.method;
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
      const state: Bootstrap = {
        conversations: store.conversations(principalId).filter((conversation) => adminBootstrap || conversation.audience !== "admin"),
        personas: await loadBootstrapPersonas(principalId),
        scenarios: tsFixtures.scenarios.map(({ scenarioId, label }) => ({ scenarioId, label })),
        intentPrompts,
        defaultPersonaId: demo.defaultPersonaId, defaultScenarioId: demo.defaultScenarioId,
        gatewayConfigured: Boolean(runtime), mode, selectionMode, inspectorEnabled,
        ...(options.gateway?.profile === "openai" && { openAiModel: options.gateway.model }),
        ...(options.gateway?.profile === "copilot_acp" && { copilotModel: options.gateway.model }),
      };
      return json(res, state);
    }
    const workspacePersona = resource === "workspace" && id ? profileStore.findByPersonaId(id) : undefined;
    if (workspacePersona) {
      const { personaId } = workspacePersona;
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
        if (runtime) {
          const governed = await runtime.executeGovernedWrite(principalId, {
            domain: "customer360",
            recordId: personaId,
            action: "apply_bindings",
            actor: workspacePersona.displayName,
            updates,
          }, AbortSignal.timeout(5000));
          return json(res, {
            updatedFields: Object.keys(updates),
            sfieldRunId: governed.sfieldRunId,
            auditId: governed.audit?.auditId,
          });
        }
        const applied = profileStore.applyBindings(personaId, updates, now());
        const audit = writeAudit.record({
          sfieldRunId: "offline",
          sfieldToolRef: domainWriteToolRef,
          domain: "customer360",
          recordId: personaId,
          action: "apply_bindings",
          actor: workspacePersona.displayName,
          summary: `Updated Customer 360 bindings: ${applied.updatedFields.join(", ") || "none"}`,
          status: "succeeded",
        });
        return json(res, { updatedFields: applied.updatedFields, auditId: audit.auditId });
      }
    }
    if (resource === "admin" && inspectorEnabled && !operation) {
      const toolSetupLimit = 768 * 1024;
      if (id === "pending-action-logs" && method === "GET") return json(res, store.workspaceActionLogs(principalId));
      if (id === "conversations" && method === "POST") {
        const { personaId, scenarioId } = await body(req, createBody);
        const conversation = experience.createConversation(principalId, personaId, scenarioId, "admin");
        return json(res, { ...presentConversation(conversation), turns: [] }, 201);
      }
      if (id === "ui-layouts" && method === "GET") {
        return json(res, { layouts: store.listUiLayouts(principalId), targets: uiTargetOptions(registry, principalId) });
      }
      if (id === "ui-layouts" && method === "POST") {
        const change = await body(req, uiLayoutChangeSchema, 32 * 1024);
        if (change.operation !== "unpublish") validateUiDesign(change.design, uiTargetOptions(registry, principalId), change.operation === "publish");
        return json(res, store.changeUiLayout(principalId, change, now()));
      }
      if (id === "ui-layout-preview" && method === "POST") {
        const previewBody = await body(req, z.union([
          z.object({ design: uiDesignSchema, personaId: z.string().regex(idPattern).optional() }).strict(),
          uiDesignSchema,
        ]), 32 * 1024);
        const design = "design" in previewBody ? previewBody.design : previewBody;
        const personaId = "design" in previewBody ? previewBody.personaId : undefined;
        validateUiDesign(design, uiTargetOptions(registry, principalId), false);
        return json(res, await previewUiLayout(design, personaId, {
          incident: opsStore.primaryIncident(),
          deal: salesStore.primaryDeal(),
        }));
      }
      if (id === "ui-layout-generate" && method === "POST") {
        const { prompt } = await body(req, z.object({ prompt: z.string().trim().min(4).max(800) }).strict(), 8 * 1024);
        const validTargets = uiTargetOptions(registry, principalId);
        const customKeys = [...new Set(profileStore.list().flatMap((p) => (p.customAttributes ?? []).map((a) => `custom.${a.key}`)))];
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
        return json(res, { widgets: widgetLibrary.list(principalId, now()) });
      }
      if (id === "widget-generate" && method === "POST") {
        const input = await body(req, widgetGenerateRequestSchema, 6 * 1024 * 1024);
        const generated = await generateWidgetFromMultimodal(input, options.gateway, options.dataDir);
        return json(res, generated);
      }
      if (id === "widgets" && method === "POST") {
        const change = await body(req, widgetLibraryChangeSchema, 32 * 1024);
        return json(res, widgetLibrary.change(principalId, change, now()));
      }
      if (id === "customers" && method === "GET") {
        return json(res, { customers: listAdminCustomers(principalId) });
      }
      if (id === "customers" && method === "POST") {
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
        return json(res, buildExperienceRegistryView(principalId));
      }
      if (id === "registry-intent" && method === "POST") {
        const input = await body(req, managedIntentInputSchema, 16 * 1024);
        if (!activeContexts.some((c) => c.contextId === input.contextId)) {
          throw new ApiError(400, "invalid_context", "Choose an active Treatment Selector context.");
        }
        experienceRegistry.upsertIntent(input);
        return json(res, buildExperienceRegistryView(principalId));
      }
      if (id === "registry-intent-delete" && method === "POST") {
        const { intentId } = await body(req, z.object({ intentId: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/) }).strict());
        experienceRegistry.deleteOrResetIntent(intentId);
        return json(res, buildExperienceRegistryView(principalId));
      }
      if (id === "registry-content" && method === "POST") {
        const input = await body(req, managedContentInputSchema, 32 * 1024);
        experienceRegistry.upsertContent(input);
        return json(res, buildExperienceRegistryView(principalId));
      }
      if (id === "registry-content-delete" && method === "POST") {
        const { contentId } = await body(req, z.object({ contentId: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/) }).strict());
        experienceRegistry.deleteOrResetContent(contentId);
        return json(res, buildExperienceRegistryView(principalId));
      }
      if (id === "registry-nba" && method === "POST") {
        const input = await body(req, managedNbaRuleInputSchema, 16 * 1024);
        experienceRegistry.upsertNbaRule(input);
        return json(res, buildExperienceRegistryView(principalId));
      }
      if (id === "registry-nba-reorder" && method === "POST") {
        const { orderedIds } = await body(req, z.object({ orderedIds: z.array(z.string().min(1)).min(1).max(30) }).strict());
        experienceRegistry.reorderNbaRules(orderedIds);
        return json(res, buildExperienceRegistryView(principalId));
      }
      if (id === "registry-nba-delete" && method === "POST") {
        const { id: ruleId } = await body(req, z.object({ id: z.string().regex(/^nba_[a-z0-9_]{3,40}$/) }).strict());
        experienceRegistry.deleteOrResetNbaRule(ruleId);
        return json(res, buildExperienceRegistryView(principalId));
      }
      if (id === "evaluation" && method === "GET") {
        return json(res, { mode, rows: await runtime?.evaluation(principalId) ?? [] });
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
      if (id === "tools" && method === "GET") {
        const setup = store.toolSetup(principalId);
        res.setHeader("ETag", toolSetupTag(setup));
        return json(res, toolSetupView(setup));
      }
      if (id === "tools" && method === "POST") {
        const setup = await body(req, toolSetupSchema, toolSetupLimit);
        validateToolSetup(setup);
        const tag = toolSetupTag(setup);
        const expected = req.headers["if-match"];
        if (expected !== undefined) {
          const current = toolSetupTag(store.toolSetup(principalId));
          if (expected !== current && tag !== current) {
            throw new ApiError(412, "tool_setup_changed", "Tool settings changed. Reload Tool setup to review the latest settings.");
          }
        }
        store.saveToolSetup(principalId, setup);
        res.setHeader("ETag", tag);
        return json(res, setup);
      }
      if (id === "treatment-preview" && method === "POST") {
        return json(res, await previewTreatmentSelector(await body(req, treatmentPreviewSchema, toolSetupLimit), portfolioSnapshots));
      }
      if (id === "ccre-rules" && method === "POST") {
        const rule = await body(req, mockCcreRuleSchema, toolSetupLimit);
        const current = store.toolSetup(principalId);
        const updated = addCcreRule(current, rule);
        if (updated !== current) store.saveToolSetup(principalId, updated);
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
        const input = await body(req, z.object({ mode: z.enum(["deterministic", "live_llm"]).optional() }).strict());
        const evalMode = input.mode ?? "deterministic";
        return json(res, await evalRunner.runSuite({
          mode: evalMode,
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
        return json(res, scheduledJobs.upsert(input));
      }
      if (id === "scheduled-jobs-run" && method === "POST") {
        const { id: jobId } = await body(req, z.object({ id: z.string().regex(idPattern) }).strict());
        try {
          return json(res, scheduledJobs.runJob(jobId, "manual"));
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
        const existingWidgets = widgetLibrary.list(principalId, now());
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
            principalId,
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
        const { personaId, scenarioId } = await body(req, createBody);
        const conversation = experience.createConversation(principalId, personaId, scenarioId);
        return json(res, { ...presentConversation(conversation), turns: [] }, 201);
      }
      if (id) {
        const conversation = store.conversation(id, principalId);
        if (conversation.audience === "admin" && !inspectorEnabled) throw new ApiError(404, "not_found", "This conversation is unavailable.");
        if (method === "GET" && !operation) {
          return json(res, { ...presentConversation(conversation), turns: await experience.conversationTurns(conversation) });
        }
        if (method === "POST" && operation === "settings") {
          return json(res, store.changeConversation(id, principalId, await body(req, conversationChangeBody), now()));
        }
        if (method === "POST" && operation === "preview-funding") {
          const { clientRequestId, source } = await body(req, previewFundingBody);
          return json(res, experience.previewWorkspaceFunding(conversation, clientRequestId, source), 202);
        }
        if (method === "POST" && operation === "turns") {
          const { message, clientRequestId } = await body(req, messageBody);
          const fresh = store.conversation(conversation.id, principalId);
          return json(res, experience.submit(fresh, message, clientRequestId), 202);
        }
      }
    }
    if (resource === "turns" && id) {
      const turn = store.ownTurn(id, principalId);
      if (!inspectorEnabled && store.conversation(turn.scope.conversationId, principalId).audience === "admin") {
        throw new ApiError(404, "not_found", "This message is unavailable.");
      }
      if (method === "GET" && !operation) return json(res, await experience.turnView(turn));
      if (method === "POST" && operation === "cancel") return json(res, experience.cancel(turn));
      if (method === "POST" && operation === "retry") {
        const { clientRequestId } = await body(req, retryBody);
        return json(res, await experience.retry(store.ownTurn(id, principalId), clientRequestId), 202);
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
          const live = store.ownTurn(id, principalId);
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
      const { envelope, clientRequestId } = await body(req, actionBody);
      return json(res, experience.followUp(principalId, id, envelope, clientRequestId), 202);
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
      const actor = rawInput.actor ?? "CEP Operator";
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
        return json(res, proactiveStore.view());
      }
      if (id === "trigger" && !operation && method === "POST") {
        const input = await body(req, proactiveTriggerInputSchema, 8 * 1024);
        return json(res, proactiveStore.trigger(input), 201);
      }
      if (id && operation === "dismiss" && method === "POST") {
        return json(res, proactiveStore.dismiss(id));
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
        const unsubscribe = proactiveStore.subscribe((alert) => {
          if (!res.writableEnded) {
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
      if (id && operation === "portfolio" && method === "GET") {
        return json(res, tradeStore.snapshotFor(id));
      }
      if (id === "tax-harvest" && !operation && method === "POST") {
        const input = await body(req, taxHarvestPreviewInputSchema);
        try {
          return json(res, tradeStore.analyzeTaxHarvest(input.personaId, input.symbol, input.shares));
        } catch (err) {
          throw new ApiError(400, "tax_harvest_invalid", err instanceof Error ? err.message : "Could not run tax-loss harvesting analysis.");
        }
      }
      if (id === "jobs" && !operation && method === "POST") {
        const input = await body(req, tradeJobCreateInputSchema);
        const legs = input.legs.map((l) => ({ ...l, symbol: l.symbol.toUpperCase(), reason: l.reason ?? "primary" as const }));
        const grossCents = tradeStore.estimateGrossCents(input.personaId, legs);
        if (!input.bypassApprovalGate && approvalStore.shouldGateTrade(grossCents)) {
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
            requester: input.actor ?? "Customer",
            dualControl: policy.defaultDualControl,
          });
          return json(res, { status: "pending_approval", approval, approvalsView: approvalStore.view() }, 202);
        }
        try {
          const job = tradeStore.startTradeJob(input, makeTradeSettler(principalId));
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
      const decisionInput = await body(req, approvalDecisionInputSchema);
      const outcome = approvalStore.decide(id, decisionInput);
      if (!outcome.ok) {
        throw new ApiError(outcome.status, outcome.code, outcome.message);
      }
      if (outcome.record.status === "denied") {
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
      const data = await body(req, incidentDecisionInputSchema.extend({ queueForApproval: z.boolean().optional() }));
      const existingInc = opsStore.findById(id);
      if (!existingInc) throw new ApiError(404, "not_found", "Incident not found.");
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
          payload: { decision: data.decision, ...(data.note ? { note: data.note } : {}) },
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
      const data = await body(req, dealDecisionInputSchema.extend({ queueForApproval: z.boolean().optional() }));
      const existingDeal = salesStore.list().find((d) => d.id.toLowerCase() === id.toLowerCase());
      if (!existingDeal) throw new ApiError(404, "not_found", "Deal not found.");
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
          payload: { decision: data.decision, ...(data.note ? { note: data.note } : {}) },
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
    if (resource === "pzn" && inspectorEnabled) {
      const invokePzn = async <T>(toolRef: string, opName: string, payload: unknown, fallback: () => T) => {
        if (runtime) {
          return runtime.executePznTool<T>(principalId, toolRef, opName, payload);
        }
        return { data: fallback(), summary: opName, sfieldRunId: "offline", sfieldToolRef: toolRef };
      };
      const pznGate = (operation: string, args: Record<string, unknown>, requester?: string) => (
        pznGateFor(approvalStore.getPolicy(), operation).gated
          ? requestPznApproval(approvalStore, selfServicePzn, { operation, args, requester })
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
      store.analytics(principalId, data.experienceId, data.eventId, data.type, now());
      return json(res, { received: true });
    }
    const payloadRequest = (resource === "admin" && id === "logs") || (resource === "debug" && id === "payloads");
    const traceRequest = (resource === "admin" && id === "inspector") || (resource === "debug" && id === "turns");
    if (inspectorEnabled && (payloadRequest || traceRequest) && operation && method === "GET") {
      const turn = store.ownTurn(operation, principalId);
      const conversation = store.conversation(turn.scope.conversationId, principalId);
      if (payloadRequest) {
        const payloads = await runtime?.payloads(turn, conversation);
        return json(res, payloads ?? {
          turnId: turn.public.id, topicScores: null, router: null, glossary: null, treatment: null,
          portfolio: null, goal: null, composer: null, workflow: null,
        });
      }
      return json(res, {
        turnId: turn.public.id, personaId: conversation.personaId, scenarioId: conversation.scenarioId, ordinal: turn.ordinal,
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
  } catch (error) {
    await vite?.close();
    await experience.close();
    throw error;
  }

  return {
    url: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    async close() {
      for (const stream of streams) stream.end();
      await vite?.close();
      await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
      await experience.close();
      tradeStore.close();
      workflowEngine.close();
      scheduledJobs.close();
      selfServicePzn.close();
      if (getActiveCustomerProfileStore() === profileStore) setActiveCustomerProfileStore(null);
      if (getActiveEquityLedger() === tradeStore) setActiveEquityLedger(null);
      if (getActiveExperienceRegistryStore() === experienceRegistry) setActiveExperienceRegistryStore(null);
    },
  };
}
