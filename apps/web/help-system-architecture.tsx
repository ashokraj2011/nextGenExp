import { useId, useLayoutEffect, useRef, useState, type Ref } from "react";
import { ArrowUpRight, Braces, Cable, Database, Download, Layers, ListFilter, MessageSquare, Monitor, PanelsTopLeft, Server, Settings2, Wrench } from "lucide-react";
import { adminPaths } from "../../packages/contracts/admin-paths";
import { fundingPreviewWorkflow } from "../../packages/contracts/funding-workflow";
import { DeveloperDrawer } from "./developer-drawer";
import { RecordedEvidence, useFundingClick, type EvidenceKind, type MarcusRun } from "./help-run-evidence";
import { architectureSteps, type ArchitectureStep, type ArchitectureView as View } from "./help-architecture-steps";
import { ArrowReceipt } from "./help-arrow-evidence";
import "./help-system-architecture.css";

type ComponentId = "chat" | "host" | "runtime" | "model" | "selector" | "tools" | "compiler" | "renderer" | "setup" | "admin";
type Interface = { input: string; output: string };
type Component = {
  title: string; Icon: typeof Server; lines: string[]; compactLines?: string[]; db?: string; contract: string;
  message: Interface; funding?: Interface;
};
const components: Record<ComponentId, Component> = {
  chat: { title: "Customer chat", Icon: MessageSquare, lines: ["Message or follow-up"], contract: "chat",
    message: { input: "The customer’s message in an open thread.", output: "A turn request carrying the message and a client request ID." },
    funding: { input: "The customer selects Preview funding on a recommendation from TS.", output: "An action envelope with the surface, component and action IDs. The app uses the envelope to find the original recommendation." } },
  host: { title: "Turn controller", Icon: Server, lines: ["Selects the chat flow"], compactLines: ["Selects the flow"], db: "app.sqlite", contract: "flow-selection",
    message: { input: "The app saves the flows allowed for the thread’s tenant, domain and audience when it accepts the message. It reads recent turns from sfield’s chat harness.", output: "For model-based selection the app sends the message, recent context and allowed flows directly to the provider. It checks the returned flow ID. The account-help flow then asks sfield to discover topics and infer the specific intent." },
    funding: { input: "The issued action and its source decision, including the workflow ID and version.", output: "The ordered tool calls from the matching workflow definition in Tool setup. The app saves the resulting turn and surface." } },
  runtime: { title: "sfield runtime", Icon: Cable, lines: ["Model and tool calls"], db: "sfield.sqlite", contract: "router",
    message: { input: "A model request or a registered tool reference with inputs scoped to the current turn.", output: "Model proposals and tool results for the app to verify. The harness keeps chat history by tenant, domain, user, session and thread." },
    funding: { input: "The registered tools in the saved workflow, their order and the current turn reference.", output: "Each tool’s result. A later step can use an earlier result, such as the funding method selected for the preview." } },
  model: { title: "Model provider", Icon: Braces, lines: ["Flow selection", "Context Router", "Experience Composer"], compactLines: ["Selects flow", "Infers intent", "Proposes layout"], contract: "gateway",
    message: { input: "The app sends the configured flow choices. Inside account help, sfield sends the Context Router the message, recent chat, supported intents and TS topic scores. The Experience Composer receives the verified intent and eligible candidates.", output: "These calls return a flow ID, an intent or clarification, and a proposed layout or reply, respectively." },
    funding: { input: "The earlier message used the router and composer to present the recommendation.", output: "The ordered funding path uses the saved workflow definition for the click." } },
  selector: { title: "Treatment Selector", Icon: ListFilter, lines: ["Local CCRE rule engine", "Content, actions, workflows"], compactLines: ["Local CCRE rules", "Recommendations"], contract: "treatment",
    message: { input: "For discovery, sfield asks for supported topics and member topic scores. For eligibility, the TS adapter receives the MID and verified context.", output: "The legacy contract returns ranked content IDs. The chat contract also returns eligible actions and workflows by ID and version." },
    funding: { input: "On the earlier turn, TS evaluated the MID and address-update context.", output: "The matching rule recommended account.funding.preview at version 1.0.0. That saved reference identifies the workflow for this click." } },
  tools: { title: "Domain tools", Icon: Wrench, lines: ["Account reads", "Workflow steps"], contract: "portfolio",
    message: { input: "The sfield registry dispatches a tool reference with the current turn and its scoped inputs.", output: "A typed result, such as a portfolio snapshot, goal history or retirement account record. The verified experience uses the tools its topic needs." },
    funding: { input: "A turn reference and step-specific arguments. The preview builder receives a method ID from the options step.", output: "The tools return eligible funding methods and a preview of the chosen method and amount. A configured status check also returns the account’s funding status." } },
  compiler: { title: "UI compiler", Icon: Layers, lines: ["Published layouts", "and data bindings"], contract: "render",
    message: { input: "The verified layout, approved content, scoped data and eligible actions. Published domain layouts can customize the result.", output: "An A2UI surface with components, data bindings and issued action IDs. The server saves it and emits an experience.ready event." },
    funding: { input: "The verified result of the funding preview tool.", output: "A funding preview surface attached to the new chat turn." } },
  setup: { title: "Tenant and domain settings", Icon: Settings2, lines: ["Chat flows   ·   Published layouts   ·   CCRE rules   ·   Tools and workflows"],
    compactLines: ["Flows, layouts, rules, tools and workflows"], contract: "flow-selection",
    message: { input: "Tool setup saves tenant defaults and domain overrides in the routing_flow_settings table in app.sqlite. Each flow has an ID, an enabled setting, a description and example messages.",
      output: "The app starts with registered flows, applies tenant defaults and domain overrides, and keeps the flows allowed for the chat audience. A domain can narrow the tenant list. The turn retains its own copy." },
    funding: { input: "The workflow ID and version issued on the earlier chat turn.",
      output: "The matching definition supplies the execution mode and tool sequence for the funding preview." } },
  admin: { title: "Admin console", Icon: PanelsTopLeft, lines: ["Flows, rules and tools"], contract: "flow-selection",
    message: { input: "Admins set tenant defaults in Tool setup. Domain owners choose enabled flows and edit their descriptions and example messages for their domain.",
      output: "Saved flow settings apply to the next accepted message in that scope. Tool setup also manages rules and workflows, and UI Builder publishes layouts." } },
  renderer: { title: "A2UI renderer", Icon: Monitor, lines: ["Cards, forms and charts"], compactLines: ["Cards and forms"], contract: "render",
    message: { input: "The browser listens for turn events and fetches the completed turn with its A2UI surface.", output: "React renders the registered components. A follow-up click sends the issued action back to the app server." },
    funding: { input: "The completed workflow turn and its funding preview surface.", output: "A card showing the method and amount returned by the workflow." } },
};

