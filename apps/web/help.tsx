import { useEffect, useState } from "react";
import treatmentDiagramUrl from "./assets/ts-sfield-interaction.svg?url";
import { ArrowUpRight, BookOpenText, Braces, Database, Download, GitBranch, House, Layers, LayoutGrid, ListFilter, MessageSquare, Network, PanelsTopLeft, Settings2, ShieldCheck, Sparkles, UsersRound } from "lucide-react";
import { recommendationArbitrateToolRef } from "../../packages/contracts/recommendation-provider";
import { adminPaths } from "../../packages/contracts/admin-paths";
import { pendingActionsContext } from "../../packages/contracts/workspace";
import { developerGuideHref } from "./admin-navigation";
import { DeveloperDrawer } from "./developer-drawer";
import { ExchangePath, InteractionDiagram, TreatmentEvolutionDiagram, TreatmentHandoffDiagram, type DiagramExchange } from "./help-architecture";
import { contractList, helpContracts, type ContractFile } from "./help-contracts";
import { addressUpdateExample, helpFlows, treatmentDecisionExamples, type FlowStep, type HandoffExample, type PayloadExample } from "./help-flow";
import { RecordedEvidence, useMarcusRun, type MarcusRun } from "./help-run-evidence";
import { SystemArchitecture } from "./help-system-architecture";
import { ToolInteractionDiagram } from "./help-tool-interactions";
import { InteractionMap } from "./help-interactions";
import { SfieldHelp } from "./help-sfield";
import "./help.css";

const stepIcons = {
  chat: MessageSquare,
  discovery: GitBranch,
  router: Sparkles,
  treatment: ListFilter,
  portfolio: Database,
  goal: House,
  composer: Braces,
  glossary: BookOpenText,
  render: LayoutGrid,
};

function PayloadExamples({ examples }: { examples: { direction: string; label: string; source: string; emphasized?: boolean }[] }) {
  return <div className="help-payload-pair">
    {examples.map(({ direction, label, source, emphasized }) => (
      <section className="help-payload" key={direction} aria-label={direction} data-emphasized={emphasized}>
        <div className="help-payload-caption"><strong>{direction}</strong><span>{label}</span></div>
        <pre tabIndex={0} aria-label={direction + " JSON"}><code>{source}</code></pre>
      </section>
    ))}
  </div>;
}

function PayloadPair({ input, output }: { input: PayloadExample; output: PayloadExample }) {
  return <PayloadExamples examples={[
    { direction: "Input", label: input.label, source: JSON.stringify(input.value, null, 2) },
    { direction: "Output", label: output.label, source: JSON.stringify(output.value, null, 2) },
  ]} />;
}

