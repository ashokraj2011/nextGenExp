import { z } from "zod";
import { workflowRecommendationSchema } from "./funding-workflow";
import type { RuleWorkflowMatch } from "./customer-workflows";
import type { ApprovalRecord } from "./approval";

// The published topic ID is referenced by rules, integrations and saved decisions.
export const wealthRecommendationsTopic = {
  contextId: "wealth-next-best-offers",
  displayName: "Wealth Next-Best Recommendations",
} as const;

export function recommendationContextLabel(contextId: string, displayName?: string): string {
  if (contextId === wealthRecommendationsTopic.contextId && (displayName === undefined || displayName === "Wealth Next-Best Offers")) {
    return wealthRecommendationsTopic.displayName;
  }
  return displayName ?? contextId;
}

export const pznDataTypes = ["enum", "boolean", "number", "currency_usd", "string", "string_list"] as const;
export type PznDataType = typeof pznDataTypes[number];

export const pznOperators = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "exists"] as const;
export type PznOperator = typeof pznOperators[number];

export const pznOperatorLabels: Record<PznOperator, string> = {
  eq: "Equals (=)",
  ne: "Does not equal (!=)",
  gt: "Greater than (>)",
  gte: "At least (>=)",
  lt: "Less than (<)",
  lte: "At most (<=)",
  in: "Is one of (in)",
  not_in: "Is not one of (not in)",
  contains: "Contains",
  exists: "Has value (exists)",
};

export const pznSourceSystems = [
  "customer_360",
  "portfolio_snapshot",
  "goal_progress",
  "session_context",
  "custom_attribute",
] as const;
export type PznSourceSystem = typeof pznSourceSystems[number];

export const pznSlugSchema = z.string().trim().regex(/^[a-z][a-z0-9_-]{0,63}$/, "Use lowercase letters, numbers, hyphens, or underscores");

export const pznEnumOptionSchema = z.object({
  value: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(80),
  definition: z.string().trim().max(200).default(""),
}).strict();
export type PznEnumOption = z.infer<typeof pznEnumOptionSchema>;

export const pznNamespaceInputSchema = z.object({
  id: pznSlugSchema,
  displayName: z.string().trim().min(1).max(80),
  businessDefinition: z.string().trim().min(1).max(400),
  owner: z.string().trim().min(1).max(80).default("Personalization Platform"),
  sourceSystem: z.enum(pznSourceSystems).default("customer_360"),
}).strict();
export type PznNamespaceInput = z.infer<typeof pznNamespaceInputSchema>;

export const pznNamespaceSchema = pznNamespaceInputSchema.extend({
  builtIn: z.boolean().default(false),
  updatedAt: z.string(),
}).strict();
export type PznNamespace = z.infer<typeof pznNamespaceSchema>;

export const pznAttributeInputSchema = z.object({
  id: pznSlugSchema,
  namespaceId: pznSlugSchema,
  displayName: z.string().trim().min(1).max(100),
  businessDefinition: z.string().trim().min(1).max(500),
  dataType: z.enum(pznDataTypes),
  allowedOperators: z.array(z.enum(pznOperators)).min(1).max(pznOperators.length),
  enumOptions: z.array(pznEnumOptionSchema).max(32).default([]),
  unit: z.string().trim().max(32).default(""),
  sampleValue: z.string().trim().max(120).default(""),
  resolverPath: z.string().trim().min(1).max(120),
  piiClassification: z.enum(["none", "internal", "pii"]).default("none"),
}).strict();
export type PznAttributeInput = z.infer<typeof pznAttributeInputSchema>;

export const pznAttributeSchema = pznAttributeInputSchema.extend({
  builtIn: z.boolean().default(false),
  updatedAt: z.string(),
}).strict();
export type PznAttribute = z.infer<typeof pznAttributeSchema>;

const pznDictionaryNamespaceSchema = pznNamespaceSchema.extend({ attributes: z.array(pznAttributeSchema) });
export type PznDictionaryNamespaceView = z.infer<typeof pznDictionaryNamespaceSchema>;

const pznDataDictionarySchema = z.object({
  version: z.string(),
  updatedAt: z.string(),
  namespaces: z.array(pznDictionaryNamespaceSchema),
}).strict();
export type PznDataDictionary = z.infer<typeof pznDataDictionarySchema>;

