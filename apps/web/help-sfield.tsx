import {
  ArrowRight, ArrowUpRight, CheckCircle2, Cpu, Database, HardDrive, HeartHandshake, KeyRound, Layers, Lock, Network, ShieldCheck, Sliders, Sparkles,
} from "lucide-react";
import { empathyAssessToolRef } from "../../packages/contracts/empathy";
import { recommendationArbitrateToolRef } from "../../packages/contracts/recommendation-provider";
import { sfieldTools, toolKeys, toolVersion, type ToolKey } from "../../packages/contracts/tool-setup";

const usage = {
  catalog: { caller: "App · Before intent selection", contract: "discovery", description: "Gets the active topics from the mock Treatment Selector." },
  propensity: { caller: "App · Before intent selection", contract: "discovery", description: "Asks Treatment Selector for the customer’s scores for the active topics." },
  selection: { caller: "App · Finds eligible treatments", contract: "treatment", description: "Gets eligible content, standalone actions and workflows from TS. After a click, sfield runs the registered tools for the selected reference." },
  balances: { caller: "Experience Composer", contract: "balance", description: "Looks up the customer’s sample balances." },
  glossary: { caller: "App · Creates a rule", contract: "glossary", description: "Lists the fields and comparisons you can use in a rule." },
  retirementAccounts: { caller: "sfield · Reads account records", contract: "retirement-accounts", description: "Lists retirement accounts for the signed-in member and reads the designation on the account selected from the chat." },
  portfolio: { caller: "App · Summarizes a portfolio", contract: "portfolio", description: "Looks up what the demo customer holds in their portfolio." },
  goal: { caller: "App · Shows goal progress", contract: "goal", description: "Looks up the down payment target and monthly savings." },
  fundingOptions: { caller: "Funding preview workflow", contract: "funding", description: "Reads eligible funding methods and the preview amount." },
  fundingStatus: { caller: "Funding preview workflow", contract: "funding", description: "Checks funding status before the agent lists the available methods." },
  fundingPreview: { caller: "Funding preview workflow", contract: "funding", description: "Builds a sample preview using the method read for this turn." },
} satisfies Record<ToolKey, { caller: string; contract: string; description: string }>;

const sfieldPillars = [
  {
    Icon: KeyRound,
    title: "1. Zero-Trust Identity & Authorizer",
    detail: "Every execution carries a host-authenticated Principal (tenantId, subjectId, roles). Before any tool runs, sfield invokes the Authorizer hook to verify tenant, role, action, read/write effect, and caller origin (agent vs host).",
  },
  {
    Icon: Lock,
    title: "2. Policy Presets & Effect Isolation",
    detail: "LLM agents (Context Router, Composer, Funding, Experience) always run under preset: read_only — they can never invoke write tools. Operator-confirmed mutations run only in host-owned bounded_auto scopes with explicit resource bindings.",
  },
  {
    Icon: CheckCircle2,
    title: "3. Closed Schemas & Output Verifiers",
    detail: "Every tool input and output is validated by Ajv against a strict closed JSON Schema subset. Structured LLM outputs pass through host Verifier gates (contextSelection, experience, fundingPreview) before anything can publish.",
  },
  {
    Icon: Sliders,
    title: "4. Lifecycle Hooks (Narrow & Prepare)",
    detail: "beforeModelDispatch narrows the exact tool surface visible to an agent on each turn, while prepareTool injects verified host scope and turn references — preventing prompt-injected parameter tampering.",
  },
  {
    Icon: HardDrive,
    title: "5. Durable Checkpoints & Crash Recovery",
    detail: "Sessions, runs, checkpoints, model attempts, and tool calls persist with idempotency keys via ExecutionPersistence. Interrupted multi-step workflows (such as Funding Preview) resume cleanly after server restarts.",
  },
  {
    Icon: Cpu,
    title: "6. Budgets, Deadlines & Audit Proof",
    detail: "Enforces strict ceilings on token output, model calls, tool attempts, timeouts, and payload byte sizes (maxOutputBytes). Every run and governed write produces a traceable sfieldRunId inspectable in Logs and Inspector.",
  },
];

