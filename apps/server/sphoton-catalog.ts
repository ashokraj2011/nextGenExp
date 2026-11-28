import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { DomainPackId } from "../../packages/contracts/domain-packs";
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
  smassAggregateOpSchema,
  smassClassificationSchema,
  smassFieldFormatSchema,
  smassFieldTypeSchema,
  smassRelationCardinalitySchema,
  validateToolBackedModel,
  type SmassDomainRegistry,
  type SmassFieldSpec,
  type SmassModelSummary,
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

export const customVirtualModelAggregateFieldSchema = z.object({
  kind: z.literal("aggregate"),
  key: z.string().trim().regex(virtualModelFieldIdPattern, "Field key must be a valid identifier."),
  label: z.string().trim().min(1).max(80),
  op: smassAggregateOpSchema,
  sourceField: z.string().trim().regex(virtualModelFieldIdPattern).optional(),
  itemField: z.string().trim().min(1).max(80).optional(),
  sourceFields: z.array(z.string().trim().regex(virtualModelFieldIdPattern)).min(1).max(12).optional(),
  type: smassFieldTypeSchema.default("number"),
  format: smassFieldFormatSchema.optional(),
  classification: smassClassificationSchema.default("internal"),
  exposed: z.boolean().default(true),
}).strict().refine((data) => Boolean(data.sourceField || data.sourceFields?.length), {
  message: "Aggregate field must target an array sourceField or one or more scalar sourceFields.",
});

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

type CustomVirtualModelFile = Partial<Record<DomainPackId, CustomVirtualModelInput[]>>;

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
  private overrides: ExposureOverrideFile = {};
  private customModels: CustomVirtualModelFile = {};
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
  }) {
    this.signingSecret = loadOrCreateSphotonSecret(deps.dataDir);
    this.smass = deps.smass ?? createCepSmassRegistry({ opsStore: deps.opsStore, salesStore: deps.salesStore });
    this.exposureFile = join(deps.dataDir, "sphoton-exposures.json");
    this.customModelsFile = join(deps.dataDir, "smass-virtual-models.json");
    this.loadOverrides();
    this.loadCustomModels();
  }

  private loadOverrides() {
    try {
      if (!existsSync(this.exposureFile)) return;
      const parsed = JSON.parse(readFileSync(this.exposureFile, "utf8")) as ExposureOverrideFile;
      if (parsed && typeof parsed === "object") this.overrides = parsed;
    } catch {
      this.overrides = {};
    }
  }

  private saveOverrides() {
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
      ...(spec.description ? { description: spec.description } : {}),
      ...(primaryKey ? { primaryKey } : {}),
      sources,
      ...(compiledUnnest ? { unnest: compiledUnnest } : {}),
      fields,
      ...(relations ? { relations } : {}),
    });
  }

  private loadCustomModels() {
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
    } catch {
      this.customModels = {};
    }
  }

  private saveCustomModelsFile() {
    mkdirSync(dirname(this.customModelsFile), { recursive: true });
    writeFileSync(this.customModelsFile, JSON.stringify(this.customModels, null, 2));
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
  ): Promise<SmassVirtualSnapshotResult> {
    const parsed = customVirtualModelTestSchema.parse(req);
    const adapter = this.sfieldAdapter();
    const customerId = parsed.customerId || (domainId === "wealth" ? "demo-learner" : undefined);
    const turnCache = createTurnSnapshotCache();
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
    return [...byRef.values()];
  }

  summarizeDomainModels(domainId?: DomainPackId): SmassModelSummary[] {
    const descriptors = new Map(this.allToolDescriptors().map((desc) => [desc.ref, desc]));
    const summaries = this.smass.summarize(domainId, descriptors);
    if (!domainId) return summaries;
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

  domainWorkbenchView(domainId: DomainPackId) {
    const descriptors = new Map(this.allToolDescriptors().map((desc) => [desc.ref, desc]));
    const models = this.summarizeDomainModels(domainId);
    const dataModel = this.smass.toDataModelGraph(domainId, descriptors, models);
    const catalog = this.catalogForDomain(domainId);
    const exposedByKey = new Map(catalog.fields.map((f) => [`${f.toolRef}::${f.outputPath}`, f]));
    const actionRefs = new Set(models.flatMap((m) => m.actions.map((a) => a.toolRef)));
    const domainToolRefs = new Set<string>(models.flatMap((m) => m.toolRefs));
    for (const t of catalog.tools) domainToolRefs.add(t.toolRef);

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

    return {
      tenantId: this.deps.tenantId,
      domainId,
      models,
      customModelIds: (this.customModels[domainId] ?? []).map((m) => m.id),
      customModels: this.customModels[domainId] ?? [],
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
