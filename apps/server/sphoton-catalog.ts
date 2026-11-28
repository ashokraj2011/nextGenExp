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

const opsIncidentInputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: { incidentId: { type: "string" } },
};
const opsIncidentOutputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    severity: { type: "string" },
    status: { type: "string" },
    service: { type: "string" },
    environment: { type: "string" },
    currentRelease: { type: "string" },
    previousRelease: { type: "string" },
    rollbackStatus: { type: "string" },
    errorRatePct: { type: "number" },
    p95LatencyMs: { type: "integer" },
  },
  required: ["id", "title", "severity", "status", "service"],
};
const opsRollbackPreviewInputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    incidentId: { type: "string" },
    targetRelease: { type: "string" },
    window: { type: "string" },
  },
};
const opsRollbackPreviewOutputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    incidentId: { type: "string" },
    targetRelease: { type: "string" },
    window: { type: "string" },
    rollbackStatus: { type: "string" },
    estimatedRecoveryMinutes: { type: "integer" },
  },
  required: ["incidentId", "targetRelease", "rollbackStatus"],
};

const salesDealInputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: { dealId: { type: "string" } },
};
const salesDealOutputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    accountName: { type: "string" },
    title: { type: "string" },
    stage: { type: "string" },
    owner: { type: "string" },
    arrCents: { type: "integer" },
    discountPct: { type: "number" },
    winProbability: { type: "integer" },
    closeDate: { type: "string" },
    discountStatus: { type: "string" },
  },
  required: ["id", "accountName", "stage", "arrCents"],
};
const salesDiscountPreviewInputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    dealId: { type: "string" },
    discountPct: { type: "number" },
    termMonths: { type: "integer" },
  },
};
const salesDiscountPreviewOutputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    dealId: { type: "string" },
    discountPct: { type: "number" },
    termMonths: { type: "integer" },
    netArrCents: { type: "integer" },
    approvalLevel: { type: "string" },
  },
  required: ["dealId", "discountPct", "netArrCents"],
};

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

type DefaultFieldExposure = {
  toolRef: string;
  outputPath: string;
  label: string;
  group: string;
  description?: string;
  supportedFormats?: SphotonFormat[];
  defaultFormat?: SphotonFormat;
  legacyBindingKey?: string;
};

