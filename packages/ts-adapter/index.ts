import { z } from "zod";
import { contextCatalogSchema, type ContextCatalog } from "../contracts/domain";
import { normalizedIdsSchema, treatmentOverride, type MockCcreRule, type TreatmentOverride } from "../contracts/tool-setup";
import rawCatalog from "../../fixtures/contexts.json";
import rawScenarios from "../../fixtures/treatment-scenarios.json";
import host from "../../fixtures/host.json";
import { applyMockCcreRules } from "./mock-ccre";

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
type TreatmentRequest = { mid: string; context: string };
export interface TsAdapter {
  listContexts(signal?: AbortSignal): Promise<ContextCatalog>;
  getRankedEligibleIds(request: TreatmentRequest, signal?: AbortSignal): Promise<string[]>;
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
  constructor(
    private readonly state: FixtureState,
    private readonly overrides: readonly TreatmentOverride[] = [],
    private readonly ccreRules: readonly MockCcreRule[] = [],
  ) {}

  async listContexts(signal?: AbortSignal): Promise<ContextCatalog> {
    signal?.throwIfAborted();
    if (this.state.scenarioId === "catalog-unavailable") throw new Error("TS_CONTEXT_CATALOG_UNAVAILABLE");
    return activeContextCatalog;
  }

  async getRankedEligibleIds(request: TreatmentRequest, signal?: AbortSignal): Promise<string[]> {
    return this.selectEligibleContent(request, signal).contentIds;
  }

  selectEligibleContent({ mid, context }: TreatmentRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const persona = host.personas.find((persona) => (
      persona.syntheticMid === mid && persona.allowedScenarios.includes(this.state.scenarioId)
    ));
    if (!persona || !activeContexts.some((entry) => entry.contextId === context)) {
      throw new Error("UNCONFIGURED_TS_SCOPE");
    }

    const override = treatmentOverride(this.overrides, this.state.scenarioId, context)?.output;
    const fixture = override ? undefined : fixtureRuleFor(this.state, context);
    if (override?.mode === "timeout" || fixture?.error) throw new TreatmentSelectorTimeout();
    const ids = override?.mode === "empty" ? [] : (override?.contentIds ?? fixture?.eligible ?? tsFixtures.base[context]);
    return applyMockCcreRules([...ids], this.ccreRules, { ...this.state, contextId: context, personaId: persona.personaId });
  }
}
