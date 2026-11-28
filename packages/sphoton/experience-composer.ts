/**
 * Singularity Photon (sphoton) — Generic 5-Class Experience Composer & Surface Policy Engine.
 *
 * Pure, domain-agnostic, zero-server, zero-PZN-coupling module.
 * Any sfield tool (domain APIs, PZN treatment tools, compliance rules, ranking tools, ops alerts)
 * feeds candidate items into sphoton; sphoton owns:
 *   1. Unified UI Component Catalog & 3-mode UI Resolution (pinned, runtime tool-selected, runtime A2UI)
 *   2. 5-Class UI Taxonomy (main, tasks, nba, actions, chrome)
 *   3. Per-Channel Surface Budgets & Priority Arbitration (Main > Tasks > NBA)
 *   4. Cross-channel dismissal suppression, Task-to-NBA auto-promotion, and immutable compliance chrome.
 */

export type SphotonUiPlacementClass = "main" | "tasks" | "nba" | "actions" | "chrome";

export type SphotonUiResolutionMode =
  | "pinned_widget"
  | "runtime_tool_selected"
  | "runtime_sphoton_generative";

export type SphotonVisualKind =
  | "kpi_cards"
  | "allocation_bar"
  | "comparison_table"
  | "readiness_gauge"
  | "action_checklist";

export type SphotonFrameMode = "chat" | "web" | "mobile" | "advisor";

export type SphotonUiComponentEntry = {
  id: string;
  name: string;
  source: "ui_registry" | "widget_studio" | "tool_catalog" | "sphoton_a2ui";
  visualKind: SphotonVisualKind;
  description: string;
  badge: string;
};

export type SphotonChannelBudget = {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
  maxMain: number;
  maxTasks: number;
  maxNba: number;
  maxCompanionTotal: number;
  maxFollowUps: number;
  showProvenanceRail: boolean;
  frameMode: SphotonFrameMode;
  custom?: boolean;
};

export type SphotonResolvedUi = {
  mode: SphotonUiResolutionMode;
  resolvedUiId: string;
  resolvedUiName: string;
  source: SphotonUiComponentEntry["source"];
  visualKind: SphotonVisualKind;
  rationale: string;
  a2uiNodes?: string[];
};

export type SphotonArbitrationOutcome =
  | "placed"
  | "suppressed"
  | "promoted"
  | "dismissed"
  | "cleared";

export type SphotonArbitrationEntry = {
  uiClass: SphotonUiPlacementClass;
  outcome: SphotonArbitrationOutcome;
  itemId: string;
  reason: string;
};

export type SphotonCompanionCandidate = {
  id: string;
  title: string;
  sourceToolRef: string;
  ruleId?: string;
  score?: number;
};

export type SphotonSuppressedItem = {
  uiClass: "tasks" | "nba";
  id: string;
  title: string;
  reason: string;
};

export const DEFAULT_SPHOTON_UI_CATALOG: readonly SphotonUiComponentEntry[] = [
  {
    id: "ui_allocation_breakdown@2.0.0",
    name: "Proportional Allocation Breakdown",
    source: "ui_registry",
    visualKind: "allocation_bar",
    description: "Proportional split bar + KPI strip bound to smass currency/numeric fields.",
    badge: "UI Registry",
  },
  {
    id: "ui_kpi_summary@1.0.0",
    name: "Executive KPI Metric Card",
    source: "ui_registry",
    visualKind: "kpi_cards",
    description: "Clean 3-tile tabular-numeral KPI strip with status highlights.",
    badge: "UI Registry",
  },
  {
    id: "ui_comparison_matrix@1.0.0",
    name: "Side-by-Side Comparison Card",
    source: "ui_registry",
    visualKind: "comparison_table",
    description: "Structured 2-column comparison layout for balances, liquidity, or options.",
    badge: "UI Registry",
  },
  {
    id: "ui_readiness_gauge@1.0.0",
    name: "Goal & Readiness Progress Gauge",
    source: "ui_registry",
    visualKind: "readiness_gauge",
    description: "Visual progress bar + milestone breakdown bound to verified targets.",
    badge: "UI Registry",
  },
  {
    id: "ui_guided_checklist@1.0.0",
    name: "Guided Verification Checklist",
    source: "ui_registry",
    visualKind: "action_checklist",
    description: "Step-by-step guided task card for operational or compliance workflows.",
    badge: "UI Registry",
  },
];