// Coordinates in each layout share the same components, interfaces and direction of travel.
type Box = [x: number, y: number, width: number, height: number];
const wideNodes: Record<ComponentId, Box> = {
  chat: [30, 88, 172, 91], host: [303, 78, 211, 118], runtime: [655, 78, 266, 118], model: [1013, 83, 175, 106],
  setup: [303, 434, 624, 63], admin: [1013, 414, 176, 83],
  renderer: [30, 315, 172, 85], compiler: [303, 308, 211, 92], selector: [549, 308, 195, 92], tools: [771, 308, 156, 92],
};
const narrowNodes: Record<ComponentId, Box> = {
  chat: [22, 45, 155, 63], renderer: [225, 45, 153, 63], host: [20, 202, 160, 102], compiler: [228, 209, 152, 85],
  setup: [20, 708, 358, 65], admin: [106, 832, 188, 66],
  runtime: [20, 358, 180, 102], model: [261, 364, 128, 88], selector: [20, 600, 178, 75], tools: [224, 600, 154, 75],
};
type Stroke = { path: string; x: number; y: number; badges: [number, number][] };
type Connection = { from: ComponentId; to: ComponentId; label: string; click?: string; reply?: boolean; config?: boolean; wide: Stroke; narrow: Stroke };
const connections: Connection[] = [
  { from: "chat", to: "host", label: "Message", click: "Action ID", wide: { path: "M202 127 H303", x: 252, y: 106, badges: [[252,127]] }, narrow: { path: "M99 108 V202", x: 140, y: 146, badges: [[99,142]] } },
  { from: "setup", to: "host", label: "", config: true, wide: { path: "M313 434 V421 H288 V360 M288 348 V179 H303", x: 0, y: 0, badges: [[288,277]] }, narrow: { path: "M80 708 V687 H14 V276 H20", x: 0, y: 0, badges: [[75,687]] } },
  { from: "host", to: "model", label: "Allowed flows", wide: { path: "M489 78 V-19 H1052 V83", x: 745, y: -35, badges: [[745,-19]] }, narrow: { path: "M180 262 H205 V329 H284 V364", x: 246, y: 349, badges: [[269,329]] } },
  { from: "model", to: "host", label: "Selected flow", reply: true, wide: { path: "M1155 83 V-64 H444 V78", x: 778, y: -78, badges: [[778,-64]] }, narrow: { path: "M355 364 V308 H216 V283 H180", x: 326, y: 345, badges: [[330,308]] } },
  { from: "host", to: "runtime", label: "Run stage", click: "Run steps", wide: { path: "M514 115 H655", x: 584, y: 94, badges: [[584,115]] }, narrow: { path: "M65 304 V358", x: 38, y: 337, badges: [[65,335]] } },
  { from: "runtime", to: "host", label: "Result", reply: true, wide: { path: "M655 164 H514", x: 584, y: 143, badges: [[584,164]] }, narrow: { path: "M147 358 V304", x: 181, y: 337, badges: [[147,335]] } },
  { from: "runtime", to: "model", label: "Prompt", wide: { path: "M921 115 H1013", x: 967, y: 94, badges: [[950,115],[983,115]] }, narrow: { path: "M200 387 H261", x: 230, y: 370, badges: [[215,387],[245,387]] } },
  { from: "model", to: "runtime", label: "Proposal", reply: true, wide: { path: "M1013 164 H921", x: 967, y: 144, badges: [[950,164],[983,164]] }, narrow: { path: "M261 429 H200", x: 230, y: 413, badges: [[215,429],[245,429]] } },
  { from: "runtime", to: "selector", label: "MID + topic", wide: { path: "M705 196 V224 H609 V308", x: 564, y: 262, badges: [[609,251],[609,282]] }, narrow: { path: "M71 460 V600", x: 47, y: 579, badges: [[71,510],[71,544]] } },
  { from: "selector", to: "runtime", label: "Eligible recommendations", reply: true, wide: { path: "M650 308 V257 H746 V196", x: 696, y: 281, badges: [[679,257],[719,257]] }, narrow: { path: "M164 600 V460", x: 166, y: 561, badges: [[164,500],[164,534]] } },
  { from: "runtime", to: "tools", label: "Tool input", wide: { path: "M815 196 V222 H835 V308", x: 791, y: 252, badges: [[835,264]] }, narrow: { path: "M186 460 V478 H276 V600", x: 271, y: 508, badges: [[276,528]] } },
  { from: "tools", to: "runtime", label: "Data", click: "Result", reply: true, wide: { path: "M873 308 V235 H884 V196", x: 904, y: 259, badges: [[873,279]] }, narrow: { path: "M346 600 V491 H198 V460", x: 347, y: 581, badges: [[346,555]] } },
  { from: "host", to: "compiler", label: "Verified input", wide: { path: "M407 196 V308", x: 465, y: 255, badges: [[407,253]] }, narrow: { path: "M180 245 H228", x: 204, y: 227, badges: [[204,245]] } },
  { from: "compiler", to: "renderer", label: "A2UI surface", reply: true, wide: { path: "M303 354 H202", x: 252, y: 335, badges: [[252,354]] }, narrow: { path: "M301 209 V108", x: 349, y: 147, badges: [[301,142]] } },
  { from: "renderer", to: "chat", label: "Next click", click: "Show card", wide: { path: "M113 315 V179", x: 156, y: 233, badges: [[113,239]] }, narrow: { path: "M225 76 H177", x: 201, y: 59, badges: [[201,76]] } },
  { from: "admin", to: "setup", label: "Save", config: true, wide: { path: "M1013 463 H927", x: 969, y: 443, badges: [[969,463]] }, narrow: { path: "M200 832 V773", x: 231, y: 805, badges: [[200,801]] } },
  { from: "setup", to: "compiler", label: "", config: true, wide: { path: "M406 434 V400", x: 0, y: 0, badges: [[406,417]] },
    narrow: { path: "M36 708 V687 H14 V314 H59 M71 314 H140 M154 314 H301 V294", x: 0, y: 0, badges: [[36,690]] } },
  { from: "setup", to: "selector", label: "", config: true, wide: { path: "M647 434 V400", x: 0, y: 0, badges: [[647,417]] }, narrow: { path: "M106 708 V675", x: 0, y: 0, badges: [[106,690]] } },
  { from: "setup", to: "tools", label: "", config: true, wide: { path: "M847 434 V400", x: 0, y: 0, badges: [[847,417]] }, narrow: { path: "M301 708 V675", x: 0, y: 0, badges: [[301,690]] } },
];

