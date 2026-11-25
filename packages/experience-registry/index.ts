import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { contentEntrySchema, type ContentEntry } from "../contracts/domain";
import {
  managedContentInputSchema,
  managedIntentInputSchema,
  managedNbaRuleInputSchema,
  type ManagedContentInput,
  type ManagedIntentInput,
  type ManagedNbaRuleInput,
} from "../contracts/experience-registry";
import { routingIntents } from "../contracts/routing-intents";
import {
  builtInContentById,
  builtInContentEntries,
  builtInNbaRules,
  registerExperienceRegistryLookup,
  type ExperienceRegistryLookup,
} from "./registry";

const persistedRegistrySchema = z.object({
  intents: z.array(managedIntentInputSchema).default([]),
  content: z.array(managedContentInputSchema).default([]),
  nbaRules: z.array(managedNbaRuleInputSchema).default([]),
  nbaOrder: z.array(z.string()).default([]),
}).strict();

type PersistedRegistry = z.infer<typeof persistedRegistrySchema>;

const defaultIntentSamples: Record<string, string[]> = {
  explain_balance: ["What is available balance?", "Explain current balance"],
  compare_balances: ["Compare available vs current balance"],
  show_balance: ["Show my balance", "What is my balance?"],
  explain_portfolio: ["Explain my asset allocation", "What do holdings labels mean?"],
  show_portfolio: ["Let me know my portfolio summary", "How can I invest more?"],
  show_home_goal: ["Show my home-buying goal", "How close am I to my down payment?"],
  retirement_learning: ["I want to learn about retirement"],
  beneficiary_update_steps: ["How do I add a beneficiary?"],
  update_address: ["I moved and need to update my mailing address"],
  learn_transfers: ["How do transfers work?"],
  guide_transfer: ["Walk me through a transfer"],
  suggest_next_step: ["What should I do next?"],
};

export const builtInManagedIntents: ManagedIntentInput[] = routingIntents
  .filter((item): item is Exclude<typeof item, { contextId: null }> => item.contextId !== null)
  .map((item) => ({
    intentId: item.intentId,
    label: item.label,
    contextId: item.contextId,
    task: item.task,
    description: item.description,
    samplePhrases: defaultIntentSamples[item.intentId] ?? [],
    enabled: true,
  }));

const builtInIntentById = new Map(builtInManagedIntents.map((i) => [i.intentId, i]));
const builtInNbaById = new Map(builtInNbaRules.map((r) => [r.id, r]));

function toContentEntry(input: ManagedContentInput): ContentEntry {
  const existing = builtInContentById.get(input.contentId);
  const disclosureId = existing?.requiredDisclosures[0]?.disclosureId ?? "custom_disclosure";
  const base: ContentEntry = existing
    ? {
        ...existing,
        publicationStatus: input.publicationStatus,
        kind: input.kind,
        title: input.title,
        description: input.description,
        body: input.body,
        allowedComponents: input.allowedComponents,
        sourceLabel: input.sourceLabel,
        requiredDisclosures: [{ disclosureId, text: input.disclosureText }, ...existing.requiredDisclosures.slice(1)],
      }
    : {
        contentId: input.contentId,
        version: "v1",
        publicationStatus: input.publicationStatus,
        kind: input.kind,
        title: input.title,
        description: input.description,
        body: input.body,
        allowedComponents: input.allowedComponents,
        comparisonGroup: null,
        comparisonFields: [],
        steps: [],
        metricSpec: null,
        followUps: [],
        sourceRef: "fixture:" + input.contentId,
        sourceLabel: input.sourceLabel,
        requiredDisclosures: [{ disclosureId: "custom_disclosure", text: input.disclosureText }],
      };
  return contentEntrySchema.parse(base);
}

export function contentEntryToInput(entry: ContentEntry): ManagedContentInput {
  return {
    contentId: entry.contentId,
    publicationStatus: entry.publicationStatus,
    kind: entry.kind,
    title: entry.title,
    description: entry.description,
    body: entry.body,
    allowedComponents: [...entry.allowedComponents],
    sourceLabel: entry.sourceLabel,
    disclosureText: entry.requiredDisclosures[0]?.text ?? "Figures are for illustration.",
  };
}

export class ExperienceRegistryStore implements ExperienceRegistryLookup {
  private readonly filePath: string;
  private cache: PersistedRegistry | null = null;

  constructor(dataDir: string) {
    this.filePath = resolve(dataDir, "experience-registry.json");
  }

