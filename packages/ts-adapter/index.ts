import type { RuleWorkflowMatch } from "../contracts/customer-workflows";
import { z } from "zod";
import { contextCatalogSchema, type ContextCatalog, type PropensityResult } from "../contracts/domain";
import { actionRecommendationSchema, type TreatmentDecision, type TreatmentRecommendations, type WorkflowCandidate } from "../contracts/funding-workflow";
import { portfolioSnapshotSchema } from "../contracts/portfolio";
import { effectiveCcreRules, mockCcreConditionSchema, mockCcreRuleSchema, normalizedIdsSchema, treatmentOverride, type MockCcreRule, type TreatmentOverride } from "../contracts/tool-setup";
import { pendingActionsContext, type FirstDepositConfirmation } from "../contracts/workspace";
import { formatGlossaryCondition } from "../contracts/rule-glossary";
import type { MockCcreEvaluation } from "../contracts/tool-setup";
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
export type FundingFact = "funded" | "unfunded" | FirstDepositConfirmation;
export type TreatmentRequest = { mid: string; context: string; accountId?: string; overrideCashCents?: number };
export type ContextScoresRequest = { mid: string; contextIds: string[] };

export interface TreatmentSelectionResult {
  contentIds: string[];
  ccre?: MockCcreEvaluation;
  portfolio: z.infer<typeof portfolioSnapshotSchema> | null;
  workflowMatches: RuleWorkflowMatch[];
  actionMatches: typeof tsFixtures.actionRules;
  recommendations: TreatmentRecommendations;
  decision: TreatmentDecision;
  renderedEntries?: ReturnType<typeof pznTextContentToCatalogEntry>[];
}
export interface TreatmentRecommendationsResult extends TreatmentSelectionResult {
  response: TreatmentV3;
}

export interface TsAdapter {
  listContexts(signal?: AbortSignal): Promise<ContextCatalog>;
  getContextScores(request: ContextScoresRequest, signal?: AbortSignal): Promise<PropensityResult>;
  getRankedEligibleIds(request: TreatmentRequest, signal?: AbortSignal): Promise<string[]>;
  selectEligibleContent(request: TreatmentRequest, signal?: AbortSignal): Promise<TreatmentSelectionResult>;
  selectRecommendations(request: TreatmentRequest, signal?: AbortSignal): Promise<TreatmentRecommendationsResult>;
}

export type TsAdapterContext = {
  state: FixtureState;
  overrides?: readonly TreatmentOverride[];
  ccreRules?: readonly MockCcreRule[];
  portfolios?: PortfolioSnapshotProvider;
  funding?: FundingFact;
};

/**
 * Shared factory seam for Treatment Selector (categorized as a recommendation_provider tool).
 * Chat, Agentic Execution, Pending Actions, and Admin Tool Setup preview all resolve through
 * the single injected factory so customers receive a consistent decision across every surface.
 */
export type TsAdapterFactory = (ctx: TsAdapterContext) => TsAdapter;

export function createFixtureTsAdapterFactory(): TsAdapterFactory {
  return ({ state, overrides = [], ccreRules = [], portfolios = fixturePortfolioSnapshotProvider, funding }) =>
    new FixtureTsAdapter(state, overrides, ccreRules, portfolios, funding);
}

export interface RemoteTsAdapterOptions {
  /** Base URL of the external Treatment Selector HTTP service (e.g. https://ts.internal/v1). */
  endpoint: string;
  /** Optional static headers (e.g. Authorization: Bearer ...). */
  headers?: Record<string, string>;
  /** Per-request timeout in ms (default 5000). */
  timeoutMs?: number;
  /** Optional custom fetch implementation (for testing or mTLS dispatchers). */
  fetchFn?: typeof fetch;
}

/**
 * HTTP-backed Treatment Selector adapter implementing the full TsAdapter contract.
 * Connects Chat, Agentic Execution, Pending Actions, and Tool Setup preview to a real TS endpoint.
 */
export class RemoteTsAdapter implements TsAdapter {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly ctx: TsAdapterContext;

  constructor(options: RemoteTsAdapterOptions, ctx: TsAdapterContext) {
    this.baseUrl = options.endpoint.replace(/\/+$/, "");
    this.headers = { "Content-Type": "application/json", ...options.headers };
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.ctx = ctx;
  }

