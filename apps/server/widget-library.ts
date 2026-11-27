import type { DomainPackId } from "../../packages/contracts/domain-packs";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { dynamicCanvasSchema, type DynamicCanvasNode, type DynamicCanvasProps } from "../../packages/contracts/dynamic-canvas";
import {
  savedWidgetSchema, type SavedWidget, type WidgetDraft, type WidgetKind, type WidgetLibraryChange,
} from "../../packages/contracts/widget";

const WIDGET_STOPWORDS = new Set([
  "this", "that", "with", "from", "have", "what", "when", "where", "which", "would", "could", "should",
  "about", "into", "your", "their", "there", "here", "today", "tomorrow", "please", "help", "want", "need",
  "show", "make", "build", "create", "generate", "design", "widget", "card", "component", "block", "layout",
  "chart", "graph", "table", "dashboard", "visualize", "visualise", "summary", "just", "very", "more", "some", "also", "like", "give", "tell", "know", "take", "open", "view", "check",
  "account", "balance", "balances", "portfolio", "rule", "rules", "wire", "transfer", "stock", "stocks",
]);

function extractWidgetTokens(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !WIDGET_STOPWORDS.has(w)),
  )];
}

export function compileSavedWidgetToCanvas(
  widget: SavedWidget,
  userPrompt: string,
  personaName?: string,
): { intro: string; canvas: DynamicCanvasProps } {
  const nodes: DynamicCanvasNode[] = [];
  const greetingPrefix = personaName ? `${personaName}: ` : "";

  nodes.push({
    type: "callout",
    tone: widget.accentTop ? "highlight" : "info",
    title: `${greetingPrefix}${widget.title}`.slice(0, 90),
    body: widget.body.slice(0, 600),
  });

  if (widget.metrics && widget.metrics.length > 0) {
    nodes.push({
      type: "metrics",
      items: widget.metrics.slice(0, 4).map((m) => ({
        label: m.label.slice(0, 48),
        value: m.value.slice(0, 36),
        ...(m.delta ? { delta: m.delta.slice(0, 32) } : {}),
      })),
    });
  }

  if (widget.columns && widget.columns.length === 2) {
    nodes.push({
      type: "comparison",
      columns: widget.columns.map((c) => ({
        title: c.title.slice(0, 56),
        points: c.points.slice(0, 6).map((p) => p.slice(0, 160)),
      })),
    });
  }

  if (widget.goal && widget.goal.target > 0) {
    nodes.push({
      type: "progress",
      label: `${widget.name} · ${widget.goal.unitLabel}`.slice(0, 160),
      current: Math.max(0, widget.goal.saved),
      target: widget.goal.target,
      currentDisplay: fmtUsd(widget.goal.saved).slice(0, 32),
      targetDisplay: fmtUsd(widget.goal.target).slice(0, 32),
    });
  }

  if (widget.steps && widget.steps.length > 0) {
    nodes.push({
      type: "checklist",
      title: widget.title.slice(0, 90),
      items: widget.steps.slice(0, 8).map((s) => s.slice(0, 160)),
    });
  }

  if (widget.sliders && widget.sliders.length > 0) {
    const allowedIds = new Set(["amount", "monthly", "rate", "years"]);
    const fallbackIds: ("monthly" | "years" | "rate")[] = ["monthly", "years", "rate"];
    nodes.push({
      type: "sliders",
      title: widget.title.slice(0, 90),
      formula: "compound_monthly",
      resultLabel: "Projected Total",
      inputs: widget.sliders.slice(0, 3).map((s, idx) => ({
        id: (allowedIds.has(s.id) ? s.id : fallbackIds[idx] ?? "amount") as "amount" | "monthly" | "rate" | "years",
        label: s.label.slice(0, 48),
        min: s.min,
        max: s.max,
        step: Math.max(0.1, s.step),
        value: s.value,
        unit: (s.unit === "percent" || s.unit === "years" ? s.unit : "usd") as "usd" | "percent" | "years",
      })),
    });
  }

  const canvas = dynamicCanvasSchema.parse({
    title: widget.name.slice(0, 96),
    badge: (widget.badge || "Saved Widget").slice(0, 44),
    subtitle: widget.title.slice(0, 200),
    generatedBy: "synthesizer",
    dataSource: `Widget Library (${widget.id})`,
    recordId: widget.id,
    prompt: userPrompt.slice(0, 400),
    nodes: nodes.slice(0, 5),
    disclaimer: "Rendered from your saved custom widget in CEP UI Studio → Widget Library.",
    ...(widget.ctaLabel ? { suggestedFollowUp: widget.ctaLabel.slice(0, 120) } : {}),
  });

  const intro = personaName
    ? `${widget.badge ? `**${widget.badge}**, ${personaName}! ` : ""}Matched your saved **${widget.name}** widget from the Widget Library.`
    : `Matched your saved **${widget.name}** widget from the Widget Library.`;

  return { intro, canvas };
}

