import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, Eye, Layers, Loader2, Lock, MinusCircle, ShieldAlert, ShieldCheck, Sparkles, UserCheck } from "lucide-react";
import {
  progressLabels, type ActionMode, type CustomerLookupSummary, type Progress, type ProviderArbitrationTrace, type SemanticRouteTrace, type TurnStatus,
} from "../../packages/contracts/api";
import type { PiiRedactionTrace } from "../../packages/contracts/pii-firewall";
import type { DisplayExperience } from "../../packages/contracts/surface";

const progressDetails: Record<Progress, string> = {
  accepted: "Validated request context and customer session.",
  planning: "Mapped intent against available advisory tools.",
  catalog: "Loaded active high-level intents and TS rule scopes.",
  routing: "Extracted customer intent using Customer 360 signals.",
  glossary: "Loaded CCRE rule glossary and eligibility attributes.",
  eligibility: "Ran Treatment Selector (TS) and CCRE eligibility rules.",
  portfolio: "Synchronized live portfolio balances and allocation.",
  goal: "Loaded savings milestones and target horizon.",
  workflow: "Staged funding preview workflow and options.",
  composition: "Synthesized structured interactive response.",
  verifying: "Verified disclosures, citations, and surface schema.",
};

const actionModeMeta: Record<ActionMode, { label: string; detail: string; tone: string }> = {
  plain_chat: {
    label: "Plain Chat",
    detail: "Identified as conversational reply — answered directly without heavy UI rendering.",
    tone: "mode-chat",
  },
  verified_experience: {
    label: "Verified Experience",
    detail: "Routed to governed Customer 360 lookup, eligibility rules, and verified A2UI surface.",
    tone: "mode-verified",
  },
  dynamic_ui: {
    label: "Dynamic UI Canvas",
    detail: "Stage 0 routed directly to live LLM composable canvas outside fixed templates.",
    tone: "mode-dynamic",
  },
  clarify: {
    label: "Clarification",
    detail: "Requested confirmation before invoking account tools or rendering a surface.",
    tone: "mode-clarify",
  },
};

const componentFriendlyNames: Record<string, string> = {
  PznContentCard: "Advisory Card",
  PznComparison: "Side-by-Side Comparison",
  PznStepList: "Step-by-Step Guide",
  PznMetricSummary: "Verified Balances",
  PznGoalProgress: "Goal Progress Chart",
  PznPortfolioSnapshot: "Portfolio Snapshot",
  PznFundingOptions: "Funding Options",
  PznFundingPreview: "Funding Preview",
  PznSavingsChart: "Savings Projection",
  PznSavingsMetric: "Required Contribution",
  PznCapabilityForm: "Interactive Simulator",
  PznFactSummary: "Verified Facts",
  PznDynamicCanvas: "Dynamic LLM Canvas",
};

function verifiedFactsFor(experience?: DisplayExperience): string[] {
  if (!experience) return [];
  const facts: string[] = [];
  if (experience.blocks.length > 0) {
    const names = [...new Set(experience.blocks.map((block) => componentFriendlyNames[block.component] ?? block.component))];
    facts.push(`Rendered ${experience.blocks.length} verified surface${experience.blocks.length === 1 ? "" : "s"} (${names.join(", ")}).`);
  }
  const sourceCount = experience.blocks.reduce((sum, block) => (
    "sources" in block.props && Array.isArray(block.props.sources) ? sum + block.props.sources.length : sum
  ), 0);
  if (sourceCount > 0) {
    facts.push(`Attached ${sourceCount} approved citation${sourceCount === 1 ? "" : "s"} and regulatory disclosures.`);
  }
  if (experience.actions.length > 0) {
    facts.push(`Prepared ${experience.actions.length} scoped follow-up action${experience.actions.length === 1 ? "" : "s"}.`);
  }
  return facts;
}

