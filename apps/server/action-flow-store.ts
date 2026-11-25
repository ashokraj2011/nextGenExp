import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  actionFlowSchema,
  actionFlowUpsertSchema,
  type ActionFlow,
  type ActionFlowUpsertInput,
} from "../../packages/contracts/action-flow";

function defaultActionFlows(nowIso: string): ActionFlow[] {
  return [
    {
      id: "p1_pagerduty_escalation",
      name: "P1 PagerDuty Escalation Flow",
      domain: "operations",
      description: "Escalate active production incidents to PagerDuty via cep.connector.invoke@1.0.0 with inline HITL approval.",
      triggerPhrases: ["escalate to pagerduty", "page SRE on-call", "trigger P1 escalation flow"],
      targetKind: "external_connector",
      connectorId: "pagerduty_incident_webhook",
      connectorAction: "escalate_p1_incident",
      approvalMode: "hitl_inline",
      enabled: true,
      updatedAt: nowIso,
    },
    {
      id: "servicenow_change_approval",
      name: "ServiceNow Change Request (4-Eyes)",
      domain: "operations",
      description: "Open a governed production change ticket via external connector requiring 4-eyes separate approver sign-off.",
      triggerPhrases: ["open servicenow change ticket", "file emergency change request", "run change approval flow"],
      targetKind: "external_connector",
      connectorId: "pagerduty_incident_webhook",
      connectorAction: "create_change_ticket",
      approvalMode: "hitl_4eyes",
      enabled: true,
      updatedAt: nowIso,
    },
  ];
}

function slugId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36);
  return base || `flow_${Date.now().toString(36)}`;
}

export class ActionFlowStore {
  private readonly filePath: string;
  private flows: ActionFlow[];

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "action-flows.json");
    this.flows = this.load();
  }

  private load(): ActionFlow[] {
    if (existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
        if (Array.isArray(raw)) {
          const valid = raw
            .map((item) => actionFlowSchema.safeParse(item))
            .filter((res): res is { success: true; data: ActionFlow } => res.success)
            .map((res) => res.data);
          if (valid.length > 0) return valid;
        }
      } catch { /* fall through */ }
    }
    const seeded = defaultActionFlows(new Date().toISOString());
    this.save(seeded);
    return seeded;
  }

  private save(next: ActionFlow[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(next, null, 2), "utf8");
    this.flows = next;
  }

  list(): ActionFlow[] {
    return this.flows.map((f) => ({ ...f, triggerPhrases: [...f.triggerPhrases] }));
  }

  findById(id: string): ActionFlow | undefined {
    const found = this.flows.find((f) => f.id === id);
    return found ? { ...found, triggerPhrases: [...found.triggerPhrases] } : undefined;
  }

  matchPrompt(prompt: string): ActionFlow | undefined {
    const lower = prompt.toLowerCase().trim();
    if (lower.length < 5) return undefined;
    for (const flow of this.flows) {
      if (!flow.enabled) continue;
      if (lower.includes(flow.name.toLowerCase())) return { ...flow, triggerPhrases: [...flow.triggerPhrases] };
      for (const phrase of flow.triggerPhrases) {
        const p = phrase.toLowerCase().trim();
        if (p.length >= 4 && lower.includes(p)) {
          return { ...flow, triggerPhrases: [...flow.triggerPhrases] };
        }
      }
    }
    return undefined;
  }

  upsert(rawInput: ActionFlowUpsertInput): { flow: ActionFlow; flows: ActionFlow[] } {
    const input = actionFlowUpsertSchema.parse(rawInput);
    const id = input.id ?? slugId(input.name);
    const record: ActionFlow = {
      id,
      name: input.name,
      domain: input.domain,
      description: input.description,
      triggerPhrases: input.triggerPhrases,
      targetKind: input.targetKind,
      ...(input.connectorId ? { connectorId: input.connectorId } : {}),
      ...(input.connectorAction ? { connectorAction: input.connectorAction } : {}),
      ...(input.uiLayoutId ? { uiLayoutId: input.uiLayoutId } : {}),
      approvalMode: input.approvalMode,
      enabled: input.enabled,
      updatedAt: new Date().toISOString(),
    };
    const exists = this.flows.some((f) => f.id === id);
    const next = exists
      ? this.flows.map((f) => (f.id === id ? record : f))
      : [record, ...this.flows];
    this.save(next);
    return { flow: record, flows: this.list() };
  }

  remove(id: string): { deleted: boolean; flows: ActionFlow[] } {
    const next = this.flows.filter((f) => f.id !== id);
    if (next.length === this.flows.length) return { deleted: false, flows: this.list() };
    this.save(next);
    return { deleted: true, flows: this.list() };
  }
}
