#!/usr/bin/env python3
"""
Zero-dependency Python MCP 2026 (Streamable HTTP) Tool Server for sfield.

Demonstrates how Python ML / quantitative / data-science teams expose tools
into sfield's Node.js zero-trust governance kernel via `createMcpProxyTools`
with zero rewrite of the runtime.
"""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
import sys

PROTOCOL_VERSION = "2026-07-28"
TOOL_DEF = {
    "name": "py.risk.score",
    "description": "Compute portfolio volatility & risk tier using Python analytics.",
    "inputSchema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["equityPct", "cashPct"],
        "properties": {
            "equityPct": {"type": "number", "minimum": 0, "maximum": 100},
            "cashPct": {"type": "number", "minimum": 0, "maximum": 100},
            "horizonYears": {"type": "number", "minimum": 1, "maximum": 50},
        },
    },
    "outputSchema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["riskScore", "riskTier", "engine"],
        "properties": {
            "riskScore": {"type": "number"},
            "riskTier": {"type": "string"},
            "engine": {"type": "string"},
        },
    },
}


def score_portfolio(args: dict) -> dict:
    equity = float(args.get("equityPct", 0))
    cash = float(args.get("cashPct", 0))
    horizon = float(args.get("horizonYears", 10))
    raw_score = max(1.0, min(100.0, round(equity * 0.85 - cash * 0.25 - min(horizon, 20) * 0.4, 2)))
    tier = "high" if raw_score >= 65 else ("moderate" if raw_score >= 35 else "conservative")
    return {
        "riskScore": raw_score,
        "riskTier": tier,
        "engine": f"python-{sys.version_info.major}.{sys.version_info.minor}",
    }


class McpHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return  # quiet stdout for clean piping

    def _send_json(self, payload: dict, status: int = 200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("MCP-Protocol-Version", PROTOCOL_VERSION)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        msg = json.loads(raw)
        req_id = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}

        if method == "initialize":
            self._send_json({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "serverInfo": {"name": "sfield-python-mcp-tool", "version": "1.0.0"},
                    "capabilities": {"tools": {"listChanged": False}},
                },
            })
            return

        if method == "server/discover":
            self._send_json({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersions": [PROTOCOL_VERSION, "2025-03-26"],
                    "serverInfo": {"name": "sfield-python-mcp-tool", "version": "1.0.0"},
                    "capabilities": {"tools": {"listChanged": False}},
                },
            })
            return

        if method == "tools/list":
            self._send_json({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"tools": [TOOL_DEF]},
            })
            return

        if method == "tools/call":
            name = params.get("name")
            if name != TOOL_DEF["name"]:
                self._send_json({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32602, "message": f"Unknown tool: {name}"},
                }, 400)
                return
            out = score_portfolio(params.get("arguments") or {})
            self._send_json({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps(out)}],
                    "structuredContent": out,
                },
            })
            return

        self._send_json({
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        }, 404)


if __name__ == "__main__":
    port = int(os.environ.get("PY_MCP_PORT", "8765"))
    server = HTTPServer(("127.0.0.1", port), McpHandler)
    print(f"[python-mcp] listening on http://127.0.0.1:{port}/mcp", flush=True)
    server.serve_forever()
