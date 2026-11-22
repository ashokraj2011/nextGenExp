import type { CSSProperties } from "react";
import {
  ArrowRight, BookOpenText, Database, GitBranch, ListFilter, MessageSquare, Network, Sparkles, Zap,
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
    name: "PZN app server + sfield", shortName: "App server + sfield", Icon: Network,
    description: "The app server links the message to the customer and checks the result. sfield calls the model and tools.",
  },
  {
    name: "Language model", shortName: "Language model", Icon: Sparkles,
    description: "The first call identifies what the customer wants. The second picks content and a layout for the reply.",
  },
  {
    name: "Treatment Selector", shortName: "Treatment Selector", Icon: ListFilter,
    description: "Uses CCRE rules to decide what content applies to this customer and topic.",
  },
  {
    name: "Content and data", shortName: "Content and data", Icon: Database,
    description: "Provides approved content and sample balances, portfolio values, and savings progress.",
  },
];

const [chat, host, model, selector, data] = participants;
const cases = addressUpdateExample.exchanges;
const exchanges = [
  { from: chat, to: host, label: "Message + conversation ID", example: cases.chat },
  { from: host, to: selector, label: "Ask which topics are supported", example: cases.contexts },
  { from: selector, to: host, label: "List of supported topics", reply: true, example: cases.contexts },
  { from: host, to: model, label: "Message, recent chat, and request options", example: cases.router },
  { from: model, to: host, label: "Likely request or follow-up question", reply: true, example: cases.router },
  { from: host, to: selector, label: "Topic and member ID", example: cases.treatment },
  { from: selector, to: host, label: "Matching content IDs in order", reply: true, example: cases.treatment },
  { from: host, to: data, label: "Look up content and account details", example: cases.content },
  { from: data, to: host, label: "Content and sample account details", reply: true, example: cases.content },
  { from: host, to: model, label: "Customer’s request and matching content", example: cases.composer },
  { from: model, to: host, label: "Suggested layout for the reply", reply: true, example: cases.composer },
  { from: host, to: chat, label: "A2UI instructions for cards and buttons", reply: true, example: cases.surface },
  { from: chat, to: host, label: "Button starts the next chat step", example: cases.followUp },
];
export type DiagramExchange = (typeof exchanges)[number] & { number: number };

export function InteractionDiagram({ onSelect }: { onSelect: (exchange: DiagramExchange) => void }) {
  return <figure className="help-interaction" aria-labelledby="architecture-title">
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
          const { from, to, label, reply } = exchange;
          const number = index + 1;
          const start = participants.indexOf(from);
          const end = participants.indexOf(to);
          const columns = Math.abs(end - start) + 1;
          const style = {
            gridColumn: `${Math.min(start, end) + 1} / span ${columns}`,
            "--lane-inset": `${50 / columns}%`,
          } as CSSProperties;
          return <li key={label}>
            <div className="help-message-edge" style={style} data-reply={reply} data-direction={start < end ? "right" : "left"}>
              <span className="help-message-endpoints">
                {from.shortName} <ArrowRight size={13} aria-hidden="true" /> <span className="sr-only">to</span> {to.shortName}
              </span>
              <button className="help-message-heading" type="button" aria-haspopup="dialog" aria-label={`Step ${number} · ${label}`}
                onClick={() => onSelect({ ...exchange, number })}>
                <span className="help-message-number">{number}</span>
                <span className="help-message-label">{label}</span>
              </button>
              <span className="help-message-arrow" aria-hidden="true" />
            </div>
          </li>;
        })}
      </ol>
    </div>
    <figcaption>The model can use relevance scores as hints when it picks a topic. If the request is unclear, chat asks a follow-up question. The app reads account details as needed.</figcaption>
  </figure>;
}

export const currentTreatmentExample = {
  request: {
    mid: hostFixture.personas.find(({ personaId }) => personaId === "demo-new-account")!.syntheticMid,
    context: "address-update",
  },
  response: treatmentFixture.base["address-update"],
};
const proposedRecommendations = [
  ...currentTreatmentExample.response.map((id) => ({ kind: "content", id })),
  { kind: "action", id: "funding.options.read", version: "1.0.0" },
  { kind: "workflow", id: "account.funding.preview", version: "1.0.0" },
];
export const proposedTreatmentExample = [
  "{",
  '  "schemaVersion": "2.0",',
  '  "recommendations": [',
  proposedRecommendations.map((item) => "    " + JSON.stringify(item)).join(",\n"),
  "  ]",
  "}",
].join("\n");

const recommendations = [
  { title: "Content", Icon: BookOpenText, description: "Show the address guide and the Fund your account card." },
  { title: "Action", Icon: Zap, description: "Use one tool, for example to check how the customer can fund the account." },
  { title: "Workflow", Icon: GitBranch, description: "Guide the customer through a few steps and show a funding preview." },
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
        <p>Find the right tool, check what it needs and what the customer can do, then run it when its conditions are met.</p>
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
    <figcaption>In this proposal, Marcus chooses <strong>Preview funding</strong> to start the steps in chat. If a step would change his account, chat asks him to confirm first.</figcaption>
  </figure>;
}
