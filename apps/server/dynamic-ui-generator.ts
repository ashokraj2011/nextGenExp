import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { dynamicCanvasSchema, type DynamicCanvasNode, type DynamicCanvasProps } from "../../packages/contracts/dynamic-canvas";
import { widgetDraftSchema, type WidgetDraft } from "../../packages/contracts/widget";
import { runCopilotPrompt } from "./copilot-acp-client";
import type { GatewaySettings } from "./gateway";
import type { OpsIncidentStore } from "./ops-store";
import type { SalesDealStore } from "./sales-store";
import type { SemanticRouteDecision } from "../../packages/contracts/capabilities-catalog";
import type { ActionFlow } from "../../packages/contracts/action-flow";
import type { TradeDraftState, TradeLegInput } from "../../packages/contracts/trading";
import type { ConnectorStore } from "./connector-store";
import type { ApprovalStore } from "./approval-store";
import type { ActionFlowStore } from "./action-flow-store";
import { parseStockTradePrompt, type SettlementCallback, type TradeStore } from "./trade-store";
import { connectorInvokeToolRef, domainWriteToolRef } from "./runtime";
import { generateWidgetFromText } from "./widget-library";

const dynamicUiTrigger = /\b(widget|table|bar chart|chart|graph|dashboard|visuali[sz]e|visuali[sz]ation|calculator|simulator|matrix|breakdown|dynamic ui|custom ui|interactive|approval\s+(?:card|flow|form|workflow|request|queue)|pending\s+approvals?|show\s+(?:my\s+)?approvals?|review\s+approvals?|hitl\s+queue|pagerduty|external\s+connector|invoke\s+connector|run\s+connector|trigger\s+webhook|timeline|roadmap|triage|incident\s+(?:triage|dashboard|timeline|queue|status|report|response)|rollback|deal\s+desk|sales\s+pipeline|discount\s+approval|close[- ]plan|intake\s+form|(?:sell|buy|purchase|trim|trade)\b.*\b(?:shares?|stocks?|aapl|apple|msft|microsoft|nvda|nvidia|intc|intel|boeing|pfizer|voo)\b|tax[- ]?loss\s+harvest(?:ing)?|(?:show|list|view|all|what|see)\b.*\b(?:my\s+)?(?:stocks?|holdings?|shares?|positions?|equities)\b|\bmy\s+(?:stocks?|holdings?|shares?|positions?)\b|stock\s+(?:holdings?|positions?|list)|build\s+(?:me\s+)?a\b|design\s+(?:me\s+)?a\b|generate\s+(?:me\s+)?a\b|create\s+a\s+.*(?:ui|card|view|table|chart|calculator|tracker|breakdown|form|board|dashboard|timeline|approval|checklist|workflow)|make\s+a\s+.*(?:ui|card|view|table|chart|calculator|tracker|breakdown|form|board|dashboard|timeline|approval|checklist))\b/i;
const nonDynamicGuard = /\b(weather|stock price|tomorrow|create a? ?rule)\b/i;
const opsIncidentTrigger = /\b(incident|triage|rollback|sre|sev\s*[0-3]|p[1-3]\b|latency|5xx|error rate|it ops|operations dashboard|post-incident|production alert|inc-\d+)\b/i;
const salesDealTrigger = /\b(deal\s*desk|deal-\d+|sales\s*pipeline|pipeline\s*(?:breakdown|chart|table|forecast)|revops|discount\s*approval|pricing\s*exception|mutual\s*action\s*plan|close[- ]plan|acme\s*cloud|enterprise\s*renewal)\b/i;
const approvalQueueTrigger = /\b(pending\s+approvals?|approval\s+queue|show\s+(?:my\s+)?approvals?|review\s+approvals?|hitl\s+queue)\b/i;
const connectorActionTrigger = /\b(pagerduty|external\s+connector|invoke\s+connector|run\s+connector|trigger\s+webhook|servicenow\s+webhook)\b/i;
const stockTradeTrigger = /\b((?:sell|buy|purchase|trim|trade|simulate\s+(?:a\s+)?(?:sell|buy|trade))\b.*\b(?:shares?|stocks?|aapl|apple|msft|microsoft|nvda|nvidia|intc|intel|boeing|pfizer|voo)\b|tax[- ]?loss\s+harvest(?:ing)?)\b/i;
const stockHoldingsTrigger = /\b((?:show|list|view|see|all|what)\b.*\b(?:my\s+)?(?:stocks?|holdings?|shares?|positions?)\b|my\s+(?:stocks?|holdings?|shares?|positions?)|stock\s+(?:holdings?|positions?|list))\b/i;

export function isDynamicUiRequest(message: string): boolean {
  const clean = message.trim();
  if (clean.length < 8 || nonDynamicGuard.test(clean)) return false;
  return dynamicUiTrigger.test(clean);
}

export function isOpsIncidentPrompt(message: string): boolean {
  return opsIncidentTrigger.test(message);
}

export function isSalesDealPrompt(message: string): boolean {
  return salesDealTrigger.test(message);
}

export function isApprovalQueuePrompt(message: string): boolean {
  return approvalQueueTrigger.test(message);
}

export function isConnectorActionPrompt(message: string): boolean {
  return connectorActionTrigger.test(message);
}

