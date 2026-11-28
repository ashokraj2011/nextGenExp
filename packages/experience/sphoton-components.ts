import type { DisplayBlock } from "../contracts/surface";
import { goalProgressSchema, type GoalProgress } from "../contracts/goal-progress";
import { portfolioSnapshotSchema } from "../contracts/portfolio";
import { createSphotonRegistry, type SphotonComponentRegistry } from "../sphoton";

/**
 * CEP-specific A2UI component registrations for sphoton.
 * Keeps packages/sphoton 100% domain-agnostic while giving CEP strict validation
 * and deterministic compilation for Wealth, IT Ops, and Sales RevOps components.
 */
export const cepSphotonRegistry: SphotonComponentRegistry = createSphotonRegistry([
  {
    component: "PznGoalProgress",
    schema: {
      fields: {
        "goal.title": { types: ["string"] },
        "goal.targetCents": { types: ["integer", "number"], required: true },
        "goal.history": { types: ["array"], required: true },
        "goal.monthlyContributionCents": { types: ["integer", "number"] },
        "goal.currency": { types: ["string"] },
        "goal.asOf": { types: ["string"] },
        "goal.goalId": { types: ["string"] },
        "goal.fixtureVersion": { types: ["string"] },
        "goal.targetMonth": { types: ["string"] },
        "goal.projectedTargetMonth": { types: ["string"] },
      },
    },
    compile({ slotData, resolvedRaw, signedActions, baseBlock, design, unavailableBlock }) {
      const firstSlot = Object.values(slotData)[0] as Partial<GoalProgress> | undefined;
      const baseGoal = baseBlock?.component === "PznGoalProgress"
        ? (baseBlock as Extract<DisplayBlock, { component: "PznGoalProgress" }>).props.goal
        : undefined;
      const mergedGoal = {
        ...(baseGoal ?? {}),
        ...(firstSlot ?? {}),
        ...(resolvedRaw["goal.goalId"] !== undefined ? { goalId: resolvedRaw["goal.goalId"] } : {}),
        ...(resolvedRaw["goal.targetCents"] !== undefined ? { targetCents: resolvedRaw["goal.targetCents"] } : {}),
        ...(resolvedRaw["goal.history"] !== undefined ? { history: resolvedRaw["goal.history"] } : {}),
        ...(resolvedRaw["goal.monthlyContributionCents"] !== undefined ? { monthlyContributionCents: resolvedRaw["goal.monthlyContributionCents"] } : {}),
        ...(resolvedRaw["goal.currency"] !== undefined ? { currency: resolvedRaw["goal.currency"] } : {}),
        ...(resolvedRaw["goal.fixtureVersion"] !== undefined ? { fixtureVersion: resolvedRaw["goal.fixtureVersion"] } : {}),
      };
      const parsedGoal = goalProgressSchema.safeParse(mergedGoal);
      if (!parsedGoal.success) {
        return {
          status: "unavailable",
          block: unavailableBlock("Goal progress data is incomplete and cannot be charted."),
          missingRequiredFields: ["goal"],
          reason: "Merged goal payload failed goalProgressSchema validation.",
        };
      }

      const savingsAction = signedActions.find((act) =>
        act.toolRef.startsWith("goal.savings.preview@") && typeof act.resolvedInputs.extraMonthlyCents === "number");
      const extraMonthlyCents = savingsAction ? Number(savingsAction.resolvedInputs.extraMonthlyCents) : undefined;
      const canOfferSavings = Boolean(
        savingsAction
        && extraMonthlyCents
        && parsedGoal.data.monthlyContributionCents !== undefined
        && parsedGoal.data.history.at(-1)!.savedCents < parsedGoal.data.targetCents,
      );

      const goalLabel = design?.title ?? "Home down payment";
      const sharedBase = baseBlock?.component === "PznGoalProgress"
        ? (() => {
          const typed = baseBlock as Extract<DisplayBlock, { component: "PznGoalProgress" }>;
          return {
            variant: typed.props.variant,
            title: typed.props.title,
            sources: typed.props.sources,
            disclosures: typed.props.disclosures,
          };
        })()
        : {
          variant: "expanded" as const,
          title: goalLabel,
          sources: [{ title: goalLabel, label: "sfield · goal.progress.read", version: "1.0.0", ref: "goal.progress.read@1.0.0" }],
          disclosures: ["Goal progress is read from verified account records."],
        };

      return {
        status: "compiled",
        block: {
          component: "PznGoalProgress",
          props: {
            ...sharedBase,
            goal: parsedGoal.data,
            ...(canOfferSavings && savingsAction && extraMonthlyCents
              ? { savingsOption: { actionId: savingsAction.actionRefId, extraMonthlyCents } }
              : {}),
          },
        },
        signedActions: canOfferSavings ? signedActions : [],
      };
    },
    synthesizeFromCatalog(prompt, catalog) {
      const lower = prompt.toLowerCase();
      const goalTool = catalog.tools.find((t) => t.id === "goal.progress.read");
      const goalTarget = catalog.fields.find((f) => f.toolRef === goalTool?.toolRef && f.outputPath === "targetCents");
      const goalHistory = catalog.fields.find((f) => f.toolRef === goalTool?.toolRef && f.outputPath === "history");
      if (!goalTool || !goalTarget || !goalHistory || !/\b(goal|down\s*payment|home|saving|chart|target)\b/i.test(lower)) {
        return null;
      }
      const savingsAction = catalog.actions.find((a) => a.toolRef.startsWith("goal.savings.preview@"));
      return {
        component: "PznGoalProgress",
        sources: { goal: { toolRef: goalTool.toolRef, read: "reuseVerifiedTurnResult" } },
        bindings: [
          { field: "goal.targetCents", from: "goal.data.targetCents", format: "currency_cents", required: true },
          { field: "goal.history", from: "goal.data.history", format: "series", required: true },
        ],
        ...(savingsAction ? {
          actions: [{
            id: "add-monthly-savings",
            label: "Add $500 a month",
            toolRef: savingsAction.toolRef,
            fixedInputs: { extraMonthlyCents: 50_000 },
            followUpInputs: ["startMonth"],
            update: "originalCard",
          }],
        } : {}),
        unavailableState: {
          title: "Home-buying goal unavailable",
          message: "We couldn’t read your current home-buying goal figures right now.",
        },
      };
    },
  },
  {
    component: "PznPortfolioSnapshot",
    schema: {
      fields: {
        "portfolio.totalCents": { types: ["integer", "number"], required: true },
        "portfolio.cashCents": { types: ["integer", "number"] },
        "portfolio.equityCents": { types: ["integer", "number"] },
        "portfolio.asOf": { types: ["string"] },
        "portfolio.currency": { types: ["string"] },
        "portfolio.holdings": { types: ["array"] },
      },
    },
    compile({ slotData, resolvedRaw, baseBlock, unavailableBlock }) {
      const firstSlot = Object.values(slotData)[0] as Record<string, unknown> | undefined;
      const merged = {
        ...(baseBlock?.component === "PznPortfolioSnapshot" ? baseBlock.props : {}),
        ...(firstSlot ?? {}),
        ...(resolvedRaw["portfolio.totalCents"] !== undefined ? { totalCents: resolvedRaw["portfolio.totalCents"] } : {}),
        ...(resolvedRaw["portfolio.cashCents"] !== undefined ? { cashCents: resolvedRaw["portfolio.cashCents"] } : {}),
        ...(resolvedRaw["portfolio.equityCents"] !== undefined ? { equityCents: resolvedRaw["portfolio.equityCents"] } : {}),
      };
      const parsed = portfolioSnapshotSchema.safeParse(merged);
      if (!parsed.success) {
        return {
          status: "unavailable",
          block: unavailableBlock("Portfolio snapshot data is currently unavailable."),
          missingRequiredFields: ["portfolio"],
        };
      }
      return { status: "compiled", block: { component: "PznPortfolioSnapshot", props: parsed.data } };
    },
  },
  {
    component: "PznMetricSummary",
    schema: {
      allowDynamicFields: true,
      fields: {
        "balances.available": { types: ["integer", "number", "string"] },
        "balances.current": { types: ["integer", "number", "string"] },
        "balances.pending": { types: ["integer", "number", "string"] },
      },
    },
  },
  {
    component: "PznBoundWidget",
    schema: {
      allowDynamicFields: true,
      fields: {
        badge: { types: ["string", "number", "integer", "boolean"] },
        title: { types: ["string", "number", "integer", "boolean"] },
        body: { types: ["string", "number", "integer", "boolean"] },
        progress: { types: ["number", "integer"] },
      },
    },
  },
  {
    component: "PznFactSummary",
    schema: {
      allowDynamicFields: true,
      fields: {
        title: { types: ["string"] },
        body: { types: ["string"] },
      },
    },
  },
]);
