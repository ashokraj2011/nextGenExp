/**
 * Workflows, External Connectors, Action Flows, Document Extraction, and Proactive Event SSE routes.
 * Extracted from `apps/server/http.ts` for clean separation of concerns.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { actionFlowUpsertSchema } from "../../../packages/contracts/action-flow";
import { connectorInvokeInputSchema, connectorUpsertSchema } from "../../../packages/contracts/connector";
import type { DomainPackId } from "../../../packages/contracts/domain-packs";
import { proactiveTriggerInputSchema } from "../../../packages/contracts/proactive-events";
import { recommendationArbitrateToolRef } from "../../../packages/contracts/recommendation-provider";
import { workflowDefinitionUpsertSchema } from "../../../packages/contracts/workflow-definition";
import type { CustomerProfileStore } from "../../../packages/customer-profiles";
import demo from "../../../fixtures/host.json";
import type { ActionFlowStore } from "../action-flow-store";
import type { ApprovalStore } from "../approval-store";
import type { ConnectorStore } from "../connector-store";
import { extractDocumentAction } from "../document-extractor";
import type { GatewaySettings } from "../gateway";
import type { ProactiveEventStore } from "../proactive-engine";
import type { PublicationReviews } from "../publication-reviews";
import { connectorInvokeToolRef, domainWriteToolRef, type Runtime } from "../runtime";
import { ApiError } from "../store";
import type { WorkflowEngine } from "../workflow-engine";
import { generateWorkflowWithLlm } from "../workflow-generator";
import type { WriteAuditStore } from "../write-audit";

const idPattern = /^[A-Za-z0-9._-]{1,80}$/;

export interface WorkflowsConnectorsRouteDeps {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  resource: string;
  id: string | undefined;
  operation: string | undefined;
  method: string | undefined;
  principalId: string;
  operator: string | undefined;
  selectedProfile: string | undefined;
  customerSession: boolean;
  inspectorEnabled: boolean;
  streams: Set<ServerResponse>;
  runtime: Runtime | null;
  gateway: GatewaySettings | null;
  dataDir: string;
  membership: { chat: (domain: DomainPackId, personaId: string, operator?: string) => boolean };
  connectorStore: ConnectorStore;
  approvalStore: ApprovalStore;
  publicationReviews: PublicationReviews;
  actionFlowStore: ActionFlowStore;
  workflowEngine: WorkflowEngine;
  proactiveStore: ProactiveEventStore;
  profileStore: CustomerProfileStore;
  writeAudit: WriteAuditStore;
  json: (res: ServerResponse, data: unknown, status?: number) => void;
  body: <S extends z.ZodTypeAny>(req: IncomingMessage, schema: S, limit?: number) => Promise<z.output<S>>;
  requireOperator: () => string;
}

export async function handleWorkflowsAndConnectorsRoutes(deps: WorkflowsConnectorsRouteDeps): Promise<boolean> {
  const {
    req, res, url, resource, id, operation, method, principalId, operator, selectedProfile,
    customerSession, inspectorEnabled, streams, runtime, gateway, dataDir, membership,
    connectorStore, approvalStore, actionFlowStore, workflowEngine, proactiveStore,
    profileStore, writeAudit, json, body, requireOperator,
  } = deps;
  const requestPublication = (action: string, input: unknown) => json(res, deps.publicationReviews.request(action, input, {
    scope: "tenant", principalId, operator: requireOperator(),
  }), 202);

  if (resource === "admin" && id === "recommendation-providers" && !operation && method === "GET" && inspectorEnabled) {
    json(res, {
      toolRef: recommendationArbitrateToolRef,
      writeToolRef: domainWriteToolRef,
      connectorToolRef: connectorInvokeToolRef,
      providers: runtime?.recommendationProviderDescriptors() ?? [],
    });
    return true;
  }
  if (resource === "admin" && id === "connectors" && !operation && method === "GET" && inspectorEnabled) {
    json(res, { connectors: connectorStore.list() });
    return true;
  }
  if (resource === "admin" && id === "connectors" && !operation && method === "POST" && inspectorEnabled) {
    const data = await body(req, connectorUpsertSchema);
    requestPublication("connectors", data);
    return true;
  }
  if (resource === "admin" && id === "connector-delete" && !operation && method === "POST" && inspectorEnabled) {
    const { id: connId } = await body(req, z.object({ id: z.string().regex(idPattern) }).strict());
    requestPublication("connector-delete", { id: connId });
    return true;
  }
  if (resource === "admin" && id === "connector-test" && !operation && method === "POST" && inspectorEnabled) {
    const { id: connId } = await body(req, z.object({ id: z.string().regex(idPattern) }).strict());
    json(res, await connectorStore.testConnector(connId));
    return true;
  }
  if (
    ((resource === "admin" && id === "connector-invoke" && !operation && inspectorEnabled)
      || (resource === "connectors" && id === "invoke" && !operation))
    && method === "POST"
  ) {
    const rawInput = await body(req, connectorInvokeInputSchema);
    const action = rawInput.action ?? "invoke";
    const actor = requireOperator();
    const payload = rawInput.payload ?? {};
    const conn = connectorStore.findById(rawInput.connectorId);
    if (!conn) throw new ApiError(404, "not_found", "Connector not found.");
    if (!conn.enabled) throw new ApiError(409, "connector_disabled", `Connector "${conn.name}" is disabled.`);
    if (approvalStore.shouldGateConnector(conn)) {
      const approval = approvalStore.createPending({
        targetKind: "external_connector",
        sfieldToolRef: connectorInvokeToolRef,
        domain: "external_connector",
        recordId: conn.id,
        action,
        title: `External Connector · ${conn.name}`,
        summary: rawInput.note?.trim() || `Execute "${action}" against ${conn.url} (${conn.method}) via ${connectorInvokeToolRef}.`,
        riskLevel: conn.effect === "write" ? "high" : "medium",
        payload,
        details: [
          { label: "Connector", value: conn.name },
          { label: "Endpoint", value: `${conn.method} ${conn.url}` },
          { label: "Action", value: action },
          { label: "sfield Effect", value: conn.effect },
          { label: "4-Eyes Dual Control", value: (conn.dualControl || approvalStore.getPolicy().defaultDualControl) ? "Required" : "Inline allowed" },
        ],
        requester: actor,
        dualControl: conn.dualControl || approvalStore.getPolicy().defaultDualControl,
      });
      json(res, { status: "pending_approval", approval, approvalsView: approvalStore.view() }, 202);
      return true;
    }
    if (runtime) {
      const execution = await runtime.executeConnectorInvoke(principalId, {
        connectorId: conn.id,
        action,
        actor,
        payload,
      }, AbortSignal.timeout(8000));
      json(res, { status: "executed", execution });
      return true;
    }
    const execution = await connectorStore.invokeConnector(conn.id, {
      action,
      actor,
      payload,
    }, AbortSignal.timeout(8000));
    const audit = writeAudit.record({
      sfieldRunId: "offline",
      sfieldToolRef: connectorInvokeToolRef,
      domain: "external_connector",
      recordId: conn.id,
      action,
      actor,
      summary: execution.summary,
      status: "succeeded",
    });
    json(res, { status: "executed", execution: { ...execution, sfieldRunId: "offline", auditId: audit.auditId } });
    return true;
  }
  if (resource === "admin" && id === "action-flows" && !operation && method === "GET" && inspectorEnabled) {
    json(res, { flows: actionFlowStore.list() });
    return true;
  }
  if (resource === "admin" && id === "action-flows" && !operation && method === "POST" && inspectorEnabled) {
    const input = await body(req, actionFlowUpsertSchema);
    requestPublication("action-flows", input);
    return true;
  }
  if (resource === "admin" && id === "action-flow-delete" && !operation && method === "POST" && inspectorEnabled) {
    const { id: flowId } = await body(req, z.object({ id: z.string().regex(idPattern) }).strict());
    requestPublication("action-flow-delete", { id: flowId });
    return true;
  }
  if (resource === "workflows") {
    if (!id && method === "GET") {
      json(res, workflowEngine.view());
      return true;
    }
    if (id === "generate" && !operation && method === "POST" && inspectorEnabled) {
      const { prompt } = await body(req, z.object({ prompt: z.string().trim().min(4).max(800) }).strict(), 8 * 1024);
      json(res, await generateWorkflowWithLlm({
        prompt,
        gateway,
        dataDir,
        connectors: connectorStore.list(),
      }));
      return true;
    }
    if (!id && method === "POST" && inspectorEnabled) {
      const input = await body(req, workflowDefinitionUpsertSchema, 48 * 1024);
      requestPublication("workflows", input);
      return true;
    }
    if (id && operation === "delete" && method === "POST" && inspectorEnabled) {
      requestPublication("workflow-delete", { id });
      return true;
    }
    if (id && operation === "start" && method === "POST") {
      const input = await body(req, z.object({
        personaId: z.string().regex(idPattern).optional(),
        actorName: z.string().trim().min(1).max(80).optional(),
        initialInputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      }).strict());
      const personaId = input.personaId ?? demo.defaultPersonaId;
      const profile = profileStore.findByPersonaId(personaId);
      try {
        const started = await workflowEngine.startRun(id, {
          personaId,
          actorName: input.actorName ?? profile?.displayName ?? "Customer",
          initialInputs: input.initialInputs,
        });
        json(res, started, 201);
        return true;
      } catch (err) {
        throw new ApiError(404, "workflow_not_found", err instanceof Error ? err.message : "Workflow not found.");
      }
    }
  }
  if (resource === "documents" && id === "extract" && !operation && method === "POST") {
    const input = await body(req, z.object({
      fileName: z.string().trim().min(1).max(120),
      content: z.string().trim().min(5).max(8000),
    }).strict(), 16 * 1024);
    const extracted = await extractDocumentAction({
      fileName: input.fileName,
      content: input.content,
      gateway,
      dataDir,
    });
    json(res, { extracted });
    return true;
  }
  if (resource === "proactive") {
    if (id === "alerts" && !operation && method === "GET") {
      requireOperator();
      json(res, proactiveStore.view());
      return true;
    }
    if (id === "trigger" && !operation && method === "POST") {
      const input = await body(req, proactiveTriggerInputSchema, 8 * 1024);
      json(res, proactiveStore.trigger(input, principalId), 201);
      return true;
    }
    if (id && operation === "dismiss" && method === "POST") {
      const view = proactiveStore.dismiss(id, operator ? undefined : principalId);
      json(res, operator ? view : { alerts: [], activeCount: 0 });
      return true;
    }
    if (id === "stream" && !operation && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      streams.add(res);
      res.write(`event: proactive.connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      const personaId = url.searchParams.get("personaId");
      const retailProfile = customerSession || Boolean(selectedProfile) || !operator;
      const unsubscribe = proactiveStore.subscribe((alert) => {
        if (alert.principalId === principalId && alert.personaId === personaId && (!retailProfile || (alert.domain === "wealth" && (!selectedProfile || selectedProfile === personaId))) && membership.chat(alert.domain, personaId ?? "", operator) && !res.writableEnded) {
          res.write(`event: proactive.alert\ndata: ${JSON.stringify(alert)}\n\n`);
        }
      });
      const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": keepalive\n\n"); }, 15_000);
      res.once("close", () => { unsubscribe(); clearInterval(heartbeat); streams.delete(res); });
      return true;
    }
  }
  if (resource === "workflow-runs" && id) {
    if (!operation && method === "GET") {
      const run = workflowEngine.getRun(id);
      if (!run) throw new ApiError(404, "workflow_run_not_found", "Workflow run not found.");
      json(res, { run, definition: workflowEngine.getDefinition(run.workflowId) });
      return true;
    }
    if (operation === "input" && method === "POST") {
      const { inputs } = await body(req, z.object({
        inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
      }).strict());
      try {
        const run = await workflowEngine.submitInput(id, inputs);
        json(res, { run, definition: workflowEngine.getDefinition(run.workflowId) });
        return true;
      } catch (err) {
        throw new ApiError(400, "workflow_input_failed", err instanceof Error ? err.message : "Could not submit workflow input.");
      }
    }
    if (operation === "cancel" && method === "POST") {
      try {
        const run = workflowEngine.cancelRun(id);
        json(res, { run, definition: workflowEngine.getDefinition(run.workflowId) });
        return true;
      } catch (err) {
        throw new ApiError(404, "workflow_run_not_found", err instanceof Error ? err.message : "Workflow run not found.");
      }
    }
    if (operation === "events" && method === "GET") {
      const initialRun = workflowEngine.getRun(id);
      if (!initialRun) throw new ApiError(404, "workflow_run_not_found", "Workflow run not found.");
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      streams.add(res);
      const sendSnapshot = (snapshot: typeof initialRun) => {
        if (res.writableEnded) return;
        res.write(`event: workflow.update\ndata: ${JSON.stringify(snapshot)}\n\n`);
        if (snapshot.status === "completed" || snapshot.status === "cancelled" || snapshot.status === "failed") {
          res.end();
        }
      };
      const unsubscribe = workflowEngine.subscribe(id, sendSnapshot);
      const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": keepalive\n\n"); }, 15_000);
      res.once("close", () => { unsubscribe(); clearInterval(heartbeat); streams.delete(res); });
      sendSnapshot(initialRun);
      return true;
    }
  }

  return false;
}
