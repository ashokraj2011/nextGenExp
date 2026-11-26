import { z } from "zod";
import { runAgenticHarness, type AgenticHarness, type HarnessTrace } from "@sfield/core";
import {
  dynamicCanvasSchema,
  type DynamicCanvasNode,
  type DynamicCanvasProps,
  type DynamicHarnessTrace,
} from "../../packages/contracts/dynamic-canvas";
import { principalFor } from "./runtime";
import type { PortfolioSnapshotProvider } from "../../packages/portfolio-snapshot";
import type { GoalProgressProvider } from "../../packages/goal-progress";
import { findProfileById } from "../../packages/customer-profiles";
import type { StoredCustomerProfile } from "../../packages/contracts/customer-360";
import type { GatewaySettings } from "./gateway";
import type { TradeStore } from "./trade-store";
import { getLlmEgressContext } from "./pii-firewall";
import { callConfiguredLlmJson } from "./dynamic-ui-generator";

export type HarnessSourceId =
  | "portfolio_snapshot"
  | "stock_holdings"
  | "goal_progress"
  | "customer_balances"
  | "conversation_history"
  | "missing_external_source";

export type HarnessVisualType =
  | "piechart"
  | "barchart"
  | "table"
  | "metrics"
  | "progress"
  | "checklist"
  | "comparison"
  | "sliders";

const planSchema = z.object({
  resolvedGoal: z.string().trim().min(1).max(220),
  thinking: z.string().trim().max(360).optional(),
  needsClarification: z.boolean().optional(),
  clarificationQuestion: z.string().trim().max(220).optional(),
  clarificationChoices: z.array(z.object({
    id: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(240).optional(),
  }).strict()).max(6).optional(),
  neededSources: z.array(z.enum([
    "portfolio_snapshot",
    "stock_holdings",
    "goal_progress",
    "customer_balances",
    "conversation_history",
    "missing_external_source",
  ])).min(1).max(6),
  missingSourceName: z.string().trim().max(80).optional(),
  requiredVisuals: z.array(z.enum([
    "piechart",
    "barchart",
    "table",
    "metrics",
    "progress",
    "checklist",
    "comparison",
    "sliders",
  ])).max(5),
  correctionNote: z.string().trim().max(200).optional(),
});

export type DynamicUiPlan = z.infer<typeof planSchema>;

export interface FetchedGroundedData {
  persona?: StoredCustomerProfile;
  portfolio?: {
    totalCents: number;
    investedCents: number;
    equityCents: number;
    fixedIncomeCents: number;
    cashCents: number;
    asOf?: string;
  };
  goal?: {
    savedCents: number;
    targetCents: number;
    targetDate?: string;
  };
  holdings?: Array<{
    symbol: string;
    name: string;
    shares: number;
    avgCostCents: number;
    priceCents: number;
    marketValueCents: number;
    unrealizedPlCents: number;
  }>;
  recentContext?: string;
  sourceLabels: string[];
  promptContextText: string;
}

