import { useEffect, useRef, useState, type ReactNode } from "react";
import { Code2, X } from "lucide-react";
import type { Bootstrap, ConversationView, TurnView } from "../../packages/contracts/api";
import { api, type Trace } from "./api";
import { PayloadInspector } from "./payload-inspector";

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function StageDetails({ title, run, skipped }: { title: string; run: Trace["routeRun"]; skipped?: boolean }) {
  return <section className="trace-stage">
    <h4>{title}</h4>
    {run ? <p>{run.state} · {run.elapsedMs} ms · {run.modelCalls} model {run.modelCalls === 1 ? "call" : "calls"}<br />
      {run.totalTokens.toLocaleString()} tokens ({run.tokensReported ? "reported" : "estimated"}){run.errorCode && <><br /><code>{run.errorCode}</code></>}</p>
      : <p>{skipped ? "Skipped for rule creation" : "Awaiting run"}</p>}
  </section>;
}

function TraceView({ trace }: { trace: Trace }) {
  const {
    catalog, propensity, selectedContextId, surface, sourcePageContext, routeDecisionId, contentDecisionId,
    catalogScopeId, glossaryScopeId, glossaryVersion, tsScopeId, portfolioScopeId, routerRunId, composerRunId, ts, finalOrder, components, failures,
  } = trace;
  const creatingRule = trace.routeOutcome === "create_rule";
  const elapsed = trace.markers.terminal === undefined ? null : trace.markers.terminal - trace.markers.accepted;
  return <div className="trace-view">
    <section>
      <h3>Routing</h3>
      <dl className="trace-dl">
        {creatingRule
          ? <Detail label="Router intent"><code>create_rule</code></Detail>
          : <Detail label="Selected TS context">{selectedContextId ?? trace.routeOutcome ?? "Pending"}</Detail>}
        <Detail label="Delivery surface">{surface}</Detail>
        <Detail label="Source page">{sourcePageContext ?? "No source page"}</Detail>
        <Detail label="Catalog version">{catalog?.catalogVersion ?? "Pending"}</Detail>
        {!creatingRule && <Detail label="Route decision"><code>{routeDecisionId ?? "Pending"}</code></Detail>}
      </dl>
      {catalog && <details className="trace-details">
        <summary>Context catalog · {catalog.contexts.length} active</summary>
        <p><code>{catalog.id}</code></p>
        {catalog.contexts.map((item) => <p key={item.contextId}><strong>{item.displayName}</strong><br />{item.description}</p>)}
      </details>}
      {propensity && <details className="trace-details">
        <summary>Synthetic propensity · {propensity.status}</summary>
        <dl className="trace-dl">{propensity.scores.map(({ contextId, score }) => (
          <Detail key={contextId} label={contextId}>{score === null ? "Unknown" : score.toFixed(2)}</Detail>
        ))}</dl>
        <p><code>{propensity.version}</code></p>
      </details>}
    </section>
    <section>
      <h3>{creatingRule ? "Rule creation" : "Selection and composition"}</h3>
      <dl className="trace-dl">
        {!creatingRule && <>
          <Detail label="Selection mode">{trace.selectionMode}</Detail>
          <Detail label="Content decision"><code>{contentDecisionId ?? "Pending"}</code></Detail>
        </>}
        <Detail label="Components">{components?.join(", ") || "None"}</Detail>
        {creatingRule && glossaryVersion && <Detail label="Glossary version"><code>{glossaryVersion}</code></Detail>}
        {!creatingRule && <Detail label="Synthetic balance read">{trace.metricReadSucceeded ? "Succeeded" : "No successful read"}</Detail>}
        {portfolioScopeId && <Detail label="Portfolio Snapshot">{trace.portfolioReadSucceeded ? "Succeeded" : "Awaiting snapshot"}</Detail>}
      </dl>
      {ts && <>
        <dl className="trace-dl"><Detail label="TS response">{ts.source === "override" ? "Configured mock" : "Built-in fixture"}</Detail></dl>
        <details className="trace-details" open>
          <summary>TS eligibility order</summary>
          {ts.baseline.length ? <ol>{ts.baseline.map((id) => <li key={id}><code>{id}</code></li>)}</ol> : <p>Empty eligible list</p>}
        </details>
        <details className="trace-details">
          <summary>Simulated rejections · {ts.rejections.length}</summary>
          {ts.rejections.length ? <ul>{ts.rejections.map((row) => (
            <li key={row.contentId}><code>{row.contentId}</code><br />{row.reasonCode}</li>
          ))}</ul> : <p>No fixture rejections for this turn.</p>}
        </details>
      </>}
      {finalOrder && <details className="trace-details" open>
        <summary>Final content order</summary>
        {finalOrder.length ? <ol>{finalOrder.map((id) => <li key={id}><code>{id}</code></li>)}</ol> : <p>No selected content</p>}
      </details>}
    </section>
    <section>
      <h3>Execution {elapsed === null ? "" : "· " + elapsed + " ms"}</h3>
      <div className="trace-stages"><StageDetails title="Router" run={trace.routeRun} /><StageDetails title="Composer" run={trace.composeRun} skipped={creatingRule} /></div>
      <details className="trace-details">
        <summary>Execution and run IDs</summary>
        <dl className="trace-dl">
          <Detail label="Catalog scope"><code>{catalogScopeId ?? "Pending"}</code></Detail>
          {glossaryScopeId && <Detail label="Glossary scope"><code>{glossaryScopeId}</code></Detail>}
          {!creatingRule && <Detail label="Selection scope"><code>{tsScopeId ?? "Pending"}</code></Detail>}
          {portfolioScopeId && <Detail label="Portfolio scope"><code>{portfolioScopeId}</code></Detail>}
          <Detail label="Router run"><code>{routerRunId ?? "Pending"}</code></Detail>
          {!creatingRule && <Detail label="Composer run"><code>{composerRunId ?? "Pending"}</code></Detail>}
        </dl>
      </details>
      {failures.length > 0 && <details className="trace-details" open>
        <summary>Validation and failures</summary>
        <ul>{failures.map((item, index) => <li key={index}>{item.stage} · <code>{item.code}</code></li>)}</ul>
      </details>}
    </section>
  </div>;
}

