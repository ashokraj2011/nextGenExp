import { Fragment, type CSSProperties } from "react";
import {
  ArrowRight, BookOpenText, Database, GitBranch, ListFilter, MessageSquare, Network, ShieldCheck, Sparkles, Zap,
} from "lucide-react";
import hostFixture from "../../fixtures/host.json";
import treatmentFixture from "../../fixtures/treatment-scenarios.json";
import { addressUpdateExample } from "./help-flow";

const participants = [
  {
    name: "Chat and A2UI", shortName: "Chat", Icon: MessageSquare,
    description: "Profile-scoped chat workbench. Renders Advisory Reasoning (with Stage 0 badge), verified A2UI cards, Dynamic LLM Canvas, and #1 NBA.",
  },
  {
    name: "CEP app server", shortName: "App server", Icon: Network,
    description: "Runs Customer 360 lookup, Stage 0 Action Gate, schema verification, UI Builder layouts, and NBA arbitration with persistent dismissals.",
  },
  {
    name: "sfield", shortName: "sfield", Icon: ShieldCheck,
    description: "Runs inside the app server. Executes Copilot ACP calls and scoped tools for Treatment Selector, balances, portfolio, goals, and workflows.",
  },
  {
    name: "Language model", shortName: "Language model", Icon: Sparkles,
    description: "Copilot ACP extracts high-level intents using Customer 360 signals, composes verified layouts, or builds safe Dynamic UI canvases.",
  },
  {
    name: "Treatment Selector", shortName: "Treatment Selector", Icon: ListFilter,
    description: "Evaluates CCRE eligibility rules and ranking overrides per customer MID to decide eligible treatments, workflows, and capabilities.",
  },
  {
    name: "Content and data", shortName: "Content and data", Icon: Database,
    description: "Live Customer 360 profiles (/admin/customers), governed Content Catalog & Intents (/admin/intents), and Widget Library (/admin/ui).",
  },
];

const [chat, host, sfield, model, selector, data] = participants;
const { exchanges: cases, handoffs } = addressUpdateExample;
const exchanges = [
  { path: [chat, host], label: "Message + Stage 0 Action Gate", example: cases.chat },
  { path: [host, data], label: "Customer 360 lookup & active intents", example: cases.contexts },
  { path: [data, host], label: "Customer 360 signals & live intent catalog", reply: true, example: cases.contexts },
  { path: [host, sfield, model], label: "Prompt, Customer 360 signals & high-level intents", example: cases.router, handoff: handoffs.router },
  { path: [model, sfield, host], label: "Extracted intent or action mode (update_address)", reply: true, example: cases.router },
  { path: [host, sfield, selector], label: "TS rule group + member ID (CCRE rules)", example: cases.treatment, handoff: handoffs.treatment },
  { path: [selector, sfield, host], label: "Matching content and workflow", reply: true, example: cases.treatment },
  { path: [host, data], label: "Resolve approved content from catalog", example: cases.content },
  { path: [data, host], label: "Approved copy, disclosures & allowed components", reply: true, example: cases.content },
  { path: [host, sfield, model], label: "Customer’s request and eligible candidates", example: cases.composer, handoff: handoffs.composer },
  { path: [model, sfield, host], label: "Verified layout proposal (JSON only — no HTML)", reply: true, example: cases.composer },
  { path: [host, host], label: "Form UI: compile A2UI v1.0, UI Builder layouts & live bindings", self: true, example: cases.compileUi },
  { path: [host, chat], label: "Send A2UI instructions (experience.ready SSE) → React render", reply: true, example: cases.surface },
  { path: [chat, host], label: "Button starts the next step or governed sfield write", example: cases.followUp },
];
export type DiagramExchange = (typeof exchanges)[number] & { number: number; inspectHandoff?: true };

export function ExchangePath({ path, short = false }: { path: DiagramExchange["path"]; short?: boolean }) {
  return path.map((participant, index) => (
    <Fragment key={`${participant.name}-${index}`}>
      {index > 0 && <><ArrowRight size={short ? 13 : 15} aria-hidden="true" /><span className="sr-only">to</span></>}
      {short ? <span>{participant.shortName}</span> : <strong>{participant.name}</strong>}
    </Fragment>
  ));
}

