import balanceFixture from "../../fixtures/demo-balance-reads.json";
import contextFixture from "../../fixtures/contexts.json";
import goalFixture from "../../fixtures/demo-goal-progress.json";
import portfolioFixture from "../../fixtures/demo-portfolio-snapshots.json";
import propensityFixture from "../../fixtures/propensity.json";
import treatmentFixture from "../../fixtures/treatment-scenarios.json";
import host from "../../fixtures/host.json";
import type { ContextSelectionProposal, ExperienceProposal, Intent, ProposalBlock } from "../../packages/contracts/domain";
import { portfolioSummaryQuestion, routingIntents, type RoutingIntentId } from "../../packages/contracts/routing-intents";
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
type Flow = { id: string; title: string; prompt: string; prior?: string; persona?: string; steps: FlowStep[] };

const turnRef = "turn_demo";
const catalogSnapshotId = "catalog_demo";
const decisionId = "decision_demo";
const routeDecisionId = "route_demo";
const mid = host.personas[0].syntheticMid;
const newAccount = host.personas.find(({ personaId }) => personaId === "demo-new-account")!;
const catalog = { ...contextFixture, contexts: contextFixture.contexts.filter(({ active }) => active) };
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
    description: "The browser sends the message with an ID. The app saves it to the demo customer’s chat and sends back progress updates.",
    input: { label: "POST /api/conversations/conversation_demo/turns", value: { message, clientRequestId: "request_demo" } },
    output: { label: "TurnAccepted · excerpt", value: { turnId: turnRef, eventsUrl: "/api/turns/" + turnRef + "/events", turn: { id: turnRef, status: "working", progress: "accepted" } } },
    contracts: ["chat"],
  };
}

function discoveryFor(personaId: keyof typeof propensityFixture.defaults): FlowStep {
  const scores: Record<string, number> = propensityFixture.defaults[personaId];
  const propensity = {
    version: propensityFixture.version, classification: propensityFixture.classification, status: "available",
    scores: catalog.contexts.map(({ contextId }) => ({ contextId, score: scores[contextId] ?? null })),
  };
  return {
    id: "discovery", title: "Load supported topics", role: "sfield tools",
    description: "sfield fetches the supported topics and scores that suggest which ones may fit. The app saves a copy of the list for this message and sends it to the first model call.",
    input: { label: "Tool requests", value: {
      "contexts.list": { turnRef }, "propensity.context.score": { turnRef, catalogSnapshotId },
    } },
    output: { label: "Topics and relevance scores", value: { catalog, propensity } },
    contracts: ["discovery", "domain"],
  };
}
const discovery = discoveryFor("demo-learner");

function routeProposal(intentId: RoutingIntentId, summary: string): ContextSelectionProposal {
  return {
    schemaVersion: "1.1", catalogSnapshotId, catalogVersion: catalog.catalogVersion,
    status: "selected", intentId, clarificationQuestion: null, replyText: null, summary,
  };
}

function router(description: string, value: object, proposal: ContextSelectionProposal): FlowStep {
  return {
    id: "router", title: "Context Router", role: "First model call", description,
    input: { label: "What the model receives · excerpt", value: { inputType: "PznContextRoutingInput", catalogSnapshotId, ...value } },
    output: { label: "ContextSelectionProposal", value: proposal },
    contracts: ["router", "gateway"],
  };
}

