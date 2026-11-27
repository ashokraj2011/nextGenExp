/**
 * Generic MCP Client & Proxy Tool Adapter for @sfield/core.
 *
 * Discovers tools from any Streamable HTTP MCP server (or an in-process SFieldMcpServer)
 * and mounts them as governed @sfield/core ToolDefinitions with closed Ajv schemas,
 * Authorizer policy enforcement, optional HITL approval requirements, and ToolResilienceGuard
 * (rate limiting + circuit breaking).
 */
import type { DataClassification, Effect, JsonObject, JsonSchema, JsonValue } from "../types/common.js";
import type { ToolDefinition } from "../types/tool.js";
import { defineTool } from "../registry/define-tool.js";
import { ToolError } from "../registry/tool-error.js";
import type { ToolResilienceGuard } from "../policy/resilience.js";
import { MCP_PROTOCOL_VERSION, type McpHttpResponse, type McpToolDescriptor } from "./server.js";

export interface McpClientOptions {
  /** Streamable HTTP MCP endpoint URL (e.g. `https://api.example.com/api/mcp`). */
  endpoint?: string;
  /** Optional custom HTTP headers (e.g. `Authorization: Bearer ...`). */
  headers?: Record<string, string>;
  /** Optional in-process handler (e.g. `(req) => mcpServer.handleRequest(req)` for direct embedding/tests). */
  inProcessHandler?: (raw: unknown) => Promise<McpHttpResponse>;
  /** Per-call HTTP timeout in ms. Defaults to 10_000. */
  timeoutMs?: number;
  /** Optional fetch implementation override. */
  fetchImpl?: typeof fetch;
}

export interface McpProxyToolOptions {
  /** Namespace prefix for generated sfield tool IDs (e.g. `"mcp.crm"` -> `mcp.crm.get_contact`). Defaults to `"mcp"`. */
  namespace?: string;
  /** Tool version assigned to generated sfield definitions. Defaults to `"1.0.0"`. */
  version?: string;
  /** Default effect when remote MCP tool lacks `readOnlyHint`/`destructiveHint`. Defaults to `"read"`. */
  defaultEffect?: Effect;
  /** Classification applied to imported tools. Defaults to `"internal"`. */
  classification?: DataClassification;
  /** Whether write/destructive tools require HITL approval. Defaults to `true`. */
  requireApprovalForWrites?: boolean;
  /** Optional filter selecting which remote MCP tools to import. */
  filter?: (tool: McpToolDescriptor) => boolean;
  /** Optional resilience guard (token-bucket rate limiter + circuit breaker). */
  resilience?: ToolResilienceGuard;
  /** Timeout per tool call in ms. Defaults to 10_000. */
  timeoutMs?: number;
}

function sanitizeSegment(raw: string): string {
  const cleaned = raw
    .replace(/@\d+\.\d+\.\d+.*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/\.{2,}/g, ".");
  return cleaned.slice(0, 48) || "tool";
}

/** Ensures a remote JSON Schema conforms to sfield's closed object schema subset. */
function closeSchemaForSField(raw: JsonObject | undefined): JsonSchema {
  if (!raw || typeof raw !== "object" || raw.type !== "object") {
    return { type: "object", additionalProperties: false, properties: {} };
  }
  const props: Record<string, unknown> = {};
  const rawProps = (raw.properties && typeof raw.properties === "object" && !Array.isArray(raw.properties))
    ? raw.properties as Record<string, unknown>
    : {};
  for (const [k, v] of Object.entries(rawProps)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const prop = { ...(v as Record<string, unknown>) };
    if (prop.type === "object" && prop.additionalProperties === undefined) {
      prop.additionalProperties = false;
    }
    props[k] = prop;
  }
  const required = Array.isArray(raw.required)
    ? raw.required.filter((x): x is string => typeof x === "string" && x in props)
    : undefined;
  return {
    type: "object",
    additionalProperties: false,
    properties: props,
    ...(required && required.length ? { required } : {}),
  };
}

