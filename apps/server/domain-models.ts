import { sfieldTools, toolVersion } from "../../packages/contracts/tool-setup";
import {
  createSmassRegistry,
  defineStoreBackedModel,
  defineToolBackedModel,
  type SmassDomainRegistry,
} from "../../packages/smass";
import type { OpsIncidentStore } from "./ops-store";
import type { SalesDealStore } from "./sales-store";

/**
 * Wealth Domain Models (Mode 1 — Tool-backed / Federated).
 * Composed directly from tools already registered in sfield, with zero schema duplication.
 */
export const wealthHomeGoalModel = defineToolBackedModel({
  id: "wealth.home_goal",
  version: toolVersion,
  domain: "wealth",
  label: "Goal Progress",
  description: "Home down-payment goal progress composed from goal.progress.read@1.0.0 and goal.savings.preview@1.0.0.",
  sources: {
    goal: { toolRef: `${sfieldTools.goal.id}@${toolVersion}`, description: "Verified customer goal progress read." },
  },
  fields: {
    targetCents: {
      from: "goal.targetCents",
      label: "Down payment target",
      description: "Target home down payment amount in cents.",
      format: "currency_cents",
      supportedFormats: ["currency_cents", "number"],
      classification: "confidential",
      legacyBindingKey: "goal.target",
    },
    history: {
      from: "goal.history",
      label: "Savings history",
      description: "Monthly savings progress history series.",
      format: "series",
      supportedFormats: ["series"],
      classification: "confidential",
    },
    monthlyContributionCents: {
      from: "goal.monthlyContributionCents",
      label: "Current monthly savings",
      description: "Current recurring monthly savings amount in cents.",
      format: "currency_cents",
      supportedFormats: ["currency_cents", "number"],
      classification: "confidential",
    },
  },
  actions: [
    {
      id: "add-monthly-savings",
      toolRef: `${sfieldTools.goalScenario.id}@${toolVersion}`,
      label: "Add $500 a month",
      description: "Previews adding an extra monthly savings contribution and updates the goal chart in place.",
      effect: "read",
      fixedInputFields: { extraMonthlyCents: "integer" },
      followUpInputFields: ["startMonth"],
      defaultUpdate: "originalCard",
    },
  ],
});

export const wealthPortfolioModel = defineToolBackedModel({
  id: "wealth.portfolio",
  version: toolVersion,
  domain: "wealth",
  label: "Portfolio Snapshot",
  description: "Portfolio valuation composed from portfolio.snapshot.read@1.0.0.",
  sources: {
    portfolio: { toolRef: `${sfieldTools.portfolio.id}@${toolVersion}` },
  },
  fields: {
    totalCents: {
      from: "portfolio.totalCents",
      label: "Total portfolio value",
      format: "currency_cents",
      supportedFormats: ["currency_cents", "number"],
      classification: "confidential",
      legacyBindingKey: "portfolio.total",
    },
    cashCents: {
      from: "portfolio.cashCents",
      label: "Portfolio cash",
      format: "currency_cents",
      supportedFormats: ["currency_cents", "number"],
      classification: "confidential",
      legacyBindingKey: "portfolio.cash",
    },
    equityCents: {
      from: "portfolio.equityCents",
      label: "Portfolio equities",
      format: "currency_cents",
      supportedFormats: ["currency_cents", "number"],
      classification: "confidential",
      legacyBindingKey: "portfolio.equities",
    },
  },
});

export const wealthBalancesModel = defineToolBackedModel({
  id: "wealth.balances",
  version: toolVersion,
  domain: "wealth",
  label: "Balances",
  description: "Account balance summary composed from demo.balance.read@1.0.0.",
  sources: {
    balances: { toolRef: `${sfieldTools.balances.id}@${toolVersion}` },
  },
  fields: {
    available: {
      from: "balances.values.available",
      label: "Available balance",
      format: "currency",
      supportedFormats: ["currency", "number", "text"],
      classification: "confidential",
      legacyBindingKey: "balances.available",
    },
    current: {
      from: "balances.values.current",
      label: "Current balance",
      format: "currency",
      supportedFormats: ["currency", "number", "text"],
      classification: "confidential",
      legacyBindingKey: "balances.current",
    },
  },
});

