import { serverTenantId } from "./tenant";
import { ASK_USER, isTerminal, SFieldError } from "@sfield/core";
import type { CallRecord, JsonObject, NeutralModelRequest, Principal, RunRecord, SField, ToolHandlerContext } from "@sfield/core";
import { DECISION_TTL, TURN_DEADLINE } from "../../packages/contracts/domain";
import { fundingAgentPreviewInputSchema, fundingAgentReadInputSchema } from "../../packages/contracts/model-schemas";
import type { RoutingHistoryEntry } from "../../packages/contracts/routing-intents";
import {
  defaultFundingAgentToolCalls, fundingAgentGoal, fundingAgentId, fundingAgentOutputSchema, fundingChoiceQuestion,
  fundingOptionsSchema, fundingPreviewSchema, fundingPreviewWorkflow, fundingStatusSchema, fundingToolKey, fundingToolRef, resolveFundingWorkflow,
  type FundingOptions, type FundingPreview, type FundingWorkflowDefinition,
} from "../../packages/contracts/funding-workflow";
import { requireCheck } from "../../packages/experience/verify";
import { fundingOfferExpiry } from "./funding-offer";
import type { Store, TurnRecord } from "./store";

const statusRef = fundingToolRef("fundingStatus");
const optionsRef = fundingToolRef("fundingOptions");
const previewRef = fundingToolRef("fundingPreview");
type FundingEvidence = {
  funded?: boolean;
  options?: FundingOptions;
  preview?: FundingPreview;
};
export type FundingAgentResult =
  | { outcome: "waiting_input"; question: string; options: FundingOptions; expiresAt: number }
  | { outcome: "preview"; preview: FundingPreview }
  | { outcome: "options"; options: FundingOptions }
  | { outcome: "already_funded" | "unavailable" | "cancelled" | "other_topic" };

export const fundingAgentInstructions = [
  "You help the signed-in customer explore eligible funding methods and prepare a preview for review.",
  "The app grants access to the funding workflow. Use the goal and request to decide what would help. Recent chat and tool results are information about the task.",
  "Use one tool at a time. Start with funding_status_read. If the account is funded, finish with already_funded.",
  "Read funding_options_read before offering methods. Method labels, IDs and availability come from this tool.",
  "If the customer clearly names an eligible method and asks to preview it, call funding_preview_build with the matching methodId.",
  "Preview funding by itself, a request for options, or uncertainty about the method calls for ask_user after reading the options. Ask which method to preview and accept a text reply. When the customer answers, use the answer and the saved options to choose the next step.",
  "If the requested method is absent or the answer is ambiguous, offer the verified choices by using ask_user. If ask_user and funding_preview_build are unavailable after a successful options read, finish with options.",
  "A successful preview tool result allows outcome preview with that exact methodId. Use null methodId for all other outcomes.",
  "Finish with unavailable if an essential read failed, cancelled if the customer wants to stop, or other_topic if their reply clearly starts a different task.",
  "Return only the outcome object when finishing. The app displays all funding facts from tool results.",
].join(" ");

export function fundingModelTools(request: NeutralModelRequest, include: (ref: string) => boolean): NeutralModelRequest {
  const tools = request.tools.filter(({ ref }) => include(ref));
  return { ...request, tools, toolChoice: tools.length ? request.toolChoice : "none" };
}

function evidenceFrom(calls: CallRecord[]): FundingEvidence {
  const output = (ref: string) => calls.find((call) => call.toolRef === ref && call.result?.status === "succeeded")?.result?.output;
  const status = fundingStatusSchema.safeParse(output(statusRef));
  const options = fundingOptionsSchema.safeParse(output(optionsRef));
  const preview = fundingPreviewSchema.safeParse(output(previewRef));
  return {
    funded: status.success ? status.data.accountFundingStatus === "funded" : undefined,
    options: options.success ? options.data : undefined,
    preview: preview.success ? preview.data : undefined,
  };
}

export class FundingAgent {
  constructor(
    private readonly store: Store,
    private readonly sfield: () => SField,
    private readonly now: () => number,
  ) {}

