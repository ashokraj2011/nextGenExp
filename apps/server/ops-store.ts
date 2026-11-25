import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  incidentRecordSchema,
  type IncidentDecisionInput,
  type IncidentRecord,
  type OpsIncidentsView,
  type OpsSummary,
} from "../../packages/contracts/ops";

function defaultIncidents(nowIso: string): IncidentRecord[] {
  return [
    {
      id: "INC-4821",
      title: "Checkout & Auth Edge 5xx Spike after Release v2.14.3",
      severity: "P1",
      status: "open",
      service: "Checkout API + Auth Gateway",
      environment: "Production · US-East",
      errorRatePct: 4.8,
      baselineErrorRatePct: 0.2,
      p95LatencyMs: 640,
      affectedUsers: 1840,
      currentRelease: "v2.14.3",
      previousRelease: "v2.14.2",
      slaMinutes: 30,
      owner: "On-Call SRE · Release Bot",
      summary: "Elevated 502/504 responses observed 6 minutes after canary ramp reached 100% on US-East edge nodes. Instant rollback to healthy build v2.14.2 is verified with zero schema migrations.",
      rollbackStatus: "pending",
      timeline: [
        {
          time: "03:42 UTC",
          title: "Release v2.14.3 promoted to 100% traffic",
          detail: "Automated pipeline completed rollout across US-East clusters.",
          owner: "Release Bot",
          status: "done",
        },
        {
          time: "03:48 UTC",
          title: "SLO burn alert triggered (4.8% 5xx)",
          detail: "Checkout API error budget exceeded 24x baseline; p95 latency hit 640ms.",
          owner: "Datadog Monitor",
          status: "done",
        },
        {
          time: "03:51 UTC",
          title: "Rollback to v2.14.2 staged — awaiting approval",
          detail: "Pre-flight checks passed; zero database schema migration conflicts.",
          owner: "On-Call SRE",
          status: "active",
        },
        {
          time: "Pending",
          title: "Verify edge error rate < 0.2% & close bridge",
          detail: "Post-rollback telemetry confirmation and stakeholder status update.",
          owner: "Incident Commander",
          status: "pending",
        },
      ],
      updatedAt: nowIso,
    },
    {
      id: "INC-4819",
      title: "Token Introspection Cache Miss Surge",
      severity: "P2",
      status: "mitigating",
      service: "Identity Session Store",
      environment: "Production · EU-West",
      errorRatePct: 1.1,
      baselineErrorRatePct: 0.1,
      p95LatencyMs: 310,
      affectedUsers: 420,
      currentRelease: "v4.9.1",
      previousRelease: "v4.9.0",
      slaMinutes: 60,
      owner: "Identity Platform Team",
      summary: "Redis replica failover caused elevated cache misses; read replicas are warming back to normal hit ratio.",
      rollbackStatus: "not_applicable",
      timeline: [
        {
          time: "02:55 UTC",
          title: "Redis shard-2 failover detected",
          detail: "Cache hit ratio dipped from 99.1% to 84.3%.",
          owner: "Redis Sentinel",
          status: "done",
        },
        {
          time: "03:12 UTC",
          title: "Replica warm-up in progress",
          detail: "Hit ratio recovering (94.6%); monitoring until > 98%.",
          owner: "Identity SRE",
          status: "active",
        },
      ],
      updatedAt: nowIso,
    },
    {
      id: "INC-4812",
      title: "Nightly Ledger Reconciliation Delay",
      severity: "P3",
      status: "open",
      service: "Batch Settlement Worker",
      environment: "Production · Global",
      errorRatePct: 0.4,
      baselineErrorRatePct: 0.1,
      p95LatencyMs: 890,
      affectedUsers: 0,
      currentRelease: "v1.22.0",
      previousRelease: "v1.21.8",
      slaMinutes: 240,
      owner: "Core Ops Engineering",
      summary: "Upstream SFTP file arrived 18 minutes late; batch queue is draining smoothly with no customer-facing impact.",
      rollbackStatus: "not_applicable",
      timeline: [
        {
          time: "01:18 UTC",
          title: "Upstream feed delay logged",
          detail: "Worker auto-retried and started processing at 01:22 UTC.",
          owner: "Batch Scheduler",
          status: "done",
        },
        {
          time: "03:30 UTC",
          title: "Queue drain 82% complete",
          detail: "Estimated completion in 12 minutes.",
          owner: "Core Ops",
          status: "active",
        },
      ],
      updatedAt: nowIso,
    },
  ];
}

