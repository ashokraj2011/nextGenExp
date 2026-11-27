import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "./operator-fixture";
import { testClient, testProject } from "./client";
import { startFixtureGateway } from "./gateway-fixture";
import { signAsyncCallback } from "../apps/server/integration-resilience";
import type { IntegrationTasksView, TaskContract, TaskRun } from "../packages/contracts/integration-task";

function statusContract(integrationId: string) {
  return {
    integrationId,
    taskId: "check_change_status",
    version: "1.0.0",
    description: "Poll status of an async change request job.",
    effect: "read" as const,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobId"],
      properties: { jobId: { type: "string", minLength: 1, maxLength: 64 } },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobId", "status"],
      properties: {
        jobId: { type: "string" },
        status: { type: "string" },
        changeNumber: { type: "string" },
        approved: { type: "boolean" },
        error: { type: "string" },
      },
    },
    outcomeCodes: [{ code: "STATUS_OK", meaning: "Status checked", success: true }],
    outcomeMapping: [{ statusIn: [200], code: "STATUS_OK" }],
    approvalPolicy: { mode: "none" as const, when: [], dualControl: false, expiresInMinutes: 30 },
    idempotency: { supported: false },
    binding: { target: "itsm.check_change_status", method: "GET" as const },
  };
}

function asyncSubmitContract(integrationId: string) {
  return {
    integrationId,
    taskId: "submit_change_request",
    version: "1.0.0",
    description: "Submit a long-running change request (202 Accepted) completed via poll or signed callback.",
    effect: "write" as const,
    executionMode: "async" as const,
    asyncConfig: { statusTaskId: "check_change_status", jobIdPath: "jobId", pollIntervalMs: 1000 },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "idempotencyKey"],
      properties: {
        summary: { type: "string", minLength: 1, maxLength: 200 },
        idempotencyKey: { type: "string", minLength: 1, maxLength: 64 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobId", "status", "changeNumber", "approved"],
      properties: {
        jobId: { type: "string" },
        status: { type: "string" },
        changeNumber: { type: "string" },
        approved: { type: "boolean" },
      },
    },
    outcomeCodes: [{ code: "ACCEPTED", meaning: "Change request queued", success: true }],
    outcomeMapping: [{ statusIn: [202], code: "ACCEPTED" }],
    approvalPolicy: { mode: "none" as const, when: [], dualControl: false, expiresInMinutes: 30 },
    idempotency: { supported: true, keyField: "idempotencyKey" },
    manualReconcile: true,
    binding: { target: "itsm.submit_change_request", method: "POST" as const },
  };
}

test("3.3: Per-integration token-bucket rate limiter and circuit breaker (open -> half_open -> closed + reset)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-33-resilience-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, inspectorEnabled: true });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);

  // Configure tight rate limit (2 burst) and fast circuit breaker (2 failures -> 500ms reset) on itsm_sandbox.
  await client.publish("/api/integrations/integrations", {
    id: "itsm_sandbox",
    name: "ITSM Sandbox",
    description: "Rate-limited & circuit-protected ITSM.",
    transport: "sandbox",
    baseUrl: "",
    timeoutMs: 5000,
    enabled: true,
    rateLimit: { requestsPerMinute: 2, burst: 2 },
    circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 500 },
  });

  const runFind = () => client.request<{ run: TaskRun }>("/api/integrations/tasks/run", {
    toolRef: "int.itsm_sandbox.find_ticket@1.0.0",
    input: { idempotencyKey: "idem_rl_check" },
    requestedBy: "Author A",
  });

  // 1. Token bucket allows burst of 2, rejects 3rd with rate_limited.
  assert.equal((await runFind()).run.state, "succeeded");
  assert.equal((await runFind()).run.state, "succeeded");
  const limited = await runFind();
  assert.equal(limited.run.state, "failed");
  assert.equal(limited.run.error?.kind, "rate_limited");
  assert.equal(limited.run.error?.retryable, true);

  const view1 = await client.request<IntegrationTasksView>("/api/integrations");
  assert.equal(view1.resilience?.itsm_sandbox?.rejectedRateLimitCount, 1);

  // Operator resets resilience -> bucket restored, remove tight rate limit so we can test circuit breaker cleanly.
  await client.request("/api/integrations/resilience/reset", { integrationId: "itsm_sandbox" });
  await client.publish("/api/integrations/integrations", {
    id: "itsm_sandbox",
    name: "ITSM Sandbox",
    description: "Circuit-protected ITSM.",
    transport: "sandbox",
    baseUrl: "",
    timeoutMs: 5000,
    enabled: true,
    circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 500 },
  });

  // 2. Two consecutive 503 failures trip circuit breaker to OPEN.
  const fail1 = await client.request<{ run: TaskRun }>("/api/integrations/tasks/run", {
    toolRef: "int.itsm_sandbox.create_ticket@1.0.0",
    input: { title: "Outage [fail500] 1", priority: "P3", service: "api" },
    requestedBy: "Author A",
  });
  assert.equal(fail1.run.error?.kind, "upstream_5xx");

  const fail2 = await client.request<{ run: TaskRun }>("/api/integrations/tasks/run", {
    toolRef: "int.itsm_sandbox.create_ticket@1.0.0",
    input: { title: "Outage [fail500] 2", priority: "P3", service: "api" },
    requestedBy: "Author A",
  });
  assert.equal(fail2.run.error?.kind, "upstream_5xx");

  const viewOpen = await client.request<IntegrationTasksView>("/api/integrations");
  assert.equal(viewOpen.resilience?.itsm_sandbox?.circuitState, "open");

  // 3. While OPEN, even a healthy read call is short-circuited immediately with circuit_open.
  const blocked = await runFind();
  assert.equal(blocked.run.state, "failed");
  assert.equal(blocked.run.error?.kind, "circuit_open");

  // 4. After resetTimeoutMs (500ms), breaker moves to half_open and closes on first healthy probe.
  await new Promise((r) => setTimeout(r, 560));
  const probe = await runFind();
  assert.equal(probe.run.state, "succeeded");
  const viewClosed = await client.request<IntegrationTasksView>("/api/integrations");
  assert.equal(viewClosed.resilience?.itsm_sandbox?.circuitState, "closed");
  assert.equal(viewClosed.resilience?.itsm_sandbox?.consecutiveFailures, 0);
});

