import { createHash } from "node:crypto";
import type {
  SmassClassification,
  SmassDomainModel,
  SmassExecutionContext,
  SmassFieldSpec,
  SmassFieldType,
  SmassToolBackedModel,
} from "./contracts";

export type SmassToolExecutor = (
  toolRef: string,
  inputs: Record<string, unknown>,
  ctx: SmassExecutionContext,
) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;

export type SmassVersionExtractor = (
  slot: string,
  payload: Record<string, unknown>,
) => Record<string, string | number>;

export type SmassSnapshotRequest = {
  modelId: string;
  ctx: SmassExecutionContext;
  /** Optional inputs forwarded to underlying tool/store reads (merged with principal/customer identifiers). */
  inputs?: Record<string, unknown>;
  /** Per-slot input overrides for tool_backed models (keyed by source slot name). */
  sourceInputs?: Record<string, Record<string, unknown>>;
  /** Projection pushdown: only materialize these logical fields (+ transitive computed dependencies). Omit for all fields. */
  requestedFields?: readonly string[];
  /** Minimum required numeric versions (e.g. `{ accountVersion: 42 }`). Bypasses stale cache and returns `stale_version_retry` if backend lags. */
  minVersions?: Record<string, number>;
  /** Optional classifications to redact from the returned data view (e.g. `["pii"]` for LLM prompts). */
  redactClassifications?: readonly SmassClassification[];
  /** Turn-scoped cache to guarantee 1x physical reads shared across CCRE, Treatment Resolver, and UI. */
  cache?: SmassTurnSnapshotCache;
  /** Tool executor used for `tool_backed` models (e.g. wrapping an `sfield` execution scope or Data Agg adapter). */
  executeTool?: SmassToolExecutor;
  /** Optional custom extractor for source version tokens. */
  extractVersions?: SmassVersionExtractor;
};

export type SmassSnapshotValidationIssue = {
  field: string;
  message: string;
};

export type SmassVirtualSnapshotOk = {
  status: "ok";
  snapshotId: string;
  modelId: string;
  modelVersion: string;
  domain: string;
  principalId: string;
  materializedAt: string;
  data: Record<string, unknown>;
  dataVersions: Record<string, string | number>;
  /** Logical fields requested (after expanding computed dependencies). */
  projectedFields: string[];
  /** Physical source slots queried during this call (empty when served from turn cache). */
  sourcesQueried: string[];
  /** Physical source slots skipped due to projection pushdown. */
  sourcesSkipped: string[];
  /** Number of physical read calls executed by this invocation (0 on turn-cache reuse). */
  sourceCalls: number;
  cacheHit: boolean;
  redactedFields: string[];
};

export type SmassVirtualSnapshotStale = {
  status: "stale_version_retry";
  modelId: string;
  modelVersion: string;
  domain: string;
  principalId: string;
  requiredVersions: Record<string, number>;
  observedVersions: Record<string, string | number>;
  sourcesQueried: string[];
  sourceCalls: number;
  message: string;
};

export type SmassVirtualSnapshotResult = SmassVirtualSnapshotOk | SmassVirtualSnapshotStale;

export class SmassSnapshotValidationError extends Error {
  readonly modelId: string;
  readonly issues: SmassSnapshotValidationIssue[];

  constructor(modelId: string, issues: SmassSnapshotValidationIssue[]) {
    super(`smass virtual snapshot validation failed for "${modelId}": ${issues.map((i) => `${i.field}: ${i.message}`).join("; ")}`);
    this.name = "SmassSnapshotValidationError";
    this.modelId = modelId;
    this.issues = issues;
  }
}

type CachedEntry = {
  snapshot: SmassVirtualSnapshotOk;
  coveredFields: Set<string>;
};

/**
 * Lightweight turn-scoped snapshot cache so multiple consumers in the same turn
 * (e.g. CCRE rule evaluation + Treatment Resolver enrichment + UI rendering)
 * reuse the exact same materialized snapshot with zero extra backend reads.
 */
export class SmassTurnSnapshotCache {
  private readonly entries = new Map<string, CachedEntry>();

  private keyFor(modelId: string, ctx: SmassExecutionContext, inputs?: Record<string, unknown>): string {
    const stableInputs = inputs ? JSON.stringify(sortObjectKeys(inputs)) : "";
    return `${ctx.tenantId}|${ctx.domainId}|${ctx.principalId}|${ctx.customerId ?? ""}|${modelId}|${stableInputs}`;
  }