const DEFAULT_EXPOSURES: Record<DomainPackId, DefaultFieldExposure[]> = {
  wealth: [
    {
      toolRef: `${sfieldTools.goal.id}@${toolVersion}`,
      outputPath: "targetCents",
      label: "Down payment target",
      group: "Goal Progress (sfield)",
      description: "Target home down payment amount in cents.",
      supportedFormats: ["currency_cents", "number"],
      defaultFormat: "currency_cents",
      legacyBindingKey: "goal.target",
    },
    {
      toolRef: `${sfieldTools.goal.id}@${toolVersion}`,
      outputPath: "history",
      label: "Savings history",
      group: "Goal Progress (sfield)",
      description: "Monthly savings progress history series.",
      supportedFormats: ["series"],
      defaultFormat: "series",
    },
    {
      toolRef: `${sfieldTools.goal.id}@${toolVersion}`,
      outputPath: "monthlyContributionCents",
      label: "Current monthly savings",
      group: "Goal Progress (sfield)",
      description: "Current recurring monthly savings amount in cents.",
      supportedFormats: ["currency_cents", "number"],
      defaultFormat: "currency_cents",
    },
    {
      toolRef: `${sfieldTools.portfolio.id}@${toolVersion}`,
      outputPath: "totalCents",
      label: "Total portfolio value",
      group: "Portfolio Snapshot (sfield)",
      supportedFormats: ["currency_cents", "number"],
      defaultFormat: "currency_cents",
      legacyBindingKey: "portfolio.total",
    },
    {
      toolRef: `${sfieldTools.portfolio.id}@${toolVersion}`,
      outputPath: "cashCents",
      label: "Portfolio cash",
      group: "Portfolio Snapshot (sfield)",
      supportedFormats: ["currency_cents", "number"],
      defaultFormat: "currency_cents",
      legacyBindingKey: "portfolio.cash",
    },
    {
      toolRef: `${sfieldTools.portfolio.id}@${toolVersion}`,
      outputPath: "equityCents",
      label: "Portfolio equities",
      group: "Portfolio Snapshot (sfield)",
      supportedFormats: ["currency_cents", "number"],
      defaultFormat: "currency_cents",
      legacyBindingKey: "portfolio.equities",
    },
    {
      toolRef: `${sfieldTools.balances.id}@${toolVersion}`,
      outputPath: "values.available",
      label: "Available balance",
      group: "Balances (sfield)",
      supportedFormats: ["currency", "number", "text"],
      defaultFormat: "currency",
      legacyBindingKey: "balances.available",
    },
    {
      toolRef: `${sfieldTools.balances.id}@${toolVersion}`,
      outputPath: "values.current",
      label: "Current balance",
      group: "Balances (sfield)",
      supportedFormats: ["currency", "number", "text"],
      defaultFormat: "currency",
      legacyBindingKey: "balances.current",
    },
  ],
  it_ops: [
    { toolRef: "ops.incident.read@1.0.0", outputPath: "id", label: "Incident ID", group: "IT Ops Incident (sfield)", legacyBindingKey: "incident.id" },
    { toolRef: "ops.incident.read@1.0.0", outputPath: "title", label: "Incident title", group: "IT Ops Incident (sfield)", legacyBindingKey: "incident.title" },
    { toolRef: "ops.incident.read@1.0.0", outputPath: "severity", label: "Severity", group: "IT Ops Incident (sfield)", legacyBindingKey: "incident.severity" },
    { toolRef: "ops.incident.read@1.0.0", outputPath: "status", label: "Incident status", group: "IT Ops Incident (sfield)", legacyBindingKey: "incident.status" },
    { toolRef: "ops.incident.read@1.0.0", outputPath: "service", label: "Affected service", group: "IT Ops Incident (sfield)", legacyBindingKey: "incident.service" },
    { toolRef: "ops.incident.read@1.0.0", outputPath: "currentRelease", label: "Current release", group: "IT Ops Incident (sfield)", legacyBindingKey: "incident.currentRelease" },
    { toolRef: "ops.incident.read@1.0.0", outputPath: "rollbackStatus", label: "Rollback status", group: "IT Ops Incident (sfield)", legacyBindingKey: "incident.rollbackStatus" },
    { toolRef: "ops.incident.read@1.0.0", outputPath: "errorRatePct", label: "Edge error rate", group: "IT Ops Incident (sfield)", supportedFormats: ["percent", "number"], defaultFormat: "percent", legacyBindingKey: "incident.errorRate" },
    { toolRef: "ops.incident.read@1.0.0", outputPath: "p95LatencyMs", label: "p95 latency (ms)", group: "IT Ops Incident (sfield)", supportedFormats: ["number"], defaultFormat: "number", legacyBindingKey: "incident.p95Latency" },
  ],
  sales_revops: [
    { toolRef: "sales.deal.read@1.0.0", outputPath: "id", label: "Deal ID", group: "Sales Deal (sfield)", legacyBindingKey: "deal.id" },
    { toolRef: "sales.deal.read@1.0.0", outputPath: "accountName", label: "Account name", group: "Sales Deal (sfield)", legacyBindingKey: "deal.accountName" },
    { toolRef: "sales.deal.read@1.0.0", outputPath: "title", label: "Deal title", group: "Sales Deal (sfield)", legacyBindingKey: "deal.title" },
    { toolRef: "sales.deal.read@1.0.0", outputPath: "stage", label: "Pipeline stage", group: "Sales Deal (sfield)", legacyBindingKey: "deal.stage" },
    { toolRef: "sales.deal.read@1.0.0", outputPath: "arrCents", label: "Annual recurring revenue", group: "Sales Deal (sfield)", supportedFormats: ["currency_cents", "number"], defaultFormat: "currency_cents", legacyBindingKey: "deal.arr" },
    { toolRef: "sales.deal.read@1.0.0", outputPath: "discountPct", label: "Requested discount", group: "Sales Deal (sfield)", supportedFormats: ["percent", "number"], defaultFormat: "percent", legacyBindingKey: "deal.discountPct" },
    { toolRef: "sales.deal.read@1.0.0", outputPath: "winProbability", label: "Win probability", group: "Sales Deal (sfield)", supportedFormats: ["percent", "number"], defaultFormat: "percent", legacyBindingKey: "deal.winProbability" },
    { toolRef: "sales.deal.read@1.0.0", outputPath: "closeDate", label: "Target close date", group: "Sales Deal (sfield)", supportedFormats: ["date", "text"], defaultFormat: "date", legacyBindingKey: "deal.closeDate" },
  ],
};

type ExposureOverrideFile = Partial<Record<DomainPackId, DomainFieldExposure[]>>;

export class SphotonCatalogService {
  readonly signingSecret: string;
  private readonly exposureFile: string;
  private overrides: ExposureOverrideFile = {};
  private customToolSchemas = new Map<string, SfieldToolDescriptor>();

