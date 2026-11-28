## `sfield` — Governed Enterprise Agent SDK

**`sfield`** is the standalone TypeScript-first **Governed Agent SDK** (Node.js 22+) that powers CEP. Every capability built in this repository—closed-schema tool execution, HITL approvals, MCP federation, PII egress firewalling, resilience guards, sub-agent delegation, OpenTelemetry tracing, vector memory, and durable storage—is packaged under `vendor/sfield/packages/*` so any application can adopt `sfield` independently of CEP.

> Prefer a visual architecture overview? Open the standalone HTML guide at [`/sfield-sdk.html`](/sfield-sdk.html) or launch the live governance workbench at [`/admin/sfield-studio`](/admin/sfield-studio).

---

### Package suite (9 publishable workspaces)

| Package | Role | Key exports |
| --- | --- | --- |
| `@sfield/core` | 100% headless core runtime & enterprise primitives | `SField`, `defineTool`, `TurnContextHydrator` (`sf.context.hydrateTurn`), `ChatHarness` (`sf.chat`), `ConversationCompactor` (`sf.compactor`), `GraphService` (`sf.graphs`), `SlashCommandService` (`sf.commands`), `AnthropicProvider`, `GeminiProvider`, `OpenAICompatibleProvider`, `SFieldMcpServer` (MCP 2026), `McpClient`, `createMcpProxyTools`, `createPiiFirewallHook`, `createToolResilienceGuard`, `DelegationService`, `streamRun`, `FilesystemArtifactStore`, `VectorMemoryIndex` |
| `@sfield/preset-memory` | Zero-boilerplate ephemeral preset | `preset: "memory"` (`EphemeralPersistence`, `InMemoryArtifactStore`, `createDevAuthorizer`) |
| `@sfield/preset-local` | Zero-boilerplate durable local preset | `preset: "local"` (`SqlitePersistence`, `FilesystemArtifactStore`, `createDevAuthorizer`) |
| `@sfield/store-sqlite` | Single-node durable store | `sqlitePersistence`, `SqlitePersistence`, `SqliteMemoryRepository` (over built-in `node:sqlite`) |
| `@sfield/store-postgres` | Service Postgres store + JSON fallback | `PostgresPersistence`, `PostgresMemoryRepository`, `POSTGRES_SCHEMA_SQL`, `createPgPoolAdapter`, `JsonFilePersistence`, `createPostgresOrJsonPersistence` |
| `@sfield/telemetry-otel` | OpenTelemetry `gen_ai.*` sink | `createOtelTelemetrySink`, `OtelTelemetrySink` (OTLP/HTTP JSON `v1/traces`) |
| `@sfield/studio` | Standalone & embeddable workbench | `createStudioHandler`, `startStudioServer`, `renderStudioHtml`, `StudioPluginTab` |
| `@sfield/testing` | Conformance & release-gate eval runner | `persistenceConformance`, `runEvalSuite`, `evaluateReleaseGate`, `FakeModelProvider` |
| `@sfield/cli` | Standalone CLI (`sfield`) | `init`, `validate`, `eval`, `lock status`, `lock approve`, `inspect`, `doctor`, `studio`, `mcp serve` |

---

### 5-line quick start

```js
import { SField, defineTool } from "@sfield/core";

const greet = defineTool({
  id: "demo.greet",
  version: "1.0.0",
  description: "Greet a user by name.",
  inputs: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  outputs: { type: "object", properties: { greeting: { type: "string" } }, required: ["greeting"], additionalProperties: false },
  policy: { effect: "read", classification: "public" },
  handler: async ({ name }) => ({ greeting: `Hello from sfield, ${name}!` }),
});

const sf = await SField.create({
  config: { version: 1, models: {}, agents: {} },
  preset: "memory", // or "local" for SQLite + disk artifacts
  tools: [greet],
});

const res = await sf.registry.execute({ toolRef: "demo.greet@1.0.0", inputs: { name: "Ada" } });
await sf.close();
```

---

### Turn Context Hydration (`sf.context.hydrateTurn`)

Instead of hand-wiring per-turn flow gating, principal normalization, chat history loading, and domain-store checks in host middleware, `@sfield/core` exposes a built-in **`TurnContextHydrator`** on `sf.context`:

- **`sf.context.registerFlows(flows)` & `sf.context.setFlowOverrides(tenantId, scope, rules)`** — manage tenant defaults and domain-level overrides (domain overrides can narrow/disable a flow, never escalate a tenant-disabled flow, and `operatorOnly` flows are excluded for non-operators).
- **`sf.context.hydrateTurn({ principal, domainId, flows, chatScope, conversationId, resources })`** — in one headless call: normalizes `Principal`, resolves active flows (`allows(flowId)`), loads recent `sf.chat` messages and persisted `sf.compactor` rolling summaries, and declaratively unlocks capability-gated host resources (`requiredFlows`, `anyFlow`, `allowedDomains`, `requireOperator`, `requiredRoles`) alongside a `deniedResources` audit trail.

---

### Headless `sfield` + `smass` Domain Models + `sphoton` UI Binding

`@sfield/core` is strictly **headless** — it owns tool registration, closed Ajv schemas, turn context hydration, execution scopes, HITL approvals, and call logs, with zero UI or domain ER code. Two sibling packages layer cleanly above it:

- **`smass` (`packages/smass/`, see `docs/developers/smass.md`)** — represents relational domain data models (tool-backed & store-backed entities, PK/FK/`principalKey` joins, directed relationships, enums, nested item schemas, computed fields, lifecycles), compiles store models into closed `@sfield/core` tools, and exports canonical Mermaid ER diagrams & Draft 2020-12 JSON Schema `$defs` (`GET /api/admin/domain-models`).
- **`sphoton` (`packages/sphoton/`, see `docs/developers/sphoton.md`)** — consumes `sfield` through `SfieldAdapter` and `createSurfaceBinder(sf, { signingSecret })`:

1. **`validateCardBinding` & `compileBoundCard`** — validates card bindings against closed `sfield` schemas and a pluggable `SphotonComponentRegistry`, reuses verified turn results (`reuseVerifiedTurnResult`), renders approved unavailable states, and seals persistent HMAC-SHA256 action references.
2. **`createSurfaceBinder(sf).inspectSchemas()`** — auto-discovers bindable output/input paths from registered `sfield` tool JSON Schemas.
3. **`createSurfaceBinder(sf).stitch(...)` & `dispatchAction(...)`** — executes read sources via `ExecutionScope`, resolves `$ref` / `$repeat` / `$input`, and verifies HMAC-SHA256 seals and `Principal` match (blocking tampering & cross-principal replay).

CEP exposes `smass` at `GET /api/admin/domain-models` and `sphoton` at `GET/POST /api/admin/ui-binding-catalog` and `/api/surfaces/*` (`apps/server/routes/admin-studio.ts`, `apps/server/routes/collaboration.ts`).

---

### MCP 2026 (`2026-07-28`) Elicitation & Async Tasks

`sf.createMcpServer()` and `createMcpClient()` negotiate `2026-07-28` (while remaining backwards-compatible with `2025-03-26`), adding:

- **Stateless `server/discover`** for lightweight capability & tool discovery.
- **Structured Elicitation (`elicitation/create` / `elicitation/respond`)** so tools can pause mid-flight with `status: "input_required"` and validate structured user input against a closed JSON Schema.
- **Tenant-Isolated Async Tasks (`tasks/get`, `tasks/result`, `tasks/cancel`)** supporting long-running execution, mid-flight elicitation, and cancellation.

---

### How `sfield` compares to other agent frameworks

Most agent frameworks optimize for prompt chaining, graph prototyping, or frontend streaming. **`sfield`** is designed specifically as a **zero-trust backend governance kernel** for regulated Node.js/TypeScript systems—and pairs cleanly behind frontend streaming libraries like `assistant-ui` or Vercel AI SDK.