const MAX_WIDGETS_PER_PRINCIPAL = 48;

function titleCase(text: string) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Custom Widget";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function extractAmounts(prompt: string): number[] {
  const matches = [...prompt.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*([kKmM])?/g)];
  return matches.map((match) => {
    const raw = Number(match[1].replace(/,/g, ""));
    const suffix = match[2]?.toLowerCase();
    if (suffix === "k") return Math.round(raw * 1_000);
    if (suffix === "m") return Math.round(raw * 1_000_000);
    return Math.round(raw);
  }).filter((value) => Number.isFinite(value));
}

function extractPercents(prompt: string): string[] {
  return [...prompt.matchAll(/([+-]?\d+(?:\.\d+)?%)/g)].map((m) => m[1]);
}

function deriveTitle(prompt: string, fallback: string): string {
  const stripped = prompt
    .replace(/^(?:(?:please|create|build|make|generate|design|add|show|me|an|a|the)\s+)+/i, "")
    .replace(/\s+(?:widget|card|component|module|block)(?:\s+(?:with|showing|for|that).*)?$/i, "")
    .replace(/\s+(?:showing|with)\s+.*$/i, "")
    .replace(/[.?!]+$/, "")
    .trim();
  if (stripped.length >= 4 && stripped.length <= 68) return titleCase(stripped);
  if (stripped.length > 68) return titleCase(stripped.slice(0, 65).replace(/\s+\S*$/, ""));
  return fallback;
}

function detectKind(prompt: string): WidgetKind {
  const lower = prompt.toLowerCase();
  if (/\b(vs\.?|versus|compare|comparison|difference between)\b/.test(lower)) return "comparison";
  if (/\b(calculator|slider|simulate|simulator|projection|planner|what-if|compound)\b/.test(lower)) return "calculator";
  if (/\b(goal|progress|tracker|target|saved toward|milestone|emergency fund|down payment)\b/.test(lower)) return "goal";
  if (/\b(checklist|steps|step-by-step|guide|onboarding|walkthrough|how to)\b/.test(lower)) return "checklist";
  if (/\b(kpi|metric|metrics|net worth|summary|dashboard|yield|balance|portfolio|allocation|assets)\b/.test(lower)) return "kpi";
  return "advisory";
}

function fmtUsd(amount: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount);
}

