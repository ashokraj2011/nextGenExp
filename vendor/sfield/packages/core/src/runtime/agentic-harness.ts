/**
 * General-purpose multi-stage Agentic Harness for sfield.
 *
 * Replaces fragile one-shot LLM calls with a governed, auditable, domain-agnostic pipeline:
 *   1. plan       — clarify intent, resolve follow-ups/corrections, detect missing data or ambiguity
 *   2. gather     — fetch grounded evidence / execute read tools requested by the plan
 *   3. synthesize — produce a candidate output (UI, grounded answer, action payload, contract, etc.)
 *   4. verify     — check schema, grounding, and user constraints; run bounded repair or fallback
 */
import type { JsonObject, Principal } from "../types/common.js";
import type { AuditRecord, ExecutionPersistence } from "../types/persistence.js";
import { newId, nowIso } from "../util/digest.js";

export type HarnessStageName = "plan" | "clarify" | "fetch" | "compose" | "verify" | "repair";
export type HarnessStageStatus = "ok" | "repaired" | "skipped" | "needs_data" | "needs_clarification";

export interface HarnessStageRecord {
  stage: HarnessStageName;
  status: HarnessStageStatus;
  summary: string;
  durationMs?: number;
}

export interface HarnessTrace {
  harnessRunId: string;
  kind: string;
  resolvedGoal: string;
  fetchedSources: string[];
  visualTargets: string[];
  repaired: boolean;
  stages: HarnessStageRecord[];
}

export interface HarnessClarificationChoice {
  id: string;
  label: string;
}

export type HarnessPlanOutcome<TPlan> =
  | {
      status: "ready";
      plan: TPlan;
      resolvedGoal: string;
      summary: string;
      targets?: string[];
    }
  | {
      status: "needs_data";
      plan?: TPlan;
      missingSource?: string;
      resolvedGoal: string;
      summary: string;
      targets?: string[];
    }
  | {
      status: "needs_clarification";
      plan?: TPlan;
      question: string;
      choices?: HarnessClarificationChoice[];
      resolvedGoal: string;
      summary: string;
      targets?: string[];
    };

export type HarnessGatherOutcome<TEvidence> =
  | {
      status?: "ok";
      evidence: TEvidence;
      sources: string[];
      summary: string;
    }
  | {
      status: "needs_data";
      missingSource?: string;
      summary: string;
    };

export interface HarnessSynthesizeOutcome<TCandidate = unknown> {
  candidate: TCandidate;
  summary?: string;
}

export type HarnessVerifyOutcome<TOutput> =
  | { ok: true; output: TOutput; summary?: string }
  | { ok: false; violations: string[] };

export interface HarnessContext {
  harnessRunId: string;
  signal?: AbortSignal;
}

export interface AgenticHarnessSpec<TPlan, TEvidence, TOutput, TCandidate = unknown> {
  /** Logical workflow kind recorded in the trace and sfield audit log (e.g. "dynamic_ui", "rag_qa", "action_plan"). */
  kind: string;
  /** Optional tenant/principal metadata for sfield audit logging. */
  principal?: Principal;
  /** Optional cancellation signal checked between every stage. */
  signal?: AbortSignal;
  /** Maximum LLM repair attempts when verification fails. Defaults to 1. */
  maxRepairs?: number;
  /** Stage 1: Clarify user intent, resolve follow-ups, identify needed sources or ambiguity. */
  plan(ctx: HarnessContext): Promise<HarnessPlanOutcome<TPlan>>;
  /** Stage 2: Fetch grounded evidence / invoke read tools requested by the plan. */
  gather(plan: TPlan, ctx: HarnessContext): Promise<HarnessGatherOutcome<TEvidence>>;
  /** Stage 3: Produce a candidate output strictly from the verified plan + gathered evidence. */
  synthesize(plan: TPlan, evidence: TEvidence, ctx: HarnessContext): Promise<HarnessSynthesizeOutcome<TCandidate>>;
  /** Stage 4a: Verify schema, grounding, and user constraints. */
  verify(candidate: TCandidate, plan: TPlan, evidence: TEvidence, ctx: HarnessContext): Promise<HarnessVerifyOutcome<TOutput>> | HarnessVerifyOutcome<TOutput>;
  /** Stage 4b (optional): Targeted LLM repair pass fed the exact verification violations. */
  repair?(
    plan: TPlan,
    evidence: TEvidence,
    violations: string[],
    previousCandidate: TCandidate,
    attempt: number,
    ctx: HarnessContext,
  ): Promise<HarnessSynthesizeOutcome<TCandidate>>;
  /** Stage 4c (optional): Deterministic grounded fallback if bounded repair still fails. */
  fallback?(plan: TPlan, evidence: TEvidence, violations: string[], ctx: HarnessContext): Promise<TOutput> | TOutput;
}

