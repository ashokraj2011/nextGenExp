/**
 * Tenant-configurable Slash Command Registry (`sf.commands`) for `@sfield/core`.
 *
 * Lets every tenant configure, override, reorder, disable, or scope `/` commands
 * by domain and Principal roles inside `sfield` — so host chat UIs never hardcode
 * tenant-specific slash commands.
 */
import type { Principal } from "../types/common.js";
import { SFieldError } from "../errors.js";

export interface SlashCommandDefinition {
  /** Slash trigger starting with `/` (e.g. "/portfolio", "/triage"). No spaces. */
  command: string;
  /** Short display title shown in the chat command palette. */
  label: string;
  /** Secondary hint describing what the command does. */
  hint: string;
  /** Execution kind: "prompt", "tool", "graph", or host UI action (e.g. "advisor", "memory", "upload"). */
  action: string;
  /** Prompt text appended to chat when `action === "prompt"`. */
  prompt?: string;
  /** Optional `sfield` tool reference when `action === "tool"`. */
  toolRef?: string;
  /** Optional `sfield` graph ID when `action === "graph"`. */
  graphId?: string;
  /** Optional domain scope (e.g. "wealth", "it_ops", "sales_revops"). Omit for all domains. */
  domain?: string;
  /** Optional allowed Principal roles. Omit for all callers. */
  roles?: string[];
  /** Whether the command is active (defaults to true). */
  enabled?: boolean;
  /** Optional explicit sort order (lower appears first). */
  order?: number;
}

export interface ListSlashCommandsOptions {
  tenantId: string;
  domain?: string;
  principal?: Principal;
  includeDisabled?: boolean;
}

const COMMAND_RE = /^\/[a-z0-9][a-z0-9_-]{0,31}$/;

export function normalizeSlashCommand(def: SlashCommandDefinition): SlashCommandDefinition {
  const raw = (def.command ?? "").trim().toLowerCase();
  const command = raw.startsWith("/") ? raw : `/${raw}`;
  if (!COMMAND_RE.test(command)) {
    throw new SFieldError(
      "INVALID_INPUT",
      `Invalid slash command "${def.command}". Must start with "/" followed by 1-32 lowercase letters, digits, "-" or "_".`,
    );
  }
  const label = (def.label ?? "").trim();
  if (!label) {
    throw new SFieldError("INVALID_INPUT", `Slash command "${command}" requires a non-empty label.`);
  }
  const action = (def.action ?? "prompt").trim();
  if (!action) {
    throw new SFieldError("INVALID_INPUT", `Slash command "${command}" requires an action.`);
  }
  return {
    command,
    label,
    hint: (def.hint ?? "").trim(),
    action,
    ...(def.prompt !== undefined ? { prompt: def.prompt } : {}),
    ...(def.toolRef !== undefined ? { toolRef: def.toolRef } : {}),
    ...(def.graphId !== undefined ? { graphId: def.graphId } : {}),
    ...(def.domain?.trim() ? { domain: def.domain.trim() } : {}),
    ...(Array.isArray(def.roles) && def.roles.length ? { roles: [...def.roles] } : {}),
    enabled: def.enabled !== false,
    ...(typeof def.order === "number" && Number.isFinite(def.order) ? { order: def.order } : {}),
  };
}

export class SlashCommandService {
  private defaults: SlashCommandDefinition[] = [];
  private readonly tenantOverrides = new Map<string, SlashCommandDefinition[]>();

  constructor(initialDefaults: readonly SlashCommandDefinition[] = []) {
    if (initialDefaults.length) {
      this.registerDefaults(initialDefaults);
    }
  }

  /** Registers fallback commands used for any tenant without explicit overrides. */
  registerDefaults(commands: readonly SlashCommandDefinition[]): this {
    this.defaults = commands.map((c, idx) => normalizeSlashCommand({ order: idx, ...c }));
    return this;
  }

  /** Replaces the complete slash command set for a specific tenant. */
  setTenantCommands(tenantId: string, commands: readonly SlashCommandDefinition[]): SlashCommandDefinition[] {
    const tid = tenantId.trim();
    if (!tid) throw new SFieldError("INVALID_INPUT", "tenantId is required.");
    const normalized = commands.map((c, idx) => normalizeSlashCommand({ order: idx, ...c }));
    this.tenantOverrides.set(tid, normalized);
    return normalized.map((c) => ({ ...c }));
  }

  /** Adds or updates a single slash command for a tenant (forking from defaults on first edit). */
  upsert(tenantId: string, command: SlashCommandDefinition): SlashCommandDefinition {
    const tid = tenantId.trim();
    if (!tid) throw new SFieldError("INVALID_INPUT", "tenantId is required.");
    const normalized = normalizeSlashCommand(command);
    const current = this.tenantOverrides.has(tid)
      ? [...this.tenantOverrides.get(tid)!]
      : this.defaults.map((c) => ({ ...c }));
    const idx = current.findIndex((c) => c.command === normalized.command);
    if (idx >= 0) {
      current[idx] = { order: current[idx]!.order ?? idx, ...normalized };
    } else {
      current.push({ order: current.length, ...normalized });
    }
    this.tenantOverrides.set(tid, current);
    return { ...normalized };
  }

  /** Removes a slash command for a tenant (forking from defaults on first edit). */
  remove(tenantId: string, commandName: string): boolean {
    const tid = tenantId.trim();
    if (!tid) throw new SFieldError("INVALID_INPUT", "tenantId is required.");
    const target = commandName.trim().toLowerCase();
    const normalizedTarget = target.startsWith("/") ? target : `/${target}`;
    const current = this.tenantOverrides.has(tid)
      ? [...this.tenantOverrides.get(tid)!]
      : this.defaults.map((c) => ({ ...c }));
    const next = current.filter((c) => c.command !== normalizedTarget);
    if (next.length === current.length) return false;
    this.tenantOverrides.set(tid, next);
    return true;
  }

  /** Clears tenant-specific overrides so the tenant falls back to defaults. */
  resetTenant(tenantId: string): void {
    this.tenantOverrides.delete(tenantId.trim());
  }

  /** Returns whether a tenant has custom slash command overrides. */
  hasTenantOverride(tenantId: string): boolean {
    return this.tenantOverrides.has(tenantId.trim());
  }

  /** Lists effective slash commands for a tenant, filtered by domain, enabled state, and Principal roles. */
  list(options: ListSlashCommandsOptions): SlashCommandDefinition[] {
    const tid = options.tenantId.trim();
    const base = this.tenantOverrides.get(tid) ?? this.defaults;
    const callerRoles = options.principal?.roles ?? [];

    return base
      .filter((cmd) => {
        if (!options.includeDisabled && cmd.enabled === false) return false;
        if (options.domain && cmd.domain && cmd.domain !== options.domain) return false;
        if (cmd.roles?.length && options.principal) {
          if (!cmd.roles.some((r) => callerRoles.includes(r))) return false;
        }
        return true;
      })
      .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.command.localeCompare(b.command))
      .map((c) => ({ ...c }));
  }

  /** Filters a tenant's effective commands against a live chat composer draft (e.g. "/po"). */
  match(draft: string, options: ListSlashCommandsOptions): SlashCommandDefinition[] {
    const trimmed = draft.trimStart();
    if (!trimmed.startsWith("/") || trimmed.includes(" ")) return [];
    const q = trimmed.toLowerCase();
    return this.list(options).filter((c) =>
      c.command.startsWith(q) || c.label.toLowerCase().includes(q.slice(1)),
    );
  }
}
