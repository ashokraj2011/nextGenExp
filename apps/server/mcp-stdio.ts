/**
 * Standalone stdio MCP server entrypoint for CEP's @sfield/core runtime.
 *
 * Usage:
 *   npm run mcp:stdio
 *
 * Connect from Claude Desktop, Cursor, or any MCP stdio client to invoke CEP's
 * governed sfield tools (cep.empathy.assess@1.0.0, cep.customer360.read@1.0.0,
 * cep.knowledge.search@1.0.0) with full Authorizer, Ajv validation, and SQLite audit logging.
 */
import { join, resolve } from "node:path";
import { SField, defineTool, createDevAuthorizer, LOCAL_DEV_PRINCIPAL } from "@sfield/core";
import { SqlitePersistence } from "@sfield/store-sqlite";
import {
  emotionalAssessmentJsonSchema,
  empathyAssessInputJsonSchema,
  empathyAssessInputSchema,
  empathyAssessToolId,
  empathyAssessToolRef,
  empathyAssessToolVersion,
} from "../../packages/contracts/empathy";
import { CustomerProfileStore } from "../../packages/customer-profiles";
import { KnowledgeBaseStore } from "./knowledge-base";
import { assessEmotionalState, firstNameOf } from "./response-personalizer";
import {
  customer360ReadToolId,
  customer360ReadToolRef,
  customer360ReadToolVersion,
  McpExposureStore,
} from "./mcp-exposure-store";
import { tenantDataDirectory } from "./tenant";

const dataDir = tenantDataDirectory(resolve(process.env.PZN_DATA_DIR || ".pzn-data/copilot"));
const profileStore = new CustomerProfileStore(dataDir);
const knowledgeBase = new KnowledgeBaseStore(dataDir);
const exposureStore = new McpExposureStore(dataDir);

const empathyTool = defineTool({
  id: empathyAssessToolId,
  version: empathyAssessToolVersion,
  description: "Assesses customer emotional state, life events, promotion suppression, and tailored empathy framing from chat + Customer 360 notes.",
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
    const profile = profileStore.findByPersonaId(parsed.personaId);
    return assessEmotionalState({
      firstName: firstNameOf(profile?.displayName),
      userMessage: parsed.userMessage,
      ordinal: parsed.ordinal,
      recentSummary: parsed.recentSummary,
      customerNotes: parsed.customerNotes ?? profile?.notes,
      hasRetirementHistory: parsed.hasRetirementHistory,
      signal: ctx.signal,
    });
  },
});

const customer360ReadTool = defineTool({
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
    classification: "internal",
    maxOutputBytes: 8_000,
  },
  handler: async (raw) => {
    const personaId = String((raw as { personaId: string }).personaId);
    const profile = profileStore.findByPersonaId(personaId);
    if (!profile) throw new Error(`Customer profile not found: ${personaId}`);
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
});

async function main() {
  const sf = await SField.create({
    deployment: "durable_single",
    config: { version: 1, models: {}, agents: {} },
    persistence: new SqlitePersistence({ path: join(dataDir, "sfield-mcp-stdio.sqlite") }),
    namespace: "cep-mcp-stdio",
    authorizer: createDevAuthorizer(),
    tools: [empathyTool, customer360ReadTool],
  });

  const cfg = exposureStore.get();
  const mcp = sf.createMcpServer({
    serverInfo: { name: "cep-sfield-stdio-mcp", version: "1.1.0" },
    sessionId: "cep-mcp-stdio",
    principal: LOCAL_DEV_PRINCIPAL,
    preset: "read_only",
    allowTools: cfg.enabledToolRefs.length ? cfg.enabledToolRefs : [empathyAssessToolRef, customer360ReadToolRef],
    extraTools: cfg.includeKnowledgeSearch
      ? [{
          descriptor: {
            name: "cep.knowledge.search@1.0.0",
            description: "Search CEP enterprise policy & runbook Knowledge Base using hybrid BM25 + semantic vector retrieval.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["query"],
              properties: {
                query: { type: "string", minLength: 2, maxLength: 400 },
                limit: { type: "integer", minimum: 1, maximum: 10 },
              },
            },
            annotations: { title: "CEP Knowledge Search", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
          },
          handler: async (args) => {
            const query = String(args.query ?? "").trim();
            if (!query) throw new Error("query is required");
            const limit = typeof args.limit === "number" ? Math.min(10, Math.max(1, Math.round(args.limit))) : 3;
            const res = knowledgeBase.search(query, limit);
            return { content: [{ type: "text", text: JSON.stringify(res) }], structuredContent: res };
          },
        }]
      : [],
  });

  try {
    await mcp.serveStdio();
  } finally {
    await sf.close();
  }
}

void main();
