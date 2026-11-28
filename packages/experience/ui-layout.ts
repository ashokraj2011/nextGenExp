import { interpolateBindingTokens, type DataBindingValues } from "../contracts/data-bindings";
import type { DisplayBlock, DisplayExperience } from "../contracts/surface";
import { formatPortfolioAmount } from "../contracts/portfolio";
import {
  layoutWidgets, targetKey, widgetSequence,
  type AppliedUiLayout, type ResolvedBoundWidgetProps, type UiDesign, type UiPublication, type UiTarget, type WidgetSlot,
} from "../contracts/ui-layout";
import { buildSurface, makeId, type CompiledExperience, type IssuedAction } from "./compile";

type SlotBlock = { block: DisplayBlock; index?: number; extraMonthlyCents?: number; actionLabel?: string };

function resolveToolBindingExtraMonthlyCents(slot: UiDesign["slots"][number]): { extraMonthlyCents?: number; label?: string } {
  if (slot.kind !== "block") return {};
  if (slot.extraMonthlyCents !== undefined) return { extraMonthlyCents: slot.extraMonthlyCents };
  const savingsAction = slot.toolBinding?.actions?.find((action) =>
    action.toolRef.startsWith("goal.savings.preview@") && typeof action.fixedInputs?.extraMonthlyCents === "number");
  if (!savingsAction) return {};
  return {
    extraMonthlyCents: Number(savingsAction.fixedInputs?.extraMonthlyCents),
    label: savingsAction.label,
  };
}

function resolveWidget(slot: WidgetSlot, bindings?: DataBindingValues, linking = false): ResolvedBoundWidgetProps {
  const progressEntry = slot.progressBinding ? bindings?.[slot.progressBinding] : undefined;
  return {
    badge: interpolateBindingTokens(slot.badge, bindings),
    title: interpolateBindingTokens(slot.title || "Live customer widget", bindings),
    body: interpolateBindingTokens(slot.body, bindings),
    accentTop: slot.accentTop,
    ...(bindings?.["customer.displayName"] ? { hydratedFor: bindings["customer.displayName"].display } : {}),
    metrics: slot.metrics.map((metric) => {
      const resolved = metric.binding ? bindings?.[metric.binding] : undefined;
      return {
        id: metric.id,
        label: metric.label,
        value: resolved ? resolved.display : (metric.staticValue || "—"),
        subtext: interpolateBindingTokens(metric.subtext, bindings),
        tone: metric.tone,
        ...(metric.binding ? { boundKey: metric.binding } : {}),
      };
    }),
    ...(slot.progressLabel ? { progressLabel: interpolateBindingTokens(slot.progressLabel, bindings) } : {}),
    ...(progressEntry?.percent !== undefined ? { progressPercent: progressEntry.percent, progressDisplay: progressEntry.display } : {}),
    ...(slot.ctaLabel ? { ctaLabel: slot.ctaLabel } : {}),
    ...(!linking && slot.ctaPrompt ? { ctaPrompt: interpolateBindingTokens(slot.ctaPrompt, bindings) } : {}),
  };
}

function arrange(
  design: UiDesign,
  original: DisplayBlock[],
  bindings?: DataBindingValues,
  precompiledToolBlocks?: DisplayBlock[],
) {
  const positions = new Set<number>();
  const mapped: SlotBlock[] = [];
  let toolBlockCursor = 0;
  const widgets = layoutWidgets(design.slots);
  const destinationIds = new Set([...widgets.values()].map(({ nextWidgetId }) => nextWidgetId));
  const wizards = new Map<string, WidgetSlot[]>();
  const laterStepIds = new Set<string>();
  for (const widget of widgets.values()) {
    if (!widget.nextWidgetId || destinationIds.has(widget.id)) continue;
    const { steps, issue } = widgetSequence(widget, widgets);
    if (issue) continue;
    wizards.set(widget.id, steps);
    for (const step of steps.slice(1)) laterStepIds.add(step.id);
  }
  for (const slot of design.slots) {
    if (slot.kind === "text") {
      if (slot.heading || slot.body) {
        mapped.push({
          block: {
            component: "PznLayoutText",
            props: {
              heading: interpolateBindingTokens(slot.heading, bindings),
              body: interpolateBindingTokens(slot.body, bindings),
              tone: slot.tone,
            },
          },
        });
      }
      continue;
    }
    if (slot.kind === "form") {
      if (slot.title || slot.fields.length > 0) {
        mapped.push({
          block: {
            component: "PznCustomForm",
            props: {
              title: interpolateBindingTokens(slot.title || "Customer form", bindings),
              description: interpolateBindingTokens(slot.description, bindings),
              submitLabel: slot.submitLabel || "Submit",
              ...(slot.writeBack !== undefined ? { writeBack: slot.writeBack } : {}),
              fields: slot.fields.map((field) => ({
                ...field,
                ...(field.defaultBinding && bindings?.[field.defaultBinding]
                  ? { initialValue: bindings[field.defaultBinding].rawInput }
                  : {}),
              })),
            },
          },
        });
      }
      continue;
    }
    if (slot.kind === "widget") {
      if (laterStepIds.has(slot.id)) continue;
      if (slot.toolBinding && precompiledToolBlocks && precompiledToolBlocks[toolBlockCursor]) {
        mapped.push({ block: precompiledToolBlocks[toolBlockCursor++] });
        continue;
      }
      const steps = wizards.get(slot.id);
      const block: DisplayBlock = steps
        ? { component: "PznWidgetWizard", props: {
          wizardId: slot.id,
          steps: steps.map((step, index) => resolveWidget(step, bindings, index < steps.length - 1)),
        } }
        : { component: "PznBoundWidget", props: resolveWidget(slot, bindings) };
      mapped.push({ block });
      continue;
    }
    if (slot.toolBinding && precompiledToolBlocks && precompiledToolBlocks[toolBlockCursor]) {
      const savings = resolveToolBindingExtraMonthlyCents(slot);
      mapped.push({
        block: precompiledToolBlocks[toolBlockCursor++],
        extraMonthlyCents: savings.extraMonthlyCents,
        actionLabel: savings.label,
      });
      continue;
    }
    const index = original.findIndex((block, i) => block.component === slot.component && !positions.has(i));
    if (index >= 0) {
      const savings = resolveToolBindingExtraMonthlyCents(slot);
      mapped.push({ block: original[index], index, extraMonthlyCents: savings.extraMonthlyCents, actionLabel: savings.label });
      positions.add(index);
    }
  }
  return { mapped, positions };
}

