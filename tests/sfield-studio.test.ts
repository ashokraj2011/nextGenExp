import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SField,
  createDevAuthorizer,
  defineTool,
  resolveIdentifier,
} from "@sfield/core";
import { sqlitePersistence } from "@sfield/store-sqlite";
import { startStudioServer } from "@sfield/studio";
import { createOtelTelemetrySink } from "@sfield/telemetry-otel";
import { operatorHeader, startApp } from "./operator-fixture";
import { runCli } from "@sfield/cli";

test("@sfield/studio serves standalone workbench UI, Principal/Tool playground, traces, locks, memory, PII lab, OTel, auth & readOnly guards", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sfield-studio-"));
  const dbPath = join(dir, "studio.sqlite");
  const telemetry = createOtelTelemetrySink({ serviceName: "studio-test" });

  const patientChartTool = defineTool({
    id: "ehr.chart.read",
    version: "1.0.0",
    description: "Read a patient chart using Principal.identifiers.mrn.",
    resource: { type: "patient_chart", id: { ref: "principal.identifiers.mrn" } },
    inputs: {
      type: "object",
      additionalProperties: false,
      properties: { section: { type: "string" } },
      required: ["section"],
    },
    outputs: {
      type: "object",
      additionalProperties: false,
      properties: {
        mrn: { type: "string" },
        section: { type: "string" },
        callerKind: { type: "string" },
        actingForSubject: { type: "string" },
      },
      required: ["mrn", "section", "callerKind", "actingForSubject"],
    },
    policy: { effect: "read", classification: "confidential" },
    handler: async (raw, ctx) => {
      const mrn = resolveIdentifier(ctx.principal, "mrn") ?? "unknown";
      return {
        mrn,
        section: String(raw["section"] ?? "summary"),
        callerKind: ctx.principal.kind ?? "human",
        actingForSubject: ctx.principal.actingFor?.subjectId ?? ctx.principal.subjectId,
      };
    },
  });

  const sf = await SField.create({
    config: { version: 1, models: {}, agents: {} },
    deployment: "durable_single",
    persistence: sqlitePersistence({ path: dbPath }),
    telemetry,
    tools: [patientChartTool],
    authorizer: {
      authorize: async (req) => (
        req.principal.tenantId === "hospital-east"
          ? { decision: "allow" as const, evidenceId: `ehr_${req.resource.id}`, expiresAt: new Date(Date.now() + 60_000).toISOString() }
          : { decision: "deny" as const, code: "TENANT_DENIED", reason: "Unknown hospital tenant" }
      ),
    },
    quiet: true,
  });

  const studio = await startStudioServer({
    runtime: sf,
    telemetry,
    port: 0,
    title: "Healthcare sfield Studio",
    plugins: [
      { id: "ehr-admin", label: "EHR Rules", badge: "Domain", href: "/ehr" },
    ],
  });

  try {
    // 1. HTML UI renders title and host plugin tab
    const htmlRes = await fetch(studio.url);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /Healthcare sfield Studio/);
    assert.match(html, /EHR Rules/);

    // 2. Overview & Tool Registry
    const overview = await (await fetch(`${studio.url}/api/overview`)).json() as {
      hasRuntime: boolean;
      configDigest: string;
      counts: { tools: number };
      lock: { approved: boolean };
    };
    assert.equal(overview.hasRuntime, true);
    assert.ok(overview.configDigest.startsWith("sha256:"));
    assert.ok(overview.counts.tools >= 1);
    assert.equal(overview.lock.approved, false);

    const toolsRes = await (await fetch(`${studio.url}/api/tools`)).json() as { tools: Array<{ ref: string }> };
    assert.ok(toolsRes.tools.some((t) => t.ref === "ehr.chart.read@1.0.0"));

    // 3. Principal & Tool Playground (Agent acting On-Behalf-Of human with MRN identifier)
    const invokeRes = await fetch(`${studio.url}/api/tools/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolRef: "ehr.chart.read@1.0.0",
        args: { section: "allergies" },
        principal: {
          tenantId: "hospital-east",
          subjectId: "triage-bot-01",
          kind: "agent",
          identifiers: { mrn: "MRN-77412" },
          actingFor: {
            tenantId: "hospital-east",
            subjectId: "patient-alice",
            kind: "human",
            identifiers: { mrn: "MRN-77412" },
          },
        },
      }),
    });
    const invokeText = await invokeRes.text();
    assert.equal(invokeRes.status, 200, invokeText);
    const invoked = JSON.parse(invokeText) as {
      runId: string;
      status: string;
      output: { mrn: string; section: string; callerKind: string; actingForSubject: string };
    };
    assert.equal(invoked.status, "succeeded");
    assert.equal(invoked.output.mrn, "MRN-77412");
    assert.equal(invoked.output.callerKind, "agent");
    assert.equal(invoked.output.actingForSubject, "patient-alice");

    // 4. Persisted Runs & Deep Run Trace Inspector
    const runsPayload = await (await fetch(`${studio.url}/api/runs`)).json() as { runs: Array<{ runId: string }> };
    assert.ok(runsPayload.runs.some((r) => r.runId === invoked.runId));

    const runDetail = await (await fetch(`${studio.url}/api/runs/${encodeURIComponent(invoked.runId)}`)).json() as {
      run: { runId: string; principal: { kind?: string; identifiers?: Record<string, string>; actingFor?: { subjectId: string } } };
      calls: Array<{ toolRef: string }>;
      audit: unknown[];
    };
    assert.equal(runDetail.run.principal.kind, "agent");
    assert.equal(runDetail.run.principal.identifiers?.mrn, "MRN-77412");
    assert.equal(runDetail.run.principal.actingFor?.subjectId, "patient-alice");
    assert.equal(runDetail.calls[0]?.toolRef, "ehr.chart.read@1.0.0");

    // 5. Governance Lock approval via Studio API
    const lockRes = await fetch(`${studio.url}/api/locks/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approver: "release-lead", comment: "Verified in Studio" }),
    });
    assert.equal(lockRes.status, 200);
    const lockStatus = await (await fetch(`${studio.url}/api/locks`)).json() as { approved: boolean; record: { approver: string } };
    assert.equal(lockStatus.approved, true);
    assert.equal(lockStatus.record.approver, "release-lead");

    // 6. Memory Explorer CRUD
    const memAdd = await fetch(`${studio.url}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: "hospital-east", subjectId: "patient-alice", kind: "fact", content: "Allergic to penicillin" }),
    });
    assert.equal(memAdd.status, 201);
    const { item } = await memAdd.json() as { item: { id: string; content: string } };
    assert.equal(item.content, "Allergic to penicillin");

    const memList = await (await fetch(`${studio.url}/api/memory?tenantId=hospital-east&subjectId=patient-alice`)).json() as { items: Array<{ id: string }> };
    assert.ok(memList.items.some((m) => m.id === item.id));

    const memDel = await fetch(`${studio.url}/api/memory/${encodeURIComponent(item.id)}?tenantId=hospital-east`, { method: "DELETE" });
    assert.equal(memDel.status, 200);

    // 7. PII Firewall Lab
    const piiRes = await fetch(`${studio.url}/api/pii/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Contact jane@example.com with SSN 123-45-6789." }),
    });
    assert.equal(piiRes.status, 200);
    const pii = await piiRes.json() as { scrubbed: string; rehydrated: string; redactions: unknown[] };
    assert.ok(!pii.scrubbed.includes("123-45-6789"));
    assert.ok(pii.rehydrated.includes("123-45-6789"));
    assert.ok(pii.redactions.length >= 2);

    // 8. Telemetry & OTLP JSON export
    const tel = await (await fetch(`${studio.url}/api/telemetry`)).json() as { spans: unknown[] };
    assert.ok(Array.isArray(tel.spans));
    const otlp = await (await fetch(`${studio.url}/api/telemetry/otlp`)).json() as { resourceSpans: unknown[] };
    assert.ok(Array.isArray(otlp.resourceSpans));

    // 8b. MCP 2026 Elicitation & Async Task lifecycle in Studio
    const mcpState = await (await fetch(`${studio.url}/api/mcp2026/state`)).json() as {
      protocolVersion: string;
      tools: Array<{ name: string }>;
      tasks: unknown[];
      elicitations: unknown[];
    };
    assert.equal(mcpState.protocolVersion, "2026-07-28");
    assert.ok(mcpState.tools.some((t) => t.name === "studio.mcp2026.demo@1.0.0"));

    const callRes = await fetch(`${studio.url}/api/mcp2026/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "studio.mcp2026.demo@1.0.0",
        arguments: { action: "rebalance_portfolio" },
        asyncTask: true,
      }),
    });
    assert.equal(callRes.status, 200);
    const callBody = await callRes.json() as { response: { result?: { task?: { taskId: string } } } };
    const taskId = callBody.response.result?.task?.taskId;
    assert.ok(taskId);

    // Wait briefly for the async task to pause on mid-flight elicitation
    await new Promise((r) => setTimeout(r, 40));
    const pausedState = await (await fetch(`${studio.url}/api/mcp2026/state`)).json() as {
      tasks: Array<{ taskId: string; status: string }>;
      elicitations: Array<{ elicitationId: string }>;
    };
    const pausedTask = pausedState.tasks.find((t) => t.taskId === taskId);
    assert.equal(pausedTask?.status, "input_required");
    assert.equal(pausedState.elicitations.length, 1);
    const elicitationId = pausedState.elicitations[0].elicitationId;

    // Submit structured elicitation response and confirm async task completes
    const respRes = await fetch(`${studio.url}/api/mcp2026/elicitations/${encodeURIComponent(elicitationId)}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "accept",
        content: { justification: "Quarterly client rebalance", maxBudgetUsd: 5000, confirmed: true },
      }),
    });
    assert.equal(respRes.status, 200);
    const taskResultRes = await fetch(`${studio.url}/api/mcp2026/tasks/${encodeURIComponent(taskId)}/result`);
    assert.equal(taskResultRes.status, 200);
    const taskResult = await taskResultRes.json() as {
      response: {
        result?: {
          task?: { status: string };
          result?: { structuredContent?: { status: string; maxBudgetUsd: number } };
        };
      };
    };
    assert.equal(taskResult.response.result?.task?.status, "completed");
    assert.equal(taskResult.response.result?.result?.structuredContent?.status, "completed");
    assert.equal(taskResult.response.result?.result?.structuredContent?.maxBudgetUsd, 5000);
  } finally {
    await studio.close();
  }

  // 9. Auth guard (401) and Read-Only guard (403)
  const lockedStudio = await startStudioServer({
    runtime: sf,
    port: 0,
    readOnly: true,
    authorize: (req) => req.headers["x-studio-key"] === "secret-token",
  });
  try {
    const unauth = await fetch(`${lockedStudio.url}/api/overview`);
    assert.equal(unauth.status, 401);

    const authOk = await fetch(`${lockedStudio.url}/api/overview`, { headers: { "x-studio-key": "secret-token" } });
    assert.equal(authOk.status, 200);

    const roDeny = await fetch(`${lockedStudio.url}/api/locks/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-studio-key": "secret-token" },
      body: JSON.stringify({ approver: "someone" }),
    });
    assert.equal(roDeny.status, 403);
  } finally {
    await lockedStudio.close();
    await sf.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CEP embeds @sfield/studio at /admin/sfield-studio with host plugins and sfield CLI lists studio command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cep-studio-mount-"));
  const app = await startApp({
    dataDir: dir,
    projectRoot: process.cwd(),
    gateway: null,
    inspectorEnabled: true,
  });
  try {
    const authHeaders = { Authorization: operatorHeader() };
    const page = await fetch(`${app.url}/admin/sfield-studio`, { headers: authHeaders });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /sfield Studio · CEP/);
    assert.match(html, /Self-Service PZN Studio/);

    const overviewRes = await fetch(`${app.url}/admin/sfield-studio/api/overview`, { headers: authHeaders });
    assert.equal(overviewRes.status, 200);
    const overview = await overviewRes.json() as { title: string; plugins: Array<{ id: string }> };
    assert.equal(overview.title, "sfield Studio · CEP");
    assert.ok(overview.plugins.some((p) => p.id === "pzn-studio"));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }

  let helpOut = "";
  const code = await runCli(["--help"], { stdout: (c) => { helpOut += c; } });
  assert.equal(code, 0);
  assert.match(helpOut, /sfield studio/);
});
