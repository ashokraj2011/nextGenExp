/**
 * CEP Embeddable Client SDK (@cep/embed) + Third-Party Host Portal Simulator.
 *
 * Served directly by the CEP app server:
 *   - GET /sdk/cep-embed.js  -> Zero-dependency Web Component (<cep-assistant>) + window.CEPEmbed.mount(...)
 *                               with DOM-Aware Ambient Context (MutationObserver on [data-cep-context])
 *   - GET /embed-demo        -> Standalone Host Portal (default: Meridian Private Wealth, or any ?vertical=<packId>)
 */
import type { VerticalPackRecord, VerticalScreenContext } from "../../packages/contracts/vertical-pack";
import { accountPortalPath } from "../../packages/contracts/workspace";

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

const DEFAULT_MERIDIAN_SCREEN_VIEWS: VerticalScreenContext[] = [
  {
    id: "portfolio-overview",
    label: "Portfolio Overview · $50,000",
    viewType: "portfolio_dashboard",
    summary: "Viewing client brokerage dashboard: $35,738 cash, $14,262 equities, AAPL concentration at 42%.",
    metrics: [
      { label: "Total Value", value: "$50,000" },
      { label: "Cash", value: "$35,738" },
      { label: "Top Holding", value: "AAPL (42%)" },
    ],
    suggestedActions: [
      { label: "Sell 40% AAPL + Tax-Loss Harvest", prompt: "I want to sell 40% of my Apple shares" },
      { label: "Review Allocation", prompt: "Let me know my portfolio summary." },
    ],
    dataAttributes: { view: "portfolio_dashboard", accountId: "acct-meridian-8821" },
  },
  {
    id: "wire-invoice-441",
    label: "Wire Invoice #INV-441 ($18,500)",
    viewType: "pending_wire_invoice",
    summary: "Viewing pending outbound wire invoice #INV-441 for $18,500 to Apex Title Co — exceeds $10,000 dual-control HITL threshold.",
    metrics: [
      { label: "Wire Amount", value: "$18,500" },
      { label: "Beneficiary", value: "Apex Title Co" },
      { label: "Policy Gate", value: ">$10k HITL" },
    ],
    suggestedActions: [
      { label: "Launch Governed Wire Workflow", prompt: "I want to initiate a wire transfer" },
      { label: "Check Wire Policy & Limits", prompt: "What are the wire transfer approval limits and security rules?" },
    ],
    dataAttributes: { view: "pending_wire_invoice", invoiceId: "INV-441", amountUsd: 18500 },
  },
  {
    id: "tax-loss-lot",
    label: "Tax Center · INTC Loss Lot (-$1,420)",
    viewType: "tax_lot_detail",
    summary: "Viewing short-term unrealized loss lot in INTC (-$1,420) eligible for tax-loss harvesting with wash-sale window clear.",
    metrics: [
      { label: "Unrealized P/L", value: "-$1,420" },
      { label: "Position", value: "85 sh INTC" },
      { label: "Wash-Sale", value: "Clear (30d)" },
    ],
    suggestedActions: [
      { label: "Inspect Equity Holdings", prompt: "whats in my equity book right now?" },
      { label: "Explain Wash-Sale Policy", prompt: "What is our policy on tax-loss harvesting and wash-sale rules?" },
    ],
    dataAttributes: { view: "tax_lot_detail", symbol: "INTC", lossUsd: 1420 },
  },
];

