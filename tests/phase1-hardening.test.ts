import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "./operator-fixture";
import { testClient, testProject } from "./client";
import { startFixtureGateway } from "./gateway-fixture";
import { callConfiguredLlmJson } from "../apps/server/dynamic-ui-generator";
import { scrubNeutralModelRequest } from "../apps/server/pii-firewall";
import { CepTelemetry } from "../apps/server/telemetry";
import type { TelemetryView } from "../packages/contracts/telemetry";
import type { IntegrationTasksView, TaskRun } from "../packages/contracts/integration-task";
import type { WorkflowRun, WorkflowsAdminView } from "../packages/contracts/workflow-definition";
import type { ApprovalRecord, PublicationReview } from "../packages/contracts/approval";
import type { KnowledgeBaseView } from "../packages/contracts/knowledge-base";
import type { VerticalPacksView } from "../packages/contracts/vertical-pack";

/** Fake OpenAI-compatible LLM that echoes the received user prompt inside a JSON object so tests can assert zero PII egress. */
async function startEchoLlm() {
  const seenPrompts: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { messages?: Array<{ role: string; content: string }> };
      const userText = body.messages?.find((m) => m.role === "user")?.content ?? "";
      seenPrompts.push(userText);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        model: "echo-test-model",
        usage: { prompt_tokens: 120, completion_tokens: 45 },
        choices: [{ message: { role: "assistant", content: JSON.stringify({ echoed: userText }) } }],
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    seenPrompts,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Fake OTLP/HTTP trace collector that records incoming ExportTraceServiceRequest JSON payloads. */
async function startFakeOtlpCollector() {
  const batches: Array<{ resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string; attributes: Array<{ key: string }> }> }> }> }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.url === "/v1/traces") {
        batches.push(JSON.parse(raw || "{}"));
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    batches,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("1.1 PII Firewall enforces redaction at the single LLM egress boundary and rehydrates locally", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-p1-pii-"));
  const echo = await startEchoLlm();
  const fixture = await startFixtureGateway();
  const app = await startApp({
    projectRoot: fileURLToPath(testProject),
    dataDir: dir,
    gateway: fixture.settings,
   
    inspectorEnabled: true,
    piiEnabledByDefault: true,
  });
  t.after(async () => { await app.close(); await fixture.close(); await echo.close(); await rm(dir, { recursive: true, force: true }); });

  const sensitivePrompt = "Draft a note for Alice Morgan (alice@example.com, SSN 123-45-6789) regarding $42,500 transfer from acct-99112233.";
  const result = await callConfiguredLlmJson(
    { baseUrl: echo.baseUrl, model: "echo-test-model", apiKey: "sk-echo", contextWindow: 16384, maxOutputTokens: 1500 },
    dir,
    "Return JSON.",
    sensitivePrompt,
    AbortSignal.timeout(5000),
  ) as { echoed: string };

  // 1. Outbound payload seen by the external LLM must contain ZERO raw PII.
  assert.equal(echo.seenPrompts.length, 1);
  const outbound = echo.seenPrompts[0]!;
  assert.ok(!outbound.includes("Alice Morgan"), `Name leaked outbound: ${outbound}`);
  assert.ok(!outbound.includes("alice@example.com"), `Email leaked outbound: ${outbound}`);
  assert.ok(!outbound.includes("123-45-6789"), `SSN leaked outbound: ${outbound}`);
  assert.ok(!outbound.includes("$42,500"), `Amount leaked outbound: ${outbound}`);
  assert.ok(!outbound.includes("acct-99112233"), `Account ID leaked outbound: ${outbound}`);
  assert.match(outbound, /«PERSON_\d+»/);
  assert.match(outbound, /«EMAIL_\d+»/);
  assert.match(outbound, /«SSN_\d+»/);

  // 2. Parsed JSON response is rehydrated locally back to the original values.
  assert.ok(result.echoed.includes("Alice Morgan"), `Expected local rehydration of name, got: ${result.echoed}`);
  assert.ok(result.echoed.includes("alice@example.com"));
  assert.ok(result.echoed.includes("123-45-6789"));
  assert.ok(result.echoed.includes("$42,500"));

  // 2b. Verify sfield's beforeModelDispatch hook scrubber also scrubs JSON envelopes safely without breaking JSON syntax.
  const hookOut = scrubNeutralModelRequest({
    binding: {} as never,
    instructions: [],
    messages: [{ role: "user", parts: [{ type: "text", text: JSON.stringify({ inputType: "PznContextRoutingInput", request: "Email alice@example.com about $9,500 SSN 123-45-6789", contextId: "portsum" }) }] }],
    tools: [],
    params: { maxOutputTokens: 512 },
    toolChoice: "none",
  }, ["Alice Morgan"], app.internals.piiFirewall, "run_hook_test");
  assert.equal(hookOut.redactedCount, 3);
  const scrubbedJson = JSON.parse((hookOut.request.messages[0] as { parts: Array<{ text: string }> }).parts[0]!.text) as { inputType: string; request: string; contextId: string };
  assert.equal(scrubbedJson.inputType, "PznContextRoutingInput", "structural keys remain verbatim");
  assert.equal(scrubbedJson.contextId, "portsum", "structural keys remain verbatim");
  assert.ok(!scrubbedJson.request.includes("alice@example.com") && !scrubbedJson.request.includes("123-45-6789") && !scrubbedJson.request.includes("$9,500"));

  // 3. Audit trail & Telemetry recorded the egress redaction + gen_ai.* span.
  const client = await testClient(app.url);
  const piiView = await client.request<{ stats: { totalTokensRedacted: number }; recentEvents: Array<{ personaName?: string }> }>("/api/admin/pii-firewall");
  assert.ok(piiView.stats.totalTokensRedacted >= 5, `Expected >=5 redacted tokens, got ${piiView.stats.totalTokensRedacted}`);
  assert.ok(piiView.recentEvents.some((e) => e.personaName?.startsWith("egress:")));

  const teleView = await client.request<TelemetryView>("/api/admin/telemetry");
  assert.ok(teleView.summary.totalModelCalls >= 1);
  assert.equal(teleView.summary.totalInputTokens, 120);
  assert.equal(teleView.summary.totalOutputTokens, 45);
  assert.ok(teleView.summary.piiRedactedTokens >= 5);
  assert.ok(teleView.recentSpans.some((s) => s.attributes["gen_ai.request.model"] === "echo-test-model"));
});

