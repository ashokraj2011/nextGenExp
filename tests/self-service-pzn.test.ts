import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SelfServicePznStore } from "../apps/server/self-service-pzn-store";
import { runSelfServicePznCopilot } from "../apps/server/self-service-pzn-copilot";
import { ApprovalStore } from "../apps/server/approval-store";
import { applyPznOperationDirect, pznGateFor, requestPznApproval, verifyPznApproval } from "../apps/server/pzn-approvals";
import { CustomerProfileStore, setActiveCustomerProfileStore } from "../packages/customer-profiles";
import { fundingPreviewWorkflow } from "../packages/contracts/funding-workflow";
import { FixtureTsAdapter } from "../packages/ts-adapter";
import { resolveCandidates, lookupContent } from "../packages/experience/content";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "cep-pzn-self-service-"));
  const profiles = new CustomerProfileStore(dir);
  setActiveCustomerProfileStore(profiles);
  const pzn = new SelfServicePznStore(dir);
  return {
    dir,
    profiles,
    pzn,
    cleanup() {
      pzn.close();
      setActiveCustomerProfileStore(null);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("Self-service Data Dictionary, Rule Engine, Draft/Publish isolation, and Live TS MID evaluation", async () => {
  const env = setup();
  try {
    // 1. Seeded Data Dictionary has namespaces & attributes with business definitions
    const ws = env.pzn.getWorkspaceState();
    assert.ok(ws.dictionary.namespaces.length >= 5);
    const portfolioNs = ws.dictionary.namespaces.find((n) => n.id === "portfolio");
    assert.ok(portfolioNs?.businessDefinition.length);
    assert.ok(portfolioNs?.attributes.some((a) => a.id === "cash_usd" && a.businessDefinition.includes("cash")));

    // 2. Define a custom namespace & custom attribute with business definition
    env.pzn.upsertNamespace({
      id: "loyalty",
      displayName: "Loyalty & Tier",
      businessDefinition: "Member loyalty tier and rewards eligibility attributes.",
      owner: "Growth Platform",
      sourceSystem: "custom_attribute",
    });
    env.pzn.upsertAttribute({
      id: "vip_tier",
      namespaceId: "loyalty",
      displayName: "VIP Loyalty Tier",
      businessDefinition: "Commercial VIP tier assigned to high-engagement accounts.",
      dataType: "enum",
      allowedOperators: ["eq", "ne", "in"],
      enumOptions: [
        { value: "gold", label: "Gold", definition: "Standard VIP tier" },
        { value: "platinum", label: "Platinum", definition: "Top advisory tier" },
      ],
      unit: "",
      sampleValue: "platinum",
      resolverPath: "customAttributes.vip_tier",
      piiClassification: "none",
    });

    // 3. Reject invalid rule referencing unknown Data Dictionary attribute
    assert.throws(() => {
      env.pzn.upsertRule({
        ruleId: "bad_rule",
        name: "Invalid attribute rule",
        businessDescription: "Should fail dictionary validation",
        effect: "include_when_true",
        status: "published",
        rootGroup: {
          id: "g1",
          kind: "group",
          combinator: "AND",
          children: [
            { id: "c1", kind: "clause", namespaceId: "loyalty", attributeId: "nonexistent_attr", operator: "eq", value: "gold" },
          ],
        },
      });
    }, /Unknown Data Dictionary attribute/);

    // 4. Create text contents + composable AND rule using both built-in portfolio.cash_usd and custom loyalty.vip_tier
    env.pzn.upsertContent({
      contentId: "vip_concierge_cash_text",
      title: "Platinum Cash Concierge",
      headline: "You hold {{portfolio.cash_usd}} in core cash as a {{loyalty.vip_tier}} member.",
      body: "Speak directly with our Cash Management desk to structure a custom treasury ladder.",
      ctaLabel: "Book Concierge Call",
      ctaPrompt: "Help me schedule a cash management concierge review.",
      disclosureText: "Available to Platinum members with > $10,000 cash.",
      tags: ["vip", "cash"],
      status: "published",
    });
    env.pzn.upsertContent({
      contentId: "general_savings_tip_text",
      title: "Automate Monthly Investing",
      headline: "Build wealth steadily with recurring transfers.",
      body: "Your cash balance is {{portfolio.cash_usd}}.",
      ctaLabel: "Set Up Auto-Invest",
      ctaPrompt: "Show me how to automate monthly investing.",
      disclosureText: "",
      tags: ["general"],
      status: "published",
    });

    env.pzn.upsertRule({
      ruleId: "platinum_high_cash_rule",
      name: "Platinum & Cash > $10,000",
      businessDescription: "Requires both Platinum loyalty tier and portfolio cash above $10,000.",
      effect: "include_when_true",
      status: "published",
      rootGroup: {
        id: "g_root",
        kind: "group",
        combinator: "AND",
        children: [
          { id: "c_cash", kind: "clause", namespaceId: "portfolio", attributeId: "cash_usd", operator: "gt", value: 10000 },
          { id: "c_tier", kind: "clause", namespaceId: "loyalty", attributeId: "vip_tier", operator: "eq", value: "platinum" },
        ],
      },
    });

    // 5. Define Context in Draft — Live TS must reject until Published!
    env.pzn.upsertContext({
      contextId: "vip-wealth-banner",
      displayName: "VIP Wealth Banner",
      description: "Serves Platinum Cash Concierge and general investing text offers.",
      channel: "all",
      contextRuleIds: [],
      attachments: [
        { contentId: "vip_concierge_cash_text", rank: 1, ruleIds: ["platinum_high_cash_rule"], ruleMatchMode: "all" },
        { contentId: "general_savings_tip_text", rank: 2, ruleIds: [], ruleMatchMode: "all" },
      ],
    });

    const alice = env.profiles.findByPersonaId("demo-learner")!;
    assert.throws(() => {
      env.pzn.evaluateLiveTs({ mid: alice.syntheticMid, contextId: "vip-wealth-banner" });
    }, /Draft/);

    // 6. Publish immutable v1 snapshot
    const pub = env.pzn.publishContext("vip-wealth-banner", "Test Operator", "v1 launch");
    assert.equal(pub.version, 1);

    // 7. Evaluate Live TS for Alice WITHOUT Platinum tier -> vip_concierge_cash_text filtered out, general stays eligible
    const evalWithoutTier = env.pzn.evaluateLiveTs({
      mid: alice.syntheticMid,
      contextId: "vip-wealth-banner",
    });
    assert.deepEqual(evalWithoutTier.experiencePayload.eligibleContentIds, ["general_savings_tip_text"]);
    assert.equal(evalWithoutTier.filteredOutContents.length, 1);
    assert.equal(evalWithoutTier.filteredOutContents[0].contentId, "vip_concierge_cash_text");
    assert.equal(evalWithoutTier.filteredOutContents[0].reasonCode, "RULE_FALSE");

    // 8. Evaluate Live TS for Alice WITH Platinum tier override -> BOTH contents eligible & text tokens interpolated!
    const evalWithPlatinum = env.pzn.evaluateLiveTs({
      mid: alice.syntheticMid,
      contextId: "vip-wealth-banner",
      attributeOverrides: { "loyalty.vip_tier": "platinum" },
    });
    assert.deepEqual(evalWithPlatinum.experiencePayload.eligibleContentIds, [
      "vip_concierge_cash_text",
      "general_savings_tip_text",
    ]);
    assert.ok(evalWithPlatinum.experiencePayload.cards[0].headline.includes("$12,500"));
    assert.ok(evalWithPlatinum.experiencePayload.cards[0].headline.includes("platinum"));

    // 9. Verify live FixtureTsAdapter + Experience Layer Catalog seamlessly resolve the newly published context & text content!
    const tsAdapter = new FixtureTsAdapter({ scenarioId: "normal", ordinal: 1 });
    const ctxCatalog = await tsAdapter.listContexts();
    assert.ok(ctxCatalog.contexts.some((c) => c.contextId === "vip-wealth-banner"));

    const tsRes = await tsAdapter.selectEligibleContent({ mid: alice.syntheticMid, context: "vip-wealth-banner" });
    assert.deepEqual(tsRes.contentIds, ["general_savings_tip_text"]);

    const jordan = env.profiles.findByPersonaId("demo-returning")!;
    const second = await tsAdapter.selectEligibleContent({ mid: jordan.syntheticMid, context: "vip-wealth-banner" });
    const { candidates, rejections } = resolveCandidates(tsRes.contentIds, tsRes.renderedEntries);
    assert.match(lookupContent(resolveCandidates(second.contentIds, second.renderedEntries).candidates[0])!.body, /\$10,000/);
    assert.match(lookupContent(candidates[0])!.body, /\$12,500/);
    assert.equal(rejections.length, 0);
    assert.equal(candidates.length, 1);
    const entry = lookupContent(candidates[0]);
    assert.equal(entry?.title, "Automate Monthly Investing");
  } finally {
    env.cleanup();
  }
});

test("the wealth topic keeps its published ID and shows the new name for existing data", async () => {
  const env = setup();
  const contextId = "wealth-next-best-offers";
  const oldName = "Wealth Next-Best Offers";
  const displayName = "Wealth Next-Best Recommendations";
  try {
    const db = new DatabaseSync(join(env.dir, "self-service-pzn.sqlite"));
    try {
      db.prepare("UPDATE pzn_contexts SET record = json_set(record, '$.displayName', ?) WHERE context_id = ?").run(oldName, contextId);
      db.prepare("UPDATE pzn_publications SET record = json_set(record, '$.context.displayName', ?) WHERE context_id = ?").run(oldName, contextId);
    } finally { db.close(); }
    assert.equal(env.pzn.listPublishedContextSummaries().find((c) => c.contextId === contextId)?.displayName, displayName);
    assert.equal(env.pzn.getPublishedPublication(contextId)?.context.displayName, oldName);
    assert.equal(env.pzn.evaluateLiveTs({ mid: "DEMO-MID-1003", contextId }).contextDisplayName, displayName);
    const { description, attachments } = env.pzn.getContext(contextId)!;
    env.pzn.upsertContext({ contextId, displayName: "My recommendations", description, attachments });
    assert.equal(env.pzn.getContext(contextId)?.displayName, "My recommendations");
    env.pzn.upsertContext({ contextId: "wealth", displayName: "Wealth", description, attachments });
    const turn = await runSelfServicePznCopilot({ message: "Test " + displayName + " for Marcus Reed", activeContextId: "wealth" }, env.pzn);
    assert.equal(turn.activeContextId, contextId);
    assert.ok(turn.cards.some((card) => card.kind === "ts_evaluation" && card.evaluation.contextId === contextId));
  } finally { env.cleanup(); }
});

test("published rule attachments reach TS only after publication and only for eligible members", async () => {
  const env = setup();
  try {
    const context = "wealth-next-best-offers";
    const target = "first_deposit_welcome_text";
    const { ruleId, name, effect, status, businessDescription, rootGroup } = env.pzn.getRule("unfunded_account_rule")!;
    const rule = { ruleId, name, effect, status, businessDescription, rootGroup };
    const workflow = fundingPreviewWorkflow.recommendation;
    const adapter = new FixtureTsAdapter({ scenarioId: "normal", ordinal: 1 });
    const request = { mid: env.profiles.findByPersonaId("demo-new-account")!.syntheticMid, context };
    const offered = async (mid = request.mid) => (await adapter.selectEligibleContent({ mid, context })).recommendations
      .recommendations.filter((r) => r.kind === "workflow");
    env.pzn.upsertRule({ ...rule, workflow });
    assert.deepEqual(await offered(), []);
    env.pzn.publishContext(context, "Test Operator");
    assert.deepEqual(await offered(), [{ ...workflow, forContentIds: [target] }]);
    assert.deepEqual(await offered(env.profiles.findByPersonaId("demo-returning")!.syntheticMid), []);
    const decision = await adapter.selectEligibleContent(request);
    assert.deepEqual(decision.workflowMatches, [{ name, contentId: target, workflow }]);
    assert.deepEqual(await adapter.getRankedEligibleIds(request), decision.contentIds);
    env.pzn.upsertRule({ ...rule, workflow: null });
    assert.equal((await offered()).length, 1);
    env.pzn.publishContext(context, "Test Operator");
    assert.deepEqual(await offered(), []);
  } finally { env.cleanup(); }
});

test("Self-service Copilot chat executes dictionary, authoring, publish, and live MID TS evaluation", async () => {
  const env = setup();
  try {
    // 1. Inspect Data Dictionary via chat
    const dictTurn = await runSelfServicePznCopilot(
      { message: "Show the Data Dictionary namespaces and business definitions" },
      env.pzn,
    );
    assert.ok(dictTurn.cards.some((c) => c.kind === "dictionary"));

    // 2. Create content + rule + context + publish in one chat turn
    const createTurn = await runSelfServicePznCopilot(
      { message: "Create a Treasury Ladder recommendation for cash over $11,000, attach to context chat_treasury_nudge, and publish it" },
      env.pzn,
    );
    assert.equal(createTurn.activeContextId, "chat_treasury_nudge");
    assert.ok(createTurn.actionsExecuted.some((a) => a.tool === "context.publish" && a.status === "ok"));
    assert.ok(createTurn.cards.some((c) => c.kind === "context" && c.context.status === "published"));

    // 3. Test live TS across Alice Morgan ($12,500 > $11,000 -> ELIGIBLE) and Jordan Lee ($10,000 <= $11,000 -> RULE_FALSE)
    const invokedRefs: string[] = [];
    const evalTurn = await runSelfServicePznCopilot(
      { message: "Test chat_treasury_nudge for Alice Morgan and Jordan Lee", activeContextId: "chat_treasury_nudge" },
      env.pzn,
      {
        executeSfieldTool: async <T>(toolRef: string, operation: string, payload?: unknown) => {
          invokedRefs.push(`${toolRef}:${operation}`);
          if (operation === "evaluate") {
            const data = env.pzn.evaluateLiveTs(payload as Parameters<SelfServicePznStore["evaluateLiveTs"]>[0]);
            return { data: data as T, summary: "evaluated via sfield", sfieldRunId: "run_test_ts_1", sfieldToolRef: toolRef };
          }
          throw new Error(`Unexpected tool ${toolRef}:${operation}`);
        },
      },
    );
    assert.deepEqual(invokedRefs, [
      "cep.pzn.treatment_selector@1.0.0:evaluate",
      "cep.pzn.treatment_selector@1.0.0:evaluate",
    ]);
    assert.equal(evalTurn.actionsExecuted[0].sfieldToolRef, "cep.pzn.treatment_selector@1.0.0");
    assert.equal(evalTurn.actionsExecuted[0].sfieldRunId, "run_test_ts_1");
    const tsCards = evalTurn.cards.filter((c) => c.kind === "ts_evaluation");
    assert.equal(tsCards.length, 2);
    assert.equal(tsCards[0].evaluation.eligibleContents.length, 1);
    assert.equal(tsCards[1].evaluation.eligibleContents.length, 0);
    assert.equal(tsCards[1].evaluation.filteredOutContents[0].reasonCode, "RULE_FALSE");
  } finally {
    env.cleanup();
  }
});

test("configurable approvals gate publish/destructive changes and enforce 4-eyes only when policy requires", async () => {
  const env = setup();
  try {
    const approvals = new ApprovalStore(env.dir);
    approvals.updatePolicy({ gatePznPublish: true, gatePznDestructive: true, gatePznDictionaryChanges: false, pznDualControl: "high_risk" });

    env.pzn.upsertContent({
      contentId: "appr_offer", title: "Approval Offer", headline: "", body: "Body", ctaLabel: "", ctaPrompt: "",
      disclosureText: "", tags: [], status: "published",
    });
    env.pzn.upsertContext({
      contextId: "appr_ctx", displayName: "Approval Ctx", description: "Gated context", channel: "all",
      contextRuleIds: [], attachments: [{ contentId: "appr_offer", rank: 1, ruleIds: [], ruleMatchMode: "all" }],
    });

    // Drafts and reads are never gated; dictionary edits are off by default.
    assert.equal(pznGateFor(approvals.getPolicy(), "upsert_context").gated, false);
    assert.equal(pznGateFor(approvals.getPolicy(), "upsert_attribute").gated, false);

    // 1. Copilot "publish" turns into a pending approval card instead of executing.
    const turn = await runSelfServicePznCopilot({ message: "Publish appr_ctx", activeContextId: "appr_ctx" }, env.pzn, {
      requestApproval: (operation, args) => (
        pznGateFor(approvals.getPolicy(), operation).gated
          ? requestPznApproval(approvals, env.pzn, { operation, args, requester: "Author A" })
          : null
      ),
    });
    assert.equal(env.pzn.getContext("appr_ctx")?.status, "draft");
    const card = turn.cards.find((c) => c.kind === "approval_request");
    assert.ok(card && card.kind === "approval_request");
    assert.ok(turn.actionsExecuted.some((a) => a.status === "pending"));
    assert.match(turn.reply, /Nothing has been published or deleted yet/);
    const publishApproval = card.approval;
    assert.equal(publishApproval.riskLevel, "medium");
    assert.equal(publishApproval.dualControl, false, "publish is medium risk, so high_risk mode allows self-approval");

    // 2. The sfield-boundary check refuses the gated op without an approved approval.
    assert.throws(() => verifyPznApproval(approvals, env.pzn, "publish_context", { contextId: "appr_ctx" }), /requires an approved/);
    assert.throws(
      () => verifyPznApproval(approvals, env.pzn, "publish_context", { ...(publishApproval.payload.args as object), approvalId: publishApproval.id }),
      /is pending/,
    );

    // 3. Self-approval is allowed here; then the approved change applies.
    assert.ok(approvals.decide(publishApproval.id, { decision: "approve", actor: "Author A" }).ok);
    // Approved is not enough: execution needs an atomic claim, so an approval runs at most once.
    assert.throws(
      () => verifyPznApproval(approvals, env.pzn, "publish_context", { ...(publishApproval.payload.args as object), approvalId: publishApproval.id }),
      /must be approved and claimed/,
    );
    assert.ok(approvals.claimForExecution(publishApproval.id).ok);
    assert.equal(approvals.claimForExecution(publishApproval.id).ok, false, "a second claim (double-click / second approver) is rejected");
    assert.equal(publishApproval.payload.toolRef, "cep.pzn.rule_metadata@1.0.0", "the approval is bound to the tool version");
    // Tampered args are rejected even with an approved id.
    assert.throws(
      () => verifyPznApproval(approvals, env.pzn, "publish_context", { contextId: "appr_ctx", notes: "tampered", approvalId: publishApproval.id }),
      /differs from what approval/,
    );
    const args = verifyPznApproval(approvals, env.pzn, "publish_context", { ...(publishApproval.payload.args as object), approvalId: publishApproval.id });
    applyPznOperationDirect(env.pzn, "publish_context", args);
    approvals.markExecuted(publishApproval.id, { summary: "published", sfieldRunId: "offline" });
    assert.equal(env.pzn.getContext("appr_ctx")?.status, "published");
    assert.throws(
      () => verifyPznApproval(approvals, env.pzn, "publish_context", { ...(publishApproval.payload.args as object), approvalId: publishApproval.id }),
      /is executed/,
      "an executed approval cannot be replayed",
    );

    // 4. Destructive change under high_risk mode requires a second approver.
    const unpublish = requestPznApproval(approvals, env.pzn, { operation: "unpublish_context", args: { contextId: "appr_ctx" }, requester: "Author A" });
    assert.equal(unpublish.riskLevel, "high");
    assert.equal(unpublish.dualControl, true);
    const selfApprove = approvals.decide(unpublish.id, { decision: "approve", actor: "Author A" });
    assert.equal(selfApprove.ok, false);
    assert.ok(approvals.decide(unpublish.id, { decision: "approve", actor: "Approver B" }).ok);
    assert.ok(approvals.claimForExecution(unpublish.id).ok);

    // 5. Staleness: if the context changes after the request, the approval no longer applies.
    env.pzn.upsertContext({
      contextId: "appr_ctx", displayName: "Approval Ctx (edited)", description: "Gated context", channel: "all",
      contextRuleIds: [], attachments: [{ contentId: "appr_offer", rank: 1, ruleIds: [], ruleMatchMode: "all" }],
    });
    assert.throws(() => verifyPznApproval(approvals, env.pzn, "unpublish_context", { contextId: "appr_ctx", approvalId: unpublish.id }), /changed after approval/);

    // 6. Policy is configurable: dual control off -> no second approver; gate off -> runs without approval.
    approvals.updatePolicy({ pznDualControl: "off" });
    assert.equal(requestPznApproval(approvals, env.pzn, { operation: "delete_context", args: { contextId: "appr_ctx" } }).dualControl, false);
    approvals.updatePolicy({ pznDualControl: "always" });
    assert.equal(requestPznApproval(approvals, env.pzn, { operation: "publish_context", args: { contextId: "appr_ctx" } }).dualControl, true);
    approvals.updatePolicy({ gatePznPublish: false });
    assert.deepEqual(verifyPznApproval(approvals, env.pzn, "publish_context", { contextId: "appr_ctx" }), { contextId: "appr_ctx" });
  } finally {
    env.cleanup();
  }
});
