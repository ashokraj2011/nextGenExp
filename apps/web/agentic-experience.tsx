import { createContext, useContext, useId, useState, type FormEvent, type ReactNode } from "react";
import type { z } from "zod";
import type { ActionMessage } from "@a2ui/web_core/v1_0";
import type { InputValues } from "../../packages/contracts/agentic";
import type { contributionSchema, projectionSchema } from "../../packages/capabilities/calculations";
import { formatPortfolioAmount as dollars } from "../../packages/contracts/portfolio";
import { FOLLOW_UP_EVENT, type CapabilityFormProps, type factSummary } from "../../packages/contracts/surface";

type LiveSimValues = { monthlyCents?: number; transferFromCashCents?: number; months?: number };
const LiveSimulationContext = createContext<{
  values: LiveSimValues;
  setValues: (patch: LiveSimValues) => void;
}>({ values: {}, setValues: () => undefined });

export function LiveSimulationProvider({ children }: { children: ReactNode }) {
  const [values, setRaw] = useState<LiveSimValues>({});
  const setValues = (patch: LiveSimValues) => setRaw((prev) => ({ ...prev, ...patch }));
  return <LiveSimulationContext.Provider value={{ values, setValues }}>{children}</LiveSimulationContext.Provider>;
}

export function SavingsChart({
  savedCents,
  targetCents,
  projectedCents,
  monthlyCents,
  months,
  points,
  remainingCents,
  transferFromCashCents = 0,
  portfolioCashBeforeCents,
  portfolioCashAfterCents,
  baselineProjectedCents,
  baselinePoints,
  investingEligibility,
}: z.infer<typeof projectionSchema>) {
  const gradId = useId();
  const { values } = useContext(LiveSimulationContext);

  const activeMonths = values.months !== undefined && values.months >= 1 && values.months <= 120 ? Math.round(values.months) : months;
  const activeMonthly = values.monthlyCents !== undefined && values.monthlyCents >= 0 ? Math.round(values.monthlyCents) : monthlyCents;
  const rawActiveTransfer = values.transferFromCashCents !== undefined && values.transferFromCashCents >= 0
    ? Math.round(values.transferFromCashCents)
    : transferFromCashCents;
  const activeTransfer = portfolioCashBeforeCents !== undefined
    ? Math.min(rawActiveTransfer, portfolioCashBeforeCents)
    : rawActiveTransfer;

  const isPreview = activeMonths !== months || activeMonthly !== monthlyCents || activeTransfer !== transferFromCashCents;

  const verifiedBaselineProjected = baselineProjectedCents ?? (savedCents + monthlyCents * months);
  const verifiedBaselinePoints = baselinePoints ?? points.map(({ month }) => ({ month, savedCents: savedCents + monthlyCents * month }));

  const previewBaselineProjected = savedCents + activeMonthly * activeMonths;
  const previewCombinedProjected = savedCents + activeTransfer + activeMonthly * activeMonths;
  const stepsCount = Math.min(activeMonths, 12);
  const previewBaselinePoints = Array.from({ length: stepsCount + 1 }, (_, i) => {
    const m = Math.round((activeMonths * i) / Math.max(stepsCount, 1));
    return { month: m, savedCents: savedCents + activeMonthly * m };
  });
  const previewCombinedPoints = Array.from({ length: stepsCount + 1 }, (_, i) => {
    const m = Math.round((activeMonths * i) / Math.max(stepsCount, 1));
    return { month: m, savedCents: savedCents + activeTransfer + activeMonthly * m };
  });

  const displayProjected = isPreview ? previewCombinedProjected : projectedCents;
  const displayBaseline = isPreview ? previewBaselineProjected : verifiedBaselineProjected;
  const displayRemaining = Math.max(0, targetCents - displayProjected);
  const displayCashAfter = portfolioCashBeforeCents !== undefined
    ? Math.max(0, portfolioCashBeforeCents - activeTransfer)
    : portfolioCashAfterCents;

  const showDualPaths = activeTransfer > 0 || transferFromCashCents > 0;
  const max = Math.max(
    targetCents,
    projectedCents,
    verifiedBaselineProjected,
    isPreview ? Math.max(previewCombinedProjected, previewBaselineProjected) : 0,
    1,
  );
  const y = (amount: number) => 114 - 92 * amount / max;
  const toPolyline = (pts: { month: number; savedCents: number }[], totalMonths: number) =>
    pts.map(({ month, savedCents: val }) => `${16 + 268 * month / Math.max(totalMonths, 1)},${y(val)}`).join(" ");

  const combinedLine = toPolyline(points, months);
  const baselineLine = toPolyline(verifiedBaselinePoints, months);
  const area = `16,118 ${combinedLine} 284,118`;
  const previewCombinedLine = isPreview ? toPolyline(previewCombinedPoints, activeMonths) : "";
  const previewBaselineLine = isPreview ? toPolyline(previewBaselinePoints, activeMonths) : "";

  const progressPct = Math.min(100, Math.round((displayProjected / Math.max(targetCents, 1)) * 100));
  const thresholdCents = investingEligibility?.thresholdCents ?? 1_000_000;
  const previewEligible = displayCashAfter !== undefined ? displayCashAfter > thresholdCents : undefined;
  const effectiveEligible = isPreview ? previewEligible : investingEligibility?.eligible;

  return <section className={"content-card axe-chart" + (isPreview ? " is-live-preview" : "")} aria-label="Projected savings">
    <header className="axe-card-header">
      <div>
        <span className="axe-card-kicker">
          {isPreview ? "Live Dual-Path Preview · Click Recalculate for Treatment Selector Verification" : "Verified Dual-Path Projection (sfield)"}
        </span>
        <h3>Projected savings</h3>
      </div>
      <span className={"axe-card-badge" + (isPreview ? " is-preview-badge" : "")}>
        {isPreview ? "Previewing · " + progressPct + "%" : `${progressPct}% of target`}
      </span>
    </header>
    <p className="axe-amount">
      {dollars(displayProjected)} <small>in {activeMonths} months</small>
      {showDualPaths && (
        <span className="axe-delta-pill">+{dollars(activeTransfer)} from cash today</span>
      )}
    </p>
    <div className="axe-chart-legend" aria-label="Chart series legend">
      <span className="axe-legend-item">
        <span className={"axe-legend-swatch " + (isPreview ? "is-preview" : "is-combined")} aria-hidden="true" />
        With cash transfer ({dollars(displayProjected)})
      </span>
      <span className="axe-legend-item">
        <span className="axe-legend-swatch is-baseline" aria-hidden="true" />
        Monthly savings only ({dollars(displayBaseline)})
      </span>
      <span className="axe-legend-item">
        <span className="axe-legend-swatch is-target" aria-hidden="true" />
        Goal target ({dollars(targetCents)})
      </span>
    </div>
    <figure>
      <svg viewBox="0 0 300 127" role="img" aria-label={`Projected savings reach ${dollars(displayProjected)} with cash transfer versus ${dollars(displayBaseline)} monthly only. Target ${dollars(targetCents)}.`}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#368727" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#368727" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1="16" x2="284" y1={y(targetCents)} y2={y(targetCents)} stroke="#525150" strokeDasharray="4 4" strokeWidth="1.2" />
        <polygon points={area} fill={`url(#${gradId})`} />
        {showDualPaths && (
          <>
            <polyline points={baselineLine} fill="none" stroke="#64748b" strokeDasharray="3 3" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="284" cy={y(verifiedBaselineProjected)} r="3.4" fill="#64748b" stroke="#fff" strokeWidth="1.4" />
          </>
        )}
        <polyline points={combinedLine} fill="none" stroke="#368727" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="284" cy={y(projectedCents)} r="4.5" fill="#368727" stroke="#fff" strokeWidth="1.8" />
        {isPreview && (
          <>
            <polyline points={previewBaselineLine} fill="none" stroke="#2563eb" strokeDasharray="3 3" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="284" cy={y(previewBaselineProjected)} r="3.4" fill="#2563eb" stroke="#fff" strokeWidth="1.4" />
            <polyline points={previewCombinedLine} fill="none" stroke="#d97706" strokeDasharray="5 4" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="284" cy={y(previewCombinedProjected)} r="4.4" fill="#d97706" stroke="#fff" strokeWidth="1.6" />
          </>
        )}
      </svg>
      <figcaption>
        <span>Today · {dollars(savedCents + activeTransfer)}{activeTransfer > 0 ? ` (incl. ${dollars(activeTransfer)} transfer)` : ""}</span>
        <span>Month {activeMonths} · {dollars(displayProjected)}</span>
      </figcaption>
    </figure>
    <dl className="axe-kpi-strip axe-kpi-strip-4">
      <div><dt>Monthly contribution</dt><dd>{dollars(activeMonthly)}</dd></div>
      <div><dt>Moved from cash</dt><dd>{dollars(activeTransfer)}</dd></div>
      {displayCashAfter !== undefined ? (
        <div><dt>Portfolio cash left</dt><dd>{dollars(displayCashAfter)}</dd></div>
      ) : (
        <div><dt>Target</dt><dd>{dollars(targetCents)}</dd></div>
      )}
      <div><dt>Remaining at mo {activeMonths}</dt><dd>{dollars(isPreview ? displayRemaining : remainingCents)}</dd></div>
    </dl>

    {(investingEligibility || (displayCashAfter !== undefined && isPreview)) && (
      <div className={"axe-ts-verdict " + (effectiveEligible ? "is-eligible" : "is-ineligible")} role="status">
        <div className="axe-ts-verdict-top">
          <strong>
            Cash Investing Card: {effectiveEligible ? "Appears (Eligible)" : "Disappears (Filtered Out)"}
          </strong>
          <span className="axe-ts-verdict-badge">
            {isPreview ? "Live Preview · Click Recalculate to Verify" : "Verified by Treatment Selector"}
          </span>
        </div>
        <p>
          {isPreview
            ? (effectiveEligible
              ? `Hypothetical cash after transfer (${dollars(displayCashAfter ?? 0)}) stays above the ${dollars(thresholdCents)} CCRE rule — click Recalculate so sfield verifies with Treatment Selector.`
              : `Hypothetical cash after transfer (${dollars(displayCashAfter ?? 0)}) drops to or below the ${dollars(thresholdCents)} CCRE rule — click Recalculate so sfield confirms Treatment Selector hides the investing card.`)
            : investingEligibility?.reason}
        </p>
      </div>
    )}

    <p className="disclosure">Assumes equal monthly contributions and no interest, fees or withdrawals. Hypothetical cash transfers are simulated read-only until confirmed.</p>
  </section>;
}

