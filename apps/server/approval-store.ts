import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  approvalPolicySettingsSchema,
  approvalRecordSchema,
  type ApprovalDecisionInput,
  type ApprovalDomain,
  type ApprovalPolicySettings,
  type ApprovalRecord,
  type ApprovalRiskLevel,
  type ApprovalsView,
  type ApprovalTargetKind,
} from "../../packages/contracts/approval";
import type { ExternalConnector } from "../../packages/contracts/connector";
import { makeId } from "../../packages/experience/compile";

const APPROVAL_TTL_MS = 30 * 60 * 1000; // 30 minutes

const defaultPolicy: ApprovalPolicySettings = {
  gateHighRiskOpsRollbacks: true,
  gateHighRiskSalesDiscounts: true,
  gateExternalConnectorWrites: true,
  gateHighRiskTrades: true,
  highRiskTradeThresholdUsd: 10_000,
  defaultDualControl: false,
  gatePznPublish: true,
  gatePznDestructive: true,
  gatePznDictionaryChanges: false,
  pznDualControl: "high_risk",
  pznApprovalExpiryMinutes: 30,
};

interface PersistedApprovals {
  policy: ApprovalPolicySettings;
  records: ApprovalRecord[];
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function computeApprovalDigest(input: {
  targetKind: ApprovalTargetKind;
  sfieldToolRef: string;
  domain: ApprovalDomain;
  recordId: string;
  action: string;
  payload: Record<string, unknown>;
}): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex").slice(0, 32);
}

