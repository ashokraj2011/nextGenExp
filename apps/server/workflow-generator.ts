import {
  workflowDefinitionUpsertSchema,
  type WorkflowCondition,
  type WorkflowDefinitionUpsertInput,
  type WorkflowField,
  type WorkflowStep,
} from "../../packages/contracts/workflow-definition";
import type { ExternalConnector } from "../../packages/contracts/connector";
import { callConfiguredLlmJson } from "./dynamic-ui-generator";
import type { GatewaySettings } from "./gateway";

export interface GeneratedWorkflowResult {
  definition: WorkflowDefinitionUpsertInput;
  generatedBy: "copilot_llm" | "synthesizer";
  summary: string;
}

const VALID_DOMAINS = new Set(["wealth", "operations", "sales", "general"]);
const VALID_OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "truthy", "falsy", "contains"]);
const VALID_FIELD_TYPES = new Set(["text", "number", "currency", "select", "checkbox"]);

function slug(raw: unknown, fallback: string): string {
  const s = typeof raw === "string"
    ? raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^[^a-z0-9]+|_+$/g, "").slice(0, 42)
    : "";
  return /^[a-z0-9][a-z0-9_-]{1,47}$/.test(s) ? s : fallback;
}

function cleanFieldId(raw: unknown, fallback: string): string {
  const s = typeof raw === "string" ? raw.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 36) : "";
  return /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(s) ? s : fallback;
}

function sanitizeCondition(raw: unknown): WorkflowCondition | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  const field = typeof c.field === "string" ? c.field.trim().slice(0, 64) : "";
  const op = typeof c.op === "string" && VALID_OPS.has(c.op) ? (c.op as WorkflowCondition["op"]) : undefined;
  if (!field || !op) return undefined;
  const val = c.value;
  return {
    field,
    op,
    ...(typeof val === "string" || typeof val === "number" || typeof val === "boolean" ? { value: val } : {}),
  };
}

