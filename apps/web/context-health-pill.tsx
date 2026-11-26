import { useCallback, useEffect, useRef, useState } from "react";
import { Cpu, Layers, Minimize2, RefreshCw, Sparkles } from "lucide-react";
import { api } from "./api";

type ContextSnapshot = Awaited<ReturnType<typeof api.conversationContext>>;

export function ContextHealthPill({
  conversationId,
  turnCount,
  disabled,
}: {
  conversationId?: string;
  turnCount: number;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<ContextSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!conversationId) {
      setCtx(null);
      return;
    }
    setLoading(true);
    try {
      const snap = await api.conversationContext(conversationId);
      setCtx(snap);
    } catch {
      // keep prior snapshot
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    setFeedback("");
    void load();
  }, [load, turnCount]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!conversationId) return null;

  const pct = ctx?.utilizationPct ?? 0;
  const tone = pct >= 75 ? "high" : pct >= 40 ? "mid" : "low";
  const hasSummary = Boolean(ctx?.rollingSummary);

  async function handleCompact() {
    if (!conversationId || compacting) return;
    setCompacting(true);
    setFeedback("");
    try {
      const res = await api.compactConversation(conversationId);
      setCtx(res.context);
      setFeedback(res.reason);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Compaction failed.");
    } finally {
      setCompacting(false);
    }
  }

  return (
    <div className="context-health-wrap" ref={rootRef}>
      <button
        type="button"
        className={`context-health-pill is-${tone}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        title="sfield context window health & compaction"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void load();
        }}
      >
        <span className="context-health-dot" aria-hidden="true" />
        <Cpu size={13} aria-hidden="true" />
        <span>Context {ctx ? `${pct}%` : "…"}</span>
        {hasSummary && <span className="context-health-badge" title="Rolling summary active">S</span>}
      </button>

      {open && (
        <div className="context-health-popover" role="dialog" aria-label="sfield Context Health">
          <div className="context-health-pop-head">
            <div>
              <strong><Layers size={14} aria-hidden="true" /> sfield Context &amp; Compaction</strong>
              <small>Summary → Preferences → Facts → History</small>
            </div>
            <button type="button" className="icon-button" aria-label="Refresh context health" disabled={loading} onClick={() => void load()}>
              <RefreshCw size={13} aria-hidden="true" />
            </button>
          </div>

          <div className="context-health-meter">
            <div className="context-health-meter-row">
              <span>Estimated window usage</span>
              <strong>
                {ctx ? `${ctx.estimatedContextTokens.toLocaleString()} / ${ctx.tokenBudget.toLocaleString()} tok (${pct}%)` : "Loading…"}
              </strong>
            </div>
            <div className="context-health-track" aria-hidden="true">
              <span className={`is-${tone}`} style={{ width: `${Math.max(4, pct)}%` }} />
            </div>
          </div>

          {ctx && (
            <dl className="context-health-stats">
              <div><dt>Completed turns</dt><dd>{ctx.completedTurnCount}</dd></div>
              <div><dt>Memory items</dt><dd>{ctx.memoryCount}</dd></div>
              <div><dt>Rolling summary</dt><dd>{ctx.rollingSummary ? `Through turn ${ctx.rollingSummary.coveredThroughOrdinal}` : "None yet"}</dd></div>
            </dl>
          )}

          {ctx?.rollingSummary && (
            <div className="context-health-summary">
              <span><Sparkles size={12} aria-hidden="true" /> Active Rolling Summary ({ctx.rollingSummary.method})</span>
              <p>{ctx.rollingSummaryText || ctx.rollingSummary.activeGoal}</p>
            </div>
          )}

          {ctx?.pendingClarification && (
            <div className="context-health-clarify">
              <span>Pending clarification</span>
              <p>{ctx.pendingClarification.question}</p>
            </div>
          )}

          <div className="context-health-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={compacting || !ctx || ctx.completedTurnCount < 3}
              onClick={() => void handleCompact()}
            >
              <Minimize2 size={13} aria-hidden="true" />
              {compacting ? "Compacting…" : "Compact now"}
            </button>
            <span className="context-health-note">
              {feedback || (ctx && ctx.completedTurnCount < 3 ? "Compacts automatically after 5 turns (manual at 3+)." : "Compresses older turns into sfield.memory.")}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
