import { mkdtemp, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "../apps/server/http";
import { gatewayFromEnv } from "../apps/server/gateway";
import type { SelectionMode } from "../packages/contracts/domain";
import type { TurnView } from "../packages/contracts/api";
import { testClient, testProject } from "./client";
import { liveCases, type LiveCase } from "./live-cases";

const useOpenAi = process.argv.includes("--openai");
const gateway = gatewayFromEnv(process.env, useOpenAi ? "openai" : "gateway");
if (!gateway) throw new Error("Set LLM_BASE_URL, LLM_MODEL, and LLM_API_KEY or LLM_GATEWAY_HEADERS_JSON before running gateway verification.");
const smoke = process.argv.includes("--smoke");
const modes: SelectionMode[] = smoke ? ["semantic_rerank"] : ["semantic_rerank", "preserve_ts_rank"];
const smokeCases = ["balance-compare", "metric-summary", "transfer-steps"];
if (useOpenAi) smokeCases.push("portfolio-summary-cash", "portfolio-summary-threshold");
const chosen = smoke ? liveCases.filter(({ id }) => smokeCases.includes(id)) : liveCases;

function p95(values: number[]) {
  return values.length ? Math.round([...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]) : null;
}
function ratio(results: boolean[]) {
  return { passed: results.filter(Boolean).length, total: results.length };
}

for (const selectionMode of modes) {
  const dir = await mkdtemp(join(tmpdir(), "pzn-live-eval-"));
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway, selectionMode });
  try {
    const client = await testClient(app.url);
    async function evaluate(entry: LiveCase) {
      const conversation = await client.conversation(entry.scenario, entry.persona);
      if (entry.prior) await client.ask(conversation.id, entry.prior);
      const start = performance.now();
      const accepted = await client.submit(conversation.id, entry.message);
      const stream = await client.response(accepted.eventsUrl);
      let first: number | null = null;
      const reader = stream.body?.getReader();
      if (reader) {
        let read = await reader.read();
        while (!read.done) {
          if (read.value.byteLength && first === null) first = performance.now() - start;
          read = await reader.read();
        }
      }
      const duration = performance.now() - start;
      const [turn, trace] = await Promise.all([client.turn(accepted.turnId), client.trace(accepted.turnId)]);
      const route = trace.selectedContextId ?? trace.routeOutcome;
      const outcome = turn.experience?.outcome ?? turn.failureCode;
      const contentOrder = trace.finalOrder ?? [];
      const relevant = (!entry.relevant || contentOrder.some((id) => entry.relevant!.includes(id)))
        && !contentOrder.some((id) => entry.exclude?.includes(id))
        && (!entry.component || Boolean(trace.components?.includes(entry.component)));
      return {
        id: entry.id, expectedRoute: entry.route, route, routeMatches: route === entry.route,
        expectedOutcome: entry.outcome, outcome, outcomeMatches: outcome === entry.outcome,
        relevant, checksRelevance: entry.relevant !== undefined, contentOrder,
        firstStatusMs: first, endToEndMs: duration, completed: turn.status === "completed",
        routerMs: trace.routeRun?.elapsedMs, composerMs: trace.composeRun?.elapsedMs,
        reportedTokens: [trace.routeRun, trace.composeRun].filter((item) => item?.tokensReported).length,
        estimatedTokens: [trace.routeRun, trace.composeRun].filter((item) => item && !item.tokensReported).length,
        metricReadSucceeded: trace.metricReadSucceeded,
        ...(trace.failures.length && { failureCodes: trace.failures.map(({ stage, code }) => ({ stage, code })) }),
      };
    }

    const results: Awaited<ReturnType<typeof evaluate>>[] = [];
    const concurrency = smoke ? 1 : 10;
    for (let offset = 0; offset < chosen.length; offset += concurrency) {
      results.push(...await Promise.all(chosen.slice(offset, offset + concurrency).map(evaluate)));
    }
    let cancelled: boolean | undefined;
    if (smoke) {
      const conversation = await client.conversation();
      const accepted = await client.submit(conversation.id, "Explain the balance labels in the fictional demo.");
      const end = await client.request<TurnView>("/api/turns/" + accepted.turnId + "/cancel", {});
      const recovered = await client.wait(accepted);
      cancelled = end.status === "cancelled" && recovered.turn.status === "cancelled" && !recovered.events.includes("event: experience.ready");
    }
    console.log(JSON.stringify({
      mode: selectionMode, verification: smoke ? "gateway_smoke" : "live_prompt_evaluation", concurrency,
      provider: useOpenAi ? "openai" : "gateway", model: gateway.model,
      contextChoice: ratio(results.filter(({ expectedRoute }) => expectedRoute !== "no_match" && expectedRoute !== "clarify").map(({ routeMatches }) => routeMatches)),
      clarification: ratio(results.filter(({ expectedRoute }) => expectedRoute === "clarify").map(({ routeMatches, outcomeMatches }) => routeMatches && outcomeMatches)),
      unsupported: ratio(results.filter(({ expectedRoute }) => expectedRoute === "no_match").map(({ routeMatches, outcomeMatches }) => routeMatches && outcomeMatches)),
      expectedOutcomes: ratio(results.map(({ outcomeMatches }) => outcomeMatches)),
      fixtureRelevance: ratio(results.filter(({ checksRelevance }) => checksRelevance).map(({ relevant }) => relevant)),
      completedTurns: ratio(results.map(({ completed }) => completed)),
      firstSseStatusP95Ms: p95(results.flatMap(({ firstStatusMs }) => firstStatusMs === null ? [] : [firstStatusMs])),
      successfulTurnP95Ms: p95(results.filter(({ completed }) => completed).map(({ endToEndMs }) => endToEndMs)),
      routerP95Ms: p95(results.flatMap(({ routerMs }) => routerMs === undefined ? [] : [routerMs])),
      composerP95Ms: p95(results.flatMap(({ composerMs }) => composerMs === undefined ? [] : [composerMs])),
      cancelled, cases: results,
    }, null, 2));
    if (results.some((item) => !item.routeMatches || !item.outcomeMatches || !item.relevant) || cancelled === false) process.exitCode = 1;
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}