  get(
    modelId: string,
    ctx: SmassExecutionContext,
    inputs: Record<string, unknown> | undefined,
    requiredFields: readonly string[],
    minVersions?: Record<string, number>,
  ): SmassVirtualSnapshotOk | undefined {
    const entry = this.entries.get(this.keyFor(modelId, ctx, inputs));
    if (!entry) return undefined;
    for (const field of requiredFields) {
      if (!entry.coveredFields.has(field)) return undefined;
    }
    if (minVersions && !satisfiesMinVersions(entry.snapshot.dataVersions, minVersions)) {
      return undefined;
    }
    return entry.snapshot;
  }

  set(
    modelId: string,
    ctx: SmassExecutionContext,
    inputs: Record<string, unknown> | undefined,
    snapshot: SmassVirtualSnapshotOk,
  ): void {
    this.entries.set(this.keyFor(modelId, ctx, inputs), {
      snapshot,
      coveredFields: new Set(snapshot.projectedFields),
    });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export function createTurnSnapshotCache(): SmassTurnSnapshotCache {
  return new SmassTurnSnapshotCache();
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortObjectKeys(record[key]);
    }
    return sorted;
  }
  return value;
}

function readDotPath(obj: unknown, dotPath: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  let cursor: unknown = obj;
  for (const segment of dotPath.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function defaultExtractVersions(slot: string, payload: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, val] of Object.entries(payload)) {
    if (typeof val !== "number" && typeof val !== "string") continue;
    if (key === "version" || key === "revision" || key === "etag") {
      out[`${slot}.${key}`] = val;
      if (!(key in out)) out[key] = val;
    } else if (/Version$/.test(key)) {
      out[key] = val;
    }
  }
  if (payload.dataVersions && typeof payload.dataVersions === "object" && !Array.isArray(payload.dataVersions)) {
    for (const [k, v] of Object.entries(payload.dataVersions as Record<string, unknown>)) {
      if (typeof v === "number" || typeof v === "string") out[k] = v;
    }
  }
  return out;
}

function parseNumericVersion(value: string | number | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const match = value.match(/(\d+(?:\.\d+)?)$/);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function satisfiesMinVersions(
  observed: Record<string, string | number>,
  minVersions: Record<string, number>,
): boolean {
  for (const [key, minVal] of Object.entries(minVersions)) {
    const current = parseNumericVersion(observed[key]);
    if (current === undefined || current < minVal) return false;
  }
  return true;
}

/**
 * Safe, zero-eval deterministic arithmetic expression evaluator for `smass` computed fields.
 * Supports: numbers, identifiers, `+`, `-`, `*`, `/`, unary `-`, parentheses,
 * and safe numeric functions `min`, `max`, `abs`, `round`, `floor`, `ceil`.
 */
type ExprToken =
  | { kind: "num"; value: number }
  | { kind: "id"; value: string }
  | { kind: "op"; value: "+" | "-" | "*" | "/" }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "comma" };

function tokenizeExpression(expr: string): ExprToken[] {
  const tokens: ExprToken[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      tokens.push({ kind: "op", value: ch });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: "comma" });
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let end = i;
      while (end < expr.length && /[0-9._]/.test(expr[end]!)) end++;
      const raw = expr.slice(i, end).replaceAll("_", "");
      const num = Number(raw);
      if (!Number.isFinite(num)) {
        throw new Error(`Invalid numeric literal "${raw}" in expression "${expr}"`);
      }
      tokens.push({ kind: "num", value: num });
      i = end;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i;
      while (end < expr.length && /[A-Za-z0-9_.$]/.test(expr[end]!)) end++;
      tokens.push({ kind: "id", value: expr.slice(i, end) });
      i = end;
      continue;
    }
    throw new Error(`Unsupported character "${ch}" in computed expression "${expr}"`);
  }
  return tokens;
}

const SAFE_MATH_FNS: Record<string, (...args: number[]) => number> = {
  min: (...args) => Math.min(...args),
  max: (...args) => Math.max(...args),
  abs: (x) => Math.abs(x),
  round: (x) => Math.round(x),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
};

