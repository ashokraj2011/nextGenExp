import { EventEmitter } from "node:events";
import { SqliteDatabase } from "@sfield/store-sqlite";
import type { UsageSummary } from "@sfield/core";
import type { CatalogSnapshot, ContentDecision, PropensityResult, RouteDecision, BalanceProof, Scope, SelectionMode } from "../../packages/contracts/domain";
import type { Conversation, FailureCode, Progress, PublicEvent, PublicEventType, TurnView } from "../../packages/contracts/api";
import type { GatewayExchange } from "../../packages/contracts/inspector";
import type { GoalProgress } from "../../packages/contracts/goal-progress";
import {
  asksAboutFunding, defaultAgentFundingWorkflow, type WorkflowLaunch,
} from "../../packages/contracts/funding-workflow";
import type { PortfolioSnapshot } from "../../packages/contracts/portfolio";
import type { RoutingIntentId } from "../../packages/contracts/routing-intents";
import { defaultToolSetup, type MockCcreEvaluation, type ToolSetup, type TreatmentSource } from "../../packages/contracts/tool-setup";
import type { CompiledExperience, IssuedAction } from "../../packages/experience/compile";
import { makeId } from "../../packages/experience/compile";
import type { ContextScoresRequest, Rejection } from "../../packages/ts-adapter";

export type Stage = "route" | "compose";
export const stageAgent: Record<Stage, string> = { route: "context-router", compose: "experience-composer" };
export type StageAttempt = {
  id: string;
  stage: Stage;
  sessionId: string;
  decisionRef: string;
  idempotencyKey: string;
  runId: string | null;
  startedAt: number;
};
export type StageTrace = Pick<UsageSummary, "elapsedMs" | "modelCalls" | "providerAttempts" | "toolCalls" | "totalTokens" | "tokensReported"> & {
  state: string; errorCode?: string;
};
export type TurnTrace = {
  surface: "chat";
  sourcePageContext: string | null;
  markers: Record<string, number>;
  ts?: { contextId: string; baseline: string[]; fixtureVersion: string; rejections: Rejection[]; partial: boolean; source?: TreatmentSource };
  finalOrder?: string[];
  components?: string[];
  routeOutcome?: string;
  intentId?: RoutingIntentId | null;
  possibleIntentId?: RoutingIntentId;
  glossaryVersion?: string;
  selectionMode: SelectionMode;
  failures: { stage: string; code: string }[];
  routeRun?: StageTrace;
  composeRun?: StageTrace;
};

export type ConversationRecord = Conversation & {
  principalId: string;
  sessions: Partial<Record<Stage, string>>;
};
type FundingLogPosition = { attempts: number; calls: number };
export type FundingRun = {
  id: string;
  rootTurnId: string;
  after: FundingLogPosition;
  through?: FundingLogPosition;
  answerTo?: string;
  waiting?: { requestId: string; expiresAt: number };
  outcome?: string;
};
export type TurnRecord = {
  public: TurnView;
  scope: Scope;
  ordinal: number;
  requestId: string;
  origin: string;
  selectionMode: SelectionMode;
  toolSetup?: ToolSetup;
  attempts: Partial<Record<Stage, StageAttempt>>;
  trace: TurnTrace;
  catalogScopeId?: string;
  tsScopeId?: string;
  glossaryScopeId?: string;
  portfolioScopeId?: string;
  portfolioForRule?: PortfolioSnapshot;
  portfolioSnapshot?: PortfolioSnapshot;
  goalScopeId?: string;
  goalProgress?: GoalProgress;
  workflow?: WorkflowLaunch;
  workflowScopeId?: string;
  fundingRun?: FundingRun;
  treatmentScores?: { scopeId: string; input: ContextScoresRequest };
  treatmentMockInput?: { mid: string; context: string };
  treatmentCcre?: MockCcreEvaluation;
  catalog?: CatalogSnapshot;
  propensity?: PropensityResult;
  route?: RouteDecision;
  decision?: ContentDecision;
  proof?: BalanceProof;
};
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
function parse<T>(row?: { record: string }): T | undefined {
  return row ? JSON.parse(row.record) as T : undefined;
}
export function presentConversation(record: ConversationRecord): Conversation {
  const { id, title, personaId, scenarioId, updatedAt } = record;
  return { id, title, personaId, scenarioId, updatedAt };
}
function inaccessible(): never {
  throw new ApiError(404, "not_found", "This item is unavailable.");
}

