import { useEffect, useState } from "react";
import { Eye, Lock, Play, RotateCw, ShieldAlert, ShieldCheck } from "lucide-react";
import type { PiiFirewallConfig, PiiFirewallView, PiiRedactionTrace } from "../../packages/contracts/pii-firewall";
import { api, toolSetupErrorMessage } from "./api";

const DEFAULT_TEST_PROMPT = "Wire $18,500 for Alice Morgan from acct-8821 and send receipt to alice@meridian.io or call 415-555-0192";
const DEFAULT_TEST_CONTEXT = "Alice Morgan (Account mid_alice_001, Cash $35,738.20, Equities $74,565.80)";

export function PiiFirewallPanel() {
  const [view, setView] = useState<PiiFirewallView | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [samplePrompt, setSamplePrompt] = useState(DEFAULT_TEST_PROMPT);
  const [sampleContext, setSampleContext] = useState(DEFAULT_TEST_CONTEXT);
  const [testTrace, setTestTrace] = useState<PiiRedactionTrace | null>(null);

  async function load() {
    try {
      setView(await api.piiFirewall());
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function update(patch: Partial<PiiFirewallConfig>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await api.savePiiFirewall(patch);
      setView(next);
      setNotice(
        patch.enabled !== undefined
          ? (next.config.enabled
            ? "Visual PII Firewall is now ON — all customer prompts & Customer 360 context are tokenized before reaching the LLM."
            : "Visual PII Firewall is now OFF — raw prompts & context will pass through unredacted.")
          : "PII Firewall category rules updated.",
      );
      // Automatically refresh sandbox preview if already tested
      if (testTrace) {
        const res = await api.testPiiFirewall(samplePrompt, sampleContext);
        setTestTrace(res.trace);
      }
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function runSandboxTest() {
    if (!samplePrompt.trim()) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.testPiiFirewall(samplePrompt, sampleContext);
      setTestTrace(res.trace);
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const enabled = view?.config.enabled ?? false;

  return (
    <section className="admin-card pii-admin-panel" aria-labelledby="pii-firewall-title">
      <div className="pii-admin-head">
        <div>
          <h2 id="pii-firewall-title" style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            {enabled ? <ShieldCheck size={19} aria-hidden="true" /> : <ShieldAlert size={19} aria-hidden="true" />}
            Visual PII Firewall &amp; LLM X-Ray Mode
          </h2>
          <p>
            Zero-leakage local tokenization boundary: scrubs customer names, balances, account IDs, emails, and phones into opaque tokens
            (<code>«PERSON_1»</code>, <code>«AMOUNT_1»</code>, <code>«ACCT_1»</code>) before LLM calls and re-hydrates real values locally at render time.
          </p>
        </div>
        <div className="pii-master-controls">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            disabled={busy || !view}
            className={"pii-master-switch " + (enabled ? "is-on" : "is-off")}
            onClick={() => void update({ enabled: !enabled })}
          >
            <Lock size={14} aria-hidden="true" />
            {enabled ? "PII Firewall: ON" : "PII Firewall: OFF"}
          </button>
          <button type="button" className="secondary-button" onClick={() => void load()}>
            <RotateCw size={14} aria-hidden="true" /> Refresh
          </button>
        </div>
      </div>

      {notice && <div className="embed-notice" role="status">{notice}</div>}
      {error && <p className="request-notice" role="alert">{error}</p>}

      {view && (
        <>
          <div className="pii-kpi-row">
            <div className="pii-kpi-box">
              <span>Status</span>
              <strong className={enabled ? "is-ok" : "is-warn"}>{enabled ? "Active (Zero-Leakage)" : "Disabled (Pass-Through)"}</strong>
            </div>
            <div className="pii-kpi-box">
              <span>Turns Inspected</span>
              <strong>{view.stats.totalTurnsInspected}</strong>
            </div>
            <div className="pii-kpi-box">
              <span>Turns Protected</span>
              <strong>{view.stats.totalTurnsProtected}</strong>
            </div>
            <div className="pii-kpi-box">
              <span>PII Tokens Scrubbed</span>
              <strong>{view.stats.totalTokensRedacted}</strong>
            </div>
          </div>

          <div className="pii-category-grid">
            <label className="pii-cat-check">
              <input
                type="checkbox"
                disabled={busy || !enabled}
                checked={view.config.redactNames}
                onChange={(e) => void update({ redactNames: e.target.checked })}
              />
              <span>Customer Names (<code>«PERSON_1»</code>)</span>
            </label>
            <label className="pii-cat-check">
              <input
                type="checkbox"
                disabled={busy || !enabled}
                checked={view.config.redactAmounts}
                onChange={(e) => void update({ redactAmounts: e.target.checked })}
              />
              <span>Dollar Balances &amp; Amounts (<code>«AMOUNT_1»</code>)</span>
            </label>
            <label className="pii-cat-check">
              <input
                type="checkbox"
                disabled={busy || !enabled}
                checked={view.config.redactAccountIds}
                onChange={(e) => void update({ redactAccountIds: e.target.checked })}
              />
              <span>Account, Case &amp; Invoice IDs (<code>«ACCT_1»</code>)</span>
            </label>
            <label className="pii-cat-check">
              <input
                type="checkbox"
                disabled={busy || !enabled}
                checked={view.config.redactEmailsPhones}
                onChange={(e) => void update({ redactEmailsPhones: e.target.checked })}
              />
              <span>Emails, Phones &amp; SSNs (<code>«EMAIL_1»</code>, <code>«PHONE_1»</code>)</span>
            </label>
          </div>

          <div className="pii-sandbox-box">
            <div className="pii-sandbox-head">
              <h3><Eye size={15} aria-hidden="true" /> Live LLM X-Ray Redaction Sandbox</h3>
              <button type="button" className="embed-primary-btn" disabled={busy} onClick={() => void runSandboxTest()}>
                <Play size={13} aria-hidden="true" /> Test Redaction
              </button>
            </div>
            <div className="pii-sandbox-inputs">
              <label>
                <span>Customer Prompt</span>
                <input value={samplePrompt} onChange={(e) => setSamplePrompt(e.target.value)} />
              </label>
              <label>
                <span>Customer 360 Context</span>
                <input value={sampleContext} onChange={(e) => setSampleContext(e.target.value)} />
              </label>
            </div>
            {testTrace && (
              <div className="pii-xray-grid" style={{ marginTop: "10px" }}>
                <div className="pii-xray-col">
                  <span className="pii-xray-label">Local View (Original)</span>
                  <pre>{testTrace.originalPrompt}</pre>
                  {testTrace.originalContextSummary && <pre className="pii-xray-ctx">{testTrace.originalContextSummary}</pre>}
                </div>
                <div className="pii-xray-col is-scrubbed">
                  <span className="pii-xray-label">
                    Exact Payload Sent to LLM ({testTrace.firewallEnabled ? `${testTrace.redactedCount} tokens scrubbed` : "Firewall OFF"})
                  </span>
                  <pre>{testTrace.scrubbedPrompt}</pre>
                  {testTrace.scrubbedContextSummary && <pre className="pii-xray-ctx">{testTrace.scrubbedContextSummary}</pre>}
                </div>
              </div>
            )}
          </div>

          {view.recentEvents.length > 0 && (
            <div className="pii-audit-section">
              <h3>Recent Turn Inspections ({view.recentEvents.length})</h3>
              <div className="pii-audit-list">
                {view.recentEvents.slice(0, 10).map((evt) => (
                  <div key={evt.id} className="pii-audit-row">
                    <span className={"pii-shield-badge " + (evt.firewallEnabled ? "is-on" : "is-off")}>
                      {evt.firewallEnabled ? `${evt.redactedCount} scrubbed` : "OFF"}
                    </span>
                    <strong>{evt.personaName ?? "User"}</strong>
                    <code>{evt.scrubbedPreview}</code>
                    <small>{new Date(evt.timestamp).toLocaleTimeString()}</small>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
