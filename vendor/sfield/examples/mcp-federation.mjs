// Standalone MCP Federation example: expose sfield tools via SFieldMcpServer and consume via McpClient + createMcpProxyTools
import { SField, defineTool, createMcpClient, createMcpProxyTools } from "@sfield/core";

const quoteTool = defineTool({
  id: "market.quote",
  version: "1.0.0",
  description: "Return a mock quote for a ticker symbol.",
  inputs: {
    type: "object",
    properties: { symbol: { type: "string" } },
    required: ["symbol"],
    additionalProperties: false,
  },
  outputs: {
    type: "object",
    properties: { symbol: { type: "string" }, price: { type: "number" } },
    required: ["symbol", "price"],
    additionalProperties: false,
  },
  policy: { effect: "read", classification: "public" },
  handler: async ({ symbol }) => ({ symbol: String(symbol).toUpperCase(), price: 184.25 }),
});

// Server runtime exposing market.quote@1.0.0 over MCP
const serverSf = await SField.create({
  config: { version: 1, models: {}, agents: {} },
  preset: "memory",
  tools: [quoteTool],
  quiet: true,
});
const mcpServer = serverSf.createMcpServer({
  serverInfo: { name: "market-mcp", version: "1.0.0" },
  preset: "read_only",
  allowTools: ["market.quote@1.0.0"],
});

// In-process transport adapter bridging McpClient -> SFieldMcpServer.handleRequest
const inMemoryFetch = async (_url, init) => {
  const res = await mcpServer.handleRequest(JSON.parse(String(init?.body ?? "{}")));
  return new Response(JSON.stringify(res.body ?? {}), { status: res.status, headers: res.headers });
};

const client = createMcpClient({ endpoint: "http://in-memory.local/mcp", fetchImpl: inMemoryFetch });
const proxyTools = await createMcpProxyTools(client, { namespace: "remote_market" });

// Consumer runtime mounting the discovered remote MCP tools as governed sfield tools
const consumerSf = await SField.create({
  config: { version: 1, models: {}, agents: {} },
  preset: "memory",
  tools: proxyTools,
  quiet: true,
});

const out = await consumerSf.registry.execute({
  toolRef: proxyTools[0].id + "@" + proxyTools[0].version,
  inputs: { symbol: "AAPL" },
});
console.log("Federated MCP call result:", out.status, out.output);

await consumerSf.close();
await serverSf.close();
