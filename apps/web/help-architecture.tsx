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
    description: "Sends messages and renders cards, forms, and follow-up controls.",
  },
  {
    name: "PZN host + sfield", shortName: "Host + sfield", Icon: Network,
    description: "sfield runs models and tools. The host binds the profile, verifies results, and compiles A2UI.",
  },
  {
    name: "LLM gateway", shortName: "LLM gateway", Icon: Sparkles,
    description: "The Context Router infers intent. The Experience Composer selects content and layout.",
  },
  {
    name: "Treatment Selector", shortName: "Treatment Selector", Icon: ListFilter,
    description: "Applies CCRE rules and ranks eligible content for the member and context.",
  },
  {
    name: "Content and data", shortName: "Content and data", Icon: Database,
    description: "Supplies published content and scoped demo balances, portfolio values, and goal progress.",
  },
];

const [chat, host, model, selector, data] = participants;
const cases = addressUpdateExample.exchanges;
const exchanges = [
  { from: chat, to: host, label: "Message + conversation ID", example: cases.chat },
  { from: host, to: selector, label: "Discover active contexts", example: cases.contexts },
  { from: selector, to: host, label: "Active context catalog", reply: true, example: cases.contexts },
  { from: host, to: model, label: "Message, recent turns & intent catalog", example: cases.router },
  { from: model, to: host, label: "Intent proposal or clarification", reply: true, example: cases.router },
  { from: host, to: selector, label: "Verified context + member ID", example: cases.treatment },
  { from: selector, to: host, label: "Ranked eligible content IDs", reply: true, example: cases.treatment },
  { from: host, to: data, label: "Resolve content and read scoped values", example: cases.content },
  { from: data, to: host, label: "Published content + demo data", reply: true, example: cases.content },
  { from: host, to: model, label: "Verified intent + eligible candidates", example: cases.composer },
  { from: model, to: host, label: "Experience proposal", reply: true, example: cases.composer },
  { from: host, to: chat, label: "Verified A2UI surface", reply: true, example: cases.surface },
  { from: chat, to: host, label: "Follow-up click starts a new turn", example: cases.followUp },
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
    <figcaption>Discovery supplies active contexts and advisory propensity scores before routing. A clarification can return directly to chat. Scoped reads run as needed.</figcaption>
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
  { title: "Content", Icon: BookOpenText, description: "Render the address guide and the Fund your account card." },
  { title: "Action", Icon: Zap, description: "Run one registered operation, such as reading available funding methods." },
  { title: "Workflow", Icon: GitBranch, description: "Run a registered sequence that gathers choices and builds a funding preview." },
];

export function TreatmentProposalDiagram() {
  return <figure className="help-proposal-diagram" aria-label="Proposed Treatment Selector interaction">
    <ol className="help-proposal-flow" role="list">
      <li className="help-proposal-entity">
        <span className="help-entity-icon"><ListFilter size={18} aria-hidden="true" /></span>
        <h3>Treatment Selector</h3>
        <p>Evaluate business rules and return ranked references to eligible content, actions, and workflows.</p>
        <ArrowRight className="help-proposal-arrow" size={22} aria-hidden="true" />
      </li>
      <li className="help-proposal-entity">
        <span className="help-entity-icon"><Network size={18} aria-hidden="true" /></span>
        <h3>PZN host + sfield</h3>
        <p>Resolve registered IDs and validate inputs and member permissions. Run the selected capability when its registered trigger is met.</p>
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
    <figcaption>In the proposed flow, Marcus chooses <strong>Preview funding</strong> to start the workflow. A2UI shows the resulting preview. An account change would require explicit confirmation before sfield runs it.</figcaption>
  </figure>;
}
