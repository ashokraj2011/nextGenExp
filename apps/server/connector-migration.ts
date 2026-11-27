/**
 * Unifies legacy ExternalConnector entries (connector-store.ts) onto the governed Integration → TaskContract model.
 * Each legacy connector becomes an immutable, versioned, closed-schema TaskContract published into sfield.
 */
import type { ExternalConnector } from "../../packages/contracts/connector";
import type { Integration, TaskContractInput } from "../../packages/contracts/integration-task";
import type { ConnectorStore } from "./connector-store";
import { canonicalJson } from "./approval-store";
import type { IntegrationTaskService, IntegrationTaskStore } from "./integration-tasks";
import { slugifyTaskId } from "./integration-mcp";

export interface ConnectorMigrationEntry {
  connectorId: string;
  integrationId: string;
  toolRef: string;
  status: "migrated" | "already_migrated" | "skipped";
  route?: "dedicated" | "dispatcher" | "unavailable";
  reason?: string;
}

function integrationFromConnector(conn: ExternalConnector): { integration: Integration; target: string } {
  const id = slugifyTaskId(`conn_${conn.id}`);
  const isSandbox = conn.sandboxMode || conn.url.startsWith("sandbox://");
  if (isSandbox) {
    return {
      integration: {
        id,
        name: conn.name.slice(0, 80),
        description: (conn.description || `Migrated from legacy connector ${conn.id}.`).slice(0, 240),
        transport: "sandbox",
        baseUrl: "",
        timeoutMs: Math.min(30_000, Math.max(200, conn.timeoutMs)),
        enabled: conn.enabled,
      },
      target: `legacy_connector:${conn.id}`,
    };
  }

  let baseUrl = conn.url;
  let target = "/";
  try {
    const parsed = new URL(conn.url);
    baseUrl = parsed.origin;
    target = (parsed.pathname || "/") + (parsed.search || "");
  } catch {
    // Keep raw url; store validation will catch invalid URLs.
  }

  const transport = conn.kind === "mcp_bridge" ? "mcp" : "http";
  return {
    integration: {
      id,
      name: conn.name.slice(0, 80),
      description: (conn.description || `Migrated from legacy connector ${conn.id}.`).slice(0, 240),
      transport,
      baseUrl: transport === "mcp" ? conn.url : baseUrl,
      ...(conn.authEnvVar && /^[A-Z][A-Z0-9_]{1,63}$/.test(conn.authEnvVar) ? { secretRef: conn.authEnvVar } : {}),
      timeoutMs: Math.min(30_000, Math.max(200, conn.timeoutMs)),
      enabled: conn.enabled,
    },
    target: transport === "mcp" ? slugifyTaskId(conn.id) : target,
  };
}

function contractFromConnector(conn: ExternalConnector, integrationId: string, target: string): TaskContractInput {
  const taskId = slugifyTaskId(conn.kind === "rest_action" ? `invoke_${conn.id}` : `query_${conn.id}`);
  const isWrite = conn.effect === "write";
  return {
    integrationId,
    taskId,
    version: "1.0.0",
    description: (conn.description || `Governed task migrated from legacy connector "${conn.name}".`).slice(0, 400),
    effect: isWrite ? "write" : "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", minLength: 1, maxLength: 80 },
        note: { type: "string", maxLength: 400 },
        recordId: { type: "string", maxLength: 80 },
        ...(isWrite ? { idempotencyKey: { type: "string", maxLength: 80 } } : {}),
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: {
        summary: { type: "string" },
        statusCode: { type: "integer" },
        connectorId: { type: "string" },
        sandboxMode: { type: "boolean" },
      },
    },
    resultKind: "data",
    outcomeCodes: [
      { code: "OK", meaning: "Connector action completed", success: true },
      { code: "REJECTED", meaning: "Upstream rejected the request", success: false },
    ],
    outcomeMapping: [
      { statusIn: [200, 201, 202], code: "OK" },
      { statusIn: [400, 404, 422], code: "REJECTED" },
    ],
    approvalPolicy: isWrite
      ? { mode: conn.requiresApproval ? "always" : "none", when: [], dualControl: conn.dualControl, expiresInMinutes: 30 }
      : { mode: "none", when: [], dualControl: false, expiresInMinutes: 30 },
    idempotency: isWrite ? { supported: true, keyField: "idempotencyKey" } : { supported: false },
    resourceIdField: "action",
    binding: { target, method: conn.method === "GET" ? "GET" : "POST" },
  };
}

function destination(taskStore: IntegrationTaskStore, integrationId: string, ref: string) {
  return { integration: taskStore.integration(integrationId) ?? null, contract: taskStore.contract(ref) ?? null };
}

export function prepareConnectorMigrations(connectorStore: ConnectorStore, taskStore: IntegrationTaskStore, connectorId?: string) {
  const connectors = connectorStore.list().filter((connector) => !connectorId || connector.id === connectorId);
  return connectors.map((conn) => {
    const { integration, target } = integrationFromConnector(conn);
    const contractInput = contractFromConnector(conn, integration.id, target);
    const ref = `int.${contractInput.integrationId}.${contractInput.taskId}@${contractInput.version}`;
    return { connectorId: conn.id, integration, contractInput, ref, current: destination(taskStore, integration.id, ref) };
  });
}

/** Already-published migrated tasks are left untouched. */
export async function migrateLegacyConnectors(
  migrations: ReturnType<typeof prepareConnectorMigrations>,
  taskStore: IntegrationTaskStore,
  taskService: IntegrationTaskService,
): Promise<ConnectorMigrationEntry[]> {
  const results: ConnectorMigrationEntry[] = [];
  for (const { connectorId, integration, contractInput, ref, current } of migrations) {
    const result = { connectorId, integrationId: integration.id, toolRef: ref };
    if (current.contract?.status === "published") {
      results.push({ ...result, status: "already_migrated" });
      continue;
    }
    try {
      if (canonicalJson(destination(taskStore, integration.id, ref)) !== canonicalJson(current)) {
        throw new Error("The task or its connection changed. Submit a new review.");
      }
      if (!current.integration) taskStore.upsertIntegration(integration);
      if (!current.contract) taskStore.upsertDraft(contractInput);
      const published = await taskService.publish(ref);
      results.push({
        ...result,
        status: "migrated",
        route: published.sfieldRoute,
      });
    } catch (err) {
      results.push({
        ...result,
        status: "skipped",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
