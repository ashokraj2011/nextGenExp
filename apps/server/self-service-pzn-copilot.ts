import {
  pznSfieldToolRefs,
  recommendationContextLabel,
  wealthRecommendationsTopic,
  type PznAttribute,
  type PznContext,
  type PznContextPublication,
  type PznCopilotActionLog,
  type PznCopilotCard,
  type PznCopilotRequest,
  type PznCopilotResponse,
  type PznDataDictionary,
  type PznDataType,
  type PznNamespace,
  type PznOperator,
  type PznRule,
  type PznRuleValue,
  type PznStudioWorkspaceState,
  type PznTextContent,
  type PznTsEvaluationResult,
} from "../../packages/contracts/self-service-pzn";

export type PznSfieldToolExecutor = <T = unknown>(
  toolRef: string,
  operation: string,
  payload?: unknown,
) => Promise<{ data: T; summary: string; sfieldRunId: string; sfieldToolRef: string }>;
import { callConfiguredLlmJson } from "./dynamic-ui-generator";
import type { GatewaySettings } from "./gateway";
import type { SelfServicePznStore } from "./self-service-pzn-store";
import type { ApprovalRecord } from "../../packages/contracts/approval";

type PlannedOp =
  | {
      op: "upsert_namespace";
      id: string;
      displayName: string;
      businessDefinition: string;
      owner?: string;
      sourceSystem?: "customer_360" | "portfolio_snapshot" | "goal_progress" | "session_context" | "custom_attribute";
    }
  | {
      op: "upsert_attribute";
      namespaceId: string;
      id: string;
      displayName: string;
      businessDefinition: string;
      dataType: PznDataType;
      allowedOperators?: PznOperator[];
      enumOptions?: { value: string; label: string; definition?: string }[];
      unit?: string;
      sampleValue?: string;
      resolverPath?: string;
      piiClassification?: "none" | "internal" | "pii";
    }
  | {
      op: "upsert_content";
      contentId: string;
      title: string;
      headline?: string;
      body: string;
      ctaLabel?: string;
      ctaPrompt?: string;
      disclosureText?: string;
      tags?: string[];
      status?: "draft" | "published" | "archived";
    }
  | {
      op: "upsert_rule";
      ruleId: string;
      name: string;
      businessDescription: string;
      effect?: "include_when_true" | "exclude_when_true";
      combinator?: "AND" | "OR";
      clauses: {
        namespaceId: string;
        attributeId: string;
        operator: PznOperator;
        value?: PznRuleValue;
      }[];
    }
  | {
      op: "upsert_context";
      contextId: string;
      displayName: string;
      description: string;
      channel?: "chat" | "web" | "mobile" | "all";
      contextRuleIds?: string[];
      attachments: {
        contentId: string;
        rank?: number;
        ruleIds?: string[];
        ruleMatchMode?: "all" | "any";
      }[];
    }
  | { op: "publish_context"; contextId: string; notes?: string }
  | { op: "unpublish_context"; contextId: string }
  | {
      op: "evaluate_ts";
      contextId: string;
      mids: string[];
      useDraft?: boolean;
      attributeOverrides?: Record<string, PznRuleValue>;
    }
  | { op: "show_dictionary"; namespaceId?: string }
  | { op: "show_catalog" }
  | { op: "show_rule_builder"; initialNamespaceId?: string; initialAttributeId?: string }
  | { op: "show_rules" }
  | { op: "show_context_matrix" }
  | { op: "show_approvals" };

interface LlmCopilotPlan {
  reply?: string;
  operations?: PlannedOp[];
  suggestedPrompts?: string[];
}

function slug(raw: string, fallback = "item_1"): string {
  const s = raw.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+/g, "_");
  return s.slice(0, 56) || fallback;
}

function defaultOpsForType(dt: PznDataType): PznOperator[] {
  if (dt === "enum") return ["eq", "ne", "in", "not_in"];
  if (dt === "boolean") return ["eq", "ne"];
  if (dt === "number" || dt === "currency_usd") return ["eq", "ne", "gt", "gte", "lt", "lte"];
  return ["eq", "ne", "contains", "in", "not_in", "exists"];
}