export const DEFAULT_SPHOTON_CHANNEL_BUDGETS: readonly SphotonChannelBudget[] = [
  {
    id: "chat_turn",
    label: "AI Chat Turn",
    shortLabel: "AI Chat",
    description: "Conversational reply: 1 Main card + max 1 companion (Task outranks NBA) + 3 follow-ups + locked disclosures.",
    maxMain: 1,
    maxTasks: 1,
    maxNba: 1,
    maxCompanionTotal: 1,
    maxFollowUps: 3,
    showProvenanceRail: false,
    frameMode: "chat",
  },
  {
    id: "web_dashboard",
    label: "Web Portal Dashboard",
    shortLabel: "Web Portal",
    description: "Full portal overview: 1 Main hero + Pending Tasks rail + 1 Ranked NBA spotlight + Compliance footer.",
    maxMain: 1,
    maxTasks: 3,
    maxNba: 1,
    maxCompanionTotal: 4,
    maxFollowUps: 4,
    showProvenanceRail: false,
    frameMode: "web",
  },
  {
    id: "mobile_compact",
    label: "Mobile App (Compact)",
    shortLabel: "Mobile App",
    description: "Tight 375px thumb budget: 1 Main compact card + 1 highest-priority pill (Task > NBA) + 1 follow-up.",
    maxMain: 1,
    maxTasks: 1,
    maxNba: 1,
    maxCompanionTotal: 1,
    maxFollowUps: 1,
    showProvenanceRail: false,
    frameMode: "mobile",
  },
  {
    id: "advisor_desktop",
    label: "Advisor Co-Pilot Workstation",
    shortLabel: "Advisor Co-Pilot",
    description: "High-density workstation: Main + All Tasks + All Ranked NBAs with scores + live smass/tool provenance.",
    maxMain: 1,
    maxTasks: 4,
    maxNba: 3,
    maxCompanionTotal: 7,
    maxFollowUps: 4,
    showProvenanceRail: true,
    frameMode: "advisor",
  },
];

/**
 * Resolves which UI component renders the Main experience zone across the 3 sphoton resolution modes:
 *   1. pinned_widget: design-time attached component from UI Registry or Widget Studio
 *   2. runtime_tool_selected: runtime UI template chosen dynamically by an sfield tool (e.g. PZN or domain tool)
 *   3. runtime_sphoton_generative: declarative A2UI node tree synthesized at runtime and bound to verified smass fields
 */
