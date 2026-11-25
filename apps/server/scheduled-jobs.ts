import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  scheduledJobExecutionSchema,
  scheduledJobSchema,
  scheduledJobUpsertSchema,
  type ScheduledJob,
  type ScheduledJobExecution,
  type ScheduledJobUpsertInput,
  type ScheduledJobsView,
} from "../../packages/contracts/scheduled-jobs";
import type { CustomerProfileStore } from "../../packages/customer-profiles";
import { makeId } from "../../packages/experience/compile";
import type { OpsIncidentStore } from "./ops-store";
import type { ProactiveEventStore } from "./proactive-engine";
import type { SalesDealStore } from "./sales-store";
import type { TradeStore } from "./trade-store";

interface PersistedScheduledState {
  jobs: ScheduledJob[];
  executions: ScheduledJobExecution[];
}

function defaultScheduledJobs(): ScheduledJob[] {
  return [
    {
      id: "weekly_tax_harvest_scan",
      name: "Weekly Tax-Loss Harvest Scanner",
      domain: "wealth",
      kind: "tax_harvest_scan",
      scheduleLabel: "Every Friday · 9:00 AM ET",
      intervalMinutes: 10_080,
      personaId: "demo-learner",
      thresholdUsd: 50,
      enabled: true,
      autoPushProactive: true,
      runCount: 0,
    },
    {
      id: "daily_idle_cash_sweep",
      name: "Daily Idle Cash Reserve Monitor",
      domain: "wealth",
      kind: "idle_cash_sweep",
      scheduleLabel: "Daily · 8:30 AM ET",
      intervalMinutes: 1_440,
      personaId: "demo-learner",
      thresholdUsd: 20_000,
      enabled: true,
      autoPushProactive: true,
      runCount: 0,
    },
    {
      id: "hourly_p1_slo_monitor",
      name: "Hourly P1 SLO & Error-Budget Watch",
      domain: "operations",
      kind: "p1_slo_monitor",
      scheduleLabel: "Every 60 minutes",
      intervalMinutes: 60,
      personaId: "demo-learner",
      enabled: true,
      autoPushProactive: true,
      runCount: 0,
    },
    {
      id: "daily_deal_desk_audit",
      name: "Daily Deal Desk Discount Risk Audit",
      domain: "sales",
      kind: "deal_risk_audit",
      scheduleLabel: "Daily · 7:00 AM ET",
      intervalMinutes: 1_440,
      personaId: "demo-learner",
      thresholdUsd: 15,
      enabled: true,
      autoPushProactive: true,
      runCount: 0,
    },
  ];
}

