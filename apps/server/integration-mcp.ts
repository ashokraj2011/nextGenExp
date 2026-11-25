/**
 * MCP (Model Context Protocol) transport for integration tasks, plus tool discovery that turns an MCP server's
 * tool list into reviewable task-contract drafts. Drafts are never saved or published automatically.
 */
import type { Integration, McpImportCandidate, TaskContract, TaskContractInput, TaskEffect } from "../../packages/contracts/integration-task";
import type { IntegrationTaskStore } from "./integration-tasks";

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; title?: string };
};

export class McpTransportError extends Error {
  constructor(message: string, readonly kind: "timeout" | "unreachable" | "sent", readonly status?: number) { super(message); }
}

const PROTOCOL_VERSION = "2025-03-26";

/** Reads a JSON-RPC response from either a JSON body or a server-sent-events stream (Streamable HTTP). */
async function readRpc(response: Response): Promise<{ result?: unknown; error?: { code: number; message: string } } | null> {
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const candidates = type.includes("text/event-stream")
    ? text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim())
    : [text];
  for (const raw of candidates.reverse()) {
    try {
      const parsed = JSON.parse(raw) as { result?: unknown; error?: { code: number; message: string } };
      if (parsed && (parsed.result !== undefined || parsed.error)) return parsed;
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * One MCP request over HTTP: initialize (captures the session id when the server uses one), notify initialized,
 * then the method. Stateless servers work too.
 */
export async function mcpRequest(integration: Integration, method: string, params: Record<string, unknown>, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(integration.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const secret = integration.secretRef ? process.env[integration.secretRef] : undefined;
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const url = integration.baseUrl;
  let sent = false;
  const post = async (body: Record<string, unknown>) => {
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: combined });
      return res;
    } catch (err) {
      if (timeout.aborted) throw new McpTransportError(`No response within ${integration.timeoutMs}ms`, sent ? "timeout" : "unreachable");
      const code = (err as { cause?: { code?: string } }).cause?.code;
      throw new McpTransportError(err instanceof Error ? err.message : "transport error", code === "ECONNREFUSED" || code === "ENOTFOUND" || !sent ? "unreachable" : "sent");
    }
  };
  const init = await post({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "cep-integrations", version: "1.0.0" } } });
  if (!init.ok) throw new McpTransportError(`MCP initialize failed with HTTP ${init.status}`, "unreachable", init.status);
  await readRpc(init);
  const session = init.headers.get("mcp-session-id");
  if (session) headers["Mcp-Session-Id"] = session;
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }).then((r) => r.text()).catch(() => undefined);
  sent = true;
  const res = await post({ jsonrpc: "2.0", id: `cep_${Date.now()}`, method, params });
  const rpc = res.ok ? await readRpc(res) : null;
  return { status: res.status, rpc };
}

/** Calls an MCP tool and maps the result onto the task engine's status/body shape (so outcome mapping applies). */
export async function callMcpTool(integration: Integration, contract: TaskContract, input: Record<string, unknown>, signal: AbortSignal) {
  const { status, rpc } = await mcpRequest(integration, "tools/call", { name: contract.binding.target, arguments: input }, signal);
  if (status < 200 || status >= 300) return { status, body: {} as Record<string, unknown> };
  if (!rpc) return { status: 502, body: { error: "The MCP server returned no JSON-RPC response" } as Record<string, unknown> };
  // JSON-RPC errors (unknown tool, invalid params) are rejected before the tool runs.
  if (rpc.error) return { status: 400, body: { error: rpc.error.message, code: rpc.error.code } as Record<string, unknown> };
  const result = (rpc.result ?? {}) as { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
  const text = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").slice(0, 20_000);
  if (result.isError) return { status: 422, body: { text } as Record<string, unknown> };
  if (result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)) {
    return { status: 200, body: result.structuredContent as Record<string, unknown> };
  }
  return { status: 200, body: { text } as Record<string, unknown> };
}

/* ---------------------------------------------------------------- discovery → drafts */

export function slugifyTaskId(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  return /^[a-z]/.test(slug) && slug.length >= 2 ? slug : `t_${slug}`.slice(0, 48);
}

