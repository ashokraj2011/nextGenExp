import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleAlert, Cpu, FlaskConical, Power, RotateCcw } from "lucide-react";
import { api, toolSetupErrorMessage } from "./api";
import "./recommendation-studio.css";

type Provider = "openai_compatible" | "openai" | "gemini" | "copilot_acp";
type Config = {
  provider: Provider; label?: string; baseUrl?: string; model: string;
  apiKeyMode: "stored" | "env" | "none"; apiKey?: string; apiKeyEnv?: string;
  headers: Record<string, string>; bodyFields: Record<string, unknown>;
  contextWindow: number; maxOutputTokens: number; quirks: string[]; copilotCommand?: string;
};
export type GatewayTest = { ok: boolean; testedAt: string; latencyMs: number; provider: Provider; model: string; steps: { name: string; ok: boolean; detail: string }[]; configDigest: string };
export type GatewayView = {
  source: "saved" | "environment" | "default" | "none";
  running: { provider: string; model: string; baseUrl?: string } | null;
  active?: Omit<Config, "apiKey"> & { apiKeySet: boolean; apiKeyHint?: string; activatedAt: string; activatedBy: string };
  lastTest?: GatewayTest;
  restartSupported: boolean;
};

const QUIRKS = [
  ["system_as_user", "Send system prompts as user messages"],
  ["no_stream_usage", "Gateway doesn't report token usage when streaming"],
  ["no_strict", "No strict JSON-schema mode"],
  ["json_mode_only", "Only JSON mode (no JSON schema)"],
  ["tool_choice_unsupported", "No tool_choice parameter"],
] as const;

const PROVIDER_LABEL: Record<Provider, string> = {
  copilot_acp: "GitHub Copilot (ACP)",
  gemini: "Google Gemini API (@sfield/core GeminiProvider)",
  openai: "OpenAI API",
  openai_compatible: "LLM gateway (OpenAI-compatible Chat Completions)",
};

function blank(provider: Provider = "copilot_acp"): Config {
  const model = provider === "copilot_acp" ? "auto" : provider === "gemini" ? "gemini-2.5-flash" : provider === "openai" ? "gpt-4.1-mini" : "";
  const contextWindow = provider === "gemini" ? 1_000_000 : 16384;
  const maxOutputTokens = provider === "gemini" ? 8192 : 1500;
  return { provider, model, baseUrl: "", apiKeyMode: provider === "copilot_acp" ? "none" : "stored",
    headers: {}, bodyFields: {}, contextWindow, maxOutputTokens, quirks: [] };
}

function fromView(v: GatewayView): Config {
  if (v.active) {
    const { apiKeySet: _s, apiKeyHint: _h, activatedAt: _a, activatedBy: _b, ...rest } = v.active;
    return { ...blank(rest.provider), ...rest };
  }
  if (v.running) {
    const provider = v.running.provider as Provider;
    return { ...blank(provider), model: v.running.model, baseUrl: v.running.baseUrl ?? "" };
  }
  return blank();
}

