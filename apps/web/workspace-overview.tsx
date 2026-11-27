import { useEffect, useId, useState } from "react";
import { ArrowRight, ArrowUpRight, House, ShieldCheck, Wallet } from "lucide-react";
import type { DemoPersona } from "../../packages/contracts/api";
import type { GoalProgress } from "../../packages/contracts/goal-progress";
import { formatPortfolioAmount, type PortfolioHistoryPoint, type PortfolioSnapshot } from "../../packages/contracts/portfolio";
import type { WorkspaceNextStep, WorkspacePin } from "../../packages/contracts/workspace";
import { api } from "./api";
import { SavingsGrowthChart } from "./goal-progress";
import { PortfolioHistory } from "./portfolio-history";
import { PortfolioSnapshotBlock } from "./portfolio-snapshot";
import { workspaceSections, type WorkspaceSection } from "./workspace-menu";
import { PendingActionsCard, type PendingActions } from "./workspace-actions";
import "./workspace-overview.css";

const snapshotDate = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

function SavingsOverview({ goal, disabled, onReview }: {
  goal: GoalProgress; disabled: boolean; onReview: () => void;
}) {
  const title = useId();
  const saved = goal.history[goal.history.length - 1].savedCents;
  const percent = Math.floor(saved * 100 / goal.targetCents);
  return <section className="content-card workspace-savings" aria-labelledby={title}>
    <header className="workspace-card-heading">
      <h3 id={title}><House size={18} aria-hidden="true" />Home down payment</h3>
      <button className="overview-action" type="button" disabled={disabled} onClick={onReview}>
        Open in chat <ArrowUpRight size={15} aria-hidden="true" />
      </button>
    </header>
    <div className="savings-overview-stats">
      <div>
        <div className="savings-overview-value">{formatPortfolioAmount(saved)}</div>
        <p>Saved toward {formatPortfolioAmount(goal.targetCents)}</p>
      </div>
      <div className="savings-overview-progress">
        <span>{percent}% of goal</span>
        <progress aria-label="Home down payment progress" max={goal.targetCents} value={Math.min(saved, goal.targetCents)} />
      </div>
    </div>
    <SavingsGrowthChart goal={goal} />
  </section>;
}

function AccountOverview({ profile }: { profile: DemoPersona["profile"] }) {
  const title = useId();
  if (!profile) return null;
  const missing = profile.beneficiaryStatus === "missing";
  const unfunded = profile.accountFundingStatus === "unfunded";
  return <section className="content-card workspace-account" aria-labelledby={title}>
    <h3 id={title}>Account status</h3>
    <dl>
      <div>
        <dt><Wallet size={16} aria-hidden="true" />Funding</dt>
        <dd className={unfunded ? "attention" : undefined}>{unfunded ? "Awaiting deposit" : "Funded"}</dd>
      </div>
      <div>
        <dt><ShieldCheck size={16} aria-hidden="true" />Beneficiaries</dt>
        <dd className={missing ? "attention" : undefined}>{missing ? "Missing" : "On file"}</dd>
      </div>
    </dl>
  </section>;
}

function useNextStep(personaId?: string) {
  const [step, setStep] = useState<WorkspaceNextStep | null>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!personaId) return;
    let active = true;
    void api.nextStep(personaId).then((result) => { if (active) setStep(result); },
      () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [personaId, attempt]);
  return { step, failed, retry: () => { setFailed(false); setAttempt((value) => value + 1); } };
}

function NextStepCard({ personaId, disabled, optional, onPreview }: {
  personaId: string; disabled: boolean; optional: boolean; onPreview: () => void;
}) {
  const { step, failed, retry } = useNextStep(personaId);
  if (optional && !step && !failed) return null;
  return <section className="content-card workspace-next-step" aria-label="Suggested next step">
    {step ? <>
      <div>
        <p className="next-step-label">Suggested next step</p>
        <h3>{step.title}</h3>
        <p className="next-step-copy">{step.body}</p>
        {step.reason && <details className="next-step-reason"><summary>Why am I seeing this?</summary><p>{step.reason}.</p></details>}
      </div>
      {step.canPreviewFunding && <button className="workspace-primary" type="button" disabled={disabled} onClick={onPreview}>
        Preview funding <ArrowRight size={16} aria-hidden="true" />
      </button>}
    </> : failed ? <div className="next-step-error">
      <p role="status">Couldn’t load your next step.</p>
      <button className="secondary-button" type="button" onClick={retry}>Try again</button>
    </div> : <p role="status">{step === undefined ? "Checking your next step…" : "No suggested next step right now."}</p>}
  </section>;
}