export function Inspector({ configuration, conversation, latest, close, create }: {
  configuration: Bootstrap;
  conversation?: ConversationView;
  latest?: TurnView;
  close: () => void;
  create: (personaId: string, scenarioId: string) => Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [personaId, setPersonaId] = useState(conversation?.personaId ?? configuration.defaultPersonaId);
  const [scenarioId, setScenarioId] = useState(conversation?.scenarioId ?? configuration.defaultScenarioId);
  const [selectedTurn, setSelectedTurn] = useState("");
  const [trace, setTrace] = useState<Trace>();
  const [traceError, setTraceError] = useState(false);
  const [creating, setCreating] = useState(false);
  const turns = conversation?.turns ?? [];
  const displayedTurn = turns.find((turn) => turn.id === selectedTurn) ?? latest;
  const persona = configuration.personas.find((value) => value.personaId === personaId)!;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    if (!displayedTurn) { setTrace(undefined); return; }
    const id = displayedTurn.id;
    let disposed = false;
    setTraceError(false);
    void api.debug(id).then(
      (data) => { if (!disposed) setTrace(data); },
      () => { if (!disposed) setTraceError(true); },
    );
    return () => { disposed = true; };
  }, [displayedTurn?.id, displayedTurn?.progress, displayedTurn?.status, displayedTurn?.feedback]);

  return <dialog className="inspector" ref={dialog} aria-labelledby="inspector-title" onCancel={(event) => { event.preventDefault(); close(); }}
    onClick={(event) => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left) close(); } }}>
    <div className="inspector-heading">
      <span className="inspector-icon"><Code2 size={17} /></span>
      <h2 id="inspector-title">Developer inspector</h2>
      <button className="icon-button" aria-label="Close inspector" onClick={close}><X size={20} /></button>
    </div>
    <div className="inspector-scroll">
      <form className="demo-settings" onSubmit={async (event) => {
        event.preventDefault();
        setCreating(true);
        try { if (await create(personaId, scenarioId)) close(); }
        finally { setCreating(false); }
      }}>
        <h3>Demo setup</h3>
        <label htmlFor="persona">Persona</label>
        <select id="persona" value={personaId} onChange={(event) => {
          const next = configuration.personas.find((value) => value.personaId === event.target.value)!;
          setPersonaId(next.personaId);
          if (!next.allowedScenarios.includes(scenarioId)) setScenarioId(next.allowedScenarios[0]);
        }}>{configuration.personas.map((item) => <option key={item.personaId} value={item.personaId}>{item.displayName}</option>)}</select>
        <label htmlFor="scenario">Scenario</label>
        <select id="scenario" value={scenarioId} onChange={(event) => setScenarioId(event.target.value)}>
          {configuration.scenarios.filter((item) => persona.allowedScenarios.includes(item.scenarioId))
            .map((item) => <option key={item.scenarioId} value={item.scenarioId}>{item.label}</option>)}
        </select>
        <button className="secondary-button" type="submit" disabled={creating}>Start with these settings</button>
      </form>
      <section className="trace-selector">
        <label htmlFor="trace-turn">Turn trace</label>
        {turns.length ? <select id="trace-turn" value={selectedTurn} onChange={(event) => setSelectedTurn(event.target.value)}>
          <option value="">Latest turn</option>
          {turns.map((turn, index) => <option value={turn.id} key={turn.id}>{index + 1}. {turn.message.slice(0, 70)}</option>)}
        </select> : <p>Send a question to see its execution trace.</p>}
      </section>
      {displayedTurn && <PayloadInspector key={displayedTurn.id} turn={displayedTurn} />}
      {traceError && <p role="alert">The turn trace is unavailable.</p>}
      {trace?.turnId === displayedTurn?.id && trace && <TraceView trace={trace} />}
    </div>
  </dialog>;
}
