import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  defineStoreBackedModel,
  SmassDomainRegistry,
  type SmassDataModelGraph,
  type SmassDomainModel,
  type SmassExecutionContext,
} from "../../packages/smass";

export type PznDemoContextId = "balance" | "portsum" | "address-update" | "pending-actions";

export type Customer360Record = {
  mid: string;
  displayName: string;
  accountStatus: "open" | "restricted" | "closed";
  fundingStatus: "unfunded" | "pending" | "funded";
  availableBalanceCents: number;
  currentBalanceCents: number;
  portfolioCashCents: number;
  accountVersion: number;
  balanceVersion: string;
};

export type SmassFactSnapshot = {
  snapshotId: string;
  mid: string;
  fetchedAt: string;
  dataVersions: {
    accountVersion: number;
    balanceVersion: string;
  };
  facts: Customer360Record;
};

export type CcreSharedRule = {
  ruleId: string;
  label: string;
  description: string;
  field: keyof Customer360Record;
  op: "==" | ">=";
  value: string | number;
  enabled: boolean;
  contexts: PznDemoContextId[];
};

export type CcreRuleOutcome = {
  ruleId: string;
  label: string;
  matched: boolean;
  field: keyof Customer360Record;
  observedValue: string | number;
  expected: string;
  dataVersionRef: string;
};

export type RankedCandidate = {
  contentId: string;
  placement: "primary" | "nextAction";
  score: number;
  baseScore: number;
  verifiedOutcomeLift: number;
  selected: boolean;
};

export type PznPlacement =
  | {
      kind: "content";
      id: string;
      title: string;
      summary: string;
      card: Record<string, unknown>;
      enrichedFromSnapshotId: string;
    }
  | {
      kind: "action";
      id: string;
      version: string;
      contentId: string;
      title: string;
      summary: string;
    }
  | {
      kind: "workflow";
      id: string;
      version: string;
      contentId: string;
      recommendationId: string;
      title: string;
      summary: string;
      ctaLabel: string;
      card?: Record<string, unknown>;
      signedActionToken: string;
      enrichedFromSnapshotId: string;
    };

export type PznTraceExchange = {
  step: number;
  stage:
    | "channel_to_ts"
    | "ts_to_ccre"
    | "ccre_to_smass_data_agg"
    | "ts_to_ranking"
    | "ts_to_resolver"
    | "pzn_to_sfield"
    | "sfield_tool"
    | "event_refresh";
  from: string;
  to: string;
  summary: string;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  timestamp: string;
};

export type PznWorkflowStepResult = {
  step: number;
  toolRef: string;
  label: string;
  turnRef: string;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
};

export type PznWorkflowExecutionRecord = {
  workflowId: string;
  workflowVersion: string;
  decisionId: string;
  revision: number;
  mid: string;
  turnRef: string;
  executedAt: string;
  signatureVerified: boolean;
  status: "preview";
  preview: {
    methodId: string;
    methodLabel: string;
    amountCents: number;
    currency: "USD";
    accountFundingStatus: string;
  };
  steps: PznWorkflowStepResult[];
};

export type PznDecisionRecord = {
  decisionId: string;
  revision: number;
  mid: string;
  displayName: string;
  context: PznDemoContextId;
  trigger: string;
  createdAt: string;
  updatedAt: string;
  snapshotId: string;
  dataVersions: {
    accountVersion: number;
    balanceVersion: string;
  };
  dataAggCalls: number;
  snapshotReusedByResolver: boolean;
  ruleOutcomes: CcreRuleOutcome[];
  rankedCandidates: RankedCandidate[];
  placements: {
    primary: PznPlacement | null;
    nextAction: PznPlacement | null;
  };
  workflowExecutions: PznWorkflowExecutionRecord[];
  refreshEvents: Array<{
    eventId: string;
    eventType: "funding.confirmed";
    minAccountVersion: number;
    appliedRevision: number;
    appliedAt: string;
    clearedNextAction: boolean;
  }>;
  exchanges: PznTraceExchange[];
  ledgerHash: string;
};

export type RankingMetricRow = {
  contentId: string;
  label: string;
  baseScore: number;
  impressions: number;
  clicks: number;
  verifiedOutcomes: number;
  effectiveScore: number;
};

export type PznDecisionPlaneState = {
  smassGraph: SmassDataModelGraph;
  smassValidationIssues: number;
  personas: Customer360Record[];
  rules: CcreSharedRule[];
  rankingMetrics: RankingMetricRow[];
  decisions: PznDecisionRecord[];
};

