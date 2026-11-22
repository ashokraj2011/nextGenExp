import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import host from "../../fixtures/host.json";
import {
  MAX_CCRE_RULES, type MockCcreRule, type MockOutput, type ToolSetup, type ToolSetupView, type TreatmentPreview, type TreatmentPreviewInput,
} from "../../packages/contracts/tool-setup";
import { contentCatalog } from "../../packages/experience/content";
import { activeContexts, fixtureEligibleSets, FixtureTsAdapter, scenariosById, TreatmentSelectorTimeout, tsFixtures } from "../../packages/ts-adapter";
import { ApiError } from "./store";

const fixtureIds = new Set(fixtureEligibleSets.flat());
const content = contentCatalog.entries
  .filter(({ contentId, publicationStatus }) => publicationStatus === "published" && fixtureIds.has(contentId))
  .map(({ contentId, title }) => ({ contentId, title }));
const contentIds = new Set(content.map(({ contentId }) => contentId));
const contexts = activeContexts.map(({ contextId, displayName }) => ({ contextId, displayName }));

export function toolSetupTag(setup: ToolSetup) {
  return '"' + createHash("sha256").update(JSON.stringify(setup)).digest("hex") + '"';
}

export function toolSetupView(setup: ToolSetup): ToolSetupView {
  return {
    setup, content, contexts,
    defaultPersonaId: host.defaultPersonaId,
    defaultScenarioId: host.defaultScenarioId,
    personas: host.personas.map(({ personaId, displayName, allowedScenarios }) => ({ personaId, displayName, allowedScenarios })),
    scenarios: tsFixtures.scenarios.map(({ scenarioId, label }) => ({ scenarioId, label })),
  };
}

function validateScope(scenarioId: string, contextId: string) {
  if (!scenariosById.has(scenarioId) || !contexts.some((entry) => entry.contextId === contextId)) {
    throw new ApiError(400, "invalid_mock_scope", "Choose a fixture scenario and an active context.");
  }
}

function validateMock(scenarioId: string, contextId: string, output: MockOutput | null) {
  validateScope(scenarioId, contextId);
  if (output?.mode === "ranked" && output.contentIds.some((id) => !contentIds.has(id))) {
    throw new ApiError(400, "invalid_mock_content", "Choose content from the eligible demo catalog.");
  }
}

function validateCcreRule(rule: MockCcreRule) {
  validateScope(rule.scenarioId, rule.contextId);
  if (!contentIds.has(rule.contentId)) {
    throw new ApiError(400, "invalid_ccre_treatment", "Choose a rule target from the eligible demo catalog.");
  }
  const { condition } = rule;
  if (condition.kind === "persona_is" && !host.personas.some((persona) => (
    persona.personaId === condition.personaId && persona.allowedScenarios.includes(rule.scenarioId)
  ))) {
    throw new ApiError(400, "invalid_ccre_persona", "Choose a rule persona allowed for its scenario.");
  }
}

export function validateToolSetup(setup: ToolSetup) {
  for (const { scenarioId, contextId, output } of setup.treatmentOverrides) validateMock(scenarioId, contextId, output);
  for (const rule of setup.ccreRules ?? []) validateCcreRule(rule);
}

export function addCcreRule(setup: ToolSetup, rule: MockCcreRule): ToolSetup {
  validateCcreRule(rule);
  const rules = setup.ccreRules ?? [];
  const existing = rules.find(({ scenarioId, contextId, contentId }) => (
    scenarioId === rule.scenarioId && contextId === rule.contextId && contentId === rule.contentId
  ));
  if (existing) {
    if (isDeepStrictEqual(existing, rule)) return setup;
    throw new ApiError(409, "ccre_rule_exists", "This treatment already has a rule in this scenario and context. You can edit it in Tool setup.");
  }
  if (rules.length >= MAX_CCRE_RULES) {
    throw new ApiError(409, "ccre_rule_limit", "The setup has reached its rule limit.");
  }
  return { ...setup, ccreRules: [...rules, rule] };
}

export async function previewTreatmentSelector(input: TreatmentPreviewInput): Promise<TreatmentPreview> {
  const { scenarioId, contextId, personaId, ordinal, enabled, output, ccreRules = [] } = input;
  validateMock(scenarioId, contextId, output);
  for (const rule of ccreRules) {
    if (rule.scenarioId !== scenarioId || rule.contextId !== contextId) {
      throw new ApiError(400, "invalid_ccre_preview_scope", "Preview rules must belong to the selected scenario and context.");
    }
    validateCcreRule(rule);
  }
  const persona = host.personas.find((entry) => entry.personaId === personaId && entry.allowedScenarios.includes(scenarioId));
  if (!persona) throw new ApiError(400, "invalid_mock_persona", "Choose a demo persona allowed for this scenario.");
  if (!enabled) return { status: "disabled" };
  const source = output ? "override" : "fixture";
  const adapter = new FixtureTsAdapter({ scenarioId, ordinal }, output ? [{ scenarioId, contextId, output }] : [], ccreRules);
  try {
    const result = adapter.selectEligibleContent({ mid: persona.syntheticMid, context: contextId });
    return { status: result.contentIds.length ? "ranked" : "empty", source, ...result };
  } catch (error) {
    if (error instanceof TreatmentSelectorTimeout) return { status: "timeout", source };
    throw error;
  }
}