export function generateWidgetFromText(prompt: string): WidgetDraft {
  const cleanPrompt = prompt.trim();
  const kind = detectKind(cleanPrompt);
  const amounts = extractAmounts(cleanPrompt);
  const percents = extractPercents(cleanPrompt);
  const lower = cleanPrompt.toLowerCase();

  if (kind === "comparison") {
    const vsMatch = cleanPrompt.match(/([A-Za-z0-9\s&-]{2,36})\s+(?:vs\.?|versus)\s+([A-Za-z0-9\s&-]{2,36})/i);
    const leftRaw = vsMatch?.[1]?.replace(/^(?:(?:please|create|build|make|generate|compare|an|a|the)\s+)+/i, "").trim() || "Option A";
    const rightRaw = vsMatch?.[2]?.replace(/\s+(?:comparison|widget|card).*$/i, "").trim() || "Option B";
    const left = titleCase(leftRaw.slice(0, 36));
    const right = titleCase(rightRaw.slice(0, 36));
    const isIra = /roth|ira|traditional/i.test(cleanPrompt);
    return {
      name: `${left} vs ${right}`.slice(0, 72),
      kind,
      prompt: cleanPrompt,
      badge: "Comparison",
      title: `${left} vs. ${right}`,
      body: "Side-by-side highlights to help customers evaluate key trade-offs before taking action.",
      ctaLabel: "Ask assistant to compare",
      accentTop: true,
      recommendedComponent: "PznComparison",
      columns: [
        {
          title: left,
          points: isIra
            ? ["After-tax contributions", "Tax-free qualified withdrawals", "No required minimum distributions"]
            : ["Designed for immediate flexibility", "Clear fee and liquidity profile", "Best for short-to-medium horizon"],
        },
        {
          title: right,
          points: isIra
            ? ["Potential upfront tax deduction", "Tax-deferred compounding growth", "Taxed as income in retirement"]
            : ["Optimized for long-term compounding", "Structured allocation discipline", "Best for multi-year goals"],
        },
      ],
    };
  }

  if (kind === "calculator") {
    const monthlyDefault = amounts[0] && amounts[0] <= 10_000 ? amounts[0] : 1_200;
    const yearsMatch = cleanPrompt.match(/(\d{1,2})\s*(?:year|yr)/i);
    const yearsDefault = yearsMatch ? Math.min(40, Math.max(1, Number(yearsMatch[1]))) : 10;
    const title = deriveTitle(cleanPrompt, "Savings & Growth Calculator");
    return {
      name: title.slice(0, 72),
      kind,
      prompt: cleanPrompt,
      badge: "Interactive Calculator",
      title,
      body: "Adjust the sliders below to explore projected outcomes in real time.",
      ctaLabel: "Apply projection to plan",
      accentTop: true,
      recommendedComponent: "PznCapabilityForm",
      sliders: [
        { id: "monthly", label: "Monthly contribution", min: 100, max: 5000, step: 50, value: monthlyDefault, unit: "usd" },
        { id: "years", label: "Time horizon", min: 1, max: 30, step: 1, value: yearsDefault, unit: "years" },
        { id: "rate", label: "Expected annual return", min: 1, max: 12, step: 0.5, value: 6, unit: "percent" },
      ],
    };
  }

  if (kind === "goal") {
    const saved = amounts.length >= 2 ? Math.min(amounts[0], amounts[1]) : (amounts[0] ? Math.round(amounts[0] * 0.65) : 18_000);
    const target = amounts.length >= 2 ? Math.max(amounts[0], amounts[1]) : (amounts[0] || 25_000);
    const title = deriveTitle(cleanPrompt, "Savings Goal Tracker");
    return {
      name: title.slice(0, 72),
      kind,
      prompt: cleanPrompt,
      badge: "Goal Milestone",
      title,
      body: `Tracking progress toward ${fmtUsd(target)} with automated contribution visibility.`,
      ctaLabel: "Boost monthly savings",
      accentTop: true,
      recommendedComponent: "PznGoalProgress",
      goal: { saved, target, unitLabel: "saved toward target" },
    };
  }

  if (kind === "checklist") {
    const title = deriveTitle(cleanPrompt, "Action Checklist");
    const isBeneficiary = /beneficiar/i.test(lower);
    const isFunding = /fund|deposit|transfer/i.test(lower);
    const steps = isBeneficiary
      ? [
          "Review current primary and contingent beneficiaries on file",
          "Confirm allocation percentages total 100%",
          "Sign electronically and save confirmation receipt",
        ]
      : isFunding
        ? [
            "Choose a linked bank or cash management funding source",
            "Confirm transfer amount and settlement timeline",
            "Review funding preview and authorize deposit",
          ]
        : [
            "Review current account eligibility and details",
            "Confirm target parameters and preferences",
            "Verify disclosures and complete submission",
          ];
    return {
      name: title.slice(0, 72),
      kind,
      prompt: cleanPrompt,
      badge: "Guided Steps",
      title,
      body: "Complete these verified steps to finish the workflow cleanly.",
      ctaLabel: "Start guided steps",
      accentTop: false,
      recommendedComponent: "PznStepList",
      steps,
    };
  }

  if (kind === "kpi") {
    const title = deriveTitle(cleanPrompt, "Portfolio KPI Snapshot");
    const primary = amounts[0] ? fmtUsd(amounts[0]) : "$124,500";
    const secondary = amounts[1] ? fmtUsd(amounts[1]) : "$18,200";
    const trend = percents[0] ?? "+4.8%";
    return {
      name: title.slice(0, 72),
      kind,
      prompt: cleanPrompt,
      badge: "Live Metrics",
      title,
      body: "Real-time summary of key customer account indicators and momentum.",
      ctaLabel: "Review full breakdown",
      accentTop: true,
      recommendedComponent: "PznPortfolioSnapshot",
      metrics: [
        { label: "Total Value", value: primary, delta: trend },
        { label: "Cash Reserve", value: secondary, delta: "Liquid" },
        { label: "Projected Yield", value: percents[1] ?? "4.65%", delta: "Annualized" },
      ],
    };
  }

  const title = deriveTitle(cleanPrompt, "Personalized Advisory Insight");
  return {
    name: title.slice(0, 72),
    kind: "advisory",
    prompt: cleanPrompt,
    badge: "Suggested Next Step",
    title,
    body: cleanPrompt.length > 24 && cleanPrompt.length <= 280
      ? titleCase(cleanPrompt)
      : "Surface timely, eligibility-verified guidance tailored to the customer's current account state.",
    ctaLabel: "Explore recommendation",
    accentTop: true,
    recommendedComponent: "PznContentCard",
  };
}

