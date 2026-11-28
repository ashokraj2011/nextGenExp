import type {
  SphotonBindingCatalog,
  SphotonBlock,
  SphotonCardBinding,
  SphotonComponentSchema,
  SphotonFormat,
  SphotonSignedActionPayload,
  SphotonSignedActionRef,
} from "./contracts";

export type SphotonComponentCompileContext = {
  card: SphotonCardBinding;
  catalog: SphotonBindingCatalog;
  slotData: Record<string, unknown>;
  resolvedRaw: Record<string, unknown>;
  resolvedFormatted: Record<string, string>;
  bindingLabels: Record<string, string>;
  signedActions: SphotonSignedActionRef[];
  baseBlock?: SphotonBlock;
  design?: { id: string; revision: number; name?: string; title?: string; badge?: string; body?: string };
  unavailableBlock: (reason: string) => SphotonBlock;
};

export type SphotonComponentCompileOutcome =
  | { status: "compiled"; block: SphotonBlock; signedActions?: SphotonSignedActionRef[] }
  | { status: "unavailable"; block: SphotonBlock; missingRequiredFields?: string[]; reason?: string };

export type SphotonComponentDefinition = {
  component: string;
  schema: SphotonComponentSchema;
  compile?: (ctx: SphotonComponentCompileContext) => SphotonComponentCompileOutcome;
  applyActionResult?: (
    block: SphotonBlock,
    action: Pick<SphotonSignedActionPayload, "resultBindings" | "label">,
    actionOutput: unknown,
  ) => SphotonBlock;
  /** Optional prompt matcher used by sphoton's catalog synthesizer when a specialized component fits a domain prompt. */
  synthesizeFromCatalog?: (prompt: string, catalog: SphotonBindingCatalog) => SphotonCardBinding | null;
};

const monthFormatter = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export function formatCurrencyCents(cents: number): string {
  const dollars = cents / 100;
  return "$" + dollars.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function formatBoundValue(value: unknown, format?: SphotonFormat): string {
  if (value === null || value === undefined) return "—";
  if (format === "currency_cents" && typeof value === "number") {
    return formatCurrencyCents(value);
  }
  if (format === "currency" && typeof value === "number") {
    return "$" + value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  if (format === "percent" && typeof value === "number") {
    return `${Math.round(value * 10) / 10}%`;
  }
  if (format === "month" && typeof value === "string" && /^\d{4}-\d{2}$/.test(value)) {
    return monthFormatter.format(new Date(value + "-01T00:00:00Z"));
  }
  if (format === "number" && typeof value === "number") {
    return value.toLocaleString("en-US");
  }
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Pluggable component registry owned by sphoton.
 * Host apps register their domain/UI components here so packages/sphoton
 * stays 100% domain-agnostic with zero imports from host contracts.
 */
export class SphotonComponentRegistry {
  private readonly defs = new Map<string, SphotonComponentDefinition>();

  constructor(initial: readonly SphotonComponentDefinition[] = []) {
    for (const def of initial) {
      this.register(def);
    }
  }

  register(def: SphotonComponentDefinition): this {
    this.defs.set(def.component, def);
    return this;
  }

  get(component: string): SphotonComponentDefinition | undefined {
    return this.defs.get(component);
  }

  has(component: string): boolean {
    return this.defs.has(component);
  }

  list(): SphotonComponentDefinition[] {
    return [...this.defs.values()];
  }
}

export function createSphotonRegistry(initial: readonly SphotonComponentDefinition[] = []): SphotonComponentRegistry {
  return new SphotonComponentRegistry(initial);
}
