import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  defineStoreBackedModel,
  SmassDomainRegistry,
  type SmassDataModelGraph,
  type SmassExecutionContext,
} from "../../packages/smass";

export type SubjectAreaId = "wealth" | "banking" | "retirement";
export type ChannelSurfaceId = "chat_turn" | "web_dashboard" | "mobile_compact" | "advisor_desktop";
export type UiPlacementClass = "main" | "tasks" | "nba" | "actions" | "chrome";

export type SubjectAreaMeta = {
  id: SubjectAreaId;
  label: string;
  tagline: string;
  accentLabel: string;
  smassModelId: string;
};

export type ChannelBudgetSpec = {
  id: ChannelSurfaceId;
  label: string;
  shortLabel: string;
  description: string;
  maxMain: number;
  maxTasks: number;
  maxNba: number;
  maxCompanionTotal: number; // Combined Task + NBA cap (Task outranks NBA when tight)
  maxFollowUps: number;
  showProvenanceRail: boolean;
  frameMode: "chat" | "web" | "mobile" | "advisor";
};

export type ComposerMemberRecord = {
  mid: string;
  displayName: string;
  subjectArea: SubjectAreaId;
  segment: string;
  accountVersion: number;
  balanceVersion: string;
  primaryMetricLabel: string;
  primaryMetricCents: number;
  secondaryMetricLabel: string;
  secondaryMetricCents: number;
  tertiaryMetricLabel: string;
  tertiaryMetricCents: number;
  taskStatus: "open" | "completed";
  nbaEligible: boolean;
  defaultExperienceId: string;
};

export type ComposerExperienceOption = {
  id: string;
  subjectArea: SubjectAreaId;
  mid: string;
  label: string;
  userPrompt: string;
  mainTitle: string;
  mainSubtitle: string;
  mainKind: "portfolio_summary" | "address_task" | "cashflow_overview" | "retirement_readiness";
  mainHighlights: Array<{ label: string; value: string; tone?: "default" | "positive" | "warn" }>;
  disclosures: string[];
  sources: Array<{ title: string; version: string }>;
  followUps: string[];
  taskCandidate: {
    id: string;
    ruleId: string;
    title: string;
    summary: string;
    urgency: "high" | "medium";
    ctaLabel: string;
    workflowId: string;
    workflowVersion: string;
    eventName: string;
    previewSummary: string;
    previewAmountCents: number;
    toolRefs: [string, string, string];
  };
  nbaCandidate: {
    id: string;
    ruleId: string;
    title: string;
    summary: string;
    score: number;
    estimatedValue: string;
    ctaLabel: string;
    workflowId: string;
    workflowVersion: string;
    previewSummary: string;
    previewAmountCents: number;
    toolRefs: [string, string, string];
  };
};

export type ComposedTaskItem = {
  id: string;
  uiClass: "tasks";
  ruleId: string;
  title: string;
  summary: string;
  urgency: "high" | "medium";
  ctaLabel: string;
  workflowId: string;
  workflowVersion: string;
  eventName: string;
  signedActionToken: string;
  snapshotId: string;
};

export type ComposedNbaItem = {
  id: string;
  uiClass: "nba";
  ruleId: string;
  title: string;
  summary: string;
  score: number;
  estimatedValue: string;
  ctaLabel: string;
  workflowId: string;
  workflowVersion: string;
  signedActionToken: string;
  snapshotId: string;
};

export type ArbitrationEntry = {
  uiClass: UiPlacementClass;
  outcome: "placed" | "suppressed" | "promoted" | "dismissed" | "cleared";
  itemId: string;
  reason: string;
};

export type ComposedActionExecution = {
  workflowId: string;
  workflowVersion: string;
  sourceClass: "tasks" | "nba";
  sourceItemId: string;
  turnRef: string;
  executedAt: string;
  signatureVerified: boolean;
  previewSummary: string;
  previewAmountCents: number;
  steps: Array<{ step: number; toolRef: string; status: "ok"; summary: string }>;
};

export type ComposedExperienceResult = {
  compositionId: string;
  decisionId: string;
  revision: number;
  subjectArea: SubjectAreaId;
  channel: ChannelSurfaceId;
  budget: ChannelBudgetSpec;
  experienceId: string;
  mid: string;
  displayName: string;
  segment: string;
  userPrompt: string;
  snapshotId: string;
  dataVersions: { accountVersion: number; balanceVersion: string };
  dataAggCalls: 1;
  zones: {
    main: {
      uiClass: "main";
      kind: ComposerExperienceOption["mainKind"];
      title: string;
      subtitle: string;
      highlights: Array<{ label: string; value: string; tone?: "default" | "positive" | "warn" }>;
      metrics: Array<{ label: string; cents: number }>;
      snapshotId: string;
    };
    tasks: ComposedTaskItem[];
    nba: ComposedNbaItem[];
    actions: {
      uiClass: "actions";
      availableCount: number;
      activeExecution: ComposedActionExecution | null;
    };
    chrome: {
      uiClass: "chrome";
      followUps: string[];
      disclosures: string[];
      sources: Array<{ title: string; version: string }>;
    };
  };
  suppressed: Array<{ uiClass: "tasks" | "nba"; id: string; title: string; reason: string }>;
  arbitrationLog: ArbitrationEntry[];
  dismissedIds: string[];
  taskCompleted: boolean;
  ledgerHash: string;
};

