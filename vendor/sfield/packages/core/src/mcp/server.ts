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
import { sharedValidator } from "../schema/validator.js";
import { nowIso } from "../util/digest.js";
import {
  ElicitationRequiredError,
  MCP_EXTENSION_ELICITATION,
  MCP_EXTENSION_TASKS,
  MCP_PROTOCOL_VERSION_2026,
  McpExtensionStore,
  parseElicitationToolError,
  type McpElicitationAction,
  type McpTaskStatus,
} from "./extensions.js";

export const MCP_PROTOCOL_VERSION = "2025-03-26";
export const MCP_SUPPORTED_VERSIONS = [MCP_PROTOCOL_VERSION_2026, MCP_PROTOCOL_VERSION] as const;

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
  /** Optional shared extension store for MCP 2026 async tasks & elicitations across HTTP requests. */
  extensionStore?: McpExtensionStore;
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
  readonly extensions: McpExtensionStore;

  constructor(
    private readonly sf: SFieldMcpHost,
    private readonly options: SFieldMcpServerOptions = {},
  ) {
    this.serverInfo = options.serverInfo ?? { name: "sfield-mcp-server", version: "1.0.0" };
    this.sessionId = options.sessionId ?? "sfield-mcp";
    this.defaultPreset = options.preset ?? "read_only";
    this.purpose = options.purpose ?? "sfield-mcp";
    this.extensions = options.extensionStore ?? new McpExtensionStore();
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

    const serverCapabilities = {
      tools: { listChanged: true },
      resources: {},
      extensions: {
        [MCP_EXTENSION_ELICITATION]: { modes: ["form"], multiRoundTrip: true },
        [MCP_EXTENSION_TASKS]: { list: true, get: true, result: true, cancel: true },
      },
    };

    if (msg.method === "initialize") {
      const requestedVersion = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "";
      const negotiatedVersion = requestedVersion === MCP_PROTOCOL_VERSION_2026
        ? MCP_PROTOCOL_VERSION_2026
        : MCP_PROTOCOL_VERSION;
      return ok({
        protocolVersion: negotiatedVersion,
        capabilities: serverCapabilities,
        serverInfo: this.serverInfo,
      });
    }

    // MCP 2026 stateless discovery endpoint (no prior initialize handshake required).
    if (msg.method === "server/discover") {
      return ok({
        protocolVersions: [...MCP_SUPPORTED_VERSIONS],
        capabilities: serverCapabilities,
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

    if (msg.method === "tasks/list") {
      let principal: Principal;
      try { principal = await this.resolvePrincipal(ctx); } catch (e) {
        return err(-32001, e instanceof Error ? e.message : "Authentication required");
      }
      const status = typeof msg.params?.status === "string" ? (msg.params.status as McpTaskStatus) : undefined;
      return ok({ tasks: this.extensions.listTasks({ tenantId: principal.tenantId, ...(status ? { status } : {}) }) });
    }

    if (msg.method === "tasks/get") {
      let principal: Principal;
      try { principal = await this.resolvePrincipal(ctx); } catch (e) {
        return err(-32001, e instanceof Error ? e.message : "Authentication required");
      }
      const taskId = String(msg.params?.taskId ?? "").trim();
      if (!taskId) return err(-32602, "taskId is required");
      const rec = this.extensions.getTask(taskId);
      if (!rec) return err(-32602, `Unknown taskId: ${taskId}`);
      if (rec.tenantId !== principal.tenantId) return err(-32001, "Access denied to task belonging to another tenant");
      return ok({ task: this.extensions.toTaskSummary(rec) });
    }

    if (msg.method === "tasks/result") {
      let principal: Principal;
      try { principal = await this.resolvePrincipal(ctx); } catch (e) {
        return err(-32001, e instanceof Error ? e.message : "Authentication required");
      }
      const taskId = String(msg.params?.taskId ?? "").trim();
      if (!taskId) return err(-32602, "taskId is required");
      const rec = this.extensions.getTask(taskId);
      if (!rec) return err(-32602, `Unknown taskId: ${taskId}`);
      if (rec.tenantId !== principal.tenantId) return err(-32001, "Access denied to task belonging to another tenant");
      return ok({
        task: this.extensions.toTaskSummary(rec),
        ...(rec.result !== undefined ? { result: rec.result } : {}),
        ...(rec.error !== undefined ? { error: rec.error } : {}),
      });
    }

    if (msg.method === "tasks/cancel") {
      let principal: Principal;
      try { principal = await this.resolvePrincipal(ctx); } catch (e) {
        return err(-32001, e instanceof Error ? e.message : "Authentication required");
      }
      const taskId = String(msg.params?.taskId ?? "").trim();
      if (!taskId) return err(-32602, "taskId is required");
      const rec = this.extensions.getTask(taskId);
      if (!rec) return err(-32602, `Unknown taskId: ${taskId}`);
      if (rec.tenantId !== principal.tenantId) return err(-32001, "Access denied to task belonging to another tenant");
      if (rec.status === "working" || rec.status === "input_required") {
        rec.controller?.abort(new Error("MCP task cancelled by caller"));
        this.extensions.updateTask(taskId, { status: "cancelled", statusMessage: "Cancelled by caller", elicitation: undefined });
      }
      return ok({ task: this.extensions.toTaskSummary(rec) });
    }

    if (msg.method === "elicitation/list") {
      let principal: Principal;
      try { principal = await this.resolvePrincipal(ctx); } catch (e) {
        return err(-32001, e instanceof Error ? e.message : "Authentication required");
      }
      return ok({ elicitations: this.extensions.listElicitations({ tenantId: principal.tenantId, status: "pending" }) });
    }

    if (msg.method === "elicitation/respond") {
      let principal: Principal;
      try { principal = await this.resolvePrincipal(ctx); } catch (e) {
        return err(-32001, e instanceof Error ? e.message : "Authentication required");
      }
      const elicitationId = String(msg.params?.elicitationId ?? "").trim();
      const action = msg.params?.action as McpElicitationAction | undefined;
      if (!elicitationId) return err(-32602, "elicitationId is required");
      if (action !== "accept" && action !== "decline" && action !== "cancel") {
        return err(-32602, 'action must be "accept", "decline", or "cancel"');
      }
      const rec = this.extensions.getElicitation(elicitationId);
      if (!rec) return err(-32602, `Unknown elicitationId: ${elicitationId}`);
      if (rec.principal.tenantId !== principal.tenantId || rec.principal.subjectId !== principal.subjectId) {
        return err(-32001, "Access denied: elicitation belongs to a different principal");
      }
      if (rec.status !== "pending") {
        return err(-32602, `Elicitation "${elicitationId}" is already ${rec.status}`);
      }

      if (action === "decline" || action === "cancel") {
        rec.status = action === "decline" ? "declined" : "cancelled";
        rec.updatedAt = nowIso();
        rec.response = { action, respondedAt: rec.updatedAt };
        if (rec.taskId) {
          this.extensions.updateTask(rec.taskId, {
            status: "cancelled",
            statusMessage: `Elicitation ${rec.status} by user`,
            elicitation: undefined,
          });
        }
        return ok({ status: rec.status, elicitationId, ...(rec.taskId ? { taskId: rec.taskId } : {}) });
      }

      const content = isPlainObject(msg.params?.content) ? msg.params!.content : {};
      const validation = sharedValidator().validate(rec.requestedSchema, content);
      if (!validation.ok) {
        return err(-32602, `Elicitation content failed schema validation: ${validation.errors.map((e) => e.message).join("; ")}`);
      }

      rec.status = "accepted";
      rec.updatedAt = nowIso();
      rec.response = { action: "accept", content, respondedAt: rec.updatedAt };

      const mergedArgs: Record<string, unknown> = { ...rec.originalArgs, ...content };
      const resumeCtx: McpCallContext = {
        ...ctx,
        principal: rec.principal,
        preset: rec.preset,
        meta: { ...(ctx.meta ?? {}), elicitation: { elicitationId, content } },
      };

      if (rec.taskId) {
        const taskRec = this.extensions.getTask(rec.taskId);
        const controller = new AbortController();
        if (taskRec) taskRec.controller = controller;
        this.extensions.updateTask(rec.taskId, {
          status: "working",
          statusMessage: `Resumed ${rec.toolName} after elicitation`,
          elicitation: undefined,
        });
        this.runToolInBackground(rec.taskId, rec.toolName, mergedArgs, { ...resumeCtx, signal: controller.signal });
        return ok({
          status: "accepted",
          elicitationId,
          task: taskRec ? this.extensions.toTaskSummary(taskRec) : undefined,
        });
      }

      const outcome = await this.executeToolCall(rec.toolName, mergedArgs, resumeCtx);
      if (outcome.kind === "rpc_error") return err(outcome.code, outcome.message, outcome.data);
      return ok(outcome.result);
    }

    if (msg.method === "tools/call") {
      const name = String(msg.params?.name ?? "").trim();
      if (!name) return err(-32602, "Tool name is required");
      const rawArgs = isPlainObject(msg.params?.arguments) ? msg.params!.arguments : {};
      const taskParam = isPlainObject(msg.params?.task)
        ? msg.params!.task
        : (isPlainObject(msg.params?._meta) && msg.params!._meta.task ? {} : undefined);

      // MCP 2026 Async Tasks Extension: launch tool in background & return task handle immediately.
      if (taskParam) {
        let principal: Principal;
        try { principal = await this.resolvePrincipal(ctx); } catch (e) {
          return err(-32001, e instanceof Error ? e.message : "Authentication required");
        }
        // Verify tool exists & is allowed before queuing async task.
        const isExtra = this.resolveExtraTools({ ...ctx, principal }).some((t) => t.descriptor.name === name);
        const isAllowed = isExtra || this.allowedSFieldTools(principal).some((t) => t.ref === name || t.id === name);
        if (!isAllowed) {
          return err(-32602, `Unknown or disallowed sfield tool: ${name}`);
        }
        const ttlMs = typeof taskParam.ttlMs === "number" && taskParam.ttlMs > 0 ? Math.min(3_600_000, taskParam.ttlMs) : 5 * 60_000;
        const controller = new AbortController();
        const taskRec = this.extensions.createTask({
          toolName: name,
          tenantId: principal.tenantId,
          subjectId: principal.subjectId,
          ttlMs,
          controller,
        });
        this.runToolInBackground(taskRec.taskId, name, rawArgs, { ...ctx, principal, signal: controller.signal });
        return ok({ task: this.extensions.toTaskSummary(taskRec) });
      }

      const outcome = await this.executeToolCall(name, rawArgs, ctx);
      if (outcome.kind === "rpc_error") return err(outcome.code, outcome.message, outcome.data);
      return ok(outcome.result);
    }

    return err(-32601, `Unsupported MCP method: ${String(msg.method ?? "")}`);
  }

  private runToolInBackground(taskId: string, name: string, rawArgs: Record<string, unknown>, ctx: McpCallContext): void {
    void this.executeToolCall(name, rawArgs, ctx, taskId).then((outcome) => {
      const current = this.extensions.getTask(taskId);
      if (!current || current.status === "cancelled") return;
      if (outcome.kind === "elicitation") {
        this.extensions.updateTask(taskId, {
          status: "input_required",
          statusMessage: outcome.elicitation.message,
          elicitation: outcome.elicitation,
        });
        return;
      }
      if (outcome.kind === "rpc_error") {
        this.extensions.updateTask(taskId, {
          status: "failed",
          statusMessage: outcome.message,
          error: { code: outcome.code, message: outcome.message },
        });
        return;
      }
      this.extensions.updateTask(taskId, {
        status: outcome.result.isError ? "failed" : "completed",
        statusMessage: outcome.result.isError ? "Tool returned an error" : "Completed",
        result: outcome.result,
      });
    }).catch((e) => {
      const current = this.extensions.getTask(taskId);
      if (!current || current.status === "cancelled") return;
      const msg = e instanceof Error ? e.message : "Async task failed";
      this.extensions.updateTask(taskId, {
        status: "failed",
        statusMessage: msg,
        error: { code: -32603, message: msg },
      });
    });
  }

  private async executeToolCall(
    name: string,
    rawArgs: Record<string, unknown>,
    ctx: McpCallContext,
    taskId?: string,
  ): Promise<
    | { kind: "ok"; result: McpCallResult }
    | { kind: "elicitation"; elicitation: ReturnType<McpExtensionStore["toElicitationRequest"]>; result: McpCallResult }
    | { kind: "rpc_error"; code: number; message: string; data?: unknown }
  > {
    const buildElicitationOutcome = (
      elicitationInput: { elicitationId?: string; message: string; requestedSchema: JsonObject; ttlMs?: number },
      principal: Principal,
      preset: PolicyPreset,
    ) => {
      const rec = this.extensions.createElicitation({
        elicitationId: elicitationInput.elicitationId,
        message: elicitationInput.message,
        requestedSchema: elicitationInput.requestedSchema,
        ttlMs: elicitationInput.ttlMs,
        toolName: name,
        originalArgs: rawArgs,
        principal,
        preset,
        ...(taskId ? { taskId } : {}),
      });
      const elicitation = this.extensions.toElicitationRequest(rec);
      const payload = { status: "input_required", elicitation, ...(taskId ? { taskId } : {}) };
      const result: McpCallResult = {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
      return taskId
        ? ({ kind: "elicitation", elicitation, result } as const)
        : ({ kind: "ok", result } as const);
    };

    // 1. Check host-supplied virtual / custom-routed tools first.
    const extra = this.resolveExtraTools(ctx).find((t) => t.descriptor.name === name);
    if (extra) {
      try {
        const result = await extra.handler(rawArgs, ctx);
        return { kind: "ok", result };
      } catch (e) {
        if (e instanceof ElicitationRequiredError) {
          const p = (await this.resolveOptionalPrincipal(ctx)) ?? { tenantId: "default", subjectId: "anonymous", roles: [], attributes: {} };
          return buildElicitationOutcome(
            { elicitationId: e.elicitationId, message: e.promptMessage, requestedSchema: e.requestedSchema, ttlMs: e.ttlMs },
            p,
            ctx.preset ?? this.defaultPreset,
          );
        }
        return { kind: "rpc_error", code: -32603, message: e instanceof Error ? e.message : "Tool execution failed" };
      }
    }

    let principal: Principal;
    try {
      principal = await this.resolvePrincipal(ctx);
    } catch (e) {
      return { kind: "rpc_error", code: -32001, message: e instanceof Error ? e.message : "Authentication required" };
    }

    // 2. Enforce explicit principal-scoped sfield MCP allowlist (never expose hidden tools).
    const allowed = this.allowedSFieldTools(principal).find((t) => t.ref === name || t.id === name);
    if (!allowed) {
      return { kind: "rpc_error", code: -32602, message: `Unknown or disallowed sfield tool: ${name}` };
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

      // Detect native sfield tool requesting MCP 2026 Elicitation (`requestElicitation(...)`).
      const elicited = parseElicitationToolError(res.error);
      if (elicited) {
        return buildElicitationOutcome(elicited, principal, preset);
      }

      const isError = res.status !== "succeeded";
      const payload = {
        sfieldRunId: scope.id,
        toolRef: allowed.ref,
        status: res.status,
        ...(res.output !== undefined ? { output: res.output } : {}),
        ...(res.error ? { error: res.error } : {}),
      };
      return {
        kind: "ok",
        result: {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
          ...(isError ? { isError: true } : {}),
        },
      };
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
        return {
          kind: "ok",
          result: {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            structuredContent: payload,
          },
        };
      }
      if (e instanceof SFieldError) {
        const payload = {
          sfieldRunId: scope?.id ?? null,
          toolRef: allowed.ref,
          status: "denied",
          error: { code: e.code, message: e.message },
        };
        return {
          kind: "ok",
          result: {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            structuredContent: payload,
            isError: true,
          },
        };
      }
      return { kind: "rpc_error", code: -32603, message: e instanceof Error ? e.message : "sfield tool execution failed" };
    } finally {
      if (scope && !suspended) {
        await scope.close().catch(() => undefined);
      }
    }
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
