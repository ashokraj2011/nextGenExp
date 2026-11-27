/**
 * Generic MCP (Model Context Protocol, 2025-03-26) server adapter for @sfield/core.
 *
 * Exposes an explicit allowlist of registered sfield tools (and optional host-supplied
 * virtual tools and resources) over Streamable HTTP or newline-delimited stdio JSON-RPC 2.0.
 *
 * Every sfield tool invocation runs inside a scoped ExecutionScope (`executions.open` /
 * `executions.resume`), preserving zero-trust Principal identity, Authorizer policy checks,
 * PolicyPreset enforcement (`read_only` by default), closed Ajv input/output validation,
 * HITL approval suspension (`APPROVAL_REQUIRED` -> `pending_approval`), and audit persistence.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { JsonObject, Principal } from "../types/common.js";
import type { PolicyPreset } from "../policy/presets.js";
import type { ToolDescription } from "../registry/registry.js";
import type { ExecutionScope, ExecutionScopeOptions } from "../runtime/execution-scope.js";
import { SFieldError } from "../errors.js";

export const MCP_PROTOCOL_VERSION = "2025-03-26";

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  annotations?: McpToolAnnotations;
}

export interface McpCallResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpCallContext {
  principal?: Principal;
  /** Optional HTTP request headers passed to `options.authenticate(headers)` to resolve a Principal. */
  headers?: Record<string, string | undefined>;
  preset?: PolicyPreset;
  signal?: AbortSignal;
  meta?: Record<string, unknown>;
}

export interface McpExtraTool {
  descriptor: McpToolDescriptor;
  handler: (args: Record<string, unknown>, ctx: McpCallContext) => Promise<McpCallResult>;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text: string;
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  read: (ctx: McpCallContext) => Promise<string> | string;
}

export interface McpHttpResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

export interface SFieldMcpHost {
  readonly registry: {
    list(): ToolDescription[];
    describe(ref: string): ToolDescription;
  };
  readonly executions: {
    open(opts: ExecutionScopeOptions): Promise<ExecutionScope>;
    resume(opts: { runId: string; principal?: Principal; preset?: PolicyPreset; budget?: ExecutionScopeOptions["budget"] }): Promise<ExecutionScope>;
  };
  readonly devPrincipal?: Principal;
}

export interface SFieldMcpServerOptions {
  serverInfo?: { name: string; version: string };
  /** Value returned in the `Mcp-Session-Id` response header. */
  sessionId?: string;
  /** Default Principal used when callers do not pass a per-request principal. */
  principal?: Principal;
  /**
   * Optional request authenticator (e.g., Bearer/JWT verifier) resolving a Principal from HTTP headers.
   * When configured and `ctx.principal` is omitted, `authenticate(ctx.headers)` is invoked before
   * tool listing/execution so RBAC `allowTools(tool, principal)` policies can enforce per-caller scopes.
   */
  authenticate?: (headers: Record<string, string | undefined>) => Promise<Principal | null> | Principal | null;
  /** Default execution policy preset. Defaults to `"read_only"` (safe by default). */
  preset?: PolicyPreset;
  /** Purpose string recorded on opened ExecutionScopes. Defaults to `"sfield-mcp"`. */
  purpose?: string;
  /** Budget ceiling applied to each opened MCP tool execution scope. */
  budget?: { maxCostMicroUsd?: number; maxToolCalls?: number };
  /**
   * Explicit allowlist of registered sfield tools to expose over MCP.
   * Accepts an array of exact `ref` (`id@version`) or `id` strings, or a principal-aware RBAC predicate.
   * When omitted, exposes only non-builtin tools whose `policy.effect === "read"`.
   */
  allowTools?: readonly string[] | ((tool: ToolDescription, principal?: Principal) => boolean);
  /** Optional host-defined virtual tools (e.g. RAG search or custom-routed dispatchers). */
  extraTools?: readonly McpExtraTool[] | ((ctx: McpCallContext) => readonly McpExtraTool[]);
  /** Optional MCP resources exposed via `resources/list` and `resources/read`. */
  resources?: readonly McpResourceDefinition[] | ((ctx: McpCallContext) => readonly McpResourceDefinition[]);
}

interface JsonRpcReq {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function describeSFieldToolForMcp(tool: ToolDescription): McpToolDescriptor {
  return {
    name: tool.ref,
    description: `[sfield ${tool.policy.effect}] ${tool.description}`,
    inputSchema: tool.inputs,
    outputSchema: tool.outputs,
    annotations: {
      title: `${tool.id} v${tool.version}`,
      readOnlyHint: tool.policy.effect === "read",
      destructiveHint: tool.policy.effect === "destructive",
      idempotentHint: tool.policy.retrySafety !== "never",
    },
  };
}

export class SFieldMcpServer {
  private readonly serverInfo: { name: string; version: string };
  private readonly sessionId: string;
  private readonly defaultPreset: PolicyPreset;
  private readonly purpose: string;

