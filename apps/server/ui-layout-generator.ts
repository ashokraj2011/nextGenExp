import { dataBindingKeySchema, dataDictionary, type DataBindingKey } from "../../packages/contracts/data-bindings";
import { getDomainPack, type DomainPackId } from "../../packages/contracts/domain-packs";
import {
  bindingDomain,
  targetKey,
  uiDesignSchema,
  type BoundWidgetMetric,
  type CustomFormField,
  type LayoutComponent,
  type LayoutSlot,
  type UiDesign,
  type UiTargetOption,
} from "../../packages/contracts/ui-layout";
import {
  sphotonCardBindingSchema,
  type SphotonBindingCatalog,
  type SphotonCardBinding,
} from "../../packages/sphoton";
import { callConfiguredLlmJson } from "./dynamic-ui-generator";
import type { GatewaySettings } from "./gateway";
import { slotBindingKeys, validateUiDesign } from "./ui-layouts";

export interface GeneratedBoundUiLayout {
  design: UiDesign;
  generatedBy: "copilot_llm" | "synthesizer";
  boundKeys: string[];
  boundToolFields?: string[];
  summary: string;
}

const VALID_FIELD_TYPES = new Set(["text", "number", "currency", "select", "date", "checkbox"]);
const VALID_TONES = new Set(["default", "positive", "caution"]);

function cleanSlotId(raw: unknown, fallback: string): string {
  const s = typeof raw === "string" ? raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 44) : "";
  return /^[a-zA-Z0-9_-]{1,50}$/.test(s) ? s : fallback;
}

function safeBinding(raw: unknown): DataBindingKey | undefined {
  if (typeof raw !== "string") return undefined;
  const parsed = dataBindingKeySchema.safeParse(raw.trim());
  return parsed.success ? parsed.data : undefined;
}

function extractBoundKeys(design: UiDesign) {
  return [...new Set(design.slots.flatMap(slotBindingKeys))];
}

function extractBoundToolFields(design: UiDesign): string[] {
  const fields: string[] = [];
  for (const slot of design.slots) {
    if ((slot.kind === "block" || slot.kind === "widget") && slot.toolBinding) {
      for (const binding of slot.toolBinding.bindings) {
        const [slotName, ...rest] = binding.from.split(".data.");
        const source = slot.toolBinding.sources[slotName];
        if (source && rest.length) {
          fields.push(`${source.toolRef}:${rest.join(".data.")}`);
        }
      }
    }
  }
  return [...new Set(fields)];
}