export type ExperienceComposerBootstrap = {
  subjectAreas: SubjectAreaMeta[];
  channels: ChannelBudgetSpec[];
  experiences: Array<Pick<ComposerExperienceOption, "id" | "subjectArea" | "mid" | "label" | "userPrompt">>;
  members: ComposerMemberRecord[];
  smassGraphs: Record<SubjectAreaId, SmassDataModelGraph>;
};

export const SUBJECT_AREAS: SubjectAreaMeta[] = [
  {
    id: "wealth",
    label: "Wealth Advisory",
    tagline: "Portfolios, uninvested cash, funding obligations & beneficiaries",
    accentLabel: "Wealth · Customer 360",
    smassModelId: "wealth_customer_360",
  },
  {
    id: "banking",
    label: "Banking & Lending",
    tagline: "Checking liquidity, mortgage rate-lock tasks & pre-approved credit",
    accentLabel: "Banking · Account 360",
    smassModelId: "banking_account_360",
  },
  {
    id: "retirement",
    label: "Retirement & Benefits",
    tagline: "401(k) readiness, rollover verification tasks & employer match NBAs",
    accentLabel: "Retirement · Plan 360",
    smassModelId: "retirement_plan_360",
  },
];

export const CHANNEL_BUDGETS: ChannelBudgetSpec[] = [
  {
    id: "chat_turn",
    label: "AI Chat Turn",
    shortLabel: "AI Chat",
    description: "Conversational reply: 1 Main card + max 1 companion (Task outranks NBA) + 3 follow-ups + locked disclosures.",
    maxMain: 1,
    maxTasks: 1,
    maxNba: 1,
    maxCompanionTotal: 1,
    maxFollowUps: 3,
    showProvenanceRail: false,
    frameMode: "chat",
  },
  {
    id: "web_dashboard",
    label: "Web Portal Dashboard",
    shortLabel: "Web Portal",
    description: "Full portal overview: 1 Main hero + Pending Tasks rail + 1 Ranked NBA spotlight + Compliance footer.",
    maxMain: 1,
    maxTasks: 3,
    maxNba: 1,
    maxCompanionTotal: 4,
    maxFollowUps: 4,
    showProvenanceRail: false,
    frameMode: "web",
  },
  {
    id: "mobile_compact",
    label: "Mobile App (Compact)",
    shortLabel: "Mobile App",
    description: "Tight 375px thumb budget: 1 Main compact card + 1 highest-priority pill (Task > NBA) + 1 follow-up.",
    maxMain: 1,
    maxTasks: 1,
    maxNba: 1,
    maxCompanionTotal: 1,
    maxFollowUps: 1,
    showProvenanceRail: false,
    frameMode: "mobile",
  },
  {
    id: "advisor_desktop",
    label: "Advisor Co-Pilot Workstation",
    shortLabel: "Advisor Co-Pilot",
    description: "High-density advisor surface: Main + All Tasks + All Ranked NBAs with scores + live smass/CCRE provenance.",
    maxMain: 1,
    maxTasks: 4,
    maxNba: 3,
    maxCompanionTotal: 7,
    maxFollowUps: 4,
    showProvenanceRail: true,
    frameMode: "advisor",
  },
];

