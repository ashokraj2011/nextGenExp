import { z } from "zod";
import { recommendationDomainSchema } from "./recommendation-provider";

export const connectorKindSchema = z.enum(["rest_recommendation", "mcp_bridge", "rest_data"]);

export const externalConnectorSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,47}$/),
  name: z.string().trim().min(1).max(80),
  kind: connectorKindSchema,
  url: z.string().trim().url().max(320),
  method: z.enum(["GET", "POST"]).default("POST"),
  domains: z.array(recommendationDomainSchema).min(1).max(4),
  enabled: z.boolean(),
  timeoutMs: z.number().int().min(500).max(10_000).default(3_000),
  authHeaderName: z.string().trim().max(64).optional(),
  description: z.string().trim().max(240),
  updatedAt: z.string().trim().min(1).max(64),
}).strict();

export const connectorUpsertSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,47}$/).optional(),
  name: z.string().trim().min(1).max(80),
  kind: connectorKindSchema,
  url: z.string().trim().url().max(320),
  method: z.enum(["GET", "POST"]).default("POST"),
  domains: z.array(recommendationDomainSchema).min(1).max(4),
  enabled: z.boolean().default(false),
  timeoutMs: z.number().int().min(500).max(10_000).default(3_000),
  authHeaderName: z.string().trim().max(64).optional(),
  description: z.string().trim().max(240).default(""),
}).strict();

export type ConnectorKind = z.infer<typeof connectorKindSchema>;
export type ExternalConnector = z.infer<typeof externalConnectorSchema>;
export type ConnectorUpsertInput = z.input<typeof connectorUpsertSchema>;

export interface ConnectorTestResult {
  connectorId: string;
  ok: boolean;
  statusCode?: number;
  elapsedMs: number;
  message: string;
}
