import type { SphotonLlmAdapter } from "./adapter";
import {
  sphotonCardBindingSchema,
  type SphotonBindingCatalog,
  type SphotonCardBinding,
} from "./contracts";
import { validateCardBinding } from "./validator";

export type SphotonGeneratedDraft = {
  card: SphotonCardBinding;
  generatedBy: "llm" | "catalog_synthesizer";
  boundFields: string[];
  summary: string;
};

function shortSlotName(toolRef: string): string {
  const base = toolRef.split("@")[0].split(".")[0] ?? "source";
  return base.replace(/[^a-zA-Z0-9_-]/g, "_") || "source";
}

function synthesizeFromCatalog(prompt: string, catalog: SphotonBindingCatalog): SphotonCardBinding {
  const lower = prompt.toLowerCase();

  // Wealth goal progress card when prompt asks about home/goal/down payment/savings and goal tool is exposed.
  const goalTool = catalog.tools.find((t) => t.id === "goal.progress.read");
  const goalTarget = catalog.fields.find((f) => f.toolRef === goalTool?.toolRef && f.outputPath === "targetCents");
  const goalHistory = catalog.fields.find((f) => f.toolRef === goalTool?.toolRef && f.outputPath === "history");
  if (goalTool && goalTarget && goalHistory && /\b(goal|down\s*payment|home|saving|chart|target)\b/i.test(lower)) {
    const savingsAction = catalog.actions.find((a) => a.toolRef.startsWith("goal.savings.preview@"));
    return {
      component: "PznGoalProgress",
      sources: {
        goal: {
          toolRef: goalTool.toolRef,
          read: "reuseVerifiedTurnResult",
        },
      },
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
  }

  // Generic catalog-driven card: score fields by prompt keyword overlap so ANY exposed field in ANY domain is bindable!
  const promptTokens = new Set(lower.split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
  const scored = catalog.fields.map((field, index) => {
    const haystack = `${field.label} ${field.outputPath} ${field.group} ${field.description ?? ""}`.toLowerCase();
    let score = 0;
    for (const token of promptTokens) {
      if (haystack.includes(token)) score += 2;
    }
    return { field, score, index };
  }).sort((a, b) => b.score - a.score || a.index - b.index);

  const chosen = scored.slice(0, 4).map(({ field }) => field);
  const sources: SphotonCardBinding["sources"] = {};
  const toolToSlot = new Map<string, string>();
  for (const field of chosen) {
    if (!toolToSlot.has(field.toolRef)) {
      let slot = shortSlotName(field.toolRef);
      let suffix = 2;
      while (sources[slot]) slot = `${shortSlotName(field.toolRef)}_${suffix++}`;
      toolToSlot.set(field.toolRef, slot);
      sources[slot] = { toolRef: field.toolRef, read: "reuseVerifiedTurnResult" };
    }
  }

  const bindings = chosen.map((field, idx) => ({
    field: idx === 0 && field.type === "string" ? "title" : `metric_${idx + 1}`,
    from: `${toolToSlot.get(field.toolRef)!}.data.${field.outputPath}`,
    ...(field.defaultFormat ? { format: field.defaultFormat } : {}),
    label: field.label,
    required: idx === 0,
  }));

  const matchedAction = catalog.actions.find((action) => {
    const text = `${action.label} ${action.toolRef} ${action.description ?? ""}`.toLowerCase();
    return [...promptTokens].some((tok) => text.includes(tok));
  }) ?? catalog.actions[0];

  return {
    component: "PznBoundWidget",
    sources,
    bindings,
    ...(matchedAction ? {
      actions: [{
        id: matchedAction.id,
        label: matchedAction.label,
        toolRef: matchedAction.toolRef,
        followUpInputs: matchedAction.followUpInputFields,
        update: matchedAction.defaultUpdate,
      }],
    } : {}),
    unavailableState: {
      title: "Card data unavailable",
      message: "Required data from the domain tool could not be loaded.",
    },
  };
}

/**
 * Generates a tool-bound card draft strictly from the domain's exposed binding catalog.
 * Uses the injected LLM adapter when available, validates against sphoton, and falls back
 * deterministically to catalog synthesis if the candidate is invalid or no model is connected.
 */
export async function generateBoundCardDraft(input: {
  prompt: string;
  catalog: SphotonBindingCatalog;
  llm?: SphotonLlmAdapter;
}): Promise<SphotonGeneratedDraft> {
  const { prompt, catalog, llm } = input;

  if (llm && catalog.fields.length > 0) {
    const fieldLines = catalog.fields.map((f) =>
      `- ${f.toolRef} -> ${f.outputPath} (${f.type}, label: "${f.label}", formats: ${f.supportedFormats.join(",")})`,
    ).join("\n");
    const actionLines = catalog.actions.map((a) =>
      `- ${a.toolRef} (id: ${a.id}, label: "${a.label}", fixedInputs: ${Object.keys(a.fixedInputFields).join(",") || "none"}, followUp: ${a.followUpInputFields.join(",") || "none"})`,
    ).join("\n");

    const systemPrompt = [
      `You are sphoton, a UI binding generator for the ${catalog.domainId} domain.`,
      `Return ONLY valid JSON matching { component, sources, bindings, actions?, unavailableState? }.`,
      `Use ONLY tools, output paths, and actions from the allowed catalog below:`,
      `EXPOSED FIELDS:\n${fieldLines}`,
      actionLines ? `EXPOSED ACTIONS:\n${actionLines}` : "EXPOSED ACTIONS: none",
    ].join("\n\n");

    try {
      const raw = await llm.generateJson({ systemPrompt, userPrompt: prompt });
      const parsed = sphotonCardBindingSchema.safeParse(raw);
      if (parsed.success) {
        const check = validateCardBinding(parsed.data, catalog);
        if (check.valid) {
          return {
            card: parsed.data,
            generatedBy: "llm",
            boundFields: parsed.data.bindings.map((b) => b.from),
            summary: `Generated ${parsed.data.component} bound to ${parsed.data.bindings.length} verified tool field(s).`,
          };
        }
      }
    } catch {
      // Fall through to deterministic catalog synthesizer
    }
  }

  const card = synthesizeFromCatalog(prompt, catalog);
  return {
    card,
    generatedBy: "catalog_synthesizer",
    boundFields: card.bindings.map((b) => b.from),
    summary: `Synthesized ${card.component} bound to ${card.bindings.length} verified tool field(s) from ${catalog.domainId}.`,
  };
}
