import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  dealRecordSchema,
  type DealDecisionInput,
  type DealRecord,
  type SalesDealsView,
  type SalesSummary,
} from "../../packages/contracts/sales";

function defaultDeals(nowIso: string): DealRecord[] {
  return [
    {
      id: "DEAL-904",
      accountName: "Acme Cloud Corp",
      title: "3-Year Enterprise Platform Expansion (1,500 seats)",
      stage: "Negotiation",
      arrUsd: 480_000,
      discountPct: 18,
      discountStatus: "pending",
      winProbabilityPct: 75,
      closeDate: "2026-12-18",
      owner: "Jordan Blake · Enterprise AE",
      segment: "Enterprise · North America",
      summary: "Multi-year platform consolidation with upfront Year 1 billing. Customer procurement requested an 18% volume discount (3% above standard AE threshold) in exchange for a signed 36-month term before Q4 close.",
      timeline: [
        {
          time: "Nov 04",
          title: "Technical POC & security sign-off completed",
          detail: "SOC2 Type II and SSO integration approved by Acme CISO.",
          owner: "Solutions Architect",
          status: "done",
        },
        {
          time: "Nov 18",
          title: "Redlines & MSA finalized with legal",
          detail: "Standard liability cap and data residency terms accepted.",
          owner: "Commercial Legal",
          status: "done",
        },
        {
          time: "Active",
          title: "18% multi-year volume discount awaiting Deal Desk approval",
          detail: "Exceeds 15% AE band by 3%; locks in $1.44M total contract value.",
          owner: "VP Revenue Operations",
          status: "active",
        },
        {
          time: "Dec 18",
          title: "Order form signature & Q4 revenue booking",
          detail: "Target countersignature before fiscal quarter close.",
          owner: "Jordan Blake",
          status: "pending",
        },
      ],
      updatedAt: nowIso,
    },
    {
      id: "DEAL-887",
      accountName: "Northstar FinTech",
      title: "Core Analytics Suite Annual License",
      stage: "Security Review",
      arrUsd: 310_000,
      discountPct: 10,
      discountStatus: "none",
      winProbabilityPct: 60,
      closeDate: "2026-12-22",
      owner: "Priya Nair · Strategic AE",
      segment: "Mid-Market · Financial Services",
      summary: "Standard 10% tier pricing within AE guidelines. Final penetration test review scheduled to complete this week.",
      timeline: [
        {
          time: "Nov 10",
          title: "Executive sponsor alignment",
          detail: "VP Data Engineering confirmed Q4 budget allocation.",
          owner: "Priya Nair",
          status: "done",
        },
        {
          time: "Active",
          title: "InfoSec questionnaire & pen-test sign-off",
          detail: "2 low-severity clarifications under review.",
          owner: "Security Engineering",
          status: "active",
        },
      ],
      updatedAt: nowIso,
    },
    {
      id: "DEAL-912",
      accountName: "Horizon Logistics",
      title: "Global Ops Automation Rollout",
      stage: "Proposal",
      arrUsd: 225_000,
      discountPct: 8,
      discountStatus: "none",
      winProbabilityPct: 45,
      closeDate: "2027-01-15",
      owner: "Devon Brooks · Enterprise AE",
      segment: "Enterprise · EMEA",
      summary: "Initial commercial proposal delivered covering 4 regional hubs; procurement kickoff scheduled next Tuesday.",
      timeline: [
        {
          time: "Nov 14",
          title: "ROI business case presented to CFO",
          detail: "Projected 3.4x payback within 9 months.",
          owner: "Devon Brooks",
          status: "done",
        },
        {
          time: "Active",
          title: "Procurement commercial review",
          detail: "Awaiting regional deployment phasing confirmation.",
          owner: "Horizon Procurement",
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

export class SalesDealStore {
  private readonly filePath: string;
  private deals: DealRecord[];

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "deals.json");
    this.deals = this.load();
  }

  private load(): DealRecord[] {
    if (existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
        if (Array.isArray(raw)) {
          const parsed = raw
            .map((item) => dealRecordSchema.safeParse(item))
            .filter((res): res is { success: true; data: DealRecord } => res.success)
            .map((res) => res.data);
          if (parsed.length > 0) return parsed;
        }
      } catch {
        // Seed defaults on parse error
      }
    }
    const seeded = defaultDeals(new Date().toISOString());
    this.save(seeded);
    return seeded;
  }

  private save(records: DealRecord[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(records, null, 2), "utf8");
    this.deals = records;
  }

  list(): DealRecord[] {
    return this.deals.map((d) => ({ ...d, timeline: d.timeline.map((ev) => ({ ...ev })) }));
  }

  primaryDeal(): DealRecord {
    const all = this.list();
    return all.find((d) => d.discountStatus === "pending") ?? all[0];
  }

  summary(): SalesSummary {
    const all = this.deals;
    const totalPipelineUsd = all.reduce((sum, d) => sum + d.arrUsd, 0);
    const weightedForecastUsd = Math.round(all.reduce((sum, d) => sum + (d.arrUsd * d.winProbabilityPct) / 100, 0));
    return {
      totalPipelineUsd,
      weightedForecastUsd,
      pendingApprovals: all.filter((d) => d.discountStatus === "pending").length,
      activeDeals: all.length,
      sourceLabel: "CEP Live CRM Deal Store (deals.json)",
    };
  }

  view(): SalesDealsView {
    return { summary: this.summary(), deals: this.list() };
  }

  decide(id: string, input: DealDecisionInput): DealRecord | null {
    const idx = this.deals.findIndex((d) => d.id.toLowerCase() === id.toLowerCase());
    if (idx < 0) return null;
    const existing = this.deals[idx];
    const now = new Date();
    const clock = formatUtcClock(now);
    const actor = input.actor?.trim() || "VP Revenue Operations";

    let updated: DealRecord;
    if (input.decision === "approve_discount") {
      const nextTimeline = existing.timeline.map((ev) => (ev.status === "active" ? { ...ev, status: "done" as const } : ev));
      nextTimeline.push({
        time: clock,
        title: `${existing.discountPct}% discount approved — deal moved to Commit`,
        detail: input.note?.trim() || `Approved by ${actor}; order form unlocked for Q4 signature (${existing.winProbabilityPct}% → 92% win probability).`,
        owner: actor,
        status: "done",
      });
      updated = {
        ...existing,
        stage: "Commit",
        discountStatus: "approved",
        discountNote: `Approved by ${actor} at ${clock} — moved to Commit (92% probability)`,
        winProbabilityPct: 92,
        timeline: nextTimeline.slice(-12),
        updatedAt: now.toISOString(),
      };
    } else if (input.decision === "reject_discount") {
      const nextTimeline = [...existing.timeline, {
        time: clock,
        title: `${existing.discountPct}% discount held — counter-offer requested`,
        detail: input.note?.trim() || `Deal Desk requested counter-offer at standard 15% cap.`,
        owner: actor,
        status: "active" as const,
      }];
      updated = {
        ...existing,
        discountStatus: "rejected",
        discountNote: `Held by ${actor} at ${clock} — counter-offer at 15% cap requested`,
        timeline: nextTimeline.slice(-12),
        updatedAt: now.toISOString(),
      };
    } else {
      updated = {
        ...existing,
        stage: "Commit",
        winProbabilityPct: Math.min(95, existing.winProbabilityPct + 15),
        updatedAt: now.toISOString(),
      };
    }

    const nextList = [...this.deals];
    nextList[idx] = updated;
    this.save(nextList);
    return updated;
  }

  reset(): SalesDealsView {
    const seeded = defaultDeals(new Date().toISOString());
    this.save(seeded);
    return this.view();
  }
}
