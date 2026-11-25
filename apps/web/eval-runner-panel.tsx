import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Download, FileCheck2, Play, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
import type { ComplianceAuditPacket, EvalCategory, EvalRunReport } from "../../packages/contracts/eval-suite";
import { api } from "./api";

function downloadTextFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toCsv(report: EvalRunReport): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = ["id", "category", "severity", "passed", "name", "prompt", "expected", "actual", "durationMs", "details"].join(",");
  const rows = report.results.map((r) => [
    r.id, r.category, r.severity, r.passed ? "PASS" : "FAIL", r.name, r.prompt, r.expected, r.actual, r.durationMs, r.details,
  ].map(esc).join(","));
  return [header, ...rows].join("\n");
}

export function EvalRunnerPanel() {
  const [runs, setRuns] = useState<EvalRunReport[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [mode, setMode] = useState<"deterministic" | "live_llm">("deterministic");
  const [categoryFilter, setCategoryFilter] = useState<EvalCategory | "all">("all");
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [packet, setPacket] = useState<ComplianceAuditPacket | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    void api.evals().then((view) => {
      if (!alive) return;
      setRuns(view.runs);
      if (view.latest) setSelectedRunId(view.latest.runId);
    }).catch((err: unknown) => {
      if (alive) setError(err instanceof Error ? err.message : "Could not load eval history.");
    });
    return () => { alive = false; };
  }, []);

  const activeRun = useMemo(
    () => runs.find((r) => r.runId === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId],
  );

  const filteredResults = useMemo(() => {
    if (!activeRun) return [];
    if (categoryFilter === "all") return activeRun.results;
    return activeRun.results.filter((r) => r.category === categoryFilter);
  }, [activeRun, categoryFilter]);

  const executeSuite = async () => {
    setRunning(true);
    setError("");
    setNotice("");
    try {
      const res = await api.runEvals(mode);
      setRuns(res.runs);
      setSelectedRunId(res.report.runId);
      setCategoryFilter("all");
      setNotice(
        `Completed ${res.report.totalCases} guardrail evals in ${res.report.durationMs}ms — `
        + `${res.report.passedCases}/${res.report.totalCases} passed (${res.report.passRatePct}%). Release gate: ${res.report.releaseGate === "ready_to_publish" ? "READY TO PUBLISH" : "BLOCKED"}.`,
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to run guardrail eval suite.");
    } finally {
      setRunning(false);
    }
  };

  const exportComplianceJson = async () => {
    setExporting(true);
    setError("");
    try {
      const data = await api.compliancePacket();
      setPacket(data);
      downloadTextFile(`cep-compliance-audit-${data.packetId}.json`, JSON.stringify(data, null, 2), "application/json;charset=utf-8");
      setNotice(`Generated & downloaded SHA-256 signed compliance packet (${data.packetId} · digest ${data.packetDigest.slice(0, 12)}…).`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not generate compliance audit packet.");
    } finally {
      setExporting(false);
    }
  };

  const previewCompliancePacket = async () => {
    setExporting(true);
    setError("");
    try {
      const data = await api.compliancePacket();
      setPacket(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not preview compliance packet.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="admin-card eval-panel" aria-labelledby="eval-runner-title">
      <div className="eval-head">
        <div>
          <h2 id="eval-runner-title">
            <ShieldCheck size={19} aria-hidden="true" />
            Guardrail Eval Runner &amp; Compliance Audit Export
          </h2>
          <p>
            Run automated pre-flight checks across <strong>Semantic Routing</strong>, <strong>SHA-256 HITL &amp; 4-Eyes Gates</strong>,{" "}
            <strong>Prompt-Injection Defense</strong>, <strong>Financial Parity &amp; Tax-Harvest Math</strong>,{" "}
            <strong>Workflow DAG Branching</strong>, and <strong>A2UI v1.0 Schema Validation</strong> before publishing changes.
          </p>
        </div>

        <div className="eval-controls">
          <select
            className="eval-mode-select"
            value={mode}
            disabled={running}
            aria-label="Evaluation mode"
            onChange={(e) => setMode(e.target.value as "deterministic" | "live_llm")}
          >
            <option value="deterministic">Deterministic Fast Suite (&lt;1s)</option>
            <option value="live_llm">Live LLM Routing + Guardrails</option>
          </select>
          <button type="button" className="eval-run-btn" disabled={running} onClick={executeSuite}>
            <Play size={15} aria-hidden="true" />
            {running ? "Running 16 Evals…" : "Run Guardrail Eval Suite"}
          </button>
        </div>
      </div>

      {notice && <p className="eval-notice" role="status">{notice}</p>}
      {error && <p className="request-notice" role="alert">{error}</p>}

      {activeRun ? (
        <>
          <div className={`eval-gate-banner is-${activeRun.releaseGate}`}>
            <div className="eval-gate-left">
              {activeRun.releaseGate === "ready_to_publish"
                ? <CheckCircle2 size={22} aria-hidden="true" />
                : <ShieldAlert size={22} aria-hidden="true" />}
              <div>
                <strong>
                  {activeRun.releaseGate === "ready_to_publish" ? "RELEASE GATE: READY TO PUBLISH" : "RELEASE GATE: BLOCKED"}
                </strong>
                <span>
                  {activeRun.passedCases}/{activeRun.totalCases} passed ({activeRun.passRatePct}%) · {activeRun.criticalFailures} critical failures · {activeRun.durationMs}ms · {activeRun.modelLabel}
                </span>
              </div>
            </div>
            <div className="eval-gate-right">
              <span className="eval-digest-chip">SHA-256: <code>{activeRun.reportDigest.slice(0, 14)}…</code></span>
              <button
                type="button"
                className="secondary-button"
                onClick={() => downloadTextFile(`cep-eval-scorecard-${activeRun.runId}.csv`, toCsv(activeRun), "text/csv;charset=utf-8")}
              >
                <Download size={14} aria-hidden="true" />Export CSV
              </button>
            </div>
          </div>

          <div className="eval-category-grid">
            <button
              type="button"
              className={"eval-cat-card" + (categoryFilter === "all" ? " is-active" : "")}
              onClick={() => setCategoryFilter("all")}
            >
              <span>All Categories</span>
              <strong>{activeRun.passedCases}/{activeRun.totalCases}</strong>
              <small>{activeRun.passRatePct}% pass</small>
            </button>
            {activeRun.categorySummary.map((cat) => (
              <button
                key={cat.category}
                type="button"
                className={"eval-cat-card" + (categoryFilter === cat.category ? " is-active" : "") + (cat.passed < cat.total ? " has-fail" : "")}
                onClick={() => setCategoryFilter(cat.category)}
              >
                <span>{cat.label}</span>
                <strong>{cat.passed}/{cat.total}</strong>
                <small>{cat.passRatePct}% pass</small>
              </button>
            ))}
          </div>

          {runs.length > 1 && (
            <div className="eval-history-bar">
              <span>Run History ({runs.length}):</span>
              {runs.slice(0, 8).map((r) => (
                <button
                  key={r.runId}
                  type="button"
                  className={"eval-history-pill" + (r.runId === activeRun.runId ? " is-active" : "")}
                  onClick={() => setSelectedRunId(r.runId)}
                >
                  {r.passRatePct}% · {new Date(r.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </button>
              ))}
            </div>
          )}

          <div className="eval-table-wrap">
            <table className="eval-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Severity</th>
                  <th>Test Case</th>
                  <th>Expected → Actual</th>
                  <th>Latency</th>
                </tr>
              </thead>
              <tbody>
                {filteredResults.map((item) => (
                  <tr key={item.id} className={item.passed ? "is-pass" : "is-fail"}>
                    <td>
                      <span className={`eval-pass-pill ${item.passed ? "is-pass" : "is-fail"}`}>
                        {item.passed ? <CheckCircle2 size={13} aria-hidden="true" /> : <XCircle size={13} aria-hidden="true" />}
                        {item.passed ? "PASS" : "FAIL"}
                      </span>
                    </td>
                    <td><span className={`eval-sev-pill is-${item.severity}`}>{item.severity}</span></td>
                    <td>
                      <strong>{item.name}</strong>
                      <div className="eval-case-prompt">Prompt: “{item.prompt}”</div>
                      <div className="eval-case-detail">{item.details}</div>
                    </td>
                    <td>
                      <div className="eval-kv"><span>Expected:</span> <code>{item.expected}</code></div>
                      <div className="eval-kv"><span>Actual:</span> <code>{item.actual}</code></div>
                    </td>
                    <td className="eval-ms">{item.durationMs}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="eval-empty-state">
          <ShieldCheck size={28} aria-hidden="true" />
          <h3>No Eval Runs Recorded Yet</h3>
          <p>Click <strong>Run Guardrail Eval Suite</strong> above to run all 16 routing, HITL, prompt-injection, financial math, workflow, and A2UI v1.0 schema checks.</p>
        </div>
      )}

      <div className="eval-audit-export">
        <div className="eval-audit-head">
          <div>
            <h3><FileCheck2 size={16} aria-hidden="true" /> Signed Compliance Audit Packet (FINRA / OCC SR 11-7 / EU AI Act Art. 14)</h3>
            <p>
              Bundles live HITL Approval Policy, SHA-256 Approval Records, <code>sfield</code> Governed Write Audit,
              Omnichannel Webhook Deliveries, Durable Workflow Runs, and Latest Eval Scorecard into a single SHA-256 signed evidence packet.
            </p>
          </div>
          <div className="eval-controls">
            <button type="button" className="secondary-button" disabled={exporting} onClick={previewCompliancePacket}>
              Preview Packet Summary
            </button>
            <button type="button" className="eval-run-btn" disabled={exporting} onClick={exportComplianceJson}>
              <Download size={14} aria-hidden="true" />
              Download Signed Audit Packet (.json)
            </button>
          </div>
        </div>

        {packet && (
          <div className="eval-packet-preview">
            <div className="eval-packet-meta">
              <span>Packet ID: <code>{packet.packetId}</code></span>
              <span>SHA-256 Packet Digest: <code>{packet.packetDigest}</code></span>
              <span>Approvals: <strong>{packet.summary.totalApprovals}</strong> ({packet.summary.executedApprovals} executed, {packet.summary.pendingApprovals} pending)</span>
              <span>Governed Writes: <strong>{packet.summary.governedWrites}</strong></span>
              <span>Workflow Runs: <strong>{packet.summary.workflowRuns}</strong></span>
              <span>Eval Gate: <strong>{packet.summary.latestReleaseGate}</strong></span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
