import { useEffect, useId, useState } from "react";
import { RotateCw } from "lucide-react";
import type { JsonValue } from "@sfield/core";
import type { DemoPersona, TurnView } from "../../packages/contracts/api";
import type { WorkspaceActionLog } from "../../packages/contracts/workspace";
import { decodeChatInput } from "../../packages/contracts/inspector";
import type {
  GatewayExchange, InspectorPayload, ModelStagePayloads, RegistryToolPayloads, TreatmentPayloads, TurnPayloads, WorkflowPayloads,
} from "../../packages/contracts/inspector";
import { api } from "./api";

function JsonBlock({ title, value, open = false }: { title: string; value?: InspectorPayload; open?: boolean }) {
  return <details className="trace-details trace-payload" open={open}>
    <summary>{title}</summary>
    {value?.data !== undefined ? <pre tabIndex={0} aria-label={title}><code>{JSON.stringify(value.data, null, 2)}</code></pre>
      : <p>{value ? `Payload exceeds the capture limit (${value.bytes.toLocaleString()} bytes).` : "No payload was recorded."}</p>}
  </details>;
}

function decodeJson(text: unknown): InspectorPayload | undefined {
  if (typeof text !== "string") return;
  try { return { bytes: 0, data: JSON.parse(text) as JsonValue }; }
  catch { return undefined; }
}

function ModelExchange({ exchange, error }: { exchange: GatewayExchange; error?: InspectorPayload }) {
  const input = decodeChatInput(exchange);
  const acp = exchange.method === "JSON-RPC";
  const response = exchange.response?.data;
  const message = response && typeof response === "object" && !Array.isArray(response) ? response.message : undefined;
  const output = message && typeof message === "object" && !Array.isArray(message) ? decodeJson(message.content) : undefined;
  return <>
    {exchange.path && <p><code>{exchange.method} {exchange.path}</code></p>}
    {exchange.source === "verified" && <p>Request body verified against the saved digest.</p>}
    <JsonBlock title={acp ? "ACP request" : "Gateway request body"} value={exchange.request} />
    {input !== undefined && <JsonBlock title="Decoded chat input" value={{ bytes: 0, data: input }} />}
    <JsonBlock title={acp ? error ? "ACP error" : "ACP response" : error ? "Gateway error" : "Gateway response"} value={exchange.response ?? error} />
    {output && <JsonBlock title="Decoded model output" value={output} open />}
  </>;
}

function ModelStage({ title, stage }: { title: string; stage: ModelStagePayloads | null }) {
  return <details className="trace-details payload-stage">
    <summary>{title}{stage ? ` · ${stage.attempts.length} ${stage.attempts.length === 1 ? "attempt" : "attempts"}` : " · no call"}</summary>
    {stage ? <>
      {stage.attempts.map((attempt, index) => <details key={attempt.id} className="trace-details" open={stage.attempts.length === 1}>
        <summary>Attempt {index + 1} · {attempt.status}</summary>
        <p><code>{attempt.model}</code></p>
        {attempt.exchange ? <ModelExchange exchange={attempt.exchange} error={attempt.error} /> : attempt.error ? (
          <JsonBlock title="Gateway error" value={attempt.error} open />
        ) : <p>No gateway body was saved for this attempt.</p>}
      </details>)}
      {stage.saved && <>
        <p>Saved sfield requests and responses.</p>
        <JsonBlock title="Saved agent input" value={stage.saved.input} />
        {stage.saved.responses.map((response, index) => <JsonBlock key={index} title={`Saved response ${index + 1}`} value={response} />)}
      </>}
    </> : <p>No model call recorded for this turn.</p>}
  </details>;
}

