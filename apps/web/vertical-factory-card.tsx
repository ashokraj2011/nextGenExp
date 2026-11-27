import { useEffect, useState } from "react";
import { BookOpen, ExternalLink, GitBranch, Sparkles, Trash2, Wand2 } from "lucide-react";
import type { VerticalPackRecord } from "../../packages/contracts/vertical-pack";
import { api } from "./api";

const VERTICAL_PRESETS = [
  {
    label: "Healthcare Prior-Authorization Portal",
    prompt: "Spin up a Healthcare Prior-Authorization portal with CMS clinical policy rules, >$5,000 Medical Director HITL approval workflow, and live prior-auth case views",
  },
  {
    label: "Commercial Real Estate Underwriting",
    prompt: "Create a Commercial Real Estate Underwriting desk with DSCR & cap-rate policy rules, >$1,000,000 Investment Committee HITL term-sheet workflow, and live deal views",
  },
  {
    label: "Insurance Claims Concierge",
    prompt: "Build an Insurance Claims adjudication portal with policy coverage rules, >$2,500 senior adjuster HITL payout workflow, and live policyholder claim views",
  },
];

export function VerticalFactoryCard() {
  const [packs, setPacks] = useState<VerticalPackRecord[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    void api.verticalPacks().then((view) => {
      if (alive) setPacks(view.packs);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  async function generate(overridePrompt?: string) {
    const text = (overridePrompt ?? prompt).trim();
    if (text.length < 5) return;
    if (overridePrompt) setPrompt(overridePrompt);
    setBusy(true);
    setError("");
    try {
      await api.generateVerticalPack(text);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not generate vertical pack.");
    } finally {
      setBusy(false);
    }
  }

  async function removePack(id: string) {
    setError("");
    try {
      await api.deleteVerticalPack(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not request portal removal.");
    }
  }

  return (
    <section className="embed-card vertical-factory-card" aria-labelledby="vertical-factory-title">
      <div className="embed-omni-head">
        <div>
          <h2 id="vertical-factory-title">
            <Wand2 size={17} aria-hidden="true" />
            Industry portal builder
          </h2>
          <p className="embed-card-sub">
            Describe an industry to generate a portal, a policy reference, and a workflow. Review the draft in Admin chat before publishing.
          </p>
        </div>
      </div>

      <form
        className="vf-form"
        onSubmit={(e) => {
          e.preventDefault();
          void generate();
        }}
      >
        <input
          value={prompt}
          disabled={busy}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. Spin up a Healthcare Prior-Authorization portal with CMS policy rules and >$5k Medical Director HITL workflow..."
          aria-label="Prompt to generate new vertical pack"
        />
        <button type="submit" className="embed-primary-btn" disabled={busy || prompt.trim().length < 5}>
          <Sparkles size={14} aria-hidden="true" />
          {busy ? "Generating draft…" : "Generate draft for review"}
        </button>
      </form>

      <div className="vf-presets">
        <span>1-Click Verticals:</span>
        {VERTICAL_PRESETS.map((p) => (
          <button key={p.label} type="button" className="embed-tab" disabled={busy} onClick={() => void generate(p.prompt)}>
            {p.label}
          </button>
        ))}
      </div>

      {error && <p className="request-notice" role="alert">{error}</p>}

      {packs.length > 0 && (
        <div className="vf-pack-grid">
          {packs.map((pack) => (
            <div key={pack.id} className="vf-pack-card">
              <div className="vf-pack-top">
                <span className="vf-pack-swatch" style={{ background: pack.accentColor }} aria-hidden="true" />
                <div>
                  <strong>{pack.portalName}</strong>
                  <small>{pack.industry} · {pack.brandTitle}</small>
                </div>
                <button type="button" className="wf-icon-del" title="Remove vertical pack" onClick={() => void removePack(pack.id)}>
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </div>
              <div className="vf-pack-artifacts">
                <span><BookOpen size={12} aria-hidden="true" /> Policy RAG: <strong>{pack.policyTitle}</strong></span>
                <span><GitBranch size={12} aria-hidden="true" /> Workflow DAG: <strong>{pack.workflowName}</strong></span>
                <span><Sparkles size={12} aria-hidden="true" /> Ambient Screen Views: <strong>{pack.screenViews.length}</strong></span>
              </div>
              <div className="vf-pack-actions">
                <a
                  className="embed-primary-link"
                  href={`/embed-demo?vertical=${encodeURIComponent(pack.id)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={14} aria-hidden="true" />
                  Launch White-Label Portal
                </a>
                <a className="embed-secondary-link" href="/admin/intents">
                  Inspect DAG &amp; RAG
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
