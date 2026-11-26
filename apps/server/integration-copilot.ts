import { z } from "zod";
import type {
  FieldProvenance,
  IntegrationCopilotCard,
  IntegrationCopilotRequest,
  IntegrationCopilotResponse,
  IntegrationTasksView,
  TaskContract,
  ViewContract,
} from "../../packages/contracts/integration-task";
import { callConfiguredLlmJson } from "./dynamic-ui-generator";
import type { GatewaySettings } from "./gateway";
import type { IntegrationTaskService } from "./integration-tasks";
import { AUTHORING_PROMPT, AUTHORING_TYPES, detectAuthoring, runAuthoringAction, type AuthoringAction } from "./integration-authoring";

type Contract = ViewContract;

type Plan = {
  reply: string;
  action:
    | { type: "catalog" }
    | { type: "contract"; toolRef: string }
    | { type: "task"; toolRef: string; input: Record<string, unknown> }
    | { type: "runs"; filter?: string }
    | { type: "reconcile"; runId: string }
    | { type: "approvals" }
    | AuthoringAction;
  suggestedPrompts?: string[];
};

const copilotPlanSchema = z.object({
  reply: z.string().min(1).max(2000),
  action: z.object({ type: z.string().min(1).max(40) }).passthrough(),
  suggestedPrompts: z.array(z.string().max(160)).max(6).optional(),
});

const runnable = (view: IntegrationTasksView) => view.contracts.filter((c) => c.status === "published");

/** Latest published version of each task. */
function latestTasks(view: IntegrationTasksView): Contract[] {
  const byTask = new Map<string, Contract>();
  for (const c of runnable(view)) {
    const key = `${c.integrationId}.${c.taskId}`;
    const prev = byTask.get(key);
    const newer = !prev || c.version.localeCompare(prev.version, undefined, { numeric: true }) > 0;
    // Newest version sfield can run (dedicated tool or dispatcher); unavailable versions only as a last resort.
    const runs = (x: Contract) => x.sfieldRoute !== "unavailable";
    if (!prev || (runs(c) && !runs(prev)) || (runs(c) === runs(prev) && newer)) byTask.set(key, c);
  }
  return [...byTask.values()];
}

function findTask(view: IntegrationTasksView, text: string): Contract | undefined {
  const lower = text.toLowerCase();
  const tasks = latestTasks(view);
  return tasks.find((c) => lower.includes(c.ref.toLowerCase()))
    ?? tasks.find((c) => lower.includes(c.taskId.replaceAll("_", " ")) || lower.includes(c.taskId));
}

function extractJson(text: string): string | undefined {
  const start = text.search(/[{[]/);
  if (start < 0) return undefined;
  for (let end = text.length; end > start; end--) {
    const candidate = text.slice(start, end).trim();
    if (!/[}\]]$/.test(candidate)) continue;
    try { JSON.parse(candidate); return candidate; } catch { /* keep shrinking */ }
  }
  return undefined;
}

