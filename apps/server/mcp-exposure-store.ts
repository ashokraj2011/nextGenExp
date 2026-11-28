import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { empathyAssessToolRef } from "../../packages/contracts/empathy";
import type { SystemConfigStore } from "./system-config-store";

export const customer360ReadToolId = "cep.customer360.read";
export const customer360ReadToolVersion = "1.0.0";
export const customer360ReadToolRef = `${customer360ReadToolId}@${customer360ReadToolVersion}`;

export const mcpExposureConfigSchema = z.object({
  enabledToolRefs: z.array(z.string().trim().min(1).max(128)).max(40),
  includeKnowledgeSearch: z.boolean().default(true),
  includePublishedTasks: z.boolean().default(true),
}).strict();

export type McpExposureConfig = z.infer<typeof mcpExposureConfigSchema>;

const DEFAULT_CONFIG: McpExposureConfig = {
  enabledToolRefs: [empathyAssessToolRef],
  includeKnowledgeSearch: true,
  includePublishedTasks: true,
};

export const STANDALONE_SFIELD_MCP_TOOLS: ReadonlyArray<{
  ref: string;
  label: string;
  description: string;
  effect: "read";
  sampleArgs: Record<string, unknown>;
}> = [
  {
    ref: empathyAssessToolRef,
    label: "Empathy & Life-Event Assessor",
    description: "Assesses customer sentiment, life events, and promotion suppression from chat + Customer 360 notes.",
    effect: "read",
    sampleArgs: {
      personaId: "demo-learner",
      userMessage: "I just lost my job, what should I do?",
      ordinal: 1,
    },
  },
  {
    ref: customer360ReadToolRef,
    label: "Customer 360 Profile Snapshot",
    description: "Reads live Customer 360 profile, advisor notes, balances, portfolio totals, and funding status by personaId.",
    effect: "read",
    sampleArgs: {
      personaId: "demo-learner",
    },
  },
];

export class McpExposureStore {
  private readonly filePath: string;
  private readonly systemConfig?: SystemConfigStore;
  private cache: McpExposureConfig | null = null;

  constructor(dataDir: string, systemConfig?: SystemConfigStore) {
    this.filePath = resolve(dataDir, "mcp-server-config.json");
    this.systemConfig = systemConfig;
    this.bootstrapToSystemConfig();
  }

  private bootstrapToSystemConfig() {
    if (!this.systemConfig) return;
    if (this.systemConfig.get("tenant", "mcp_exposure", "default")) return;
    const initial = this.readFromFileOrDefault();
    this.systemConfig.upsert({
      domainId: "tenant",
      kind: "mcp_exposure",
      entityId: "default",
      label: "MCP Server Exposure",
      status: "published",
      payload: initial,
      updatedBy: "system",
      changeNote: existsSync(this.filePath) ? "Migrated from mcp-server-config.json" : "Seeded default MCP exposure",
    });
  }

  private readFromFileOrDefault(): McpExposureConfig {
    if (existsSync(this.filePath)) {
      try {
        const parsed = mcpExposureConfigSchema.safeParse(JSON.parse(readFileSync(this.filePath, "utf8")));
        if (parsed.success) return parsed.data;
      } catch {
        // fall through
      }
    }
    return { ...DEFAULT_CONFIG, enabledToolRefs: [...DEFAULT_CONFIG.enabledToolRefs] };
  }

  reloadFromSystemConfig() {
    this.cache = null;
    this.get();
  }

  get(): McpExposureConfig {
    if (this.cache) return this.cache;
    if (this.systemConfig) {
      const entity = this.systemConfig.get("tenant", "mcp_exposure", "default");
      if (entity) {
        const parsed = mcpExposureConfigSchema.safeParse(entity.payload);
        if (parsed.success) {
          this.cache = parsed.data;
          return this.cache;
        }
      }
    }
    this.cache = this.readFromFileOrDefault();
    return this.cache;
  }

  save(input: McpExposureConfig, updatedBy = "operator"): McpExposureConfig {
    const parsed = mcpExposureConfigSchema.parse({
      enabledToolRefs: [...new Set(input.enabledToolRefs)],
      includeKnowledgeSearch: input.includeKnowledgeSearch,
      includePublishedTasks: input.includePublishedTasks,
    });
    this.cache = parsed;
    if (this.systemConfig) {
      this.systemConfig.upsert({
        domainId: "tenant",
        kind: "mcp_exposure",
        entityId: "default",
        label: "MCP Server Exposure",
        status: "published",
        payload: parsed,
        updatedBy,
        changeNote: "Updated MCP server exposure policy",
      });
    } else {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(parsed, null, 2), "utf8");
    }
    return parsed;
  }
}
