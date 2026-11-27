import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { empathyAssessToolRef } from "../../packages/contracts/empathy";

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
  private cache: McpExposureConfig | null = null;

  constructor(dataDir: string) {
    this.filePath = resolve(dataDir, "mcp-server-config.json");
  }

  get(): McpExposureConfig {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = { ...DEFAULT_CONFIG, enabledToolRefs: [...DEFAULT_CONFIG.enabledToolRefs] };
      return this.cache;
    }
    try {
      const parsed = mcpExposureConfigSchema.safeParse(JSON.parse(readFileSync(this.filePath, "utf8")));
      if (parsed.success) {
        this.cache = parsed.data;
        return this.cache;
      }
    } catch {
      // Fall through to default config
    }
    this.cache = { ...DEFAULT_CONFIG, enabledToolRefs: [...DEFAULT_CONFIG.enabledToolRefs] };
    return this.cache;
  }

  save(input: McpExposureConfig): McpExposureConfig {
    const parsed = mcpExposureConfigSchema.parse({
      enabledToolRefs: [...new Set(input.enabledToolRefs)],
      includeKnowledgeSearch: input.includeKnowledgeSearch,
      includePublishedTasks: input.includePublishedTasks,
    });
    this.cache = parsed;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(parsed, null, 2), "utf8");
    return parsed;
  }
}
