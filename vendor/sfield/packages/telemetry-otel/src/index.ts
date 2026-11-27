/**
 * OpenTelemetry `gen_ai.*` TelemetrySink for @sfield/core.
 *
 * Implements @sfield/core's `TelemetrySink` interface with zero external runtime dependencies,
 * capturing GenAI spans and metrics and exporting OTLP/HTTP JSON (`v1/traces` & `v1/metrics`).
 */
import { randomBytes } from "node:crypto";
import type { TelemetrySink } from "@sfield/core";

export type OtelAttrValue = string | number | boolean;

export interface OtelSpanRecord {
  traceId: string;
  spanId: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: "OK" | "ERROR";
  attributes: Record<string, OtelAttrValue>;
}

export interface OtelMetricPoint {
  name: string;
  value: number;
  timeUnixNano: string;
  attributes: Record<string, OtelAttrValue>;
}

export interface OtelTelemetryOptions {
  serviceName?: string;
  serviceVersion?: string;
  /** Optional OTLP/HTTP base endpoint (e.g. `http://localhost:4318` or full `.../v1/traces`). */
  otlpEndpoint?: string;
  /** Optional HTTP headers for OTLP collector authentication. */
  headers?: Record<string, string>;
  /** Maximum spans retained in local ring buffer. Defaults to 500. */
  maxRetainedSpans?: number;
  /** Maximum metric points retained in local ring buffer. Defaults to 1000. */
  maxRetainedMetrics?: number;
  /** Optional fetch override for testing. */
  fetchImpl?: typeof fetch;
}

function toOtlpAttributes(attrs: Record<string, OtelAttrValue>) {
  return Object.entries(attrs).map(([key, value]) => ({
    key,
    value: typeof value === "boolean"
      ? { boolValue: value }
      : typeof value === "number"
        ? Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
        : { stringValue: value },
  }));
}

function nowUnixNano(offsetMs = 0): string {
  return String(BigInt(Date.now() + offsetMs) * 1_000_000n);
}

export class OtelTelemetrySink implements TelemetrySink {
  private readonly serviceName: string;
  private readonly serviceVersion: string;
  private readonly otlpEndpoint?: string;
  private readonly headers: Record<string, string>;
  private readonly maxSpans: number;
  private readonly maxMetrics: number;
  private readonly fetchImpl: typeof fetch;
  private readonly spans: OtelSpanRecord[] = [];
  private readonly metrics: OtelMetricPoint[] = [];
  private exportedCount = 0;

