# `sfield` — Governed Enterprise Agent SDK

`sfield` is a standalone, TypeScript-first **Governed Agent SDK** for Node.js 22+ designed for production enterprise AI applications where every model call, tool invocation, memory write, and sub-agent delegation must be **schema-verified, identity-scoped, policy-gated, auditable, and resilient**.

---

## Packages

| Package | Role | Key Exports |
| :--- | :--- | :--- |
| **`@sfield/core`** | 100% headless runtime, model gateway, closed-schema tool pipeline, state graphs (`sf.graphs`), HITL approvals, MCP 2026 server/client (Elicitation + Async Tasks), PII firewall, resilience, delegation, streaming, artifacts & vector memory | `SField`, `defineTool`, `defineGraph`, `AnthropicProvider`, `GeminiProvider`, `OpenAICompatibleProvider`, `SFieldMcpServer`, `McpClient`, `createMcpProxyTools`, `createPiiFirewallHook`, `createToolResilienceGuard`, `DelegationService`, `streamRun`, `FilesystemArtifactStore`, `VectorMemoryIndex` |
| **`@sfield/preset-memory`** | Zero-boilerplate ephemeral preset for tests & scripts | `preset: "memory"` (`EphemeralPersistence`, `InMemoryArtifactStore`, `createDevAuthorizer`) |
| **`@sfield/preset-local`** | Zero-boilerplate durable local preset | `preset: "local"` (`SqlitePersistence`, `FilesystemArtifactStore`, `createDevAuthorizer`) |
| **`@sfield/store-sqlite`** | `durable_single` persistence over built-in `node:sqlite` | `sqlitePersistence`, `SqlitePersistence`, `SqliteMemoryRepository` |
| **`@sfield/store-postgres`** | `deployment: "service"` PostgreSQL persistence **with automatic durable JSON-file fallback** | `PostgresPersistence`, `PostgresMemoryRepository`, `POSTGRES_SCHEMA_SQL`, `createPgPoolAdapter`, `JsonFilePersistence`, `createPostgresOrJsonPersistence` |
| **`@sfield/telemetry-otel`** | Zero-dependency OpenTelemetry `gen_ai.*` `TelemetrySink` | `createOtelTelemetrySink`, `OtelTelemetrySink` (OTLP/HTTP JSON `v1/traces`) |
| **`@sfield/studio`** | Standalone & embeddable governance workbench UI + HTTP handler (zero UI framework dependencies) | `createStudioHandler`, `startStudioServer`, `renderStudioHtml`, `StudioPluginTab` |
| **`@sfield/testing`** | Conformance suites, deterministic fake providers & guardrail eval runner | `persistenceConformance`, `runEvalSuite`, `evaluateReleaseGate`, `FakeModelProvider` |
| **`@sfield/cli`** | Standalone CLI (`sfield`) | `init`, `validate`, `eval`, `lock status`, `lock approve`, `inspect`, `doctor`, `studio`, `mcp serve` |

---

## 5-Line Quick Start

```js
import { SField, defineTool } from "@sfield/core";

const greet = defineTool({
  id: "demo.greet",
  version: "1.0.0",
  description: "Greet a user by name.",
  inputs: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  outputs: { type: "object", properties: { greeting: { type: "string" } }, required: ["greeting"], additionalProperties: false },
  policy: { effect: "read", classification: "public" },
  handler: async ({ name }) => ({ greeting: `Hello, ${name}!` }),
});

const sf = await SField.create({
  config: { version: 1, models: {}, agents: {} },
  preset: "memory", // or "local" for durable SQLite + disk artifacts
  tools: [greet],
});

const res = await sf.registry.execute({ toolRef: "demo.greet@1.0.0", inputs: { name: "Ada" } });
console.log(res.output); // { greeting: "Hello, Ada!" }
await sf.close();
```

---

## Strictly Headless Separation of Concerns

`@sfield/core` owns **tools, closed JSON Schemas, scoped execution, policy presets, approvals, and immutable call logs** — and contains **zero UI code**. Host applications that want schema-validated Data-to-UI binding and HMAC-sealed UI actions layer a dedicated UI binder (such as sibling **`sphoton`** in `packages/sphoton/`) on top of `SField`’s public `registry` and `executions` APIs.

