## `sphoton` — Shared Tool Bindings for Chat UI

`sphoton` *(Singularity Photon)* is the dedicated UI data-binding toolkit in `packages/sphoton/`. It sits cleanly between headless **`sfield`** *(Singularity Field)* and the host app/domains so domain owners can build or generate chat cards from registered `sfield` tools, preview them, submit them for Admin chat approval, and update published cards in place.

### Separation of Responsibilities

```
┌────────────────────────────────────────────────────────────────────────────┐
│                        App & Domains (CEP)                                 │
│  • Registers domain A2UI components (cepSphotonRegistry)                   │
│  • UI Builder field picker & preview   • Tenant/domain exposure & labels   │
│  • Admin chat publication approval     • Browser A2UI renderer & threads   │
│  • GET / POST /api/admin/ui-binding-catalog?domain=<domain>                │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ SphotonBindingCatalog + SphotonComponentRegistry
                                ▼
┌────────────────────────────────────────────────────────────────────────────┐
│              sphoton (packages/sphoton/ — 100% Domain-Agnostic)            │
│  • Zero CEP/domain imports (depends only on zod, node:crypto, @sfield/core)│
│  • Pluggable SphotonComponentRegistry (registerComponent)                  │
│  • Binding contract, schema validator & SHA-256 dependency fingerprinting    │
│  • Catalog-driven AI draft generator (injected SphotonLlmAdapter)          │
│  • Single deterministic compiler + SurfaceBinder (createSurfaceBinder)     │
│  • Verified turn-result reuse, unavailable states & persistent HMAC seals  │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ Narrow SfieldAdapter / public SField API
                                ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                sfield (@sfield/core — 100% Headless Runtime)               │
│  • Tool registry & versioned closed JSON Schemas                           │
│  • Policy-enforced execution scopes, HITL approvals & immutable call logs  │
│  • Zero UI code (no SurfaceBinder, components, layouts, cards, or A2UI)    │
└────────────────────────────────────────────────────────────────────────────┘
```

| Layer | Owns | Does Not Own |
| :--- | :--- | :--- |
| **`sfield`** | Tool registry, versioned input/output JSON Schemas, scoped execution, and call logs. | UI components, layouts, cards, formatters, or A2UI. |
| **`sphoton`** | Design binding contract, schema/type validation, AI draft generation, single A2UI compiler, unavailable states, and HMAC-SHA256 signed action references. | Tool implementations, domain allowlists, approval UI, or thread persistence. |
| **App & Domains** | Registers tools in `sfield`, sets tenant/domain exposure & friendly labels, runs UI Builder, Admin chat approval, browser A2UI renderer, and customer/thread scope. | Duplicate card compilers or per-card validation rules. |

---

### 1. Discover Exposed Fields (`GET /api/admin/ui-binding-catalog`)

`GET /api/admin/ui-binding-catalog?domain=wealth` filters the `sfield` registry by the caller's tenant and authorized domain, returning:

- `tools` — versioned `toolRef` (`id@version`), closed input/output schemas, and SHA-256 `contractFingerprint`.
- `fields` — exposed output paths with `sfield`-supplied types, domain-supplied friendly labels (e.g. `goal.progress.read@1.0.0 -> targetCents` as **Down payment target**), and supported formats (`currency_cents`, `percent`, `month`, `date`, `series`, `text`).
- `actions` — allowed action tools (`goal.savings.preview@1.0.0`, `ops.incident.rollback.preview@1.0.0`, `sales.discount.preview@1.0.0`) with fixed input schemas, follow-up input slots, and default update mode (`originalCard`).

Domain owners can expose or hide registered `sfield` tool fields via `POST /api/admin/ui-binding-catalog?domain=<domain>`. Both the UI Builder field picker and `POST /api/admin/ui-layout-generate?domain=<domain>` consume the exact same catalog.

### 2. Author a Tool-Bound Card

A slot (`block` or `widget`) declares a `toolBinding`:

```json
{
  "component": "PznGoalProgress",
  "sources": {
    "goal": {
      "toolRef": "goal.progress.read@1.0.0",
      "read": "reuseVerifiedTurnResult"
    }
  },
  "bindings": [
    { "field": "goal.targetCents", "from": "goal.data.targetCents", "format": "currency_cents", "required": true },
    { "field": "goal.history", "from": "goal.data.history", "format": "series", "required": true }
  ],
  "actions": [
    {
      "id": "add-monthly-savings",
      "label": "Add $500 a month",
      "toolRef": "goal.savings.preview@1.0.0",
      "fixedInputs": { "extraMonthlyCents": 50000 },
      "followUpInputs": ["startMonth"],
      "update": "originalCard"
    }
  ]
}
```

### 3. Validate, Fingerprint & Publish

1. `validateCardBinding` (`packages/sphoton/validator.ts`) checks every source tool, output path, format, component destination type (e.g., `goal.targetCents` requires `integer | number`), and action input against closed `sfield` schemas and the domain's catalog.
2. `compileBoundCard` (`packages/sphoton/compiler.ts`) compiles the card identically for draft preview, approval preview, and customer chat.
3. Submitting **Publish** computes SHA-256 tool-contract and domain-exposure fingerprints (`dependencyRevision` in `apps/server/publication-reviews.ts` and `apps/server/studio-publications.ts`). Drafts and pending revisions stay out of customer chat. If a tool contract or exposed field changes during review, approval is rejected and the author submits a revised review.

