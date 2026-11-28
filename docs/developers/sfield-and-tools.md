## Work with sfield and tools

sfield runs inside the app server. The host opens model sessions and tool runs, binds them to a chat turn and checks the results. The vendored SDK and SQLite adapter are under `vendor/sfield/packages/`. Most domain changes belong in the app or a provider package.

### Follow a model request

On each incoming chat message (`POST /api/conversations/:id/turns`), the server persists a durable `working` turn in `app.sqlite` (recovered via `reconcile()` after restarts), returns `202 Accepted` with an SSE `eventsUrl`, and calls `sf.context.hydrateTurn(...)` (`TurnContextHydrator` in `@sfield/core`) to resolve the `Principal`, active tenant/domain routing flows, persisted `ConversationCompactor` summary, and capability-gated domain stores in one step. For the account-help flow, `apps/server/service.ts` then builds a `PznContextRoutingInput` containing the current message, recent turns, supported intents, a topic snapshot, optional member scores and customer signals. A follow-up can include a hint derived by the host, such as `summaryFollowUpIntentId`. Logs distinguish the model proposal from the verified route.

`compileRouterInstructions` and `compileComposerInstructions` in `packages/experience/prompt-compiler.ts` supply the agent instructions. `Runtime.model` in `apps/server/runtime.ts` opens an sfield session and sends a JSON-encoded envelope. Inspect the field definitions in `packages/contracts/model-inputs.ts`. The router has an empty tool list. The host obtains topics and scores before invoking it. The composer receives verified intent and eligible candidates and can request the registered balance read. The host verifies the result before compiling cards.

On a verified portfolio-summary turn, sfield reads `portfolio.snapshot.read` for the signed-in member. The server publishes the snapshot as an `experience.preview` event. Chat mounts the card immediately, and a reconnect can recover it from the saved turn. Treatment Selector then checks the member and context. When it returns eligible content, the composer selects a recommendation and the server publishes `experience.ready` for the same chat surface. Admin → Logs shows each call's duration and the browser receipts for the portfolio card and final reply.

### Run a tool before connecting it to chat

From the repository root, run the checked-in example. It registers `savings.target.read@1.0.0` with `defineTool` and executes it through a read-only sfield scope using local data.

```sh
npm run build:sfield
node docs/developers/examples/read-tool.mjs
```

The first result has `status: "succeeded"` and `output.targetCents: 6000000`. The second requests an unknown goal and returns `status: "failed"` with `error.code: "GOAL_NOT_FOUND"`. Both include a call ID. Read `docs/developers/examples/read-tool.mjs` for the complete registration, input and output schemas, handler and cleanup. This local SDK exercise runs independently of the app and model gateway.

### Replace the source behind a registered read

Consider `goal.progress.read@1.0.0`. The host passes `turnRef` and `routeDecisionId`. The handler checks the run, customer, goal route and eligibility before obtaining the MID from the bound profile. The provider receives that MID and an abort signal. Its output supplies the savings graph.

```ts
interface GoalProgressProvider {
  read(mid: string, signal?: AbortSignal): Promise<GoalProgress | null>;
}
```

Implement this interface from `packages/goal-progress/index.ts` to change the source. Return `null` for an absent goal. Validate a successful payload with `goalProgressSchema` from `packages/contracts/goal-progress.ts`. An example payload is shown below.

```json
{
  "fixtureVersion": "goal-service-v1",
  "goalId": "home_down_payment",
  "currency": "USD",
  "targetCents": 6000000,
  "history": [
    { "month": "2026-05", "savedCents": 2000000 },
    { "month": "2026-06", "savedCents": 2200000 }
  ]
}
```

Pass the provider as `goalProgressProvider` when calling `startApp` in `apps/server/http.ts`. For example, a service embedding the host can call `startApp({ projectRoot, dataDir, gateway, goalProgressProvider })`. The existing tool ID, client UI and workflow callers can keep their contracts.

### Register a host-owned read tool

