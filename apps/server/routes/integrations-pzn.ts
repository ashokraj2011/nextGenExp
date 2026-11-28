/**
 * Integrations Workspace & Self-Service PZN Studio HTTP routes.
 * Extracted from `apps/server/http.ts` for clean separation of concerns.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { digestJson } from "@sfield/core";
import { z } from "zod";
import type { ApprovalRecord } from "../../../packages/contracts/approval";
import {
  curlImportRequestSchema,
  draftValidateRequestSchema,
  integrationCopilotRequestSchema,
  integrationMcpDiscoverRequestSchema,
  runTaskRequestSchema,
} from "../../../packages/contracts/integration-task";
import { parseCurlToIntegrationDraft } from "../integration-curl";
import {
  pznAttributeInputSchema,
  pznContextInputSchema,
  pznCopilotRequestSchema,
  pznNamespaceInputSchema,
  pznRegisteredSfieldTools,
  pznRuleInputSchema,
  pznRuleTestRequestSchema,
  pznSfieldToolRefs,
  pznSlugSchema,
  pznTextContentInputSchema,
  pznTsEvaluateRequestSchema,
} from "../../../packages/contracts/self-service-pzn";
import type { ApprovalStore } from "../approval-store";
import type { GatewaySettings } from "../gateway";
import { runIntegrationCopilot } from "../integration-copilot";
import { IntegrationTaskError, type IntegrationTaskService, type IntegrationTaskStore } from "../integration-tasks";
import { pznGateFor, requestPznApproval } from "../pzn-approvals";
import type { PublicationReviews } from "../publication-reviews";
import type { Runtime } from "../runtime";
import { runSelfServicePznCopilot } from "../self-service-pzn-copilot";
import type { SelfServicePznStore } from "../self-service-pzn-store";
import { ApiError } from "../store";

export interface IntegrationsPznRouteDeps {
  req: IncomingMessage;
  res: ServerResponse;
  resource: string;
  id: string | undefined;
  operation: string | undefined;
  method: string | undefined;
  principalId: string;
  inspectorEnabled: boolean;
  runtime: Runtime | null;
  gateway: GatewaySettings | null;
  dataDir: string;
  approvalStore: ApprovalStore;
  publicationReviews: PublicationReviews;
  integrationTasks: IntegrationTaskStore;
  integrationService: IntegrationTaskService;
  selfServicePzn: SelfServicePznStore;
  demoMcp: (payload: unknown) => { status: number; headers: Record<string, string>; body?: unknown };
  json: (res: ServerResponse, data: unknown, status?: number) => void;
  body: <S extends z.ZodTypeAny>(req: IncomingMessage, schema: S, limit?: number) => Promise<z.output<S>>;
  requireOperator: () => string;
  enforceEvalGate: (actionLabel: string) => void;
}

/** Returns `true` when the request was handled by this route module. */
export async function handleIntegrationsAndPznRoutes(deps: IntegrationsPznRouteDeps): Promise<boolean> {
  const {
    req, res, resource, id, operation, method, principalId, inspectorEnabled,
    runtime, gateway, dataDir, approvalStore, publicationReviews, integrationTasks,
    integrationService, selfServicePzn, demoMcp, json, body, requireOperator, enforceEvalGate,
  } = deps;

  if (resource === "integrations" && inspectorEnabled) {
    const guard = async <T>(fn: () => Promise<T> | T) => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof IntegrationTaskError) {
          const status = err.code === "sfield_runtime_required" ? 503
            : err.code === "invalid_callback_signature" ? 401
            : err.code.endsWith("not_found") ? 404
            : err.code === "invalid_contract" ? 400 : 409;
          throw new ApiError(status, err.code, err.message);
        }
        if (err instanceof z.ZodError) throw new ApiError(400, "invalid_input", err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 400));
        throw err;
      }
    };
    if (!id && method === "GET") { json(res, integrationService.view()); return true; }
    if (id === "contracts" && !operation && method === "POST") {
      const raw = await body(req, z.record(z.string(), z.unknown()), 64 * 1024);
      json(res, { contract: await guard(() => integrationTasks.upsertDraft(raw)), view: integrationService.view() });
      return true;
    }
    if (id === "demo-mcp" && !operation && method === "POST") {
      const out = demoMcp(await body(req, z.unknown(), 64 * 1024));
      res.writeHead(out.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...out.headers });
      res.end(out.body === undefined ? "" : JSON.stringify(out.body));
      return true;
    }
    if (id === "integrations" && !operation && method === "POST") {
      const raw = await body(req, z.record(z.string(), z.unknown()), 16 * 1024);
      await guard(() => {
        const integration = integrationTasks.upsertIntegration(raw, true);
        if (integrationTasks.published().some((contract) => contract.integrationId === integration.id)) {
          json(res, publicationReviews.request("integration-config", integration, {
            scope: "tenant", principalId, operator: requireOperator(),
          }), 202);
        } else {
          json(res, { integration: integrationTasks.upsertIntegration(integration), view: integrationService.view() });
        }
      });
      return true;
    }
    if (id === "contracts" && operation === "validate" && method === "POST") {
      const { draft } = await body(req, draftValidateRequestSchema, 64 * 1024);
      json(res, integrationTasks.validateDraft(draft));
      return true;
    }
    if (id === "mcp" && operation === "discover" && method === "POST") {
      const { integrationId } = await body(req, integrationMcpDiscoverRequestSchema);
      json(res, await guard(() => integrationService.discoverMcp(integrationId)));
      return true;
    }
    if (id === "import" && operation === "curl" && method === "POST") {
      const input = await body(req, curlImportRequestSchema, 96 * 1024);
      json(
        res,
        await guard(() => {
          try {
            return parseCurlToIntegrationDraft(
              input,
              integrationService.view().integrations,
              (draft) => integrationTasks.validateDraft(draft),
            );
          } catch (err) {
            throw new ApiError(400, "invalid_curl", err instanceof Error ? err.message : "Could not parse cURL command.");
          }
        }),
      );
      return true;
    }
    if (id === "contracts" && operation === "delete" && method === "POST") {
      const { ref } = await body(req, z.object({ ref: z.string().min(3).max(120) }).strict());
      const deleted = await guard(() => integrationTasks.deleteDraft(ref));
      json(res, { ...deleted, view: integrationService.view() });
      return true;
    }
    if (id === "integrations" && operation === "delete" && method === "POST") {
      const { id: integrationId } = await body(req, z.object({ id: z.string().min(2).max(64) }).strict());
      const deleted = await guard(() => integrationTasks.deleteIntegration(integrationId));
      json(res, { ...deleted, view: integrationService.view() });
      return true;
    }
    if (id === "contracts" && operation === "publish" && method === "POST") {
      enforceEvalGate("publishing an integration task contract");
      const { ref } = await body(req, z.object({ ref: z.string().min(3).max(120) }).strict());
      const contract = integrationTasks.contract(ref);
      if (!contract) throw new ApiError(404, "contract_not_found", `Unknown task contract ${ref}`);
      if (contract.status !== "draft") throw new ApiError(409, "not_draft", `${ref} is already ${contract.status}.`);
      await guard(() => integrationTasks.publish(ref, true));
      const actor = requireOperator();
      const approval = approvalStore.createPending({
        targetKind: "task_publish",
        sfieldToolRef: contract.ref,
        domain: "integration",
        recordId: contract.ref,
        action: "publish_task",
        title: `Publish Integration Task · ${contract.ref}`,
        summary: `Publish ${contract.effect} task "${contract.description.slice(0, 140)}" into the live sfield runtime.`,
        riskLevel: contract.effect === "read" ? "low" : "high",
        payload: {
          ref: contract.ref, contractDigest: contract.contractDigest, bindingDigest: contract.bindingDigest,
          integrationDigest: digestJson(integrationTasks.integration(contract.integrationId) ?? null),
          preview: contract,
        },
        details: [
          { label: "Task Ref", value: contract.ref },
          { label: "Effect", value: contract.effect },
          { label: "Contract Digest", value: contract.contractDigest.slice(0, 22) },
          { label: "Binding Digest", value: contract.bindingDigest.slice(0, 22) },
        ],
        requester: actor,
        dualControl: approvalStore.getPolicy().defaultDualControl,
      });
      json(res, { status: "pending_approval", approval, view: integrationService.view() }, 202);
      return true;
    }
    if (id === "tasks" && operation === "run" && method === "POST") {
      const data = await body(req, runTaskRequestSchema, 32 * 1024);
      const out = await guard(() => integrationService.run(principalId, { ...data, requestedBy: requireOperator() }));
      json(res, out, out.approval || out.run.state === "accepted" ? 202 : 200);
      return true;
    }
    if (id === "copilot" && !operation && method === "POST") {
      const data = await body(req, integrationCopilotRequestSchema, 48 * 1024);
      json(res, await runIntegrationCopilot(data, integrationService, principalId, { operatorName: requireOperator(), gateway, dataDir }));
      return true;
    }
    if (id === "runs" && operation === "reconcile" && method === "POST") {
      const { runId } = await body(req, z.object({ runId: z.string().min(3).max(64) }).strict());
      json(res, await guard(() => integrationService.reconcile(principalId, runId)));
      return true;
    }
    if (id === "runs" && operation === "poll" && method === "POST") {
      const { runId } = await body(req, z.object({ runId: z.string().min(3).max(64) }).strict());
      json(res, await guard(() => integrationService.pollAsyncRun(principalId, runId)));
      return true;
    }
    if (id === "callbacks" && operation && method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > 64 * 1024) {
          req.resume();
          throw new ApiError(413, "request_too_large", "Callback payload is too large.");
        }
        chunks.push(chunk);
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const sigHeader = typeof req.headers["x-cep-signature"] === "string" ? req.headers["x-cep-signature"] : undefined;
      json(res, await guard(() => integrationService.completeAsyncCallback(operation, rawBody, sigHeader)));
      return true;
    }
    if (id === "resilience" && operation === "reset" && method === "POST") {
      const { integrationId } = await body(req, z.object({ integrationId: z.string().min(2).max(64) }).strict());
      json(res, { view: await guard(() => integrationService.resetResilience(integrationId)) });
      return true;
    }
    if (id === "migrate-connectors" && !operation && method === "POST") {
      const data = await body(req, z.object({ connectorId: z.string().min(1).max(64).optional() }).strict());
      json(res, publicationReviews.request(id, data, { scope: "tenant", principalId, operator: requireOperator() }), 202);
      return true;
    }
  }

  if (resource === "pzn" && inspectorEnabled) {
    const invokePzn = async <T>(toolRef: string, opName: string, payload: unknown, fallback: () => T) => {
      if (runtime) {
        return runtime.executePznTool<T>(principalId, toolRef, opName, payload);
      }
      return { data: fallback(), summary: opName, sfieldRunId: "offline", sfieldToolRef: toolRef };
    };
    const pznGate = (opName: string, args: Record<string, unknown>, _requester?: string) => (
      pznGateFor(approvalStore.getPolicy(), opName).gated
        ? requestPznApproval(approvalStore, selfServicePzn, { operation: opName, args, requester: requireOperator() })
        : null
    );
    const pendingResponse = (approval: ApprovalRecord) => {
      json(res, { status: "pending_approval", approval, workspace: selfServicePzn.getWorkspaceState() }, 202);
      return true;
    };
    if (id === "sfield-tools" && !operation && method === "GET") {
      json(res, { tools: pznRegisteredSfieldTools, runtimeConnected: Boolean(runtime) });
      return true;
    }
    if (id === "workspace" && !operation && method === "GET") {
      const out = await invokePzn(pznSfieldToolRefs.ruleMetadata, "get_workspace", {}, () => selfServicePzn.getWorkspaceState());
      json(res, out.data);
      return true;
    }
    if (id === "namespaces" && !operation && method === "POST") {
      const data = await body(req, pznNamespaceInputSchema, 32 * 1024);
      const pendingNs = pznGate("upsert_namespace", data);
      if (pendingNs) return pendingResponse(pendingNs);
      const out = await invokePzn(pznSfieldToolRefs.dataDictionary, "upsert_namespace", data, () => selfServicePzn.upsertNamespace(data));
      json(res, { namespace: out.data, sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      return true;
    }
    if (id === "namespaces" && operation === "delete" && method === "POST") {
      const { id: nsId } = await body(req, z.object({ id: pznSlugSchema }).strict());
      const pendingNsDel = pznGate("delete_namespace", { id: nsId });
      if (pendingNsDel) return pendingResponse(pendingNsDel);
      const out = await invokePzn(pznSfieldToolRefs.dataDictionary, "delete_namespace", { id: nsId }, () => { selfServicePzn.deleteNamespace(nsId); return { deleted: true }; });
      json(res, { sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      return true;
    }
    if (id === "attributes" && !operation && method === "POST") {
      const data = await body(req, pznAttributeInputSchema, 32 * 1024);
      const pendingAttr = pznGate("upsert_attribute", data);
      if (pendingAttr) return pendingResponse(pendingAttr);
      const out = await invokePzn(pznSfieldToolRefs.dataDictionary, "upsert_attribute", data, () => selfServicePzn.upsertAttribute(data));
      json(res, { attribute: out.data, sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      return true;
    }
    if (id === "attributes" && operation === "delete" && method === "POST") {
      const { namespaceId, attributeId } = await body(req, z.object({ namespaceId: pznSlugSchema, attributeId: pznSlugSchema }).strict());
      const pendingAttrDel = pznGate("delete_attribute", { namespaceId, attributeId });
      if (pendingAttrDel) return pendingResponse(pendingAttrDel);
      const out = await invokePzn(pznSfieldToolRefs.dataDictionary, "delete_attribute", { namespaceId, attributeId }, () => { selfServicePzn.deleteAttribute(namespaceId, attributeId); return { deleted: true }; });
      json(res, { sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      return true;
    }
    if (id === "contents" && !operation && method === "POST") {
      const data = await body(req, pznTextContentInputSchema, 32 * 1024);
      const out = await invokePzn(pznSfieldToolRefs.ruleMetadata, "upsert_content", data, () => selfServicePzn.upsertContent(data));
      json(res, { content: out.data, sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      return true;
    }
    if (id === "contents" && operation === "delete" && method === "POST") {
      const { contentId } = await body(req, z.object({ contentId: pznSlugSchema }).strict());
      const pendingContentDel = pznGate("delete_content", { contentId });
      if (pendingContentDel) return pendingResponse(pendingContentDel);
      const out = await invokePzn(pznSfieldToolRefs.ruleMetadata, "delete_content", { contentId }, () => { selfServicePzn.deleteContent(contentId); return { deleted: true }; });
      json(res, { sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      return true;
    }
    if (id === "rules" && !operation && method === "POST") {
      const data = await body(req, pznRuleInputSchema, 32 * 1024);
      const out = await invokePzn(pznSfieldToolRefs.ruleMetadata, "upsert_rule", data, () => selfServicePzn.upsertRule(data));
      json(res, { rule: out.data, sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      return true;
    }
    if (id === "rules" && operation === "delete" && method === "POST") {
      const { ruleId } = await body(req, z.object({ ruleId: pznSlugSchema }).strict());
      const pendingRuleDel = pznGate("delete_rule", { ruleId });
      if (pendingRuleDel) return pendingResponse(pendingRuleDel);
      const out = await invokePzn(pznSfieldToolRefs.ruleMetadata, "delete_rule", { ruleId }, () => { selfServicePzn.deleteRule(ruleId); return { deleted: true }; });
      json(res, { sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      return true;
    }
    if (id === "rules" && operation === "test" && method === "POST") {
      const data = await body(req, pznRuleTestRequestSchema, 32 * 1024);
      const out = await invokePzn(pznSfieldToolRefs.ruleMetadata, "test_rule", data, () => selfServicePzn.testRule(data));
      json(res, out.data);
      return true;
    }
    if (id === "contexts" && !operation && method === "POST") {
      const data = await body(req, pznContextInputSchema, 32 * 1024);
      const out = await invokePzn(pznSfieldToolRefs.ruleMetadata, "upsert_context", data, () => selfServicePzn.upsertContext(data));
      json(res, { context: out.data, sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      return true;
    }
    if (id === "contexts" && operation === "publish" && method === "POST") {
      enforceEvalGate("publishing a PZN context");
      const data = await body(req, z.object({
        contextId: pznSlugSchema,
        publishedBy: z.string().max(80).optional(),
        notes: z.string().max(240).optional(),
      }).strict());
      const pendingPublish = pznGate("publish_context", data, data.publishedBy);
      if (pendingPublish) return pendingResponse(pendingPublish);
      const out = await invokePzn(pznSfieldToolRefs.ruleMetadata, "publish_context", data, () => selfServicePzn.publishContext(data.contextId, data.publishedBy, data.notes));
      json(res, { publication: out.data, sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      return true;
    }
    if (id === "contexts" && operation === "unpublish" && method === "POST") {
      const { contextId } = await body(req, z.object({ contextId: pznSlugSchema }).strict());
      const pendingCtx = pznGate("unpublish_context", { contextId });
      if (pendingCtx) return pendingResponse(pendingCtx);
      const out = await invokePzn(pznSfieldToolRefs.ruleMetadata, "unpublish_context", { contextId }, () => selfServicePzn.unpublishContext(contextId));
      json(res, { context: out.data, sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      return true;
    }
    if (id === "contexts" && operation === "delete" && method === "POST") {
      const { contextId } = await body(req, z.object({ contextId: pznSlugSchema }).strict());
      const pendingCtx = pznGate("delete_context", { contextId });
      if (pendingCtx) return pendingResponse(pendingCtx);
      const out = await invokePzn(pznSfieldToolRefs.ruleMetadata, "delete_context", { contextId }, () => { selfServicePzn.deleteContext(contextId); return { deleted: true }; });
      json(res, { sfieldToolRef: out.sfieldToolRef, sfieldRunId: out.sfieldRunId, workspace: selfServicePzn.getWorkspaceState() });
      return true;
    }
    if (id === "ts" && operation === "evaluate" && method === "POST") {
      const data = await body(req, pznTsEvaluateRequestSchema, 32 * 1024);
      const out = await invokePzn(pznSfieldToolRefs.treatmentSelector, "evaluate", data, () => selfServicePzn.evaluateLiveTs(data));
      json(res, out.data);
      return true;
    }
    if (id === "copilot" && !operation && method === "POST") {
      const data = await body(req, pznCopilotRequestSchema, 48 * 1024);
      json(res, await runSelfServicePznCopilot(data, selfServicePzn, {
        gateway,
        dataDir,
        requestApproval: (opName: string, args: Record<string, unknown>) => pznGate(opName, args),
        ...(runtime ? {
          executeSfieldTool: <T>(toolRef: string, opName: string, payload?: unknown) => (
            runtime.executePznTool<T>(principalId, toolRef, opName, payload)
          ),
        } : {}),
      }));
      return true;
    }
  }

  return false;
}
