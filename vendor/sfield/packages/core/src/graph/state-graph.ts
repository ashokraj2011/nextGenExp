/**
 * Governed State Graph Engine (`defineGraph` / `sf.graphs`) for `@sfield/core`.
 *
 * Brings LangGraph-style typed state-machine orchestration (nodes, conditional edges,
 * parallel fan-out, mid-graph interrupts, and checkpoint Time-Travel fork/replay)
 * directly inside `sfield`'s zero-trust governance kernel — enforcing `Principal`
 * identity, per-node `PolicyPreset` isolation, and `ExecutionScope` tool calls on every node.
 */
import type { JsonObject, Principal } from "../types/common.js";
import type { PolicyPreset } from "../policy/presets.js";
import type { ExecutionScope, ExecutionScopeOptions } from "../runtime/execution-scope.js";
import type { ToolResult } from "../types/tool.js";
import { SFieldError } from "../errors.js";
import { newId, nowIso } from "../util/digest.js";

export const GRAPH_END = "__end__" as const;
export type GraphEnd = typeof GRAPH_END;

export interface GraphInterruptSignal {
  readonly __sfieldGraphInterrupt: true;
  readonly reason: string;
  readonly payload?: Record<string, unknown>;
}

export function graphInterrupt(reason: string, payload?: Record<string, unknown>): GraphInterruptSignal {
  return { __sfieldGraphInterrupt: true, reason, ...(payload ? { payload } : {}) };
}

function isGraphInterrupt(value: unknown): value is GraphInterruptSignal {
  return Boolean(
    value
    && typeof value === "object"
    && (value as { __sfieldGraphInterrupt?: unknown }).__sfieldGraphInterrupt === true,
  );
}

export interface GraphNodeContext<TState extends Record<string, unknown>> {
  readonly runId: string;
  readonly graphId: string;
  readonly nodeId: string;
  readonly stepIndex: number;
  readonly principal: Principal;
  readonly preset: PolicyPreset;
  /** Value passed into `sf.graphs.resume({ resumeValue })` when resuming an interrupted node. */
  readonly resumeValue?: unknown;
  /** Invoke any registered `sfield` tool through a governed `ExecutionScope`. */
  callTool(toolRef: string, inputs: JsonObject, presetOverride?: PolicyPreset): Promise<ToolResult>;
  /** Pause the graph at a durable checkpoint until a human/caller resumes it. */
  interrupt(reason: string, payload?: Record<string, unknown>): GraphInterruptSignal;
  /** Snapshot of the current state (read-only copy). */
  getState(): Readonly<TState>;
}

export type GraphNodeResult<TState extends Record<string, unknown>> =
  | Partial<TState>
  | GraphInterruptSignal
  | void;

export interface GraphFunctionNode<TState extends Record<string, unknown>> {
  kind?: "fn";
  /** Optional policy preset for tool calls inside this node (defaults to run preset, usually `read_only`). */
  preset?: PolicyPreset;
  description?: string;
  handler: (state: Readonly<TState>, ctx: GraphNodeContext<TState>) => Promise<GraphNodeResult<TState>> | GraphNodeResult<TState>;
}

export interface GraphParallelNode<TState extends Record<string, unknown>> {
  kind: "parallel";
  description?: string;
  /** Node IDs to execute concurrently against the current state snapshot. */
  branches: readonly string[];
  /** Optional custom reducer to merge branch partial states (defaults to shallow Object.assign in branch order). */
  merge?: (state: Readonly<TState>, branchPatches: Array<{ nodeId: string; patch: Partial<TState> }>) => Partial<TState>;
}

export type GraphNode<TState extends Record<string, unknown>> =
  | GraphFunctionNode<TState>
  | GraphParallelNode<TState>;

export interface GraphDefinition<TState extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  version: string;
  description?: string;
  entry: string;
  nodes: Record<string, GraphNode<TState>>;
  /** Static transitions: nodeId -> nextNodeId | "__end__". */
  edges?: Record<string, string | GraphEnd>;
  /** Dynamic transitions evaluated on the updated state: nodeId -> (state) => nextNodeId | "__end__". */
  conditionalEdges?: Record<string, (state: Readonly<TState>) => string | GraphEnd>;
  /** Default step ceiling to prevent infinite loops (default 50). */
  maxSteps?: number;
}

