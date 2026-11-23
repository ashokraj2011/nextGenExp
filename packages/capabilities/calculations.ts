import { z } from "zod";
import { goalProgressSchema } from "../contracts/goal-progress";

const cents = z.number().int().nonnegative().max(2_200_000_000_000);
const base = {
  months: z.number().int().min(1).max(120),
  savedCents: cents,
  targetCents: cents,
  monthlyCents: cents,
};
export const projectionSchema = z.object({
  ...base, projectedCents: cents, remainingCents: cents,
  points: z.array(z.object({ month: z.number().int().nonnegative(), savedCents: cents }).strict()).min(2).max(13),
}).strict();
export const contributionSchema = z.object(base).strict();

export function savingsProjection(progress: unknown, months: number, monthlyCents: number) {
  const goal = goalProgressSchema.parse(progress);
  const savedCents = goal.history.at(-1)!.savedCents;
  const projectedCents = savedCents + months * monthlyCents;
  const interval = Math.ceil(months / 12);
  const points = Array.from({ length: Math.ceil(months / interval) + 1 }, (_, index) => {
    const month = Math.min(months, index * interval);
    return { month, savedCents: savedCents + month * monthlyCents };
  });
  return projectionSchema.parse({
    months, monthlyCents, savedCents, targetCents: goal.targetCents, projectedCents,
    remainingCents: Math.max(0, goal.targetCents - projectedCents), points,
  });
}

export function requiredContribution(progress: unknown, months: number) {
  const goal = goalProgressSchema.parse(progress);
  const savedCents = goal.history.at(-1)!.savedCents;
  return contributionSchema.parse({
    months, savedCents, targetCents: goal.targetCents,
    monthlyCents: Math.ceil(Math.max(0, goal.targetCents - savedCents) / months),
  });
}
