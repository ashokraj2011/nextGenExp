// Standalone Agent-to-Agent (A2A) & Domain-Agnostic Identity example:
// Demonstrates a non-MID domain (Healthcare MRN) where an AI triage agent acts On-Behalf-Of
// a patient via createAgentPrincipal() + declarative { ref: "principal.identifiers.mrn" } binding over MCP.
import {
  SField,
  EphemeralPersistence,
  defineTool,
  createAgentPrincipal,
  createMcpClient,
  createMcpProxyTools,
  effectiveSubjectId,
  isAgentPrincipal,
  resolveIdentifier,
} from "@sfield/core";

const patientChartTool = defineTool({
  id: "ehr.chart.summary",
  version: "1.0.0",
  description: "Read a patient chart summary bound to the authenticated caller's MRN.",
  inputs: {
    type: "object",
    properties: { section: { type: "string", enum: ["allergies", "medications"] } },
    required: ["section"],
    additionalProperties: false,
  },
  outputs: {
    type: "object",
    properties: {
      mrn: { type: "string" },
      callerKind: { type: "string" },
      representedSubject: { type: "string" },
      section: { type: "string" },
      items: { type: "array", items: { type: "string" } },
    },
    required: ["mrn", "callerKind", "representedSubject", "section", "items"],
    additionalProperties: false,
  },
  // Declaratively binds resource.id to ANY domain identifier (here: MRN, not MID!)
  resource: { type: "patient", id: { ref: "principal.identifiers.mrn" } },
  policy: { effect: "read", classification: "confidential" },
  handler: async ({ section }, ctx) => {
    const mrn = resolveIdentifier(ctx.principal, "mrn") ?? "unknown";
    return {
      mrn,
      callerKind: ctx.principal.kind ?? "human",
      representedSubject: effectiveSubjectId(ctx.principal),
      section: String(section),
      items: section === "allergies" ? ["Penicillin"] : ["Lisinopril 10mg"],
    };
  },
});

// EHR service runtime governed by an Authorizer that understands both human & agent OBO callers
const ehrSf = await SField.create({
  config: { version: 1, models: {}, agents: {} },
  deployment: "ephemeral",
  persistence: new EphemeralPersistence(),
  tools: [patientChartTool],
  authorizer: {
    async authorize(req) {
      // Allow verified agent callers acting on behalf of a patient for read-only patient resources
      if (isAgentPrincipal(req.principal) && req.effect === "read" && req.resource.type === "patient" && req.resource.id === "MRN-88210") {
        return { decision: "allow", evidenceId: `obo:${req.principal.subjectId}->${req.resource.id}`, expiresAt: new Date(Date.now() + 60_000).toISOString() };
      }
      return { decision: "deny", code: "ACCESS_DENIED", reason: "Caller not authorized for patient resource" };
    },
  },
  quiet: true,
});

// Expose EHR tool over MCP with token -> Agent OBO Principal authentication
const ehrMcp = ehrSf.createMcpServer({
  serverInfo: { name: "ehr-sfield-mcp", version: "1.0.0" },
  preset: "read_only",
  authenticate: (headers) => {
    if (headers["authorization"] === "Bearer agent-triage-obo-token") {
      return createAgentPrincipal({
        tenantId: "clinic-east",
        agentId: "triage-assistant",
        roles: ["agent", "ehr.read"],
        actingFor: {
          subjectId: "patient:8821",
          kind: "human",
          identifiers: { mrn: "MRN-88210" },
        },
      });
    }
    return null;
  },
  allowTools: (tool, principal) => Boolean(principal?.roles.includes("ehr.read")) && tool.ref === "ehr.chart.summary@1.0.0",
});

// Calling agent runtime consumes EHR tool over MCP with its signed agent token
const inMemoryFetch = async (_url, init) => {
  const hdrs = Object.fromEntries(new Headers(init?.headers).entries());
  const res = await ehrMcp.handleRequest(JSON.parse(String(init?.body ?? "{}")), { headers: hdrs });
  return new Response(JSON.stringify(res.body ?? {}), { status: res.status, headers: res.headers });
};

const client = createMcpClient({
  endpoint: "http://ehr.internal/mcp",
  headers: { authorization: "Bearer agent-triage-obo-token" },
  fetchImpl: inMemoryFetch,
});
const proxyTools = await createMcpProxyTools(client, { namespace: "ehr_remote" });

const callerSf = await SField.create({
  config: { version: 1, models: {}, agents: {} },
  preset: "memory",
  tools: proxyTools,
  quiet: true,
});

const out = await callerSf.registry.execute({
  toolRef: `${proxyTools[0].id}@${proxyTools[0].version}`,
  inputs: { section: "allergies" },
});
console.log("A2A OBO result:", out.status, out.output);

await callerSf.close();
await ehrSf.close();
