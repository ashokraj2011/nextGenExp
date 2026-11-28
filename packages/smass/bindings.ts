import { z } from "zod";

/**
 * Canonical smass-backed domain field binding catalog.
 * Replaces legacy `packages/contracts/data-bindings.ts` so every field key maps to its canonical
 * smass domain model & field path (`smassModel`, `smassField`), with zero UI or server imports.
 */
export const dataDictionary = [
  { key: "customer.displayName", smassModel: "wealth.customer", smassField: "displayName", group: "Customer Profile", label: "Customer name", kind: "text" },
  { key: "customer.segment", smassModel: "wealth.customer", smassField: "segment", group: "Customer Profile", label: "Customer segment", kind: "text" },
  { key: "customer.fundingStatus", smassModel: "wealth.customer", smassField: "fundingStatus", group: "Customer Profile", label: "Account funding status", kind: "text" },
  { key: "customer.beneficiaryStatus", smassModel: "wealth.customer", smassField: "beneficiaryStatus", group: "Customer Profile", label: "Beneficiary status", kind: "text" },
  { key: "balances.available", smassModel: "wealth.balances", smassField: "availableCents", group: "Balances", label: "Available balance ($)", kind: "currency" },
  { key: "balances.current", smassModel: "wealth.balances", smassField: "currentCents", group: "Balances", label: "Current balance ($)", kind: "currency" },
  { key: "portfolio.total", smassModel: "wealth.portfolio", smassField: "totalCents", group: "Portfolio", label: "Total portfolio value ($)", kind: "currency" },
  { key: "portfolio.invested", smassModel: "wealth.portfolio", smassField: "investedCents", group: "Portfolio", label: "Invested assets ($)", kind: "currency" },
  { key: "portfolio.cash", smassModel: "wealth.portfolio", smassField: "cashCents", group: "Portfolio", label: "Cash reserve ($)", kind: "currency" },
  { key: "portfolio.equities", smassModel: "wealth.portfolio", smassField: "equityCents", group: "Portfolio", label: "Equities ($)", kind: "currency" },
  { key: "portfolio.fixedIncome", smassModel: "wealth.portfolio", smassField: "fixedIncomeCents", group: "Portfolio", label: "Fixed income ($)", kind: "currency" },
  { key: "portfolio.cashPct", smassModel: "wealth.portfolio", smassField: "cashPct", group: "Portfolio", label: "Cash share (%)", kind: "percent" },
  { key: "portfolio.equitiesPct", smassModel: "wealth.portfolio", smassField: "equitiesPct", group: "Portfolio", label: "Equities share (%)", kind: "percent" },
  { key: "portfolio.fixedIncomePct", smassModel: "wealth.portfolio", smassField: "fixedIncomePct", group: "Portfolio", label: "Fixed income share (%)", kind: "percent" },
  { key: "goal.target", smassModel: "wealth.home_goal", smassField: "targetCents", group: "Home Goal", label: "Home goal target ($)", kind: "currency" },
  { key: "goal.saved", smassModel: "wealth.home_goal", smassField: "savedCents", group: "Home Goal", label: "Home goal saved ($)", kind: "currency" },
  { key: "goal.remaining", smassModel: "wealth.home_goal", smassField: "remainingCents", group: "Home Goal", label: "Home goal remaining ($)", kind: "currency" },
  { key: "goal.percentFunded", smassModel: "wealth.home_goal", smassField: "percentFunded", group: "Home Goal", label: "Home goal funded (%)", kind: "percent" },
  { key: "incident.id", smassModel: "ops.incident", smassField: "id", group: "IT Operations (Live)", label: "Active incident ID", kind: "text" },
  { key: "incident.title", smassModel: "ops.incident", smassField: "title", group: "IT Operations (Live)", label: "Incident title", kind: "text" },
  { key: "incident.severity", smassModel: "ops.incident", smassField: "severity", group: "IT Operations (Live)", label: "Severity", kind: "text" },
  { key: "incident.status", smassModel: "ops.incident", smassField: "status", group: "IT Operations (Live)", label: "Incident status", kind: "text" },
  { key: "incident.service", smassModel: "ops.incident", smassField: "service", group: "IT Operations (Live)", label: "Affected service", kind: "text" },
  { key: "incident.environment", smassModel: "ops.incident", smassField: "environment", group: "IT Operations (Live)", label: "Environment", kind: "text" },
  { key: "incident.errorRate", smassModel: "ops.incident", smassField: "errorRate", group: "IT Operations (Live)", label: "Error rate (%)", kind: "percent" },
  { key: "incident.p95Latency", smassModel: "ops.incident", smassField: "p95LatencyMs", group: "IT Operations (Live)", label: "p95 Latency (ms)", kind: "text" },
  { key: "incident.currentRelease", smassModel: "ops.incident", smassField: "currentRelease", group: "IT Operations (Live)", label: "Current release", kind: "text" },
  { key: "incident.previousRelease", smassModel: "ops.incident", smassField: "previousRelease", group: "IT Operations (Live)", label: "Previous healthy release", kind: "text" },
  { key: "incident.rollbackStatus", smassModel: "ops.incident", smassField: "rollbackStatus", group: "IT Operations (Live)", label: "Rollback status", kind: "text" },
  { key: "deal.id", smassModel: "sales.deal", smassField: "id", group: "Sales / RevOps (Live)", label: "Active deal ID", kind: "text" },
  { key: "deal.accountName", smassModel: "sales.deal", smassField: "accountName", group: "Sales / RevOps (Live)", label: "Account name", kind: "text" },
  { key: "deal.title", smassModel: "sales.deal", smassField: "title", group: "Sales / RevOps (Live)", label: "Deal title", kind: "text" },
  { key: "deal.stage", smassModel: "sales.deal", smassField: "stage", group: "Sales / RevOps (Live)", label: "Deal stage", kind: "text" },
  { key: "deal.arr", smassModel: "sales.deal", smassField: "arrCents", group: "Sales / RevOps (Live)", label: "Annual value (ARR $)", kind: "currency" },
  { key: "deal.discountPct", smassModel: "sales.deal", smassField: "discountPct", group: "Sales / RevOps (Live)", label: "Discount requested (%)", kind: "percent" },
  { key: "deal.discountStatus", smassModel: "sales.deal", smassField: "discountStatus", group: "Sales / RevOps (Live)", label: "Discount approval status", kind: "text" },
  { key: "deal.winProbability", smassModel: "sales.deal", smassField: "winProbability", group: "Sales / RevOps (Live)", label: "Win probability (%)", kind: "percent" },
  { key: "deal.closeDate", smassModel: "sales.deal", smassField: "closeDate", group: "Sales / RevOps (Live)", label: "Target close date", kind: "text" },
  { key: "deal.owner", smassModel: "sales.deal", smassField: "owner", group: "Sales / RevOps (Live)", label: "Deal owner", kind: "text" },
] as const;

