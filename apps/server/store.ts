import { serverTenantId } from "./tenant";
import { digestJson } from "@sfield/core";
import { inheritedFlows, resolveTurnFlows, type FlowCatalogSetup, type FlowOverrides, type FlowScope, type TurnFlowCatalog } from "../../packages/contracts/routing-flows";
import type { RuleWorkflowMatch } from "../../packages/contracts/customer-workflows";
import type { DomainPackId } from "../../packages/contracts/domain-packs";
import { normalizedIntentPhrase, layoutTargetDomain, maxLayouts, targetKey, type LibraryDesign, type AppliedUiLayout, type UiLayoutChange, type UiLayoutRecord, type UiPublication, type UiTarget } from "../../packages/contracts/ui-layout";
import { applyPublishedUi } from "../../packages/experience/ui-layout";
import { resolveMultiDomainBindings } from "../../packages/customer-profiles/bindings";
import { findProfileById } from "../../packages/customer-profiles";
import { applyPersonalization, firstNameOf } from "./response-personalizer";
import type { IncidentRecord } from "../../packages/contracts/ops";
import type { DealRecord } from "../../packages/contracts/sales";
import type { AgentLaunch } from "../../packages/contracts/agentic";
import { cancelsJourney, explicitInputs } from "./agentic-inputs";
import { AgenticStore } from "./agentic-store";
import { EventEmitter } from "node:events";
import { SqliteDatabase } from "@sfield/store-sqlite";
import type { UsageSummary } from "@sfield/core";
import type { ContentEntry, CatalogSnapshot, ContentDecision, PropensityResult, RouteDecision, BalanceProof, Scope, SelectionMode } from "../../packages/contracts/domain";
import type { Conversation, ConversationChange, ConversationFolder, FailureCode, Progress, PublicEvent, PublicEventType, TurnStatus, TurnView } from "../../packages/contracts/api";
import type { GatewayExchange, OfferClick, TimedCall, TreatmentRun, TurnExchange, TurnExchangeStage } from "../../packages/contracts/inspector";
import type { GoalProgress } from "../../packages/contracts/goal-progress";
import {
  asksAboutFunding, defaultAgentFundingWorkflow, fundingPreviewWorkflow, type ActionRecommendation, type TreatmentRecommendations, type WorkflowLaunch,
} from "../../packages/contracts/funding-workflow";
import type { PortfolioSnapshot } from "../../packages/contracts/portfolio";
import type { RoutingIntentId } from "../../packages/contracts/routing-intents";
import { defaultToolSetup, type MockCcreCondition, type MockCcreEvaluation, type ToolSetup, type TreatmentSource } from "../../packages/contracts/tool-setup";
import type { CompiledExperience, IssuedAction } from "../../packages/experience/compile";
import { buildSurface, compileExperience, makeId } from "../../packages/experience/compile";
import type { ContextScoresRequest, Rejection } from "../../packages/ts-adapter";
import { defaultWorkspacePins, overviewFundingOrigin, pendingActionsFundingOrigin, workspaceFundingContext, workspacePinsSchema,
  type WorkspaceActionLog, type WorkspacePendingAction, type WorkspacePin } from "../../packages/contracts/workspace";

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
  empathyCheck?: TimedCall & { model?: TimedCall };
  customerEvaluation?: TimedCall;
  customerRead?: { toolRef: string; runId: string };
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
  uiLayout?: AppliedUiLayout;
};

type ThreadViewer = { customer?: string; operator?: string };
const accessibleThreads = `(principal_id=? OR id IN (SELECT thread_id FROM user_threads WHERE tenant_id=? AND
  ((domain_id=\'wealth\' AND user_id=?) OR (domain_id<>\'wealth\' AND user_id=?))))`;