function buildSystemPrompt(ws: PznStudioWorkspaceState, activeContextId?: string): string {
  const dictSummary = ws.dictionary.namespaces.map((ns) => ({
    namespace: ns.id,
    displayName: ns.displayName,
    businessDefinition: ns.businessDefinition,
    attributes: ns.attributes.map((a) => ({
      key: `${ns.id}.${a.id}`,
      displayName: a.displayName,
      businessDefinition: a.businessDefinition,
      dataType: a.dataType,
      allowedOperators: a.allowedOperators,
      ...(a.enumOptions.length ? { enumOptions: a.enumOptions.map((o) => o.value) } : {}),
    })),
  }));

  const ctxSummary = ws.contexts.map((c) => ({
    contextId: c.contextId,
    displayName: c.displayName,
    status: c.status,
    publishedVersion: c.publishedVersion,
    attachments: c.attachments,
  }));

  const contentSummary = ws.contents.map((c) => ({ contentId: c.contentId, title: c.title, status: c.status }));
  const ruleSummary = ws.rules.map((r) => ({ ruleId: r.ruleId, name: r.name, effect: r.effect }));
  const customers = ws.customers.map((c) => ({ displayName: c.displayName, mid: c.syntheticMid, segment: c.segment }));

  return `You are the CEP Recommendation Self-Service Copilot.
Users configure the ENTIRE Recommendation Self-Service Platform by chatting with you:
1. Define Data Dictionary namespaces & attributes (with business definitions).
2. Author Text Contents (title, headline, body with optional {{namespace.attribute}} tokens, CTA, disclosure).
3. Author Rules strictly using valid Data Dictionary attributes & allowed operators.
4. Create Contexts, attach ranked Text Contents and Rules, and Publish immutable snapshots to Treatment Selector.
5. Run Live Treatment Selector evaluations for Customer MIDs (including what-if attribute overrides) to inspect Rule Engine verdicts and Experience Layer outputs.

CURRENT WORKSPACE STATE:
- Active Context ID: ${activeContextId ?? ws.contexts[0]?.contextId ?? "none"}
- Data Dictionary: ${JSON.stringify(dictSummary)}
- Customers (MIDs): ${JSON.stringify(customers)}
- Contexts: ${JSON.stringify(ctxSummary)}
- Text Contents: ${JSON.stringify(contentSummary)}
- Rules: ${JSON.stringify(ruleSummary)}

RETURN STRICT JSON ONLY:
{
  "reply": "Concise, helpful explanation of what you created, published, or evaluated.",
  "operations": [
    // Zero or more ordered operations from:
    // { "op": "upsert_namespace", "id": "slug", "displayName": "...", "businessDefinition": "...", "owner": "...", "sourceSystem": "custom_attribute" }
    // { "op": "upsert_attribute", "namespaceId": "slug", "id": "slug", "displayName": "...", "businessDefinition": "...", "dataType": "enum|boolean|number|currency_usd|string|string_list", "allowedOperators": [...], "enumOptions": [{"value":"...","label":"...","definition":"..."}], "unit": "...", "sampleValue": "...", "resolverPath": "customAttributes.<id>" }
    // { "op": "upsert_content", "contentId": "slug", "title": "...", "headline": "...", "body": "...", "ctaLabel": "...", "ctaPrompt": "...", "disclosureText": "...", "tags": ["..."] }
    // { "op": "upsert_rule", "ruleId": "slug", "name": "...", "businessDescription": "...", "effect": "include_when_true|exclude_when_true", "combinator": "AND|OR", "clauses": [{"namespaceId":"...","attributeId":"...","operator":"eq|ne|gt|gte|lt|lte|in|not_in|contains|exists","value":...}] }
    // { "op": "upsert_context", "contextId": "slug", "displayName": "...", "description": "...", "channel": "all|chat|web|mobile", "contextRuleIds": [], "attachments": [{"contentId":"slug","rank":1,"ruleIds":["slug"],"ruleMatchMode":"all|any"}] }
    // { "op": "publish_context", "contextId": "slug", "notes": "..." }
    // { "op": "unpublish_context", "contextId": "slug" }
    // { "op": "evaluate_ts", "contextId": "slug", "mids": ["DEMO-MID-1001"], "useDraft": false, "attributeOverrides": {"portfolio.cash_usd": 5000} }
    // { "op": "show_dictionary", "namespaceId": "optional_ns" }
    // { "op": "show_catalog" }
    // { "op": "show_rule_builder", "initialNamespaceId": "portfolio", "initialAttributeId": "cash_usd" }
    // { "op": "show_rules" }
    // { "op": "show_context_matrix" }
    // { "op": "show_approvals" }
  ],
  "suggestedPrompts": ["2 to 4 concise follow-up prompts the user can click next"]
}

RULES:
- Every ID (namespace, attribute, contentId, ruleId, contextId) MUST be lowercase slug matching ^[a-z][a-z0-9_-]*$.
- Call the items returned by Treatment Selector recommendations in replies and suggested prompts. Use the published IDs in tool inputs.
- When creating a complete recommendation flow (content + rule + context), emit operations in dependency order: upsert_namespace -> upsert_attribute -> upsert_content -> upsert_rule -> upsert_context -> (optional publish_context) -> (optional evaluate_ts).
- If the user asks to test/simulate for multiple customers (e.g. "Alice and Jordan" or "all customers"), include all requested MIDs in evaluate_ts.mids.
- Always use exact existing Data Dictionary keys & allowedOperators unless you also emit upsert_attribute first.`;
}

