/**
 * Deterministic Schema-Driven Data-to-UI Surface Stitcher for @sfield/core.
 *
 * Moves UI-to-tool data binding, formatting, array iteration, and sealed action dispatch
 * into sfield's trusted governance boundary so host app servers (like CEP) can blindly
 * render stitched UI envelopes and blindly forward action clicks back to sfield.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { JsonObject, JsonSchema, JsonValue, Principal } from "../types/common.js";
import type { PolicyPreset } from "../policy/presets.js";
import type { ToolDescription } from "../registry/registry.js";
import type { ExecutionScope, ExecutionScopeOptions } from "../runtime/execution-scope.js";
import { SFieldError } from "../errors.js";
import { canonicalize } from "../util/jcs.js";
import { newId, nowIso } from "../util/digest.js";
import { principalToBindingRoot } from "../security/identity.js";
import { parseElicitationToolError } from "../mcp/extensions.js";

export type SurfaceFormat =
  | "usd_cents"
  | "usd"
  | "number"
  | "integer"
  | "percent"
  | "percent_0_1"
  | "date"
  | "datetime"
  | "upper"
  | "lower"
  | "string";

export interface DataRefBinding {
  $ref: string;
  format?: SurfaceFormat;
  fallback?: JsonValue;
}

export interface RepeatBinding {
  $repeat: string;
  as?: string;
  template: unknown;
}

export interface InputSlotBinding {
  $input: string;
  default?: JsonValue;
}

export interface SurfaceActionSpec {
  id: string;
  label: string;
  toolRef: string;
  inputs: Record<string, unknown>;
  preset?: PolicyPreset;
}

export interface SealedSurfaceAction {
  surfaceId: string;
  actionId: string;
  label: string;
  toolRef: string;
  preset: PolicyPreset;
  /** Pre-resolved static & $ref arguments sealed at stitch time (tamper-proof). */
  resolvedInputs: JsonObject;
  /** Declared user-editable form fields allowed to be merged at dispatch time. */
  inputSlots: Record<string, { field: string; default?: JsonValue }>;
  /** HMAC-SHA256 seal binding this action to the original Principal, toolRef, and resolvedInputs. */
  seal: string;
}

export interface SurfaceSourceSpec {
  toolRef: string;
  inputs: JsonObject;
}

export interface SurfaceTemplate {
  component: string;
  props: Record<string, unknown>;
  actions?: SurfaceActionSpec[];
}

export interface DataModelSlot {
  toolRef: string;
  status: "succeeded" | "failed";
  data?: JsonValue;
  error?: { code: string; message: string };
}

export interface StitchedSurface {
  surfaceId: string;
  sfieldRunId: string;
  stitchedAt: string;
  component: string;
  props: Record<string, unknown>;
  actions: SealedSurfaceAction[];
  dataModel: Record<string, DataModelSlot>;
  bindingsResolved: number;
  schemaWarnings: string[];
}

export interface SurfaceActionDispatchResult {
  status: "succeeded" | "failed" | "pending_approval" | "input_required" | "denied";
  sfieldRunId: string | null;
  toolRef: string;
  output?: JsonValue;
  error?: { code: string; message: string };
  approvalId?: string | null;
  callId?: string | null;
  elicitation?: { elicitationId: string; message: string; requestedSchema: JsonObject };
}

export interface BindableFieldDescriptor {
  path: string;
  type: string;
  description?: string;
}

export interface BindableToolSchema {
  toolRef: string;
  id: string;
  version: string;
  effect: string;
  description: string;
  outputFields: BindableFieldDescriptor[];
  inputFields: BindableFieldDescriptor[];
}

