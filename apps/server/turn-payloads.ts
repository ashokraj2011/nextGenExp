import { serverTenantId } from "./tenant";
import { experienceAgentId } from "../../packages/contracts/agentic";
import { ASK_USER } from "@sfield/core";
import type { CallRecord, JsonValue, ModelAttemptRecord, RunRecord, SField } from "@sfield/core";
import host from "../../fixtures/host.json";
import { findProfileById } from "../../packages/customer-profiles";
import type { AgenticPayloads, WorkflowPayloads, ModelStagePayloads, RegistryToolPayloads, TreatmentPayloads, TurnHandoffs, TurnPayloads } from "../../packages/contracts/inspector";
import { workflowDefinition, workflowToolKey } from "../../packages/contracts/customer-workflows";
import { fundingAgentId, fundingToolKey, treatmentDecisionVersion, treatmentRecommendationsVersion } from "../../packages/contracts/funding-workflow";
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
  if (!run || run.tenantId !== serverTenantId || run.subjectId !== turn.scope.principalId || run.agentId !== stageAgent[stage]
    || run.request.inputs?.turnRef !== turn.public.id || run.request.inputs?.stageAttemptId !== stageAttempt.id) return null;

  const recorded = await sf.persistence.listModelAttempts(run.runId);
  const session = { request: inspection.payload(run.request as unknown as JsonValue),
    ...(run.output !== undefined && { output: inspection.payload(run.output) }) };
  const attempts = recorded.map((attempt) => modelAttemptPayload(store, inspection, attempt));
  if (attempts.length === 1 && !attempts[0].exchange) {
    const exchange = await verifiedExchange(sf, inspection, run, recorded[0]);
    if (exchange) {
      store.saveGatewayExchange(attempts[0].id, exchange);
      attempts[0].exchange = exchange;
    }
  }
  if (attempts.length && attempts.every(({ exchange }) => exchange)) return { attempts, session };

  // Older runs keep the agent's input and assistant messages even without the compiled body.
  const saved = await sf.persistence.getCheckpoint(run.runId);
  const responses = saved?.runMessages.flatMap((message) => (
    message.role === "assistant" ? [inspection.payload(assistantResponse(message))] : []
  )) ?? [];
  if (!responses.length && run.output !== undefined) responses.push(inspection.payload(run.output));
  let input: JsonValue = run.request.message.text;
  try { input = JSON.parse(run.request.message.text) as JsonValue; } catch { /* Preserve a plain text input. */ }
  return { attempts, session, saved: { input: inspection.payload(input), responses } };
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

async function customerLookupPayload(sf: SField, inspection: Inspection, turn: TurnRecord) {
  const read = turn.customerTask;
  if (!read?.sfieldRunId || !read.sfieldCallId) return;
  const run = await sf.persistence.getRun(read.sfieldRunId);
  if (run?.tenantId !== serverTenantId || run.subjectId !== turn.scope.principalId) return;
  const call = (await sf.persistence.listCalls(run.runId)).find((entry) => entry.callId === read.sfieldCallId);
  return call && registryPayload(inspection, call);
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
  sf: SField, inspection: Inspection, turn: TurnRecord, scopeId: string | undefined, key: "portfolio" | "goal" | "retirementAccounts",
) {
  if (!scopeId || !turn.route) return null;
  const tool = `${sfieldTools[key].id}@${toolVersion}`;
  const call = (await sf.persistence.listCalls(scopeId)).find((entry) => (
    entry.toolRef === tool && entry.proposedArguments.turnRef === turn.public.id
    && entry.proposedArguments.routeDecisionId === turn.route?.routeDecisionId
  ));
  return call ? registryPayload(inspection, call) : null;
}

async function discoveryPayloads(sf: SField, inspection: Inspection, turn: TurnRecord): Promise<Pick<TurnPayloads, "catalogLookup" | "topicScores">> {
  if (!turn.catalogScopeId) return { topicScores: null };
  const calls = (await sf.persistence.listCalls(turn.catalogScopeId)).filter((call) => call.proposedArguments.turnRef === turn.public.id);
  const catalog = calls.find((call) => call.toolRef === `${sfieldTools.catalog.id}@${toolVersion}`);
  const scores = turn.catalog && calls.find((call) => call.toolRef === `${sfieldTools.propensity.id}@${toolVersion}`
    && call.proposedArguments.catalogSnapshotId === turn.catalog?.snapshotId);
  const recorded = turn.treatmentScores;
  return {
    ...(catalog && { catalogLookup: registryPayload(inspection, catalog) }),
    topicScores: recorded?.scopeId === turn.catalogScopeId && scores
      ? { ...registryPayload(inspection, scores), mockInput: inspection.payload(recorded.input) } : null,
  };
}

