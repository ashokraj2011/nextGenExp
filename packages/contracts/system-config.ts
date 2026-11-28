import { z } from "zod";

export const systemConfigKindSchema = z.enum([
  "smass_virtual_model",
  "smass_relation",
  "sphoton_exposure",
  "integration",
  "task_contract",
  "mcp_exposure",
]);
export type SystemConfigKind = z.infer<typeof systemConfigKindSchema>;

export const systemConfigStatusSchema = z.enum(["draft", "published", "deprecated", "deleted"]);
export type SystemConfigStatus = z.infer<typeof systemConfigStatusSchema>;

export const systemConfigEntitySchema = z.object({
  tenantId: z.string(),
  domainId: z.string(),
  kind: systemConfigKindSchema,
  entityId: z.string(),
  label: z.string(),
  status: systemConfigStatusSchema,
  revision: z.number().int().positive(),
  digest: z.string(),
  payload: z.unknown(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type SystemConfigEntity = z.infer<typeof systemConfigEntitySchema>;

export const systemConfigRevisionSchema = z.object({
  tenantId: z.string(),
  domainId: z.string(),
  kind: systemConfigKindSchema,
  entityId: z.string(),
  revision: z.number().int().positive(),
  status: systemConfigStatusSchema,
  digest: z.string(),
  payload: z.unknown(),
  changeNote: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type SystemConfigRevision = z.infer<typeof systemConfigRevisionSchema>;

export const systemConfigBundleSchema = z.object({
  format: z.literal("cep.system.bundle@1.0.0"),
  tenantId: z.string().min(1).max(80),
  exportedAt: z.string(),
  bundleDigest: z.string().min(16).max(128),
  entities: z.array(
    z.object({
      domainId: z.string().min(1).max(64),
      kind: systemConfigKindSchema,
      entityId: z.string().min(1).max(160),
      label: z.string().min(1).max(160),
      status: z.enum(["draft", "published", "deprecated"]),
      payload: z.unknown(),
    }),
  ).max(500),
}).strict();
export type SystemConfigBundle = z.infer<typeof systemConfigBundleSchema>;

export const systemRollbackRequestSchema = z.object({
  domainId: z.string().trim().min(1).max(64),
  kind: systemConfigKindSchema,
  entityId: z.string().trim().min(1).max(160),
  targetRevision: z.number().int().positive(),
}).strict();

export const systemCopilotRequestSchema = z.object({
  message: z.string().trim().min(1).max(4000),
}).strict();

export type SystemCopilotCard =
  | {
      kind: "system_catalog";
      tenantId: string;
      entities: SystemConfigEntity[];
      countsByKind: Record<string, number>;
      filterKind?: SystemConfigKind;
    }
  | {
      kind: "system_history";
      domainId: string;
      entityKind: SystemConfigKind;
      entityId: string;
      revisions: SystemConfigRevision[];
    }
  | {
      kind: "system_bundle";
      bundle: SystemConfigBundle;
      mode: "export" | "import";
    }
  | {
      kind: "system_schema";
      tenantId: string;
      tables: Array<{ name: string; primaryKey: string[]; columns: Array<{ name: string; type: string; note: string }> }>;
      mermaidEr: string;
      totalEntities: number;
      totalRevisions: number;
    }
  | {
      kind: "system_health";
      tenantId: string;
      totalEntities: number;
      totalRevisions: number;
      driftCount: number;
      driftIssues: Array<{ domainId: string; modelId: string; message: string }>;
      domains: Array<{ domainId: string; entityCount: number; publishedVirtualTools: number }>;
    };

export type SystemCopilotResponse = {
  reply: string;
  cards: SystemCopilotCard[];
  suggestedPrompts: string[];
};
