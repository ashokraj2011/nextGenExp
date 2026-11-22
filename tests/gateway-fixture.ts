import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { GatewaySettings } from "../apps/server/gateway";
import type { ComponentName, ContextSelectionProposal, ExperienceProposal, Intent } from "../packages/contracts/domain";
import type { modelBundle } from "../packages/experience/content";

type Envelope = {
  inputType: "PznContextRoutingInput" | "PznExperienceCompositionInput";
  request: string;
  catalogSnapshotId?: string;
  catalog?: { catalogVersion: string; contexts: { contextId: string }[] };
  propensity?: unknown;
  recent?: { request: string; contextId: string }[];
  selectedContextId?: string;
  intent?: Intent;
  eligible?: ReturnType<typeof modelBundle>;
  allowedQuestions: string[];
  canCreateRule?: boolean;
  portfolioSnapshotIncluded?: boolean;
};
type RequestBody = {
  model: string;
  stream: boolean;
  stream_options?: { include_usage: boolean };
  messages: Array<{ role: string; content: string | null; tool_call_id?: string }>;
  response_format: { type: string; json_schema?: { strict: boolean } };
  tools?: { function: { name: string } }[];
};
type GatewayCall = { envelope: Envelope; body: RequestBody; headers: IncomingHttpHeaders };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type ResponseData = ContextSelectionProposal | ExperienceProposal | Record<string, unknown>;
export type TestResponse = { status?: number; json?: ResponseData; delayMs?: number; draft?: string; omitUsage?: boolean; errorMessage?: string };
export type TestInterceptor = (call: GatewayCall) => TestResponse | void;
const testKey = "pzn-test-gateway-key";

function fromMessage(body: RequestBody): Envelope | undefined {
  for (const message of body.messages) {
    if (message.role !== "user" || !message.content) continue;
    try {
      const value = JSON.parse(message.content);
      if (value?.inputType === "PznContextRoutingInput" || value?.inputType === "PznExperienceCompositionInput") return value;
    } catch { /* Runtime repair instructions are ordinary text. */ }
  }
  return undefined;
}

