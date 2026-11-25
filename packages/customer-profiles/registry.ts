import host from "../../fixtures/host.json";
import rawBalanceReads from "../../fixtures/demo-balance-reads.json";
import rawGoalProgress from "../../fixtures/demo-goal-progress.json";
import rawPortfolioSnapshots from "../../fixtures/demo-portfolio-snapshots.json";
import type { CustomAttribute, StoredCustomerProfile } from "../contracts/customer-360";

export type CustomerProfileLookup = {
  list(): StoredCustomerProfile[];
  findByPersonaId(personaId: string): StoredCustomerProfile | undefined;
  findByMid(mid: string): StoredCustomerProfile | undefined;
};

const defaultSegments: Record<string, { segment: string; notes: string; customAttributes: CustomAttribute[] }> = {
  "demo-learner": {
    segment: "Mass Affluent · Accumulator",
    notes: "Holds elevated cash reserve; exploring retirement basics and home down payment goal.",
    customAttributes: [
      { key: "risk_tolerance", label: "Risk tolerance", type: "text", value: "Moderate Growth" },
      { key: "advisor_name", label: "Dedicated advisor", type: "text", value: "Priya Sharma" },
      { key: "retirement_readiness", label: "Retirement readiness", type: "percent", value: "68" },
    ],
  },
  "demo-returning": {
    segment: "Core Investor · Balanced",
    notes: "Established funded portfolio with beneficiaries on file and steady savings momentum.",
    customAttributes: [
      { key: "risk_tolerance", label: "Risk tolerance", type: "text", value: "Balanced" },
      { key: "advisor_name", label: "Dedicated advisor", type: "text", value: "David Chen" },
      { key: "retirement_readiness", label: "Retirement readiness", type: "percent", value: "82" },
    ],
  },
  "demo-new-account": {
    segment: "New Onboarding · Unfunded",
    notes: "Recently opened account awaiting initial funding deposit.",
    customAttributes: [
      { key: "risk_tolerance", label: "Risk tolerance", type: "text", value: "Starter Growth" },
      { key: "advisor_name", label: "Dedicated advisor", type: "text", value: "Onboarding Desk" },
      { key: "retirement_readiness", label: "Retirement readiness", type: "percent", value: "15" },
    ],
  },
};

function parseBalanceCents(displayValue?: string): number {
  const num = Number(displayValue ?? "0");
  return Number.isFinite(num) && num >= 0 ? Math.round(num * 100) : 0;
}

export const builtInCustomerProfiles: StoredCustomerProfile[] = host.personas.map((persona) => {
  const snapshot = rawPortfolioSnapshots.snapshots.find((s) => s.mid === persona.syntheticMid);
  const goal = rawGoalProgress.goals.find((g) => g.mid === persona.syntheticMid);
  const balance = rawBalanceReads.reads.find((r) => r.personaId === persona.personaId && r.syntheticMid === persona.syntheticMid);
  const available = balance?.values.find((v) => v.metricKey === "available")?.displayValue;
  const current = balance?.values.find((v) => v.metricKey === "current")?.displayValue;
  const defaults = defaultSegments[persona.personaId] ?? { segment: "Advisory Client", notes: "", customAttributes: [] };
  return {
    personaId: persona.personaId,
    displayName: persona.displayName,
    syntheticMid: persona.syntheticMid,
    allowedScenarios: [...persona.allowedScenarios],
    segment: defaults.segment,
    notes: defaults.notes,
    accountFundingStatus: persona.accountFundingStatus === "unfunded" ? "unfunded" : "funded",
    beneficiaryStatus: persona.beneficiaryStatus === "missing" ? "missing" : "on_file",
    availableBalanceCents: parseBalanceCents(available),
    currentBalanceCents: parseBalanceCents(current),
    cashCents: snapshot?.cashCents ?? 0,
    equityCents: snapshot?.equityCents ?? 0,
    fixedIncomeCents: snapshot?.fixedIncomeCents ?? 0,
    homeGoalTargetCents: goal?.targetCents ?? 0,
    homeGoalSavedCents: goal?.history.at(-1)?.savedCents ?? 0,
    customAttributes: defaults.customAttributes,
    updatedAt: rawPortfolioSnapshots.asOf,
  };
});

export const builtInCustomerProfileById = new Map(builtInCustomerProfiles.map((p) => [p.personaId, p]));

let activeLookup: CustomerProfileLookup | null = null;

export function registerCustomerProfileLookup(lookup: CustomerProfileLookup | null) {
  activeLookup = lookup;
}

export function listAllProfiles(): StoredCustomerProfile[] {
  return activeLookup ? activeLookup.list() : builtInCustomerProfiles;
}

export function findProfileById(personaId: string): StoredCustomerProfile | undefined {
  return activeLookup ? activeLookup.findByPersonaId(personaId) : builtInCustomerProfileById.get(personaId);
}

export function findProfileByMid(mid: string): StoredCustomerProfile | undefined {
  return activeLookup ? activeLookup.findByMid(mid) : builtInCustomerProfiles.find((p) => p.syntheticMid === mid);
}
