import { useEffect, useState } from "react";
import { Clock, Play, Sparkles } from "lucide-react";
import type { ScheduledJob, ScheduledJobExecution } from "../../packages/contracts/scheduled-jobs";
import { api } from "./api";

export function ScheduledJobsCard() {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [executions, setExecutions] = useState<ScheduledJobExecution[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let alive = true;
    void api.scheduledJobs().then((view) => {
      if (!alive) return;
      setJobs(view.jobs);
      setExecutions(view.executions);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  async function toggleJob(job: ScheduledJob) {
    setBusyId(job.id);
    setNotice("");
    try {
      const view = await api.saveScheduledJob({
        id: job.id,
        name: job.name,
        domain: job.domain,
        kind: job.kind,
        scheduleLabel: job.scheduleLabel,
        intervalMinutes: job.intervalMinutes,
        personaId: job.personaId,
        ...(job.thresholdUsd !== undefined ? { thresholdUsd: job.thresholdUsd } : {}),
        enabled: !job.enabled,
        autoPushProactive: job.autoPushProactive,
      });
      setJobs(view.jobs);
      setExecutions(view.executions);
      setNotice(`${!job.enabled ? "Enabled" : "Paused"} autonomous job "${job.name}".`);
    } catch (err: unknown) {
      setNotice(err instanceof Error ? err.message : "Could not update job.");
    } finally {
      setBusyId(null);
    }
  }

  async function runNow(job: ScheduledJob) {
    setBusyId(job.id);
    setNotice("");
    try {
      const res = await api.runScheduledJob(job.id);
      setJobs(res.view.jobs);
      setExecutions(res.view.executions);
      setNotice(
        `Executed "${job.name}" → ${res.execution.status.replace("_", " ").toUpperCase()}: ${res.execution.summary}`
        + (res.execution.alertId ? " (Live Proactive SSE Alert pushed to Chat & /embed!)" : ""),
      );
    } catch (err: unknown) {
      setNotice(err instanceof Error ? err.message : "Could not run scheduled job.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="embed-card scheduled-jobs-card" aria-labelledby="scheduled-jobs-title">
      <div className="embed-omni-head">
        <div>
          <h2 id="scheduled-jobs-title"><Clock size={16} aria-hidden="true" /> 5. Scheduled Autonomous Agent Jobs (Recurring Monitors)</h2>
          <p className="embed-card-sub">
            Background autonomous monitors inspect live <strong>TradeStore</strong>, <strong>Customer 360</strong>, <strong>IT Ops Incidents</strong>, and{" "}
            <strong>Sales Deals</strong> on a recurring schedule (or on-demand via <strong>Run Now</strong>) and push live <strong>Proactive SSE Alerts</strong> into Chat &amp; <code>/embed</code>.
          </p>
        </div>
      </div>

      {notice && <div className="embed-notice" role="status">{notice}</div>}

      <div className="sched-grid">
        {jobs.map((job) => (
          <div key={job.id} className={"sched-card" + (!job.enabled ? " is-paused" : "")}>
            <div className="sched-card-top">
              <div>
                <strong>{job.name}</strong>
                <span className="sched-cadence">{job.scheduleLabel} · {job.domain}</span>
              </div>
              <label className="sched-toggle">
                <input
                  type="checkbox"
                  checked={job.enabled}
                  disabled={busyId === job.id}
                  onChange={() => void toggleJob(job)}
                />
                <span>{job.enabled ? "Active" : "Paused"}</span>
              </label>
            </div>
            {job.lastSummary ? (
              <p className="sched-last">{job.lastSummary}</p>
            ) : (
              <p className="sched-last is-muted">Never executed yet · Runs automatically on interval or click Run Now.</p>
            )}
            <div className="sched-card-foot">
              <span className="sched-meta">Runs: <strong>{job.runCount}</strong>{job.thresholdUsd !== undefined ? ` · Threshold: ${job.kind === "deal_risk_audit" ? `${job.thresholdUsd}%` : `$${job.thresholdUsd.toLocaleString("en-US")}`}` : ""}</span>
              <button
                type="button"
                className="embed-primary-btn"
                disabled={busyId === job.id}
                onClick={() => void runNow(job)}
              >
                <Play size={13} aria-hidden="true" />
                {busyId === job.id ? "Scanning…" : "Run Now"}
              </button>
            </div>
          </div>
        ))}
      </div>

      {executions.length > 0 && (
        <div className="embed-delivery-log" style={{ marginTop: "14px" }}>
          <h3><Sparkles size={14} aria-hidden="true" /> Recent Autonomous Job Executions ({executions.length})</h3>
          <div className="embed-delivery-list">
            {executions.slice(0, 6).map((ex) => (
              <div key={ex.executionId} className="embed-delivery-row">
                <div className="embed-delivery-top">
                  <span className={`embed-status-pill is-${ex.status === "alert_pushed" ? "delivered" : ex.status === "error" ? "failed" : "sandbox_preview"}`}>
                    {ex.status.replace("_", " ")}
                  </span>
                  <strong>{ex.jobName}</strong>
                  <span className="embed-delivery-meta">{ex.metricValue} · {ex.triggeredBy}</span>
                </div>
                <small>{ex.summary}</small>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