function initialPersonas(): Map<string, Customer360Record> {
  return new Map<string, Customer360Record>([
    [
      "DEMO-MID-1001",
      {
        mid: "DEMO-MID-1001",
        displayName: "Alice Morgan",
        accountStatus: "open",
        fundingStatus: "funded",
        availableBalanceCents: 125_000,
        currentBalanceCents: 150_000,
        portfolioCashCents: 1_250_000,
        accountVersion: 17,
        balanceVersion: "bal_17",
      },
    ],
    [
      "DEMO-MID-1003",
      {
        mid: "DEMO-MID-1003",
        displayName: "Marcus Reed",
        accountStatus: "open",
        fundingStatus: "unfunded",
        availableBalanceCents: 0,
        currentBalanceCents: 0,
        portfolioCashCents: 0,
        accountVersion: 41,
        balanceVersion: "bal_41",
      },
    ],
  ]);
}

function initialRules(): CcreSharedRule[] {
  return [
    {
      ruleId: "open_account",
      label: "Account is open",
      description: "Verifies the member holds an active open account before rendering balance or portfolio views.",
      field: "accountStatus",
      op: "==",
      value: "open",
      enabled: true,
      contexts: ["balance", "portsum"],
    },
    {
      ruleId: "cash_above_10k",
      label: "Cash above $10,000",
      description: "Recommends exploring investing options when uninvested portfolio cash exceeds the threshold.",
      field: "portfolioCashCents",
      op: ">=",
      value: 1_000_000,
      enabled: true,
      contexts: ["portsum"],
    },
    {
      ruleId: "first_deposit",
      label: "Shared first-deposit rule",
      description:
        "One canonical CCRE rule shared across Address Help, Pending Actions, and Chat — edit once, update everywhere.",
      field: "fundingStatus",
      op: "==",
      value: "unfunded",
      enabled: true,
      contexts: ["address-update", "pending-actions"],
    },
  ];
}

function initialRankingStats(): Map<string, { label: string; baseScore: number; impressions: number; clicks: number; verifiedOutcomes: number }> {
  return new Map([
    ["balance_metric_template", { label: "Balance Summary Card", baseScore: 0.91, impressions: 18, clicks: 7, verifiedOutcomes: 6 }],
    ["balance_education", { label: "Balance Education Explainer", baseScore: 0.64, impressions: 18, clicks: 3, verifiedOutcomes: 1 }],
    ["explore_investing_options", { label: "Explore Investing Options", baseScore: 0.84, impressions: 12, clicks: 5, verifiedOutcomes: 4 }],
    ["address_update_guide", { label: "Address Update Guided Action", baseScore: 0.95, impressions: 14, clicks: 11, verifiedOutcomes: 10 }],
    ["fund_account", { label: "First Deposit Funding Workflow", baseScore: 0.82, impressions: 15, clicks: 6, verifiedOutcomes: 4 }],
  ]);
}

/**
 * Interactive PZN + smass + sfield Decision Plane Engine.
 * Demonstrates how smass (closed-schema Customer 360 + single versioned snapshot) and sfield
 * (signed workflow execution, audit ledger, and event-driven revisions) modernize TS, CCRE,
 * Data Agg, Ranking Model, and Treatment Resolver into an enterprise agentic decision plane.
 */
export class PznDecisionPlane {
  private readonly secret: Buffer;
  private personas = initialPersonas();
  private rules = initialRules();
  private ranking = initialRankingStats();
  private decisions = new Map<string, PznDecisionRecord>();
  private decisionOrder: string[] = [];
  private seq = 0;
  private readonly registry: SmassDomainRegistry;
  private readonly customer360Model: SmassDomainModel;

