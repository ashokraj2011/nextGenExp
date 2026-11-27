# `sfield` — Governed Enterprise Agent SDK

`sfield` is a standalone, TypeScript-first **Governed Agent SDK** for Node.js 22+ designed for production enterprise AI applications where every model call, tool invocation, memory write, and sub-agent delegation must be **schema-verified, identity-scoped, policy-gated, auditable, and resilient**.

---

## Packages

| Package | Role | Key Exports |
| :--- | :--- | :--- |
| **`@sfield/core`** | Runtime, model gateway, closed-schema tool pipeline, HITL approvals, MCP server/client, PII firewall, resilience, delegation, streaming, artifacts & vector memory | `SField`, `defineTool`, `AnthropicProvider`, `GeminiProvider`, `OpenAICompatibleProvider`, `SFieldMcpServer`, `McpClient`, `createMcpProxyTools`, `createPiiFirewallHook`, `createToolResilienceGuard`, `DelegationService`, `streamRun`, `FilesystemArtifactStore`, `VectorMemoryIndex` |
| **`@sfield/preset-memory`** | Zero-boilerplate ephemeral preset for tests & scripts | `preset: "memory"` (`EphemeralPersistence`, `InMemoryArtifactStore`, `createDevAuthorizer`) |
| **`@sfield/preset-local`** | Zero-boilerplate durable local preset | `preset: "local"` (`SqlitePersistence`, `FilesystemArtifactStore`, `createDevAuthorizer`) |
| **`@sfield/store-sqlite`** | `durable_single` persistence over built-in `node:sqlite` | `sqlitePersistence`, `SqlitePersistence`, `SqliteMemoryRepository` |
| **`@sfield/store-postgres`** | `deployment: "service"` PostgreSQL persistence **with automatic durable JSON-file fallback** | `PostgresPersistence`, `PostgresMemoryRepository`, `POSTGRES_SCHEMA_SQL`, `createPgPoolAdapter`, `JsonFilePersistence`, `createPostgresOrJsonPersistence` |
| **`@sfield/telemetry-otel`** | Zero-dependency OpenTelemetry `gen_ai.*` `TelemetrySink` | `createOtelTelemetrySink`, `OtelTelemetrySink` (OTLP/HTTP JSON `v1/traces`) |
| **`@sfield/testing`** | Conformance suites, deterministic fake providers & guardrail eval runner | `persistenceConformance`, `runEvalSuite`, `evaluateReleaseGate`, `FakeModelProvider` |
| **`@sfield/cli`** | Standalone CLI (`sfield`) | `init`, `validate`, `eval`, `lock status`, `lock approve`, `inspect`, `mcp serve` |

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
