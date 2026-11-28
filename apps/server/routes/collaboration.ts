/**
 * Collaboration, Handoffs, Living Watchcards, Agent Delegation, Knowledge RAG,
 * MCP Server, AG-UI Streaming, and sfield Memory HTTP routes.
 * Extracted from `apps/server/http.ts` for clean separation of concerns.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { coBrowseSlidersSchema, createHandoffInputSchema } from "../../../packages/contracts/handoff";
import {
  createDelegationPassInputSchema,
  createWatchcardInputSchema,
  runNegotiationInputSchema,
  scenarioPlanInputSchema,
} from "../../../packages/contracts/nextgen-chat";
import type { CustomerProfileStore } from "../../../packages/customer-profiles";
import { agUiRunInputSchema, streamAgUiRun } from "../ag-ui";
import type { AgentDelegationStore } from "../agent-delegation";
import type { ApprovalStore } from "../approval-store";
import { handleCepMcpRequest } from "../cep-mcp-server";
import type { GatewaySettings } from "../gateway";
import type { HandoffStore } from "../handoff-store";
import type { IntegrationTaskService } from "../integration-tasks";
import type { KnowledgeBaseStore } from "../knowledge-base";
import type { McpExposureStore } from "../mcp-exposure-store";
import { domainWriteToolRef, principalFor, type Runtime } from "../runtime";
import { SlashCommandService } from "@sfield/core";
import { createSurfaceBinder, type SealedSurfaceAction } from "../../../packages/sphoton";
import type { SphotonCatalogService } from "../sphoton-catalog";
import { hydrateTenantSlashCommands, persistTenantSlashCommands } from "../slash-commands";
import { serverTenantId } from "../tenant";
import type { ExperienceService } from "../service";
import { ApiError, type Store } from "../store";
import type { WatchcardStore } from "../watchcard-store";
import type { WriteAuditStore } from "../write-audit";

export interface CollaborationRouteDeps {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  origin: string;
  resource: string;
  id: string | undefined;
  operation: string | undefined;
  method: string | undefined;
  principalId: string;
  operator: string | undefined;
  viewer: { customer?: string; operator?: string };
  inspectorEnabled: boolean;
  streams: Set<ServerResponse>;
  store: Store;
  runtime: Runtime | null;
  gateway: GatewaySettings | null;
  dataDir: string;
  experience: ExperienceService;
  profileStore: CustomerProfileStore;
  approvalStore: ApprovalStore;
  writeAudit: WriteAuditStore;
  handoffStore: HandoffStore;
  watchcardStore: WatchcardStore;
  agentDelegation: AgentDelegationStore;
  knowledgeBase: KnowledgeBaseStore;
  integrationService: IntegrationTaskService;
  mcpExposure: McpExposureStore;
  sphotonCatalog: SphotonCatalogService;
  now: () => number;
  json: (res: ServerResponse, data: unknown, status?: number) => void;
  body: <S extends z.ZodTypeAny>(req: IncomingMessage, schema: S, limit?: number) => Promise<z.output<S>>;
  requireOperator: () => string;
}

/** Returns `true` when the request was handled by this route module. */
export async function handleCollaborationAndProtocolRoutes(deps: CollaborationRouteDeps): Promise<boolean> {
  const {
    req, res, url, origin, resource, id, operation, method, principalId, operator, viewer,
    inspectorEnabled, streams, store, runtime, gateway, dataDir, experience, profileStore,
    approvalStore, writeAudit, handoffStore, watchcardStore, agentDelegation, knowledgeBase,
    integrationService, mcpExposure, sphotonCatalog, now, json, body, requireOperator,
  } = deps;

  if (resource === "admin" && id === "handoffs" && inspectorEnabled) {
    const actor = requireOperator();
    if (!operation && method === "GET") { json(res, handoffStore.view()); return true; }
    if (operation === "claim" && method === "POST") {
      const { handoffId } = await body(req, z.object({ handoffId: z.string().min(3).max(64) }).strict());
      const ticket = handoffStore.claim(handoffId, actor);
      if (!ticket) throw new ApiError(404, "handoff_not_found", "Handoff ticket not found.");
      json(res, { ticket, view: handoffStore.view() });
      return true;
    }
    if (operation === "reply" && method === "POST") {
      const { handoffId, text } = await body(req, z.object({ handoffId: z.string().min(3).max(64), text: z.string().trim().min(1).max(2000) }).strict());
      const ticket = handoffStore.addReply(handoffId, actor, text, "agent");
      if (!ticket) throw new ApiError(404, "handoff_not_found", "Handoff ticket not found.");
      json(res, { ticket, view: handoffStore.view() });
      return true;
    }
    if (operation === "resolve" && method === "POST") {
      const { handoffId, resolutionNote } = await body(req, z.object({ handoffId: z.string().min(3).max(64), resolutionNote: z.string().max(300).optional() }).strict());
      const ticket = handoffStore.resolve(handoffId, actor, resolutionNote);
      if (!ticket) throw new ApiError(404, "handoff_not_found", "Handoff ticket not found.");
      json(res, { ticket, view: handoffStore.view() });
      return true;
    }
    if (operation === "propose" && method === "POST") {
      const input = await body(req, z.object({
        handoffId: z.string().min(3).max(64),
        title: z.string().trim().min(2).max(120),
        summary: z.string().trim().min(2).max(400),
        actionLabel: z.string().trim().min(2).max(60).optional(),
        updates: z.record(z.string(), z.string()),
      }).strict(), 16 * 1024);
      const ticket = handoffStore.pushProposal(input.handoffId, actor, input);
      if (!ticket) throw new ApiError(404, "handoff_not_found", "Handoff ticket not found.");
      json(res, { ticket, view: handoffStore.view() });
      return true;
    }
    throw new ApiError(404, "not_found", "This item is unavailable.");
  }

  if (resource === "chat" && id === "commit-scenario" && !operation && method === "POST") {
    const plan = await body(req, scenarioPlanInputSchema, 16 * 1024);
    const profile = profileStore.findByPersonaId(plan.personaId);
    const actor = operator ?? profile?.displayName ?? plan.personaId;
    const updates: Record<string, string> = { "goal.target": String(Math.round(plan.targetGoalUsd)) };
    const summary = `Committed "${plan.scenarioName}": $${plan.monthlyDepositUsd.toLocaleString("en-US")}/mo for ${plan.horizonMonths} mo (${plan.equityAllocationPct}% equity, ${plan.expectedReturnPct}% est. return → projected $${Math.round(plan.projectedEndingUsd).toLocaleString("en-US")}).`;
    const approval = approvalStore.createPending({
      targetKind: "domain_write",
      sfieldToolRef: domainWriteToolRef,
      domain: "customer360",
      recordId: plan.personaId,
      action: "commit_parallel_future",
      title: `Parallel Future Commit · ${plan.scenarioName}`,
      summary,
      riskLevel: plan.monthlyDepositUsd >= 5000 ? "high" : "low",
      payload: { updates, plan },
      details: [
        { label: "Scenario", value: plan.scenarioName },
        { label: "Monthly Contribution", value: `$${plan.monthlyDepositUsd.toLocaleString("en-US")}/mo` },
        { label: "Horizon & Return", value: `${plan.horizonMonths} mo @ ${plan.expectedReturnPct}%` },
        { label: "Projected Ending Value", value: `$${Math.round(plan.projectedEndingUsd).toLocaleString("en-US")}` },
      ],
      requester: actor,
      dualControl: false,
    });
    if (profile) profileStore.applyBindings(plan.personaId, updates, now());
    approvalStore.decide(approval.id, { decision: "approve", actor, comment: "Committed directly from Parallel Futures simulator" });
    const audit = writeAudit.record({
      sfieldRunId: `sim_${approval.id.slice(0, 12)}`,
      sfieldToolRef: domainWriteToolRef,
      domain: "customer360",
      recordId: plan.personaId,
      action: "commit_parallel_future",
      actor,
      summary,
      status: "succeeded",
      approvalId: approval.id,
    });
    approvalStore.markExecuted(approval.id, { summary, sfieldRunId: audit.sfieldRunId, auditId: audit.auditId });
    json(res, { committed: true, summary, approvalId: approval.id, auditId: audit.auditId, payloadDigest: approval.payloadDigest }, 201);
    return true;
  }

  if (resource === "watchcards") {
    if (!id && method === "GET") {
      const personaId = url.searchParams.get("personaId") ?? undefined;
      json(res, { watchcards: watchcardStore.list(personaId) });
      return true;
    }
    if (id === "stream" && !operation && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      streams.add(res);
      res.write(`event: watchcard.connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      const personaId = url.searchParams.get("personaId");
      const unsub = watchcardStore.subscribe((card) => {
        if ((!personaId || card.personaId === personaId) && !res.writableEnded) {
          res.write(`event: watchcard.update\ndata: ${JSON.stringify(card)}\n\n`);
        }
      });
      const hb = setInterval(() => { if (!res.writableEnded) res.write(": keepalive\n\n"); }, 15_000);
      hb.unref();
      res.once("close", () => { unsub(); clearInterval(hb); streams.delete(res); });
      return true;
    }
    if (!id && method === "POST") {
      const input = await body(req, createWatchcardInputSchema, 16 * 1024);
      const watchcard = watchcardStore.create(input, profileStore);
      json(res, { watchcard, watchcards: watchcardStore.list(watchcard.personaId) }, 201);
      return true;
    }
    if (id && operation === "simulate" && method === "POST") {
      const card = watchcardStore.findById(id);
      if (!card) throw new ApiError(404, "watchcard_not_found", "Watchcard not found.");
      const observed = card.operator === "gte" ? Math.max(card.thresholdUsd, card.currentValueUsd) + 250 : Math.max(0, Math.min(card.thresholdUsd, card.currentValueUsd) - 250);
      const approval = approvalStore.createPending({
        targetKind: "domain_write",
        sfieldToolRef: domainWriteToolRef,
        domain: "customer360",
        recordId: card.personaId,
        action: "watchcard_triggered_action",
        title: `Living Watchcard Triggered · ${card.title}`,
        summary: `${card.metric.replaceAll("_", " ")} crossed $${card.thresholdUsd.toLocaleString("en-US")} (observed $${observed.toLocaleString("en-US")}). Ready to execute: ${card.actionSummary}`,
        riskLevel: "medium",
        payload: { watchcardId: card.id, metric: card.metric, observedUsd: observed, actionSummary: card.actionSummary },
        details: [
          { label: "Watchcard", value: card.title },
          { label: "Condition", value: `${card.metric} ${card.operator === "gte" ? ">=" : "<="} $${card.thresholdUsd.toLocaleString("en-US")}` },
          { label: "Observed Value", value: `$${observed.toLocaleString("en-US")}` },
          { label: "Staged Action", value: card.actionSummary },
        ],
        requester: "cep:living-watchcard",
        dualControl: false,
      });
      const updated = watchcardStore.markTriggered(card.id, observed, approval.id)!;
      json(res, { watchcard: updated, approval, watchcards: watchcardStore.list(updated.personaId) });
      return true;
    }
    if (id && operation === "execute" && method === "POST") {
      const card = watchcardStore.findById(id);
      if (!card) throw new ApiError(404, "watchcard_not_found", "Watchcard not found.");
      if (card.status !== "triggered") throw new ApiError(409, "watchcard_not_triggered", "Watchcard must be triggered before execution.");
      const actor = operator ?? profileStore.findByPersonaId(card.personaId)?.displayName ?? card.personaId;
      if (card.approvalId) {
        approvalStore.decide(card.approvalId, { decision: "approve", actor, comment: "1-tap sign-off from Living Watchcard" });
        approvalStore.markExecuted(card.approvalId, { summary: `Executed Living Watchcard: ${card.actionSummary}`, sfieldRunId: `wch_${card.id}` });
      }
      const audit = writeAudit.record({
        sfieldRunId: `wch_${card.id}`,
        sfieldToolRef: domainWriteToolRef,
        domain: "customer360",
        recordId: card.personaId,
        action: "watchcard_executed",
        actor,
        summary: `Living Watchcard "${card.title}" executed: ${card.actionSummary}`,
        status: "succeeded",
        ...(card.approvalId ? { approvalId: card.approvalId } : {}),
      });
      const updated = watchcardStore.markExecuted(card.id, audit.auditId)!;
      json(res, { watchcard: updated, auditId: audit.auditId, watchcards: watchcardStore.list(updated.personaId) });
      return true;
    }
    if (id && operation === "dismiss" && method === "POST") {
      const updated = watchcardStore.dismiss(id);
      if (!updated) throw new ApiError(404, "watchcard_not_found", "Watchcard not found.");
      json(res, { watchcard: updated, watchcards: watchcardStore.list(updated.personaId) });
      return true;
    }
  }

  if (resource === "agent-delegation") {
    if (!id && method === "GET") {
      const personaId = url.searchParams.get("personaId") ?? undefined;
      json(res, agentDelegation.view(personaId));
      return true;
    }
    if (id === "pass" && !operation && method === "POST") {
      const input = await body(req, createDelegationPassInputSchema, 8 * 1024);
      const pass = agentDelegation.mintPass(input);
      json(res, { pass, view: agentDelegation.view(pass.personaId) }, 201);
      return true;
    }
    if (id === "revoke" && !operation && method === "POST") {
      const { passId } = await body(req, z.object({ passId: z.string().min(3).max(80) }).strict());
      const pass = agentDelegation.revokePass(passId);
      if (!pass) throw new ApiError(404, "pass_not_found", "Delegation pass not found.");
      json(res, { pass, view: agentDelegation.view(pass.personaId) });
      return true;
    }
    if (id === "negotiate" && !operation && method === "POST") {
      const input = await body(req, runNegotiationInputSchema, 16 * 1024);
      const session = await agentDelegation.runNegotiation(input, {
        origin,
        principalId,
        profileStore,
        integrationService,
        knowledgeBase,
        approvalStore,
        writeAudit,
      });
      json(res, { session, view: agentDelegation.view(session.personaId) }, session.status === "paused_for_approval" ? 202 : 200);
      return true;
    }
    if (id === "approve" && !operation && method === "POST") {
      const { sessionId } = await body(req, z.object({ sessionId: z.string().min(3).max(80) }).strict());
      const existing = agentDelegation.view().negotiations.find((n) => n.sessionId === sessionId);
      if (!existing) throw new ApiError(404, "negotiation_not_found", "Negotiation session not found.");
      const actor = operator ?? profileStore.findByPersonaId(existing.personaId)?.displayName ?? existing.personaId;
      const session = agentDelegation.approveNegotiation(sessionId, actor, approvalStore, writeAudit)!;
      json(res, { session, view: agentDelegation.view(session.personaId) });
      return true;
    }
  }

  if (resource === "knowledge-search" && !id && method === "POST") {
    const { query } = await body(req, z.object({ query: z.string().trim().min(2).max(400) }).strict());
    json(res, knowledgeBase.search(query, 3));
    return true;
  }

  if (resource === "handoffs") {
    if (id === "active" && !operation && method === "GET") {
      const personaId = url.searchParams.get("personaId") ?? "";
      const ticket = personaId ? handoffStore.findActiveForPersona(personaId) ?? null : null;
      json(res, { ticket });
      return true;
    }
    if (id && !operation && method === "GET") {
      const ticket = handoffStore.findById(id);
      if (!ticket) throw new ApiError(404, "handoff_not_found", "Handoff ticket not found.");
      json(res, { ticket });
      return true;
    }
    if (id && operation === "stream" && method === "GET") {
      const existing = handoffStore.findById(id);
      if (!existing) throw new ApiError(404, "handoff_not_found", "Handoff ticket not found.");
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      streams.add(res);
      res.write(`event: handoff.update\ndata: ${JSON.stringify(existing)}\n\n`);
      const unsub = handoffStore.subscribe(id, (next) => {
        if (!res.writableEnded) res.write(`event: handoff.update\ndata: ${JSON.stringify(next)}\n\n`);
      });
      const hb = setInterval(() => { if (!res.writableEnded) res.write(": keepalive\n\n"); }, 15_000);
      hb.unref();
      res.once("close", () => { unsub(); clearInterval(hb); streams.delete(res); });
      return true;
    }
    if (id && operation === "cobrowse" && method === "POST") {
      const input = await body(req, z.object({
        updatedBy: z.enum(["advisor", "customer"]).optional(),
        active: z.boolean().optional(),
        title: z.string().trim().min(1).max(120).optional(),
        sliders: coBrowseSlidersSchema.partial().optional(),
      }).strict(), 16 * 1024);
      const role = input.updatedBy ?? (operator ? "advisor" : "customer");
      const ticket = handoffStore.updateCoBrowse(id, role, input);
      if (!ticket) throw new ApiError(404, "handoff_not_found", "Handoff ticket not found.");
      json(res, { ticket });
      return true;
    }
    if (id && operation === "proposal" && method === "POST") {
      const { decision } = await body(req, z.object({ decision: z.enum(["accepted", "declined"]) }).strict());
      const existing = handoffStore.findById(id);
      if (!existing?.coBrowse?.proposal) throw new ApiError(404, "proposal_not_found", "No pending advisor proposal.");
      let auditId: string | undefined;
      if (decision === "accepted") {
        const proposal = existing.coBrowse.proposal;
        const updates = proposal.updates;
        if (Object.keys(updates).length > 0) {
          profileStore.applyBindings(existing.personaId, updates, now());
        }
        const audit = writeAudit.record({
          sfieldRunId: `cobrowse_${proposal.id}`,
          sfieldToolRef: domainWriteToolRef,
          domain: "customer360",
          recordId: existing.personaId,
          action: "cobrowse_proposal_signed",
          actor: existing.customerName,
          summary: `Customer signed Advisor-Proposed card "${proposal.title}" by ${proposal.proposedBy}: ${JSON.stringify(updates)}`,
          status: "succeeded",
        });
        auditId = audit.auditId;
      }
      const ticket = handoffStore.decideProposal(id, decision, auditId);
      json(res, { ticket, ...(auditId ? { auditId } : {}) });
      return true;
    }
    if (id && operation === "share-card" && method === "POST") {
      const input = await body(req, z.object({
        turnId: z.string().max(80).optional(),
        prompt: z.string().trim().min(1).max(600),
        sharedBy: z.enum(["advisor", "customer"]).default("advisor"),
        sharedByName: z.string().trim().min(1).max(80),
        experience: z.record(z.string(), z.unknown()),
      }).strict(), 256 * 1024);
      const ticket = handoffStore.shareCard(id, input);
      if (!ticket) throw new ApiError(404, "handoff_not_found", "Handoff ticket not found.");
      json(res, { ticket });
      return true;
    }
    if (id && operation === "close" && method === "POST") {
      const existing = handoffStore.findById(id);
      if (!existing) throw new ApiError(404, "handoff_not_found", "Handoff ticket not found.");
      const ticket = handoffStore.resolve(id, existing.customerName, "Closed by customer from chat.");
      json(res, { ticket });
      return true;
    }
    if (id && operation === "reply" && method === "POST") {
      const { text, role, author } = await body(req, z.object({
        text: z.string().trim().min(1).max(2000),
        role: z.enum(["customer", "agent"]).optional(),
        author: z.string().trim().min(1).max(80).optional(),
      }).strict());
      const existing = handoffStore.findById(id);
      if (!existing) throw new ApiError(404, "handoff_not_found", "Handoff ticket not found.");
      const effectiveRole = role ?? "customer";
      const effectiveAuthor = author ?? (effectiveRole === "agent" ? (existing.assignedAgent ?? "Wealth Advisor") : existing.customerName);
      const ticket = handoffStore.addReply(id, effectiveAuthor, text, effectiveRole);
      json(res, { ticket });
      return true;
    }
    if (!id && method === "POST") {
      const input = await body(req, createHandoffInputSchema, 16 * 1024);
      const profile = profileStore.findByPersonaId(input.personaId);
      const customerSnapshot: Record<string, string> = profile ? {
        Customer: profile.displayName,
        Account: profile.accountFundingStatus,
        Beneficiary: profile.beneficiaryStatus,
        ...(profile.cashCents != null ? { Cash: `$${(profile.cashCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}` } : {}),
        ...(profile.equityCents != null ? { Equities: `$${(profile.equityCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}` } : {}),
      } : {};
      let recentTranscript: Array<{ role: "user" | "assistant"; text: string }> = [];
      try {
        const conv = store.conversation(input.conversationId, principalId, viewer);
        const turns = await experience.conversationTurns(conv);
        recentTranscript = turns.slice(-5).flatMap((t) => [
          { role: "user" as const, text: t.message },
          ...(t.experience?.intro ? [{ role: "assistant" as const, text: t.experience.intro }] : []),
        ]);
      } catch { /* conversation may be external or brand new */ }
      const ticket = handoffStore.create({
        conversationId: input.conversationId,
        personaId: input.personaId,
        customerName: profile?.displayName ?? input.personaId,
        domain: input.domain,
        reason: input.reason,
        priority: input.priority,
        assignedAgent: input.assignedAgent,
        customerSnapshot,
        recentTranscript,
      });
      json(res, { ticket }, 201);
      return true;
    }
  }

  if (resource === "mcp" && !id && method === "POST") {
    const actor = requireOperator();
    const out = await handleCepMcpRequest(await body(req, z.unknown(), 64 * 1024), {
      integrationService,
      knowledgeBase,
      principalId,
      operatorName: actor,
      runtime,
      exposureConfig: mcpExposure.get(),
    });
    res.writeHead(out.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...out.headers });
    res.end(out.body === undefined ? "" : JSON.stringify(out.body));
    return true;
  }

  if (resource === "ag-ui" && !id && method === "POST") {
    const actor = requireOperator();
    const input = await body(req, agUiRunInputSchema, 48 * 1024);
    await streamAgUiRun(res, input, {
      integrationService,
      principalId,
      operatorName: actor,
      gateway,
      dataDir,
    });
    return true;
  }

  if (resource === "memory") {
    if (!runtime) throw new ApiError(503, "sfield_runtime_required", "Connect a model gateway to enable sfield MemoryService.");
    if (!id && method === "GET") {
      const items = await runtime.listMemory(principalId);
      json(res, { items });
      return true;
    }
    if (!id && method === "POST") {
      const input = await body(req, z.object({
        kind: z.enum(["preference", "fact"]).default("preference"),
        content: z.string().trim().min(2).max(500),
        key: z.string().trim().min(1).max(64).optional(),
      }).strict());
      try {
        const item = await runtime.rememberMemory(principalId, input);
        json(res, { item, items: await runtime.listMemory(principalId) }, 201);
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Could not save memory item.";
        throw new ApiError(400, "memory_rejected", msg);
      }
    }
    if (id === "forget" && !operation && method === "POST") {
      const { id: memoryId } = await body(req, z.object({ id: z.string().trim().min(2).max(120) }).strict());
      const receipt = await runtime.forgetMemory(principalId, memoryId);
      json(res, { receipt, items: await runtime.listMemory(principalId) });
      return true;
    }
  }

  // sphoton SurfaceBinder over headless @sfield/core: sfield owns tools & execution, sphoton owns UI stitching & HMAC action sealing.
  if (resource === "surfaces") {
    if (!runtime) throw new ApiError(503, "sfield_runtime_required", "Connect a model gateway to enable sphoton SurfaceBinder.");
    const binder = createSurfaceBinder(runtime.sfieldInstance, { signingSecret: sphotonCatalog.signingSecret });
    if (id === "schemas" && !operation && method === "GET") {
      json(res, { tools: binder.inspectSchemas() });
      return true;
    }
    if (id === "stitch" && !operation && method === "POST") {
      const input = await body(req, z.object({
        personaId: z.string().trim().min(1).max(64).optional(),
        template: z.object({
          component: z.string().trim().min(1).max(80),
          props: z.record(z.string(), z.unknown()),
          actions: z.array(z.object({
            id: z.string().trim().min(1).max(64),
            label: z.string().trim().min(1).max(80),
            toolRef: z.string().trim().min(1).max(120),
            inputs: z.record(z.string(), z.unknown()),
            preset: z.enum(["read_only", "supervised", "bounded_auto"]).optional(),
          }).strict()).optional(),
        }).strict(),
        sources: z.record(z.string(), z.object({
          toolRef: z.string().trim().min(1).max(120),
          inputs: z.record(z.string(), z.unknown()),
        }).strict()),
        strictSchemaValidation: z.boolean().optional(),
      }).strict(), 64 * 1024);
      const stitched = await binder.stitch({
        principal: principalFor(principalId, input.personaId ? { personaId: input.personaId, domainId: "wealth" } : undefined),
        template: input.template,
        sources: input.sources as Record<string, { toolRef: string; inputs: import("@sfield/core").JsonObject }>,
        strictSchemaValidation: input.strictSchemaValidation,
      });
      json(res, stitched);
      return true;
    }
    if (id === "action" && !operation && method === "POST") {
      const input = await body(req, z.object({
        personaId: z.string().trim().min(1).max(64).optional(),
        action: z.object({
          surfaceId: z.string(),
          actionId: z.string(),
          label: z.string(),
          toolRef: z.string(),
          preset: z.enum(["read_only", "supervised", "bounded_auto"]),
          resolvedInputs: z.record(z.string(), z.unknown()),
          inputSlots: z.record(z.string(), z.object({ field: z.string(), default: z.unknown().optional() })),
          seal: z.string(),
        }).strict(),
        formInputs: z.record(z.string(), z.unknown()).optional(),
      }).strict(), 32 * 1024);
      const outcome = await binder.dispatchAction({
        principal: principalFor(principalId, input.personaId ? { personaId: input.personaId, domainId: "wealth" } : undefined),
        action: input.action as SealedSurfaceAction,
        formInputs: input.formInputs as Record<string, import("@sfield/core").JsonValue> | undefined,
      });
      json(res, outcome, outcome.status === "denied" ? 403 : outcome.status === "pending_approval" ? 202 : 200);
      return true;
    }
  }

  // ── Tenant-Configurable Slash Commands (backed by sf.commands) ────────────
  if (resource === "slash-commands") {
    const getCommandService = (): SlashCommandService => {
      if (runtime?.sfieldInstance) return runtime.sfieldInstance.commands;
      const offline = new SlashCommandService();
      hydrateTenantSlashCommands(offline, dataDir, serverTenantId);
      return offline;
    };

    if (!id && !operation && method === "GET") {
      const domain = url.searchParams.get("domain") || undefined;
      const includeDisabled = url.searchParams.get("includeDisabled") === "true" && Boolean(operator);
      const svc = getCommandService();
      json(res, {
        tenantId: serverTenantId,
        hasOverride: svc.hasTenantOverride(serverTenantId),
        commands: svc.list({ tenantId: serverTenantId, ...(domain ? { domain } : {}), includeDisabled }),
      });
      return true;
    }
    if (!id && !operation && method === "POST") {
      requireOperator();
      const input = await body(req, z.object({
        command: z.string().trim().min(1).max(34),
        label: z.string().trim().min(1).max(80),
        hint: z.string().trim().max(160).default(""),
        action: z.string().trim().min(1).max(32).default("prompt"),
        prompt: z.string().max(600).optional(),
        toolRef: z.string().max(120).optional(),
        domain: z.string().max(48).optional(),
        enabled: z.boolean().optional(),
      }).strict(), 16 * 1024);
      const svc = getCommandService();
      const saved = svc.upsert(serverTenantId, input);
      persistTenantSlashCommands(svc, dataDir, serverTenantId);
      json(res, {
        tenantId: serverTenantId,
        command: saved,
        commands: svc.list({ tenantId: serverTenantId, includeDisabled: true }),
      }, 201);
      return true;
    }
    if (!operation && method === "DELETE" && (id || url.searchParams.get("command"))) {
      requireOperator();
      const target = id ? decodeURIComponent(id) : String(url.searchParams.get("command") ?? "");
      const svc = getCommandService();
      const removed = svc.remove(serverTenantId, target);
      persistTenantSlashCommands(svc, dataDir, serverTenantId);
      json(res, {
        tenantId: serverTenantId,
        removed,
        commands: svc.list({ tenantId: serverTenantId, includeDisabled: true }),
      });
      return true;
    }
  }

  return false;
}