export class ScheduledJobStore {
  private readonly filePath: string;
  private state: PersistedScheduledState;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    dataDir: string,
    private readonly deps: {
      profileStore: CustomerProfileStore;
      tradeStore: TradeStore;
      opsStore: OpsIncidentStore;
      salesStore: SalesDealStore;
      proactiveStore: ProactiveEventStore;
    },
  ) {
    this.filePath = join(dataDir, "scheduled-jobs.json");
    this.state = this.load();
  }

  private load(): PersistedScheduledState {
    if (existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PersistedScheduledState>;
        const jobs = Array.isArray(raw.jobs)
          ? raw.jobs
              .map((item) => scheduledJobSchema.safeParse(item))
              .filter((r): r is { success: true; data: ScheduledJob } => r.success)
              .map((r) => r.data)
          : [];
        const executions = Array.isArray(raw.executions)
          ? raw.executions
              .map((item) => scheduledJobExecutionSchema.safeParse(item))
              .filter((r): r is { success: true; data: ScheduledJobExecution } => r.success)
              .map((r) => r.data)
          : [];
        if (jobs.length > 0) return { jobs, executions: executions.slice(0, 40) };
      } catch { /* fall through */ }
    }
    const fresh: PersistedScheduledState = { jobs: defaultScheduledJobs(), executions: [] };
    this.save(fresh);
    return fresh;
  }

  private save(next: PersistedScheduledState): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify({ ...next, executions: next.executions.slice(0, 40) }, null, 2), "utf8");
    this.state = { ...next, executions: next.executions.slice(0, 40) };
  }

  startTicker(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const nowMs = Date.now();
      for (const job of this.state.jobs) {
        if (!job.enabled) continue;
        const lastMs = job.lastRunAt ? new Date(job.lastRunAt).getTime() : 0;
        if (lastMs > 0 && nowMs - lastMs >= job.intervalMinutes * 60_000) {
          this.runJob(job.id, "scheduler");
        }
      }
    }, 60_000);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  view(): ScheduledJobsView {
    return {
      jobs: this.state.jobs.map((j) => ({ ...j })),
      executions: this.state.executions.slice(0, 20).map((e) => ({ ...e })),
    };
  }

  upsert(rawInput: ScheduledJobUpsertInput): ScheduledJobsView {
    const parsed = scheduledJobUpsertSchema.parse(rawInput);
    const existing = this.state.jobs.find((j) => j.id === parsed.id);
    const record: ScheduledJob = {
      ...parsed,
      ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
      ...(existing?.lastStatus ? { lastStatus: existing.lastStatus } : {}),
      ...(existing?.lastSummary ? { lastSummary: existing.lastSummary } : {}),
      runCount: existing?.runCount ?? 0,
    };
    const jobs = existing
      ? this.state.jobs.map((j) => (j.id === parsed.id ? record : j))
      : [record, ...this.state.jobs];
    this.save({ ...this.state, jobs });
    return this.view();
  }

  runJob(jobId: string, triggeredBy: "scheduler" | "manual" = "manual"): { execution: ScheduledJobExecution; view: ScheduledJobsView } {
    const job = this.state.jobs.find((j) => j.id === jobId);
    if (!job) throw new Error(`Scheduled job "${jobId}" not found.`);

    const ranAt = new Date().toISOString();
    let status: ScheduledJobExecution["status"] = "no_action";
    let summary = "No actionable threshold exceeded.";
    let metricValue = "OK";
    let alertId: string | undefined;

    try {
      if (job.kind === "tax_harvest_scan") {
        const analysis = this.deps.tradeStore.analyzeTaxHarvest(job.personaId, "AAPL", 10);
        const savedUsd = Math.round(analysis.estimatedTaxSavingsCents / 100);
        const minUsd = job.thresholdUsd ?? 100;
        metricValue = `$${savedUsd} est. tax offset`;
        if (savedUsd >= minUsd && analysis.recommendations.length > 0) {
          const top = analysis.recommendations[0];
          summary = `Found ${analysis.recommendations.length} harvestable loss lot (${top.recommendedShares} ${top.symbol}) saving ~$${savedUsd} against AAPL gains.`;
          status = "alert_pushed";
          if (job.autoPushProactive) {
            const pushed = this.deps.proactiveStore.trigger({
              eventType: "market.price_alert",
              personaId: job.personaId,
              title: `Autonomous Scan · $${savedUsd} Tax-Loss Harvest Opportunity`,
              summary,
              metricLabel: "Est. Tax Savings",
              metricValue: `$${savedUsd}`,
              ctaLabel: "Simulate 40% AAPL Trim + Tax Harvest",
              ctaPrompt: "I want to sell 40% of my Apple shares",
            });
            alertId = pushed.alert.id;
          }
        } else {
          summary = `Scanned holdings — estimated tax savings ($${savedUsd}) below $${minUsd} threshold.`;
        }
      } else if (job.kind === "idle_cash_sweep") {
        const snap = this.deps.tradeStore.snapshotFor(job.personaId);
        const cashUsd = Math.round(snap.cashCents / 100);
        const threshold = job.thresholdUsd ?? 20_000;
        metricValue = `$${cashUsd.toLocaleString("en-US")} cash`;
        if (cashUsd >= threshold) {
          summary = `Cash reserve ($${cashUsd.toLocaleString("en-US")}) exceeds $${threshold.toLocaleString("en-US")} target buffer. Ready for allocation or governed wire.`;
          status = "alert_pushed";
          if (job.autoPushProactive) {
            const pushed = this.deps.proactiveStore.trigger({
              eventType: "portfolio.large_deposit",
              personaId: job.personaId,
              title: `Autonomous Sweep · $${cashUsd.toLocaleString("en-US")} Idle Cash Detected`,
              summary,
              metricLabel: "Idle Cash",
              metricValue: `$${cashUsd.toLocaleString("en-US")}`,
              ctaLabel: "Review Portfolio Allocation",
              ctaPrompt: "Let me know my portfolio summary.",
            });
            alertId = pushed.alert.id;
          }
        } else {
          summary = `Cash reserve ($${cashUsd.toLocaleString("en-US")}) within $${threshold.toLocaleString("en-US")} target.`;
        }
      } else if (job.kind === "p1_slo_monitor") {
        const inc = this.deps.opsStore.primaryIncident();
        metricValue = inc ? `${inc.errorRatePct}% 5xx · ${inc.p95LatencyMs}ms` : "Healthy";
        if (inc && inc.status !== "resolved") {
          summary = `Active ${inc.severity} incident ${inc.id} on ${inc.service} (${inc.errorRatePct}% 5xx, ${inc.p95LatencyMs}ms p95). Rollback triage staged.`;
          status = "alert_pushed";
          if (job.autoPushProactive) {
            const pushed = this.deps.proactiveStore.trigger({
              eventType: "ops.latency_spike",
              personaId: job.personaId,
              title: `Autonomous SLO Watch · ${inc.id} (${inc.service} ${inc.errorRatePct}% 5xx)`,
              summary,
              metricLabel: "Edge 5xx",
              metricValue: `${inc.errorRatePct}%`,
              ctaLabel: "Open P1 Rollback Triage",
              ctaPrompt: "Build an IT incident triage dashboard for our active P1 alert",
            });
            alertId = pushed.alert.id;
          }
        } else {
          summary = "All production SLOs healthy — zero open P1 incidents.";
        }
      } else if (job.kind === "deal_risk_audit") {
        const deal = this.deps.salesStore.primaryDeal();
        const capPct = job.thresholdUsd ?? 15;
        metricValue = deal ? `${deal.discountPct}% off · $${deal.arrUsd.toLocaleString("en-US")}` : "Clean";
        if (deal && deal.discountPct > capPct && deal.discountStatus === "pending") {
          summary = `${deal.accountName} (${deal.id}, $${deal.arrUsd.toLocaleString("en-US")} ARR) requests ${deal.discountPct}% discount (exceeds ${capPct}% AE cap).`;
          status = "alert_pushed";
          if (job.autoPushProactive) {
            const pushed = this.deps.proactiveStore.trigger({
              eventType: "sales.deal_at_risk",
              personaId: job.personaId,
              title: `Autonomous Deal Audit · ${deal.accountName} (${deal.discountPct}% Discount)`,
              summary,
              metricLabel: "At-Risk ARR",
              metricValue: `$${deal.arrUsd.toLocaleString("en-US")}`,
              ctaLabel: "Review Deal Desk Approval",
              ctaPrompt: "Show the enterprise discount approval card for Acme Cloud Corp",
            });
            alertId = pushed.alert.id;
          }
        } else {
          summary = "No pending enterprise deals exceed standard discount authority.";
        }
      }
    } catch (err) {
      status = "error";
      summary = err instanceof Error ? err.message : "Job execution failed.";
    }

    const execution: ScheduledJobExecution = {
      executionId: makeId("jobrun"),
      jobId: job.id,
      jobName: job.name,
      domain: job.domain,
      triggeredBy,
      ranAt,
      status,
      summary,
      metricValue,
      ...(alertId ? { alertId } : {}),
    };

    const jobs = this.state.jobs.map((j) => (j.id === job.id
      ? { ...j, lastRunAt: ranAt, lastStatus: status, lastSummary: summary, runCount: j.runCount + 1 }
      : j));
    this.save({ jobs, executions: [execution, ...this.state.executions] });
    return { execution, view: this.view() };
  }
}
