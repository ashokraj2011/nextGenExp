import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  capabilityLabelFor,
  CEP_CAPABILITIES,
  semanticRouteOutputSchema,
  type CepCapabilityDefinition,
  type CepCapabilityId,
  type SemanticRouteDecision,
} from "../../packages/contracts/capabilities-catalog";
import { runCopilotPrompt } from "./copilot-acp-client";
import type { TimedCall } from "../../packages/contracts/inspector";
import {
  isApprovalQueuePrompt,
  isConnectorActionPrompt,
  isDynamicUiRequest,
  isOpsIncidentPrompt,
  isSalesDealPrompt,
  isStockHoldingsPrompt,
  isStockTradePrompt,
} from "./dynamic-ui-generator";
import type { GatewaySettings } from "./gateway";
import { parseStockPositionPrompt, parseStockTradePrompt } from "./trade-store";

const nonDynamicGuard = /\b(weather|stock price|tomorrow|create a? ?rule)\b/i;
const chatReply = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })) });

function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/i);
  if (fenced) return fenced[1].trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

function routingPrompt(catalog: readonly CepCapabilityDefinition[]) {
  const registered = new Set(catalog.map((capability) => capability.id));
  const whenRegistered = (id: CepCapabilityId, instruction: string) => registered.has(id) ? [instruction] : [];
  return [
    "You are the CEP (Customer Engagement Platform) Unified Semantic Capability Router.",
    "Your job is to classify a user's message into EXACTLY ONE capabilityId from the catalog below based on semantic meaning — even when phrased informally, paraphrased, or with typos.",
    "Catalog:",
    ...catalog.map(
      (c) => `- ${c.id} (${c.domain}): ${c.description} Examples: ${c.examples.map((e) => `"${e}"`).join(", ")}`,
    ),
    "Critical disambiguation rules:",
    ...whenRegistered("stock_holdings", "Choose 'stock_holdings' for individual stock positions, shares owned, equity book, cost basis, or unrealized gains/losses. Include extractedParams.symbol for a request about one specific position, using its ticker. For the full list or several positions, omit symbol."),
    ...whenRegistered("stock_trade", "Choose 'stock_trade' whenever the user wants to buy, sell, trim, liquidate, or simulate trading stocks, or wants tax-loss harvesting analysis/offset trades. Extract optional extractedParams: { side?: 'buy'|'sell', symbol?: 'AAPL'|'MSFT'|'NVDA'|'INTC'|'BA'|'PFE', percent?: number (1-100, e.g. 'a third'->33, 'half'->50), shares?: integer }."),
    ...whenRegistered("verified_experience", "Choose 'verified_experience' for high-level portfolio summary/allocation ('portfolio summary', 'how can I invest more'), balance definitions/comparisons, home down-payment goal, retirement/beneficiaries, address change, funding/transfers, 'what is next', creating rules, live market price/weather queries, or plain greetings/thanks."),
    ...whenRegistered("hitl_approvals", "Choose 'hitl_approvals' for questions about pending approvals, items awaiting sign-off, or the HITL queue."),
    ...whenRegistered("external_connector", "Choose 'external_connector' for triggering/invoking external webhooks or bridges (PagerDuty, ServiceNow, external connectors)."),
    ...whenRegistered("ops_incident", "Choose 'ops_incident' for production incidents, latency/5xx outages, SRE triage, or release rollbacks."),
    ...whenRegistered("sales_deal_desk", "Choose 'sales_deal_desk' for Q4 sales pipeline, RevOps forecast, Deal Desk discount approvals, or enterprise close plans."),
    ...whenRegistered("verified_experience", "A generic request to visualize the current portfolio allocation (without specifying pie chart, donut chart, bar chart, or table) is a verified_experience."),
    ...whenRegistered("custom_dynamic_ui", "Choose 'custom_dynamic_ui' whenever the user explicitly asks for a specific chart/visual format (pie chart, donut chart, bar chart, comparison table, 3 bullet points, checklist, calculator, form, dashboard) OR corrects a previous visual (e.g. 'this is not a pie chart', 'make it a table instead')."),
    'Return ONLY valid JSON: { "capabilityId": "...", "confidence": 0.95, "reasoning": "short 1-sentence reason", "extractedParams": {} }.',
  ].join("\n");
}

