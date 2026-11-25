import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SqliteDatabase } from "@sfield/store-sqlite";
import type { ContentEntry, ContextCatalog } from "../../packages/contracts/domain";
import {
  pznAttributeInputSchema,
  pznContextInputSchema,
  pznNamespaceInputSchema,
  pznRuleInputSchema,
  pznRuleTestRequestSchema,
  pznTextContentInputSchema,
  pznTsEvaluateRequestSchema,
  type PznAttribute,
  type PznAttributeInput,
  type PznContext,
  type PznContextInput,
  type PznContextPublication,
  type PznDataDictionary,
  type PznNamespace,
  type PznNamespaceInput,
  type PznRule,
  type PznRuleEvalResult,
  type PznRuleInput,
  type PznRuleValue,
  type PznStudioWorkspaceState,
  type PznTextContent,
  type PznTextContentInput,
  type PznTsEvaluationResult,
  type PznTsEvaluateRequest,
} from "../../packages/contracts/self-service-pzn";
import { listAllProfiles } from "../../packages/customer-profiles";
import {
  evaluatePznRule,
  evaluateTreatmentSelector,
  pznTextContentToCatalogEntry,
  registerActiveSelfServicePznProvider,
  resolveAttributesForMid,
  validateRuleAgainstDictionary,
  type ActiveSelfServicePznProvider,
} from "../../packages/recommendations/self-service-engine";
import { ApiError } from "./store";

function nowIso() {
  return new Date().toISOString();
}

const DICTIONARY_VERSION = "cep-dict-v2";

function seedNamespaces(ts: string): PznNamespace[] {
  return [
    {
      id: "customer",
      displayName: "Customer Profile",
      businessDefinition: "Core customer identity, lifecycle segment, relationship tenure, and compliance profile sourced from Customer 360.",
      owner: "Customer Data Platform",
      sourceSystem: "customer_360",
      builtIn: true,
      updatedAt: ts,
    },
    {
      id: "account",
      displayName: "Account & Funding",
      businessDefinition: "Account operational status, liquidity balances, and funding milestones used to trigger onboarding and deposit nudges.",
      owner: "Core Brokerage Ledger",
      sourceSystem: "customer_360",
      builtIn: true,
      updatedAt: ts,
    },
    {
      id: "portfolio",
      displayName: "Portfolio Holdings",
      businessDefinition: "Real-time asset mix across cash, equities, and fixed income used for wealth optimization and cash-sweep recommendations.",
      owner: "Wealth Analytics",
      sourceSystem: "portfolio_snapshot",
      builtIn: true,
      updatedAt: ts,
    },
    {
      id: "goals",
      displayName: "Financial Goals",
      businessDefinition: "Customer-declared savings targets (e.g., home down payment) and funded progress ratios.",
      owner: "Goal Planning Engine",
      sourceSystem: "goal_progress",
      builtIn: true,
      updatedAt: ts,
    },
    {
      id: "conversation",
      displayName: "Session & Channel",
      businessDefinition: "Live interaction context including channel surface and conversational turn depth.",
      owner: "Experience Layer",
      sourceSystem: "session_context",
      builtIn: true,
      updatedAt: ts,
    },
  ];
}

