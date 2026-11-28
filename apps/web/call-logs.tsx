import { useEffect, useId, useState } from "react";
import { RotateCw } from "lucide-react";
import type { JsonValue } from "@sfield/core";
import type { DemoPersona, TurnView } from "../../packages/contracts/api";
import type { WorkspaceActionLog } from "../../packages/contracts/workspace";
import { decodeChatInput } from "../../packages/contracts/inspector";
import type {
  GatewayExchange, InspectorPayload, ModelStagePayloads, RegistryToolPayloads, TreatmentPayloads, TurnPayloads, WorkflowPayloads,
} from "../../packages/contracts/inspector";
import { adminPaths } from "../../packages/contracts/admin-paths";
import { formatGlossaryCondition } from "../../packages/contracts/rule-glossary";
import { customerWorkflow } from "../../packages/contracts/customer-workflows";
import { diagnosticHref } from "./admin-navigation";
import { api } from "./api";

export function JsonBlock({ title, value, open = false }: { title: string; value?: InspectorPayload; open?: boolean }) {
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

function ModelExchange({ exchange, error, showBodies }: { exchange: GatewayExchange; error?: InspectorPayload; showBodies?: boolean }) {
  const input = decodeChatInput(exchange);
  const acp = exchange.method === "JSON-RPC";
  const response = exchange.response?.data;
  const message = response && typeof response === "object" && !Array.isArray(response) ? response.message : undefined;
  const output = message && typeof message === "object" && !Array.isArray(message) ? decodeJson(message.content) : undefined;
  return <>
    {exchange.path && <p><code>{exchange.method} {exchange.path}</code></p>}
    {exchange.source === "verified" && <p>Request body verified against the saved digest.</p>}
    <JsonBlock title={acp ? "ACP request" : "Gateway request body"} value={exchange.request} open={showBodies} />
    {input !== undefined && <JsonBlock title="Decoded chat input" value={{ bytes: 0, data: input }} />}
    <JsonBlock title={acp ? error ? "ACP error" : "ACP response" : error ? "Gateway error" : "Gateway response"} value={exchange.response ?? error} open={showBodies} />
    {output && <JsonBlock title="Decoded model output" value={output} open />}
  </>;
}

export function ModelStage({ title, stage, expanded = false, showBodies = false }: { title: string; stage: ModelStagePayloads | null; expanded?: boolean; showBodies?: boolean }) {
  return <details className="trace-details payload-stage" open={expanded}>
    <summary>{title}{stage ? ` · ${stage.attempts.length} ${stage.attempts.length === 1 ? "attempt" : "attempts"}` : " · no call"}</summary>
    {stage ? <>
      {stage.attempts.map((attempt, index) => <details key={attempt.id} className="trace-details" open={stage.attempts.length === 1}>
        <summary>Attempt {index + 1} · {attempt.status}</summary>
        <p><code>{attempt.model}</code></p>
        {attempt.exchange ? <ModelExchange exchange={attempt.exchange} error={attempt.error} showBodies={showBodies} /> : attempt.error ? (
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

function FundingRuleDetails({ check }: { check: NonNullable<TreatmentPayloads["fundingCheck"]> }) {
  const { confirmation } = check;
  return <section className="content-card" aria-label="Funding reminder decision">
    <h3>Funding reminder {check.eligible ? "eligible" : "excluded"}</h3>
    <p>The account portal confirmed the first deposit for <code>{confirmation.mid}</code> on {new Date(confirmation.occurredAt).toLocaleString()}.</p>
    <p>TS evaluated <strong>{check.rule}</strong>. The condition was <code>{check.condition}</code>. The recorded funding status was <strong>{check.actual}</strong>.</p>
    <JsonBlock title="Account portal confirmation" value={{ bytes: 0, data: confirmation }} />
  </section>;
}

function TreatmentStage({ stage, scoring = false }: { stage: TreatmentPayloads | null; scoring?: boolean }) {
  const title = scoring ? "Treatment Selector topic scores" : "Treatment Selector";
  const labels = scoring
    ? { toolRequest: "sfield topic scores request", request: "Mock topic scores request", response: "Topic scores response", error: "Topic scores error" }
    : { toolRequest: "sfield tool request", request: "Mock request", response: "Tool response", error: "Tool error" };
  return <details className="trace-details payload-stage" open={stage?.fundingCheck ? true : undefined}>
    <summary>{title} · {stage?.status ?? "no call"}</summary>
    {stage ? <>
      <p><code>{stage.tool}</code></p>
      {stage.fundingCheck && <FundingRuleDetails check={stage.fundingCheck} />}
      <JsonBlock title={labels.toolRequest} value={stage.registryInput} />
      {stage.mockInput && <JsonBlock title={labels.request} value={stage.mockInput} open />}
      {stage.ccre && <JsonBlock title="Mock CCRE evaluation" value={stage.ccre} />}
      <JsonBlock title={stage.error ? labels.error : labels.response} value={stage.error ?? stage.result} open />
    </> : <p>No Treatment Selector call recorded for this turn.</p>}
  </details>;
}

function DecisionComparison({ stage }: { stage: TreatmentPayloads }) {
  const comparison = stage.comparison;
  if (!comparison) return null;
  const typed = comparison.returned === "decisions";
  return <section className="ts-comparison" aria-label="Treatment Selector response comparison">
    <h3>Treatment Selector decision</h3>
    <p>TS evaluated this member and topic once. sfield received <code>{stage.tool}</code>. The two formats below show that same decision.</p>
    {stage.mockInput && <JsonBlock title="Treatment Selector input" value={stage.mockInput} open />}
    <div className="ts-response-pair">
      <JsonBlock title="Legacy response · content IDs" value={comparison.legacy} open />
      <JsonBlock title={typed ? "New response · content, actions and workflows" : "New response · content and workflows"} value={comparison.workflows} open />
    </div>
    {Boolean(comparison.contentReasons?.length) && <details className="trace-details">
      <summary>Why TS returned the content IDs</summary>
      <ol>{comparison.contentReasons!.map((entry) => <li key={entry.id}><code>{entry.id}</code> · {entry.source}
        {entry.matchingRules.length > 0 && <> · Matched {entry.matchingRules.join(", ")}</>}</li>)}</ol>
    </details>}
    {Boolean(comparison.reasons?.length) && <section className="ts-rule-evidence" aria-label="Rules behind the recommendations">
      <h4>Why TS recommended each next step</h4>
      {comparison.reasons!.map((rule) => <div key={[rule.kind, rule.id, rule.name, ...rule.contentIds].join("/")}>
        <span>{rule.kind === "action" ? "Standalone action" : "Workflow"}</span>
        <strong>{rule.name}</strong>
        <p>Topic <code>{rule.context}</code>{rule.condition?.kind === "attribute" && <> and <code>{formatGlossaryCondition(rule.condition)}</code></>}.
          {rule.kind === "action" && !rule.contentIds.length && " TS can recommend this action on its own."}
          {rule.contentIds.length > 0 && <> Eligible content · {rule.contentIds.map((id) => <code key={id}>{id} </code>)}</>}</p>
        {rule.condition && !["always", "attribute"].includes(rule.condition.kind) && <code>{JSON.stringify(rule.condition)}</code>}
        <p>Recommends <code>{rule.id}@{rule.version}</code></p>
      </div>)}
    </section>}
    {!typed && comparison.rules.map((rule) => <p key={JSON.stringify([rule.name, rule.contentId, rule.workflowId])}>
      <strong>{rule.name}</strong> matched for <code>{rule.contentId}</code> and recommended <code>{rule.workflowId}</code>.
    </p>)}
  </section>;
}

export function ReadToolStage({ title, stage, payloadLabel = title, expanded = false }: { title: string; stage: RegistryToolPayloads; payloadLabel?: string; expanded?: boolean }) {
  return <details className="trace-details payload-stage" open={expanded}>
    <summary>{title} · {stage.status}</summary>
    <p><code>{stage.tool}</code></p>
    <div className={expanded ? "ts-response-pair" : undefined}>
      <JsonBlock title={payloadLabel + " tool request"} value={stage.registryInput} open />
      <JsonBlock title={payloadLabel + (stage.error ? " tool error" : " tool response")} value={stage.error ?? stage.result} open />
    </div>
  </details>;
}

function WorkflowStage({ workflow }: { workflow: WorkflowPayloads }) {
  const { recommendation, definition, calls, agent } = workflow;
  return <details className="trace-details payload-stage" open>
    <summary>{recommendation.id === "account.funding.preview" ? "Funding preview workflow" : customerWorkflow(recommendation)?.label ?? recommendation.id}</summary>
    <p><code>{recommendation.id}@{recommendation.version}</code></p>
    {definition && <JsonBlock title="Workflow definition" value={definition} />}
    {agent && <>
      <p>Agent run <code>{agent.runId}</code>{agent.outcome === "waiting_input" ? " · Waiting for a funding method" : ""}</p>
      {agent.answer && <JsonBlock title="Customer reply that resumed this run" value={agent.answer} />}
      <ModelStage title="Funding agent model" stage={agent.model} />
    </>}
    {calls.length ? <ol className="workflow-call-order" aria-label="sfield calls in execution order">{calls.map((call, index) =>
      <li key={call.tool + ":" + index}><ReadToolStage title={call.label} stage={call} expanded={!agent} /></li>)}</ol>
      : <p>No workflow calls recorded for this turn.</p>}
  </details>;
}

export function SentFlowList({ list }: { list: NonNullable<TurnPayloads["sentFlowList"]> }) {
  return <div className="flow-request-list">
    <h4>Flows in the model request</h4>
    <p>Tenant <code>{list.tenantId}</code> · Domain <code>{list.domainId}</code> · {list.audience === "customer" ? "Customer chat" : "Operator chat"}</p>
    <ol aria-label="Flows in the model request">{list.flowIds.map((id) => <li key={id}><code>{id}</code></li>)}</ol>
  </div>;
}

export function FlowSelectionCall({ turn, log, focus }: {
  turn: TurnView; log: TurnPayloads; focus?: "request" | "response";
}) {
  const exchange = log.handoffs?.flowRouting;
  return <>
    {log.sentFlowList && <SentFlowList list={log.sentFlowList} />}
    {turn.semanticRoute && <><p><strong>{turn.semanticRoute.capabilityLabel}</strong> · <code>{turn.semanticRoute.capabilityId}</code></p>
      <p>{turn.semanticRoute.method === "llm_semantic" ? "Selected by the model" : "Selected by app rules"}. {turn.semanticRoute.reasoning}</p>
      <JsonBlock title="Saved flow decision" value={{ bytes: 0, data: { ...turn.semanticRoute } }} /></>}
    {exchange ? <>
      <p><code>{exchange.operation}</code></p>
      <JsonBlock title="Flow selection request" value={exchange.request} open={focus === "request"} />
      <JsonBlock title="Flow selection response" value={exchange.response} open={focus === "response"} />
    </> : <p>No flow-selection model exchange was captured for this turn.</p>}
  </>;
}

function elapsed(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function CallTimings({ timing }: { timing: NonNullable<TurnPayloads["timing"]> }) {
  const milestones = [
    ["Snapshot published", timing.snapshotReadyAt], ["Portfolio card shown", timing.snapshotDisplayedAt],
    ["Final reply ready", timing.finishedAt], ["Final reply shown", timing.displayedAt],
  ] as const;
  return <section className="turn-timings" aria-label="Call timings">
    <h3>Call timings</h3>
    <p>Times start when the server accepted the message. Display times come from the chat browser.</p>
    <dl>{milestones.map(([label, at]) => at !== undefined && <div key={label}><dt>{label}</dt><dd>{elapsed(at - timing.acceptedAt)}</dd></div>)}</dl>
    {timing.calls.length > 0 && <div className="turn-timings-table"><table aria-label="Recorded call timings">
      <thead><tr><th scope="col">Call</th><th scope="col">Started at</th><th scope="col">Duration</th><th scope="col">Result</th></tr></thead>
      <tbody>{timing.calls.map((call, index) => <tr key={index}>
        <th scope="row">{call.parentLabel && <span aria-hidden="true">↳ </span>}{call.label}</th><td>{elapsed(call.startedAt - timing.acceptedAt)}</td><td>{elapsed(call.durationMs)}</td><td>{call.status}</td>
      </tr>)}</tbody>
    </table></div>}
    {timing.calls.some((call) => call.parentLabel) && <small>The indented model call is included in the customer context check.</small>}
  </section>;
}

function TurnPayloadLog({ turn }: { turn: TurnView }) {
  const [payloads, setPayloads] = useState<TurnPayloads>();
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setFailed(false);
    async function read() {
      try {
        const data = await api.payloads(turn.id);
        if (disposed) return;
        if (data.turnId !== turn.id) { setFailed(true); return; }
        setPayloads(data);
        const timing = data.timing;
        if (timing && (timing.finishedAt === undefined ? turn.status === "working"
          : timing.displayedAt === undefined && Date.now() - timing.finishedAt < 5000)) timer = setTimeout(read, 1000);
      } catch { if (!disposed) setFailed(true); }
    }
    void read();
    return () => { disposed = true; clearTimeout(timer); };
  }, [reload, turn.id, turn.progress, turn.status]);
  return <div className="call-log-list">
    <p>Gateway credentials and configured metadata values are redacted.</p>
    {failed && <div className="call-log-error">
      <p role="alert">The call logs are unavailable.</p>
      <button className="secondary-button" type="button" onClick={() => setReload((attempt) => attempt + 1)}>Retry loading logs</button>
    </div>}
    {payloads ? <>
      {payloads.timing && <CallTimings timing={payloads.timing} />}
      {(turn.semanticRoute || payloads.handoffs?.flowRouting) && <section aria-label="App flow decision">
        <h3>1. App server · Choose the flow</h3>
        <FlowSelectionCall turn={turn} log={payloads} />
      </section>}
      {(payloads.router || payloads.catalogLookup || payloads.topicScores) && <section aria-label="sfield intent decision">
        <h3>{turn.semanticRoute && "2. "}sfield · Identify the intent</h3>
        {payloads.verifiedIntent && <p>Verified intent <code>{payloads.verifiedIntent.intentId}</code>
          {" · "}Treatment Selector topic <code>{payloads.verifiedIntent.contextId}</code></p>}
        {payloads.catalogLookup && <ReadToolStage title="Supported topic catalog" stage={payloads.catalogLookup} />}
        {payloads.topicScores && <TreatmentStage stage={payloads.topicScores} scoring />}
        <ModelStage title="Context Router" stage={payloads.router} />
      </section>}
      {payloads.sourceDecision && <>
        <a href={diagnosticHref(adminPaths.logs, turn.conversationId, payloads.sourceDecision.turnId)}>Source message · {payloads.sourceDecision.message}</a>
        <DecisionComparison stage={payloads.sourceDecision.treatment} />
      </>}
      {payloads.treatment && <DecisionComparison stage={payloads.treatment} />}
      {payloads.workflowClicks?.map((click) => <p key={click.id}>
        <a href={diagnosticHref(adminPaths.logs, turn.conversationId, click.id)}>View sfield calls after {click.label}</a>
      </p>)}
      {payloads.agentic && <details className="trace-details payload-stage" open>
        <summary>Experience Agent and tools</summary>
        <p>Run <code>{payloads.agentic.runId}</code></p>
        {payloads.agentic.model && <ModelStage title="Experience Agent model" stage={payloads.agentic.model} />}
        <ol className="workflow-call-order" aria-label="sfield action calls in execution order">{payloads.agentic.calls.map((call, i) =>
          <li key={call.tool + ":" + i}><ReadToolStage title={call.tool} stage={call} expanded={Boolean(payloads.sourceDecision)} /></li>)}</ol>
      </details>}
      {payloads.interactiveExperience && <section aria-label="Interactive experience">
        <h3>Interactive experience</h3>
        {turn.interactiveExperience?.sourceTurnId && <p><a href={diagnosticHref(adminPaths.logs, turn.conversationId, turn.interactiveExperience.sourceTurnId)}>Open the turn that displayed this action</a></p>}
        <JsonBlock title="Resolved action and inputs" value={payloads.interactiveExperience.invocation} open />
        {payloads.interactiveExperience.call && <ReadToolStage title="sfield integration task" stage={payloads.interactiveExperience.call} expanded />}
        <JsonBlock title="Saved record and run state" value={payloads.interactiveExperience.state} />
      </section>}
      {payloads.customerLookup && <ReadToolStage title="Customer record lookup" stage={payloads.customerLookup} />}
      {payloads.appliedDesign && <section aria-label="Approved design revision">
        <h3>Approved design</h3>
        <p>
          <strong>{payloads.appliedDesign.name}</strong> · Revision <code>{payloads.appliedDesign.revision}</code>{" "}
          (<code>{payloads.appliedDesign.id}</code>)
        </p>
        {payloads.appliedDesign.toolContracts && Object.keys(payloads.appliedDesign.toolContracts).length > 0 && (
          <p>Bound tools: {Object.keys(payloads.appliedDesign.toolContracts).map((ref) => <code key={ref} style={{ marginRight: "6px" }}>{ref}</code>)}</p>
        )}
      </section>}
      {payloads.goalScenario && <section aria-label="Savings scenario">
        <h3>Savings scenario</h3>
        {payloads.goalScenario.design && (
          <p>
            Approved design: <strong>{payloads.goalScenario.design.name}</strong> · Revision <code>{payloads.goalScenario.design.revision}</code>
          </p>
        )}
        <p><a href={diagnosticHref(adminPaths.logs, turn.conversationId, payloads.goalScenario.sourceTurnId)}>Open the original goal turn</a></p>
        <ReadToolStage title="sfield savings projection" stage={payloads.goalScenario.call} expanded />
      </section>}
      {((!payloads.workflow && !payloads.agentic && !payloads.customerLookup && !payloads.interactiveExperience && !payloads.goalScenario)
        || payloads.topicScores || payloads.router || payloads.treatment) && <>
        {!payloads.catalogLookup && !payloads.topicScores && !payloads.router && <ModelStage title="Context Router" stage={null} />}
        {payloads.glossary && <ReadToolStage title="CCRE glossary" payloadLabel="Glossary" stage={payloads.glossary} />}
        {payloads.retirementAccounts && <ReadToolStage title="Retirement account records" stage={payloads.retirementAccounts} />}
        {payloads.portfolio && <ReadToolStage title="Portfolio Snapshot" stage={payloads.portfolio} />}
        <TreatmentStage stage={payloads.treatment} />
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
        {lookup.status === "succeeded" && lookup.ccre?.fundingCheck && <FundingRuleDetails check={lookup.ccre.fundingCheck} />}
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
