import apiSource from "../../packages/contracts/api.ts?raw";
import httpInputsSource from "../../packages/contracts/http-inputs.ts?raw";
import modelInputsSource from "../../packages/contracts/model-inputs.ts?raw";
import routingSource from "../../packages/contracts/routing-intents.ts?raw";
import domainSource from "../../packages/contracts/domain.ts?raw";
import toolSetupSource from "../../packages/contracts/tool-setup.ts?raw";
import glossarySource from "../../packages/contracts/rule-glossary.ts?raw";
import portfolioSource from "../../packages/contracts/portfolio.ts?raw";
import goalSource from "../../packages/contracts/goal-progress.ts?raw";
import surfaceSource from "../../packages/contracts/surface.ts?raw";
import inspectorSource from "../../packages/contracts/inspector.ts?raw";
import treatmentAdapterSource from "../../packages/ts-adapter/index.ts?raw";
import contentBundleSource from "../../packages/experience/content.ts?raw";
import portfolioProviderSource from "../../packages/portfolio-snapshot/index.ts?raw";
import goalProviderSource from "../../packages/goal-progress/index.ts?raw";
import contextFixtureSource from "../../fixtures/contexts.json?raw";
import treatmentFixtureSource from "../../fixtures/treatment-scenarios.json?raw";
import sfieldModelSource from "../../vendor/sfield/packages/core/src/types/model.ts?raw";
import traceSource from "./api.ts?raw";
import {
  routingOutputSchema, compositionOutputSchema, turnInputSchema, contextResultSchema, propensityInputSchema,
  propensityResultSchema, treatmentInputSchema, treatmentResultSchema, glossaryInputSchema, glossaryResultSchema,
  portfolioInputSchema, portfolioResultSchema, balanceInputSchema, balanceResultSchema,
  goalProgressInputSchema, goalProgressResultSchema,
} from "../../packages/contracts/model-schemas";

export type ContractFile = { name: string; source: string };
type Contract = {
  id: string;
  title: string;
  description: string;
  files: ContractFile[];
  endpoints?: [path: string, purpose: string][];
};

function jsonFile(name: string, value: unknown): ContractFile {
  return { name, source: JSON.stringify(value, null, 2) + "\n" };
}

const gatewaySettingsExample = [
  "LLM_BASE_URL=https://gateway.example.invalid/v1",
  "LLM_MODEL=your-model-alias",
  "LLM_API_KEY=",
  "LLM_CONTEXT_WINDOW=16384",
  "LLM_MAX_OUTPUT_TOKENS=1500",
  'LLM_GATEWAY_HEADERS_JSON=\'{"X-Client-Id":"pzn-lab","X-Gateway-Context":{"environment":"demo"}}\'',
  'LLM_GATEWAY_BODY_JSON=\'{"metadata":{"application":"pzn-lab"}}\'',
  "",
].join("\n");

