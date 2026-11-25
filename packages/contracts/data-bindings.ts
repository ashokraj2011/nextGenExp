import { z } from "zod";

export const dataDictionary = [
  { key: "customer.displayName", group: "Customer Profile", label: "Customer name", kind: "text" },
  { key: "customer.segment", group: "Customer Profile", label: "Customer segment", kind: "text" },
  { key: "customer.fundingStatus", group: "Customer Profile", label: "Account funding status", kind: "text" },
  { key: "customer.beneficiaryStatus", group: "Customer Profile", label: "Beneficiary status", kind: "text" },
  { key: "balances.available", group: "Balances", label: "Available balance ($)", kind: "currency" },
  { key: "balances.current", group: "Balances", label: "Current balance ($)", kind: "currency" },
  { key: "portfolio.total", group: "Portfolio", label: "Total portfolio value ($)", kind: "currency" },
  { key: "portfolio.invested", group: "Portfolio", label: "Invested assets ($)", kind: "currency" },
  { key: "portfolio.cash", group: "Portfolio", label: "Cash reserve ($)", kind: "currency" },
  { key: "portfolio.equities", group: "Portfolio", label: "Equities ($)", kind: "currency" },
  { key: "portfolio.fixedIncome", group: "Portfolio", label: "Fixed income ($)", kind: "currency" },
  { key: "portfolio.cashPct", group: "Portfolio", label: "Cash share (%)", kind: "percent" },
  { key: "portfolio.equitiesPct", group: "Portfolio", label: "Equities share (%)", kind: "percent" },
  { key: "portfolio.fixedIncomePct", group: "Portfolio", label: "Fixed income share (%)", kind: "percent" },
  { key: "goal.target", group: "Home Goal", label: "Home goal target ($)", kind: "currency" },
  { key: "goal.saved", group: "Home Goal", label: "Home goal saved ($)", kind: "currency" },
  { key: "goal.remaining", group: "Home Goal", label: "Home goal remaining ($)", kind: "currency" },
  { key: "goal.percentFunded", group: "Home Goal", label: "Home goal funded (%)", kind: "percent" },
  { key: "incident.id", group: "IT Operations (Live)", label: "Active incident ID", kind: "text" },
  { key: "incident.title", group: "IT Operations (Live)", label: "Incident title", kind: "text" },
  { key: "incident.severity", group: "IT Operations (Live)", label: "Severity", kind: "text" },
  { key: "incident.status", group: "IT Operations (Live)", label: "Incident status", kind: "text" },
  { key: "incident.service", group: "IT Operations (Live)", label: "Affected service", kind: "text" },
  { key: "incident.environment", group: "IT Operations (Live)", label: "Environment", kind: "text" },
  { key: "incident.errorRate", group: "IT Operations (Live)", label: "Error rate (%)", kind: "percent" },
  { key: "incident.p95Latency", group: "IT Operations (Live)", label: "p95 Latency (ms)", kind: "text" },
  { key: "incident.currentRelease", group: "IT Operations (Live)", label: "Current release", kind: "text" },
  { key: "incident.previousRelease", group: "IT Operations (Live)", label: "Previous healthy release", kind: "text" },
  { key: "incident.rollbackStatus", group: "IT Operations (Live)", label: "Rollback status", kind: "text" },
  { key: "deal.id", group: "Sales / RevOps (Live)", label: "Active deal ID", kind: "text" },
  { key: "deal.accountName", group: "Sales / RevOps (Live)", label: "Account name", kind: "text" },
  { key: "deal.title", group: "Sales / RevOps (Live)", label: "Deal title", kind: "text" },
  { key: "deal.stage", group: "Sales / RevOps (Live)", label: "Deal stage", kind: "text" },
  { key: "deal.arr", group: "Sales / RevOps (Live)", label: "Annual value (ARR $)", kind: "currency" },
  { key: "deal.discountPct", group: "Sales / RevOps (Live)", label: "Discount requested (%)", kind: "percent" },
  { key: "deal.discountStatus", group: "Sales / RevOps (Live)", label: "Discount approval status", kind: "text" },
  { key: "deal.winProbability", group: "Sales / RevOps (Live)", label: "Win probability (%)", kind: "percent" },
  { key: "deal.closeDate", group: "Sales / RevOps (Live)", label: "Target close date", kind: "text" },
  { key: "deal.owner", group: "Sales / RevOps (Live)", label: "Deal owner", kind: "text" },
] as const;

export type BuiltInDataBindingKey = (typeof dataDictionary)[number]["key"];
const bindingKeys = dataDictionary.map((entry) => entry.key) as [BuiltInDataBindingKey, ...BuiltInDataBindingKey[]];
export const customBindingKeySchema = z.string().regex(/^custom\.[a-z][a-z0-9_]{0,47}$/);
export const dataBindingKeySchema = z.union([z.enum(bindingKeys), customBindingKeySchema]);
export type DataBindingKey = z.infer<typeof dataBindingKeySchema>;

export type ResolvedBindingEntry = {
  display: string;
  rawInput: string;
  percent?: number;
};

export type DataBindingValues = Record<string, ResolvedBindingEntry>;

export function bindingLabel(key: DataBindingKey): string {
  const builtIn = dataDictionary.find((d) => d.key === key);
  if (builtIn) return builtIn.label;
  if (key.startsWith("custom.")) {
    return key.slice(7).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return key;
}

const tokenPattern = /\{\{\s*([a-z]+\.[a-zA-Z0-9_]+)\s*\}\}/g;

export function interpolateBindingTokens(template: string, values?: DataBindingValues): string {
  if (!values || !template.includes("{{")) return template;
  return template.replace(tokenPattern, (match, key: string) => {
    const entry = values[key];
    return entry ? entry.display : match;
  });
}
