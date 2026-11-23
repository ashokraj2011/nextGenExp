import { z } from "zod";
import type { PropensityResult } from "../contracts/domain";
import rawPropensity from "../../fixtures/propensity.json";

const scoreMap = z.record(z.number().min(0).max(1).nullable());
const fixture = z.object({
  version: z.string(),
  classification: z.literal("synthetic_advisory"),
  defaults: z.record(scoreMap),
  overrides: z.array(z.object({ personaId: z.string(), scenarioId: z.string(), scores: scoreMap.nullable() }).strict()),
}).strict().parse(rawPropensity);

export function scoreContexts(personaId: string, scenarioId: string, contextIds: readonly string[]): PropensityResult {
  const override = fixture.overrides.find((item) => item.personaId === personaId && item.scenarioId === scenarioId);
  const scores = override ? override.scores : fixture.defaults[personaId];
  return {
    version: fixture.version,
    classification: fixture.classification,
    status: scores ? "available" : "unavailable",
    scores: contextIds.map((contextId) => ({ contextId, score: scores?.[contextId] ?? null })),
  };
}
