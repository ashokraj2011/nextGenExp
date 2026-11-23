import { isDeepStrictEqual } from "node:util";
import { capabilityRef, manifestSchema, componentOutputs, type CapabilityManifest, type InputField, type OutputKind } from "../../packages/contracts/agentic";
import { builtinCapabilities, capabilityTools, type CapabilityTool } from "../../packages/capabilities";
import { activeContexts } from "../../packages/ts-adapter";
import { ApiError, type Store } from "./store";

const contexts = new Set(activeContexts.map(({ contextId }) => contextId));
const contentVersion = new Map(builtinCapabilities.map((item) => [capabilityRef(item), item.eligibility.kind]));
const ownerFor = (principalId: string) => ({ principalId, personaId: "" });
const toolIndex = new Map(capabilityTools.map((tool) => [tool.ref, tool]));
const sameSet = <T>(left: T[], right: T[]) => left.length === right.length && new Set(left).size === left.length && left.every((value) => right.includes(value));

function compatibleField(field: InputField, required: InputField) {
  if (field.id !== required.id || field.type !== required.type || field.required !== required.required) return false;
  if (field.type === "integer" && required.type === "integer") return field.min >= required.min && field.max <= required.max && field.unit === required.unit;
  if (field.type === "text" && required.type === "text") return field.maxLength <= required.maxLength;
  return field.type === "choice";
}

export function capabilityIssue(manifest: CapabilityManifest) {
  const { tools, discovery, eligibility, inputs, invariants, execution, experience, completionCriteria } = manifest;
  const accessRef = capabilityRef(eligibility);
  if (contentVersion.get(accessRef) !== eligibility.kind) return "Choose a Treatment Selector reference published for this version.";
  if (new Set(discovery.contexts).size !== discovery.contexts.length || discovery.contexts.some((id) => !contexts.has(id))) {
    return "Choose distinct, active Treatment Selector contexts.";
  }
  if (discovery.planningCompanions?.some((ref) => ref === capabilityRef(manifest) || !contentVersion.has(ref))) {
    return "Choose known companion capability versions.";
  }
  const definitions = tools.map((ref) => toolIndex.get(ref));
  if (definitions.some((tool) => !tool) || new Set(tools).size !== tools.length) return "Choose distinct tools from the registered list.";
  const registered = definitions as CapabilityTool[];
  if (registered.some((tool) => tool.authorizedBy !== accessRef || discovery.contexts.some((id) => !tool.contexts.includes(id)))) {
    return "A tool is outside the selected eligibility reference or context.";
  }
  const baseline = capabilityTools.filter((tool) => tool.authorizedBy === accessRef);
  if (!sameSet(tools, baseline.map(({ ref }) => ref))) return "Include every tool required by this Treatment Selector reference.";
  if (!sameSet(invariants, registered.map(({ invariant }) => invariant))) return "Include the deterministic checks registered for these tools.";
  if (execution.mode === "direct" && tools.length !== 1) return "Direct execution requires one tool.";
  const requiredFields = registered.flatMap((tool) => tool.requiredFields ?? []);
  if (new Set(inputs.map(({ id }) => id)).size !== inputs.length || inputs.length !== requiredFields.length
    || inputs.some((field) => !requiredFields.some((required) => compatibleField(field, required)))) return "Input types and limits must match the tools.";
  if (inputs.some((field) => field.type === "integer" && (field.min > field.max
    || (field.default !== undefined && (field.default < field.min || field.default > field.max))))) return "Use input defaults within the allowed range.";
  if (inputs.some((field) => field.type === "integer" && field.default !== undefined
    && requiredFields.some((required) => required.id === field.id && required.type === "integer" && required.default === undefined))) {
    return "Customer-entered amounts require explicit input.";
  }
  const ordered = new Set<OutputKind>();
  const produced = new Set(registered.map(({ output }) => output));
  for (const tool of registered) {
    if (execution.mode !== "agent" && tool.uses?.some((kind) => produced.has(kind) && !ordered.has(kind))) return "Place prerequisite tools before their consumers.";
    ordered.add(tool.output);
  }
  const allowed = new Set(experience.allowedComponents);
  if (allowed.size !== experience.allowedComponents.length || [...allowed].some((component) => (
    component === "Form" ? !inputs.length : !componentOutputs[component].some((kind) => produced.has(kind))
  ))) return "Choose components that can render the selected tools' results.";
  const requiredOutput = baseline.at(-1)!.output;
  if (!completionCriteria.includes(requiredOutput) || completionCriteria.some((kind) => !produced.has(kind))) {
    return "The completion criteria must include the final verified result.";
  }
  if (inputs.length && !allowed.has("Form")) return "Include a form for customer inputs.";
  if (!Array.from(allowed).some((component) => componentOutputs[component].includes(requiredOutput))) return "Include a component for the final result.";
}

