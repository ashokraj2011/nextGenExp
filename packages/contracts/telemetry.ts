import { z } from "zod";

/** OpenTelemetry GenAI Semantic Convention span (gen_ai.*) captured by CEP / sfield. */
export const otelSpanSchema = z.object({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  kind: z.enum(["client", "internal", "server"]),
  operation: z.enum(["chat", "execute_tool", "invoke_agent", "context_build", "egress_pii"]),
  startTimeUnixNano: z.string(),
  endTimeUnixNano: z.string(),
  durationMs: z.number().nonnegative(),
  status: z.enum(["ok", "error"]),
  errorMessage: z.string().optional(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
}).strict();
export type OtelSpan = z.infer<typeof otelSpanSchema>;

export interface TelemetryModelStats {
  model: string;
  provider: string;
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  avgLatencyMs: number;
}

export interface TelemetryToolStats {
  tool: string;
  calls: number;
  errors: number;
  avgLatencyMs: number;
}

export interface TelemetryView {
  serviceName: string;
  tenantId: string;
  updatedAt: string;
  summary: {
    totalModelCalls: number;
    modelSuccessRatePct: number;
    totalToolCalls: number;
    toolSuccessRatePct: number;
    totalAgentRuns: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    estimatedCostUsd: number;
    modelLatencyP50Ms: number;
    modelLatencyP95Ms: number;
    toolLatencyP50Ms: number;
    toolLatencyP95Ms: number;
    piiRedactedTokens: number;
  };
  byModel: TelemetryModelStats[];
  byTool: TelemetryToolStats[];
  otlpExport: {
    configured: boolean;
    endpoint?: string;
    exportedSpans: number;
    failedExports: number;
    lastExportedAt?: string;
    lastError?: string;
  };
  recentSpans: OtelSpan[];
}
