import fixtures from "../../fixtures/demo-goal-progress.json";
import host from "../../fixtures/host.json";
import { goalProgressSchema, type GoalProgress } from "../contracts/goal-progress";
import { getActiveCustomerProfileStore } from "../customer-profiles";

export interface GoalProgressProvider {
  read(mid: string, signal?: AbortSignal): Promise<GoalProgress | null>;
}

const { fixtureVersion, goalId, currency, goals } = fixtures;
const byMid = new Map(goals.map(({ mid, ...progress }) => [
  mid, goalProgressSchema.parse({ fixtureVersion, goalId, currency, ...progress }),
]));
if (byMid.size !== goals.length || goals.some(({ mid }) => !host.personas.some(({ syntheticMid }) => syntheticMid === mid))) {
  throw new Error("Invalid demo goal progress bindings");
}

export const fixtureGoalProgressProvider: GoalProgressProvider = {
  async read(mid, signal) {
    signal?.throwIfAborted();
    const live = getActiveCustomerProfileStore();
    if (live) {
      const progress = live.goalProgress(mid);
      if (progress) return progress;
      if (live.findByMid(mid)) return null;
    }
    return byMid.get(mid) ?? null;
  },
};
