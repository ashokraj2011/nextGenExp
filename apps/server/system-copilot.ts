/**
 * Conversational System Config Copilot — lets operators inspect, version, roll back,
 * export/import, and govern all tenant configs stored in the unified `system` DB schema
 * (`system_entities` + `system_entity_revisions`) using the same chat + interactive card model
 * as Customer Chat and Integrations Copilot.
 */
import { DOMAIN_PACKS, type DomainPackId } from "../../packages/contracts/domain-packs";
import type {
  SystemConfigKind,
  SystemCopilotCard,
  SystemCopilotResponse,
} from "../../packages/contracts/system-config";
import type { IntegrationTaskStore } from "./integration-tasks";
import type { McpExposureStore } from "./mcp-exposure-store";
import type { SphotonCatalogService } from "./sphoton-catalog";
import type { SystemConfigStore } from "./system-config-store";

export interface SystemCopilotDeps {
  systemConfig: SystemConfigStore;
  sphotonCatalog: SphotonCatalogService;
  integrationTasks: IntegrationTaskStore;
  mcpExposure: McpExposureStore;
  operatorName: string;
}

export function reloadAllControlPlaneStores(deps: Pick<SystemCopilotDeps, "sphotonCatalog" | "integrationTasks" | "mcpExposure">) {
  deps.sphotonCatalog.reloadFromSystemConfig();
  deps.integrationTasks.reloadFromSystemConfig();
  deps.mcpExposure.reloadFromSystemConfig();
}

function summarizeCounts(entities: ReturnType<SystemConfigStore["list"]>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entities) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  }
  return counts;
}

function detectKindFilter(lower: string): SystemConfigKind | undefined {
  if (/\b(virtual\s*model|smass\s*model|vdm)\b/.test(lower)) return "smass_virtual_model";
  if (/\b(relation|er\s*link|foreign\s*key)\b/.test(lower)) return "smass_relation";
  if (/\b(exposure|sphoton|binding\s*override)\b/.test(lower)) return "sphoton_exposure";
  if (/\b(task\s*contract|contract|tool\s*contract)\b/.test(lower)) return "task_contract";
  if (/\b(integration|api\s*connection)\b/.test(lower)) return "integration";
  if (/\b(mcp)\b/.test(lower)) return "mcp_exposure";
  return undefined;
}

function findMatchingEntity(message: string, entities: ReturnType<SystemConfigStore["list"]>) {
  const lower = message.toLowerCase();
  return (
    entities.find((e) => lower.includes(e.entityId.toLowerCase())) ??
    entities.find((e) => e.label.length >= 3 && lower.includes(e.label.toLowerCase()))
  );
}

