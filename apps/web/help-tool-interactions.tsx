import { useId, useRef, useState } from "react";
import {
  ArrowLeft, ArrowRight, Braces, CheckCircle2, Cpu, Database, Download, Filter,
  Layers, Lock, Server, ShieldCheck, Sparkles, Wrench,
} from "lucide-react";
import "./help-tool-interactions.css";

type ModeId = "intent" | "experience" | "funding" | "harness";
type NodeId = "host" | "allowlist" | "narrow" | "llm" | "proposal" | "registry" | "gate" | "executor" | "systems";
type Selection = { kind: "step"; index: number } | { kind: "node"; id: NodeId };

type ModeSpec = {
  id: ModeId;
  label: string;
  shortLabel: string;
  headline: string;
  summary: string;
  llmBadge: string;
  llmToolsList: string[];
  hiddenFromLlm: string[];
  policyPreset: string;
  requestToolsJson: string;
  codeRefs: string[];
  nodeCopy: Record<NodeId, { subtitle: string[]; detail: string; serverSide: string }>;
  steps: {
    number: number;
    title: string;
    wireLabel: string;
    from: NodeId;
    to: NodeId;
    whatHappens: string;
    llmSees: string;
    enforcement: string;
  }[];
};

const MODES: Record<ModeId, ModeSpec> = {
  intent: {
    id: "intent",
    label: "Intent routing (Chat)",
    shortLabel: "Intent routing",
    headline: "LLM classifies intent with 0 tools; CEP + sfield run the matching read tools deterministically.",
    summary: "For standard chat turns, context-router receives tools: [] and only picks an intent/context from the catalog. CEP then invokes Treatment Selector and domain read tools through sfield — the LLM never sees the full tool registry.",
    llmBadge: "0 tools (router) · max 1 (composer)",
    llmToolsList: ["context-router: [] (none)", "experience-composer: balances_read (max 1 call)"],
    hiddenFromLlm: ["Treatment Selector / CCRE", "portfolio_read · goal_read · retirement_accounts", "int.* integration tasks", "cep.domain.execute_write (DENY)"],
    policyPreset: "read_only",
    requestToolsJson: `{
  "agentId": "context-router",
  "policy": { "preset": "read_only" },
  "tools": [],
  "output": { "schema": "routingOutputSchema", "verifier": "contextSelection" }
}`,
    codeRefs: [
      "apps/server/runtime.ts · runtimeConfig() (tools: [])",
      "vendor/sfield/packages/core/src/runtime/runtime.ts · modelTurn()",
      "apps/server/runtime.ts · authorizer (blocks agent writes)",
    ],
    nodeCopy: {
      host: {
        subtitle: ["Selects chat flow &", "loads recent transcript"],
        detail: "Accepts the customer message, resolves allowed flows for tenant + domain, and hands the account-help stage to sfield.",
        serverSide: "Tenant, principal, MID, and active domain pack stay bound in server memory and app.sqlite.",
      },
      allowlist: {
        subtitle: ["context-router: []", "composer: [balances]"],
        detail: "sfield binds only the agent's declared tool allowlist (ctx.exposed) into buildContext(). The rest of the global registry is excluded before prompting.",
        serverSide: "30+ registered domain, TS, MCP, and write tools are never attached to context-router.",
      },
      narrow: {
        subtitle: ["Narrow-only hook +", "PII egress firewall"],
        detail: "beforeModelDispatch verifies no hook can add tools (throws ACCESS_DENIED if attempted) and scrubs PII tokens before the model call.",
        serverSide: "Redaction token map stays server-side in Runtime so responses rehydrate locally.",
      },
      llm: {
        subtitle: ["Sees: intent catalog", "Tools: [] (zero tools)"],
        detail: "The model focuses purely on classifying user intent/context (or composing from already-fetched records) — zero schema bloat and zero tool hallucination.",
        serverSide: "No credentials, no MID lookups, and no write schemas ever cross the provider boundary.",
      },
      proposal: {
        subtitle: ["Structured JSON +", "Verifier gate"],
        detail: "Output must match closed JSON Schema and pass host Verifier (contextSelection / experience) before CEP trusts the intent.",
        serverSide: "Invalid or invented intent IDs are rejected or repaired within max_repairs: 1.",
      },
      registry: {
        subtitle: ["Domain reads · TS/CCRE", "Meta · int.* · Writes"],
        detail: "All tools live inside SField.create({ tools }) with closed Ajv schemas, effect tags (read/write/destructive), and versioned refs.",
        serverSide: "Only sfield can dispatch a tool ref; the registry itself is never serialized to the LLM.",
      },
      gate: {
        subtitle: ["Authorizer + prepareTool", "read_only vs host scope"],
        detail: "CEP host calls the tools required by the verified intent. sfield's Authorizer validates Principal, tenant, role, and read effect; prepareTool injects scoped turnRef.",
        serverSide: "Deterministic evidenceId digest binds every invocation to the authenticated session.",
      },
      executor: {
        subtitle: ["Runs TS, Portfolio,", "Goal & Account reads"],
        detail: "Executes only the exact tools that satisfy the verified intent (e.g. Treatment Selector eligibility + portfolio snapshot or retirement accounts).",
        serverSide: "Strict timeout, maxOutputBytes, and budget ceilings enforced per call.",
      },
      systems: {
        subtitle: ["TS/CCRE · Customer 360", "sfield.sqlite audit log"],
        detail: "Reads live domain snapshots and appends immutable tool_call + model_attempt records to sfield.sqlite.",
        serverSide: "Every turn produces an inspectable sfieldRunId and trace in Admin Logs.",
      },
    },
    steps: [
      {
        number: 1,
        title: "Open scoped sfield run",
        wireLabel: "Agent\nrun",
        from: "host",
        to: "allowlist",
        whatHappens: "CEP Turn Controller starts the context-router agent inside sfield with the authenticated Principal and domain scope.",
        llmSees: "Nothing yet — sfield is assembling the context packet and checking agent.tools.",
        enforcement: "apps/server/runtime.ts · runtimeConfig(): context-router declares tools: [] and policy: read_only.",
      },
      {
        number: 2,
        title: "Apply agent allowlist & hooks",
        wireLabel: "Scoped\nexposed",
        from: "allowlist",
        to: "narrow",
        whatHappens: "sfield passes only ctx.exposed (empty for router, balances only for composer) through beforeModelDispatch and the PII Firewall.",
        llmSees: "Full tool registry stays behind the sfield boundary — zero write, TS, or integration schemas pass through.",
        enforcement: "vendor/sfield/packages/core/src/runtime/runtime.ts · beforeModelDispatch rejects any hook attempting to add tools (ACCESS_DENIED).",
      },
      {
        number: 3,
        title: "Dispatch narrowed prompt to LLM",
        wireLabel: "Prompt\n(0 tools)",
        from: "narrow",
        to: "llm",
        whatHappens: "The LLM receives the user message, conversation summary/history, and the allowed intent catalog — with tools: [].",
        llmSees: "Intent catalog + scrubbed prompt text. No tool registry, no write tools, no internal IDs.",
        enforcement: "Closed JSON Schema output contract (routingOutputSchema) + max_model_calls: 2 budget.",
      },
      {
        number: 4,
        title: "Verify intent proposal",
        wireLabel: "Verified intent proposal",
        from: "proposal",
        to: "gate",
        whatHappens: "The LLM returns the inferred intent ID (or clarification). sfield's contextSelection verifier validates it before CEP maps the intent to data tools.",
        llmSees: "LLM's job for routing is complete; CEP now decides which server tools satisfy that verified intent.",
        enforcement: "apps/server/runtime.ts · verifiers.contextSelection validates intent eligibility & catalog scope.",
      },
      {
        number: 5,
        title: "Authorize & prepare scoped tool call",
        wireLabel: "Auth &\nprepare",
        from: "gate",
        to: "executor",
        whatHappens: "CEP requests the exact read tools needed for the verified intent (e.g. TS eligibility + portfolio/goal read). Authorizer verifies Principal and read effect.",
        llmSees: "Not involved — parameters like member ID (MID) and turnRef are injected host-side.",
        enforcement: "apps/server/runtime.ts · authorizer checks tenantId, pzn-demo role, and readAllowed.",
      },
      {
        number: 6,
        title: "Execute read & record audit trail",
        wireLabel: "Read &\naudit",
        from: "executor",
        to: "systems",
        whatHappens: "Scoped adapters query Treatment Selector / CCRE and live customer stores, returning typed records to compile the A2UI card.",
        llmSees: "Only verified, scoped fields are passed if Experience Composer summarizes them.",
        enforcement: "Every call is validated against closed output schemas and logged to sfield.sqlite.",
      },
    ],
  },

  experience: {
    id: "experience",
    label: "Goal planning (experience-agent)",
    shortLabel: "Goal planning",
    headline: "LLM uses progressive meta-tools (discover → describe → plan) instead of seeing raw business tools.",
    summary: "For multi-step goals, ExperienceAgent never dumps the business tool registry into the prompt. Turn 1 exposes only discover; once capabilities are discovered, beforeModelDispatch unlocks describe and plan — and CEP executes the underlying sfield tools.",
    llmBadge: "1 → 3 meta-tools (+ ask_user)",
    llmToolsList: [
      "Turn 1: axe.discover@1.0.0 only",
      "Turn 2+: + axe.describe, + axe.plan",
      "If input missing: + ask_user",
    ],
    hiddenFromLlm: ["All raw business read tools", "Account IDs & financial values", "int.* integration tasks", "Write & approval tools"],
    policyPreset: "read_only",
    requestToolsJson: `{
  "agentId": "experience-agent",
  "turn1_tools": ["axe.discover@1.0.0"],
  "turn2_tools": ["axe.discover@1.0.0", "axe.describe@1.0.0", "axe.plan@1.0.0"],
  "note": "Raw business tools are executed server-side by AgenticExecution inside axe.plan"
}`,
    codeRefs: [
      "apps/server/experience-agent.ts · narrow() (progressive tool unlock)",
      "apps/server/experience-agent.ts · tools() (discover / describe / plan)",
      "apps/server/agentic-execution.ts · executes underlying sfield tools",
    ],
    nodeCopy: {
      host: {
        subtitle: ["Detects multi-step goal", "via CapabilityRegistry"],
        detail: "ExperienceAgent.shouldHandle() matches multi-step goals, resumes active journeys, or routes newly published capabilities.",
        serverSide: "Journey state and decision_trace_events persist per conversation in app.sqlite.",
      },
      allowlist: {
        subtitle: ["Meta-tools only:", "discover · describe · plan"],
        detail: "Even at the agent config level, experience-agent is only bound to the 3 capability meta-tools plus ask_user — never raw business tools.",
        serverSide: "New capabilities published in Studio become discoverable dynamically without editing agent.tools.",
      },
      narrow: {
        subtitle: ["ExperienceAgent.narrow()", "Progressive unlock"],
        detail: "beforeModelDispatch checks decision_trace_events: Turn 1 allows ONLY discover; describe + plan unlock only after capabilities are discovered; ask_user unlocks only when methodId is missing.",
        serverSide: "Enforces combined native + business toolCalls budget before dispatching to LLM.",
      },
      llm: {
        subtitle: ["Calls discover → plan", "Zero raw business tools"],
        detail: "The model queries capabilities by user goal, inspects schemas if needed, and proposes an ordered plan using exact discovered capabilityId@version.",
        serverSide: "Prompt forbids financial values or account IDs inside plan arguments.",
      },
      proposal: {
        subtitle: ["Plan of capability IDs", "+ version lock"],
        detail: "axe.plan rejects any capability version that was not returned by discover in the same run (CAPABILITY_NOT_DISCOVERED).",
        serverSide: "Prevents the LLM from inventing or guessing tool refs.",
      },
      registry: {
        subtitle: ["Capability manifests +", "underlying sfield tools"],
        detail: "CapabilityRegistry maps published manifests (keywords, prerequisites, outputs) to real sfield business tools.",
        serverSide: "Manifest prerequisites and dependency graphs are enforced deterministically in code.",
      },
      gate: {
        subtitle: ["Validates plan graph", "& injects host scope"],
        detail: "AgenticExecution validates dependency order, checks Treatment Selector eligibility, and runs each underlying sfield tool through Authorizer.",
        serverSide: "prepareTool locks ask_user to verified fundingChoiceQuestion when input is needed.",
      },
      executor: {
        subtitle: ["AgenticExecution runs", "independent & dependent"],
        detail: "Executes independent reads in parallel and dependent steps sequentially within goalBudget, recording every step result on the Journey.",
        serverSide: "Returns only a compact status projection (stepId, status, missing) back to the LLM.",
      },
      systems: {
        subtitle: ["TS · Portfolio · Goals", "Journeys & Audit Trace"],
        detail: "Persists journey checkpoints, capability discovery traces, and sfield tool call receipts.",
        serverSide: "Compiles verified results directly into an A2UI surface — LLM never fabricates figures.",
      },
    },
    steps: [
      {
        number: 1,
        title: "Match multi-step goal",
        wireLabel: "Goal\njourney",
        from: "host",
        to: "allowlist",
        whatHappens: "ExperienceAgent.shouldHandle() detects a multi-step goal or published capability and opens an experience-agent run.",
        llmSees: "Not called yet; agent.tools contains only meta-tools (discover, describe, plan, ask_user).",
        enforcement: "apps/server/experience-agent.ts · shouldHandle() & boundTurn() verify tenant + principal.",
      },
      {
        number: 2,
        title: "Progressively narrow meta-tools",
        wireLabel: "Turn-gated\nnarrow",
        from: "allowlist",
        to: "narrow",
        whatHappens: "beforeModelDispatch calls ExperienceAgent.narrow(): Turn 1 exposes ONLY discover; describe and plan unlock only after discovery succeeds.",
        llmSees: "Turn 1: [discover]. Turn 2: [discover, describe, plan]. Missing input: [+ ask_user].",
        enforcement: "apps/server/experience-agent.ts · narrow() + sfield narrow-only invariant.",
      },
      {
        number: 3,
        title: "LLM discovers & proposes plan",
        wireLabel: "Meta-tool\ncalls",
        from: "narrow",
        to: "llm",
        whatHappens: "The LLM searches capabilities by goal text, optionally reads a capability's contract via describe, and submits a capability plan.",
        llmSees: "Only the discovered capability summaries and schemas — never the entire global tool registry.",
        enforcement: "axe.plan rejects undiscovered or invented capability versions.",
      },
      {
        number: 4,
        title: "Submit capability plan to runtime",
        wireLabel: "Capability plan",
        from: "proposal",
        to: "gate",
        whatHappens: "sfield routes the axe.plan tool call back into the host's AgenticExecution planner.",
        llmSees: "Waits for a compact projection of verified step outcomes.",
        enforcement: "Plan & manifest validation rejects forged dependencies or missing prerequisites.",
      },
      {
        number: 5,
        title: "Authorize underlying sfield tools",
        wireLabel: "Scoped\nreads",
        from: "gate",
        to: "executor",
        whatHappens: "AgenticExecution resolves each planned capability to its registered sfield tool ref and checks Authorizer + Treatment Selector eligibility.",
        llmSees: "Underlying business tool refs and member IDs stay completely inside the server.",
        enforcement: "Every underlying business tool still passes sfield Authorizer + Ajv schema validation.",
      },
      {
        number: 6,
        title: "Run business tools & persist journey",
        wireLabel: "Execute\n& trace",
        from: "executor",
        to: "systems",
        whatHappens: "Verified reads execute against live providers; results save to the Journey and compile into the interactive A2UI experience.",
        llmSees: "Receives only the sanitized step status projection (no raw credentials or forged numbers).",
        enforcement: "Full decision_trace_events + sfield.sqlite audit trail.",
      },
    ],
  },

  funding: {
    id: "funding",
    label: "Guided workflow (funding-agent)",
    shortLabel: "Guided workflow",
    headline: "State-machine narrowing exposes only the 1–2 legal next tools at each workflow step.",
    summary: "Inside FundingAgent, beforeModelDispatch inspects completed CallRecords from sfield.sqlite and hides every tool that isn't legal yet — forcing strict status → options → preview (or ask_user) ordering.",
    llmBadge: "1–2 state-gated tools per turn",
    llmToolsList: [
      "Step 1: [funding_status_read]",
      "Step 2: [funding_options_read]",
      "Step 3: [funding_preview_build, ask_user]",
    ],
    hiddenFromLlm: ["Out-of-order workflow steps", "turnRef & session scope (host-injected)", "Other domain tools", "All write tools"],
    policyPreset: "read_only",
    requestToolsJson: `{
  "agentId": "funding-agent",
  "beforeModelDispatch": "FundingAgent.narrow(request, runId)",
  "step1_exposed": ["funding_status_read@1.0.0"],
  "step2_exposed": ["funding_options_read@1.0.0"],
  "step3_exposed": ["funding_preview_build@1.0.0", "ask_user"]
}`,
    codeRefs: [
      "apps/server/funding-agent.ts · available() & narrow()",
      "apps/server/funding-agent.ts · prepare() (injects turnRef)",
      "apps/server/funding-agent.ts · verify() (evidence gate)",
    ],
    nodeCopy: {
      host: {
        subtitle: ["Starts or resumes", "funding workflow run"],
        detail: "Triggered when a customer clicks Preview funding or answers a funding method question; binds the run to the original TS recommendation.",
        serverSide: "Verifies recommendation version and workflow mode from Tool Setup.",
      },
      allowlist: {
        subtitle: ["3 funding tools +", "ask_user"],
        detail: "funding-agent declares only fundingStatus, fundingOptions, fundingPreview, and ask_user in runtimeConfig.",
        serverSide: "All other domain, integration, and write tools are completely absent.",
      },
      narrow: {
        subtitle: ["FundingAgent.narrow()", "State-machine gate"],
        detail: "Reads prior succeeded CallRecords from sfield.sqlite: hides options until status is unfunded, hides preview until options are read, and swaps in clean LLM-facing schemas.",
        serverSide: "LLM cannot skip prerequisites or call two tools in the same batch.",
      },
      llm: {
        subtitle: ["Sees 1–2 legal tools", "No internal turnRef"],
        detail: "Decides whether to call the single next read tool, ask the user which method they want via ask_user, or build the preview for a named method.",
        serverSide: "Stripped inputSchema hides turnRef so prompt injection cannot target another turn.",
      },
      proposal: {
        subtitle: ["Outcome verified", "against CallRecords"],
        detail: "verifiers.fundingPreview checks that a claimed preview outcome actually has a succeeded funding_preview_build record with the exact methodId.",
        serverSide: "Prevents fabricated funding previews or skipped eligibility checks.",
      },
      registry: {
        subtitle: ["Funding adapters +", "global tool catalog"],
        detail: "Registered funding tools live in sfield alongside all other tools, governed by closed schemas and Tool Setup toggles.",
        serverSide: "Disabled tools in Tool Setup are automatically removed by available().",
      },
      gate: {
        subtitle: ["prepareTool injects", "verified turnRef"],
        detail: "FundingAgent.prepare() re-checks batch size === 1, confirms the tool is legal for current evidence, and injects the server-verified turnRef.",
        serverSide: "Re-validates scope even if a run resumes after a server restart.",
      },
      executor: {
        subtitle: ["Durable sfield", "step execution"],
        detail: "Executes status check, options read, or preview builder; pauses cleanly on ask_user and checkpoints state to SQLite.",
        serverSide: "Crash-safe resume via durable_single checkpoints and idempotency keys.",
      },
      systems: {
        subtitle: ["Funding Portal state", "& sfield checkpoints"],
        detail: "Reads live funding status/methods and saves every tool attempt and waiting_input checkpoint.",
        serverSide: "Compiles the verified Funding Preview A2UI card from tool evidence.",
      },
    },
    steps: [
      {
        number: 1,
        title: "Bind workflow to TS recommendation",
        wireLabel: "Workflow\nrun",
        from: "host",
        to: "allowlist",
        whatHappens: "CEP opens or resumes the funding-agent run, bound to the earlier Treatment Selector recommendation and turn scope.",
        llmSees: "Nothing yet; agent.tools scopes the universe to 3 funding tools + ask_user.",
        enforcement: "apps/server/funding-agent.ts · scope() validates idempotency key, tenant, and deadline.",
      },
      {
        number: 2,
        title: "Compute legal tools from evidence",
        wireLabel: "State\nfilter",
        from: "allowlist",
        to: "narrow",
        whatHappens: "beforeModelDispatch inspects succeeded CallRecords in sfield.sqlite and narrows request.tools down to only the 1–2 legal next steps.",
        llmSees: "Step 1: status only. Step 2: options only. Step 3: preview + ask_user.",
        enforcement: "apps/server/funding-agent.ts · available() + narrow() strip internal turnRef from schemas.",
      },
      {
        number: 3,
        title: "Dispatch single-step choice to LLM",
        wireLabel: "1–2 legal\ntools",
        from: "narrow",
        to: "llm",
        whatHappens: "The LLM chooses the next tool or calls ask_user to clarify which funding method the customer prefers.",
        llmSees: "Only the legal tool(s) for the current state and prior verified tool outputs.",
        enforcement: "Strict fundingAgentToolLimit budget and read_only policy preset.",
      },
      {
        number: 4,
        title: "Validate tool call or final outcome",
        wireLabel: "Tool call / verified outcome",
        from: "proposal",
        to: "gate",
        whatHappens: "Tool calls enter prepareTool; final outcomes pass through verifiers.fundingPreview to verify evidence matches the claimed methodId.",
        llmSees: "Cannot claim 'preview' without a real succeeded preview tool call.",
        enforcement: "apps/server/funding-agent.ts · verify() checks evidenceFrom(calls).",
      },
      {
        number: 5,
        title: "Inject verified turnRef & authorize",
        wireLabel: "prepare\nTool",
        from: "gate",
        to: "executor",
        whatHappens: "prepareTool enforces single-tool batches, re-verifies legality, and injects the authenticated root turnRef before execution.",
        llmSees: "Cannot forge or overwrite turnRef or cross customer boundaries.",
        enforcement: "apps/server/funding-agent.ts · prepare() + sfield Authorizer.",
      },
      {
        number: 6,
        title: "Execute & checkpoint to SQLite",
        wireLabel: "Run &\ncheckpoint",
        from: "executor",
        to: "systems",
        whatHappens: "Runs the funding adapter and persists durable checkpoints so ask_user pauses survive restarts.",
        llmSees: "Next turn sees the verified tool result and unlocks the next workflow step.",
        enforcement: "Durable SQLite checkpoints + immutable audit log.",
      },
    ],
  },

  harness: {
    id: "harness",
    label: "Dynamic UI (sf.harness) & Host Writes",
    shortLabel: "sf.harness & Writes",
    headline: "sf.harness plans providers in code (0 raw tools to LLM), while writes run exclusively in host-owned bounded_auto scopes.",
    summary: "Dynamic Canvas requests run the 4-stage sfield AgenticHarness (Plan → Fetch → Compose → Verify/Repair) without exposing raw tool schemas. All mutations (trades, rollbacks, int.* writes) require host-owned execution (!agentId) and operator/customer approvals.",
    llmBadge: "0 raw tools · Host-only writes",
    llmToolsList: [
      "sf.harness: Plan (provider match) → Fetch (code) → Compose (UI JSON)",
      "Host Writes: !agentId · preset: bounded_auto · digest-bound approval",
    ],
    hiddenFromLlm: [
      "cep.domain.execute_write@1.0.0 (BLOCKED for agents)",
      "cep.connector.invoke@1.0.0 (BLOCKED for agents)",
      "int.* published write tasks (BLOCKED for agents)",
      "Approval decision & signing keys",
    ],
    policyPreset: "read_only (harness) / bounded_auto (host writes)",
    requestToolsJson: `{
  "harness": "sf.harness.run({ plan, fetch, compose, verify, repair })",
  "llm_tools_exposed": [],
  "host_write_authorizer": "effect === 'write' && !agentId && validApprovalDigest"
}`,
    codeRefs: [
      "vendor/sfield/packages/core/src/runtime/agentic-harness.ts · sf.harness",
      "apps/server/dynamic-ui-harness.ts · 4-stage Dynamic Canvas harness",
      "apps/server/runtime.ts · authorizer (writeAllowed requires !agentId)",
    ],
    nodeCopy: {
      host: {
        subtitle: ["Dynamic Canvas or", "Confirmed Write Action"],
        detail: "Either runs sf.harness for rich visual queries (charts/tables/comparisons) OR executes a human-confirmed write/approval action.",
        serverSide: "Explicitly separates autonomous LLM reads from human-confirmed state mutations.",
      },
      allowlist: {
        subtitle: ["Harness: 0 raw tools", "Writes: Host-only"],
        detail: "sf.harness never exposes raw tool schemas to the LLM. Write tools (cep.domain.execute_write, int.*) are omitted from every agent's allowlist.",
        serverSide: "Even if a prompt tries to invoke a write tool, no agent has a ref to call it.",
      },
      narrow: {
        subtitle: ["Stage 1 Plan / Clarify", "+ PII Firewall"],
        detail: "Stage 1 matches the request to allowed CEP data providers (or pauses with a clarifying question if ambiguous or unsupported). All LLM calls pass PII redaction.",
        serverSide: "Streams live Thinking stages (plan → fetch → compose → verify) over SSE.",
      },
      llm: {
        subtitle: ["Stage 3 Compose UI", "from grounded facts"],
        detail: "In Stage 3, the LLM only receives already-fetched grounded records and allowed visual primitives (metric, chart, piechart, table, list) to compose the layout.",
        serverSide: "Zero direct database/API access; cannot invent unconnected data sources.",
      },
      proposal: {
        subtitle: ["Stage 4 Verify/Repair", "Deterministic checks"],
        detail: "Checks schema validity, chart type match, and grounded numeric citations; triggers bounded auto-repair if anything drifts.",
        serverSide: "Persists full HarnessTrace into sfield audit storage.",
      },
      registry: {
        subtitle: ["Data Providers +", "Governed Write Tools"],
        detail: "Holds read data providers (portfolio, goals, retirement, ops, sales, thread status) plus governed write tools and published int.* integration tasks.",
        serverSide: "Write tools require explicit business resource binding (domain_record) + digest lock.",
      },
      gate: {
        subtitle: ["Authorizer: !agentId", "+ Approval Digest"],
        detail: "For writes, sfield Authorizer strictly requires !agentId (host-initiated only) and verifies digest-bound approval records before allowing execution.",
        serverSide: "Prevents replay, parameter tampering, or unapproved agent mutations.",
      },
      executor: {
        subtitle: ["Stage 2 Fetch OR", "Governed Write Run"],
        detail: "In sf.harness, Stage 2 fetches live data in code. For writes, executes inside a host-owned bounded_auto sfield run.",
        serverSide: "Runs with per-integration rate limiters, circuit breakers, and timeouts.",
      },
      systems: {
        subtitle: ["Live Stores, MCP/APIs", "& Immutable Write Audit"],
        detail: "Commits approved updates (trades, incident rollbacks, deal approvals, C360 changes) and logs immutable sfieldRunId + audit receipts.",
        serverSide: "Inspectable in Admin Logs → Write audit and OpenTelemetry traces.",
      },
    },
    steps: [
      {
        number: 1,
        title: "Enter sf.harness or host write flow",
        wireLabel: "Plan /\nAction",
        from: "host",
        to: "allowlist",
        whatHappens: "Visual/analytical prompts enter sf.harness; confirmed button/approval clicks enter a host-owned bounded_auto write scope.",
        llmSees: "Nothing yet; neither path sends the global tool registry to the LLM.",
        enforcement: "apps/server/runtime.ts · write tools are excluded from every agent's tools list.",
      },
      {
        number: 2,
        title: "Stage 1: Plan provider or clarify",
        wireLabel: "Plan /\nClarify",
        from: "allowlist",
        to: "narrow",
        whatHappens: "sf.harness matches the prompt to connected CEP providers. If unclear (e.g. 'as pie chart') it pauses with clickable clarification choices instead of guessing.",
        llmSees: "Only the allowed provider capability list — never raw tool schemas or write endpoints.",
        enforcement: "vendor/sfield/packages/core/src/runtime/agentic-harness.ts · needs_clarification stop.",
      },
      {
        number: 3,
        title: "Stage 3: Compose grounded UI (0 tools)",
        wireLabel: "Compose\n(0 tools)",
        from: "narrow",
        to: "llm",
        whatHappens: "After Stage 2 fetches verified records server-side, Stage 3 asks the LLM to compose a visual layout solely from those grounded facts.",
        llmSees: "Grounded JSON records + visual component catalog. tools: [].",
        enforcement: "PII egress firewall scrubs sensitive identifiers before the model call.",
      },
      {
        number: 4,
        title: "Stage 4: Verify & auto-repair output",
        wireLabel: "Verify & auto-repair",
        from: "proposal",
        to: "gate",
        whatHappens: "Deterministic verifier validates structure, requested chart type, and data grounding; runs bounded repair if a rule fails.",
        llmSees: "Only sees targeted verification error notes if repair is triggered.",
        enforcement: "sf.harness enforces maxRepairs and records every stage to sfield audit.",
      },
      {
        number: 5,
        title: "Host-only Authorizer & approval check",
        wireLabel: "!agentId\n+ digest",
        from: "gate",
        to: "executor",
        whatHappens: "For Stage 2 reads or confirmed writes: Authorizer enforces !agentId on all write/destructive effects and checks digest-bound approval receipts.",
        llmSees: "LLM cannot invoke write tools directly — even via prompt injection.",
        enforcement: "apps/server/runtime.ts · writeAllowed requires !agentId + digestJson evidenceId.",
      },
      {
        number: 6,
        title: "Fetch / commit & persist audit proof",
        wireLabel: "Execute\n& audit",
        from: "executor",
        to: "systems",
        whatHappens: "Reads return grounded data to Dynamic Canvas; approved writes commit to stores/connectors and append an immutable Write Audit entry.",
        llmSees: "Only the safe summary/status returned after server verification.",
        enforcement: "Immutable write-audit.json + sfield.sqlite run receipt + OTel span.",
      },
    ],
  },
};

