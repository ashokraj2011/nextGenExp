import { readRetirementView } from "../../packages/retirement-accounts";
import { retirementBeneficiaryIntent, retirementListIntent } from "../../packages/contracts/retirement-accounts";
import profiles from "../../fixtures/host.json";
import { findProfileById, listAllProfiles } from "../../packages/customer-profiles";
import { resolveMultiDomainBindings } from "../../packages/customer-profiles/bindings";
import { getDomainPack, type DomainPackId } from "../../packages/contracts/domain-packs";
import type { IncidentRecord } from "../../packages/contracts/ops";
import type { DealRecord } from "../../packages/contracts/sales";
import { availableFundingOptions, fundingPreviewFrom } from "../../packages/capabilities";
import { requiredContribution, savingsProjection } from "../../packages/capabilities/calculations";
import type { ComponentKind } from "../../packages/contracts/agentic";
import { canSaveProfileBinding, dataBindingKeySchema } from "../../packages/contracts/data-bindings";
import { synthesizeDynamicCanvas } from "./dynamic-ui-generator";
import type { OpsIncidentStore } from "./ops-store";
import type { SalesDealStore } from "./sales-store";
import { allRoutingIntents, type IntentDefinition } from "../../packages/contracts/routing-intents";
import type { DisplayBlock } from "../../packages/contracts/surface";
import { CEP_CAPABILITIES } from "../../packages/contracts/capabilities-catalog";
import { bindingDomain, layoutTargetDomain, layoutWidgets, widgetSequence, normalizedIntentPhrase, recordIntentOption, recordCapabilities, recordIntentId, recordLayoutCapabilities, recordViews, targetKey, type RecordDomain, type LayoutComponent, type UiDesign, type UiTargetOption } from "../../packages/contracts/ui-layout";
import { conversationalTextAllowed } from "../../packages/experience/chat-policy";
import { contentCatalog, readDemoBalance } from "../../packages/experience/content";
import { findEffectiveContentById, getEffectiveContentEntries } from "../../packages/experience-registry/registry";
import { compileUiLayoutPreview } from "../../packages/experience/ui-layout";
import { fixtureGoalProgressProvider, type GoalProgressProvider } from "../../packages/goal-progress";
import { fixturePortfolioSnapshotProvider, type PortfolioSnapshotProvider } from "../../packages/portfolio-snapshot";
import type { CapabilityRegistry } from "./capability-registry";
import { ApiError } from "./store";

const capabilityBlocks: Record<ComponentKind, LayoutComponent[]> = {
  GoalProgress: ["PznGoalProgress"], Portfolio: ["PznPortfolioSnapshot"], Balances: ["PznMetricSummary"],
  Chart: ["PznSavingsChart"], Metric: ["PznSavingsMetric", "PznFactSummary"], Content: ["PznContentCard"],
  FundingOptions: ["PznFundingOptions"], FundingPreview: ["PznFundingPreview"], Form: ["PznCapabilityForm"], Summary: ["PznFactSummary"],
};

function intentBlocks({ intentId, contextId, task }: IntentDefinition): LayoutComponent[] {
  if (intentId === retirementListIntent) return ["PznRetirementAccounts"];
  if (intentId === retirementBeneficiaryIntent) return ["PznRetirementAccounts", "PznContentCard", "PznStepList"];
  if (task === "create_rule") return ["PznRuleCreation"];
  const components: LayoutComponent[] = ["PznContentCard"];
  if (task === "compare") components.push("PznComparison");
  if (task === "guide") components.push("PznStepList");
  if (task === "show" && contextId === "balance") components.push("PznMetricSummary");
  if (task === "show" && contextId === "portsum") components.push("PznPortfolioSnapshot");
  if (task === "show" && contextId === "goals") components.push("PznGoalProgress");
  return components;
}

export function recordViewOptions(domain: RecordDomain): UiTargetOption[] {
  const subject = domain === "it_ops" ? "Incident" : "Deal";
  return recordViews.map((view) => ({
    target: { kind: "intent", id: recordIntentId(domain, view) },
    label: subject + " " + (view === "detail" ? "details" : view),
    description: view === "list" ? "Choose a record from the displayed results." : "Show the selected record’s " + (view === "timeline" ? "timeline." : "details."),
    components: ["PznDynamicCanvas"],
  }));
}

