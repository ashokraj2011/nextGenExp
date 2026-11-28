import type { ToolDefinition } from "@sfield/core";
import type {
  SmassActionSpec,
  SmassDomainModel,
  SmassExecutionContext,
  SmassFieldFormat,
  SmassFieldType,
  SmassModelSummary,
  SmassStoreBackedModel,
  SmassToolDescriptorLike,
} from "./contracts";
import {
  compileModelToSfieldTools,
  describeStoreBackedModelTools,
  resolveSchemaPath,
  validateToolBackedModel,
  type SmassModelValidationIssue,
} from "./schema-compiler";

export type SmassProjectedField = {
  modelId: string;
  toolRef: string;
  outputPath: string;
  label: string;
  group: string;
  description?: string;
  supportedFormats?: SmassFieldFormat[];
  defaultFormat?: SmassFieldFormat;
  legacyBindingKey?: string;
  exposed: boolean;
};

export type SmassProjectedAction = {
  modelId: string;
  id: string;
  toolRef: string;
  label: string;
  description?: string;
  fixedInputFields: Record<string, SmassFieldType>;
  followUpInputFields: string[];
  defaultUpdate: "originalCard" | "newTurn";
};

/**
 * Singularity Mass (smass) Domain Registry.
 * Holds both tool-backed (federated over sfield tools) and store-backed (generates sfield tools)
 * domain models. Depends only on @sfield/core tool/schema primitives — zero UI, zero server code.
 */
export class SmassDomainRegistry {
  private readonly models = new Map<string, SmassDomainModel>();

  constructor(initial: readonly SmassDomainModel[] = []) {
    for (const model of initial) this.register(model);
  }

  register(model: SmassDomainModel): this {
    this.models.set(model.id, model);
    return this;
  }

  get(id: string): SmassDomainModel | undefined {
    return this.models.get(id);
  }

  list(domain?: string): SmassDomainModel[] {
    const all = [...this.models.values()];
    return domain ? all.filter((m) => m.domain === domain) : all;
  }

  domains(): string[] {
    return [...new Set([...this.models.values()].map((m) => m.domain))];
  }

  /** Returns closed JSON Schema tool descriptors generated from all store-backed models. */
  describeGeneratedTools(domain?: string): SmassToolDescriptorLike[] {
    const out: SmassToolDescriptorLike[] = [];
    for (const model of this.list(domain)) {
      if (model.mode === "store_backed") {
        out.push(...describeStoreBackedModelTools(model));
      }
    }
    return out;
  }

