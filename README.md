# CEP — Customer Engagement Platform

## Expanding Treatment Selector from Content Recommendations to Actions and Workflows

Treatment Selector (TS) already uses a member ID, a topic, and CCRE rules to return ranked content IDs. This proof of concept lets domain teams use those rules to recommend a standalone action or a versioned workflow. In chat, `sfield` uses the conversation and a language model to identify intent, then asks TS what the customer is eligible for. The app presents the choices using A2UI. When the customer selects a workflow, `sfield` runs its tools.

When Marcus Reed asks **“What’s next?”**, TS recommends **Preview funding** because his account is unfunded. Once the mock account portal confirms his first deposit, the same rule excludes the funding reminder at his next sign-in. Logs show the rule, the account status it evaluated, and the portal confirmation. [Follow the customer interaction map](http://127.0.0.1:4174/admin/help#interactions) or [inspect the TS rule examples](http://127.0.0.1:4174/admin/help#proposal).

**What to prove next.** Can a second domain team connect an existing rule, an approved workflow, and the event that confirms completion entirely through configuration? For Alice’s beneficiary review, the retirement account service would confirm the update for one IRA. Reopening the chat would show that IRA’s review as complete while TS still evaluates her other accounts independently. The team should be able to deliver this with its existing UI and without editing chat code or copying eligibility rules into model prompts.

> Follow the five-minute [investment customer walkthrough](./DEMO_SCRIPT.md), also available in Help at `/admin/help#demo-playbook`.

---

## Platform Highlights

| Pillar | Capabilities Included |
| :--- | :--- |
| **Chat flow selection** | In **Tool setup → Chat routing flows**, choose tenant defaults and domain overrides for the registered flows. Each turn uses the enabled flows available to its audience. In **Logs → Flows in the model request**, inspect the ordered list and the recorded request and response. |
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

### 1. Run with GitHub Copilot ACP (default)

Sign in with Copilot CLI (`copilot login`), then start CEP. The app and chat harness use Copilot ACP with automatic model selection when no provider or office gateway URL is configured.

```sh
PZN_PORT=4180 npm run dev
```

Open **[http://127.0.0.1:4180/](http://127.0.0.1:4180/)** for Customer Chat and **[http://127.0.0.1:4180/admin/help](http://127.0.0.1:4180/admin/help)** for interactive Architecture Docs.

### 2. Run with Direct OpenAI API
Set `OPENAI_API_KEY` (or put it in ignored `.env.openai`):

```sh
npm run build
npm run start:openai
```

Opens on port `4175` with `gpt-4.1-mini` (override via `OPENAI_MODEL`).

### 3. Run the local app on port 4174

After signing in to Copilot CLI, run:

```sh
npm run build
npm run preview
```

Open [chat](http://127.0.0.1:4174/) or [admin Logs](http://127.0.0.1:4174/admin/logs). Chat and the command-line harness use the configured provider. For a local presentation, `PZN_OPERATOR_AUTH=off` opens the admin pages directly. The preview keeps chats and logs in `.pzn-data/preview` between restarts. Set `PZN_DATA_DIR` to use an existing data directory.

### 4. Run with an Enterprise Gateway
Copy `.env.example` to `.env` and set `LLM_PROVIDER=gateway`, `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY` (or custom headers via `LLM_GATEWAY_HEADERS_JSON` and body fields via `LLM_GATEWAY_BODY_JSON`), then run `npm start`.

An existing `.env` with an office `LLM_BASE_URL` also selects that gateway. Set `LLM_PROVIDER=copilot_acp` to select Copilot explicitly.

---

### Model gateway (sfield)

**Administration → Model gateway** (`/admin/gateway`) selects the provider the app uses to choose a flow and sfield uses to infer intent and compose the reply. It supports GitHub Copilot (ACP), the OpenAI API, and an OpenAI-compatible office gateway with custom headers, body fields and model limits.

1. **Test connection** checks the settings with the same rules as the environment variables, runs sfield's context-capacity check for the router and composer prompts, and makes a real model call that must return JSON.
2. **Activate** is enabled only after a passing test of exactly those settings (within 30 minutes). It saves the configuration to `llm-gateway.json` in the data directory (mode 600; a stored key is never sent back to the browser) and restarts the app in place so sfield re-binds the model. Pending approvals resume after the restart.
3. A saved configuration takes priority on startup. **Use startup settings** clears it and restores the provider selected at launch, which defaults to Copilot ACP. The app also uses this provider if it cannot load a saved configuration.

### Try a retirement account review

An investment customer can ask which retirement accounts they hold, point to the second one in chat, and see its beneficiary. The account service supplies the record and TS checks which follow-up applies.

Sign in as **Alice Morgan** and select **Retirement accounts** in the chat sidebar. Her workplace 401(k) appears first and her rollover IRA second. Ask **“Who’s the beneficiary on the second one?”** The account record shows that her IRA ending in **6105** has no designation. Treatment Selector evaluates the rule for that MID and account, and returns **Update your beneficiaries**. Ask about the workplace plan to see Jamie Morgan on file.

Try the same questions as **Jordan Lee**. His second account is a Roth IRA ending in **9281**, with Casey Lee on file. In **Administration → Logs**, open the follow-up turn to see the router’s recent chat context, the retirement account read, and Treatment Selector’s request, returned IDs and rule outcome.

### Tenants, domains and shared designs

A tenant is one organization running the app. Inside it, a user can belong to more than one domain. Wealth, IT Operations and Sales each have a design library at `/admin/ui?view=library`. A domain owner can publish from **Administration → UI Builder** at `/admin/ui`. Choose the domain, attach the design to an intent or capability, and select **Publish**. **Design library** shows the published revision. Another owner with access can choose **Use as template**, select a domain they own and attach the copy to its own intent.

| Scope | What belongs there |
| --- | --- |
| Tenant | The app process, model configuration and data directory |
| Domain | Published layouts, attached intents, widgets and published tool settings, including Treatment Selector rules and the funding workflow |
| User | The customer profile in Wealth or the signed-in operator in IT and Sales |
| Thread | sfield keeps messages, displayed record IDs and their order for the user and domain. A signed-in user can reopen the thread in another browser. |

When Alice and Jordan compare balances, both can receive the same Wealth design. A turn records the published revision and uses the readings from that turn to fill its cards. For example, the cash figure in a custom widget and in the portfolio summary comes from the same portfolio snapshot.

In UI Builder, **Layout preview** shows a sample for the current attachment. Expand **Try a chat turn**, enter a customer message and run it to see the actual reply and whether the draft applied. The chat uses the configured model and published domain rules. In IT Operations and Sales you can attach different layouts to a record list, detail or timeline. **Create a named intent** attaches your own phrases to one of those views. New record sources and operations still need a registered implementation.

In Tool setup, **Save settings** publishes to the domain. **Open draft in chat** uses the current settings in a private admin chat. Use **Load private draft** to recover different settings from this browser, including settings saved before domain publishing was introduced. Existing sessions see a publication on their next turn.

Set `PZN_TENANT_ID` on the server. A named tenant stores its files under `PZN_DATA_DIR/tenants/<tenant-id>`. Use a separate process and port per tenant. The default `pzn-local` tenant keeps the existing installation path. On upgrade, an original browser session can reclaim its older drafts by saving them under a signed-in owner. If legacy publications overlap, the most recently updated layout keeps the attachment and the others remain drafts.

Set these variables alongside your operator credentials to limit access by domain. Omitted domains are closed when the membership map is present. Operators listed in `PZN_TENANT_ADMINS_JSON` can manage tenant-wide settings and all domain libraries.

```dotenv
PZN_TENANT_ID=north
PZN_DOMAIN_MEMBERSHIPS_JSON='{"wealth":{"owners":["wealth-owner"],"users":["demo-learner","demo-returning"]},"it_ops":{"owners":["ops-owner"],"users":["oncall"]}}'
PZN_TENANT_ADMINS_JSON='["platform-admin"]'
```

Without a membership map, the local app retains open profile selection and existing operator access. With memberships configured, the Wealth profile picker binds one selected customer to the server session. Switching profiles changes the account and threads that session can access. The picker simulates customer sign-in. A customer deployment needs a verified identity from its sign-in system mapped to a tenant, domain and user before opening a chat.

### Operator sign-in

Customer chat opens at `/`. With operator sign-in enabled, the admin, integration, sales and operations workspaces prompt for an operator account. On first start the server saves the local operator username and generated password in `operator-credentials.json` inside the active data directory. For Copilot on port 4180 the default path is `.pzn-data/copilot/operator-credentials.json`. To use separate identities for approvals, set `PZN_OPERATORS_JSON` to a JSON object mapping two or more usernames to passwords of at least 12 characters each. Customer sign-in uses the local profile picker.

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
| `/admin/help` | **Architecture & Playbook**: a clickable diagram from tenant and domain flow selection through intent, recommendations and A2UI delivery, **`sfield` Runtime Architecture**, downloadable contracts, and **5-Minute Demo Playbook**. |

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