export function resolveExperienceUi(input: {
  mode: SphotonUiResolutionMode;
  catalog: readonly SphotonUiComponentEntry[];
  budget: SphotonChannelBudget;
  snapshotId: string;
  domainId: string;
  pinnedUiId?: string;
  runtimeSuggestedUiId?: string;
  runtimeSelectorToolRef?: string;
  defaultVisualKind?: SphotonVisualKind;
}): SphotonResolvedUi {
  const { catalog, budget, snapshotId } = input;
  const fallback = catalog[0] ?? DEFAULT_SPHOTON_UI_CATALOG[0];

  if (input.mode === "pinned_widget") {
    const entry = (input.pinnedUiId ? catalog.find((c) => c.id === input.pinnedUiId) : undefined) ?? fallback;
    return {
      mode: "pinned_widget",
      resolvedUiId: entry.id,
      resolvedUiName: entry.name,
      source: entry.source,
      visualKind: entry.visualKind,
      rationale: `Design-time pinned to ${entry.badge} "${entry.name}" (${entry.id}) bound to snapshot ${snapshotId}.`,
    };
  }

  if (input.mode === "runtime_sphoton_generative") {
    const visualKind: SphotonVisualKind =
      budget.frameMode === "mobile" ? "kpi_cards" : (input.defaultVisualKind ?? "kpi_cards");
    return {
      mode: "runtime_sphoton_generative",
      resolvedUiId: `sphoton_a2ui_${input.domainId}_${budget.frameMode}`,
      resolvedUiName: "sphoton A2UI Synthesized Surface",
      source: "sphoton_a2ui",
      visualKind,
      rationale: `Runtime-synthesized by sphoton A2UI from 4 approved primitives bound strictly to ${snapshotId} (0 unverified values).`,
      a2uiNodes: [
        "SurfaceHeader(title, subtitle)",
        visualKind === "allocation_bar"
          ? "AllocationBar($ref:smass.metrics)"
          : visualKind === "readiness_gauge"
            ? "ReadinessGauge($ref:smass.metrics)"
            : visualKind === "comparison_table"
              ? "ComparisonColumns($ref:smass.metrics)"
              : "MetricGrid($ref:smass.metrics)",
        "HighlightBadges($ref:smass.highlights)",
        "ImmutableDisclosure(compliance.locked)",
      ],
    };
  }

  // runtime_tool_selected: driven by any registered sfield tool (PZN, ranking, or domain tool)
  const pickedId =
    budget.frameMode === "mobile"
      ? "ui_kpi_summary@1.0.0"
      : (input.runtimeSuggestedUiId ?? fallback.id);
  const entry = catalog.find((c) => c.id === pickedId) ?? fallback;
  const selectorLabel = input.runtimeSelectorToolRef ?? "sfield.ui.selector@1.0.0";
  return {
    mode: "runtime_tool_selected",
    resolvedUiId: entry.id,
    resolvedUiName: entry.name,
    source: "tool_catalog",
    visualKind: entry.visualKind,
    rationale: `Selected at runtime by sfield tool ${selectorLabel} for ${budget.shortLabel} -> "${entry.name}" (${entry.id}) bound to ${snapshotId}.`,
  };
}

/**
 * Pure 5-Class Experience Surface Arbitrator inside sphoton.
 * Consumes normalized candidates produced by any sfield tools (PZN or otherwise) and enforces:
 *   - Class 1 (Main): always placed #1
 *   - Class 2 (Tasks): outranks Class 3 (NBA) under combined companion caps
 *   - Class 3 (NBA): suppresses dismissed items across channels; auto-promotes when an open Task clears
 *   - Class 5 (Chrome): clamps follow-ups to channel budget while keeping disclosures immutable
 */
export function arbitrateExperienceSurface<
  TTask extends SphotonCompanionCandidate,
  TNba extends SphotonCompanionCandidate,