function TreatmentEvolution({ selectContract, run }: { selectContract: (id: string) => void; run: MarcusRun }) {
  const [selected, setSelected] = useState(0);
  const example = treatmentDecisionExamples[selected];
  return <section id="proposal" className="help-section" aria-labelledby="proposal-title">
    <div className="help-section-heading">
      <div>
        <h2 id="proposal-title">Expanding Treatment Selector from Content Recommendations to Actions and Workflows</h2>
        <p className="help-exchange-description">Today, Treatment Selector (TS) takes a MID (<code>mid</code>) and a topic (<code>context</code>) and returns ranked content IDs. In this proof of concept, the same CCRE rules can recommend a standalone action or a workflow by ID and version. sfield sends TS the topic it inferred from chat and runs the workflow the customer picks.</p>
        <p className="help-exchange-description">
          When Marcus Reed asks “What’s next?”, the <strong>Account is unfunded</strong> rule makes <strong>Preview funding</strong> eligible.
          Once the mock account portal confirms his first deposit, TS reads his updated status at the next sign-in and drops the reminder.{" "}
          <a className="help-section-link" href={adminPaths.logs + "?source=" + pendingActionsContext}>
            View Pending actions in Logs <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        </p>
      </div>
      <nav className="help-step-contracts" aria-label="Treatment Selector resources">
        <a href="#system-architecture">System map <ArrowUpRight size={14} aria-hidden="true" /></a>
        <a href={treatmentDiagramUrl} download="ts-sfield-interaction.svg">Download diagram <Download size={14} aria-hidden="true" /></a>
        <a href="#contracts" onClick={() => selectContract("treatment")}>View TS contracts <ArrowUpRight size={14} aria-hidden="true" /></a>
      </nav>
    </div>
    <div className="help-proposal">
      <TreatmentHandoffDiagram run={run} />
      <TreatmentEvolutionDiagram />
      <div className="help-sfield-subsection">
        <div className="help-evolution-example-heading">
          <h3>One rule decision, two response formats</h3>
          <div className="help-flow-picker" role="group" aria-label="Treatment Selector examples">
            {treatmentDecisionExamples.map(({ label }, index) => <button key={label} type="button"
              aria-pressed={index === selected} aria-controls="ts-decision-example" onClick={() => setSelected(index)}>{label}</button>)}
          </div>
        </div>
        <div id="ts-decision-example">
          <p className="help-example">“{example.prompt}”</p>
          <dl className="help-decision-facts">
            <div><dt>Matching CCRE rule</dt><dd><strong>{example.rule}.</strong> {example.eligibility}</dd></div>
            <div><dt>After the click</dt><dd><strong>{example.button}.</strong> {example.afterClick}</dd></div>
          </dl>
          <details className="help-tool-exchange">
            <summary>Compare the legacy and current TS responses</summary>
            <p>Both formats use this TS request.{example.request.context === "learning" && <> Once Alice chooses a retirement account, a follow-up can include <code>accountId</code> so the rule checks that account.</>}</p>
            <pre className="help-contract-source help-ts-request" tabIndex={0} aria-label="Treatment Selector request JSON"><code>{JSON.stringify(example.request, null, 2)}</code></pre>
            <PayloadExamples examples={[
              { direction: "Content IDs", label: "v1", source: JSON.stringify(example.legacy, null, 2) },
              { direction: "Content, actions and workflows", label: "v2.1", source: JSON.stringify(example.response, null, 2) },
            ]} />
          </details>
        </div>
        <p>In Tool setup, choose <strong>{example.button}</strong> under <strong>Workflow on click</strong> for this rule and save it. Ask the question in chat and click the button. Open the original message in Logs to compare responses, then follow the link to the click for each sfield call in order.</p>
        {selected === 0 && <p>The standalone address rule is defined in <code>fixtures/treatment-scenarios.json</code>. Its eligibility is independent of the address guide.</p>}
        <nav className="help-step-contracts" aria-label="Test a TS decision">
          <a href={adminPaths.tools}>Open Tool setup <ArrowUpRight size={14} aria-hidden="true" /></a>
          <a href={adminPaths.logs}>Open Logs <ArrowUpRight size={14} aria-hidden="true" /></a>
        </nav>
      </div>
      <div className="help-sfield-subsection">
        <h3>How to roll this out</h3>
        <ol className="help-ts-rollout">
          <li><strong>Check the content order.</strong> Evaluate CCRE once and compare v1’s list with the content entries in v2.1 for the same members and topics. Include cases where a rule excludes a card.</li>
          <li><strong>Pilot one workflow.</strong> Enable the typed response for one channel and topic while existing channels use v1. If the channel cannot run the workflow version, it can still show the eligible content.</li>
          <li><strong>Measure what happens next.</strong> Add a TS decision ID and a reason for each recommendation to the shared contract. Use that ID to link what the customer saw and clicked with what they completed.</li>
        </ol>
      </div>
    </div>
  </section>;
}

