import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { knowledgeDocumentUpsertSchema, type KnowledgeDocumentUpsertInput } from "../../packages/contracts/knowledge-base";
import {
  verticalPackRecordSchema,
  type VerticalPackRecord,
  type VerticalPacksView,
  type VerticalScreenContext,
} from "../../packages/contracts/vertical-pack";
import { workflowDefinitionUpsertSchema, type WorkflowDefinitionUpsertInput } from "../../packages/contracts/workflow-definition";
import type { ExternalConnector } from "../../packages/contracts/connector";
import { callConfiguredLlmJson } from "./dynamic-ui-generator";
import type { GatewaySettings } from "./gateway";
import type { KnowledgeBaseStore } from "./knowledge-base";
import type { WorkflowEngine } from "./workflow-engine";
import { generateWorkflowWithLlm } from "./workflow-generator";

function slugId(raw: string, fallback: string): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36);
  return /^[a-z0-9][a-z0-9_-]{1,47}$/.test(s) ? s : fallback;
}

function safeColor(raw: unknown, fallback: string): string {
  return typeof raw === "string" && /^#[0-9a-fA-F]{3,8}$/.test(raw.trim()) ? raw.trim() : fallback;
}

interface VerticalBlueprint {
  id: string;
  name: string;
  industry: string;
  brandTitle: string;
  portalName: string;
  portalSubtitle: string;
  accentColor: string;
  domain: "wealth" | "operations" | "sales" | "general";
  guardrailLabel: string;
  composerPlaceholder: string;
  policyDoc: KnowledgeDocumentUpsertInput;
  workflow: WorkflowDefinitionUpsertInput;
  screenViews: VerticalScreenContext[];
  quickPrompts: { label: string; prompt: string }[];
}

export const verticalPackDraftSchema = z.object({
  blueprint: verticalPackRecordSchema.omit({
    policyDocId: true, policyTitle: true, workflowId: true, workflowName: true,
    workflowTriggerPhrase: true, createdAt: true, generatedBy: true,
  }).extend({
    policyDoc: knowledgeDocumentUpsertSchema,
    workflow: workflowDefinitionUpsertSchema,
  }),
  generatedBy: z.enum(["copilot_llm", "synthesizer"]),
}).strict();

type VerticalPackDraft = z.input<typeof verticalPackDraftSchema>;

