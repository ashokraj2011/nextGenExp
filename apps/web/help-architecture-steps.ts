export type ArchitectureView = "message" | "funding";
type Wire = "chat-host" | "host-runtime" | "runtime-model" | "model-runtime" | "runtime-selector" | "selector-runtime"
  | "runtime-tools" | "tools-runtime" | "runtime-host" | "host-compiler" | "compiler-renderer" | "renderer-chat"
  | "admin-setup" | "setup-host" | "host-model" | "model-host" | "setup-compiler" | "setup-selector" | "setup-tools";
export type ArrowEvidence = "submission" | "registry" | "discovery" | "router" | "treatment" | "domain" | "composer"
  | "stageResult" | "compile" | "deliver" | "click" | "workflow" | "workflowCalls" | "workflowResult" | "render"
  | "settings" | "layout" | "rules" | "toolSetup" | "fundingModel" | "flowList" | "flowRequest" | "flowResponse";
type Step = { wire: Wire; kind: ArrowEvidence; title: string };
export type ArchitectureStep = Step & { number: number };

const chat: Step[] = [
  { wire: "chat-host", kind: "submission", title: "Send the address-update message" },
  { wire: "setup-host", kind: "flowList", title: "Resolve the flows for this tenant, domain and audience" },
  { wire: "host-model", kind: "flowRequest", title: "Send the message and allowed flows to the model" },
  { wire: "model-host", kind: "flowResponse", title: "Return the selected flow to the app" },
  { wire: "host-runtime", kind: "registry", title: "Start topic discovery through sfield" },
  { wire: "runtime-selector", kind: "discovery", title: "Request supported topics and scores" },
  { wire: "selector-runtime", kind: "discovery", title: "Return topics and Marcus’s scores" },
  { wire: "runtime-model", kind: "router", title: "Ask the Context Router" },
  { wire: "model-runtime", kind: "router", title: "Return the proposed intent" },
  { wire: "runtime-selector", kind: "treatment", title: "Check eligibility for Marcus’s member ID and topic" },
  { wire: "selector-runtime", kind: "treatment", title: "Return eligible recommendations" },
  { wire: "runtime-tools", kind: "domain", title: "Request domain data when needed" },
  { wire: "tools-runtime", kind: "domain", title: "Return domain data when requested" },
  { wire: "runtime-model", kind: "composer", title: "Ask the Experience Composer" },
  { wire: "model-runtime", kind: "composer", title: "Return the proposed experience" },
  { wire: "runtime-host", kind: "stageResult", title: "Return the composer result to the controller" },
  { wire: "host-compiler", kind: "compile", title: "Compile the verified experience" },
  { wire: "compiler-renderer", kind: "deliver", title: "Deliver the address-update surface" },
  { wire: "renderer-chat", kind: "click", title: "Follow Marcus’s Preview funding click" },
];
const funding: Step[] = [
  { wire: "chat-host", kind: "submission", title: "Submit the Preview funding click" },
  { wire: "host-runtime", kind: "workflow", title: "Resolve the recommended workflow" },
  { wire: "runtime-tools", kind: "workflowCalls", title: "Call the funding tools in order" },
  { wire: "tools-runtime", kind: "workflowCalls", title: "Return the funding tool results" },
  { wire: "runtime-host", kind: "workflowResult", title: "Return the funding result" },
  { wire: "host-compiler", kind: "compile", title: "Compile the funding result" },
  { wire: "compiler-renderer", kind: "deliver", title: "Deliver the funding surface" },
  { wire: "renderer-chat", kind: "render", title: "Display the funding card" },
];
const agentCalls: Step[] = [
  { wire: "runtime-model", kind: "fundingModel", title: "Ask the funding agent for its next step" },
  { wire: "model-runtime", kind: "fundingModel", title: "Return the funding agent’s decision" },
];
const configuration: Step[] = [
  { wire: "admin-setup", kind: "settings", title: "Inspect the saved domain settings" },
  { wire: "setup-compiler", kind: "layout", title: "Inspect the layout used for this turn" },
  { wire: "setup-selector", kind: "rules", title: "Inspect the rules behind the recommendations" },
  { wire: "setup-tools", kind: "toolSetup", title: "Inspect the tools configured for this turn" },
];
export function architectureSteps(view: ArchitectureView, agent: boolean): ArchitectureStep[] {
  const path = view === "message" ? chat : agent ? [...funding.slice(0, 2), ...agentCalls, ...funding.slice(2)] : funding;
  const settings = configuration.filter((step) => view === "message" || step.kind !== "rules");
  return [...path, ...settings].map((step, index) => ({ ...step, number: index + 1 }));
}