const executionLanes = [
  {
    lane: "LLM Agent Sessions",
    preset: "read_only",
    caller: "route · compose · funding · experience",
    allowed: "Scoped read tools & ask_user only",
    guarantee: "Cannot invoke write tools; outputs must pass Verifier gates",
  },
  {
    lane: "Host Read Scopes",
    preset: "read_only",
    caller: "CEP App Server (registry.execute)",
    allowed: "Treatment Selector, Portfolio, Goal, cep.empathy.assess@1.0.0, cep.recommendations.arbitrate@1.0.0",
    guarantee: "Deterministic arbitration, empathy & C360 note assessment, and PII-safe data reads with full audit logs",
  },
  {
    lane: "Host Governed Writes",
    preset: "bounded_auto",
    caller: "CEP App Server (operator UI confirmation)",
    allowed: "cep.domain.execute_write@1.0.0 only (no agentId)",
    guarantee: "Explicit business resource binding (domain_record) + immutable Write Audit entry",
  },
  {
    lane: "External MCP Clients",
    preset: "read_only / supervised",
    caller: "sf.createMcpServer() (POST /api/mcp · stdio)",
    allowed: "Allowlisted sfield tools (e.g. cep.empathy.assess@1.0.0), published int.* tasks, KB RAG",
    guarantee: "Authorizer + Ajv schemas + HITL approval suspension (pending_approval) + sfieldRunId audit",
  },
];

const deploymentModes = [
  {
    mode: "ephemeral",
    label: "Ephemeral (In-Memory)",
    use: "Zero-boilerplate unit tests & scripts via @sfield/preset-memory (EphemeralPersistence + InMemoryArtifactStore) and @sfield/testing.",
    active: false,
  },
  {
    mode: "durable_single",
    label: "Durable Single-Node (SQLite)",
    use: "Active in CEP today via @sfield/store-sqlite & @sfield/preset-local — node:sqlite checkpoints, SqliteMemoryRepository, and FilesystemArtifactStore.",
    active: true,
  },
  {
    mode: "service",
    label: "Distributed Service (Postgres + JSON Fallback)",
    use: "Production HA via @sfield/store-postgres (PostgresPersistence + PostgresMemoryRepository + lock-manifest gating) with automatic durable JsonFilePersistence fallback (createPostgresOrJsonPersistence) when Postgres is unavailable.",
    active: false,
  },
];

const sdkPackages = [
  {
    pkg: "@sfield/core",
    role: "Governed Agent Kernel",
    highlights: "SField runtime, closed Ajv tool contracts, HITL approvals, Anthropic / Gemini / OpenAI-compatible providers, SFieldMcpServer + McpClient, PiiFirewall, ToolResilienceGuard, DelegationService, streamRun, FilesystemArtifactStore & VectorMemoryIndex.",
  },
  {
    pkg: "@sfield/preset-memory",
    role: "Zero-Boilerplate Ephemeral Preset",
    highlights: 'Enables SField.create({ config, preset: "memory" }) for tests and scripts; refuses NODE_ENV=production and deployment: "service".',
  },
  {
    pkg: "@sfield/preset-local",
    role: "Zero-Boilerplate Durable Local Preset",
    highlights: 'Enables SField.create({ config, preset: "local" }) backed by SQLite + FilesystemArtifactStore under .sfield/ (or SFIELD_LOCAL_DIR).',
  },
  {
    pkg: "@sfield/store-sqlite",
    role: "Durable Single-Node Store",
    highlights: "Atomic BEGIN IMMEDIATE transactions, durable epoch fencing, SqliteMemoryRepository, and bounded event retention over built-in node:sqlite.",
  },
  {
    pkg: "@sfield/store-postgres",
    role: "Service Postgres + JSON Fallback",
    highlights: "Production POSTGRES_SCHEMA_SQL DDL, PostgresMemoryRepository, createPgPoolAdapter(pgPool), and createPostgresOrJsonPersistence() falling back automatically to conformance-verified JsonFilePersistence.",
  },
  {
    pkg: "@sfield/telemetry-otel",
    role: "OpenTelemetry GenAI Sink",
    highlights: "Zero-dependency TelemetrySink recording gen_ai.* spans & token/cost/duration metrics with OTLP/HTTP JSON (v1/traces) export.",
  },
  {
    pkg: "@sfield/studio",
    role: "Standalone & Embeddable Workbench",
    highlights: "Zero-framework governance UI & HTTP handler (createStudioHandler, startStudioServer) for runs, Principal/Tool playground, HITL approvals, locks, evals, memory, PII lab, and OTel traces.",
  },
  {
    pkg: "@sfield/testing",
    role: "Conformance & Release-Gate Eval Runner",
    highlights: "persistenceConformance() suite, deterministic FakeModelProvider, plus runEvalSuite() & evaluateReleaseGate() wired into sf.lock.evalReports().",
  },
  {
    pkg: "@sfield/cli",
    role: "Standalone CLI (sfield)",
    highlights: "init, validate, eval, lock status, lock approve, inspect <runId>, doctor, studio, and mcp serve (stdio).",
  },
];

