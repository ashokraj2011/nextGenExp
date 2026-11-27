import { createHash } from "node:crypto";
import { z } from "zod";
import type { ApprovalRecord, PublicationReview } from "../../packages/contracts/approval";
import { flowScopeSchema, type FlowScope } from "../../packages/contracts/routing-flows";
import { canonicalJson, type ApprovalStore } from "./approval-store";
import { ApiError } from "./store";

type ReviewActor = { principalId: string; operator: string };
export type PublicationContext = ReviewActor & { scope: FlowScope };
export type PublicationPlan = {
  recordId: string;
  title: string;
  current: unknown;
  preview?: unknown;
  details?: ApprovalRecord["details"];
  apply: (approver: string) => PublicationResult | Promise<PublicationResult>;
};
export type PublicationResult = { summary: string; value?: unknown };
export type PublicationPlans = Record<string, (candidate: unknown, context: PublicationContext) => PublicationPlan>;

const payloadSchema = z.object({
  scope: flowScopeSchema,
  principalId: z.string().min(1),
  candidate: z.unknown(),
  preview: z.unknown().optional(),
  baseRevision: z.string().length(64),
}).strict();

function revision(value: unknown) {
  return createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(value ?? null)))).digest("hex");
}

export class PublicationReviews {
  constructor(
    private readonly approvals: ApprovalStore,
    private readonly plans: PublicationPlans,
    private readonly allowedScopes: (operator: string) => readonly FlowScope[],
    private readonly enforceEvalGate: (label: string) => void,
  ) {}

  mayReview(operator: string, record: ApprovalRecord) {
    const scopes = this.allowedScopes(operator);
    if (record.targetKind !== "publication") return scopes.includes("tenant");
    const payload = payloadSchema.safeParse(record.payload);
    return payload.success && scopes.includes(payload.data.scope);
  }

  private prepare(action: string, candidate: unknown, context: PublicationContext) {
    if (!this.allowedScopes(context.operator).includes(context.scope)) {
      throw new ApiError(403, "domain_access_denied", "Publishing access is required for this workspace.");
    }
    const plan = Object.hasOwn(this.plans, action) ? this.plans[action] : undefined;
    if (!plan) throw new ApiError(400, "publication_unknown", "This type of publication is unavailable.");
    return plan(candidate, context);
  }

  request(action: string, candidate: unknown, context: PublicationContext): PublicationReview {
    const plan = this.prepare(action, candidate, context);
    this.enforceEvalGate("submitting this publication");
    const payload = {
      candidate: JSON.parse(JSON.stringify(candidate)) as unknown,
      ...(plan.preview !== undefined && { preview: JSON.parse(JSON.stringify(plan.preview)) as unknown }),
      scope: context.scope,
      principalId: context.principalId,
      baseRevision: revision(plan.current),
    };
    const pending = this.approvals.pending().find((record) =>
      record.targetKind === "publication" && record.action === action && record.requester === context.operator
      && canonicalJson(record.payload) === canonicalJson(payload));
    if (pending) return { status: "pending_approval", approval: pending };
    const approval = this.approvals.createPending({
      targetKind: "publication",
      sfieldToolRef: "cep.publication",
      domain: "publication",
      recordId: plan.recordId.slice(0, 64),
      action,
      title: plan.title.slice(0, 120),
      summary: "Review this exact change before it becomes available in the workspace.",
      riskLevel: "low",
      payload,
      details: [{ label: "Workspace", value: context.scope }, ...(plan.details ?? [])],
      requester: context.operator,
      ttlMs: 24 * 60 * 60 * 1000,
    });
    return { status: "pending_approval", approval };
  }

  planForApproval(record: ApprovalRecord, operator: string) {
    if (!this.mayReview(operator, record)) {
      throw new ApiError(404, "approval_not_found", "This publication request is unavailable.");
    }
    const { scope, principalId, candidate, baseRevision } = payloadSchema.parse(record.payload);
    this.enforceEvalGate("publishing this change");
    const plan = this.prepare(record.action, candidate, { scope, principalId, operator: record.requester });
    if (revision(plan.current) !== baseRevision) {
      throw new ApiError(409, "publication_changed", "The current revision changed. Submit a new review from the latest revision.");
    }
    return plan;
  }
}
