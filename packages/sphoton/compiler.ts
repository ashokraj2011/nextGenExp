import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { SfieldAdapter } from "./adapter";
import {
  canonicalStableJson,
  parseBindingSourcePath,
  type SphotonBindingCatalog,
  type SphotonBlock,
  type SphotonCardAction,
  type SphotonCardBinding,
  type SphotonExecutionScope,
  type SphotonSignedActionPayload,
  type SphotonSignedActionRef,
} from "./contracts";
import { fingerprintToolContract } from "./fingerprint";
import { formatBoundValue, type SphotonComponentRegistry } from "./registry";

export type SphotonCompileResult<TBlock extends SphotonBlock = SphotonBlock> = {
  status: "compiled" | "unavailable" | "incompatible_contract";
  cardId: string;
  block: TBlock;
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

function actionSealPayload(
  payload: SphotonSignedActionPayload,
  scope: Pick<SphotonExecutionScope, "tenantId" | "domainId" | "principalId" | "conversationId">,
): string {
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

function defaultUnavailableBlock(card: SphotonCardBinding, reason: string): SphotonBlock {
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

function defaultGenericCardBlock(input: {
  card: SphotonCardBinding;
  catalog: SphotonBindingCatalog;
  resolvedRaw: Record<string, unknown>;
  resolvedFormatted: Record<string, string>;
  bindingLabels: Record<string, string>;
  signedActions: SphotonSignedActionRef[];
  design?: { id: string; revision: number; name?: string; title?: string; badge?: string; body?: string };
}): SphotonBlock {
  const { card, catalog, resolvedRaw, resolvedFormatted, bindingLabels, signedActions, design } = input;
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
    component: card.component,
    props: {
      badge: resolvedFormatted.badge ?? design?.badge ?? `${catalog.domainId} · sfield`,
      title: resolvedFormatted.title ?? design?.title ?? design?.name ?? "Bound Data Card",
      body: resolvedFormatted.body ?? design?.body ?? "Live fields bound through sphoton from sfield.",
      accentTop: true,
      metrics,
      ...(progressRaw !== undefined ? { progressLabel: bindingLabels.progress ?? "Progress", progressPercent: progressRaw, progressDisplay: `${progressRaw}%` } : {}),
      ...(primaryAction ? { ctaLabel: primaryAction.label } : {}),
    },
  };
}

/**
 * Single deterministic compiler shared by draft preview, approval preview, and live customer chat.
 * Completely domain-agnostic: delegates specialized component compilation to `registry`.
 */
export async function compileBoundCard<TBlock extends SphotonBlock = SphotonBlock>(input: {
  card: SphotonCardBinding;
  catalog: SphotonBindingCatalog;
  scope: SphotonExecutionScope;
  registry?: SphotonComponentRegistry;
  sfield?: SfieldAdapter;
  verifiedTurnResults?: Record<string, unknown>;
  sampleResults?: Record<string, unknown>;
  baseBlock?: SphotonBlock;
  design?: { id: string; revision: number; name?: string; title?: string; badge?: string; body?: string };
  expectedToolContracts?: Record<string, string>;
  signingSecret: string;
  now?: number;
  actionTtlMs?: number;
  signal?: AbortSignal;
}): Promise<SphotonCompileResult<TBlock>> {
  const {
    card,
    catalog,
    scope,
    registry,
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
  const unavailableBlock = (reason: string) => defaultUnavailableBlock(card, reason);

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
        block: unavailableBlock(`Tool ${source.toolRef} is no longer available. Submit a revised design for approval.`) as TBlock,
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
        block: unavailableBlock(`The tool contract for ${source.toolRef} changed. A revised publication must be approved.`) as TBlock,
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
        card.unavailableState?.message ?? "Required customer data is currently unavailable for this card.",
      ) as TBlock,
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

  // 5. Compile via pluggable component registry (or generic fallback card).
  const registered = registry?.get(card.component);
  if (registered?.compile) {
    const compiled = registered.compile({
      card,
      catalog,
      slotData,
      resolvedRaw,
      resolvedFormatted,
      bindingLabels,
      signedActions,
      baseBlock,
      design,
      unavailableBlock,
    });
    if (compiled.status === "unavailable") {
      return {
        status: "unavailable",
        cardId,
        block: compiled.block as TBlock,
        signedActions: [],
        reusedSources,
        invokedSources,
        missingRequiredFields: compiled.missingRequiredFields ?? [],
        toolContracts,
        reason: compiled.reason,
      };
    }
    return {
      status: "compiled",
      cardId,
      block: compiled.block as TBlock,
      signedActions: compiled.signedActions ?? signedActions,
      reusedSources,
      invokedSources,
      missingRequiredFields: [],
      toolContracts,
    };
  }

  return {
    status: "compiled",
    cardId,
    block: defaultGenericCardBlock({
      card,
      catalog,
      resolvedRaw,
      resolvedFormatted,
      bindingLabels,
      signedActions,
      design,
    }) as TBlock,
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
export function applyActionResultToBlock<TBlock extends SphotonBlock>(
  block: TBlock,
  action: Pick<SphotonSignedActionPayload, "resultBindings" | "label">,
  actionOutput: unknown,
  registry?: SphotonComponentRegistry,
): TBlock {
  const registered = registry?.get(block.component);
  if (registered?.applyActionResult) {
    return registered.applyActionResult(block, action, actionOutput) as TBlock;
  }
  if (!action.resultBindings?.length || !actionOutput || typeof actionOutput !== "object") return block;
  const nextProps = structuredClone(block.props);
  const metrics = Array.isArray(nextProps.metrics) ? (nextProps.metrics as Array<Record<string, unknown>>) : undefined;
  for (const rb of action.resultBindings) {
    const raw = readPathValue(actionOutput, rb.from);
    if (raw === undefined || raw === null) continue;
    const formatted = formatBoundValue(raw, rb.format);
    if (rb.field === "title") nextProps.title = formatted;
    else if (rb.field === "badge") nextProps.badge = formatted;
    else if (rb.field === "body") nextProps.body = formatted;
    else if (rb.field === "progress" && typeof raw === "number") {
      const pct = Math.max(0, Math.min(100, Math.round(raw)));
      nextProps.progressPercent = pct;
      nextProps.progressDisplay = `${pct}%`;
    } else if (metrics) {
      const existing = metrics.find((metric) => metric.id === rb.field || metric.label === rb.field);
      if (existing) {
        existing.value = formatted;
        existing.tone = "positive";
      } else if (metrics.length < 6) {
        metrics.push({
          id: rb.field.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "updated",
          label: rb.field,
          value: formatted,
          subtext: action.label,
          tone: "positive",
        });
      }
    }
  }
  return { ...block, props: nextProps };
}
