import type { ApprovalPolicySettings, ApprovalRecord, ApprovalRiskLevel } from "../../packages/contracts/approval";
import { pznSfieldToolRefs } from "../../packages/contracts/self-service-pzn";
import { canonicalJson, type ApprovalStore } from "./approval-store";
import type { SelfServicePznStore } from "./self-service-pzn-store";

export type PznGateCategory = "publish" | "destructive" | "dictionary" | "none";
export type PznGate = {
  gated: boolean;
  category: PznGateCategory;
  riskLevel: ApprovalRiskLevel;
  dualControl: boolean;
};

const DICTIONARY_OPS = new Set(["get_dictionary", "upsert_namespace", "delete_namespace", "upsert_attribute", "delete_attribute"]);
const TS_OPS = new Set(["evaluate", "list_published_contexts"]);
const DESTRUCTIVE_OPS = new Set(["unpublish_context", "delete_rule", "delete_content", "delete_context", "delete_namespace", "delete_attribute"]);

/** Every PZN operation name is unique across the three sfield tools, so the tool ref is derivable. */
export function pznToolRefForOperation(operation: string): string {
  if (DICTIONARY_OPS.has(operation)) return pznSfieldToolRefs.dataDictionary;
  if (TS_OPS.has(operation)) return pznSfieldToolRefs.treatmentSelector;
  return pznSfieldToolRefs.ruleMetadata;
}

export function pznGateFor(policy: ApprovalPolicySettings, operation: string): PznGate {
  let category: PznGateCategory = "none";
  let riskLevel: ApprovalRiskLevel = "low";
  let gated = false;
  if (operation === "publish_context") {
    category = "publish";
    riskLevel = "medium";
    gated = policy.gatePznPublish;
  } else if (DESTRUCTIVE_OPS.has(operation)) {
    category = "destructive";
    riskLevel = "high";
    gated = policy.gatePznDestructive;
  } else if (operation === "upsert_namespace" || operation === "upsert_attribute") {
    category = "dictionary";
    riskLevel = "medium";
    gated = policy.gatePznDictionaryChanges;
  }
  const dualControl = gated && (
    policy.pznDualControl === "always"
    || (policy.pznDualControl === "high_risk" && riskLevel === "high")
  );
  return { gated, category, riskLevel, dualControl };
}

export function splitApprovalId(raw: Record<string, unknown>): { approvalId?: string; args: Record<string, unknown> } {
  const { approvalId, ...args } = raw;
  return { ...(typeof approvalId === "string" && approvalId ? { approvalId } : {}), args };
}

function entityId(operation: string, args: Record<string, unknown>): string {
  const pick = (k: string) => (typeof args[k] === "string" && args[k] ? String(args[k]) : undefined);
  if (operation.endsWith("_attribute")) return `${pick("namespaceId") ?? "ns"}.${pick("attributeId") ?? pick("id") ?? "attr"}`;
  return pick("contextId") ?? pick("ruleId") ?? pick("contentId") ?? pick("id") ?? operation;
}

/** A version token for the target entity, so an approval is invalidated if the entity changes after the request. */
function stalenessToken(pzn: SelfServicePznStore, operation: string, args: Record<string, unknown>): string | undefined {
  if (typeof args.contextId === "string") return pzn.getContext(args.contextId)?.updatedAt;
  if (operation === "delete_rule" && typeof args.ruleId === "string") return pzn.getRule(args.ruleId)?.updatedAt;
  if (operation === "delete_content" && typeof args.contentId === "string") return pzn.getContent(args.contentId)?.updatedAt;
  return undefined;
}

const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max - 1) + "…" : value);

