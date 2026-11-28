import type { SfieldAdapter } from "./adapter";
import {
  parseBindingSourcePath,
  sphotonCardBindingSchema,
  type SphotonBindingCatalog,
  type SphotonCardBinding,
  type SphotonComponentSchema,
  type SphotonFieldType,
} from "./contracts";
import { fingerprintToolContract, sha256Hex } from "./fingerprint";
import type { SphotonComponentRegistry } from "./registry";

export type SphotonValidationIssue = {
  code:
    | "invalid_schema"
    | "unknown_component"
    | "tool_not_allowed"
    | "tool_unregistered"
    | "source_missing"
    | "field_not_allowed"
    | "output_path_missing"
    | "type_mismatch"
    | "format_unsupported"
    | "required_field_missing"
    | "action_not_allowed"
    | "action_input_invalid";
  path: string;
  message: string;
};

export type SphotonDependencySnapshot = {
  domainId: string;
  catalogFingerprint: string;
  toolContracts: Record<string, string>;
  allowedFieldIds: string[];
  allowedActionIds: string[];
  fingerprint: string;
};

export type SphotonValidationResult = {
  valid: boolean;
  issues: SphotonValidationIssue[];
  dependencies: SphotonDependencySnapshot;
};

const DEFAULT_DYNAMIC_COMPONENT_SCHEMA: SphotonComponentSchema = {
  allowDynamicFields: true,
  fields: {
    badge: { types: ["string", "number", "integer", "boolean"] },
    title: { types: ["string", "number", "integer", "boolean"] },
    body: { types: ["string", "number", "integer", "boolean"] },
    progress: { types: ["number", "integer"] },
  },
};

function normalizeSchemaTypes(node: Record<string, unknown>): SphotonFieldType[] {
  const raw = node.type;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.filter((item): item is SphotonFieldType =>
    item === "string" || item === "number" || item === "integer" || item === "boolean" || item === "array" || item === "object");
}

/**
 * Resolves a dot-delimited output path (e.g. `targetCents` or `summary.totalCents`)
 * against a closed JSON Schema object.
 */
export function resolveJsonSchemaPath(schema: Record<string, unknown> | undefined, outputPath: string): {
  found: boolean;
  types: SphotonFieldType[];
  node?: Record<string, unknown>;
} {
  if (!schema || typeof schema !== "object") return { found: false, types: [] };
  const segments = outputPath.split(".").filter(Boolean);
  let current: Record<string, unknown> | undefined = schema;
  for (const segment of segments) {
    if (!current || typeof current !== "object") return { found: false, types: [] };
    const props = current.properties as Record<string, Record<string, unknown>> | undefined;
    if (props && Object.prototype.hasOwnProperty.call(props, segment)) {
      current = props[segment];
      continue;
    }
    const items = current.items as Record<string, unknown> | undefined;
    if (/^\d+$/.test(segment) && items && typeof items === "object") {
      current = items;
      continue;
    }
    return { found: false, types: [] };
  }
  if (!current) return { found: false, types: [] };
  return { found: true, types: normalizeSchemaTypes(current), node: current };
}

function runtimeValueMatchesTypes(value: unknown, allowed: readonly SphotonFieldType[]): boolean {
  if (allowed.length === 0) return true;
  if (typeof value === "string") return allowed.includes("string");
  if (typeof value === "boolean") return allowed.includes("boolean");
  if (typeof value === "number") {
    if (Number.isInteger(value)) return allowed.includes("integer") || allowed.includes("number");
    return allowed.includes("number");
  }
  if (Array.isArray(value)) return allowed.includes("array");
  if (value !== null && typeof value === "object") return allowed.includes("object");
  return false;
}

function typesCompatible(sourceTypes: readonly SphotonFieldType[], expectedTypes: readonly SphotonFieldType[]): boolean {
  if (sourceTypes.length === 0 || expectedTypes.length === 0) return true;
  return sourceTypes.some((src) =>
    expectedTypes.includes(src)
    || (src === "integer" && expectedTypes.includes("number")));
}

