import { useEffect, useState } from "react";
import { Activity, CheckCircle2, Download, RotateCw, ShieldCheck, Trash2, XCircle } from "lucide-react";
import type { TelemetryView } from "../../packages/contracts/telemetry";
import { api, toolSetupErrorMessage } from "./api";

export function TelemetryPanel() {
  const [data, setData] = useState<TelemetryView>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tick, setTick] = useState(0);
  const [expandedSpanId, setExpandedSpanId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void api.telemetry().then(
      (res) => { if (active) setData(res); },
      (err: unknown) => { if (active) setError(toolSetupErrorMessage(err)); },
    );
    return () => { active = false; };
  }, [tick]);

  async function resetMetrics() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await api.resetTelemetry();
      setData(next);
      setNotice("Telemetry counters and span buffer cleared.");
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function downloadOtlp() {
    setBusy(true);
    setError("");
    try {
      const bundle = await api.exportOtlpTelemetry();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cep-otlp-traces-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice("Downloaded OpenTelemetry OTLP/HTTP JSON trace bundle.");
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const s = data?.summary;

  return (
    <section className="admin-card" aria-labelledby="otel-telemetry-title">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <div>
          <h2 id="otel-telemetry-title" style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <Activity size={18} aria-hidden="true" />
            OpenTelemetry (<code>gen_ai.*</code>) &amp; Cost Telemetry
          </h2>
          <p>
            Live spans captured via <code>sfield</code>&apos;s <code>TelemetrySink</code> and the single LLM egress layer (<code>gen_ai.operation.name</code>, token usage, latency p50/p95, PII redactions, and optional OTLP/HTTP export).
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => void downloadOtlp()}>
            <Download size={14} aria-hidden="true" />Export OTLP JSON
          </button>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => void resetMetrics()}>
            <Trash2 size={14} aria-hidden="true" />Reset
          </button>
          <button className="secondary-button" type="button" onClick={() => setTick((t) => t + 1)}>
            <RotateCw size={15} aria-hidden="true" />Refresh
          </button>
        </div>
      </div>

      {notice && <p role="status" style={{ marginTop: "10px", color: "var(--teal-dark)", fontWeight: 600 }}>{notice}</p>}
      {error && <p className="request-notice" role="alert" style={{ marginTop: "10px" }}>{error}</p>}
      {!data && !error && <p className="workspace-loading" role="status">Loading OpenTelemetry metrics…</p>}

      {data && s && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "10px", marginTop: "14px" }}>
            <div className="admin-kpi">
              <small>Model calls</small>
              <strong>{s.totalModelCalls}</strong>
              <span className="admin-muted">{s.modelSuccessRatePct}% ok · p95 {s.modelLatencyP95Ms} ms</span>
            </div>
            <div className="admin-kpi">
              <small>sfield tool calls</small>
              <strong>{s.totalToolCalls}</strong>
              <span className="admin-muted">{s.toolSuccessRatePct}% ok · p95 {s.toolLatencyP95Ms} ms</span>
            </div>
            <div className="admin-kpi">
              <small>Tokens (in / out)</small>
              <strong>{(s.totalInputTokens + s.totalOutputTokens).toLocaleString()}</strong>
              <span className="admin-muted">{s.totalInputTokens.toLocaleString()} in · {s.totalOutputTokens.toLocaleString()} out</span>
            </div>
            <div className="admin-kpi">
              <small>Estimated LLM cost</small>
              <strong>${s.estimatedCostUsd.toFixed(4)}</strong>
              <span className="admin-muted">{s.totalAgentRuns} agent runs</span>
            </div>
            <div className="admin-kpi">
              <small>PII tokens scrubbed</small>
              <strong style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                <ShieldCheck size={15} aria-hidden="true" />{s.piiRedactedTokens}
              </strong>
              <span className="admin-muted">at LLM egress boundary</span>
            </div>
            <div className="admin-kpi">
              <small>OTLP/HTTP exporter</small>
              <strong>{data.otlpExport.configured ? "Active" : "Local buffer"}</strong>
              <span className="admin-muted">
                {data.otlpExport.configured
                  ? `${data.otlpExport.exportedSpans} sent · ${data.otlpExport.failedExports} failed`
                  : "Set OTEL_EXPORTER_OTLP_ENDPOINT"}
              </span>
            </div>
          </div>

          {data.byModel.length > 0 && (
            <div style={{ marginTop: "18px" }}>
              <h3 style={{ fontSize: "0.95rem", marginBottom: "8px" }}>By model</h3>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.84rem" }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid var(--line)" }}>
                    <th style={{ padding: "6px" }}>Provider / Model</th>
                    <th style={{ padding: "6px" }}>Calls</th>
                    <th style={{ padding: "6px" }}>Errors</th>
                    <th style={{ padding: "6px" }}>Tokens (in / out)</th>
                    <th style={{ padding: "6px" }}>Avg latency</th>
                    <th style={{ padding: "6px" }}>Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byModel.map((m) => (
                    <tr key={`${m.provider}:${m.model}`} style={{ borderBottom: "1px solid var(--line)" }}>
                      <td style={{ padding: "6px" }}><code>{m.provider}</code> · <strong>{m.model}</strong></td>
                      <td style={{ padding: "6px" }}>{m.calls}</td>
                      <td style={{ padding: "6px" }}>{m.errors}</td>
                      <td style={{ padding: "6px" }}>{m.inputTokens.toLocaleString()} / {m.outputTokens.toLocaleString()}</td>
                      <td style={{ padding: "6px" }}>{m.avgLatencyMs} ms</td>
                      <td style={{ padding: "6px" }}>${m.estimatedCostUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.byTool.length > 0 && (
            <div style={{ marginTop: "18px" }}>
              <h3 style={{ fontSize: "0.95rem", marginBottom: "8px" }}>By sfield tool</h3>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.84rem" }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid var(--line)" }}>
                    <th style={{ padding: "6px" }}>Tool</th>
                    <th style={{ padding: "6px" }}>Calls</th>
                    <th style={{ padding: "6px" }}>Errors</th>
                    <th style={{ padding: "6px" }}>Avg duration</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byTool.map((t) => (
                    <tr key={t.tool} style={{ borderBottom: "1px solid var(--line)" }}>
                      <td style={{ padding: "6px" }}><code>{t.tool}</code></td>
                      <td style={{ padding: "6px" }}>{t.calls}</td>
                      <td style={{ padding: "6px" }}>{t.errors}</td>
                      <td style={{ padding: "6px" }}>{t.avgLatencyMs} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ marginTop: "18px" }}>
            <h3 style={{ fontSize: "0.95rem", marginBottom: "8px" }}>Recent OpenTelemetry spans ({data.recentSpans.length})</h3>
            {data.recentSpans.length === 0 ? (
              <p className="admin-muted">No spans recorded yet. Send a chat message or run a task to populate <code>gen_ai.*</code> traces.</p>
            ) : (
              <div style={{ display: "grid", gap: "6px" }}>
                {data.recentSpans.slice(0, 30).map((span) => {
                  const open = expandedSpanId === span.spanId;
                  return (
                    <div key={span.spanId} style={{ border: "1px solid var(--line)", borderRadius: "8px", padding: "8px 10px", fontSize: "0.82rem" }}>
                      <button
                        type="button"
                        onClick={() => setExpandedSpanId(open ? null : span.spanId)}
                        style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", background: "none", border: "none", cursor: "pointer", padding: 0, color: "inherit", textAlign: "left" }}
                      >
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                          {span.status === "ok"
                            ? <CheckCircle2 size={14} style={{ color: "var(--teal-dark)" }} aria-hidden="true" />
                            : <XCircle size={14} style={{ color: "#b91c1c" }} aria-hidden="true" />}
                          <strong>{span.name}</strong>
                          <code style={{ opacity: 0.75 }}>{span.operation}</code>
                        </span>
                        <span style={{ display: "inline-flex", gap: "10px", opacity: 0.8 }}>
                          <span>{span.durationMs} ms</span>
                          <code>{span.traceId.slice(0, 8)}</code>
                        </span>
                      </button>
                      {open && (
                        <pre style={{ marginTop: "8px", padding: "8px", borderRadius: "6px", background: "var(--surface-muted, rgba(127,127,127,0.08))", overflowX: "auto", fontSize: "0.75rem" }}>
                          {JSON.stringify({ traceId: span.traceId, spanId: span.spanId, status: span.status, ...(span.errorMessage ? { errorMessage: span.errorMessage } : {}), attributes: span.attributes }, null, 2)}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
