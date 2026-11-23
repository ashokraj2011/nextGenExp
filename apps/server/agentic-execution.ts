import { defineTool, ToolError, type DefineToolInput, type JsonObject, type JsonValue, type Principal, type SField, type ToolHandlerContext, type ToolResult } from "@sfield/core";
import host from "../../fixtures/host.json";
import { addressFields, capabilityRef, type ExecutionBudget, type CapabilityManifest, type EligibilityGrant, type Evidence, type ExecutionPlan, type InputValues, type Journey, type OutputKind, type PlanProposal, type StepResult } from "../../packages/contracts/agentic";
import { DECISION_TTL } from "../../packages/contracts/domain";
import { fundingStatusSchema } from "../../packages/contracts/funding-workflow";
import type { PortfolioSnapshotProvider } from "../../packages/portfolio-snapshot";
import type { GoalProgressProvider } from "../../packages/goal-progress";
import { makeId } from "../../packages/experience/compile";
import { Rejected, requireCheck } from "../../packages/experience/verify";
import { FixtureTsAdapter, type TsAdapter } from "../../packages/ts-adapter";
import { normalizeRecommendations } from "../../packages/ts-adapter/recommendations";
import { capabilityTools, type CapabilityTool } from "../../packages/capabilities";
import { CapabilityRegistry, describe } from "./capability-registry";
import { EligibilityAuthority, type EligibilityDecision } from "./eligibility-authority";
import { includeRequestedCapabilities, independentSteps, verifyPlan } from "./execution-plan";
import { CustomerWorldModel } from "./customer-world-model";
import { explicitInputs, fieldValueValid } from "./agentic-inputs";
import { outputKinds } from "../../packages/contracts/agentic";
import { axeRefs, closed, jsonString } from "./agentic-model";
import type { Store, TurnRecord } from "./store";

type Payload = { data: string };
export const response = (value: unknown): Payload => ({ data: JSON.stringify(value) });
export const resultSchema = closed({ data: { type: "string", maxLength: 42_000 } });
function readResult(result: ToolResult): unknown {
  requireCheck(result.status === "succeeded" && result.output && typeof result.output === "object" && !Array.isArray(result.output)
    && typeof result.output.data === "string", result.error?.code ?? "TOOL_UNAVAILABLE");
  return JSON.parse(result.output.data);
}
const reasonCode = (error: unknown) => error instanceof Rejected ? error.code : error instanceof ToolError ? error.code : "TOOL_UNAVAILABLE";

type Persona = typeof host.personas[number];
type BoundRead =
  | { kind: "decision"; contextId: string }
  | { kind: "capability"; journeyId: string; stepId: string; tool: CapabilityTool; manifest: CapabilityManifest; grant: EligibilityGrant;
      decision: EligibilityDecision; values: InputValues; prior: Partial<Record<OutputKind, unknown>> };

type Scope = {
  turnId: string; runId: string; principal: Principal; persona: Persona; adapter: FixtureTsAdapter; leases: Map<string, BoundRead>;
};

export function readTool(ref: string, description: string, inputs: JsonObject, handler: DefineToolInput["handler"], timeoutMs = 5_000) {
  const [id, version] = ref.split("@");
  return defineTool({
    id, version, description, inputs, outputs: resultSchema, handler,
    policy: {
      action: id, effect: "read", requiresApproval: false, maxAttempts: 1, timeoutMs, classification: "public", maxOutputBytes: 48_000,
    },
  });
}

async function finishBatch<T>(work: Promise<T>[]) {
  const results = await Promise.allSettled(work);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
}

function addCompanions(plan: PlanProposal, admitted: ReadonlyMap<string, CapabilityManifest>, request: string): PlanProposal {
  if (plan.intentType !== "planning" || /\b(?:only|just)\b/i.test(request)) return plan;
  const refs = new Set(plan.steps.map(({ capabilityId: id, version }) => capabilityRef({ id, version })));
  const seenIds = new Set(plan.steps.map(({ id }) => id));
  const steps = [...plan.steps];
  for (const ref of [...refs]) {
    for (const companion of admitted.get(ref)?.discovery.planningCompanions ?? []) {
      const manifest = admitted.get(companion);
      if (!manifest || refs.has(companion) || steps.length === 6) continue;
      let id = "companion_" + steps.length;
      while (seenIds.has(id)) id += "_";
      steps.push({ id, capabilityId: manifest.id, version: manifest.version, required: false, dependsOn: [] });
      refs.add(companion);
      seenIds.add(id);
    }
  }
  return { ...plan, steps };
}