export function handleSystemCopilotMessage(message: string, deps: SystemCopilotDeps): SystemCopilotResponse {
  const { systemConfig, sphotonCatalog, operatorName } = deps;
  const lower = message.toLowerCase();
  const allEntities = systemConfig.list();

  // 1. Rollback `<entityId>` to revision `<N>`
  const rollbackMatch = message.match(/\b(?:rollback|restore|revert)\b.*?\b(?:rev(?:ision)?\s*#?(\d+))\b/i);
  if (rollbackMatch) {
    const targetRev = Number(rollbackMatch[1]);
    const entity = findMatchingEntity(message, allEntities);
    if (!entity) {
      return {
        reply: "Which config entity should I roll back? Pick one from the System Catalog below and click **History**.",
        cards: [{ kind: "system_catalog", tenantId: systemConfig.tenantId, entities: allEntities, countsByKind: summarizeCounts(allEntities) }],
        suggestedPrompts: ["Show system catalog", "Show system DB schema", "Export tenant bundle"],
      };
    }
    const restored = systemConfig.rollback({
      domainId: entity.domainId,
      kind: entity.kind,
      entityId: entity.entityId,
      targetRevision: targetRev,
      updatedBy: operatorName,
    });
    reloadAllControlPlaneStores(deps);
    const revisions = systemConfig.history(entity.domainId, entity.kind, entity.entityId);
    return {
      reply: `Rolled back **${restored.entityId}** (\`${restored.kind}\`) to revision **#${targetRev}** → created revision **#${restored.revision}** and hot-reloaded the live runtime.`,
      cards: [{ kind: "system_history", domainId: entity.domainId, entityKind: entity.kind, entityId: entity.entityId, revisions }],
      suggestedPrompts: ["Show system catalog", "Show health & drift", "Export tenant bundle"],
    };
  }

  // 2. Publish / Set Draft a virtual model directly from chat
  const statusMatch = message.match(/\b(publish|set\s+draft|draft)\b\s+([a-z][a-z0-9_.-]{2,80})/i);
  if (statusMatch) {
    const verb = statusMatch[1]!.toLowerCase();
    const modelId = statusMatch[2]!;
    const entity = allEntities.find((e) => e.kind === "smass_virtual_model" && e.entityId.toLowerCase() === modelId.toLowerCase());
    if (entity) {
      const nextStatus = verb === "publish" ? "published" : "draft";
      sphotonCatalog.setVirtualModelStatus(entity.domainId as DomainPackId, entity.entityId, nextStatus);
      const updated = systemConfig.list();
      return {
        reply: `Updated **${entity.entityId}** status to **${nextStatus}** in \`system_entities\` (revision history recorded & runtime updated).`,
        cards: [{ kind: "system_catalog", tenantId: systemConfig.tenantId, entities: updated, countsByKind: summarizeCounts(updated), filterKind: "smass_virtual_model" }],
        suggestedPrompts: [`Show history for ${entity.entityId}`, "Show system catalog", "Show health & drift"],
      };
    }
  }

  // 3. Revision history for a specific entity
  if (/\b(history|revisions?|versions?|audit|diff)\b/.test(lower)) {
    const entity = findMatchingEntity(message, allEntities);
    if (entity) {
      const revisions = systemConfig.history(entity.domainId, entity.kind, entity.entityId);
      return {
        reply: `Showing **${revisions.length}** immutable revision(s) for **${entity.entityId}** (\`${entity.kind}\`) in \`system_entity_revisions\`. Click any earlier revision to roll back atomically.`,
        cards: [{ kind: "system_history", domainId: entity.domainId, entityKind: entity.kind, entityId: entity.entityId, revisions }],
        suggestedPrompts: ["Show system catalog", "Export tenant bundle", "Show health & drift"],
      };
    }
    const recent = systemConfig.listRecentRevisions(20);
    if (recent.length > 0) {
      const first = recent[0]!;
      return {
        reply: `Showing the latest **${recent.length}** revisions across tenant **${systemConfig.tenantId}** in \`system_entity_revisions\`. Mention an entity ID (e.g. \`Show history for ${first.entityId}\`) to roll back a specific item.`,
        cards: [{ kind: "system_history", domainId: first.domainId, entityKind: first.kind, entityId: "Recent Tenant Revisions", revisions: recent }],
        suggestedPrompts: ["Show system catalog", "Show system DB schema", "Export tenant bundle"],
      };
    }
  }

  // 4. Export / Import tenant bundle
  if (/\b(export|backup|promote|bundle|snapshot)\b/.test(lower) && !/\bimport\b/.test(lower)) {
    const bundle = systemConfig.exportTenantBundle();
    return {
      reply: `Exported tenant **${bundle.tenantId}** (\`${bundle.entities.length}\` config entities, SHA-256 digest \`${bundle.bundleDigest.slice(0, 12)}\`). Download this bundle to promote configs from dev → staging → prod.`,
      cards: [{ kind: "system_bundle", bundle, mode: "export" }],
      suggestedPrompts: ["Import tenant bundle", "Show system catalog", "Show health & drift"],
    };
  }

  if (/\bimport\b/.test(lower) && /\b(bundle|config|tenant|json)\b/.test(lower)) {
    const bundle = systemConfig.exportTenantBundle();
    return {
      reply: "Upload a `.json` tenant bundle (or paste it below) to validate its SHA-256 checksum, atomically upsert into `system_entities`, and hot-reload all stores.",
      cards: [{ kind: "system_bundle", bundle, mode: "import" }],
      suggestedPrompts: ["Show system catalog", "Show health & drift"],
    };
  }

  // 5. System DB Schema / ER metadata (dogfooding view)
  if (/\b(schema|table|ddl|er\b|database|db|postgres|sqlite|metadata)\b/.test(lower)) {
    const meta = systemConfig.schemaMetadata();
    return {
      reply: `All control-plane configurations for tenant **${systemConfig.tenantId}** live in the unified \`system\` DB schema (\`system_entities\` + \`system_entity_revisions\`), keyed by \`tenant_id\` for clean multi-tenant isolation & Postgres RLS.`,
      cards: [{
        kind: "system_schema",
        tenantId: systemConfig.tenantId,
        tables: meta.tables,
        mermaidEr: meta.mermaidEr,
        totalEntities: allEntities.length,
        totalRevisions: systemConfig.countRevisions(),
      }],
      suggestedPrompts: ["Show system catalog", "Show health & drift", "Export tenant bundle"],
    };
  }

  // 6. Health & Schema Drift across all domains
  if (/\b(health|drift|status|check|validate|diagnostics?)\b/.test(lower)) {
    const driftIssues: Array<{ domainId: string; modelId: string; message: string }> = [];
    const domains = DOMAIN_PACKS.map((pack) => {
      const wb = sphotonCatalog.domainWorkbenchView(pack.id);
      for (const issue of wb.driftIssues) {
        driftIssues.push({ domainId: pack.id, modelId: issue.modelId, message: issue.message });
      }
      return {
        domainId: pack.id,
        entityCount: wb.models.length,
        publishedVirtualTools: wb.virtualTools.length,
      };
    });
    const card: SystemCopilotCard = {
      kind: "system_health",
      tenantId: systemConfig.tenantId,
      totalEntities: allEntities.length,
      totalRevisions: systemConfig.countRevisions(),
      driftCount: driftIssues.length,
      driftIssues,
      domains,
    };
    return {
      reply: driftIssues.length === 0
        ? `All **${domains.length}** domains have **0 schema drift**! Tenant **${systemConfig.tenantId}** holds **${allEntities.length}** config entities and **${systemConfig.countRevisions()}** immutable revisions in the \`system\` DB schema.`
        : `Detected **${driftIssues.length}** schema drift issue(s) across tenant **${systemConfig.tenantId}**. Review details below.`,
      cards: [card],
      suggestedPrompts: ["Show system catalog", "Show system DB schema", "Export tenant bundle"],
    };
  }

  // Default: Show unified System Catalog (optionally filtered by kind)
  const filterKind = detectKindFilter(lower);
  const filtered = filterKind ? allEntities.filter((e) => e.kind === filterKind) : allEntities;
  return {
    reply: filterKind
      ? `Showing **${filtered.length}** \`${filterKind}\` config(s) stored in \`system_entities\` for tenant **${systemConfig.tenantId}**.`
      : `Tenant **${systemConfig.tenantId}** has **${allEntities.length}** configuration entities and **${systemConfig.countRevisions()}** revisions stored in the unified \`system\` DB schema. Ask to inspect history, roll back, check drift, or export a promotion bundle.`,
    cards: [{
      kind: "system_catalog",
      tenantId: systemConfig.tenantId,
      entities: filtered,
      countsByKind: summarizeCounts(allEntities),
      ...(filterKind ? { filterKind } : {}),
    }],
    suggestedPrompts: [
      "Show system DB schema",
      "Show health & drift",
      "Export tenant bundle",
      "Show recent revisions",
    ],
  };
}
