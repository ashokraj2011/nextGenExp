import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  proactiveAlertSchema,
  proactiveTriggerInputSchema,
  type ProactiveAlert,
  type ProactiveEventType,
  type ProactiveTriggerInput,
  type ProactiveView,
} from "../../packages/contracts/proactive-events";
import { makeId } from "../../packages/experience/compile";

const EVENT_TEMPLATES: Record<ProactiveEventType, Omit<ProactiveAlert, "id" | "createdAt" | "dismissed" | "personaId">> = {
  "market.price_alert": {
    eventType: "market.price_alert",
    severity: "opportunity",
    domain: "wealth",
    title: "AAPL +8.4% Gain · Tax-Loss Harvest Window Open",
    summary: "Apple reached $236.40 intraday. Pairing a partial trim with unrealized INTC losses can offset estimated capital gains tax.",
    metricLabel: "Est. Tax Offset",
    metricValue: "$220+ Savings",
    ctaLabel: "Simulate 40% AAPL Trim + Tax Harvest",
    ctaPrompt: "I want to sell 40% of my Apple shares",
  },
  "portfolio.large_deposit": {
    eventType: "portfolio.large_deposit",
    severity: "info",
    domain: "wealth",
    title: "Large Cash Deposit Settled (+$25,000)",
    summary: "Your available cash reserve now exceeds your target liquidity buffer. Review allocation options or initiate a governed wire.",
    metricLabel: "Idle Cash Alert",
    metricValue: "+$25,000",
    ctaLabel: "Review Portfolio Allocation",
    ctaPrompt: "Let me know my portfolio summary.",
  },
  "ops.latency_spike": {
    eventType: "ops.latency_spike",
    severity: "critical",
    domain: "it_ops",
    title: "P1 Edge Latency Spike Detected (442ms · 5xx 4.8%)",
    summary: "Checkout API error budget burn exceeded 10x threshold after v4.12.1 rollout. Rollback approval card is pre-staged.",
    metricLabel: "p95 Latency",
    metricValue: "442ms (P1)",
    ctaLabel: "Open P1 Triage & Rollback",
    ctaPrompt: "Build an IT incident triage dashboard for our active P1 alert",
  },
  "sales.deal_at_risk": {
    eventType: "sales.deal_at_risk",
    severity: "opportunity",
    domain: "sales_revops",
    title: "Enterprise Renewal At Risk · Acme Cloud Corp ($420k ARR)",
    summary: "Buyer requested a 22% multi-year discount before Friday close. Deal Desk HITL sign-off required (>15% cap).",
    metricLabel: "At-Risk ARR",
    metricValue: "$420,000",
    ctaLabel: "Review Deal Desk Approval",
    ctaPrompt: "Show the enterprise discount approval card for Acme Cloud Corp",
  },
  "custom.event": {
    eventType: "custom.event",
    severity: "info",
    domain: "wealth",
    title: "Proactive CEP Event Triggered",
    summary: "An external webhook event triggered a proactive advisory card in your workspace.",
    metricLabel: "Status",
    metricValue: "Action Ready",
    ctaLabel: "Inspect Live Equity Book",
    ctaPrompt: "whats in my equity book right now?",
  },
};

export class ProactiveEventStore {
  private readonly filePath: string;
  private alerts: ProactiveAlert[];
  private readonly listeners = new Set<(alert: ProactiveAlert) => void>();

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "proactive-alerts.json");
    this.alerts = this.load();
  }

  private load(): ProactiveAlert[] {
    if (existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
        if (Array.isArray(raw)) {
          return raw
            .map((item) => proactiveAlertSchema.safeParse(item))
            .filter((res): res is { success: true; data: ProactiveAlert } => res.success)
            .map((res) => res.data)
            .slice(0, 40);
        }
      } catch { /* fall through */ }
    }
    return [];
  }

  private save(next: ProactiveAlert[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(next.slice(0, 40), null, 2), "utf8");
    this.alerts = next.slice(0, 40);
  }

  subscribe(listener: (alert: ProactiveAlert) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  view(): ProactiveView {
    const active = this.alerts.filter((a) => !a.dismissed);
    return {
      alerts: this.alerts.slice(0, 20),
      activeCount: active.length,
    };
  }

  trigger(rawInput: ProactiveTriggerInput, principalId?: string): { alert: ProactiveAlert; view: ProactiveView } {
    const input = proactiveTriggerInputSchema.parse(rawInput);
    const tpl = EVENT_TEMPLATES[input.eventType];
    const alert: ProactiveAlert = {
      id: makeId("evt"),
      eventType: input.eventType,
      severity: tpl.severity,
      domain: tpl.domain,
      title: input.title || tpl.title,
      summary: input.summary || tpl.summary,
      metricLabel: input.metricLabel || tpl.metricLabel,
      metricValue: input.metricValue || tpl.metricValue,
      ctaLabel: input.ctaLabel || tpl.ctaLabel,
      ctaPrompt: input.ctaPrompt || tpl.ctaPrompt,
      personaId: input.personaId || "demo-learner",
      principalId,
      createdAt: new Date().toISOString(),
      dismissed: false,
    };
    this.save([alert, ...this.alerts]);
    for (const fn of this.listeners) {
      try { fn(alert); } catch { /* ignore */ }
    }
    return { alert, view: this.view() };
  }

  dismiss(id: string, principalId?: string): ProactiveView {
    const next = this.alerts.map((a) => (a.id === id && (!principalId || a.principalId === principalId) ? { ...a, dismissed: true } : a));
    this.save(next);
    return this.view();
  }
}