  constructor(options: OtelTelemetryOptions = {}) {
    this.serviceName = options.serviceName ?? "sfield-runtime";
    this.serviceVersion = options.serviceVersion ?? "0.1.0";
    this.otlpEndpoint = options.otlpEndpoint;
    this.headers = options.headers ?? {};
    this.maxSpans = options.maxRetainedSpans ?? 500;
    this.maxMetrics = options.maxRetainedMetrics ?? 1000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** Receives sfield runtime lifecycle events (`sfield.*` / `gen_ai.*`). */
  event(name: string, attributes: Record<string, OtelAttrValue>): void {
    const durationMs = typeof attributes.durationMs === "number" ? Math.max(0, attributes.durationMs) : 1;
    const endNano = nowUnixNano();
    const startNano = nowUnixNano(-durationMs);
    const status: "OK" | "ERROR" = attributes.status === "error" || attributes.status === "failed" || Boolean(attributes.error)
      ? "ERROR"
      : "OK";

    const normalized: Record<string, OtelAttrValue> = {
      "sfield.event": name,
      ...attributes,
    };
    if (typeof attributes.model === "string") normalized["gen_ai.request.model"] = attributes.model;
    if (typeof attributes.provider === "string") normalized["gen_ai.system"] = attributes.provider;
    if (typeof attributes.inputTokens === "number") normalized["gen_ai.usage.input_tokens"] = attributes.inputTokens;
    if (typeof attributes.outputTokens === "number") normalized["gen_ai.usage.output_tokens"] = attributes.outputTokens;

    this.spans.push({
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      name,
      startTimeUnixNano: startNano,
      endTimeUnixNano: endNano,
      status,
      attributes: normalized,
    });
    if (this.spans.length > this.maxSpans) {
      this.spans.splice(0, this.spans.length - this.maxSpans);
    }
  }

  /** Receives sfield runtime numeric metrics (durations, token usage, cost, tool counts). */
  metric(name: string, value: number, attributes: Record<string, OtelAttrValue> = {}): void {
    this.metrics.push({
      name,
      value,
      timeUnixNano: nowUnixNano(),
      attributes,
    });
    if (this.metrics.length > this.maxMetrics) {
      this.metrics.splice(0, this.metrics.length - this.maxMetrics);
    }
  }

  /** Helper for hosts to record a full GenAI model invocation directly with OTel semantic conventions. */
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
    errorMessage?: string;
  }): void {
    const attrs: Record<string, OtelAttrValue> = {
      "gen_ai.operation.name": input.operation,
      "gen_ai.system": input.provider,
      "gen_ai.request.model": input.model,
      durationMs: input.durationMs,
      status: input.status,
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      ...(input.costMicroUsd !== undefined ? { "sfield.cost.micro_usd": input.costMicroUsd } : {}),
      ...(input.runId ? { "sfield.run_id": input.runId } : {}),
      ...(input.errorMessage ? { "error.message": input.errorMessage } : {}),
    };
    this.event(`gen_ai.${input.operation}`, attrs);
    this.metric("gen_ai.client.operation.duration", input.durationMs / 1000, {
      "gen_ai.system": input.provider,
      "gen_ai.request.model": input.model,
    });
    if (input.inputTokens !== undefined) {
      this.metric("gen_ai.client.token.usage", input.inputTokens, { "gen_ai.token.type": "input", "gen_ai.request.model": input.model });
    }
    if (input.outputTokens !== undefined) {
      this.metric("gen_ai.client.token.usage", input.outputTokens, { "gen_ai.token.type": "output", "gen_ai.request.model": input.model });
    }
  }

  /** Builds a standards-compliant OTLP/HTTP JSON trace export payload (`ExportTraceServiceRequest`). */
  buildOtlpTracePayload(spans: readonly OtelSpanRecord[] = this.spans) {
    return {
      resourceSpans: [
        {
          resource: {
            attributes: toOtlpAttributes({
              "service.name": this.serviceName,
              "service.version": this.serviceVersion,
              "telemetry.sdk.name": "@sfield/telemetry-otel",
            }),
          },
          scopeSpans: [
            {
              scope: { name: "@sfield/telemetry-otel", version: this.serviceVersion },
              spans: spans.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                name: s.name,
                kind: 3, // SPAN_KIND_CLIENT
                startTimeUnixNano: s.startTimeUnixNano,
                endTimeUnixNano: s.endTimeUnixNano,
                attributes: toOtlpAttributes(s.attributes),
                status: { code: s.status === "ERROR" ? 2 : 1 },
              })),
            },
          ],
        },
      ],
    };
  }

  /** Flushes buffered spans to the configured OTLP/HTTP endpoint (if set). */
  async flush(): Promise<{ exportedSpans: number; statusCode?: number }> {
    if (!this.otlpEndpoint || this.spans.length === 0) {
      return { exportedSpans: 0 };
    }
    const url = this.otlpEndpoint.endsWith("/v1/traces")
      ? this.otlpEndpoint
      : `${this.otlpEndpoint.replace(/\/+$/, "")}/v1/traces`;
    const batch = this.spans.slice(this.exportedCount);
    if (batch.length === 0) return { exportedSpans: 0 };

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify(this.buildOtlpTracePayload(batch)),
    });
    if (res.ok) {
      this.exportedCount = this.spans.length;
    }
    return { exportedSpans: res.ok ? batch.length : 0, statusCode: res.status };
  }

  snapshot() {
    return {
      serviceName: this.serviceName,
      spanCount: this.spans.length,
      metricCount: this.metrics.length,
      spans: [...this.spans],
      metrics: [...this.metrics],
    };
  }
}

export function createOtelTelemetrySink(options?: OtelTelemetryOptions): OtelTelemetrySink {
  return new OtelTelemetrySink(options);
}
