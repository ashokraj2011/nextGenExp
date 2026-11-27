import apiSource from "../../packages/contracts/api.ts?raw";
import httpInputsSource from "../../packages/contracts/http-inputs.ts?raw";
import modelInputsSource from "../../packages/contracts/model-inputs.ts?raw";
import routingSource from "../../packages/contracts/routing-intents.ts?raw";
import domainSource from "../../packages/contracts/domain.ts?raw";
import fundingWorkflowSource from "../../packages/contracts/funding-workflow.ts?raw";
import { defaultAgentFundingWorkflow, defaultFundingWorkflow } from "../../packages/contracts/funding-workflow";
import flowSettingsSource from "../../packages/contracts/routing-flows.ts?raw";
import registeredFlowsSource from "../../packages/contracts/capabilities-catalog.ts?raw";
import toolSetupSource from "../../packages/contracts/tool-setup.ts?raw";
import glossarySource from "../../packages/contracts/rule-glossary.ts?raw";
import portfolioSource from "../../packages/contracts/portfolio.ts?raw";
import goalSource from "../../packages/contracts/goal-progress.ts?raw";
import surfaceSource from "../../packages/contracts/surface.ts?raw";
import inspectorSource from "../../packages/contracts/inspector.ts?raw";
import recommendationProviderContractSource from "../../packages/contracts/recommendation-provider.ts?raw";
import empathyContractSource from "../../packages/contracts/empathy.ts?raw";
import { emotionalAssessmentJsonSchema, empathyAssessInputJsonSchema } from "../../packages/contracts/empathy";
import recommendationArbitratorSource from "../../packages/recommendations/index.ts?raw";
import treatmentAdapterSource from "../../packages/ts-adapter/index.ts?raw";
import treatmentFormatsSource from "../../packages/ts-adapter/recommendations.ts?raw";
import customerWorkflowsSource from "../../packages/contracts/customer-workflows.ts?raw";
import contentBundleSource from "../../packages/experience/content.ts?raw";
import portfolioProviderSource from "../../packages/portfolio-snapshot/index.ts?raw";
import goalProviderSource from "../../packages/goal-progress/index.ts?raw";
import { retirementAccountsResultSchema } from "../../packages/contracts/model-schemas";
import contextFixtureSource from "../../fixtures/contexts.json?raw";
import propensityFixtureSource from "../../fixtures/propensity.json?raw";
import treatmentFixtureSource from "../../fixtures/treatment-scenarios.json?raw";
import sfieldModelSource from "../../vendor/sfield/packages/core/src/types/model.ts?raw";
import traceSource from "./api.ts?raw";
import {
  routingOutputSchema, compositionOutputSchema, turnInputSchema, contextResultSchema, propensityInputSchema,
  propensityResultSchema, treatmentInputSchema, treatmentResultSchema, treatmentDecisionResultSchema, glossaryInputSchema, glossaryResultSchema,
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
  "LLM_PROVIDER=gateway",
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
          ["POST /api/conversations/:id/compact", "Trigger sfield ConversationCompactor on demand to summarize older turns."],
          ["POST /api/conversations/:id/fork", "Branch a new thread from any previous turn."],
          ["POST /api/folders/:id/update", "Save folder name or shared Project instructions."],
        ],
        files: [{ name: "http-inputs.ts", source: httpInputsSource }, { name: "api.ts", source: apiSource }],
      },
      {
        id: "empathy",
        title: "Empathy & life-event assessment (sfield)",
        description: "Host-governed sfield read tool (cep.empathy.assess@1.0.0) that evaluates chat + Customer 360 notes, drives empathetic personalization, writes new life events back to Customer 360, and sets excludePromotions for Recommendation Providers.",
        endpoints: [
          ["GET /api/admin/customers", "Read Customer 360 profiles including persisted life-event notes."],
          ["POST /api/admin/customers", "Update Customer 360 advisor notes read by cep.empathy.assess@1.0.0 on the next turn."],
        ],
        files: [
          jsonFile("empathy-assess.tool.json", {
            "cep.empathy.assess@1.0.0": { input: empathyAssessInputJsonSchema, output: emotionalAssessmentJsonSchema },
          }),
          { name: "empathy.ts", source: empathyContractSource },
        ],
      },
      {
        id: "flow-selection",
        title: "Chat flow selection",
        description: "The app resolves registered flows for the tenant, domain and chat audience. When it calls the model, it sends their IDs, descriptions and examples with the message and recent chat. It checks the returned capabilityId against the saved list.",
        endpoints: [
          ["GET /api/admin/routing-flows?scope=wealth", "Read inherited settings and overrides for Wealth. Use scope=tenant for tenant defaults."],
          ["POST /api/admin/routing-flows?scope=wealth", "Save domain overrides. The editor sends the revision in If-Match."],
          ["GET /api/admin/logs/:turnId", "Read the captured flow-selection request, response and ordered list for that turn."],
        ],
        files: [{ name: "routing-flows.ts", source: flowSettingsSource }, { name: "capabilities-catalog.ts", source: registeredFlowsSource }],
      },
      {
        id: "discovery",
        title: "Supported topics and relevance scores",
        description: "The mock Treatment Selector loads active topics from contexts.json. It uses the MID and test case to return scores from propensity.json for the requested topics.",
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
        description: "Inside account help, sfield sends the Context Router the message, recent chat, supported intents, topics and member scores. It identifies the request, asks a question, replies directly, or asks to open the rule editor.",
        files: [
          { name: "model-inputs.ts", source: modelInputsSource },
          jsonFile("context-selection-proposal.schema.json", routingOutputSchema),
          { name: "routing-intents.ts", source: routingSource },
        ],
      },
      {
        id: "gateway",
        title: "Model gateway",
        description: "The app and sfield use Copilot ACP by default. Administration → Model gateway shows the running provider and lets you activate an office gateway or the OpenAI API.",
        endpoints: [["POST /chat/completions", "Send a request to the configured model."]],
        files: [{ name: "sfield-model.ts", source: sfieldModelSource }, { name: "gateway.env.example", source: gatewaySettingsExample }],
      },
    ],
  },
  {
    title: "Personalization and tools",
    contracts: [
      {
        id: "providers",
        title: "Recommendation providers (sfield)",
        description: "One host-governed sfield tool (cep.recommendations.arbitrate@1.0.0) fans out across pluggable RecommendationProvider adapters (Treatment Selector + CCRE, Customer 360 NBA, IT Ops Runbooks, or external decisioning engines) and returns one normalized, priority-arbitrated bundle.",
        endpoints: [
          ["GET /api/admin/recommendation-providers", "List active RecommendationProvider adapters registered behind cep.recommendations.arbitrate@1.0.0."],
        ],
        files: [
          { name: "recommendation-provider.ts", source: recommendationProviderContractSource },
          { name: "recommendations-arbitrator.ts", source: recommendationArbitratorSource },
        ],
      },
      {
        id: "treatment",
        title: "Treatment Selector",
        description: "The sfield tool takes turnRef and routeDecisionId. The server uses them to send TS the MID and verified topic, plus accountId for a selected retirement account. V1 returns ordered content IDs. V2.0 adds workflows linked to eligible cards. Chat requests v2.1, which also allows independently eligible actions with an ID and version. The multi-step planner uses a separate v3 format that can also carry ranked capabilities.",
        files: [
          jsonFile("treatment-selector.tool.json", { input: treatmentInputSchema, output: treatmentResultSchema }),
          jsonFile("treatment-recommendations.tool.json", { input: treatmentInputSchema, output: treatmentRecommendationsResultSchema }),
          jsonFile("treatment-decisions.tool.json", { input: treatmentInputSchema, output: treatmentDecisionResultSchema }),
          { name: "recommendations.ts", source: treatmentFormatsSource },
          { name: "customer-workflows.ts", source: customerWorkflowsSource },
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
        id: "retirement-accounts",
        title: "Retirement account records",
        description: "Alice asks for her retirement accounts and then asks about the second one. The account service reads her Rollover IRA ending in 6105. Treatment Selector receives her MID, the learning context and the selected account ID. Its beneficiary rule determines whether the reminder appears.",
        files: [jsonFile("retirement-accounts.tool.json", { input: portfolioInputSchema, output: retirementAccountsResultSchema })],
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
        description: "After the customer clicks, the app looks up the workflow by ID and version. In saved tool order, sfield runs the configured steps in sequence. Agent-guided mode can ask the customer to choose a funding method.",
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
        description: "A rule can attach a versioned customer workflow to its content. Preview shows which content and workflows pass for the chosen member. Saving applies the rule to subsequent decisions.",
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
        description: "After TS checks eligibility, sfield sends the Experience Composer the verified intent and eligible content. It can choose a layout and follow-up buttons or continue in plain text when no content fits.",
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