function operationLabel(operation: string): string {
  switch (operation) {
    case "publish_context": return "Publish context to Treatment Selector";
    case "unpublish_context": return "Unpublish context (removes it from live Treatment Selector)";
    case "delete_rule": return "Delete rule";
    case "delete_content": return "Delete text content";
    case "delete_context": return "Delete context and its publication history";
    case "delete_namespace": return "Delete Data Dictionary namespace";
    case "delete_attribute": return "Delete Data Dictionary attribute";
    case "upsert_namespace": return "Create/update Data Dictionary namespace";
    case "upsert_attribute": return "Create/update Data Dictionary attribute";
    default: return operation;
  }
}

/** Live Treatment Selector impact preview: current published result vs. what the draft would return. */
function impactDetails(pzn: SelfServicePznStore, operation: string, args: Record<string, unknown>) {
  const contextId = typeof args.contextId === "string" ? args.contextId : undefined;
  if (!contextId || (operation !== "publish_context" && operation !== "unpublish_context")) return [];
  const ctx = pzn.getContext(contextId);
  if (!ctx) return [];
  const customers = pzn.getWorkspaceState().customers.slice(0, 3);
  const details: { label: string; value: string }[] = [];
  for (const customer of customers) {
    try {
      const before = ctx.status === "published"
        ? pzn.evaluateLiveTs({ mid: customer.syntheticMid, contextId }).eligibleContents.map((c) => c.contentId)
        : [];
      const after = operation === "unpublish_context"
        ? []
        : pzn.evaluateLiveTs({ mid: customer.syntheticMid, contextId, useDraft: true }).eligibleContents.map((c) => c.contentId);
      const added = after.filter((id) => !before.includes(id));
      const removed = before.filter((id) => !after.includes(id));
      const delta = [
        added.length ? `+${added.join(", +")}` : "",
        removed.length ? `-${removed.join(", -")}` : "",
      ].filter(Boolean).join(" ");
      details.push({
        label: clip(`Impact · ${customer.displayName}`, 64),
        value: clip(`${before.length} → ${after.length} eligible${delta ? ` (${delta})` : " (no change)"}`, 160),
      });
    } catch {
      /* Impact preview is advisory; never block the approval request on it. */
    }
  }
  return details;
}

export function requestPznApproval(
  approvals: ApprovalStore,
  pzn: SelfServicePznStore,
  input: { operation: string; args: Record<string, unknown>; requester?: string },
): ApprovalRecord {
  const policy = approvals.getPolicy();
  const gate = pznGateFor(policy, input.operation);
  const { args } = splitApprovalId(input.args);
  const target = entityId(input.operation, args);
  const token = stalenessToken(pzn, input.operation, args);
  const ctx = typeof args.contextId === "string" ? pzn.getContext(args.contextId) : undefined;
  const versionLine = input.operation === "publish_context" && ctx
    ? `v${ctx.publishedVersion} → v${ctx.publishedVersion + 1} (${ctx.attachments.length} attached content item(s))`
    : undefined;

  const details = [
    { label: "Change", value: clip(operationLabel(input.operation), 160) },
    { label: "Target", value: clip(target, 160) },
    ...(versionLine ? [{ label: "Version", value: versionLine }] : []),
    {
      label: "Approvers",
      value: gate.dualControl ? "Second approver required (4-eyes)" : "Requester may self-approve",
    },
    ...impactDetails(pzn, input.operation, args),
  ].slice(0, 8);

  return approvals.createPending({
    targetKind: "pzn_change",
    sfieldToolRef: pznToolRefForOperation(input.operation),
    domain: "pzn_self_service",
    recordId: clip(target, 64),
    action: input.operation,
    title: clip(`${operationLabel(input.operation)} · ${target}`, 120),
    summary: clip(
      `${operationLabel(input.operation)} for "${target}". ${gate.riskLevel.toUpperCase()} risk. `
        + (gate.dualControl ? "A second approver must approve." : "The requester may approve this change."),
      400,
    ),
    riskLevel: gate.riskLevel,
    payload: { args, toolRef: pznToolRefForOperation(input.operation), ...(token ? { stalenessToken: token } : {}) },
    details,
    requester: input.requester?.trim() || "Recommendation Author",
    dualControl: gate.dualControl,
    ttlMs: policy.pznApprovalExpiryMinutes * 60_000,
  });
}