test("3.3: Async long-running tasks — 202 Accepted, status polling, and HMAC-SHA256 signed webhook callbacks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cep-33-async-"));
  const gateway = await startFixtureGateway();
  const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, inspectorEnabled: true });
  t.after(async () => { await app.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const client = await testClient(app.url);

  // Publish async status read task + async submit task on itsm_sandbox.
  const statusSaved = await client.request<{ contract: TaskContract }>("/api/integrations/contracts", statusContract("itsm_sandbox"));
  await client.publish("/api/integrations/contracts/publish", { ref: statusSaved.contract.ref });

  const submitSaved = await client.request<{ contract: TaskContract }>("/api/integrations/contracts", asyncSubmitContract("itsm_sandbox"));
  await client.publish("/api/integrations/contracts/publish", { ref: submitSaved.contract.ref });

  // Path A: Poll lifecycle (202 Accepted -> poll 1 in_progress -> poll 2 succeeded + schema validated).
  const started = await client.request<{ run: TaskRun }>("/api/integrations/tasks/run", {
    toolRef: submitSaved.contract.ref,
    input: { summary: "Upgrade core trading router" },
    requestedBy: "Author A",
  }, 202);
  assert.equal(started.run.state, "accepted");
  assert.match(started.run.externalJobId ?? "", /^job_/);
  assert.ok(started.run.callbackToken);

  const poll1 = await client.request<{ run: TaskRun; terminal: boolean }>("/api/integrations/runs/poll", { runId: started.run.runId });
  assert.equal(poll1.terminal, false);
  assert.equal(poll1.run.state, "accepted");
  assert.equal(poll1.run.pollAttempts, 1);

  const poll2 = await client.request<{ run: TaskRun; terminal: boolean }>("/api/integrations/runs/poll", { runId: started.run.runId });
  assert.equal(poll2.terminal, true);
  assert.equal(poll2.run.state, "succeeded");
  assert.equal(poll2.run.outcome?.code, "ASYNC_COMPLETED");
  assert.equal((poll2.run.output as { approved?: boolean })?.approved, true);

  // Path B: Signed HMAC-SHA256 webhook callback (no operator auth; rejects invalid signature with 401).
  const started2 = await client.request<{ run: TaskRun }>("/api/integrations/tasks/run", {
    toolRef: submitSaved.contract.ref,
    input: { summary: "Settlement wire batch #42" },
    requestedBy: "Author A",
  }, 202);
  assert.equal(started2.run.state, "accepted");

  const callbackBody = JSON.stringify({
    status: "succeeded",
    output: { jobId: started2.run.externalJobId, status: "completed", changeNumber: "CHG-9901", approved: true },
  });

  // Forged signature -> 401
  const badRes = await fetch(`${app.url}/api/integrations/callbacks/${started2.run.runId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CEP-Signature": "sha256=deadbeef" },
    body: callbackBody,
  });
  assert.equal(badRes.status, 401);

  // Valid HMAC-SHA256 signature -> 200 and run transitions to succeeded
  const sig = signAsyncCallback(callbackBody, started2.run.callbackToken!);
  const okRes = await fetch(`${app.url}/api/integrations/callbacks/${started2.run.runId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CEP-Signature": sig },
    body: callbackBody,
  });
  assert.equal(okRes.status, 200, await okRes.clone().text());
  const okData = (await okRes.json()) as { run: TaskRun };
  assert.equal(okData.run.state, "succeeded");
  assert.equal(okData.run.outcome?.code, "ASYNC_CALLBACK_COMPLETED");
  assert.equal((okData.run.output as { changeNumber?: string })?.changeNumber, "CHG-9901");
});