function defaultSeedWidgets(now: number): SavedWidget[] {
  const seeds: WidgetDraft[] = [
    generateWidgetFromText("Create a retirement savings calculator with sliders for monthly contribution and 15 years"),
    generateWidgetFromText("Build an emergency fund goal tracker showing $18,000 saved toward $25,000"),
    generateWidgetFromText("Make a Roth IRA vs Traditional IRA comparison widget"),
  ];
  return seeds.map((widget, index) => ({
    ...widget,
    id: `wdg_seed00000000000${index + 1}`,
    createdAt: now - (3 - index) * 60_000,
    updatedAt: now - (3 - index) * 60_000,
  }));
}

export class WidgetLibraryStore {
  private readonly filePath: string;
  private cache: Record<string, SavedWidget[]> | null = null;

  constructor(dataDir: string, private readonly domainId: DomainPackId = "wealth") {
    this.filePath = resolve(dataDir, domainId === "wealth" ? "widget-library.json" : `widget-library.${domainId}.json`);
  }

  private load(): Record<string, SavedWidget[]> {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = {};
      return this.cache;
    }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, unknown>;
      const parsed: Record<string, SavedWidget[]> = {};
      for (const [principal, list] of Object.entries(raw)) {
        if (!Array.isArray(list)) continue;
        parsed[principal] = list.flatMap((entry) => {
          const result = savedWidgetSchema.safeParse(entry);
          return result.success ? [result.data] : [];
        });
      }
      this.cache = parsed;
      return parsed;
    } catch {
      this.cache = {};
      return this.cache;
    }
  }

  private persist(data: Record<string, SavedWidget[]>) {
    this.cache = data;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf8");
  }

  authorKey(sessionId: string, operator: string) {
    const owner = "operator:" + operator;
    const data = this.load();
    const legacy = data[sessionId];
    if (legacy) {
      const existing = data[owner] ?? [];
      const ids = new Set(existing.map(({ id }) => id));
      data[owner] = [...existing, ...legacy.filter(({ id }) => !ids.has(id))];
      delete data[sessionId];
      this.persist(data);
    }
    return owner;
  }

  list(principalId: string, now: number): SavedWidget[] {
    const data = this.load();
    if (!data[principalId]) {
      data[principalId] = this.domainId === "wealth" ? defaultSeedWidgets(now) : [];
      this.persist(data);
    }
    return data[principalId].slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  change(principalId: string, input: WidgetLibraryChange, now: number): { widget?: SavedWidget; widgets: SavedWidget[] } {
    const data = this.load();
    const current = this.list(principalId, now);

    if (input.operation === "delete") {
      const next = current.filter((item) => item.id !== input.id);
      data[principalId] = next;
      this.persist(data);
      return { widgets: next.slice().sort((a, b) => b.updatedAt - a.updatedAt) };
    }

    if (input.operation === "set_availability") {
      let updatedWidget: SavedWidget | undefined;
      const next = current.map((item) => {
        if (item.id !== input.id) return item;
        updatedWidget = { ...item, availableForConsumption: input.availableForConsumption, updatedAt: now };
        return updatedWidget;
      });
      data[principalId] = next;
      this.persist(data);
      return {
        ...(updatedWidget ? { widget: updatedWidget } : {}),
        widgets: (data[principalId] ?? []).slice().sort((a, b) => b.updatedAt - a.updatedAt),
      };
    }

    const existing = input.id ? current.find((item) => item.id === input.id) : undefined;
    if (!existing && current.length >= MAX_WIDGETS_PER_PRINCIPAL) {
      throw new Error(`Widget library limit (${MAX_WIDGETS_PER_PRINCIPAL}) reached. Delete a widget before adding another.`);
    }

    const saved: SavedWidget = {
      ...input.widget,
      availableForConsumption: input.widget.availableForConsumption ?? existing?.availableForConsumption ?? false,
      id: existing?.id ?? ("wdg_" + randomBytes(12).toString("hex")),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const next = [saved, ...current.filter((item) => item.id !== saved.id)];
    data[principalId] = next;
    this.persist(data);
    return { widget: saved, widgets: next.slice().sort((a, b) => b.updatedAt - a.updatedAt) };
  }

  renderPublishedWidget(principalId: string, prompt: string, personaName?: string, exactOnly = false) {
    const widget = this.matchCustomWidget(principalId, prompt, exactOnly);
    return widget && { widget, ...compileSavedWidgetToCanvas(widget, prompt, personaName) };
  }

  publishedWidgets(preferredOwner?: string) {
    const data = this.load();
    const groups = Object.entries(data).filter(([owner]) => owner !== preferredOwner).map(([, widgets]) => widgets);
    if (preferredOwner) groups.unshift(data[preferredOwner] ?? []);
    const widgets = new Map<string, SavedWidget>();
    for (const group of groups) {
      for (const widget of group) {
        if (widget.availableForConsumption && !widgets.has(widget.id)) widgets.set(widget.id, widget);
      }
    }
    return [...widgets.values()];
  }

  matchCustomWidget(principalId: string, prompt: string, exactOnly = false): SavedWidget | undefined {
    const trimmed = prompt.trim();
    if (trimmed.length < 3 || /\bcreate\s+(?:a\s+)?rule\b/i.test(trimmed)) return undefined;
    const tokens = extractWidgetTokens(trimmed);
    const candidates = this.publishedWidgets(principalId);
    const query = trimmed.toLowerCase();
    const exact = candidates.find((w) => w.prompt.trim().toLowerCase() === query || w.name.toLowerCase() === query);
    if (exact || exactOnly) return exact;
    if (!tokens.length) return undefined;
    let best: { widget: SavedWidget; score: number } | undefined;
    for (const w of candidates) {
      const nameLower = w.name.toLowerCase();
      const badgeLower = w.badge.toLowerCase();
      const titleLower = w.title.toLowerCase();
      const promptLower = w.prompt.toLowerCase();
      const bodyLower = w.body.toLowerCase();
      let score = 0;
      for (const tok of tokens) {
        if (nameLower.includes(tok)) score += 5;
        if (badgeLower.includes(tok)) score += 4;
        if (titleLower.includes(tok)) score += 3;
        if (promptLower.includes(tok)) score += 2;
        if (bodyLower.includes(tok)) score += 1;
      }
      if (score >= 5 && (!best || score > best.score)) {
        best = { widget: w, score };
      }
    }
    return best?.widget;
  }
}
