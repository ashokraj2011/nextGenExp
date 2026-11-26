import { z } from "zod";
import type { JsonValue } from "@sfield/core";
import type { CapabilityManifest, ComponentKind, InputField, InputValues, OutputKind } from "../contracts/agentic";
import { addressFields, amountCentsMax, capabilityRef, manifestSchema } from "../contracts/agentic";
import type { MetricReading } from "../contracts/domain";
import { metricReadingSchema } from "../contracts/domain";
import { fundingOptionsSchema, fundingPreviewSchema, fundingStatusSchema } from "../contracts/funding-workflow";
import { goalProgressSchema } from "../contracts/goal-progress";
import { portfolioSnapshotSchema } from "../contracts/portfolio";
import type { PortfolioSnapshotProvider } from "../portfolio-snapshot";
import type { GoalProgressProvider } from "../goal-progress";
import { readDemoBalance } from "../experience/content";
import {
  contributionSchema, projectionSchema, requiredContribution, savingsProjection, type InvestingEligibility,
} from "./calculations";

const V1 = "1.0.0";
const toolRef = (id: string, version = V1) => id + "@" + version;
const fundingId = "account.funding.preview";
const portfolioId = "portfolio.summary";
const progressId = "goal.progress";
const simulationId = "goal.savings.simulate";
const contributionId = "goal.savings.required-contribution";
const addressId = "account.address.prepare";
const educationId = "retirement.education";
const beneficiaryId = "beneficiary.review";
const balanceId = "balance.summary";
const fundingVersion = "2.0.0";
const previewRequires = ["fundingStatus", "fundingOptions"] as const satisfies readonly OutputKind[];
const cap = (id: string, version = V1) => capabilityRef({ id, version });

export type CapabilityTool = {
  ref: string; label: string; output: OutputKind; schema: z.ZodTypeAny;
  authorizedBy: string; contexts: string[]; invariant: string;
  requiredFields?: InputField[]; uses?: readonly OutputKind[];
  enabledKey?: "goal" | "portfolio" | "balances" | "fundingStatus" | "fundingOptions" | "fundingPreview";
  invoke: (ctx: BusinessContext) => Promise<JsonValue> | JsonValue;
};

type BusinessContext = {
  mid: string; personaId: string; now: number; signal: AbortSignal;
  fundingStatus: "funded" | "unfunded";
  eligibleContent: string[];
  values: InputValues;
  prior: Partial<Record<OutputKind, unknown>>;
  portfolio: PortfolioSnapshotProvider;
  goals: GoalProgressProvider;
  evaluateHypotheticalCash?: (cashAfterCents: number) => Promise<InvestingEligibility | undefined>;
};

const months: InputField = { id: "months", label: "Months until purchase", type: "integer", required: true, min: 1, max: 120, unit: "months", default: 24 };
const monthly: InputField = { id: "monthlyCents", label: "Monthly contribution", type: "integer", required: true, min: 0, max: 500_000, unit: "cents", presentation: "slider", default: 100_000 };
const transferFromCash: InputField = {
  id: "transferFromCashCents",
  label: "Move from portfolio cash today",
  type: "integer",
  required: false,
  min: 0,
  max: 5_000_000,
  unit: "cents",
  presentation: "slider",
  default: 0,
};
const fundingFields: InputField[] = [
  { id: "amountCents", label: "Funding amount", type: "integer", required: true, min: 1, max: amountCentsMax, unit: "cents", presentation: "amount" },
  { id: "methodId", label: "Funding method", type: "choice", required: true, optionsFrom: "fundingOptions" },
];
const addressInputs: InputField[] = addressFields.map((id, i) => ({
  id, label: ["Street address", "City", "State or region", "ZIP or postal code"][i],
  type: "text", required: true, maxLength: i === 0 ? 120 : 60,
}));
export const addressResultSchema = z.object({ status: z.literal("prepared") }).strict();
export const approvedContentSchema = z.object({ contentId: z.string().min(1) }).strict();

