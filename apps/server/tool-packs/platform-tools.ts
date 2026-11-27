/**
 * Host-governed platform tool pack for sfield.
 *
 * Groups the 5 cross-domain platform tools (`cep.recommendations.arbitrate`, `cep.empathy.assess`,
 * `cep.customer360.read`, `cep.domain.execute_write`, `cep.connector.invoke`) behind clean dependency
 * injection so `Runtime` stays focused on sfield bootstrap, authorization, and scope orchestration.
 */
import { defineTool, ToolError, type JsonObject, type ToolHandlerContext } from "@sfield/core";
import {
  recommendationArbitrateInputJsonSchema,
  recommendationArbitrateInputSchema,
  recommendationArbitrateResultJsonSchema,
  recommendationArbitrateToolId,
  recommendationArbitrateToolVersion,
} from "../../../packages/contracts/recommendation-provider";
import {
  emotionalAssessmentJsonSchema,
  empathyAssessInputJsonSchema,
  empathyAssessInputSchema,
  empathyAssessToolId,
  empathyAssessToolVersion,
} from "../../../packages/contracts/empathy";
import { findProfileById, type CustomerProfileStore, type PersonaRecord } from "../../../packages/customer-profiles";
import type { RecommendationArbitrator } from "../../../packages/recommendations";
import type { ConnectorStore } from "../connector-store";
import type { GatewaySettings } from "../gateway";
import { customer360ReadToolId, customer360ReadToolVersion } from "../mcp-exposure-store";
import type { OpsIncidentStore } from "../ops-store";
import { assessEmotionalState, firstNameOf } from "../response-personalizer";
import type { SalesDealStore } from "../sales-store";
import type { ConversationRecord, TurnRecord } from "../store";

export const domainWriteToolId = "cep.domain.execute_write";
export const domainWriteToolVersion = "1.0.0";
export const domainWriteToolRef = `${domainWriteToolId}@${domainWriteToolVersion}`;

export const connectorInvokeToolId = "cep.connector.invoke";
export const connectorInvokeToolVersion = "1.0.0";
export const connectorInvokeToolRef = `${connectorInvokeToolId}@${connectorInvokeToolVersion}`;

export const connectorInvokeInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["connectorId", "action", "actor"],
  properties: {
    connectorId: { type: "string", minLength: 1, maxLength: 64 },
    action: { type: "string", minLength: 1, maxLength: 64 },
    actor: { type: "string", minLength: 1, maxLength: 80 },
    payloadJson: { type: "string", maxLength: 4000 },
  },
} as const;

export const connectorInvokeResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "connectorId", "connectorName", "statusCode", "elapsedMs", "summary", "responsePreview", "sandbox"],
  properties: {
    ok: { type: "boolean" },
    connectorId: { type: "string", minLength: 1, maxLength: 64 },
    connectorName: { type: "string", minLength: 1, maxLength: 100 },
    statusCode: { type: "integer" },
    elapsedMs: { type: "integer" },
    summary: { type: "string", minLength: 1, maxLength: 320 },
    responsePreview: { type: "string", maxLength: 600 },
    sandbox: { type: "boolean" },
  },
} as const;

export const domainWriteInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["domain", "recordId", "action", "actor"],
  properties: {
    domain: { type: "string", enum: ["ops_incident", "sales_deal", "customer360"] },
    recordId: { type: "string", minLength: 1, maxLength: 64 },
    action: { type: "string", minLength: 1, maxLength: 64 },
    actor: { type: "string", minLength: 1, maxLength: 80 },
    note: { type: "string", maxLength: 240 },
    updatesJson: { type: "string", maxLength: 4000 },
  },
} as const;

export const domainWriteResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "recordId", "summary"],
  properties: {
    ok: { type: "boolean" },
    updatedFields: { type: "array", items: { type: "string" } },
    recordId: { type: "string", minLength: 1, maxLength: 64 },
    summary: { type: "string", minLength: 1, maxLength: 320 },
  },
} as const;

export interface PlatformToolPackDeps {
  scopedSelectionTurn: (turnRef: unknown, ctx: ToolHandlerContext) => { turn: TurnRecord; conversation: ConversationRecord; persona: PersonaRecord };
  effectiveFundingStatus: (persona: Pick<PersonaRecord, "personaId" | "accountFundingStatus">, principalId: string) => "funded" | "unfunded";
  buildArbitrator: (turn?: TurnRecord, conversation?: ConversationRecord) => RecommendationArbitrator;
  profileStore?: CustomerProfileStore;
  opsStore?: OpsIncidentStore;
  salesStore?: SalesDealStore;
  connectorStore?: ConnectorStore;
  gatewaySettings?: GatewaySettings;
  dataDir?: string;
  now: () => number;
}