function deterministicPlan(message: string, view: IntegrationTasksView): Plan {
  const authoring = detectAuthoring(message, view);
  if (authoring) return { ...authoring, suggestedPrompts: authoringSuggestions(authoring.action) };
  const lower = message.toLowerCase();
  const tasks = latestTasks(view);
  const byId = (id: string) => tasks.find((c) => c.taskId === id);

  if (/approv/.test(lower)) {
    return { reply: "Here are the pending task approvals. Each one is held by sfield until someone approves it.", action: { type: "approvals" } };
  }
  const runId = message.match(/trun_[a-z0-9]{6,}/i)?.[0];
  if (/reconcile/.test(lower)) {
    return runId
      ? { reply: `Reconciling ${runId}: checking the integration with the same idempotency key.`, action: { type: "reconcile", runId } }
      : { reply: "These runs have an unknown outcome. Reconcile one to find out whether the change was applied.", action: { type: "runs", filter: "outcome_unknown" } };
  }
  if (/\b(runs?|history|recent|activity|executions?)\b/.test(lower) && !/\b(create|open|raise|file)\b/.test(lower)) {
    return { reply: "Recent task runs, newest first.", action: { type: "runs" } };
  }
  if (/\b(contract|schema of|inputs? (for|of)|fields? (for|of)|what does|explain)\b/.test(lower)) {
    const task = findTask(view, message);
    if (task) return { reply: `This is the contract for **${task.taskId}** v${task.version}.`, action: { type: "contract", toolRef: task.ref } };
  }
  if (/^\s*(run|use|start|open)\b/.test(lower)) {
    const task = findTask(view, message);
    if (task) {
      return {
        reply: `Fill in **${task.taskId}** and submit.${task.effect !== "read" ? " Writes run only after you confirm the form." : ""}`,
        action: { type: "task", toolRef: task.ref, input: {} },
      };
    }
  }
  if (/\b(generate|infer|derive|make)\b.*\bschema\b|\bjson schema\b|\bmapping schema\b/.test(lower)) {
    const task = byId("generate_mapping_schema");
    if (task) {
      const sampleJson = extractJson(message) ?? "";
      const entityName = message.match(/\bfor (?:an? |the )?([A-Za-z][A-Za-z0-9_]{1,40})/)?.[1] ?? "Entity";
      return {
        reply: sampleJson
          ? `I filled in the schema generator with your sample. It's a read-only task, so it runs without approval and returns a schema for review.`
          : "Paste a JSON sample into the form and I'll generate a schema for review.",
        action: { type: "task", toolRef: task.ref, input: { entityName, ...(sampleJson ? { sampleJson } : {}) } },
      };
    }
  }
  if (/\b(find|look ?up|check)\b.*\bticket\b/.test(lower)) {
    const task = byId("find_ticket");
    const key = message.match(/idem_[a-z0-9]+/i)?.[0];
    if (task) return { reply: key ? `Looking up the ticket for ${key}.` : "Enter the idempotency key to look up.", action: { type: "task", toolRef: task.ref, input: key ? { idempotencyKey: key } : {} } };
  }
  if (/\b(ticket|incident|outage|alert|page|sev)\b/.test(lower)) {
    const task = byId("create_ticket");
    if (task) {
      const priority = message.match(/\bP([1-4])\b/i)?.[1]
        ?? (/\b(critical|outage|down|sev ?1)\b/.test(lower) ? "1" : /\b(urgent|high|sev ?2)\b/.test(lower) ? "2" : /\blow\b/.test(lower) ? "4" : "3");
      // "on <service>" / "service <x>" is the strongest signal; "for <x>" usually describes the problem.
      const service = (message.match(/\b(?:on|service)\s+(?:the\s+)?([a-z][a-z0-9-]{1,40})/i)
        ?? message.match(/\bin\s+(?:the\s+)?([a-z][a-z0-9-]{1,40})/i)
        ?? message.match(/\bfor\s+(?:the\s+)?([a-z][a-z0-9-]{1,40})/i))?.[1]?.toLowerCase();
      const title = message
        .replace(/^(please\s+)?(create|open|raise|file|log)\s+(a|an)?\s*(p[1-4]\s+)?(ticket|incident)\s*(for|about)?\s*/i, "")
        .trim()
        .slice(0, 160);
      return {
        reply: `I drafted a **P${priority}** ticket from your message. Check the fields — anything marked *AI-filled* was guessed — then submit.${priority === "1" ? " P1 tickets need approval before they're created." : ""}`,
        action: { type: "task", toolRef: task.ref, input: { title: title.length >= 3 ? title : message.slice(0, 160), priority: `P${priority}`, ...(service ? { service } : {}) } },
      };
    }
  }
  return { reply: "Here are the integrations and their tasks. Ask me to run one, show its contract, or review runs and approvals.", action: { type: "catalog" } };
}

function authoringSuggestions(action: AuthoringAction): string[] {
  switch (action.type) {
    case "integration": return ["Import tools from the MCP server", "Show integrations and tasks"];
    case "mcp_import": return ["Show drafts", "Show integrations and tasks"];
    case "drafts": return ["Create a task to look up an order by orderId", "Show integrations and tasks"];
    case "publish": return ["Show drafts", "Show integrations and tasks"];
    default: return ["Show drafts", "Show integrations and tasks", "Show pending approvals"];
  }
}

