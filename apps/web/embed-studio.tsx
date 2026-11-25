import { useEffect, useMemo, useState } from "react";
import { Bell, Check, Code2, Copy, ExternalLink, Globe, Send, Sparkles } from "lucide-react";
import type { OmnichannelChannel, OmnichannelConfig, OmnichannelView } from "../../packages/contracts/omnichannel";
import type { CepEmbedDomain, CepEmbedMode, CepEmbedTheme } from "../../packages/embed-sdk";
import { api } from "./api";
import { ProactiveEventsCard } from "./proactive-events-card";
import { ScheduledJobsCard } from "./scheduled-jobs-card";
import { VerticalFactoryCard } from "./vertical-factory-card";

type SnippetTab = "web-component" | "react" | "javascript" | "events";

const ACCENT_PRESETS = [
  { label: "Meridian Navy", color: "#1d4ed8", brand: "Meridian AI Concierge" },
  { label: "Private Emerald", color: "#0f766e", brand: "Apex Private Desk" },
  { label: "Royal Plum", color: "#6d28d9", brand: "Vanguardian Wealth" },
  { label: "CEP Green", color: "#2f7d22", brand: "CEP Assistant" },
];

export function EmbedStudio() {
  const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:4180";
  const [mode, setMode] = useState<CepEmbedMode>("inline");
  const [domain, setDomain] = useState<CepEmbedDomain>("wealth");
  const [theme, setTheme] = useState<CepEmbedTheme>("light");
  const [personaId, setPersonaId] = useState("demo-learner");
  const [brand, setBrand] = useState("Meridian AI Concierge");
  const [accent, setAccent] = useState("#1d4ed8");
  const [snippetTab, setSnippetTab] = useState<SnippetTab>("web-component");
  const [copied, setCopied] = useState(false);

  const [omni, setOmni] = useState<OmnichannelView | null>(null);
  const [omniDraft, setOmniDraft] = useState<OmnichannelConfig | null>(null);
  const [omniBusy, setOmniBusy] = useState(false);
  const [omniNotice, setOmniNotice] = useState("");
  const [previewChannel, setPreviewChannel] = useState<"slack" | "teams">("slack");

  useEffect(() => {
    let alive = true;
    void api.omnichannel().then((view) => {
      if (!alive) return;
      setOmni(view);
      setOmniDraft(view.config);
      if (view.config.channel === "teams") setPreviewChannel("teams");
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const demoHref = useMemo(() => {
    const params = new URLSearchParams({
      mode,
      domain,
      theme,
      personaId,
      brand,
      accent,
    });
    return `/embed-demo?${params.toString()}`;
  }, [mode, domain, theme, personaId, brand, accent]);

  const previewIframeSrc = useMemo(() => {
    const params = new URLSearchParams({
      mode: "inline",
      domain,
      theme,
      personaId,
      brand,
      accent,
    });
    return `/embed?${params.toString()}`;
  }, [domain, theme, personaId, brand, accent]);

  const snippet = useMemo(() => {
    if (snippetTab === "web-component") {
      return `<!-- 1. Load zero-dependency CEP Embed SDK -->
<script src="${origin}/sdk/cep-embed.js" defer></script>

<!-- 2. Drop the Shadow-DOM Web Component anywhere in your app -->
<cep-assistant
  mode="${mode}"
  domain="${domain}"
  theme="${theme}"
  persona-id="${personaId}"
  brand="${brand}"
  accent="${accent}"
  height="640px"
></cep-assistant>`;
    }
    if (snippetTab === "react") {
      return `import { useEffect, useRef } from "react";
import type { CepEmbedController } from "@cep/embed";

export function EmbeddedAdvisor() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hostRef.current || !(window as any).CEPEmbed) return;
    const ctrl: CepEmbedController = (window as any).CEPEmbed.mount(hostRef.current, {
      baseUrl: "${origin}",
      mode: "${mode}",
      domain: "${domain}",
      theme: "${theme}",
      personaId: "${personaId}",
      brand: "${brand}",
      accent: "${accent}",
      onEvent: (event) => {
        if (event.type === "cep:balance_updated") {
          console.log("Live settled balance:", event.payload);
        }
      },
    });
    return () => ctrl.destroy();
  }, []);

  return <div ref={hostRef} />;
}`;
    }
    if (snippetTab === "javascript") {
      return `<div id="cep-host"></div>
<script src="${origin}/sdk/cep-embed.js"></script>
<script>
  const assistant = window.CEPEmbed.mount("#cep-host", {
    baseUrl: "${origin}",
    mode: "${mode}",
    domain: "${domain}",
    theme: "${theme}",
    personaId: "${personaId}",
    brand: "${brand}",
    accent: "${accent}",
    onEvent: (evt) => console.log("[CEP Event]", evt.type, evt.payload),
  });

  // Drive CEP from any host portal button:
  // assistant.sendPrompt("I want to sell 40% of my Apple shares");
  // assistant.setTheme("dark");
  // assistant.setBrand("${brand}", "${accent}");
</script>`;
    }
    return `// Bi-directional postMessage protocol ("cep:v1")

// Host -> CEP commands:
{ protocol: "cep:v1", type: "cep:send_prompt", payload: { prompt: "I want to sell 40% of my Apple shares" } }
{ protocol: "cep:v1", type: "cep:set_theme",   payload: { theme: "dark" } }
{ protocol: "cep:v1", type: "cep:set_domain",  payload: { domain: "it_ops" } }
{ protocol: "cep:v1", type: "cep:set_brand",   payload: { brand: "${brand}", accent: "${accent}" } }

// CEP -> Host events:
{ protocol: "cep:v1", type: "cep:ready",           payload: { personaId, displayName, domain, theme } }
{ protocol: "cep:v1", type: "cep:turn_completed",  payload: { turnId, message, status, summary } }
{ protocol: "cep:v1", type: "cep:balance_updated", payload: { personaId, cashCents, equityCents, totalCents } }`;
  }, [snippetTab, origin, mode, domain, theme, personaId, brand, accent]);

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* ignore clipboard errors */ }
  };

  const saveOmnichannel = async () => {
    if (!omniDraft) return;
    setOmniBusy(true);
    setOmniNotice("");
    try {
      const updated = await api.saveOmnichannel(omniDraft);
      setOmni(updated);
      setOmniDraft(updated.config);
      setOmniNotice("Omnichannel HITL webhook configuration saved.");
    } catch (err) {
      setOmniNotice(err instanceof Error ? err.message : "Failed to save omnichannel settings.");
    } finally {
      setOmniBusy(false);
    }
  };

  const sendTestAlert = async () => {
    setOmniBusy(true);
    setOmniNotice("");
    try {
      const result = await api.testOmnichannel();
      setOmni(result.view);
      setOmniNotice(`Dispatched ${result.delivery.channel.toUpperCase()} test alert (${result.delivery.status.replace("_", " ")}).`);
    } catch (err) {
      setOmniNotice(err instanceof Error ? err.message : "Failed to send test alert.");
    } finally {
      setOmniBusy(false);
    }
  };

  return (
    <div className="admin-page embed-studio-page">
      <header className="embed-studio-header">
        <div>
          <span className="embed-kicker"><Globe size={13} aria-hidden="true" /> Omnichannel Distribution &amp; White-Label SDK</span>
          <h1>Embed SDK &amp; Omnichannel Studio</h1>
          <p>
            Drop CEP into any customer portal, internal ops console, or CRM via zero-dependency Shadow DOM Web Components
            (<code>&lt;cep-assistant&gt;</code>) and route high-risk HITL approvals to Slack or Microsoft Teams.
          </p>
        </div>
        <div className="embed-studio-cta">
          <a className="embed-primary-link" href={demoHref} target="_blank" rel="noreferrer">
            <ExternalLink size={15} aria-hidden="true" />
            Launch Host Portal Simulator
          </a>
          <a className="embed-secondary-link" href="/sdk/cep-embed.js" target="_blank" rel="noreferrer">
            <Code2 size={15} aria-hidden="true" />
            Inspect /sdk/cep-embed.js
          </a>
        </div>
      </header>

      <VerticalFactoryCard />

      <div className="embed-studio-grid">
        <section className="embed-card">
          <h2>1. White-Label Embed Configurator</h2>
          <p className="embed-card-sub">Customize surface layout, domain pack, theme, and brand identity. Code snippets and live preview update instantly.</p>

          <div className="embed-form-grid">
            <label>
              <span>Embed Mode</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as CepEmbedMode)}>
                <option value="inline">Inline Co-Pilot (container)</option>
                <option value="launcher">Floating Launcher FAB + Drawer</option>
                <option value="sidebar">Full-Height Slide-Over Sidebar</option>
              </select>
            </label>
            <label>
              <span>Default Domain Pack</span>
              <select value={domain} onChange={(e) => setDomain(e.target.value as CepEmbedDomain)}>
                <option value="wealth">Wealth Advisory &amp; Trading</option>
                <option value="it_ops">IT Operations &amp; SRE</option>
                <option value="sales_revops">Sales RevOps &amp; Deal Desk</option>
              </select>
            </label>
            <label>
              <span>Initial Theme</span>
              <select value={theme} onChange={(e) => setTheme(e.target.value as CepEmbedTheme)}>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <label>
              <span>Signed-In Customer Persona</span>
              <select value={personaId} onChange={(e) => setPersonaId(e.target.value)}>
                <option value="demo-learner">Alice Morgan (Active Investor)</option>
                <option value="demo-returning">Jordan Lee (Returning Investor)</option>
                <option value="demo-new-account">Marcus Reed (Unfunded)</option>
              </select>
            </label>
            <label>
              <span>White-Label Brand Title</span>
              <input value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={60} />
            </label>
            <label>
              <span>Brand Accent Color</span>
              <div className="embed-accent-row">
                <input value={accent} onChange={(e) => setAccent(e.target.value)} maxLength={9} />
                <div className="embed-swatch-row">
                  {ACCENT_PRESETS.map((preset) => (
                    <button
                      key={preset.color}
                      type="button"
                      className={"embed-swatch" + (accent.toLowerCase() === preset.color ? " is-active" : "")}
                      style={{ background: preset.color }}
                      title={preset.label}
                      onClick={() => { setAccent(preset.color); setBrand(preset.brand); }}
                    />
                  ))}
                </div>
              </div>
            </label>
          </div>

          <div className="embed-snippet-header">
            <div className="embed-tab-bar" role="tablist">
              {(["web-component", "react", "javascript", "events"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={snippetTab === tab}
                  className={"embed-tab" + (snippetTab === tab ? " is-active" : "")}
                  onClick={() => setSnippetTab(tab)}
                >
                  {tab === "web-component" ? "HTML Web Component" : tab === "react" ? "React / Next.js" : tab === "javascript" ? "Imperative JS" : "postMessage Events"}
                </button>
              ))}
            </div>
            <button type="button" className="embed-copy-btn" onClick={copySnippet}>
              {copied ? <><Check size={14} aria-hidden="true" />Copied</> : <><Copy size={14} aria-hidden="true" />Copy snippet</>}
            </button>
          </div>
          <pre className="embed-code-block"><code>{snippet}</code></pre>
        </section>

        <section className="embed-card embed-preview-card">
          <div className="embed-preview-head">
            <div>
              <h2>2. Live Embedded Surface Preview</h2>
              <p className="embed-card-sub">Real chromeless <code>/embed</code> frame rendered with your brand &amp; accent overrides.</p>
            </div>
            <span className="embed-live-pill"><Sparkles size={12} aria-hidden="true" />Live iframe</span>
          </div>
          <div className="embed-preview-frame-shell">
            <iframe
              key={previewIframeSrc}
              title="CEP Live Embed Preview"
              src={previewIframeSrc}
              className="embed-preview-iframe"
            />
          </div>
        </section>
      </div>

      <section className="embed-card embed-omni-section">
        <div className="embed-omni-head">
          <div>
            <h2><Bell size={16} aria-hidden="true" /> 3. Omnichannel HITL Approval Webhooks (Slack &amp; Microsoft Teams)</h2>
            <p className="embed-card-sub">
              Whenever CEP queues a SHA-256 digest-locked approval (high-value trades &gt; $10k, PagerDuty webhooks, production rollbacks, or Deal Desk overrides),
              deliver interactive approval cards directly into your team channels.
            </p>
          </div>
          <div className="embed-omni-actions">
            <button type="button" className="embed-secondary-btn" disabled={omniBusy} onClick={sendTestAlert}>
              <Send size={14} aria-hidden="true" />
              Send Test Alert
            </button>
            <button type="button" className="embed-primary-btn" disabled={omniBusy || !omniDraft} onClick={saveOmnichannel}>
              Save Webhook Config
            </button>
          </div>
        </div>

        {omniNotice && <div className="embed-notice" role="status">{omniNotice}</div>}

        <div className="embed-omni-grid">
          <div className="embed-omni-form">
            {omniDraft && (
              <>
                <div className="embed-form-grid">
                  <label>
                    <span>Target Channel Format</span>
                    <select
                      value={omniDraft.channel}
                      onChange={(e) => {
                        const next = e.target.value as OmnichannelChannel;
                        setOmniDraft({ ...omniDraft, channel: next });
                        if (next === "slack" || next === "teams") setPreviewChannel(next);
                      }}
                    >
                      <option value="slack">Slack (Block Kit)</option>
                      <option value="teams">Microsoft Teams (Adaptive Card v1.4)</option>
                      <option value="webhook">Generic Signed JSON Webhook</option>
                    </select>
                  </label>
                  <label>
                    <span>Channel / Destination Label</span>
                    <input
                      value={omniDraft.channelName}
                      onChange={(e) => setOmniDraft({ ...omniDraft, channelName: e.target.value })}
                      placeholder="#cep-approvals"
                    />
                  </label>
                </div>
                <label className="embed-full-field">
                  <span>Incoming Webhook URL (leave blank for local Sandbox Preview)</span>
                  <input
                    value={omniDraft.webhookUrl}
                    onChange={(e) => setOmniDraft({ ...omniDraft, webhookUrl: e.target.value })}
                    placeholder="https://hooks.slack.com/services/... (optional)"
                  />
                </label>
                <div className="embed-toggle-list">
                  <label className="embed-checkbox">
                    <input
                      type="checkbox"
                      checked={omniDraft.enabled}
                      onChange={(e) => setOmniDraft({ ...omniDraft, enabled: e.target.checked })}
                    />
                    <span>Enable outbound omnichannel governance dispatch</span>
                  </label>
                  <label className="embed-checkbox">
                    <input
                      type="checkbox"
                      checked={omniDraft.notifyOnPendingApproval}
                      onChange={(e) => setOmniDraft({ ...omniDraft, notifyOnPendingApproval: e.target.checked })}
                    />
                    <span>Notify on every SHA-256 pending HITL approval</span>
                  </label>
                  <label className="embed-checkbox">
                    <input
                      type="checkbox"
                      checked={omniDraft.includeDigestBadge}
                      onChange={(e) => setOmniDraft({ ...omniDraft, includeDigestBadge: e.target.checked })}
                    />
                    <span>Include SHA-256 payload digest badge in approval cards</span>
                  </label>
                </div>
              </>
            )}

            <div className="embed-delivery-log">
              <h3>Recent Omnichannel Deliveries ({omni?.deliveries.length ?? 0})</h3>
              {(!omni || omni.deliveries.length === 0) ? (
                <p className="embed-empty-note">No deliveries yet. Click <strong>Send Test Alert</strong> or trigger a high-value approval in chat.</p>
              ) : (
                <div className="embed-delivery-list">
                  {omni.deliveries.slice(0, 8).map((item) => (
                    <div key={item.id} className="embed-delivery-row">
                      <div className="embed-delivery-top">
                        <span className={`embed-status-pill is-${item.status}`}>{item.status.replace("_", " ")}</span>
                        <strong>{item.title}</strong>
                        <span className="embed-delivery-meta">{item.channel.toUpperCase()} · {item.channelName}</span>
                      </div>
                      <small>{item.summary}</small>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="embed-payload-preview">
            <div className="embed-tab-bar">
              <button
                type="button"
                className={"embed-tab" + (previewChannel === "slack" ? " is-active" : "")}
                onClick={() => setPreviewChannel("slack")}
              >
                Slack Block Kit Payload
              </button>
              <button
                type="button"
                className={"embed-tab" + (previewChannel === "teams" ? " is-active" : "")}
                onClick={() => setPreviewChannel("teams")}
              >
                MS Teams Adaptive Card
              </button>
            </div>
            <pre className="embed-code-block embed-payload-json">
              <code>{JSON.stringify(omni?.samplePayloads[previewChannel] ?? {}, null, 2)}</code>
            </pre>
          </div>
        </div>
      </section>

      <ProactiveEventsCard />
      <ScheduledJobsCard />
    </div>
  );
}