export function availableFundingOptions(includeAccountTransfer: boolean, amountCents = 25_000) {
  return fundingOptionsSchema.parse({
    methods: [
      { methodId: "bank_transfer", label: "Bank transfer", from: "Linked bank account", to: "Investment account" },
      ...(includeAccountTransfer ? [{
        methodId: "account_transfer", label: "Transfer from another account", from: "Cash management account", to: "Investment account",
      }] : []),
    ],
    amountCents, currency: "USD",
  });
}
export function fundingPreviewFrom(options: z.infer<typeof fundingOptionsSchema>, methodId: unknown, amountCents: number) {
  const method = options.methods.find((item) => item.methodId === methodId);
  return fundingPreviewSchema.parse({ method, amountCents, status: "preview", currency: options.currency });
}

export const capabilityTools: readonly CapabilityTool[] = [
  {
    ref: toolRef("goal.progress.read", "2.0.0"), label: "Read goal progress", output: "progress", schema: goalProgressSchema,
    authorizedBy: cap(progressId), contexts: ["goals"], invariant: "goal_progress_verified", enabledKey: "goal",
    async invoke({ goals, mid, signal }) { return goalProgressSchema.parse(await goals.read(mid, signal)); },
  },
  {
    ref: toolRef("portfolio.snapshot.read", "2.0.0"), label: "Read portfolio snapshot", output: "portfolio", schema: portfolioSnapshotSchema,
    authorizedBy: cap(portfolioId), contexts: ["portsum"], invariant: "portfolio_verified", enabledKey: "portfolio",
    async invoke({ portfolio, mid, signal }) { return portfolioSnapshotSchema.parse(await portfolio.read(mid, signal)); },
  },
  {
    ref: toolRef("balance.summary.read"), label: "Read account balances", output: "balances", schema: metricReadingSchema,
    authorizedBy: cap(balanceId), contexts: ["balance"], invariant: "balances_verified", enabledKey: "balances",
    invoke({ personaId, mid, now }) { return readDemoBalance(personaId, mid, now) satisfies MetricReading; },
  },
  {
    ref: toolRef("savings.projection.calculate"), label: "Calculate savings projection", output: "projection", schema: projectionSchema,
    authorizedBy: cap(simulationId), contexts: ["goals"], invariant: "projection_matches_inputs", uses: ["progress"], requiredFields: [months, monthly, transferFromCash],
    async invoke({ prior, values, portfolio, mid, signal, evaluateHypotheticalCash }) {
      const parsedPriorPortfolio = portfolioSnapshotSchema.safeParse(prior.portfolio);
      let portfolioCashBeforeCents = parsedPriorPortfolio.success ? parsedPriorPortfolio.data.cashCents : undefined;
      if (portfolioCashBeforeCents === undefined) {
        try {
          const snap = await portfolio.read(mid, signal);
          const parsedSnap = portfolioSnapshotSchema.safeParse(snap);
          if (parsedSnap.success) portfolioCashBeforeCents = parsedSnap.data.cashCents;
        } catch { /* portfolio read optional */ }
      }
      const rawTransfer = typeof values.transferFromCashCents === "number" ? values.transferFromCashCents : 0;
      const clampedTransfer = portfolioCashBeforeCents !== undefined
        ? Math.max(0, Math.min(rawTransfer, portfolioCashBeforeCents))
        : Math.max(0, rawTransfer);
      const cashAfterCents = portfolioCashBeforeCents !== undefined
        ? Math.max(0, portfolioCashBeforeCents - clampedTransfer)
        : undefined;
      const investingEligibility = cashAfterCents !== undefined && evaluateHypotheticalCash
        ? await evaluateHypotheticalCash(cashAfterCents)
        : undefined;
      return savingsProjection(prior.progress, Number(values.months), Number(values.monthlyCents), {
        transferFromCashCents: clampedTransfer,
        portfolioCashBeforeCents,
        investingEligibility,
      });
    },
  },
  {
    ref: toolRef("savings.contribution.calculate"), label: "Calculate required savings", output: "contribution", schema: contributionSchema,
    authorizedBy: cap(contributionId), contexts: ["goals"], invariant: "contribution_matches_target", uses: ["progress"], requiredFields: [months],
    invoke({ prior, values }) { return requiredContribution(prior.progress, Number(values.months)); },
  },
  {
    ref: toolRef("funding.status.read", fundingVersion), label: "Check funding status", output: "fundingStatus", schema: fundingStatusSchema,
    authorizedBy: cap(fundingId, fundingVersion), contexts: ["next-step", "address-update"], invariant: "account_status_verified",
    enabledKey: "fundingStatus",
    invoke({ fundingStatus }) { return { accountFundingStatus: fundingStatus }; },
  },
  {
    ref: toolRef("funding.options.read", fundingVersion), label: "Read funding methods", output: "fundingOptions", schema: fundingOptionsSchema,
    authorizedBy: cap(fundingId, fundingVersion), contexts: ["next-step", "address-update"], invariant: "funding_method_eligible",
    enabledKey: "fundingOptions", uses: ["fundingStatus"],
    invoke({ values }) { return availableFundingOptions(true, typeof values.amountCents === "number" ? values.amountCents : undefined); },
  },
  {
    ref: toolRef("funding.preview.build", fundingVersion), label: "Build funding preview", output: "fundingPreview", schema: fundingPreviewSchema,
    authorizedBy: cap(fundingId, fundingVersion), contexts: ["next-step", "address-update"], invariant: "preview_matches_customer_input",
    enabledKey: "fundingPreview", uses: previewRequires, requiredFields: fundingFields,
    invoke({ prior, values }) { return fundingPreviewFrom(fundingOptionsSchema.parse(prior.fundingOptions), values.methodId, Number(values.amountCents)); },
  },
  {
    ref: toolRef("address.update.prepare"), label: "Prepare address change", output: "address", schema: addressResultSchema,
    authorizedBy: cap(addressId), contexts: ["address-update"], invariant: "address_fields_valid", requiredFields: addressInputs,
    invoke() { return { status: "prepared" }; },
  },
  ...([
    [educationId, "retirement_learning", "retirement.education.read", "Read approved retirement guidance"],
    [beneficiaryId, "beneficiary_update", "beneficiary.review.read", "Read beneficiary review guidance"],
  ] as const).map(([id, contentId, name, label]): CapabilityTool => ({
    ref: toolRef(name), label, output: "content", schema: approvedContentSchema, authorizedBy: cap(id), contexts: ["learning"],
    invariant: "approved_content_only",
    invoke({ eligibleContent }) {
      if (!eligibleContent.includes(contentId)) throw new Error("CONTENT_NOT_ELIGIBLE");
      return { contentId };
    },
  })),
];

