import { useEffect, useState } from "react";
import type { JsonValue } from "@sfield/core";
import type { TurnView } from "../../packages/contracts/api";
import type {
  GatewayExchange, InspectorPayload, ModelStagePayloads, RegistryToolPayloads, TreatmentPayloads, TurnPayloads,
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
  const body = exchange.request.data;
  const messages = body && typeof body === "object" && !Array.isArray(body) ? body.messages : undefined;
  const userMessage = Array.isArray(messages) ? messages.find((message) => (
    message && typeof message === "object" && !Array.isArray(message) && message.role === "user"
  )) : undefined;
  const input = userMessage && typeof userMessage === "object" && !Array.isArray(userMessage) ? decodeJson(userMessage.content) : undefined;
  const response = exchange.response?.data;
  const message = response && typeof response === "object" && !Array.isArray(response) ? response.message : undefined;
  const output = message && typeof message === "object" && !Array.isArray(message) ? decodeJson(message.content) : undefined;
  return <>
    {exchange.path && <p><code>{exchange.method} {exchange.path}</code></p>}
    {exchange.source === "verified" && <p>Request body verified against the saved digest.</p>}
    <JsonBlock title="Gateway request body" value={exchange.request} />
    {input && <JsonBlock title="Decoded chat input" value={input} />}
    <JsonBlock title={error ? "Gateway error" : "Gateway response"} value={exchange.response ?? error} />
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
        <p>Saved sfield payloads for the run.</p>
        <JsonBlock title="Saved agent input" value={stage.saved.input} />
        {stage.saved.responses.map((response, index) => <JsonBlock key={index} title={`Saved response ${index + 1}`} value={response} />)}
      </>}
    </> : <p>No model call recorded for this turn.</p>}
  </details>;
}

function TreatmentStage({ stage }: { stage: TreatmentPayloads | null }) {
  return <details className="trace-details payload-stage">
    <summary>Treatment Selector · {stage?.status ?? "no call"}</summary>
    {stage ? <>
      <p><code>{stage.tool}</code></p>
      <JsonBlock title="sfield tool request" value={stage.registryInput} />
      {stage.mockInput && <JsonBlock title="Mock request" value={stage.mockInput} open />}
      {stage.ccre && <JsonBlock title="Mock CCRE evaluation" value={stage.ccre} />}
      <JsonBlock title={stage.error ? "Tool error" : "Tool response"} value={stage.error ?? stage.result} open />
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

export function PayloadInspector({ turn }: { turn: TurnView }) {
  const [open, setOpen] = useState(false);
  const [payloads, setPayloads] = useState<TurnPayloads>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setFailed(false);
    void api.payloads(turn.id).then(
      (data) => { if (!disposed && data.turnId === turn.id) setPayloads(data); },
      () => { if (!disposed) setFailed(true); },
    );
    return () => { disposed = true; };
  }, [open, turn.id, turn.progress, turn.status]);
  return <details className="trace-details payload-inspector" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Request and response payloads</summary>
    <p>Gateway credentials and configured metadata values are redacted.</p>
    {failed && <p role="alert">The turn payloads are unavailable. Reopen this section to retry.</p>}
    {payloads ? <>
      <ModelStage title="Context Router" stage={payloads.router} />
      {payloads.glossary && <ReadToolStage title="CCRE glossary" payloadLabel="Glossary" stage={payloads.glossary} />}
      <TreatmentStage stage={payloads.treatment} />
      {payloads.portfolio && <ReadToolStage title="Portfolio Snapshot" stage={payloads.portfolio} />}
      <ModelStage title="Experience Composer" stage={payloads.composer} />
    </> : open && !failed && <p role="status">Loading turn payloads…</p>}
  </details>;
}
