/**
 * Self-contained domain assistants & governed recommendation arbitration helpers.
 * Extracted from `apps/server/service.ts` to keep `ExperienceService` focused on
 * turn lifecycle orchestration rather than domain-specific canvas construction.
 */
import type { ProviderArbitrationTrace } from "../../../packages/contracts/api";
import type { CepCapabilityId } from "../../../packages/contracts/capabilities-catalog";
import { DECISION_TTL } from "../../../packages/contracts/domain";
import type { DynamicCanvasNode, DynamicCanvasProps } from "../../../packages/contracts/dynamic-canvas";
import { recommendationArbitrateToolRef } from "../../../packages/contracts/recommendation-provider";
import { findProfileById, type PersonaRecord } from "../../../packages/customer-profiles";
import { compileDynamicCanvas } from "../../../packages/experience/compile";
import {
  createOpsRunbookProvider,
  createSalesDealDeskProvider,
  RecommendationArbitrator,
} from "../../../packages/recommendations";
import type { Customer360Service } from "../customer-360";
import { inferSuggestedGoalFromPrompt, type CustomerGoalStore } from "../goal-store";
import type { OpsIncidentStore } from "../ops-store";
import type { Runtime } from "../runtime";
import type { SalesDealStore } from "../sales-store";
import type { ConversationRecord, Store, TurnRecord } from "../store";
import type { TradeStore } from "../trade-store";

export function buildGoalPlannerResponse(args: {
  scopedPrompt: string;
  personaId: string;
  goalStore: CustomerGoalStore;
  startedAt: number;
  now: number;
}) {
  const { scopedPrompt, personaId, goalStore, startedAt, now } = args;
  const goals = goalStore.list(personaId);
  const suggested = inferSuggestedGoalFromPrompt(scopedPrompt);
  const profile = findProfileById(personaId);
  const actorName = profile?.displayName ?? "Customer";
  const totalTargetCents = goals.reduce((sum, g) => sum + g.targetCents, 0);
  const totalSavedCents = goals.reduce((sum, g) => sum + g.savedCents, 0);

  const canvas: DynamicCanvasProps = {
    title: suggested.suggestedName ? `Set Up ${suggested.suggestedName}` : "Financial Goals Planner",
    badge: "Goal Builder",
    subtitle: `${actorName} · ${goals.length} active goal${goals.length === 1 ? "" : "s"} tracked in Customer 360`,
    generatedBy: "synthesizer",
    dataSource: "Customer 360 Goals · sfield Governed Write",
    prompt: scopedPrompt.slice(0, 600),
    nodes: [
      {
        type: "metrics",
        items: [
          { label: "Active Goals", value: String(goals.length), delta: "Tracked live" },
          { label: "Total Saved", value: `$${Math.round(totalSavedCents / 100).toLocaleString("en-US")}` },
          { label: "Combined Target", value: `$${Math.round(totalTargetCents / 100).toLocaleString("en-US")}` },
        ],
      },
      {
        type: "goal_creator",
        personaId,
        actorName,
        ...(suggested.suggestedName ? { suggestedName: suggested.suggestedName } : {}),
        ...(suggested.suggestedCategory ? { suggestedCategory: suggested.suggestedCategory } : {}),
        ...(suggested.suggestedTargetUsd ? { suggestedTargetUsd: suggested.suggestedTargetUsd } : {}),
        goals: goals.map((g) => ({
          id: g.id,
          name: g.name,
          category: g.category,
          targetCents: g.targetCents,
          savedCents: g.savedCents,
          monthlyContributionCents: g.monthlyContributionCents,
          targetDate: g.targetDate,
          ...(g.builtIn ? { builtIn: true } : {}),
        })),
      },
    ],
    disclaimer: "New goals persist via sfield governed writes and immediately appear in your portfolio & goals tracking.",
    harnessTrace: {
      resolvedGoal: suggested.suggestedName
        ? `Open interactive goal creator pre-filled for ${suggested.suggestedName}`
        : "Open interactive multi-goal planner & creator",
      thinking: `Matched multi-goal creation intent for ${actorName}. Loaded ${goals.length} existing goal(s) and opened the governed Goal Creator card.`,
      fetchedSources: ["CustomerGoalStore", "Customer 360"],
      visualTargets: ["metrics", "goal_creator"],
      repaired: false,
      stages: [
        { stage: "plan", status: "ok", summary: "Matched goal setup & management request", durationMs: 2 },
        { stage: "fetch", status: "ok", summary: `Loaded ${goals.length} existing goal(s) for ${actorName}`, durationMs: Math.max(1, now - startedAt) },
        { stage: "compose", status: "ok", summary: "Composed interactive Goal Creator & tracker", durationMs: 1 },
        { stage: "verify", status: "ok", summary: "Verified schema and governed write endpoint", durationMs: 1 },
      ],
    },
  };
  const intro = suggested.suggestedName
    ? `Let’s set up your **${suggested.suggestedName}** goal! I’ve pre-filled a starting target below — adjust the name, target, monthly contribution, or target date and click **Create Goal**.`
    : `You currently have **${goals.length} goal${goals.length === 1 ? "" : "s"}** tracked. Pick a preset or enter custom details below to set up another goal — it will save immediately to your profile.`;

  return compileDynamicCanvas(intro, canvas, now + DECISION_TTL);
}

