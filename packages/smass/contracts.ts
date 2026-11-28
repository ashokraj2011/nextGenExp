import { z } from "zod";

export const smassFieldTypeSchema = z.enum(["string", "number", "integer", "boolean", "array", "object"]);
export type SmassFieldType = z.infer<typeof smassFieldTypeSchema>;

export const smassFieldFormatSchema = z.enum([
  "currency_cents",
  "currency",
  "percent",
  "month",
  "date",
  "number",
  "text",
  "series",
]);
export type SmassFieldFormat = z.infer<typeof smassFieldFormatSchema>;

export const smassClassificationSchema = z.enum(["public", "internal", "confidential", "pii"]);
export type SmassClassification = z.infer<typeof smassClassificationSchema>;

export const smassToolRefSchema = z.string().regex(/^[a-z][a-z0-9._-]{1,80}@\d+\.\d+\.\d+$/);

export type SmassExecutionContext = {
  tenantId: string;
  domainId: string;
  principalId: string;
  customerId?: string;
  signal?: AbortSignal;
};

export type SmassToolDescriptorLike = {
  ref: string;
  id: string;
  version: string;
  description?: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
};

export type SmassFieldSpec = {
  /** Required for store-backed models; optional for tool-backed models (inferred from sfield tool output schema). */
  type?: SmassFieldType;
  /** For tool-backed models: `<sourceSlot>.<outputPath>` (e.g. `goal.targetCents`). Defaults to field key for store-backed models. */
  from?: string;
  label: string;
  group?: string;
  description?: string;
  format?: SmassFieldFormat;
  supportedFormats?: SmassFieldFormat[];
  classification?: SmassClassification;
  required?: boolean;
  writable?: boolean;
  exposed?: boolean;
  legacyBindingKey?: string;
};

export type SmassActionParamSpec = {
  type: SmassFieldType;
  required?: boolean;
  description?: string;
};

export type SmassActionSpec = {
  id: string;
  /** Versioned sfield tool ref (e.g. `goal.savings.preview@1.0.0`). */
  toolRef: string;
  label: string;
  description?: string;
  effect?: "read" | "write";
  classification?: SmassClassification;
  inputs?: Record<string, SmassActionParamSpec>;
  outputs?: Record<string, SmassActionParamSpec>;
  fixedInputFields?: Record<string, SmassFieldType>;
  followUpInputFields?: string[];
  defaultUpdate?: "originalCard" | "newTurn";
  /** Handler used when this action is store-backed and compiled into an sfield tool by smass. */
  handler?: (inputs: Record<string, unknown>, ctx: SmassExecutionContext) => Promise<unknown> | unknown;
};

export type SmassDataSource<TRecord = Record<string, unknown>> = {
  read: (inputs: Record<string, unknown>, ctx: SmassExecutionContext) => Promise<TRecord | null> | TRecord | null;
  list?: (ctx: SmassExecutionContext) => Promise<TRecord[]> | TRecord[];
  update?: (id: string, patch: Record<string, unknown>, ctx: SmassExecutionContext) => Promise<TRecord | null> | TRecord | null;
};

/**
 * Mode 1: Tool-backed domain model (Brownfield / Federated).
 * Composes a canonical domain entity directly from tools already registered in sfield.
 */
export type SmassToolBackedModel = {
  mode: "tool_backed";
  id: string;
  version: string;
  domain: string;
  label: string;
  description?: string;
  sources: Record<string, { toolRef: string; description?: string }>;
  fields: Record<string, SmassFieldSpec>;
  actions?: SmassActionSpec[];
};

/**
 * Mode 2: Store-backed domain model (Greenfield / Local or Adapter-backed).
 * Declares fields + DataSource once and compiles into closed-schema sfield tools automatically.
 */
export type SmassStoreBackedModel<TRecord = Record<string, unknown>> = {
  mode: "store_backed";
  id: string;
  version: string;
  domain: string;
  label: string;
  description?: string;
  primaryKey: string;
  /** Versioned tool ref emitted for reading one entity (defaults to `<id>.read@<version>`). */
  readToolRef: string;
  readInputs?: Record<string, SmassActionParamSpec>;
  classification?: SmassClassification;
  fields: Record<string, SmassFieldSpec & { type: SmassFieldType }>;
  actions?: SmassActionSpec[];
  source: SmassDataSource<TRecord>;
};

export type SmassDomainModel = SmassToolBackedModel | SmassStoreBackedModel;

export function defineToolBackedModel(
  spec: Omit<SmassToolBackedModel, "mode">,
): SmassToolBackedModel {
  return { ...spec, mode: "tool_backed" };
}

export function defineStoreBackedModel<TRecord = Record<string, unknown>>(
  spec: Omit<SmassStoreBackedModel<TRecord>, "mode" | "readToolRef"> & { readToolRef?: string },
): SmassStoreBackedModel<TRecord> {
  return {
    ...spec,
    mode: "store_backed",
    readToolRef: spec.readToolRef ?? `${spec.id}.read@${spec.version}`,
  };
}

export type SmassModelSummary = {
  id: string;
  version: string;
  domain: string;
  label: string;
  description?: string;
  mode: "tool_backed" | "store_backed";
  toolRefs: string[];
  fields: Array<{
    key: string;
    toolRef: string;
    outputPath: string;
    label: string;
    type?: SmassFieldType;
    format?: SmassFieldFormat;
    classification: SmassClassification;
    writable: boolean;
    exposed: boolean;
  }>;
  actions: Array<{
    id: string;
    toolRef: string;
    label: string;
    effect: "read" | "write";
  }>;
};