export function evaluateSmassComputedExpression(
  expression: string,
  scope: Record<string, unknown>,
): number {
  const tokens = tokenizeExpression(expression);
  let pos = 0;

  const peek = (): ExprToken | undefined => tokens[pos];
  const consume = (): ExprToken => {
    const tok = tokens[pos];
    if (!tok) throw new Error(`Unexpected end of expression "${expression}"`);
    pos++;
    return tok;
  };

  const parseAddSub = (): number => {
    let left = parseMulDiv();
    while (true) {
      const next = peek();
      if (next?.kind === "op" && (next.value === "+" || next.value === "-")) {
        consume();
        const right = parseMulDiv();
        left = next.value === "+" ? left + right : left - right;
      } else {
        break;
      }
    }
    return left;
  };

  const parseMulDiv = (): number => {
    let left = parseUnary();
    while (true) {
      const next = peek();
      if (next?.kind === "op" && (next.value === "*" || next.value === "/")) {
        consume();
        const right = parseUnary();
        if (next.value === "/") {
          if (right === 0) throw new Error(`Division by zero in expression "${expression}"`);
          left = left / right;
        } else {
          left = left * right;
        }
      } else {
        break;
      }
    }
    return left;
  };

  const parseUnary = (): number => {
    const next = peek();
    if (next?.kind === "op" && next.value === "-") {
      consume();
      return -parseUnary();
    }
    if (next?.kind === "op" && next.value === "+") {
      consume();
      return parseUnary();
    }
    return parsePrimary();
  };

  const parsePrimary = (): number => {
    const tok = consume();
    if (tok.kind === "num") return tok.value;
    if (tok.kind === "lparen") {
      const val = parseAddSub();
      const closing = consume();
      if (closing.kind !== "rparen") {
        throw new Error(`Expected ")" in expression "${expression}"`);
      }
      return val;
    }
    if (tok.kind === "id") {
      if (peek()?.kind === "lparen") {
        const fn = SAFE_MATH_FNS[tok.value];
        if (!fn) throw new Error(`Unsupported function "${tok.value}" in expression "${expression}"`);
        consume(); // '('
        const args: number[] = [];
        if (peek()?.kind !== "rparen") {
          args.push(parseAddSub());
          while (peek()?.kind === "comma") {
            consume();
            args.push(parseAddSub());
          }
        }
        const closing = consume();
        if (closing.kind !== "rparen") {
          throw new Error(`Expected ")" after arguments to "${tok.value}" in "${expression}"`);
        }
        return fn(...args);
      }
      const val = tok.value.includes(".") ? readDotPath(scope, tok.value) : scope[tok.value];
      if (typeof val !== "number" || !Number.isFinite(val)) {
        throw new Error(`Computed dependency "${tok.value}" is not a finite number (got ${typeof val})`);
      }
      return val;
    }
    throw new Error(`Unexpected token in expression "${expression}"`);
  };

  const result = parseAddSub();
  if (pos < tokens.length) {
    throw new Error(`Unexpected trailing tokens in expression "${expression}"`);
  }
  return result;
}

function expandProjectedFields(
  model: SmassDomainModel,
  requestedFields?: readonly string[],
): string[] {
  const allKeys = Object.keys(model.fields);
  if (!requestedFields || requestedFields.length === 0) return allKeys;

  const included = new Set<string>();
  const visit = (fieldKey: string): void => {
    if (included.has(fieldKey)) return;
    const spec = model.fields[fieldKey];
    if (!spec) {
      throw new SmassSnapshotValidationError(model.id, [
        { field: fieldKey, message: `Requested field "${fieldKey}" is not declared on model "${model.id}".` },
      ]);
    }
    included.add(fieldKey);
    if (spec.computed) {
      for (const dep of spec.computed.dependsOn) {
        visit(dep);
      }
    }
  };

  for (const fieldKey of requestedFields) visit(fieldKey);
  return [...included];
}

function topologicalSortComputed(
  model: SmassDomainModel,
  projectedFields: readonly string[],
): string[] {
  const computedKeys = projectedFields.filter((key) => Boolean(model.fields[key]?.computed));
  const computedSet = new Set(computedKeys);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: string[] = [];

  const dfs = (key: string): void => {
    if (visited.has(key)) return;
    if (visiting.has(key)) {
      throw new SmassSnapshotValidationError(model.id, [
        { field: key, message: `Circular dependency detected in computed field "${key}".` },
      ]);
    }
    visiting.add(key);
    const deps = model.fields[key]?.computed?.dependsOn ?? [];
    for (const dep of deps) {
      if (computedSet.has(dep)) dfs(dep);
    }
    visiting.delete(key);
    visited.add(key);
    ordered.push(key);
  };

  for (const key of computedKeys) dfs(key);
  return ordered;
}

function matchesFieldType(value: unknown, expected: SmassFieldType): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
}

