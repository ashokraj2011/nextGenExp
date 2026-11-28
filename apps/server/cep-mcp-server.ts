/**
 * Exposes CEP as a standards-compliant Streamable HTTP MCP Server (POST /api/mcp)
 * backed directly by @sfield/core's generic `SFieldMcpServer`, and publishes a
 * Google A2A Agent Card (GET /.well-known/agent.json).
 *
 * External agents (Claude, Copilot Studio, Salesforce Agentforce, Cursor) can discover and invoke:
 * - Allowlisted native sfield tools (e.g. `cep.empathy.assess@1.0.0`) directly via `sf.executions.open()`
 * - Published CEP Integration Tasks (`int.*`) through the exact same sfield governance + HITL boundary
 * - Hybrid BM25 + Vector Knowledge Base Search (`cep.knowledge.search@1.0.0`)
 */
import {
  createSFieldMcpServer,
  MCP_PROTOCOL_VERSION,
  McpExtensionStore,
  SFieldError,
  type McpExtraTool,
  type McpHttpResponse,
  type McpResourceDefinition,
  type SFieldMcpHost,
} from "@sfield/core";
import { empathyAssessToolRef } from "../../packages/contracts/empathy";
import type { IntegrationTaskService } from "./integration-tasks";
import type { KnowledgeBaseStore } from "./knowledge-base";
import type { McpExposureConfig } from "./mcp-exposure-store";
import { principalFor, type Runtime } from "./runtime";
import type { SphotonCatalogService } from "./sphoton-catalog";
import { serverTenantId } from "./tenant";

export interface CepMcpDeps {
  integrationService: IntegrationTaskService;
  knowledgeBase: KnowledgeBaseStore;
  sphotonCatalog?: SphotonCatalogService;
  principalId: string;
  operatorName: string;
  runtime?: Runtime | null;
  exposureConfig?: McpExposureConfig;
}

export const cepMcpExtensionStore = new McpExtensionStore();

const OFFLINE_MCP_HOST: SFieldMcpHost = {
  registry: {
    list: () => [],
    describe: (ref) => { throw new SFieldError("UNKNOWN_TOOL", `sfield runtime offline; tool ${ref} unavailable`); },
  },
  executions: {
    open: async () => { throw new SFieldError("STATE_UNAVAILABLE", "sfield runtime offline"); },
    resume: async () => { throw new SFieldError("STATE_UNAVAILABLE", "sfield runtime offline"); },
  },
};

