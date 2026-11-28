import { z } from "zod";

export const sphotonFieldTypeSchema = z.enum(["string", "number", "integer", "boolean", "array", "object"]);
export type SphotonFieldType = z.infer<typeof sphotonFieldTypeSchema>;

export const sphotonFormatSchema = z.enum([
  "currency_cents",
  "currency",
  "percent",
  "month",
  "date",
  "number",
  "text",
  "series",
]);
export type SphotonFormat = z.infer<typeof sphotonFormatSchema>;

export const toolRefSchema = z.string().regex(/^[a-z][a-z0-9._-]{1,80}@\d+\.\d+\.\d+$/);

export const sphotonSourceSpecSchema = z.object({
  toolRef: toolRefSchema,
  read: z.enum(["reuseVerifiedTurnResult", "alwaysInvoke"]).default("reuseVerifiedTurnResult"),
  inputs: z.record(z.unknown()).optional(),
}).strict();
export type SphotonSourceSpec = z.infer<typeof sphotonSourceSpecSchema>;

export const sphotonFieldBindingSchema = z.object({
  field: z.string().trim().min(1).max(80),
  from: z.string().trim().regex(/^[a-zA-Z][a-zA-Z0-9_-]*\.data\.[a-zA-Z0-9_.-]+$/),
  format: sphotonFormatSchema.optional(),
  required: z.boolean().optional(),
  label: z.string().trim().min(1).max(80).optional(),
}).strict();
export type SphotonFieldBinding = z.infer<typeof sphotonFieldBindingSchema>;

export const sphotonActionResultBindingSchema = z.object({
  field: z.string().trim().min(1).max(80),
  from: z.string().trim().min(1).max(120),
  format: sphotonFormatSchema.optional(),
}).strict();
export type SphotonActionResultBinding = z.infer<typeof sphotonActionResultBindingSchema>;

export const sphotonCardActionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  label: z.string().trim().min(1).max(80),
  toolRef: toolRefSchema,
  fixedInputs: z.record(z.unknown()).optional(),
  followUpInputs: z.array(z.string().trim().min(1).max(60)).max(8).optional(),
  update: z.enum(["originalCard", "newTurn"]).default("originalCard"),
  resultBindings: z.array(sphotonActionResultBindingSchema).max(12).optional(),
}).strict();
export type SphotonCardAction = z.infer<typeof sphotonCardActionSchema>;

export const sphotonUnavailableStateSchema = z.object({
  title: z.string().trim().min(1).max(90),
  message: z.string().trim().min(1).max(240),
}).strict();
export type SphotonUnavailableState = z.infer<typeof sphotonUnavailableStateSchema>;

export const sphotonCardBindingSchema = z.object({
  component: z.string().trim().min(1).max(64),
  sources: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/), sphotonSourceSpecSchema)
    .refine((sources) => Object.keys(sources).length > 0 && Object.keys(sources).length <= 6, {
      message: "Card binding must declare between 1 and 6 tool sources.",
    }),
  bindings: z.array(sphotonFieldBindingSchema).min(1).max(24),
  actions: z.array(sphotonCardActionSchema).max(6).optional(),
  unavailableState: sphotonUnavailableStateSchema.optional(),
}).strict();
export type SphotonCardBinding = z.infer<typeof sphotonCardBindingSchema>;

export type SphotonBlock = {
  component: string;
  props: Record<string, unknown>;
};

export type SphotonCatalogTool = {
  toolRef: string;
  id: string;
  version: string;
  label: string;
  description?: string;
  contractFingerprint: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
};

export type SphotonCatalogField = {
  id: string;
  toolRef: string;
  outputPath: string;
  type: SphotonFieldType;
  label: string;
  group: string;
  description?: string;
  supportedFormats: SphotonFormat[];
  defaultFormat?: SphotonFormat;
  legacyBindingKey?: string;
  sampleValue?: unknown;
};

export type SphotonCatalogAction = {
  id: string;
  toolRef: string;
  label: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  fixedInputFields: Record<string, SphotonFieldType>;
  followUpInputFields: string[];
  defaultUpdate: "originalCard" | "newTurn";
  contractFingerprint: string;
};

export type SphotonBindingCatalog = {
  tenantId: string;
  domainId: string;
  catalogFingerprint: string;
  tools: SphotonCatalogTool[];
  fields: SphotonCatalogField[];
  actions: SphotonCatalogAction[];
};

export type SphotonExecutionScope = {
  tenantId: string;
  domainId: string;
  principalId: string;
  customerId?: string;
  conversationId?: string;
  turnId?: string;
  mode: "draft_preview" | "approval_preview" | "customer_chat";
};

export type SphotonSignedActionPayload = {
  actionRefId: string;
  cardId: string;
  designId?: string;
  designRevision?: number;
  actionId: string;
  label: string;
  toolRef: string;
  resolvedInputs: Record<string, unknown>;
  followUpInputs: string[];
  update: "originalCard" | "newTurn";
  resultBindings?: SphotonActionResultBinding[];
  issuedAt: number;
  expiresAt: number;
};

export type SphotonSignedActionRef = SphotonSignedActionPayload & {
  seal: string;
};

export type SphotonComponentFieldRule = {
  types: readonly SphotonFieldType[];
  required?: boolean;
};

export type SphotonComponentSchema = {
  allowDynamicFields?: boolean;
  fields: Record<string, SphotonComponentFieldRule>;
};

export function canonicalStableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalStableJson).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return "{" + entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalStableJson(entry)}`).join(",") + "}";
}

export function parseBindingSourcePath(from: string): { slot: string; outputPath: string } | null {
  const match = /^([a-zA-Z][a-zA-Z0-9_-]*)\.data\.([a-zA-Z0-9_.-]+)$/.exec(from);
  if (!match) return null;
  return { slot: match[1], outputPath: match[2] };
}