export function deterministicCapabilityRoute(prompt: string): SemanticRouteDecision {
  const clean = prompt.trim();
  const positionSymbol = parseStockPositionPrompt(clean);
  if (positionSymbol) {
    return {
      capabilityId: "stock_holdings",
      capabilityLabel: capabilityLabelFor("stock_holdings"),
      method: "deterministic",
      confidence: 0.99,
      reasoning: `Matched a request to view the ${positionSymbol} position.`,
      extractedParams: { symbol: positionSymbol },
    };
  }
  if (clean.length < 4 || nonDynamicGuard.test(clean)) {
    return {
      capabilityId: "verified_experience",
      capabilityLabel: capabilityLabelFor("verified_experience"),
      method: "deterministic",
      confidence: 0.95,
      reasoning: "Matched governed advisory or guardrail path.",
    };
  }
  if (isStockTradePrompt(clean)) {
    const parsed = parseStockTradePrompt(clean);
    return {
      capabilityId: "stock_trade",
      capabilityLabel: capabilityLabelFor("stock_trade"),
      method: "deterministic",
      confidence: 0.94,
      reasoning: `Matched stock ${parsed.side} / tax-loss harvesting request for ${parsed.symbol}.`,
      extractedParams: parsed,
    };
  }
  const explicitChartFormat = /\b(pie\s*chart|donut\s*chart|bar\s*chart|bubble\s*chart|scatter\s*(?:plot|chart)|radar\s*chart|heat\s*map|industry|sector|drill\s*down)\b/i.test(clean);
  if (!explicitChartFormat && (isStockHoldingsPrompt(clean) || /\b(?:equity|stock)\s+book\b|\bmy\s+equities\b/i.test(clean))) {
    return {
      capabilityId: "stock_holdings",
      capabilityLabel: capabilityLabelFor("stock_holdings"),
      method: "deterministic",
      confidence: 0.93,
      reasoning: "Matched individual stock holdings and tax-lot positions query.",
    };
  }
  if (isApprovalQueuePrompt(clean)) {
    return {
      capabilityId: "hitl_approvals",
      capabilityLabel: capabilityLabelFor("hitl_approvals"),
      method: "deterministic",
      confidence: 0.95,
      reasoning: "Matched live Human-in-the-Loop approval queue request.",
    };
  }
  if (isConnectorActionPrompt(clean)) {
    return {
      capabilityId: "external_connector",
      capabilityLabel: capabilityLabelFor("external_connector"),
      method: "deterministic",
      confidence: 0.94,
      reasoning: "Matched external REST/MCP connector invocation request.",
    };
  }
  if (isOpsIncidentPrompt(clean)) {
    return {
      capabilityId: "ops_incident",
      capabilityLabel: capabilityLabelFor("ops_incident"),
      method: "deterministic",
      confidence: 0.92,
      reasoning: "Matched live IT Operations incident triage / rollback workflow.",
    };
  }
  if (isSalesDealPrompt(clean)) {
    return {
      capabilityId: "sales_deal_desk",
      capabilityLabel: capabilityLabelFor("sales_deal_desk"),
      method: "deterministic",
      confidence: 0.92,
      reasoning: "Matched live Sales & RevOps Deal Desk workflow.",
    };
  }
  const refinementFollowUp = /\b((?:exclude|without|remove|drop|hide)\s+(?:apple|aapl|microsoft|msft|nvidia|nvda|intel|intc|boeing|ba|pfizer|pfe|cash|fixed\s+income)|(?:only|just|filter\s+to|focus\s+on)\s+(?:tech|technology|semiconductors?|industrials?|healthcare|pharma|stocks?|equities)|(?:turn|switch|convert|change)\s+(?:that|it|this)\s+(?:in)?to\s+(?:a\s+)?(?:pie|donut|bar|bubble|table)|show\s+(?:that|it|this)\s+as\s+(?:a\s+)?(?:pie|donut|bar|bubble|table))\b/i;
  if (isDynamicUiRequest(clean) || refinementFollowUp.test(clean) || /\b(by\s+industry|based\s+on\s+industry|by\s+sector|sector\s+breakdown|industry\s+breakdown|drill\s*down)\b/i.test(clean)) {
    const explicitFormatOrCorrection = refinementFollowUp.test(clean) || /\b(pie\s*chart|donut\s*chart|bar\s*chart|bubble\s*chart|scatter\s*plot|radar\s*chart|heat\s*map|comparison\s+table|as\s+a\s+(?:clear\s+)?(?:comparison\s+)?table|summarize\s+(?:your\s+)?last\s+answer|in\s+\d+\s+bullet\s+points?|not\s+a\s+(?:pie|bar|donut)\s*chart|by\s+industry|based\s+on\s+industry|by\s+sector|sector\s+breakdown|industry\s+breakdown|drill\s*down)\b|^\s*as\s+(?:a\s+|an\s+)?[\w\s-]{2,24}(?:chart|table|graph|plot)\s*$/i.test(clean);
    return {
      capabilityId: "custom_dynamic_ui",
      capabilityLabel: capabilityLabelFor("custom_dynamic_ui"),
      method: "deterministic",
      confidence: explicitFormatOrCorrection ? 0.94 : 0.85,
      reasoning: explicitFormatOrCorrection
        ? "Matched explicit dynamic visual format or visual correction request."
        : "Matched ad-hoc interactive UI composition request.",
    };
  }
  return {
    capabilityId: "verified_experience",
    capabilityLabel: capabilityLabelFor("verified_experience"),
    method: "deterministic",
    confidence: 0.85,
    reasoning: "Defaulting to governed Context Router & Verified Experience pipeline.",
  };
}

