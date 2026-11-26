import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { matchingDeals, matchingIncidents } from "./record-context";
import { dynamicCanvasSchema, type DynamicCanvasNode, type DynamicCanvasProps } from "../../packages/contracts/dynamic-canvas";
import { findProfileById } from "../../packages/customer-profiles";
import { widgetDraftSchema, type WidgetDraft } from "../../packages/contracts/widget";
import { runCopilotPrompt } from "./copilot-acp-client";
import { getLlmEgressContext, rehydrateObjectStrings, scrubJsonSafeText, type LlmEgressContext } from "./pii-firewall";
import type { GatewaySettings } from "./gateway";
import type { OpsIncidentStore } from "./ops-store";
import type { SalesDealStore } from "./sales-store";
import type { SemanticRouteDecision } from "../../packages/contracts/capabilities-catalog";
import type { ActionFlow } from "../../packages/contracts/action-flow";
import type { TradeDraftState, TradeLegInput } from "../../packages/contracts/trading";
import type { ConnectorStore } from "./connector-store";
import type { ApprovalStore } from "./approval-store";
import type { ActionFlowStore } from "./action-flow-store";
import { parseStockTradePrompt, type SettlementCallback, type TradeStore } from "./trade-store";
import { connectorInvokeToolRef, domainWriteToolRef } from "./runtime";
import { generateWidgetFromText } from "./widget-library";
import { runDynamicUiHarness } from "./dynamic-ui-harness";
import type { AgenticHarness, HarnessStageRecord } from "@sfield/core";
import type { PendingClarificationState } from "./chat-history";
import type { PortfolioSnapshotProvider } from "../../packages/portfolio-snapshot";
import type { GoalProgressProvider } from "../../packages/goal-progress";

const dynamicUiTrigger = /\b(widget|table|pie\s*chart|donut\s*chart|bar\s*chart|chart|graph|dashboard|visuali[sz]e|visuali[sz]ation|calculator|simulator|matrix|breakdown|dynamic ui|custom ui|interactive|summarize\s+(?:your\s+)?last\s+answer|in\s+\d+\s+bullet\s+points?|not\s+a\s+(?:pie|bar|donut)\s*chart|approval\s+(?:card|flow|form|workflow|request|queue)|pending\s+approvals?|show\s+(?:my\s+)?approvals?|review\s+approvals?|hitl\s+queue|pagerduty|external\s+connector|invoke\s+connector|run\s+connector|trigger\s+webhook|timeline|roadmap|triage|incident\s+(?:triage|dashboard|timeline|queue|status|report|response)|rollback|deal\s+desk|sales\s+pipeline|discount\s+approval|close[- ]plan|intake\s+form|(?:sell|buy|purchase|trim|trade)\b.*\b(?:shares?|stocks?|aapl|apple|msft|microsoft|nvda|nvidia|intc|intel|boeing|pfizer|voo)\b|tax[- ]?loss\s+harvest(?:ing)?|(?:show|list|view|all|what|see)\b.*\b(?:my\s+)?(?:stocks?|holdings?|shares?|positions?|equities)\b|\bmy\s+(?:stocks?|holdings?|shares?|positions?)\b|stock\s+(?:holdings?|positions?|list)|build\s+(?:me\s+)?a\b|design\s+(?:me\s+)?a\b|generate\s+(?:me\s+)?a\b|create\s+a\s+.*(?:ui|card|view|table|chart|calculator|tracker|breakdown|form|board|dashboard|timeline|approval|checklist|workflow)|make\s+a\s+.*(?:ui|card|view|table|chart|calculator|tracker|breakdown|form|board|dashboard|timeline|approval|checklist))\b/i;
const nonDynamicGuard = /\b(weather|stock price|tomorrow|create a? ?rule)\b/i;
const opsIncidentTrigger = /\b(incidents?|triage|rollback|sre|sev\s*[0-3]|p[1-3]\b|latency|5xx|error rate|it ops|operations dashboard|post-incident|production alert|inc-\d+)\b/i;
const salesDealTrigger = /\b(deals?|deal\s*desk|deal-\d+|sales\s*pipeline|pipeline\s*(?:breakdown|chart|table|forecast)|revops|discount\s*approval|pricing\s*exception|mutual\s*action\s*plan|close[- ]plan|acme\s*cloud|enterprise\s*renewal)\b/i;
const approvalQueueTrigger = /\b(pending\s+approvals?|approval\s+queue|show\s+(?:my\s+)?approvals?|review\s+approvals?|hitl\s+queue)\b/i;
const connectorActionTrigger = /\b(pagerduty|external\s+connector|invoke\s+connector|run\s+connector|trigger\s+webhook|servicenow\s+webhook)\b/i;
const stockTradeTrigger = /\b((?:sell|buy|purchase|trim|trade|simulate\s+(?:a\s+)?(?:sell|buy|trade))\b.*\b(?:shares?|stocks?|aapl|apple|msft|microsoft|nvda|nvidia|intc|intel|boeing|pfizer|voo)\b|tax[- ]?loss\s+harvest(?:ing)?)\b/i;
const stockHoldingsTrigger = /\b((?:show|list|view|see|all|what)\b.*\b(?:my\s+)?(?:stocks?|holdings?|shares?|positions?)\b|my\s+(?:stocks?|holdings?|shares?|positions?)|stock\s+(?:holdings?|positions?|list))\b/i;

export function isDynamicUiRequest(message: string): boolean {
  const clean = message.trim();
  if (clean.length < 5 || nonDynamicGuard.test(clean)) return false;
  // Explicit visual formats (pie/donut/bar/bubble chart, comparison table) always enter the Dynamic UI Harness.
  if (/\b(pie\s*chart|donut\s*chart|bar\s*chart|bubble\s*chart|scatter\s*plot|radar\s*chart|heat\s*map|comparison\s+table|as\s+a\s+(?:clear\s+)?(?:comparison\s+)?table|not\s+a\s+(?:pie|bar|donut)\s*chart)\b|^\s*as\s+(?:a\s+|an\s+)?[\w\s-]{2,24}(?:chart|table|graph|plot)\s*$/i.test(clean)) return true;
  // Generic portfolio allocation queries use the verified Portfolio Snapshot card.
  if (/\bportfolio\b/i.test(clean) && /\b(?:allocation|asset mix)\b/i.test(clean) && !/\b(?:simulat\w*|project\w*|forecast\w*|histor\w*|trend\w*|model)\b/i.test(clean)) return false;
  return dynamicUiTrigger.test(clean);
}

export function isOpsIncidentPrompt(message: string): boolean {
  return opsIncidentTrigger.test(message);
}

export function isSalesDealPrompt(message: string): boolean {
  return salesDealTrigger.test(message);
}

export function isApprovalQueuePrompt(message: string): boolean {
  return approvalQueueTrigger.test(message);
}

export function isConnectorActionPrompt(message: string): boolean {
  return connectorActionTrigger.test(message);
}

export function isStockTradePrompt(message: string): boolean {
  return stockTradeTrigger.test(message);
}

export function isStockHoldingsPrompt(message: string): boolean {
  return stockHoldingsTrigger.test(message);
}

function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/i);
  if (fenced) return fenced[1].trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

