## `sfield` — Governed Enterprise Agent SDK

**`sfield`** is the standalone TypeScript-first **Governed Agent SDK** (Node.js 22+) that powers CEP. Every capability built in this repository—closed-schema tool execution, HITL approvals, MCP federation, PII egress firewalling, resilience guards, sub-agent delegation, OpenTelemetry tracing, vector memory, and durable storage—is packaged under `vendor/sfield/packages/*` so any application can adopt `sfield` independently of CEP.

> Prefer a visual architecture overview? Open the standalone HTML guide at [`/sfield-sdk.html`](/sfield-sdk.html) or launch the live governance workbench at [`/admin/sfield-studio`](/admin/sfield-studio).

---

### Package suite (9 publishable workspaces)

| Package | Role | Key exports |
| --- | --- | --- |
| `@sfield/core` | Core runtime & enterprise primitives | `SField`, `defineTool`, `SurfaceBinderService` (`sf.surfaces`), `AnthropicProvider`, `GeminiProvider`, `OpenAICompatibleProvider`, `SFieldMcpServer` (MCP 2026), `McpClient`, `createMcpProxyTools`, `createPiiFirewallHook`, `createToolResilienceGuard`, `DelegationService`, `streamRun`, `FilesystemArtifactStore`, `VectorMemoryIndex` |
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

### Deterministic Data-to-UI Stitching (`sf.surfaces`) & Blind Pass-Through

`sf.surfaces` (`SurfaceBinderService`) eliminates bespoke per-screen server glue and prevents LLMs from fabricating financial figures in UI payloads:

1. **`sf.surfaces.inspectSchemas()`** — auto-discovers bindable output/input paths from registered `sfield` tool JSON Schemas.
2. **`sf.surfaces.stitch({ principal, template, sources, strictSchemaValidation })`** — executes read sources via `ExecutionScope`, resolves `$ref` (including `principal.identifiers.*`), expands `$repeat` (`$item` / `$index`), formats values (`usd_cents`, `percent`, `date`, etc.), and seals every action with **HMAC-SHA256** bound to the principal and resolved arguments.
3. **`sf.surfaces.dispatchAction({ principal, action, formInputs })`** — verifies the HMAC seal and `Principal` match (blocking tampering & cross-principal replay), merges only declared `$input` slots, and returns normalized outcomes (`succeeded`, `pending_approval`, `input_required`, `denied`, `failed`).

CEP exposes these directly as zero-glue blind pass-through endpoints in `apps/server/routes/collaboration.ts`:
- `GET /api/surfaces/schemas`
- `POST /api/surfaces/stitch`
- `POST /api/surfaces/action`

---

### MCP 2026 (`2026-07-28`) Elicitation & Async Tasks

`sf.createMcpServer()` and `createMcpClient()` negotiate `2026-07-28` (while remaining backwards-compatible with `2025-03-26`), adding:

- **Stateless `server/discover`** for lightweight capability & tool discovery.
- **Structured Elicitation (`elicitation/create` / `elicitation/respond`)** so tools can pause mid-flight with `status: "input_required"` and validate structured user input against a closed JSON Schema.
- **Tenant-Isolated Async Tasks (`tasks/get`, `tasks/result`, `tasks/cancel`)** supporting long-running execution, mid-flight elicitation, and cancellation.

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