function synthesizeBlueprint(prompt: string): VerticalBlueprint {
  const lower = prompt.toLowerCase();

  if (/\b(health|medical|clinical|prior[\s-]*auth|patient|hospital|payer|claim.*medical)\b/i.test(lower)) {
    const id = "healthcare_prior_auth";
    return {
      id,
      name: "Healthcare Prior-Authorization Suite",
      industry: "Healthcare & Payer Operations",
      brandTitle: "Aegis Clinical Concierge",
      portalName: "Aegis Health Provider Portal",
      portalSubtitle: "Clinical Prior-Authorization · Medical Director HITL · CMS Policy RAG",
      accentColor: "#0f766e",
      domain: "general",
      guardrailLabel: "CEP Clinical Compliance & HIPAA Guardrails Active",
      composerPlaceholder: "Ask clinical policy rules or launch a prior-authorization workflow...",
      policyDoc: {
        id: "clinical_prior_auth_policy",
        title: "Clinical Prior-Authorization & Medical Necessity Policy",
        domain: "general",
        version: "2.1",
        tags: ["prior-auth", "healthcare", "clinical", "medical-director", "cms", "imaging"],
        enabled: true,
        content: [
          "Section 1 — Automated Clinical Approval Threshold: Outpatient diagnostic imaging and procedures under $5,000 meeting NCCN/CMS medical necessity criteria may be auto-approved within 15 seconds with full clinical audit trail.",
          "Section 2 — Medical Director HITL Escalation (> $5,000): Any surgical procedure, specialty biologic infusion, or inpatient authorization exceeding $5,000 MUST pause for SHA-256 signed Medical Director review prior to issuing an authorization number.",
          "Section 3 — Urgent Turnaround SLA: Expedited clinical requests carry a mandatory 24-hour SLA determination window and must cite the exact CPT code and clinical guideline section.",
        ].join("\n\n"),
      },
      workflow: {
        id: "prior_auth_adjudication",
        name: "Clinical Prior-Authorization Workflow",
        domain: "general",
        version: "1.0.0",
        description: "Collects patient CPT procedure and cost, runs automated clinical criteria check, gates >$5,000 for Medical Director HITL sign-off, issues auth ID, and syncs provider EHR portal.",
        triggerPhrases: ["prior authorization", "start prior auth", "submit prior auth workflow", "authorize procedure"],
        enabled: true,
        steps: [
          {
            id: "collect_clinical_case",
            type: "collect_input",
            title: "Collect Prior-Auth Case Details",
            submitLabel: "Run Clinical Criteria Check",
            fields: [
              { id: "memberId", label: "Member / Patient ID", type: "text", required: true, defaultValue: "MBR-409218" },
              { id: "procedureName", label: "CPT Procedure / Therapy", type: "text", required: true, defaultValue: "CPT 70553 · Brain MRI w/ Contrast" },
              { id: "estimatedCostUsd", label: "Estimated Cost ($ USD)", type: "currency", required: true, defaultValue: 7400 },
              { id: "urgentCase", label: "Expedited 24-Hour Clinical SLA", type: "checkbox", defaultValue: true },
            ],
          },
          {
            id: "clinical_criteria_check",
            type: "compute",
            title: "CMS / NCCN Medical Necessity Pre-Check",
            evaluator: "template_summary",
            outputTemplate: "Verified active eligibility for {{inputs.memberId}} · {{inputs.procedureName}} (${{inputs.estimatedCostUsd}}) matches CMS clinical criteria.",
          },
          {
            id: "medical_director_gate",
            type: "hitl_approval",
            title: "Medical Director Clinical Sign-Off (> $5k)",
            when: { field: "inputs.estimatedCostUsd", op: "gt", value: 5000 },
            riskLevel: "high",
            dualControl: false,
            approvalTitleTemplate: "Prior-Auth Sign-Off · {{inputs.memberId}} (${{inputs.estimatedCostUsd}})",
            approvalSummaryTemplate: "{{inputs.procedureName}} exceeds $5,000 auto-approval threshold and requires Medical Director sign-off.",
            approveLabel: "Approve Authorization",
            rejectLabel: "Pend for Peer Review",
          },
          {
            id: "issue_auth_code",
            type: "async_job",
            title: "Payer Clearinghouse Auth Issuance",
            durationSeconds: 4,
            cancellable: true,
            runningLabel: "Issuing EDI-278 authorization for {{inputs.memberId}}...",
            completedTemplate: "Authorization Issued · #AUTH-{{computed.confirmationCode}} · Approved {{inputs.procedureName}} (${{inputs.estimatedCostUsd}}).",
          },
          {
            id: "sync_ehr_portal",
            type: "emit_host_event",
            title: "Sync Provider EHR Portal",
            eventName: "cep:workflow_completed",
            messageTemplate: "Pushed #AUTH-{{computed.confirmationCode}} to provider EHR portal.",
          },
        ],
      },
      screenViews: [
        {
          id: "pa_case_7400",
          label: "Prior-Auth Case #PA-8821 ($7,400)",
          viewType: "prior_auth_case",
          summary: "Member MBR-409218 · CPT 70553 Brain MRI w/ Contrast · Exceeds $5,000 auto-approval cap.",
          metrics: [
            { label: "Est. Cost", value: "$7,400" },
            { label: "SLA Window", value: "24h Urgent" },
            { label: "Policy Gate", value: "> $5k MD Review" },
          ],
          suggestedActions: [
            { label: "Start Prior-Auth Workflow ($7,400)", prompt: "start prior authorization" },
            { label: "Check Clinical Policy Rules", prompt: "What is our clinical prior authorization policy and medical director threshold?" },
          ],
          dataAttributes: { caseId: "PA-8821", memberId: "MBR-409218", estimatedCostUsd: 7400 },
        },
        {
          id: "pa_routine_1800",
          label: "Outpatient Echo #PA-8834 ($1,800)",
          viewType: "prior_auth_case",
          summary: "Routine transthoracic echocardiogram under $5,000 auto-approval threshold.",
          metrics: [
            { label: "Est. Cost", value: "$1,800" },
            { label: "Expected Path", value: "Auto-Approve" },
            { label: "Eligibility", value: "Verified" },
          ],
          suggestedActions: [
            { label: "Fast-Track Prior Auth", prompt: "start prior authorization" },
            { label: "Cite CMS Necessity Policy", prompt: "What is our clinical prior authorization policy?" },
          ],
          dataAttributes: { caseId: "PA-8834", estimatedCostUsd: 1800 },
        },
      ],
      quickPrompts: [
        { label: "Start Clinical Prior-Auth Workflow", prompt: "start prior authorization" },
        { label: "Check Medical Necessity Policy", prompt: "What is our clinical prior authorization policy and medical director threshold?" },
      ],
    };
  }

  if (/\b(real\s*estate|cre|underwrit|property|cap\s*rate|rent\s*roll|mortgage|commercial)\b/i.test(lower)) {
    const id = "cre_underwriting_desk";
    return {
      id,
      name: "Commercial Real Estate Underwriting",
      industry: "Commercial Real Estate & Lending",
      brandTitle: "Keystone CRE Copilot",
      portalName: "Keystone Capital Underwriting Desk",
      portalSubtitle: "CRE Debt Underwriting · Investment Committee HITL · DSCR Policy RAG",
      accentColor: "#7c3aed",
      domain: "wealth",
      guardrailLabel: "CEP Credit Committee & DSCR Underwriting Guardrails Active",
      composerPlaceholder: "Ask CRE underwriting guidelines or launch a deal IC workflow...",
      policyDoc: {
        id: "cre_underwriting_policy",
        title: "Commercial Real Estate DSCR & Investment Committee Policy",
        domain: "wealth",
        version: "3.0",
        tags: ["cre", "real-estate", "dscr", "ltv", "cap-rate", "underwriting", "ic"],
        enabled: true,
        content: [
          "Section 1 — Minimum DSCR & LTV Covenants: Multifamily and industrial loans require a minimum Debt Service Coverage Ratio (DSCR) of 1.25x and maximum Loan-to-Value (LTV) of 70%. Office assets require 1.35x DSCR and 60% max LTV.",
          "Section 2 — Investment Committee (IC) HITL Gate: Any commercial loan commitment above $1,000,000 MUST pause for SHA-256 Investment Committee sign-off before issuing a binding term sheet.",
          "Section 3 — Cap-Rate Stress Testing: Underwriting must model a +75 bps exit cap-rate shock and confirm positive debt yield above 8.5%.",
        ].join("\n\n"),
      },
      workflow: {
        id: "cre_term_sheet_workflow",
        name: "CRE Term Sheet & IC Approval Pipeline",
        domain: "wealth",
        version: "1.0.0",
        description: "Collects property NOI & loan request, evaluates DSCR covenants, gates >$1M for Investment Committee HITL, generates term sheet, and syncs deal portal.",
        triggerPhrases: ["underwrite property", "cre term sheet", "start cre underwriting", "commercial real estate workflow"],
        enabled: true,
        steps: [
          {
            id: "collect_property",
            type: "collect_input",
            title: "Property & Debt Structure",
            submitLabel: "Run DSCR Covenant Check",
            fields: [
              { id: "propertyName", label: "Property / Asset Name", type: "text", required: true, defaultValue: "Riverfront Logistics Park (Austin, TX)" },
              { id: "loanAmountUsd", label: "Loan Commitment ($ USD)", type: "currency", required: true, defaultValue: 2400000 },
              { id: "assetClass", label: "Asset Class", type: "select", options: ["Industrial", "Multifamily", "Office"], defaultValue: "Industrial" },
              { id: "runCapShock", label: "Run +75 bps Cap-Rate Stress Test", type: "checkbox", defaultValue: true },
            ],
          },
          {
            id: "dscr_screen",
            type: "compute",
            title: "DSCR & Cap-Rate Stress Screen",
            when: { field: "inputs.runCapShock", op: "truthy" },
            evaluator: "template_summary",
            outputTemplate: "{{inputs.propertyName}} ({{inputs.assetClass}}) passed +75 bps stress test · DSCR 1.38x (>1.25x floor) · Debt Yield 9.2%.",
          },
          {
            id: "ic_committee_gate",
            type: "hitl_approval",
            title: "Investment Committee Sign-Off (> $1M)",
            when: { field: "inputs.loanAmountUsd", op: "gt", value: 1000000 },
            riskLevel: "high",
            dualControl: false,
            approvalTitleTemplate: "IC Approval · {{inputs.propertyName}} (${{inputs.loanAmountUsd}})",
            approvalSummaryTemplate: "Commercial loan commitment exceeds $1,000,000 desk limit and requires Investment Committee SHA-256 sign-off.",
            approveLabel: "Approve Term Sheet",
            rejectLabel: "Decline Deal",
          },
          {
            id: "generate_termsheet",
            type: "async_job",
            title: "Term Sheet Generation & Registry Lock",
            durationSeconds: 4,
            cancellable: true,
            runningLabel: "Generating binding term sheet for {{inputs.propertyName}}...",
            completedTemplate: "Term Sheet Issued · #CRE-{{computed.confirmationCode}} · ${{inputs.loanAmountUsd}} locked for {{inputs.propertyName}}.",
          },
          {
            id: "sync_cre_portal",
            type: "emit_host_event",
            title: "Sync Underwriting Portal",
            eventName: "cep:workflow_completed",
            messageTemplate: "Broadcasted term sheet #CRE-{{computed.confirmationCode}} to Keystone Portal.",
          },
        ],
      },
      screenViews: [
        {
          id: "cre_riverfront",
          label: "Riverfront Logistics ($2.4M Debt)",
          viewType: "cre_deal",
          summary: "Industrial 145k sq ft · 97% occupied · DSCR 1.38x · Requires IC HITL approval.",
          metrics: [
            { label: "Loan Ask", value: "$2.4M" },
            { label: "DSCR", value: "1.38x" },
            { label: "Cap Rate", value: "6.4%" },
          ],
          suggestedActions: [
            { label: "Launch CRE Term Sheet Workflow", prompt: "start cre underwriting" },
            { label: "Check DSCR & IC Policy", prompt: "What is our CRE DSCR underwriting policy and IC threshold?" },
          ],
          dataAttributes: { asset: "Riverfront Logistics Park", loanAmountUsd: 2400000 },
        },
        {
          id: "cre_office_review",
          label: "Midtown Office Refi ($850k)",
          viewType: "cre_deal",
          summary: "Sub-$1M office bridge refinancing — verify 1.35x office DSCR covenant.",
          metrics: [
            { label: "Loan Ask", value: "$850k" },
            { label: "Max LTV", value: "60%" },
            { label: "Min DSCR", value: "1.35x" },
          ],
          suggestedActions: [
            { label: "Verify Office Covenant Policy", prompt: "What is our CRE DSCR underwriting policy?" },
            { label: "Run Underwriting Pipeline", prompt: "start cre underwriting" },
          ],
          dataAttributes: { asset: "Midtown Office", loanAmountUsd: 850000 },
        },
      ],
      quickPrompts: [
        { label: "Launch CRE Underwriting Workflow", prompt: "start cre underwriting" },
        { label: "Check CRE DSCR & IC Policy", prompt: "What is our CRE DSCR underwriting policy and IC threshold?" },
      ],
    };
  }

  const baseSlug = slugId(prompt.split(/\s+/).slice(0, 4).join("_"), `vertical_${Date.now().toString(36).slice(-4)}`);
  const cleanTitle = prompt.trim().slice(0, 48).replace(/[.?!]+$/, "");
  return {
    id: baseSlug,
    name: `${cleanTitle} Suite`.slice(0, 76),
    industry: "Enterprise Operations",
    brandTitle: "Apex Vertical Concierge",
    portalName: `${cleanTitle} Portal`.slice(0, 76),
    portalSubtitle: "AI-Generated Vertical Pack · Policy RAG · Governed Workflow DAG",
    accentColor: "#0284c7",
    domain: "general",
    guardrailLabel: "CEP Vertical Governance & SHA-256 HITL Guardrails Active",
    composerPlaceholder: `Ask policy questions or trigger ${cleanTitle} workflows...`,
    policyDoc: {
      id: `${baseSlug}_policy`,
      title: `${cleanTitle} Governance & Approval Policy`.slice(0, 100),
      domain: "general",
      version: "1.0",
      tags: ["policy", "vertical", baseSlug],
      enabled: true,
      content: [
        `Section 1 — Automated Processing Cap: Standard ${cleanTitle} requests up to $5,000 may settle automatically once required inputs are validated.`,
        `Section 2 — Mandatory HITL Compliance Gate: Requests exceeding $5,000 MUST pause for SHA-256 digest-bound human approval prior to execution.`,
        `Section 3 — Audit & Host Sync: Every completed case is recorded in immutable audit logs and emitted to the embedding host portal via cep:workflow_completed.`,
      ].join("\n\n"),
    },
    workflow: {
      id: `${baseSlug}_workflow`,
      name: `${cleanTitle} Approval Pipeline`.slice(0, 76),
      domain: "general",
      version: "1.0.0",
      description: `Governed multi-step workflow generated for: ${prompt.slice(0, 180)}`,
      triggerPhrases: [`start ${baseSlug.replace(/_/g, " ")}`, `run ${cleanTitle.toLowerCase()}`, "start vertical workflow"],
      enabled: true,
      steps: [
        {
          id: "collect_case",
          type: "collect_input",
          title: "Collect Case Details",
          submitLabel: "Validate & Continue",
          fields: [
            { id: "caseSubject", label: "Case / Account Reference", type: "text", required: true, defaultValue: "CASE-2026-104" },
            { id: "amountUsd", label: "Value ($ USD)", type: "currency", required: true, defaultValue: 8500 },
            { id: "runCompliance", label: "Run Automated Policy Pre-Check", type: "checkbox", defaultValue: true },
          ],
        },
        {
          id: "policy_check",
          type: "compute",
          title: "Automated Policy Pre-Check",
          when: { field: "inputs.runCompliance", op: "truthy" },
          evaluator: "template_summary",
          outputTemplate: "Case {{inputs.caseSubject}} (${{inputs.amountUsd}}) passed automated compliance validation.",
        },
        {
          id: "approval_gate",
          type: "hitl_approval",
          title: "Supervisor HITL Gate (> $5,000)",
          when: { field: "inputs.amountUsd", op: "gt", value: 5000 },
          riskLevel: "high",
          dualControl: false,
          approvalTitleTemplate: "Approve {{inputs.caseSubject}} (${{inputs.amountUsd}})",
          approvalSummaryTemplate: "Exceeds $5,000 automated limit; SHA-256 digest locked for supervisor approval.",
          approveLabel: "Approve & Execute",
          rejectLabel: "Reject",
        },
        {
          id: "execute_settlement",
          type: "async_job",
          title: "Fulfillment & Ledger Posting",
          durationSeconds: 4,
          cancellable: true,
          runningLabel: "Processing {{inputs.caseSubject}}...",
          completedTemplate: "Completed {{inputs.caseSubject}} (#REF-{{computed.confirmationCode}}).",
        },
        {
          id: "sync_portal",
          type: "emit_host_event",
          title: "Notify Embedding Host Portal",
          eventName: "cep:workflow_completed",
          messageTemplate: "Emitted cep:workflow_completed for {{inputs.caseSubject}}.",
        },
      ],
    },
    screenViews: [
      {
        id: "active_case_1",
        label: "Active Case #CASE-2026-104 ($8,500)",
        viewType: "vertical_case",
        summary: `High-value ${cleanTitle} case currently awaiting compliance review and approval.`,
        metrics: [
          { label: "Case Value", value: "$8,500" },
          { label: "Gate", value: "> $5k HITL" },
          { label: "Status", value: "Ready" },
        ],
        suggestedActions: [
          { label: "Start Governed Workflow", prompt: "start vertical workflow" },
          { label: "Check Policy Rules", prompt: `What is our ${cleanTitle} governance policy?` },
        ],
        dataAttributes: { caseId: "CASE-2026-104", amountUsd: 8500 },
      },
    ],
    quickPrompts: [
      { label: "Start Governed Workflow", prompt: "start vertical workflow" },
      { label: "Check Vertical Policy", prompt: `What is our ${cleanTitle} governance policy?` },
    ],
  };
}