function deterministicPlan(message: string, ws: PznStudioWorkspaceState, activeContextId?: string): LlmCopilotPlan {
  const lower = message.toLowerCase();
  const namesWealthTopic = lower.includes(wealthRecommendationsTopic.displayName.toLowerCase()) || lower.includes(wealthRecommendationsTopic.contextId);
  const wealthTopic = namesWealthTopic ? ws.contexts.find((c) => c.contextId === wealthRecommendationsTopic.contextId) : undefined;
  const target = wealthTopic ?? ws.contexts.find((c) => lower.includes(c.contextId.toLowerCase()) || lower.includes(c.displayName.toLowerCase()));
  const targetCtxId = target?.contextId ?? activeContextId ?? ws.contexts[0]?.contextId ?? wealthRecommendationsTopic.contextId;

  const targetLabel = recommendationContextLabel(targetCtxId);

  // 0. Explicit interactive widget requests (define rule widget, show rules, show context matrix)
  if (/(pending approvals?|approval queue|approval policy|approvals?\b.*(show|list|review)|(show|list|review).*approvals?)/i.test(lower)) {
    return {
      reply: "Here is the **Approval Queue** for recommendation changes, with the configurable approval policy (which changes need approval and when a second approver is required).",
      operations: [{ op: "show_approvals" }],
      suggestedPrompts: [
        "Show all contexts with attached contents and rules",
        `Test ${targetLabel} for Alice Morgan and Jordan Lee`,
        "Open the interactive rule builder widget",
      ],
    };
  }
  if (/^\s*(open|show|launch)?\s*(the\s+)?(rule builder|define a rule|create a rule|new rule widget)\s*$/i.test(lower)
    || /(open|launch|show)\s+(me\s+)?(the\s+)?(interactive\s+)?rule\s*(builder|widget|editor)/i.test(lower)) {
    return {
      reply: "Opened the **Interactive Rule Builder Widget** below — pick any Data Dictionary namespace & attribute (with inline business definitions), test live against a Customer MID, and save directly.",
      operations: [{ op: "show_rule_builder", initialNamespaceId: "portfolio", initialAttributeId: "cash_usd" }],
      suggestedPrompts: [
        "Show all rules and their Data Dictionary clauses",
        "Show all contexts with attached contents and rules",
        `Test ${targetLabel} for Alice Morgan and Jordan Lee`,
      ],
    };
  }
  if (/(show|list|view)\s+(all\s+)?(my\s+)?rules\b/i.test(lower) && !/(context|attach)/i.test(lower)) {
    return {
      reply: `Here are all **${ws.rules.length} governed rules** in the catalog with their Data Dictionary clauses and business definitions.`,
      operations: [{ op: "show_rules" }],
      suggestedPrompts: [
        "Open the interactive rule builder widget",
        "Show all contexts with attached contents and rules",
        `Test ${targetLabel} for Alice Morgan and Jordan Lee`,
      ],
    };
  }
  if (/(show|list|view)\s+(all\s+)?(my\s+)?contexts?\b/i.test(lower) || /attached\s+contents?/i.test(lower)) {
    return {
      reply: `Here is the **Contexts, Attached Contents & Rules Matrix** showing every placement, its publication version, attached text contents, and attached filtering rules.`,
      operations: [{ op: "show_context_matrix" }],
      suggestedPrompts: [
        "Open the interactive rule builder widget",
        `Test ${targetLabel} for Alice Morgan and Jordan Lee`,
        "Create a Treasury Ladder recommendation for cash > $20,000, attach to context treasury_nudge, and publish it",
      ],
    };
  }

  // 1. Dictionary inspection
  if (/(data dictionary|dictionary|namespaces?|attributes?|business def)/i.test(lower) && !/(create|add|new|define)\s+(a\s+)?(namespace|attribute)/i.test(lower)) {
    const matchedNs = ws.dictionary.namespaces.find((ns) => lower.includes(ns.id) || lower.includes(ns.displayName.toLowerCase()));
    return {
      reply: matchedNs
        ? `Here is the **${matchedNs.displayName}** (\`${matchedNs.id}\`) namespace from the Data Dictionary with business definitions, owners, and live resolvers.`
        : `Here is the governed **Data Dictionary** (${ws.dictionary.namespaces.length} namespaces, ${ws.dictionary.namespaces.reduce((a, n) => a + n.attributes.length, 0)} attributes) with business definitions and Customer 360 resolver paths.`,
      operations: [{ op: "show_dictionary", ...(matchedNs ? { namespaceId: matchedNs.id } : {}) }],
      suggestedPrompts: [
        "Add a custom attribute loyalty.vip_tier (gold/platinum) to the Data Dictionary",
        `Run Live Treatment Selector on ${targetLabel} for Alice Morgan and Jordan Lee`,
        "Create a high-cash treasury recommendation, rule for cash > $20,000, attach to a new context, and publish it",
      ],
    };
  }

  // 2. Add namespace / attribute
  if (/(create|add|new|define)\s+(a\s+)?(custom\s+)?(namespace|attribute|field)/i.test(lower)) {
    const dotMatch = message.match(/([a-z][a-z0-9_-]*)\.([a-z][a-z0-9_-]*)/i);
    const nsId = dotMatch ? slug(dotMatch[1], "loyalty") : (lower.includes("loyalty") ? "loyalty" : "customer");
    const attrId = dotMatch ? slug(dotMatch[2], "vip_tier") : (lower.includes("vip") || lower.includes("tier") ? "vip_tier" : slug(message.slice(0, 24), "custom_attr"));
    const ops: PlannedOp[] = [];
    if (!ws.dictionary.namespaces.some((n) => n.id === nsId)) {
      ops.push({
        op: "upsert_namespace",
        id: nsId,
        displayName: nsId.charAt(0).toUpperCase() + nsId.slice(1),
        businessDefinition: `Self-service business namespace for ${nsId} eligibility attributes.`,
        owner: "Personalization Team",
        sourceSystem: "custom_attribute",
      });
    }
    const isEnum = /(gold|platinum|silver|tier|enum|status)/i.test(lower);
    const isNum = /(\$|usd|amount|score|age|balance|pct|percent)/i.test(lower);
    const dataType: PznDataType = isEnum ? "enum" : isNum ? "number" : "string";
    ops.push({
      op: "upsert_attribute",
      namespaceId: nsId,
      id: attrId,
      displayName: attrId.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      businessDefinition: `Business attribute "${nsId}.${attrId}" created from self-service chat for rule eligibility evaluation.`,
      dataType,
      allowedOperators: defaultOpsForType(dataType),
      enumOptions: isEnum
        ? [
            { value: "gold", label: "Gold", definition: "Standard loyalty tier" },
            { value: "platinum", label: "Platinum", definition: "Top advisory VIP tier" },
          ]
        : [],
      sampleValue: isEnum ? "platinum" : isNum ? "100" : "active",
      resolverPath: `customAttributes.${attrId}`,
    });
    ops.push({ op: "show_dictionary", namespaceId: nsId });
    return {
      reply: `Added **\`${nsId}.${attrId}\`** to the governed Data Dictionary with its business definition and Customer 360 resolver path.`,
      operations: ops,
      suggestedPrompts: [
        `Create a rule using ${nsId}.${attrId}`,
        "Show the full Data Dictionary",
        `Run Live Treatment Selector on ${targetLabel} for Alice Morgan`,
      ],
    };
  }

  // 3. Publish / Unpublish explicit request
  if (/^\s*(publish|unpublish)\b/i.test(lower)) {
    const isUnpublish = /^\s*unpublish\b/i.test(lower);
    return {
      reply: isUnpublish
        ? `Unpublished **\`${targetLabel}\`** from Treatment Selector.`
        : `Published an immutable snapshot of **\`${targetLabel}\`** to Treatment Selector.`,
      operations: [
        isUnpublish
          ? { op: "unpublish_context", contextId: targetCtxId }
          : { op: "publish_context", contextId: targetCtxId, notes: "Published via Self-Service Copilot" },
      ],
      suggestedPrompts: [
        `Test ${targetLabel} for Alice Morgan and Jordan Lee`,
        `Simulate ${targetLabel} for Alice Morgan with portfolio.cash_usd = 5000`,
        "Show all contexts in the catalog",
      ],
    };
  }

  // 4. Live TS Evaluation / Test / Simulate for MIDs
  if (/(test|run|evaluate|simulate|check|what-if|compare|live ts|treatment selector)/i.test(lower)) {
    const mids: string[] = [];
    for (const c of ws.customers) {
      const firstName = c.displayName.split(" ")[0].toLowerCase();
      if (lower.includes(firstName) || lower.includes(c.syntheticMid.toLowerCase()) || lower.includes(c.displayName.toLowerCase())) {
        mids.push(c.syntheticMid);
      }
    }
    const midRegex = message.match(/DEMO-MID-\d+/gi);
    if (midRegex) {
      for (const m of midRegex) {
        if (!mids.includes(m.toUpperCase())) mids.push(m.toUpperCase());
      }
    }
    if (mids.length === 0) {
      if (/(all|compare|both|everyone)/i.test(lower)) {
        mids.push(...ws.customers.slice(0, 3).map((c) => c.syntheticMid));
      } else {
        mids.push(ws.customers[0]?.syntheticMid ?? "DEMO-MID-1001");
      }
    }

    const overrides: Record<string, PznRuleValue> = {};
    const cashOverrideMatch = message.match(/(?:cash(?:_usd)?\s*(?:=|is|to|at)\s*\$?\s*([\d,]+(?:\.\d+)?))/i);
    if (cashOverrideMatch) {
      const num = Number(cashOverrideMatch[1].replace(/,/g, ""));
      if (Number.isFinite(num)) overrides["portfolio.cash_usd"] = num;
    }
    const customOverrideMatch = message.match(/([a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*)\s*=\s*([a-zA-Z0-9_.-]+)/);
    if (customOverrideMatch) {
      const valRaw = customOverrideMatch[2];
      const num = Number(valRaw);
      overrides[customOverrideMatch[1]] = valRaw === "true" ? true : valRaw === "false" ? false : (Number.isFinite(num) && valRaw !== "" ? num : valRaw);
    }

    const ctxObj = ws.contexts.find((c) => c.contextId === targetCtxId);
    const useDraft = ctxObj ? ctxObj.status !== "published" : false;
    return {
      reply: `Executed **Live Treatment Selector** for **\`${targetLabel}\`** across ${mids.length} customer MID${mids.length > 1 ? "s" : ""}${Object.keys(overrides).length ? ` (with what-if override ${Object.entries(overrides).map(([k, v]) => `\`${k} = ${v}\``).join(", ")})` : ""}.`,
      operations: [{
        op: "evaluate_ts",
        contextId: targetCtxId,
        mids,
        useDraft,
        ...(Object.keys(overrides).length ? { attributeOverrides: overrides } : {}),
      }],
      suggestedPrompts: [
        `Compare ${targetLabel} across Alice Morgan, Jordan Lee, and Marcus Reed`,
        `Simulate ${targetLabel} for Alice Morgan with portfolio.cash_usd = 5000`,
        "Show the Data Dictionary namespaces and business definitions",
      ],
    };
  }

  // 5. End-to-end authoring: create content + rule + context (+ optional publish)
  if (/(create|build|make|launch|set up|setup|author|new)\b/i.test(lower)) {
    const cashThresholdMatch = message.match(/\$\s*([\d,]+)/);
    const threshold = cashThresholdMatch ? Number(cashThresholdMatch[1].replace(/,/g, "")) : 20000;
    const shouldPublish = /publish/i.test(lower);
    const explicitCtxMatch = message.match(/context\s+[`"']?([a-z][a-z0-9_-]{2,40})[`"']?/i);
    const baseTopic = lower.includes("treasury") ? "treasury_ladder"
      : lower.includes("retirement") ? "retirement_nudge"
      : lower.includes("mortgage") || lower.includes("home") ? "home_buyer_recommendation"
      : lower.includes("tax") ? "tax_harvest_recommendation"
      : "custom_cash_recommendation";
    const suffix = Date.now().toString(36).slice(-3);
    const contentId = `${baseTopic}_text_${suffix}`;
    const ruleId = `${baseTopic}_rule_${suffix}`;
    const contextId = explicitCtxMatch ? slug(explicitCtxMatch[1], `${baseTopic}_ctx`) : `${baseTopic}_ctx_${suffix}`;

    const isBeneficiary = lower.includes("beneficiary");
    const isUnfunded = lower.includes("unfunded");
    const clause = isBeneficiary
      ? { namespaceId: "customer", attributeId: "beneficiary_status", operator: "eq" as const, value: "missing" }
      : isUnfunded
      ? { namespaceId: "account", attributeId: "funding_status", operator: "eq" as const, value: "unfunded" }
      : { namespaceId: "portfolio", attributeId: "cash_usd", operator: "gt" as const, value: threshold };

    const ruleName = isBeneficiary
      ? "Beneficiary Missing"
      : isUnfunded
      ? "Account Unfunded"
      : `Portfolio Cash Above $${threshold.toLocaleString("en-US")}`;

    const ops: PlannedOp[] = [
      {
        op: "upsert_content",
        contentId,
        title: baseTopic.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        headline: isBeneficiary
          ? "Protect your account by adding a beneficiary."
          : `You currently have {{portfolio.cash_usd}} in core cash ({{portfolio.cash_share_pct}} of portfolio).`,
        body: `Personalized recommendation authored via Self-Service Copilot: ${message.slice(0, 260)}`,
        ctaLabel: "Explore Recommendation",
        ctaPrompt: `Tell me more about ${baseTopic.replace(/_/g, " ")}.`,
        disclosureText: "Governed via CEP Recommendation Self-Service Platform.",
        tags: [baseTopic.split("_")[0], "self-service"],
      },
      {
        op: "upsert_rule",
        ruleId,
        name: ruleName,
        businessDescription: `Eligibility rule automatically validated against the Data Dictionary for ${ruleName}.`,
        effect: "include_when_true",
        combinator: "AND",
        clauses: [clause],
      },
      {
        op: "upsert_context",
        contextId,
        displayName: contextId.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        description: `Self-service recommendation context for ${baseTopic.replace(/_/g, " ")}.`,
        channel: "all",
        contextRuleIds: [],
        attachments: [{ contentId, rank: 1, ruleIds: [ruleId], ruleMatchMode: "all" }],
      },
    ];
    if (shouldPublish) {
      ops.push({ op: "publish_context", contextId, notes: "Published via Self-Service Copilot" });
    }
    return {
      reply: shouldPublish
        ? `Created text content **\`${contentId}\`**, Data Dictionary rule **${ruleName}**, attached both to context **\`${contextId}\`**, and **published v1** live to Treatment Selector.`
        : `Drafted text content **\`${contentId}\`**, Data Dictionary rule **${ruleName}**, and attached both to context **\`${contextId}\`**. Review the cards below and click **Publish to TS** (or ask me to publish it).`,
      operations: ops,
      suggestedPrompts: shouldPublish
        ? [
            `Test ${contextId} for Alice Morgan and Jordan Lee`,
            `Simulate ${contextId} for Alice Morgan with portfolio.cash_usd = 5000`,
            "Show the Data Dictionary",
          ]
        : [
            `Publish ${contextId}`,
            `Test ${contextId} for Alice Morgan and Jordan Lee`,
            "Add another rule condition",
          ],
    };
  }

  // Default: catalog summary
  return {
    reply: `Here is your live **Recommendation Self-Service Platform** overview. Tell me what you want to create, edit, publish, or simulate by Customer MID.`,
    operations: [{ op: "show_catalog" }],
    suggestedPrompts: [
      "Create a Treasury Ladder recommendation for cash > $20,000, attach to context treasury-nudge, and publish it",
      `Test ${wealthRecommendationsTopic.displayName} for Alice Morgan and Jordan Lee`,
      "Show the Data Dictionary namespaces and business definitions",
      "Add custom attribute loyalty.vip_tier (gold/platinum) to the Data Dictionary",
    ],
  };
}

export async function runSelfServicePznCopilot(
  req: PznCopilotRequest,
  store: SelfServicePznStore,
  options?: {
    gateway?: GatewaySettings | null;
    dataDir?: string;
    executeSfieldTool?: PznSfieldToolExecutor;
    /** Returns a pending approval when the operation is gated by the approval policy; null when it may run now. */
    requestApproval?: (operation: string, args: Record<string, unknown>) => ApprovalRecord | null;
  },
): Promise<PznCopilotResponse> {
  let pendingApprovals = 0;
  const invokeTool = async <T>(
    toolRef: string,
    operation: string,
    payload: unknown,
    fallback: () => T,
  ): Promise<{ data: T; sfieldToolRef: string; sfieldRunId?: string }> => {
    if (options?.executeSfieldTool) {
      const res = await options.executeSfieldTool<T>(toolRef, operation, payload);
      return { data: res.data, sfieldToolRef: res.sfieldToolRef, sfieldRunId: res.sfieldRunId };
    }
    return { data: fallback(), sfieldToolRef: toolRef };
  };
  const initialWs = store.getWorkspaceState();
  let plan: LlmCopilotPlan | null = null;
  let generatedBy: "copilot_llm" | "deterministic" = "deterministic";

  if (options?.gateway && options.dataDir) {
    try {
      const historyText = (req.history ?? []).slice(-6).map((h) => `${h.role.toUpperCase()}: ${h.text}`).join("\n");
      const userPrompt = historyText ? `RECENT CONVERSATION:\n${historyText}\n\nNEW MESSAGE:\n${req.message}` : req.message;
      const raw = await callConfiguredLlmJson(
        options.gateway,
        options.dataDir,
        buildSystemPrompt(initialWs, req.activeContextId),
        userPrompt,
        AbortSignal.timeout(22_000),
      );
      if (raw && typeof raw === "object" && ("operations" in raw || "reply" in raw)) {
        const candidate = raw as LlmCopilotPlan;
        if (Array.isArray(candidate.operations) || typeof candidate.reply === "string") {
          plan = candidate;
          generatedBy = "copilot_llm";
        }
      }
    } catch {
      plan = null;
    }
  }

  if (!plan) {
    plan = deterministicPlan(req.message, initialWs, req.activeContextId);
    generatedBy = "deterministic";
  }

  const actionsExecuted: PznCopilotActionLog[] = [];
  const cards: PznCopilotCard[] = [];
  let activeContextId = req.activeContextId;
  const operations = Array.isArray(plan.operations) ? plan.operations : [];
  /** If the policy gates this operation, record a pending approval card instead of executing. */
  const gated = (tool: string, sfieldToolRef: string, operation: string, args: Record<string, unknown>): boolean => {
    const approval = options?.requestApproval?.(operation, args) ?? null;
    if (!approval) return false;
    pendingApprovals += 1;
    actionsExecuted.push({
      tool,
      sfieldToolRef,
      summary: `Approval ${approval.id} requested (${approval.riskLevel} risk${approval.dualControl ? ", second approver required" : ", self-approval allowed"})`,
      status: "pending",
    });
    cards.push({ kind: "approval_request", approval });
    return true;
  };

  for (const op of operations) {
    try {
      switch (op.op) {
        case "upsert_namespace": {
          const payload = {
            id: slug(op.id, "custom"),
            displayName: op.displayName,
            businessDefinition: op.businessDefinition,
            owner: op.owner || "Personalization Team",
            sourceSystem: op.sourceSystem || "custom_attribute",
          };
          if (gated("dictionary.upsertNamespace", pznSfieldToolRefs.dataDictionary, "upsert_namespace", payload)) break;
          const { data: saved, sfieldToolRef, sfieldRunId } = await invokeTool<PznNamespace>(
            pznSfieldToolRefs.dataDictionary,
            "upsert_namespace",
            payload,
            () => store.upsertNamespace(payload),
          );
          actionsExecuted.push({ tool: "dictionary.upsertNamespace", sfieldToolRef, sfieldRunId, summary: `Saved namespace "${saved.id}" (${saved.displayName})`, status: "ok" });
          break;
        }
        case "upsert_attribute": {
          const nsId = slug(op.namespaceId, "customer");
          const attrId = slug(op.id, "custom_attr");
          const dataType = op.dataType || "string";
          const payload = {
            namespaceId: nsId,
            id: attrId,
            displayName: op.displayName,
            businessDefinition: op.businessDefinition,
            dataType,
            allowedOperators: op.allowedOperators?.length ? op.allowedOperators : defaultOpsForType(dataType),
            enumOptions: (op.enumOptions ?? []).map((o) => ({ value: o.value, label: o.label, definition: o.definition ?? "" })),
            unit: op.unit ?? "",
            sampleValue: op.sampleValue ?? "",
            resolverPath: op.resolverPath || `customAttributes.${attrId}`,
            piiClassification: op.piiClassification ?? "none",
          };
          if (gated("dictionary.upsertAttribute", pznSfieldToolRefs.dataDictionary, "upsert_attribute", payload)) break;
          const { data: saved, sfieldToolRef, sfieldRunId } = await invokeTool<PznAttribute>(
            pznSfieldToolRefs.dataDictionary,
            "upsert_attribute",
            payload,
            () => store.upsertAttribute(payload),
          );
          actionsExecuted.push({ tool: "dictionary.upsertAttribute", sfieldToolRef, sfieldRunId, summary: `Saved Data Dictionary attribute "${saved.namespaceId}.${saved.id}"`, status: "ok" });
          const dict = store.getDictionary();
          const nsView = dict.namespaces.filter((n) => n.id === saved.namespaceId);
          cards.push({ kind: "dictionary", namespaces: nsView, highlightKey: `${saved.namespaceId}.${saved.id}` });
          break;
        }
        case "upsert_content": {
          const payload = {
            contentId: slug(op.contentId, "text_recommendation"),
            title: op.title,
            headline: op.headline ?? "",
            body: op.body,
            ctaLabel: op.ctaLabel ?? "",
            ctaPrompt: op.ctaPrompt ?? "",
            disclosureText: op.disclosureText ?? "",
            tags: op.tags ?? [],
            status: op.status ?? "published",
          };
          const { data: saved, sfieldToolRef, sfieldRunId } = await invokeTool<PznTextContent>(
            pznSfieldToolRefs.ruleMetadata,
            "upsert_content",
            payload,
            () => store.upsertContent(payload),
          );
          actionsExecuted.push({ tool: "content.upsert", sfieldToolRef, sfieldRunId, summary: `Saved text content "${saved.contentId}" (${saved.title})`, status: "ok" });
          cards.push({ kind: "content", content: saved });
          break;
        }
        case "upsert_rule": {
          const payload = {
            ruleId: slug(op.ruleId, "custom_rule"),
            name: op.name,
            businessDescription: op.businessDescription,
            effect: op.effect ?? "include_when_true",
            status: "published" as const,
            rootGroup: {
              id: "grp_root",
              kind: "group" as const,
              combinator: op.combinator ?? "AND",
              children: (op.clauses ?? []).map((cl, idx) => ({
                id: `cl_${idx + 1}`,
                kind: "clause" as const,
                namespaceId: slug(cl.namespaceId, "portfolio"),
                attributeId: slug(cl.attributeId, "cash_usd"),
                operator: cl.operator,
                ...(cl.operator === "exists" ? {} : { value: cl.value }),
              })),
            },
          };
          const { data: saved, sfieldToolRef, sfieldRunId } = await invokeTool<PznRule>(
            pznSfieldToolRefs.ruleMetadata,
            "upsert_rule",
            payload,
            () => store.upsertRule(payload),
          );
          actionsExecuted.push({ tool: "rule.upsert", sfieldToolRef, sfieldRunId, summary: `Validated & saved rule "${saved.ruleId}" (${saved.name})`, status: "ok" });
          cards.push({ kind: "rule", rule: saved });
          break;
        }
        case "upsert_context": {
          const ctxId = slug(op.contextId, "custom_context");
          const payload = {
            contextId: ctxId,
            displayName: op.displayName,
            description: op.description,
            channel: op.channel ?? "all",
            contextRuleIds: (op.contextRuleIds ?? []).map((r) => slug(r)),
            attachments: (op.attachments ?? []).map((att, idx) => ({
              contentId: slug(att.contentId),
              rank: att.rank ?? idx + 1,
              ruleIds: (att.ruleIds ?? []).map((r) => slug(r)),
              ruleMatchMode: att.ruleMatchMode ?? "all",
            })),
          };
          const { data: saved, sfieldToolRef, sfieldRunId } = await invokeTool<PznContext>(
            pznSfieldToolRefs.ruleMetadata,
            "upsert_context",
            payload,
            () => store.upsertContext(payload),
          );
          activeContextId = saved.contextId;
          actionsExecuted.push({ tool: "context.upsert", sfieldToolRef, sfieldRunId, summary: `Saved context "${saved.contextId}" with ${saved.attachments.length} attachment(s)`, status: "ok" });
          const wsNow = store.getWorkspaceState();
          const latestPublication = wsNow.publicationsByContext[saved.contextId]?.[0];
          cards.push({
            kind: "context",
            context: saved,
            contents: wsNow.contents,
            rules: wsNow.rules,
            latestPublication,
          });
          break;
        }
        case "publish_context": {
          const ctxId = slug(op.contextId, activeContextId ?? wealthRecommendationsTopic.contextId);
          const payload = { contextId: ctxId, publishedBy: "Self-Service Copilot", notes: op.notes || "Published via chat" };
          if (gated("context.publish", pznSfieldToolRefs.ruleMetadata, "publish_context", payload)) {
            activeContextId = ctxId;
            break;
          }
          const { data: pub, sfieldToolRef, sfieldRunId } = await invokeTool<PznContextPublication>(
            pznSfieldToolRefs.ruleMetadata,
            "publish_context",
            payload,
            () => store.publishContext(ctxId, payload.publishedBy, payload.notes),
          );
          activeContextId = pub.contextId;
          actionsExecuted.push({ tool: "context.publish", sfieldToolRef, sfieldRunId, summary: `Published "${pub.contextId}" v${pub.version} to Treatment Selector`, status: "ok" });
          const idx = cards.findIndex((c) => c.kind === "context" && c.context.contextId === pub.contextId);
          const wsNow = store.getWorkspaceState();
          const ctxCard: PznCopilotCard = {
            kind: "context",
            context: pub.context,
            contents: wsNow.contents,
            rules: wsNow.rules,
            latestPublication: pub,
          };
          if (idx >= 0) cards[idx] = ctxCard;
          else cards.push(ctxCard);
          break;
        }
        case "unpublish_context": {
          const ctxId = slug(op.contextId, activeContextId ?? wealthRecommendationsTopic.contextId);
          if (gated("context.unpublish", pznSfieldToolRefs.ruleMetadata, "unpublish_context", { contextId: ctxId })) {
            activeContextId = ctxId;
            break;
          }
          const { data: updated, sfieldToolRef, sfieldRunId } = await invokeTool<PznContext>(
            pznSfieldToolRefs.ruleMetadata,
            "unpublish_context",
            { contextId: ctxId },
            () => store.unpublishContext(ctxId),
          );
          activeContextId = updated.contextId;
          actionsExecuted.push({ tool: "context.unpublish", sfieldToolRef, sfieldRunId, summary: `Unpublished "${updated.contextId}"`, status: "ok" });
          const wsNow = store.getWorkspaceState();
          cards.push({ kind: "context", context: updated, contents: wsNow.contents, rules: wsNow.rules });
          break;
        }
        case "evaluate_ts": {
          const ctxId = slug(op.contextId, activeContextId ?? wealthRecommendationsTopic.contextId);
          activeContextId = ctxId;
          const mids = op.mids?.length ? op.mids.slice(0, 4) : [initialWs.customers[0]?.syntheticMid ?? "DEMO-MID-1001"];
          const ctxRecord = store.getContext(ctxId);
          const autoDraft = op.useDraft ?? (ctxRecord ? ctxRecord.status !== "published" : false);
          for (const mid of mids) {
            const payload = {
              mid,
              contextId: ctxId,
              useDraft: autoDraft,
              ...(op.attributeOverrides && Object.keys(op.attributeOverrides).length ? { attributeOverrides: op.attributeOverrides } : {}),
            };
            const { data: evalRes, sfieldToolRef, sfieldRunId } = await invokeTool<PznTsEvaluationResult>(
              pznSfieldToolRefs.treatmentSelector,
              "evaluate",
              payload,
              () => store.evaluateLiveTs(payload),
            );
            actionsExecuted.push({
              tool: "ts.evaluate",
              sfieldToolRef,
              sfieldRunId,
              summary: `TS(${mid}, ${ctxId}) → ${evalRes.eligibleContents.length} eligible, ${evalRes.filteredOutContents.length} filtered out (${evalRes.durationMs}ms)`,
              status: "ok",
            });
            cards.push({ kind: "ts_evaluation", evaluation: evalRes });
          }
          break;
        }
        case "show_dictionary": {
          const { data: dict, sfieldToolRef, sfieldRunId } = await invokeTool<PznDataDictionary>(
            pznSfieldToolRefs.dataDictionary,
            "get_dictionary",
            {},
            () => store.getDictionary(),
          );
          const filtered = op.namespaceId
            ? dict.namespaces.filter((n) => n.id === slug(op.namespaceId!))
            : dict.namespaces;
          const finalNs = filtered.length ? filtered : dict.namespaces;
          actionsExecuted.push({ tool: "dictionary.read", sfieldToolRef, sfieldRunId, summary: `Loaded ${finalNs.length} Data Dictionary namespace(s)`, status: "ok" });
          cards.push({ kind: "dictionary", namespaces: finalNs });
          break;
        }
        case "show_catalog": {
          const { data: wsNow, sfieldToolRef, sfieldRunId } = await invokeTool<PznStudioWorkspaceState>(
            pznSfieldToolRefs.ruleMetadata,
            "get_workspace",
            {},
            () => store.getWorkspaceState(),
          );
          actionsExecuted.push({ tool: "catalog.summary", sfieldToolRef, sfieldRunId, summary: `Listed ${wsNow.contexts.length} context(s), ${wsNow.contents.length} content(s), ${wsNow.rules.length} rule(s)`, status: "ok" });
          cards.push({
            kind: "catalog_summary",
            contexts: wsNow.contexts,
            contentsCount: wsNow.contents.length,
            rulesCount: wsNow.rules.length,
            attrCount: wsNow.dictionary.namespaces.reduce((acc, ns) => acc + ns.attributes.length, 0),
          });
          break;
        }
        case "show_rule_builder": {
          const { sfieldToolRef, sfieldRunId } = await invokeTool<PznDataDictionary>(
            pznSfieldToolRefs.dataDictionary,
            "get_dictionary",
            {},
            () => store.getDictionary(),
          );
          actionsExecuted.push({ tool: "widget.ruleBuilder", sfieldToolRef, sfieldRunId, summary: "Mounted Interactive Rule Builder Widget (Data Dictionary–bound)", status: "ok" });
          cards.push({
            kind: "rule_builder_widget",
            ...(op.initialNamespaceId ? { initialNamespaceId: slug(op.initialNamespaceId) } : {}),
            ...(op.initialAttributeId ? { initialAttributeId: slug(op.initialAttributeId) } : {}),
          });
          break;
        }
        case "show_rules": {
          const { data: rulesList, sfieldToolRef, sfieldRunId } = await invokeTool<PznRule[]>(
            pznSfieldToolRefs.ruleMetadata,
            "list_rules",
            {},
            () => store.listRules(),
          );
          actionsExecuted.push({ tool: "rules.list", sfieldToolRef, sfieldRunId, summary: `Loaded ${rulesList.length} Data Dictionary rule(s)`, status: "ok" });
          cards.push({ kind: "rules_catalog_widget", rules: rulesList });
          break;
        }
        case "show_approvals": {
          actionsExecuted.push({ tool: "approvals.queue", summary: "Loaded approval queue and policy", status: "ok" });
          cards.push({ kind: "approvals_queue_widget" });
          break;
        }
        case "show_context_matrix": {
          const { data: wsNow, sfieldToolRef, sfieldRunId } = await invokeTool<PznStudioWorkspaceState>(
            pznSfieldToolRefs.ruleMetadata,
            "get_workspace",
            {},
            () => store.getWorkspaceState(),
          );
          actionsExecuted.push({ tool: "contexts.matrix", sfieldToolRef, sfieldRunId, summary: `Loaded ${wsNow.contexts.length} context(s) with attached contents & rules`, status: "ok" });
          cards.push({
            kind: "context_matrix_widget",
            contexts: wsNow.contexts,
            contents: wsNow.contents,
            rules: wsNow.rules,
          });
          break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Operation failed";
      actionsExecuted.push({ tool: op.op, summary: msg, status: "error" });
    }
  }

  const workspace = store.getWorkspaceState();
  const hasErrors = actionsExecuted.some((a) => a.status === "error");
  const errorSuffix = hasErrors
    ? "\n\nSome steps reported validation issues: " + actionsExecuted.filter((a) => a.status === "error").map((a) => `${a.tool}: ${a.summary}`).join("; ")
    : "";

  return {
    // When anything was gated, the model's prose may claim it already happened, so state the facts instead.
    reply: (pendingApprovals > 0
      ? [
          actionsExecuted.some((a) => a.status === "ok")
            ? `Done: ${actionsExecuted.filter((a) => a.status === "ok").map((a) => a.summary).join("; ")}.`
            : "",
          `⏳ ${pendingApprovals} change${pendingApprovals > 1 ? "s need" : " needs"} approval before going live. Nothing has been published or deleted yet. Review the approval card below.`,
        ].filter(Boolean).join("\n\n")
      : (plan.reply?.trim() || "Completed your Recommendation Self-Service request."))
      + errorSuffix,
    generatedBy,
    actionsExecuted,
    cards,
    suggestedPrompts: Array.isArray(plan.suggestedPrompts) && plan.suggestedPrompts.length > 0
      ? plan.suggestedPrompts.slice(0, 4)
      : [
          `Test ${recommendationContextLabel(activeContextId ?? workspace.contexts[0]?.contextId ?? wealthRecommendationsTopic.contextId)} for Alice Morgan and Jordan Lee`,
          "Show the Data Dictionary namespaces and business definitions",
          "Create a new text recommendation and rule for cash > $25,000 and publish it",
        ],
    activeContextId,
    workspace,
  };
}