export interface GraphCheckpoint<TState extends Record<string, unknown> = Record<string, unknown>> {
  checkpointId: string;
  stepIndex: number;
  nodeId: string;
  preset: PolicyPreset;
  status: "completed" | "interrupted" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stateBefore: TState;
  stateAfter: TState;
  toolCalls: Array<{ toolRef: string; status: string; callId?: string; durationMs: number }>;
  interrupt?: { reason: string; payload?: Record<string, unknown> };
  error?: string;
}

export interface GraphRunRecord<TState extends Record<string, unknown> = Record<string, unknown>> {
  runId: string;
  graphId: string;
  graphVersion: string;
  tenantId: string;
  subjectId: string;
  status: "completed" | "interrupted" | "failed";
  currentNodeId: string | GraphEnd;
  state: TState;
  checkpoints: GraphCheckpoint<TState>[];
  interrupt?: { nodeId: string; checkpointId: string; reason: string; payload?: Record<string, unknown> };
  error?: string;
  parentRunId?: string;
  forkedFromCheckpointId?: string;
  createdAt: string;
  updatedAt: string;
  totalDurationMs: number;
}

export interface GraphExecutionHost {
  readonly executions: {
    open(options: ExecutionScopeOptions): Promise<ExecutionScope>;
  };
}

/** Validates and returns a strongly-typed `GraphDefinition`. */
export function defineGraph<TState extends Record<string, unknown>>(
  spec: GraphDefinition<TState>,
): GraphDefinition<TState> {
  if (!spec.id || !spec.id.trim()) {
    throw new SFieldError("INVALID_INPUT", "Graph id is required.");
  }
  if (!spec.nodes || !spec.nodes[spec.entry]) {
    throw new SFieldError("INVALID_INPUT", `Graph "${spec.id}" entry node "${spec.entry}" does not exist.`);
  }
  for (const [from, to] of Object.entries(spec.edges ?? {})) {
    if (!spec.nodes[from]) {
      throw new SFieldError("INVALID_INPUT", `Graph "${spec.id}" edge source "${from}" does not exist.`);
    }
    if (to !== GRAPH_END && !spec.nodes[to]) {
      throw new SFieldError("INVALID_INPUT", `Graph "${spec.id}" edge target "${to}" does not exist.`);
    }
  }
  for (const [nodeId, node] of Object.entries(spec.nodes)) {
    if (node.kind === "parallel") {
      if (!node.branches.length) {
        throw new SFieldError("INVALID_INPUT", `Parallel node "${nodeId}" must declare at least one branch.`);
      }
      for (const b of node.branches) {
        if (!spec.nodes[b]) {
          throw new SFieldError("INVALID_INPUT", `Parallel node "${nodeId}" references unknown branch "${b}".`);
        }
      }
    }
  }
  return spec;
}

