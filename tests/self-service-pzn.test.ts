import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SelfServicePznStore } from "../apps/server/self-service-pzn-store";
import { runSelfServicePznCopilot } from "../apps/server/self-service-pzn-copilot";
import { CustomerProfileStore, setActiveCustomerProfileStore } from "../packages/customer-profiles";
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
      body: "Set up an automatic monthly transfer to stay consistent through market cycles.",
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

    const { candidates, rejections } = resolveCandidates(tsRes.contentIds);
    assert.equal(rejections.length, 0);
    assert.equal(candidates.length, 1);
    const entry = lookupContent(candidates[0]);
    assert.equal(entry?.title, "Automate Monthly Investing");
  } finally {
    env.cleanup();
  }
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
      { message: "Create a Treasury Ladder offer for cash over $11,000, attach to context chat_treasury_nudge, and publish it" },
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