function seedAttributes(ts: string): PznAttribute[] {
  return [
    {
      id: "segment",
      namespaceId: "customer",
      displayName: "Customer Segment",
      businessDefinition: "Commercial tier assigned to the member based on relationship assets and advisory eligibility (e.g., Mass Affluent, Emerging Investor, Private Client).",
      dataType: "string",
      allowedOperators: ["eq", "ne", "contains", "in", "not_in", "exists"],
      enumOptions: [],
      unit: "",
      sampleValue: "Mass Affluent",
      resolverPath: "customer.segment",
      piiClassification: "internal",
      builtIn: true,
      updatedAt: ts,
    },
    {
      id: "beneficiary_status",
      namespaceId: "customer",
      displayName: "Beneficiary Designation Status",
      businessDefinition: "Indicates whether the member has at least one primary beneficiary formally recorded on eligible retirement/brokerage accounts.",
      dataType: "enum",
      allowedOperators: ["eq", "ne", "in", "not_in"],
      enumOptions: [
        { value: "missing", label: "Missing", definition: "No primary beneficiary on file; eligible for compliance & estate planning prompts." },
        { value: "on_file", label: "On File", definition: "At least one verified beneficiary is recorded on the account." },
      ],
      unit: "",
      sampleValue: "missing",
      resolverPath: "customer.beneficiary_status",
      piiClassification: "internal",
      builtIn: true,
      updatedAt: ts,
    },
    {
      id: "is_returning",
      namespaceId: "customer",
      displayName: "Returning Member",
      businessDefinition: "True when the member has completed prior authenticated digital advisory sessions.",
      dataType: "boolean",
      allowedOperators: ["eq", "ne"],
      enumOptions: [],
      unit: "",
      sampleValue: "true",
      resolverPath: "customer.is_returning",
      piiClassification: "none",
      builtIn: true,
      updatedAt: ts,
    },
    {
      id: "funding_status",
      namespaceId: "account",
      displayName: "Account Funding Status",
      businessDefinition: "Tracks whether the primary investment account has received and settled its initial deposit.",
      dataType: "enum",
      allowedOperators: ["eq", "ne", "in", "not_in"],
      enumOptions: [
        { value: "unfunded", label: "Unfunded", definition: "Zero settled deposits; eligible for first-deposit onboarding offers." },
        { value: "funded", label: "Funded", definition: "At least one settled deposit has posted to the account." },
      ],
      unit: "",
      sampleValue: "unfunded",
      resolverPath: "account.funding_status",
      piiClassification: "internal",
      builtIn: true,
      updatedAt: ts,
    },
    {
      id: "available_balance_usd",
      namespaceId: "account",
      displayName: "Available Balance (USD)",
      businessDefinition: "Settled liquid cash immediately available for withdrawal, transfer, or trade execution in US dollars.",
      dataType: "currency_usd",
      allowedOperators: ["eq", "ne", "gt", "gte", "lt", "lte"],
      enumOptions: [],
      unit: "USD",
      sampleValue: "14500",
      resolverPath: "account.available_balance_usd",
      piiClassification: "internal",
      builtIn: true,
      updatedAt: ts,
    },
    {
      id: "cash_usd",
      namespaceId: "portfolio",
      displayName: "Portfolio Cash Balance (USD)",
      businessDefinition: "Uninvested core cash held across the member's portfolio snapshot. Used by cash-management and high-yield sweep eligibility rules.",
      dataType: "currency_usd",
      allowedOperators: ["eq", "ne", "gt", "gte", "lt", "lte"],
      enumOptions: [],
      unit: "USD",
      sampleValue: "35738.20",
      resolverPath: "portfolio.cash_usd",
      piiClassification: "internal",
      builtIn: true,
      updatedAt: ts,
    },
    {
      id: "total_value_usd",
      namespaceId: "portfolio",
      displayName: "Total Portfolio Value (USD)",
      businessDefinition: "Aggregate market value of cash, equities, and fixed income holdings across the member's portfolio.",
      dataType: "currency_usd",
      allowedOperators: ["eq", "ne", "gt", "gte", "lt", "lte"],
      enumOptions: [],
      unit: "USD",
      sampleValue: "120304",
      resolverPath: "portfolio.total_value_usd",
      piiClassification: "internal",
      builtIn: true,
      updatedAt: ts,
    },
    {
      id: "cash_share_pct",
      namespaceId: "portfolio",
      displayName: "Cash Allocation Share (%)",
      businessDefinition: "Percentage of total portfolio value sitting in uninvested cash (portfolio.cash_usd / portfolio.total_value_usd * 100).",
      dataType: "number",
      allowedOperators: ["eq", "ne", "gt", "gte", "lt", "lte"],
      enumOptions: [],
      unit: "%",
      sampleValue: "29.7",
      resolverPath: "portfolio.cash_share_pct",
      piiClassification: "none",
      builtIn: true,
      updatedAt: ts,
    },
    {
      id: "home_funded_pct",
      namespaceId: "goals",
      displayName: "Home Goal Funded (%)",
      businessDefinition: "Percentage of the customer's stated home down-payment goal currently accumulated.",
      dataType: "number",
      allowedOperators: ["eq", "ne", "gt", "gte", "lt", "lte"],
      enumOptions: [],
      unit: "%",
      sampleValue: "52",
      resolverPath: "goals.home_funded_pct",
      piiClassification: "none",
      builtIn: true,
      updatedAt: ts,
    },
    {
      id: "home_remaining_usd",
      namespaceId: "goals",
      displayName: "Home Goal Remaining Gap (USD)",
      businessDefinition: "Dollar shortfall remaining to reach the customer's home down-payment target.",
      dataType: "currency_usd",
      allowedOperators: ["eq", "ne", "gt", "gte", "lt", "lte"],
      enumOptions: [],
      unit: "USD",
      sampleValue: "24000",
      resolverPath: "goals.home_remaining_usd",
      piiClassification: "internal",
      builtIn: true,
      updatedAt: ts,
    },
    {
      id: "turn_number",
      namespaceId: "conversation",
      displayName: "Conversation Turn Number",
      businessDefinition: "1-indexed count of messages in the active conversation; useful for frequency capping or progressive disclosure.",
      dataType: "number",
      allowedOperators: ["eq", "ne", "gt", "gte", "lt", "lte"],
      enumOptions: [],
      unit: "turns",
      sampleValue: "1",
      resolverPath: "conversation.turn_number",
      piiClassification: "none",
      builtIn: true,
      updatedAt: ts,
    },
  ];
}