function issueSavingsOptions(mapped: SlotBlock[], preview = false) {
  const issued: IssuedAction[] = [];
  const blocks = mapped.map(({ block, extraMonthlyCents, actionLabel }, index): DisplayBlock => {
    if (block.component !== "PznGoalProgress" || !extraMonthlyCents) return block;
    const { goal } = block.props;
    if (goal.monthlyContributionCents === undefined || goal.history.at(-1)!.savedCents >= goal.targetCents) return block;
    const actionId = preview ? "preview_only" : makeId("action");
    const amount = formatPortfolioAmount(extraMonthlyCents);
    if (!preview) {
      issued.push({
        actionId, componentId: "block_" + (index + 1), followUpId: "goal_savings_scenario",
        label: actionLabel ?? ("Add " + amount + " a month"), userMessage: "What if I add " + amount + " a month?",
        inline: true, goalScenario: true,
      });
    }
    return { ...block, props: { ...block.props, savingsOption: { actionId, extraMonthlyCents } } };
  });
  return { blocks, issued };
}

function fields(display: DisplayExperience, layout: UiDesign["layout"]) {
  const { status, outcome, intro, question, partial, expiresAt } = display;
  return { status, outcome, intro, question, partial, expiresAt, layout, theme: "evergreen" as const };
}

function collectToolRefs(design: UiDesign): Record<string, string> | undefined {
  const refs: Record<string, string> = {};
  for (const slot of design.slots) {
    if ((slot.kind === "block" || slot.kind === "widget") && slot.toolBinding) {
      for (const source of Object.values(slot.toolBinding.sources)) {
        const [, version = "1.0.0"] = source.toolRef.split("@");
        refs[source.toolRef] = version;
      }
      for (const action of slot.toolBinding.actions ?? []) {
        const [, version = "1.0.0"] = action.toolRef.split("@");
        refs[action.toolRef] = version;
      }
    }
  }
  return Object.keys(refs).length > 0 ? refs : undefined;
}

export function applyPublishedUi(
  result: CompiledExperience,
  publications: UiPublication[],
  targets: UiTarget[],
  bindings?: DataBindingValues,
  toolContractsByPublication?: ReadonlyMap<string, Record<string, string>>,
) {
  const { display, issued } = result;
  if (!display.blocks.length) return;
  for (const target of targets) {
    const publication = publications.find(({ design }) => design.targets.some((item) => targetKey(item) === targetKey(target)));
    if (!publication) continue;
    const { design, id, revision } = publication;
    const { mapped, positions } = arrange(design, display.blocks, bindings);
    const hasCustomBlock = mapped.some((entry) => entry.block.component === "PznCustomForm" || entry.block.component === "PznBoundWidget"
      || entry.block.component === "PznWidgetWizard");
    if (!positions.size && !hasCustomBlock) continue;
    for (const [index, block] of display.blocks.entries()) {
      if (!positions.has(index)) mapped.push({ block, index });
    }
    const componentIds = new Map(mapped.flatMap(({ index }, next) => (
      index === undefined ? [] : [["block_" + (index + 1), "block_" + (next + 1)] as const]
    )));
    const adjusted = issued.map((action) => ({ ...action, componentId: componentIds.get(action.componentId) ?? action.componentId }));
    const savings = issueSavingsOptions(mapped);
    const toolContracts = toolContractsByPublication?.get(id) ?? collectToolRefs(design);
    return {
      result: buildSurface(fields(display, design.layout), savings.blocks, [...adjusted, ...savings.issued], display),
      attachment: {
        id,
        revision,
        name: design.name,
        target,
        ...(toolContracts ? { toolContracts } : {}),
      } satisfies AppliedUiLayout,
    };
  }
}

export function compileUiLayoutPreview(
  design: UiDesign,
  samples: DisplayBlock[],
  bindings?: DataBindingValues,
  precompiledToolBlocks?: DisplayBlock[],
): DisplayExperience {
  const { mapped } = arrange(design, samples, bindings, precompiledToolBlocks);
  return buildSurface({
    status: "ready", outcome: "ready", intro: "Here’s what I found.",
    question: null, partial: false, expiresAt: 0, layout: design.layout, theme: "evergreen",
  }, issueSavingsOptions(mapped, true).blocks, []).display;
}