/** Closes every object schema (additionalProperties: false) and drops keys the contract guard rejects. */
export function closeSchema(schema: unknown, notes: string[], path = "schema"): unknown {
  if (Array.isArray(schema)) return schema.map((s, i) => closeSchema(s, notes, `${path}[${i}]`));
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === "$schema" || k === "$id") continue;
    out[k] = k === "properties" && v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, s]) => [p, closeSchema(s, notes, `${path}.${p}`)]))
      : closeSchema(v, notes, `${path}.${k}`);
  }
  const isObject = out.type === "object" || (out.properties !== undefined && out.type === undefined);
  if (isObject) {
    if (out.type === undefined) out.type = "object";
    if (out.additionalProperties !== false) {
      if (out.additionalProperties !== undefined) notes.push(`${path}: extra properties are no longer accepted (closed)`);
      out.additionalProperties = false;
    }
    if (!out.properties) out.properties = {};
  }
  return out;
}

const IDEMPOTENCY_FIELDS = ["idempotencyKey", "idempotency_key", "requestId", "request_id", "clientRequestId", "client_request_id", "dedupeKey"];

function bumpMinor(version: string) {
  const [maj, min] = version.split(".").map(Number);
  return `${maj}.${min + 1}.0`;
}

export function draftFromMcpTool(integration: Integration, tool: McpTool, store: IntegrationTaskStore): McpImportCandidate {
  const notes: string[] = [];
  const taskId = slugifyTaskId(tool.name);
  const existing = store.allVersions(integration.id, taskId);
  const latest = existing[0];
  const version = latest ? bumpMinor(latest.version) : "1.0.0";
  const a = tool.annotations ?? {};
  // MCP: tools are assumed destructive unless they say otherwise.
  const effect: TaskEffect = a.readOnlyHint ? "read" : a.destructiveHint === false ? "write" : "destructive";
  notes.push(a.readOnlyHint ? "Read-only per the server's annotations." : a.destructiveHint === false ? "Treated as a write (server says it is not destructive)." : "Treated as destructive (MCP default when the server does not say otherwise). Change it if you know better.");
  const inputSchema = closeSchema(tool.inputSchema ?? { type: "object", properties: {} }, notes, "input") as Record<string, unknown>;
  const outputSchema = tool.outputSchema
    ? closeSchema(tool.outputSchema, notes, "output") as Record<string, unknown>
    : { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } };
  if (!tool.outputSchema) notes.push("No output schema from the server: the task returns the tool's text content.");
  const props = ((inputSchema.properties ?? {}) as Record<string, { type?: unknown }>);
  const keyField = effect !== "read" ? IDEMPOTENCY_FIELDS.find((f) => props[f] && (props[f].type === "string" || props[f].type === undefined)) : undefined;
  if (effect !== "read") {
    notes.push(keyField
      ? `Uses "${keyField}" as the idempotency key (filled automatically before approval).`
      : "No idempotency key: if the outcome is uncertain, someone must check it by hand (manual reconcile).");
    notes.push("Every call needs approval by default. Relax it in the editor if appropriate.");
  }
  const draft: TaskContractInput = {
    integrationId: integration.id,
    taskId,
    version,
    description: (tool.description || a.title || `MCP tool ${tool.name}`).replace(/\s+/g, " ").trim().slice(0, 400),
    effect,
    inputSchema,
    outputSchema,
    resultKind: "data",
    outcomeCodes: [
      { code: "OK", meaning: "The tool completed", success: true },
      { code: "TOOL_ERROR", meaning: "The tool reported an error", success: false },
      { code: "REJECTED", meaning: "The server rejected the call (unknown tool or invalid arguments)", success: false },
    ],
    outcomeMapping: [{ statusIn: [200], code: "OK" }, { statusIn: [422], code: "TOOL_ERROR" }, { statusIn: [400], code: "REJECTED" }],
    approvalPolicy: { mode: effect === "read" ? "none" : "always", when: [], dualControl: false, expiresInMinutes: 30 },
    idempotency: keyField ? { supported: true, keyField } : { supported: false },
    ...(effect !== "read" && !keyField ? { manualReconcile: true } : {}),
    binding: { target: tool.name.slice(0, 200), method: "POST" },
  };
  // Same contract as an existing version (ignoring the version number) → already imported.
  const alreadyImported = existing.some((c) => c.binding.target === tool.name && c.contractDigest === store.digestOf({ ...draft, version: c.version }));
  return { toolName: tool.name, description: draft.description, draft, check: store.validateDraft(draft), notes, alreadyImported };
}

export async function discoverMcpTools(integration: Integration, store: IntegrationTaskStore): Promise<McpImportCandidate[]> {
  if (integration.transport !== "mcp") throw new Error(`${integration.id} is a ${integration.transport} integration, not MCP.`);
  const { status, rpc } = await mcpRequest(integration, "tools/list", {});
  if (status < 200 || status >= 300) throw new Error(`tools/list failed with HTTP ${status}`);
  if (!rpc || rpc.error) throw new Error(`tools/list failed: ${rpc?.error?.message ?? "no JSON-RPC response"}`);
  const tools = ((rpc.result as { tools?: McpTool[] })?.tools ?? []).filter((t) => t && typeof t.name === "string").slice(0, 50);
  return tools.map((t) => draftFromMcpTool(integration, t, store));
}

