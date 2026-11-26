import { z } from "zod";
import { adminPaths } from "../../packages/contracts/admin-paths";
import { contextCatalogSchema, propensitySchema } from "../../packages/contracts/domain";
import { decodeChatInput, type InspectorPayload, type RegistryToolPayloads, type TurnExchange } from "../../packages/contracts/inspector";
import { recommendationContextLabel } from "../../packages/contracts/self-service-pzn";
import { diagnosticHref } from "./admin-navigation";
import { FlowSelectionCall, JsonBlock, ModelStage, ReadToolStage } from "./call-logs";
import type { ArchitectureStep, ArchitectureView, ArrowEvidence } from "./help-architecture-steps";
import { FlowSettingsEvidence, RunStatus, SavedJson, type FundingClick, type MarcusRun } from "./help-run-evidence";

type RecordData = NonNullable<MarcusRun["data"]>;

const routerFields = z.object({
  request: z.string(), catalog: contextCatalogSchema,
  intentCatalog: z.array(z.object({ intentId: z.string(), contextId: z.string().nullable(), label: z.string() })),
  customerContext: z.record(z.string(), z.unknown()).optional(), propensity: propensitySchema.optional(),
  recent: z.array(z.unknown()).optional(), summaryFollowUpIntentId: z.string().optional(),
});

function RoutingExplanation({ record }: { record: RecordData }) {
  const { log, trace } = record;
  const stage = log.router;
  const exchange = stage?.attempts.findLast((item) => item.exchange && item.status === "succeeded")?.exchange;
  const input = routerFields.safeParse((exchange && decodeChatInput(exchange)) ?? stage?.saved?.input.data);
  return <section className="sa-routing" aria-label="How intent is derived">
    <h3>How intent is derived</h3>
    {record.turn.semanticRoute && <p>The app first chose <strong>{record.turn.semanticRoute.capabilityLabel}</strong> for this message
      using {record.turn.semanticRoute.method === "deterministic" ? "a routing rule" : "its capability-routing model"}.</p>}
    <p>sfield loads the active topics from TS. It then sends the member ID and those topic IDs to TS for relevance scores.
      The app supplies the allowed intent-to-topic mappings, recent messages and selected profile fields to the Context Router.
      The router proposes an intent or a clarifying question. The app checks the proposal before requesting eligible recommendations.</p>
    {input.success && <>
      <dl><div><dt>Customer message</dt><dd>{input.data.request}</dd></div>
        <div><dt>Verified intent</dt><dd><code>{trace.intentId ?? trace.routeOutcome ?? "Unavailable"}</code></dd></div>
        <div><dt>Topic sent to TS</dt><dd><code>{trace.selectedContextId ?? "None"}</code></dd></div>
      </dl>
      <details className="trace-details"><summary>Topics, supported intents and member scores ({input.data.catalog.contexts.length})</summary>
        <p>Each intent maps to a topic. A topic can support several intents. Scores are hints from TS. A blank score means TS supplied no score for that topic.</p>
        <table><thead><tr><th>Topic</th><th>Supported intents</th><th>Member score</th></tr></thead><tbody>
          {input.data.catalog.contexts.map((topic) => {
            const intents = input.data.intentCatalog.filter((intent) => intent.contextId === topic.contextId);
            const score = input.data.propensity?.scores.find((entry) => entry.contextId === topic.contextId)?.score;
            return <tr key={topic.contextId} data-selected={topic.contextId === trace.selectedContextId}>
              <td>{recommendationContextLabel(topic.contextId, topic.displayName)}<br /><code>{topic.contextId}</code></td>
              <td>{intents.map((intent) => intent.label).join(", ") || "—"}</td><td>{score ?? "—"}</td></tr>;
          })}</tbody></table>
      </details>
      <SavedJson title="Customer fields in the router request" value={input.data.customerContext} open />
      <SavedJson title="Recent chat in the router request" value={input.data.recent} />
      {input.data.summaryFollowUpIntentId && <p>For this follow-up the app also supplied <code>summaryFollowUpIntentId = {input.data.summaryFollowUpIntentId}</code>.</p>}
      {log.treatment?.comparison?.reasons?.length ? <details className="trace-details"><summary>How customer data affected eligibility</summary>
        <JsonBlock title="Member ID and verified topic sent to TS" value={log.treatment.mockInput} open />
        <SavedJson title="Rules matched by TS" value={log.treatment.comparison.reasons} open />
      </details> : null}
    </>}
  </section>;
}

