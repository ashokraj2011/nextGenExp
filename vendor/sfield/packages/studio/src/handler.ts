/**
 * HTTP handler and standalone server for @sfield/studio.
 *
 * Works in two modes:
 *   1. Standalone CLI/process: `await startStudioServer({ runtime, telemetry, port: 4310 })`
 *   2. Embeddable middleware: `const handle = createStudioHandler({ runtime, basePath: "/admin/sfield-studio", authorize })`
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  approveLock,
  createPiiFirewall,
  createPrincipal,
  createSFieldMcpServer,
  defineGraph,
  GRAPH_END,
  GraphService,
  isoAfter,
  MCP_PROTOCOL_VERSION_2026,
  McpExtensionStore,
  newId,
  nowIso,
  requestElicitation,
  SFieldError,
  SlashCommandService,
  type ActingForIdentity,
  type ExecutionPersistence,
  type JsonObject,
  type McpExtraTool,
  type MemoryItem,
  type Principal,
  type RunState,
  type SFieldMcpHost,
} from "@sfield/core";
import type { StudioOptions, StudioServerHandle, StudioServerOptions } from "./types.js";
import { renderStudioHtml } from "./ui.js";
import { runRedTeamProofSuite } from "./redteam.js";

function normalizeBasePath(raw?: string): string {
  if (!raw || raw === "/") return "";
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("Request body too large."), { statusCode: 413 });
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw Object.assign(
      new Error(err instanceof Error ? err.message : "Invalid JSON body."),
      { statusCode: 400 },
    );
  }
}

function getPersistence(options: StudioOptions): ExecutionPersistence | undefined {
  return options.runtime?.persistence ?? options.persistence;
}

function extractIdentifiers(raw: unknown): Record<string, string> {
  const identifiers: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) identifiers[k] = v.trim();
    }
  }
  return identifiers;
}

function buildPrincipalFromBody(raw: unknown, fallbackTenant = "studio", fallbackSubject = "studio-user"): Principal {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createPrincipal({ tenantId: fallbackTenant, subjectId: fallbackSubject });
  }
  const obj = raw as Record<string, unknown>;
  const tenantId = typeof obj["tenantId"] === "string" && obj["tenantId"].trim() ? obj["tenantId"].trim() : fallbackTenant;
  const subjectId = typeof obj["subjectId"] === "string" && obj["subjectId"].trim() ? obj["subjectId"].trim() : fallbackSubject;
  const kind = obj["kind"] === "agent" || obj["kind"] === "service" ? obj["kind"] : "human";
  const identifiers = extractIdentifiers(obj["identifiers"]);

  let actingFor: ActingForIdentity | undefined;
  if (obj["actingFor"] && typeof obj["actingFor"] === "object" && !Array.isArray(obj["actingFor"])) {
    const obo = obj["actingFor"] as Record<string, unknown>;
    const oboSub = typeof obo["subjectId"] === "string" && obo["subjectId"].trim() ? obo["subjectId"].trim() : undefined;
    if (oboSub) {
      const oboIds = extractIdentifiers(obo["identifiers"]);
      actingFor = {
        subjectId: oboSub,
        kind: obo["kind"] === "service" ? "service" : "human",
        ...(Object.keys(oboIds).length > 0 ? { identifiers: oboIds } : {}),
      };
    }
  }

  return createPrincipal({
    tenantId,
    subjectId,
    kind,
    ...(Object.keys(identifiers).length > 0 ? { identifiers } : {}),
    ...(actingFor ? { actingFor } : {}),
  });
}

/**
 * Creates a reusable Node.js HTTP request handler for `@sfield/studio`.
 * Returns `true` when the request path matched `basePath` and was handled; `false` otherwise.
 */
