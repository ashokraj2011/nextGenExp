import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CustomerLookupSummary, NextBestActionCard } from "../../packages/contracts/api";
import { formatPortfolioAmount } from "../../packages/contracts/portfolio";
import { findProfileById } from "../../packages/customer-profiles";
import { getEffectiveNbaRules } from "../../packages/experience-registry/registry";

type DismissalMap = Record<string, string[]>;

export class Customer360Service {
  private readonly filePath: string;
  private cache: DismissalMap | null = null;

  constructor(dataDir: string) {
    this.filePath = resolve(dataDir, "nba-dismissals.json");
  }

  private key(principalId: string, personaId: string) {
    return `${principalId}::${personaId}`;
  }

  private load(): DismissalMap {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = {};
      return this.cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as DismissalMap;
      this.cache = parsed && typeof parsed === "object" ? parsed : {};
      return this.cache;
    } catch {
      this.cache = {};
      return this.cache;
    }
  }

  private persist(data: DismissalMap) {
    this.cache = data;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf8");
  }

  dismissedIds(principalId: string, personaId: string): Set<string> {
    const data = this.load();
    return new Set(data[this.key(principalId, personaId)] ?? []);
  }

  totalDismissalCount(): number {
    const data = this.load();
    return Object.values(data).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
  }

  dismiss(principalId: string, personaId: string, nbaId: string): string[] {
    const data = this.load();
    const k = this.key(principalId, personaId);
    const next = [...new Set([...(data[k] ?? []), nbaId])];
    data[k] = next;
    this.persist(data);
    return next;
  }

  resetDismissals(principalId: string, personaId: string): string[] {
    const data = this.load();
    const k = this.key(principalId, personaId);
    if (k in data) {
      delete data[k];
      this.persist(data);
    }
    return [];
  }

  evaluate(input: {
    principalId: string;
    personaId: string;
    fundingStatus: "funded" | "unfunded";
    excludePromotions: boolean;
    existingBlockTitles?: string[];
  }): { lookup: CustomerLookupSummary; nba?: NextBestActionCard } {
    const persona = findProfileById(input.personaId);
    if (!persona) {
      return {
        lookup: { personaName: "Customer", fundingStatus: input.fundingStatus, highlights: [] },
      };
    }

    const totalCents = persona.cashCents + persona.equityCents + persona.fixedIncomeCents;
    const cashCents = persona.cashCents;
    const hasGoal = persona.homeGoalTargetCents > 0;
    const goalPct = hasGoal
      ? Math.min(100, Math.round((persona.homeGoalSavedCents / Math.max(persona.homeGoalTargetCents, 1)) * 100))
      : undefined;

    const highlights: string[] = [];
    if (persona.segment) highlights.push(persona.segment);
    highlights.push(input.fundingStatus === "funded" ? "Account funded" : "Awaiting first deposit");
    if (totalCents > 0) {
      highlights.push(`${formatPortfolioAmount(totalCents)} portfolio (${formatPortfolioAmount(cashCents)} cash)`);
    }
    highlights.push(persona.beneficiaryStatus === "missing" ? "Beneficiaries missing" : "Beneficiaries on file");
    if (hasGoal && goalPct !== undefined) {
      highlights.push(`Home goal ${goalPct}% funded`);
    }
    for (const attr of (persona.customAttributes ?? []).slice(0, 3)) {
      if (attr.value.trim()) {
        const formatted = attr.type === "percent" ? `${attr.value.replace(/%$/, "")}%`
          : attr.type === "currency" && !attr.value.startsWith("$") ? `$${attr.value}`
          : attr.value;
        highlights.push(`${attr.label}: ${formatted}`);
      }
    }

    const dismissed = this.dismissedIds(input.principalId, input.personaId);
    const existingLower = (input.existingBlockTitles ?? []).map((t) => t.toLowerCase());
    const alreadyShown = (keywords: string[]) => keywords.some((kw) => existingLower.some((t) => t.includes(kw.toLowerCase())));

    const cashPct = totalCents > 0 ? Math.round((cashCents / totalCents) * 100) : 0;
    const goalRemainingCents = Math.max(0, persona.homeGoalTargetCents - persona.homeGoalSavedCents);
    const interpolate = (template: string, thresholdUsd: number) => template
      .replaceAll("{cash}", formatPortfolioAmount(cashCents))
      .replaceAll("{threshold}", formatPortfolioAmount(thresholdUsd * 100))
      .replaceAll("{cashPct}", String(cashPct))
      .replaceAll("{goalPct}", String(goalPct ?? 0))
      .replaceAll("{goalSaved}", formatPortfolioAmount(persona.homeGoalSavedCents))
      .replaceAll("{goalTarget}", formatPortfolioAmount(persona.homeGoalTargetCents))
      .replaceAll("{goalRemaining}", formatPortfolioAmount(goalRemainingCents))
      .replaceAll("{name}", persona.displayName);

    const candidates: NextBestActionCard[] = [];
    for (const rule of getEffectiveNbaRules()) {
      if (!rule.enabled) continue;
      if (rule.respectsPromotionExclusion && input.excludePromotions) continue;
      if (rule.dedupeKeywords.length && alreadyShown(rule.dedupeKeywords)) continue;
      const thresholdUsd = rule.thresholdUsd ?? 10000;
      const matches = rule.conditionKind === "unfunded_account"
        ? input.fundingStatus === "unfunded"
        : rule.conditionKind === "cash_above_usd"
          ? input.fundingStatus === "funded" && cashCents > thresholdUsd * 100
          : rule.conditionKind === "beneficiary_missing"
            ? persona.beneficiaryStatus === "missing"
            : rule.conditionKind === "has_home_goal"
              ? hasGoal && goalPct !== undefined
              : true;
      if (!matches) continue;
      candidates.push({
        id: rule.id,
        priority: rule.priority,
        kicker: interpolate(rule.kicker, thresholdUsd),
        title: interpolate(rule.title, thresholdUsd),
        body: interpolate(rule.body, thresholdUsd),
        reason: interpolate(rule.reason, thresholdUsd),
        ctaLabel: rule.ctaLabel,
        actionKind: rule.actionKind,
        ...(rule.actionKind === "prompt" && rule.prompt ? { prompt: rule.prompt } : {}),
      });
    }

    const selected = candidates.find((item) => !dismissed.has(item.id));
    return {
      lookup: {
        personaName: persona.displayName,
        fundingStatus: input.fundingStatus,
        highlights,
        ...(selected ? { nbaSelected: selected.title } : {}),
      },
      nba: selected,
    };
  }
}
