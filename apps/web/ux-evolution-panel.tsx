import { useEffect, useState } from "react";
import { ArrowUpRight, BookOpen, CheckCircle2, Rocket, Sparkles, Wand2, X } from "lucide-react";
import type { UxEvolutionView } from "../../packages/contracts/ux-evolution";
import { api, isPublicationReview, toolSetupErrorMessage } from "./api";
import { LiveWidgetPreview } from "./widget-studio";

export function UxEvolutionPanel() {
  const [view, setView] = useState<UxEvolutionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void api.uxEvolution().then(setView).catch((err) => setError(toolSetupErrorMessage(err)));
  }, []);

  async function scan(includeSampleTraffic = false) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await api.scanUxEvolution(includeSampleTraffic);
      setView(res.view);
      setNotice(
        res.created.length > 0
          ? `Friction Scanner drafted ${res.created.length} new self-evolving UX proposal(s) ready for 1-click ship.`
          : "Scan complete — all detected unmet customer intents already have live widgets or pending proposals.",
      );
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function approve(id: string) {
    setBusyId(id);
    setError("");
    setNotice("");
    try {
      const res = await api.approveUxProposal(id);
      if (isPublicationReview(res)) return;
      setView(res.view);
      setNotice(
        `Shipped "${res.proposal.title}" LIVE! Widget (${res.proposal.shippedWidgetId}) is marked Available in Chat`
        + (res.proposal.shippedPolicyDocId ? ` and Policy RAG doc (${res.proposal.shippedPolicyDocId}) is indexed.` : "."),
      );
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function dismiss(id: string) {
    setBusyId(id);
    try {
      setView(await api.dismissUxProposal(id));
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  const visibleProposals = (view?.proposals ?? []).filter((p) => p.status !== "dismissed");

  return (
    <section className="admin-card uxe-panel" aria-labelledby="uxe-title">
      <div className="pii-admin-head">
        <div>
          <h2 id="uxe-title" style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <Wand2 size={19} aria-hidden="true" />
            Self-Evolving UX Agent (Autonomous Friction Detector)
          </h2>
          <p>
            Scans real customer conversations for <strong>Plain Chat misses</strong>, <strong>unhelpful feedback</strong>, and{" "}
            <strong>repeated unmet questions</strong> — then automatically drafts a live interactive Widget + Policy RAG guide ready for 1-click ship.
          </p>
        </div>
        <div className="pii-master-controls">
          <button type="button" className="embed-primary-btn" disabled={busy} onClick={() => void scan(false)}>
            <Sparkles size={14} aria-hidden="true" />
            {busy ? "Scanning & Drafting…" : "Scan Live Conversations"}
          </button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void scan(true)}>
            Simulate Unmet Traffic &amp; Scan
          </button>
        </div>
      </div>

      {notice && <div className="embed-notice" role="status">{notice}</div>}
      {error && <p className="request-notice" role="alert">{error}</p>}

      {view && (
        <div className="pii-kpi-row">
          <div className="pii-kpi-box">
            <span>Turns Scanned</span>
            <strong>{view.stats.scannedTurns}</strong>
          </div>
          <div className="pii-kpi-box">
            <span>Plain Chat Misses</span>
            <strong>{view.stats.plainChatMisses}</strong>
          </div>
          <div className="pii-kpi-box">
            <span>Pending Proposals</span>
            <strong>{view.stats.pendingCount}</strong>
          </div>
          <div className="pii-kpi-box">
            <span>Auto-Shipped Live</span>
            <strong className="is-ok">{view.stats.shippedCount}</strong>
          </div>
        </div>
      )}

      {visibleProposals.length === 0 ? (
        <div className="uxe-empty">
          <p>
            No UX evolution proposals queued yet. Click <strong>Scan Live Conversations</strong> to inspect real SQLite chat history
            (or <strong>Simulate Unmet Traffic &amp; Scan</strong> to see autonomous drafting in action).
          </p>
        </div>
      ) : (
        <div className="uxe-grid">
          {visibleProposals.map((prop) => (
            <article key={prop.id} className={"uxe-card" + (prop.status === "approved" ? " is-shipped" : "")}>
              <div className="uxe-card-top">
                <div className="uxe-badges">
                  <span className={"uxe-reason-pill is-" + prop.frictionReason}>
                    {prop.frictionReason.replace(/_/g, " ")} · {prop.occurrenceCount}x
                  </span>
                  <span className="uxe-gen-pill">
                    {prop.generatedBy === "copilot_llm" ? "Drafted by Copilot ACP" : "Drafted by UX Synthesizer"}
                  </span>
                </div>
                {prop.status === "approved" ? (
                  <span className="uxe-shipped-pill">
                    <CheckCircle2 size={13} aria-hidden="true" /> Shipped Live
                  </span>
                ) : (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Dismiss ${prop.title}`}
                    disabled={busyId === prop.id}
                    onClick={() => void dismiss(prop.id)}
                  >
                    <X size={15} aria-hidden="true" />
                  </button>
                )}
              </div>

              <h3>{prop.title}</h3>
              <p className="uxe-summary">{prop.summary}</p>

              <div className="uxe-prompts">
                <span>Detected customer prompt(s):</span>
                {prop.samplePrompts.map((sp) => <code key={sp}>&ldquo;{sp}&rdquo;</code>)}
              </div>

              <div className="uxe-preview-wrap">
                <LiveWidgetPreview widget={prop.widgetDraft} compact />
              </div>

              {prop.policyDraft && (
                <div className="uxe-policy-note">
                  <BookOpen size={13} aria-hidden="true" />
                  <span>Also indexes Policy RAG: <strong>{prop.policyDraft.title}</strong> ({prop.policyDraft.category})</span>
                </div>
              )}

              {prop.regression && <p>Evaluation checks “{prop.regression.prompt}” against the published card.</p>}
              <div className="uxe-card-foot">
                {prop.status === "pending" ? (
                  <button
                    type="button"
                    className="embed-primary-btn"
                    disabled={busyId === prop.id}
                    onClick={() => void approve(prop.id)}
                  >
                    <Rocket size={14} aria-hidden="true" />
                    {busyId === prop.id ? "Shipping…" : "Approve & Ship Live to Chat"}
                  </button>
                ) : (
                  <a className="embed-primary-link" href="/wealth">
                    Test Live in Wealth Chat <ArrowUpRight size={14} aria-hidden="true" />
                  </a>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