  private load(): PersistedRegistry {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = { intents: [], content: [], nbaRules: [], nbaOrder: [] };
      return this.cache;
    }
    try {
      this.cache = persistedRegistrySchema.parse(JSON.parse(readFileSync(this.filePath, "utf8")));
      return this.cache;
    } catch {
      this.cache = { intents: [], content: [], nbaRules: [], nbaOrder: [] };
      return this.cache;
    }
  }

  private persist(next: PersistedRegistry) {
    this.cache = next;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(next, null, 2), "utf8");
  }

  // --- Intents ---
  getIntentOverrides(): Map<string, ManagedIntentInput> {
    return new Map(this.load().intents.map((item) => [item.intentId, item]));
  }

  listIntents(): (ManagedIntentInput & { isBuiltIn: boolean; isCustomized: boolean })[] {
    const overrides = this.getIntentOverrides();
    const merged = builtInManagedIntents.map((base) => {
      const override = overrides.get(base.intentId);
      return { ...(override ?? base), isBuiltIn: true, isCustomized: Boolean(override) };
    });
    for (const custom of overrides.values()) {
      if (!builtInIntentById.has(custom.intentId)) {
        merged.push({ ...custom, isBuiltIn: false, isCustomized: true });
      }
    }
    return merged;
  }

  upsertIntent(input: ManagedIntentInput): ManagedIntentInput {
    const data = this.load();
    const intents = data.intents.filter((item) => item.intentId !== input.intentId);
    intents.push(input);
    this.persist({ ...data, intents });
    return input;
  }

  deleteOrResetIntent(intentId: string): { deleted: boolean; reset: boolean } {
    const data = this.load();
    if (!data.intents.some((item) => item.intentId === intentId)) return { deleted: false, reset: false };
    this.persist({ ...data, intents: data.intents.filter((item) => item.intentId !== intentId) });
    return builtInIntentById.has(intentId) ? { deleted: false, reset: true } : { deleted: true, reset: false };
  }

  // --- Content Catalog ---
  getContentEntries(): ContentEntry[] {
    const data = this.load();
    const overrides = new Map(data.content.map((item) => [item.contentId, toContentEntry(item)]));
    const merged = builtInContentEntries.map((base) => overrides.get(base.contentId) ?? base);
    for (const [id, entry] of overrides.entries()) {
      if (!builtInContentById.has(id)) merged.push(entry);
    }
    return merged;
  }

  findContentById(contentId: string): ContentEntry | undefined {
    const data = this.load();
    const override = data.content.find((item) => item.contentId === contentId);
    if (override) return toContentEntry(override);
    return builtInContentById.get(contentId);
  }

  listContent(): { input: ManagedContentInput; rawEntry: ContentEntry; isBuiltIn: boolean; isCustomized: boolean }[] {
    const data = this.load();
    const overrideIds = new Set(data.content.map((c) => c.contentId));
    return this.getContentEntries().map((entry) => ({
      input: contentEntryToInput(entry),
      rawEntry: entry,
      isBuiltIn: builtInContentById.has(entry.contentId),
      isCustomized: overrideIds.has(entry.contentId),
    }));
  }

  upsertContent(input: ManagedContentInput): ContentEntry {
    const entry = toContentEntry(input);
    const data = this.load();
    const content = data.content.filter((item) => item.contentId !== input.contentId);
    content.push(input);
    this.persist({ ...data, content });
    return entry;
  }

  deleteOrResetContent(contentId: string): { deleted: boolean; reset: boolean } {
    const data = this.load();
    if (!data.content.some((item) => item.contentId === contentId)) return { deleted: false, reset: false };
    this.persist({ ...data, content: data.content.filter((item) => item.contentId !== contentId) });
    return builtInContentById.has(contentId) ? { deleted: false, reset: true } : { deleted: true, reset: false };
  }

  // --- Next Best Action Rules ---
  getNbaRules(): ManagedNbaRuleInput[] {
    const data = this.load();
    const overrides = new Map(data.nbaRules.map((item) => [item.id, item]));
    const byId = new Map<string, ManagedNbaRuleInput>();
    for (const base of builtInNbaRules) byId.set(base.id, overrides.get(base.id) ?? base);
    for (const custom of overrides.values()) {
      if (!byId.has(custom.id)) byId.set(custom.id, custom);
    }
    const order = data.nbaOrder.length ? data.nbaOrder : [...byId.keys()];
    const ordered: ManagedNbaRuleInput[] = [];
    for (const id of order) {
      const rule = byId.get(id);
      if (rule) {
        ordered.push(rule);
        byId.delete(id);
      }
    }
    for (const remaining of byId.values()) ordered.push(remaining);
    return ordered;
  }

  listNbaRules(): (ManagedNbaRuleInput & { rank: number; isBuiltIn: boolean; isCustomized: boolean })[] {
    const data = this.load();
    const overrideIds = new Set(data.nbaRules.map((r) => r.id));
    return this.getNbaRules().map((rule, index) => ({
      ...rule,
      rank: index + 1,
      isBuiltIn: builtInNbaById.has(rule.id),
      isCustomized: overrideIds.has(rule.id),
    }));
  }

  upsertNbaRule(input: ManagedNbaRuleInput): ManagedNbaRuleInput {
    const data = this.load();
    const nbaRules = data.nbaRules.filter((item) => item.id !== input.id);
    nbaRules.push(input);
    const nbaOrder = data.nbaOrder.length ? [...data.nbaOrder] : this.getNbaRules().map((r) => r.id);
    if (!nbaOrder.includes(input.id)) nbaOrder.push(input.id);
    this.persist({ ...data, nbaRules, nbaOrder });
    return input;
  }

  reorderNbaRules(orderedIds: string[]) {
    const data = this.load();
    const valid = new Set(this.getNbaRules().map((r) => r.id));
    const filtered = orderedIds.filter((id) => valid.has(id));
    for (const id of valid) if (!filtered.includes(id)) filtered.push(id);
    this.persist({ ...data, nbaOrder: filtered });
  }

  deleteOrResetNbaRule(id: string): { deleted: boolean; reset: boolean } {
    const data = this.load();
    const isBuiltIn = builtInNbaById.has(id);
    const hadOverride = data.nbaRules.some((r) => r.id === id);
    if (!hadOverride && isBuiltIn) return { deleted: false, reset: false };
    const nbaRules = data.nbaRules.filter((r) => r.id !== id);
    const nbaOrder = isBuiltIn ? data.nbaOrder : data.nbaOrder.filter((item) => item !== id);
    this.persist({ ...data, nbaRules, nbaOrder });
    return isBuiltIn ? { deleted: false, reset: true } : { deleted: true, reset: false };
  }
}

let activeStore: ExperienceRegistryStore | null = null;

export function setActiveExperienceRegistryStore(store: ExperienceRegistryStore | null) {
  activeStore = store;
  registerExperienceRegistryLookup(store);
}

export function getActiveExperienceRegistryStore(): ExperienceRegistryStore | null {
  return activeStore;
}