function parseOptionalToolBinding(raw: unknown): SphotonCardBinding | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const parsed = sphotonCardBindingSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function sanitizeCandidateDesign(
  raw: unknown,
  prompt: string,
  validTargets: UiTargetOption[],
): UiDesign | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const knownTargets = new Map(validTargets.map((opt) => [targetKey(opt.target), opt.target]));
  const validComponents = new Set<string>(validTargets.flatMap(({ components }) => components ?? []));
  const rawSlots = Array.isArray(obj.slots) ? obj.slots : [];
  const usedIds = new Set<string>();
  const uniqueId = (preferred: unknown, prefix: string, idx: number) => {
    let base = cleanSlotId(preferred, `${prefix}_${idx + 1}`);
    let candidate = base;
    let n = 2;
    while (usedIds.has(candidate)) {
      candidate = `${base.slice(0, 42)}_${n++}`;
    }
    usedIds.add(candidate);
    return candidate;
  };

  const slots: LayoutSlot[] = [];
  for (const [idx, item] of rawSlots.slice(0, 6).entries()) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    if (s.kind === "widget") {
      const rawMetrics = Array.isArray(s.metrics) ? s.metrics : [];
      const metrics: BoundWidgetMetric[] = [];
      for (const [mIdx, mItem] of rawMetrics.slice(0, 6).entries()) {
        if (!mItem || typeof mItem !== "object") continue;
        const m = mItem as Record<string, unknown>;
        const label = typeof m.label === "string" && m.label.trim() ? m.label.trim().slice(0, 60) : `Metric ${mIdx + 1}`;
        const binding = safeBinding(m.binding);
        metrics.push({
          id: cleanSlotId(m.id, `m_${idx}_${mIdx + 1}`),
          label,
          ...(binding ? { binding } : {}),
          staticValue: binding ? "" : String(m.staticValue ?? "—").trim().slice(0, 60),
          subtext: typeof m.subtext === "string" ? m.subtext.trim().slice(0, 80) : "",
          tone: VALID_TONES.has(String(m.tone)) ? (String(m.tone) as BoundWidgetMetric["tone"]) : "default",
        });
      }
      const progressBinding = safeBinding(s.progressBinding);
      const toolBinding = parseOptionalToolBinding(s.toolBinding);
      slots.push({
        kind: "widget",
        id: uniqueId(s.id, "widget", idx),
        badge: typeof s.badge === "string" && s.badge.trim() ? s.badge.trim().slice(0, 48) : "Live Data Card",
        title: typeof s.title === "string" && s.title.trim() ? s.title.trim().slice(0, 110) : "Live Data Summary",
        body: typeof s.body === "string" ? s.body.trim().slice(0, 320) : "",
        accentTop: s.accentTop !== false,
        metrics,
        ...(typeof s.progressLabel === "string" && s.progressLabel.trim() ? { progressLabel: s.progressLabel.trim().slice(0, 60) } : {}),
        ...(progressBinding ? { progressBinding } : {}),
        ...(typeof s.ctaLabel === "string" && s.ctaLabel.trim() ? { ctaLabel: s.ctaLabel.trim().slice(0, 48) } : {}),
        ...(typeof s.ctaPrompt === "string" && s.ctaPrompt.trim() ? { ctaPrompt: s.ctaPrompt.trim().slice(0, 200) } : {}),
        ...(toolBinding ? { toolBinding } : {}),
      });
    } else if (s.kind === "form") {
      const rawFields = Array.isArray(s.fields) ? s.fields : [];
      const fields: CustomFormField[] = [];
      for (const [fIdx, fItem] of rawFields.slice(0, 8).entries()) {
        if (!fItem || typeof fItem !== "object") continue;
        const f = fItem as Record<string, unknown>;
        const label = typeof f.label === "string" && f.label.trim() ? f.label.trim().slice(0, 80) : `Field ${fIdx + 1}`;
        const fType = VALID_FIELD_TYPES.has(String(f.type)) ? (String(f.type) as CustomFormField["type"]) : "text";
        const defaultBinding = safeBinding(f.defaultBinding);
        const options = Array.isArray(f.options)
          ? f.options.map((o) => String(o).trim().slice(0, 60)).filter(Boolean).slice(0, 10)
          : [];
        fields.push({
          id: cleanSlotId(f.id, `f_${idx}_${fIdx + 1}`),
          label,
          type: fType,
          placeholder: typeof f.placeholder === "string" ? f.placeholder.trim().slice(0, 100) : "",
          required: Boolean(f.required),
          options: fType === "select" && options.length === 0 ? ["Option 1", "Option 2"] : options,
          ...(defaultBinding ? { defaultBinding } : {}),
          ...(typeof f.initialValue === "string" && f.initialValue.trim() ? { initialValue: f.initialValue.trim().slice(0, 120) } : {}),
        });
      }
      if (fields.length > 0) {
        slots.push({
          kind: "form",
          id: uniqueId(s.id, "form", idx),
          title: typeof s.title === "string" && s.title.trim() ? s.title.trim().slice(0, 90) : "Update Details",
          description: typeof s.description === "string" ? s.description.trim().slice(0, 240) : "",
          submitLabel: typeof s.submitLabel === "string" && s.submitLabel.trim() ? s.submitLabel.trim().slice(0, 48) : "Save Changes",
          writeBack: s.writeBack !== false,
          fields,
        });
      }
    } else if (s.kind === "block" && typeof s.component === "string" && validComponents.has(s.component)) {
      const toolBinding = parseOptionalToolBinding(s.toolBinding);
      slots.push({
        kind: "block",
        id: uniqueId(s.id, "block", idx),
        component: s.component as LayoutComponent,
        ...(toolBinding ? { toolBinding } : {}),
      });
    } else if (s.kind === "text") {
      const heading = typeof s.heading === "string" ? s.heading.trim().slice(0, 90) : "";
      const body = typeof s.body === "string" ? s.body.trim().slice(0, 320) : "";
      if (heading || body) {
        slots.push({
          kind: "text",
          id: uniqueId(s.id, "text", idx),
          heading,
          body,
          tone: s.tone === "accent" ? "accent" : "plain",
        });
      }
    }
  }

  if (slots.length === 0) return null;

  const rawTargets = Array.isArray(obj.targets) ? obj.targets : [];
  const targets = rawTargets
    .filter((t): t is { kind: "intent" | "capability"; id: string } => Boolean(t && typeof t === "object" && "kind" in t && "id" in t))
    .map((t) => knownTargets.get(`${t.kind}:${t.id}`))
    .filter((t): t is NonNullable<typeof t> => Boolean(t))
    .slice(0, 4);

  const candidate: UiDesign = {
    name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim().slice(0, 72) : prompt.slice(0, 64),
    description: typeof obj.description === "string" && obj.description.trim()
      ? obj.description.trim().slice(0, 200)
      : `Copilot-generated data-bound layout for: ${prompt.slice(0, 140)}`,
    layout: obj.layout === "dashboard" ? "dashboard" : "stack",
    slots,
    targets,
  };

  const parsed = uiDesignSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function synthesizeBoundLayoutFromPrompt(prompt: string, domainId: DomainPackId, validTargets: UiTargetOption[]): UiDesign {
  const lower = prompt.toLowerCase();
  const wantsForm = /\b(form|edit|editable|update|write-?back|change|modify|submit|input)\b/i.test(lower);
  const isGoal = /\b(home|goal|down\s*payment|saving|target|progress)\b/i.test(lower);

  const findIntentTarget = (id: string) => validTargets.find((t) => t.target.kind === "intent" && t.target.id === id)?.target;

  if (domainId === "it_ops") {
    return {
      name: "IT Ops · Live P1 Incident Command",
      description: "Data-bound SRE triage view linked directly to live incident metrics, release tags, and rollback status.",
      layout: "stack",
      slots: [
        {
          kind: "widget",
          id: "ops_live_card",
          badge: "IT Ops · {{incident.severity}}",
          title: "{{incident.id}} — {{incident.title}}",
          body: "Service {{incident.service}} running {{incident.currentRelease}} in {{incident.environment}} is currently {{incident.status}}.",
          accentTop: true,
          metrics: [
            { id: "m_err", label: "Edge Error Rate", binding: "incident.errorRate", staticValue: "", subtext: "Live telemetry", tone: "caution" },
            { id: "m_lat", label: "p95 Latency", binding: "incident.p95Latency", staticValue: "", subtext: "{{incident.service}}", tone: "caution" },
            { id: "m_rel", label: "Current Release", binding: "incident.currentRelease", staticValue: "", subtext: "Prev: {{incident.previousRelease}}", tone: "default" },
            { id: "m_rb", label: "Rollback Status", binding: "incident.rollbackStatus", staticValue: "", subtext: "{{incident.environment}}", tone: "positive" },
          ],
          ctaLabel: "Open P1 Rollback Triage",
          ctaPrompt: "Build an IT incident triage dashboard for our active P1 alert",
        },
      ],
      targets: [],
    };
  }

  if (domainId === "sales_revops") {
    return {
      name: "Sales RevOps · Live Deal Desk Card",
      description: "Data-bound CRM Deal Desk view linked directly to live ARR, discount %, win probability, and close date.",
      layout: "stack",
      slots: [
        {
          kind: "widget",
          id: "sales_live_card",
          badge: "Deal Desk · {{deal.id}}",
          title: "{{deal.accountName}} — {{deal.stage}}",
          body: "{{deal.title}} led by {{deal.owner}} targeting close date {{deal.closeDate}}.",
          accentTop: true,
          metrics: [
            { id: "m_arr", label: "Annual Value (ARR)", binding: "deal.arr", staticValue: "", subtext: "{{deal.stage}}", tone: "positive" },
            { id: "m_disc", label: "Discount Requested", binding: "deal.discountPct", staticValue: "", subtext: "Status: {{deal.discountStatus}}", tone: "caution" },
            { id: "m_close", label: "Target Close Date", binding: "deal.closeDate", staticValue: "", subtext: "Owner: {{deal.owner}}", tone: "default" },
          ],
          progressLabel: "Win Probability ({{deal.winProbability}})",
          progressBinding: "deal.winProbability",
          ctaLabel: "Open Deal Desk Approval",
          ctaPrompt: "Show the enterprise discount approval card for Acme Cloud Corp",
        },
      ],
      targets: [],
    };
  }

  if (isGoal && !wantsForm) {
    const goalTarget = findIntentTarget("goal_progress");
    return {
      name: "Home Goal & Savings Tracker",
      description: "Live home-buying progress card bound to Customer 360 goal saved, target, remaining amount, and funded percentage.",
      layout: "stack",
      slots: [
        {
          kind: "widget",
          id: "home_goal_widget",
          badge: "Goal Tracker · Live",
          title: "Home Down Payment Plan for {{customer.displayName}}",
          body: "Saved {{goal.saved}} toward your {{goal.target}} target ({{goal.remaining}} remaining) alongside {{portfolio.cash}} in cash.",
          accentTop: true,
          metrics: [
            { id: "m_saved", label: "Saved So Far", binding: "goal.saved", staticValue: "", subtext: "{{goal.percentFunded}} funded", tone: "positive" },
            { id: "m_target", label: "Goal Target", binding: "goal.target", staticValue: "", subtext: "Home down payment", tone: "default" },
            { id: "m_rem", label: "Remaining Gap", binding: "goal.remaining", staticValue: "", subtext: "Available cash: {{portfolio.cash}}", tone: "caution" },
          ],
          progressLabel: "Goal Funded Progress ({{goal.saved}} / {{goal.target}})",
          progressBinding: "goal.percentFunded",
          ctaLabel: "Explore Savings Options",
          ctaPrompt: "Show my home-buying goal and savings progress.",
        },
        { kind: "block", id: "goal_block", component: "PznGoalProgress" },
      ],
      targets: goalTarget ? [goalTarget] : [],
    };
  }

  const portfolioTarget = findIntentTarget("portfolio_summary");
  const slots: LayoutSlot[] = [
    {
      kind: "widget",
      id: "wealth_exec_widget",
      badge: "Customer 360 · Live",
      title: "Wealth Snapshot for {{customer.displayName}}",
      body: "{{customer.segment}} · Funding status: {{customer.fundingStatus}} · Beneficiary: {{customer.beneficiaryStatus}}.",
      accentTop: true,
      metrics: [
        { id: "m_total", label: "Total Portfolio", binding: "portfolio.total", staticValue: "", subtext: "Live valuation", tone: "positive" },
        { id: "m_cash", label: "Cash Reserve", binding: "portfolio.cash", staticValue: "", subtext: "{{portfolio.cashPct}} of portfolio", tone: "caution" },
        { id: "m_eq", label: "Equities", binding: "portfolio.equities", staticValue: "", subtext: "{{portfolio.equitiesPct}} share", tone: "default" },
        { id: "m_avail", label: "Available Balance", binding: "balances.available", staticValue: "", subtext: "Current: {{balances.current}}", tone: "default" },
      ],
      progressLabel: "Home Goal Funded ({{goal.saved}} of {{goal.target}})",
      progressBinding: "goal.percentFunded",
      ctaLabel: "Review Stock Holdings",
      ctaPrompt: "whats in my equity book right now?",
    },
  ];

  if (wantsForm) {
    slots.push({
      kind: "form",
      id: "c360_writeback_form",
      title: "Update Customer 360 Profile (Governed Write-Back)",
      description: "Pre-filled from live Customer 360 bindings. Submitting writes back through sfield governance.",
      submitLabel: "Save to Customer 360",
      writeBack: true,
      fields: [
        {
          id: "cash_reserve",
          label: "Target Cash Reserve ($)",
          type: "currency",
          placeholder: "35000",
          required: true,
          options: [],
          defaultBinding: "portfolio.cash",
        },
        {
          id: "beneficiary_status",
          label: "Beneficiary Designation Status",
          type: "select",
          placeholder: "",
          required: true,
          options: ["on_file", "missing"],
          defaultBinding: "customer.beneficiaryStatus",
        },
        {
          id: "goal_saved",
          label: "Home Goal Saved ($)",
          type: "currency",
          placeholder: "25000",
          required: false,
          options: [],
          defaultBinding: "goal.saved",
        },
      ],
    });
  }

  return {
    name: wantsForm ? "Wealth Snapshot + Customer 360 Form" : "Wealth Executive Snapshot",
    description: "Data-bound wealth overview linked directly to live Customer 360 portfolio, cash, equity, and goal bindings.",
    layout: "stack",
    slots,
    targets: portfolioTarget ? [portfolioTarget] : [],
  };
}

