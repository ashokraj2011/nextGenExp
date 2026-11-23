import { ASK_USER, ToolError, type JsonObject, type NeutralModelRequest, type Principal, type RunResult, type SField, type ToolHandlerContext } from "@sfield/core";
import { z } from "zod";
import {
  axeBudget, capabilityRef, experienceAgentId, experienceProposalSchema, type CapabilityManifest, type Journey,
} from "../../packages/contracts/agentic";
import { DECISION_TTL } from "../../packages/contracts/domain";
import { fundingChoiceQuestion } from "../../packages/contracts/funding-workflow";
import type { RoutingHistoryEntry } from "../../packages/contracts/routing-intents";
import { compileAgenticExperience } from "../../packages/experience/agentic";
import { compileChatReply } from "../../packages/experience/compile";
import { Rejected, requireCheck } from "../../packages/experience/verify";
import { readTool, response, type AgenticExecution } from "./agentic-execution";
import { cancelsJourney, excludesPromotions, explicitInputs, isJourneyAnswer, pausesJourney, resumesJourney } from "./agentic-inputs";
import { axeRefs, closed, jsonString, list, proposalSchema } from "./agentic-model";
import { includeRequestedCapabilities } from "./execution-plan";
import { describe } from "./capability-registry";
import type { TurnRecord } from "./store";

export function axeToolAction(ref: string) {
  return ref.slice(0, ref.indexOf("@"));
}

const discoverySchema = z.object({
  goal: z.string().trim().min(1).max(360), contextIds: z.array(z.string().max(84)).max(axeBudget.contexts),
  requiredOutputs: z.array(z.string().max(40)).max(8), limit: z.number().int().min(1).max(10),
}).strict();
const readSchema = closed({
  goal: { ...jsonString, maxLength: 360 }, contextIds: list(jsonString, axeBudget.contexts),
  requiredOutputs: list(jsonString, 8), limit: { type: "integer", minimum: 1, maximum: 10 },
});
const normalizedRequest = (message: string) => message.trim().toLowerCase().replace(/[.!?]+$/, "");
const capabilityMatches = (message: string) => /\b(?:and|also|plus|then|while)\b|[;\n]/i.test(message);
const applicable = (journey: Journey) => !["cancelled", "failed", "completed"].includes(journey.status);

function projection(journey: Journey) {
  return {
    goalId: journey.goalId, objective: journey.objective, revision: journey.revision, status: journey.status,
    plan: journey.plan.steps,
    confirmations: journey.confirmations,
    results: journey.results.map(({ stepId, status, reason, missing }) => ({ stepId, status, reason, missing })),
  };
}

export class ExperienceAgent {
  private readonly planning = new Set<string>();
  private readonly resuming = new Set<string>();
  constructor(readonly execution: AgenticExecution, private readonly sf: () => SField) {}

  private get store() { return this.execution.store; }
  private get now() { return this.execution.now; }
  get registry() { return this.execution.registry; }

