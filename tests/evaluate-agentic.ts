import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "../apps/server/http";
import { gatewayFromEnv } from "../apps/server/gateway";
import type { DisplayBlock } from "../packages/contracts/surface";
import type { DecisionEvent } from "../packages/contracts/agentic";
import type { Trace } from "../apps/web/api";
import { testClient, testProject } from "./client";

const gateway = gatewayFromEnv(process.env, process.argv.includes("--openai") ? "openai" : "gateway");
if (!gateway) throw new Error("Connect a model gateway or pass --openai with OPENAI_API_KEY.");
const dataDir = await mkdtemp(join(tmpdir(), "pzn-agentic-eval-"));
const open = () => startApp({ projectRoot: fileURLToPath(testProject), dataDir, gateway });
let app = await open();

function usage(trace: Trace) {
  const sample = trace.agentic?.events.find(({ type }) => type === "model.usage")?.detail as Record<string, number> | undefined;
  const legacy = [trace.routeRun, trace.composeRun];
  const measured = {
    modelCalls: sample?.modelCalls ?? legacy.reduce((total, run) => total + (run?.modelCalls ?? 0), 0),
    toolCalls: sample ? sample.toolCalls + (trace.agentic?.events.filter(({ type }) => type === "tool.started").length ?? 0) : undefined,
    tokens: sample?.totalTokens ?? legacy.reduce((total, run) => total + (run?.totalTokens ?? 0), 0),
    activeMs: sample?.activeMs,
  };
  return measured;
}
function summary(observation: Awaited<ReturnType<Awaited<ReturnType<typeof testClient>>["ask"]>>, id: string, passed: boolean, latencyMs: number) {
  const { turn, trace } = observation;
  return {
    id, path: trace.agentic ? "goal" : "fast", passed, latencyMs,
    blocks: turn.experience?.blocks.map(({ component }) => component) ?? [],
    ...usage(trace),
    failures: trace.failures,
  };
}
const has = (blocks: DisplayBlock[], component: DisplayBlock["component"]) => blocks.some((block) => block.component === component);
const hasTitle = (blocks: DisplayBlock[], title: string) => blocks.some(({ props }) => "title" in props && props.title === title);
const amountMatches = (blocks: DisplayBlock[], amountCents: number) => blocks.some((block) => (
  block.component === "PznFundingPreview" && block.props.amountCents === amountCents
));
const a = "demo-learner", j = "demo-returning", m = "demo-new-account";
const cases = [
  { id: "fast-balance", persona: a, prompt: "Compare available and current balances.", check: (blocks: DisplayBlock[]) => has(blocks, "PznComparison") },
  { id: "fast-portfolio", persona: j, prompt: "Show me my portfolio summary.", check: (blocks: DisplayBlock[]) => has(blocks, "PznPortfolioSnapshot") },
  {
    id: "home-plan", persona: a, prompt: "I want to buy a house in two years. Show me how close I am and help me explore a savings plan.",
    check: (blocks: DisplayBlock[]) => has(blocks, "PznGoalProgress") && (has(blocks, "PznPortfolioSnapshot") || hasTitle(blocks, "Available portfolio cash"))
      && has(blocks, "PznSavingsChart") && has(blocks, "PznCapabilityForm"),
  },
  {
    id: "onboarding", persona: m, prompt: "I moved recently and want to deposit $500 into my investment account.",
    check: (blocks: DisplayBlock[]) => hasTitle(blocks, "Prepare an address change") && has(blocks, "PznFundingOptions"),
  },
  { id: "direct-funding", persona: m, prompt: "Deposit $500 from my linked bank account.", check: (blocks: DisplayBlock[]) => amountMatches(blocks, 50_000) },
  {
    id: "retirement-alice", persona: a, prompt: "Help me learn about retirement and review my beneficiary details.",
    check: (blocks: DisplayBlock[]) => hasTitle(blocks, "Retirement planning basics") && hasTitle(blocks, "Update your beneficiaries"),
  },
  {
    id: "retirement-jordan", persona: j, prompt: "Help me learn about retirement and review my beneficiary details.",
    check: (blocks: DisplayBlock[]) => hasTitle(blocks, "Retirement planning basics") && !hasTitle(blocks, "Update your beneficiaries"),
  },
  {
    id: "required-contribution", persona: a, prompt: "How much do I need to save each month to reach my house deposit target?",
    check: (blocks: DisplayBlock[]) => blocks.some((block) => block.component === "PznSavingsMetric" && block.props.monthlyCents === 100_000),
  },
];
const results: ReturnType<typeof summary>[] = [];
try {
  let client = await testClient(app.url);
  results.push(...await Promise.all(cases.map(async (entry) => {
    const thread = await client.conversation("normal", entry.persona);
    const started = Date.now();
    const observation = await client.ask(thread.id, entry.prompt);
    const passed = observation.turn.status === "completed" && entry.check(observation.turn.experience?.blocks ?? []);
    return summary(observation, entry.id, passed, Date.now() - started);
  })));

  const thread = await client.conversation("normal", m);
  const initial = await client.ask(thread.id, "I want to deposit $500 into my investment account.");
  const paused = initial.trace.agentic?.events.some(({ type }: DecisionEvent) => type === "journey.paused");
  const cookie = client.cookie;
  await app.close();
  app = await open();
  client = await testClient(app.url, cookie);
  const started = Date.now();
  const resumed = await client.ask(thread.id, "Use the linked bank account.");
  const refresh = resumed.trace.agentic?.events.some(({ type }) => type === "eligibility.granted");
  results.push(summary(resumed, "restart-and-resume", Boolean(paused && refresh && amountMatches(resumed.turn.experience?.blocks ?? [], 50_000)), Date.now() - started));

  const event = { eventId: "eval_first_deposit", personaId: m, type: "account.first_deposit.completed" };
  const first = await client.request<{ accepted: boolean }>("/api/admin/customer-events", event);
  const duplicate = await client.request<{ accepted: boolean }>("/api/admin/customer-events", event);
  const nextStarted = Date.now();
  const next = await client.ask(thread.id, "What is next?");
  results.push(summary(next, "first-deposit-event", first.accepted && !duplicate.accepted
    && hasTitle(next.turn.experience?.blocks ?? [], "Your first deposit is on file"), Date.now() - nextStarted));

  const aggregate = (path: string) => {
    const matching = results.filter((row) => row.path === path);
    return { cases: matching.length, passed: matching.filter(({ passed }) => passed).length,
      medianMs: matching.map(({ latencyMs }) => latencyMs).sort((x, y) => x - y)[Math.floor(matching.length / 2)],
      modelCalls: matching.reduce((total, row) => total + row.modelCalls, 0),
      tokens: matching.reduce((total, row) => total + row.tokens, 0),
    };
  };
  console.log(JSON.stringify({
    provider: gateway.profile ?? "gateway", model: gateway.model, passed: results.filter(({ passed }) => passed).length,
    total: results.length, fastPath: aggregate("fast"), goalPath: aggregate("goal"), cases: results,
  }, null, 2));
  if (results.some(({ passed }) => !passed)) process.exitCode = 1;
} finally {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
