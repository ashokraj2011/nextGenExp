import balanceFixture from "../../fixtures/demo-balance-reads.json";
import contextFixture from "../../fixtures/contexts.json";
import goalFixture from "../../fixtures/demo-goal-progress.json";
import portfolioFixture from "../../fixtures/demo-portfolio-snapshots.json";
import propensityFixture from "../../fixtures/propensity.json";
import treatmentFixture from "../../fixtures/treatment-scenarios.json";
import host from "../../fixtures/host.json";
import marcusCalls from "../../fixtures/marcus-sfield-exchanges.json";
import type { ContextSelectionProposal, ExperienceProposal, Intent, ProposalBlock } from "../../packages/contracts/domain";
import { beneficiaryReviewWorkflow } from "../../packages/contracts/customer-workflows";
import { fundingPreviewWorkflow, treatmentDecisionSchema, type TreatmentDecision } from "../../packages/contracts/funding-workflow";
import { portfolioSummaryQuestion, type RoutingIntentId } from "../../packages/contracts/routing-intents";
import { mockRuleGlossary } from "../../packages/rule-glossary";
import { resolveTurnFlows } from "../../packages/contracts/routing-flows";

export type PayloadExample = { label: string; value: unknown };
type CapturedCall = (typeof marcusCalls)[keyof typeof marcusCalls];
export type HandoffExample = {
  description?: string;
  calls: { title: string; description: string; exchange: CapturedCall }[];
};
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
const learner = host.personas.find(({ personaId }) => personaId === "demo-learner")!;
const mid = learner.syntheticMid;
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
    id: "discovery", title: "Load topics and scores", role: "sfield tools",
    description: "Inside account help, sfield asks Treatment Selector for active topics, then for the member’s topic scores. The app saves both and includes them in the Context Router request.",
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
    id: "router", title: "Context Router", role: "sfield · Intent selection", description,
    input: { label: "What the model receives · excerpt", value: { inputType: "PznContextRoutingInput", catalogSnapshotId, ...value } },
    output: { label: "ContextSelectionProposal", value: proposal },
    contracts: ["router", "gateway"],
  };
}