function seedContents(ts: string): PznTextContent[] {
  return [
    {
      contentId: "cash_yield_sweep_offer",
      title: "Put idle cash to work with automated cash sweep",
      headline: "You have {{portfolio.cash_usd}} sitting in core cash ({{portfolio.cash_share_pct}} of your portfolio).",
      body: "Customers holding more than $10,000 in core cash can move excess liquidity into a high-yield cash sweep or short-duration treasury ladder while keeping daily liquidity.",
      ctaLabel: "Explore cash options",
      ctaPrompt: "Show me options for my excess cash balance.",
      disclosureText: "Yield rates are illustrative and subject to market conditions. Cash sweep options are reviewed before any transfer.",
      tags: ["cash", "yield", "wealth"],
      status: "published",
      version: 1,
      builtIn: true,
      updatedAt: ts,
    },
    {
      contentId: "beneficiary_reminder_text",
      title: "Add a beneficiary to protect your account",
      headline: "Your account currently does not have a beneficiary on file.",
      body: "Designating a beneficiary takes less than two minutes and ensures your assets transfer directly according to your wishes without probate delays.",
      ctaLabel: "Review beneficiary steps",
      ctaPrompt: "How do I add a beneficiary to my account?",
      disclosureText: "Beneficiary designations can be updated at any time.",
      tags: ["compliance", "beneficiary", "estate"],
      status: "published",
      version: 1,
      builtIn: true,
      updatedAt: ts,
    },
    {
      contentId: "first_deposit_welcome_text",
      title: "Make your first deposit to activate investing",
      headline: "Your brokerage account is open and ready for funding.",
      body: "Link an external bank account or schedule a one-time transfer to start putting your savings plan into action with zero account minimums.",
      ctaLabel: "Start funding preview",
      ctaPrompt: "Help me fund my account.",
      disclosureText: "Electronic bank transfers typically settle within 1–3 business days.",
      tags: ["onboarding", "funding"],
      status: "published",
      version: 1,
      builtIn: true,
      updatedAt: ts,
    },
    {
      contentId: "home_goal_accelerator_text",
      title: "Accelerate your home down-payment timeline",
      headline: "You are {{goals.home_funded_pct}} funded with {{goals.home_remaining_usd}} remaining.",
      body: "Pairing a recurring monthly contribution with a partial transfer from idle portfolio cash can close your down-payment gap months sooner.",
      ctaLabel: "Model home savings plan",
      ctaPrompt: "I want to buy a house in two years. Show me how close I am and help me explore a savings plan.",
      disclosureText: "Projections assume consistent contributions and do not reflect taxes or market returns.",
      tags: ["goals", "home-buying"],
      status: "published",
      version: 1,
      builtIn: true,
      updatedAt: ts,
    },
  ];
}

function seedRules(ts: string): PznRule[] {
  return [
    {
      ruleId: "high_idle_cash_rule",
      name: "High Idle Cash (> $10,000 & > 15% Cash)",
      businessDescription: "Targets customers with more than $10,000 in portfolio cash whose cash allocation exceeds 15% of total portfolio value.",
      effect: "include_when_true",
      rootGroup: {
        id: "grp_root_cash",
        kind: "group",
        combinator: "AND",
        children: [
          { id: "cl_cash_1", kind: "clause", namespaceId: "portfolio", attributeId: "cash_usd", operator: "gt", value: 10000 },
          { id: "cl_cash_2", kind: "clause", namespaceId: "portfolio", attributeId: "cash_share_pct", operator: "gt", value: 15 },
        ],
      },
      dictionaryVersion: DICTIONARY_VERSION,
      status: "published",
      version: 1,
      builtIn: true,
      updatedAt: ts,
    },
    {
      ruleId: "missing_beneficiary_rule",
      name: "Beneficiary Missing",
      businessDescription: "Identifies members whose Customer 360 profile shows no primary beneficiary designation on file.",
      effect: "include_when_true",
      rootGroup: {
        id: "grp_root_bene",
        kind: "group",
        combinator: "AND",
        children: [
          { id: "cl_bene_1", kind: "clause", namespaceId: "customer", attributeId: "beneficiary_status", operator: "eq", value: "missing" },
        ],
      },
      dictionaryVersion: DICTIONARY_VERSION,
      status: "published",
      version: 1,
      builtIn: true,
      updatedAt: ts,
    },
    {
      ruleId: "unfunded_account_rule",
      name: "Account Unfunded",
      businessDescription: "Matches members whose primary account has not yet received its initial deposit.",
      effect: "include_when_true",
      rootGroup: {
        id: "grp_root_fund",
        kind: "group",
        combinator: "AND",
        children: [
          { id: "cl_fund_1", kind: "clause", namespaceId: "account", attributeId: "funding_status", operator: "eq", value: "unfunded" },
        ],
      },
      dictionaryVersion: DICTIONARY_VERSION,
      status: "published",
      version: 1,
      builtIn: true,
      updatedAt: ts,
    },
    {
      ruleId: "home_goal_in_progress_rule",
      name: "Home Goal Active & Under 100% Funded",
      businessDescription: "Eligible when the customer has an active home down-payment goal with a remaining funding gap above $0.",
      effect: "include_when_true",
      rootGroup: {
        id: "grp_root_home",
        kind: "group",
        combinator: "AND",
        children: [
          { id: "cl_home_1", kind: "clause", namespaceId: "goals", attributeId: "home_remaining_usd", operator: "gt", value: 0 },
          { id: "cl_home_2", kind: "clause", namespaceId: "goals", attributeId: "home_funded_pct", operator: "lt", value: 100 },
        ],
      },
      dictionaryVersion: DICTIONARY_VERSION,
      status: "published",
      version: 1,
      builtIn: true,
      updatedAt: ts,
    },
  ];
}

