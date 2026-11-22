import { z } from "zod";
import type { RouteDecision } from "./domain";

export const homeDownPaymentGoalId = "home_down_payment";
export const goalMonthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const savedAmount = z.number().int().nonnegative().max(1_000_000_000_000);
export const goalProgressPayloadSchema = z.object({
  fixtureVersion: z.string().min(1),
  goalId: z.literal(homeDownPaymentGoalId),
  currency: z.literal("USD"),
  targetCents: savedAmount.positive(),
  history: z.array(z.object({
    month: z.string().regex(goalMonthPattern),
    savedCents: savedAmount,
  }).strict()).min(2).max(12),
}).strict();

export const goalProgressSchema = goalProgressPayloadSchema.refine(
  ({ history }) => history.every(({ month }, index) => index === 0 || history[index - 1].month < month),
  { message: "Goal history must use distinct months in chronological order.", path: ["history"] },
);
export type GoalProgress = z.infer<typeof goalProgressSchema>;

export function isHomeGoalSummary(route: Pick<RouteDecision, "contextId" | "intent">) {
  return route.contextId === "goals" && route.intent.task === "show";
}