export function InteractionDiagram({ onSelect }: { onSelect: (exchange: DiagramExchange) => void }) {
  return <figure className="help-interaction" aria-labelledby="architecture-title"
    style={{ "--lane-count": participants.length } as CSSProperties}>
    <ul className="help-participants" aria-label="Entity responsibilities" role="list">
      {participants.map(({ name, Icon, description }) => (
        <li key={name}>
          <span className="help-entity-icon"><Icon size={18} aria-hidden="true" /></span>
          <div><h3>{name}</h3><p>{description}</p></div>
        </li>
      ))}
    </ul>
    <div className="help-sequence">
      <div className="help-lifelines" aria-hidden="true">{participants.map(({ name }) => <span key={name} />)}</div>
      <ol aria-label="Chat interaction sequence" role="list">
        {exchanges.map((exchange, index) => {
          const { path, label, reply, handoff } = exchange;
          const isSelf = "self" in exchange && exchange.self === true;
          const number = index + 1;
          const step = { ...exchange, number };
          const lanes = path.map((participant) => participants.indexOf(participant));
          const start = lanes[0];
          const end = lanes[lanes.length - 1];
          const columns = Math.abs(end - start) + 1;
          const style = isSelf
            ? ({ gridColumn: `${start + 1} / span 2`, "--lane-inset": "4%" } as CSSProperties)
            : ({
                gridColumn: `${Math.min(start, end) + 1} / span ${columns}`,
                "--lane-inset": `${50 / columns}%`,
              } as CSSProperties);
          return <li key={label}>
            <div className="help-message-edge" style={style} data-reply={reply} data-self={isSelf ? "true" : undefined} data-direction={start < end ? "right" : "left"}>
              <span className="help-message-endpoints">
                <ExchangePath path={path} short />
              </span>
              <button className="help-message-heading" type="button" aria-haspopup="dialog" aria-label={`Step ${number} · ${label}`}
                onClick={() => onSelect(step)}>
                <span className="help-message-number">{number}</span>
                <span className="help-message-label">{label}</span>
              </button>
              {isSelf ? (
                <span className="help-self-loop-bar" aria-hidden="true">
                  <span>Host UI Compiler · compileExperience() + applyPublishedUi() → A2UI v1.0</span>
                </span>
              ) : (
                <span className="help-message-arrow" data-inspectable={handoff ? true : undefined}>
                  {path.slice(1).map((participant, leg) => {
                    const legStyle = { flex: Math.abs(lanes[leg + 1] - lanes[leg]) };
                    return leg === 0 && handoff
                      ? <button key={participant.name} className="help-message-leg help-message-handoff" style={legStyle}
                          type="button" aria-haspopup="dialog" aria-label={`App server to sfield handoff · step ${number}`}
                          onClick={() => onSelect({ ...step, inspectHandoff: true })}>
                          <span>App <ArrowRight size={12} aria-hidden="true" /> sfield</span>
                        </button>
                      : <span key={participant.name} className="help-message-leg" style={legStyle} aria-hidden="true" />;
                  })}
                </span>
              )}
            </div>
          </li>;
        })}
      </ol>
    </div>
    <figcaption>
      <strong>Where the UI is formed &amp; sent:</strong> The LLM only proposes component choices at <strong>Step 11</strong> (never raw HTML). At <strong>Step 12</strong>, the <strong>CEP app server</strong> deterministically compiles A2UI v1.0 messages, applies published UI Builder layouts &amp; live multi-domain bindings, and streams them via SSE at <strong>Step 13</strong> for React rendering. Custom visualization requests (IT Ops / RevOps / ad-hoc charts) branch at Step 1 into <code>compileDynamicCanvas()</code> and join at Step 13.
    </figcaption>
  </figure>;
}

export const treatmentExample = {
  request: {
    mid: hostFixture.personas.find(({ personaId }) => personaId === "demo-new-account")!.syntheticMid,
    context: "address-update",
  },
  contentIds: treatmentFixture.base["address-update"],
  response: addressUpdateExample.treatmentResponse,
};

const recommendations = [
  { title: "Content", Icon: BookOpenText, description: "Show the address guide and the Fund your account card." },
  { title: "Action", Icon: Zap, description: "A single-tool recommendation could show the available funding methods." },
  { title: "Workflow", Icon: GitBranch, description: "Check funding status, show eligible methods, and preview the one Marcus chooses." },
];

export function TreatmentProposalDiagram() {
  return <figure className="help-proposal-diagram" aria-label="Proposed Treatment Selector interaction">
    <ol className="help-proposal-flow" role="list">
      <li className="help-proposal-entity">
        <span className="help-entity-icon"><ListFilter size={18} aria-hidden="true" /></span>
        <h3>Treatment Selector</h3>
        <p>Use business rules to recommend what the customer can see or do next.</p>
        <ArrowRight className="help-proposal-arrow" size={22} aria-hidden="true" />
      </li>
      <li className="help-proposal-entity">
        <span className="help-entity-icon"><Network size={18} aria-hidden="true" /></span>
        <h3>CEP app server + sfield</h3>
        <p>The app looks up the recommended ID and version in Tool setup. sfield runs the funding agent when Marcus opens the preview.</p>
        <ArrowRight className="help-proposal-arrow" size={22} aria-hidden="true" />
      </li>
      <li className="help-proposal-choices">
        {recommendations.map(({ title, Icon, description }) => (
          <div className="help-proposal-choice" key={title}>
            <span className="help-entity-icon"><Icon size={16} aria-hidden="true" /></span>
            <div><h3>{title}</h3><p>{description}</p></div>
          </div>
        ))}
      </li>
    </ol>
    <figcaption>Choose <strong>Preview funding</strong> and reply with a funding method. The agent resumes the same run and builds the preview. Open <strong>Logs</strong> on each message to see the run and its calls.</figcaption>
  </figure>;
}