### 4. Render, Reuse Reads, Update in Place & Audit in Logs

1. On a customer turn, `compileBoundCard` reuses the turn's verified tool result when `read: "reuseVerifiedTurnResult"` is set (avoiding duplicate `sfield` reads). If missing, it invokes the declared read through `SfieldAdapter` using the customer's scope.
2. Missing required fields render the card's approved `unavailableState` rather than partial or fabricated figures. Incompatible tool contracts return `incompatible_contract` until a revised publication is approved.
3. Actions emit persistent HMAC-SHA256 signed references (`sphoton-signing.key`, bound to tenant, domain, principal, and conversation). Clicking **Add $500 a month** or asking **“What if I start in March?”** updates the original card in place and persists on the thread for reload.
4. **Administration → Logs** (`apps/server/turn-payloads.ts`, `apps/web/call-logs.tsx`) shows the approved design revision, bound tool versions, originating turn link, and the exact `sfield` inputs and outputs for every projection call.

### 5. Multi-Domain Support & `smass` Integration

Any domain (`wealth`, `it_ops`, `sales_revops`, or future packs) publishes cards through the same `packages/sphoton/` compiler using its own catalog (`ops.incident.read@1.0.0`, `sales.deal.read@1.0.0`, etc.). Cross-domain tool bindings are blocked at validation and preview time.

- **How `smass` feeds `sphoton` without coupling**: `packages/smass/` and `packages/sphoton/` have zero direct imports of each other. `smass` models each domain's relational entities (`wealth.customer`, `wealth.home_goal`, `wealth.portfolio`, `wealth.balances`, `ops.service`, `ops.incident`, `sales.account`, `sales.deal`), holds the canonical field binding catalog (`packages/smass/bindings.ts`), and projects UI-exposable fields and actions via `projectBindingsForDomain(domain)`. The host bridge (`apps/server/sphoton-catalog.ts`) merges those projections with live domain-owner toggles from **Tool setup** (`/admin`), fingerprints each closed `sfield` tool contract, and hands `sphoton` a signed `SphotonBindingCatalog` (`GET /api/admin/ui-binding-catalog?domain=<domain>`). At runtime, `sphoton` never reads `smass` directly — every read and sealed action executes through `sfield`. See `docs/developers/smass.md`.

---

### 6. Unified 5-Class Experience Composer & Surface Policies (`packages/sphoton/experience-composer.ts`)

`sphoton` owns **Experience Composition & Surface Policies** across all domains and channels, while **`sfield` tools** (including PZN, domain APIs, compliance checks, and workflows) supply verified candidates and actions:

- **Zero PZN coupling in `sphoton`**: PZN (`pzn.treatments.decide@1.0.0`) is simply one pluggable `sfield` tool. Any domain (Wealth, Banking, Retirement, IT Ops, RevOps) can bind its own `sfield` tools into the exact same 5-class surface arbitrator.
- **5-Class UI Taxonomy (`SphotonUiPlacementClass`)**:
  1. `main` — Primary experience fulfilling user intent (non-negotiable #1).
  2. `tasks` — Pending obligations (outranks `nba` when channel companion caps are tight).
  3. `nba` — Ranked recommendations (auto-promotes into freed companion slots on live task completion; dismissals sync cross-channel via `sfield` memory).
  4. `actions` — Interactive HMAC-signed `sfield` workflows.
  5. `chrome` — Follow-up chips (clamped to channel budget) + immutable compliance disclosures.
- **3 UI Resolution Modes (`resolveExperienceUi`)**:
  - `pinned_widget` — Design-time attached component from the unified UI Registry or Widget Studio (`/admin/ui`).
  - `runtime_tool_selected` — Runtime template dynamically picked by a bound `sfield` tool per member and channel.
  - `runtime_sphoton_generative` — Runtime-synthesized declarative A2UI node tree bound strictly to verified `smass` snapshot fields.
- **Channel Surface Budgets (`DEFAULT_SPHOTON_CHANNEL_BUDGETS` & `arbitrateExperienceSurface`)**:
  - `chat_turn`: `1 Main + max 1 Companion (Task > NBA) + 3 Follow-ups` (wired directly into live customer chat turns in `apps/server/service.ts` via `TurnView.surfaceArbitration`).
  - `web_dashboard`: `1 Main + max 3 Tasks + 1 NBA + 4 Follow-ups`.
  - `mobile_compact`: `1 Main + max 1 Priority Pill (Task > NBA) + 1 Follow-up`.
  - `advisor_desktop`: `1 Main + max 4 Tasks + 3 NBAs + full provenance`.
- **Consolidated Studio & SQLite Persistence**:
  - `/admin/ui` (**sphoton UI Studio**) unifies UI Layouts, Widget Library, SurfaceBinder Lab, and the 5-Class Experience Composer (`/experience-composer`) in one place.
  - Custom Subject Areas, Experiences, Channel Budgets, UI Bindings, and cross-channel dismissals persist in SQLite (`experience-composer.sqlite`) across server restarts.
