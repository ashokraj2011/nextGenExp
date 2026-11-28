import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DOMAIN_PACKS, type DomainPackId } from "../../packages/contracts/domain-packs";
import type { RuleGlossary } from "../../packages/contracts/rule-glossary";
import { buildDynamicRuleGlossary } from "../../packages/rule-glossary";
import type { SystemConfigStore } from "./system-config-store";
import {
  balanceInputSchema,
  balanceResultSchema,
  goalProgressInputSchema,
  goalProgressResultSchema,
  goalSavingsInputSchema,
  goalSavingsResultSchema,
  portfolioInputSchema,
  portfolioResultSchema,
} from "../../packages/contracts/model-schemas";
import { sfieldTools, toolVersion } from "../../packages/contracts/tool-setup";
import { fixtureGoalProgressProvider, type GoalProgressProvider } from "../../packages/goal-progress";
import { fixturePortfolioSnapshotProvider, type PortfolioSnapshotProvider } from "../../packages/portfolio-snapshot";
import { findProfileById } from "../../packages/customer-profiles";
import { readDemoBalance } from "../../packages/experience/content";
import {
  createTurnSnapshotCache,
  defineToolBackedModel,
  evaluateSmassComputedExpression,
  smassAggregateFilterOpSchema,
  smassAggregateOpSchema,
  smassClassificationSchema,
  smassFieldFormatSchema,
  smassFieldTypeSchema,
  smassModelStatusSchema,
  smassRelationCardinalitySchema,
  validateDomainGraph,
  validateToolBackedModel,
  type SmassDomainRegistry,
  type SmassFieldSpec,
  type SmassModelSummary,
  type SmassModelValidationIssue,
  type SmassRelationSpec,
  type SmassToolBackedModel,
  type SmassVirtualSnapshotResult,
} from "../../packages/smass";
import {
  extractSchemaFields,
  fingerprintToolContract,
  resolveJsonSchemaPath,
  sha256Hex,
  sphotonFormatSchema,
  toolRefSchema,
  type SfieldAdapter,
  type SfieldToolDescriptor,
  type SfieldToolExecutionResult,
  type SphotonBindingCatalog,
  type SphotonCatalogAction,
  type SphotonCatalogField,
  type SphotonCatalogTool,
  type SphotonExecutionScope,
  type SphotonFieldType,
  type SphotonFormat,
} from "../../packages/sphoton";
import { createCepSmassRegistry } from "./domain-models";
import type { IntegrationTaskService } from "./integration-tasks";
import type { OpsIncidentStore } from "./ops-store";
import type { Runtime } from "./runtime";
import type { SalesDealStore } from "./sales-store";

export const domainFieldExposureSchema = z.object({
  toolRef: toolRefSchema,
  outputPath: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(80),
  group: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(200).optional(),
  supportedFormats: z.array(sphotonFormatSchema).min(1).max(6).optional(),
  defaultFormat: sphotonFormatSchema.optional(),
  exposed: z.boolean().default(true),
}).strict();
export type DomainFieldExposure = z.infer<typeof domainFieldExposureSchema>;

const virtualModelFieldIdPattern = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const virtualModelIdPattern = /^[a-z][a-z0-9._-]{1,60}$/;

export const customVirtualModelMappedFieldSchema = z.object({
  kind: z.literal("mapped").default("mapped"),
  key: z.string().trim().regex(virtualModelFieldIdPattern, "Field key must be a valid identifier (letters, digits, underscore)."),
  label: z.string().trim().min(1).max(80),
  toolRef: toolRefSchema,
  outputPath: z.string().trim().min(1).max(160),
  format: smassFieldFormatSchema.optional(),
  classification: smassClassificationSchema.default("internal"),
  required: z.boolean().default(false),
  exposed: z.boolean().default(true),
  foreignKey: z.object({
    modelId: z.string().trim().regex(virtualModelIdPattern),
    field: z.string().trim().regex(virtualModelFieldIdPattern),
  }).strict().optional(),
}).strict();

export const customVirtualModelComputedFieldSchema = z.object({
  kind: z.literal("computed"),
  key: z.string().trim().regex(virtualModelFieldIdPattern, "Field key must be a valid identifier."),
  label: z.string().trim().min(1).max(80),
  expression: z.string().trim().min(1).max(200),
  dependsOn: z.array(z.string().trim().regex(virtualModelFieldIdPattern)).min(1).max(12),
  type: smassFieldTypeSchema.default("number"),
  format: smassFieldFormatSchema.optional(),
  classification: smassClassificationSchema.default("internal"),
  exposed: z.boolean().default(true),
}).strict();

export const customVirtualModelAggregateFilterSchema = z.object({
  field: z.string().trim().min(1).max(80),
  op: smassAggregateFilterOpSchema,
  value: z.union([z.string(), z.number(), z.boolean()]),
}).strict();

export const customVirtualModelAggregateFieldSchema = z.object({
  kind: z.literal("aggregate"),
  key: z.string().trim().regex(virtualModelFieldIdPattern, "Field key must be a valid identifier."),
  label: z.string().trim().min(1).max(80),
  op: smassAggregateOpSchema,
  sourceField: z.string().trim().regex(virtualModelFieldIdPattern).optional(),
  itemField: z.string().trim().min(1).max(80).optional(),
  sourceFields: z.array(z.string().trim().regex(virtualModelFieldIdPattern)).min(1).max(12).optional(),
  targetModelId: z.string().trim().regex(virtualModelIdPattern).optional(),
  where: customVirtualModelAggregateFilterSchema.optional(),
  type: smassFieldTypeSchema.default("number"),
  format: smassFieldFormatSchema.optional(),
  classification: smassClassificationSchema.default("internal"),
  exposed: z.boolean().default(true),
}).strict().refine((data) => Boolean(data.sourceField || data.sourceFields?.length || data.targetModelId), {
  message: "Aggregate field must target an array sourceField, scalar sourceFields, or a related targetModelId.",
});

export const customVirtualModelStatusSchema = z.object({
  modelId: z.string().trim().regex(virtualModelIdPattern),
  status: smassModelStatusSchema,
}).strict();

export const customVirtualModelRelationSchema = z.object({
  name: z.string().trim().min(1).max(60),
  targetModelId: z.string().trim().regex(virtualModelIdPattern),
  cardinality: smassRelationCardinalitySchema,
  localField: z.string().trim().regex(virtualModelFieldIdPattern),
  foreignField: z.string().trim().regex(virtualModelFieldIdPattern),
}).strict();

export const customVirtualModelUnnestSchema = z.object({
  toolRef: toolRefSchema,
  path: z.string().trim().min(1).max(120),
  parentModelId: z.string().trim().regex(virtualModelIdPattern).optional(),
  parentJoinField: z.string().trim().regex(virtualModelFieldIdPattern).optional(),
  indexField: z.string().trim().regex(virtualModelFieldIdPattern).optional(),
}).strict();

export const customVirtualModelInputSchema = z.object({
  id: z.string().trim().regex(virtualModelIdPattern, "Model ID must look like wealth.advisor_brief."),
  previousId: z.string().trim().regex(virtualModelIdPattern).optional(),
  version: z.string().trim().regex(/^\d+\.\d+\.\d+$/).default("1.0.0"),
  status: smassModelStatusSchema.default("published"),
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().max(240).optional(),
  primaryKey: z.string().trim().regex(virtualModelFieldIdPattern).optional(),
  principalKey: z.string().trim().regex(virtualModelFieldIdPattern).optional(),
  unnest: customVirtualModelUnnestSchema.optional(),
  fields: z.array(
    z.union([
      customVirtualModelMappedFieldSchema,
      customVirtualModelComputedFieldSchema,
      customVirtualModelAggregateFieldSchema,
    ]),
  ).min(1).max(40),
  relations: z.array(customVirtualModelRelationSchema).max(12).optional(),
}).strict();
export type CustomVirtualModelInput = z.infer<typeof customVirtualModelInputSchema>;

