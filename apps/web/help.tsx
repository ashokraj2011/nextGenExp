import { useEffect, useState } from "react";
import { ArrowLeft, ArrowUpRight, BookOpenText, Braces, Database, Download, GitBranch, House, LayoutGrid, ListFilter, MessageSquare, Sparkles } from "lucide-react";
import { DeveloperDrawer } from "./developer-drawer";
import { currentTreatmentExample, ExchangePath, InteractionDiagram, proposedTreatmentExample, TreatmentProposalDiagram, type DiagramExchange } from "./help-architecture";
import { contractList, helpContracts, type ContractFile } from "./help-contracts";
import { addressUpdateExample, helpFlows, type FlowStep, type HandoffExample, type PayloadExample } from "./help-flow";
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

function HandoffExamples({ handoff }: { handoff: HandoffExample }) {
  const [selected, setSelected] = useState(0);
  const { description, exchange: { request, response } } = handoff.calls[selected];
  const message = "message" in request ? request.message : undefined;
  return <>
    {handoff.description && <p className="help-exchange-description">{handoff.description}</p>}
    {handoff.calls.length > 1 && <div className="help-flow-picker help-handoff-picker" role="group" aria-label="Discovery tool calls">
      {handoff.calls.map(({ title }, index) => (
        <button key={title} type="button" aria-pressed={selected === index} onClick={() => setSelected(index)}>{title}</button>
      ))}
    </div>}
    <p className="help-exchange-description">{description}</p>
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

function ExchangeDetails({ exchange, close }: { exchange: DiagramExchange; close: () => void }) {
  const { example, path, label, number, reply } = exchange;
  const handoff = exchange.inspectHandoff ? exchange.handoff : undefined;
  return <div className="help-exchange-drawer">
    <DeveloperDrawer title={`Step ${number} · ${handoff ? "App server to sfield" : label}`} icon={<Braces size={18} />} closeLabel="Close exchange details" close={close} wide>
      <p className="help-example">As <strong>{addressUpdateExample.persona}</strong>, ask <strong>“{addressUpdateExample.prompt}”</strong></p>
      <p className="help-exchange-direction">
        <ExchangePath path={handoff ? path.slice(0, 2) : path} />
      </p>
      {handoff ? <>
        <HandoffExamples handoff={handoff} />
        <p className="help-example-note">Recorded in Test mode. Generated IDs were replaced with sample IDs.</p>
      </> : <>
        <p className="help-exchange-description">{example.description}</p>
        <PayloadExamples examples={[
          { direction: "Request", label: example.input.label, source: JSON.stringify(example.input.value, null, 2), emphasized: !reply },
          { direction: "Response", label: example.output.label, source: JSON.stringify(example.output.value, null, 2), emphasized: reply },
        ]} />
        <p className="help-example-note">These examples use sample IDs. Open <strong>Logs</strong> in chat to see a real run of the demo.</p>
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
        <a className="help-home" href="/">PZN Lab</a>
        <nav aria-label="Help sections">
          <a href="#architecture">Architecture</a>
          <a href="#sfield">sfield</a>
          <a href="#walkthroughs">Walkthroughs</a>
          <a href="#proposal">Proposal</a>
          <a href="#contracts">Contracts</a>
        </nav>
        <a className="help-back" href="/"><ArrowLeft size={16} aria-hidden="true" /> Back to chat</a>
      </div>
    </header>
    <main className="help-width help-main">
      <div className="help-intro">
        <h1>How PZN Lab works</h1>
        <p>See how the app understands a request, picks content for the customer, and displays the reply.</p>
      </div>
      <section id="architecture" className="help-section" aria-labelledby="architecture-title">
        <div className="help-section-heading">
          <div>
            <h2 id="architecture-title">How chat answers a message</h2>
            <p className="help-exchange-description">Choose a step number for Marcus’s address update, or select an App → sfield arrow to see what passes between the server and sfield.</p>
          </div>
          <a className="help-section-link" href="#walkthroughs">See a walkthrough <ArrowUpRight size={14} aria-hidden="true" /></a>
        </div>
        <InteractionDiagram onSelect={setExchange} />
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
        <p className="help-example-note">Open <strong>Logs</strong> in chat to see the requests and responses recorded when you send a message.</p>
      </section>
      <section id="proposal" className="help-section" aria-labelledby="proposal-title">
        <div className="help-section-heading help-reference-heading">
          <h2 id="proposal-title">Treatment Selector proposal</h2>
          <p>Let Treatment Selector recommend content, actions, and multi-step tasks.</p>
        </div>
        <div className="help-proposal">
          <TreatmentProposalDiagram />
          <details className="help-tool-exchange">
            <summary>Compare the current and proposed responses</summary>
            <p>Both examples use the same request to Treatment Selector for Marcus’s address update.</p>
            <p><code>{JSON.stringify(currentTreatmentExample.request)}</code></p>
            <PayloadExamples examples={[
              { direction: "Current response", label: "Content IDs in order", source: JSON.stringify(currentTreatmentExample.response, null, 2) },
              { direction: "Proposed response", label: "Content, actions, and workflows", source: proposedTreatmentExample },
            ]} />
          </details>
        </div>
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
    {exchange && <ExchangeDetails exchange={exchange} close={() => setExchange(undefined)} />}
  </div>;
}
