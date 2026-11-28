import { z } from "zod";
import { capabilityRef } from "../../packages/contracts/agentic";
import { actionFlowUpsertSchema } from "../../packages/contracts/action-flow";
import { connectorUpsertSchema } from "../../packages/contracts/connector";
import type { DomainPackId } from "../../packages/contracts/domain-packs";
import { managedContentInputSchema, managedIntentInputSchema, managedNbaRuleInputSchema } from "../../packages/contracts/experience-registry";
import { knowledgeDocumentUpsertSchema } from "../../packages/contracts/knowledge-base";
import { flowOverridesSchema } from "../../packages/contracts/routing-flows";
import { toolSetupSchema } from "../../packages/contracts/tool-setup";
import { layoutTargetDomain, uiLayoutChangeSchema } from "../../packages/contracts/ui-layout";
import { widgetLibraryChangeSchema } from "../../packages/contracts/widget";
import { workflowDefinitionUpsertSchema } from "../../packages/contracts/workflow-definition";
import type { ExperienceRegistryStore } from "../../packages/experience-registry";
import { activeContexts } from "../../packages/ts-adapter";
import type { CapabilityRegistry } from "./capability-registry";
import type { ActionFlowStore } from "./action-flow-store";
import { migrateLegacyConnectors, prepareConnectorMigrations } from "./connector-migration";
import type { ConnectorStore } from "./connector-store";
import type { IntegrationTaskService, IntegrationTaskStore } from "./integration-tasks";
import { validateInteractiveExperience } from "./interactive-experiences";
import type { KnowledgeBaseStore } from "./knowledge-base";
import type { PublicationContext, PublicationPlan, PublicationPlans } from "./publication-reviews";
import { ApiError, type Store } from "./store";
import { validateToolSetup } from "./tool-setup";
import { collectDesignToolDependencies, uiTargetOptions, validateUiDesign } from "./ui-layouts";
import type { SphotonCatalogService } from "./sphoton-catalog";
import { verticalPackDraftSchema, type VerticalPackStore } from "./vertical-factory";
import type { WidgetLibraryStore } from "./widget-library";
import type { WorkflowEngine } from "./workflow-engine";
import type { UxEvolutionStore } from "./ux-evolution";

const catalogId = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);
export const registryIntentDeleteSchema = z.object({ intentId: catalogId }).strict();
export const registryContentDeleteSchema = z.object({ contentId: catalogId }).strict();
export const registryNbaDeleteSchema = z.object({ id: z.string().regex(/^nba_[a-z0-9_]{3,40}$/) }).strict();
export const registryNbaOrderSchema = z.object({ orderedIds: z.array(z.string().min(1)).min(1).max(30) }).strict();
const targetIdSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/) }).strict();

function domain(context: PublicationContext) {
  if (context.scope === "tenant") throw new ApiError(400, "domain_invalid", "Choose a domain for this publication.");
  return context.scope;
}

function plan(recordId: string, title: string, current: unknown, apply: () => unknown, summary: string, details?: PublicationPlan["details"]): PublicationPlan {
  return { recordId, title, current, details, apply: () => ({ value: apply(), summary }) };
}