function buildLayoutSystemPrompt(
  domainId: DomainPackId,
  fields: (typeof dataDictionary)[number][],
  validTargets: UiTargetOption[],
  customKeys: string[],
  bindingCatalog?: SphotonBindingCatalog,
): string {
  const dictLines = fields.map((d) => `- ${d.key} (${d.group}, ${d.kind}): ${d.label}`);
  if (customKeys.length > 0) {
    for (const key of customKeys) dictLines.push(`- ${key} (Custom Customer 360 Attribute, text)`);
  }
  const sphotonLines = (bindingCatalog?.fields ?? []).map((f) =>
    `- ${f.toolRef} -> ${f.outputPath} (${f.type}, label: "${f.label}", formats: ${f.supportedFormats.join(",")})`,
  );
  const sphotonActions = (bindingCatalog?.actions ?? []).map((a) =>
    `- ${a.toolRef} (id: ${a.id}, label: "${a.label}", update: ${a.defaultUpdate}, fixedInputs: ${Object.keys(a.fixedInputFields).join(",") || "none"}, followUp: ${a.followUpInputFields.join(",") || "none"})`,
  );
  const intentIds = validTargets.filter(({ target }) => target.kind === "intent");
  const componentIds = [...new Set(validTargets.flatMap(({ components }) => components ?? []))];
  const writeBack = domainId === "wealth";
  const exampleField = fields[0].key;

  return [
    `Design a data-bound UI for the ${getDomainPack(domainId).label} workspace. Use only this workspace's listed fields and targets.`,
    "CRITICAL RULES:",
    "1. NEVER invent hardcoded customer balances, error rates, or ARR figures when a live Data Dictionary or sfield tool binding exists. Always set `binding` / `progressBinding` / `defaultBinding` to exact keys from the Data Dictionary below, or attach a valid `toolBinding` using exposed sfield tool fields.",
    writeBack
      ? "2. If the user asks for editing, use a form with writeBack true and editable profile bindings."
      : "2. Use read-only bindings and set writeBack to false on forms. Attach widgets that use record fields to a detail or timeline intent.",
    "3. Keep slots between 1 and 4. Use widget slots for data-bound cards, form slots for inputs, and block slots with one of these components: " + componentIds.join(", ") + ".",
    "4. Set progressBinding only to a field listed below with kind percent.",
    "5. Do NOT use any external company names. Return ONLY valid JSON.",
    "",
    "AVAILABLE DATA DICTIONARY KEYS (exact strings):",
    ...dictLines,
    ...(sphotonLines.length > 0 ? ["", "EXPOSED SFIELD TOOL FIELDS (sphoton catalog):", ...sphotonLines] : []),
    ...(sphotonActions.length > 0 ? ["", "EXPOSED SFIELD ACTIONS (sphoton catalog):", ...sphotonActions] : []),
    "",
    `AVAILABLE INTENT TARGETS (optional): ${intentIds.map(({ target, label }) => `${target.id} (${label})`).join(", ")}`,
    "",
    "OUTPUT JSON SHAPE:",
    JSON.stringify({
      name: "Short layout title (max 72 chars)",
      description: "When this layout appears (max 200 chars)",
      layout: "stack | dashboard",
      targets: [],
      slots: [
        {
          kind: "widget",
          id: "slot_1",
          badge: "Badge (supports {{key}})",
          title: "Title (supports {{key}})",
          body: "Summary sentence (supports {{key}})",
          accentTop: true,
          metrics: [
            { id: "m1", label: "Label", binding: exampleField, staticValue: "", subtext: "", tone: "positive" },
          ],
          progressLabel: "Optional progress label",
          ctaLabel: "Optional button label",
          ctaPrompt: "Optional follow-up chat prompt",
        },
        {
          kind: "form",
          id: "form_1",
          title: "Optional form title",
          description: "Optional description",
          submitLabel: "Save changes",
          writeBack,
          fields: [
            { id: "f1", label: "Field name", type: "text", placeholder: "", required: true, options: [], defaultBinding: exampleField },
          ],
        },
      ],
    }),
  ].join("\n");
}

