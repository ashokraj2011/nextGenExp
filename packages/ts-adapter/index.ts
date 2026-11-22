import { z } from "zod";
import { contextCatalogSchema, type ContextCatalog } from "../contracts/domain";
import { normalizedIdsSchema, treatmentOverride, type MockOutput, type TreatmentOverride } from "../contracts/tool-setup";
import rawCatalog from "../../fixtures/contexts.json";
import rawScenarios from "../../fixtures/treatment-scenarios.json";
import host from "../../fixtures/host.json";

const rejectionSchema = z.object({
  contentId: z.string(), stage: z.enum(["simulated_ccre", "catalog_resolution"]), reasonCode: z.string(),
}).strict();
export type Rejection = z.infer<typeof rejectionSchema>;
const fixtureRule = z.object({
  context: z.string(),
  fromTurn: z.number().int().positive(),
  eligible: normalizedIdsSchema.optional(),
  error: z.literal("TS_TIMEOUT").optional(),
  rejections: z.array(rejectionSchema).optional(),
}).strict().refine((rule) => (rule.eligible === undefined) !== (rule.error === undefined));
const catalog = contextCatalogSchema.parse(rawCatalog);
export const tsFixtures = z.object({
  fixtureVersion: z.string(),
  base: z.record(normalizedIdsSchema),
  scenarios: z.array(z.object({ scenarioId: z.string(), label: z.string(), rules: z.array(fixtureRule) }).strict()),
}).strict().parse(rawScenarios);
export const scenariosById = new Map(tsFixtures.scenarios.map((scenario) => [scenario.scenarioId, scenario]));
export const fixtureEligibleSets = [
  ...Object.values(tsFixtures.base),
  ...tsFixtures.scenarios.flatMap(({ rules }) => rules.flatMap((rule) => rule.eligible ? [rule.eligible] : [])),
];
export const activeContexts = catalog.contexts.filter((context) => context.active);
export const activeContextCatalog: ContextCatalog = { ...catalog, contexts: activeContexts };
if (new Set(catalog.contexts.map((entry) => entry.contextId)).size !== catalog.contexts.length
  || scenariosById.size !== tsFixtures.scenarios.length
  || activeContexts.some(({ contextId }) => !Object.hasOwn(tsFixtures.base, contextId))
  || host.personas.some((persona) => persona.allowedScenarios.some((scenario) => !scenariosById.has(scenario)))) {
  throw new Error("Invalid TS fixture bindings");
}

export type FixtureState = Readonly<{ scenarioId: string; ordinal: number }>;
export interface TsAdapter {
  listContexts(signal?: AbortSignal): Promise<ContextCatalog>;
  getRankedEligibleIds(request: { mid: string; context: string }, signal?: AbortSignal): Promise<string[]>;
}

function fixtureRuleFor(state: FixtureState, context: string) {
  const scenario = scenariosById.get(state.scenarioId);
  if (!scenario) throw new Error("Unknown TS fixture scenario");
  return scenario.rules
    .filter((rule) => rule.fromTurn <= state.ordinal && (rule.context === context || rule.context === "*"))
    .sort((a, b) => b.fromTurn - a.fromTurn || Number(b.context === context) - Number(a.context === context))[0];
}

export function fixtureRejections(state: FixtureState, context: string): Rejection[] {
  return fixtureRuleFor(state, context)?.rejections ?? [];
}

export class TreatmentSelectorTimeout extends Error {
  constructor() { super("TS_TIMEOUT"); }
}

export class FixtureTsAdapter implements TsAdapter {
  constructor(private readonly state: FixtureState, private readonly overrides: readonly TreatmentOverride[] = []) {}

  async listContexts(signal?: AbortSignal): Promise<ContextCatalog> {
    signal?.throwIfAborted();
    if (this.state.scenarioId === "catalog-unavailable") throw new Error("TS_CONTEXT_CATALOG_UNAVAILABLE");
    return activeContextCatalog;
  }

  async getRankedEligibleIds({ mid, context }: { mid: string; context: string }, signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted();
    const authorized = host.personas.some((persona) => (
      persona.syntheticMid === mid && persona.allowedScenarios.includes(this.state.scenarioId)
    ));
    if (!authorized || !activeContexts.some((entry) => entry.contextId === context)) {
      throw new Error("UNCONFIGURED_TS_SCOPE");
    }

    const override: MockOutput | undefined = treatmentOverride(this.overrides, this.state.scenarioId, context)?.output;
    if (override) {
      if (override.mode === "timeout") throw new TreatmentSelectorTimeout();
      return override.mode === "empty" ? [] : [...override.contentIds];
    }
    const rule = fixtureRuleFor(this.state, context);
    if (rule?.error) throw new TreatmentSelectorTimeout();
    return [...(rule?.eligible ?? tsFixtures.base[context])];
  }
}
