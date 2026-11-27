/**
 * Action-oriented Dynamic Canvas builders (HITL Approval Queue, External Connectors,
 * No-Code Action Flows, Stock Trading & Tax-Loss Harvesting, and Equity Holdings).
 * Extracted from `apps/server/dynamic-ui-generator.ts` for clean separation of concerns.
 */
import type { ActionFlow } from "../../../packages/contracts/action-flow";
import type { SemanticRouteDecision } from "../../../packages/contracts/capabilities-catalog";
import type { DynamicCanvasNode, DynamicCanvasProps } from "../../../packages/contracts/dynamic-canvas";
import type { ApprovalStore } from "../approval-store";
import type { ConnectorStore } from "../connector-store";
import { connectorInvokeToolRef, domainWriteToolRef } from "../runtime";
import { parseStockTradePrompt, type TradeStore } from "../trade-store";

export function buildApprovalQueueCanvas(approvalStore: ApprovalStore, prompt: string): { intro: string; canvas: DynamicCanvasProps } {
  const view = approvalStore.view();
  const pending = view.approvals.filter((a) => a.status === "pending");
  const decided = view.approvals.filter((a) => a.status !== "pending").slice(0, 6);
  const nodes: DynamicCanvasNode[] = [
    {
      type: "metrics",
      items: [
        { label: "Pending Approvals", value: String(view.pendingCount), delta: "Live sfield HITL queue" },
        { label: "Approval Mode", value: view.policy.defaultDualControl ? "4-Eyes Dual Control" : "Inline Chat Allowed", delta: "/admin/logs?source=approvals" },
        { label: "Total Logged", value: String(view.approvals.length), delta: "SHA-256 digest bound" },
      ],
    },
  ];
  if (pending.length === 0) {
    nodes.push({
      type: "callout",
      tone: "info",
      title: "Approval queue is clear",
      body: "No high-risk sfield writes or external connector calls are currently awaiting approval. Trigger an external connector (for example, \"invoke PagerDuty connector\") or enable 4-eyes dual control in /admin/logs?source=approvals to queue new approvals.",
    });
  } else {
    for (const item of pending.slice(0, 3)) {
      nodes.push({
        type: "approval",
        title: item.title,
        summary: item.summary,
        requester: item.requester,
        riskLevel: item.riskLevel,
        details: item.details,
        approveLabel: "Approve & execute",
        rejectLabel: "Deny request",
        recordId: item.recordId,
        domain: item.domain === "customer360" || item.domain === "pzn_self_service" || item.domain === "integration" ? "generic" : item.domain,
        approvalId: item.id,
        payloadDigest: item.payloadDigest,
        dualControl: item.dualControl,
        sfieldToolRef: item.sfieldToolRef,
        initialDecision: "pending",
      });
    }
  }
  if (decided.length > 0) {
    nodes.push({
      type: "table",
      caption: "Recent Approval Decisions",
      columns: ["Approval ID", "Target", "Status", "Approver"],
      rows: decided.map((a) => [
        a.id,
        `${a.domain}:${a.recordId}`,
        a.status,
        a.decidedBy ?? "—",
      ]),
    });
  }
  return {
    intro: pending.length > 0
      ? `There ${pending.length === 1 ? "is 1 pending high-risk action" : `are ${pending.length} pending high-risk actions`} awaiting human approval. You can approve or deny directly in Chat below or from /admin/logs?source=approvals.`
      : "Your live Human-in-the-Loop approval queue is currently clear.",
    canvas: {
      title: "Human-in-the-Loop Approval Queue",
      badge: "sfield HITL · Live Queue",
      subtitle: `${view.pendingCount} pending · Synchronized live with /admin/logs?source=approvals`,
      generatedBy: "synthesizer",
      dataSource: "approvals.json (sfield HITL)",
      prompt,
      nodes,
      disclaimer: "Approvals are cryptographically bound to the prepared SHA-256 payload digest and execute through governed sfield write tools with immutable Write Audit logging.",
      suggestedFollowUp: pending.length > 0 ? "Show pending approvals" : "Invoke PagerDuty connector for INC-4821",
    },
  };
}