function formatUtcClock(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

export class OpsIncidentStore {
  private readonly filePath: string;
  private incidents: IncidentRecord[];

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "incidents.json");
    this.incidents = this.load();
  }

  private load(): IncidentRecord[] {
    if (existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
        if (Array.isArray(raw)) {
          const parsed = raw
            .map((item) => incidentRecordSchema.safeParse(item))
            .filter((res): res is { success: true; data: IncidentRecord } => res.success)
            .map((res) => res.data);
          if (parsed.length > 0) return parsed;
        }
      } catch {
        // Fall through to seed defaults
      }
    }
    const seeded = defaultIncidents(new Date().toISOString());
    this.save(seeded);
    return seeded;
  }

  private save(records: IncidentRecord[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(records, null, 2), "utf8");
    this.incidents = records;
  }

  list(): IncidentRecord[] {
    return this.incidents.map((item) => ({ ...item, timeline: item.timeline.map((ev) => ({ ...ev })) }));
  }

  findById(id: string): IncidentRecord | undefined {
    return this.list().find((item) => item.id.toLowerCase() === id.toLowerCase());
  }

  primaryIncident(): IncidentRecord {
    const all = this.list();
    return (
      all.find((i) => i.severity === "P1" && i.status === "open")
      ?? all.find((i) => i.severity === "P1")
      ?? all[0]
    );
  }

  summary(): OpsSummary {
    const all = this.incidents;
    const openish = all.filter((i) => i.status !== "resolved" && i.status !== "rolled_back");
    return {
      totalOpen: openish.length,
      activeP1Count: openish.filter((i) => i.severity === "P1").length,
      pendingRollbacks: all.filter((i) => i.rollbackStatus === "pending").length,
      highestErrorRatePct: all.reduce((max, item) => Math.max(max, item.errorRatePct), 0),
      sourceLabel: "CEP Live Incident Store (incidents.json)",
    };
  }

  view(): OpsIncidentsView {
    return { summary: this.summary(), incidents: this.list() };
  }

  decide(id: string, input: IncidentDecisionInput): IncidentRecord | null {
    const idx = this.incidents.findIndex((item) => item.id.toLowerCase() === id.toLowerCase());
    if (idx < 0) return null;
    const existing = this.incidents[idx];
    const now = new Date();
    const clock = formatUtcClock(now);
    const actor = input.actor?.trim() || "CEP Operator";

    let updated: IncidentRecord;
    if (input.decision === "approve_rollback") {
      const nextTimeline = existing.timeline.map((ev) => (
        ev.status === "active" ? { ...ev, status: "done" as const } : ev
      ));
      nextTimeline.push({
        time: clock,
        title: `Rollback ${existing.currentRelease} → ${existing.previousRelease} approved & executed`,
        detail: input.note?.trim() || `Traffic shifted back to ${existing.previousRelease}; error rate dropped to 0.1% and p95 latency stabilized at 142ms.`,
        owner: actor,
        status: "done",
      });
      updated = {
        ...existing,
        status: "rolled_back",
        rollbackStatus: "approved",
        rollbackNote: `Approved by ${actor} at ${clock} — reverted to ${existing.previousRelease}`,
        errorRatePct: 0.1,
        p95LatencyMs: 142,
        affectedUsers: 0,
        timeline: nextTimeline.slice(-12),
        updatedAt: now.toISOString(),
      };
    } else if (input.decision === "reject_rollback") {
      const nextTimeline = [...existing.timeline, {
        time: clock,
        title: `Rollback held — active investigation continued`,
        detail: input.note?.trim() || `Operator held rollback on ${existing.currentRelease} to capture live traces.`,
        owner: actor,
        status: "active" as const,
      }];
      updated = {
        ...existing,
        status: "mitigating",
        rollbackStatus: "rejected",
        rollbackNote: `Held by ${actor} at ${clock} — investigation underway`,
        timeline: nextTimeline.slice(-12),
        updatedAt: now.toISOString(),
      };
    } else if (input.decision === "resolve") {
      const nextTimeline = existing.timeline.map((ev) => ({ ...ev, status: "done" as const }));
      nextTimeline.push({
        time: clock,
        title: `Incident ${existing.id} marked resolved`,
        detail: input.note?.trim() || `All SLO checks green across ${existing.environment}.`,
        owner: actor,
        status: "done",
      });
      updated = {
        ...existing,
        status: "resolved",
        errorRatePct: existing.baselineErrorRatePct,
        affectedUsers: 0,
        timeline: nextTimeline.slice(-12),
        updatedAt: now.toISOString(),
      };
    } else {
      const nextTimeline = [...existing.timeline, {
        time: clock,
        title: `Escalated to Executive On-Call`,
        detail: input.note?.trim() || `Escalated by ${actor} for cross-team incident bridge.`,
        owner: actor,
        status: "blocked" as const,
      }];
      updated = {
        ...existing,
        status: "escalated",
        timeline: nextTimeline.slice(-12),
        updatedAt: now.toISOString(),
      };
    }

    const nextList = [...this.incidents];
    nextList[idx] = updated;
    this.save(nextList);
    return updated;
  }

  reset(): OpsIncidentsView {
    const seeded = defaultIncidents(new Date().toISOString());
    this.save(seeded);
    return this.view();
  }
}