---

## MCP 2026 (`2026-07-28`) Elicitation & Async Tasks

`sf.createMcpServer()` and `createMcpClient()` implement MCP `2026-07-28` (backwards-compatible with `2025-03-26`):

- **Stateless Discovery (`server/discover`)**: Advertises capabilities, protocol versions, and allowlisted tools without requiring a stateful session.
- **Elicitation (`elicitation/create` / `elicitation/respond`)**: Tools can suspend mid-flight via `ctx.elicit({ message, requestedSchema })`, returning `status: "input_required"` and validating user answers against the closed JSON Schema before resuming.
- **Async Tasks (`tasks/get`, `tasks/result`, `tasks/cancel`)**: Long-running tool invocations return a tenant-isolated `taskId` immediately, support mid-flight elicitation, and can be polled or cancelled cleanly.

---

## How `sfield` Compares to Other Agent Frameworks

| Capability | `sfield` (`@sfield/*`) — Pros & Cons | Other Frameworks (LangGraph, Vercel AI SDK, OpenAI Agents, Google ADK, Mastra/CrewAI) — Pros & Cons |
| :--- | :--- | :--- |
| **Runtime & Ecosystem** | **Pros:** Zero-trust TypeScript/Node 22+ kernel with zero cloud lock-in and minimal dependencies.<br>**Cons:** Node.js/TS only (no native Python SDK yet); smaller third-party community plugin catalog than LangChain/LangGraph. | **Pros:** Massive Python & JS ecosystems (LangGraph, Google ADK, CrewAI), hundreds of pre-built connectors, and deep vendor hooks.<br>**Cons:** Heavier dependency trees, faster API churn, or tighter coupling to a single cloud/model vendor. |
| **Identity, Multi-Tenant & OBO** | **Pros:** First-class `Principal` (`human\|agent\|service`), custom `identifiers`, RFC 8693 `actingFor`, and declarative `principal.*` bindings.<br>**Cons:** Host apps must construct and pass a `Principal` upfront. | **Pros:** Quick to start with plain strings or session dicts.<br>**Cons:** Tenant isolation, agent OBO attribution, and cross-principal replay protection must be hand-rolled in app middleware. |
| **Tool Schemas & Policy Presets** | **Pros:** Strict closed Ajv schemas, built-in `read_only` / `supervised` / `bounded_auto` presets, and `beforeModelDispatch` tool narrowing.<br>**Cons:** Closed schemas reject loose/untyped tool payloads until explicitly modeled. | **Pros:** Flexible Zod/Pydantic tool definitions make rapid prototyping effortless.<br>**Cons:** Read/write effect isolation and per-turn tool narrowing are usually convention-based rather than kernel-enforced. |
| **Graphs, HITL & Time-Travel** | **Pros:** Built-in `defineGraph()` (parallel fan-out, conditional edges, mid-graph `ctx.interrupt()`, `forkAndReplay()` Time-Travel) plus SHA-256 argument-digest-bound HITL approvals & durable checkpoints.<br>**Cons:** Graph engine is newer than LangGraph’s multi-year subgraph ecosystem. | **Pros:** LangGraph `StateGraph` / `interrupt()` and Mastra/ADK workflows offer mature branching state machines.<br>**Cons:** Cryptographic argument binding, per-node effect presets, and dual-control approval queues are typically DIY. |
| **Data-to-UI & Sealed Actions** | **Pros:** Strictly headless kernel pairs with sibling `sphoton` (`createSurfaceBinder(sf)` + `compileBoundCard`) to bind closed tool schemas and seal UI actions with persistent HMAC-SHA256 without leaking UI into `sfield`.<br>**Cons:** Bring your own frontend renderer (React, A2UI, or `assistant-ui`). | **Pros:** Vercel AI SDK (`streamUI` / `useChat`) provides best-in-class React streaming hooks and instant generative UI components.<br>**Cons:** No built-in cryptographic action sealing or closed-schema Data-to-UI stitcher. |
| **MCP 2026 & Federation** | **Pros:** Built-in RBAC `SFieldMcpServer` (HTTP + stdio), MCP `2026-07-28` Elicitation, Async Tasks, and `McpClient` proxy tools.<br>**Cons:** Newer MCP 2026 extensions are still rolling out across third-party clients. | **Pros:** Broad MCP client adapters and hosted MCP marketplaces.<br>**Cons:** Server-side RBAC, tenant-isolated async task queues, and schema-validated mid-flight elicitation are rarely built in. |
| **PII Firewall & Resilience** | **Pros:** Built-in `PiiFirewall` (scrub + local rehydration) and `TokenBucket` / 3-state `CircuitBreaker` with zero extra infra.<br>**Cons:** Deterministic pattern/dictionary scrubbing may still be paired with ML DLP (e.g. Model Armor/Presidio) for unstructured prose. | **Pros:** Easy to pair with enterprise cloud DLP and API gateways (GCP Model Armor, Azure Content Safety, Cloudflare AI Gateway).<br>**Cons:** Requires deploying and operating separate sidecars, gateways, or custom middleware. |
| **Workbench, Waterfall & Red-Team** | **Pros:** Zero-framework embeddable & standalone `@sfield/studio` with visual execution waterfalls, interactive Graph Time-Travel, MCP 2026 Elicitation/Tasks, 1-Click Red-Team Proofs & `sfield lock approve`.<br>**Cons:** Lighter dataset-annotation UX than commercial SaaS platforms like LangSmith. | **Pros:** Rich hosted observability, prompt playgrounds, and dataset annotation UIs (LangSmith, LangGraph Studio, Vertex Eval, OpenAI Traces).<br>**Cons:** Often requires paid SaaS accounts, external trace egress, or cloud lock-in; no built-in 1-click red-team proof suite. |

