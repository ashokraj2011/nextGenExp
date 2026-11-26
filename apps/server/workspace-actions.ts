import host from "../../fixtures/host.json";
import type { PersonaRecord } from "../../packages/customer-profiles";
import { fundingPreviewWorkflow } from "../../packages/contracts/funding-workflow";
import { pendingActionsContext, type WorkspaceActionLog, type WorkspacePendingAction } from "../../packages/contracts/workspace";
import { makeId } from "../../packages/experience/compile";
import { lookupContent } from "../../packages/experience/content";
import type { PortfolioSnapshotProvider } from "../../packages/portfolio-snapshot";
import { FixtureTsAdapter, TreatmentSelectorTimeout } from "../../packages/ts-adapter";
import { nextStepRecommendation } from "./funding-offer";
import { ApiError, type Store } from "./store";

export async function readWorkspacePendingActions(
  store: Store, principalId: string, persona: Pick<PersonaRecord, "personaId" | "syntheticMid">,
  portfolios: PortfolioSnapshotProvider, inspection: boolean, now: number,
): Promise<WorkspacePendingAction[]> {
  const { personaId, syntheticMid } = persona;
  const setup = store.toolSetup("wealth");
  if (!setup.enabled.selection) throw new ApiError(503, "selection_disabled", "Pending actions are unavailable.");
  const adapter = new FixtureTsAdapter(
    { scenarioId: host.defaultScenarioId, ordinal: 1 }, setup.treatmentOverrides, setup.ccreRules,
    portfolios, store.axe.fundingFact({ principalId, personaId }),
  );
  const request = { mid: syntheticMid, context: pendingActionsContext } as const;
  const log = { id: makeId("pending"), personaId, createdAt: now, request };
  const record = (entry: WorkspaceActionLog) => {
    if (!inspection) return;
    try { store.saveWorkspaceActionLog(principalId, entry); }
    catch { /* Diagnostic storage cannot change the selection result. */ }
  };

  let selection: Awaited<ReturnType<FixtureTsAdapter["selectEligibleContent"]>>;
  try {
    selection = await adapter.selectEligibleContent(request, AbortSignal.timeout(5000));
  } catch (error) {
    const code = error instanceof TreatmentSelectorTimeout || (error instanceof Error && error.name === "TimeoutError")
      ? "TS_TIMEOUT" : "TS_UNAVAILABLE";
    record({ ...log, status: "failed", error: { code } });
    throw new ApiError(503, "pending_actions_unavailable", "Couldn’t load pending actions.");
  }

  const { recommendations, ccre } = selection;
  record({ ...log, status: "succeeded", response: recommendations, ccre });
  const { candidates, workflow } = nextStepRecommendation(recommendations, setup, pendingActionsContext, selection.renderedEntries);
  const actions: WorkspacePendingAction[] = [];
  for (const candidate of candidates) {
    const content = lookupContent(candidate);
    if (!content) continue;
    const { contentId, title, body } = content;
    if (contentId === "beneficiary_update") {
      const guide = content.followUps.find(({ followUpId }) => followUpId === "fu_beneficiary_steps");
      if (guide) actions.push({ contentId, title, body, action: { kind: "guide", label: guide.label, message: guide.userMessage } });
    }
    if (contentId === "fund_account" && workflow) {
      actions.push({ contentId, title, body, action: { kind: "funding", label: fundingPreviewWorkflow.label } });
    }
  }
  return actions;
}
