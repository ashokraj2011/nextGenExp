import type { modelBundle } from "../experience/content";
import type { ContextCatalog, Intent, PropensityResult } from "./domain";
import type { RoutingHistoryEntry, RoutingIntent, RoutingIntentId } from "./routing-intents";

export type ContextRoutingInput = {
  inputType: "PznContextRoutingInput";
  catalogSnapshotId: string;
  catalog: ContextCatalog;
  intentCatalog: readonly RoutingIntent[];
  propensity?: PropensityResult;
  allowedQuestions: readonly string[];
  canCreateRule: boolean;
  recent: RoutingHistoryEntry[];
  summaryFollowUpIntentId?: Extract<RoutingIntent, { task: "show" }>["intentId"];
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
  allowedQuestions: readonly string[];
};
