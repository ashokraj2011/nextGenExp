import type { DecisionEvent, Evidence } from "../../packages/contracts/agentic";

export type AgenticTrace = { events: DecisionEvent[]; evidence: Evidence[] };

function Details({ label, values, open }: { label: string; values: unknown[]; open?: boolean }) {
  return <details className="trace-details" open={open}>
    <summary>{label}</summary>
    {values.length ? <pre aria-label={label} tabIndex={0}>{JSON.stringify(values.length === 1 ? values[0] : values, null, 2)}</pre> : <p>None recorded.</p>}
  </details>;
}

export function DecisionTrace({ trace }: { trace: AgenticTrace }) {
  const items = (...types: string[]) => trace.events.filter(({ type }) => types.includes(type)).map(({ detail }) => detail).filter(Boolean);
  return <section className="axe-trace" aria-label="Experience decision trace">
    <h3>Experience decision trace</h3>
    <Details label="Customer goal" values={items("goal.interpreted", "goal.completed", "goal.saved")} open />
    <Details label="Execution plan" values={items("plan.created", "plan.revised", "plan.rejected", "plan.independent_steps_verified", "plan.coverage_validated")} />
    <Details label="Eligibility" values={items("eligibility.evaluated", "eligibility.granted", "recommendation.suppressed")} />
    <Details label="Capabilities" values={items("capability.discovered", "capability.rejected")} />
    <Details label="Evidence" values={trace.evidence} />
    <Details label="Journey" values={items("journey.checkpoint", "journey.paused", "journey.resumed", "journey.event_applied")} />
    <Details label="Model UI proposal" values={items("experience.proposed")} />
    <Details label="Verified Experience IR" values={items("experience.verified")} />
    <Details label="Model usage" values={items("model.usage")} />
    <details className="trace-details">
      <summary>Event order</summary>
      <ol>{trace.events.map(({ sequence, type }) => <li key={sequence}><code>{type}</code></li>)}</ol>
    </details>
  </section>;
}