  constructor(private readonly deps: {
    tenantId: string;
    dataDir: string;
    getRuntime: () => Runtime | null;
    integrationService?: IntegrationTaskService;
    goalProgressProvider?: GoalProgressProvider;
    portfolioSnapshots?: PortfolioSnapshotProvider;
    opsStore?: OpsIncidentStore;
    salesStore?: SalesDealStore;
  }) {
    this.signingSecret = loadOrCreateSphotonSecret(deps.dataDir);
    this.exposureFile = join(deps.dataDir, "sphoton-exposures.json");
    this.loadOverrides();
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

  /**
   * Registers/updates a headless tool descriptor override (used by tests and dynamic tool registration).
   */
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
      {
        ref: "ops.incident.read@1.0.0",
        id: "ops.incident.read",
        version: "1.0.0",
        description: "Reads live SRE incident telemetry, release versions, and rollback state.",
        inputs: opsIncidentInputSchema,
        outputs: opsIncidentOutputSchema,
      },
      {
        ref: "ops.incident.rollback.preview@1.0.0",
        id: "ops.incident.rollback.preview",
        version: "1.0.0",
        description: "Previews rolling back a service to a target release version.",
        inputs: opsRollbackPreviewInputSchema,
        outputs: opsRollbackPreviewOutputSchema,
      },
      {
        ref: "sales.deal.read@1.0.0",
        id: "sales.deal.read",
        version: "1.0.0",
        description: "Reads CRM deal ARR, discount request, stage, and win probability.",
        inputs: salesDealInputSchema,
        outputs: salesDealOutputSchema,
      },
      {
        ref: "sales.discount.preview@1.0.0",
        id: "sales.discount.preview",
        version: "1.0.0",
        description: "Previews net ARR and approval tier for a requested discount and term.",
        inputs: salesDiscountPreviewInputSchema,
        outputs: salesDiscountPreviewOutputSchema,
      },
    ];
  }

  private allToolDescriptors(): SfieldToolDescriptor[] {
    const byRef = new Map<string, SfieldToolDescriptor>();
    for (const desc of this.builtinToolDescriptors()) {
      byRef.set(desc.ref, desc);
    }

    // Pull live closed schemas from sfield registry when runtime is connected (still zero UI in sfield).
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

    // Also include published integration read contracts so domain-registered tools are discoverable offline too.
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
      if (toolRef === "ops.incident.read@1.0.0") {
        const incident = (typeof inputs.incidentId === "string" && this.deps.opsStore?.findById(inputs.incidentId))
          || this.deps.opsStore?.primaryIncident();
        if (!incident) {
          return { status: "failed", toolRef, error: { code: "INCIDENT_UNAVAILABLE", message: "No active incident found." } };
        }
        return {
          status: "succeeded",
          toolRef,
          output: {
            id: incident.id,
            title: incident.title,
            severity: incident.severity,
            status: incident.status,
            service: incident.service,
            environment: incident.environment,
            currentRelease: incident.currentRelease,
            previousRelease: incident.previousRelease,
            rollbackStatus: incident.rollbackStatus,
            errorRatePct: incident.errorRatePct,
            p95LatencyMs: incident.p95LatencyMs,
          },
        };
      }
      if (toolRef === "sales.deal.read@1.0.0") {
        const deal = (typeof inputs.dealId === "string" && this.deps.salesStore?.list().find((d) => d.id === inputs.dealId))
          || this.deps.salesStore?.primaryDeal();
        if (!deal) {
          return { status: "failed", toolRef, error: { code: "DEAL_UNAVAILABLE", message: "No active deal found." } };
        }
        return {
          status: "succeeded",
          toolRef,
          output: {
            id: deal.id,
            accountName: deal.accountName,
            title: deal.title,
            stage: deal.stage,
            owner: deal.owner,
            arrCents: Math.round(deal.arrUsd * 100),
            discountPct: deal.discountPct,
            winProbability: deal.winProbabilityPct,
            closeDate: deal.closeDate,
            discountStatus: deal.discountStatus,
          },
        };
      }
      return { status: "failed", toolRef, error: { code: "TOOL_UNAVAILABLE", message: `Read tool ${toolRef} is not executable in this context.` } };
    };

    const executeAction = async (input: {
      toolRef: string;
      inputs: Record<string, unknown>;
      scope: SphotonExecutionScope;
      signal?: AbortSignal;
    }): Promise<SfieldToolExecutionResult> => {
      const { toolRef, inputs } = input;
      if (toolRef === "ops.incident.rollback.preview@1.0.0") {
        const incident = (typeof inputs.incidentId === "string" && this.deps.opsStore?.findById(inputs.incidentId))
          || this.deps.opsStore?.primaryIncident();
        const targetRelease = typeof inputs.targetRelease === "string" ? inputs.targetRelease : (incident?.previousRelease ?? "v2.4.0");
        const window = typeof inputs.window === "string" ? inputs.window : "immediate";
        return {
          status: "succeeded",
          toolRef,
          output: {
            incidentId: incident?.id ?? "INC-4012",
            targetRelease,
            window,
            rollbackStatus: `Ready to roll back to ${targetRelease} (${window})`,
            estimatedRecoveryMinutes: window === "immediate" ? 3 : 8,
          },
        };
      }
      if (toolRef === "sales.discount.preview@1.0.0") {
        const deal = (typeof inputs.dealId === "string" && this.deps.salesStore?.list().find((d) => d.id === inputs.dealId))
          || this.deps.salesStore?.primaryDeal();
        const baseArrCents = Math.round((deal?.arrUsd ?? 480_000) * 100);
        const discountPct = typeof inputs.discountPct === "number" ? inputs.discountPct : (deal?.discountPct ?? 15);
        const termMonths = typeof inputs.termMonths === "number" ? inputs.termMonths : 12;
        const netArrCents = Math.round(baseArrCents * (1 - discountPct / 100));
        return {
          status: "succeeded",
          toolRef,
          output: {
            dealId: deal?.id ?? "DEAL-2041",
            discountPct,
            termMonths,
            netArrCents,
            approvalLevel: discountPct > 20 ? "VP Finance" : "Deal Desk",
          },
        };
      }
      return { status: "failed", toolRef, error: { code: "ACTION_UNSUPPORTED", message: `Action ${toolRef} must run through its scoped runtime handler.` } };
    };

    return { listTools, describeTool, executeRead, executeAction };
  }

  catalogForDomain(domainId: DomainPackId): SphotonBindingCatalog {
    const adapter = this.sfieldAdapter();
    const descriptors = new Map(adapter.listTools().map((desc) => [desc.ref, desc]));
    const baseExposures = DEFAULT_EXPOSURES[domainId] ?? [];
    const domainOverrides = this.overrides[domainId] ?? [];

    // Merge default exposures with domain owner overrides (expose new fields or hide existing ones).
    const mergedMap = new Map<string, DomainFieldExposure & { legacyBindingKey?: string }>();
    for (const item of baseExposures) {
      mergedMap.set(`${item.toolRef}::${item.outputPath}`, {
        toolRef: item.toolRef,
        outputPath: item.outputPath,
        label: item.label,
        group: item.group,
        description: item.description,
        supportedFormats: item.supportedFormats,
        defaultFormat: item.defaultFormat,
        exposed: true,
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
    const addAction = (spec: {
      id: string;
      toolRef: string;
      label: string;
      description: string;
      fixedInputFields: Record<string, SphotonFieldType>;
      followUpInputFields: string[];
      defaultUpdate: "originalCard" | "newTurn";
    }) => {
      const desc = descriptors.get(spec.toolRef);
      if (!desc) return;
      referencedTools.add(spec.toolRef);
      actions.push({
        ...spec,
        inputSchema: desc.inputs,
        outputSchema: desc.outputs,
        contractFingerprint: fingerprintToolContract(desc.ref, desc.inputs, desc.outputs),
      });
    };

    if (domainId === "wealth") {
      addAction({
        id: "add-monthly-savings",
        toolRef: `${sfieldTools.goalScenario.id}@${toolVersion}`,
        label: "Add $500 a month",
        description: "Previews adding an extra monthly savings contribution and updates the goal chart in place.",
        fixedInputFields: { extraMonthlyCents: "integer" },
        followUpInputFields: ["startMonth"],
        defaultUpdate: "originalCard",
      });
    } else if (domainId === "it_ops") {
      addAction({
        id: "preview-rollback",
        toolRef: "ops.incident.rollback.preview@1.0.0",
        label: "Preview rollback",
        description: "Simulates rolling back to the previous healthy release and updates the incident card in place.",
        fixedInputFields: { targetRelease: "string" },
        followUpInputFields: ["window"],
        defaultUpdate: "originalCard",
      });
    } else if (domainId === "sales_revops") {
      addAction({
        id: "preview-discount",
        toolRef: "sales.discount.preview@1.0.0",
        label: "Preview discount impact",
        description: "Calculates net ARR and approval tier for a discount scenario and updates the deal card in place.",
        fixedInputFields: { discountPct: "number" },
        followUpInputFields: ["termMonths"],
        defaultUpdate: "originalCard",
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
