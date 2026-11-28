import { defineTool, type JsonObject, type JsonSchema, type ToolDefinition } from "@sfield/core";
import type {
  SmassActionParamSpec,
  SmassActionSpec,
  SmassClassification,
  SmassDataModelRelationEdge,
  SmassDomainModel,
  SmassFieldSpec,
  SmassFieldType,
  SmassItemFieldSpec,
  SmassModelSummary,
  SmassRelationCardinality,
  SmassStoreBackedModel,
  SmassToolBackedModel,
  SmassToolDescriptorLike,
} from "./contracts";

type SchemaFieldInput = {
  type: SmassFieldType;
  required?: boolean;
  nullable?: boolean;
  description?: string;
  enumValues?: string[];
  items?: Record<string, SmassItemFieldSpec>;
  computed?: { expression: string; dependsOn: string[] };
};

function toJsonSchemaNode(spec: SchemaFieldInput): JsonSchema {
  const baseType: JsonSchema["type"] = spec.nullable ? [spec.type, "null"] : spec.type;
  if (spec.type === "array") {
    const itemSchema: Record<string, unknown> = spec.items
      ? buildClosedObjectSchema(spec.items)
      : { type: "object" };
    return {
      type: baseType,
      items: itemSchema as JsonSchema,
      ...(spec.description ? { description: spec.description } : {}),
    };
  }
  if (spec.type === "object") {
    if (spec.items) {
      return {
        ...buildClosedObjectSchema(spec.items),
        ...(spec.nullable ? { type: ["object", "null"] } : {}),
        ...(spec.description ? { description: spec.description } : {}),
      } as JsonSchema;
    }
    return { type: baseType, ...(spec.description ? { description: spec.description } : {}) };
  }
  return {
    type: baseType,
    ...(spec.enumValues?.length ? { enum: spec.enumValues } : {}),
    ...(spec.description ? { description: spec.description } : {}),
  };
}