export class AgenticExecution {
  readonly registry: CapabilityRegistry;
  readonly world: CustomerWorldModel;
  private readonly scopes = new Map<string, Scope>();
  private readonly grants: EligibilityAuthority;

  constructor(
    readonly store: Store, readonly sf: () => SField, readonly now: () => number, readonly current: (turnId: string) => TurnRecord,
    private readonly portfolios: PortfolioSnapshotProvider, private readonly goals: GoalProgressProvider, readonly budget: ExecutionBudget,
  ) {
    this.registry = new CapabilityRegistry(store);
    this.world = new CustomerWorldModel(store, now);
    this.grants = new EligibilityAuthority(store, now);
  }

  persona(turn: TurnRecord) {
    const persona = host.personas.find(({ personaId }) => personaId === turn.scope.personaId);
    requireCheck(persona, "PERSONA_MISMATCH");
    return persona;
  }

  adapter(turn: TurnRecord) {
    const conversation = this.store.conversation(turn.scope.conversationId, turn.scope.principalId);
    return new FixtureTsAdapter(
      { scenarioId: conversation.scenarioId, ordinal: turn.ordinal }, turn.toolSetup?.treatmentOverrides, turn.toolSetup?.ccreRules,
      this.portfolios, this.store.axe.fundingStatus(turn.scope),
    );
  }

  trace(turn: TurnRecord, runId: string, type: string, detail?: unknown, journeyId?: string) {
    this.store.axe.trace(turn.scope, { type, detail, at: this.now(), turnId: turn.public.id, runId, journeyId });
  }

  tools() {
    const invoke = (ref: string) => async (args: JsonObject, context: ToolHandlerContext) => {
      try { return await this.boundRead(ref, args, context); }
      catch (error) { throw new ToolError(reasonCode(error)); }
    };
    const input = closed({ lease: jsonString, turnRef: jsonString, target: jsonString, parameters: jsonString });
    return [
      readTool(axeRefs.treatment, "Read Treatment Selector recommendations for a verified context and customer.", input, invoke(axeRefs.treatment)),
      ...capabilityTools.map((tool) => readTool(tool.ref, tool.label, input, invoke(tool.ref))),
    ];
  }

  private async boundRead(ref: string, { lease, turnRef, target }: JsonObject, ctx: ToolHandlerContext): Promise<JsonValue> {
    const scope = this.scopes.get(ctx.runId);
    requireCheck(scope && scope.turnId === turnRef && !ctx.agentId && ctx.principal.tenantId === scope.principal.tenantId
      && ctx.principal.subjectId === scope.principal.subjectId && typeof lease === "string", "EXECUTION_SCOPE_MISMATCH");
    const bound = scope.leases.get(lease);
    scope.leases.delete(lease);
    const turn = this.current(scope.turnId);
    const mid = scope.persona.syntheticMid;
    ctx.signal.throwIfAborted();
    if (bound?.kind === "decision") {
      requireCheck(ref === axeRefs.treatment && target === bound.contextId && turn.toolSetup?.enabled.selection !== false, "TREATMENT_UNAVAILABLE");
      const request = { mid, context: bound.contextId };
      const result = await scope.adapter.selectRecommendations(request, ctx.signal);
      return response({ request, response: result.response, ccre: result.ccre ?? null });
    }
    requireCheck(bound?.kind === "capability" && bound.tool.ref === ref && target === bound.stepId
      && bound.grant.runId === scope.runId, "CAPABILITY_SCOPE_MISMATCH");
    const { manifest, grant, decision, tool, values, prior } = bound;
    this.grants.require(turn, grant, ref, manifest, mid);
    requireCheck(!tool.enabledKey || turn.toolSetup?.enabled[tool.enabledKey] !== false, "TOOL_DISABLED");
    requireCheck((tool.uses ?? []).every((kind) => prior[kind] !== undefined), "VERIFIED_PREREQUISITE_REQUIRED");
    requireCheck((tool.requiredFields ?? []).every((field) => fieldValueValid(field, values[field.id], prior.fundingOptions)), "INVALID_CUSTOMER_INPUT");
    const fundingStatus = fundingStatusSchema.shape.accountFundingStatus.parse(this.store.axe.fundingStatus(turn.scope) ?? scope.persona.accountFundingStatus);
    if (tool.uses?.includes("fundingStatus")) {
      requireCheck(fundingStatus === "unfunded" && fundingStatusSchema.parse(prior.fundingStatus).accountFundingStatus === "unfunded", "ACCOUNT_ALREADY_FUNDED");
    }
    const value = await tool.invoke({
      personaId: scope.persona.personaId, mid, fundingStatus, values, prior, eligibleContent: decision.contentIds, now: this.now(),
      signal: ctx.signal, goals: this.goals, portfolio: this.portfolios,
    });
    ctx.signal.throwIfAborted();
    return response(tool.schema.parse(value));
  }