| Capability | `sfield` (`@sfield/*`) — Pros & Cons | Other Frameworks (LangGraph, Vercel AI SDK, OpenAI Agents, Google ADK, Mastra/CrewAI) — Pros & Cons |
| :--- | :--- | :--- |
| **Runtime & Ecosystem** | **Pros:** Zero-trust TypeScript/Node 22+ kernel with zero cloud lock-in and minimal dependencies.<br>**Cons:** Node.js/TS only (no native Python SDK yet); smaller third-party community plugin catalog than LangChain/LangGraph. | **Pros:** Massive Python & JS ecosystems (LangGraph, Google ADK, CrewAI), hundreds of pre-built connectors, and deep vendor hooks.<br>**Cons:** Heavier dependency trees, faster API churn, or tighter coupling to a single cloud/model vendor. |
| **Identity, Multi-Tenant & OBO** | **Pros:** First-class `Principal` (`human\|agent\|service`), custom `identifiers`, RFC 8693 `actingFor`, and declarative `principal.*` bindings.<br>**Cons:** Host apps must construct and pass a `Principal` upfront (slightly more setup for quick scripts). | **Pros:** Quick to start with plain strings or session dicts and minimal identity ceremony.<br>**Cons:** Tenant isolation, agent OBO attribution, and cross-principal replay protection must be hand-rolled in app middleware. |
| **Tool Schemas & Policy Presets** | **Pros:** Strict closed Ajv schemas, built-in `read_only` / `supervised` / `bounded_auto` presets, and `beforeModelDispatch` tool narrowing.<br>**Cons:** Closed schemas reject loose/untyped tool payloads until explicitly modeled. | **Pros:** Flexible Zod/Pydantic tool definitions make rapid prototyping and open-ended JSON tools effortless.<br>**Cons:** Read/write effect isolation and per-turn tool narrowing are usually convention-based rather than kernel-enforced. |
| **Graphs, HITL & Time-Travel** | **Pros:** Built-in `defineGraph()` (parallel fan-out, conditional edges, mid-graph `ctx.interrupt()`, `forkAndReplay()` Time-Travel) plus SHA-256 argument-digest-bound HITL approvals & durable checkpoints.<br>**Cons:** Graph engine is newer than LangGraph’s multi-year subgraph ecosystem. | **Pros:** LangGraph `StateGraph` / `interrupt()` and Mastra/ADK workflows offer mature branching state machines.<br>**Cons:** Cryptographic argument binding, per-node effect presets, and dual-control approval queues are typically DIY. |
| **Data-to-UI & Sealed Actions** | **Pros:** Headless `sfield` pairs cleanly with sibling **`sphoton`** (`packages/sphoton`) for closed-schema tool bindings, `SurfaceBinder` (`$ref`/`$repeat`/`$input`), verified-read reuse, and persistent HMAC-SHA256 action sealing.<br>**Cons:** Backend declarative binding layer — you still bring your own frontend renderer (React, A2UI, or `assistant-ui`). | **Pros:** Vercel AI SDK (`streamUI` / `useChat`) provides best-in-class React streaming hooks and instant generative UI components.<br>**Cons:** No built-in cryptographic action sealing or closed-schema Data-to-UI stitcher; LLMs often serialize raw business figures into UI JSON. |
| **MCP 2026 & Federation** | **Pros:** Built-in RBAC `SFieldMcpServer` (HTTP + stdio), MCP `2026-07-28` Elicitation, Async Tasks, and `McpClient` proxy tools.<br>**Cons:** Newer MCP 2026 extensions are still rolling out across third-party clients. | **Pros:** Broad MCP client adapters across Python/JS frameworks and hosted MCP marketplaces.<br>**Cons:** Server-side RBAC, tenant-isolated async task queues, and schema-validated mid-flight elicitation are rarely built in. |
| **PII Firewall & Resilience** | **Pros:** Built-in `PiiFirewall` (scrub + local rehydration) and `TokenBucket` / 3-state `CircuitBreaker` with zero extra infra.<br>**Cons:** Deterministic pattern/dictionary scrubbing may still be paired with ML DLP (e.g. Model Armor/Presidio) for unstructured prose. | **Pros:** Easy to pair with enterprise cloud DLP and API gateways (GCP Model Armor, Azure Content Safety, Cloudflare AI Gateway).<br>**Cons:** Requires deploying and operating separate sidecars, gateways, or custom middleware. |
| **Workbench, Waterfall & Red-Team** | **Pros:** Zero-framework embeddable & standalone `@sfield/studio` with visual execution waterfalls, interactive Graph Time-Travel, MCP 2026 Elicitation/Tasks, 1-Click Red-Team Proofs & `sfield lock approve`.<br>**Cons:** Lighter dataset-annotation UX than commercial SaaS platforms like LangSmith. | **Pros:** Rich hosted observability, prompt playgrounds, and dataset annotation UIs (LangSmith, LangGraph Studio, Vertex Eval, OpenAI Traces).<br>**Cons:** Often requires paid SaaS accounts, external trace egress, or cloud lock-in; no built-in 1-click red-team proof suite. |