export class ApprovalStore {
  private readonly filePath: string;
  private state: PersistedApprovals;
  private onCreatedListener?: (record: ApprovalRecord) => void;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "approvals.json");
    this.state = this.load();
  }

  setOnCreated(listener: (record: ApprovalRecord) => void): void {
    this.onCreatedListener = listener;
  }

  private load(): PersistedApprovals {
    if (existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PersistedApprovals>;
        const policyParsed = approvalPolicySettingsSchema.safeParse(raw.policy ?? defaultPolicy);
        const records = Array.isArray(raw.records)
          ? raw.records
              .map((item) => approvalRecordSchema.safeParse(item))
              .filter((res): res is { success: true; data: ApprovalRecord } => res.success)
              .map((res) => res.data)
          : [];
        return {
          policy: policyParsed.success ? policyParsed.data : { ...defaultPolicy },
          records,
        };
      } catch { /* fall through */ }
    }
    const fresh: PersistedApprovals = { policy: { ...defaultPolicy }, records: [] };
    this.save(fresh);
    return fresh;
  }

  private save(next: PersistedApprovals): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(next, null, 2), "utf8");
    this.state = next;
  }

  private sweepExpired(): void {
    const nowIso = new Date().toISOString();
    let changed = false;
    const records = this.state.records.map((rec) => {
      if (rec.status === "pending" && rec.expiresAt <= nowIso) {
        changed = true;
        return { ...rec, status: "expired" as const };
      }
      return rec;
    });
    if (changed) this.save({ ...this.state, records });
  }

  getPolicy(): ApprovalPolicySettings {
    return { ...this.state.policy };
  }

  updatePolicy(input: Partial<ApprovalPolicySettings>): ApprovalPolicySettings {
    const parsed = approvalPolicySettingsSchema.parse({ ...this.state.policy, ...input });
    this.save({ ...this.state, policy: parsed });
    return { ...parsed };
  }

  list(): ApprovalRecord[] {
    this.sweepExpired();
    return this.state.records.map((rec) => ({
      ...rec,
      payload: { ...rec.payload },
      details: rec.details.map((d) => ({ ...d })),
    }));
  }

  pending(): ApprovalRecord[] {
    return this.list().filter((rec) => rec.status === "pending");
  }

  view(): ApprovalsView {
    const approvals = this.list();
    return {
      policy: this.getPolicy(),
      approvals,
      pendingCount: approvals.filter((a) => a.status === "pending").length,
    };
  }

  findById(id: string): ApprovalRecord | undefined {
    this.sweepExpired();
    const found = this.state.records.find((r) => r.id === id);
    return found ? { ...found, payload: { ...found.payload }, details: found.details.map((d) => ({ ...d })) } : undefined;
  }

  shouldGateConnector(conn: ExternalConnector): boolean {
    if (conn.requiresApproval) return true;
    return this.state.policy.gateExternalConnectorWrites && conn.effect === "write";
  }

  shouldGateTrade(grossCents: number): boolean {
    return this.state.policy.gateHighRiskTrades && grossCents > this.state.policy.highRiskTradeThresholdUsd * 100;
  }

  shouldGateDomainWrite(input: {
    domain: "ops_incident" | "sales_deal" | "customer360";
    action: string;
    riskLevel?: ApprovalRiskLevel;
  }): boolean {
    if (input.domain === "ops_incident" && input.action === "approve_rollback") {
      return this.state.policy.gateHighRiskOpsRollbacks && (input.riskLevel === "high" || this.state.policy.defaultDualControl);
    }
    if (input.domain === "sales_deal" && input.action === "approve_discount") {
      return this.state.policy.gateHighRiskSalesDiscounts && (input.riskLevel !== "low" || this.state.policy.defaultDualControl);
    }
    return false;
  }

  createPending(input: {
    targetKind: ApprovalTargetKind;
    sfieldToolRef: string;
    domain: ApprovalDomain;
    recordId: string;
    action: string;
    title: string;
    summary: string;
    riskLevel: ApprovalRiskLevel;
    payload: Record<string, unknown>;
    details: { label: string; value: string }[];
    requester: string;
    dualControl?: boolean;
    ttlMs?: number;
    /** Lets a caller reserve the id up front (e.g. to bind it into a tool call before the record exists). */
    id?: string;
  }): ApprovalRecord {
    this.sweepExpired();
    const payloadDigest = computeApprovalDigest({
      targetKind: input.targetKind,
      sfieldToolRef: input.sfieldToolRef,
      domain: input.domain,
      recordId: input.recordId,
      action: input.action,
      payload: input.payload,
    });
    const now = Date.now();
    const record: ApprovalRecord = {
      id: input.id ?? makeId("apr"),
      status: "pending",
      riskLevel: input.riskLevel,
      targetKind: input.targetKind,
      sfieldToolRef: input.sfieldToolRef,
      domain: input.domain,
      recordId: input.recordId,
      action: input.action,
      title: input.title.slice(0, 120),
      summary: input.summary.slice(0, 400),
      payloadDigest,
      payload: input.payload,
      details: input.details.slice(0, 8),
      requester: input.requester.slice(0, 80),
      dualControl: input.dualControl ?? this.state.policy.defaultDualControl,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (input.ttlMs ?? APPROVAL_TTL_MS)).toISOString(),
    };
    const records = [record, ...this.state.records].slice(0, 150);
    this.save({ ...this.state, records });
    try {
      this.onCreatedListener?.(record);
    } catch { /* non-blocking omnichannel notification */ }
    return record;
  }

  decide(id: string, decisionInput: ApprovalDecisionInput): { ok: true; record: ApprovalRecord } | { ok: false; status: number; code: string; message: string } {
    this.sweepExpired();
    const existing = this.state.records.find((r) => r.id === id);
    if (!existing) return { ok: false, status: 404, code: "approval_not_found", message: `Approval ${id} was not found.` };
    if (existing.status === "expired") return { ok: false, status: 409, code: "approval_expired", message: `Approval ${id} expired.` };
    if (existing.status !== "pending") return { ok: false, status: 409, code: "approval_already_decided", message: `Approval ${id} is already ${existing.status}.` };

    if (decisionInput.decision === "approve" && existing.dualControl) {
      if (decisionInput.actor.trim().toLowerCase() === existing.requester.trim().toLowerCase()) {
        return {
          ok: false,
          status: 409,
          code: "dual_control_violation",
          message: `4-eyes dual control is enabled: approver must be different from requester ("${existing.requester}"). Approve from /admin/logs or enter a separate approver name.`,
        };
      }
    }

    const expectedDigest = computeApprovalDigest({
      targetKind: existing.targetKind,
      sfieldToolRef: existing.sfieldToolRef,
      domain: existing.domain,
      recordId: existing.recordId,
      action: existing.action,
      payload: existing.payload,
    });
    if (expectedDigest !== existing.payloadDigest) {
      return {
        ok: false,
        status: 409,
        code: "approval_digest_mismatch",
        message: "Prepared payload digest changed since this approval request was issued.",
      };
    }

    const updated: ApprovalRecord = {
      ...existing,
      status: decisionInput.decision === "approve" ? "approved" : "denied",
      decidedBy: decisionInput.actor.trim(),
      decidedAt: new Date().toISOString(),
      ...(decisionInput.comment?.trim() ? { comment: decisionInput.comment.trim() } : {}),
    };
    this.save({
      ...this.state,
      records: this.state.records.map((r) => (r.id === id ? updated : r)),
    });
    return { ok: true, record: updated };
  }

  /**
   * Atomically moves an approved request to "executing" so it can run at most once,
   * even with double-clicks or two concurrent approvers.
   */
  claimForExecution(id: string): { ok: true; record: ApprovalRecord } | { ok: false; code: string; message: string } {
    this.sweepExpired();
    const existing = this.state.records.find((r) => r.id === id);
    if (!existing) return { ok: false, code: "approval_not_found", message: `Approval ${id} was not found.` };
    if (existing.status !== "approved") {
      return { ok: false, code: "approval_not_claimable", message: `Approval ${id} is ${existing.status}; only an approved request can execute, and only once.` };
    }
    const updated: ApprovalRecord = { ...existing, status: "executing" };
    this.save({ ...this.state, records: this.state.records.map((r) => (r.id === id ? updated : r)) });
    return { ok: true, record: updated };
  }

  /** Returns a claimed request to "approved" when execution definitely did not happen, so it can be retried. */
  releaseClaim(id: string): void {
    const existing = this.state.records.find((r) => r.id === id);
    if (!existing || existing.status !== "executing") return;
    this.save({ ...this.state, records: this.state.records.map((r) => (r.id === id ? { ...existing, status: "approved" as const } : r)) });
  }

  markExecuted(
    id: string,
    executionResult: NonNullable<ApprovalRecord["executionResult"]>,
  ): ApprovalRecord | undefined {
    const existing = this.state.records.find((r) => r.id === id);
    if (!existing) return undefined;
    const updated: ApprovalRecord = {
      ...existing,
      status: "executed",
      executionResult,
    };
    this.save({
      ...this.state,
      records: this.state.records.map((r) => (r.id === id ? updated : r)),
    });
    return updated;
  }
}