function isEarlier(id: ComponentId, view: View, agent: boolean) {
  return view === "funding" && (id === "selector" || (id === "model" && !agent));
}

const diagramStyles = `
  .sa-canvas { font-family: Inter, system-ui, sans-serif; }
  .sa-boundary { fill: #f2f7f4; stroke: #afc8bb; stroke-width: 1.5; }
  .sa-browser { fill: #f2f6fa; stroke: #b8cad6; }
  .sa-area { fill: #3f5a4f; font-size: 16px; font-weight: 700; }
  .sa-boundary-note { fill: #53685d; font-size: 13px; }
  .sa-wire { fill: none; stroke: #2b6754; stroke-width: 1.8; stroke-linejoin: round; }
  .sa-return { stroke: #526b81; stroke-dasharray: 5 3; }
  .sa-config { stroke: #78735e; stroke-dasharray: 1 4; stroke-linecap: round; }
  .sa-link, .sa-number { cursor: pointer; }
  .sa-hit { fill: none; stroke: transparent; stroke-width: 16; pointer-events: stroke; }
  .sa-number { outline: none; }
  .sa-number circle { fill: #fff; stroke: #326a52; stroke-width: 1.7; }
  .sa-number[data-type="return"] circle { stroke: #526b81; }
  .sa-number[data-type="config"] circle { stroke: #78735e; }
  .sa-number rect { fill: transparent; }
  .sa-number text { fill: #204d3b; font-size: 12px; font-weight: 700; text-anchor: middle; }
  .sa-number:hover circle, .sa-number:focus-visible circle { fill: #234e3e; stroke: #0a4831; stroke-width: 2.5; }
  .sa-number:hover text, .sa-number:focus-visible text { fill: #fff; }
  .sa-label { fill: #334d41; font-size: 13px; font-weight: 550; text-anchor: middle; paint-order: stroke; stroke: #f8fbf9; stroke-width: 4px; stroke-linejoin: round; }
  .sa-node { cursor: pointer; outline: none; }
  .sa-box { fill: white; stroke: #a5bbaf; stroke-width: 1.3; }
  .sa-name { fill: #173b30; font-weight: 690; font-size: 17px; }
  .sa-text { fill: #40594f; font-size: 14px; }
  .sa-store { fill: #334e43; font: 12px ui-monospace, monospace; }
  .sa-divider { stroke: #d8e4dc; }
  .sa-node[data-key="runtime"] .sa-box { fill: #1d4b3e; stroke: #163e32; }
  .sa-node[data-key="runtime"] .sa-name { fill: white; }
  .sa-node[data-key="runtime"] .sa-text, .sa-node[data-key="runtime"] .sa-store { fill: #e2f3e8; }
  .sa-node[data-key="runtime"] .sa-divider { stroke: #487162; }
  .sa-node[data-key="setup"] .sa-box, .sa-node[data-key="admin"] .sa-box { fill: #f7f7f2; stroke: #c8c9b8; }
  .sa-node[data-key="model"] .sa-box { fill: #f4f1fb; stroke: #b6a9cf; }
  .sa-node[data-key="selector"] .sa-box { fill: #fcf7ea; stroke: #c6b178; }
  .sa-node[data-earlier="true"] .sa-box { fill: #f7f8f7; stroke: #b9c3bd; stroke-dasharray: 4 3; }
  .sa-node[data-earlier="true"] .sa-name, .sa-node[data-earlier="true"] .sa-text { fill: #59675e; }
  .sa-ring { fill: none; stroke: transparent; stroke-width: 2; }
  .sa-node[aria-pressed="true"] .sa-ring { stroke: #518574; }
  .sa-node:hover .sa-ring, .sa-node:focus-visible .sa-ring { stroke: #115c93; stroke-width: 3; }
  .sa-compact .sa-name { font-size: 16px; }
  .sa-compact .sa-text { font-size: 13.5px; }
`;

