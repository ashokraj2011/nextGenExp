import { axeBudget, type ExecutionBudget } from "../../packages/contracts/agentic";

export function agenticBudgetFromEnv(value: string | undefined): ExecutionBudget {
  if (!value) return axeBudget;
  let overrides: unknown;
  try { overrides = JSON.parse(value); } catch { throw new Error("PZN_AXE_BUDGET_JSON must be valid JSON."); }
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("PZN_AXE_BUDGET_JSON must be an object.");
  const budget: ExecutionBudget = { ...axeBudget };
  for (const [name, limit] of Object.entries(overrides)) {
    if (!Object.hasOwn(axeBudget, name) || typeof limit !== "number" || !Number.isInteger(limit)) {
      throw new Error("PZN_AXE_BUDGET_JSON contains an unknown budget or invalid value.");
    }
    const key = name as keyof ExecutionBudget;
    if (limit < (key === "clarifications" ? 0 : 1) || limit > axeBudget[key]) {
      throw new Error("PZN_AXE_BUDGET_JSON limits must stay within the supported range.");
    }
    budget[key] = limit;
  }
  return budget;
}
