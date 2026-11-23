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
    description: "Chat sends messages. A2UI displays cards, forms, and buttons.",
  },
  {
    name: "PZN app server", shortName: "App server", Icon: Network,
    description: "Matches the chat to a demo customer, chooses the next step, and checks the results before building the reply.",
  },
  {
    name: "sfield", shortName: "sfield", Icon: ShieldCheck,
    description: "Runs inside the app server. Calls the language model and runs the tools that call Treatment Selector.",
  },
  {
    name: "Language model", shortName: "Language model", Icon: Sparkles,
    description: "The first call identifies what the customer wants. The second picks content and a layout for the reply.",
  },
  {
    name: "Treatment Selector", shortName: "Treatment Selector", Icon: ListFilter,
    description: "Provides topics and relevance scores. Uses CCRE rules to decide what content fits the customer and topic.",
  },
  {
    name: "Content and data", shortName: "Content and data", Icon: Database,
    description: "Provides approved content and sample balances, portfolio values, and savings progress.",
  },
];

const [chat, host, sfield, model, selector, data] = participants;
const { exchanges: cases, handoffs } = addressUpdateExample;
const exchanges = [
  { path: [chat, host], label: "Message + conversation ID", example: cases.chat },
  { path: [host, sfield, selector], label: "Get supported topics and scores", example: cases.contexts, handoff: handoffs.discovery },
  { path: [selector, sfield, host], label: "Supported topics and relevance scores", reply: true, example: cases.contexts },
  { path: [host, sfield, model], label: "Message, recent chat, and request options", example: cases.router, handoff: handoffs.router },
  { path: [model, sfield, host], label: "Likely request or follow-up question", reply: true, example: cases.router },
  { path: [host, sfield, selector], label: "Topic and member ID", example: cases.treatment, handoff: handoffs.treatment },
  { path: [selector, sfield, host], label: "Matching content and workflow", reply: true, example: cases.treatment },
  { path: [host, data], label: "Look up content by ID", example: cases.content },
  { path: [data, host], label: "Matching content for this request", reply: true, example: cases.content },
  { path: [host, sfield, model], label: "Customer’s request and matching content", example: cases.composer, handoff: handoffs.composer },
  { path: [model, sfield, host], label: "Suggested layout for the reply", reply: true, example: cases.composer },
  { path: [host, chat], label: "A2UI instructions for cards and buttons", reply: true, example: cases.surface },
  { path: [chat, host], label: "Button starts the next chat step", example: cases.followUp },
];
export type DiagramExchange = (typeof exchanges)[number] & { number: number; inspectHandoff?: true };

export function ExchangePath({ path, short = false }: { path: DiagramExchange["path"]; short?: boolean }) {
  return path.map((participant, index) => (
    <Fragment key={participant.name}>
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
          const number = index + 1;
          const step = { ...exchange, number };
          const lanes = path.map((participant) => participants.indexOf(participant));
          const start = lanes[0];
          const end = lanes[lanes.length - 1];
          const columns = Math.abs(end - start) + 1;
          const style = {
            gridColumn: `${Math.min(start, end) + 1} / span ${columns}`,
            "--lane-inset": `${50 / columns}%`,
          } as CSSProperties;
          return <li key={label}>
            <div className="help-message-edge" style={style} data-reply={reply} data-direction={start < end ? "right" : "left"}>
              <span className="help-message-endpoints">
                <ExchangePath path={path} short />
              </span>
              <button className="help-message-heading" type="button" aria-haspopup="dialog" aria-label={`Step ${number} · ${label}`}
                onClick={() => onSelect(step)}>
                <span className="help-message-number">{number}</span>
                <span className="help-message-label">{label}</span>
              </button>
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
            </div>
          </li>;
        })}
      </ol>
    </div>
    <figcaption>The model can use relevance scores as hints when it picks a topic. If the request is unclear, chat asks a follow-up question. When the reply needs account details, the app can read them through sfield tools.</figcaption>
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
  { title: "Workflow", Icon: GitBranch, description: "Read the sample funding options and build a preview when Marcus clicks." },
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
        <h3>PZN app server + sfield</h3>
        <p>The app checks the recommendation and offers it in chat. When Marcus clicks, sfield runs the workflow’s approved tools.</p>
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
    <figcaption>In the address update demo, Marcus chooses <strong>Preview funding</strong> to see a sample transfer. Open <strong>Logs</strong> on that turn to see both sfield calls.</figcaption>
  </figure>;
}