function sanitizeWorkflowCandidate(
  raw: unknown,
  prompt: string,
  connectors: ExternalConnector[],
): WorkflowDefinitionUpsertInput | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const rawSteps = Array.isArray(obj.steps) ? obj.steps : [];
  const defaultConnId = connectors.find((c) => c.enabled)?.id ?? "pagerduty_incident_webhook";
  const knownConnIds = new Set(connectors.map((c) => c.id));
  const usedIds = new Set<string>();
  const uniqStepId = (pref: unknown, idx: number) => {
    const base = slug(pref, `step_${idx + 1}`);
    let cand = base;
    let n = 2;
    while (usedIds.has(cand)) cand = `${base.slice(0, 38)}_${n++}`;
    usedIds.add(cand);
    return cand;
  };

  const steps: WorkflowStep[] = [];
  for (const [idx, item] of rawSteps.slice(0, 10).entries()) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    const id = uniqStepId(s.id, idx);
    const title = typeof s.title === "string" && s.title.trim() ? s.title.trim().slice(0, 80) : `Step ${idx + 1}`;
    const description = typeof s.description === "string" && s.description.trim() ? s.description.trim().slice(0, 220) : undefined;
    const when = sanitizeCondition(s.when);
    const base = { id, title, ...(description ? { description } : {}), ...(when ? { when } : {}) };

    if (s.type === "collect_input") {
      const rawFields = Array.isArray(s.fields) ? s.fields : [];
      const fields: WorkflowField[] = [];
      for (const [fIdx, fItem] of rawFields.slice(0, 8).entries()) {
        if (!fItem || typeof fItem !== "object") continue;
        const f = fItem as Record<string, unknown>;
        const fType = VALID_FIELD_TYPES.has(String(f.type)) ? (String(f.type) as WorkflowField["type"]) : "text";
        const options = Array.isArray(f.options)
          ? f.options.map((o) => String(o).trim().slice(0, 56)).filter(Boolean).slice(0, 10)
          : undefined;
        fields.push({
          id: cleanFieldId(f.id, `field${fIdx + 1}`),
          label: typeof f.label === "string" && f.label.trim() ? f.label.trim().slice(0, 64) : `Input ${fIdx + 1}`,
          type: fType,
          required: f.required !== false,
          ...(typeof f.placeholder === "string" && f.placeholder.trim() ? { placeholder: f.placeholder.trim().slice(0, 80) } : {}),
          ...(fType === "select" ? { options: options && options.length > 0 ? options : ["Standard", "Expedited"] } : {}),
          ...(typeof f.defaultValue === "string" || typeof f.defaultValue === "number" || typeof f.defaultValue === "boolean"
            ? { defaultValue: f.defaultValue }
            : {}),
        });
      }
      if (fields.length > 0) {
        steps.push({
          ...base,
          type: "collect_input",
          submitLabel: typeof s.submitLabel === "string" && s.submitLabel.trim() ? s.submitLabel.trim().slice(0, 40) : "Continue",
          fields,
        });
      }
    } else if (s.type === "compute") {
      const evaluator = s.evaluator === "ofac_velocity_screen" || s.evaluator === "loan_underwriting" ? s.evaluator : "template_summary";
      steps.push({
        ...base,
        type: "compute",
        evaluator,
        outputTemplate: typeof s.outputTemplate === "string" && s.outputTemplate.trim()
          ? s.outputTemplate.trim().slice(0, 400)
          : `Evaluated "${title}" successfully.`,
      });
    } else if (s.type === "hitl_approval") {
      const riskLevel = s.riskLevel === "low" || s.riskLevel === "medium" ? s.riskLevel : "high";
      steps.push({
        ...base,
        type: "hitl_approval",
        riskLevel,
        dualControl: Boolean(s.dualControl),
        approvalTitleTemplate: typeof s.approvalTitleTemplate === "string" && s.approvalTitleTemplate.trim()
          ? s.approvalTitleTemplate.trim().slice(0, 120)
          : `Approval Required · ${title}`,
        approvalSummaryTemplate: typeof s.approvalSummaryTemplate === "string" && s.approvalSummaryTemplate.trim()
          ? s.approvalSummaryTemplate.trim().slice(0, 320)
          : "SHA-256 digest-bound approval required prior to execution.",
        approveLabel: typeof s.approveLabel === "string" && s.approveLabel.trim() ? s.approveLabel.trim().slice(0, 40) : "Approve & Continue",
        rejectLabel: typeof s.rejectLabel === "string" && s.rejectLabel.trim() ? s.rejectLabel.trim().slice(0, 40) : "Reject & Abort",
      });
    } else if (s.type === "connector_call") {
      const connId = typeof s.connectorId === "string" && knownConnIds.has(s.connectorId) ? s.connectorId : defaultConnId;
      steps.push({
        ...base,
        type: "connector_call",
        connectorId: connId,
        action: typeof s.action === "string" && s.action.trim() ? s.action.trim().slice(0, 64) : "workflow_action",
        ...(typeof s.noteTemplate === "string" && s.noteTemplate.trim() ? { noteTemplate: s.noteTemplate.trim().slice(0, 240) } : {}),
      });
    } else if (s.type === "async_job") {
      const dur = Math.min(12, Math.max(2, Math.round(Number(s.durationSeconds) || 4)));
      steps.push({
        ...base,
        type: "async_job",
        durationSeconds: dur,
        cancellable: s.cancellable !== false,
        runningLabel: typeof s.runningLabel === "string" && s.runningLabel.trim() ? s.runningLabel.trim().slice(0, 120) : `Executing ${title}...`,
        completedTemplate: typeof s.completedTemplate === "string" && s.completedTemplate.trim() ? s.completedTemplate.trim().slice(0, 260) : `${title} settled cleanly.`,
      });
    } else if (s.type === "emit_host_event") {
      steps.push({
        ...base,
        type: "emit_host_event",
        eventName: typeof s.eventName === "string" && s.eventName.trim() ? s.eventName.trim().slice(0, 64) : "cep:workflow_completed",
        messageTemplate: typeof s.messageTemplate === "string" && s.messageTemplate.trim()
          ? s.messageTemplate.trim().slice(0, 240)
          : "Dispatched completion event to host portal.",
      });
    }
  }

  if (steps.length === 0) return null;

  const rawTriggers = Array.isArray(obj.triggerPhrases)
    ? obj.triggerPhrases.map((t) => String(t).trim().slice(0, 120)).filter((t) => t.length >= 3).slice(0, 8)
    : [];
  const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim().slice(0, 80) : "Copilot Generated Workflow";
  const candidate: WorkflowDefinitionUpsertInput = {
    id: slug(obj.id ?? name, `wf_${Date.now().toString(36).slice(-5)}`),
    name,
    domain: VALID_DOMAINS.has(String(obj.domain)) ? (String(obj.domain) as WorkflowDefinitionUpsertInput["domain"]) : "wealth",
    version: "1.0.0",
    description: typeof obj.description === "string" && obj.description.trim()
      ? obj.description.trim().slice(0, 260)
      : prompt.slice(0, 240),
    triggerPhrases: rawTriggers.length > 0 ? rawTriggers : [name.toLowerCase()],
    steps,
    enabled: true,
  };
  const parsed = workflowDefinitionUpsertSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function synthesizeWorkflowFromPrompt(prompt: string, connectors: ExternalConnector[]): WorkflowDefinitionUpsertInput {
  const lower = prompt.toLowerCase();
  const thresholdMatch = prompt.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(k)?/i);
  const threshold = thresholdMatch
    ? Math.round(Number(thresholdMatch[1].replace(/,/g, "")) * (thresholdMatch[2] ? 1000 : 1))
    : 5000;
  const dualControl = /\b(4-?eyes|dual\s*control|separate\s*approver)\b/i.test(lower);
  const connId = connectors.find((c) => c.enabled)?.id ?? "pagerduty_incident_webhook";

  if (/\b(insurance|claim|payout|reimburse)\b/i.test(lower)) {
    return {
      id: "insurance_claim_payout",
      name: "Insurance Claim Adjudication & Payout",
      domain: "wealth",
      version: "1.0.0",
      description: `Collects claim details, runs automated policy check, requires HITL sign-off above $${threshold.toLocaleString("en-US")}, settles payout via timer, and notifies host portal.`,
      triggerPhrases: ["file insurance claim", "submit claim payout", "insurance claim workflow"],
      enabled: true,
      steps: [
        {
          id: "collect_claim",
          type: "collect_input",
          title: "Collect Claim Details",
          submitLabel: "Evaluate Claim",
          fields: [
            { id: "policyNumber", label: "Policy Number", type: "text", required: true, defaultValue: "POL-884210" },
            { id: "claimType", label: "Claim Type", type: "select", options: ["Property", "Auto", "Health / Dental"], defaultValue: "Property" },
            { id: "claimAmountUsd", label: "Claim Amount ($ USD)", type: "currency", required: true, defaultValue: threshold + 1500 },
            { id: "expeditedReview", label: "Run Fraud & Duplicate Screening", type: "checkbox", defaultValue: true },
          ],
        },
        {
          id: "fraud_screen",
          type: "compute",
          title: "Automated Policy & Fraud Pre-Check",
          when: { field: "inputs.expeditedReview", op: "truthy" },
          evaluator: "template_summary",
          outputTemplate: "Policy {{inputs.policyNumber}} verified active for {{inputs.claimType}} claim (${{inputs.claimAmountUsd}}). Zero duplicate claims detected.",
        },
        {
          id: "adjuster_gate",
          type: "hitl_approval",
          title: `Senior Adjuster Approval (> $${threshold.toLocaleString("en-US")})`,
          when: { field: "inputs.claimAmountUsd", op: "gt", value: threshold },
          riskLevel: "high",
          dualControl,
          approvalTitleTemplate: "Claim Approval · {{inputs.policyNumber}} (${{inputs.claimAmountUsd}})",
          approvalSummaryTemplate: `Claim amount $${"{{inputs.claimAmountUsd}}"} exceeds $${threshold.toLocaleString("en-US")} auto-adjudication cap.`,
          approveLabel: "Approve Claim Payout",
          rejectLabel: "Deny Claim",
        },
        {
          id: "payout_job",
          type: "async_job",
          title: "ACH Payout Disbursal",
          durationSeconds: 4,
          cancellable: true,
          runningLabel: "Disbursing ${{inputs.claimAmountUsd}} for policy {{inputs.policyNumber}}...",
          completedTemplate: "Payout settled · ${{inputs.claimAmountUsd}} sent for claim {{inputs.policyNumber}}.",
        },
        {
          id: "emit_claim_done",
          type: "emit_host_event",
          title: "Sync Host Claims Portal",
          eventName: "cep:workflow_completed",
          messageTemplate: "Emitted cep:workflow_completed for policy {{inputs.policyNumber}}.",
        },
      ],
    };
  }

  if (/\b(vendor|procurement|invoice|expense|supplier|onboard)\b/i.test(lower)) {
    return {
      id: "vendor_onboarding_compliance",
      name: "Vendor Onboarding & Payout Governance",
      domain: "sales",
      version: "1.0.0",
      description: `Collects vendor contract details, screens risk tier, gates contracts over $${threshold.toLocaleString("en-US")} with HITL approval, and provisions vendor record.`,
      triggerPhrases: ["onboard new vendor", "vendor approval workflow", "procurement workflow"],
      enabled: true,
      steps: [
        {
          id: "collect_vendor",
          type: "collect_input",
          title: "Vendor & Contract Information",
          submitLabel: "Run Compliance Check",
          fields: [
            { id: "vendorName", label: "Vendor Legal Name", type: "text", required: true, defaultValue: "Northstar Cloud Analytics" },
            { id: "annualSpendUsd", label: "Annual Contract Value ($ USD)", type: "currency", required: true, defaultValue: threshold + 5000 },
            { id: "dataAccess", label: "Data Access Tier", type: "select", options: ["Public Only", "Internal", "PII / Regulated"], defaultValue: "PII / Regulated" },
          ],
        },
        {
          id: "vendor_risk_calc",
          type: "compute",
          title: "SOC2 & Data-Tier Screening",
          evaluator: "template_summary",
          outputTemplate: "Screened {{inputs.vendorName}} (${{inputs.annualSpendUsd}}/yr, tier: {{inputs.dataAccess}}). Ready for procurement gate.",
        },
        {
          id: "procurement_gate",
          type: "hitl_approval",
          title: `Procurement & InfoSec Sign-Off (> $${threshold.toLocaleString("en-US")})`,
          when: { field: "inputs.annualSpendUsd", op: "gt", value: threshold },
          riskLevel: "high",
          dualControl,
          approvalTitleTemplate: "Vendor Sign-Off · {{inputs.vendorName}} (${{inputs.annualSpendUsd}})",
          approvalSummaryTemplate: "Annual vendor spend and data access tier ({{inputs.dataAccess}}) require formal approval.",
          approveLabel: "Approve Vendor",
          rejectLabel: "Reject Vendor",
        },
        {
          id: "provision_vendor",
          type: "async_job",
          title: "ERP Vendor Provisioning",
          durationSeconds: 4,
          cancellable: true,
          runningLabel: "Provisioning {{inputs.vendorName}} in ERP ledger...",
          completedTemplate: "{{inputs.vendorName}} onboarded and active for PO issuance.",
        },
        {
          id: "emit_vendor_done",
          type: "emit_host_event",
          title: "Notify Procurement Portal",
          eventName: "cep:workflow_completed",
          messageTemplate: "Broadcasted vendor activation for {{inputs.vendorName}}.",
        },
      ],
    };
  }

  return {
    id: `copilot_workflow_${Date.now().toString(36).slice(-4)}`,
    name: "Copilot Governed Multi-Step Pipeline",
    domain: /\b(ops|sre|deploy|rollback|incident|cloud)\b/i.test(lower) ? "operations" : "wealth",
    version: "1.0.0",
    description: prompt.slice(0, 240),
    triggerPhrases: ["run copilot workflow", "start governed pipeline"],
    enabled: true,
    steps: [
      {
        id: "collect_params",
        type: "collect_input",
        title: "Collect Execution Parameters",
        submitLabel: "Validate & Continue",
        fields: [
          { id: "targetName", label: "Target / Subject", type: "text", required: true, defaultValue: "Primary Account" },
          { id: "amountUsd", label: "Value / Impact ($ USD)", type: "currency", required: true, defaultValue: threshold + 2000 },
          { id: "notifyWebhook", label: "Notify External Connector", type: "checkbox", defaultValue: true },
        ],
      },
      {
        id: "policy_gate",
        type: "hitl_approval",
        title: `Compliance Approval Gate (> $${threshold.toLocaleString("en-US")})`,
        when: { field: "inputs.amountUsd", op: "gt", value: threshold },
        riskLevel: "high",
        dualControl,
        approvalTitleTemplate: "Approve {{inputs.targetName}} (${{inputs.amountUsd}})",
        approvalSummaryTemplate: "Execution exceeds automated threshold and requires SHA-256 human sign-off.",
        approveLabel: "Approve & Execute",
        rejectLabel: "Abort",
      },
      {
        id: "dispatch_connector",
        type: "connector_call",
        title: "Invoke External Connector",
        when: { field: "inputs.notifyWebhook", op: "truthy" },
        connectorId: connId,
        action: "workflow_dispatch",
        noteTemplate: "Executing {{inputs.targetName}} (${{inputs.amountUsd}})",
      },
      {
        id: "settle_job",
        type: "async_job",
        title: "Background Settlement Timer",
        durationSeconds: 4,
        cancellable: true,
        runningLabel: "Settling {{inputs.targetName}}...",
        completedTemplate: "Completed {{inputs.targetName}} (${{inputs.amountUsd}}).",
      },
      {
        id: "sync_host",
        type: "emit_host_event",
        title: "Emit Host Portal Event",
        eventName: "cep:workflow_completed",
        messageTemplate: "Sent cep:workflow_completed to host app.",
      },
    ],
  };
}