export function GatewayAdmin() {
  const [view, setView] = useState<GatewayView | null>(null);
  const [config, setConfig] = useState<Config>(blank);
  const [headersText, setHeadersText] = useState("{}");
  const [bodyText, setBodyText] = useState("{}");
  const [jsonError, setJsonError] = useState("");
  const [test, setTest] = useState<GatewayTest | null>(null);
  const [testedDigest, setTestedDigest] = useState("");
  const [busy, setBusy] = useState<"" | "test" | "activate" | "reset" | "restarting">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    const v = await api.gatewayConfig();
    setView(v);
    return v;
  }
  useEffect(() => {
    void load().then((v) => {
      const c = fromView(v);
      setConfig(c);
      setHeadersText(JSON.stringify(c.headers, null, 2));
      setBodyText(JSON.stringify(c.bodyFields, null, 2));
    }).catch((e) => setError(toolSetupErrorMessage(e)));
  }, []);

  const set = (patch: Partial<Config>) => setConfig((c) => ({ ...c, ...patch }));
  const formKey = useMemo(() => JSON.stringify({ ...config, label: undefined }), [config]);
  const testedThisForm = test?.ok && testedDigest === formKey;

  function payload(): Config | null {
    try {
      const headers = JSON.parse(headersText || "{}") as Record<string, string>;
      const bodyFields = JSON.parse(bodyText || "{}") as Record<string, unknown>;
      setJsonError("");
      const c: Config = { ...config, headers, bodyFields };
      if (c.provider !== "openai_compatible") { delete c.baseUrl; c.headers = {}; c.bodyFields = {}; c.quirks = []; }
      if (c.provider === "copilot_acp") { c.apiKeyMode = "none"; delete c.apiKey; delete c.apiKeyEnv; }
      if (c.apiKeyMode !== "stored") delete c.apiKey;
      if (c.apiKeyMode !== "env") delete c.apiKeyEnv;
      if (!c.label) delete c.label;
      if (!c.copilotCommand) delete c.copilotCommand;
      return c;
    } catch {
      setJsonError("Headers and extra body fields must be JSON objects.");
      return null;
    }
  }

  async function runTest() {
    const c = payload();
    if (!c) return;
    setBusy("test"); setError(""); setNotice(""); setTest(null);
    try {
      const result = await api.testGateway(c);
      setTest(result);
      setTestedDigest(formKey);
    } catch (e) { setError(toolSetupErrorMessage(e)); }
    finally { setBusy(""); }
  }

  async function waitForRestart(expect: (v: GatewayView) => boolean) {
    setBusy("restarting");
    const until = Date.now() + 60_000;
    await new Promise((r) => setTimeout(r, 1500));
    while (Date.now() < until) {
      try { const v = await load(); if (expect(v)) { setBusy(""); return true; } } catch { /* server restarting */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    setBusy("");
    return false;
  }

  async function activate() {
    const c = payload();
    if (!c) return;
    setBusy("activate"); setError(""); setNotice("");
    try {
      const out = await api.activateGateway(c);
      if (!out.restarting) { setView(out.view); setNotice("Saved. Restart the server to switch the running model."); setBusy(""); return; }
      const ok = await waitForRestart((v) => v.source === "saved" && v.running?.provider === c.provider && v.running.model === c.model);
      setNotice(ok ? `Active: sfield now runs on ${c.model}.` : "Saved, but the server didn't come back with the new model. Check the server log.");
    } catch (e) { setError(toolSetupErrorMessage(e)); setBusy(""); }
  }

  async function reset() {
    setBusy("reset"); setError(""); setNotice("");
    try {
      const out = await api.resetGateway();
      if (!out.restarting) { setView(out.view); setBusy(""); return; }
      const ok = await waitForRestart((v) => v.source !== "saved");
      setNotice(ok ? "The startup gateway is active." : "Restart the server to use the startup gateway.");
    } catch (e) { setError(toolSetupErrorMessage(e)); setBusy(""); }
  }

  const running = view?.running;
  return (
    <div className="pzn-studio" style={{ padding: 24, maxWidth: 980 }}>
      <section className="content-card pzn-widget-card" aria-label="Running model">
        <div className="pzn-widget-head">
          <div>
            <span className="pzn-stage-kicker"><Cpu size={13} /> MODEL GATEWAY · SFIELD</span>
            <h3>{running ? `${PROVIDER_LABEL[running.provider as Provider] ?? running.provider} · ${running.model}` : "No model configured"}</h3>
          </div>
          <span className={"pzn-badge " + (view?.source === "none" ? "is-warn" : "is-pass")}>
            {view?.source === "saved" ? "Saved configuration" : view?.source === "default" ? "Built-in default" : view?.source === "environment" ? "From environment" : "Not configured"}
          </span>
        </div>
        <div className="pzn-list-meta" style={{ fontSize: "0.8rem" }}>
          {running?.baseUrl && <span>Endpoint: <code className="pzn-code">{running.baseUrl}</code></span>}
          {view?.active && <span>Activated by {view.active.activatedBy} · {new Date(view.active.activatedAt).toLocaleString()}</span>}
          {view?.active?.apiKeySet && <span>API key: {view.active.apiKeyHint} (stored on the server)</span>}
          {view?.lastTest && <span>Last test: {view.lastTest.ok ? "passed" : "failed"} · {new Date(view.lastTest.testedAt).toLocaleString()}</span>}
        </div>
        <p className="pzn-subtitle" style={{ fontSize: "0.78rem" }}>
          The app and sfield use this provider for model calls. Copilot ACP is the built-in default. Activating a saved configuration restarts the app with that provider.
        </p>
        {view?.source === "saved" && (
          <div className="pzn-btn-row">
            <button type="button" className="pzn-btn pzn-btn-sm" disabled={Boolean(busy)} onClick={() => void reset()}><RotateCcw size={12} /> Use startup settings</button>
          </div>
        )}
      </section>

      <section className="content-card pzn-widget-card" aria-label="Gateway configuration" style={{ marginTop: 16 }}>
        <div className="pzn-widget-head">
          <div>
            <span className="pzn-stage-kicker">CONFIGURATION</span>
            <h3>Test, then activate</h3>
          </div>
        </div>
        <div className="pzn-form-grid">
          <div className="pzn-field">
            <label>Provider</label>
            <select aria-label="Provider" value={config.provider} onChange={(e) => {
              const { provider, model, apiKeyMode, contextWindow, maxOutputTokens } = blank(e.target.value as Provider);
              set({ provider, model, apiKeyMode, contextWindow, maxOutputTokens });
            }}>
              {(Object.keys(PROVIDER_LABEL) as Provider[]).map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
            </select>
          </div>
          <div className="pzn-field">
            <label>Name (optional)</label>
            <input aria-label="Configuration name" placeholder="e.g. Corporate gateway" value={config.label ?? ""} onChange={(e) => set({ label: e.target.value })} />
          </div>
          {config.provider === "openai_compatible" && (
            <div className="pzn-field is-full">
              <label>Base URL (Chat Completions prefix)</label>
              <input aria-label="Base URL" placeholder="https://gateway.example.com/v1" value={config.baseUrl ?? ""} onChange={(e) => set({ baseUrl: e.target.value })} />
            </div>
          )}
          <div className="pzn-field">
            <label>Model</label>
            <input aria-label="Model" placeholder={config.provider === "copilot_acp" ? "auto" : config.provider === "gemini" ? "gemini-2.5-flash" : config.provider === "openai" ? "gpt-4.1-mini" : "model id"} value={config.model} onChange={(e) => set({ model: e.target.value })} />
          </div>
          {config.provider === "copilot_acp" ? (
            <div className="pzn-field">
              <label>Copilot command</label>
              <input aria-label="Copilot command" placeholder="copilot" value={config.copilotCommand ?? ""} onChange={(e) => set({ copilotCommand: e.target.value })} />
            </div>
          ) : (
            <div className="pzn-field">
              <label>API key</label>
              <select aria-label="API key source" value={config.apiKeyMode} onChange={(e) => set({ apiKeyMode: e.target.value as Config["apiKeyMode"] })}>
                <option value="stored">Enter it here (stored on the server only)</option>
                <option value="env">Read from an environment variable</option>
                {config.provider === "openai_compatible" && <option value="none">None (use headers)</option>}
              </select>
            </div>
          )}
          {config.provider !== "copilot_acp" && config.apiKeyMode === "stored" && (
            <div className="pzn-field">
              <label>Key</label>
              <input aria-label="API key" type="password" autoComplete="off"
                placeholder={view?.active?.apiKeySet ? `${view.active.apiKeyHint} — leave blank to keep` : "sk-…"}
                value={config.apiKey ?? ""} onChange={(e) => set({ apiKey: e.target.value })} />
            </div>
          )}
          {config.provider !== "copilot_acp" && config.apiKeyMode === "env" && (
            <div className="pzn-field">
              <label>Environment variable</label>
              <input aria-label="API key env var" placeholder={config.provider === "gemini" ? "GEMINI_API_KEY" : config.provider === "openai" ? "OPENAI_API_KEY" : "LLM_API_KEY"} value={config.apiKeyEnv ?? ""} onChange={(e) => set({ apiKeyEnv: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") })} />
            </div>
          )}
          <div className="pzn-field">
            <label>Context window (tokens)</label>
            <input aria-label="Context window" type="number" min={4096} value={config.contextWindow} onChange={(e) => set({ contextWindow: Number(e.target.value) })} />
          </div>
          <div className="pzn-field">
            <label>Max output (tokens)</label>
            <input aria-label="Max output tokens" type="number" min={512} value={config.maxOutputTokens} onChange={(e) => set({ maxOutputTokens: Number(e.target.value) })} />
          </div>
          {config.provider === "openai_compatible" && (
            <>
              <div className="pzn-field is-full">
                <label>Extra headers (JSON) — e.g. {"{\"Authorization\": \"Bearer …\", \"X-Team\": \"cep\"}"}</label>
                <textarea aria-label="Extra headers" rows={3} value={headersText} onChange={(e) => setHeadersText(e.target.value)} />
              </div>
              <div className="pzn-field is-full">
                <label>Extra request body fields (JSON) — e.g. {"{\"user\": \"cep\"}"}</label>
                <textarea aria-label="Extra body fields" rows={2} value={bodyText} onChange={(e) => setBodyText(e.target.value)} />
              </div>
              <div className="pzn-field is-full">
                <label>Gateway quirks</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
                  {QUIRKS.map(([q, label]) => (
                    <label key={q} style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: "0.8rem", fontWeight: 400 }}>
                      <input type="checkbox" checked={config.quirks.includes(q)} onChange={(e) => set({ quirks: e.target.checked ? [...config.quirks, q] : config.quirks.filter((x) => x !== q) })} />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
        {jsonError && <p className="pzn-error" role="alert">{jsonError}</p>}

        {test && (
          <div className="pzn-list" aria-label="Test result" style={{ marginTop: 8 }}>
            <div className="pzn-btn-row">
              <span className={"pzn-badge " + (test.ok ? "is-pass" : "is-fail")}>{test.ok ? "Test passed" : "Test failed"}</span>
              <span className="pzn-subtitle" style={{ fontSize: "0.78rem" }}>{test.latencyMs} ms total</span>
              {!testedThisForm && test.ok && <span className="pzn-badge is-warn">Changed since the test — test again</span>}
            </div>
            {test.steps.map((s) => (
              <div key={s.name} className="pzn-biz-def" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                {s.ok ? <CheckCircle2 size={14} color="var(--success, #2f855a)" /> : <CircleAlert size={14} color="var(--danger, #c0392b)" />}
                <span><strong>{s.name}</strong> — {s.detail}</span>
              </div>
            ))}
          </div>
        )}
        {error && <p className="pzn-error" role="alert">{error}</p>}
        {notice && <p className="pzn-badge is-pass" role="status" style={{ display: "inline-block" }}>{notice}</p>}
        <div className="pzn-btn-row" style={{ marginTop: 8 }}>
          <button type="button" className="pzn-btn pzn-btn-sm" disabled={Boolean(busy) || !config.model} onClick={() => void runTest()}>
            <FlaskConical size={12} /> {busy === "test" ? "Testing…" : "Test connection"}
          </button>
          <button type="button" className="pzn-btn pzn-btn-sm pzn-btn-primary" disabled={Boolean(busy) || !testedThisForm} onClick={() => void activate()}
            title={testedThisForm ? "Save and switch sfield to this model" : "Run a passing test of this exact configuration first"}>
            <Power size={12} /> {busy === "activate" ? "Activating…" : busy === "restarting" ? "Restarting with the new model…" : "Activate"}
          </button>
          {!testedThisForm && <span className="pzn-subtitle" style={{ fontSize: "0.76rem" }}>Activate is enabled after a passing test of exactly these settings.</span>}
        </div>
      </section>
    </div>
  );
}