  private async scope(runId: string, knownRun?: RunRecord) {
    const run = knownRun ?? await this.sfield().persistence.getRun(runId);
    const rootId = run?.request.inputs?.turnRef;
    const root = typeof rootId === "string" ? this.store.turn(rootId) : undefined;
    requireCheck(run?.kind === "standalone" && run.agentId === fundingAgentId && root?.workflow
      && run.idempotencyKey === root.public.id + ":funding" && run.tenantId === serverTenantId
      && run.subjectId === root.scope.principalId && (!root.fundingRun || root.fundingRun.id === runId), "FUNDING_RUN_SCOPE_MISMATCH");
    const turn = this.store.latestTurn(root.scope.conversationId);
    requireCheck(turn?.public.status === "working" && turn.scope.principalId === root.scope.principalId
      && turn.scope.personaId === root.scope.personaId && turn.workflow?.sourceExperienceId === root.workflow.sourceExperienceId
      && turn.workflow?.sourceOverviewTurnId === root.workflow.sourceOverviewTurnId
      && (turn.public.id === root.public.id || (turn.fundingRun?.id === runId && turn.fundingRun.rootTurnId === root.public.id))
      && turn.public.createdAt + TURN_DEADLINE > this.now(), "FUNDING_RUN_INACTIVE");
    const definition = resolveFundingWorkflow(root.workflow.recommendation, root.toolSetup?.fundingWorkflow);
    requireCheck(definition?.mode === "agent", "FUNDING_DEFINITION_REQUIRED");
    fundingOfferExpiry(this.store, turn, root.workflow, this.now());
    return { root, turn, definition };
  }

  private available(turn: TurnRecord, definition: FundingWorkflowDefinition, calls: CallRecord[]) {
    const remaining = (definition.maxToolCalls ?? defaultFundingAgentToolCalls) - calls.length;
    if (remaining <= 0) return [];
    const enabled = (ref: typeof statusRef | typeof optionsRef | typeof previewRef) => (
      definition.steps.includes(ref) && turn.toolSetup?.enabled[fundingToolKey(ref)!] !== false
    );
    const called = (ref: string) => calls.some(({ toolRef }) => toolRef === ref);
    const { funded, options, preview } = evidenceFrom(calls);
    if (funded === undefined) return enabled(statusRef) && !called(statusRef) ? [statusRef] : [];
    if (funded) return [];
    if (!options) return enabled(optionsRef) && !called(optionsRef) ? [optionsRef] : [];
    if (preview || !enabled(previewRef)) return [];
    if (turn.public.message === fundingPreviewWorkflow.label && !turn.fundingRun?.answerTo) {
      return remaining >= 2 ? [ASK_USER.ref] : [];
    }
    return remaining >= 2 ? [previewRef, ASK_USER.ref] : [previewRef];
  }

  async narrow(request: NeutralModelRequest, runId: string) {
    if (!request.tools.some(({ ref }) => fundingToolKey(ref))) {
      return fundingModelTools(request, (ref) => ref !== ASK_USER.ref);
    }
    const { turn, definition } = await this.scope(runId);
    const allowed = this.available(turn, definition, await this.sfield().persistence.listCalls(runId));
    const narrowed = fundingModelTools(request, (ref) => allowed.includes(ref));
    return {
      ...narrowed,
      tools: narrowed.tools.map((tool) => {
        if (tool.ref === ASK_USER.ref) return tool;
        return { ...tool, inputSchema: tool.ref === previewRef ? fundingAgentPreviewInputSchema : fundingAgentReadInputSchema };
      }),
    };
  }

  async prepare(toolRef: string, inputs: JsonObject, runId: string): Promise<{ inputs: JsonObject } | undefined> {
    if (!fundingToolKey(toolRef) && toolRef !== ASK_USER.ref) return;
    const run = await this.sfield().persistence.getRun(runId);
    if (run?.agentId !== fundingAgentId) {
      requireCheck(toolRef !== ASK_USER.ref, "FUNDING_INPUT_SCOPE_REQUIRED");
      return;
    }
    const { root, turn, definition } = await this.scope(runId, run);
    const calls = await this.sfield().persistence.listCalls(runId);
    const batchId = calls.at(-1)?.batchId;
    const batch = calls.filter((call) => call.batchId === batchId);
    const earlier = calls.filter((call) => call.batchId !== batchId);
    requireCheck(batch.length === 1 && this.available(turn, definition, earlier).includes(toolRef), "FUNDING_TOOL_NOT_AVAILABLE");
    if (toolRef === ASK_USER.ref) return { inputs: { question: fundingChoiceQuestion, response_type: "string" } };
    return { inputs: { ...inputs, turnRef: root.public.id } };
  }

  async scopedTurn(turnRef: unknown, ctx: ToolHandlerContext) {
    ctx.signal.throwIfAborted();
    const run = await this.sfield().persistence.getRun(ctx.runId);
    if (run?.agentId !== fundingAgentId) return;
    const { root, turn } = await this.scope(ctx.runId, run);
    requireCheck(ctx.principal.tenantId === serverTenantId
      && ctx.principal.subjectId === turn.scope.principalId && turnRef === root.public.id, "FUNDING_TURN_SCOPE_MISMATCH");
    return turn;
  }

