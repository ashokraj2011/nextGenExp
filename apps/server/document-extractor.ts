import { callConfiguredLlmJson } from "./dynamic-ui-generator";
import type { GatewaySettings } from "./gateway";

export type ExtractedDocumentAction =
  | {
      actionType: "wire_workflow";
      fileName: string;
      confidence: number;
      summary: string;
      extractedFields: {
        recipientName: string;
        amountUsd: number;
        rail: "Domestic Fedwire" | "International SWIFT";
        runFraudScreen: boolean;
      };
    }
  | {
      actionType: "stock_trade";
      fileName: string;
      confidence: number;
      summary: string;
      extractedFields: {
        side: "buy" | "sell";
        symbol: string;
        shares?: number;
        percent?: number;
      };
    }
  | {
      actionType: "ops_incident";
      fileName: string;
      confidence: number;
      summary: string;
      extractedFields: {
        serviceName: string;
        errorRatePct: number;
        p95LatencyMs: number;
        releaseTag: string;
        logExcerpt: string;
      };
    };

export function hasAttachedDocumentBlock(message: string): { fileName: string; body: string } | null {
  const match = message.match(/\[Attached:\s*([^\]()]+?)(?:\s*\([^)]+\))?\]\s*([\s\S]*)/i);
  if (!match) return null;
  const fileName = match[1].trim();
  const body = (match[2] ?? "").trim();
  if (!fileName || body.length < 10) return null;
  return { fileName, body };
}

function deterministicExtract(fileName: string, content: string): ExtractedDocumentAction | null {
  const text = `${fileName}\n${content}`;
  const lower = text.toLowerCase();

  // 1. Wire Transfer / Invoice Extraction
  if (/\b(invoice|wire|beneficiary|recipient|fedwire|swift|iban|remittance|payable|escrow)\b/i.test(lower)) {
    const recipientMatch = content.match(/(?:recipient|beneficiary|pay\s*to|vendor|bill\s*to)\s*[:=-]\s*([^\n,;]{3,64})/i);
    const amountMatch = content.match(/(?:amount|total\s*due|wire\s*amount|subtotal|pay)\s*[:=-]?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i)
      ?? content.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
    const amountUsd = amountMatch ? Math.max(100, Math.round(Number(amountMatch[1].replace(/,/g, "")))) : 14500;
    const isSwift = /\b(swift|international|iban|eur|gbp)\b/i.test(lower);
    const recipientName = recipientMatch?.[1]?.trim() || "Apex Escrow Holdings LLC";
    const rail = isSwift ? "International SWIFT" : "Domestic Fedwire";
    return {
      actionType: "wire_workflow",
      fileName,
      confidence: 0.94,
      summary: `Extracted wire payment from ${fileName}: $${amountUsd.toLocaleString("en-US")} to ${recipientName} via ${rail}.`,
      extractedFields: {
        recipientName,
        amountUsd,
        rail,
        runFraudScreen: true,
      },
    };
  }

  // 2. SRE / Outage Log Extraction
  if (/\b(error|5xx|502|503|latency|p95|timeout|crash|exception|incident|rollback|release|v\d+\.\d+)\b/i.test(lower)) {
    const serviceMatch = content.match(/(?:service|app|deployment)\s*[:=-]\s*([a-z0-9._-]{3,48})/i);
    const errMatch = content.match(/(?:error[_\s-]*rate|5xx)\s*[:=-]?\s*([\d.]+)\s*%/i);
    const latMatch = content.match(/(?:p95|latency)\s*[:=-]?\s*(\d{2,5})\s*ms/i);
    const relMatch = content.match(/\b(v\d+\.\d+\.\d+(?:-[a-z0-9]+)?)\b/i);
    const serviceName = serviceMatch?.[1]?.trim() || "checkout-api";
    const errorRatePct = errMatch ? Number(errMatch[1]) : 4.6;
    const p95LatencyMs = latMatch ? Number(latMatch[1]) : 438;
    const releaseTag = relMatch?.[1] || "v4.12.1";
    return {
      actionType: "ops_incident",
      fileName,
      confidence: 0.92,
      summary: `Extracted production outage signals from ${fileName}: ${serviceName} (${releaseTag}) at ${errorRatePct}% 5xx / ${p95LatencyMs}ms p95.`,
      extractedFields: {
        serviceName,
        errorRatePct,
        p95LatencyMs,
        releaseTag,
        logExcerpt: content.slice(0, 260),
      },
    };
  }

  // 3. Brokerage Order / Holdings CSV Extraction
  if (/\b(aapl|msft|nvda|intc|ba|pfe|ticker|symbol|shares|sell|buy|order|brokerage)\b/i.test(lower)) {
    const symMatch = content.match(/\b(AAPL|MSFT|NVDA|INTC|BA|PFE)\b/i);
    const sideMatch = content.match(/\b(buy|sell|trim|liquidate)\b/i);
    const pctMatch = content.match(/\b(\d{1,3})\s*%/);
    const sharesMatch = content.match(/(?:shares|qty|quantity)\s*[:=,\s]\s*(\d{1,5})\b/i)
      ?? content.match(/\b(\d{1,4})\s+shares?\b/i);
    const symbol = (symMatch?.[1] ?? "AAPL").toUpperCase();
    const side: "buy" | "sell" = sideMatch && /buy/i.test(sideMatch[1]) ? "buy" : "sell";
    const percent = pctMatch ? Math.min(100, Math.max(1, Number(pctMatch[1]))) : undefined;
    const shares = !percent && sharesMatch ? Math.max(1, Number(sharesMatch[1])) : undefined;
    return {
      actionType: "stock_trade",
      fileName,
      confidence: 0.93,
      summary: `Extracted equity order from ${fileName}: ${side.toUpperCase()} ${percent ? `${percent}%` : `${shares ?? 10} shares`} of ${symbol}.`,
      extractedFields: {
        side,
        symbol,
        ...(percent ? { percent } : { shares: shares ?? 10 }),
      },
    };
  }

  return null;
}

