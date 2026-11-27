/**
 * OpenTelemetry GenAI Semantic Conventions (gen_ai.*) TelemetrySink for sfield and CEP.
 *
 * Zero external runtime dependencies:
 * - Implements @sfield/core's TelemetrySink (`event` + `metric`).
 * - Records OTel-compliant `gen_ai.*` spans for model calls, tool executions, and agent runs.
 * - Aggregates token usage, estimated USD cost, latency percentiles (p50/p95), and error rates.
 * - Optionally exports standard OTLP/HTTP JSON (`ExportTraceServiceRequest`) when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TelemetrySink } from "@sfield/core";
import { createOtelTelemetrySink, type OtelTelemetrySink } from "@sfield/telemetry-otel";
import type { OtelSpan, TelemetryModelStats, TelemetryToolStats, TelemetryView } from "../../packages/contracts/telemetry";
import { serverTenantId } from "./tenant";

/** Fallback USD pricing per 1M tokens when provider does not report micro-USD cost. */
const MODEL_PRICING_PER_MTOK: Array<{ match: RegExp; inputUsd: number; outputUsd: number }> = [
  { match: /gpt-4\.1-mini|gpt-4o-mini/i, inputUsd: 0.4, outputUsd: 1.6 },
  { match: /gpt-4\.1|gpt-4o/i, inputUsd: 2.5, outputUsd: 10.0 },
  { match: /claude-3\.5-haiku|claude-haiku/i, inputUsd: 0.8, outputUsd: 4.0 },
  { match: /claude-3\.5-sonnet|claude-3\.7-sonnet|claude-sonnet/i, inputUsd: 3.0, outputUsd: 15.0 },
  { match: /claude-opus/i, inputUsd: 15.0, outputUsd: 75.0 },
  { match: /gemini-2\.5-flash|gemini-2\.0-flash|flash/i, inputUsd: 0.15, outputUsd: 0.6 },
  { match: /gemini-2\.5-pro|gemini-pro/i, inputUsd: 1.25, outputUsd: 10.0 },
];

export function estimateModelCostUsd(model: string, inputTokens: number, outputTokens: number, reportedMicroUsd?: number): number {
  if (typeof reportedMicroUsd === "number" && reportedMicroUsd > 0) {
    return Number((reportedMicroUsd / 1_000_000).toFixed(6));
  }
  const tier = MODEL_PRICING_PER_MTOK.find((t) => t.match.test(model)) ?? { inputUsd: 1.0, outputUsd: 4.0 };
  const usd = (Math.max(0, inputTokens) / 1_000_000) * tier.inputUsd + (Math.max(0, outputTokens) / 1_000_000) * tier.outputUsd;
  return Number(usd.toFixed(6));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]!);
}