  private history(turn: TurnRecord) {
    return this.store.axe.list("journeys", turn.scope, turn.scope.conversationId, 48).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  shouldHandle(turn: TurnRecord) {
    if (turn.agentLaunch || turn.agentRunId) return true;
    const message = turn.public.message;
    if (resumesJourney(message)) return this.store.axe.activeJourneys(turn.scope).length > 0;
    const previous = this.history(turn)[0];
    if (previous && ((applicable(previous) && (cancelsJourney(message) || pausesJourney(message))) || isJourneyAnswer(message, previous))) return true;
    const matches = this.registry.matching(turn.scope.principalId, message);
    if (!matches.length) return false;
    const topics = new Set(matches.flatMap((item) => item.discovery.contexts));
    return matches.some(({ execution }) => execution.route === "goal")
      || (matches.length > 1 && topics.size > 1 && capabilityMatches(message))
      || (matches.length > 1 && /\bbeneficiar/i.test(message) && /\bretir/i.test(message))
      || excludesPromotions(message);
  }

  private async boundTurn(runId: string, principal?: Principal) {
    const run = await this.sf().persistence.getRun(runId);
    const turnId = run?.request.inputs?.turnRef;
    requireCheck(run?.agentId === experienceAgentId && run.kind === "standalone" && typeof turnId === "string"
      && run.idempotencyKey === turnId + ":experience-agent", "EXPERIENCE_RUN_NOT_BOUND");
    const turn = this.execution.current(turnId);
    requireCheck(run.tenantId === "pzn-local" && run.subjectId === turn.scope.principalId
      && (!turn.agentRunId || turn.agentRunId === runId)
      && (!principal || (principal.tenantId === run.tenantId && principal.subjectId === run.subjectId)), "EXPERIENCE_SCOPE_MISMATCH");
    return turn;
  }

  private discovered(turn: TurnRecord, runId: string) {
    const events = this.store.axe.list("decision_trace_events", turn.scope, turn.public.id);
    const refs = events.filter(({ type, runId: id }) => type === "capability.discovered" && id === runId)
      .flatMap(({ detail }) => Array.isArray(detail) ? detail : []).map(capabilityRef);
    const selected = turn.agentLaunch && "capability" in turn.agentLaunch ? capabilityRef(turn.agentLaunch.capability) : undefined;
    const available = this.registry.list(turn.scope.principalId).filter((item) => refs.includes(capabilityRef(item)));
    // The test run may add a prerequisite but must include its selected capability in the plan.
    return { available: new Map(available.map((item) => [capabilityRef(item), item])), selected };
  }

  async narrow(request: NeutralModelRequest, runId: string) {
    const run = await this.sf().persistence.getRun(runId);
    if (run?.agentId !== experienceAgentId) return;
    const turn = await this.boundTurn(runId);
    const { available } = this.discovered(turn, runId);
    const journey = this.execution.journey(turn);
    const askForMethod = journey?.status === "waiting_input" && !journey.pending
      && journey.clarifications < this.execution.budget.clarifications
      && journey.results.some(({ missing }) => missing?.includes("methodId"));
    const allowed = new Set<string>([axeRefs.discover]);
    if (available.size) {
      allowed.add(axeRefs.describe);
      allowed.add(axeRefs.plan);
    }
    if (askForMethod) allowed.add(ASK_USER.ref);
    const native = (await this.sf().persistence.listCalls(runId)).length;
    const business = this.store.axe.list("decision_trace_events", turn.scope, turn.public.id).filter(({ type }) => type === "tool.started").length;
    const tools = native + business < this.execution.budget.toolCalls ? request.tools.filter(({ ref }) => allowed.has(ref)) : [];
    return { ...request, tools, toolChoice: tools.length ? request.toolChoice : "none" } satisfies NeutralModelRequest;
  }

  async prepare(ref: string, runId: string, principal: Principal) {
    if (ref !== ASK_USER.ref) return;
    const run = await this.sf().persistence.getRun(runId);
    if (run?.agentId !== experienceAgentId) return;
    const turn = await this.boundTurn(runId, principal);
    const journey = this.execution.journey(turn);
    requireCheck(journey?.status === "waiting_input" && !journey.pending && journey.clarifications < this.execution.budget.clarifications
      && journey.results.some(({ missing }) => missing?.includes("methodId")), "CUSTOMER_INPUT_NOT_READY");
    return { inputs: { question: fundingChoiceQuestion, response_type: "string" } };
  }

  tools() {
    const turnFor = (ctx: ToolHandlerContext) => this.boundTurn(ctx.runId, ctx.principal);
    return [
      readTool(axeRefs.discover, "Find registered capabilities and active Treatment Selector contexts for the customer goal. Eligibility is checked later.", readSchema, async (args, ctx) => {
        const turn = await turnFor(ctx);
        const { goal, contextIds, requiredOutputs, limit } = discoverySchema.parse(args);
        const selected = turn.agentLaunch && "capability" in turn.agentLaunch ? this.registry.get(turn.scope.principalId, capabilityRef(turn.agentLaunch.capability)) : undefined;
        const query = selected ? goal + " " + selected.discovery.keywords.join(" ") : goal;
        return response(await this.execution.discover(turn, ctx.runId, query, contextIds, requiredOutputs, limit, ctx.signal));
      }),
      readTool(axeRefs.describe, "Show the input fields, prerequisites, approved components and exact version of a discovered capability.",
        closed({ capabilityId: jsonString, version: jsonString }), async (args, ctx) => {
          const turn = await turnFor(ctx);
          const { capabilityId: id, version } = z.object({ capabilityId: z.string(), version: z.string() }).parse(args);
          const capability = this.discovered(turn, ctx.runId).available.get(capabilityRef({ id, version }));
          if (!capability) throw new ToolError("CAPABILITY_NOT_DISCOVERED");
          return response(describe(capability, true));
        }),
      readTool(axeRefs.plan, "Propose a plan and execute verified independent reads and dependent steps. Use only discovered exact capability versions. No financial values or account IDs are accepted.",
        proposalSchema, async (args, ctx) => {
          const turn = await turnFor(ctx);
          if (this.planning.has(ctx.runId)) throw new ToolError("PLAN_ALREADY_RUNNING");
          const { available, selected } = this.discovered(turn, ctx.runId);
          const { steps } = args as { steps: { capabilityId: string; version: string }[] };
          if (selected && !steps.some(({ capabilityId: id, version }) => capabilityRef({ id, version }) === selected)) throw new ToolError("SELECTED_CAPABILITY_REQUIRED");
          this.planning.add(ctx.runId);
          try {
            return response(projection(await this.execution.execute(turn, args, ctx.principal, ctx.signal, available, ctx.runId)));
          } catch (error) {
            throw new ToolError(error instanceof Rejected ? error.code : "PLAN_EXECUTION_FAILED");
          } finally { this.planning.delete(ctx.runId); }
        }, this.execution.budget.activeSeconds * 1_000),
    ];
  }

  private selectPrior(turn: TurnRecord) {
    const launch = turn.agentLaunch;
    if (launch && "action" in launch) return this.store.axe.get("journeys", turn.scope, launch.action.journeyId);
    if (launch) return undefined;
    const history = this.history(turn);
    const latest = history[0];
    if (resumesJourney(turn.public.message)) {
      const local = history.filter(applicable);
      const pending = local.length ? local : this.store.axe.activeJourneys(turn.scope);
      if (pending.length > 1) return "ambiguous" as const;
      return pending[0];
    }
    if (latest && (isJourneyAnswer(turn.public.message, latest) || cancelsJourney(turn.public.message) || pausesJourney(turn.public.message))) return latest;
  }

  private async closePending(journey: Journey, principal: Principal) {
    if (!journey.pending) return;
    const prior = await this.sf().persistence.getRun(journey.runId);
    if (prior?.kind !== "standalone" || prior.agentId !== experienceAgentId || prior.tenantId !== principal.tenantId || prior.subjectId !== principal.subjectId) return;
    const handle = await this.sf().runs.get({ runId: journey.runId, principal });
    await handle.cancel("Superseded by a refreshed journey revision");
  }

  async respond(turn: TurnRecord, principal: Principal, recent: RoutingHistoryEntry[], signal: AbortSignal) {
    const prior = this.selectPrior(turn);
    if (prior === "ambiguous") {
      return compileChatReply("You have more than one open plan. Open the conversation for the plan you want to continue.", "reply", this.now());
    }
    if (turn.agentLaunch && "action" in turn.agentLaunch) {
      const { action } = turn.agentLaunch;
      requireCheck(prior && prior.revision === action.revision, "EXPERIENCE_REVISION_STALE");
    }
    if (prior) {
      if (this.resuming.has(prior.id)) return compileChatReply("This plan is already being updated. Please try again in a moment.", "reply", this.now());
      this.resuming.add(prior.id);
      try {
        if (cancelsJourney(turn.public.message) || pausesJourney(turn.public.message)) {
          const status = cancelsJourney(turn.public.message) ? "cancelled" : "paused";
          this.store.axe.saveJourney(turn.scope, { ...prior, status, pending: undefined, updatedAt: this.now() });
          this.execution.trace(turn, prior.runId, "journey." + status, undefined, prior.id);
          await this.closePending(prior, principal);
          return compileChatReply(status === "paused" ? "I’ll keep this plan here so you can return to it." : "I closed that plan.", "reply", this.now());
        }
        return await this.revise(turn, prior, principal, signal);
      } finally { this.resuming.delete(prior.id); }
    }
    return this.start(turn, principal, recent, signal);
  }

  private async revise(turn: TurnRecord, prior: Journey, principal: Principal, signal: AbortSignal) {
    const launch = turn.agentLaunch && "action" in turn.agentLaunch ? turn.agentLaunch : undefined;
    const admitted = new Map(this.registry.list(turn.scope.principalId).map((item) => [capabilityRef(item), item]));
    const { objective, intentType, steps } = prior.plan;
    // The checkpoint is linked to the earlier run. Each revision obtains current TS grants and fresh data.
    const journey = await this.execution.execute(turn, { objective, intentType, steps }, principal, signal, admitted, undefined, prior, launch?.values);
    await this.closePending(prior, principal);
    const saved = launch?.action.operation === "save" && journey.results.some((result) => (
      result.status === "completed" && result.capability === launch.action.capability
    ));
    if (saved) {
      const definition = admitted.get(launch.action.capability)!;
      const parameters = Object.fromEntries(definition.inputs.flatMap((field) => {
        const value = journey.inputs[field.id] ?? (field.type === "integer" ? field.default : undefined);
        return value === undefined ? [] : [[field.id, value]];
      }));
      this.store.axe.saveGoal(turn.scope, journey, parameters, this.now());
      this.execution.trace(turn, journey.runId, "goal.saved", { goalId: journey.goalId, parameters }, journey.id);
    }
    return this.compile(turn, journey, undefined, saved);
  }

  private async start(turn: TurnRecord, principal: Principal, recent: RoutingHistoryEntry[], signal: AbortSignal) {
    const sf = this.sf();
    const matches = this.registry.matching(turn.scope.principalId, turn.public.message);
    const data = {
      inputType: "PznExperienceGoalInput",
      request: turn.public.message, recent,
      customerContext: this.execution.world.projection(turn, new Set(matches.flatMap((item) => item.discovery.contexts)),
        new Set(matches.flatMap((item) => item.inputs.map(({ id }) => id)))),
      constraints: { excludePromotions: this.execution.world.exclusions(turn) },
      ...(turn.agentLaunch && "capability" in turn.agentLaunch && { requestedCapability: turn.agentLaunch.capability }),
    };
    signal.throwIfAborted();
    const handle = await sf.runs.start({
      agent: experienceAgentId, principal,
      request: { idempotencyKey: turn.public.id + ":experience-agent", inputs: { turnRef: turn.public.id }, message: { text: JSON.stringify(data) } },
    });
    const cancel = () => { void handle.cancel("Application turn ended").catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) cancel();
      this.store.update(turn.public.id, (row) => { row.agentRunId = handle.id; });
      const result = await handle.result();
      signal.throwIfAborted();
      const latest = this.execution.current(turn.public.id);
      let journey = this.execution.journey(latest);
      const parsed = experienceProposalSchema.safeParse(result.output);
      const proposal = parsed.success ? parsed.data : undefined;
      this.recordUsage(turn, result, journey?.id);
      if (result.state === "waiting_input" && journey) {
        const requestId = result.pending?.inputs[0];
        const input = requestId ? await sf.persistence.getInputRequest(requestId) : undefined;
        requireCheck(input?.runId === handle.id && input.status === "pending" && requestId, "CUSTOMER_INPUT_NOT_READY");
        journey = { ...journey, pending: { requestId, expiresAt: Date.parse(input.expiresAt) }, clarifications: journey.clarifications + 1 };
        this.store.axe.saveJourney(turn.scope, journey);
        this.execution.trace(turn, handle.id, "journey.paused", { requestId, reason: "customer_input_required" }, journey.id);
      }
      if (journey) {
        if (journey.status === "waiting_input" && !journey.pending) {
          this.execution.trace(turn, handle.id, "journey.paused", { reason: "awaiting_validated_form" }, journey.id);
        }
        return this.compile(turn, journey, proposal, false);
      }
      if (proposal && result.state === "completed" && !turn.agentLaunch
        && !this.store.axe.list("decision_trace_events", turn.scope, turn.public.id).some(({ type, detail }) => (
          type === "plan.rejected" && (detail as { reason?: string } | undefined)?.reason !== "PLAN_MISSING_EVIDENCE_DEPENDENCY"
        ))) {
        const { available } = this.discovered(latest, handle.id);
        const requested = this.registry.explicitMatches(turn.scope.principalId, turn.public.message).filter((item) => available.has(capabilityRef(item)));
        if (requested.length) {
          const plan = includeRequestedCapabilities({ objective: requested.map(({ title }) => title).join(" and ").slice(0, 360), intentType: "planning", steps: [] }, requested, available);
          if (plan.steps.length) {
            this.execution.trace(turn, handle.id, "plan.recovered", { reason: "EXPLICIT_REQUEST_MATCH" });
            const verified = await this.execution.execute(latest, plan, principal, signal, available, handle.id);
            if (verified.status === "waiting_input") {
              this.execution.trace(turn, handle.id, "journey.paused", { reason: "awaiting_validated_form" }, verified.id);
            }
            return this.compile(turn, verified, proposal, false);
          }
        }
      }
      if (proposal?.disposition === "pass") return;
      return compileChatReply(proposal?.disposition === "clarify"
        ? "Which account or goal would you like to look at first?"
        : "I couldn’t put that request together. Try again or ask for one part of it.", "reply", this.now());
    } finally { signal.removeEventListener("abort", cancel); }
  }