export class McpClient {
  private reqId = 0;
  private sessionId?: string;
  private initialized = false;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: McpClientOptions) {
    if (!options.endpoint && !options.inProcessHandler) {
      throw new Error("McpClient requires either `endpoint` or `inProcessHandler`.");
    }
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  private async rpc<T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const id = ++this.reqId;
    const payload = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };

    if (this.options.inProcessHandler) {
      const res = await this.options.inProcessHandler(payload);
      if (res.headers["Mcp-Session-Id"]) this.sessionId = res.headers["Mcp-Session-Id"];
      const body = res.body as { result?: T; error?: { code: number; message: string } } | undefined;
      if (body?.error) throw new Error(`MCP error (${body.error.code}): ${body.error.message}`);
      return body?.result as T;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("MCP request timeout")), this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const res = await this.fetchImpl(this.options.endpoint!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
          ...(this.options.headers ?? {}),
        },
        body: JSON.stringify(payload),
        signal: combined,
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      if (!res.ok) {
        throw new Error(`MCP HTTP ${res.status}: ${await res.text().catch(() => res.statusText)}`);
      }
      const body = await res.json() as { result?: T; error?: { code: number; message: string } };
      if (body.error) throw new Error(`MCP error (${body.error.code}): ${body.error.message}`);
      return body.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async initialize(signal?: AbortSignal): Promise<{ protocolVersion: string; serverInfo?: { name: string; version: string } }> {
    const res = await this.rpc<{ protocolVersion: string; serverInfo?: { name: string; version: string } }>(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "sfield-mcp-client", version: "1.0.0" },
      },
      signal,
    );
    this.initialized = true;
    return res;
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    if (!this.initialized) await this.initialize(signal);
    const res = await this.rpc<{ tools: McpToolDescriptor[] }>("tools/list", undefined, signal);
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean }> {
    if (!this.initialized) await this.initialize(signal);
    return this.rpc("tools/call", { name, arguments: args }, signal);
  }
}

export function createMcpClient(options: McpClientOptions): McpClient {
  return new McpClient(options);
}

/**
 * Discovers tools from a remote MCP server (or in-process SFieldMcpServer) and wraps each one
 * as a native @sfield/core ToolDefinition ready to pass into `SField.create({ tools })`.
 */
export async function createMcpProxyTools(
  client: McpClient,
  opts: McpProxyToolOptions = {},
  signal?: AbortSignal,
): Promise<ToolDefinition[]> {
  const remoteTools = await client.listTools(signal);
  const namespace = sanitizeSegment(opts.namespace ?? "mcp");
  const version = opts.version ?? "1.0.0";
  const defaultEffect = opts.defaultEffect ?? "read";
  const classification = opts.classification ?? "internal";
  const requireApprovalForWrites = opts.requireApprovalForWrites ?? true;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const selected = opts.filter ? remoteTools.filter(opts.filter) : remoteTools;

  return selected.map((remote) => {
    const effect: Effect = remote.annotations?.destructiveHint
      ? "destructive"
      : remote.annotations?.readOnlyHint === true
        ? "read"
        : remote.annotations?.readOnlyHint === false
          ? "write"
          : defaultEffect;
    const toolId = `${namespace}.${sanitizeSegment(remote.name)}`;
    const inputSchema = closeSchemaForSField(remote.inputSchema);

    return defineTool({
      id: toolId,
      version,
      description: remote.description || `Remote MCP tool ${remote.name}`,
      ...(effect !== "read" ? { resource: { type: `${namespace}_remote`, id: { literal: remote.name } } } : {}),
      inputs: inputSchema,
      outputs: {
        type: "object",
        additionalProperties: false,
        required: ["remoteTool", "ok", "resultJson"],
        properties: {
          remoteTool: { type: "string" },
          ok: { type: "boolean" },
          resultJson: { type: "string" },
        },
      },
      policy: {
        action: toolId,
        effect,
        requiresApproval: effect !== "read" && requireApprovalForWrites,
        timeoutMs,
        maxAttempts: 1,
        classification,
        maxOutputBytes: 48_000,
      },
      handler: async (raw, ctx): Promise<JsonObject> => {
        const invoke = async () => client.callTool(remote.name, (raw ?? {}) as Record<string, unknown>, ctx.signal);
        const res = opts.resilience
          ? await opts.resilience.execute(`mcp:${toolId}`, invoke)
          : await invoke();

        if (res.isError) {
          const msg = res.content?.map((c) => c.text).filter(Boolean).join(" ") || `Remote MCP tool ${remote.name} returned an error`;
          throw new ToolError("REMOTE_MCP_ERROR", msg.slice(0, 300));
        }

        const payload: JsonValue = (res.structuredContent !== undefined
          ? res.structuredContent
          : res.content?.[0]?.text ?? null) as JsonValue;

        return {
          remoteTool: remote.name,
          ok: true,
          resultJson: typeof payload === "string" ? payload : JSON.stringify(payload),
        };
      },
    });
  });
}