function systemPrompt(view: IntegrationTasksView): string {
  const tasks = latestTasks(view).map((c) => ({
    toolRef: c.ref, effect: c.effect, description: c.description, inputSchema: c.inputSchema,
    approval: c.approvalPolicy.mode === "conditional" ? c.approvalPolicy.when : c.approvalPolicy.mode,
  }));
  const runs = view.runs.slice(0, 10).map((r) => ({ runId: r.runId, toolRef: r.toolRef, state: r.state }));
  const integrations = view.integrations.map((i) => ({ id: i.id, name: i.name, transport: i.transport }));
  const drafts = view.contracts.filter((c) => c.status === "draft").map((c) => c.ref);
  return `You help operators build and run governed integration tasks in CEP.
INTEGRATIONS: ${JSON.stringify(integrations)}
DRAFTS: ${JSON.stringify(drafts)}
TASKS: ${JSON.stringify(tasks)}
RECENT RUNS: ${JSON.stringify(runs)}

Return ONLY JSON:
{ "reply": "short, plain answer",
  "action": one of
    {"type":"catalog"} |
    {"type":"contract","toolRef":"..."} |
    {"type":"task","toolRef":"...","input":{...only fields from that task's inputSchema, best guesses from the message...}} |
    {"type":"runs","filter":"outcome_unknown|failed|pending_approval (optional)"} |
    {"type":"reconcile","runId":"trun_..."} |
    {"type":"approvals"},
  "suggestedPrompts": ["2-3 short follow-ups"] }
${AUTHORING_PROMPT}
Rules: use exact toolRefs from TASKS/DRAFTS. Never invent idempotency keys. For write tasks the host shows a form for a person to confirm; do not claim anything was created, saved, or published.`;
}

