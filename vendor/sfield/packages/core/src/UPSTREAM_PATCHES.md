# Local patches to vendored sfield (upstream report)

These changes were made in `vendor/sfield/packages/core` for CEP integration tasks. Each one fixes a real
problem in sfield, so each should go upstream as its own issue and PR. They are written to be additive and
backwards compatible.

## 1. `approvals.decide()` breaks calls waiting in external execution scopes

**Symptom:** an external loop opens a scope with `sfield.executions.open()`. A call returns
`APPROVAL_REQUIRED`, the host calls `sfield.approvals.decide()`, and then `registry.execute(ref, inputs, { callId })`
fails with `OWNERSHIP_LOST` ("epoch N no longer owns run ...").

**Cause:** `ApprovalService.decide()` calls `onWakeup(runId)`, so `Scheduler.wakeup()` schedules
`AgentRuntime.execute(runId)` for the *external* run. The agent runtime takes the scope's claim (or fails it with
`UNKNOWN_AGENT`), so the host loop no longer owns the run.

**Fix** ([scheduler.ts](runtime/scheduler.ts)): `wakeup()` returns early when `run.kind === "external"`. External
scopes are driven by their host loop, not by the scheduler.

**Host workaround this removes:** CEP was writing the decision through `persistence.decideApproval()` to skip the
wakeup. It now uses `sfield.approvals.decide()`.

## 2. External execution scopes cannot be resumed after a restart

**Symptom:** every `executions.open()` creates a new run. If the process restarts while a call waits for approval,
nothing can continue that call, so its digest-bound approval can never be used. The only options were to
re-request approval or to re-grant a new approval automatically, which adds an extra trust step.

**Fix** ([execution-scope.ts](runtime/execution-scope.ts), [sfield.ts](sfield.ts)):

- `sfield.executions.resume({ runId, principal?, preset?, budget? })` reopens an external scope by id:
  - it uses the run's original principal (the caller must be in the same tenant);
  - it takes a new ownership epoch;
  - pending calls continue with `registry.execute(ref, inputs, { callId })`.
- Calls re-prepare against the scope's **pinned** `run.configDigest`, so the prepared-invocation digest still matches
  the existing approval even if the current configuration changed (for example, tools were added by `reload`).
  The tool digest is still part of the invocation, so a changed tool still invalidates the approval.
- `ExecutionScope.suspend()` releases ownership without finishing the run. `SField.close()` now suspends every open
  external scope, so after a clean shutdown the next process can resume at once.
- After a crash, `resume()` fails with `OWNERSHIP_UNAVAILABLE` (retryable) until the old lease expires (≤ 30 s).
- Resume and suspend are audited (`external_scope_resumed`, `external_scope_suspended`).

## 3. Code tools cannot be added after the first run

**Symptom:** `registerTool()` throws `REGISTRATION_CLOSED` after the first run. `reload()` only handles tools that
come from configuration (adapters), so a host whose tool set grows at runtime (for example, publishing a new
integration-task version) must restart.

**Fix** ([sfield.ts](sfield.ts), [registry.ts](registry/registry.ts)):

- `reload({ tools: DefineToolInput[] })` compiles a candidate that includes the extra code tools. The candidate goes
  through `checkLockApproved` (lock governance) *before* anything is registered.
- New tools are then added with `ToolRegistry.registerLate()`, which only adds new refs and never replaces one. An
  existing `id@version` with a different digest fails with `DUPLICATE_TOOL`.
- The return value includes `added: string[]`, and the `config_reloaded` audit record lists the added refs.
- Runs already in progress stay pinned to their configuration version.

## Tests covering these patches (in CEP)

[integration-tasks.test.ts](../../../../../tests/integration-tasks.test.ts):

- approval in the same process, via `approvals.decide()` (patch 1);
- restart, then approval resumes the original sfield run and approval, with exactly one sfield approval record (patch 2);
- a version published after startup is registered as a dedicated tool and runs, with and without approval (patch 3).

## 4. General-purpose multi-stage Agentic Harness (`sfield.harness`)

**Symptom:** Host applications building multi-step LLM capabilities (dynamic UI generation, multi-source RAG/Q&A, action planning, authoring copilots) either cram everything into a brittle single LLM call or re-implement ad-hoc plan/fetch/verify/repair loops outside `sfield`'s governance and audit trail.

**Fix** ([agentic-harness.ts](runtime/agentic-harness.ts), [sfield.ts](sfield.ts), [index.ts](index.ts)):

- Added `AgenticHarness` (`sfield.harness.run(spec)`) and standalone `runAgenticHarness(spec)` implementing a domain-agnostic 4-stage pipeline:
  1. `plan` — clarify intent, resolve follow-ups/corrections, or pause cleanly with `needs_clarification` / `needs_data`;
  2. `gather` — execute only the grounded data/tool reads selected by the plan;
  3. `synthesize` — produce a candidate output from the verified plan and evidence;
  4. `verify` + bounded `repair` (and optional deterministic `fallback`) — validate schema, grounding, and user constraints before returning.
- Every run gets a `hrn_*` id, honors `AbortSignal` between stages, captures per-stage timings in `HarnessTrace`, and appends an `agentic_harness_completed` audit record to `sfield`'s persistence store.

## 5. `buildContext` summarizer hook wired in `AgentRuntime` + context priority fix

**Symptom:** `buildContext()` implemented bounded per-turn history summarization when `agent.context.summarizer && input.summarize` were set, but `AgentRuntime.modelTurn()` never passed `summarize`, leaving dropped history unsummarized (`cp.counters.summarizations` always `0`). Also `AGENT_DEFAULTS.context.priority` placed `"summary"` last behind `"history"`, allowing verbose raw history to evict compact summaries.

**Fix** ([runtime.ts](runtime/runtime.ts), [defaults.ts](config/defaults.ts)):

- Wired `summarizeDroppedHistory()` in `AgentRuntime.modelTurn()` when `agent.context.summarizer` is configured, using the configured summarizer model binding (or agent default) with a safe extractive fallback, incrementing `cp.counters.summarizations`, and recording a `history_summarized` audit event.
- Reordered `AGENT_DEFAULTS.context.priority` to `["summary", "preferences", "facts", "history", "retrieval"]`.

## 6. Rolling `ConversationCompactor` (`sfield.compactor`) & live `onStage` streaming

**Fix** ([compactor.ts](context/compactor.ts), [agentic-harness.ts](runtime/agentic-harness.ts), [sfield.ts](sfield.ts)):

- Added `ConversationCompactor` (`sf.compactor`) to fold older turns outside the verbatim window into a structured `RollingThreadSummary` persisted in `sfield.memory` (`kind: "summary"`, `origin: "derived"`, automatic key supersession).
- Added optional `onStage` observer on `AgenticHarnessSpec` so hosts can stream live stage transitions and thinking progress as each stage finishes.
