import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  Briefcase,
  CheckCircle2,
  Eye,
  EyeOff,
  Landmark,
  Layers,
  LayoutDashboard,
  Lock,
  MessageSquare,
  Monitor,
  Play,
  Plus,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react";
import type {
  ChannelSurfaceId,
  ComposedExperienceResult,
  ExperienceComposerBootstrap,
  SubjectAreaId,
} from "../server/experience-composer";
import { ExperienceComposerModal, type CreateModalTab } from "./experience-composer-modal";
import { ThemeToggle } from "./theme";
import "./experience-composer-studio.css";

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { message?: string; error?: string }).message || `Request failed (${res.status})`);
  }
  return data as T;
}

const SUBJECT_ICONS: Record<SubjectAreaId, typeof TrendingUp> = {
  wealth: TrendingUp,
  banking: Landmark,
  retirement: Briefcase,
};

const CHANNEL_ICONS: Record<ChannelSurfaceId, typeof MessageSquare> = {
  chat_turn: MessageSquare,
  web_dashboard: LayoutDashboard,
  mobile_compact: Smartphone,
  advisor_desktop: Monitor,
};

export function ExperienceComposerStudio() {
  const [bootstrap, setBootstrap] = useState<ExperienceComposerBootstrap | null>(null);
  const [composed, setComposed] = useState<ComposedExperienceResult | null>(null);
  const [subjectArea, setSubjectArea] = useState<SubjectAreaId>("wealth");
  const [experienceId, setExperienceId] = useState<string>("wealth-portfolio-summary");
  const [channel, setChannel] = useState<ChannelSurfaceId>("chat_turn");
  const [showAnatomy, setShowAnatomy] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  const [banner, setBanner] = useState<{ kind: "info" | "success" | "warn" | "error"; text: string } | null>(null);
  const [createModal, setCreateModal] = useState<{ open: boolean; tab: CreateModalTab }>({ open: false, tab: "experience" });

  const composeView = useCallback(async (nextExpId: string, nextChannel: ChannelSurfaceId, silent = false) => {
    setBusy(true);
    if (!silent) setBanner(null);
    try {
      const data = await apiJson<{ composed: ComposedExperienceResult; bootstrap: ExperienceComposerBootstrap }>(
        "/api/experience-composer/compose",
        {
          method: "POST",
          body: JSON.stringify({ experienceId: nextExpId, channel: nextChannel }),
        },
      );
      setBootstrap(data.bootstrap);
      setComposed(data.composed);
      setSubjectArea(data.composed.subjectArea);
      setExperienceId(data.composed.experienceId);
      setChannel(data.composed.channel);
    } catch (err) {
      setBanner({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void composeView("wealth-portfolio-summary", "chat_turn", true);
  }, [composeView]);

  const pickSubject = (nextSubject: SubjectAreaId) => {
    setSubjectArea(nextSubject);
    const match = bootstrap?.experiences.find((e) => e.subjectArea === nextSubject);
    if (match) void composeView(match.id, channel);
  };

  const executeSignedAction = async (token: string, label: string) => {
    if (!composed) return;
    setBusy(true);
    setBanner(null);
    try {
      const data = await apiJson<{ composed: ComposedExperienceResult; bootstrap: ExperienceComposerBootstrap }>(
        "/api/experience-composer/execute",
        {
          method: "POST",
          body: JSON.stringify({ experienceId: composed.experienceId, channel: composed.channel, signedActionToken: token }),
        },
      );
      setBootstrap(data.bootstrap);
      setComposed(data.composed);
      setBanner({
        kind: "success",
        text: `sfield verified HMAC signature and ran 3 deterministic tools for "${label}".`,
      });
    } catch (err) {
      setBanner({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const completeTask = async () => {
    if (!composed) return;
    setBusy(true);
    setBanner(null);
    try {
      const data = await apiJson<{ composed: ComposedExperienceResult; bootstrap: ExperienceComposerBootstrap }>(
        "/api/experience-composer/complete-task",
        {
          method: "POST",
          body: JSON.stringify({ experienceId: composed.experienceId, channel: composed.channel }),
        },
      );
      setBootstrap(data.bootstrap);
      setComposed(data.composed);
      const promoted = data.composed.arbitrationLog.find((a) => a.outcome === "promoted");
      setBanner({
        kind: "success",
        text: promoted
          ? `Domain event confirmed -> revision ${data.composed.revision} cleared the Task live & auto-promoted the waiting NBA into the freed slot!`
          : `Domain event confirmed -> revision ${data.composed.revision} cleared the Task live (Main card untouched).`,
      });
    } catch (err) {
      setBanner({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const dismissNba = async (nbaId: string, title: string) => {
    if (!composed) return;
    setBusy(true);
    setBanner(null);
    try {
      const data = await apiJson<{ composed: ComposedExperienceResult; bootstrap: ExperienceComposerBootstrap }>(
        "/api/experience-composer/dismiss-nba",
        {
          method: "POST",
          body: JSON.stringify({ experienceId: composed.experienceId, channel: composed.channel, nbaId }),
        },
      );
      setBootstrap(data.bootstrap);
      setComposed(data.composed);
      setBanner({
        kind: "info",
        text: `Dismissed "${title}" in sfield memory — now suppressed across AI Chat, Web Portal, Mobile App, and Advisor Co-Pilot.`,
      });
    } catch (err) {
      setBanner({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const resetAll = async () => {
    setBusy(true);
    setBanner(null);
    try {
      const data = await apiJson<{ composed: ComposedExperienceResult; bootstrap: ExperienceComposerBootstrap }>(
        "/api/experience-composer/reset",
        {
          method: "POST",
          body: JSON.stringify({ experienceId, channel }),
        },
      );
      setBootstrap(data.bootstrap);
      setComposed(data.composed);
      setBanner({ kind: "info", text: "Experience Composer reset across all 3 subject areas and 4 channels." });
    } catch (err) {
      setBanner({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const subjectExperiences = bootstrap?.experiences.filter((e) => e.subjectArea === subjectArea) ?? [];
  const activeExec = composed?.zones.actions.activeExecution ?? null;

  const renderZoneTag = (num: number, label: string, tone: string) =>
    showAnatomy ? (
      <span className={`ec-zone-tag tone-${tone}`}>
        <strong>{num}</strong> {label}
      </span>
    ) : null;

  const renderMainZone = () => {
    if (!composed) return null;
    const { main } = composed.zones;
    return (
      <section className={"ec-card ec-zone-main" + (showAnatomy ? " has-anatomy" : "")}>
        <div className="ec-zone-head">
          {renderZoneTag(1, "MAIN · PRIMARY EXPERIENCE", "main")}
          <span className="ec-snap-chip">
            <ShieldCheck size={12} /> smass {composed.dataVersions.balanceVersion} · 1x read
          </span>
        </div>
        <h3 className="ec-main-title">{main.title}</h3>
        <p className="ec-main-sub">{main.subtitle}</p>
        <div className="ec-metric-grid">
          {main.metrics.map((metric) => (
            <div key={metric.label} className="ec-metric-tile">
              <span>{metric.label}</span>
              <strong>{formatCents(metric.cents)}</strong>
            </div>
          ))}
        </div>
        <div className="ec-highlight-row">
          {main.highlights.map((item) => (
            <div key={item.label} className={`ec-highlight-chip tone-${item.tone ?? "default"}`}>
              <span>{item.label}:</span> <strong>{item.value}</strong>
            </div>
          ))}
        </div>
      </section>
    );
  };

  const renderTasksZone = () => {
    if (!composed || composed.zones.tasks.length === 0) return null;
    return (
      <div className="ec-companion-stack">
        {composed.zones.tasks.map((task) => (
          <section key={task.id} className={"ec-card ec-zone-task" + (showAnatomy ? " has-anatomy" : "")}>
            <div className="ec-zone-head">
              {renderZoneTag(2, "TASK · PENDING OBLIGATION", "task")}
              <span className="ec-rule-pill">CCRE: {task.ruleId}</span>
            </div>
            <h4>{task.title}</h4>
            <p>{task.summary}</p>
            <div className="ec-card-actions">
              <button
                type="button"
                className="ec-btn-primary"
                disabled={busy}
                onClick={() => void executeSignedAction(task.signedActionToken, task.ctaLabel)}
              >
                <Play size={13} aria-hidden="true" />
                {task.ctaLabel}
              </button>
              <button type="button" className="ec-btn-subtle" disabled={busy} onClick={() => void completeTask()}>
                <CheckCircle2 size={13} aria-hidden="true" />
                Emit {task.eventName} (v{composed.dataVersions.accountVersion + 1})
              </button>
            </div>
          </section>
        ))}
      </div>
    );
  };

  const renderNbaZone = () => {
    if (!composed || composed.zones.nba.length === 0) return null;
    return (
      <div className="ec-companion-stack">
        {composed.zones.nba.map((item) => (
          <section key={item.id} className={"ec-card ec-zone-nba" + (showAnatomy ? " has-anatomy" : "")}>
            <div className="ec-zone-head">
              {renderZoneTag(3, "NBA · RANKED RECOMMENDATION", "nba")}
              <span className="ec-score-pill">Rank {item.score.toFixed(2)} · {item.estimatedValue}</span>
            </div>
            <h4>{item.title}</h4>
            <p>{item.summary}</p>
            <div className="ec-card-actions">
              <button
                type="button"
                className="ec-btn-primary"
                disabled={busy}
                onClick={() => void executeSignedAction(item.signedActionToken, item.ctaLabel)}
              >
                <Sparkles size={13} aria-hidden="true" />
                {item.ctaLabel}
              </button>
              <button
                type="button"
                className="ec-btn-ghost"
                disabled={busy}
                onClick={() => void dismissNba(item.id, item.title)}
              >
                <X size={13} aria-hidden="true" />
                Not now
              </button>
            </div>
          </section>
        ))}
      </div>
    );
  };

  const renderActionsZone = () => {
    if (!activeExec || !composed) return null;
    return (
      <section className={"ec-card ec-zone-action" + (showAnatomy ? " has-anatomy" : "")}>
        <div className="ec-zone-head">
          {renderZoneTag(4, "ACTION · SFIELD SIGNED WORKFLOW", "action")}
          <span className="ec-rule-pill">
            <Lock size={11} /> {activeExec.workflowId}@{activeExec.workflowVersion}
          </span>
        </div>
        <h4>{activeExec.previewSummary}</h4>
        <ol className="ec-workflow-steps">
          {activeExec.steps.map((s) => (
            <li key={s.step}>
              <span className="ec-step-dot">{s.step}</span>
              <div>
                <code>{s.toolRef}</code>
                <span>{s.summary}</span>
              </div>
            </li>
          ))}
        </ol>
        {activeExec.sourceClass === "tasks" && !composed.taskCompleted && (
          <div className="ec-card-actions">
            <button type="button" className="ec-btn-primary" disabled={busy} onClick={() => void completeTask()}>
              <CheckCircle2 size={13} aria-hidden="true" />
              Confirm &amp; Refresh Zone Live (rev {composed.revision + 1})
            </button>
          </div>
        )}
      </section>
    );
  };

  const renderChromeZone = () => {
    if (!composed) return null;
    const { chrome } = composed.zones;
    return (
      <footer className={"ec-zone-chrome" + (showAnatomy ? " has-anatomy" : "")}>
        <div className="ec-zone-head">
          {renderZoneTag(5, "CHROME · FOLLOW-UPS & IMMUTABLE COMPLIANCE", "chrome")}
          <span className="ec-chrome-meta">
            {chrome.sources.map((s) => `${s.title} (${s.version})`).join(" · ")}
          </span>
        </div>
        {chrome.followUps.length > 0 && (
          <div className="ec-followup-row">
            {chrome.followUps.map((chip) => (
              <span key={chip} className="ec-followup-chip">{chip}</span>
            ))}
          </div>
        )}
        <p className="ec-disclosure">{chrome.disclosures.join(" ")}</p>
      </footer>
    );
  };

  return (
    <div className="ec-page">
      <header className="ec-topbar">
        <div className="ec-topbar-left">
          <a href="/" className="ec-pill-link">
            <ArrowLeft size={14} /> Chat
          </a>
          <div className="ec-title-wrap">
            <span className="ec-eyebrow">
              <Layers size={12} /> EXPERIENCE COMPOSER STUDIO (SPHOTON + PZN + SMASS + SFIELD)
            </span>
            <h1>Compose 5-Class Experiences Across Subject Areas &amp; Channels</h1>
          </div>
        </div>
        <div className="ec-topbar-right">
          <button
            type="button"
            className="ec-btn-primary"
            onClick={() => setCreateModal({ open: true, tab: "experience" })}
          >
            <Plus size={14} aria-hidden="true" /> Create New
          </button>
          <a href="/pzn-architecture" className="ec-pill-link">
            PZN Trace View
          </a>
          <button
            type="button"
            className={"ec-pill-btn" + (showAnatomy ? " is-active" : "")}
            onClick={() => setShowAnatomy((v) => !v)}
          >
            {showAnatomy ? <Eye size={14} /> : <EyeOff size={14} />}
            Zone Anatomy
          </button>
          <button type="button" className="ec-pill-btn" disabled={busy} onClick={() => void resetAll()}>
            <RotateCcw size={14} /> Reset
          </button>
          <ThemeToggle compact />
        </div>
      </header>

      <main className="ec-main">
        {/* 3-Dimension Switcher Bar: Subject Area -> Customer Experience -> Channel */}
        <section className="ec-control-deck" aria-label="Experience dimensions">
          <div className="ec-control-group">
            <div className="ec-control-head">
              <label>1. Subject Area</label>
              <button type="button" className="ec-inline-add" onClick={() => setCreateModal({ open: true, tab: "subject" })}>
                <Plus size={12} /> New
              </button>
            </div>
            <div className="ec-seg-row">
              {bootstrap?.subjectAreas.map((area) => {
                const Icon = SUBJECT_ICONS[area.id] ?? Layers;
                return (
                  <button
                    key={area.id}
                    type="button"
                    disabled={busy}
                    className={"ec-seg-btn" + (subjectArea === area.id ? " is-active" : "")}
                    onClick={() => pickSubject(area.id)}
                  >
                    <Icon size={14} aria-hidden="true" />
                    <span>{area.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="ec-control-group">
            <div className="ec-control-head">
              <label>2. Customer Experience</label>
              <button type="button" className="ec-inline-add" onClick={() => setCreateModal({ open: true, tab: "experience" })}>
                <Plus size={12} /> New
              </button>
            </div>
            <div className="ec-seg-row">
              {subjectExperiences.map((exp) => (
                <button
                  key={exp.id}
                  type="button"
                  disabled={busy}
                  className={"ec-seg-btn" + (experienceId === exp.id ? " is-active" : "")}
                  onClick={() => void composeView(exp.id, channel)}
                >
                  <span>{exp.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="ec-control-group">
            <div className="ec-control-head">
              <label>3. Target Channel &amp; Surface Budget</label>
              <button type="button" className="ec-inline-add" onClick={() => setCreateModal({ open: true, tab: "channel" })}>
                <Plus size={12} /> New
              </button>
            </div>
            <div className="ec-seg-row">
              {bootstrap?.channels.map((ch) => {
                const Icon = CHANNEL_ICONS[ch.id] ?? LayoutDashboard;
                return (
                  <button
                    key={ch.id}
                    type="button"
                    disabled={busy}
                    className={"ec-seg-btn" + (channel === ch.id ? " is-active" : "")}
                    onClick={() => void composeView(experienceId, ch.id)}
                  >
                    <Icon size={14} aria-hidden="true" />
                    <span>{ch.shortLabel}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {banner && (
          <div className={`ec-banner is-${banner.kind}`} role="status">
            {banner.kind === "warn" || banner.kind === "error" ? <ShieldAlert size={16} /> : <CheckCircle2 size={16} />}
            <span>{banner.text}</span>
          </div>
        )}

        <div className="ec-studio-grid">
          {/* Center Stage: Live Channel Preview */}
          <section className="ec-stage-wrap">
            <div className="ec-stage-bar">
              <div>
                <strong>{composed?.budget.label ?? "Channel Surface"}</strong>
                <span> — {composed?.budget.description}</span>
              </div>
              <span className="ec-rev-chip">
                {composed?.decisionId} · rev {composed?.revision ?? 1} · #{composed?.ledgerHash}
              </span>
            </div>

            {composed && (
              <div className={`ec-surface-frame mode-${composed.budget.frameMode}`}>
                {composed.budget.frameMode === "mobile" && (
                  <div className="ec-mobile-notch">
                    <span>9:41</span>
                    <div className="ec-mobile-pill" />
                    <span>5G · 100%</span>
                  </div>
                )}

                {composed.budget.frameMode === "chat" && (
                  <div className="ec-chat-prompt-row">
                    <span className="ec-avatar">{composed.displayName.split(" ").map((p) => p[0]).join("")}</span>
                    <div className="ec-user-bubble">{composed.userPrompt}</div>
                  </div>
                )}

                {composed.budget.frameMode === "web" && (
                  <div className="ec-web-header">
                    <div>
                      <span className="ec-web-kicker">{composed.segment}</span>
                      <h2>Welcome back, {composed.displayName.split(" ")[0]}.</h2>
                    </div>
                    <span className="ec-snap-chip">MID: {composed.mid} · v{composed.dataVersions.accountVersion}</span>
                  </div>
                )}

                {composed.budget.frameMode === "advisor" && (
                  <div className="ec-advisor-header">
                    <div>
                      <span className="ec-web-kicker">ADVISOR CO-PILOT WORKSTATION · FULL PROVENANCE</span>
                      <h2>{composed.displayName} ({composed.mid}) — {composed.segment}</h2>
                    </div>
                    <span className="ec-snap-chip">Snapshot: {composed.snapshotId}</span>
                  </div>
                )}

                {composed.budget.frameMode === "web" || composed.budget.frameMode === "advisor" ? (
                  <div className="ec-two-col-canvas">
                    <div className="ec-col-primary">
                      {renderMainZone()}
                      {renderActionsZone()}
                    </div>
                    <div className="ec-col-rail">
                      {renderTasksZone()}
                      {renderNbaZone()}
                      {composed.zones.tasks.length === 0 && composed.zones.nba.length === 0 && (
                        <div className="ec-card ec-all-clear">
                          <CheckCircle2 size={18} />
                          <div>
                            <strong>All companion items resolved</strong>
                            <p>No pending tasks or active recommendations for this member.</p>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="ec-single-col-canvas">
                    {renderMainZone()}
                    {renderTasksZone()}
                    {renderNbaZone()}
                    {renderActionsZone()}
                  </div>
                )}

                {renderChromeZone()}
              </div>
            )}
          </section>

          {/* Right Rail: 5-Class Budget & Live Arbitration Log */}
          <aside className="ec-inspector-rail">
            <section className="ec-inspector-panel">
              <h3>5-Class Surface Budget</h3>
              <div className="ec-budget-list">
                <div className="ec-budget-row">
                  <span className="ec-zone-tag tone-main"><strong>1</strong> Main</span>
                  <strong>1 / {composed?.budget.maxMain ?? 1}</strong>
                </div>
                <div className="ec-budget-row">
                  <span className="ec-zone-tag tone-task"><strong>2</strong> Tasks</span>
                  <strong>{composed?.zones.tasks.length ?? 0} / {composed?.budget.maxTasks ?? 1}</strong>
                </div>
                <div className="ec-budget-row">
                  <span className="ec-zone-tag tone-nba"><strong>3</strong> NBA</span>
                  <strong>{composed?.zones.nba.length ?? 0} / {composed?.budget.maxNba ?? 1}</strong>
                </div>
                <div className="ec-budget-row">
                  <span className="ec-zone-tag tone-action"><strong>4</strong> sfield Actions</span>
                  <strong>{composed?.zones.actions.activeExecution ? "Running" : `${composed?.zones.actions.availableCount ?? 0} ready`}</strong>
                </div>
                <div className="ec-budget-row">
                  <span className="ec-zone-tag tone-chrome"><strong>5</strong> Follow-ups</span>
                  <strong>{composed?.zones.chrome.followUps.length ?? 0} / {composed?.budget.maxFollowUps ?? 3}</strong>
                </div>
              </div>
              <p className="ec-budget-note">
                Combined companion cap on <strong>{composed?.budget.shortLabel}</strong>: <strong>{composed?.budget.maxCompanionTotal}</strong>{" "}
                (Tasks automatically outrank NBA).
              </p>
            </section>

            {composed && composed.suppressed.length > 0 && (
              <section className="ec-inspector-panel is-suppressed">
                <h3>Held Back by Composer ({composed.suppressed.length})</h3>
                {composed.suppressed.map((item) => (
                  <div key={item.id} className="ec-suppressed-card">
                    <strong>{item.title}</strong>
                    <p>{item.reason}</p>
                  </div>
                ))}
                {!composed.taskCompleted && (
                  <button type="button" className="ec-btn-primary ec-full-btn" disabled={busy} onClick={() => void completeTask()}>
                    <CheckCircle2 size={14} />
                    Complete Open Task → Watch NBA Promote Live
                  </button>
                )}
              </section>
            )}

            <section className="ec-inspector-panel">
              <h3>Live Arbitration Decisions</h3>
              <ul className="ec-arb-list">
                {composed?.arbitrationLog.map((entry, idx) => (
                  <li key={`${entry.itemId}-${idx}`} className={`ec-arb-item outcome-${entry.outcome}`}>
                    <div className="ec-arb-head">
                      <span className={`ec-outcome-badge outcome-${entry.outcome}`}>{entry.outcome}</span>
                      <code>{entry.uiClass}</code>
                    </div>
                    <p>{entry.reason}</p>
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      </main>
      {createModal.open && (
        <ExperienceComposerModal
          key={`${createModal.tab}-${subjectArea}`}
          open={createModal.open}
          initialTab={createModal.tab}
          bootstrap={bootstrap}
          activeSubjectArea={subjectArea}
          activeExperienceId={experienceId}
          activeChannel={channel}
          onClose={() => setCreateModal((m) => ({ ...m, open: false }))}
          onCreated={({ composed: nextComposed, bootstrap: nextBootstrap, notice }) => {
            setBootstrap(nextBootstrap);
            setComposed(nextComposed);
            setSubjectArea(nextComposed.subjectArea);
            setExperienceId(nextComposed.experienceId);
            setChannel(nextComposed.channel);
            setBanner({ kind: "success", text: notice });
          }}
        />
      )}
    </div>
  );
}
