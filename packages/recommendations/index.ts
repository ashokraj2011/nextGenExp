import {
  recommendationArbitrateToolRef,
  type NormalizedRecommendation,
  type ProviderExecutionTrace,
  type RecommendationArbitrateResult,
  type RecommendationProvider,
  type RecommendationProviderContext,
  type RecommendationProviderDescriptor,
} from "../contracts/recommendation-provider";
import type { TreatmentRecommendations } from "../contracts/funding-workflow";
import type { NextBestActionCard } from "../contracts/api";
import type { IncidentRecord } from "../contracts/ops";
import type { DealRecord } from "../contracts/sales";
import { findEffectiveContentById } from "../experience-registry/registry";
import { makeId } from "../experience/compile";

export function createTreatmentSelectorProvider(
  selectEligible: (mid: string, contextId: string, signal: AbortSignal) => Promise<{
    recommendations: TreatmentRecommendations;
  }>,
): RecommendationProvider {
  return {
    id: "treatment_selector",
    label: "Treatment Selector (TS + CCRE)",
    description: "Evaluates CCRE eligibility rules, ranking overrides, and approved content/workflow treatments per customer MID.",
    domains: ["wealth"],
    toolRef: "treatments.eligible@1.0.0",
    async evaluate(ctx, signal) {
      const result = await selectEligible(ctx.syntheticMid, ctx.contextId, signal);
      return result.recommendations.recommendations.map((rec, index): NormalizedRecommendation => {
        if (rec.kind === "workflow") {
          return {
            id: `ts_workflow:${rec.id}@${rec.version}`,
            providerId: "treatment_selector",
            providerLabel: "Treatment Selector (TS + CCRE)",
            kind: "workflow",
            priority: 10 + index,
            title: `Workflow: ${rec.id}`,
            workflow: { capabilityId: rec.id, version: rec.version },
            badge: "Verified Workflow",
          };
        }
        const entry = findEffectiveContentById(rec.id);
        return {
          id: `ts_content:${rec.id}`,
          providerId: "treatment_selector",
          providerLabel: "Treatment Selector (TS + CCRE)",
          kind: "content",
          priority: 10 + index,
          title: entry?.title ?? rec.id,
          body: entry?.body,
          contentId: rec.id,
          badge: "TS Eligible",
        };
      });
    },
  };
}

export function createCustomer360NbaProvider(
  evaluateNba: (input: {
    principalId: string;
    personaId: string;
    fundingStatus: "funded" | "unfunded";
    excludePromotions: boolean;
    existingBlockTitles?: string[];
  }) => { nba?: NextBestActionCard },
): RecommendationProvider {
  return {
    id: "customer360_nba",
    label: "Customer 360 NBA Engine",
    description: "Arbitrates prioritized Next Best Action rules against live Customer 360 signals and persistent customer dismissals.",
    domains: ["wealth", "general"],
    async evaluate(ctx) {
      const { nba } = evaluateNba({
        principalId: ctx.principalId,
        personaId: ctx.personaId,
        fundingStatus: ctx.fundingStatus,
        excludePromotions: ctx.excludePromotions,
        existingBlockTitles: ctx.existingBlockTitles,
      });
      if (!nba) return [];
      return [{
        id: `c360_nba:${nba.id}`,
        providerId: "customer360_nba",
        providerLabel: "Customer 360 NBA Engine",
        kind: "nba",
        priority: 5,
        title: nba.title,
        body: nba.body,
        ctaLabel: nba.ctaLabel,
        ...(nba.prompt ? { ctaPrompt: nba.prompt } : {}),
        ...(nba.reason ? { reason: nba.reason } : {}),
        badge: "Next Best Action",
      }];
    },
  };
}

export function createOpsRunbookProvider(
  listIncidents: () => IncidentRecord[],
): RecommendationProvider {
  return {
    id: "ops_runbook",
    label: "IT Ops Runbook Recommender",
    description: "Recommends next steps for open and escalated incidents. P1 incidents get higher priority, and a pending rollback brings up the triage and rollback review.",
    domains: ["operations"],
    async evaluate() {
      const active = listIncidents().filter((inc) => inc.status === "open" || inc.status === "escalated");
      return active.map((inc, index): NormalizedRecommendation => ({
        id: `ops_inc:${inc.id}`,
        providerId: "ops_runbook",
        providerLabel: "IT Ops Runbook Recommender",
        kind: "action",
        priority: inc.severity === "P1" ? 1 + index : 20 + index,
        title: inc.rollbackStatus === "pending"
          ? `Approve rollback for ${inc.id} (${inc.currentRelease} → ${inc.previousRelease})`
          : `Triage ${inc.id}: ${inc.title}`,
        body: inc.summary,
        ctaLabel: inc.rollbackStatus === "pending" ? "Open triage & rollback" : "Inspect incident",
        ctaPrompt: `Build an IT incident triage dashboard for ${inc.id}`,
        reason: `${inc.severity} · ${inc.errorRatePct}% error rate (SLA ${inc.slaMinutes}m)`,
        badge: `IT Ops · ${inc.severity}`,
      }));
    },
  };
}