export function isStockTradePrompt(message: string): boolean {
  return stockTradeTrigger.test(message);
}

export function isStockHoldingsPrompt(message: string): boolean {
  return stockHoldingsTrigger.test(message);
}

function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/i);
  if (fenced) return fenced[1].trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

async function callConfiguredLlmJson(
  gateway: GatewaySettings,
  dataDir: string,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
): Promise<unknown | null> {
  if (gateway.profile === "copilot_acp") {
    const cliHome = resolve(dataDir, "copilot-cli");
    mkdirSync(cliHome, { recursive: true, mode: 0o700 });
    const fullText = `${systemPrompt}\n\nUSER REQUEST:\n${userPrompt}\n\nReturn ONLY one valid JSON object matching the schema. No markdown fences, no commentary.`;
    const reply = await runCopilotPrompt(gateway, cliHome, [{ type: "text", text: fullText }], signal, () => undefined);
    return JSON.parse(stripJsonFences(reply.text));
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(gateway.apiKey ? { Authorization: `Bearer ${gateway.apiKey}` } : {}),
    ...(gateway.headers ?? {}),
  };
  const response = await fetch(`${gateway.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      ...(gateway.bodyFields ?? {}),
      model: gateway.model,
      max_tokens: Math.min(gateway.maxOutputTokens, 1400),
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!response.ok) return null;
  const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
  const text = payload.choices?.[0]?.message?.content;
  if (!text) return null;
  return JSON.parse(stripJsonFences(text));
}

const canvasSystemPrompt = [
  "You are CEP (Customer Engagement Platform) Multi-Domain Dynamic UI Composer.",
  "Compose a rich, original, schema-valid interactive UI component tree tailored to ANY domain the user requests (Wealth, IT Operations / Incident Triage, Sales / RevOps, HR / Onboarding, Release Readiness, Supply Chain, Support Desk, Healthcare, etc.).",
  "Only use customer financial context if the request is about finance or wealth. For non-financial domains (IT Ops, HR, Sales, Product, Ops), tailor 100% of labels, badges, data, disclaimer, and follow-ups to the requested domain.",
  "IMPORTANT: When LIVE DOMAIN DATA is included in the user request, you MUST ground all KPI metrics, table rows, timeline events, and approval details strictly in those exact live values — do NOT fabricate conflicting numbers. Mention the live data source in the disclaimer.",
  "When no live domain data is provided, use realistic illustrative data and clearly note that in disclaimer.",
  "Return ONE JSON object with this exact shape:",
  JSON.stringify({
    intro: "1-2 sentence concise introduction explaining what this custom UI shows.",
    canvas: {
      title: "Short clear card headline (max 90 chars)",
      badge: "Short category badge like 'IT Operations', 'Deal Review', 'Approval Flow', or 'Interactive Form' (max 36 chars)",
      subtitle: "Optional concise subtitle",
      generatedBy: "llm",
      nodes: [
        "1 to 5 composable nodes from these exact 11 types:",
        "{ type: 'metrics', items: [{ label, value, delta? }] }",
        "{ type: 'table', caption?, columns: [2..5 strings], rows: [[2..5 strings]] }",
        "{ type: 'barchart', title?, unit?: 'usd'|'percent'|'number', bars: [{ label, value: number, displayValue, highlight?: boolean }] }",
        "{ type: 'progress', label, current: number, target: number, currentDisplay, targetDisplay }",
        "{ type: 'sliders', title?, formula: 'compound_monthly'|'annual_yield'|'simple_total', resultLabel, inputs: [{ id: 'amount'|'monthly'|'rate'|'years', label, min, max, step, value, unit: 'usd'|'percent'|'years' }] }",
        "{ type: 'comparison', columns: [{ title, points: [strings] }, { title, points: [strings] }] }",
        "{ type: 'checklist', title?, items: [strings] }",
        "{ type: 'callout', tone: 'info'|'highlight'|'caution', title?, body }",
        "{ type: 'form', title?, submitLabel, fields: [{ id, label, type: 'text'|'number'|'currency'|'select'|'date'|'checkbox', placeholder?, required?, options?: [strings], defaultValue? }] }",
        "{ type: 'approval', title, summary, requester?, riskLevel?: 'low'|'medium'|'high', details: [{ label, value }], approveLabel, rejectLabel }",
        "{ type: 'timeline', title?, events: [{ time, title, detail?, owner?, status: 'done'|'active'|'pending'|'blocked' }] }",
      ],
      disclaimer: "Illustrative interactive workspace generated dynamically for review.",
      suggestedFollowUp: "Optional short follow-up prompt matching the requested domain",
    },
  }),
].join("\n");

export function synthesizeDynamicCanvas(
  prompt: string,
  profileSummary?: string,
  opsStore?: OpsIncidentStore,
  salesStore?: SalesDealStore,
): { intro: string; canvas: DynamicCanvasProps } {
  const widget = generateWidgetFromText(prompt);
  const lower = prompt.toLowerCase();
  const nodes: DynamicCanvasNode[] = [];
  let customBadge: string | undefined;
  let customFollowUp = "Show my portfolio summary";
  let dataSource: string | undefined;
  let recordId: string | undefined;
  let customTitle: string | undefined;
  let customSubtitle: string | undefined;
  let customDisclaimer: string | undefined;

  if (opsStore && isOpsIncidentPrompt(prompt)) {
    const view = opsStore.view();
    const primary = opsStore.primaryIncident();
    const statusLabel = primary.status.replace("_", " ").toUpperCase();
    dataSource = view.summary.sourceLabel;
    recordId = primary.id;
    customBadge = `IT Operations · ${primary.id}`;
    customTitle = `${primary.id}: ${primary.title}`.slice(0, 96);
    customSubtitle = `${primary.service} · ${primary.environment} · Status: ${statusLabel}`;
    customDisclaimer = `Live operational telemetry grounded in ${view.summary.sourceLabel}. Actions persist directly to the incident store.`;
    customFollowUp = primary.rollbackStatus === "pending"
      ? "Show the incident timeline and active incident queue"
      : "Refresh the IT incident triage dashboard with live status";

    const isTimelineFocus = /\b(timeline|post-incident|root-cause|history)\b/.test(lower);
    nodes.push({
      type: "metrics",
      items: [
        { label: "Severity & Status", value: `${primary.severity} · ${statusLabel}`, delta: `SLA ${primary.slaMinutes}m` },
        { label: "Error Rate", value: `${primary.errorRatePct}%`, delta: `Baseline ${primary.baselineErrorRatePct}%` },
        { label: "p95 Latency", value: `${primary.p95LatencyMs}ms`, delta: `${primary.affectedUsers.toLocaleString("en-US")} affected` },
        { label: "Open Queue", value: `${view.summary.totalOpen} active`, delta: `${view.summary.activeP1Count} P1 open` },
      ],
    });
    if (isTimelineFocus) {
      nodes.push({
        type: "timeline",
        title: `${primary.id} Live Incident Timeline`,
        events: primary.timeline.slice(0, 8),
      });
    } else {
      nodes.push({
        type: "approval",
        title: `Production Rollback · ${primary.id} (${primary.currentRelease} → ${primary.previousRelease})`,
        summary: primary.summary,
        requester: primary.owner,
        riskLevel: primary.severity === "P1" ? "high" : "medium",
        details: [
          { label: "Incident ID", value: primary.id },
          { label: "Target Environment", value: primary.environment },
          { label: "Release Action", value: `Revert ${primary.currentRelease} → ${primary.previousRelease}` },
          { label: "Current Error Rate", value: `${primary.errorRatePct}% (p95 ${primary.p95LatencyMs}ms)` },
        ],
        approveLabel: "Approve rollback",
        rejectLabel: "Hold & investigate",
        recordId: primary.id,
        domain: "ops_incident",
        initialDecision: primary.rollbackStatus === "approved" ? "approved" : primary.rollbackStatus === "rejected" ? "rejected" : "pending",
        ...(primary.rollbackNote ? { decisionNote: primary.rollbackNote } : {}),
      });
    }
    nodes.push({
      type: "table",
      caption: "Live Incident Queue",
      columns: ["Incident", "Sev", "Service", "Error Rate", "Status"],
      rows: view.incidents.slice(0, 6).map((inc) => [
        inc.id,
        inc.severity,
        inc.service,
        `${inc.errorRatePct}%`,
        inc.status.replace("_", " "),
      ]),
    });
    if (!isTimelineFocus) {
      nodes.push({
        type: "timeline",
        title: `${primary.id} Live Timeline`,
        events: primary.timeline.slice(-4),
      });
    }
  } else if (salesStore && isSalesDealPrompt(prompt)) {
    const view = salesStore.view();
    const primary = salesStore.primaryDeal();
    const usdFmt = (n: number) => `$${n.toLocaleString("en-US")}`;
    dataSource = view.summary.sourceLabel;
    recordId = primary.id;
    customBadge = `RevOps · ${primary.id}`;
    customTitle = `${primary.accountName} · ${primary.id}`.slice(0, 96);
    customSubtitle = `${primary.title} · Stage: ${primary.stage} · Close ${primary.closeDate}`;
    customDisclaimer = `Live CRM deal data grounded in ${view.summary.sourceLabel}. Deal Desk approvals persist immediately.`;
    customFollowUp = primary.discountStatus === "pending"
      ? "Show a live sales pipeline breakdown and deal table"
      : "Build a close-plan timeline for DEAL-904 enterprise renewal";

    const isTimelineFocus = /\b(timeline|close[- ]plan|mutual\s*action)\b/.test(lower);
    const isPipelineFocus = /\b(pipeline|bar chart|chart)\b/.test(lower);
    nodes.push({
      type: "metrics",
      items: [
        { label: "Total Q4 Pipeline", value: usdFmt(view.summary.totalPipelineUsd), delta: `${view.summary.activeDeals} active deals` },
        { label: "Weighted Forecast", value: usdFmt(view.summary.weightedForecastUsd), delta: `${view.summary.pendingApprovals} approval pending` },
        { label: `${primary.id} ARR`, value: usdFmt(primary.arrUsd), delta: `${primary.winProbabilityPct}% · ${primary.stage}` },
      ],
    });
    if (isTimelineFocus) {
      nodes.push({
        type: "timeline",
        title: `${primary.accountName} Mutual Action Plan`,
        events: primary.timeline.slice(0, 8),
      });
    } else if (isPipelineFocus) {
      nodes.push({
        type: "barchart",
        title: "Live Pipeline by Account (ARR)",
        unit: "usd",
        bars: view.deals.map((d) => ({
          label: `${d.accountName} (${d.stage})`,
          value: d.arrUsd,
          displayValue: usdFmt(d.arrUsd),
          highlight: d.id === primary.id,
        })),
      });
    } else {
      nodes.push({
        type: "approval",
        title: `Discount Approval · ${primary.accountName} (${primary.discountPct}% off)`,
        summary: primary.summary,
        requester: primary.owner,
        riskLevel: primary.discountPct > 15 ? "medium" : "low",
        details: [
          { label: "Deal ID", value: primary.id },
          { label: "Annual Value (ARR)", value: usdFmt(primary.arrUsd) },
          { label: "Current Stage", value: `${primary.stage} (${primary.winProbabilityPct}% prob.)` },
          { label: "Discount Requested", value: `${primary.discountPct}% (Standard cap: 15%)` },
        ],
        approveLabel: "Approve discount",
        rejectLabel: "Hold & counter-offer",
        recordId: primary.id,
        domain: "sales_deal",
        initialDecision: primary.discountStatus === "approved" ? "approved" : primary.discountStatus === "rejected" ? "rejected" : "pending",
        ...(primary.discountNote ? { decisionNote: primary.discountNote } : {}),
      });
    }
    nodes.push({
      type: "table",
      caption: "Live Q4 Deal Pipeline",
      columns: ["Deal", "Account", "Stage", "ARR", "Discount"],
      rows: view.deals.map((d) => [
        d.id,
        d.accountName,
        d.stage,
        usdFmt(d.arrUsd),
        `${d.discountPct}% (${d.discountStatus})`,
      ]),
    });
  } else if (/\b(approval|approve|rollback|incident|triage|escalation)\b/.test(lower)) {
    customBadge = "Operations & Approval";
    customFollowUp = "Build a post-incident timeline and root-cause checklist";
    nodes.push({
      type: "metrics",
      items: [
        { label: "Severity", value: "P1 · High", delta: "SLA 30m" },
        { label: "Affected Services", value: "2 APIs", delta: "Checkout + Auth" },
        { label: "Error Rate", value: "4.8%", delta: "+4.5% vs baseline" },
      ],
    });
    nodes.push({
      type: "approval",
      title: "Production Rollback Approval",
      summary: "Revert release v2.14.3 to last known healthy build v2.14.2 to clear elevated 5xx latency spikes.",
      requester: "On-Call SRE · Release Bot",
      riskLevel: "medium",
      details: [
        { label: "Target Environment", value: "Production · US-East" },
        { label: "Estimated Recovery", value: "< 3 minutes" },
        { label: "Data Impact", value: "Zero schema migration rollback" },
      ],
      approveLabel: "Approve rollback",
      rejectLabel: "Hold & investigate",
    });
    nodes.push({
      type: "checklist",
      title: "Verification runbook",
      items: [
        "Confirm error rate returns below 0.2% across edge gateways",
        "Verify p95 latency stabilizes under 180ms",
        "Post status update to incident channel and notify stakeholders",
      ],
    });
  } else if (/\b(timeline|roadmap|release readiness|onboarding|milestone|sprint)\b/.test(lower)) {
    customBadge = "Timeline & Readiness";
    customFollowUp = "Create an interactive intake form for launch sign-off";
    nodes.push({
      type: "timeline",
      title: widget.title,
      events: [
        { time: "Phase 1 · Done", title: "Requirements & design review", detail: "Architecture signed off across engineering and product.", owner: "Product Lead", status: "done" },
        { time: "Phase 2 · Active", title: "Integration testing & QA gate", detail: "Automated E2E suite passing; final performance check underway.", owner: "QA & SRE", status: "active" },
        { time: "Phase 3 · Pending", title: "Staged production rollout (10% → 100%)", detail: "Feature flag ramp with automated rollback guardrails.", owner: "Release Manager", status: "pending" },
        { time: "Phase 4 · Pending", title: "Post-launch telemetry review", detail: "24-hour KPI health check and customer feedback triage.", owner: "Ops Team", status: "pending" },
      ],
    });
    nodes.push({
      type: "checklist",
      title: "Sign-off checklist",
      items: [
        "All P0/P1 defects resolved and verified",
        "Runbook and rollback trigger verified",
        "Stakeholder release notes approved",
      ],
    });
  } else if (/\b(form|intake|request|application|survey|onboarding form|pto|expense)\b/.test(lower)) {
    customBadge = "Interactive Form";
    customFollowUp = "Create an approval card to review submitted requests";
    nodes.push({
      type: "form",
      title: widget.title,
      submitLabel: "Submit request",
      fields: [
        { id: "title", label: "Request title", type: "text", placeholder: "Short summary...", required: true },
        { id: "category", label: "Category", type: "select", required: true, options: ["Operations", "Engineering", "Finance & Ops", "HR / People"] },
        { id: "priority", label: "Priority", type: "select", required: true, options: ["Standard", "High", "Urgent"] },
        { id: "target_date", label: "Target date", type: "date", required: false },
        { id: "confirm", label: "Confirm manager / policy review completed", type: "checkbox", required: true },
      ],
    });
    nodes.push({
      type: "callout",
      tone: "info",
      title: "Governed submission",
      body: "Submitted details are validated and logged into the conversation audit trail automatically.",
    });
  } else if (/\b(table|matrix|schedule|year-by-year|5-year|10-year)\b/.test(lower)) {
    nodes.push({
      type: "table",
      caption: widget.title,
      columns: ["Horizon", "Conservative (4.5%)", "Balanced (6.5%)", "Growth (8.5%)"],
      rows: [
        ["Year 1", "$10,450", "$10,650", "$10,850"],
        ["Year 3", "$11,412", "$12,079", "$12,773"],
        ["Year 5", "$12,462", "$13,701", "$15,037"],
        ["Year 10", "$15,530", "$18,771", "$22,610"],
      ],
    });
    nodes.push({
      type: "callout",
      tone: "highlight",
      title: "Key takeaway",
      body: "Compounding differences widen substantially after Year 5. Pair return expectations with your liquidity timeline.",
    });
  } else if (/\b(bar chart|chart|graph|visuali[sz]e|bucket|breakdown)\b/.test(lower)) {
    nodes.push({
      type: "barchart",
      title: widget.title,
      unit: "percent",
      bars: [
        { label: "Core Equities", value: 55, displayValue: "55%", highlight: true },
        { label: "Investment-Grade Fixed Income", value: 25, displayValue: "25%" },
        { label: "High-Yield Cash Reserve", value: 15, displayValue: "15%" },
        { label: "Short-Term Liquidity Buffer", value: 5, displayValue: "5%" },
      ],
    });
    nodes.push({
      type: "metrics",
      items: [
        { label: "Illustrative Blend", value: "5.2%", delta: "Est. yield/return" },
        { label: "Liquid Share", value: "20%", delta: "T+1 accessible" },
        { label: "Rebalance Cadence", value: "Quarterly", delta: "Automated drift check" },
      ],
    });
  } else if (widget.kind === "calculator" && widget.sliders?.length) {
    nodes.push({
      type: "sliders",
      title: "Adjust assumptions live",
      formula: /yield|income|dividend/i.test(lower) ? "annual_yield" : "compound_monthly",
      resultLabel: /yield|income|dividend/i.test(lower) ? "Estimated annual income" : "Projected future value",
      inputs: widget.sliders.map((s) => ({
        id: s.id === "monthly" ? "monthly" : s.id === "rate" ? "rate" : s.id === "years" ? "years" : "amount",
        label: s.label,
        min: s.min,
        max: s.max,
        step: s.step,
        value: s.value,
        unit: s.unit === "months" ? "years" : s.unit,
      })),
    });
  } else if (widget.kind === "comparison" && widget.columns?.length === 2) {
    nodes.push({ type: "comparison", columns: widget.columns });
  } else if (widget.kind === "goal" && widget.goal) {
    const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
    nodes.push({
      type: "progress",
      label: widget.title,
      current: widget.goal.saved,
      target: widget.goal.target,
      currentDisplay: fmt(widget.goal.saved),
      targetDisplay: fmt(widget.goal.target),
    });
  } else if (widget.kind === "checklist" && widget.steps?.length) {
    nodes.push({ type: "checklist", title: "Action checklist", items: widget.steps });
  } else if (widget.metrics?.length) {
    nodes.push({ type: "metrics", items: widget.metrics });
  } else {
    nodes.push({
      type: "callout",
      tone: "highlight",
      title: widget.title,
      body: profileSummary ? `${widget.body} (${profileSummary})` : widget.body,
    });
  }

  return {
    intro: dataSource
      ? `Loaded live operational telemetry from ${dataSource} for "${customTitle ?? widget.title}". Approving or holding the rollback updates the backing incident store immediately.`
      : `I composed a custom interactive view for "${widget.title}". You can interact with it below or save it directly to your Widget Library.`,
    canvas: {
      title: customTitle ?? widget.title,
      badge: customBadge ?? widget.badge,
      subtitle: customSubtitle ?? widget.body,
      generatedBy: "synthesizer",
      ...(dataSource ? { dataSource } : {}),
      ...(recordId ? { recordId } : {}),
      prompt,
      nodes,
      disclaimer: customDisclaimer ?? "Illustrative dynamic UI generated for exploration and operational review.",
      suggestedFollowUp: customFollowUp,
    },
  };
}

function buildApprovalQueueCanvas(approvalStore: ApprovalStore, prompt: string): { intro: string; canvas: DynamicCanvasProps } {
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
        domain: item.domain === "customer360" ? "generic" : item.domain,
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

function buildConnectorActionCanvas(
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

function buildActionFlowCanvas(
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
            domain: approval.domain === "customer360" ? "generic" : approval.domain,
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

function buildStockTradeCanvas(
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

function buildStockHoldingsCanvas(
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

  return {
    intro: `Here are all **${activeHoldings.length} active stock positions** in your live portfolio (${usd(marketTotalCents)} total equity holdings, ${usd(snapshot.cashCents)} cash, ${tlhCount} tax-loss harvesting candidate${tlhCount === 1 ? "" : "s"}). Ask to buy or sell any ticker (for example, *"I want to sell 40% of my Apple shares"*) to open the trade & tax-harvest simulator.`,
    canvas: {
      title: "Live Stock Holdings & Tax-Lot Positions",
      badge: "Live Equity Holdings",
      subtitle: `${activeHoldings.length} active tickers · Cash ${usd(snapshot.cashCents)} · ${tlhCount} TLH candidate${tlhCount === 1 ? "" : "s"}`,
      generatedBy: "synthesizer",
      dataSource: "trades-portfolio.json + Customer 360",
      prompt,
      nodes,
      disclaimer: "Holdings reflect live simulated trades settled through sfield cep.domain.execute_write@1.0.0. Highlighted rows indicate unrealized losses eligible for Tax-Loss Harvesting.",
      suggestedFollowUp: "I want to sell 40% of my Apple shares",
    },
  };
}

export async function generateDynamicUi(input: {
  prompt: string;
  profileSummary?: string;
  gateway?: GatewaySettings | null;
  dataDir: string;
  opsStore?: OpsIncidentStore;
  salesStore?: SalesDealStore;
  connectorStore?: ConnectorStore;
  approvalStore?: ApprovalStore;
  tradeStore?: TradeStore;
  actionFlowStore?: ActionFlowStore;
  matchedActionFlow?: ActionFlow;
  personaId?: string;
  conversationId?: string;
  principalId?: string;
  onTradeSettle?: (principalId: string) => SettlementCallback;
  requesterName?: string;
  semanticRoute?: SemanticRouteDecision;
  tradeContinuation?: {
    draft: TradeDraftState;
    intent: "tax_analysis" | "adjust_qty" | "execute";
    percent?: number;
    shares?: number;
    includeHarvest?: boolean;
  };
  signal?: AbortSignal;
}): Promise<{ intro: string; canvas: DynamicCanvasProps }> {
  const {
    prompt, profileSummary, gateway, dataDir, opsStore, salesStore, connectorStore, approvalStore,
    tradeStore, matchedActionFlow, personaId, conversationId, principalId, onTradeSettle, requesterName, semanticRoute, tradeContinuation,
  } = input;

  if (matchedActionFlow) {
    return buildActionFlowCanvas(matchedActionFlow, connectorStore, approvalStore, requesterName, prompt);
  }

  if (tradeContinuation && tradeStore) {
    const { draft, intent, percent, shares, includeHarvest } = tradeContinuation;
    const snap = tradeStore.snapshotFor(draft.personaId);
    const target = snap.holdings.find((h) => h.symbol === draft.symbol) ?? snap.holdings[0];
    const nextShares = shares
      ?? (percent && target.shares > 0 ? Math.max(1, Math.round((target.shares * percent) / 100)) : draft.shares);

    if (intent === "tax_analysis") {
      return buildStockTradeCanvas(tradeStore, draft.personaId, draft.actorName, prompt, undefined, {
        conversationId,
        initialStage: "tax_analysis",
        overrideSide: draft.side,
        overrideSymbol: draft.symbol,
        overrideShares: nextShares,
      });
    }
    if (intent === "adjust_qty") {
      return buildStockTradeCanvas(tradeStore, draft.personaId, draft.actorName, prompt, { percent }, {
        conversationId,
        initialStage: "configure",
        overrideSide: draft.side,
        overrideSymbol: draft.symbol,
        overrideShares: nextShares,
      });
    }
    // intent === "execute"
    const legs: TradeLegInput[] = [
      { symbol: draft.symbol, side: draft.side, shares: nextShares, reason: "primary" },
    ];
    if (includeHarvest && draft.side === "sell") {
      const analysis = draft.taxAnalysis ?? tradeStore.analyzeTaxHarvest(draft.personaId, draft.symbol, nextShares);
      for (const rec of analysis.recommendations) {
        if (rec.recommendedShares > 0) {
          legs.push({ symbol: rec.symbol, side: "sell", shares: rec.recommendedShares, reason: "tax_harvest" });
        }
      }
    }
    const grossCents = tradeStore.estimateGrossCents(draft.personaId, legs);
    if (approvalStore && approvalStore.shouldGateTrade(grossCents)) {
      const policy = approvalStore.getPolicy();
      const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const approval = approvalStore.createPending({
        targetKind: "stock_trade",
        sfieldToolRef: domainWriteToolRef,
        domain: "stock_trade",
        recordId: draft.personaId,
        action: "execute_trade_bundle",
        title: `High-Value Trade Approval · ${legs.map((l) => `${l.side.toUpperCase()} ${l.shares} ${l.symbol}`).join(" + ")}`.slice(0, 120),
        summary: `Gross trade value ${usd(grossCents)} exceeds the $${policy.highRiskTradeThresholdUsd.toLocaleString("en-US")} compliance threshold. Approve to launch the timed sfield settlement job.`,
        riskLevel: "high",
        payload: { personaId: draft.personaId, legs, taxHarvestAnalyzed: Boolean(includeHarvest), grossCents },
        details: [
          { label: "Gross Order Value", value: usd(grossCents) },
          { label: "Compliance Threshold", value: `$${policy.highRiskTradeThresholdUsd.toLocaleString("en-US")}` },
          { label: "Order Legs", value: legs.map((l) => `${l.side.toUpperCase()} ${l.shares} ${l.symbol}`).join(", ") },
          { label: "4-Eyes Dual Control", value: policy.defaultDualControl ? "Required" : "Inline allowed" },
        ],
        requester: draft.actorName,
        dualControl: policy.defaultDualControl,
      });
      if (conversationId) tradeStore.clearDraft(conversationId);
      return {
        intro: `This trade bundle (**${usd(grossCents)}**) exceeds the **$${policy.highRiskTradeThresholdUsd.toLocaleString("en-US")}** high-value compliance threshold, so it has been gated for **HITL Approval** (\`${approval.id}\`). Approve inline below or in \`/admin/logs?source=approvals\` to launch the timed settlement job.`,
        canvas: {
          title: "High-Value Trade Compliance Gate (HITL)",
          badge: "Trade · HITL Approval",
          subtitle: `Approval ${approval.id} · ${usd(grossCents)} gross order value`,
          generatedBy: "synthesizer",
          dataSource: "trades-portfolio.json + approvals.json",
          prompt,
          nodes: [
            {
              type: "approval",
              title: approval.title,
              summary: approval.summary,
              requester: approval.requester,
              riskLevel: "high",
              details: approval.details,
              approveLabel: "Approve & run trade",
              rejectLabel: "Deny trade",
              recordId: approval.recordId,
              domain: "stock_trade",
              approvalId: approval.id,
              payloadDigest: approval.payloadDigest,
              dualControl: approval.dualControl,
              sfieldToolRef: approval.sfieldToolRef,
              initialDecision: "pending",
            },
          ],
          disclaimer: "High-value trades are cryptographically digest-bound and gated through sfield HITL approvals before settlement.",
          suggestedFollowUp: "Show all my stocks",
        },
      };
    }

    const settler = onTradeSettle ? onTradeSettle(principalId ?? "chat") : async () => ({ sfieldRunId: "offline" });
    const job = tradeStore.startTradeJob(
      { personaId: draft.personaId, actor: draft.actorName, legs, taxHarvestAnalyzed: Boolean(includeHarvest), durationSeconds: 5 },
      settler,
    );
    if (conversationId) tradeStore.clearDraft(conversationId);
    return buildStockTradeCanvas(tradeStore, draft.personaId, draft.actorName, prompt, undefined, {
      conversationId,
      initialStage: "running",
      initialJobId: job.jobId,
      overrideSide: draft.side,
      overrideSymbol: draft.symbol,
      overrideShares: nextShares,
    });
  }

  const capId = semanticRoute?.capabilityId;
  if (tradeStore && (capId === "stock_trade" || (!capId && stockTradeTrigger.test(prompt)))) {
    return buildStockTradeCanvas(tradeStore, personaId || "demo-learner", requesterName, prompt, semanticRoute?.extractedParams, { conversationId });
  }
  if (tradeStore && (capId === "stock_holdings" || (!capId && stockHoldingsTrigger.test(prompt)))) {
    return buildStockHoldingsCanvas(tradeStore, personaId || "demo-learner", prompt);
  }
  if (approvalStore && (capId === "hitl_approvals" || (!capId && isApprovalQueuePrompt(prompt)))) {
    return buildApprovalQueueCanvas(approvalStore, prompt);
  }
  if (connectorStore && approvalStore && (capId === "external_connector" || (!capId && isConnectorActionPrompt(prompt)))) {
    return buildConnectorActionCanvas(connectorStore, approvalStore, prompt, requesterName);
  }
  const opsLive = opsStore && (capId === "ops_incident" || (!capId && isOpsIncidentPrompt(prompt))) ? {
    view: opsStore.view(),
    primary: opsStore.primaryIncident(),
  } : null;
  const salesLive = !opsLive && salesStore && (capId === "sales_deal_desk" || (!capId && isSalesDealPrompt(prompt))) ? {
    view: salesStore.view(),
    primary: salesStore.primaryDeal(),
  } : null;

  if (!gateway) return synthesizeDynamicCanvas(prompt, profileSummary, opsStore, salesStore);

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), 18_000);
  timer.unref();
  const onParentAbort = () => timeoutController.abort();
  input.signal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    const parts: string[] = [];
    if (opsLive) {
      parts.push(`LIVE DOMAIN DATA (${opsLive.view.summary.sourceLabel}):\n${JSON.stringify({
        summary: opsLive.view.summary,
        primaryIncident: opsLive.primary,
        allIncidents: opsLive.view.incidents.map((i) => ({
          id: i.id,
          title: i.title,
          severity: i.severity,
          status: i.status,
          service: i.service,
          environment: i.environment,
          errorRatePct: i.errorRatePct,
          p95LatencyMs: i.p95LatencyMs,
          affectedUsers: i.affectedUsers,
          currentRelease: i.currentRelease,
          previousRelease: i.previousRelease,
          rollbackStatus: i.rollbackStatus,
          rollbackNote: i.rollbackNote,
        })),
      })}`);
    } else if (salesLive) {
      parts.push(`LIVE DOMAIN DATA (${salesLive.view.summary.sourceLabel}):\n${JSON.stringify({
        summary: salesLive.view.summary,
        primaryDeal: salesLive.primary,
        allDeals: salesLive.view.deals.map((d) => ({
          id: d.id,
          accountName: d.accountName,
          title: d.title,
          stage: d.stage,
          arrUsd: d.arrUsd,
          discountPct: d.discountPct,
          discountStatus: d.discountStatus,
          discountNote: d.discountNote,
          winProbabilityPct: d.winProbabilityPct,
          closeDate: d.closeDate,
          owner: d.owner,
        })),
      })}`);
    } else if (profileSummary) {
      parts.push(`Customer context: ${profileSummary}`);
    }
    parts.push(`Request: ${prompt}`);
    const userPrompt = parts.join("\n\n");

    const raw = await callConfiguredLlmJson(gateway, dataDir, canvasSystemPrompt, userPrompt, timeoutController.signal);
    if (raw && typeof raw === "object") {
      const obj = raw as { intro?: unknown; canvas?: unknown };
      const candidateCanvas = (obj.canvas && typeof obj.canvas === "object" ? obj.canvas : raw) as Record<string, unknown>;
      const rawNodes = Array.isArray(candidateCanvas.nodes) ? candidateCanvas.nodes : [];
      const hydratedNodes = opsLive
        ? rawNodes.map((n) => {
            if (n && typeof n === "object" && (n as { type?: string }).type === "approval") {
              const p = opsLive.primary;
              return {
                ...(n as Record<string, unknown>),
                recordId: p.id,
                domain: "ops_incident",
                initialDecision: p.rollbackStatus === "approved" ? "approved" : p.rollbackStatus === "rejected" ? "rejected" : "pending",
                ...(p.rollbackNote ? { decisionNote: p.rollbackNote } : {}),
              };
            }
            return n;
          })
        : salesLive
          ? rawNodes.map((n) => {
              if (n && typeof n === "object" && (n as { type?: string }).type === "approval") {
                const d = salesLive.primary;
                return {
                  ...(n as Record<string, unknown>),
                  recordId: d.id,
                  domain: "sales_deal",
                  initialDecision: d.discountStatus === "approved" ? "approved" : d.discountStatus === "rejected" ? "rejected" : "pending",
                  ...(d.discountNote ? { decisionNote: d.discountNote } : {}),
                };
              }
              return n;
            })
          : rawNodes;

      const parsed = dynamicCanvasSchema.safeParse({
        ...candidateCanvas,
        nodes: hydratedNodes,
        generatedBy: "llm",
        ...(opsLive ? { dataSource: opsLive.view.summary.sourceLabel, recordId: opsLive.primary.id } : {}),
        ...(salesLive ? { dataSource: salesLive.view.summary.sourceLabel, recordId: salesLive.primary.id } : {}),
        prompt,
      });
      if (parsed.success) {
        const intro = typeof obj.intro === "string" && obj.intro.trim()
          ? obj.intro.trim().slice(0, 600)
          : `Here is a dynamically generated interactive view for "${parsed.data.title}".`;
        return { intro, canvas: parsed.data };
      }
    }
  } catch {
    // Gracefully fall back to deterministic composable synthesizer if the live model times out or returns malformed JSON.
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onParentAbort);
  }
  return synthesizeDynamicCanvas(prompt, profileSummary, opsStore, salesStore);
}

