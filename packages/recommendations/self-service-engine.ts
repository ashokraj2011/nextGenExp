import { customerWorkflow, type RuleWorkflowMatch } from "../contracts/customer-workflows";
import { randomUUID } from "node:crypto";
import type { ContentEntry, ContextCatalog } from "../contracts/domain";
import {
  pznOperatorLabels,
  recommendationContextLabel,
  type PznAttribute,
  type PznClauseEvalResult,
  type PznContentEvalResult,
  type PznContext,
  type PznContextPublication,
  type PznDataDictionary,
  type PznOperator,
  type PznRule,
  type PznRuleClause,
  type PznRuleEvalResult,
  type PznRuleGroup,
  type PznRuleValue,
  type PznTextContent,
  type PznTsEvaluationResult,
} from "../contracts/self-service-pzn";
import { findProfileById, findProfileByMid } from "../customer-profiles";

export interface ActiveSelfServicePznProvider {
  listPublishedContextSummaries(): ContextCatalog["contexts"];
  getPublishedPublication(contextId: string): PznContextPublication | undefined;
  findPublishedContentEntry(contentId: string): ContentEntry | undefined;
  evaluatePublishedForTs(mid: string, contextId: string, overrides?: Record<string, PznRuleValue>): PznTsEvaluationResult | undefined;
}

let activeProvider: ActiveSelfServicePznProvider | null = null;

export function registerActiveSelfServicePznProvider(provider: ActiveSelfServicePznProvider | null) {
  activeProvider = provider;
}

export function getActiveSelfServicePznProvider(): ActiveSelfServicePznProvider | null {
  return activeProvider;
}

export function indexDictionaryAttributes(dictionary: PznDataDictionary): Map<string, PznAttribute> {
  const map = new Map<string, PznAttribute>();
  for (const ns of dictionary.namespaces) {
    for (const attr of ns.attributes) {
      map.set(`${ns.id}.${attr.id}`, attr);
    }
  }
  return map;
}

export function validateRuleAgainstDictionary(rule: Pick<PznRule, "rootGroup" | "workflow"> & Partial<Pick<PznRule, "effect">>, dictionary: PznDataDictionary): string[] {
  const attrs = indexDictionaryAttributes(dictionary);
  const errors: string[] = [];
  if (rule.workflow && (!customerWorkflow(rule.workflow) || rule.effect === "exclude_when_true")) {
    errors.push("Choose a registered customer workflow for an inclusion rule.");
  }

  function walk(node: PznRuleGroup | PznRuleClause) {
    if (node.kind === "group") {
      if (!node.children.length) {
        errors.push(`Condition group ${node.id} must have at least one condition.`);
        return;
      }
      for (const child of node.children) walk(child);
      return;
    }
    const key = `${node.namespaceId}.${node.attributeId}`;
    const attr = attrs.get(key);
    if (!attr) {
      errors.push(`Unknown Data Dictionary attribute "${key}".`);
      return;
    }
    if (!attr.allowedOperators.includes(node.operator)) {
      errors.push(`Operator "${node.operator}" is not allowed for attribute "${key}".`);
    }
    if (node.operator === "exists") return;
    if (node.value === undefined || node.value === null || node.value === "") {
      errors.push(`Attribute "${key}" requires a comparison value.`);
      return;
    }
    if ((node.operator === "in" || node.operator === "not_in") && !Array.isArray(node.value)) {
      errors.push(`Operator "${node.operator}" on "${key}" expects a list of values.`);
      return;
    }
    if (attr.dataType === "enum" && (node.operator === "eq" || node.operator === "ne") && attr.enumOptions.length > 0) {
      if (!attr.enumOptions.some((opt) => opt.value === String(node.value))) {
        errors.push(`Value "${String(node.value)}" is not a valid option for "${key}".`);
      }
    }
    if ((attr.dataType === "number" || attr.dataType === "currency_usd") && node.operator !== "in" && node.operator !== "not_in") {
      if (typeof node.value !== "number" || !Number.isFinite(node.value)) {
        errors.push(`Attribute "${key}" requires a numeric value.`);
      }
    }
    if (attr.dataType === "boolean" && typeof node.value !== "boolean") {
      errors.push(`Attribute "${key}" requires a boolean (true/false) value.`);
    }
  }

  walk(rule.rootGroup);
  return errors;
}