/** Exposes native sfield tools, published Integration Tasks, and Knowledge Base over MCP JSON-RPC 2.0. */
export async function handleCepMcpRequest(raw: unknown, deps: CepMcpDeps): Promise<McpHttpResponse> {
  const exposure = deps.exposureConfig ?? {
    enabledToolRefs: [empathyAssessToolRef],
    includeKnowledgeSearch: true,
    includePublishedTasks: true,
  };
  const publishedContracts = exposure.includePublishedTasks
    ? deps.integrationService
        .view()
        .contracts
        .filter((c) => c.status === "published" && c.sfieldRoute !== "unavailable")
    : [];

  const extraTools: McpExtraTool[] = [
    ...publishedContracts.map((c): McpExtraTool => ({
      descriptor: {
        name: c.ref,
        description: `[CEP sfield-governed ${c.effect}] ${c.description}`,
        inputSchema: c.inputSchema as import("@sfield/core").JsonObject,
        outputSchema: c.outputSchema as import("@sfield/core").JsonObject,
        annotations: {
          title: `${c.integrationId} · ${c.taskId} v${c.version}`,
          readOnlyHint: c.effect === "read",
          destructiveHint: c.effect === "destructive",
          idempotentHint: c.idempotency.supported,
        },
      },
      handler: async (args) => {
        const out = await deps.integrationService.run(deps.principalId, {
          toolRef: c.ref,
          input: args,
          requestedBy: `mcp:${deps.operatorName}`,
        });
        if (out.approval) {
          const payload = {
            status: "pending_approval",
            runId: out.run.runId,
            approvalId: out.approval.id,
            sfieldRunId: out.run.sfieldRunId,
            message: `Held by sfield for HITL approval (${out.approval.id}). Approve in CEP /integrations or /admin/logs?source=approvals.`,
          };
          return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
        }
        const isErr = out.run.state === "failed" || out.run.state === "denied" || out.run.state === "outcome_unknown";
        const payload = {
          runId: out.run.runId,
          state: out.run.state,
          sfieldRunId: out.run.sfieldRunId,
          outcome: out.run.outcome,
          output: out.run.output,
          ...(out.run.artifact ? { artifact: out.run.artifact } : {}),
          ...(out.run.error ? { error: out.run.error } : {}),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
          ...(isErr ? { isError: true } : {}),
        };
      },
    })),
    ...(exposure.includeKnowledgeSearch ? [{
      descriptor: {
        name: "cep.knowledge.search@1.0.0",
        description: "Search CEP enterprise policy & runbook Knowledge Base using hybrid BM25 + semantic vector retrieval.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string", minLength: 2, maxLength: 400 },
            limit: { type: "integer", minimum: 1, maximum: 10 },
          },
        },
        annotations: { title: "CEP Knowledge Search", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      handler: async (args: Record<string, unknown>) => {
        const query = String(args.query ?? "").trim();
        if (!query) throw new Error("query is required");
        const limit = typeof args.limit === "number" ? Math.min(10, Math.max(1, Math.round(args.limit))) : 3;
        const res = deps.knowledgeBase.search(query, limit);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(res) }],
          structuredContent: res,
        };
      },
    }] : []),
    ...(deps.sphotonCatalog?.allPublishedVirtualTools().map((vt): McpExtraTool => ({
      descriptor: {
        name: vt.ref,
        description: `[smass Virtual Data Model · ${vt.domainId}] ${vt.description ?? vt.modelLabel}`,
        inputSchema: vt.inputs as import("@sfield/core").JsonObject,
        outputSchema: vt.outputs as import("@sfield/core").JsonObject,
        annotations: {
          title: `smass VDM · ${vt.modelLabel}`,
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const customerId = typeof args.customerId === "string" && args.customerId.trim() ? args.customerId.trim() : undefined;
        const exec = await deps.sphotonCatalog!.sfieldAdapter().executeRead({
          toolRef: vt.ref,
          inputs: args,
          scope: {
            tenantId: serverTenantId,
            domainId: vt.domainId,
            principalId: deps.principalId,
            customerId,
            mode: "customer_chat",
          },
        });
        if (exec.status !== "succeeded") {
          const payload = { status: exec.status, error: exec.error };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(payload) }],
            structuredContent: payload,
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(exec.output) }],
          structuredContent: exec.output as Record<string, unknown>,
        };
      },
    })) ?? []),
  ];

  const resources: McpResourceDefinition[] = [
    ...(deps.sphotonCatalog ? [{
      uri: "cep://smass/models",
      name: "Canonical smass Virtual Data Models & ER Schemas",
      mimeType: "application/json",
      read: () => JSON.stringify(deps.sphotonCatalog!.allDomainDataModels(), null, 2),
    }] : []),
    {
      uri: "cep://catalog/tasks",
      name: "Published CEP Integration Tasks",
      mimeType: "application/json",
      read: () => JSON.stringify(publishedContracts, null, 2),
    },
    {
      uri: "cep://knowledge/documents",
      name: "CEP Policy Knowledge Base",
      mimeType: "application/json",
      read: () => JSON.stringify(deps.knowledgeBase.view(), null, 2),
    },
    {
      uri: "cep://sfield/tools",
      name: "MCP-Exposed Native sfield Tools",
      mimeType: "application/json",
      read: () => JSON.stringify(
        mcpServer.allowedSFieldTools().map((t) => ({
          ref: t.ref,
          description: t.description,
          effect: t.policy.effect,
          classification: t.policy.classification,
        })),
        null,
        2,
      ),
    },
  ];

  const options = {
    serverInfo: { name: "cep-governed-mcp-server", version: "1.1.0" },
    sessionId: `cep-mcp-${serverTenantId}`,
    principal: principalFor(deps.principalId),
    preset: "read_only" as const,
    purpose: "cep-mcp",
    allowTools: exposure.enabledToolRefs,
    extraTools,
    resources,
    extensionStore: cepMcpExtensionStore,
  };

  const mcpServer = deps.runtime
    ? deps.runtime.createMcpServer(options)
    : createSFieldMcpServer(OFFLINE_MCP_HOST, options);

  return mcpServer.handleRequest(raw, {
    principal: principalFor(deps.principalId),
  });
}

