/**
 * Exposes CEP as a standards-compliant Streamable HTTP MCP Server (POST /api/mcp)
 * and publishes a Google A2A Agent Card (GET /.well-known/agent.json) — item 3.1.
 *
 * External agents (Claude, Copilot Studio, Salesforce Agentforce, Cursor) can discover and invoke
 * CEP's published Integration Tasks and Knowledge Base through the exact same sfield governance boundary.
 */
import type { IntegrationTaskService } from "./integration-tasks";
import type { KnowledgeBaseStore } from "./knowledge-base";
import { serverTenantId } from "./tenant";

const PROTOCOL_VERSION = "2025-03-26";

type JsonRpcReq = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export interface CepMcpDeps {
  integrationService: IntegrationTaskService;
  knowledgeBase: KnowledgeBaseStore;
  principalId: string;
  operatorName: string;
}

/** Exposes published CEP Integration Tasks + Knowledge Base search over MCP JSON-RPC 2.0. */
export async function handleCepMcpRequest(raw: unknown, deps: CepMcpDeps): Promise<{ status: number; headers: Record<string, string>; body?: unknown }> {
  const msg = (raw && typeof raw === "object" ? raw : {}) as JsonRpcReq;
  const headers = { "Mcp-Session-Id": `cep-mcp-${serverTenantId}` };

  // JSON-RPC notifications have no id.
  if (msg.id === undefined) {
    return { status: 202, headers };
  }
  const ok = (result: unknown) => ({ status: 200, headers, body: { jsonrpc: "2.0", id: msg.id, result } });
  const err = (code: number, message: string) => ({ status: 200, headers, body: { jsonrpc: "2.0", id: msg.id, error: { code, message } } });

  if (msg.method === "initialize") {
    return ok({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: true }, resources: {} },
      serverInfo: { name: "cep-governed-mcp-server", version: "1.1.0" },
    });
  }

  const publishedContracts = deps.integrationService.view().contracts.filter((c) => c.status === "published" && c.sfieldRoute !== "unavailable");

  if (msg.method === "tools/list") {
    const taskTools = publishedContracts.map((c) => ({
      name: c.ref,
      description: `[CEP sfield-governed ${c.effect}] ${c.description}`,
      inputSchema: c.inputSchema,
      outputSchema: c.outputSchema,
      annotations: {
        title: `${c.integrationId} · ${c.taskId} v${c.version}`,
        readOnlyHint: c.effect === "read",
        destructiveHint: c.effect === "destructive",
        idempotentHint: c.idempotency.supported,
      },
    }));

    const kbTool = {
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
    };

    return ok({ tools: [...taskTools, kbTool] });
  }

  if (msg.method === "resources/list") {
    return ok({
      resources: [
        { uri: "cep://catalog/tasks", name: "Published CEP Integration Tasks", mimeType: "application/json" },
        { uri: "cep://knowledge/documents", name: "CEP Policy Knowledge Base", mimeType: "application/json" },
      ],
    });
  }

  if (msg.method === "resources/read") {
    const uri = String(msg.params?.uri ?? "");
    if (uri === "cep://catalog/tasks") {
      return ok({ contents: [{ uri, mimeType: "application/json", text: JSON.stringify(publishedContracts, null, 2) }] });
    }
    if (uri === "cep://knowledge/documents") {
      return ok({ contents: [{ uri, mimeType: "application/json", text: JSON.stringify(deps.knowledgeBase.view(), null, 2) }] });
    }
    return err(-32602, `Unknown resource URI: ${uri}`);
  }

  if (msg.method === "tools/call") {
    const name = String(msg.params?.name ?? "");
    const args = (msg.params?.arguments && typeof msg.params.arguments === "object" ? msg.params.arguments : {}) as Record<string, unknown>;

    if (name === "cep.knowledge.search@1.0.0") {
      const query = String(args.query ?? "").trim();
      if (!query) return err(-32602, "query is required");
      const limit = typeof args.limit === "number" ? Math.min(10, Math.max(1, Math.round(args.limit))) : 3;
      const res = deps.knowledgeBase.search(query, limit);
      return ok({
        content: [{ type: "text", text: JSON.stringify(res) }],
        structuredContent: res,
      });
    }

    const contract = publishedContracts.find((c) => c.ref === name);
    if (!contract) return err(-32602, `Unknown or unpublished CEP tool: ${name}`);

    try {
      const out = await deps.integrationService.run(deps.principalId, {
        toolRef: contract.ref,
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
        return ok({ content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload });
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
      return ok({
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
        ...(isErr ? { isError: true } : {}),
      });
    } catch (e) {
      return err(-32603, e instanceof Error ? e.message : "Tool execution failed");
    }
  }

  return err(-32601, `Unsupported MCP method: ${String(msg.method ?? "")}`);
}

/** Builds a Google A2A (Agent-to-Agent) Agent Card for /.well-known/agent.json. */
export function buildA2aAgentCard(origin: string, integrationService: IntegrationTaskService) {
  const published = integrationService.view().contracts.filter((c) => c.status === "published");
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
        { uri: "https://modelcontextprotocol.io/2025-03-26", description: "Streamable HTTP MCP server at /api/mcp" },
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
    ],
  };
}
