import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  connectorUpsertSchema,
  externalConnectorSchema,
  type ConnectorTestResult,
  type ConnectorUpsertInput,
  type ExternalConnector,
} from "../../packages/contracts/connector";
import type { NormalizedRecommendation, RecommendationProvider } from "../../packages/contracts/recommendation-provider";

function defaultConnectors(nowIso: string): ExternalConnector[] {
  return [
    {
      id: "pega_cdh_nba",
      name: "Pega CDH · Next-Best-Action REST",
      kind: "rest_recommendation",
      url: "https://cdh.example.invalid/prweb/api/PegaMKTContainer/V3/Container",
      method: "POST",
      domains: ["wealth", "general"],
      enabled: false,
      timeoutMs: 3000,
      authHeaderName: "Authorization",
      description: "External enterprise decisioning container adapter. Enable and point to your Pega CDH / Adobe Offer Decisioning endpoint to plug directly into cep.recommendations.arbitrate@1.0.0.",
      updatedAt: nowIso,
    },
    {
      id: "servicenow_mcp",
      name: "ServiceNow / PagerDuty MCP Bridge",
      kind: "mcp_bridge",
      url: "https://mcp.example.invalid/ops/incidents/recommend",
      method: "POST",
      domains: ["operations"],
      enabled: false,
      timeoutMs: 3500,
      authHeaderName: "X-API-Key",
      description: "External ITSM & SRE runbook bridge via MCP/JSON-RPC. Enable with a live endpoint to supplement local incidents.json with live enterprise tickets.",
      updatedAt: nowIso,
    },
  ];
}

function slugId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36);
  return base || `conn_${Date.now().toString(36)}`;
}

export class ConnectorStore {
  private readonly filePath: string;
  private connectors: ExternalConnector[];

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "connectors.json");
    this.connectors = this.load();
  }

  private load(): ExternalConnector[] {
    if (existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
        if (Array.isArray(raw)) {
          const parsed = raw
            .map((item) => externalConnectorSchema.safeParse(item))
            .filter((res): res is { success: true; data: ExternalConnector } => res.success)
            .map((res) => res.data);
          if (parsed.length > 0) return parsed;
        }
      } catch { /* fall through */ }
    }
    const seeded = defaultConnectors(new Date().toISOString());
    this.save(seeded);
    return seeded;
  }

  private save(records: ExternalConnector[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(records, null, 2), "utf8");
    this.connectors = records;
  }

  list(): ExternalConnector[] {
    return this.connectors.map((c) => ({ ...c, domains: [...c.domains] }));
  }

  upsert(rawInput: ConnectorUpsertInput): { connector: ExternalConnector; connectors: ExternalConnector[] } {
    const input = connectorUpsertSchema.parse(rawInput);
    const id = input.id ?? slugId(input.name);
    const record: ExternalConnector = {
      id,
      name: input.name,
      kind: input.kind,
      url: input.url,
      method: input.method,
      domains: input.domains,
      enabled: input.enabled,
      timeoutMs: input.timeoutMs,
      ...(input.authHeaderName ? { authHeaderName: input.authHeaderName } : {}),
      description: input.description,
      updatedAt: new Date().toISOString(),
    };
    const exists = this.connectors.some((c) => c.id === id);
    const next = exists
      ? this.connectors.map((c) => (c.id === id ? record : c))
      : [record, ...this.connectors];
    this.save(next);
    return { connector: record, connectors: this.list() };
  }

  remove(id: string): { deleted: boolean; connectors: ExternalConnector[] } {
    const next = this.connectors.filter((c) => c.id !== id);
    if (next.length === this.connectors.length) return { deleted: false, connectors: this.list() };
    this.save(next);
    return { deleted: true, connectors: this.list() };
  }

  async testConnector(id: string): Promise<ConnectorTestResult> {
    const conn = this.connectors.find((c) => c.id === id);
    if (!conn) {
      return { connectorId: id, ok: false, elapsedMs: 0, message: "Connector not found." };
    }
    const started = Date.now();
    if (conn.url.includes(".example.invalid")) {
      return {
        connectorId: id,
        ok: true,
        statusCode: 200,
        elapsedMs: 12,
        message: "Template schema validated (replace .example.invalid URL with your live endpoint to execute network probes).",
      };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(conn.timeoutMs, 4000));
      timer.unref();
      try {
        const res = await fetch(conn.url, {
          method: conn.method,
          headers: { "Content-Type": "application/json" },
          ...(conn.method === "POST" ? { body: JSON.stringify({ ping: true, source: "cep-connector-test" }) } : {}),
          signal: controller.signal,
        });
        return {
          connectorId: id,
          ok: res.ok,
          statusCode: res.status,
          elapsedMs: Math.max(1, Date.now() - started),
          message: res.ok ? `Connected cleanly (HTTP ${res.status}).` : `Endpoint responded with HTTP ${res.status}.`,
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return {
        connectorId: id,
        ok: false,
        elapsedMs: Math.max(1, Date.now() - started),
        message: err instanceof Error ? err.message.slice(0, 140) : "Connection failed.",
      };
    }
  }

  buildRecommendationProviders(): RecommendationProvider[] {
    return this.connectors
      .filter((c) => c.enabled && (c.kind === "rest_recommendation" || c.kind === "mcp_bridge"))
      .map((conn): RecommendationProvider => ({
        id: `ext_${conn.id}`,
        label: conn.name,
        description: conn.description || `External ${conn.kind} connector (${conn.url})`,
        domains: [...conn.domains],
        async evaluate(ctx, signal) {
          if (conn.url.includes(".example.invalid")) return [];
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), conn.timeoutMs);
          timer.unref();
          const onAbort = () => controller.abort();
          signal.addEventListener("abort", onAbort, { once: true });
          try {
            const res = await fetch(conn.url, {
              method: conn.method,
              headers: { "Content-Type": "application/json" },
              ...(conn.method === "POST" ? {
                body: JSON.stringify({
                  domain: ctx.domain,
                  contextId: ctx.contextId,
                  fundingStatus: ctx.fundingStatus,
                  personaId: ctx.personaId,
                }),
              } : {}),
              signal: controller.signal,
            });
            if (!res.ok) return [];
            const payload = await res.json() as { recommendations?: unknown[] };
            if (!Array.isArray(payload.recommendations)) return [];
            return payload.recommendations
              .slice(0, 5)
              .map((raw, idx): NormalizedRecommendation | null => {
                if (!raw || typeof raw !== "object") return null;
                const item = raw as Record<string, unknown>;
                const title = typeof item.title === "string" ? item.title.trim().slice(0, 140) : "";
                if (!title) return null;
                return {
                  id: `ext:${conn.id}:${typeof item.id === "string" ? item.id : idx}`,
                  providerId: `ext_${conn.id}`,
                  providerLabel: conn.name,
                  kind: "action",
                  priority: typeof item.priority === "number" ? Math.max(1, Math.min(999, Math.round(item.priority))) : 30 + idx,
                  title,
                  ...(typeof item.body === "string" ? { body: item.body.slice(0, 400) } : {}),
                  ...(typeof item.ctaLabel === "string" ? { ctaLabel: item.ctaLabel.slice(0, 64) } : {}),
                  ...(typeof item.ctaPrompt === "string" ? { ctaPrompt: item.ctaPrompt.slice(0, 240) } : {}),
                  badge: conn.name.slice(0, 44),
                };
              })
              .filter((x): x is NormalizedRecommendation => x !== null);
          } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
          }
        },
      }));
  }
}
