import { z } from "zod";
import { contextCatalogSchema, type ContextCatalog, type PropensityResult } from "../contracts/domain";
import { workflowRecommendationSchema, type TreatmentRecommendations } from "../contracts/funding-workflow";
import { portfolioSnapshotSchema } from "../contracts/portfolio";
import { mockCcreRuleSchema, normalizedIdsSchema, treatmentOverride, type MockCcreRule, type TreatmentOverride } from "../contracts/tool-setup";
import { pendingActionsContext } from "../contracts/workspace";
import { fixturePortfolioSnapshotProvider, type PortfolioSnapshotProvider } from "../portfolio-snapshot";
import { findProfileByMid } from "../customer-profiles";
import rawCatalog from "../../fixtures/contexts.json";
import rawScenarios from "../../fixtures/treatment-scenarios.json";
import host from "../../fixtures/host.json";
import { applyMockCcreRules } from "./mock-ccre";
import { scoreContexts } from "./propensity";
import { normalizeRecommendations, type Recommendation, type TreatmentV3 } from "./recommendations";
import { getActiveSelfServicePznProvider } from "../recommendations/self-service-engine";
import agenticRecommendations from "../../fixtures/agentic-recommendations.json";

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
  workflowRecommendations: z.array(z.object({
    contextId: z.string(), requiresContentIds: normalizedIdsSchema, recommendation: workflowRecommendationSchema,
  }).strict()).max(12),
  defaultCcreRules: z.array(mockCcreRuleSchema.omit({ scenarioId: true })),
  scenarios: z.array(z.object({ scenarioId: z.string(), label: z.string(), rules: z.array(fixtureRule) }).strict()),
}).strict().parse(rawScenarios);
export const scenariosById = new Map(tsFixtures.scenarios.map((scenario) => [scenario.scenarioId, scenario]));
export const fixtureEligibleSets = [
  ...Object.values(tsFixtures.base),
  ...tsFixtures.scenarios.flatMap(({ rules }) => rules.flatMap((rule) => rule.eligible ? [rule.eligible] : [])),
];
export const activeContexts = catalog.contexts.filter((context) => context.active);
export const activeContextCatalog: ContextCatalog = { ...catalog, contexts: activeContexts };
export const treatmentContexts = [...activeContexts, { contextId: pendingActionsContext, displayName: "Pending actions" }];
if (new Set(catalog.contexts.map((entry) => entry.contextId)).size !== catalog.contexts.length
  || scenariosById.size !== tsFixtures.scenarios.length
  || treatmentContexts.some(({ contextId }) => !Object.hasOwn(tsFixtures.base, contextId))
  || host.personas.some((persona) => persona.allowedScenarios.some((scenario) => !scenariosById.has(scenario)))) {
  throw new Error("Invalid TS fixture bindings");
}

