import { interactiveToolInputs, validateInteractiveExperience } from "../interactive-experiences";
/**
 * Admin Studio & Control Plane HTTP routes: UI layouts, widgets, Customer 360 admin,
 * Experience Registry, Capabilities, Routing Flows, Tool Setup, Omnichannel, Evals,
 * Compliance Packet, MCP Server/Discovery, Knowledge Base, Scheduled Jobs, Vertical Packs,
 * PII Firewall, and UX Evolution.
 * Extracted from `apps/server/http.ts` for clean separation of concerns.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import demo from "../../../fixtures/host.json";
import { capabilityIdSchema, capabilityRef, customerEventSchema, versionSchema } from "../../../packages/contracts/agentic";
import { capabilityTools } from "../../../packages/capabilities";
import { customer360ProfileInputSchema, type Customer360AdminRecord } from "../../../packages/contracts/customer-360";
import type { DomainPackId } from "../../../packages/contracts/domain-packs";
import {
  managedContentInputSchema,
  managedIntentInputSchema,
  managedNbaRuleInputSchema,
  type ExperienceRegistryScopes,
  type ExperienceRegistryView,
  type RecordWorkspaceRegistry,
} from "../../../packages/contracts/experience-registry";
import { knowledgeDocumentUpsertSchema } from "../../../packages/contracts/knowledge-base";
import { mcpDiscoverRequestSchema, mcpImportRequestSchema } from "../../../packages/contracts/mcp-discovery";
import { omnichannelConfigSchema } from "../../../packages/contracts/omnichannel";
import { piiFirewallConfigSchema } from "../../../packages/contracts/pii-firewall";
import { flowOverridesSchema, flowScopeSchema, type FlowScope } from "../../../packages/contracts/routing-flows";
import { scheduledJobUpsertSchema } from "../../../packages/contracts/scheduled-jobs";
import { mockCcreRuleSchema, toolSetupSchema, treatmentPreviewSchema } from "../../../packages/contracts/tool-setup";
import { layoutTargetDomain, recordIntentOption, uiDesignSchema, uiLayoutChangeSchema } from "../../../packages/contracts/ui-layout";
import { widgetGenerateRequestSchema, widgetLibraryChangeSchema } from "../../../packages/contracts/widget";
import type { CustomerProfileStore } from "../../../packages/customer-profiles";
import { compileDynamicCanvas, makeId } from "../../../packages/experience/compile";
import type { GoalProgressProvider } from "../../../packages/goal-progress";
import type { PortfolioSnapshotProvider } from "../../../packages/portfolio-snapshot";
import type { RecommendationProviderRegistry } from "../../../packages/recommendations";
import type { ApprovalStore } from "../approval-store";
import type { CapabilityRegistry } from "../capability-registry";
import type { ConnectorStore } from "../connector-store";
import type { Customer360Service } from "../customer-360";
import { generateWidgetFromMultimodal } from "../dynamic-ui-generator";
import type { EvalRunnerStore } from "../eval-runner";
import { simulateCustomerEvent } from "../event-simulator";
import type { GatewaySettings } from "../gateway";
import {
  systemConfigBundleSchema,
  systemConfigKindSchema,
  systemCopilotRequestSchema,
  systemRollbackRequestSchema,
} from "../../../packages/contracts/system-config";
import type { IntegrationTaskService, IntegrationTaskStore } from "../integration-tasks";
import type { SystemConfigStore } from "../system-config-store";
import { handleSystemCopilotMessage, reloadAllControlPlaneStores } from "../system-copilot";
import type { KnowledgeBaseStore } from "../knowledge-base";
import { discoverMcpServer, mcpToolConnector } from "../mcp-discovery";
import { mcpExposureConfigSchema, STANDALONE_SFIELD_MCP_TOOLS, type McpExposureStore } from "../mcp-exposure-store";
import type { OmnichannelStore } from "../omnichannel-store";
import type { OpsIncidentStore } from "../ops-store";
import { scrubWithPiiFirewall, type PiiFirewallStore } from "../pii-firewall";
import type { PublicationReviews } from "../publication-reviews";
import { registryContentDeleteSchema, registryIntentDeleteSchema, registryNbaDeleteSchema, registryNbaOrderSchema } from "../studio-publications";
import type { Runtime } from "../runtime";
import type { SalesDealStore } from "../sales-store";
import type { ScheduledJobStore } from "../scheduled-jobs";
import type { ExperienceService } from "../service";
import { ApiError, type Store } from "../store";
import { serverTenantId } from "../tenant";
import { addCcreRule, previewTreatmentSelector, toolSetupTag, toolSetupView, validateToolSetup } from "../tool-setup";
import type { TradeStore } from "../trade-store";
import { generateBoundUiLayoutWithLlm } from "../ui-layout-generator";
import { previewUiLayout, recordViewOptions, uiTargetOptions, validateUiDesign } from "../ui-layouts";
import {
  customDomainRelationDeleteSchema,
  customDomainRelationInputSchema,
  customVirtualModelDeleteSchema,
  customVirtualModelInputSchema,
  customVirtualModelStatusSchema,
  customVirtualModelTestSchema,
  domainFieldExposureSchema,
  type SphotonCatalogService,
} from "../sphoton-catalog";
import type { UxEvolutionStore } from "../ux-evolution";
import type { VerticalPackStore } from "../vertical-factory";
import type { WidgetLibraryStore } from "../widget-library";
import type { WorkflowEngine } from "../workflow-engine";
import type { WriteAuditStore } from "../write-audit";

const idPattern = /^[A-Za-z0-9._-]{1,80}$/;

const registryChangeSchemas = {
  "registry-intent": managedIntentInputSchema,
  "registry-intent-delete": registryIntentDeleteSchema,
  "registry-content": managedContentInputSchema,
  "registry-content-delete": registryContentDeleteSchema,
  "registry-nba": managedNbaRuleInputSchema,
  "registry-nba-reorder": registryNbaOrderSchema,
  "registry-nba-delete": registryNbaDeleteSchema,
};

export function isExperienceRegistryEndpoint(id: string) {
  return id === "experience-registry" || Object.hasOwn(registryChangeSchemas, id);
}

function recordWorkspaceRegistry(
  domainId: RecordWorkspaceRegistry["domainId"], store: Store, widgets: WidgetLibraryStore, runtime: Runtime | null,
): RecordWorkspaceRegistry {
  const layouts = store.publishedUiLayouts(domainId);
  const layoutByIntent = new Map(layouts.flatMap(({ design }) => design.targets.flatMap(({ kind, id }) =>
    kind === "intent" ? [[id, design.name] as const] : [])));
  const intents: RecordWorkspaceRegistry["intents"] = recordViewOptions(domainId).map(({ target, label, description }) => ({
    id: target.id, label, description, layoutName: layoutByIntent.get(target.id),
  }));
  for (const { id, design } of layouts) {
    if (design.recordIntent) {
      const intent = design.recordIntent;
      intents.push({ id: intent.id, label: intent.label, description: design.description, phrases: intent.phrases, layoutName: design.name });
    }
    if (design.experience?.audience === "operator") {
      for (const action of design.experience.actions) {
        if (action.phrases.length) intents.push({
          id: id + ":" + action.id, label: action.title, description: action.description || design.description,
          phrases: action.phrases, layoutName: design.name,
        });
      }
    }
  }
  const providerDomain = domainId === "it_ops" ? "operations" : "sales";
  return {
    tenantId: serverTenantId, domainId, intents,
    catalog: [
      ...layouts.map(({ id, design, revision }) => ({ id, kind: "layout" as const, title: design.name, description: design.description, revision })),
      ...widgets.publishedWidgets().map(({ id, name, body }) => ({ id, kind: "widget" as const, title: name, description: body })),
    ],
    providers: (runtime?.recommendationProviderDescriptors() ?? []).filter(({ domains }) => domains.includes(providerDomain))
      .map(({ id, label, description }) => ({ id, label, description })),
  };
}

export interface AdminStudioRouteDeps {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  origin: string;
  resource: string;
  id: string | undefined;
  operation: string | undefined;
  method: string | undefined;
  principalId: string;
  viewer: { customer?: string; operator?: string };
  inspectorEnabled: boolean;
  store: Store;
  runtime: Runtime | null;
  gateway: GatewaySettings | null;
  dataDir: string;
  experience: ExperienceService;
  registry: CapabilityRegistry;
  membership: {
    authoring: (actor: string) => DomainPackId[];
    library: (actor: string) => DomainPackId[];
    isTenantAdmin: (actor: string) => boolean;
  };
  portfolioSnapshots: PortfolioSnapshotProvider;
  goalProgressProvider: GoalProgressProvider;
  recommendationRegistry: RecommendationProviderRegistry;
  opsStore: OpsIncidentStore;
  salesStore: SalesDealStore;
  profileStore: CustomerProfileStore;
  customer360: Customer360Service;
  publicationReviews: PublicationReviews;
  widgetLibrary: WidgetLibraryStore;
  widgetLibraries: Record<DomainPackId, WidgetLibraryStore>;
  omnichannelStore: OmnichannelStore;
  evalRunner: EvalRunnerStore;
  uxEvolution: UxEvolutionStore;
  tradeStore: TradeStore;
  approvalStore: ApprovalStore;
  connectorStore: ConnectorStore;
  workflowEngine: WorkflowEngine;
  writeAudit: WriteAuditStore;
  mcpExposure: McpExposureStore;
  integrationService: IntegrationTaskService;
  integrationTasks: IntegrationTaskStore;
  systemConfig: SystemConfigStore;
  knowledgeBase: KnowledgeBaseStore;
  scheduledJobs: ScheduledJobStore;
  verticalFactory: VerticalPackStore;
  piiFirewall: PiiFirewallStore;
  sphotonCatalog: SphotonCatalogService;
  now: () => number;
  json: (res: ServerResponse, data: unknown, status?: number) => void;
  body: <S extends z.ZodTypeAny>(req: IncomingMessage, schema: S, limit?: number) => Promise<z.output<S>>;
  requireOperator: () => string;
  requireChatDomain: (domainId: DomainPackId, personaId: string) => void;
  authoringDomain: () => DomainPackId;
  createChat: (audience?: "admin") => Promise<void>;
  listAdminCustomers: (principalId: string) => Customer360AdminRecord[];
  buildExperienceRegistryView: () => ExperienceRegistryView;
}

export async function handleAdminStudioRoutes(deps: AdminStudioRouteDeps): Promise<boolean> {
  const {
    req, res, url, origin, resource, id, operation, method, principalId, viewer, inspectorEnabled,
    store, runtime, gateway, dataDir, experience, registry, membership, portfolioSnapshots,
    goalProgressProvider, recommendationRegistry, opsStore, salesStore, profileStore, customer360, publicationReviews,
    widgetLibrary, widgetLibraries, omnichannelStore, evalRunner, uxEvolution, tradeStore,
    approvalStore, connectorStore, workflowEngine, writeAudit, mcpExposure, integrationService,
    integrationTasks, systemConfig, knowledgeBase, scheduledJobs, verticalFactory, piiFirewall, sphotonCatalog, now, json, body,
    requireOperator, requireChatDomain, authoringDomain, createChat, listAdminCustomers,
    buildExperienceRegistryView,
  } = deps;

  if (resource !== "admin" || !inspectorEnabled || operation) return false;

  const toolSetupLimit = 768 * 1024;
  const requestReview = (action: string, scope: FlowScope, input: unknown) =>
    json(res, publicationReviews.request(action, input, { scope, principalId, operator: requireOperator() }), 202);
  const experienceTool = (ref: string) => integrationService.interactiveReadContract(ref);
  if (id === "treatment-runs" && method === "GET") {
    const query = z.object({
      personaId: z.string().regex(idPattern),
      context: z.string().regex(idPattern),
      turn: z.string().regex(idPattern).optional(),
    }).safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) throw new ApiError(400, "invalid_query", "Choose a customer and topic.");
    const { personaId, context, turn } = query.data;
    requireChatDomain("wealth", personaId);
    json(res, store.treatmentRuns(principalId, viewer, personaId, context, turn));
    return true;
  }
  if (id === "pending-action-logs" && method === "GET") {
    json(res, store.workspaceActionLogs(principalId));
    return true;
  }
  if (id === "conversations" && method === "POST") {
    await createChat("admin");
    return true;
  }
  const buildDomainLineage = (domainId: DomainPackId) => {
    const uiLayouts = store.publishedUiLayouts(domainId).map((layout) => ({
      name: layout.design.name || layout.id,
      refs: [JSON.stringify(layout.design)],
    }));
    const lib = widgetLibraries[domainId];
    const owner = lib ? lib.authorKey(principalId, requireOperator()) : principalId;
    const widgets = (lib ? lib.list(owner, now()) : []).map((w) => ({
      name: w.name || w.id,
      refs: [JSON.stringify(w)],
    }));
    const setup = store.toolSetup(domainId);
    const ccreRules = (setup.ccreRules ?? []).map((r) => ({
      name: r.name || r.scenarioId,
      refs: [JSON.stringify(r)],
    }));
    return { uiLayouts, widgets, ccreRules };
  };

  if (id === "domain-models" && method === "GET") {
    const domainId = authoringDomain();
    json(res, sphotonCatalog.domainWorkbenchView(domainId, buildDomainLineage(domainId)));
    return true;
  }
  if (id === "domain-models" && method === "POST") {
    const domainId = authoringDomain();
    const spec = await body(req, customVirtualModelInputSchema, 32 * 1024);
    try {
      sphotonCatalog.saveVirtualModel(domainId, spec);
      json(res, sphotonCatalog.domainWorkbenchView(domainId, buildDomainLineage(domainId)));
    } catch (err) {
      throw new ApiError(400, "virtual_model_invalid", err instanceof Error ? err.message : "Could not save virtual model.");
    }
    return true;
  }
  if (id === "domain-models-status" && method === "POST") {
    const domainId = authoringDomain();
    const payload = await body(req, customVirtualModelStatusSchema, 4 * 1024);
    try {
      sphotonCatalog.setVirtualModelStatus(domainId, payload.modelId, payload.status);
      json(res, sphotonCatalog.domainWorkbenchView(domainId, buildDomainLineage(domainId)));
    } catch (err) {
      throw new ApiError(404, "virtual_model_not_found", err instanceof Error ? err.message : "Virtual model not found.");
    }
    return true;
  }
  if (id === "domain-models-delete" && method === "POST") {
    const domainId = authoringDomain();
    const payload = await body(req, customVirtualModelDeleteSchema, 4 * 1024);
    try {
      sphotonCatalog.deleteVirtualModel(domainId, payload.modelId);
      json(res, sphotonCatalog.domainWorkbenchView(domainId, buildDomainLineage(domainId)));
    } catch (err) {
      throw new ApiError(404, "virtual_model_not_found", err instanceof Error ? err.message : "Virtual model not found.");
    }
    return true;
  }
  if (id === "domain-models-test" && method === "POST") {
    const domainId = authoringDomain();
    const payload = await body(req, customVirtualModelTestSchema, 8 * 1024);
    try {
      const snapshot = await sphotonCatalog.materializeVirtualModel(domainId, payload, principalId);
      json(res, { snapshot });
    } catch (err) {
      throw new ApiError(400, "virtual_model_materialize_failed", err instanceof Error ? err.message : "Could not materialize virtual snapshot.");
    }
    return true;
  }
  if (id === "domain-models-relation" && method === "POST") {
    const domainId = authoringDomain();
    const payload = await body(req, customDomainRelationInputSchema, 4 * 1024);
    try {
      sphotonCatalog.saveDomainRelation(domainId, payload);
      json(res, sphotonCatalog.domainWorkbenchView(domainId, buildDomainLineage(domainId)));
    } catch (err) {
      throw new ApiError(400, "domain_relation_invalid", err instanceof Error ? err.message : "Could not save entity relationship.");
    }
    return true;
  }
  if (id === "domain-models-relation-delete" && method === "POST") {
    const domainId = authoringDomain();
    const payload = await body(req, customDomainRelationDeleteSchema, 4 * 1024);
    try {
      sphotonCatalog.deleteDomainRelation(domainId, payload);
      json(res, sphotonCatalog.domainWorkbenchView(domainId, buildDomainLineage(domainId)));
    } catch (err) {
      throw new ApiError(400, "domain_relation_delete_failed", err instanceof Error ? err.message : "Could not delete entity relationship.");
    }
    return true;
  }
  if (id === "ui-binding-catalog" && method === "GET") {
    const domainId = authoringDomain();
    json(res, sphotonCatalog.catalogForDomain(domainId));
    return true;
  }
  if (id === "ui-binding-catalog" && method === "POST") {
    const domainId = authoringDomain();
    const exposure = await body(req, domainFieldExposureSchema, 8 * 1024);
    const descriptor = sphotonCatalog.sfieldAdapter().describeTool(exposure.toolRef);
    if (!descriptor) {
      throw new ApiError(400, "tool_unregistered", `Tool ${exposure.toolRef} is not registered in sfield.`);
    }
    sphotonCatalog.setFieldExposure(domainId, exposure);
    json(res, sphotonCatalog.catalogForDomain(domainId));
    return true;
  }
  if (id === "ui-layouts" && method === "GET") {
    const actor = requireOperator();
    const domains = membership.authoring(actor);
    const visibleDomains = membership.library(actor);
    json(res, {
      tenantId: serverTenantId,
      domains,
      layouts: store.listUiLayouts(principalId, actor).filter((layout) => domains.includes(layout.domainId)),
      library: store.publishedUiLayouts().filter((layout) => visibleDomains.includes(layout.domainId)),
      experienceTools: integrationService.interactiveReadContracts().map((task) => ({
        ref: task.ref, description: task.description, customer: Boolean(task.customerExperience),
        inputs: interactiveToolInputs(task, "operator"), outputSchema: task.outputSchema,
        ...(task.customerExperience && {
          customerInputs: interactiveToolInputs(task, "customer"),
          customerFields: [task.resourceIdField!, ...task.customerExperience.fields.map(({ key }) => key)],
        }),
      })),
      targets: [...uiTargetOptions(registry, principalId), ...store.publishedUiLayouts().flatMap(({ design }) =>
        design.recordIntent ? [recordIntentOption(design.recordIntent)] : [])].filter(({ target }) => visibleDomains.includes(layoutTargetDomain(target))),
    });
    return true;
  }
  if (id === "ui-layouts" && method === "POST") {
    const change = await body(req, uiLayoutChangeSchema, 32 * 1024);
    const actor = requireOperator();
    if (change.operation === "draft") {
      validateUiDesign(change.design, uiTargetOptions(registry, principalId), false);
      json(res, store.changeUiLayout(principalId, actor, membership.authoring(actor), change, now()));
    } else {
      const current = "id" in change ? store.listUiLayouts(principalId, actor).find((layout) => layout.id === change.id) : undefined;
      const scope = current?.domainId ?? ("domainId" in change ? change.domainId : undefined) ?? "wealth";
      requestReview(id, scope, change);
    }
    return true;
  }
  if (id === "ui-layout-preview" && method === "POST") {
    const previewBody = await body(req, z.union([
      z.object({ design: uiDesignSchema, personaId: z.string().regex(idPattern).optional() }).strict(),
      uiDesignSchema,
    ]), 32 * 1024);
    const design = "design" in previewBody ? previewBody.design : previewBody;
    const personaId = "design" in previewBody ? previewBody.personaId : undefined;
    const domainId = authoringDomain();
    validateUiDesign(
      design,
      uiTargetOptions(registry, principalId),
      false,
      domainId,
      sphotonCatalog.catalogForDomain(domainId),
      sphotonCatalog.sfieldAdapter(),
    );
    json(res, await previewUiLayout(design, personaId, {
      domainId,
      portfolioProvider: portfolioSnapshots,
      goalProvider: goalProgressProvider,
      opsStore: domainId === "it_ops" ? opsStore : undefined,
      salesStore: domainId === "sales_revops" ? salesStore : undefined,
      incident: domainId === "it_ops" ? opsStore.primaryIncident() : undefined,
      deal: domainId === "sales_revops" ? salesStore.primaryDeal() : undefined,
      sphotonCatalog,
    }));
    return true;
  }
  if (id === "ui-layout-test" && method === "POST") {
    const domainId = authoringDomain();
    const { design, message, personaId } = await body(req, z.object({
      design: uiDesignSchema,
      message: z.string().trim().min(1).max(1600),
      personaId: z.string().regex(idPattern).optional(),
    }).strict(), 32 * 1024);
    validateUiDesign(
      design,
      uiTargetOptions(registry, principalId),
      true,
      domainId,
      sphotonCatalog.catalogForDomain(domainId),
      sphotonCatalog.sfieldAdapter(),
    );
    if (design.experience) validateInteractiveExperience(design.experience, domainId, experienceTool);
    const draft = { id: makeId("ui"), revision: 1, design };
    const actor = requireOperator();
    const profile = domainId === "wealth" ? personaId ?? demo.defaultPersonaId : actor;
    requireChatDomain(domainId, profile);
    const thread = experience.createConversation(principalId, profile, demo.defaultScenarioId, "admin", domainId, actor, { layout: draft });
    const accepted = experience.submit(thread, message, makeId("request"), "layout_preview", undefined, undefined, undefined, actor);
    json(res, { ...accepted, layoutId: draft.id }, 202);
    return true;
  }
  if (id === "ui-layout-generate" && method === "POST") {
    const domainId = authoringDomain();
    const { prompt } = await body(req, z.object({ prompt: z.string().trim().min(4).max(800) }).strict(), 8 * 1024);
    const validTargets = uiTargetOptions(registry, principalId).filter(({ target }) => layoutTargetDomain(target) === domainId);
    const customKeys = domainId === "wealth" ? [...new Set(profileStore.list().flatMap((p) => (p.customAttributes ?? []).map((a) => `custom.${a.key}`)))] : [];
    const bindingCatalog = sphotonCatalog.catalogForDomain(domainId);
    const generated = await generateBoundUiLayoutWithLlm({
      prompt,
      gateway,
      dataDir,
      domainId,
      validTargets,
      customAttributeKeys: customKeys,
      bindingCatalog,
    });
    validateUiDesign(generated.design, validTargets, false, domainId, bindingCatalog, sphotonCatalog.sfieldAdapter());
    json(res, generated);
    return true;
  }
  if (id === "widgets" && method === "GET") {
    const library = widgetLibraries[authoringDomain()];
    json(res, { widgets: library.list(library.authorKey(principalId, requireOperator()), now()) });
    return true;
  }
  if (id === "widget-generate" && method === "POST") {
    authoringDomain();
    const input = await body(req, widgetGenerateRequestSchema, 6 * 1024 * 1024);
    const generated = await generateWidgetFromMultimodal(input, gateway, dataDir);
    json(res, generated);
    return true;
  }
  if (id === "widgets" && method === "POST") {
    const change = await body(req, widgetLibraryChangeSchema, 32 * 1024);
    const scope = authoringDomain();
    const library = widgetLibraries[scope];
    const owner = library.authorKey(principalId, requireOperator());
    const current = change.id ? library.list(owner, now()).find(({ id }) => id === change.id) : undefined;
    if (change.operation === "set_availability" || current?.availableForConsumption
      || (change.operation === "save" && change.widget.availableForConsumption)) {
      requestReview(id, scope, change);
    } else {
      json(res, library.change(owner, change, now()));
    }
    return true;
  }
  if (id === "customers" && method === "GET") {
    if (!membership.authoring(requireOperator()).includes("wealth")) throw new ApiError(403, "domain_access_denied", "This setting requires a Wealth owner.");
    json(res, { customers: listAdminCustomers(principalId) });
    return true;
  }
  if (id === "customers" && method === "POST") {
    if (!membership.authoring(requireOperator()).includes("wealth")) throw new ApiError(403, "domain_access_denied", "This setting requires a Wealth owner.");
    const input = await body(req, customer360ProfileInputSchema, 16 * 1024);
    const saved = profileStore.upsert(input, now());
    const customers = listAdminCustomers(principalId);
    json(res, { customer: customers.find((c) => c.personaId === saved.personaId), customers });
    return true;
  }
  if (id === "customer-delete" && method === "POST") {
    const { personaId } = await body(req, z.object({ personaId: z.string().regex(idPattern) }).strict());
    const result = profileStore.removeOrReset(personaId);
    json(res, { ...result, customers: listAdminCustomers(principalId) });
    return true;
  }
  if (id === "customer-reset-nba" && method === "POST") {
    const { personaId } = await body(req, z.object({ personaId: z.string().regex(idPattern) }).strict());
    customer360.resetDismissals(principalId, personaId);
    json(res, { customers: listAdminCustomers(principalId) });
    return true;
  }
  if (id === "experience-registry" && method === "GET") {
    if (url.searchParams.get("view") === "scopes") {
      const actor = requireOperator();
      json(res, { tenantId: serverTenantId, domains: membership.authoring(actor), tenantTools: membership.isTenantAdmin(actor) } satisfies ExperienceRegistryScopes);
      return true;
    }
    const domain = authoringDomain();
    json(res, domain === "wealth" ? buildExperienceRegistryView() : recordWorkspaceRegistry(domain, store, widgetLibraries[domain], runtime));
    return true;
  }
  if (method === "POST" && id && Object.hasOwn(registryChangeSchemas, id)) {
    if (authoringDomain() !== "wealth") {
      throw new ApiError(400, "registry_domain_invalid", "Choose Wealth to edit customer intents, content, and Next Best Action rules.");
    }
    const schema = registryChangeSchemas[id as keyof typeof registryChangeSchemas];
    requestReview(id, "wealth", await body(req, schema, 32 * 1024));
    return true;
  }
  if (id === "evaluation" && method === "GET") {
    json(res, { mode: "live", rows: await runtime?.evaluation(principalId) ?? [] });
    return true;
  }
  if (id === "capabilities" && method === "GET") {
    json(res, {
      manifests: registry.list(principalId),
      tools: capabilityTools.map(({ ref, label, output, invariant }) => ({ ref, label, output, invariant })),
    });
    return true;
  }
  if ((id === "capabilities" || id === "capability-validation") && method === "POST") {
    const input = await body(req, z.unknown(), 48 * 1024);
    if (id === "capability-validation") json(res, registry.publish(principalId, input, true));
    else requestReview(id, authoringDomain(), input);
    return true;
  }
  if (id === "capability-preview" && method === "POST") {
    if (!runtime) throw new ApiError(409, "model_unavailable", "Connect a model to run a capability preview.");
    const input = await body(req, z.object({
      capability: z.object({ id: capabilityIdSchema, version: versionSchema }).strict(),
      personaId: z.string().regex(idPattern),
      message: z.string().trim().min(1).max(1600),
    }).strict());
    if (!registry.get(principalId, capabilityRef(input.capability))) {
      throw new ApiError(404, "capability_unavailable", "Publish or select a known capability version.");
    }
    const conversation = experience.createConversation(principalId, input.personaId, demo.defaultScenarioId, "admin");
    const turn = experience.submit(conversation, input.message, makeId("request"), "capability_preview", undefined, undefined, { capability: input.capability });
    json(res, turn, 202);
    return true;
  }
  if (id === "customer-events" && method === "POST") {
    json(res, simulateCustomerEvent(store, principalId, await body(req, customerEventSchema), now()));
    return true;
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
    const result = store.flowSetup(scope.data, editableScopes);
    if (method === "GET") {
      res.setHeader("ETag", result.revision);
      json(res, result.data);
    } else {
      const input = await body(req, flowOverridesSchema, 64 * 1024);
      const expected = req.headers["if-match"];
      if (expected && expected !== result.revision) throw new ApiError(412, "flows_changed", "Flow settings changed. Reload them before saving.");
      requestReview(id, scope.data, input);
    }
    return true;
  }
  if (id === "tools" && method === "GET") {
    const domainId = authoringDomain();
    const preview = url.searchParams.get("scope") === "preview";
    const setup = store.toolSetup(domainId, preview ? principalId : undefined);
    const tag = toolSetupTag(setup);
    const draft = preview ? undefined : store.toolSetup(domainId, principalId);
    const glossary = sphotonCatalog.effectiveRuleGlossary(domainId);
    res.setHeader("ETag", tag);
    json(res, { ...toolSetupView(setup, glossary), ...(draft && toolSetupTag(draft) !== tag && { privateDraft: draft }) });
    return true;
  }
  if (id === "tools" && method === "POST") {
    const domainId = authoringDomain();
    const previewSession = url.searchParams.get("scope") === "preview" ? principalId : undefined;
    const setup = await body(req, toolSetupSchema, toolSetupLimit);
    validateToolSetup(setup, sphotonCatalog.effectiveRuleGlossary(domainId));
    const tag = toolSetupTag(setup);
    const expected = req.headers["if-match"];
    if (expected !== undefined) {
      const current = toolSetupTag(store.toolSetup(domainId, previewSession));
      if (expected !== current && tag !== current) {
        throw new ApiError(412, "tool_setup_changed", "Tool settings changed. Reload Tool setup to review the latest settings.");
      }
    }
    if (previewSession) {
      store.saveToolSetup(domainId, setup, previewSession);
      res.setHeader("ETag", tag);
      json(res, setup);
    } else requestReview(id, domainId, setup);
    return true;
  }
  if (id === "treatment-preview" && method === "POST") {
    const input = await body(req, treatmentPreviewSchema, toolSetupLimit);
    const funding = store.axe.fundingFact({ principalId, personaId: input.personaId });
    json(
      res,
      await previewTreatmentSelector(
        input,
        portfolioSnapshots,
        funding,
        recommendationRegistry,
        sphotonCatalog.effectiveRuleGlossary("wealth"),
        (personaId, keys) => sphotonCatalog.evaluateSmassCcreAttributes("wealth", personaId, keys),
      ),
    );
    return true;
  }
  if (id === "ccre-rules" && method === "POST") {
    const rule = await body(req, mockCcreRuleSchema, toolSetupLimit);
    const domainId = authoringDomain();
    const current = store.toolSetup(domainId);
    const updated = addCcreRule(current, rule, sphotonCatalog.effectiveRuleGlossary(domainId));
    if (updated === current) json(res, rule);
    else requestReview("tools", domainId, updated);
    return true;
  }
  if (id === "omnichannel" && method === "GET") {
    json(res, omnichannelStore.view(origin));
    return true;
  }
  if (id === "omnichannel" && method === "POST") {
    const nextConfig = await body(req, omnichannelConfigSchema.partial(), 8 * 1024);
    omnichannelStore.updateConfig(nextConfig);
    json(res, omnichannelStore.view(origin));
    return true;
  }
  if (id === "omnichannel-test" && method === "POST") {
    json(res, await omnichannelStore.sendTestNotification(origin));
    return true;
  }
  if (id === "evals" && method === "GET") {
    json(res, evalRunner.view());
    return true;
  }
  if (id === "eval-run" && method === "POST") {
    await body(req, z.object({ mode: z.literal("live_llm").optional() }).strict());
    if (!gateway) throw new ApiError(503, "gateway_unconfigured", "Connect a model provider to run evaluations.");
    json(res, await evalRunner.runSuite({
      approvedCorrections: uxEvolution.view().proposals.flatMap((p) => p.status === "approved" && p.regression ? [p.regression] : []),
      replayCorrection: async (prompt) => {
        const widget = widgetLibrary.renderPublishedWidget(principalId, prompt);
        if (!widget) return {};
        const rendered = compileDynamicCanvas(widget.intro, widget.canvas, now() + 60_000).display.blocks.find((b) => b.component === "PznDynamicCanvas");
        return { recordId: rendered?.props.recordId, title: rendered?.props.title };
      },
      gateway,
      profileStore,
      tradeStore,
      approvalStore,
      connectorStore,
      workflowEngine,
    }));
    return true;
  }
  if (id === "compliance-packet" && method === "GET") {
    json(res, evalRunner.buildCompliancePacket({
      approvalStore,
      writeAudit,
      omnichannelStore,
      workflowEngine,
      baseUrl: origin,
    }));
    return true;
  }
  if (id === "mcp-server" && method === "GET") {
    const config = mcpExposure.get();
    const publishedTasks = integrationService.view().contracts.filter((c) => c.status === "published" && c.sfieldRoute !== "unavailable");
    const smassVirtualTools = sphotonCatalog.allPublishedVirtualTools().map((vt) => ({
      ref: vt.ref,
      domainId: vt.domainId,
      modelId: vt.modelId,
      label: vt.modelLabel,
      description: vt.description ?? "",
      enabled: true,
    }));
    json(res, {
      endpoint: "/api/mcp",
      protocolVersion: "2025-03-26",
      stdioCommand: "npm run mcp:stdio",
      config,
      sfieldTools: STANDALONE_SFIELD_MCP_TOOLS.map((t) => ({
        ...t,
        enabled: config.enabledToolRefs.includes(t.ref),
      })),
      smassVirtualTools,
      publishedTaskCount: publishedTasks.length,
    });
    return true;
  }
  if (id === "mcp-server" && method === "POST") {
    const input = await body(req, mcpExposureConfigSchema, 8 * 1024);
    const saved = mcpExposure.save(input);
    const publishedTasks = integrationService.view().contracts.filter((c) => c.status === "published" && c.sfieldRoute !== "unavailable");
    const smassVirtualTools = sphotonCatalog.allPublishedVirtualTools().map((vt) => ({
      ref: vt.ref,
      domainId: vt.domainId,
      modelId: vt.modelId,
      label: vt.modelLabel,
      description: vt.description ?? "",
      enabled: true,
    }));
    json(res, {
      endpoint: "/api/mcp",
      protocolVersion: "2025-03-26",
      stdioCommand: "npm run mcp:stdio",
      config: saved,
      sfieldTools: STANDALONE_SFIELD_MCP_TOOLS.map((t) => ({
        ...t,
        enabled: saved.enabledToolRefs.includes(t.ref),
      })),
      smassVirtualTools,
      publishedTaskCount: publishedTasks.length,
    });
    return true;
  }
  if (id === "mcp-discover" && method === "POST") {
    const input = await body(req, mcpDiscoverRequestSchema, 8 * 1024);
    try {
      json(res, await discoverMcpServer({
        serverUrl: input.serverUrl,
        authHeaderName: input.authHeaderName,
        authEnvVar: input.authEnvVar,
        connectorStore,
      }));
      return true;
    } catch (err) {
      throw new ApiError(400, "mcp_discovery_failed", err instanceof Error ? err.message : "Could not discover MCP tools.");
    }
  }
  if (id === "mcp-import" && method === "POST") {
    const input = await body(req, mcpImportRequestSchema, 8 * 1024);
    requestReview("connectors", "tenant", mcpToolConnector({
      ...input,
      requiresApproval: input.requiresApproval ?? input.effect === "write",
      dualControl: input.dualControl ?? false,
    }));
    return true;
  }
  if (id === "knowledge-base" && method === "GET") {
    json(res, knowledgeBase.view());
    return true;
  }
  if (id === "knowledge-base" && method === "POST") {
    const input = await body(req, knowledgeDocumentUpsertSchema, 32 * 1024);
    requestReview(id, "tenant", input);
    return true;
  }
  if (id === "knowledge-base-delete" && method === "POST") {
    const { id: docId } = await body(req, z.object({ id: z.string().regex(idPattern) }).strict());
    requestReview(id, "tenant", { id: docId });
    return true;
  }
  if (id === "knowledge-search" && method === "POST") {
    const { query } = await body(req, z.object({ query: z.string().trim().min(2).max(400) }).strict());
    json(res, knowledgeBase.search(query, 4));
    return true;
  }
  if (id === "scheduled-jobs" && method === "GET") {
    json(res, scheduledJobs.view());
    return true;
  }
  if (id === "scheduled-jobs" && method === "POST") {
    const input = await body(req, scheduledJobUpsertSchema, 8 * 1024);
    json(res, scheduledJobs.upsert(input, principalId));
    return true;
  }
  if (id === "scheduled-jobs-run" && method === "POST") {
    const { id: jobId } = await body(req, z.object({ id: z.string().regex(idPattern) }).strict());
    try {
      json(res, scheduledJobs.runJob(jobId, "manual", principalId));
      return true;
    } catch (err) {
      throw new ApiError(404, "scheduled_job_not_found", err instanceof Error ? err.message : "Job not found.");
    }
  }
  if (id === "vertical-packs" && method === "GET") {
    json(res, verticalFactory.view());
    return true;
  }
  if (id === "vertical-packs-generate" && method === "POST") {
    const { prompt } = await body(req, z.object({ prompt: z.string().trim().min(5).max(600) }).strict(), 8 * 1024);
    const draft = await verticalFactory.generateDraft({ prompt, gateway, dataDir, connectors: connectorStore.list() });
    requestReview(id, "tenant", draft);
    return true;
  }
  if (id === "vertical-packs-delete" && method === "POST") {
    const { id: packId } = await body(req, z.object({ id: z.string().regex(idPattern) }).strict());
    requestReview(id, "tenant", { id: packId });
    return true;
  }
  if (id === "pii-firewall" && method === "GET") {
    json(res, piiFirewall.view());
    return true;
  }
  if (id === "pii-firewall" && method === "POST") {
    const patch = await body(req, piiFirewallConfigSchema.partial().strict());
    json(res, piiFirewall.updateConfig(patch));
    return true;
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
    json(res, { trace: result.trace });
    return true;
  }
  if (id === "ux-evolution" && method === "GET") {
    json(res, uxEvolution.view());
    return true;
  }
  if (id === "ux-evolution-scan" && method === "POST") {
    const input = await body(req, z.object({ includeSampleTraffic: z.boolean().optional() }).strict());
    const recentTurns = store.listAllCompletedTurns(200);
    const existingWidgets = widgetLibrary.list(widgetLibrary.authorKey(principalId, requireOperator()), now());
    json(res, await uxEvolution.scanAndDraft({
      turns: recentTurns,
      existingWidgets,
      gateway,
      dataDir,
      includeSampleTraffic: input.includeSampleTraffic,
    }));
    return true;
  }
  if (id === "ux-evolution-approve" && method === "POST") {
    const { id: proposalId } = await body(req, z.object({ id: z.string().regex(idPattern) }).strict());
    requestReview(id, "wealth", { id: proposalId });
    return true;
  }
  if (id === "ux-evolution-dismiss" && method === "POST") {
    const { id: proposalId } = await body(req, z.object({ id: z.string().regex(idPattern) }).strict());
    json(res, uxEvolution.dismissProposal(proposalId));
    return true;
  }

  if (id === "system-config" && method === "GET") {
    const entities = systemConfig.list();
    const countsByKind: Record<string, number> = {};
    for (const e of entities) countsByKind[e.kind] = (countsByKind[e.kind] ?? 0) + 1;
    json(res, {
      tenantId: systemConfig.tenantId,
      totalEntities: entities.length,
      totalRevisions: systemConfig.countRevisions(),
      countsByKind,
      entities,
      schema: systemConfig.schemaMetadata(),
    });
    return true;
  }
  if (id === "system-config-history" && method === "GET") {
    const domainId = url.searchParams.get("domain") || "wealth";
    const kindParsed = systemConfigKindSchema.safeParse(url.searchParams.get("kind"));
    const entityId = url.searchParams.get("entityId") || "";
    if (!kindParsed.success || !entityId) {
      json(res, { revisions: systemConfig.listRecentRevisions(30) });
      return true;
    }
    json(res, { revisions: systemConfig.history(domainId, kindParsed.data, entityId) });
    return true;
  }
  if (id === "system-config-rollback" && method === "POST") {
    const input = await body(req, systemRollbackRequestSchema, 8 * 1024);
    try {
      const entity = systemConfig.rollback({ ...input, updatedBy: requireOperator() });
      reloadAllControlPlaneStores({ sphotonCatalog, integrationTasks, mcpExposure });
      json(res, {
        entity,
        revisions: systemConfig.history(input.domainId, input.kind, input.entityId),
      });
      return true;
    } catch (err) {
      throw new ApiError(400, "system_rollback_failed", err instanceof Error ? err.message : "Could not roll back config entity.");
    }
  }
  if (id === "system-config-export" && method === "GET") {
    json(res, systemConfig.exportTenantBundle());
    return true;
  }
  if (id === "system-config-import" && method === "POST") {
    const raw = await body(req, systemConfigBundleSchema, 256 * 1024);
    try {
      const result = systemConfig.importTenantBundle(raw, requireOperator());
      reloadAllControlPlaneStores({ sphotonCatalog, integrationTasks, mcpExposure });
      json(res, {
        ...result,
        entities: systemConfig.list(),
      });
      return true;
    } catch (err) {
      throw new ApiError(400, "system_bundle_invalid", err instanceof Error ? err.message : "Could not import tenant config bundle.");
    }
  }
  if (id === "system-copilot" && method === "POST") {
    const { message } = await body(req, systemCopilotRequestSchema, 16 * 1024);
    try {
      json(
        res,
        handleSystemCopilotMessage(message, {
          systemConfig,
          sphotonCatalog,
          integrationTasks,
          mcpExposure,
          operatorName: requireOperator(),
        }),
      );
      return true;
    } catch (err) {
      throw new ApiError(400, "system_copilot_error", err instanceof Error ? err.message : "Could not process system config request.");
    }
  }

  return false;
}