function readCustomAttrValue(raw: string, type: "text" | "currency" | "number" | "percent"): unknown {
  const trimmed = raw.trim();
  if (type === "currency" || type === "number" || type === "percent") {
    const cleaned = trimmed.replace(/[$,%\s,]/g, "");
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : trimmed;
  }
  if (trimmed.toLowerCase() === "true") return true;
  if (trimmed.toLowerCase() === "false") return false;
  return trimmed;
}

export function resolveAttributesForMid(
  mid: string,
  dictionary: PznDataDictionary,
  overrides?: Record<string, PznRuleValue>,
): {
  customerDisplayName: string;
  personaId?: string;
  attributes: Record<string, unknown>;
} {
  const profile = findProfileByMid(mid) ?? findProfileById(mid);
  const totalPortfolioCents = profile
    ? profile.cashCents + profile.equityCents + profile.fixedIncomeCents
    : 0;
  const cashSharePct = totalPortfolioCents > 0
    ? Math.round(((profile?.cashCents ?? 0) / totalPortfolioCents) * 1000) / 10
    : 0;
  const homeGoalPct = profile && profile.homeGoalTargetCents > 0
    ? Math.min(100, Math.round((profile.homeGoalSavedCents / profile.homeGoalTargetCents) * 100))
    : 0;
  const homeGoalRemainingUsd = profile
    ? Math.max(0, Math.round((profile.homeGoalTargetCents - profile.homeGoalSavedCents) / 100))
    : 0;

  const customMap = new Map<string, unknown>();
  for (const attr of profile?.customAttributes ?? []) {
    customMap.set(attr.key, readCustomAttrValue(attr.value, attr.type));
  }

  const builtInValues: Record<string, unknown> = profile ? {
    "customer.mid": profile.syntheticMid,
    "customer.persona": profile.personaId,
    "customer.display_name": profile.displayName,
    "customer.segment": profile.segment || "General",
    "customer.is_returning": profile.personaId === "demo-returning",
    "customer.beneficiary_status": profile.beneficiaryStatus,
    "account.funding_status": profile.accountFundingStatus,
    "account.available_balance_usd": Math.round(profile.availableBalanceCents) / 100,
    "account.current_balance_usd": Math.round(profile.currentBalanceCents) / 100,
    "portfolio.cash_usd": Math.round(profile.cashCents) / 100,
    "portfolio.equity_usd": Math.round(profile.equityCents) / 100,
    "portfolio.fixed_income_usd": Math.round(profile.fixedIncomeCents) / 100,
    "portfolio.total_value_usd": Math.round(totalPortfolioCents) / 100,
    "portfolio.cash_share_pct": cashSharePct,
    "goals.home_target_usd": Math.round(profile.homeGoalTargetCents) / 100,
    "goals.home_saved_usd": Math.round(profile.homeGoalSavedCents) / 100,
    "goals.home_funded_pct": homeGoalPct,
    "goals.home_remaining_usd": homeGoalRemainingUsd,
    "conversation.turn_number": 1,
    "conversation.channel": "chat",
  } : {
    "customer.mid": mid,
    "conversation.turn_number": 1,
    "conversation.channel": "chat",
  };

  const resolved: Record<string, unknown> = {};
  for (const ns of dictionary.namespaces) {
    for (const attr of ns.attributes) {
      const fullKey = `${ns.id}.${attr.id}`;
      if (overrides && Object.hasOwn(overrides, fullKey) && overrides[fullKey] !== undefined) {
        resolved[fullKey] = overrides[fullKey];
        continue;
      }
      if (attr.resolverPath.startsWith("customAttributes.")) {
        const customKey = attr.resolverPath.slice("customAttributes.".length);
        if (customMap.has(customKey)) {
          resolved[fullKey] = customMap.get(customKey);
          continue;
        }
      }
      if (Object.hasOwn(builtInValues, attr.resolverPath)) {
        resolved[fullKey] = builtInValues[attr.resolverPath];
        continue;
      }
      if (Object.hasOwn(builtInValues, fullKey)) {
        resolved[fullKey] = builtInValues[fullKey];
        continue;
      }
      if (customMap.has(attr.id)) {
        resolved[fullKey] = customMap.get(attr.id);
        continue;
      }
      resolved[fullKey] = undefined;
    }
  }

  // Also preserve any extra overrides passed in for ad-hoc simulation
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (v !== undefined) resolved[k] = v;
    }
  }

  return {
    customerDisplayName: profile?.displayName ?? `Customer (${mid})`,
    personaId: profile?.personaId,
    attributes: resolved,
  };
}