export function renderCepEmbedSdkScript(defaultBaseUrl: string): string {
  const safeBase = JSON.stringify(defaultBaseUrl);
  return `/* @cep/embed v1.0.0 — Zero-Dependency Embeddable Customer Engagement Platform SDK */
(function (global) {
  "use strict";
  var PROTOCOL = "cep:v1";
  var DEFAULT_BASE = (function () {
    try {
      var cur = document.currentScript;
      if (cur && cur.src) return new URL(cur.src, location.href).origin;
    } catch (_) {}
    return ${safeBase};
  })();

  function sanitizeColor(color) {
    if (!color) return "#2f7d22";
    var trimmed = String(color).trim();
    return /^#[0-9a-fA-F]{3,8}$/.test(trimmed) ? trimmed : "#2f7d22";
  }

  function buildEmbedUrl(opts) {
    var base = (opts.baseUrl || DEFAULT_BASE).replace(/\\/+$/, "");
    var params = new URLSearchParams();
    if (opts.personaId) params.set("personaId", opts.personaId);
    if (opts.domain) params.set("domain", opts.domain);
    if (opts.theme) params.set("theme", opts.theme);
    if (opts.brand) params.set("brand", opts.brand);
    if (opts.accent) params.set("accent", sanitizeColor(opts.accent));
    if (opts.prompt) params.set("prompt", opts.prompt);
    params.set("mode", opts.mode || "launcher");
    return base + "/embed?" + params.toString();
  }

  class CepAssistantElement extends HTMLElement {
    static get observedAttributes() {
      return ["mode", "persona-id", "domain", "theme", "brand", "accent", "position", "open", "height", "base-url", "prompt"];
    }

    constructor() {
      super();
      this._shadow = this.attachShadow({ mode: "open" });
      this._iframe = null;
      this._open = false;
      this._ready = false;
      this._queue = [];
      this._listeners = new Set();
      this._domObserver = null;
      this._lastContextSig = "";
      this._latestContext = null;
      this._onWindowMessage = this._handleWindowMessage.bind(this);
    }

    connectedCallback() {
      this._open = this.hasAttribute("open") && this.getAttribute("open") !== "false";
      window.addEventListener("message", this._onWindowMessage);
      this._render();
      this._startDomContextObserver();
    }

    disconnectedCallback() {
      window.removeEventListener("message", this._onWindowMessage);
      if (this._domObserver) {
        this._domObserver.disconnect();
        this._domObserver = null;
      }
    }

    attributeChangedCallback(name, oldValue, newValue) {
      if (oldValue === newValue || !this.isConnected) return;
      if (name === "theme" && newValue) {
        this.setTheme(newValue);
        return;
      }
      if (name === "domain" && newValue) {
        this.setDomain(newValue);
        return;
      }
      if (name === "brand" || name === "accent") {
        this.setBrand(this.getAttribute("brand") || "CEP Assistant", this.getAttribute("accent") || "#2f7d22");
        return;
      }
      if (name === "open") {
        this._open = newValue !== null && newValue !== "false";
        this._syncDrawerState();
        return;
      }
      this._render();
    }

    _config() {
      return {
        baseUrl: this.getAttribute("base-url") || DEFAULT_BASE,
        mode: this.getAttribute("mode") || "launcher",
        personaId: this.getAttribute("persona-id") || "demo-learner",
        domain: this.getAttribute("domain") || "wealth",
        theme: this.getAttribute("theme") || "light",
        brand: this.getAttribute("brand") || "CEP Assistant",
        accent: sanitizeColor(this.getAttribute("accent") || "#2f7d22"),
        position: this.getAttribute("position") || "bottom-right",
        height: this.getAttribute("height") || "660px",
        prompt: this.getAttribute("prompt") || "",
      };
    }

    _post(type, payload) {
      var msg = { protocol: PROTOCOL, type: type, payload: payload || {} };
      if (!this._iframe || !this._iframe.contentWindow || !this._ready) {
        this._queue.push(msg);
        return;
      }
      this._iframe.contentWindow.postMessage(msg, "*");
    }

    _flushQueue() {
      if (!this._iframe || !this._iframe.contentWindow || !this._ready) return;
      var sentContext = false;
      while (this._queue.length > 0) {
        var next = this._queue.shift();
        if (next && next.type === "cep:screen_context") sentContext = true;
        this._iframe.contentWindow.postMessage(next, "*");
      }
      if (!sentContext && this._latestContext) {
        this._iframe.contentWindow.postMessage({ protocol: PROTOCOL, type: "cep:screen_context", payload: this._latestContext }, "*");
      }
    }

    _readDomContext() {
      var target = document.querySelector('[data-cep-context][data-cep-active="true"]') || document.querySelector("[data-cep-context]");
      if (!target) return null;
      var raw = target.getAttribute("data-cep-context");
      if (!raw) return null;
      try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && typeof parsed.label === "string") return parsed;
      } catch (_) {
        return {
          id: target.id || "dom-context",
          label: raw.slice(0, 72),
          viewType: target.getAttribute("data-cep-view") || "host_view",
          summary: target.getAttribute("data-cep-summary") || ("Viewing " + raw.slice(0, 120)),
        };
      }
      return null;
    }

    _scanDomContext() {
      var ctx = this._readDomContext();
      if (!ctx) return;
      var sig = JSON.stringify(ctx);
      if (sig === this._lastContextSig) return;
      this._lastContextSig = sig;
      this.setScreenContext(ctx);
    }

    _startDomContextObserver() {
      if (this._domObserver || typeof MutationObserver === "undefined" || !document.body) return;
      this._domObserver = new MutationObserver(() => {
        this._scanDomContext();
      });
      this._domObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ["data-cep-context", "data-cep-active"],
        childList: true,
        subtree: true,
      });
      this._scanDomContext();
    }

    _handleWindowMessage(event) {
      var data = event.data;
      if (!data || data.protocol !== PROTOCOL || typeof data.type !== "string") return;
      if (this._iframe && event.source !== this._iframe.contentWindow) return;
      if (data.type === "cep:ready") {
        this._ready = true;
        this._flushQueue();
      }
      this.dispatchEvent(new CustomEvent(data.type, { detail: data.payload, bubbles: true, composed: true }));
      this.dispatchEvent(new CustomEvent("cep:event", { detail: data, bubbles: true, composed: true }));
      this._listeners.forEach(function (fn) {
        try { fn(data); } catch (_) {}
      });
    }

    _syncDrawerState() {
      var panel = this._shadow.querySelector(".cep-drawer");
      var fab = this._shadow.querySelector(".cep-fab");
      if (panel) panel.classList.toggle("is-open", this._open);
      if (fab) {
        fab.setAttribute("aria-expanded", String(this._open));
        fab.classList.toggle("is-open", this._open);
      }
    }

    open() {
      this._open = true;
      this._syncDrawerState();
      this.dispatchEvent(new CustomEvent("cep:open", { bubbles: true, composed: true }));
    }

    close() {
      this._open = false;
      this._syncDrawerState();
      this.dispatchEvent(new CustomEvent("cep:close", { bubbles: true, composed: true }));
    }

    toggle() {
      if (this._open) this.close();
      else this.open();
    }

    sendPrompt(prompt) {
      if (!prompt || !String(prompt).trim()) return;
      if (this._config().mode !== "inline") this.open();
      this._post("cep:send_prompt", { prompt: String(prompt).trim() });
    }

    setTheme(theme) {
      var normalized = theme === "dark" ? "dark" : "light";
      this._post("cep:set_theme", { theme: normalized });
      var host = this._shadow.querySelector(".cep-shell");
      if (host) host.setAttribute("data-theme", normalized);
    }

    setDomain(domain) {
      this._post("cep:set_domain", { domain: domain });
    }

    setBrand(brand, accent) {
      var color = sanitizeColor(accent || this.getAttribute("accent") || "#2f7d22");
      var shell = this._shadow.querySelector(".cep-shell");
      if (shell) shell.style.setProperty("--cep-accent", color);
      var label = this._shadow.querySelector(".cep-fab-label");
      if (label && brand) label.textContent = brand;
      this._post("cep:set_brand", { brand: brand, accent: color });
    }

    setPersona(personaId) {
      this._post("cep:set_persona", { personaId: personaId });
    }

    setScreenContext(context) {
      if (!context || typeof context !== "object") return;
      this._latestContext = context;
      this._lastContextSig = JSON.stringify(context);
      this._post("cep:screen_context", context);
      this.dispatchEvent(new CustomEvent("cep:screen_context_sent", { detail: context, bubbles: true, composed: true }));
    }

    onEvent(listener) {
      this._listeners.add(listener);
      return () => this._listeners.delete(listener);
    }

    _render() {
      var cfg = this._config();
      var src = buildEmbedUrl(cfg);
      this._ready = false;
      var isInline = cfg.mode === "inline";
      var isSidebar = cfg.mode === "sidebar";
      var alignLeft = cfg.position === "bottom-left";

      var css = \`
        :host { display: block; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .cep-shell { --cep-accent: \${cfg.accent}; }
        .cep-inline-frame-wrap {
          width: 100%;
          height: \${cfg.height};
          min-height: 460px;
          border-radius: 16px;
          overflow: hidden;
          border: 1px solid rgba(15, 23, 42, 0.12);
          background: #ffffff;
          box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
          display: flex;
          flex-direction: column;
        }
        .cep-shell[data-theme="dark"] .cep-inline-frame-wrap,
        .cep-shell[data-theme="dark"] .cep-drawer {
          background: #0f1311;
          border-color: rgba(255, 255, 255, 0.14);
        }
        iframe {
          width: 100%;
          height: 100%;
          border: 0;
          flex: 1;
          background: transparent;
        }
        .cep-fab {
          position: fixed;
          bottom: 22px;
          \${alignLeft ? "left: 22px;" : "right: 22px;"}
          z-index: 2147483000;
          display: inline-flex;
          align-items: center;
          gap: 10px;
          height: 52px;
          padding: 0 20px 0 16px;
          border: 0;
          border-radius: 999px;
          background: var(--cep-accent);
          color: #ffffff;
          font: 600 14px/1 Inter, -apple-system, sans-serif;
          cursor: pointer;
          box-shadow: 0 12px 28px rgba(15, 23, 42, 0.25);
          transition: transform 0.16s ease, box-shadow 0.16s ease, opacity 0.16s ease;
        }
        .cep-fab:hover { transform: translateY(-2px); box-shadow: 0 16px 34px rgba(15, 23, 42, 0.32); }
        .cep-fab-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: #86efac;
          box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.24);
        }
        .cep-drawer {
          position: fixed;
          z-index: 2147483001;
          background: #ffffff;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          box-shadow: 0 24px 64px rgba(15, 23, 42, 0.28);
          border: 1px solid rgba(15, 23, 42, 0.12);
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.18s ease, transform 0.2s ease;
          \${isSidebar
            ? "top: 0; bottom: 0; right: 0; width: min(460px, 96vw); border-radius: 0; transform: translateX(24px);"
            : \`bottom: 86px; \${alignLeft ? "left: 22px;" : "right: 22px;"} width: min(440px, calc(100vw - 32px)); height: min(680px, calc(100vh - 116px)); border-radius: 18px; transform: translateY(16px) scale(0.98);\`}
        }
        .cep-drawer.is-open {
          opacity: 1;
          pointer-events: auto;
          transform: translate(0, 0) scale(1);
        }
        .cep-drawer-close {
          position: absolute;
          top: 10px;
          right: 10px;
          z-index: 4;
          width: 30px;
          height: 30px;
          border-radius: 999px;
          border: 1px solid rgba(15, 23, 42, 0.14);
          background: rgba(255, 255, 255, 0.92);
          color: #0f172a;
          font-size: 16px;
          line-height: 1;
          cursor: pointer;
          display: grid;
          place-items: center;
        }
        .cep-shell[data-theme="dark"] .cep-drawer-close {
          background: rgba(22, 28, 24, 0.92);
          color: #eef3ef;
          border-color: rgba(255, 255, 255, 0.16);
        }
      \`;

      if (isInline) {
        this._shadow.innerHTML = \`
          <style>\${css}</style>
          <div class="cep-shell" data-theme="\${cfg.theme}">
            <div class="cep-inline-frame-wrap">
              <iframe title="\${cfg.brand}" allow="microphone; clipboard-write" src="\${src}"></iframe>
            </div>
          </div>
        \`;
      } else {
        this._shadow.innerHTML = \`
          <style>\${css}</style>
          <div class="cep-shell" data-theme="\${cfg.theme}">
            <div class="cep-drawer \${this._open ? "is-open" : ""}" role="dialog" aria-label="\${cfg.brand}">
              <button type="button" class="cep-drawer-close" aria-label="Close assistant">&times;</button>
              <iframe title="\${cfg.brand}" allow="microphone; clipboard-write" src="\${src}"></iframe>
            </div>
            <button type="button" class="cep-fab \${this._open ? "is-open" : ""}" aria-expanded="\${String(this._open)}">
              <span class="cep-fab-dot" aria-hidden="true"></span>
              <span class="cep-fab-label">\${cfg.brand}</span>
            </button>
          </div>
        \`;
        var fab = this._shadow.querySelector(".cep-fab");
        var closeBtn = this._shadow.querySelector(".cep-drawer-close");
        if (fab) fab.addEventListener("click", () => this.toggle());
        if (closeBtn) closeBtn.addEventListener("click", () => this.close());
      }
      this._iframe = this._shadow.querySelector("iframe");
    }
  }

  if (!customElements.get("cep-assistant")) {
    customElements.define("cep-assistant", CepAssistantElement);
  }

  global.CEPEmbed = {
    version: "1.0.0",
    protocol: PROTOCOL,
    mount: function mount(target, options) {
      var opts = options || {};
      var container = typeof target === "string" ? document.querySelector(target) : (target || document.body);
      if (!container) throw new Error("CEPEmbed.mount: target container not found.");
      var el = document.createElement("cep-assistant");
      if (opts.baseUrl) el.setAttribute("base-url", opts.baseUrl);
      if (opts.mode) el.setAttribute("mode", opts.mode);
      if (opts.personaId) el.setAttribute("persona-id", opts.personaId);
      if (opts.domain) el.setAttribute("domain", opts.domain);
      if (opts.theme) el.setAttribute("theme", opts.theme);
      if (opts.brand) el.setAttribute("brand", opts.brand);
      if (opts.accent) el.setAttribute("accent", opts.accent);
      if (opts.position) el.setAttribute("position", opts.position);
      if (opts.height) el.setAttribute("height", opts.height);
      if (opts.prompt) el.setAttribute("prompt", opts.prompt);
      if (opts.open) el.setAttribute("open", "true");
      if (typeof opts.onEvent === "function") el.onEvent(opts.onEvent);
      container.appendChild(el);
      return {
        element: el,
        open: function () { el.open(); },
        close: function () { el.close(); },
        toggle: function () { el.toggle(); },
        sendPrompt: function (prompt) { el.sendPrompt(prompt); },
        setTheme: function (theme) { el.setTheme(theme); },
        setDomain: function (domain) { el.setDomain(domain); },
        setBrand: function (brand, accent) { el.setBrand(brand, accent); },
        setPersona: function (personaId) { el.setPersona(personaId); },
        setScreenContext: function (context) { el.setScreenContext(context); },
        destroy: function () { el.remove(); },
      };
    },
  };
})(window);
`;
}