function HandoffExamples({ handoff }: { handoff: HandoffExample }) {
  const [selected, setSelected] = useState(0);
  const { description, exchange } = handoff.calls[selected];
  const { request, response } = exchange;
  const message = "message" in request ? request.message : undefined;
  return <>
    {handoff.description && <p className="help-exchange-description">{handoff.description}</p>}
    {handoff.calls.length > 1 && <div className="help-flow-picker help-handoff-picker" role="group" aria-label="Discovery tool calls">
      {handoff.calls.map(({ title }, index) => (
        <button key={title} type="button" aria-pressed={selected === index} onClick={() => setSelected(index)}>{title}</button>
      ))}
    </div>}
    <p className="help-exchange-description">{description}</p>
    {"treatmentSelectorInput" in exchange && <details className="help-tool-exchange">
      <summary>Treatment Selector request and response</summary>
      <PayloadExamples examples={[
        { direction: "Treatment Selector request", label: "getContextScores", source: JSON.stringify(exchange.treatmentSelectorInput, null, 2) },
        { direction: "Treatment Selector response", label: "Topic relevance scores", source: JSON.stringify(response.output, null, 2) },
      ]} />
    </details>}
    <PayloadExamples examples={[
      { direction: "Request", label: message ? "session.send" : "registry.execute", source: JSON.stringify(request, null, 2) },
      { direction: "Response", label: message ? "sfield RunResult" : "sfield ToolResult", source: JSON.stringify(response, null, 2) },
    ]} />
    {message && <details className="help-tool-exchange help-handoff-message">
      <summary>Read the model input as JSON</summary>
      <pre className="help-contract-source" tabIndex={0} aria-label="Model input JSON">
        <code>{JSON.stringify(JSON.parse(message.text), null, 2)}</code>
      </pre>
    </details>}
  </>;
}

function ExchangeDetails({ exchange, close, run }: { exchange: DiagramExchange; close: () => void; run: MarcusRun }) {
  const { example, path, label, number, reply } = exchange;
  const handoff = exchange.inspectHandoff ? exchange.handoff : undefined;
  return <div className="help-exchange-drawer">
    <DeveloperDrawer title={`Step ${number} · ${handoff ? "App server to sfield" : label}`} icon={<Braces size={18} />} closeLabel="Close exchange details" close={close} wide>
      {run.selected || run.pin || run.error || !run.runs ? <RecordedEvidence run={run} kind={exchange.evidence} /> : <>
      <p className="help-example-note">Reference example · No recorded Marcus address-update run is available.</p>
      <p className="help-example">As <strong>{addressUpdateExample.persona}</strong>, ask <strong>“{addressUpdateExample.prompt}”</strong></p>
      <p className="help-exchange-direction">
        <ExchangePath path={handoff ? path.slice(0, 2) : path} />
      </p>
      {handoff ? <>
        <HandoffExamples handoff={handoff} />
        <p className="help-example-note">Illustrative exchange with sample IDs. Open Logs to see a recorded chat turn.</p>
      </> : <>
        <p className="help-exchange-description">{example.description}</p>
        <PayloadExamples examples={[
          { direction: "Request", label: example.input.label, source: JSON.stringify(example.input.value, null, 2), emphasized: !reply },
          { direction: "Response", label: example.output.label, source: JSON.stringify(example.output.value, null, 2), emphasized: reply },
        ]} />
        <p className="help-example-note">These examples use sample IDs. Choose a conversation in <strong>Logs</strong> to see a recorded run.</p>
      </>}
      </>}
    </DeveloperDrawer>
  </div>;
}

