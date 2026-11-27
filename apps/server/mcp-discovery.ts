import type { ConnectorStore } from "./connector-store";
import type { McpDiscoveredTool, McpDiscoveryResult } from "../../packages/contracts/mcp-discovery";
import type { RecommendationDomain } from "../../packages/contracts/recommendation-provider";

interface RawMcpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

const SANDBOX_MCP_SERVERS: Record<string, { serverName: string; domain: RecommendationDomain; tools: RawMcpTool[] }> = {
  "mcp-sandbox://wealth-brokerage": {
    serverName: "Wealth Brokerage & Clearing MCP Server (Sandbox)",
    domain: "wealth",
    tools: [
      {
        name: "brokerage.place_equity_order",
        description: "Submit a market or limit equity order to the custody OMS with pre-trade compliance checks.",
        inputSchema: {
          type: "object",
          properties: {
            accountId: { type: "string", description: "Custody account identifier" },
            symbol: { type: "string", description: "Ticker symbol (e.g. AAPL, INTC)" },
            side: { type: "string", description: "buy or sell" },
            quantity: { type: "number", description: "Whole share quantity" },
          },
          required: ["accountId", "symbol", "side", "quantity"],
        },
      },
      {
        name: "plaid.verify_bank_ach",
        description: "Verify external checking account ownership & instant ACH funding limit via Plaid Auth.",
        inputSchema: {
          type: "object",
          properties: {
            personaId: { type: "string", description: "Customer profile ID" },
            amountUsd: { type: "number", description: "Requested ACH deposit amount" },
          },
          required: ["personaId", "amountUsd"],
        },
      },
      {
        name: "tax.fetch_lot_basis",
        description: "Read tax-lot cost basis and holding periods (short-term vs long-term) for a customer account.",
        inputSchema: {
          type: "object",
          properties: {
            accountId: { type: "string", description: "Custody account identifier" },
            symbol: { type: "string", description: "Optional ticker filter" },
          },
          required: ["accountId"],
        },
      },
    ],
  },
  "mcp-sandbox://enterprise-itsm": {
    serverName: "Enterprise ITSM & Observability MCP Server (Sandbox)",
    domain: "operations",
    tools: [
      {
        name: "servicenow.create_emergency_change",
        description: "Create a governed ServiceNow CHG ticket linked to an active P1 incident and rollback plan.",
        inputSchema: {
          type: "object",
          properties: {
            incidentId: { type: "string", description: "Incident key (e.g. INC-4821)" },
            service: { type: "string", description: "Target microservice" },
            releaseTag: { type: "string", description: "Rollback or hotfix release version" },
          },
          required: ["incidentId", "service", "releaseTag"],
        },
      },
      {
        name: "datadog.query_slo_burn",
        description: "Read live 5xx error budget burn rate and p95 latency metrics from Datadog.",
        inputSchema: {
          type: "object",
          properties: {
            service: { type: "string", description: "Service name" },
            windowMinutes: { type: "number", description: "Lookback window in minutes" },
          },
          required: ["service"],
        },
      },
      {
        name: "kubernetes.rollback_deployment",
        description: "Execute a production canary rollback to the last known healthy release revision.",
        inputSchema: {
          type: "object",
          properties: {
            cluster: { type: "string", description: "Production cluster name" },
            deployment: { type: "string", description: "Deployment name" },
            revision: { type: "string", description: "Target revision tag" },
          },
          required: ["cluster", "deployment", "revision"],
        },
      },
    ],
  },
  "mcp-sandbox://crm-revops": {
    serverName: "CRM & Deal Desk MCP Server (Sandbox)",
    domain: "sales",
    tools: [
      {
        name: "salesforce.update_deal_discount",
        description: "Write approved enterprise discount terms and close stage back to Salesforce Opportunity.",
        inputSchema: {
          type: "object",
          properties: {
            dealId: { type: "string", description: "Opportunity ID (e.g. DEAL-904)" },
            discountPct: { type: "number", description: "Approved discount percentage" },
            approver: { type: "string", description: "Approving VP/CFO name" },
          },
          required: ["dealId", "discountPct"],
        },
      },
      {
        name: "docusign.dispatch_order_form",
        description: "Generate and send an executable DocuSign Order Form envelope to the enterprise buyer.",
        inputSchema: {
          type: "object",
          properties: {
            dealId: { type: "string", description: "Opportunity ID" },
            recipientEmail: { type: "string", description: "Buyer signer email" },
          },
          required: ["dealId", "recipientEmail"],
        },
      },
      {
        name: "hubspot.read_account_health",
        description: "Read enterprise customer health score, renewal date, and open support tickets.",
        inputSchema: {
          type: "object",
          properties: {
            accountName: { type: "string", description: "Account name" },
          },
          required: ["accountName"],
        },
      },
    ],
  },
};

function inferEffect(name: string, description: string): "read" | "write" {
  const text = `${name} ${description}`.toLowerCase();
  if (/\b(create|place|update|delete|send|dispatch|execute|rollback|submit|approve|trigger|write|transfer|wire)\b/.test(text)) {
    return "write";
  }
  return "read";
}

