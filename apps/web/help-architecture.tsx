import { Fragment, useState, type CSSProperties } from "react";
import {
  ArrowRight, Braces, ChevronRight, Database, GitBranch, ListFilter, MessageSquare, Network, ShieldCheck, Sparkles, Zap,
} from "lucide-react";
import { DeveloperDrawer } from "./developer-drawer";
import { RecordedEvidence, RecordedRecommendations, RunPicker, type EvidenceKind, type MarcusRun } from "./help-run-evidence";
import { addressUpdateExample, type HandoffExample } from "./help-flow";

const participants = [
  {
    name: "Chat and A2UI", shortName: "Chat", Icon: MessageSquare,
    description: "Shows progress, account information, and the next available action. A2UI renders the cards and forms in the conversation.",
  },
  {
    name: "CEP app server", shortName: "App server", Icon: Network,
    description: "Resolves the flows allowed in this chat, selects a flow, checks model results and builds the UI.",
  },
  {
    name: "sfield", shortName: "sfield", Icon: ShieldCheck,
    description: "Runs inside the app server. Calls the configured model and scoped tools for Treatment Selector, balances, portfolio, goals, and workflows.",
  },
  {
    name: "Language model", shortName: "Language model", Icon: Sparkles,
    description: "Selects from the app’s flow list. Inside account help, it proposes a specific intent and a layout from eligible content.",
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
type SequenceExchange = {
  path: typeof participants; label: string; evidence: EvidenceKind;
  example: (typeof cases)[keyof typeof cases]; handoff?: HandoffExample; self?: string; reply?: boolean;
};
const exchanges: SequenceExchange[] = [
  { path: [chat, host], label: "Send the customer message", evidence: "message", example: cases.chat },
  { path: [host, host], label: "Save the flow list for this chat", self: "Tenant defaults → domain overrides → chat audience", evidence: "flowList", example: cases.flowList },
  { path: [host, model], label: "Send the message and allowed flows", evidence: "flowRequest", example: cases.flowSelection },
  { path: [model, host], label: "Return the selected flow", reply: true, evidence: "flowResponse", example: cases.flowSelection },
  { path: [host, sfield, selector], label: "Request active topics and member scores", evidence: "lookup", example: cases.contexts },
  { path: [selector, sfield, host], label: "Return topics and member scores", reply: true, evidence: "lookup", example: cases.contexts },
  { path: [host, sfield, model], label: "Send the Context Router the chat, intents and topic scores", evidence: "router", example: cases.router, handoff: handoffs.router },
  { path: [model, sfield, host], label: "Return the proposed intent", reply: true, evidence: "router", example: cases.router },
  { path: [host, sfield, selector], label: "Check eligibility for the verified topic and member ID", evidence: "request", example: cases.treatment, handoff: handoffs.treatment },
  { path: [selector, sfield, host], label: "Eligible content, standalone action and workflow", reply: true, evidence: "decision", example: cases.treatment },
  { path: [host, data], label: "Resolve approved content from catalog", evidence: "content", example: cases.content },
  { path: [data, host], label: "Approved copy, disclosures & allowed components", reply: true, evidence: "content", example: cases.content },
  { path: [host, sfield, model], label: "Customer’s request and eligible candidates", evidence: "composer", example: cases.composer, handoff: handoffs.composer },
  { path: [model, sfield, host], label: "Return the proposed layout", reply: true, evidence: "composer", example: cases.composer },
  { path: [host, host], label: "Build the A2UI surface", self: "Apply the published layout and bind its data", evidence: "surface", example: cases.compileUi },
  { path: [host, chat], label: "Send the finished surface to chat", reply: true, evidence: "surface", example: cases.surface },
  { path: [chat, host], label: "Start the next turn from a button", evidence: "clicks", example: cases.followUp },
];
export type DiagramExchange = SequenceExchange & { number: number; inspectHandoff?: true };

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
          const isSelf = Boolean(exchange.self);
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
                  <span>{exchange.self}</span>
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
      Marcus’s address update uses the account-help flow. The composer proposes a layout, the app builds its A2UI surface with published content and customer data, and the browser renders the cards. Preview funding starts a separate turn.
    </figcaption>
  </figure>;
}

const decisionSteps = [
  { actor: "Chat and app server", title: "Receive the request", Icon: MessageSquare, kind: "message",
    description: "The app uses the flows allowed for Marcus’s chat. After account help is selected, sfield loads topics from TS and calls the Context Router to identify the address-update intent." },
  { actor: "sfield", title: "Ask TS what Marcus can do", Icon: Network, kind: "request",
    description: "sfield sends the verified topic and Marcus’s member ID to Treatment Selector." },
  { actor: "Treatment Selector", title: "Apply the business rules", Icon: ListFilter, kind: "decision",
    description: "TS checks eligibility and returns the content, actions and workflows that qualify." },
  { actor: "TS → sfield → chat", title: "Render the eligible recommendations", Icon: MessageSquare, kind: "surface",
    description: "sfield sends eligible content to the composer. The app verifies the layout and builds the cards and controls." },
  { actor: "Customer → sfield", title: "Follow Marcus’s click", Icon: GitBranch, kind: "clicks",
    description: "Inspect the recommendation Marcus chose and each tool sfield called, in execution order." },
] as const satisfies readonly { actor: string; title: string; Icon: typeof MessageSquare; kind: EvidenceKind; description: string }[];

export function TreatmentHandoffDiagram({ run }: { run: MarcusRun }) {
  const [active, setActive] = useState<number>();
  function stepButton(index: number) {
    const { actor, title, description, Icon } = decisionSteps[index];
    return <button type="button" className="ts-step-button" aria-haspopup="dialog"
      aria-label={`Step ${index + 1} · ${title}`} onClick={() => setActive(index)}>
      <span className="ts-step-actor"><Icon size={16} aria-hidden="true" />{index + 1} · {actor}<ChevronRight size={14} aria-hidden="true" /></span>
      <strong>{title}</strong><span className="ts-step-description">{description}</span>
    </button>;
  }
  return <figure className="ts-handoff" id="ts-sfield" aria-labelledby="ts-sfield-title">
    <header><h3 id="ts-sfield-title">How TS and sfield work together</h3>
      <p>Marcus Reed’s address update. Select a step to inspect its saved evidence.</p></header>
    <RunPicker run={run} />
    <ol className="ts-actors" aria-label="From customer request to eligibility decision">
      {decisionSteps.slice(0, 3).map((step, i) => <li key={step.kind}>{stepButton(i)}</li>)}
    </ol>
    <ol className="ts-delivery" start={4} aria-label="From decision to customer click">
      <li>{stepButton(3)}</li><li>{stepButton(4)}</li>
    </ol>
    {run.selected && <RecordedRecommendations run={run} />}
    {active !== undefined && <DeveloperDrawer title={`Step ${active + 1} · ${decisionSteps[active].title}`} icon={<Braces size={18} />}
      closeLabel="Close recorded step" close={() => setActive(undefined)} wide>
      <RecordedEvidence kind={decisionSteps[active].kind} run={run} />
    </DeveloperDrawer>}
  </figure>;
}

export function TreatmentEvolutionDiagram() {
  return <figure className="help-proposal-diagram" aria-label="Treatment Selector evolution">
    <ol className="help-proposal-flow help-evolution-stages" role="list">
      <li className="help-proposal-entity">
        <span className="help-evolution-stage"><ListFilter size={16} aria-hidden="true" /> Existing contract · v1</span>
        <h3>Rank eligible content</h3>
        <p>TS applies CCRE rules to the member and topic. It returns content IDs in priority order. The channel looks up the published copy for each ID.</p>
        <ArrowRight className="help-proposal-arrow" size={20} aria-hidden="true" />
      </li>
      <li className="help-proposal-entity">
        <span className="help-evolution-stage"><GitBranch size={16} aria-hidden="true" /> Chat proof of concept · v2</span>
        <h3>Recommend a workflow with a card</h3>
        <p>A rule can also return a workflow ID and version. Its <code>forContentIds</code> field identifies the eligible cards that can display the workflow.</p>
        <ArrowRight className="help-proposal-arrow" size={20} aria-hidden="true" />
      </li>
      <li className="help-proposal-entity">
        <span className="help-evolution-stage"><Zap size={16} aria-hidden="true" /> Available in chat · v2.1</span>
        <h3>Recommend a standalone action</h3>
        <p>A rule can recommend <code>account.address.prepare</code> directly. Chat can render its form even when the address guide is absent. The same decision can also recommend a funding workflow.</p>
      </li>
    </ol>
    <figcaption>
      A business owner can change the funding rule in TS and every channel using that decision sees the new eligibility.
      The team running sfield can change the tools in the funding workflow through Tool setup while TS continues to recommend the same reference.
    </figcaption>
  </figure>;
}
