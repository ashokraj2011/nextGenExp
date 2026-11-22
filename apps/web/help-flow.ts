import balanceFixture from "../../fixtures/demo-balance-reads.json";
import contextFixture from "../../fixtures/contexts.json";
import goalFixture from "../../fixtures/demo-goal-progress.json";
import portfolioFixture from "../../fixtures/demo-portfolio-snapshots.json";
import propensityFixture from "../../fixtures/propensity.json";
import treatmentFixture from "../../fixtures/treatment-scenarios.json";
import host from "../../fixtures/host.json";
import type { ContextSelectionProposal, ExperienceProposal, Intent, ProposalBlock } from "../../packages/contracts/domain";
import { portfolioSummaryQuestion, type RoutingIntentId } from "../../packages/contracts/routing-intents";
import { mockRuleGlossary } from "../../packages/rule-glossary";

export type PayloadExample = { label: string; value: unknown };
export type FlowStep = {
  id: "chat" | "discovery" | "router" | "treatment" | "portfolio" | "goal" | "composer" | "glossary" | "render";
  title: string;
  role: string;
  description: string;
  input: PayloadExample;
  output: PayloadExample;
  contracts: string[];
  tool?: { title: string; description: string; input: PayloadExample; output: PayloadExample };
};
type Flow = { id: string; title: string; prompt: string; prior?: string; steps: FlowStep[] };

const turnRef = "turn_demo";
const catalogSnapshotId = "catalog_demo";
const decisionId = "decision_demo";
const routeDecisionId = "route_demo";
const mid = host.personas[0].syntheticMid;
const catalog = { ...contextFixture, contexts: contextFixture.contexts.filter(({ active }) => active) };
const propensity = {
  version: propensityFixture.version,
  classification: propensityFixture.classification,
  status: "available",
  scores: Object.entries(propensityFixture.defaults["demo-learner"]).map(([contextId, score]) => ({ contextId, score })),
};
const demoBalance = {
  fixtureVersion: balanceFixture.fixtureVersion,
  observedAt: "2026-11-22T00:00:00.000Z",
  values: balanceFixture.reads[0].values,
};
const { mid: _, ...portfolioAmounts } = portfolioFixture.snapshots[0];
const portfolio = {
  fixtureVersion: portfolioFixture.fixtureVersion, asOf: portfolioFixture.asOf,
  currency: portfolioFixture.currency, ...portfolioAmounts,
};
const { targetCents, history } = goalFixture.goals[0];
const homeGoal = { fixtureVersion: goalFixture.fixtureVersion, goalId: goalFixture.goalId, currency: goalFixture.currency, targetCents, history };

function chat(message: string): FlowStep {
  return {
    id: "chat", title: "Chat request", role: "Browser",
    description: "The browser sends the message and a client request ID in the active conversation. The host records the turn, binds it to the demo profile and streams updates.",
    input: { label: "POST /api/conversations/conversation_demo/turns", value: { message, clientRequestId: "request_demo" } },
    output: { label: "TurnAccepted · excerpt", value: { turnId: turnRef, eventsUrl: "/api/turns/" + turnRef + "/events", turn: { id: turnRef, status: "working", progress: "accepted" } } },
    contracts: ["chat"],
  };
}

const discovery: FlowStep = {
  id: "discovery", title: "Context discovery", role: "sfield tools",
  description: "sfield reads the active context catalog and advisory propensity scores. The host stores a scoped catalog snapshot. The router uses these inputs to evaluate the user's request.",
  input: { label: "Registry tool inputs", value: {
    "contexts.list": { turnRef }, "propensity.context.score": { turnRef, catalogSnapshotId },
  } },
  output: { label: "Catalog and propensity results", value: { catalog, propensity } },
  contracts: ["discovery", "domain"],
};

function routeProposal(intentId: RoutingIntentId, summary: string): ContextSelectionProposal {
  return {
    schemaVersion: "1.1", catalogSnapshotId, catalogVersion: catalog.catalogVersion,
    status: "selected", intentId, clarificationQuestion: null, replyText: null, summary,
  };
}

function router(description: string, value: object, proposal: ContextSelectionProposal): FlowStep {
  return {
    id: "router", title: "Context Router", role: "sfield · LLM 1", description,
    input: { label: "Routing envelope · excerpt", value: { inputType: "PznContextRoutingInput", catalogSnapshotId, ...value } },
    output: { label: "ContextSelectionProposal", value: proposal },
    contracts: ["router", "gateway"],
  };
}

