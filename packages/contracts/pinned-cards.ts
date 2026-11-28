import { z } from "zod";
import { domainPackIds, type DomainPackId } from "./domain-packs";
import type { DisplayExperience } from "./surface";

export const createPinnedCardSchema = z.object({
  domainId: z.enum(domainPackIds),
  personaId: z.string().trim().min(1).max(80).optional(),
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(1000),
  sourceTurnId: z.string().trim().min(1).max(120).optional(),
  toolRefs: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
  experience: z.record(z.string(), z.unknown()),
}).strict();

export type CreatePinnedCardInput = z.infer<typeof createPinnedCardSchema>;

export interface PinnedLiveCard {
  id: string;
  domainId: DomainPackId;
  personaId?: string;
  title: string;
  prompt: string;
  sourceTurnId?: string;
  toolRefs: string[];
  experience: DisplayExperience;
  createdAt: number;
  refreshedAt: number;
  liveBacked: boolean;
}
