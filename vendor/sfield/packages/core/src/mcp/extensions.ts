/**
 * MCP 2026 Extensions: Elicitation (multi-round-trip HITL input) & Async Tasks.
 *
 * Keeps protocol types, elicitation error helpers, and tenant-scoped in-memory
 * task/elicitation tracking cleanly decoupled from core JSON-RPC routing.
 */
import type { JsonObject, Principal } from "../types/common.js";
import type { PolicyPreset } from "../policy/presets.js";
import { ToolError } from "../registry/tool-error.js";
import { newId, nowIso } from "../util/digest.js";
import type { McpCallResult } from "./server.js";

export const MCP_PROTOCOL_VERSION_2026 = "2026-07-28";
export const MCP_EXTENSION_ELICITATION = "io.modelcontextprotocol/elicitation";
export const MCP_EXTENSION_TASKS = "io.modelcontextprotocol/tasks";

export type McpElicitationAction = "accept" | "decline" | "cancel";
export type McpElicitationStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired";

export interface McpElicitationRequest {
  elicitationId: string;
  mode: "form";
  message: string;
  requestedSchema: JsonObject;
  expiresAt?: string;
}

export interface McpElicitationRecord extends McpElicitationRequest {
  toolName: string;
  originalArgs: Record<string, unknown>;
  principal: Principal;
  preset: PolicyPreset;
  status: McpElicitationStatus;
  createdAt: string;
  updatedAt: string;
  taskId?: string;
  response?: {
    action: McpElicitationAction;
    content?: Record<string, unknown>;
    respondedAt: string;
  };
}

export type McpTaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export interface McpTaskSummary {
  taskId: string;
  toolName: string;
  status: McpTaskStatus;
  statusMessage?: string;
  pollIntervalMs?: number;
  createdAt: string;
  updatedAt: string;
  ttlMs: number;
  elicitation?: McpElicitationRequest;
}

export interface McpTaskRecord extends McpTaskSummary {
  tenantId: string;
  subjectId: string;
  result?: McpCallResult;
  error?: { code: number; message: string };
  controller?: AbortController;
}

/**
 * Thrown by a tool handler (or extraTool) when it needs structured human input
 * via the MCP 2026 Elicitation extension (`input_required` -> `elicitation/respond`).
 * Extends `ToolError` with `effect: "none"` so native `defineTool` handlers also propagate cleanly.
 */
export class ElicitationRequiredError extends ToolError {
  readonly elicitationId: string;
  readonly promptMessage: string;
  readonly requestedSchema: JsonObject;
  readonly ttlMs: number;

  constructor(input: {
    message: string;
    requestedSchema: JsonObject;
    elicitationId?: string;
    ttlMs?: number;
  }) {
    const elicitationId = input.elicitationId ?? newId("elicit");
    const ttlMs = input.ttlMs ?? 10 * 60_000;
    const encoded = JSON.stringify({
      elicitationId,
      message: input.message,
      requestedSchema: input.requestedSchema,
      ttlMs,
    });
    super("ELICITATION_REQUIRED", encoded, { effect: "none", retryable: false });
    this.name = "ElicitationRequiredError";
    this.elicitationId = elicitationId;
    this.promptMessage = input.message;
    this.requestedSchema = input.requestedSchema;
    this.ttlMs = ttlMs;
  }
}

export function parseElicitationToolError(error?: { code?: string; message?: string }): {
  elicitationId: string;
  message: string;
  requestedSchema: JsonObject;
  ttlMs: number;
} | null {
  if (!error || error.code !== "ELICITATION_REQUIRED" || !error.message) return null;
  try {
    const parsed = JSON.parse(error.message) as Record<string, unknown>;
    if (
      typeof parsed["elicitationId"] === "string"
      && typeof parsed["message"] === "string"
      && parsed["requestedSchema"]
      && typeof parsed["requestedSchema"] === "object"
      && !Array.isArray(parsed["requestedSchema"])
    ) {
      return {
        elicitationId: parsed["elicitationId"],
        message: parsed["message"],
        requestedSchema: parsed["requestedSchema"] as JsonObject,
        ttlMs: typeof parsed["ttlMs"] === "number" ? parsed["ttlMs"] : 10 * 60_000,
      };
    }
  } catch {
    // ignore malformed
  }
  return null;
}

/** Convenience helper for tool handlers to pause and request structured human input over MCP Elicitation. */
export function requestElicitation(input: {
  message: string;
  requestedSchema: JsonObject;
  elicitationId?: string;
  ttlMs?: number;
}): never {
  throw new ElicitationRequiredError(input);
}

/** Tenant-scoped store for active MCP 2026 async tasks and pending elicitations. */
export class McpExtensionStore {
  private readonly tasks = new Map<string, McpTaskRecord>();
  private readonly elicitations = new Map<string, McpElicitationRecord>();
  private readonly maxRecords: number;

