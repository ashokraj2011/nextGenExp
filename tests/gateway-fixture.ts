import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { GatewaySettings } from "../apps/server/gateway";
import type { ComponentName, ContextSelectionProposal, ExperienceProposal, Intent } from "../packages/contracts/domain";
import { isSubjectlessSummaryRequest, leavingWorkQuestion, portfolioSummaryQuestion, retirementQuestion, type RoutingHistoryEntry, type RoutingIntent, type RoutingIntentId } from "../packages/contracts/routing-intents";
import type { modelBundle } from "../packages/experience/content";

type Envelope = {
  inputType: "PznContextRoutingInput" | "PznExperienceCompositionInput";
  request: string;
  catalogSnapshotId?: string;
  catalog?: { catalogVersion: string; contexts: { contextId: string }[] };
  propensity?: unknown;
  recent?: RoutingHistoryEntry[];
  intentCatalog?: RoutingIntent[];
  summaryFollowUpIntentId?: RoutingIntentId;
  selectedContextId?: string;
  selectedIntentId?: RoutingIntentId;
  intent?: Intent;
  eligible?: ReturnType<typeof modelBundle>;
  allowedQuestions: string[];
  canCreateRule?: boolean;
  portfolioSnapshotIncluded?: boolean;
  goalProgressIncluded?: boolean;
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

function asksToSeeGoals(text: string) {
  const request = text.replace(/^(?:please |(?:can|could|would) (?:i|you) )/, "");
  const topic = request.replace(/^(?:show(?: me)?|view|see|check|review|where (?:is|are)|what (?:about|happen(?:e)?d to)) /, "");
  return /^(?:(?:my|the|savings) )?goals?[.!?]*$/.test(topic);
}

function route(envelope: Envelope): ContextSelectionProposal {
  const { request, recent, allowedQuestions, summaryFollowUpIntentId, intentCatalog = [] } = envelope;
  const text = request.toLowerCase().trim();
  const base = {
    schemaVersion: "1.1" as const, catalogSnapshotId: envelope.catalogSnapshotId!, catalogVersion: envelope.catalog!.catalogVersion,
    summary: "Deterministic test intent.", replyText: null,
  };
  const noMatch: ContextSelectionProposal = {
    ...base, status: "no_match", intentId: null, clarificationQuestion: null,
  };
  const reply = (replyText: string): ContextSelectionProposal => (
    { ...base, status: "reply", intentId: null, clarificationQuestion: null, replyText }
  );
  const clarify = (clarificationQuestion = allowedQuestions[0], intentId: RoutingIntentId | null = null): ContextSelectionProposal => (
    { ...base, status: "clarify", intentId, clarificationQuestion }
  );
  const select = (intentId: RoutingIntentId): ContextSelectionProposal => (
    { ...base, status: "selected", intentId, clarificationQuestion: null }
  );
  if (summaryFollowUpIntentId) return select(summaryFollowUpIntentId);
  const previous = recent?.at(-1);
  if (/^(?:hi|hello|hey|how are you)[!.?]*$/.test(text)) return reply("Hi! What would you like to talk about?");
  if (/^(?:(?:that(?:['’]s|s| is) )?(?:nice|great|cool|helpful|interesting)|thanks|thank you|got it)[!.?]*$/.test(text)) {
    return reply(previous?.contextId === "learning"
      ? "Glad that helped. I’m here if more retirement questions come up."
      : "Glad it helped. What else is on your mind?");
  }
  if (previous?.assistantReply && /^what did you (?:just )?say\??$/.test(text)) return reply(previous.assistantReply);
  if (/^(?:(?:please|i want to|can you|i'd like to) )?(?:create|add) (?:(?:a|new|a new) )?(?:ccre |treatment selector )?rule\b/.test(text)) {
    return intentCatalog.some(({ intentId }) => intentId === "create_rule")
      ? { ...base, status: "create_rule", intentId: "create_rule", clarificationQuestion: null }
      : noMatch;
  }
  if (/\b(?:job search|unemployment|layoff assistance|(?:find|look(?:ing)? for) (?:a )?new job)\b/.test(text)) return noMatch;
  if (/^(?:what(?:'s| is) next(?: for me)?|what (?:should|can|do) i do (?:next|now)|what (?:is|are) my next steps?|now what)[.!?]*$/.test(text.replaceAll("’", "'"))
    && intentCatalog.some(({ intentId }) => intentId === "suggest_next_step")) return select("suggest_next_step");

  const contexts = new Set<string>();
  const retirementTopic = /\b(?:retire|retiring|retirement|retierment|retieremtn)\b/;
  if (/balance|ledger|available term/.test(text)) contexts.add("balance");
  if (/portfolio|protfolio|holdings|allocation/.test(text)) contexts.add("portsum");
  if (/transfer|app home|demo profile|app help|demo app/.test(text)) contexts.add("app-home");
  if (retirementTopic.test(text) || /beneficiar/.test(text)) contexts.add("learning");
  if (/\b(?:address (?:update|change)|(?:update|change|edit|correct) (?:my |the |a )?(?:(?:mailing|home|street|postal|residential) )?address)\b/.test(text)) {
    contexts.add("address-update");
  }
  if (/\b(?:down[ -]payment|home[ -]buying|home purchase|buy(?:ing)? (?:a |my |the )?(?:home|house)|mortgage (?:goal|progress|savings)|goal progress|my (?:savings )?goal)\b/.test(text)) contexts.add("goals");
  if (!contexts.size && asksToSeeGoals(text)) contexts.add("goals");

  if (!contexts.size) {
    const previousTopic = recent?.findLast(({ contextId }) => contextId !== null);
    const priorQuestion = previous?.clarificationQuestion;
    const confirms = /^(?:yes\b|sure\b|correct\b|that'?s right\b)/.test(text);
    const askedAboutPortfolioSummary = priorQuestion === portfolioSummaryQuestion;
    const portfolioIntent = intentCatalog.find(({ intentId }) => intentId === "show_portfolio");
    if (askedAboutPortfolioSummary && confirms && portfolioIntent) return select(portfolioIntent.intentId);
    if (portfolioIntent && isSubjectlessSummaryRequest(request)) {
      return clarify(portfolioSummaryQuestion, portfolioIntent.intentId);
    }

    const establishedRetirement = previousTopic?.intentId === "retirement_learning"
      || (previousTopic?.contextId === "learning" && retirementTopic.test(previousTopic.request.toLowerCase()));
    const askedAboutRetirement = priorQuestion === retirementQuestion || priorQuestion === leavingWorkQuestion;
    const confirmedRetirement = askedAboutRetirement && confirms;
    const leavingWork = /\blast day (?:at|of) (?:(?:my|the) )?(?:job|work)\b/.test(text);
    const losingJob = /\b(?:lose|loose|lost|losing) (?:my|the) job\b/.test(text);
    const ageClue = /\b(?:(?:will be|turning|turn|i am|i'm) [5-8]\d|am old|getting older)\b/.test(text);
    if (confirmedRetirement || (establishedRetirement && (ageClue || leavingWork))) contexts.add("learning");
    else if (ageClue || leavingWork || losingJob) {
      const possibleIntent = intentCatalog.find(({ intentId }) => intentId === "retirement_learning");
      return clarify(leavingWork || losingJob ? leavingWorkQuestion : retirementQuestion, possibleIntent?.intentId ?? null);
    }
    else if ((askedAboutRetirement || askedAboutPortfolioSummary) && /^(?:no|not really)[.!]*$/.test(text)) return clarify();
    else if (previousTopic?.contextId && /\b(that|those|again|more)\b/.test(text)) contexts.add(previousTopic.contextId);
  }
  if (contexts.size > 1) return clarify();
  if (!contexts.size) {
    if (/weather|recipe|stock price|bitcoin|rental car/.test(text)) return noMatch;
    return /help|explain|show|learn|what|\bhow\b|\?$/.test(text) ? clarify() : reply("I’m here. What would you like to talk about?");
  }

  const asksForPortfolioValues = /\b(my|show|summarize|display)\b/.test(text) || /^(?:portfolio|protfolio) summary\W*$/.test(text);
  const showPortfolio = asksForPortfolioValues && !/\b(explain|terms|labels)\b/.test(text) && !/^what(?: is|'s) (?:a|the)\b/.test(text);
  const task = contexts.has("goals") ? "show" : contexts.has("address-update") ? "guide" : /compare|difference|versus/.test(text) ? "compare"
    : /guide|steps|checklist|how do|walk/.test(text) ? "guide"
    : (contexts.has("portsum") ? showPortfolio : /summary|how much|amount|show my/.test(text)) ? "show" : "explain";
  const contextId = [...contexts][0];
  const choice = intentCatalog.find((item) => item.contextId === contextId && item.task === task)
    ?? intentCatalog.find((item) => item.contextId === contextId && item.task === "explain");
  return choice && choice.contextId !== null ? select(choice.intentId) : noMatch;
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
    const template = get("Balance summary");
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
    return choose("PznContentCard", [get("Understanding your portfolio")], "explanation");
  }
  if (envelope.selectedContextId === "goals" && envelope.goalProgressIncluded) {
    return choose("PznGoalProgress", [get("Home down payment")], "summary");
  }
  if (envelope.selectedContextId === "learning") {
    if (envelope.intent?.task === "guide") {
      return choose("PznStepList", [get("Update your beneficiaries")], "steps");
    }
    return choose("PznContentCard", [get("Retirement planning basics")], "explanation");
  }
  if (envelope.selectedContextId === "address-update") {
    return choose("PznStepList", [get("Update your mailing address")], "steps");
  }
  if (envelope.selectedContextId === "next-step") {
    return { ...choose("PznContentCard", [get("Fund your account")], "next_step"), followUpIds: [] };
  }
  if (envelope.selectedContextId === "app-home") {
    if (envelope.intent?.task === "guide") return choose("PznStepList", [get("Transfer checklist")], "steps");
    return choose("PznContentCard", [get("How transfers work")], "explanation");
  }
  if (/explain the available|available-balance term/.test(text)) {
    return choose("PznContentCard", [get("Available balance") ?? get("Understanding your balances")], "explanation");
  }
  return choose("PznContentCard", [get("Understanding your balances")], "explanation");
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
