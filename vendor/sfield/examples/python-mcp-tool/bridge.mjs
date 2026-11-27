/**
 * Node.js sfield bridge that mounts the Python MCP 2026 tool (`py.risk.score`)
 * inside sfield's zero-trust governance kernel (`Principal`, closed schemas,
 * `read_only` preset, and `ExecutionScope` audit receipts).
 *
 * Usage:
 *   1. python3 vendor/sfield/examples/python-mcp-tool/server.py
 *   2. node vendor/sfield/examples/python-mcp-tool/bridge.mjs
 */
import { createMcpClient, createMcpProxyTools, SField } from "@sfield/core";

const endpoint = process.env.PY_MCP_URL ?? "http://127.0.0.1:8765/mcp";
const client = createMcpClient({ endpoint });
await client.initialize();

const proxyTools = await createMcpProxyTools(client, { namespace: "python" });
const sf = await SField.create({
  config: { version: 1, models: {}, agents: {} },
  preset: "memory",
  tools: proxyTools,
});

try {
  const scope = await sf.executions.open({
    principal: sf.devPrincipal,
    preset: "read_only",
    purpose: "python-mcp-bridge-demo",
  });
  try {
    const result = await scope.registry.execute("python.py.risk.score@1.0.0", {
      equityPct: 80,
      cashPct: 10,
      horizonYears: 12,
    });
    console.log("Governed Python MCP result:", JSON.stringify(result, null, 2));
  } finally {
    await scope.close();
  }
} finally {
  await sf.close();
}