function Pair({ input, output, inputLabel = "Request", outputLabel = "Response" }: {
  input?: InspectorPayload; output?: InspectorPayload; inputLabel?: string; outputLabel?: string;
}) {
  return <div className="sa-pair"><JsonBlock title={inputLabel} value={input} open /><JsonBlock title={outputLabel} value={output} open /></div>;
}

function Exchange({ exchange }: { exchange: TurnExchange }) {
  return <><p><code>{exchange.operation}</code></p><Pair input={exchange.request} output={exchange.response} /></>;
}

function ToolCalls({ calls }: { calls: RegistryToolPayloads[] }) {
  return calls.length ? <ol className="sa-calls" aria-label="Recorded tool calls in order">
    {calls.map((call, index) => <li key={index}><ReadToolStage title={call.tool} stage={call} expanded /></li>)}
  </ol> : <p>No tool call was recorded for this step.</p>;
}

function Submission({ record }: { record: RecordData }) {
  const saved = record.log.handoffs;
  if (saved?.submission) return <Exchange exchange={saved.submission} />;
  return <><p>This run predates HTTP capture. The app saved the accepted input fields and its acceptance event.</p>
    {saved?.acceptedInput ? <Pair inputLabel="Saved input fields" input={saved.acceptedInput} outputLabel="Recorded acceptance event" output={saved.acceptedEvent} />
      : <SavedJson title="Saved customer message" value={record.turn.message} open />}</>;
}

function ArrowPayload({ kind, record }: { kind: ArrowEvidence; record: RecordData }) {
  const { turn, trace, log } = record;
  const saved = log.handoffs;
  const workflow = log.workflow;
  switch (kind) {
    case "submission": case "click": return <Submission record={record} />;
    case "flowList": return <FlowSettingsEvidence log={log} />;
    case "flowRequest": case "flowResponse": return <FlowSelectionCall turn={turn} log={log}
      focus={kind === "flowRequest" ? "request" : "response"} />;
    case "registry": case "discovery": return <>
      <p>TS returns the domain’s active topics. The scoring request then sends Marcus’s member ID and those topic IDs to TS.</p>
      <ToolCalls calls={[log.catalogLookup, log.topicScores].filter((call): call is RegistryToolPayloads => Boolean(call))} />
      {log.topicScores?.mockInput && <JsonBlock title="Member and topics sent to TS for scoring" value={log.topicScores.mockInput} />}
    </>;
    case "router": case "composer": case "fundingModel": return <>{kind === "router" && <RoutingExplanation record={record} />}<ModelStage
      title={kind === "router" ? "Context Router" : kind === "composer" ? "Experience Composer" : "Funding agent"}
      stage={kind === "fundingModel" ? workflow?.agent?.model ?? null : log[kind]} expanded showBodies /></>;
    case "treatment": case "rules": {
      const ts = log.treatment;
      if (!ts) return <p>No Treatment Selector decision was recorded for this turn.</p>;
      return <>
        <p><code>{ts.tool}</code> · {ts.status}</p>
        <Pair inputLabel={ts.inputReconstructed ? "Reconstructed TS request" : "TS request"} input={ts.mockInput}
          outputLabel={ts.error ? "TS error" : "TS response"} output={ts.error ?? ts.result} />
        <JsonBlock title="CCRE rule evaluation" value={ts.ccre} open={kind === "rules"} />
        <SavedJson title="Rules behind the recommendations" value={ts.comparison?.reasons} open />
      </>;
    }
    case "domain": {
      const calls = [log.customerLookup, log.portfolio, log.goal, log.retirementAccounts].filter((call): call is RegistryToolPayloads => Boolean(call));
      return calls.length ? <ToolCalls calls={calls} /> : <><p>Marcus’s address update used the TS decision. No separate domain tool call was recorded on this turn.</p>
        {turn.customerLookup && <SavedJson title="Account context saved by the app" value={turn.customerLookup} open />}</>;
    }
    case "stageResult": return <><p><code>sfield · Experience Composer</code></p>
      <Pair inputLabel="sfield session request" input={log.composer?.session?.request} outputLabel="sfield run output" output={log.composer?.session?.output} />
    </>;
    case "workflow": return <><p>The controller resolves the ID and version from the source TS decision against the definition saved for this click.</p>
      <div className="sa-pair"><SavedJson title="Workflow reference" value={workflow?.recommendation} open />
        <JsonBlock title="Workflow definition used" value={workflow?.definition} open /></div></>;
    case "workflowCalls": return <ToolCalls calls={workflow?.calls ?? []} />;
    case "workflowResult": {
      const last = workflow?.calls.at(-1);
      return <>{last && <ReadToolStage title="Last tool in the recorded execution" stage={last} expanded />}
        {workflow?.agent && <SavedJson title="Funding agent outcome" value={workflow.agent.outcome} open />}
        {!last && !workflow?.agent && <p>No funding result was recorded.</p>}</>;
    }
    case "compile": {
      if (saved?.compiler) return <Exchange exchange={saved.compiler} />;
      return <><p>This run saved the data used to build the card and the resulting surface. The full compiler invocation is unavailable.</p>
        {workflow ? <JsonBlock title="Last funding tool output" value={workflow.calls.at(-1)?.result} open /> :
          <SavedJson title="Verified content order" value={trace.finalOrder} open />}
        <SavedJson title="Compiled surface" value={turn.experience} open /></>;
    }
    case "deliver": return <>
      <JsonBlock title="Recorded experience.ready event" value={saved?.readyEvent} open />
      <p>Help reads the completed turn from the same endpoint as chat.</p><p><code>GET /api/turns/{turn.id}</code></p>
      <SavedJson title="Completed turn response" value={turn} open />
    </>;
    case "render": return <><SavedJson title="Card data delivered to chat" value={turn.experience?.blocks} open />
      <JsonBlock title="Browser render acknowledgement" value={saved?.renderReceipt} open /></>;
    case "settings": return <><p>Configuration is saved in the admin console before chat. This turn retained the settings it used. An admin save has its own lifecycle.</p>
      <JsonBlock title="Domain settings saved with this turn" value={saved?.settings} open /></>;
    case "layout": return <>{trace.uiLayout ? <SavedJson title="Published layout applied to this turn" value={trace.uiLayout} open />
      : <p>This turn used the built-in layout.</p>}<SavedJson title="Components in the saved surface" value={turn.experience?.blocks.map((item) => item.component)} open /></>;
    case "toolSetup": return <>
      <JsonBlock title="Tool settings saved with this turn" value={saved?.settings} open={!workflow} />
      {workflow && <JsonBlock title="Workflow definition used" value={workflow.definition} open />}
    </>;
  }
}