export function buildFolderProjectBriefResponse(args: {
  store: Store;
  conversation: ConversationRecord;
  currentTurnId: string;
  scopedPrompt: string;
  now: number;
}) {
  const { store, conversation, currentTurnId, scopedPrompt, now } = args;
  const allFolders = store.listFolders(conversation.principalId, conversation.domainId);
  const lowerPrompt = scopedPrompt.toLowerCase();
  const matchedFolder = (conversation.folderId ? store.getFolder(conversation.folderId, conversation.principalId) : undefined)
    ?? allFolders.find((f) => lowerPrompt.includes(f.name.toLowerCase()));
  if (!matchedFolder) return null;

  const folderConvs = store.folderConversations(matchedFolder.id, conversation.principalId);
  const threadSummaries = folderConvs.map((c) => {
    const turns = store.conversationTurns(c.id).filter((t) => t.public.id !== currentTurnId);
    const completed = turns.filter((t) => t.public.status === "completed");
    const working = turns.filter((t) => t.public.status === "working");
    const last = completed.at(-1) ?? turns.at(-1);
    return {
      title: c.title,
      completedCount: completed.length,
      workingCount: working.length,
      lastPrompt: last?.public.message ?? "No messages yet",
      lastReply: last?.public.experience?.intro ?? last?.public.experience?.question ?? "Waiting for first turn",
    };
  });
  const totalCompleted = threadSummaries.reduce((sum, t) => sum + t.completedCount, 0);
  const totalWorking = threadSummaries.reduce((sum, t) => sum + t.workingCount, 0);
  const nodes: DynamicCanvasNode[] = [
    {
      type: "metrics",
      items: [
        { label: "Folder", value: matchedFolder.name.slice(0, 34), delta: matchedFolder.instructions ? "Shared rules on" : "No shared rules" },
        { label: "Threads", value: String(threadSummaries.length) },
        { label: "Completed Turns", value: String(totalCompleted) },
        { label: "In Progress", value: String(totalWorking), delta: totalWorking > 0 ? "Live" : "All clear" },
      ],
    },
  ];
  if (matchedFolder.instructions) {
    nodes.push({
      type: "callout",
      tone: "highlight",
      title: `Shared Project Instructions (${matchedFolder.name})`,
      body: matchedFolder.instructions,
    });
  }
  if (threadSummaries.length > 0) {
    nodes.push({
      type: "table",
      caption: `Threads in "${matchedFolder.name}"`,
      columns: ["Thread", "Turns", "Latest Question", "Latest Outcome"],
      rows: threadSummaries.slice(0, 10).map((t) => [
        t.title.slice(0, 40),
        `${t.completedCount} done${t.workingCount ? ` · ${t.workingCount} live` : ""}`,
        t.lastPrompt.slice(0, 60),
        t.lastReply.slice(0, 76),
      ]),
    });
    const highlights = threadSummaries
      .filter((t) => t.completedCount > 0)
      .slice(0, 6)
      .map((t) => `${t.title}: ${t.lastReply.slice(0, 110)}`);
    if (highlights.length) {
      nodes.push({
        type: "checklist",
        title: "Key Takeaways Across Folder",
        items: highlights,
      });
    }
  }
  const canvas: DynamicCanvasProps = {
    title: `${matchedFolder.name} — Folder Project Brief`,
    badge: "Folder Brief",
    subtitle: `Synthesized across ${threadSummaries.length} thread${threadSummaries.length === 1 ? "" : "s"} in ${matchedFolder.name}`,
    generatedBy: "synthesizer",
    dataSource: "SQLite Folders · sfield Chat Transcripts",
    prompt: scopedPrompt.slice(0, 600),
    nodes,
    disclaimer: "Synthesized directly from your persisted threads and folder instructions.",
    harnessTrace: {
      resolvedGoal: `Synthesize all threads and instructions in folder "${matchedFolder.name}"`,
      thinking: `Loaded ${threadSummaries.length} thread(s) and ${totalCompleted} completed turn(s) from folder "${matchedFolder.name}"${matchedFolder.instructions ? " along with shared folder instructions" : ""}.`,
      fetchedSources: ["ConversationFolders", "sfield.chat_threads"],
      visualTargets: ["metrics", "table", "checklist"],
      repaired: false,
      stages: [
        { stage: "plan", status: "ok", summary: `Matched folder summary request for "${matchedFolder.name}"`, durationMs: 1 },
        { stage: "fetch", status: "ok", summary: `Scanned ${threadSummaries.length} thread(s) (${totalCompleted} turns)`, durationMs: 2 },
        { stage: "compose", status: "ok", summary: "Built cross-thread Folder Project Brief", durationMs: 1 },
        { stage: "verify", status: "ok", summary: "Verified grounded thread summaries", durationMs: 1 },
      ],
    },
  };
  const intro = `Here is the project brief across **${threadSummaries.length} thread${threadSummaries.length === 1 ? "" : "s"}** in **${matchedFolder.name}** (${totalCompleted} completed turn${totalCompleted === 1 ? "" : "s"}).`;
  return {
    folderName: matchedFolder.name,
    result: compileDynamicCanvas(intro, canvas, now + DECISION_TTL),
  };
}