function treatment(context: string, contentIds: string[], description: string): FlowStep {
  return {
    id: "treatment", title: "Treatment Selector", role: "Eligibility", description,
    input: { label: "sfield tool and adapter requests", value: {
      registryInput: { turnRef, routeDecisionId }, adapterInput: { mid, context },
    } },
    output: { label: "Ranked eligible content IDs", value: contentIds },
    contracts: ["treatment", "rules", "domain"],
  };
}

function composer(
  request: string, selectedContextId: string, selectedIntentId: RoutingIntentId, intent: Intent,
  candidates: { candidateId: string; title: string; tsRank: number }[], blocks: ProposalBlock[],
  description: string, introKey: ExperienceProposal["introKey"], followUpIds: string[] = [],
): FlowStep {
  const output: ExperienceProposal = {
    schemaVersion: "1.0", decisionId, status: "ready", intent, introKey, clarificationQuestion: null, blocks, followUpIds,
  };
  return {
    id: "composer", title: "Experience Composer", role: "sfield · LLM 2", description,
    input: { label: "Composition envelope · excerpt", value: {
      inputType: "PznExperienceCompositionInput", request, selectedContextId, selectedIntentId, intent,
      ...(selectedIntentId === "show_portfolio" && { portfolioSnapshotIncluded: true }),
      ...(selectedIntentId === "show_home_goal" && { goalProgressIncluded: true }),
      eligible: { decisionId, partial: false, selectionMode: "semantic_rerank", candidates },
    } },
    output: { label: "ExperienceProposal", value: output },
    contracts: ["composer", "domain"],
  };
}

function render(description: string, input: PayloadExample, output: PayloadExample): FlowStep {
  return { id: "render", title: "Verify and render", role: "Host + A2UI", description, input, output, contracts: ["render", "chat", "logs"] };
}

const comparePrompt = "Compare available and current balance.";
const summaryPrompt = "show me the summary";
const portfolioPrompt = "Let me know my portfolio summary.";
const goalPrompt = "Show my home-buying goal and savings progress.";
const retirementPrompt = "I'd like to learn about retirement.";
const rulePrompt = "Create rule";
const balanceRoute = routeProposal("show_balance", "Show the summary of the established balance topic.");
const portfolioRoute = routeProposal("show_portfolio", "Show the customer's demo portfolio.");
const goalRoute = routeProposal("show_home_goal", "Show progress toward a home down payment.");
const retirementRoute = routeProposal("retirement_learning", "Explain retirement planning basics.");
const balanceCard: ProposalBlock = { blockId: "b1", component: "PznMetricSummary", candidateIds: ["candidate_balance"], variant: "compact" };
const balanceComposer = composer(
  summaryPrompt, "balance", "show_balance", { topic: "Show demo balances", task: "show", summary: balanceRoute.summary },
  [{ candidateId: "candidate_balance", title: "Synthetic balance summary", tsRank: 5 }], [balanceCard],
  "The composer receives the verified intent and resolved eligible candidates. It requests the scoped balance read. sfield sends the tool result back to the same composer, which selects the balance summary card.",
  "summary", ["fu_compare_balances"],
);
balanceComposer.tool = {
  title: "Balance read and composer continuation",
  description: "The first composer exchange asks for the read. The next request includes the tool result as a tool message. The host verifies the proof before publishing the figures.",
  input: { label: "demo.balance.read arguments", value: {} },
  output: { label: "Tool result sent back to the composer", value: demoBalance },
};
balanceComposer.contracts = [...balanceComposer.contracts, "balance"];

