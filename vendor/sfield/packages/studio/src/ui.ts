/**
 * Self-contained HTML/CSS/JS workbench UI for @sfield/studio.
 * Zero React/Vite build dependency — works standalone via `sfield studio` or embedded in any Node HTTP app.
 */
import type { StudioPluginTab } from "./types.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderStudioHtml(opts: {
  title: string;
  basePath: string;
  readOnly: boolean;
  plugins: StudioPluginTab[];
  approvalChatPath?: string;
}): string {
  const safeTitle = escapeHtml(opts.title);
  const bootConfig = JSON.stringify({
    title: opts.title,
    basePath: opts.basePath,
    readOnly: opts.readOnly,
    plugins: opts.plugins,
    approvalChatPath: opts.approvalChatPath,
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    :root {
      --bg: #0b0e14;
      --surface: #121722;
      --surface-2: #181f2e;
      --border: #263044;
      --text: #e6edf7;
      --muted: #8b9bb4;
      --accent: #4f8cff;
      --accent-soft: rgba(79, 140, 255, 0.14);
      --ok: #2ecc71;
      --ok-soft: rgba(46, 204, 113, 0.14);
      --warn: #f5a623;
      --warn-soft: rgba(245, 166, 35, 0.14);
      --err: #ff5c72;
      --err-soft: rgba(255, 92, 114, 0.14);
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14px; height: 100%; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .shell { display: grid; grid-template-columns: 248px 1fr; min-height: 100vh; }
    .rail { background: var(--surface); border-right: 1px solid var(--border); padding: 18px 12px; display: flex; flex-direction: column; gap: 18px; }
    .brand { display: flex; align-items: center; gap: 10px; padding: 6px 10px; }
    .brand-mark { width: 28px; height: 28px; border-radius: 8px; background: linear-gradient(135deg, #4f8cff, #7c5cff); display: grid; place-items: center; font-weight: 800; color: #fff; font-size: 13px; }
    .brand-title { font-weight: 700; font-size: 15px; letter-spacing: -0.01em; }
    .brand-sub { font-size: 11px; color: var(--muted); }
    .nav-group-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); padding: 0 10px 6px; font-weight: 600; }
    .nav { display: flex; flex-direction: column; gap: 2px; }
    .nav button, .nav a.nav-link {
      display: flex; align-items: center; justify-content: space-between; width: 100%;
      background: transparent; border: 1px solid transparent; color: var(--text);
      padding: 8px 10px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 13px; text-align: left;
    }
    .nav button:hover, .nav a.nav-link:hover { background: var(--surface-2); text-decoration: none; }
    .nav button.active { background: var(--accent-soft); border-color: rgba(79, 140, 255, 0.35); color: #fff; font-weight: 600; }
    .pill { font-size: 11px; padding: 2px 7px; border-radius: 999px; background: var(--surface-2); color: var(--muted); border: 1px solid var(--border); }
    .pill.ok { background: var(--ok-soft); color: var(--ok); border-color: rgba(46, 204, 113, 0.3); }
    .pill.warn { background: var(--warn-soft); color: var(--warn); border-color: rgba(245, 166, 35, 0.3); }
    .pill.err { background: var(--err-soft); color: var(--err); border-color: rgba(255, 92, 114, 0.3); }
    .pill.accent { background: var(--accent-soft); color: #8cb7ff; border-color: rgba(79, 140, 255, 0.35); }
    .main { display: flex; flex-direction: column; min-width: 0; }
    .topbar { display: flex; align-items: center; justify-content: space-between; padding: 14px 24px; border-bottom: 1px solid var(--border); background: var(--surface); gap: 12px; }
    .topbar h1 { margin: 0; font-size: 17px; font-weight: 650; }
    .topbar-right { display: flex; align-items: center; gap: 10px; }
    .content { padding: 22px 24px 40px; max-width: 1280px; width: 100%; display: flex; flex-direction: column; gap: 18px; }
    .grid-4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
    .card h2, .card h3 { margin: 0 0 10px; font-size: 14px; font-weight: 650; }
    .kpi-label { font-size: 12px; color: var(--muted); }
    .kpi-val { font-size: 24px; font-weight: 700; margin-top: 6px; letter-spacing: -0.02em; }
    .kpi-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .btn {
      background: var(--surface-2); color: var(--text); border: 1px solid var(--border);
      padding: 7px 12px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 13px; font-weight: 500;
    }
    .btn:hover:not(:disabled) { border-color: var(--accent); }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.ok { background: var(--ok-soft); border-color: rgba(46, 204, 113, 0.4); color: var(--ok); }
    .btn.err { background: var(--err-soft); border-color: rgba(255, 92, 114, 0.4); color: var(--err); }
    .btn:disabled { opacity: 0.45; cursor: not-allowed; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; }
    tr.clickable { cursor: pointer; }
    tr.clickable:hover td { background: var(--surface-2); }
    pre, code { font-family: var(--mono); font-size: 12px; }
    pre { margin: 0; padding: 12px; background: #090c11; border: 1px solid var(--border); border-radius: 8px; overflow: auto; max-height: 360px; white-space: pre-wrap; word-break: break-word; }
    input, textarea, select {
      width: 100%; background: #090c11; color: var(--text); border: 1px solid var(--border);
      border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 13px;
    }
    textarea.mono { font-family: var(--mono); font-size: 12px; min-height: 92px; }
    label.field { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--muted); }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .stack { display: flex; flex-direction: column; gap: 12px; }
    .muted { color: var(--muted); }
    .empty { color: var(--muted); padding: 24px 12px; text-align: center; font-size: 13px; }
    .notice { padding: 10px 12px; border-radius: 8px; background: var(--accent-soft); border: 1px solid rgba(79, 140, 255, 0.35); font-size: 13px; }
    .notice.err { background: var(--err-soft); border-color: rgba(255, 92, 114, 0.35); color: #ffd3da; }
    .notice.ok { background: var(--ok-soft); border-color: rgba(46, 204, 113, 0.35); color: #ccf6dd; }
    .plugin-frame { width: 100%; height: calc(100vh - 130px); border: 1px solid var(--border); border-radius: 10px; background: #fff; }
    .wf-list { display: flex; flex-direction: column; gap: 8px; }
    .wf-row { display: grid; grid-template-columns: 180px 1fr 90px; gap: 10px; align-items: center; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: #0d121b; }
    .wf-bar-track { height: 10px; border-radius: 999px; background: var(--surface-2); overflow: hidden; position: relative; }
    .wf-bar { height: 100%; border-radius: 999px; background: var(--accent); min-width: 6px; }
    .wf-bar.ok { background: var(--ok); }
    .wf-bar.warn { background: var(--warn); }
    .wf-bar.err { background: var(--err); }
    @media (max-width: 820px) {
      .shell { grid-template-columns: 1fr; }
      .rail { border-right: none; border-bottom: 1px solid var(--border); }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="rail">
      <div class="brand">
        <div class="brand-mark">sf</div>
        <div>
          <div class="brand-title" id="studio-title">${safeTitle}</div>
          <div class="brand-sub">@sfield/studio · Governed SDK</div>
        </div>
      </div>
      <div>
        <div class="nav-group-label">SDK Workbench</div>
        <nav class="nav" id="core-nav"></nav>
      </div>
      <div id="plugin-section" style="display:none">
        <div class="nav-group-label">Host Plugins</div>
        <nav class="nav" id="plugin-nav"></nav>
      </div>
      <div style="margin-top:auto;padding:8px 10px;font-size:11px;color:var(--muted)" id="rail-footer"></div>
    </aside>
    <div class="main">
      <header class="topbar">
        <h1 id="page-heading">Overview</h1>
        <div class="topbar-right">
          <span class="pill" id="health-pill">Loading…</span>
          <button class="btn" id="refresh-btn" type="button">Refresh</button>
        </div>
      </header>
      <main class="content" id="view-root"></main>
    </div>
  </div>
  <script>
    const BOOT = ${bootConfig};
    const API = (BOOT.basePath || "") + "/api";
    const CORE_TABS = [
      { id: "overview", label: "Overview & Locks" },
      { id: "runs", label: "Runs & Waterfall" },
      { id: "graphs", label: "Graphs & Time-Travel" },
      { id: "redteam", label: "Red-Team Proofs" },
      { id: "tools", label: "Tools & Playground" },
      { id: "commands", label: "Slash Commands" },
      { id: "mcp2026", label: "MCP 2026 Elicitation & Tasks" },
      { id: "approvals", label: "HITL Approvals" },
      { id: "evals", label: "Evals & Gate" },
      { id: "memory", label: "Memory Explorer" },
      { id: "pii", label: "PII Firewall Lab" },
      { id: "telemetry", label: "OTel Telemetry" },
    ];
    let activeTab = "overview";
    let state = { overview: null, runs: [], selectedRun: null, tools: [], approvals: [], evals: [], memory: [], telemetry: null, mcp2026: null, mcpLastOut: null, graphs: null, selectedGraphRunId: null, redteam: null, commands: null, commandTenant: "pzn-local" };

    async function api(path, opts) {
      const res = await fetch(API + path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts || {}));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || ("HTTP " + res.status));
      return data;
    }

    function esc(v) {
      return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function pill(text, tone) {
      return '<span class="pill ' + (tone || "") + '">' + esc(text) + '</span>';
    }

    function renderNav() {
      const counts = state.overview ? state.overview.counts : {};
      const coreEl = document.getElementById("core-nav");
      coreEl.innerHTML = CORE_TABS.map((tab) => {
        const badge = tab.id === "approvals" && counts.pendingApprovals > 0
          ? pill(counts.pendingApprovals, "warn")
          : tab.id === "runs" && counts.runs != null ? pill(counts.runs)
          : tab.id === "tools" && counts.tools != null ? pill(counts.tools)
          : "";
        return '<button type="button" class="' + (activeTab === tab.id ? "active" : "") + '" data-tab="' + tab.id + '"><span>' + esc(tab.label) + '</span>' + badge + '</button>';
      }).join("");
      coreEl.querySelectorAll("button").forEach((btn) => {
        btn.onclick = () => { activeTab = btn.dataset.tab; renderNav(); void loadActiveTab(); };
      });

      const pluginSec = document.getElementById("plugin-section");
      const pluginNav = document.getElementById("plugin-nav");
      if (BOOT.plugins && BOOT.plugins.length > 0) {
        pluginSec.style.display = "block";
        pluginNav.innerHTML = BOOT.plugins.map((p) => {
          if (p.href && !p.iframeSrc) {
            return '<a class="nav-link" href="' + esc(p.href) + '"><span>' + esc(p.label) + '</span>' + (p.badge ? pill(p.badge, "accent") : "") + '</a>';
          }
          return '<button type="button" class="' + (activeTab === "plugin:" + p.id ? "active" : "") + '" data-tab="plugin:' + esc(p.id) + '"><span>' + esc(p.label) + '</span>' + (p.badge ? pill(p.badge, "accent") : "") + '</button>';
        }).join("");
        pluginNav.querySelectorAll("button").forEach((btn) => {
          btn.onclick = () => { activeTab = btn.dataset.tab; renderNav(); void loadActiveTab(); };
        });
      }
      document.getElementById("rail-footer").textContent = BOOT.readOnly ? "Read-only mode" : "Interactive mode";
    }

    async function loadOverview() {
      state.overview = await api("/overview");
      const hp = document.getElementById("health-pill");
      const ok = Boolean(state.overview.health && state.overview.health.ok);
      hp.className = "pill " + (ok ? "ok" : "err");
      hp.textContent = ok ? ("Healthy · " + (state.overview.deployment || "persistence")) : "Degraded";
      renderNav();
    }

    async function loadActiveTab() {
      const root = document.getElementById("view-root");
      const heading = document.getElementById("page-heading");
      try {
        await loadOverview();
        if (activeTab === "overview") {
          heading.textContent = "Overview & Governance Locks";
          renderOverview(root);
        } else if (activeTab === "runs") {
          heading.textContent = "Runs, Visual Waterfall & Traces";
          const data = await api("/runs?limit=50");
          state.runs = data.runs || [];
          renderRuns(root);
        } else if (activeTab === "graphs") {
          heading.textContent = "Governed State Graphs & Checkpoint Time-Travel";
          state.graphs = await api("/graphs/runs");
          renderGraphs(root);
        } else if (activeTab === "redteam") {
          heading.textContent = "1-Click Zero-Trust Governance & Red-Team Proofs";
          renderRedTeam(root);
        } else if (activeTab === "tools") {
          heading.textContent = "Tool Registry & Principal Playground";
          const data = await api("/tools");
          state.tools = data.tools || [];
          renderTools(root);
        } else if (activeTab === "commands") {
          heading.textContent = "Tenant Slash Commands (sf.commands)";
          state.commands = await api("/commands?includeDisabled=true&tenantId=" + encodeURIComponent(state.commandTenant || "pzn-local"));
          renderCommands(root);
        } else if (activeTab === "mcp2026") {
          heading.textContent = "MCP 2026 · Elicitation & Async Tasks";
          state.mcp2026 = await api("/mcp2026/state");
          renderMcp2026(root);
        } else if (activeTab === "approvals") {
          heading.textContent = "Human-in-the-Loop Approvals";
          const data = await api("/approvals");
          state.approvals = data.approvals || [];
          renderApprovals(root);
        } else if (activeTab === "evals") {
          heading.textContent = "Eval Reports & Release Gate";
          const data = await api("/evals");
          state.evals = data.reports || [];
          renderEvals(root);
        } else if (activeTab === "memory") {
          heading.textContent = "Memory Explorer";
          const data = await api("/memory");
          state.memory = data.items || [];
          renderMemory(root);
        } else if (activeTab === "pii") {
          heading.textContent = "PII Firewall Lab";
          renderPii(root);
        } else if (activeTab === "telemetry") {
          heading.textContent = "OpenTelemetry GenAI Spans & Metrics";
          state.telemetry = await api("/telemetry");
          renderTelemetry(root);
        } else if (activeTab.startsWith("plugin:")) {
          const pid = activeTab.slice(7);
          const plugin = (BOOT.plugins || []).find((p) => p.id === pid);
          heading.textContent = plugin ? plugin.label : "Plugin";
          renderPlugin(root, plugin);
        }
      } catch (err) {
        root.innerHTML = '<div class="notice err">' + esc(err.message || err) + '</div>';
      }
    }

    function renderOverview(root) {
      const o = state.overview;
      const c = o.counts || {};
      const lock = o.lock;
      root.innerHTML =
        '<div class="grid-4">' +
          '<div class="card"><div class="kpi-label">Registered Tools</div><div class="kpi-val">' + esc(c.tools ?? 0) + '</div><div class="kpi-sub">Closed JSON schemas</div></div>' +
          '<div class="card"><div class="kpi-label">Persisted Runs</div><div class="kpi-val">' + esc(c.runs ?? 0) + '</div><div class="kpi-sub">Latest 50 indexed</div></div>' +
          '<div class="card"><div class="kpi-label">Pending Approvals</div><div class="kpi-val">' + esc(c.pendingApprovals ?? 0) + '</div><div class="kpi-sub">SHA-256 digest bound</div></div>' +
          '<div class="card"><div class="kpi-label">OTel Spans</div><div class="kpi-val">' + esc(c.spans ?? 0) + '</div><div class="kpi-sub">' + esc(c.evalReports ?? 0) + ' eval report(s)</div></div>' +
        '</div>' +
        '<div class="grid-2">' +
          '<div class="card stack">' +
            '<div class="row" style="justify-content:space-between"><h2>Config Digest & Governance Lock</h2>' + (lock && lock.approved ? pill("Approved", "ok") : pill("Unapproved", "warn")) + '</div>' +
            '<div class="muted">Digest: <code>' + esc(o.configDigest || "N/A (persistence-only mode)") + '</code></div>' +
            (lock && lock.record ? '<div class="muted">Approver: <strong>' + esc(lock.record.approver) + '</strong> · ' + esc(lock.record.decidedAt) + (lock.record.comment ? ' · "' + esc(lock.record.comment) + '"' : '') + '</div>' : '<div class="muted">No lock approval recorded yet for the active digest.</div>') +
            (!BOOT.readOnly && o.configDigest ? '<div class="row">' +
              (BOOT.approvalChatPath ? '' : '<input id="lock-approver" placeholder="Approver name" value="studio-operator" style="max-width:180px" />') +
              '<input id="lock-comment" placeholder="Approval note" style="flex:1" /><button class="btn primary" id="approve-lock-btn" type="button">' +
              (BOOT.approvalChatPath ? 'Request lock approval' : 'Approve Lock') + '</button></div><div id="lock-msg"></div>' : '') +
          '</div>' +
          '<div class="card stack">' +
            '<h2>Agents & Models</h2>' +
            '<div class="muted">Deployment: <code>' + esc(o.deployment || "unknown") + '</code> · Live runtime: ' + (o.hasRuntime ? pill("Connected", "ok") : pill("DB Inspect Only", "warn")) + '</div>' +
            '<div class="muted">Models: ' + ((o.models && o.models.length) ? o.models.map((m) => pill(m, "accent")).join(" ") : '<em>none</em>') + '</div>' +
            '<div class="muted">Agents: ' + ((o.agents && o.agents.length) ? o.agents.map((a) => pill(a)).join(" ") : '<em>none</em>') + '</div>' +
          '</div>' +
        '</div>';

      const btn = document.getElementById("approve-lock-btn");
      if (btn) {
        btn.onclick = async () => {
          const msg = document.getElementById("lock-msg");
          try {
            const approver = document.getElementById("lock-approver")?.value.trim();
            const comment = document.getElementById("lock-comment").value.trim();
            const out = await api("/locks/approve", { method: "POST", body: JSON.stringify({
              digest: o.configDigest, comment,
              ...(BOOT.approvalChatPath ? {} : { approver: approver || "studio-operator", noBaseline: true }),
            }) });
            if (BOOT.approvalChatPath && out.status === "pending_approval" && out.approval) {
              msg.innerHTML = '<div class="notice ok"><a href="' + esc(BOOT.approvalChatPath + '?review=' + encodeURIComponent(out.approval.id)) + '">Review in Admin chat</a></div>';
              return;
            }
            msg.innerHTML = '<div class="notice ok">Lock approved for ' + esc(o.configDigest.slice(0, 16)) + '…</div>';
            await loadActiveTab();
          } catch (e) {
            msg.innerHTML = '<div class="notice err">' + esc(e.message) + '</div>';
          }
        };
      }
    }

    function renderRuns(root) {
      const rows = state.runs.map((r) => {
        const p = r.principal || {};
        const kind = p.kind || "human";
        const ids = p.identifiers ? Object.entries(p.identifiers).map(([k, v]) => pill(k + "=" + v, "accent")).join(" ") : "";
        const obo = p.actingFor ? pill("OBO: " + p.actingFor.subjectId, "warn") : "";
        const stTone = r.state === "completed" ? "ok" : (r.state === "failed" || r.state === "cancelled" ? "err" : "warn");
        return '<tr class="clickable" data-run="' + esc(r.runId) + '">' +
          '<td><code>' + esc(r.runId.slice(0, 18)) + '</code></td>' +
          '<td>' + pill(r.state, stTone) + '</td>' +
          '<td><code>' + esc(r.agentId) + '</code></td>' +
          '<td>' + pill(kind, kind === "agent" ? "accent" : "") + ' <strong>' + esc(r.subjectId) + '</strong> ' + ids + ' ' + obo + '</td>' +
          '<td>' + esc((r.usage && r.usage.toolCalls) || 0) + ' tools / ' + esc((r.usage && r.usage.totalTokens) || 0) + ' tok</td>' +
          '<td class="muted">' + esc(r.createdAt) + '</td>' +
        '</tr>';
      }).join("");
      root.innerHTML =
        '<div class="card">' +
          '<h2>Persisted Runs (' + state.runs.length + ')</h2>' +
          (state.runs.length
            ? '<table><thead><tr><th>Run ID</th><th>State</th><th>Agent</th><th>Principal & Identifiers</th><th>Usage</th><th>Created</th></tr></thead><tbody>' + rows + '</tbody></table>'
            : '<div class="empty">No runs recorded in persistence yet. Try invoking a tool in <strong>Tools &amp; Playground</strong>.</div>') +
        '</div>' +
        '<div id="run-detail"></div>';

      root.querySelectorAll("tr[data-run]").forEach((tr) => {
        tr.onclick = async () => {
          const detail = document.getElementById("run-detail");
          detail.innerHTML = '<div class="card">Loading run trace…</div>';
          try {
            const d = await api("/runs/" + encodeURIComponent(tr.dataset.run));
            const wfItems = []
              .concat((d.modelAttempts || []).map((m, idx) => ({
                label: "Model #" + (idx + 1) + " · " + (m.model || "llm"),
                tone: m.status === "succeeded" ? "ok" : "warn",
                ms: Math.max(1, Number(m.durationMs || 15)),
                meta: (m.usage && m.usage.totalTokens ? m.usage.totalTokens + " tok" : m.status || "done"),
              })))
              .concat((d.calls || []).map((c) => ({
                label: "Tool · " + (c.toolRef || c.toolId || "call"),
                tone: c.status === "succeeded" ? "ok" : (c.status === "suspended" ? "warn" : "err"),
                ms: Math.max(1, Number(c.durationMs || 5)),
                meta: c.status || "done",
              })));
            const maxMs = wfItems.reduce((acc, it) => Math.max(acc, it.ms), 1);
            const wfHtml = wfItems.length
              ? '<div class="wf-list">' + wfItems.map((it) =>
                  '<div class="wf-row"><div><code>' + esc(it.label) + '</code></div><div class="wf-bar-track"><div class="wf-bar ' + it.tone + '" style="width:' + Math.max(6, Math.round((it.ms / maxMs) * 100)) + '%"></div></div><div class="muted" style="text-align:right">' + esc(it.meta) + '</div></div>'
                ).join("") + '</div>'
              : '<div class="empty">No model or tool steps recorded on this run.</div>';
            detail.innerHTML =
              '<div class="card stack">' +
                '<div class="row" style="justify-content:space-between"><h2>Run Trace · <code>' + esc(d.run.runId) + '</code></h2>' + pill(d.run.state, d.run.state === "completed" ? "ok" : "warn") + '</div>' +
                '<div><h3>Execution Waterfall (' + wfItems.length + ' steps)</h3>' + wfHtml + '</div>' +
                '<div class="grid-2">' +
                  '<div><h3>Principal & Identity</h3><pre>' + esc(JSON.stringify(d.run.principal, null, 2)) + '</pre></div>' +
                  '<div><h3>Tool Calls (' + d.calls.length + ')</h3><pre>' + esc(JSON.stringify(d.calls, null, 2)) + '</pre></div>' +
                '</div>' +
                '<div class="grid-2">' +
                  '<div><h3>Audit Trail (' + d.audit.length + ')</h3><pre>' + esc(JSON.stringify(d.audit, null, 2)) + '</pre></div>' +
                  '<div><h3>Model Attempts (' + d.modelAttempts.length + ')</h3><pre>' + esc(JSON.stringify(d.modelAttempts, null, 2)) + '</pre></div>' +
                '</div>' +
              '</div>';
          } catch (e) {
            detail.innerHTML = '<div class="notice err">' + esc(e.message) + '</div>';
          }
        };
      });
    }

    function renderTools(root) {
      const rows = state.tools.map((t) =>
        '<tr>' +
          '<td><code>' + esc(t.ref) + '</code></td>' +
          '<td>' + pill(t.policy.effect, t.policy.effect === "read" ? "ok" : "warn") + (t.policy.requiresApproval ? ' ' + pill("HITL", "err") : '') + '</td>' +
          '<td>' + pill(t.policy.classification) + '</td>' +
          '<td class="muted">' + esc(t.description || "") + '</td>' +
        '</tr>'
      ).join("");
      const opts = state.tools.map((t) => '<option value="' + esc(t.ref) + '">' + esc(t.ref) + ' (' + esc(t.policy.effect) + ')</option>').join("");
      root.innerHTML =
        '<div class="grid-2">' +
          '<div class="card">' +
            '<h2>Registered Tools (' + state.tools.length + ')</h2>' +
            (state.tools.length
              ? '<table><thead><tr><th>Tool Ref</th><th>Effect</th><th>Class</th><th>Description</th></tr></thead><tbody>' + rows + '</tbody></table>'
              : '<div class="empty">No live runtime tools registered (start Studio with a live SField runtime).</div>') +
          '</div>' +
          '<div class="card stack">' +
            '<h2>Principal & Tool Playground</h2>' +
            '<div class="muted">Execute any registered tool through <code>sfield</code> with custom domain identifiers (<code>mrn</code>, <code>orderId</code>, <code>mid</code>) or Agent On-Behalf-Of (<code>actingFor</code>).</div>' +
            '<label class="field">Tool<select id="pg-tool">' + opts + '</select></label>' +
            '<div class="row">' +
              '<label class="field" style="flex:1">Tenant ID<input id="pg-tenant" value="demo-tenant" /></label>' +
              '<label class="field" style="flex:1">Subject ID<input id="pg-subject" value="studio-user" /></label>' +
              '<label class="field" style="width:130px">Kind<select id="pg-kind"><option value="human">human</option><option value="agent">agent</option><option value="service">service</option></select></label>' +
            '</div>' +
            '<label class="field">Principal Identifiers (JSON)<input id="pg-ids" value="{&quot;mid&quot;:&quot;DEMO-MID-1001&quot;}" /></label>' +
            '<label class="field">Acting For / On-Behalf-Of Subject (optional, for agent kind)<input id="pg-obo" placeholder="e.g. patient-42" /></label>' +
            '<label class="field">Tool Input Arguments (JSON)<textarea id="pg-args" class="mono">{}</textarea></label>' +
            '<div class="row"><button class="btn primary" id="pg-run-btn" type="button" ' + (BOOT.readOnly || !state.tools.length ? "disabled" : "") + '>Invoke via sfield</button></div>' +
            '<div id="pg-result"></div>' +
          '</div>' +
        '</div>';

      const btn = document.getElementById("pg-run-btn");
      if (btn) {
        btn.onclick = async () => {
          const out = document.getElementById("pg-result");
          out.innerHTML = '<div class="notice">Executing tool…</div>';
          try {
            const toolRef = document.getElementById("pg-tool").value;
            const tenantId = document.getElementById("pg-tenant").value.trim() || "demo-tenant";
            const subjectId = document.getElementById("pg-subject").value.trim() || "studio-user";
            const kind = document.getElementById("pg-kind").value;
            const identifiers = JSON.parse(document.getElementById("pg-ids").value || "{}");
            const obo = document.getElementById("pg-obo").value.trim();
            const args = JSON.parse(document.getElementById("pg-args").value || "{}");
            const principal = { tenantId, subjectId, kind, identifiers };
            if (obo) principal.actingFor = { tenantId, subjectId: obo, kind: "human", identifiers };
            const res = await api("/tools/invoke", { method: "POST", body: JSON.stringify({ toolRef, principal, args }) });
            out.innerHTML = '<div class="notice ' + (res.status === "succeeded" ? "ok" : "err") + '">Status: <strong>' + esc(res.status) + '</strong> · Run: <code>' + esc(res.runId || "") + '</code></div><pre>' + esc(JSON.stringify(res, null, 2)) + '</pre>';
          } catch (e) {
            out.innerHTML = '<div class="notice err">' + esc(e.message) + '</div>';
          }
        };
      }
    }

    function renderApprovals(root) {
      const rows = state.approvals.map((a) => {
        const tone = a.status === "pending" ? "warn" : (a.status === "approved" || a.status === "consumed" ? "ok" : "err");
        const actions = a.status === "pending" && !BOOT.readOnly
          ? '<div class="row"><button class="btn ok" data-decide="approve" data-id="' + esc(a.id) + '">Approve</button><button class="btn err" data-decide="deny" data-id="' + esc(a.id) + '">Deny</button></div>'
          : (a.decision ? '<span class="muted">' + esc(a.decision.decision) + ' by ' + esc(a.decision.actor.subjectId || a.decision.actor.id || "") + '</span>' : '');
        const summary = (a.view && a.view[0]) ? a.view[0].toolRef + " (" + a.view[0].action + ")" : a.runId;
        return '<tr><td><code>' + esc(a.id.slice(0, 16)) + '</code></td><td>' + pill(a.status, tone) + '</td><td>' + esc(summary) + '</td><td><code>' + esc((a.preparedDigests && a.preparedDigests[0] || "").slice(0, 16)) + '…</code></td><td>' + actions + '</td></tr>';
      }).join("");
      root.innerHTML = '<div class="card"><h2>Approvals (' + state.approvals.length + ')</h2>' +
        (state.approvals.length
          ? '<table><thead><tr><th>ID</th><th>Status</th><th>Action</th><th>SHA-256 Digest</th><th>Decision</th></tr></thead><tbody>' + rows + '</tbody></table>'
          : '<div class="empty">No approval records found.</div>') +
        '</div>';
      root.querySelectorAll("button[data-decide]").forEach((btn) => {
        btn.onclick = async () => {
          await api("/approvals/" + encodeURIComponent(btn.dataset.id) + "/decide", {
            method: "POST",
            body: JSON.stringify({ decision: btn.dataset.decide, actorId: "studio-approver", comment: "Decided in @sfield/studio" }),
          });
          await loadActiveTab();
        };
      });
    }

    function renderEvals(root) {
      const rows = state.evals.map((r) => {
        const pct = Math.round((r.passRate || 0) * 100);
        const tone = pct >= 90 ? "ok" : pct >= 70 ? "warn" : "err";
        return '<tr><td><strong>' + esc(r.suite) + '</strong></td><td>' + pill(pct + "% pass", tone) + '</td><td>' + Math.round((r.verifiedSuccessRate || 0) * 100) + '%</td><td><code>' + esc((r.candidateDigest || "").slice(0, 14)) + '</code></td><td class="muted">' + esc(r.createdAt) + '</td></tr>';
      }).join("");
      root.innerHTML = '<div class="card"><h2>Persisted Eval Reports (' + state.evals.length + ')</h2>' +
        (state.evals.length
          ? '<table><thead><tr><th>Suite</th><th>Pass Rate</th><th>Verified</th><th>Digest</th><th>Created</th></tr></thead><tbody>' + rows + '</tbody></table>'
          : '<div class="empty">No eval reports persisted yet. Run <code>sfield eval</code> to record one.</div>') +
        '</div>';
    }

    function renderMemory(root) {
      const rows = state.memory.map((m) =>
        '<tr><td>' + pill(m.kind, "accent") + '</td><td>' + esc(m.content) + '</td><td><code>' + esc(JSON.stringify(m.scope)) + '</code></td><td>' +
        (!BOOT.readOnly ? '<button class="btn err" data-del="' + esc(m.id) + '" data-tenant="' + esc((m.scope && m.scope.tenantId) || "demo-tenant") + '">Forget</button>' : '') + '</td></tr>'
      ).join("");
      root.innerHTML =
        (!BOOT.readOnly ? '<div class="card stack"><h2>Remember Fact / Preference</h2><div class="row">' +
          '<input id="mem-tenant" placeholder="tenantId" value="demo-tenant" style="max-width:150px" />' +
          '<input id="mem-subject" placeholder="subjectId" value="studio-user" style="max-width:150px" />' +
          '<select id="mem-kind" style="max-width:130px"><option value="fact">fact</option><option value="preference">preference</option></select>' +
          '<input id="mem-content" placeholder="Memory content…" style="flex:1" />' +
          '<button class="btn primary" id="mem-add-btn" type="button">Save</button></div></div>' : '') +
        '<div class="card"><h2>Stored Memories (' + state.memory.length + ')</h2>' +
        (state.memory.length
          ? '<table><thead><tr><th>Kind</th><th>Content</th><th>Scope</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
          : '<div class="empty">No memory entries stored.</div>') +
        '</div>';
      const addBtn = document.getElementById("mem-add-btn");
      if (addBtn) {
        addBtn.onclick = async () => {
          const content = document.getElementById("mem-content").value.trim();
          if (!content) return;
          await api("/memory", {
            method: "POST",
            body: JSON.stringify({
              tenantId: document.getElementById("mem-tenant").value.trim() || "demo-tenant",
              subjectId: document.getElementById("mem-subject").value.trim() || "studio-user",
              kind: document.getElementById("mem-kind").value,
              content,
            }),
          });
          await loadActiveTab();
        };
      }
      root.querySelectorAll("button[data-del]").forEach((btn) => {
        btn.onclick = async () => {
          await api("/memory/" + encodeURIComponent(btn.dataset.del) + "?tenantId=" + encodeURIComponent(btn.dataset.tenant || "demo-tenant"), { method: "DELETE" });
          await loadActiveTab();
        };
      });
    }

    function renderPii(root) {
      root.innerHTML =
        '<div class="card stack">' +
          '<h2>Interactive PII Firewall Lab</h2>' +
          '<div class="muted">Tests <code>@sfield/core</code> <code>PiiFirewall</code> egress scrubbing and local rehydration.</div>' +
          '<label class="field">Input Text<textarea id="pii-input" class="mono">Patient Jane Doe (SSN 123-45-6789, email jane@example.com, phone 415-555-0199) asked about account 9876543210.</textarea></label>' +
          '<div class="row"><button class="btn primary" id="pii-test-btn" type="button">Scrub &amp; Rehydrate</button></div>' +
          '<div id="pii-out"></div>' +
        '</div>';
      document.getElementById("pii-test-btn").onclick = async () => {
        const text = document.getElementById("pii-input").value;
        const res = await api("/pii/test", { method: "POST", body: JSON.stringify({ text }) });
        document.getElementById("pii-out").innerHTML =
          '<div class="grid-2">' +
            '<div><h3>Scrubbed Egress (' + res.redactions.length + ' redactions)</h3><pre>' + esc(res.scrubbed) + '</pre></div>' +
            '<div><h3>Rehydrated Output</h3><pre>' + esc(res.rehydrated) + '</pre></div>' +
          '</div>' +
          '<div style="margin-top:12px"><h3>Tokens</h3><pre>' + esc(JSON.stringify(res.redactions, null, 2)) + '</pre></div>';
      };
    }

    function renderTelemetry(root) {
      const t = state.telemetry || { spans: [], metrics: [] };
      const rows = (t.spans || []).slice().reverse().slice(0, 50).map((s) =>
        '<tr><td><code>' + esc(s.name) + '</code></td><td>' + pill(s.status, s.status === "OK" ? "ok" : "err") + '</td><td><code>' + esc(s.traceId.slice(0, 14)) + '</code></td><td><pre style="max-height:110px">' + esc(JSON.stringify(s.attributes)) + '</pre></td></tr>'
      ).join("");
      root.innerHTML =
        '<div class="card stack">' +
          '<div class="row" style="justify-content:space-between"><h2>Recent GenAI Spans (' + (t.spans ? t.spans.length : 0) + ')</h2><a class="btn" href="' + esc(API + "/telemetry/otlp") + '" target="_blank">Export OTLP JSON</a></div>' +
          (t.spans && t.spans.length
            ? '<table><thead><tr><th>Span</th><th>Status</th><th>Trace</th><th>Attributes</th></tr></thead><tbody>' + rows + '</tbody></table>'
            : '<div class="empty">No telemetry spans recorded yet. Attach an <code>OtelTelemetrySink</code> to capture live spans.</div>') +
        '</div>';
    }

    function renderMcp2026(root) {
      const m = state.mcp2026 || { protocolVersion: "2026-07-28", tasks: [], elicitations: [], tools: [] };
      const toolOpts = (m.tools || []).map((t) => '<option value="' + esc(t.name) + '">' + esc(t.name) + '</option>').join("");
      const elicitCards = (m.elicitations || []).map((el) => {
        const props = (el.requestedSchema && el.requestedSchema.properties) ? el.requestedSchema.properties : {};
        const reqList = Array.isArray(el.requestedSchema && el.requestedSchema.required) ? el.requestedSchema.required : [];
        const fieldsHtml = Object.entries(props).map(([key, def]) => {
          const isReq = reqList.includes(key);
          const label = key + (isReq ? " *" : "") + (def && def.description ? " — " + def.description : "");
          if (def && def.type === "boolean") {
            return '<label class="row" style="font-size:13px"><input type="checkbox" style="width:auto" data-elicit-field="' + esc(el.elicitationId) + ':' + esc(key) + '" data-field-type="boolean" checked /> <span>' + esc(label) + '</span></label>';
          }
          if (def && Array.isArray(def.enum)) {
            const opts = def.enum.map((v) => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join("");
            return '<label class="field">' + esc(label) + '<select data-elicit-field="' + esc(el.elicitationId) + ':' + esc(key) + '" data-field-type="string">' + opts + '</select></label>';
          }
          const inputType = (def && (def.type === "number" || def.type === "integer")) ? "number" : "text";
          const defVal = inputType === "number" ? "5000" : "";
          return '<label class="field">' + esc(label) + '<input type="' + inputType + '" value="' + defVal + '" placeholder="' + esc(key) + '" data-elicit-field="' + esc(el.elicitationId) + ':' + esc(key) + '" data-field-type="' + esc((def && def.type) || "string") + '" /></label>';
        }).join("");
        return '<div class="card stack" style="border-color:rgba(245,166,35,0.45)">' +
          '<div class="row" style="justify-content:space-between"><strong>' + esc(el.message) + '</strong>' + pill("input_required", "warn") + '</div>' +
          '<div class="muted" style="font-size:12px">ID: <code>' + esc(el.elicitationId) + '</code></div>' +
          fieldsHtml +
          '<div class="row">' +
            '<button class="btn ok" type="button" data-elicit-act="accept" data-elicit-id="' + esc(el.elicitationId) + '">Accept &amp; Resume</button>' +
            '<button class="btn err" type="button" data-elicit-act="decline" data-elicit-id="' + esc(el.elicitationId) + '">Decline</button>' +
            '<button class="btn" type="button" data-elicit-act="cancel" data-elicit-id="' + esc(el.elicitationId) + '">Cancel</button>' +
          '</div>' +
        '</div>';
      }).join("");

      const taskRows = (m.tasks || []).map((t) => {
        const tone = t.status === "completed" ? "ok" : t.status === "input_required" || t.status === "working" ? "warn" : "err";
        const acts =
          '<button class="btn" type="button" data-task-res="' + esc(t.taskId) + '">Result</button> ' +
          ((t.status === "working" || t.status === "input_required") && !BOOT.readOnly
            ? '<button class="btn err" type="button" data-task-cancel="' + esc(t.taskId) + '">Cancel</button>'
            : '');
        return '<tr><td><code>' + esc(t.taskId) + '</code></td><td><code>' + esc(t.toolName) + '</code></td><td>' + pill(t.status, tone) + '</td><td>' + esc(t.statusMessage || "") + '</td><td>' + acts + '</td></tr>';
      }).join("");

      root.innerHTML =
        '<div class="grid-2">' +
          '<div class="card stack">' +
            '<div class="row" style="justify-content:space-between"><h2>MCP 2026 Tool &amp; Async Task Launcher</h2>' + pill("Protocol " + (m.protocolVersion || "2026-07-28"), "accent") + '</div>' +
            '<div class="muted">Invoke any MCP tool synchronously or as an Async Task (<code>task.ttl</code>). Choose <code>studio.mcp2026.demo@1.0.0</code> to trigger a live mid-flight JSON Schema Elicitation form.</div>' +
            '<label class="field">Tool<select id="mcp-tool-select">' + toolOpts + '</select></label>' +
            '<label class="field">Arguments JSON<textarea id="mcp-args-json" class="mono">{"action": "rebalance_portfolio"}</textarea></label>' +
            '<label class="row" style="font-size:13px"><input type="checkbox" id="mcp-async-chk" style="width:auto" checked /> <span>Run as MCP 2026 Async Task (<code>task: { ttl: 60000 }</code>)</span></label>' +
            '<div class="row"><button class="btn primary" id="mcp-invoke-btn" type="button"' + (BOOT.readOnly ? " disabled" : "") + '>Invoke via MCP 2026</button></div>' +
            (state.mcpLastOut ? '<div><h3>Last JSON-RPC Response</h3><pre>' + esc(JSON.stringify(state.mcpLastOut, null, 2)) + '</pre></div>' : '') +
          '</div>' +
          '<div class="stack">' +
            '<div class="card stack">' +
              '<h2>Pending Elicitations (' + (m.elicitations ? m.elicitations.length : 0) + ')</h2>' +
              (elicitCards || '<div class="empty">No pending elicitations. Invoke <code>studio.mcp2026.demo@1.0.0</code> to trigger one.</div>') +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="card stack">' +
          '<h2>Async Tasks Tray (' + (m.tasks ? m.tasks.length : 0) + ')</h2>' +
          (m.tasks && m.tasks.length
            ? '<table><thead><tr><th>Task ID</th><th>Tool</th><th>Status</th><th>Message</th><th>Actions</th></tr></thead><tbody>' + taskRows + '</tbody></table>'
            : '<div class="empty">No MCP 2026 async tasks yet.</div>') +
        '</div>';

      const invokeBtn = document.getElementById("mcp-invoke-btn");
      if (invokeBtn) {
        invokeBtn.onclick = async () => {
          const name = document.getElementById("mcp-tool-select").value;
          const asyncTask = document.getElementById("mcp-async-chk").checked;
          const parsedArgs = JSON.parse(document.getElementById("mcp-args-json").value || "{}");
          const out = await api("/mcp2026/call", {
            method: "POST",
            body: JSON.stringify({ name, arguments: parsedArgs, asyncTask }),
          });
          state.mcpLastOut = out.response;
          await new Promise((r) => setTimeout(r, 80));
          await loadActiveTab();
        };
      }

      root.querySelectorAll("button[data-elicit-act]").forEach((btn) => {
        btn.onclick = async () => {
          const id = btn.dataset.elicitId;
          const action = btn.dataset.elicitAct;
          const content = {};
          if (action === "accept") {
            root.querySelectorAll('[data-elicit-field^="' + id + ':"]').forEach((el) => {
              const fieldKey = el.dataset.elicitField.slice(id.length + 1);
              const t = el.dataset.fieldType;
              if (t === "boolean") content[fieldKey] = Boolean(el.checked);
              else if (t === "number" || t === "integer") content[fieldKey] = Number(el.value);
              else content[fieldKey] = el.value;
            });
          }
          const out = await api("/mcp2026/elicitations/" + encodeURIComponent(id) + "/respond", {
            method: "POST",
            body: JSON.stringify({ action, ...(action === "accept" ? { content } : {}) }),
          });
          state.mcpLastOut = out.response;
          await loadActiveTab();
        };
      });

      root.querySelectorAll("button[data-task-cancel]").forEach((btn) => {
        btn.onclick = async () => {
          const out = await api("/mcp2026/tasks/" + encodeURIComponent(btn.dataset.taskCancel) + "/cancel", { method: "POST" });
          state.mcpLastOut = out.response;
          await loadActiveTab();
        };
      });

      root.querySelectorAll("button[data-task-res]").forEach((btn) => {
        btn.onclick = async () => {
          const out = await api("/mcp2026/tasks/" + encodeURIComponent(btn.dataset.taskRes) + "/result");
          state.mcpLastOut = out.response;
          renderMcp2026(root);
        };
      });
    }

    function renderGraphs(root) {
      const g = state.graphs || { graphs: [], runs: [] };
      const runs = g.runs || [];
      if (!state.selectedGraphRunId && runs.length) state.selectedGraphRunId = runs[0].runId;
      const active = runs.find((r) => r.runId === state.selectedGraphRunId) || runs[0] || null;

      const runRows = runs.map((r) => {
        const tone = r.status === "completed" ? "ok" : (r.status === "interrupted" ? "warn" : "err");
        const forkBadge = r.parentRunId ? " " + pill("forked", "accent") : "";
        return '<tr class="clickable" data-grun="' + esc(r.runId) + '">' +
          '<td><code>' + esc(r.runId.slice(0, 16)) + '</code>' + forkBadge + '</td>' +
          '<td><code>' + esc(r.graphId) + '</code></td>' +
          '<td>' + pill(r.status, tone) + '</td>' +
          '<td>' + esc(r.checkpoints.length) + ' nodes · ' + esc(r.totalDurationMs) + 'ms</td>' +
        '</tr>';
      }).join("");

      let activeHtml = '<div class="empty">Run the demo graph on the left to inspect its checkpoint waterfall and try Time-Travel Fork &amp; Replay.</div>';
      if (active) {
        const maxDur = active.checkpoints.reduce((m, c) => Math.max(m, Math.max(1, c.durationMs)), 1);
        const cpHtml = active.checkpoints.map((cp) => {
          const tone = cp.status === "completed" ? "ok" : (cp.status === "interrupted" ? "warn" : "err");
          const pct = Math.max(8, Math.round((Math.max(1, cp.durationMs) / maxDur) * 100));
          return '<div class="wf-row" style="grid-template-columns:190px 1fr 220px">' +
            '<div><strong>#' + cp.stepIndex + ' ' + esc(cp.nodeId) + '</strong><div class="muted" style="font-size:11px">' + pill(cp.preset, "accent") + ' ' + pill(cp.status, tone) + '</div></div>' +
            '<div class="stack" style="gap:4px"><div class="wf-bar-track"><div class="wf-bar ' + tone + '" style="width:' + pct + '%"></div></div><div class="muted" style="font-size:11px">stateAfter: <code>' + esc(JSON.stringify(cp.stateAfter)) + '</code></div></div>' +
            '<div class="row" style="justify-content:flex-end">' +
              '<span class="muted" style="font-size:11px">' + cp.durationMs + 'ms</span>' +
              (!BOOT.readOnly ? '<button class="btn" type="button" data-fork-cp="' + esc(cp.checkpointId) + '">Fork &amp; Replay</button>' : '') +
            '</div>' +
          '</div>';
        }).join("");

        activeHtml =
          '<div class="stack">' +
            '<div class="row" style="justify-content:space-between">' +
              '<div><strong>Run <code>' + esc(active.runId) + '</code></strong>' + (active.parentRunId ? ' ' + pill("Forked from " + active.parentRunId.slice(0, 12), "accent") : '') + '</div>' +
              pill(active.status, active.status === "completed" ? "ok" : (active.status === "interrupted" ? "warn" : "err")) +
            '</div>' +
            (active.interrupt
              ? '<div class="notice"><strong>Paused at <code>' + esc(active.interrupt.nodeId) + '</code>:</strong> ' + esc(active.interrupt.reason) +
                (!BOOT.readOnly ? ' <button class="btn ok" id="graph-resume-btn" type="button" style="margin-left:10px">Approve &amp; Resume</button>' : '') +
                '</div>'
              : '') +
            '<div class="wf-list">' + cpHtml + '</div>' +
            (!BOOT.readOnly
              ? '<label class="field">Time-Travel State Override JSON (applied when clicking Fork &amp; Replay on any checkpoint)<input id="graph-fork-override" value="{&quot;amountUsd&quot;: 5000}" /></label>'
              : '') +
            '<div><h3>Final State</h3><pre>' + esc(JSON.stringify(active.state, null, 2)) + '</pre></div>' +
          '</div>';
      }

      root.innerHTML =
        '<div class="grid-2">' +
          '<div class="card stack">' +
            '<h2>Governed Graph Launcher (<code>sf.graphs</code>)</h2>' +
            '<div class="muted">Runs <code>studio.rebalance.graph</code> with parallel compliance/liquidity fan-out and conditional HITL interrupt (&ge; $10,000). Try running with $25,000, then click <strong>Fork &amp; Replay</strong> on checkpoint #0 with <code>{"amountUsd": 5000}</code> to Time-Travel onto the auto-clear branch!</div>' +
            '<div class="row">' +
              '<label class="field" style="flex:1">Rebalance Amount (USD)<input id="graph-amount" type="number" value="25000" /></label>' +
              '<button class="btn primary" id="graph-run-btn" type="button" style="margin-top:18px"' + (BOOT.readOnly ? " disabled" : "") + '>Run Governed Graph</button>' +
            '</div>' +
            '<h3>Graph Runs (' + runs.length + ')</h3>' +
            (runs.length
              ? '<table><thead><tr><th>Run</th><th>Graph</th><th>Status</th><th>Steps</th></tr></thead><tbody>' + runRows + '</tbody></table>'
              : '<div class="empty">No graph runs yet.</div>') +
          '</div>' +
          '<div class="card stack">' +
            '<h2>Checkpoint Waterfall &amp; Time-Travel</h2>' +
            activeHtml +
          '</div>' +
        '</div>';

      const runBtn = document.getElementById("graph-run-btn");
      if (runBtn) {
        runBtn.onclick = async () => {
          const amountUsd = Number(document.getElementById("graph-amount").value || 25000);
          const out = await api("/graphs/demo", { method: "POST", body: JSON.stringify({ amountUsd }) });
          state.selectedGraphRunId = out.run.runId;
          await loadActiveTab();
        };
      }
      root.querySelectorAll("tr[data-grun]").forEach((tr) => {
        tr.onclick = () => { state.selectedGraphRunId = tr.dataset.grun; renderGraphs(root); };
      });
      const resumeBtn = document.getElementById("graph-resume-btn");
      if (resumeBtn && active) {
        resumeBtn.onclick = async () => {
          await api("/graphs/runs/" + encodeURIComponent(active.runId) + "/resume", {
            method: "POST",
            body: JSON.stringify({ resumeValue: { approved: true } }),
          });
          await loadActiveTab();
        };
      }
      root.querySelectorAll("button[data-fork-cp]").forEach((btn) => {
        btn.onclick = async () => {
          if (!active) return;
          const rawOverride = (document.getElementById("graph-fork-override") || {}).value || "{}";
          const stateOverride = JSON.parse(rawOverride);
          const out = await api("/graphs/runs/" + encodeURIComponent(active.runId) + "/fork", {
            method: "POST",
            body: JSON.stringify({ checkpointId: btn.dataset.forkCp, stateOverride }),
          });
          state.selectedGraphRunId = out.run.runId;
          await loadActiveTab();
        };
      });
    }

    function renderRedTeam(root) {
      const r = state.redteam;
      const cards = r
        ? r.proofs.map((p) =>
            '<div class="card stack" style="border-color:' + (p.passed ? "rgba(46,204,113,0.45)" : "rgba(255,92,114,0.5)") + '">' +
              '<div class="row" style="justify-content:space-between"><strong>' + esc(p.title) + '</strong>' + pill(p.passed ? "BLOCKED / VERIFIED (" + p.durationMs + "ms)" : "FAILED", p.passed ? "ok" : "err") + '</div>' +
              '<div style="font-size:13px"><strong>Simulated Attack:</strong> ' + esc(p.attack) + '</div>' +
              '<div class="muted" style="font-size:13px"><strong>sfield Defense:</strong> ' + esc(p.defense) + '</div>' +
              '<pre>' + esc(JSON.stringify(p.evidence, null, 2)) + '</pre>' +
            '</div>'
          ).join("")
        : '<div class="empty">Click <strong>Run 5 Live Security Proofs</strong> above to execute real adversarial tests against <code>@sfield/core</code>.</div>';

      root.innerHTML =
        '<div class="card stack">' +
          '<div class="row" style="justify-content:space-between">' +
            '<div><h2>1-Click Zero-Trust Governance &amp; Red-Team Proof Suite</h2><div class="muted">Executes 5 live adversarial attacks against an isolated <code>@sfield/core</code> kernel: prompt-injected write, tampered HMAC UI action, cross-tenant replay, PII egress leak, and unapproved write HITL gating.</div></div>' +
            '<button class="btn primary" id="redteam-run-btn" type="button">Run 5 Live Security Proofs</button>' +
          '</div>' +
          (r ? '<div class="notice ' + (r.allPassed ? "ok" : "err") + '"><strong>Result: ' + r.passed + ' / ' + r.total + ' proofs passed</strong> · Executed at ' + esc(r.ranAt) + '</div>' : '') +
        '</div>' +
        '<div class="stack">' + cards + '</div>';

      document.getElementById("redteam-run-btn").onclick = async () => {
        const btn = document.getElementById("redteam-run-btn");
        btn.disabled = true;
        btn.textContent = "Running attacks…";
        try {
          state.redteam = await api("/redteam/run", { method: "POST", body: "{}" });
          renderRedTeam(root);
        } catch (e) {
          root.innerHTML = '<div class="notice err">' + esc(e.message) + '</div>';
        }
      };
    }

    function renderCommands(root) {
      const c = state.commands || { tenantId: state.commandTenant || "pzn-local", commands: [], hasOverride: false };
      const rows = (c.commands || []).map((cmd) =>
        '<tr>' +
          '<td><code>' + esc(cmd.command) + '</code></td>' +
          '<td><strong>' + esc(cmd.label) + '</strong><div class="muted" style="font-size:12px">' + esc(cmd.hint || "") + '</div></td>' +
          '<td>' + pill(cmd.action, "accent") + (cmd.domain ? " " + pill(cmd.domain) : "") + '</td>' +
          '<td>' + pill(cmd.enabled === false ? "disabled" : "active", cmd.enabled === false ? "err" : "ok") + '</td>' +
          '<td>' + (!BOOT.readOnly ? '<button class="btn err" type="button" data-del-cmd="' + esc(cmd.command) + '">Remove</button>' : '') + '</td>' +
        '</tr>'
      ).join("");

      root.innerHTML =
        '<div class="card stack">' +
          '<div class="row" style="justify-content:space-between"><div><h2>Tenant Slash Command Registry (<code>sf.commands</code>)</h2><div class="muted">Configure the <code>/</code> commands surfaced in chat for each tenant and optional domain.</div></div>' +
          '<div class="row"><input id="cmd-tenant" value="' + esc(c.tenantId) + '" style="width:160px" placeholder="tenantId" /><button class="btn" id="cmd-load-btn" type="button">Load Tenant</button></div></div>' +
          (!BOOT.readOnly
            ? '<div class="grid-2">' +
                '<label class="field">Command (starts with /)<input id="cmd-trigger" placeholder="/triage" /></label>' +
                '<label class="field">Label<input id="cmd-label" placeholder="Incident Triage" /></label>' +
                '<label class="field">Hint<input id="cmd-hint" placeholder="Summarize active P1 alerts" /></label>' +
                '<label class="field">Domain (optional)<input id="cmd-domain" placeholder="wealth / it_ops / sales_revops" /></label>' +
              '</div>' +
              '<label class="field">Prompt (for action=prompt)<input id="cmd-prompt" placeholder="Show active P1 incidents and rollback status." /></label>' +
              '<div class="row"><button class="btn primary" id="cmd-save-btn" type="button">Save Command for Tenant</button></div>'
            : '') +
        '</div>' +
        '<div class="card stack">' +
          '<h2>Effective Commands for <code>' + esc(c.tenantId) + '</code> (' + (c.commands ? c.commands.length : 0) + ')</h2>' +
          (c.commands && c.commands.length
            ? '<table><thead><tr><th>Command</th><th>Label &amp; Hint</th><th>Action / Domain</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
            : '<div class="empty">No slash commands configured for this tenant.</div>') +
        '</div>';

      document.getElementById("cmd-load-btn").onclick = async () => {
        state.commandTenant = document.getElementById("cmd-tenant").value.trim() || "pzn-local";
        await loadActiveTab();
      };
      const saveBtn = document.getElementById("cmd-save-btn");
      if (saveBtn) {
        saveBtn.onclick = async () => {
          const tenantId = document.getElementById("cmd-tenant").value.trim() || "pzn-local";
          state.commandTenant = tenantId;
          await api("/commands", {
            method: "POST",
            body: JSON.stringify({
              tenantId,
              command: document.getElementById("cmd-trigger").value.trim(),
              label: document.getElementById("cmd-label").value.trim(),
              hint: document.getElementById("cmd-hint").value.trim(),
              domain: document.getElementById("cmd-domain").value.trim() || undefined,
              action: "prompt",
              prompt: document.getElementById("cmd-prompt").value.trim(),
            }),
          });
          await loadActiveTab();
        };
      }
      root.querySelectorAll("button[data-del-cmd]").forEach((btn) => {
        btn.onclick = async () => {
          const tenantId = document.getElementById("cmd-tenant").value.trim() || "pzn-local";
          await api("/commands/" + encodeURIComponent(btn.dataset.delCmd) + "?tenantId=" + encodeURIComponent(tenantId), { method: "DELETE" });
          await loadActiveTab();
        };
      });
    }

    function renderPlugin(root, plugin) {
      if (!plugin) { root.innerHTML = '<div class="empty">Plugin not found.</div>'; return; }
      root.innerHTML =
        '<div class="card stack">' +
          '<div class="row" style="justify-content:space-between"><div><h2>' + esc(plugin.label) + '</h2>' + (plugin.description ? '<div class="muted">' + esc(plugin.description) + '</div>' : '') + '</div>' +
          (plugin.href ? '<a class="btn primary" href="' + esc(plugin.href) + '">Open Full Screen</a>' : '') + '</div>' +
          (plugin.iframeSrc ? '<iframe class="plugin-frame" src="' + esc(plugin.iframeSrc) + '" title="' + esc(plugin.label) + '"></iframe>' : '') +
        '</div>';
    }

    document.getElementById("refresh-btn").onclick = () => void loadActiveTab();
    renderNav();
    void loadActiveTab();
  </script>
</body>
</html>`;
}