export function uiTargetOptions(registry: CapabilityRegistry, principalId: string): UiTargetOption[] {
  const latest = new Map(registry.list(principalId).map((manifest) => [manifest.id, manifest]));
  return [
    ...allRoutingIntents().flatMap((intent): UiTargetOption[] => {
      const target = { kind: "intent" as const, id: intent.intentId };
      return layoutTargetDomain(target) === "wealth" ? [{
        target, label: intent.label, description: intent.description, components: intentBlocks(intent),
      }] : [];
    }),
    ...getEffectiveContentEntries().filter(({ publicationStatus }) => publicationStatus === "published")
      .map((entry): UiTargetOption => ({
        target: { kind: "content", id: entry.contentId }, label: entry.title, description: entry.description,
        components: entry.allowedComponents,
      })),
    ...(["it_ops", "sales_revops"] as const).flatMap(recordViewOptions),
    ...recordLayoutCapabilities.map((id): UiTargetOption => {
      const { label, description } = CEP_CAPABILITIES.find((c) => c.id === id)!;
      return { target: { kind: "capability", id }, label, description, components: ["PznDynamicCanvas"] };
    }),
    ...[...latest.values()].map(({ id, title, description, experience }): UiTargetOption => ({ target: { kind: "capability", id }, label: title, description,
      components: [...new Set(experience.allowedComponents.flatMap((component) => capabilityBlocks[component]))] })),
  ];
}

export function slotBindingKeys(slot: UiDesign["slots"][number]) {
  const content = slot.kind === "widget" && slot.nextWidgetId ? { ...slot, ctaPrompt: undefined } : slot;
  const keys = [...JSON.stringify(content).matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)].map((match) => match[1]);
  if (slot.kind === "widget") {
    keys.push(...slot.metrics.flatMap((metric) => metric.binding ? [metric.binding] : []));
    if (slot.progressBinding) keys.push(slot.progressBinding);
  }
  if (slot.kind === "form") keys.push(...slot.fields.flatMap((field) => field.defaultBinding ? [field.defaultBinding] : []));
  return keys;
}