  private async requestJson<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const combinedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.headers, ...(init.headers as Record<string, string> | undefined) },
        signal: combinedSignal,
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new TreatmentSelectorTimeout();
      }
      throw err;
    }
    if (!response.ok) {
      if (response.status === 504 || response.status === 408) throw new TreatmentSelectorTimeout();
      throw new Error(`REMOTE_TS_HTTP_${response.status}`);
    }
    return await response.json() as T;
  }

  async listContexts(signal?: AbortSignal): Promise<ContextCatalog> {
    return this.requestJson<ContextCatalog>("/contexts", { method: "GET" }, signal);
  }

  async getContextScores(request: ContextScoresRequest, signal?: AbortSignal): Promise<PropensityResult> {
    return this.requestJson<PropensityResult>("/scores", {
      method: "POST",
      body: JSON.stringify({ ...request, scenarioId: this.ctx.state.scenarioId }),
    }, signal);
  }

  async getRankedEligibleIds(request: TreatmentRequest, signal?: AbortSignal): Promise<string[]> {
    return (await this.selectEligibleContent(request, signal)).contentIds;
  }

  async selectEligibleContent(request: TreatmentRequest, signal?: AbortSignal): Promise<TreatmentSelectionResult> {
    const fundingStatus = typeof this.ctx.funding === "object" ? "funded" : this.ctx.funding;
    const raw = await this.requestJson<Partial<TreatmentSelectionResult> & { contentIds: string[] }>("/select", {
      method: "POST",
      body: JSON.stringify({
        ...request,
        scenarioId: this.ctx.state.scenarioId,
        ordinal: this.ctx.state.ordinal,
        ...(fundingStatus ? { fundingStatus } : {}),
      }),
    }, signal);
    const contentIds = Array.isArray(raw.contentIds) ? raw.contentIds : [];
    const recommendations: TreatmentRecommendations = raw.recommendations ?? {
      schemaVersion: "2.0",
      recommendations: contentIds.map((id) => ({ kind: "content" as const, id })),
    };
    const decision: TreatmentDecision = raw.decision ?? {
      schemaVersion: "2.1",
      recommendations: recommendations.recommendations,
    };
    return {
      contentIds,
      ccre: raw.ccre,
      portfolio: raw.portfolio ?? null,
      workflowMatches: raw.workflowMatches ?? [],
      actionMatches: raw.actionMatches ?? [],
      recommendations,
      decision,
      renderedEntries: raw.renderedEntries,
    };
  }

  async selectRecommendations(request: TreatmentRequest, signal?: AbortSignal): Promise<TreatmentRecommendationsResult> {
    const selection = await this.selectEligibleContent(request, signal);
    const recommendations = normalizeRecommendations(selection.decision);
    const response: TreatmentV3 = { schemaVersion: "3.0", recommendations };
    return { ...selection, response };
  }
}

export function createRemoteTsAdapterFactory(options: RemoteTsAdapterOptions): TsAdapterFactory {
  return (ctx) => new RemoteTsAdapter(options, ctx);
}

/**
 * Returns the default shared TsAdapterFactory:
 * - If `PZN_TS_ENDPOINT` is configured, connects all callers to the real HTTP TS service.
 * - Otherwise, uses the local FixtureTsAdapter mock.
 */
export function createDefaultTsAdapterFactory(env: NodeJS.ProcessEnv = process.env): TsAdapterFactory {
  const endpoint = env.PZN_TS_ENDPOINT?.trim();
  if (endpoint) {
    const apiKey = env.PZN_TS_API_KEY?.trim();
    return createRemoteTsAdapterFactory({
      endpoint,
      ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
    });
  }
  return createFixtureTsAdapterFactory();
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
  private readonly fundingStatus?: "funded" | "unfunded";
  private readonly confirmation?: FirstDepositConfirmation;
  constructor(
    private readonly state: FixtureState,
    private readonly overrides: readonly TreatmentOverride[] = [],
    private readonly ccreRules: readonly MockCcreRule[] = [],
    private readonly portfolios: PortfolioSnapshotProvider = fixturePortfolioSnapshotProvider,
    funding?: FundingFact,
  ) {
    if (typeof funding === "object") {
      this.confirmation = funding;
      this.fundingStatus = "funded";
    } else this.fundingStatus = funding;
  }

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
    const confirmation = this.confirmation;
    if (confirmation && confirmation.mid !== mid) throw new Error("FUNDING_MEMBER_MISMATCH");
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
      const fundingRule = rules.find((rule) => rule.contentId === "fund_account");
      const condition = fundingRule?.condition;
      const evaluatedFunding = result.ccre?.results.find((rule) => rule.contentId === "fund_account" && rule.outcome !== "outside_list");
      if (confirmation && result.ccre && evaluatedFunding && condition?.kind === "attribute"
        && condition.namespaceId === "account" && condition.attributeId === "funding_status") {
        result.ccre.fundingCheck = { confirmation, rule: evaluatedFunding.name, condition: formatGlossaryCondition(condition),
          actual: input.fundingStatus!, eligible: evaluatedFunding.outcome === "matched" };
      }
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
        let publishedFundingCheck: MockCcreEvaluation["fundingCheck"];
        const ccreResults = [...evalResult.eligibleContents, ...evalResult.filteredOutContents].map((card) => {
          const rules = [...evalResult.contextRuleResults, ...evalResult.ruleResults.filter((r) => card.attachedRuleIds.includes(r.ruleId))];
          if (confirmation && card.contentId === "fund_account") {
            for (const rule of rules) {
              const check = rule.clauses.find((c) => c.namespaceId === "account" && c.attributeId === "funding_status");
              if (check) {
                publishedFundingCheck = { confirmation, rule: rule.ruleName, condition: check.reason,
                  actual: String(check.actualValue), eligible: card.eligible };
                if (!rule.effectiveAllow) break;
              }
            }
          }
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
          ccre: { beforeRules, results: [...ccreResults, ...(evaluated.ccre?.results ?? [])],
            fundingCheck: evaluated.ccre?.fundingCheck ?? publishedFundingCheck },
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
