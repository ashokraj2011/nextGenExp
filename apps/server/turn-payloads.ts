import { experienceAgentId } from "../../packages/contracts/agentic";
import { ASK_USER } from "@sfield/core";
import type { CallRecord, JsonValue, ModelAttemptRecord, RunRecord, SField } from "@sfield/core";
import host from "../../fixtures/host.json";
import { findProfileById } from "../../packages/customer-profiles";
import type { AgenticPayloads, WorkflowPayloads, ModelStagePayloads, RegistryToolPayloads, TreatmentPayloads, TurnPayloads } from "../../packages/contracts/inspector";
import { fundingAgentId, fundingToolKey, resolveFundingWorkflow, treatmentRecommendationsVersion } from "../../packages/contracts/funding-workflow";
import { sfieldTools, toolVersion } from "../../packages/contracts/tool-setup";
import { workspaceFundingContext } from "../../packages/contracts/workspace";
import type { configureGateway } from "./gateway";
import { assistantResponse } from "./payload-capture";
import { fundingModelTools } from "./funding-agent";
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
    const compiled = await inspection.compile(fundingModelTools(context.request, (ref) => ref !== ASK_USER.ref));
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
  const attempts = recorded.map((attempt) => modelAttemptPayload(store, inspection, attempt));
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

function modelAttemptPayload(store: Store, inspection: Inspection, attempt: ModelAttemptRecord) {
  return {
    id: attempt.attemptId, model: attempt.model, status: attempt.status,
    exchange: store.gatewayExchange(attempt.attemptId),
    error: attempt.error ? inspection.payload({ ...attempt.error }) : undefined,
  };
}

function registryPayload(inspection: Inspection, call: CallRecord): RegistryToolPayloads {
  return {
    tool: call.toolRef,
    status: call.result?.status ?? call.state,
    registryInput: inspection.payload(call.invocation?.normalizedInputs ?? call.proposedArguments),
    result: call.result?.output === undefined ? undefined : inspection.payload(call.result.output),
    error: call.result?.error ? inspection.payload({ ...call.result.error }) : undefined,
  };
}

async function glossaryPayloads(sf: SField, inspection: Inspection, turn: TurnRecord) {
  const routerRunId = turn.attempts.route?.runId;
  if (!turn.glossaryScopeId || !routerRunId) return null;
  const tool = `${sfieldTools.glossary.id}@${toolVersion}`;
  const call = (await sf.persistence.listCalls(turn.glossaryScopeId)).find((entry) => (
    entry.toolRef === tool && entry.proposedArguments.turnRef === turn.public.id && entry.proposedArguments.routerRunId === routerRunId
  ));
  return call ? registryPayload(inspection, call) : null;
}

async function routeReadPayloads(
  sf: SField, inspection: Inspection, turn: TurnRecord, scopeId: string | undefined, key: "portfolio" | "goal",
) {
  if (!scopeId || !turn.route) return null;
  const tool = `${sfieldTools[key].id}@${toolVersion}`;
  const call = (await sf.persistence.listCalls(scopeId)).find((entry) => (
    entry.toolRef === tool && entry.proposedArguments.turnRef === turn.public.id
    && entry.proposedArguments.routeDecisionId === turn.route?.routeDecisionId
  ));
  return call ? registryPayload(inspection, call) : null;
}

async function topicScoresPayloads(sf: SField, inspection: Inspection, turn: TurnRecord): Promise<TreatmentPayloads | null> {
  const recorded = turn.treatmentScores;
  if (!recorded || recorded.scopeId !== turn.catalogScopeId || !turn.catalog) return null;
  const tool = `${sfieldTools.propensity.id}@${toolVersion}`;
  const call = (await sf.persistence.listCalls(recorded.scopeId)).find((entry) => (
    entry.toolRef === tool && entry.proposedArguments.turnRef === turn.public.id
    && entry.proposedArguments.catalogSnapshotId === turn.catalog?.snapshotId
  ));
  return call ? { ...registryPayload(inspection, call), mockInput: inspection.payload(recorded.input) } : null;
}

async function treatmentPayloads(sf: SField, inspection: Inspection, turn: TurnRecord, conversation: ConversationRecord): Promise<TreatmentPayloads | null> {
  const workspaceContext = workspaceFundingContext(turn.origin);
  const decisionRef = workspaceContext ? turn.public.id : turn.route?.routeDecisionId;
  const context = workspaceContext ?? turn.route?.contextId;
  if (!turn.tsScopeId || !decisionRef || !context) return null;
  const tools = [toolVersion, treatmentRecommendationsVersion].map((version) => `${sfieldTools.selection.id}@${version}`);
  const call = (await sf.persistence.listCalls(turn.tsScopeId)).find((entry) => (
    tools.includes(entry.toolRef) && entry.proposedArguments.turnRef === turn.public.id
    && entry.proposedArguments.routeDecisionId === decisionRef
  ));
  if (!call) return null;
  let mockInput = turn.treatmentMockInput;
  if (!mockInput && (call.result?.status === "succeeded" || call.result?.error?.code === "TS_TIMEOUT")) {
    const persona = findProfileById(conversation.personaId);
    if (persona) mockInput = { mid: persona.syntheticMid, context };
  }
  return {
    ...registryPayload(inspection, call),
    mockInput: mockInput ? inspection.payload(mockInput) : undefined,
    ccre: turn.treatmentCcre ? inspection.payload(turn.treatmentCcre) : undefined,
  };
}