export class Store {
  private readonly db: SqliteDatabase;
  private readonly events = new EventEmitter().setMaxListeners(0);
  constructor(path: string) {
    this.db = new SqliteDatabase(path);
    this.db.open();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS tool_setups (
        principal_id TEXT PRIMARY KEY REFERENCES local_sessions(id), record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gateway_exchanges (
        attempt_id TEXT PRIMARY KEY, record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, updated_at INTEGER NOT NULL, record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversations_principal ON conversations(principal_id, updated_at);
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        request_id TEXT NOT NULL, ordinal INTEGER NOT NULL, status TEXT NOT NULL, record TEXT NOT NULL,
        UNIQUE(conversation_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS turns_conversation ON turns(conversation_id);
      CREATE INDEX IF NOT EXISTS turns_running ON turns(status);
      CREATE TABLE IF NOT EXISTS public_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
        turn_id TEXT NOT NULL REFERENCES turns(id), type TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_turn ON public_events(turn_id, sequence);
      CREATE TABLE IF NOT EXISTS experiences (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id), actions TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analytics (
        id TEXT PRIMARY KEY, experience_id TEXT NOT NULL REFERENCES experiences(id), event_type TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS analytics_rendered ON analytics(experience_id, event_type)
        WHERE event_type IN ('rendered', 'render_fallback');
    `);
  }

  session(id?: string) {
    if (id && this.db.one("SELECT id FROM local_sessions WHERE id = ?", id)) return { id, created: false };
    const sessionId = makeId("local");
    this.db.run("INSERT INTO local_sessions (id) VALUES (?)", sessionId);
    return { id: sessionId, created: true };
  }

  toolSetup(principalId: string) {
    return parse<ToolSetup>(this.db.one("SELECT record FROM tool_setups WHERE principal_id = ?", principalId)) ?? defaultToolSetup;
  }

  saveToolSetup(principalId: string, setup: ToolSetup) {
    this.db.run(`
      INSERT INTO tool_setups (principal_id, record) VALUES (?, ?)
      ON CONFLICT(principal_id) DO UPDATE SET record = excluded.record
    `, principalId, JSON.stringify(setup));
  }

  gatewayExchange(attemptId: string) {
    return parse<GatewayExchange>(this.db.one("SELECT record FROM gateway_exchanges WHERE attempt_id = ?", attemptId));
  }

  saveGatewayExchange(attemptId: string, exchange: GatewayExchange) {
    this.db.run("INSERT OR IGNORE INTO gateway_exchanges (attempt_id, record) VALUES (?, ?)", attemptId, JSON.stringify(exchange));
  }

  createConversation(principalId: string, personaId: string, scenarioId: string, now: number) {
    const record: ConversationRecord = { id: makeId("conv"), principalId, personaId, scenarioId, title: "New conversation", updatedAt: now, sessions: {} };
    this.db.run("INSERT INTO conversations VALUES (?, ?, ?, ?)", record.id, principalId, now, JSON.stringify(record));
    return record;
  }

  conversations(principalId: string) {
    return this.db.all<{ record: string }>("SELECT record FROM conversations WHERE principal_id = ? ORDER BY updated_at DESC, rowid DESC", principalId)
      .map((row) => presentConversation(parse<ConversationRecord>(row)!));
  }

  conversation(id: string, principalId: string) {
    const record = parse<ConversationRecord>(this.db.one("SELECT record FROM conversations WHERE id = ? AND principal_id = ?", id, principalId));
    return record ?? inaccessible();
  }

  setSession(record: ConversationRecord, stage: Stage, sessionId: string) {
    const next = this.conversation(record.id, record.principalId);
    next.sessions[stage] = sessionId;
    this.saveConversation(next);
    return next;
  }

  private saveConversation(record: ConversationRecord) {
    this.db.run("UPDATE conversations SET record = ?, updated_at = ? WHERE id = ?", JSON.stringify(record), record.updatedAt, record.id);
  }

  turn(id: string) {
    return parse<TurnRecord>(this.db.one("SELECT record FROM turns WHERE id = ?", id));
  }

  ownTurn(id: string, principalId: string) {
    const record = this.turn(id);
    return record?.scope.principalId === principalId ? record : inaccessible();
  }

  conversationTurns(id: string) {
    return this.db.all<{ record: string }>("SELECT record FROM turns WHERE conversation_id = ? ORDER BY rowid", id)
      .map((row) => parse<TurnRecord>(row)!);
  }

  workingTurns() {
    return this.db.all<{ record: string }>("SELECT record FROM turns WHERE status = 'working' ORDER BY rowid")
      .map((row) => parse<TurnRecord>(row)!);
  }

  latestTurn(id: string) {
    return parse<TurnRecord>(this.db.one("SELECT record FROM turns WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1", id));
  }

  private saveTurn(record: TurnRecord) {
    this.db.run("UPDATE turns SET record = ?, status = ? WHERE id = ?", JSON.stringify(record), record.public.status, record.public.id);
  }

  existingRequest(conversationId: string, requestId: string, message: string, origin: string) {
    const existing = parse<TurnRecord>(this.db.one("SELECT record FROM turns WHERE conversation_id = ? AND request_id = ?", conversationId, requestId));
    if (existing && (existing.public.message !== message || existing.origin !== origin)) {
      throw new ApiError(409, "request_conflict", "This request ID already belongs to a different message.");
    }
    return existing;
  }

  accept(input: {
    conversation: ConversationRecord; requestId: string; origin: string; message: string; selectionMode: SelectionMode; now: number;
    retry?: TurnRecord; workflow?: WorkflowLaunch;
  }) {
    let created = false;
    const turn = this.db.tx(() => {
      const { conversation, requestId, origin, message, selectionMode, now, retry } = input;
      const previous = this.existingRequest(conversation.id, requestId, message, origin);
      if (previous) return previous;
      const latest = this.latestTurn(conversation.id);
      if (latest?.public.status === "working") throw new ApiError(409, "turn_active", "Wait for the current response or stop it first.");
      if (retry && (latest?.public.id !== retry.public.id || !["cancelled", "failed"].includes(retry.public.status))) {
        throw new ApiError(409, "retry_stale", "Start a fresh request to ask this question again.");
      }

      const id = makeId("turn");
      const setup = this.toolSetup(conversation.principalId);
      const workflowDefinition = setup.fundingWorkflow ?? defaultAgentFundingWorkflow;
      const paused = origin === "message" && latest?.workflow ? latest.fundingRun : undefined;
      const continuation = paused?.through && paused.waiting && paused.waiting.expiresAt > now ? {
        id: paused.id, rootTurnId: paused.rootTurnId, after: paused.through, answerTo: paused.waiting.requestId,
      } : undefined;
      const offered = !continuation && origin === "message" && workflowDefinition.mode === "agent" && asksAboutFunding(message)
        && latest?.public.experience && latest.public.experience.expiresAt > now
        ? this.experience(latest.public.experience.experienceId, conversation.principalId).actions.find(({ workflow }) => workflow)?.workflow
        : undefined;
      const launch = retry?.workflow ?? input.workflow ?? (continuation ? latest?.workflow : undefined)
        ?? (offered && latest?.public.experience ? { recommendation: offered, sourceExperienceId: latest.public.experience.experienceId } : undefined);
      const record: TurnRecord = {
        public: { id, conversationId: conversation.id, message, createdAt: now, status: "working", progress: "accepted", retryOf: retry?.public.id },
        scope: { turnId: id, principalId: conversation.principalId, conversationId: conversation.id, personaId: conversation.personaId },
        ordinal: retry?.ordinal ?? (latest?.ordinal ?? 0) + 1,
        requestId, origin, selectionMode, attempts: {},
        workflow: launch,
        fundingRun: continuation,
        toolSetup: continuation ? latest?.toolSetup : setup.fundingWorkflow ? setup : { ...setup, fundingWorkflow: workflowDefinition },
        trace: { surface: "chat", sourcePageContext: null, selectionMode, markers: { accepted: now }, failures: [] },
      };
      this.db.run("INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?)", id, conversation.id, requestId, record.ordinal, "working", JSON.stringify(record));
      if (!latest) conversation.title = [...message.replace(/\s+/g, " ")].slice(0, 54).join("");
      conversation.updatedAt = now;
      this.saveConversation(conversation);
      this.addEvent(record, "turn.accepted", { progress: "accepted" });
      created = true;
      return record;
    });
    if (created) this.events.emit(turn.public.id);
    return { turn, created };
  }

  update(id: string, change: (record: TurnRecord) => void) {
    return this.db.tx(() => {
      const turn = this.turn(id);
      if (!turn || turn.public.status !== "working") return undefined;
      change(turn);
      this.saveTurn(turn);
      return turn;
    });
  }

  progress(id: string, progress: Progress, now: number) {
    const record = this.db.tx(() => {
      const result = this.update(id, (turn) => {
        turn.public.progress = progress;
        turn.trace.markers[progress] ??= now;
      });
      if (result) this.addEvent(result, "turn.status", { progress });
      return result;
    });
    if (record) this.events.emit(id);
  }

  finish(
    id: string,
    outcome: { type: "completed"; result: CompiledExperience } | { type: "failed"; code: FailureCode } | { type: "cancelled" },
    now: number,
  ) {
    const record = this.db.tx(() => {
      const turn = this.turn(id);
      if (!turn || turn.public.status !== "working") return undefined;
      turn.public.status = outcome.type;
      turn.trace.markers.terminal = now;
      if (outcome.type === "completed") {
        const { display, issued } = outcome.result;
        turn.public.experience = display;
        turn.trace.markers.compiled = now;
        this.db.run("INSERT INTO experiences VALUES (?, ?, ?)", display.experienceId, id, JSON.stringify(issued));
        this.addEvent(turn, "experience.ready", {
          experienceId: display.experienceId, messageId: display.messageId, a2uiVersion: display.a2uiVersion, messages: display.messages,
        });
      } else if (outcome.type === "failed") {
        turn.public.failureCode = outcome.code;
        this.addEvent(turn, "turn.failed", { code: outcome.code });
      } else {
        this.addEvent(turn, "turn.cancelled", {});
      }
      this.saveTurn(turn);
      return turn;
    });
    if (record) this.events.emit(id);
    return record;
  }

  experience(experienceId: string, principalId: string) {
    const row = this.db.one<{ turn_id: string; actions: string }>("SELECT turn_id, actions FROM experiences WHERE id = ?", experienceId);
    if (!row) return inaccessible();
    return { turn: this.ownTurn(row.turn_id, principalId), actions: JSON.parse(row.actions) as IssuedAction[] };
  }

  analytics(principalId: string, experienceId: string, eventId: string, type: "rendered" | "render_fallback" | "helpful" | "unhelpful", now: number) {
    this.db.tx(() => {
      const { turn } = this.experience(experienceId, principalId);
      if (!this.db.run("INSERT OR IGNORE INTO analytics VALUES (?, ?, ?, ?)", eventId, experienceId, type, now).changes) return;
      if (type === "rendered" || type === "render_fallback") {
        turn.trace.markers.displayed ??= now;
        if (type === "render_fallback") turn.trace.markers.renderFallback = now;
      } else {
        turn.public.feedback = type;
        turn.trace.markers.feedback = now;
      }
      this.saveTurn(turn);
    });
  }

  private addEvent(turn: TurnRecord, type: PublicEventType, payload: Record<string, unknown>) {
    this.db.run("INSERT INTO public_events (event_id, turn_id, type, payload) VALUES (?, ?, ?, ?)",
      makeId("evt"), turn.public.id, type, JSON.stringify(payload));
  }

  replay(turn: TurnRecord, cursor: number) {
    if (cursor && !this.db.one("SELECT sequence FROM public_events WHERE turn_id = ? AND sequence = ?", turn.public.id, cursor)) return null;
    return this.db.all<{ sequence: number; event_id: string; type: PublicEventType; payload: string }>(
      "SELECT sequence, event_id, type, payload FROM public_events WHERE turn_id = ? AND sequence > ? ORDER BY sequence", turn.public.id, cursor,
    ).map(({ sequence, event_id, type, payload }): PublicEvent => ({
      sequence, eventId: event_id, conversationId: turn.public.conversationId, turnId: turn.public.id, type, payload: JSON.parse(payload),
    }));
  }

  subscribe(turnId: string, fn: () => void) {
    this.events.on(turnId, fn);
    return () => this.events.off(turnId, fn);
  }

  close() {
    this.events.removeAllListeners();
    this.db.close();
  }
}