export function buildClosedObjectSchema(
  fields: Record<string, SchemaFieldInput>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, spec] of Object.entries(fields)) {
    if (spec.computed) continue;
    properties[key] = toJsonSchemaNode(spec);
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
  for (const rawSegment of path.split(".").filter(Boolean)) {
    const arrayMatch = rawSegment.match(/^(.+?)\[(?:-?\d+)?\]$/);
    const segment = arrayMatch ? arrayMatch[1]! : rawSegment;
    const props = current?.properties as Record<string, Record<string, unknown>> | undefined;
    if (!props || !Object.prototype.hasOwnProperty.call(props, segment)) {
      return { found: false, types: [] };
    }
    current = props[segment];
    if (arrayMatch) {
      const items = current?.items as Record<string, unknown> | undefined;
      if (!items || typeof items !== "object") {
        return { found: false, types: [] };
      }
      current = items;
    }
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
  if (model.unnest) {
    const unnestSource = model.sources[model.unnest.slot];
    if (!unnestSource) {
      issues.push({
        modelId: model.id,
        message: `Unnest references unknown source slot "${model.unnest.slot}".`,
      });
    } else {
      const desc = descriptors.get(unnestSource.toolRef);
      if (desc && !resolveSchemaPath(desc.outputs, model.unnest.path).found) {
        issues.push({
          modelId: model.id,
          toolRef: unnestSource.toolRef,
          message: `Unnest path "${model.unnest.path}" does not exist on ${unnestSource.toolRef} output schema.`,
        });
      }
    }
  }
  for (const [fieldKey, field] of Object.entries(model.fields)) {
    if (field.principalKey) continue;
    if (model.unnest?.indexField && fieldKey === model.unnest.indexField) continue;
    if (field.computed) {
      for (const dep of field.computed.dependsOn) {
        if (!Object.prototype.hasOwnProperty.call(model.fields, dep)) {
          issues.push({
            modelId: model.id,
            field: fieldKey,
            message: `Computed field "${fieldKey}" depends on undeclared field "${dep}".`,
          });
        }
      }
      continue;
    }
    if (field.aggregate) {
      const deps = [
        ...(field.aggregate.sourceField ? [field.aggregate.sourceField] : []),
        ...(field.aggregate.sourceFields ?? []),
      ];
      if (deps.length === 0) {
        issues.push({
          modelId: model.id,
          field: fieldKey,
          message: `Aggregate field "${fieldKey}" must specify sourceField or sourceFields.`,
        });
      }
      for (const dep of deps) {
        if (!Object.prototype.hasOwnProperty.call(model.fields, dep)) {
          issues.push({
            modelId: model.id,
            field: fieldKey,
            message: `Aggregate field "${fieldKey}" depends on undeclared field "${dep}".`,
          });
        }
      }
      continue;
    }
    const from = field.from;
    if (!from || !from.includes(".")) {
      issues.push({
        modelId: model.id,
        field: fieldKey,
        message: `Tool-backed field "${fieldKey}" must specify from: "<sourceSlot>.<outputPath>", principalKey, or computed.`,
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

/**
 * Validates referential integrity across entity relationships, foreign keys, computed dependencies,
 * and lifecycle state machines within a registry of smass domain models.
 */
export function validateDomainGraph(models: readonly SmassDomainModel[]): SmassModelValidationIssue[] {
  const issues: SmassModelValidationIssue[] = [];
  const byId = new Map(models.map((m) => [m.id, m]));

  for (const model of models) {
    for (const rel of model.relations ?? []) {
      const target = byId.get(rel.targetModelId);
      if (!target) {
        issues.push({
          modelId: model.id,
          message: `Relation "${rel.name}" references unknown target model "${rel.targetModelId}".`,
        });
      }
    }
    for (const [fieldKey, field] of Object.entries(model.fields)) {
      if (field.foreignKey && !byId.has(field.foreignKey.modelId)) {
        issues.push({
          modelId: model.id,
          field: fieldKey,
          message: `Foreign key on "${fieldKey}" references unknown model "${field.foreignKey.modelId}".`,
        });
      }
      if (field.computed) {
        for (const dep of field.computed.dependsOn) {
          if (!Object.prototype.hasOwnProperty.call(model.fields, dep)) {
            issues.push({
              modelId: model.id,
              field: fieldKey,
              message: `Computed field "${fieldKey}" depends on undeclared field "${dep}".`,
            });
          }
        }
      }
      if (field.aggregate) {
        const deps = [
          ...(field.aggregate.sourceField ? [field.aggregate.sourceField] : []),
          ...(field.aggregate.sourceFields ?? []),
        ];
        if (deps.length === 0) {
          issues.push({
            modelId: model.id,
            field: fieldKey,
            message: `Aggregate field "${fieldKey}" must specify sourceField or sourceFields.`,
          });
        }
        for (const dep of deps) {
          if (!Object.prototype.hasOwnProperty.call(model.fields, dep)) {
            issues.push({
              modelId: model.id,
              field: fieldKey,
              message: `Aggregate field "${fieldKey}" depends on undeclared field "${dep}".`,
            });
          }
        }
      }
    }
    if (model.lifecycle) {
      const { stateField, states, transitions } = model.lifecycle;
      if (!Object.prototype.hasOwnProperty.call(model.fields, stateField)) {
        issues.push({
          modelId: model.id,
          field: stateField,
          message: `Lifecycle stateField "${stateField}" is not declared on model "${model.id}".`,
        });
      }
      const stateSet = new Set(states);
      const actionIds = new Set((model.actions ?? []).map((a) => a.id));
      for (const tr of transitions) {
        if (!stateSet.has(tr.from) || !stateSet.has(tr.to)) {
          issues.push({
            modelId: model.id,
            field: stateField,
            message: `Lifecycle transition "${tr.from} -> ${tr.to}" references an undeclared state.`,
          });
        }
        if (tr.actionId && !actionIds.has(tr.actionId)) {
          issues.push({
            modelId: model.id,
            message: `Lifecycle transition "${tr.from} -> ${tr.to}" references unknown action "${tr.actionId}".`,
          });
        }
      }
    }
  }
  return issues;
}

function mermaidEntityName(modelId: string): string {
  return modelId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

function mermaidCardinality(cardinality: SmassRelationCardinality): string {
  switch (cardinality) {
    case "one_to_one":
      return "||--||";
    case "one_to_many":
      return "||--o{";
    case "many_to_one":
      return "}o--||";
    case "many_to_many":
      return "}o--o{";
  }
}

/**
 * Compiles a smass domain model graph into a standard Mermaid ER diagram.
 */
export function compileMermaidErDiagram(
  entities: readonly SmassModelSummary[],
  relations: readonly SmassDataModelRelationEdge[],
): string {
  const lines: string[] = ["erDiagram"];
  for (const entity of entities) {
    const name = mermaidEntityName(entity.id);
    lines.push(`  ${name} {`);
    for (const field of entity.fields) {
      const typeToken = field.type ?? "string";
      const keyTags = [
        ...(field.primaryKey ? ["PK"] : []),
        ...(field.foreignKey ? ["FK"] : []),
      ].join(",");
      const notes: string[] = [];
      if (field.format) notes.push(field.format);
      if (field.computed) notes.push(`computed: ${field.computed.expression}`);
      if (field.aggregate) {
        const target = field.aggregate.sourceField
          ? `${field.aggregate.sourceField}${field.aggregate.itemField ? `.${field.aggregate.itemField}` : ""}`
          : (field.aggregate.sourceFields ?? []).join(", ");
        notes.push(`agg: ${field.aggregate.op}(${target})`);
      }
      if (field.enumValues?.length) notes.push(`enum: ${field.enumValues.join("|")}`);
      if (field.principalKey) notes.push(`principal.${field.principalKey}`);
      const suffix = notes.length ? ` "${notes.join(" · ")}"` : "";
      lines.push(`    ${typeToken} ${field.key}${keyTags ? ` ${keyTags}` : ""}${suffix}`);
    }
    lines.push("  }");
  }

  const seenEdges = new Set<string>();
  for (const rel of relations) {
    const dedupeKey = `${rel.sourceModelId}:${rel.targetModelId}:${rel.name}`;
    if (seenEdges.has(dedupeKey)) continue;
    seenEdges.add(dedupeKey);
    lines.push(
      `  ${mermaidEntityName(rel.sourceModelId)} ${mermaidCardinality(rel.cardinality)} ${mermaidEntityName(rel.targetModelId)} : "${rel.name}"`,
    );
  }
  return lines.join("\n");
}

/**
 * Compiles a smass domain model graph into a self-describing JSON Schema (Draft 2020-12) $defs document.
 */
export function compileDomainJsonSchema(
  domain: string,
  entities: readonly SmassModelSummary[],
): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  for (const entity of entities) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const field of entity.fields) {
      const node: Record<string, unknown> = {
        type: field.nullable && field.type ? [field.type, "null"] : (field.type ?? "string"),
        title: field.label,
      };
      if (field.format) node["x-smass-format"] = field.format;
      if (field.enumValues?.length) node.enum = field.enumValues;
      if (field.items) {
        if (field.type === "array") {
          node.items = buildClosedObjectSchema(field.items);
        } else {
          node.properties = (buildClosedObjectSchema(field.items) as { properties: unknown }).properties;
        }
      }
      if (field.primaryKey) node["x-smass-primary-key"] = true;
      if (field.foreignKey) node["x-smass-foreign-key"] = field.foreignKey;
      if (field.principalKey) node["x-smass-principal-key"] = field.principalKey;
      if (field.computed) node["x-smass-computed"] = field.computed;
      if (field.aggregate) node["x-smass-aggregate"] = field.aggregate;
      if (field.toolRef) node["x-sfield-source"] = `${field.toolRef}#${field.outputPath}`;
      node["x-smass-classification"] = field.classification;
      node["x-smass-exposed"] = field.exposed;
      properties[field.key] = node;
      if (field.required) required.push(field.key);
    }
    defs[entity.id] = {
      type: "object",
      title: entity.label,
      ...(entity.description ? { description: entity.description } : {}),
      additionalProperties: false,
      properties,
      ...(required.length ? { required } : {}),
      "x-smass-mode": entity.mode,
      ...(entity.primaryKey ? { "x-smass-primary-key": entity.primaryKey } : {}),
      ...(entity.unnest ? { "x-smass-unnest": entity.unnest } : {}),
      "x-smass-tools": entity.toolRefs,
      ...(entity.relations.length ? { "x-smass-relations": entity.relations } : {}),
      ...(entity.lifecycle ? { "x-smass-lifecycle": entity.lifecycle } : {}),
    };
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `urn:smass:domain:${domain}`,
    title: `${domain} domain data model`,
    $defs: defs,
  };
}