type Builtin = {
  id: string; version?: string; title: string; description: string; goals: string[]; keywords: string[];
  tools: CapabilityTool[]; components: ComponentKind[]; completion: OutputKind; phrases?: string[];
  route?: "simple" | "goal"; inputs?: InputField[]; mode?: "direct" | "ordered" | "agent"; planningCompanions?: string[];
};
function defineCapability({ id, version = V1, title, description, goals, keywords, tools, components, completion, phrases, route = "simple", inputs = [], mode = "direct", planningCompanions }: Builtin) {
  return manifestSchema.parse({
    schemaVersion: "1.0", id, version, title, description, supportedGoals: goals,
    discovery: { contexts: tools[0].contexts, keywords, explicitPhrases: phrases, planningCompanions },
    eligibility: { authority: "treatment-selector", kind: id === fundingId ? "workflow" : "capability", id, version },
    inputs, tools: tools.map(({ ref }) => ref), invariants: tools.map(({ invariant }) => invariant),
    execution: { mode, route, resumable: inputs.length > 0 }, policy: { effect: "read", requiresApproval: false },
    experience: { allowedComponents: components }, completionCriteria: [completion],
  });
}
const toolsFor = (id: string, version?: string) => capabilityTools.filter(({ authorizedBy }) => authorizedBy === cap(id, version));