function inferDomain(name: string, description: string, fallback: RecommendationDomain): RecommendationDomain {
  const text = `${name} ${description}`.toLowerCase();
  if (/\b(order|trade|broker|plaid|tax|portfolio|wire|ach|account)\b/.test(text)) return "wealth";
  if (/\b(incident|servicenow|datadog|k8s|kubernetes|rollback|pagerduty|slo|latency)\b/.test(text)) return "operations";
  if (/\b(salesforce|deal|discount|docusign|hubspot|crm|opportunity|quote)\b/.test(text)) return "sales";
  return fallback;
}

function slugConnectorId(toolName: string): string {
  const clean = `mcp_${toolName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`.slice(0, 44);
  return clean || `mcp_tool_${Date.now().toString(36)}`;
}

function normalizeTools(
  rawTools: RawMcpTool[],
  fallbackDomain: RecommendationDomain,
  existingIds: Set<string>,
): McpDiscoveredTool[] {
  return rawTools.slice(0, 24).map((t) => {
    const desc = (t.description ?? "Discovered MCP tool").slice(0, 260);
    const effect = inferEffect(t.name, desc);
    const props = t.inputSchema?.properties ?? {};
    const reqSet = new Set(t.inputSchema?.required ?? []);
    const parameters = Object.entries(props).slice(0, 8).map(([pName, meta]) => ({
      name: pName,
      type: String(meta?.type ?? "string"),
      required: reqSet.has(pName),
      ...(meta?.description ? { description: meta.description.slice(0, 120) } : {}),
    }));
    const suggestedConnectorId = slugConnectorId(t.name);
    return {
      name: t.name.slice(0, 80),
      description: desc,
      effect,
      riskLevel: effect === "write" ? "high" : "low",
      parameters,
      suggestedConnectorId,
      suggestedDomain: inferDomain(t.name, desc, fallbackDomain),
      alreadyImported: existingIds.has(suggestedConnectorId),
    };
  });
}

export async function discoverMcpServer(input: {
  serverUrl: string;
  authHeaderName?: string;
  authEnvVar?: string;
  connectorStore: ConnectorStore;
}): Promise<McpDiscoveryResult> {
  const serverUrl = input.serverUrl.trim();
  const existingIds = new Set(input.connectorStore.list().map((c) => c.id));
  const nowIso = new Date().toISOString();

  // 1. Built-in Sandbox MCP Servers (for instant zero-credential discovery & import demos)
  const sandbox = SANDBOX_MCP_SERVERS[serverUrl];
  if (sandbox) {
    return {
      serverUrl,
      serverName: sandbox.serverName,
      protocolVersion: "2025-03-26",
      transport: "builtin_sandbox",
      discoveredAt: nowIso,
      tools: normalizeTools(sandbox.tools, sandbox.domain, existingIds),
    };
  }

  // 2. Real Live HTTP JSON-RPC 2.0 MCP Server (tools/list)
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(serverUrl);
  } catch {
    throw new Error("Enter a valid https://, http://localhost, or mcp-sandbox:// server URL.");
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "127.0.0.1" && parsedUrl.hostname !== "localhost") {
    throw new Error("Remote MCP servers must use https:// (or localhost / mcp-sandbox:// for local testing).");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (input.authHeaderName && input.authEnvVar && process.env[input.authEnvVar]) {
    headers[input.authHeaderName] = process.env[input.authEnvVar]!;
  }

  const response = await fetch(serverUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`MCP server returned HTTP ${response.status} on tools/list.`);
  }
  const body = (await response.json()) as {
    result?: { tools?: RawMcpTool[]; serverInfo?: { name?: string }; protocolVersion?: string };
    tools?: RawMcpTool[];
  };
  const rawTools = Array.isArray(body?.result?.tools)
    ? body.result.tools
    : Array.isArray(body?.tools)
      ? body.tools
      : [];
  if (rawTools.length === 0) {
    throw new Error("MCP server responded, but tools/list returned 0 tools.");
  }

  return {
    serverUrl,
    serverName: body?.result?.serverInfo?.name ?? parsedUrl.host,
    protocolVersion: body?.result?.protocolVersion ?? "2025-03-26",
    transport: "http_jsonrpc",
    discoveredAt: nowIso,
    tools: normalizeTools(rawTools, "general", existingIds),
  };
}

export function mcpToolConnector(input: {
  serverUrl: string;
  toolName: string;
  description: string;
  effect: "read" | "write";
  domain: RecommendationDomain;
  requiresApproval: boolean;
  dualControl: boolean;
  authHeaderName?: string;
  authEnvVar?: string;
}) {
  const isSandbox = input.serverUrl.startsWith("mcp-sandbox://");
  const connectorUrl = isSandbox
    ? `sandbox://mcp/${input.toolName.replace(/[^a-zA-Z0-9_-]/g, "_")}`
    : input.serverUrl;
  const id = slugConnectorId(input.toolName);
  return {
    id,
    name: `MCP · ${input.toolName}`.slice(0, 80),
    kind: "mcp_bridge",
    url: connectorUrl,
    method: "POST",
    domains: [input.domain],
    enabled: true,
    timeoutMs: 4000,
    ...(input.authHeaderName ? { authHeaderName: input.authHeaderName } : {}),
    ...(input.authEnvVar ? { authEnvVar: input.authEnvVar } : {}),
    effect: input.effect,
    requiresApproval: input.requiresApproval,
    dualControl: input.dualControl,
    sandboxMode: isSandbox,
    description: `[MCP Auto-Imported from ${input.serverUrl}] ${input.description}`.slice(0, 240),
  };
}
