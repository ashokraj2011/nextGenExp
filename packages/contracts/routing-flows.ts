import { z } from "zod";
import { CEP_CAPABILITIES, cepCapabilityIdSchema, type CepCapabilityDefinition } from "./capabilities-catalog";
import { domainPackIds, type DomainPackId } from "./domain-packs";

export const flowScopeSchema = z.enum(["tenant", ...domainPackIds]);
export type FlowScope = z.infer<typeof flowScopeSchema>;
const line = (limit: number) => z.string().trim().min(1).max(limit).regex(/^[^\r\n]+$/);
const overrideSchema = z.object({
  enabled: z.boolean().optional(),
  description: line(600).optional(),
  examples: z.array(line(200)).max(12).optional(),
}).strict();
export const flowOverridesSchema = z.record(cepCapabilityIdSchema, overrideSchema);
export type FlowOverride = z.infer<typeof overrideSchema>;
export type FlowOverrides = z.infer<typeof flowOverridesSchema>;
export type FlowOption = CepCapabilityDefinition & { enabled: boolean };
export type FlowCatalogSetup = {
  tenantId: string; scope: FlowScope; editableScopes: FlowScope[];
  inherited: FlowOption[]; overrides: FlowOverrides;
};
export type TurnFlowCatalog = {
  tenantId: string; domainId: DomainPackId; audience: "customer" | "operator";
  flows: CepCapabilityDefinition[];
};
const catalogDomains = { wealth: "wealth", it_ops: "operations", sales_revops: "sales" } as const;

export function applyFlowOverride(flow: FlowOption, change?: FlowOverride): FlowOption {
  return {
    ...flow, enabled: flow.enabled && change?.enabled !== false,
    description: change?.description ?? flow.description, examples: change?.examples ?? flow.examples,
  };
}

export function inheritedFlows(scope: FlowScope, tenant: FlowOverrides): FlowOption[] {
  return CEP_CAPABILITIES.filter((flow) => scope === "tenant" || flow.domain === catalogDomains[scope] || flow.domain === "platform")
    .map((flow) => applyFlowOverride({ ...flow, enabled: true }, scope === "tenant" ? undefined : tenant[flow.id]));
}

export function resolveTurnFlows(tenantId: string, domainId: DomainPackId, audience: TurnFlowCatalog["audience"],
  tenantOperator: boolean, tenant: FlowOverrides, domain: FlowOverrides): TurnFlowCatalog {
  const flows = inheritedFlows(domainId, tenant).map((flow) => applyFlowOverride(flow, domain[flow.id]))
    .filter((flow) => flow.enabled && (flow.domain !== "platform" || flow.id === "custom_dynamic_ui" || (audience === "operator" && tenantOperator)))
    .map(({ enabled: _enabled, ...flow }) => flow);
  return { tenantId, domainId, audience, flows };
}