export function buildConnectorActionCanvas(
  connectorStore: ConnectorStore,
  approvalStore: ApprovalStore,
  prompt: string,
  requesterName?: string,
): { intro: string; canvas: DynamicCanvasProps } {
  const connectors = connectorStore.list();
  const enabledAction = connectors.find((c) => c.enabled && (c.kind === "rest_action" || c.kind === "mcp_bridge"))
    ?? connectors.find((c) => c.enabled)
    ?? connectors[0];

  if (!enabledAction) {
    return {
      intro: "No external connectors are registered yet. Register a connector in /admin to invoke it via sfield.",
      canvas: {
        title: "External Connectors",
        badge: "Connector Registry",
        generatedBy: "synthesizer",
        prompt,
        nodes: [{ type: "callout", tone: "caution", title: "No connectors configured", body: "Open Tool setup (/admin) to register and enable an external REST or MCP connector." }],
        disclaimer: "External connectors run under sfield governance via cep.connector.invoke@1.0.0.",
      },
    };
  }

  const requester = requesterName || "CEP Operator";
  const action = /\bescalat/i.test(prompt) ? "escalate_incident" : /\brollback/i.test(prompt) ? "notify_rollback" : "trigger_incident_webhook";
  const approval = approvalStore.createPending({
    targetKind: "external_connector",
    sfieldToolRef: connectorInvokeToolRef,
    domain: "external_connector",
    recordId: enabledAction.id,
    action,
    title: `External Connector · ${enabledAction.name}`,
    summary: `Prepared governed sfield call (${connectorInvokeToolRef}) for "${action}" against ${enabledAction.method} ${enabledAction.url}.`,
    riskLevel: enabledAction.effect === "write" ? "high" : "medium",
    payload: { prompt, connectorId: enabledAction.id, action, triggeredFrom: "chat" },
    details: [
      { label: "Connector", value: enabledAction.name },
      { label: "Endpoint", value: `${enabledAction.method} ${enabledAction.url}` },
      { label: "Action", value: action },
      { label: "sfield Tool", value: connectorInvokeToolRef },
      { label: "4-Eyes Dual Control", value: (enabledAction.dualControl || approvalStore.getPolicy().defaultDualControl) ? "Required" : "Inline allowed" },
    ],
    requester,
    dualControl: enabledAction.dualControl || approvalStore.getPolicy().defaultDualControl,
  });

  return {
    intro: `Prepared an external connector call to **${enabledAction.name}** via \`${connectorInvokeToolRef}\`. Because this connector is gated by HITL approval policy, review and approve it right here in Chat or from \`/admin/logs?source=approvals\`.`,
    canvas: {
      title: `External Connector Execution · ${enabledAction.name}`.slice(0, 96),
      badge: "sfield Connector · HITL",
      subtitle: `${enabledAction.method} ${enabledAction.url} · Approval ID ${approval.id}`,
      generatedBy: "synthesizer",
      dataSource: "connectors.json + approvals.json",
      recordId: enabledAction.id,
      prompt,
      nodes: [
        {
          type: "approval",
          title: approval.title,
          summary: approval.summary,
          requester: approval.requester,
          riskLevel: approval.riskLevel,
          details: approval.details,
          approveLabel: "Approve & invoke",
          rejectLabel: "Deny invocation",
          recordId: approval.recordId,
          domain: "external_connector",
          approvalId: approval.id,
          payloadDigest: approval.payloadDigest,
          dualControl: approval.dualControl,
          sfieldToolRef: approval.sfieldToolRef,
          initialDecision: "pending",
        },
        {
          type: "table",
          caption: "Registered External Connectors",
          columns: ["Connector", "Kind", "Effect", "Status"],
          rows: connectors.slice(0, 6).map((c) => [
            c.name,
            c.kind,
            c.effect,
            c.enabled ? (c.requiresApproval ? "enabled (HITL)" : "enabled") : "disabled",
          ]),
        },
      ],
      disclaimer: "External connector calls execute through sfield cep.connector.invoke@1.0.0 with timeout enforcement, payload digest validation, and immutable Write Audit logging.",
      suggestedFollowUp: "Show pending approvals",
    },
  };
}