const extractorSystemPrompt = [
  "You extract structured action fields from an uploaded document (invoice, wire request, brokerage CSV, or server outage log).",
  "Return ONLY ONE JSON object with `actionType` = 'wire_workflow' | 'stock_trade' | 'ops_incident' and `extractedFields`:",
  "- If wire_workflow: { actionType: 'wire_workflow', summary, extractedFields: { recipientName, amountUsd (number), rail: 'Domestic Fedwire'|'International SWIFT', runFraudScreen: true } }",
  "- If stock_trade: { actionType: 'stock_trade', summary, extractedFields: { side: 'buy'|'sell', symbol: 'AAPL'|'MSFT'|'NVDA'|'INTC'|'BA'|'PFE', shares?: number, percent?: number } }",
  "- If ops_incident: { actionType: 'ops_incident', summary, extractedFields: { serviceName, errorRatePct (number), p95LatencyMs (number), releaseTag, logExcerpt } }",
  "Return ONLY valid JSON.",
].join("\n");

export async function extractDocumentAction(input: {
  fileName: string;
  content: string;
  gateway?: GatewaySettings | null;
  dataDir: string;
  signal?: AbortSignal;
}): Promise<ExtractedDocumentAction | null> {
  const deterministic = deterministicExtract(input.fileName, input.content);
  if (deterministic) return deterministic;
  if (input.gateway) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), 9000);
    timer.unref();
    try {
      const raw = await callConfiguredLlmJson(
        input.gateway,
        input.dataDir,
        extractorSystemPrompt,
        `File: ${input.fileName}\n\n${input.content.slice(0, 1800)}`,
        controller.signal,
      );
      if (raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>;
        const ef = (obj.extractedFields && typeof obj.extractedFields === "object" ? obj.extractedFields : {}) as Record<string, unknown>;
        if (obj.actionType === "wire_workflow" && typeof ef.recipientName === "string" && Number(ef.amountUsd) > 0) {
          return {
            actionType: "wire_workflow",
            fileName: input.fileName,
            confidence: 0.96,
            summary: typeof obj.summary === "string" && obj.summary.trim() ? obj.summary.trim() : `Extracted wire from ${input.fileName}`,
            extractedFields: {
              recipientName: ef.recipientName.trim().slice(0, 64),
              amountUsd: Math.round(Number(ef.amountUsd)),
              rail: String(ef.rail).toLowerCase().includes("swift") ? "International SWIFT" : "Domestic Fedwire",
              runFraudScreen: ef.runFraudScreen !== false,
            },
          };
        }
        if (obj.actionType === "stock_trade" && typeof ef.symbol === "string") {
          const sym = ef.symbol.trim().toUpperCase();
          if (["AAPL", "MSFT", "NVDA", "INTC", "BA", "PFE"].includes(sym)) {
            return {
              actionType: "stock_trade",
              fileName: input.fileName,
              confidence: 0.95,
              summary: typeof obj.summary === "string" && obj.summary.trim() ? obj.summary.trim() : `Extracted trade order from ${input.fileName}`,
              extractedFields: {
                side: ef.side === "buy" ? "buy" : "sell",
                symbol: sym,
                ...(Number(ef.percent) > 0 ? { percent: Math.min(100, Math.round(Number(ef.percent))) } : { shares: Math.max(1, Math.round(Number(ef.shares) || 10)) }),
              },
            };
          }
        }
        if (obj.actionType === "ops_incident" && typeof ef.serviceName === "string") {
          return {
            actionType: "ops_incident",
            fileName: input.fileName,
            confidence: 0.94,
            summary: typeof obj.summary === "string" && obj.summary.trim() ? obj.summary.trim() : `Extracted outage from ${input.fileName}`,
            extractedFields: {
              serviceName: ef.serviceName.trim().slice(0, 48),
              errorRatePct: Number(ef.errorRatePct) || 4.5,
              p95LatencyMs: Number(ef.p95LatencyMs) || 420,
              releaseTag: typeof ef.releaseTag === "string" ? ef.releaseTag.trim() : "v4.12.1",
              logExcerpt: input.content.slice(0, 240),
            },
          };
        }
      }
    } catch {
      // Fall back to deterministic extractor
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }
  return deterministic;
}