export type ConversationRecord = Conversation & {
  principalId: string;
  legacyTranscript?: boolean;
  preview?: { layout?: UiPublication; tools?: ToolSetup };
  sessions: Partial<Record<Stage, string>>;
  customTitle?: boolean;
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
export type WatchSource = { kind: "deal" | "task"; ref: string; recordId: string; target: string; label: string };
export type StoredWatch = WatchSource & { id: string; conversationId: string; principalId: string; personaId: string; value: string; state: "watching" | "reached"; updatedAt: number };
export type TurnRecord = {
  public: TurnView;
  historyStatus?: TurnStatus;
  requestSessionId?: string;
  agentLaunch?: AgentLaunch;
  agentRunId?: string;
  agentJourneyId?: string;
  agentExecutionIds?: string[];
  scope: Scope;
  ordinal: number;
  requestId: string;
  origin: string;
  selectionMode: SelectionMode;
  toolSetup?: ToolSetup;
  flowCatalog?: TurnFlowCatalog;
  uiLayouts?: UiPublication[];
  attempts: Partial<Record<Stage, StageAttempt>>;
  trace: TurnTrace;
  catalogScopeId?: string;
  tsScopeId?: string;
  glossaryScopeId?: string;
  retirementScopeId?: string;
  retirementAccounts?: import("../../packages/contracts/retirement-accounts").RetirementView;
  portfolioScopeId?: string;
  portfolioForRule?: PortfolioSnapshot;
  portfolioSnapshot?: PortfolioSnapshot;
  goalScopeId?: string;
  goalProgress?: GoalProgress;
  workflow?: WorkflowLaunch;
  workflowScopeId?: string;
  fundingRun?: FundingRun;
  treatmentScores?: { scopeId: string; input: ContextScoresRequest };
  treatmentMockInput?: { mid: string; context: string; accountId?: string };
  treatmentCcre?: MockCcreEvaluation;
  treatmentFormats?: { legacy: string[]; workflows: TreatmentRecommendations; matches?: RuleWorkflowMatch[]; actionMatches?: { name: string; contextId: string; condition: MockCcreCondition; action: ActionRecommendation }[] };
  treatmentEntries?: ContentEntry[];
  recordId?: string;
  requestedRecordIntent?: string;
  operatorName?: string;
  customerTask?: { ref: string; recordId: string; runId: string; sfieldRunId?: string; sfieldCallId?: string; confirmWatch?: boolean };
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
  const { id, title, tenantId, domainId, userId, personaId, scenarioId, updatedAt, archivedAt, audience, folderId, forkedFrom } = record;
  return {
    id, title, tenantId, domainId, userId, personaId, scenarioId, updatedAt,
    ...(archivedAt === undefined ? {} : { archivedAt }),
    ...(audience && { audience }),
    ...(folderId && { folderId }),
    ...(forkedFrom && { forkedFrom }),
  };
}
function inaccessible(): never {
  throw new ApiError(404, "not_found", "This item is unavailable.");
}

const operatorTurn = `json_extract(record, '$.public.actionMode') = 'dynamic_ui'
  AND json_extract(record, '$.public.semanticRoute.capabilityId') IN ('hitl_approvals','external_connector','ops_incident','sales_deal_desk')`;

export class Store {
  private readonly db: SqliteDatabase;
  readonly axe: AgenticStore;
  private readonly events = new EventEmitter().setMaxListeners(0);
  private domainBindingContext?: (id: string) => { incident?: IncidentRecord; deal?: DealRecord };

  setDomainBindingContext(provider: (id: string) => { incident?: IncidentRecord; deal?: DealRecord }) {
    this.domainBindingContext = provider;
  }
  constructor(path: string) {
    this.db = new SqliteDatabase(path);
    this.db.open();
    this.axe = new AgenticStore(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS session_profiles (session_id TEXT PRIMARY KEY REFERENCES local_sessions(id), persona_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_preferences (
        principal_id TEXT NOT NULL, persona_id TEXT NOT NULL, pins TEXT NOT NULL, PRIMARY KEY (principal_id, persona_id)
      );
      CREATE TABLE IF NOT EXISTS workspace_todos (
        persona_id TEXT NOT NULL, content_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (persona_id, content_id)
      );
      CREATE TABLE IF NOT EXISTS workspace_action_logs (
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES local_sessions(id), record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workspace_actions_principal ON workspace_action_logs(principal_id);
      CREATE TABLE IF NOT EXISTS tool_setups (
        principal_id TEXT PRIMARY KEY REFERENCES local_sessions(id), record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS domain_tool_setups (
        tenant_id TEXT NOT NULL, domain_id TEXT NOT NULL, scope_key TEXT NOT NULL, record TEXT NOT NULL,
        PRIMARY KEY (tenant_id, domain_id, scope_key)
      );
      CREATE TABLE IF NOT EXISTS gateway_exchanges (
        attempt_id TEXT PRIMARY KEY, record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS routing_flow_settings (
        tenant_id TEXT NOT NULL, scope TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (tenant_id, scope)
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, updated_at INTEGER NOT NULL, record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_folders (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, domain_id TEXT NOT NULL,
        name TEXT NOT NULL, instructions TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS folders_principal ON conversation_folders(principal_id, domain_id, name);
      CREATE TABLE IF NOT EXISTS user_threads (
        thread_id TEXT PRIMARY KEY REFERENCES conversations(id), tenant_id TEXT NOT NULL, domain_id TEXT NOT NULL, user_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS user_threads_owner ON user_threads(tenant_id,domain_id,user_id);
      CREATE INDEX IF NOT EXISTS conversations_principal ON conversations(principal_id, updated_at);
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        request_id TEXT NOT NULL, ordinal INTEGER NOT NULL, status TEXT NOT NULL, record TEXT NOT NULL,
        UNIQUE(conversation_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS turns_conversation ON turns(conversation_id);
      CREATE INDEX IF NOT EXISTS turns_running ON turns(status);
      CREATE TABLE IF NOT EXISTS turn_exchanges (
        turn_id TEXT NOT NULL REFERENCES turns(id), stage TEXT NOT NULL, record TEXT NOT NULL,
        PRIMARY KEY (turn_id, stage)
      );
      CREATE INDEX IF NOT EXISTS operator_turns ON turns(conversation_id) WHERE ${operatorTurn};
      CREATE INDEX IF NOT EXISTS completed_conversation_turns ON turns(conversation_id, ordinal) WHERE status = 'completed';
      CREATE TABLE IF NOT EXISTS record_watches (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), checked_at INTEGER NOT NULL DEFAULT 0, record TEXT NOT NULL,
        UNIQUE(conversation_id, id)
      );
      CREATE INDEX IF NOT EXISTS watches_due ON record_watches(json_extract(record, '$.state'), checked_at);
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
      UPDATE conversations SET record = json_set(record, '$.audience', 'admin')
        WHERE json_extract(record, '$.audience') IS NULL AND id IN (
          SELECT conversation_id FROM turns WHERE json_extract(record, '$.trace.intentId') = 'create_rule'
            OR json_extract(record, '$.public.experience.outcome') = 'create_rule'
        );
    `);
    this.initializeDesignLibrary();
    const folderCols = this.db.all<{ name: string }>("PRAGMA table_info(conversation_folders)");
    if (!folderCols.some((c) => c.name === "instructions")) {
      this.db.run("ALTER TABLE conversation_folders ADD COLUMN instructions TEXT");
    }
    this.db.run(`INSERT OR IGNORE INTO user_threads SELECT c.id, ?, json_extract(c.record,'$.domainId'), json_extract(c.record,'$.userId')
      FROM conversations c WHERE json_extract(c.record,'$.tenantId')=? AND json_extract(c.record,'$.audience') IS NULL
      AND (json_extract(c.record,'$.domainId') IN ('it_ops','sales_revops') OR EXISTS (
        SELECT 1 FROM session_profiles p WHERE p.session_id=c.principal_id AND p.persona_id=json_extract(c.record,'$.userId')
        AND NOT EXISTS (SELECT 1 FROM turns WHERE conversation_id=c.id AND ${operatorTurn})))`, serverTenantId, serverTenantId);
  }

  private initializeDesignLibrary() {
    this.db.tx(() => {
      if (this.db.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='domain_ui_layouts'")) return;
      this.db.exec(`
        CREATE TABLE domain_ui_layouts (
          tenant_id TEXT NOT NULL, domain_id TEXT NOT NULL, owner_key TEXT NOT NULL,
          id TEXT NOT NULL, updated_at INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY (tenant_id, id)
        );
        CREATE INDEX domain_layout_owner ON domain_ui_layouts(tenant_id, owner_key);
        CREATE INDEX domain_layout_publication ON domain_ui_layouts(tenant_id, domain_id) WHERE json_type(record, '$.published')='object';
        UPDATE conversations AS c SET record = json_set(record, '$.domainId', COALESCE((
            SELECT CASE json_extract(t.record, '$.public.semanticRoute.capabilityId') WHEN 'ops_incident' THEN 'it_ops' ELSE 'sales_revops' END
            FROM turns t WHERE t.conversation_id=c.id AND json_extract(t.record,'$.public.semanticRoute.capabilityId') IN ('ops_incident','sales_deal_desk')
            ORDER BY t.ordinal DESC LIMIT 1), 'wealth'), '$.legacyTranscript', json('true'))
          WHERE json_extract(record,'$.domainId') IS NULL;
      `);
      this.db.run("UPDATE conversations SET record=json_set(record,'$.tenantId',?) WHERE json_extract(record,'$.tenantId') IS NULL", serverTenantId);
      this.db.exec(`UPDATE conversations AS c SET record=json_set(record, '$.userId',
        COALESCE((SELECT json_extract(t.record,'$.operatorName') FROM turns t WHERE t.conversation_id=c.id
          AND json_extract(c.record,'$.domainId')!='wealth' AND json_extract(t.record,'$.operatorName') IS NOT NULL
          ORDER BY t.ordinal DESC LIMIT 1), json_extract(c.record,'$.personaId')))`);
      if (!this.db.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ui_layouts'")) return;
      const used = new Set<string>();
      const rows = this.db.all<{ principal_id: string; record: string }>("SELECT principal_id, record FROM ui_layouts ORDER BY updated_at DESC, id");
      for (const row of rows) {
        const legacy = JSON.parse(row.record) as UiLayoutRecord;
        const slots = JSON.stringify((legacy.published?.design ?? legacy.draft).slots);
        const domainId: DomainPackId = /\bincident\./.test(slots) ? "it_ops" : /\bdeal\./.test(slots) ? "sales_revops" : "wealth";
        const keys = legacy.published?.design.targets.map((target) => domainId + ":" + targetKey(target)) ?? [];
        const record = { ...legacy, domainId };
        if (keys.some((key) => used.has(key))) delete record.published;
        else for (const key of keys) used.add(key);
        this.db.run("INSERT INTO domain_ui_layouts VALUES (?, ?, ?, ?, ?, ?)",
          serverTenantId, domainId, "session:" + row.principal_id, record.id, record.updatedAt, JSON.stringify(record));
      }
    });
  }

  watch(conversation: ConversationRecord, source: WatchSource, value: string) {
    const id = [conversation.id, source.kind, source.ref, source.recordId, source.target].join(":");
    const record: StoredWatch = { ...source, id, conversationId: conversation.id, principalId: conversation.principalId, personaId: conversation.personaId, value, state: "watching", updatedAt: Date.now() };
    this.db.run("INSERT OR IGNORE INTO record_watches(id,conversation_id,checked_at,record) VALUES(?,?,?,?)", id, conversation.id, Date.now(), JSON.stringify(record));
  }

  watches(conversation: ConversationRecord) {
    return this.db.all<{ record: string }>("SELECT record FROM record_watches WHERE conversation_id=? ORDER BY rowid", conversation.id)
      .map((r) => JSON.parse(r.record) as StoredWatch);
  }

  watchDue(id: string) {
    return Boolean(this.db.one("SELECT id FROM record_watches WHERE id=? AND checked_at < ?", id, Date.now() - 5_000));
  }

  dueWatches() {
    return this.db.all<{ record: string }>("SELECT record FROM record_watches WHERE json_extract(record,'$.state')='watching' AND checked_at < ? ORDER BY checked_at LIMIT 12", Date.now() - 60_000)
      .map((r) => JSON.parse(r.record) as StoredWatch);
  }

  observeWatch(w: StoredWatch, value?: string) {
    const now = Date.now();
    const next = value === undefined || value === w.value ? w : { ...w, value, updatedAt: now, state: value === w.target ? "reached" : "watching" };
    this.db.run("UPDATE record_watches SET record=?, checked_at=? WHERE id=? AND json_extract(record,'$.state')='watching'", JSON.stringify(next), now, w.id);
  }

  session(id?: string) {
    if (id && this.db.one("SELECT id FROM local_sessions WHERE id = ?", id)) return { id, created: false };
    const sessionId = makeId("local");
    this.db.run("INSERT INTO local_sessions (id) VALUES (?)", sessionId);
    return { id: sessionId, created: true };
  }

  selectedProfile(sessionId: string) {
    return this.db.one<{ persona_id: string }>("SELECT persona_id FROM session_profiles WHERE session_id=?", sessionId)?.persona_id;
  }

  selectProfile(sessionId: string, personaId: string | null) {
    if (personaId === null) this.db.run("DELETE FROM session_profiles WHERE session_id=?", sessionId);
    else this.db.tx(() => {
      this.db.run("INSERT INTO session_profiles VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET persona_id=excluded.persona_id", sessionId, personaId);
      this.db.run(`INSERT OR IGNORE INTO user_threads
        SELECT id, ?, 'wealth', ? FROM conversations WHERE principal_id=? AND json_extract(record,'$.domainId')='wealth'
        AND json_extract(record,'$.userId')=? AND json_extract(record,'$.audience') IS NULL
        AND NOT EXISTS (SELECT 1 FROM turns WHERE conversation_id=conversations.id AND ${operatorTurn})`,
        serverTenantId, personaId, sessionId, personaId);
    });
  }

  toolSetup(domainId: DomainPackId = "wealth", previewSession?: string): ToolSetup {
    const read = (key: string) => parse<ToolSetup>(this.db.one(
      "SELECT record FROM domain_tool_setups WHERE tenant_id=? AND domain_id=? AND scope_key=?", serverTenantId, domainId, key,
    ));
    if (previewSession) {
      const draft = read(previewSession) ?? (domainId === "wealth"
        ? parse<ToolSetup>(this.db.one("SELECT record FROM tool_setups WHERE principal_id=?", previewSession)) : undefined);
      if (draft) return draft;
    }
    return read("published") ?? defaultToolSetup;
  }

  saveToolSetup(domainId: DomainPackId, setup: ToolSetup, previewSession?: string) {
    this.db.run(`INSERT INTO domain_tool_setups VALUES (?, ?, ?, ?)
      ON CONFLICT(tenant_id, domain_id, scope_key) DO UPDATE SET record=excluded.record`,
      serverTenantId, domainId, previewSession ?? "published", JSON.stringify(setup));
  }

  private flowOverrides(scope: FlowScope): FlowOverrides {
    return parse<FlowOverrides>(this.db.one("SELECT record FROM routing_flow_settings WHERE tenant_id=? AND scope=?", serverTenantId, scope)) ?? {};
  }

  flowSetup(scope: FlowScope, editableScopes: FlowScope[]) {
    const inherited = inheritedFlows(scope, scope === "tenant" ? {} : this.flowOverrides("tenant"));
    const overrides = this.flowOverrides(scope);
    const data: FlowCatalogSetup = { tenantId: serverTenantId, scope, editableScopes, inherited, overrides };
    return { data, revision: '"' + digestJson({ scope, inherited, overrides }) + '"' };
  }

  saveFlowSetup(scope: FlowScope, editableScopes: FlowScope[], overrides: FlowOverrides, expected?: string) {
    return this.db.tx(() => {
      const current = this.flowSetup(scope, editableScopes);
      if (expected && expected !== current.revision) throw new ApiError(412, "flows_changed", "Flow settings changed. Reload them before saving.");
      if (Object.keys(overrides).some((id) => !current.data.inherited.some((flow) => flow.id === id))) {
        throw new ApiError(400, "flow_scope_invalid", "Choose flows registered for this domain.");
      }
      this.db.run(`INSERT INTO routing_flow_settings VALUES (?, ?, ?) ON CONFLICT(tenant_id, scope) DO UPDATE SET record=excluded.record`,
        serverTenantId, scope, JSON.stringify(overrides));
      return this.flowSetup(scope, editableScopes);
    });
  }

  routingFlows(conversation: Conversation, tenantOperator: boolean) {
    const { domainId } = conversation;
    const audience = domainId === "wealth" && conversation.audience !== "admin" ? "customer" : "operator";
    return resolveTurnFlows(serverTenantId, domainId, audience, tenantOperator, this.flowOverrides("tenant"), this.flowOverrides(domainId));
  }

  listUiLayouts(principalId: string, operator: string) {
    return this.db.all<{ record: string }>("SELECT record FROM domain_ui_layouts WHERE tenant_id=? AND owner_key IN (?, ?) ORDER BY updated_at DESC, id",
      serverTenantId, "operator:" + operator, "session:" + principalId)
      .map((row) => parse<UiLayoutRecord>(row)!);
  }

  publishedUiLayouts(domainId?: DomainPackId): LibraryDesign[] {
    const sql = `SELECT domain_id, json_extract(record, '$.published') AS publication FROM domain_ui_layouts
      WHERE tenant_id=? AND json_type(record, '$.published')='object'`;
    return this.db.all<{ domain_id: DomainPackId; publication: string }>(sql + (domainId ? " AND domain_id=?" : "") + " ORDER BY updated_at DESC, id",
      serverTenantId, ...(domainId ? [domainId] : []))
      .map((row) => ({ ...JSON.parse(row.publication) as UiPublication, domainId: row.domain_id }));
  }

  changeUiLayout(principalId: string, operator: string, allowedDomains: readonly DomainPackId[], change: UiLayoutChange, now: number) {
    return this.db.tx(() => {
      const layouts = this.listUiLayouts(principalId, operator);
      const current = "id" in change ? layouts.find(({ id }) => id === change.id) : undefined;
      if ("id" in change) {
        if (!current) return inaccessible();
        if (current.revision !== change.revision) {
          throw new ApiError(409, "ui_layout_changed", "This layout changed in another tab. Reload to get the latest version.");
        }
      } else if (layouts.length >= maxLayouts) {
        throw new ApiError(409, "ui_layout_limit", "Edit an existing layout to continue.");
      }
      const domainId = current?.domainId ?? ("domainId" in change ? change.domainId : undefined) ?? "wealth";
      if (!allowedDomains.includes(domainId)) throw new ApiError(403, "domain_access_denied", "Publishing access is required for this domain.");
      if ("domainId" in change && change.domainId && change.domainId !== domainId) {
        throw new ApiError(409, "design_domain_changed", "Make a copy to publish this design in another domain.");
      }
      const id = current?.id ?? makeId("ui");
      const revision = (current?.revision ?? 0) + 1;
      const draft = change.operation === "unpublish" ? current!.draft : change.design;
      let published = current?.published;
      if (change.operation === "publish") {
        if (draft.targets.some((target) => layoutTargetDomain(target) !== domainId)) {
          throw new ApiError(400, "domain_attachment_invalid", "Attach an intent or capability supported by this domain.");
        }
        const keys = new Set(draft.targets.map(targetKey));
        const others = this.publishedUiLayouts(domainId).filter((item) => item.id !== id);
        const phrases = new Set(draft.recordIntent?.phrases.map(normalizedIntentPhrase));
        if (others.some((item) => item.design.recordIntent?.phrases.some((phrase) => phrases.has(normalizedIntentPhrase(phrase))))) {
          throw new ApiError(409, "ui_phrase_taken", "Another published intent in this domain already uses this phrase.");
        }
        const conflict = others.find((item) => item.design.targets.some((target) => keys.has(targetKey(target))));
        if (conflict) {
          throw new ApiError(409, "ui_attachment_taken", `An attachment is already in use by “${conflict.design.name}”. Unpublish that layout or remove the attachment from it.`);
        }
        published = { id, revision, design: draft };
      } else if (change.operation === "unpublish") {
        published = undefined;
      }
      const record: UiLayoutRecord = { id, domainId, revision, updatedAt: now, draft, published };
      this.db.run(`INSERT INTO domain_ui_layouts VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, id) DO UPDATE SET owner_key=excluded.owner_key, updated_at=excluded.updated_at, record=excluded.record`,
        serverTenantId, domainId, "operator:" + operator, id, now, JSON.stringify(record));

      return record;
    });
  }

  gatewayExchange(attemptId: string) {
    return parse<GatewayExchange>(this.db.one("SELECT record FROM gateway_exchanges WHERE attempt_id = ?", attemptId));
  }

  saveGatewayExchange(attemptId: string, exchange: GatewayExchange) {
    this.db.run("INSERT OR IGNORE INTO gateway_exchanges (attempt_id, record) VALUES (?, ?)", attemptId, JSON.stringify(exchange));
  }

  saveTurnExchange(turnId: string, stage: TurnExchangeStage, exchange: TurnExchange) {
    this.db.run("INSERT OR IGNORE INTO turn_exchanges (turn_id, stage, record) VALUES (?, ?, ?)", turnId, stage, JSON.stringify(exchange));
  }

  turnExchanges(turnId: string) {
    const result: Partial<Record<TurnExchangeStage, TurnExchange>> = {};
    for (const row of this.db.all<{ stage: TurnExchangeStage; record: string }>(
      "SELECT stage, record FROM turn_exchanges WHERE turn_id=?", turnId,
    )) result[row.stage] = JSON.parse(row.record) as TurnExchange;
    return result;
  }

  renderReceipt(experienceId: string) {
    return this.db.one<{ eventId: string; experienceId: string; type: string }>(
      "SELECT id AS eventId, experience_id AS experienceId, event_type AS type FROM analytics WHERE experience_id=? AND event_type IN ('rendered','render_fallback') ORDER BY created_at DESC LIMIT 1",
      experienceId,
    );
  }

  createConversation(principalId: string, personaId: string, scenarioId: string, now: number, audience?: Conversation["audience"], domainId: DomainPackId = "wealth", userId = personaId, preview?: ConversationRecord["preview"], folderId?: string) {
    const validFolderId = folderId && this.getFolder(folderId, principalId)?.domainId === domainId ? folderId : undefined;
    const record: ConversationRecord = {
      id: makeId("conv"), tenantId: serverTenantId, domainId, userId, principalId, personaId, scenarioId, title: "New conversation", updatedAt: now, sessions: {},
      ...(audience && { audience }), ...(preview && { preview }), ...(validFolderId && { folderId: validFolderId }),
    };
    this.db.tx(() => {
      this.db.run("INSERT INTO conversations VALUES (?, ?, ?, ?)", record.id, principalId, now, JSON.stringify(record));
      if (preview?.tools) this.saveToolSetup(domainId, preview.tools, principalId);
      if (!audience && (domainId !== "wealth" || this.selectedProfile(principalId) === userId)) {
        this.db.run("INSERT INTO user_threads VALUES (?, ?, ?, ?)", record.id, serverTenantId, domainId, userId);
      }
    });
    return record;
  }

  getFolder(id: string, principalId: string): ConversationFolder | undefined {
    const row = this.db.one<{ id: string; name: string; domain_id: DomainPackId; instructions: string | null; created_at: number; updated_at: number }>(
      "SELECT id, name, domain_id, instructions, created_at, updated_at FROM conversation_folders WHERE id = ? AND principal_id = ? AND tenant_id = ?",
      id, principalId, serverTenantId,
    );
    return row
      ? {
          id: row.id, name: row.name, domainId: row.domain_id,
          ...(row.instructions ? { instructions: row.instructions } : {}),
          createdAt: row.created_at, updatedAt: row.updated_at,
        }
      : undefined;
  }

  listFolders(principalId: string, domainId?: DomainPackId): ConversationFolder[] {
    const rows = domainId
      ? this.db.all<{ id: string; name: string; domain_id: DomainPackId; instructions: string | null; created_at: number; updated_at: number }>(
          "SELECT id, name, domain_id, instructions, created_at, updated_at FROM conversation_folders WHERE principal_id = ? AND tenant_id = ? AND domain_id = ? ORDER BY created_at ASC, name ASC",
          principalId, serverTenantId, domainId,
        )
      : this.db.all<{ id: string; name: string; domain_id: DomainPackId; instructions: string | null; created_at: number; updated_at: number }>(
          "SELECT id, name, domain_id, instructions, created_at, updated_at FROM conversation_folders WHERE principal_id = ? AND tenant_id = ? ORDER BY created_at ASC, name ASC",
          principalId, serverTenantId,
        );
    return rows.map((row) => ({
      id: row.id, name: row.name, domainId: row.domain_id,
      ...(row.instructions ? { instructions: row.instructions } : {}),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  createFolder(principalId: string, domainId: DomainPackId, name: string, now: number, instructions?: string): ConversationFolder {
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 48);
    if (!clean) throw new ApiError(400, "folder_name_invalid", "Enter a folder name.");
    const existing = this.listFolders(principalId, domainId);
    if (existing.length >= 24) throw new ApiError(409, "folder_limit", "You can create up to 24 folders.");
    const duplicate = existing.find((f) => f.name.toLowerCase() === clean.toLowerCase());
    if (duplicate) return duplicate;
    const cleanInstructions = instructions?.trim().slice(0, 600) || undefined;
    const folder: ConversationFolder = {
      id: makeId("fld"), name: clean, domainId,
      ...(cleanInstructions ? { instructions: cleanInstructions } : {}),
      createdAt: now, updatedAt: now,
    };
    this.db.run(
      "INSERT INTO conversation_folders (id, tenant_id, principal_id, domain_id, name, instructions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      folder.id, serverTenantId, principalId, domainId, folder.name, cleanInstructions ?? null, now, now,
    );
    return folder;
  }

  renameFolder(id: string, principalId: string, name: string, now: number): ConversationFolder {
    return this.updateFolder(id, principalId, { name }, now);
  }

  updateFolder(id: string, principalId: string, patch: { name?: string; instructions?: string | null }, now: number): ConversationFolder {
    const existing = this.getFolder(id, principalId);
    if (!existing) inaccessible();
    const nextName = patch.name !== undefined ? patch.name.replace(/\s+/g, " ").trim().slice(0, 48) : existing.name;
    if (!nextName) throw new ApiError(400, "folder_name_invalid", "Enter a folder name.");
    const nextInstructions = patch.instructions === undefined
      ? existing.instructions
      : (patch.instructions === null ? undefined : (patch.instructions.trim().slice(0, 600) || undefined));
    this.db.run(
      "UPDATE conversation_folders SET name = ?, instructions = ?, updated_at = ? WHERE id = ? AND principal_id = ? AND tenant_id = ?",
      nextName, nextInstructions ?? null, now, id, principalId, serverTenantId,
    );
    return {
      ...existing,
      name: nextName,
      ...(nextInstructions ? { instructions: nextInstructions } : { instructions: undefined }),
      updatedAt: now,
    };
  }

  folderConversations(folderId: string, principalId: string): ConversationRecord[] {
    return this.db.all<{ record: string }>(
      "SELECT record FROM conversations WHERE principal_id = ? AND json_extract(record, '$.folderId') = ? ORDER BY updated_at DESC, rowid DESC",
      principalId, folderId,
    ).flatMap((row) => {
      const parsed = parse<ConversationRecord>(row);
      return parsed ? [parsed] : [];
    });
  }

  forkConversation(
    source: ConversationRecord,
    principalId: string,
    now: number,
    upToTurnId?: string,
    customTitle?: string,
  ): ConversationRecord {
    return this.db.tx(() => {
      const sourceTurns = this.conversationTurns(source.id).filter((t) => t.public.status === "completed");
      let cut = sourceTurns;
      if (upToTurnId) {
        const idx = sourceTurns.findIndex((t) => t.public.id === upToTurnId);
        if (idx === -1) throw new ApiError(404, "turn_not_found", "Turn not found in this conversation.");
        cut = sourceTurns.slice(0, idx + 1);
      }
      const title = (customTitle?.trim() || `Branch · ${source.title}`).slice(0, 80);
      const forked: ConversationRecord = {
        id: makeId("conv"),
        principalId,
        tenantId: source.tenantId,
        domainId: source.domainId,
        userId: source.userId,
        title,
        personaId: source.personaId,
        scenarioId: source.scenarioId,
        updatedAt: now,
        sessions: {},
        ...(source.audience && { audience: source.audience }),
        ...(source.folderId && { folderId: source.folderId }),
        forkedFrom: { conversationId: source.id, ...(upToTurnId ? { turnId: upToTurnId } : {}) },
      };
      this.db.run("INSERT INTO conversations VALUES (?, ?, ?, ?)", forked.id, principalId, now, JSON.stringify(forked));
      if (forked.audience !== "admin") {
        this.db.run(
          "INSERT OR IGNORE INTO user_threads VALUES (?, ?, ?, ?)",
          forked.id, forked.tenantId, forked.domainId, forked.userId,
        );
      }
      cut.forEach((orig, idx) => {
        const clonedTurnId = makeId("turn");
        const cloned: TurnRecord = {
          ...orig,
          ordinal: idx + 1,
          historyStatus: undefined,
          scope: { ...orig.scope, conversationId: forked.id, principalId },
          public: {
            ...orig.public,
            id: clonedTurnId,
            conversationId: forked.id,
          },
        };
        this.db.run(
          "INSERT INTO turns (id, conversation_id, request_id, ordinal, status, record) VALUES (?, ?, ?, ?, ?, ?)",
          clonedTurnId, forked.id, `fork:${orig.public.id}:${clonedTurnId}`, cloned.ordinal, cloned.public.status, JSON.stringify(cloned),
        );
      });
      return forked;
    });
  }

  deleteFolder(id: string, principalId: string): { deleted: boolean; unfiledIds: string[] } {
    return this.db.tx(() => {
      const existing = this.getFolder(id, principalId);
      if (!existing) inaccessible();
      const unfiledIds: string[] = [];
      const rows = this.db.all<{ record: string }>(
        "SELECT record FROM conversations WHERE principal_id = ? AND json_extract(record, '$.folderId') = ?",
        principalId, id,
      );
      for (const row of rows) {
        const conv = parse<ConversationRecord>(row);
        if (!conv) continue;
        delete conv.folderId;
        this.saveConversation(conv);
        unfiledIds.push(conv.id);
      }
      this.db.run("DELETE FROM conversation_folders WHERE id = ? AND principal_id = ? AND tenant_id = ?", id, principalId, serverTenantId);
      return { deleted: true, unfiledIds };
    });
  }

  hasOperatorContent(conversationId: string) {
    return Boolean(this.db.one(`SELECT 1 FROM turns WHERE conversation_id = ? AND ${operatorTurn} LIMIT 1`, conversationId));
  }

  conversations(principalId: string, includeOperatorThreads = true, viewer?: ThreadViewer) {
    const visibility = includeOperatorThreads ? "" : ` AND NOT EXISTS (
      SELECT 1 FROM turns WHERE conversation_id = conversations.id AND ${operatorTurn}
    )`;
    return this.db.all<{ record: string }>(`SELECT record FROM conversations WHERE ${accessibleThreads}${visibility} ORDER BY updated_at DESC, rowid DESC`, principalId, serverTenantId, viewer?.customer ?? "", viewer?.operator ?? "")
      .map((row) => presentConversation(parse<ConversationRecord>(row)!));
  }

  conversation(id: string, principalId: string, viewer?: ThreadViewer) {
    const record = parse<ConversationRecord>(this.db.one(`SELECT record FROM conversations WHERE id=? AND ${accessibleThreads}`,
      id, principalId, serverTenantId, viewer?.customer ?? "", viewer?.operator ?? ""));
    return record ?? inaccessible();
  }

  changeConversation(id: string, principalId: string, change: ConversationChange, now: number) {
    return this.db.tx(() => {
      const record = this.conversation(id, principalId);
      if (change.operation === "rename") {
        record.title = change.title;
        record.customTitle = true;
      } else if (change.operation === "archive") {
        if (this.workingTurnsInConversation(id).length > 0) {
          throw new ApiError(409, "turn_active", "Wait for the current response or stop it before archiving this chat.");
        }
        record.archivedAt ??= now;
      } else if (change.operation === "move") {
        if (change.folderId === null) {
          delete record.folderId;
        } else {
          const folder = this.getFolder(change.folderId, principalId);
          if (!folder || folder.domainId !== record.domainId) throw new ApiError(404, "folder_not_found", "Folder not found.");
          record.folderId = folder.id;
        }
      } else {
        delete record.archivedAt;
      }
      this.saveConversation(record);
      return presentConversation(record);
    });
  }

  workspacePins(principalId: string, personaId: string) {
    const row = this.db.one<{ pins: string }>("SELECT pins FROM workspace_preferences WHERE principal_id = ? AND persona_id = ?", principalId, personaId);
    return row ? workspacePinsSchema.parse(JSON.parse(row.pins)) : defaultWorkspacePins;
  }

  saveWorkspacePins(principalId: string, personaId: string, pins: WorkspacePin[]) {
    this.db.run("INSERT INTO workspace_preferences VALUES (?, ?, ?) ON CONFLICT(principal_id, persona_id) DO UPDATE SET pins = excluded.pins",
      principalId, personaId, JSON.stringify(pins));
    return pins;
  }

  workspaceTodos(personaId: string) {
    return this.db.all<{ record: string }>("SELECT record FROM workspace_todos WHERE persona_id = ? ORDER BY rowid DESC", personaId)
      .map((row) => parse<WorkspacePendingAction>(row)!);
  }

  saveWorkspaceTodo(personaId: string, action: WorkspacePendingAction) {
    this.db.run("INSERT OR IGNORE INTO workspace_todos (persona_id, content_id, record) VALUES (?, ?, ?)",
      personaId, action.contentId, JSON.stringify(action));
  }

  removeWorkspaceTodo(personaId: string, contentId: string) {
    this.db.run("DELETE FROM workspace_todos WHERE persona_id = ? AND content_id = ?", personaId, contentId);
  }

  workspaceFundingConversation(principalId: string, personaId: string, viewer: ThreadViewer, includeOperator: boolean) {
    const visibility = includeOperator ? "" : `AND NOT EXISTS (
      SELECT 1 FROM turns WHERE conversation_id = conversations.id AND ${operatorTurn}
    )`;
    return this.db.one<{ conversation_id: string }>(`
      SELECT t.conversation_id FROM turns t
      WHERE t.conversation_id IN (
        SELECT id FROM conversations WHERE ${accessibleThreads}
          AND json_extract(record, '$.domainId') = 'wealth'
          AND json_extract(record, '$.personaId') = ?
          AND json_extract(record, '$.audience') IS NULL
          AND json_extract(record, '$.archivedAt') IS NULL
          ${visibility}
      )
      AND t.request_id NOT LIKE 'fork:%'
      AND (
        (t.status = 'completed' AND EXISTS (
          SELECT 1 FROM json_each(t.record, '$.public.experience.blocks')
          WHERE json_extract(value, '$.component') IN ('PznFundingOptions', 'PznFundingPreview')
        ))
        OR (t.status = 'working' AND (
          json_extract(t.record, '$.origin') IN (?, ?)
          OR json_extract(t.record, '$.workflow.recommendation.id') = ?
        ))
      )
      AND NOT EXISTS (
        SELECT 1 FROM turns later WHERE later.conversation_id = t.conversation_id AND later.rowid > t.rowid
          AND json_extract(later.record, '$.fundingRun.outcome') = 'cancelled'
      )
      ORDER BY t.rowid DESC LIMIT 1`, principalId, serverTenantId, viewer.customer ?? "", viewer.operator ?? "", personaId,
    overviewFundingOrigin, pendingActionsFundingOrigin, fundingPreviewWorkflow.recommendation.id
    )?.conversation_id;
  }

  saveWorkspaceActionLog(principalId: string, log: WorkspaceActionLog) {
    this.db.tx(() => {
      this.db.run("INSERT INTO workspace_action_logs VALUES (?, ?, ?)", log.id, principalId, JSON.stringify(log));
      this.db.run(`
        DELETE FROM workspace_action_logs WHERE id IN (
          SELECT id FROM workspace_action_logs WHERE principal_id = ? ORDER BY rowid DESC LIMIT -1 OFFSET 50
        )
      `, principalId);
    });
  }

  workspaceActionLogs(principalId: string) {
    return this.db.all<{ record: string }>("SELECT record FROM workspace_action_logs WHERE principal_id = ? ORDER BY rowid DESC LIMIT 50", principalId)
      .map((row) => parse<WorkspaceActionLog>(row)!);
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

  ownTurn(id: string, principalId: string, viewer?: ThreadViewer) {
    const record = this.turn(id);
    if (!record) return inaccessible();
    if (record.scope.principalId !== principalId) this.conversation(record.scope.conversationId, principalId, viewer);
    return record;
  }

  conversationTurns(id: string) {
    return this.db.all<{ record: string }>("SELECT record FROM turns WHERE conversation_id = ? ORDER BY rowid", id)
      .map((row) => parse<TurnRecord>(row)!);
  }

  treatmentRuns(principalId: string, viewer: ThreadViewer, personaId: string, context: string, turnId?: string) {
    const rows = this.db.all<Omit<TreatmentRun, "clicks"> & { experienceId: string }>(`
      SELECT id AS turnId, conversation_id AS threadId, json_extract(record, '$.public.createdAt') AS createdAt,
        json_extract(record, '$.public.message') AS message, json_extract(record, '$.public.experience.experienceId') AS experienceId
      FROM turns WHERE conversation_id IN (
        SELECT id FROM conversations WHERE ${accessibleThreads} AND json_extract(record, '$.domainId') = 'wealth'
          AND json_extract(record, '$.personaId') = ?
      ) AND status = 'completed' AND json_extract(record, '$.decision.contextId') = ?
        AND json_type(record, '$.public.experience.experienceId') = 'text' ${turnId ? "AND id = ?" : ""}
      ORDER BY rowid DESC LIMIT 25
    `, principalId, serverTenantId, viewer.customer ?? "", viewer.operator ?? "", personaId, context, ...(turnId ? [turnId] : []));
    return rows.map(({ experienceId, ...source }) => ({ ...source, clicks: this.offerClicks(source.threadId, experienceId) }));
  }

  private offerClicks(threadId: string, experienceId: string) {
    return this.db.all<OfferClick>(`
      SELECT id AS turnId, json_extract(record, '$.public.message') AS label,
        CASE WHEN json_type(record, '$.workflow.recommendation') = 'object' THEN 'workflow' ELSE 'action' END AS kind,
        COALESCE(json_extract(record, '$.workflow.recommendation.id'), json_extract(record, '$.agentLaunch.capability.id')) AS id,
        COALESCE(json_extract(record, '$.workflow.recommendation.version'), json_extract(record, '$.agentLaunch.capability.version')) AS version
      FROM turns
      WHERE conversation_id = ? AND (
        json_extract(record, '$.workflow.sourceExperienceId') = ? AND json_type(record, '$.fundingRun.answerTo') IS NULL
        OR json_extract(record, '$.agentLaunch.sourceExperienceId') = ? AND json_type(record, '$.agentLaunch.capability') = 'object'
      ) ORDER BY ordinal
    `, threadId, experienceId, experienceId);
  }

  workflowClicks(source: TurnRecord) {
    return this.offerClicks(source.scope.conversationId, source.public.experience!.experienceId)
      .map(({ turnId, label }) => ({ id: turnId, label }));
  }

  previousCompletedTurn(conversationId: string, ordinal: number) {
    return parse<TurnRecord>(this.db.one(`
      SELECT record FROM turns WHERE conversation_id = ? AND status = 'completed' AND ordinal < ?
      ORDER BY ordinal DESC LIMIT 1
    `, conversationId, ordinal));
  }

  recentCompletedTurns(principalId: string) {
    return this.db.all<{ record: string }>(`
      SELECT turns.record FROM turns JOIN conversations ON conversations.id=turns.conversation_id
      WHERE conversations.principal_id=? AND turns.status IN ('completed', 'failed')
      ORDER BY turns.rowid DESC LIMIT 40
    `, principalId).map((row) => parse<TurnRecord>(row)!);
  }

  workingTurns() {
    return this.db.all<{ record: string }>("SELECT record FROM turns WHERE status = 'working' ORDER BY rowid")
      .map((row) => parse<TurnRecord>(row)!);
  }

  workingTurnsInConversation(conversationId: string) {
    return this.db.all<{ record: string }>("SELECT record FROM turns WHERE conversation_id = ? AND status = 'working' ORDER BY rowid", conversationId)
      .map((row) => parse<TurnRecord>(row)!);
  }

  latestTurn(id: string) {
    return parse<TurnRecord>(this.db.one("SELECT record FROM turns WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1", id));
  }

  private saveTurn(record: TurnRecord) {
    this.db.run("UPDATE turns SET record = ?, status = ? WHERE id = ?", JSON.stringify(record), record.public.status, record.public.id);
  }

  markHistoryStatus(id: string, status: TurnStatus) {
    this.db.tx(() => {
      const turn = this.turn(id);
      if (turn?.public.status !== status || turn.historyStatus === status) return;
      turn.historyStatus = status;
      this.saveTurn(turn);
    });
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
    retry?: TurnRecord; workflow?: WorkflowLaunch; agentLaunch?: AgentLaunch; operatorName?: string; requestSessionId?: string;
    tenantOperator?: boolean;
  }) {
    let created = false;
    const turn = this.db.tx(() => {
      const { requestId, origin, message, selectionMode, now, retry } = input;
      const conversation = this.conversation(input.conversation.id, input.conversation.principalId);
      const previous = this.existingRequest(conversation.id, requestId, message, origin);
      if (previous) return previous;
      if (conversation.archivedAt !== undefined) throw new ApiError(409, "chat_archived", "Restore this chat to continue it.");
      const latest = this.latestTurn(conversation.id);
      const activeWorking = this.workingTurnsInConversation(conversation.id);
      if (origin !== "message" && activeWorking.length > 0) {
        throw new ApiError(409, "turn_active", "Wait for the current response or stop it first.");
      }
      if (origin === "message" && activeWorking.length >= 4) {
        throw new ApiError(409, "turn_active", "Too many concurrent requests are already running in this thread. Wait for one to finish or stop it first.");
      }
      if (retry && (latest?.public.id !== retry.public.id || !["cancelled", "failed"].includes(retry.public.status))) {
        throw new ApiError(409, "retry_stale", "Start a fresh request to ask this question again.");
      }

      const id = makeId("turn");
      const setup = conversation.preview?.tools ?? this.toolSetup(conversation.domainId);
      const publications = this.publishedUiLayouts(conversation.domainId);
      const draft = conversation.preview?.layout;
      const uiLayouts = draft ? [draft, ...publications] : publications;
      const workflowDefinition = setup.fundingWorkflow ?? defaultAgentFundingWorkflow;
      const fundingInput = typeof explicitInputs(message).methodId === "string"
        && !/\b(?:compare|balance|portfolio|retire|address|goal|savings)\b/i.test(message);
      const paused = origin === "message" && latest?.workflow && (fundingInput || cancelsJourney(message))
        ? latest.fundingRun : undefined;
      const continuation = paused?.through && paused.waiting && paused.waiting.expiresAt > now ? {
        id: paused.id, rootTurnId: paused.rootTurnId, after: paused.through, answerTo: paused.waiting.requestId,
      } : undefined;
      const offer = !continuation && origin === "message" && workflowDefinition.mode === "agent" && asksAboutFunding(message)
        && latest?.public.experience && latest.public.experience.expiresAt > now
        ? this.experience(latest.public.experience.experienceId, conversation.principalId).actions.find(({ workflow }) => workflow?.id === fundingPreviewWorkflow.recommendation.id)
        : undefined;
      const overviewFunding = workspaceFundingContext(origin);
      const launch = overviewFunding ? undefined
        : retry?.workflow ?? input.workflow ?? (continuation ? latest?.workflow : undefined)
          ?? (offer?.workflow && latest?.public.experience ? { recommendation: offer.workflow, sourceExperienceId: offer.offerSourceId ?? latest.public.experience.experienceId } : undefined);
      const record: TurnRecord = {
        public: { id, conversationId: conversation.id, message, createdAt: now, status: "working", progress: "accepted", retryOf: retry?.public.id },
        scope: { turnId: id, tenantId: serverTenantId, domainId: conversation.domainId, userId: conversation.userId, principalId: conversation.principalId, conversationId: conversation.id, personaId: conversation.personaId },
        ordinal: retry?.ordinal ?? (latest?.ordinal ?? 0) + 1,
        requestId, origin, selectionMode, attempts: {},
        workflow: launch,
        operatorName: input.operatorName, requestSessionId: input.requestSessionId,
        flowCatalog: this.routingFlows(conversation, Boolean(input.tenantOperator)),
        agentLaunch: input.agentLaunch ?? retry?.agentLaunch,
        fundingRun: continuation,
        ...(uiLayouts.length && { uiLayouts }),
        toolSetup: continuation ? latest?.toolSetup : setup.fundingWorkflow ? setup : { ...setup, fundingWorkflow: workflowDefinition },
        trace: { surface: "chat", sourcePageContext: overviewFunding ? "Overview" : null, selectionMode, markers: { accepted: now }, failures: [] },
      };
      this.db.run("INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?)", id, conversation.id, requestId, record.ordinal, "working", JSON.stringify(record));
      if (!latest && !conversation.customTitle) conversation.title = [...message.replace(/\s+/g, " ")].slice(0, 54).join("");
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

  recordHarnessStage(
    id: string,
    stage: NonNullable<TurnView["harnessStages"]>[number],
    progress?: Progress,
    now?: number,
  ) {
    const record = this.db.tx(() => {
      const result = this.update(id, (turn) => {
        const list = turn.public.harnessStages ? [...turn.public.harnessStages] : [];
        list.push(stage);
        turn.public.harnessStages = list.slice(-8);
        if (progress) {
          turn.public.progress = progress;
          if (now !== undefined) turn.trace.markers[progress] ??= now;
        }
      });
      if (result) this.addEvent(result, "turn.status", { progress: result.public.progress, harnessStage: stage });
      return result;
    });
    if (record) this.events.emit(id);
  }

  publishPortfolio(id: string, snapshot: PortfolioSnapshot, now: number) {
    const published = this.db.tx(() => {
      const turn = this.turn(id);
      if (turn?.public.status !== "working" || !turn.route || turn.public.previewExperience) return false;
      const preview = compileExperience({ status: "ready", outcome: "ready", introKey: "summary", question: null,
        partial: false, portfolio: snapshot, expiresAt: turn.route.expiresAt });
      turn.portfolioSnapshot = snapshot;
      turn.public.previewExperience = this.personalize(turn, preview).display;
      turn.trace.markers.portfolioResolved = now;
      turn.trace.markers.portfolioPublished = now;
      this.saveTurn(turn);
      this.addEvent(turn, "experience.preview", { experience: turn.public.previewExperience });
      return true;
    });
    if (published) this.events.emit(id);
  }

  recordPortfolioDisplay(id: string, now: number) {
    this.db.tx(() => {
      const turn = this.turn(id);
      if (!turn || turn.trace.markers.portfolioPublished === undefined || turn.trace.markers.portfolioDisplayed !== undefined) return;
      turn.trace.markers.portfolioDisplayed = now;
      this.saveTurn(turn);
    });
  }

  private personalize(turn: TurnRecord, result: CompiledExperience) {
    const profile = turn.scope.domainId === "wealth" && findProfileById(turn.scope.personaId);
    return profile ? applyPersonalization(result, { firstName: firstNameOf(profile.displayName),
      userMessage: turn.public.message, ordinal: turn.ordinal, emotionalState: turn.public.emotionalState }) : result;
  }

  private applyUiLayout(turn: TurnRecord, result: CompiledExperience) {
    if (!turn.uiLayouts?.length) return result;
    const targets: UiTarget[] = [];
    const capability = turn.public.semanticRoute?.capabilityId;
    if (turn.trace.intentId) targets.push({ kind: "intent", id: turn.trace.intentId });
    if (turn.recordId && turn.operatorName && (capability === "ops_incident" || capability === "sales_deal_desk")) targets.push({ kind: "capability", id: capability });
    if (turn.workflow) targets.push({ kind: "capability", id: turn.workflow.recommendation.id });
    const journey = turn.agentJourneyId && this.axe.get("journeys", turn.scope, turn.agentJourneyId);
    if (journey && journey.turnId === turn.public.id) {
      for (const step of journey.results) {
        if (step.status === "completed" || step.status === "waiting_input") {
          targets.push({ kind: "capability", id: step.capability.split("@")[0] });
        }
      }
    }
    try {
      const extra = turn.recordId && turn.operatorName ? this.domainBindingContext?.(turn.recordId) : undefined;
      const domain = turn.scope.domainId ?? "wealth";
      const bindings = resolveMultiDomainBindings(domain === "wealth" ? turn.scope.personaId : undefined, {
        portfolio: turn.portfolioSnapshot ?? result.display.blocks.find((b) => b.component === "PznPortfolioSnapshot")?.props ?? turn.portfolioForRule,
        goal: turn.goalProgress ?? result.display.blocks.find((b) => b.component === "PznGoalProgress")?.props.goal,
        balances: turn.proof?.values ?? result.display.blocks.find((b) => b.component === "PznMetricSummary")?.props.values,
        effectiveFundingStatus: domain === "wealth" ? this.axe.fundingStatus(turn.scope) : undefined,
        incident: domain === "it_ops" ? extra?.incident : undefined,
        deal: domain === "sales_revops" ? extra?.deal : undefined,
      });
      const applied = applyPublishedUi(result, turn.uiLayouts, targets, bindings);
      if (applied) {
        turn.trace.uiLayout = applied.attachment;
        turn.trace.components = applied.result.display.blocks.map(({ component }) => component);
        return applied.result;
      }
    } catch {
      turn.trace.failures.push({ stage: "ui_layout", code: "UI_LAYOUT_RENDER_FALLBACK" });
    }
    return result;
  }

  private carryForwardOffers(turn: TurnRecord, result: CompiledExperience, now: number) {
    const sourceId = turn.workflow?.sourceExperienceId ?? (turn.agentLaunch && "capability" in turn.agentLaunch ? turn.agentLaunch.sourceExperienceId : undefined);
    if (!sourceId || result.display.status !== "ready" || !result.display.blocks.length || turn.fundingRun?.waiting) return result;
    const { turn: source, actions } = this.experience(sourceId, turn.scope.principalId);
    const display = source.public.experience;
    if (!display || display.expiresAt <= now || source.scope.conversationId !== turn.scope.conversationId
      || source.scope.personaId !== turn.scope.personaId || !source.decision?.actionRecommendations?.length) return result;
    const used = new Set(this.workflowClicks(source).flatMap(({ id }) => {
      const clicked = this.turn(id);
      const ref = clicked?.workflow?.recommendation ?? (clicked?.agentLaunch && "capability" in clicked.agentLaunch ? clicked.agentLaunch.capability : undefined);
      return ref ? [ref.id + "@" + ref.version] : [];
    }));
    const issued = [...result.issued];
    const blocks = [...result.display.blocks];
    for (const action of actions) {
      const ref = action.standaloneAction ?? action.workflow;
      if (!ref || used.has(ref.id + "@" + ref.version)) continue;
      const actionId = makeId("action");
      if (action.standaloneAction) {
        const form = display.blocks.find((block) => block.component === "PznCapabilityForm" && block.props.actionId === action.actionId);
        if (form?.component !== "PznCapabilityForm") continue;
        blocks.push({ component: form.component, props: { ...form.props, actionId } });
        issued.push({ ...action, actionId, componentId: "block_" + blocks.length, offerSourceId: sourceId });
      } else if (result.display.actions.length + issued.length - result.issued.length < 3) {
        issued.push({ ...action, actionId, componentId: "offer_" + actionId, offerSourceId: sourceId });
      }
    }
    if (issued.length === result.issued.length) return result;
    return buildSurface({ ...result.display, expiresAt: Math.min(result.display.expiresAt, display.expiresAt) }, blocks, issued, result.display);
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
        const laidOut = this.applyUiLayout(turn, this.carryForwardOffers(turn, outcome.result, now));
        const { display, issued } = this.personalize(turn, laidOut);
        delete turn.public.previewExperience;
        if (turn.agentLaunch && "capability" in turn.agentLaunch) delete turn.agentLaunch.values;
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

  experience(experienceId: string, principalId: string, viewer?: ThreadViewer) {
    const row = this.db.one<{ turn_id: string; actions: string }>("SELECT turn_id, actions FROM experiences WHERE id = ?", experienceId);
    if (!row) return inaccessible();
    return { turn: this.ownTurn(row.turn_id, principalId, viewer), actions: JSON.parse(row.actions) as IssuedAction[] };
  }

  analytics(principalId: string, experienceId: string, eventId: string, type: "rendered" | "render_fallback" | "helpful" | "unhelpful", now: number) {
    this.db.tx(() => {
      const { turn } = this.experience(experienceId, principalId);
      if (!this.db.run("INSERT OR IGNORE INTO analytics VALUES (?, ?, ?, ?)", eventId, experienceId, type, now).changes) return;
      if (type === "rendered" || type === "render_fallback") {
        turn.trace.markers.displayed ??= now;
        if (type === "render_fallback") turn.trace.markers.renderFallback = now;
        if (turn.agentRunId) this.axe.trace(turn.scope, {
          type: "experience.rendered", at: now, runId: turn.agentRunId, turnId: turn.public.id, journeyId: turn.agentJourneyId,
          detail: { experienceId, renderer: type === "rendered" ? "a2ui" : "fallback" },
        });
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

  listAllCompletedTurns(limit = 200): TurnRecord[] {
    const rows = this.db.all<{ record: string }>(
      "SELECT record FROM turns WHERE status = 'completed' ORDER BY rowid DESC LIMIT ?",
      limit,
    );
    return rows.flatMap((row) => {
      try {
        return [JSON.parse(row.record) as TurnRecord];
      } catch {
        return [];
      }
    });
  }

  engagementSummary() {
    const turnRows = this.db.all<{ record: string }>("SELECT record FROM turns");
    let turnsTotal = 0;
    let turnsCompleted = 0;
    let verifiedExperience = 0;
    let dynamicUi = 0;
    let plainChat = 0;
    let clarify = 0;
    for (const row of turnRows) {
      try {
        const parsed = JSON.parse(row.record) as TurnRecord;
        turnsTotal += 1;
        if (parsed.public.status === "completed") turnsCompleted += 1;
        if (parsed.public.actionMode === "verified_experience") verifiedExperience += 1;
        else if (parsed.public.actionMode === "dynamic_ui") dynamicUi += 1;
        else if (parsed.public.actionMode === "plain_chat") plainChat += 1;
        else if (parsed.public.actionMode === "clarify") clarify += 1;
      } catch { /* ignore malformed row */ }
    }
    const eventRows = this.db.all<{ event_type: string; cnt: number }>(
      "SELECT event_type, COUNT(*) AS cnt FROM analytics GROUP BY event_type",
    );
    const counts = Object.fromEntries(eventRows.map((r) => [r.event_type, Number(r.cnt)]));
    return {
      turnsTotal,
      turnsCompleted,
      modeBreakdown: { verifiedExperience, dynamicUi, plainChat, clarify },
      surfacesRendered: (counts.rendered ?? 0) + (counts.render_fallback ?? 0),
      feedbackHelpful: counts.helpful ?? 0,
      feedbackUnhelpful: counts.unhelpful ?? 0,
    };
  }

  close() {
    this.events.removeAllListeners();
    this.db.close();
  }
}