export const builtinCapabilities = [
  defineCapability({
    id: progressId, title: "Home savings progress", description: "Read the down payment target and savings history for a home purchase.",
    goals: ["track home-buying goal", "see how close I am to buying a house"],
    phrases: ["buy a house", "buy a home", "my savings progress"],
    keywords: ["home purchase", "buy a house", "buy a home", "down payment", "house deposit", "home buying", "savings progress"],
    tools: toolsFor(progressId), components: ["GoalProgress"], completion: "progress",
  }),
  defineCapability({
    id: portfolioId, title: "Portfolio snapshot", description: "Read available portfolio cash and holdings. Include when a larger plan asks about resources or affordability.",
    goals: ["review portfolio", "check how much cash is available to save"],
    phrases: ["portfolio summary", "portfolio cash", "enough cash"],
    keywords: ["portfolio", "holdings", "available cash", "cash on hand", "enough cash"],
    tools: toolsFor(portfolioId), components: ["Portfolio", "Metric"], completion: "portfolio",
  }),
  defineCapability({
    id: balanceId, title: "Account balance summary", description: "Read available and current balances for the selected account.",
    goals: ["view balance summary"], phrases: ["my balances", "balance summary"],
    keywords: ["my balances", "my balance", "account balances", "balance summary"],
    tools: toolsFor(balanceId), components: ["Balances"], completion: "balances",
  }),
  defineCapability({
    id: simulationId, title: "Monthly savings planner", description: "Project down payment savings over time from verified goal progress and a monthly contribution. Add a portfolio snapshot when the customer wants to plan a home purchase.",
    goals: ["explore a savings plan", "simulate monthly savings", "try a different contribution"],
    phrases: ["savings plan", "savings projection", "if i save"],
    keywords: ["savings plan", "monthly savings", "savings projection", "if i save", "save per month", "monthly contribution"],
    tools: toolsFor(simulationId), components: ["Chart", "Form"], completion: "projection", inputs: [monthly, transferFromCash, months], route: "goal", planningCompanions: [cap(portfolioId)],
  }),
  defineCapability({
    id: fundingId, version: fundingVersion, title: "Account funding preview",
    description: "Check funding status and eligible methods, then prepare a review-only deposit preview with the customer's amount and method.",
    goals: ["deposit money", "fund an investment account", "preview a first deposit"],
    phrases: ["want to deposit", "from my linked bank", "fund my account", "make a deposit", "deposit money", "preview funding"],
    keywords: ["make a deposit", "deposit money", "deposit into", "deposit", "fund my account", "fund my investment", "funding", "add money", "linked bank"],
    tools: toolsFor(fundingId, fundingVersion), components: ["FundingOptions", "FundingPreview", "Form"],
    completion: "fundingPreview", inputs: fundingFields, route: "goal", mode: "agent",
  }),
  defineCapability({
    id: addressId, title: "Prepare an address change", description: "Collect a new mailing address for review without saving it to the account.",
    goals: ["update address", "prepare address change"], phrases: ["i moved", "change my address", "update my address", "new mailing address"],
    keywords: ["address", "i moved", "relocated"],
    tools: toolsFor(addressId), components: ["Form", "Summary"], completion: "address", inputs: addressInputs,
  }),
  defineCapability({
    id: educationId, title: "Retirement education", description: "Show approved planning guidance for retirement and related tasks.",
    goals: ["learn about retirement"], phrases: ["retirement planning"], keywords: ["retirement", "retiring", "retire", "leaving work", "retierment"],
    tools: toolsFor(educationId), components: ["Content"], completion: "content",
  }),
  defineCapability({
    id: beneficiaryId, title: "Review beneficiary details", description: "Show beneficiary review guidance when Treatment Selector identifies a missing designation during a retirement request.",
    goals: ["review beneficiaries"], phrases: ["review my beneficiary", "my beneficiary details"], keywords: ["beneficiary", "beneficiaries", "retirement"],
    tools: toolsFor(beneficiaryId), components: ["Content"], completion: "content",
  }),
  defineCapability({
    id: contributionId, title: "Required monthly savings", description: "Calculate the monthly contribution needed to reach a verified home savings target within a specified number of months.",
    goals: ["how much to save each month to reach target"],
    phrases: ["how much do i need to save", "how much should i save each month", "required monthly savings"],
    keywords: ["how much do i need to save", "how much should i save each month", "required monthly savings", "reach my house deposit target"],
    tools: toolsFor(contributionId), components: ["Metric", "Form"], completion: "contribution", inputs: [months], route: "goal",
  }),
];
