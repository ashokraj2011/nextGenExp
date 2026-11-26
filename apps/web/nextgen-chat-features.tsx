import { useEffect, useMemo, useState } from "react";
import {
  Activity, Bell, Bot, CheckCircle2, Eye, GitCompare, KeyRound, Layers,
  Play, Plus, Radio, ShieldAlert, ShieldCheck, Sliders, Sparkles, Terminal, Trash2, X, Zap,
} from "lucide-react";
import type { DemoPersona, TurnView } from "../../packages/contracts/api";
import type { CoBrowseSliders, HandoffTicket } from "../../packages/contracts/handoff";
import type {
  AgentDelegationView,
  DelegationScope,
  ExpertiseMode,
  Watchcard,
  WatchcardMetric,
} from "../../packages/contracts/nextgen-chat";
import { api, toolSetupErrorMessage } from "./api";
import "./nextgen-chat-features.css";

/* ============================================================================
 * Deterministic financial projection helper (used by #1 Co-Browse & #2 Parallel Futures)
 * ========================================================================== */

export function projectFutureValue(startingUsd: number, monthlyUsd: number, months: number, annualReturnPct: number): number {
  const r = annualReturnPct / 100 / 12;
  if (r <= 0) return Math.round(startingUsd + monthlyUsd * months);
  const growth = Math.pow(1 + r, months);
  return Math.round(startingUsd * growth + monthlyUsd * ((growth - 1) / r));
}

const fmtUsd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/* ============================================================================
 * #1 Multiplayer "Live Glass" Advisor Co-Browsing Canvas
 * ========================================================================== */

