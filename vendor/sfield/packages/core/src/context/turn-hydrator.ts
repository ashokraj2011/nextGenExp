/**
 * Turn Context Hydrator for sfield (`sf.context`).
 *
 * Centralizes per-turn flow scope resolution, Principal normalization, durable ChatHarness
 * history + ConversationCompactor rolling summary loading, and declarative capability-scoped
 * resource gating so host applications do not hand-wire store/flow glue per request.
 */
import type { ChatHarness, ChatScope } from "../chat/harness.js";
import type { ConversationCompactor, RollingThreadSummary } from "./compactor.js";
import { formatRollingSummary } from "./compactor.js";
import { createPrincipal, type CreatePrincipalInput } from "../security/identity.js";
import type { Principal } from "../types/common.js";
import type { MessageRecord } from "../types/persistence.js";
import { nowIso } from "../util/digest.js";

export interface HydratedFlowDescriptor {
  id: string;
  label?: string;
  domain?: string;
  enabled?: boolean;
  operatorOnly?: boolean;
}

export interface FlowOverrideRule {
  enabled?: boolean;
  label?: string;
}

export interface GatedResourceSpec<T> {
  value: T | undefined;
  /** Every listed flow ID must be enabled for this turn (logical AND). */
  requiredFlows?: readonly string[];
  /** At least one listed flow ID must be enabled for this turn (logical OR). */
  anyFlow?: readonly string[];
  /** Restrict resource visibility to specific domain IDs. */
  allowedDomains?: readonly string[];
  /** Require the turn's Principal to have operator/admin privileges. */
  requireOperator?: boolean;
  /** Require at least one of these roles on Principal.roles. */
  requiredRoles?: readonly string[];
}

export type GatedResourceMap = Record<string, GatedResourceSpec<unknown>>;

export type UnlockedResources<TMap extends GatedResourceMap> = {
  [K in keyof TMap]: TMap[K] extends GatedResourceSpec<infer V> ? V | undefined : never;
};

export interface DeniedResourceAudit {
  key: string;
  reason: string;
}

export interface HydrateTurnInput<TResources extends GatedResourceMap = Record<string, never>> {
  /** Pre-built Principal or raw identity input normalized via createPrincipal(). */
  principal?: Principal | CreatePrincipalInput;
  /** Domain scope for the turn (defaults to "default"). */
  domainId?: string;
  /** Explicit operator privilege flag (also inferred from Principal roles "operator" | "admin"). */
  isOperator?: boolean;
  /**
   * Optional pre-resolved flow catalog from the host (e.g. a host SQLite store).
   * When omitted, sf.context resolves flows from its built-in tenant/domain flow registry.
   */
  flows?: readonly HydratedFlowDescriptor[];
  /** Optional ChatHarness scope for hydrating recent durable messages. */
  chatScope?: ChatScope;
  /** Max number of recent messages to load from ChatHarness when chatScope is provided. */
  historyLimit?: number;
  /** Conversation ID for loading the persisted rolling compaction summary. */
  conversationId?: string;
  /** Declarative map of domain stores/services gated by enabled flows, domain, and Principal roles. */
  resources?: TResources;
}

export interface HydratedTurnContext<TResources extends GatedResourceMap = Record<string, never>> {
  tenantId: string;
  domainId: string;
  principal: Principal;
  isOperator: boolean;
  flows: HydratedFlowDescriptor[];
  enabledFlowIds: ReadonlySet<string>;
  allows(flowId: string): boolean;
  threadId?: string;
  messages: MessageRecord[];
  rollingSummary: RollingThreadSummary | null;
  rollingSummaryText: string | null;
  resources: UnlockedResources<TResources>;
  deniedResources: DeniedResourceAudit[];
  hydratedAt: string;
}

export interface TurnContextHydratorDeps {
  chat: ChatHarness;
  compactor: ConversationCompactor;
  resolvePrincipal: (principal?: Principal) => Principal;
}

function isFullPrincipal(input: Principal | CreatePrincipalInput): input is Principal {
  return "tenantId" in input && "subjectId" in input && Array.isArray((input as Principal).roles);
}

/**
 * Headless, domain-agnostic Turn Context Hydrator exposed as `sf.context`.
 */
export class TurnContextHydrator {
  private readonly baseFlows = new Map<string, HydratedFlowDescriptor>();
  /** Keyed by `${tenantId}::${scope}` where scope is "tenant" or a domainId. */
  private readonly overrides = new Map<string, Record<string, FlowOverrideRule>>();

  constructor(private readonly deps: TurnContextHydratorDeps) {}

  /** Registers baseline flow descriptors managed directly by sfield. */
  registerFlows(flows: readonly HydratedFlowDescriptor[]): this {
    for (const flow of flows) {
      this.baseFlows.set(flow.id, { ...flow, enabled: flow.enabled !== false });
    }
    return this;
  }

  /** Sets tenant-wide ("tenant") or domain-specific overrides for registered flows. */
  setFlowOverrides(tenantId: string, scope: "tenant" | string, rules: Record<string, FlowOverrideRule>): this {
    this.overrides.set(`${tenantId}::${scope}`, { ...rules });
    return this;
  }

