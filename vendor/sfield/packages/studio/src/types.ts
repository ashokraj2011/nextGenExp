/** Public contracts for @sfield/studio. */
import type { IncomingMessage } from "node:http";
import type { ExecutionPersistence, McpExtensionStore, PiiFirewall, SField } from "@sfield/core";
import type { OtelMetricPoint, OtelSpanRecord, OtelTelemetrySink } from "@sfield/telemetry-otel";

export interface StudioPluginTab {
  /** Unique slug for the plugin tab. */
  id: string;
  /** Short display name shown in the Studio sidebar. */
  label: string;
  /** Optional subtitle/description shown in the plugin header. */
  description?: string;
  /** Optional badge label (e.g. "CEP", "Domain"). */
  badge?: string;
  /** External or host-relative URL opened in a new tab or navigated directly. */
  href?: string;
  /** Optional same-origin URL rendered inline inside an iframe panel. */
  iframeSrc?: string;
}

export interface StudioTelemetrySource {
  snapshot(): {
    serviceName: string;
    spanCount: number;
    metricCount: number;
    spans: OtelSpanRecord[];
    metrics: OtelMetricPoint[];
  };
  buildOtlpTracePayload(spans?: readonly OtelSpanRecord[]): Record<string, unknown>;
}

export interface StudioOptions {
  /** Live SField runtime instance (enables tool registry, live playground, config, and persistence). */
  runtime?: SField;
  /** Direct persistence handle (used when inspecting a SQLite/Postgres store without a live runtime). */
  persistence?: ExecutionPersistence;
  /** Optional OpenTelemetry sink (`OtelTelemetrySink` or compatible source). */
  telemetry?: OtelTelemetrySink | StudioTelemetrySource;
  /** Optional PII firewall instance for the interactive redaction lab. */
  piiFirewall?: PiiFirewall;
  /** Optional shared MCP 2026 Elicitation & Async Tasks store (defaults to an isolated in-memory store). */
  mcpExtensionStore?: McpExtensionStore;
  /** Display title in the Studio header. Defaults to "sfield Studio". */
  title?: string;
  /** Optional mount prefix (e.g. "/admin/sfield-studio"). Defaults to "". */
  basePath?: string;
  /** Optional request authorizer (e.g. host RBAC/session check). Return `false` to respond 401. */
  authorize?: (req: IncomingMessage) => boolean | Promise<boolean>;
  /** Optional host-provided domain studio tabs (e.g. PZN Studio, Customer 360, UI Builder). */
  plugins?: StudioPluginTab[];
  /** When true, disables mutating actions (approval decisions, lock approvals, tool playground, memory writes). */
  readOnly?: boolean;
  /** Host chat route that can open a prepared lock approval by ID. */
  approvalChatPath?: string;
}

export interface StudioServerOptions extends StudioOptions {
  /** Port to listen on (0 assigns an ephemeral free port). Defaults to 4310. */
  port?: number;
  /** Host interface to bind to. Defaults to "127.0.0.1". */
  host?: string;
}

export interface StudioServerHandle {
  url: string;
  port: number;
  host: string;
  close(): Promise<void>;
}