export function ArrowReceipt({ step, view, run, funding }: {
  step: ArchitectureStep; view: ArchitectureView; run: MarcusRun; funding: FundingClick;
}) {
  if (!run.selected || !run.data) return <>{step.kind === "flowList" && <FlowSettingsEvidence />}<RunStatus run={run} /></>;
  const child = view === "funding" || step.kind === "click";
  const sourceLink = diagnosticHref(adminPaths.logs, run.selected.threadId, run.selected.turnId);
  const record = child ? funding.data : run.data;
  return <div className="ts-evidence sa-receipt">
    <header><p><strong>Marcus Reed</strong> · {child ? "Preview funding" : "Address update"}</p>
      <p>“{run.data.turn.message}”</p>
      <a href={sourceLink}>Address update in Logs</a>
      {child && funding.click && <> · <a href={diagnosticHref(adminPaths.logs, run.selected.threadId, funding.click.turnId)}>Funding click in Logs</a></>}
    </header>
    {child && funding.clicks.length > 1 && <label>Recorded funding click <select value={funding.click?.turnId}
      onChange={(event) => funding.choose(event.target.value)}>{funding.clicks.map((click, index) =>
        <option key={click.turnId} value={click.turnId}>{index + 1} · {click.turnId}</option>)}</select></label>}
    {child && funding.error ? <p role="alert">{funding.error} <button type="button" onClick={run.refresh}>Try again</button></p>
      : child && !funding.click ? <p>Marcus has no recorded Preview funding click for this address update. After the click, <button className="ts-inline-button" type="button" onClick={run.refresh}>refresh the run</button>.</p>
      : record ? <ArrowPayload kind={step.kind} record={record} /> : <p role="status">Loading the funding turn…</p>}
  </div>;
}
