/**
 * Domain-agnostic Principal & Agent-to-Agent (On-Behalf-Of) identity helpers for @sfield/core.
 *
 * Allows any domain to carry its own entity identifiers (`mid`, `mrn`, `customerId`, `accountId`,
 * `agentId`, etc.) without hardcoding domain-specific ID fields into the SDK, and enables first-class
 * AI agent callers (`kind: "agent"`) acting autonomously or on behalf of a human (`actingFor`).
 */
import type { ActingForIdentity, JsonObject, Principal, PrincipalKind } from "../types/common.js";

export interface CreatePrincipalInput {
  tenantId: string;
  subjectId: string;
  kind?: PrincipalKind;
  roles?: readonly string[];
  identifiers?: Readonly<Record<string, string>>;
  attributes?: Readonly<Record<string, string>>;
  actingFor?: ActingForIdentity;
}

export interface CreateAgentPrincipalInput {
  tenantId: string;
  /** Logical identifier of the calling agent (e.g., `"portfolio-rebalancer"`). */
  agentId: string;
  roles?: readonly string[];
  /** Optional human or service subject this agent is acting on behalf of (RFC 8693 Act-As / OBO). */
  actingFor?: ActingForIdentity;
  identifiers?: Readonly<Record<string, string>>;
  attributes?: Readonly<Record<string, string>>;
}

/** Builds a normalized, host-authenticated Principal for any domain or actor class. */
export function createPrincipal(input: CreatePrincipalInput): Principal {
  const identifiers = input.identifiers ? { ...input.identifiers } : undefined;
  const attributes: Record<string, string> = {
    ...(identifiers ?? {}),
    ...(input.attributes ?? {}),
  };
  return {
    tenantId: input.tenantId,
    subjectId: input.subjectId,
    kind: input.kind ?? "human",
    roles: [...(input.roles ?? [])],
    attributes,
    ...(identifiers ? { identifiers } : {}),
    ...(input.actingFor ? { actingFor: { ...input.actingFor, ...(input.actingFor.identifiers ? { identifiers: { ...input.actingFor.identifiers } } : {}) } } : {}),
  };
}

/**
 * Mints a verified `kind: "agent"` Principal for an AI agent calling into sfield
 * (either autonomously or on behalf of a human/service via `actingFor`).
 */
export function createAgentPrincipal(input: CreateAgentPrincipalInput): Principal {
  const subjectId = input.agentId.startsWith("agent:") ? input.agentId : `agent:${input.agentId}`;
  const identifiers: Record<string, string> = {
    agentId: input.agentId,
    ...(input.identifiers ?? {}),
  };
  return createPrincipal({
    tenantId: input.tenantId,
    subjectId,
    kind: "agent",
    roles: input.roles ?? ["agent"],
    identifiers,
    attributes: {
      agentId: input.agentId,
      ...(input.actingFor ? { actingForSubjectId: input.actingFor.subjectId } : {}),
      ...(input.attributes ?? {}),
    },
    ...(input.actingFor ? { actingFor: input.actingFor } : {}),
  });
}

/** Returns the actor class of a Principal (defaults to `"human"`). */
export function principalKindOf(principal: Principal): PrincipalKind {
  return principal.kind ?? "human";
}

/** Returns true when the Principal represents an AI agent caller. */
export function isAgentPrincipal(principal: Principal): boolean {
  return principalKindOf(principal) === "agent";
}

/**
 * Returns the represented subjectId (`actingFor.subjectId` when an agent/service acts on behalf
 * of a user, otherwise `principal.subjectId`).
 */
export function effectiveSubjectId(principal: Principal): string {
  return principal.actingFor?.subjectId ?? principal.subjectId;
}

/**
 * Resolves any domain identifier key (e.g., `"mid"`, `"mrn"`, `"customerId"`, `"agentId"`) from
 * `principal.identifiers`, `principal.attributes`, or (by default) `principal.actingFor.identifiers`.
 */
export function resolveIdentifier(
  principal: Principal,
  key: string,
  opts: { includeActingFor?: boolean } = {},
): string | undefined {
  const direct = principal.identifiers?.[key];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const attr = principal.attributes?.[key];
  if (typeof attr === "string" && attr.length > 0) return attr;
  if (opts.includeActingFor !== false) {
    const delegated = principal.actingFor?.identifiers?.[key];
    if (typeof delegated === "string" && delegated.length > 0) return delegated;
  }
  return undefined;
}

/**
 * Converts a Principal into a plain JsonObject root for declarative `{ ref: "principal.*" }`
 * tool resource and operation bindings.
 */
export function principalToBindingRoot(principal: Principal): JsonObject {
  const mergedIdentifiers: Record<string, string> = {
    ...(principal.actingFor?.identifiers ?? {}),
    ...(principal.attributes ?? {}),
    ...(principal.identifiers ?? {}),
  };
  const root: JsonObject = {
    tenantId: principal.tenantId,
    subjectId: principal.subjectId,
    effectiveSubjectId: effectiveSubjectId(principal),
    kind: principalKindOf(principal),
    roles: [...principal.roles],
    attributes: { ...principal.attributes },
    identifiers: mergedIdentifiers,
  };
  if (principal.actingFor) {
    root["actingFor"] = {
      subjectId: principal.actingFor.subjectId,
      kind: principal.actingFor.kind ?? "human",
      identifiers: { ...(principal.actingFor.identifiers ?? {}) },
    };
  }
  return root;
}