function WelcomeBanner({ displayName, portfolio, modelUnavailable }: {
  displayName?: string; portfolio?: PortfolioSnapshot | null; modelUnavailable: boolean;
}) {
  const title = useId();
  const firstName = displayName?.split(/\s+/)[0];
  const total = portfolio ? portfolio.cashCents + portfolio.equityCents + portfolio.fixedIncomeCents : 0;
  return <section className="overview-banner" aria-labelledby={title}>
    <h2 id={title}>{firstName ? `Welcome, ${firstName}.` : "Your planning overview"}</h2>
    {portfolio && <>
      <p className="overview-summary">Your portfolio value is <strong>{formatPortfolioAmount(total)}</strong>
        {total > 0 && <>, including <strong>{formatPortfolioAmount(portfolio.cashCents)}</strong> in cash</>}.
      </p>
      <p className="overview-date">As of <time dateTime={portfolio.asOf}>{snapshotDate.format(new Date(portfolio.asOf))}</time></p>
    </>}
    {modelUnavailable && <p className="gateway-status" role="status">The assistant is temporarily unavailable.</p>}
  </section>;
}

function AccountSummary({ portfolio, history, disabled, onReview }: {
  portfolio: PortfolioSnapshot; history?: PortfolioHistoryPoint[]; disabled: boolean; onReview: () => void;
}) {
  const title = useId();
  const { asOf, cashCents, equityCents, fixedIncomeCents } = portfolio;
  const invested = equityCents + fixedIncomeCents;
  const showHistory = history && history.length >= 2;
  return <section className={"content-card account-summary" + (showHistory ? " has-history" : "")} aria-labelledby={title}>
    <div className="account-summary-values">
      <header className="workspace-card-heading">
        <h3 id={title}>Account summary</h3>
        <p className="overview-date">As of <time dateTime={asOf}>{snapshotDate.format(new Date(asOf))}</time></p>
      </header>
      <p className="account-summary-total"><span>Portfolio value</span><strong>{formatPortfolioAmount(invested + cashCents)}</strong></p>
      <dl>
        <div><dt>Invested</dt><dd>{formatPortfolioAmount(invested)}</dd></div>
        <div><dt>Cash</dt><dd>{formatPortfolioAmount(cashCents)}</dd></div>
      </dl>
      <button className="overview-action" type="button" disabled={disabled} onClick={onReview}>
        View portfolio in chat <ArrowUpRight size={15} aria-hidden="true" />
      </button>
    </div>
    {showHistory && <PortfolioHistory history={history} overview />}
  </section>;
}

export function WorkspaceHome({ activeProfile, pendingActions, disabled, modelUnavailable, onReviewPortfolio, onReviewGuide, onPreviewFunding }: {
  activeProfile?: DemoPersona; pendingActions: PendingActions; disabled: boolean; modelUnavailable: boolean;
  onReviewPortfolio: () => void; onReviewGuide: (message: string) => void; onPreviewFunding: () => void;
}) {
  const portfolio = activeProfile?.overview?.portfolio;
  const actionsDisabled = disabled || modelUnavailable;
  return <div className="workspace-overview workspace-home">
    <WelcomeBanner displayName={activeProfile?.displayName} modelUnavailable={modelUnavailable} />
    {activeProfile && <>
      {portfolio ? <AccountSummary portfolio={portfolio} history={activeProfile.overview?.portfolioHistory}
        disabled={actionsDisabled} onReview={onReviewPortfolio} /> : <section className="content-card welcome-no-portfolio" aria-label="Account summary">
        <h3>Account summary</h3>
        <p>Portfolio information is unavailable.</p>
      </section>}
      <PendingActionsCard pendingActions={pendingActions} firstDepositConfirmedAt={activeProfile.profile?.firstDepositConfirmedAt} disabled={disabled} modelUnavailable={modelUnavailable}
        onReviewGuide={onReviewGuide} onPreviewFunding={onPreviewFunding} />
    </>}
  </div>;
}