export const helpContracts = [
  {
    title: "Chat and routing",
    contracts: [
      {
        id: "chat",
        title: "Chat API and turn events",
        description: "The browser creates a conversation, submits turns with a client request ID, and receives progress and completed experiences over server-sent events.",
        endpoints: [
          ["GET /api/bootstrap", "Load the demo profiles, scenarios, conversations and mode."],
          ["POST /api/conversations", "Start a conversation for a profile and scenario."],
          ["GET /api/conversations/:id", "Restore a conversation and its turns."],
          ["POST /api/conversations/:id/turns", "Accept a chat message and issue a turn ID."],
          ["GET /api/turns/:id/events", "Stream and replay turn events."],
          ["GET /api/turns/:id", "Read the current turn and its experience."],
          ["POST /api/turns/:id/cancel", "Stop an active turn."],
          ["POST /api/turns/:id/retry", "Submit a new attempt for a saved turn."],
        ],
        files: [{ name: "http-inputs.ts", source: httpInputsSource }, { name: "api.ts", source: apiSource }],
      },
      {
        id: "discovery",
        title: "Context catalog and propensity",
        description: "The catalog lists active Treatment Selector contexts. Propensity provides advisory scores for those contexts, including an unavailable status when scores cannot be read.",
        files: [
          jsonFile("context-discovery.tools.json", {
            "contexts.list": { input: turnInputSchema, output: contextResultSchema },
            "propensity.context.score": { input: propensityInputSchema, output: propensityResultSchema },
          }),
          { name: "contexts.json", source: contextFixtureSource },
        ],
      },
      {
        id: "router",
        title: "Context Router",
        description: "The input carries the latest message, recent turns, active intents and approved questions. The structured output selects an intent, requests clarification, replies, or opens the rule editor.",
        files: [
          { name: "model-inputs.ts", source: modelInputsSource },
          jsonFile("context-selection-proposal.schema.json", routingOutputSchema),
          { name: "routing-intents.ts", source: routingSource },
        ],
      },
      {
        id: "gateway",
        title: "Model gateway",
        description: "sfield compiles model requests into streamed Chat Completions requests with messages and a structured response format. Test mode uses a deterministic gateway through the same contract. The server supports additional headers and body fields for a deployed gateway.",
        endpoints: [["POST /chat/completions", "Run a model stage using the configured gateway prefix."]],
        files: [{ name: "sfield-model.ts", source: sfieldModelSource }, { name: "gateway.env.example", source: gatewaySettingsExample }],
      },
    ],
  },
  {
    title: "Personalization and tools",
    contracts: [
      {
        id: "treatment",
        title: "Treatment Selector",
        description: "The registered tool accepts a turn and verified route ID. The adapter receives the synthetic member ID and context and returns ranked eligible content IDs.",
        files: [
          jsonFile("treatment-selector.tool.json", { input: treatmentInputSchema, output: treatmentResultSchema }),
          { name: "ts-adapter.ts", source: treatmentAdapterSource },
          { name: "treatment-scenarios.json", source: treatmentFixtureSource },
        ],
      },
      {
        id: "balance",
        title: "Demo balance read",
        description: "The composer requests synthetic balances with empty arguments. The tool derives the member and verified decision from the run scope and returns timestamped demo values.",
        files: [
          jsonFile("demo-balance.tool.json", { input: balanceInputSchema, output: balanceResultSchema }),
          { name: "domain.ts", source: domainSource },
        ],
      },
      {
        id: "portfolio",
        title: "Portfolio Snapshot",
        description: "The scoped read returns cash, equities and fixed income in cents. The provider interface gives an enterprise adapter the same request and response boundary.",
        files: [
          jsonFile("portfolio-snapshot.tool.json", { input: portfolioInputSchema, output: portfolioResultSchema }),
          { name: "portfolio.ts", source: portfolioSource },
          { name: "portfolio-provider.ts", source: portfolioProviderSource },
        ],
      },
      {
        id: "glossary",
        title: "CCRE glossary",
        description: "The glossary response defines versioned namespaces, attributes, value types and operators for the rule editor.",
        files: [
          jsonFile("ccre-glossary.tool.json", { input: glossaryInputSchema, output: glossaryResultSchema }),
          { name: "rule-glossary.ts", source: glossarySource },
        ],
      },
      {
        id: "goal",
        title: "Goal Progress",
        description: "The scoped tool returns the home down payment target and savings history for the eligible demo member. Monthly values are ordered and amounts use integer cents.",
        files: [
          jsonFile("goal-progress.tool.json", { input: goalProgressInputSchema, output: goalProgressResultSchema }),
          { name: "goal-progress.ts", source: goalSource },
          { name: "goal-progress-provider.ts", source: goalProviderSource },
        ],
      },
      {
        id: "rules",
        title: "Rule authoring and Tool setup",
        description: "These contracts define treatment overrides, scoped CCRE mock rules, preview inputs and evaluation results. The mock evaluates structured conditions and stores optional CCRE source text.",
        endpoints: [
          ["GET /api/admin/tools", "Read the current setup, glossary and available treatments."],
          ["POST /api/admin/tools", "Save a tool configuration with its revision for concurrent edits."],
          ["POST /api/admin/treatment-preview", "Preview eligible content for a persona, scenario and turn."],
          ["POST /api/admin/ccre-rules", "Add a rule for a scenario, context and treatment."],
        ],
        files: [{ name: "tool-setup.ts", source: toolSetupSource }, { name: "rule-glossary.ts", source: glossarySource }],
      },
    ],
  },
  {
    title: "Composition and delivery",
    contracts: [
      {
        id: "composer",
        title: "Experience Composer",
        description: "The input contains the verified intent and eligible candidates. The proposal selects display components, scoped candidate IDs and available follow-ups.",
        files: [
          { name: "model-inputs.ts", source: modelInputsSource },
          jsonFile("experience-proposal.schema.json", compositionOutputSchema),
          { name: "content-bundle.ts", source: contentBundleSource },
        ],
      },
      {
        id: "domain",
        title: "Decisions, content and proof",
        description: "Shared domain types bind catalogs, routes, content decisions and data proof to a conversation and turn. The content contract carries versions, disclosures, source references and supported components.",
        files: [{ name: "domain.ts", source: domainSource }],
      },
      {
        id: "render",
        title: "A2UI surfaces and actions",
        description: "The host compiles a versioned A2UI surface using the registered component catalog. A follow-up sends an issued action ID back to the host.",
        endpoints: [
          ["POST /api/experiences/:id/actions", "Validate a follow-up action and start its next turn."],
          ["POST /api/events", "Record rendering and feedback."],
        ],
        files: [{ name: "surface.ts", source: surfaceSource }, { name: "http-inputs.ts", source: httpInputsSource }],
      },
      {
        id: "logs",
        title: "Inspector and call logs",
        description: "Local logs expose recorded model bodies, tool inputs, results and attempt status. Captured exchanges redact credentials and configured metadata values.",
        endpoints: [
          ["GET /api/debug/turns/:id", "Read the trace, route decisions and eligibility details."],
          ["GET /api/debug/payloads/:id", "Read model and tool payloads for the selected turn."],
        ],
        files: [{ name: "inspector.ts", source: inspectorSource }, { name: "web-api.ts", source: traceSource }],
      },
    ],
  },
] satisfies { title: string; contracts: Contract[] }[];

export const contractList: Contract[] = helpContracts.flatMap(({ contracts }) => contracts);
