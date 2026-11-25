import { ActionMessageSchema } from "@a2ui/web_core/v1_0";
import { z } from "zod";
import { domainPackIds } from "./domain-packs";
import { MAX_MESSAGE_LENGTH } from "./domain";
import { pendingActionsContext } from "./workspace";

export const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const requestId = z.string().regex(idPattern);

export const messageBody = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH), clientRequestId: requestId,
}).strict();
export const createBody = z.union([
  z.object({ personaId: requestId, scenarioId: requestId, domainId: z.literal("wealth").default("wealth") }).strict(),
  z.object({ domainId: z.enum(domainPackIds).exclude(["wealth"]), personaId: requestId.optional(), scenarioId: requestId.optional() }).strict(),
]);
export const conversationChangeBody = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("rename"), title: z.string().trim().min(1).max(80).transform((title) => title.replace(/\s+/g, " ")) }).strict(),
  z.object({ operation: z.literal("archive") }).strict(),
  z.object({ operation: z.literal("restore") }).strict(),
]);
export const retryBody = z.object({ clientRequestId: requestId }).strict();
export const previewFundingBody = retryBody.extend({ source: z.literal(pendingActionsContext).optional() });
export const actionBody = z.object({ clientRequestId: requestId, envelope: ActionMessageSchema }).strict();
export const eventBody = z.object({
  eventId: requestId, experienceId: requestId, type: z.enum(["rendered", "render_fallback", "helpful", "unhelpful"]),
}).strict();