export const pznTextContentInputSchema = z.object({
  contentId: pznSlugSchema,
  title: z.string().trim().min(1).max(120),
  headline: z.string().trim().max(180).default(""),
  body: z.string().trim().min(1).max(2000),
  ctaLabel: z.string().trim().max(60).default(""),
  ctaPrompt: z.string().trim().max(240).default(""),
  disclosureText: z.string().trim().max(400).default(""),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  status: z.enum(["draft", "published", "archived"]).default("published"),
}).strict();
export type PznTextContentInput = z.infer<typeof pznTextContentInputSchema>;

export const pznTextContentSchema = pznTextContentInputSchema.extend({
  version: z.number().int().positive().default(1),
  builtIn: z.boolean().default(false),
  updatedAt: z.string(),
}).strict();
export type PznTextContent = z.infer<typeof pznTextContentSchema>;

export const pznRuleValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.null(),
]);
export type PznRuleValue = z.infer<typeof pznRuleValueSchema>;

export const pznRuleClauseSchema = z.object({
  id: z.string().trim().min(1).max(64),
  kind: z.literal("clause"),
  namespaceId: pznSlugSchema,
  attributeId: pznSlugSchema,
  operator: z.enum(pznOperators),
  value: pznRuleValueSchema.optional(),
}).strict();
export type PznRuleClause = z.infer<typeof pznRuleClauseSchema>;

export type PznRuleGroup = {
  id: string;
  kind: "group";
  combinator: "AND" | "OR";
  children: (PznRuleClause | PznRuleGroup)[];
};

export const pznRuleGroupSchema: z.ZodType<PznRuleGroup> = z.lazy(() =>
  z.object({
    id: z.string().trim().min(1).max(64),
    kind: z.literal("group"),
    combinator: z.enum(["AND", "OR"]),
    children: z.array(z.union([pznRuleClauseSchema, pznRuleGroupSchema])).min(1).max(16),
  }).strict(),
);

export const pznRuleInputSchema = z.object({
  ruleId: pznSlugSchema,
  name: z.string().trim().min(1).max(100),
  businessDescription: z.string().trim().min(1).max(400),
  effect: z.enum(["include_when_true", "exclude_when_true"]).default("include_when_true"),
  rootGroup: pznRuleGroupSchema,
  workflow: workflowRecommendationSchema.nullable().optional(),
  status: z.enum(["draft", "published"]).default("published"),
}).strict();
export type PznRuleInput = z.infer<typeof pznRuleInputSchema>;

export const pznRuleSchema = pznRuleInputSchema.extend({
  dictionaryVersion: z.string().min(1),
  version: z.number().int().positive().default(1),
  builtIn: z.boolean().default(false),
  updatedAt: z.string(),
}).strict();
export type PznRule = z.infer<typeof pznRuleSchema>;

export const pznContentAttachmentSchema = z.object({
  contentId: pznSlugSchema,
  rank: z.number().int().positive().max(100),
  ruleIds: z.array(pznSlugSchema).max(12).default([]),
  ruleMatchMode: z.enum(["all", "any"]).default("all"),
}).strict();
export type PznContentAttachment = z.infer<typeof pznContentAttachmentSchema>;

export const pznContextInputSchema = z.object({
  contextId: pznSlugSchema,
  displayName: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(400),
  channel: z.enum(["chat", "web", "mobile", "all"]).default("all"),
  contextRuleIds: z.array(pznSlugSchema).max(8).default([]),
  attachments: z.array(pznContentAttachmentSchema).max(24).default([]),
}).strict();
export type PznContextInput = z.infer<typeof pznContextInputSchema>;

export const pznContextSchema = pznContextInputSchema.extend({
  status: z.enum(["draft", "published", "archived"]).default("draft"),
  publishedVersion: z.number().int().min(0).default(0),
  hasUnpublishedChanges: z.boolean().default(true),
  builtIn: z.boolean().default(false),
  updatedAt: z.string(),
}).strict();
export type PznContext = z.infer<typeof pznContextSchema>;

export const pznContextPublicationSchema = z.object({
  id: z.string().min(1),
  contextId: pznSlugSchema,
  version: z.number().int().positive(),
  publishedAt: z.string(),
  publishedBy: z.string().min(1),
  notes: z.string().max(240).default(""),
  dictionaryVersion: z.string().min(1),
  dictionary: pznDataDictionarySchema.optional(),
  context: pznContextSchema,
  contents: z.array(pznTextContentSchema),
  rules: z.array(pznRuleSchema),
}).strict();
export type PznContextPublication = z.infer<typeof pznContextPublicationSchema>;

