## `smass` — Singularity Mass (Domain Models & Data Fabric)

`smass` *(Singularity Mass)* is the domain-modeling framework in `packages/smass/`. It completes the **3-pillar Singularity architecture** alongside headless **`sfield`** *(Singularity Field)* and UI-binding **`sphoton`** *(Singularity Photon)*:

```
┌────────────────────────────────────────────────────────────────────────────┐
│                   smass (packages/smass/ — Domain Models)                  │
│  • Mode 1 — Tool-backed models: compose entities from existing sfield tools│
│  • Mode 2 — Store-backed models: define fields + DataSource once           │
│  • Compiles store models -> closed Ajv @sfield/core ToolDefinition[]       │
│  • Projects fields, labels, formats & actions -> sphoton binding catalogs  │
│  • Zero UI code, zero HTTP server imports                                  │
└───────────────┬──────────────────────────────────────────┬─────────────────┘
                │ toSfieldTools() / schema validation      │ projectBindingsForDomain()
                ▼                                          ▼
┌────────────────────────────────────────┐  ┌────────────────────────────────┐
│   sfield (@sfield/core — Headless)     │  │ sphoton (packages/sphoton/)    │
│  • Tool registry & closed Ajv schemas  │◀─│ • SphotonComponentRegistry     │
│  • Policy presets, HITL, MCP & logs    │  │ • Validation & AI drafts       │
│  • Zero UI, zero domain schemas        │  │ • A2UI compiler & HMAC seals   │
└────────────────────────────────────────┘  └────────────────────────────────┘
```

### Two Modes in One Model Framework

#### 1. Tool-Backed Models (`defineToolBackedModel`) — Brownfield / Federated
Compose a canonical domain entity from tools already registered in `sfield` (existing microservices, connectors, MCP servers, or Treatment Selector) without duplicating schemas:

```ts
import { defineToolBackedModel } from "../../packages/smass";

export const wealthHomeGoalModel = defineToolBackedModel({
  id: "wealth.home_goal",
  version: "1.0.0",
  domain: "wealth",
  label: "Goal Progress",
  sources: { goal: { toolRef: "goal.progress.read@1.0.0" } },
  fields: {
    targetCents: { from: "goal.targetCents", label: "Down payment target", format: "currency_cents", classification: "confidential" },
    history:     { from: "goal.history",     label: "Savings history",     format: "series",         classification: "confidential" },
  },
  actions: [
    {
      id: "add-monthly-savings",
      toolRef: "goal.savings.preview@1.0.0",
      label: "Add $500 a month",
      fixedInputFields: { extraMonthlyCents: "integer" },
      followUpInputFields: ["startMonth"],
      defaultUpdate: "originalCard",
    },
  ],
});
```

`smass.validateAgainstTools(descriptors)` verifies every `from` path against `sfield`'s closed JSON Schema so schema drift is caught immediately.

#### 2. Store-Backed Models (`defineStoreBackedModel`) — Greenfield / Local or Store Adapters
Define an entity's fields, classifications, actions, and `DataSource` **once** (as CEP does for `ops.incident` and `sales.deal` in `apps/server/domain-models.ts`). `smass` automatically compiles:

- **Closed JSON Schemas** (`additionalProperties: false`, typed `properties`, `required`)
- **Executable `@sfield/core` tools** (`smass.toSfieldTools()` → `ops.incident.read@1.0.0`, `ops.incident.rollback.preview@1.0.0`)
- **`sphoton` binding catalog entries** (`smass.projectBindingsForDomain(domain)`)

### Canonical Data Model Representation (`toDataModelGraph`)

Beyond field bindings, `smass` represents the full relational data model for every domain:

- **Keys & Federation**: `primaryKey`, `foreignKey` (`{ modelId, field }`), and `principalKey` (e.g. `principal.identifiers.mid`) linking federated `tool_backed` entities across separate microservices.
- **Entity Relationships (`relations`)**: Directed edges (`one_to_one`, `one_to_many`, `many_to_one`, `many_to_many`) with join keys (`localField`, `foreignField`) and referential integrity validation via `validateDomainGraph()`.
- **Rich Field Semantics**: `enumValues`, `nullable`, typed nested `items` schemas (e.g., `history: [{ month, savedCents }]`), and `computed` derived fields (`{ expression, dependsOn }`).
- **Entity Lifecycles (`lifecycle`)**: Valid state sets and transitions tied to `smass` actions (e.g. `ops.incident.rollbackStatus` and `sales.deal.discountStatus`).
- **Standard Exports**: `registry.toDataModelGraph(domain)` compiles the live domain model into:
  - **`entities` & `relations`** — structured Entity-Relationship graph
  - **`mermaidEr`** — canonical Mermaid `erDiagram` source
  - **`jsonSchema`** — Draft 2020-12 JSON Schema `$defs` bundle

### Inspect & Evolve Domain Models

`GET /api/admin/domain-models?domain=<domain>` returns the domain's registered `sfield` tools + closed output schemas, `models`, canonical `dataModel` (`entities`, `relations`, `mermaidEr`, `jsonSchema`), and `sphoton` `catalog`. Evolving a tool schema field in **Tool setup** (`/admin`) immediately updates the `smass` data model, JSON Schema, Mermaid ER diagram, and `sphoton` UI Builder catalog.

See `apps/server/domain-models.ts`, `apps/server/sphoton-catalog.ts`, `apps/web/domain-tools-model.tsx`, and `tests/smass.test.ts`.
