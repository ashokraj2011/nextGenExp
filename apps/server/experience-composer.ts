import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  defineStoreBackedModel,
  SmassDomainRegistry,
  type SmassDataModelGraph,
  type SmassExecutionContext,
} from "../../packages/smass";
import {
  arbitrateExperienceSurface,
  DEFAULT_SPHOTON_CHANNEL_BUDGETS,
  DEFAULT_SPHOTON_UI_CATALOG,
  resolveExperienceUi,
  type SphotonArbitrationEntry,
  type SphotonChannelBudget,
  type SphotonResolvedUi,
  type SphotonUiComponentEntry,
  type SphotonUiPlacementClass,
  type SphotonUiResolutionMode,
  type SphotonVisualKind,
} from "../../packages/sphoton";

export type SubjectAreaId = string;
export type ChannelSurfaceId = string;
export type UiPlacementClass = SphotonUiPlacementClass;
export type UiResolutionMode = SphotonUiResolutionMode | "runtime_pzn_selected";
export type UiTemplateVisualKind = SphotonVisualKind;
export type UiCatalogEntry = SphotonUiComponentEntry;
export type ChannelBudgetSpec = SphotonChannelBudget;
export type ArbitrationEntry = SphotonArbitrationEntry;

function normalizeResolutionMode(mode?: UiResolutionMode): SphotonUiResolutionMode {
  if (mode === "pinned_widget") return "pinned_widget";
  if (mode === "runtime_sphoton_generative") return "runtime_sphoton_generative";
  return "runtime_tool_selected";
}

export type ExternalWidgetProvider = () => Array<{
  id: string;
  name: string;
  kind: string;
  title: string;
  body: string;
  availableForConsumption?: boolean;
}>;

export type SubjectAreaMeta = {
  id: SubjectAreaId;
  label: string;
  tagline: string;
  accentLabel: string;
  smassModelId: string;
  custom?: boolean;
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
  custom?: boolean;
  uiResolutionMode?: UiResolutionMode;
  attachedUiId?: string;
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
  sourceToolRef: string;
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
  sourceToolRef: string;
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
      uiResolution: SphotonResolvedUi;
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
  experiences: Array<
    Pick<ComposerExperienceOption, "id" | "subjectArea" | "mid" | "label" | "userPrompt" | "custom" | "uiResolutionMode" | "attachedUiId">
  >;
  members: ComposerMemberRecord[];
  uiCatalog: UiCatalogEntry[];
  smassGraphs: Record<string, SmassDataModelGraph>;
};

export const BUILTIN_UI_CATALOG: UiCatalogEntry[] = [...DEFAULT_SPHOTON_UI_CATALOG];

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

export const CHANNEL_BUDGETS: ChannelBudgetSpec[] = [...DEFAULT_SPHOTON_CHANNEL_BUDGETS];

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

type PersistedComposerSnapshot = {
  customSubjectAreas: SubjectAreaMeta[];
  customChannels: ChannelBudgetSpec[];
  customExperiences: ComposerExperienceOption[];
  members: Array<[string, ComposerMemberRecord]>;
  uiBindings: Array<[string, { uiResolutionMode: UiResolutionMode; attachedUiId?: string }]>;
  dismissedByMid: Array<[string, string[]]>;
  revisionsByKey: Array<[string, number]>;
};

export class ExperienceComposerEngine {
  private readonly secret: Buffer;
  private readonly externalWidgets?: ExternalWidgetProvider;
  private readonly db?: DatabaseSync;
  private subjectAreas: SubjectAreaMeta[] = SUBJECT_AREAS.map((s) => ({ ...s }));
  private channels: ChannelBudgetSpec[] = CHANNEL_BUDGETS.map((c) => ({ ...c }));
  private experiences: ComposerExperienceOption[] = EXPERIENCES.map((e) => ({ ...e }));
  private members = initialMembers();
  private dismissedByMid = new Map<string, Set<string>>();
  private executionsByKey = new Map<string, ComposedActionExecution>();
  private revisionsByKey = new Map<string, number>();
  private registries: Record<string, SmassDomainRegistry>;