function initialMembers(): Map<string, ComposerMemberRecord> {
  return new Map<string, ComposerMemberRecord>([
    [
      "DEMO-MID-1001",
      {
        mid: "DEMO-MID-1001",
        displayName: "Alice Morgan",
        subjectArea: "wealth",
        segment: "Private Wealth · Active",
        accountVersion: 17,
        balanceVersion: "bal_17",
        primaryMetricLabel: "Total Portfolio",
        primaryMetricCents: 5_000_000,
        secondaryMetricLabel: "Invested Assets",
        secondaryMetricCents: 3_750_000,
        tertiaryMetricLabel: "Uninvested Cash",
        tertiaryMetricCents: 1_250_000,
        taskStatus: "open",
        nbaEligible: true,
        defaultExperienceId: "wealth-portfolio-summary",
      },
    ],
    [
      "DEMO-MID-1003",
      {
        mid: "DEMO-MID-1003",
        displayName: "Marcus Reed",
        subjectArea: "wealth",
        segment: "New Investor · Onboarding",
        accountVersion: 41,
        balanceVersion: "bal_41",
        primaryMetricLabel: "Account Balance",
        primaryMetricCents: 0,
        secondaryMetricLabel: "Funding Target",
        secondaryMetricCents: 25_000,
        tertiaryMetricLabel: "Pending Transfers",
        tertiaryMetricCents: 0,
        taskStatus: "open",
        nbaEligible: true,
        defaultExperienceId: "wealth-address-update",
      },
    ],
    [
      "DEMO-MID-2004",
      {
        mid: "DEMO-MID-2004",
        displayName: "Maya Patel",
        subjectArea: "banking",
        segment: "Premier Checking & Home Lending",
        accountVersion: 28,
        balanceVersion: "chk_28",
        primaryMetricLabel: "Premier Checking",
        primaryMetricCents: 1_840_000,
        secondaryMetricLabel: "Monthly Outflows",
        secondaryMetricCents: 620_000,
        tertiaryMetricLabel: "Available Credit Line",
        tertiaryMetricCents: 7_500_000,
        taskStatus: "open",
        nbaEligible: true,
        defaultExperienceId: "banking-cashflow-summary",
      },
    ],
    [
      "DEMO-MID-3009",
      {
        mid: "DEMO-MID-3009",
        displayName: "David Chen",
        subjectArea: "retirement",
        segment: "Workplace 401(k) · Mid-Career",
        accountVersion: 63,
        balanceVersion: "ret_63",
        primaryMetricLabel: "401(k) Balance",
        primaryMetricCents: 24_200_000,
        secondaryMetricLabel: "YTD Contributions",
        secondaryMetricCents: 1_120_000,
        tertiaryMetricLabel: "Unclaimed Match / Yr",
        tertiaryMetricCents: 360_000,
        taskStatus: "open",
        nbaEligible: true,
        defaultExperienceId: "retirement-readiness",
      },
    ],
  ]);
}