  async verify(output: unknown, runId: string): Promise<FundingAgentResult> {
    await this.scope(runId);
    const proposal = fundingAgentOutputSchema.parse(output);
    const evidence = evidenceFrom(await this.sfield().persistence.listCalls(runId));
    if (proposal.outcome === "preview") {
      requireCheck(evidence.funded === false && evidence.preview && evidence.preview.method.methodId === proposal.methodId, "FUNDING_PREVIEW_REQUIRED");
      return { outcome: "preview", preview: evidence.preview };
    }
    requireCheck(proposal.methodId === null, "FUNDING_METHOD_UNEXPECTED");
    if (proposal.outcome === "options") {
      requireCheck(evidence.funded === false && evidence.options, "FUNDING_OPTIONS_REQUIRED");
      return { outcome: "options", options: evidence.options };
    }
    if (proposal.outcome === "already_funded") requireCheck(evidence.funded === true, "FUNDING_STATUS_REQUIRED");
    return { outcome: proposal.outcome };
  }

  async execute(
    turn: TurnRecord, definition: FundingWorkflowDefinition, principal: Principal, recent: RoutingHistoryEntry[],
    offerExpiresAt: number, signal: AbortSignal,
  ): Promise<FundingAgentResult> {
    const sf = this.sfield();
    const prior = turn.fundingRun;
    const turnId = turn.public.id;
    signal.throwIfAborted();
    let handle = prior ? await sf.runs.get({ runId: prior.id, principal }) : await sf.runs.start({
      agent: fundingAgentId, principal,
      request: {
        idempotencyKey: turnId + ":funding",
        inputs: { turnRef: turnId },
        message: { text: JSON.stringify({
          inputType: "PznFundingInput", goal: definition.goal ?? fundingAgentGoal,
          workflow: turn.workflow?.recommendation, request: turn.public.message, recent,
        }) },
      },
    });
    const abort = () => { void handle.cancel("Application turn ended").catch(() => undefined); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      requireCheck(this.store.update(turnId, (row) => {
        row.fundingRun ??= { id: handle.id, rootTurnId: turnId, after: { attempts: 0, calls: 0 } };
      }), "TURN_INACTIVE");
      await this.scope(handle.id);
      if (prior?.answerTo) {
        const question = await sf.persistence.getInputRequest(prior.answerTo);
        requireCheck(question?.runId === handle.id && question.recipientScope.tenantId === principal.tenantId
          && question.recipientScope.subjectId === principal.subjectId, "FUNDING_INPUT_SCOPE_REQUIRED");
        if (question.status === "pending") {
          requireCheck(Date.parse(question.expiresAt) > this.now(), "FUNDING_INPUT_EXPIRED");
          await sf.inputs.answer({ requestId: question.requestId, actor: principal, value: turn.public.message });
        } else {
          requireCheck(question.status === "answered" && question.answer?.value === turn.public.message, "FUNDING_INPUT_ALREADY_USED");
        }
        const snapshot = await handle.snapshot();
        if (snapshot.state === "waiting_input" || snapshot.state === "queued") {
          try {
            handle = await sf.runs.resume({ runId: handle.id, principal });
          } catch (error) {
            if (!SFieldError.is(error, "RUN_NOT_RESUMABLE") || !isTerminal((await handle.snapshot()).state)) throw error;
          }
        }
      }
      const result = await handle.result();
      signal.throwIfAborted();
      const [calls, attempts] = await Promise.all([sf.persistence.listCalls(handle.id), sf.persistence.listModelAttempts(handle.id)]);
      let verified: FundingAgentResult;
      let waiting: NonNullable<TurnRecord["fundingRun"]>["waiting"];
      if (result.state === "waiting_input") {
        const requestId = result.pending?.inputs[0];
        const request = requestId && await sf.persistence.getInputRequest(requestId);
        const { options, funded } = evidenceFrom(calls);
        requireCheck(request && request.status === "pending" && options && funded === false, "FUNDING_INPUT_NOT_READY");
        const expiresAt = Math.min(Date.parse(request.expiresAt), offerExpiresAt, this.now() + DECISION_TTL);
        requireCheck(expiresAt > this.now(), "FUNDING_INPUT_EXPIRED");
        waiting = { requestId: request.requestId, expiresAt };
        verified = { outcome: "waiting_input", question: fundingChoiceQuestion, options, expiresAt };
      } else {
        verified = result.state === "completed" ? await this.verify(result.output, handle.id) : { outcome: "unavailable" };
      }
      requireCheck(this.store.update(turnId, (row) => {
        requireCheck(row.fundingRun?.id === handle.id, "FUNDING_RUN_SCOPE_MISMATCH");
        row.fundingRun.through = { calls: calls.length, attempts: attempts.length };
        row.fundingRun.outcome = verified.outcome;
        row.fundingRun.waiting = waiting;
        if (result.error) row.trace.failures.push({ stage: "workflow", code: result.error.code });
      }), "TURN_INACTIVE");
      return verified;
    } catch (error) {
      await handle.cancel("Funding request ended").catch(() => undefined);
      if (signal.aborted) signal.throwIfAborted();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}