  async discover(turn: TurnRecord, runId: string, goal: string, contextIds: string[], requiredOutputs: string[], limit: number, signal: AbortSignal) {
    requireCheck(turn.toolSetup?.enabled.catalog !== false, "CATALOG_UNAVAILABLE");
    const adapter: TsAdapter = this.adapter(turn);
    const catalog = await adapter.listContexts(signal);
    const active = new Set(catalog.contexts.map(({ contextId }) => contextId));
    const requested = contextIds.filter((id) => active.has(id));
    const explicit = this.registry.explicitMatches(turn.scope.principalId, turn.public.message);
    const outputs = requiredOutputs.filter((kind) => outputKinds.some((output) => output === kind));
    const requestedCapabilities = this.registry.discover(turn.scope.principalId, goal + " " + turn.public.message, requested, outputs, limit);
    const related = this.registry.discover(turn.scope.principalId, turn.public.message, [], [], limit);
    const candidates = new Map([...explicit, ...requestedCapabilities, ...related]
      .filter((item) => item.discovery.contexts.some((id) => active.has(id))).map((item) => [capabilityRef(item), item]));
    const found = [...candidates.values()].slice(0, limit);
    const contexts = catalog.contexts.map(({ contextId, displayName, description }) => ({ contextId, displayName, description }));
    this.trace(turn, runId, "context.discovered", { catalogVersion: catalog.catalogVersion, contexts });
    const capabilities = found.map((item) => describe(item));
    this.trace(turn, runId, "capability.discovered", capabilities);
    let relevance: { contextId: string; score: number | null }[] = [];
    if (turn.toolSetup?.enabled.propensity !== false) {
      try {
        relevance = (await adapter.getContextScores({
          mid: this.persona(turn).syntheticMid, contextIds: [...new Set(found.flatMap((item) => item.discovery.contexts))],
        }, signal)).scores;
      } catch { signal.throwIfAborted(); }
    }
    return { contexts, capabilities, relevance, explicitlyRequested: explicit.map(capabilityRef).filter((ref) => candidates.has(ref)) };
  }

  journey(turn: TurnRecord) {
    return turn.agentJourneyId ? this.store.axe.get("journeys", turn.scope, turn.agentJourneyId) : undefined;
  }

  private remember(turn: TurnRecord, journey: Journey) {
    this.current(turn.public.id);
    this.store.axe.saveJourney(turn.scope, journey);
  }