function TreatmentStage({ stage, scoring = false }: { stage: TreatmentPayloads | null; scoring?: boolean }) {
  const title = scoring ? "Treatment Selector topic scores" : "Treatment Selector";
  const labels = scoring
    ? { toolRequest: "sfield topic scores request", request: "Mock topic scores request", response: "Topic scores response", error: "Topic scores error" }
    : { toolRequest: "sfield tool request", request: "Mock request", response: "Tool response", error: "Tool error" };
  return <details className="trace-details payload-stage">
    <summary>{title} · {stage?.status ?? "no call"}</summary>
    {stage ? <>
      <p><code>{stage.tool}</code></p>
      <JsonBlock title={labels.toolRequest} value={stage.registryInput} />
      {stage.mockInput && <JsonBlock title={labels.request} value={stage.mockInput} open />}
      {stage.ccre && <JsonBlock title="Mock CCRE evaluation" value={stage.ccre} />}
      <JsonBlock title={stage.error ? labels.error : labels.response} value={stage.error ?? stage.result} open />
    </> : <p>No Treatment Selector call recorded for this turn.</p>}
  </details>;
}

function ReadToolStage({ title, stage, payloadLabel = title }: { title: string; stage: RegistryToolPayloads; payloadLabel?: string }) {
  return <details className="trace-details payload-stage">
    <summary>{title} · {stage.status}</summary>
    <p><code>{stage.tool}</code></p>
    <JsonBlock title={payloadLabel + " tool request"} value={stage.registryInput} open />
    <JsonBlock title={payloadLabel + (stage.error ? " tool error" : " tool response")} value={stage.error ?? stage.result} open />
  </details>;
}

function WorkflowStage({ workflow }: { workflow: WorkflowPayloads }) {
  const { recommendation, definition, calls, agent } = workflow;
  return <details className="trace-details payload-stage" open>
    <summary>Funding preview workflow</summary>
    <p><code>{recommendation.id}@{recommendation.version}</code></p>
    {definition && <JsonBlock title="Workflow definition" value={definition} />}
    {agent && <>
      <p>Agent run <code>{agent.runId}</code>{agent.outcome === "waiting_input" ? " · Waiting for a funding method" : ""}</p>
      {agent.answer && <JsonBlock title="Customer reply that resumed this run" value={agent.answer} />}
      <ModelStage title="Funding agent model" stage={agent.model} />
    </>}
    {calls.length ? calls.map((call, index) => <ReadToolStage key={call.tool + ":" + index} title={call.label} stage={call} />)
      : <p>No workflow calls recorded for this turn.</p>}
  </details>;
}

function TurnPayloadLog({ turn }: { turn: TurnView }) {
  const [payloads, setPayloads] = useState<TurnPayloads>();
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let disposed = false;
    setFailed(false);
    void api.payloads(turn.id).then(
      (data) => {
        if (disposed) return;
        if (data.turnId === turn.id) setPayloads(data);
        else setFailed(true);
      },
      () => { if (!disposed) setFailed(true); },
    );
    return () => { disposed = true; };
  }, [reload, turn.id, turn.progress, turn.status]);
  return <div className="call-log-list">
    <p>Gateway credentials and configured metadata values are redacted.</p>
    {failed && <div className="call-log-error">
      <p role="alert">The call logs are unavailable.</p>
      <button className="secondary-button" type="button" onClick={() => setReload((attempt) => attempt + 1)}>Retry loading logs</button>
    </div>}
    {payloads ? <>
      {payloads.agentic && <details className="trace-details payload-stage" open>
        <summary>Experience Agent and tools</summary>
        <p>Run <code>{payloads.agentic.runId}</code></p>
        {payloads.agentic.model && <ModelStage title="Experience Agent model" stage={payloads.agentic.model} />}
        {payloads.agentic.calls.map((call, i) => <ReadToolStage key={call.tool + ":" + i} title={call.tool} stage={call} />)}
      </details>}
      {((!payloads.workflow && !payloads.agentic) || payloads.topicScores || payloads.router || payloads.treatment) && <>
        {payloads.topicScores && <TreatmentStage stage={payloads.topicScores} scoring />}
        <ModelStage title="Context Router" stage={payloads.router} />
        {payloads.glossary && <ReadToolStage title="CCRE glossary" payloadLabel="Glossary" stage={payloads.glossary} />}
        <TreatmentStage stage={payloads.treatment} />
        {payloads.portfolio && <ReadToolStage title="Portfolio Snapshot" stage={payloads.portfolio} />}
        {payloads.goal && <ReadToolStage title="Goal Progress" stage={payloads.goal} />}
        <ModelStage title="Experience Composer" stage={payloads.composer} />
      </>}
      {payloads.workflow && <WorkflowStage workflow={payloads.workflow} />}
    </> : !failed && <p role="status">Loading call logs…</p>}
  </div>;
}