function buildWorkflowSystemPrompt(connectors: ExternalConnector[]): string {
  const connList = connectors.map((c) => `- ${c.id} (${c.kind}, enabled=${c.enabled}): ${c.name}`).join("\n");
  return [
    "You are CEP Workflow Architect Copilot. Given a plain-English business process description, output ONE valid JSON object matching CEP's declarative WorkflowDefinition schema.",
    "RULES:",
    "1. Include 3 to 6 concrete executable steps using ONLY these step types: `collect_input`, `compute`, `hitl_approval`, `connector_call`, `async_job`, `emit_host_event`.",
    "2. ALWAYS start with a `collect_input` step whose field `id` values are camelCase (e.g. `claimAmountUsd`, `vendorName`) with sensible `defaultValue`s so the user can test immediately.",
    "3. Use conditional `when: { field: 'inputs.<fieldId>', op: 'gt'|'eq'|'truthy'|..., value?: ... }` on `hitl_approval`, `compute`, or `connector_call` steps whenever the prompt mentions a threshold or optional check.",
    "4. Use `{{inputs.<fieldId>}}` template interpolation inside summaries, approval titles, and job completion messages.",
    "5. End with an `async_job` (durationSeconds: 4, cancellable: true) and `emit_host_event` (eventName: 'cep:workflow_completed').",
    "6. Do NOT mention external company names. Return ONLY valid JSON.",
    "",
    "AVAILABLE CONNECTOR IDs (for connector_call steps):",
    connList || "- pagerduty_incident_webhook",
    "",
    "OUTPUT JSON SHAPE:",
    JSON.stringify({
      id: "snake_case_id",
      name: "Workflow Display Name",
      domain: "wealth | operations | sales | general",
      version: "1.0.0",
      description: "1-2 sentence summary",
      triggerPhrases: ["phrase one", "phrase two"],
      enabled: true,
      steps: [
        {
          id: "collect_details",
          type: "collect_input",
          title: "Collect Details",
          submitLabel: "Continue",
          fields: [
            { id: "amountUsd", label: "Amount ($ USD)", type: "currency", required: true, defaultValue: 5000 },
          ],
        },
        {
          id: "risk_gate",
          type: "hitl_approval",
          title: "Approval Gate",
          when: { field: "inputs.amountUsd", op: "gt", value: 2500 },
          riskLevel: "high",
          dualControl: false,
          approvalTitleTemplate: "Approve ${{inputs.amountUsd}}",
          approvalSummaryTemplate: "Exceeds threshold.",
          approveLabel: "Approve & Continue",
          rejectLabel: "Reject",
        },
        {
          id: "settle_timer",
          type: "async_job",
          title: "Settlement Job",
          durationSeconds: 4,
          cancellable: true,
          runningLabel: "Processing ${{inputs.amountUsd}}...",
          completedTemplate: "Settled ${{inputs.amountUsd}}.",
        },
        {
          id: "emit_done",
          type: "emit_host_event",
          title: "Sync Host App",
          eventName: "cep:workflow_completed",
          messageTemplate: "Emitted cep:workflow_completed.",
        },
      ],
    }),
  ].join("\n");
}

export async function generateWorkflowWithLlm(input: {
  prompt: string;
  gateway: GatewaySettings | null | undefined;
  dataDir: string;
  connectors: ExternalConnector[];
  signal?: AbortSignal;
}): Promise<GeneratedWorkflowResult> {
  const { prompt, gateway, dataDir, connectors } = input;
  if (gateway) {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), 16_000);
    timer.unref();
    try {
      const raw = await callConfiguredLlmJson(gateway, dataDir, buildWorkflowSystemPrompt(connectors), prompt, controller.signal);
      const parsed = sanitizeWorkflowCandidate(raw, prompt, connectors);
      if (parsed) {
        return {
          definition: parsed,
          generatedBy: "copilot_llm",
          summary: `Generated "${parsed.name}" via Copilot (${parsed.steps.length} steps, triggers: ${parsed.triggerPhrases.slice(0, 2).join(", ")}).`,
        };
      }
    } catch {
      // Fall back to deterministic synthesizer
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onParentAbort);
    }
  }
  const definition = synthesizeWorkflowFromPrompt(prompt, connectors);
  return {
    definition,
    generatedBy: "synthesizer",
    summary: `Generated "${definition.name}" (${definition.steps.length} steps). Review or click Save Workflow to activate live.`,
  };
}
