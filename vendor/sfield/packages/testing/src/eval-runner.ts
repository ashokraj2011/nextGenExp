/**
 * Generic Guardrail Eval Runner & Lock Release Gate for @sfield/testing.
 *
 * Executes structured evaluation cases against an SField runtime or custom target,
 * builds a signed EvalReportRecord compatible with `sf.lock.evalReports`, and computes
 * release-gate verdicts (`ready_to_publish` vs `blocked`).
 */
import { newId, nowIso, type EvalReportRecord, type ExecutionPersistence, type JsonValue } from "@sfield/core";

export interface EvalCaseDefinition<TOutput = unknown> {
  id: string;
  name: string;
  category?: string;
  run: () => Promise<TOutput>;
  verify: (output: TOutput) => Promise<{ pass: boolean; reason?: string }> | { pass: boolean; reason?: string };
}

export interface EvalCaseOutcome {
  id: string;
  name: string;
  category?: string;
  pass: boolean;
  durationMs: number;
  reason?: string;
  error?: string;
}

export interface EvalSuiteRunOptions {
  suite: string;
  datasetVersion?: string;
  candidateDigest: string;
  baselineDigest?: string;
  modelTargets?: string[];
  mode?: "replay" | "live";
  /** Report TTL in seconds. Defaults to 86400 (24h). */
  ttlSeconds?: number;
  /** Optional sfield evalReports store (e.g. `sf.lock.evalReports()`) to persist the report. */
  evalReports?: ExecutionPersistence["evalReports"];
  /** Optional baseline metrics to compute latency/cost deltas. */
  baselineAvgLatencyMs?: number;
  baselineCostMicroUsd?: number;
  actualCostMicroUsd?: number;
}

export interface EvalReleaseGatePolicy {
  minPassRate: number;
  maxLatencyDeltaRatio?: number;
  maxCostDeltaRatio?: number;
}

export interface EvalReleaseGateVerdict {
  decision: "ready_to_publish" | "blocked";
  reasons: string[];
}

export interface EvalSuiteResult {
  report: EvalReportRecord;
  cases: EvalCaseOutcome[];
  totalCases: number;
  passedCases: number;
  failedCases: number;
  avgLatencyMs: number;
}

export async function runEvalSuite(
  cases: readonly EvalCaseDefinition[],
  options: EvalSuiteRunOptions,
): Promise<EvalSuiteResult> {
  const outcomes: EvalCaseOutcome[] = [];
  for (const c of cases) {
    const started = Date.now();
    try {
      const output = await c.run();
      const verdict = await c.verify(output);
      outcomes.push({
        id: c.id,
        name: c.name,
        ...(c.category ? { category: c.category } : {}),
        pass: Boolean(verdict.pass),
        durationMs: Math.max(0, Date.now() - started),
        ...(verdict.reason ? { reason: verdict.reason } : {}),
      });
    } catch (err) {
      outcomes.push({
        id: c.id,
        name: c.name,
        ...(c.category ? { category: c.category } : {}),
        pass: false,
        durationMs: Math.max(0, Date.now() - started),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const totalCases = outcomes.length;
  const passedCases = outcomes.filter((o) => o.pass).length;
  const failedCases = totalCases - passedCases;
  const passRate = totalCases > 0 ? passedCases / totalCases : 1;
  const avgLatencyMs = totalCases > 0
    ? Math.round(outcomes.reduce((s, o) => s + o.durationMs, 0) / totalCases)
    : 0;
  const latencyDeltaRatio = options.baselineAvgLatencyMs && options.baselineAvgLatencyMs > 0
    ? (avgLatencyMs - options.baselineAvgLatencyMs) / options.baselineAvgLatencyMs
    : undefined;
  const costDeltaRatio = options.baselineCostMicroUsd && options.baselineCostMicroUsd > 0 && options.actualCostMicroUsd !== undefined
    ? (options.actualCostMicroUsd - options.baselineCostMicroUsd) / options.baselineCostMicroUsd
    : undefined;

  const createdAt = nowIso();
  const ttlMs = (options.ttlSeconds ?? 86_400) * 1000;
  const report: EvalReportRecord = {
    id: newId("eval"),
    suite: options.suite,
    datasetVersion: options.datasetVersion ?? "1.0.0",
    candidateDigest: options.candidateDigest,
    ...(options.baselineDigest ? { baselineDigest: options.baselineDigest } : {}),
    modelTargets: options.modelTargets ?? ["default"],
    mode: options.mode ?? "replay",
    passRate,
    verifiedSuccessRate: passRate,
    ...(costDeltaRatio !== undefined ? { costDeltaRatio } : {}),
    ...(latencyDeltaRatio !== undefined ? { latencyDeltaRatio } : {}),
    cases: { inline: outcomes as unknown as JsonValue },
    createdAt,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };

  if (options.evalReports) {
    await options.evalReports.put(report);
  }

  return { report, cases: outcomes, totalCases, passedCases, failedCases, avgLatencyMs };
}

export function evaluateReleaseGate(
  report: EvalReportRecord,
  policy: EvalReleaseGatePolicy,
): EvalReleaseGateVerdict {
  const reasons: string[] = [];
  if (report.passRate < policy.minPassRate) {
    reasons.push(`Pass rate ${(report.passRate * 100).toFixed(1)}% is below required ${(policy.minPassRate * 100).toFixed(1)}%`);
  }
  if (
    policy.maxLatencyDeltaRatio !== undefined
    && report.latencyDeltaRatio !== undefined
    && report.latencyDeltaRatio > policy.maxLatencyDeltaRatio
  ) {
    reasons.push(`Latency delta ${(report.latencyDeltaRatio * 100).toFixed(1)}% exceeds max ${(policy.maxLatencyDeltaRatio * 100).toFixed(1)}%`);
  }
  if (
    policy.maxCostDeltaRatio !== undefined
    && report.costDeltaRatio !== undefined
    && report.costDeltaRatio > policy.maxCostDeltaRatio
  ) {
    reasons.push(`Cost delta ${(report.costDeltaRatio * 100).toFixed(1)}% exceeds max ${(policy.maxCostDeltaRatio * 100).toFixed(1)}%`);
  }
  return {
    decision: reasons.length === 0 ? "ready_to_publish" : "blocked",
    reasons,
  };
}