export const smassFieldBindingCatalog = dataDictionary;

export type BuiltInDataBindingKey = (typeof dataDictionary)[number]["key"];
const bindingKeys = dataDictionary.map((entry) => entry.key) as [BuiltInDataBindingKey, ...BuiltInDataBindingKey[]];
export const customBindingKeySchema = z.string().regex(/^custom\.[a-z][a-z0-9_]{0,47}$/);
export const smassBindingKeySchema = z.union([z.enum(bindingKeys), customBindingKeySchema]);
export const dataBindingKeySchema = smassBindingKeySchema;
export type DataBindingKey = z.infer<typeof smassBindingKeySchema>;

export type ResolvedBindingEntry = {
  display: string;
  rawInput: string;
  percent?: number;
};

export type DataBindingValues = Record<string, ResolvedBindingEntry>;

const editableProfileBindings = new Set<string>([
  "customer.displayName", "customer.segment", "customer.fundingStatus", "customer.beneficiaryStatus",
  "balances.available", "balances.current", "portfolio.cash", "portfolio.equities", "portfolio.fixedIncome", "goal.target", "goal.saved",
]);

export function canSaveProfileBinding(key: string): boolean {
  return editableProfileBindings.has(key) || customBindingKeySchema.safeParse(key).success;
}

export function bindingLabel(key: DataBindingKey): string {
  const builtIn = dataDictionary.find((d) => d.key === key);
  if (builtIn) return builtIn.label;
  if (key.startsWith("custom.")) {
    return key.slice(7).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return key;
}

export function smassPathForBindingKey(key: DataBindingKey): string {
  const builtIn = dataDictionary.find((d) => d.key === key);
  return builtIn ? `${builtIn.smassModel}.${builtIn.smassField}` : key;
}

const tokenPattern = /\{\{\s*([a-z]+\.[a-zA-Z0-9_]+)\s*\}\}/g;

export function interpolateBindingTokens(template: string, values?: DataBindingValues): string {
  if (!values || !template.includes("{{")) return template;
  return template.replace(tokenPattern, (match, key: string) => {
    const entry = values[key];
    return entry ? entry.display : match;
  });
}