export interface SurfaceHost {
  readonly registry: {
    list(): ToolDescription[];
    describe(ref: string): ToolDescription;
  };
  readonly executions: {
    open(opts: Omit<ExecutionScopeOptions, "principal" | "runId"> & { principal?: Principal }): Promise<ExecutionScope>;
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function isDataRef(v: unknown): v is DataRefBinding {
  return isPlainObject(v) && typeof v["$ref"] === "string" && Object.keys(v).every((k) => k === "$ref" || k === "format" || k === "fallback");
}

function isRepeat(v: unknown): v is RepeatBinding {
  return isPlainObject(v) && typeof v["$repeat"] === "string" && "template" in v;
}

function isInputSlot(v: unknown): v is InputSlotBinding {
  return isPlainObject(v) && typeof v["$input"] === "string" && Object.keys(v).every((k) => k === "$input" || k === "default");
}

/** Resolves a dot/bracket path like `holdings.data.positions[0].symbol` against a root object. */
export function resolvePath(root: Record<string, unknown>, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean);
  let cursor: unknown = root;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) return undefined;
      cursor = cursor[idx];
    } else if (typeof cursor === "object") {
      if (!Object.prototype.hasOwnProperty.call(cursor, seg)) return undefined;
      cursor = (cursor as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cursor;
}

/** Deterministic value formatter for stitched UI display values. */
export function formatSurfaceValue(value: unknown, format?: SurfaceFormat): unknown {
  if (value === undefined || value === null || !format) return value;
  switch (format) {
    case "usd_cents": {
      const n = Number(value);
      return Number.isFinite(n)
        ? `$${(n / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : value;
    }
    case "usd": {
      const n = Number(value);
      return Number.isFinite(n)
        ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : value;
    }
    case "number": {
      const n = Number(value);
      return Number.isFinite(n) ? n.toLocaleString("en-US") : value;
    }
    case "integer": {
      const n = Number(value);
      return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : value;
    }
    case "percent": {
      const n = Number(value);
      return Number.isFinite(n) ? `${Number(n.toFixed(2))}%` : value;
    }
    case "percent_0_1": {
      const n = Number(value);
      return Number.isFinite(n) ? `${Number((n * 100).toFixed(1))}%` : value;
    }
    case "date": {
      const d = new Date(String(value));
      return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
    }
    case "datetime": {
      const d = new Date(String(value));
      return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
    }
    case "upper":
      return String(value).toUpperCase();
    case "lower":
      return String(value).toLowerCase();
    case "string":
      return String(value);
  }
}

/** Flattens a closed JSON Schema into bindable dot-paths for UI Builder discovery & validation. */
export function extractSchemaFields(schema: JsonSchema | undefined, prefix = "", depth = 0): BindableFieldDescriptor[] {
  if (!schema || typeof schema !== "object" || depth > 5) return [];
  const out: BindableFieldDescriptor[] = [];
  const props = schema["properties"];
  if (props && typeof props === "object" && !Array.isArray(props)) {
    for (const [key, rawDef] of Object.entries(props as Record<string, unknown>)) {
      if (!rawDef || typeof rawDef !== "object" || Array.isArray(rawDef)) continue;
      const def = rawDef as Record<string, unknown>;
      const path = prefix ? `${prefix}.${key}` : key;
      const type = typeof def["type"] === "string" ? def["type"] : "unknown";
      const description = typeof def["description"] === "string" ? def["description"] : undefined;
      out.push({ path, type, ...(description ? { description } : {}) });
      if (type === "object" && def["properties"]) {
        out.push(...extractSchemaFields(def as JsonSchema, path, depth + 1));
      } else if (type === "array" && def["items"] && typeof def["items"] === "object" && !Array.isArray(def["items"])) {
        const items = def["items"] as JsonSchema;
        if (items["type"] === "object" && items["properties"]) {
          out.push(...extractSchemaFields(items, `${path}[]`, depth + 1));
        }
      }
    }
  }
  return out;
}

/** Checks a `$ref` path against known tool output schemas and returns any warnings. */
export function validateRefPathAgainstSchemas(
  refPath: string,
  slotSchemas: Record<string, JsonSchema | undefined>,
): string | null {
  if (refPath.startsWith("principal.") || refPath.startsWith("$item.") || refPath === "$item" || refPath === "$index") {
    return null;
  }
  const normalized = refPath.replace(/\[\d+\]/g, "[]");
  const parts = normalized.split(".");
  const slot = parts[0];
  if (!slot || !(slot in slotSchemas)) {
    return `Unknown dataModel slot "${slot ?? refPath}" in $ref "${refPath}"`;
  }
  if (parts[1] !== "data") return null;
  const schema = slotSchemas[slot];
  if (!schema) return null;
  const fieldPath = parts.slice(2).join(".");
  if (!fieldPath) return null;
  const known = new Set(extractSchemaFields(schema).map((f) => f.path));
  if (!known.has(fieldPath)) {
    return `Field "${fieldPath}" is not declared in ${slot} output schema ($ref "${refPath}")`;
  }
  return null;
}

/** Pure deterministic stitcher: resolves `$ref`, `$repeat`, and formatters against a dataModel. */
export function stitchTemplateData(
  template: unknown,
  root: Record<string, unknown>,
  opts: { slotSchemas?: Record<string, JsonSchema | undefined> } = {},
): { value: unknown; bindingsResolved: number; schemaWarnings: string[] } {
  let bindingsResolved = 0;
  const schemaWarnings: string[] = [];

  const walk = (node: unknown, scope: Record<string, unknown>): unknown => {
    if (isDataRef(node)) {
      bindingsResolved++;
      if (opts.slotSchemas) {
        const warn = validateRefPathAgainstSchemas(node.$ref, opts.slotSchemas);
        if (warn) schemaWarnings.push(warn);
      }
      const raw = resolvePath(scope, node.$ref);
      const val = raw === undefined ? node.fallback : raw;
      return formatSurfaceValue(val, node.format);
    }
    if (isRepeat(node)) {
      bindingsResolved++;
      if (opts.slotSchemas) {
        const warn = validateRefPathAgainstSchemas(node.$repeat, opts.slotSchemas);
        if (warn) schemaWarnings.push(warn);
      }
      const arr = resolvePath(scope, node.$repeat);
      if (!Array.isArray(arr)) return [];
      const itemKey = node.as?.trim() || "$item";
      return arr.map((item, idx) => walk(node.template, { ...scope, [itemKey]: item, $item: item, $index: idx }));
    }
    if (Array.isArray(node)) {
      return node.map((item) => walk(item, scope));
    }
    if (isPlainObject(node)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = walk(v, scope);
      }
      return out;
    }
    return node;
  };

  return { value: walk(template, root), bindingsResolved, schemaWarnings };
}

export class SurfaceBinderService {
  private readonly signingKey: Buffer;

  constructor(
    private readonly host: SurfaceHost,
    private readonly resolvePrincipal: (p?: Principal) => Principal,
    signingSecret?: string,
  ) {
    this.signingKey = signingSecret ? Buffer.from(signingSecret, "utf8") : randomBytes(32);
  }

  private signAction(payload: Omit<SealedSurfaceAction, "seal">, principal: Principal): string {
    const canonical = canonicalize({
      tenantId: principal.tenantId,
      subjectId: principal.subjectId,
      surfaceId: payload.surfaceId,
      actionId: payload.actionId,
      toolRef: payload.toolRef,
      preset: payload.preset,
      resolvedInputs: payload.resolvedInputs,
      inputSlots: payload.inputSlots,
    });
    return createHmac("sha256", this.signingKey).update(canonical).digest("hex");
  }

  private verifyActionSeal(action: SealedSurfaceAction, principal: Principal): boolean {
    if (!action.seal || typeof action.seal !== "string") return false;
    const expected = this.signAction(
      {
        surfaceId: action.surfaceId,
        actionId: action.actionId,
        label: action.label,
        toolRef: action.toolRef,
        preset: action.preset,
        resolvedInputs: action.resolvedInputs,
        inputSlots: action.inputSlots,
      },
      principal,
    );
    const a = Buffer.from(action.seal, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Returns all registered non-builtin sfield tools with flattened bindable output/input field paths. */
  inspectSchemas(): BindableToolSchema[] {
    return this.host.registry
      .list()
      .filter((t) => t.source !== "builtin")
      .map((t) => ({
        toolRef: t.ref,
        id: t.id,
        version: t.version,
        effect: t.policy.effect,
        description: t.description,
        outputFields: extractSchemaFields(t.outputs),
        inputFields: extractSchemaFields(t.inputs),
      }));
  }

  /**
   * Executes all declared read sources via sfield, validates `$ref` paths against closed tool
   * output schemas, deterministically stitches the template, and cryptographically seals every action.
   */
  async stitch(input: {
    principal?: Principal;
    template: SurfaceTemplate;
    sources: Record<string, SurfaceSourceSpec>;
    preset?: PolicyPreset;
    strictSchemaValidation?: boolean;
    signal?: AbortSignal;
  }): Promise<StitchedSurface> {
    const principal = this.resolvePrincipal(input.principal);
    const surfaceId = newId("surf");
    const preset: PolicyPreset = input.preset ?? "read_only";
    const sourceEntries = Object.entries(input.sources);

    const dataModel: Record<string, DataModelSlot> = {};
    const slotSchemas: Record<string, JsonSchema | undefined> = {};

    const scope = await this.host.executions.open({
      principal,
      purpose: `surface.stitch:${surfaceId}`,
      preset,
      budget: { maxToolCalls: Math.max(1, sourceEntries.length) },
    });

    try {
      for (const [slot, spec] of sourceEntries) {
        const desc = this.host.registry.describe(spec.toolRef);
        slotSchemas[slot] = desc.outputs;
        const res = await scope.registry.execute(spec.toolRef, spec.inputs, {
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (res.status === "succeeded") {
          dataModel[slot] = { toolRef: spec.toolRef, status: "succeeded", data: res.output };
        } else {
          dataModel[slot] = {
            toolRef: spec.toolRef,
            status: "failed",
            ...(res.error ? { error: { code: res.error.code, message: res.error.message } } : {}),
          };
        }
      }
    } finally {
      await scope.close().catch(() => undefined);
    }

    const root: Record<string, unknown> = {
      ...dataModel,
      principal: principalToBindingRoot(principal),
    };

    const stitchedProps = stitchTemplateData(input.template.props, root, { slotSchemas });
    const schemaWarnings = [...stitchedProps.schemaWarnings];
    let bindingsResolved = stitchedProps.bindingsResolved;

    if (input.strictSchemaValidation && schemaWarnings.length > 0) {
      throw new SFieldError("INVALID_INPUT", `Surface binding schema validation failed: ${schemaWarnings.join("; ")}`);
    }

    const sealedActions: SealedSurfaceAction[] = (input.template.actions ?? []).map((act) => {
      const resolvedInputs: JsonObject = {};
      const inputSlots: Record<string, { field: string; default?: JsonValue }> = {};
      for (const [argName, rawVal] of Object.entries(act.inputs)) {
        if (isInputSlot(rawVal)) {
          inputSlots[argName] = {
            field: rawVal.$input,
            ...(rawVal.default !== undefined ? { default: rawVal.default } : {}),
          };
        } else {
          const bound = stitchTemplateData(rawVal, root, { slotSchemas });
          bindingsResolved += bound.bindingsResolved;
          schemaWarnings.push(...bound.schemaWarnings);
          if (bound.value !== undefined) {
            resolvedInputs[argName] = bound.value as JsonValue;
          }
        }
      }
      const actPreset: PolicyPreset = act.preset ?? "supervised";
      const unsigned: Omit<SealedSurfaceAction, "seal"> = {
        surfaceId,
        actionId: act.id,
        label: act.label,
        toolRef: act.toolRef,
        preset: actPreset,
        resolvedInputs,
        inputSlots,
      };
      return {
        ...unsigned,
        seal: this.signAction(unsigned, principal),
      };
    });

    return {
      surfaceId,
      sfieldRunId: scope.id,
      stitchedAt: nowIso(),
      component: input.template.component,
      props: stitchedProps.value as Record<string, unknown>,
      actions: sealedActions,
      dataModel,
      bindingsResolved,
      schemaWarnings,
    };
  }

  /**
   * Blindly dispatches a sealed UI action submitted from the client: verifies the HMAC seal
   * and Principal match, merges declared `$input` form fields only, and executes via sfield.
   */
  async dispatchAction(input: {
    principal?: Principal;
    action: SealedSurfaceAction;
    formInputs?: Record<string, JsonValue>;
    signal?: AbortSignal;
  }): Promise<SurfaceActionDispatchResult> {
    const principal = this.resolvePrincipal(input.principal);
    if (!this.verifyActionSeal(input.action, principal)) {
      return {
        status: "denied",
        sfieldRunId: null,
        toolRef: input.action.toolRef,
        error: { code: "INVALID_ACTION_SEAL", message: "Sealed surface action failed integrity or principal verification." },
      };
    }

    const mergedInputs: JsonObject = { ...input.action.resolvedInputs };
    const form = input.formInputs ?? {};
    for (const [argName, slot] of Object.entries(input.action.inputSlots)) {
      if (Object.prototype.hasOwnProperty.call(form, slot.field) && form[slot.field] !== undefined) {
        mergedInputs[argName] = form[slot.field]!;
      } else if (slot.default !== undefined) {
        mergedInputs[argName] = slot.default;
      }
    }

    let scope: ExecutionScope | undefined;
    let suspended = false;
    try {
      scope = await this.host.executions.open({
        principal,
        purpose: `surface.action:${input.action.surfaceId}:${input.action.actionId}`,
        preset: input.action.preset,
        budget: { maxToolCalls: 1 },
      });

      const res = await scope.registry.execute(input.action.toolRef, mergedInputs, {
        ...(input.signal ? { signal: input.signal } : {}),
      });

      const elicited = parseElicitationToolError(res.error);
      if (elicited) {
        return {
          status: "input_required",
          sfieldRunId: scope.id,
          toolRef: input.action.toolRef,
          elicitation: {
            elicitationId: elicited.elicitationId,
            message: elicited.message,
            requestedSchema: elicited.requestedSchema,
          },
        };
      }

      return {
        status: res.status === "succeeded" ? "succeeded" : "failed",
        sfieldRunId: scope.id,
        toolRef: input.action.toolRef,
        ...(res.output !== undefined ? { output: res.output } : {}),
        ...(res.error ? { error: { code: res.error.code, message: res.error.message } } : {}),
      };
    } catch (e) {
      if (e instanceof SFieldError && e.code === "APPROVAL_REQUIRED" && scope) {
        await scope.suspend();
        suspended = true;
        const details = (e.details ?? {}) as { approvalId?: string; callId?: string };
        return {
          status: "pending_approval",
          sfieldRunId: scope.id,
          toolRef: input.action.toolRef,
          approvalId: details.approvalId ?? null,
          callId: details.callId ?? e.callId ?? null,
          error: { code: e.code, message: e.message },
        };
      }
      if (e instanceof SFieldError) {
        return {
          status: "denied",
          sfieldRunId: scope?.id ?? null,
          toolRef: input.action.toolRef,
          error: { code: e.code, message: e.message },
        };
      }
      return {
        status: "failed",
        sfieldRunId: scope?.id ?? null,
        toolRef: input.action.toolRef,
        error: { code: "ACTION_FAILED", message: e instanceof Error ? e.message : "Surface action failed" },
      };
    } finally {
      if (scope && !suspended) {
        await scope.close().catch(() => undefined);
      }
    }
  }
}