test("1.2 OpenTelemetry gen_ai.* TelemetrySink exports valid OTLP/HTTP traces and records sfield tool metrics", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-p1-otel-"));
  const collector = await startFakeOtlpCollector();
  t.after(async () => { await collector.close(); await rm(dir, { recursive: true, force: true }); });

  const telemetry = new CepTelemetry(dir, { otlpEndpoint: collector.endpoint, serviceName: "cep-test-svc" });
  telemetry.metric("sfield.tool.duration_ms", 42, { tool: "int.itsm_sandbox.create_ticket", status: "succeeded" });
  telemetry.recordModelCall({
    operation: "sfield:route", provider: "openai", model: "gpt-4.1-mini", durationMs: 310, status: "ok",
    inputTokens: 1000, outputTokens: 250, runId: "run_test_1",
  });
  telemetry.event("sfield.run.finished", { agent: "context-router", state: "completed" });

  // Wait briefly for fire-and-forget OTLP export to deliver to local fake collector.
  for (let i = 0; i < 20 && collector.batches.length < 3; i++) await new Promise((r) => setTimeout(r, 30));

  const view = telemetry.view();
  assert.equal(view.summary.totalToolCalls, 1);
  assert.equal(view.summary.totalModelCalls, 1);
  assert.equal(view.summary.totalAgentRuns, 1);
  assert.equal(view.summary.totalInputTokens, 1000);
  assert.equal(view.summary.totalOutputTokens, 250);
  assert.ok(view.summary.estimatedCostUsd > 0);
  assert.equal(view.otlpExport.configured, true);
  assert.equal(view.otlpExport.exportedSpans, 3);
  assert.equal(view.otlpExport.failedExports, 0);
  assert.equal(collector.batches.length, 3);
  const spanNames = collector.batches.flatMap((b) => b.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans.map((sp) => sp.name))));
  assert.ok(spanNames.includes("execute_tool int.itsm_sandbox.create_ticket"));
  assert.ok(spanNames.includes("chat gpt-4.1-mini"));
  assert.ok(spanNames.includes("invoke_agent context-router"));
});