export function buildActionFlowCanvas(
  flow: ActionFlow,
  connectorStore: ConnectorStore | undefined,
  approvalStore: ApprovalStore | undefined,
  requesterName: string | undefined,
  prompt: string,
): { intro: string; canvas: DynamicCanvasProps } {
  const requester = requesterName || "CEP Operator";
  const conn = flow.connectorId ? connectorStore?.findById(flow.connectorId) : undefined;
  const action = flow.connectorAction || "trigger_action_flow";
  const dualControl = flow.approvalMode === "hitl_4eyes";
  const requiresApproval = flow.approvalMode !== "auto_execute";

  if (requiresApproval && approvalStore) {
    const approval = approvalStore.createPending({
      targetKind: flow.targetKind === "external_connector" && conn ? "external_connector" : "domain_write",
      sfieldToolRef: flow.targetKind === "external_connector" ? connectorInvokeToolRef : domainWriteToolRef,
      domain: flow.targetKind === "external_connector" ? "external_connector" : "customer360",
      recordId: conn?.id ?? flow.id,
      action,
      title: `No-Code Flow · ${flow.name}`,
      summary: `${flow.description} (Policy: ${dualControl ? "4-eyes separate approver" : "inline Chat approval"}).`,
      riskLevel: dualControl ? "high" : "medium",
      payload: { flowId: flow.id, prompt, action, connectorId: conn?.id },
      details: [
        { label: "Action Flow", value: flow.name },
        { label: "Domain", value: flow.domain },
        { label: "Bound Target", value: conn ? `${conn.name} (${conn.url})` : flow.targetKind },
        { label: "Action", value: action },
        { label: "Approval Policy", value: dualControl ? "4-Eyes Dual Control" : "Inline HITL Approval" },
      ],
      requester,
      dualControl,
    });
    return {
      intro: `Matched admin-authored No-Code Action Flow **${flow.name}**. Review the prepared SHA-256 digest and approve inline below or in \`/admin/logs?source=approvals\`.`,
      canvas: {
        title: `No-Code Flow · ${flow.name}`.slice(0, 96),
        badge: `Action Flow · ${flow.domain}`,
        subtitle: `Approval ${approval.id} · ${dualControl ? "4-eyes dual control" : "inline approval"}`,
        generatedBy: "synthesizer",
        dataSource: "action-flows.json + approvals.json",
        recordId: flow.id,
        prompt,
        nodes: [
          {
            type: "approval",
            title: approval.title,
            summary: approval.summary,
            requester: approval.requester,
            riskLevel: approval.riskLevel,
            details: approval.details,
            approveLabel: "Approve & run flow",
            rejectLabel: "Deny flow",
            recordId: approval.recordId,
            domain: approval.domain === "customer360" || approval.domain === "pzn_self_service" || approval.domain === "integration" ? "generic" : approval.domain,
            approvalId: approval.id,
            payloadDigest: approval.payloadDigest,
            dualControl: approval.dualControl,
            sfieldToolRef: approval.sfieldToolRef,
            initialDecision: "pending",
          },
        ],
        disclaimer: "Authored declaratively in /admin/intents (Action Flows) with zero code deploys. Governed by sfield and logged to Write Audit.",
        suggestedFollowUp: "Show pending approvals",
      },
    };
  }

  return {
    intro: `Matched No-Code Action Flow **${flow.name}** (${flow.description}).`,
    canvas: {
      title: flow.name,
      badge: `Action Flow · ${flow.domain}`,
      generatedBy: "synthesizer",
      dataSource: "action-flows.json",
      prompt,
      nodes: [
        {
          type: "callout",
          tone: "highlight",
          title: `Bound to ${conn?.name ?? flow.targetKind}`,
          body: `${flow.description} (Policy: ${flow.approvalMode}).`,
        },
      ],
      disclaimer: "Authored declaratively in /admin/intents (Action Flows).",
    },
  };
}

