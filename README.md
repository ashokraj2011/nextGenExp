# CEP — Customer Engagement Platform

A governed, multi-domain **Customer Engagement Platform (CEP)** built on **`sfield`** (tool governance, zero-trust authorization, durable checkpoints), **A2UI v1.0** (deterministic, schema-verified UI rendering), **assistant-ui**, and **Copilot ACP / OpenAI / Enterprise Gateway** LLM adapters.

> **Presenting live?** See the ready-to-run **[5-Minute Executive Demo Script](./DEMO_SCRIPT.md)** (also available in-app at `/admin/help#demo-playbook`).

---

## Platform Highlights

| Pillar | Capabilities Included |
| :--- | :--- |
| **Unified Semantic Routing** | Declarative 8-capability catalog (`packages/contracts/capabilities-catalog.ts`) + live LLM Semantic Capability Router (`apps/server/semantic-router.ts`) with parameter extraction and transparent routing traces inside **Advisory Reasoning** in admin test chat. |
| **Governed Wealth & Single-Source-of-Truth Ledger** | Verified A2UI experiences (Portfolio Snapshot, Balances, Home Goal, Retirement, Beneficiaries, Address Update, Funding Preview) + **Live Stock Holdings & Tax-Lot Ledger** (`apps/server/trade-store.ts`) synchronized penny-for-penny with Customer 360 (`Portfolio snapshot` = `SUM(shares × price)` + Cash + Fixed Income). |
| **Conversational Trade & Tax-Loss Harvesting Engine** | Simulate buying/selling shares by count or `%`, run **Tax-Loss Harvesting Analysis** with editable loss-offset recommendations and a real **30-day Wash-Sale Ledger**, drive drafts conversationally (`"yes"`, `"change to 50%"`, `"execute bundle"`), and execute **durable SSE-streamed timed jobs** with mid-flight **Cancel** and automatic `sfield` settlement. |
| **Multi-Domain Reusability** | Declarative Domain Packs (**Wealth Advisory**, **IT Operations & SRE**, **Sales & Revenue Ops**) with sidebar Domain Pack Switcher, live operational HUDs, persisted JSON/SQLite stores (`incidents.json`, `deals.json`, `customer-profiles.json`), and full Admin Entity CRUD at `/admin/customers`. |
| **Unified `sfield` Governance & HITL Approvals** | Three host-governed platform tools: **`cep.recommendations.arbitrate@1.0.0`** (parallel provider fan-out), **`cep.domain.execute_write@1.0.0`** (resource-bound mutations), and **`cep.connector.invoke@1.0.0`** (external REST/MCP actions) — protected by a SHA-256 digest-bound **Human-in-the-Loop Approval Queue** surfaced both inline in **Chat** and at `/admin/logs?source=approvals` (with optional **4-eyes dual control** and high-value trade gating). |
| **No-Code Admin Control Plane** | Manage Customer 360 & domain records (`/admin/customers`), Intents, Content, NBA Rules & **No-Code Action Flows** (`/admin/intents`), **UI Builder & Widget Studio** with pre-seeded **IT Ops** & **Sales RevOps** templates (`/admin/ui`), Tool Setup, CCRE Rules & **External REST/MCP Connector Registry** (`/admin`), **Closed-Loop Engagement Analytics & Write Audit Log** (`/admin/logs`), and interactive **14-Step Architecture Docs** (`/admin/help`). |
| **Light & Dark Theme** | Persistent Light/Dark design system across Customer Chat, Admin Control Plane, UI Builder, and Architecture Docs. |

---

## Quick Start

Requires **Node 22.13+** and **npm 10+**. The `sfield` core, SQLite persistence store, and testing harness are vendored in `vendor/sfield` as local npm workspaces.

```sh
npm ci
npm run build
```

### 1. Run with GitHub Copilot ACP (Recommended Local Live Mode)
Sign in once via Copilot CLI (`copilot login`), then start CEP in dev mode:

```sh
LLM_PROVIDER=copilot_acp PZN_PORT=4180 npm run dev
```

