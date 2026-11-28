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
export const wealthCustomerModel = defineToolBackedModel({
  id: "wealth.customer",
  version: toolVersion,
  domain: "wealth",
  label: "Wealth Customer",
  description: "Federated root entity anchored on principal.identifiers.mid linking portfolio, goals, and balances.",
  primaryKey: "customerId",
  sources: {
    portfolio: { toolRef: `${sfieldTools.portfolio.id}@${toolVersion}`, description: "Latest verified portfolio observation." },
  },
  fields: {
    customerId: {
      type: "string",
      principalKey: "mid",
      primaryKey: true,
      required: true,
      label: "Customer MID",
      description: "Principal-anchored customer identifier shared across federated Wealth sfield tools.",
      classification: "pii",
      exposed: false,
    },
    asOf: {
      from: "portfolio.asOf",
      label: "Snapshot date",
      format: "date",
      classification: "internal",
      exposed: false,
    },
  },
  relations: [
    {
      name: "holds_portfolio",
      targetModelId: "wealth.portfolio",
      cardinality: "one_to_one",
      localField: "customerId",
      foreignField: "customerId",
      description: "Each customer holds one consolidated portfolio snapshot.",
    },
    {
      name: "tracks_goals",
      targetModelId: "wealth.home_goal",
      cardinality: "one_to_many",
      localField: "customerId",
      foreignField: "customerId",
      description: "A customer tracks one or more savings goals.",
    },
    {
      name: "owns_balances",
      targetModelId: "wealth.balances",
      cardinality: "one_to_one",
      localField: "customerId",
      foreignField: "customerId",
      description: "A customer owns live account balance summaries.",
    },
  ],
});

