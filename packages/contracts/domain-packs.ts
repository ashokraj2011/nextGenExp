export type DomainPackId = "wealth" | "it_ops" | "sales_revops";

export interface DomainTopic {
  id: string;
  name: string;
  prompt: string;
}

export interface DomainPack {
  id: DomainPackId;
  shortLabel: string;
  label: string;
  subtitle: string;
  actorRole: string;
  guardrailLabel: string;
  composerPlaceholder: string;
  dataSourceLabel: string;
  topics: DomainTopic[];
  quickPrompts: { label: string; prompt: string }[];
}

export const DOMAIN_PACKS: readonly DomainPack[] = [
  {
    id: "wealth",
    shortLabel: "Wealth",
    label: "Wealth Advisory",
    subtitle: "Customer 360 · TS + CCRE · NBA",
    actorRole: "Customer Profile",
    guardrailLabel: "CEP Advisory Guardrails Active",
    composerPlaceholder: "Ask a question...",
    dataSourceLabel: "Customer 360 (customer-profiles.json)",
    topics: [
      { id: "portfolio", name: "Portfolio", prompt: "Let me know my portfolio summary." },
      { id: "retirement", name: "Retirement", prompt: "I'd like to learn about retirement." },
      { id: "balances", name: "Balances", prompt: "Explain the balance labels." },
    ],
    quickPrompts: [
      { label: "Review portfolio mix", prompt: "Let me know my portfolio summary." },
      { label: "Model 2-year home plan", prompt: "Show my home-buying goal and savings progress." },
      { label: "Explore retirement basics", prompt: "I'd like to learn about retirement." },
    ],
  },
  {
    id: "it_ops",
    shortLabel: "IT Ops",
    label: "IT Operations & SRE",
    subtitle: "Live Incident Store · Rollback Approvals",
    actorRole: "On-Call SRE Commander",
    guardrailLabel: "CEP SRE Change-Control Guardrails Active",
    composerPlaceholder: "Triage an incident, inspect timeline, or request a rollback...",
    dataSourceLabel: "Live Incident Store (incidents.json)",
    topics: [
      { id: "p1-triage", name: "Active P1 Triage", prompt: "Build an IT incident triage dashboard for our active P1 alert" },
      { id: "rollback", name: "Rollback Approvals", prompt: "Show the production rollback approval card for INC-4821" },
      { id: "timeline", name: "Incident Timeline", prompt: "Build a post-incident timeline and root-cause checklist for INC-4821" },
      { id: "intake", name: "Escalation Form", prompt: "Create an incident escalation intake form for on-call engineering" },
    ],
    quickPrompts: [
      { label: "Triage P1 · INC-4821", prompt: "Build an IT incident triage dashboard for our active P1 alert" },
      { label: "Post-incident timeline", prompt: "Build a post-incident timeline and root-cause checklist for INC-4821" },
      { label: "Escalation intake form", prompt: "Create an incident escalation intake form for on-call engineering" },
    ],
  },
  {
    id: "sales_revops",
    shortLabel: "RevOps",
    label: "Sales & Revenue Ops",
    subtitle: "Live CRM Deal Desk · Discount Approvals",
    actorRole: "VP Revenue Operations",
    guardrailLabel: "CEP Deal Desk & Pricing Guardrails Active",
    composerPlaceholder: "Review Q4 pipeline, approve a deal discount, or build an action plan...",
    dataSourceLabel: "Live CRM Deal Store (deals.json)",
    topics: [
      { id: "deal-desk", name: "Q4 Deal Desk", prompt: "Build a Q4 deal desk and discount approval dashboard for DEAL-904" },
      { id: "pipeline", name: "Pipeline Breakdown", prompt: "Show a live sales pipeline breakdown and deal table" },
      { id: "map", name: "Mutual Action Plan", prompt: "Build a close-plan timeline for DEAL-904 enterprise renewal" },
      { id: "quote-form", name: "Deal Intake Form", prompt: "Create an enterprise pricing exception intake form" },
    ],
    quickPrompts: [
      { label: "Approve DEAL-904 discount", prompt: "Build a Q4 deal desk and discount approval dashboard for DEAL-904" },
      { label: "Live Q4 pipeline chart", prompt: "Show a live sales pipeline breakdown and deal table" },
      { label: "Enterprise close timeline", prompt: "Build a close-plan timeline for DEAL-904 enterprise renewal" },
    ],
  },
] as const;

export function getDomainPack(id: string | null | undefined): DomainPack {
  return DOMAIN_PACKS.find((p) => p.id === id) ?? DOMAIN_PACKS[0];
}