function PinnedSummary({ activeProfile, pins, onSelect }: {
  activeProfile: DemoPersona; pins: WorkspacePin[]; onSelect: (section: WorkspaceSection) => void;
}) {
  const { overview, profile } = activeProfile;
  const portfolio = overview?.portfolio;
  const goal = overview?.homeGoal;
  const latestSavings = goal?.history.at(-1);
  const values = {
    portfolio: portfolio && { value: formatPortfolioAmount(portfolio.equityCents + portfolio.fixedIncomeCents), detail: "Invested value" },
    savings: goal && latestSavings && { value: formatPortfolioAmount(latestSavings.savedCents), detail: "Saved toward " + formatPortfolioAmount(goal.targetCents) },
    account: profile && {
      value: profile.accountFundingStatus === "unfunded" ? "Awaiting deposit" : "Funded",
      detail: profile.beneficiaryStatus === "missing" ? "Beneficiaries missing" : "Beneficiaries on file",
    },
    "next-step": undefined,
  };
  const display = pins.filter((pin) => values[pin]);
  if (!display.length) return null;
  return <div className="pinned-summary" aria-label="Pinned sections">
    {display.map((pin) => {
      const { label, Icon } = workspaceSections[pin];
      const item = values[pin]!;
      return <button key={pin} className="content-card pinned-summary-item" type="button" onClick={() => onSelect(pin)}>
        <span className="pinned-summary-label"><Icon size={17} aria-hidden="true" />{label}<ArrowUpRight size={14} aria-hidden="true" /></span>
        <strong>{item.value}</strong>
        <span>{item.detail}</span>
      </button>;
    })}
  </div>;
}

export function WorkspaceOverview({ activeProfile, section, pins, onSelect, disabled, modelUnavailable, showNextStep, onReviewGoal, onReviewPortfolio, onPreviewFunding }: {
  activeProfile?: DemoPersona; section: WorkspaceSection; disabled: boolean; modelUnavailable: boolean; showNextStep: boolean;
  pins: WorkspacePin[]; onSelect: (section: WorkspaceSection) => void;
  onReviewGoal: () => void; onReviewPortfolio: () => void; onPreviewFunding: () => void;
}) {
  const { displayName, profile, overview } = activeProfile ?? {};
  const portfolio = overview?.portfolio;
  const goal = overview?.homeGoal;
  if (section === "portfolio" && portfolio) return <div className="workspace-overview workspace-detail">
    <div className="workspace-detail-toolbar">
      <button className="overview-action" type="button" disabled={disabled} onClick={onReviewPortfolio}>
        Ask about portfolio <ArrowUpRight size={15} aria-hidden="true" />
      </button>
    </div>
    <PortfolioSnapshotBlock {...portfolio} />
    <PortfolioHistory history={overview?.portfolioHistory ?? []} />
  </div>;
  if (section === "savings" && goal) return <div className="workspace-overview workspace-detail">
    <SavingsOverview goal={goal} disabled={disabled} onReview={onReviewGoal} />
  </div>;
  if (section === "account" && profile) return <div className="workspace-overview workspace-detail">
    <AccountOverview profile={profile} />
  </div>;
  if (section === "next-step" && activeProfile) return <div className="workspace-overview workspace-detail">
    <NextStepCard key={activeProfile.personaId} personaId={activeProfile.personaId} disabled={disabled} optional={false} onPreview={onPreviewFunding} />
  </div>;
  if (section !== "summary") return <div className="workspace-overview"><p role="status">This section is unavailable for your profile.</p></div>;
  return <div className="workspace-overview workspace-summary">
    <WelcomeBanner displayName={displayName} portfolio={portfolio} modelUnavailable={modelUnavailable} />
    {activeProfile && showNextStep && <PinnedSummary activeProfile={activeProfile} pins={pins} onSelect={onSelect} />}
    {activeProfile && showNextStep && <NextStepCard key={activeProfile.personaId} personaId={activeProfile.personaId} disabled={disabled} optional onPreview={onPreviewFunding} />}
  </div>;
}