function seedContexts(ts: string): PznContext[] {
  return [
    {
      contextId: "wealth-next-best-offers",
      displayName: "Wealth Next-Best Offers",
      description: "Personalized text recommendations for cash optimization, beneficiary protection, home-buying acceleration, and first-deposit onboarding.",
      channel: "all",
      contextRuleIds: [],
      attachments: [
        { contentId: "cash_yield_sweep_offer", rank: 1, ruleIds: ["high_idle_cash_rule"], ruleMatchMode: "all" },
        { contentId: "home_goal_accelerator_text", rank: 2, ruleIds: ["home_goal_in_progress_rule"], ruleMatchMode: "all" },
        { contentId: "beneficiary_reminder_text", rank: 3, ruleIds: ["missing_beneficiary_rule"], ruleMatchMode: "all" },
        { contentId: "first_deposit_welcome_text", rank: 4, ruleIds: ["unfunded_account_rule"], ruleMatchMode: "all" },
      ],
      status: "published",
      publishedVersion: 1,
      hasUnpublishedChanges: false,
      builtIn: true,
      updatedAt: ts,
    },
  ];
}

export class SelfServicePznStore implements ActiveSelfServicePznProvider {
  private readonly db: SqliteDatabase;
  private readonly ownsDb: boolean;
  private readonly lastRenderedByContentId = new Map<string, { headline: string; body: string }>();

  constructor(dataDirOrDb: string | SqliteDatabase) {
    if (typeof dataDirOrDb === "string") {
      mkdirSync(dataDirOrDb, { recursive: true });
      this.db = new SqliteDatabase(join(dataDirOrDb, "self-service-pzn.sqlite"));
      this.db.open();
      this.ownsDb = true;
    } else {
      this.db = dataDirOrDb;
      this.ownsDb = false;
    }
    this.initSchema();
    this.seedDefaults();
    registerActiveSelfServicePznProvider(this);
  }