const portfolioWord = /\b(port?f[oa]l?io|protfolio|portfoilo|portofolio|porfolio|allocation|asset\s*mix|net\s*worth|invested|investments?)\b/i;
const holdingsWord = /\b(holdings?|stocks?|tickers?|equities|shares?|positions?|tax[- ]?loss)\b/i;
const goalWord = /\b(goal|home\s+(?:goal|plan|savings?|purchase)|down\s*payment|savings?\s+target)\b/i;
const balanceWord = /\b(balance|balances|cash|available|current\s+balance|beneficiar(?:y|ies)|funding|account\s+status)\b/i;
const followUpOrCorrectionWord = /\b(this\s+is\s+not|that\s+is\s+not|not\s+a\s+(?:pie|bar|donut|table|chart)|instead|make\s+it|change\s+it|turn\s+(?:it|that|this)\s+into|show\s+(?:it|that|this)\s+as|last\s+answer|previous\s+answer|prior\s+answer|your\s+answer|above|reframe|try\s+again)\b|^\s*(?:as|in|into|like|switch\s+to|convert\s+to)\s+(?:a\s+|an\s+)?[\w\s-]{2,28}(?:chart|graph|table|plot|diagram|map|view|summary|list|matrix|bullets?)\s*[.!?]*$/i;
const unsupportedVisualTypeRegex = /\b(bubble\s*chart|scatter\s*(?:plot|chart)|heat\s*map|radar\s*chart|spider\s*chart|tree\s*map|sankey(?:\s*diagram)?|waterfall\s*chart|gantt\s*chart|candlestick(?:\s*chart)?|box\s*plot|funnel\s*chart|3d\s*chart)\b/i;
const explicitUnconnectedWord = /\b(jira|confluence|snowflake|databricks|bigquery|sap|erp|workday|bamboohr|zendesk|freshdesk|hubspot|marketo|shopify|stripe\s+invoices|github\s+issues|linear\s+tickets|datadog|splunk|warehouse|shipments?|inventory|weather|sports\s+scores|flights?|hotels?)\b/i;

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtUsdWhole(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

function pct1(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

export function extractRequiredVisuals(prompt: string): HarnessVisualType[] {
  const visuals: HarnessVisualType[] = [];
  if (/\b(pie\s*chart|donut\s*chart|\bpie\b|\bdonut\b)\b/i.test(prompt)) visuals.push("piechart");
  if (/\b(bar\s*chart|column\s*chart|histogram)\b/i.test(prompt)) visuals.push("barchart");
  if (/\b(table|matrix|spreadsheet|tabular|grid)\b/i.test(prompt)) visuals.push("table");
  if (/\b(bullet\s*points?|checklist|summarize|key\s+takeaways?|3\s+points?)\b/i.test(prompt) && !visuals.includes("table")) {
    visuals.push("checklist");
  }
  if (/\b(side[- ]by[- ]side|pros\s+and\s+cons|trade-?offs?)\b/i.test(prompt)) visuals.push("comparison");
  if (/\b(calculator|simulator|slider|what[- ]if)\b/i.test(prompt)) visuals.push("sliders");
  return visuals;
}

const ambiguousVisualOnlyPrompt = /^\s*(?:please\s+)?(?:can\s+you\s+)?(?:(?:show|make|build|create|generate|draw|give|render|design|display|convert|switch)\s+(?:me\s+|it\s+|this\s+|that\s+)?)?(?:as\s+|in\s+|into\s+|to\s+)?(?:a\s+|an\s+|some\s+)?(?:custom\s+|interactive\s+|dynamic\s+|clear\s+)?(?:(?:pie|donut|bar|line|area|bubble|scatter|radar|funnel|waterfall|comparison)\s+)?(?:chart|graph|plot|table|dashboard|widget|view|breakdown|visuali[sz]ation|report|summary|matrix|checklist)\s*(?:of\s+(?:my\s+)?(?:data|stuff|things|account|numbers|everything))?(?:\s+please)?[\s.!?]*$/i;

export function inferDeterministicPlan(prompt: string, recentContext?: string): DynamicUiPlan {
  const clean = prompt.trim();
  const requiredVisuals = extractRequiredVisuals(clean);
  const isFollowUp = followUpOrCorrectionWord.test(clean);
  const unsupportedVisual = clean.match(unsupportedVisualTypeRegex)?.[1]?.trim();

  // If the prompt explicitly asks about an unconnected external dataset (e.g. Jira, warehouse shipments),
  // never fabricate numbers — flag missing_external_source immediately.
  if (explicitUnconnectedWord.test(clean) && !portfolioWord.test(clean) && !holdingsWord.test(clean) && !goalWord.test(clean)) {
    const match = clean.match(explicitUnconnectedWord)?.[0] ?? "that external dataset";
    return {
      resolvedGoal: clean.slice(0, 200),
      thinking: `Detected external dataset "${match}", which is not connected to CEP's Customer 360 or Portfolio providers. Stopping before synthesis to avoid fabricated records.`,
      neededSources: ["missing_external_source"],
      missingSourceName: match,
      requiredVisuals,
    };
  }

  const hasAnyDomainCue = portfolioWord.test(clean) || holdingsWord.test(clean) || goalWord.test(clean) || balanceWord.test(clean);
  const hasRecentContext = Boolean(recentContext?.trim());

  // 1. Unsupported visual primitive (e.g. "as bubble chart", "radar chart", "scatter plot"):
  //    Never say "Data source needed" — explain honestly what visual primitives ARE supported and ask what they want to show!
  if (unsupportedVisual) {
    const topicLabel = hasAnyDomainCue || hasRecentContext ? "your portfolio or stock holdings" : "your account data";
    const question = hasAnyDomainCue || hasRecentContext
      ? `I don't have a native ${unsupportedVisual.toLowerCase()} renderer yet, though I have your live data ready. What would you like shown and which supported visual should I use?`
      : `I don't have a native ${unsupportedVisual.toLowerCase()} renderer yet, and you didn't specify which dataset to plot. What would you like to visualize?`;
    return {
      resolvedGoal: `Clarify dataset and supported chart format instead of ${unsupportedVisual.toLowerCase()}`,
      thinking: `Requested "${unsupportedVisual}", which is not in the supported visual catalog (piechart, barchart, table, metrics, progress, checklist, comparison, sliders)${hasRecentContext ? ", while referencing prior conversation context" : " and no dataset was named"}. Asking a clarifying question with supported options instead of failing.`,
      needsClarification: true,
      clarificationQuestion: question,
      clarificationChoices: [
        { id: "portfolio_pie", label: "Portfolio allocation as a Pie Chart", prompt: "Show my portfolio allocation as a pie chart" },
        { id: "holdings_bar", label: "Stock holdings by value as a Bar Chart", prompt: "Show my stock holdings as a bar chart" },
        { id: "portfolio_table", label: "Portfolio & balances as a Comparison Table", prompt: "Show my portfolio summary as a comparison table" },
        { id: "home_goal_view", label: "Home savings goal & cash breakdown", prompt: "Show my home savings goal and cash balances as a table" },
      ],
      neededSources: ["portfolio_snapshot"],
      requiredVisuals: ["piechart"],
    };
  }

  // 2. Underspecified visual-only prompt with NO dataset mentioned and NO prior context to inherit:
  //    Pause at Stage 1 with a focused clarifying question + one-tap options.
  if (!hasAnyDomainCue && !hasRecentContext && ambiguousVisualOnlyPrompt.test(clean)) {
    const formatWord = requiredVisuals.includes("piechart")
      ? "pie chart"
      : requiredVisuals.includes("barchart")
        ? "bar chart"
        : requiredVisuals.includes("table")
          ? "table"
          : "view";
    const visualSuffix = formatWord === "view" ? "breakdown" : formatWord;
    return {
      resolvedGoal: `Clarify which connected dataset to render as a ${formatWord}`,
      thinking: `You asked for a ${formatWord} without specifying which dataset to visualize, and there is no active topic to inherit. Asking one quick clarifying question before fetching data.`,
      needsClarification: true,
      clarificationQuestion: `What would you like this ${formatWord} to show?`,
      clarificationChoices: [
        { id: "portfolio_alloc", label: "Portfolio allocation (Stocks, Fixed Income, Cash)", prompt: `Show my portfolio allocation as a ${visualSuffix}` },
        { id: "stock_holdings", label: "Individual stock holdings by ticker", prompt: `Show my stock holdings as a ${visualSuffix}` },
        { id: "home_goal", label: "Home savings goal & cash reserve", prompt: `Show my home savings goal and cash balances as a ${visualSuffix}` },
      ],
      neededSources: ["portfolio_snapshot"],
      requiredVisuals: requiredVisuals.length ? requiredVisuals : ["piechart"],
    };
  }

  const needed = new Set<HarnessSourceId>();
  const combinedForSources = (isFollowUp || ambiguousVisualOnlyPrompt.test(clean)) && recentContext
    ? `${clean}\n${recentContext}`
    : clean;

  if (portfolioWord.test(combinedForSources)) {
    needed.add("portfolio_snapshot");
    needed.add("customer_balances");
  }
  if (holdingsWord.test(combinedForSources)) {
    needed.add("stock_holdings");
    needed.add("portfolio_snapshot");
  }
  if (goalWord.test(combinedForSources)) {
    needed.add("goal_progress");
    needed.add("customer_balances");
  }
  if (balanceWord.test(combinedForSources)) {
    needed.add("customer_balances");
    needed.add("portfolio_snapshot");
  }
  if ((isFollowUp || ambiguousVisualOnlyPrompt.test(clean)) && hasRecentContext) {
    needed.add("conversation_history");
    // If the user gave a short visual follow-up ("as pie chart", "this is not a pie chart") after a turn, inherit portfolio data.
    if (needed.size === 1) {
      needed.add("portfolio_snapshot");
      needed.add("customer_balances");
    }
  }

  // If still no connected CEP source matched (e.g. "Show a chart of regional sales by quarter" in wealth domain)
  if (needed.size === 0) {
    return {
      resolvedGoal: clean.slice(0, 200),
      thinking: `No connected CEP provider matches "${clean.slice(0, 80)}". Stopping cleanly so the user can identify which data source should supply the records.`,
      neededSources: ["missing_external_source"],
      missingSourceName: "that dataset",
      requiredVisuals,
    };
  }

  const visualText = requiredVisuals.length ? requiredVisuals.join(" + ") : "structured visual summary";
  const resolvedGoal = isFollowUp
    ? `Update the prior view to display the customer's live data as ${visualText} (per request: "${clean.slice(0, 110)}")`
    : `Display the customer's live data as ${visualText}: ${clean.slice(0, 140)}`;
  const thinking = isFollowUp
    ? `Recognized follow-up/correction ("${clean.slice(0, 80)}") against the previous turn. Selected ${[...needed].join(", ")} and locked required visual(s) to ${visualText}.`
    : `Interpreted request against connected CEP sources (${[...needed].join(", ")}) and locked required visual(s) to ${visualText}.`;

  return {
    resolvedGoal: resolvedGoal.slice(0, 220),
    thinking: thinking.slice(0, 360),
    neededSources: [...needed],
    requiredVisuals: requiredVisuals.length ? requiredVisuals : ["metrics", "table"],
    ...(isFollowUp ? { correctionNote: `User follow-up/correction: "${clean.slice(0, 140)}"` } : {}),
  };
}

const plannerSystemPrompt = [
  "You are Stage 1 (Planner) of the sfield Multi-Step Agentic Harness.",
  "Your job is to think through and clarify EXACTLY what the user wants BEFORE any data fetch or UI generation — handling typos (e.g., 'protfolio' = portfolio), resolving multi-turn follow-ups/corrections (e.g., 'this is not a pie chart', 'make it a table instead'), and asking a brief clarifying question when the request is genuinely ambiguous.",
  "Available CONNECTED CEP data sources:",
  "- portfolio_snapshot: live total portfolio value, stocks, fixed income, and cash allocation",
  "- stock_holdings: live individual stock tickers, shares, avg cost, market value, unrealized P/L",
  "- goal_progress: home down-payment savings saved vs target and progress",
  "- customer_balances: current balance, available balance, funding status, beneficiary status, profile attributes",
  "- conversation_history: prior turns in this thread",
  "- missing_external_source: choose ONLY when the user asks for an external system/dataset NOT covered by the 5 connected sources above (e.g. Jira tickets, warehouse shipments, weather, Salesforce contacts).",
  "Available UI visual primitives:",
  "- piechart (SVG donut/pie chart — MUST choose whenever the user asks for a pie chart or donut chart!)",
  "- barchart (horizontal bar chart)",
  "- table (structured rows & columns)",
  "- metrics (KPI summary tiles)",
  "- progress (goal progress bar)",
  "- checklist (concise bullet summary / action checklist)",
  "- comparison (2-column side-by-side comparison)",
  "- sliders (interactive what-if calculator)",
  "WHEN TO CLARIFY (needsClarification: true):",
  "- Ask ONE crisp clarifying question with 2-4 clickable choices ONLY when the user asks for a generic chart/table/dashboard/view without specifying which dataset or angle AND there is no clear topic in RECENT CONVERSATION (e.g., 'make me a pie chart', 'build a dashboard', 'visualize my data').",
  "- Do NOT ask for clarification when the dataset & visual are clear (e.g., 'show the protfolio as pie chart') or when the user asks for an unconnected external system (use neededSources: ['missing_external_source'] instead).",
  "Always include a concise 1-2 sentence 'thinking' explaining your reasoning for the user to inspect.",
  "Return ONE valid JSON object:",
  JSON.stringify({
    resolvedGoal: "Clear 1-sentence goal after resolving typos and prior context",
    thinking: "1-2 sentences explaining how you interpreted the prompt, what sources/visuals you chose, or why clarification is needed.",
    needsClarification: false,
    clarificationQuestion: "Optional 1-sentence question only when needsClarification is true",
    clarificationChoices: [{ id: "portfolio_alloc", label: "Portfolio allocation", prompt: "Show my portfolio allocation as a pie chart" }],
    neededSources: ["portfolio_snapshot"],
    missingSourceName: "Optional name only if neededSources includes missing_external_source",
    requiredVisuals: ["piechart", "metrics"],
    correctionNote: "Optional note if user corrected or rejected the previous visualization",
  }),
].join("\n");

const composerSystemPrompt = [
  "You are Stage 3 (Dynamic UI Composer) of the CEP Multi-Step Dynamic UI Harness.",
  "You receive a verified PLAN (resolvedGoal, requiredVisuals, correctionNote) and STAGE 2 FETCHED GROUNDED DATA.",
  "CRITICAL RULES:",
  "1. You MUST include EVERY visual node type listed in plan.requiredVisuals! For example, if 'piechart' is in requiredVisuals, you MUST include a { type: 'piechart', slices: [...] } node — do NOT substitute a barchart or table.",
  "2. Use ONLY the exact live numbers, labels, and facts from FETCHED GROUNDED DATA. Never invent numbers.",
  "3. Never mention any external brokerage or company names; refer to the platform only as CEP.",
  "Return ONE JSON object with this exact shape:",
  JSON.stringify({
    intro: "1-2 concise sentences explaining what the dynamic view shows.",
    canvas: {
      title: "Clear headline (max 90 chars)",
      badge: "Short badge like 'Portfolio Pie Chart' or 'Dynamic Comparison' (max 40 chars)",
      subtitle: "Concise subtitle citing live balances",
      generatedBy: "llm",
      dataSource: "Customer 360 + Live Portfolio Snapshot",
      nodes: [
        "1 to 5 nodes using ONLY these exact schemas:",
        "{ type: 'piechart', title?, centerLabel?, centerValue?, slices: [{ label, value: number>=0, displayValue, color?: '#hex', highlight?: boolean }] } (2-8 slices)",
        "{ type: 'barchart', title?, unit?: 'usd'|'percent'|'number', bars: [{ label, value: number>=0, displayValue, highlight?: boolean }] } (2-8 bars)",
        "{ type: 'metrics', items: [{ label, value, delta? }] } (1-4 items)",
        "{ type: 'table', caption?, columns: [2..5 strings], rows: [[2..5 strings matching columns]] } (1-10 rows)",
        "{ type: 'progress', label, current: number>=0, target: number>0, currentDisplay, targetDisplay }",
        "{ type: 'checklist', title?, items: [1..8 strings] }",
        "{ type: 'comparison', columns: [{ title, points: [1..6 strings] }, { title, points: [1..6 strings] }] }",
        "{ type: 'sliders', title?, formula: 'compound_monthly'|'annual_yield'|'simple_total', resultLabel, inputs: [{ id: 'amount'|'monthly'|'rate'|'years', label, min, max, step, value, unit: 'usd'|'percent'|'years' }] }",
        "{ type: 'callout', tone: 'info'|'highlight'|'caution', title?, body }",
      ],
      disclaimer: "Grounded in live Customer 360 and Portfolio Snapshot data.",
      suggestedFollowUp: "Short natural next prompt",
    },
  }),
].join("\n");

async function callLlmStage(
  gateway: GatewaySettings,
  dataDir: string,
  operation: string,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  const onAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await callConfiguredLlmJson(
      gateway,
      dataDir,
      systemPrompt,
      userPrompt,
      controller.signal,
      undefined,
      { ...(getLlmEgressContext(dataDir) ?? {}), operation },
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onAbort);
  }
}

export async function fetchGroundedData(input: {
  plan: DynamicUiPlan;
  personaId?: string;
  portfolioSnapshots?: PortfolioSnapshotProvider;
  goalProgressProvider?: GoalProgressProvider;
  tradeStore?: TradeStore;
  recentContext?: string;
  signal?: AbortSignal;
}): Promise<FetchedGroundedData> {
  const persona = input.personaId ? findProfileById(input.personaId) : undefined;
  const sourceLabels: string[] = [];
  const textSections: string[] = [];
  const needed = new Set(input.plan.neededSources);

  let portfolio: FetchedGroundedData["portfolio"];
  if (persona && (needed.has("portfolio_snapshot") || needed.has("customer_balances") || needed.has("stock_holdings"))) {
    const liveSnap = input.portfolioSnapshots
      ? await input.portfolioSnapshots.read(persona.syntheticMid, input.signal).catch(() => null)
      : null;
    const equityCents = liveSnap?.equityCents ?? persona.equityCents;
    const fixedIncomeCents = liveSnap?.fixedIncomeCents ?? persona.fixedIncomeCents;
    const cashCents = liveSnap?.cashCents ?? persona.cashCents;
    const totalCents = equityCents + fixedIncomeCents + cashCents;
    const investedCents = equityCents + fixedIncomeCents;
    portfolio = {
      totalCents,
      investedCents,
      equityCents,
      fixedIncomeCents,
      cashCents,
      asOf: liveSnap?.asOf?.slice(0, 10),
    };
    sourceLabels.push(liveSnap ? "Live Portfolio Snapshot" : "Customer 360 Portfolio");
    textSections.push([
      `LIVE PORTFOLIO SNAPSHOT${portfolio.asOf ? ` (As of ${portfolio.asOf})` : ""}:`,
      `- Total Portfolio Value: ${fmtUsd(totalCents)}`,
      `- Stocks / Equities: ${fmtUsd(equityCents)} (${pct1(equityCents, totalCents)}%)`,
      `- Fixed Income: ${fmtUsd(fixedIncomeCents)} (${pct1(fixedIncomeCents, totalCents)}%)`,
      `- Invested Subtotal: ${fmtUsd(investedCents)} (${pct1(investedCents, totalCents)}%)`,
      `- Cash: ${fmtUsd(cashCents)} (${pct1(cashCents, totalCents)}%)`,
    ].join("\n"));
  }

  let goal: FetchedGroundedData["goal"];
  if (persona && (needed.has("goal_progress") || needed.has("customer_balances") || needed.has("portfolio_snapshot"))) {
    const liveGoal = input.goalProgressProvider
      ? await input.goalProgressProvider.read(persona.syntheticMid, input.signal).catch(() => null)
      : null;
    const savedCents = liveGoal?.history?.at(-1)?.savedCents ?? persona.homeGoalSavedCents;
    const targetCents = liveGoal?.targetCents ?? persona.homeGoalTargetCents;
    if (targetCents > 0) {
      goal = { savedCents, targetCents };
      sourceLabels.push("Goal Progress");
      const gp = Math.min(100, Math.round((savedCents / targetCents) * 100));
      textSections.push(
        `HOME SAVINGS GOAL: ${fmtUsd(savedCents)} saved of ${fmtUsd(targetCents)} target (${gp}% funded, ${fmtUsd(Math.max(0, targetCents - savedCents))} remaining).`,
      );
    }
  }

  if (persona && needed.has("customer_balances")) {
    sourceLabels.push("Customer 360");
    textSections.push([
      `CUSTOMER 360 PROFILE:`,
      `- Name: ${persona.displayName} (${persona.segment || "Member"})`,
      `- Funding Status: ${persona.accountFundingStatus} | Beneficiaries: ${persona.beneficiaryStatus}`,
      `- Current Balance: ${fmtUsd(persona.currentBalanceCents)} | Available Balance: ${fmtUsd(persona.availableBalanceCents)}`,
    ].join("\n"));
  }

  let holdings: FetchedGroundedData["holdings"];
  if (persona && input.tradeStore && needed.has("stock_holdings")) {
    const snap = input.tradeStore.snapshotFor(persona.personaId);
    const active = snap.holdings.filter((h) => h.shares > 0);
    if (active.length) {
      holdings = active.map((h) => ({
        symbol: h.symbol,
        name: h.name,
        shares: h.shares,
        avgCostCents: h.avgCostCents,
        priceCents: h.priceCents,
        marketValueCents: h.shares * h.priceCents,
        unrealizedPlCents: (h.priceCents - h.avgCostCents) * h.shares,
      }));
      sourceLabels.push("Live Stock Holdings");
      textSections.push([
        "LIVE STOCK HOLDINGS:",
        ...holdings.slice(0, 8).map(
          (h) => `- ${h.symbol} (${h.name}): ${h.shares} sh, market value ${fmtUsd(h.marketValueCents)}, P/L ${h.unrealizedPlCents >= 0 ? "+" : ""}${fmtUsd(h.unrealizedPlCents)}`,
        ),
      ].join("\n"));
    }
  }

  if (input.recentContext?.trim()) {
    sourceLabels.push("Conversation Context");
    textSections.push(`RECENT CONVERSATION:\n${input.recentContext.trim().slice(0, 2000)}`);
  }

  return {
    persona,
    portfolio,
    goal,
    holdings,
    recentContext: input.recentContext,
    sourceLabels: [...new Set(sourceLabels)],
    promptContextText: textSections.join("\n\n"),
  };
}

export function buildGroundedFallbackCanvas(
  prompt: string,
  plan: DynamicUiPlan,
  fetched: FetchedGroundedData,
): { intro: string; canvas: DynamicCanvasProps } {
  const name = fetched.persona?.displayName ?? "Customer";
  const p = fetched.portfolio;
  const nodes: DynamicCanvasNode[] = [];
  const visuals = new Set(plan.requiredVisuals);

  if (p) {
    const stocksPct = pct1(p.equityCents, p.totalCents);
    const fixedPct = pct1(p.fixedIncomeCents, p.totalCents);
    const cashPct = pct1(p.cashCents, p.totalCents);

    if (visuals.has("piechart")) {
      const slices = fetched.holdings?.length && /\b(stocks?|holdings?|tickers?)\b/i.test(prompt)
        ? fetched.holdings.slice(0, 6).map((h) => ({
            label: h.symbol,
            value: Math.round(h.marketValueCents / 100),
            displayValue: fmtUsd(h.marketValueCents),
          }))
        : [
            { label: "Stocks", value: Math.round(p.equityCents / 100), displayValue: fmtUsd(p.equityCents), color: "#2f7d32", highlight: true },
            { label: "Cash", value: Math.round(p.cashCents / 100), displayValue: fmtUsd(p.cashCents), color: "#c88a2b" },
            { label: "Fixed Income", value: Math.round(p.fixedIncomeCents / 100), displayValue: fmtUsd(p.fixedIncomeCents), color: "#476b8a" },
          ].filter((s) => s.value > 0);

      if (slices.length >= 2) {
        nodes.push({
          type: "piechart",
          title: `${name}'s Portfolio Breakdown`,
          centerLabel: "Total value",
          centerValue: fmtUsdWhole(p.totalCents),
          slices,
        });
      }
    }

    nodes.push({
      type: "metrics",
      items: [
        { label: "Total Portfolio", value: fmtUsd(p.totalCents), delta: p.asOf ? `As of ${p.asOf}` : "Live balance" },
        { label: "Invested", value: fmtUsd(p.investedCents), delta: `${(stocksPct + fixedPct).toFixed(1)}%` },
        { label: "Stocks", value: fmtUsd(p.equityCents), delta: `${stocksPct}%` },
        { label: "Cash", value: fmtUsd(p.cashCents), delta: `${cashPct}%` },
      ],
    });

    if (visuals.has("checklist") && !visuals.has("table") && !visuals.has("piechart")) {
      const items = [
        `Total portfolio is ${fmtUsd(p.totalCents)}: ${fmtUsd(p.investedCents)} invested (${stocksPct}% stocks, ${fixedPct}% fixed income) and ${fmtUsd(p.cashCents)} (${cashPct}%) in cash.`,
        fetched.goal
          ? `Home savings goal is ${Math.min(100, Math.round((fetched.goal.savedCents / fetched.goal.targetCents) * 100))}% funded (${fmtUsd(fetched.goal.savedCents)} of ${fmtUsd(fetched.goal.targetCents)}).`
          : `Current balance is ${fmtUsd(fetched.persona?.currentBalanceCents ?? p.totalCents)} with ${fmtUsd(fetched.persona?.availableBalanceCents ?? p.cashCents)} available.`,
        cashPct >= 20
          ? `Cash represents ${cashPct}% of your portfolio (${fmtUsd(p.cashCents)}) — consider modeling cash deployment.`
          : "Portfolio cash reserve is within typical liquidity ranges.",
      ];
      nodes.push({ type: "checklist", title: "Key Portfolio Takeaways", items });
    }

    if (visuals.has("table") || (!visuals.has("piechart") && !visuals.has("barchart") && !visuals.has("checklist"))) {
      const rows: string[][] = [
        ["Stocks / Equities", fmtUsd(p.equityCents), `${stocksPct}%`, "Long-term growth"],
        ["Fixed Income", fmtUsd(p.fixedIncomeCents), `${fixedPct}%`, "Stability & income"],
        ["Cash", fmtUsd(p.cashCents), `${cashPct}%`, cashPct >= 20 ? "Elevated reserve" : "Liquid reserve"],
      ];
      if (fetched.goal) {
        const gp = Math.min(100, Math.round((fetched.goal.savedCents / fetched.goal.targetCents) * 100));
        rows.push(["Home Savings Goal", fmtUsd(fetched.goal.savedCents), `${gp}% of ${fmtUsd(fetched.goal.targetCents)}`, `${fmtUsd(Math.max(0, fetched.goal.targetCents - fetched.goal.savedCents))} remaining`]);
      }
      nodes.push({
        type: "table",
        caption: `${name} — Live Portfolio Comparison`,
        columns: ["Category", "Amount", "Share / Progress", "Role"],
        rows,
      });
    }

    if (visuals.has("barchart")) {
      nodes.push({
        type: "barchart",
        title: "Portfolio Allocation by Asset Class",
        unit: "usd",
        bars: [
          { label: `Stocks (${stocksPct}%)`, value: Math.round(p.equityCents / 100), displayValue: fmtUsd(p.equityCents), highlight: true },
          { label: `Cash (${cashPct}%)`, value: Math.round(p.cashCents / 100), displayValue: fmtUsd(p.cashCents) },
          { label: `Fixed Income (${fixedPct}%)`, value: Math.round(p.fixedIncomeCents / 100), displayValue: fmtUsd(p.fixedIncomeCents) },
        ],
      });
    }

    if (visuals.has("progress") && fetched.goal) {
      nodes.push({
        type: "progress",
        label: "Home savings goal",
        current: Math.round(fetched.goal.savedCents / 100),
        target: Math.round(fetched.goal.targetCents / 100),
        currentDisplay: fmtUsd(fetched.goal.savedCents),
        targetDisplay: fmtUsd(fetched.goal.targetCents),
      });
    }
  }

  if (nodes.length === 0) {
    nodes.push({
      type: "callout",
      tone: "info",
      body: "Connected account details were loaded, though no numeric portfolio segments were present.",
    });
  }

  const primaryVisual = visuals.has("piechart")
    ? "pie chart"
    : visuals.has("barchart")
      ? "bar chart"
      : visuals.has("checklist")
        ? "summary checklist"
        : "comparison table";

  const title = visuals.has("piechart")
    ? "Portfolio Allocation Pie Chart"
    : visuals.has("barchart")
      ? "Portfolio Allocation Bar Chart"
      : visuals.has("checklist")
        ? "Portfolio Summary Takeaways"
        : "Portfolio Summary Comparison Table";

  const badge = visuals.has("piechart")
    ? "Pie Chart"
    : visuals.has("barchart")
      ? "Bar Chart"
      : visuals.has("checklist")
        ? "Dynamic Summary"
        : "Dynamic Table";

  const intro = p
    ? `Here is ${name}'s live portfolio as a ${primaryVisual} (${fmtUsd(p.totalCents)} total: ${pct1(p.equityCents, p.totalCents)}% stocks, ${pct1(p.fixedIncomeCents, p.totalCents)}% fixed income, ${pct1(p.cashCents, p.totalCents)}% cash).`
    : `Here is ${name}'s account view as a ${primaryVisual}.`;

  return {
    intro,
    canvas: {
      title,
      badge,
      subtitle: `${name} · Grounded in ${fetched.sourceLabels.join(" + ") || "Customer 360"}`,
      generatedBy: "synthesizer",
      dataSource: fetched.sourceLabels.join(" + ") || "Customer 360",
      prompt: prompt.slice(0, 600),
      nodes: nodes.slice(0, 5),
      disclaimer: "Figures reflect live Customer 360 and Portfolio Snapshot balances.",
      suggestedFollowUp: visuals.has("piechart")
        ? "Show this breakdown as a comparison table"
        : "Show my portfolio as a pie chart",
    },
  };
}

function validateAgainstPlan(raw: unknown, plan: DynamicUiPlan, prompt: string, dataSource: string): {
  ok: boolean;
  result?: { intro: string; canvas: DynamicCanvasProps };
  violations: string[];
} {
  if (!raw || typeof raw !== "object") {
    return { ok: false, violations: ["Model did not return a JSON object."] };
  }
  const obj = raw as Record<string, unknown>;
  const rawCanvas = obj.canvas && typeof obj.canvas === "object" ? (obj.canvas as Record<string, unknown>) : null;
  if (!rawCanvas) {
    return { ok: false, violations: ["Missing top-level 'canvas' object."] };
  }
  const candidate = {
    ...rawCanvas,
    generatedBy: "llm" as const,
    dataSource: typeof rawCanvas.dataSource === "string" && rawCanvas.dataSource.trim()
      ? rawCanvas.dataSource.trim().slice(0, 120)
      : dataSource.slice(0, 120),
    prompt: prompt.slice(0, 600),
    disclaimer: typeof rawCanvas.disclaimer === "string" && rawCanvas.disclaimer.trim()
      ? rawCanvas.disclaimer.trim().slice(0, 240)
      : "Grounded in live Customer 360 and Portfolio Snapshot data.",
  };
  const parsed = dynamicCanvasSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`);
    return { ok: false, violations: [`Schema validation failed: ${issues.join("; ")}`] };
  }

  const nodeTypes = new Set(parsed.data.nodes.map((n) => n.type));
  const violations: string[] = [];
  for (const required of plan.requiredVisuals) {
    if (required === "metrics") continue; // metrics are helpful but secondary to primary visual
    if (!nodeTypes.has(required)) {
      violations.push(`Missing required visual node type '${required}'.`);
    }
  }
  if (violations.length > 0) {
    return { ok: false, violations };
  }

  const intro = typeof obj.intro === "string" && obj.intro.trim()
    ? obj.intro.trim().slice(0, 400)
    : `Here is your dynamically composed view for "${parsed.data.title}".`;
  return { ok: true, result: { intro, canvas: parsed.data }, violations: [] };
}

function toCanvasTrace(trace: HarnessTrace): DynamicHarnessTrace {
  return {
    harnessRunId: trace.harnessRunId,
    resolvedGoal: trace.resolvedGoal,
    ...(trace.thinking ? { thinking: trace.thinking } : {}),
    fetchedSources: trace.fetchedSources,
    visualTargets: trace.visualTargets,
    repaired: trace.repaired,
    stages: trace.stages,
  };
}

export async function runDynamicUiHarness(input: {
  prompt: string;
  personaId?: string;
  principalId?: string;
  recentContext?: string;
  gateway?: GatewaySettings | null;
  dataDir: string;
  harness?: AgenticHarness;
  portfolioSnapshots?: PortfolioSnapshotProvider;
  goalProgressProvider?: GoalProgressProvider;
  tradeStore?: TradeStore;
  signal?: AbortSignal;
}): Promise<{ intro: string; canvas: DynamicCanvasProps }> {
  const execute = input.harness
    ? input.harness.run.bind(input.harness)
    : runAgenticHarness;

  const outcome = await execute<DynamicUiPlan, FetchedGroundedData, { intro: string; canvas: DynamicCanvasProps }, unknown>({
    kind: "dynamic_ui",
    principal: input.principalId ? principalFor(input.principalId) : undefined,
    signal: input.signal,
    maxRepairs: 1,

    // ── STAGE 1: PLAN ──
    plan: async () => {
      const detPlan = inferDeterministicPlan(input.prompt, input.recentContext);
      let plan: DynamicUiPlan = detPlan;

      const shouldUseLlmPlanner = Boolean(input.gateway)
        && !explicitUnconnectedWord.test(input.prompt)
        && !detPlan.needsClarification;
      if (shouldUseLlmPlanner && input.gateway) {
        const plannerPrompt = [
          input.recentContext?.trim() ? `RECENT CONVERSATION:\n${input.recentContext.trim().slice(0, 1400)}` : "RECENT CONVERSATION: (none)",
          `USER MESSAGE: ${input.prompt}`,
        ].join("\n\n");
        const rawPlan = await callLlmStage(
          input.gateway,
          input.dataDir,
          "dynamic_ui_plan",
          plannerSystemPrompt,
          plannerPrompt,
          8_000,
          input.signal,
        );
        const parsedPlan = planSchema.safeParse(rawPlan);
        if (parsedPlan.success) {
          const mergedVisuals = [...new Set([...parsedPlan.data.requiredVisuals, ...extractRequiredVisuals(input.prompt)])].slice(0, 5);
          const llmNeedsMissing = parsedPlan.data.neededSources.includes("missing_external_source");
          const detNeedsMissing = detPlan.neededSources.includes("missing_external_source");
          plan = {
            ...parsedPlan.data,
            neededSources: (detNeedsMissing && llmNeedsMissing)
              ? ["missing_external_source"]
              : parsedPlan.data.neededSources,
            requiredVisuals: mergedVisuals.length ? mergedVisuals : detPlan.requiredVisuals,
          };
        }
      }

      if (plan.needsClarification && plan.clarificationQuestion) {
        return {
          status: "needs_clarification",
          plan,
          question: plan.clarificationQuestion,
          choices: plan.clarificationChoices,
          resolvedGoal: plan.resolvedGoal,
          thinking: plan.thinking ?? detPlan.thinking,
          targets: plan.requiredVisuals,
          summary: `Request needs clarification before fetching data`,
        };
      }

      if (plan.neededSources.includes("missing_external_source")) {
        return {
          status: "needs_data",
          plan,
          missingSource: plan.missingSourceName,
          resolvedGoal: plan.resolvedGoal,
          thinking: plan.thinking ?? detPlan.thinking,
          targets: plan.requiredVisuals,
          summary: `Identified unconnected data request (${plan.missingSourceName ?? "external source"})`,
        };
      }

      return {
        status: "ready",
        plan,
        resolvedGoal: plan.resolvedGoal,
        thinking: plan.thinking ?? detPlan.thinking,
        targets: plan.requiredVisuals,
        summary: `Goal resolved · visuals: ${plan.requiredVisuals.join(", ") || "auto"} · sources: ${plan.neededSources.join(", ")}`,
      };
    },

    // ── STAGE 2: GATHER / FETCH ──
    gather: async (plan) => {
      const fetched = await fetchGroundedData({
        plan,
        personaId: input.personaId,
        portfolioSnapshots: input.portfolioSnapshots,
        goalProgressProvider: input.goalProgressProvider,
        tradeStore: input.tradeStore,
        recentContext: input.recentContext,
        signal: input.signal,
      });
      const portfolioNote = fetched.portfolio
        ? `Loaded live portfolio (${fmtUsd(fetched.portfolio.totalCents)}: ${pct1(fetched.portfolio.equityCents, fetched.portfolio.totalCents)}% stocks, ${pct1(fetched.portfolio.fixedIncomeCents, fetched.portfolio.totalCents)}% fixed income, ${pct1(fetched.portfolio.cashCents, fetched.portfolio.totalCents)}% cash).`
        : "Loaded live profile and conversation context.";
      return {
        status: "ok",
        evidence: fetched,
        sources: fetched.sourceLabels,
        thinking: portfolioNote,
        summary: fetched.sourceLabels.length
          ? `Fetched grounded data from ${fetched.sourceLabels.join(", ")}`
          : "Loaded session context",
      };
    },

    // ── STAGE 3: SYNTHESIZE / COMPOSE ──
    synthesize: async (plan, fetched) => {
      if (input.gateway && fetched.promptContextText) {
        const composePrompt = [
          `VERIFIED PLAN:\n${JSON.stringify(plan, null, 2)}`,
          fetched.promptContextText,
          `USER REQUEST: ${input.prompt}`,
        ].join("\n\n");
        const raw = await callLlmStage(
          input.gateway,
          input.dataDir,
          "dynamic_ui_compose",
          composerSystemPrompt,
          composePrompt,
          12_000,
          input.signal,
        );
        return { candidate: raw, summary: `LLM composed candidate for ${plan.requiredVisuals.join(" + ") || "dynamic view"}` };
      }
      const fallback = buildGroundedFallbackCanvas(input.prompt, plan, fetched);
      return {
        candidate: { __groundedDirect: true, result: fallback },
        summary: `Composed grounded ${fallback.canvas.nodes.map((n) => n.type).join(" + ")} directly from live data`,
      };
    },

    // ── STAGE 4a: VERIFY ──
    verify: (candidate, plan, fetched) => {
      if (candidate && typeof candidate === "object" && "__groundedDirect" in candidate && "result" in candidate) {
        const direct = (candidate as { result: { intro: string; canvas: DynamicCanvasProps } }).result;
        return {
          ok: true,
          output: direct,
          summary: `Verified required visuals (${plan.requiredVisuals.join(", ") || "valid"}) against Customer 360`,
        };
      }
      const dataSourceLabel = fetched.sourceLabels.join(" + ") || "Customer 360";
      const check = validateAgainstPlan(candidate, plan, input.prompt, dataSourceLabel);
      if (check.ok && check.result) {
        return {
          ok: true,
          output: check.result,
          summary: `Verified schema + required visuals (${plan.requiredVisuals.join(", ") || "valid"})`,
        };
      }
      return { ok: false, violations: check.violations };
    },

    // ── STAGE 4b: TARGETED LLM REPAIR ──
    repair: input.gateway
      ? async (plan, fetched, violations) => {
          const repairPrompt = [
            `VERIFIED PLAN:\n${JSON.stringify(plan, null, 2)}`,
            fetched.promptContextText,
            `USER REQUEST: ${input.prompt}`,
            `VERIFICATION VIOLATIONS TO FIX:\n- ${violations.join("\n- ")}`,
            "Fix every violation above and return ONLY the corrected JSON object.",
          ].join("\n\n");
          const raw = await callLlmStage(
            input.gateway!,
            input.dataDir,
            "dynamic_ui_repair",
            composerSystemPrompt,
            repairPrompt,
            10_000,
            input.signal,
          );
          return { candidate: raw, summary: `LLM auto-repaired canvas for ${plan.requiredVisuals.join(" + ") || "view"}` };
        }
      : undefined,

    // ── STAGE 4c: DETERMINISTIC GROUNDED FALLBACK ──
    fallback: (plan, fetched) => buildGroundedFallbackCanvas(input.prompt, plan, fetched),
  });

  if (outcome.status === "needs_data") {
    const missingLabel = outcome.missingSource && outcome.missingSource !== "that dataset"
      ? `for "${outcome.missingSource}"`
      : "for that view";
    const intro = `I don’t have a connected data source ${missingLabel}. Which source should supply the records?`;
    return {
      intro,
      canvas: {
        title: "Data source needed",
        badge: "Data availability",
        generatedBy: "synthesizer",
        nodes: [{ type: "callout", tone: "info", body: intro }],
        disclaimer: "No records were loaded.",
        harnessTrace: toCanvasTrace(outcome.trace),
      },
    };
  }

  if (outcome.status === "needs_clarification") {
    return {
      intro: outcome.question,
      canvas: {
        title: "Quick clarification",
        badge: "sfield Harness",
        generatedBy: "synthesizer",
        nodes: [{ type: "callout", tone: "info", body: outcome.question }],
        ...(outcome.choices?.length ? { choices: outcome.choices } : {}),
        disclaimer: "Choose an option or reply with the details you'd like shown.",
        harnessTrace: toCanvasTrace(outcome.trace),
      },
    };
  }

  if (outcome.status === "completed") {
    return {
      intro: outcome.output.intro,
      canvas: {
        ...outcome.output.canvas,
        harnessTrace: toCanvasTrace(outcome.trace),
      },
    };
  }

  const emergency = buildGroundedFallbackCanvas(input.prompt, outcome.plan, outcome.evidence);
  return {
    intro: emergency.intro,
    canvas: {
      ...emergency.canvas,
      harnessTrace: toCanvasTrace(outcome.trace),
    },
  };
}