export function SavingsMetric({ months, targetCents, savedCents, monthlyCents }: z.infer<typeof contributionSchema>) {
  return <section className="content-card axe-metric-card" aria-label="Required monthly savings">
    <header className="axe-card-header">
      <div>
        <span className="axe-card-kicker">Savings Target Model</span>
        <h3>Required monthly savings</h3>
      </div>
      <span className="axe-card-badge">{months} mo horizon</span>
    </header>
    <p className="axe-amount">{dollars(monthlyCents)} <small>per month</small></p>
    <p className="content-body">With {dollars(savedCents)} already saved, this would reach {dollars(targetCents)} in {months} months.</p>
    <p className="disclosure">Contributions are rounded up to the nearest cent. Assumes no interest, fees or withdrawals.</p>
  </section>;
}

export function FactSummary({ title, body, facts }: z.infer<typeof factSummary.schema>) {
  return <section className="content-card" aria-label={title}>
    <h3>{title}</h3><p className="content-body">{body}</p>
    {!!facts.length && <dl className="axe-facts">{facts.map(({ label, value }) => (
      <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
    ))}</dl>}
  </section>;
}

const stringValue = ({ field, value }: CapabilityFormProps["fields"][number]) => (
  value === undefined ? "" : String(typeof value === "number" && "unit" in field && field.unit === "cents" ? value / 100 : value)
);

