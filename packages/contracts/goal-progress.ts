import { z } from "zod";
import type { RouteDecision } from "./domain";

export const homeDownPaymentGoalId = "home_down_payment";
export const goalMonthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
export const goalMonthSchema = z.string().regex(goalMonthPattern);
export const defaultExtraMonthlyCents = 50_000;
export const goalProjectionMonths = 120;
export const extraMonthlyCentsSchema = z.number().int().positive().max(500_000);
const savedAmount = z.number().int().nonnegative().max(1_000_000_000_000);
export const goalMonthlyContributionSchema = z.number().int().nonnegative().max(100_000_000);
export const goalProgressPayloadSchema = z.object({
  fixtureVersion: z.string().min(1),
  goalId: z.literal(homeDownPaymentGoalId),
  currency: z.literal("USD"),
  targetCents: savedAmount.positive(),
  monthlyContributionCents: goalMonthlyContributionSchema.optional(),
  history: z.array(z.object({
    month: goalMonthSchema,
    savedCents: savedAmount,
  }).strict()).min(2).max(12),
}).strict();

export const goalProgressSchema = goalProgressPayloadSchema.refine(
  ({ history }) => history.every(({ month }, index) => index === 0 || history[index - 1].month < month),
  { message: "Goal history must use distinct months in chronological order.", path: ["history"] },
);
export type GoalProgress = z.infer<typeof goalProgressSchema>;

const projectedAmount = z.number().int().nonnegative().max(1_100_000_000_000);
export const goalSavingsProjectionSchema = z.object({
  currentMonthlyCents: goalMonthlyContributionSchema,
  extraMonthlyCents: extraMonthlyCentsSchema,
  startMonth: goalMonthSchema,
  currentTargetMonth: goalMonthSchema.nullable(),
  projectedTargetMonth: goalMonthSchema.nullable(),
  points: z.array(z.object({
    month: goalMonthSchema,
    currentCents: projectedAmount,
    projectedCents: projectedAmount,
  }).strict()).min(2).max(goalProjectionMonths + 2),
}).strict();
export type GoalSavingsProjection = z.infer<typeof goalSavingsProjectionSchema>;
export type GoalScenarioUpdate = { sourceTurnId: string; projection: GoalSavingsProjection };

export function goalMonthIndex(month: string) {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1;
}

export function goalMonthAt(index: number) {
  return String(Math.floor(index / 12)).padStart(4, "0") + "-" + String(index % 12 + 1).padStart(2, "0");
}

export function firstGoalContributionMonth(goal: GoalProgress, asOf: number) {
  const currentMonth = new Date(asOf).toISOString().slice(0, 7);
  return goalMonthAt(goalMonthIndex(currentMonth > goal.history.at(-1)!.month ? currentMonth : goal.history.at(-1)!.month) + 1);
}

const monthFormatter = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
export function formatGoalMonth(month: string) {
  return monthFormatter.format(new Date(month + "-01T00:00:00Z"));
}

export function isHomeGoalSummary(route: Pick<RouteDecision, "contextId" | "intent">) {
  return route.contextId === "goals" && route.intent.task === "show";
}