> **Complementary by design**: `sfield` is a backend governance kernel — pair it behind **Vercel AI SDK** or **`assistant-ui`** for frontend streaming chat, or adopt **LangGraph / Google ADK** when your team is Python-first or anchored to LangSmith / Vertex AI.

---

## Production Deployment (`deployment: "service"`) with Postgres + JSON Fallback

`@sfield/store-postgres` supports PostgreSQL (`pg.Pool` via `createPgPoolAdapter`) with automatic durable atomic JSON-file fallback when Postgres is unavailable or unconfigured:

```js
import { SField, approveLock } from "@sfield/core";
import { createPostgresOrJsonPersistence } from "@sfield/store-postgres";

const persistence = createPostgresOrJsonPersistence({
  // client: createPgPoolAdapter(pgPool), // optional — falls back to JSON file when omitted or unreachable
  jsonPath: "./.sfield/service-state.json",
  onFallback: (reason) => console.warn("Using JSON fallback store:", reason),
});
```

---

## Standalone CLI

From the repository root:

```sh
npm run build:sfield

# Scaffold a new standalone project
npm run sfield -- init ./my-agent

# Validate config & print deterministic lock digest
npm run sfield -- validate ./my-agent/sfield.config.yaml

# Run guardrail eval suite & release gate
npm run sfield -- eval ./suite.mjs --db ./state.sqlite --config ./my-agent/sfield.config.yaml --gate-min-pass 0.95

# Approve config lock manifest
npm run sfield -- lock approve --db ./state.sqlite --config ./my-agent/sfield.config.yaml --approver release-bot

# Inspect a persisted run, tool calls, model attempts & delegation tree
npm run sfield -- inspect <runId> --db ./state.sqlite

# Expose governed sfield tools over MCP stdio
npm run sfield -- mcp serve --db ./state.sqlite --config ./my-agent/sfield.config.yaml

# Launch the standalone @sfield/studio governance workbench
npm run sfield -- studio --db ./state.sqlite --port 4310
```

---

## Runnable Examples

Run any standalone example directly with Node 22+ (after `npm run build:sfield`):

```sh
node vendor/sfield/examples/hello-agent.mjs
node vendor/sfield/examples/hitl-approval.mjs
node vendor/sfield/examples/mcp-federation.mjs
node vendor/sfield/examples/postgres-or-json-service.mjs
node vendor/sfield/examples/agent-to-agent-identity.mjs
# Polyglot Python MCP 2026 tool -> sfield bridge:
# python3 vendor/sfield/examples/python-mcp-tool/server.py & node vendor/sfield/examples/python-mcp-tool/bridge.mjs
```

Licensed under [Apache-2.0](./LICENSE).
