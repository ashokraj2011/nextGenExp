import profiles from "../../fixtures/host.json";
import { findProfileById, listAllProfiles } from "../../packages/customer-profiles";
import { resolveCustomerBindings } from "../../packages/customer-profiles/bindings";
import { availableFundingOptions, fundingPreviewFrom } from "../../packages/capabilities";
import { requiredContribution, savingsProjection } from "../../packages/capabilities/calculations";
import { allRoutingIntents } from "../../packages/contracts/routing-intents";
import type { DisplayBlock } from "../../packages/contracts/surface";
import { targetKey, type LayoutComponent, type UiDesign, type UiTargetOption } from "../../packages/contracts/ui-layout";
import { conversationalTextAllowed } from "../../packages/experience/chat-policy";
import { contentCatalog, readDemoBalance } from "../../packages/experience/content";
import { findEffectiveContentById } from "../../packages/experience-registry/registry";
import { compileUiLayoutPreview } from "../../packages/experience/ui-layout";
import { fixtureGoalProgressProvider } from "../../packages/goal-progress";
import { fixturePortfolioSnapshotProvider } from "../../packages/portfolio-snapshot";
import type { CapabilityRegistry } from "./capability-registry";
import { ApiError } from "./store";

export function uiTargetOptions(registry: CapabilityRegistry, principalId: string): UiTargetOption[] {
  const latest = new Map(registry.list(principalId).map((manifest) => [manifest.id, manifest]));
  return [
    ...allRoutingIntents().map(({ intentId, label, description }): UiTargetOption => ({ target: { kind: "intent", id: intentId }, label, description })),
    ...[...latest.values()].map(({ id, title, description }): UiTargetOption => ({ target: { kind: "capability", id }, label: title, description })),
  ];
}

export function validateUiDesign(design: UiDesign, options: UiTargetOption[], publishing: boolean) {
  const known = new Set(options.map(({ target }) => targetKey(target)));
  if (design.targets.some((target) => !known.has(targetKey(target)))) {
    throw new ApiError(400, "unknown_ui_attachment", "Choose an intent or capability from the list.");
  }
  if (design.slots.some((slot) => slot.kind === "text"
    && !conversationalTextAllowed(slot.heading + ". " + slot.body))) {
    throw new ApiError(400, "invalid_ui_copy", "Use headings and explanatory copy. Add verified components for account figures, recommendations, or results.");
  }
  if (!publishing) return;
  if (!design.description || !design.targets.length || !design.slots.some(({ kind }) => kind === "block" || kind === "form" || kind === "widget")) {
    throw new ApiError(400, "ui_layout_incomplete", "Add a description, an attachment, and at least one component, form, or widget before publishing.");
  }
  if (design.slots.some((slot) => slot.kind === "text" && !slot.heading && !slot.body)) {
    throw new ApiError(400, "ui_layout_incomplete", "Fill in or remove any empty text sections.");
  }
  if (design.slots.some((slot) => slot.kind === "form" && (!slot.title.trim() || slot.fields.length === 0))) {
    throw new ApiError(400, "ui_layout_incomplete", "Give each interactive form a title and at least one field before publishing.");
  }
  if (design.slots.some((slot) => slot.kind === "widget" && !slot.title.trim())) {
    throw new ApiError(400, "ui_layout_incomplete", "Give each data-bound widget a title before publishing.");
  }
}

function content(id: string) {
  const live = findEffectiveContentById(id);
  const published = (live && live.publicationStatus === "published")
    ? live
    : contentCatalog.entries.find((entry) => entry.contentId === id && entry.publicationStatus === "published");
  if (!published) throw new Error("UI preview content is missing.");
  return published;
}

function sampleDetails(id: string) {
  const item = content(id);
  const { title, body, description, steps, sourceLabel, version, sourceRef } = item;
  const shared = {
    variant: "expanded" as const,
    title,
    sources: [{ title, label: sourceLabel, version, ref: sourceRef }],
    disclosures: item.requiredDisclosures.map(({ text }) => text),
  };
  return { shared, body, description, steps };
}

export async function previewUiLayout(design: UiDesign, requestedPersonaId?: string) {
  const activeProfile = (requestedPersonaId ? findProfileById(requestedPersonaId) : undefined)
    ?? listAllProfiles()[0]
    ?? profiles.personas[0];
  const { personaId, syntheticMid } = activeProfile;
  const fallbackMid = profiles.personas[0].syntheticMid;
  const [goalRaw, portfolioRaw] = await Promise.all([
    fixtureGoalProgressProvider.read(syntheticMid),
    fixturePortfolioSnapshotProvider.read(syntheticMid),
  ]);
  const goal = goalRaw ?? await fixtureGoalProgressProvider.read(fallbackMid);
  const portfolio = portfolioRaw ?? await fixturePortfolioSnapshotProvider.read(fallbackMid);
  if (!goal || !portfolio) throw new Error("UI preview data is missing.");
  const bindings = resolveCustomerBindings(personaId);
  const funding = availableFundingOptions(true, 50_000);
  const balance = readDemoBalance(personaId, syntheticMid, Date.parse(portfolio.asOf));
  const education = sampleDetails("balance_education");
  const address = sampleDetails("address_update_guide");
  const definitions = ["balance_available_definition", "balance_current_definition"].map(content);
  const samples: Record<LayoutComponent, DisplayBlock> = {
    PznComparison: { component: "PznComparison", props: {
      ...sampleDetails("balance_available_definition").shared, title: "Compare balance definitions",
      columns: definitions.map(({ title, comparisonFields }) => ({ title, fields: comparisonFields })),
    } },
    PznMetricSummary: { component: "PznMetricSummary", props: {
      ...sampleDetails("balance_metric_template").shared, observedAt: balance.observedAt, values: balance.values,
    } },
    PznPortfolioSnapshot: { component: "PznPortfolioSnapshot", props: portfolio },
    PznGoalProgress: { component: "PznGoalProgress", props: { ...sampleDetails("home_down_payment_progress").shared, goal } },
    PznSavingsChart: { component: "PznSavingsChart", props: savingsProjection(goal, 24, 100_000) },
    PznSavingsMetric: { component: "PznSavingsMetric", props: requiredContribution(goal, 24) },
    PznContentCard: { component: "PznContentCard", props: { ...education.shared, body: education.body, description: education.description } },
    PznStepList: { component: "PznStepList", props: { ...address.shared, body: address.body, steps: address.steps } },
    PznFundingOptions: { component: "PznFundingOptions", props: funding },
    PznFundingPreview: { component: "PznFundingPreview", props: fundingPreviewFrom(funding, "bank_transfer", 50_000) },
    PznCapabilityForm: { component: "PznCapabilityForm", props: {
      title: "Monthly savings planner", submitLabel: "Recalculate", actionId: "preview_only",
      fields: [
        { field: { id: "monthlyCents", label: "Monthly contribution", type: "integer", min: 0, max: 500_000, required: true, unit: "cents", presentation: "slider" }, value: 100_000 },
        { field: { id: "months", label: "Months until purchase", type: "integer", min: 1, max: 120, required: true, unit: "months" }, value: 24 },
      ],
    } },
    PznFactSummary: { component: "PznFactSummary", props: {
      title: "Step status", body: "Review the steps in this request.", facts: [{ label: "Address change", value: "Prepared for review" }],
    } },
    PznRuleCreation: { component: "PznRuleCreation", props: { scenarioId: profiles.defaultScenarioId, personaId } },
  };
  return compileUiLayoutPreview(
    design,
    design.slots.flatMap((slot) => slot.kind === "block" ? [samples[slot.component]] : []),
    bindings,
  );
}
