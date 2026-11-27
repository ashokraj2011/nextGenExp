# Polyglot Python Tool Bridge (`MCP 2026` → `sfield`)

Python ML, quantitative, and data-science teams do **not** need a Python rewrite of `sfield` to get zero-trust governance (`Principal`/OBO, policy presets, HITL approvals, PII firewall, and OTel audit). Expose Python tools over **MCP `2026-07-28` Streamable HTTP** and mount them into `sfield` with `createMcpProxyTools(...)`.

## Run It

```sh
# Terminal 1 — Start the zero-dependency Python MCP 2026 tool server
python3 vendor/sfield/examples/python-mcp-tool/server.py

# Terminal 2 — Mount & execute the Python tool inside sfield's governance kernel
npm run build:sfield
node vendor/sfield/examples/python-mcp-tool/bridge.mjs
```