export type AgenticHarnessResult<TPlan, TEvidence, TOutput> =
  | {
      status: "completed";
      output: TOutput;
      plan: TPlan;
      evidence: TEvidence;
      trace: HarnessTrace;
    }
  | {
      status: "needs_data";
      missingSource?: string;
      plan?: TPlan;
      trace: HarnessTrace;
    }
  | {
      status: "needs_clarification";
      question: string;
      choices?: HarnessClarificationChoice[];
      plan?: TPlan;
      trace: HarnessTrace;
    }
  | {
      status: "failed";
      violations: string[];
      plan: TPlan;
      evidence: TEvidence;
      trace: HarnessTrace;
    };

export interface AgenticHarnessDeps {
  persistence?: Pick<ExecutionPersistence, "appendAudit">;
  resolvePrincipal?: (principal?: Principal) => Principal;
  configDigest?: () => string;
  presetName?: string;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Agentic harness aborted");
  }
}

/**
 * Pure standalone runner for the 4-stage sfield Agentic Harness.
 * Can be called directly or through `sfield.harness.run(...)` for automatic sfield audit logging.
 */
export async function runAgenticHarness<TPlan, TEvidence, TOutput, TCandidate = unknown>(
  spec: AgenticHarnessSpec<TPlan, TEvidence, TOutput, TCandidate>,
  deps?: AgenticHarnessDeps,
): Promise<AgenticHarnessResult<TPlan, TEvidence, TOutput>> {
  const harnessRunId = newId("hrn");
  const ctx: HarnessContext = { harnessRunId, signal: spec.signal };
  const stages: HarnessStageRecord[] = [];
  const maxRepairs = Math.max(0, spec.maxRepairs ?? 1);

  const emitAudit = async (status: string, trace: HarnessTrace, extra?: JsonObject): Promise<void> => {
    if (!deps?.persistence) return;
    let principal: Principal | undefined = spec.principal;
    if (!principal && deps.resolvePrincipal) {
      try {
        principal = deps.resolvePrincipal(undefined);
      } catch {
        principal = undefined;
      }
    }
    const record: AuditRecord = {
      id: newId("aud"),
      at: nowIso(),
      tenantId: principal?.tenantId ?? "host",
      type: "agentic_harness_completed",
      ...(principal ? { principal: { tenantId: principal.tenantId, subjectId: principal.subjectId } } : {}),
      ...(deps.configDigest ? { configDigest: deps.configDigest() } : {}),
      ...(deps.presetName ? { preset: deps.presetName } : {}),
      data: {
        harnessRunId: trace.harnessRunId,
        kind: trace.kind,
        status,
        resolvedGoal: trace.resolvedGoal,
        fetchedSources: trace.fetchedSources,
        visualTargets: trace.visualTargets,
        repaired: trace.repaired,
        stages: trace.stages.map((s) => ({
          stage: s.stage,
          status: s.status,
          summary: s.summary,
          ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}),
        })),
        ...(extra ?? {}),
      },
    };
    await deps.persistence.appendAudit([record]).catch(() => undefined);
  };

  // ── STAGE 1: PLAN ──────────────────────────────────────────────────────────
  checkAborted(spec.signal);
  const planStart = Date.now();
  const planOutcome = await spec.plan(ctx);
  const targets = planOutcome.targets ?? [];
  stages.push({
    stage: "plan",
    status: planOutcome.status === "ready" ? "ok" : planOutcome.status,
    summary: planOutcome.summary.slice(0, 200),
    durationMs: Date.now() - planStart,
  });

  if (planOutcome.status === "needs_clarification") {
    stages.push({
      stage: "clarify",
      status: "needs_clarification",
      summary: planOutcome.question.slice(0, 200),
      durationMs: 0,
    });
    const trace: HarnessTrace = {
      harnessRunId,
      kind: spec.kind,
      resolvedGoal: planOutcome.resolvedGoal.slice(0, 220),
      fetchedSources: [],
      visualTargets: targets.slice(0, 6),
      repaired: false,
      stages,
    };
    await emitAudit("needs_clarification", trace, { question: planOutcome.question });
    return {
      status: "needs_clarification",
      question: planOutcome.question,
      ...(planOutcome.choices ? { choices: planOutcome.choices } : {}),
      ...(planOutcome.plan !== undefined ? { plan: planOutcome.plan } : {}),
      trace,
    };
  }

  if (planOutcome.status === "needs_data") {
    stages.push({
      stage: "fetch",
      status: "needs_data",
      summary: "No connected provider supplies those records — stopped without fabricating data.",
      durationMs: 0,
    });
    const trace: HarnessTrace = {
      harnessRunId,
      kind: spec.kind,
      resolvedGoal: planOutcome.resolvedGoal.slice(0, 220),
      fetchedSources: [],
      visualTargets: targets.slice(0, 6),
      repaired: false,
      stages,
    };
    await emitAudit("needs_data", trace, planOutcome.missingSource ? { missingSource: planOutcome.missingSource } : undefined);
    return {
      status: "needs_data",
      ...(planOutcome.missingSource ? { missingSource: planOutcome.missingSource } : {}),
      ...(planOutcome.plan !== undefined ? { plan: planOutcome.plan } : {}),
      trace,
    };
  }

  // ── STAGE 2: GATHER / FETCH ────────────────────────────────────────────────
  checkAborted(spec.signal);
  const gatherStart = Date.now();
  const gathered = await spec.gather(planOutcome.plan, ctx);
  if (gathered.status === "needs_data") {
    stages.push({
      stage: "fetch",
      status: "needs_data",
      summary: gathered.summary.slice(0, 200),
      durationMs: Date.now() - gatherStart,
    });
    const trace: HarnessTrace = {
      harnessRunId,
      kind: spec.kind,
      resolvedGoal: planOutcome.resolvedGoal.slice(0, 220),
      fetchedSources: [],
      visualTargets: targets.slice(0, 6),
      repaired: false,
      stages,
    };
    await emitAudit("needs_data", trace, gathered.missingSource ? { missingSource: gathered.missingSource } : undefined);
    return {
      status: "needs_data",
      ...(gathered.missingSource ? { missingSource: gathered.missingSource } : {}),
      plan: planOutcome.plan,
      trace,
    };
  }

  stages.push({
    stage: "fetch",
    status: "ok",
    summary: gathered.summary.slice(0, 200),
    durationMs: Date.now() - gatherStart,
  });

  // ── STAGE 3: SYNTHESIZE / COMPOSE ──────────────────────────────────────────
  checkAborted(spec.signal);
  const synthStart = Date.now();
  const synth = await spec.synthesize(planOutcome.plan, gathered.evidence, ctx);
  const firstCheck = await spec.verify(synth.candidate, planOutcome.plan, gathered.evidence, ctx);

  stages.push({
    stage: "compose",
    status: firstCheck.ok ? "ok" : "repaired",
    summary: (firstCheck.ok
      ? (synth.summary ?? "Synthesized candidate output")
      : `Draft needed repair: ${firstCheck.violations[0] ?? "verification failed"}`).slice(0, 200),
    durationMs: Date.now() - synthStart,
  });

  // ── STAGE 4: VERIFY & BOUNDED REPAIR ───────────────────────────────────────
  if (firstCheck.ok) {
    stages.push({
      stage: "verify",
      status: "ok",
      summary: (firstCheck.summary ?? "Verified schema and grounding constraints").slice(0, 200),
    });
    const trace: HarnessTrace = {
      harnessRunId,
      kind: spec.kind,
      resolvedGoal: planOutcome.resolvedGoal.slice(0, 220),
      fetchedSources: gathered.sources.slice(0, 8),
      visualTargets: targets.slice(0, 6),
      repaired: false,
      stages,
    };
    await emitAudit("completed", trace);
    return {
      status: "completed",
      output: firstCheck.output,
      plan: planOutcome.plan,
      evidence: gathered.evidence,
      trace,
    };
  }

  let lastCandidate = synth.candidate;
  let lastViolations = firstCheck.violations;

  if (spec.repair) {
    for (let attempt = 1; attempt <= maxRepairs; attempt++) {
      checkAborted(spec.signal);
      const repairStart = Date.now();
      const repairedSynth = await spec.repair(planOutcome.plan, gathered.evidence, lastViolations, lastCandidate, attempt, ctx);
      const check = await spec.verify(repairedSynth.candidate, planOutcome.plan, gathered.evidence, ctx);
      if (check.ok) {
        stages.push({
          stage: "repair",
          status: "repaired",
          summary: (repairedSynth.summary ?? `Auto-repaired output on attempt ${attempt}`).slice(0, 200),
          durationMs: Date.now() - repairStart,
        });
        const trace: HarnessTrace = {
          harnessRunId,
          kind: spec.kind,
          resolvedGoal: planOutcome.resolvedGoal.slice(0, 220),
          fetchedSources: gathered.sources.slice(0, 8),
          visualTargets: targets.slice(0, 6),
          repaired: true,
          stages,
        };
        await emitAudit("completed", trace, { repairAttempts: attempt });
        return {
          status: "completed",
          output: check.output,
          plan: planOutcome.plan,
          evidence: gathered.evidence,
          trace,
        };
      }
      lastCandidate = repairedSynth.candidate;
      lastViolations = check.violations;
      stages.push({
        stage: "repair",
        status: "repaired",
        summary: `Repair attempt ${attempt} still had violation: ${check.violations[0] ?? "invalid"}`.slice(0, 200),
        durationMs: Date.now() - repairStart,
      });
    }
  }

  if (spec.fallback) {
    checkAborted(spec.signal);
    const fallbackStart = Date.now();
    const output = await spec.fallback(planOutcome.plan, gathered.evidence, lastViolations, ctx);
    stages.push({
      stage: "repair",
      status: "repaired",
      summary: "Applied deterministic grounded fallback after repair check",
      durationMs: Date.now() - fallbackStart,
    });
    const trace: HarnessTrace = {
      harnessRunId,
      kind: spec.kind,
      resolvedGoal: planOutcome.resolvedGoal.slice(0, 220),
      fetchedSources: gathered.sources.slice(0, 8),
      visualTargets: targets.slice(0, 6),
      repaired: true,
      stages,
    };
    await emitAudit("completed", trace, { usedFallback: true });
    return {
      status: "completed",
      output,
      plan: planOutcome.plan,
      evidence: gathered.evidence,
      trace,
    };
  }

  const trace: HarnessTrace = {
    harnessRunId,
    kind: spec.kind,
    resolvedGoal: planOutcome.resolvedGoal.slice(0, 220),
    fetchedSources: gathered.sources.slice(0, 8),
    visualTargets: targets.slice(0, 6),
    repaired: false,
    stages,
  };
  await emitAudit("failed", trace, { violations: lastViolations });
  return {
    status: "failed",
    violations: lastViolations,
    plan: planOutcome.plan,
    evidence: gathered.evidence,
    trace,
  };
}

/**
 * First-class `sfield.harness` service attached to every SField instance.
 * Runs any multi-stage agentic workflow through `plan -> gather -> synthesize -> verify/repair`
 * with automatic persistence audit logging.
 */
export class AgenticHarness {
  constructor(private readonly deps: AgenticHarnessDeps) {}

  run<TPlan, TEvidence, TOutput, TCandidate = unknown>(
    spec: AgenticHarnessSpec<TPlan, TEvidence, TOutput, TCandidate>,
  ): Promise<AgenticHarnessResult<TPlan, TEvidence, TOutput>> {
    return runAgenticHarness(spec, this.deps);
  }
}
