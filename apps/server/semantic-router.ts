import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  capabilityLabelFor,
  CEP_CAPABILITIES,
  semanticRouteOutputSchema,
  type CepCapabilityId,
  type SemanticRouteDecision,
} from "../../packages/contracts/capabilities-catalog";
import { runCopilotPrompt } from "./copilot-acp-client";
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
import { parseStockTradePrompt } from "./trade-store";

const nonDynamicGuard = /\b(weather|stock price|tomorrow|create a? ?rule)\b/i;

function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/i);
  if (fenced) return fenced[1].trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

const semanticRouterSystemPrompt = [
  "You are the CEP (Customer Engagement Platform) Unified Semantic Capability Router.",
  "Your job is to classify a user's message into EXACTLY ONE capabilityId from the catalog below based on semantic meaning — even when phrased informally, paraphrased, or with typos.",
  "Catalog:",
  ...CEP_CAPABILITIES.map(
    (c) => `- ${c.id} (${c.domain}): ${c.description} Examples: ${c.examples.map((e) => `"${e}"`).join(", ")}`,
  ),
  "Critical disambiguation rules:",
  "1. Choose 'stock_holdings' whenever the user asks to see individual stocks, tickers, shares owned, equity book, cost basis, or which positions are up/down or losing money.",
  "2. Choose 'stock_trade' whenever the user wants to buy, sell, trim, liquidate, or simulate trading stocks, or wants tax-loss harvesting analysis/offset trades. Extract optional extractedParams: { side?: 'buy'|'sell', symbol?: 'AAPL'|'MSFT'|'NVDA'|'INTC'|'BA'|'PFE', percent?: number (1-100, e.g. 'a third'->33, 'half'->50), shares?: integer }.",
  "3. Choose 'verified_experience' for high-level portfolio summary/allocation ('portfolio summary', 'how can I invest more'), balance definitions/comparisons, home down-payment goal, retirement/beneficiaries, address change, funding/transfers, 'what is next', creating rules, live market price/weather queries, or plain greetings/thanks.",
  "4. Choose 'hitl_approvals' for questions about pending approvals, items awaiting sign-off, or the HITL queue.",
  "5. Choose 'external_connector' for triggering/invoking external webhooks or bridges (PagerDuty, ServiceNow, external connectors).",
  "6. Choose 'ops_incident' for production incidents, latency/5xx outages, SRE triage, or release rollbacks.",
  "7. Choose 'sales_deal_desk' for Q4 sales pipeline, RevOps forecast, Deal Desk discount approvals, or enterprise close plans.",
  "A request to visualize the current portfolio allocation is a verified_experience. The Portfolio Snapshot supplies the asset mix.",
  "8. Choose 'custom_dynamic_ui' ONLY when the user explicitly wants an interactive calculator, custom chart/table/form/matrix/checklist/dashboard that does not fit capabilities 1-7.",
  'Return ONLY valid JSON: { "capabilityId": "...", "confidence": 0.95, "reasoning": "short 1-sentence reason", "extractedParams": {} }.',
].join("\n");

export function deterministicCapabilityRoute(prompt: string): SemanticRouteDecision {
  const clean = prompt.trim();
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
  if (isStockHoldingsPrompt(clean) || /\b(?:equity|stock)\s+book\b|\bmy\s+equities\b/i.test(clean)) {
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
  if (isDynamicUiRequest(clean)) {
    return {
      capabilityId: "custom_dynamic_ui",
      capabilityLabel: capabilityLabelFor("custom_dynamic_ui"),
      method: "deterministic",
      confidence: 0.85,
      reasoning: "Matched ad-hoc interactive UI composition request.",
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
  mode: "live" | "test";
  gateway?: GatewaySettings | null;
  dataDir: string;
  recentSummary?: string;
  signal?: AbortSignal;
}): Promise<SemanticRouteDecision> {
  const { prompt, mode, gateway, dataDir, recentSummary, signal } = input;
  const clean = prompt.trim();
  const fallback = deterministicCapabilityRoute(clean);

  // In automated mock-gateway tests, or on guarded/short prompts, keep routing deterministic with zero extra model calls.
  if (mode === "test" || !gateway || clean.length < 6 || nonDynamicGuard.test(clean) || /\b(?:DEAL|INC)-[A-Z0-9]+\b/i.test(clean)) {
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

  try {
    const userPrompt = recentSummary
      ? `Recent context: ${recentSummary}\nUser message: ${clean}`
      : `User message: ${clean}`;

    let raw: unknown = null;
    if (gateway.profile === "copilot_acp") {
      const cliHome = resolve(dataDir, "copilot-cli");
      mkdirSync(cliHome, { recursive: true, mode: 0o700 });
      const fullText = `${semanticRouterSystemPrompt}\n\n${userPrompt}\n\nReturn ONLY the JSON object.`;
      const reply = await runCopilotPrompt(gateway, cliHome, [{ type: "text", text: fullText }], controller.signal, () => undefined);
      raw = JSON.parse(stripJsonFences(reply.text));
    } else {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(gateway.apiKey ? { Authorization: `Bearer ${gateway.apiKey}` } : {}),
        ...(gateway.headers ?? {}),
      };
      const response = await fetch(`${gateway.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          ...(gateway.bodyFields ?? {}),
          model: gateway.model,
          max_tokens: 220,
          temperature: 0,
          messages: [
            { role: "system", content: semanticRouterSystemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });
      if (response.ok) {
        const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
        const text = payload.choices?.[0]?.message?.content;
        if (text) raw = JSON.parse(stripJsonFences(text));
      }
    }

    const parsed = semanticRouteOutputSchema.safeParse(raw);
    if (parsed.success && parsed.data.confidence >= 0.65) {
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
    // Gracefully fall back to deterministic route if LLM classifier times out or fails.
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onParentAbort);
  }

  return fallback;
}
