import { useEffect, useState } from "react";
import type { JsonValue } from "@sfield/core";
import { adminPaths } from "../../packages/contracts/admin-paths";
import { capabilityRef } from "../../packages/contracts/agentic";
import { customerWorkflow } from "../../packages/contracts/customer-workflows";
import { chatTreatmentSchema, fundingPreviewWorkflow, type ActionRecommendation, type TreatmentDecision, type WorkflowCandidate } from "../../packages/contracts/funding-workflow";
import { decodeChatInput, type OfferClick, type TreatmentPayloads, type TreatmentRun, type TurnPayloads } from "../../packages/contracts/inspector";
import { formatGlossaryCondition } from "../../packages/contracts/rule-glossary";
import { api, toolSetupErrorMessage } from "./api";
import { diagnosticHref } from "./admin-navigation";
import { FlowSelectionCall, JsonBlock, ModelStage, ReadToolStage, SentFlowList } from "./call-logs";

type NextStepRecommendation = ActionRecommendation | WorkflowCandidate;


function useRead<T>(key: string, revision: number, read: (key: string) => Promise<T>) {
  const [result, setResult] = useState<{ key: string; revision: number; data?: T; error?: string }>();
  useEffect(() => {
    if (!key) return;
    let current = true;
    void read(key).then(
      (data) => { if (current) setResult({ key, revision, data }); },
      (reason) => { if (current) setResult({ key, revision, error: toolSetupErrorMessage(reason) }); },
    );
    return () => { current = false; };
  }, [key, revision, read]);
  return result?.key === key && result.revision === revision ? result : undefined;
}

async function readRuns(query: string) {
  return api.treatmentRuns("demo-new-account", "address-update", new URLSearchParams(query).get("turn") ?? undefined);
}

async function readSource(id: string) {
  const [turn, log, trace] = await Promise.all([api.turn(id), api.payloads(id), api.debug(id)]);
  if (turn.id !== id || log.turnId !== id || trace.turnId !== id) throw new Error("The saved turn could not be matched.");
  return { turn, log, trace };
}

export function useMarcusRun() {
  const [sourceQuery] = useState(() => new URLSearchParams(location.search));
  const [revision, setRevision] = useState(0);
  const [choice, setChoice] = useState("");
  const [recommendationKey, chooseRecommendation] = useState("");
  const pin = sourceQuery.get("turn") || undefined;
  const listing = useRead(pin ? new URLSearchParams({ turn: pin }).toString() : "recent", revision, readRuns);
  const rows = listing?.data;
  const runs = pin && sourceQuery.has("thread") ? rows?.filter((r) => r.threadId === sourceQuery.get("thread")) : rows;
  const selected = runs?.find((run) => run.turnId === choice)
    ?? runs?.find(({ clicks }) => clicks.some((c) => c.kind === "action" && c.id === "account.address.prepare")
      && clicks.some((c) => c.kind === "workflow" && c.id === "account.funding.preview"))
    ?? runs?.[0];
  const source = useRead(selected?.turnId ?? "", revision, readSource);
  return { runs, pin, selected, data: source?.data, error: listing?.error || source?.error, revision,
    choose: setChoice, refresh: () => setRevision((n) => n + 1), recommendationKey, chooseRecommendation };
}
export type MarcusRun = ReturnType<typeof useMarcusRun>;

export function useFundingClick(run: MarcusRun, enabled: boolean) {
  const [choice, choose] = useState("");
  const clicks = run.selected?.clicks.filter((click) => matches(fundingPreviewWorkflow.recommendation, click)) ?? [];
  const click = clicks.find((item) => item.turnId === choice) ?? clicks[0];
  const record = useRead(enabled && click ? click.turnId : "", run.revision, readSource);
  const data = record?.data;
  const mismatch = data && (data.turn.conversationId !== run.selected?.threadId
    || (data.log.sourceDecision && data.log.sourceDecision.turnId !== run.selected?.turnId)
    || (data.log.workflow && !matches(fundingPreviewWorkflow.recommendation, data.log.workflow.recommendation)));
  return { clicks, click, choose, data: mismatch ? undefined : data,
    error: mismatch ? "The saved funding turn belongs to a different decision." : record?.error };
}
export type FundingClick = ReturnType<typeof useFundingClick>;