  constructor(
    private readonly sf: SFieldMcpHost,
    private readonly options: SFieldMcpServerOptions = {},
  ) {
    this.serverInfo = options.serverInfo ?? { name: "sfield-mcp-server", version: "1.0.0" };
    this.sessionId = options.sessionId ?? "sfield-mcp";
    this.defaultPreset = options.preset ?? "read_only";
    this.purpose = options.purpose ?? "sfield-mcp";
  }

  /** Lists registered sfield tools permitted by `allowTools` (defaults to read-only non-builtins). */
  allowedSFieldTools(principal?: Principal): ToolDescription[] {
    const all = this.sf.registry.list().filter((t) => t.source !== "builtin");
    const rule = this.options.allowTools;
    if (!rule) {
      return all.filter((t) => t.policy.effect === "read");
    }
    if (typeof rule === "function") {
      return all.filter((t) => rule(t, principal));
    }
    const set = new Set(rule);
    return all.filter((t) => set.has(t.ref) || set.has(t.id));
  }

  private resolveExtraTools(ctx: McpCallContext): readonly McpExtraTool[] {
    const raw = this.options.extraTools;
    if (!raw) return [];
    return typeof raw === "function" ? raw(ctx) : raw;
  }

  private resolveResources(ctx: McpCallContext): readonly McpResourceDefinition[] {
    const raw = this.options.resources;
    if (!raw) return [];
    return typeof raw === "function" ? raw(ctx) : raw;
  }

  private async resolveOptionalPrincipal(ctx: McpCallContext): Promise<Principal | undefined> {
    if (ctx.principal) return ctx.principal;
    if (this.options.authenticate && ctx.headers) {
      const authed = await this.options.authenticate(ctx.headers);
      if (authed) return authed;
    }
    return this.options.principal ?? this.sf.devPrincipal;
  }

  private async resolvePrincipal(ctx: McpCallContext): Promise<Principal> {
    const p = await this.resolveOptionalPrincipal(ctx);
    if (!p) {
      throw new SFieldError("ACCESS_DENIED", "MCP request requires an authenticated sfield Principal");
    }
    return p;
  }

  /** Handles a single MCP JSON-RPC 2.0 request (usable over Streamable HTTP or stdio). */
  async handleRequest(raw: unknown, ctx: McpCallContext = {}): Promise<McpHttpResponse> {
    const msg = (isPlainObject(raw) ? raw : {}) as JsonRpcReq;
    const headers: Record<string, string> = { "Mcp-Session-Id": this.sessionId };

    // JSON-RPC 2.0 notifications omit `id` -> acknowledge with 202 Accepted and no body.
    if (msg.id === undefined) {
      return { status: 202, headers };
    }

    const ok = (result: unknown): McpHttpResponse => ({
      status: 200,
      headers,
      body: { jsonrpc: "2.0", id: msg.id, result },
    });
    const err = (code: number, message: string, data?: unknown): McpHttpResponse => ({
      status: 200,
      headers,
      body: { jsonrpc: "2.0", id: msg.id, error: { code, message, ...(data !== undefined ? { data } : {}) } },
    });

    if (msg.method === "initialize") {
      return ok({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: true },
          resources: {},
        },
        serverInfo: this.serverInfo,
      });
    }

    if (msg.method === "ping") {
      return ok({});
    }

    if (msg.method === "tools/list") {
      const callerPrincipal = await this.resolveOptionalPrincipal(ctx);
      if (this.options.authenticate && ctx.headers && !callerPrincipal) {
        return err(-32001, "Unauthorized MCP client");
      }
      const enrichedCtx: McpCallContext = callerPrincipal ? { ...ctx, principal: callerPrincipal } : ctx;
      const extras = this.resolveExtraTools(enrichedCtx);
      const seen = new Set<string>();
      const tools: McpToolDescriptor[] = [];
      for (const extra of extras) {
        if (seen.has(extra.descriptor.name)) continue;
        seen.add(extra.descriptor.name);
        tools.push(extra.descriptor);
      }
      for (const tool of this.allowedSFieldTools(callerPrincipal)) {
        if (seen.has(tool.ref)) continue;
        seen.add(tool.ref);
        tools.push(describeSFieldToolForMcp(tool));
      }
      return ok({ tools });
    }

    if (msg.method === "resources/list") {
      const resources = this.resolveResources(ctx).map((r) => ({
        uri: r.uri,
        name: r.name,
        ...(r.description ? { description: r.description } : {}),
        ...(r.mimeType ? { mimeType: r.mimeType } : {}),
      }));
      return ok({ resources });
    }

    if (msg.method === "resources/read") {
      const uri = String(msg.params?.uri ?? "");
      const res = this.resolveResources(ctx).find((r) => r.uri === uri);
      if (!res) return err(-32602, `Unknown resource URI: ${uri}`);
      try {
        const text = await res.read(ctx);
        return ok({
          contents: [{ uri: res.uri, ...(res.mimeType ? { mimeType: res.mimeType } : {}), text }],
        });
      } catch (e) {
        return err(-32603, e instanceof Error ? e.message : "Failed to read resource");
      }
    }