  constructor(secretSeed?: string) {
    this.secret = Buffer.from(secretSeed ?? randomBytes(32).toString("hex"), "utf8");
    const model = defineStoreBackedModel<Customer360Record>({
      id: "customer_360",
      version: "1.0.0",
      domain: "pzn_pilot",
      label: "Customer 360 (Data Agg)",
      description:
        "Canonical closed-schema Customer 360 entity backed by Data Agg. Shared across CCRE rules and Treatment Resolver via versioned snapshots.",
      primaryKey: "mid",
      readInputs: {
        mid: { type: "string", required: true, description: "Member ID (MID)" },
      },
      classification: "confidential",
      fields: {
        mid: {
          type: "string",
          label: "Member ID",
          primaryKey: true,
          principalKey: "mid",
          required: true,
          classification: "pii",
        },
        displayName: {
          type: "string",
          label: "Member Name",
          required: true,
          classification: "pii",
        },
        accountStatus: {
          type: "string",
          label: "Account Status",
          required: true,
          enumValues: ["open", "restricted", "closed"],
        },
        fundingStatus: {
          type: "string",
          label: "Funding Status",
          required: true,
          enumValues: ["unfunded", "pending", "funded"],
        },
        availableBalanceCents: {
          type: "integer",
          label: "Available Balance",
          format: "currency_cents",
          required: true,
        },
        currentBalanceCents: {
          type: "integer",
          label: "Current Balance",
          format: "currency_cents",
          required: true,
        },
        portfolioCashCents: {
          type: "integer",
          label: "Portfolio Cash",
          format: "currency_cents",
          required: true,
        },
        accountVersion: {
          type: "integer",
          label: "Account Data Version",
          required: true,
        },
        balanceVersion: {
          type: "string",
          label: "Balance Data Version",
          required: true,
        },
      },
      lifecycle: {
        stateField: "fundingStatus",
        states: ["unfunded", "pending", "funded"],
        transitions: [
          { from: "unfunded", to: "pending", actionId: "account.funding.preview", label: "Preview first deposit" },
          { from: "pending", to: "funded", actionId: "funding.confirmed", label: "Confirm deposit" },
          { from: "unfunded", to: "funded", actionId: "funding.confirmed", label: "Confirm deposit" },
        ],
      },
      actions: [
        {
          id: "account.funding.preview",
          toolRef: "account.funding.preview@1.0.0",
          label: "Preview first deposit",
          description: "Runs deterministic 3-step sfield funding preview workflow.",
          effect: "read",
        },
        {
          id: "funding.confirmed",
          toolRef: "account.funding.confirm@1.0.0",
          label: "Confirm deposit",
          description: "Marks member funded and advances Customer 360 accountVersion.",
          effect: "write",
        },
      ],
      source: {
        read: (inputs) => {
          const mid = String(inputs.mid ?? "");
          const row = this.personas.get(mid);
          return row ? { ...row } : null;
        },
        list: () => [...this.personas.values()].map((row) => ({ ...row })),
      },
    });
    this.customer360Model = model;
    this.registry = new SmassDomainRegistry([model]);
  }

  private execCtx(mid: string): SmassExecutionContext {
    return { tenantId: "pzn-pilot", domainId: "pzn_pilot", principalId: mid, customerId: mid };
  }