const verticalMetaSystemPrompt = [
  "You are CEP Vertical Pack Factory Copilot. Given an industry prompt, return ONE JSON object describing the white-label vertical portal branding, policy document, and 2 host screen views:",
  JSON.stringify({
    id: "snake_case_id",
    name: "Vertical Pack Name",
    industry: "Industry Name",
    brandTitle: "Concierge Assistant Name",
    portalName: "Fictional Host Portal Name",
    portalSubtitle: "Short subtitle",
    accentColor: "#0f766e",
    domain: "wealth | operations | sales | general",
    guardrailLabel: "CEP <Industry> Guardrails Active",
    composerPlaceholder: "Ask policy rules or start a workflow...",
    policyTitle: "Policy Document Title",
    policyTags: ["tag1", "tag2", "tag3"],
    policySections: [
      "Section 1 — Automated Threshold: ...",
      "Section 2 — Mandatory HITL Approval Gate: ...",
      "Section 3 — SLA & Audit Requirements: ...",
    ],
    screenViews: [
      {
        id: "view_1",
        label: "Case #101 ($7,500)",
        viewType: "case_detail",
        summary: "1-sentence summary of what user is viewing on host screen",
        metrics: [{ label: "Amount", value: "$7,500" }, { label: "Status", value: "Review" }],
        suggestedActions: [{ label: "Run Workflow", prompt: "trigger phrase" }, { label: "Check Policy", prompt: "What is our policy?" }],
      },
    ],
  }),
  "Do not use any real external brokerage/company trademarks. Return ONLY valid JSON.",
].join("\n");