type Box = { x: number; y: number; w: number; h: number };
const BOXES: Record<NodeId, Box> = {
  host: { x: 42, y: 66, w: 220, h: 112 },
  allowlist: { x: 322, y: 66, w: 224, h: 112 },
  narrow: { x: 606, y: 66, w: 222, h: 112 },
  llm: { x: 904, y: 66, w: 234, h: 150 },
  proposal: { x: 904, y: 244, w: 234, h: 94 },
  registry: { x: 42, y: 274, w: 248, h: 244 },
  gate: { x: 350, y: 294, w: 226, h: 204 },
  executor: { x: 630, y: 294, w: 198, h: 204 },
  systems: { x: 904, y: 418, w: 234, h: 100 },
};

const NODE_META: Record<NodeId, { title: string; Icon: typeof Server; tone: "default" | "kernel" | "llm" | "registry" | "systems" }> = {
  host: { title: "CEP Turn / Flow Host", Icon: Server, tone: "default" },
  allowlist: { title: "Per-Agent Allowlist", Icon: Filter, tone: "kernel" },
  narrow: { title: "beforeModelDispatch", Icon: ShieldCheck, tone: "kernel" },
  llm: { title: "LLM Provider", Icon: Sparkles, tone: "llm" },
  proposal: { title: "Output & Verifier Gate", Icon: CheckCircle2, tone: "llm" },
  registry: { title: "Global Tool Registry", Icon: Wrench, tone: "registry" },
  gate: { title: "Authorizer & prepareTool", Icon: Lock, tone: "kernel" },
  executor: { title: "Tool & Harness Runner", Icon: Cpu, tone: "default" },
  systems: { title: "Live Systems & Audit", Icon: Database, tone: "systems" },
};