function ArchitectureDrawing({ compact, view, active, choose, svgRef, detailId, steps, openStep, agent }: {
  compact: boolean; view: View; active: ComponentId; choose: (id: ComponentId) => void;
  svgRef: Ref<SVGSVGElement>; detailId: string;
  steps: ArchitectureStep[]; openStep: (step: ArchitectureStep) => void; agent: boolean;
}) {
  const id = useId().replace(/[^a-z0-9_-]/gi, "");
  const boxes = compact ? narrowNodes : wideNodes;
  const funding = view === "funding";
  const wires = connections.map((wire) => ({
    wire, shape: compact ? wire.narrow : wire.wide,
    uses: steps.filter((step) => step.wire === wire.from + "-" + wire.to),
  })).filter(({ uses }) => uses.length);
  return <svg xmlns="http://www.w3.org/2000/svg" ref={svgRef} className={"sa-canvas" + (compact ? " sa-compact" : "")}
    viewBox={compact ? "0 0 400 929" : funding ? "0 0 1200 545" : "0 -100 1200 645"} role="group" aria-labelledby={id + "-title " + id + "-desc"}>
    <title id={id + "-title"}>{funding ? agent ? "Agent funding workflow architecture" : "Ordered funding workflow architecture" : "Chat system architecture"}</title>
    <desc id={id + "-desc"}>The browser sends a turn to the CEP app server. Inside the server the turn controller calls sfield.
      {funding ? " The funding click runs the recommended workflow. Treatment Selector participated in the earlier turn." :
        " The app resolves the tenant and domain flow settings and calls the model directly to select a flow. Inside account help, sfield gets topics and scores from Treatment Selector and calls the Context Router. Treatment Selector checks the verified topic and MID for eligible recommendations."}
      {" "}The UI compiler builds an A2UI surface for the browser. A customer click starts another turn. The admin workspace supplies domain rules, layouts and workflow definitions.</desc>
    <style>{diagramStyles}</style>
    <defs>{[["call", "#2b6754"], ["return", "#526b81"], ["config", "#78735e"]].map(([key, color]) =>
      <marker key={key} id={id + key} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
        <path d="M0 0 L8 4 L0 8 L2 4 Z" fill={color} /></marker>)}</defs>
    <rect y={!compact && !funding ? -100 : 0} width="100%" height="100%" fill="#fcfdfb" />
    <g aria-hidden="true">
      {compact ? <>
        <rect className="sa-boundary sa-browser" x="8" y="7" width="384" height="115" rx="10" />
        <path className="sa-boundary" d="M18 166 H382 Q392 166 392 176 V314 Q392 324 382 324 H250 Q240 324 240 334 V477 Q240 487 250 487 H382 Q392 487 392 497 V783 Q392 793 382 793 H18 Q8 793 8 783 V176 Q8 166 18 166 Z" />
        <text className="sa-area" x="22" y="32">Browser</text><text className="sa-area" x="200" y="188" textAnchor="middle">CEP app server · Node.js</text>
      </> : <>
        <rect className="sa-boundary sa-browser" x="12" y="30" width="207" height="395" rx="13" />
        <rect className="sa-boundary" x="277" y="16" width="671" height="499" rx="13" />
        <text className="sa-area" x="30" y="60">Browser</text><text className="sa-area" x="303" y="49">CEP app server</text>
        <text className="sa-boundary-note" x="922" y="49" textAnchor="end">Node.js process</text>
        <text className="sa-boundary-note" x="1014" y={funding ? 64 : 211}>Configured provider</text>
      </>}
    </g>
    {wires.map(({ wire, shape: { path, x, y }, uses }) => {
      const primary = uses.find((step) => step.kind === "treatment") ?? uses[0];
      let label = funding ? wire.click ?? wire.label : wire.label;
      if (compact && wire.from === "host" && wire.to === "compiler") label = "Verify";
      if (compact && wire.from === "host" && wire.to === "runtime") label = funding ? "Steps" : "Run";
      if (compact && wire.from === "host" && wire.to === "model") label = "Flows";
      if (compact && wire.from === "model" && wire.to === "host") label = "Choice";
      if (compact && wire.from === "renderer") label = funding ? "Card" : "Click";
      return <g className="sa-link" key={wire.from + wire.to} aria-hidden="true" onClick={() => {
        document.getElementById(id + "-arrow-" + primary.number)?.focus();
        openStep(primary);
      }}>
        <title>{uses.map((step) => step.number + " · " + step.title).join(" / ")}</title>
        <path className="sa-hit" d={path} />
        <path className={wire.config ? "sa-wire sa-config" : wire.reply ? "sa-wire sa-return" : "sa-wire"} d={path}
          markerEnd={`url(#${id}${wire.config ? "config" : wire.reply ? "return" : "call"})`} />
        {label && <text className="sa-label" x={x} y={y}>{label === "Eligible recommendations" ? <>
          <tspan x={x}>Eligible </tspan><tspan x={x} dy="15">recommendations</tspan></> : label}</text>}
      </g>;
    })}
    {steps.map((step) => {
      const { wire, shape, uses } = wires.find((item) => item.uses.includes(step))!;
      const [x, y] = shape.badges[uses.indexOf(step)];
      const label = "Arrow " + step.number + " · " + step.title;
      return <g className="sa-number" id={id + "-arrow-" + step.number} key={step.wire + step.kind}
        data-type={wire.config ? "config" : wire.reply ? "return" : "call"} transform={`translate(${x} ${y})`}
        role="button" aria-label={label} aria-haspopup="dialog" tabIndex={0} onClick={() => openStep(step)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openStep(step); }
        }}>
        <title>{label}</title><rect x="-14" y="-14" width="28" height="28" /><circle r="10" />
        <text y="4">{step.number}</text>
      </g>;
    })}
    {(Object.keys(components) as ComponentId[]).map((key) => {
      const { title, lines, compactLines, db, Icon } = components[key];
      const [x, y, w, h] = boxes[key];
      const earlier = isEarlier(key, view, agent);
      const body = earlier ? (key === "selector" ? ["Prior recommendation"] : ["Prior model call"])
        : funding && key === "tools" ? ["Funding methods", "and preview"] : funding && key === "model" ? ["Funding agent"] : compact && compactLines ? compactLines : lines;
      const nameY = compact ? 23 : 30;
      return <g key={key} className="sa-node" data-key={key} data-earlier={earlier} transform={`translate(${x} ${y})`}
        role="button" tabIndex={0} aria-label={title} aria-pressed={active === key} aria-controls={detailId}
        onClick={() => choose(key)} onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(key); }
        }}>
        <rect className="sa-ring" x="-3" y="-3" width={w + 6} height={h + 6} rx="11" />
        <rect className="sa-box" width={w} height={h} rx="8" />
        {!compact && <Icon x={12} y={nameY - 14} width={17} height={17} color={key === "runtime" ? "#d4eddf" : "#496758"} aria-hidden="true" />}
        <text className="sa-name" x={compact ? 11 : 36} y={nameY}>{title}</text>
        {body.map((line, i) => <text className="sa-text" key={line} x={compact ? 11 : 12} y={nameY + 23 + i * 18}>{line}</text>)}
        {db && <><path className="sa-divider" d={`M1 ${h - 31} H${w - 1}`} />
          <Database x={12} y={h - 22} width={13} height={13} color={key === "runtime" ? "#cfebdb" : "#526e60"} aria-hidden="true" />
          <text className="sa-store" x="31" y={h - 11}>{db}{compact ? "" : key === "runtime" ? " · threads & runs" : " · turns & UI"}</text></>}
      </g>;
    })}
    <g aria-hidden="true" transform={compact ? "translate(20 919)" : "translate(303 535)"}>
      <path className="sa-wire" d="M0 -4 H25" markerEnd={`url(#${id}call)`} /><text className="sa-boundary-note" x="34">Request</text>
      <path className="sa-wire sa-return" d="M112 -4 H137" markerEnd={`url(#${id}return)`} /><text className="sa-boundary-note" x="146">Response</text>
      <path className="sa-wire sa-config" d="M229 -4 H254" markerEnd={`url(#${id}config)`} /><text className="sa-boundary-note" x="263">Configuration</text>
    </g>
  </svg>;
}

