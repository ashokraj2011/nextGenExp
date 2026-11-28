import { useEffect, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import type { Progress } from "../../packages/contracts/api";
import { RichText } from "./markdown";
import "./immersive-ux.css";

const pillCopy: Record<Progress, { done: string; active: string }> = {
  accepted: { done: "Request received", active: "Preparing request…" },
  planning: { done: "Plan ready", active: "Planning steps…" },
  catalog: { done: "Catalog loaded", active: "Checking topics…" },
  routing: { done: "Topic matched", active: "Matching topic…" },
  glossary: { done: "Rules loaded", active: "Loading rules…" },
  eligibility: { done: "Eligibility checked", active: "Checking eligibility…" },
  retirementAccounts: { done: "Accounts synced", active: "Syncing retirement accounts…" },
  portfolio: { done: "Portfolio synced", active: "Syncing portfolio…" },
  goal: { done: "Goal verified", active: "Verifying home goal…" },
  composition: { done: "Surface compiled", active: "Composing verified card…" },
  verifying: { done: "Policy verified", active: "Verifying policy & schemas…" },
  workflow: { done: "Workflow ready", active: "Running sfield workflow…" },
};

/**
 * Replaces generic loading spinners with live sfield grounding pills
 * (✓ Topic matched, ✓ Portfolio synced, ✓ Eligibility checked, ✓ Policy verified).
 */
export function LiveGroundingBar({
  steps,
  working,
  hasPreview,
}: {
  steps: Progress[];
  working: boolean;
  hasPreview?: boolean;
}) {
  const uniqueSteps = steps.filter((step, idx) => steps.indexOf(step) === idx);
  if (!uniqueSteps.length) return null;

  return (
    <div className={"live-grounding-bar" + (working ? " is-working" : " is-done")} role="status" aria-live="polite">
      <div className="live-grounding-pills">
        {uniqueSteps.map((step, idx) => {
          const isCurrent = working && idx === uniqueSteps.length - 1;
          const copy = pillCopy[step] ?? { done: step, active: `${step}…` };
          return (
            <span key={step} className={"grounding-pill" + (isCurrent ? " is-active" : " is-complete")}>
              {isCurrent ? (
                <Loader2 size={11} className="is-spinning" aria-hidden="true" />
              ) : (
                <CheckCircle2 size={11} aria-hidden="true" />
              )}
              <span>{isCurrent ? copy.active : copy.done}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Streams live assistant intro text token-by-token so replies feel immediate (~200ms),
 * while rendering historical turns or reduced-motion sessions instantaneously.
 */
export function StreamingRichText({
  text,
  live,
  className,
}: {
  text: string;
  live: boolean;
  className?: string;
}) {
  const [visibleCount, setVisibleCount] = useState(() => {
    if (!live) return Number.MAX_SAFE_INTEGER;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return Number.MAX_SAFE_INTEGER;
    }
    return Math.min(text.length, 16);
  });

  useEffect(() => {
    if (!live || visibleCount >= text.length) return;
    const timer = window.setInterval(() => {
      setVisibleCount((curr) => {
        if (curr >= text.length) {
          window.clearInterval(timer);
          return text.length;
        }
        // Advance to next word boundary (or ~14 chars) for smooth natural cadence
        const nextSpace = text.indexOf(" ", curr + 8);
        return nextSpace === -1 ? text.length : nextSpace + 1;
      });
    }, 24);
    return () => window.clearInterval(timer);
  }, [live, text, visibleCount]);

  const shown = !live || visibleCount >= text.length ? text : text.slice(0, visibleCount);
  const stillStreaming = live && visibleCount < text.length;
  return (
    <div className={stillStreaming ? "streaming-text-wrap is-streaming" : "streaming-text-wrap"}>
      <RichText text={shown} className={className} />
    </div>
  );
}
