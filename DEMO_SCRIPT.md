# CEP — 5-Minute Executive Demo Script

**Live URL:** `http://127.0.0.1:4180/` (running with `LLM_PROVIDER=copilot_acp PZN_PORT=4180 npm run dev`)  
**Brand:** **CEP (Customer Engagement Platform)** · Built on `sfield` + A2UI v1.0 + Copilot ACP

---

## Pre-Flight Check (15 seconds before presenting)
1. Confirm the server is live at `http://127.0.0.1:4180/` and signed in as **Alice Morgan** (Wealth Advisory domain pack).
2. Optional: toggle **Light / Dark mode** from the header to show full enterprise design-system polish.
3. Keep two browser tabs open:
   - Tab 1: **Customer Chat** (`http://127.0.0.1:4180/`)
   - Tab 2: **Admin & Architecture** (`http://127.0.0.1:4180/admin/help`)

---

## Beat 1 · Governed Advisory & Unified Semantic Routing (`0:00 – 0:50`)

**Goal:** Show that the LLM *never* hallucinates account figures, eligibility, or raw HTML — and that natural paraphrases route semantically instead of breaking on rigid keywords.

1. In Chat (as **Alice Morgan**), ask:
   > `Show my portfolio summary`
   - **Point out:** The verified **Portfolio Snapshot** (`Total value`, `Invested`, `Cash`) + eligible `#1 Next Best Action` (**Explore investing options**).
   - In admin test chat (`/admin/chat`), repeat the question and expand **Advisory Reasoning** → show **1. Customer 360 Lookup**, **2. Unified Capability Router**, **3. Recommendation Arbitration (`cep.recommendations.arbitrate@1.0.0`)**, and **Host Verification**.
2. Now ask a natural paraphrase that doesn't match any static keyword:
   > `whats in my equity book right now?`
   - **Point out:** The **Unified Semantic Capability Router** (`Semantic LLM` badge in admin test chat) routes directly to **Live Stock Holdings & Tax-Lot Positions**, displaying all 6 tickers (`AAPL`, `MSFT`, `NVDA`, `INTC`, `BA`, `PFE`), cost basis, live prices, unrealized P/L, and **`(TLH)`** tax-loss harvesting tags — summing **penny-for-penny** with `Portfolio snapshot` (single source of truth).

**Executive soundbite:**  
*"The LLM proposes intent and structure, never raw HTML and never unverified numbers. Every figure comes from scoped `sfield` reads and a single holdings ledger."*

---

## Beat 2 · Conversational Stock Trading, Tax-Loss Harvesting & Timed SSE Job (`0:50 – 2:10`)

**Goal:** Demonstrate a multi-step transactional workflow driven conversationally OR interactively — with live tax-loss math, real-time SSE job streaming, and governed write-back.

1. In Chat, ask:
   > `I want to sell 40% of my Apple shares`
   - **Point out:** Existing `AAPL` position, pre-calculated `40%` share count, quick percentage chips, and the prompt asking whether to run **Tax-Loss Harvesting Analysis**.
2. **Type directly in Chat** (no button click needed):
   > `yes`
   - **Point out:** Conversational continuation automatically opens the **Tax-Loss Harvesting Analysis** card — showing the realized `AAPL` capital gain, estimated tax before/after, **exact recommended loss-offset trades (`INTC`, `BA`)** with editable quantities, and the **30-day IRS Wash-Sale guardrail**.
3. Click **`Execute bundle`** (or type `execute bundle` in Chat):
   - **Point out:**
     - If the bundle exceeds the **$10,000 compliance threshold**, it pauses at an inline **High-Value Trade HITL Compliance Gate** (`sha256` digest bound) — click **`Approve & launch trade job`**.
     - Watch the **5-second Live SSE Countdown Timer** (`queued → validating → routing → executing → settling → completed`) with a live **`Cancel order`** button available mid-flight.
     - Once settled, point out the **Before → After Cash & Equities Diff**, **Fill Receipt**, **`sfield` Run ID + Audit ID**, and the **live sidebar cash balance updating automatically** with zero page reload.