Open **[http://127.0.0.1:4180/](http://127.0.0.1:4180/)** for Customer Chat and **[http://127.0.0.1:4180/admin/help](http://127.0.0.1:4180/admin/help)** for interactive Architecture Docs.

### 2. Run with Direct OpenAI API
Set `OPENAI_API_KEY` (or put it in ignored `.env.openai`):

```sh
npm run build
npm run start:openai
```

Opens on port `4175` with `gpt-4.1-mini` (override via `OPENAI_MODEL`).

### 3. Run Deterministic Offline Test Preview (No API Keys Required)

```sh
npm run test:preview
```

Opens on `http://127.0.0.1:4174` using deterministic fixture gateway responses through real `sfield`, SQLite, host verifiers, assistant-ui, and A2UI v1.0.

### 4. Run with an Enterprise Gateway
Copy `.env.example` to `.env` and set `LLM_PROVIDER=gateway`, `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY` (or custom headers via `LLM_GATEWAY_HEADERS_JSON` and body fields via `LLM_GATEWAY_BODY_JSON`), then run `npm start`.

---

### Model gateway (sfield)

**Administration → Model gateway** (`/admin/gateway`) configures the LLM that sfield binds for every agent run, chat copilot and tool call: an OpenAI-compatible gateway (base URL, model, API key or env var, extra headers/body fields, context and output limits, adapter quirks), the OpenAI API, or GitHub Copilot (ACP).

1. **Test connection** checks the settings with the same rules as the environment variables, runs sfield's context-capacity check for the router and composer prompts, and makes a real model call that must return JSON.
2. **Activate** is enabled only after a passing test of exactly those settings (within 30 minutes). It saves the configuration to `llm-gateway.json` in the data directory (mode 600; a stored key is never sent back to the browser) and restarts the app in place so sfield re-binds the model. Pending approvals resume after the restart.
3. A saved configuration overrides the launch environment on every start. **Use environment settings instead** removes it. If a saved configuration can't start, the server falls back to the environment settings.

### Tenants, domains and shared designs

A tenant is one organization running the app. Inside it, a user can belong to more than one domain. Wealth, IT Operations and Sales each have a design library at `/admin/ui?view=library`. A domain owner can publish from **Administration → UI Builder** at `/admin/ui`. Choose the domain, attach the design to an intent or capability, and select **Publish**. **Design library** shows the published revision. Another owner with access can choose **Use as template**, select a domain they own and attach the copy to its own intent.

| Scope | What belongs there |
| --- | --- |
| Tenant | The app process, model configuration and data directory |
| Domain | Memberships, published layouts, widgets and their attachments |
| User | The customer profile in Wealth or the signed-in operator in IT and Sales |
| Session and thread | Chat messages and follow-up context in sfield |

When Alice and Jordan compare balances, both can receive one Wealth design. The server fills its fields from the profile on each chat. A new draft stays with its author until published. A turn records the published revision it used, so a later edit leaves earlier answers intact.

Set `PZN_TENANT_ID` on the server. A named tenant stores its files under `PZN_DATA_DIR/tenants/<tenant-id>`. Use a separate process and port per tenant. The default `pzn-local` tenant keeps the existing installation path. On upgrade, an original browser session can reclaim its older drafts by saving them under a signed-in owner. If legacy publications overlap, the most recently updated layout keeps the attachment and the others remain drafts.

Set these variables alongside your operator credentials to limit access by domain. Omitted domains are closed when the membership map is present. Operators listed in `PZN_TENANT_ADMINS_JSON` can manage tenant-wide settings and all domain libraries.

```dotenv
PZN_TENANT_ID=north
PZN_DOMAIN_MEMBERSHIPS_JSON='{"wealth":{"owners":["wealth-owner"],"users":["demo-learner","demo-returning"]},"it_ops":{"owners":["ops-owner"],"users":["oncall"]}}'
PZN_TENANT_ADMINS_JSON='["platform-admin"]'
```

Without a membership map, the local app retains open profile selection and existing operator access. With memberships configured, the Wealth profile picker binds one selected customer to the server session. Switching profiles changes the account and threads that session can access. The picker simulates customer sign-in. A customer deployment needs a verified identity from its sign-in system mapped to a tenant, domain and user before opening a chat.

### Operator sign-in

Customer chat opens at `/`. The admin, integration, sales and operations workspaces prompt for an operator account. On first start the server saves the local operator username and generated password in `operator-credentials.json` inside the active data directory. For Copilot on port 4180 the default path is `.pzn-data/copilot/operator-credentials.json`. To use separate identities for approvals, set `PZN_OPERATORS_JSON` to a JSON object mapping two or more usernames to passwords of at least 12 characters each. Customer sign-in uses the local profile picker.

For local demos you can skip the prompt with `PZN_OPERATOR_AUTH=off`. Admin pages then open without a password and actions are attributed to `local-operator`; signing in still works and takes precedence (useful for testing dual control). The server refuses this setting under `NODE_ENV=production`, and it only listens on `127.0.0.1`/`localhost`.

In `/integrations`, the **Customer chat** settings on a read task map the record ID, member ID and fields customers may see. Publish the task to make it available in chat. For example, Alice can ask “Where is my order ORD-1001?” and then “Tell me when it is delivered.” The server checks the registered source and posts the status change to that thread.

## Navigation & Admin Control Plane Map

| Route | Purpose |
| :--- | :--- |
| `/` and `/chat` | Customer chat with pinned sections, an account summary, personalized pending actions and saved threads. |
| `/planning` | Customer planning overview & topic launcher. |
| `/login` | Demo profile selector (**Alice Morgan**, **Jordan Lee**, **Marcus Reed**). |
| `/admin` | **Tool Setup**, Treatment Selector overrides, CCRE rule builder, **Recommendation Providers (`sfield`)**, **External REST & MCP Connector Registry** (`Invoke via sfield`), and Capability Studio. |
| `/admin/customers` | **Customer 360** CRUD + **IT Ops Incidents** CRUD + **Sales RevOps Deals** CRUD. |
| `/admin/intents` | **Intents & TS Mapping**, **Content Catalog**, **NBA Priority Rules**, and **Action Flows (No-Code)**. |
| `/admin/ui` | **UI Builder** (drag-and-drop multi-namespace `customer.*` / `incident.*` / `deal.*` / `custom.*` bindings + starter templates) and **Widget Studio**. |
| `/admin/logs` | **Chat calls**, **Pending actions**, **Approvals (HITL)** (`?source=approvals`), **Write audit (sfield)** (`?source=write_audit`), and **Engagement analytics** (`?source=analytics`). |
| `/admin/inspector` | Deep turn decision trace, verified Experience IR, and `sfield` run inspection. |
| `/admin/help` | **Architecture & Playbook**: 14-step clickable sequence diagram (showing host A2UI compilation & SSE delivery), **`sfield` Runtime Architecture**, downloadable contracts, and **5-Minute Demo Playbook**. |

---

## Verification & Automated Tests

```sh
# Full TypeScript check (including vendor/sfield) + Vite production build
npm run build

# Unit & integration host test suite (38 tests covering sfield, verifiers, SSE, CCRE, recovery)
node --import tsx --test tests/host.test.ts

# End-to-end Playwright browser verification (Chat, Help, Admin, UI Builder, Logs, mobile layouts)
node --import tsx tests/browser.ts

# Interactive CLI chat harness (tests sfield transcript persistence across restarts)
npm run chat:harness
```

---

## Project Map

- **`apps/server/`** — HTTP/SSE server (`http.ts`), `sfield` runtime & host-governed tools (`runtime.ts`), Unified Semantic Capability Router (`semantic-router.ts`), Experience orchestrator (`service.ts`), Dynamic UI & domain builders (`dynamic-ui-generator.ts`), and persisted domain stores (`trade-store.ts`, `approval-store.ts`, `connector-store.ts`, `action-flow-store.ts`, `ops-store.ts`, `sales-store.ts`, `write-audit.ts`).
- **`apps/web/`** — React + assistant-ui Chat (`main.tsx`), A2UI v1.0 renderer (`surface.tsx`), Dynamic Canvas & Stock Trade/Tax-Harvest UI (`dynamic-canvas.tsx`, `trade-ticket.tsx`), Advisory Reasoning (`reasoning-panel.tsx`), Admin Control Plane (`admin.tsx`, `admin-diagnostics.tsx`, `experience-registry-admin.tsx`, `action-flows-panel.tsx`, `ui-builder.tsx`, `customer-360-admin.tsx`), and Architecture Docs (`help.tsx`, `help-architecture.tsx`, `help-sfield.tsx`).
- **`packages/contracts/`** — Shared Zod schemas & TypeScript contracts (`capabilities-catalog.ts`, `trading.ts`, `approval.ts`, `connector.ts`, `action-flow.ts`, `domain-packs.ts`, `ui-layout.ts`, `data-bindings.ts`, `recommendation-provider.ts`).
- **`packages/experience/`** — Host verifiers (`verify.ts`), deterministic A2UI v1.0 compiler (`compile.ts`), UI Builder layout applicator (`ui-layout.ts`), and dynamic prompt compiler (`prompt-compiler.ts`).
- **`packages/recommendations/`** — Pluggable `RecommendationProvider` arbitrator and adapters (TS + CCRE, Customer 360 NBA, IT Ops Runbooks, Sales Deal Desk, External REST/MCP).
- **`packages/customer-profiles/`** — Live Customer 360 profile store, multi-namespace binding resolver, and single-source-of-truth equity ledger bridge.
- **`vendor/sfield/`** — Vendored `@sfield/core`, `@sfield/store-sqlite`, and `@sfield/testing` workspaces.