export type CapabilityDescriptor = ReturnType<typeof describe>;
export function describe(manifest: CapabilityManifest, includeInputs = false) {
  const { id, version, title, description, discovery, supportedGoals, experience, tools } = manifest;
  const operations = tools.map((ref) => toolIndex.get(ref)!);
  return {
    id, version, title, description, contexts: discovery.contexts, supportedGoals,
    outputs: operations.map(({ output }) => output),
    requires: [...new Set(operations.flatMap(({ uses }) => uses ?? []).filter((kind) => !operations.some(({ output }) => output === kind)))],
    components: experience.allowedComponents, planningCompanions: discovery.planningCompanions ?? [],
    ...(includeInputs && { inputs: manifest.inputs, mode: manifest.execution.mode }),
  };
}

function words(value: string) {
  return " " + value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
}
function textScore(query: string, item: CapabilityManifest) {
  const value = words(query);
  return Math.max(0, ...[...item.discovery.keywords, ...item.supportedGoals].map((phrase) => (
    value.includes(words(phrase)) ? words(phrase).trim().split(" ").length : 0
  )));
}

export class CapabilityRegistry {
  constructor(private readonly store: Store) {
    for (const definition of builtinCapabilities) {
      const issue = capabilityIssue(definition);
      if (issue) throw new Error(capabilityRef(definition) + " " + issue);
    }
  }

  list(principalId: string) {
    return [...builtinCapabilities, ...this.store.axe.list("capability_definitions", ownerFor(principalId), "published", 48)];
  }

  matching(principalId: string, query: string) {
    return this.list(principalId).filter((item) => textScore(query, item) > 0);
  }

  explicitMatches(principalId: string, message: string) {
    const affirmative = message.split(/[,;]|\b(?:and|but|instead)\b/gi).filter((clause) => (
      !/\b(?:do not|don['’]t|never|no longer)\b/i.test(clause)
    )).map(words);
    return this.list(principalId).filter((item) => (
      [...item.supportedGoals, ...item.discovery.explicitPhrases ?? []].some((phrase) => affirmative.some((clause) => clause.includes(words(phrase))))
    ));
  }

  discover(principalId: string, query: string, contextIds: string[], requiredOutputs: string[], limit: number) {
    const items = this.list(principalId);
    const matches = items.map((item) => ({ item, score: textScore(query, item) }));
    const contextSet = new Set(contextIds);
    const outputSet = new Set(requiredOutputs);
    const related = new Set(matches.filter(({ score }) => score > 0).flatMap(({ item }) => item.discovery.contexts));
    const found = matches.filter(({ item, score }) => (
      (contextIds.length ? item.discovery.contexts.some((id) => contextSet.has(id)) : score > 0 || item.discovery.contexts.some((id) => related.has(id)))
      && (!outputSet.size || describe(item).outputs.some((kind) => outputSet.has(kind)))
    )).sort((left, right) => right.score - left.score).map(({ item }) => item);
    if (outputSet.size) return found.slice(0, limit);
    const expanded = new Map<string, CapabilityManifest>();
    for (const item of found) {
      expanded.set(capabilityRef(item), item);
      for (const ref of item.discovery.planningCompanions ?? []) {
        const next = items.find((candidate) => capabilityRef(candidate) === ref);
        if (next) expanded.set(ref, next);
      }
    }
    return [...expanded.values()].slice(0, limit);
  }

  get(principalId: string, ref: string) {
    return this.list(principalId).find((item) => capabilityRef(item) === ref);
  }

  publish(principalId: string, value: unknown, preview = false) {
    const parsed = manifestSchema.safeParse(value);
    if (!parsed.success) throw new ApiError(400, "invalid_capability", "Check the capability manifest fields.");
    const manifest = parsed.data;
    const issue = capabilityIssue(manifest);
    if (issue) throw new ApiError(400, "invalid_capability", issue);
    const ref = capabilityRef(manifest);
    const existing = this.get(principalId, ref);
    if (existing) {
      if (isDeepStrictEqual(JSON.parse(JSON.stringify(existing)), JSON.parse(JSON.stringify(manifest)))) return existing;
      throw new ApiError(409, "capability_version_exists", "Publish changes under a new version.");
    }
    if (this.store.axe.list("capability_definitions", ownerFor(principalId), "published", 48).length >= 48) {
      throw new ApiError(409, "capability_limit", "The published capability limit has been reached.");
    }
    if (!preview) this.store.axe.insert("capability_definitions", ownerFor(principalId), ref, "published", manifest);
    return manifest;
  }

  tool(ref: string) {
    const tool = toolIndex.get(ref);
    if (!tool) throw new Error("UNREGISTERED_TOOL");
    return tool;
  }
}
