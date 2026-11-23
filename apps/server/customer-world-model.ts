import type { Evidence, InputValues, Journey } from "../../packages/contracts/agentic";
import type { Store, TurnRecord } from "./store";
import { excludesPromotions } from "./agentic-inputs";

const remembered = /\b(?:remember|always|from now on|going forward)\b/i;

export class CustomerWorldModel {
  constructor(private readonly store: Store, private readonly now: () => number) {}

  exclusions(turn: TurnRecord, prior?: Journey) {
    const saved = this.store.axe.get("customer_preferences", turn.scope, "promotions");
    return excludesPromotions(turn.public.message) || prior?.excludePromotions === true || saved?.allowPromotionalContent === false;
  }

  rememberPreference(turn: TurnRecord) {
    const text = turn.public.message;
    if (!remembered.test(text)) return;
    if (excludesPromotions(text)) this.store.axe.setPromotionPreference(turn.scope, false, this.now());
    else if (/\b(?:allow|show)\s+(?:me\s+)?(?:promotions?|offers?)\b/i.test(text)) this.store.axe.setPromotionPreference(turn.scope, true, this.now());
  }

  rememberFact(turn: TurnRecord, evidence: Evidence) {
    if (!["portfolio", "progress", "balances", "fundingStatus"].includes(evidence.outputKind)) return;
    this.store.axe.setObservedFact(turn.scope, evidence);
  }

  savedInputs(turn: TurnRecord, fields: ReadonlySet<string>): InputValues {
    const record = this.store.axe.list("customer_goals", turn.scope).sort((a, b) => a.savedAt - b.savedAt).at(-1);
    return Object.fromEntries(Object.entries(record?.parameters ?? {}).filter(([key]) => fields.has(key)));
  }

  projection(turn: TurnRecord, contexts: Set<string>, fields: ReadonlySet<string>) {
    const relevantFacts: Record<string, readonly string[]> = {
      goals: ["progress"], portsum: ["portfolio"], balance: ["balances"], "next-step": ["fundingStatus"], "address-update": ["fundingStatus"],
    };
    const keys = new Set([...contexts].flatMap((id) => relevantFacts[id] ?? []));
    const facts = [...keys].flatMap((key) => {
      const record = this.store.axe.observedFact(turn.scope, key);
      if (!record || record.expiresAt <= this.now()) return [];
      return [{ kind: key, observedAt: record.observedAt, source: record.source, classification: "verified_fact" }];
    });
    return {
      declaredParameters: this.savedInputs(turn, fields),
      verifiedSources: facts,
      preferences: { excludePromotions: this.exclusions(turn) },
    };
  }
}
