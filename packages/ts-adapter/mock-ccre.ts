import type { MockCcreCondition, MockCcreEvaluation, MockCcreRule } from "../contracts/tool-setup";
import { matchesGlossaryCondition } from "../rule-glossary";

type RuleInput = { scenarioId: string; contextId: string; personaId: string; ordinal: number; portfolioCashCents?: number; fundingStatus?: "funded" | "unfunded" };

function matches(condition: MockCcreCondition, input: RuleInput): boolean {
  switch (condition.kind) {
    case "always": return true;
    case "never": return false;
    case "persona_is": return condition.personaId === input.personaId;
    case "from_turn": return input.ordinal >= condition.ordinal;
    case "attribute": return matchesGlossaryCondition(condition, input);
  }
}

export function applyMockCcreRules(contentIds: string[], rules: readonly MockCcreRule[], input: RuleInput) {
  const scoped = rules.filter((rule) => rule.scenarioId === input.scenarioId && rule.contextId === input.contextId);
  if (!scoped.length) return { contentIds };

  const candidates = new Set(contentIds);
  const results: MockCcreEvaluation["results"] = scoped.map(({ name, contentId, condition }) => ({
    name, contentId,
    outcome: !candidates.has(contentId) ? "outside_list" : matches(condition, input) ? "matched" : "excluded",
  }));
  const excluded = new Set(results.filter(({ outcome }) => outcome === "excluded").map(({ contentId }) => contentId));
  return {
    contentIds: contentIds.filter((id) => !excluded.has(id)),
    ccre: { beforeRules: contentIds, results },
  };
}