const EXPERIENCES: ComposerExperienceOption[] = [
  {
    id: "wealth-portfolio-summary",
    subjectArea: "wealth",
    mid: "DEMO-MID-1001",
    label: "Alice · Portfolio Summary",
    userPrompt: "Show my portfolio summary and cash position.",
    mainTitle: "Portfolio summary",
    mainSubtitle: "Verified holdings & liquidity snapshot bound from smass Customer 360.",
    mainKind: "portfolio_summary",
    mainHighlights: [
      { label: "Allocation", value: "75% Equities · 25% Cash" },
      { label: "Drift vs. Target", value: "+15% Cash Overweight", tone: "warn" },
      { label: "3-Month Return", value: "+13.3% (+$5,880)", tone: "positive" },
    ],
    disclosures: ["For illustration. Balances verified against smass Customer 360 snapshot."],
    sources: [
      { title: "Customer 360 Portfolio Snapshot", version: "bal_17" },
      { title: "Target Allocation Policy", version: "v2.4" },
    ],
    followUps: ["Compare cash vs. treasury yield", "Simulate investing $10,000", "Review tax-lot gains"],
    taskCandidate: {
      id: "task_beneficiary_missing",
      ruleId: "beneficiary_required",
      title: "Add a primary beneficiary",
      summary: "No beneficiary is currently designated on Alice's taxable brokerage account.",
      urgency: "high",
      ctaLabel: "Review beneficiary steps",
      workflowId: "account.beneficiary.prepare",
      workflowVersion: "1.0.0",
      eventName: "beneficiary.confirmed",
      previewSummary: "Primary beneficiary designation form pre-filled for Alice Morgan (100% primary split).",
      previewAmountCents: 0,
      toolRefs: ["account.beneficiary.read@1.0.0", "compliance.designation.check@1.0.0", "account.beneficiary.preview@1.0.0"],
    },
    nbaCandidate: {
      id: "nba_invest_excess_cash",
      ruleId: "cash_above_10k",
      title: "Put $12,500 idle cash to work",
      summary: "Cash exceeds the $10,000 reserve threshold (verified at bal_17). Explore a low-cost Treasury or Core ETF allocation.",
      score: 0.94,
      estimatedValue: "+$540/yr projected yield",
      ctaLabel: "Preview investing plan",
      workflowId: "portfolio.cash_deploy.preview",
      workflowVersion: "1.0.0",
      previewSummary: "Draft allocation preview: move $10,000 idle cash into Treasury Ladder (4.8% APY) while keeping $2,500 liquid.",
      previewAmountCents: 1_000_000,
      toolRefs: ["portfolio.cash.read@1.0.0", "portfolio.options.rank@1.0.0", "portfolio.cash_deploy.build@1.0.0"],
    },
  },
  {
    id: "wealth-address-update",
    subjectArea: "wealth",
    mid: "DEMO-MID-1003",
    label: "Marcus · Address Update",
    userPrompt: "I need to update my mailing address.",
    mainTitle: "Update your mailing address",
    mainSubtitle: "Guided address verification & compliance update for Marcus Reed.",
    mainKind: "address_task",
    mainHighlights: [
      { label: "Current Status", value: "Address verified on file" },
      { label: "Delivery Preference", value: "Paperless + Tax Mail" },
      { label: "Estimated Time", value: "~1 minute" },
    ],
    disclosures: ["Address changes require identity verification before tax documents are re-issued."],
    sources: [{ title: "Account Maintenance Policy", version: "v3.1" }],
    followUps: ["Check tax document mailing dates", "Enable paperless statements", "Review security alerts"],
    taskCandidate: {
      id: "task_first_deposit",
      ruleId: "first_deposit",
      title: "Complete your first deposit",
      summary: "Shared CCRE rule (account.fundingStatus == unfunded) — activate your account with a $250 ACH transfer.",
      urgency: "high",
      ctaLabel: "Preview $250 funding",
      workflowId: "account.funding.preview",
      workflowVersion: "1.0.0",
      eventName: "funding.confirmed",
      previewSummary: "$250 Linked Bank Transfer (ACH) preview ready — account activates immediately upon confirmation.",
      previewAmountCents: 25_000,
      toolRefs: ["funding.status.read@1.0.0", "funding.options.read@1.0.0", "funding.preview.build@1.0.0"],
    },
    nbaCandidate: {
      id: "nba_auto_invest_plan",
      ruleId: "recurring_starter",
      title: "Set up a $100/mo auto-invest habit",
      summary: "Members who automate monthly deposits reach their first $5,000 milestone 2.4x faster.",
      score: 0.87,
      estimatedValue: "$1,200/yr automated savings",
      ctaLabel: "Preview recurring plan",
      workflowId: "goal.recurring.preview",
      workflowVersion: "1.0.0",
      previewSummary: "Recurring $100/month draft schedule starting next month — editable or pausable anytime.",
      previewAmountCents: 10_000,
      toolRefs: ["goal.eligibility.read@1.0.0", "goal.schedule.options@1.0.0", "goal.recurring.build@1.0.0"],
    },
  },
  {
    id: "banking-cashflow-summary",
    subjectArea: "banking",
    mid: "DEMO-MID-2004",
    label: "Maya · Cashflow & Mortgage",
    userPrompt: "Show my checking liquidity and upcoming bills.",
    mainTitle: "Premier checking & liquidity overview",
    mainSubtitle: "Real-time checking balance, scheduled outflows, and reserve runway.",
    mainKind: "cashflow_overview",
    mainHighlights: [
      { label: "30-Day Reserve", value: "2.9x Monthly Outflows", tone: "positive" },
      { label: "Auto-Pay Bills", value: "4 Scheduled ($3,410)" },
      { label: "Mortgage Application", value: "Rate Lock Expiring in 48h", tone: "warn" },
    ],
    disclosures: ["FDIC insured up to applicable limits. Balances reflect posted and pending activity."],
    sources: [
      { title: "Core Banking Ledger (smass)", version: "chk_28" },
      { title: "Mortgage Origination Status", version: "v1.9" },
    ],
    followUps: ["Break down recurring bills", "Simulate mortgage monthly payment", "Export 90-day cashflow"],
    taskCandidate: {
      id: "task_rate_lock_esign",
      ruleId: "mortgage_ratelock_expiring",
      title: "Sign mortgage rate-lock disclosure (48h left)",
      summary: "Your 6.125% 30-year fixed lock expires in 48 hours unless e-signed.",
      urgency: "high",
      ctaLabel: "Preview rate-lock e-sign",
      workflowId: "lending.ratelock.preview",
      workflowVersion: "1.0.0",
      eventName: "ratelock.signed",
      previewSummary: "Rate-lock packet ready: 6.125% APR locked for 45 days on $420,000 loan — $0 lock fee.",
      previewAmountCents: 0,
      toolRefs: ["lending.lock.read@1.0.0", "lending.disclosure.verify@1.0.0", "lending.ratelock.build@1.0.0"],
    },
    nbaCandidate: {
      id: "nba_high_yield_sweep",
      ruleId: "checking_surplus_15k",
      title: "Sweep $8,000 surplus to High-Yield Savings",
      summary: "Keep $10,400 buffer in checking and earn 4.35% APY on excess liquidity automatically.",
      score: 0.91,
      estimatedValue: "+$348/yr extra interest",
      ctaLabel: "Preview auto-sweep",
      workflowId: "banking.sweep.preview",
      workflowVersion: "1.0.0",
      previewSummary: "One-time $8,000 sweep to High-Yield Savings (4.35% APY) preserving a $10,400 checking cushion.",
      previewAmountCents: 800_000,
      toolRefs: ["banking.balance.read@1.0.0", "banking.rates.read@1.0.0", "banking.sweep.build@1.0.0"],
    },
  },
  {
    id: "retirement-readiness",
    subjectArea: "retirement",
    mid: "DEMO-MID-3009",
    label: "David · 401(k) Readiness",
    userPrompt: "How is my 401(k) tracking for retirement?",
    mainTitle: "Workplace 401(k) readiness",
    mainSubtitle: "Vested balance, contribution rate, and projected age-65 replacement income.",
    mainKind: "retirement_readiness",
    mainHighlights: [
      { label: "Current Contribution", value: "4% of Salary (Employer matches up to 6%)", tone: "warn" },
      { label: "Projected Age 65", value: "$1.84M (84% Target)", tone: "positive" },
      { label: "Vesting Status", value: "100% Vested" },
    ],
    disclosures: ["Projections are hypothetical illustrations and do not guarantee future investment results."],
    sources: [
      { title: "Workplace Plan Recordkeeper (smass)", version: "ret_63" },
      { title: "Employer Match Schedule", version: "2026-plan" },
    ],
    followUps: ["Model retiring at age 62", "Compare Roth vs. Pre-Tax 401(k)", "Check target-date fund fee"],
    taskCandidate: {
      id: "task_rollover_verify",
      ruleId: "rollover_docs_pending",
      title: "Confirm prior-employer rollover election",
      summary: "A $38,500 rollover check from your previous plan needs fund selection before auto-default.",
      urgency: "high",
      ctaLabel: "Preview rollover election",
      workflowId: "retirement.rollover.preview",
      workflowVersion: "1.0.0",
      eventName: "rollover.confirmed",
      previewSummary: "Rollover election preview: allocate $38,500 into Target Date 2050 Index (0.08% ER).",
      previewAmountCents: 3_850_000,
      toolRefs: ["retirement.rollover.read@1.0.0", "retirement.funds.read@1.0.0", "retirement.rollover.build@1.0.0"],
    },
    nbaCandidate: {
      id: "nba_capture_employer_match",
      ruleId: "employer_match_gap",
      title: "Capture $3,600/yr in free employer match",
      summary: "Increasing your contribution from 4% to 6% unlocks 100% of your company's matching dollars.",
      score: 0.96,
      estimatedValue: "+$3,600/yr employer match",
      ctaLabel: "Preview +2% contribution bump",
      workflowId: "retirement.contribution.preview",
      workflowVersion: "1.0.0",
      previewSummary: "Payroll preview: +2% pre-tax bump ($150/paycheck) unlocks +$150/paycheck instant employer match.",
      previewAmountCents: 360_000,
      toolRefs: ["retirement.payroll.read@1.0.0", "retirement.match.calc@1.0.0", "retirement.contribution.build@1.0.0"],
    },
  },
];

