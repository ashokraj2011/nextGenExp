import { useState, type FormEvent } from "react";
import { Layers, Plus, Sparkles, X } from "lucide-react";
import type {
  ChannelSurfaceId,
  ComposedExperienceResult,
  ExperienceComposerBootstrap,
  SubjectAreaId,
} from "../server/experience-composer";

export type CreateModalTab = "experience" | "subject" | "channel";

type Props = {
  open: boolean;
  initialTab: CreateModalTab;
  bootstrap: ExperienceComposerBootstrap | null;
  activeSubjectArea: SubjectAreaId;
  activeExperienceId: string;
  activeChannel: ChannelSurfaceId;
  onClose: () => void;
  onCreated: (result: { composed: ComposedExperienceResult; bootstrap: ExperienceComposerBootstrap; notice: string }) => void;
};

type ExperienceFormState = {
  subjectArea: string;
  memberName: string;
  label: string;
  userPrompt: string;
  mainTitle: string;
  mainSubtitle: string;
  primaryMetricLabel: string;
  primaryMetricDollars: number;
  secondaryMetricLabel: string;
  secondaryMetricDollars: number;
  tertiaryMetricLabel: string;
  tertiaryMetricDollars: number;
  taskRuleId: string;
  taskTitle: string;
  taskSummary: string;
  taskCtaLabel: string;
  taskWorkflowId: string;
  taskEventName: string;
  nbaRuleId: string;
  nbaTitle: string;
  nbaSummary: string;
  nbaScore: number;
  nbaEstimatedValue: string;
  nbaCtaLabel: string;
  nbaWorkflowId: string;
  followUpsCsv: string;
  disclosure: string;
};

const PRESETS: Array<{ name: string; values: Omit<ExperienceFormState, "subjectArea"> }> = [
  {
    name: "Tax-Loss Harvest Review",
    values: {
      memberName: "Priya Nair",
      label: "Priya · Tax-Loss Harvest",
      userPrompt: "Check my taxable portfolio for year-end tax-loss harvesting.",
      mainTitle: "Taxable portfolio & harvest summary",
      mainSubtitle: "Real-time unrealized gains/losses bound from smass Customer 360.",
      primaryMetricLabel: "Taxable Portfolio",
      primaryMetricDollars: 185000,
      secondaryMetricLabel: "Harvestable Losses",
      secondaryMetricDollars: 4200,
      tertiaryMetricLabel: "Est. Tax Savings",
      tertiaryMetricDollars: 1344,
      taskRuleId: "cost_basis_missing",
      taskTitle: "Confirm transferred lot cost basis",
      taskSummary: "2 transferred equity lots need cost-basis verification before year-end settlement.",
      taskCtaLabel: "Verify cost basis",
      taskWorkflowId: "tax.cost_basis.preview",
      taskEventName: "cost_basis.confirmed",
      nbaRuleId: "harvest_opportunity_3k",
      nbaTitle: "Harvest $4,200 loss & rotate to peer ETF",
      nbaSummary: "Avoid wash-sale rules while capturing ~$1,344 in federal tax offset before Dec 31.",
      nbaScore: 0.95,
      nbaEstimatedValue: "+$1,344 est. tax savings",
      nbaCtaLabel: "Preview harvest trade",
      nbaWorkflowId: "tax.harvest.preview",
      followUpsCsv: "Check wash-sale window, Compare peer ETFs, Estimate net tax impact",
      disclosure: "Tax estimates are illustrative and do not constitute tax advice.",
    },
  },
  {
    name: "Home Equity Line Review",
    values: {
      memberName: "Carlos Rivera",
      label: "Carlos · Home Equity",
      userPrompt: "How much home equity can I unlock for a renovation?",
      mainTitle: "Home equity & borrowing power",
      mainSubtitle: "Estimated home value, mortgage balance, and pre-qualified HELOC line.",
      primaryMetricLabel: "Est. Home Value",
      primaryMetricDollars: 640000,
      secondaryMetricLabel: "Mortgage Balance",
      secondaryMetricDollars: 390000,
      tertiaryMetricLabel: "Available Equity Line",
      tertiaryMetricDollars: 122000,
      taskRuleId: "insurance_escrow_renewal",
      taskTitle: "Upload updated homeowner insurance binder",
      taskSummary: "Escrow verification requires your renewed hazard policy before draw activation.",
      taskCtaLabel: "Upload insurance binder",
      taskWorkflowId: "lending.insurance.preview",
      taskEventName: "insurance.verified",
      nbaRuleId: "heloc_prequalified",
      nbaTitle: "Lock 6.95% intro HELOC rate (0 closing fees)",
      nbaSummary: "Pre-qualified for up to $122,000 revolving line based on verified equity.",
      nbaScore: 0.91,
      nbaEstimatedValue: "$0 closing costs · 6.95% intro",
      nbaCtaLabel: "Preview HELOC terms",
      nbaWorkflowId: "lending.heloc.preview",
      followUpsCsv: "Compare HELOC vs. cash-out refi, Estimate monthly draw payment, Check credit impact",
      disclosure: "Subject to credit approval and property appraisal. Equal Housing Lender.",
    },
  },
];

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { message?: string; error?: string }).message || `Request failed (${res.status})`);
  }
  return data as T;
}