export function RunStatus({ run }: { run: MarcusRun }) {
  if (run.error) return <p role="alert">{run.error} <button type="button" className="ts-inline-button" onClick={run.refresh}>Try again</button></p>;
  if (!run.runs || run.selected) return <p role="status">Loading the recorded run…</p>;
  return <p>{run.pin ? "This saved Marcus address-update turn is unavailable." : "No Marcus address-update run is available in this workspace."}{" "}
    {run.pin ? <a href={adminPaths.help + "#ts-sfield"}>Browse available runs</a> : <>
      Ask Marcus’s address question in <a href={adminPaths.chat}>Admin chat</a>, then <button type="button" className="ts-inline-button" onClick={run.refresh}>refresh runs</button>.
    </>}</p>;
}

export function RunPicker({ run }: { run: MarcusRun }) {
  if (!run.selected) return <div className="ts-run-picker"><RunStatus run={run} /></div>;
  return <div className="ts-run-picker">
    <label>Recorded run <select aria-label="Marcus’s recorded run" value={run.selected.turnId} onChange={(e) => run.choose(e.target.value)}>
      {run.runs?.map((r) => <option value={r.turnId} key={r.turnId}>{new Date(r.createdAt).toLocaleString()} · {r.turnId.slice(-8)} · {r.clicks.length} {r.clicks.length === 1 ? "click" : "clicks"}</option>)}
    </select></label>
    <a href={adminPaths.help + "?" + new URLSearchParams({ thread: run.selected.threadId, turn: run.selected.turnId }) + "#ts-sfield"}>Link to this run</a>
    {run.pin && <a href={adminPaths.help + "#ts-sfield"}>Browse runs</a>}
    <button className="ts-inline-button" type="button" onClick={run.refresh}>Refresh</button>
  </div>;
}

export function SavedJson({ title, value, open = false }: { title: string; value: unknown; open?: boolean }) {
  return <JsonBlock title={title} value={value === undefined ? undefined : { bytes: 0, data: value as JsonValue }} open={open} />;
}

function matches(recommendation: NextStepRecommendation, other: Pick<NextStepRecommendation, "kind" | "id" | "version">) {
  return other.kind === recommendation.kind && other.id === recommendation.id && other.version === recommendation.version;
}

function recommendationTitle(recommendation: NextStepRecommendation, run: TreatmentRun) {
  return run.clicks.find((click) => matches(recommendation, click))?.label
    ?? (recommendation.kind === "workflow" ? customerWorkflow(recommendation)?.label : recommendation.id === "account.address.prepare" ? "Prepare an address change" : undefined)
    ?? recommendation.id;
}

function RecommendationRule({ recommendation, treatment }: { recommendation: NextStepRecommendation; treatment: TreatmentPayloads }) {
  const reasons = treatment.comparison?.reasons?.filter((r) => matches(recommendation, r));
  return <div className="ts-recommendation-rule">
    <span>{recommendation.kind === "action" ? "Standalone action" : "Workflow"}</span> <code>{capabilityRef(recommendation)}</code>
    {reasons?.length ? reasons.map((r, i) => <details className="trace-details" key={i}>
      <summary>{r.name}</summary>
      <p>Topic <code>{r.context}</code>{r.condition?.kind === "attribute" && <> · <code>{formatGlossaryCondition(r.condition)}</code></>}
        {r.condition?.kind === "always" && " · Applies whenever this topic matches"}.</p>
      <SavedJson title="Matched rule and recommendation" value={r} open />
    </details>) : <p>No matching rule details were saved for this recommendation.</p>}
  </div>;
}