  /** Compiles all store-backed models into executable `@sfield/core` ToolDefinition[]. */
  toSfieldTools(domain?: string): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const model of this.list(domain)) {
      if (model.mode === "store_backed") {
        out.push(...compileModelToSfieldTools(model));
      }
    }
    return out;
  }

  /** Executes a read against a registered store-backed model by its generated readToolRef. */
  async executeStoreRead(
    toolRef: string,
    inputs: Record<string, unknown>,
    ctx: SmassExecutionContext,
  ): Promise<{ found: false } | { found: true; output: unknown | null }> {
    for (const model of this.models.values()) {
      if (model.mode === "store_backed" && model.readToolRef === toolRef) {
        const output = await model.source.read(inputs, ctx);
        return { found: true, output };
      }
    }
    return { found: false };
  }

  /** Executes an action handler registered on a store-backed model by its toolRef. */
  async executeStoreAction(
    toolRef: string,
    inputs: Record<string, unknown>,
    ctx: SmassExecutionContext,
  ): Promise<{ found: false } | { found: true; output: unknown }> {
    for (const model of this.models.values()) {
      if (model.mode !== "store_backed") continue;
      const action = model.actions?.find((entry) => entry.toolRef === toolRef && entry.handler);
      if (action?.handler) {
        const output = await action.handler(inputs, ctx);
        return { found: true, output };
      }
    }
    return { found: false };
  }

  /** Validates every tool-backed model against live sfield tool descriptors. */
  validateAgainstTools(descriptors: ReadonlyMap<string, SmassToolDescriptorLike>): SmassModelValidationIssue[] {
    const issues: SmassModelValidationIssue[] = [];
    for (const model of this.models.values()) {
      if (model.mode === "tool_backed") {
        issues.push(...validateToolBackedModel(model, descriptors));
      }
    }
    return issues;
  }

  /**
   * Projects all domain models for a domain into field & action binding definitions
   * consumable by sphoton's binding catalog without duplicating schemas.
   */
  projectBindingsForDomain(domain: string): {
    fields: SmassProjectedField[];
    actions: SmassProjectedAction[];
  } {
    const fields: SmassProjectedField[] = [];
    const actions: SmassProjectedAction[] = [];

    for (const model of this.list(domain)) {
      const group = `${model.label} (sfield)`;
      if (model.mode === "tool_backed") {
        for (const field of Object.values(model.fields)) {
          if (!field.from || !field.from.includes(".")) continue;
          const dot = field.from.indexOf(".");
          const slot = field.from.slice(0, dot);
          const outputPath = field.from.slice(dot + 1);
          const source = model.sources[slot];
          if (!source) continue;
          fields.push({
            modelId: model.id,
            toolRef: source.toolRef,
            outputPath,
            label: field.label,
            group: field.group ?? group,
            ...(field.description ? { description: field.description } : {}),
            ...(field.supportedFormats ? { supportedFormats: field.supportedFormats } : {}),
            ...(field.format ? { defaultFormat: field.format } : {}),
            ...(field.legacyBindingKey ? { legacyBindingKey: field.legacyBindingKey } : {}),
            exposed: field.exposed !== false,
          });
        }
      } else {
        const storeModel = model as SmassStoreBackedModel;
        for (const [key, field] of Object.entries(storeModel.fields)) {
          fields.push({
            modelId: model.id,
            toolRef: storeModel.readToolRef,
            outputPath: key,
            label: field.label,
            group: field.group ?? group,
            ...(field.description ? { description: field.description } : {}),
            ...(field.supportedFormats ? { supportedFormats: field.supportedFormats } : {}),
            ...(field.format ? { defaultFormat: field.format } : {}),
            ...(field.legacyBindingKey ? { legacyBindingKey: field.legacyBindingKey } : {}),
            exposed: field.exposed !== false,
          });
        }
      }

      for (const action of (model.actions ?? []) as SmassActionSpec[]) {
        actions.push({
          modelId: model.id,
          id: action.id,
          toolRef: action.toolRef,
          label: action.label,
          ...(action.description ? { description: action.description } : {}),
          fixedInputFields: action.fixedInputFields ?? {},
          followUpInputFields: action.followUpInputFields ?? [],
          defaultUpdate: action.defaultUpdate ?? "originalCard",
        });
      }
    }

    return { fields, actions };
  }

  /** Produces a serializable summary of registered models for admin/studio inspection. */
  summarize(domain?: string, descriptors?: ReadonlyMap<string, SmassToolDescriptorLike>): SmassModelSummary[] {
    return this.list(domain).map((model) => {
      const toolRefs = new Set<string>();
      const fields: SmassModelSummary["fields"] = [];

      if (model.mode === "tool_backed") {
        for (const src of Object.values(model.sources)) toolRefs.add(src.toolRef);
        for (const [key, field] of Object.entries(model.fields)) {
          const dot = field.from?.indexOf(".") ?? -1;
          const slot = dot >= 0 ? field.from!.slice(0, dot) : "";
          const outputPath = dot >= 0 ? field.from!.slice(dot + 1) : key;
          const toolRef = model.sources[slot]?.toolRef ?? "";
          const inferredType = field.type ?? (toolRef && descriptors?.get(toolRef)
            ? resolveSchemaPath(descriptors.get(toolRef)!.outputs, outputPath).types[0]
            : undefined);
          fields.push({
            key,
            toolRef,
            outputPath,
            label: field.label,
            ...(inferredType ? { type: inferredType } : {}),
            ...(field.format ? { format: field.format } : {}),
            classification: field.classification ?? "internal",
            writable: Boolean(field.writable),
            exposed: field.exposed !== false,
          });
        }
      } else {
        toolRefs.add(model.readToolRef);
        for (const [key, field] of Object.entries(model.fields)) {
          fields.push({
            key,
            toolRef: model.readToolRef,
            outputPath: key,
            label: field.label,
            type: field.type,
            ...(field.format ? { format: field.format } : {}),
            classification: field.classification ?? "internal",
            writable: Boolean(field.writable),
            exposed: field.exposed !== false,
          });
        }
      }

      for (const action of model.actions ?? []) toolRefs.add(action.toolRef);

      return {
        id: model.id,
        version: model.version,
        domain: model.domain,
        label: model.label,
        ...(model.description ? { description: model.description } : {}),
        mode: model.mode,
        toolRefs: [...toolRefs],
        fields,
        actions: (model.actions ?? []).map((a) => ({
          id: a.id,
          toolRef: a.toolRef,
          label: a.label,
          effect: a.effect ?? "read",
        })),
      };
    });
  }
}

export function createSmassRegistry(initial: readonly SmassDomainModel[] = []): SmassDomainRegistry {
  return new SmassDomainRegistry(initial);
}
