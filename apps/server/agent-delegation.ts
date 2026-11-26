/**
 * Consumer A2A — "My Personal AI <-> Enterprise AI" Delegated Negotiation Engine (#6):
 * Lets a customer mint a scoped, time-bound Delegation Pass for their personal AI (Claude, Copilot, Apple Intelligence),
 * then executes a live multi-turn A2A + MCP negotiation against CEP's real Agent Card, Hybrid RAG KB, Customer 360,
 * and sfield HITL approval boundary.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  agentDelegationPassSchema,
  negotiationSessionSchema,
  type AgentDelegationPass,
  type AgentDelegationView,
  type CreateDelegationPassInput,
  type NegotiationMessage,
  type NegotiationSession,
  type RunNegotiationInput,
} from "../../packages/contracts/nextgen-chat";
import type { CustomerProfileStore } from "../../packages/customer-profiles";
import type { ApprovalStore } from "./approval-store";
import { buildA2aAgentCard, handleCepMcpRequest } from "./cep-mcp-server";
import type { IntegrationTaskService } from "./integration-tasks";
import type { KnowledgeBaseStore } from "./knowledge-base";
import type { WriteAuditStore } from "./write-audit";

type Persisted = { passes: AgentDelegationPass[]; negotiations: NegotiationSession[] };

export class AgentDelegationStore {
  private readonly filePath: string;
  private state: Persisted;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "agent-delegation.json");
    this.state = this.load();
  }

  private load(): Persisted {
    if (!existsSync(this.filePath)) return { passes: [], negotiations: [] };
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<Persisted>;
      return {
        passes: (raw.passes ?? []).flatMap((p) => { const r = agentDelegationPassSchema.safeParse(p); return r.success ? [r.data] : []; }),
        negotiations: (raw.negotiations ?? []).flatMap((n) => { const r = negotiationSessionSchema.safeParse(n); return r.success ? [r.data] : []; }),
      };
    } catch {
      return { passes: [], negotiations: [] };
    }
  }

  private save() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.state.passes = this.state.passes.slice(0, 30);
    this.state.negotiations = this.state.negotiations.slice(0, 30);
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  view(personaId?: string): AgentDelegationView {
    return {
      passes: this.state.passes.filter((p) => !personaId || p.personaId === personaId),
      negotiations: this.state.negotiations.filter((n) => !personaId || n.personaId === personaId),
    };
  }

  mintPass(input: CreateDelegationPassInput): AgentDelegationPass {
    const now = Date.now();
    const hours = input.expiresInHours ?? 24;
    const pass = agentDelegationPassSchema.parse({
      passId: `dlg_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      token: `cep_dlg_${randomBytes(12).toString("hex")}`,
      personaId: input.personaId ?? "demo-learner",
      agentName: input.agentName ?? "Personal Claude / Copilot",
      allowedScopes: input.allowedScopes ?? ["read_balances", "search_policies", "stage_drafts", "request_actions"],
      maxTransactionUsd: input.maxTransactionUsd ?? 5_000,
      status: "active",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + hours * 3600_000).toISOString(),
    });
    this.state.passes = [pass, ...this.state.passes];
    this.save();
    return pass;
  }

  revokePass(passId: string): AgentDelegationPass | undefined {
    const found = this.state.passes.find((p) => p.passId === passId);
    if (!found) return undefined;
    const updated: AgentDelegationPass = { ...found, status: "revoked" };
    this.state.passes = this.state.passes.map((p) => (p.passId === passId ? updated : p));
    this.save();
    return updated;
  }

  /** Runs a live Personal AI <-> CEP Agent A2A/MCP negotiation governed by the customer's Delegation Pass and sfield HITL. */
  async runNegotiation(
    input: RunNegotiationInput,
    deps: {
      origin: string;
      principalId: string;
      profileStore: CustomerProfileStore;
      integrationService: IntegrationTaskService;
      knowledgeBase: KnowledgeBaseStore;
      approvalStore: ApprovalStore;
      writeAudit: WriteAuditStore;
    },
  ): Promise<NegotiationSession> {
    const pass = this.state.passes.find((p) => p.passId === input.passId);
    const nowIso = () => new Date().toISOString();
    const transcript: NegotiationMessage[] = [];
    const pushMsg = (
      speaker: NegotiationMessage["speaker"],
      protocol: NegotiationMessage["protocol"],
      text: string,
      payloadSummary?: string,
    ) => {
      transcript.push({
        id: `nm_${randomUUID().slice(0, 8)}`,
        speaker,
        protocol,
        text,
        ...(payloadSummary ? { payloadSummary } : {}),
        timestamp: nowIso(),
      });
    };

    const amount = input.requestedAmountUsd ?? 0;
    if (!pass || pass.status !== "active" || Date.parse(pass.expiresAt) <= Date.now()) {
      pushMsg("sfield_guard", "sfield-HITL", "Delegation Pass is missing, revoked, or expired. A2A session denied before any data left CEP.");
      const denied = negotiationSessionSchema.parse({
        sessionId: `neg_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
        passId: input.passId,
        personaId: pass?.personaId ?? "unknown",
        agentName: pass?.agentName ?? "External Personal AI",
        goal: input.goal,
        requestedAmountUsd: amount,
        status: "denied",
        transcript,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      this.state.negotiations = [denied, ...this.state.negotiations];
      this.save();
      return denied;
    }

    // Step 1: A2A Agent Card Discovery
    const card = buildA2aAgentCard(deps.origin, deps.integrationService);
    pushMsg(
      "personal_ai",
      "A2A",
      `Discovered ${card.name} via /.well-known/agent.json (${card.skills.length} governed skills). Presenting Delegation Pass ${pass.passId} for goal: "${input.goal}".`,
      `scopes=[${pass.allowedScopes.join(", ")}] · cap=$${pass.maxTransactionUsd.toLocaleString("en-US")}`,
    );

    // Step 2: Scoped Customer 360 Balance Inspection
    const profile = deps.profileStore.findByPersonaId(pass.personaId);
    if (pass.allowedScopes.includes("read_balances") && profile) {
      const cashUsd = Math.round((profile.cashCents ?? 0) / 100);
      const equityUsd = Math.round((profile.equityCents ?? 0) / 100);
      pushMsg(
        "cep_agent",
        "A2A",
        `Verified Delegation Pass for ${profile.displayName}. Shared scoped snapshot: Cash $${cashUsd.toLocaleString("en-US")}, Equities $${equityUsd.toLocaleString("en-US")}.`,
        `persona=${profile.personaId} · funding=${profile.accountFundingStatus}`,
      );
    } else {
      pushMsg("sfield_guard", "sfield-HITL", "Balance read withheld because Delegation Pass omits the read_balances scope.");
    }

    // Step 3: Live MCP Hybrid RAG Policy Verification via handleCepMcpRequest
    if (pass.allowedScopes.includes("search_policies")) {
      const mcpRes = await handleCepMcpRequest(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cep.knowledge.search@1.0.0", arguments: { query: input.goal, limit: 2 } } },
        {
          integrationService: deps.integrationService,
          knowledgeBase: deps.knowledgeBase,
          principalId: deps.principalId,
          operatorName: `a2a:${pass.agentName}`,
        },
      );
      const citations = ((mcpRes.body as { result?: { structuredContent?: { citations?: Array<{ docTitle: string; score: number }> } } })?.result?.structuredContent?.citations) ?? [];
      pushMsg(
        "cep_agent",
        "MCP",
        citations.length > 0
          ? `Checked enterprise compliance via POST /api/mcp (cep.knowledge.search@1.0.0): matched ${citations.map((c) => `"${c.docTitle}"`).join(", ")}.`
          : "Checked enterprise compliance via POST /api/mcp (cep.knowledge.search@1.0.0): no policy conflicts found.",
        `retrievalMode=hybrid_bm25_vector · hits=${citations.length}`,
      );
    }

    // Step 4: Risk Boundary Enforcement via sfield HITL Approval Gate
    const exceedsCap = amount > pass.maxTransactionUsd;
    const needsAction = amount > 0 || pass.allowedScopes.includes("request_actions");

    if (exceedsCap || (needsAction && !pass.allowedScopes.includes("request_actions"))) {
      const approval = deps.approvalStore.createPending({
        targetKind: "domain_write",
        sfieldToolRef: "cep.a2a.delegated_action@1.0.0",
        domain: "customer360",
        recordId: pass.personaId,
        action: "a2a_negotiated_commit",
        title: `Personal AI Negotiation · ${pass.agentName} ($${amount.toLocaleString("en-US")})`,
        summary: `${pass.agentName} negotiated: "${input.goal}". Requested $${amount.toLocaleString("en-US")} exceeds autonomous delegation cap ($${pass.maxTransactionUsd.toLocaleString("en-US")}). Customer tap required.`,
        riskLevel: "high",
        payload: { passId: pass.passId, goal: input.goal, requestedAmountUsd: amount },
        details: [
          { label: "External Agent", value: pass.agentName },
          { label: "Delegation Pass", value: pass.passId },
          { label: "Requested Amount", value: `$${amount.toLocaleString("en-US")}` },
          { label: "Delegation Cap", value: `$${pass.maxTransactionUsd.toLocaleString("en-US")}` },
        ],
        requester: `a2a:${pass.agentName}`,
        dualControl: false,
      });
      pushMsg(
        "sfield_guard",
        "sfield-HITL",
        `Paused at risk boundary: $${amount.toLocaleString("en-US")} exceeds your Delegation Pass cap ($${pass.maxTransactionUsd.toLocaleString("en-US")}). Staged digest-bound approval ${approval.id} for your 1-tap confirmation.`,
        `approvalId=${approval.id} · sha256=${approval.payloadDigest.slice(0, 14)}`,
      );
      const paused = negotiationSessionSchema.parse({
        sessionId: `neg_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
        passId: pass.passId,
        personaId: pass.personaId,
        agentName: pass.agentName,
        goal: input.goal,
        requestedAmountUsd: amount,
        status: "paused_for_approval",
        approvalId: approval.id,
        transcript,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      this.state.negotiations = [paused, ...this.state.negotiations];
      this.save();
      return paused;
    }

    // Within autonomous delegation cap -> execute & record governed audit entry!
    const audit = deps.writeAudit.record({
      sfieldRunId: `a2a_${randomUUID().slice(0, 8)}`,
      sfieldToolRef: "cep.a2a.delegated_action@1.0.0",
      domain: "customer360",
      recordId: pass.personaId,
      action: "a2a_autonomous_draft",
      actor: `a2a:${pass.agentName}`,
      summary: `Completed within Delegation Pass ${pass.passId} cap ($${amount.toLocaleString("en-US")} <= $${pass.maxTransactionUsd.toLocaleString("en-US")}): ${input.goal}`,
      status: "succeeded",
    });
    pushMsg(
      "cep_agent",
      "A2A",
      `Negotiation completed within your $${pass.maxTransactionUsd.toLocaleString("en-US")} delegation cap and logged to sfield audit (${audit.auditId}).`,
      `auditId=${audit.auditId}`,
    );
    const completed = negotiationSessionSchema.parse({
      sessionId: `neg_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      passId: pass.passId,
      personaId: pass.personaId,
      agentName: pass.agentName,
      goal: input.goal,
      requestedAmountUsd: amount,
      status: "completed",
      auditId: audit.auditId,
      transcript,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    this.state.negotiations = [completed, ...this.state.negotiations];
    this.save();
    return completed;
  }

  /** Customer signs off on a paused A2A negotiation inside chat. */
  approveNegotiation(sessionId: string, customerName: string, approvalStore: ApprovalStore, writeAudit: WriteAuditStore): NegotiationSession | undefined {
    const existing = this.state.negotiations.find((n) => n.sessionId === sessionId);
    if (!existing || existing.status !== "paused_for_approval") return existing;
    const now = new Date().toISOString();
    if (existing.approvalId) {
      approvalStore.decide(existing.approvalId, { decision: "approve", actor: customerName, comment: "Approved via Consumer A2A chat card" });
      approvalStore.markExecuted(existing.approvalId, {
        summary: `Customer ${customerName} approved ${existing.agentName} negotiation: ${existing.goal}`,
        sfieldRunId: `a2a_${sessionId}`,
      });
    }
    const audit = writeAudit.record({
      sfieldRunId: `a2a_${sessionId}`,
      sfieldToolRef: "cep.a2a.delegated_action@1.0.0",
      domain: "customer360",
      recordId: existing.personaId,
      action: "a2a_customer_approved",
      actor: customerName,
      summary: `Customer signed off on ${existing.agentName} negotiation ($${existing.requestedAmountUsd.toLocaleString("en-US")}): ${existing.goal}`,
      status: "succeeded",
      ...(existing.approvalId ? { approvalId: existing.approvalId } : {}),
    });
    const updated: NegotiationSession = {
      ...existing,
      status: "completed",
      auditId: audit.auditId,
      updatedAt: now,
      transcript: [
        ...existing.transcript,
        {
          id: `nm_${randomUUID().slice(0, 8)}`,
          speaker: "sfield_guard",
          protocol: "sfield-HITL",
          text: `Customer ${customerName} approved & signed (${audit.auditId}). Negotiated plan committed.`,
          payloadSummary: `auditId=${audit.auditId}`,
          timestamp: now,
        },
      ],
    };
    this.state.negotiations = this.state.negotiations.map((n) => (n.sessionId === sessionId ? updated : n));
    this.save();
    return updated;
  }
}
