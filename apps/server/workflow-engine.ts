import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  workflowDefinitionSchema,
  workflowDefinitionUpsertSchema,
  workflowRunSchema,
  type WorkflowCondition,
  type WorkflowDefinition,
  type WorkflowDefinitionUpsertInput,
  type WorkflowRun,
  type WorkflowStep,
  type WorkflowStepRun,
  type WorkflowsAdminView,
} from "../../packages/contracts/workflow-definition";
import { makeId } from "../../packages/experience/compile";
import type { ApprovalStore } from "./approval-store";
import type { ConnectorStore } from "./connector-store";
import type { IntegrationTaskService } from "./integration-tasks";
import type { TaskRun } from "../../packages/contracts/integration-task";

export function defaultWorkflowDefinitions(nowIso: string): WorkflowDefinition[] {
  return [
    {
      id: "wire_transfer_governed",
      name: "Governed Wire Transfer Pipeline",
      domain: "wealth",
      version: "1.0.0",
      description: "Multi-step wire transfer workflow with optional OFAC screening, automatic HITL approval gate above $10,000, cancellable clearinghouse timer, and host portal event sync.",
      triggerPhrases: ["wire transfer", "send a wire", "initiate wire", "run wire workflow", "international wire", "wire $", "wire money"],
      enabled: true,
      isBuiltIn: true,
      updatedAt: nowIso,
      steps: [
        {
          id: "collect_wire_details",
          type: "collect_input",
          title: "Collect Wire Transfer Details",
          description: "Enter recipient, dollar amount, rail, and screening preference.",
          submitLabel: "Validate & Continue",
          fields: [
            { id: "recipientName", label: "Recipient / Beneficiary", type: "text", required: true, defaultValue: "Meridian Escrow Trust LLC" },
            { id: "amountUsd", label: "Wire Amount ($ USD)", type: "currency", required: true, defaultValue: 15000 },
            { id: "rail", label: "Settlement Rail", type: "select", options: ["Domestic Fedwire", "International SWIFT"], defaultValue: "Domestic Fedwire" },
            { id: "runFraudScreen", label: "Run Pre-Flight OFAC & Velocity Screening", type: "checkbox", defaultValue: true },
          ],
        },
        {
          id: "ofac_screening",
          type: "compute",
          title: "OFAC & Velocity Pre-Flight Screen",
          description: "Runs only if pre-flight screening is checked.",
          when: { field: "inputs.runFraudScreen", op: "truthy" },
          evaluator: "ofac_velocity_screen",
          outputTemplate: "OFAC & Velocity passed for {{inputs.recipientName}} (${{inputs.amountUsd}} via {{inputs.rail}}) · Risk score: {{computed.riskScore}}/100 ({{computed.riskBand}}).",
        },
        {
          id: "high_value_approval",
          type: "hitl_approval",
          title: "High-Value Wire Compliance Gate (> $10k)",
          description: "Automatically triggers SHA-256 digest-locked HITL approval + Slack/Teams alert when wire exceeds $10,000.",
          when: { field: "inputs.amountUsd", op: "gt", value: 10000 },
          riskLevel: "high",
          dualControl: false,
          approvalTitleTemplate: "Wire Approval · ${{inputs.amountUsd}} to {{inputs.recipientName}}",
          approvalSummaryTemplate: "Governed wire transfer via {{inputs.rail}} exceeds the $10,000 automated limit. SHA-256 payload digest locked prior to clearinghouse dispatch.",
          approveLabel: "Approve Wire & Settle",
          rejectLabel: "Block Wire",
        },
        {
          id: "clearinghouse_settlement",
          type: "async_job",
          title: "Clearinghouse Settlement Window",
          description: "Simulated Fedwire/SWIFT dispatch with mid-flight cancel window.",
          durationSeconds: 4,
          cancellable: true,
          runningLabel: "Transmitting ${{inputs.amountUsd}} wire to {{inputs.recipientName}} via {{inputs.rail}}...",
          completedTemplate: "Wire settled · Confirmation #FED-{{computed.confirmationCode}} · ${{inputs.amountUsd}} dispatched to {{inputs.recipientName}}.",
        },
        {
          id: "sync_host_portal",
          type: "emit_host_event",
          title: "Notify Embedding Host Portal",
          description: "Emits postMessage event back to any host app embedding <cep-assistant>.",
          eventName: "cep:workflow_completed",
          messageTemplate: "Dispatched cep:workflow_completed to host portal for wire #FED-{{computed.confirmationCode}}.",
        },
      ],
    },
    {
      id: "loan_origination_fasttrack",
      name: "Portfolio Credit Line Origination",
      domain: "wealth",
      version: "1.0.0",
      description: "Declarative lending workflow: collect loan parameters, run deterministic underwriting & APR calculation, gate >$25k for Credit Committee HITL, and post disbursal.",
      triggerPhrases: ["apply for a loan", "margin loan workflow", "start loan origination", "portfolio credit line"],
      enabled: true,
      isBuiltIn: true,
      updatedAt: nowIso,
      steps: [
        {
          id: "collect_loan_terms",
          type: "collect_input",
          title: "Loan Application Inputs",
          submitLabel: "Run Underwriting",
          fields: [
            { id: "loanAmountUsd", label: "Requested Amount ($ USD)", type: "currency", required: true, defaultValue: 30000 },
            { id: "termMonths", label: "Repayment Term", type: "select", options: ["12", "24", "36"], defaultValue: "24" },
            { id: "purpose", label: "Use of Proceeds", type: "select", options: ["Bridge Liquidity", "Real Estate Down Payment", "Tax Payment"], defaultValue: "Bridge Liquidity" },
          ],
        },
        {
          id: "underwriting_calc",
          type: "compute",
          title: "Automated Underwriting & APR Pricing",
          evaluator: "loan_underwriting",
          outputTemplate: "Underwriting approved · ${{inputs.loanAmountUsd}} over {{inputs.termMonths}} mo at {{computed.aprPct}}% APR (~${{computed.monthlyPaymentUsd}}/mo est.).",
        },
        {
          id: "credit_committee_gate",
          type: "hitl_approval",
          title: "Credit Committee Sign-Off (> $25k)",
          when: { field: "inputs.loanAmountUsd", op: "gt", value: 25000 },
          riskLevel: "high",
          dualControl: false,
          approvalTitleTemplate: "Credit Line Approval · ${{inputs.loanAmountUsd}} ({{inputs.purpose}})",
          approvalSummaryTemplate: "Requested credit line of ${{inputs.loanAmountUsd}} at {{computed.aprPct}}% APR exceeds $25,000 instant-approval cap.",
          approveLabel: "Approve Credit Line",
          rejectLabel: "Decline Application",
        },
        {
          id: "disburse_credit",
          type: "async_job",
          title: "Ledger Posting & Funding Disbursal",
          durationSeconds: 4,
          cancellable: true,
          runningLabel: "Booking ${{inputs.loanAmountUsd}} credit facility at {{computed.aprPct}}% APR...",
          completedTemplate: "Credit facility active · ${{inputs.loanAmountUsd}} funded for {{inputs.purpose}}.",
        },
        {
          id: "emit_loan_sync",
          type: "emit_host_event",
          title: "Sync Host App Credit Ledger",
          eventName: "cep:workflow_completed",
          messageTemplate: "Emitted cep:workflow_completed with approved credit facility details.",
        },
      ],
    },
    {
      id: "incident_change_pipeline",
      name: "Production Hotfix & PagerDuty Pipeline",
      domain: "operations",
      version: "1.0.0",
      description: "Multi-stage SRE workflow with conditional Global blast-radius HITL gate, optional PagerDuty webhook invocation, and canary verification timer.",
      triggerPhrases: ["production change workflow", "deploy hotfix workflow", "multi-stage rollback pipeline", "run sre change workflow"],
      enabled: true,
      isBuiltIn: true,
      updatedAt: nowIso,
      steps: [
        {
          id: "collect_change_spec",
          type: "collect_input",
          title: "Change Specification",
          submitLabel: "Evaluate Change Risk",
          fields: [
            { id: "serviceName", label: "Target Service", type: "text", required: true, defaultValue: "payments-gateway" },
            { id: "targetRelease", label: "Target Release Tag", type: "text", required: true, defaultValue: "v4.12.2-hotfix" },
            { id: "blastRadius", label: "Blast Radius", type: "select", options: ["Single Region", "Global"], defaultValue: "Global" },
            { id: "notifyPagerDuty", label: "Page On-Call SRE via PagerDuty Connector", type: "checkbox", defaultValue: true },
          ],
        },
        {
          id: "global_change_gate",
          type: "hitl_approval",
          title: "Global Blast-Radius Change Gate",
          when: { field: "inputs.blastRadius", op: "eq", value: "Global" },
          riskLevel: "high",
          dualControl: false,
          approvalTitleTemplate: "Global Hotfix Approval · {{inputs.serviceName}} → {{inputs.targetRelease}}",
          approvalSummaryTemplate: "Global blast-radius deployment requires explicit change-control sign-off before PagerDuty & canary rollout.",
          approveLabel: "Approve Rollout",
          rejectLabel: "Halt Deployment",
        },
        {
          id: "pagerduty_notify",
          type: "connector_call",
          title: "Dispatch PagerDuty Escalation Webhook",
          when: { field: "inputs.notifyPagerDuty", op: "truthy" },
          connectorId: "pagerduty_incident_webhook",
          action: "workflow_change_notice",
          noteTemplate: "Rolling {{inputs.serviceName}} to {{inputs.targetRelease}} ({{inputs.blastRadius}})",
        },
        {
          id: "canary_timer",
          type: "async_job",
          title: "Canary Health & Error-Rate Verification",
          durationSeconds: 4,
          cancellable: true,
          runningLabel: "Verifying canary telemetry for {{inputs.serviceName}} ({{inputs.targetRelease}})...",
          completedTemplate: "Canary healthy (p95 42ms, 0.01% errors) · {{inputs.serviceName}} promoted to {{inputs.targetRelease}}.",
        },
        {
          id: "emit_ops_done",
          type: "emit_host_event",
          title: "Emit Ops Pipeline Completion",
          eventName: "cep:workflow_completed",
          messageTemplate: "Broadcasted deployment completion for {{inputs.serviceName}} ({{inputs.targetRelease}}).",
        },
      ],
    },
  ];
}

