import { z } from "zod";
import { domainPackIds, type DomainPackId } from "../../packages/contracts/domain-packs";
import type { DynamicCanvasNode, DynamicCanvasProps } from "../../packages/contracts/dynamic-canvas";
import { formatPortfolioAmount } from "../../packages/contracts/portfolio";
import type { WidgetDraft } from "../../packages/contracts/widget";
import { findProfileById } from "../../packages/customer-profiles";
import { compileDynamicCanvas, type CompiledExperience } from "../../packages/experience/compile";
import type { GoalProgressProvider } from "../../packages/goal-progress";
import type { PortfolioSnapshotProvider } from "../../packages/portfolio-snapshot";
import { generateWidgetFromMultimodal } from "./dynamic-ui-generator";
import type { GatewaySettings } from "./gateway";
import type { OpsIncidentStore } from "./ops-store";
import type { SalesDealStore } from "./sales-store";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const sketchToUiRequestSchema = z.object({
  conversationId: z.string().trim().min(1).max(120).optional(),
  domainId: z.enum(domainPackIds).default("wealth"),
  personaId: z.string().trim().min(1).max(80).optional(),
  prompt: z.string().trim().max(600).optional(),
  imageDataUrl: z.string().regex(/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/).max(5_000_000),
  imageName: z.string().trim().max(120).optional(),
}).strict();

export type SketchToUiRequest = z.infer<typeof sketchToUiRequestSchema>;

export interface SketchToUiDeps {
  gateway: GatewaySettings | null;
  dataDir: string;
  portfolioSnapshots: PortfolioSnapshotProvider;
  goalProgressProvider: GoalProgressProvider;
  opsStore?: OpsIncidentStore;
  salesStore?: SalesDealStore;
  now: () => number;
}