1. Give the tool a stable ID, version and input/output JSON Schemas. The goal example uses `sfieldTools.goal` in `packages/contracts/tool-setup.ts` and `goalProgressInputSchema` / `goalProgressResultSchema` in `packages/contracts/model-schemas.ts`. The SDK builds the versioned reference from the ID and version.
2. In `Runtime.tools()`, register the handler using the existing `read(...)` helper around `defineTool`. Resolve the current customer from `scopedRegistryTurn`, validate the route required for the read, pass `ctx.signal` to the provider, and validate its output. The runtime enforces the declared effect, timeout, attempt limit and output size.
3. Add the versioned reference to `toolRefs` and map the handler to the intended run in `registryBoundaries`. For a new execution scope, also add its purpose in `registryPurposes` and its ID to `TurnRecord` in `apps/server/store.ts`. Update the default enabled settings and the Tool setup description when operators should be able to toggle it.
4. Call the tool from the relevant branch in `apps/server/service.ts`. `Runtime.registry` opens a read-only execution for the current principal with a tool-call budget and closes it after use. The goal controller makes the following call.

```ts
const result = await runtime.registry(turn, "goalScopeId", 1, signal, call =>
  call("goal", { turnRef: turn.public.id, routeDecisionId: route.routeDecisionId })
);
```

Check `result.status` before consuming `result.output`. Open the turn in Logs to see its `toolRef`, `callId`, inputs and result. Agent-invoked tools also need the versioned reference in that agent's tool list and a handler that accepts that agent's scope. For a write, follow the registered `cep.domain.execute_write@1.0.0` path with its resource, confirmation and audit handling.

### Emotional & life-event assessment (`cep.empathy.assess@1.0.0`)

On wealth turns, the host invokes the registered `sfield` read tool `cep.empathy.assess@1.0.0` inside a scoped `read_only` execution (`purpose: "cep-empathy-assess"`). Its closed Ajv input and output contracts live in `packages/contracts/empathy.ts`, and its evaluator lives in `apps/server/response-personalizer.ts`.

1. **Reads chat + Customer 360 `notes`**: The tool reads the customer's current message, recent context, and live `notes` from `CustomerProfileStore` (`customer-profiles.json`). When a live external LLM gateway is active, subtle emotional phrasing is classified through the PII Firewall with a 4-second timeout and deterministic heuristic fallback.
2. **Writes new life events back**: When the customer shares a new major life event in chat (job loss, medical emergency, bereavement, family crisis, new family, or career milestone), `apps/server/service.ts` persists a deduplicated note to Customer 360 (`CustomerProfileStore.appendNote`, capped to 400 characters) and stores a `fact` in `sfield.memory`.
3. **Drives personalization & promotion suppression**: `Store.finish` passes `turn.public.emotionalState` to `applyPersonalization` so every response opens with the customer's name and situation-aware tone. Whenever `emotionalState.suppressPromotions` is `true` (from chat or from an advisor's Customer 360 note), the host forwards `excludePromotions: true` to both `Customer360Service.evaluate` and `cep.recommendations.arbitrate@1.0.0`, pausing promotional investment offers across Recommendation Providers.

### Expose `sfield` as a governed MCP 2026 Server (`sf.createMcpServer`)

`@sfield/core` ships a built-in, transport-agnostic MCP Server supporting **`2026-07-28`** (backwards-compatible with `2025-03-26` JSON-RPC 2.0) in `vendor/sfield/packages/core/src/mcp/server.ts` and `vendor/sfield/packages/core/src/mcp/extensions.ts`. Any `sfield` app can expose an allowlisted subset of its registered tools over **Streamable HTTP** (`handleRequest`) or **stdio** (`serveStdio`):

```ts
const mcp = sf.createMcpServer({
  serverInfo: { name: "my-sfield-mcp", version: "1.0.0" },
  principal,
  preset: "read_only", // safe default; use "supervised" for HITL-approved writes
  allowTools: ["cep.empathy.assess@1.0.0"],
});

// Streamable HTTP: pass JSON-RPC payload to mcp.handleRequest(body, { principal })
// Local CLI / Claude Desktop / Cursor: await mcp.serveStdio({ principal })
```