export class ExperienceComposerEngine {
  private readonly secret: Buffer;
  private members = initialMembers();
  private dismissedByMid = new Map<string, Set<string>>();
  private executionsByKey = new Map<string, ComposedActionExecution>();
  private revisionsByKey = new Map<string, number>();
  private registries: Record<SubjectAreaId, SmassDomainRegistry>;

  constructor(secretSeed?: string) {
    this.secret = Buffer.from(secretSeed ?? randomBytes(32).toString("hex"), "utf8");
    this.registries = {
      wealth: this.buildRegistry("wealth", "wealth_customer_360", "Wealth Customer 360"),
      banking: this.buildRegistry("banking", "banking_account_360", "Banking Account 360"),
      retirement: this.buildRegistry("retirement", "retirement_plan_360", "Retirement Plan 360"),
    };
  }

  private buildRegistry(subjectArea: SubjectAreaId, modelId: string, label: string): SmassDomainRegistry {
    const model = defineStoreBackedModel<ComposerMemberRecord>({
      id: modelId,
      version: "1.0.0",
      domain: subjectArea,
      label,
      description: `Canonical smass Customer 360 snapshot contract for ${label}.`,
      primaryKey: "mid",
      readInputs: { mid: { type: "string", required: true } },
      classification: "confidential",
      fields: {
        mid: { type: "string", label: "Member ID", primaryKey: true, principalKey: "mid", required: true, classification: "pii" },
        displayName: { type: "string", label: "Member Name", required: true, classification: "pii" },
        subjectArea: { type: "string", label: "Subject Area", required: true, enumValues: ["wealth", "banking", "retirement"] },
        primaryMetricCents: { type: "integer", label: "Primary Metric", format: "currency_cents", required: true },
        secondaryMetricCents: { type: "integer", label: "Secondary Metric", format: "currency_cents", required: true },
        tertiaryMetricCents: { type: "integer", label: "Tertiary Metric", format: "currency_cents", required: true },
        taskStatus: { type: "string", label: "Task Status", required: true, enumValues: ["open", "completed"] },
        accountVersion: { type: "integer", label: "Account Version", required: true },
        balanceVersion: { type: "string", label: "Balance Version", required: true },
      },
      lifecycle: {
        stateField: "taskStatus",
        states: ["open", "completed"],
        transitions: [{ from: "open", to: "completed", actionId: "task.complete", label: "Complete task" }],
      },
      actions: [
        {
          id: "task.complete",
          toolRef: `${subjectArea}.task.complete@1.0.0`,
          label: "Complete task",
          effect: "write",
        },
      ],
      source: {
        read: (inputs) => {
          const row = this.members.get(String(inputs.mid ?? ""));
          return row ? { ...row } : null;
        },
        list: () => [...this.members.values()].filter((m) => m.subjectArea === subjectArea).map((m) => ({ ...m })),
      },
    });
    return new SmassDomainRegistry([model]);
  }