test("1.3 Unify legacy connectors & workflows onto governed Integration → TaskContract", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-p1-unify-"));
  const fixture = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: fixture.settings, inspectorEnabled: true });
  t.after(async () => { await app.close(); await fixture.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);

  // A. Migrate legacy sandbox connector (pagerduty_incident_webhook) into a governed Integration Task published live to sfield.
  const migrated = await client.publish<{
    results: Array<{ connectorId: string; toolRef: string; status: string; route?: string }>;
    view: IntegrationTasksView;
  }>("/api/integrations/migrate-connectors", { connectorId: "pagerduty_incident_webhook" });
  assert.equal(migrated.results.length, 1);
  assert.equal(migrated.results[0]!.status, "migrated");
  assert.equal(migrated.results[0]!.route, "dedicated");
  const pdRef = migrated.results[0]!.toolRef;

  // Running the migrated write task requires approval (preserving connector.requiresApproval=true) and executes through sfield!
  const pendingPd = await client.request<{ run: TaskRun; approval?: ApprovalRecord }>("/api/integrations/tasks/run", {
    toolRef: pdRef,
    input: { action: "trigger_incident", note: "Edge latency spike" },
  }, 202);
  assert.ok(pendingPd.approval);
  const approvedPd = await client.request<{ taskRun: TaskRun }>(`/api/approvals/${pendingPd.approval.id}/decide`, { decision: "approve" });
  assert.equal(approvedPd.taskRun.state, "succeeded");
  assert.equal(approvedPd.taskRun.outcome?.code, "OK");

  // Re-running migration is idempotent.
  const secondMigrate = await client.publish<{ results: Array<{ status: string }> }>("/api/integrations/migrate-connectors", { connectorId: "pagerduty_incident_webhook" });
  assert.equal(secondMigrate.results[0]!.status, "already_migrated");

  // B. Workflow Engine executes a governed `integration_task` step — including pausing for sfield HITL approval and auto-resuming!
  await client.publish("/api/workflows", {
    id: "governed_incident_flow",
    name: "Governed Incident Escalation Flow",
    domain: "operations",
    version: "1.0.0",
    description: "Collects incident details, creates a governed ITSM ticket through sfield, and emits completion.",
    triggerPhrases: ["run governed incident flow"],
    enabled: true,
    steps: [
      {
        id: "collect",
        type: "collect_input",
        title: "Incident Details",
        submitLabel: "Create Ticket",
        fields: [
          { id: "title", label: "Title", type: "text", required: true },
          { id: "priority", label: "Priority", type: "select", options: ["P1", "P3"], defaultValue: "P1" },
          { id: "service", label: "Service", type: "text", defaultValue: "payments" },
        ],
      },
      {
        id: "ticket",
        type: "integration_task",
        title: "Create Governed ITSM Ticket",
        toolRef: "int.itsm_sandbox.create_ticket@1.0.0",
        inputMapping: { title: "{{inputs.title}}", priority: "{{inputs.priority}}", service: "{{inputs.service}}" },
        outputPrefix: "itsm",
      },
      {
        id: "done",
        type: "emit_host_event",
        title: "Emit Confirmation",
        eventName: "cep:incident_created",
        messageTemplate: "Ticket {{computed.itsm_ticketId}} is {{computed.itsm_status}}.",
      },
    ],
  });

  // Start workflow and submit P1 -> pauses at integration_task waiting for sfield approval!
  const started = await client.request<{ run: WorkflowRun }>("/api/workflows/governed_incident_flow/start", { personaId: "demo-learner" }, 201);
  assert.equal(started.run.status, "waiting_input");
  const afterInput = await client.request<{ run: WorkflowRun }>(`/api/workflow-runs/${started.run.runId}/input`, {
    inputs: { title: "Payments gateway 503", priority: "P1", service: "payments" },
  });
  assert.equal(afterInput.run.status, "waiting_approval");
  const taskStep = afterInput.run.steps.find((s) => s.stepId === "ticket")!;
  assert.equal(taskStep.type, "integration_task");
  assert.ok(taskStep.approvalId);

  // Approving the integration_task approval executes sfield AND automatically resumes & completes the workflow!
  await client.request(`/api/approvals/${taskStep.approvalId}/decide`, { decision: "approve" });
  const finished = await client.request<{ run: WorkflowRun }>(`/api/workflow-runs/${started.run.runId}`);
  assert.equal(finished.run.status, "completed");
  assert.match(String(finished.run.computed.itsm_ticketId), /^TCK-/);
  assert.match(finished.run.steps.find((s) => s.stepId === "done")!.summary ?? "", /Ticket TCK-\d+ is open\./);

  // Telemetry captured the governed sfield tool executions too.
  const tele = await client.request<TelemetryView>("/api/admin/telemetry");
  assert.ok(tele.summary.totalToolCalls >= 2, `Expected tool calls in telemetry, got ${tele.summary.totalToolCalls}`);
});

test("generated portals and their bundled assets become available together after review", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-portal-review-"));
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: null, inspectorEnabled: true });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);
  const pending = await client.request<PublicationReview>("/api/admin/vertical-packs-generate", {
    prompt: "Build an insurance claims review portal.",
  }, 202);
  const { blueprint } = pending.approval.payload.candidate as {
    blueprint: { id: string; policyDoc: { id: string }; workflow: { id: string } };
  };
  const live = async () => {
    const [portals, knowledge, workflows] = await Promise.all([
      client.request<VerticalPacksView>("/api/admin/vertical-packs"),
      client.request<KnowledgeBaseView>("/api/admin/knowledge-base"),
      client.request<WorkflowsAdminView>("/api/workflows"),
    ]);
    return {
      portal: portals.packs.find(({ id }) => id === blueprint.id),
      policy: knowledge.documents.find(({ id }) => id === blueprint.policyDoc.id),
      workflow: workflows.definitions.find(({ id }) => id === blueprint.workflow.id),
    };
  };
  assert.deepEqual(await live(), { portal: undefined, policy: undefined, workflow: undefined });
  await client.request("/api/approvals/" + pending.approval.id + "/decide", { decision: "approve" });
  const { portal, policy, workflow } = await live();
  assert.equal(portal?.id, blueprint.id);
  assert.equal(policy?.id, blueprint.policyDoc.id);
  assert.equal(workflow?.id, blueprint.workflow.id);
});