function compareValues(operator: PznOperator, actual: unknown, expected: PznRuleValue | undefined): boolean {
  if (operator === "exists") {
    return actual !== undefined && actual !== null && actual !== "";
  }
  if (actual === undefined || actual === null) return false;
  switch (operator) {
    case "eq":
      if (typeof actual === "string" && typeof expected === "string") {
        return actual.trim().toLowerCase() === expected.trim().toLowerCase();
      }
      return actual === expected;
    case "ne":
      if (typeof actual === "string" && typeof expected === "string") {
        return actual.trim().toLowerCase() !== expected.trim().toLowerCase();
      }
      return actual !== expected;
    case "gt":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "gte":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "lt":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "lte":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "in": {
      const list = Array.isArray(expected) ? expected : String(expected ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const actualStr = String(actual).trim().toLowerCase();
      return list.some((item) => item.trim().toLowerCase() === actualStr);
    }
    case "not_in": {
      const list = Array.isArray(expected) ? expected : String(expected ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const actualStr = String(actual).trim().toLowerCase();
      return !list.some((item) => item.trim().toLowerCase() === actualStr);
    }
    case "contains":
      if (Array.isArray(actual)) {
        return actual.some((item) => String(item).toLowerCase().includes(String(expected ?? "").toLowerCase()));
      }
      return String(actual).toLowerCase().includes(String(expected ?? "").toLowerCase());
  }
}

function formatDisplayVal(val: unknown, attr?: PznAttribute): string {
  if (val === undefined || val === null) return "missing";
  if (Array.isArray(val)) return `[${val.join(", ")}]`;
  if (typeof val === "number" && attr?.dataType === "currency_usd") {
    return "$" + val.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  if (typeof val === "number" && attr?.unit) {
    return `${val}${attr.unit === "%" ? "%" : ` ${attr.unit}`}`;
  }
  return String(val);
}

export function evaluatePznRule(
  rule: Pick<PznRule, "ruleId" | "name" | "businessDescription" | "effect" | "rootGroup">,
  resolvedAttributes: Record<string, unknown>,
  dictionary: PznDataDictionary,
): PznRuleEvalResult {
  const attrs = indexDictionaryAttributes(dictionary);
  const clauses: PznClauseEvalResult[] = [];

  function evalNode(node: PznRuleGroup | PznRuleClause): boolean {
    if (node.kind === "clause") {
      const key = `${node.namespaceId}.${node.attributeId}`;
      const attr = attrs.get(key);
      const actual = resolvedAttributes[key];
      const passed = compareValues(node.operator, actual, node.value);
      const opLabel = pznOperatorLabels[node.operator] ?? node.operator;
      const reason = node.operator === "exists"
        ? `${key} is ${actual !== undefined && actual !== null && actual !== "" ? `present (${formatDisplayVal(actual, attr)})` : "missing"}`
        : `${key} (${formatDisplayVal(actual, attr)}) ${opLabel} ${formatDisplayVal(node.value, attr)} → ${passed ? "TRUE" : "FALSE"}`;

      clauses.push({
        clauseId: node.id,
        namespaceId: node.namespaceId,
        attributeId: node.attributeId,
        attributeLabel: attr?.displayName ?? node.attributeId,
        businessDefinition: attr?.businessDefinition ?? "Custom runtime attribute.",
        operator: node.operator,
        expectedValue: node.value,
        actualValue: actual ?? null,
        passed,
        reason,
      });
      return passed;
    }

    if (node.combinator === "AND") {
      let allTrue = true;
      for (const child of node.children) {
        if (!evalNode(child)) allTrue = false;
      }
      return allTrue;
    } else {
      let anyTrue = false;
      for (const child of node.children) {
        if (evalNode(child)) anyTrue = true;
      }
      return anyTrue;
    }
  }

  const matched = evalNode(rule.rootGroup);
  const effectiveAllow = rule.effect === "include_when_true" ? matched : !matched;
  const passedCount = clauses.filter((c) => c.passed).length;
  const summary = rule.effect === "include_when_true"
    ? (matched
      ? `Rule matched (${passedCount}/${clauses.length} clauses true) — content eligible.`
      : `Rule did not match (${passedCount}/${clauses.length} clauses true) — content excluded.`)
    : (matched
      ? `Suppression rule triggered (${passedCount}/${clauses.length} clauses true) — content suppressed.`
      : `Suppression rule did not trigger — content stays eligible.`);

  return {
    ruleId: rule.ruleId,
    ruleName: rule.name,
    businessDescription: rule.businessDescription,
    effect: rule.effect,
    matched,
    effectiveAllow,
    combinator: rule.rootGroup.combinator,
    clauses,
    summary,
    evaluatedAt: new Date().toISOString(),
  };
}

export function renderContentText(template: string, resolvedAttributes: Record<string, unknown>, dictionary: PznDataDictionary): string {
  const attrs = indexDictionaryAttributes(dictionary);
  return template.replace(/\{\{\s*([a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*)\s*\}\}/gi, (_match, key: string) => {
    const val = resolvedAttributes[key];
    if (val === undefined || val === null) return "";
    return formatDisplayVal(val, attrs.get(key));
  });
}

export function evaluateTreatmentSelector(params: {
  mid: string;
  context: PznContext;
  contents: PznTextContent[];
  rules: PznRule[];
  dictionary: PznDataDictionary;
  sourceMode: "published" | "draft_preview";
  publicationVersion: number;
  attributeOverrides?: Record<string, PznRuleValue>;
}): PznTsEvaluationResult {
  const start = performance.now();
  const { mid, context, contents, rules, dictionary, sourceMode, publicationVersion, attributeOverrides } = params;
  const { customerDisplayName, personaId, attributes } = resolveAttributesForMid(mid, dictionary, attributeOverrides);

  const ruleMap = new Map(rules.map((r) => [r.ruleId, r]));
  const contentMap = new Map(contents.map((c) => [c.contentId, c]));
  const evalCache = new Map<string, PznRuleEvalResult>();

  const evalRuleById = (ruleId: string): PznRuleEvalResult | undefined => {
    const cached = evalCache.get(ruleId);
    if (cached) return cached;
    const rule = ruleMap.get(ruleId);
    if (!rule) return undefined;
    const res = evaluatePznRule(rule, attributes, dictionary);
    evalCache.set(ruleId, res);
    return res;
  };

  // 1. Evaluate context-wide gate rules
  const contextRuleResults: PznRuleEvalResult[] = [];
  for (const rId of context.contextRuleIds) {
    const res = evalRuleById(rId);
    if (res) contextRuleResults.push(res);
  }
  const contextGatePassed = contextRuleResults.every((r) => r.effectiveAllow);

  // 2. Evaluate each attached content item in priority rank order
  const sortedAttachments = [...context.attachments].sort((a, b) => a.rank - b.rank);
  const eligibleContents: PznContentEvalResult[] = [];
  const filteredOutContents: PznContentEvalResult[] = [];

  for (const attachment of sortedAttachments) {
    const item = contentMap.get(attachment.contentId);
    if (!item) continue;

    const renderedBody = renderContentText(item.body, attributes, dictionary);
    const renderedHeadline = renderContentText(item.headline || "", attributes, dictionary);

    if (item.status === "archived") {
      filteredOutContents.push({
        contentId: item.contentId,
        title: item.title,
        headline: renderedHeadline,
        body: item.body,
        renderedBody,
        ctaLabel: item.ctaLabel,
        ctaPrompt: item.ctaPrompt,
        disclosureText: item.disclosureText,
        tags: item.tags,
        rank: attachment.rank,
        eligible: false,
        attachedRuleIds: attachment.ruleIds,
        ruleMatchMode: attachment.ruleMatchMode,
        failedRuleIds: [],
        reasonCode: "CONTENT_NOT_PUBLISHED",
        reason: "Content item is archived.",
      });
      continue;
    }

    if (!contextGatePassed) {
      const failedCtxRules = contextRuleResults.filter((r) => !r.effectiveAllow).map((r) => r.ruleId);
      filteredOutContents.push({
        contentId: item.contentId,
        title: item.title,
        headline: renderedHeadline,
        body: item.body,
        renderedBody,
        ctaLabel: item.ctaLabel,
        ctaPrompt: item.ctaPrompt,
        disclosureText: item.disclosureText,
        tags: item.tags,
        rank: attachment.rank,
        eligible: false,
        attachedRuleIds: attachment.ruleIds,
        ruleMatchMode: attachment.ruleMatchMode,
        failedRuleIds: failedCtxRules,
        reasonCode: "CONTEXT_RULE_FALSE",
        reason: `Context-level rule gate failed (${failedCtxRules.join(", ")}).`,
      });
      continue;
    }

    const attachedResults = attachment.ruleIds
      .map((rId) => evalRuleById(rId))
      .filter((r): r is PznRuleEvalResult => Boolean(r));

    if (attachedResults.length === 0) {
      eligibleContents.push({
        contentId: item.contentId,
        title: item.title,
        headline: renderedHeadline,
        body: item.body,
        renderedBody,
        ctaLabel: item.ctaLabel,
        ctaPrompt: item.ctaPrompt,
        disclosureText: item.disclosureText,
        tags: item.tags,
        rank: attachment.rank,
        eligible: true,
        attachedRuleIds: [],
        ruleMatchMode: attachment.ruleMatchMode,
        failedRuleIds: [],
        reasonCode: "ELIGIBLE",
        reason: "No filtering rules attached — eligible for all customers in this context.",
      });
      continue;
    }

    const passed = attachment.ruleMatchMode === "all"
      ? attachedResults.every((r) => r.effectiveAllow)
      : attachedResults.some((r) => r.effectiveAllow);

    const failed = attachedResults.filter((r) => !r.effectiveAllow);
    const suppressed = failed.some((r) => r.effect === "exclude_when_true" && r.matched);

    if (passed) {
      eligibleContents.push({
        contentId: item.contentId,
        title: item.title,
        headline: renderedHeadline,
        body: item.body,
        renderedBody,
        ctaLabel: item.ctaLabel,
        ctaPrompt: item.ctaPrompt,
        disclosureText: item.disclosureText,
        tags: item.tags,
        rank: attachment.rank,
        eligible: true,
        attachedRuleIds: attachment.ruleIds,
        ruleMatchMode: attachment.ruleMatchMode,
        failedRuleIds: [],
        reasonCode: "ELIGIBLE",
        reason: `Passed ${attachment.ruleMatchMode === "all" ? "all" : "at least one"} attached rule(s): ${attachedResults.filter((r) => r.effectiveAllow).map((r) => r.ruleName).join(", ")}.`,
      });
    } else {
      filteredOutContents.push({
        contentId: item.contentId,
        title: item.title,
        headline: renderedHeadline,
        body: item.body,
        renderedBody,
        ctaLabel: item.ctaLabel,
        ctaPrompt: item.ctaPrompt,
        disclosureText: item.disclosureText,
        tags: item.tags,
        rank: attachment.rank,
        eligible: false,
        attachedRuleIds: attachment.ruleIds,
        ruleMatchMode: attachment.ruleMatchMode,
        failedRuleIds: failed.map((r) => r.ruleId),
        reasonCode: suppressed ? "SUPPRESSED_BY_RULE" : "RULE_FALSE",
        reason: failed.map((r) => `${r.ruleName}: ${r.summary}`).join(" "),
      });
    }
  }

  const durationMs = Math.max(1, Math.round((performance.now() - start) * 100) / 100);
  const allRuleResults = Array.from(evalCache.values());
  const workflowMatches: RuleWorkflowMatch[] = eligibleContents.flatMap((card) =>
    [...new Set([...context.contextRuleIds, ...card.attachedRuleIds])].flatMap((id) => {
      const rule = ruleMap.get(id);
      const result = evalCache.get(id);
      return rule?.workflow && result?.matched && result.effectiveAllow
        ? [{ name: rule.name, contentId: card.contentId, workflow: rule.workflow }] : [];
    }));

  return {
    ...(workflowMatches.length && { workflowMatches }),
    evaluationId: "ts_eval_" + randomUUID().replaceAll("-", "").slice(0, 14),
    mid,
    customerDisplayName,
    personaId,
    contextId: context.contextId,
    contextDisplayName: recommendationContextLabel(context.contextId, context.displayName),
    sourceMode,
    publicationVersion,
    dictionaryVersion: dictionary.version,
    evaluatedAt: new Date().toISOString(),
    durationMs,
    contextGatePassed,
    resolvedAttributes: attributes,
    contextRuleResults,
    ruleResults: allRuleResults,
    eligibleContents,
    filteredOutContents,
    experiencePayload: {
      schemaVersion: "1.0",
      contextId: context.contextId,
      mid,
      eligibleContentIds: eligibleContents.map((c) => c.contentId),
      cards: eligibleContents.map((c) => ({
        contentId: c.contentId,
        title: c.title,
        headline: c.headline,
        body: c.renderedBody,
        ctaLabel: c.ctaLabel,
        ctaPrompt: c.ctaPrompt,
        disclosureText: c.disclosureText,
        rank: c.rank,
      })),
    },
  };
}

export function pznTextContentToCatalogEntry(item: PznTextContent): ContentEntry {
  return {
    contentId: item.contentId,
    version: `v${item.version}`,
    publicationStatus: item.status === "published" ? "published" : "withdrawn",
    kind: "education",
    title: item.title,
    description: item.headline || item.body.slice(0, 160),
    body: item.body,
    allowedComponents: ["PznContentCard"],
    comparisonGroup: null,
    comparisonFields: [],
    steps: [],
    metricSpec: null,
    followUps: item.ctaLabel && item.ctaPrompt
      ? [{ followUpId: `fu_${item.contentId}`, label: item.ctaLabel, userMessage: item.ctaPrompt }]
      : [],
    sourceRef: `self-service:${item.contentId}`,
    sourceLabel: "Self-Service Recommendation Catalog",
    requiredDisclosures: item.disclosureText
      ? [{ disclosureId: `disc_${item.contentId}`, text: item.disclosureText }]
      : [{ disclosureId: "demo_self_service", text: "Personalized via CEP Recommendation Self-Service Platform." }],
  };
}