Every `tools/call` runs inside a real `sfield` `ExecutionScope` (`executions.open` / `executions.resume`), preserving `Authorizer` policy checks, Ajv closed schema validation, HITL approval suspension (`APPROVAL_REQUIRED` → `status: "pending_approval"` with `approvalId` + `callId`), **MCP 2026 Elicitation** (`elicitation/create` → `status: "input_required"` → `elicitation/respond`), **MCP 2026 Async Tasks** (`tasks/get`, `tasks/result`, `tasks/cancel` with tenant isolation), stateless **`server/discover`**, and `sfield.sqlite` audit receipts (`sfieldRunId`). CEP wires `POST /api/mcp` onto `runtime.createMcpServer(...)` in `apps/server/cep-mcp-server.ts`, exposing `cep.empathy.assess@1.0.0`, published `int.*` Integration Tasks, and `cep.knowledge.search@1.0.0`.

### Headless `sfield` vs. `sphoton` UI Binding (`packages/sphoton/`)

`sfield` *(Singularity Field)* is a **headless** tool and agent runtime: it owns tool registration, closed Ajv input/output JSON Schemas, scoped execution, approvals, and immutable call logs — not UI components or layouts.

UI data binding, pluggable component schema validation (`SphotonComponentRegistry`), AI draft binding, deterministic A2UI compilation, `SurfaceBinderService` (`createSurfaceBinder(sf)`), and persistent HMAC-SHA256 signed action references live in **`sphoton`** (`packages/sphoton/`), which has zero CEP/domain imports and talks to `sfield` strictly through `SfieldAdapter` (`apps/server/sphoton-catalog.ts`) or `SField`'s public tool registry/execution APIs. See `docs/developers/sphoton.md` for the full 3-layer diagram (`sfield` → `sphoton` → App/Domains).

### Core `@sfield/*` SDK workspace packages & primitives

Beyond CEP-specific tools, the `sfield` SDK (`vendor/sfield/packages/*`) ships standalone enterprise packages and primitives usable in any TypeScript/Node 22 host:

- **Turn Context Hydrator (`sf.context.hydrateTurn`)** — centralizes `Principal` normalization, tenant/domain flow override resolution (`registerFlows` / `setFlowOverrides`), `ChatHarness` transcript & `ConversationCompactor` rolling-summary hydration, and declarative resource/store gating (`requiredFlows`, `anyFlow`, `allowedDomains`, `requireOperator`) with a `deniedResources` audit trail.
- **Native Model Providers (`@sfield/core`)** — `AnthropicProvider`, `GeminiProvider` (Google Gemini v1beta SSE streaming, function calls, and `responseSchema`), and `OpenAICompatibleProvider`.
- **PII Egress Firewall (`createPiiFirewall` / `createPiiFirewallHook`)** — tokenizes SSN, email, phone, card, account IDs, known names, and custom rules in `beforeModelDispatch` and rehydrates locally via `firewall.rehydrateRunOutput(runId, output)`.
- **Tool Resilience (`createToolResilienceGuard`)** — per-key `TokenBucketRateLimiter` (`RATE_LIMITED`) and 3-state `CircuitBreaker` (`CIRCUIT_OPEN` → `half_open` → `closed`).
- **Federated MCP Client & RBAC Server (`createMcpClient`, `createMcpProxyTools`, `sf.createMcpServer`)** — discover tools from any remote Streamable HTTP MCP server (or another `sfield` instance) and mount them as closed-schema `sfield` tools with `Authorizer` + resilience enforcement; enforce per-caller RBAC on `SFieldMcpServer` via `authenticate(headers)` + `allowTools(tool, principal)`.
- **Governed Sub-Agent Delegation (`sf.delegation.delegate` / `sf.delegation.tree`)** — delegates to child agents under the parent's exact `Principal` (blocking identity escalation and recursive depth loops) with immutable `delegation_started` / `delegation_finished` parent→child audit links.
- **Typed Run Streaming (`sf.streamRun` / `formatRunStreamSse`)** — streams normalized `RunStreamChunk` lifecycle & delta events from any `RunHandle` ready for SSE or AG-UI transports.
- **Zero-Boilerplate Dev Presets (`@sfield/preset-memory`, `@sfield/preset-local`)** — pass `preset: "memory"` or `preset: "local"` to `SField.create(...)` for instant ephemeral or SQLite + disk-artifact development (both refuse `NODE_ENV=production` and `deployment: "service"`).
- **Durable Artifacts & Semantic Vector Memory (`@sfield/core`)** — `FilesystemArtifactStore` (atomic writes, SHA-256 verification, tenant isolation, uncommitted GC) and `VectorMemoryIndex` + pluggable `EmbeddingProvider` / zero-dependency `HashEmbeddingProvider`.
- **OpenTelemetry GenAI Sink (`@sfield/telemetry-otel`)** — `createOtelTelemetrySink` records `gen_ai.*` spans & metrics and exports OTLP/HTTP JSON (`v1/traces`) to any collector (dogfooded by CEP's `CepTelemetry`).
- **PostgreSQL Service Store + Durable JSON Fallback (`@sfield/store-postgres`)** — `PostgresPersistence` + `PostgresMemoryRepository` (`deployment: "service"`), `POSTGRES_SCHEMA_SQL` production DDL, `createPgPoolAdapter(pool)` for `pg`, and **`createPostgresOrJsonPersistence()`** falling back automatically to conformance-verified durable **`JsonFilePersistence`** when Postgres is unavailable.
- **Eval Runner & Release Gate (`@sfield/testing`)** — `runEvalSuite` executes guardrail cases, writes `EvalReportRecord` into `sf.lock.evalReports()`, and `evaluateReleaseGate` enforces pass-rate, latency, and cost budgets.
- **Standalone CLI (`@sfield/cli`)** — run `npm run sfield -- init | validate | eval | lock status | lock approve | inspect <runId> | doctor | studio | mcp serve` to scaffold, diagnose, validate configs, run eval gates, manage lock approvals, inspect persisted runs, launch `@sfield/studio`, or run a stdio MCP server.
- **Governance Workbench (`@sfield/studio`)** — standalone or embeddable zero-framework workbench (`createStudioHandler`, `startStudioServer`), mounted in CEP at `/admin/sfield-studio` with Host Plugins.
- **Pluggable `RecommendationProviderRegistry`** — Treatment Selector (`treatments.eligible@1.0.0`, categorized as `recommendation_provider`) is registered as one optional `RecommendationProvider` alongside `customer360_nba`, `ops_runbook`, `sales_deal_desk`, and external REST/MCP connectors. `startApp({ recommendationProviders })` supports custom providers or `[]` (zero-TS mode).
- **CI & Publishing Pipelines** — `.github/workflows/ci.yml` verifies build, 174 tests, and Playwright suites; `.github/workflows/release.yml` publishes all 9 `@sfield/*` packages to npm or GitHub Packages.

### Connect an existing service

For a configurable external read, author a task in the **Integrations** workspace at `/integrations`. Declare its effect, input/output fields and transport binding, then publish it. For customer record lookups, configure **Customer chat** with the record ID, MID and visible fields. `Runtime.registerPublishedTask` attempts a dedicated registration and can fall back to the integration dispatcher. Check the published task's execution route there. `packages/contracts/integration-task.ts` defines the contract and `apps/server/integration-tasks.ts` runs the transport.

### Reopen a thread and inspect what persists

`PznChatHistory` in `apps/server/chat-history.ts` binds tenant, domain, user, session and thread to the sfield chat harness. Customer messages and assistant replies are stored in `sfield.sqlite`. Assistant records include the verified intent and displayed choice IDs so “the second one” can refer to a previous card. Long threads automatically compact older turns into rolling summaries via `sfield`'s `ConversationCompactor` (or on demand via `POST /api/conversations/:id/compact`). Conversations can be organized into folders with shared Project instructions (`POST /api/folders/:id/update`) and branched from any message (`POST /api/conversations/:id/fork`). The host stores turn state, folders, and issued actions in `app.sqlite`. Both files live in the active tenant data directory.

Use the balance harness from Getting started to compare the stored transcript with the router's `recent` array after `/reopen`. `tests/chat-history.test.ts` exercises restart and thread scoping. `tests/host.test.ts` covers allowed and failed tool reads.