function downloadMap(svg: SVGSVGElement, view: View) {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute("width", String(svg.viewBox.baseVal.width));
  copy.setAttribute("height", String(svg.viewBox.baseVal.height));
  copy.setAttribute("role", "img");
  copy.querySelectorAll(".sa-node, .sa-number").forEach((node) => {
    for (const name of ["role", "tabindex", "aria-controls", "aria-pressed", "aria-haspopup"]) node.removeAttribute(name);
  });
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: "image/svg+xml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = view === "message" ? "chat-system-architecture.svg" : "funding-workflow-architecture.svg";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SystemArchitecture({ run, selectContract }: { run: MarcusRun; selectContract: (id: string) => void }) {
  const [view, setView] = useState<View>("message");
  const [active, setActive] = useState<ComponentId>("runtime");
  const [compact, setCompact] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceKind>();
  const [arrow, setArrow] = useState<ArchitectureStep>();
  const frame = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const detailId = useId();
  useLayoutEffect(() => {
    const element = frame.current!;
    const measure = () => setCompact(element.clientWidth < 750);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const funding = view === "funding";
  const click = useFundingClick(run, funding || arrow?.kind === "click");
  const agent = funding && Boolean(click.data?.log.workflow?.agent);
  const steps = architectureSteps(view, agent);
  const selected = arrow && steps.find((step) => step.wire === arrow.wire && step.kind === arrow.kind);
  const component = components[active];
  const details = agent && active === "model" ? {
    input: "The funding agent receives the current workflow state and available tools.",
    output: "A proposed tool call, a customer question or a completed result. Each captured attempt is available on the model arrows.",
  } : funding ? component.funding ?? component.message : component.message;
  const contract = funding && (["runtime", "tools", "host", "setup"].includes(active) || (agent && active === "model")) ? "funding" : component.contract;
  const lookups: Record<ComponentId, EvidenceKind> = { admin: "decision", setup: "decision", chat: "message", host: "message", runtime: "router", model: "router", selector: "decision", tools: "lookup", compiler: "surface", renderer: "surface" };
  const receipt = funding && active !== "selector" && (active !== "model" || agent) ? "clicks" : lookups[active];
  function inspect(kind: EvidenceKind) {
    if (kind === "clicks") {
      const ref = fundingPreviewWorkflow.recommendation;
      run.chooseRecommendation("workflow/" + ref.id + "@" + ref.version);
    }
    setEvidence(kind);
  }
  return <section id="system-architecture" className="help-section sa-section" aria-labelledby="system-architecture-title">
    <div className="help-section-heading">
      <div><h2 id="system-architecture-title">System architecture</h2>
        <p className="help-exchange-description">Select a numbered arrow for Marcus’s recorded exchange or a component for its contract.</p></div>
      <a className="help-section-link" href="#ts-sfield">Inspect Marcus’s run <ArrowUpRight size={14} aria-hidden="true" /></a>
    </div>
    <figure className="sa-figure" aria-labelledby="system-architecture-title">
      <div className="sa-toolbar">
        <div className="sa-views" role="group" aria-label="Architecture view">
          <button type="button" aria-pressed={!funding} onClick={() => setView("message")}>Chat message</button>
          <button type="button" aria-pressed={funding} onClick={() => setView("funding")}>After a funding click</button>
        </div>
        {!funding && <><button type="button" className="sa-routing-link" onClick={() => setArrow(steps.find((step) => step.kind === "flowList"))}>How is the flow chosen?</button>
          <button type="button" className="sa-routing-link" onClick={() => setArrow(steps.find((step) => step.kind === "router"))}>How is intent derived?</button></>}
        <button type="button" className="sa-download" onClick={() => svg.current && downloadMap(svg.current, view)}>
          <Download size={15} aria-hidden="true" />Download SVG</button>
      </div>
      <div className="sa-drawing" ref={frame}><ArchitectureDrawing compact={compact} view={view} active={active} choose={setActive}
        svgRef={svg} detailId={detailId} steps={steps} openStep={setArrow} agent={agent} /></div>
      <figcaption>{funding ? "Preview funding starts a new turn. The app resolves the workflow version from the original TS recommendation. The tool calls show the order recorded for that click."
        : "The app chooses the flow. Within account help, sfield asks TS for topics and member scores, then asks the Context Router for the intent. Select an arrow to inspect that step for the recorded turn."}</figcaption>
    </figure>
    <section id={detailId} className="sa-detail" aria-label="Selected architecture component" aria-live="polite">
      <div className="sa-detail-head"><h3>{component.title}</h3><div>
        {active === "admin" ? <><a href={adminPaths.tools}>Tool setup</a><a href={adminPaths.builder}>UI Builder</a></> : <>
          <a href="#contracts" onClick={() => selectContract(contract)}>{contract === "portfolio" ? "Portfolio tool contract" : contract === "router" ? "Router contract" : "View contract"} <ArrowUpRight size={13} aria-hidden="true" /></a>
          {receipt === "router" ? <>
            <button type="button" onClick={() => inspect("router")}>Inspect router call</button>
            <button type="button" onClick={() => inspect("composer")}>Inspect composer call</button>
          </> : <button type="button" onClick={() => inspect(receipt)}>Inspect recorded {receipt === "clicks" ? "calls" : receipt === "decision" ? "decision" : "turn"}</button>}
        </>}
      </div></div>
      <dl><div><dt>Input</dt><dd>{details.input}</dd></div><div><dt>Output</dt><dd>{details.output}</dd></div></dl>
    </section>
    {evidence && <DeveloperDrawer title={component.title + " · Marcus’s run"} icon={<Braces size={18} />} closeLabel="Close recorded evidence" close={() => setEvidence(undefined)} wide>
      <RecordedEvidence run={run} kind={evidence} />
    </DeveloperDrawer>}
    {selected && <DeveloperDrawer title={"Arrow " + selected.number + " · " + selected.title} icon={<Braces size={18} />}
      closeLabel="Close arrow details" close={() => setArrow(undefined)} wide>
      <div className="sa-arrow-nav">
        <p>{funding ? "Preview funding" : "Address update"} · {selected.number} of {steps.length}</p>
        <button type="button" disabled={selected.number === 1} onClick={() => setArrow(steps[selected.number - 2])}>Previous arrow</button>
        <button type="button" disabled={selected.number === steps.length} onClick={() => setArrow(steps[selected.number])}>Next arrow</button>
        {selected.kind === "click" && <button type="button" onClick={() => {
          setView("funding"); setArrow(architectureSteps("funding", false)[0]);
        }}>Follow funding workflow</button>}
      </div>
      <ArrowReceipt key={selected.wire + selected.kind} step={selected} view={view} run={run} funding={click} />
    </DeveloperDrawer>}
  </section>;
}