export function buildStockTradeCanvas(
  tradeStore: TradeStore,
  personaId: string,
  requesterName: string | undefined,
  prompt: string,
  extractedParams?: SemanticRouteDecision["extractedParams"],
  options?: {
    conversationId?: string;
    initialStage?: "configure" | "tax_analysis" | "running";
    initialJobId?: string;
    overrideShares?: number;
    overrideSymbol?: string;
    overrideSide?: "buy" | "sell";
  },
): { intro: string; canvas: DynamicCanvasProps } {
  const lexical = parseStockTradePrompt(prompt);
  const parsed = {
    side: options?.overrideSide ?? extractedParams?.side ?? lexical.side,
    symbol: (options?.overrideSymbol ?? (extractedParams?.symbol ? extractedParams.symbol.toUpperCase() : lexical.symbol)),
    percent: extractedParams?.percent ?? lexical.percent,
    shares: options?.overrideShares ?? extractedParams?.shares ?? lexical.shares,
  };
  const snapshot = tradeStore.snapshotFor(personaId);
  const target = snapshot.holdings.find((h) => h.symbol === parsed.symbol) ?? snapshot.holdings[0];
  const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const marketValueCents = target.shares * target.priceCents;
  const unrealizedCents = (target.priceCents - target.avgCostCents) * target.shares;
  const unrealizedSign = unrealizedCents >= 0 ? "+" : "-";
  const resolvedShares = parsed.shares
    ?? (parsed.percent && target.shares > 0 ? Math.max(1, Math.round((target.shares * parsed.percent) / 100)) : Math.max(1, Math.round(target.shares * 0.25)));
  const washSaleWarnings = tradeStore.washSaleWarningsFor(personaId, target.symbol, parsed.side);

  if (options?.conversationId && options.initialStage !== "running") {
    tradeStore.setDraft({
      conversationId: options.conversationId,
      personaId,
      actorName: requesterName || "Customer",
      side: parsed.side,
      symbol: target.symbol,
      shares: Math.min(Math.max(1, resolvedShares), parsed.side === "sell" ? Math.max(1, target.shares) : resolvedShares),
      ...(parsed.percent ? { percent: parsed.percent } : {}),
      stage: options.initialStage === "tax_analysis" ? "awaiting_execution" : "awaiting_tax_choice",
      ...(options.initialStage === "tax_analysis" && parsed.side === "sell" && target.shares > 0
        ? { taxAnalysis: tradeStore.analyzeTaxHarvest(personaId, target.symbol, Math.min(resolvedShares, target.shares)) }
        : {}),
      updatedAt: Date.now(),
    });
  }

  const intro = options?.initialStage === "running" && options.initialJobId
    ? `Launched timed execution job **\`${options.initialJobId}\`** for your **${parsed.side.toUpperCase()} ${resolvedShares} ${target.symbol}** order. Watch the live SSE countdown below — you can cancel before settlement or wait for your updated balance & portfolio receipt.`
    : options?.initialStage === "tax_analysis"
      ? `Completed **Tax-Loss Harvesting analysis** for selling **${resolvedShares} shares of ${target.symbol}**. Review the recommended offsetting loss trades below — click **Execute bundle** or reply **"execute bundle"** in Chat to launch the timed job.`
      : parsed.side === "sell"
        ? `You currently hold **${target.shares} shares of ${target.name} (${target.symbol})** (${usd(marketValueCents)} at ${usd(target.priceCents)}/sh, avg cost ${usd(target.avgCostCents)}, unrealized ${unrealizedSign}${usd(Math.abs(unrealizedCents))}). Confirm the quantity or percentage below — or reply **"yes"** in Chat to run Tax-Loss Harvesting analysis, **"change to 50%"**, or **"execute now"**.`
        : `Your available cash is **${usd(snapshot.cashCents)}** and you currently hold **${target.shares} shares of ${target.name} (${target.symbol})** at ${usd(target.priceCents)}/sh. Choose how many shares to buy below and launch the timed execution job.`;

  return {
    intro,
    canvas: {
      title: `${parsed.side === "sell" ? "Sell" : "Buy"} ${target.name} (${target.symbol}) — Trade & Tax-Harvest Simulator`,
      badge: parsed.side === "sell" ? "Trade + Tax Harvesting" : "Stock Order Simulator",
      subtitle: `Existing position: ${target.shares} shares · Live price ${usd(target.priceCents)} · Cash ${usd(snapshot.cashCents)}`,
      generatedBy: "synthesizer",
      dataSource: "trades-portfolio.json + Customer 360 (sfield)",
      recordId: target.symbol,
      prompt,
      nodes: [
        {
          type: "trade_ticket",
          personaId,
          actorName: requesterName || "Customer",
          side: parsed.side,
          symbol: target.symbol,
          companyName: target.name,
          existingShares: target.shares,
          avgCostCents: target.avgCostCents,
          priceCents: target.priceCents,
          holdingPeriod: target.holdingPeriod,
          cashBalanceCents: snapshot.cashCents,
          equityTotalCents: snapshot.equityCents,
          fixedIncomeCents: snapshot.fixedIncomeCents,
          ...(parsed.percent ? { suggestedPercent: parsed.percent } : {}),
          ...(parsed.shares ? { suggestedShares: parsed.shares } : {}),
          askTaxHarvest: parsed.side === "sell",
          ...(options?.initialStage ? { initialStage: options.initialStage } : {}),
          ...(options?.initialJobId ? { initialJobId: options.initialJobId } : {}),
          ...(washSaleWarnings.length > 0 ? { washSaleWarnings } : {}),
          holdings: snapshot.holdings.map((h) => ({
            symbol: h.symbol,
            name: h.name,
            shares: h.shares,
            avgCostCents: h.avgCostCents,
            priceCents: h.priceCents,
          })),
        },
      ],
      disclaimer: "Simulated trade execution runs as a durable SSE-streamed timed job with cancellation, 30-day wash-sale tracking, and sfield settlement into Customer 360.",
      suggestedFollowUp: "Show all my stocks",
    },
  };
}

