import type { DisplayBlock } from "../packages/contracts/surface";

export type LiveCase = {
  id: string;
  message: string;
  route: "balance" | "portsum" | "learning" | "goals" | "app-home" | "clarify" | "reply" | "no_match";
  outcome: string;
  component?: DisplayBlock["component"];
  relevant?: string[];
  exclude?: string[];
  scenario?: string;
  persona?: string;
  prior?: string | string[];
};
const ready = "ready";
const balance = "balance";
const portfolio = "portsum";
const home = "app-home";
const card = "PznContentCard";
const compare = "PznComparison";
const guide = "PznStepList";
const metric = "PznMetricSummary";
const education = "balance_education";
const available = "balance_available_definition";
const current = "balance_current_definition";
const portfolioItem = "portfolio_explanation";
const transferIntro = "transfer_learning";
const transferGuide = "transfer_checklist";
const metricTemplate = "balance_metric_template";
const promotion = "promotion_general";

export const liveCases: LiveCase[] = [
  { id: "balance-labels", message: "Explain the demo balance labels.", route: balance, outcome: ready, component: card, relevant: [education] },
  { id: "available-definition", message: "What does available balance mean in the demo?", route: balance, outcome: ready, component: card, relevant: [available, education] },
  { id: "current-definition", message: "How is the current balance label used in the demo?", route: balance, outcome: ready, component: card, relevant: [current, education] },
  { id: "intent-over-propensity", message: "I only want to understand the available and current balance labels. Please skip offers.", route: balance, outcome: ready, relevant: [education, available, current], exclude: [promotion], scenario: "conflicting-propensity" },
  { id: "missing-score", message: "Help me understand the fictional available balance.", route: balance, outcome: ready, component: card, relevant: [available, education], scenario: "missing-propensity" },
  { id: "balance-compare", message: "Compare available and current balance in the demo.", route: balance, outcome: ready, component: compare, relevant: [available, current] },
  { id: "balance-difference", message: "What's the difference between the ready-to-use and ledger balance amounts?", route: balance, outcome: ready, component: compare, relevant: [available, current] },
  { id: "balance-reverse-order", message: "Compare current balance first and then available balance.", route: balance, outcome: ready, component: compare, relevant: [current, available] },
  { id: "metric-summary", message: "Show my synthetic demo balance summary.", route: balance, outcome: ready, component: metric, relevant: [metricTemplate] },
  { id: "balance-summary-follow-up", message: "show me the summary", prior: "Compare available and current balance.", route: balance, outcome: ready, component: metric, relevant: [metricTemplate] },
  { id: "metric-values", message: "Show both fictional balance amounts in demo units.", route: balance, outcome: ready, component: metric, relevant: [metricTemplate], persona: "demo-returning" },
  { id: "portfolio-overview", message: "Explain the fictional portfolio view.", route: portfolio, outcome: ready, component: card, relevant: [portfolioItem] },
  { id: "portfolio-labels", message: "What do the labels in the demo portfolio overview mean?", route: portfolio, outcome: ready, component: card, relevant: [portfolioItem] },
  { id: "portfolio-holdings", message: "How are the sample holdings shown in the fictional portfolio?", route: portfolio, outcome: ready, component: card, relevant: [portfolioItem] },
  { id: "portfolio-allocation", message: "Show me an explanation of the demo portfolio allocation view.", route: portfolio, outcome: ready, component: card, relevant: [portfolioItem], scenario: "propensity-unavailable" },
  { id: "portfolio-summary-cash", message: "Let me know my portfolio summary.", route: portfolio, outcome: ready, component: "PznPortfolioSnapshot", relevant: ["portfolio_cash_investing"] },
  { id: "portfolio-summary-threshold", message: "Let me know my portfolio summary.", route: portfolio, outcome: ready, component: "PznPortfolioSnapshot", exclude: ["portfolio_cash_investing", portfolioItem], persona: "demo-returning" },
  { id: "home-goal-progress", message: "How close am I to buying a house?", route: "goals", outcome: ready, component: "PznGoalProgress", relevant: ["home_down_payment_progress"] },
  { id: "retirement-missing-beneficiary", message: "I'd like to learn about retirement.", route: "learning", outcome: ready, component: card, relevant: ["beneficiary_update"] },
  { id: "retirement-beneficiary-on-file", message: "I'd like to learn about retirement.", route: "learning", outcome: ready, component: card, relevant: ["retirement_learning"], exclude: ["beneficiary_update"], persona: "demo-returning" },
  { id: "retirement-unclear", message: "last day of job is next week", prior: "i will be 62", route: "clarify", outcome: "clarify" },
  { id: "retirement-confirmed", message: "yes", prior: ["i will be 62", "last day of job is next week"], route: "learning", outcome: ready, component: card, relevant: ["beneficiary_update"] },
  { id: "retirement-acknowledgment", message: "thats nice", prior: ["i will be 62", "yes"], route: "reply", outcome: "reply" },
  { id: "retirement-inferred-follow-up", message: "last day of job is next week", prior: ["i want to know about retierment", "am old", "i am going to loose my job", "i will be 62"], route: "learning", outcome: ready, component: card, relevant: ["beneficiary_update"] },
  { id: "beneficiary-update-steps", message: "Show me the demo steps to update my beneficiaries.", route: "learning", outcome: ready, component: guide, relevant: ["beneficiary_update"] },
  { id: "transfer-overview", message: "Explain the fictional transfer flow.", route: home, outcome: ready, component: card, relevant: [transferIntro] },
  { id: "transfer-steps", message: "Walk me through the demo transfer steps.", route: home, outcome: ready, component: guide, relevant: [transferGuide] },
  { id: "transfer-preview", message: "How do I get to a preview in the demo transfer checklist?", route: home, outcome: ready, component: guide, relevant: [transferGuide] },
  { id: "app-home-help", message: "I’m on the demo app home. What can I learn about the transfer flow?", route: home, outcome: ready, relevant: [transferIntro, transferGuide] },
  { id: "excluded-offer", message: "Show the restricted demo transfer promotion, or suggest a way to learn about transfers.", route: home, outcome: ready, relevant: [transferIntro, transferGuide], exclude: ["promotion_blocked"], scenario: "relevant-blocked" },
  { id: "empty-eligibility", message: "Find the demo balance definition.", route: balance, outcome: "eligible_empty", scenario: "empty" },
  { id: "ts-timeout", message: "Find my demo balance definition.", route: balance, outcome: "ts_unavailable", scenario: "ts-unavailable" },
  { id: "partial-catalog", message: "Explain both fictional balance labels.", route: balance, outcome: ready, component: card, relevant: [education], scenario: "catalog-resolution" },
  { id: "no-resolved-content", message: "Show the updated balance explanation.", route: balance, outcome: "content_unavailable", scenario: "catalog-resolution", prior: "Explain both fictional balance labels." },
  { id: "ambiguous", message: "Can you explain that?", route: "clarify", outcome: "clarify" },
  { id: "multiple-contexts", message: "Show my balance and walk me through a transfer.", route: "clarify", outcome: "clarify" },
  { id: "unsupported", message: "What is the weather tomorrow?", route: "no_match", outcome: "no_match" },
  { id: "topic-change", message: "Now explain the portfolio overview instead.", route: portfolio, outcome: ready, component: card, relevant: [portfolioItem], prior: "Explain the demo balance labels." },
  { id: "prior-reference", message: "Can you compare those two labels?", route: balance, outcome: ready, component: compare, relevant: [available, current], prior: "Explain the available and current balance labels." },
  { id: "transfer-eligibility-changes", message: "Show that demo transfer guide again.", route: home, outcome: "no_match", prior: "Walk me through the demo transfer steps.", scenario: "cross-turn-change", persona: "demo-returning" },
  { id: "out-of-scope-destination", message: "Book a rental car for this weekend.", route: "no_match", outcome: "no_match" },
];