  private signAction(payload: {
    decisionId: string;
    revision: number;
    mid: string;
    workflowId: string;
    workflowVersion: string;
  }): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const sig = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    return `sfa_v1.${encoded}.${sig}`;
  }

  private verifyActionToken(token: string): {
    valid: boolean;
    payload?: { decisionId: string; revision: number; mid: string; workflowId: string; workflowVersion: string };
    error?: string;
  } {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "sfa_v1") {
      return { valid: false, error: "Malformed sfield signed action token." };
    }
    const [, encoded, sig] = parts;
    const expected = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    const sigBuf = Buffer.from(sig, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      return { valid: false, error: "Signature mismatch — forged or tampered action token rejected by sfield." };
    }
    try {
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
        decisionId: string;
        revision: number;
        mid: string;
        workflowId: string;
        workflowVersion: string;
      };
      return { valid: true, payload };
    } catch {
      return { valid: false, error: "Unreadable token payload." };
    }
  }

  private hashLedger(record: Omit<PznDecisionRecord, "ledgerHash">): string {
    return createHmac("sha256", this.secret)
      .update(
        JSON.stringify({
          decisionId: record.decisionId,
          revision: record.revision,
          mid: record.mid,
          snapshotId: record.snapshotId,
          dataVersions: record.dataVersions,
          ruleOutcomes: record.ruleOutcomes,
          placements: record.placements,
          workflowCount: record.workflowExecutions.length,
          refreshCount: record.refreshEvents.length,
        }),
      )
      .digest("hex")
      .slice(0, 16);
  }

  /** Compile-time schema check: verifies any CCRE rule against the canonical smass Customer 360 model. */
  validateRuleAgainstSmass(rule: Pick<CcreSharedRule, "field" | "op" | "value">): { valid: boolean; error?: string } {
    const fieldSpec = this.customer360Model.fields[rule.field];
    if (!fieldSpec) {
      return { valid: false, error: `Field "${rule.field}" does not exist in smass model customer_360@1.0.0.` };
    }
    if (fieldSpec.enumValues && typeof rule.value === "string" && !fieldSpec.enumValues.includes(rule.value)) {
      return {
        valid: false,
        error: `Value "${rule.value}" violates smass enum [${fieldSpec.enumValues.join(", ")}] on customer_360.${rule.field}.`,
      };
    }
    if (fieldSpec.type === "integer" && typeof rule.value !== "number") {
      return { valid: false, error: `Field customer_360.${rule.field} expects an integer value.` };
    }
    return { valid: true };
  }

  updateSharedRule(
    ruleId: string,
    patch: Partial<Pick<CcreSharedRule, "enabled" | "value">>,
  ): { ok: true; rule: CcreSharedRule } | { ok: false; error: string } {
    const rule = this.rules.find((item) => item.ruleId === ruleId);
    if (!rule) return { ok: false, error: `Unknown CCRE rule "${ruleId}".` };
    const candidate = { ...rule, ...patch };
    const check = this.validateRuleAgainstSmass(candidate);
    if (!check.valid) return { ok: false, error: check.error ?? "Rule failed smass schema validation." };
    Object.assign(rule, patch);
    return { ok: true, rule: { ...rule } };
  }

  private async readSmassSnapshot(mid: string): Promise<SmassFactSnapshot> {
    const result = await this.registry.executeStoreRead("customer_360.read@1.0.0", { mid }, this.execCtx(mid));
    if (!result.found || !result.output) {
      throw new Error(`Member "${mid}" not found in smass Data Agg (customer_360).`);
    }
    const facts = result.output as Customer360Record;
    return {
      snapshotId: `snap_${mid}_v${facts.accountVersion}_${facts.balanceVersion}`,
      mid,
      fetchedAt: new Date().toISOString(),
      dataVersions: {
        accountVersion: facts.accountVersion,
        balanceVersion: facts.balanceVersion,
      },
      facts,
    };
  }

  private evaluateCcreRules(context: PznDemoContextId, snapshot: SmassFactSnapshot): CcreRuleOutcome[] {
    const applicable = this.rules.filter((rule) => rule.contexts.includes(context));
    return applicable.map((rule) => {
      const observed = snapshot.facts[rule.field];
      let matched = false;
      if (rule.enabled) {
        if (rule.op === "==" && observed === rule.value) matched = true;
        if (rule.op === ">=" && typeof observed === "number" && typeof rule.value === "number" && observed >= rule.value) {
          matched = true;
        }
      }
      return {
        ruleId: rule.ruleId,
        label: rule.label,
        matched,
        field: rule.field,
        observedValue: observed,
        expected: rule.enabled ? `${rule.op} ${rule.value}` : "DISABLED",
        dataVersionRef:
          rule.field === "availableBalanceCents" || rule.field === "currentBalanceCents" || rule.field === "portfolioCashCents"
            ? snapshot.dataVersions.balanceVersion
            : `accountVersion:${snapshot.dataVersions.accountVersion}`,
      };
    });
  }

  private effectiveScore(contentId: string): { baseScore: number; lift: number; total: number } {
    const stats = this.ranking.get(contentId);
    if (!stats) return { baseScore: 0.7, lift: 0, total: 0.7 };
    const conversionRate = stats.impressions > 0 ? stats.verifiedOutcomes / stats.impressions : 0;
    const lift = Number((conversionRate * 0.15).toFixed(3));
    return { baseScore: stats.baseScore, lift, total: Number((stats.baseScore + lift).toFixed(3)) };
  }

  private recordImpression(contentId: string): void {
    const stats = this.ranking.get(contentId);
    if (stats) stats.impressions += 1;
  }

  async evaluateDecision(input: {
    mid: string;
    context: PznDemoContextId;
    trigger?: string;
  }): Promise<PznDecisionRecord> {
    const trigger = input.trigger ?? "chat_request";
    const now = () => new Date().toISOString();
    const exchanges: PznTraceExchange[] = [];
    const decisionId =
      input.context === "balance" && input.mid === "DEMO-MID-1001"
        ? `dec_alice_balance_${++this.seq}`
        : input.context === "portsum" && input.mid === "DEMO-MID-1001"
          ? `dec_alice_portsum_${++this.seq}`
          : input.context === "address-update" && input.mid === "DEMO-MID-1003"
            ? `dec_marcus_address_${++this.seq}`
            : `dec_${input.mid.toLowerCase()}_${input.context.replace(/[^a-z0-9]+/g, "_")}_${++this.seq}`;

    exchanges.push({
      step: 1,
      stage: "channel_to_ts",
      from: "PZN Channel / sfield Hydrator",
      to: "Treatment Selector (TS)",
      summary: `Evaluate dual placements (primary + nextAction) for ${input.mid} in context "${input.context}"`,
      request: { mid: input.mid, context: input.context, trigger },
      response: { policyMode: "dual_placement", decisionId },
      timestamp: now(),
    });

    // Single versioned read via smass Data Agg (reused by both CCRE & Treatment Resolver)
    const snapshot = await this.readSmassSnapshot(input.mid);
    exchanges.push({
      step: 2,
      stage: "ccre_to_smass_data_agg",
      from: "CCRE → smass Contract",
      to: "Data Agg (Customer 360)",
      summary: `Single schema-validated snapshot read (${snapshot.snapshotId}) — reused later by Treatment Resolver (0 duplicate reads)`,
      request: { toolRef: "customer_360.read@1.0.0", mid: input.mid },
      response: { snapshotId: snapshot.snapshotId, dataVersions: snapshot.dataVersions, facts: snapshot.facts },
      timestamp: now(),
    });

    const ruleOutcomes = this.evaluateCcreRules(input.context, snapshot);
    exchanges.push({
      step: 3,
      stage: "ts_to_ccre",
      from: "Treatment Selector (TS)",
      to: "CCRE Rule Engine",
      summary: `Evaluated ${ruleOutcomes.length} schema-validated shared rule(s) against ${snapshot.snapshotId}`,
      request: { context: input.context, snapshotId: snapshot.snapshotId, ruleIds: ruleOutcomes.map((r) => r.ruleId) },
      response: { ruleOutcomes },
      timestamp: now(),
    });

    const matchedRule = (ruleId: string) => ruleOutcomes.some((r) => r.ruleId === ruleId && r.matched);
    const rankedCandidates: RankedCandidate[] = [];
    let primary: PznPlacement | null = null;
    let nextAction: PznPlacement | null = null;

    if (input.context === "balance" && matchedRule("open_account")) {
      const candidates = ["balance_metric_template", "balance_education"].map((contentId) => {
        const score = this.effectiveScore(contentId);
        return { contentId, placement: "primary" as const, score: score.total, baseScore: score.baseScore, verifiedOutcomeLift: score.lift, selected: false };
      });
      candidates.sort((a, b) => b.score - a.score);
      candidates[0].selected = true;
      rankedCandidates.push(...candidates);
      this.recordImpression(candidates[0].contentId);

      primary = {
        kind: "content",
        id: "balance_metric_template",
        title: "Balance summary",
        summary: `Available $${(snapshot.facts.availableBalanceCents / 100).toLocaleString()} · Current $${(snapshot.facts.currentBalanceCents / 100).toLocaleString()}`,
        card: {
          currency: "USD",
          availableCents: snapshot.facts.availableBalanceCents,
          currentCents: snapshot.facts.currentBalanceCents,
          balanceVersion: snapshot.dataVersions.balanceVersion,
        },
        enrichedFromSnapshotId: snapshot.snapshotId,
      };
    } else if (input.context === "portsum" && matchedRule("open_account")) {
      const balanceScore = this.effectiveScore("balance_metric_template");
      rankedCandidates.push({
        contentId: "balance_metric_template",
        placement: "primary",
        score: balanceScore.total,
        baseScore: balanceScore.baseScore,
        verifiedOutcomeLift: balanceScore.lift,
        selected: true,
      });
      primary = {
        kind: "content",
        id: "portfolio_summary_template",
        title: "Portfolio cash summary",
        summary: `Portfolio cash $${(snapshot.facts.portfolioCashCents / 100).toLocaleString()} at ${snapshot.dataVersions.balanceVersion}`,
        card: {
          currency: "USD",
          portfolioCashCents: snapshot.facts.portfolioCashCents,
          availableCents: snapshot.facts.availableBalanceCents,
          balanceVersion: snapshot.dataVersions.balanceVersion,
        },
        enrichedFromSnapshotId: snapshot.snapshotId,
      };
      if (matchedRule("cash_above_10k")) {
        const investScore = this.effectiveScore("explore_investing_options");
        rankedCandidates.push({
          contentId: "explore_investing_options",
          placement: "nextAction",
          score: investScore.total,
          baseScore: investScore.baseScore,
          verifiedOutcomeLift: investScore.lift,
          selected: true,
        });
        this.recordImpression("explore_investing_options");
        const workflowId = "portfolio.investing.explore";
        const workflowVersion = "1.0.0";
        nextAction = {
          kind: "workflow",
          id: workflowId,
          version: workflowVersion,
          contentId: "explore_investing_options",
          recommendationId: "cash_above_10k",
          title: "Explore investing options",
          summary: `You hold $${(snapshot.facts.portfolioCashCents / 100).toLocaleString()} in cash (verified at ${snapshot.dataVersions.balanceVersion}).`,
          ctaLabel: "Explore investing options",
          card: {
            portfolioCashCents: snapshot.facts.portfolioCashCents,
            balanceVersion: snapshot.dataVersions.balanceVersion,
          },
          signedActionToken: this.signAction({
            decisionId,
            revision: 1,
            mid: input.mid,
            workflowId,
            workflowVersion,
          }),
          enrichedFromSnapshotId: snapshot.snapshotId,
        };
      }
    } else if (input.context === "address-update") {
      const addrScore = this.effectiveScore("address_update_guide");
      rankedCandidates.push({
        contentId: "address_update_guide",
        placement: "primary",
        score: addrScore.total,
        baseScore: addrScore.baseScore,
        verifiedOutcomeLift: addrScore.lift,
        selected: true,
      });
      primary = {
        kind: "action",
        id: "account.address.prepare",
        version: "1.0.0",
        contentId: "address_update_guide",
        title: "Update your mailing address",
        summary: "Guided address verification & update workflow for your account.",
      };
      if (matchedRule("first_deposit")) {
        const fundScore = this.effectiveScore("fund_account");
        rankedCandidates.push({
          contentId: "fund_account",
          placement: "nextAction",
          score: fundScore.total,
          baseScore: fundScore.baseScore,
          verifiedOutcomeLift: fundScore.lift,
          selected: true,
        });
        this.recordImpression("fund_account");
        const workflowId = "account.funding.preview";
        const workflowVersion = "1.0.0";
        nextAction = {
          kind: "workflow",
          id: workflowId,
          version: workflowVersion,
          contentId: "fund_account",
          recommendationId: "first_deposit",
          title: "Fund your account",
          summary: "Your account is currently unfunded. Preview a $250 bank transfer in one click.",
          ctaLabel: "Preview funding",
          signedActionToken: this.signAction({
            decisionId,
            revision: 1,
            mid: input.mid,
            workflowId,
            workflowVersion,
          }),
          enrichedFromSnapshotId: snapshot.snapshotId,
        };
      }
    } else if (input.context === "pending-actions") {
      if (matchedRule("first_deposit")) {
        const fundScore = this.effectiveScore("fund_account");
        rankedCandidates.push({
          contentId: "fund_account",
          placement: "nextAction",
          score: fundScore.total,
          baseScore: fundScore.baseScore,
          verifiedOutcomeLift: fundScore.lift,
          selected: true,
        });
        this.recordImpression("fund_account");
        const workflowId = "account.funding.preview";
        const workflowVersion = "1.0.0";
        nextAction = {
          kind: "workflow",
          id: workflowId,
          version: workflowVersion,
          contentId: "fund_account",
          recommendationId: "first_deposit",
          title: "Fund your account",
          summary: "Driven by the exact same shared first_deposit rule as Address Update.",
          ctaLabel: "Preview funding",
          signedActionToken: this.signAction({
            decisionId,
            revision: 1,
            mid: input.mid,
            workflowId,
            workflowVersion,
          }),
          enrichedFromSnapshotId: snapshot.snapshotId,
        };
      }
    }

    exchanges.push({
      step: 4,
      stage: "ts_to_ranking",
      from: "Treatment Selector (TS)",
      to: "Ranking Model (Outcome-Trained)",
      summary: `Ranked ${rankedCandidates.length} eligible candidate(s) using base score + sfield verified-outcome lift`,
      request: { context: input.context, candidates: rankedCandidates.map((c) => c.contentId) },
      response: { rankedCandidates },
      timestamp: now(),
    });

    exchanges.push({
      step: 5,
      stage: "ts_to_resolver",
      from: "Treatment Selector (TS)",
      to: "Treatment Resolver (smass Binder + sfield Sealer)",
      summary: `Bound card values from cached ${snapshot.snapshotId} (0 extra Data Agg calls) & sealed workflow tokens`,
      request: { snapshotId: snapshot.snapshotId, reuseCachedSnapshot: true },
      response: {
        dataAggCallsUsedByResolver: 0,
        placements: {
          primary: primary?.id ?? null,
          nextAction: nextAction?.id ?? null,
          signedWorkflowBound: nextAction?.kind === "workflow",
        },
      },
      timestamp: now(),
    });

    const createdAt = now();
    const baseRecord: Omit<PznDecisionRecord, "ledgerHash"> = {
      decisionId,
      revision: 1,
      mid: input.mid,
      displayName: snapshot.facts.displayName,
      context: input.context,
      trigger,
      createdAt,
      updatedAt: createdAt,
      snapshotId: snapshot.snapshotId,
      dataVersions: snapshot.dataVersions,
      dataAggCalls: 1,
      snapshotReusedByResolver: true,
      ruleOutcomes,
      rankedCandidates,
      placements: { primary, nextAction },
      workflowExecutions: [],
      refreshEvents: [],
      exchanges,
    };
    const record: PznDecisionRecord = { ...baseRecord, ledgerHash: this.hashLedger(baseRecord) };
    this.decisions.set(decisionId, record);
    this.decisionOrder = [decisionId, ...this.decisionOrder.filter((id) => id !== decisionId)].slice(0, 20);
    return record;
  }

  async executeSignedAction(input: {
    decisionId: string;
    mid: string;
    signedActionToken: string;
  }): Promise<{ ok: true; decision: PznDecisionRecord; execution: PznWorkflowExecutionRecord } | { ok: false; status: number; error: string }> {
    const verified = this.verifyActionToken(input.signedActionToken);
    if (!verified.valid || !verified.payload) {
      return { ok: false, status: 403, error: verified.error ?? "Invalid action signature." };
    }
    if (verified.payload.decisionId !== input.decisionId || verified.payload.mid !== input.mid) {
      return {
        ok: false,
        status: 403,
        error: "Action token binding mismatch — token belongs to a different decisionId or MID.",
      };
    }
    const decision = this.decisions.get(input.decisionId);
    if (!decision) {
      return { ok: false, status: 404, error: `Decision "${input.decisionId}" not found in ledger.` };
    }
    if (decision.placements.nextAction?.kind !== "workflow") {
      return { ok: false, status: 409, error: "This decision no longer has an active workflow nextAction (already cleared)." };
    }

    const turnRef = `turn_funding_${String(decision.workflowExecutions.length + 1).padStart(2, "0")}`;
    const now = () => new Date().toISOString();
    const snapshot = await this.readSmassSnapshot(input.mid);

    const steps: PznWorkflowStepResult[] = [
      {
        step: 1,
        toolRef: "funding.status.read@1.0.0",
        label: "Check funding status",
        turnRef,
        request: { turnRef, mid: input.mid },
        response: {
          accountFundingStatus: snapshot.facts.fundingStatus,
          accountVersion: snapshot.facts.accountVersion,
          proceed: snapshot.facts.fundingStatus === "unfunded",
        },
      },
      {
        step: 2,
        toolRef: "funding.options.read@1.0.0",
        label: "Read funding options",
        turnRef,
        request: { turnRef, mid: input.mid },
        response: {
          methodId: "bank_transfer",
          methodLabel: "Linked bank transfer (ACH)",
          amountCents: 25_000,
          currency: "USD",
        },
      },
      {
        step: 3,
        toolRef: "funding.preview.build@1.0.0",
        label: "Build funding preview",
        turnRef,
        request: { turnRef, methodId: "bank_transfer", amountCents: 25_000 },
        response: {
          status: "preview",
          method: { methodId: "bank_transfer", label: "Linked bank transfer (ACH)" },
          amountCents: 25_000,
          currency: "USD",
          accountFundingStatus: snapshot.facts.fundingStatus,
        },
      },
    ];

    const execution: PznWorkflowExecutionRecord = {
      workflowId: verified.payload.workflowId,
      workflowVersion: verified.payload.workflowVersion,
      decisionId: decision.decisionId,
      revision: decision.revision,
      mid: input.mid,
      turnRef,
      executedAt: now(),
      signatureVerified: true,
      status: "preview",
      preview: {
        methodId: "bank_transfer",
        methodLabel: "Linked bank transfer (ACH)",
        amountCents: 25_000,
        currency: "USD",
        accountFundingStatus: snapshot.facts.fundingStatus,
      },
      steps,
    };

    const nextStepNum = decision.exchanges.length + 1;
    decision.exchanges.push({
      step: nextStepNum,
      stage: "pzn_to_sfield",
      from: "PZN Channel",
      to: "sfield Workflow Runtime",
      summary: `Verified HMAC token & ran ${execution.workflowId}@${execution.workflowVersion} (${steps.length} deterministic tools)`,
      request: { decisionId: decision.decisionId, workflowId: execution.workflowId, version: execution.workflowVersion, turnRef },
      response: { signatureVerified: true, preview: execution.preview },
      timestamp: now(),
    });

    const stats = this.ranking.get(decision.placements.nextAction.contentId);
    if (stats) stats.clicks += 1;

    decision.workflowExecutions.push(execution);
    decision.updatedAt = now();
    decision.ledgerHash = this.hashLedger(decision);

    return { ok: true, decision, execution };
  }

  async confirmFundingAndRefresh(input: {
    decisionId: string;
    mid: string;
    simulateStaleVersion?: boolean;
  }): Promise<
    | { ok: true; status: "refreshed"; decision: PznDecisionRecord }
    | { ok: true; status: "retry_required"; currentAccountVersion: number; requiredMinAccountVersion: number; message: string }
    | { ok: false; status: number; error: string }
  > {
    const decision = this.decisions.get(input.decisionId);
    if (!decision) return { ok: false, status: 404, error: `Decision "${input.decisionId}" not found.` };
    const member = this.personas.get(input.mid);
    if (!member) return { ok: false, status: 404, error: `Member "${input.mid}" not found.` };

    const targetVersion = Math.max(member.accountVersion + 1, 42);
    if (input.simulateStaleVersion) {
      return {
        ok: true,
        status: "retry_required",
        currentAccountVersion: member.accountVersion,
        requiredMinAccountVersion: targetVersion,
        message: `Data Agg Customer 360 is at accountVersion ${member.accountVersion} (< minAccountVersion ${targetVersion}). TS instructs PZN to retry once replicated.`,
      };
    }

    // Account system confirms deposit and updates Customer 360 in Data Agg
    member.fundingStatus = "funded";
    member.accountVersion = targetVersion;
    member.balanceVersion = `bal_${targetVersion}`;
    member.availableBalanceCents += 25_000;
    member.currentBalanceCents += 25_000;

    const freshSnapshot = await this.readSmassSnapshot(input.mid);
    const ruleOutcomes = this.evaluateCcreRules(decision.context, freshSnapshot);
    const stillUnfunded = ruleOutcomes.some((r) => r.ruleId === "first_deposit" && r.matched);

    const prevNextActionContentId = decision.placements.nextAction?.kind === "workflow" ? decision.placements.nextAction.contentId : undefined;
    const now = new Date().toISOString();
    const eventId = `evt_funded_${targetVersion}`;

    decision.revision += 1;
    decision.snapshotId = freshSnapshot.snapshotId;
    decision.dataVersions = freshSnapshot.dataVersions;
    decision.ruleOutcomes = ruleOutcomes;
    if (!stillUnfunded) {
      decision.placements.nextAction = null;
      if (prevNextActionContentId) {
        const stats = this.ranking.get(prevNextActionContentId);
        if (stats) stats.verifiedOutcomes += 1;
      }
    }
    decision.refreshEvents.push({
      eventId,
      eventType: "funding.confirmed",
      minAccountVersion: targetVersion,
      appliedRevision: decision.revision,
      appliedAt: now,
      clearedNextAction: !stillUnfunded,
    });
    decision.exchanges.push({
      step: decision.exchanges.length + 1,
      stage: "event_refresh",
      from: "Account System → PZN → TS",
      to: "CCRE → smass Data Agg (v" + targetVersion + ")",
      summary: `Event ${eventId} refreshed decision to revision ${decision.revision} (nextAction: ${decision.placements.nextAction ? "retained" : "null — cleared live"})`,
      request: { decisionId: decision.decisionId, eventId, minAccountVersion: targetVersion },
      response: {
        revision: decision.revision,
        accountVersion: freshSnapshot.dataVersions.accountVersion,
        fundingStatus: freshSnapshot.facts.fundingStatus,
        nextAction: decision.placements.nextAction,
        rankingOutcomeRecorded: !stillUnfunded,
      },
      timestamp: now,
    });
    decision.updatedAt = now;
    decision.ledgerHash = this.hashLedger(decision);

    return { ok: true, status: "refreshed", decision };
  }

  getState(): PznDecisionPlaneState {
    const smassGraph = this.registry.toDataModelGraph("pzn_pilot");
    const issues = this.registry.validateAgainstTools(new Map());
    const rankingMetrics: RankingMetricRow[] = [...this.ranking.entries()].map(([contentId, row]) => {
      const score = this.effectiveScore(contentId);
      return {
        contentId,
        label: row.label,
        baseScore: row.baseScore,
        impressions: row.impressions,
        clicks: row.clicks,
        verifiedOutcomes: row.verifiedOutcomes,
        effectiveScore: score.total,
      };
    });
    return {
      smassGraph,
      smassValidationIssues: issues.length,
      personas: [...this.personas.values()].map((p) => ({ ...p })),
      rules: this.rules.map((r) => ({ ...r })),
      rankingMetrics,
      decisions: this.decisionOrder.map((id) => this.decisions.get(id)!).filter(Boolean),
    };
  }

  reset(): PznDecisionPlaneState {
    this.personas = initialPersonas();
    this.rules = initialRules();
    this.ranking = initialRankingStats();
    this.decisions.clear();
    this.decisionOrder = [];
    this.seq = 0;
    return this.getState();
  }
}
