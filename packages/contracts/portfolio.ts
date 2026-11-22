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

export function isPortfolioSummary(route: Pick<RouteDecision, "contextId" | "intent">) {
  return route.contextId === "portsum" && route.intent.task === "show";
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 });
export function formatPortfolioAmount(cents: number) {
  return usd.format(cents / 100);
}