/**
 * IT Ops Domain Model (Mode 2 — Store-backed).
 * Defined once here; smass automatically compiles its closed JSON Schemas, sfield tools, and sphoton catalog fields.
 */
export function createOpsIncidentModel(opsStore?: OpsIncidentStore) {
  return defineStoreBackedModel({
    id: "ops.incident",
    version: "1.0.0",
    domain: "it_ops",
    label: "IT Ops Incident",
    description: "Reads live SRE incident telemetry, release versions, and rollback state.",
    primaryKey: "id",
    readToolRef: "ops.incident.read@1.0.0",
    readInputs: { incidentId: { type: "string", description: "Optional incident ID (defaults to primary active incident)." } },
    classification: "internal",
    fields: {
      id: { type: "string", label: "Incident ID", required: true, legacyBindingKey: "incident.id" },
      title: { type: "string", label: "Incident title", required: true, legacyBindingKey: "incident.title" },
      severity: { type: "string", label: "Severity", required: true, legacyBindingKey: "incident.severity" },
      status: { type: "string", label: "Incident status", required: true, legacyBindingKey: "incident.status" },
      service: { type: "string", label: "Affected service", required: true, legacyBindingKey: "incident.service" },
      environment: { type: "string", label: "Environment", exposed: false },
      currentRelease: { type: "string", label: "Current release", legacyBindingKey: "incident.currentRelease" },
      previousRelease: { type: "string", label: "Previous release", exposed: false },
      rollbackStatus: { type: "string", label: "Rollback status", writable: true, legacyBindingKey: "incident.rollbackStatus" },
      errorRatePct: {
        type: "number",
        label: "Edge error rate",
        format: "percent",
        supportedFormats: ["percent", "number"],
        legacyBindingKey: "incident.errorRate",
      },
      p95LatencyMs: {
        type: "integer",
        label: "p95 latency (ms)",
        format: "number",
        supportedFormats: ["number"],
        legacyBindingKey: "incident.p95Latency",
      },
    },
    source: {
      read(inputs) {
        const incident = (typeof inputs.incidentId === "string" && opsStore?.findById(inputs.incidentId))
          || opsStore?.primaryIncident();
        if (!incident) return null;
        return {
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
        };
      },
    },
    actions: [
      {
        id: "preview-rollback",
        toolRef: "ops.incident.rollback.preview@1.0.0",
        label: "Preview rollback",
        description: "Simulates rolling back to the previous healthy release and updates the incident card in place.",
        effect: "read",
        inputs: {
          incidentId: { type: "string" },
          targetRelease: { type: "string" },
          window: { type: "string" },
        },
        outputs: {
          incidentId: { type: "string", required: true },
          targetRelease: { type: "string", required: true },
          window: { type: "string" },
          rollbackStatus: { type: "string", required: true },
          estimatedRecoveryMinutes: { type: "integer" },
        },
        fixedInputFields: { targetRelease: "string" },
        followUpInputFields: ["window"],
        defaultUpdate: "originalCard",
        handler(inputs) {
          const incident = (typeof inputs.incidentId === "string" && opsStore?.findById(inputs.incidentId))
            || opsStore?.primaryIncident();
          const targetRelease = typeof inputs.targetRelease === "string" ? inputs.targetRelease : (incident?.previousRelease ?? "v2.4.0");
          const window = typeof inputs.window === "string" ? inputs.window : "immediate";
          return {
            incidentId: incident?.id ?? "INC-4012",
            targetRelease,
            window,
            rollbackStatus: `Ready to roll back to ${targetRelease} (${window})`,
            estimatedRecoveryMinutes: window === "immediate" ? 3 : 8,
          };
        },
      },
    ],
  });
}

/**
 * Sales RevOps Domain Model (Mode 2 — Store-backed).
 * Defined once here; smass automatically compiles its closed JSON Schemas, sfield tools, and sphoton catalog fields.
 */