export function createSalesDealDeskProvider(
  listDeals: () => DealRecord[],
): RecommendationProvider {
  return {
    id: "sales_deal_desk",
    label: "Sales Deal Desk Recommender",
    description: "Recommends next steps for deals in negotiation or with a pending discount. Pending discounts get higher priority.",
    domains: ["sales"],
    async evaluate() {
      const deals = listDeals();
      return deals
        .filter((d) => d.discountStatus === "pending" || d.stage === "Negotiation")
        .map((deal, index): NormalizedRecommendation => ({
          id: `sales_deal:${deal.id}`,
          providerId: "sales_deal_desk",
          providerLabel: "Sales Deal Desk Recommender",
          kind: "action",
          priority: deal.discountStatus === "pending" ? 1 + index : 15 + index,
          title: deal.discountStatus === "pending"
            ? `Review ${deal.discountPct}% discount for ${deal.accountName} ($${(deal.arrUsd / 1000).toFixed(0)}k ARR)`
            : `Advance ${deal.accountName} (${deal.stage})`,
          body: deal.summary,
          ctaLabel: "Open Deal Desk",
          ctaPrompt: `Build a Q4 deal desk and discount approval dashboard for ${deal.id}`,
          reason: `${deal.stage} · ${deal.winProbabilityPct}% probability · Close ${deal.closeDate}`,
          badge: `RevOps · ${deal.id}`,
        }));
    },
  };
}

export class RecommendationArbitrator {
  constructor(private readonly providers: RecommendationProvider[]) {}

  descriptors(): RecommendationProviderDescriptor[] {
    return this.providers.map((p) => ({
      id: p.id,
      label: p.label,
      category: "recommendation_provider",
      description: p.description,
      domains: [...p.domains],
      sfieldToolRef: recommendationArbitrateToolRef,
      ...(p.toolRef ? { toolRef: p.toolRef } : {}),
    }));
  }

  async arbitrate(ctx: RecommendationProviderContext, signal: AbortSignal): Promise<RecommendationArbitrateResult> {
    const traces: ProviderExecutionTrace[] = [];
    const collected: NormalizedRecommendation[] = [];

    const settled = await Promise.all(
      this.providers.map(async (provider) => {
        if (!provider.domains.includes(ctx.domain)) {
          return {
            trace: {
              providerId: provider.id,
              providerLabel: provider.label,
              status: "skipped" as const,
              candidateCount: 0,
              elapsedMs: 0,
              note: `Domain "${ctx.domain}" outside provider scope (${provider.domains.join(", ")})`,
            },
            items: [] as NormalizedRecommendation[],
          };
        }
        const started = Date.now();
        try {
          const items = await provider.evaluate(ctx, signal);
          return {
            trace: {
              providerId: provider.id,
              providerLabel: provider.label,
              status: "ok" as const,
              candidateCount: items.length,
              elapsedMs: Math.max(0, Date.now() - started),
            },
            items,
          };
        } catch (err) {
          return {
            trace: {
              providerId: provider.id,
              providerLabel: provider.label,
              status: "error" as const,
              candidateCount: 0,
              elapsedMs: Math.max(0, Date.now() - started),
              note: err instanceof Error ? err.message.slice(0, 180) : "Provider evaluation failed",
            },
            items: [] as NormalizedRecommendation[],
          };
        }
      }),
    );

    const seenIds = new Set<string>();
    for (const entry of settled) {
      traces.push(entry.trace);
      for (const item of entry.items) {
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        collected.push(item);
      }
    }

    collected.sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));
    const topNba = collected.find((item) => item.kind === "nba") ?? collected[0];

    return {
      decisionId: makeId("rec_arb"),
      toolRef: recommendationArbitrateToolRef,
      providers: traces,
      recommendations: collected,
      ...(topNba ? { topNba } : {}),
    };
  }
}

/**
 * Domain-agnostic registry of optional RecommendationProviders.
 * A deployment may register zero, one, or many providers (e.g. Treatment Selector,
 * Customer 360 NBA, IT Ops Runbooks, Sales Deal Desk, or external REST/MCP services).
 * Core CEP routes never assume any specific provider (such as TS) is installed.
 */
export class RecommendationProviderRegistry {
  private readonly providers: RecommendationProvider[];

  constructor(providers: readonly RecommendationProvider[] = []) {
    this.providers = [...providers];
  }

  list(): RecommendationProvider[] {
    return [...this.providers];
  }

  get(id: string): RecommendationProvider | undefined {
    return this.providers.find((provider) => provider.id === id);
  }

  has(id: string): boolean {
    return this.providers.some((provider) => provider.id === id);
  }

  /**
   * Returns the first registered provider supporting rich eligibility selection
   * (optionally filtered by domain), or `undefined` if none is configured.
   */
  primaryEligibilityProvider(domain?: RecommendationProvider["domains"][number]): RecommendationProvider | undefined {
    return this.providers.find((provider) =>
      typeof provider.selectEligible === "function"
      && (!domain || provider.domains.includes(domain)),
    );
  }

  descriptors(): RecommendationProviderDescriptor[] {
    return new RecommendationArbitrator(this.providers).descriptors();
  }
}