function parseOtlpHeaders(raw?: string): Record<string, string> {
  if (!raw?.trim()) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

function toNano(ms: number): string {
  return (BigInt(Math.max(0, Math.round(ms))) * 1_000_000n).toString();
}

function otlpAttr(key: string, value: string | number | boolean) {
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
}

interface PersistedTelemetry {
  updatedAt: string;
  totalAgentRuns: number;
  piiRedactedTokens: number;
  modelLatenciesMs: number[];
  toolLatenciesMs: number[];
  byModel: Record<string, { model: string; provider: string; calls: number; errors: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number; totalLatencyMs: number }>;
  byTool: Record<string, { tool: string; calls: number; errors: number; totalLatencyMs: number }>;
  recentSpans: OtelSpan[];
  otlpExport: { exportedSpans: number; failedExports: number; lastExportedAt?: string; lastError?: string };
}

const MAX_SPANS = 100;
const MAX_LATENCIES = 300;

export class CepTelemetry implements TelemetrySink {
  private readonly filePath: string;
  private readonly serviceName: string;
  private readonly tenantId: string;
  private readonly otlpEndpoint?: string;
  private readonly otlpHeaders: Record<string, string>;
  private readonly sdkOtelSink: OtelTelemetrySink;
  private state: PersistedTelemetry;

  constructor(
    dataDir: string,
    opts?: {
      serviceName?: string;
      tenantId?: string;
      otlpEndpoint?: string;
      otlpHeaders?: Record<string, string>;
    },
  ) {
    this.filePath = join(dataDir, "telemetry.json");
    this.serviceName = opts?.serviceName ?? process.env.OTEL_SERVICE_NAME?.trim() ?? "cep-platform";
    this.tenantId = opts?.tenantId ?? serverTenantId;
    const endpoint = opts?.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
    this.otlpEndpoint = endpoint ? (endpoint.endsWith("/v1/traces") ? endpoint : `${endpoint.replace(/\/+$/, "")}/v1/traces`) : undefined;
    this.otlpHeaders = opts?.otlpHeaders ?? parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
    this.sdkOtelSink = createOtelTelemetrySink({
      serviceName: this.serviceName,
      serviceVersion: "1.1.0",
      ...(this.otlpEndpoint ? { otlpEndpoint: this.otlpEndpoint } : {}),
      headers: this.otlpHeaders,
    });
    this.state = this.load();
  }

  /** Exposes the underlying @sfield/telemetry-otel OtelTelemetrySink snapshot for SDK diagnostics. */
  sdkOtelSnapshot() {
    return this.sdkOtelSink.snapshot();
  }

  /** Exposes the underlying @sfield/telemetry-otel sink for @sfield/studio live trace inspection. */
  get otelSink(): OtelTelemetrySink {
    return this.sdkOtelSink;
  }

  private empty(): PersistedTelemetry {
    return {
      updatedAt: new Date().toISOString(),
      totalAgentRuns: 0,
      piiRedactedTokens: 0,
      modelLatenciesMs: [],
      toolLatenciesMs: [],
      byModel: {},
      byTool: {},
      recentSpans: [],
      otlpExport: { exportedSpans: 0, failedExports: 0 },
    };
  }

  private load(): PersistedTelemetry {
    if (!existsSync(this.filePath)) return this.empty();
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PersistedTelemetry>;
      return {
        ...this.empty(),
        ...parsed,
        modelLatenciesMs: Array.isArray(parsed.modelLatenciesMs) ? parsed.modelLatenciesMs.slice(-MAX_LATENCIES) : [],
        toolLatenciesMs: Array.isArray(parsed.toolLatenciesMs) ? parsed.toolLatenciesMs.slice(-MAX_LATENCIES) : [],
        recentSpans: Array.isArray(parsed.recentSpans) ? parsed.recentSpans.slice(0, MAX_SPANS) : [],
        byModel: parsed.byModel && typeof parsed.byModel === "object" ? parsed.byModel : {},
        byTool: parsed.byTool && typeof parsed.byTool === "object" ? parsed.byTool : {},
        otlpExport: { exportedSpans: parsed.otlpExport?.exportedSpans ?? 0, failedExports: parsed.otlpExport?.failedExports ?? 0, ...(parsed.otlpExport?.lastExportedAt ? { lastExportedAt: parsed.otlpExport.lastExportedAt } : {}), ...(parsed.otlpExport?.lastError ? { lastError: parsed.otlpExport.lastError } : {}) },
      };
    } catch {
      return this.empty();
    }
  }

  private save() {
    this.state.updatedAt = new Date().toISOString();
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  private pushSpan(span: OtelSpan) {
    this.state.recentSpans = [span, ...this.state.recentSpans].slice(0, MAX_SPANS);
    this.save();
    if (this.otlpEndpoint) {
      void this.exportSpans([span]);
    }
  }

  /** Implements @sfield/core TelemetrySink.metric */
  metric(name: string, value: number, attributes: Record<string, string | number | boolean> = {}): void {
    this.sdkOtelSink.metric(name, value, attributes);
    const endMs = Date.now();
    const durationMs = Math.max(0, Math.round(value));
    const startMs = endMs - durationMs;

    if (name === "sfield.tool.duration_ms") {
      const tool = String(attributes.tool ?? "unknown");
      const statusStr = String(attributes.status ?? "succeeded");
      const isErr = statusStr !== "succeeded";
      const bucket = this.state.byTool[tool] ?? { tool, calls: 0, errors: 0, totalLatencyMs: 0 };
      bucket.calls += 1;
      if (isErr) bucket.errors += 1;
      bucket.totalLatencyMs += durationMs;
      this.state.byTool[tool] = bucket;
      this.state.toolLatenciesMs = [...this.state.toolLatenciesMs, durationMs].slice(-MAX_LATENCIES);
      this.pushSpan({
        traceId: randomBytes(16).toString("hex"),
        spanId: randomBytes(8).toString("hex"),
        name: `execute_tool ${tool}`,
        kind: "internal",
        operation: "execute_tool",
        startTimeUnixNano: toNano(startMs),
        endTimeUnixNano: toNano(endMs),
        durationMs,
        status: isErr ? "error" : "ok",
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": tool,
          "sfield.tool.status": statusStr,
          "cep.tenant.id": this.tenantId,
        },
      });
      return;
    }

    if (name === "sfield.model.attempt_ms") {
      const provider = String(attributes.provider ?? "sfield");
      const statusStr = String(attributes.status ?? "succeeded");
      const isErr = statusStr !== "succeeded";
      this.state.modelLatenciesMs = [...this.state.modelLatenciesMs, durationMs].slice(-MAX_LATENCIES);
      this.pushSpan({
        traceId: randomBytes(16).toString("hex"),
        spanId: randomBytes(8).toString("hex"),
        name: `chat ${provider}`,
        kind: "client",
        operation: "chat",
        startTimeUnixNano: toNano(startMs),
        endTimeUnixNano: toNano(endMs),
        durationMs,
        status: isErr ? "error" : "ok",
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.system": provider,
          "gen_ai.client.operation.duration": Number((durationMs / 1000).toFixed(4)),
          "sfield.attempt.status": statusStr,
          "cep.tenant.id": this.tenantId,
        },
      });
      return;
    }

    if (name === "sfield.context.build_ms") {
      this.pushSpan({
        traceId: randomBytes(16).toString("hex"),
        spanId: randomBytes(8).toString("hex"),
        name: `context_build ${String(attributes.agent ?? "agent")}`,
        kind: "internal",
        operation: "context_build",
        startTimeUnixNano: toNano(startMs),
        endTimeUnixNano: toNano(endMs),
        durationMs,
        status: "ok",
        attributes: {
          "gen_ai.agent.name": String(attributes.agent ?? "agent"),
          "cep.tenant.id": this.tenantId,
        },
      });
    }
  }

  /** Implements @sfield/core TelemetrySink.event */
  event(name: string, attributes: Record<string, string | number | boolean>): void {
    this.sdkOtelSink.event(name, attributes);
    if (name === "sfield.run.finished") {
      this.state.totalAgentRuns += 1;
      const nowMs = Date.now();
      const agent = String(attributes.agent ?? "agent");
      const state = String(attributes.state ?? "completed");
      this.pushSpan({
        traceId: randomBytes(16).toString("hex"),
        spanId: randomBytes(8).toString("hex"),
        name: `invoke_agent ${agent}`,
        kind: "internal",
        operation: "invoke_agent",
        startTimeUnixNano: toNano(nowMs),
        endTimeUnixNano: toNano(nowMs),
        durationMs: 0,
        status: state === "completed" ? "ok" : "error",
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": agent,
          "sfield.run.state": state,
          "cep.tenant.id": this.tenantId,
        },
      });
    }
  }

  /** Records a direct LLM call (e.g. callConfiguredLlmJson) or a completed sfield agent usage summary. */
  recordModelCall(input: {
    operation: string;
    provider: string;
    model: string;
    durationMs: number;
    status: "ok" | "error";
    inputTokens?: number;
    outputTokens?: number;
    costMicroUsd?: number;
    runId?: string;
    piiRedactedCount?: number;
    errorMessage?: string;
  }): void {
    const endMs = Date.now();
    const durationMs = Math.max(0, Math.round(input.durationMs));
    this.sdkOtelSink.recordModelCall({
      provider: input.provider,
      model: input.model,
      operation: input.operation,
      durationMs,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costMicroUsd: input.costMicroUsd,
      status: input.status,
    });
    const startMs = endMs - durationMs;
    const inTok = Math.max(0, Math.round(input.inputTokens ?? 0));
    const outTok = Math.max(0, Math.round(input.outputTokens ?? 0));
    const costUsd = estimateModelCostUsd(input.model, inTok, outTok, input.costMicroUsd);
    const key = `${input.provider}:${input.model}`;
    const bucket = this.state.byModel[key] ?? {
      model: input.model, provider: input.provider, calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, totalLatencyMs: 0,
    };
    bucket.calls += 1;
    if (input.status === "error") bucket.errors += 1;
    bucket.inputTokens += inTok;
    bucket.outputTokens += outTok;
    bucket.estimatedCostUsd = Number((bucket.estimatedCostUsd + costUsd).toFixed(6));
    bucket.totalLatencyMs += durationMs;
    this.state.byModel[key] = bucket;
    this.state.modelLatenciesMs = [...this.state.modelLatenciesMs, durationMs].slice(-MAX_LATENCIES);
    if (input.piiRedactedCount && input.piiRedactedCount > 0) {
      this.state.piiRedactedTokens += input.piiRedactedCount;
    }

    const attrs: Record<string, string | number | boolean> = {
      "gen_ai.operation.name": "chat",
      "gen_ai.system": input.provider,
      "gen_ai.request.model": input.model,
      "gen_ai.usage.input_tokens": inTok,
      "gen_ai.usage.output_tokens": outTok,
      "gen_ai.client.operation.duration": Number((durationMs / 1000).toFixed(4)),
      "cep.operation": input.operation,
      "cep.tenant.id": this.tenantId,
      "cep.estimated_cost_usd": costUsd,
    };
    if (input.runId) attrs["cep.sfield.run_id"] = input.runId;
    if (input.piiRedactedCount !== undefined) attrs["cep.pii_redacted_count"] = input.piiRedactedCount;

    this.pushSpan({
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      name: `chat ${input.model}`,
      kind: "client",
      operation: "chat",
      startTimeUnixNano: toNano(startMs),
      endTimeUnixNano: toNano(endMs),
      durationMs,
      status: input.status,
      ...(input.errorMessage ? { errorMessage: input.errorMessage.slice(0, 300) } : {}),
      attributes: attrs,
    });
  }

  recordPiiRedaction(count: number, source: string, runId?: string): void {
    if (count <= 0) return;
    this.state.piiRedactedTokens += count;
    const nowMs = Date.now();
    this.pushSpan({
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      name: `egress_pii ${source}`,
      kind: "internal",
      operation: "egress_pii",
      startTimeUnixNano: toNano(nowMs),
      endTimeUnixNano: toNano(nowMs),
      durationMs: 0,
      status: "ok",
      attributes: {
        "cep.pii_redacted_count": count,
        "cep.pii.source": source,
        "cep.tenant.id": this.tenantId,
        ...(runId ? { "cep.sfield.run_id": runId } : {}),
      },
    });
  }

  /** Standard OTLP/HTTP JSON ExportTraceServiceRequest payload. */
  toOtlpExport(spans = this.state.recentSpans) {
    return {
      resourceSpans: [
        {
          resource: {
            attributes: [
              otlpAttr("service.name", this.serviceName),
              otlpAttr("service.version", "1.1.0"),
              otlpAttr("cep.tenant.id", this.tenantId),
            ],
          },
          scopeSpans: [
            {
              scope: { name: "cep.sfield.telemetry", version: "1.0.0" },
              spans: spans.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
                name: s.name,
                kind: s.kind === "client" ? 3 : s.kind === "server" ? 2 : 1,
                startTimeUnixNano: s.startTimeUnixNano,
                endTimeUnixNano: s.endTimeUnixNano,
                attributes: Object.entries(s.attributes).map(([k, v]) => otlpAttr(k, v)),
                status: { code: s.status === "ok" ? 1 : 2, ...(s.errorMessage ? { message: s.errorMessage } : {}) },
              })),
            },
          ],
        },
      ],
    };
  }

  private async exportSpans(spans: OtelSpan[]): Promise<void> {
    if (!this.otlpEndpoint || spans.length === 0) return;
    try {
      const res = await fetch(this.otlpEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.otlpHeaders },
        body: JSON.stringify(this.toOtlpExport(spans)),
        signal: AbortSignal.timeout(4_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.state.otlpExport.exportedSpans += spans.length;
      this.state.otlpExport.lastExportedAt = new Date().toISOString();
      delete this.state.otlpExport.lastError;
      this.save();
    } catch (err) {
      this.state.otlpExport.failedExports += 1;
      this.state.otlpExport.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      this.save();
    }
  }

  reset(): TelemetryView {
    this.state = this.empty();
    this.save();
    return this.view();
  }

  view(): TelemetryView {
    const byModel: TelemetryModelStats[] = Object.values(this.state.byModel)
      .map((m) => ({
        model: m.model,
        provider: m.provider,
        calls: m.calls,
        errors: m.errors,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        estimatedCostUsd: Number(m.estimatedCostUsd.toFixed(6)),
        avgLatencyMs: m.calls ? Math.round(m.totalLatencyMs / m.calls) : 0,
      }))
      .sort((a, b) => b.calls - a.calls);

    const byTool: TelemetryToolStats[] = Object.values(this.state.byTool)
      .map((t) => ({
        tool: t.tool,
        calls: t.calls,
        errors: t.errors,
        avgLatencyMs: t.calls ? Math.round(t.totalLatencyMs / t.calls) : 0,
      }))
      .sort((a, b) => b.calls - a.calls);

    const totalModelCalls = byModel.reduce((s, m) => s + m.calls, 0);
    const totalModelErrors = byModel.reduce((s, m) => s + m.errors, 0);
    const totalToolCalls = byTool.reduce((s, t) => s + t.calls, 0);
    const totalToolErrors = byTool.reduce((s, t) => s + t.errors, 0);
    const totalInputTokens = byModel.reduce((s, m) => s + m.inputTokens, 0);
    const totalOutputTokens = byModel.reduce((s, m) => s + m.outputTokens, 0);
    const estimatedCostUsd = Number(byModel.reduce((s, m) => s + m.estimatedCostUsd, 0).toFixed(6));

    return {
      serviceName: this.serviceName,
      tenantId: this.tenantId,
      updatedAt: this.state.updatedAt,
      summary: {
        totalModelCalls,
        modelSuccessRatePct: totalModelCalls ? Math.round(((totalModelCalls - totalModelErrors) / totalModelCalls) * 100) : 100,
        totalToolCalls,
        toolSuccessRatePct: totalToolCalls ? Math.round(((totalToolCalls - totalToolErrors) / totalToolCalls) * 100) : 100,
        totalAgentRuns: this.state.totalAgentRuns,
        totalInputTokens,
        totalOutputTokens,
        estimatedCostUsd,
        modelLatencyP50Ms: percentile(this.state.modelLatenciesMs, 50),
        modelLatencyP95Ms: percentile(this.state.modelLatenciesMs, 95),
        toolLatencyP50Ms: percentile(this.state.toolLatenciesMs, 50),
        toolLatencyP95Ms: percentile(this.state.toolLatenciesMs, 95),
        piiRedactedTokens: this.state.piiRedactedTokens,
      },
      byModel,
      byTool,
      otlpExport: {
        configured: Boolean(this.otlpEndpoint),
        ...(this.otlpEndpoint ? { endpoint: this.otlpEndpoint } : {}),
        ...this.state.otlpExport,
      },
      recentSpans: this.state.recentSpans.slice(0, 50),
    };
  }
}
