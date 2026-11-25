import { z } from "zod";
import { recommendationDomainSchema } from "./recommendation-provider";

export const mcpDiscoveredToolSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(260),
  effect: z.enum(["read", "write"]),
  riskLevel: z.enum(["low", "medium", "high"]),
  parameters: z.array(z.object({
    name: z.string(),
    type: z.string(),
    required: z.boolean(),
    description: z.string().optional(),
  })),
  suggestedConnectorId: z.string(),
  suggestedDomain: recommendationDomainSchema,
  alreadyImported: z.boolean(),
});
export type McpDiscoveredTool = z.infer<typeof mcpDiscoveredToolSchema>;

export const mcpDiscoveryResultSchema = z.object({
  serverUrl: z.string(),
  serverName: z.string(),
  protocolVersion: z.string(),
  transport: z.enum(["http_jsonrpc", "builtin_sandbox"]),
  discoveredAt: z.string(),
  tools: z.array(mcpDiscoveredToolSchema),
});
export type McpDiscoveryResult = z.infer<typeof mcpDiscoveryResultSchema>;

export const mcpDiscoverRequestSchema = z.object({
  serverUrl: z.string().trim().min(4).max(260),
  authHeaderName: z.string().trim().max(64).optional(),
  authEnvVar: z.string().trim().max(64).optional(),
}).strict();

export const mcpImportRequestSchema = z.object({
  serverUrl: z.string().trim().min(4).max(260),
  toolName: z.string().trim().min(1).max(80),
  description: z.string().trim().max(260),
  effect: z.enum(["read", "write"]),
  domain: recommendationDomainSchema,
  requiresApproval: z.boolean().default(true),
  dualControl: z.boolean().default(false),
  authHeaderName: z.string().trim().max(64).optional(),
  authEnvVar: z.string().trim().max(64).optional(),
}).strict();
