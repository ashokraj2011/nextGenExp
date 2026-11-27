# `sfield` — Governed Enterprise Agent SDK

`sfield` is a standalone, TypeScript-first **Governed Agent SDK** for Node.js 22+ designed for production enterprise AI applications where every model call, tool invocation, memory write, and sub-agent delegation must be **schema-verified, identity-scoped, policy-gated, auditable, and resilient**.

---

## Packages

| Package | Role | Key Exports |
| :--- | :--- | :--- |
| **`@sfield/core`** | Runtime, model gateway, closed-schema tool pipeline, deterministic Data-to-UI `SurfaceBinder`, HITL approvals, MCP 2026 server/client (Elicitation + Async Tasks), PII firewall, resilience, delegation, streaming, artifacts & vector memory | `SField`, `defineTool`, `SurfaceBinderService` (`sf.surfaces`), `AnthropicProvider`, `GeminiProvider`, `OpenAICompatibleProvider`, `SFieldMcpServer`, `McpClient`, `createMcpProxyTools`, `createPiiFirewallHook`, `createToolResilienceGuard`, `DelegationService`, `streamRun`, `FilesystemArtifactStore`, `VectorMemoryIndex` |
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

## Deterministic Data-to-UI Stitching (`sf.surfaces`)

`sf.surfaces` (`SurfaceBinderService`) lets `sfield` own the entire Data-to-UI stitch and action dispatch boundary so host app servers can blindly render stitched envelopes and blindly forward action clicks:

- **Schema Auto-Discovery (`sf.surfaces.inspectSchemas()`)**: Inspects registered tool JSON Schemas to advertise bindable output/input paths; `strictSchemaValidation: true` rejects mistyped `$ref` paths before render.
- **Declarative Stitching (`sf.surfaces.stitch(...)`)**: Executes read sources via `ExecutionScope`, resolves `$ref` (including `principal.identifiers.*`), iterates arrays via `$repeat` (`$item` / `$index`), applies deterministic formatters (`usd_cents`, `usd`, `percent`, `date`, etc.), and cryptographically seals every action with **HMAC-SHA256** bound to `{ tenantId, subjectId, surfaceId, actionId, toolRef, preset, resolvedInputs, inputSlots }`.
- **Tamper-Proof Action Dispatch (`sf.surfaces.dispatchAction(...)`)**: Verifies the HMAC seal and `Principal` identity (rejecting tampered arguments or cross-principal replay with `INVALID_ACTION_SEAL`), merges only declared `$input` form slots, and returns normalized outcomes (`succeeded`, `pending_approval`, `input_required`, `denied`, `failed`).

---

## MCP 2026 (`2026-07-28`) Elicitation & Async Tasks

`sf.createMcpServer()` and `createMcpClient()` implement MCP `2026-07-28` (backwards-compatible with `2025-03-26`):

- **Stateless Discovery (`server/discover`)**: Advertises capabilities, protocol versions, and allowlisted tools without requiring a stateful session.
- **Elicitation (`elicitation/create` / `elicitation/respond`)**: Tools can suspend mid-flight via `ctx.elicit({ message, requestedSchema })`, returning `status: "input_required"` and validating user answers against the closed JSON Schema before resuming.
- **Async Tasks (`tasks/get`, `tasks/result`, `tasks/cancel`)**: Long-running tool invocations return a tenant-isolated `taskId` immediately, support mid-flight elicitation, and can be polled or cancelled cleanly.

---

## How `sfield` Compares to Other Agent Frameworks

| Capability | `sfield` (`@sfield/*`) | LangGraph / LangChain | Vercel AI SDK | OpenAI Agents SDK | Google ADK | Mastra / CrewAI |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Primary focus** | Zero-trust enterprise governance runtime (Node 22+ / TS) | Graph/state-machine orchestration (Python / JS) | Streaming UI hooks & multi-model SDK (TS) | Lightweight multi-agent handoffs & guardrails | Hierarchical multi-agent & Vertex AI / Gemini | Rapid workflow / role-based prototyping |
| **Identity, multi-tenant & OBO** | **Built-in** `Principal` (`human\|agent\|service`, custom `identifiers`, RFC 8693 `actingFor`) | App-layer / custom middleware | App-layer / custom middleware | Context object (no built-in OBO) | Session state / Vertex IAM | App-layer / custom middleware |
| **Policy presets & closed schemas** | **Built-in** (`read_only`, `supervised`, `bounded_auto`) + closed Ajv schemas + tool narrowing | Custom guards; Pydantic/Zod | Zod schemas; host enforces effects | Guardrail functions | Tool callbacks / plugins | Zod/Pydantic; custom policy |
| **Digest-bound HITL & resume** | **Built-in** SHA-256 argument-bound approvals + SQLite/Postgres checkpoints | Checkpointed `interrupt()` (digest & RBAC DIY) | Confirmation hooks (host persists) | Approval callbacks | Long-running pause / resume | Workflow suspend / resume |
| **Data-to-UI stitch & sealed actions** | **Built-in** `sf.surfaces` (`$ref`/`$repeat`/`$input` + HMAC-SHA256 sealed actions) | Separate (AG-UI / CopilotKit) | Generative UI (`streamUI`), no action sealing | None built-in | None built-in | None built-in |
| **MCP 2026 (Elicitation & Async Tasks)** | **Built-in** RBAC `SFieldMcpServer` (HTTP + stdio), Elicitation, Async Tasks & `McpClient` | MCP client adapters | Experimental MCP client | MCP client | MCP toolset client | MCP adapters |
| **PII firewall & resilience** | **Built-in** `PiiFirewall` + `TokenBucket` + 3-state `CircuitBreaker` | External gateway / DIY | External gateway / DIY | Custom guardrails | Model Armor (GCP) / DIY | Custom middleware |
| **Workbench & release gates** | **Embeddable & standalone** `@sfield/studio` + `sfield eval` + `sfield lock approve` | LangSmith / LangGraph Studio | External (OTel / Braintrust) | OpenAI Traces | ADK Web UI + Vertex Eval | Mastra Playground / CrewAI Enterprise |

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
```

Licensed under [Apache-2.0](./LICENSE).
