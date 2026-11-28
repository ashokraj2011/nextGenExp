import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import rawBalanceReads from "../../fixtures/demo-balance-reads.json";
import rawGoalProgress from "../../fixtures/demo-goal-progress.json";
import rawPortfolioHistory from "../../fixtures/demo-portfolio-history.json";
import rawPortfolioSnapshots from "../../fixtures/demo-portfolio-snapshots.json";
import {
  storedCustomerProfileSchema,
  type Customer360ProfileInput,
  type StoredCustomerProfile,
} from "../contracts/customer-360";
import { metricValueSchema } from "../contracts/domain";
type MetricValue = z.infer<typeof metricValueSchema>;
import type { GoalProgress } from "../contracts/goal-progress";
import type { PortfolioHistoryPoint, PortfolioSnapshot } from "../contracts/portfolio";
import {
  builtInCustomerProfileById as builtInById,
  builtInCustomerProfiles as builtInProfiles,
  findProfileById,
  findProfileByMid,
  listAllProfiles,
  registerCustomerProfileLookup,
} from "./registry";

export { findProfileById, findProfileByMid, listAllProfiles };

export type PersonaRecord = {
  personaId: string;
  displayName: string;
  syntheticMid: string;
  beneficiaryStatus: "missing" | "on_file";
  accountFundingStatus: "funded" | "unfunded";
  allowedScenarios: string[];
  segment?: string;
  notes?: string;
};

function formatBalanceDollars(cents: number): string {
  return (Math.max(0, cents) / 100).toFixed(2);
}

const builtInHistoryMap = rawPortfolioHistory as Record<string, PortfolioHistoryPoint[]>;
const builtInGoalMap = new Map(rawGoalProgress.goals.map((g) => [g.mid, g]));
const snapshotDate = rawPortfolioSnapshots.asOf.slice(0, 10);

function synthesizePortfolioHistory(totalCents: number): PortfolioHistoryPoint[] {
  const dates = ["2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30", "2026-10-31"];
  if (totalCents <= 0) {
    return [
      { date: "2026-10-31", totalCents: 0 },
      { date: snapshotDate, totalCents: 0 },
    ];
  }
  const factors = [0.84, 0.88, 0.91, 0.95, 0.98];
  return [
    ...dates.map((date, idx) => ({ date, totalCents: Math.round(totalCents * factors[idx]) })),
    { date: snapshotDate, totalCents },
  ];
}

function synthesizeGoalHistory(savedCents: number): { month: string; savedCents: number }[] {
  const months = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"];
  if (savedCents <= 0) {
    return [
      { month: "2026-10", savedCents: 0 },
      { month: "2026-11", savedCents: 0 },
    ];
  }
  const factors = [0.32, 0.44, 0.56, 0.70, 0.85, 1];
  return months.map((month, idx) => ({ month, savedCents: Math.round(savedCents * factors[idx]) }));
}

const persistedSchema = z.object({
  profiles: z.array(storedCustomerProfileSchema),
}).strict();

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "customer";
  return `custom-${base}-${randomBytes(2).toString("hex")}`;
}

export class CustomerProfileStore {
  private readonly filePath: string;
  private overrides: Map<string, StoredCustomerProfile> | null = null;

  constructor(dataDir: string) {
    this.filePath = resolve(dataDir, "customer-profiles.json");
  }

  private loadOverrides(): Map<string, StoredCustomerProfile> {
    if (this.overrides) return this.overrides;
    if (!existsSync(this.filePath)) {
      this.overrides = new Map();
      return this.overrides;
    }
    try {
      const parsed = persistedSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8")));
      // Earlier profile defaults embedded a funding status that can now change at the account portal.
      const onboarding = parsed.profiles.find((profile) => profile.personaId === "demo-new-account");
      const defaults = builtInById.get("demo-new-account");
      if (onboarding && defaults) {
        if (onboarding.segment === "New Onboarding · Unfunded") onboarding.segment = defaults.segment;
        if (onboarding.notes === "Recently opened account awaiting initial funding deposit.") onboarding.notes = defaults.notes;
      }
      this.overrides = new Map(parsed.profiles.map((p) => [p.personaId, p]));
      return this.overrides;
    } catch {
      this.overrides = new Map();
      return this.overrides;
    }
  }