const widgetStudioSystemPrompt = [
  "You are CEP Widget Studio Generator. Given a natural-language widget request, output ONE JSON object matching this schema:",
  JSON.stringify({
    name: "Short library name (max 72 chars)",
    kind: "kpi | calculator | goal | comparison | checklist | advisory",
    prompt: "Original user prompt",
    badge: "Short badge label (max 40 chars)",
    title: "Card headline (max 90 chars)",
    body: "1-2 sentence description (max 320 chars)",
    ctaLabel: "Action button text (max 48 chars)",
    accentTop: true,
    recommendedComponent: "PznPortfolioSnapshot | PznCapabilityForm | PznGoalProgress | PznComparison | PznStepList | PznContentCard",
    metrics: "Optional (when kind=kpi): 2-4 items [{ label, value, delta? }]",
    sliders: "Optional (when kind=calculator): 2-3 items [{ id: 'monthly'|'years'|'rate', label, min, max, step, value, unit: 'usd'|'percent'|'years'|'months' }]",
    goal: "Optional (when kind=goal): { saved: number, target: number, unitLabel?: string }",
    columns: "Optional (when kind=comparison): exactly 2 items [{ title, points: [2-4 strings] }]",
    steps: "Optional (when kind=checklist): 3-5 step strings",
  }),
  "Do not include any external company names. Return ONLY valid JSON.",
].join("\n");

export async function generateWidgetDraftWithLlm(
  prompt: string,
  gateway: GatewaySettings | null | undefined,
  dataDir: string,
): Promise<WidgetDraft> {
  if (!gateway) return generateWidgetFromText(prompt);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 14_000);
  timer.unref();
  try {
    const raw = await callConfiguredLlmJson(gateway, dataDir, widgetStudioSystemPrompt, prompt, controller.signal);
    const parsed = widgetDraftSchema.safeParse(raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>), prompt } : null);
    if (parsed.success) return parsed.data;
  } catch {
    // Fall back to deterministic generator
  } finally {
    clearTimeout(timer);
  }
  return generateWidgetFromText(prompt);
}
