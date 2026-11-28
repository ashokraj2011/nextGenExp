import { z } from "zod";
import {
  extraMonthlyCentsSchema, goalMonthAt, goalMonthIndex, goalMonthSchema, goalProgressSchema, goalProjectionMonths, goalSavingsProjectionSchema,
} from "../contracts/goal-progress";

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

export function projectExtraGoalSavings(progress: unknown, extraCents: number, firstMonth: string, startMonth: string) {
  const goal = goalProgressSchema.parse(progress);
  const currentMonthlyCents = goal.monthlyContributionCents;
  const extraMonthlyCents = extraMonthlyCentsSchema.parse(extraCents);
  const latest = goal.history.at(-1)!;
  const first = goalMonthIndex(goalMonthSchema.parse(firstMonth));
  const delay = goalMonthIndex(goalMonthSchema.parse(startMonth)) - first;
  if (currentMonthlyCents === undefined || first <= goalMonthIndex(latest.month) || delay < 0 || delay >= goalProjectionMonths) {
    throw new Error("Goal savings assumptions are unavailable.");
  }
  const remaining = Math.max(0, goal.targetCents - latest.savedCents);
  const currentMonths = remaining === 0 ? 0 : Math.ceil(remaining / currentMonthlyCents);
  const projectedMonths = delay * currentMonthlyCents >= remaining
    ? currentMonths
    : delay + Math.ceil((remaining - delay * currentMonthlyCents) / (currentMonthlyCents + extraMonthlyCents));
  const targetMonth = (months: number) => remaining <= 0 ? latest.month
    : months <= goalProjectionMonths ? goalMonthAt(first + months - 1) : null;
  const horizon = Math.min(goalProjectionMonths, Math.max(12, delay + 1,
    Number.isFinite(currentMonths) ? currentMonths : projectedMonths));
  const opening = { month: latest.month, currentCents: latest.savedCents, projectedCents: latest.savedCents };

  return goalSavingsProjectionSchema.parse({
    currentMonthlyCents,
    extraMonthlyCents,
    startMonth,
    currentTargetMonth: targetMonth(currentMonths),
    projectedTargetMonth: targetMonth(projectedMonths),
    points: [
      opening,
      ...(first > goalMonthIndex(latest.month) + 1 ? [{ ...opening, month: goalMonthAt(first - 1) }] : []),
      ...Array.from({ length: horizon }, (_, index) => {
        const currentCents = latest.savedCents + (index + 1) * currentMonthlyCents;
        return { month: goalMonthAt(first + index), currentCents,
          projectedCents: currentCents + Math.max(0, index + 1 - delay) * extraMonthlyCents };
      }),
    ],
  });
}

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
