import host from "../../fixtures/host.json";
import type { MockOutput, ToolSetup, ToolSetupView, TreatmentPreview, TreatmentPreviewInput } from "../../packages/contracts/tool-setup";
import { contentCatalog } from "../../packages/experience/content";
import { activeContexts, fixtureEligibleSets, FixtureTsAdapter, scenariosById, TreatmentSelectorTimeout, tsFixtures } from "../../packages/ts-adapter";
import { ApiError } from "./store";

const fixtureIds = new Set(fixtureEligibleSets.flat());
const content = contentCatalog.entries
  .filter(({ contentId, publicationStatus }) => publicationStatus === "published" && fixtureIds.has(contentId))
  .map(({ contentId, title }) => ({ contentId, title }));
const contentIds = new Set(content.map(({ contentId }) => contentId));
const contexts = activeContexts.map(({ contextId, displayName }) => ({ contextId, displayName }));

export function toolSetupView(setup: ToolSetup): ToolSetupView {
  return {
    setup, content, contexts,
    defaultPersonaId: host.defaultPersonaId,
    defaultScenarioId: host.defaultScenarioId,
    personas: host.personas.map(({ personaId, displayName, allowedScenarios }) => ({ personaId, displayName, allowedScenarios })),
    scenarios: tsFixtures.scenarios.map(({ scenarioId, label }) => ({ scenarioId, label })),
  };
}

function validateMock(scenarioId: string, contextId: string, output: MockOutput | null) {
  if (!scenariosById.has(scenarioId) || !contexts.some((entry) => entry.contextId === contextId)) {
    throw new ApiError(400, "invalid_mock_scope", "Choose a fixture scenario and an active context.");
  }
  if (output?.mode === "ranked" && output.contentIds.some((id) => !contentIds.has(id))) {
    throw new ApiError(400, "invalid_mock_content", "Choose content from the eligible demo catalog.");
  }
}

export function validateToolSetup(setup: ToolSetup) {
  for (const { scenarioId, contextId, output } of setup.treatmentOverrides) validateMock(scenarioId, contextId, output);
}

export async function previewTreatmentSelector(input: TreatmentPreviewInput): Promise<TreatmentPreview> {
  const { scenarioId, contextId, personaId, ordinal, enabled, output } = input;
  validateMock(scenarioId, contextId, output);
  const persona = host.personas.find((entry) => entry.personaId === personaId && entry.allowedScenarios.includes(scenarioId));
  if (!persona) throw new ApiError(400, "invalid_mock_persona", "Choose a demo persona allowed for this scenario.");
  if (!enabled) return { status: "disabled" };
  const source = output ? "override" : "fixture";
  const adapter = new FixtureTsAdapter({ scenarioId, ordinal }, output ? [{ scenarioId, contextId, output }] : []);
  try {
    const contentIds = await adapter.getRankedEligibleIds({ mid: persona.syntheticMid, context: contextId });
    return { status: contentIds.length ? "ranked" : "empty", source, contentIds };
  } catch (error) {
    if (error instanceof TreatmentSelectorTimeout) return { status: "timeout", source };
    throw error;
  }
}