  async execute(
    turn: TurnRecord, proposed: unknown, principal: Principal, signal: AbortSignal,
    admitted: ReadonlyMap<string, CapabilityManifest>, runId?: string, prior?: Journey, values?: InputValues,
  ) {
    const latest = this.current(turn.public.id);
    const traces = this.store.axe.list("decision_trace_events", turn.scope, turn.public.id, 100);
    requireCheck(traces.filter(({ type }) => type === "plan.created" || type === "plan.revised" || type === "plan.rejected").length
      < this.budget.planRevisions, "PLAN_REVISION_LIMIT");
    let validated;
    try {
      validated = verifyPlan(proposed, admitted, this.registry, true);
      const original = (proposed as PlanProposal).steps;
      if (validated.steps.some((step, index) => step.dependsOn.length !== original[index]?.dependsOn.length)) {
        this.trace(turn, runId ?? "", "plan.independent_steps_verified", { proposed: original, accepted: validated.steps });
        validated = verifyPlan(validated, admitted, this.registry);
      }
      if (!prior && !(turn.agentLaunch && "capability" in turn.agentLaunch)) {
        const requested = this.registry.explicitMatches(turn.scope.principalId, turn.public.message);
        const required = includeRequestedCapabilities(validated, requested, admitted);
        const completePlan = addCompanions(required, admitted, turn.public.message);
        if (completePlan.steps.length !== validated.steps.length) {
          this.trace(turn, runId ?? "", "plan.coverage_validated", { proposed: validated.steps, accepted: completePlan.steps });
          validated = verifyPlan(completePlan, admitted, this.registry);
        }
      }
      const contexts = new Set(validated.steps.flatMap(({ capabilityId: id, version }) => admitted.get(capabilityRef({ id, version }))!.discovery.contexts));
      requireCheck(contexts.size <= this.budget.contexts, "CONTEXT_LIMIT");
    } catch (error) {
      this.trace(turn, runId ?? prior?.runId ?? "", "plan.rejected", { reason: reasonCode(error) });
      throw error;
    }
    const execution = await this.sf().executions.open({ principal, purpose: "pzn-experience-plan", preset: "read_only", budget: { maxToolCalls: this.budget.toolCalls } });
    const rootRunId = runId ?? execution.id;
    const persona = this.persona(latest);
    const existing = this.journey(latest) ?? prior;
    const now = this.now();
    const goalId = existing?.goalId ?? makeId("goal");
    const revision = (existing?.revision ?? 0) + 1;
    const plan: ExecutionPlan = { ...validated, goalId, revision, planId: makeId("plan") };
    const fields = new Set(validated.steps.flatMap(({ capabilityId: id, version }) => (
      admitted.get(capabilityRef({ id, version }))!.inputs.map((field) => field.id)
    )));
    const persistedInputs = this.world.savedInputs(turn, fields);
    const executionInputs = { ...persistedInputs, ...existing?.inputs, ...explicitInputs(turn.public.message), ...values };
    const journey: Journey = {
      id: existing?.id ?? makeId("journey"), threadId: turn.scope.conversationId, goalId, objective: plan.objective,
      status: "executing", createdAt: existing?.createdAt ?? now, updatedAt: now, plan, revision,
      runId: rootRunId, turnId: turn.public.id, clarifications: existing?.clarifications ?? 0, results: [],
      excludePromotions: this.world.exclusions(turn, existing),
      confirmations: existing?.confirmations,
      inputs: Object.fromEntries(Object.entries(executionInputs).filter(([key]) => !addressFields.some((field) => field === key))),
    };
    const active: Scope = { turnId: turn.public.id, runId: rootRunId, principal, persona, adapter: this.adapter(latest), leases: new Map() };
    try {
      requireCheck(this.store.update(turn.public.id, (row) => {
        row.agentRunId ??= rootRunId;
        row.agentJourneyId = journey.id;
        (row.agentExecutionIds ??= []).push(execution.id);
      }), "TURN_INACTIVE");
      this.remember(turn, journey);
      this.store.axe.insert("execution_plans", turn.scope, plan.planId, journey.id, plan);
      this.trace(turn, rootRunId, "goal.interpreted", { objective: plan.objective, intentType: plan.intentType }, journey.id);
      this.trace(turn, rootRunId, revision === 1 ? "plan.created" : "plan.revised", plan, journey.id);
      this.trace(turn, rootRunId, "plan.validated", { planId: plan.planId, revision }, journey.id);
      if (prior) this.trace(turn, rootRunId, "journey.resumed", { previousRunId: prior.runId, previousTurnId: prior.turnId }, journey.id);

      this.scopes.set(execution.id, active);
      const catalog = latest.toolSetup?.enabled.catalog === false ? undefined : await active.adapter.listContexts(signal).catch(() => undefined);
      const activeIds = new Set(catalog?.contexts.map(({ contextId }) => contextId) ?? []);
      const definitions = new Map(plan.steps.map((step) => [step.id, admitted.get(capabilityRef({ id: step.capabilityId, version: step.version }))!]));
      const contextIds = [...new Set([...definitions.values()].flatMap((item) => item.discovery.contexts))];
      let calls = traces.filter(({ type }) => type === "tool.started").length;
      const runTool = async (ref: string, target: string, binding: BoundRead) => {
        signal.throwIfAborted();
        this.current(turn.public.id);
        const nativeCalls = runId ? (await this.sf().persistence.listCalls(runId)).length : 0;
        requireCheck(nativeCalls + calls + 1 < this.budget.toolCalls, "EXECUTION_BUDGET_EXHAUSTED");
        calls++;
        const lease = makeId("read");
        active.leases.set(lease, binding);
        this.trace(turn, rootRunId, "tool.started", { executionId: execution.id, ref, target }, journey.id);
        try {
          const parameters = binding.kind === "decision"
            ? { mid: active.persona.syntheticMid, context: binding.contextId }
            : {
              grantId: binding.grant.grantId,
              capability: capabilityRef(binding.manifest),
              ...(Object.keys(binding.values).length && { supplied: Object.fromEntries(Object.entries(binding.values)
                .map(([key, value]) => [key, addressFields.some((field) => field === key) ? "[REDACTED]" : value])) }),
            };
          const result = await execution.registry.execute(ref, { lease, turnRef: turn.public.id, target, parameters: JSON.stringify(parameters) }, { signal });
          if (result.status !== "succeeded") throw new Rejected(result.error?.code ?? "TOOL_UNAVAILABLE");
          this.trace(turn, rootRunId, "tool.completed", { ref, target, callId: result.callId }, journey.id);
          return { payload: readResult(result), callId: result.callId };
        } catch (error) {
          this.trace(turn, rootRunId, "tool.failed", { ref, target, reason: reasonCode(error) }, journey.id);
          throw error;
        } finally { active.leases.delete(lease); }
      };

      const decisions = new Map<string, EligibilityDecision>();
      const evaluate = async (contextId: string) => {
        try {
          requireCheck(activeIds.has(contextId), "CONTEXT_UNAVAILABLE");
          const { payload } = await runTool(axeRefs.treatment, contextId, { kind: "decision", contextId });
          const value = payload as { request: { mid: string; context: string }; response: unknown; ccre: unknown };
          requireCheck(value.request.mid === persona.syntheticMid && value.request.context === contextId, "TREATMENT_SCOPE_MISMATCH");
          const recommendations = normalizeRecommendations(value.response);
          const decision: EligibilityDecision = {
            id: makeId("decision"), contextId, customerRef: persona.syntheticMid, evaluatedAt: this.now(), recommendations,
            contentIds: recommendations.flatMap(({ kind, id }) => kind === "content" ? [id] : []),
          };
          decisions.set(contextId, decision);
          this.trace(turn, rootRunId, "eligibility.evaluated", { id: decision.id, ...value }, journey.id);
        } catch (error) {
          signal.throwIfAborted();
          this.trace(turn, rootRunId, "eligibility.evaluated", { contextId, reason: reasonCode(error) }, journey.id);
        }
      };
      for (let i = 0; i < contextIds.length; i += this.budget.parallelReads) {
        await finishBatch(contextIds.slice(i, i + this.budget.parallelReads).map(evaluate));
      }

      const completed = new Set<string>();
      const byStep = new Map<string, Evidence[]>();
      const results = new Map<string, StepResult>();
      const executeStep = async (step: ExecutionPlan["steps"][number]): Promise<StepResult> => {
        const manifest = definitions.get(step.id)!;
        const capability = capabilityRef(manifest);
        const evidence: Evidence[] = [];
        const done = (status: StepResult["status"], reason?: string, missing?: string[]) => ({
          stepId: step.id, capability, status, reason, missing, evidenceIds: evidence.map(({ evidenceId }) => evidenceId),
        });
        if (step.dependsOn.some((id) => results.get(id)?.status !== "completed")) return done("blocked", "DEPENDENCY_UNAVAILABLE");
        const matching = manifest.discovery.contexts.flatMap((id) => decisions.get(id) ?? []);
        const grant = matching.map((decision) => this.grants.issue(turn, rootRunId, decision, manifest)).find(Boolean);
        if (!grant) {
          this.trace(turn, rootRunId, "capability.rejected", { capability, reason: "NOT_ELIGIBLE" }, journey.id);
          if (!step.required) this.trace(turn, rootRunId, "recommendation.suppressed", { capability, reason: "NOT_ELIGIBLE" }, journey.id);
          return done("blocked", "NOT_ELIGIBLE");
        }
        this.trace(turn, rootRunId, "eligibility.granted", grant, journey.id);
        const decision = decisions.get(grant.contextId)!;
        const priorEvidence: Partial<Record<OutputKind, unknown>> = {};
        const visit = (id: string) => {
          for (const dependency of plan.steps.find((candidate) => candidate.id === id)!.dependsOn) visit(dependency);
          for (const record of byStep.get(id) ?? []) {
            if (record.expiresAt > this.now()) priorEvidence[record.outputKind] = record.payload;
          }
        };
        step.dependsOn.forEach(visit);
        const pending = manifest.tools.map((ref) => this.registry.tool(ref));
        while (pending.length) {
          const ready = (tool: CapabilityTool) => (tool.uses ?? []).every((kind) => priorEvidence[kind] !== undefined);
          const index = manifest.execution.mode === "agent" ? pending.findIndex(ready) : 0;
          const tool = pending[index];
          if (!tool || !ready(tool)) return done("blocked", "VERIFIED_PREREQUISITE_REQUIRED");
          pending.splice(index, 1);
          const fields = manifest.inputs.filter((field) => tool.requiredFields?.some(({ id }) => id === field.id));
          const inputs = Object.fromEntries(fields.map((field) => {
            const key = field.id;
            const value = executionInputs[key] ?? (field.type === "integer" ? field.default : undefined);
            return [key, value];
          }).filter((entry): entry is [string, string | number] => entry[1] !== undefined));
          const missing = fields.filter((field) => !fieldValueValid(field, inputs[field.id], priorEvidence.fundingOptions)).map(({ id }) => id);
          if (missing.length) {
            const prepared = tool.output === "address" && fields.every(({ id }) => executionInputs[id] === undefined)
              ? existing?.results.find((item) => item.stepId === step.id && item.capability === capability && item.status === "completed")
              : undefined;
            const saved = prepared?.evidenceIds.flatMap((id) => this.store.axe.get("evidence_records", turn.scope, id) ?? [])
              .find((item) => item.journeyId === journey.id && item.stepId === step.id && item.customerRef === persona.syntheticMid
                && item.source === tool.ref && item.outputKind === "address" && tool.schema.safeParse(item.payload).success);
            if (!saved) return done("waiting_input", "INPUT_REQUIRED", missing);
            evidence.push(saved);
            this.trace(turn, rootRunId, "evidence.reused", { evidenceId: saved.evidenceId, stepId: step.id, grantId: grant.grantId }, journey.id);
            continue;
          }
          try {
            const { payload, callId } = await runTool(tool.ref, step.id, {
              kind: "capability", journeyId: journey.id, stepId: step.id, tool, manifest, grant, decision, values: inputs, prior: priorEvidence,
            });
            const observedAt = this.now();
            const record: Evidence = {
              evidenceId: makeId("evidence"), runId: rootRunId, executionId: execution.id, customerRef: persona.syntheticMid,
              journeyId: journey.id, stepId: step.id, source: tool.ref, callId, grantId: grant.grantId, outputKind: tool.output,
              status: "verified", payload: tool.schema.parse(payload), observedAt, expiresAt: Math.min(observedAt + DECISION_TTL, grant.expiresAt),
            };
            this.store.axe.insert("evidence_records", turn.scope, record.evidenceId, turn.public.id, record);
            this.world.rememberFact(turn, record);
            this.trace(turn, rootRunId, "evidence.recorded", { evidenceId: record.evidenceId, source: record.source, callId, stepId: step.id }, journey.id);
            evidence.push(record);
            priorEvidence[tool.output] = record.payload;
            if (tool.output === "fundingStatus" && fundingStatusSchema.parse(record.payload).accountFundingStatus === "funded") {
              return done("blocked", "ACCOUNT_ALREADY_FUNDED");
            }
          } catch (error) {
            signal.throwIfAborted();
            return done("failed", reasonCode(error));
          }
        }
        return done(manifest.completionCriteria.every((kind) => evidence.some(({ outputKind }) => outputKind === kind))
          ? "completed" : "failed");
      };
      while (completed.size < plan.steps.length) {
        const ready = independentSteps(plan.steps, completed, this.budget.parallelReads);
        requireCheck(ready.length > 0, "PLAN_CYCLE");
        await finishBatch(ready.map(async (step) => {
          const result = await executeStep(step);
          const records = result.evidenceIds.flatMap((id) => this.store.axe.get("evidence_records", turn.scope, id) ?? []);
          byStep.set(step.id, records);
          results.set(step.id, result);
          completed.add(step.id);
          journey.results = plan.steps.flatMap(({ id }) => results.get(id) ?? []);
          this.remember(turn, journey);
        }));
      }
      const missing = journey.results.filter((step) => step.status === "waiting_input");
      const complete = plan.steps.filter(({ required }) => required).every((step) => results.get(step.id)?.status === "completed");
      journey.status = missing.length ? "waiting_input" : complete ? "completed" : journey.results.some(({ evidenceIds }) => evidenceIds.length) ? "partially_completed" : "failed";
      journey.updatedAt = this.now();
      this.remember(turn, journey);
      for (const step of missing) this.trace(turn, rootRunId, "customer.input.required", { stepId: step.stepId, fields: step.missing }, journey.id);
      if (complete && !missing.length) this.trace(turn, rootRunId, "goal.completed", { goalId, meaning: "Required preview or information results verified." }, journey.id);
      return journey;
    } finally {
      this.scopes.delete(execution.id);
      await execution.close();
    }
  }
}