export class PznApprovalError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Enforcement used inside the sfield tool handlers (and the offline path). If the operation is gated by policy,
 * the call must carry an approved approvalId whose args and target version match exactly.
 * Returns the args with approvalId removed.
 */
export function verifyPznApproval(
  approvals: ApprovalStore,
  pzn: SelfServicePznStore,
  operation: string,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const { approvalId, args } = splitApprovalId(raw);
  const gate = pznGateFor(approvals.getPolicy(), operation);
  if (!gate.gated) return args;
  if (!approvalId) {
    throw new PznApprovalError("APPROVAL_REQUIRED", `"${operation}" requires an approved change request under the current approval policy.`);
  }
  const record = approvals.findById(approvalId);
  if (!record || record.targetKind !== "pzn_change") {
    throw new PznApprovalError("APPROVAL_NOT_FOUND", `Approval ${approvalId} was not found.`);
  }
  if (record.status !== "executing") {
    throw new PznApprovalError(
      "APPROVAL_NOT_APPROVED",
      `Approval ${approvalId} is ${record.status}; it must be approved and claimed for execution (each approval runs once).`,
    );
  }
  const expectedToolRef = pznToolRefForOperation(operation);
  if (record.action !== operation || record.sfieldToolRef !== expectedToolRef || record.payload.toolRef !== expectedToolRef) {
    throw new PznApprovalError("APPROVAL_SCOPE_MISMATCH", `Approval ${approvalId} does not authorize "${operation}" on ${expectedToolRef}.`);
  }
  if (canonicalJson(record.payload.args ?? {}) !== canonicalJson(args)) {
    throw new PznApprovalError("APPROVAL_PAYLOAD_MISMATCH", `The requested change differs from what approval ${approvalId} authorized.`);
  }
  const expected = typeof record.payload.stalenessToken === "string" ? record.payload.stalenessToken : undefined;
  if (expected !== stalenessToken(pzn, operation, args)) {
    throw new PznApprovalError("APPROVAL_STALE", `The target changed after approval ${approvalId} was requested. Request a new approval.`);
  }
  return args;
}

/** Offline executor (no model gateway / sfield runtime). Mirrors the sfield tool handlers. */
export function applyPznOperationDirect(pzn: SelfServicePznStore, operation: string, args: Record<string, unknown>): string {
  const s = (k: string) => String(args[k] ?? "");
  switch (operation) {
    case "publish_context": {
      const pub = pzn.publishContext(s("contextId"), typeof args.publishedBy === "string" ? args.publishedBy : "Approved Change", typeof args.notes === "string" ? args.notes : "");
      return `Published "${pub.contextId}" v${pub.version} to Treatment Selector`;
    }
    case "unpublish_context": return `Unpublished "${pzn.unpublishContext(s("contextId")).contextId}"`;
    case "delete_rule": pzn.deleteRule(s("ruleId")); return `Deleted rule "${s("ruleId")}"`;
    case "delete_content": pzn.deleteContent(s("contentId")); return `Deleted text content "${s("contentId")}"`;
    case "delete_context": pzn.deleteContext(s("contextId")); return `Deleted context "${s("contextId")}"`;
    case "delete_namespace": pzn.deleteNamespace(s("id")); return `Deleted namespace "${s("id")}"`;
    case "delete_attribute": pzn.deleteAttribute(s("namespaceId"), s("attributeId")); return `Deleted attribute "${s("namespaceId")}.${s("attributeId")}"`;
    case "upsert_namespace": return `Saved namespace "${pzn.upsertNamespace(args).id}"`;
    case "upsert_attribute": {
      const attr = pzn.upsertAttribute(args);
      return `Saved Data Dictionary attribute "${attr.namespaceId}.${attr.id}"`;
    }
    default: throw new PznApprovalError("INVALID_OPERATION", `Unsupported approved operation: ${operation}`);
  }
}
