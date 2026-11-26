import type { RuleWorkflowMatch } from "../contracts/customer-workflows";
import { z } from "zod";
import { contextCatalogSchema, type ContextCatalog, type PropensityResult } from "../contracts/domain";
import { actionRecommendationSchema, type TreatmentDecision, type TreatmentRecommendations, type WorkflowCandidate } from "../contracts/funding-workflow";
import { portfolioSnapshotSchema } from "../contracts/portfolio";
import { effectiveCcreRules, mockCcreConditionSchema, mockCcreRuleSchema, normalizedIdsSchema, treatmentOverride, type MockCcreRule, type TreatmentOverride } from "../contracts/tool-setup";
import { pendingActionsContext } from "../contracts/workspace";
import { fixturePortfolioSnapshotProvider, type PortfolioSnapshotProvider } from "../portfolio-snapshot";
import { memberRetirementAccounts } from "../retirement-accounts";
import { findProfileByMid } from "../customer-profiles";
import rawCatalog from "../../fixtures/contexts.json";
import rawScenarios from "../../fixtures/treatment-scenarios.json";
import host from "../../fixtures/host.json";
import { applyMockCcreRules, matchesCondition } from "./mock-ccre";
import { scoreContexts } from "./propensity";
import { normalizeRecommendations, type Recommendation, type TreatmentV3 } from "./recommendations";
import { getActiveSelfServicePznProvider, pznTextContentToCatalogEntry } from "../recommendations/self-service-engine";
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
  actionRules: z.array(z.object({
    contextId: z.string().min(1), name: z.string().min(1), condition: mockCcreConditionSchema, action: actionRecommendationSchema,
  }).strict()),
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
type TreatmentRequest = { mid: string; context: string; accountId?: string; overrideCashCents?: number };
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

