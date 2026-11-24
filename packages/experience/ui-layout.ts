import type { DisplayBlock, DisplayExperience } from "../contracts/surface";
import type { AppliedUiLayout, UiDesign, UiPublication, UiTarget } from "../contracts/ui-layout";
import { targetKey } from "../contracts/ui-layout";
import { buildSurface, type CompiledExperience } from "./compile";

type SlotBlock = { block: DisplayBlock; index?: number };

function arrange(design: UiDesign, original: DisplayBlock[]) {
  const positions = new Set<number>();
  const mapped: SlotBlock[] = [];
  for (const slot of design.slots) {
    if (slot.kind === "text") {
      if (slot.heading || slot.body) {
        mapped.push({ block: { component: "PznLayoutText", props: { heading: slot.heading, body: slot.body, tone: slot.tone } } });
      }
      continue;
    }
    const index = original.findIndex((block, i) => block.component === slot.component && !positions.has(i));
    if (index >= 0) {
      mapped.push({ block: original[index], index });
      positions.add(index);
    }
  }
  return { mapped, positions };
}

function fields(display: DisplayExperience, layout: UiDesign["layout"]) {
  const { status, outcome, intro, question, partial, expiresAt } = display;
  return { status, outcome, intro, question, partial, expiresAt, layout, theme: "evergreen" as const };
}

export function applyPublishedUi(result: CompiledExperience, publications: UiPublication[], targets: UiTarget[]) {
  const { display, issued } = result;
  if (!display.blocks.length) return;
  for (const target of targets) {
    const publication = publications.find(({ design }) => design.targets.some((item) => targetKey(item) === targetKey(target)));
    if (!publication) continue;
    const { design, id, revision } = publication;
    const { mapped, positions } = arrange(design, display.blocks);
    if (!positions.size) continue;
    for (const [index, block] of display.blocks.entries()) {
      if (!positions.has(index)) mapped.push({ block, index });
    }
    const componentIds = new Map(mapped.flatMap(({ index }, next) => (
      index === undefined ? [] : [["block_" + (index + 1), "block_" + (next + 1)] as const]
    )));
    const adjusted = issued.map((action) => ({ ...action, componentId: componentIds.get(action.componentId) ?? action.componentId }));
    return {
      result: buildSurface(fields(display, design.layout), mapped.map(({ block }) => block), adjusted, display),
      attachment: { id, revision, name: design.name, target } satisfies AppliedUiLayout,
    };
  }
}

export function compileUiLayoutPreview(design: UiDesign, samples: DisplayBlock[]): DisplayExperience {
  const { mapped } = arrange(design, samples);
  return buildSurface({
    status: "ready", outcome: "ready", intro: "Here’s what I found.",
    question: null, partial: false, expiresAt: 0, layout: design.layout, theme: "evergreen",
  }, mapped.map(({ block }) => block), []).display;
}