  /** Resolves effective flows for a tenant, domain, and operator status (tenant defaults -> domain overrides). */
  resolveFlows(input: { tenantId: string; domainId: string; isOperator: boolean }): HydratedFlowDescriptor[] {
    const tenantRules = this.overrides.get(`${input.tenantId}::tenant`) ?? {};
    const domainRules = this.overrides.get(`${input.tenantId}::${input.domainId}`) ?? {};
    const resolved: HydratedFlowDescriptor[] = [];

    for (const base of this.baseFlows.values()) {
      if (base.domain && base.domain !== "platform" && base.domain !== input.domainId) continue;
      if (base.operatorOnly && !input.isOperator) continue;
      const tenantRule = tenantRules[base.id];
      const domainRule = domainRules[base.id];
      const tenantEnabled = tenantRule?.enabled ?? (base.enabled !== false);
      // Domain overrides can only disable (never escalate) a tenant-disabled flow.
      const effectiveEnabled = tenantEnabled && (domainRule?.enabled ?? true);
      if (!effectiveEnabled) continue;
      resolved.push({
        ...base,
        label: domainRule?.label ?? tenantRule?.label ?? base.label,
        enabled: true,
      });
    }
    return resolved;
  }

  /**
   * Hydrates a complete Turn Context in one call:
   * Principal -> Flow Scope -> ChatHarness history & Compactor summary -> Capability-gated Resources.
   */
  async hydrateTurn<TResources extends GatedResourceMap = Record<string, never>>(
    input: HydrateTurnInput<TResources>,
  ): Promise<HydratedTurnContext<TResources>> {
    const principal: Principal = input.principal
      ? (isFullPrincipal(input.principal) ? input.principal : createPrincipal(input.principal))
      : this.deps.resolvePrincipal(undefined);

    const domainId = input.domainId ?? "default";
    const isOperator = input.isOperator ?? (
      principal.roles.includes("operator") || principal.roles.includes("admin")
    );

    const flows = input.flows
      ? input.flows.filter((flow) => flow.enabled !== false && (!flow.operatorOnly || isOperator))
      : this.resolveFlows({ tenantId: principal.tenantId, domainId, isOperator });

    const enabledFlowIds = new Set(flows.map((flow) => flow.id));
    const allows = (flowId: string) => enabledFlowIds.has(flowId);

    let threadId: string | undefined;
    let messages: MessageRecord[] = [];
    if (input.chatScope) {
      const thread = await this.deps.chat.open(input.chatScope);
      threadId = thread.id;
      messages = await thread.history(input.historyLimit ? { limit: input.historyLimit } : undefined);
    }

    const conversationId = input.conversationId ?? input.chatScope?.threadId;
    const rollingSummary = conversationId
      ? await this.deps.compactor.getSummary(principal, conversationId).catch(() => null)
      : null;
    const rollingSummaryText = rollingSummary ? formatRollingSummary(rollingSummary) : null;

    const unlocked: Record<string, unknown> = {};
    const deniedResources: DeniedResourceAudit[] = [];

    for (const [key, spec] of Object.entries(input.resources ?? {})) {
      if (spec.value === undefined) {
        unlocked[key] = undefined;
        continue;
      }
      if (spec.allowedDomains?.length && !spec.allowedDomains.includes(domainId)) {
        unlocked[key] = undefined;
        deniedResources.push({ key, reason: `domain "${domainId}" not in [${spec.allowedDomains.join(", ")}]` });
        continue;
      }
      if (spec.requireOperator && !isOperator) {
        unlocked[key] = undefined;
        deniedResources.push({ key, reason: "requires operator privileges" });
        continue;
      }
      if (spec.requiredRoles?.length && !spec.requiredRoles.some((r) => principal.roles.includes(r))) {
        unlocked[key] = undefined;
        deniedResources.push({ key, reason: `missing required role (${spec.requiredRoles.join(" | ")})` });
        continue;
      }
      if (spec.requiredFlows?.length) {
        const missing = spec.requiredFlows.filter((fid) => !enabledFlowIds.has(fid));
        if (missing.length > 0) {
          unlocked[key] = undefined;
          deniedResources.push({ key, reason: `missing required flow(s): ${missing.join(", ")}` });
          continue;
        }
      }
      if (spec.anyFlow?.length && !spec.anyFlow.some((fid) => enabledFlowIds.has(fid))) {
        unlocked[key] = undefined;
        deniedResources.push({ key, reason: `none of [${spec.anyFlow.join(", ")}] enabled` });
        continue;
      }
      unlocked[key] = spec.value;
    }

    return {
      tenantId: principal.tenantId,
      domainId,
      principal,
      isOperator,
      flows,
      enabledFlowIds,
      allows,
      ...(threadId ? { threadId } : {}),
      messages,
      rollingSummary,
      rollingSummaryText,
      resources: unlocked as UnlockedResources<TResources>,
      deniedResources,
      hydratedAt: nowIso(),
    };
  }
}
