import { z } from "zod";

export const cepCapabilityIdSchema = z.enum([
  "verified_experience",
  "stock_holdings",
  "stock_trade",
  "ops_incident",
  "sales_deal_desk",
  "hitl_approvals",
  "external_connector",
  "custom_dynamic_ui",
]);

export type CepCapabilityId = z.infer<typeof cepCapabilityIdSchema>;

export interface CepCapabilityDefinition {
  id: CepCapabilityId;
  label: string;
  domain: "wealth" | "operations" | "sales" | "platform";
  description: string;
  examples: readonly string[];
}

export const CEP_CAPABILITIES: readonly CepCapabilityDefinition[] = [
  {
    id: "verified_experience",
    label: "Verified Advisory & Account Experience",
    domain: "wealth",
    description: "Governed account summaries and advisory experiences: high-level portfolio snapshot/allocation, available vs current balance explanations or comparisons, home down-payment savings goal, retirement planning, beneficiary update steps, mailing address change, account funding/transfers, next-step recommendations, creating Treatment Selector rules, or simple greetings/chit-chat.",
    examples: [
      "Show my portfolio summary",
      "Explain the balance labels",
      "How close am I to my home down payment goal?",
      "I want to update my mailing address",
      "How can I invest more of my cash?",
      "Create a rule",
      "Hi",
    ],
  },
  {
    id: "stock_holdings",
    label: "Live Stock Holdings & Tax-Lot Positions",
    domain: "wealth",
    description: "View individual equity tickers, share quantities, cost basis, current stock prices, unrealized gains/losses, or which stocks are down / eligible for tax-loss harvesting.",
    examples: [
      "Show all my stocks",
      "What's in my equity book?",
      "Which stocks am I losing money on?",
      "List my stock positions and share counts",
    ],
  },
  {
    id: "stock_trade",
    label: "Stock Buy/Sell & Tax-Loss Harvesting Simulator",
    domain: "wealth",
    description: "Simulate buying or selling specific stocks or ETFs (by share count or percentage), run tax-loss harvesting analysis to offset capital gains, or execute a timed simulated trade job.",
    examples: [
      "I want to sell 40% of my Apple shares",
      "Trim half my Microsoft position",
      "Buy 10 shares of NVDA",
      "Offset my Apple capital gains with tax-loss harvesting",
    ],
  },
  {
    id: "ops_incident",
    label: "IT Operations & Incident Triage",
    domain: "operations",
    description: "Inspect live production incidents (P1/SEV-1 alerts, latency/5xx spikes), review incident timelines, or approve/hold production release rollbacks.",
    examples: [
      "Any active production alerts?",
      "Build an IT incident triage dashboard for our P1 alert",
      "Approve rollback for INC-4821",
    ],
  },
  {
    id: "sales_deal_desk",
    label: "Sales Pipeline & Deal Desk Approvals",
    domain: "sales",
    description: "Inspect live Q4 sales pipeline, weighted forecast, Deal Desk discount approvals (e.g. DEAL-904 / Acme Cloud), or mutual action close plans.",
    examples: [
      "Review Q4 deal desk discounts waiting for approval",
      "Show our sales pipeline forecast",
      "Build a close-plan for Acme Cloud",
    ],
  },
  {
    id: "hitl_approvals",
    label: "Human-in-the-Loop Approval Queue",
    domain: "platform",
    description: "View, approve, or deny pending high-risk actions waiting for human sign-off in the sfield HITL approval queue.",
    examples: [
      "Show pending approvals",
      "Anything waiting for my sign-off?",
      "Open the HITL approval queue",
    ],
  },
  {
    id: "external_connector",
    label: "External REST & MCP Connector Execution",
    domain: "platform",
    description: "Invoke or trigger an external registered connector or webhook (such as PagerDuty escalation or ServiceNow change bridge) through sfield.",
    examples: [
      "Invoke PagerDuty connector for INC-4821",
      "Page on-call via our external webhook",
      "Trigger ServiceNow connector",
    ],
  },
  {
    id: "custom_dynamic_ui",
    label: "Custom Dynamic UI Composition",
    domain: "platform",
    description: "Build a bespoke ad-hoc interactive visualization, slider calculator, comparison matrix, intake form, checklist, roadmap, or custom dashboard not covered by the specific domain tools above.",
    examples: [
      "Build a compound interest savings calculator with sliders",
      "Build a form for a savings goal",
      "Compare two savings scenarios in a chart",
    ],
  },
] as const;

export const semanticRouteOutputSchema = z.object({
  capabilityId: cepCapabilityIdSchema,
  confidence: z.number().min(0).max(1),
  reasoning: z.string().trim().min(1).max(240),
  extractedParams: z.object({
    side: z.enum(["buy", "sell"]).optional(),
    symbol: z.string().trim().max(12).optional(),
    percent: z.number().min(1).max(100).optional(),
    shares: z.number().int().positive().max(1_000_000).optional(),
  }).optional(),
}).strict();

export type SemanticRouteDecision = {
  capabilityId: CepCapabilityId;
  capabilityLabel: string;
  method: "llm_semantic" | "deterministic";
  confidence: number;
  reasoning: string;
  extractedParams?: {
    side?: "buy" | "sell";
    symbol?: string;
    percent?: number;
    shares?: number;
  };
};

export function capabilityLabelFor(id: CepCapabilityId): string {
  return CEP_CAPABILITIES.find((c) => c.id === id)?.label ?? id;
}
