import host from "../../fixtures/host.json";
import type { z } from "zod";
import type { customerEventSchema } from "../../packages/contracts/agentic";
import { ApiError, type Store } from "./store";

export function simulateCustomerEvent(store: Store, principalId: string, input: z.infer<typeof customerEventSchema>, now: number) {
  const { personaId, eventId, type } = input;
  const persona = host.personas.find((value) => value.personaId === personaId);
  if (persona?.accountFundingStatus !== "unfunded") {
    throw new ApiError(400, "event_profile_unavailable", "Choose a profile awaiting its first deposit.");
  }
  const event = { eventId, type, customerRef: persona.syntheticMid, source: "mock-account-service" as const, occurredAt: now };
  const accepted = store.axe.applyFundingEvent({ principalId, personaId }, event);
  return { eventId, accepted, fundingStatus: "funded" as const };
}