export async function runIntegrationCopilot(
  req: IntegrationCopilotRequest,
  service: IntegrationTaskService,
  principalId: string,
  options: { gateway?: GatewaySettings | null; dataDir?: string; operatorName?: string },
): Promise<IntegrationCopilotResponse> {
  const view = service.view();
  let plan: Plan | null = null;
  let generatedBy: IntegrationCopilotResponse["generatedBy"] = "deterministic";
  if (options.gateway && options.dataDir) {
    try {
      const history = (req.history ?? []).slice(-6).map((h) => `${h.role.toUpperCase()}: ${h.text}`).join("\n");
      const raw = await callConfiguredLlmJson(options.gateway, options.dataDir, systemPrompt(view),
        history ? `RECENT CONVERSATION:\n${history}\n\nNEW MESSAGE:\n${req.message}` : req.message, AbortSignal.timeout(20_000));
      const parsed = copilotPlanSchema.safeParse(raw);
      if (parsed.success) {
        const candidate = parsed.data as unknown as Plan;
        const validRef = (ref: unknown) => typeof ref === "string" && view.contracts.some((c) => c.ref === ref);
        const a = candidate.action as { type: string; toolRef?: unknown };
        const refOk = !["task", "contract", "new_version", "edit_draft"].includes(a.type) || validRef(a.toolRef);
        if (refOk) {
          plan = candidate;
          generatedBy = "copilot_llm";
        }
      }
    } catch { /* fall back */ }
  }
  // Authoring intents are recognised deterministically too, so a model answer that ignores them can't run a task instead.
  const detected = detectAuthoring(req.message, view);
  // When the user's words clearly name an authoring step, that step wins; the model may only enrich it (e.g. a drafted contract).
  if (plan && detected && plan.action.type !== detected.action.type) plan = null;
  if (!plan) plan = deterministicPlan(req.message, view);

  const cards: IntegrationCopilotCard[] = [];
  const actions: IntegrationCopilotResponse["actions"] = [];
  let reply = plan.reply;
  const contractFor = (ref: string) => view.contracts.find((c) => c.ref === ref);

  try {
    const action = plan.action;
    if (AUTHORING_TYPES.has(action.type)) {
      const out = await runAuthoringAction(action as AuthoringAction, req.message, view, service);
      cards.push(...out.cards);
      actions.push({ tool: `authoring.${action.type}`, summary: out.summary, status: "ok" });
      if (out.reply) reply = out.reply;
    } else switch (action.type) {
      case "catalog":
        cards.push({ kind: "catalog", view });
        actions.push({ tool: "integrations.catalog", summary: `${view.integrations.length} integration(s), ${latestTasks(view).length} task(s)`, status: "ok" });
        break;
      case "contract": {
        const contract = contractFor(action.toolRef);
        if (!contract) throw new Error(`Unknown task ${action.toolRef}`);
        cards.push({ kind: "contract", contract });
        actions.push({ tool: "task.contract", summary: contract.ref, status: "ok" });
        break;
      }
      case "task": {
        const contract = contractFor(action.toolRef);
        if (!contract) throw new Error(`Unknown task ${action.toolRef}`);
        // Keep only fields the contract declares; everything the model filled is marked as model-proposed.
        const props = (contract.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
        const keyField = contract.idempotency.keyField;
        const prefill = Object.fromEntries(Object.entries(action.input ?? {}).filter(([k]) => k in props && k !== keyField));
        const provenance = Object.fromEntries(Object.keys(prefill).map((k) => [k, "model_proposed" as FieldProvenance]));
        const required = (contract.inputSchema as { required?: string[] }).required ?? [];
        const complete = required.every((k) => prefill[k] !== undefined && prefill[k] !== "");
        if (contract.effect === "read" && complete && contract.sfieldRoute !== "unavailable") {
          const out = await service.run(principalId, { toolRef: contract.ref, input: prefill, requestedBy: options.operatorName ?? principalId, provenance });
          cards.push({ kind: "task_run", run: out.run });
          actions.push({ tool: contract.ref, summary: `${out.run.state}${out.run.outcome ? ` (${out.run.outcome.code})` : ""}`, status: out.run.state === "failed" ? "error" : "ok" });
        } else {
          cards.push({ kind: "task_form", contract, prefill, provenance });
          actions.push({ tool: contract.ref, summary: contract.effect === "read" ? "Needs input before it can run" : "Drafted for confirmation (writes are never run from chat text)", status: "pending" });
          if (contract.effect !== "read") reply += reply.includes("submit") ? "" : " Review the form and submit to run it.";
        }
        break;
      }
      case "runs": {
        const runs = (action.filter ? view.runs.filter((r) => r.state === action.filter) : view.runs).slice(0, 12);
        cards.push({ kind: "runs", runs, ...(action.filter ? { filter: action.filter } : {}) });
        actions.push({ tool: "task.runs", summary: `${runs.length} run(s)${action.filter ? ` · ${action.filter}` : ""}`, status: "ok" });
        if (!runs.length) reply = action.filter ? `No runs are ${action.filter.replaceAll("_", " ")} right now.` : "No task runs yet. Try creating a ticket.";
        break;
      }
      case "reconcile": {
        const out = await service.reconcile(principalId, action.runId);
        cards.push({ kind: "task_run", run: out.run });
        actions.push({ tool: "task.reconcile", summary: `${action.runId} → ${out.run.state}`, status: "ok" });
        reply = out.run.state === "succeeded"
          ? `Reconciled: the change **was applied** upstream, so ${action.runId} is now succeeded.`
          : `Reconciled: the change **was not applied**. It's safe to retry with the same idempotency key.`;
        break;
      }
      case "approvals":
        cards.push({ kind: "approvals" });
        actions.push({ tool: "approvals.queue", summary: "Loaded pending task approvals", status: "ok" });
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "That didn't work.";
    actions.push({ tool: plan.action.type, summary: message, status: "error" });
    reply = `I couldn't do that: ${message}`;
  }

  return {
    reply,
    generatedBy,
    cards,
    actions,
    suggestedPrompts: plan.suggestedPrompts?.length ? plan.suggestedPrompts.slice(0, 3) : [
      "Create a P1 ticket for checkout outage on payments",
      "Show recent task runs",
      "Show pending approvals",
    ],
  };
}