async function treatmentPayloads(sf: SField, inspection: Inspection, turn: TurnRecord, conversation: ConversationRecord): Promise<TreatmentPayloads | null> {
  const workspaceContext = workspaceFundingContext(turn.origin);
  const decisionRef = workspaceContext ? turn.public.id : turn.route?.routeDecisionId;
  const context = workspaceContext ?? turn.route?.contextId;
  if (!turn.tsScopeId || !decisionRef || !context) return null;
  const tools = [toolVersion, treatmentRecommendationsVersion, treatmentDecisionVersion].map((version) => `${sfieldTools.selection.id}@${version}`);
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
  const formats = call.result?.status === "succeeded" ? turn.treatmentFormats : undefined;
  const returned = call.toolRef === tools[0] ? "legacy" : call.toolRef === tools[2] ? "decisions" : "workflows";
  const raw = registryPayload(inspection, call);
  return {
    ...raw,
    ...(formats && raw.result && { comparison: {
      legacy: returned === "legacy" ? raw.result : inspection.payload(formats.legacy),
      workflows: returned !== "legacy" ? raw.result : inspection.payload(formats.workflows),
      returned,
      ...(returned === "decisions" && { contentReasons: formats.legacy.map((id) => ({
        id, source: turn.treatmentEntries ? "Published context" : turn.trace.ts?.source === "override" ? "Tool setup override" : "Ranked context list",
        matchingRules: turn.treatmentCcre?.results.filter((rule) => rule.contentId === id && rule.outcome === "matched").map((rule) => rule.name) ?? [],
      })), reasons: [
        ...(formats.actionMatches ?? []).map(({ name, contextId, condition, action }) => ({
          ...action, name, condition, context: contextId, contentIds: [],
        })),
        ...(formats.matches ?? []).map(({ name, condition, contentId, requiresContentIds, workflow }) => ({
          ...workflow, name, condition, context, contentIds: [contentId, ...requiresContentIds ?? []],
        })),
      ] }),
      rules: formats.matches?.map(({ name, contentId, workflow }) => ({ name, contentId, workflowId: workflow.id })) ?? formats.workflows.recommendations.flatMap((item) => item.kind === "workflow"
        ? (item.forContentIds ?? []).flatMap((id) => {
          const rule = turn.treatmentCcre?.results.findLast((r) => r.contentId === id && r.outcome === "matched");
          return rule ? [{ name: rule.name, contentId: id, workflowId: item.id }] : [];
        }) : []),
    } }),
    mockInput: mockInput ? inspection.payload(mockInput) : undefined,
    ...(mockInput && !turn.treatmentMockInput && { inputReconstructed: true as const }),
    ccre: turn.treatmentCcre ? inspection.payload(turn.treatmentCcre) : undefined,
    fundingCheck: turn.treatmentCcre?.fundingCheck,
  };
}

async function workflowPayloads(sf: SField, store: Store, inspection: Inspection, turn: TurnRecord): Promise<WorkflowPayloads | null> {
  if (!turn.workflow) return null;
  const { recommendation } = turn.workflow;
  const definition = workflowDefinition(recommendation, turn.toolSetup?.fundingWorkflow);
  const phase = turn.fundingRun;
  if (phase) {
    const run = await sf.persistence.getRun(phase.id);
    const root = store.turn(phase.rootTurnId);
    if (!run || run.agentId !== fundingAgentId || run.tenantId !== serverTenantId || run.subjectId !== turn.scope.principalId
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
      const key = workflowToolKey(call.toolRef);
      return key ? [{ ...registryPayload(inspection, call), label: sfieldTools[key].label }] : [];
    });
  return { recommendation, definition: definition && inspection.payload(definition), calls };
}