export async function generateBoundUiLayoutWithLlm(input: {
  prompt: string;
  gateway: GatewaySettings | null | undefined;
  dataDir: string;
  domainId: DomainPackId;
  validTargets: UiTargetOption[];
  customAttributeKeys?: string[];
  bindingCatalog?: SphotonBindingCatalog;
  signal?: AbortSignal;
}): Promise<GeneratedBoundUiLayout> {
  const { prompt, gateway, dataDir, domainId, validTargets, bindingCatalog } = input;
  const customKeys = domainId === "wealth" ? input.customAttributeKeys ?? [] : [];
  const fields = dataDictionary.filter(({ key }) => bindingDomain(key) === domainId);
  const allowedKeys = new Set<string>([...fields.map(({ key }) => key), ...customKeys]);
  if (gateway) {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), 16_000);
    timer.unref();
    try {
      const systemPrompt = buildLayoutSystemPrompt(domainId, fields, validTargets, customKeys, bindingCatalog);
      const raw = await callConfiguredLlmJson(gateway, dataDir, systemPrompt, prompt, controller.signal);
      const design = sanitizeCandidateDesign(raw, prompt, validTargets);
      if (design) {
        validateUiDesign(design, validTargets, false, domainId, bindingCatalog);
        const boundKeys = extractBoundKeys(design);
        const boundToolFields = extractBoundToolFields(design);
        if ((boundKeys.length > 0 || boundToolFields.length > 0) && boundKeys.every((key) => allowedKeys.has(key))) {
          return {
            design,
            generatedBy: "copilot_llm",
            boundKeys,
            ...(boundToolFields.length > 0 ? { boundToolFields } : {}),
            summary: `Generated "${design.name}" via Copilot with ${design.slots.length} slot(s) and ${boundKeys.length + boundToolFields.length} live data binding(s).`,
          };
        }
      }
    } catch {
      // An unavailable model or incompatible layout can fall back to the selected workspace.
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onParentAbort);
    }
  }

  const design = synthesizeBoundLayoutFromPrompt(prompt, domainId, validTargets);
  // Attach matching sphoton toolBinding when the prompt targets an exposed catalog field (e.g. newly exposed domain fields or goal progress).
  if (bindingCatalog && bindingCatalog.fields.length > 0) {
    const lower = prompt.toLowerCase();
    const matchedCatalogField = bindingCatalog.fields.find((f) =>
      !f.legacyBindingKey && (lower.includes(f.label.toLowerCase()) || lower.includes(f.outputPath.toLowerCase())),
    );
    const goalSlot = design.slots.find((slot) => slot.kind === "block" && slot.component === "PznGoalProgress");
    const hasGoalFields = bindingCatalog.fields.some((f) => f.toolRef === "goal.progress.read@1.0.0" && f.outputPath === "targetCents")
      && bindingCatalog.fields.some((f) => f.toolRef === "goal.progress.read@1.0.0" && f.outputPath === "history");
    if (goalSlot && goalSlot.kind === "block" && hasGoalFields) {
      const savingsAction = bindingCatalog.actions.find((a) => a.toolRef === "goal.savings.preview@1.0.0");
      const extraGoalBinding = matchedCatalogField && matchedCatalogField.toolRef === "goal.progress.read@1.0.0"
        && matchedCatalogField.outputPath !== "targetCents" && matchedCatalogField.outputPath !== "history"
        ? [{
          field: `goal.${matchedCatalogField.outputPath}`,
          from: `goal.data.${matchedCatalogField.outputPath}`,
          ...(matchedCatalogField.defaultFormat ? { format: matchedCatalogField.defaultFormat } : {}),
          required: false,
        }]
        : [];
      goalSlot.toolBinding = {
        component: "PznGoalProgress",
        sources: { goal: { toolRef: "goal.progress.read@1.0.0", read: "reuseVerifiedTurnResult" } },
        bindings: [
          { field: "goal.targetCents", from: "goal.data.targetCents", format: "currency_cents", required: true },
          { field: "goal.history", from: "goal.data.history", format: "series", required: true },
          ...extraGoalBinding,
        ],
        ...(savingsAction ? {
          actions: [{
            id: "add-monthly-savings",
            label: "Add $500 a month",
            toolRef: savingsAction.toolRef,
            fixedInputs: { extraMonthlyCents: 50_000 },
            followUpInputs: ["startMonth"],
            update: "originalCard",
          }],
        } : {}),
      };
    } else {
      const firstWidget = design.slots.find((slot) => slot.kind === "widget");
      if (matchedCatalogField && firstWidget && firstWidget.kind === "widget") {
        firstWidget.toolBinding = {
          component: "PznBoundWidget",
          sources: {
            primary: { toolRef: matchedCatalogField.toolRef, read: "reuseVerifiedTurnResult" },
          },
          bindings: [
            {
              field: "metric_1",
              from: `primary.data.${matchedCatalogField.outputPath}`,
              ...(matchedCatalogField.defaultFormat ? { format: matchedCatalogField.defaultFormat } : {}),
              label: matchedCatalogField.label,
              required: true,
            },
          ],
        };
      }
    }
  }
  const boundKeys = extractBoundKeys(design);
  const boundToolFields = extractBoundToolFields(design);
  return {
    design,
    generatedBy: "synthesizer",
    boundKeys,
    ...(boundToolFields.length > 0 ? { boundToolFields } : {}),
    summary: `Generated "${design.name}" with ${design.slots.length} slot(s) and ${boundKeys.length + boundToolFields.length} live data binding(s).`,
  };
}