export function ExperienceComposerModal({
  open,
  initialTab,
  bootstrap,
  activeSubjectArea,
  activeExperienceId,
  activeChannel,
  onClose,
  onCreated,
}: Props) {
  const [tab, setTab] = useState<CreateModalTab>(initialTab);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Tab 1: New Customer Experience
  const [exp, setExp] = useState<ExperienceFormState>(() => ({
    subjectArea: activeSubjectArea,
    ...PRESETS[0].values,
  }));

  // Tab 2: New Subject Area
  const [subLabel, setSubLabel] = useState("Insurance & Protection");
  const [subTagline, setSubTagline] = useState("Life, auto & umbrella policies, renewal tasks & bundle savings NBAs");
  const [subModelId, setSubModelId] = useState("insurance_policy_360");

  // Tab 3: New Channel Budget
  const [chLabel, setChLabel] = useState("Branch Kiosk");
  const [chShort, setChShort] = useState("Branch Kiosk");
  const [chFrame, setChFrame] = useState<"chat" | "web" | "mobile" | "advisor">("web");
  const [chMaxTasks, setChMaxTasks] = useState(2);
  const [chMaxNba, setChMaxNba] = useState(1);
  const [chCompanionCap, setChCompanionCap] = useState(2);
  const [chFollowUps, setChFollowUps] = useState(2);

  if (!open) return null;

  const submitExperience = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const data = await postJson<{
        experience: { label: string };
        composed: ComposedExperienceResult;
        bootstrap: ExperienceComposerBootstrap;
      }>("/api/experience-composer/create-experience", {
        subjectArea: exp.subjectArea || activeSubjectArea,
        channel: activeChannel,
        memberName: exp.memberName,
        label: exp.label,
        userPrompt: exp.userPrompt,
        mainTitle: exp.mainTitle,
        mainSubtitle: exp.mainSubtitle,
        primaryMetricLabel: exp.primaryMetricLabel,
        primaryMetricDollars: Number(exp.primaryMetricDollars) || 0,
        secondaryMetricLabel: exp.secondaryMetricLabel,
        secondaryMetricDollars: Number(exp.secondaryMetricDollars) || 0,
        tertiaryMetricLabel: exp.tertiaryMetricLabel,
        tertiaryMetricDollars: Number(exp.tertiaryMetricDollars) || 0,
        taskRuleId: exp.taskRuleId,
        taskTitle: exp.taskTitle,
        taskSummary: exp.taskSummary,
        taskCtaLabel: exp.taskCtaLabel,
        taskWorkflowId: exp.taskWorkflowId,
        taskEventName: exp.taskEventName,
        nbaRuleId: exp.nbaRuleId,
        nbaTitle: exp.nbaTitle,
        nbaSummary: exp.nbaSummary,
        nbaScore: Number(exp.nbaScore) || 0.9,
        nbaEstimatedValue: exp.nbaEstimatedValue,
        nbaCtaLabel: exp.nbaCtaLabel,
        nbaWorkflowId: exp.nbaWorkflowId,
        followUps: exp.followUpsCsv.split(",").map((s) => s.trim()).filter(Boolean),
        disclosure: exp.disclosure,
      });
      onCreated({
        composed: data.composed,
        bootstrap: data.bootstrap,
        notice: `Created "${data.experience.label}" and composed it live across all 5 UI classes!`,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const submitSubject = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const data = await postJson<{
        subjectArea: { label: string; smassModelId: string };
        composed: ComposedExperienceResult;
        bootstrap: ExperienceComposerBootstrap;
      }>("/api/experience-composer/create-subject", {
        label: subLabel,
        tagline: subTagline,
        smassModelId: subModelId || undefined,
        channel: activeChannel,
      });
      onCreated({
        composed: data.composed,
        bootstrap: data.bootstrap,
        notice: `Created Subject Area "${data.subjectArea.label}" with live smass model ${data.subjectArea.smassModelId}@1.0.0!`,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const submitChannel = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const data = await postJson<{
        channel: { label: string; maxCompanionTotal: number };
        composed: ComposedExperienceResult;
        bootstrap: ExperienceComposerBootstrap;
      }>("/api/experience-composer/create-channel", {
        label: chLabel,
        shortLabel: chShort || chLabel,
        frameMode: chFrame,
        maxTasks: Number(chMaxTasks),
        maxNba: Number(chMaxNba),
        maxCompanionTotal: Number(chCompanionCap),
        maxFollowUps: Number(chFollowUps),
        experienceId: activeExperienceId,
      });
      onCreated({
        composed: data.composed,
        bootstrap: data.bootstrap,
        notice: `Created channel "${data.channel.label}" (companion cap ${data.channel.maxCompanionTotal}) and composed live!`,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ec-modal-backdrop" role="dialog" aria-modal="true" aria-label="Create new experience component">
      <div className="ec-modal">
        <div className="ec-modal-head">
          <div>
            <span className="ec-eyebrow"><Sparkles size={12} /> EXPERIENCE COMPOSER BUILDER</span>
            <h2>Create New Subject Area, Experience, or Channel Budget</h2>
          </div>
          <button type="button" className="ec-modal-close" aria-label="Close builder" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="ec-modal-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "experience"} className={tab === "experience" ? "is-active" : ""} onClick={() => { setTab("experience"); setError(""); }}>
            1. New Customer Experience
          </button>
          <button type="button" role="tab" aria-selected={tab === "subject"} className={tab === "subject" ? "is-active" : ""} onClick={() => { setTab("subject"); setError(""); }}>
            2. New Subject Area (smass)
          </button>
          <button type="button" role="tab" aria-selected={tab === "channel"} className={tab === "channel" ? "is-active" : ""} onClick={() => { setTab("channel"); setError(""); }}>
            3. New Channel &amp; Budget
          </button>
        </div>

        {error && <div className="ec-banner is-error">{error}</div>}

        {tab === "experience" && (
          <form className="ec-modal-form" onSubmit={(e) => void submitExperience(e)}>
            <div className="ec-preset-bar">
              <span>Quick-fill template:</span>
              {PRESETS.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  className="ec-preset-chip"
                  onClick={() => setExp((cur) => ({ ...cur, ...p.values }))}
                >
                  {p.name}
                </button>
              ))}
            </div>

            <div className="ec-form-section">
              <h4>1 · Main Experience &amp; smass Metrics</h4>
              <div className="ec-form-grid-3">
                <label>
                  Subject Area
                  <select value={exp.subjectArea} onChange={(e) => setExp({ ...exp, subjectArea: e.target.value })}>
                    {bootstrap?.subjectAreas.map((s) => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Member Name
                  <input required value={exp.memberName} onChange={(e) => setExp({ ...exp, memberName: e.target.value })} />
                </label>
                <label>
                  Experience Pill Label
                  <input required value={exp.label} onChange={(e) => setExp({ ...exp, label: e.target.value })} />
                </label>
              </div>
              <div className="ec-form-grid-2">
                <label>
                  Main Card Title
                  <input required value={exp.mainTitle} onChange={(e) => setExp({ ...exp, mainTitle: e.target.value })} />
                </label>
                <label>
                  User Prompt (for AI Chat)
                  <input required value={exp.userPrompt} onChange={(e) => setExp({ ...exp, userPrompt: e.target.value })} />
                </label>
              </div>
              <div className="ec-form-grid-3">
                <label>
                  Metric 1 ({exp.primaryMetricLabel} $)
                  <input type="number" min={0} value={exp.primaryMetricDollars} onChange={(e) => setExp({ ...exp, primaryMetricDollars: Number(e.target.value) })} />
                </label>
                <label>
                  Metric 2 ({exp.secondaryMetricLabel} $)
                  <input type="number" min={0} value={exp.secondaryMetricDollars} onChange={(e) => setExp({ ...exp, secondaryMetricDollars: Number(e.target.value) })} />
                </label>
                <label>
                  Metric 3 ({exp.tertiaryMetricLabel} $)
                  <input type="number" min={0} value={exp.tertiaryMetricDollars} onChange={(e) => setExp({ ...exp, tertiaryMetricDollars: Number(e.target.value) })} />
                </label>
              </div>
            </div>

            <div className="ec-form-grid-2">
              <div className="ec-form-section is-task">
                <h4>2 · Task (Pending Obligation · Outranks NBA)</h4>
                <label>
                  Task Title
                  <input required value={exp.taskTitle} onChange={(e) => setExp({ ...exp, taskTitle: e.target.value })} />
                </label>
                <label>
                  Summary
                  <input required value={exp.taskSummary} onChange={(e) => setExp({ ...exp, taskSummary: e.target.value })} />
                </label>
                <div className="ec-form-grid-2">
                  <label>
                    CCRE Rule ID
                    <input required value={exp.taskRuleId} onChange={(e) => setExp({ ...exp, taskRuleId: e.target.value })} />
                  </label>
                  <label>
                    sfield Workflow ID
                    <input required value={exp.taskWorkflowId} onChange={(e) => setExp({ ...exp, taskWorkflowId: e.target.value })} />
                  </label>
                </div>
              </div>

              <div className="ec-form-section is-nba">
                <h4>3 · NBA (Ranked Recommendation)</h4>
                <label>
                  NBA Title
                  <input required value={exp.nbaTitle} onChange={(e) => setExp({ ...exp, nbaTitle: e.target.value })} />
                </label>
                <label>
                  Summary
                  <input required value={exp.nbaSummary} onChange={(e) => setExp({ ...exp, nbaSummary: e.target.value })} />
                </label>
                <div className="ec-form-grid-2">
                  <label>
                    Rank Score (0.50–0.99)
                    <input type="number" step="0.01" min={0.5} max={0.99} value={exp.nbaScore} onChange={(e) => setExp({ ...exp, nbaScore: Number(e.target.value) })} />
                  </label>
                  <label>
                    Estimated Value Badge
                    <input required value={exp.nbaEstimatedValue} onChange={(e) => setExp({ ...exp, nbaEstimatedValue: e.target.value })} />
                  </label>
                </div>
              </div>
            </div>

            <div className="ec-form-section">
              <h4>5 · Chrome (Follow-ups &amp; Immutable Disclosure)</h4>
              <div className="ec-form-grid-2">
                <label>
                  Follow-up Chips (comma-separated)
                  <input value={exp.followUpsCsv} onChange={(e) => setExp({ ...exp, followUpsCsv: e.target.value })} />
                </label>
                <label>
                  Mandatory Disclosure
                  <input required value={exp.disclosure} onChange={(e) => setExp({ ...exp, disclosure: e.target.value })} />
                </label>
              </div>
            </div>

            <div className="ec-modal-foot">
              <button type="button" className="ec-pill-btn" onClick={onClose}>Cancel</button>
              <button type="submit" className="ec-btn-primary" disabled={submitting}>
                <Plus size={14} /> {submitting ? "Composing…" : "Create & Compose Live"}
              </button>
            </div>
          </form>
        )}

        {tab === "subject" && (
          <form className="ec-modal-form" onSubmit={(e) => void submitSubject(e)}>
            <div className="ec-form-section">
              <h4>Define New Subject Area &amp; Compile Live smass Customer 360 Model</h4>
              <div className="ec-form-grid-2">
                <label>
                  Subject Area Name
                  <input
                    required
                    value={subLabel}
                    onChange={(e) => {
                      const val = e.target.value;
                      setSubLabel(val);
                      setSubModelId(`${val.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "custom"}_360`);
                    }}
                    placeholder="e.g. Insurance & Protection"
                  />
                </label>
                <label>
                  smass Domain Model ID
                  <input required value={subModelId} onChange={(e) => setSubModelId(e.target.value)} />
                </label>
              </div>
              <label>
                Subject Area Tagline
                <input value={subTagline} onChange={(e) => setSubTagline(e.target.value)} />
              </label>
              <p className="ec-budget-note">
                <Layers size={13} style={{ verticalAlign: "-2px" }} /> Automatically compiles a closed-schema <code>{subModelId}@1.0.0</code> store-backed <code>smass</code> model and seeds a runnable starter experience across all channels.
              </p>
            </div>
            <div className="ec-modal-foot">
              <button type="button" className="ec-pill-btn" onClick={onClose}>Cancel</button>
              <button type="submit" className="ec-btn-primary" disabled={submitting}>
                <Plus size={14} /> {submitting ? "Compiling smass Model…" : "Create Subject Area"}
              </button>
            </div>
          </form>
        )}

        {tab === "channel" && (
          <form className="ec-modal-form" onSubmit={(e) => void submitChannel(e)}>
            <div className="ec-form-section">
              <h4>Define New Channel Surface &amp; 5-Class Arbitration Budget</h4>
              <div className="ec-form-grid-3">
                <label>
                  Channel Name
                  <input required value={chLabel} onChange={(e) => { setChLabel(e.target.value); setChShort(e.target.value.slice(0, 20)); }} />
                </label>
                <label>
                  Pill Short Label
                  <input required value={chShort} onChange={(e) => setChShort(e.target.value)} />
                </label>
                <label>
                  Viewport Frame Style
                  <select value={chFrame} onChange={(e) => setChFrame(e.target.value as "chat" | "web" | "mobile" | "advisor")}>
                    <option value="chat">AI Chat Thread</option>
                    <option value="web">Web Portal (2-Column)</option>
                    <option value="mobile">Mobile Device (375px)</option>
                    <option value="advisor">Advisor Workstation (Full)</option>
                  </select>
                </label>
              </div>
              <div className="ec-form-grid-4">
                <label>
                  Max Tasks (0–5)
                  <input type="number" min={0} max={5} value={chMaxTasks} onChange={(e) => setChMaxTasks(Number(e.target.value))} />
                </label>
                <label>
                  Max NBAs (0–5)
                  <input type="number" min={0} max={5} value={chMaxNba} onChange={(e) => setChMaxNba(Number(e.target.value))} />
                </label>
                <label>
                  Companion Cap (0–8)
                  <input type="number" min={0} max={8} value={chCompanionCap} onChange={(e) => setChCompanionCap(Number(e.target.value))} />
                </label>
                <label>
                  Max Follow-ups (0–5)
                  <input type="number" min={0} max={5} value={chFollowUps} onChange={(e) => setChFollowUps(Number(e.target.value))} />
                </label>
              </div>
              <p className="ec-budget-note">
                Tip: Set <strong>Companion Cap = 1</strong> to enforce strict Task-over-NBA arbitration (holding NBA back until the open Task completes), or set <strong>Companion Cap = 0</strong> for a distraction-free Main-only surface!
              </p>
            </div>
            <div className="ec-modal-foot">
              <button type="button" className="ec-pill-btn" onClick={onClose}>Cancel</button>
              <button type="submit" className="ec-btn-primary" disabled={submitting}>
                <Plus size={14} /> {submitting ? "Creating…" : "Create Channel & Compose"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