export type FixtureState = Readonly<{ scenarioId: string; ordinal: number }>;
type TreatmentRequest = { mid: string; context: string; overrideCashCents?: number };
export type ContextScoresRequest = { mid: string; contextIds: string[] };
export interface TsAdapter {
  listContexts(signal?: AbortSignal): Promise<ContextCatalog>;
  getContextScores(request: ContextScoresRequest, signal?: AbortSignal): Promise<PropensityResult>;
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
    private readonly portfolios: PortfolioSnapshotProvider = fixturePortfolioSnapshotProvider,
    private readonly fundingStatus?: "funded" | "unfunded",
  ) {}

  private personaFor(mid: string) {
    const profile = findProfileByMid(mid);
    if (profile && profile.allowedScenarios.includes(this.state.scenarioId)) {
      return profile;
    }
    const persona = host.personas.find((entry) => (
      entry.syntheticMid === mid && entry.allowedScenarios.includes(this.state.scenarioId)
    ));
    if (!persona) throw new Error("UNCONFIGURED_TS_SCOPE");
    return persona;
  }

  async listContexts(signal?: AbortSignal): Promise<ContextCatalog> {
    signal?.throwIfAborted();
    if (this.state.scenarioId === "catalog-unavailable") throw new Error("TS_CONTEXT_CATALOG_UNAVAILABLE");
    const dynamicContexts = getActiveSelfServicePznProvider()?.listPublishedContextSummaries() ?? [];
    if (!dynamicContexts.length) return activeContextCatalog;
    const merged = [...activeContexts];
    for (const ctx of dynamicContexts) {
      if (!merged.some((existing) => existing.contextId === ctx.contextId)) {
        merged.push(ctx);
      }
    }
    return { ...catalog, contexts: merged };
  }

  async getContextScores({ mid, contextIds }: ContextScoresRequest, signal?: AbortSignal): Promise<PropensityResult> {
    signal?.throwIfAborted();
    return scoreContexts(this.personaFor(mid).personaId, this.state.scenarioId, contextIds);
  }

  async getRankedEligibleIds(request: TreatmentRequest, signal?: AbortSignal): Promise<string[]> {
    return (await this.selectEligibleContent(request, signal)).contentIds;
  }

  async selectEligibleContent({ mid, context, overrideCashCents }: TreatmentRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const persona = this.personaFor(mid);
    const isBuiltInContext = treatmentContexts.some((entry) => entry.contextId === context);
    const selfServiceProvider = getActiveSelfServicePznProvider();
    const selfServicePub = selfServiceProvider?.getPublishedPublication(context);
    if (selfServicePub && (!isBuiltInContext || selfServicePub.version > 1)) {
      const overrides = overrideCashCents !== undefined ? { "portfolio.cash_usd": overrideCashCents / 100 } : undefined;
      const evalResult = selfServiceProvider!.evaluatePublishedForTs(mid, context, overrides);
      if (evalResult) {
        const contentIds = evalResult.eligibleContents.map((c) => c.contentId);
        const beforeRules = [
          ...evalResult.eligibleContents.map((c) => c.contentId),
          ...evalResult.filteredOutContents.map((c) => c.contentId),
        ];
        const ccreResults = [
          ...evalResult.eligibleContents.map((c) => ({
            name: c.attachedRuleIds.length ? c.reason : "Always eligible",
            contentId: c.contentId,
            outcome: "matched" as const,
          })),
          ...evalResult.filteredOutContents.map((c) => ({
            name: c.reason,
            contentId: c.contentId,
            outcome: "excluded" as const,
          })),
        ];
        const recommendations: TreatmentRecommendations = {
          schemaVersion: "2.0",
          recommendations: contentIds.map((id) => ({ kind: "content" as const, id })),
        };
        return {
          contentIds,
          ccre: { beforeRules, results: ccreResults },
          portfolio: null,
          recommendations,
        };
      }
    }
    if (!isBuiltInContext) {
      throw new Error("UNCONFIGURED_TS_SCOPE");
    }

    const override = treatmentOverride(this.overrides, this.state.scenarioId, context)?.output;
    const fixture = override ? undefined : fixtureRuleFor(this.state, context);
    if (override?.mode === "timeout" || fixture?.error) throw new TreatmentSelectorTimeout();
    let ids = override?.mode === "empty" ? [] : (override?.contentIds ?? fixture?.eligible ?? tsFixtures.base[context]);
    if (!override && !fixture && context === "next-step" && this.fundingStatus === "funded") ids = [...ids, "account_first_deposit_complete"];
    const rules = this.ccreRules.filter((rule) => rule.scenarioId === this.state.scenarioId && rule.contextId === context);
    const configuredTargets = new Set(rules.map(({ contentId }) => contentId));
    const defaultRules = tsFixtures.defaultCcreRules
      .filter((rule) => rule.contextId === context && !configuredTargets.has(rule.contentId))
      .map((rule) => ({ ...rule, scenarioId: this.state.scenarioId }));
    const activeRules = [...rules, ...defaultRules];
    const needsPortfolio = activeRules.some(({ contentId, condition }) => (
      ids.includes(contentId) && condition.kind === "attribute" && condition.namespaceId === "portfolio"
    ));
    const reading = needsPortfolio && overrideCashCents === undefined ? await this.portfolios.read(mid, signal) : null;
    signal?.throwIfAborted();
    const portfolio = reading ? portfolioSnapshotSchema.parse(reading) : null;
    const effectiveCashCents = overrideCashCents !== undefined ? overrideCashCents : portfolio?.cashCents;
    const result = applyMockCcreRules([...ids], activeRules, {
      ...this.state, contextId: context, personaId: persona.personaId, portfolioCashCents: effectiveCashCents, fundingStatus: this.fundingStatus,
    });
    const recommendations: TreatmentRecommendations = {
      schemaVersion: "2.0",
      recommendations: [
        ...result.contentIds.map((id) => ({ kind: "content" as const, id })),
        ...tsFixtures.workflowRecommendations.filter(({ contextId, requiresContentIds }) => (
          contextId === context && requiresContentIds.every((id) => result.contentIds.includes(id))
        )).map(({ recommendation }) => recommendation),
      ],
    };
    return { ...result, portfolio, recommendations };
  }

  async selectRecommendations(request: TreatmentRequest, signal?: AbortSignal) {
    const selection = await this.selectEligibleContent(request, signal);
    const eligible = new Set(selection.contentIds);
    const recommendations = normalizeRecommendations(selection.recommendations);
    const funding = recommendations.find((entry) => entry.kind === "workflow" && entry.id === "account.funding.preview");
    const extensions: Omit<Extract<Recommendation, { kind: "capability" | "workflow" }>, "rank">[] = agenticRecommendations
      .filter(({ context, requiresContentIds }) => context === request.context && requiresContentIds.every((id) => eligible.has(id)))
      .map(({ id }) => ({ kind: "capability", id, version: "1.0.0" }));
    if (funding && !this.fundingStatus) extensions.push({ kind: "workflow", id: funding.id, version: "2.0.0" });
    const response: TreatmentV3 = {
      schemaVersion: "3.0", recommendations: [...recommendations, ...extensions.map((entry, index) => (
        { ...entry, rank: recommendations.length + index + 1 }
      ))],
    };
    return { ...selection, response };
  }
}
