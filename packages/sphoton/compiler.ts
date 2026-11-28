import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { DisplayBlock } from "../contracts/surface";
import { formatGoalMonth, goalProgressSchema, type GoalProgress } from "../contracts/goal-progress";
import { formatPortfolioAmount, portfolioSnapshotSchema } from "../contracts/portfolio";
import type { SfieldAdapter } from "./adapter";
import {
  canonicalStableJson,
  parseBindingSourcePath,
  type SphotonBindingCatalog,
  type SphotonCardAction,
  type SphotonCardBinding,
  type SphotonExecutionScope,
  type SphotonFormat,
  type SphotonSignedActionPayload,
  type SphotonSignedActionRef,
} from "./contracts";
import { fingerprintToolContract } from "./fingerprint";

export type SphotonCompileResult = {
  status: "compiled" | "unavailable" | "incompatible_contract";
  cardId: string;
  block: DisplayBlock;
  signedActions: SphotonSignedActionRef[];
  reusedSources: string[];
  invokedSources: string[];
  missingRequiredFields: string[];
  toolContracts: Record<string, string>;
  reason?: string;
};

export function readPathValue(data: unknown, outputPath: string): unknown {
  let current: unknown = data;
  for (const segment of outputPath.split(".").filter(Boolean)) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      const idx = Number(segment);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

export function formatBoundValue(value: unknown, format?: SphotonFormat): string {
  if (value === null || value === undefined) return "—";
  if (format === "currency_cents" && typeof value === "number") {
    return formatPortfolioAmount(value);
  }
  if (format === "currency" && typeof value === "number") {
    return "$" + value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  if (format === "percent" && typeof value === "number") {
    return `${Math.round(value * 10) / 10}%`;
  }
  if (format === "month" && typeof value === "string" && /^\d{4}-\d{2}$/.test(value)) {
    return formatGoalMonth(value);
  }
  if (format === "number" && typeof value === "number") {
    return value.toLocaleString("en-US");
  }
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function actionSealPayload(payload: SphotonSignedActionPayload, scope: Pick<SphotonExecutionScope, "tenantId" | "domainId" | "principalId" | "conversationId">): string {
  return canonicalStableJson({
    ...payload,
    tenantId: scope.tenantId,
    domainId: scope.domainId,
    principalId: scope.principalId,
    conversationId: scope.conversationId ?? "",
  });
}

export function signActionRef(
  payload: SphotonSignedActionPayload,
  scope: Pick<SphotonExecutionScope, "tenantId" | "domainId" | "principalId" | "conversationId">,
  signingSecret: string,
): SphotonSignedActionRef {
  const seal = createHmac("sha256", signingSecret)
    .update(actionSealPayload(payload, scope))
    .digest("hex");
  return { ...payload, seal };
}

export function verifyActionRef(
  ref: SphotonSignedActionRef,
  scope: Pick<SphotonExecutionScope, "tenantId" | "domainId" | "principalId" | "conversationId">,
  signingSecret: string,
  now = Date.now(),
): { valid: true } | { valid: false; reason: "expired" | "invalid_seal" } {
  if (ref.expiresAt > 0 && now > ref.expiresAt) {
    return { valid: false, reason: "expired" };
  }
  const { seal, ...payload } = ref;
  const expected = createHmac("sha256", signingSecret)
    .update(actionSealPayload(payload, scope))
    .digest("hex");
  try {
    const a = Buffer.from(seal, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { valid: false, reason: "invalid_seal" };
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: "invalid_seal" };
  }
}

function unavailableBlock(card: SphotonCardBinding, reason: string): DisplayBlock {
  const title = card.unavailableState?.title ?? "Information temporarily unavailable";
  const message = card.unavailableState?.message ?? reason;
  return {
    component: "PznFactSummary",
    props: {
      title,
      body: message,
      facts: [{ label: "Status", value: "Unavailable" }],
    },
  };
}

/**
 * Single deterministic compiler shared by draft preview, approval preview, and live customer chat.
 * Reuses verified turn tool results when present, invokes declared reads via the sfield adapter
 * on a miss, enforces approved unavailable states, and emits signed action references.
 */
export async function compileBoundCard(input: {
  card: SphotonCardBinding;
  catalog: SphotonBindingCatalog;
  scope: SphotonExecutionScope;
  sfield?: SfieldAdapter;
  verifiedTurnResults?: Record<string, unknown>;
  sampleResults?: Record<string, unknown>;
  baseBlock?: DisplayBlock;
  design?: { id: string; revision: number; name?: string; title?: string; badge?: string; body?: string };
  expectedToolContracts?: Record<string, string>;
  signingSecret: string;
  now?: number;
  actionTtlMs?: number;
  signal?: AbortSignal;
}): Promise<SphotonCompileResult> {
  const {
    card,
    catalog,
    scope,
    sfield,
    verifiedTurnResults = {},
    sampleResults = {},
    baseBlock,
    design,
    expectedToolContracts,
    signingSecret,
    signal,
  } = input;
  const now = input.now ?? Date.now();
  const actionTtlMs = input.actionTtlMs ?? 6 * 60 * 60 * 1000;
  const cardId = `card_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

  const toolsByRef = new Map(catalog.tools.map((tool) => [tool.toolRef, tool]));
  const fieldsByKey = new Map(catalog.fields.map((field) => [`${field.toolRef}::${field.outputPath}`, field]));
  const toolContracts: Record<string, string> = {};

  // 1. Check live tool contract compatibility against approved publication fingerprints.
  for (const source of Object.values(card.sources)) {
    const live = sfield?.describeTool(source.toolRef);
    const catalogTool = toolsByRef.get(source.toolRef);
    const currentFingerprint = live
      ? fingerprintToolContract(live.ref, live.inputs, live.outputs)
      : catalogTool?.contractFingerprint;
    if (!currentFingerprint) {
      return {
        status: "incompatible_contract",
        cardId,
        block: unavailableBlock(card, `Tool ${source.toolRef} is no longer available. Submit a revised design for approval.`),
        signedActions: [],
        reusedSources: [],
        invokedSources: [],
        missingRequiredFields: [],
        toolContracts,
        reason: `Tool ${source.toolRef} is unavailable.`,
      };
    }
    toolContracts[source.toolRef] = currentFingerprint;
    if (expectedToolContracts?.[source.toolRef] && expectedToolContracts[source.toolRef] !== currentFingerprint) {
      return {
        status: "incompatible_contract",
        cardId,
        block: unavailableBlock(card, `The tool contract for ${source.toolRef} changed. A revised publication must be approved.`),
        signedActions: [],
        reusedSources: [],
        invokedSources: [],
        missingRequiredFields: [],
        toolContracts,
        reason: `Tool contract drifted for ${source.toolRef}.`,
      };
    }
  }

  // 2. Resolve declared read sources: reuse verified turn result when allowed, otherwise invoke sfield.
  const slotData: Record<string, unknown> = {};
  const reusedSources: string[] = [];
  const invokedSources: string[] = [];
  const failedSources: string[] = [];

  for (const [slotName, source] of Object.entries(card.sources)) {
    const hasVerified = source.read === "reuseVerifiedTurnResult"
      && Object.prototype.hasOwnProperty.call(verifiedTurnResults, source.toolRef)
      && verifiedTurnResults[source.toolRef] !== undefined;
    if (hasVerified) {
      slotData[slotName] = verifiedTurnResults[source.toolRef];
      reusedSources.push(source.toolRef);
      continue;
    }

    if (scope.mode !== "customer_chat" && Object.prototype.hasOwnProperty.call(sampleResults, source.toolRef) && sampleResults[source.toolRef] !== undefined) {
      slotData[slotName] = sampleResults[source.toolRef];
      reusedSources.push(source.toolRef);
      continue;
    }

    if (sfield) {
      const exec = await sfield.executeRead({
        toolRef: source.toolRef,
        inputs: source.inputs ?? {},
        scope,
        signal,
      });
      if (exec.status === "succeeded") {
        slotData[slotName] = exec.output;
        invokedSources.push(source.toolRef);
      } else {
        failedSources.push(source.toolRef);
      }
    } else if (Object.prototype.hasOwnProperty.call(sampleResults, source.toolRef) && sampleResults[source.toolRef] !== undefined) {
      slotData[slotName] = sampleResults[source.toolRef];
      reusedSources.push(source.toolRef);
    } else {
      failedSources.push(source.toolRef);
    }
  }

  // 3. Extract bound fields and check required values.
  const resolvedRaw: Record<string, unknown> = {};
  const resolvedFormatted: Record<string, string> = {};
  const bindingLabels: Record<string, string> = {};
  const missingRequiredFields: string[] = [];

  for (const binding of card.bindings) {
    const parsedFrom = parseBindingSourcePath(binding.from);
    if (!parsedFrom) continue;
    const source = card.sources[parsedFrom.slot];
    const catalogField = source ? fieldsByKey.get(`${source.toolRef}::${parsedFrom.outputPath}`) : undefined;
    const raw = readPathValue(slotData[parsedFrom.slot], parsedFrom.outputPath);
    const isRequired = binding.required !== false;
    if (raw === undefined || raw === null) {
      if (isRequired) missingRequiredFields.push(binding.field);
      continue;
    }
    resolvedRaw[binding.field] = raw;
    resolvedFormatted[binding.field] = formatBoundValue(raw, binding.format ?? catalogField?.defaultFormat);
    bindingLabels[binding.field] = binding.label ?? catalogField?.label ?? binding.field;
  }

  if (missingRequiredFields.length > 0 || (failedSources.length > 0 && Object.keys(resolvedRaw).length === 0)) {
    return {
      status: "unavailable",
      cardId,
      block: unavailableBlock(
        card,
        card.unavailableState?.message ?? "Required customer data is currently unavailable for this card.",
      ),
      signedActions: [],
      reusedSources,
      invokedSources,
      missingRequiredFields,
      toolContracts,
      reason: missingRequiredFields.length > 0
        ? `Missing required bound fields: ${missingRequiredFields.join(", ")}`
        : `Failed to read required tool source(s): ${failedSources.join(", ")}`,
    };
  }

  // 4. Sign declared actions (bound to principal/tenant/domain/conversation + fixedInputs).
  const signedActions: SphotonSignedActionRef[] = (card.actions ?? []).map((action: SphotonCardAction) => {
    const payload: SphotonSignedActionPayload = {
      actionRefId: scope.mode === "customer_chat" ? `act_${randomUUID().replace(/-/g, "").slice(0, 16)}` : `preview_${action.id}`,
      cardId,
      ...(design ? { designId: design.id, designRevision: design.revision } : {}),
      actionId: action.id,
      label: action.label,
      toolRef: action.toolRef,
      resolvedInputs: { ...(action.fixedInputs ?? {}) },
      followUpInputs: [...(action.followUpInputs ?? [])],
      update: action.update,
      ...(action.resultBindings ? { resultBindings: action.resultBindings } : {}),
      issuedAt: now,
      expiresAt: scope.mode === "customer_chat" ? now + actionTtlMs : 0,
    };
    return signActionRef(payload, scope, signingSecret);
  });

  // 5. Compile into target A2UI DisplayBlock.
  if (card.component === "PznGoalProgress") {
    const firstSlot = Object.values(slotData)[0] as Partial<GoalProgress> | undefined;
    const baseGoal = baseBlock?.component === "PznGoalProgress" ? baseBlock.props.goal : undefined;
    const mergedGoal = {
      ...(baseGoal ?? {}),
      ...(firstSlot ?? {}),
      ...(resolvedRaw["goal.goalId"] !== undefined ? { goalId: resolvedRaw["goal.goalId"] } : {}),
      ...(resolvedRaw["goal.title"] !== undefined ? { title: resolvedRaw["goal.title"] } : {}),
      ...(resolvedRaw["goal.targetCents"] !== undefined ? { targetCents: resolvedRaw["goal.targetCents"] } : {}),
      ...(resolvedRaw["goal.history"] !== undefined ? { history: resolvedRaw["goal.history"] } : {}),
      ...(resolvedRaw["goal.monthlyContributionCents"] !== undefined ? { monthlyContributionCents: resolvedRaw["goal.monthlyContributionCents"] } : {}),
      ...(resolvedRaw["goal.currency"] !== undefined ? { currency: resolvedRaw["goal.currency"] } : {}),
      ...(resolvedRaw["goal.asOf"] !== undefined ? { asOf: resolvedRaw["goal.asOf"] } : {}),
    };
    const parsedGoal = goalProgressSchema.safeParse(mergedGoal);
    if (!parsedGoal.success) {
      return {
        status: "unavailable",
        cardId,
        block: unavailableBlock(card, "Goal progress data is incomplete and cannot be charted."),
        signedActions: [],
        reusedSources,
        invokedSources,
        missingRequiredFields: ["goal"],
        toolContracts,
        reason: "Merged goal payload failed goalProgressSchema validation.",
      };
    }

    const savingsAction = signedActions.find((act) =>
      act.toolRef.startsWith("goal.savings.preview@") && typeof act.resolvedInputs.extraMonthlyCents === "number");
    const extraMonthlyCents = savingsAction ? Number(savingsAction.resolvedInputs.extraMonthlyCents) : undefined;
    const canOfferSavings = Boolean(
      savingsAction
      && extraMonthlyCents
      && parsedGoal.data.monthlyContributionCents !== undefined
      && parsedGoal.data.history.at(-1)!.savedCents < parsedGoal.data.targetCents,
    );

    const goalLabel = design?.title ?? "Home down payment";
    const sharedBase = baseBlock?.component === "PznGoalProgress"
      ? {
        variant: baseBlock.props.variant,
        title: baseBlock.props.title,
        sources: baseBlock.props.sources,
        disclosures: baseBlock.props.disclosures,
      }
      : {
        variant: "expanded" as const,
        title: goalLabel,
        sources: [{ title: goalLabel, label: "sfield · goal.progress.read", version: "1.0.0", ref: "goal.progress.read@1.0.0" }],
        disclosures: ["Goal progress is read from verified account records."],
      };

    return {
      status: "compiled",
      cardId,
      block: {
        component: "PznGoalProgress",
        props: {
          ...sharedBase,
          goal: parsedGoal.data,
          ...(canOfferSavings && savingsAction && extraMonthlyCents
            ? { savingsOption: { actionId: savingsAction.actionRefId, extraMonthlyCents } }
            : {}),
        },
      },
      signedActions: canOfferSavings ? signedActions : [],
      reusedSources,
      invokedSources,
      missingRequiredFields: [],
      toolContracts,
    };
  }

  if (card.component === "PznPortfolioSnapshot") {
    const firstSlot = Object.values(slotData)[0] as Record<string, unknown> | undefined;
    const merged = {
      ...(baseBlock?.component === "PznPortfolioSnapshot" ? baseBlock.props : {}),
      ...(firstSlot ?? {}),
      ...(resolvedRaw["portfolio.totalCents"] !== undefined ? { totalCents: resolvedRaw["portfolio.totalCents"] } : {}),
      ...(resolvedRaw["portfolio.cashCents"] !== undefined ? { cashCents: resolvedRaw["portfolio.cashCents"] } : {}),
      ...(resolvedRaw["portfolio.equityCents"] !== undefined ? { equityCents: resolvedRaw["portfolio.equityCents"] } : {}),
    };
    const parsed = portfolioSnapshotSchema.safeParse(merged);
    if (!parsed.success) {
      return {
        status: "unavailable",
        cardId,
        block: unavailableBlock(card, "Portfolio snapshot data is currently unavailable."),
        signedActions: [],
        reusedSources,
        invokedSources,
        missingRequiredFields: ["portfolio"],
        toolContracts,
      };
    }
    return {
      status: "compiled",
      cardId,
      block: { component: "PznPortfolioSnapshot", props: parsed.data },
      signedActions,
      reusedSources,
      invokedSources,
      missingRequiredFields: [],
      toolContracts,
    };
  }

  // Generic domain card compilation → PznBoundWidget (works for Wealth, IT Ops, Sales RevOps, and any future domain!)
  const metrics = card.bindings
    .filter((binding) => !["title", "badge", "body", "progress"].includes(binding.field) && resolvedFormatted[binding.field] !== undefined)
    .slice(0, 6)
    .map((binding, idx) => ({
      id: `m_${idx + 1}`,
      label: bindingLabels[binding.field] ?? binding.field,
      value: resolvedFormatted[binding.field],
      subtext: binding.from.split(".data.")[0],
      tone: "default" as const,
    }));

  const progressRaw = typeof resolvedRaw.progress === "number"
    ? Math.max(0, Math.min(100, Math.round(resolvedRaw.progress)))
    : undefined;
  const primaryAction = signedActions[0];

  return {
    status: "compiled",
    cardId,
    block: {
      component: "PznBoundWidget",
      props: {
        badge: resolvedFormatted.badge ?? design?.badge ?? `${catalog.domainId} · sfield`,
        title: resolvedFormatted.title ?? design?.title ?? design?.name ?? "Bound Data Card",
        body: resolvedFormatted.body ?? design?.body ?? "Live fields bound through sphoton from sfield.",
        accentTop: true,
        metrics,
        ...(progressRaw !== undefined ? { progressLabel: bindingLabels.progress ?? "Progress", progressPercent: progressRaw, progressDisplay: `${progressRaw}%` } : {}),
        ...(primaryAction ? { ctaLabel: primaryAction.label } : {}),
      },
    },
    signedActions,
    reusedSources,
    invokedSources,
    missingRequiredFields: [],
    toolContracts,
  };
}

/**
 * Applies an action execution result back onto an existing compiled card block in place.
 */
export function applyActionResultToBlock(
  block: DisplayBlock,
  action: Pick<SphotonSignedActionPayload, "resultBindings" | "label">,
  actionOutput: unknown,
): DisplayBlock {
  if (block.component !== "PznBoundWidget") return block;
  if (!action.resultBindings?.length || !actionOutput || typeof actionOutput !== "object") return block;
  const nextProps = structuredClone(block.props);
  for (const rb of action.resultBindings) {
    const raw = readPathValue(actionOutput, rb.from);
    if (raw === undefined || raw === null) continue;
    const formatted = formatBoundValue(raw, rb.format);
    if (rb.field === "title") nextProps.title = formatted;
    else if (rb.field === "badge") nextProps.badge = formatted;
    else if (rb.field === "body") nextProps.body = formatted;
    else if (rb.field === "progress" && typeof raw === "number") {
      nextProps.progressPercent = Math.max(0, Math.min(100, Math.round(raw)));
      nextProps.progressDisplay = `${nextProps.progressPercent}%`;
    } else {
      const existing = nextProps.metrics.find((metric) => metric.id === rb.field || metric.label === rb.field);
      if (existing) {
        existing.value = formatted;
        existing.tone = "positive";
      } else if (nextProps.metrics.length < 6) {
        nextProps.metrics.push({
          id: rb.field.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "updated",
          label: rb.field,
          value: formatted,
          subtext: action.label,
          tone: "positive",
        });
      }
    }
  }
  return { component: "PznBoundWidget", props: nextProps };
}
