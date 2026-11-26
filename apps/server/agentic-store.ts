import type { SqliteDatabase } from "@sfield/store-sqlite";
import { randomUUID } from "node:crypto";
import { findProfileById } from "../../packages/customer-profiles";
import type { FirstDepositConfirmation } from "../../packages/contracts/workspace";
import type { DecisionEvent, Evidence, ExecutionPlan, ExperienceIR, EligibilityGrant, Journey, CapabilityManifest, InputValues } from "../../packages/contracts/agentic";

type Owner = { principalId: string; personaId: string };
type FundingEvent = { eventId: string; type: "account.first_deposit.completed"; customerRef: string; occurredAt: number; source: "mock-account-service" };
type Records = {
  capability_definitions: CapabilityManifest;
  customer_goals: { goalId: string; objective: string; parameters: InputValues; savedAt: number };
  customer_preferences: { allowPromotionalContent: boolean; observedAt: number };
  customer_facts: { kind: "event"; status: "funded"; evidence: FundingEvent }
    | { kind: "observation"; evidenceId: string; source: string; observedAt: number; expiresAt: number };
  journeys: Journey;
  journey_steps: Journey["results"][number] & { journeyId: string; revision: number };
  execution_plans: ExecutionPlan;
  eligibility_grants: EligibilityGrant;
  evidence_records: Evidence;
  experience_revisions: ExperienceIR;
  customer_events: FundingEvent;
  decision_trace_events: DecisionEvent;
};
const tables: (keyof Records)[] = [
  "capability_definitions", "customer_goals", "customer_preferences", "customer_facts", "journeys", "journey_steps",
  "execution_plans", "eligibility_grants", "evidence_records", "experience_revisions", "customer_events", "decision_trace_events",
];
const formatVersion = 1;