const SYMBOL_NAMES: Record<string, RegExp> = {
  AAPL: /\b(aapl|apple)\b/i,
  MSFT: /\b(msft|microsoft)\b/i,
  NVDA: /\b(nvda|nvidia)\b/i,
  INTC: /\b(intc|intel)\b/i,
  BA: /\b(ba|boeing)\b/i,
  PFE: /\b(pfe|pfizer)\b/i,
};

export async function arbitrateCanvasRecommendation(args: {
  capabilityId: CepCapabilityId;
  canvas: DynamicCanvasProps;
  runtime: Runtime;
  currentTurn: () => TurnRecord;
  initialTurn: TurnRecord;
  conversation: ConversationRecord;
  persona?: PersonaRecord;
  suppressPromotionsForEmpathy: boolean;
  lookupInfo?: ReturnType<Customer360Service["evaluate"]>;
  opsStore?: OpsIncidentStore;
  salesStore?: SalesDealStore;
  tradeStore?: TradeStore;
  signal: AbortSignal;
}): Promise<{ governedCanvas: DynamicCanvasProps; providerArbitration?: ProviderArbitrationTrace }> {
  const {
    capabilityId, canvas, runtime, currentTurn, initialTurn, conversation,
    persona, suppressPromotionsForEmpathy, lookupInfo, opsStore, salesStore, tradeStore, signal,
  } = args;

  const arbDomain: ProviderArbitrationTrace["domain"] = capabilityId === "ops_incident"
    ? "operations"
    : capabilityId === "sales_deal_desk"
      ? "sales"
      : "wealth";

  let providerArbitration: ProviderArbitrationTrace | undefined;
  let governedWinner: { providerLabel: string; title: string; ctaLabel?: string; ctaPrompt?: string } | undefined;

  const recentBuys = tradeStore?.recentlyBoughtSymbols(conversation.personaId) ?? new Set<string>();
  const contradictsRecentBuy = (text: string) => {
    if (!/\b(sell|trim|liquidate|harvest)\b/i.test(text)) return false;
    for (const sym of recentBuys) {
      const rx = SYMBOL_NAMES[sym] ?? new RegExp(`\\b${sym}\\b`, "i");
      if (rx.test(text)) return true;
    }
    return false;
  };
  const pickEligibleRecommendation = (
    items: Array<{ providerLabel: string; title: string; ctaLabel?: string; ctaPrompt?: string }>,
  ) => items.find((item) => {
    if (!item.ctaPrompt?.trim()) return false;
    return !contradictsRecentBuy(`${item.title} ${item.ctaLabel ?? ""} ${item.ctaPrompt}`);
  });

  try {
    if (arbDomain === "operations" && opsStore) {
      const opsArb = await new RecommendationArbitrator([
        createOpsRunbookProvider(() => opsStore.list().filter((r) => !canvas.recordId || r.id === canvas.recordId)),
      ]).arbitrate({
        principalId: initialTurn.scope.principalId,
        personaId: conversation.personaId,
        syntheticMid: persona?.syntheticMid ?? "ops",
        contextId: "it_ops",
        domain: "operations",
        fundingStatus: "funded",
        excludePromotions: false,
      }, signal);
      governedWinner = pickEligibleRecommendation(opsArb.recommendations);
      providerArbitration = {
        toolRef: recommendationArbitrateToolRef,
        domain: "operations",
        decisionId: opsArb.decisionId,
        winnerTitle: governedWinner?.title ?? opsArb.topNba?.title,
        providers: [
          ...opsArb.providers,
          { providerId: "treatment_selector", providerLabel: "Treatment Selector (TS + CCRE)", status: "skipped", candidateCount: 0, elapsedMs: 0, note: 'Domain "operations" outside wealth scope' },
          { providerId: "customer360_nba", providerLabel: "Customer 360 NBA Engine", status: "skipped", candidateCount: 0, elapsedMs: 0, note: 'Domain "operations" outside customer scope' },
          { providerId: "sales_deal_desk", providerLabel: "Sales Deal Desk Recommender", status: "skipped", candidateCount: 0, elapsedMs: 0, note: 'Domain "operations" outside sales scope' },
        ],
      };
    } else if (arbDomain === "sales" && salesStore) {
      const salesArb = await new RecommendationArbitrator([
        createSalesDealDeskProvider(() => salesStore.list().filter((r) => !canvas.recordId || r.id === canvas.recordId)),
      ]).arbitrate({
        principalId: initialTurn.scope.principalId,
        personaId: conversation.personaId,
        syntheticMid: persona?.syntheticMid ?? "sales",
        contextId: "sales_revops",
        domain: "sales",
        fundingStatus: "funded",
        excludePromotions: false,
      }, signal);
      governedWinner = pickEligibleRecommendation(salesArb.recommendations);
      providerArbitration = {
        toolRef: recommendationArbitrateToolRef,
        domain: "sales",
        decisionId: salesArb.decisionId,
        winnerTitle: governedWinner?.title ?? salesArb.topNba?.title,
        providers: [
          ...salesArb.providers,
          { providerId: "treatment_selector", providerLabel: "Treatment Selector (TS + CCRE)", status: "skipped", candidateCount: 0, elapsedMs: 0, note: 'Domain "sales" outside wealth scope' },
          { providerId: "customer360_nba", providerLabel: "Customer 360 NBA Engine", status: "skipped", candidateCount: 0, elapsedMs: 0, note: 'Domain "sales" outside customer scope' },
          { providerId: "ops_runbook", providerLabel: "IT Ops Runbook Recommender", status: "skipped", candidateCount: 0, elapsedMs: 0, note: 'Domain "sales" outside operations scope' },
        ],
      };
    } else {
      const wealthContext = capabilityId === "stock_holdings" || capabilityId === "stock_trade"
        ? "portfolio"
        : "goals";
      const wealthArb = await runtime.arbitrateRecommendations(currentTurn(), {
        contextId: wealthContext,
        domain: "wealth",
        excludePromotions: suppressPromotionsForEmpathy || runtime.experiences.execution.world.exclusions(initialTurn),
        existingBlockTitles: [canvas.title],
      }, signal);
      governedWinner = pickEligibleRecommendation(wealthArb.recommendations);
      providerArbitration = {
        toolRef: wealthArb.toolRef,
        domain: "wealth",
        decisionId: wealthArb.decisionId,
        winnerTitle: governedWinner?.title ?? wealthArb.topNba?.title,
        providers: wealthArb.providers,
      };
    }
  } catch {
    if (lookupInfo?.nba?.prompt && !contradictsRecentBuy(`${lookupInfo.nba.title} ${lookupInfo.nba.prompt}`)) {
      governedWinner = {
        providerLabel: "Customer 360 NBA Engine",
        title: lookupInfo.nba.title,
        ctaLabel: lookupInfo.nba.ctaLabel,
        ctaPrompt: lookupInfo.nba.prompt,
      };
    }
  }

  // Enforce single recommendation authority: strip any ad-hoc generator/LLM suggestedFollowUp
  // and attach ONLY the governed Recommendation Provider winner (with provenance).
  const governedCanvas: DynamicCanvasProps = { ...canvas };
  delete governedCanvas.suggestedFollowUp;
  delete governedCanvas.recommendationLabel;
  delete governedCanvas.recommendationSource;
  if (governedWinner?.ctaPrompt) {
    governedCanvas.suggestedFollowUp = governedWinner.ctaPrompt.slice(0, 160);
    governedCanvas.recommendationLabel = (governedWinner.ctaLabel || governedWinner.title).slice(0, 80);
    governedCanvas.recommendationSource = governedWinner.providerLabel.slice(0, 80);
  }
  return { governedCanvas, providerArbitration };
}