function ChildCalls({ run, click }: { run: MarcusRun; click: OfferClick }) {
  const record = useRead(click.turnId, run.revision, api.payloads);
  if (record?.error) return <p role="alert">{record.error} <button type="button" className="ts-inline-button" onClick={run.refresh}>Try again</button></p>;
  if (!record?.data) return <p role="status">Loading sfield calls…</p>;
  const log = record.data;
  if (log.turnId !== click.turnId || (log.sourceDecision && log.sourceDecision.turnId !== run.selected?.turnId))
    return <p>This trace belongs to a different decision.</p>;
  const calls = (click.kind === "workflow" ? log.workflow?.calls : log.agentic?.calls) ?? [];
  const model = click.kind === "workflow" ? log.workflow?.agent?.model : log.agentic?.model;
  return <>
    <a className="ts-log-link" href={diagnosticHref(adminPaths.logs, run.selected?.threadId, click.turnId)}>Open this click in Logs</a>
    {log.workflow?.definition && <JsonBlock title="Workflow definition used for this click" value={log.workflow.definition} />}
    {model && <ModelStage title="Model calls during the click" stage={model} />}
    {calls.length ? <ol className="ts-recorded-calls" aria-label="Recorded sfield calls in execution order">
      {calls.map((call, index) => <li key={index}>
        <ReadToolStage title={call.tool} stage={call} payloadLabel={call.tool} />
      </li>)}
    </ol> : <p>No sfield tool calls were recorded for this click.</p>}
  </>;
}

export function RecordedRecommendations({ run }: { run: MarcusRun }) {
  if (!run.data || !run.selected) return <RunStatus run={run} />;
  const treatment = run.data.log.treatment;
  if (!treatment?.result?.data) return <p>The captured TS response is unavailable for this turn.</p>;
  const parsed = chatTreatmentSchema.safeParse(treatment.result.data);
  const recommendations: TreatmentDecision["recommendations"] = parsed.success ? parsed.data.recommendations : [];
  const nextSteps = recommendations.filter((r): r is NextStepRecommendation => r.kind !== "content");
  if (!nextSteps.length) return <p>The saved response contains no action or workflow recommendations.</p>;
  const key = (o: NextStepRecommendation) => o.kind + "/" + capabilityRef(o);
  const recommendation = nextSteps.find((o) => key(o) === run.recommendationKey) ?? nextSteps[0];
  const clicks = run.selected.clicks.filter((click) => matches(recommendation, click));
  return <>
    <div className="ts-path-picker" role="group" aria-label="Choose Marcus’s next step">
      {nextSteps.map((o) => <button type="button" key={key(o)} aria-pressed={o === recommendation}
        onClick={() => run.chooseRecommendation(key(o))}>{recommendationTitle(o, run.selected!)}</button>)}
    </div>
    <div className="ts-path-detail" aria-live="polite">
      <div><h4>Rule behind this recommendation</h4><RecommendationRule recommendation={recommendation} treatment={treatment} /></div>
      <div><h4>sfield calls after the click</h4>
        {clicks.length ? clicks.map((c) => <section key={c.turnId} aria-label={c.label}><ChildCalls click={c} run={run} /></section>)
          : <p>No click on this recommendation was recorded for this decision.</p>}
      </div>
    </div>
  </>;
}

export type EvidenceKind = "message" | "flowList" | "flowRequest" | "flowResponse" | "lookup" | "router" | "request" | "decision" | "content" | "composer" | "surface" | "clicks";

export function FlowSettingsEvidence({ log }: { log?: TurnPayloads }) {
  return <>
    <p>At message acceptance, the app starts with the flows registered in <code>capabilities-catalog.ts</code> and reads the saved overrides from <code>routing_flow_settings</code> in <code>app.sqlite</code>.
      It applies tenant defaults, then domain overrides, filters by chat audience, and saves the list with the turn.</p>
    <p>For model-based selection, the app sends each allowed ID, description and set of examples directly to the provider. Some explicit requests match an app rule and skip this call.</p>
    {log?.sentFlowList ? <SentFlowList list={log.sentFlowList} /> : log && <p>This turn has no captured list of flows sent to the model.</p>}
    <a href={adminPaths.tools + "#routing-flows"}>Open chat routing flows in Tool setup</a>
  </>;
}