function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class GraphService {
  private readonly definitions = new Map<string, GraphDefinition<Record<string, unknown>>>();
  private readonly runs = new Map<string, GraphRunRecord<Record<string, unknown>>>();
  private readonly maxRuns: number;

  constructor(private readonly host: GraphExecutionHost, maxRuns = 200) {
    this.maxRuns = maxRuns;
  }

  register<TState extends Record<string, unknown>>(graph: GraphDefinition<TState>): this {
    this.definitions.set(graph.id, graph as unknown as GraphDefinition<Record<string, unknown>>);
    return this;
  }

  list(): Array<{ id: string; version: string; description?: string; entry: string; nodes: string[] }> {
    return [...this.definitions.values()].map((g) => ({
      id: g.id,
      version: g.version,
      ...(g.description ? { description: g.description } : {}),
      entry: g.entry,
      nodes: Object.keys(g.nodes),
    }));
  }

  get<TState extends Record<string, unknown> = Record<string, unknown>>(id: string): GraphDefinition<TState> | undefined {
    return this.definitions.get(id) as GraphDefinition<TState> | undefined;
  }

  listRuns(filter: { tenantId?: string; graphId?: string } = {}): GraphRunRecord[] {
    const out: GraphRunRecord[] = [];
    for (const r of this.runs.values()) {
      if (filter.tenantId && r.tenantId !== filter.tenantId) continue;
      if (filter.graphId && r.graphId !== filter.graphId) continue;
      out.push(r);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getRun<TState extends Record<string, unknown> = Record<string, unknown>>(runId: string): GraphRunRecord<TState> | undefined {
    return this.runs.get(runId) as GraphRunRecord<TState> | undefined;
  }

  async run<TState extends Record<string, unknown>>(input: {
    graph: GraphDefinition<TState> | string;
    principal: Principal;
    initialState: TState;
    preset?: PolicyPreset;
    maxSteps?: number;
  }): Promise<GraphRunRecord<TState>> {
    const graph = typeof input.graph === "string"
      ? this.get<TState>(input.graph)
      : input.graph;
    if (!graph) {
      throw new SFieldError("INVALID_INPUT", `Unknown graph: ${String(input.graph)}`);
    }
    if (!this.definitions.has(graph.id)) {
      this.register(graph);
    }
    const runId = newId("grun");
    const createdAt = nowIso();
    const record: GraphRunRecord<TState> = {
      runId,
      graphId: graph.id,
      graphVersion: graph.version,
      tenantId: input.principal.tenantId,
      subjectId: input.principal.subjectId,
      status: "completed",
      currentNodeId: graph.entry,
      state: cloneState(input.initialState),
      checkpoints: [],
      createdAt,
      updatedAt: createdAt,
      totalDurationMs: 0,
    };
    await this.executeLoop(graph, record, input.principal, input.preset ?? "read_only", input.maxSteps ?? graph.maxSteps ?? 50);
    this.saveRun(record as unknown as GraphRunRecord<Record<string, unknown>>);
    return record;
  }

  async resume<TState extends Record<string, unknown>>(input: {
    runId: string;
    principal: Principal;
    resumeValue?: unknown;
    statePatch?: Partial<TState>;
    preset?: PolicyPreset;
    maxSteps?: number;
  }): Promise<GraphRunRecord<TState>> {
    const record = this.getRun<TState>(input.runId);
    if (!record) {
      throw new SFieldError("INVALID_INPUT", `Unknown graph run: ${input.runId}`);
    }
    if (record.tenantId !== input.principal.tenantId) {
      throw new SFieldError("AUTHORIZATION_DENIED", "Access denied to graph run belonging to another tenant.");
    }
    if (record.status !== "interrupted" || !record.interrupt) {
      throw new SFieldError("INVALID_INPUT", `Graph run "${input.runId}" is not interrupted (status=${record.status}).`);
    }
    const graph = this.get<TState>(record.graphId);
    if (!graph) {
      throw new SFieldError("INVALID_INPUT", `Graph definition "${record.graphId}" is no longer registered.`);
    }
    if (input.statePatch) {
      record.state = { ...record.state, ...cloneState(input.statePatch) };
    }
    record.currentNodeId = record.interrupt.nodeId;
    record.interrupt = undefined;
    await this.executeLoop(
      graph,
      record,
      input.principal,
      input.preset ?? "read_only",
      input.maxSteps ?? graph.maxSteps ?? 50,
      input.resumeValue,
    );
    this.saveRun(record as unknown as GraphRunRecord<Record<string, unknown>>);
    return record;
  }

  /**
   * Time-Travel Fork & Replay: creates a brand-new child graph run starting from
   * any historical checkpoint's `stateBefore` (optionally patched with `stateOverride`),
   * re-executing from that exact node forward while preserving the original run immutably.
   */
  async forkAndReplay<TState extends Record<string, unknown>>(input: {
    runId: string;
    checkpointId: string;
    principal: Principal;
    stateOverride?: Partial<TState>;
    preset?: PolicyPreset;
    maxSteps?: number;
  }): Promise<GraphRunRecord<TState>> {
    const source = this.getRun<TState>(input.runId);
    if (!source) {
      throw new SFieldError("INVALID_INPUT", `Unknown graph run: ${input.runId}`);
    }
    if (source.tenantId !== input.principal.tenantId) {
      throw new SFieldError("AUTHORIZATION_DENIED", "Access denied to graph run belonging to another tenant.");
    }
    const cpIndex = source.checkpoints.findIndex((c) => c.checkpointId === input.checkpointId);
    if (cpIndex < 0) {
      throw new SFieldError("INVALID_INPUT", `Unknown checkpoint "${input.checkpointId}" in run "${input.runId}".`);
    }
    const targetCp = source.checkpoints[cpIndex]!;
    const graph = this.get<TState>(source.graphId);
    if (!graph) {
      throw new SFieldError("INVALID_INPUT", `Graph definition "${source.graphId}" is no longer registered.`);
    }

    const forkedRunId = newId("grun");
    const createdAt = nowIso();
    const priorCheckpoints = cloneState(source.checkpoints.slice(0, cpIndex));
    const forkedState: TState = {
      ...cloneState(targetCp.stateBefore),
      ...(input.stateOverride ? cloneState(input.stateOverride) : {}),
    };

    const forked: GraphRunRecord<TState> = {
      runId: forkedRunId,
      graphId: graph.id,
      graphVersion: graph.version,
      tenantId: input.principal.tenantId,
      subjectId: input.principal.subjectId,
      status: "completed",
      currentNodeId: targetCp.nodeId,
      state: forkedState,
      checkpoints: priorCheckpoints,
      parentRunId: source.runId,
      forkedFromCheckpointId: targetCp.checkpointId,
      createdAt,
      updatedAt: createdAt,
      totalDurationMs: priorCheckpoints.reduce((sum, c) => sum + c.durationMs, 0),
    };

    await this.executeLoop(graph, forked, input.principal, input.preset ?? "read_only", input.maxSteps ?? graph.maxSteps ?? 50);
    this.saveRun(forked as unknown as GraphRunRecord<Record<string, unknown>>);
    return forked;
  }

  private async executeLoop<TState extends Record<string, unknown>>(
    graph: GraphDefinition<TState>,
    record: GraphRunRecord<TState>,
    principal: Principal,
    defaultPreset: PolicyPreset,
    maxSteps: number,
    initialResumeValue?: unknown,
  ): Promise<void> {
    let stepsExecuted = 0;
    let resumeVal = initialResumeValue;

    while (record.currentNodeId !== GRAPH_END) {
      if (stepsExecuted >= maxSteps) {
        record.status = "failed";
        record.error = `Graph "${graph.id}" exceeded maxSteps (${maxSteps}).`;
        record.updatedAt = nowIso();
        return;
      }
      const nodeId = record.currentNodeId;
      const node = graph.nodes[nodeId];
      if (!node) {
        record.status = "failed";
        record.error = `Graph "${graph.id}" transitioned to unknown node "${nodeId}".`;
        record.updatedAt = nowIso();
        return;
      }

      const stepIndex = record.checkpoints.length;
      const startedAt = nowIso();
      const startedMs = Date.now();
      const stateBefore = cloneState(record.state);
      const toolCalls: GraphCheckpoint<TState>["toolCalls"] = [];
      const nodePreset: PolicyPreset = node.kind === "parallel" ? defaultPreset : (node.preset ?? defaultPreset);

      try {
        let outcome: GraphNodeResult<TState>;
        if (node.kind === "parallel") {
          const branchResults = await Promise.all(
            node.branches.map(async (branchId) => {
              const branchNode = graph.nodes[branchId];
              if (!branchNode || branchNode.kind === "parallel") {
                throw new SFieldError("INVALID_INPUT", `Parallel branch "${branchId}" must be a function node.`);
              }
              const branchPreset = branchNode.preset ?? defaultPreset;
              const branchOut = await this.invokeFunctionNode(
                branchNode,
                graph.id,
                record.runId,
                branchId,
                stepIndex,
                principal,
                branchPreset,
                stateBefore,
                toolCalls,
                undefined,
              );
              if (isGraphInterrupt(branchOut)) {
                throw new SFieldError("INVALID_INPUT", `Parallel branch "${branchId}" cannot interrupt directly.`);
              }
              return { nodeId: branchId, patch: (branchOut ?? {}) as Partial<TState> };
            }),
          );
          outcome = node.merge
            ? node.merge(stateBefore, branchResults)
            : Object.assign({}, ...branchResults.map((b) => b.patch)) as Partial<TState>;
        } else {
          outcome = await this.invokeFunctionNode(
            node,
            graph.id,
            record.runId,
            nodeId,
            stepIndex,
            principal,
            nodePreset,
            stateBefore,
            toolCalls,
            resumeVal,
          );
          resumeVal = undefined;
        }

        const finishedAt = nowIso();
        const durationMs = Math.max(0, Date.now() - startedMs);

        if (isGraphInterrupt(outcome)) {
          const checkpointId = newId("gcp");
          record.checkpoints.push({
            checkpointId,
            stepIndex,
            nodeId,
            preset: nodePreset,
            status: "interrupted",
            startedAt,
            finishedAt,
            durationMs,
            stateBefore,
            stateAfter: cloneState(record.state),
            toolCalls,
            interrupt: { reason: outcome.reason, ...(outcome.payload ? { payload: outcome.payload } : {}) },
          });
          record.status = "interrupted";
          record.interrupt = {
            nodeId,
            checkpointId,
            reason: outcome.reason,
            ...(outcome.payload ? { payload: outcome.payload } : {}),
          };
          record.totalDurationMs += durationMs;
          record.updatedAt = finishedAt;
          return;
        }

        if (outcome && typeof outcome === "object") {
          record.state = { ...record.state, ...cloneState(outcome as Partial<TState>) };
        }
        const stateAfter = cloneState(record.state);
        record.checkpoints.push({
          checkpointId: newId("gcp"),
          stepIndex,
          nodeId,
          preset: nodePreset,
          status: "completed",
          startedAt,
          finishedAt,
          durationMs,
          stateBefore,
          stateAfter,
          toolCalls,
        });
        record.totalDurationMs += durationMs;
        record.updatedAt = finishedAt;

        // Resolve next transition
        const cond = graph.conditionalEdges?.[nodeId];
        const nextNode = cond ? cond(stateAfter) : (graph.edges?.[nodeId] ?? GRAPH_END);
        record.currentNodeId = nextNode;
        stepsExecuted += 1;
      } catch (err) {
        const finishedAt = nowIso();
        const durationMs = Math.max(0, Date.now() - startedMs);
        const message = err instanceof Error ? err.message : String(err);
        record.checkpoints.push({
          checkpointId: newId("gcp"),
          stepIndex,
          nodeId,
          preset: nodePreset,
          status: "failed",
          startedAt,
          finishedAt,
          durationMs,
          stateBefore,
          stateAfter: cloneState(record.state),
          toolCalls,
          error: message,
        });
        record.status = "failed";
        record.error = message;
        record.totalDurationMs += durationMs;
        record.updatedAt = finishedAt;
        return;
      }
    }

    record.status = "completed";
    record.updatedAt = nowIso();
  }

  private async invokeFunctionNode<TState extends Record<string, unknown>>(
    node: GraphFunctionNode<TState>,
    graphId: string,
    runId: string,
    nodeId: string,
    stepIndex: number,
    principal: Principal,
    preset: PolicyPreset,
    stateSnapshot: TState,
    toolCalls: GraphCheckpoint<TState>["toolCalls"],
    resumeValue: unknown,
  ): Promise<GraphNodeResult<TState>> {
    const ctx: GraphNodeContext<TState> = {
      runId,
      graphId,
      nodeId,
      stepIndex,
      principal,
      preset,
      ...(resumeValue !== undefined ? { resumeValue } : {}),
      callTool: async (toolRef, inputs, presetOverride) => {
        const effectivePreset = presetOverride ?? preset;
        const t0 = Date.now();
        const scope = await this.host.executions.open({
          principal,
          preset: effectivePreset,
          purpose: `graph:${graphId}:${nodeId}`,
          budget: { maxToolCalls: 4 },
        });
        try {
          const res = await scope.registry.execute(toolRef, inputs);
          toolCalls.push({
            toolRef,
            status: res.status,
            ...(res.callId ? { callId: res.callId } : {}),
            durationMs: Math.max(0, Date.now() - t0),
          });
          return res;
        } finally {
          await scope.close().catch(() => undefined);
        }
      },
      interrupt: (reason, payload) => graphInterrupt(reason, payload),
      getState: () => stateSnapshot,
    };
    return node.handler(stateSnapshot, ctx);
  }

  private saveRun(record: GraphRunRecord<Record<string, unknown>>): void {
    this.runs.set(record.runId, record);
    if (this.runs.size > this.maxRuns) {
      const oldest = this.runs.keys().next().value;
      if (oldest) this.runs.delete(oldest);
    }
  }
}
