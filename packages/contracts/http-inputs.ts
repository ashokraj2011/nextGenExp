import { ActionMessageSchema } from "@a2ui/web_core/v1_0";
import { z } from "zod";
import { MAX_MESSAGE_LENGTH } from "./domain";

export const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const requestId = z.string().regex(idPattern);

export const messageBody = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH), clientRequestId: requestId,
}).strict();
export const createBody = z.object({ personaId: requestId, scenarioId: requestId }).strict();
export const retryBody = z.object({ clientRequestId: requestId }).strict();
export const actionBody = z.object({ clientRequestId: requestId, envelope: ActionMessageSchema }).strict();
export const eventBody = z.object({
  eventId: requestId, experienceId: requestId, type: z.enum(["rendered", "render_fallback", "helpful", "unhelpful"]),
}).strict();