export const customVirtualModelDeleteSchema = z.object({
  modelId: z.string().trim().regex(virtualModelIdPattern),
}).strict();

export const customVirtualModelTestSchema = z.object({
  modelId: z.string().trim().regex(virtualModelIdPattern),
  customerId: z.string().trim().max(80).optional(),
  requestedFields: z.array(z.string().trim().min(1).max(64)).max(40).optional(),
  redactPii: z.boolean().default(false),
  inputs: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type CustomVirtualModelTestInput = z.infer<typeof customVirtualModelTestSchema>;

export const customDomainRelationInputSchema = z.object({
  sourceModelId: z.string().trim().regex(virtualModelIdPattern),
  targetModelId: z.string().trim().regex(virtualModelIdPattern),
  name: z.string().trim().min(1).max(60),
  cardinality: smassRelationCardinalitySchema,
  localField: z.string().trim().regex(virtualModelFieldIdPattern),
  foreignField: z.string().trim().regex(virtualModelFieldIdPattern),
}).strict();
export type CustomDomainRelationInput = z.infer<typeof customDomainRelationInputSchema>;

export const customDomainRelationDeleteSchema = z.object({
  sourceModelId: z.string().trim().regex(virtualModelIdPattern),
  targetModelId: z.string().trim().regex(virtualModelIdPattern),
  name: z.string().trim().min(1).max(60),
}).strict();

type CustomVirtualModelFile = Partial<Record<DomainPackId, CustomVirtualModelInput[]>>;
type CustomDomainRelationFile = Partial<Record<DomainPackId, CustomDomainRelationInput[]>>;

export function loadOrCreateSphotonSecret(dataDir: string): string {
  const keyPath = join(dataDir, "sphoton-signing.key");
  try {
    if (existsSync(keyPath)) {
      const existing = readFileSync(keyPath, "utf8").trim();
      if (existing.length >= 32) return existing;
    }
    mkdirSync(dirname(keyPath), { recursive: true });
    const created = randomBytes(32).toString("hex");
    writeFileSync(keyPath, created + "\n", { mode: 0o600 });
    return created;
  } catch {
    return sha256Hex({ fallback: dataDir });
  }
}

function defaultFormatsFor(type: SphotonFieldType, outputPath: string): { supported: SphotonFormat[]; def: SphotonFormat } {
  const lower = outputPath.toLowerCase();
  if ((type === "integer" || type === "number") && lower.endsWith("cents")) {
    return { supported: ["currency_cents", "number"], def: "currency_cents" };
  }
  if ((type === "integer" || type === "number") && (lower.includes("pct") || lower.includes("percent") || lower.includes("probability") || lower.includes("rate"))) {
    return { supported: ["percent", "number"], def: "percent" };
  }
  if (type === "integer" || type === "number") {
    return { supported: ["number", "currency_cents", "percent"], def: "number" };
  }
  if (type === "array") {
    return { supported: ["series"], def: "series" };
  }
  if (lower.includes("month")) {
    return { supported: ["month", "text"], def: "month" };
  }
  if (lower.includes("date") || lower === "asof") {
    return { supported: ["date", "text"], def: "date" };
  }
  return { supported: ["text"], def: "text" };
}

type ExposureOverrideFile = Partial<Record<DomainPackId, DomainFieldExposure[]>>;

/**
 * Bridges smass (domain models) + sfield (headless tool registry & execution) -> sphoton (UI binding catalog).
 * Zero duplicated entity schemas: store-backed and tool-backed models are projected directly from `smass`.
 */
export class SphotonCatalogService {
  readonly signingSecret: string;
  readonly smass: SmassDomainRegistry;
  private readonly exposureFile: string;
  private readonly customModelsFile: string;
  private readonly customRelationsFile: string;
  private overrides: ExposureOverrideFile = {};
  private customModels: CustomVirtualModelFile = {};
  private customRelations: CustomDomainRelationFile = {};
  private customToolSchemas = new Map<string, SfieldToolDescriptor>();

  constructor(private readonly deps: {
    tenantId: string;
    dataDir: string;
    getRuntime: () => Runtime | null;
    smass?: SmassDomainRegistry;
    integrationService?: IntegrationTaskService;
    goalProgressProvider?: GoalProgressProvider;
    portfolioSnapshots?: PortfolioSnapshotProvider;
    opsStore?: OpsIncidentStore;
    salesStore?: SalesDealStore;
    systemConfig?: SystemConfigStore;
  }) {
    this.signingSecret = loadOrCreateSphotonSecret(deps.dataDir);
    this.smass = deps.smass ?? createCepSmassRegistry({ opsStore: deps.opsStore, salesStore: deps.salesStore });
    this.exposureFile = join(deps.dataDir, "sphoton-exposures.json");
    this.customModelsFile = join(deps.dataDir, "smass-virtual-models.json");
    this.customRelationsFile = join(deps.dataDir, "smass-relations.json");
    this.loadOverrides();
    this.loadCustomModels();
    this.loadCustomRelations();
  }

  private loadOverrides() {
    if (this.deps.systemConfig) {
      const dbItems = this.deps.systemConfig.list({ kind: "sphoton_exposure" });
      if (dbItems.length > 0 || this.deps.systemConfig.hasAnyRevision("sphoton_exposure")) {
        const next: ExposureOverrideFile = {};
        for (const row of dbItems) {
          const parsed = domainFieldExposureSchema.safeParse(row.payload);
          if (!parsed.success) continue;
          const domain = row.domainId as DomainPackId;
          next[domain] = [...(next[domain] ?? []), parsed.data];
        }
        this.overrides = next;
        return;
      }
    }
    try {
      if (!existsSync(this.exposureFile)) return;
      const parsed = JSON.parse(readFileSync(this.exposureFile, "utf8")) as ExposureOverrideFile;
      if (parsed && typeof parsed === "object") {
        this.overrides = parsed;
        if (this.deps.systemConfig) this.syncOverridesToSystemConfig("system", "Migrated from sphoton-exposures.json");
      }
    } catch {
      this.overrides = {};
    }
  }

  private syncOverridesToSystemConfig(updatedBy = "operator", changeNote?: string) {
    const sys = this.deps.systemConfig;
    if (!sys) return;
    const currentKeys = new Set<string>();
    for (const [domain, list] of Object.entries(this.overrides)) {
      for (const item of list ?? []) {
        const entityId = `${item.toolRef}::${item.outputPath}`;
        currentKeys.add(`${domain}::${entityId}`);
        sys.upsert({
          domainId: domain,
          kind: "sphoton_exposure",
          entityId,
          label: item.label || item.outputPath,
          status: item.exposed ? "published" : "draft",
          payload: item,
          updatedBy,
          ...(changeNote ? { changeNote } : {}),
        });
      }
    }
    for (const row of sys.list({ kind: "sphoton_exposure" })) {
      if (!currentKeys.has(`${row.domainId}::${row.entityId}`)) {
        sys.remove({ domainId: row.domainId, kind: "sphoton_exposure", entityId: row.entityId, updatedBy });
      }
    }
  }

  private saveOverrides() {
    if (this.deps.systemConfig) {
      this.syncOverridesToSystemConfig();
      return;
    }
    mkdirSync(dirname(this.exposureFile), { recursive: true });
    writeFileSync(this.exposureFile, JSON.stringify(this.overrides, null, 2));
  }

  private compileCustomVirtualModel(domainId: DomainPackId, spec: CustomVirtualModelInput): SmassToolBackedModel {
    const sources: Record<string, { toolRef: string }> = {};
    const toolToSlot = new Map<string, string>();
    const ensureSlot = (toolRef: string): string => {
      const existing = toolToSlot.get(toolRef);
      if (existing) return existing;
      const base = toolRef.split("@")[0]!.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "source";
      let slot = base;
      let idx = 2;
      while (slot in sources) {
        slot = `${base}_${idx++}`;
      }
      sources[slot] = { toolRef };
      toolToSlot.set(toolRef, slot);
      return slot;
    };

    const fields: Record<string, SmassFieldSpec> = {};
    const primaryKey = spec.primaryKey ?? (spec.unnest?.indexField ? spec.unnest.indexField : undefined) ?? spec.principalKey ?? spec.fields[0]?.key;

    if (spec.unnest?.indexField && !spec.fields.some((f) => f.key === spec.unnest!.indexField)) {
      fields[spec.unnest.indexField] = {
        type: "integer",
        primaryKey: primaryKey === spec.unnest.indexField,
        label: "Row index",
        required: true,
        classification: "internal",
        exposed: true,
      };
    }

    if (spec.principalKey && !spec.fields.some((f) => f.key === spec.principalKey)) {
      fields[spec.principalKey] = {
        type: "string",
        principalKey: spec.principalKey,
        primaryKey: primaryKey === spec.principalKey,
        ...(spec.unnest?.parentModelId
          ? { foreignKey: { modelId: spec.unnest.parentModelId, field: spec.unnest.parentJoinField ?? spec.principalKey } }
          : {}),
        label: spec.principalKey === "mid" ? "Member ID (MID)" : spec.principalKey,
        required: true,
        classification: "internal",
        exposed: Boolean(spec.unnest?.parentModelId),
      };
    }

    for (const field of spec.fields) {
      if (field.kind === "computed") {
        fields[field.key] = {
          type: field.type,
          label: field.label,
          ...(field.format ? { format: field.format } : {}),
          classification: field.classification,
          computed: {
            expression: field.expression,
            dependsOn: field.dependsOn,
          },
          primaryKey: primaryKey === field.key,
          exposed: field.exposed,
        };
      } else if (field.kind === "aggregate") {
        fields[field.key] = {
          type: field.type,
          label: field.label,
          ...(field.format ? { format: field.format } : {}),
          classification: field.classification,
          aggregate: {
            op: field.op,
            ...(field.sourceField ? { sourceField: field.sourceField } : {}),
            ...(field.itemField ? { itemField: field.itemField } : {}),
            ...(field.sourceFields?.length ? { sourceFields: field.sourceFields } : {}),
            ...(field.targetModelId ? { targetModelId: field.targetModelId } : {}),
            ...(field.where ? { where: field.where } : {}),
          },
          primaryKey: primaryKey === field.key,
          exposed: field.exposed,
        };
      } else {
        const slot = ensureSlot(field.toolRef);
        fields[field.key] = {
          from: `${slot}.${field.outputPath}`,
          label: field.label,
          ...(field.format ? { format: field.format } : {}),
          ...(field.foreignKey ? { foreignKey: field.foreignKey } : {}),
          classification: field.classification,
          required: field.required || primaryKey === field.key,
          primaryKey: primaryKey === field.key,
          exposed: field.exposed,
        };
      }
    }

    const compiledUnnest = spec.unnest
      ? {
          slot: ensureSlot(spec.unnest.toolRef),
          path: spec.unnest.path,
          ...(spec.unnest.parentModelId ? { parentModelId: spec.unnest.parentModelId } : {}),
          ...(spec.unnest.indexField ? { indexField: spec.unnest.indexField } : {}),
        }
      : undefined;

    const relations: SmassRelationSpec[] | undefined = spec.relations?.length ? [...spec.relations] : undefined;

    return defineToolBackedModel({
      id: spec.id,
      version: spec.version,
      domain: domainId,
      label: spec.label,
      status: spec.status ?? "published",
      exposeAsTool: true,
      ...(spec.description ? { description: spec.description } : {}),
      ...(primaryKey ? { primaryKey } : {}),
      sources,
      ...(compiledUnnest ? { unnest: compiledUnnest } : {}),
      fields,
      ...(relations ? { relations } : {}),
    });
  }

  private loadCustomModels() {
    if (this.deps.systemConfig) {
      const dbItems = this.deps.systemConfig.list({ kind: "smass_virtual_model" });
      if (dbItems.length > 0 || this.deps.systemConfig.hasAnyRevision("smass_virtual_model")) {
        const next: CustomVirtualModelFile = {};
        for (const row of dbItems) {
          const valid = customVirtualModelInputSchema.safeParse(row.payload);
          if (!valid.success) continue;
          const domain = row.domainId as DomainPackId;
          next[domain] = [...(next[domain] ?? []), valid.data];
          this.smass.register(this.compileCustomVirtualModel(domain, valid.data));
        }
        this.customModels = next;
        return;
      }
    }
    try {
      if (!existsSync(this.customModelsFile)) return;
      const parsed = JSON.parse(readFileSync(this.customModelsFile, "utf8")) as CustomVirtualModelFile;
      if (!parsed || typeof parsed !== "object") return;
      this.customModels = parsed;
      for (const [domain, list] of Object.entries(parsed)) {
        for (const raw of list ?? []) {
          const valid = customVirtualModelInputSchema.safeParse(raw);
          if (valid.success) {
            this.smass.register(this.compileCustomVirtualModel(domain as DomainPackId, valid.data));
          }
        }
      }
      if (this.deps.systemConfig) this.syncCustomModelsToSystemConfig("system", "Migrated from smass-virtual-models.json");
    } catch {
      this.customModels = {};
    }
  }

  private syncCustomModelsToSystemConfig(updatedBy = "operator", changeNote?: string) {
    const sys = this.deps.systemConfig;
    if (!sys) return;
    const currentKeys = new Set<string>();
    for (const [domain, list] of Object.entries(this.customModels)) {
      for (const model of list ?? []) {
        currentKeys.add(`${domain}::${model.id}`);
        sys.upsert({
          domainId: domain,
          kind: "smass_virtual_model",
          entityId: model.id,
          label: model.label,
          status: model.status ?? "published",
          payload: model,
          updatedBy,
          ...(changeNote ? { changeNote } : {}),
        });
      }
    }
    for (const row of sys.list({ kind: "smass_virtual_model" })) {
      if (!currentKeys.has(`${row.domainId}::${row.entityId}`)) {
        sys.remove({ domainId: row.domainId, kind: "smass_virtual_model", entityId: row.entityId, updatedBy });
      }
    }
  }

  private saveCustomModelsFile() {
    if (this.deps.systemConfig) {
      this.syncCustomModelsToSystemConfig();
      return;
    }
    mkdirSync(dirname(this.customModelsFile), { recursive: true });
    writeFileSync(this.customModelsFile, JSON.stringify(this.customModels, null, 2));
  }

  private loadCustomRelations() {
    if (this.deps.systemConfig) {
      const dbItems = this.deps.systemConfig.list({ kind: "smass_relation" });
      if (dbItems.length > 0 || this.deps.systemConfig.hasAnyRevision("smass_relation")) {
        const next: CustomDomainRelationFile = {};
        for (const row of dbItems) {
          const valid = customDomainRelationInputSchema.safeParse(row.payload);
          if (!valid.success) continue;
          const domain = row.domainId as DomainPackId;
          next[domain] = [...(next[domain] ?? []), valid.data];
        }
        this.customRelations = next;
        return;
      }
    }
    try {
      if (!existsSync(this.customRelationsFile)) return;
      const parsed = JSON.parse(readFileSync(this.customRelationsFile, "utf8")) as CustomDomainRelationFile;
      if (parsed && typeof parsed === "object") {
        this.customRelations = parsed;
        if (this.deps.systemConfig) this.syncCustomRelationsToSystemConfig("system", "Migrated from smass-relations.json");
      }
    } catch {
      this.customRelations = {};
    }
  }

  private syncCustomRelationsToSystemConfig(updatedBy = "operator", changeNote?: string) {
    const sys = this.deps.systemConfig;
    if (!sys) return;
    const currentKeys = new Set<string>();
    for (const [domain, list] of Object.entries(this.customRelations)) {
      for (const rel of list ?? []) {
        const entityId = `${rel.sourceModelId}::${rel.name}::${rel.targetModelId}`;
        currentKeys.add(`${domain}::${entityId}`);
        sys.upsert({
          domainId: domain,
          kind: "smass_relation",
          entityId,
          label: `${rel.sourceModelId} → ${rel.targetModelId} (${rel.name})`,
          status: "published",
          payload: rel,
          updatedBy,
          ...(changeNote ? { changeNote } : {}),
        });
      }
    }
    for (const row of sys.list({ kind: "smass_relation" })) {
      if (!currentKeys.has(`${row.domainId}::${row.entityId}`)) {
        sys.remove({ domainId: row.domainId, kind: "smass_relation", entityId: row.entityId, updatedBy });
      }
    }
  }

  private saveCustomRelationsFile() {
    if (this.deps.systemConfig) {
      this.syncCustomRelationsToSystemConfig();
      return;
    }
    mkdirSync(dirname(this.customRelationsFile), { recursive: true });
    writeFileSync(this.customRelationsFile, JSON.stringify(this.customRelations, null, 2));
  }

  /** Hot-reloads all custom smass virtual models, ER relations, and sphoton exposures from SystemConfigStore (e.g. after rollback or bundle import). */
  reloadFromSystemConfig() {
    if (!this.deps.systemConfig) return;
    for (const list of Object.values(this.customModels)) {
      for (const model of list ?? []) {
        this.smass.unregister(model.id);
      }
    }
    this.customModels = {};
    this.customRelations = {};
    this.overrides = {};
    this.loadOverrides();
    this.loadCustomModels();
    this.loadCustomRelations();
  }

  saveDomainRelation(domainId: DomainPackId, input: CustomDomainRelationInput) {
    const parsed = customDomainRelationInputSchema.parse(input);
    const source = this.smass.get(parsed.sourceModelId);
    const target = this.smass.get(parsed.targetModelId);
    if (!source) throw new Error(`Source entity "${parsed.sourceModelId}" does not exist.`);
    if (!target) throw new Error(`Target entity "${parsed.targetModelId}" does not exist.`);

    const list = (this.customRelations[domainId] ?? []).filter(
      (r) => !(r.sourceModelId === parsed.sourceModelId && r.targetModelId === parsed.targetModelId && r.name === parsed.name),
    );
    list.push(parsed);
    this.customRelations[domainId] = list;
    this.saveCustomRelationsFile();
    return this.domainWorkbenchView(domainId);
  }

  deleteDomainRelation(domainId: DomainPackId, input: { sourceModelId: string; targetModelId: string; name: string }) {
    const parsed = customDomainRelationDeleteSchema.parse(input);
    const before = this.customRelations[domainId] ?? [];
    const after = before.filter(
      (r) => !(r.sourceModelId === parsed.sourceModelId && r.targetModelId === parsed.targetModelId && r.name === parsed.name),
    );
    if (after.length !== before.length) {
      this.customRelations[domainId] = after;
      this.saveCustomRelationsFile();
    } else {
      // Also allow removing an inline relation declared on a custom virtual model
      const customList = this.customModels[domainId] ?? [];
      const customTarget = customList.find((m) => m.id === parsed.sourceModelId);
      if (customTarget?.relations?.length) {
        customTarget.relations = customTarget.relations.filter(
          (r) => !(r.targetModelId === parsed.targetModelId && r.name === parsed.name),
        );
        this.smass.register(this.compileCustomVirtualModel(domainId, customTarget));
        this.saveCustomModelsFile();
      }
    }
    return this.domainWorkbenchView(domainId);
  }

  saveVirtualModel(domainId: DomainPackId, input: CustomVirtualModelInput) {
    const parsed = customVirtualModelInputSchema.parse(input);
    const { previousId, ...persistedSpec } = parsed;
    const existing = this.smass.get(parsed.id);
    const isCustomExisting = (this.customModels[domainId] ?? []).some((m) => m.id === parsed.id);
    if (existing && !isCustomExisting) {
      throw new Error(`Cannot overwrite built-in model "${parsed.id}". Choose a new virtual model ID.`);
    }

    const compiled = this.compileCustomVirtualModel(domainId, persistedSpec);
    const descriptors = new Map(this.allToolDescriptors().map((desc) => [desc.ref, desc]));
    const issues = validateToolBackedModel(compiled, descriptors);
    if (issues.length > 0) {
      throw new Error(issues.map((i) => `${i.field ?? i.modelId}: ${i.message}`).join(" "));
    }
    // Validate computed field dependencies and expression syntax deterministically before saving
    for (const [key, field] of Object.entries(compiled.fields)) {
      if (!field.computed) continue;
      const sampleScope: Record<string, number> = {};
      for (const dep of field.computed.dependsOn) {
        if (!(dep in compiled.fields)) {
          throw new Error(`Computed field "${key}" depends on undeclared field "${dep}".`);
        }
        sampleScope[dep] = 100;
      }
      evaluateSmassComputedExpression(field.computed.expression, sampleScope);
    }

    // Support clean rename of a custom virtual model ID
    if (previousId && previousId !== parsed.id && (this.customModels[domainId] ?? []).some((m) => m.id === previousId)) {
      this.smass.unregister(previousId);
    }

    this.smass.register(compiled);
    const nextList = [
      ...(this.customModels[domainId] ?? []).filter((m) => m.id !== parsed.id && m.id !== previousId),
      persistedSpec,
    ];
    this.customModels[domainId] = nextList;
    this.saveCustomModelsFile();
    return this.domainWorkbenchView(domainId);
  }

  setVirtualModelStatus(domainId: DomainPackId, modelId: string, status: "draft" | "published") {
    const list = this.customModels[domainId] ?? [];
    const target = list.find((m) => m.id === modelId);
    if (!target) {
      throw new Error(`Custom virtual model "${modelId}" was not found in domain "${domainId}".`);
    }
    target.status = status;
    this.smass.register(this.compileCustomVirtualModel(domainId, target));
    this.saveCustomModelsFile();
    return this.domainWorkbenchView(domainId);
  }

  deleteVirtualModel(domainId: DomainPackId, modelId: string) {
    const list = this.customModels[domainId] ?? [];
    if (!list.some((m) => m.id === modelId)) {
      throw new Error(`Custom virtual model "${modelId}" was not found in domain "${domainId}".`);
    }
    this.customModels[domainId] = list.filter((m) => m.id !== modelId);
    this.smass.unregister(modelId);
    this.saveCustomModelsFile();
    return this.domainWorkbenchView(domainId);
  }

  async materializeVirtualModel(
    domainId: DomainPackId,
    req: CustomVirtualModelTestInput,
    principalId: string,
    cache?: ReturnType<typeof createTurnSnapshotCache>,
  ): Promise<SmassVirtualSnapshotResult> {
    const parsed = customVirtualModelTestSchema.parse(req);
    const adapter = this.sfieldAdapter();
    const customerId = parsed.customerId || (domainId === "wealth" ? "demo-learner" : undefined);
    const turnCache = cache ?? createTurnSnapshotCache();
    return this.smass.materializeSnapshot({
      modelId: parsed.modelId,
      ctx: {
        tenantId: this.deps.tenantId,
        domainId,
        principalId,
        ...(customerId ? { customerId } : {}),
      },
      ...(parsed.inputs ? { inputs: parsed.inputs } : {}),
      ...(parsed.requestedFields?.length ? { requestedFields: parsed.requestedFields } : {}),
      ...(parsed.redactPii ? { redactClassifications: ["pii"] } : {}),
      cache: turnCache,
      executeTool: async (toolRef, inputs, ctx) => {
        const result = await adapter.executeRead({
          toolRef,
          inputs,
          scope: {
            tenantId: ctx.tenantId,
            domainId: ctx.domainId as DomainPackId,
            principalId: ctx.principalId,
            mode: "draft_preview",
            ...(ctx.customerId ? { customerId: ctx.customerId } : {}),
          },
          signal: ctx.signal,
        });
        if (result.status !== "succeeded") {
          throw new Error(result.error?.message ?? `Tool ${toolRef} failed to execute.`);
        }
        return (result.output && typeof result.output === "object"
          ? result.output
          : { value: result.output }) as Record<string, unknown>;
      },
    });
  }

  registerToolDescriptor(descriptor: SfieldToolDescriptor) {
    this.customToolSchemas.set(descriptor.ref, descriptor);
  }

  setFieldExposure(domainId: DomainPackId, exposure: DomainFieldExposure) {
    const parsed = domainFieldExposureSchema.parse(exposure);
    const list = [...(this.overrides[domainId] ?? [])].filter(
      (item) => !(item.toolRef === parsed.toolRef && item.outputPath === parsed.outputPath),
    );
    list.push(parsed);
    this.overrides[domainId] = list;
    this.saveOverrides();
  }

  private builtinToolDescriptors(): SfieldToolDescriptor[] {
    return [
      {
        ref: `${sfieldTools.goal.id}@${toolVersion}`,
        id: sfieldTools.goal.id,
        version: toolVersion,
        description: sfieldTools.goal.description,
        inputs: goalProgressInputSchema as Record<string, unknown>,
        outputs: goalProgressResultSchema as Record<string, unknown>,
      },
      {
        ref: `${sfieldTools.goalScenario.id}@${toolVersion}`,
        id: sfieldTools.goalScenario.id,
        version: toolVersion,
        description: sfieldTools.goalScenario.description,
        inputs: goalSavingsInputSchema as Record<string, unknown>,
        outputs: goalSavingsResultSchema as Record<string, unknown>,
      },
      {
        ref: `${sfieldTools.portfolio.id}@${toolVersion}`,
        id: sfieldTools.portfolio.id,
        version: toolVersion,
        description: sfieldTools.portfolio.description,
        inputs: portfolioInputSchema as Record<string, unknown>,
        outputs: portfolioResultSchema as Record<string, unknown>,
      },
      {
        ref: `${sfieldTools.balances.id}@${toolVersion}`,
        id: sfieldTools.balances.id,
        version: toolVersion,
        description: sfieldTools.balances.description,
        inputs: balanceInputSchema as Record<string, unknown>,
        outputs: balanceResultSchema as Record<string, unknown>,
      },
      // Store-backed domain models compiled automatically by smass
      ...this.smass.describeGeneratedTools(),
    ];
  }

  private allToolDescriptors(): SfieldToolDescriptor[] {
    const byRef = new Map<string, SfieldToolDescriptor>();
    for (const desc of this.builtinToolDescriptors()) {
      byRef.set(desc.ref, desc);
    }

    const runtime = this.deps.getRuntime();
    const sfieldRegistry = runtime?.sfieldInstance.registry;
    if (sfieldRegistry) {
      for (const summary of sfieldRegistry.list()) {
        try {
          const described = sfieldRegistry.describe(summary.ref);
          const [id, version = "1.0.0"] = summary.ref.split("@");
          byRef.set(summary.ref, {
            ref: summary.ref,
            id,
            version,
            description: described.description,
            inputs: (described.inputs ?? { type: "object", properties: {} }) as Record<string, unknown>,
            outputs: (described.outputs ?? { type: "object", properties: {} }) as Record<string, unknown>,
          });
        } catch {
          // Ignore tools whose descriptor cannot be inspected
        }
      }
    }

    for (const task of this.deps.integrationService?.interactiveReadContracts() ?? []) {
      const [id, version = "1.0.0"] = task.ref.split("@");
      if (!byRef.has(task.ref)) {
        byRef.set(task.ref, {
          ref: task.ref,
          id,
          version,
          description: task.description,
          inputs: { type: "object", properties: {} },
          outputs: task.outputSchema,
        });
      }
    }

    for (const [ref, custom] of this.customToolSchemas) {
      byRef.set(ref, custom);
    }

    // Expose all published custom smass Virtual Models as executable closed-schema sfield read tools
    for (const virtualDesc of this.smass.describeVirtualModelTools(byRef, undefined, false)) {
      byRef.set(virtualDesc.ref, virtualDesc);
    }
    return [...byRef.values()];
  }

  summarizeDomainModels(domainId?: DomainPackId): SmassModelSummary[] {
    const descriptors = new Map(this.allToolDescriptors().map((desc) => [desc.ref, desc]));
    const summaries = this.smass.summarize(domainId, descriptors);
    if (!domainId) return summaries;
    const customRels = this.customRelations[domainId] ?? [];
    for (const rel of customRels) {
      const sourceSummary = summaries.find((m) => m.id === rel.sourceModelId);
      if (!sourceSummary) continue;
      const exists = sourceSummary.relations.some(
        (existing) => existing.targetModelId === rel.targetModelId && existing.name === rel.name,
      );
      if (!exists) {
        sourceSummary.relations.push({
          name: rel.name,
          targetModelId: rel.targetModelId,
          cardinality: rel.cardinality,
          localField: rel.localField,
          foreignField: rel.foreignField,
        });
      }
    }
    const overrides = this.overrides[domainId] ?? [];
    if (!overrides.length) return summaries;

    // Reflect live domain owner field exposures/hides inside the evolved smass model summary.
    for (const override of overrides) {
      const targetModel = summaries.find((m) => m.toolRefs.includes(override.toolRef));
      if (!targetModel) continue;
      const existing = targetModel.fields.find((f) => f.toolRef === override.toolRef && f.outputPath === override.outputPath);
      if (existing) {
        existing.exposed = override.exposed;
        existing.label = override.label;
        if (override.defaultFormat) existing.format = override.defaultFormat;
      } else if (override.exposed) {
        const desc = descriptors.get(override.toolRef);
        const resolved = resolveJsonSchemaPath(desc?.outputs, override.outputPath);
        targetModel.fields.push({
          key: override.outputPath.replace(/[^a-zA-Z0-9_]/g, "_"),
          toolRef: override.toolRef,
          outputPath: override.outputPath,
          label: override.label,
          ...(resolved.types[0] ? { type: resolved.types[0] } : {}),
          ...(override.defaultFormat ? { format: override.defaultFormat } : {}),
          required: false,
          nullable: false,
          primaryKey: false,
          classification: "internal",
          writable: false,
          exposed: true,
        });
      }
    }
    return summaries;
  }

  domainWorkbenchView(
    domainId: DomainPackId,
    downstream?: {
      uiLayouts?: Array<{ name: string; refs: string[] }>;
      widgets?: Array<{ name: string; refs: string[] }>;
      ccreRules?: Array<{ name: string; refs: string[] }>;
    },
  ) {
    const descriptors = new Map(this.allToolDescriptors().map((desc) => [desc.ref, desc]));
    const models = this.summarizeDomainModels(domainId);
    const dataModel = this.smass.toDataModelGraph(domainId, descriptors, models);
    const catalog = this.catalogForDomain(domainId);
    const exposedByKey = new Map(catalog.fields.map((f) => [`${f.toolRef}::${f.outputPath}`, f]));
    const actionRefs = new Set(models.flatMap((m) => m.actions.map((a) => a.toolRef)));
    const domainToolRefs = new Set<string>(models.flatMap((m) => m.toolRefs));
    for (const t of catalog.tools) {
      if (!t.toolRef.startsWith("smass.")) domainToolRefs.add(t.toolRef);
    }

    // Schema drift detection across all domain models (flags broken source paths immediately on the ER canvas)
    const driftIssues: SmassModelValidationIssue[] = [];
    const domainRawModels = this.smass.list(domainId);
    for (const rawModel of domainRawModels) {
      if (rawModel.mode === "tool_backed") {
        driftIssues.push(...validateToolBackedModel(rawModel, descriptors));
      }
    }
    driftIssues.push(...validateDomainGraph(domainRawModels));

    // Downstream lineage & impact map (which UI layouts, widgets, CCRE rules, and child entities depend on each model)
    const lineage: Record<
      string,
      { uiLayouts: string[]; widgets: string[]; ccreRules: string[]; childModels: string[]; virtualToolRef?: string }
    > = {};
    for (const model of models) {
      const needles = new Set<string>([
        model.id,
        ...model.toolRefs,
        ...(model.virtualReadToolRef ? [model.virtualReadToolRef] : []),
        ...model.fields.map((f) => f.key),
      ]);
      const matchesAny = (refs: string[]) =>
        refs.some((r) => {
          if (needles.has(r)) return true;
          for (const tRef of model.toolRefs) if (r.includes(tRef)) return true;
          if (model.virtualReadToolRef && r.includes(model.virtualReadToolRef)) return true;
          return r.includes(model.id);
        });
      const childModels = models
        .filter((other) => other.id !== model.id && (other.unnest?.parentModelId === model.id || other.relations.some((rel) => rel.targetModelId === model.id)))
        .map((other) => other.id);
      lineage[model.id] = {
        uiLayouts: (downstream?.uiLayouts ?? []).filter((item) => matchesAny(item.refs)).map((item) => item.name),
        widgets: (downstream?.widgets ?? []).filter((item) => matchesAny(item.refs)).map((item) => item.name),
        ccreRules: (downstream?.ccreRules ?? []).filter((item) => matchesAny(item.refs)).map((item) => item.name),
        childModels,
        ...(model.virtualReadToolRef ? { virtualToolRef: model.virtualReadToolRef } : {}),
      };
    }

    const tools = [...domainToolRefs]
      .sort()
      .map((ref) => descriptors.get(ref))
      .filter((desc): desc is SfieldToolDescriptor => Boolean(desc))
      .map((desc) => {
        const modelIds = models.filter((m) => m.toolRefs.includes(desc.ref)).map((m) => m.id);
        const rawOutputs = extractSchemaFields(desc.outputs as import("@sfield/core").JsonSchema);
        const rawInputs = extractSchemaFields(desc.inputs as import("@sfield/core").JsonSchema);
        return {
          toolRef: desc.ref,
          id: desc.id,
          version: desc.version,
          role: actionRefs.has(desc.ref) ? ("action" as const) : ("read" as const),
          description: desc.description ?? "",
          contractFingerprint: fingerprintToolContract(desc.ref, desc.inputs, desc.outputs),
          modelIds,
          inputFields: rawInputs.map((f) => ({ path: f.path, type: f.type })),
          outputFields: rawOutputs.map((f) => {
            const exposed = exposedByKey.get(`${desc.ref}::${f.path}`);
            return {
              path: f.path,
              type: f.type,
              exposed: Boolean(exposed),
              label: exposed?.label ?? f.path,
              format: exposed?.defaultFormat,
            };
          }),
        };
      });

    const virtualTools = this.smass.describeVirtualModelTools(descriptors, domainId, false).map((desc) => ({
      toolRef: desc.ref,
      id: desc.id,
      version: desc.version,
      description: desc.description ?? "",
      contractFingerprint: fingerprintToolContract(desc.ref, desc.inputs, desc.outputs),
    }));

    return {
      tenantId: this.deps.tenantId,
      domainId,
      models,
      customModelIds: (this.customModels[domainId] ?? []).map((m) => m.id),
      customModels: this.customModels[domainId] ?? [],
      customRelations: this.customRelations[domainId] ?? [],
      driftIssues,
      lineage,
      virtualTools,
      dataModel,
      tools,
      catalog,
    };
  }

  sfieldAdapter(): SfieldAdapter {
    const listTools = () => this.allToolDescriptors();
    const describeTool = (toolRef: string) => listTools().find((item) => item.ref === toolRef);
    const executeRead = async (input: {
      toolRef: string;
      inputs: Record<string, unknown>;
      scope: SphotonExecutionScope;
      signal?: AbortSignal;
    }): Promise<SfieldToolExecutionResult> => {
      const { toolRef, inputs, scope, signal } = input;
      if (toolRef === `${sfieldTools.goal.id}@${toolVersion}`) {
        const profile = scope.customerId ? findProfileById(scope.customerId) : undefined;
        if (!profile) {
          return { status: "failed", toolRef, error: { code: "CUSTOMER_REQUIRED", message: "Customer scope is required for goal progress." } };
        }
        const provider = this.deps.goalProgressProvider ?? fixtureGoalProgressProvider;
        const reading = await provider.read(profile.syntheticMid, signal);
        if (!reading) {
          return { status: "failed", toolRef, error: { code: "GOAL_UNAVAILABLE", message: "No goal progress record is available." } };
        }
        return { status: "succeeded", toolRef, output: reading };
      }
      if (toolRef === `${sfieldTools.portfolio.id}@${toolVersion}`) {
        const profile = scope.customerId ? findProfileById(scope.customerId) : undefined;
        if (!profile) {
          return { status: "failed", toolRef, error: { code: "CUSTOMER_REQUIRED", message: "Customer scope is required for portfolio snapshot." } };
        }
        const provider = this.deps.portfolioSnapshots ?? fixturePortfolioSnapshotProvider;
        const snapshot = await provider.read(profile.syntheticMid, signal);
        if (!snapshot) {
          return { status: "failed", toolRef, error: { code: "PORTFOLIO_UNAVAILABLE", message: "No portfolio snapshot is available." } };
        }
        return { status: "succeeded", toolRef, output: snapshot };
      }
      if (toolRef === `${sfieldTools.balances.id}@${toolVersion}`) {
        const profile = scope.customerId ? findProfileById(scope.customerId) : undefined;
        if (!profile) {
          return { status: "failed", toolRef, error: { code: "CUSTOMER_REQUIRED", message: "Customer scope is required for balances." } };
        }
        return { status: "succeeded", toolRef, output: readDemoBalance(profile.personaId, profile.syntheticMid, Date.now()) };
      }

      // Delegate published custom Virtual Data Model tools (`smass.<modelId>.read@<version>`) directly to VDM runtime
      const virtualModel = this.smass.findVirtualModelByToolRef(toolRef);
      if (virtualModel) {
        try {
          const snap = await this.materializeVirtualModel(
            virtualModel.domain as DomainPackId,
            {
              modelId: virtualModel.id,
              customerId: typeof inputs.customerId === "string" ? inputs.customerId : scope.customerId,
              redactPii: false,
            },
            scope.principalId,
          );
          if (snap.status !== "ok") {
            return { status: "failed", toolRef, error: { code: "STALE_VERSION_RETRY", message: snap.message } };
          }
          const output = snap.rows
            ? { ...snap.data, rows: snap.rows, rowCount: snap.rowCount ?? snap.rows.length }
            : snap.data;
          return { status: "succeeded", toolRef, output };
        } catch (err) {
          return {
            status: "failed",
            toolRef,
            error: { code: "VIRTUAL_MODEL_READ_FAILED", message: err instanceof Error ? err.message : "Virtual snapshot read failed." },
          };
        }
      }

      // Delegate all store-backed domain models cleanly to smass
      const smassRead = await this.smass.executeStoreRead(toolRef, inputs, {
        tenantId: scope.tenantId,
        domainId: scope.domainId,
        principalId: scope.principalId,
        customerId: scope.customerId,
        signal,
      });
      if (smassRead.found) {
        if (!smassRead.output) {
          return { status: "failed", toolRef, error: { code: "ENTITY_UNAVAILABLE", message: `No active record found for ${toolRef}.` } };
        }
        return { status: "succeeded", toolRef, output: smassRead.output };
      }

      return { status: "failed", toolRef, error: { code: "TOOL_UNAVAILABLE", message: `Read tool ${toolRef} is not executable in this context.` } };
    };

    const executeAction = async (input: {
      toolRef: string;
      inputs: Record<string, unknown>;
      scope: SphotonExecutionScope;
      signal?: AbortSignal;
    }): Promise<SfieldToolExecutionResult> => {
      const { toolRef, inputs, scope, signal } = input;
      const smassAction = await this.smass.executeStoreAction(toolRef, inputs, {
        tenantId: scope.tenantId,
        domainId: scope.domainId,
        principalId: scope.principalId,
        customerId: scope.customerId,
        signal,
      });
      if (smassAction.found) {
        return { status: "succeeded", toolRef, output: smassAction.output };
      }
      return { status: "failed", toolRef, error: { code: "ACTION_UNSUPPORTED", message: `Action ${toolRef} must run through its scoped runtime handler.` } };
    };

    return { listTools, describeTool, executeRead, executeAction };
  }

  allPublishedVirtualTools(): Array<
    SfieldToolDescriptor & { domainId: DomainPackId; modelId: string; modelLabel: string }
  > {
    const descriptors = new Map(this.allToolDescriptors().map((desc) => [desc.ref, desc]));
    const out: Array<SfieldToolDescriptor & { domainId: DomainPackId; modelId: string; modelLabel: string }> = [];
    for (const pack of DOMAIN_PACKS) {
      const models = this.smass.list(pack.id);
      for (const desc of this.smass.describeVirtualModelTools(descriptors, pack.id, false)) {
        const model = models.find((m) => m.mode === "tool_backed" && desc.ref === `smass.${m.id}.read@${m.version}`);
        out.push({
          ...desc,
          domainId: pack.id,
          modelId: model?.id ?? desc.id.replace(/^smass\./, "").replace(/\.read$/, ""),
          modelLabel: model?.label ?? desc.id,
        });
      }
    }
    return out;
  }

  allDomainDataModels() {
    const descriptors = new Map(this.allToolDescriptors().map((desc) => [desc.ref, desc]));
    return DOMAIN_PACKS.map((pack) => {
      const entities = this.summarizeDomainModels(pack.id);
      const graph = this.smass.toDataModelGraph(pack.id, descriptors, entities);
      return {
        domainId: pack.id,
        label: pack.label,
        entities: graph.entities,
        relations: graph.relations,
        mermaidEr: graph.mermaidEr,
      };
    });
  }

  /**
   * Projects every published custom smass Virtual Model's scalar columns (mapped, derived, aggregate)
   * into CCRE / PZN Rule Glossary namespaces so personalization rules can condition directly on smass models.
   */
  projectCcreGlossaryNamespaces(domainId: DomainPackId = "wealth"): RuleGlossary["namespaces"] {
    const summaries = this.summarizeDomainModels(domainId);
    const customSet = new Set((this.customModels[domainId] ?? []).map((m) => m.id));
    const namespaces: RuleGlossary["namespaces"] = [];

    for (const model of summaries) {
      if (!customSet.has(model.id)) continue;
      if (model.status === "draft") continue;
      if (model.unnest) continue;

      const slug = model.id
        .replace(/^[^.]+\./, "")
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "_")
        .replace(/^[^a-z]+/, "")
        .slice(0, 50);
      if (!slug) continue;
      const nsId = `smass_${slug}`;

      const attributes: RuleGlossary["namespaces"][number]["attributes"] = [];
      for (const field of model.fields) {
        if (!field.exposed || field.principalKey) continue;
        if (field.type === "array" || field.type === "object") continue;
        const attrId = field.key
          .replace(/([a-z])([A-Z])/g, "$1_$2")
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "_")
          .replace(/^[^a-z]+/, "")
          .slice(0, 60);
        if (!attrId || attributes.some((a) => a.id === attrId)) continue;

        if (field.enumValues && field.enumValues.length > 0) {
          const validOpts = field.enumValues
            .filter((v) => /^[a-z][a-z0-9_-]*$/.test(v))
            .slice(0, 16)
            .map((v) => ({ value: v, label: v }));
          if (validOpts.length > 0) {
            attributes.push({
              id: attrId,
              label: field.label.slice(0, 100),
              description: `smass ${model.id}.${field.key} (enum)`.slice(0, 240),
              valueType: "enum",
              operators: ["eq", "ne"],
              options: validOpts,
              minimum: null,
            });
            continue;
          }
        }
        if (field.type === "boolean") {
          attributes.push({
            id: attrId,
            label: field.label.slice(0, 100),
            description: `smass ${model.id}.${field.key} (boolean)`.slice(0, 240),
            valueType: "boolean",
            operators: ["eq", "ne"],
            options: [],
            minimum: null,
          });
        } else if (field.type === "integer" || field.type === "number") {
          attributes.push({
            id: attrId,
            label: field.label.slice(0, 100),
            description: `smass ${model.id}.${field.key}${field.aggregate ? " (aggregate)" : field.computed ? " (derived)" : ""}`.slice(0, 240),
            valueType: "integer",
            operators: ["eq", "ne", "gt", "gte", "lte"],
            options: [],
            minimum: null,
          });
        } else {
          attributes.push({
            id: attrId,
            label: field.label.slice(0, 100),
            description: `smass ${model.id}.${field.key}${field.computed ? " (derived)" : ""}`.slice(0, 240),
            valueType: "string",
            operators: ["eq", "ne"],
            options: [],
            minimum: null,
          });
        }
      }

      if (attributes.length > 0) {
        namespaces.push({
          id: nsId,
          label: `smass · ${model.label}`.slice(0, 100),
          attributes: attributes.slice(0, 24),
        });
      }
    }
    return namespaces;
  }

  effectiveRuleGlossary(domainId: DomainPackId = "wealth"): RuleGlossary {
    return buildDynamicRuleGlossary(this.projectCcreGlossaryNamespaces(domainId));
  }

  /**
   * Evaluates live smass virtual model attributes requested by active CCRE rules for a customer,
   * sharing a single 1x turn snapshot cache across all referenced virtual models.
   */
  async evaluateSmassCcreAttributes(
    domainId: DomainPackId,
    customerId: string,
    requestedNamespaceAttrKeys: readonly string[],
  ): Promise<Record<string, string | number | boolean>> {
    const out: Record<string, string | number | boolean> = {};
    if (requestedNamespaceAttrKeys.length === 0) return out;

    const wantedByNs = new Map<string, Set<string>>();
    for (const full of requestedNamespaceAttrKeys) {
      const dot = full.indexOf(".");
      if (dot <= 0) continue;
      const ns = full.slice(0, dot);
      const attr = full.slice(dot + 1);
      if (!ns.startsWith("smass_")) continue;
      const set = wantedByNs.get(ns) ?? new Set<string>();
      set.add(attr);
      wantedByNs.set(ns, set);
    }
    if (wantedByNs.size === 0) return out;

    const summaries = this.summarizeDomainModels(domainId);
    const customSet = new Set((this.customModels[domainId] ?? []).map((m) => m.id));
    const cache = createTurnSnapshotCache();

    for (const model of summaries) {
      if (!customSet.has(model.id) || model.status === "draft" || model.unnest) continue;
      const slug = model.id
        .replace(/^[^.]+\./, "")
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "_")
        .replace(/^[^a-z]+/, "")
        .slice(0, 50);
      const nsId = `smass_${slug}`;
      const wantedAttrs = wantedByNs.get(nsId);
      if (!wantedAttrs || wantedAttrs.size === 0) continue;

      const attrToFieldKey = new Map<string, string>();
      for (const f of model.fields) {
        const attrId = f.key
          .replace(/([a-z])([A-Z])/g, "$1_$2")
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "_")
          .replace(/^[^a-z]+/, "")
          .slice(0, 60);
        if (wantedAttrs.has(attrId)) attrToFieldKey.set(attrId, f.key);
      }
      if (attrToFieldKey.size === 0) continue;

      const snap = await this.materializeVirtualModel(domainId, {
        modelId: model.id,
        customerId,
        requestedFields: [...attrToFieldKey.values()],
        redactPii: false,
      }, customerId, cache);
      if (snap.status !== "ok") continue;

      for (const [attrId, fieldKey] of attrToFieldKey) {
        const val = snap.data[fieldKey];
        if (typeof val === "string" || typeof val === "boolean") {
          out[`${nsId}.${attrId}`] = val;
        } else if (typeof val === "number" && Number.isFinite(val)) {
          out[`${nsId}.${attrId}`] = Math.round(val);
        }
      }
    }
    return out;
  }

  catalogForDomain(domainId: DomainPackId): SphotonBindingCatalog {
    const adapter = this.sfieldAdapter();
    const descriptors = new Map(adapter.listTools().map((desc) => [desc.ref, desc]));
    const projected = this.smass.projectBindingsForDomain(domainId);
    const domainOverrides = this.overrides[domainId] ?? [];

    const mergedMap = new Map<string, DomainFieldExposure & { legacyBindingKey?: string }>();
    for (const item of projected.fields) {
      mergedMap.set(`${item.toolRef}::${item.outputPath}`, {
        toolRef: item.toolRef,
        outputPath: item.outputPath,
        label: item.label,
        group: item.group,
        description: item.description,
        supportedFormats: item.supportedFormats,
        defaultFormat: item.defaultFormat,
        exposed: item.exposed,
        legacyBindingKey: item.legacyBindingKey,
      });
    }
    for (const override of domainOverrides) {
      const key = `${override.toolRef}::${override.outputPath}`;
      const existing = mergedMap.get(key);
      mergedMap.set(key, {
        ...existing,
        ...override,
      });
    }

    const fields: SphotonCatalogField[] = [];
    const referencedTools = new Set<string>();

    for (const entry of mergedMap.values()) {
      if (!entry.exposed) continue;
      const descriptor = descriptors.get(entry.toolRef);
      if (!descriptor) continue;
      const resolved = resolveJsonSchemaPath(descriptor.outputs, entry.outputPath);
      if (!resolved.found) continue;
      const fieldType: SphotonFieldType = resolved.types[0] ?? "string";
      const defaults = defaultFormatsFor(fieldType, entry.outputPath);
      referencedTools.add(entry.toolRef);
      fields.push({
        id: `${entry.toolRef}:${entry.outputPath}`,
        toolRef: entry.toolRef,
        outputPath: entry.outputPath,
        type: fieldType,
        label: entry.label,
        group: entry.group ?? descriptor.id,
        ...(entry.description ? { description: entry.description } : {}),
        supportedFormats: entry.supportedFormats ?? defaults.supported,
        defaultFormat: entry.defaultFormat ?? defaults.def,
        ...(entry.legacyBindingKey ? { legacyBindingKey: entry.legacyBindingKey } : {}),
      });
    }

    const actions: SphotonCatalogAction[] = [];
    for (const spec of projected.actions) {
      const desc = descriptors.get(spec.toolRef);
      if (!desc) continue;
      referencedTools.add(spec.toolRef);
      actions.push({
        id: spec.id,
        toolRef: spec.toolRef,
        label: spec.label,
        ...(spec.description ? { description: spec.description } : {}),
        fixedInputFields: spec.fixedInputFields,
        followUpInputFields: spec.followUpInputFields,
        defaultUpdate: spec.defaultUpdate,
        inputSchema: desc.inputs,
        outputSchema: desc.outputs,
        contractFingerprint: fingerprintToolContract(desc.ref, desc.inputs, desc.outputs),
      });
    }

    const tools: SphotonCatalogTool[] = [...referencedTools]
      .sort()
      .map((ref) => descriptors.get(ref)!)
      .map((desc) => ({
        toolRef: desc.ref,
        id: desc.id,
        version: desc.version,
        label: desc.id,
        ...(desc.description ? { description: desc.description } : {}),
        contractFingerprint: fingerprintToolContract(desc.ref, desc.inputs, desc.outputs),
        inputSchema: desc.inputs,
        outputSchema: desc.outputs,
      }));

    const catalogFingerprint = sha256Hex({
      tenantId: this.deps.tenantId,
      domainId,
      tools: tools.map(({ toolRef, contractFingerprint }) => ({ toolRef, contractFingerprint })),
      fields: fields.map(({ id, type, label, supportedFormats }) => ({ id, type, label, supportedFormats })),
      actions: actions.map(({ id, toolRef, contractFingerprint }) => ({ id, toolRef, contractFingerprint })),
    });

    return {
      tenantId: this.deps.tenantId,
      domainId,
      catalogFingerprint,
      tools,
      fields,
      actions,
    };
  }
}
