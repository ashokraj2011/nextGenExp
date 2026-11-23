import { useId, useState, type FormEvent } from "react";
import type { z } from "zod";
import type { ActionMessage } from "@a2ui/web_core/v1_0";
import type { InputValues } from "../../packages/contracts/agentic";
import type { contributionSchema, projectionSchema } from "../../packages/capabilities/calculations";
import { formatPortfolioAmount as dollars } from "../../packages/contracts/portfolio";
import { FOLLOW_UP_EVENT, type CapabilityFormProps, type factSummary } from "../../packages/contracts/surface";

export function SavingsChart({ savedCents, targetCents, projectedCents, monthlyCents, months, points, remainingCents }: z.infer<typeof projectionSchema>) {
  const max = Math.max(targetCents, projectedCents, 1);
  const y = (amount: number) => 117 - 98 * amount / max;
  const line = points.map(({ month, savedCents }) => 14 + 272 * month / months + "," + y(savedCents)).join(" ");
  return <section className="content-card axe-chart" aria-label="Projected savings">
    <h3>Projected savings</h3>
    <p className="axe-amount">{dollars(projectedCents)} <small>in {months} months</small></p>
    <figure>
      <svg viewBox="0 0 300 127" role="img" aria-label={`Projected savings rise from ${dollars(savedCents)} to ${dollars(projectedCents)}. Target ${dollars(targetCents)}.`}>
        <line x1="14" x2="286" y1={y(targetCents)} y2={y(targetCents)} stroke="var(--muted, #60746b)" strokeDasharray="4 4" />
        <polyline points={line} fill="none" stroke="#276847" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="286" cy={y(projectedCents)} r="4" fill="#276847" />
      </svg>
      <figcaption><span>Today</span><span>Month {months}</span></figcaption>
    </figure>
    <dl className="axe-facts">
      <div><dt>Monthly contribution</dt><dd>{dollars(monthlyCents)}</dd></div>
      <div><dt>Target</dt><dd>{dollars(targetCents)}</dd></div>
      <div><dt>Remaining at month {months}</dt><dd>{dollars(remainingCents)}</dd></div>
    </dl>
    <p className="disclosure">Assumes equal monthly contributions and no interest, fees or withdrawals.</p>
  </section>;
}

export function SavingsMetric({ months, targetCents, savedCents, monthlyCents }: z.infer<typeof contributionSchema>) {
  return <section className="content-card" aria-label="Required monthly savings">
    <h3>Required monthly savings</h3>
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
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(props.fields.map((item) => [item.field.id, stringValue(item)])));
  const [message, setMessage] = useState("");
  const update = (id: string, value: string) => setDraft((previous) => ({ ...previous, [id]: value }));
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
    <h3>{props.title}</h3>
    <form onSubmit={submit}>
      <fieldset disabled={!enabled}>
        <div className="axe-fields">{props.fields.map(({ field, choices }) => {
          const id = prefix + "-" + field.id;
          const value = draft[field.id] ?? "";
          const common = { id, required: field.required, value, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => update(field.id, event.target.value) };
          return <div className="axe-field" key={field.id}>
            <label htmlFor={id}>{field.label}{field.type === "integer" && field.unit === "cents" && field.presentation !== "slider" && " (USD)"}</label>
            {field.type === "integer" && (() => {
              const scale = field.unit === "cents" ? 100 : 1;
              const bounds = { min: field.min / scale, max: field.max / scale };
              return field.presentation === "slider" ? <>
                <output htmlFor={id}>{dollars(Math.round(Number(value || 0) * scale))}</output>
                <input {...common} {...bounds} type="range" step={scale === 100 ? 0.01 : 1} />
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
          <button type="submit" className="secondary-button" data-action={props.actionId}>{props.submitLabel}</button>
          {props.saveActionId && <button type="submit" className="secondary-button" data-action={props.saveActionId}>Save savings plan</button>}
        </div>
      </fieldset>
      {message && <p role="alert">{message}</p>}
    </form>
  </section>;
}

export function formEnvelope(experienceId: string, componentId: string, actionId: string, values: InputValues): ActionMessage {
  return { version: "1.0", action: {
    name: FOLLOW_UP_EVENT, surfaceId: experienceId, sourceComponentId: componentId,
    timestamp: new Date().toISOString(), context: { actionId, values },
  } };
}
