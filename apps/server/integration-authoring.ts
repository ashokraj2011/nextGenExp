/**
 * Chat authoring for integration tasks: turns plain-English requests into editable drafts, MCP imports, integration
 * forms and publish reviews. Nothing here saves or publishes; the cards do that only after an explicit click.
 */
import type {
  DraftOrigin,
  Integration,
  IntegrationCopilotCard,
  IntegrationTasksView,
  TaskContract,
  TaskContractInput,
  TaskEffect,
  ViewContract,
} from "../../packages/contracts/integration-task";
import type { IntegrationTaskService } from "./integration-tasks";
import { closeSchema, slugifyTaskId } from "./integration-mcp";

export type AuthoringAction =
  | { type: "integration"; prefill?: Partial<Integration> }
  | { type: "mcp_import"; integrationId?: string }
  | { type: "draft_task"; draft?: Partial<TaskContractInput> }
  | { type: "new_version"; toolRef: string }
  | { type: "edit_draft"; toolRef: string }
  | { type: "publish"; toolRef?: string }
  | { type: "drafts" };

export const AUTHORING_TYPES = new Set(["integration", "mcp_import", "draft_task", "new_version", "edit_draft", "publish", "drafts"]);

/** Strips derived fields so a stored contract can be edited as a draft input. */
export function toDraftInput(c: TaskContract | ViewContract): TaskContractInput {
  const { ref: _r, status: _s, contractDigest: _c, bindingDigest: _b, updatedAt: _u, publishedAt: _p, ...rest } = c as ViewContract;
  const { sfieldRegistered: _reg, sfieldRoute: _route, ...input } = rest as typeof rest & { sfieldRegistered?: boolean; sfieldRoute?: string };
  return input as TaskContractInput;
}

function bump(version: string, part: "minor" | "major") {
  const [maj, min] = version.split(".").map(Number);
  return part === "major" ? `${maj + 1}.0.0` : `${maj}.${min + 1}.0`;
}

function findContract(view: IntegrationTasksView, text: string, opts: { status?: "draft" | "published" } = {}) {
  const lower = text.toLowerCase();
  const pool = view.contracts.filter((c) => !opts.status || c.status === opts.status)
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return pool.find((c) => lower.includes(c.ref.toLowerCase()))
    ?? pool.find((c) => lower.includes(`${c.integrationId}.${c.taskId}`))
    ?? pool.find((c) => new RegExp(`\\b${c.taskId}\\b`).test(lower) || lower.includes(c.taskId.replaceAll("_", " ")));
}

function findIntegration(view: IntegrationTasksView, text: string) {
  const lower = text.toLowerCase();
  return view.integrations.find((i) => new RegExp(`\\b${i.id}\\b`).test(lower) || lower.includes(i.name.toLowerCase()));
}