export class AgenticStore {
  constructor(private readonly db: SqliteDatabase) {
    db.exec(`CREATE TABLE IF NOT EXISTS account_first_deposits (
      mid TEXT PRIMARY KEY, event_id TEXT UNIQUE NOT NULL, occurred_at INTEGER NOT NULL
    )`);
    for (const table of tables) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
        principal_id TEXT NOT NULL, persona_id TEXT NOT NULL, id TEXT NOT NULL, correlation TEXT NOT NULL,
        version INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY (principal_id, persona_id, id)
      );
      CREATE INDEX IF NOT EXISTS ${table}_scope ON ${table}(principal_id, persona_id, correlation);`);
    }
  }

  get<K extends keyof Records>(table: K, owner: Owner, id: string): Records[K] | undefined {
    const row = this.db.one<{ record: string }>(
      `SELECT record FROM ${table} WHERE principal_id = ? AND persona_id = ? AND id = ? AND version = ?`,
      owner.principalId, owner.personaId, id, formatVersion,
    );
    return row && JSON.parse(row.record) as Records[K];
  }

  list<K extends keyof Records>(table: K, owner: Owner, correlation?: string, limit = 100): Records[K][] {
    const prefix = `SELECT record FROM ${table} WHERE principal_id = ? AND persona_id = ? AND version = ?`;
    const order = " ORDER BY rowid DESC LIMIT ?";
    const scope = [owner.principalId, owner.personaId, formatVersion] as const;
    const rows = correlation === undefined
      ? this.db.all<{ record: string }>(prefix + order, ...scope, limit)
      : this.db.all<{ record: string }>(prefix + " AND correlation = ?" + order, ...scope, correlation, limit);
    return rows.reverse().map(({ record }) => JSON.parse(record) as Records[K]);
  }

  insert<K extends keyof Records>(table: K, owner: Owner, id: string, correlation: string, record: Records[K]) {
    return Boolean(this.db.run(`INSERT OR IGNORE INTO ${table} VALUES (?, ?, ?, ?, ?, ?)`,
      owner.principalId, owner.personaId, id, correlation, formatVersion, JSON.stringify(record),
    ).changes);
  }

  private upsert<K extends keyof Records>(table: K, owner: Owner, id: string, correlation: string, record: Records[K]) {
    this.db.run(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(principal_id, persona_id, id) DO UPDATE SET correlation=excluded.correlation, version=excluded.version, record=excluded.record`,
      owner.principalId, owner.personaId, id, correlation, formatVersion, JSON.stringify(record),
    );
  }

  saveJourney(owner: Owner, journey: Journey) {
    this.db.tx(() => {
      this.upsert("journeys", owner, journey.id, journey.threadId, journey);
      for (const step of journey.results) {
        this.upsert("journey_steps", owner, journey.id + ":" + journey.revision + ":" + step.stepId, journey.id,
          { ...step, journeyId: journey.id, revision: journey.revision });
      }
    });
  }

  saveGoal(owner: Owner, journey: Journey, parameters: InputValues, savedAt: number) {
    this.upsert("customer_goals", owner, journey.goalId, journey.id, { goalId: journey.goalId, objective: journey.objective, parameters, savedAt });
  }

  activeJourneys(owner: Owner, threadId?: string) {
    return this.list("journeys", owner, threadId).filter(({ status }) => ["planning", "executing", "waiting_input", "paused", "partially_completed"].includes(status))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  trace(owner: Owner, input: Omit<DecisionEvent, "sequence">) {
    this.db.tx(() => {
      const last = this.list("decision_trace_events", owner, input.turnId, 1)[0]?.sequence ?? 0;
      const sequence = last + 1;
      this.insert("decision_trace_events", owner, input.turnId + ":" + sequence, input.turnId, { ...input, sequence });
    });
  }

  portalConfirmation(mid: string): FirstDepositConfirmation | undefined {
    const row = this.db.one<{ event_id: string; occurred_at: number }>(
      "SELECT event_id, occurred_at FROM account_first_deposits WHERE mid = ?", mid);
    if (row) return { eventId: row.event_id, type: "account.first_deposit.completed",
      source: "mock-account-portal", mid, occurredAt: row.occurred_at };
  }

  confirmPortalDeposit(personaId: string, mid: string, now: number) {
    return this.db.tx(() => {
      const existing = this.portalConfirmation(mid);
      if (existing) return existing;
      const eventId = "deposit_" + randomUUID();
      this.db.run("INSERT INTO account_first_deposits (mid, event_id, occurred_at) VALUES (?, ?, ?)", mid, eventId, now);
      const sessions = this.db.all<{ principal_id: string }>("SELECT DISTINCT principal_id FROM journeys WHERE persona_id = ?", personaId);
      for (const { principal_id } of sessions) this.confirmFundingJourneys({ principalId: principal_id, personaId }, eventId, now);
      return this.portalConfirmation(mid)!;
    });
  }

  fundingFact(owner: Owner) {
    const mid = findProfileById(owner.personaId)?.syntheticMid;
    const confirmation = mid ? this.portalConfirmation(mid) : undefined;
    if (confirmation) return confirmation;
    const record = this.get("customer_facts", owner, "funding_status");
    return record?.kind === "event" ? record.status : undefined;
  }

  fundingStatus(owner: Owner) {
    return this.fundingFact(owner) ? "funded" as const : undefined;
  }

  setObservedFact(owner: Owner, evidence: Evidence) {
    this.upsert("customer_facts", owner, evidence.outputKind, evidence.journeyId, {
      kind: "observation", evidenceId: evidence.evidenceId, source: evidence.source,
      observedAt: evidence.observedAt, expiresAt: evidence.expiresAt,
    });
  }

  observedFact(owner: Owner, key: string) {
    const result = this.get("customer_facts", owner, key);
    return result?.kind === "observation" ? result : undefined;
  }

  setPromotionPreference(owner: Owner, allowPromotionalContent: boolean, observedAt: number) {
    this.upsert("customer_preferences", owner, "promotions", "declared", { allowPromotionalContent, observedAt });
  }

  applyFundingEvent(owner: Owner, event: FundingEvent) {
    return this.db.tx(() => {
      const existing = this.get("customer_events", owner, event.eventId);
      if (existing || this.fundingStatus(owner)) return false;
      if (!this.insert("customer_events", owner, event.eventId, event.type, event)) return false;
      this.upsert("customer_facts", owner, "funding_status", event.eventId, { kind: "event", status: "funded", evidence: event });
      this.confirmFundingJourneys(owner, event.eventId, event.occurredAt);
      return true;
    });
  }

  private confirmFundingJourneys(owner: Owner, eventId: string, occurredAt: number) {
    for (const journey of this.activeJourneys(owner)) {
      const affected = journey.plan.steps.filter(({ capabilityId }) => capabilityId === "account.funding.preview");
      if (!affected.length || journey.confirmations?.some((item) => item.objective === "first_deposit")) continue;
      const results = journey.results.map((step) => affected.some(({ id }) => id === step.stepId)
        ? { ...step, status: "blocked" as const, reason: "FIRST_DEPOSIT_CONFIRMED", missing: undefined } : step);
      this.saveJourney(owner, {
        ...journey, results, pending: undefined, status: "partially_completed", updatedAt: occurredAt,
        confirmations: [...journey.confirmations ?? [], { objective: "first_deposit", eventId, confirmedAt: occurredAt }],
      });
      this.trace(owner, {
        type: "journey.event_applied", at: occurredAt, runId: journey.runId, turnId: journey.turnId,
        journeyId: journey.id, detail: { eventId, type: "account.first_deposit.completed", fundingObjectiveConfirmed: true },
      });
    }
  }
}