  private signToken(payload: {
    decisionId: string;
    revision: number;
    mid: string;
    workflowId: string;
    workflowVersion: string;
    sourceClass: "tasks" | "nba";
    sourceItemId: string;
  }): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const sig = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    return `sfa_cmp_v1.${encoded}.${sig}`;
  }

  private verifyToken(token: string) {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "sfa_cmp_v1") return { valid: false as const, error: "Malformed sfield composer token." };
    const [, encoded, sig] = parts;
    const expected = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { valid: false as const, error: "HMAC signature mismatch — tampered token rejected by sfield." };
    }
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      decisionId: string;
      revision: number;
      mid: string;
      workflowId: string;
      workflowVersion: string;
      sourceClass: "tasks" | "nba";
      sourceItemId: string;
    };
    return { valid: true as const, payload };
  }

  private keyFor(experienceId: string): string {
    return experienceId;
  }

  getBootstrap(): ExperienceComposerBootstrap {
    return {
      subjectAreas: SUBJECT_AREAS,
      channels: CHANNEL_BUDGETS,
      experiences: EXPERIENCES.map(({ id, subjectArea, mid, label, userPrompt }) => ({
        id,
        subjectArea,
        mid,
        label,
        userPrompt,
      })),
      members: [...this.members.values()].map((m) => ({ ...m })),
      smassGraphs: {
        wealth: this.registries.wealth.toDataModelGraph("wealth"),
        banking: this.registries.banking.toDataModelGraph("banking"),
        retirement: this.registries.retirement.toDataModelGraph("retirement"),
      },
    };
  }

  async compose(input: { experienceId: string; channel: ChannelSurfaceId }): Promise<ComposedExperienceResult> {
    const exp = EXPERIENCES.find((e) => e.id === input.experienceId) ?? EXPERIENCES[0];
    const budget = CHANNEL_BUDGETS.find((c) => c.id === input.channel) ?? CHANNEL_BUDGETS[0];
    const reg = this.registries[exp.subjectArea];
    const readToolRef = `${SUBJECT_AREAS.find((s) => s.id === exp.subjectArea)!.smassModelId}.read@1.0.0`;
    const ctx: SmassExecutionContext = { tenantId: "pzn-composer", domainId: exp.subjectArea, principalId: exp.mid, customerId: exp.mid };
    const snapRead = await reg.executeStoreRead(readToolRef, { mid: exp.mid }, ctx);
    if (!snapRead.found || !snapRead.output) {
      throw new Error(`Member ${exp.mid} not found in smass ${exp.subjectArea} registry.`);
    }
    const member = snapRead.output as ComposerMemberRecord;
    const revision = this.revisionsByKey.get(this.keyFor(exp.id)) ?? 1;
    const decisionId = `dec_${exp.id.replace(/[^a-z0-9]+/g, "_")}`;
    const snapshotId = `snap_${member.mid}_v${member.accountVersion}_${member.balanceVersion}`;
    const dismissed = this.dismissedByMid.get(member.mid) ?? new Set<string>();

    const arbitrationLog: ArbitrationEntry[] = [];
    const suppressed: ComposedExperienceResult["suppressed"] = [];
    const placedTasks: ComposedTaskItem[] = [];
    const placedNba: ComposedNbaItem[] = [];

    // Class 1: Main is ALWAYS placed first and never displaced
    arbitrationLog.push({
      uiClass: "main",
      outcome: "placed",
      itemId: exp.id,
      reason: `Main experience "${exp.mainTitle}" locked at priority #1 from single smass snapshot ${snapshotId}.`,
    });

    // Class 2: Tasks (Pending Obligations) — outrank NBA when companion budget is tight
    let companionUsed = 0;
    if (member.taskStatus === "open") {
      if (companionUsed < budget.maxCompanionTotal && placedTasks.length < budget.maxTasks) {
        const t = exp.taskCandidate;
        placedTasks.push({
          id: t.id,
          uiClass: "tasks",
          ruleId: t.ruleId,
          title: t.title,
          summary: t.summary,
          urgency: t.urgency,
          ctaLabel: t.ctaLabel,
          workflowId: t.workflowId,
          workflowVersion: t.workflowVersion,
          eventName: t.eventName,
          signedActionToken: this.signToken({
            decisionId,
            revision,
            mid: member.mid,
            workflowId: t.workflowId,
            workflowVersion: t.workflowVersion,
            sourceClass: "tasks",
            sourceItemId: t.id,
          }),
          snapshotId,
        });
        companionUsed += 1;
        arbitrationLog.push({
          uiClass: "tasks",
          outcome: "placed",
          itemId: t.id,
          reason: `Shared CCRE rule "${t.ruleId}" matched -> Task "${t.title}" placed (Tasks outrank NBA).`,
        });
      }
    } else {
      arbitrationLog.push({
        uiClass: "tasks",
        outcome: "cleared",
        itemId: exp.taskCandidate.id,
        reason: `Task "${exp.taskCandidate.title}" cleared live at revision ${revision} (accountVersion ${member.accountVersion}).`,
      });
    }

    // Class 3: NBA — placed only if eligible, not dismissed, and within surface companion budget
    const nba = exp.nbaCandidate;
    if (member.nbaEligible) {
      if (dismissed.has(nba.id)) {
        suppressed.push({
          uiClass: "nba",
          id: nba.id,
          title: nba.title,
          reason: "Suppressed across all channels — dismissed by member in sfield memory.",
        });
        arbitrationLog.push({
          uiClass: "nba",
          outcome: "dismissed",
          itemId: nba.id,
          reason: `NBA "${nba.title}" suppressed because member dismissed it (synced across Chat, Web, Mobile & Advisor).`,
        });
      } else if (companionUsed >= budget.maxCompanionTotal || placedNba.length >= budget.maxNba) {
        suppressed.push({
          uiClass: "nba",
          id: nba.id,
          title: nba.title,
          reason: `${budget.shortLabel} budget allows ${budget.maxCompanionTotal} companion slot — Task "${exp.taskCandidate.title}" took priority.`,
        });
        arbitrationLog.push({
          uiClass: "nba",
          outcome: "suppressed",
          itemId: nba.id,
          reason: `NBA "${nba.title}" (score ${nba.score}) held back on ${budget.shortLabel} because open Task consumed the ${budget.maxCompanionTotal}-slot budget.`,
        });
      } else {
        placedNba.push({
          id: nba.id,
          uiClass: "nba",
          ruleId: nba.ruleId,
          title: nba.title,
          summary: nba.summary,
          score: nba.score,
          estimatedValue: nba.estimatedValue,
          ctaLabel: nba.ctaLabel,
          workflowId: nba.workflowId,
          workflowVersion: nba.workflowVersion,
          signedActionToken: this.signToken({
            decisionId,
            revision,
            mid: member.mid,
            workflowId: nba.workflowId,
            workflowVersion: nba.workflowVersion,
            sourceClass: "nba",
            sourceItemId: nba.id,
          }),
          snapshotId,
        });
        companionUsed += 1;
        arbitrationLog.push({
          uiClass: "nba",
          outcome: member.taskStatus === "completed" && budget.maxCompanionTotal === 1 ? "promoted" : "placed",
          itemId: nba.id,
          reason:
            member.taskStatus === "completed" && budget.maxCompanionTotal === 1
              ? `Task cleared at rev ${revision} -> Composer automatically promoted waiting NBA "${nba.title}" (score ${nba.score}) into the freed ${budget.shortLabel} slot!`
              : `PZN Ranking Model placed NBA "${nba.title}" (score ${nba.score}) within ${budget.shortLabel} budget.`,
        });
      }
    }

    // Class 5: Chrome & Compliance — follow-ups capped by channel, disclosures NEVER dropped
    const followUps = exp.followUps.slice(0, budget.maxFollowUps);
    arbitrationLog.push({
      uiClass: "chrome",
      outcome: "placed",
      itemId: "compliance_chrome",
      reason: `Pinned ${exp.disclosures.length} immutable disclosure(s) & ${followUps.length}/${exp.followUps.length} follow-up chip(s) for ${budget.shortLabel}.`,
    });

    const activeExecution = this.executionsByKey.get(this.keyFor(exp.id)) ?? null;
    const ledgerHash = createHmac("sha256", this.secret)
      .update(JSON.stringify({ decisionId, revision, channel: budget.id, snapshotId, tasks: placedTasks.length, nba: placedNba.length }))
      .digest("hex")
      .slice(0, 14);

    return {
      compositionId: `cmp_${exp.id}_${budget.id}_r${revision}`,
      decisionId,
      revision,
      subjectArea: exp.subjectArea,
      channel: budget.id,
      budget,
      experienceId: exp.id,
      mid: member.mid,
      displayName: member.displayName,
      segment: member.segment,
      userPrompt: exp.userPrompt,
      snapshotId,
      dataVersions: { accountVersion: member.accountVersion, balanceVersion: member.balanceVersion },
      dataAggCalls: 1,
      zones: {
        main: {
          uiClass: "main",
          kind: exp.mainKind,
          title: exp.mainTitle,
          subtitle: exp.mainSubtitle,
          highlights: exp.mainHighlights,
          metrics: [
            { label: member.primaryMetricLabel, cents: member.primaryMetricCents },
            { label: member.secondaryMetricLabel, cents: member.secondaryMetricCents },
            { label: member.tertiaryMetricLabel, cents: member.tertiaryMetricCents },
          ],
          snapshotId,
        },
        tasks: placedTasks,
        nba: placedNba,
        actions: {
          uiClass: "actions",
          availableCount: placedTasks.length + placedNba.length,
          activeExecution,
        },
        chrome: {
          uiClass: "chrome",
          followUps,
          disclosures: exp.disclosures,
          sources: exp.sources,
        },
      },
      suppressed,
      arbitrationLog,
      dismissedIds: [...dismissed],
      taskCompleted: member.taskStatus === "completed",
      ledgerHash,
    };
  }

  async executeAction(input: {
    experienceId: string;
    channel: ChannelSurfaceId;
    signedActionToken: string;
  }): Promise<{ ok: true; composed: ComposedExperienceResult; execution: ComposedActionExecution } | { ok: false; status: number; error: string }> {
    const exp = EXPERIENCES.find((e) => e.id === input.experienceId);
    if (!exp) return { ok: false, status: 404, error: `Unknown experience "${input.experienceId}".` };
    const check = this.verifyToken(input.signedActionToken);
    if (!check.valid) return { ok: false, status: 403, error: check.error };
    if (check.payload.mid !== exp.mid) {
      return { ok: false, status: 403, error: "Token MID mismatch — rejected by sfield." };
    }
    const candidate = check.payload.sourceClass === "tasks" ? exp.taskCandidate : exp.nbaCandidate;
    const execution: ComposedActionExecution = {
      workflowId: check.payload.workflowId,
      workflowVersion: check.payload.workflowVersion,
      sourceClass: check.payload.sourceClass,
      sourceItemId: check.payload.sourceItemId,
      turnRef: `turn_${exp.subjectArea}_${Date.now().toString(36).slice(-4)}`,
      executedAt: new Date().toISOString(),
      signatureVerified: true,
      previewSummary: candidate.previewSummary,
      previewAmountCents: candidate.previewAmountCents,
      steps: candidate.toolRefs.map((toolRef, idx) => ({
        step: idx + 1,
        toolRef,
        status: "ok",
        summary: idx === 0 ? "Verified smass Customer 360 eligibility" : idx === 1 ? "Loaded governed options & policy limits" : candidate.previewSummary,
      })),
    };
    this.executionsByKey.set(this.keyFor(exp.id), execution);
    const composed = await this.compose({ experienceId: exp.id, channel: input.channel });
    return { ok: true, composed, execution };
  }

  async completeTaskEvent(input: { experienceId: string; channel: ChannelSurfaceId }): Promise<ComposedExperienceResult> {
    const exp = EXPERIENCES.find((e) => e.id === input.experienceId) ?? EXPERIENCES[0];
    const member = this.members.get(exp.mid);
    if (member && member.taskStatus === "open") {
      member.taskStatus = "completed";
      member.accountVersion += 1;
      const prefix = member.balanceVersion.replace(/\d+$/, "");
      member.balanceVersion = `${prefix}${member.accountVersion}`;
      if (exp.id === "wealth-address-update") {
        member.primaryMetricCents += 25_000;
      }
      const nextRev = (this.revisionsByKey.get(this.keyFor(exp.id)) ?? 1) + 1;
      this.revisionsByKey.set(this.keyFor(exp.id), nextRev);
      this.executionsByKey.delete(this.keyFor(exp.id));
    }
    return this.compose({ experienceId: exp.id, channel: input.channel });
  }

  async dismissNba(input: { experienceId: string; channel: ChannelSurfaceId; nbaId: string }): Promise<ComposedExperienceResult> {
    const exp = EXPERIENCES.find((e) => e.id === input.experienceId) ?? EXPERIENCES[0];
    let set = this.dismissedByMid.get(exp.mid);
    if (!set) {
      set = new Set<string>();
      this.dismissedByMid.set(exp.mid, set);
    }
    set.add(input.nbaId);
    const nextRev = (this.revisionsByKey.get(this.keyFor(exp.id)) ?? 1) + 1;
    this.revisionsByKey.set(this.keyFor(exp.id), nextRev);
    return this.compose({ experienceId: exp.id, channel: input.channel });
  }

  async reset(experienceId = EXPERIENCES[0].id, channel: ChannelSurfaceId = "chat_turn"): Promise<ComposedExperienceResult> {
    this.members = initialMembers();
    this.dismissedByMid.clear();
    this.executionsByKey.clear();
    this.revisionsByKey.clear();
    return this.compose({ experienceId, channel });
  }
}