/** Deterministic detection of authoring intents (used without a model and as a guard for model plans). */
export function detectAuthoring(message: string, view: IntegrationTasksView): { reply: string; action: AuthoringAction } | null {
  const lower = message.toLowerCase();
  const url = message.match(/https?:\/\/[^\s"'<>]+/)?.[0];
  if (/\bimport\b/.test(lower) && /\b(tools?|mcp|operations?)\b/.test(lower)) {
    const integration = findIntegration(view, message);
    return { reply: "Here are the tools the MCP server offers, as task drafts. Pick the ones to import; nothing is saved until you click.", action: { type: "mcp_import", ...(integration ? { integrationId: integration.id } : {}) } };
  }
  if (/\b(connect|add|register|new|set ?up)\b/.test(lower) && /\b(mcp|integration|server|endpoint|api|system)\b/.test(lower) && !/\btask\b/.test(lower)) {
    const name = message.match(/\b(?:as|called|named)\s+["']?([A-Za-z][\w -]{1,40}?)["']?\s*(?:[.,]|$)/i)?.[1]?.trim();
    const transport = /\bmcp\b/.test(lower) ? "mcp" : url ? "http" : "mcp";
    const id = name ? slugifyTaskId(name) : url ? slugifyTaskId(new URL(url).hostname.split(".")[0] ?? "integration") : undefined;
    return {
      reply: `Fill in the connection details and save. ${transport === "mcp" ? "After saving I can list the server's tools and draft tasks from them." : "Then add tasks to it."}`,
      action: { type: "integration", prefill: { transport, ...(url ? { baseUrl: url } : {}), ...(name ? { name } : {}), ...(id ? { id } : {}) } },
    };
  }
  if (/\bpublish\b/.test(lower)) {
    const c = findContract(view, message, { status: "draft" });
    return c
      ? { reply: `Review **${c.ref}** before publishing. Published versions are immutable.`, action: { type: "publish", toolRef: c.ref } }
      : { reply: "Which draft? Here are the drafts waiting to be published.", action: { type: "drafts" } };
  }
  if (/\bdrafts?\b/.test(lower) && !/\b(create|new|add|define|make)\b/.test(lower)) {
    return { reply: "Drafts waiting for review and publishing.", action: { type: "drafts" } };
  }
  if (/\b(new version|next version|bump|change|edit|update|modify|revise)\b/.test(lower)) {
    const draft = findContract(view, message, { status: "draft" });
    if (draft) return { reply: `Here's the draft **${draft.ref}**. Edit it and save.`, action: { type: "edit_draft", toolRef: draft.ref } };
    const published = findContract(view, message, { status: "published" });
    if (published) return { reply: `I copied **${published.ref}** into a new minor version. Change what you need; I'll flag breaking changes (they need a major version).`, action: { type: "new_version", toolRef: published.ref } };
  }
  if (/\b(create|define|add|new|build|make|author)\b/.test(lower) && /\b(task|tool|operation|action|capability)\b/.test(lower)) {
    return { reply: "I drafted a task contract from your description. Review every field, fix anything flagged, then save the draft.", action: { type: "draft_task" } };
  }
  return null;
}

const STRINGY = /(id|name|key|email|status|title|code|type|reason|note|description|url|ref|query|text|message|service)$/i;

/** A starting draft from plain English. The author always reviews and edits it in the card. */
export function templateDraft(message: string, view: IntegrationTasksView): { draft: TaskContractInput; note: string } {
  const lower = message.toLowerCase();
  const mentioned = findIntegration(view, message);
  const integration = mentioned ?? view.integrations.find((i) => i.transport !== "sandbox" && i.enabled) ?? view.integrations[0];
  const effect: TaskEffect = /\b(delete|remove|cancel|purge|revoke|terminate)\b/.test(lower) ? "destructive"
    : /\b(get|find|look ?up|list|search|fetch|read|check|show|query|retrieve)\b/.test(lower) ? "read" : "write";
  const named = message.match(/\b(?:called|named|id)\s+["'`]?([a-z][a-z0-9_]{1,47})/i)?.[1];
  const purpose = message.match(/\b(?:to|that|which)\s+(.+?)(?:\s+(?:with|taking|using|by|given|from)\b|[.,]|$)/i)?.[1] ?? message;
  const taskId = slugifyTaskId(named ?? purpose.split(/\s+/).filter((w) => !/^(a|an|the|for|of|on|in)$/i.test(w)).slice(0, 4).join("_"));
  const fieldText = (message.match(/\b(?:with|taking|using|by|given|fields?|inputs?|parameters?)\s*:?\s+(.+?)(?:\.|$|\s+(?:and returns?|returning|that returns?)\b)/i)?.[1] ?? "").split(/\s+(?:on|in|for|against|via)\s+/i)[0]!;
  const names = fieldText.split(/\s*(?:,|\band\b|\bor\b|\/)\s*/).map((s) => s.trim().replace(/^(an?|the)\s+/i, ""))
    .map((s) => s.replace(/[^A-Za-z0-9_ ]/g, "").trim()).filter(Boolean)
    .map((s) => (/\s/.test(s) ? s.split(/\s+/).map((w, i) => (i ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join("") : s))
    .filter((s) => /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(s)).slice(0, 8);
  const properties: Record<string, Record<string, unknown>> = {};
  for (const n of names) {
    properties[n] = /^(is|has|enabled|active)/i.test(n) ? { type: "boolean" }
      : /(count|qty|quantity|days|limit|age|number)$/i.test(n) ? { type: "integer", minimum: 0 }
      : /(amount|price|total|rate)$/i.test(n) ? { type: "number" }
      : STRINGY.test(n) || true ? { type: "string", minLength: 1, maxLength: 200 } : {};
  }
  if (effect !== "read") properties.idempotencyKey = { type: "string", maxLength: 80 };
  const transport = integration?.transport ?? "http";
  const draft: TaskContractInput = {
    integrationId: integration?.id ?? "itsm_sandbox",
    taskId,
    version: "1.0.0",
    description: message.replace(/^\s*(please\s+)?(create|define|add|build|make)\s+(a|an|new)?\s*(task|tool)\s*(to|that|which|called\s+\S+)?\s*/i, "").trim().slice(0, 400) || `Task ${taskId}`,
    effect,
    inputSchema: { type: "object", additionalProperties: false, required: names.slice(0, 8), properties },
    outputSchema: { type: "object", additionalProperties: false, required: [], properties: { result: { type: "string" } } },
    resultKind: "data",
    outcomeCodes: [
      { code: "OK", meaning: effect === "read" ? "Found" : "Applied", success: true },
      { code: "REJECTED", meaning: "The system rejected the request", success: false },
    ],
    outcomeMapping: [{ statusIn: effect === "read" ? [200] : [200, 201], code: "OK" }, { statusIn: [400, 404, 422], code: "REJECTED" }],
    approvalPolicy: { mode: effect === "read" ? "none" : "always", when: [], dualControl: false, expiresInMinutes: 30 },
    idempotency: effect === "read" ? { supported: false } : { supported: true, keyField: "idempotencyKey" },
    binding: { target: transport === "mcp" ? taskId : transport === "sandbox" ? `${integration?.id ?? "sandbox"}.${taskId}` : `/${taskId.replaceAll("_", "-")}`, method: effect === "read" ? "GET" : effect === "destructive" ? "DELETE" : "POST" },
  };
  const notes = [
    names.length ? `Input fields guessed from your message: ${names.join(", ")}.` : "I couldn't find input fields in your message; add them below.",
    "The output schema is a placeholder: describe what the system returns.",
    effect === "read" ? "Read task: runs without approval." : "Every call needs approval by default; switch to conditional if only some calls are risky.",
    ...(!mentioned && integration ? [`Attached to ${integration.name}; change the integration if that's wrong.`] : []),
    ...(transport === "sandbox" ? ["Sandbox integrations only run built-in demo handlers; connect an HTTP or MCP integration to run real calls."] : []),
  ];
  return { draft, note: notes.join(" ") };
}

/** Merges a model-proposed partial contract over the template; unknown keys are dropped by validation later. */
function mergeDraft(base: TaskContractInput, proposed: Partial<TaskContractInput> | undefined): TaskContractInput {
  if (!proposed || typeof proposed !== "object") return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(proposed)) if (v !== undefined && v !== null && k in base || ["artifact", "reconcileTaskId", "resourceIdField", "manualReconcile"].includes(k)) out[k] = v;
  return out as TaskContractInput;
}

export async function runAuthoringAction(
  action: AuthoringAction, message: string, view: IntegrationTasksView, service: IntegrationTaskService,
): Promise<{ cards: IntegrationCopilotCard[]; summary: string; reply?: string }> {
  const contractByRef = (ref: string) => view.contracts.find((c) => c.ref === ref);
  const draftCard = (draft: TaskContractInput, origin: DraftOrigin, note?: string): IntegrationCopilotCard =>
    ({ kind: "task_draft", draft, check: service.validateDraft(draft), origin, ...(note ? { note } : {}) });
  switch (action.type) {
    case "integration": {
      const existing = action.prefill?.id ? service.integration(action.prefill.id) : undefined;
      return { cards: [{ kind: "integration_form", prefill: { ...(existing ?? {}), ...(action.prefill ?? {}) }, existing: Boolean(existing) }], summary: existing ? `Editing ${existing.id}` : "New integration form" };
    }
    case "mcp_import": {
      const mcp = view.integrations.filter((i) => i.transport === "mcp");
      const integrationId = action.integrationId ?? (mcp.length === 1 ? mcp[0]!.id : undefined);
      if (!integrationId) {
        return mcp.length
          ? { cards: [{ kind: "catalog", view }], summary: "Several MCP integrations", reply: `Which MCP server? ${mcp.map((i) => `\`${i.id}\``).join(", ")}. Say "Import tools from <id>".` }
          : { cards: [{ kind: "integration_form", prefill: { transport: "mcp" }, existing: false }], summary: "No MCP integration yet", reply: "There's no MCP integration yet. Connect one first; then I'll list its tools." };
      }
      try {
        const out = await service.discoverMcp(integrationId);
        return { cards: [{ kind: "mcp_import", integrationId, candidates: out.candidates }], summary: `${out.candidates.length} tool(s) on ${integrationId}` };
      } catch (err) {
        return { cards: [{ kind: "mcp_import", integrationId, candidates: [], error: err instanceof Error ? err.message : String(err) }], summary: "Discovery failed", reply: `I couldn't list tools from ${integrationId}.` };
      }
    }
    case "draft_task": {
      const { draft, note } = templateDraft(message, view);
      const merged = mergeDraft(draft, action.draft);
      // Model-written schemas are tightened deterministically (closed objects), and the author is told.
      const tightened: string[] = [];
      merged.inputSchema = closeSchema(merged.inputSchema, tightened, "input") as Record<string, unknown>;
      merged.outputSchema = closeSchema(merged.outputSchema, tightened, "output") as Record<string, unknown>;
      const modelNote = `Drafted by the assistant. Review every field before saving.${tightened.length ? ` I closed open schemas (${tightened.join("; ")}).` : ""}`;
      return { cards: [draftCard(merged, action.draft ? "assistant" : "template", action.draft ? modelNote : note)], summary: `Draft ${merged.integrationId}.${merged.taskId}@${merged.version}` };
    }
    case "new_version": {
      const source = contractByRef(action.toolRef);
      if (!source) throw new Error(`Unknown task ${action.toolRef}`);
      const newest = service.allVersions(source.integrationId, source.taskId)[0];
      if (newest?.status === "draft") return { cards: [draftCard(toDraftInput(newest), "existing_draft")], summary: `Existing draft ${newest.ref}`, reply: `There's already a draft **${newest.ref}**; continue editing it.` };
      const draft = { ...toDraftInput(source), version: bump(newest?.version ?? source.version, "minor") };
      return { cards: [draftCard(draft, "new_version", `Copied from ${source.ref}. Breaking changes (new required inputs, removed fields, narrowed values, different effect) need a major version.`)], summary: `New version of ${source.ref}` };
    }
    case "edit_draft": {
      const c = contractByRef(action.toolRef);
      if (!c || c.status !== "draft") throw new Error(`${action.toolRef} is not a draft`);
      return { cards: [draftCard(toDraftInput(c), "existing_draft")], summary: `Editing ${c.ref}` };
    }
    case "publish": {
      const c = action.toolRef ? contractByRef(action.toolRef) : undefined;
      if (!c) return { cards: [{ kind: "drafts", drafts: view.contracts.filter((x) => x.status === "draft") }], summary: "Choose a draft" };
      if (c.status !== "draft") return { cards: [{ kind: "contract", contract: c }], summary: `${c.ref} is ${c.status}`, reply: `${c.ref} is already ${c.status}. Ask for a new version to change it.` };
      return { cards: [{ kind: "publish_review", contract: c, check: service.validateDraft(toDraftInput(c)) }], summary: `Publish review for ${c.ref}` };
    }
    case "drafts": {
      const drafts = view.contracts.filter((c) => c.status === "draft");
      return { cards: [{ kind: "drafts", drafts }], summary: `${drafts.length} draft(s)`, ...(drafts.length ? {} : { reply: "No drafts right now. Ask me to create a task or a new version of one." }) };
    }
  }
}

export const AUTHORING_PROMPT = `
AUTHORING ACTIONS (nothing is saved or published by you; the user confirms on a card):
  {"type":"integration","prefill":{"id":"slug","name":"...","transport":"mcp|http","baseUrl":"https://..."}}  connect a system
  {"type":"mcp_import","integrationId":"..."}   list an MCP server's tools as drafts
  {"type":"draft_task","draft":{ partial task contract: integrationId, taskId (slug), version "1.0.0", description, effect read|write|destructive,
     inputSchema/outputSchema (JSON Schema objects with "additionalProperties": false on every object),
     outcomeCodes [{code:"OK",meaning,success:true}], outcomeMapping [{statusIn:[200],code:"OK"}],
     approvalPolicy {mode:none|always|conditional, when:[{field,op:eq|ne|gt|gte|lt|lte|in,value}], dualControl, expiresInMinutes},
     idempotency {supported, keyField}, binding {target, method} }}
  {"type":"new_version","toolRef":"int.x.y@1.0.0"}   copy a published task into a new version
  {"type":"edit_draft","toolRef":"..."}  {"type":"publish","toolRef":"<draft ref>"}  {"type":"drafts"}
Writes need an idempotency key field (or a reconcile task). Read tasks never require approval.`;
