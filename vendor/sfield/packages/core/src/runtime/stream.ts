/**
 * Ergonomic typed Run Streaming helper for @sfield/core (`streamRun` + SSE frame encoder).
 *
 * Normalizes raw persisted & live `RunEvent` records from `RunHandle.events()` into strongly-typed
 * stream chunks ready for SSE endpoints, AG-UI adapters, or CLI/terminal renderers.
 */
import type { JsonObject } from "../types/common.js";
import type { RunEvent, RunHandle } from "../types/runtime.js";

export type RunStreamChunk =
  | { kind: "run_started"; runId: string; timestamp: string; seq?: number }
  | { kind: "text_delta"; runId: string; timestamp: string; delta: string; seq?: number }
  | { kind: "tool_proposed"; runId: string; timestamp: string; toolRef?: string; callId?: string; seq?: number }
  | { kind: "approval_requested"; runId: string; timestamp: string; approvalId?: string; callIds?: string[]; seq?: number }
  | { kind: "tool_finished"; runId: string; timestamp: string; toolRef?: string; callId?: string; status?: string; seq?: number }
  | { kind: "run_suspended"; runId: string; timestamp: string; reason?: string; seq?: number }
  | { kind: "run_finished"; runId: string; timestamp: string; state?: string; seq?: number }
  | { kind: "event"; runId: string; timestamp: string; eventType: string; payload: JsonObject; seq?: number };

export function normalizeRunEvent(ev: RunEvent): RunStreamChunk {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const base = { runId: ev.runId, timestamp: ev.timestamp, ...(ev.seq !== undefined ? { seq: ev.seq } : {}) };

  if (ev.type === "run_started") {
    return { kind: "run_started", ...base };
  }
  if (ev.type === "model_delta" || ev.type === "text_delta" || ev.type === "assistant_delta") {
    const delta = typeof p.delta === "string" ? p.delta : typeof p.text === "string" ? p.text : "";
    return { kind: "text_delta", delta, ...base };
  }
  if (ev.type === "tool_proposed" || ev.type === "tool_call_proposed") {
    return {
      kind: "tool_proposed",
      ...(typeof p.toolRef === "string" ? { toolRef: p.toolRef } : {}),
      ...(typeof p.callId === "string" ? { callId: p.callId } : {}),
      ...base,
    };
  }
  if (ev.type === "approval_requested") {
    return {
      kind: "approval_requested",
      ...(typeof p.approvalId === "string" ? { approvalId: p.approvalId } : {}),
      ...(Array.isArray(p.callIds) ? { callIds: p.callIds.map(String) } : {}),
      ...base,
    };
  }
  if (ev.type === "tool_finished" || ev.type === "tool_call_finished") {
    return {
      kind: "tool_finished",
      ...(typeof p.toolRef === "string" ? { toolRef: p.toolRef } : {}),
      ...(typeof p.callId === "string" ? { callId: p.callId } : {}),
      ...(typeof p.status === "string" ? { status: p.status } : {}),
      ...base,
    };
  }
  if (ev.type === "run_suspended") {
    return { kind: "run_suspended", ...(typeof p.reason === "string" ? { reason: p.reason } : {}), ...base };
  }
  if (ev.type === "run_finished") {
    return { kind: "run_finished", ...(typeof p.state === "string" ? { state: p.state } : {}), ...base };
  }
  return { kind: "event", eventType: ev.type, payload: ev.payload, ...base };
}

/** Streams typed, normalized lifecycle and delta chunks from any `RunHandle`. */
export async function* streamRun(handle: RunHandle, opts: { after?: string } = {}): AsyncIterable<RunStreamChunk> {
  for await (const ev of handle.events(opts)) {
    yield normalizeRunEvent(ev);
  }
}

/** Encodes a `RunStreamChunk` as a standard Server-Sent Events (SSE) frame. */
export function formatRunStreamSse(chunk: RunStreamChunk): string {
  const idLine = chunk.seq !== undefined ? `id: ${chunk.seq}\n` : "";
  return `${idLine}event: ${chunk.kind}\ndata: ${JSON.stringify(chunk)}\n\n`;
}
