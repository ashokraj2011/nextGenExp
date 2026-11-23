import { DecisionTrace } from "./decision-trace";
import { useEffect, useState, type ReactNode } from "react";
import { Code2, FileText } from "lucide-react";
import type { Bootstrap, ConversationView, TurnView } from "../../packages/contracts/api";
import { api, type Trace } from "./api";
import { DeveloperDrawer } from "./developer-drawer";

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
  if (trace.agentic) return <DecisionTrace trace={trace.agentic} />;
  const creatingRule = trace.routeOutcome === "create_rule";
  const elapsed = trace.markers.terminal === undefined ? null : trace.markers.terminal - trace.markers.accepted;
  return <div className="trace-view">
    <section>
      <h3>Routing</h3>
      <dl className="trace-dl">
        {(trace.intentId || creatingRule) && <Detail label="Router intent"><code>{trace.intentId ?? "create_rule"}</code></Detail>}
        {trace.possibleIntentId && <Detail label="Possible intent"><code>{trace.possibleIntentId}</code></Detail>}
        {!creatingRule && <Detail label={selectedContextId ? "Selected topic" : "Routing outcome"}>
          {selectedContextId ?? trace.routeOutcome ?? "Pending"}
        </Detail>}
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
        <summary>Topic relevance scores · {propensity.status}</summary>
        <dl className="trace-dl">{propensity.scores.map(({ contextId, score }) => (
          <Detail key={contextId} label={contextId}>{score === null ? "Unknown" : score.toFixed(2)}</Detail>
        ))}</dl>
        <p><code>{propensity.version}</code></p>
      </details>}
    </section>
    <section>
      <h3>{creatingRule ? "Rule creation" : "Content and layout"}</h3>
      <dl className="trace-dl">
        {!creatingRule && <>
          <Detail label="Selection mode">{trace.selectionMode}</Detail>
          <Detail label="Content decision"><code>{contentDecisionId ?? "Pending"}</code></Detail>
        </>}
        <Detail label="Components">{components?.join(", ") || "None"}</Detail>
        {creatingRule && glossaryVersion && <Detail label="Glossary version"><code>{glossaryVersion}</code></Detail>}
        {!creatingRule && <Detail label="Sample balance lookup">{trace.metricReadSucceeded ? "Succeeded" : "No successful lookup"}</Detail>}
        {portfolioScopeId && <Detail label="Portfolio Snapshot">{trace.portfolioReadSucceeded ? "Succeeded" : "Awaiting snapshot"}</Detail>}
        {trace.goalScopeId && <Detail label="Goal Progress">{trace.goalReadSucceeded ? "Succeeded" : "Awaiting goal progress"}</Detail>}
      </dl>
      {ts && <>
        <dl className="trace-dl"><Detail label="Treatment Selector response">{ts.source === "override" ? "Custom response" : "Default response"}</Detail></dl>
        <details className="trace-details" open>
          <summary>Matching content in order</summary>
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
          {trace.goalScopeId && <Detail label="Goal progress scope"><code>{trace.goalScopeId}</code></Detail>}
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

export function Inspector({ configuration, conversation, latest, close, create, openLogs }: {
  configuration: Bootstrap;
  conversation?: ConversationView;
  latest?: TurnView;
  close: () => void;
  create: (personaId: string, scenarioId: string) => Promise<boolean>;
  openLogs: (turnId: string) => void;
}) {
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

  return <DeveloperDrawer title="Developer inspector" icon={<Code2 size={17} />} closeLabel="Close inspector" close={close}>
    <form className="demo-settings" onSubmit={async (event) => {
      event.preventDefault();
      setCreating(true);
      try { if (await create(personaId, scenarioId)) close(); }
      finally { setCreating(false); }
    }}>
      <h3>Demo setup</h3>
      <label htmlFor="persona">Demo profile</label>
      <select id="persona" value={personaId} onChange={(event) => {
        const next = configuration.personas.find((value) => value.personaId === event.target.value)!;
        setPersonaId(next.personaId);
        if (!next.allowedScenarios.includes(scenarioId)) setScenarioId(next.allowedScenarios[0]);
      }}>{configuration.personas.map((item) => <option key={item.personaId} value={item.personaId}>{item.displayName}</option>)}</select>
      <label htmlFor="scenario">Test case</label>
      <select id="scenario" value={scenarioId} onChange={(event) => setScenarioId(event.target.value)}>
        {configuration.scenarios.filter((item) => persona.allowedScenarios.includes(item.scenarioId))
          .map((item) => <option key={item.scenarioId} value={item.scenarioId}>{item.label}</option>)}
      </select>
      <button className="secondary-button" type="submit" disabled={creating}>Start with these settings</button>
    </form>
    <section className="trace-selector">
      <label htmlFor="trace-turn">Chat message</label>
      {turns.length ? <select id="trace-turn" value={selectedTurn} onChange={(event) => setSelectedTurn(event.target.value)}>
        <option value="">Latest message</option>
        {turns.map((turn, index) => <option value={turn.id} key={turn.id}>{index + 1}. {turn.message.slice(0, 70)}</option>)}
      </select> : <p>Send a question to see its execution trace.</p>}
    </section>
    {displayedTurn && <button className="secondary-button inspector-logs-link" type="button" aria-haspopup="dialog"
      onClick={() => openLogs(displayedTurn.id)}><FileText size={16} aria-hidden="true" />Open call logs</button>}
    {traceError && <p role="alert">The turn trace is unavailable.</p>}
    {trace?.turnId === displayedTurn?.id && trace && <TraceView trace={trace} />}
  </DeveloperDrawer>;
}