export function buildStockHoldingsCanvas(
  tradeStore: TradeStore,
  personaId: string,
  prompt: string,
): { intro: string; canvas: DynamicCanvasProps } {
  const snapshot = tradeStore.snapshotFor(personaId);
  const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const activeHoldings = snapshot.holdings.filter((h) => h.shares > 0);
  const marketTotalCents = activeHoldings.reduce((sum, h) => sum + h.shares * h.priceCents, 0);
  const unrealizedTotalCents = activeHoldings.reduce((sum, h) => sum + (h.priceCents - h.avgCostCents) * h.shares, 0);
  const tlhCount = activeHoldings.filter((h) => h.priceCents < h.avgCostCents).length;
  const activeBars = activeHoldings
    .map((h) => ({
      label: `${h.symbol} (${h.shares} sh)`,
      value: Math.round((h.shares * h.priceCents) / 100),
      displayValue: usd(h.shares * h.priceCents),
      highlight: h.priceCents < h.avgCostCents,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  const nodes: DynamicCanvasNode[] = [
    {
      type: "metrics",
      items: [
        { label: "Active Positions", value: `${activeHoldings.length} stocks`, delta: `${tlhCount} tax-loss eligible` },
        { label: "Holdings Market Value", value: usd(marketTotalCents), delta: `${unrealizedTotalCents >= 0 ? "+" : ""}${usd(unrealizedTotalCents)} P/L` },
        { label: "Cash Balance", value: usd(snapshot.cashCents), delta: "Live Customer 360" },
        { label: "Total Portfolio", value: usd(snapshot.totalCents), delta: `Fixed income ${usd(snapshot.fixedIncomeCents)}` },
      ],
    },
    {
      type: "table",
      caption: "Live Stock Holdings & Cost Basis (trades-portfolio.json)",
      columns: ["Stock", "Shares", "Avg Cost → Price", "Market Value", "Unrealized P/L"],
      rows: snapshot.holdings.map((h) => {
        const mv = h.shares * h.priceCents;
        const pl = (h.priceCents - h.avgCostCents) * h.shares;
        const plText = h.shares === 0
          ? "Closed (0 sh)"
          : `${pl >= 0 ? "+" : ""}${usd(pl)}${pl < 0 ? " (TLH)" : ""}`;
        return [
          `${h.symbol} · ${h.name}`,
          `${h.shares} sh`,
          `${usd(h.avgCostCents)} → ${usd(h.priceCents)}`,
          usd(mv),
          plText,
        ];
      }),
    },
  ];

  if (activeBars.length >= 2) {
    nodes.push({
      type: "barchart",
      title: "Equity Allocation by Stock (highlighted = unrealized loss / TLH candidate)",
      unit: "usd",
      bars: activeBars,
    });
  }

  const recentBuys = tradeStore.recentlyBoughtSymbols(personaId);
  const recentBuyNote = recentBuys.size > 0
    ? ` Recent purchase${recentBuys.size === 1 ? "" : "s"} (${[...recentBuys].join(", ")}) are reflected above.`
    : "";

  return {
    intro: `Here are all **${activeHoldings.length} active stock positions** in your live portfolio (${usd(marketTotalCents)} total equity holdings, ${usd(snapshot.cashCents)} cash, ${tlhCount} tax-loss harvesting candidate${tlhCount === 1 ? "" : "s"}).${recentBuyNote}`,
    canvas: {
      title: "Live Stock Holdings & Tax-Lot Positions",
      badge: "Live Equity Holdings",
      subtitle: `${activeHoldings.length} active tickers · Cash ${usd(snapshot.cashCents)} · ${tlhCount} TLH candidate${tlhCount === 1 ? "" : "s"}`,
      generatedBy: "synthesizer",
      dataSource: "trades-portfolio.json + Customer 360",
      prompt,
      nodes,
      disclaimer: "Holdings reflect live simulated trades settled through sfield cep.domain.execute_write@1.0.0. Highlighted rows indicate unrealized losses eligible for Tax-Loss Harvesting.",
    },
  };
}
