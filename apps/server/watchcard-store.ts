/**
 * Living Threads — Autonomous Watchcards store (#3):
 * Turns any customer intent into a persistent, self-updating sentinel card inside chat.
 * When the real-world condition triggers, CEP stages a digest-bound approval and pushes an SSE update live to chat.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  watchcardSchema,
  type CreateWatchcardInput,
  type Watchcard,
  type WatchcardMetric,
} from "../../packages/contracts/nextgen-chat";
import type { CustomerProfileStore } from "../../packages/customer-profiles";

export class WatchcardStore {
  private readonly filePath: string;
  private cards: Watchcard[];
  private readonly listeners = new Set<(card: Watchcard) => void>();

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "watchcards.json");
    this.cards = this.load();
  }

  private load(): Watchcard[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.flatMap((x) => {
        const p = watchcardSchema.safeParse(x);
        return p.success ? [p.data] : [];
      });
    } catch {
      return [];
    }
  }

  private save(next: Watchcard[]) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.cards = next.slice(0, 100);
    writeFileSync(this.filePath, JSON.stringify(this.cards, null, 2), "utf8");
  }

  subscribe(listener: (card: Watchcard) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(card: Watchcard) {
    for (const cb of this.listeners) {
      try { cb(card); } catch { /* ignore */ }
    }
  }

  metricValueUsd(profileStore: CustomerProfileStore, personaId: string, metric: WatchcardMetric): number {
    const p = profileStore.findByPersonaId(personaId);
    if (!p) return 0;
    switch (metric) {
      case "cash_balance": return Math.round((p.cashCents ?? 0) / 100);
      case "equity_value": return Math.round((p.equityCents ?? 0) / 100);
      case "goal_progress": return Math.round((p.homeGoalSavedCents ?? 0) / 100);
      case "portfolio_total": return Math.round(((p.cashCents ?? 0) + (p.equityCents ?? 0) + (p.fixedIncomeCents ?? 0)) / 100);
    }
  }

  list(personaId?: string): Watchcard[] {
    return this.cards.filter((c) => c.status !== "dismissed" && (!personaId || c.personaId === personaId));
  }

  findById(id: string): Watchcard | undefined {
    return this.cards.find((c) => c.id === id);
  }

  create(input: CreateWatchcardInput, profileStore: CustomerProfileStore): Watchcard {
    const now = new Date().toISOString();
    const metric = input.metric ?? "cash_balance";
    const personaId = input.personaId ?? "demo-learner";
    const currentValueUsd = this.metricValueUsd(profileStore, personaId, metric);
    const card = watchcardSchema.parse({
      id: `wch_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      conversationId: input.conversationId ?? "default",
      personaId,
      title: input.title,
      metric,
      operator: input.operator ?? "gte",
      thresholdUsd: input.thresholdUsd,
      actionSummary: input.actionSummary,
      actionPrompt: input.actionPrompt ?? input.actionSummary,
      status: "watching",
      currentValueUsd,
      createdAt: now,
      updatedAt: now,
    });
    this.save([card, ...this.cards]);
    this.emit(card);
    return card;
  }

  markTriggered(id: string, observedValueUsd: number, approvalId: string): Watchcard | undefined {
    const existing = this.findById(id);
    if (!existing || existing.status !== "watching") return existing;
    const now = new Date().toISOString();
    const updated: Watchcard = {
      ...existing,
      status: "triggered",
      currentValueUsd: observedValueUsd,
      approvalId,
      triggeredAt: now,
      updatedAt: now,
    };
    this.save(this.cards.map((c) => (c.id === id ? updated : c)));
    this.emit(updated);
    return updated;
  }

  markExecuted(id: string, auditId: string): Watchcard | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;
    const now = new Date().toISOString();
    const updated: Watchcard = {
      ...existing,
      status: "executed",
      auditId,
      executedAt: now,
      updatedAt: now,
    };
    this.save(this.cards.map((c) => (c.id === id ? updated : c)));
    this.emit(updated);
    return updated;
  }

  dismiss(id: string): Watchcard | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;
    const now = new Date().toISOString();
    const updated: Watchcard = { ...existing, status: "dismissed", updatedAt: now };
    this.save(this.cards.map((c) => (c.id === id ? updated : c)));
    this.emit(updated);
    return updated;
  }
}
