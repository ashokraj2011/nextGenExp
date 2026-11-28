import assert from "node:assert/strict";
import test from "node:test";
import { SField, createPrincipal } from "@sfield/core";

test("@sfield/core sf.context hydrates Principal, tenant/domain flow overrides, ChatHarness history, rolling summary, and gated resources", async () => {
  const sf = await SField.create({
    config: { version: 1, models: {}, agents: {} },
    preset: "memory",
    quiet: true,
  });

  try {
    // 1. Register baseline flows and tenant/domain overrides
    sf.context
      .registerFlows([
        { id: "verified_experience", label: "Verified experience", domain: "wealth" },
        { id: "ops_incident", label: "IT Ops incident", domain: "it_ops" },
        { id: "external_connector", label: "External connector", domain: "platform" },
        { id: "admin_audit", label: "Admin audit", domain: "platform", operatorOnly: true },
      ])
      .setFlowOverrides("tenant-a", "tenant", {
        external_connector: { enabled: false },
      })
      .setFlowOverrides("tenant-a", "it_ops", {
        // Domain override CANNOT escalate a tenant-disabled flow
        external_connector: { enabled: true },
      });

    const alice = createPrincipal({
      tenantId: "tenant-a",
      subjectId: "alice",
      roles: ["customer"],
      identifiers: { mid: "MID-ALICE-001" },
    });

    // 2. Seed durable ChatHarness messages and a persisted rolling compaction summary
    const chatScope = {
      tenantId: "tenant-a",
      domainId: "wealth",
      userId: "alice",
      sessionId: "sess-1",
      threadId: "conv-1",
    };
    const thread = await sf.chat.open(chatScope);
    await thread.append({ id: "m1", role: "user", text: "Show my $120,000 home goal." });
    await thread.append({ id: "m2", role: "assistant", text: "Your down payment goal is $120,000." });

    await sf.compactor.compactIfNeeded({
      principal: alice,
      conversationId: "conv-1",
      force: true,
      verbatimWindow: 1,
      turns: [
        { ordinal: 1, turnId: "t1", userMessage: "Show my $120,000 home goal.", assistantReply: "Target is $120,000." },
        { ordinal: 2, turnId: "t2", userMessage: "I prefer bar charts.", assistantReply: "Noted bar chart preference." },
      ],
    });

    const mockOpsStore = { kind: "ops" };
    const mockConnectorStore = { kind: "connector" };
    const mockKb = { kind: "kb" };
    const mockWealthStore = { kind: "wealth" };

    // 3. Hydrate a customer turn in Wealth
    const wealthCtx = await sf.context.hydrateTurn({
      principal: alice,
      domainId: "wealth",
      chatScope,
      conversationId: "conv-1",
      resources: {
        wealthStore: { value: mockWealthStore, requiredFlows: ["verified_experience"], allowedDomains: ["wealth"] },
        opsStore: { value: mockOpsStore, requiredFlows: ["ops_incident"] },
        connectorStore: { value: mockConnectorStore, requiredFlows: ["external_connector"] },
        knowledgeBase: { value: mockKb, requiredFlows: ["verified_experience"], requireOperator: true },
      },
    });

    assert.equal(wealthCtx.tenantId, "tenant-a");
    assert.equal(wealthCtx.domainId, "wealth");
    assert.equal(wealthCtx.isOperator, false);
    assert.equal(wealthCtx.principal.identifiers?.mid, "MID-ALICE-001");
    assert.equal(wealthCtx.allows("verified_experience"), true);
    assert.equal(wealthCtx.allows("ops_incident"), false);
    assert.equal(wealthCtx.allows("external_connector"), false);
    assert.equal(wealthCtx.allows("admin_audit"), false);
    assert.equal(wealthCtx.messages.length, 2);
    assert.ok(wealthCtx.rollingSummary);
    assert.match(wealthCtx.rollingSummaryText ?? "", /120,000/);

    // Verify capability-scoped resource gating + denied audit trail
    assert.equal(wealthCtx.resources.wealthStore, mockWealthStore);
    assert.equal(wealthCtx.resources.opsStore, undefined);
    assert.equal(wealthCtx.resources.connectorStore, undefined);
    assert.equal(wealthCtx.resources.knowledgeBase, undefined);
    assert.deepEqual(
      wealthCtx.deniedResources.map((d) => d.key).sort(),
      ["connectorStore", "knowledgeBase", "opsStore"],
    );

    // 4. Hydrate an operator turn in IT Ops (external_connector remains blocked by tenant default!)
    const opsCtx = await sf.context.hydrateTurn({
      principal: { tenantId: "tenant-a", subjectId: "sre-1", roles: ["operator"] },
      domainId: "it_ops",
      resources: {
        opsStore: { value: mockOpsStore, requiredFlows: ["ops_incident"] },
        connectorStore: { value: mockConnectorStore, requiredFlows: ["external_connector"] },
        auditTools: { value: { kind: "audit" }, requiredFlows: ["admin_audit"], requireOperator: true },
      },
    });

    assert.equal(opsCtx.isOperator, true);
    assert.equal(opsCtx.allows("ops_incident"), true);
    assert.equal(opsCtx.allows("admin_audit"), true);
    assert.equal(opsCtx.allows("external_connector"), false);
    assert.equal(opsCtx.resources.opsStore, mockOpsStore);
    assert.equal(opsCtx.resources.auditTools?.kind, "audit");
    assert.equal(opsCtx.resources.connectorStore, undefined);
  } finally {
    await sf.close();
  }
});