export async function runSketchToUi(
  input: SketchToUiRequest,
  deps: SketchToUiDeps,
): Promise<{
  widget: WidgetDraft;
  source: "copilot_vision" | "figma_api" | "copilot_llm" | "synthesizer";
  sourceSummary: string;
  compiled: CompiledExperience;
}> {
  const domainPromptPrefix =
    input.domainId === "it_ops"
      ? "IT Operations & SRE incident dashboard"
      : input.domainId === "sales_revops"
        ? "Sales Revenue Operations Q4 deal desk & pipeline dashboard"
        : "Wealth Advisory portfolio & financial goal dashboard";

  const generated = await generateWidgetFromMultimodal(
    {
      prompt: input.prompt?.trim()
        ? `${input.prompt.trim()} (${domainPromptPrefix})`
        : `Convert this uploaded sketch or picture into an interactive ${domainPromptPrefix}`,
      imageDataUrl: input.imageDataUrl,
      imageName: input.imageName || "sketch.png",
    },
    deps.gateway,
    deps.dataDir,
  );

  const widget = generated.widget;
  const nodes: DynamicCanvasNode[] = [];
  let dataSource = "Sketch-to-UI · Live sfield grounding";

  // Ground KPI metrics directly from live sfield / smass domain sources!
  const liveMetrics: Array<{ label: string; value: string; delta?: string }> = [];
  if (input.domainId === "wealth") {
    const profile = input.personaId ? findProfileById(input.personaId) : undefined;
    if (profile) {
      const [portfolio, goal] = await Promise.all([
        deps.portfolioSnapshots.read(profile.syntheticMid).catch(() => null),
        deps.goalProgressProvider.read(profile.syntheticMid).catch(() => null),
      ]);
      if (portfolio) {
        const total = portfolio.cashCents + portfolio.equityCents + portfolio.fixedIncomeCents;
        liveMetrics.push(
          { label: "Total Portfolio", value: formatPortfolioAmount(total), delta: "Live sfield" },
          { label: "Invested Equities", value: formatPortfolioAmount(portfolio.equityCents) },
          { label: "Cash Available", value: formatPortfolioAmount(portfolio.cashCents) },
        );
        dataSource = "Customer 360 + portfolio.snapshot.read@1.0.0";
      }
      if (goal) {
        const saved = goal.history.at(-1)?.savedCents ?? 0;
        const pct = Math.min(100, Math.round((saved / Math.max(goal.targetCents, 1)) * 100));
        liveMetrics.push({ label: "Home Goal Progress", value: `${pct}%`, delta: formatPortfolioAmount(saved) });
        if (!widget.goal) {
          nodes.push({
            type: "progress",
            label: "Home Down-Payment Goal",
            current: Math.round(saved / 100),
            target: Math.round(goal.targetCents / 100),
            currentDisplay: formatPortfolioAmount(saved),
            targetDisplay: formatPortfolioAmount(goal.targetCents),
          });
        }
      }
    }
  } else if (input.domainId === "it_ops" && deps.opsStore) {
    const inc = deps.opsStore.primaryIncident();
    if (inc) {
      liveMetrics.push(
        { label: "Active Incident", value: inc.id, delta: inc.severity },
        { label: "Service", value: inc.service },
        { label: "Error Rate", value: `${inc.errorRatePct}%` },
        { label: "p95 Latency", value: `${inc.p95LatencyMs} ms` },
      );
      dataSource = "Live Incident Store · ops.incident.read@1.0.0";
    }
  } else if (input.domainId === "sales_revops" && deps.salesStore) {
    const deal = deps.salesStore.primaryDeal();
    if (deal) {
      liveMetrics.push(
        { label: "Primary Deal ARR", value: usd.format(deal.arrUsd), delta: deal.id },
        { label: "Account", value: deal.accountName },
        { label: "Requested Discount", value: `${deal.discountPct}%` },
        { label: "Win Probability", value: `${deal.winProbabilityPct}%` },
      );
      dataSource = "Live CRM Deal Store · sales.deal.read@1.0.0";
    }
  }

  // Merge live verified metrics first, then any additional sketched metrics
  const combinedMetrics = [
    ...liveMetrics,
    ...(widget.metrics ?? []).filter(
      (m) => !liveMetrics.some((live) => live.label.toLowerCase() === m.label.toLowerCase()),
    ),
  ].slice(0, 6);

  if (combinedMetrics.length > 0) {
    nodes.unshift({ type: "metrics", items: combinedMetrics });
  }

  if (widget.goal) {
    nodes.push({
      type: "progress",
      label: widget.goal.unitLabel || widget.title,
      current: widget.goal.saved,
      target: widget.goal.target,
      currentDisplay: usd.format(widget.goal.saved),
      targetDisplay: usd.format(widget.goal.target),
    });
  }

  if (widget.sliders?.length) {
    const validIds = ["amount", "monthly", "rate", "years"] as const;
    const normalizedSliders = widget.sliders.map((s, idx) => {
      const id = (validIds as readonly string[]).includes(s.id)
        ? (s.id as typeof validIds[number])
        : validIds[idx % validIds.length];
      const unit: "usd" | "percent" | "years" = s.unit === "months" ? "years" : s.unit;
      return { ...s, id, unit };
    });
    nodes.push({
      type: "sliders",
      title: "Interactive What-If Controls",
      formula: "compound_monthly",
      resultLabel: "Projected Outcome",
      inputs: normalizedSliders,
    });
  }

  if (widget.columns?.length) {
    nodes.push({
      type: "comparison",
      columns: widget.columns,
    });
  }

  if (widget.steps?.length) {
    nodes.push({
      type: "checklist",
      title: "Action Checklist",
      items: widget.steps,
    });
  }

  if (widget.body?.trim()) {
    nodes.push({
      type: "callout",
      tone: "info",
      title: generated.source === "copilot_vision" ? "Interpreted from your picture via Vision" : "Generated from your sketch",
      body: widget.body,
    });
  }

  const canvas: DynamicCanvasProps = {
    badge: widget.badge || "Sketch-to-UI",
    title: widget.title || "Custom Sketched Dashboard",
    subtitle: generated.sourceSummary,
    generatedBy: generated.source === "synthesizer" ? "synthesizer" : "llm",
    dataSource,
    nodes,
    disclaimer: "Layout generated from your sketch/picture and hydrated with live sfield-verified domain data. Click Pin to Menu to keep it permanently.",
  };

  const intro = `I turned your ${input.imageName ? `**${input.imageName}**` : "drawing"} into a live **${canvas.title}** dashboard grounded in verified data. Click **Pin to Menu** to keep it permanently in your sidebar!`;
  const compiled = compileDynamicCanvas(intro, canvas, deps.now() + 24 * 60 * 60 * 1000);

  return {
    widget,
    source: generated.source,
    sourceSummary: generated.sourceSummary,
    compiled,
  };
}
