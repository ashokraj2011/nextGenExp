import { defineTool, type JsonObject, type JsonSchema, type ToolDefinition } from "@sfield/core";
import type {
  SmassActionParamSpec,
  SmassActionSpec,
  SmassClassification,
  SmassFieldSpec,
  SmassFieldType,
  SmassStoreBackedModel,
  SmassToolBackedModel,
  SmassToolDescriptorLike,
} from "./contracts";

function toJsonSchemaNode(type: SmassFieldType, description?: string): JsonSchema {
  if (type === "array") {
    return { type: "array", items: { type: "object" }, ...(description ? { description } : {}) };
  }
  if (type === "object") {
    return { type: "object", ...(description ? { description } : {}) };
  }
  return { type, ...(description ? { description } : {}) };
}

export function buildClosedObjectSchema(
  fields: Record<string, { type: SmassFieldType; required?: boolean; description?: string }>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, spec] of Object.entries(fields)) {
    properties[key] = toJsonSchemaNode(spec.type, spec.description);
    if (spec.required) required.push(key);
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function splitToolRef(ref: string): { id: string; version: string } {
  const [id, version = "1.0.0"] = ref.split("@");
  return { id, version };
}

function highestClassification(
  fallback: SmassClassification | undefined,
  fields: Record<string, SmassFieldSpec>,
): "public" | "internal" | "confidential" | "restricted" {
  const rank = { public: 0, internal: 1, confidential: 2, pii: 3 } as const;
  let max: SmassClassification = fallback ?? "internal";
  for (const field of Object.values(fields)) {
    const c = field.classification ?? "internal";
    if (rank[c] > rank[max]) max = c;
  }
  return max === "pii" ? "restricted" : max;
}

/**
 * Generates closed tool descriptors for a store-backed smass domain model and its declared actions.
 */
export function describeStoreBackedModelTools(model: SmassStoreBackedModel): SmassToolDescriptorLike[] {
  const out: SmassToolDescriptorLike[] = [];
  const { id, version } = splitToolRef(model.readToolRef);
  const readInputs: Record<string, SmassActionParamSpec> = model.readInputs ?? {
    [model.primaryKey]: { type: "string", description: `Primary identifier (${model.primaryKey})` },
  };
  out.push({
    ref: model.readToolRef,
    id,
    version,
    description: model.description ?? `Reads a ${model.label} record.`,
    inputs: buildClosedObjectSchema(readInputs),
    outputs: buildClosedObjectSchema(model.fields),
  });

  for (const action of model.actions ?? []) {
    if (!action.inputs && !action.outputs) continue;
    const parts = splitToolRef(action.toolRef);
    out.push({
      ref: action.toolRef,
      id: parts.id,
      version: parts.version,
      description: action.description ?? action.label,
      inputs: buildClosedObjectSchema(action.inputs ?? {}),
      outputs: buildClosedObjectSchema(action.outputs ?? {}),
    });
  }
  return out;
}

/**
 * Compiles a store-backed smass domain model into executable `@sfield/core` ToolDefinition[]
 * with closed Ajv schemas, policy classifications, and resource bindings.
 */
export function compileModelToSfieldTools(model: SmassStoreBackedModel): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const { id: readId, version: readVersion } = splitToolRef(model.readToolRef);
  const readInputs: Record<string, SmassActionParamSpec> = model.readInputs ?? {
    [model.primaryKey]: { type: "string", description: `Primary identifier (${model.primaryKey})` },
  };
  const classification = highestClassification(model.classification, model.fields);

  tools.push(defineTool({
    id: readId,
    version: readVersion,
    description: model.description ?? `Reads a ${model.label} record from ${model.domain}.`,
    inputs: buildClosedObjectSchema(readInputs) as JsonSchema,
    outputs: buildClosedObjectSchema(model.fields) as JsonSchema,
    policy: { effect: "read", classification },
    handler: async (rawInputs, ctx) => {
      const record = await model.source.read(rawInputs as Record<string, unknown>, {
        tenantId: ctx.principal.tenantId,
        domainId: model.domain,
        principalId: ctx.principal.subjectId,
        signal: ctx.signal,
      });
      if (!record) {
        throw new Error(`${model.id.toUpperCase()}_NOT_FOUND`);
      }
      return record as JsonObject;
    },
  }));

  for (const action of model.actions ?? []) {
    if (!action.handler) continue;
    const parts = splitToolRef(action.toolRef);
    const actionClass = action.classification === "pii" ? "restricted" : (action.classification ?? classification);
    tools.push(defineTool({
      id: parts.id,
      version: parts.version,
      description: action.description ?? action.label,
      inputs: buildClosedObjectSchema(action.inputs ?? {}) as JsonSchema,
      outputs: buildClosedObjectSchema(action.outputs ?? {}) as JsonSchema,
      policy: {
        effect: action.effect ?? "read",
        classification: actionClass,
      },
      handler: async (rawInputs, ctx) => {
        const result = await action.handler!(rawInputs as Record<string, unknown>, {
          tenantId: ctx.principal.tenantId,
          domainId: model.domain,
          principalId: ctx.principal.subjectId,
          signal: ctx.signal,
        });
        return result as JsonObject;
      },
    }));
  }

  return tools;
}