function resolvePath(path: string, run: WorkflowRun): unknown {
  const [scope, key] = path.split(".");
  if (scope === "inputs" && key) return run.inputs[key];
  if (scope === "computed" && key) return run.computed[key];
  if (key === undefined) return run.inputs[path] ?? run.computed[path];
  return undefined;
}

function evaluateCondition(cond: WorkflowCondition, run: WorkflowRun): { matched: boolean; reason: string } {
  const raw = resolvePath(cond.field, run);
  const numRaw = typeof raw === "number" ? raw : Number(raw);
  const numVal = typeof cond.value === "number" ? cond.value : Number(cond.value);
  let matched = false;
  switch (cond.op) {
    case "truthy":
      matched = raw === true || raw === "true" || (typeof raw === "number" && raw > 0) || (typeof raw === "string" && raw.length > 0 && raw !== "false" && raw !== "0");
      break;
    case "falsy":
      matched = !raw || raw === "false" || raw === "0";
      break;
    case "eq":
      matched = String(raw ?? "").toLowerCase() === String(cond.value ?? "").toLowerCase();
      break;
    case "neq":
      matched = String(raw ?? "").toLowerCase() !== String(cond.value ?? "").toLowerCase();
      break;
    case "gt":
      matched = Number.isFinite(numRaw) && Number.isFinite(numVal) && numRaw > numVal;
      break;
    case "gte":
      matched = Number.isFinite(numRaw) && Number.isFinite(numVal) && numRaw >= numVal;
      break;
    case "lt":
      matched = Number.isFinite(numRaw) && Number.isFinite(numVal) && numRaw < numVal;
      break;
    case "lte":
      matched = Number.isFinite(numRaw) && Number.isFinite(numVal) && numRaw <= numVal;
      break;
    case "contains":
      matched = String(raw ?? "").toLowerCase().includes(String(cond.value ?? "").toLowerCase());
      break;
  }
  const displayRaw = raw === undefined ? "unset" : String(raw);
  const reason = cond.value !== undefined
    ? `${cond.field} (${displayRaw}) ${cond.op} ${String(cond.value)}`
    : `${cond.field} (${displayRaw}) is ${cond.op}`;
  return { matched, reason };
}