export const helpFlows: Flow[] = [
  {
    id: "balance", title: "Balance summary", prompt: summaryPrompt, prior: comparePrompt,
    steps: [
      chat(summaryPrompt), discovery,
      router(
        "The host finds the previous verified balance topic and supplies show_balance for this clear follow-up. The LLM receives that reference along with the chat history and returns the structured routing decision.",
        {
          request: summaryPrompt,
          recent: [{
            request: comparePrompt, contextId: "balance", intentId: "compare_balances", clarificationQuestion: null,
            assistantReply: host.introCopy.comparison, displayedContent: ["Compare demo definitions"],
          }],
          summaryFollowUpIntentId: "show_balance",
        }, balanceRoute,
      ),
      treatment("balance", treatmentFixture.base.balance, "The host verifies the route before sfield calls the existing Treatment Selector interface through the mock adapter. The returned IDs are resolved to published catalog entries and scoped candidate IDs."),
      balanceComposer,
      render(
        "The host verifies the candidate and fresh balance proof, then compiles the A2UI surface. The browser renders registered components and uses the canonical display blocks as its fallback.",
        { label: "Verified inputs · excerpt", value: { block: balanceCard, balanceProofValues: demoBalance.values } },
        { label: "A2UI CreateSurfaceMessage · excerpt", value: {
          version: "1.0",
          createSurface: {
            surfaceId: "exp_demo", catalogId: "https://pzn.example.invalid/catalogs/v1.0/experience",
            dataModel: { intro: host.introCopy.summary },
            components: [
              { id: "root", component: "PznExperience", intro: { "@path": "/intro" }, children: ["block_1"], actionCount: 0, question: null, partial: false },
              { id: "block_1", component: "PznMetricSummary", title: "Synthetic balance summary", variant: "compact", observedAt: demoBalance.observedAt, values: demoBalance.values },
            ],
          },
        } },
      ),
    ],
  },
  {
    id: "portfolio", title: "Portfolio summary", prompt: portfolioPrompt,
    steps: [
      chat(portfolioPrompt), discovery,
      router("The model selects show_portfolio from the active intent catalog. The host validates the proposal and maps it to the portsum context.", { request: portfolioPrompt, recent: [] }, portfolioRoute),
      treatment("portsum", treatmentFixture.base.portsum, "The Treatment Selector mock evaluates the existing eligibility rule against demo cash. Alice's $12,500 meets the greater-than-$10,000 rule. Jordan's $10,000 equals the threshold, so his turn publishes the snapshot by itself."),
      {
        id: "portfolio", title: "Portfolio Snapshot", role: "Scoped read",
        description: "The portfolio provider returns the account values for the verified demo member. The host can reuse the snapshot read for eligibility and use the same values in the displayed summary.",
        input: { label: "portfolio.snapshot.read", value: { turnRef, routeDecisionId } },
        output: { label: "PortfolioSnapshot", value: portfolio },
        contracts: ["portfolio"],
      },
      composer(
        portfolioPrompt, "portsum", "show_portfolio", { topic: "Show portfolio summary", task: "show", summary: portfolioRoute.summary },
        [{ candidateId: "candidate_cash", title: "Explore investing options", tsRank: 2 }],
        [{ blockId: "b1", component: "PznContentCard", candidateIds: ["candidate_cash"], variant: "compact" }],
        "The model receives the eligible suggestion and a flag that the host already has the snapshot. If the suggestion is selected, the host uses the snapshot to fill in the cash amount.",
        "summary",
      ),
      render(
        "The host builds the portfolio snapshot from the scoped data and adds the eligible recommendation selected by the composer.",
        { label: "Verified inputs · excerpt", value: { portfolio, selectedCandidateId: "candidate_cash" } },
        { label: "DisplayExperience · excerpt", value: { status: "ready", blocks: [
          { component: "PznPortfolioSnapshot", props: portfolio },
          { component: "PznContentCard", props: { recommendation: true, title: "Explore investing options", body: "You have $12,500 in cash. Would you like to explore investing options?" } },
        ] } },
      ),
    ],
  },
  {
    id: "home-goal", title: "Home-buying goal", prompt: goalPrompt,
    steps: [
      chat(goalPrompt), discovery,
      router("The model chooses show_home_goal from the intent catalog. The host verifies the route and maps it to the goals context.", { request: goalPrompt, recent: [] }, goalRoute),
      treatment("goals", treatmentFixture.base.goals, "Treatment Selector returns the eligible home down payment template. The host resolves the ID to a published candidate before reading savings history."),
      {
        id: "goal", title: "Goal Progress", role: "Scoped read",
        description: "sfield reads the verified demo member's target and monthly savings history. The host checks the amounts and the order of the months.",
        input: { label: "goal.progress.read", value: { turnRef, routeDecisionId } },
        output: { label: "GoalProgress", value: homeGoal },
        contracts: ["goal"],
      },
      composer(
        goalPrompt, "goals", "show_home_goal", { topic: "Show home-buying goal", task: "show", summary: goalRoute.summary },
        [{ candidateId: "candidate_home_goal", title: "Home down payment", tsRank: 1 }],
        [{ blockId: "b1", component: "PznGoalProgress", candidateIds: ["candidate_home_goal"], variant: "expanded" }],
        "The model receives the eligible goal template and a flag that the host has the goal data. It selects the goal chart component.",
        "summary",
      ),
      render(
        "The host attaches the verified goal data to the A2UI card. The browser shows the saved amount, target, remaining gap and growth graph.",
        { label: "Verified inputs · excerpt", value: { selectedCandidateId: "candidate_home_goal", goal: homeGoal } },
        { label: "DisplayExperience · excerpt", value: { status: "ready", blocks: [{ component: "PznGoalProgress", props: { title: "Home down payment", goal: homeGoal } }] } },
      ),
    ],
  },
  {
    id: "retirement", title: "Retirement learning", prompt: retirementPrompt,
    steps: [
      chat(retirementPrompt), discovery,
      router("The model interprets the request as retirement learning. The host verifies the intent and selects the Learning context.", { request: retirementPrompt, recent: [] }, retirementRoute),
      treatment("learning", treatmentFixture.base.learning, "The Treatment Selector mock returns retirement learning content and includes the beneficiary reminder when the customer has missing beneficiary details. Alice is eligible for the reminder."),
      composer(
        retirementPrompt, "learning", "retirement_learning", { topic: "Learn about retirement", task: "explain", summary: retirementRoute.summary },
        [{ candidateId: "candidate_learning", title: "Retirement planning basics", tsRank: 1 }],
        [{ blockId: "b1", component: "PznContentCard", candidateIds: ["candidate_learning"], variant: "compact" }],
        "The model selects the retirement lesson from the eligible candidate bundle. The host can append the beneficiary reminder issued by Treatment Selector when the lesson is rendered.",
        "explanation",
      ),
      render(
        "The host renders the lesson with Alice's eligible beneficiary reminder. Its issued action starts a new turn for the beneficiary update guide.",
        { label: "Verified inputs · excerpt", value: { selectedCandidateId: "candidate_learning", eligibleReminder: "beneficiary_update" } },
        { label: "DisplayExperience · excerpt", value: { status: "ready", blocks: [
          { component: "PznContentCard", props: { title: "Retirement planning basics" } },
          { component: "PznContentCard", props: { title: "Update your beneficiaries" } },
        ], actions: [{ actionId: "action_demo", componentId: "follow_up_1", label: "See beneficiary update steps" }] } },
      ),
    ],
  },
  {
    id: "authoring", title: "Create rule", prompt: rulePrompt,
    steps: [
      chat(rulePrompt), discovery,
      router(
        "When rule authoring is enabled, the model selects the explicit rule-authoring intent. The host verifies the capability and proceeds to the glossary.",
        { request: rulePrompt, canCreateRule: true, recent: [] },
        { ...routeProposal("create_rule", "Open the CCRE rule editor."), status: "create_rule" },
      ),
      {
        id: "glossary", title: "CCRE glossary", role: "Scoped read",
        description: "sfield asks the glossary tool for namespaces, attributes and supported operators. The host validates the versioned response and passes it to the editor.",
        input: { label: "ccre.glossary.get", value: { turnRef, routerRunId: "run_demo" } },
        output: { label: "RuleGlossary", value: mockRuleGlossary },
        contracts: ["glossary", "rules"],
      },
      render(
        "A2UI opens the rule editor inside chat. Preview evaluates the draft for a demo profile and turn. Save registers the rule for subsequent Treatment Selector calls.",
        { label: "Rule editor properties · excerpt", value: { scenarioId: "normal", personaId: "demo-learner", glossary: { version: mockRuleGlossary.version } } },
        { label: "DisplayExperience · excerpt", value: { status: "ready", outcome: "create_rule", blocks: [{ component: "PznRuleCreation" }] } },
      ),
    ],
  },
  {
    id: "clarification", title: "Clarify intent", prompt: summaryPrompt, prior: "Hi",
    steps: [
      chat(summaryPrompt), discovery,
      router(
        "With a greeting as the only prior turn, the subject of the summary is unclear. The model proposes a portfolio clarification. The host displays the approved question and waits for the following chat turn.",
        { request: summaryPrompt, recent: [{ request: "Hi", contextId: null, intentId: null, clarificationQuestion: null, assistantReply: "Hi! What would you like to talk about?" }] },
        { ...routeProposal("show_portfolio", "Confirm whether the customer wants a portfolio summary."), status: "clarify", clarificationQuestion: portfolioSummaryQuestion },
      ),
      render(
        "The router's approved question appears in chat. A confirmation starts a new turn with that question in its history. Conversational replies can also go straight from the router to chat.",
        { label: "Verified clarification · excerpt", value: { status: "clarify", intentId: null, possibleIntentId: "show_portfolio", clarificationQuestion: portfolioSummaryQuestion } },
        { label: "DisplayExperience · excerpt", value: { status: "clarify", outcome: "clarify", question: portfolioSummaryQuestion, blocks: [], actions: [] } },
      ),
    ],
  },
];