  constructor(maxRecords = 500) {
    this.maxRecords = maxRecords;
  }

  createTask(input: {
    toolName: string;
    tenantId: string;
    subjectId: string;
    ttlMs?: number;
    pollIntervalMs?: number;
    controller: AbortController;
  }): McpTaskRecord {
    const now = nowIso();
    const record: McpTaskRecord = {
      taskId: newId("mcptask"),
      toolName: input.toolName,
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      status: "working",
      statusMessage: `Executing ${input.toolName}`,
      pollIntervalMs: input.pollIntervalMs ?? 250,
      createdAt: now,
      updatedAt: now,
      ttlMs: input.ttlMs ?? 5 * 60_000,
      controller: input.controller,
    };
    this.tasks.set(record.taskId, record);
    this.pruneMap(this.tasks);
    return record;
  }

  getTask(taskId: string): McpTaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(filter: { tenantId?: string; status?: McpTaskStatus } = {}): McpTaskSummary[] {
    const out: McpTaskSummary[] = [];
    for (const rec of this.tasks.values()) {
      if (filter.tenantId && rec.tenantId !== filter.tenantId) continue;
      if (filter.status && rec.status !== filter.status) continue;
      out.push(this.toTaskSummary(rec));
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  updateTask(taskId: string, patch: Partial<Pick<McpTaskRecord, "status" | "statusMessage" | "elicitation" | "result" | "error">>): McpTaskRecord | undefined {
    const rec = this.tasks.get(taskId);
    if (!rec) return undefined;
    Object.assign(rec, patch, { updatedAt: nowIso() });
    if (patch.status && ["completed", "failed", "cancelled"].includes(patch.status)) {
      rec.controller = undefined;
    }
    return rec;
  }

  toTaskSummary(rec: McpTaskRecord): McpTaskSummary {
    return {
      taskId: rec.taskId,
      toolName: rec.toolName,
      status: rec.status,
      ...(rec.statusMessage ? { statusMessage: rec.statusMessage } : {}),
      ...(rec.pollIntervalMs !== undefined ? { pollIntervalMs: rec.pollIntervalMs } : {}),
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      ttlMs: rec.ttlMs,
      ...(rec.elicitation ? { elicitation: rec.elicitation } : {}),
    };
  }

  createElicitation(input: {
    elicitationId?: string;
    message: string;
    requestedSchema: JsonObject;
    toolName: string;
    originalArgs: Record<string, unknown>;
    principal: Principal;
    preset: PolicyPreset;
    ttlMs?: number;
    taskId?: string;
  }): McpElicitationRecord {
    const now = nowIso();
    const expiresAt = new Date(Date.now() + (input.ttlMs ?? 10 * 60_000)).toISOString();
    const record: McpElicitationRecord = {
      elicitationId: input.elicitationId ?? newId("elicit"),
      mode: "form",
      message: input.message,
      requestedSchema: input.requestedSchema,
      expiresAt,
      toolName: input.toolName,
      originalArgs: input.originalArgs,
      principal: input.principal,
      preset: input.preset,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      ...(input.taskId ? { taskId: input.taskId } : {}),
    };
    this.elicitations.set(record.elicitationId, record);
    this.pruneMap(this.elicitations);
    return record;
  }

  getElicitation(elicitationId: string): McpElicitationRecord | undefined {
    const rec = this.elicitations.get(elicitationId);
    if (!rec) return undefined;
    if (rec.status === "pending" && rec.expiresAt && Date.parse(rec.expiresAt) < Date.now()) {
      rec.status = "expired";
      rec.updatedAt = nowIso();
    }
    return rec;
  }

  listElicitations(filter: { tenantId?: string; status?: McpElicitationStatus } = {}): McpElicitationRequest[] {
    const out: McpElicitationRequest[] = [];
    for (const id of this.elicitations.keys()) {
      const rec = this.getElicitation(id);
      if (!rec) continue;
      if (filter.tenantId && rec.principal.tenantId !== filter.tenantId) continue;
      if (filter.status && rec.status !== filter.status) continue;
      out.push(this.toElicitationRequest(rec));
    }
    return out;
  }

  toElicitationRequest(rec: McpElicitationRecord): McpElicitationRequest {
    return {
      elicitationId: rec.elicitationId,
      mode: rec.mode,
      message: rec.message,
      requestedSchema: rec.requestedSchema,
      ...(rec.expiresAt ? { expiresAt: rec.expiresAt } : {}),
    };
  }

  private pruneMap<T>(map: Map<string, T>): void {
    while (map.size > this.maxRecords) {
      const firstKey = map.keys().next().value;
      if (firstKey === undefined) break;
      map.delete(firstKey);
    }
  }
}