const STEP_WIRES: { path: string; badge: [number, number]; labelPos: [number, number]; returnWire?: boolean }[] = [
  { path: "M262 122 H322", badge: [292, 122], labelPos: [292, 92] },
  { path: "M546 122 H606", badge: [576, 122], labelPos: [576, 92] },
  { path: "M828 122 H904", badge: [866, 122], labelPos: [866, 92] },
  { path: "M904 291 H868 V232 H463 V294", badge: [686, 232], labelPos: [686, 212], returnWire: true },
  { path: "M576 396 H630", badge: [603, 396], labelPos: [603, 366] },
  { path: "M828 468 H904", badge: [866, 468], labelPos: [866, 438] },
];

function downloadSvg(svg: SVGSVGElement, modeId: ModeId) {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute("width", String(svg.viewBox.baseVal.width));
  copy.setAttribute("height", String(svg.viewBox.baseVal.height));
  copy.setAttribute("role", "img");
  copy.querySelectorAll(".ti-node, .ti-step").forEach((el) => {
    for (const attr of ["role", "tabindex", "aria-pressed", "aria-controls"]) el.removeAttribute(attr);
  });
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: "image/svg+xml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `cep-sfield-tools-${modeId}.svg`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const inlineSvgStyles = `
  .ti-svg { font-family: Inter, system-ui, sans-serif; }
  .ti-boundary { fill: #f2f7f4; stroke: #afc8bb; stroke-width: 1.5; }
  .ti-boundary-llm { fill: #f6f4fb; stroke: #c5bae0; }
  .ti-boundary-sys { fill: #faf7ef; stroke: #d4c59e; }
  .ti-area { fill: #2f5143; font-size: 14.5px; font-weight: 700; }
  .ti-area-llm { fill: #4a3a72; }
  .ti-area-sys { fill: #665428; }
  .ti-area-note { fill: #53685d; font-size: 12px; font-weight: 500; }
  .ti-wire { fill: none; stroke: #2b6754; stroke-width: 2; stroke-linejoin: round; }
  .ti-wire-return { stroke: #526b81; stroke-dasharray: 5 3; }
  .ti-wire-ref { fill: none; stroke: #8a7f5d; stroke-width: 1.5; stroke-dasharray: 2 4; stroke-linecap: round; }
  .ti-wire-active { stroke: #166534; stroke-width: 3; }
  .ti-wire-return.ti-wire-active { stroke: #1d4ed8; stroke-width: 3; }
  .ti-hit { fill: none; stroke: transparent; stroke-width: 18; cursor: pointer; }
  .ti-label { fill: #2d4a3e; font-size: 10.5px; font-weight: 640; text-anchor: middle; paint-order: stroke; stroke: #f8fbf9; stroke-width: 4px; stroke-linejoin: round; }
  .ti-blocked-pill rect { fill: #fef2f2; stroke: #dc2626; stroke-width: 1.2; }
  .ti-blocked-pill text { fill: #991b1b; font-size: 10.5px; font-weight: 700; text-anchor: middle; }
  .ti-llm-pill rect { fill: #ede9fe; stroke: #7c3aed; stroke-width: 1.2; }
  .ti-llm-pill text { fill: #4c1d95; font-size: 10.8px; font-weight: 700; text-anchor: middle; }
  .ti-reg-row rect { fill: #f8faf8; stroke: #d3e0d7; stroke-width: 1; }
  .ti-reg-row.is-hidden rect { fill: #fef7f7; stroke: #f3c6c6; }
  .ti-reg-row text { fill: #234134; font-size: 11px; font-weight: 600; }
  .ti-reg-row .ti-reg-tag { fill: #64748b; font-size: 9.8px; font-weight: 650; text-anchor: end; }
  .ti-reg-row.is-hidden .ti-reg-tag { fill: #b91c1c; }
  .ti-node { cursor: pointer; outline: none; }
  .ti-box { fill: #ffffff; stroke: #a5bbaf; stroke-width: 1.4; }
  .ti-node[data-tone="kernel"] .ti-box { fill: #1d4b3e; stroke: #14372d; }
  .ti-node[data-tone="llm"] .ti-box { fill: #ffffff; stroke: #b4a4d6; }
  .ti-node[data-tone="registry"] .ti-box { fill: #ffffff; stroke: #8aa898; }
  .ti-node[data-tone="systems"] .ti-box { fill: #ffffff; stroke: #ccb988; }
  .ti-name { fill: #173b30; font-size: 14.5px; font-weight: 700; }
  .ti-sub { fill: #425c51; font-size: 12px; }
  .ti-node[data-tone="kernel"] .ti-name { fill: #ffffff; }
  .ti-node[data-tone="kernel"] .ti-sub { fill: #d8efe2; }
  .ti-ring { fill: none; stroke: transparent; stroke-width: 2.5; }
  .ti-node[aria-pressed="true"] .ti-ring { stroke: #15803d; stroke-width: 3; }
  .ti-node:hover .ti-ring, .ti-node:focus-visible .ti-ring { stroke: #115c93; stroke-width: 3; }
  .ti-step { cursor: pointer; outline: none; }
  .ti-step circle { fill: #ffffff; stroke: #2b6754; stroke-width: 1.8; }
  .ti-step[data-return="true"] circle { stroke: #526b81; }
  .ti-step text { fill: #1c4a38; font-size: 11.5px; font-weight: 750; text-anchor: middle; }
  .ti-step[aria-pressed="true"] circle,
  .ti-step:hover circle,
  .ti-step:focus-visible circle { fill: #1d4b3e; stroke: #0f3328; stroke-width: 2.4; }
  .ti-step[aria-pressed="true"] text,
  .ti-step:hover text,
  .ti-step:focus-visible text { fill: #ffffff; }
`;

export function ToolInteractionDiagram() {
  const [modeId, setModeId] = useState<ModeId>("intent");
  const [selection, setSelection] = useState<Selection>({ kind: "step", index: 1 });
  const svgRef = useRef<SVGSVGElement>(null);
  const idPrefix = useId().replace(/[^a-z0-9_-]/gi, "");
  const detailId = idPrefix + "-detail";

  const mode = MODES[modeId];
  const activeStep = selection.kind === "step" ? mode.steps[selection.index] : undefined;
  const activeNode = selection.kind === "node" ? selection.id : undefined;

  const registryRows: { label: string; tag: string; hidden: boolean }[] = [
    { label: "Domain Read Tools (11)", tag: modeId === "intent" ? "Host / 1" : modeId === "funding" ? "1–2 gated" : "Host only", hidden: modeId === "harness" },
    { label: "TS / CCRE & Arbitrator", tag: "Host only", hidden: true },
    { label: "Meta-Tools (discover/plan)", tag: modeId === "experience" ? "1 → 3" : "Hidden", hidden: modeId !== "experience" },
    { label: "int.* Integration Tasks", tag: "BLOCKED", hidden: true },
    { label: "Governed Write Tools", tag: "BLOCKED", hidden: true },
  ];

  return (
    <section id="tool-interactions" className="help-section ti-section" aria-labelledby="tool-interactions-title">
      <div className="help-section-heading">
        <div>
          <h2 id="tool-interactions-title">Tools, sfield &amp; LLM interactions</h2>
          <p className="help-exchange-description">
            sfield never dumps the full tool registry to the LLM. Switch paths below or click any numbered step or box to inspect what reaches the model vs. what stays behind sfield’s zero-trust boundary.
          </p>
        </div>
      </div>

      <figure className="ti-figure" aria-labelledby="tool-interactions-title">
        <div className="ti-toolbar">
          <div className="sa-views ti-mode-tabs" role="group" aria-label="Tool interaction pattern">
            {(Object.keys(MODES) as ModeId[]).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={modeId === key}
                onClick={() => {
                  setModeId(key);
                  setSelection({ kind: "step", index: 1 });
                }}
              >
                {MODES[key].shortLabel}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="sa-download"
            onClick={() => svgRef.current && downloadSvg(svgRef.current, modeId)}
          >
            <Download size={15} aria-hidden="true" />
            Download SVG
          </button>
        </div>

        <div className="ti-summary-strip">
          <div className="ti-summary-pill">
            <span>Sent in <code>request.tools</code></span>
            <strong>{mode.llmBadge}</strong>
          </div>
          <div className="ti-summary-pill">
            <span>Policy Preset</span>
            <strong><code>{mode.policyPreset}</code></strong>
          </div>
          <div className="ti-summary-pill is-safe">
            <span>Write tools visible to LLM</span>
            <strong>0 (Authorizer enforces <code>!agentId</code>)</strong>
          </div>
        </div>

        <div className="ti-drawing">
          <svg
            ref={svgRef}
            xmlns="http://www.w3.org/2000/svg"
            className="ti-svg"
            viewBox="0 0 1180 558"
            role="group"
            aria-labelledby={idPrefix + "-svg-title " + idPrefix + "-svg-desc"}
          >
            <title id={idPrefix + "-svg-title"}>sfield tool registry, narrowing hooks, and LLM interaction diagram</title>
            <desc id={idPrefix + "-svg-desc"}>
              {mode.headline} {mode.summary}
            </desc>
            <style>{inlineSvgStyles}</style>
            <defs>
              {[
                ["call", "#2b6754"],
                ["callActive", "#166534"],
                ["ret", "#526b81"],
                ["retActive", "#1d4ed8"],
                ["ref", "#8a7f5d"],
              ].map(([k, color]) => (
                <marker key={k} id={`${idPrefix}-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
                  <path d="M0 0 L8 4 L0 8 L2 4 Z" fill={color} />
                </marker>
              ))}
            </defs>

            <rect width="1180" height="558" fill="#fcfdfb" />

            {/* Zone Boundaries */}
            <g aria-hidden="true">
              <rect className="ti-boundary" x="20" y="18" width="830" height="522" rx="14" />
              <text className="ti-area" x="42" y="45">sfield Zero-Trust Tool Kernel (CEP Server)</text>
              <text className="ti-area-note" x="828" y="45" textAnchor="end">Full tool registry never leaves this boundary</text>

              <rect className="ti-boundary ti-boundary-llm" x="882" y="18" width="278" height="342" rx="14" />
              <text className="ti-area ti-area-llm" x="904" y="45">LLM Provider Boundary</text>

              <rect className="ti-boundary ti-boundary-sys" x="882" y="382" width="278" height="158" rx="14" />
              <text className="ti-area ti-area-sys" x="904" y="407">Live Systems &amp; Audit</text>
            </g>

            {/* Reference wires from Global Tool Registry (inside sfield only) */}
            <g aria-hidden="true">
              {/* Registry -> Allowlist */}
              <path className="ti-wire-ref" d="M166 274 V206 H434 V178" markerEnd={`url(#${idPrefix}-ref)`} />
              <g className="ti-blocked-pill" transform="translate(300 206)">
                <rect x="-106" y="-11" width="212" height="22" rx="11" />
                <text y="3.5">Full registry filtered by agent.tools</text>
              </g>
              {/* Registry -> Authorizer/Gate (direct host dispatch) */}
              <path className="ti-wire-ref" d="M290 396 H350" markerEnd={`url(#${idPrefix}-ref)`} />
              {/* LLM -> Proposal */}
              <path className="ti-wire ti-wire-return" d="M1021 216 V244" markerEnd={`url(#${idPrefix}-ret)`} />
            </g>

            {/* Interactive numbered interaction wires (paths behind nodes) */}
            {mode.steps.map((step, idx) => {
              const wire = STEP_WIRES[idx];
              const isSelected = selection.kind === "step" && selection.index === idx;
              const marker = wire.returnWire
                ? (isSelected ? `${idPrefix}-retActive` : `${idPrefix}-ret`)
                : (isSelected ? `${idPrefix}-callActive` : `${idPrefix}-call`);
              return (
                <g
                  key={"wire-" + step.number}
                  onClick={() => setSelection({ kind: "step", index: idx })}
                  style={{ cursor: "pointer" }}
                >
                  <title>{`${step.number}. ${step.title}`}</title>
                  <path className="ti-hit" d={wire.path} />
                  <path
                    className={
                      "ti-wire"
                      + (wire.returnWire ? " ti-wire-return" : "")
                      + (isSelected ? " ti-wire-active" : "")
                    }
                    d={wire.path}
                    markerEnd={`url(#${marker})`}
                  />
                </g>
              );
            })}

            {/* Clickable architectural nodes */}
            {(Object.keys(BOXES) as NodeId[]).map((nodeId) => {
              const box = BOXES[nodeId];
              const meta = NODE_META[nodeId];
              const copy = mode.nodeCopy[nodeId];
              const Icon = meta.Icon;
              const isSelected = activeNode === nodeId;
              const isKernel = meta.tone === "kernel";
              return (
                <g
                  key={nodeId}
                  className="ti-node"
                  data-tone={meta.tone}
                  transform={`translate(${box.x} ${box.y})`}
                  role="button"
                  tabIndex={0}
                  aria-label={meta.title}
                  aria-pressed={isSelected}
                  aria-controls={detailId}
                  onClick={() => setSelection({ kind: "node", id: nodeId })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelection({ kind: "node", id: nodeId });
                    }
                  }}
                >
                  <rect className="ti-ring" x="-3.5" y="-3.5" width={box.w + 7} height={box.h + 7} rx="12" />
                  <rect className="ti-box" width={box.w} height={box.h} rx="9" />
                  <Icon
                    x={12}
                    y={14}
                    width={16}
                    height={16}
                    color={isKernel ? "#cdebd9" : meta.tone === "llm" ? "#6d28d9" : "#3a6352"}
                    aria-hidden="true"
                  />
                  <text className="ti-name" x={34} y={27}>{meta.title}</text>

                  {nodeId === "registry" ? (
                    <>
                      <text className="ti-sub" x={12} y={48}>Registered inside SField.create()</text>
                      {registryRows.map((row, idx) => (
                        <g
                          key={row.label}
                          className={"ti-reg-row" + (row.hidden ? " is-hidden" : "")}
                          transform={`translate(10 ${60 + idx * 35})`}
                        >
                          <rect width={box.w - 20} height={28} rx="6" />
                          <text x={8} y={18}>{row.label}</text>
                          <text className="ti-reg-tag" x={box.w - 28} y={18}>{row.tag}</text>
                        </g>
                      ))}
                    </>
                  ) : (
                    <>
                      {copy.subtitle.map((line, i) => (
                        <text className="ti-sub" key={line} x={12} y={53 + i * 18}>
                          {line}
                        </text>
                      ))}
                      {nodeId === "llm" && (
                        <g className="ti-llm-pill" transform={`translate(${box.w / 2} 118)`}>
                          <rect x={-(box.w - 24) / 2} y="-13" width={box.w - 24} height="26" rx="13" />
                          <text y="3.5">{mode.llmBadge}</text>
                        </g>
                      )}
                      {nodeId === "gate" && (
                        <g className="ti-blocked-pill" transform={`translate(${box.w / 2} 170)`}>
                          <rect x={-(box.w - 24) / 2} y="-12" width={box.w - 24} height="24" rx="12" />
                          <text y="3.5">Agent writes: AUTHORIZER DENY</text>
                        </g>
                      )}
                      {nodeId === "executor" && (
                        <text className="ti-sub" x={12} y={178} style={{ fontSize: "10.8px", opacity: 0.85 }}>
                          Closed Ajv schemas + budgets
                        </text>
                      )}
                    </>
                  )}
                </g>
              );
            })}

            {/* Step labels & numbered badges rendered ABOVE nodes so labels never clip */}
            {mode.steps.map((step, idx) => {
              const wire = STEP_WIRES[idx];
              const isSelected = selection.kind === "step" && selection.index === idx;
              const lines = step.wireLabel.split("\n");
              return (
                <g key={"badge-" + step.number}>
                  <text
                    className="ti-label"
                    x={wire.labelPos[0]}
                    y={wire.labelPos[1]}
                    style={{ cursor: "pointer" }}
                    onClick={() => setSelection({ kind: "step", index: idx })}
                  >
                    {lines.map((line, lineIdx) => (
                      <tspan key={line} x={wire.labelPos[0]} dy={lineIdx === 0 ? 0 : 12}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                  <g
                    className="ti-step"
                    data-return={wire.returnWire ? "true" : undefined}
                    transform={`translate(${wire.badge[0]} ${wire.badge[1]})`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Step ${step.number}: ${step.title}`}
                    aria-pressed={isSelected}
                    aria-controls={detailId}
                    onClick={() => setSelection({ kind: "step", index: idx })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelection({ kind: "step", index: idx });
                      }
                    }}
                  >
                    <title>{`Step ${step.number}: ${step.title}`}</title>
                    <circle r="11.5" />
                    <text y="4">{step.number}</text>
                  </g>
                </g>
              );
            })}
          </svg>
        </div>

        <figcaption>
          <strong>{mode.headline}</strong> {mode.summary}
        </figcaption>
      </figure>

      {/* Interactive Detail & Payload Inspector */}
      <section id={detailId} className="ti-detail" aria-live="polite" aria-label="Selected tool interaction details">
        {activeStep ? (
          <>
            <div className="ti-detail-head">
              <div>
                <span className="ti-detail-kicker">
                  Step {activeStep.number} of {mode.steps.length} · {mode.label}
                </span>
                <h3>{activeStep.title}</h3>
              </div>
              <div className="ti-stepper">
                <button
                  type="button"
                  disabled={selection.kind === "step" && selection.index === 0}
                  onClick={() => setSelection({ kind: "step", index: Math.max(0, activeStep.number - 2) })}
                >
                  <ArrowLeft size={14} aria-hidden="true" />
                  Prev
                </button>
                <button
                  type="button"
                  disabled={selection.kind === "step" && selection.index === mode.steps.length - 1}
                  onClick={() => setSelection({ kind: "step", index: Math.min(mode.steps.length - 1, activeStep.number) })}
                >
                  Next
                  <ArrowRight size={14} aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className="ti-detail-grid">
              <div>
                <h4>What happens here</h4>
                <p>{activeStep.whatHappens}</p>
              </div>
              <div>
                <h4>What the LLM sees at this step</h4>
                <p>{activeStep.llmSees}</p>
              </div>
              <div>
                <h4>Security &amp; code enforcement</h4>
                <p><code>{activeStep.enforcement}</code></p>
              </div>
            </div>
          </>
        ) : activeNode ? (
          <>
            <div className="ti-detail-head">
              <div>
                <span className="ti-detail-kicker">Component · {mode.label}</span>
                <h3>{NODE_META[activeNode].title}</h3>
              </div>
              <button
                type="button"
                className="ti-reset-step"
                onClick={() => setSelection({ kind: "step", index: 0 })}
              >
                Walk steps 1 → 6
              </button>
            </div>
            <div className="ti-detail-grid ti-detail-grid-2">
              <div>
                <h4>Role in this path</h4>
                <p>{mode.nodeCopy[activeNode].detail}</p>
              </div>
              <div>
                <h4>Server-side boundary guarantee</h4>
                <p>{mode.nodeCopy[activeNode].serverSide}</p>
              </div>
            </div>
          </>
        ) : null}

        <div className="ti-contract-split">
          <div className="ti-contract-box">
            <h4><Braces size={14} aria-hidden="true" /> Effective LLM dispatch contract (<code>request.tools</code>)</h4>
            <pre><code>{mode.requestToolsJson}</code></pre>
          </div>
          <div className="ti-contract-box">
            <h4><Layers size={14} aria-hidden="true" /> Exposed vs. Hidden from LLM</h4>
            <div className="ti-exposure-lists">
              <div>
                <span className="ti-exposure-label is-open">Visible to LLM</span>
                <ul>
                  {mode.llmToolsList.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
              <div>
                <span className="ti-exposure-label is-blocked">Kept server-side in sfield</span>
                <ul>
                  {mode.hiddenFromLlm.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>
    </section>
  );
}
