import type { RunResult } from "@sfield/core";
import demo from "../../fixtures/host.json";
import { type FailureCode } from "../../packages/contracts/api";
import { DECISION_TTL, TURN_DEADLINE, contextCatalogSchema, propensitySchema, type SelectionMode, type PropensityResult } from "../../packages/contracts/domain";
import { FOLLOW_UP_EVENT, type DisplayExperience } from "../../packages/contracts/surface";
import { normalizedIdsSchema, treatmentOverride } from "../../packages/contracts/tool-setup";
import { activeContextCatalog, fixtureRejections, tsFixtures } from "../../packages/ts-adapter";
import { contentCatalog, modelBundle, resolveCandidates } from "../../packages/experience/content";
import { compileExperience, compileRuleCreation, makeId } from "../../packages/experience/compile";
import { verifyContextProposal, verifyRoute, requireCheck, Rejected } from "../../packages/experience/verify";
import { ApiError, Store, type ConversationRecord, type Stage, type TurnRecord } from "./store";
import type { ActionMessage } from "@a2ui/web_core/v1_0";
import type { Runtime } from "./runtime";

class TurnFailure extends Error {
  constructor(readonly code: FailureCode) { super(code); }
}
const asRef = (turn: TurnRecord) => ({ turnRef: turn.public.id });
const completed = (result: RunResult, stage: Stage) => {
  if (result.state === "completed") return;
  if (result.state === "verification_failed") throw new TurnFailure(stage === "route" ? "route_rejected" : "verification_failed");
  if (result.state === "budget_exhausted" || result.state === "expired") throw new TurnFailure("turn_timeout");
  throw new TurnFailure("gateway_unavailable");
};
function traceFor(result: RunResult) {
  const { elapsedMs, modelCalls, providerAttempts, toolCalls, totalTokens, tokensReported } = result.usage;
  return { state: result.state, errorCode: result.error?.code, elapsedMs, modelCalls, providerAttempts, toolCalls, totalTokens, tokensReported };
}

