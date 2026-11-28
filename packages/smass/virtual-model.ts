import { createHash } from "node:crypto";
import type {
  SmassAggregateFilterSpec,
  SmassAggregateSpec,
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
  /** Optional resolver for cross-entity rollup aggregates (`aggregate.targetModelId`), wired automatically by SmassDomainRegistry. */
  resolveRelatedModel?: (targetModelId: string) => Promise<Record<string, unknown>[]>;
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
  /** Populated when the model uses `unnest` to normalize a 1:N nested JSON array (or 1:1 nested object) into relational rows. */
  rows?: Record<string, unknown>[];
  rowCount?: number;
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
  for (const rawSegment of dotPath.split(".").filter(Boolean)) {
    if (!cursor || typeof cursor !== "object") return undefined;
    const idxMatch = rawSegment.match(/^(.+?)\[(-?\d+)\]$/);
    if (idxMatch) {
      const prop = idxMatch[1]!;
      const index = Number(idxMatch[2]);
      const arr = (cursor as Record<string, unknown>)[prop];
      if (!Array.isArray(arr)) return undefined;
      const resolvedIdx = index < 0 ? arr.length + index : index;
      cursor = resolvedIdx >= 0 && resolvedIdx < arr.length ? arr[resolvedIdx] : undefined;
    } else {
      cursor = (cursor as Record<string, unknown>)[rawSegment];
    }
  }
  return cursor;
}

/**
 * Recursively flattens a nested JSON record into a single-level key/value map
 * (useful for flat UI bindings, rule engines, and tabular exports).
 */
