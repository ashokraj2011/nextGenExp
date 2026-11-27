import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Play, Server, Terminal } from "lucide-react";
import { api, toolSetupErrorMessage } from "./api";

type McpServerView = Awaited<ReturnType<typeof api.mcpServerConfig>>;

export function McpServerPanel() {
  const [data, setData] = useState<McpServerView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedTool, setSelectedTool] = useState("cep.empathy.assess@1.0.0");
  const [argsJson, setArgsJson] = useState("");
  const [testOutput, setTestOutput] = useState("");
  const [runningTest, setRunningTest] = useState(false);
  const [copiedMode, setCopiedMode] = useState<"" | "http" | "stdio">("");

  useEffect(() => {
    void api.mcpServerConfig().then((res) => {
      setData(res);
      const firstEnabled = res.sfieldTools.find((t) => t.enabled) ?? res.sfieldTools[0];
      if (firstEnabled) {
        setSelectedTool(firstEnabled.ref);
        setArgsJson(JSON.stringify(firstEnabled.sampleArgs, null, 2));
      }
    }).catch((e) => setError(toolSetupErrorMessage(e)));
  }, []);

  const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:4180";

  const httpSnippet = useMemo(() => JSON.stringify({
    mcpServers: {
      "cep-sfield": {
        type: "streamable-http",
        url: `${origin}/api/mcp`,
      },
    },
  }, null, 2), [origin]);

  const stdioSnippet = useMemo(() => JSON.stringify({
    mcpServers: {
      "cep-sfield-stdio": {
        command: "npm",
        args: ["run", "mcp:stdio"],
      },
    },
  }, null, 2), []);

  async function saveNext(next: McpServerView["config"]) {
    setBusy(true);
    setError("");
    try {
      const saved = await api.saveMcpServerConfig(next);
      setData(saved);
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleTool(ref: string, enabled: boolean) {
    if (!data) return;
    const set = new Set(data.config.enabledToolRefs);
    if (enabled) set.add(ref);
    else set.delete(ref);
    void saveNext({ ...data.config, enabledToolRefs: [...set] });
  }

  function pickTestTool(ref: string) {
    setSelectedTool(ref);
    if (!data) return;
    if (ref === "cep.knowledge.search@1.0.0") {
      setArgsJson(JSON.stringify({ query: "trade approval threshold", limit: 3 }, null, 2));
      return;
    }
    const found = data.sfieldTools.find((t) => t.ref === ref);
    if (found) setArgsJson(JSON.stringify(found.sampleArgs, null, 2));
  }

  async function runLiveTest() {
    setRunningTest(true);
    setError("");
    try {
      const parsedArgs = argsJson.trim() ? JSON.parse(argsJson) as Record<string, unknown> : {};
      const res = await api.callMcpRpc("tools/call", { name: selectedTool, arguments: parsedArgs });
      setTestOutput(JSON.stringify(res, null, 2));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to run MCP tool call");
    } finally {
      setRunningTest(false);
    }
  }

  async function copySnippet(mode: "http" | "stdio", text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMode(mode);
      setTimeout(() => setCopiedMode(""), 1800);
    } catch { /* ignore */ }
  }

  return (
    <section className="admin-card" aria-labelledby="sfield-mcp-server-title">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", flexWrap: "wrap" }}>
        <div>
          <h2 id="sfield-mcp-server-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Server size={18} aria-hidden="true" />
            sfield Governed MCP Server (Streamable HTTP + stdio)
          </h2>
          <p className="admin-muted" style={{ marginTop: "4px" }}>
            Powered by <code>@sfield/core</code> <code>sf.createMcpServer()</code> (MCP <code>{data?.protocolVersion ?? "2025-03-26"}</code>).
            Choose which governed <code>sfield</code> tools external agents (Claude, Cursor, Copilot Studio) may invoke at <code>POST /api/mcp</code> or via <code>npm run mcp:stdio</code>.
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button type="button" className="secondary-button" onClick={() => void copySnippet("http", httpSnippet)}>
            {copiedMode === "http" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            Copy HTTP Config
          </button>
          <button type="button" className="secondary-button" onClick={() => void copySnippet("stdio", stdioSnippet)}>
            {copiedMode === "stdio" ? <Check size={13} aria-hidden="true" /> : <Terminal size={13} aria-hidden="true" />}
            Copy stdio Config
          </button>
        </div>
      </div>

      {error && <p className="admin-error" role="alert">{error}</p>}

      {data && (
        <>
          <ul className="admin-tools" style={{ marginTop: "12px" }}>
            {data.sfieldTools.map((tool) => (
              <li key={tool.ref}>
                <label className="admin-tool">
                  <span>
                    <strong>{tool.label}</strong>
                    <code>{tool.ref} · sfield {tool.effect} · read_only scope</code>
                    <small>{tool.description}</small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={"Expose " + tool.ref + " over MCP"}
                    checked={tool.enabled}
                    disabled={busy}
                    onChange={(e) => toggleTool(tool.ref, e.target.checked)}
                  />
                </label>
              </li>
            ))}
            <li>
              <label className="admin-tool">
                <span>
                  <strong>Enterprise Policy Knowledge Search (Hybrid RAG)</strong>
                  <code>cep.knowledge.search@1.0.0 · BM25 + Vector</code>
                  <small>Allows MCP clients to query verified compliance policies and runbooks with citations.</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="Expose Knowledge Base search over MCP"
                  checked={data.config.includeKnowledgeSearch}
                  disabled={busy}
                  onChange={(e) => void saveNext({ ...data.config, includeKnowledgeSearch: e.target.checked })}
                />
              </label>
            </li>
            <li>
              <label className="admin-tool">
                <span>
                  <strong>Published Integration Tasks ({data.publishedTaskCount})</strong>
                  <code>int.* · sfield Authorizer + HITL Approval Gates</code>
                  <small>Exposes published tasks from /integrations over MCP with automatic HITL approval pauses.</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="Expose published integration tasks over MCP"
                  checked={data.config.includePublishedTasks}
                  disabled={busy}
                  onChange={(e) => void saveNext({ ...data.config, includePublishedTasks: e.target.checked })}
                />
              </label>
            </li>
          </ul>

          <div style={{ marginTop: "16px", padding: "12px", borderRadius: "10px", border: "1px solid var(--border)", background: "var(--surface-subtle, rgba(0,0,0,0.02))" }}>
            <div style={{ display: "flex", gap: "10px", alignItems: "flex-end", flexWrap: "wrap" }}>
              <div className="setup-field" style={{ flex: "1 1 240px", margin: 0 }}>
                <label htmlFor="mcp-test-tool">Live MCP <code>tools/call</code> Runner</label>
                <select id="mcp-test-tool" value={selectedTool} onChange={(e) => pickTestTool(e.target.value)}>
                  {data.sfieldTools.filter((t) => t.enabled).map((t) => (
                    <option key={t.ref} value={t.ref}>{t.label} ({t.ref})</option>
                  ))}
                  {data.config.includeKnowledgeSearch && (
                    <option value="cep.knowledge.search@1.0.0">Knowledge Search (cep.knowledge.search@1.0.0)</option>
                  )}
                </select>
              </div>
              <button type="button" className="send-button" disabled={runningTest} onClick={() => void runLiveTest()}>
                <Play size={14} aria-hidden="true" />
                {runningTest ? "Running…" : "Run tools/call"}
              </button>
            </div>
            <div className="setup-field" style={{ marginTop: "10px" }}>
              <label htmlFor="mcp-test-args">JSON Arguments</label>
              <textarea
                id="mcp-test-args"
                rows={4}
                style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.82rem", width: "100%" }}
                value={argsJson}
                onChange={(e) => setArgsJson(e.target.value)}
              />
            </div>
            {testOutput && (
              <pre style={{ marginTop: "10px", maxHeight: "220px", overflow: "auto", fontSize: "0.78rem", padding: "10px", borderRadius: "8px", background: "var(--surface, #fff)", border: "1px solid var(--border)" }}>
                {testOutput}
              </pre>
            )}
          </div>
        </>
      )}
    </section>
  );
}