function downloadContract(file: ContractFile) {
  const type = file.name.endsWith(".json") ? "application/json" : "text/plain";
  const url = URL.createObjectURL(new Blob([file.source], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ContractDetail({ contract }: { contract: typeof contractList[number] }) {
  const [file, setFile] = useState(contract.files[0]);
  return <section className="help-contract-detail" aria-labelledby="selected-contract-title">
    <div className="help-contract-header">
      <div>
        <h3 id="selected-contract-title">{contract.title}</h3>
        <p>{contract.description}</p>
      </div>
      <button className="help-download" type="button" onClick={() => downloadContract(file)} aria-label={"Download " + file.name}>
        <Download size={16} aria-hidden="true" /> Download
      </button>
    </div>
    {contract.endpoints && <dl className="help-endpoints">
      {contract.endpoints.map(([path, purpose]) => <div key={path}><dt><code>{path}</code></dt><dd>{purpose}</dd></div>)}
    </dl>}
    <div className="help-file-list" role="group" aria-label="Contract files">
      {contract.files.map((option) => (
        <button key={option.name} type="button" aria-pressed={option.name === file.name} onClick={() => setFile(option)}>{option.name}</button>
      ))}
    </div>
    <pre className="help-contract-source" aria-label={"Source for " + file.name} tabIndex={0} key={file.name}><code>{file.source}</code></pre>
  </section>;
}

export function Help() {
  const run = useMarcusRun();
  const [flow, setFlow] = useState(helpFlows[0]);
  const [stepId, setStepId] = useState<FlowStep["id"]>("router");
  const [contractId, setContractId] = useState("router");
  const [exchange, setExchange] = useState<DiagramExchange>();
  useEffect(() => {
    document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, []);
  const step = flow.steps.find(({ id }) => id === stepId)!;
  const contract = contractList.find(({ id }) => id === contractId)!;
  return <div className="help-page">
    <header className="help-topbar">
      <div className="help-width help-topbar-inner">
        <nav aria-label="Help sections">
          <a href="#interactions">Interaction map</a>
          <a href="#system-architecture">System architecture</a>
          <a href="#tool-interactions">Tools &amp; LLM</a>
          <a href="#architecture">Chat sequence</a>
          <a href="#proposal">Treatment Selector’s role</a>
          <a href="#demo-playbook">5-Min Demo</a>
          <a href="#providers">Providers</a>
          <a href="#goal-planning">Multi-step requests</a>
          <a href="#sfield">sfield</a>
          <a href="#walkthroughs">Walkthroughs</a>
          <a href="#contracts">Contracts</a>
          <a href={developerGuideHref()}>Developer docs</a>
          <a href="/sfield-sdk.html" target="_blank" rel="noreferrer">sfield SDK HTML ↗</a>
        </nav>
      </div>
    </header>
    <main className="help-width help-main">
      <div className="help-intro">
        <h1>How CEP &amp; sfield work</h1>
        <p><strong>sfield</strong> (<code>@sfield/*</code>) is the standalone Governed Agent SDK powering CEP — enforcing zero-trust identity, closed tool schemas, HITL approvals, MCP federation, PII firewalling, OTel tracing, and durable storage (SQLite or Postgres with automatic JSON fallback). CEP is its multi-domain reference platform connecting language models, Treatment Selector, and A2UI surfaces.</p>
      </div>
      <InteractionMap run={run} />
      <div id="cep-blueprint">
        <SystemArchitecture run={run} selectContract={setContractId} />
        <ToolInteractionDiagram />
        <details className="sa-configuration">
          <summary>Routing options and administration</summary>
          <p>The diagram follows an account-help request. A goal with several tasks can use the <a href="#goal-planning">multi-step planning flow</a>. Domains can also ask sfield to <a href="#providers">combine recommendations from several sources</a>, or use the <a href="#interaction-render">custom UI flow</a> for an interactive view.</p>
          <div className="help-control-plane" aria-label="Admin master data control plane">
            <a className="help-cp-card" href={adminPaths.customers}>
              <span className="help-entity-icon"><UsersRound size={17} aria-hidden="true" /></span>
              <div>
                <strong>Customer 360 Profiles</strong>
                <p>Create/edit customer profiles, balances, portfolios, goals &amp; NBA preview.</p>
              </div>
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
            <a className="help-cp-card" href={adminPaths.intents}>
              <span className="help-entity-icon"><GitBranch size={17} aria-hidden="true" /></span>
              <div>
                <strong>Intents, Catalog &amp; NBA Rules</strong>
                <p>Manage high-level intents, governed content treatments, and NBA priority order.</p>
              </div>
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
            <a className="help-cp-card" href={adminPaths.tools}>
              <span className="help-entity-icon"><Settings2 size={17} aria-hidden="true" /></span>
              <div>
                <strong>Tool Setup (TS &amp; CCRE Rules)</strong>
                <p>Configure Treatment Selector overrides, CCRE eligibility rules, workflows &amp; capabilities.</p>
              </div>
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
            <a className="help-cp-card" href={adminPaths.builder}>
              <span className="help-entity-icon"><PanelsTopLeft size={17} aria-hidden="true" /></span>
              <div>
                <strong>UI Builder &amp; Widget Studio</strong>
                <p>Bind custom layouts to intents and save Copilot-generated widgets to the library.</p>
              </div>
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
          </div>
        </details>
      </div>
      <TreatmentEvolution run={run} selectContract={setContractId} />
      <section id="demo-playbook" className="help-section" aria-labelledby="demo-playbook-title">
        <div className="help-section-heading">
          <div>
            <h2 id="demo-playbook-title">Investment customer walkthrough</h2>
            <p className="help-exchange-description">Two customers ask the same question about the second retirement account in their chat.</p>
          </div>
          <a className="help-section-link" href="/chat">Open customer chat <ArrowUpRight size={14} aria-hidden="true" /></a>
        </div>
        <ol className="help-cep-pipeline" aria-label="Retirement account walkthrough">
          <li>
            <h3>Show Alice’s retirement accounts</h3>
            <p>Sign in as <strong>Alice Morgan</strong> and choose <strong>Retirement accounts</strong>. Her workplace 401(k) appears first and her rollover IRA second.</p>
          </li>
          <li>
            <h3>Ask who is named on the second account</h3>
            <p>Ask <strong>“Who’s the beneficiary on the second one?”</strong> The IRA ending in 6105 has no beneficiary on file. Open the steps on <strong>Update your beneficiaries</strong>.</p>
          </li>
          <li>
            <h3>Ask the same question as Jordan</h3>
            <p>Sign in as <strong>Jordan Lee</strong> in another browser session and repeat the two questions. His second account is a Roth IRA ending in 9281. The card names <strong>Casey Lee</strong> as the beneficiary.</p>
          </li>
          <li>
            <h3>Trace the difference to the account record</h3>
            <p>In <a href={adminPaths.logs}>Logs</a>, open each follow-up. <strong>Context Router</strong> shows the recent chat and displayed account order. <strong>Retirement account records</strong> shows the selected account. <strong>Treatment Selector</strong> shows the member and account IDs and the rule that includes or excludes the reminder. On Alice’s turn, <strong>Experience Composer</strong> shows how the eligible reminder was selected.</p>
          </li>
        </ol>
      </section>
      <section id="providers" className="help-section" aria-labelledby="providers-title">
        <div className="help-section-heading">
          <div>
            <h2 id="providers-title">Pluggable Recommendation Providers behind sfield</h2>
            <p className="help-exchange-description">Recommendation engines are abstracted behind one host-governed <code>sfield</code> tool — the single recommendation authority across both verified A2UI and Dynamic Canvas cards — enforcing deterministic arbitration, recent-trade contradiction checks, and <code>cep.empathy.assess@1.0.0</code> hardship promotion suppression.</p>
          </div>
          <a className="help-section-link" href="#contracts" onClick={() => setContractId("providers")}>
            Provider contract <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        </div>
        <div className="help-sfield">
          <ol className="help-sfield-flow" aria-label="Recommendation provider abstraction flow" role="list">
            <li className="help-sfield-node">
              <span className="help-entity-icon"><Network size={18} aria-hidden="true" /></span>
              <h3>CEP Host Orchestrator</h3>
              <p>Calls one stable contract per turn (<code>domain</code>, <code>contextId</code>, scoped customer/session) without vendor-specific branching.</p>
            </li>
            <li className="help-sfield-node">
              <span className="help-entity-icon"><ShieldCheck size={18} aria-hidden="true" /></span>
              <h3>sfield · Arbitrator Tool</h3>
              <p><code>{recommendationArbitrateToolRef}</code> enforces scope authorization, 5s timeout, parallel fan-out, deduplication, priority sorting, and audit traces.</p>
            </li>
            <li className="help-sfield-targets">
              <div className="help-proposal-choice">
                <span className="help-entity-icon"><ListFilter size={16} aria-hidden="true" /></span>
                <div><h3>Treatment Selector (TS + CCRE)</h3><p>Wealth eligibility rules, ranking overrides, eligible content, standalone actions and workflows.</p></div>
              </div>
              <div className="help-proposal-choice">
                <span className="help-entity-icon"><UsersRound size={16} aria-hidden="true" /></span>
                <div><h3>Customer 360 NBA Engine</h3><p>Prioritized Next Best Action rules against Customer 360 signals &amp; persistent dismissals.</p></div>
              </div>
              <div className="help-proposal-choice">
                <span className="help-entity-icon"><Layers size={16} aria-hidden="true" /></span>
                <div><h3>IT Ops, Sales RevOps &amp; External Engines</h3><p>Operations and sales use <code>incidents.json</code> and <code>deals.json</code>. External decision engines and ranking models connect through <code>RecommendationProvider</code>.</p></div>
              </div>
            </li>
          </ol>
        </div>
      </section>
      <section id="design-ownership" className="help-section" aria-labelledby="ownership-title">
        <div className="help-section-heading"><h2 id="ownership-title">Who shares a design?</h2></div>
        <p>A tenant is one organization. Each domain has owners who publish designs and members who use them. A person can belong to more than one domain.</p>
        <ol className="help-ownership">
          <li><strong>Tenant</strong><span>Sets up the model and the domains people can access.</span></li>
          <li><strong>Domain</strong><span>A Wealth owner publishes a balance card in the design library.</span></li>
          <li><strong>User</strong><span>Alice and Jordan get the same card, each filled with their own balance.</span></li>
          <li><strong>Session and thread</strong><span>sfield keeps the conversation here so a follow-up uses the right history.</span></li>
        </ol>
        <a href={adminPaths.builder + "?view=library"}>Open the shared design library</a>
      </section>
      <section id="architecture" className="help-section" aria-labelledby="architecture-title">
        <div className="help-section-heading">
          <div>
            <h2 id="architecture-title">How chat answers a message</h2>
            <p className="help-exchange-description">Select a numbered step or an App → sfield arrow to inspect Marcus’s address update. Choose the recorded run in the TS and sfield diagram.</p>
          </div>
          <a className="help-section-link" href="#ts-sfield">Choose Marcus’s run <ArrowUpRight size={14} aria-hidden="true" /></a>
        </div>
        <InteractionDiagram onSelect={setExchange} />
      </section>
      <section id="goal-planning" className="help-section" aria-labelledby="goal-planning-title">
        <div className="help-section-heading">
          <div>
            <h2 id="goal-planning-title">How chat handles a multi-step request</h2>
            <p>As Alice, ask “I want to buy a house in two years. Show me how close I am and help me explore a savings plan.”</p>
          </div>
          <a className="help-section-link" href="/chat">Open chat <ArrowUpRight size={14} aria-hidden="true" /></a>
        </div>
        <ol className="help-goal-flow">
          <li><strong>Understand the goal</strong><p>sfield gives the Experience Agent the request and recent chat. The agent looks up relevant capabilities and proposes which steps can run together.</p></li>
          <li><strong>Check eligibility</strong><p>The app sends the MID and each relevant topic to Treatment Selector. CCRE rules determine which capabilities and content are eligible.</p></li>
          <li><strong>Read and calculate</strong><p>sfield reads the savings goal and portfolio independently. Once goal progress is verified, the calculator projects savings using the selected amount and timeframe.</p></li>
          <li><strong>Build the response</strong><p>The app turns verified results into approved A2UI components. Changing the contribution runs the calculation again and updates the chart.</p></li>
        </ol>
        <p className="help-goal-note">Open <strong>Inspector</strong> for the goal, plan and evidence. Open <strong>Logs</strong> for the model, Treatment Selector and tool exchanges. Use <strong>Tool setup → Capability Studio</strong> to check and publish capability versions.</p>
      </section>
      <SfieldHelp selectContract={setContractId} />
      <section id="walkthroughs" className="help-section" aria-labelledby="walkthroughs-title">
        <div className="help-section-heading">
          <h2 id="walkthroughs-title">Demo walkthroughs</h2>
          <div className="help-flow-picker" role="group" aria-label="Demo walkthrough">
            {helpFlows.map((option) => (
              <button key={option.id} type="button" aria-pressed={option.id === flow.id} onClick={() => {
                setFlow(option);
                setStepId("router");
              }}>{option.title}</button>
            ))}
          </div>
        </div>
        <div className="help-walkthrough">
          <p className="help-example">
            {flow.prior ? <>After <strong>“{flow.prior}”</strong> ask </> : flow.persona ? <>As <strong>{flow.persona}</strong>, ask </> : "Ask "}
            <strong>“{flow.prompt}”</strong>
          </p>
          <ol className="help-steps" aria-label="Turn flow">
            {flow.steps.map((option) => {
              const Icon = stepIcons[option.id];
              return <li key={option.id}>
                <button type="button" aria-pressed={step.id === option.id} aria-controls="step-details" onClick={() => setStepId(option.id)}>
                  <Icon size={19} aria-hidden="true" />
                  <strong>{option.title}</strong>
                  <small>{option.role}</small>
                </button>
              </li>;
            })}
          </ol>
          <section className="help-step-detail" id="step-details" aria-labelledby="step-title" key={flow.id + ":" + step.id}>
            <div className="help-step-header">
              <h3 id="step-title">{step.title}</h3>
              <p>{step.description}</p>
            </div>
            <PayloadPair input={step.input} output={step.output} />
            {step.tool && <details className="help-tool-exchange">
              <summary>{step.tool.title}</summary>
              <p>{step.tool.description}</p>
              <PayloadPair input={step.tool.input} output={step.tool.output} />
            </details>}
            <nav className="help-step-contracts" aria-label="Contracts for this step">
              {step.contracts.map((id) => (
                <a key={id} href="#contracts" onClick={() => setContractId(id)}>
                  {contractList.find((item) => item.id === id)!.title} <ArrowUpRight size={14} aria-hidden="true" />
                </a>
              ))}
            </nav>
          </section>
        </div>
        <p className="help-example-note">Choose a conversation and message in <strong>Logs</strong> to see the recorded requests and responses.</p>
      </section>
      <section id="contracts" className="help-section" aria-labelledby="contracts-title">
        <div className="help-section-heading help-reference-heading">
          <h2 id="contracts-title">Contracts</h2>
          <p>See what each service expects and sends back. Download the formats and types used by the app.</p>
        </div>
        <div className="help-contract-library">
          <nav className="help-contract-nav" aria-label="Contract library">
            {helpContracts.map(({ title, contracts }) => <div className="help-contract-group" key={title}>
              <h3>{title}</h3>
              {contracts.map((item) => <button type="button" key={item.id} aria-pressed={contractId === item.id} onClick={() => setContractId(item.id)}>{item.title}</button>)}
            </div>)}
          </nav>
          <div className="help-contract-select">
            <label htmlFor="help-contract-select">Select a contract</label>
            <select id="help-contract-select" value={contractId} onChange={(event) => setContractId(event.target.value)}>
              {helpContracts.map(({ title, contracts }) => <optgroup key={title} label={title}>
                {contracts.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </optgroup>)}
            </select>
          </div>
          <ContractDetail key={contract.id} contract={contract} />
        </div>
      </section>
      <footer className="help-footer"><a href="/planning">Planning overview <ArrowUpRight size={15} aria-hidden="true" /></a></footer>
    </main>
    {exchange && <ExchangeDetails run={run} exchange={exchange} close={() => setExchange(undefined)} />}
  </div>;
}
