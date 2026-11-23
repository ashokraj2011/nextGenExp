import apiSource from "../../packages/contracts/api.ts?raw";
import httpInputsSource from "../../packages/contracts/http-inputs.ts?raw";
import modelInputsSource from "../../packages/contracts/model-inputs.ts?raw";
import routingSource from "../../packages/contracts/routing-intents.ts?raw";
import domainSource from "../../packages/contracts/domain.ts?raw";
import fundingWorkflowSource from "../../packages/contracts/funding-workflow.ts?raw";
import { defaultAgentFundingWorkflow, defaultFundingWorkflow } from "../../packages/contracts/funding-workflow";
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
import propensityFixtureSource from "../../fixtures/propensity.json?raw";
import treatmentFixtureSource from "../../fixtures/treatment-scenarios.json?raw";
import sfieldModelSource from "../../vendor/sfield/packages/core/src/types/model.ts?raw";
import traceSource from "./api.ts?raw";
import {
  routingOutputSchema, compositionOutputSchema, turnInputSchema, contextResultSchema, propensityInputSchema,
  propensityResultSchema, treatmentInputSchema, treatmentResultSchema, glossaryInputSchema, glossaryResultSchema,
  portfolioInputSchema, portfolioResultSchema, balanceInputSchema, balanceResultSchema,
  goalProgressInputSchema, goalProgressResultSchema,
  treatmentRecommendationsResultSchema, fundingAgentResultSchema, fundingOptionsResultSchema,
  fundingStatusResultSchema, fundingPreviewInputSchema, fundingPreviewResultSchema,
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
        description: "The browser starts a chat, sends each message with an ID, and gets progress updates and the finished reply.",
        endpoints: [
          ["GET /api/bootstrap", "Load demo profiles, test cases, saved chats, and the current mode."],
          ["POST /api/conversations", "Start a chat for a profile and test case."],
          ["GET /api/conversations/:id", "Load a saved chat and its messages."],
          ["POST /api/conversations/:id/turns", "Accept a message and return an ID for the request."],
          ["GET /api/turns/:id/events", "Send progress updates and replay missed updates."],
          ["GET /api/turns/:id", "Get the status and reply for a message."],
          ["POST /api/turns/:id/cancel", "Stop a request that is in progress."],
          ["POST /api/turns/:id/retry", "Try a saved request again."],
        ],
        files: [{ name: "http-inputs.ts", source: httpInputsSource }, { name: "api.ts", source: apiSource }],
      },
      {
        id: "discovery",
        title: "Supported topics and relevance scores",
        description: "The mock Treatment Selector loads active topics from contexts.json. It uses the member ID and test case to return scores from propensity.json for the requested topics.",
        files: [
          jsonFile("context-discovery.tools.json", {
            "contexts.list": { input: turnInputSchema, output: contextResultSchema },
            "propensity.context.score": { input: propensityInputSchema, output: propensityResultSchema },
          }),
          { name: "ts-adapter.ts", source: treatmentAdapterSource },
          { name: "contexts.json", source: contextFixtureSource },
          { name: "propensity.json", source: propensityFixtureSource },
        ],
      },
      {
        id: "router",
        title: "Context Router",
        description: "The first model call gets the message, recent chat, supported requests, and approved questions. It identifies the request, asks a question, replies directly, or asks to open the rule editor.",
        files: [
          { name: "model-inputs.ts", source: modelInputsSource },
          jsonFile("context-selection-proposal.schema.json", routingOutputSchema),
          { name: "routing-intents.ts", source: routingSource },
        ],
      },
      {
        id: "gateway",
        title: "Model gateway",
        description: "sfield sends the chat messages and expected response format to the model. Test mode supplies sample responses. You can configure extra request details for an office gateway.",
        endpoints: [["POST /chat/completions", "Send a request to the configured model."]],
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
        description: "The tool sends Treatment Selector a demo member ID and the checked topic. Address updates and next-step questions use version 2 to return content and any eligible workflow.",
        files: [
          jsonFile("treatment-selector.tool.json", { input: treatmentInputSchema, output: treatmentResultSchema }),
          jsonFile("treatment-recommendations.tool.json", { input: treatmentInputSchema, output: treatmentRecommendationsResultSchema }),
          { name: "ts-adapter.ts", source: treatmentAdapterSource },
          { name: "treatment-scenarios.json", source: treatmentFixtureSource },
        ],
      },
      {
        id: "balance",
        title: "Demo balance read",
        description: "The model asks for balances without passing account details. The tool looks up the right demo customer and returns the amounts and the time they were read.",
        files: [
          jsonFile("demo-balance.tool.json", { input: balanceInputSchema, output: balanceResultSchema }),
          { name: "domain.ts", source: domainSource },
        ],
      },
      {
        id: "portfolio",
        title: "Portfolio Snapshot",
        description: "The tool returns cash and investment balances in cents. A connected service can supply these figures through the provider interface.",
        files: [
          jsonFile("portfolio-snapshot.tool.json", { input: portfolioInputSchema, output: portfolioResultSchema }),
          { name: "portfolio.ts", source: portfolioSource },
          { name: "portfolio-provider.ts", source: portfolioProviderSource },
        ],
      },
      {
        id: "glossary",
        title: "CCRE glossary",
        description: "The glossary lists the groups, fields, value types, and comparisons you can use to build a rule.",
        files: [
          jsonFile("ccre-glossary.tool.json", { input: glossaryInputSchema, output: glossaryResultSchema }),
          { name: "rule-glossary.ts", source: glossarySource },
        ],
      },
      {
        id: "goal",
        title: "Goal Progress",
        description: "The tool returns the down payment target and monthly savings for the demo customer, in date order. Amounts use whole cents.",
        files: [
          jsonFile("goal-progress.tool.json", { input: goalProgressInputSchema, output: goalProgressResultSchema }),
          { name: "goal-progress.ts", source: goalSource },
          { name: "goal-progress-provider.ts", source: goalProviderSource },
        ],
      },
      {
        id: "funding",
        title: "Funding preview workflow",
        description: "The app resolves the workflow ID and version in Tool setup. The agent uses funding results to choose a next tool, ask for a method, or finish the preview.",
        files: [
          jsonFile("funding-preview.tools.json", {
            "funding.options.read": { input: turnInputSchema, output: fundingOptionsResultSchema },
            "funding.status.read": { input: turnInputSchema, output: fundingStatusResultSchema },
            "funding.preview.build": { input: fundingPreviewInputSchema, output: fundingPreviewResultSchema },
          }),
          jsonFile("funding-workflow.default.json", defaultAgentFundingWorkflow),
          jsonFile("funding-workflow.saved-order.json", defaultFundingWorkflow),
          jsonFile("funding-agent.result.json", fundingAgentResultSchema),
          { name: "funding-workflow.ts", source: fundingWorkflowSource },
        ],
      },
      {
        id: "rules",
        title: "Rule authoring and Tool setup",
        description: "These formats cover tool settings, sample rules, and previews. The demo checks the conditions entered in the form and saves any optional CCRE rule text.",
        endpoints: [
          ["GET /api/admin/tools", "Load tool settings, rule fields, and available content."],
          ["POST /api/admin/tools", "Save tool settings and check that nobody else edited them first."],
          ["POST /api/admin/treatment-preview", "Preview what a demo profile would see for a test case and message number."],
          ["POST /api/admin/ccre-rules", "Add a rule for a test case, topic, and piece of content."],
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
        description: "The second model call gets the checked request and matching content. It can choose a layout and follow-up buttons or continue in plain text when no content fits.",
        files: [
          { name: "model-inputs.ts", source: modelInputsSource },
          jsonFile("experience-proposal.schema.json", compositionOutputSchema),
          { name: "content-bundle.ts", source: contentBundleSource },
        ],
      },
      {
        id: "domain",
        title: "Decisions, content and proof",
        description: "These formats tie the topic, content, and account figures to the message they answer. Each content item includes its version, source, and display options.",
        files: [{ name: "domain.ts", source: domainSource }],
      },
      {
        id: "render",
        title: "A2UI surfaces and actions",
        description: "The app tells A2UI which cards, forms, and buttons to show. When the customer clicks a button, chat sends its ID back.",
        endpoints: [
          ["POST /api/experiences/:id/actions", "Check the selected button and start the next request."],
          ["POST /api/events", "Record what was shown and any feedback."],
        ],
        files: [{ name: "surface.ts", source: surfaceSource }, { name: "http-inputs.ts", source: httpInputsSource }],
      },
      {
        id: "logs",
        title: "Inspector and call logs",
        description: "Logs show model and tool requests, replies, and whether each call worked. Logs hide credentials and configured private values.",
        endpoints: [
          ["GET /api/debug/turns/:id", "See the topic, which content matched, and what was displayed."],
          ["GET /api/debug/payloads/:id", "See model and tool requests and responses for the chosen message."],
        ],
        files: [{ name: "inspector.ts", source: inspectorSource }, { name: "web-api.ts", source: traceSource }],
      },
    ],
  },
] satisfies { title: string; contracts: Contract[] }[];

export const contractList: Contract[] = helpContracts.flatMap(({ contracts }) => contracts);