    if (msg.method === "tools/call") {
      const name = String(msg.params?.name ?? "").trim();
      if (!name) return err(-32602, "Tool name is required");
      const rawArgs = isPlainObject(msg.params?.arguments) ? msg.params!.arguments : {};

      // 1. Check host-supplied virtual / custom-routed tools first.
      const extra = this.resolveExtraTools(ctx).find((t) => t.descriptor.name === name);
      if (extra) {
        try {
          const result = await extra.handler(rawArgs, ctx);
          return ok(result);
        } catch (e) {
          return err(-32603, e instanceof Error ? e.message : "Tool execution failed");
        }
      }

      let principal: Principal;
      try {
        principal = await this.resolvePrincipal(ctx);
      } catch (e) {
        return err(-32001, e instanceof Error ? e.message : "Authentication required");
      }

      // 2. Enforce explicit principal-scoped sfield MCP allowlist (never expose hidden tools).
      const allowed = this.allowedSFieldTools(principal).find((t) => t.ref === name || t.id === name);
      if (!allowed) {
        return err(-32602, `Unknown or disallowed sfield tool: ${name}`);
      }

      // Optional resume hint for approved HITL calls: { _sfieldResume: { runId, callId } }
      const resumeRaw = isPlainObject(rawArgs._sfieldResume) ? rawArgs._sfieldResume : undefined;
      const resumeRunId = typeof resumeRaw?.runId === "string" ? resumeRaw.runId : undefined;
      const resumeCallId = typeof resumeRaw?.callId === "string" ? resumeRaw.callId : undefined;
      const toolInputs: JsonObject = {};
      for (const [k, v] of Object.entries(rawArgs)) {
        if (k === "_sfieldResume") continue;
        toolInputs[k] = v as JsonObject[string];
      }

      const preset = ctx.preset ?? this.defaultPreset;
      let scope: ExecutionScope | undefined;
      let suspended = false;
      try {
        scope = resumeRunId
          ? await this.sf.executions.resume({ runId: resumeRunId, principal, preset, budget: this.options.budget ?? { maxToolCalls: 2 } })
          : await this.sf.executions.open({
              principal,
              purpose: `${this.purpose}:${allowed.id}`,
              preset,
              budget: this.options.budget ?? { maxToolCalls: 1 },
            });

        const res = await scope.registry.execute(allowed.ref, toolInputs, {
          ...(resumeCallId ? { callId: resumeCallId } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });

        const isError = res.status !== "succeeded";
        const payload = {
          sfieldRunId: scope.id,
          toolRef: allowed.ref,
          status: res.status,
          ...(res.output !== undefined ? { output: res.output } : {}),
          ...(res.error ? { error: res.error } : {}),
        };
        return ok({
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
          ...(isError ? { isError: true } : {}),
        });
      } catch (e) {
        if (e instanceof SFieldError && e.code === "APPROVAL_REQUIRED" && scope) {
          await scope.suspend();
          suspended = true;
          const details = (e.details ?? {}) as { approvalId?: string; callId?: string };
          const payload = {
            status: "pending_approval",
            sfieldRunId: scope.id,
            approvalId: details.approvalId ?? null,
            callId: details.callId ?? e.callId ?? null,
            toolRef: allowed.ref,
            message: e.message,
          };
          return ok({
            content: [{ type: "text", text: JSON.stringify(payload) }],
            structuredContent: payload,
          });
        }
        if (e instanceof SFieldError) {
          const payload = {
            sfieldRunId: scope?.id ?? null,
            toolRef: allowed.ref,
            status: "denied",
            error: { code: e.code, message: e.message },
          };
          return ok({
            content: [{ type: "text", text: JSON.stringify(payload) }],
            structuredContent: payload,
            isError: true,
          });
        }
        return err(-32603, e instanceof Error ? e.message : "sfield tool execution failed");
      } finally {
        if (scope && !suspended) {
          await scope.close().catch(() => undefined);
        }
      }
    }

    return err(-32601, `Unsupported MCP method: ${String(msg.method ?? "")}`);
  }

  /**
   * Serves newline-delimited JSON-RPC 2.0 MCP requests over stdio (or any Readable/Writable pair).
   * Ideal for running any @sfield/core application directly as a local MCP server (Claude Desktop, Cursor, CLI).
   */
  async serveStdio(opts: {
    input?: Readable;
    output?: Writable;
    principal?: Principal;
    preset?: PolicyPreset;
    signal?: AbortSignal;
  } = {}): Promise<void> {
    const input = opts.input ?? process.stdin;
    const output = opts.output ?? process.stdout;
    const rl = createInterface({ input, crlfDelay: Infinity });
    const onAbort = () => rl.close();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
          continue;
        }
        const res = await this.handleRequest(parsed, {
          principal: opts.principal,
          preset: opts.preset,
          signal: opts.signal,
        });
        if (res.body !== undefined) {
          output.write(JSON.stringify(res.body) + "\n");
        }
      }
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      rl.close();
    }
  }
}

export function createSFieldMcpServer(sf: SFieldMcpHost, options: SFieldMcpServerOptions = {}): SFieldMcpServer {
  return new SFieldMcpServer(sf, options);
}
