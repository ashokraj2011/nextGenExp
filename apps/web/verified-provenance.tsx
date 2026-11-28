import { useId, useState } from "react";
import { ArrowUpRight, ShieldCheck, SlidersHorizontal } from "lucide-react";
import "./immersive-ux.css";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/**
 * Hover-or-click provenance pill showing the exact sfield tool contract backing
 * a rendered sphoton card — making zero-hallucination verification visible to users.
 */
export function VerifiedProvenanceBadge({
  toolRef,
  label = "Verified",
  observedAt,
  domain,
}: {
  toolRef: string;
  label?: string;
  observedAt?: string;
  domain?: string;
}) {
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const formattedTime = observedAt
    ? (() => {
        const d = new Date(observedAt);
        return Number.isNaN(d.getTime())
          ? observedAt
          : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(d);
      })()
    : undefined;

  return (
    <span
      className="verified-prov-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="verified-prov-pill"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
        title={`Verified live via ${toolRef}`}
      >
        <ShieldCheck size={12} aria-hidden="true" />
        <span>{label}</span>
      </button>
      {open && (
        <span id={popoverId} className="verified-prov-popover" role="tooltip">
          <span className="verified-prov-popover-head">
            <ShieldCheck size={13} aria-hidden="true" />
            Verified via sfield + sphoton
          </span>
          <span>
            Source tool: <code>{toolRef}</code>
          </span>
          <p>
            Bound directly from closed-schema tool output into this UI surface — zero LLM-generated numbers.
          </p>
          <span className="verified-prov-meta">
            <span>{domain ? `Domain: ${domain}` : "Closed JSON Schema"}</span>
            {formattedTime && <span>{formattedTime}</span>}
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * Tactile "What-If" Discount Scrubber embedded directly on Sales RevOps deal cards.
 * Lets deal desk operators drag 0%..35% to inspect live Net ARR & Approval Tier flips
 * before dispatching a governed discount preview turn.
 */
export function DealDiscountScrubber({
  baseArrUsd,
  initialDiscountPct,
  dealId,
  onApply,
}: {
  baseArrUsd: number;
  initialDiscountPct: number;
  dealId?: string;
  onApply?: (prompt: string) => void;
}) {
  const sliderId = useId();
  const [discountPct, setDiscountPct] = useState(() => Math.max(0, Math.min(35, Math.round(initialDiscountPct))));
  const netArr = Math.round(baseArrUsd * (1 - discountPct / 100));
  const concession = Math.max(0, Math.round(baseArrUsd - netArr));
  const needsVpFinance = discountPct > 20;

  return (
    <div className="deal-scrubber" role="region" aria-label="Interactive discount what-if simulator">
      <div className="deal-scrubber-head">
        <strong>
          <SlidersHorizontal size={13} aria-hidden="true" />
          Live Discount What-If Scrubber
        </strong>
        <span className={"deal-tier-pill " + (needsVpFinance ? "is-vp" : "is-desk")}>
          {needsVpFinance ? "Approval Tier: VP Finance (>20%)" : "Approval Tier: Deal Desk (≤20%)"}
        </span>
      </div>
      <div className="goal-sim-field">
        <div className="goal-sim-field-head">
          <label htmlFor={sliderId}>Discount percentage</label>
          <output htmlFor={sliderId}>{discountPct}%</output>
        </div>
        <input
          id={sliderId}
          type="range"
          min={0}
          max={35}
          step={1}
          value={discountPct}
          onChange={(e) => setDiscountPct(Number(e.target.value))}
        />
        <div className="goal-sim-bounds" aria-hidden="true">
          <span>0% (List)</span>
          <span>20% (VP threshold)</span>
          <span>35%</span>
        </div>
      </div>
      <div className="deal-scrubber-grid">
        <div className="goal-sim-metrics">
          <div>
            <span>Projected Net ARR</span>
            <strong>{usd.format(netArr)}</strong>
          </div>
          <div>
            <span>Discount Concession</span>
            <strong>−{usd.format(concession)}</strong>
          </div>
        </div>
        {onApply && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => onApply(
              `Model a ${discountPct}% discount scenario${dealId ? ` for ${dealId}` : ""} and check the required approval tier.`,
            )}
          >
            Preview {discountPct}% in chat <ArrowUpRight size={13} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