  close() {
    registerActiveSelfServicePznProvider(null);
    if (this.ownsDb) this.db.close();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pzn_namespaces (
        id TEXT PRIMARY KEY,
        record TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pzn_attributes (
        key TEXT PRIMARY KEY,
        namespace_id TEXT NOT NULL,
        record TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pzn_contents (
        content_id TEXT PRIMARY KEY,
        record TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pzn_rules (
        rule_id TEXT PRIMARY KEY,
        record TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pzn_contexts (
        context_id TEXT PRIMARY KEY,
        record TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pzn_publications (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        published_at TEXT NOT NULL,
        record TEXT NOT NULL,
        UNIQUE(context_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_pzn_publications_ctx ON pzn_publications(context_id, version DESC);
    `);
  }

  private seedDefaults() {
    const existingNs = this.db.one<{ c: number }>("SELECT COUNT(*) as c FROM pzn_namespaces");
    if (existingNs && existingNs.c > 0) return;

    const ts = nowIso();
    const namespaces = seedNamespaces(ts);
    const attributes = seedAttributes(ts);
    const contents = seedContents(ts);
    const rules = seedRules(ts);
    const contexts = seedContexts(ts);

    this.db.tx(() => {
      for (const ns of namespaces) {
        this.db.run("INSERT OR IGNORE INTO pzn_namespaces (id, record, updated_at) VALUES (?, ?, ?)", ns.id, JSON.stringify(ns), ts);
      }
      for (const attr of attributes) {
        this.db.run("INSERT OR IGNORE INTO pzn_attributes (key, namespace_id, record, updated_at) VALUES (?, ?, ?, ?)", `${attr.namespaceId}.${attr.id}`, attr.namespaceId, JSON.stringify(attr), ts);
      }
      for (const content of contents) {
        this.db.run("INSERT OR IGNORE INTO pzn_contents (content_id, record, updated_at) VALUES (?, ?, ?)", content.contentId, JSON.stringify(content), ts);
      }
      for (const rule of rules) {
        this.db.run("INSERT OR IGNORE INTO pzn_rules (rule_id, record, updated_at) VALUES (?, ?, ?)", rule.ruleId, JSON.stringify(rule), ts);
      }
      for (const ctx of contexts) {
        this.db.run("INSERT OR IGNORE INTO pzn_contexts (context_id, record, updated_at) VALUES (?, ?, ?)", ctx.contextId, JSON.stringify(ctx), ts);
        const pub: PznContextPublication = {
          id: "pub_" + randomUUID().replaceAll("-", "").slice(0, 12),
          contextId: ctx.contextId,
          version: 1,
          publishedAt: ts,
          publishedBy: "System Seed",
          notes: "Initial self-service showcase publication.",
          dictionaryVersion: DICTIONARY_VERSION,
          context: ctx,
          contents,
          rules,
        };
        this.db.run(
          "INSERT OR IGNORE INTO pzn_publications (id, context_id, version, published_at, record) VALUES (?, ?, ?, ?, ?)",
          pub.id, pub.contextId, pub.version, pub.publishedAt, JSON.stringify(pub),
        );
      }
    });
  }

  // ---- Data Dictionary ----

  getDictionary(): PznDataDictionary {
    const nsRows = this.db.all<{ record: string }>("SELECT record FROM pzn_namespaces ORDER BY id");
    const attrRows = this.db.all<{ record: string }>("SELECT record FROM pzn_attributes ORDER BY key");
    const namespaces = nsRows.map((r) => JSON.parse(r.record) as PznNamespace);
    const attributes = attrRows.map((r) => JSON.parse(r.record) as PznAttribute);
    const byNs = new Map<string, PznAttribute[]>();
    for (const a of attributes) {
      const list = byNs.get(a.namespaceId) ?? [];
      list.push(a);
      byNs.set(a.namespaceId, list);
    }
    const latestTs = [...namespaces, ...attributes].reduce((max, item) => (item.updatedAt > max ? item.updatedAt : max), "");
    return {
      version: DICTIONARY_VERSION,
      updatedAt: latestTs || nowIso(),
      namespaces: namespaces.map((ns) => ({ ...ns, attributes: byNs.get(ns.id) ?? [] })),
    };
  }

  upsertNamespace(raw: PznNamespaceInput | unknown): PznNamespace {
    const input = pznNamespaceInputSchema.parse(raw);
    const existingRow = this.db.one<{ record: string }>("SELECT record FROM pzn_namespaces WHERE id = ?", input.id);
    const existing = existingRow ? JSON.parse(existingRow.record) as PznNamespace : undefined;
    const saved: PznNamespace = {
      ...input,
      builtIn: existing?.builtIn ?? false,
      updatedAt: nowIso(),
    };
    this.db.run(
      `INSERT INTO pzn_namespaces (id, record, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET record = excluded.record, updated_at = excluded.updated_at`,
      saved.id, JSON.stringify(saved), saved.updatedAt,
    );
    return saved;
  }

  deleteNamespace(id: string) {
    const existingRow = this.db.one<{ record: string }>("SELECT record FROM pzn_namespaces WHERE id = ?", id);
    if (!existingRow) throw new ApiError(404, "namespace_not_found", `Namespace "${id}" not found.`);
    const existing = JSON.parse(existingRow.record) as PznNamespace;
    if (existing.builtIn) throw new ApiError(400, "builtin_protected", `Built-in namespace "${id}" cannot be deleted.`);
    const attrs = this.db.one<{ c: number }>("SELECT COUNT(*) as c FROM pzn_attributes WHERE namespace_id = ?", id);
    if (attrs && attrs.c > 0) {
      throw new ApiError(409, "namespace_has_attributes", `Remove all attributes in "${id}" before deleting the namespace.`);
    }
    this.db.run("DELETE FROM pzn_namespaces WHERE id = ?", id);
  }

  upsertAttribute(raw: PznAttributeInput | unknown): PznAttribute {
    const input = pznAttributeInputSchema.parse(raw);
    const nsRow = this.db.one<{ id: string }>("SELECT id FROM pzn_namespaces WHERE id = ?", input.namespaceId);
    if (!nsRow) {
      throw new ApiError(404, "namespace_not_found", `Namespace "${input.namespaceId}" does not exist. Create it first.`);
    }
    const key = `${input.namespaceId}.${input.id}`;
    const existingRow = this.db.one<{ record: string }>("SELECT record FROM pzn_attributes WHERE key = ?", key);
    const existing = existingRow ? JSON.parse(existingRow.record) as PznAttribute : undefined;
    const saved: PznAttribute = {
      ...input,
      builtIn: existing?.builtIn ?? false,
      updatedAt: nowIso(),
    };
    this.db.run(
      `INSERT INTO pzn_attributes (key, namespace_id, record, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET namespace_id = excluded.namespace_id, record = excluded.record, updated_at = excluded.updated_at`,
      key, saved.namespaceId, JSON.stringify(saved), saved.updatedAt,
    );
    return saved;
  }

  deleteAttribute(namespaceId: string, attributeId: string) {
    const key = `${namespaceId}.${attributeId}`;
    const existingRow = this.db.one<{ record: string }>("SELECT record FROM pzn_attributes WHERE key = ?", key);
    if (!existingRow) throw new ApiError(404, "attribute_not_found", `Attribute "${key}" not found.`);
    const existing = JSON.parse(existingRow.record) as PznAttribute;
    if (existing.builtIn) throw new ApiError(400, "builtin_protected", `Built-in attribute "${key}" cannot be deleted.`);
    this.db.run("DELETE FROM pzn_attributes WHERE key = ?", key);
  }

  // ---- Text Content Library ----

  listContents(): PznTextContent[] {
    return this.db.all<{ record: string }>("SELECT record FROM pzn_contents ORDER BY updated_at DESC, content_id")
      .map((r) => JSON.parse(r.record) as PznTextContent);
  }

  getContent(contentId: string): PznTextContent | undefined {
    const row = this.db.one<{ record: string }>("SELECT record FROM pzn_contents WHERE content_id = ?", contentId);
    return row ? JSON.parse(row.record) as PznTextContent : undefined;
  }

  upsertContent(raw: PznTextContentInput | unknown): PznTextContent {
    const input = pznTextContentInputSchema.parse(raw);
    const existing = this.getContent(input.contentId);
    const saved: PznTextContent = {
      ...input,
      version: (existing?.version ?? 0) + 1,
      builtIn: existing?.builtIn ?? false,
      updatedAt: nowIso(),
    };
    this.db.run(
      `INSERT INTO pzn_contents (content_id, record, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(content_id) DO UPDATE SET record = excluded.record, updated_at = excluded.updated_at`,
      saved.contentId, JSON.stringify(saved), saved.updatedAt,
    );
    this.markReferencingContextsDirty({ contentId: saved.contentId });
    return saved;
  }

  deleteContent(contentId: string) {
    const existing = this.getContent(contentId);
    if (!existing) throw new ApiError(404, "content_not_found", `Content "${contentId}" not found.`);
    const referencing = this.listContexts().filter((c) => c.attachments.some((a) => a.contentId === contentId));
    if (referencing.length > 0) {
      throw new ApiError(409, "content_in_use", `Content "${contentId}" is attached to context(s): ${referencing.map((c) => c.contextId).join(", ")}. Detach it first.`);
    }
    this.db.run("DELETE FROM pzn_contents WHERE content_id = ?", contentId);
  }

  // ---- Composable Rules ----

  listRules(): PznRule[] {
    return this.db.all<{ record: string }>("SELECT record FROM pzn_rules ORDER BY updated_at DESC, rule_id")
      .map((r) => JSON.parse(r.record) as PznRule);
  }

  getRule(ruleId: string): PznRule | undefined {
    const row = this.db.one<{ record: string }>("SELECT record FROM pzn_rules WHERE rule_id = ?", ruleId);
    return row ? JSON.parse(row.record) as PznRule : undefined;
  }

  upsertRule(raw: PznRuleInput | unknown): PznRule {
    const input = pznRuleInputSchema.parse(raw);
    const dictionary = this.getDictionary();
    const validationErrors = validateRuleAgainstDictionary(input, dictionary);
    if (validationErrors.length > 0) {
      throw new ApiError(400, "invalid_rule_definition", validationErrors.join(" "));
    }
    const existing = this.getRule(input.ruleId);
    const saved: PznRule = {
      ...input,
      dictionaryVersion: dictionary.version,
      version: (existing?.version ?? 0) + 1,
      builtIn: existing?.builtIn ?? false,
      updatedAt: nowIso(),
    };
    this.db.run(
      `INSERT INTO pzn_rules (rule_id, record, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(rule_id) DO UPDATE SET record = excluded.record, updated_at = excluded.updated_at`,
      saved.ruleId, JSON.stringify(saved), saved.updatedAt,
    );
    this.markReferencingContextsDirty({ ruleId: saved.ruleId });
    return saved;
  }

  deleteRule(ruleId: string) {
    const existing = this.getRule(ruleId);
    if (!existing) throw new ApiError(404, "rule_not_found", `Rule "${ruleId}" not found.`);
    const referencing = this.listContexts().filter((c) => (
      c.contextRuleIds.includes(ruleId) || c.attachments.some((a) => a.ruleIds.includes(ruleId))
    ));
    if (referencing.length > 0) {
      throw new ApiError(409, "rule_in_use", `Rule "${ruleId}" is attached to context(s): ${referencing.map((c) => c.contextId).join(", ")}. Detach it first.`);
    }
    this.db.run("DELETE FROM pzn_rules WHERE rule_id = ?", ruleId);
  }

  testRule(raw: unknown): {
    mid: string;
    customerDisplayName: string;
    resolvedAttributes: Record<string, unknown>;
    evaluation: PznRuleEvalResult;
  } {
    const req = pznRuleTestRequestSchema.parse(raw);
    const dictionary = this.getDictionary();
    const validationErrors = validateRuleAgainstDictionary(req.rule, dictionary);
    if (validationErrors.length > 0) {
      throw new ApiError(400, "invalid_rule_definition", validationErrors.join(" "));
    }
    const { customerDisplayName, attributes } = resolveAttributesForMid(req.mid, dictionary, req.attributeOverrides);
    const evaluation = evaluatePznRule(req.rule, attributes, dictionary);
    return { mid: req.mid, customerDisplayName, resolvedAttributes: attributes, evaluation };
  }

  // ---- Contexts & Publish Lifecycle ----

  listContexts(): PznContext[] {
    return this.db.all<{ record: string }>("SELECT record FROM pzn_contexts ORDER BY updated_at DESC, context_id")
      .map((r) => JSON.parse(r.record) as PznContext);
  }

  getContext(contextId: string): PznContext | undefined {
    const row = this.db.one<{ record: string }>("SELECT record FROM pzn_contexts WHERE context_id = ?", contextId);
    return row ? JSON.parse(row.record) as PznContext : undefined;
  }

  upsertContext(raw: PznContextInput | unknown): PznContext {
    const input = pznContextInputSchema.parse(raw);
    const contentIds = new Set(this.listContents().map((c) => c.contentId));
    const ruleIds = new Set(this.listRules().map((r) => r.ruleId));

    for (const rId of input.contextRuleIds) {
      if (!ruleIds.has(rId)) throw new ApiError(400, "unknown_rule", `Context rule "${rId}" does not exist.`);
    }
    const seenContent = new Set<string>();
    for (const att of input.attachments) {
      if (!contentIds.has(att.contentId)) throw new ApiError(400, "unknown_content", `Attached content "${att.contentId}" does not exist.`);
      if (seenContent.has(att.contentId)) throw new ApiError(400, "duplicate_attachment", `Content "${att.contentId}" is attached more than once.`);
      seenContent.add(att.contentId);
      for (const rId of att.ruleIds) {
        if (!ruleIds.has(rId)) throw new ApiError(400, "unknown_rule", `Rule "${rId}" attached to "${att.contentId}" does not exist.`);
      }
    }

    const existing = this.getContext(input.contextId);
    const normalizedAttachments = [...input.attachments]
      .sort((a, b) => a.rank - b.rank)
      .map((att, idx) => ({ ...att, rank: idx + 1 }));

    const saved: PznContext = {
      ...input,
      attachments: normalizedAttachments,
      status: existing?.publishedVersion ? existing.status : "draft",
      publishedVersion: existing?.publishedVersion ?? 0,
      hasUnpublishedChanges: true,
      builtIn: existing?.builtIn ?? false,
      updatedAt: nowIso(),
    };
    this.db.run(
      `INSERT INTO pzn_contexts (context_id, record, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(context_id) DO UPDATE SET record = excluded.record, updated_at = excluded.updated_at`,
      saved.contextId, JSON.stringify(saved), saved.updatedAt,
    );
    return saved;
  }

  deleteContext(contextId: string) {
    const existing = this.getContext(contextId);
    if (!existing) throw new ApiError(404, "context_not_found", `Context "${contextId}" not found.`);
    this.db.tx(() => {
      this.db.run("DELETE FROM pzn_publications WHERE context_id = ?", contextId);
      this.db.run("DELETE FROM pzn_contexts WHERE context_id = ?", contextId);
    });
  }

  publishContext(contextId: string, publishedBy = "Admin Operator", notes = ""): PznContextPublication {
    const ctx = this.getContext(contextId);
    if (!ctx) throw new ApiError(404, "context_not_found", `Context "${contextId}" not found.`);
    if (ctx.attachments.length === 0) {
      throw new ApiError(400, "empty_context", "Attach at least one text content item before publishing this context.");
    }

    const dictionary = this.getDictionary();
    const attachedContents: PznTextContent[] = [];
    const ruleIdSet = new Set<string>(ctx.contextRuleIds);

    for (const att of ctx.attachments) {
      const content = this.getContent(att.contentId);
      if (!content) throw new ApiError(400, "unknown_content", `Attached content "${att.contentId}" no longer exists.`);
      attachedContents.push({ ...content, status: "published" });
      for (const rId of att.ruleIds) ruleIdSet.add(rId);
    }

    const attachedRules: PznRule[] = [];
    for (const rId of ruleIdSet) {
      const rule = this.getRule(rId);
      if (!rule) throw new ApiError(400, "unknown_rule", `Attached rule "${rId}" no longer exists.`);
      const errs = validateRuleAgainstDictionary(rule, dictionary);
      if (errs.length > 0) throw new ApiError(400, "invalid_rule_definition", `Rule "${rule.name}": ${errs.join(" ")}`);
      attachedRules.push({ ...rule, status: "published" });
    }

    const nextVersion = (ctx.publishedVersion ?? 0) + 1;
    const ts = nowIso();
    const updatedCtx: PznContext = {
      ...ctx,
      status: "published",
      publishedVersion: nextVersion,
      hasUnpublishedChanges: false,
      updatedAt: ts,
    };

    const publication: PznContextPublication = {
      id: "pub_" + randomUUID().replaceAll("-", "").slice(0, 12),
      contextId: ctx.contextId,
      version: nextVersion,
      publishedAt: ts,
      publishedBy: publishedBy.trim() || "Admin Operator",
      notes: notes.trim().slice(0, 240),
      dictionaryVersion: dictionary.version,
      context: updatedCtx,
      contents: attachedContents,
      rules: attachedRules,
    };

    this.db.tx(() => {
      this.db.run(
        "UPDATE pzn_contexts SET record = ?, updated_at = ? WHERE context_id = ?",
        JSON.stringify(updatedCtx), ts, ctx.contextId,
      );
      this.db.run(
        "INSERT INTO pzn_publications (id, context_id, version, published_at, record) VALUES (?, ?, ?, ?, ?)",
        publication.id, publication.contextId, publication.version, publication.publishedAt, JSON.stringify(publication),
      );
    });

    return publication;
  }

  unpublishContext(contextId: string): PznContext {
    const ctx = this.getContext(contextId);
    if (!ctx) throw new ApiError(404, "context_not_found", `Context "${contextId}" not found.`);
    const updated: PznContext = {
      ...ctx,
      status: "draft",
      hasUnpublishedChanges: true,
      updatedAt: nowIso(),
    };
    this.db.run(
      "UPDATE pzn_contexts SET record = ?, updated_at = ? WHERE context_id = ?",
      JSON.stringify(updated), updated.updatedAt, contextId,
    );
    return updated;
  }

  listPublications(contextId: string): PznContextPublication[] {
    return this.db.all<{ record: string }>(
      "SELECT record FROM pzn_publications WHERE context_id = ? ORDER BY version DESC LIMIT 20",
      contextId,
    ).map((r) => JSON.parse(r.record) as PznContextPublication);
  }

  getPublishedPublication(contextId: string): PznContextPublication | undefined {
    const ctx = this.getContext(contextId);
    if (!ctx || ctx.status !== "published" || ctx.publishedVersion < 1) return undefined;
    const row = this.db.one<{ record: string }>(
      "SELECT record FROM pzn_publications WHERE context_id = ? AND version = ?",
      contextId, ctx.publishedVersion,
    );
    return row ? JSON.parse(row.record) as PznContextPublication : undefined;
  }

  private markReferencingContextsDirty(ref: { contentId?: string; ruleId?: string }) {
    const contexts = this.listContexts();
    for (const ctx of contexts) {
      const hitContent = ref.contentId && ctx.attachments.some((a) => a.contentId === ref.contentId);
      const hitRule = ref.ruleId && (ctx.contextRuleIds.includes(ref.ruleId) || ctx.attachments.some((a) => a.ruleIds.includes(ref.ruleId!)));
      if ((hitContent || hitRule) && !ctx.hasUnpublishedChanges) {
        const updated: PznContext = { ...ctx, hasUnpublishedChanges: true, updatedAt: nowIso() };
        this.db.run("UPDATE pzn_contexts SET record = ?, updated_at = ? WHERE context_id = ?", JSON.stringify(updated), updated.updatedAt, ctx.contextId);
      }
    }
  }

  // ---- Live Treatment Selector Evaluation ----

  evaluateLiveTs(raw: PznTsEvaluateRequest): PznTsEvaluationResult {
    const req = pznTsEvaluateRequestSchema.parse(raw);
    const dictionary = this.getDictionary();

    if (req.useDraft) {
      const ctx = this.getContext(req.contextId);
      if (!ctx) throw new ApiError(404, "context_not_found", `Context "${req.contextId}" not found.`);
      return evaluateTreatmentSelector({
        mid: req.mid,
        context: ctx,
        contents: this.listContents(),
        rules: this.listRules(),
        dictionary,
        sourceMode: "draft_preview",
        publicationVersion: ctx.publishedVersion,
        attributeOverrides: req.attributeOverrides,
      });
    }

    const pub = this.getPublishedPublication(req.contextId);
    if (!pub) {
      const exists = this.getContext(req.contextId);
      if (exists) {
        throw new ApiError(409, "context_not_published", `Context "${req.contextId}" is currently in Draft. Publish it first (or enable Draft preview).`);
      }
      throw new ApiError(404, "context_not_found", `Published context "${req.contextId}" not found in Treatment Selector.`);
    }

    return evaluateTreatmentSelector({
      mid: req.mid,
      context: pub.context,
      contents: pub.contents,
      rules: pub.rules,
      dictionary,
      sourceMode: "published",
      publicationVersion: pub.version,
      attributeOverrides: req.attributeOverrides,
    });
  }

  // ---- ActiveSelfServicePznProvider Implementation (for Live Chat & Experience Layer) ----

  listPublishedContextSummaries(): ContextCatalog["contexts"] {
    return this.listContexts()
      .filter((ctx) => ctx.status === "published" && ctx.publishedVersion > 0)
      .map((ctx) => ({
        contextId: ctx.contextId,
        displayName: ctx.displayName,
        description: ctx.description,
        active: true,
      }));
  }

  findPublishedContentEntry(contentId: string): ContentEntry | undefined {
    const publishedContexts = this.listContexts().filter((c) => c.status === "published" && c.publishedVersion > 0);
    for (const ctx of publishedContexts) {
      const pub = this.getPublishedPublication(ctx.contextId);
      const found = pub?.contents.find((item) => item.contentId === contentId);
      if (found) {
        const rendered = this.lastRenderedByContentId.get(contentId);
        return pznTextContentToCatalogEntry(rendered ? { ...found, headline: rendered.headline, body: rendered.body } : found);
      }
    }
    return undefined;
  }

  evaluatePublishedForTs(mid: string, contextId: string, overrides?: Record<string, PznRuleValue>): PznTsEvaluationResult | undefined {
    const pub = this.getPublishedPublication(contextId);
    if (!pub) return undefined;
    const result = evaluateTreatmentSelector({
      mid,
      context: pub.context,
      contents: pub.contents,
      rules: pub.rules,
      dictionary: this.getDictionary(),
      sourceMode: "published",
      publicationVersion: pub.version,
      attributeOverrides: overrides,
    });
    for (const item of result.eligibleContents) {
      this.lastRenderedByContentId.set(item.contentId, { headline: item.headline, body: item.renderedBody });
    }
    return result;
  }

  // ---- Full Studio Workspace Snapshot ----

  getWorkspaceState(): PznStudioWorkspaceState {
    const contexts = this.listContexts();
    const publicationsByContext: Record<string, PznContextPublication[]> = {};
    for (const ctx of contexts) {
      publicationsByContext[ctx.contextId] = this.listPublications(ctx.contextId);
    }
    const customers = listAllProfiles().map((p) => ({
      personaId: p.personaId,
      syntheticMid: p.syntheticMid,
      displayName: p.displayName,
      segment: p.segment || "General",
    }));

    return {
      dictionary: this.getDictionary(),
      contents: this.listContents(),
      rules: this.listRules(),
      contexts,
      publicationsByContext,
      customers,
    };
  }
}