function treatment(context: string, contentIds: string[], description: string, memberId = mid): FlowStep {
  return {
    id: "treatment", title: "Treatment Selector", role: "Finds matching content", description,
    input: { label: "Tool request and what Treatment Selector receives", value: {
      registryInput: { turnRef, routeDecisionId }, adapterInput: { mid: memberId, context },
    } },
    output: { label: "Matching content IDs in order", value: contentIds },
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
    id: "composer", title: "Experience Composer", role: "Second model call", description,
    input: { label: "What the model receives · excerpt", value: {
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
  return { id: "render", title: "Check and display", role: "App and A2UI", description, input, output, contracts: ["render", "chat", "logs"] };
}

const comparePrompt = "Compare available and current balance.";
const summaryPrompt = "show me the summary";
const portfolioPrompt = "Let me know my portfolio summary.";
const goalPrompt = "Show my home-buying goal and savings progress.";
const retirementPrompt = "I'd like to learn about retirement.";
const addressPrompt = "I moved and need to update my address.";
const rulePrompt = "Create rule";
const balanceRoute = routeProposal("show_balance", "Show the summary of the established balance topic.");
const portfolioRoute = routeProposal("show_portfolio", "Show the customer's demo portfolio.");
const goalRoute = routeProposal("show_home_goal", "Show progress toward a home down payment.");
const retirementRoute = routeProposal("retirement_learning", "Explain retirement planning basics.");
const addressRoute = routeProposal("update_address", "Show the mailing address update steps.");
const balanceCard: ProposalBlock = { blockId: "b1", component: "PznMetricSummary", candidateIds: ["candidate_balance"], variant: "compact" };
const balanceComposer = composer(
  summaryPrompt, "balance", "show_balance", { topic: "Show demo balances", task: "show", summary: balanceRoute.summary },
  [{ candidateId: "candidate_balance", title: "Synthetic balance summary", tsRank: 5 }], [balanceCard],
  "The composer gets the checked request and matching content. It asks the balance tool for the figures, then chooses a balance summary card.",
  "summary", ["fu_compare_balances"],
);
balanceComposer.tool = {
  title: "How the model gets the balances",
  description: "The model asks for the balances. sfield sends back the figures, and the app checks that they came from that tool call before showing them.",
  input: { label: "demo.balance.read arguments", value: {} },
  output: { label: "Balances sent back to the model", value: demoBalance },
};
balanceComposer.contracts = [...balanceComposer.contracts, "balance"];

const addressContext = "address-update";
const addressCatalog = { ...catalog, contexts: catalog.contexts.filter(({ contextId }) => contextId === addressContext) };
const addressContentIds = treatmentFixture.base[addressContext];
const addressCandidateId = "candidate_address";
const addressExperienceId = "exp_demo";
const addressFollowUp = { actionId: "action_demo", componentId: "follow_up_1", label: "See demo transfer steps" };
const addressBlocks = [
  { component: "PznStepList", props: { title: "Update your mailing address" } },
  { component: "PznContentCard", props: { title: "Fund your account", recommendation: true } },
];
const addressSteps = {
  chat: chat(addressPrompt),
  discovery: discoveryFor("demo-new-account"),
  router: router(
    "The model recognizes the mailing address change and returns update_address. The app checks it and picks Address update as the topic.",
    { request: addressPrompt, recent: [], catalog: addressCatalog, intentCatalog: routingIntents.filter(({ contextId }) => contextId === addressContext) },
    addressRoute,
  ),
  treatment: treatment(
    addressContext, addressContentIds,
    "Treatment Selector gets Marcus’s demo member ID and the topic. His account is waiting for a first deposit, so the rule adds fund_account to the address guide.",
    newAccount.syntheticMid,
  ),
  composer: composer(
    addressPrompt, addressContext, "update_address", { topic: "Update mailing address", task: "guide", summary: addressRoute.summary },
    [{ candidateId: addressCandidateId, title: addressBlocks[0].props.title, tsRank: 1 }],
    [{ blockId: "b1", component: "PznStepList", candidateIds: [addressCandidateId], variant: "expanded" }],
    "The model chooses the address guide. The app checks the choices and adds the funding card that Treatment Selector returned.",
    "steps",
  ),
  render: render(
    "Chat shows the address guide and the funding card. The button opens the transfer walkthrough.",
    { label: "Verified inputs · excerpt", value: { selectedCandidateId: addressCandidateId, eligibleFundingCard: "fund_account" } },
    { label: "DisplayExperience · excerpt", value: { status: "ready", blocks: addressBlocks, actions: [addressFollowUp] } },
  ),
};

export const addressUpdateExample = {
  persona: newAccount.displayName,
  prompt: addressPrompt,
  exchanges: {
    chat: addressSteps.chat,
    contexts: {
      description: "sfield asks which topics are supported. This example shows the Address update topic used for Marcus’s message.",
      input: { label: "contexts.list", value: { turnRef } },
      output: { label: "ContextCatalog · excerpt", value: addressCatalog },
    },
    router: addressSteps.router,
    treatment: addressSteps.treatment,
    content: {
      description: "The app uses the returned IDs to look up the address guide and funding card. It gives each item an ID for this message.",
      input: { label: "Content IDs to look up", value: addressContentIds },
      output: { label: "Matching items", value: {
        candidates: [
          { candidateId: addressCandidateId, contentId: "address_update_guide", contentVersion: "v1", tsRank: 1 },
          { candidateId: "candidate_funding", contentId: "fund_account", contentVersion: "v1", tsRank: 2 },
        ],
        rejections: [],
      } },
    },
    composer: addressSteps.composer,
    surface: {
      description: "The app tells chat the answer is ready. It sends the address steps, the funding card, and the transfer button.",
      input: { label: "Listen for chat updates", value: { method: "GET", path: "/api/turns/" + turnRef + "/events", headers: { Accept: "text/event-stream" } } },
      output: { label: "experience.ready · event excerpt", value: {
        type: "experience.ready",
        turnId: turnRef,
        payload: {
          experienceId: addressExperienceId, messageId: "msg_demo", a2uiVersion: "1.0",
          messages: [{
            version: "1.0",
            createSurface: {
              surfaceId: addressExperienceId, catalogId: "https://pzn.example.invalid/catalogs/v1.0/experience",
              dataModel: { intro: host.introCopy.steps },
              components: [
                { id: "root", component: "PznExperience", intro: { "@path": "/intro" }, children: ["block_1", "block_2", addressFollowUp.componentId], actionCount: 1, question: null, partial: false },
                ...addressBlocks.map(({ component, props }, index) => ({ id: "block_" + (index + 1), component, ...props })),
                { id: addressFollowUp.componentId, component: "PznFollowUp", actionId: addressFollowUp.actionId, label: addressFollowUp.label },
              ],
            },
          }],
        },
      } },
    },
    followUp: {
      description: "Marcus clicks See demo transfer steps. The app checks that the button is valid and starts a new request for the transfer checklist.",
      input: { label: "POST /api/experiences/" + addressExperienceId + "/actions", value: {
        clientRequestId: "request_demo_follow_up",
        envelope: {
          version: "1.0",
          action: {
            name: "request_follow_up", surfaceId: addressExperienceId, sourceComponentId: addressFollowUp.componentId,
            timestamp: "2026-11-22T00:00:00.000Z", context: { actionId: addressFollowUp.actionId },
          },
        },
      } },
      output: { label: "HTTP 202 · TurnAccepted excerpt", value: {
        turnId: "turn_demo_follow_up", eventsUrl: "/api/turns/turn_demo_follow_up/events",
        turn: { id: "turn_demo_follow_up", message: "Show the fictional transfer checklist.", status: "working", progress: "accepted" },
      } },
    },
  } satisfies Record<string, Pick<FlowStep, "description" | "input" | "output">>,
};

export const helpFlows: Flow[] = [
  {
    id: "balance", title: "Balance summary", prompt: summaryPrompt, prior: comparePrompt,
    steps: [
      chat(summaryPrompt), discovery,
      router(
        "The app sees that the chat was about balances. It sends that hint and the recent conversation to the model, which returns show_balance.",
        {
          request: summaryPrompt,
          recent: [{
            request: comparePrompt, contextId: "balance", intentId: "compare_balances", clarificationQuestion: null,
            assistantReply: host.introCopy.comparison, displayedContent: ["Compare demo definitions"],
          }],
          summaryFollowUpIntentId: "show_balance",
        }, balanceRoute,
      ),
      treatment("balance", treatmentFixture.base.balance, "The app checks the topic before sfield calls Treatment Selector. The app then uses the returned IDs to look up the matching content."),
      balanceComposer,
      render(
        "The app checks the content and balances, then tells A2UI what to show. Chat can use the same checked content if A2UI can’t display it.",
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
      router("The model picks show_portfolio. The app checks the choice and sends Portfolio summary (portsum) as the topic.", { request: portfolioPrompt, recent: [] }, portfolioRoute),
      treatment("portsum", treatmentFixture.base.portsum, "Treatment Selector checks a rule that requires more than $10,000 in cash. Alice has $12,500 and gets the investing card. Jordan has $10,000 and gets the portfolio summary by itself."),
      {
        id: "portfolio", title: "Portfolio Snapshot", role: "Account data",
        description: "The tool returns the demo customer’s portfolio values. The app can use the same figures to check the rule and show the summary.",
        input: { label: "portfolio.snapshot.read", value: { turnRef, routeDecisionId } },
        output: { label: "PortfolioSnapshot", value: portfolio },
        contracts: ["portfolio"],
      },
      composer(
        portfolioPrompt, "portsum", "show_portfolio", { topic: "Show portfolio summary", task: "show", summary: portfolioRoute.summary },
        [{ candidateId: "candidate_cash", title: "Explore investing options", tsRank: 2 }],
        [{ blockId: "b1", component: "PznContentCard", candidateIds: ["candidate_cash"], variant: "compact" }],
        "The model sees the suggested investing card and knows the app has the portfolio figures. If the model chooses the card, the app fills in the cash amount.",
        "summary",
      ),
      render(
        "Chat shows the portfolio figures and the suggestion the model chose.",
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
      router("The model picks show_home_goal. The app checks the choice and uses Home-buying goal as the topic.", { request: goalPrompt, recent: [] }, goalRoute),
      treatment("goals", treatmentFixture.base.goals, "Treatment Selector returns the down payment card ID. The app looks up the card before reading the customer’s savings history."),
      {
        id: "goal", title: "Goal Progress", role: "Savings data",
        description: "sfield reads the demo customer’s goal and monthly savings. The app checks the amounts and the order of the months.",
        input: { label: "goal.progress.read", value: { turnRef, routeDecisionId } },
        output: { label: "GoalProgress", value: homeGoal },
        contracts: ["goal"],
      },
      composer(
        goalPrompt, "goals", "show_home_goal", { topic: "Show home-buying goal", task: "show", summary: goalRoute.summary },
        [{ candidateId: "candidate_home_goal", title: "Home down payment", tsRank: 1 }],
        [{ blockId: "b1", component: "PznGoalProgress", candidateIds: ["candidate_home_goal"], variant: "expanded" }],
        "The model sees the available goal card and knows the app has the figures. It chooses to show a chart.",
        "summary",
      ),
      render(
        "Chat shows how much the customer has saved, what’s left to reach the target, and how their savings have grown.",
        { label: "Verified inputs · excerpt", value: { selectedCandidateId: "candidate_home_goal", goal: homeGoal } },
        { label: "DisplayExperience · excerpt", value: { status: "ready", blocks: [{ component: "PznGoalProgress", props: { title: "Home down payment", goal: homeGoal } }] } },
      ),
    ],
  },
  {
    id: "retirement", title: "Retirement learning", prompt: retirementPrompt,
    steps: [
      chat(retirementPrompt), discovery,
      router("The model recognizes a request to learn about retirement. The app checks the choice and selects Learning as the topic.", { request: retirementPrompt, recent: [] }, retirementRoute),
      treatment("learning", treatmentFixture.base.learning, "Treatment Selector returns a retirement lesson. Alice’s account is missing beneficiary details, so she also gets a reminder."),
      composer(
        retirementPrompt, "learning", "retirement_learning", { topic: "Learn about retirement", task: "explain", summary: retirementRoute.summary },
        [{ candidateId: "candidate_learning", title: "Retirement planning basics", tsRank: 1 }],
        [{ blockId: "b1", component: "PznContentCard", candidateIds: ["candidate_learning"], variant: "compact" }],
        "The model chooses the retirement lesson. The app adds the reminder that Treatment Selector returned.",
        "explanation",
      ),
      render(
        "Chat shows the lesson and Alice’s reminder. The button opens the beneficiary update guide.",
        { label: "Verified inputs · excerpt", value: { selectedCandidateId: "candidate_learning", eligibleReminder: "beneficiary_update" } },
        { label: "DisplayExperience · excerpt", value: { status: "ready", blocks: [
          { component: "PznContentCard", props: { title: "Retirement planning basics" } },
          { component: "PznContentCard", props: { title: "Update your beneficiaries" } },
        ], actions: [{ actionId: "action_demo", componentId: "follow_up_1", label: "See beneficiary update steps" }] } },
      ),
    ],
  },
  {
    id: addressContext, title: "Address update", prompt: addressUpdateExample.prompt, persona: addressUpdateExample.persona,
    steps: Object.values(addressSteps),
  },
  {
    id: "authoring", title: "Create rule", prompt: rulePrompt,
    steps: [
      chat(rulePrompt), discovery,
      router(
        "The model recognizes a request to create a rule. If the rule editor is available, the app loads the fields it needs.",
        { request: rulePrompt, canCreateRule: true, recent: [] },
        { ...routeProposal("create_rule", "Open the CCRE rule editor."), status: "create_rule" },
      ),
      {
        id: "glossary", title: "CCRE glossary", role: "Rule fields",
        description: "sfield asks for the fields and comparisons you can use in a rule. The app checks the list and gives it to the editor.",
        input: { label: "ccre.glossary.get", value: { turnRef, routerRunId: "run_demo" } },
        output: { label: "RuleGlossary", value: mockRuleGlossary },
        contracts: ["glossary", "rules"],
      },
      render(
        "Chat opens the rule editor. Preview checks the rule for a demo customer and message number. Save applies it to future requests.",
        { label: "Rule editor properties · excerpt", value: { scenarioId: "normal", personaId: "demo-learner", glossary: { version: mockRuleGlossary.version } } },
        { label: "DisplayExperience · excerpt", value: { status: "ready", outcome: "create_rule", blocks: [{ component: "PznRuleCreation" }] } },
      ),
    ],
  },
  {
    id: "clarification", title: "Ask a follow-up", prompt: summaryPrompt, prior: "Hi",
    steps: [
      chat(summaryPrompt), discovery,
      router(
        "The chat has only a greeting, so the model asks whether the customer meant a portfolio summary. The app shows the question and waits for an answer.",
        { request: summaryPrompt, recent: [{ request: "Hi", contextId: null, intentId: null, clarificationQuestion: null, assistantReply: "Hi! What would you like to talk about?" }] },
        { ...routeProposal("show_portfolio", "Confirm whether the customer wants a portfolio summary."), status: "clarify", clarificationQuestion: portfolioSummaryQuestion },
      ),
      render(
        "Chat shows the follow-up question. When the customer answers, the next model call sees that question in the chat history.",
        { label: "Verified clarification · excerpt", value: { status: "clarify", intentId: null, possibleIntentId: "show_portfolio", clarificationQuestion: portfolioSummaryQuestion } },
        { label: "DisplayExperience · excerpt", value: { status: "clarify", outcome: "clarify", question: portfolioSummaryQuestion, blocks: [], actions: [] } },
      ),
    ],
  },
];
