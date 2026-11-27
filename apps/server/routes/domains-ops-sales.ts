/**
 * Domain, Trading, HITL Approvals, Write Audit, Analytics, IT Ops, and Sales RevOps HTTP routes.
 * Extracted from `apps/server/http.ts` for clean separation of concerns.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  approvalDecisionInputSchema,
  approvalPolicySettingsSchema,
  type ApprovalRecord,
} from "../../../packages/contracts/approval";
import type { DomainPackId } from "../../../packages/contracts/domain-packs";
import { dealDecisionInputSchema, dealUpsertInputSchema } from "../../../packages/contracts/sales";
import { incidentDecisionInputSchema, incidentUpsertInputSchema } from "../../../packages/contracts/ops";
import { taxHarvestPreviewInputSchema, tradeJobCreateInputSchema } from "../../../packages/contracts/trading";
import type { ApprovalStore } from "../approval-store";
import type { Customer360Service } from "../customer-360";
import type { IntegrationTaskService } from "../integration-tasks";
import type { OpsIncidentStore } from "../ops-store";
import { domainWriteToolRef, type Runtime } from "../runtime";
import type { SalesDealStore } from "../sales-store";
import { ApiError, type Store } from "../store";
import type { TradeStore } from "../trade-store";
import type { WorkflowEngine } from "../workflow-engine";
import type { WriteAuditStore } from "../write-audit";

export interface DomainsOpsSalesRouteDeps {
  req: IncomingMessage;
  res: ServerResponse;
  resource: string;
  id: string | undefined;
  operation: string | undefined;
  method: string | undefined;
  principalId: string;
  operator: string | undefined;
  inspectorEnabled: boolean;
  streams: Set<ServerResponse>;
  store: Store;
  runtime: Runtime | null;
  tradeStore: TradeStore;
  approvalStore: ApprovalStore;
  writeAudit: WriteAuditStore;
  customer360: Customer360Service;
  opsStore: OpsIncidentStore;
  salesStore: SalesDealStore;
  integrationService: IntegrationTaskService;
  workflowEngine: WorkflowEngine;
  json: (res: ServerResponse, data: unknown, status?: number) => void;
  body: <S extends z.ZodTypeAny>(req: IncomingMessage, schema: S, limit?: number) => Promise<z.output<S>>;
  requireOperator: () => string;
  requireChatDomain: (domainId: DomainPackId, personaId: string) => void;
  makeTradeSettler: (principalId: string) => Parameters<TradeStore["startTradeJob"]>[1];
  executeApprovedRecord: (principalId: string, record: ApprovalRecord) => Promise<{ approval: ApprovalRecord; execution: unknown; taskRun?: unknown }>;
}

/** Returns `true` when the request was handled by this route module. */
export async function handleDomainsOpsSalesRoutes(deps: DomainsOpsSalesRouteDeps): Promise<boolean> {
  const {
    req, res, resource, id, operation, method, principalId, operator, inspectorEnabled,
    streams, store, runtime, tradeStore, approvalStore, writeAudit, customer360,
    opsStore, salesStore, integrationService, workflowEngine,
    json, body, requireOperator, requireChatDomain, makeTradeSettler, executeApprovedRecord,
  } = deps;

  if (resource === "trading") {
    if (id && operation && ["status", "cancel", "events"].includes(operation)) {
      const job = tradeStore.getJob(id);
      if (job) requireChatDomain("wealth", job.personaId);
    }
    if (id && operation === "portfolio" && method === "GET") {
      requireChatDomain("wealth", id);
      json(res, tradeStore.snapshotFor(id));
      return true;
    }
    if (id === "tax-harvest" && !operation && method === "POST") {
      const input = await body(req, taxHarvestPreviewInputSchema);
      requireChatDomain("wealth", input.personaId);
      try {
        json(res, tradeStore.analyzeTaxHarvest(input.personaId, input.symbol, input.shares));
        return true;
      } catch (err) {
        throw new ApiError(400, "tax_harvest_invalid", err instanceof Error ? err.message : "Could not run tax-loss harvesting analysis.");
      }
    }
    if (id === "jobs" && !operation && method === "POST") {
      const input = await body(req, tradeJobCreateInputSchema);
      requireChatDomain("wealth", input.personaId);
      const legs = input.legs.map((l) => ({ ...l, symbol: l.symbol.toUpperCase(), reason: l.reason ?? "primary" as const }));
      const grossCents = tradeStore.estimateGrossCents(input.personaId, legs);
      if (approvalStore.shouldGateTrade(grossCents)) {
        const policy = approvalStore.getPolicy();
        const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const approval = approvalStore.createPending({
          targetKind: "stock_trade",
          sfieldToolRef: domainWriteToolRef,
          domain: "stock_trade",
          recordId: input.personaId,
          action: "execute_trade_bundle",
          title: `High-Value Trade Approval · ${legs.map((l) => `${l.side.toUpperCase()} ${l.shares} ${l.symbol}`).join(" + ")}`.slice(0, 120),
          summary: `Gross trade value ${usd(grossCents)} exceeds the $${policy.highRiskTradeThresholdUsd.toLocaleString("en-US")} compliance threshold. Approve to launch the timed sfield settlement job.`,
          riskLevel: "high",
          payload: { personaId: input.personaId, legs, taxHarvestAnalyzed: Boolean(input.taxHarvestAnalyzed), grossCents },
          details: [
            { label: "Gross Order Value", value: usd(grossCents) },
            { label: "Threshold", value: `$${policy.highRiskTradeThresholdUsd.toLocaleString("en-US")}` },
            { label: "Order Legs", value: legs.map((l) => `${l.side.toUpperCase()} ${l.shares} ${l.symbol}`).join(", ") },
            { label: "Tax Harvesting", value: input.taxHarvestAnalyzed ? "Analyzed" : "Skipped" },
            { label: "4-Eyes Dual Control", value: policy.defaultDualControl ? "Required" : "Inline allowed" },
          ],
          requester: operator ?? principalId,
          dualControl: policy.defaultDualControl,
        });
        json(res, { status: "pending_approval", approval, ...(operator && { approvalsView: approvalStore.view() }) }, 202);
        return true;
      }
      try {
        const job = tradeStore.startTradeJob({ ...input, actor: operator ?? principalId }, makeTradeSettler(principalId));
        json(res, job, 202);
        return true;
      } catch (err) {
        throw new ApiError(400, "trade_rejected", err instanceof Error ? err.message : "Trade order could not be queued.");
      }
    }
    if (id && operation === "status" && method === "GET") {
      const job = tradeStore.getJob(id);
      if (!job) throw new ApiError(404, "job_not_found", "Trade job not found.");
      json(res, job);
      return true;
    }
    if (id && operation === "cancel" && method === "POST") {
      const result = tradeStore.cancelJob(id);
      if (!result.ok) throw new ApiError(409, "trade_cancel_failed", result.message);
      json(res, result.job);
      return true;
    }
    if (id && operation === "events" && method === "GET") {
      const currentJob = tradeStore.getJob(id);
      if (!currentJob) throw new ApiError(404, "job_not_found", "Trade job not found.");
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      streams.add(res);
      const send = (job: typeof currentJob) => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`event: job.update\ndata: ${JSON.stringify(job)}\n\n`);
        if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
          res.end();
        }
      };
      const unsubscribe = tradeStore.subscribeJob(id, send);
      res.once("close", () => { unsubscribe(); streams.delete(res); });
      send(currentJob);
      return true;
    }
  }

  if (resource === "approvals" && !id && method === "GET") {
    json(res, approvalStore.view());
    return true;
  }
  if (resource === "approvals" && id === "policy" && !operation && method === "POST" && inspectorEnabled) {
    const next = await body(req, approvalPolicySettingsSchema.partial());
    const policy = approvalStore.updatePolicy(next);
    json(res, { policy, view: approvalStore.view() });
    return true;
  }
  if (resource === "approvals" && id && operation === "decide" && method === "POST") {
    const decisionInput = { ...await body(req, approvalDecisionInputSchema.omit({ actor: true }).extend({ actor: z.string().optional() })), actor: requireOperator() };
    const outcome = approvalStore.decide(id, decisionInput);
    if (!outcome.ok) {
      throw new ApiError(outcome.status, outcome.code, outcome.message);
    }
    if (outcome.record.status === "denied") {
      if (outcome.record.targetKind === "integration_task") {
        await integrationService.deny(outcome.record, principalId);
        await workflowEngine.resumeAfterTaskApproval(outcome.record.id, undefined, false, decisionInput.actor, decisionInput.comment);
      }
      if (outcome.record.targetKind === "workflow_step") {
        const runId = typeof outcome.record.payload.runId === "string" ? outcome.record.payload.runId : outcome.record.recordId;
        await workflowEngine.resumeAfterApproval(runId, outcome.record.id, false, decisionInput.actor, decisionInput.comment);
      }
      writeAudit.record({
        sfieldRunId: "approval_denied",
        sfieldToolRef: outcome.record.sfieldToolRef,
        domain: outcome.record.domain,
        recordId: outcome.record.recordId,
        action: outcome.record.action,
        actor: decisionInput.actor,
        summary: `Denied by ${decisionInput.actor}${decisionInput.comment ? `: ${decisionInput.comment}` : ""}`,
        status: "denied",
        approvalId: outcome.record.id,
      });
      json(res, { approval: outcome.record, view: approvalStore.view() });
      return true;
    }
    const executed = await executeApprovedRecord(principalId, outcome.record);
    json(res, {
      approval: executed.approval,
      execution: executed.execution,
      ...("taskRun" in executed ? { taskRun: executed.taskRun } : {}),
      view: approvalStore.view(),
    });
    return true;
  }

  if (resource === "admin" && id === "write-audit" && !operation && method === "GET" && inspectorEnabled) {
    json(res, {
      toolRef: domainWriteToolRef,
      entries: writeAudit.list(),
    });
    return true;
  }
  if (resource === "admin" && id === "engagement-analytics" && !operation && method === "GET" && inspectorEnabled) {
    const base = store.engagementSummary();
    const writes = writeAudit.list();
    json(res, {
      ...base,
      nbaDismissals: customer360.totalDismissalCount(),
      governedWritesTotal: writes.length,
      writesByDomain: {
        opsIncident: writes.filter((w) => w.domain === "ops_incident").length,
        salesDeal: writes.filter((w) => w.domain === "sales_deal").length,
        customer360: writes.filter((w) => w.domain === "customer360").length,
        externalConnector: writes.filter((w) => w.domain === "external_connector").length,
      },
      pendingApprovalsCount: approvalStore.pending().length,
      recentWrites: writes.slice(0, 15),
    });
    return true;
  }

  if (resource === "ops" && id === "incidents" && !operation && method === "GET") {
    json(res, opsStore.view());
    return true;
  }
  if (resource === "ops" && id === "incidents" && !operation && method === "POST") {
    const data = await body(req, incidentUpsertInputSchema);
    json(res, opsStore.upsert(data));
    return true;
  }
  if (resource === "ops" && id === "incidents" && operation === "reset" && method === "POST") {
    json(res, opsStore.reset());
    return true;
  }
  if (resource === "ops-incidents" && id && operation === "delete" && method === "POST") {
    json(res, opsStore.remove(id));
    return true;
  }
  if (resource === "ops-incidents" && id && operation === "decision" && method === "POST") {
    const data = { ...await body(req, incidentDecisionInputSchema.extend({ queueForApproval: z.boolean().optional() })), actor: requireOperator() };
    const existingInc = opsStore.findById(id);
    if (!existingInc) throw new ApiError(404, "not_found", "Incident not found.");
    if ((data.expectedUpdatedAt && data.expectedUpdatedAt !== existingInc.updatedAt) || (data.decision.endsWith("_rollback") && existingInc.rollbackStatus !== "pending")) throw new ApiError(409, "decision_unavailable", "The incident changed or has no pending rollback. Reopen the incident to review it.");
    const policy = approvalStore.getPolicy();
    const shouldQueue = Boolean(data.queueForApproval) || (
      data.decision === "approve_rollback" && policy.gateHighRiskOpsRollbacks && policy.defaultDualControl
    );
    if (shouldQueue) {
      const approval = approvalStore.createPending({
        targetKind: "domain_write",
        sfieldToolRef: domainWriteToolRef,
        domain: "ops_incident",
        recordId: existingInc.id,
        action: data.decision,
        title: `Production Rollback · ${existingInc.id} (${existingInc.currentRelease} → ${existingInc.previousRelease})`,
        summary: existingInc.summary,
        riskLevel: existingInc.severity === "P1" ? "high" : "medium",
        payload: { decision: data.decision, expectedUpdatedAt: existingInc.updatedAt, ...(data.note ? { note: data.note } : {}) },
        details: [
          { label: "Incident", value: `${existingInc.id} (${existingInc.severity})` },
          { label: "Service", value: `${existingInc.service} · ${existingInc.environment}` },
          { label: "Release Change", value: `${existingInc.currentRelease} → ${existingInc.previousRelease}` },
          { label: "Error Rate", value: `${existingInc.errorRatePct}% (p95 ${existingInc.p95LatencyMs}ms)` },
        ],
        requester: data.actor?.trim() || "On-Call SRE Commander",
        dualControl: policy.defaultDualControl,
      });
      json(res, { status: "pending_approval", approval, incident: existingInc, view: opsStore.view() }, 202);
      return true;
    }
    if (runtime) {
      const governed = await runtime.executeGovernedWrite(principalId, {
        domain: "ops_incident",
        recordId: id,
        action: data.decision,
        actor: data.actor?.trim() || "On-Call SRE Commander",
        ...(data.note ? { note: data.note } : {}),
      }, AbortSignal.timeout(5000));
      const updated = opsStore.findById(id);
      if (!updated) throw new ApiError(404, "not_found", "Incident not found.");
      json(res, { incident: updated, view: opsStore.view(), sfieldRunId: governed.sfieldRunId, auditId: governed.audit?.auditId });
      return true;
    }
    const updated = opsStore.decide(id, data);
    if (!updated) throw new ApiError(404, "not_found", "Incident not found.");
    const audit = writeAudit.record({
      sfieldRunId: "offline",
      sfieldToolRef: domainWriteToolRef,
      domain: "ops_incident",
      recordId: updated.id,
      action: data.decision,
      actor: data.actor?.trim() || "On-Call SRE Commander",
      summary: `${updated.id} → ${updated.status} (error rate ${updated.errorRatePct}%, p95 ${updated.p95LatencyMs}ms)`,
      status: "succeeded",
    });
    json(res, { incident: updated, view: opsStore.view(), auditId: audit.auditId });
    return true;
  }

  if (resource === "sales" && id === "deals" && !operation && method === "GET") {
    json(res, salesStore.view());
    return true;
  }
  if (resource === "sales" && id === "deals" && !operation && method === "POST") {
    const data = await body(req, dealUpsertInputSchema);
    json(res, salesStore.upsert(data));
    return true;
  }
  if (resource === "sales" && id === "deals" && operation === "reset" && method === "POST") {
    json(res, salesStore.reset());
    return true;
  }
  if (resource === "sales-deals" && id && operation === "delete" && method === "POST") {
    json(res, salesStore.remove(id));
    return true;
  }
  if (resource === "sales-deals" && id && operation === "decision" && method === "POST") {
    const data = { ...await body(req, dealDecisionInputSchema.extend({ queueForApproval: z.boolean().optional() })), actor: requireOperator() };
    const existingDeal = salesStore.list().find((d) => d.id.toLowerCase() === id.toLowerCase());
    if (!existingDeal) throw new ApiError(404, "not_found", "Deal not found.");
    if ((data.expectedUpdatedAt && data.expectedUpdatedAt !== existingDeal.updatedAt) || (data.decision.endsWith("_discount") && existingDeal.discountStatus !== "pending")) throw new ApiError(409, "decision_unavailable", "The deal changed or has no pending discount. Reopen the deal to review it.");
    const policy = approvalStore.getPolicy();
    const shouldQueue = Boolean(data.queueForApproval) || (
      data.decision === "approve_discount" && existingDeal.discountPct > 15 && policy.gateHighRiskSalesDiscounts && policy.defaultDualControl
    );
    if (shouldQueue) {
      const approval = approvalStore.createPending({
        targetKind: "domain_write",
        sfieldToolRef: domainWriteToolRef,
        domain: "sales_deal",
        recordId: existingDeal.id,
        action: data.decision,
        title: `Deal Desk Discount · ${existingDeal.accountName} (${existingDeal.discountPct}% off)`,
        summary: existingDeal.summary,
        riskLevel: existingDeal.discountPct > 15 ? "high" : "medium",
        payload: { decision: data.decision, expectedUpdatedAt: existingDeal.updatedAt, ...(data.note ? { note: data.note } : {}) },
        details: [
          { label: "Deal ID", value: existingDeal.id },
          { label: "Account", value: existingDeal.accountName },
          { label: "ARR", value: `$${existingDeal.arrUsd.toLocaleString("en-US")}` },
          { label: "Discount", value: `${existingDeal.discountPct}% (Standard cap: 15%)` },
        ],
        requester: data.actor?.trim() || "VP Revenue Operations",
        dualControl: policy.defaultDualControl,
      });
      json(res, { status: "pending_approval", approval, deal: existingDeal, view: salesStore.view() }, 202);
      return true;
    }
    if (runtime) {
      const governed = await runtime.executeGovernedWrite(principalId, {
        domain: "sales_deal",
        recordId: id,
        action: data.decision,
        actor: data.actor?.trim() || "VP Revenue Operations",
        ...(data.note ? { note: data.note } : {}),
      }, AbortSignal.timeout(5000));
      const updated = salesStore.list().find((d) => d.id.toLowerCase() === id.toLowerCase());
      if (!updated) throw new ApiError(404, "not_found", "Deal not found.");
      json(res, { deal: updated, view: salesStore.view(), sfieldRunId: governed.sfieldRunId, auditId: governed.audit?.auditId });
      return true;
    }
    const updated = salesStore.decide(id, data);
    if (!updated) throw new ApiError(404, "not_found", "Deal not found.");
    const audit = writeAudit.record({
      sfieldRunId: "offline",
      sfieldToolRef: domainWriteToolRef,
      domain: "sales_deal",
      recordId: updated.id,
      action: data.decision,
      actor: data.actor?.trim() || "VP Revenue Operations",
      summary: `${updated.id} (${updated.accountName}) → ${updated.stage} (${updated.discountStatus}, ${updated.winProbabilityPct}% prob.)`,
      status: "succeeded",
    });
    json(res, { deal: updated, view: salesStore.view(), auditId: audit.auditId });
    return true;
  }

  return false;
}