export class ExperienceService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly jobs = new Map<string, Promise<void>>();
  private closing = false;

  constructor(
    readonly store: Store, private readonly runtime: Runtime | null, readonly selectionMode: SelectionMode, private readonly now: () => number,
    private readonly canCreateRule: boolean,
  ) {}

  createConversation(principalId: string, personaId: string, scenarioId: string) {
    const persona = demo.personas.find((entry) => entry.personaId === personaId);
    if (!persona?.allowedScenarios.includes(scenarioId)) throw new ApiError(400, "demo_scope_invalid", "Select an available demo persona and scenario.");
    return this.store.createConversation(principalId, personaId, scenarioId, this.now());
  }

  submit(conversation: ConversationRecord, message: string, requestId: string, origin = "message", retry?: TurnRecord) {
    const { turn, created } = this.store.accept({ conversation, message, requestId, origin, retry, selectionMode: this.selectionMode, now: this.now() });
    if (created) this.schedule(turn);
    return this.accepted(turn);
  }

  retry(turn: TurnRecord, requestId: string) {
    const conversation = this.store.conversation(turn.scope.conversationId, turn.scope.principalId);
    return this.submit(conversation, turn.public.message, requestId, "retry:" + turn.public.id, turn);
  }

  followUp(principalId: string, experienceId: string, envelope: ActionMessage, requestId: string) {
    const { action } = envelope;
    const { turn, actions } = this.store.experience(experienceId, principalId);
    const signed = actions.find((entry) => entry.actionId === action.context.actionId && entry.componentId === action.sourceComponentId);
    if (!signed || action.name !== FOLLOW_UP_EVENT || action.surfaceId !== experienceId) {
      throw new ApiError(400, "action_invalid", "This follow-up is unavailable.");
    }
    const conversation = this.store.conversation(turn.scope.conversationId, principalId);
    const origin = "follow_up:" + signed.actionId;
    const existing = this.store.existingRequest(conversation.id, requestId, signed.userMessage, origin);
    if (existing) return this.accepted(existing);
    const latest = this.store.latestTurn(conversation.id);
    if (latest?.public.id !== turn.public.id || conversation.personaId !== turn.scope.personaId
      || !turn.public.experience || turn.public.experience.expiresAt <= this.now()
      || turn.decision?.routeDecisionId !== turn.route?.routeDecisionId) {
      throw new ApiError(409, "action_stale", "Ask a fresh question to get current demo content.");
    }
    return this.submit(conversation, signed.userMessage, requestId, origin);
  }

  cancel(turn: TurnRecord) {
    const id = turn.public.id;
    const stopped = this.store.finish(id, { type: "cancelled" }, this.now());
    if (stopped) this.controllers.get(id)?.abort(new Error("Stopped"));
    return (stopped ?? this.store.ownTurn(id, turn.scope.principalId)).public;
  }

  reconcile() {
    for (const turn of this.store.workingTurns()) this.schedule(turn, true);
  }

  private accepted(turn: TurnRecord) {
    const { id } = turn.public;
    return { turnId: id, eventsUrl: "/api/turns/" + id + "/events", turn: turn.public };
  }

  private schedule(turn: TurnRecord, recovering = false) {
    const { id, conversationId } = turn.public;
    const earlier = this.jobs.get(conversationId) ?? Promise.resolve();
    const promise = earlier.catch(() => undefined).then(() => this.execute(id, recovering));
    this.jobs.set(conversationId, promise);
    void promise.finally(() => {
      if (this.jobs.get(conversationId) === promise) this.jobs.delete(conversationId);
    }).catch(() => undefined);
  }

  private async execute(id: string, recovering: boolean) {
    const initial = this.store.turn(id);
    if (this.closing || initial?.public.status !== "working") return;
    const remains = initial.public.createdAt + TURN_DEADLINE - this.now();
    if (remains <= 0) {
      this.store.finish(id, { type: "failed", code: recovering ? "restarted" : "turn_timeout" }, this.now());
      return;
    }
    const runtime = this.runtime;
    if (!runtime) {
      this.store.finish(id, { type: "failed", code: "gateway_unavailable" }, this.now());
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    this.controllers.set(id, controller);
    const timer = setTimeout(() => controller.abort(new TurnFailure("turn_timeout")), remains);
    timer.unref();
    let stage: "catalog" | "route" | "ts" | "compose" = "catalog";
    const current = () => {
      signal.throwIfAborted();
      return runtime.current(id);
    };
    const done = (status: DisplayExperience["status"], outcome: DisplayExperience["outcome"], question: string | null) => {
      current();
      const result = compileExperience({
        status, outcome, introKey: status === "clarify" ? "clarification" : "no_match", question,
        partial: false, expiresAt: this.now(),
      });
      this.store.finish(id, { type: "completed", result }, this.now());
    };
    try {
      if (!initial.catalog || !initial.propensity) await this.discover(runtime, current(), signal);
      const catalog = current().catalog!;
      const conversation = this.store.conversation(initial.scope.conversationId, initial.scope.principalId);

      stage = "route";
      requireCheck(catalog.catalog.catalogVersion === activeContextCatalog.catalogVersion, "CATALOG_MISMATCH");
      if (!current().route) {
        this.store.progress(id, "routing", this.now());
        const turn = current();
        const recent = this.store.conversationTurns(conversation.id)
          .filter((previous) => previous.public.status === "completed" && previous.route)
          .slice(-3).map((previous) => ({ request: previous.public.message.slice(0, 350), contextId: previous.route!.contextId }));
        const result = await runtime.model("route", turn, conversation, catalog.snapshotId, {
          inputType: "PznContextRoutingInput",
          request: turn.public.message,
          recent,
          catalogSnapshotId: catalog.snapshotId,
          catalog: catalog.catalog,
          propensity: turn.propensity,
          allowedQuestions: demo.clarificationQuestions,
          canCreateRule: this.canCreateRule,
        }, signal, recovering);
        current();
        this.store.update(id, (row) => { row.trace.routeRun = traceFor(result); });
        completed(result, "route");
        const proposal = verifyContextProposal(result.output, catalog, turn.scope, this.now(), this.canCreateRule);
        this.store.update(id, (row) => { row.trace.routeOutcome = proposal.status; row.trace.markers.routeValidated = this.now(); });
        if (proposal.status === "create_rule") {
          const { personaId, scenarioId } = conversation;
          const now = this.now();
          const result = compileRuleCreation({ personaId, scenarioId }, now + DECISION_TTL);
          this.store.update(id, (row) => { row.trace.components = result.display.blocks.map((block) => block.component); });
          this.store.finish(id, { type: "completed", result }, now);
          return;
        }
        if (proposal.status !== "selected") {
          done(proposal.status, proposal.status, proposal.clarificationQuestion);
          return;
        }
        const now = this.now();
        this.store.update(id, (row) => {
          row.route = {
            routeDecisionId: makeId("route"), scope: row.scope, catalogSnapshotId: catalog.snapshotId, catalogVersion: catalog.catalog.catalogVersion,
            contextId: proposal.contextId!, routerRunId: result.runId, intent: proposal.intent, issuedAt: now, expiresAt: now + DECISION_TTL,
          };
        });
      }

      stage = "ts";
      let turn = current();
      const route = turn.route!;
      verifyRoute(route, catalog, turn.scope, turn.attempts.route?.runId ?? null, this.now());
      if (!turn.decision) {
        this.store.progress(id, "eligibility", this.now());
        const result = await runtime.registry(turn, "tsScopeId", 1, signal, async (call) => (
          call("selection", { ...asRef(turn), routeDecisionId: route.routeDecisionId })
        ));
        current();
        if (result.status !== "succeeded") {
          this.store.update(id, (row) => { row.trace.failures.push({ stage: "ts", code: result.error?.code ?? "TS_UNAVAILABLE" }); });
          throw new TurnFailure("ts_unavailable");
        }

        const ids = normalizedIdsSchema.parse(result.output);
        const { candidates, rejections } = resolveCandidates(ids);
        const partial = Boolean(candidates.length && rejections.length);
        const now = this.now();
        this.store.update(id, (row) => {
          const override = treatmentOverride(row.toolSetup?.treatmentOverrides ?? [], conversation.scenarioId, route.contextId);
          const simulatedRejections = override ? [] : fixtureRejections({ scenarioId: conversation.scenarioId, ordinal: row.ordinal }, route.contextId);
          const mockRuleRejections = row.treatmentCcre?.results.flatMap(({ contentId, outcome }) => outcome === "excluded"
            ? [{ contentId, stage: "simulated_ccre" as const, reasonCode: "RULE_FALSE" }] : []) ?? [];
          row.trace.ts = {
            contextId: route.contextId, fixtureVersion: tsFixtures.fixtureVersion, baseline: ids,
            source: override ? "override" : "fixture", rejections: [...simulatedRejections, ...mockRuleRejections, ...rejections],
            partial,
          };
          row.trace.markers.tsResolved = now;
          row.trace.markers.candidatesReady = now;
          row.decision = {
            decisionId: makeId("decision"), scope: row.scope, routeDecisionId: route.routeDecisionId, contextId: route.contextId,
            catalogVersion: contentCatalog.catalogVersion, issuedAt: now, expiresAt: now + DECISION_TTL,
            selectionMode: row.selectionMode, partial, candidates, composerRunId: null,
          };
        });
      }
      turn = current();
      const decision = turn.decision!;
      if (!decision.candidates.length) {
        if (turn.trace.ts?.baseline.length) throw new TurnFailure("content_unavailable");
        done("no_match", "eligible_empty", null);
        return;
      }

      stage = "compose";
      this.store.progress(id, "composition", this.now());
      const result = await runtime.model("compose", turn, conversation, decision.decisionId, {
        inputType: "PznExperienceCompositionInput",
        request: turn.public.message, intent: route.intent,
        selectedContextId: route.contextId, eligible: modelBundle(decision),
        allowedQuestions: demo.clarificationQuestions,
      }, signal, recovering);

      const latest = current();
      this.store.update(id, (row) => { row.trace.composeRun = traceFor(result); });
      if (result.state === "verification_failed" && latest.trace.failures.at(-1)?.code.startsWith("METRIC_")) {
        throw new TurnFailure("metric_unavailable");
      }
      completed(result, "compose");
      this.store.progress(id, "verifying", this.now());
      const { verified, proof, unsuccessfulRead } = await runtime.verifyComposition(result.output, latest, result.runId);
      if (unsuccessfulRead) throw new TurnFailure("metric_unavailable");
      current();
      const resultForDisplay = compileExperience({
        status: verified.proposal.status, outcome: verified.proposal.status, introKey: verified.proposal.introKey,
        question: verified.proposal.clarificationQuestion, partial: decision.partial && verified.proposal.status === "ready",
        expiresAt: Math.min(decision.expiresAt, route.expiresAt), approved: verified, proof,
      });
      this.store.update(id, (row) => {
        row.trace.markers.proposalValidated = this.now();
        row.trace.finalOrder = verified.contentOrder;
        row.trace.components = verified.proposal.blocks.map((block) => block.component);
      });
      this.store.finish(id, { type: "completed", result: resultForDisplay }, this.now());
    } catch (error) {
      if (this.closing || this.store.turn(id)?.public.status !== "working") return;
      const mapped = signal.reason instanceof TurnFailure ? signal.reason.code
        : error instanceof TurnFailure ? error.code
        : error instanceof Rejected && ["TURN_EXPIRED", "DECISION_EXPIRED"].includes(error.code) ? (recovering ? "restarted" : "turn_timeout")
        : error instanceof Rejected && error.code === "RESTARTED" ? "restarted"
        : stage === "catalog" ? "catalog_unavailable"
        : stage === "ts" ? "ts_unavailable"
        : error instanceof Rejected ? (stage === "route" ? "route_rejected" : "verification_failed")
        : "internal_error";
      this.store.update(id, (row) => { row.trace.failures.push({ stage, code: error instanceof Rejected ? error.code : mapped }); });
      this.store.finish(id, { type: "failed", code: mapped }, this.now());
    } finally {
      clearTimeout(timer);
      this.controllers.delete(id);
    }
  }

  private async discover(runtime: Runtime, turn: TurnRecord, signal: AbortSignal) {
    const id = turn.public.id;
    this.store.progress(id, "catalog", this.now());
    await runtime.registry(turn, "catalogScopeId", turn.catalog ? 1 : 2, signal, async (call) => {
      let snapshot = turn.catalog;
      if (!snapshot) {
        const result = await call("catalog", asRef(turn));
        signal.throwIfAborted();
        if (result.status !== "succeeded") throw new TurnFailure("catalog_unavailable");
        const catalog = contextCatalogSchema.parse(result.output);
        const now = this.now();
        snapshot = { snapshotId: makeId("catalog"), scope: turn.scope, catalog, issuedAt: now, expiresAt: now + DECISION_TTL };
        this.store.update(id, (row) => { row.catalog = snapshot; row.trace.markers.catalogReady = now; });
      }

      const contextIds = snapshot.catalog.contexts.map((context) => context.contextId);
      let propensity: PropensityResult | undefined;
      try {
        const result = await call("propensity", { ...asRef(turn), catalogSnapshotId: snapshot.snapshotId });
        if (result.status === "succeeded") {
          const scored = propensitySchema.parse(result.output);
          const scoreIds = new Set(scored.scores.map(({ contextId }) => contextId));
          if (scoreIds.size === scored.scores.length && scoreIds.size === contextIds.length && contextIds.every((contextId) => scoreIds.has(contextId))
            && (scored.status === "available" || scored.scores.every(({ score }) => score === null))) propensity = scored;
        }
      } catch {
        signal.throwIfAborted();
      }
      signal.throwIfAborted();
      this.store.update(id, (row) => {
        row.propensity = propensity ?? {
          version: "unavailable", classification: "synthetic_advisory", status: "unavailable",
          scores: contextIds.map((contextId) => ({ contextId, score: null })),
        };
        row.trace.markers.propensityReady = this.now();
      });
    });
  }

  async close() {
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort(new Error("Shutting down"));
    await Promise.allSettled(this.jobs.values());
    await this.runtime?.close();
    this.store.close();
  }
}