async function workflowPayloads(sf: SField, store: Store, inspection: Inspection, turn: TurnRecord): Promise<WorkflowPayloads | null> {
  if (!turn.workflow) return null;
  const { recommendation } = turn.workflow;
  const definition = resolveFundingWorkflow(recommendation, turn.toolSetup?.fundingWorkflow);
  const phase = turn.fundingRun;
  if (phase) {
    const run = await sf.persistence.getRun(phase.id);
    const root = store.turn(phase.rootTurnId);
    if (!run || run.agentId !== fundingAgentId || run.tenantId !== "pzn-local" || run.subjectId !== turn.scope.principalId
      || run.request.inputs?.turnRef !== phase.rootTurnId || root?.scope.conversationId !== turn.scope.conversationId) return null;
    const [calls, attempts, input] = await Promise.all([
      sf.persistence.listCalls(phase.id),
      sf.persistence.listModelAttempts(phase.id),
      phase.waiting ? sf.persistence.getInputRequest(phase.waiting.requestId) : undefined,
    ]);
    return {
      recommendation, definition: definition && inspection.payload(definition),
      calls: calls.slice(phase.after.calls, phase.through?.calls).flatMap((call) => {
        if (call.toolRef === ASK_USER.ref) {
          const payload = registryPayload(inspection, call);
          return [{
            ...payload, label: "Ask for a funding method",
            ...(call.callId === input?.callId && { status: "waiting_input", result: undefined, error: undefined }),
          }];
        }
        const key = fundingToolKey(call.toolRef);
        return key ? [{ ...registryPayload(inspection, call), label: sfieldTools[key].label }] : [];
      }),
      agent: {
        runId: phase.id, outcome: phase.outcome,
        answer: phase.answerTo ? inspection.payload({ requestId: phase.answerTo, reply: turn.public.message }) : undefined,
        model: { attempts: attempts.slice(phase.after.attempts, phase.through?.attempts).map((attempt) => modelAttemptPayload(store, inspection, attempt)) },
      },
    };
  }
  const recorded = turn.workflowScopeId ? await sf.persistence.listCalls(turn.workflowScopeId) : [];
  const calls = recorded.filter((call) => call.proposedArguments.turnRef === turn.public.id)
    .sort((a, b) => a.turn - b.turn || a.order - b.order)
    .flatMap((call) => {
      const key = fundingToolKey(call.toolRef);
      return key ? [{ ...registryPayload(inspection, call), label: sfieldTools[key].label }] : [];
    });
  return { recommendation, definition: definition && inspection.payload(definition), calls };
}

async function experiencePayloads(sf: SField, store: Store, inspection: Inspection, turn: TurnRecord): Promise<AgenticPayloads | undefined> {
  const root = turn.agentRunId && await sf.persistence.getRun(turn.agentRunId);
  if (!root || root.subjectId !== turn.scope.principalId || root.tenantId !== "pzn-local") return;
  const standalone = root.kind === "standalone" && root.agentId === experienceAgentId && root.request.inputs?.turnRef === turn.public.id;
  const ids = new Set([...(standalone ? [root.runId] : []), ...turn.agentExecutionIds ?? []]);
  const gathered = await Promise.all([...ids].map((id) => sf.persistence.listCalls(id)));
  const calls = gathered.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((call) => {
    const payload = registryPayload(inspection, call);
    const request = call.invocation?.normalizedInputs ?? call.proposedArguments;
    if (Object.hasOwn(request, "lease")) {
      const { lease: _lease, parameters, ...rest } = request;
      let parsed = parameters;
      if (typeof parameters === "string") {
        try { parsed = JSON.parse(parameters) as JsonValue; } catch { /* Keep the captured string. */ }
      }
      payload.registryInput = inspection.payload({ ...rest, parameters: parsed ?? null });
    }
    const serialized = call.result?.output;
    if (serialized && typeof serialized === "object" && !Array.isArray(serialized) && typeof serialized.data === "string") {
      try { return { ...payload, result: inspection.payload(JSON.parse(serialized.data) as JsonValue) }; }
      catch { return payload; }
    }
    return payload;
  });
  const model = standalone ? {
    attempts: (await sf.persistence.listModelAttempts(root.runId)).map((attempt) => modelAttemptPayload(store, inspection, attempt)),
  } : null;
  return { runId: root.runId, model, calls };
}

export async function readTurnPayloads(sf: SField, store: Store, inspection: Inspection, turn: TurnRecord, conversation: ConversationRecord): Promise<TurnPayloads> {
  const [topicScores, router, glossary, treatment, portfolio, goal, composer, workflow, agentic] = await Promise.all([
    topicScoresPayloads(sf, inspection, turn),
    modelPayloads(sf, store, inspection, turn, "route"),
    glossaryPayloads(sf, inspection, turn),
    treatmentPayloads(sf, inspection, turn, conversation),
    routeReadPayloads(sf, inspection, turn, turn.portfolioScopeId, "portfolio"),
    routeReadPayloads(sf, inspection, turn, turn.goalScopeId, "goal"),
    modelPayloads(sf, store, inspection, turn, "compose"),
    workflowPayloads(sf, store, inspection, turn),
    experiencePayloads(sf, store, inspection, turn),
  ]);
  return { turnId: turn.public.id, topicScores, router, glossary, treatment, portfolio, goal, composer, workflow, ...(agentic && { agentic }) };
}