export function studioPublicationPlans(deps: {
  store: Store;
  registry: CapabilityRegistry;
  widgetLibraries: Record<DomainPackId, WidgetLibraryStore>;
  experienceRegistry: ExperienceRegistryStore;
  integrationService: IntegrationTaskService;
  integrationTasks: IntegrationTaskStore;
  workflowEngine: WorkflowEngine;
  actionFlowStore: ActionFlowStore;
  connectorStore: ConnectorStore;
  knowledgeBase: KnowledgeBaseStore;
  uxEvolution: UxEvolutionStore;
  verticalFactory: VerticalPackStore;
  sphotonCatalog?: SphotonCatalogService;
  now: () => number;
}): PublicationPlans {
  const { store, registry, widgetLibraries, experienceRegistry, integrationService, integrationTasks, workflowEngine,
    actionFlowStore, connectorStore, knowledgeBase, uxEvolution, verticalFactory, sphotonCatalog, now } = deps;
  return {
    "ui-layouts"(candidate, context) {
      const input = uiLayoutChangeSchema.parse(candidate);
      const scope = domain(context);
      const { principalId, operator } = context;
      if (input.operation === "draft") throw new ApiError(400, "publication_invalid", "Save drafts in UI Builder.");
      const catalog = sphotonCatalog?.catalogForDomain(scope);
      const sfieldAdapter = sphotonCatalog?.sfieldAdapter();
      let dependencies: ReturnType<typeof collectDesignToolDependencies> | undefined;
      if (input.operation === "publish") {
        validateUiDesign(input.design, uiTargetOptions(registry, principalId), true, scope, catalog, sfieldAdapter);
        if (input.design.experience) {
          validateInteractiveExperience(input.design.experience, scope, (ref) => integrationService.interactiveReadContract(ref));
        }
        if (catalog) {
          const collected = collectDesignToolDependencies(input.design, catalog, sfieldAdapter);
          if (Object.keys(collected.toolContracts).length > 0) dependencies = collected;
        }
      }
      const previous = "id" in input ? store.listUiLayouts(principalId, operator).find(({ id }) => id === input.id) : undefined;
      const change = input.operation === "publish" ? { ...input, domainId: scope } : input;
      const preview = store.changeUiLayout(principalId, operator, [scope], change, now(), true);
      const name = preview.draft.name;
      const publishing = input.operation === "publish";
      const contractDetails = dependencies
        ? Object.entries(dependencies.toolContracts).map(([toolRef, hash]) => ({
          label: `Tool contract · ${toolRef}`,
          value: hash.slice(0, 12),
        }))
        : [];
      const review = plan(previous?.id ?? name, `${publishing ? "Publish" : "Unpublish"} ${name}`, previous, () =>
        store.changeUiLayout(principalId, operator, [scope], change, now()),
      `${publishing ? "Published" : "Unpublished"} ${name}.`, [
        { label: "Active revision", value: previous?.published ? String(previous.published.revision) : "First publication" },
        { label: "Proposed revision", value: String(preview.revision) },
        ...contractDetails,
      ]);
      return {
        ...review,
        ...(dependencies ? { dependencies } : {}),
        preview: publishing ? preview.draft : previous?.published?.design,
      };
    },
    widgets(candidate, context) {
      const input = widgetLibraryChangeSchema.parse(candidate);
      const library = widgetLibraries[domain(context)];
      const owner = library.authorKey(context.principalId, context.operator);
      const current = input.id ? library.list(owner, now()).find(({ id }) => id === input.id) : undefined;
      if (input.id && !current) throw new ApiError(404, "widget_not_found", "This widget is unavailable.");
      const name = input.operation === "save" ? input.widget.name : current!.name;
      const removal = input.operation === "delete" || (input.operation === "set_availability" && !input.availableForConsumption);
      const review = plan(current?.id ?? name, `${removal ? "Remove" : "Publish"} widget · ${name}`, current, () =>
        library.change(owner, input, now()), `${removal ? "Removed" : "Published"} widget ${name}.`);
      return { ...review, preview: input.operation === "save" ? input.widget : current };
    },
    "registry-intent"(candidate) {
      const input = managedIntentInputSchema.parse(candidate);
      if (layoutTargetDomain({ kind: "intent", id: input.intentId }) !== "wealth") {
        throw new ApiError(400, "registry_domain_invalid", "Use a Wealth intent ID here. Publish other domain intents in UI Builder.");
      }
      if (!activeContexts.some(({ contextId }) => contextId === input.contextId)) {
        throw new ApiError(400, "invalid_context", "Choose an active Treatment Selector context.");
      }
      const current = experienceRegistry.listIntents().find(({ intentId }) => intentId === input.intentId);
      return plan(input.intentId, `Publish intent · ${input.label}`, current, () => experienceRegistry.upsertIntent(input), `Published intent ${input.label}.`);
    },
    "registry-intent-delete"(candidate) {
      const { intentId } = registryIntentDeleteSchema.parse(candidate);
      const current = experienceRegistry.listIntents().find((item) => item.intentId === intentId);
      return plan(intentId, `Remove or reset intent · ${current?.label ?? intentId}`, current,
        () => experienceRegistry.deleteOrResetIntent(intentId), `Applied the intent change for ${intentId}.`);
    },
    "registry-content"(candidate) {
      const input = managedContentInputSchema.parse(candidate);
      const current = experienceRegistry.listContent().find(({ input: entry }) => entry.contentId === input.contentId);
      return plan(input.contentId, `${input.publicationStatus === "published" ? "Publish" : "Withdraw"} content · ${input.title}`, current, () =>
        experienceRegistry.upsertContent(input), `Saved ${input.title} as ${input.publicationStatus}.`);
    },
    "registry-content-delete"(candidate) {
      const { contentId } = registryContentDeleteSchema.parse(candidate);
      const current = experienceRegistry.listContent().find(({ input }) => input.contentId === contentId);
      return plan(contentId, `Remove or reset content · ${current?.input.title ?? contentId}`, current,
        () => experienceRegistry.deleteOrResetContent(contentId), `Applied the content change for ${contentId}.`);
    },
    "registry-nba"(candidate) {
      const input = managedNbaRuleInputSchema.parse(candidate);
      const current = experienceRegistry.listNbaRules().find(({ id }) => id === input.id);
      return plan(input.id, `Publish next action rule · ${input.title}`, current, () =>
        experienceRegistry.upsertNbaRule(input), `Published next action rule ${input.title}.`);
    },
    "registry-nba-delete"(candidate) {
      const { id } = registryNbaDeleteSchema.parse(candidate);
      const current = experienceRegistry.listNbaRules().find((rule) => rule.id === id);
      return plan(id, `Remove or reset next action rule · ${current?.title ?? id}`, current, () =>
        experienceRegistry.deleteOrResetNbaRule(id), `Applied the next action change for ${id}.`);
    },
    "registry-nba-reorder"(candidate) {
      const { orderedIds } = registryNbaOrderSchema.parse(candidate);
      const current = experienceRegistry.listNbaRules().map(({ id }) => id);
      return plan("next_best_actions", "Change next action rule order", current, () =>
        experienceRegistry.reorderNbaRules(orderedIds), "Updated the next action rule order.");
    },
    tools(candidate, context) {
      const input = toolSetupSchema.parse(candidate);
      const scope = domain(context);
      validateToolSetup(input, sphotonCatalog?.effectiveRuleGlossary(scope));
      return plan(scope, "Publish tool settings and eligibility rules", store.toolSetup(scope), () =>
        { store.saveToolSetup(scope, input); return input; }, "Published tool settings.");
    },
    "routing-flows"(candidate, { scope }) {
      const settings = flowOverridesSchema.parse(candidate);
      const current = store.flowSetup(scope, [scope]);
      if (Object.keys(settings).some((id) => !current.data.inherited.some((flow) => flow.id === id))) {
        throw new ApiError(400, "flow_scope_invalid", "Choose flows registered for this workspace.");
      }
      return plan(scope, "Publish chat routing flows", current.revision, () =>
        store.saveFlowSetup(scope, [scope], settings, current.revision).data, "Published chat routing flows.");
    },
    capabilities(candidate, { principalId }) {
      const input = registry.publish(principalId, candidate, true);
      const ref = capabilityRef(input);
      return plan(ref, `Publish capability · ${input.title}`, registry.get(principalId, ref), () =>
        registry.publish(principalId, input), `Published capability ${ref}.`);
    },
    workflows(candidate) {
      const input = workflowDefinitionUpsertSchema.parse(candidate);
      return plan(input.id, `Publish workflow · ${input.name}`, workflowEngine.getDefinition(input.id), () =>
        workflowEngine.upsertDefinition(input), `Published workflow ${input.name}.`);
    },
    "workflow-delete"(candidate) {
      const { id } = targetIdSchema.parse(candidate);
      return plan(id, `Remove or reset workflow · ${id}`, workflowEngine.getDefinition(id), () =>
        workflowEngine.deleteOrResetDefinition(id), `Applied the workflow change for ${id}.`);
    },
    "action-flows"(candidate) {
      const input = actionFlowUpsertSchema.parse(candidate);
      const current = input.id ? actionFlowStore.findById(input.id) : actionFlowStore.list();
      return plan(input.id ?? input.name, `Publish action flow · ${input.name}`, current, () =>
        actionFlowStore.upsert(input), `Published action flow ${input.name}.`);
    },
    "action-flow-delete"(candidate) {
      const { id } = targetIdSchema.parse(candidate);
      return plan(id, `Remove action flow · ${id}`, actionFlowStore.findById(id), () =>
        actionFlowStore.remove(id), `Removed action flow ${id}.`);
    },
    connectors(candidate) {
      const input = connectorUpsertSchema.parse(candidate);
      const current = input.id ? connectorStore.findById(input.id) : connectorStore.list();
      return plan(input.id ?? input.name, `Publish connector · ${input.name}`, current, () =>
        connectorStore.upsert(input), `Published connector ${input.name}.`);
    },
    "connector-delete"(candidate) {
      const { id } = targetIdSchema.parse(candidate);
      return plan(id, `Remove connector · ${id}`, connectorStore.findById(id), () =>
        connectorStore.remove(id), `Removed connector ${id}.`);
    },
    "integration-config"(candidate) {
      const integration = integrationTasks.upsertIntegration(candidate, true);
      const current = integrationTasks.integration(integration.id);
      return plan(integration.id, `Update task connection · ${integration.name}`, current, () =>
        ({ integration: integrationTasks.upsertIntegration(integration), view: integrationService.view() }),
      `Updated the task connection for ${integration.name}.`);
    },
    "migrate-connectors"(candidate) {
      const { connectorId } = z.object({ connectorId: z.string().min(1).max(64).optional() }).strict().parse(candidate);
      const migrations = prepareConnectorMigrations(connectorStore, integrationTasks, connectorId);
      if (migrations.length === 0) throw new ApiError(404, "connector_not_found", "There are no matching connectors to migrate.");
      return {
        recordId: connectorId ?? "legacy_connectors",
        title: "Publish tasks from legacy connectors",
        current: migrations,
        preview: migrations.map(({ connectorId, integration, contractInput, current }) =>
          ({ connectorId, connection: current.integration ?? integration, contract: current.contract ?? contractInput })),
        async apply() {
          const results = await migrateLegacyConnectors(migrations, integrationTasks, integrationService);
          const migrated = results.filter(({ status }) => status === "migrated").length;
          const skipped = results.filter(({ status }) => status === "skipped").length;
          return {
            summary: `Published ${migrated} task(s). ${results.length - migrated - skipped} already active. ${skipped} skipped.`,
            value: { results, view: integrationService.view() },
          };
        },
      };
    },
    "knowledge-base"(candidate) {
      const input = knowledgeDocumentUpsertSchema.parse(candidate);
      const current = knowledgeBase.view().documents.find(({ id }) => id === input.id);
      return plan(input.id, `Publish reference · ${input.title}`, current, () =>
        knowledgeBase.upsert(input), `Published ${input.title}.`);
    },
    "knowledge-base-delete"(candidate) {
      const { id } = targetIdSchema.parse(candidate);
      const current = knowledgeBase.view().documents.find((document) => document.id === id);
      return plan(id, `Remove or reset reference · ${id}`, current, () =>
        knowledgeBase.deleteOrReset(id), `Applied the reference change for ${id}.`);
    },
    "vertical-packs-generate"(candidate) {
      const draft = verticalPackDraftSchema.parse(candidate);
      const { blueprint } = draft;
      const current = {
        packs: verticalFactory.view().packs,
        workflow: workflowEngine.getDefinition(blueprint.workflow.id),
        policy: knowledgeBase.view().documents.find(({ id }) => id === blueprint.policyDoc.id),
      };
      return plan(blueprint.id, `Publish portal · ${blueprint.portalName}`, current, () =>
        verticalFactory.installDraft(draft, { knowledgeBase, workflowEngine }), `Published ${blueprint.portalName} and its workflow and policy reference.`);
    },
    "vertical-packs-delete"(candidate) {
      const { id } = targetIdSchema.parse(candidate);
      const current = verticalFactory.getPack(id);
      if (!current) throw new ApiError(404, "portal_not_found", "This portal is unavailable.");
      return plan(id, `Remove portal · ${current.portalName}`, current, () => verticalFactory.deletePack(id), `Removed ${current.portalName}.`);
    },
    "ux-evolution-approve"(candidate, context) {
      const { id } = targetIdSchema.parse(candidate);
      const proposal = uxEvolution.view().proposals.find((proposal) => proposal.id === id);
      if (!proposal || proposal.status !== "pending") throw new ApiError(409, "publication_changed", "This proposal is no longer waiting for review.");
      const widgetLibrary = widgetLibraries.wealth;
      const principalId = widgetLibrary.authorKey(context.principalId, context.operator);
      const review = plan(id, `Publish proposed widget · ${proposal.widgetDraft.name}`, proposal, () =>
        uxEvolution.approveProposal(id, { principalId, widgetLibrary, knowledgeBase, now: now() }),
      `Published proposed widget ${proposal.widgetDraft.name}.`);
      return { ...review, preview: proposal };
    },
  };
}
