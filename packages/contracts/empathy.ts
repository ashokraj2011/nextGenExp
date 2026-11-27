import { z } from "zod";

export const empathyAssessToolId = "cep.empathy.assess";
export const empathyAssessToolVersion = "1.0.0";
export const empathyAssessToolRef = `${empathyAssessToolId}@${empathyAssessToolVersion}`;

export const emotionalSentimentSchema = z.enum([
  "distressed",
  "concerned",
  "frustrated",
  "celebratory",
  "grateful",
  "neutral",
]);
export type EmotionalSentiment = z.infer<typeof emotionalSentimentSchema>;

export const emotionalLifeEventSchema = z.enum([
  "job_loss",
  "medical_hardship",
  "bereavement",
  "family_crisis",
  "home_purchase",
  "new_family",
  "retirement_transition",
  "career_milestone",
  "none",
]);
export type EmotionalLifeEvent = z.infer<typeof emotionalLifeEventSchema>;

export const emotionalSourceSchema = z.enum([
  "llm",
  "customer360_notes",
  "heuristic",
]);
export type EmotionalSource = z.infer<typeof emotionalSourceSchema>;

export const empathyAssessInputSchema = z.object({
  personaId: z.string().trim().min(1).max(120),
  userMessage: z.string().trim().min(1).max(2000),
  ordinal: z.number().int().min(1).max(1000).default(1),
  recentSummary: z.string().max(2400).optional(),
  customerNotes: z.string().max(800).optional(),
  hasRetirementHistory: z.boolean().optional(),
}).strict();
export type EmpathyAssessInput = z.infer<typeof empathyAssessInputSchema>;

export const emotionalAssessmentSchema = z.object({
  sentiment: emotionalSentimentSchema,
  lifeEvent: emotionalLifeEventSchema,
  suppressPromotions: z.boolean(),
  empathyLead: z.string().max(320),
  customerNoteToSave: z.string().max(220).optional(),
  reason: z.string().trim().min(1).max(280),
  source: emotionalSourceSchema,
  fromCurrentMessage: z.boolean(),
  toolRef: z.string().trim().min(1).max(120),
}).strict();
export type EmotionalAssessment = z.infer<typeof emotionalAssessmentSchema>;

/** Closed JSON Schema objects matching sfield's strict JsonSchema subset. */
export const empathyAssessInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["personaId", "userMessage", "ordinal"],
  properties: {
    personaId: { type: "string", minLength: 1, maxLength: 120 },
    userMessage: { type: "string", minLength: 1, maxLength: 2000 },
    ordinal: { type: "integer", minimum: 1, maximum: 1000 },
    recentSummary: { type: "string", maxLength: 2400 },
    customerNotes: { type: "string", maxLength: 800 },
    hasRetirementHistory: { type: "boolean" },
  },
} as const;

export const emotionalAssessmentJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "sentiment",
    "lifeEvent",
    "suppressPromotions",
    "empathyLead",
    "reason",
    "source",
    "fromCurrentMessage",
    "toolRef",
  ],
  properties: {
    sentiment: {
      type: "string",
      enum: ["distressed", "concerned", "frustrated", "celebratory", "grateful", "neutral"],
    },
    lifeEvent: {
      type: "string",
      enum: [
        "job_loss",
        "medical_hardship",
        "bereavement",
        "family_crisis",
        "home_purchase",
        "new_family",
        "retirement_transition",
        "career_milestone",
        "none",
      ],
    },
    suppressPromotions: { type: "boolean" },
    empathyLead: { type: "string", maxLength: 320 },
    customerNoteToSave: { type: "string", maxLength: 220 },
    reason: { type: "string", minLength: 1, maxLength: 280 },
    source: { type: "string", enum: ["llm", "customer360_notes", "heuristic"] },
    fromCurrentMessage: { type: "boolean" },
    toolRef: { type: "string", minLength: 1, maxLength: 120 },
  },
} as const;
