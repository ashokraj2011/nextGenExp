import { z } from "zod";
import type { TreatmentRecommendations } from "./funding-workflow";
import type { MockCcreEvaluation } from "./tool-setup";

export const workspacePins = ["portfolio", "savings", "account", "next-step"] as const;
export type WorkspacePin = typeof workspacePins[number];
export const defaultWorkspacePins: WorkspacePin[] = ["portfolio", "savings", "account"];
export const workspacePinsSchema = z.array(z.enum(workspacePins)).max(workspacePins.length)
  .refine((pins) => new Set(pins).size === pins.length, "A section can only be pinned once.");

export type WorkspaceNextStep = {
  title: string;
  body: string;
  reason?: string;
  canPreviewFunding: boolean;
};

export const overviewFundingOrigin = "overview_funding";
export const nextStepContext = "next-step";
export const pendingActionsContext = "pending-actions";
export const accountPortalPath = "/portal/funding";
export type FirstDepositConfirmation = {
  eventId: string;
  type: "account.first_deposit.completed";
  source: "mock-account-portal";
  mid: string;
  occurredAt: number;
};
export type PortalFundingView = {
  personaId: string;
  displayName: string;
  fundingStatus: "funded" | "unfunded";
  confirmation?: FirstDepositConfirmation;
};
export const pendingActionsFundingOrigin = "pending_actions_funding";

export function workspaceFundingContext(origin: string) {
  if (origin === overviewFundingOrigin) return nextStepContext;
  if (origin === pendingActionsFundingOrigin) return pendingActionsContext;
}

export type WorkspacePendingAction = {
  contentId: string;
  title: string;
  body: string;
  action: { kind: "guide"; label: string; message: string } | { kind: "funding"; label: string };
};

export type WorkspaceActionLog = {
  id: string;
  personaId: string;
  createdAt: number;
  request: { mid: string; context: typeof pendingActionsContext };
} & (
  { status: "succeeded"; response: TreatmentRecommendations; ccre?: MockCcreEvaluation } |
  { status: "failed"; error: { code: "TS_TIMEOUT" | "TS_UNAVAILABLE" } }
);