/* ---------------------------------------------------------------- built-in demo MCP server */

/**
 * A small MCP server (Streamable HTTP, JSON responses) served by CEP itself at /api/integrations/demo-mcp, so the
 * connect → import → publish → run flow can be tried without an external system. State is in memory.
 */
export function createDemoMcpServer() {
  const orders = new Map<string, { status: string; total: number }>([
    ["ORD-1001", { status: "shipped", total: 129.5 }],
    ["ORD-1002", { status: "processing", total: 42 }],
  ]);
  const refunds = new Map<string, { refundId: string; status: string }>();
  const subscriptions = new Set(["SUB-77", "SUB-78"]);
  let seq = 500;
  const tools: McpTool[] = [
    {
      name: "lookup_order", description: "Look up an order's status and total by order id.",
      annotations: { readOnlyHint: true, title: "Look up order" },
      inputSchema: { type: "object", properties: { orderId: { type: "string", minLength: 3, maxLength: 40 } }, required: ["orderId"] },
      outputSchema: { type: "object", properties: { found: { type: "boolean" }, orderId: { type: "string" }, status: { type: "string" }, total: { type: "number" } }, required: ["found"] },
    },
    {
      name: "refund_order", description: "Refund part or all of an order. Repeating a request id returns the original refund.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, title: "Refund order" },
      inputSchema: { type: "object", properties: { orderId: { type: "string", minLength: 3, maxLength: 40 }, amount: { type: "number", minimum: 0.01, maximum: 10000 }, requestId: { type: "string", maxLength: 80 } }, required: ["orderId", "amount"] },
      outputSchema: { type: "object", properties: { refundId: { type: "string" }, status: { type: "string" }, duplicate: { type: "boolean" } }, required: ["refundId", "status"] },
    },
    {
      name: "cancel_subscription", description: "Cancel a customer subscription immediately.",
      inputSchema: { type: "object", properties: { subscriptionId: { type: "string", minLength: 3, maxLength: 40 } }, required: ["subscriptionId"] },
    },
  ];
  const ok = (id: unknown, result: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id, result } });
  const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
  return (raw: unknown): { status: number; headers: Record<string, string>; body?: unknown } => {
    const msg = (raw ?? {}) as { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    const headers = { "Mcp-Session-Id": "cep-demo" };
    if (msg.id === undefined) return { status: 202, headers };
    if (msg.method === "initialize") return { ...ok(msg.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "cep-demo-commerce", version: "1.0.0" } }), headers };
    if (msg.method === "tools/list") return { ...ok(msg.id, { tools }), headers };
    if (msg.method !== "tools/call") return { status: 200, headers, body: { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } } };
    const args = msg.params?.arguments ?? {};
    switch (msg.params?.name) {
      case "lookup_order": {
        const order = orders.get(String(args.orderId ?? ""));
        const data = order ? { found: true, orderId: String(args.orderId), ...order } : { found: false };
        return { ...ok(msg.id, { ...text(JSON.stringify(data)), structuredContent: data }), headers };
      }
      case "refund_order": {
        const key = String(args.requestId ?? "");
        const prior = key ? refunds.get(key) : undefined;
        if (prior) return { ...ok(msg.id, { ...text("duplicate"), structuredContent: { ...prior, duplicate: true } }), headers };
        const order = orders.get(String(args.orderId ?? ""));
        if (!order) return { ...ok(msg.id, text(`Order ${String(args.orderId)} not found`, true)), headers };
        if (Number(args.amount) > order.total) return { ...ok(msg.id, text(`Refund exceeds order total ${order.total}`, true)), headers };
        const refund = { refundId: `RF-${++seq}`, status: "issued" };
        if (key) refunds.set(key, refund);
        return { ...ok(msg.id, { ...text(`Refund ${refund.refundId} issued`), structuredContent: refund }), headers };
      }
      case "cancel_subscription": {
        const id = String(args.subscriptionId ?? "");
        if (!subscriptions.delete(id)) return { ...ok(msg.id, text(`Subscription ${id} not found`, true)), headers };
        return { ...ok(msg.id, text(`Subscription ${id} cancelled`)), headers };
      }
      default:
        return { status: 200, headers, body: { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool ${msg.params?.name}` } } };
    }
  };
}