function treatment(context: string, response: string[] | TreatmentDecision, description: string, memberId = mid): FlowStep {
  return {
    id: "treatment", title: "Treatment Selector", role: "Finds eligible treatments", description,
    input: { label: "Tool request and what Treatment Selector receives", value: {
      registryInput: { turnRef, routeDecisionId }, adapterInput: { mid: memberId, context },
    } },
    output: { label: "Eligible content, actions and workflows", value: Array.isArray(response)
      ? { schemaVersion: "2.1", recommendations: response.map((id) => ({ kind: "content", id })) } : response },
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
    id: "composer", title: "Experience Composer", role: "sfield · Layout selection", description,
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
const referenceFlows = resolveTurnFlows("pzn-local", "wealth", "customer", false, {}, {});
const rulePrompt = "Create rule";
const balanceRoute = routeProposal("show_balance", "Show the summary of the established balance topic.");
const portfolioRoute = routeProposal("show_portfolio", "Show the customer's demo portfolio.");
const goalRoute = routeProposal("show_home_goal", "Show progress toward a home down payment.");
const retirementRoute = routeProposal("retirement_learning", "Explain retirement planning basics.");
const balanceCard: ProposalBlock = { blockId: "b1", component: "PznMetricSummary", candidateIds: ["candidate_balance"], variant: "compact" };
const balanceComposer = composer(
  summaryPrompt, "balance", "show_balance", { topic: "Show balances", task: "show", summary: balanceRoute.summary },
  [{ candidateId: "candidate_balance", title: "Balance summary", tsRank: 5 }], [balanceCard],
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
const addressTreatments = treatmentDecisionSchema.parse(marcusCalls.treatment.response.output);
const retirementTreatments: TreatmentDecision = {
  schemaVersion: "2.1",
  recommendations: [
    ...treatmentFixture.base.learning.map((id) => ({ kind: "content" as const, id })),
    { ...beneficiaryReviewWorkflow.recommendation, forContentIds: ["beneficiary_update"] },
  ],
};
const addressContentIds = addressTreatments.recommendations.filter(({ kind }) => kind === "content").map(({ id }) => id);
export const treatmentDecisionExamples = [
  {
    label: "Marcus · Address update", prompt: addressPrompt,
    request: { mid: newAccount.syntheticMid, context: addressContext },
    legacy: treatmentFixture.base["address-update"], response: addressTreatments,
    rule: "Mailing address update requested · Account is unfunded", button: fundingPreviewWorkflow.label,
    eligibility: "Address update qualifies Marcus for the form. His unfunded status also qualifies him for the funding card and workflow. A funded customer can still use the address form.",
    afterClick: "In this example, the saved workflow tells sfield to check funding status, read eligible funding methods, then build a preview.",
  },
  {
    label: "Alice · Retirement", prompt: retirementPrompt,
    request: { mid, context: "learning" },
    legacy: treatmentFixture.base.learning, response: retirementTreatments,
    rule: "Beneficiary details are missing", button: beneficiaryReviewWorkflow.label,
    eligibility: "Alice gets the retirement lesson and a beneficiary reminder. A customer with a beneficiary on file gets just the lesson.",
    afterClick: "sfield reads Alice’s retirement accounts. Chat lists her Workplace 401(k) and Rollover IRA and asks which one she wants to check.",
  },
] as const;
const addressCandidateId = "candidate_address";
const addressExperienceId = "exp_demo";
const addressFollowUp = { actionId: "action_demo_funding", componentId: "follow_up_1", label: fundingPreviewWorkflow.label };
const addressActions = [addressFollowUp, { actionId: "action_demo_transfer", componentId: "follow_up_2", label: "See demo transfer steps" }];
const addressBlocks = [
  { component: "PznStepList", props: { title: "Update your mailing address" } },
  { component: "PznContentCard", props: { title: "Fund your account", recommendation: true } },
  { component: "PznCapabilityForm", props: { title: "Prepare an address change" } },
];
const marcusCustomerContext = {
  segment: "New account holder",
  fundingStatus: "unfunded" as const,
  beneficiaryStatus: "on_file" as const,
  hasElevatedCash: false,
  hasActiveHomeGoal: true,
  notes: "Recently opened an investment account.",
};
const marcusRouterInput = {
  ...JSON.parse(marcusCalls.router.request.message.text),
  customerContext: marcusCustomerContext,
};
const marcusRouterExchange = {
  ...marcusCalls.router,
  request: {
    ...marcusCalls.router.request,
    message: { ...marcusCalls.router.request.message, text: JSON.stringify(marcusRouterInput) },
  },
};
const addressSteps = {
  chat: chat(addressPrompt),
  discovery: {
    id: "discovery",
    title: "Customer 360 & Intents",
    role: "Profile & catalog lookup",
    description: "Before calling the LLM router, the app reads Marcus’s live Customer 360 profile (/admin/customers) and active High-Level Intents (/admin/intents). Only privacy-safe qualitative signals enter the router — never raw MIDs or cent values.",
    input: {
      label: "Customer 360 & Experience Registry lookup",
      value: { personaId: newAccount.personaId, sources: ["customer-profiles.json", "experience-registry.json"] },
    },
    output: {
      label: "Customer 360 signals & active intents",
      value: {
        customerContext: marcusCustomerContext,
        activeIntentCount: marcusRouterInput.intentCatalog.length,
        sampleIntents: ["show_balance", "show_portfolio", "show_home_goal", "update_address", "suggest_next_step"],
      },
    },
    contracts: ["discovery", "domain"],
  },
  router: {
    id: "router", title: "Context Router", role: "sfield · Intent selection",
    description: "The routing model receives Marcus’s message, recent chat, privacy-safe Customer 360 signals, and live High-Level Intents. It proposes update_address. The app verifies the intent and asks Treatment Selector which recommendations are eligible.",
    input: { label: "What the model receives", value: marcusRouterInput },
    output: { label: "ContextSelectionProposal", value: marcusCalls.router.response.output },
    contracts: ["router", "gateway"],
  },
  treatment: treatment(
    addressContext, addressTreatments,
    "Treatment Selector receives Marcus’s MID and TS rule group (address-update). CCRE recommends a standalone address action for this topic. Marcus’s unfunded status also qualifies him for the funding card and Preview funding workflow.",
    newAccount.syntheticMid,
  ),
  composer: {
    id: "composer", title: "Experience Composer", role: "sfield · Layout selection",
    description: "The model selects the address guide strictly from eligible candidates. The app verifies disclosures, merges any published UI Builder layout, and attaches the eligible funding card.",
    input: { label: "What the model receives", value: JSON.parse(marcusCalls.composer.request.message.text) },
    output: { label: "ExperienceProposal", value: marcusCalls.composer.response.output },
    contracts: ["composer", "domain"],
  },
  render: render(
    "Chat shows the address guide, the independent address form, and a funding card with a Preview funding button. Open the turn in Admin Logs to inspect the calls.",
    { label: "Verified inputs · excerpt", value: {
      actionMode: "verified_experience",
      selectedCandidateId: addressCandidateId,
      standaloneAction: treatmentFixture.actionRules[0].action,
      eligibleFundingCard: "fund_account",
      workflow: fundingPreviewWorkflow.recommendation,
    } },
    { label: "DisplayExperience · excerpt", value: { status: "ready", actionMode: "verified_experience", blocks: addressBlocks, actions: addressActions } },
  ),
} satisfies Record<string, FlowStep>;

export const addressUpdateExample = {
  persona: newAccount.displayName,
  prompt: addressPrompt,
  handoffs: {
    router: {
      calls: [{
        title: "Context Router",
        description: "The app sends Marcus’s prompt, privacy-safe Customer 360 signals, and live High-Level Intents as JSON text. sfield calls the configured model and returns the proposed intent.",
        exchange: marcusRouterExchange,
      }],
    },
    treatment: {
      calls: [{
        title: "Treatment Selector",
        description: "The app sends the turn ID and verified route ID. sfield calls Treatment Selector with Marcus’s MID and the address-update rule group, running CCRE rules to return eligible content, the address action and the funding workflow.",
        exchange: marcusCalls.treatment,
      }],
    },
    composer: {
      calls: [{
        title: "Experience Composer",
        description: "The app sends the verified intent and eligible address guide as JSON text. sfield runs the Experience Composer and returns the proposed A2UI layout.",
        exchange: marcusCalls.composer,
      }],
    },
  } satisfies Record<string, HandoffExample>,
  exchanges: {
    chat: addressSteps.chat,
    flowList: {
      description: "The app starts with registered flows and applies tenant defaults, domain overrides and the chat audience. This example uses the Wealth defaults.",
      input: { label: "Chat scope", value: { tenantId: referenceFlows.tenantId, domainId: referenceFlows.domainId, audience: referenceFlows.audience } },
      output: { label: "Applicable flow IDs", value: referenceFlows.flows.map((flow) => flow.id) },
    },
    flowSelection: {
      description: "For this address-update example the app calls the configured model directly. It supplies recent chat when available and checks that the returned flow ID belongs to the list for this turn.",
      input: { label: "Flow selection input · excerpt", value: { message: addressPrompt, flows: referenceFlows.flows.map(({ id, description, examples }) => ({ id, description, examples })) } },
      output: { label: "Flow selection response · excerpt", value: { capabilityId: "verified_experience" } },
    },
    contexts: {
      description: "Inside account help, sfield asks TS for active topics and then for the member’s scores against those topics. The Context Router also receives supported intents, recent chat and relevant customer fields.",
      input: { label: "sfield discovery calls", value: [marcusCalls.catalog.request, marcusCalls.scores.request] },
      output: { label: "TS topics and member scores", value: { catalog: marcusCalls.catalog.response.output, propensity: marcusCalls.scores.response.output } },
    },
    router: addressSteps.router,
    treatment: addressSteps.treatment,
    content: {
      description: "The app resolves the surviving Treatment Selector content IDs against the live Content Catalog (/admin/intents) to load approved copy, disclosures, and allowed components.",
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
    compileUi: {
      description: "The LLM only proposes component choices — never HTML. Here inside the CEP app server, compileExperience() + buildSurface() + applyPublishedUi() deterministically form the UI: merging approved catalog copy & disclosures, applying any published UI Builder layout, interpolating live customer.*/incident.*/deal.* bindings, signing action buttons, and emitting A2UI v1.0 protocol messages.",
      input: {
        label: "Host UI compiler inputs (compileExperience + applyPublishedUi)",
        value: {
          verifiedProposal: { blocks: [{ blockId: "b1", component: "PznStepList", candidateIds: [addressCandidateId] }] },
          catalogCopyResolved: ["address_update_guide", "fund_account"],
          uiBuilderLayout: "published_or_default",
          liveBindings: { "customer.displayName": newAccount.displayName, "customer.fundingStatus": "unfunded" },
          arbitratedNba: "fund_account",
        },
      },
      output: {
        label: "Formed A2UI v1.0 surface & signed actions",
        value: {
          a2uiProtocol: "v1.0",
          a2uiMessages: [
            { type: "createSurface", surfaceId: "exp_demo", theme: "evergreen" },
            { type: "updateComponents", components: addressBlocks.map((block) => block.component) },
            { type: "updateDataModel", signedActions: addressActions },
          ],
          blocks: addressBlocks,
        },
      },
    },
    surface: {
      description: "store.finish() persists the formed DisplayExperience and streams an experience.ready Server-Sent Event (SSE) over GET /api/turns/:id/events. In the browser, surface.tsx receives the A2UI messages and renders the approved React components.",
      input: { label: "Listen for chat updates (SSE stream)", value: { method: "GET", path: "/api/turns/" + turnRef + "/events", headers: { Accept: "text/event-stream" } } },
      output: { label: "experience.ready · event excerpt", value: {
        type: "experience.ready",
        turnId: turnRef,
        actionMode: "verified_experience",
        customerLookup: { personaName: newAccount.displayName, fundingStatus: "unfunded", highlights: [marcusCustomerContext.segment, "Awaiting first deposit", "Beneficiaries on file"] },
        payload: {
          experienceId: addressExperienceId, messageId: "msg_demo", a2uiVersion: "1.0",
          messages: [{
            version: "1.0",
            createSurface: {
              surfaceId: addressExperienceId, catalogId: "https://pzn.example.invalid/catalogs/v1.0/experience",
              dataModel: { intro: host.introCopy.steps },
              components: [
                {
                  id: "root", component: "PznExperience", intro: { "@path": "/intro" },
                  children: [...addressBlocks.map((_, i) => "block_" + (i + 1)), ...addressActions.map(({ componentId }) => componentId)],
                  actionCount: addressActions.length, question: null, partial: false,
                },
                ...addressBlocks.map(({ component, props }, index) => ({ id: "block_" + (index + 1), component, ...props })),
                ...addressActions.map(({ componentId, actionId, label }) => ({ id: componentId, component: "PznFollowUp", actionId, label })),
              ],
            },
          }],
        },
      } },
    },
    followUp: {
      description: "Marcus clicks Preview funding. The app checks the recommendation and looks up the workflow by ID and version. With Agent-guided selected, sfield shows the eligible methods and waits for his choice. Logs shows the calls for each message.",
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
        turn: { id: "turn_demo_follow_up", message: addressFollowUp.label, status: "working", progress: "accepted" },
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
              { id: "block_1", component: "PznMetricSummary", title: "Balance summary", variant: "compact", observedAt: demoBalance.observedAt, values: demoBalance.values },
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
    id: "retirement", title: "Retirement learning", prompt: retirementPrompt, persona: learner.displayName,
    steps: [
      chat(retirementPrompt), discovery,
      router("The model recognizes a request to learn about retirement. The app checks the choice and selects Learning as the topic.", { request: retirementPrompt, recent: [] }, retirementRoute),
      treatment("learning", retirementTreatments, "Alice’s missing beneficiary details qualify her for the reminder alongside the retirement lesson. This example has Review beneficiary attached to that rule in Tool setup."),
      composer(
        retirementPrompt, "learning", "retirement_learning", { topic: "Learn about retirement", task: "explain", summary: retirementRoute.summary },
        [{ candidateId: "candidate_learning", title: "Retirement planning basics", tsRank: 1 }],
        [{ blockId: "b1", component: "PznContentCard", candidateIds: ["candidate_learning"], variant: "compact" }],
        "The model chooses the retirement lesson. The app adds the reminder that Treatment Selector returned.",
        "explanation",
      ),
      render(
        "Chat shows the lesson and Alice’s reminder. Review beneficiary starts the account review. See beneficiary update steps opens the guide.",
        { label: "Verified inputs · excerpt", value: { selectedCandidateId: "candidate_learning", eligibleReminder: "beneficiary_update" } },
        { label: "DisplayExperience · excerpt", value: { status: "ready", blocks: [
          { component: "PznContentCard", props: { title: "Retirement planning basics" } },
          { component: "PznContentCard", props: { title: "Update your beneficiaries" } },
        ], actions: [
          { actionId: "action_demo_review", componentId: "follow_up_1", label: beneficiaryReviewWorkflow.label },
          { actionId: "action_demo_steps", componentId: "follow_up_2", label: "See beneficiary update steps" },
        ] } },
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
