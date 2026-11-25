import { z } from "zod";
import { goalProgressSchema } from "../contracts/goal-progress";

const cents = z.number().int().nonnegative().max(2_200_000_000_000);
const pointSchema = z.object({ month: z.number().int().nonnegative(), savedCents: cents }).strict();

export const investingEligibilitySchema = z.object({
  eligible: z.boolean(),
  contentId: z.string(),
  ruleName: z.string(),
  thresholdCents: cents.optional(),
  cashAfterCents: cents,
  reason: z.string(),
  evaluatedBy: z.literal("treatment-selector"),
}).strict();
export type InvestingEligibility = z.infer<typeof investingEligibilitySchema>;

const base = {
  months: z.number().int().min(1).max(120),
  savedCents: cents,
  targetCents: cents,
  monthlyCents: cents,
};

export const projectionSchema = z.object({
  ...base,
  projectedCents: cents,
  remainingCents: cents,
  points: z.array(pointSchema).min(2).max(13),
  transferFromCashCents: cents.optional(),
  portfolioCashBeforeCents: cents.optional(),
  portfolioCashAfterCents: cents.optional(),
  baselineProjectedCents: cents.optional(),
  baselinePoints: z.array(pointSchema).min(2).max(13).optional(),
  investingEligibility: investingEligibilitySchema.optional(),
}).strict();

export const contributionSchema = z.object(base).strict();

export function savingsProjection(
  progress: unknown,
  months: number,
  monthlyCents: number,
  options?: {
    transferFromCashCents?: number;
    portfolioCashBeforeCents?: number;
    investingEligibility?: InvestingEligibility;
  },
) {
  const goal = goalProgressSchema.parse(progress);
  const savedCents = goal.history.at(-1)!.savedCents;
  const rawTransfer = Math.max(0, Math.round(options?.transferFromCashCents ?? 0));
  const portfolioCashBeforeCents = options?.portfolioCashBeforeCents !== undefined
    ? Math.max(0, Math.round(options.portfolioCashBeforeCents))
    : undefined;
  const transferFromCashCents = portfolioCashBeforeCents !== undefined
    ? Math.min(rawTransfer, portfolioCashBeforeCents)
    : rawTransfer;
  const portfolioCashAfterCents = portfolioCashBeforeCents !== undefined
    ? Math.max(0, portfolioCashBeforeCents - transferFromCashCents)
    : undefined;

  const baselineProjectedCents = savedCents + months * monthlyCents;
  const projectedCents = savedCents + transferFromCashCents + months * monthlyCents;
  const interval = Math.ceil(months / 12);
  const stepsCount = Math.ceil(months / interval) + 1;

  const baselinePoints = Array.from({ length: stepsCount }, (_, index) => {
    const month = Math.min(months, index * interval);
    return { month, savedCents: savedCents + month * monthlyCents };
  });
  const points = Array.from({ length: stepsCount }, (_, index) => {
    const month = Math.min(months, index * interval);
    return { month, savedCents: savedCents + transferFromCashCents + month * monthlyCents };
  });

  return projectionSchema.parse({
    months,
    monthlyCents,
    savedCents,
    targetCents: goal.targetCents,
    projectedCents,
    remainingCents: Math.max(0, goal.targetCents - projectedCents),
    points,
    transferFromCashCents,
    baselineProjectedCents,
    baselinePoints,
    ...(portfolioCashBeforeCents !== undefined ? { portfolioCashBeforeCents, portfolioCashAfterCents } : {}),
    ...(options?.investingEligibility ? { investingEligibility: options.investingEligibility } : {}),
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
