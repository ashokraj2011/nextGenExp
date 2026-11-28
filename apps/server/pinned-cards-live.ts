import { readDemoBalance } from "../../packages/experience/content";
import { buildSurface } from "../../packages/experience/compile";
import { findProfileById } from "../../packages/customer-profiles";
import type { PinnedLiveCard } from "../../packages/contracts/pinned-cards";
import type { DisplayBlock, DisplayExperience } from "../../packages/contracts/surface";
import { sfieldTools, toolVersion } from "../../packages/contracts/tool-setup";
import type { GoalProgressProvider } from "../../packages/goal-progress";
import type { PortfolioSnapshotProvider } from "../../packages/portfolio-snapshot";
import type { OpsIncidentStore } from "./ops-store";
import type { SalesDealStore } from "./sales-store";

const usdCompact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export interface LiveCardRefreshDeps {
  portfolioSnapshots: PortfolioSnapshotProvider;
  goalProgressProvider: GoalProgressProvider;
  opsStore?: OpsIncidentStore;
  salesStore?: SalesDealStore;
  now: () => number;
}

/** Infers the versioned sfield tool references backing a clipped DisplayExperience. */
export function inferPinnedCardToolRefs(experience: DisplayExperience, domainId: string): string[] {
  const refs = new Set<string>();
  for (const block of experience.blocks ?? []) {
    if (block.component === "PznPortfolioSnapshot") refs.add(`${sfieldTools.portfolio.id}@${toolVersion}`);
    if (block.component === "PznGoalProgress") refs.add(`${sfieldTools.goal.id}@${toolVersion}`);
    if (block.component === "PznMetricSummary") refs.add(`${sfieldTools.balances.id}@${toolVersion}`);
    if (block.component === "PznDynamicCanvas") {
      const text = `${block.props.dataSource ?? ""} ${block.props.badge ?? ""} ${block.props.title ?? ""}`.toLowerCase();
      if (domainId === "it_ops" || text.includes("incident") || text.includes("sre")) {
        refs.add("ops.incident.read@1.0.0");
      } else if (domainId === "sales_revops" || text.includes("deal") || text.includes("crm") || text.includes("pipeline")) {
        refs.add("sales.deal.read@1.0.0");
      } else if (text.includes("portfolio") || text.includes("holding") || text.includes("stock")) {
        refs.add(`${sfieldTools.portfolio.id}@${toolVersion}`);
      }
    }
  }
  return [...refs];
}

/**
 * Re-reads live data from sfield/smass domain providers and re-compiles the pinned card's
 * A2UI DisplayExperience in place so permanent cards in the user's Main Menu stay live.
 */
export async function refreshPinnedCardLive(
  card: PinnedLiveCard,
  deps: LiveCardRefreshDeps,
): Promise<PinnedLiveCard> {
  const now = deps.now();
  const profile = card.personaId ? findProfileById(card.personaId) : undefined;
  let updatedAny = false;
  const nextBlocks: DisplayBlock[] = [];

  for (const block of card.experience.blocks ?? []) {
    if (block.component === "PznPortfolioSnapshot" && profile) {
      const fresh = await deps.portfolioSnapshots.read(profile.syntheticMid).catch(() => null);
      if (fresh) {
        nextBlocks.push({ component: "PznPortfolioSnapshot", props: fresh });
        updatedAny = true;
        continue;
      }
    }

    if (block.component === "PznGoalProgress" && profile) {
      const fresh = await deps.goalProgressProvider.read(profile.syntheticMid).catch(() => null);
      if (fresh) {
        nextBlocks.push({
          component: "PznGoalProgress",
          props: { ...block.props, goal: fresh },
        });
        updatedAny = true;
        continue;
      }
    }

    if (block.component === "PznMetricSummary" && profile) {
      const fresh = readDemoBalance(profile.personaId, profile.syntheticMid, now);
      nextBlocks.push({
        component: "PznMetricSummary",
        props: {
          ...block.props,
          observedAt: fresh.observedAt,
          values: fresh.values,
        },
      });
      updatedAny = true;
      continue;
    }

    if (block.component === "PznDynamicCanvas") {
      if (card.domainId === "it_ops" && deps.opsStore) {
        const incident = (block.props.recordId && deps.opsStore.findById(block.props.recordId))
          || deps.opsStore.primaryIncident();
        if (incident) {
          const nextNodes = block.props.nodes.map((node) => {
            if (node.type !== "metrics") return node;
            return {
              ...node,
              items: node.items.map((item) => {
                const key = item.label.toLowerCase();
                if (key.includes("error")) return { ...item, value: `${incident.errorRatePct}%` };
                if (key.includes("latency") || key.includes("p95")) return { ...item, value: `${incident.p95LatencyMs} ms` };
                if (key.includes("rollback")) return { ...item, value: incident.rollbackStatus };
                if (key.includes("severity")) return { ...item, value: incident.severity };
                if (key.includes("status")) return { ...item, value: incident.status };
                return item;
              }),
            };
          });
          nextBlocks.push({
            component: "PznDynamicCanvas",
            props: { ...block.props, nodes: nextNodes },
          });
          updatedAny = true;
          continue;
        }
      }

      if (card.domainId === "sales_revops" && deps.salesStore) {
        const deal = (block.props.recordId && deps.salesStore.list().find((d) => d.id === block.props.recordId))
          || deps.salesStore.primaryDeal();
        if (deal) {
          const nextNodes = block.props.nodes.map((node) => {
            if (node.type !== "metrics") return node;
            return {
              ...node,
              items: node.items.map((item) => {
                const key = item.label.toLowerCase();
                if (key.includes("arr") || key.includes("deal value")) return { ...item, value: usdCompact.format(deal.arrUsd) };
                if (key.includes("discount") && key.includes("status")) return { ...item, value: deal.discountStatus };
                if (key.includes("discount")) return { ...item, value: `${deal.discountPct}%` };
                if (key.includes("prob") || key.includes("win")) return { ...item, value: `${deal.winProbabilityPct}%` };
                if (key.includes("stage")) return { ...item, value: deal.stage };
                return item;
              }),
            };
          });
          nextBlocks.push({
            component: "PznDynamicCanvas",
            props: { ...block.props, nodes: nextNodes },
          });
          updatedAny = true;
          continue;
        }
      }
    }

    nextBlocks.push(block);
  }

  const nextExperience = updatedAny
    ? buildSurface(
        {
          status: card.experience.status,
          outcome: card.experience.outcome,
          intro: card.experience.intro,
          question: card.experience.question,
          partial: card.experience.partial,
          expiresAt: Math.max(card.experience.expiresAt, now + 24 * 60 * 60 * 1000),
          layout: card.experience.layout,
        },
        nextBlocks,
        [],
        card.experience,
      ).display
    : card.experience;

  const toolRefs = card.toolRefs.length ? card.toolRefs : inferPinnedCardToolRefs(nextExperience, card.domainId);
  return {
    ...card,
    toolRefs,
    experience: nextExperience,
    refreshedAt: now,
    liveBacked: updatedAny || toolRefs.length > 0,
  };
}