export const pznTsEvaluateRequestSchema = z.object({
  mid: z.string().trim().min(1).max(100),
  contextId: pznSlugSchema,
  useDraft: z.boolean().optional(),
  attributeOverrides: z.record(z.string(), pznRuleValueSchema).optional(),
}).strict();
export type PznTsEvaluateRequest = z.infer<typeof pznTsEvaluateRequestSchema>;

export const pznRuleTestRequestSchema = z.object({
  mid: z.string().trim().min(1).max(100),
  rule: pznRuleInputSchema,
  attributeOverrides: z.record(z.string(), pznRuleValueSchema).optional(),
}).strict();
export type PznRuleTestRequest = z.infer<typeof pznRuleTestRequestSchema>;

export type PznClauseEvalResult = {
  clauseId: string;
  namespaceId: string;
  attributeId: string;
  attributeLabel: string;
  businessDefinition: string;
  operator: PznOperator;
  expectedValue: PznRuleValue | undefined;
  actualValue: unknown;
  passed: boolean;
  reason: string;
};

export type PznRuleEvalResult = {
  ruleId: string;
  ruleName: string;
  businessDescription: string;
  effect: "include_when_true" | "exclude_when_true";
  matched: boolean;
  effectiveAllow: boolean;
  combinator: "AND" | "OR";
  clauses: PznClauseEvalResult[];
  summary: string;
  evaluatedAt: string;
};

export type PznContentEvalResult = {
  contentId: string;
  title: string;
  headline: string;
  body: string;
  renderedBody: string;
  ctaLabel: string;
  ctaPrompt: string;
  disclosureText: string;
  tags: string[];
  rank: number;
  eligible: boolean;
  attachedRuleIds: string[];
  ruleMatchMode: "all" | "any";
  failedRuleIds: string[];
  reasonCode: "ELIGIBLE" | "RULE_FALSE" | "CONTEXT_RULE_FALSE" | "SUPPRESSED_BY_RULE" | "CONTENT_NOT_PUBLISHED";
  reason: string;
};

export type PznTsEvaluationResult = {
  evaluationId: string;
  mid: string;
  customerDisplayName: string;
  personaId?: string;
  contextId: string;
  contextDisplayName: string;
  sourceMode: "published" | "draft_preview";
  publicationVersion: number;
  dictionaryVersion: string;
  evaluatedAt: string;
  durationMs: number;
  contextGatePassed: boolean;
  resolvedAttributes: Record<string, unknown>;
  contextRuleResults: PznRuleEvalResult[];
  ruleResults: PznRuleEvalResult[];
  eligibleContents: PznContentEvalResult[];
  workflowMatches?: RuleWorkflowMatch[];
  filteredOutContents: PznContentEvalResult[];
  experiencePayload: {
    schemaVersion: "1.0";
    contextId: string;
    mid: string;
    eligibleContentIds: string[];
    cards: {
      contentId: string;
      title: string;
      headline: string;
      body: string;
      ctaLabel: string;
      ctaPrompt: string;
      disclosureText: string;
      rank: number;
    }[];
  };
};

export const pznDataDictionaryToolId = "cep.pzn.data_dictionary";
export const pznRuleMetadataToolId = "cep.pzn.rule_metadata";
export const pznTreatmentSelectorToolId = "cep.pzn.treatment_selector";
export const pznSfieldToolVersion = "1.0.0";

export const pznSfieldToolRefs = {
  dataDictionary: `${pznDataDictionaryToolId}@${pznSfieldToolVersion}`,
  ruleMetadata: `${pznRuleMetadataToolId}@${pznSfieldToolVersion}`,
  treatmentSelector: `${pznTreatmentSelectorToolId}@${pznSfieldToolVersion}`,
} as const;

export type PznRegisteredSfieldTool = {
  id: string;
  version: string;
  ref: string;
  label: string;
  effect: "read" | "write";
  description: string;
};

