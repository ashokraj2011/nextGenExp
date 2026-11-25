import { z } from "zod";
import host from "../../fixtures/host.json";
import raw from "../../fixtures/demo-portfolio-snapshots.json";
import historyFixture from "../../fixtures/demo-portfolio-history.json";
import { portfolioHistoryPointSchema, portfolioSnapshotSchema, type PortfolioSnapshot } from "../contracts/portfolio";
import { getActiveCustomerProfileStore } from "../customer-profiles";

export interface PortfolioSnapshotProvider {
  read(mid: string, signal?: AbortSignal): Promise<PortfolioSnapshot | null>;
}

const { fixtureVersion, asOf, currency, snapshots } = z.object({
  fixtureVersion: portfolioSnapshotSchema.shape.fixtureVersion,
  asOf: portfolioSnapshotSchema.shape.asOf,
  currency: portfolioSnapshotSchema.shape.currency,
  snapshots: portfolioSnapshotSchema.pick({ cashCents: true, equityCents: true, fixedIncomeCents: true })
    .extend({ mid: z.string().min(1) }).strict().array(),
}).strict().parse(raw);
const byMid = new Map(snapshots.map(({ mid, ...balances }) => [mid, balances]));
if (byMid.size !== snapshots.length || snapshots.some(({ mid }) => !host.personas.some(({ syntheticMid }) => syntheticMid === mid))) {
  throw new Error("Invalid demo portfolio snapshot bindings");
}
const snapshotDate = asOf.slice(0, 10);
const historyByMid = z.record(z.array(portfolioHistoryPointSchema).min(1).max(60)).parse(historyFixture);
if (Object.entries(historyByMid).some(([mid, points]) => !byMid.has(mid)
  || points.some(({ date }, index) => date >= snapshotDate || (index > 0 && points[index - 1].date >= date)))) {
  throw new Error("Invalid demo portfolio history");
}

export function fixturePortfolioHistory(mid: string) {
  const live = getActiveCustomerProfileStore();
  if (live) {
    const customHistory = live.portfolioHistory(mid);
    if (customHistory.length > 0) return customHistory;
  }
  const history = historyByMid[mid];
  const snapshot = byMid.get(mid);
  if (!history || !snapshot) return [];
  return [...history, { date: snapshotDate, totalCents: snapshot.cashCents + snapshot.equityCents + snapshot.fixedIncomeCents }];
}

export const fixturePortfolioSnapshotProvider: PortfolioSnapshotProvider = {
  async read(mid, signal) {
    signal?.throwIfAborted();
    const live = getActiveCustomerProfileStore();
    if (live) {
      const snapshot = live.portfolioSnapshot(mid);
      if (snapshot) return snapshot;
    }
    const balances = byMid.get(mid);
    return balances ? { fixtureVersion, asOf, currency, ...balances } : null;
  },
};