export function CallLogs({ turns, turnId }: { turns: TurnView[]; turnId?: string }) {
  const selectorId = useId();
  const [selected, setSelected] = useState(turns.some(({ id }) => id === turnId) ? turnId! : "");
  const turn = turns.find((entry) => entry.id === selected) ?? turns.at(-1);

  return <section className="admin-diagnostics-content" aria-label="Call log details">
    {turn ? <>
      <section className="trace-selector call-log-selector">
        <label htmlFor={selectorId}>Chat message</label>
        <select id={selectorId} value={selected} onChange={(event) => setSelected(event.target.value)}>
          <option value="">Latest message</option>
          {turns.map((entry, index) => <option key={entry.id} value={entry.id}>{index + 1}. {entry.message.slice(0, 70)}</option>)}
        </select>
        <p className="call-log-message">{turn.message}</p>
      </section>
      <TurnPayloadLog key={turn.id} turn={turn} />
    </> : <p className="call-log-empty">Send a question to see its call logs.</p>}
  </section>;
}

const lookupTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

export function PendingActionLogs({ profiles }: { profiles: DemoPersona[] }) {
  const selectorId = useId();
  const [logs, setLogs] = useState<WorkspaceActionLog[]>();
  const [selected, setSelected] = useState("");
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setFailed(false);
    void api.pendingActionLogs().then(
      (rows) => {
        if (!active) return;
        setLogs(rows);
        setSelected((id) => rows.some((row) => row.id === id) ? id : "");
      },
      () => { if (active) setFailed(true); },
    );
    return () => { active = false; };
  }, [refresh]);
  const lookup = logs?.find(({ id }) => id === selected) ?? logs?.[0];
  const profileName = (personaId: string) => profiles.find((entry) => entry.personaId === personaId)?.displayName ?? personaId;

  return <>
    <section className="admin-card diagnostics-picker">
      <label htmlFor={selectorId}>Pending action lookup</label>
      <div>
        <select id={selectorId} value={selected} disabled={!logs?.length} onChange={(event) => setSelected(event.target.value)}>
          <option value="">Latest lookup</option>
          {logs?.map(({ id, personaId, createdAt }) => (
            <option key={id} value={id}>{profileName(personaId)} · {lookupTime.format(createdAt)}</option>
          ))}
        </select>
        <button className="secondary-button" type="button" onClick={() => setRefresh((value) => value + 1)}>
          <RotateCw size={15} aria-hidden="true" />Refresh
        </button>
      </div>
    </section>
    <section className="admin-diagnostics-content" aria-label="Pending action call details">
      {failed && <p className="request-notice" role="alert">Couldn’t load pending action logs.</p>}
      {lookup ? <div className="call-log-list">
        <h3>Treatment Selector · {lookup.status}</h3>
        <p>{profileName(lookup.personaId)} · <time dateTime={new Date(lookup.createdAt).toISOString()}>{lookupTime.format(lookup.createdAt)}</time></p>
        <div className="pending-log-payloads" key={lookup.id}>
          <JsonBlock title="Treatment Selector request" value={{ bytes: 0, data: lookup.request }} open />
          {lookup.status === "succeeded"
            ? <JsonBlock title="Treatment Selector response" value={{ bytes: 0, data: lookup.response }} open />
            : <JsonBlock title="Treatment Selector error" value={{ bytes: 0, data: lookup.error }} open />}
        </div>
        {lookup.status === "succeeded" && lookup.ccre && <JsonBlock title="Mock CCRE evaluation" value={{ bytes: 0, data: lookup.ccre }} />}
      </div> : !failed && (logs ? <p className="call-log-empty">Sign in as a customer to see their pending action calls.</p>
        : <p className="call-log-empty" role="status">Loading pending action calls…</p>)}
    </section>
  </>;
}