export function renderHostPortalDemoHtml(
  baseOrigin: string,
  query: URLSearchParams,
  verticalPack?: VerticalPackRecord,
): string {
  const initialMode = query.get("mode") === "launcher" || query.get("mode") === "sidebar" ? query.get("mode")! : "inline";
  const defaultDomain = verticalPack?.domain ?? "wealth";
  const initialDomain = query.get("domain") === "it_ops" || query.get("domain") === "sales_revops" || query.get("domain") === "wealth"
    ? query.get("domain")!
    : defaultDomain;
  const initialTheme = query.get("theme") === "dark" ? "dark" : "light";
  const initialBrand = (query.get("brand") || verticalPack?.brandTitle || "Meridian AI Concierge").slice(0, 60).replace(/[<>"]/g, "");
  const rawAccent = query.get("accent") || verticalPack?.accentColor || "#1d4ed8";
  const initialAccent = /^#[0-9a-fA-F]{3,8}$/.test(rawAccent) ? rawAccent : "#1d4ed8";
  const initialPersona = query.get("personaId") || "demo-learner";
  const portalName = verticalPack?.portalName || "Meridian Private Wealth Portal";
  const portalSubtitle = verticalPack?.portalSubtitle || "External Client Banking App · Real-time Host ↔ CEP Bridge";
  const logoLetter = portalName.trim().charAt(0).toUpperCase() || "M";
  const screenViews: VerticalScreenContext[] = verticalPack?.screenViews?.length
    ? verticalPack.screenViews
    : DEFAULT_MERIDIAN_SCREEN_VIEWS;
  const initialScreen = screenViews[0]!;
  const isCustomVertical = Boolean(verticalPack);

  const actionButtonsHtml = isCustomVertical && verticalPack
    ? [
        ...verticalPack.quickPrompts.map((qp) =>
          `<button type="button" class="action-trigger" data-prompt="${escapeHtml(qp.prompt)}" data-domain="${escapeHtml(verticalPack.domain)}">`
          + `<span>${escapeHtml(qp.label)}</span><small>vertical action</small></button>`),
        `<button type="button" class="action-trigger" data-prompt="${escapeHtml(verticalPack.workflowTriggerPhrase)}" data-domain="${escapeHtml(verticalPack.domain)}" style="border-color:${escapeHtml(initialAccent)};">`
        + `<span>Run ${escapeHtml(verticalPack.workflowName)}</span><small>workflow DAG</small></button>`,
      ].join("\n          ")
    : `<button type="button" class="action-trigger" data-prompt="I want to sell 40% of my Apple shares" data-domain="wealth">
            <span>Sell 40% AAPL + Tax-Loss Harvest</span><small>postMessage</small>
          </button>
          <button type="button" class="action-trigger" data-prompt="I want to initiate a wire transfer" data-domain="wealth">
            <span>Run Governed Wire Workflow (5-Step)</span><small>workflow DAG</small>
          </button>
          <button type="button" class="action-trigger" data-prompt="whats in my equity book right now?" data-domain="wealth">
            <span>Inspect Live Stock Holdings</span><small>postMessage</small>
          </button>
          <button type="button" class="action-trigger" data-prompt="Let me know my portfolio summary." data-domain="wealth">
            <span>Review Portfolio Allocation</span><small>postMessage</small>
          </button>
          <button type="button" class="action-trigger" data-prompt="Build an IT incident triage dashboard for our active P1 alert" data-domain="it_ops">
            <span>Switch Domain &rarr; IT Ops P1 Triage</span><small>setDomain + prompt</small>
          </button>
          <button type="button" class="action-trigger" data-prompt="Show the enterprise discount approval card for Acme Cloud Corp" data-domain="sales_revops">
            <span>Switch Domain &rarr; Sales Deal Desk</span><small>setDomain + prompt</small>
          </button>
          <button type="button" class="action-trigger" id="fire-proactive-btn" style="border-color:#d97706;">
            <span>Fire Live Proactive Event (AAPL +8.4%)</span><small>SSE push</small>
          </button>`;

  const screenTabsHtml = screenViews
    .map((view, idx) =>
      `<button type="button" class="screen-tab-btn${idx === 0 ? " is-active" : ""}" data-screen-idx="${idx}">${escapeHtml(view.label)}</button>`)
    .join("\n          ");

  const initialMetricsHtml = initialScreen.metrics
    .map((m) => `<div class="bal-box"><span>${escapeHtml(m.label)}</span><strong>${escapeHtml(m.value)}</strong></div>`)
    .join("");

  return `<!doctype html>
<html lang="en" data-host-theme="${initialTheme}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(portalName)} · CEP Embed SDK Host Portal</title>
  <style>
    :root {
      --bg: #f1f5f9;
      --surface: #ffffff;
      --surface-alt: #f8fafc;
      --ink: #0f172a;
      --muted: #475569;
      --line: #dbe3ee;
      --accent: ${initialAccent};
      --badge-bg: #dbeafe;
      --badge-ink: #1e40af;
    }
    html[data-host-theme="dark"] {
      --bg: #0b1120;
      --surface: #111827;
      --surface-alt: #1e293b;
      --ink: #f1f5f9;
      --muted: #94a3b8;
      --line: #273449;
      --badge-bg: #1e3a8a;
      --badge-ink: #bfdbfe;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      min-height: 100vh;
    }
    .host-banner {
      background: linear-gradient(90deg, #0f172a 0%, #1e293b 100%);
      color: #e2e8f0;
      padding: 8px 24px;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .host-banner strong { color: #ffffff; }
    .host-banner a { color: #93c5fd; text-decoration: none; font-weight: 600; }
    .host-banner a:hover { text-decoration: underline; }
    .vertical-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 9px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.12);
      color: #e0f2fe;
      font-size: 11px;
      font-weight: 600;
      margin-left: 8px;
    }
    .portal-nav {
      background: var(--surface);
      border-bottom: 1px solid var(--line);
      padding: 14px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    .portal-brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .portal-logo {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      background: var(--accent);
      color: #fff;
      font-weight: 800;
      font-size: 16px;
      display: grid;
      place-items: center;
    }
    .portal-brand h1 { margin: 0; font-size: 16px; letter-spacing: -0.02em; }
    .portal-brand small { color: var(--muted); font-size: 12px; display: block; }
    .portal-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .ctrl-btn {
      border: 1px solid var(--line);
      background: var(--surface-alt);
      color: var(--ink);
      border-radius: 999px;
      padding: 7px 13px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .ctrl-btn:hover { border-color: var(--accent); }
    .ctrl-btn.is-active { background: var(--accent); color: #fff; border-color: var(--accent); }
    .swatch {
      width: 22px;
      height: 22px;
      border-radius: 999px;
      border: 2px solid var(--surface);
      box-shadow: 0 0 0 1px var(--line);
      cursor: pointer;
    }
    .portal-grid {
      max-width: 1400px;
      margin: 0 auto;
      padding: 20px 24px 36px;
      display: grid;
      grid-template-columns: minmax(340px, 430px) minmax(0, 1fr);
      gap: 20px;
      align-items: start;
    }
    @media (max-width: 980px) {
      .portal-grid { grid-template-columns: 1fr; }
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 18px;
      margin-bottom: 16px;
    }
    .card h2 {
      margin: 0 0 4px;
      font-size: 14px;
      letter-spacing: -0.01em;
    }
    .card p.sub {
      margin: 0 0 12px;
      font-size: 12px;
      color: var(--muted);
    }
    .screen-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 12px;
    }
    .screen-tab-btn {
      border: 1px solid var(--line);
      background: var(--surface-alt);
      color: var(--ink);
      border-radius: 9px;
      padding: 6px 10px;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      transition: border-color 0.15s ease, background 0.15s ease;
    }
    .screen-tab-btn:hover { border-color: var(--accent); }
    .screen-tab-btn.is-active {
      background: var(--accent);
      border-color: var(--accent);
      color: #ffffff;
    }
    .active-screen-box {
      padding: 12px;
      border-radius: 12px;
      background: var(--surface-alt);
      border: 1px dashed var(--accent);
    }
    .active-screen-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
    }
    .active-screen-head strong { font-size: 13px; }
    .dom-tag-pill {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10px;
      padding: 2px 7px;
      border-radius: 999px;
      background: var(--badge-bg);
      color: var(--badge-ink);
      font-weight: 700;
    }
    .active-screen-summary {
      margin: 0 0 10px;
      font-size: 12px;
      color: var(--muted);
      line-height: 1.45;
    }
    .balance-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }
    .bal-box {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px 10px;
      transition: transform 0.2s ease, border-color 0.2s ease;
    }
    .bal-box.pulse {
      border-color: #16a34a;
      transform: scale(1.03);
    }
    .bal-box span { display: block; font-size: 10.5px; color: var(--muted); margin-bottom: 3px; }
    .bal-box strong { font-size: 13.5px; font-variant-numeric: tabular-nums; }
    .sync-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 10px;
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--badge-bg);
      color: var(--badge-ink);
      font-size: 11px;
      font-weight: 600;
    }
    .action-stack {
      display: grid;
      gap: 8px;
    }
    .action-trigger {
      text-align: left;
      padding: 10px 12px;
      border-radius: 11px;
      border: 1px solid var(--line);
      background: var(--surface-alt);
      color: var(--ink);
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .action-trigger:hover { border-color: var(--accent); }
    .action-trigger small { font-weight: 500; color: var(--muted); font-size: 11px; }
    .event-log {
      max-height: 220px;
      overflow-y: auto;
      display: grid;
      gap: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
    }
    .event-row {
      padding: 7px 9px;
      border-radius: 8px;
      background: var(--surface-alt);
      border: 1px solid var(--line);
      word-break: break-word;
    }
    .event-dir {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 700;
      margin-right: 6px;
      font-size: 10px;
    }
    .event-dir.in { background: #dcfce7; color: #166534; }
    .event-dir.out { background: #dbeafe; color: #1e40af; }
    .embed-stage-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
      gap: 10px;
      flex-wrap: wrap;
    }
    .embed-stage-header code {
      background: var(--surface-alt);
      border: 1px solid var(--line);
      padding: 4px 8px;
      border-radius: 8px;
      font-size: 11px;
    }
    .launcher-placeholder {
      border: 2px dashed var(--line);
      border-radius: 16px;
      padding: 56px 24px;
      text-align: center;
      color: var(--muted);
      background: var(--surface);
    }
  </style>
</head>
<body>
  <div class="host-banner">
    <div>
      <strong>${isCustomVertical && verticalPack ? `Generated Vertical Pack · ${escapeHtml(verticalPack.industry)}` : "Simulated Third-Party Host Portal"}</strong>
      — <code>&lt;cep-assistant&gt;</code> Shadow DOM + <code>MutationObserver([data-cep-context])</code>
      ${verticalPack ? `<span class="vertical-pill">Policy RAG: ${escapeHtml(verticalPack.policyTitle)} · DAG: ${escapeHtml(verticalPack.workflowName)}</span>` : ""}
    </div>
    <div style="display:flex;gap:14px;">
      <a href="/admin/embed">&larr; Back to Admin Embed Studio</a>
      <a href="/chat">Open Full CEP App</a>
      ${initialDomain === "wealth" ? `<a href="${accountPortalPath}">Open account funding</a>` : ""}
    </div>
  </div>

  <header class="portal-nav">
    <div class="portal-brand">
      <div class="portal-logo" id="portal-logo">${escapeHtml(logoLetter)}</div>
      <div>
        <h1>${escapeHtml(portalName)}</h1>
        <small>${escapeHtml(portalSubtitle)}</small>
      </div>
    </div>
    <div class="portal-controls">
      <button type="button" class="ctrl-btn ${initialMode === "inline" ? "is-active" : ""}" id="mode-inline">Inline Co-Pilot</button>
      <button type="button" class="ctrl-btn ${initialMode === "launcher" ? "is-active" : ""}" id="mode-launcher">Floating Launcher</button>
      <button type="button" class="ctrl-btn ${initialMode === "sidebar" ? "is-active" : ""}" id="mode-sidebar">Slide-Over Sidebar</button>
      <button type="button" class="ctrl-btn" id="toggle-theme">${initialTheme === "dark" ? "Light Mode" : "Dark Mode"}</button>
      <button type="button" class="swatch" style="background:#1d4ed8" data-brand="Meridian AI Concierge" data-accent="#1d4ed8" title="Meridian Navy"></button>
      <button type="button" class="swatch" style="background:#0f766e" data-brand="Apex Private Desk" data-accent="#0f766e" title="Private Emerald"></button>
      <button type="button" class="swatch" style="background:#6d28d9" data-brand="Vanguardian Wealth" data-accent="#6d28d9" title="Royal Plum"></button>
      <button type="button" class="swatch" style="background:#2f7d22" data-brand="CEP Assistant" data-accent="#2f7d22" title="CEP Green"></button>
    </div>
  </header>

  <main class="portal-grid">
    <section>
      <div class="card">
        <h2>Host Screen Views (DOM-Aware Ambient Co-Pilot)</h2>
        <p class="sub">Switch tabs below — <code>@cep/embed</code> watches <code>[data-cep-context]</code> via <code>MutationObserver</code> and streams live screen context into the co-pilot automatically.</p>
        <div class="screen-tabs" id="screen-tabs">
          ${screenTabsHtml}
        </div>
        <div
          id="host-active-screen"
          class="active-screen-box"
          data-cep-active="true"
          data-cep-context="${escapeHtml(JSON.stringify(initialScreen))}"
        >
          <div class="active-screen-head">
            <strong id="screen-title">${escapeHtml(initialScreen.label)}</strong>
            <span class="dom-tag-pill">[data-cep-context] live</span>
          </div>
          <p class="active-screen-summary" id="screen-summary">${escapeHtml(initialScreen.summary)}</p>
          <div class="balance-grid" id="screen-metrics">${initialMetricsHtml}</div>
        </div>
        <div class="sync-pill" id="sync-status">Waiting for CEP handshake (cep:ready)...</div>
      </div>

      ${!isCustomVertical ? `<div class="card">
        <h2>Host Portal Account Summary</h2>
        <p class="sub">Automatically synced in real time via <code>cep:balance_updated</code> postMessage events whenever CEP executes a trade.</p>
        <div class="balance-grid">
          <div class="bal-box" id="box-total"><span>Total Value</span><strong id="val-total">$50,000.00</strong></div>
          <div class="bal-box" id="box-equity"><span>Equities</span><strong id="val-equity">$14,261.80</strong></div>
          <div class="bal-box" id="box-cash"><span>Cash</span><strong id="val-cash">$35,738.20</strong></div>
        </div>
      </div>` : ""}

      <div class="card">
        <h2>Host-Triggered SDK Actions</h2>
        <p class="sub">Clicking native host buttons drives the embedded CEP iframe via <code>assistant.sendPrompt(...)</code>.</p>
        <div class="action-stack">
          ${actionButtonsHtml}
        </div>
      </div>

      <div class="card">
        <h2>SDK Event Bus Inspector (<code>cep:v1</code>)</h2>
        <p class="sub">Live bi-directional <code>postMessage</code> frames between ${escapeHtml(portalName)} and CEP.</p>
        <div class="event-log" id="event-log"></div>
      </div>
    </section>

    <section>
      <div class="embed-stage-header">
        <div>
          <strong style="font-size:14px;">Embedded CEP Assistant</strong>
          <span style="font-size:12px;color:var(--muted);margin-left:8px;" id="stage-mode-label">Mode: ${initialMode}</span>
        </div>
        <code id="tag-preview">&lt;cep-assistant mode="${initialMode}" domain="${initialDomain}" brand="${escapeHtml(initialBrand)}" accent="${initialAccent}" /&gt;</code>
      </div>
      <div id="embed-mount"></div>
    </section>
  </main>

  <script src="/sdk/cep-embed.js"></script>
  <script>
    (function () {
      var SCREEN_VIEWS = ${safeJsonForScript(screenViews)};
      var state = {
        mode: ${safeJsonForScript(initialMode)},
        domain: ${safeJsonForScript(initialDomain)},
        theme: ${safeJsonForScript(initialTheme)},
        brand: ${safeJsonForScript(initialBrand)},
        accent: ${safeJsonForScript(initialAccent)},
        personaId: ${safeJsonForScript(initialPersona)},
      };
      var controller = null;
      var mountEl = document.getElementById("embed-mount");
      var logEl = document.getElementById("event-log");
      var syncEl = document.getElementById("sync-status");
      var activeScreenEl = document.getElementById("host-active-screen");
      var screenTitleEl = document.getElementById("screen-title");
      var screenSummaryEl = document.getElementById("screen-summary");
      var screenMetricsEl = document.getElementById("screen-metrics");

      function fmtMoney(cents) {
        return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((cents || 0) / 100);
      }

      function addLog(dir, type, payload) {
        var row = document.createElement("div");
        row.className = "event-row";
        var ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        row.innerHTML = '<span class="event-dir ' + dir + '">' + (dir === "in" ? "CEP &rarr; HOST" : "HOST &rarr; CEP") + '</span>'
          + '<strong>' + type + '</strong> <span style="opacity:.7">' + ts + '</span><br/>'
          + '<span>' + JSON.stringify(payload || {}).slice(0, 180) + '</span>';
        logEl.prepend(row);
      }

      function pulseBox(id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.classList.add("pulse");
        setTimeout(function () { el.classList.remove("pulse"); }, 900);
      }

      function updateTagPreview() {
        document.getElementById("stage-mode-label").textContent = "Mode: " + state.mode;
        document.getElementById("tag-preview").textContent =
          '<cep-assistant mode="' + state.mode + '" domain="' + state.domain + '" theme="' + state.theme + '" brand="' + state.brand + '" accent="' + state.accent + '" />';
      }

      function selectHostScreen(idx) {
        var view = SCREEN_VIEWS[idx];
        if (!view || !activeScreenEl) return;
        document.querySelectorAll(".screen-tab-btn").forEach(function (b, i) {
          b.classList.toggle("is-active", i === idx);
        });
        if (screenTitleEl) screenTitleEl.textContent = view.label;
        if (screenSummaryEl) screenSummaryEl.textContent = view.summary;
        if (screenMetricsEl) {
          screenMetricsEl.innerHTML = (view.metrics || []).map(function (m) {
            return '<div class="bal-box"><span>' + String(m.label).replace(/</g, "&lt;") + '</span><strong>' + String(m.value).replace(/</g, "&lt;") + '</strong></div>';
          }).join("");
        }
        // Mutating data-cep-context triggers MutationObserver inside @cep/embed automatically!
        activeScreenEl.setAttribute("data-cep-context", JSON.stringify(view));
      }

      document.querySelectorAll(".screen-tab-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var idx = Number(btn.getAttribute("data-screen-idx") || "0");
          selectHostScreen(idx);
        });
      });

      function remount() {
        if (controller) controller.destroy();
        mountEl.innerHTML = "";
        if (state.mode !== "inline") {
          mountEl.innerHTML = '<div class="launcher-placeholder"><h3 style="margin-top:0;">Floating ' + state.mode + ' active</h3><p>Click the floating <strong>' + state.brand + '</strong> button in the bottom-right corner — or click any Host-Triggered Action on the left — to open the assistant drawer.</p><button type="button" class="ctrl-btn is-active" id="open-drawer-now">Open Assistant Drawer</button></div>';
          var btn = document.getElementById("open-drawer-now");
          if (btn) btn.addEventListener("click", function () { if (controller) controller.open(); });
        }
        controller = window.CEPEmbed.mount(mountEl, {
          mode: state.mode,
          domain: state.domain,
          theme: state.theme,
          brand: state.brand,
          accent: state.accent,
          personaId: state.personaId,
          height: "680px",
          open: state.mode !== "inline",
          onEvent: function (evt) {
            addLog("in", evt.type, evt.payload);
            if (evt.type === "cep:ready") {
              syncEl.textContent = "Connected · " + (evt.payload.displayName || "Profile") + " (" + evt.payload.domain + ")";
            }
            if (evt.type === "cep:balance_updated" && evt.payload) {
              var vt = document.getElementById("val-total");
              var ve = document.getElementById("val-equity");
              var vc = document.getElementById("val-cash");
              if (vt) vt.textContent = fmtMoney(evt.payload.totalCents);
              if (ve) ve.textContent = fmtMoney(evt.payload.equityCents);
              if (vc) vc.textContent = fmtMoney(evt.payload.cashCents);
              syncEl.textContent = "Synced live · " + (evt.payload.displayName || "Profile") + " · " + new Date().toLocaleTimeString();
              pulseBox("box-total"); pulseBox("box-equity"); pulseBox("box-cash");
            }
          },
        });
        controller.element.addEventListener("cep:screen_context_sent", function (e) {
          addLog("out", "cep:screen_context (DOM)", { id: e.detail && e.detail.id, label: e.detail && e.detail.label });
        });
        updateTagPreview();
      }

      ["inline", "launcher", "sidebar"].forEach(function (mode) {
        var btn = document.getElementById("mode-" + mode);
        if (!btn) return;
        btn.addEventListener("click", function () {
          state.mode = mode;
          document.querySelectorAll("#mode-inline,#mode-launcher,#mode-sidebar").forEach(function (b) { b.classList.remove("is-active"); });
          btn.classList.add("is-active");
          remount();
        });
      });

      document.getElementById("toggle-theme").addEventListener("click", function () {
        state.theme = state.theme === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-host-theme", state.theme);
        this.textContent = state.theme === "dark" ? "Light Mode" : "Dark Mode";
        if (controller) controller.setTheme(state.theme);
        addLog("out", "cep:set_theme", { theme: state.theme });
        updateTagPreview();
      });

      document.querySelectorAll(".swatch").forEach(function (sw) {
        sw.addEventListener("click", function () {
          state.brand = sw.getAttribute("data-brand") || "Meridian AI Concierge";
          state.accent = sw.getAttribute("data-accent") || "#1d4ed8";
          document.documentElement.style.setProperty("--accent", state.accent);
          document.getElementById("portal-logo").style.background = state.accent;
          if (controller) controller.setBrand(state.brand, state.accent);
          addLog("out", "cep:set_brand", { brand: state.brand, accent: state.accent });
          updateTagPreview();
        });
      });

      document.querySelectorAll(".action-trigger").forEach(function (btn) {
        if (btn.id === "fire-proactive-btn") {
          btn.addEventListener("click", function () {
            fetch("/api/proactive/trigger", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ eventType: "market.price_alert", personaId: state.personaId }),
            }).then(function () {
              addLog("out", "api:proactive.trigger", { eventType: "market.price_alert" });
            });
          });
          return;
        }
        btn.addEventListener("click", function () {
          var prompt = btn.getAttribute("data-prompt");
          var targetDomain = btn.getAttribute("data-domain");
          if (targetDomain && targetDomain !== state.domain) {
            state.domain = targetDomain;
            if (controller) controller.setDomain(targetDomain);
            addLog("out", "cep:set_domain", { domain: targetDomain });
            updateTagPreview();
          }
          if (controller && prompt) {
            controller.sendPrompt(prompt);
            addLog("out", "cep:send_prompt", { prompt: prompt });
          }
        });
      });

      remount();
    })();
  </script>
</body>
</html>`;
}