export async function callConfiguredLlmJson(
  gateway: GatewaySettings,
  dataDir: string,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
  image?: { base64: string; mimeType: string },
  egressOverride?: LlmEgressContext & { operation?: string },
): Promise<unknown | null> {
  const egress = egressOverride ?? getLlmEgressContext(dataDir);
  const piiFirewall = egress?.piiFirewall;
  const telemetry = egress?.telemetry;
  const operation = egressOverride?.operation ?? "llm_json";
  const startedAt = Date.now();
  const provider = gateway.profile === "copilot_acp" ? "copilot_acp" : gateway.profile === "openai" ? "openai" : "openai_compatible";

  // Single egress PII firewall enforcement: scrub outbound user prompt before it leaves the server.
  let outboundUserPrompt = userPrompt;
  let tokenMap = new Map<string, string>();
  let redactedCount = 0;
  if (piiFirewall && piiFirewall.getConfig().enabled) {
    const knownNames = egress?.getKnownNames?.() ?? [];
    const scrubbed = scrubJsonSafeText(userPrompt, knownNames, piiFirewall.getConfig());
    outboundUserPrompt = scrubbed.scrubbed;
    tokenMap = scrubbed.tokenMap;
    redactedCount = scrubbed.tokens.length;
    if (redactedCount > 0) {
      piiFirewall.recordEgressEvent({
        personaName: `egress:${operation}`,
        tokens: scrubbed.tokens,
        scrubbedPreview: outboundUserPrompt.slice(0, 140),
      });
      telemetry?.recordPiiRedaction(redactedCount, operation);
    }
  }

  const approxInTokens = Math.ceil((systemPrompt.length + outboundUserPrompt.length) / 4);

  try {
    if (gateway.profile === "copilot_acp") {
      const cliHome = resolve(dataDir, "copilot-cli");
      mkdirSync(cliHome, { recursive: true, mode: 0o700 });
      const fullText = `${systemPrompt}\n\nUSER REQUEST:\n${outboundUserPrompt}\n\nReturn ONLY one valid JSON object matching the schema. No markdown fences, no commentary.`;
      let rawText: string | undefined;
      if (image) {
        try {
          const reply = await runCopilotPrompt(
            gateway,
            cliHome,
            [
              { type: "image", data: image.base64, mimeType: image.mimeType },
              { type: "text", text: fullText },
            ],
            signal,
            () => undefined,
          );
          rawText = reply.text;
        } catch {
          // If this Copilot CLI model does not support inline ACP image blocks, retry text-only below.
        }
      }
      if (rawText === undefined) {
        const reply = await runCopilotPrompt(gateway, cliHome, [{ type: "text", text: fullText }], signal, () => undefined);
        rawText = reply.text;
      }
      const parsed = JSON.parse(stripJsonFences(rawText));
      telemetry?.recordModelCall({
        operation, provider, model: gateway.model, durationMs: Date.now() - startedAt, status: "ok",
        inputTokens: approxInTokens, outputTokens: Math.ceil(rawText.length / 4), piiRedactedCount: redactedCount,
      });
      return rehydrateObjectStrings(parsed, tokenMap);
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(gateway.apiKey ? { Authorization: `Bearer ${gateway.apiKey}` } : {}),
      ...(gateway.headers ?? {}),
    };
    const userContent = image
      ? [
          { type: "text", text: outboundUserPrompt },
          { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.base64}` } },
        ]
      : outboundUserPrompt;
    const response = await fetch(`${gateway.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        ...(gateway.bodyFields ?? {}),
        model: gateway.model,
        max_tokens: Math.min(gateway.maxOutputTokens, 1400),
        temperature: 0.3,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
    });
    if (!response.ok) {
      telemetry?.recordModelCall({
        operation, provider, model: gateway.model, durationMs: Date.now() - startedAt, status: "error",
        inputTokens: approxInTokens, outputTokens: 0, piiRedactedCount: redactedCount, errorMessage: `HTTP ${response.status}`,
      });
      return null;
    }
    const payload = await response.json() as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = payload.choices?.[0]?.message?.content;
    if (!text) return null;
    const parsed = JSON.parse(stripJsonFences(text));
    telemetry?.recordModelCall({
      operation, provider, model: gateway.model, durationMs: Date.now() - startedAt, status: "ok",
      inputTokens: payload.usage?.prompt_tokens ?? approxInTokens,
      outputTokens: payload.usage?.completion_tokens ?? Math.ceil(text.length / 4),
      piiRedactedCount: redactedCount,
    });
    return rehydrateObjectStrings(parsed, tokenMap);
  } catch (err) {
    telemetry?.recordModelCall({
      operation, provider, model: gateway.model, durationMs: Date.now() - startedAt, status: "error",
      inputTokens: approxInTokens, outputTokens: 0, piiRedactedCount: redactedCount,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function recordChoices(prompt: string, title: string, source: string, choices: { id: string; label: string }[]) {
  const intro = choices.length ? "Choose a record to see its details." : "I couldn’t find a matching record. Check the ID or name and try again.";
  return { intro, canvas: {
    title, badge: "Record lookup", generatedBy: "synthesizer" as const, dataSource: source, prompt: prompt.slice(0, 600),
    nodes: [{ type: "callout" as const, tone: "info" as const, body: intro }],
    choices: choices.slice(0, 12), disclaimer: source,
  } };
}

export function isRecordTimeline(prompt: string, capability: "ops_incident" | "sales_deal_desk") {
  return capability === "ops_incident" ? /\b(timeline|post-incident|root-cause|history)\b/i.test(prompt)
    : /\b(timeline|close[- ]plan|mutual\s*action)\b/i.test(prompt);
}

const groundedCustomerDataTrigger = /\b(portfolio|summary|allocation|asset\s+mix|balance|balances|cash|invested|stocks?|equit(?:y|ies)|fixed\s+income|bonds?|holdings?|shares?|positions?|goal|home\s+(?:goal|plan|savings?)|down\s+payment|savings?|retirement|beneficiar(?:y|ies)|funding|last\s+answer|previous\s+answer|prior\s+answer|your\s+answer|above|bullet\s+points?|summarize|reframe)\b/i;

const unconnectedExternalSourceTrigger = /\b(jira|confluence|snowflake|databricks|bigquery|sap|erp|workday|bamboohr|zendesk|freshdesk|hubspot|marketo|shopify|stripe\s+invoices|github\s+issues|linear\s+tickets|datadog|splunk|weather|sports\s+scores)\b/i;

function fmtUsdCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildGroundedCustomerContext(
  personaId?: string,
  tradeStore?: TradeStore,
  profileSummary?: string,
  recentContext?: string,
): { hasCustomerData: boolean; hasRecentContext: boolean; text: string } {
  const sections: string[] = [];
  const persona = personaId ? findProfileById(personaId) : undefined;
  let hasCustomerData = false;

  if (persona) {
    hasCustomerData = true;
    const totalCents = persona.cashCents + persona.equityCents + persona.fixedIncomeCents;
    const investedCents = persona.equityCents + persona.fixedIncomeCents;
    const pct = (part: number) => totalCents > 0 ? `${((part / totalCents) * 100).toFixed(1)}%` : "0%";
    const goalPct = persona.homeGoalTargetCents > 0
      ? Math.min(100, Math.round((persona.homeGoalSavedCents / persona.homeGoalTargetCents) * 100))
      : 0;
    const lines = [
      `Customer: ${persona.displayName} (${persona.segment || "Member"})`,
      `Account Funding Status: ${persona.accountFundingStatus}`,
      `Beneficiary Status: ${persona.beneficiaryStatus}`,
      `Total Portfolio Value: ${fmtUsdCents(totalCents)}`,
      `- Stocks / Equities: ${fmtUsdCents(persona.equityCents)} (${pct(persona.equityCents)})`,
      `- Fixed Income: ${fmtUsdCents(persona.fixedIncomeCents)} (${pct(persona.fixedIncomeCents)})`,
      `- Invested Subtotal: ${fmtUsdCents(investedCents)} (${pct(investedCents)})`,
      `- Cash: ${fmtUsdCents(persona.cashCents)} (${pct(persona.cashCents)})`,
      `Current Balance: ${fmtUsdCents(persona.currentBalanceCents)} | Available Balance: ${fmtUsdCents(persona.availableBalanceCents)}`,
    ];
    if (persona.homeGoalTargetCents > 0) {
      lines.push(
        `Home Savings Goal: ${fmtUsdCents(persona.homeGoalSavedCents)} saved of ${fmtUsdCents(persona.homeGoalTargetCents)} target (${goalPct}% funded, ${fmtUsdCents(Math.max(0, persona.homeGoalTargetCents - persona.homeGoalSavedCents))} remaining)`,
      );
    }
    if (persona.customAttributes?.length) {
      lines.push(`Custom Attributes: ${persona.customAttributes.map((a) => `${a.label}=${a.value}`).join("; ")}`);
    }
    if (tradeStore) {
      const snap = tradeStore.snapshotFor(persona.personaId);
      const active = snap.holdings.filter((h) => h.shares > 0);
      if (active.length) {
        lines.push("Live Stock Holdings:");
        for (const h of active.slice(0, 8)) {
          const mv = h.shares * h.priceCents;
          const pl = (h.priceCents - h.avgCostCents) * h.shares;
          lines.push(`- ${h.symbol} (${h.name}): ${h.shares} sh, avg ${fmtUsdCents(h.avgCostCents)}, price ${fmtUsdCents(h.priceCents)}, value ${fmtUsdCents(mv)}, P/L ${pl >= 0 ? "+" : ""}${fmtUsdCents(pl)}`);
        }
      }
    }
    sections.push(`GROUNDED CUSTOMER 360 & PORTFOLIO DATA:\n${lines.join("\n")}`);
  } else if (profileSummary?.trim()) {
    hasCustomerData = true;
    sections.push(`GROUNDED CUSTOMER SUMMARY:\n${profileSummary.trim()}`);
  }

  const hasRecentContext = Boolean(recentContext?.trim());
  if (hasRecentContext) {
    sections.push(`RECENT CONVERSATION CONTEXT:\n${recentContext!.trim().slice(0, 2600)}`);
  }

  return { hasCustomerData, hasRecentContext, text: sections.join("\n\n") };
}

function synthesizeGroundedCustomerCanvas(
  prompt: string,
  personaId?: string,
  tradeStore?: TradeStore,
  recentContext?: string,
): { intro: string; canvas: DynamicCanvasProps } | null {
  const lower = prompt.toLowerCase();
  if (unconnectedExternalSourceTrigger.test(lower)) return null;
  const persona = personaId ? findProfileById(personaId) : undefined;
  if (!persona) return null;
  if (!groundedCustomerDataTrigger.test(lower)) return null;

  const totalCents = persona.cashCents + persona.equityCents + persona.fixedIncomeCents;
  const investedCents = persona.equityCents + persona.fixedIncomeCents;
  const pctNum = (part: number) => totalCents > 0 ? Math.round((part / totalCents) * 1000) / 10 : 0;
  const stocksPct = pctNum(persona.equityCents);
  const fixedPct = pctNum(persona.fixedIncomeCents);
  const cashPct = pctNum(persona.cashCents);
  const hasGoal = persona.homeGoalTargetCents > 0;
  const goalPct = hasGoal
    ? Math.min(100, Math.round((persona.homeGoalSavedCents / Math.max(1, persona.homeGoalTargetCents)) * 100))
    : 0;

  const isBulletSummary = /\b(bullet\s+points?|summarize|summary\s+in\s+\d+|tl;dr|key\s+takeaways?)\b/i.test(lower)
    && !/\b(table|matrix|chart|bar\s+chart)\b/i.test(lower);
  const wantsHoldings = /\b(holdings?|stocks?|tickers?|positions?|shares?)\b/i.test(lower) && Boolean(tradeStore);

  const nodes: DynamicCanvasNode[] = [
    {
      type: "metrics",
      items: [
        { label: "Total Portfolio", value: fmtUsdCents(totalCents), delta: persona.accountFundingStatus === "funded" ? "Funded" : "Unfunded" },
        { label: "Invested", value: fmtUsdCents(investedCents), delta: `${(stocksPct + fixedPct).toFixed(1)}% of total` },
        { label: "Cash", value: fmtUsdCents(persona.cashCents), delta: `${cashPct.toFixed(1)}% liquid` },
        ...(hasGoal
          ? [{ label: "Home Goal", value: `${goalPct}%`, delta: `${fmtUsdCents(persona.homeGoalSavedCents)} / ${fmtUsdCents(persona.homeGoalTargetCents)}` }]
          : [{ label: "Available Balance", value: fmtUsdCents(persona.availableBalanceCents), delta: `Current ${fmtUsdCents(persona.currentBalanceCents)}` }]),
      ],
    },
  ];

  if (isBulletSummary) {
    const bullets: string[] = [
      `Total portfolio is ${fmtUsdCents(totalCents)}: ${fmtUsdCents(investedCents)} invested (${stocksPct}% stocks, ${fixedPct}% fixed income) and ${fmtUsdCents(persona.cashCents)} (${cashPct}%) held in cash.`,
      hasGoal
        ? `Home savings goal is ${goalPct}% funded (${fmtUsdCents(persona.homeGoalSavedCents)} of ${fmtUsdCents(persona.homeGoalTargetCents)}, with ${fmtUsdCents(Math.max(0, persona.homeGoalTargetCents - persona.homeGoalSavedCents))} remaining).`
        : `Available balance is ${fmtUsdCents(persona.availableBalanceCents)} versus ${fmtUsdCents(persona.currentBalanceCents)} current balance.`,
      cashPct >= 20
        ? `Cash is ${cashPct}% of your portfolio (${fmtUsdCents(persona.cashCents)}) — consider exploring investing options or modeling cash deployment.`
        : persona.beneficiaryStatus === "missing"
          ? "Beneficiary designations are currently missing and ready to update."
          : "Account funding and beneficiary designations are up to date.",
    ];
    nodes.push({
      type: "checklist",
      title: "3-Point Portfolio Summary",
      items: bullets,
    });
    return {
      intro: `Here is a concise 3-point summary of ${persona.displayName}'s live portfolio and account status.`,
      canvas: {
        title: "Portfolio & Account Summary",
        badge: "Dynamic Summary",
        subtitle: `${persona.displayName} · Grounded in Customer 360`,
        generatedBy: "synthesizer",
        dataSource: "Customer 360 + Live Portfolio Snapshot",
        prompt: prompt.slice(0, 600),
        nodes,
        disclaimer: "Figures reflect live Customer 360 balances and portfolio snapshot data.",
        suggestedFollowUp: "Show my portfolio summary as a comparison table",
      },
    };
  }

  const rows: string[][] = [
    ["Stocks / Equities", fmtUsdCents(persona.equityCents), `${stocksPct}%`, "Long-term growth allocation"],
    ["Fixed Income", fmtUsdCents(persona.fixedIncomeCents), `${fixedPct}%`, "Stability & income allocation"],
    ["Cash", fmtUsdCents(persona.cashCents), `${cashPct}%`, cashPct >= 20 ? "Above target — ready to deploy" : "Liquid reserve"],
    ["Available vs Current", fmtUsdCents(persona.availableBalanceCents), `Current ${fmtUsdCents(persona.currentBalanceCents)}`, persona.accountFundingStatus === "funded" ? "Funded & active" : "Awaiting deposit"],
  ];
  if (hasGoal) {
    rows.push([
      "Home Savings Goal",
      fmtUsdCents(persona.homeGoalSavedCents),
      `${goalPct}% of ${fmtUsdCents(persona.homeGoalTargetCents)}`,
      `${fmtUsdCents(Math.max(0, persona.homeGoalTargetCents - persona.homeGoalSavedCents))} remaining`,
    ]);
  }
  rows.push([
    "Beneficiaries",
    persona.beneficiaryStatus === "on_file" ? "On file" : "Missing",
    persona.segment || "Member",
    persona.beneficiaryStatus === "on_file" ? "Complete" : "Action recommended",
  ]);

  nodes.push({
    type: "table",
    caption: `${persona.displayName} — Live Portfolio & Account Comparison`,
    columns: ["Category", "Amount / Value", "Share / Progress", "Status & Role"],
    rows,
  });

  if (totalCents > 0) {
    nodes.push({
      type: "barchart",
      title: "Live Asset Allocation Breakdown",
      unit: "usd",
      bars: [
        { label: `Stocks (${stocksPct}%)`, value: Math.round(persona.equityCents / 100), displayValue: fmtUsdCents(persona.equityCents), highlight: true },
        { label: `Cash (${cashPct}%)`, value: Math.round(persona.cashCents / 100), displayValue: fmtUsdCents(persona.cashCents) },
        { label: `Fixed Income (${fixedPct}%)`, value: Math.round(persona.fixedIncomeCents / 100), displayValue: fmtUsdCents(persona.fixedIncomeCents) },
      ],
    });
  }

  if (wantsHoldings && tradeStore) {
    const snap = tradeStore.snapshotFor(persona.personaId);
    const active = snap.holdings.filter((h) => h.shares > 0).slice(0, 6);
    if (active.length) {
      nodes.push({
        type: "table",
        caption: "Top Equity Positions",
        columns: ["Symbol", "Shares", "Market Value", "Unrealized P/L"],
        rows: active.map((h) => {
          const mv = h.shares * h.priceCents;
          const pl = (h.priceCents - h.avgCostCents) * h.shares;
          return [h.symbol, String(h.shares), fmtUsdCents(mv), `${pl >= 0 ? "+" : ""}${fmtUsdCents(pl)}`];
        }),
      });
    }
  } else if (hasGoal) {
    nodes.push({
      type: "progress",
      label: "Home down-payment goal",
      current: Math.round(persona.homeGoalSavedCents / 100),
      target: Math.round(persona.homeGoalTargetCents / 100),
      currentDisplay: fmtUsdCents(persona.homeGoalSavedCents),
      targetDisplay: fmtUsdCents(persona.homeGoalTargetCents),
    });
  }

  return {
    intro: `Here is ${persona.displayName}'s live portfolio summary organized as a structured comparison table (${fmtUsdCents(totalCents)} total value: ${stocksPct}% stocks, ${fixedPct}% fixed income, ${cashPct}% cash).`,
    canvas: {
      title: "Portfolio Summary Comparison Table",
      badge: "Dynamic Table",
      subtitle: `${persona.displayName} · Grounded in live Customer 360 balances`,
      generatedBy: "synthesizer",
      dataSource: "Customer 360 + Live Portfolio Snapshot",
      prompt: prompt.slice(0, 600),
      nodes,
      disclaimer: "Figures reflect live Customer 360 balances and portfolio snapshot data.",
      suggestedFollowUp: "Simulate deploying cash into my portfolio",
    },
  };
}

const groundedCanvasSystemPrompt = [
  "You are CEP Dynamic UI Composer. Compose a clean, grounded, schema-valid interactive UI canvas from the user's request and the provided GROUNDED DATA / RECENT CONVERSATION.",
  "STRICT GROUNDING RULES:",
  "1. Use ONLY exact numbers, holdings, balances, and facts present in GROUNDED CUSTOMER 360 & PORTFOLIO DATA or RECENT CONVERSATION CONTEXT. Never fabricate external enterprise records.",
  "2. If the user asks for records from an external system that is NOT connected in the provided data (e.g., Jira tickets, Snowflake warehouse rows, Salesforce contacts, SAP invoices, live weather), return ONLY: { \"needsDataSource\": true, \"missingSource\": \"short name of missing system\" }.",
  "3. Otherwise, compose the best visual layout matching the user's request (e.g., a crisp comparison 'table' when asked for a table, 'barchart' when asked for a chart, 'checklist' when asked for bullet points/summary, 'comparison' for 2-column tradeoffs, 'sliders' for calculators/simulators, 'metrics' for key KPIs).",
  "4. Never mention any external brokerage or company names; refer to the platform only as CEP.",
  "Return ONE JSON object matching this exact shape:",
  JSON.stringify({
    intro: "1-2 concise sentences summarizing what the dynamic view shows.",
    canvas: {
      title: "Short headline (max 90 chars)",
      badge: "Short badge like 'Dynamic Table' or 'Portfolio Comparison' (max 40 chars)",
      subtitle: "Optional concise subtitle (max 200 chars)",
      generatedBy: "llm",
      dataSource: "Customer 360 + Live Portfolio Snapshot",
      nodes: [
        "1 to 5 nodes using ONLY these exact shapes:",
        "{ type: 'metrics', items: [{ label, value, delta? }] } (1-4 items)",
        "{ type: 'table', caption?, columns: [2..5 strings], rows: [[2..5 strings matching columns length]] } (1-10 rows)",
        "{ type: 'barchart', title?, unit?: 'usd'|'percent'|'number', bars: [{ label, value: number>=0, displayValue, highlight?: boolean }] } (2-8 bars)",
        "{ type: 'progress', label, current: number>=0, target: number>0, currentDisplay, targetDisplay }",
        "{ type: 'sliders', title?, formula: 'compound_monthly'|'annual_yield'|'simple_total', resultLabel, inputs: [{ id: 'amount'|'monthly'|'rate'|'years', label, min, max, step, value, unit: 'usd'|'percent'|'years' }] }",
        "{ type: 'comparison', columns: [{ title, points: [1..6 strings] }, { title, points: [1..6 strings] }] }",
        "{ type: 'checklist', title?, items: [1..8 strings] }",
        "{ type: 'callout', tone: 'info'|'highlight'|'caution', title?, body }",
      ],
      disclaimer: "Grounded in live Customer 360 balances and recent conversation context.",
      suggestedFollowUp: "Optional short follow-up prompt",
    },
  }),
].join("\n");

async function composeDynamicCanvasWithLlm(input: {
  prompt: string;
  groundedContext: string;
  gateway: GatewaySettings;
  dataDir: string;
  signal?: AbortSignal;
}): Promise<{ intro: string; canvas: DynamicCanvasProps } | { needsDataSource: true; missingSource?: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 14_000);
  timer.unref();
  const onParentAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    const userPrompt = input.groundedContext
      ? `${input.groundedContext}\n\nUSER VIEW REQUEST:\n${input.prompt}`
      : `USER VIEW REQUEST:\n${input.prompt}`;
    const raw = await callConfiguredLlmJson(
      input.gateway,
      input.dataDir,
      groundedCanvasSystemPrompt,
      userPrompt,
      controller.signal,
      undefined,
      { ...(getLlmEgressContext(input.dataDir) ?? {}), operation: "dynamic_ui_compose" },
    );
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    if (obj.needsDataSource === true) {
      return { needsDataSource: true, missingSource: typeof obj.missingSource === "string" ? obj.missingSource : undefined };
    }
    const rawCanvas = obj.canvas && typeof obj.canvas === "object" ? (obj.canvas as Record<string, unknown>) : null;
    if (!rawCanvas) return null;
    const candidate = {
      ...rawCanvas,
      generatedBy: "llm",
      prompt: input.prompt.slice(0, 600),
      disclaimer: typeof rawCanvas.disclaimer === "string" && rawCanvas.disclaimer.trim()
        ? rawCanvas.disclaimer.trim().slice(0, 240)
        : "Grounded in live Customer 360 data and conversation context.",
    };
    const parsed = dynamicCanvasSchema.safeParse(candidate);
    if (!parsed.success) return null;
    const intro = typeof obj.intro === "string" && obj.intro.trim()
      ? obj.intro.trim().slice(0, 400)
      : `Here is your dynamically composed view for "${parsed.data.title}".`;
    return { intro, canvas: parsed.data };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onParentAbort);
  }
}

export function synthesizeDynamicCanvas(
  prompt: string,
  profileSummary?: string,
  opsStore?: OpsIncidentStore,
  salesStore?: SalesDealStore,
  capabilityId?: string,
  personaId?: string,
  tradeStore?: TradeStore,
  recentContext?: string,
): { intro: string; canvas: DynamicCanvasProps } {
  const widget = generateWidgetFromText(prompt);
  const lower = prompt.toLowerCase();
  const nodes: DynamicCanvasNode[] = [];
  let customBadge: string | undefined;
  let customFollowUp: string | undefined;
  let dataSource: string | undefined;
  let recordId: string | undefined;
  let customTitle: string | undefined;
  let customSubtitle: string | undefined;
  let customDisclaimer: string | undefined;

  if (opsStore && (capabilityId === "ops_incident" || isOpsIncidentPrompt(prompt))) {
    const view = opsStore.view();
    const matches = matchingIncidents(prompt, view.incidents);
    if (matches.length !== 1) return recordChoices(prompt, "Incident lookup", view.summary.sourceLabel, matches.map((i) => ({ id: i.id, label: i.service })));
    const primary = matches[0];
    const statusLabel = primary.status.replace("_", " ").toUpperCase();
    dataSource = view.summary.sourceLabel;
    recordId = primary.id;
    customBadge = `IT Operations · ${primary.id}`;
    customTitle = `${primary.id}: ${primary.title}`.slice(0, 96);
    customSubtitle = `${primary.service} · ${primary.environment} · ${statusLabel} · Owner: ${primary.owner}`.slice(0, 160);
    customDisclaimer = "Source: " + view.summary.sourceLabel;
    customFollowUp = primary.rollbackStatus === "pending"
      ? `Show the incident timeline for ${primary.id}`
      : `Show the current status of ${primary.id}`;

    const isTimelineFocus = isRecordTimeline(prompt, "ops_incident");
    nodes.push({
      type: "metrics",
      items: [
        { label: "Severity & Status", value: `${primary.severity} · ${statusLabel}`, delta: `SLA ${primary.slaMinutes}m` },
        { label: "Error Rate", value: `${primary.errorRatePct}%`, delta: `Baseline ${primary.baselineErrorRatePct}%` },
        { label: "p95 Latency", value: `${primary.p95LatencyMs}ms`, delta: `${primary.affectedUsers.toLocaleString("en-US")} affected` },
        { label: "Open Queue", value: `${view.summary.totalOpen} active`, delta: `${view.summary.activeP1Count} P1 open` },
      ],
    });
    if (isTimelineFocus || primary.rollbackStatus !== "pending") {
      nodes.push({
        type: "timeline",
        title: `${primary.id} Live Incident Timeline`,
        events: primary.timeline.slice(0, 8),
      });
    } else {
      nodes.push({
        type: "approval",
        title: `Production Rollback · ${primary.id} (${primary.currentRelease} → ${primary.previousRelease})`,
        summary: primary.summary,
        requester: primary.owner,
        riskLevel: primary.severity === "P1" ? "high" : "medium",
        details: [
          { label: "Incident ID", value: primary.id },
          { label: "Target Environment", value: primary.environment },
          { label: "Release Action", value: `Revert ${primary.currentRelease} → ${primary.previousRelease}` },
          { label: "Current Error Rate", value: `${primary.errorRatePct}% (p95 ${primary.p95LatencyMs}ms)` },
        ],
        approveLabel: "Approve rollback",
        rejectLabel: "Hold & investigate",
        recordId: primary.id,
        domain: "ops_incident",
        expectedUpdatedAt: primary.updatedAt,
        initialDecision: "pending",
        ...(primary.rollbackNote ? { decisionNote: primary.rollbackNote } : {}),
      });
    }
    if (/\b(queue|all incidents)\b/i.test(prompt)) nodes.push({
      type: "table",
      caption: "Incident queue",
      columns: ["Incident", "Sev", "Service", "Error Rate", "Status"],
      rows: view.incidents.slice(0, 6).map((inc) => [
        inc.id,
        inc.severity,
        inc.service,
        `${inc.errorRatePct}%`,
        inc.status.replace("_", " "),
      ]),
    });
    if (!isTimelineFocus) {
      nodes.push({
        type: "timeline",
        title: `${primary.id} Live Timeline`,
        events: primary.timeline.slice(-4),
      });
    }
  } else if (salesStore && (capabilityId === "sales_deal_desk" || isSalesDealPrompt(prompt))) {
    const view = salesStore.view();
    const matches = matchingDeals(prompt, view.deals);
    const pipeline = /\b(pipeline|forecast)\b/i.test(prompt) && !/\bDEAL-[\w-]+\b/i.test(prompt);
    if (matches.length !== 1) {
      const selection = recordChoices(prompt, pipeline ? "Sales pipeline" : "Deal lookup", view.summary.sourceLabel, matches.map((d) => ({ id: d.id, label: d.accountName })));
      if (pipeline && matches.length) return { ...selection, intro: "Here is the pipeline by account.", canvas: { ...selection.canvas, nodes: [{
        type: "barchart", unit: "usd", title: "Annual recurring revenue", bars: matches.slice(0, 8).map((d) => ({ label: d.accountName, value: d.arrUsd, displayValue: "$" + d.arrUsd.toLocaleString("en-US") })),
      }] } };
      return selection;
    }
    const primary = matches[0];
    const usdFmt = (n: number) => `$${n.toLocaleString("en-US")}`;
    dataSource = view.summary.sourceLabel;
    recordId = primary.id;
    customBadge = `RevOps · ${primary.id}`;
    customTitle = `${primary.accountName} · ${primary.id}`.slice(0, 96);
    customSubtitle = `${primary.title} · Stage: ${primary.stage} · Close ${primary.closeDate}`;
    customDisclaimer = "Source: " + view.summary.sourceLabel;
    customFollowUp = "Show the timeline for " + primary.id;

    const isTimelineFocus = isRecordTimeline(prompt, "sales_deal_desk");
    const isPipelineFocus = /\b(pipeline|bar chart|chart)\b/.test(lower);
    nodes.push({
      type: "metrics",
      items: [
        { label: "Stage", value: primary.stage },
        { label: "Owner", value: primary.owner.slice(0, 36) },
        { label: "Discount", value: primary.discountPct + "%", delta: primary.discountStatus },
        { label: `${primary.id} ARR`, value: usdFmt(primary.arrUsd), delta: `${primary.winProbabilityPct}% · ${primary.stage}` },
      ],
    });
    if (isTimelineFocus || primary.discountStatus !== "pending") {
      nodes.push({ type: "callout", tone: "info", title: primary.stage, body: primary.summary });
      nodes.push({
        type: "timeline",
        title: `${primary.accountName} Mutual Action Plan`,
        events: primary.timeline.slice(0, 8),
      });
    } else if (isPipelineFocus && pipeline) {
      nodes.push({
        type: "barchart",
        title: "Live Pipeline by Account (ARR)",
        unit: "usd",
        bars: view.deals.map((d) => ({
          label: `${d.accountName} (${d.stage})`,
          value: d.arrUsd,
          displayValue: usdFmt(d.arrUsd),
          highlight: d.id === primary.id,
        })),
      });
    } else {
      nodes.push({
        type: "approval",
        title: `Discount Approval · ${primary.accountName} (${primary.discountPct}% off)`,
        summary: primary.summary,
        requester: primary.owner,
        riskLevel: primary.discountPct > 15 ? "medium" : "low",
        details: [
          { label: "Deal ID", value: primary.id },
          { label: "Annual Value (ARR)", value: usdFmt(primary.arrUsd) },
          { label: "Current Stage", value: `${primary.stage} (${primary.winProbabilityPct}% prob.)` },
          { label: "Discount Requested", value: `${primary.discountPct}% (Standard cap: 15%)` },
        ],
        approveLabel: "Approve discount",
        rejectLabel: "Hold & counter-offer",
        recordId: primary.id,
        domain: "sales_deal",
        expectedUpdatedAt: primary.updatedAt,
        initialDecision: "pending",
        ...(primary.discountNote ? { decisionNote: primary.discountNote } : {}),
      });
    }
    if (pipeline) nodes.push({
      type: "table",
      caption: "Sales pipeline",
      columns: ["Deal", "Account", "Stage", "ARR", "Discount"],
      rows: view.deals.map((d) => [
        d.id,
        d.accountName,
        d.stage,
        usdFmt(d.arrUsd),
        `${d.discountPct}% (${d.discountStatus})`,
      ]),
    });
  } else if (/\b(form|intake|request|application|survey|onboarding form|pto|expense)\b/.test(lower)) {
    customBadge = "Interactive Form";
    customFollowUp = "Create an approval card to review submitted requests";
    nodes.push({
      type: "form",
      title: widget.title,
      submitLabel: "Submit request",
      fields: [
        { id: "title", label: "Request title", type: "text", placeholder: "Short summary...", required: true },
        { id: "category", label: "Category", type: "select", required: true, options: ["Operations", "Engineering", "Finance & Ops", "HR / People"] },
        { id: "priority", label: "Priority", type: "select", required: true, options: ["Standard", "High", "Urgent"] },
        { id: "target_date", label: "Target date", type: "date", required: false },
        { id: "confirm", label: "Confirm manager / policy review completed", type: "checkbox", required: true },
      ],
    });
    nodes.push({
      type: "callout",
      tone: "info",
      title: "Governed submission",
      body: "Submitted details are validated and logged into the conversation audit trail automatically.",
    });
  } else if (/\b(calculator|simulator|simulate|calculate|project)\b/i.test(prompt) && widget.kind === "calculator" && widget.sliders?.length) {
    nodes.push({
      type: "sliders",
      title: "Adjust assumptions live",
      formula: /yield|income|dividend/i.test(lower) ? "annual_yield" : "compound_monthly",
      resultLabel: /yield|income|dividend/i.test(lower) ? "Estimated annual income" : "Projected future value",
      inputs: widget.sliders.map((s) => ({
        id: s.id === "monthly" ? "monthly" : s.id === "rate" ? "rate" : s.id === "years" ? "years" : "amount",
        label: s.label,
        min: s.min,
        max: s.max,
        step: s.step,
        value: s.value,
        unit: s.unit === "months" ? "years" : s.unit,
      })),
    });
  } else {
    const grounded = synthesizeGroundedCustomerCanvas(prompt, personaId, tradeStore, recentContext);
    if (grounded) return grounded;
    const intro = "I don’t have a connected data source for that view. Which source should supply the records?";
    return { intro, canvas: { title: "Data source needed", badge: "Data availability", generatedBy: "synthesizer",
      nodes: [{ type: "callout", tone: "info", body: intro }], disclaimer: "No records were loaded." } };
  }

  return {
    intro: dataSource
      ? `Here are the details for ${customTitle ?? widget.title}.`
      : `I composed a custom interactive view for "${widget.title}". You can interact with it below or save it directly to your Widget Library.`,
    canvas: {
      title: customTitle ?? widget.title,
      badge: customBadge ?? widget.badge,
      subtitle: customSubtitle ?? widget.body,
      generatedBy: "synthesizer",
      ...(dataSource ? { dataSource } : {}),
      ...(recordId ? { recordId } : {}),
      prompt: prompt.slice(0, 600),
      nodes,
      disclaimer: customDisclaimer ?? "Illustrative dynamic UI generated for exploration and operational review.",
      suggestedFollowUp: customFollowUp,
    },
  };
}

function buildApprovalQueueCanvas(approvalStore: ApprovalStore, prompt: string): { intro: string; canvas: DynamicCanvasProps } {
  const view = approvalStore.view();
  const pending = view.approvals.filter((a) => a.status === "pending");
  const decided = view.approvals.filter((a) => a.status !== "pending").slice(0, 6);
  const nodes: DynamicCanvasNode[] = [
    {
      type: "metrics",
      items: [
        { label: "Pending Approvals", value: String(view.pendingCount), delta: "Live sfield HITL queue" },
        { label: "Approval Mode", value: view.policy.defaultDualControl ? "4-Eyes Dual Control" : "Inline Chat Allowed", delta: "/admin/logs?source=approvals" },
        { label: "Total Logged", value: String(view.approvals.length), delta: "SHA-256 digest bound" },
      ],
    },
  ];
  if (pending.length === 0) {
    nodes.push({
      type: "callout",
      tone: "info",
      title: "Approval queue is clear",
      body: "No high-risk sfield writes or external connector calls are currently awaiting approval. Trigger an external connector (for example, \"invoke PagerDuty connector\") or enable 4-eyes dual control in /admin/logs?source=approvals to queue new approvals.",
    });
  } else {
    for (const item of pending.slice(0, 3)) {
      nodes.push({
        type: "approval",
        title: item.title,
        summary: item.summary,
        requester: item.requester,
        riskLevel: item.riskLevel,
        details: item.details,
        approveLabel: "Approve & execute",
        rejectLabel: "Deny request",
        recordId: item.recordId,
        domain: item.domain === "customer360" || item.domain === "pzn_self_service" || item.domain === "integration" ? "generic" : item.domain,
        approvalId: item.id,
        payloadDigest: item.payloadDigest,
        dualControl: item.dualControl,
        sfieldToolRef: item.sfieldToolRef,
        initialDecision: "pending",
      });
    }
  }
  if (decided.length > 0) {
    nodes.push({
      type: "table",
      caption: "Recent Approval Decisions",
      columns: ["Approval ID", "Target", "Status", "Approver"],
      rows: decided.map((a) => [
        a.id,
        `${a.domain}:${a.recordId}`,
        a.status,
        a.decidedBy ?? "—",
      ]),
    });
  }
  return {
    intro: pending.length > 0
      ? `There ${pending.length === 1 ? "is 1 pending high-risk action" : `are ${pending.length} pending high-risk actions`} awaiting human approval. You can approve or deny directly in Chat below or from /admin/logs?source=approvals.`
      : "Your live Human-in-the-Loop approval queue is currently clear.",
    canvas: {
      title: "Human-in-the-Loop Approval Queue",
      badge: "sfield HITL · Live Queue",
      subtitle: `${view.pendingCount} pending · Synchronized live with /admin/logs?source=approvals`,
      generatedBy: "synthesizer",
      dataSource: "approvals.json (sfield HITL)",
      prompt,
      nodes,
      disclaimer: "Approvals are cryptographically bound to the prepared SHA-256 payload digest and execute through governed sfield write tools with immutable Write Audit logging.",
      suggestedFollowUp: pending.length > 0 ? "Show pending approvals" : "Invoke PagerDuty connector for INC-4821",
    },
  };
}

function buildConnectorActionCanvas(
  connectorStore: ConnectorStore,
  approvalStore: ApprovalStore,
  prompt: string,
  requesterName?: string,
): { intro: string; canvas: DynamicCanvasProps } {
  const connectors = connectorStore.list();
  const enabledAction = connectors.find((c) => c.enabled && (c.kind === "rest_action" || c.kind === "mcp_bridge"))
    ?? connectors.find((c) => c.enabled)
    ?? connectors[0];

  if (!enabledAction) {
    return {
      intro: "No external connectors are registered yet. Register a connector in /admin to invoke it via sfield.",
      canvas: {
        title: "External Connectors",
        badge: "Connector Registry",
        generatedBy: "synthesizer",
        prompt,
        nodes: [{ type: "callout", tone: "caution", title: "No connectors configured", body: "Open Tool setup (/admin) to register and enable an external REST or MCP connector." }],
        disclaimer: "External connectors run under sfield governance via cep.connector.invoke@1.0.0.",
      },
    };
  }

  const requester = requesterName || "CEP Operator";
  const action = /\bescalat/i.test(prompt) ? "escalate_incident" : /\brollback/i.test(prompt) ? "notify_rollback" : "trigger_incident_webhook";
  const approval = approvalStore.createPending({
    targetKind: "external_connector",
    sfieldToolRef: connectorInvokeToolRef,
    domain: "external_connector",
    recordId: enabledAction.id,
    action,
    title: `External Connector · ${enabledAction.name}`,
    summary: `Prepared governed sfield call (${connectorInvokeToolRef}) for "${action}" against ${enabledAction.method} ${enabledAction.url}.`,
    riskLevel: enabledAction.effect === "write" ? "high" : "medium",
    payload: { prompt, connectorId: enabledAction.id, action, triggeredFrom: "chat" },
    details: [
      { label: "Connector", value: enabledAction.name },
      { label: "Endpoint", value: `${enabledAction.method} ${enabledAction.url}` },
      { label: "Action", value: action },
      { label: "sfield Tool", value: connectorInvokeToolRef },
      { label: "4-Eyes Dual Control", value: (enabledAction.dualControl || approvalStore.getPolicy().defaultDualControl) ? "Required" : "Inline allowed" },
    ],
    requester,
    dualControl: enabledAction.dualControl || approvalStore.getPolicy().defaultDualControl,
  });

  return {
    intro: `Prepared an external connector call to **${enabledAction.name}** via \`${connectorInvokeToolRef}\`. Because this connector is gated by HITL approval policy, review and approve it right here in Chat or from \`/admin/logs?source=approvals\`.`,
    canvas: {
      title: `External Connector Execution · ${enabledAction.name}`.slice(0, 96),
      badge: "sfield Connector · HITL",
      subtitle: `${enabledAction.method} ${enabledAction.url} · Approval ID ${approval.id}`,
      generatedBy: "synthesizer",
      dataSource: "connectors.json + approvals.json",
      recordId: enabledAction.id,
      prompt,
      nodes: [
        {
          type: "approval",
          title: approval.title,
          summary: approval.summary,
          requester: approval.requester,
          riskLevel: approval.riskLevel,
          details: approval.details,
          approveLabel: "Approve & invoke",
          rejectLabel: "Deny invocation",
          recordId: approval.recordId,
          domain: "external_connector",
          approvalId: approval.id,
          payloadDigest: approval.payloadDigest,
          dualControl: approval.dualControl,
          sfieldToolRef: approval.sfieldToolRef,
          initialDecision: "pending",
        },
        {
          type: "table",
          caption: "Registered External Connectors",
          columns: ["Connector", "Kind", "Effect", "Status"],
          rows: connectors.slice(0, 6).map((c) => [
            c.name,
            c.kind,
            c.effect,
            c.enabled ? (c.requiresApproval ? "enabled (HITL)" : "enabled") : "disabled",
          ]),
        },
      ],
      disclaimer: "External connector calls execute through sfield cep.connector.invoke@1.0.0 with timeout enforcement, payload digest validation, and immutable Write Audit logging.",
      suggestedFollowUp: "Show pending approvals",
    },
  };
}

function buildActionFlowCanvas(
  flow: ActionFlow,
  connectorStore: ConnectorStore | undefined,
  approvalStore: ApprovalStore | undefined,
  requesterName: string | undefined,
  prompt: string,
): { intro: string; canvas: DynamicCanvasProps } {
  const requester = requesterName || "CEP Operator";
  const conn = flow.connectorId ? connectorStore?.findById(flow.connectorId) : undefined;
  const action = flow.connectorAction || "trigger_action_flow";
  const dualControl = flow.approvalMode === "hitl_4eyes";
  const requiresApproval = flow.approvalMode !== "auto_execute";

  if (requiresApproval && approvalStore) {
    const approval = approvalStore.createPending({
      targetKind: flow.targetKind === "external_connector" && conn ? "external_connector" : "domain_write",
      sfieldToolRef: flow.targetKind === "external_connector" ? connectorInvokeToolRef : domainWriteToolRef,
      domain: flow.targetKind === "external_connector" ? "external_connector" : "customer360",
      recordId: conn?.id ?? flow.id,
      action,
      title: `No-Code Flow · ${flow.name}`,
      summary: `${flow.description} (Policy: ${dualControl ? "4-eyes separate approver" : "inline Chat approval"}).`,
      riskLevel: dualControl ? "high" : "medium",
      payload: { flowId: flow.id, prompt, action, connectorId: conn?.id },
      details: [
        { label: "Action Flow", value: flow.name },
        { label: "Domain", value: flow.domain },
        { label: "Bound Target", value: conn ? `${conn.name} (${conn.url})` : flow.targetKind },
        { label: "Action", value: action },
        { label: "Approval Policy", value: dualControl ? "4-Eyes Dual Control" : "Inline HITL Approval" },
      ],
      requester,
      dualControl,
    });
    return {
      intro: `Matched admin-authored No-Code Action Flow **${flow.name}**. Review the prepared SHA-256 digest and approve inline below or in \`/admin/logs?source=approvals\`.`,
      canvas: {
        title: `No-Code Flow · ${flow.name}`.slice(0, 96),
        badge: `Action Flow · ${flow.domain}`,
        subtitle: `Approval ${approval.id} · ${dualControl ? "4-eyes dual control" : "inline approval"}`,
        generatedBy: "synthesizer",
        dataSource: "action-flows.json + approvals.json",
        recordId: flow.id,
        prompt,
        nodes: [
          {
            type: "approval",
            title: approval.title,
            summary: approval.summary,
            requester: approval.requester,
            riskLevel: approval.riskLevel,
            details: approval.details,
            approveLabel: "Approve & run flow",
            rejectLabel: "Deny flow",
            recordId: approval.recordId,
            domain: approval.domain === "customer360" || approval.domain === "pzn_self_service" || approval.domain === "integration" ? "generic" : approval.domain,
            approvalId: approval.id,
            payloadDigest: approval.payloadDigest,
            dualControl: approval.dualControl,
            sfieldToolRef: approval.sfieldToolRef,
            initialDecision: "pending",
          },
        ],
        disclaimer: "Authored declaratively in /admin/intents (Action Flows) with zero code deploys. Governed by sfield and logged to Write Audit.",
        suggestedFollowUp: "Show pending approvals",
      },
    };
  }

  return {
    intro: `Matched No-Code Action Flow **${flow.name}** (${flow.description}).`,
    canvas: {
      title: flow.name,
      badge: `Action Flow · ${flow.domain}`,
      generatedBy: "synthesizer",
      dataSource: "action-flows.json",
      prompt,
      nodes: [
        {
          type: "callout",
          tone: "highlight",
          title: `Bound to ${conn?.name ?? flow.targetKind}`,
          body: `${flow.description} (Policy: ${flow.approvalMode}).`,
        },
      ],
      disclaimer: "Authored declaratively in /admin/intents (Action Flows).",
    },
  };
}

function buildStockTradeCanvas(
  tradeStore: TradeStore,
  personaId: string,
  requesterName: string | undefined,
  prompt: string,
  extractedParams?: SemanticRouteDecision["extractedParams"],
  options?: {
    conversationId?: string;
    initialStage?: "configure" | "tax_analysis" | "running";
    initialJobId?: string;
    overrideShares?: number;
    overrideSymbol?: string;
    overrideSide?: "buy" | "sell";
  },
): { intro: string; canvas: DynamicCanvasProps } {
  const lexical = parseStockTradePrompt(prompt);
  const parsed = {
    side: options?.overrideSide ?? extractedParams?.side ?? lexical.side,
    symbol: (options?.overrideSymbol ?? (extractedParams?.symbol ? extractedParams.symbol.toUpperCase() : lexical.symbol)),
    percent: extractedParams?.percent ?? lexical.percent,
    shares: options?.overrideShares ?? extractedParams?.shares ?? lexical.shares,
  };
  const snapshot = tradeStore.snapshotFor(personaId);
  const target = snapshot.holdings.find((h) => h.symbol === parsed.symbol) ?? snapshot.holdings[0];
  const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const marketValueCents = target.shares * target.priceCents;
  const unrealizedCents = (target.priceCents - target.avgCostCents) * target.shares;
  const unrealizedSign = unrealizedCents >= 0 ? "+" : "-";
  const resolvedShares = parsed.shares
    ?? (parsed.percent && target.shares > 0 ? Math.max(1, Math.round((target.shares * parsed.percent) / 100)) : Math.max(1, Math.round(target.shares * 0.25)));
  const washSaleWarnings = tradeStore.washSaleWarningsFor(personaId, target.symbol, parsed.side);

  if (options?.conversationId && options.initialStage !== "running") {
    tradeStore.setDraft({
      conversationId: options.conversationId,
      personaId,
      actorName: requesterName || "Customer",
      side: parsed.side,
      symbol: target.symbol,
      shares: Math.min(Math.max(1, resolvedShares), parsed.side === "sell" ? Math.max(1, target.shares) : resolvedShares),
      ...(parsed.percent ? { percent: parsed.percent } : {}),
      stage: options.initialStage === "tax_analysis" ? "awaiting_execution" : "awaiting_tax_choice",
      ...(options.initialStage === "tax_analysis" && parsed.side === "sell" && target.shares > 0
        ? { taxAnalysis: tradeStore.analyzeTaxHarvest(personaId, target.symbol, Math.min(resolvedShares, target.shares)) }
        : {}),
      updatedAt: Date.now(),
    });
  }

  const intro = options?.initialStage === "running" && options.initialJobId
    ? `Launched timed execution job **\`${options.initialJobId}\`** for your **${parsed.side.toUpperCase()} ${resolvedShares} ${target.symbol}** order. Watch the live SSE countdown below — you can cancel before settlement or wait for your updated balance & portfolio receipt.`
    : options?.initialStage === "tax_analysis"
      ? `Completed **Tax-Loss Harvesting analysis** for selling **${resolvedShares} shares of ${target.symbol}**. Review the recommended offsetting loss trades below — click **Execute bundle** or reply **"execute bundle"** in Chat to launch the timed job.`
      : parsed.side === "sell"
        ? `You currently hold **${target.shares} shares of ${target.name} (${target.symbol})** (${usd(marketValueCents)} at ${usd(target.priceCents)}/sh, avg cost ${usd(target.avgCostCents)}, unrealized ${unrealizedSign}${usd(Math.abs(unrealizedCents))}). Confirm the quantity or percentage below — or reply **"yes"** in Chat to run Tax-Loss Harvesting analysis, **"change to 50%"**, or **"execute now"**.`
        : `Your available cash is **${usd(snapshot.cashCents)}** and you currently hold **${target.shares} shares of ${target.name} (${target.symbol})** at ${usd(target.priceCents)}/sh. Choose how many shares to buy below and launch the timed execution job.`;

  return {
    intro,
    canvas: {
      title: `${parsed.side === "sell" ? "Sell" : "Buy"} ${target.name} (${target.symbol}) — Trade & Tax-Harvest Simulator`,
      badge: parsed.side === "sell" ? "Trade + Tax Harvesting" : "Stock Order Simulator",
      subtitle: `Existing position: ${target.shares} shares · Live price ${usd(target.priceCents)} · Cash ${usd(snapshot.cashCents)}`,
      generatedBy: "synthesizer",
      dataSource: "trades-portfolio.json + Customer 360 (sfield)",
      recordId: target.symbol,
      prompt,
      nodes: [
        {
          type: "trade_ticket",
          personaId,
          actorName: requesterName || "Customer",
          side: parsed.side,
          symbol: target.symbol,
          companyName: target.name,
          existingShares: target.shares,
          avgCostCents: target.avgCostCents,
          priceCents: target.priceCents,
          holdingPeriod: target.holdingPeriod,
          cashBalanceCents: snapshot.cashCents,
          equityTotalCents: snapshot.equityCents,
          fixedIncomeCents: snapshot.fixedIncomeCents,
          ...(parsed.percent ? { suggestedPercent: parsed.percent } : {}),
          ...(parsed.shares ? { suggestedShares: parsed.shares } : {}),
          askTaxHarvest: parsed.side === "sell",
          ...(options?.initialStage ? { initialStage: options.initialStage } : {}),
          ...(options?.initialJobId ? { initialJobId: options.initialJobId } : {}),
          ...(washSaleWarnings.length > 0 ? { washSaleWarnings } : {}),
          holdings: snapshot.holdings.map((h) => ({
            symbol: h.symbol,
            name: h.name,
            shares: h.shares,
            avgCostCents: h.avgCostCents,
            priceCents: h.priceCents,
          })),
        },
      ],
      disclaimer: "Simulated trade execution runs as a durable SSE-streamed timed job with cancellation, 30-day wash-sale tracking, and sfield settlement into Customer 360.",
      suggestedFollowUp: "Show all my stocks",
    },
  };
}

function buildStockHoldingsCanvas(
  tradeStore: TradeStore,
  personaId: string,
  prompt: string,
): { intro: string; canvas: DynamicCanvasProps } {
  const snapshot = tradeStore.snapshotFor(personaId);
  const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const activeHoldings = snapshot.holdings.filter((h) => h.shares > 0);
  const marketTotalCents = activeHoldings.reduce((sum, h) => sum + h.shares * h.priceCents, 0);
  const unrealizedTotalCents = activeHoldings.reduce((sum, h) => sum + (h.priceCents - h.avgCostCents) * h.shares, 0);
  const tlhCount = activeHoldings.filter((h) => h.priceCents < h.avgCostCents).length;
  const activeBars = activeHoldings
    .map((h) => ({
      label: `${h.symbol} (${h.shares} sh)`,
      value: Math.round((h.shares * h.priceCents) / 100),
      displayValue: usd(h.shares * h.priceCents),
      highlight: h.priceCents < h.avgCostCents,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  const nodes: DynamicCanvasNode[] = [
    {
      type: "metrics",
      items: [
        { label: "Active Positions", value: `${activeHoldings.length} stocks`, delta: `${tlhCount} tax-loss eligible` },
        { label: "Holdings Market Value", value: usd(marketTotalCents), delta: `${unrealizedTotalCents >= 0 ? "+" : ""}${usd(unrealizedTotalCents)} P/L` },
        { label: "Cash Balance", value: usd(snapshot.cashCents), delta: "Live Customer 360" },
        { label: "Total Portfolio", value: usd(snapshot.totalCents), delta: `Fixed income ${usd(snapshot.fixedIncomeCents)}` },
      ],
    },
    {
      type: "table",
      caption: "Live Stock Holdings & Cost Basis (trades-portfolio.json)",
      columns: ["Stock", "Shares", "Avg Cost → Price", "Market Value", "Unrealized P/L"],
      rows: snapshot.holdings.map((h) => {
        const mv = h.shares * h.priceCents;
        const pl = (h.priceCents - h.avgCostCents) * h.shares;
        const plText = h.shares === 0
          ? "Closed (0 sh)"
          : `${pl >= 0 ? "+" : ""}${usd(pl)}${pl < 0 ? " (TLH)" : ""}`;
        return [
          `${h.symbol} · ${h.name}`,
          `${h.shares} sh`,
          `${usd(h.avgCostCents)} → ${usd(h.priceCents)}`,
          usd(mv),
          plText,
        ];
      }),
    },
  ];

  if (activeBars.length >= 2) {
    nodes.push({
      type: "barchart",
      title: "Equity Allocation by Stock (highlighted = unrealized loss / TLH candidate)",
      unit: "usd",
      bars: activeBars,
    });
  }

  const recentBuys = tradeStore.recentlyBoughtSymbols(personaId);
  const recentBuyNote = recentBuys.size > 0
    ? ` Recent purchase${recentBuys.size === 1 ? "" : "s"} (${[...recentBuys].join(", ")}) are reflected above.`
    : "";

  return {
    intro: `Here are all **${activeHoldings.length} active stock positions** in your live portfolio (${usd(marketTotalCents)} total equity holdings, ${usd(snapshot.cashCents)} cash, ${tlhCount} tax-loss harvesting candidate${tlhCount === 1 ? "" : "s"}).${recentBuyNote}`,
    canvas: {
      title: "Live Stock Holdings & Tax-Lot Positions",
      badge: "Live Equity Holdings",
      subtitle: `${activeHoldings.length} active tickers · Cash ${usd(snapshot.cashCents)} · ${tlhCount} TLH candidate${tlhCount === 1 ? "" : "s"}`,
      generatedBy: "synthesizer",
      dataSource: "trades-portfolio.json + Customer 360",
      prompt,
      nodes,
      disclaimer: "Holdings reflect live simulated trades settled through sfield cep.domain.execute_write@1.0.0. Highlighted rows indicate unrealized losses eligible for Tax-Loss Harvesting.",
    },
  };
}

export async function generateDynamicUi(input: {
  prompt: string;
  profileSummary?: string;
  recentContext?: string;
  rollingSummary?: string;
  userMemorySummary?: string;
  pendingClarification?: PendingClarificationState | null;
  gateway?: GatewaySettings | null;
  dataDir: string;
  harness?: AgenticHarness;
  onStage?: (stage: HarnessStageRecord) => void | Promise<void>;
  portfolioSnapshots?: PortfolioSnapshotProvider;
  goalProgressProvider?: GoalProgressProvider;
  opsStore?: OpsIncidentStore;
  salesStore?: SalesDealStore;
  connectorStore?: ConnectorStore;
  approvalStore?: ApprovalStore;
  tradeStore?: TradeStore;
  actionFlowStore?: ActionFlowStore;
  matchedActionFlow?: ActionFlow;
  personaId?: string;
  conversationId?: string;
  principalId?: string;
  onTradeSettle?: (principalId: string) => SettlementCallback;
  requesterName?: string;
  semanticRoute?: SemanticRouteDecision;
  tradeContinuation?: {
    draft: TradeDraftState;
    intent: "tax_analysis" | "adjust_qty" | "execute";
    percent?: number;
    shares?: number;
    includeHarvest?: boolean;
  };
  signal?: AbortSignal;
}): Promise<{ intro: string; canvas: DynamicCanvasProps }> {
  const {
    prompt, profileSummary, recentContext, rollingSummary, userMemorySummary, pendingClarification, gateway, dataDir, harness, onStage, portfolioSnapshots, goalProgressProvider, opsStore, salesStore, connectorStore, approvalStore,
    tradeStore, matchedActionFlow, personaId, conversationId, principalId, onTradeSettle, requesterName, semanticRoute, tradeContinuation, signal,
  } = input;

  if (matchedActionFlow) {
    return buildActionFlowCanvas(matchedActionFlow, connectorStore, approvalStore, requesterName, prompt);
  }

  if (tradeContinuation && tradeStore) {
    const { draft, intent, percent, shares, includeHarvest } = tradeContinuation;
    const snap = tradeStore.snapshotFor(draft.personaId);
    const target = snap.holdings.find((h) => h.symbol === draft.symbol) ?? snap.holdings[0];
    const nextShares = shares
      ?? (percent && target.shares > 0 ? Math.max(1, Math.round((target.shares * percent) / 100)) : draft.shares);

    if (intent === "tax_analysis") {
      return buildStockTradeCanvas(tradeStore, draft.personaId, draft.actorName, prompt, undefined, {
        conversationId,
        initialStage: "tax_analysis",
        overrideSide: draft.side,
        overrideSymbol: draft.symbol,
        overrideShares: nextShares,
      });
    }
    if (intent === "adjust_qty") {
      return buildStockTradeCanvas(tradeStore, draft.personaId, draft.actorName, prompt, { percent }, {
        conversationId,
        initialStage: "configure",
        overrideSide: draft.side,
        overrideSymbol: draft.symbol,
        overrideShares: nextShares,
      });
    }
    // intent === "execute"
    const legs: TradeLegInput[] = [
      { symbol: draft.symbol, side: draft.side, shares: nextShares, reason: "primary" },
    ];
    if (includeHarvest && draft.side === "sell") {
      const analysis = draft.taxAnalysis ?? tradeStore.analyzeTaxHarvest(draft.personaId, draft.symbol, nextShares);
      for (const rec of analysis.recommendations) {
        if (rec.recommendedShares > 0) {
          legs.push({ symbol: rec.symbol, side: "sell", shares: rec.recommendedShares, reason: "tax_harvest" });
        }
      }
    }
    const grossCents = tradeStore.estimateGrossCents(draft.personaId, legs);
    if (approvalStore && approvalStore.shouldGateTrade(grossCents)) {
      const policy = approvalStore.getPolicy();
      const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const approval = approvalStore.createPending({
        targetKind: "stock_trade",
        sfieldToolRef: domainWriteToolRef,
        domain: "stock_trade",
        recordId: draft.personaId,
        action: "execute_trade_bundle",
        title: `High-Value Trade Approval · ${legs.map((l) => `${l.side.toUpperCase()} ${l.shares} ${l.symbol}`).join(" + ")}`.slice(0, 120),
        summary: `Gross trade value ${usd(grossCents)} exceeds the $${policy.highRiskTradeThresholdUsd.toLocaleString("en-US")} compliance threshold. Approve to launch the timed sfield settlement job.`,
        riskLevel: "high",
        payload: { personaId: draft.personaId, legs, taxHarvestAnalyzed: Boolean(includeHarvest), grossCents },
        details: [
          { label: "Gross Order Value", value: usd(grossCents) },
          { label: "Compliance Threshold", value: `$${policy.highRiskTradeThresholdUsd.toLocaleString("en-US")}` },
          { label: "Order Legs", value: legs.map((l) => `${l.side.toUpperCase()} ${l.shares} ${l.symbol}`).join(", ") },
          { label: "4-Eyes Dual Control", value: policy.defaultDualControl ? "Required" : "Inline allowed" },
        ],
        requester: draft.actorName,
        dualControl: policy.defaultDualControl,
      });
      if (conversationId) tradeStore.clearDraft(conversationId);
      return {
        intro: `This trade bundle (**${usd(grossCents)}**) exceeds the **$${policy.highRiskTradeThresholdUsd.toLocaleString("en-US")}** high-value compliance threshold, so it has been gated for **HITL Approval** (\`${approval.id}\`). Approve inline below or in \`/admin/logs?source=approvals\` to launch the timed settlement job.`,
        canvas: {
          title: "High-Value Trade Compliance Gate (HITL)",
          badge: "Trade · HITL Approval",
          subtitle: `Approval ${approval.id} · ${usd(grossCents)} gross order value`,
          generatedBy: "synthesizer",
          dataSource: "trades-portfolio.json + approvals.json",
          prompt,
          nodes: [
            {
              type: "approval",
              title: approval.title,
              summary: approval.summary,
              requester: approval.requester,
              riskLevel: "high",
              details: approval.details,
              approveLabel: "Approve & run trade",
              rejectLabel: "Deny trade",
              recordId: approval.recordId,
              domain: "stock_trade",
              approvalId: approval.id,
              payloadDigest: approval.payloadDigest,
              dualControl: approval.dualControl,
              sfieldToolRef: approval.sfieldToolRef,
              initialDecision: "pending",
            },
          ],
          disclaimer: "High-value trades are cryptographically digest-bound and gated through sfield HITL approvals before settlement.",
          suggestedFollowUp: "Show all my stocks",
        },
      };
    }

    const settler = onTradeSettle ? onTradeSettle(principalId ?? "chat") : async () => ({ sfieldRunId: "offline" });
    const job = tradeStore.startTradeJob(
      { personaId: draft.personaId, actor: draft.actorName, legs, taxHarvestAnalyzed: Boolean(includeHarvest), durationSeconds: 5 },
      settler,
    );
    if (conversationId) tradeStore.clearDraft(conversationId);
    return buildStockTradeCanvas(tradeStore, draft.personaId, draft.actorName, prompt, undefined, {
      conversationId,
      initialStage: "running",
      initialJobId: job.jobId,
      overrideSide: draft.side,
      overrideSymbol: draft.symbol,
      overrideShares: nextShares,
    });
  }

  const capId = semanticRoute?.capabilityId;
  if (tradeStore && (capId === "stock_trade" || (!capId && stockTradeTrigger.test(prompt)))) {
    return buildStockTradeCanvas(tradeStore, personaId || "demo-learner", requesterName, prompt, semanticRoute?.extractedParams, { conversationId });
  }
  if (tradeStore && (capId === "stock_holdings" || (!capId && stockHoldingsTrigger.test(prompt)))) {
    return buildStockHoldingsCanvas(tradeStore, personaId || "demo-learner", prompt);
  }
  if (approvalStore && (capId === "hitl_approvals" || (!capId && isApprovalQueuePrompt(prompt)))) {
    return buildApprovalQueueCanvas(approvalStore, prompt);
  }
  if (connectorStore && approvalStore && (capId === "external_connector" || (!capId && isConnectorActionPrompt(prompt)))) {
    return buildConnectorActionCanvas(connectorStore, approvalStore, prompt, requesterName);
  }
  const isDedicatedDomain = (opsStore && (capId === "ops_incident" || isOpsIncidentPrompt(prompt)))
    || (salesStore && (capId === "sales_deal_desk" || isSalesDealPrompt(prompt)));
  const isFormOrCalc = /\b(form|intake|request|application|survey|onboarding form|pto|expense)\b/i.test(prompt)
    || (/\b(calculator|simulator|simulate|calculate|project)\b/i.test(prompt) && generateWidgetFromText(prompt).kind === "calculator");

  if (!isDedicatedDomain && !isFormOrCalc) {
    return runDynamicUiHarness({
      prompt,
      personaId,
      principalId,
      recentContext,
      rollingSummary,
      userMemorySummary,
      pendingClarification,
      gateway,
      dataDir,
      harness,
      onStage,
      portfolioSnapshots,
      goalProgressProvider,
      tradeStore,
      signal,
    });
  }

  return synthesizeDynamicCanvas(prompt, profileSummary, opsStore, salesStore, capId, personaId, tradeStore, recentContext);
}

const widgetStudioSystemPrompt = [
  "You are CEP Widget Studio Generator. Given a natural-language widget request, output ONE JSON object matching this schema:",
  JSON.stringify({
    name: "Short library name (max 72 chars)",
    kind: "kpi | calculator | goal | comparison | checklist | advisory",
    prompt: "Original user prompt",
    badge: "Short badge label (max 40 chars)",
    title: "Card headline (max 90 chars)",
    body: "1-2 sentence description (max 320 chars)",
    ctaLabel: "Action button text (max 48 chars)",
    accentTop: true,
    recommendedComponent: "PznPortfolioSnapshot | PznCapabilityForm | PznGoalProgress | PznComparison | PznStepList | PznContentCard",
    metrics: "Optional (when kind=kpi): 2-4 items [{ label, value, delta? }]",
    sliders: "Optional (when kind=calculator): 2-3 items [{ id: 'monthly'|'years'|'rate', label, min, max, step, value, unit: 'usd'|'percent'|'years'|'months' }]",
    goal: "Optional (when kind=goal): { saved: number, target: number, unitLabel?: string }",
    columns: "Optional (when kind=comparison): exactly 2 items [{ title, points: [2-4 strings] }]",
    steps: "Optional (when kind=checklist): 3-5 step strings",
  }),
  "Do not include any external company names. Return ONLY valid JSON.",
].join("\n");

export async function generateWidgetDraftWithLlm(
  prompt: string,
  gateway: GatewaySettings | null | undefined,
  dataDir: string,
): Promise<WidgetDraft> {
  if (!gateway) return generateWidgetFromText(prompt);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 14_000);
  timer.unref();
  try {
    const raw = await callConfiguredLlmJson(gateway, dataDir, widgetStudioSystemPrompt, prompt, controller.signal);
    const parsed = widgetDraftSchema.safeParse(raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>), prompt } : null);
    if (parsed.success) return parsed.data;
  } catch {
    // Fall back to deterministic generator
  } finally {
    clearTimeout(timer);
  }
  return generateWidgetFromText(prompt);
}

function parseDataUrl(dataUrl: string): { base64: string; mimeType: string } | null {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  return {
    mimeType: match[1] === "image/jpg" ? "image/jpeg" : match[1],
    base64: match[2],
  };
}

function parseFigmaUrl(rawUrl: string): { fileKey: string; nodeId?: string; slug?: string } | null {
  try {
    const u = new URL(rawUrl.trim());
    if (!/figma\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    const markerIdx = parts.findIndex((p) => p === "design" || p === "file" || p === "proto" || p === "board");
    if (markerIdx < 0 || !parts[markerIdx + 1]) return null;
    const fileKey = parts[markerIdx + 1];
    const slug = parts[markerIdx + 2] ? decodeURIComponent(parts[markerIdx + 2]).replace(/[-_]+/g, " ").trim() : undefined;
    const rawNode = u.searchParams.get("node-id")?.trim();
    const nodeId = rawNode ? rawNode.replace(/-/g, ":") : undefined;
    return { fileKey, ...(nodeId ? { nodeId } : {}), ...(slug ? { slug } : {}) };
  } catch {
    return null;
  }
}

function collectFigmaTextNodes(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== "object" || out.length >= 40) return out;
  const obj = node as Record<string, unknown>;
  if (typeof obj.characters === "string" && obj.characters.trim()) {
    out.push(obj.characters.trim().slice(0, 140));
  } else if (typeof obj.name === "string" && obj.type && (obj.type === "FRAME" || obj.type === "COMPONENT" || obj.type === "INSTANCE")) {
    out.push(`[Frame: ${obj.name.trim().slice(0, 60)}]`);
  }
  if (Array.isArray(obj.children)) {
    for (const child of obj.children) collectFigmaTextNodes(child, out);
  }
  return out;
}

async function fetchFigmaContext(
  figmaUrl: string,
  explicitToken?: string,
  signal?: AbortSignal,
): Promise<{
  slug?: string;
  extractedText: string[];
  image?: { base64: string; mimeType: string };
  fetchedFromApi: boolean;
  note: string;
}> {
  const parsed = parseFigmaUrl(figmaUrl);
  if (!parsed) {
    return { extractedText: [], fetchedFromApi: false, note: "Could not parse Figma URL — use a figma.com/design/... or figma.com/file/... link." };
  }
  const token = explicitToken?.trim() || process.env.FIGMA_ACCESS_TOKEN?.trim();
  if (!token) {
    return {
      slug: parsed.slug,
      extractedText: [],
      fetchedFromApi: false,
      note: `Parsed Figma file "${parsed.slug || parsed.fileKey}" (no FIGMA_ACCESS_TOKEN set — add a token or paste a Figma screenshot with Cmd+V for pixel-exact vision extraction).`,
    };
  }
  try {
    const headers = { "X-Figma-Token": token };
    const nodeEndpoint = parsed.nodeId
      ? `https://api.figma.com/v1/files/${encodeURIComponent(parsed.fileKey)}/nodes?ids=${encodeURIComponent(parsed.nodeId)}`
      : `https://api.figma.com/v1/files/${encodeURIComponent(parsed.fileKey)}?depth=3`;
    const metaRes = await fetch(nodeEndpoint, { headers, signal });
    if (!metaRes.ok) {
      return {
        slug: parsed.slug,
        extractedText: [],
        fetchedFromApi: false,
        note: `Figma API returned HTTP ${metaRes.status} — generated from URL metadata instead.`,
      };
    }
    const metaJson = await metaRes.json() as Record<string, unknown>;
    const extractedText: string[] = [];
    if (parsed.nodeId && metaJson.nodes && typeof metaJson.nodes === "object") {
      const target = (metaJson.nodes as Record<string, { document?: unknown }>)[parsed.nodeId];
      if (target?.document) collectFigmaTextNodes(target.document, extractedText);
    } else if (metaJson.document) {
      collectFigmaTextNodes(metaJson.document, extractedText);
    }

    let image: { base64: string; mimeType: string } | undefined;
    if (parsed.nodeId) {
      const imgMetaRes = await fetch(
        `https://api.figma.com/v1/images/${encodeURIComponent(parsed.fileKey)}?ids=${encodeURIComponent(parsed.nodeId)}&format=png&scale=2`,
        { headers, signal },
      );
      if (imgMetaRes.ok) {
        const imgJson = await imgMetaRes.json() as { images?: Record<string, string> };
        const pngUrl = imgJson.images?.[parsed.nodeId];
        if (pngUrl) {
          const pngRes = await fetch(pngUrl, { signal });
          if (pngRes.ok) {
            const buf = Buffer.from(await pngRes.arrayBuffer());
            if (buf.byteLength > 0 && buf.byteLength < 3_500_000) {
              image = { base64: buf.toString("base64"), mimeType: "image/png" };
            }
          }
        }
      }
    }
    return {
      slug: parsed.slug || (typeof metaJson.name === "string" ? metaJson.name : parsed.fileKey),
      extractedText,
      image,
      fetchedFromApi: true,
      note: `Imported Figma frame "${parsed.slug || parsed.fileKey}" (${extractedText.length} text/layer nodes${image ? " + rendered PNG" : ""}).`,
    };
  } catch {
    return {
      slug: parsed.slug,
      extractedText: [],
      fetchedFromApi: false,
      note: `Figma API unreachable — generated from Figma URL metadata ("${parsed.slug || parsed.fileKey}").`,
    };
  }
}

export async function generateWidgetFromMultimodal(
  input: {
    prompt?: string;
    imageDataUrl?: string;
    imageName?: string;
    figmaUrl?: string;
    figmaToken?: string;
  },
  gateway: GatewaySettings | null | undefined,
  dataDir: string,
): Promise<{
  widget: WidgetDraft;
  source: "copilot_vision" | "figma_api" | "copilot_llm" | "synthesizer";
  sourceSummary: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 24_000);
  timer.unref();

  try {
    let image = input.imageDataUrl ? parseDataUrl(input.imageDataUrl) ?? undefined : undefined;
    let figmaInfo: Awaited<ReturnType<typeof fetchFigmaContext>> | undefined;

    if (input.figmaUrl?.trim()) {
      figmaInfo = await fetchFigmaContext(input.figmaUrl, input.figmaToken, controller.signal);
      if (!image && figmaInfo.image) image = figmaInfo.image;
    }

    const basePrompt = input.prompt?.trim()
      || (figmaInfo?.slug ? `Recreate the Figma design "${figmaInfo.slug}" as an interactive CEP widget` : "")
      || (input.imageName ? `Recreate the uploaded design mockup (${input.imageName}) as an interactive CEP widget` : "Recreate the attached UI screenshot as an interactive CEP widget");

    const enrichedPromptParts = [basePrompt];
    if (image) {
      enrichedPromptParts.push(
        "A UI design screenshot is attached. Visually inspect the screenshot carefully: extract its real headline, badge, KPI numbers/labels, progress bars, comparison columns, checklist steps, or sliders, and map them accurately into the CEP WidgetDraft JSON schema.",
      );
    }
    if (figmaInfo?.extractedText.length) {
      enrichedPromptParts.push(`FIGMA LAYER & TEXT EXTRACTION:\n${figmaInfo.extractedText.slice(0, 30).join("\n")}`);
    } else if (figmaInfo?.slug) {
      enrichedPromptParts.push(`FIGMA DESIGN NAME: ${figmaInfo.slug}`);
    }
    const llmPrompt = enrichedPromptParts.join("\n\n");

    if (gateway) {
      try {
        const raw = await callConfiguredLlmJson(gateway, dataDir, widgetStudioSystemPrompt, llmPrompt, controller.signal, image);
        const parsed = widgetDraftSchema.safeParse(
          raw && typeof raw === "object"
            ? { ...(raw as Record<string, unknown>), prompt: basePrompt.slice(0, 600) }
            : null,
        );
        if (parsed.success) {
          const source = figmaInfo?.fetchedFromApi
            ? "figma_api"
            : image
              ? "copilot_vision"
              : "copilot_llm";
          const sourceSummary = figmaInfo
            ? figmaInfo.note
            : image
              ? `Generated from uploaded screenshot${input.imageName ? ` (${input.imageName})` : ""} via Copilot Vision.`
              : "Generated from prompt via Copilot ACP.";
          return { widget: parsed.data, source, sourceSummary };
        }
      } catch {
        // Fall through to deterministic synthesizer
      }
    }

    const fallbackPrompt = figmaInfo?.extractedText.length
      ? `${basePrompt} ${figmaInfo.extractedText.slice(0, 8).join(" ")}`
      : basePrompt;
    return {
      widget: generateWidgetFromText(fallbackPrompt),
      source: "synthesizer",
      sourceSummary: figmaInfo?.note ?? (image
        ? `Synthesized widget structure from screenshot metadata${input.imageName ? ` (${input.imageName})` : ""}.`
        : "Synthesized widget from text prompt."),
    };
  } finally {
    clearTimeout(timer);
  }
}