function validateMaterializedFields(
  model: SmassDomainModel,
  projectedFields: readonly string[],
  data: Record<string, unknown>,
): SmassSnapshotValidationIssue[] {
  const issues: SmassSnapshotValidationIssue[] = [];
  for (const key of projectedFields) {
    const spec: SmassFieldSpec | undefined = model.fields[key];
    if (!spec) continue;
    const value = data[key];
    const isRequired = Boolean(spec.required || spec.primaryKey || model.primaryKey === key);
    if (value === undefined) {
      if (isRequired) {
        issues.push({ field: key, message: `Required field "${key}" is missing.` });
      }
      continue;
    }
    if (value === null) {
      if (!spec.nullable) {
        issues.push({ field: key, message: `Field "${key}" is null but not nullable.` });
      }
      continue;
    }
    if (spec.type && !matchesFieldType(value, spec.type)) {
      issues.push({ field: key, message: `Expected type "${spec.type}", received "${Array.isArray(value) ? "array" : typeof value}".` });
      continue;
    }
    if (spec.enumValues?.length && typeof value === "string" && !spec.enumValues.includes(value)) {
      issues.push({
        field: key,
        message: `Value "${value}" is not in allowed enum [${spec.enumValues.join(", ")}].`,
      });
    }
  }
  return issues;
}

function applyProjectionAndRedaction(
  model: SmassDomainModel,
  baseSnapshot: SmassVirtualSnapshotOk,
  requestedFields: readonly string[] | undefined,
  redactClassifications: readonly SmassClassification[] | undefined,
  cacheHit: boolean,
): SmassVirtualSnapshotOk {
  const outputKeys = requestedFields && requestedFields.length > 0 ? requestedFields : baseSnapshot.projectedFields;
  const redactSet = new Set(redactClassifications ?? []);
  const data: Record<string, unknown> = {};
  const redactedFields: string[] = [];

  for (const key of outputKeys) {
    if (!(key in baseSnapshot.data)) continue;
    const cls = model.fields[key]?.classification ?? "internal";
    if (redactSet.has(cls)) {
      redactedFields.push(key);
      continue;
    }
    data[key] = baseSnapshot.data[key];
  }

  return {
    ...baseSnapshot,
    data,
    ...(cacheHit ? { sourcesQueried: [], sourceCalls: 0, cacheHit: true } : {}),
    redactedFields,
  };
}

function computeSnapshotId(
  modelId: string,
  principalId: string,
  dataVersions: Record<string, string | number>,
  data: Record<string, unknown>,
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ modelId, principalId, dataVersions: sortObjectKeys(dataVersions), data: sortObjectKeys(data) }))
    .digest("hex")
    .slice(0, 12);
  const safeModel = modelId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `snap_${safeModel}_${hash}`;
}

/**
 * Operational Virtual Data Model (VDM) Runtime for `smass`.
 *
 * Materializes a canonical, closed-schema, version-stamped virtual snapshot for a single entity:
 * 1. Projection pushdown: queries only physical sources needed for `requestedFields` (+ computed deps).
 * 2. Parallel federated fan-out across `tool_backed` sources (or single adapter read for `store_backed`).
 * 3. Safe deterministic `computed` field evaluation (topologically ordered, zero `eval`).
 * 4. Closed-schema runtime validation (types, required, nullable, strict enums).
 * 5. Turn-scoped 1x snapshot caching + `minVersions` freshness guard (`stale_version_retry`).
 */