export function createSalesDealModel(salesStore?: SalesDealStore) {
  return defineStoreBackedModel({
    id: "sales.deal",
    version: "1.0.0",
    domain: "sales_revops",
    label: "Sales Deal",
    description: "Reads CRM deal ARR, discount request, stage, and win probability.",
    primaryKey: "id",
    readToolRef: "sales.deal.read@1.0.0",
    readInputs: { dealId: { type: "string", description: "Optional deal ID (defaults to primary active deal)." } },
    classification: "confidential",
    fields: {
      id: { type: "string", label: "Deal ID", required: true, legacyBindingKey: "deal.id" },
      accountName: { type: "string", label: "Account name", required: true, legacyBindingKey: "deal.accountName" },
      title: { type: "string", label: "Deal title", legacyBindingKey: "deal.title" },
      stage: { type: "string", label: "Pipeline stage", required: true, legacyBindingKey: "deal.stage" },
      owner: { type: "string", label: "Deal owner", exposed: false },
      arrCents: {
        type: "integer",
        label: "Annual recurring revenue",
        required: true,
        format: "currency_cents",
        supportedFormats: ["currency_cents", "number"],
        legacyBindingKey: "deal.arr",
      },
      discountPct: {
        type: "number",
        label: "Requested discount",
        format: "percent",
        supportedFormats: ["percent", "number"],
        writable: true,
        legacyBindingKey: "deal.discountPct",
      },
      winProbability: {
        type: "integer",
        label: "Win probability",
        format: "percent",
        supportedFormats: ["percent", "number"],
        legacyBindingKey: "deal.winProbability",
      },
      closeDate: {
        type: "string",
        label: "Target close date",
        format: "date",
        supportedFormats: ["date", "text"],
        legacyBindingKey: "deal.closeDate",
      },
      discountStatus: { type: "string", label: "Discount status", exposed: false },
    },
    source: {
      read(inputs) {
        const deal = (typeof inputs.dealId === "string" && salesStore?.list().find((d) => d.id === inputs.dealId))
          || salesStore?.primaryDeal();
        if (!deal) return null;
        return {
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
        };
      },
    },
    actions: [
      {
        id: "preview-discount",
        toolRef: "sales.discount.preview@1.0.0",
        label: "Preview discount impact",
        description: "Calculates net ARR and approval tier for a discount scenario and updates the deal card in place.",
        effect: "read",
        inputs: {
          dealId: { type: "string" },
          discountPct: { type: "number" },
          termMonths: { type: "integer" },
        },
        outputs: {
          dealId: { type: "string", required: true },
          discountPct: { type: "number", required: true },
          termMonths: { type: "integer" },
          netArrCents: { type: "integer", required: true },
          approvalLevel: { type: "string" },
        },
        fixedInputFields: { discountPct: "number" },
        followUpInputFields: ["termMonths"],
        defaultUpdate: "originalCard",
        handler(inputs) {
          const deal = (typeof inputs.dealId === "string" && salesStore?.list().find((d) => d.id === inputs.dealId))
            || salesStore?.primaryDeal();
          const baseArrCents = Math.round((deal?.arrUsd ?? 480_000) * 100);
          const discountPct = typeof inputs.discountPct === "number" ? inputs.discountPct : (deal?.discountPct ?? 15);
          const termMonths = typeof inputs.termMonths === "number" ? inputs.termMonths : 12;
          const netArrCents = Math.round(baseArrCents * (1 - discountPct / 100));
          return {
            dealId: deal?.id ?? "DEAL-2041",
            discountPct,
            termMonths,
            netArrCents,
            approvalLevel: discountPct > 20 ? "VP Finance" : "Deal Desk",
          };
        },
      },
    ],
  });
}

export function createCepSmassRegistry(deps: {
  opsStore?: OpsIncidentStore;
  salesStore?: SalesDealStore;
}): SmassDomainRegistry {
  return createSmassRegistry([
    wealthHomeGoalModel,
    wealthPortfolioModel,
    wealthBalancesModel,
    createOpsIncidentModel(deps.opsStore),
    createSalesDealModel(deps.salesStore),
  ]);
}