export async function routeCapabilityUnified(input: {
  prompt: string;
  gateway?: GatewaySettings | null;
  dataDir: string;
  recentSummary?: string;
  capabilities?: readonly CepCapabilityDefinition[];
  signal?: AbortSignal;
  onExchange?: (operation: string, request: unknown, response: unknown, timing: TimedCall) => void;
}): Promise<SemanticRouteDecision> {
  const { prompt, gateway, dataDir, recentSummary, signal } = input;
  const clean = prompt.trim();
  const fallback = deterministicCapabilityRoute(clean);
  const catalog = input.capabilities ?? CEP_CAPABILITIES;
  const available = (id: CepCapabilityId) => catalog.some((capability) => capability.id === id);
  if (!available(fallback.capabilityId) && fallback.capabilityId !== "verified_experience") return fallback;

  if (!gateway || clean.length < 6 || nonDynamicGuard.test(clean) || /\b(?:DEAL|INC)-[A-Z0-9]+\b/i.test(clean)) {
    return fallback;
  }

  // Fast-path high-confidence explicit capability hits to avoid unnecessary latency, while using the live LLM
  // Semantic Router for everything else (paraphrases like "what's in my equity book?", "which stocks are losing money?",
  // "trim a third of my Apple", "anything waiting for my sign-off?", etc.).
  if (fallback.capabilityId !== "verified_experience" && fallback.confidence >= 0.93) {
    return fallback;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7_000);
  timer.unref();
  const onParentAbort = () => controller.abort();
  signal?.addEventListener("abort", onParentAbort, { once: true });

  const operation = gateway.profile === "copilot_acp" ? "ACP session/prompt" : "POST /chat/completions";
  let request: unknown;
  let received = false;
  const startedAt = Date.now();
  const capture = (response: unknown, status = "succeeded") => {
    received = true;
    input.onExchange?.(operation, request, response, { startedAt, durationMs: Date.now() - startedAt, status });
  };
  try {
    const userPrompt = recentSummary
      ? `Recent context: ${recentSummary}\nUser message: ${clean}`
      : `User message: ${clean}`;

    const semanticRouterSystemPrompt = routingPrompt(catalog);
    let raw: unknown = null;
    if (gateway.profile === "copilot_acp") {
      const cliHome = resolve(dataDir, "copilot-cli");
      mkdirSync(cliHome, { recursive: true, mode: 0o700 });
      const fullText = `${semanticRouterSystemPrompt}\n\n${userPrompt}\n\nReturn ONLY the JSON object.`;
      const reply = await runCopilotPrompt(gateway, cliHome, [{ type: "text", text: fullText }], controller.signal, (sent) => { request = sent; });
      capture({ result: reply.result, text: reply.text });
      raw = JSON.parse(stripJsonFences(reply.text));
    } else {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(gateway.apiKey ? { Authorization: `Bearer ${gateway.apiKey}` } : {}),
        ...(gateway.headers ?? {}),
      };
      request = {
        ...(gateway.bodyFields ?? {}),
        model: gateway.model,
        max_tokens: 220,
        temperature: 0,
        messages: [
          { role: "system", content: semanticRouterSystemPrompt },
          { role: "user", content: userPrompt },
        ],
      };
      const response = await fetch(`${gateway.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify(request),
      });
      const body = await response.text();
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { /* Some gateway errors return text. */ }
      capture({ status: response.status, body: payload ?? body }, response.ok ? "succeeded" : "failed");
      if (response.ok) {
        const reply = chatReply.safeParse(payload);
        const content = reply.success && reply.data.choices[0]?.message.content;
        if (content) raw = JSON.parse(stripJsonFences(content));
      }
    }

    const parsed = semanticRouteOutputSchema.safeParse(raw);
    if (parsed.success && parsed.data.confidence >= 0.65 && available(parsed.data.capabilityId)) {
      const capabilityId: CepCapabilityId = parsed.data.capabilityId;
      return {
        capabilityId,
        capabilityLabel: capabilityLabelFor(capabilityId),
        method: "llm_semantic",
        confidence: parsed.data.confidence,
        reasoning: parsed.data.reasoning,
        ...(parsed.data.extractedParams ? { extractedParams: parsed.data.extractedParams } : {}),
      };
    }
  } catch {
    if (!received) capture({ error: controller.signal.aborted ? "request_aborted" : "provider_unavailable" }, controller.signal.aborted ? "aborted" : "failed");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onParentAbort);
  }

  return fallback;
}