export function ReasoningPanel({ status, progress, history, experience, actionMode, semanticRoute, customerLookup, providerArbitration, piiRedaction }: {
  status: TurnStatus;
  progress: Progress;
  history: Progress[];
  experience?: DisplayExperience;
  actionMode?: ActionMode;
  semanticRoute?: SemanticRouteTrace;
  customerLookup?: CustomerLookupSummary;
  providerArbitration?: ProviderArbitrationTrace;
  piiRedaction?: PiiRedactionTrace;
}) {
  const [expanded, setExpanded] = useState(status === "working");
  const [xrayOpen, setXrayOpen] = useState(false);
  const isWorking = status === "working";
  const steps = history.length ? history : [progress];
  const open = isWorking ? true : expanded;
  const verifiedFacts = !isWorking ? verifiedFactsFor(experience) : [];
  const modeInfo = actionMode ? actionModeMeta[actionMode] : undefined;
  const totalChecks = steps.length + (verifiedFacts.length > 0 ? 1 : 0) + (customerLookup ? 1 : 0) + (providerArbitration ? 1 : 0) + (semanticRoute ? 1 : 0) + (piiRedaction ? 1 : 0);

  return (
    <div className={"reasoning-panel" + (isWorking ? " reasoning-panel-live" : "")}>
      <div className="reasoning-header-row">
        <button
          type="button"
          className="reasoning-toggle"
          aria-expanded={open}
          onClick={() => { if (!isWorking) setExpanded((value) => !value); }}
        >
          <span className="reasoning-toggle-title">
            <Sparkles size={14} aria-hidden="true" />
            <strong>Advisory Reasoning</strong>
            {modeInfo && !isWorking && (
              <span className={"action-mode-badge " + modeInfo.tone}>{modeInfo.label}</span>
            )}
            {piiRedaction && !isWorking && (
              <span className={"pii-shield-badge " + (piiRedaction.firewallEnabled ? "is-on" : "is-off")}>
                {piiRedaction.firewallEnabled
                  ? <><Lock size={11} aria-hidden="true" />PII Shield{piiRedaction.redactedCount > 0 ? ` · ${piiRedaction.redactedCount} scrubbed` : " · Clean"}</>
                  : <><ShieldAlert size={11} aria-hidden="true" />PII Firewall OFF</>}
              </span>
            )}
            <span className="reasoning-count">
              {isWorking
                ? `${progressLabels[progress]}…`
                : `${totalChecks} pre-flight ${totalChecks === 1 ? "check" : "checks"} completed`}
            </span>
          </span>
          {!isWorking && (open ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />)}
        </button>
        {piiRedaction && !isWorking && (
          <button
            type="button"
            className={"pii-xray-btn" + (xrayOpen ? " is-active" : "")}
            aria-pressed={xrayOpen}
            title="Inspect exact scrubbed bytes sent to LLM vs. local re-hydrated view"
            onClick={() => setXrayOpen((v) => !v)}
          >
            <Eye size={12} aria-hidden="true" />
            LLM X-Ray
          </button>
        )}
      </div>
      {xrayOpen && piiRedaction && !isWorking && (
        <div className="pii-xray-drawer" role="region" aria-label="LLM X-Ray PII Firewall Diff">
          <div className="pii-xray-head">
            <strong>
              {piiRedaction.firewallEnabled
                ? `Zero-Leakage PII Firewall ACTIVE — ${piiRedaction.redactedCount} token(s) scrubbed before LLM boundary`
                : "PII Firewall is currently OFF — Raw prompt & context passed to model (toggle ON in Admin → Logs → PII Firewall)"}
            </strong>
          </div>
          <div className="pii-xray-grid">
            <div className="pii-xray-col">
              <span className="pii-xray-label">Local View (User / Re-hydrated)</span>
              <pre>{piiRedaction.originalPrompt}</pre>
              {piiRedaction.originalContextSummary && (
                <pre className="pii-xray-ctx">{piiRedaction.originalContextSummary}</pre>
              )}
            </div>
            <div className="pii-xray-col is-scrubbed">
              <span className="pii-xray-label">Exact Payload Sent to LLM</span>
              <pre>{piiRedaction.scrubbedPrompt}</pre>
              {piiRedaction.scrubbedContextSummary && (
                <pre className="pii-xray-ctx">{piiRedaction.scrubbedContextSummary}</pre>
              )}
            </div>
          </div>
          {piiRedaction.tokens.length > 0 && (
            <div className="pii-xray-vault">
              <span>Local Token Vault:</span>
              {piiRedaction.tokens.map((t) => (
                <code key={t.token} title={`${t.category}: ${t.original}`}>
                  {t.token} &larr; {t.masked} ({t.category})
                </code>
              ))}
            </div>
          )}
        </div>
      )}
      {open && (
        <ul className="reasoning-steps" aria-live={isWorking ? "polite" : undefined}>
          {customerLookup && !isWorking && (
            <li className="reasoning-step-done">
              <UserCheck size={14} className="reasoning-check" aria-hidden="true" />
              <span className="reasoning-step-copy">
                <strong>1. Customer 360 Lookup · {customerLookup.personaName}</strong>
                <span>
                  {customerLookup.highlights.join(" · ")}
                  {customerLookup.nbaSelected ? ` · Arbitrated NBA: ${customerLookup.nbaSelected}` : ""}
                </span>
              </span>
            </li>
          )}
          {modeInfo && !isWorking && (
            <li className="reasoning-step-done">
              <Sparkles size={14} className="reasoning-check" aria-hidden="true" />
              <span className="reasoning-step-copy">
                <strong>
                  2. Unified Capability Router · {semanticRoute ? semanticRoute.capabilityLabel : modeInfo.label}
                  {semanticRoute && (
                    <> ({semanticRoute.method === "llm_semantic" ? "Semantic LLM" : "Fast-Path"} · {Math.round(semanticRoute.confidence * 100)}%)</>
                  )}
                </strong>
                <span>{semanticRoute ? semanticRoute.reasoning : modeInfo.detail}</span>
              </span>
            </li>
          )}
          {providerArbitration && !isWorking && (
            <li className="reasoning-step-done reasoning-step-arb">
              <Layers size={14} className="reasoning-check" aria-hidden="true" />
              <span className="reasoning-step-copy">
                <strong>
                  3. Recommendation Arbitration · <code>{providerArbitration.toolRef}</code> ({providerArbitration.domain})
                </strong>
                <span className="reasoning-arb-list">
                  {providerArbitration.providers.map((p) => (
                    <span key={p.providerId} className={"reasoning-arb-pill is-" + p.status}>
                      {p.status === "ok"
                        ? <CheckCircle2 size={11} aria-hidden="true" />
                        : <MinusCircle size={11} aria-hidden="true" />}
                      <b>{p.providerLabel}</b>
                      {p.status === "ok"
                        ? ` · ${p.candidateCount} eligible · ${p.elapsedMs}ms`
                        : ` · skipped`}
                    </span>
                  ))}
                </span>
              </span>
            </li>
          )}
          {steps.map((step, index) => {
            const active = isWorking && index === steps.length - 1;
            return (
              <li key={step + "-" + index} className={active ? "reasoning-step-active" : "reasoning-step-done"}>
                {active
                  ? <Loader2 size={14} className="reasoning-spinner" aria-hidden="true" />
                  : <CheckCircle2 size={14} className="reasoning-check" aria-hidden="true" />}
                <span className="reasoning-step-copy">
                  <strong>{progressLabels[step]}</strong>
                  <span>{progressDetails[step]}</span>
                </span>
              </li>
            );
          })}
          {verifiedFacts.map((fact, idx) => (
            <li key={"fact-" + idx} className="reasoning-step-done reasoning-step-verified">
              <ShieldCheck size={14} className="reasoning-check" aria-hidden="true" />
              <span className="reasoning-step-copy">
                <strong>Host Verification</strong>
                <span>{fact}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