export function resolveSchemaPath(schema: Record<string, unknown> | undefined, path: string): {
  found: boolean;
  types: SmassFieldType[];
} {
  if (!schema || typeof schema !== "object") return { found: false, types: [] };
  let current: Record<string, unknown> | undefined = schema;
  for (const segment of path.split(".").filter(Boolean)) {
    const props = current?.properties as Record<string, Record<string, unknown>> | undefined;
    if (!props || !Object.prototype.hasOwnProperty.call(props, segment)) {
      return { found: false, types: [] };
    }
    current = props[segment];
  }
  const raw = current?.type;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const types = list.filter((item): item is SmassFieldType =>
    item === "string" || item === "number" || item === "integer" || item === "boolean" || item === "array" || item === "object");
  return { found: Boolean(current), types };
}

export type SmassModelValidationIssue = {
  modelId: string;
  field?: string;
  toolRef?: string;
  message: string;
};

/**
 * Validates that every source tool, field path, and action on a tool-backed model
 * exists in the provided sfield tool descriptors.
 */
export function validateToolBackedModel(
  model: SmassToolBackedModel,
  descriptors: ReadonlyMap<string, SmassToolDescriptorLike>,
): SmassModelValidationIssue[] {
  const issues: SmassModelValidationIssue[] = [];
  for (const [slot, src] of Object.entries(model.sources)) {
    if (!descriptors.has(src.toolRef)) {
      issues.push({
        modelId: model.id,
        toolRef: src.toolRef,
        message: `Source slot "${slot}" references unregistered sfield tool ${src.toolRef}.`,
      });
    }
  }
  for (const [fieldKey, field] of Object.entries(model.fields)) {
    const from = field.from;
    if (!from || !from.includes(".")) {
      issues.push({
        modelId: model.id,
        field: fieldKey,
        message: `Tool-backed field "${fieldKey}" must specify from: "<sourceSlot>.<outputPath>".`,
      });
      continue;
    }
    const dot = from.indexOf(".");
    const slot = from.slice(0, dot);
    const outputPath = from.slice(dot + 1);
    const source = model.sources[slot];
    if (!source) {
      issues.push({
        modelId: model.id,
        field: fieldKey,
        message: `Field "${fieldKey}" references unknown source slot "${slot}".`,
      });
      continue;
    }
    const desc = descriptors.get(source.toolRef);
    if (!desc) continue;
    const resolved = resolveSchemaPath(desc.outputs, outputPath);
    if (!resolved.found) {
      issues.push({
        modelId: model.id,
        field: fieldKey,
        toolRef: source.toolRef,
        message: `Field "${fieldKey}" path "${outputPath}" does not exist on ${source.toolRef} output schema.`,
      });
    }
  }
  for (const action of (model.actions ?? []) as SmassActionSpec[]) {
    if (!descriptors.has(action.toolRef)) {
      issues.push({
        modelId: model.id,
        toolRef: action.toolRef,
        message: `Action "${action.id}" references unregistered sfield tool ${action.toolRef}.`,
      });
    }
  }
  return issues;
}