export const pznRegisteredSfieldTools: readonly PznRegisteredSfieldTool[] = [
  {
    id: pznDataDictionaryToolId,
    version: pznSfieldToolVersion,
    ref: pznSfieldToolRefs.dataDictionary,
    label: "Data Dictionary API",
    effect: "write",
    description: "Governed sfield tool for reading and authoring namespaces, attributes, business definitions, operators, and live Customer 360 resolver paths.",
  },
  {
    id: pznRuleMetadataToolId,
    version: pznSfieldToolVersion,
    ref: pznSfieldToolRefs.ruleMetadata,
    label: "Rule Metadata API",
    effect: "write",
    description: "Governed sfield tool for managing composable rules, text contents, contexts, content-rule attachments, and immutable Draft-to-Publish snapshots.",
  },
  {
    id: pznTreatmentSelectorToolId,
    version: pznSfieldToolVersion,
    ref: pznSfieldToolRefs.treatmentSelector,
    label: "Treatment Selector (TS) API",
    effect: "read",
    description: "Governed sfield tool that takes a Customer MID + Context, hydrates Data Dictionary attributes, calls the Rule Engine, filters contents, and returns eligible recommendations to the Experience Layer.",
  },
];

export const pznDataDictionaryToolInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation"],
  properties: {
    operation: {
      type: "string",
      enum: ["get_dictionary", "upsert_namespace", "delete_namespace", "upsert_attribute", "delete_attribute"],
    },
    payloadJson: { type: "string", maxLength: 32000 },
  },
} as const;

export const pznRuleMetadataToolInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation"],
  properties: {
    operation: {
      type: "string",
      enum: [
        "get_workspace",
        "list_rules",
        "upsert_rule",
        "delete_rule",
        "test_rule",
        "list_contents",
        "upsert_content",
        "delete_content",
        "list_contexts",
        "upsert_context",
        "delete_context",
        "publish_context",
        "unpublish_context",
      ],
    },
    payloadJson: { type: "string", maxLength: 32000 },
  },
} as const;

export const pznTreatmentSelectorToolInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation"],
  properties: {
    operation: {
      type: "string",
      enum: ["evaluate", "list_published_contexts"],
    },
    payloadJson: { type: "string", maxLength: 16000 },
  },
} as const;

export const pznGenericToolResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "operation", "summary", "resultJson"],
  properties: {
    ok: { type: "boolean" },
    operation: { type: "string", minLength: 1, maxLength: 64 },
    summary: { type: "string", minLength: 1, maxLength: 320 },
    resultJson: { type: "string", maxLength: 44000 },
  },
} as const;

export type PznStudioWorkspaceState = {
  dictionary: PznDataDictionary;
  contents: PznTextContent[];
  rules: PznRule[];
  contexts: PznContext[];
  publicationsByContext: Record<string, PznContextPublication[]>;
  customers: {
    personaId: string;
    syntheticMid: string;
    displayName: string;
    segment: string;
  }[];
  registeredSfieldTools: readonly PznRegisteredSfieldTool[];
};

export const pznCopilotRequestSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    text: z.string().max(1500),
  }).strict()).max(16).optional(),
  activeContextId: pznSlugSchema.optional(),
}).strict();
export type PznCopilotRequest = z.infer<typeof pznCopilotRequestSchema>;

export type PznCopilotActionLog = {
  tool: string;
  sfieldToolRef?: string;
  sfieldRunId?: string;
  summary: string;
  status: "ok" | "error" | "pending";
};

export type PznCopilotCard =
  | { kind: "dictionary"; namespaces: PznDictionaryNamespaceView[]; highlightKey?: string }
  | { kind: "content"; content: PznTextContent }
  | { kind: "rule"; rule: PznRule }
  | { kind: "rule_builder_widget"; initialNamespaceId?: string; initialAttributeId?: string }
  | { kind: "rules_catalog_widget"; rules: PznRule[] }
  | { kind: "context_matrix_widget"; contexts: PznContext[]; contents: PznTextContent[]; rules: PznRule[] }
  | { kind: "approval_request"; approval: ApprovalRecord }
  | { kind: "approvals_queue_widget" }
  | {
      kind: "context";
      context: PznContext;
      contents: PznTextContent[];
      rules: PznRule[];
      latestPublication?: PznContextPublication;
    }
  | { kind: "ts_evaluation"; evaluation: PznTsEvaluationResult }
  | {
      kind: "catalog_summary";
      contexts: PznContext[];
      contentsCount: number;
      rulesCount: number;
      attrCount: number;
    };

export type PznCopilotResponse = {
  reply: string;
  generatedBy: "copilot_llm" | "deterministic";
  actionsExecuted: PznCopilotActionLog[];
  cards: PznCopilotCard[];
  suggestedPrompts: string[];
  activeContextId?: string;
  workspace: PznStudioWorkspaceState;
};
