import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import goalFixture from "../../fixtures/demo-goal-progress.json";
import { findProfileById } from "../../packages/customer-profiles";

export type GoalCategory = "home" | "retirement" | "education" | "emergency" | "travel" | "custom";

export interface CustomerGoalRecord {
  id: string;
  personaId: string;
  name: string;
  category: GoalCategory;
  targetCents: number;
  savedCents: number;
  monthlyContributionCents: number;
  targetDate: string;
  createdAt: number;
  updatedAt: number;
  builtIn?: boolean;
  sfieldRunId?: string;
}

export interface CreateGoalInput {
  personaId: string;
  name: string;
  category: GoalCategory;
  targetCents: number;
  savedCents?: number;
  monthlyContributionCents?: number;
  targetDate?: string;
  sfieldRunId?: string;
}

export interface UpdateGoalInput {
  name?: string;
  targetCents?: number;
  savedCents?: number;
  monthlyContributionCents?: number;
  targetDate?: string;
}

const VALID_CATEGORIES = new Set<GoalCategory>(["home", "retirement", "education", "emergency", "travel", "custom"]);

function defaultTargetDate(yearsAhead = 3): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + yearsAhead);
  return d.toISOString().slice(0, 10);
}

export class CustomerGoalStore {
  private readonly filePath: string;
  private cache: CustomerGoalRecord[] | null = null;

  constructor(dataDir: string) {
    this.filePath = resolve(dataDir, "customer-goals.json");
  }

  private load(): CustomerGoalRecord[] {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = [];
      return this.cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      this.cache = Array.isArray(parsed) ? parsed as CustomerGoalRecord[] : [];
      return this.cache;
    } catch {
      this.cache = [];
      return this.cache;
    }
  }

  private persist(rows: CustomerGoalRecord[]) {
    this.cache = rows;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(rows, null, 2), "utf8");
  }

  list(personaId: string): CustomerGoalRecord[] {
    const custom = this.load().filter((g) => g.personaId === personaId);
    const profile = findProfileById(personaId);
    const builtIn: CustomerGoalRecord[] = [];
    if (profile && profile.homeGoalTargetCents > 0) {
      builtIn.push({
        id: `builtin-home-${personaId}`,
        personaId,
        name: "Home Down Payment",
        category: "home",
        targetCents: profile.homeGoalTargetCents,
        savedCents: profile.homeGoalSavedCents,
        monthlyContributionCents: goalFixture.monthlyContributionCents,
        targetDate: "2028-06-01",
        createdAt: 0,
        updatedAt: 0,
        builtIn: true,
      });
    }
    return [...builtIn, ...custom.sort((a, b) => b.updatedAt - a.updatedAt)];
  }

  create(input: CreateGoalInput, now = Date.now()): CustomerGoalRecord {
    const rows = this.load();
    const category: GoalCategory = VALID_CATEGORIES.has(input.category) ? input.category : "custom";
    const name = input.name.trim().slice(0, 64);
    if (!name) throw new Error("Enter a goal name.");
    const targetCents = Math.max(10_000, Math.round(input.targetCents));
    const savedCents = Math.max(0, Math.round(input.savedCents ?? 0));
    const monthlyContributionCents = Math.max(0, Math.round(input.monthlyContributionCents ?? 50_000));
    const goal: CustomerGoalRecord = {
      id: `goal_${randomUUID().slice(0, 10)}`,
      personaId: input.personaId,
      name,
      category,
      targetCents,
      savedCents,
      monthlyContributionCents,
      targetDate: input.targetDate?.trim() || defaultTargetDate(3),
      createdAt: now,
      updatedAt: now,
      ...(input.sfieldRunId ? { sfieldRunId: input.sfieldRunId } : {}),
    };
    this.persist([goal, ...rows]);
    return goal;
  }

  update(id: string, personaId: string, patch: UpdateGoalInput, now = Date.now()): CustomerGoalRecord | null {
    const rows = this.load();
    const idx = rows.findIndex((g) => g.id === id && g.personaId === personaId);
    if (idx === -1) return null;
    const prev = rows[idx];
    const next: CustomerGoalRecord = {
      ...prev,
      ...(patch.name?.trim() ? { name: patch.name.trim().slice(0, 64) } : {}),
      ...(typeof patch.targetCents === "number" ? { targetCents: Math.max(10_000, Math.round(patch.targetCents)) } : {}),
      ...(typeof patch.savedCents === "number" ? { savedCents: Math.max(0, Math.round(patch.savedCents)) } : {}),
      ...(typeof patch.monthlyContributionCents === "number" ? { monthlyContributionCents: Math.max(0, Math.round(patch.monthlyContributionCents)) } : {}),
      ...(patch.targetDate?.trim() ? { targetDate: patch.targetDate.trim() } : {}),
      updatedAt: now,
    };
    const updated = [...rows];
    updated[idx] = next;
    this.persist(updated);
    return next;
  }

  delete(id: string, personaId: string): boolean {
    const rows = this.load();
    const next = rows.filter((g) => !(g.id === id && g.personaId === personaId));
    if (next.length === rows.length) return false;
    this.persist(next);
    return true;
  }
}

const goalSetupPattern = /\b(set\s*up|create|add|start|open|make|new|another|manage)\s+(?:a\s+|an\s+|my\s+)?(?:new\s+|another\s+)?(?:financial\s+|savings?\s+|investment\s+|retirement\s+|college\s+|education\s+|emergency\s+|travel\s+|vacation\s+)?goals?\b/i;

export function isGoalSetupPrompt(prompt: string): boolean {
  const clean = prompt.trim();
  if (!clean) return false;
  // Don't hijack "Show my home-buying goal and savings progress" or "buy a house in two years"
  if (/\bhome[- ]buying\s+goal\b/i.test(clean) && !/\b(another|new|add|create|set\s*up)\b/i.test(clean)) return false;
  return goalSetupPattern.test(clean);
}

export function inferSuggestedGoalFromPrompt(prompt: string): {
  suggestedName?: string;
  suggestedCategory?: GoalCategory;
  suggestedTargetUsd?: number;
} {
  if (/\b(emergency|rainy\s*day)\b/i.test(prompt)) {
    return { suggestedName: "Emergency Reserve", suggestedCategory: "emergency", suggestedTargetUsd: 35000 };
  }
  if (/\b(college|education|529|tuition)\b/i.test(prompt)) {
    return { suggestedName: "College 529 Fund", suggestedCategory: "education", suggestedTargetUsd: 80000 };
  }
  if (/\b(retire|retirement|early\s+retire)\b/i.test(prompt)) {
    return { suggestedName: "Early Retirement Fund", suggestedCategory: "retirement", suggestedTargetUsd: 500000 };
  }
  if (/\b(travel|vacation|sabbatical|trip)\b/i.test(prompt)) {
    return { suggestedName: "Sabbatical & Travel Fund", suggestedCategory: "travel", suggestedTargetUsd: 20000 };
  }
  if (/\b(home|house|renovat|remodel)\b/i.test(prompt)) {
    return { suggestedName: "Home Renovation", suggestedCategory: "home", suggestedTargetUsd: 60000 };
  }
  return {};
}