export function createPlatformToolPack(deps: PlatformToolPackDeps) {
  return [
    defineTool({
      id: recommendationArbitrateToolId,
      version: recommendationArbitrateToolVersion,
      description: "Host-governed recommendation arbitrator that fans out across pluggable RecommendationProvider adapters (Treatment Selector + CCRE, Customer 360 NBA, IT Ops Runbooks) behind one normalized sfield boundary.",
      inputs: recommendationArbitrateInputJsonSchema,
      outputs: recommendationArbitrateResultJsonSchema,
      policy: {
        action: recommendationArbitrateToolId,
        effect: "read",
        requiresApproval: false,
        maxAttempts: 1,
        timeoutMs: 5_000,
        classification: "public",
        maxOutputBytes: 48_000,
      },
      handler: async (raw, ctx) => {
        const parsed = recommendationArbitrateInputSchema.parse(raw);
        const { turn, conversation, persona } = deps.scopedSelectionTurn(parsed.turnRef, ctx);
        const funding = deps.effectiveFundingStatus(persona, turn.scope.principalId) === "funded" ? "funded" : "unfunded";
        return deps.buildArbitrator(turn, conversation).arbitrate({
          principalId: turn.scope.principalId,
          personaId: turn.scope.personaId,
          syntheticMid: persona.syntheticMid,
          contextId: parsed.contextId,
          domain: parsed.domain,
          fundingStatus: funding,
          excludePromotions: parsed.excludePromotions ?? false,
          existingBlockTitles: parsed.existingBlockTitles,
        }, ctx.signal);
      },
    }),
    defineTool({
      id: empathyAssessToolId,
      version: empathyAssessToolVersion,
      description: "Assesses customer emotional state, life events, promotion suppression, and tailored empathy framing from the current message, recent context, and Customer 360 notes.",
      inputs: empathyAssessInputJsonSchema,
      outputs: emotionalAssessmentJsonSchema,
      policy: {
        action: empathyAssessToolId,
        effect: "read",
        requiresApproval: false,
        maxAttempts: 1,
        timeoutMs: 6_000,
        classification: "public",
        maxOutputBytes: 8_000,
      },
      handler: async (raw, ctx) => {
        const parsed = empathyAssessInputSchema.parse(raw);
        const profile = deps.profileStore?.findByPersonaId(parsed.personaId) ?? findProfileById(parsed.personaId);
        const customerNotes = parsed.customerNotes ?? profile?.notes;
        const gw = deps.gatewaySettings;
        const isLiveExternalGateway = Boolean(
          gw && (
            gw.profile === "copilot_acp"
            || gw.profile === "openai"
            || gw.profile === "gemini"
            || ("baseUrl" in gw && !/127\.0\.0\.1|localhost/.test(gw.baseUrl))
          ),
        );
        const dataDir = deps.dataDir;
        const llmJson = isLiveExternalGateway && gw && dataDir
          ? async (sys: string, usr: string, sig: AbortSignal) => {
              const { callConfiguredLlmJson } = await import("../dynamic-ui-generator");
              return callConfiguredLlmJson(gw, dataDir, sys, usr, sig, undefined, { operation: "sfield:empathy_assess" });
            }
          : undefined;
        return assessEmotionalState({
          firstName: firstNameOf(profile?.displayName),
          userMessage: parsed.userMessage,
          ordinal: parsed.ordinal,
          recentSummary: parsed.recentSummary,
          customerNotes,
          hasRetirementHistory: parsed.hasRetirementHistory,
          llmJson,
          signal: ctx.signal,
        });
      },
    }),
    defineTool({
      id: customer360ReadToolId,
      version: customer360ReadToolVersion,
      description: "Reads live Customer 360 profile, advisor notes, balances, and portfolio totals by personaId.",
      inputs: {
        type: "object",
        additionalProperties: false,
        required: ["personaId"],
        properties: { personaId: { type: "string", minLength: 1, maxLength: 80 } },
      },
      outputs: {
        type: "object",
        additionalProperties: false,
        required: ["personaId", "displayName", "segment", "notes", "accountFundingStatus", "beneficiaryStatus", "cashCents", "equityCents", "fixedIncomeCents", "totalPortfolioCents"],
        properties: {
          personaId: { type: "string" },
          displayName: { type: "string" },
          segment: { type: "string" },
          notes: { type: "string" },
          accountFundingStatus: { type: "string" },
          beneficiaryStatus: { type: "string" },
          cashCents: { type: "integer" },
          equityCents: { type: "integer" },
          fixedIncomeCents: { type: "integer" },
          totalPortfolioCents: { type: "integer" },
        },
      },
      policy: {
        action: customer360ReadToolId,
        effect: "read",
        requiresApproval: false,
        maxAttempts: 1,
        timeoutMs: 4_000,
        classification: "public",
        maxOutputBytes: 8_000,
      },
      handler: async (raw) => {
        const personaId = String((raw as { personaId: string }).personaId);
        const profile = deps.profileStore?.findByPersonaId(personaId) ?? findProfileById(personaId);
        if (!profile) throw new ToolError("CUSTOMER_NOT_FOUND", `Customer profile not found: ${personaId}`);
        return {
          personaId: profile.personaId,
          displayName: profile.displayName,
          segment: profile.segment,
          notes: profile.notes,
          accountFundingStatus: profile.accountFundingStatus,
          beneficiaryStatus: profile.beneficiaryStatus,
          cashCents: profile.cashCents,
          equityCents: profile.equityCents,
          fixedIncomeCents: profile.fixedIncomeCents,
          totalPortfolioCents: profile.cashCents + profile.equityCents + profile.fixedIncomeCents,
        };
      },
    }),
    defineTool({
      id: domainWriteToolId,
      version: domainWriteToolVersion,
      description: "Host-governed domain write-back tool for operator-confirmed mutations across IT Incidents, Sales Deals, and Customer 360 bindings.",
      resource: { type: "domain_record", id: { ref: "inputs.recordId" } },
      inputs: domainWriteInputJsonSchema,
      outputs: domainWriteResultJsonSchema,
      policy: {
        action: domainWriteToolId,
        effect: "write",
        requiresApproval: false,
        maxAttempts: 1,
        timeoutMs: 5_000,
        classification: "public",
        maxOutputBytes: 16_000,
      },
      handler: async (raw): Promise<JsonObject> => {
        const inp = raw as {
          domain: "ops_incident" | "sales_deal" | "customer360";
          recordId: string;
          action: string;
          actor: string;
          note?: string;
          updatesJson?: string;
        };
        if (inp.domain === "ops_incident") {
          if (!deps.opsStore) throw new ToolError("OPS_STORE_UNAVAILABLE");
          const decision = inp.action as "approve_rollback" | "reject_rollback" | "resolve" | "escalate";
          const updated = deps.opsStore.decide(inp.recordId, { decision, actor: inp.actor, ...(inp.note ? { note: inp.note } : {}) });
          if (!updated) throw new ToolError("INCIDENT_NOT_FOUND");
          return {
            ok: true,
            recordId: updated.id,
            summary: `${updated.id} → ${updated.status} (error rate ${updated.errorRatePct}%, p95 ${updated.p95LatencyMs}ms)`,
          };
        }
        if (inp.domain === "sales_deal") {
          if (!deps.salesStore) throw new ToolError("SALES_STORE_UNAVAILABLE");
          const decision = inp.action as "approve_discount" | "reject_discount" | "advance_stage";
          const updated = deps.salesStore.decide(inp.recordId, { decision, actor: inp.actor, ...(inp.note ? { note: inp.note } : {}) });
          if (!updated) throw new ToolError("DEAL_NOT_FOUND");
          return {
            ok: true,
            recordId: updated.id,
            summary: `${updated.id} (${updated.accountName}) → ${updated.stage} (${updated.discountStatus}, ${updated.winProbabilityPct}% prob.)`,
          };
        }
        if (!deps.profileStore) throw new ToolError("CUSTOMER_STORE_UNAVAILABLE");
        const updates = inp.updatesJson ? JSON.parse(inp.updatesJson) as Record<string, string> : {};
        const applied = deps.profileStore.applyBindings(inp.recordId, updates, deps.now());
        return {
          ok: applied.updatedFields.length > 0,
          recordId: inp.recordId,
          updatedFields: applied.updatedFields,
          summary: `Updated Customer 360 bindings: ${applied.updatedFields.join(", ") || "none"}`,
        };
      },
    }),
    defineTool({
      id: connectorInvokeToolId,
      version: connectorInvokeToolVersion,
      description: "Execute an enabled external REST or MCP connector action under sfield host governance, timeout controls, and write audit logging.",
      inputs: connectorInvokeInputJsonSchema,
      outputs: connectorInvokeResultJsonSchema,
      resource: { type: "external_connector", id: { ref: "inputs.connectorId" } },
      policy: {
        action: connectorInvokeToolId,
        effect: "write",
        requiresApproval: false,
        maxAttempts: 1,
        timeoutMs: 8_000,
        classification: "public",
        maxOutputBytes: 16_000,
      },
      handler: async (raw, ctx) => {
        if (!deps.connectorStore) throw new ToolError("CONNECTOR_STORE_UNAVAILABLE");
        const inp = raw as { connectorId: string; action: string; actor: string; payloadJson?: string };
        let payload: Record<string, unknown> = {};
        if (inp.payloadJson) {
          try {
            const parsed = JSON.parse(inp.payloadJson) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              payload = parsed as Record<string, unknown>;
            }
          } catch {
            throw new ToolError("INVALID_PAYLOAD_JSON");
          }
        }
        try {
          const out = await deps.connectorStore.invokeConnector(
            inp.connectorId,
            { action: inp.action, actor: inp.actor, payload },
            ctx.signal,
          );
          return {
            ok: out.ok,
            connectorId: out.connectorId,
            connectorName: out.connectorName,
            statusCode: out.statusCode,
            elapsedMs: out.elapsedMs,
            summary: out.summary,
            responsePreview: out.responsePreview,
            sandbox: out.sandbox,
          };
        } catch (err) {
          throw new ToolError("CONNECTOR_EXECUTION_FAILED", err instanceof Error ? err.message : "Connector failed");
        }
      },
    }),
  ];
}