  private persist(map: Map<string, StoredCustomerProfile>) {
    this.overrides = map;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify({ profiles: [...map.values()] }, null, 2), "utf8");
  }

  list(): StoredCustomerProfile[] {
    const map = this.loadOverrides();
    const merged: StoredCustomerProfile[] = builtInProfiles.map((base) => map.get(base.personaId) ?? base);
    for (const custom of map.values()) {
      if (!builtInById.has(custom.personaId)) merged.push(custom);
    }
    return merged;
  }

  isBuiltIn(personaId: string): boolean {
    return builtInById.has(personaId);
  }

  isCustomized(personaId: string): boolean {
    return this.loadOverrides().has(personaId);
  }

  findByPersonaId(personaId: string): StoredCustomerProfile | undefined {
    const map = this.loadOverrides();
    return map.get(personaId) ?? builtInById.get(personaId);
  }

  findByMid(mid: string): StoredCustomerProfile | undefined {
    return this.list().find((p) => p.syntheticMid === mid);
  }

  upsert(input: Customer360ProfileInput, now = Date.now()): StoredCustomerProfile {
    const map = new Map(this.loadOverrides());
    const existing = input.personaId ? (map.get(input.personaId) ?? builtInById.get(input.personaId)) : undefined;
    const personaId = existing?.personaId ?? (input.personaId || slugify(input.displayName));
    const syntheticMid = existing?.syntheticMid ?? `CUSTOM-MID-${Math.floor(2000 + Math.random() * 7999)}`;
    const allowedScenarios = existing?.allowedScenarios ?? ["normal"];
    const record: StoredCustomerProfile = {
      ...input,
      personaId,
      syntheticMid,
      allowedScenarios,
      updatedAt: new Date(now).toISOString(),
    };
    map.set(personaId, record);
    this.persist(map);
    return record;
  }

  removeOrReset(personaId: string): { deleted: boolean; reset: boolean } {
    const map = new Map(this.loadOverrides());
    if (!map.has(personaId)) {
      return { deleted: false, reset: false };
    }
    map.delete(personaId);
    this.persist(map);
    return builtInById.has(personaId) ? { deleted: false, reset: true } : { deleted: true, reset: false };
  }

  applyBindings(personaId: string, updates: Record<string, string>, now = Date.now()): { updatedFields: string[]; profile?: StoredCustomerProfile } {
    const current = this.findByPersonaId(personaId);
    if (!current) return { updatedFields: [] };
    const next: StoredCustomerProfile = {
      ...current,
      customAttributes: (current.customAttributes ?? []).map((a) => ({ ...a })),
      updatedAt: new Date(now).toISOString(),
    };
    const updatedFields: string[] = [];
    const parseDollarsToCents = (raw: string): number | null => {
      if (!/^\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw)) return null;
      const cents = Math.round(Number(raw.replace(/[$,]/g, "")) * 100);
      return Number.isSafeInteger(cents) && cents <= 1_000_000_000_00 ? cents : null;
    };

    for (const [key, rawVal] of Object.entries(updates)) {
      const value = rawVal.trim();
      if (!value) continue;
      if (key === "customer.displayName") { next.displayName = value.slice(0, 80); updatedFields.push(key); }
      else if (key === "customer.segment") { next.segment = value.slice(0, 80); updatedFields.push(key); }
      else if (key === "customer.beneficiaryStatus") {
        const lower = value.toLowerCase();
        if (!["on_file", "on file", "true", "yes", "missing", "false", "no"].includes(lower)) continue;
        next.beneficiaryStatus = ["on_file", "on file", "true", "yes"].includes(lower) ? "on_file" : "missing";
        updatedFields.push(key);
      } else if (key === "customer.fundingStatus") {
        const lower = value.toLowerCase();
        if (!["funded", "true", "yes", "unfunded", "false", "no", "awaiting first deposit"].includes(lower)) continue;
        next.accountFundingStatus = ["funded", "true", "yes"].includes(lower) ? "funded" : "unfunded";
        updatedFields.push(key);
      } else if (key === "balances.available") {
        const cents = parseDollarsToCents(value);
        if (cents !== null) { next.availableBalanceCents = cents; updatedFields.push(key); }
      } else if (key === "balances.current") {
        const cents = parseDollarsToCents(value);
        if (cents !== null) { next.currentBalanceCents = cents; updatedFields.push(key); }
      } else if (key === "portfolio.cash") {
        const cents = parseDollarsToCents(value);
        if (cents !== null) { next.cashCents = cents; updatedFields.push(key); }
      } else if (key === "portfolio.equities") {
        const cents = parseDollarsToCents(value);
        if (cents !== null) { next.equityCents = cents; updatedFields.push(key); }
      } else if (key === "portfolio.fixedIncome") {
        const cents = parseDollarsToCents(value);
        if (cents !== null) { next.fixedIncomeCents = cents; updatedFields.push(key); }
      } else if (key === "goal.target") {
        const cents = parseDollarsToCents(value);
        if (cents !== null && cents > 0) { next.homeGoalTargetCents = cents; updatedFields.push(key); }
      } else if (key === "goal.saved") {
        const cents = parseDollarsToCents(value);
        if (cents !== null) { next.homeGoalSavedCents = cents; updatedFields.push(key); }
      } else if (key.startsWith("custom.")) {
        const attrKey = key.slice(7);
        if (!/^[a-z][a-z0-9_]{0,47}$/.test(attrKey)) continue;
        const list = next.customAttributes ?? [];
        const existing = list.find((a) => a.key === attrKey);
        if (existing) {
          existing.value = value.slice(0, 160);
        } else if (list.length < 20) {
          list.push({
            key: attrKey,
            label: attrKey.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
            type: "text",
            value: value.slice(0, 160),
          });
        } else continue;
        next.customAttributes = list;
        updatedFields.push(key);
      }
    }

    if (updatedFields.length !== Object.keys(updates).length) return { updatedFields: [] };
    if (updatedFields.length > 0) {
      const map = new Map(this.loadOverrides());
      map.set(personaId, next);
      this.persist(map);
    }
    return { updatedFields, profile: next };
  }

  /**
   * Appends a concise life-event or relationship note into Customer 360 `notes` (deduplicated, capped at 560 chars).
   */
  appendNote(personaId: string, note: string): { added: boolean; notes: string } {
    const clean = note.trim().replace(/\s+/g, " ").slice(0, 220);
    const current = this.findByPersonaId(personaId);
    if (!current || !clean) return { added: false, notes: current?.notes ?? "" };
    const existing = (current.notes ?? "").trim();
    const lowerExisting = existing.toLowerCase();
    const lowerClean = clean.toLowerCase();
    // Deduplicate exact match or matching core phrase (first 36 chars)
    if (lowerExisting.includes(lowerClean) || (lowerClean.length >= 24 && lowerExisting.includes(lowerClean.slice(0, 36)))) {
      return { added: false, notes: existing };
    }
    const combined = existing ? `${existing} | ${clean}` : clean;
    const bounded = combined.length <= 400 ? combined : `${combined.slice(0, 397)}...`;
    const next: StoredCustomerProfile = { ...current, notes: bounded };
    const map = new Map(this.loadOverrides());
    map.set(personaId, next);
    this.persist(map);
    return { added: true, notes: bounded };
  }

  portfolioSnapshot(mid: string): PortfolioSnapshot | null {
    const profile = this.findByMid(mid);
    if (!profile) return null;
    const ledgerEquity = activeEquityLedger?.equityMarketValueCents(profile.personaId);
    const equityCents = typeof ledgerEquity === "number" ? ledgerEquity : profile.equityCents;
    return {
      fixtureVersion: rawPortfolioSnapshots.fixtureVersion,
      asOf: rawPortfolioSnapshots.asOf,
      currency: "USD",
      cashCents: profile.cashCents,
      equityCents,
      fixedIncomeCents: profile.fixedIncomeCents,
    };
  }

  portfolioHistory(mid: string): PortfolioHistoryPoint[] {
    const profile = this.findByMid(mid);
    if (!profile) return [];
    const ledgerEquity = activeEquityLedger?.equityMarketValueCents(profile.personaId);
    const equityCents = typeof ledgerEquity === "number" ? ledgerEquity : profile.equityCents;
    const totalCents = profile.cashCents + equityCents + profile.fixedIncomeCents;
    if (!this.isCustomized(profile.personaId) && typeof ledgerEquity !== "number" && builtInHistoryMap[mid]) {
      return [...builtInHistoryMap[mid], { date: snapshotDate, totalCents }];
    }
    return synthesizePortfolioHistory(totalCents);
  }

  goalProgress(mid: string): GoalProgress | null {
    const profile = this.findByMid(mid);
    if (!profile || profile.homeGoalTargetCents <= 0) return null;
    if (!this.isCustomized(profile.personaId) && builtInGoalMap.has(mid)) {
      const base = builtInGoalMap.get(mid)!;
      return {
        fixtureVersion: rawGoalProgress.fixtureVersion,
        goalId: "home_down_payment",
        currency: "USD",
        targetCents: base.targetCents,
        monthlyContributionCents: rawGoalProgress.monthlyContributionCents,
        history: base.history,
      };
    }
    return {
      fixtureVersion: rawGoalProgress.fixtureVersion,
      goalId: "home_down_payment",
      currency: "USD",
      targetCents: profile.homeGoalTargetCents,
      monthlyContributionCents: rawGoalProgress.monthlyContributionCents,
      history: synthesizeGoalHistory(profile.homeGoalSavedCents),
    };
  }

  balanceReading(personaId: string, syntheticMid: string, now: number): {
    fixtureVersion: string;
    observedAt: string;
    values: MetricValue[];
  } | null {
    const profile = this.findByPersonaId(personaId);
    if (!profile || profile.syntheticMid !== syntheticMid) return null;
    return {
      fixtureVersion: rawBalanceReads.fixtureVersion,
      observedAt: new Date(now).toISOString(),
      values: [
        { metricKey: "available", displayValue: formatBalanceDollars(profile.availableBalanceCents), unit: "DEMO_UNITS" },
        { metricKey: "current", displayValue: formatBalanceDollars(profile.currentBalanceCents), unit: "DEMO_UNITS" },
      ],
    };
  }
}

export interface EquityLedgerLookup {
  equityMarketValueCents(personaId: string): number | null;
}

let activeStore: CustomerProfileStore | null = null;
let activeEquityLedger: EquityLedgerLookup | null = null;

export function setActiveCustomerProfileStore(store: CustomerProfileStore | null) {
  activeStore = store;
  registerCustomerProfileLookup(store);
}

export function getActiveCustomerProfileStore(): CustomerProfileStore | null {
  return activeStore;
}

export function setActiveEquityLedger(ledger: EquityLedgerLookup | null) {
  activeEquityLedger = ledger;
}

export function getActiveEquityLedger(): EquityLedgerLookup | null {
  return activeEquityLedger;
}

export function toPersonaRecord(profile: StoredCustomerProfile): PersonaRecord {
  return {
    personaId: profile.personaId,
    displayName: profile.displayName,
    syntheticMid: profile.syntheticMid,
    beneficiaryStatus: profile.beneficiaryStatus,
    accountFundingStatus: profile.accountFundingStatus,
    allowedScenarios: profile.allowedScenarios,
    segment: profile.segment,
    notes: profile.notes,
  };
}