function recommendationsFor(contentIds: string[], matches: RuleWorkflowMatch[]): TreatmentRecommendations {
  const workflows = new Map<string, WorkflowCandidate & { forContentIds: string[] }>();
  for (const { contentId, workflow } of matches) {
    const key = JSON.stringify([workflow.id, workflow.version]);
    const candidate = workflows.get(key);
    if (!candidate) workflows.set(key, { ...workflow, forContentIds: [contentId] });
    else if (!candidate.forContentIds.includes(contentId)) candidate.forContentIds.push(contentId);
  }
  return { schemaVersion: "2.0", recommendations: [
    ...contentIds.map((id) => ({ kind: "content" as const, id })), ...workflows.values(),
  ] };
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

  async selectEligibleContent({ mid, context, accountId, overrideCashCents }: TreatmentRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const persona = this.personaFor(mid);
    const account = accountId ? memberRetirementAccounts(mid).find((item) => item.id === accountId) : undefined;
    if (accountId && (!account || context !== "learning")) throw new Error("RETIREMENT_ACCOUNT_UNAVAILABLE");
    const activeRules = effectiveCcreRules(this.state.scenarioId, context, tsFixtures.defaultCcreRules, this.ccreRules);
    const scopedActionRules = tsFixtures.actionRules.filter((rule) => rule.contextId === context);
    const evaluate = async (ids: string[], rules: MockCcreRule[], published: RuleWorkflowMatch[] = [], contextAllowed = true) => {
      const needsPortfolio = rules.some(({ contentId, condition }) => (
        ids.includes(contentId) && condition.kind === "attribute" && condition.namespaceId === "portfolio"
      ));
      const needsActionPortfolio = scopedActionRules.some(({ condition }) => condition.kind === "attribute" && condition.namespaceId === "portfolio");
      const reading = (needsPortfolio || needsActionPortfolio) && overrideCashCents === undefined ? await this.portfolios.read(mid, signal) : null;
      signal?.throwIfAborted();
      const portfolio = reading ? portfolioSnapshotSchema.parse(reading) : null;
      const effectiveCashCents = overrideCashCents !== undefined ? overrideCashCents : portfolio?.cashCents;
      const input = {
        ...this.state, contextId: context, personaId: persona.personaId, portfolioCashCents: effectiveCashCents, fundingStatus: this.fundingStatus,
        ...(account && { beneficiaryStatus: account.beneficiary === null ? "missing" as const : "on_file" as const }),
      };
      const result = applyMockCcreRules([...ids], rules, input);
      const actionMatches = contextAllowed ? scopedActionRules.filter(({ condition }) => matchesCondition(condition, input)) : [];
      const workflowMatches = result.contentIds.flatMap((contentId) => {
        const rule = rules.find((r) => r.contentId === contentId);
        const matched = result.ccre?.results.some((r) => r.contentId === contentId && r.outcome === "matched");
        if (rule?.workflow !== undefined) {
          const ready = rule.workflowRequiresContentIds?.every((id) => result.contentIds.includes(id)) ?? true;
          return matched && ready && rule.workflow ? [{ contentId, name: rule.name, workflow: rule.workflow, condition: rule.condition, requiresContentIds: rule.workflowRequiresContentIds }] : [];
        }
        return published.filter((match) => match.contentId === contentId);
      });
      const recommendations = recommendationsFor(result.contentIds, workflowMatches);
      const decision: TreatmentDecision = { schemaVersion: "2.1", recommendations: [
        ...recommendations.recommendations.filter((item) => item.kind === "content"),
        ...actionMatches.map((rule) => rule.action),
        ...recommendations.recommendations.filter((item) => item.kind === "workflow"),
      ] };
      return { ...result, portfolio, workflowMatches, actionMatches, recommendations, decision };
    };
    const isBuiltInContext = treatmentContexts.some((entry) => entry.contextId === context);
    const selfServiceProvider = getActiveSelfServicePznProvider();
    const selfServicePub = selfServiceProvider?.getPublishedPublication(context);
    if (selfServicePub && (!isBuiltInContext || selfServicePub.version > 1 || selfServicePub.rules.some((rule) => rule.workflow))) {
      const overrides = {
        ...(this.fundingStatus && { "account.funding_status": this.fundingStatus }),
        ...(overrideCashCents !== undefined && { "portfolio.cash_usd": overrideCashCents / 100 }),
        ...(account && { "customer.beneficiary_status": account.beneficiary === null ? "missing" : "on_file" }),
      };
      const evalResult = selfServiceProvider!.evaluatePublishedForTs(mid, context, overrides);
      if (evalResult) {
        const contentIds = evalResult.eligibleContents.map((c) => c.contentId);
        const beforeRules = [
          ...evalResult.eligibleContents.map((c) => c.contentId),
          ...evalResult.filteredOutContents.map((c) => c.contentId),
        ];
        const ccreResults = [...evalResult.eligibleContents, ...evalResult.filteredOutContents].map((card) => {
          const rules = [...evalResult.contextRuleResults, ...evalResult.ruleResults.filter((r) => card.attachedRuleIds.includes(r.ruleId))];
          const rule = rules.length === 1 ? rules[0] : undefined;
          const clause = rule?.effect === "include_when_true" && rule.clauses.length === 1 ? rule.clauses[0] : undefined;
          const cashAboveCents = clause?.namespaceId === "portfolio" && clause.attributeId === "cash_usd" && clause.operator === "gt" && typeof clause.expectedValue === "number" ? Math.round(clause.expectedValue * 100) : undefined;
          return {
            name: rules.map((r) => r.ruleName).join(", ") || card.reason,
            contentId: card.contentId, outcome: card.eligible ? "matched" as const : "excluded" as const,
            reason: [card.reason, ...rules.flatMap((r) => r.clauses.map((c) => c.reason))].join(" "),
            ...(cashAboveCents !== undefined && { cashAboveCents }),
          };
        });
        // Published eligibility is the outer limit. An attached rule can only narrow that set.
        const overlay = activeRules.filter((rule) => this.ccreRules.some((r) =>
          r.scenarioId === rule.scenarioId && r.contextId === context && r.contentId === rule.contentId));
        const evaluated = await evaluate(contentIds, overlay, evalResult.workflowMatches, evalResult.contextGatePassed);
        return {
          ...evaluated,
          renderedEntries: evalResult.eligibleContents.flatMap((card) => {
            const template = selfServicePub.contents.find((entry) => entry.contentId === card.contentId);
            if (!template || !evaluated.contentIds.includes(card.contentId)) return [];
            const entry = pznTextContentToCatalogEntry({ ...template, headline: card.headline, body: card.renderedBody });
            return [{ ...entry, sourceRef: `${entry.sourceRef}@${context}:v${selfServicePub.version}` }];
          }),
          ccre: { beforeRules, results: [...ccreResults, ...(evaluated.ccre?.results ?? [])] },
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
    return { ...await evaluate(ids, activeRules), renderedEntries: undefined };
  }

  async selectRecommendations(request: TreatmentRequest, signal?: AbortSignal) {
    const selection = await this.selectEligibleContent(request, signal);
    const eligible = new Set(selection.contentIds);
    const recommendations = normalizeRecommendations(selection.decision);
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