**When to choose `sfield`**: Regulated or enterprise Node.js/TypeScript apps (Finance, Healthcare, IT Ops, RevOps) where LLMs must never fabricate figures, run writes without SHA-256 digest-bound HITL, or leak PII—and you want zero-cloud-lock-in persistence (SQLite or Postgres + JSON fallback) with an embeddable workbench (`@sfield/studio`).

**When to pair or choose others**: Pair `sfield` behind **Vercel AI SDK / `assistant-ui`** for rich frontend chat streaming; choose **LangGraph** or **Google ADK** for Python-first teams or research-heavy graph pipelines tied to LangSmith or Vertex AI.

---

### Service deployment with Postgres + automatic JSON fallback

In `deployment: "service"`, `sfield` requires lock-manifest approval before booting. `@sfield/store-postgres` provides `createPostgresOrJsonPersistence()`, which connects to PostgreSQL when available and seamlessly falls back to conformance-verified, atomic durable JSON-file storage (`JsonFilePersistence` + `FilesystemArtifactStore`) when Postgres is unconfigured or unreachable:

```js
import { createPostgresOrJsonPersistence, createPgPoolAdapter } from "@sfield/store-postgres";

const persistence = createPostgresOrJsonPersistence({
  // client: createPgPoolAdapter(pgPool), // optional — falls back to JSON file when omitted or down
  jsonPath: "./.sfield/service-state.json",
  onFallback: (reason) => console.warn("Fallback to JSON store:", reason),
});
```

---

### CLI governance workflow

```sh
# 1. Diagnose runtime, packages, config, persistence & OTel
npm run sfield -- doctor --config ./sfield.config.yaml --db ./state.sqlite

# 2. Scaffold a new standalone agent project
npm run sfield -- init ./my-agent

# 3. Validate config & compute deterministic lock digest (offline-safe)
npm run sfield -- validate ./my-agent/sfield.config.yaml

# 4. Run guardrail evals & enforce release gate
npm run sfield -- eval ./suite.mjs --db ./state.sqlite --config ./my-agent/sfield.config.yaml --gate-min-pass 0.95

# 5. Approve lock digest & inspect persisted runs
npm run sfield -- lock approve --db ./state.sqlite --config ./my-agent/sfield.config.yaml --approver release-bot
npm run sfield -- inspect <runId> --db ./state.sqlite

# 6. Serve governed sfield tools over MCP stdio
npm run sfield -- mcp serve --db ./state.sqlite --config ./my-agent/sfield.config.yaml

# 7. Launch standalone @sfield/studio workbench
npm run sfield -- studio --db ./state.sqlite --port 4310
```

---

### Runnable standalone examples

Run any example directly from the repository root after `npm run build:sfield`:

- `node vendor/sfield/examples/hello-agent.mjs` — Zero-boilerplate `preset: "memory"` tool execution.
- `node vendor/sfield/examples/hitl-approval.mjs` — `APPROVAL_REQUIRED` suspension, `sf.approvals.decide()`, and single-use resume.
- `node vendor/sfield/examples/mcp-federation.mjs` — `sf.createMcpServer()` consumed remotely via `createMcpClient()` + `createMcpProxyTools()`.
- `node vendor/sfield/examples/postgres-or-json-service.mjs` — `deployment: "service"` with automatic Postgres → JSON fallback and lock approval.
- `node vendor/sfield/examples/agent-to-agent-identity.mjs` — Domain-agnostic `Principal.identifiers` (Healthcare `MRN`, not `MID`) + `createAgentPrincipal()` On-Behalf-Of (`actingFor`) + declarative `{ ref: "principal.identifiers.mrn" }` resource binding over MCP.
- `python3 vendor/sfield/examples/python-mcp-tool/server.py` + `node vendor/sfield/examples/python-mcp-tool/bridge.mjs` — Polyglot Python MCP `2026-07-28` tool governed inside `sfield` via `createMcpProxyTools`.