export function SfieldHelp({ selectContract }: { selectContract: (id: string) => void }) {
  const portfolioTool = sfieldTools.portfolio.id + "@" + toolVersion;
  return <section id="sfield" className="help-section" aria-labelledby="sfield-title">
    <div className="help-section-heading">
      <h2 id="sfield-title">sfield Agent SDK &amp; plug-in tools</h2>
      <div style={{ display: "flex", gap: "14px", alignItems: "center", flexWrap: "wrap" }}>
        <a className="help-section-link" href="/admin/sfield-studio">
          Open sfield Studio <ArrowUpRight size={14} aria-hidden="true" />
        </a>
        <a className="help-section-link" href="/sfield-sdk.html" target="_blank" rel="noreferrer">
          Standalone HTML SDK Guide <ArrowUpRight size={14} aria-hidden="true" />
        </a>
        <a className="help-section-link" href="#contracts" onClick={() => selectContract("rules")}>
          Tool setup contract <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      </div>
    </div>
    <div className="help-sfield">
      <p className="help-sfield-lead">
        <strong>sfield is the standalone zero-trust Governed Agent SDK</strong> (9 publishable packages under <code>@sfield/*</code>), and <strong>CEP is its flagship reference application</strong>. sfield sits between any host application, language models, and business systems — enforcing identity, closed schemas, policy presets, PII egress redaction, rate limits/circuit breakers, MCP federation, budgets, durability, and verification on every call.
      </p>

      <ol className="help-sfield-flow" aria-label="How sfield handles a chat message" role="list">
        <li className="help-sfield-node">
          <span className="help-entity-icon"><Network size={18} aria-hidden="true" /></span>
          <h3>CEP app server</h3>
          <p>Authenticates the session, selects the active Domain Pack &amp; principal, opens scoped sfield executions, and compiles verified A2UI surfaces.</p>
          <ArrowRight className="help-proposal-arrow" size={22} aria-hidden="true" />
        </li>
        <li className="help-sfield-node">
          <span className="help-entity-icon"><ShieldCheck size={18} aria-hidden="true" /></span>
          <h3>sfield runtime</h3>
          <p>Runs Authorizer checks, policy presets (<code>read_only</code> vs host <code>bounded_auto</code>), Ajv schema validation, lifecycle hooks, Verifiers, and durable SQLite checkpoints.</p>
          <ArrowRight className="help-proposal-arrow" size={22} aria-hidden="true" />
        </li>
        <li className="help-sfield-targets">
          <div className="help-proposal-choice">
            <span className="help-entity-icon"><Sparkles size={16} aria-hidden="true" /></span>
            <div><h3>Language model gateway</h3><p>Native <code>GeminiProvider</code>, <code>AnthropicProvider</code>, <code>OpenAICompatibleProvider</code>, and Copilot ACP — always sandboxed with PII egress scrubbing, OTel tracing, and strict token &amp; attempt budgets.</p></div>
          </div>
          <div className="help-proposal-choice">
            <span className="help-entity-icon"><Database size={16} aria-hidden="true" /></span>
            <div><h3>Scoped read &amp; write tools</h3><p>Assesses emotional &amp; life-event context (<code>cep.empathy.assess</code>), reads live domain data, arbitrates recommendations (<code>cep.recommendations.arbitrate</code>), and executes operator-confirmed writes (<code>cep.domain.execute_write</code>).</p></div>
          </div>
        </li>
      </ol>

      <div className="help-sfield-subsection">
        <h3>Core sfield architecture pillars</h3>
        <p>Unlike unguarded LLM tool loops, sfield separates <em>model reasoning</em> from <em>authorization, data access, and state mutation</em> across six enforcement layers:</p>
        <div className="help-sfield-pillars">
          {sfieldPillars.map(({ Icon, title, detail }) => (
            <article key={title} className="help-sfield-pillar">
              <span className="help-entity-icon"><Icon size={16} aria-hidden="true" /></span>
              <div>
                <h4>{title}</h4>
                <p>{detail}</p>
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="help-sfield-subsection">
        <h3>Execution lanes &amp; security boundaries</h3>
        <p>sfield enforces strict separation between what an LLM can trigger autonomously and what requires host orchestration or explicit operator confirmation:</p>
        <div className="help-sfield-table-wrap">
          <table className="help-sfield-table">
            <thead>
              <tr>
                <th>Execution Lane</th>
                <th>Policy Preset</th>
                <th>Caller</th>
                <th>Permitted Surface</th>
                <th>Security Guarantee</th>
              </tr>
            </thead>
            <tbody>
              {executionLanes.map((row) => (
                <tr key={row.lane}>
                  <td><strong>{row.lane}</strong></td>
                  <td><code>{row.preset}</code></td>
                  <td>{row.caller}</td>
                  <td>{row.allowed}</td>
                  <td>{row.guarantee}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="help-sfield-subsection">
        <h3>Standalone <code>@sfield/*</code> SDK packages (8 publishable workspaces)</h3>
        <p>Every enterprise capability built for CEP lives as a reusable, domain-agnostic package under <code>vendor/sfield/packages/</code>, verified by CI (<code>.github/workflows/ci.yml</code>) and publishable via <code>.github/workflows/release.yml</code>:</p>
        <div className="help-sfield-table-wrap">
          <table className="help-sfield-table">
            <thead>
              <tr>
                <th>Package</th>
                <th>Role</th>
                <th>Capabilities</th>
              </tr>
            </thead>
            <tbody>
              {sdkPackages.map((row) => (
                <tr key={row.pkg}>
                  <td><code>{row.pkg}</code></td>
                  <td><strong>{row.role}</strong></td>
                  <td>{row.highlights}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="help-sfield-subsection">
        <h3>Deployment modes &amp; enterprise scaling path</h3>
        <p>sfield decouples orchestration from storage through its <code>ExecutionPersistence</code> and <code>ArtifactStore</code> interfaces, supporting a smooth progression from local tests to HA production:</p>
        <div className="help-sfield-modes">
          {deploymentModes.map((item) => (
            <div key={item.mode} className={"help-sfield-mode" + (item.active ? " is-active" : "")}>
              <div className="help-sfield-mode-head">
                <code>{item.mode}</code>
                {item.active && <span className="help-mode-pill mode-verified">Active in CEP</span>}
              </div>
              <h4>{item.label}</h4>
              <p>{item.use}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="help-sfield-subsection">
        <h3>What makes a tool plug-and-play</h3>
        <p>Each tool declares an ID and version, closed JSON Schemas for inputs and outputs, a business resource binding (mandatory for write tools), policy limits, and a pluggable adapter handler:</p>
        <div className="help-provider-path" aria-label="Portfolio Snapshot provider example">
          <div>
            <h4>Portfolio Snapshot tool</h4>
            <code>{portfolioTool}</code>
            <p>The app identifies the chat request and its approved route. The tool uses that to find the right MID.</p>
          </div>
          <ArrowRight className="help-provider-arrow" size={20} aria-hidden="true" />
          <div>
            <h4>Where the data comes from</h4>
            <code>PortfolioSnapshotProvider.read(mid, signal)</code>
            <p>The demo uses sample data. Set the server’s <code>portfolioSnapshots</code> option to connect a service that provides cash and investment balances.</p>
          </div>
        </div>
        <div className="help-provider-path" aria-label="Unified Recommendation Provider example" style={{ marginTop: "12px" }}>
          <div>
            <h4><Layers size={15} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: "6px" }} />Unified Recommendation Arbitrator</h4>
            <code>{recommendationArbitrateToolRef}</code>
            <p>Host-governed <code>sfield</code> read tool — never exposed directly to the LLM so vendor selection stays deterministic and compliant.</p>
          </div>
          <ArrowRight className="help-provider-arrow" size={20} aria-hidden="true" />
          <div>
            <h4>Pluggable RecommendationProvider adapters</h4>
            <code>RecommendationProvider.evaluate(ctx, signal)</code>
            <p>Fans out in parallel to <strong>Treatment Selector (TS + CCRE)</strong>, <strong>Customer 360 NBA</strong>, <strong>IT Ops Runbooks</strong>, <strong>Sales Deal Desk</strong>, or external engines (Pega CDH, ML Ranker) — honoring <code>excludePromotions</code> during customer hardship.</p>
          </div>
        </div>
        <div className="help-provider-path" aria-label="Empathy & Life-Event Assessment example" style={{ marginTop: "12px" }}>
          <div>
            <h4><HeartHandshake size={15} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: "6px" }} />Empathy &amp; Life-Event Assessor</h4>
            <code>{empathyAssessToolRef}</code>
            <p>Host-governed <code>read_only</code> <code>sfield</code> tool that evaluates the current message, recent context, and Customer 360 advisor <code>notes</code> (via PII-scrubbed LLM + heuristic fallback).</p>
          </div>
          <ArrowRight className="help-provider-arrow" size={20} aria-hidden="true" />
          <div>
            <h4>Customer 360 Notes &amp; Promotion Guard</h4>
            <code>CustomerProfileStore.appendNote() · excludePromotions: true</code>
            <p>Personalizes response tone by name and situation, persists newly disclosed major life events into Customer 360 <code>notes</code> + <code>sfield.memory</code>, and suppresses promotional offers during hardship.</p>
          </div>
        </div>
        <div className="help-provider-path" aria-label="Governed Write Tool example" style={{ marginTop: "12px" }}>
          <div>
            <h4><Lock size={15} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: "6px" }} />Governed Domain Write Tool</h4>
            <code>cep.domain.execute_write@1.0.0</code>
            <p>Declares <code>effect: "write"</code> and <code>resource: domain_record</code> bound to <code>inputs.recordId</code>. Blocked for all LLM agents; executable only by confirmed host actions.</p>
          </div>
          <ArrowRight className="help-provider-arrow" size={20} aria-hidden="true" />
          <div>
            <h4>Live Stores &amp; Immutable Write Audit</h4>
            <code>incidents.json · deals.json · customer-profiles.json → write-audit.json</code>
            <p>Executes rollbacks, discount approvals, and Customer 360 form updates inside a signed <code>sfield</code> run and logs every <code>sfieldRunId</code> to <strong>Logs → Write audit</strong>.</p>
          </div>
        </div>
      </div>

      <div className="help-sfield-subsection">
        <h3>Registered tools</h3>
        <p>Read tools can be toggled in Tool setup, while platform arbitration and governed write tools run at the host boundary. Select a tool to inspect its contract.</p>
        <ul className="help-tool-registry" aria-label="sfield tool registry" role="list">
          {toolKeys.map((key) => {
            const tool = sfieldTools[key];
            return <li key={key}>
              <div className="help-tool-name">
                <a className="help-section-link" href="#contracts" onClick={() => selectContract(usage[key].contract)}>
                  {tool.label} <ArrowUpRight size={13} aria-hidden="true" />
                </a>
                <code>{tool.id}</code>
              </div>
              <p>{usage[key].description}</p>
              <span className="help-tool-caller">{usage[key].caller}</span>
            </li>;
          })}
        </ul>
      </div>

      <div className="help-sfield-subsection">
        <h3>Host platform tools (Empathy, Arbitration, Governed Writes &amp; External Connectors)</h3>
        <p>These platform-level tools run exclusively inside host-owned sfield scopes and are never exposed to LLM agents directly.</p>
        <ul className="help-tool-registry" aria-label="sfield platform tools" role="list">
          <li>
            <div className="help-tool-name">
              <a className="help-section-link" href="#contracts" onClick={() => selectContract("empathy")}>
                Empathy &amp; Life-Event Assessor <ArrowUpRight size={13} aria-hidden="true" />
              </a>
              <code>{empathyAssessToolRef}</code>
            </div>
            <p>Assesses emotional state and life events from chat + Customer 360 notes, writes new life events back to Customer 360 &amp; sfield.memory, and signals promotion suppression to Recommendation Providers.</p>
            <span className="help-tool-caller">Host · Read scope</span>
          </li>
          <li>
            <div className="help-tool-name">
              <a className="help-section-link" href="#contracts" onClick={() => selectContract("providers")}>
                Recommendation Arbitrator <ArrowUpRight size={13} aria-hidden="true" />
              </a>
              <code>{recommendationArbitrateToolRef}</code>
            </div>
            <p>Single recommendation authority across verified &amp; Dynamic Canvas surfaces — fans out across RecommendationProvider adapters, guards against recent-buy contradictions, and honors empathy promotion suppression.</p>
            <span className="help-tool-caller">Host · Read scope</span>
          </li>
          <li>
            <div className="help-tool-name">
              <a className="help-section-link" href="/admin/logs?source=write_audit">
                Governed Domain Write <ArrowUpRight size={13} aria-hidden="true" />
              </a>
              <code>cep.domain.execute_write@1.0.0</code>
            </div>
            <p>Executes operator-confirmed writes across IT Ops rollbacks, RevOps discount approvals, and Customer 360 form bindings with immutable audit proof.</p>
            <span className="help-tool-caller">Host · bounded_auto write scope</span>
          </li>
          <li>
            <div className="help-tool-name">
              <a className="help-section-link" href="/admin/logs?source=approvals">
                External Connector Invoke (HITL) <ArrowUpRight size={13} aria-hidden="true" />
              </a>
              <code>cep.connector.invoke@1.0.0</code>
            </div>
            <p>Executes enabled REST/MCP external connectors under sfield governance with server-side secret resolution, SHA-256 HITL approval gating (Chat + Admin), and immutable audit logging.</p>
            <span className="help-tool-caller">Host · bounded_auto + HITL gate</span>
          </li>
        </ul>
      </div>
    </div>
  </section>;
}