export function flattenNestedRecord(
  record: Record<string, unknown>,
  separator = "_",
  prefix = "",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const nextKey = prefix ? `${prefix}${separator}${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flattenNestedRecord(value as Record<string, unknown>, separator, nextKey));
    } else {
      out[nextKey] = value;
    }
  }
  return out;
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
 * Safe, zero-eval deterministic expression evaluator for `smass` derived columns.
 * Supports:
 * - Numbers, strings ("high_cash"), booleans (true/false), null
 * - Arithmetic (+ - * /), string concatenation (+), comparisons (== != > >= < <=), logical (&& || !), ternary (? :)
 * - Functions (case-insensitive): IF(cond, a, b), COALESCE(a, b, ...), CONCAT(...), UPPER, LOWER, LEN, MIN, MAX, ABS, ROUND, FLOOR, CEIL
 */
type ExprValue = number | string | boolean | null | undefined;

type ExprToken =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "id"; value: string }
  | { kind: "op"; value: "+" | "-" | "*" | "/" | "==" | "!=" | ">=" | "<=" | ">" | "<" | "&&" | "||" | "!" }
  | { kind: "qmark" }
  | { kind: "colon" }
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
    const two = expr.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === ">=" || two === "<=" || two === "&&" || two === "||") {
      tokens.push({ kind: "op", value: two });
      i += 2;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === ">" || ch === "<" || ch === "!") {
      tokens.push({ kind: "op", value: ch });
      i++;
      continue;
    }
    if (ch === "?") {
      tokens.push({ kind: "qmark" });
      i++;
      continue;
    }
    if (ch === ":") {
      tokens.push({ kind: "colon" });
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
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let out = "";
      while (j < expr.length && expr[j] !== quote) {
        if (expr[j] === "\\" && j + 1 < expr.length) {
          out += expr[j + 1];
          j += 2;
        } else {
          out += expr[j];
          j++;
        }
      }
      if (j >= expr.length) throw new Error(`Unterminated string literal in expression "${expr}"`);
      tokens.push({ kind: "str", value: out });
      i = j + 1;
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

function asNumber(val: ExprValue, expr: string): number {
  if (typeof val !== "number" || !Number.isFinite(val)) {
    throw new Error(`Expected numeric value in expression "${expr}" (got ${typeof val})`);
  }
  return val;
}

const SAFE_EXPR_FNS: Record<string, (args: ExprValue[], expr: string) => ExprValue> = {
  if: (args) => (Boolean(args[0]) ? args[1] : args[2]),
  coalesce: (args) => args.find((v) => v !== null && v !== undefined) ?? null,
  concat: (args) => args.map((v) => (v === null || v === undefined ? "" : String(v))).join(""),
  upper: (args) => String(args[0] ?? "").toUpperCase(),
  lower: (args) => String(args[0] ?? "").toLowerCase(),
  len: (args) => String(args[0] ?? "").length,
  min: (args, expr) => Math.min(...args.map((a) => asNumber(a, expr))),
  max: (args, expr) => Math.max(...args.map((a) => asNumber(a, expr))),
  abs: (args, expr) => Math.abs(asNumber(args[0], expr)),
  round: (args, expr) => Math.round(asNumber(args[0], expr)),
  floor: (args, expr) => Math.floor(asNumber(args[0], expr)),
  ceil: (args, expr) => Math.ceil(asNumber(args[0], expr)),
};

export function evaluateSmassComputedExpression(
  expression: string,
  scope: Record<string, unknown>,
): number | string | boolean | null {
  const tokens = tokenizeExpression(expression);
  let pos = 0;

  const peek = (): ExprToken | undefined => tokens[pos];
  const consume = (): ExprToken => {
    const tok = tokens[pos];
    if (!tok) throw new Error(`Unexpected end of expression "${expression}"`);
    pos++;
    return tok;
  };

  const parseTernary = (): ExprValue => {
    const cond = parseOr();
    if (peek()?.kind === "qmark") {
      consume();
      const thenVal = parseTernary();
      const colon = consume();
      if (colon.kind !== "colon") throw new Error(`Expected ":" in ternary expression "${expression}"`);
      const elseVal = parseTernary();
      return Boolean(cond) ? thenVal : elseVal;
    }
    return cond;
  };

  const parseOr = (): ExprValue => {
    let left = parseAnd();
    while (peek()?.kind === "op" && (peek() as { value: string }).value === "||") {
      consume();
      const right = parseAnd();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  };

  const parseAnd = (): ExprValue => {
    let left = parseEquality();
    while (peek()?.kind === "op" && (peek() as { value: string }).value === "&&") {
      consume();
      const right = parseEquality();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  };

  const parseEquality = (): ExprValue => {
    let left = parseRelational();
    while (true) {
      const next = peek();
      if (next?.kind === "op" && (next.value === "==" || next.value === "!=")) {
        consume();
        const right = parseRelational();
        left = next.value === "==" ? left === right : left !== right;
      } else {
        break;
      }
    }
    return left;
  };

  const parseRelational = (): ExprValue => {
    let left = parseAddSub();
    while (true) {
      const next = peek();
      if (next?.kind === "op" && (next.value === ">" || next.value === ">=" || next.value === "<" || next.value === "<=")) {
        consume();
        const right = parseAddSub();
        const l = asNumber(left, expression);
        const r = asNumber(right, expression);
        if (next.value === ">") left = l > r;
        else if (next.value === ">=") left = l >= r;
        else if (next.value === "<") left = l < r;
        else left = l <= r;
      } else {
        break;
      }
    }
    return left;
  };

  const parseAddSub = (): ExprValue => {
    let left = parseMulDiv();
    while (true) {
      const next = peek();
      if (next?.kind === "op" && (next.value === "+" || next.value === "-")) {
        consume();
        const right = parseMulDiv();
        if (next.value === "+" && (typeof left === "string" || typeof right === "string")) {
          left = `${left ?? ""}${right ?? ""}`;
        } else {
          const l = asNumber(left, expression);
          const r = asNumber(right, expression);
          left = next.value === "+" ? l + r : l - r;
        }
      } else {
        break;
      }
    }
    return left;
  };

  const parseMulDiv = (): ExprValue => {
    let left = parseUnary();
    while (true) {
      const next = peek();
      if (next?.kind === "op" && (next.value === "*" || next.value === "/")) {
        consume();
        const right = parseUnary();
        const l = asNumber(left, expression);
        const r = asNumber(right, expression);
        if (next.value === "/") {
          if (r === 0) throw new Error(`Division by zero in expression "${expression}"`);
          left = l / r;
        } else {
          left = l * r;
        }
      } else {
        break;
      }
    }
    return left;
  };

  const parseUnary = (): ExprValue => {
    const next = peek();
    if (next?.kind === "op" && next.value === "-") {
      consume();
      return -asNumber(parseUnary(), expression);
    }
    if (next?.kind === "op" && next.value === "+") {
      consume();
      return asNumber(parseUnary(), expression);
    }
    if (next?.kind === "op" && next.value === "!") {
      consume();
      return !Boolean(parseUnary());
    }
    return parsePrimary();
  };

  const parsePrimary = (): ExprValue => {
    const tok = consume();
    if (tok.kind === "num") return tok.value;
    if (tok.kind === "str") return tok.value;
    if (tok.kind === "lparen") {
      const val = parseTernary();
      const closing = consume();
      if (closing.kind !== "rparen") {
        throw new Error(`Expected ")" in expression "${expression}"`);
      }
      return val;
    }
    if (tok.kind === "id") {
      if (peek()?.kind === "lparen") {
        const fn = SAFE_EXPR_FNS[tok.value.toLowerCase()];
        if (!fn) throw new Error(`Unsupported function "${tok.value}" in expression "${expression}"`);
        consume(); // '('
        const args: ExprValue[] = [];
        if (peek()?.kind !== "rparen") {
          args.push(parseTernary());
          while (peek()?.kind === "comma") {
            consume();
            args.push(parseTernary());
          }
        }
        const closing = consume();
        if (closing.kind !== "rparen") {
          throw new Error(`Expected ")" after arguments to "${tok.value}" in "${expression}"`);
        }
        return fn(args, expression);
      }
      if (tok.value === "true") return true;
      if (tok.value === "false") return false;
      if (tok.value === "null") return null;
      const val = tok.value.includes(".") ? readDotPath(scope, tok.value) : scope[tok.value];
      if (val === undefined || val === null) return val as null | undefined;
      if (typeof val === "number" || typeof val === "string" || typeof val === "boolean") return val;
      throw new Error(`Computed dependency "${tok.value}" has unsupported runtime type "${typeof val}"`);
    }
    throw new Error(`Unexpected token in expression "${expression}"`);
  };

  const result = parseTernary();
  if (pos < tokens.length) {
    throw new Error(`Unexpected trailing tokens in expression "${expression}"`);
  }
  return result === undefined ? null : result;
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
    if (spec.aggregate) {
      if (spec.aggregate.sourceField) visit(spec.aggregate.sourceField);
      for (const dep of spec.aggregate.sourceFields ?? []) {
        visit(dep);
      }
    }
  };

  for (const fieldKey of requestedFields) visit(fieldKey);
  return [...included];
}

function matchesAggregateFilter(item: unknown, filter: SmassAggregateFilterSpec): boolean {
  const actual = readDotPath(item, filter.field);
  const expected = filter.value;
  switch (filter.op) {
    case "==":
      return actual === expected;
    case "!=":
      return actual !== expected;
    case ">":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case ">=":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "<":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "<=":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "contains":
      return typeof actual === "string" && actual.toLowerCase().includes(String(expected).toLowerCase());
  }
}

/**
 * Deterministic aggregate evaluator for `smass` virtual models.
 * Supports:
 * - Array aggregation (`sourceField` + optional `itemField` + optional `where` filter)
 * - Cross-entity rollup aggregation (`targetModelId` + `relatedRows` + optional `itemField` + optional `where` filter)
 * - Multi-column scalar aggregation (`sourceFields`)
 */
export function evaluateSmassAggregate(
  spec: SmassAggregateSpec,
  scope: Record<string, unknown>,
  relatedRows?: readonly Record<string, unknown>[],
): unknown {
  let values: unknown[] = [];

  if (spec.targetModelId && relatedRows) {
    const filtered = spec.where ? relatedRows.filter((row) => matchesAggregateFilter(row, spec.where!)) : relatedRows;
    values = spec.itemField
      ? filtered.map((item) => readDotPath(item, spec.itemField!)).filter((v) => v !== undefined && v !== null)
      : filtered.filter((v) => v !== undefined && v !== null);
  } else if (spec.sourceField) {
    const raw = scope[spec.sourceField];
    if (Array.isArray(raw)) {
      const filtered = spec.where ? raw.filter((item) => matchesAggregateFilter(item, spec.where!)) : raw;
      values = spec.itemField
        ? filtered.map((item) => readDotPath(item, spec.itemField!)).filter((v) => v !== undefined && v !== null)
        : filtered.filter((v) => v !== undefined && v !== null);
    } else if (raw !== undefined && raw !== null) {
      values = [raw];
    }
  } else if (spec.sourceFields?.length) {
    values = spec.sourceFields
      .map((key) => scope[key])
      .filter((v) => v !== undefined && v !== null);
  }

  switch (spec.op) {
    case "count":
      return values.length;
    case "first":
      return values.length > 0 ? values[0] : null;
    case "last":
      return values.length > 0 ? values[values.length - 1] : null;
    case "sum":
    case "avg":
    case "min":
    case "max": {
      const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (nums.length === 0) return 0;
      if (spec.op === "sum") return nums.reduce((acc, n) => acc + n, 0);
      if (spec.op === "avg") return nums.reduce((acc, n) => acc + n, 0) / nums.length;
      if (spec.op === "min") return Math.min(...nums);
      return Math.max(...nums);
    }
  }
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

function projectRow(
  model: SmassDomainModel,
  row: Record<string, unknown>,
  outputKeys: readonly string[],
  redactSet: ReadonlySet<SmassClassification>,
  redactedCollector: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of outputKeys) {
    if (!(key in row)) continue;
    const cls = model.fields[key]?.classification ?? "internal";
    if (redactSet.has(cls)) {
      redactedCollector.add(key);
      continue;
    }
    out[key] = row[key];
  }
  return out;
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
  const redactedSet = new Set<string>();
  const data = projectRow(model, baseSnapshot.data, outputKeys, redactSet, redactedSet);
  const rows = baseSnapshot.rows
    ? baseSnapshot.rows.map((r) => projectRow(model, r, outputKeys, redactSet, redactedSet))
    : undefined;

  return {
    ...baseSnapshot,
    data,
    ...(rows ? { rows, rowCount: rows.length } : {}),
    ...(cacheHit ? { sourcesQueried: [], sourceCalls: 0, cacheHit: true } : {}),
    redactedFields: [...redactedSet],
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

    // Projection pushdown: find minimal set of source slots needed by projected fields (+ unnest source if any)
    const requiredSlots = new Set<string>();
    if (toolModel.unnest) requiredSlots.add(toolModel.unnest.slot);
    for (const key of projectedFields) {
      const spec = toolModel.fields[key];
      if (!spec || spec.principalKey || spec.computed || spec.aggregate || !spec.from?.includes(".")) continue;
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

    // Relational unnesting mode: normalize a 1:N nested JSON array (or 1:1 nested object) into typed child rows
    if (toolModel.unnest) {
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

      const { slot: unnestSlot, path: unnestPath, indexField } = toolModel.unnest;
      const unnestRoot = slotPayloads.get(unnestSlot);
      const rawTarget = unnestRoot ? readDotPath(unnestRoot, unnestPath) : undefined;
      const items: unknown[] = Array.isArray(rawTarget)
        ? rawTarget
        : rawTarget && typeof rawTarget === "object"
          ? [rawTarget]
          : [];

      const computedOrder = topologicalSortComputed(model, projectedFields);
      const arrayPrefix = `${unnestPath}[].`;
      const objectPrefix = `${unnestPath}.`;
      const rows: Record<string, unknown>[] = [];

      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const row: Record<string, unknown> = {};

        for (const key of projectedFields) {
          const spec = toolModel.fields[key]!;
          if (spec.computed || spec.aggregate) continue;
          if (indexField && key === indexField) {
            row[key] = idx;
            continue;
          }
          if (spec.principalKey) {
            const fromInputs = req.inputs?.[spec.principalKey] ?? req.inputs?.[key];
            row[key] = fromInputs ?? req.ctx.customerId ?? req.ctx.principalId;
            continue;
          }
          if (!spec.from?.includes(".")) continue;
          const dot = spec.from.indexOf(".");
          const slot = spec.from.slice(0, dot);
          const outputPath = spec.from.slice(dot + 1);
          if (slot === unnestSlot && outputPath.startsWith(arrayPrefix)) {
            row[key] = readDotPath(item, outputPath.slice(arrayPrefix.length));
          } else if (slot === unnestSlot && outputPath.startsWith(objectPrefix)) {
            row[key] = readDotPath(item, outputPath.slice(objectPrefix.length));
          } else if (slot === unnestSlot && outputPath === unnestPath) {
            row[key] = item;
          } else {
            const payload = slotPayloads.get(slot);
            if (payload) row[key] = readDotPath(payload, outputPath);
          }
        }

        for (const key of projectedFields) {
          const spec = toolModel.fields[key];
          if (!spec?.aggregate) continue;
          const relatedRows =
            spec.aggregate.targetModelId && req.resolveRelatedModel
              ? await req.resolveRelatedModel(spec.aggregate.targetModelId)
              : undefined;
          const aggValue = evaluateSmassAggregate(spec.aggregate, row, relatedRows);
          row[key] = spec.type === "integer" && typeof aggValue === "number" ? Math.round(aggValue) : aggValue;
        }
        for (const key of computedOrder) {
          const spec = toolModel.fields[key]!;
          if (!spec.computed) continue;
          const computedValue = evaluateSmassComputedExpression(spec.computed.expression, row);
          row[key] = spec.type === "integer" && typeof computedValue === "number" ? Math.round(computedValue) : computedValue;
        }

        const rowIssues = validateMaterializedFields(model, projectedFields, row);
        if (rowIssues.length > 0) {
          throw new SmassSnapshotValidationError(model.id, rowIssues);
        }
        rows.push(row);
      }

      const baseSnapshot: SmassVirtualSnapshotOk = {
        status: "ok",
        snapshotId: computeSnapshotId(model.id, req.ctx.principalId, dataVersions, { rows }),
        modelId: model.id,
        modelVersion: model.version,
        domain: model.domain,
        principalId: req.ctx.principalId,
        materializedAt: new Date().toISOString(),
        data: rows[0] ?? {},
        rows,
        rowCount: rows.length,
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

    // Map canonical fields from physical payloads and principal identity
    for (const key of projectedFields) {
      const spec = toolModel.fields[key]!;
      if (spec.computed || spec.aggregate) continue;
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
        if (spec.computed || spec.aggregate) continue;
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

  // 3a. Evaluate aggregate columns before derived expressions (including cross-entity rollups via `resolveRelatedModel`)
  const relatedCache = new Map<string, Record<string, unknown>[]>();
  for (const key of projectedFields) {
    const spec = model.fields[key];
    if (!spec?.aggregate) continue;
    let relatedRows: Record<string, unknown>[] | undefined;
    if (spec.aggregate.targetModelId && req.resolveRelatedModel) {
      if (!relatedCache.has(spec.aggregate.targetModelId)) {
        relatedCache.set(spec.aggregate.targetModelId, await req.resolveRelatedModel(spec.aggregate.targetModelId));
      }
      relatedRows = relatedCache.get(spec.aggregate.targetModelId);
    }
    const aggValue = evaluateSmassAggregate(spec.aggregate, rawValues, relatedRows);
    rawValues[key] = spec.type === "integer" && typeof aggValue === "number" ? Math.round(aggValue) : aggValue;
  }

  // 3b. Evaluate derived/computed fields once in topological dependency order
  for (const key of topologicalSortComputed(model, projectedFields)) {
    const spec = model.fields[key]!;
    if (!spec.computed) continue;
    const computedValue = evaluateSmassComputedExpression(spec.computed.expression, rawValues);
    rawValues[key] = spec.type === "integer" && typeof computedValue === "number" ? Math.round(computedValue) : computedValue;
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