export function RecordedEvidence({ kind, run }: { kind: EvidenceKind; run: MarcusRun }) {
  if (!run.data || !run.selected) return <RunStatus run={run} />;
  const { turn, trace, log } = run.data;
  const ts = log.treatment;
  const composerExchange = log.composer?.attempts.find((a) => a.exchange)?.exchange;
  const input = composerExchange ? decodeChatInput(composerExchange) : log.composer?.saved?.input.data;
  const eligible = input && typeof input === "object" && !Array.isArray(input) ? input.eligible : undefined;
  const candidates = eligible && typeof eligible === "object" && !Array.isArray(eligible) ? eligible.candidates : undefined;
  return <div className="ts-evidence">
    <header><p><strong>Marcus Reed</strong> · {new Date(turn.createdAt).toLocaleString()}</p>
      <p>“{turn.message}”</p><a href={diagnosticHref(adminPaths.logs, turn.conversationId, turn.id)}>Open the source turn in Logs</a></header>
    {kind === "message" && <>
      <SavedJson title="Saved customer message" value={{ id: turn.id, conversationId: turn.conversationId, message: turn.message, createdAt: turn.createdAt }} open />
      <FlowSelectionCall turn={turn} log={log} />
    </>}
    {kind === "flowList" && <FlowSettingsEvidence log={log} />}
    {(kind === "flowRequest" || kind === "flowResponse") && <FlowSelectionCall turn={turn} log={log} focus={kind === "flowRequest" ? "request" : "response"} />}
    {kind === "lookup" && <>
      {log.customerLookup && <ReadToolStage title="Customer record lookup" stage={log.customerLookup} expanded />}
      {log.catalogLookup ? <ReadToolStage title="Supported topic catalog" stage={log.catalogLookup} expanded />
        : <SavedJson title="Saved topic catalog" value={trace.catalog ?? undefined} open />}
      {log.topicScores && <ReadToolStage title="Topic relevance scores" stage={log.topicScores} expanded />}
      {log.topicScores?.mockInput && <JsonBlock title="TS topic scores request" value={log.topicScores.mockInput} />}
    </>}
    {kind === "router" && <ModelStage title="Context Router" stage={log.router} expanded />}
    {(kind === "request" || kind === "decision") && (ts ? <>
      <p><code>{ts.tool}</code> · {ts.status}</p>
      <JsonBlock title="sfield tool request" value={ts.registryInput} open={kind === "request"} />
      <JsonBlock title={ts.inputReconstructed ? "Reconstructed TS input" : "TS request"} value={ts.mockInput} open />
      <JsonBlock title={ts.error ? "TS error" : "TS response returned to sfield"} value={ts.error ?? ts.result} open />
      {kind === "decision" && <>
        {ts.comparison?.legacy && <JsonBlock title="Same decision in the content-only format" value={ts.comparison.legacy} />}
        {ts.comparison?.contentReasons && <SavedJson title="Why TS returned the content IDs" value={ts.comparison.contentReasons} />}
        <JsonBlock title="CCRE evaluation" value={ts.ccre} />
        <RecordedRecommendations run={run} />
      </>}
    </> : <p>No Treatment Selector call was captured for this turn.</p>)}
    {kind === "content" && <>
      <p>The Experience Composer’s saved input shows which content reached the model.</p>
      <SavedJson title="Eligible candidates in the composer request" value={candidates} open />
      <ModelStage title="Experience Composer" stage={log.composer} />
    </>}
    {(kind === "composer" || kind === "surface") && <>
      <ModelStage title="Experience Composer" stage={log.composer} expanded={kind === "composer"} />
      <SavedJson title="A2UI messages delivered to chat" value={turn.experience?.messages} open={kind === "surface"} />
    </>}
    {kind === "clicks" && <RecordedRecommendations run={run} />}
  </div>;
}