**Executive soundbite:**  
*"Users can tap cards or just reply 'yes' and 'execute bundle' in plain English. Settlement runs as a durable, cancellable SSE job backed by a 30-day wash-sale ledger and `sfield` write governance."*

---

## Beat 3 · Multi-Domain Reuse: IT Ops, RevOps & No-Code Action Flows (`2:10 – 3:25`)

**Goal:** Prove CEP is a horizontal engagement platform — not a hard-coded wealth app.

1. In the left sidebar, switch Domain Pack from **Wealth** → **IT Ops**.
   - **Point out:** The live **P1 Incident HUD** (`INC-4821 · payments-api`), IT Ops quick prompts, and domain guardrails switch instantly.
2. In Chat, type a trigger phrase for an **admin-authored No-Code Action Flow**:
   > `escalate to pagerduty`
   - **Point out:** CEP matches the No-Code Action Flow (`P1 PagerDuty Escalation Flow`) bound to **`cep.connector.invoke@1.0.0`** (external REST/MCP connector) and renders a **SHA-256 digest-bound HITL Approval Card** right inside Chat.
   - Click **`Approve & run flow`** → executes the sandbox webhook through `sfield`, returning HTTP `200`, `sfieldRunId`, and immutable Write Audit ID.
3. Switch to Tab 2 → open **`/admin/logs?source=approvals`** and **`/admin/logs?source=write_audit`**:
   - **Point out:**
     - The **Human-in-the-Loop Approval Queue** is 100% synchronized with Chat, with live policy switches including **Require separate approver (4-eyes dual control)** and **Gate high-value trades (>$10k)**.
     - **Write Audit (sfield)** displays every settled trade, IT Ops rollback, RevOps discount approval, and external connector invocation with linked `approvalId` and `sfieldRunId`.

**Executive soundbite:**  
*"Chat itself is an approval surface synchronized with `/admin/logs`. Every mutation — internal or external webhook — passes through `sfield` with SHA-256 payload digests and immutable audit trails."*

---

## Beat 4 · No-Code Admin Control Plane (`3:25 – 4:25`)

**Goal:** Show business & platform teams can configure intents, rules, UI layouts, and external connectors without code deploys.

1. Open **`/admin/intents`** → click the **`Action Flows (No-Code)`** tab:
   - Show how admins bind **Trigger Phrases → Domain → External Connector (`cep.connector.invoke@1.0.0`) → Approval Policy (`Inline` / `4-Eyes` / `Auto`)** live.
2. Open **`/admin/ui`** (**UI Builder**):
   - Click **`IT Ops · P1 Incident Card`** → live preview hydrates `INC-4821` from `incidents.json`.
   - Click **`Sales RevOps · Deal Desk Card`** → live preview hydrates `DEAL-904 · Acme Cloud Corp` from `deals.json`.
3. Open **`/admin`** (**Tool Setup & External Connectors**):
   - Show **Recommendation Providers (`cep.recommendations.arbitrate@1.0.0`)** and the **External REST & MCP Connector Registry** with `Test connection` and `Invoke via sfield`.

**Executive soundbite:**  
*"Admins author intents, CCRE eligibility rules, multi-domain A2UI cards, external REST/MCP connectors, and HITL action flows from one control plane — live with zero redeploys."*

---

## Beat 5 · Under the Hood: 14-Step Architecture & `sfield` Governance (`4:25 – 5:00`)

1. Open **`/admin/help#architecture`**:
   - Show the **14-Step Interactive Sequence Diagram** — click **Step 12 (`Form UI: compile A2UI v1.0, UI Builder layouts & live bindings`)** to inspect the exact separation between the LLM's JSON-only proposal (Step 11), deterministic host A2UI compilation (Step 12), and SSE delivery to React (Step 13).
2. Scroll briefly to **`/admin/help#sfield`**:
   - Highlight the 3 execution lanes (`LLM Agents: read_only` → `Host Arbitration: read_only` → `Host Governed Writes & External Connectors: bounded_auto + HITL gate`) and the drop-in path from local SQLite (`durable_single`) to production Postgres (`service` mode).

**Closing line:**  
*"CEP gives enterprises the conversational speed of LLMs with the determinism, auditability, and multi-domain reusability required for regulated production."*
