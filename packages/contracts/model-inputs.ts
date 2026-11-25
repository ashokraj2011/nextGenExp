import type { modelBundle } from "../experience/content";
import type { ContextCatalog, Intent, PropensityResult } from "./domain";
import type { RoutingHistoryEntry, RoutingIntent, RoutingIntentId } from "./routing-intents";

export type CustomerRoutingContext = {
  segment?: string;
  fundingStatus: "funded" | "unfunded";
  beneficiaryStatus: "on_file" | "missing";
  hasElevatedCash: boolean;
  hasActiveHomeGoal: boolean;
  notes?: string;
};

export type ContextRoutingInput = {
  inputType: "PznContextRoutingInput";
  catalogSnapshotId: string;
  catalog: ContextCatalog;
  intentCatalog: readonly RoutingIntent[];
  customerContext?: CustomerRoutingContext;
  uiDescriptions?: { intentId: RoutingIntentId; description: string }[];
  propensity?: PropensityResult;
  allowedQuestions: readonly string[];
  canCreateRule: boolean;
  recent: RoutingHistoryEntry[];
  summaryFollowUpIntentId?: RoutingIntentId;
  request: string;
};

export type ExperienceCompositionInput = {
  inputType: "PznExperienceCompositionInput";
  request: string;
  intent: Intent;
  selectedIntentId?: RoutingIntentId;
  selectedContextId: string;
  eligible: ReturnType<typeof modelBundle>;
  portfolioSnapshotIncluded?: true;
  goalProgressIncluded?: true;
  recent?: RoutingHistoryEntry[];
  allowedQuestions: readonly string[];
};