async function experiencePayloads(sf: SField, store: Store, inspection: Inspection, turn: TurnRecord): Promise<AgenticPayloads | undefined> {
  const root = turn.agentRunId && await sf.persistence.getRun(turn.agentRunId);
  if (!root || root.subjectId !== turn.scope.principalId || root.tenantId !== serverTenantId) return;
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

function turnHandoffs(store: Store, inspection: Inspection, turn: TurnRecord): TurnHandoffs {
  const exchanges = store.turnExchanges(turn.public.id);
  const events = store.replay(turn, 0) ?? [];
  const accepted = events.find((event) => event.type === "turn.accepted");
  const ready = events.find((event) => event.type === "experience.ready");
  const receipt = turn.public.experience && store.renderReceipt(turn.public.experience.experienceId);
  let savedInput;
  if (!exchanges.submission && turn.origin === "message") {
    savedInput = { message: turn.public.message, clientRequestId: turn.requestId };
  } else if (!exchanges.submission && turn.origin.startsWith("workflow:")) {
    const actionId = turn.origin.slice("workflow:".length);
    const surface = store.previousCompletedTurn(turn.scope.conversationId, turn.ordinal)?.public.experience;
    const action = surface?.actions.find((item) => item.actionId === actionId);
    savedInput = { actionId, clientRequestId: turn.requestId, ...(surface && action && {
      surfaceId: surface.experienceId, sourceComponentId: action.componentId,
    }) };
  }
  const settings = turn.toolSetup;
  return { ...exchanges,
    ...(savedInput && { acceptedInput: inspection.payload(savedInput) }),
    ...(accepted && { acceptedEvent: inspection.payload(accepted as unknown as JsonValue) }),
    ...(ready && { readyEvent: inspection.payload(ready as unknown as JsonValue) }),
    ...(receipt && { renderReceipt: inspection.payload(receipt) }),
    ...(settings && { settings: inspection.payload({ enabled: settings.enabled, ruleNames: settings.ccreRules?.map((rule) => rule.name) ?? [],
      ...(settings.fundingWorkflow && { fundingWorkflow: settings.fundingWorkflow }) } as JsonValue) }),
  };
}

export async function readTurnPayloads(sf: SField, store: Store, inspection: Inspection, turn: TurnRecord, conversation: ConversationRecord): Promise<TurnPayloads> {
  const [discovery, router, glossary, treatment, portfolio, goal, composer, workflow, agentic, customerLookup, retirementAccounts] = await Promise.all([
    discoveryPayloads(sf, inspection, turn),
    modelPayloads(sf, store, inspection, turn, "route"),
    glossaryPayloads(sf, inspection, turn),
    treatmentPayloads(sf, inspection, turn, conversation),
    routeReadPayloads(sf, inspection, turn, turn.portfolioScopeId, "portfolio"),
    routeReadPayloads(sf, inspection, turn, turn.goalScopeId, "goal"),
    modelPayloads(sf, store, inspection, turn, "compose"),
    workflowPayloads(sf, store, inspection, turn),
    experiencePayloads(sf, store, inspection, turn),
    customerLookupPayload(sf, inspection, turn),
    routeReadPayloads(sf, inspection, turn, turn.retirementScopeId, "retirementAccounts"),
  ]);
  const sourceId = turn.workflow?.sourceExperienceId ?? (turn.agentLaunch && "capability" in turn.agentLaunch ? turn.agentLaunch.sourceExperienceId : undefined);
  const source = sourceId && store.experience(sourceId, turn.scope.principalId).turn;
  const sourceTreatment = source && source.scope.conversationId === conversation.id && source.scope.personaId === turn.scope.personaId
    ? await treatmentPayloads(sf, inspection, source, conversation) : null;
  const clicks = turn.public.experience && (turn.decision?.workflowRecommendations?.length || turn.decision?.actionRecommendations?.length) ? store.workflowClicks(turn) : [];
  const handoffs = turnHandoffs(store, inspection, turn);
  const catalog = turn.flowCatalog;
  return { handoffs,
    ...(handoffs.flowRouting && catalog && { sentFlowList: { tenantId: catalog.tenantId, domainId: catalog.domainId, audience: catalog.audience, flowIds: catalog.flows.map((flow) => flow.id) } }),
    ...(source && sourceTreatment && { sourceDecision: { turnId: source.public.id, message: source.public.message, treatment: sourceTreatment } }),
    ...(turn.route && turn.trace.intentId && { verifiedIntent: { intentId: turn.trace.intentId, contextId: turn.route.contextId } }),
    ...(clicks.length && { workflowClicks: clicks }), turnId: turn.public.id, ...discovery, router, glossary, treatment, portfolio, goal, composer, workflow, ...(retirementAccounts && { retirementAccounts }), ...(agentic && { agentic }), ...(customerLookup && { customerLookup }) };
}
