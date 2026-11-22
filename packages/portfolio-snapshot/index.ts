import { z } from "zod";
import host from "../../fixtures/host.json";
import raw from "../../fixtures/demo-portfolio-snapshots.json";
import { portfolioSnapshotSchema, type PortfolioSnapshot } from "../contracts/portfolio";

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

export const fixturePortfolioSnapshotProvider: PortfolioSnapshotProvider = {
  async read(mid, signal) {
    signal?.throwIfAborted();
    const balances = byMid.get(mid);
    return balances ? { fixtureVersion, asOf, currency, ...balances } : null;
  },
};