export async function materializeVirtualSnapshot(
  model: SmassDomainModel,
  req: Omit<SmassSnapshotRequest, "modelId">,
): Promise<SmassVirtualSnapshotResult> {
  const projectedFields = expandProjectedFields(model, req.requestedFields);

  // 1. Check turn-scoped 1x cache first (automatically bypassed if `minVersions` is unsatisfied)
  if (req.cache) {
    const cached = req.cache.get(model.id, req.ctx, req.inputs, projectedFields, req.minVersions);
    if (cached) {
      return applyProjectionAndRedaction(model, cached, req.requestedFields, req.redactClassifications, true);
    }
  }

  const versionExtractor = req.extractVersions ?? defaultExtractVersions;
  const dataVersions: Record<string, string | number> = {};
  const rawValues: Record<string, unknown> = {};
  const sourcesQueried: string[] = [];
  const sourcesSkipped: string[] = [];
  let sourceCalls = 0;

  if (model.mode === "tool_backed") {
    const toolModel = model as SmassToolBackedModel;
    if (!req.executeTool) {
      throw new Error(`Cannot materialize tool_backed model "${model.id}" without an executeTool callback.`);
    }

    // Projection pushdown: find minimal set of source slots needed by projected fields
    const requiredSlots = new Set<string>();
    for (const key of projectedFields) {
      const spec = toolModel.fields[key];
      if (!spec || spec.principalKey || spec.computed || !spec.from?.includes(".")) continue;
      requiredSlots.add(spec.from.slice(0, spec.from.indexOf(".")));
    }

    const allSlots = Object.keys(toolModel.sources);
    const slotsToQuery = allSlots.filter((slot) => requiredSlots.has(slot));
    for (const slot of allSlots) {
      if (requiredSlots.has(slot)) sourcesQueried.push(slot);
      else sourcesSkipped.push(slot);
    }

    // Parallel federated fan-out across required physical tools
    const slotPayloads = new Map<string, Record<string, unknown>>();
    await Promise.all(
      slotsToQuery.map(async (slot) => {
        const sourceDef = toolModel.sources[slot]!;
        const slotInputs: Record<string, unknown> = {
          ...(req.inputs ?? {}),
          ...(req.sourceInputs?.[slot] ?? {}),
        };
        sourceCalls++;
        const payload = await req.executeTool!(sourceDef.toolRef, slotInputs, req.ctx);
        if (payload && typeof payload === "object") {
          slotPayloads.set(slot, payload);
          Object.assign(dataVersions, versionExtractor(slot, payload));
        }
      }),
    );

    // Map canonical fields from physical payloads and principal identity
    for (const key of projectedFields) {
      const spec = toolModel.fields[key]!;
      if (spec.computed) continue;
      if (spec.principalKey) {
        const fromInputs = req.inputs?.[spec.principalKey] ?? req.inputs?.[key];
        rawValues[key] = fromInputs ?? req.ctx.customerId ?? req.ctx.principalId;
        continue;
      }
      if (!spec.from?.includes(".")) continue;
      const dot = spec.from.indexOf(".");
      const slot = spec.from.slice(0, dot);
      const outputPath = spec.from.slice(dot + 1);
      const payload = slotPayloads.get(slot);
      if (payload) {
        rawValues[key] = readDotPath(payload, outputPath);
      }
    }
  } else {
    // Store-backed model: single adapter read
    sourcesQueried.push("store");
    sourceCalls = 1;
    const record = await model.source.read(req.inputs ?? {}, req.ctx);
    if (record && typeof record === "object") {
      Object.assign(dataVersions, versionExtractor("store", record));
      for (const key of projectedFields) {
        const spec = model.fields[key]!;
        if (spec.computed) continue;
        if (spec.principalKey) {
          rawValues[key] = record[key] ?? req.inputs?.[spec.principalKey] ?? req.ctx.customerId ?? req.ctx.principalId;
        } else {
          rawValues[key] = record[key];
        }
      }
    }
  }

  // 2. Enforce `minVersions` freshness guard before computing/returning stale facts
  if (req.minVersions && !satisfiesMinVersions(dataVersions, req.minVersions)) {
    return {
      status: "stale_version_retry",
      modelId: model.id,
      modelVersion: model.version,
      domain: model.domain,
      principalId: req.ctx.principalId,
      requiredVersions: { ...req.minVersions },
      observedVersions: { ...dataVersions },
      sourcesQueried,
      sourceCalls,
      message: `Observed versions (${JSON.stringify(dataVersions)}) lag behind required minVersions (${JSON.stringify(req.minVersions)}).`,
    };
  }

  // 3. Evaluate derived/computed fields once in topological dependency order
  for (const key of topologicalSortComputed(model, projectedFields)) {
    const spec = model.fields[key]!;
    if (!spec.computed) continue;
    const computedValue = evaluateSmassComputedExpression(spec.computed.expression, rawValues);
    rawValues[key] = spec.type === "integer" ? Math.round(computedValue) : computedValue;
  }

  // 4. Closed-schema runtime validation
  const validationIssues = validateMaterializedFields(model, projectedFields, rawValues);
  if (validationIssues.length > 0) {
    throw new SmassSnapshotValidationError(model.id, validationIssues);
  }

  const baseSnapshot: SmassVirtualSnapshotOk = {
    status: "ok",
    snapshotId: computeSnapshotId(model.id, req.ctx.principalId, dataVersions, rawValues),
    modelId: model.id,
    modelVersion: model.version,
    domain: model.domain,
    principalId: req.ctx.principalId,
    materializedAt: new Date().toISOString(),
    data: rawValues,
    dataVersions,
    projectedFields,
    sourcesQueried,
    sourcesSkipped,
    sourceCalls,
    cacheHit: false,
    redactedFields: [],
  };

  if (req.cache) {
    req.cache.set(model.id, req.ctx, req.inputs, baseSnapshot);
  }

  return applyProjectionAndRedaction(model, baseSnapshot, req.requestedFields, req.redactClassifications, false);
}
