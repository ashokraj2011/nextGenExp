import { join } from "node:path";
import { z } from "zod";
import { domainPackIds, type DomainPackId } from "../../packages/contracts/domain-packs";

const tenantIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, "Use a tenant ID with lowercase letters, numbers, hyphens or underscores.");
export const serverTenantId = tenantIdSchema.parse(process.env.PZN_TENANT_ID ?? "pzn-local");

// Each deployment owns its data sources, credentials, designs and sfield persistence.
export function tenantDataDirectory(base: string, tenantId = serverTenantId) {
  return tenantId === "pzn-local" ? base : join(base, "tenants", tenantIdSchema.parse(tenantId));
}

export function tenantCookie(name: string) {
  return serverTenantId === "pzn-local" ? name : name + "_" + serverTenantId;
}

const grant = z.object({ owners: z.array(z.string().min(1)).default([]), users: z.array(z.string().min(1)).default([]) }).strict();
export function domainMemberships(value = process.env.PZN_DOMAIN_MEMBERSHIPS_JSON) {
  const grants = value === undefined ? undefined : z.record(z.enum(domainPackIds), grant).parse(JSON.parse(value));
  const admins = z.array(z.string().min(1)).parse(JSON.parse(process.env.PZN_TENANT_ADMINS_JSON ?? "[]"));
  const isTenantAdmin = (actor: string) => !grants || admins.includes(actor);
  const canOwn = (domain: DomainPackId, actor: string) => isTenantAdmin(actor) || Boolean(grants?.[domain]?.owners.includes(actor));
  const canRead = (domain: DomainPackId, user: string) => canOwn(domain, user) || Boolean(grants?.[domain]?.users.includes(user));
  return {
    restricted: grants !== undefined,
    isTenantAdmin,
    authoring: (actor: string) => domainPackIds.filter((id) => canOwn(id, actor)),
    library: (actor: string) => domainPackIds.filter((id) => canRead(id, actor)),
    chat(domain: DomainPackId, persona: string, operator?: string) {
      if (domain !== "wealth") return Boolean(operator && canRead(domain, operator));
      if (!grants || (operator && canOwn(domain, operator))) return true;
      return (!operator || operator === persona) && Boolean(grants.wealth?.users.includes(persona));
    },
  };
}