function interpolate(template: string, run: WorkflowRun): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, path: string) => {
    const val = resolvePath(path, run);
    if (val === undefined || val === null) return "—";
    if (typeof val === "number") return val.toLocaleString("en-US");
    return String(val);
  });
}

export class WorkflowEngine {
  private readonly defsPath: string;
  private readonly runsPath: string;
  private definitions: WorkflowDefinition[];
  private runs: WorkflowRun[];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Map<string, Set<(run: WorkflowRun) => void>>();

  constructor(
    dataDir: string,
    private readonly deps: {
      approvalStore: ApprovalStore;
      connectorStore: ConnectorStore;
      integrationService?: IntegrationTaskService;
    },
  ) {
    this.defsPath = join(dataDir, "workflows.json");
    this.runsPath = join(dataDir, "workflow-runs.json");
    this.definitions = this.loadDefinitions();
    this.runs = this.loadRuns();
  }

  private loadDefinitions(): WorkflowDefinition[] {
    if (existsSync(this.defsPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.defsPath, "utf8")) as unknown;
        if (Array.isArray(raw)) {
          const valid = raw
            .map((item) => workflowDefinitionSchema.safeParse(item))
            .filter((res): res is { success: true; data: WorkflowDefinition } => res.success)
            .map((res) => res.data);
          if (valid.length > 0) return valid;
        }
      } catch { /* fall through */ }
    }
    const seeded = defaultWorkflowDefinitions(new Date().toISOString());
    this.saveDefinitions(seeded);
    return seeded;
  }

  private saveDefinitions(next: WorkflowDefinition[]): void {
    mkdirSync(dirname(this.defsPath), { recursive: true });
    writeFileSync(this.defsPath, JSON.stringify(next, null, 2), "utf8");
    this.definitions = next;
  }

  private loadRuns(): WorkflowRun[] {
    if (existsSync(this.runsPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.runsPath, "utf8")) as unknown;
        if (Array.isArray(raw)) {
          return raw
            .map((item) => workflowRunSchema.safeParse(item))
            .filter((res): res is { success: true; data: WorkflowRun } => res.success)
            .map((res) => res.data)
            .slice(0, 60);
        }
      } catch { /* fall through */ }
    }
    return [];
  }

  private saveRuns(next: WorkflowRun[]): void {
    mkdirSync(dirname(this.runsPath), { recursive: true });
    writeFileSync(this.runsPath, JSON.stringify(next.slice(0, 60), null, 2), "utf8");
    this.runs = next.slice(0, 60);
  }

  private emit(run: WorkflowRun): void {
    const subs = this.listeners.get(run.runId);
    if (!subs) return;
    for (const fn of subs) {
      try { fn(run); } catch { /* ignore subscriber error */ }
    }
  }

  subscribe(runId: string, listener: (run: WorkflowRun) => void): () => void {
    let subs = this.listeners.get(runId);
    if (!subs) {
      subs = new Set();
      this.listeners.set(runId, subs);
    }
    subs.add(listener);
    return () => {
      subs?.delete(listener);
      if (subs && subs.size === 0) this.listeners.delete(runId);
    };
  }

  listDefinitions(): WorkflowDefinition[] {
    return this.definitions.map((d) => structuredClone(d));
  }

  getDefinition(id: string): WorkflowDefinition | undefined {
    const found = this.definitions.find((d) => d.id === id);
    return found ? structuredClone(found) : undefined;
  }

  setIntegrationService(service: IntegrationTaskService): void {
    this.deps.integrationService = service;
  }

  view(): WorkflowsAdminView {
    return {
      definitions: this.listDefinitions(),
      recentRuns: this.runs.slice(0, 20).map((r) => structuredClone(r)),
    };
  }

  upsertDefinition(rawInput: WorkflowDefinitionUpsertInput): WorkflowsAdminView {
    const parsed = workflowDefinitionUpsertSchema.parse(rawInput);
    const existing = this.definitions.find((d) => d.id === parsed.id);
    const record: WorkflowDefinition = {
      ...parsed,
      ...(existing?.isBuiltIn ? { isBuiltIn: true } : {}),
      updatedAt: new Date().toISOString(),
    };
    const next = existing
      ? this.definitions.map((d) => (d.id === parsed.id ? record : d))
      : [record, ...this.definitions];
    this.saveDefinitions(next);
    return this.view();
  }

  deleteOrResetDefinition(id: string): WorkflowsAdminView {
    const builtIns = defaultWorkflowDefinitions(new Date().toISOString());
    const builtIn = builtIns.find((b) => b.id === id);
    if (builtIn) {
      const next = this.definitions.map((d) => (d.id === id ? builtIn : d));
      this.saveDefinitions(next);
    } else {
      this.saveDefinitions(this.definitions.filter((d) => d.id !== id));
    }
    return this.view();
  }

  matchPrompt(prompt: string): WorkflowDefinition | undefined {
    const lower = prompt.toLowerCase().trim();
    if (lower.length < 5) return undefined;
    for (const def of this.definitions) {
      if (!def.enabled) continue;
      if (lower.includes(def.name.toLowerCase())) return structuredClone(def);
      for (const phrase of def.triggerPhrases) {
        const p = phrase.toLowerCase().trim();
        if (p.length >= 4 && lower.includes(p)) return structuredClone(def);
      }
    }
    return undefined;
  }

  getRun(runId: string): WorkflowRun | undefined {
    const found = this.runs.find((r) => r.runId === runId);
    return found ? structuredClone(found) : undefined;
  }

  private persistRun(updated: WorkflowRun): WorkflowRun {
    updated.updatedAt = new Date().toISOString();
    const exists = this.runs.some((r) => r.runId === updated.runId);
    const next = exists
      ? this.runs.map((r) => (r.runId === updated.runId ? updated : r))
      : [updated, ...this.runs];
    this.saveRuns(next);
    const clone = structuredClone(updated);
    this.emit(clone);
    return clone;
  }

  async startRun(workflowId: string, context: {
    personaId: string;
    actorName: string;
    conversationId?: string;
    initialInputs?: Record<string, string | number | boolean>;
  }): Promise<{ run: WorkflowRun; definition: WorkflowDefinition }> {
    const def = this.getDefinition(workflowId);
    if (!def) throw new Error(`Workflow "${workflowId}" not found.`);
    const nowIso = new Date().toISOString();
    const run: WorkflowRun = {
      runId: makeId("wfr"),
      workflowId: def.id,
      workflowName: def.name,
      workflowVersion: def.version,
      domain: def.domain,
      personaId: context.personaId,
      actorName: context.actorName,
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
      status: "waiting_input",
      currentStepIndex: 0,
      inputs: { ...(context.initialInputs ?? {}) },
      computed: {
        confirmationCode: Math.floor(100000 + Math.random() * 900000).toString(),
      },
      steps: def.steps.map((s): WorkflowStepRun => ({
        stepId: s.id,
        title: s.title,
        type: s.type,
        status: "pending",
      })),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.persistRun(run);
    const advanced = await this.advance(run.runId);
    return { run: advanced, definition: def };
  }

  async submitInput(runId: string, submitted: Record<string, string | number | boolean>): Promise<WorkflowRun> {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Workflow run "${runId}" not found.`);
    if (run.status !== "waiting_input") return run;
    const def = this.getDefinition(run.workflowId);
    if (!def) throw new Error(`Workflow "${run.workflowId}" not found.`);
    const stepDef = def.steps[run.currentStepIndex];
    if (!stepDef || stepDef.type !== "collect_input") return run;

    for (const field of stepDef.fields) {
      const rawVal = submitted[field.id];
      if (field.type === "number" || field.type === "currency") {
        const num = Number(String(rawVal ?? field.defaultValue ?? 0).replace(/[^0-9.-]/g, ""));
        run.inputs[field.id] = Number.isFinite(num) ? num : 0;
      } else if (field.type === "checkbox") {
        run.inputs[field.id] = rawVal === true || rawVal === "true";
      } else {
        run.inputs[field.id] = String(rawVal ?? field.defaultValue ?? "").trim();
      }
    }

    const summaryParts = stepDef.fields.slice(0, 4).map((f) => {
      const v = run.inputs[f.id];
      if (f.type === "currency" && typeof v === "number") return `${f.label}: $${v.toLocaleString("en-US")}`;
      if (f.type === "checkbox") return `${f.label}: ${v ? "Yes" : "No"}`;
      return `${f.label}: ${String(v)}`;
    });

    run.steps[run.currentStepIndex] = {
      ...run.steps[run.currentStepIndex],
      status: "completed",
      summary: summaryParts.join(" · "),
      finishedAt: new Date().toISOString(),
    };
    run.currentStepIndex += 1;
    this.persistRun(run);
    return this.advance(run.runId);
  }

  async resumeAfterApproval(
    runId: string,
    approvalId: string,
    approved: boolean,
    actor: string,
    note?: string,
  ): Promise<WorkflowRun | undefined> {
    const run = this.getRun(runId);
    if (!run) return undefined;
    const stepIdx = run.steps.findIndex((s) => s.approvalId === approvalId);
    if (stepIdx < 0) return run;

    if (!approved) {
      run.steps[stepIdx] = {
        ...run.steps[stepIdx],
        status: "failed",
        summary: `Rejected by ${actor}${note ? ` — ${note}` : ""}`,
        finishedAt: new Date().toISOString(),
      };
      run.status = "failed";
      run.errorMessage = `Approval ${approvalId} rejected by ${actor}.`;
      return this.persistRun(run);
    }

    run.steps[stepIdx] = {
      ...run.steps[stepIdx],
      status: "completed",
      summary: `Approved by ${actor} (${approvalId})`,
      finishedAt: new Date().toISOString(),
    };
    run.currentStepIndex = stepIdx + 1;
    this.persistRun(run);
    return this.advance(run.runId);
  }

  /** Called when an integration_task approval spawned by a workflow step is approved or denied. */
  async resumeAfterTaskApproval(
    approvalId: string,
    taskRun: TaskRun | undefined,
    approved: boolean,
    actor: string,
    note?: string,
  ): Promise<WorkflowRun | undefined> {
    const run = this.runs.find((r) => r.status === "waiting_approval" && r.steps.some((s) => s.approvalId === approvalId && s.type === "integration_task"));
    if (!run) return undefined;
    const stepIdx = run.steps.findIndex((s) => s.approvalId === approvalId);
    if (stepIdx < 0) return run;
    const def = this.getDefinition(run.workflowId);
    const stepDef = def?.steps[stepIdx];

    if (!approved || !taskRun) {
      run.steps[stepIdx] = {
        ...run.steps[stepIdx],
        status: "failed",
        summary: `Rejected by ${actor}${note ? ` — ${note}` : ""}`,
        finishedAt: new Date().toISOString(),
      };
      run.status = "failed";
      run.errorMessage = `Task approval ${approvalId} rejected by ${actor}.`;
      return this.persistRun(run);
    }

    const ok = taskRun.state === "succeeded" || taskRun.state === "succeeded_unverified_output";
    if (!ok) {
      const msg = taskRun.state === "outcome_unknown"
        ? `Outcome unknown for ${taskRun.toolRef} (${taskRun.runId}) — reconcile before retrying.`
        : (taskRun.error?.message ?? `Task ${taskRun.toolRef} ended as ${taskRun.state}`);
      run.steps[stepIdx] = {
        ...run.steps[stepIdx],
        status: "failed",
        summary: msg,
        taskRunId: taskRun.runId,
        outcomeCode: taskRun.outcome?.code,
        sfieldRunId: taskRun.sfieldRunId,
        finishedAt: new Date().toISOString(),
      };
      run.status = "failed";
      run.errorMessage = msg;
      return this.persistRun(run);
    }

    if (stepDef?.type === "integration_task" && taskRun.output && typeof taskRun.output === "object" && !Array.isArray(taskRun.output)) {
      const prefix = stepDef.outputPrefix ? `${stepDef.outputPrefix}_` : "";
      for (const [k, v] of Object.entries(taskRun.output as Record<string, unknown>)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          run.computed[`${prefix}${k}`] = v;
        }
      }
    }

    run.steps[stepIdx] = {
      ...run.steps[stepIdx],
      status: "completed",
      summary: `Approved by ${actor} · ${taskRun.toolRef} → ${taskRun.outcome?.code ?? taskRun.state}`,
      taskRunId: taskRun.runId,
      outcomeCode: taskRun.outcome?.code,
      sfieldRunId: taskRun.sfieldRunId,
      finishedAt: new Date().toISOString(),
    };
    run.currentStepIndex = stepIdx + 1;
    this.persistRun(run);
    return this.advance(run.runId);
  }

  cancelRun(runId: string): WorkflowRun {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Workflow run "${runId}" not found.`);
    const timer = this.timers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(runId);
    }
    if (run.status === "completed" || run.status === "cancelled") return run;
    const idx = run.currentStepIndex;
    if (run.steps[idx] && ["active", "waiting_input", "waiting_approval", "running_job"].includes(run.steps[idx].status)) {
      run.steps[idx] = {
        ...run.steps[idx],
        status: "cancelled",
        summary: "Cancelled mid-flight by user.",
        finishedAt: new Date().toISOString(),
      };
    }
    run.status = "cancelled";
    return this.persistRun(run);
  }

  private async advance(runId: string): Promise<WorkflowRun> {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Workflow run "${runId}" not found.`);
    const def = this.getDefinition(run.workflowId);
    if (!def) throw new Error(`Workflow "${run.workflowId}" not found.`);

    while (run.currentStepIndex < def.steps.length) {
      const idx = run.currentStepIndex;
      const step: WorkflowStep = def.steps[idx];
      const nowIso = new Date().toISOString();

      if (step.when) {
        const evalRes = evaluateCondition(step.when, run);
        if (!evalRes.matched) {
          run.steps[idx] = {
            ...run.steps[idx],
            status: "skipped",
            summary: `Skipped (${evalRes.reason} = false)`,
            startedAt: nowIso,
            finishedAt: nowIso,
          };
          run.currentStepIndex += 1;
          this.persistRun(run);
          continue;
        }
      }

      if (step.type === "collect_input") {
        run.steps[idx] = {
          ...run.steps[idx],
          status: "waiting_input",
          startedAt: nowIso,
        };
        run.status = "waiting_input";
        return this.persistRun(run);
      }

      if (step.type === "compute") {
        if (step.evaluator === "ofac_velocity_screen") {
          const amount = Number(run.inputs.amountUsd ?? 0);
          const isIntl = String(run.inputs.rail ?? "").toLowerCase().includes("swift");
          const score = Math.min(92, Math.max(12, Math.round(14 + (amount / 2500) + (isIntl ? 18 : 0))));
          run.computed.riskScore = score;
          run.computed.riskBand = score >= 55 ? "Elevated Review" : "Low Risk";
        } else if (step.evaluator === "loan_underwriting") {
          const amount = Math.max(1000, Number(run.inputs.loanAmountUsd ?? 25000));
          const months = Math.max(6, Number(run.inputs.termMonths ?? 24));
          const aprPct = amount > 25000 ? 6.85 : 6.25;
          const r = aprPct / 100 / 12;
          const monthly = Math.round((amount * r) / (1 - Math.pow(1 + r, -months)));
          run.computed.aprPct = aprPct;
          run.computed.monthlyPaymentUsd = monthly;
        }
        const summary = interpolate(step.outputTemplate, run);
        run.steps[idx] = {
          ...run.steps[idx],
          status: "completed",
          summary,
          startedAt: nowIso,
          finishedAt: new Date().toISOString(),
        };
        run.currentStepIndex += 1;
        this.persistRun(run);
        continue;
      }

      if (step.type === "hitl_approval") {
        const title = interpolate(step.approvalTitleTemplate, run);
        const summary = interpolate(step.approvalSummaryTemplate, run);
        const details = Object.entries(run.inputs).slice(0, 6).map(([k, v]) => ({
          label: k,
          value: typeof v === "number" ? v.toLocaleString("en-US") : String(v),
        }));
        const approval = this.deps.approvalStore.createPending({
          targetKind: "workflow_step",
          sfieldToolRef: "cep.workflow.step@1.0.0",
          domain: "workflow",
          recordId: run.runId,
          action: step.id,
          title,
          summary,
          riskLevel: step.riskLevel,
          payload: {
            runId: run.runId,
            workflowId: run.workflowId,
            stepId: step.id,
            inputs: run.inputs,
          },
          details: details.length > 0 ? details : [{ label: "Workflow", value: run.workflowName }],
          requester: run.actorName,
          dualControl: step.dualControl,
        });
        run.steps[idx] = {
          ...run.steps[idx],
          status: "waiting_approval",
          summary: `Paused for SHA-256 HITL approval (${approval.id})`,
          approvalId: approval.id,
          payloadDigest: approval.payloadDigest,
          dualControl: approval.dualControl,
          startedAt: nowIso,
        };
        run.status = "waiting_approval";
        return this.persistRun(run);
      }

      if (step.type === "connector_call") {
        const note = step.noteTemplate ? interpolate(step.noteTemplate, run) : run.workflowName;
        try {
          const exec = await this.deps.connectorStore.invokeConnector(
            step.connectorId,
            {
              action: step.action,
              actor: run.actorName,
              payload: { workflowId: run.workflowId, runId: run.runId, note, inputs: run.inputs },
            },
            AbortSignal.timeout(5000),
          );
          run.steps[idx] = {
            ...run.steps[idx],
            status: "completed",
            summary: `${exec.summary} (HTTP ${exec.statusCode})`,
            startedAt: nowIso,
            finishedAt: new Date().toISOString(),
          };
        } catch (err) {
          run.steps[idx] = {
            ...run.steps[idx],
            status: "failed",
            summary: err instanceof Error ? err.message : "Connector call failed.",
            startedAt: nowIso,
            finishedAt: new Date().toISOString(),
          };
          run.status = "failed";
          run.errorMessage = run.steps[idx].summary;
          return this.persistRun(run);
        }
        run.currentStepIndex += 1;
        this.persistRun(run);
        continue;
      }

      if (step.type === "integration_task") {
        const svc = this.deps.integrationService;
        if (!svc) {
          run.steps[idx] = { ...run.steps[idx], status: "failed", toolRef: step.toolRef, summary: "IntegrationTaskService is not wired into WorkflowEngine.", startedAt: nowIso, finishedAt: new Date().toISOString() };
          run.status = "failed";
          run.errorMessage = run.steps[idx].summary;
          return this.persistRun(run);
        }
        const contract = svc.view().contracts.find((c) => c.ref === step.toolRef);
        const props = ((contract?.inputSchema as { properties?: Record<string, { type?: string | string[] }> } | undefined)?.properties) ?? {};
        const input: Record<string, unknown> = {};
        for (const [field, tmpl] of Object.entries(step.inputMapping ?? {})) {
          const rawVal = interpolate(tmpl, run);
          const propType = Array.isArray(props[field]?.type) ? props[field]!.type[0] : props[field]?.type;
          if (propType === "number" || propType === "integer") {
            const num = Number(rawVal);
            input[field] = Number.isFinite(num) ? (propType === "integer" ? Math.round(num) : num) : rawVal;
          } else if (propType === "boolean") {
            input[field] = rawVal === "true";
          } else {
            input[field] = rawVal;
          }
        }
        try {
          const out = await svc.run(run.personaId || "workflow-engine", {
            toolRef: step.toolRef,
            input,
            requestedBy: run.actorName,
          });
          if (out.approval) {
            run.steps[idx] = {
              ...run.steps[idx],
              status: "waiting_approval",
              summary: `Held by sfield for approval (${out.approval.id}) before running ${step.toolRef}`,
              approvalId: out.approval.id,
              payloadDigest: out.approval.payloadDigest,
              dualControl: out.approval.dualControl,
              taskRunId: out.run.runId,
              toolRef: step.toolRef,
              sfieldRunId: out.run.sfieldRunId,
              startedAt: nowIso,
            };
            run.status = "waiting_approval";
            return this.persistRun(run);
          }
          const ok = out.run.state === "succeeded" || out.run.state === "succeeded_unverified_output";
          if (!ok) {
            const msg = out.run.state === "outcome_unknown"
              ? `Outcome unknown for ${step.toolRef} (${out.run.runId}) — reconcile before retrying.`
              : (out.run.error?.message ?? `Task ${step.toolRef} ended as ${out.run.state}`);
            run.steps[idx] = {
              ...run.steps[idx],
              status: "failed",
              summary: msg,
              taskRunId: out.run.runId,
              toolRef: step.toolRef,
              outcomeCode: out.run.outcome?.code,
              sfieldRunId: out.run.sfieldRunId,
              startedAt: nowIso,
              finishedAt: new Date().toISOString(),
            };
            run.status = "failed";
            run.errorMessage = msg;
            return this.persistRun(run);
          }
          if (out.run.output && typeof out.run.output === "object" && !Array.isArray(out.run.output)) {
            const prefix = step.outputPrefix ? `${step.outputPrefix}_` : "";
            for (const [k, v] of Object.entries(out.run.output as Record<string, unknown>)) {
              if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
                run.computed[`${prefix}${k}`] = v;
              }
            }
          }
          run.steps[idx] = {
            ...run.steps[idx],
            status: "completed",
            summary: `${step.toolRef} → ${out.run.outcome?.code ?? out.run.state} (sfield ${out.run.sfieldRunId ?? "ok"})`,
            taskRunId: out.run.runId,
            toolRef: step.toolRef,
            outcomeCode: out.run.outcome?.code,
            sfieldRunId: out.run.sfieldRunId,
            startedAt: nowIso,
            finishedAt: new Date().toISOString(),
          };
        } catch (err) {
          run.steps[idx] = {
            ...run.steps[idx],
            status: "failed",
            toolRef: step.toolRef,
            summary: err instanceof Error ? err.message : `Task ${step.toolRef} failed.`,
            startedAt: nowIso,
            finishedAt: new Date().toISOString(),
          };
          run.status = "failed";
          run.errorMessage = run.steps[idx].summary;
          return this.persistRun(run);
        }
        run.currentStepIndex += 1;
        this.persistRun(run);
        continue;
      }

      if (step.type === "async_job") {
        const endsAt = new Date(Date.now() + step.durationSeconds * 1000).toISOString();
        run.steps[idx] = {
          ...run.steps[idx],
          status: "running_job",
          summary: interpolate(step.runningLabel, run),
          jobStartedAt: nowIso,
          jobEndsAt: endsAt,
          durationSeconds: step.durationSeconds,
          startedAt: nowIso,
        };
        run.status = "running_job";
        const saved = this.persistRun(run);
        const timer = setTimeout(() => {
          this.timers.delete(run.runId);
          const latest = this.getRun(run.runId);
          if (!latest || latest.status !== "running_job" || latest.currentStepIndex !== idx) return;
          latest.steps[idx] = {
            ...latest.steps[idx],
            status: "completed",
            summary: interpolate(step.completedTemplate, latest),
            finishedAt: new Date().toISOString(),
          };
          latest.currentStepIndex += 1;
          this.persistRun(latest);
          void this.advance(latest.runId);
        }, step.durationSeconds * 1000);
        this.timers.set(run.runId, timer);
        return saved;
      }

      if (step.type === "emit_host_event") {
        const msg = interpolate(step.messageTemplate, run);
        run.steps[idx] = {
          ...run.steps[idx],
          status: "completed",
          summary: msg,
          emittedEvent: {
            eventName: step.eventName,
            payload: {
              runId: run.runId,
              workflowId: run.workflowId,
              workflowName: run.workflowName,
              inputs: run.inputs,
              computed: run.computed,
            },
          },
          startedAt: nowIso,
          finishedAt: new Date().toISOString(),
        };
        run.currentStepIndex += 1;
        this.persistRun(run);
        continue;
      }
    }

    run.status = "completed";
    run.completedAt = new Date().toISOString();
    return this.persistRun(run);
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.listeners.clear();
  }
}
