import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPrincipal, SField } from "@sfield/core";
import { startStudioServer } from "@sfield/studio";
import { startApp } from "../apps/server/http";

test("@sfield/core sf.commands isolates slash commands per tenant, filters by domain & role, and supports Studio CRUD", async () => {
  const sf = await SField.create({
    config: { version: 1, models: {}, agents: {} },
    preset: "memory",
  });

  try {
    sf.commands.registerDefaults([
      { command: "/help", label: "Help", hint: "General help", action: "prompt", prompt: "Help me" },
      { command: "/portfolio", label: "Portfolio", hint: "Wealth portfolio", action: "prompt", prompt: "Show portfolio", domain: "wealth" },
    ]);

    // Tenant A adds a custom IT Ops command and removes /portfolio
    sf.commands.upsert("tenant-a", {
      command: "/triage",
      label: "P1 Triage",
      hint: "Triage active outage",
      action: "prompt",
      prompt: "Show active P1 incidents",
      domain: "it_ops",
      roles: ["sre"],
    });
    sf.commands.remove("tenant-a", "/portfolio");

    // Tenant B still sees defaults (strict tenant isolation)
    const tenantBList = sf.commands.list({ tenantId: "tenant-b" });
    assert.deepEqual(tenantBList.map((c) => c.command), ["/help", "/portfolio"]);

    // Tenant A sees /triage only for callers with role "sre"
    const srePrincipal = createPrincipal({ tenantId: "tenant-a", subjectId: "oncall", roles: ["sre"] });
    const viewerPrincipal = createPrincipal({ tenantId: "tenant-a", subjectId: "guest", roles: ["viewer"] });
    assert.deepEqual(
      sf.commands.list({ tenantId: "tenant-a", domain: "it_ops", principal: srePrincipal }).map((c) => c.command),
      ["/help", "/triage"],
    );
    assert.deepEqual(
      sf.commands.list({ tenantId: "tenant-a", domain: "it_ops", principal: viewerPrincipal }).map((c) => c.command),
      ["/help"],
    );

    // Studio /api/commands CRUD
    const studio = await startStudioServer({ runtime: sf, port: 0 });
    try {
      const addRes = await fetch(`${studio.url}/api/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: "tenant-c",
          command: "/dealdesk",
          label: "Deal Desk",
          hint: "Review enterprise discounts",
          action: "prompt",
          prompt: "Show pending enterprise deal approvals.",
          domain: "sales_revops",
        }),
      });
      assert.equal(addRes.status, 201);
      const listRes = await (await fetch(`${studio.url}/api/commands?tenantId=tenant-c&domain=sales_revops`)).json() as {
        commands: Array<{ command: string }>;
      };
      assert.ok(listRes.commands.some((c) => c.command === "/dealdesk"));
    } finally {
      await studio.close();
    }
  } finally {
    await sf.close();
  }
});

test("CEP /api/slash-commands serves and persists tenant-configured slash commands across requests", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cep-slash-cmds-"));
  const app = await startApp({
    dataDir,
    projectRoot: process.cwd(),
    gateway: null,
    port: 0,
    operatorAuth: "off",
    startScheduledJobs: false,
  });
  try {
    // 1. Default wealth commands returned
    const initRes = await fetch(`${app.url}/api/slash-commands?domain=wealth`);
    assert.equal(initRes.status, 200);
    const initData = await initRes.json() as { commands: Array<{ command: string }> };
    assert.ok(initData.commands.some((c) => c.command === "/portfolio"));

    // 2. Operator adds a custom tenant slash command
    const addRes = await fetch(`${app.url}/api/slash-commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "/taxharvest",
        label: "Tax-Loss Harvest",
        hint: "Run tax-loss harvesting scan",
        action: "prompt",
        prompt: "Analyze my portfolio for tax-loss harvesting opportunities.",
        domain: "wealth",
      }),
    });
    assert.equal(addRes.status, 201);

    // 3. Chat composer endpoint immediately surfaces /taxharvest for this tenant
    const updatedRes = await fetch(`${app.url}/api/slash-commands?domain=wealth`);
    const updatedData = await updatedRes.json() as { commands: Array<{ command: string }> };
    assert.ok(updatedData.commands.some((c) => c.command === "/taxharvest"));

    // 4. Operator removes /taxharvest
    const delRes = await fetch(`${app.url}/api/slash-commands/taxharvest`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
    const afterDel = await (await fetch(`${app.url}/api/slash-commands?domain=wealth`)).json() as {
      commands: Array<{ command: string }>;
    };
    assert.equal(afterDel.commands.some((c) => c.command === "/taxharvest"), false);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
