import { capabilityRef, planProposalSchema, type CapabilityManifest, type OutputKind, type PlanProposal, type PlanStep } from "../../packages/contracts/agentic";
import { requireCheck } from "../../packages/experience/verify";
import { describe, type CapabilityRegistry } from "./capability-registry";

export function verifyPlan(
  proposal: unknown, manifests: ReadonlyMap<string, CapabilityManifest>, registry: CapabilityRegistry, removeUnusedDependencies = false,
): PlanProposal {
  const input = planProposalSchema.safeParse(proposal);
  requireCheck(input.success, "PLAN_SCHEMA_INVALID");
  const { steps } = input.data;
  const byId = new Map(steps.map((step) => [step.id, step]));
  const refs = steps.map(({ capabilityId: id, version }) => capabilityRef({ id, version }));
  requireCheck(byId.size === steps.length && new Set(refs).size === refs.length, "PLAN_DUPLICATE_STEP");
  requireCheck(steps.some(({ required }) => required), "PLAN_REQUIRED_OBJECTIVE_MISSING");
  for (const step of steps) {
    requireCheck(new Set(step.dependsOn).size === step.dependsOn.length && step.dependsOn.every((id) => byId.has(id)), "PLAN_UNKNOWN_DEPENDENCY");
  }
  // Check the graph before adapting any dependencies.
  const ancestorIds = new Map<string, Set<string>>();
  for (const step of steps) {
    const ancestors = new Set<string>();
    const visiting = new Set([step.id]);
    function visit(id: string) {
      requireCheck(!visiting.has(id), "PLAN_CYCLE");
      if (ancestors.has(id)) return;
      visiting.add(id);
      for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
      visiting.delete(id);
      ancestors.add(id);
    }
    for (const id of step.dependsOn) visit(id);
    ancestorIds.set(step.id, ancestors);
  }
  for (const [index, step] of steps.entries()) {
    const manifest = manifests.get(refs[index]);
    requireCheck(manifest, "CAPABILITY_NOT_DISCOVERED");
    const ancestors = ancestorIds.get(step.id)!;
    const sources = new Map<OutputKind, number>();
    for (const id of ancestors) {
      const dependency = byId.get(id)!;
      const definition = manifests.get(capabilityRef({ id: dependency.capabilityId, version: dependency.version }));
      requireCheck(definition, "CAPABILITY_NOT_DISCOVERED");
      for (const ref of definition.tools) {
        const kind = registry.tool(ref).output;
        sources.set(kind, (sources.get(kind) ?? 0) + 1);
      }
    }
    const ownTools = manifest.tools.map((ref) => registry.tool(ref));
    const own = new Set(ownTools.map(({ output }) => output));
    const required = new Set(ownTools.flatMap(({ uses }) => uses ?? []).filter((kind) => !own.has(kind)));
    for (const kind of required) {
      requireCheck(sources.get(kind) === 1, sources.has(kind) ? "PLAN_AMBIGUOUS_EVIDENCE_BINDING" : "PLAN_MISSING_EVIDENCE_DEPENDENCY");
    }
    const used = step.dependsOn.filter((id) => {
      const item = byId.get(id)!;
      const dependency = manifests.get(capabilityRef({ id: item.capabilityId, version: item.version }))!;
      return dependency.tools.some((ref) => required.has(registry.tool(ref).output));
    });
    if (removeUnusedDependencies) step.dependsOn = used;
    else requireCheck(used.length === step.dependsOn.length, "PLAN_UNUSED_DEPENDENCY");
  }
  return input.data;
}

export function independentSteps(steps: PlanStep[], completed: ReadonlySet<string>, limit: number) {
  return steps.filter((step) => !completed.has(step.id) && step.dependsOn.every((id) => completed.has(id))).slice(0, limit);
}

/** Add clear requests from the registered descriptions, with dependencies supplied by discovered capabilities. */
export function includeRequestedCapabilities(
  base: PlanProposal, requested: CapabilityManifest[], admitted: ReadonlyMap<string, CapabilityManifest>,
) {
  const steps = [...base.steps];
  function add(manifest: CapabilityManifest, visiting: ReadonlySet<string>): string | undefined {
    const ref = capabilityRef(manifest);
    const existing = steps.find((step) => capabilityRef({ id: step.capabilityId, version: step.version }) === ref);
    if (existing) return existing.id;
    if (steps.length >= 6 || visiting.has(ref) || !admitted.has(ref)) return;
    const children = new Set([...visiting, ref]);
    const required = describe(manifest).requires;
    const dependsOn: string[] = [];
    for (const kind of required) {
      const present = steps.find(({ capabilityId: id, version }) => {
        const item = admitted.get(capabilityRef({ id, version }));
        return item && describe(item).outputs.includes(kind);
      });
      const producer = [...admitted.values()].find((item) => describe(item).outputs.includes(kind));
      const dependency = present?.id ?? (producer && add(producer, children));
      if (!dependency) return;
      dependsOn.push(dependency);
    }
    if (steps.length >= 6) return;
    let id = "requested_" + steps.length;
    while (steps.some((step) => step.id === id)) id += "_";
    steps.push({ id, capabilityId: manifest.id, version: manifest.version, dependsOn: [...new Set(dependsOn)], required: true });
    return id;
  }
  for (const manifest of requested) add(manifest, new Set());
  return { ...base, steps };
}