export function CapabilityForm({ props, enabled, dispatch }: {
  props: CapabilityFormProps; enabled: boolean; dispatch(actionId: string, values: InputValues): void;
}) {
  const prefix = useId();
  const { setValues } = useContext(LiveSimulationContext);
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(props.fields.map((item) => [item.field.id, stringValue(item)])));
  const [message, setMessage] = useState("");
  const update = (id: string, value: string, field: CapabilityFormProps["fields"][number]["field"]) => {
    setDraft((previous) => ({ ...previous, [id]: value }));
    if (field.type === "integer" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        if (id === "monthlyCents") setValues({ monthlyCents: Math.round(parsed * (field.unit === "cents" ? 100 : 1)) });
        if (id === "transferFromCashCents") setValues({ transferFromCashCents: Math.round(parsed * (field.unit === "cents" ? 100 : 1)) });
        if (id === "months") setValues({ months: Math.round(parsed) });
      }
    }
  };
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const button = (event.nativeEvent as SubmitEvent).submitter;
    const actionId = button?.getAttribute("data-action") ?? props.actionId;
    const values: InputValues = {};
    for (const { field, choices } of props.fields) {
      const input = draft[field.id]?.trim();
      if (!input && !field.required) continue;
      if (!input || (field.type === "choice" && !choices?.some(({ id }) => id === input))) {
        setMessage("Choose or enter a value for " + field.label.toLowerCase() + ".");
        return;
      }
      values[field.id] = field.type === "integer" ? Math.round(Number(input) * (field.unit === "cents" ? 100 : 1)) : input;
    }
    setMessage("");
    dispatch(actionId, values);
  }
  return <section className="content-card axe-form" aria-label={props.title}>
    <header className="axe-card-header">
      <div>
        <span className="axe-card-kicker">Interactive Canvas (Live Synchronized)</span>
        <h3>{props.title}</h3>
      </div>
    </header>
    <form onSubmit={submit}>
      <fieldset disabled={!enabled}>
        <div className="axe-fields">{props.fields.map(({ field, choices }) => {
          const id = prefix + "-" + field.id;
          const value = draft[field.id] ?? "";
          const common = { id, required: field.required, value, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => update(field.id, event.target.value, field) };
          const isSlider = field.type === "integer" && field.presentation === "slider";
          return <div className={"axe-field" + (isSlider ? " axe-field-slider" : "")} key={field.id}>
            <div className="axe-field-head">
              <label htmlFor={id}>{field.label}{field.type === "integer" && field.unit === "cents" && field.presentation !== "slider" && " (USD)"}</label>
              {isSlider && (() => {
                const scale = field.unit === "cents" ? 100 : 1;
                return <output htmlFor={id}>{field.unit === "cents" ? dollars(Math.round(Number(value || 0) * scale)) : value}</output>;
              })()}
            </div>
            {field.type === "integer" && (() => {
              const scale = field.unit === "cents" ? 100 : 1;
              const bounds = { min: field.min / scale, max: field.max / scale };
              const step = field.id === "transferFromCashCents" ? 500 : (scale === 100 ? 50 : 1);
              return isSlider ? <>
                <input {...common} {...bounds} type="range" step={step} />
                <div className="axe-slider-bounds" aria-hidden="true">
                  <span>{field.unit === "cents" ? dollars(field.min) : field.min}</span>
                  <span>{field.unit === "cents" ? dollars(field.max) : field.max}</span>
                </div>
              </> : <input {...common} {...bounds} type="number" inputMode="decimal" step={1 / scale} />;
            })()}
            {field.type === "choice" && <select {...common}>
              <option value="">Choose a method</option>
              {choices?.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
            </select>}
            {field.type === "text" && <input {...common} type="text" maxLength={field.maxLength} autoComplete="off" />}
          </div>;
        })}</div>
        <div className="axe-form-actions">
          <button type="submit" className="axe-primary-button" data-action={props.actionId}>{props.submitLabel}</button>
          {props.saveActionId && <button type="submit" className="secondary-button" data-action={props.saveActionId}>Save savings plan</button>}
        </div>
      </fieldset>
      {message && <p role="alert" className="request-notice">{message}</p>}
    </form>
  </section>;
}

export function formEnvelope(experienceId: string, componentId: string, actionId: string, values: InputValues): ActionMessage {
  return { version: "1.0", action: {
    name: FOLLOW_UP_EVENT, surfaceId: experienceId, sourceComponentId: componentId,
    timestamp: new Date().toISOString(), context: { actionId, values },
  } };
}