export function validateUiDesign(design: UiDesign, options: UiTargetOption[], publishing: boolean, domain?: DomainPackId) {
  if (design.experience) {
    if (design.recordIntent || design.targets.length || design.slots.length) {
      throw new ApiError(400, "interactive_layout_mixed", "Use a separate design for tool-driven chat actions and layout attachments.");
    }
    return;
  }
  const widgets = layoutWidgets(design.slots);
  for (const widget of widgets.values()) {
    const { issue } = widgetSequence(widget, widgets);
    if (issue === "missing_widget") throw new ApiError(400, "ui_widget_link_invalid", "Link to a widget in this layout.");
    if (issue === "cycle") throw new ApiError(400, "ui_widget_link_invalid", "Widget links must move forward without looping. Chat adds a Back button to each step.");
  }
  const declaration = design.recordIntent;
  if (declaration) {
    const option = recordIntentOption(declaration);
    options = [...options, option];
    const phrases = declaration.phrases.map(normalizedIntentPhrase);
    if (phrases.some((phrase) => !phrase) || new Set(phrases).size !== phrases.length
      || !design.targets.some((target) => targetKey(target) === targetKey(option.target))) {
      throw new ApiError(400, "ui_intent_invalid", "Attach the named intent and enter distinct example phrases.");
    }
  }
  const known = new Set(options.map(({ target }) => targetKey(target)));
  if (design.targets.some((target) => !known.has(targetKey(target)))) {
    throw new ApiError(400, "unknown_ui_attachment", "Choose an intent, capability, or published content item from the list.");
  }
  if (design.slots.some((slot) => slot.kind === "text"
    && !conversationalTextAllowed(slot.heading + ". " + slot.body))) {
    throw new ApiError(400, "invalid_ui_copy", "Use headings and explanatory copy. Add verified components for account figures, recommendations, or results.");
  }
  if (domain) {
    const targets = design.targets.map((target) => options.find((option) => targetKey(option.target) === targetKey(target))!);
    if (targets.some(({ target }) => layoutTargetDomain(target) !== domain)) throw new ApiError(400, "domain_attachment_invalid", "Choose a target in this domain.");
    for (const slot of design.slots) {
      if (slot.kind === "block") {
        const incompatible = targets.find((target) => target.components && !target.components.includes(slot.component));
        if (incompatible) throw new ApiError(400, "ui_component_unavailable", `${incompatible.label} cannot supply ${slot.component}. Choose a supported block or change the attachment.`);
      }
      if (slot.kind === "form" && slot.writeBack !== false) {
        const field = slot.fields.find(({ defaultBinding }) => defaultBinding && !canSaveProfileBinding(defaultBinding));
        if (field) throw new ApiError(400, "ui_field_read_only", `${field.defaultBinding} is read-only. Disable saving bound fields or choose a writable field.`);
      }
      for (const key of slotBindingKeys(slot)) {
        if (!dataBindingKeySchema.safeParse(key).success) {
          throw new ApiError(400, "ui_binding_unavailable", `The data dictionary has no field called ${key}. Choose an available field.`);
        }
        const sourceDomain = bindingDomain(key);
        if (sourceDomain !== domain) {
          throw new ApiError(400, "ui_binding_unavailable", `${key} belongs to ${getDomainPack(sourceDomain).shortLabel}. Choose that workspace in Design domain.`);
        }
        if (domain !== "wealth" && targets.some(({ target }) => target.id === recordIntentId(domain, "list") || (target.id === declaration?.id && declaration.view === "list"))) {
          throw new ApiError(400, "ui_binding_unavailable", `The list view cannot supply ${key} for a single record. Attach a detail or timeline view.`);
        }
      }
    }
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

function sampleDetails(item: string | ReturnType<typeof content>) {
  if (typeof item === "string") item = content(item);
  const { title, body, description, steps, sourceLabel, version, sourceRef } = item;
  const shared = {
    variant: "expanded" as const,
    title,
    sources: [{ title, label: sourceLabel, version, ref: sourceRef }],
    disclosures: item.requiredDisclosures.map(({ text }) => text),
  };
  return { shared, body, description, steps };
}

export async function previewUiLayout(
  design: UiDesign,
  requestedPersonaId?: string,
  extraContext?: { domainId?: DomainPackId; incident?: IncidentRecord; deal?: DealRecord; opsStore?: OpsIncidentStore; salesStore?: SalesDealStore;
    portfolioProvider?: PortfolioSnapshotProvider; goalProvider?: GoalProgressProvider },
) {
  if (extraContext?.domainId && extraContext.domainId !== "wealth") {
    const domain = extraContext.domainId;
    const list = design.recordIntent?.view === "list" || design.targets.some(({ id }) => id === recordIntentId(domain, "list"));
    const timeline = design.recordIntent?.view === "timeline" || design.targets.some(({ id }) => id === recordIntentId(domain, "timeline"));
    const record = extraContext.incident ?? extraContext.deal;
    const prompt = list ? "Show records" : (timeline ? "Show timeline for " : "Show ") + (record?.id ?? "");
    const { canvas } = synthesizeDynamicCanvas(prompt, undefined, extraContext.opsStore, extraContext.salesStore, recordCapabilities[domain]);
    return compileUiLayoutPreview(design, [{ component: "PznDynamicCanvas", props: canvas }], list ? undefined : resolveMultiDomainBindings(undefined, extraContext));
  }
  const activeProfile = requestedPersonaId ? findProfileById(requestedPersonaId) : listAllProfiles()[0];
  if (!activeProfile) throw new ApiError(404, "preview_profile_unavailable", "Choose an available customer to preview this layout.");
  const { personaId, syntheticMid } = activeProfile;
  const targetContent = design.targets.find(({ kind }) => kind === "content");
  const selectedContent = targetContent ? findEffectiveContentById(targetContent.id) : undefined;
  const sampleFor = (component: LayoutComponent, fallback: string) => sampleDetails(
    selectedContent?.allowedComponents.some((allowed) => allowed === component) ? selectedContent : fallback,
  );
  const fields = design.slots.flatMap(slotBindingKeys);
  const blocks = design.slots.flatMap((slot) => slot.kind === "block" ? [slot.component] : []);
  const needsGoal = fields.some((key) => key.startsWith("goal.")) || blocks.some((b) => ["PznGoalProgress", "PznSavingsChart", "PznSavingsMetric"].includes(b));
  const needsPortfolio = fields.some((key) => key.startsWith("portfolio.")) || blocks.some((b) => ["PznPortfolioSnapshot", "PznSavingsChart", "PznCapabilityForm"].includes(b));
  const [goal, portfolio] = await Promise.all([
    needsGoal ? (extraContext?.goalProvider ?? fixtureGoalProgressProvider).read(syntheticMid) : undefined,
    needsPortfolio ? (extraContext?.portfolioProvider ?? fixturePortfolioSnapshotProvider).read(syntheticMid) : undefined,
  ]);
  if ((needsGoal && !goal) || (needsPortfolio && !portfolio)) {
    throw new ApiError(422, "preview_data_unavailable", "The selected customer has no reading for the requested layout.");
  }
  const funding = availableFundingOptions(true, 50_000);
  const balance = readDemoBalance(personaId, syntheticMid, portfolio ? Date.parse(portfolio.asOf) : Date.now());
  const bindings = resolveMultiDomainBindings(personaId, { goal: goal ?? undefined, portfolio: portfolio ?? undefined, balances: balance.values });
  const education = sampleFor("PznContentCard", "balance_education");
  const address = sampleFor("PznStepList", "address_update_guide");
  const pair = selectedContent?.comparisonGroup && getEffectiveContentEntries().find((entry) =>
    entry.publicationStatus === "published" && entry.contentId !== selectedContent.contentId
    && entry.allowedComponents.includes("PznComparison") && entry.comparisonGroup === selectedContent.comparisonGroup);
  const definitions = selectedContent && pair ? [selectedContent, pair] : ["balance_available_definition", "balance_current_definition"].map(content);
  const retirementIntent = design.targets.some(({ id }) => id === retirementBeneficiaryIntent) ? retirementBeneficiaryIntent : retirementListIntent;
  const accounts = readRetirementView(syntheticMid, retirementListIntent, "");
  const samples: Partial<Record<LayoutComponent, DisplayBlock>> = {
    PznRetirementAccounts: { component: "PznRetirementAccounts", props: retirementIntent === retirementListIntent ? accounts
      : readRetirementView(syntheticMid, retirementIntent, "the first one", accounts) },
    PznComparison: { component: "PznComparison", props: {
      ...sampleDetails(definitions[0]).shared, title: "Compare balance definitions",
      columns: definitions.map(({ title, comparisonFields }) => ({ title, fields: comparisonFields })),
    } },
    PznMetricSummary: { component: "PznMetricSummary", props: {
      ...sampleFor("PznMetricSummary", "balance_metric_template").shared, observedAt: balance.observedAt, values: balance.values,
    } },
    ...(portfolio && { PznPortfolioSnapshot: { component: "PznPortfolioSnapshot", props: portfolio } } as const),
    ...(goal && { PznGoalProgress: { component: "PznGoalProgress", props: { ...sampleFor("PznGoalProgress", "home_down_payment_progress").shared, goal } } } as const),
    ...(goal && portfolio && { PznSavingsChart: { component: "PznSavingsChart", props: savingsProjection(goal, 24, 100_000, {
      transferFromCashCents: Math.min(1_000_000, portfolio.cashCents),
      portfolioCashBeforeCents: portfolio.cashCents,
      // The chat run supplies eligibility after Treatment Selector evaluates the projected balance.
    }) } } as const),
    ...(goal && { PznSavingsMetric: { component: "PznSavingsMetric", props: requiredContribution(goal, 24) } } as const),
    PznContentCard: { component: "PznContentCard", props: { ...education.shared, body: education.body, description: education.description } },
    PznStepList: { component: "PznStepList", props: { ...address.shared, body: address.body, steps: address.steps } },
    PznFundingOptions: { component: "PznFundingOptions", props: funding },
    PznFundingPreview: { component: "PznFundingPreview", props: fundingPreviewFrom(funding, "bank_transfer", 50_000) },
    PznCapabilityForm: { component: "PznCapabilityForm", props: {
      title: "Monthly savings planner", submitLabel: "Recalculate", actionId: "preview_only",
      fields: [
        { field: { id: "monthlyCents", label: "Monthly contribution", type: "integer", min: 0, max: 500_000, required: true, unit: "cents", presentation: "slider" }, value: 100_000 },
        { field: { id: "transferFromCashCents", label: "Move from portfolio cash today", type: "integer", min: 0, max: Math.max(100_000, Math.floor((portfolio?.cashCents ?? 0) / 100) * 100), required: false, unit: "cents", presentation: "slider" }, value: Math.min(1_000_000, Math.floor((portfolio?.cashCents ?? 0) / 100) * 100) },
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
    design.slots.flatMap((slot) => {
      if (slot.kind !== "block") return [];
      const sample = samples[slot.component];
      if (!sample) throw new ApiError(422, "preview_data_unavailable", `This customer has no data for ${slot.component}.`);
      return [sample];
    }),
    bindings,
  );
}