  constructor(secretSeed?: string, externalWidgets?: ExternalWidgetProvider, dataDir?: string) {
    this.secret = Buffer.from(secretSeed ?? randomBytes(32).toString("hex"), "utf8");
    this.externalWidgets = externalWidgets;
    this.registries = {
      wealth: this.buildRegistry("wealth", "wealth_customer_360", "Wealth Customer 360"),
      banking: this.buildRegistry("banking", "banking_account_360", "Banking Account 360"),
      retirement: this.buildRegistry("retirement", "retirement_plan_360", "Retirement Plan 360"),
    };
    if (dataDir) {
      mkdirSync(dataDir, { recursive: true });
      this.db = new DatabaseSync(join(dataDir, "experience-composer.sqlite"));
      this.db.exec(`CREATE TABLE IF NOT EXISTS composer_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      this.hydrateFromDb();
    }
  }

  close(): void {
    this.db?.close();
  }

  private persistToDb(): void {
    if (!this.db) return;
    const payload: PersistedComposerSnapshot = {
      customSubjectAreas: this.subjectAreas.filter((s) => s.custom),
      customChannels: this.channels.filter((c) => c.custom),
      customExperiences: this.experiences.filter((e) => e.custom),
      members: [...this.members.entries()],
      uiBindings: this.experiences
        .filter((e) => e.uiResolutionMode !== undefined)
        .map((e) => [e.id, { uiResolutionMode: e.uiResolutionMode!, ...(e.attachedUiId ? { attachedUiId: e.attachedUiId } : {}) }]),
      dismissedByMid: [...this.dismissedByMid.entries()].map(([mid, set]) => [mid, [...set]]),
      revisionsByKey: [...this.revisionsByKey.entries()],
    };
    this.db
      .prepare("INSERT INTO composer_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run("snapshot", JSON.stringify(payload));
  }

  private hydrateFromDb(): void {
    if (!this.db) return;
    const row = this.db.prepare("SELECT value FROM composer_state WHERE key = ?").get("snapshot") as { value?: string } | undefined;
    if (!row?.value) return;
    try {
      const saved = JSON.parse(row.value) as Partial<PersistedComposerSnapshot>;
      for (const area of saved.customSubjectAreas ?? []) {
        if (!this.subjectAreas.some((s) => s.id === area.id)) {
          this.subjectAreas.push(area);
          this.registries[area.id] = this.buildRegistry(area.id, area.smassModelId, `${area.label} 360`);
        }
      }
      for (const ch of saved.customChannels ?? []) {
        if (!this.channels.some((c) => c.id === ch.id)) this.channels.push(ch);
      }
      for (const exp of saved.customExperiences ?? []) {
        if (!this.experiences.some((e) => e.id === exp.id)) this.experiences.push(exp);
      }
      for (const [mid, member] of saved.members ?? []) {
        this.members.set(mid, member);
      }
      for (const [expId, binding] of saved.uiBindings ?? []) {
        const exp = this.experiences.find((e) => e.id === expId);
        if (exp) {
          exp.uiResolutionMode = binding.uiResolutionMode;
          exp.attachedUiId = binding.attachedUiId;
        }
      }
      this.dismissedByMid = new Map((saved.dismissedByMid ?? []).map(([mid, ids]) => [mid, new Set(ids)]));
      this.revisionsByKey = new Map(saved.revisionsByKey ?? []);
    } catch {
      // ignore corrupted snapshot and fall back to defaults
    }
  }

  private mapWidgetKindToVisual(kind: string): UiTemplateVisualKind {
    if (kind === "comparison") return "comparison_table";
    if (kind === "goal" || kind === "calculator") return "readiness_gauge";
    if (kind === "checklist") return "action_checklist";
    return "kpi_cards";
  }

  getUiCatalog(): UiCatalogEntry[] {
    const widgetItems: UiCatalogEntry[] = (this.externalWidgets?.() ?? [])
      .filter((w) => w.availableForConsumption !== false)
      .map((w) => ({
        id: w.id,
        name: w.name || w.title,
        source: "widget_studio",
        visualKind: this.mapWidgetKindToVisual(w.kind),
        description: w.body || `Published Widget Studio component (${w.kind}).`,
        badge: "Widget Studio",
      }));
    return [...BUILTIN_UI_CATALOG, ...widgetItems];
  }

  updateUiBinding(input: {
    experienceId: string;
    uiResolutionMode: UiResolutionMode;
    attachedUiId?: string;
  }): ComposerExperienceOption {
    const exp = this.experiences.find((e) => e.id === input.experienceId);
    if (!exp) throw new Error(`Unknown experience "${input.experienceId}".`);
    exp.uiResolutionMode = input.uiResolutionMode;
    exp.attachedUiId = input.uiResolutionMode === "pinned_widget" ? input.attachedUiId : undefined;
    this.persistToDb();
    return exp;
  }

  private slugify(raw: string, fallback: string): string {
    const clean = raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 42);
    return clean || fallback;
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
        subjectArea: { type: "string", label: "Subject Area", required: true },
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
    const smassGraphs: Record<string, SmassDataModelGraph> = {};
    for (const area of this.subjectAreas) {
      const reg = this.registries[area.id];
      if (reg) smassGraphs[area.id] = reg.toDataModelGraph(area.id);
    }
    return {
      subjectAreas: this.subjectAreas.map((s) => ({ ...s })),
      channels: this.channels.map((c) => ({ ...c })),
      experiences: this.experiences.map(({ id, subjectArea, mid, label, userPrompt, custom, uiResolutionMode, attachedUiId }) => ({
        id,
        subjectArea,
        mid,
        label,
        userPrompt,
        custom,
        uiResolutionMode,
        attachedUiId,
      })),
      members: [...this.members.values()].map((m) => ({ ...m })),
      uiCatalog: this.getUiCatalog(),
      smassGraphs,
    };
  }

  createSubjectArea(input: {
    label: string;
    tagline: string;
    smassModelId?: string;
  }): { subjectArea: SubjectAreaMeta; experienceId: string } {
    const baseId = this.slugify(input.label, "custom-domain").replace(/-/g, "_");
    let id = baseId;
    let suffix = 2;
    while (this.subjectAreas.some((s) => s.id === id)) {
      id = `${baseId}_${suffix++}`;
    }
    const smassModelId = input.smassModelId?.trim()
      ? input.smassModelId.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_")
      : `${id}_360`;
    const meta: SubjectAreaMeta = {
      id,
      label: input.label.trim(),
      tagline: input.tagline.trim() || `Governed ${input.label.trim()} experiences powered by smass & sfield`,
      accentLabel: `${input.label.trim()} · Customer 360`,
      smassModelId,
      custom: true,
    };
    this.subjectAreas.push(meta);
    this.registries[id] = this.buildRegistry(id, smassModelId, `${meta.label} 360`);

    // Create a ready-to-run starter experience in this new subject area so switching to it works immediately
    const created = this.createExperience({
      subjectArea: id,
      memberName: "Elena Vance",
      segment: `${meta.label} · Active Member`,
      label: `Elena · ${meta.label} Overview`,
      userPrompt: `Show my ${meta.label.toLowerCase()} summary and open items.`,
      mainTitle: `${meta.label} overview`,
      mainSubtitle: `Live verified snapshot bound from smass model ${smassModelId}@1.0.0.`,
      primaryMetricLabel: "Active Coverage / Value",
      primaryMetricDollars: 120000,
      secondaryMetricLabel: "YTD Activity",
      secondaryMetricDollars: 14500,
      tertiaryMetricLabel: "Available Benefit",
      tertiaryMetricDollars: 4800,
      taskRuleId: `${id}_verification_required`,
      taskTitle: `Verify ${meta.label.toLowerCase()} profile details`,
      taskSummary: `Shared CCRE rule across channels — confirm required ${meta.label.toLowerCase()} documents.`,
      taskCtaLabel: "Preview verification steps",
      taskWorkflowId: `${id}.verify.preview`,
      taskEventName: `${id}.verified`,
      nbaRuleId: `${id}_optimization_opportunity`,
      nbaTitle: `Optimize your ${meta.label.toLowerCase()} plan`,
      nbaSummary: `PZN Ranking Model identified a tailored optimization based on your ${smassModelId} snapshot.`,
      nbaScore: 0.92,
      nbaEstimatedValue: "+$720/yr projected value",
      nbaCtaLabel: "Preview recommendation",
      nbaWorkflowId: `${id}.optimize.preview`,
      followUps: [`Compare ${meta.label.toLowerCase()} tiers`, "Simulate annual savings", "Review policy details"],
      disclosure: `For illustration. Verified against smass ${smassModelId}@1.0.0 snapshot.`,
    });

    return { subjectArea: meta, experienceId: created.id };
  }

  createExperience(input: {
    subjectArea: SubjectAreaId;
    memberName: string;
    segment?: string;
    label: string;
    userPrompt: string;
    mainTitle: string;
    mainSubtitle?: string;
    primaryMetricLabel: string;
    primaryMetricDollars: number;
    secondaryMetricLabel: string;
    secondaryMetricDollars: number;
    tertiaryMetricLabel: string;
    tertiaryMetricDollars: number;
    taskRuleId: string;
    taskTitle: string;
    taskSummary: string;
    taskCtaLabel: string;
    taskWorkflowId: string;
    taskEventName: string;
    nbaRuleId: string;
    nbaTitle: string;
    nbaSummary: string;
    nbaScore: number;
    nbaEstimatedValue: string;
    nbaCtaLabel: string;
    nbaWorkflowId: string;
    followUps: string[];
    disclosure: string;
    uiResolutionMode?: UiResolutionMode;
    attachedUiId?: string;
  }): ComposerExperienceOption {
    const area = this.subjectAreas.find((s) => s.id === input.subjectArea);
    if (!area) throw new Error(`Unknown subject area "${input.subjectArea}".`);
    const baseExpId = `${area.id}-${this.slugify(input.label, "experience")}`;
    let expId = baseExpId;
    let suffix = 2;
    while (this.experiences.some((e) => e.id === expId)) {
      expId = `${baseExpId}-${suffix++}`;
    }
    const midNum = 4000 + this.members.size + 1;
    const mid = `DEMO-MID-${midNum}`;
    const verPrefix = area.id.slice(0, 3);
    const member: ComposerMemberRecord = {
      mid,
      displayName: input.memberName.trim() || "Custom Member",
      subjectArea: area.id,
      segment: input.segment?.trim() || `${area.label} · Custom Experience`,
      accountVersion: 11,
      balanceVersion: `${verPrefix}_11`,
      primaryMetricLabel: input.primaryMetricLabel.trim() || "Primary Value",
      primaryMetricCents: Math.round(input.primaryMetricDollars * 100),
      secondaryMetricLabel: input.secondaryMetricLabel.trim() || "Secondary Value",
      secondaryMetricCents: Math.round(input.secondaryMetricDollars * 100),
      tertiaryMetricLabel: input.tertiaryMetricLabel.trim() || "Opportunity",
      tertiaryMetricCents: Math.round(input.tertiaryMetricDollars * 100),
      taskStatus: "open",
      nbaEligible: true,
      defaultExperienceId: expId,
    };
    this.members.set(mid, member);

    const cleanWorkflow = (raw: string, fallback: string) =>
      raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "") || fallback;
    const taskWf = cleanWorkflow(input.taskWorkflowId, `${area.id}.task.preview`);
    const nbaWf = cleanWorkflow(input.nbaWorkflowId, `${area.id}.nba.preview`);

    const option: ComposerExperienceOption = {
      id: expId,
      subjectArea: area.id,
      mid,
      label: input.label.trim(),
      userPrompt: input.userPrompt.trim() || `Show ${input.mainTitle.trim()}`,
      custom: true,
      uiResolutionMode: input.uiResolutionMode ?? "runtime_pzn_selected",
      attachedUiId: input.uiResolutionMode === "pinned_widget" ? input.attachedUiId : undefined,
      mainTitle: input.mainTitle.trim(),
      mainSubtitle: input.mainSubtitle?.trim() || `Live verified snapshot bound from smass ${area.smassModelId}@1.0.0.`,
      mainKind: "portfolio_summary",
      mainHighlights: [
        { label: "Subject Area", value: area.label, tone: "positive" },
        { label: "smass Model", value: `${area.smassModelId}@1.0.0` },
        { label: "Open Task", value: input.taskRuleId.trim() || "pending_check", tone: "warn" },
      ],
      disclosures: [input.disclosure.trim() || `For illustration. Verified against smass ${area.smassModelId}@1.0.0.`],
      sources: [
        { title: `${area.label} Snapshot (smass)`, version: member.balanceVersion },
        { title: "PZN Shared Policy Catalog", version: "v1.0" },
      ],
      followUps: input.followUps.filter((f) => f.trim().length > 0).slice(0, 4),
      taskCandidate: {
        id: `task_${expId.replace(/[^a-z0-9]+/g, "_")}`,
        ruleId: input.taskRuleId.trim() || `${area.id}_task_rule`,
        title: input.taskTitle.trim(),
        summary: input.taskSummary.trim(),
        urgency: "high",
        ctaLabel: input.taskCtaLabel.trim() || "Preview task",
        workflowId: taskWf,
        workflowVersion: "1.0.0",
        eventName: input.taskEventName.trim() || `${area.id}.task.confirmed`,
        previewSummary: `sfield verified preview ready for "${input.taskTitle.trim()}" (${member.displayName}).`,
        previewAmountCents: Math.max(0, member.tertiaryMetricCents),
        toolRefs: [`${taskWf}.read@1.0.0`, `${taskWf}.options@1.0.0`, `${taskWf}.build@1.0.0`],
      },
      nbaCandidate: {
        id: `nba_${expId.replace(/[^a-z0-9]+/g, "_")}`,
        ruleId: input.nbaRuleId.trim() || `${area.id}_nba_rule`,
        title: input.nbaTitle.trim(),
        summary: input.nbaSummary.trim(),
        score: Math.min(0.99, Math.max(0.5, Number(input.nbaScore) || 0.9)),
        estimatedValue: input.nbaEstimatedValue.trim() || "Personalized value",
        ctaLabel: input.nbaCtaLabel.trim() || "Preview offer",
        workflowId: nbaWf,
        workflowVersion: "1.0.0",
        previewSummary: `sfield verified offer preview ready for "${input.nbaTitle.trim()}" (${input.nbaEstimatedValue.trim() || "governed"}).`,
        previewAmountCents: Math.max(0, member.tertiaryMetricCents),
        toolRefs: [`${nbaWf}.read@1.0.0`, `${nbaWf}.rank@1.0.0`, `${nbaWf}.build@1.0.0`],
      },
    };
    this.experiences.push(option);
    this.persistToDb();
    return option;
  }

  createChannel(input: {
    label: string;
    shortLabel?: string;
    description?: string;
    frameMode: "chat" | "web" | "mobile" | "advisor";
    maxTasks: number;
    maxNba: number;
    maxCompanionTotal: number;
    maxFollowUps: number;
  }): ChannelBudgetSpec {
    const baseId = this.slugify(input.label, "custom-channel").replace(/-/g, "_");
    let id = baseId;
    let suffix = 2;
    while (this.channels.some((c) => c.id === id)) {
      id = `${baseId}_${suffix++}`;
    }
    const spec: ChannelBudgetSpec = {
      id,
      label: input.label.trim(),
      shortLabel: (input.shortLabel?.trim() || input.label.trim()).slice(0, 22),
      description:
        input.description?.trim() ||
        `Custom channel budget: 1 Main + max ${input.maxCompanionTotal} companion (Tasks ${input.maxTasks}, NBA ${input.maxNba}) + ${input.maxFollowUps} follow-ups.`,
      maxMain: 1,
      maxTasks: Math.max(0, Math.min(5, Math.round(input.maxTasks))),
      maxNba: Math.max(0, Math.min(5, Math.round(input.maxNba))),
      maxCompanionTotal: Math.max(0, Math.min(8, Math.round(input.maxCompanionTotal))),
      maxFollowUps: Math.max(0, Math.min(5, Math.round(input.maxFollowUps))),
      showProvenanceRail: input.frameMode === "advisor",
      frameMode: input.frameMode,
      custom: true,
    };
    this.channels.push(spec);
    this.persistToDb();
    return spec;
  }

  async compose(input: { experienceId: string; channel: ChannelSurfaceId }): Promise<ComposedExperienceResult> {
    const exp = this.experiences.find((e) => e.id === input.experienceId) ?? this.experiences[0];
    const budget = this.channels.find((c) => c.id === input.channel) ?? this.channels[0];
    const reg = this.registries[exp.subjectArea];
    const areaMeta = this.subjectAreas.find((s) => s.id === exp.subjectArea)!;
    const readToolRef = `${areaMeta.smassModelId}.read@1.0.0`;
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

    const sourceToolFor = (subject: string, slot: "tasks" | "nba"): string => {
      if (subject === "wealth") return "pzn.treatments.decide@1.0.0";
      if (subject === "banking") return slot === "tasks" ? "lending.obligations.read@1.0.0" : "pzn.treatments.decide@1.0.0";
      if (subject === "retirement") return slot === "tasks" ? "retirement.rollover.check@1.0.0" : "retirement.match.advise@1.0.0";
      return `${subject}.policy.evaluate@1.0.0`;
    };

    const defaultMode: SphotonUiResolutionMode = normalizeResolutionMode(
      exp.uiResolutionMode ?? (exp.id === "wealth-portfolio-summary" ? "pinned_widget" : "runtime_tool_selected"),
    );
    const suggestedUiId =
      exp.mainKind === "portfolio_summary"
        ? "ui_allocation_breakdown@2.0.0"
        : exp.mainKind === "retirement_readiness"
          ? "ui_readiness_gauge@1.0.0"
          : exp.mainKind === "cashflow_overview"
            ? "ui_comparison_matrix@1.0.0"
            : exp.mainKind === "address_task"
              ? "ui_guided_checklist@1.0.0"
              : "ui_kpi_summary@1.0.0";
    const defaultVisualKind: SphotonVisualKind =
      exp.mainKind === "portfolio_summary"
        ? "allocation_bar"
        : exp.mainKind === "retirement_readiness"
          ? "readiness_gauge"
          : exp.mainKind === "cashflow_overview"
            ? "comparison_table"
            : exp.mainKind === "address_task"
              ? "action_checklist"
              : "kpi_cards";

    // Delegate UI resolution cleanly to packages/sphoton
    const uiResolution = resolveExperienceUi({
      mode: defaultMode,
      catalog: this.getUiCatalog(),
      budget,
      snapshotId,
      domainId: exp.subjectArea,
      pinnedUiId: exp.attachedUiId ?? suggestedUiId,
      runtimeSuggestedUiId: suggestedUiId,
      runtimeSelectorToolRef: sourceToolFor(exp.subjectArea, "nba"),
      defaultVisualKind,
    });

    // Build normalized candidate items produced by sfield tools (PZN is simply one sfield tool!)
    const taskCandidates: ComposedTaskItem[] =
      member.taskStatus === "open"
        ? [
            {
              id: exp.taskCandidate.id,
              uiClass: "tasks",
              sourceToolRef: sourceToolFor(exp.subjectArea, "tasks"),
              ruleId: exp.taskCandidate.ruleId,
              title: exp.taskCandidate.title,
              summary: exp.taskCandidate.summary,
              urgency: exp.taskCandidate.urgency,
              ctaLabel: exp.taskCandidate.ctaLabel,
              workflowId: exp.taskCandidate.workflowId,
              workflowVersion: exp.taskCandidate.workflowVersion,
              eventName: exp.taskCandidate.eventName,
              signedActionToken: this.signToken({
                decisionId,
                revision,
                mid: member.mid,
                workflowId: exp.taskCandidate.workflowId,
                workflowVersion: exp.taskCandidate.workflowVersion,
                sourceClass: "tasks",
                sourceItemId: exp.taskCandidate.id,
              }),
              snapshotId,
            },
          ]
        : [];

    const nbaCandidates: ComposedNbaItem[] = member.nbaEligible
      ? [
          {
            id: exp.nbaCandidate.id,
            uiClass: "nba",
            sourceToolRef: sourceToolFor(exp.subjectArea, "nba"),
            ruleId: exp.nbaCandidate.ruleId,
            title: exp.nbaCandidate.title,
            summary: exp.nbaCandidate.summary,
            score: exp.nbaCandidate.score,
            estimatedValue: exp.nbaCandidate.estimatedValue,
            ctaLabel: exp.nbaCandidate.ctaLabel,
            workflowId: exp.nbaCandidate.workflowId,
            workflowVersion: exp.nbaCandidate.workflowVersion,
            signedActionToken: this.signToken({
              decisionId,
              revision,
              mid: member.mid,
              workflowId: exp.nbaCandidate.workflowId,
              workflowVersion: exp.nbaCandidate.workflowVersion,
              sourceClass: "nba",
              sourceItemId: exp.nbaCandidate.id,
            }),
            snapshotId,
          },
        ]
      : [];

    // Delegate 5-Class Experience Policy & Channel Budget Arbitration cleanly to packages/sphoton
    const arbitrated = arbitrateExperienceSurface({
      budget,
      mainItemId: uiResolution.resolvedUiId,
      mainRationale: uiResolution.rationale,
      revision,
      accountVersion: member.accountVersion,
      taskCandidates,
      clearedTasks: member.taskStatus === "completed" ? [{ id: exp.taskCandidate.id, title: exp.taskCandidate.title }] : [],
      nbaCandidates,
      dismissedIds: dismissed,
      followUps: exp.followUps,
      disclosures: exp.disclosures,
    });

    const { placedTasks, placedNba, suppressed, followUps, disclosures, arbitrationLog } = arbitrated;

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
          uiResolution,
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
          disclosures,
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
    const exp = this.experiences.find((e) => e.id === input.experienceId);
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
    const exp = this.experiences.find((e) => e.id === input.experienceId) ?? this.experiences[0];
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
      this.persistToDb();
    }
    return this.compose({ experienceId: exp.id, channel: input.channel });
  }

  async dismissNba(input: { experienceId: string; channel: ChannelSurfaceId; nbaId: string }): Promise<ComposedExperienceResult> {
    const exp = this.experiences.find((e) => e.id === input.experienceId) ?? this.experiences[0];
    let set = this.dismissedByMid.get(exp.mid);
    if (!set) {
      set = new Set<string>();
      this.dismissedByMid.set(exp.mid, set);
    }
    set.add(input.nbaId);
    const nextRev = (this.revisionsByKey.get(this.keyFor(exp.id)) ?? 1) + 1;
    this.revisionsByKey.set(this.keyFor(exp.id), nextRev);
    this.persistToDb();
    return this.compose({ experienceId: exp.id, channel: input.channel });
  }

  async reset(experienceId = EXPERIENCES[0].id, channel: ChannelSurfaceId = "chat_turn"): Promise<ComposedExperienceResult> {
    this.subjectAreas = SUBJECT_AREAS.map((s) => ({ ...s }));
    this.channels = CHANNEL_BUDGETS.map((c) => ({ ...c }));
    this.experiences = EXPERIENCES.map((e) => ({ ...e }));
    this.registries = {
      wealth: this.buildRegistry("wealth", "wealth_customer_360", "Wealth Customer 360"),
      banking: this.buildRegistry("banking", "banking_account_360", "Banking Account 360"),
      retirement: this.buildRegistry("retirement", "retirement_plan_360", "Retirement Plan 360"),
    };
    this.members = initialMembers();
    this.dismissedByMid.clear();
    this.executionsByKey.clear();
    this.revisionsByKey.clear();
    this.db?.prepare("DELETE FROM composer_state WHERE key = ?").run("snapshot");
    const safeExp = this.experiences.some((e) => e.id === experienceId) ? experienceId : this.experiences[0].id;
    const safeChannel = this.channels.some((c) => c.id === channel) ? channel : "chat_turn";
    return this.compose({ experienceId: safeExp, channel: safeChannel });
  }
}
