import { z } from "zod";
import type { RouteDecision } from "./domain";

const amount = z.number().int().nonnegative().max(1_000_000_000_000);
export const portfolioSnapshotSchema = z.object({
  fixtureVersion: z.string().min(1),
  asOf: z.string().datetime(),
  currency: z.literal("USD"),
  cashCents: amount,
  equityCents: amount,
  fixedIncomeCents: amount,
}).strict();
export type PortfolioSnapshot = z.infer<typeof portfolioSnapshotSchema>;
export const portfolioHistoryPointSchema = z.object({ date: z.string().date(), totalCents: amount }).strict();
export type PortfolioHistoryPoint = z.infer<typeof portfolioHistoryPointSchema>;

export function isPortfolioSummary(route: Pick<RouteDecision, "contextId" | "intent">) {
  return route.contextId === "portsum" && route.intent.task === "show";
}

const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
const usdCents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** "$120,304" for whole dollars, "$35,738.20" otherwise (never "$35,738.2"). */
export function formatPortfolioAmount(cents: number) {
  return (Number.isInteger(cents) && cents % 100 === 0 ? usdWhole : usdCents).format(cents / 100);
}