  partial(turn: TurnRecord) {
    const journey = this.execution.journey(turn);
    if (journey?.turnId !== turn.public.id || !journey.results.some(({ evidenceIds }) => evidenceIds.length)) return;
    const checkpoint: Journey = { ...journey, status: "partially_completed", updatedAt: this.now() };
    this.store.axe.saveJourney(turn.scope, checkpoint);
    this.execution.trace(turn, journey.runId, "journey.paused", { reason: "TURN_BUDGET_EXHAUSTED" }, journey.id);
    return this.compile(turn, checkpoint, undefined);
  }

  private recordUsage(turn: TurnRecord, result: RunResult, journeyId?: string) {
    this.execution.trace(turn, result.runId, "model.usage", { state: result.state, ...result.usage, ...(result.error && { error: result.error.code }) }, journeyId);
  }

  private compile(turn: TurnRecord, journey: Journey, proposal: z.infer<typeof experienceProposalSchema> | undefined, saved = false) {
    const { runId, id } = journey;
    this.execution.trace(turn, runId, "experience.proposed", proposal ?? { source: "verified_plan" }, id);
    const mid = this.execution.persona(turn).syntheticMid;
    const now = this.now();
    const verified = new Map(journey.results.flatMap((step) => {
      const manifest = this.registry.get(turn.scope.principalId, step.capability);
      if (!manifest) return [];
      const records = step.evidenceIds.flatMap((evidenceId) => {
        const evidence = this.store.axe.get("evidence_records", turn.scope, evidenceId);
        if (!evidence || evidence.journeyId !== id || evidence.customerRef !== mid
          || evidence.stepId !== step.stepId || !manifest.tools.includes(evidence.source)) return [];
        const historicalReview = evidence.outputKind === "address" && evidence.runId !== runId;
        const grants = historicalReview ? this.store.axe.list("eligibility_grants", turn.scope, turn.public.id) : [
          this.store.axe.get("eligibility_grants", turn.scope, evidence.grantId),
        ];
        const grant = grants.find((item) => item?.turnId === turn.public.id && item.runId === runId && item.expiresAt > now
          && item.allowedUses.some(({ capabilityId, version, tools }) => capabilityId === manifest.id && version === manifest.version && tools.includes(evidence.source)));
        const tool = this.registry.tool(evidence.source);
        if (!grant || tool.output !== evidence.outputKind || !tool.schema.safeParse(evidence.payload).success) return [];
        return historicalReview ? [{ ...evidence, expiresAt: grant.expiresAt }]
          : evidence.runId === runId && evidence.expiresAt > now ? [evidence] : [];
      });
      return [[step.stepId, { manifest, records, status: step.status, reason: step.reason }] as const];
    }));
    if (journey.excludePromotions) this.execution.trace(turn, runId, "recommendation.suppressed", { reason: "CUSTOMER_EXCLUDED_PROMOTIONS" }, id);
    const expiresAt = Math.min(now + DECISION_TTL, ...[...verified.values()].flatMap(({ records }) => records.map(({ expiresAt }) => expiresAt)));
    const { ir, result } = compileAgenticExperience(journey, verified, proposal, expiresAt, saved);
    this.store.axe.insert("experience_revisions", turn.scope, result.display.experienceId, turn.public.id, ir);
    this.execution.trace(turn, runId, "experience.verified", { experienceId: result.display.experienceId, ir }, id);
    this.execution.trace(turn, runId, "journey.checkpoint", projection(journey), id);
    return result;
  }
}
