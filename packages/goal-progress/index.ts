import fixtures from "../../fixtures/demo-goal-progress.json";
import host from "../../fixtures/host.json";
import { goalProgressSchema, type GoalProgress } from "../contracts/goal-progress";

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
    return byMid.get(mid) ?? null;
  },
};
