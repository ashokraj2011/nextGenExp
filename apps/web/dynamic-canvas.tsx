import { useId, useMemo, useState } from "react";
import { ArrowUpRight, BookmarkPlus, Check, CheckCircle2, Clock, Database, Plus, RotateCcw, ShieldAlert, Sparkles, Target, Trash2, XCircle } from "lucide-react";
import type { DynamicCanvasNode, DynamicCanvasProps } from "../../packages/contracts/dynamic-canvas";
import type { WidgetDraft } from "../../packages/contracts/widget";
import { api } from "./api";
import { notifyDomainDataUpdated } from "./domain-pack-ui";
import { TradeTicketNode } from "./trade-ticket";
import { WorkflowRunnerNode } from "./workflow-runner";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const PIE_PALETTE = ["#2f7d32", "#476b8a", "#c88a2b", "#0d9488", "#6d5bd0", "#c2410c", "#0284c7", "#64748b"];

function PieChartNode({ node, onFollowUp }: { node: Extract<DynamicCanvasNode, { type: "piechart" }>; onFollowUp?: (prompt: string) => void }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const activeIdx = hoverIdx ?? selectedIdx;
  const total = Math.max(node.slices.reduce((sum, s) => sum + Math.max(0, s.value), 0), 0.0001);
  const radius = 64;
  const circumference = 2 * Math.PI * radius;

  let offset = 0;
  const segments = node.slices.map((slice, idx) => {
    const fraction = Math.max(0, slice.value) / total;
    const pct = Math.round(fraction * 1000) / 10;
    const length = fraction * circumference;
    const dashOffset = -offset;
    offset += length;
    const color = slice.color && /^#[0-9a-f]{3,8}$/i.test(slice.color)
      ? slice.color
      : PIE_PALETTE[idx % PIE_PALETTE.length];
    return { ...slice, idx, pct, length, dashOffset, color };
  });

  const focused = activeIdx !== null ? segments[activeIdx] : null;
  const selected = selectedIdx !== null ? segments[selectedIdx] : null;
  const centerTop = focused ? focused.label : (node.centerLabel ?? "Total");
  const centerMain = focused ? `${focused.pct}%` : (node.centerValue ?? usd.format(total));
  const centerSub = focused ? focused.displayValue : `${segments.length} segments`;

  return (
    <div className="dyn-piechart">
      {node.title && <h4>{node.title}</h4>}
      <div className="dyn-pie-layout">
        <div className="dyn-pie-visual">
          <svg viewBox="0 0 180 180" className="dyn-pie-svg" role="img" aria-label={node.title || "Pie chart"}>
            <circle cx="90" cy="90" r={radius} fill="none" stroke="var(--line)" strokeWidth="26" />
            {segments.map((seg) => (
              <circle
                key={seg.label}
                cx="90"
                cy="90"
                r={radius}
                fill="none"
                stroke={seg.color}
                strokeWidth={activeIdx === seg.idx ? 30 : 26}
                strokeDasharray={`${Math.max(seg.length - 1.5, 0)} ${circumference}`}
                strokeDashoffset={seg.dashOffset}
                transform="rotate(-90 90 90)"
                className="dyn-pie-slice"
                onMouseEnter={() => setHoverIdx(seg.idx)}
                onMouseLeave={() => setHoverIdx(null)}
                onClick={() => setSelectedIdx((cur) => (cur === seg.idx ? null : seg.idx))}
              >
                <title>{`${seg.label}: ${seg.displayValue} (${seg.pct}%) — Click to drill down`}</title>
              </circle>
            ))}
          </svg>
          <div className="dyn-pie-center" aria-live="polite">
            <span className="dyn-pie-center-label">{centerTop}</span>
            <strong className="dyn-pie-center-value">{centerMain}</strong>
            <small className="dyn-pie-center-sub">{centerSub}</small>
          </div>
        </div>
        <ul className="dyn-pie-legend">
          {segments.map((seg) => (
            <li
              key={seg.label}
              className={activeIdx === seg.idx ? "is-active" : ""}
              onMouseEnter={() => setHoverIdx(seg.idx)}
              onMouseLeave={() => setHoverIdx(null)}
              onClick={() => setSelectedIdx((cur) => (cur === seg.idx ? null : seg.idx))}
            >
              <span className="dyn-pie-swatch" style={{ background: seg.color }} aria-hidden="true" />
              <span className="dyn-pie-legend-name">{seg.label}</span>
              <span className="dyn-pie-legend-pct">{seg.pct}%</span>
              <strong>{seg.displayValue}</strong>
            </li>
          ))}
        </ul>
      </div>
      {selected && onFollowUp && (
        <div className="dyn-drill-bar" role="region" aria-label={`Drill-down actions for ${selected.label}`}>
          <span className="dyn-drill-label">
            <span className="dyn-pie-swatch" style={{ background: selected.color }} aria-hidden="true" />
            <strong>{selected.label}</strong> ({selected.displayValue} · {selected.pct}%)
          </span>
          <div className="dyn-drill-actions">
            <button type="button" onClick={() => onFollowUp(`Show a detailed breakdown of ${selected.label} in my portfolio`)}>
              Drill into {selected.label} <ArrowUpRight size={12} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => onFollowUp(`Compare ${selected.label} against the rest of my portfolio side-by-side`)}>
              Compare side-by-side
            </button>
            <button type="button" onClick={() => onFollowUp("Show my stock holdings as a bubble chart")}>
              As Bubble Chart
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function BubbleChartNode({ node, onFollowUp }: { node: Extract<DynamicCanvasNode, { type: "bubblechart" }>; onFollowUp?: (prompt: string) => void }) {
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const activeIdx = hoverIdx ?? selectedIdx;

  const xs = node.points.map((p) => p.x);
  const ys = node.points.map((p) => p.y);
  const sizes = node.points.map((p) => Math.max(1, p.size));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const maxSize = Math.max(...sizes, 1);

  const padX = (maxX - minX) * 0.16 || Math.max(1, Math.abs(maxX) * 0.25);
  const padY = (maxY - minY) * 0.18 || Math.max(1, Math.abs(maxY) * 0.25);
  const x0 = minX - padX;
  const x1 = maxX + padX;
  const y0 = minY - padY;
  const y1 = maxY + padY;

  const plotL = 56;
  const plotR = 524;
  const plotT = 22;
  const plotB = 224;
  const mapX = (x: number) => plotL + ((x - x0) / Math.max(0.0001, x1 - x0)) * (plotR - plotL);
  const mapY = (y: number) => plotB - ((y - y0) / Math.max(0.0001, y1 - y0)) * (plotB - plotT);
  const mapR = (size: number) => 12 + Math.sqrt(Math.max(0, size) / maxSize) * 24;

  const plotted = node.points.map((pt, idx) => ({
    ...pt,
    idx,
    cx: mapX(pt.x),
    cy: mapY(pt.y),
    r: mapR(pt.size),
    color: pt.color && /^#[0-9a-f]{3,8}$/i.test(pt.color) ? pt.color : PIE_PALETTE[idx % PIE_PALETTE.length],
  }));

  const focused = activeIdx !== null ? plotted[activeIdx] : null;
  const selected = selectedIdx !== null ? plotted[selectedIdx] : null;

  return (
    <div className="dyn-bubblechart">
      <div className="dyn-bubble-head">
        {node.title && <h4>{node.title}</h4>}
        {node.sizeLabel && <span className="dyn-bubble-size-hint">Bubble size: {node.sizeLabel}</span>}
      </div>
      <div className="dyn-bubble-canvas">
        <svg viewBox="0 0 560 264" className="dyn-bubble-svg" role="img" aria-label={node.title || "Bubble chart"}>
          {[0, 0.25, 0.5, 0.75, 1].map((t) => {
            const gy = plotB - t * (plotB - plotT);
            return <line key={"hy" + t} x1={plotL} y1={gy} x2={plotR} y2={gy} className="dyn-bubble-grid" />;
          })}
          {[0, 0.25, 0.5, 0.75, 1].map((t) => {
            const gx = plotL + t * (plotR - plotL);
            return <line key={"hx" + t} x1={gx} y1={plotT} x2={gx} y2={plotB} className="dyn-bubble-grid" />;
          })}
          <line x1={plotL} y1={plotB} x2={plotR} y2={plotB} className="dyn-bubble-axis" />
          <line x1={plotL} y1={plotT} x2={plotL} y2={plotB} className="dyn-bubble-axis" />
          <text x={(plotL + plotR) / 2} y={254} className="dyn-bubble-axis-label">{node.xLabel}</text>
          <text x={18} y={(plotT + plotB) / 2} transform={`rotate(-90 18 ${(plotT + plotB) / 2})`} className="dyn-bubble-axis-label">{node.yLabel}</text>

          {plotted.map((pt) => {
            const isActive = activeIdx === pt.idx;
            return (
              <g
                key={pt.label}
                className="dyn-bubble-point"
                onMouseEnter={() => setHoverIdx(pt.idx)}
                onMouseLeave={() => setHoverIdx(null)}
                onClick={() => setSelectedIdx((cur) => (cur === pt.idx ? null : pt.idx))}
              >
                <circle
                  cx={pt.cx}
                  cy={pt.cy}
                  r={isActive ? pt.r + 3 : pt.r}
                  fill={pt.color}
                  fillOpacity={isActive ? 0.88 : 0.68}
                  stroke={pt.color}
                  strokeWidth={isActive ? 2.5 : 1.5}
                >
                  <title>{`${pt.label}: ${pt.xDisplay}, ${pt.yDisplay}${pt.sizeDisplay ? ` · ${pt.sizeDisplay}` : ""}`}</title>
                </circle>
                <text x={pt.cx} y={pt.cy + 4} className="dyn-bubble-label">{pt.label}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="dyn-bubble-readout" aria-live="polite">
        {focused ? (
          <>
            <span className="dyn-pie-swatch" style={{ background: focused.color }} aria-hidden="true" />
            <strong>{focused.label}</strong>
            {focused.category && <span className="dyn-bubble-cat">{focused.category}</span>}
            <span>{node.xLabel}: <b>{focused.xDisplay}</b></span>
            <span>{node.yLabel}: <b>{focused.yDisplay}</b></span>
            {focused.sizeDisplay && <span>{node.sizeLabel ?? "Value"}: <b>{focused.sizeDisplay}</b></span>}
          </>
        ) : (
          <span className="dyn-bubble-hint">Hover or click any bubble to inspect metrics and drill down.</span>
        )}
      </div>
      {selected && onFollowUp && (
        <div className="dyn-drill-bar" role="region" aria-label={`Drill-down actions for ${selected.label}`}>
          <span className="dyn-drill-label">
            <span className="dyn-pie-swatch" style={{ background: selected.color }} aria-hidden="true" />
            <strong>{selected.label}</strong> {selected.sizeDisplay ? `(${selected.sizeDisplay})` : ""}
          </span>
          <div className="dyn-drill-actions">
            <button type="button" onClick={() => onFollowUp(`Show full details for ${selected.label} in my portfolio`)}>
              Inspect {selected.label} <ArrowUpRight size={12} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => onFollowUp("Show my portfolio allocation as a pie chart")}>
              View as Pie Chart
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const GOAL_PRESETS: Array<{ label: string; name: string; category: "emergency" | "education" | "retirement" | "travel" | "home"; targetUsd: number; monthlyUsd: number }> = [
  { label: "Emergency Fund", name: "Emergency Reserve", category: "emergency", targetUsd: 35000, monthlyUsd: 800 },
  { label: "College 529", name: "College 529 Fund", category: "education", targetUsd: 80000, monthlyUsd: 650 },
  { label: "Early Retirement", name: "Early Retirement Fund", category: "retirement", targetUsd: 500000, monthlyUsd: 2500 },
  { label: "Travel / Sabbatical", name: "Sabbatical & Travel", category: "travel", targetUsd: 20000, monthlyUsd: 600 },
];

function GoalCreatorNode({ node, onFollowUp }: { node: Extract<DynamicCanvasNode, { type: "goal_creator" }>; onFollowUp?: (prompt: string) => void }) {
  const [goals, setGoals] = useState(node.goals);
  const [name, setName] = useState(node.suggestedName ?? "");
  const [category, setCategory] = useState<"home" | "retirement" | "education" | "emergency" | "travel" | "custom">(node.suggestedCategory ?? "emergency");
  const [targetUsd, setTargetUsd] = useState(String(node.suggestedTargetUsd ?? 35000));
  const [savedUsd, setSavedUsd] = useState("5000");
  const [monthlyUsd, setMonthlyUsd] = useState("750");
  const [targetDate, setTargetDate] = useState("2029-06-01");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [receipt, setReceipt] = useState<string | null>(null);

  const parsedTarget = Math.max(100, Number(targetUsd) || 0);
  const parsedSaved = Math.max(0, Number(savedUsd) || 0);
  const parsedMonthly = Math.max(0, Number(monthlyUsd) || 0);
  const monthsRemaining = parsedMonthly > 0 ? Math.ceil(Math.max(0, parsedTarget - parsedSaved) / parsedMonthly) : null;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setNotice("Enter a name for your goal."); return; }
    setBusy(true);
    setNotice("");
    try {
      const res = await api.createGoal({
        personaId: node.personaId,
        name: name.trim(),
        category,
        targetCents: Math.round(parsedTarget * 100),
        savedCents: Math.round(parsedSaved * 100),
        monthlyContributionCents: Math.round(parsedMonthly * 100),
        targetDate,
      });
      setGoals(res.goals);
      setReceipt(`Saved "${res.goal.name}" (${usd.format(res.goal.targetCents / 100)} target)${res.sfieldRunId ? ` · sfieldRunId ${res.sfieldRunId.slice(0, 14)}` : ""}`);
      setName("");
      notifyDomainDataUpdated();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not save goal.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(goalId: string) {
    setBusy(true);
    try {
      const res = await api.deleteGoal(goalId, node.personaId);
      setGoals(res.goals);
      notifyDomainDataUpdated();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not remove goal.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dyn-goal-creator">
      <div className="dyn-goal-existing">
        <h4><Target size={15} aria-hidden="true" /> Tracked Goals ({goals.length})</h4>
        <div className="dyn-goal-list">
          {goals.map((g) => {
            const pct = Math.min(100, Math.round((g.savedCents / Math.max(1, g.targetCents)) * 100));
            return (
              <div key={g.id} className="dyn-goal-item">
                <div className="dyn-goal-item-head">
                  <div>
                    <strong>{g.name}</strong>
                    <span className="dyn-goal-cat">{g.category}</span>
                  </div>
                  <div className="dyn-goal-item-right">
                    <span>{pct}%</span>
                    {!g.builtIn && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove ${g.name}`}
                        title="Remove goal"
                        disabled={busy}
                        onClick={() => void handleDelete(g.id)}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
                <div className="dyn-bar-track" aria-hidden="true">
                  <span className="is-highlight" style={{ width: `${Math.max(3, pct)}%` }} />
                </div>
                <div className="dyn-progress-foot">
                  <span>{usd.format(g.savedCents / 100)} saved · +{usd.format(g.monthlyContributionCents / 100)}/mo</span>
                  <span>Target {usd.format(g.targetCents / 100)} by {g.targetDate}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <form className="dyn-goal-form" onSubmit={handleCreate}>
        <h4><Plus size={15} aria-hidden="true" /> Create a New Goal</h4>
        <div className="dyn-goal-presets">
          {GOAL_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className="dyn-goal-preset-chip"
              onClick={() => {
                setName(p.name);
                setCategory(p.category);
                setTargetUsd(String(p.targetUsd));
                setMonthlyUsd(String(p.monthlyUsd));
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="dyn-goal-inputs">
          <label>
            <span>Goal name *</span>
            <input type="text" placeholder="e.g. College 529 Fund" maxLength={64} required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <span>Category</span>
            <select value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
              <option value="emergency">Emergency</option>
              <option value="education">Education</option>
              <option value="retirement">Retirement</option>
              <option value="home">Home</option>
              <option value="travel">Travel</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label>
            <span>Target amount ($)</span>
            <input type="number" min={100} step={100} required value={targetUsd} onChange={(e) => setTargetUsd(e.target.value)} />
          </label>
          <label>
            <span>Starting saved ($)</span>
            <input type="number" min={0} step={100} value={savedUsd} onChange={(e) => setSavedUsd(e.target.value)} />
          </label>
          <label>
            <span>Monthly contribution ($)</span>
            <input type="number" min={0} step={50} value={monthlyUsd} onChange={(e) => setMonthlyUsd(e.target.value)} />
          </label>
          <label>
            <span>Target date</span>
            <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
          </label>
        </div>
        <div className="dyn-goal-footer">
          <span className="dyn-goal-pace">
            {monthsRemaining === null
              ? "Add a monthly contribution to estimate your completion pace."
              : monthsRemaining === 0
                ? "Target already funded!"
                : `Estimated pace: ~${monthsRemaining} month${monthsRemaining === 1 ? "" : "s"} (${(monthsRemaining / 12).toFixed(1)} yrs)`}
          </span>
          <button type="submit" className="primary-button" disabled={busy || !name.trim()}>
            {busy ? "Saving…" : "Create Goal"}
          </button>
        </div>
        {notice && <p className="dyn-form-error" role="alert">{notice}</p>}
        {receipt && (
          <div className="dyn-form-submitted" role="status">
            <strong><CheckCircle2 size={14} aria-hidden="true" /> Goal Created via sfield</strong>
            <p>{receipt}</p>
            {onFollowUp && (
              <button type="button" className="secondary-button" onClick={() => onFollowUp("Show my portfolio and goals summary")}>
                View updated summary <ArrowUpRight size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </form>
    </div>
  );
}

function formatUnit(value: number, unit: "usd" | "percent" | "years") {
  if (unit === "usd") return usd.format(value);
  if (unit === "percent") return `${value}%`;
  return `${value} yr${value === 1 ? "" : "s"}`;
}

function SliderCalculatorNode({ node }: { node: Extract<DynamicCanvasNode, { type: "sliders" }> }) {
  const [values, setValues] = useState<Record<string, number>>(() => (
    Object.fromEntries(node.inputs.map((item) => [item.id, item.value]))
  ));

  const computed = useMemo(() => {
    const amount = values.amount ?? 0;
    const monthly = values.monthly ?? 0;
    const rate = (values.rate ?? 5) / 100;
    const years = Math.max(1, values.years ?? 10);

    if (node.formula === "annual_yield") {
      const base = amount || monthly * 12;
      const annual = Math.round(base * rate);
      return { primary: usd.format(annual), detail: `${usd.format(Math.round(annual / 12))}/mo illustrative income` };
    }
    if (node.formula === "simple_total") {
      const total = Math.round(amount + monthly * years * 12);
      return { primary: usd.format(total), detail: `Over ${years} yr${years === 1 ? "" : "s"} (without compounding)` };
    }
    const months = Math.round(years * 12);
    const r = rate / 12;
    const futureLump = amount * Math.pow(1 + r, months);
    const futureMonthly = r > 0 ? monthly * ((Math.pow(1 + r, months) - 1) / r) : monthly * months;
    const total = Math.round(futureLump + futureMonthly);
    const contributed = Math.round(amount + monthly * months);
    return { primary: usd.format(total), detail: `Includes +${usd.format(Math.max(0, total - contributed))} illustrative growth` };
  }, [node.formula, values]);

  return (
    <div className="dyn-sliders">
      {node.title && <h4>{node.title}</h4>}
      <div className="dyn-slider-grid">
        {node.inputs.map((input) => {
          const val = values[input.id] ?? input.value;
          return (
            <label key={input.id} className="dyn-slider-tile">
              <span className="dyn-slider-head">
                <span>{input.label}</span>
                <strong>{formatUnit(val, input.unit)}</strong>
              </span>
              <input
                type="range"
                min={input.min}
                max={input.max}
                step={input.step}
                value={val}
                onChange={(event) => setValues((prev) => ({ ...prev, [input.id]: Number(event.target.value) }))}
              />
              <span className="dyn-slider-bounds" aria-hidden="true">
                <span>{formatUnit(input.min, input.unit)}</span>
                <span>{formatUnit(input.max, input.unit)}</span>
              </span>
            </label>
          );
        })}
      </div>
      <div className="dyn-slider-result">
        <span>{node.resultLabel}</span>
        <strong>{computed.primary}</strong>
        <small>{computed.detail}</small>
      </div>
    </div>
  );
}

function ChecklistNode({ node }: { node: Extract<DynamicCanvasNode, { type: "checklist" }> }) {
  const [done, setDone] = useState<Record<number, boolean>>({});
  const completed = node.items.filter((_, idx) => done[idx]).length;
  return (
    <div className="dyn-checklist">
      {node.title && <h4>{node.title}</h4>}
      <ol>
        {node.items.map((item, idx) => (
          <li key={idx} className={done[idx] ? "is-done" : ""}>
            <label>
              <input type="checkbox" checked={Boolean(done[idx])} onChange={(e) => setDone((prev) => ({ ...prev, [idx]: e.target.checked }))} />
              <span>{item}</span>
            </label>
          </li>
        ))}
      </ol>
      <small>{completed} of {node.items.length} completed</small>
    </div>
  );
}

function DynamicFormNode({ node, onFollowUp }: {
  node: Extract<DynamicCanvasNode, { type: "form" }>;
  onFollowUp?: (prompt: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const init: Record<string, string | boolean> = {};
    for (const f of node.fields) {
      if (f.type === "checkbox") init[f.id] = f.defaultValue === "true";
      else if (f.type === "select") init[f.id] = f.defaultValue ?? f.options?.[0] ?? "";
      else init[f.id] = f.defaultValue ?? "";
    }
    return init;
  });
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const missing = node.fields.filter((f) => {
      if (!f.required) return false;
      const v = values[f.id];
      return f.type === "checkbox" ? v !== true : !String(v ?? "").trim();
    });
    if (missing.length > 0) {
      setError(`Please complete: ${missing.map((f) => f.label).join(", ")}`);
      return;
    }
    setError("");
    const summary = node.fields.map((f) => {
      const v = values[f.id];
      const formatted = f.type === "checkbox" ? (v ? "Yes" : "No")
        : f.type === "currency" && String(v ?? "").trim() ? `$${String(v).replace(/^\$/, "")}`
        : String(v ?? "—");
      return `${f.label}: ${formatted}`;
    }).join(" · ");
    setSubmitted(summary);
    onFollowUp?.(`Submitted "${node.title || "Form"}" — ${summary}`);
  }

  return (
    <div className="dyn-form-node">
      {node.title && <h4>{node.title}</h4>}
      {submitted ? (
        <div className="dyn-form-submitted" role="status">
          <strong><CheckCircle2 size={15} aria-hidden="true" />Submitted</strong>
          <p>{submitted}</p>
        </div>
      ) : (
        <form className="dyn-form-grid" onSubmit={submit}>
          {node.fields.map((f) => {
            const v = values[f.id];
            if (f.type === "checkbox") {
              return (
                <label key={f.id} className="dyn-form-check">
                  <input type="checkbox" checked={Boolean(v)} onChange={(e) => setValues((p) => ({ ...p, [f.id]: e.target.checked }))} />
                  <span>{f.label}{f.required ? " *" : ""}</span>
                </label>
              );
            }
            return (
              <label key={f.id} className="dyn-form-field">
                <span>{f.label}{f.required ? " *" : ""}</span>
                {f.type === "select" ? (
                  <select value={String(v ?? "")} onChange={(e) => setValues((p) => ({ ...p, [f.id]: e.target.value }))}>
                    {(f.options ?? []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                ) : (
                  <input
                    type={f.type === "date" ? "date" : f.type === "number" || f.type === "currency" ? "number" : "text"}
                    step="any"
                    value={String(v ?? "")}
                    placeholder={f.placeholder ?? (f.type === "currency" ? "0.00" : "")}
                    onChange={(e) => setValues((p) => ({ ...p, [f.id]: e.target.value }))}
                  />
                )}
              </label>
            );
          })}
          {error && <p className="dyn-form-error" role="alert">{error}</p>}
          <div>
            <button type="submit" className="axe-primary-button">{node.submitLabel}</button>
          </div>
        </form>
      )}
    </div>
  );
}

function ApprovalNode({ node, onFollowUp }: {
  node: Extract<DynamicCanvasNode, { type: "approval" }>;
  onFollowUp?: (prompt: string) => void;
}) {
  const [decision, setDecision] = useState<"pending" | "approved" | "rejected" | "queued">(node.initialDecision ?? "pending");
  const [saving, setSaving] = useState(false);
  const [liveMessage, setLiveMessage] = useState<string>(node.decisionNote ?? "");
  const [error, setError] = useState("");
  const [comment, setComment] = useState("");

  async function decide(next: "approved" | "rejected", queueOnly = false) {
    if (saving) return;
    setError("");
    const verb = next === "approved" ? node.approveLabel : node.rejectLabel;
    if (node.approvalId) {
      setSaving(true);
      try {
        const res = await api.decideApproval(node.approvalId, {
          decision: next === "approved" ? "approve" : "deny",
          actor: undefined,
          ...(comment.trim() ? { comment: comment.trim() } : {}),
        });
        const apr = res.approval;
        setDecision(next);
        if (next === "approved" && apr.executionResult) {
          setLiveMessage(
            `${apr.executionResult.summary} · sfield run ${apr.executionResult.sfieldRunId}${apr.executionResult.auditId ? ` · audit ${apr.executionResult.auditId}` : ""}`,
          );
        } else {
          setLiveMessage(`Approval ${apr.id} ${apr.status} by ${apr.decidedBy ?? "operator"}.`);
        }
        notifyDomainDataUpdated();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not record approval decision.");
      } finally {
        setSaving(false);
      }
      return;
    }
    if (node.domain === "ops_incident" && node.recordId) {
      setSaving(true);
      try {
        const res = await api.decideIncident(node.recordId, {
          decision: next === "approved" ? "approve_rollback" : "reject_rollback",
          expectedUpdatedAt: node.expectedUpdatedAt,
          ...(queueOnly ? { queueForApproval: true } : {}),
        });
        if (res.status === "pending_approval" && res.approval) {
          setDecision("queued");
          setLiveMessage(`Queued for HITL review (${res.approval.id}) · Review in /admin/logs?source=approvals or type "show pending approvals" in Chat.`);
          notifyDomainDataUpdated();
          return;
        }
        const inc = res.incident;
        setDecision(next);
        setLiveMessage(
          next === "approved"
            ? `Live store updated · ${inc.id} status is now "${inc.status.replace("_", " ")}" · Error rate dropped to ${inc.errorRatePct}% (p95 ${inc.p95LatencyMs}ms).`
            : `Live store updated · ${inc.id} status is now "${inc.status.replace("_", " ")}" · Rollback held for live trace inspection.`,
        );
        notifyDomainDataUpdated();
        onFollowUp?.(
          next === "approved"
            ? `Approved rollback for ${inc.id} — refresh the IT incident triage dashboard with live status`
            : `Held rollback for ${inc.id} — show the updated incident timeline and queue`,
        );
      } catch {
        setError("Could not persist decision to the live incident store. Please retry.");
      } finally {
        setSaving(false);
      }
      return;
    }
    if (node.domain === "sales_deal" && node.recordId) {
      setSaving(true);
      try {
        const res = await api.decideDeal(node.recordId, {
          decision: next === "approved" ? "approve_discount" : "reject_discount",
          expectedUpdatedAt: node.expectedUpdatedAt,
          ...(queueOnly ? { queueForApproval: true } : {}),
        });
        if (res.status === "pending_approval" && res.approval) {
          setDecision("queued");
          setLiveMessage(`Queued for HITL review (${res.approval.id}) · Review in /admin/logs?source=approvals or type "show pending approvals" in Chat.`);
          notifyDomainDataUpdated();
          return;
        }
        const deal = res.deal;
        setDecision(next);
        setLiveMessage(
          next === "approved"
            ? `Live CRM updated · ${deal.id} (${deal.accountName}) moved to "${deal.stage}" · Win probability ${deal.winProbabilityPct}%.`
            : `Live CRM updated · ${deal.id} discount held — counter-offer at standard 15% cap requested.`,
        );
        notifyDomainDataUpdated();
        onFollowUp?.(
          next === "approved"
            ? `Approved discount for ${deal.id} — refresh the Q4 deal desk dashboard with live status`
            : `Held discount for ${deal.id} — show the live sales pipeline breakdown and deal table`,
        );
      } catch {
        setError("Could not persist decision to the live CRM deal store. Please retry.");
      } finally {
        setSaving(false);
      }
      return;
    }
    setDecision(next);
    onFollowUp?.(`Decision recorded for "${node.title}": ${verb}`);
  }

  return (
    <div className={"dyn-approval is-" + decision}>
      <div className="dyn-approval-head">
        <div>
          <h4>{node.title}</h4>
          {node.requester && <span className="dyn-approval-req">Requested by {node.requester}</span>}
          {node.approvalId && (
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "4px", fontSize: "0.74rem", opacity: 0.85 }}>
              <code>{node.approvalId}</code>
              {node.sfieldToolRef && <code>{node.sfieldToolRef}</code>}
              {node.payloadDigest && <code>sha256:{node.payloadDigest.slice(0, 12)}</code>}
              {node.dualControl && <strong>4-eyes dual control</strong>}
            </div>
          )}
        </div>
        {node.riskLevel && (
          <span className={"dyn-risk-pill risk-" + node.riskLevel}>
            <ShieldAlert size={12} aria-hidden="true" />{node.riskLevel} risk
          </span>
        )}
      </div>
      <p className="dyn-approval-summary">{node.summary}</p>
      <dl className="dyn-approval-details">
        {node.details.map((d) => (
          <div key={d.label}><dt>{d.label}</dt><dd>{d.value}</dd></div>
        ))}
      </dl>
      {error && <p className="dyn-form-error" role="alert">{error}</p>}
      {decision === "pending" ? (
        <div style={{ display: "grid", gap: "10px" }}>
          {node.approvalId && (
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.3fr)", gap: "8px" }}>
              <label className="dyn-form-field">
                <span>Decision note (optional)</span>
                <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Reason or ticket ref" />
              </label>
            </div>
          )}
          <div className="dyn-approval-actions">
            <button type="button" className="axe-primary-button" disabled={saving} onClick={() => void decide("approved")}>
              <CheckCircle2 size={14} aria-hidden="true" />{saving ? "Executing…" : node.approveLabel}
            </button>
            <button type="button" className="secondary-button" disabled={saving} onClick={() => void decide("rejected")}>
              <XCircle size={14} aria-hidden="true" />{node.rejectLabel}
            </button>
            {!node.approvalId && (node.domain === "ops_incident" || node.domain === "sales_deal") && (
              <button type="button" className="secondary-button" disabled={saving} onClick={() => void decide("approved", true)}>
                <Clock size={14} aria-hidden="true" />Queue for Admin Review
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="dyn-approval-result" role="status">
          {decision === "approved"
            ? <><CheckCircle2 size={15} aria-hidden="true" /><strong>Approved &amp; Executed</strong> — {liveMessage || `${node.approveLabel} recorded.`}</>
            : decision === "queued"
              ? <><Clock size={15} aria-hidden="true" /><strong>Queued for Approval</strong> — {liveMessage}</>
              : <><XCircle size={15} aria-hidden="true" /><strong>Held / Denied</strong> — {liveMessage || `${node.rejectLabel} recorded.`}</>}
        </div>
      )}
    </div>
  );
}

function TimelineNode({ node }: { node: Extract<DynamicCanvasNode, { type: "timeline" }> }) {
  return (
    <div className="dyn-timeline">
      {node.title && <h4>{node.title}</h4>}
      <ol className="dyn-timeline-list">
        {node.events.map((ev, idx) => (
          <li key={idx} className={"dyn-tl-item status-" + ev.status}>
            <span className="dyn-tl-dot" aria-hidden="true" />
            <div className="dyn-tl-body">
              <div className="dyn-tl-top">
                <span className="dyn-tl-time"><Clock size={12} aria-hidden="true" />{ev.time}</span>
                {ev.owner && <span className="dyn-tl-owner">{ev.owner}</span>}
                <span className={"dyn-tl-status st-" + ev.status}>{ev.status}</span>
              </div>
              <strong>{ev.title}</strong>
              {ev.detail && <p>{ev.detail}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function canvasToWidgetDraft(props: DynamicCanvasProps): WidgetDraft {
  const firstMetrics = props.nodes.find((n) => n.type === "metrics");
  const firstSliders = props.nodes.find((n) => n.type === "sliders");
  const firstGoal = props.nodes.find((n) => n.type === "progress");
  const firstCompare = props.nodes.find((n) => n.type === "comparison");
  const firstChecklist = props.nodes.find((n) => n.type === "checklist");

  if (firstSliders && firstSliders.type === "sliders") {
    return {
      name: props.title.slice(0, 72),
      kind: "calculator",
      prompt: props.prompt ?? props.title,
      badge: props.badge.slice(0, 40),
      title: props.title.slice(0, 90),
      body: (props.subtitle ?? "Interactive calculator generated dynamically by CEP.").slice(0, 320),
      ctaLabel: "Explore in chat",
      accentTop: true,
      recommendedComponent: "PznCapabilityForm",
      sliders: firstSliders.inputs.map((inp) => ({ ...inp, unit: inp.unit })),
    };
  }
  if (firstCompare && firstCompare.type === "comparison") {
    return {
      name: props.title.slice(0, 72),
      kind: "comparison",
      prompt: props.prompt ?? props.title,
      badge: props.badge.slice(0, 40),
      title: props.title.slice(0, 90),
      body: (props.subtitle ?? "Dynamic side-by-side comparison generated by CEP.").slice(0, 320),
      ctaLabel: "Compare in chat",
      accentTop: true,
      recommendedComponent: "PznComparison",
      columns: firstCompare.columns.map((c) => ({ title: c.title.slice(0, 48), points: c.points.slice(0, 5).map((p) => p.slice(0, 120)) })),
    };
  }
  if (firstGoal && firstGoal.type === "progress") {
    return {
      name: props.title.slice(0, 72),
      kind: "goal",
      prompt: props.prompt ?? props.title,
      badge: props.badge.slice(0, 40),
      title: props.title.slice(0, 90),
      body: (props.subtitle ?? firstGoal.label).slice(0, 320),
      ctaLabel: "Review goal plan",
      accentTop: true,
      recommendedComponent: "PznGoalProgress",
      goal: { saved: firstGoal.current, target: firstGoal.target, unitLabel: "target" },
    };
  }
  if (firstChecklist && firstChecklist.type === "checklist") {
    return {
      name: props.title.slice(0, 72),
      kind: "checklist",
      prompt: props.prompt ?? props.title,
      badge: props.badge.slice(0, 40),
      title: props.title.slice(0, 90),
      body: (props.subtitle ?? "Guided interactive checklist generated by CEP.").slice(0, 320),
      ctaLabel: "Start steps",
      accentTop: true,
      recommendedComponent: "PznStepList",
      steps: firstChecklist.items.slice(0, 6).map((s) => s.slice(0, 140)),
    };
  }
  if (firstMetrics && firstMetrics.type === "metrics") {
    return {
      name: props.title.slice(0, 72),
      kind: "kpi",
      prompt: props.prompt ?? props.title,
      badge: props.badge.slice(0, 40),
      title: props.title.slice(0, 90),
      body: (props.subtitle ?? "Dynamic metrics card generated by CEP.").slice(0, 320),
      ctaLabel: "Analyze metrics",
      accentTop: true,
      recommendedComponent: "PznPortfolioSnapshot",
      metrics: firstMetrics.items.map((m) => ({ label: m.label, value: m.value.slice(0, 32), ...(m.delta ? { delta: m.delta.slice(0, 24) } : {}) })),
    };
  }
  return {
    name: props.title.slice(0, 72),
    kind: "advisory",
    prompt: props.prompt ?? props.title,
    badge: props.badge.slice(0, 40),
    title: props.title.slice(0, 90),
    body: (props.subtitle ?? props.disclaimer).slice(0, 320),
    ctaLabel: "Explore details",
    accentTop: true,
    recommendedComponent: "PznContentCard",
  };
}

export function DynamicCanvasBlock(props: DynamicCanvasProps & { onFollowUp?: (prompt: string) => void }) {
  const titleId = useId();
  const [savedState, setSavedState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  async function saveWidget() {
    if (savedState === "saving" || savedState === "saved") return;
    setSavedState("saving");
    try {
      await api.saveWidgetLibrary({ operation: "save", widget: canvasToWidgetDraft(props) });
      setSavedState("saved");
    } catch {
      setSavedState("error");
    }
  }

  return (
    <section className="content-card dynamic-canvas" aria-labelledby={titleId}>
      <header className="dyn-canvas-header">
        <div>
          <div className="dyn-canvas-kicker-row">
            <span className="dyn-canvas-kicker">
              <Sparkles size={13} aria-hidden="true" />
              {props.badge} · {props.generatedBy === "llm" ? "Dynamic LLM UI" : "Dynamic Canvas"}
            </span>
            {props.dataSource && (
              <span className="dyn-live-badge" title={`Grounded in ${props.dataSource}`}>
                <Database size={12} aria-hidden="true" />
                Live data · {props.dataSource}
              </span>
            )}
          </div>
          <h3 id={titleId}>{props.title}</h3>
          {props.subtitle && <p className="dyn-canvas-subtitle">{props.subtitle}</p>}
        </div>
        <div className="dyn-header-actions">
          {!(props.recordId?.startsWith("wdg_") || props.dataSource?.startsWith("Widget Library")) && (
            <button
              type="button"
              className="dyn-save-btn"
              disabled={savedState === "saving" || savedState === "saved"}
              onClick={() => void saveWidget()}
            >
              {savedState === "saved"
                ? <><Check size={14} aria-hidden="true" />Saved to Library</>
                : <><BookmarkPlus size={14} aria-hidden="true" />{savedState === "saving" ? "Saving…" : "Save to Library"}</>}
            </button>
          )}
        </div>
      </header>

      {props.harnessTrace && (
        <details
          className="dyn-harness-trace"
          open={props.harnessTrace.repaired || props.harnessTrace.stages.some((s) => s.stage === "clarify")}
        >
          <summary>
            <span className="dyn-harness-summary-main">
              <Sparkles size={12} aria-hidden="true" />
              <strong>Thinking</strong>
              <span className="dyn-harness-chain">
                sfield Harness · {props.harnessTrace.stages.map((s) => s.stage.charAt(0).toUpperCase() + s.stage.slice(1)).join(" → ")}
                {props.harnessTrace.repaired ? " (auto-repaired)" : ""}
              </span>
            </span>
            {props.harnessTrace.thinking && (
              <span className="dyn-harness-preview">{props.harnessTrace.thinking}</span>
            )}
          </summary>
          <div className="dyn-harness-body">
            {props.harnessTrace.thinking && (
              <p className="dyn-harness-thought">{props.harnessTrace.thinking}</p>
            )}
            <p className="dyn-harness-goal">
              <strong>Goal:</strong> {props.harnessTrace.resolvedGoal}
              {props.harnessTrace.harnessRunId && <small style={{ marginLeft: 8, opacity: 0.7 }}>({props.harnessTrace.harnessRunId})</small>}
            </p>
            <ol className="dyn-harness-steps">
              {props.harnessTrace.stages.map((step, idx) => (
                <li key={idx} className={"is-" + step.status}>
                  <span className="dyn-harness-stage">{step.stage}</span>
                  <span>
                    {step.summary}
                    {step.thinking && <small className="dyn-harness-step-thought">{step.thinking}</small>}
                  </span>
                  {step.durationMs !== undefined && <small>{step.durationMs}ms</small>}
                </li>
              ))}
            </ol>
          </div>
        </details>
      )}

      {props.choices?.length ? (
        <div className="composer-starters" aria-label="Choose an option">
          {props.choices.map((r) => (
            <button
              key={r.id}
              type="button"
              className="starter"
              disabled={!props.onFollowUp}
              onClick={() => props.onFollowUp?.(r.prompt ?? ("Show " + r.id))}
            >
              {r.prompt ? r.label : `${r.label} · ${r.id}`}
            </button>
          ))}
        </div>
      ) : null}
      <div className="dyn-canvas-nodes">
        {props.nodes.map((node, idx) => {
          if (node.type === "metrics") {
            return (
              <dl key={idx} className="dyn-metrics-grid">
                {node.items.map((item) => (
                  <div key={item.label}>
                    <dt>{item.label}</dt>
                    <dd>
                      <strong>{item.value}</strong>
                      {item.delta && <span>{item.delta}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            );
          }
          if (node.type === "table") {
            return (
              <div key={idx} className="dyn-table-wrap">
                {node.caption && <h4>{node.caption}</h4>}
                <table className="dyn-table">
                  <thead>
                    <tr>{node.columns.map((col) => <th key={col}>{col}</th>)}</tr>
                  </thead>
                  <tbody>
                    {node.rows.map((row, rIdx) => (
                      <tr
                        key={rIdx}
                        className={props.onFollowUp ? "dyn-table-row-clickable" : undefined}
                        title={props.onFollowUp ? `Click to drill into ${row[0]}` : undefined}
                        onClick={() => props.onFollowUp?.(`Show details and analysis for ${row[0]}`)}
                      >
                        {row.map((cell, cIdx) => <td key={cIdx}>{cell}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          if (node.type === "barchart") {
            const max = Math.max(...node.bars.map((b) => b.value), 1);
            return (
              <div key={idx} className="dyn-barchart">
                {node.title && <h4>{node.title}</h4>}
                <ul className="dyn-bar-list">
                  {node.bars.map((bar) => (
                    <li key={bar.label}>
                      <div className="dyn-bar-row">
                        <span>{bar.label}</span>
                        <strong>{bar.displayValue}</strong>
                      </div>
                      <div className="dyn-bar-track" aria-hidden="true">
                        <span className={bar.highlight ? "is-highlight" : ""} style={{ width: `${Math.max(4, Math.round((bar.value / max) * 100))}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          }
          if (node.type === "piechart") return <PieChartNode key={idx} node={node} onFollowUp={props.onFollowUp} />;
          if (node.type === "bubblechart") return <BubbleChartNode key={idx} node={node} onFollowUp={props.onFollowUp} />;
          if (node.type === "goal_creator") return <GoalCreatorNode key={idx} node={node} onFollowUp={props.onFollowUp} />;
          if (node.type === "progress") {
            const pct = Math.min(100, Math.round((node.current / Math.max(node.target, 1)) * 100));
            return (
              <div key={idx} className="dyn-progress">
                <div className="dyn-progress-head">
                  <span>{node.label}</span>
                  <strong>{pct}%</strong>
                </div>
                <div className="dyn-bar-track" aria-hidden="true">
                  <span className="is-highlight" style={{ width: `${pct}%` }} />
                </div>
                <div className="dyn-progress-foot">
                  <span>{node.currentDisplay}</span>
                  <span>Target: {node.targetDisplay}</span>
                </div>
              </div>
            );
          }
          if (node.type === "sliders") return <SliderCalculatorNode key={idx} node={node} />;
          if (node.type === "comparison") {
            return (
              <div key={idx} className="compare-grid">
                {node.columns.map((col) => (
                  <section key={col.title} className="compare-column">
                    <h4>{col.title}</h4>
                    <ul className="dyn-compare-list">
                      {col.points.map((pt) => <li key={pt}>{pt}</li>)}
                    </ul>
                  </section>
                ))}
              </div>
            );
          }
          if (node.type === "checklist") return <ChecklistNode key={idx} node={node} />;
          if (node.type === "form") return <DynamicFormNode key={idx} node={node} onFollowUp={props.onFollowUp} />;
          if (node.type === "approval") return <ApprovalNode key={idx} node={node} onFollowUp={props.onFollowUp} />;
          if (node.type === "timeline") return <TimelineNode key={idx} node={node} />;
          if (node.type === "trade_ticket") return <TradeTicketNode key={idx} node={node} onFollowUp={props.onFollowUp} />;
          if (node.type === "workflow_runner") return <WorkflowRunnerNode key={idx} node={node} />;
          return (
            <div key={idx} className={"dyn-callout dyn-callout-" + node.tone}>
              {node.title && <strong>{node.title}</strong>}
              <p>{node.body}</p>
            </div>
          );
        })}
      </div>

      <footer className="dyn-canvas-footer">
        <p className="disclosure">{props.disclaimer}</p>
        {props.suggestedFollowUp && props.recommendationSource && props.onFollowUp && (
          <div className="dyn-provider-rec">
            <span className="dyn-provider-rec-badge">
              <Sparkles size={11} aria-hidden="true" />
              {props.recommendationSource}
            </span>
            <button type="button" className="secondary-button" onClick={() => props.onFollowUp!(props.suggestedFollowUp!)}>
              {props.recommendationLabel || props.suggestedFollowUp} <ArrowUpRight size={14} aria-hidden="true" />
            </button>
          </div>
        )}
      </footer>
    </section>
  );
}