/** Builds a Google A2A (Agent-to-Agent) Agent Card for /.well-known/agent.json. */
export function buildA2aAgentCard(
  origin: string,
  integrationService: IntegrationTaskService,
  sphotonCatalog?: SphotonCatalogService,
) {
  const published = integrationService.view().contracts.filter((c) => c.status === "published");
  const smassVirtualTools = sphotonCatalog?.allPublishedVirtualTools() ?? [];
  return {
    name: "CEP — Customer Engagement Platform",
    description: "Governed Agentic Customer Engagement Platform combining Treatment Selector eligibility, A2UI v1.0 declarative surfaces, and sfield digest-bound HITL execution.",
    url: origin,
    version: "1.1.0",
    protocolVersion: "0.2.0",
    provider: { organization: "CEP", url: origin },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
      extensions: [
        { uri: "https://a2ui.org/spec/v1.0", description: "Declarative A2UI v1.0 surfaces" },
        { uri: "https://ag-ui.com/protocol/v1", description: "AG-UI SSE transport at /api/ag-ui" },
        { uri: `https://modelcontextprotocol.io/${MCP_PROTOCOL_VERSION}`, description: "Streamable HTTP MCP server (backed by @sfield/core SFieldMcpServer) at /api/mcp" },
      ],
    },
    endpoints: {
      agUi: `${origin}/api/ag-ui`,
      mcp: `${origin}/api/mcp`,
      integrationsChat: `${origin}/api/integrations/copilot`,
    },
    authentication: {
      schemes: ["Basic", "Cookie"],
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json", "text/event-stream"],
    skills: [
      {
        id: "treatment_selector_engagement",
        name: "Treatment Selector & Governed Customer Engagement",
        description: "Routes customer intent, evaluates Treatment Selector / CCRE eligibility rules, and renders verified A2UI v1.0 surfaces.",
        tags: ["engagement", "personalization", "a2ui", "sfield"],
      },
      {
        id: empathyAssessToolRef,
        name: "Customer Empathy & Life-Event Assessment (sfield MCP)",
        description: "Assesses customer emotional state, life events, and promotion suppression from chat + Customer 360 notes via sfield.",
        tags: ["empathy", "customer360", "mcp", "sfield"],
      },
      {
        id: "policy_hybrid_rag",
        name: "Enterprise Policy Hybrid RAG",
        description: "Searches verified compliance policies and runbooks with hybrid BM25 + semantic vector citations.",
        tags: ["rag", "compliance", "citations"],
      },
      ...published.map((c) => ({
        id: c.ref,
        name: `${c.integrationId}.${c.taskId} v${c.version}`,
        description: c.description,
        tags: [c.integrationId, c.effect, c.approvalPolicy.mode === "none" ? "auto" : "hitl-approval"],
      })),
      ...smassVirtualTools.map((vt) => ({
        id: vt.ref,
        name: `smass · ${vt.modelLabel}`,
        description: vt.description ?? `Virtual Data Model read tool for ${vt.modelId}.`,
        tags: ["smass", "vdm", "read", vt.domainId],
      })),
    ],
  };
}
