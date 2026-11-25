import { useState } from "react";
import { Check, Download, Plug, Search, ShieldCheck } from "lucide-react";
import type { McpDiscoveredTool, McpDiscoveryResult } from "../../packages/contracts/mcp-discovery";
import { api, toolSetupErrorMessage } from "./api";

const MCP_PRESETS = [
  { label: "Wealth Brokerage MCP", url: "mcp-sandbox://wealth-brokerage" },
  { label: "Enterprise ITSM MCP", url: "mcp-sandbox://enterprise-itsm" },
  { label: "CRM & Deal Desk MCP", url: "mcp-sandbox://crm-revops" },
];

export function McpDiscoveryCard({ onImported }: { onImported: () => void }) {
  const [serverUrl, setServerUrl] = useState("mcp-sandbox://wealth-brokerage");
  const [authHeaderName, setAuthHeaderName] = useState("");
  const [authEnvVar, setAuthEnvVar] = useState("");
  const [busy, setBusy] = useState(false);
  const [importingTool, setImportingTool] = useState<string | null>(null);
  const [result, setResult] = useState<McpDiscoveryResult | null>(null);
  const [importedSet, setImportedSet] = useState<Set<string>>(() => new Set());
  const [dualControlByTool, setDualControlByTool] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function runDiscovery(overrideUrl?: string) {
    const targetUrl = (overrideUrl ?? serverUrl).trim();
    if (!targetUrl) return;
    if (overrideUrl) setServerUrl(overrideUrl);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await api.discoverMcp({
        serverUrl: targetUrl,
        ...(authHeaderName.trim() ? { authHeaderName: authHeaderName.trim() } : {}),
        ...(authEnvVar.trim() ? { authEnvVar: authEnvVar.trim() } : {}),
      });
      setResult(res);
      const already = new Set(res.tools.filter((t) => t.alreadyImported).map((t) => t.name));
      setImportedSet(already);
      setNotice(`Discovered ${res.tools.length} tool(s) from ${res.serverName} via MCP tools/list (${res.protocolVersion}).`);
    } catch (err: unknown) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function importTool(tool: McpDiscoveredTool) {
    if (!result) return;
    setImportingTool(tool.name);
    setError("");
    setNotice("");
    try {
      const imported = await api.importMcpTool({
        serverUrl: result.serverUrl,
        toolName: tool.name,
        description: tool.description,
        effect: tool.effect,
        domain: tool.suggestedDomain,
        requiresApproval: tool.effect === "write",
        dualControl: Boolean(dualControlByTool[tool.name]),
        ...(authHeaderName.trim() ? { authHeaderName: authHeaderName.trim() } : {}),
        ...(authEnvVar.trim() ? { authEnvVar: authEnvVar.trim() } : {}),
      });
      setImportedSet((prev) => new Set([...prev, tool.name]));
      setNotice(`Imported "${tool.name}" as governed connector "${imported.connector.id}" (HITL ${imported.connector.requiresApproval ? "enabled" : "off"}). Available in External Connectors & Workflows.`);
      onImported();
    } catch (err: unknown) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setImportingTool(null);
    }
  }

  return (
    <section className="admin-card mcp-discovery-card" aria-labelledby="mcp-discovery-title" style={{ marginTop: "18px" }}>
      <div className="mcp-head">
        <div>
          <h2 id="mcp-discovery-title" style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <Plug size={18} aria-hidden="true" />
            MCP Server Auto-Discovery (<code>tools/list</code> Importer)
          </h2>
          <p>
            Connect any live HTTP JSON-RPC 2.0 MCP server (or try a built-in enterprise sandbox preset) to inspect tool schemas and import them as governed <code>sfield</code> connectors with SHA-256 HITL protection.
          </p>
        </div>
      </div>

      <form
        className="mcp-discover-form"
        onSubmit={(e) => {
          e.preventDefault();
          void runDiscovery();
        }}
      >
        <input
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          placeholder="https://mcp.company.com/rpc or mcp-sandbox://wealth-brokerage"
          aria-label="MCP Server URL"
        />
        <input
          value={authHeaderName}
          onChange={(e) => setAuthHeaderName(e.target.value)}
          placeholder="Auth header (optional)"
          style={{ maxWidth: "160px" }}
        />
        <input
          value={authEnvVar}
          onChange={(e) => setAuthEnvVar(e.target.value)}
          placeholder="Secret env var (optional)"
          style={{ maxWidth: "170px" }}
        />
        <button type="submit" className="eval-run-btn" disabled={busy || !serverUrl.trim()}>
          <Search size={14} aria-hidden="true" />
          {busy ? "Discovering…" : "Discover Tools (tools/list)"}
        </button>
      </form>

      <div className="mcp-presets">
        <span>Sandbox MCP Servers:</span>
        {MCP_PRESETS.map((p) => (
          <button
            key={p.url}
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void runDiscovery(p.url)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {notice && <p className="eval-notice" role="status">{notice}</p>}
      {error && <p className="request-notice" role="alert">{error}</p>}

      {result && (
        <div className="mcp-tools-grid">
          {result.tools.map((tool) => {
            const isImported = importedSet.has(tool.name);
            return (
              <div key={tool.name} className="mcp-tool-card">
                <div className="mcp-tool-top">
                  <strong><code>{tool.name}</code></strong>
                  <span className={`mcp-effect-pill is-${tool.effect}`}>{tool.effect}</span>
                  <span className="mcp-domain-pill">{tool.suggestedDomain}</span>
                </div>
                <p className="mcp-tool-desc">{tool.description}</p>
                {tool.parameters.length > 0 && (
                  <div className="mcp-params">
                    <span>Schema params:</span>
                    {tool.parameters.map((p) => (
                      <code key={p.name}>
                        {p.name}{p.required ? "*" : ""}: {p.type}
                      </code>
                    ))}
                  </div>
                )}
                <div className="mcp-tool-foot">
                  <label className="mcp-dual-check">
                    <input
                      type="checkbox"
                      checked={Boolean(dualControlByTool[tool.name])}
                      disabled={isImported}
                      onChange={(e) => setDualControlByTool((prev) => ({ ...prev, [tool.name]: e.target.checked }))}
                    />
                    <ShieldCheck size={13} aria-hidden="true" />
                    <span>4-Eyes HITL</span>
                  </label>
                  <button
                    type="button"
                    className={isImported ? "secondary-button" : "eval-run-btn"}
                    disabled={importingTool === tool.name}
                    onClick={() => void importTool(tool)}
                  >
                    {isImported ? (
                      <><Check size={14} aria-hidden="true" />Imported (Re-sync)</>
                    ) : importingTool === tool.name ? (
                      "Importing…"
                    ) : (
                      <><Download size={14} aria-hidden="true" />Import Connector</>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
