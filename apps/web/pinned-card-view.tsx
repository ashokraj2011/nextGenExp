import { useEffect, useState } from "react";
import { ArrowLeft, ArrowUpRight, Pin, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import type { PinnedLiveCard } from "../../packages/contracts/pinned-cards";
import { ExperienceCanvasView } from "./surface";
import "./immersive-ux.css";

function formatAge(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ts));
}

export function PinnedCardWorkspaceView({
  card,
  refreshing,
  onRefresh,
  onUnpin,
  onOpenInChat,
  onBack,
}: {
  card: PinnedLiveCard;
  refreshing: boolean;
  onRefresh: () => void;
  onUnpin: () => void;
  onOpenInChat: (prompt: string) => void;
  onBack: () => void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  return (
    <section className="pinned-live-stage" aria-label={`Pinned live card: ${card.title}`}>
      <header className="pinned-live-header">
        <div className="pinned-live-title-group">
          <button type="button" className="secondary-button" onClick={onBack}>
            <ArrowLeft size={14} aria-hidden="true" />
            Back
          </button>
          <div>
            <div className="pinned-live-kicker">
              <span className="living-sync-dot" aria-hidden="true" />
              <span>{card.liveBacked ? "LIVE PINNED CARD" : "PINNED CARD"}</span>
              <span>· Updated {formatAge(card.refreshedAt)}</span>
            </div>
            <h2>{card.title}</h2>
          </div>
        </div>
        <div className="pinned-live-actions">
          <button type="button" className="secondary-button" disabled={refreshing} onClick={onRefresh}>
            <RefreshCw size={14} className={refreshing ? "is-spinning" : ""} aria-hidden="true" />
            {refreshing ? "Syncing live…" : "Refresh live"}
          </button>
          <button type="button" className="secondary-button" onClick={() => onOpenInChat(card.prompt)}>
            Continue in chat <ArrowUpRight size={14} aria-hidden="true" />
          </button>
          <button type="button" className="secondary-button" onClick={onUnpin} aria-label={`Unpin ${card.title}`}>
            <Trash2 size={14} aria-hidden="true" />
            Unpin
          </button>
        </div>
      </header>

      {card.toolRefs.length > 0 && (
        <div className="pinned-live-provenance">
          <ShieldCheck size={14} aria-hidden="true" />
          <span>
            Live data synced via <code>sfield</code>:{" "}
            {card.toolRefs.map((ref) => <code key={ref} style={{ marginRight: "6px" }}>{ref}</code>)}
          </span>
        </div>
      )}

      <div className="pinned-live-body">
        <ExperienceCanvasView data={card.experience} />
      </div>
    </section>
  );
}

export function HomePinnedCardsGrid({
  cards,
  onOpenCard,
  onRefreshCard,
  onUnpinCard,
}: {
  cards: PinnedLiveCard[];
  onOpenCard: (card: PinnedLiveCard) => void;
  onRefreshCard: (card: PinnedLiveCard) => void;
  onUnpinCard: (card: PinnedLiveCard) => void;
}) {
  if (!cards.length) return null;
  return (
    <section className="home-pinned-section" aria-label="Pinned live cards">
      <div className="home-pinned-head">
        <h3><Pin size={15} aria-hidden="true" /> Pinned live cards ({cards.length})</h3>
        <span>Clipped from chat · synced live from <code>sfield</code></span>
      </div>
      <div className="home-pinned-grid">
        {cards.map((card) => (
          <article key={card.id} className="content-card home-pinned-card">
            <header className="home-pinned-card-head">
              <div>
                <span className="pinned-live-kicker">
                  <span className="living-sync-dot" aria-hidden="true" />
                  {card.liveBacked ? "Live" : "Pinned"} · {formatAge(card.refreshedAt)}
                </span>
                <h4>{card.title}</h4>
              </div>
              <div style={{ display: "inline-flex", gap: "6px" }}>
                <button type="button" className="icon-button" title="Refresh live data" aria-label={`Refresh ${card.title}`} onClick={() => onRefreshCard(card)}>
                  <RefreshCw size={14} aria-hidden="true" />
                </button>
                <button type="button" className="icon-button" title="Open full live card" aria-label={`Open ${card.title}`} onClick={() => onOpenCard(card)}>
                  <ArrowUpRight size={15} aria-hidden="true" />
                </button>
                <button type="button" className="icon-button" title="Unpin from menu" aria-label={`Unpin ${card.title}`} onClick={() => onUnpinCard(card)}>
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </div>
            </header>
            <div className="home-pinned-card-preview">
              <ExperienceCanvasView data={card.experience} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
