/**
 * Governed Sub-Agent Delegation for @sfield/core.
 *
 * Allows an orchestrator or parent agent to delegate a scoped task to another registered
 * sfield agent while enforcing:
 * - Zero identity escalation (child runs under the parent's verified Principal)
 * - Bounded recursion depth (`maxDelegationDepth`, defaults to 3)
 * - Full immutable parent -> child audit linkage (`delegation_started` / `delegation_finished`)
 * - Clean `AbortSignal` propagation (cancels child run if parent aborts)
 */
import type { JsonObject, Principal } from "../types/common.js";
import type { ExecutionPersistence } from "../types/persistence.js";
import type { RunResult, Session } from "../types/runtime.js";
import { SFieldError } from "../errors.js";
import { newId, nowIso } from "../util/digest.js";

export interface DelegateInput {
  /** Parent run ID (or external execution scope ID) that initiated this delegation. */
  parentRunId: string;
  /** Registered child agent ID from sfield config. */
  agent: string;
  /** Prompt/instruction passed to the child agent. */
  message: string;
  /** Authenticated Principal (must match parent run's tenantId & subjectId when parent exists). */
  principal: Principal;
  /** Optional structured inputs forwarded to the child run. */
  inputs?: JsonObject;
  /** Current delegation depth (0 for top-level parent). Defaults to 0. */
  depth?: number;
  /** Maximum allowed delegation depth. Defaults to 3. */
  maxDepth?: number;
  /** Optional AbortSignal; aborting cancels the child run cleanly. */
  signal?: AbortSignal;
}

export interface DelegationOutcome {
  delegationId: string;
  parentRunId: string;
  childRunId: string;
  agent: string;
  depth: number;
  result: RunResult;
}

export interface DelegatedChildRecord {
  delegationId: string;
  parentRunId: string;
  childRunId: string;
  agent: string;
  depth: number;
  state: string;
  startedAt: string;
  finishedAt?: string;
}

export interface DelegationDeps {
  persistence: ExecutionPersistence;
  openSession: (opts: { agent: string; principal: Principal }) => Promise<Session>;
}

export class DelegationService {
  constructor(private readonly deps: DelegationDeps) {}

  async delegate(input: DelegateInput): Promise<DelegationOutcome> {
    const depth = input.depth ?? 0;
    const maxDepth = input.maxDepth ?? 3;
    if (depth >= maxDepth) {
      throw new SFieldError("LOOP_DETECTED", `Delegation depth ${depth} reached maxDepth ${maxDepth}`, {
        runId: input.parentRunId,
        details: { depth, maxDepth, agent: input.agent },
      });
    }

    // Verify zero identity escalation against persisted parent run if present.
    const parent = await this.deps.persistence.getRun(input.parentRunId);
    if (parent) {
      if (parent.tenantId !== input.principal.tenantId || parent.subjectId !== input.principal.subjectId) {
        throw new SFieldError(
          "ACCESS_DENIED",
          "Delegated child run cannot escalate or switch Principal identity from its parent run",
          { runId: input.parentRunId },
        );
      }
    }

    const delegationId = newId("del");
    const session = await this.deps.openSession({ agent: input.agent, principal: input.principal });
    try {
      const handle = await session.send({
        message: { text: input.message },
        inputs: {
          ...(input.inputs ?? {}),
          _sfieldParentRunId: input.parentRunId,
          _sfieldDelegationId: delegationId,
          _sfieldDelegationDepth: depth + 1,
        },
        idempotencyKey: `del_${delegationId}`,
      });

      await this.deps.persistence.appendAudit([{
        id: newId("aud"),
        at: nowIso(),
        tenantId: input.principal.tenantId,
        runId: input.parentRunId,
        type: "delegation_started",
        principal: { tenantId: input.principal.tenantId, subjectId: input.principal.subjectId },
        data: {
          delegationId,
          parentRunId: input.parentRunId,
          childRunId: handle.id,
          agent: input.agent,
          depth: depth + 1,
        },
      }]);

      const onAbort = () => { void handle.cancel("Parent delegation aborted").catch(() => undefined); };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      let result: RunResult;
      try {
        if (input.signal?.aborted) onAbort();
        result = await handle.result();
      } finally {
        input.signal?.removeEventListener("abort", onAbort);
      }

      await this.deps.persistence.appendAudit([{
        id: newId("aud"),
        at: nowIso(),
        tenantId: input.principal.tenantId,
        runId: input.parentRunId,
        type: "delegation_finished",
        principal: { tenantId: input.principal.tenantId, subjectId: input.principal.subjectId },
        data: {
          delegationId,
          parentRunId: input.parentRunId,
          childRunId: handle.id,
          agent: input.agent,
          depth: depth + 1,
          state: result.state,
          toolCalls: result.usage.toolCalls,
          totalTokens: result.usage.totalTokens,
        },
      }]);

      return {
        delegationId,
        parentRunId: input.parentRunId,
        childRunId: handle.id,
        agent: input.agent,
        depth: depth + 1,
        result,
      };
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  /** Lists all child delegations recorded under `parentRunId` from sfield's immutable audit log. */
  async tree(parentRunId: string, tenantId?: string): Promise<DelegatedChildRecord[]> {
    const records = await this.deps.persistence.readAudit({
      runId: parentRunId,
      ...(tenantId ? { tenantId } : {}),
      limit: 200,
    });
    const byId = new Map<string, DelegatedChildRecord>();
    for (const rec of records) {
      if (rec.type === "delegation_started") {
        const d = rec.data as { delegationId?: string; childRunId?: string; agent?: string; depth?: number };
        if (!d.delegationId || !d.childRunId) continue;
        byId.set(d.delegationId, {
          delegationId: d.delegationId,
          parentRunId,
          childRunId: d.childRunId,
          agent: String(d.agent ?? ""),
          depth: Number(d.depth ?? 1),
          state: "running",
          startedAt: rec.at,
        });
      } else if (rec.type === "delegation_finished") {
        const d = rec.data as { delegationId?: string; state?: string };
        if (!d.delegationId) continue;
        const cur = byId.get(d.delegationId);
        if (cur) {
          cur.state = String(d.state ?? "completed");
          cur.finishedAt = rec.at;
        }
      }
    }
    return [...byId.values()];
  }
}
