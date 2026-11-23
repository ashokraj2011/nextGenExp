import { capabilityRef, type CapabilityManifest, type EligibilityGrant } from "../../packages/contracts/agentic";
import { DECISION_TTL } from "../../packages/contracts/domain";
import { makeId } from "../../packages/experience/compile";
import { requireCheck } from "../../packages/experience/verify";
import type { Recommendation } from "../../packages/ts-adapter/recommendations";
import type { Store, TurnRecord } from "./store";

export type EligibilityDecision = {
  id: string; contextId: string; customerRef: string; evaluatedAt: number;
  recommendations: Recommendation[]; contentIds: string[];
};

export class EligibilityAuthority {
  constructor(private readonly store: Store, private readonly now: () => number) {}

  issue(turn: TurnRecord, runId: string, decision: EligibilityDecision, manifest: CapabilityManifest) {
    const { id: capabilityId, version, eligibility, tools } = manifest;
    const issuedAt = this.now();
    if (!manifest.discovery.contexts.includes(decision.contextId) || decision.evaluatedAt + DECISION_TTL <= issuedAt
      || !decision.recommendations.some((entry) => (
        entry.kind === eligibility.kind && capabilityRef(entry) === capabilityRef(eligibility)
      ))) return;
    const grant: EligibilityGrant = {
      grantId: makeId("grant"), customerRef: decision.customerRef, runId, turnId: turn.public.id,
      decisionId: decision.id, contextId: decision.contextId, issuedAt, expiresAt: decision.evaluatedAt + DECISION_TTL,
      allowedUses: [{ capabilityId, version, tools, operation: "preview" }],
    };
    this.store.axe.insert("eligibility_grants", turn.scope, grant.grantId, turn.public.id, grant);
    return grant;
  }

  require(turn: TurnRecord, expected: EligibilityGrant, toolRef: string, manifest: CapabilityManifest, mid: string) {
    const grant = this.store.axe.get("eligibility_grants", turn.scope, expected.grantId);
    requireCheck(grant?.runId === expected.runId && grant.turnId === turn.public.id && grant.customerRef === mid
      && grant.decisionId === expected.decisionId && grant.expiresAt > this.now()
      && manifest.discovery.contexts.includes(grant.contextId)
      && grant.allowedUses.some(({ capabilityId, version, operation, tools }) => (
        capabilityId === manifest.id && version === manifest.version && operation === "preview" && tools.includes(toolRef)
      )), "ELIGIBILITY_GRANT_REQUIRED");
    return grant;
  }
}