export function MultiplayerCoBrowseCard({
  ticket,
  role,
  startingBalanceUsd = 42_000,
  onTicketUpdated,
}: {
  ticket: HandoffTicket;
  role: "advisor" | "customer";
  startingBalanceUsd?: number;
  onTicketUpdated: (ticket: HandoffTicket) => void;
}) {
  const sliders: CoBrowseSliders = ticket.coBrowse?.sliders ?? {
    monthlyContributionUsd: 1500,
    horizonMonths: 24,
    expectedReturnPct: 6.5,
    equityAllocationPct: 65,
  };
  const [local, setLocal] = useState<CoBrowseSliders>(sliders);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [proposalTitle, setProposalTitle] = useState("Update Home Savings Target & Allocation");
  const [proposalTarget, setProposalTarget] = useState("115000");

  useEffect(() => {
    if (ticket.coBrowse?.sliders) setLocal(ticket.coBrowse.sliders);
  }, [ticket.coBrowse?.updatedAt]);

  const projected = projectFutureValue(startingBalanceUsd, local.monthlyContributionUsd, local.horizonMonths, local.expectedReturnPct);

  async function syncSlider(patch: Partial<CoBrowseSliders>) {
    const next = { ...local, ...patch };
    setLocal(next);
    setError("");
    try {
      const res = await api.updateHandoffCoBrowse(ticket.handoffId, { updatedBy: role, active: true, sliders: next });
      onTicketUpdated(res.ticket);
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    }
  }

  async function pushProposal() {
    setBusy(true);
    setError("");
    try {
      const res = await api.pushAdvisorProposal({
        handoffId: ticket.handoffId,
        title: proposalTitle,
        summary: `Set monthly contribution plan to ${fmtUsd(local.monthlyContributionUsd)}/mo for ${local.horizonMonths} mo (${local.equityAllocationPct}% equities, projected ${fmtUsd(projected)}) and update goal target to ${fmtUsd(Number(proposalTarget) || 100_000)}.`,
        actionLabel: "Review & Sign Proposal",
        updates: { "goal.target": String(Math.max(1000, Number(proposalTarget) || 100_000)) },
      });
      onTicketUpdated(res.ticket);
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function decideProposal(decision: "accepted" | "declined") {
    setBusy(true);
    setError("");
    try {
      const res = await api.decideAdvisorProposal(ticket.handoffId, decision);
      onTicketUpdated(res.ticket);
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const proposal = ticket.coBrowse?.proposal;

  return (
    <div className="cobrowse-glass" aria-label="Multiplayer Live Glass Co-Browse">
      <div className="cobrowse-head">
        <span className="cobrowse-live-pill">
          <Radio size={11} aria-hidden="true" />
          LIVE GLASS CO-BROWSE · {role === "advisor" ? "ADVISOR CONTROL" : "SHARED WITH SPECIALIST"}
        </span>
        <small>
          {ticket.coBrowse?.updatedBy
            ? `Last moved by ${ticket.coBrowse.updatedBy === "advisor" ? (ticket.assignedAgent ?? "Advisor") : ticket.customerName}`
            : "Move any slider — updates both screens live"}
        </small>
      </div>

      <div className="cobrowse-projection">
        <div>
          <span>Projected Shared Balance ({local.horizonMonths} mo)</span>
          <strong>{fmtUsd(projected)}</strong>
        </div>
        <div className="cobrowse-mix-bar" aria-label="Equity vs Fixed Income mix">
          <span className="is-eq" style={{ width: `${local.equityAllocationPct}%` }} />
          <span className="is-fi" style={{ width: `${100 - local.equityAllocationPct}%` }} />
        </div>
        <small>{local.equityAllocationPct}% Equities · {100 - local.equityAllocationPct}% Fixed Income &amp; Cash · {local.expectedReturnPct}% est. return</small>
      </div>

      <div className="cobrowse-sliders">
        <label>
          <span>Monthly Deposit: <strong>{fmtUsd(local.monthlyContributionUsd)}/mo</strong></span>
          <input
            type="range"
            min={200}
            max={6000}
            step={100}
            value={local.monthlyContributionUsd}
            onChange={(e) => void syncSlider({ monthlyContributionUsd: Number(e.target.value) })}
          />
        </label>
        <label>
          <span>Horizon: <strong>{local.horizonMonths} months</strong></span>
          <input
            type="range"
            min={12}
            max={120}
            step={6}
            value={local.horizonMonths}
            onChange={(e) => void syncSlider({ horizonMonths: Number(e.target.value) })}
          />
        </label>
        <label>
          <span>Equity Allocation: <strong>{local.equityAllocationPct}%</strong></span>
          <input
            type="range"
            min={10}
            max={95}
            step={5}
            value={local.equityAllocationPct}
            onChange={(e) => void syncSlider({ equityAllocationPct: Number(e.target.value) })}
          />
        </label>
        <label>
          <span>Expected Return: <strong>{local.expectedReturnPct.toFixed(1)}%</strong></span>
          <input
            type="range"
            min={2}
            max={12}
            step={0.5}
            value={local.expectedReturnPct}
            onChange={(e) => void syncSlider({ expectedReturnPct: Number(e.target.value) })}
          />
        </label>
      </div>

      {role === "advisor" && (
        <div className="cobrowse-advisor-push">
          <div className="cobrowse-push-fields">
            <input aria-label="Proposal title" value={proposalTitle} onChange={(e) => setProposalTitle(e.target.value)} />
            <input aria-label="Goal target USD" type="number" min={5000} step={1000} value={proposalTarget} onChange={(e) => setProposalTarget(e.target.value)} />
          </div>
          <button type="button" className="rich-btn-primary" disabled={busy} onClick={() => void pushProposal()}>
            <Sparkles size={13} aria-hidden="true" />Push Advisor-Proposed Card to Customer
          </button>
        </div>
      )}

      {proposal && (
        <div className={"cobrowse-proposal is-" + proposal.status} role="region" aria-label="Advisor-Proposed Action Card">
          <div className="cobrowse-proposal-head">
            <span className="advisor-provenance-badge">
              <ShieldCheck size={11} aria-hidden="true" /> Advisor-Proposed · {proposal.proposedBy}
            </span>
            <span className={"handoff-status-pill is-" + (proposal.status === "accepted" ? "resolved" : "queued")}>
              {proposal.status}
            </span>
          </div>
          <h4>{proposal.title}</h4>
          <p>{proposal.summary}</p>
          {Object.keys(proposal.updates).length > 0 && (
            <div className="live-handoff-snapshot">
              {Object.entries(proposal.updates).map(([k, v]) => (
                <span key={k}><code>{k}</code> → <strong>{v}</strong></span>
              ))}
            </div>
          )}
          {proposal.status === "pending" && role === "customer" && (
            <div className="cobrowse-proposal-actions">
              <button type="button" className="rich-btn-primary" disabled={busy} onClick={() => void decideProposal("accepted")}>
                <CheckCircle2 size={13} aria-hidden="true" />{proposal.actionLabel}
              </button>
              <button type="button" className="rich-action-chip" disabled={busy} onClick={() => void decideProposal("declined")}>
                Decline
              </button>
            </div>
          )}
          {proposal.status === "accepted" && (
            <small className="cobrowse-signed-note">
              <CheckCircle2 size={12} aria-hidden="true" /> Signed &amp; recorded in governed sfield audit{proposal.auditId ? ` (${proposal.auditId})` : ""}.
            </small>
          )}
        </div>
      )}

      {error && <p className="rich-error" role="alert">{error}</p>}
    </div>
  );
}

/* ============================================================================
 * #2 Counterfactual "Parallel Futures" Simulator + 1-Click Governed Commit
 * ========================================================================== */

type ScenarioState = {
  name: string;
  monthlyDepositUsd: number;
  horizonMonths: number;
  expectedReturnPct: number;
  equityAllocationPct: number;
  targetGoalUsd: number;
};

export function ParallelFuturesPane({
  persona,
  onClose,
  onCommitted,
}: {
  persona?: DemoPersona;
  onClose: () => void;
  onCommitted?: (summary: string) => void;
}) {
  const startingUsd = useMemo(() => {
    const p = persona?.overview?.portfolio;
    if (!p) return 45_000;
    return Math.round((p.cashCents + p.equityCents + p.fixedIncomeCents) / 100);
  }, [persona]);
  const defaultTarget = useMemo(() => {
    const t = persona?.overview?.homeGoal?.targetCents;
    return t ? Math.round(t / 100) : 100_000;
  }, [persona]);

  const [a, setA] = useState<ScenarioState>({
    name: "Scenario A · Steady Cash Sweep",
    monthlyDepositUsd: 1200,
    horizonMonths: 24,
    expectedReturnPct: 4.5,
    equityAllocationPct: 35,
    targetGoalUsd: defaultTarget,
  });
  const [b, setB] = useState<ScenarioState>({
    name: "Scenario B · Accelerated Growth",
    monthlyDepositUsd: 2100,
    horizonMonths: 24,
    expectedReturnPct: 7.5,
    equityAllocationPct: 75,
    targetGoalUsd: defaultTarget,
  });
  const [committing, setCommitting] = useState<"A" | "B" | null>(null);
  const [receipt, setReceipt] = useState<{ scenario: string; approvalId: string; auditId: string; digest: string } | null>(null);
  const [error, setError] = useState("");

  const endA = projectFutureValue(startingUsd, a.monthlyDepositUsd, a.horizonMonths, a.expectedReturnPct);
  const endB = projectFutureValue(startingUsd, b.monthlyDepositUsd, b.horizonMonths, b.expectedReturnPct);
  const delta = endB - endA;

  async function commit(which: "A" | "B", s: ScenarioState, projectedEndingUsd: number) {
    setCommitting(which);
    setError("");
    try {
      const res = await api.commitParallelScenario({
        scenarioName: s.name,
        personaId: persona?.personaId ?? "demo-learner",
        monthlyDepositUsd: s.monthlyDepositUsd,
        horizonMonths: s.horizonMonths,
        expectedReturnPct: s.expectedReturnPct,
        equityAllocationPct: s.equityAllocationPct,
        targetGoalUsd: s.targetGoalUsd,
        projectedEndingUsd,
      });
      setReceipt({ scenario: s.name, approvalId: res.approvalId, auditId: res.auditId, digest: res.payloadDigest });
      onCommitted?.(res.summary);
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setCommitting(null);
    }
  }

  const renderCol = (label: "A" | "B", s: ScenarioState, setS: (next: ScenarioState) => void, endUsd: number) => {
    const gap = endUsd - s.targetGoalUsd;
    const pct = Math.min(100, Math.round((endUsd / Math.max(1, s.targetGoalUsd)) * 100));
    return (
      <div className={"futures-col is-" + label.toLowerCase()}>
        <div className="futures-col-head">
          <strong>{s.name}</strong>
          <span className={"futures-gap-pill " + (gap >= 0 ? "is-surplus" : "is-gap")}>
            {gap >= 0 ? `+${fmtUsd(gap)} over target` : `${fmtUsd(Math.abs(gap))} short`}
          </span>
        </div>
        <div className="futures-big-num">
          <span>Projected Value</span>
          <strong>{fmtUsd(endUsd)}</strong>
          <div className="futures-bar"><span style={{ width: `${pct}%` }} /></div>
          <small>{pct}% of {fmtUsd(s.targetGoalUsd)} goal (from {fmtUsd(startingUsd)} today)</small>
        </div>
        <div className="futures-sliders">
          <label>
            <span>Monthly Deposit: <b>{fmtUsd(s.monthlyDepositUsd)}</b></span>
            <input type="range" min={200} max={6000} step={100} value={s.monthlyDepositUsd} onChange={(e) => setS({ ...s, monthlyDepositUsd: Number(e.target.value) })} />
          </label>
          <label>
            <span>Timeline: <b>{s.horizonMonths} mo</b></span>
            <input type="range" min={12} max={120} step={6} value={s.horizonMonths} onChange={(e) => setS({ ...s, horizonMonths: Number(e.target.value) })} />
          </label>
          <label>
            <span>Est. Return: <b>{s.expectedReturnPct.toFixed(1)}%</b></span>
            <input type="range" min={2} max={12} step={0.5} value={s.expectedReturnPct} onChange={(e) => setS({ ...s, expectedReturnPct: Number(e.target.value) })} />
          </label>
          <label>
            <span>Equity Mix: <b>{s.equityAllocationPct}%</b></span>
            <input type="range" min={10} max={95} step={5} value={s.equityAllocationPct} onChange={(e) => setS({ ...s, equityAllocationPct: Number(e.target.value) })} />
          </label>
        </div>
        <button type="button" className="rich-btn-primary" disabled={committing !== null} onClick={() => void commit(label, s, endUsd)}>
          <Zap size={13} aria-hidden="true" />{committing === label ? "Committing…" : `Commit Scenario ${label}`}
        </button>
      </div>
    );
  };

  return (
    <aside className="live-canvas-pane futures-pane" aria-label="Parallel Futures Counterfactual Simulator">
      <header className="live-canvas-head">
        <div className="live-canvas-title">
          <span className="rich-kicker"><GitCompare size={12} aria-hidden="true" /> PARALLEL FUTURES SIMULATOR</span>
          <strong>Compare two live scenarios &amp; commit atomically</strong>
        </div>
        <button type="button" className="icon-button" aria-label="Close Parallel Futures" onClick={onClose}>
          <X size={17} aria-hidden="true" />
        </button>
      </header>
      <div className="live-canvas-body">
        <div className="futures-delta-banner">
          <Sparkles size={14} aria-hidden="true" />
          <span>
            Scenario B finishes <strong>{delta >= 0 ? `${fmtUsd(delta)} ahead` : `${fmtUsd(Math.abs(delta))} behind`}</strong> Scenario A with deterministic compound math.
          </span>
        </div>
        <div className="futures-grid">
          {renderCol("A", a, setA, endA)}
          {renderCol("B", b, setB, endB)}
        </div>
        {error && <p className="rich-error" role="alert" style={{ marginTop: 12 }}>{error}</p>}
        {receipt && (
          <div className="futures-receipt" role="status">
            <CheckCircle2 size={15} aria-hidden="true" />
            <div>
              <strong>Committed {receipt.scenario}</strong>
              <small>Approval <code>{receipt.approvalId}</code> · Audit <code>{receipt.auditId}</code> · sha256:<code>{receipt.digest.slice(0, 12)}</code></small>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

/* ============================================================================
 * #3 "Living Threads" — Autonomous Watchcards
 * ========================================================================== */

const WATCH_PRESETS: Array<{ label: string; title: string; metric: WatchcardMetric; operator: "gte" | "lte"; thresholdUsd: number; actionSummary: string }> = [
  {
    label: "Cash >= $25k -> High-Yield Sweep",
    title: "High-Yield Cash Sweep Sentinel",
    metric: "cash_balance",
    operator: "gte",
    thresholdUsd: 25_000,
    actionSummary: "Stage a $5,000 sweep into Money Market Treasury Fund",
  },
  {
    label: "Equities <= $120k -> Tax-Loss Harvest",
    title: "Tax-Loss Harvest Watcher",
    metric: "equity_value",
    operator: "lte",
    thresholdUsd: 120_000,
    actionSummary: "Stage wash-sale-safe tax-loss harvest swap bundle",
  },
  {
    label: "Goal >= $60k -> Lock Down-Payment CD",
    title: "Home Down-Payment Milestone",
    metric: "goal_progress",
    operator: "gte",
    thresholdUsd: 60_000,
    actionSummary: "Prepare 6-month Treasury ladder preview for escrow funds",
  },
];

export function LivingWatchcardsStrip({
  personaId,
  conversationId,
  watchcards,
  onChange,
  showCreator,
  onCloseCreator,
}: {
  personaId: string;
  conversationId: string;
  watchcards: Watchcard[];
  onChange: (next: Watchcard[]) => void;
  showCreator: boolean;
  onCloseCreator: () => void;
}) {
  const [title, setTitle] = useState("Cash Sweep Sentinel");
  const [metric, setMetric] = useState<WatchcardMetric>("cash_balance");
  const [operator, setOperator] = useState<"gte" | "lte">("gte");
  const [threshold, setThreshold] = useState("25000");
  const [actionSummary, setActionSummary] = useState("Stage a $5,000 high-yield sweep preview");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function createCard(preset?: typeof WATCH_PRESETS[number]) {
    setBusyId("create");
    setError("");
    try {
      const res = await api.createWatchcard({
        conversationId,
        personaId,
        title: preset?.title ?? title,
        metric: preset?.metric ?? metric,
        operator: preset?.operator ?? operator,
        thresholdUsd: preset?.thresholdUsd ?? (Number(threshold) || 25_000),
        actionSummary: preset?.actionSummary ?? actionSummary,
      });
      onChange(res.watchcards);
      onCloseCreator();
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setBusyId(null);
    }
  }

  async function simulate(id: string) {
    setBusyId(id);
    setError("");
    try {
      const res = await api.simulateWatchcard(id);
      onChange(res.watchcards);
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setBusyId(null);
    }
  }

  async function execute(id: string) {
    setBusyId(id);
    setError("");
    try {
      const res = await api.executeWatchcard(id);
      onChange(res.watchcards);
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setBusyId(null);
    }
  }

  async function dismiss(id: string) {
    setBusyId(id);
    try {
      const res = await api.dismissWatchcard(id);
      onChange(res.watchcards);
    } finally {
      setBusyId(null);
    }
  }

  if (!showCreator && watchcards.length === 0) return null;

  return (
    <section className="living-watchcards-wrap" aria-label="Living Thread Autonomous Watchcards">
      {showCreator && (
        <div className="watchcard-creator">
          <div className="watchcard-creator-head">
            <span className="rich-kicker"><Bell size={12} aria-hidden="true" /> CREATE LIVING WATCHCARD</span>
            <button type="button" className="icon-button" aria-label="Close watchcard creator" onClick={onCloseCreator}>
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          <div className="watchcard-presets">
            {WATCH_PRESETS.map((p) => (
              <button key={p.label} type="button" className="rich-action-chip" disabled={busyId === "create"} onClick={() => void createCard(p)}>
                <Plus size={11} aria-hidden="true" />{p.label}
              </button>
            ))}
          </div>
          <form className="watchcard-form" onSubmit={(e) => { e.preventDefault(); void createCard(); }}>
            <input aria-label="Watchcard title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Watchcard name" />
            <select aria-label="Metric" value={metric} onChange={(e) => setMetric(e.target.value as WatchcardMetric)}>
              <option value="cash_balance">Cash Balance</option>
              <option value="equity_value">Equity Value</option>
              <option value="goal_progress">Goal Progress</option>
              <option value="portfolio_total">Portfolio Total</option>
            </select>
            <select aria-label="Operator" value={operator} onChange={(e) => setOperator(e.target.value as "gte" | "lte")}>
              <option value="gte">&gt;= crosses above</option>
              <option value="lte">&lt;= drops below</option>
            </select>
            <input aria-label="Threshold USD" type="number" min={0} step={500} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
            <input aria-label="Action when triggered" className="is-wide" value={actionSummary} onChange={(e) => setActionSummary(e.target.value)} placeholder="Action to stage on trigger" />
            <button type="submit" className="rich-btn-primary" disabled={busyId === "create"}>
              <Activity size={13} aria-hidden="true" />Activate Sentinel
            </button>
          </form>
        </div>
      )}

      {error && <p className="rich-error" role="alert">{error}</p>}

      {watchcards.length > 0 && (
        <div className="watchcard-list">
          {watchcards.map((c) => (
            <article key={c.id} className={"watchcard-item is-" + c.status}>
              <div className="watchcard-item-head">
                <div className="watchcard-item-title">
                  <span className={"watchcard-dot is-" + c.status} aria-hidden="true" />
                  <strong>{c.title}</strong>
                  <span className={"handoff-status-pill is-" + (c.status === "executed" ? "resolved" : c.status === "triggered" ? "claimed" : "queued")}>
                    {c.status}
                  </span>
                </div>
                <button type="button" className="icon-button" aria-label={`Dismiss ${c.title}`} onClick={() => void dismiss(c.id)}>
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
              <p className="watchcard-meta">
                Rule: <code>{c.metric} {c.operator === "gte" ? ">=" : "<="} {fmtUsd(c.thresholdUsd)}</code> · Current: <strong>{fmtUsd(c.currentValueUsd)}</strong> · Action: {c.actionSummary}
              </p>
              <div className="watchcard-actions">
                {c.status === "watching" && (
                  <button type="button" className="rich-action-chip" disabled={busyId === c.id} onClick={() => void simulate(c.id)}>
                    <Play size={11} aria-hidden="true" />Simulate Live Trigger
                  </button>
                )}
                {c.status === "triggered" && (
                  <button type="button" className="rich-btn-primary" disabled={busyId === c.id} onClick={() => void execute(c.id)}>
                    <CheckCircle2 size={13} aria-hidden="true" />Approve &amp; Execute ({c.approvalId})
                  </button>
                )}
                {c.status === "executed" && (
                  <small className="cobrowse-signed-note">
                    <CheckCircle2 size={12} aria-hidden="true" /> Executed &amp; audited ({c.auditId})
                  </small>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

/* ============================================================================
 * #4 Instant "Expertise Morph" Dial (Guided <-> Standard <-> Pro Terminal)
 * ========================================================================== */

export function ExpertiseMorphDial({
  mode,
  onChange,
}: {
  mode: ExpertiseMode;
  onChange: (next: ExpertiseMode) => void;
}) {
  const options: Array<{ id: ExpertiseMode; label: string; icon: typeof Eye }> = [
    { id: "guided", label: "Guided", icon: Eye },
    { id: "standard", label: "Standard", icon: Layers },
    { id: "pro", label: "Pro", icon: Terminal },
  ];
  return (
    <div className="expertise-dial" role="group" aria-label="Display complexity mode">
      {options.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          className={"expertise-dial-btn" + (mode === id ? " is-active" : "")}
          aria-pressed={mode === id}
          onClick={() => onChange(id)}
        >
          <Icon size={12} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

export function ExpertiseTurnBanner({ mode, turn }: { mode: ExpertiseMode; turn: TurnView }) {
  if (mode === "standard" || !turn.experience) return null;
  const blocks = turn.experience.blocks;
  if (mode === "guided") {
    const headline = turn.experience.intro.split(/(?<=[.!?])\s+/)[0] ?? turn.experience.intro;
    return (
      <div className="expertise-guided-card" role="note" aria-label="Plain-English takeaway">
        <span className="rich-kicker"><Sparkles size={11} aria-hidden="true" /> PLAIN-ENGLISH TAKEAWAY</span>
        <p>{headline}</p>
      </div>
    );
  }
  // Pro Terminal telemetry strip
  const sourceCount = blocks.reduce((acc, b) => acc + (Array.isArray((b.props as { sources?: unknown[] }).sources) ? (b.props as { sources: unknown[] }).sources.length : 0), 0);
  return (
    <div className="expertise-pro-strip" role="note" aria-label="Pro Terminal metadata">
      <span><Terminal size={11} aria-hidden="true" /> PRO</span>
      <code>mode={turn.actionMode ?? "verified"}</code>
      <code>exp={turn.experience.experienceId.slice(0, 14)}</code>
      <code>blocks={blocks.map((b) => b.component.replace(/^Pzn/, "")).join(",") || "text"}</code>
      <code>sources={sourceCount}</code>
      <code>actions={turn.experience.actions.length}</code>
    </div>
  );
}

/* ============================================================================
 * #6 Consumer A2A — "My Personal AI <-> Enterprise AI" Delegated Negotiation Drawer
 * ========================================================================== */

const ALL_SCOPES: Array<{ id: DelegationScope; label: string }> = [
  { id: "read_balances", label: "Read balances" },
  { id: "search_policies", label: "Search policies (MCP)" },
  { id: "stage_drafts", label: "Stage drafts" },
  { id: "request_actions", label: "Request actions" },
];

export function ConsumerA2aDrawer({
  open,
  personaId,
  onClose,
}: {
  open: boolean;
  personaId: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<AgentDelegationView>({ passes: [], negotiations: [] });
  const [agentName, setAgentName] = useState("Personal Claude / Copilot");
  const [capUsd, setCapUsd] = useState("5000");
  const [scopes, setScopes] = useState<DelegationScope[]>(["read_balances", "search_policies", "stage_drafts", "request_actions"]);
  const [goal, setGoal] = useState("Negotiate an $8,500 home deposit transfer and verify wash-sale & wire policy compliance");
  const [reqAmount, setReqAmount] = useState("8500");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    void api.agentDelegationView(personaId).then(setView).catch((e) => setError(toolSetupErrorMessage(e)));
  }, [open, personaId]);

  if (!open) return null;

  const activePass = view.passes.find((p) => p.status === "active");

  async function mintPass(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api.mintDelegationPass({
        personaId,
        agentName,
        allowedScopes: scopes.length ? scopes : ["read_balances"],
        maxTransactionUsd: Number(capUsd) || 5000,
        expiresInHours: 24,
      });
      setView(res.view);
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(passId: string) {
    setBusy(true);
    try {
      const res = await api.revokeDelegationPass(passId);
      setView(res.view);
    } finally {
      setBusy(false);
    }
  }

  async function runNegotiation(passId: string) {
    setBusy(true);
    setError("");
    try {
      const res = await api.runAgentNegotiation({
        passId,
        goal,
        requestedAmountUsd: Number(reqAmount) || 0,
      });
      setView(res.view);
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function approveSession(sessionId: string) {
    setBusy(true);
    try {
      const res = await api.approveAgentNegotiation(sessionId);
      setView(res.view);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rich-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="a2a-drawer-title">
      <div className="rich-drawer a2a-drawer">
        <header className="rich-drawer-head">
          <div>
            <span className="rich-kicker"><Bot size={13} aria-hidden="true" /> CONSUMER A2A · DELEGATED NEGOTIATION</span>
            <h2 id="a2a-drawer-title">My Personal AI ↔ CEP Agent</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Close Personal AI delegation drawer" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <p className="rich-drawer-sub">
          Issue a scoped, time-bound Delegation Pass for your personal AI. Watch it discover CEP via <code>/.well-known/agent.json</code>, verify compliance over <code>/api/mcp</code>, and pause at <code>sfield</code>’s risk boundary for your tap.
        </p>

        <form className="a2a-mint-form" onSubmit={(e) => void mintPass(e)}>
          <div className="a2a-mint-row">
            <label>
              <span>Personal AI Name</span>
              <input value={agentName} onChange={(e) => setAgentName(e.target.value)} />
            </label>
            <label>
              <span>Autonomous Cap ($)</span>
              <input type="number" min={0} step={500} value={capUsd} onChange={(e) => setCapUsd(e.target.value)} />
            </label>
          </div>
          <div className="a2a-scopes">
            {ALL_SCOPES.map((s) => (
              <label key={s.id} className="a2a-scope-check">
                <input
                  type="checkbox"
                  checked={scopes.includes(s.id)}
                  onChange={(e) => setScopes((prev) => e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id))}
                />
                <span>{s.label}</span>
              </label>
            ))}
          </div>
          <button type="submit" className="rich-btn-primary" disabled={busy}>
            <KeyRound size={13} aria-hidden="true" />Mint Scoped Delegation Pass (24h)
          </button>
        </form>

        {error && <p className="rich-error" role="alert">{error}</p>}

        {view.passes.length > 0 && (
          <div className="a2a-passes">
            <span className="rich-kicker">ISSUED PASSES</span>
            {view.passes.slice(0, 3).map((p) => (
              <div key={p.passId} className={"a2a-pass-card is-" + p.status}>
                <div>
                  <strong>{p.agentName}</strong> · <code>{p.passId}</code>
                  <small>Cap: {fmtUsd(p.maxTransactionUsd)} · Scopes: {p.allowedScopes.join(", ")}</small>
                </div>
                {p.status === "active" ? (
                  <button type="button" className="icon-button" title="Revoke pass" onClick={() => void revoke(p.passId)}>
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                ) : (
                  <span className="handoff-status-pill is-resolved">revoked</span>
                )}
              </div>
            ))}
          </div>
        )}

        {activePass && (
          <div className="a2a-run-box">
            <span className="rich-kicker"><Sliders size={11} aria-hidden="true" /> RUN LIVE A2A NEGOTIATION</span>
            <input aria-label="Negotiation goal" value={goal} onChange={(e) => setGoal(e.target.value)} />
            <div className="a2a-run-row">
              <label>
                <span>Requested Amount ($)</span>
                <input type="number" min={0} step={500} value={reqAmount} onChange={(e) => setReqAmount(e.target.value)} />
              </label>
              <button type="button" className="rich-btn-primary" disabled={busy} onClick={() => void runNegotiation(activePass.passId)}>
                <Play size={13} aria-hidden="true" />Negotiate Now
              </button>
            </div>
          </div>
        )}

        {view.negotiations.length > 0 && (
          <div className="a2a-feed">
            <span className="rich-kicker">LIVE AGENT-TO-AGENT TRANSCRIPT</span>
            {view.negotiations.slice(0, 3).map((neg) => (
              <article key={neg.sessionId} className={"a2a-session is-" + neg.status}>
                <div className="a2a-session-head">
                  <strong>{neg.agentName} → CEP</strong>
                  <span className={"handoff-status-pill is-" + (neg.status === "completed" ? "resolved" : neg.status === "paused_for_approval" ? "claimed" : "queued")}>
                    {neg.status.replaceAll("_", " ")}
                  </span>
                </div>
                <div className="a2a-transcript">
                  {neg.transcript.map((m) => (
                    <div key={m.id} className={"a2a-msg is-" + m.speaker}>
                      <div className="a2a-msg-top">
                        <strong>{m.speaker === "personal_ai" ? neg.agentName : m.speaker === "cep_agent" ? "CEP Governed Agent" : "sfield Risk Guard"}</strong>
                        <code>{m.protocol}</code>
                      </div>
                      <p>{m.text}</p>
                      {m.payloadSummary && <small><code>{m.payloadSummary}</code></small>}
                    </div>
                  ))}
                </div>
                {neg.status === "paused_for_approval" && (
                  <div className="a2a-approve-bar">
                    <ShieldAlert size={14} aria-hidden="true" />
                    <button type="button" className="rich-btn-primary" disabled={busy} onClick={() => void approveSession(neg.sessionId)}>
                      <CheckCircle2 size={13} aria-hidden="true" />Approve &amp; Sign ({neg.approvalId})
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
