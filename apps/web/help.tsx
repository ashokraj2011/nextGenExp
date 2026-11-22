import { useState } from "react";
import { ArrowLeft, ArrowUpRight, BookOpenText, Braces, Database, Download, GitBranch, House, LayoutGrid, ListFilter, MessageSquare, Sparkles } from "lucide-react";
import { contractList, helpContracts, type ContractFile } from "./help-contracts";
import { helpFlows, type FlowStep, type PayloadExample } from "./help-flow";
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

function PayloadPair({ input, output }: { input: PayloadExample; output: PayloadExample }) {
  return <div className="help-payload-pair">
    {[{ ...input, direction: "Input" }, { ...output, direction: "Output" }].map(({ direction, label, value }) => (
      <section className="help-payload" key={direction} aria-label={direction}>
        <div className="help-payload-caption"><strong>{direction}</strong><span>{label}</span></div>
        <pre tabIndex={0} aria-label={direction + " JSON"}><code>{JSON.stringify(value, null, 2)}</code></pre>
      </section>
    ))}
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
  const step = flow.steps.find(({ id }) => id === stepId)!;
  const contract = contractList.find(({ id }) => id === contractId)!;
  return <div className="help-page">
    <header className="help-topbar">
      <div className="help-width help-topbar-inner">
        <a className="help-home" href="/">PZN Lab</a>
        <nav aria-label="Help sections">
          <a href="#architecture">Architecture</a>
          <a href="#contracts">Contracts</a>
        </nav>
        <a className="help-back" href="/"><ArrowLeft size={16} aria-hidden="true" /> Back to chat</a>
      </div>
    </header>
    <main className="help-width help-main">
      <div className="help-intro">
        <h1>How PZN Lab works</h1>
        <p>Follow a chat turn through sfield, Treatment Selector and A2UI. Choose a demo and select a step to see its inputs, outputs and contracts.</p>
      </div>
      <section id="architecture" className="help-section" aria-labelledby="architecture-title">
        <div className="help-section-heading">
          <h2 id="architecture-title">Architecture</h2>
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
            {flow.prior ? <>After <strong>“{flow.prior}”</strong> ask <strong>“{flow.prompt}”</strong></> : <>Ask <strong>“{flow.prompt}”</strong></>}
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
        <p className="help-example-note">Payloads are demo examples. Open <strong>Logs</strong> in chat for the requests and responses recorded on an actual turn.</p>
      </section>
      <section id="contracts" className="help-section" aria-labelledby="contracts-title">
        <div className="help-section-heading help-reference-heading">
          <h2 id="contracts-title">Contracts</h2>
          <p>Browse and download the runtime schemas, shared types and tool interfaces used in this app.</p>
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
  </div>;
}
