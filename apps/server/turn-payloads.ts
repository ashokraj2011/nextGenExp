import type { JsonValue, ModelAttemptRecord, RunRecord, SField } from "@sfield/core";
import host from "../../fixtures/host.json";
import type { ModelStagePayloads, TreatmentPayloads, TurnPayloads } from "../../packages/contracts/inspector";
import { sfieldTools, toolVersion } from "../../packages/contracts/tool-setup";
import type { configureGateway } from "./gateway";
import { assistantResponse } from "./payload-capture";
import { stageAgent, type ConversationRecord, type Stage, type Store, type TurnRecord } from "./store";

type Inspection = NonNullable<ReturnType<typeof configureGateway>["inspection"]>;

async function verifiedExchange(sf: SField, inspection: Inspection, run: RunRecord, attempt: ModelAttemptRecord) {
  if (run.state !== "completed" || run.usage.modelCalls !== 1 || attempt.status !== "succeeded" || !attempt.usage || !attempt.stopReason) return;
  const saved = await sf.persistence.getCheckpoint(run.runId);
  const response = saved?.runMessages[0];
  if (!saved || saved.runMessages.length !== 1 || response?.role !== "assistant") return;
  try {
    const context = await sf.context.build({
      agent: run.agentId, principal: run.principal, message: run.request.message,
      runInputs: run.request.inputs, transcript: saved.transcript,
    });
    const compiled = await inspection.compile(context.request);
    if (compiled.digest !== attempt.compiledDigest) return;
    return inspection.exchange(compiled, {
      type: "done", message: response, stopReason: attempt.stopReason, usage: attempt.usage,
    }, "verified");
  } catch {
    // A changed gateway configuration can make an older body impossible to verify.
    return undefined;
  }
}

async function modelPayloads(sf: SField, store: Store, inspection: Inspection, turn: TurnRecord, stage: Stage): Promise<ModelStagePayloads | null> {
  const stageAttempt = turn.attempts[stage];
  if (!stageAttempt?.runId) return null;
  const run = await sf.persistence.getRun(stageAttempt.runId);
  if (!run || run.tenantId !== "pzn-local" || run.subjectId !== turn.scope.principalId || run.agentId !== stageAgent[stage]
    || run.request.inputs?.turnRef !== turn.public.id || run.request.inputs?.stageAttemptId !== stageAttempt.id) return null;

  const recorded = await sf.persistence.listModelAttempts(run.runId);
  const attempts = recorded.map((attempt) => ({
    id: attempt.attemptId, model: attempt.model, status: attempt.status,
    exchange: store.gatewayExchange(attempt.attemptId),
    error: attempt.error ? inspection.payload({ ...attempt.error }) : undefined,
  }));
  if (attempts.length === 1 && !attempts[0].exchange) {
    const exchange = await verifiedExchange(sf, inspection, run, recorded[0]);
    if (exchange) {
      store.saveGatewayExchange(attempts[0].id, exchange);
      attempts[0].exchange = exchange;
    }
  }
  if (attempts.length && attempts.every(({ exchange }) => exchange)) return { attempts };

  // Older runs keep the agent's input and assistant messages even without the compiled body.
  const saved = await sf.persistence.getCheckpoint(run.runId);
  const responses = saved?.runMessages.flatMap((message) => (
    message.role === "assistant" ? [inspection.payload(assistantResponse(message))] : []
  )) ?? [];
  if (!responses.length && run.output !== undefined) responses.push(inspection.payload(run.output));
  let input: JsonValue = run.request.message.text;
  try { input = JSON.parse(run.request.message.text) as JsonValue; } catch { /* Preserve a plain text input. */ }
  return { attempts, saved: { input: inspection.payload(input), responses } };
}

async function treatmentPayloads(sf: SField, inspection: Inspection, turn: TurnRecord, conversation: ConversationRecord): Promise<TreatmentPayloads | null> {
  if (!turn.tsScopeId || !turn.route) return null;
  const tool = `${sfieldTools.selection.id}@${toolVersion}`;
  const call = (await sf.persistence.listCalls(turn.tsScopeId)).find((entry) => (
    entry.toolRef === tool && entry.proposedArguments.turnRef === turn.public.id
    && entry.proposedArguments.routeDecisionId === turn.route?.routeDecisionId
  ));
  if (!call) return null;
  let mockInput = turn.treatmentMockInput;
  if (!mockInput && (call.result?.status === "succeeded" || call.result?.error?.code === "TS_TIMEOUT")) {
    const persona = host.personas.find((entry) => entry.personaId === conversation.personaId);
    if (persona) mockInput = { mid: persona.syntheticMid, context: turn.route.contextId };
  }
  return {
    tool, status: call.result?.status ?? call.state,
    registryInput: inspection.payload(call.invocation?.normalizedInputs ?? call.proposedArguments),
    mockInput: mockInput ? inspection.payload(mockInput) : undefined,
    result: call.result?.output === undefined ? undefined : inspection.payload(call.result.output),
    error: call.result?.error ? inspection.payload({ ...call.result.error }) : undefined,
  };
}

export async function readTurnPayloads(sf: SField, store: Store, inspection: Inspection, turn: TurnRecord, conversation: ConversationRecord): Promise<TurnPayloads> {
  const [router, treatment, composer] = await Promise.all([
    modelPayloads(sf, store, inspection, turn, "route"),
    treatmentPayloads(sf, inspection, turn, conversation),
    modelPayloads(sf, store, inspection, turn, "compose"),
  ]);
  return { turnId: turn.public.id, router, treatment, composer };
}