export const wealthHomeGoalModel = defineToolBackedModel({
  id: "wealth.home_goal",
  version: toolVersion,
  domain: "wealth",
  label: "Goal Progress",
  description: "Home down-payment goal progress composed from goal.progress.read@1.0.0 and goal.savings.preview@1.0.0.",
  primaryKey: "goalId",
  sources: {
    goal: { toolRef: `${sfieldTools.goal.id}@${toolVersion}`, description: "Verified customer goal progress read." },
  },
  fields: {
    goalId: {
      from: "goal.goalId",
      primaryKey: true,
      required: true,
      label: "Goal ID",
      classification: "internal",
      exposed: false,
    },
    customerId: {
      type: "string",
      principalKey: "mid",
      required: true,
      foreignKey: { modelId: "wealth.customer", field: "customerId" },
      label: "Customer MID",
      classification: "pii",
      exposed: false,
    },
    targetCents: {
      from: "goal.targetCents",
      label: "Down payment target",
      description: "Target home down payment amount in cents.",
      required: true,
      format: "currency_cents",
      supportedFormats: ["currency_cents", "number"],
      classification: "confidential",
      legacyBindingKey: "goal.target",
    },
    history: {
      from: "goal.history",
      label: "Savings history",
      description: "Monthly savings progress history series.",
      required: true,
      format: "series",
      supportedFormats: ["series"],
      items: {
        month: { type: "string", required: true, description: "YYYY-MM month bucket" },
        savedCents: { type: "integer", required: true, description: "Cumulative savings in cents" },
      },
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
  relations: [
    {
      name: "belongs_to_customer",
      targetModelId: "wealth.customer",
      cardinality: "many_to_one",
      localField: "customerId",
      foreignField: "customerId",
    },
  ],
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
  primaryKey: "customerId",
  sources: {
    portfolio: { toolRef: `${sfieldTools.portfolio.id}@${toolVersion}` },
  },
  fields: {
    customerId: {
      type: "string",
      principalKey: "mid",
      primaryKey: true,
      required: true,
      foreignKey: { modelId: "wealth.customer", field: "customerId" },
      label: "Customer MID",
      classification: "pii",
      exposed: false,
    },
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
      required: true,
      format: "currency_cents",
      supportedFormats: ["currency_cents", "number"],
      classification: "confidential",
      legacyBindingKey: "portfolio.cash",
    },
    equityCents: {
      from: "portfolio.equityCents",
      label: "Portfolio equities",
      required: true,
      format: "currency_cents",
      supportedFormats: ["currency_cents", "number"],
      classification: "confidential",
      legacyBindingKey: "portfolio.equities",
    },
    fixedIncomeCents: {
      from: "portfolio.fixedIncomeCents",
      label: "Fixed income",
      required: true,
      format: "currency_cents",
      supportedFormats: ["currency_cents", "number"],
      classification: "confidential",
      exposed: false,
    },
    totalAssetsCents: {
      type: "integer",
      label: "Derived total assets",
      format: "currency_cents",
      computed: {
        expression: "cashCents + equityCents + fixedIncomeCents",
        dependsOn: ["cashCents", "equityCents", "fixedIncomeCents"],
      },
      classification: "confidential",
      exposed: false,
    },
  },
  relations: [
    {
      name: "belongs_to_customer",
      targetModelId: "wealth.customer",
      cardinality: "one_to_one",
      localField: "customerId",
      foreignField: "customerId",
    },
  ],
});

export const wealthBalancesModel = defineToolBackedModel({
  id: "wealth.balances",
  version: toolVersion,
  domain: "wealth",
  label: "Balances",
  description: "Account balance summary composed from demo.balance.read@1.0.0.",
  primaryKey: "customerId",
  sources: {
    balances: { toolRef: `${sfieldTools.balances.id}@${toolVersion}` },
  },
  fields: {
    customerId: {
      type: "string",
      principalKey: "mid",
      primaryKey: true,
      required: true,
      foreignKey: { modelId: "wealth.customer", field: "customerId" },
      label: "Customer MID",
      classification: "pii",
      exposed: false,
    },
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
  relations: [
    {
      name: "belongs_to_customer",
      targetModelId: "wealth.customer",
      cardinality: "one_to_one",
      localField: "customerId",
      foreignField: "customerId",
    },
  ],
});

/**
 * IT Ops Domain Models (Mode 2 — Store-backed).
 * Defined once here; smass automatically compiles closed JSON Schemas, sfield tools, ER graph, and sphoton catalog fields.
 */
export function createOpsServiceModel(opsStore?: OpsIncidentStore) {
  return defineStoreBackedModel({
    id: "ops.service",
    version: "1.0.0",
    domain: "it_ops",
    label: "Production Service",
    description: "Catalog of production services linked to active SRE incidents and release versions.",
    primaryKey: "service",
    readToolRef: "ops.service.read@1.0.0",
    readInputs: { service: { type: "string", description: "Optional service name." } },
    classification: "internal",
    fields: {
      service: { type: "string", label: "Service name", primaryKey: true, required: true },
      environment: { type: "string", label: "Environment", required: true, enumValues: ["production", "staging", "canary"] },
      activeRelease: { type: "string", label: "Active release", required: true },
      activeIncidentCount: { type: "integer", label: "Active incidents", format: "number", required: true },
    },
    relations: [
      {
        name: "has_incidents",
        targetModelId: "ops.incident",
        cardinality: "one_to_many",
        localField: "service",
        foreignField: "service",
        description: "Production service owns zero or more operational incidents.",
      },
    ],
    source: {
      read(inputs) {
        const incidents = opsStore?.list() ?? [];
        const requested = typeof inputs.service === "string" ? inputs.service : undefined;
        const match = (requested ? incidents.find((i) => i.service === requested) : incidents[0]) ?? opsStore?.primaryIncident();
        if (!match) return null;
        const count = incidents.filter((i) => i.service === match.service && i.status !== "resolved").length || 1;
        return {
          service: match.service,
          environment: match.environment,
          activeRelease: match.currentRelease,
          activeIncidentCount: count,
        };
      },
    },
  });
}

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
      id: { type: "string", label: "Incident ID", primaryKey: true, required: true, legacyBindingKey: "incident.id" },
      title: { type: "string", label: "Incident title", required: true, legacyBindingKey: "incident.title" },
      severity: { type: "string", label: "Severity", required: true, enumValues: ["P1", "P2", "P3"], legacyBindingKey: "incident.severity" },
      status: { type: "string", label: "Incident status", required: true, enumValues: ["investigating", "mitigated", "resolved"], legacyBindingKey: "incident.status" },
      service: {
        type: "string",
        label: "Affected service",
        required: true,
        foreignKey: { modelId: "ops.service", field: "service" },
        legacyBindingKey: "incident.service",
      },
      environment: { type: "string", label: "Environment", exposed: false },
      currentRelease: { type: "string", label: "Current release", legacyBindingKey: "incident.currentRelease" },
      previousRelease: { type: "string", label: "Previous release", exposed: false },
      rollbackStatus: {
        type: "string",
        label: "Rollback status",
        writable: true,
        enumValues: ["not_started", "pending_approval", "previewed", "approved", "rolled_back"],
        legacyBindingKey: "incident.rollbackStatus",
      },
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
    relations: [
      {
        name: "impacts_service",
        targetModelId: "ops.service",
        cardinality: "many_to_one",
        localField: "service",
        foreignField: "service",
      },
    ],
    lifecycle: {
      stateField: "rollbackStatus",
      states: ["not_started", "previewed", "pending_approval", "approved", "rolled_back"],
      transitions: [
        { from: "not_started", to: "previewed", actionId: "preview-rollback", label: "Preview rollback impact" },
        { from: "previewed", to: "pending_approval", label: "Submit HITL change ticket" },
        { from: "pending_approval", to: "approved", label: "SRE commander approval" },
        { from: "approved", to: "rolled_back", label: "Execute rollback" },
      ],
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
 * Sales RevOps Domain Models (Mode 2 — Store-backed).
 * Defined once here; smass automatically compiles closed JSON Schemas, sfield tools, ER graph, and sphoton catalog fields.
 */
export function createSalesAccountModel(salesStore?: SalesDealStore) {
  return defineStoreBackedModel({
    id: "sales.account",
    version: "1.0.0",
    domain: "sales_revops",
    label: "CRM Account",
    description: "Enterprise customer account aggregating open pipeline deals and assigned owner.",
    primaryKey: "accountName",
    readToolRef: "sales.account.read@1.0.0",
    readInputs: { accountName: { type: "string", description: "Optional enterprise account name." } },
    classification: "confidential",
    fields: {
      accountName: { type: "string", label: "Account name", primaryKey: true, required: true },
      owner: { type: "string", label: "Account owner", required: true },
      openDealCount: { type: "integer", label: "Open deals", format: "number", required: true },
      totalPipelineArrCents: {
        type: "integer",
        label: "Total pipeline ARR",
        format: "currency_cents",
        supportedFormats: ["currency_cents", "number"],
        required: true,
      },
    },
    relations: [
      {
        name: "has_deals",
        targetModelId: "sales.deal",
        cardinality: "one_to_many",
        localField: "accountName",
        foreignField: "accountName",
        description: "An enterprise account has one or more active pipeline opportunities.",
      },
    ],
    source: {
      read(inputs) {
        const deals = salesStore?.list() ?? [];
        const requested = typeof inputs.accountName === "string" ? inputs.accountName : undefined;
        const primary = (requested ? deals.find((d) => d.accountName === requested) : deals[0]) ?? salesStore?.primaryDeal();
        if (!primary) return null;
        const matching = deals.filter((d) => d.accountName === primary.accountName);
        const totalPipelineArrCents = matching.reduce((sum, d) => sum + Math.round(d.arrUsd * 100), 0);
        return {
          accountName: primary.accountName,
          owner: primary.owner,
          openDealCount: matching.length || 1,
          totalPipelineArrCents,
        };
      },
    },
  });
}

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
      id: { type: "string", label: "Deal ID", primaryKey: true, required: true, legacyBindingKey: "deal.id" },
      accountName: {
        type: "string",
        label: "Account name",
        required: true,
        foreignKey: { modelId: "sales.account", field: "accountName" },
        legacyBindingKey: "deal.accountName",
      },
      title: { type: "string", label: "Deal title", legacyBindingKey: "deal.title" },
      stage: {
        type: "string",
        label: "Pipeline stage",
        required: true,
        enumValues: ["Discovery", "Proposal", "Negotiation", "Closed Won", "Closed Lost"],
        legacyBindingKey: "deal.stage",
      },
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
      netArrCents: {
        type: "integer",
        label: "Net discounted ARR",
        format: "currency_cents",
        computed: {
          expression: "arrCents * (1 - discountPct / 100)",
          dependsOn: ["arrCents", "discountPct"],
        },
        exposed: false,
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
      discountStatus: {
        type: "string",
        label: "Discount status",
        enumValues: ["none", "pending_approval", "approved", "rejected"],
        exposed: false,
      },
    },
    relations: [
      {
        name: "belongs_to_account",
        targetModelId: "sales.account",
        cardinality: "many_to_one",
        localField: "accountName",
        foreignField: "accountName",
      },
    ],
    lifecycle: {
      stateField: "discountStatus",
      states: ["none", "pending_approval", "approved", "rejected"],
      transitions: [
        { from: "none", to: "pending_approval", actionId: "preview-discount", label: "Request discount exception" },
        { from: "pending_approval", to: "approved", label: "Approve discount (VP Finance)" },
        { from: "pending_approval", to: "rejected", label: "Reject exception" },
      ],
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
    wealthCustomerModel,
    wealthHomeGoalModel,
    wealthPortfolioModel,
    wealthBalancesModel,
    createOpsServiceModel(deps.opsStore),
    createOpsIncidentModel(deps.opsStore),
    createSalesAccountModel(deps.salesStore),
    createSalesDealModel(deps.salesStore),
  ]);
}