export function validateCardBinding(
  rawCard: SphotonCardBinding,
  catalog: SphotonBindingCatalog,
  options?: {
    sfield?: SfieldAdapter;
    registry?: SphotonComponentRegistry;
    strictRequiredComponentFields?: boolean;
  },
): SphotonValidationResult {
  const issues: SphotonValidationIssue[] = [];
  const parsed = sphotonCardBindingSchema.safeParse(rawCard);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        code: "invalid_schema",
        path: issue.path.join(".") || "card",
        message: issue.message,
      })),
      dependencies: {
        domainId: catalog.domainId,
        catalogFingerprint: catalog.catalogFingerprint,
        toolContracts: {},
        allowedFieldIds: [],
        allowedActionIds: [],
        fingerprint: sha256Hex({ invalid: true }),
      },
    };
  }
  const card = parsed.data;
  const toolsByRef = new Map(catalog.tools.map((tool) => [tool.toolRef, tool]));
  const fieldsByKey = new Map(catalog.fields.map((field) => [`${field.toolRef}::${field.outputPath}`, field]));
  const actionsByRef = new Map(catalog.actions.map((action) => [action.toolRef, action]));

  const componentSchema: SphotonComponentSchema | undefined = options?.registry
    ? options.registry.get(card.component)?.schema
    : DEFAULT_DYNAMIC_COMPONENT_SCHEMA;

  if (!componentSchema) {
    issues.push({
      code: "unknown_component",
      path: "component",
      message: `Component ${card.component} is not registered in the sphoton component registry.`,
    });
  }

  const toolContracts: Record<string, string> = {};
  const allowedFieldIds = new Set<string>();
  const allowedActionIds = new Set<string>();

  for (const [slotName, source] of Object.entries(card.sources)) {
    const catalogTool = toolsByRef.get(source.toolRef);
    if (!catalogTool) {
      issues.push({
        code: "tool_not_allowed",
        path: `sources.${slotName}.toolRef`,
        message: `Tool ${source.toolRef} is not exposed in the ${catalog.domainId} binding catalog.`,
      });
      continue;
    }
    const liveDescriptor = options?.sfield?.describeTool(source.toolRef);
    if (options?.sfield && !liveDescriptor) {
      issues.push({
        code: "tool_unregistered",
        path: `sources.${slotName}.toolRef`,
        message: `Tool ${source.toolRef} is not registered in sfield.`,
      });
      continue;
    }
    toolContracts[source.toolRef] = liveDescriptor
      ? fingerprintToolContract(liveDescriptor.ref, liveDescriptor.inputs, liveDescriptor.outputs)
      : catalogTool.contractFingerprint;
  }

  const boundFields = new Set<string>();
  for (const [index, binding] of card.bindings.entries()) {
    boundFields.add(binding.field);
    const parsedFrom = parseBindingSourcePath(binding.from);
    if (!parsedFrom) {
      issues.push({
        code: "source_missing",
        path: `bindings[${index}].from`,
        message: `Binding path ${binding.from} must follow <sourceSlot>.data.<outputPath>.`,
      });
      continue;
    }
    const source = card.sources[parsedFrom.slot];
    if (!source) {
      issues.push({
        code: "source_missing",
        path: `bindings[${index}].from`,
        message: `Binding ${binding.field} references undeclared source slot "${parsedFrom.slot}".`,
      });
      continue;
    }
    const catalogTool = toolsByRef.get(source.toolRef);
    const catalogField = fieldsByKey.get(`${source.toolRef}::${parsedFrom.outputPath}`);
    if (!catalogField) {
      issues.push({
        code: "field_not_allowed",
        path: `bindings[${index}].from`,
        message: `Field ${source.toolRef} -> ${parsedFrom.outputPath} is not exposed for ${catalog.domainId}.`,
      });
      continue;
    }
    allowedFieldIds.add(catalogField.id);

    const outputSchema = options?.sfield?.describeTool(source.toolRef)?.outputs ?? catalogTool?.outputSchema;
    const resolved = resolveJsonSchemaPath(outputSchema, parsedFrom.outputPath);
    if (!resolved.found) {
      issues.push({
        code: "output_path_missing",
        path: `bindings[${index}].from`,
        message: `Output path ${parsedFrom.outputPath} does not exist in ${source.toolRef} output schema.`,
      });
      continue;
    }

    const effectiveTypes = resolved.types.length > 0 ? resolved.types : [catalogField.type];
    if (binding.format && !catalogField.supportedFormats.includes(binding.format)) {
      issues.push({
        code: "format_unsupported",
        path: `bindings[${index}].format`,
        message: `Format "${binding.format}" is not supported for ${catalogField.label} (${parsedFrom.outputPath}).`,
      });
    }

    if (componentSchema) {
      const rule = componentSchema.fields[binding.field];
      if (!rule && !componentSchema.allowDynamicFields) {
        issues.push({
          code: "type_mismatch",
          path: `bindings[${index}].field`,
          message: `Component ${card.component} does not declare destination field "${binding.field}".`,
        });
      } else if (rule && !typesCompatible(effectiveTypes, rule.types)) {
        issues.push({
          code: "type_mismatch",
          path: `bindings[${index}].field`,
          message: `Field ${parsedFrom.outputPath} (${effectiveTypes.join("|")}) does not fit ${card.component}.${binding.field} (expects ${rule.types.join("|")}).`,
        });
      }
    }
  }

  if (options?.strictRequiredComponentFields && componentSchema) {
    for (const [destField, rule] of Object.entries(componentSchema.fields)) {
      if (rule.required && !boundFields.has(destField)) {
        issues.push({
          code: "required_field_missing",
          path: "bindings",
          message: `Component ${card.component} requires a binding for "${destField}".`,
        });
      }
    }
  }

  for (const [index, action] of (card.actions ?? []).entries()) {
    const catalogAction = actionsByRef.get(action.toolRef);
    if (!catalogAction) {
      issues.push({
        code: "action_not_allowed",
        path: `actions[${index}].toolRef`,
        message: `Action tool ${action.toolRef} is not allowed in the ${catalog.domainId} binding catalog.`,
      });
      continue;
    }
    allowedActionIds.add(catalogAction.id);
    const liveAction = options?.sfield?.describeTool(action.toolRef);
    if (options?.sfield && !liveAction) {
      issues.push({
        code: "tool_unregistered",
        path: `actions[${index}].toolRef`,
        message: `Action tool ${action.toolRef} is not registered in sfield.`,
      });
      continue;
    }
    const inputSchema = liveAction?.inputs ?? catalogAction.inputSchema;
    toolContracts[action.toolRef] = liveAction
      ? fingerprintToolContract(liveAction.ref, liveAction.inputs, liveAction.outputs)
      : catalogAction.contractFingerprint;

    for (const [key, val] of Object.entries(action.fixedInputs ?? {})) {
      const schemaField = resolveJsonSchemaPath(inputSchema, key);
      const allowedType = catalogAction.fixedInputFields[key];
      if (!schemaField.found && !allowedType) {
        issues.push({
          code: "action_input_invalid",
          path: `actions[${index}].fixedInputs.${key}`,
          message: `Input "${key}" is not declared on action ${action.toolRef}.`,
        });
        continue;
      }
      const expectedTypes = schemaField.types.length > 0 ? schemaField.types : allowedType ? [allowedType] : [];
      if (!runtimeValueMatchesTypes(val, expectedTypes)) {
        issues.push({
          code: "action_input_invalid",
          path: `actions[${index}].fixedInputs.${key}`,
          message: `Fixed input "${key}" value does not match expected type (${expectedTypes.join("|")}).`,
        });
      }
    }

    for (const followUpKey of action.followUpInputs ?? []) {
      const schemaField = resolveJsonSchemaPath(inputSchema, followUpKey);
      if (!schemaField.found && !catalogAction.followUpInputFields.includes(followUpKey)) {
        issues.push({
          code: "action_input_invalid",
          path: `actions[${index}].followUpInputs`,
          message: `Follow-up input "${followUpKey}" is not declared on action ${action.toolRef}.`,
        });
      }
    }
  }

  const sortedFieldIds = [...allowedFieldIds].sort();
  const sortedActionIds = [...allowedActionIds].sort();
  const dependencies: SphotonDependencySnapshot = {
    domainId: catalog.domainId,
    catalogFingerprint: catalog.catalogFingerprint,
    toolContracts,
    allowedFieldIds: sortedFieldIds,
    allowedActionIds: sortedActionIds,
    fingerprint: sha256Hex({
      domainId: catalog.domainId,
      toolContracts,
      allowedFieldIds: sortedFieldIds,
      allowedActionIds: sortedActionIds,
    }),
  };

  return {
    valid: issues.length === 0,
    issues,
    dependencies,
  };
}