>(input: {
  budget: SphotonChannelBudget;
  mainItemId: string;
  mainRationale: string;
  revision: number;
  accountVersion: number;
  taskCandidates: readonly TTask[];
  clearedTasks?: ReadonlyArray<{ id: string; title: string }>;
  nbaCandidates: readonly TNba[];
  dismissedIds: ReadonlySet<string>;
  followUps: readonly string[];
  disclosures: readonly string[];
}): {
  placedTasks: TTask[];
  placedNba: TNba[];
  suppressed: SphotonSuppressedItem[];
  followUps: string[];
  disclosures: string[];
  arbitrationLog: SphotonArbitrationEntry[];
} {
  const { budget, dismissedIds } = input;
  const arbitrationLog: SphotonArbitrationEntry[] = [];
  const suppressed: SphotonSuppressedItem[] = [];
  const placedTasks: TTask[] = [];
  const placedNba: TNba[] = [];

  // Class 1: Main is non-negotiable #1
  arbitrationLog.push({
    uiClass: "main",
    outcome: "placed",
    itemId: input.mainItemId,
    reason: input.mainRationale,
  });

  // Cleared tasks (from confirmed domain events)
  const hadClearedTask = (input.clearedTasks?.length ?? 0) > 0;
  for (const cleared of input.clearedTasks ?? []) {
    arbitrationLog.push({
      uiClass: "tasks",
      outcome: "cleared",
      itemId: cleared.id,
      reason: `Task "${cleared.title}" cleared live at revision ${input.revision} (version ${input.accountVersion}).`,
    });
  }

  // Class 2: Tasks outrank NBA when companion slots are constrained
  let companionUsed = 0;
  for (const task of input.taskCandidates) {
    if (companionUsed < budget.maxCompanionTotal && placedTasks.length < budget.maxTasks) {
      placedTasks.push(task);
      companionUsed += 1;
      arbitrationLog.push({
        uiClass: "tasks",
        outcome: "placed",
        itemId: task.id,
        reason: `sfield tool ${task.sourceToolRef}${task.ruleId ? ` (${task.ruleId})` : ""} -> Task "${task.title}" placed (Tasks outrank NBA).`,
      });
    } else {
      const reason = `${budget.shortLabel} budget cap reached (${budget.maxTasks} tasks / ${budget.maxCompanionTotal} companions).`;
      suppressed.push({ uiClass: "tasks", id: task.id, title: task.title, reason });
      arbitrationLog.push({ uiClass: "tasks", outcome: "suppressed", itemId: task.id, reason });
    }
  }

  // Class 3: NBAs sorted by score descending, subject to dismissals & remaining companion budget
  const rankedNbas = [...input.nbaCandidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  for (const nba of rankedNbas) {
    if (dismissedIds.has(nba.id)) {
      suppressed.push({
        uiClass: "nba",
        id: nba.id,
        title: nba.title,
        reason: "Suppressed across all channels — dismissed in sfield memory.",
      });
      arbitrationLog.push({
        uiClass: "nba",
        outcome: "dismissed",
        itemId: nba.id,
        reason: `NBA "${nba.title}" suppressed because member dismissed it (synced across all channels via sfield memory).`,
      });
      continue;
    }

    if (companionUsed >= budget.maxCompanionTotal || placedNba.length >= budget.maxNba) {
      const blocker = placedTasks[0]?.title;
      const reason = blocker
        ? `${budget.shortLabel} budget allows ${budget.maxCompanionTotal} companion slot — Task "${blocker}" took priority.`
        : `${budget.shortLabel} budget allows max ${budget.maxNba} NBA / ${budget.maxCompanionTotal} companion slot(s).`;
      suppressed.push({ uiClass: "nba", id: nba.id, title: nba.title, reason });
      arbitrationLog.push({
        uiClass: "nba",
        outcome: "suppressed",
        itemId: nba.id,
        reason: `NBA "${nba.title}"${nba.score !== undefined ? ` (score ${nba.score})` : ""} held back on ${budget.shortLabel}: ${reason}`,
      });
      continue;
    }

    placedNba.push(nba);
    companionUsed += 1;
    const promoted = hadClearedTask && placedTasks.length === 0 && budget.maxCompanionTotal === 1;
    arbitrationLog.push({
      uiClass: "nba",
      outcome: promoted ? "promoted" : "placed",
      itemId: nba.id,
      reason: promoted
        ? `Task cleared at rev ${input.revision} -> sphoton auto-promoted waiting NBA "${nba.title}" (from ${nba.sourceToolRef}) into freed ${budget.shortLabel} slot!`
        : `sfield tool ${nba.sourceToolRef} -> NBA "${nba.title}"${nba.score !== undefined ? ` (score ${nba.score})` : ""} placed within ${budget.shortLabel} budget.`,
    });
  }

  // Class 5: Chrome — follow-ups clamped per channel, disclosures ALWAYS preserved
  const followUps = input.followUps.slice(0, budget.maxFollowUps);
  const disclosures = [...input.disclosures];
  arbitrationLog.push({
    uiClass: "chrome",
    outcome: "placed",
    itemId: "compliance_chrome",
    reason: `Pinned ${disclosures.length} immutable disclosure(s) & ${followUps.length}/${input.followUps.length} follow-up chip(s) for ${budget.shortLabel}.`,
  });

  return { placedTasks, placedNba, suppressed, followUps, disclosures, arbitrationLog };
}