export function createStudioHandler(options: StudioOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const basePath = normalizeBasePath(options.basePath);
  const title = options.title ?? "sfield Studio";
  const readOnly = Boolean(options.readOnly);
  const plugins = options.plugins ?? [];
  const pii = options.piiFirewall ?? createPiiFirewall();
  const mcpStore = options.mcpExtensionStore ?? new McpExtensionStore();
  const html = renderStudioHtml({
    title,
    basePath,
    readOnly,
    plugins,
    approvalChatPath: options.approvalChatPath,
    backHref: options.backHref,
    backLabel: options.backLabel,
  });

  const studioDemoTool: McpExtraTool = {
    descriptor: {
      name: "studio.mcp2026.demo@1.0.0",
      description: "Interactive MCP 2026 demo tool supporting Async Tasks and mid-flight JSON Schema Elicitation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", description: "Action to request (e.g. rebalance_portfolio)" },
          justification: { type: "string", description: "Operator justification (elicited if omitted)" },
          maxBudgetUsd: { type: "number", description: "Approved budget cap in USD (elicited if omitted)" },
          confirmed: { type: "boolean", description: "Explicit confirmation flag" },
        },
      },
    },
    handler: async (args) => {
      const action = typeof args["action"] === "string" && args["action"].trim()
        ? args["action"].trim()
        : "rebalance_portfolio";
      if (!args["justification"] || typeof args["maxBudgetUsd"] !== "number") {
        requestElicitation({
          message: `Provide structured approval details to continue "${action}".`,
          requestedSchema: {
            type: "object",
            additionalProperties: false,
            required: ["justification", "maxBudgetUsd", "confirmed"],
            properties: {
              justification: { type: "string", minLength: 3, maxLength: 200, description: "Business justification" },
              maxBudgetUsd: { type: "number", minimum: 1, maximum: 1000000, description: "Budget cap (USD)" },
              confirmed: { type: "boolean", description: "Confirm execution" },
            },
          },
        });
      }
      const payload = {
        status: "completed",
        action,
        justification: args["justification"],
        maxBudgetUsd: args["maxBudgetUsd"],
        confirmed: Boolean(args["confirmed"]),
        completedAt: nowIso(),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  };

  const offlineMcpHost: SFieldMcpHost = {
    registry: {
      list: () => [],
      describe: (ref) => { throw new SFieldError("UNKNOWN_TOOL", `Runtime offline; tool ${ref} unavailable`); },
    },
    executions: {
      open: async () => { throw new SFieldError("STATE_UNAVAILABLE", "Runtime offline"); },
      resume: async () => { throw new SFieldError("STATE_UNAVAILABLE", "Runtime offline"); },
    },
  };

  const studioMcpServer = createSFieldMcpServer(options.runtime ?? offlineMcpHost, {
    serverInfo: { name: "sfield-studio-mcp", version: "1.0.0" },
    preset: "read_only",
    extensionStore: mcpStore,
    extraTools: [studioDemoTool],
  });

  const studioMcpPrincipal = (): Principal => options.runtime?.devPrincipal
    ?? createPrincipal({ tenantId: "studio", subjectId: "studio-operator" });

  const graphService = options.runtime?.graphs ?? new GraphService({
    executions: {
      open: async () => { throw new SFieldError("STATE_UNAVAILABLE", "Runtime offline"); },
    },
  });
  const commandService = options.runtime?.commands ?? new SlashCommandService();

  type RebalanceState = {
    accountId: string;
    amountUsd: number;
    riskTier?: "low" | "elevated";
    complianceOk?: boolean;
    liquidityOk?: boolean;
    humanApproved?: boolean;
    decision?: string;
  };

  const studioDemoGraph = defineGraph<RebalanceState>({
    id: "studio.rebalance.graph",
    version: "1.0.0",
    description: "Governed multi-step rebalance graph with parallel checks, conditional HITL interrupt, and checkpoint Time-Travel.",
    entry: "assess_risk",
    nodes: {
      assess_risk: {
        preset: "read_only",
        handler: async (state) => ({
          riskTier: state.amountUsd >= 10_000 ? "elevated" : "low",
        }),
      },
      parallel_checks: {
        kind: "parallel",
        branches: ["check_compliance", "check_liquidity"],
      },
      check_compliance: {
        preset: "read_only",
        handler: async () => ({ complianceOk: true }),
      },
      check_liquidity: {
        preset: "read_only",
        handler: async () => ({ liquidityOk: true }),
      },
      hitl_review: {
        preset: "supervised",
        handler: async (state, ctx) => {
          if (ctx.resumeValue && typeof ctx.resumeValue === "object" && (ctx.resumeValue as { approved?: boolean }).approved) {
            return { humanApproved: true };
          }
          return ctx.interrupt(`Elevated rebalance ($${state.amountUsd.toLocaleString()}) requires human sign-off.`, {
            accountId: state.accountId,
            amountUsd: state.amountUsd,
            riskTier: state.riskTier,
          });
        },
      },
      finalize: {
        preset: "read_only",
        handler: async (state) => ({
          decision: state.riskTier === "elevated"
            ? `Approved high-value rebalance of $${state.amountUsd.toLocaleString()} for ${state.accountId} (HITL verified)`
            : `Auto-cleared low-risk rebalance of $${state.amountUsd.toLocaleString()} for ${state.accountId}`,
        }),
      },
    },
    edges: {
      assess_risk: "parallel_checks",
      hitl_review: "finalize",
      finalize: GRAPH_END,
    },
    conditionalEdges: {
      parallel_checks: (state) => (state.riskTier === "elevated" ? "hitl_review" : "finalize"),
    },
  });
  graphService.register(studioDemoGraph);

  const assertWritable = () => {
    if (readOnly) {
      throw Object.assign(new Error("Studio is running in read-only mode."), { statusCode: 403 });
    }
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const rawUrl = req.url ?? "/";
    const url = new URL(rawUrl, "http://127.0.0.1");
    const pathname = url.pathname;

    if (basePath) {
      if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
        return false;
      }
    }

    if (options.authorize) {
      const allowed = await options.authorize(req);
      if (!allowed) {
        sendJson(res, { error: "unauthorized", message: "Studio access requires authorization." }, 401);
        return true;
      }
    }

    const rel = basePath ? pathname.slice(basePath.length) || "/" : pathname;
    const method = (req.method ?? "GET").toUpperCase();

    try {
      // Root HTML UI
      if ((rel === "/" || rel === "") && method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(html);
        return true;
      }

      const persistence = getPersistence(options);

      // GET /api/overview
      if (rel === "/api/overview" && method === "GET") {
        const health = options.runtime
          ? await options.runtime.health()
          : persistence
            ? { ok: (await persistence.health()).ok, persistence: await persistence.health() }
            : { ok: true, detail: "no persistence attached" };
        const configDigest = options.runtime?.config.digest() ?? null;
        const effective = options.runtime?.config.effective();
        const lockRecord = persistence
          ? (configDigest ? await persistence.lockApprovals.get(configDigest) : await persistence.lockApprovals.latest())
          : null;
        const runs = persistence ? await persistence.listRuns({ limit: 50 }) : [];
        const pendingApprovals = persistence ? await persistence.listApprovals({ status: ["pending"] }) : [];
        const evalReports = persistence ? await persistence.evalReports.list({}) : [];
        const tools = options.runtime ? options.runtime.registry.list() : [];
        const spans = options.telemetry ? options.telemetry.snapshot().spans : [];

        sendJson(res, {
          title,
          readOnly,
          hasRuntime: Boolean(options.runtime),
          deployment: options.runtime ? (health as { deployment?: string }).deployment ?? persistence?.mode : persistence?.mode ?? "none",
          health,
          configDigest,
          models: effective ? Object.keys(effective.models) : [],
          agents: effective ? Object.keys(effective.agents) : [],
          lock: {
            digest: configDigest ?? lockRecord?.digest ?? null,
            approved: Boolean(lockRecord),
            record: lockRecord,
          },
          counts: {
            tools: tools.length,
            runs: runs.length,
            pendingApprovals: pendingApprovals.length,
            evalReports: evalReports.length,
            spans: spans.length,
          },
          plugins,
        });
        return true;
      }

      // GET /api/runs
      if (rel === "/api/runs" && method === "GET") {
        if (!persistence) {
          sendJson(res, { runs: [] });
          return true;
        }
        const limitRaw = Number(url.searchParams.get("limit") ?? "50");
        const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.floor(limitRaw))) : 50;
        const tenantId = url.searchParams.get("tenantId") || undefined;
        const stateParam = url.searchParams.get("state");
        const state = stateParam ? (stateParam.split(",") as RunState[]) : undefined;
        const runs = await persistence.listRuns({
          ...(tenantId ? { tenantId } : {}),
          ...(state ? { state } : {}),
          limit,
        });
        sendJson(res, { runs });
        return true;
      }

      // GET /api/runs/:runId
      if (rel.startsWith("/api/runs/") && method === "GET") {
        const runId = decodeURIComponent(rel.slice("/api/runs/".length));
        if (!persistence) {
          sendJson(res, { error: "persistence_unavailable", message: "No persistence store attached." }, 404);
          return true;
        }
        const run = await persistence.getRun(runId);
        if (!run) {
          sendJson(res, { error: "run_not_found", message: `Run "${runId}" not found.` }, 404);
          return true;
        }
        const [calls, modelAttempts, audit, events] = await Promise.all([
          persistence.listCalls(runId),
          persistence.listModelAttempts(runId),
          persistence.readAudit({ runId, limit: 200 }),
          persistence.readEvents(runId, 0, 200),
        ]);
        sendJson(res, { run, calls, modelAttempts, audit, events: events.events });
        return true;
      }

      // GET /api/tools
      if (rel === "/api/tools" && method === "GET") {
        const tools = options.runtime ? options.runtime.registry.list() : [];
        sendJson(res, { tools });
        return true;
      }

      // POST /api/tools/invoke — interactive Principal & Tool Playground
      if (rel === "/api/tools/invoke" && method === "POST") {
        assertWritable();
        if (!options.runtime) {
          sendJson(res, { error: "runtime_required", message: "A live SField runtime is required to invoke tools." }, 400);
          return true;
        }
        const body = await readJsonBody(req);
        const toolRef = typeof body["toolRef"] === "string" ? body["toolRef"].trim() : "";
        if (!toolRef) {
          sendJson(res, { error: "invalid_input", message: "toolRef is required." }, 400);
          return true;
        }
        const args = (body["args"] && typeof body["args"] === "object" && !Array.isArray(body["args"]))
          ? (body["args"] as JsonObject)
          : {};
        const principal = buildPrincipalFromBody(body["principal"]);
        const preset = body["preset"] === "read_only" || body["preset"] === "bounded_auto" ? body["preset"] : "supervised";

        const scope = await options.runtime.executions.open({
          principal,
          purpose: `studio:${toolRef}`,
          preset,
        });
        try {
          const result = await scope.registry.execute(toolRef, args);
          sendJson(res, {
            ...result,
            runId: scope.id,
            principal,
          });
        } finally {
          await scope.close();
        }
        return true;
      }

      // GET /api/approvals
      if (rel === "/api/approvals" && method === "GET") {
        const approvals = persistence ? await persistence.listApprovals({}) : [];
        sendJson(res, { approvals });
        return true;
      }

      // POST /api/approvals/:id/decide
      if (rel.startsWith("/api/approvals/") && rel.endsWith("/decide") && method === "POST") {
        assertWritable();
        if (!persistence) {
          sendJson(res, { error: "persistence_unavailable", message: "No persistence store attached." }, 400);
          return true;
        }
        const id = decodeURIComponent(rel.slice("/api/approvals/".length, -"/decide".length));
        const body = await readJsonBody(req);
        const decision = body["decision"] === "approve" || body["decision"] === "deny" ? body["decision"] : null;
        if (!decision) {
          sendJson(res, { error: "invalid_input", message: 'decision must be "approve" or "deny".' }, 400);
          return true;
        }
        const actorId = typeof body["actorId"] === "string" && body["actorId"].trim() ? body["actorId"].trim() : "studio-approver";
        const comment = typeof body["comment"] === "string" ? body["comment"] : undefined;
        const existingApproval = await persistence.getApproval(id);
        const result = await persistence.decideApproval({
          id,
          actor: { tenantId: existingApproval?.tenantId ?? "studio", subjectId: actorId, roles: ["studio-approver"] },
          decision,
          ...(comment ? { comment } : {}),
          now: nowIso(),
        });
        sendJson(res, result);
        return true;
      }

      // GET /api/locks
      if (rel === "/api/locks" && method === "GET") {
        const digest = options.runtime?.config.digest() ?? url.searchParams.get("digest") ?? null;
        const record = persistence
          ? (digest ? await persistence.lockApprovals.get(digest) : await persistence.lockApprovals.latest())
          : null;
        sendJson(res, { digest: digest ?? record?.digest ?? null, approved: Boolean(record), record });
        return true;
      }

      // POST /api/locks/approve
      if (rel === "/api/locks/approve" && method === "POST") {
        assertWritable();
        if (!persistence) {
          sendJson(res, { error: "persistence_unavailable", message: "No persistence store attached." }, 400);
          return true;
        }
        const body = await readJsonBody(req);
        const digest = (typeof body["digest"] === "string" && body["digest"].trim())
          ? body["digest"].trim()
          : options.runtime?.config.digest();
        if (!digest) {
          sendJson(res, { error: "invalid_input", message: "digest is required." }, 400);
          return true;
        }
        const approver = typeof body["approver"] === "string" && body["approver"].trim() ? body["approver"].trim() : "studio-operator";
        const comment = typeof body["comment"] === "string" && body["comment"].trim() ? body["comment"].trim() : undefined;
        const noBaseline = body["noBaseline"] !== false;
        const result = await approveLock(
          { digest, approver, ...(comment ? { comment } : {}), noBaseline },
          undefined,
          { lockApprovals: persistence.lockApprovals, evalReports: persistence.evalReports },
        );
        sendJson(res, { ok: true, ...result });
        return true;
      }

      // GET /api/evals
      if (rel === "/api/evals" && method === "GET") {
        const reports = persistence ? await persistence.evalReports.list({}) : [];
        sendJson(res, { reports });
        return true;
      }

      // GET /api/memory
      if (rel === "/api/memory" && method === "GET") {
        if (!persistence?.memory) {
          sendJson(res, { items: [] });
          return true;
        }
        const tenantId = url.searchParams.get("tenantId") || options.runtime?.devPrincipal?.tenantId || "demo-tenant";
        const subjectId = url.searchParams.get("subjectId") || undefined;
        const text = url.searchParams.get("text") || undefined;
        const page = await persistence.memory.list(
          tenantId,
          {
            ...(subjectId ? { scope: { kind: "subject", tenantId, subjectId } } : {}),
            ...(text ? { text } : {}),
          },
          { limit: 100 },
        );
        sendJson(res, { items: page.items });
        return true;
      }

      // POST /api/memory
      if (rel === "/api/memory" && method === "POST") {
        assertWritable();
        if (!persistence?.memory) {
          sendJson(res, { error: "memory_unavailable", message: "Memory repository is not attached." }, 400);
          return true;
        }
        const body = await readJsonBody(req);
        const tenantId = typeof body["tenantId"] === "string" && body["tenantId"].trim() ? body["tenantId"].trim() : "demo-tenant";
        const subjectId = typeof body["subjectId"] === "string" && body["subjectId"].trim() ? body["subjectId"].trim() : "studio-user";
        const content = typeof body["content"] === "string" ? body["content"].trim() : "";
        const kind = body["kind"] === "preference" || body["kind"] === "summary" ? body["kind"] : "fact";
        if (!content) {
          sendJson(res, { error: "invalid_input", message: "content is required." }, 400);
          return true;
        }
        const now = nowIso();
        const memItem: MemoryItem = {
          id: newId("mem"),
          version: "1",
          scope: { kind: "subject", tenantId, subjectId },
          kind,
          content,
          origin: "user_explicit",
          provenance: [{ sourceType: "host", sourceId: "sfield-studio", observedAt: now }],
          classification: "internal",
          expiresAt: isoAfter(365 * 24 * 3600 * 1000),
          status: "active",
          createdAt: now,
          updatedAt: now,
        };
        const created = await persistence.memory.create(tenantId, memItem, newId("idem"));
        sendJson(res, { item: created.item }, 201);
        return true;
      }

      // DELETE /api/memory/:id
      if (rel.startsWith("/api/memory/") && method === "DELETE") {
        assertWritable();
        if (!persistence?.memory) {
          sendJson(res, { error: "memory_unavailable", message: "Memory repository is not attached." }, 400);
          return true;
        }
        const id = decodeURIComponent(rel.slice("/api/memory/".length));
        const tenantId = url.searchParams.get("tenantId") || options.runtime?.devPrincipal?.tenantId || "demo-tenant";
        const receipt = await persistence.memory.delete(tenantId, [id], newId("idem"));
        sendJson(res, { deleted: true, receipt });
        return true;
      }

      // POST /api/pii/test
      if (rel === "/api/pii/test" && method === "POST") {
        const body = await readJsonBody(req);
        const text = typeof body["text"] === "string" ? body["text"] : "";
        const result = pii.scrubText(text);
        const rehydrated = pii.rehydrateText(result.scrubbed, result.tokenMap);
        sendJson(res, {
          scrubbed: result.scrubbed,
          rehydrated,
          redactions: result.tokens,
        });
        return true;
      }

      // GET /api/telemetry
      if (rel === "/api/telemetry" && method === "GET") {
        if (!options.telemetry) {
          sendJson(res, { spans: [], metrics: [] });
          return true;
        }
        const snap = options.telemetry.snapshot();
        sendJson(res, {
          serviceName: snap.serviceName,
          spans: snap.spans,
          metrics: snap.metrics,
        });
        return true;
      }

      // GET /api/telemetry/otlp
      if (rel === "/api/telemetry/otlp" && method === "GET") {
        sendJson(res, options.telemetry ? options.telemetry.buildOtlpTracePayload() : { resourceSpans: [] });
        return true;
      }

      // GET /api/mcp2026/state — list active MCP 2026 async tasks, pending elicitations, and callable tools
      if (rel === "/api/mcp2026/state" && method === "GET") {
        const principal = studioMcpPrincipal();
        const listed = await studioMcpServer.handleRequest(
          { jsonrpc: "2.0", id: "tools-list", method: "tools/list" },
          { principal },
        );
        const resultObj = (listed.body && typeof listed.body === "object" && "result" in listed.body)
          ? (listed.body as { result?: Record<string, unknown> }).result
          : undefined;
        const tools = Array.isArray(resultObj?.["tools"]) ? resultObj!["tools"] : [];
        sendJson(res, {
          protocolVersion: MCP_PROTOCOL_VERSION_2026,
          tasks: mcpStore.listTasks(),
          elicitations: mcpStore.listElicitations({ status: "pending" }),
          tools,
        });
        return true;
      }

      // POST /api/mcp2026/call — invoke a tool over MCP 2026 (optionally as an Async Task)
      if (rel === "/api/mcp2026/call" && method === "POST") {
        assertWritable();
        const body = await readJsonBody(req);
        const name = typeof body["name"] === "string" ? body["name"].trim() : "";
        if (!name) {
          sendJson(res, { error: "invalid_tool", message: "name is required." }, 400);
          return true;
        }
        const args = (body["arguments"] && typeof body["arguments"] === "object" && !Array.isArray(body["arguments"]))
          ? body["arguments"] as Record<string, unknown>
          : {};
        const asyncTask = Boolean(body["asyncTask"]);
        const principal = body["principal"] ? buildPrincipalFromBody(body["principal"]) : studioMcpPrincipal();
        const rpc = await studioMcpServer.handleRequest({
          jsonrpc: "2.0",
          id: newId("mcp"),
          method: "tools/call",
          params: {
            name,
            arguments: args,
            ...(asyncTask ? { task: { ttl: 60_000 } } : {}),
          },
        }, { principal });
        sendJson(res, {
          response: rpc.body,
          tasks: mcpStore.listTasks(),
          elicitations: mcpStore.listElicitations({ status: "pending" }),
        }, rpc.status);
        return true;
      }

      // POST /api/mcp2026/elicitations/:id/respond — respond (accept / decline / cancel) to a pending elicitation
      if (rel.startsWith("/api/mcp2026/elicitations/") && rel.endsWith("/respond") && method === "POST") {
        assertWritable();
        const elicitationId = decodeURIComponent(
          rel.slice("/api/mcp2026/elicitations/".length, -"/respond".length),
        );
        const body = await readJsonBody(req);
        const action = body["action"] === "decline" || body["action"] === "cancel" ? body["action"] : "accept";
        const content = (body["content"] && typeof body["content"] === "object" && !Array.isArray(body["content"]))
          ? body["content"] as Record<string, unknown>
          : undefined;
        const existing = mcpStore.getElicitation(elicitationId);
        const principal = existing?.principal ?? studioMcpPrincipal();
        const rpc = await studioMcpServer.handleRequest({
          jsonrpc: "2.0",
          id: newId("mcp"),
          method: "elicitation/respond",
          params: {
            elicitationId,
            action,
            ...(content ? { content } : {}),
          },
        }, { principal });
        sendJson(res, {
          response: rpc.body,
          tasks: mcpStore.listTasks(),
          elicitations: mcpStore.listElicitations({ status: "pending" }),
        }, rpc.status);
        return true;
      }

      // POST /api/mcp2026/tasks/:id/cancel — cancel an active MCP 2026 async task
      if (rel.startsWith("/api/mcp2026/tasks/") && rel.endsWith("/cancel") && method === "POST") {
        assertWritable();
        const taskId = decodeURIComponent(rel.slice("/api/mcp2026/tasks/".length, -"/cancel".length));
        const taskRec = mcpStore.getTask(taskId);
        const principal = taskRec
          ? createPrincipal({ tenantId: taskRec.tenantId, subjectId: taskRec.subjectId })
          : studioMcpPrincipal();
        const rpc = await studioMcpServer.handleRequest({
          jsonrpc: "2.0",
          id: newId("mcp"),
          method: "tasks/cancel",
          params: { taskId },
        }, { principal });
        sendJson(res, {
          response: rpc.body,
          tasks: mcpStore.listTasks(),
          elicitations: mcpStore.listElicitations({ status: "pending" }),
        }, rpc.status);
        return true;
      }

      // GET /api/mcp2026/tasks/:id/result — fetch result of an MCP 2026 async task
      if (rel.startsWith("/api/mcp2026/tasks/") && rel.endsWith("/result") && method === "GET") {
        const taskId = decodeURIComponent(rel.slice("/api/mcp2026/tasks/".length, -"/result".length));
        const taskRec = mcpStore.getTask(taskId);
        const principal = taskRec
          ? createPrincipal({ tenantId: taskRec.tenantId, subjectId: taskRec.subjectId })
          : studioMcpPrincipal();
        const rpc = await studioMcpServer.handleRequest({
          jsonrpc: "2.0",
          id: newId("mcp"),
          method: "tasks/result",
          params: { taskId },
        }, { principal });
        sendJson(res, { response: rpc.body }, rpc.status);
        return true;
      }

      // GET /api/graphs/runs — list registered governed graphs and persisted graph runs
      if (rel === "/api/graphs/runs" && method === "GET") {
        sendJson(res, {
          graphs: graphService.list(),
          runs: graphService.listRuns(),
        });
        return true;
      }

      // POST /api/graphs/demo — execute the built-in governed rebalance graph (supports custom amountUsd)
      if (rel === "/api/graphs/demo" && method === "POST") {
        assertWritable();
        const body = await readJsonBody(req);
        const amountUsd = typeof body["amountUsd"] === "number" && Number.isFinite(body["amountUsd"])
          ? body["amountUsd"]
          : 25_000;
        const accountId = typeof body["accountId"] === "string" && body["accountId"].trim()
          ? body["accountId"].trim()
          : "acct-wealth-001";
        const principal = body["principal"] ? buildPrincipalFromBody(body["principal"]) : studioMcpPrincipal();
        const run = await graphService.run({
          graph: studioDemoGraph,
          principal,
          initialState: { accountId, amountUsd },
        });
        sendJson(res, { run, runs: graphService.listRuns() }, 201);
        return true;
      }

      // POST /api/graphs/runs/:id/resume — resume an interrupted graph run
      if (rel.startsWith("/api/graphs/runs/") && rel.endsWith("/resume") && method === "POST") {
        assertWritable();
        const runId = decodeURIComponent(rel.slice("/api/graphs/runs/".length, -"/resume".length));
        const body = await readJsonBody(req);
        const existing = graphService.getRun(runId);
        const principal = existing
          ? createPrincipal({ tenantId: existing.tenantId, subjectId: existing.subjectId })
          : studioMcpPrincipal();
        const run = await graphService.resume({
          runId,
          principal,
          resumeValue: body["resumeValue"] ?? { approved: true },
          ...(body["statePatch"] && typeof body["statePatch"] === "object"
            ? { statePatch: body["statePatch"] as Record<string, unknown> }
            : {}),
        });
        sendJson(res, { run, runs: graphService.listRuns() });
        return true;
      }

      // POST /api/graphs/runs/:id/fork — Time-Travel fork & replay from any historical checkpoint
      if (rel.startsWith("/api/graphs/runs/") && rel.endsWith("/fork") && method === "POST") {
        assertWritable();
        const runId = decodeURIComponent(rel.slice("/api/graphs/runs/".length, -"/fork".length));
        const body = await readJsonBody(req);
        const checkpointId = typeof body["checkpointId"] === "string" ? body["checkpointId"].trim() : "";
        if (!checkpointId) {
          sendJson(res, { error: "invalid_checkpoint", message: "checkpointId is required." }, 400);
          return true;
        }
        const existing = graphService.getRun(runId);
        const principal = existing
          ? createPrincipal({ tenantId: existing.tenantId, subjectId: existing.subjectId })
          : studioMcpPrincipal();
        const forked = await graphService.forkAndReplay({
          runId,
          checkpointId,
          principal,
          ...(body["stateOverride"] && typeof body["stateOverride"] === "object"
            ? { stateOverride: body["stateOverride"] as Record<string, unknown> }
            : {}),
        });
        sendJson(res, { run: forked, runs: graphService.listRuns() }, 201);
        return true;
      }

      // POST /api/redteam/run — execute 5 live zero-trust governance & red-team proofs
      if (rel === "/api/redteam/run" && method === "POST") {
        const result = await runRedTeamProofSuite();
        sendJson(res, result);
        return true;
      }

      // GET /api/commands — list tenant-scoped slash commands from sf.commands
      if (rel === "/api/commands" && method === "GET") {
        const tenantId = url.searchParams.get("tenantId") || options.runtime?.devPrincipal?.tenantId || "pzn-local";
        const domain = url.searchParams.get("domain") || undefined;
        const includeDisabled = url.searchParams.get("includeDisabled") === "true";
        sendJson(res, {
          tenantId,
          hasOverride: commandService.hasTenantOverride(tenantId),
          commands: commandService.list({ tenantId, ...(domain ? { domain } : {}), includeDisabled }),
        });
        return true;
      }

      // POST /api/commands — upsert a tenant-scoped slash command
      if (rel === "/api/commands" && method === "POST") {
        assertWritable();
        const body = await readJsonBody(req);
        const tenantId = typeof body["tenantId"] === "string" && body["tenantId"].trim()
          ? body["tenantId"].trim()
          : (options.runtime?.devPrincipal?.tenantId || "pzn-local");
        const saved = commandService.upsert(tenantId, {
          command: String(body["command"] ?? ""),
          label: String(body["label"] ?? ""),
          hint: String(body["hint"] ?? ""),
          action: String(body["action"] ?? "prompt"),
          ...(typeof body["prompt"] === "string" ? { prompt: body["prompt"] } : {}),
          ...(typeof body["toolRef"] === "string" && body["toolRef"].trim() ? { toolRef: body["toolRef"].trim() } : {}),
          ...(typeof body["domain"] === "string" && body["domain"].trim() ? { domain: body["domain"].trim() } : {}),
          enabled: body["enabled"] !== false,
        });
        sendJson(res, {
          tenantId,
          command: saved,
          commands: commandService.list({ tenantId, includeDisabled: true }),
        }, 201);
        return true;
      }

      // DELETE /api/commands/:cmd — remove a slash command for a tenant
      if (rel.startsWith("/api/commands/") && method === "DELETE") {
        assertWritable();
        const cmd = decodeURIComponent(rel.slice("/api/commands/".length));
        const tenantId = url.searchParams.get("tenantId") || options.runtime?.devPrincipal?.tenantId || "pzn-local";
        const removed = commandService.remove(tenantId, cmd);
        sendJson(res, {
          tenantId,
          removed,
          commands: commandService.list({ tenantId, includeDisabled: true }),
        });
        return true;
      }

      sendJson(res, { error: "not_found", message: `Unknown Studio route: ${method} ${rel}` }, 404);
      return true;
    } catch (err) {
      const status = typeof (err as { statusCode?: number }).statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : 500;
      sendJson(res, { error: "studio_error", message: err instanceof Error ? err.message : String(err) }, status);
      return true;
    }
  };
}

/** Starts a standalone `@sfield/studio` HTTP workbench server. */
export async function startStudioServer(options: StudioServerOptions = {}): Promise<StudioServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4310;
  const handler = createStudioHandler(options);

  const server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled && !res.writableEnded) {
        sendJson(res, { error: "not_found" }, 404);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const basePath = normalizeBasePath(options.basePath);
  return {
    host,
    port: addr.port,
    url: `http://${host}:${addr.port}${basePath}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
