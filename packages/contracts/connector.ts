import { z } from "zod";
import { recommendationDomainSchema } from "./recommendation-provider";

export const connectorKindSchema = z.enum(["rest_recommendation", "mcp_bridge", "rest_data", "rest_action"]);
export const connectorEffectSchema = z.enum(["read", "write"]);

const connectorUrlSchema = z.string().trim().min(1).max(320).refine(
  (value) => /^https?:\/\/.+/.test(value) || /^sandbox:\/\/[a-z0-9/_-]+$/i.test(value),
  "Must be an http(s):// or sandbox:// URL.",
);

export const externalConnectorSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,47}$/),
  name: z.string().trim().min(1).max(80),
  kind: connectorKindSchema,
  url: connectorUrlSchema,
  method: z.enum(["GET", "POST"]).default("POST"),
  domains: z.array(recommendationDomainSchema).min(1).max(4),
  enabled: z.boolean(),
  timeoutMs: z.number().int().min(500).max(10_000).default(3_000),
  authHeaderName: z.string().trim().max(64).optional(),
  authEnvVar: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional(),
  effect: connectorEffectSchema.default("read"),
  requiresApproval: z.boolean().default(false),
  dualControl: z.boolean().default(false),
  sandboxMode: z.boolean().default(false),
  description: z.string().trim().max(240),
  updatedAt: z.string().trim().min(1).max(64),
}).strict();

export const connectorUpsertSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,47}$/).optional(),
  name: z.string().trim().min(1).max(80),
  kind: connectorKindSchema,
  url: connectorUrlSchema,
  method: z.enum(["GET", "POST"]).default("POST"),
  domains: z.array(recommendationDomainSchema).min(1).max(4),
  enabled: z.boolean().default(false),
  timeoutMs: z.number().int().min(500).max(10_000).default(3_000),
  authHeaderName: z.string().trim().max(64).optional(),
  authEnvVar: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional(),
  effect: connectorEffectSchema.default("read"),
  requiresApproval: z.boolean().default(false),
  dualControl: z.boolean().default(false),
  sandboxMode: z.boolean().default(false),
  description: z.string().trim().max(240).default(""),
}).strict();

export const connectorInvokeInputSchema = z.object({
  connectorId: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,47}$/),
  action: z.string().trim().min(1).max(64).default("invoke"),
  actor: z.string().trim().min(1).max(80).default("CEP Operator"),
  note: z.string().trim().max(240).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict();

export type ConnectorKind = z.infer<typeof connectorKindSchema>;
export type ConnectorEffect = z.infer<typeof connectorEffectSchema>;
export type ExternalConnector = z.infer<typeof externalConnectorSchema>;
export type ConnectorUpsertInput = z.input<typeof connectorUpsertSchema>;
export type ConnectorInvokeInput = z.input<typeof connectorInvokeInputSchema>;

export interface ConnectorTestResult {
  connectorId: string;
  ok: boolean;
  statusCode?: number;
  elapsedMs: number;
  message: string;
}

export interface ConnectorInvokeExecution {
  ok: boolean;
  connectorId: string;
  connectorName: string;
  statusCode: number;
  elapsedMs: number;
  summary: string;
  responsePreview: string;
  sandbox: boolean;
  sfieldRunId?: string;
  auditId?: string;
}