function route(envelope: Envelope): ContextSelectionProposal {
  const { request, recent, allowedQuestions } = envelope;
  const text = request.toLowerCase().trim();
  const catalog = { schemaVersion: "1.0" as const, catalogSnapshotId: envelope.catalogSnapshotId!, catalogVersion: envelope.catalog!.catalogVersion };
  if (/^(?:(?:please|i want to|can you|i'd like to) )?(?:create|add) (?:(?:a|new|a new) )?(?:ccre |treatment selector )?rule\b/.test(text)) {
    const intent = { topic: "Treatment Selector rules", summary: "Create a Treatment Selector eligibility rule." };
    return envelope.canCreateRule
      ? { ...catalog, status: "create_rule", contextId: null, clarificationQuestion: null, intent: { ...intent, task: "create_rule" } }
      : { ...catalog, status: "no_match", contextId: null, clarificationQuestion: null, intent: { ...intent, task: "unknown" } };
  }
  const contexts = new Set<string>();
  if (/balance|ledger|available term/.test(text)) contexts.add("balance");
  if (/portfolio|protfolio|holdings|allocation/.test(text)) contexts.add("portsum");
  if (/transfer|app home|demo profile|app help|demo app/.test(text)) contexts.add("app-home");
  if (/retirement|beneficiar|\b(?:retierment|retieremtn)\b/.test(text)) contexts.add("learning");
  if (!contexts.size && /\b(that|those|again|more)\b/.test(text) && recent?.length) contexts.add(recent.at(-1)!.contextId);
  const ambiguous = contexts.size > 1 || (!contexts.size && /help|explain|show|learn|what/.test(text) && !/weather|recipe|stock price|bitcoin/.test(text));
  const status = ambiguous ? "clarify" : contexts.size === 1 ? "selected" : "no_match";
  const asksForPortfolioValues = /\b(my|show|summarize|display)\b/.test(text) || /^(?:portfolio|protfolio) summary\W*$/.test(text);
  const showPortfolio = asksForPortfolioValues && !/\b(explain|terms|labels)\b/.test(text) && !/^what(?: is|'s) (?:a|the)\b/.test(text);
  const task = /compare|difference|versus/.test(text) ? "compare"
    : /guide|steps|checklist|how do|walk/.test(text) ? "guide"
    : (contexts.has("portsum") ? showPortfolio : /summary|how much|amount|show my/.test(text)) ? "show" : "explain";
  const contextId = status === "selected" ? [...contexts][0] : null;
  return {
    ...catalog,
    status, contextId, clarificationQuestion: status === "clarify" ? allowedQuestions[0] : null,
    intent: { task, topic: contextId ?? "demo topics", summary: "Deterministic test intent." },
  };
}

function compose({ body, envelope }: GatewayCall): ExperienceProposal | ToolCall {
  const eligible = envelope.eligible!;
  const text = envelope.request.toLowerCase();
  const get = (prefix: string) => eligible.candidates.find((item) => item.title.startsWith(prefix));
  const choose = (component: ComponentName, candidates: (typeof eligible.candidates[number] | undefined)[], introKey: ExperienceProposal["introKey"]): ExperienceProposal => {
    const chosen = candidates.every(Boolean) ? candidates as typeof eligible.candidates : [];
    if (eligible.selectionMode === "preserve_ts_rank") chosen.sort((a, b) => a.tsRank - b.tsRank);
    return {
      schemaVersion: "1.0", decisionId: eligible.decisionId, status: chosen.length ? "ready" : "no_match", intent: envelope.intent!,
      introKey: chosen.length ? introKey : "no_match", clarificationQuestion: null,
      blocks: chosen.length ? [{ blockId: "fixture", component, candidateIds: chosen.map((item) => item.candidateId), variant: "expanded" }] : [],
      followUpIds: [...new Set(chosen.flatMap((item) => item.followUps.map((followUp) => followUp.followUpId)))].slice(0, 3),
    };
  };
  if (envelope.selectedContextId === "balance" && envelope.intent?.task === "show") {
    const template = get("Synthetic balance summary");
    const tool = body.tools?.find(({ function: definition }) => definition.name.includes("balance"));
    if (template && tool && !body.messages.some((message) => message.role === "tool")) {
      return { id: "call_pzn_fixture", type: "function", function: { name: tool.function.name, arguments: "{}" } };
    }
    return choose("PznMetricSummary", [template], "summary");
  }
  if (envelope.selectedContextId === "balance" && envelope.intent?.task === "compare") {
    return choose("PznComparison", [get("Available balance"), get("Current balance")], "comparison");
  }
  if (envelope.selectedContextId === "portsum") {
    if (envelope.portfolioSnapshotIncluded) return choose("PznContentCard", [get("Explore investing options")], "summary");
    return choose("PznContentCard", [get("Understanding the fictional portfolio")], "explanation");
  }
  if (envelope.selectedContextId === "learning") {
    if (envelope.intent?.task === "guide") {
      return choose("PznStepList", [get("Update your beneficiaries")], "steps");
    }
    return choose("PznContentCard", [get("Retirement planning basics")], "explanation");
  }
  if (envelope.selectedContextId === "app-home") {
    if (envelope.intent?.task === "guide") return choose("PznStepList", [get("Fictional transfer checklist")], "steps");
    return choose("PznContentCard", [get("Learn about the fictional transfer")], "explanation");
  }
  if (/explain the available|available-balance term/.test(text)) {
    return choose("PznContentCard", [get("Available balance") ?? get("Understanding the demo balance")], "explanation");
  }
  return choose("PznContentCard", [get("Understanding the demo balance")], "explanation");
}

export async function startFixtureGateway(
  intercept?: TestInterceptor,
  authorize = (headers: IncomingHttpHeaders) => headers.authorization === "Bearer " + testKey,
) {
  const calls: GatewayCall[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      if (request.url !== "/v1/chat/completions" || !authorize(request.headers)) {
        response.writeHead(401).end(JSON.stringify({ error: { message: "Test gateway authorization failed" } }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as RequestBody;
      const envelope = fromMessage(body);
      if (!envelope || !body.stream) {
        response.writeHead(400).end(JSON.stringify({ error: { message: "Unknown test gateway request" } }));
        return;
      }
      const call = { envelope, body, headers: request.headers };
      calls.push(call);
      const override = intercept?.(call);
      if (override?.status) {
        response.writeHead(override.status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: override.errorMessage ?? "A controlled test failure" } }));
        return;
      }
      if (override?.delayMs) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, override.delayMs);
          response.once("close", () => { clearTimeout(timer); resolve(); });
        });
        if (response.destroyed) return;
      }

      const result = override?.json ?? (envelope.inputType === "PznContextRoutingInput" ? route(envelope) : compose(call));
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const write = (payload: unknown) => response.write("data: " + JSON.stringify(payload) + "\n\n");
      if ("function" in result && "id" in result) {
        write({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...result }] }, finish_reason: null }] });
        write({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        const text = override?.draft ?? JSON.stringify(result);
        const half = Math.ceil(text.length / 2);
        write({ choices: [{ index: 0, delta: { content: text.slice(0, half) }, finish_reason: null }] });
        write({ choices: [{ index: 0, delta: { content: text.slice(half) }, finish_reason: null }] });
        write({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      if (!override?.omitUsage) write({ choices: [], usage: { prompt_tokens: 430, completion_tokens: 109, total_tokens: 539 } });
      response.end("data: [DONE]\n\n");
    })().catch(() => { response.writeHead(500).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const settings: GatewaySettings = {
    baseUrl: "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/v1",
    apiKey: testKey, model: "pzn-automated-fixture", contextWindow: 16384, maxOutputTokens: 1500,
  };
  return { settings, calls, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