export class VerticalPackStore {
  private readonly filePath: string;
  private packs: VerticalPackRecord[];

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "vertical-packs.json");
    this.packs = this.load();
  }

  private load(): VerticalPackRecord[] {
    if (existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
        if (Array.isArray(raw)) {
          return raw
            .map((item) => verticalPackRecordSchema.safeParse(item))
            .filter((res): res is { success: true; data: VerticalPackRecord } => res.success)
            .map((res) => res.data);
        }
      } catch { /* fall through */ }
    }
    return [];
  }

  private save(next: VerticalPackRecord[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(next.slice(0, 20), null, 2), "utf8");
    this.packs = next.slice(0, 20);
  }

  view(): VerticalPacksView {
    return { packs: this.packs.map((p) => structuredClone(p)) };
  }

  getPack(id: string): VerticalPackRecord | undefined {
    const found = this.packs.find((p) => p.id === id);
    return found ? structuredClone(found) : undefined;
  }

  deletePack(id: string): VerticalPacksView {
    this.save(this.packs.filter((p) => p.id !== id));
    return this.view();
  }

  async generateDraft(input: {
    prompt: string;
    gateway: GatewaySettings | null | undefined;
    dataDir: string;
    connectors: ExternalConnector[];
  }): Promise<VerticalPackDraft> {
    const fallback = synthesizeBlueprint(input.prompt);
    let blueprint = fallback;
    let generatedBy: VerticalPackDraft["generatedBy"] = "synthesizer";

    if (input.gateway) {
      try {
        const [metaRaw, wfRes] = await Promise.all([
          callConfiguredLlmJson(input.gateway, input.dataDir, verticalMetaSystemPrompt, input.prompt, AbortSignal.timeout(16_000)),
          generateWorkflowWithLlm({
            prompt: input.prompt,
            gateway: input.gateway,
            dataDir: input.dataDir,
            connectors: input.connectors,
          }),
        ]);
        if (metaRaw && typeof metaRaw === "object") {
          const m = metaRaw as Record<string, unknown>;
          const id = slugId(String(m.id ?? m.name ?? fallback.id), fallback.id);
          const wfDef = wfRes.definition;
          const primaryTrigger = wfDef.triggerPhrases[0] ?? fallback.workflow.triggerPhrases[0];
          const policyTitle = typeof m.policyTitle === "string" && m.policyTitle.trim() ? m.policyTitle.trim().slice(0, 100) : fallback.policyDoc.title;
          const sections = Array.isArray(m.policySections)
            ? m.policySections.map((s) => String(s).trim()).filter((s) => s.length >= 20)
            : [];
          const rawViews = Array.isArray(m.screenViews) ? m.screenViews : [];
          const views: VerticalScreenContext[] = rawViews
            .slice(0, 3)
            .map((v, idx): VerticalScreenContext | null => {
              if (!v || typeof v !== "object") return null;
              const vo = v as Record<string, unknown>;
              const metrics = Array.isArray(vo.metrics)
                ? vo.metrics.slice(0, 3).map((mt) => ({
                    label: String((mt as Record<string, unknown>).label ?? "Metric").slice(0, 38),
                    value: String((mt as Record<string, unknown>).value ?? "—").slice(0, 44),
                  }))
                : [{ label: "Status", value: "Active" }];
              return {
                id: slugId(String(vo.id ?? `view_${idx + 1}`), `view_${idx + 1}`),
                label: String(vo.label ?? `Case #${idx + 1}`).slice(0, 70),
                viewType: String(vo.viewType ?? "case_detail").slice(0, 44),
                summary: String(vo.summary ?? input.prompt).slice(0, 230),
                metrics,
                suggestedActions: [
                  { label: `Start ${wfDef.name}`.slice(0, 54), prompt: primaryTrigger },
                  { label: `Check ${policyTitle}`.slice(0, 54), prompt: `What is our ${policyTitle} policy?`.slice(0, 200) },
                ],
                dataAttributes: { vertical: id, viewIndex: idx + 1 },
              };
            })
            .filter((x): x is VerticalScreenContext => Boolean(x));

          blueprint = {
            id,
            name: typeof m.name === "string" && m.name.trim() ? m.name.trim().slice(0, 78) : fallback.name,
            industry: typeof m.industry === "string" && m.industry.trim() ? m.industry.trim().slice(0, 58) : fallback.industry,
            brandTitle: typeof m.brandTitle === "string" && m.brandTitle.trim() ? m.brandTitle.trim().slice(0, 58) : fallback.brandTitle,
            portalName: typeof m.portalName === "string" && m.portalName.trim() ? m.portalName.trim().slice(0, 78) : fallback.portalName,
            portalSubtitle: typeof m.portalSubtitle === "string" && m.portalSubtitle.trim() ? m.portalSubtitle.trim().slice(0, 155) : fallback.portalSubtitle,
            accentColor: safeColor(m.accentColor, fallback.accentColor),
            domain: wfDef.domain,
            guardrailLabel: typeof m.guardrailLabel === "string" && m.guardrailLabel.trim() ? m.guardrailLabel.trim().slice(0, 88) : fallback.guardrailLabel,
            composerPlaceholder: typeof m.composerPlaceholder === "string" && m.composerPlaceholder.trim() ? m.composerPlaceholder.trim().slice(0, 118) : fallback.composerPlaceholder,
            policyDoc: {
              id: `${id}_policy`.slice(0, 46),
              title: policyTitle,
              domain: wfDef.domain,
              version: "1.0",
              tags: Array.isArray(m.policyTags) ? m.policyTags.map((t) => String(t).slice(0, 30)).filter(Boolean).slice(0, 8) : fallback.policyDoc.tags,
              content: sections.length >= 2 ? sections.join("\n\n").slice(0, 10_000) : fallback.policyDoc.content,
              enabled: true,
            },
            workflow: wfDef,
            screenViews: views.length > 0 ? views : fallback.screenViews,
            quickPrompts: [
              { label: `Start ${wfDef.name}`.slice(0, 62), prompt: primaryTrigger },
              { label: `Cite ${policyTitle}`.slice(0, 62), prompt: `What is our ${policyTitle} policy?`.slice(0, 200) },
            ],
          };
          generatedBy = "copilot_llm";
        }
      } catch {
        // Fall back cleanly to deterministic vertical synthesizer
      }
    }

    return verticalPackDraftSchema.parse({ blueprint, generatedBy });
  }

  installDraft(draft: VerticalPackDraft, input: {
    knowledgeBase: KnowledgeBaseStore;
    workflowEngine: WorkflowEngine;
  }): { pack: VerticalPackRecord; embedDemoUrl: string; view: VerticalPacksView } {
    const { blueprint, generatedBy } = verticalPackDraftSchema.parse(draft);
    input.knowledgeBase.upsert(blueprint.policyDoc);
    input.workflowEngine.upsertDefinition(blueprint.workflow);

    const record: VerticalPackRecord = {
      id: blueprint.id,
      name: blueprint.name,
      industry: blueprint.industry,
      brandTitle: blueprint.brandTitle,
      portalName: blueprint.portalName,
      portalSubtitle: blueprint.portalSubtitle,
      accentColor: blueprint.accentColor,
      domain: blueprint.domain,
      guardrailLabel: blueprint.guardrailLabel,
      composerPlaceholder: blueprint.composerPlaceholder,
      policyDocId: blueprint.policyDoc.id,
      policyTitle: blueprint.policyDoc.title,
      workflowId: blueprint.workflow.id,
      workflowName: blueprint.workflow.name,
      workflowTriggerPhrase: blueprint.workflow.triggerPhrases[0] ?? blueprint.workflow.name,
      screenViews: blueprint.screenViews,
      quickPrompts: blueprint.quickPrompts,
      generatedBy,
      createdAt: new Date().toISOString(),
    };

    const next = [record, ...this.packs.filter((p) => p.id !== record.id)];
    this.save(next);
    return {
      pack: record,
      embedDemoUrl: `/embed-demo?vertical=${encodeURIComponent(record.id)}`,
      view: this.view(),
    };
  }
}
