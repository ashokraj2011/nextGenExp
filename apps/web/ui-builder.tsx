import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import {
  ArrowDown, ArrowRight, ArrowUp, Check, ChevronDown, ChevronRight, Database, FormInput,
  GripVertical, LayoutGrid, LayoutTemplate, List, Plus, SlidersHorizontal, Sparkles, Trash2, Type, X,
} from "lucide-react";
import { dataDictionary, type DataBindingKey } from "../../packages/contracts/data-bindings";
import type { Customer360AdminRecord } from "../../packages/contracts/customer-360";
import {
  bindingDomain, layoutWidgets, recordIntentOption, widgetSequence, type RecordIntent, layoutComponents, layoutTargetDomain, maxLayoutDescription, maxLayoutSlots, maxLayoutTargets, maxLayouts, targetKey,
  type BoundWidgetMetric, type CustomFormField, type CustomFormFieldType, type LayoutComponent, type LayoutSlot, type UiDesign, type UiLayoutCatalog, type UiLayoutChange, type UiLayoutRecord, type WidgetSlot,
} from "../../packages/contracts/ui-layout";
import type { DisplayExperience } from "../../packages/contracts/surface";
import type { SavedWidget } from "../../packages/contracts/widget";
import { api, toolSetupErrorMessage } from "./api";
import { ExperienceCanvasView, ExperienceControls, ExperienceLayoutPreview } from "./surface";
import type { ActionMessage } from "@a2ui/web_core/v1_0";
import { adminPaths } from "../../packages/contracts/admin-paths";
import type { TurnAccepted } from "../../packages/contracts/api";
import { interactiveExperienceSchema } from "../../packages/contracts/interactive-experience";
import { diagnosticHref } from "./admin-navigation";
import { InteractiveExperienceEditor, orderExperienceTemplate, startInteractiveExperience } from "./interactive-experience-editor";
import { DesignLibrary } from "./design-library";
import { getDomainPack, type DomainPackId } from "../../packages/contracts/domain-packs";
import { WidgetStudio } from "./widget-studio";
import { SurfaceBinderLab } from "./surface-binder-lab";
import "./ui-builder.css";

const blank = (): UiDesign => ({
  name: "", description: "", layout: "stack", slots: [], targets: [],
});

const starter = (): UiDesign => ({
  name: "Balance comparison",
  description: "Use when a customer asks how available and current balances differ.",
  layout: "stack",
  slots: [
    { kind: "text", id: "intro", heading: "Understand your balances", body: "See what each balance means and when to use it.", tone: "accent" },
    { kind: "block", id: "compare", component: "PznComparison" },
  ],
  targets: [{ kind: "intent", id: "compare_balances" }],
});

const itOpsStarter = (): UiDesign => ({
  name: "IT Ops · Live P1 Incident Card",
  description: "Data-bound SRE incident triage card hydrated directly from incidents.json.",
  layout: "stack",
  slots: [
    {
      kind: "widget",
      id: "ops_incident_card",
      badge: "IT Ops · {{incident.severity}}",
      title: "{{incident.id}} — {{incident.title}}",
      body: "Service {{incident.service}} ({{incident.currentRelease}} in {{incident.environment}}) is currently {{incident.status}}.",
      accentTop: true,
      metrics: [
        { id: "m_err", label: "Error Rate", binding: "incident.errorRate", staticValue: "", subtext: "Live edge 5xx rate", tone: "caution" },
        { id: "m_lat", label: "p95 Latency", binding: "incident.p95Latency", staticValue: "", subtext: "{{incident.service}}", tone: "caution" },
        { id: "m_stat", label: "Rollback Status", binding: "incident.rollbackStatus", staticValue: "", subtext: "Prev: {{incident.previousRelease}}", tone: "default" },
      ],
      ctaLabel: "Open P1 Rollback Approval",
      ctaPrompt: "Build an IT incident triage dashboard for our active P1 alert",
    },
  ],
  targets: [{ kind: "capability", id: "ops_incident" }],
});

const salesRevOpsStarter = (): UiDesign => ({
  name: "Sales RevOps · Deal Desk Card",
  description: "Data-bound CRM Deal Desk card hydrated directly from deals.json.",
  layout: "stack",
  slots: [
    {
      kind: "widget",
      id: "sales_deal_card",
      badge: "RevOps · {{deal.id}}",
      title: "{{deal.accountName}} — {{deal.stage}}",
      body: "{{deal.title}} owned by {{deal.owner}} targeting close date {{deal.closeDate}}.",
      accentTop: true,
      metrics: [
        { id: "m_arr", label: "Annual Value (ARR)", binding: "deal.arr", staticValue: "", subtext: "{{deal.stage}}", tone: "positive" },
        { id: "m_disc", label: "Requested Discount", binding: "deal.discountPct", staticValue: "", subtext: "Status: {{deal.discountStatus}}", tone: "caution" },
        { id: "m_prob", label: "Win Probability", binding: "deal.winProbability", staticValue: "", subtext: "Close {{deal.closeDate}}", tone: "default" },
      ],
      ctaLabel: "Open Deal Desk Approval",
      ctaPrompt: "Build a Q4 deal desk and discount approval dashboard for DEAL-904",
    },
  ],
  targets: [{ kind: "capability", id: "sales_deal_desk" }],
});

const layoutPrompts: { label: string; domainId: DomainPackId; prompt: string }[] = [
  { label: "Wealth Snapshot + Write-Back", domainId: "wealth", prompt: "Build a wealth snapshot showing customer name, live total portfolio, cash reserve, equities, home goal progress bar, and an editable form to update cash reserve and beneficiary status" },
  { label: "Home Goal Tracker", domainId: "wealth", prompt: "Create a home-buying tracker bound to live goal saved, target, remaining amount, funded progress bar, and home goal progress chart" },
  { label: "IT Ops P1 War Room", domainId: "it_ops", prompt: "Build an IT Ops P1 incident triage card linked to live incident ID, service, error rate, p95 latency, release version, and rollback status" },
  { label: "Sales Deal Desk Card", domainId: "sales_revops", prompt: "Design a Sales RevOps executive card bound to live deal account name, ARR, requested discount %, win probability progress bar, and close date" },
];
const domainStarters = { wealth: starter, it_ops: itOpsStarter, sales_revops: salesRevOpsStarter };

const componentLabel = (id: LayoutComponent) => layoutComponents.find((component) => component.id === id)!.label;
const normalized = (design: UiDesign) => JSON.stringify(design);
const fieldTypes: { value: CustomFormFieldType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "currency", label: "Currency ($)" },
  { value: "number", label: "Number" },
  { value: "select", label: "Dropdown" },
  { value: "date", label: "Date" },
  { value: "checkbox", label: "Checkbox" },
];

const bindingGroups = [...new Set(dataDictionary.map((item) => item.group))];
const percentBindings = dataDictionary.filter((item) => item.kind === "percent");

type CustomBindingOption = { key: DataBindingKey; label: string; type: "text" | "currency" | "number" | "percent" };

function BindingSelect({ value, onChange, domainId, ariaLabel, emptyLabel = "Static value (unbound)", customOptions = [] }: {
  value?: DataBindingKey;
  domainId: DomainPackId;
  onChange: (next?: DataBindingKey) => void;
  ariaLabel: string;
  emptyLabel?: string;
  customOptions?: CustomBindingOption[];
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value ?? ""}
      onChange={(e) => onChange((e.target.value || undefined) as DataBindingKey | undefined)}
    >
      <option value="">{emptyLabel}</option>
      {bindingGroups.map((group) => (
        <optgroup key={group} label={group}>
          {dataDictionary.filter((d) => d.group === group && bindingDomain(d.key) === domainId).map((item) => (
            <option key={item.key} value={item.key}>{item.label}</option>
          ))}
        </optgroup>
      ))}
      {customOptions.length > 0 && (
        <optgroup label="Custom Attributes (Customer 360)">
          {customOptions.map((item) => (
            <option key={item.key} value={item.key}>{item.label} ({item.key})</option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

function InsertFieldPicker({ onInsert, customOptions, domainId }: {
  domainId: DomainPackId;
  onInsert: (token: string) => void;
  customOptions: CustomBindingOption[];
}) {
  return (
    <select
      className="ui-insert-field-select"
      aria-label="Insert live data field"
      value=""
      onChange={(e) => {
        if (e.target.value) onInsert(`{{${e.target.value}}}`);
      }}
    >
      <option value="">+ Insert live field…</option>
      {bindingGroups.map((group) => (
        <optgroup key={group} label={group}>
          {dataDictionary.filter((d) => d.group === group && bindingDomain(d.key) === domainId).map((item) => (
            <option key={item.key} value={item.key}>{item.label}</option>
          ))}
        </optgroup>
      ))}
      {customOptions.length > 0 && (
        <optgroup label="Custom Attributes">
          {customOptions.map((item) => (
            <option key={item.key} value={item.key}>{item.label}</option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

function makeStarterWidgetSlot(id: string): Extract<LayoutSlot, { kind: "widget" }> {
  return {
    id,
    kind: "widget",
    badge: "Customer 360 Live",
    title: "Portfolio pulse for {{customer.displayName}}",
    body: "Live snapshot for {{customer.segment}} — cash reserve is {{portfolio.cash}} ({{portfolio.cashPct}} of portfolio).",
    accentTop: true,
    metrics: [
      { id: "m_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8), label: "Total portfolio", binding: "portfolio.total", staticValue: "", subtext: "{{customer.fundingStatus}}", tone: "positive" },
      { id: "m_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8), label: "Cash reserve", binding: "portfolio.cash", staticValue: "", subtext: "{{portfolio.cashPct}} share", tone: "caution" },
      { id: "m_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8), label: "Available balance", binding: "balances.available", staticValue: "", subtext: "Ready to use", tone: "default" },
    ],
    progressLabel: "Home down payment progress ({{goal.saved}} of {{goal.target}})",
    progressBinding: "goal.percentFunded",
    ctaLabel: "Review portfolio",
    ctaPrompt: "Let me know my portfolio summary.",
  };
}

function makeNewMetric(domainId: DomainPackId): BoundWidgetMetric {
  return {
    id: "m_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8),
    label: "New metric",
    ...(domainId === "wealth" && { binding: "portfolio.total" }),
    staticValue: "",
    subtext: "",
    tone: "default",
  };
}

function makeStarterFormSlot(id: string): Extract<LayoutSlot, { kind: "form" }> {
  return {
    id,
    kind: "form",
    title: "Advisory intake form",
    description: "Pre-filled from your Customer 360 profile — review or adjust below.",
    submitLabel: "Save & continue",
    writeBack: true,
    fields: [
      { id: "f_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8), label: "Goal target", type: "currency", placeholder: "50000", required: true, options: [], defaultBinding: "goal.target" },
      { id: "f_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8), label: "Primary focus", type: "select", placeholder: "", required: true, options: ["Grow investments", "Home down payment", "Retirement planning"] },
    ],
  };
}

function makeNewField(): CustomFormField {
  return {
    id: "f_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8),
    label: "New field",
    type: "text",
    placeholder: "Enter value...",
    required: false,
    options: [],
  };
}

function slotMetaSummary(slot: LayoutSlot): string {
  if (slot.kind === "block") return "Built-in component";
  if (slot.kind === "text") return slot.tone === "accent" ? "Highlighted callout" : "Text note";
  if (slot.kind === "form") {
    const bound = slot.fields.filter((f) => f.defaultBinding).length;
    return `${slot.fields.length} fields${bound ? ` · ${bound} bound` : ""}${slot.writeBack !== false ? " · write-back" : ""}`;
  }
  const bound = slot.metrics.filter((m) => m.binding).length;
  return `${slot.metrics.length} metrics${bound ? ` · ${bound} live` : ""}${slot.progressBinding ? " · progress" : ""}`;
}

function LayoutChatTest({ domainId, design, personaId }: { domainId: DomainPackId; design: UiDesign; personaId?: string }) {
  const [message, setMessage] = useState("");
  const [test, setTest] = useState<{ key: string; pending?: boolean; error?: string; result?: DisplayExperience; matched?: boolean; log?: string }>();
  const key = JSON.stringify([domainId, personaId, design, message.trim()]);
  const current = test?.key === key ? test : undefined;
  const runId = useRef(0);
  useEffect(() => () => { runId.current++; }, []);

  async function run(start: () => Promise<TurnAccepted & { layoutId?: string }>, followingUp = false) {
    if (current?.pending) return;
    const id = ++runId.current;
    setTest({ key, pending: true, ...(followingUp && { result: current?.result }) });
    try {
      const accepted = await start();
      const events = await fetch(accepted.eventsUrl);
      if (!events.ok) throw new Error("The admin chat could not be opened.");
      await events.text();
      const turn = await api.turn(accepted.turnId);
      if (!turn.experience) throw new Error("The turn ended without a reply. Check the turn in Logs.");
      const matched = design.experience
        ? Boolean(turn.interactiveExperience?.publication.id === accepted.layoutId || (followingUp && turn.interactiveExperience))
        : (await api.debug(accepted.turnId)).uiLayout?.id === accepted.layoutId;
      if (runId.current === id) setTest({ key, result: turn.experience, matched,
        log: diagnosticHref(adminPaths.logs, accepted.conversation.id, accepted.turnId) });
    } catch (error) {
      if (runId.current === id) setTest({ key, error: error instanceof Error ? error.message : "The chat test could not finish.",
        ...(followingUp && { result: current?.result }) });
    }
  }

  return <details className="ui-layout-test" open={design.experience ? true : undefined}>
    <summary>Try a chat turn</summary>
    <p>{design.experience ? "Enter a matching phrase, then try the actions on the result." : "Run a message through the configured chat and published rules using this draft."}</p>
    <label>Customer message<input value={message} placeholder={design.experience ? "Enter a chat phrase" : undefined} maxLength={1600}
      onChange={(e) => setMessage(e.target.value)} /></label>
    <button className="ui-button" type="button" disabled={!message.trim() || current?.pending}
      onClick={() => void run(() => api.testUiLayout(domainId, design, message.trim(), personaId))}>
      {current?.pending ? "Waiting for reply…" : "Send message"}
    </button>
    {current?.error && <p role="alert" className="ui-builder-error">{current.error}</p>}
    {current?.result && <>
      {!current.pending && current.matched !== undefined && <p role="status">{current.matched
        ? (design.experience ? "Draft experience applied." : "Draft layout applied.")
        : "Chat returned a different experience for this message."}</p>}
      {design.experience ? <ExperienceControls.Provider value={{
        activeExperienceId: current.pending ? undefined : current.result.experienceId,
        rendered: () => undefined,
        followUp: (id: string, envelope: ActionMessage) => {
          void run(() => api.followUp(id, envelope, crypto.randomUUID()), true);
        },
      }}>
        <ExperienceCanvasView data={current.result} />
      </ExperienceControls.Provider> : <ExperienceLayoutPreview data={current.result} />}
      {design.experience && current.log && <a className="ui-chat-link" href={current.log} target="_blank" rel="noreferrer">View this turn in Logs <ArrowRight size={14} /></a>}
    </>}
  </details>;
}

function LayoutPreview({ domainId, design, customers, previewPersonaId, onChangePreviewPersona, published }: {
  domainId: DomainPackId;
  design: UiDesign;
  customers: Customer360AdminRecord[];
  previewPersonaId: string;
  onChangePreviewPersona: (personaId: string) => void;
  published?: boolean;
}) {
  const [preview, setPreview] = useState<DisplayExperience>();
  const [error, setError] = useState("");
  const [updating, setUpdating] = useState(false);
  const persona = domainId === "wealth" ? previewPersonaId || undefined : undefined;

  useEffect(() => {
    if (!design.slots.length) return;
    let active = true;
    setUpdating(true);
    setError("");
    const timer = window.setTimeout(() => {
      void api.previewUiLayout({ ...design, name: design.name.trim() || "Untitled layout" }, persona, domainId).then((result) => {
        if (active) {
          setPreview(result);
          setUpdating(false);
        }
      }, (reason: unknown) => {
        if (active) {
          setError(toolSetupErrorMessage(reason));
          setUpdating(false);
        }
      });
    }, 220);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [design, persona, domainId]);

  const activeCustomerName = customers.find((c) => c.personaId === previewPersonaId)?.displayName;

  return (
    <section className="ui-work-card ui-preview" aria-label="Layout preview">
      <header className="ui-preview-head">
        <div>
          <h2>Layout preview</h2>
          <p>{activeCustomerName ? `Sample layout for ${activeCustomerName}`
            : domainId === "wealth" ? "Sample layout" : `Sample ${getDomainPack(domainId).shortLabel} record`}</p>
        </div>
        <div className="ui-preview-head-right">
          {customers.length > 0 && (
            <select
              className="ui-preview-persona"
              aria-label="Preview as customer"
              value={previewPersonaId}
              onChange={(e) => onChangePreviewPersona(e.target.value)}
            >
              {customers.map((c) => (
                <option key={c.personaId} value={c.personaId}>Preview: {c.displayName}</option>
              ))}
            </select>
          )}
          {published && (
            <a className="ui-chat-link" href={getDomainPack(domainId).path}>
              Open chat <ArrowRight size={14} aria-hidden="true" />
            </a>
          )}
        </div>
      </header>
      <div className="ui-preview-canvas" aria-busy={design.slots.length > 0 && updating}>
        {!design.slots.length ? <p className="ui-preview-empty">Prompt Copilot above or click <strong>+ Add block</strong> to see a live preview.</p>
          : error ? <p className="ui-builder-error" role="alert">{error}</p>
          : preview ? <ExperienceLayoutPreview data={preview} /> : <p className="ui-preview-empty" role="status">Preparing preview…</p>}
      </div>
      {design.slots.length > 0 && <LayoutChatTest domainId={domainId} design={design} personaId={domainId === "wealth" ? previewPersonaId || undefined : undefined} />}
    </section>
  );
}

function NamedIntentEditor({ domain, value, attach }: {
  domain: "it_ops" | "sales_revops"; value?: RecordIntent; attach: (intent: RecordIntent) => void;
}) {
  const [label, setLabel] = useState(value?.label ?? "");
  const [examples, setExamples] = useState(value?.phrases.join("\n") ?? "");
  const [view, setView] = useState<RecordIntent["view"]>(value?.view ?? "detail");
  const phrases = examples.split("\n").map((phrase) => phrase.trim()).filter(Boolean);
  const valid = label.trim() && phrases.length > 0 && phrases.length <= 8 && phrases.every((phrase) => phrase.length >= 3 && phrase.length <= 120);
  return <details className="ui-named-intent">
    <summary>{value ? "Edit named intent" : "Create a named intent"}</summary>
    <div className="setup-field"><label>Intent name<input maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} /></label></div>
    <div className="setup-field"><label>Record view<select value={view} onChange={(e) => setView(e.target.value as RecordIntent["view"])}>
      <option value="detail">Record details</option><option value="timeline">Timeline</option><option value="list">Record list</option>
    </select></label></div>
    <div className="setup-field"><label>Chat phrases, one per line<textarea rows={2} value={examples} onChange={(e) => setExamples(e.target.value)} /></label></div>
    <button className="ui-button" type="button" disabled={!valid} onClick={() => attach({
      id: value?.id ?? domain + "_intent_" + crypto.randomUUID().replaceAll("-", ""),
      label: label.trim(), view, phrases,
    })}>{value ? "Update intent" : "Attach named intent"}</button>
  </details>;
}

function SlotAccordion({
  slot, domainId, index, count, expanded, onToggle, change, move, remove, widgets,
  onDragStart, onDragOver, onDrop, onDragEnd, isDragging, isDragOver, customOptions,
}: {
  slot: LayoutSlot; domainId: DomainPackId; index: number; count: number; widgets: ReadonlyMap<string, WidgetSlot>;
  expanded: boolean;
  onToggle: () => void;
  change: (slot: LayoutSlot) => void;
  move: (direction: number) => void;
  remove: () => void;
  onDragStart: (event: DragEvent<HTMLLIElement>) => void;
  onDragOver: (event: DragEvent<HTMLLIElement>) => void;
  onDrop: (event: DragEvent<HTMLLIElement>) => void;
  onDragEnd: () => void;
  isDragging: boolean;
  isDragOver: boolean;
  customOptions: CustomBindingOption[];
}) {
  const id = useId();
  const label = slot.kind === "block" ? componentLabel(slot.component)
    : slot.kind === "form" ? (slot.title.trim() || "Interactive form")
    : slot.kind === "widget" ? (slot.title.trim() || "Data-bound widget")
    : (slot.heading.trim() || "Text section");
  const editable = slot.kind !== "block";
  const destination = slot.kind === "widget" && slot.nextWidgetId ? widgets.get(slot.nextWidgetId) : undefined;
  const nextWidgets = slot.kind === "widget" ? [...widgets.values()].filter((candidate) => {
    const { steps, issue } = widgetSequence(candidate, widgets);
    return !issue && steps.every(({ id }) => id !== slot.id);
  }) : [];

  function updateField(fieldIndex: number, nextField: CustomFormField) {
    if (slot.kind !== "form") return;
    change({ ...slot, fields: slot.fields.map((f, i) => (i === fieldIndex ? nextField : f)) });
  }

  function moveField(fieldIndex: number, dir: -1 | 1) {
    if (slot.kind !== "form") return;
    const target = fieldIndex + dir;
    if (target < 0 || target >= slot.fields.length) return;
    const next = slot.fields.slice();
    [next[fieldIndex], next[target]] = [next[target], next[fieldIndex]];
    change({ ...slot, fields: next });
  }

  function removeField(fieldIndex: number) {
    if (slot.kind !== "form") return;
    change({ ...slot, fields: slot.fields.filter((_, i) => i !== fieldIndex) });
  }

  function addField() {
    if (slot.kind !== "form" || slot.fields.length >= 10) return;
    change({ ...slot, fields: [...slot.fields, makeNewField()] });
  }

  return (
    <li
      className={"ui-slot ui-slot-compact" + (expanded ? " is-expanded" : "") + (isDragging ? " is-dragging" : "") + (isDragOver ? " is-drag-over" : "")}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <div className="ui-slot-top">
        <button
          type="button"
          className="ui-slot-toggle"
          disabled={!editable}
          aria-expanded={editable ? expanded : undefined}
          onClick={editable ? onToggle : undefined}
        >
          <span className="ui-drag-handle" aria-hidden="true" title="Drag to reorder"><GripVertical size={14} /></span>
          {editable ? (expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />) : null}
          <span className="ui-slot-kind-icon" aria-hidden="true">
            {slot.kind === "text" ? <Type size={15} />
              : slot.kind === "form" ? <FormInput size={15} />
              : slot.kind === "widget" ? <Database size={15} />
              : <LayoutTemplate size={15} />}
          </span>
          <span className="ui-slot-label-group">
            <strong>{label}</strong>
            <small>{slotMetaSummary(slot)}{destination && ` · Next → ${destination.title || "Untitled widget"}`}</small>
          </span>
        </button>
        <div className="ui-slot-controls">
          <button type="button" aria-label={"Move " + label + " up"} disabled={index === 0} onClick={() => move(-1)}><ArrowUp size={14} /></button>
          <button type="button" aria-label={"Move " + label + " down"} disabled={index === count - 1} onClick={() => move(1)}><ArrowDown size={14} /></button>
          <button type="button" aria-label={"Remove " + label} onClick={remove}><X size={15} /></button>
        </div>
      </div>

      {expanded && slot.kind === "text" && (
        <div className="ui-slot-fields">
          <label htmlFor={id + "-heading"}>Heading</label>
          <input id={id + "-heading"} value={slot.heading} maxLength={90} onChange={(e) => change({ ...slot, heading: e.target.value })} />
          <label htmlFor={id + "-body"}>Body text</label>
          <textarea id={id + "-body"} value={slot.body} maxLength={320} rows={2} onChange={(e) => change({ ...slot, body: e.target.value })} />
          <label className="ui-checkbox">
            <input type="checkbox" checked={slot.tone === "accent"} onChange={(e) => change({ ...slot, tone: e.target.checked ? "accent" : "plain" })} />
            Highlight as accent callout
          </label>
        </div>
      )}

      {expanded && slot.kind === "form" && (
        <div className="ui-slot-fields ui-form-builder">
          <div className="ui-form-meta-grid">
            <div>
              <label htmlFor={id + "-ftitle"}>Form title</label>
              <input id={id + "-ftitle"} value={slot.title} maxLength={90} placeholder="e.g. Callback request"
                onChange={(e) => change({ ...slot, title: e.target.value })} />
            </div>
            <div>
              <label htmlFor={id + "-fsubmit"}>Submit button</label>
              <input id={id + "-fsubmit"} value={slot.submitLabel} maxLength={48} placeholder="Submit"
                onChange={(e) => change({ ...slot, submitLabel: e.target.value })} />
            </div>
          </div>
          <label className="ui-checkbox">
            <input
              type="checkbox"
              checked={slot.writeBack !== false}
              disabled={domainId !== "wealth" && slot.writeBack === false}
              onChange={(e) => change({ ...slot, writeBack: e.target.checked })}
            />
            Write bound fields back to Customer 360 on submit
          </label>
          <div className="ui-form-fields-head">
            <span>Fields ({slot.fields.length}/10)</span>
            <button type="button" className="ui-mini-add" disabled={slot.fields.length >= 10} onClick={addField}>
              <Plus size={13} aria-hidden="true" /> Add field
            </button>
          </div>
          <div className="ui-form-field-list">
            {slot.fields.map((field, fIdx) => (
              <div key={field.id} className="ui-form-field-card">
                <div className="ui-form-field-top">
                  <input
                    aria-label={`Field ${fIdx + 1} label`}
                    value={field.label}
                    maxLength={80}
                    placeholder="Field label"
                    onChange={(e) => updateField(fIdx, { ...field, label: e.target.value })}
                  />
                  <select
                    aria-label={`Field ${fIdx + 1} type`}
                    value={field.type}
                    onChange={(e) => {
                      const nextType = e.target.value as CustomFormFieldType;
                      updateField(fIdx, {
                        ...field,
                        type: nextType,
                        options: nextType === "select" && field.options.length === 0 ? ["Option 1", "Option 2"] : field.options,
                      });
                    }}
                  >
                    {fieldTypes.map((ft) => <option key={ft.value} value={ft.value}>{ft.label}</option>)}
                  </select>
                  <div className="ui-form-field-btns">
                    <button type="button" aria-label={`Move field ${fIdx + 1} up`} disabled={fIdx === 0} onClick={() => moveField(fIdx, -1)}><ArrowUp size={13} /></button>
                    <button type="button" aria-label={`Move field ${fIdx + 1} down`} disabled={fIdx === slot.fields.length - 1} onClick={() => moveField(fIdx, 1)}><ArrowDown size={13} /></button>
                    <button type="button" aria-label={`Remove field ${fIdx + 1}`} onClick={() => removeField(fIdx)}><Trash2 size={13} /></button>
                  </div>
                </div>
                <div className="ui-form-binding-row">
                  <span>Live data binding:</span>
                  <BindingSelect domainId={domainId}
                    ariaLabel={`Field ${fIdx + 1} Customer 360 pre-fill`}
                    value={field.defaultBinding}
                    emptyLabel="None (start blank)"
                    customOptions={customOptions}
                    onChange={(next) => updateField(fIdx, { ...field, defaultBinding: next })}
                  />
                </div>
                {field.type === "select" && (
                  <input
                    aria-label={`Field ${fIdx + 1} options`}
                    value={field.options.join(", ")}
                    placeholder="Comma-separated options (e.g. Growth, Balanced, Income)"
                    onChange={(e) => updateField(fIdx, { ...field, options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10) })}
                  />
                )}
              </div>
            ))}
          </div>
          <details className="ui-advanced-disclosure">
            <summary>Form instructions</summary>
            <input id={id + "-fdesc"} value={slot.description} maxLength={240} placeholder="Optional short instructions..."
              onChange={(e) => change({ ...slot, description: e.target.value })} />
          </details>
        </div>
      )}

      {expanded && slot.kind === "widget" && (
        <div className="ui-slot-fields ui-form-builder">
          <div className="ui-label-with-picker">
            <label htmlFor={id + "-wtitle"}>Title</label>
            <InsertFieldPicker domainId={domainId}
              customOptions={customOptions}
              onInsert={(token) => change({ ...slot, title: (slot.title + (slot.title ? " " : "") + token).slice(0, 110) })}
            />
          </div>
          <input id={id + "-wtitle"} value={slot.title} maxLength={110} placeholder="Widget title..."
            onChange={(e) => change({ ...slot, title: e.target.value })} />
          <div className="ui-label-with-picker">
            <label htmlFor={id + "-wbody"}>Body copy</label>
            <InsertFieldPicker domainId={domainId}
              customOptions={customOptions}
              onInsert={(token) => change({ ...slot, body: (slot.body + (slot.body ? " " : "") + token).slice(0, 320) })}
            />
          </div>
          <textarea id={id + "-wbody"} value={slot.body} maxLength={320} rows={2}
            onChange={(e) => change({ ...slot, body: e.target.value })} />

          <div className="ui-form-fields-head">
            <span>Live metrics ({slot.metrics.length}/6)</span>
            <button
              type="button"
              className="ui-mini-add"
              disabled={slot.metrics.length >= 6}
              onClick={() => change({ ...slot, metrics: [...slot.metrics, makeNewMetric(domainId)] })}
            >
              <Plus size={13} aria-hidden="true" /> Add metric
            </button>
          </div>
          <div className="ui-form-field-list">
            {slot.metrics.map((metric, mIdx) => (
              <div key={metric.id} className="ui-form-field-card">
                <div className="ui-form-field-top">
                  <input
                    aria-label={`Metric ${mIdx + 1} label`}
                    value={metric.label}
                    maxLength={60}
                    placeholder="Metric label"
                    onChange={(e) => change({ ...slot, metrics: slot.metrics.map((m, i) => (i === mIdx ? { ...m, label: e.target.value } : m)) })}
                  />
                  <select
                    aria-label={`Metric ${mIdx + 1} tone`}
                    value={metric.tone}
                    onChange={(e) => change({ ...slot, metrics: slot.metrics.map((m, i) => (i === mIdx ? { ...m, tone: e.target.value as BoundWidgetMetric["tone"] } : m)) })}
                  >
                    <option value="default">Neutral</option>
                    <option value="positive">Green</option>
                    <option value="caution">Amber</option>
                  </select>
                  <div className="ui-form-field-btns">
                    <button
                      type="button"
                      aria-label={`Remove metric ${mIdx + 1}`}
                      onClick={() => change({ ...slot, metrics: slot.metrics.filter((_, i) => i !== mIdx) })}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                <div className="ui-form-binding-row">
                  <span>Bind data:</span>
                  <BindingSelect domainId={domainId}
                    ariaLabel={`Metric ${mIdx + 1} data binding`}
                    value={metric.binding}
                    customOptions={customOptions}
                    onChange={(next) => change({ ...slot, metrics: slot.metrics.map((m, i) => (i === mIdx ? { ...m, binding: next } : m)) })}
                  />
                </div>
                {!metric.binding && (
                  <input
                    aria-label={`Metric ${mIdx + 1} static value`}
                    value={metric.staticValue}
                    maxLength={60}
                    placeholder="Static value (e.g. $50,000)"
                    onChange={(e) => change({ ...slot, metrics: slot.metrics.map((m, i) => (i === mIdx ? { ...m, staticValue: e.target.value } : m)) })}
                  />
                )}
              </div>
            ))}
          </div>

          <details className="ui-advanced-disclosure">
            <summary>Advanced (Badge, Progress Bar &amp; CTA)</summary>
            <div className="ui-advanced-body">
              <div className="ui-form-meta-grid">
                <div>
                  <label htmlFor={id + "-wbadge"}>Badge</label>
                  <input id={id + "-wbadge"} value={slot.badge} maxLength={48} placeholder="e.g. Customer 360 Live"
                    onChange={(e) => change({ ...slot, badge: e.target.value })} />
                </div>
                <label className="ui-checkbox ui-accent-inline">
                  <input type="checkbox" checked={slot.accentTop} onChange={(e) => change({ ...slot, accentTop: e.target.checked })} />
                  Green top border
                </label>
              </div>
              <div className="ui-form-meta-grid">
                <div>
                  <label htmlFor={id + "-wprogbind"}>Progress bar binding</label>
                  <select
                    id={id + "-wprogbind"}
                    value={slot.progressBinding ?? ""}
                    onChange={(e) => change({ ...slot, progressBinding: (e.target.value || undefined) as DataBindingKey | undefined })}
                  >
                    <option value="">No progress bar</option>
                    {percentBindings.filter((item) => bindingDomain(item.key) === domainId).map((item) => (
                      <option key={item.key} value={item.key}>{item.label}</option>
                    ))}
                    {customOptions.filter((item) => item.type === "percent").map((item) => (
                      <option key={item.key} value={item.key}>{item.label} ({item.key})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor={id + "-wproglabel"}>Progress bar label</label>
                  <input
                    id={id + "-wproglabel"}
                    value={slot.progressLabel ?? ""}
                    maxLength={60}
                    placeholder="e.g. Home goal progress"
                    onChange={(e) => change({ ...slot, progressLabel: e.target.value || undefined })}
                  />
                </div>
              </div>
              <div className="ui-form-meta-grid">
                <div>
                  <label htmlFor={id + "-wcta"}>CTA button label</label>
                  <input
                    id={id + "-wcta"}
                    value={slot.ctaLabel ?? ""}
                    maxLength={48}
                    placeholder={slot.nextWidgetId ? "Continue" : "e.g. Review portfolio"}
                    onChange={(e) => change({ ...slot, ctaLabel: e.target.value || undefined })}
                  />
                </div>
                <div>
                  <label htmlFor={id + "-waction"}>On button click</label>
                  <select id={id + "-waction"} value={slot.nextWidgetId ?? ""}
                    onChange={(e) => change({ ...slot, nextWidgetId: e.target.value || undefined })}>
                    <option value="">Send a chat prompt</option>
                    {nextWidgets.length > 0 && <optgroup label="Show another widget">
                      {nextWidgets.map(({ id, title }) => <option key={id} value={id}>{title || "Untitled widget"}</option>)}
                    </optgroup>}
                  </select>
                </div>
                {!slot.nextWidgetId && <div>
                  <label htmlFor={id + "-wprompt"}>CTA chat prompt</label>
                  <input
                    id={id + "-wprompt"}
                    value={slot.ctaPrompt ?? ""}
                    maxLength={200}
                    placeholder="Let me know my portfolio summary."
                    onChange={(e) => change({ ...slot, ctaPrompt: e.target.value || undefined })}
                  />
                </div>}
              </div>
              {widgets.size < 2 && <p className="ui-advanced-note">Add a second widget to link this button to another step.</p>}
            </div>
          </details>
        </div>
      )}
    </li>
  );
}

function statusOf(record: UiLayoutRecord, design = record.draft) {
  if (!record.published) return "Draft";
  return normalized(record.published.design) === normalized(design) ? "Published" : "Draft changes";
}

function UiWorkspace({ initial, customers }: {
  initial: UiLayoutCatalog;
  customers: Customer360AdminRecord[];
}) {
  const [view, setView] = useState<"editor" | "widgets" | "designs" | "surfaces">(() => {
    const param = new URLSearchParams(location.search).get("view");
    if (param === "surfaces") return "surfaces";
    return !initial.domains.length || param === "library" ? "designs" : "editor";
  });
  const [library, setLibrary] = useState(initial.library);
  const [newDomain, setNewDomain] = useState<DomainPackId>(initial.domains[0] ?? "wealth");
  const [widgets, setWidgets] = useState<SavedWidget[]>([]);
  const [records, setRecords] = useState(initial.layouts);
  const [selected, setSelected] = useState(initial.layouts[0]?.id ?? "new");
  const [edits, setEdits] = useState<Partial<Record<string, UiDesign>>>(() => initial.layouts.length ? {} : { new: domainStarters[newDomain]() });
  const [expandedSlotId, setExpandedSlotId] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [previewPersonaId, setPreviewPersonaId] = useState(customers[0]?.personaId ?? "demo-learner");

  const customBindingOptions: CustomBindingOption[] = [];
  const seenCustomKeys = new Set<string>();
  for (const customer of customers) {
    for (const attr of customer.customAttributes ?? []) {
      const fullKey = `custom.${attr.key}` as DataBindingKey;
      if (seenCustomKeys.has(fullKey)) continue;
      seenCustomKeys.add(fullKey);
      customBindingOptions.push({ key: fullKey, label: attr.label, type: attr.type });
    }
  }

  const [targetChoice, setTargetChoice] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | "end" | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiBoundKeys, setAiBoundKeys] = useState<string[]>([]);
  const [aiSource, setAiSource] = useState<"" | "copilot_llm" | "synthesizer">("");

  const record = records.find(({ id }) => id === selected);
  const domainId = record?.domainId ?? newDomain;
  const activeDesign = edits[selected] ?? record?.draft ?? domainStarters[domainId]();
  const widgetsById = layoutWidgets(activeDesign.slots);
  useEffect(() => {
    if (!initial.domains.includes(domainId)) return;
    let active = true;
    setWidgets([]);
    void api.widgets(domainId).then((result) => {
      if (active) setWidgets(result.widgets);
    }, (reason) => { if (active) setError(toolSetupErrorMessage(reason)); });
    return () => { active = false; };
  }, [domainId, initial.domains]);
  useEffect(() => {
    if (view !== "designs") return;
    let active = true;
    void api.uiLayouts().then((result) => {
      if (active) {
        setLibrary(result.library);
        setRecords((prior) => result.layouts.map((latest) => edits[latest.id] ? prior.find(({ id }) => id === latest.id) ?? latest : latest));
      }
    }, (reason) => { if (active) setError(toolSetupErrorMessage(reason)); });
    return () => { active = false; };
  }, [view]);
  const attached = new Set(activeDesign.targets.map(targetKey));
  const availableTargets = [...initial.targets, ...library.flatMap(({ design }) => design.recordIntent ? [recordIntentOption(design.recordIntent)] : [])];
  if (activeDesign.recordIntent) availableTargets.push(recordIntentOption(activeDesign.recordIntent));
  const names = new Map(availableTargets.map((option) => [targetKey(option.target), option]));
  const choices = [...names.values()].filter(({ target }) => layoutTargetDomain(target) === domainId && !attached.has(targetKey(target)));
  const canPublish = Boolean(activeDesign.name.trim() && activeDesign.targets.length
    && activeDesign.targets.every((target) => layoutTargetDomain(target) === domainId)
    && activeDesign.slots.some(({ kind }) => kind === "block" || kind === "form" || kind === "widget")
    && activeDesign.slots.every((slot) => (
      slot.kind === "block"
      || (slot.kind === "text" && Boolean(slot.heading.trim() || slot.body.trim()))
      || (slot.kind === "form" && Boolean(slot.title.trim()) && slot.fields.length > 0)
      || (slot.kind === "widget" && Boolean(slot.title.trim()))
    )));
  const experience = activeDesign.experience;
  const validExperience = Boolean(experience && interactiveExperienceSchema.safeParse(experience).success);
  const tools = initial.experienceTools ?? [];
  const publishAllowed = experience ? validExperience && experience.actions.some(({ phrases }) => phrases.length) : canPublish;
  const dirty = record ? normalized(activeDesign) !== normalized(record.draft) : true;

  function edit(next: UiDesign) {
    setEdits((previous) => ({ ...previous, [selected]: next }));
    setNotice("");
    setError("");
  }

  async function generateFromPrompt(overridePrompt?: string) {
    const text = (overridePrompt ?? aiPrompt).trim();
    if (text.length < 4) {
      setError("Describe the UI and the live data fields you want Copilot to link.");
      return;
    }
    const generationDomain = layoutPrompts.find(({ prompt }) => prompt === text)?.domainId ?? domainId;
    if (!initial.domains.includes(generationDomain)) {
      setError(`You need authoring access to ${getDomainPack(generationDomain).shortLabel} to use this prompt.`);
      return;
    }
    if (overridePrompt) setAiPrompt(overridePrompt);
    setAiGenerating(true);
    setError("");
    setNotice("");
    setAiBoundKeys([]);
    setAiSource("");
    try {
      const result = await api.generateUiLayout(text, generationDomain);
      setEdits((prev) => ({ ...prev, new: result.design }));
      setNewDomain(generationDomain);
      select("new");
      setAiBoundKeys(result.boundKeys);
      setAiSource(result.generatedBy);
      setNotice(result.summary);
    } catch (err: unknown) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setAiGenerating(false);
    }
  }

  function select(id: string) {
    setSelected(id);
    setExpandedSlotId(null);
    setTargetChoice("");
    setError("");
    setNotice("");
  }

  function newLayout() {
    setNewDomain(domainId);
    setEdits((previous) => ({ ...previous, new: blank() }));
    select("new");
    setShowDetails(true);
  }

  function newInteractive() {
    const experience = startInteractiveExperience(domainId, tools);
    if (!experience) return;
    setNewDomain(domainId);
    setEdits((previous) => ({ ...previous, new: { ...blank(), name: "Interactive experience", experience } }));
    select("new");
  }

  function buildSlot(kind: LayoutComponent | "text" | "form" | "widget"): LayoutSlot {
    const id = crypto.randomUUID();
    if (kind === "text") return { id, kind: "text", heading: "Section heading", body: "", tone: "plain" };
    if (kind === "form") return domainId === "wealth" ? makeStarterFormSlot(id) : {
      id, kind, title: "Record follow-up", description: "", submitLabel: "Continue", writeBack: false, fields: [makeNewField()],
    };
    if (kind === "widget") {
      if (domainId === "wealth") return makeStarterWidgetSlot(id);
      return { id, kind, title: "Record summary", badge: "", body: "", accentTop: false, metrics: [] };
    }
    return { id, kind: "block", component: kind };
  }

  function insertSlotAt(slot: LayoutSlot, index?: number) {
    if (activeDesign.slots.length >= maxLayoutSlots) return;
    const nextSlots = activeDesign.slots.slice();
    if (index === undefined || index < 0 || index > nextSlots.length) nextSlots.push(slot);
    else nextSlots.splice(index, 0, slot);
    edit({ ...activeDesign, slots: nextSlots });
    if (slot.kind !== "block") setExpandedSlotId(slot.id);
    setAddMenuOpen(false);
  }

  function insertWidgetIntoLayout(widget: SavedWidget, atIndex?: number) {
    if (activeDesign.slots.length >= maxLayoutSlots) return;
    const slot: Extract<LayoutSlot, { kind: "widget" }> = {
      id: "w_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
      kind: "widget",
      badge: widget.badge.slice(0, 48),
      title: widget.title.slice(0, 110),
      body: widget.body.slice(0, 320),
      accentTop: widget.accentTop,
      metrics: (widget.metrics ?? []).slice(0, 6).map((m) => ({
        id: "m_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8),
        label: m.label.slice(0, 60),
        staticValue: m.value.slice(0, 60),
        subtext: (m.delta ?? "").slice(0, 80),
        tone: m.delta?.trim().startsWith("+") ? "positive" : "default",
      })),
      ...(widget.ctaLabel ? { ctaLabel: widget.ctaLabel.slice(0, 48), ctaPrompt: widget.prompt.slice(0, 200) } : {}),
    };
    insertSlotAt(slot, atIndex);
    setView("editor");
    setNotice(`Added "${widget.name}" to this layout.`);
  }

  function handleDropAt(event: DragEvent, targetIndex?: number) {
    event.preventDefault();
    event.stopPropagation();
    const payloadRaw = event.dataTransfer.getData("application/x-cep-builder");
    setDragIndex(null);
    setDropTargetIndex(null);
    if (!payloadRaw) return;
    try {
      const payload = JSON.parse(payloadRaw) as { source: "slot"; index: number };
      if (payload.source === "slot") {
        const from = payload.index;
        const to = targetIndex === undefined ? activeDesign.slots.length - 1 : targetIndex;
        if (from === to || from < 0 || from >= activeDesign.slots.length) return;
        const next = activeDesign.slots.slice();
        const [moved] = next.splice(from, 1);
        const dest = from < to ? Math.max(0, to - 1) : to;
        next.splice(dest, 0, moved);
        edit({ ...activeDesign, slots: next });
      }
    } catch { /* ignore */ }
  }

  function moveSlot(index: number, direction: number) {
    const next = index + direction;
    if (next < 0 || next >= activeDesign.slots.length) return;
    const slots = activeDesign.slots.slice();
    [slots[index], slots[next]] = [slots[next], slots[index]];
    edit({ ...activeDesign, slots });
  }

  async function save(operation: UiLayoutChange["operation"]) {
    if (busy) return;
    setNotice("");
    setError("");
    setBusy(true);
    try {
      const existing = record && { id: record.id, revision: record.revision };
      if (operation === "unpublish" && !existing) return;
      const designToSave: UiDesign = {
        ...activeDesign,
        description: activeDesign.description.trim() || `${activeDesign.name.trim() || "Custom"} chat experience.`,
      };
      const change: UiLayoutChange = operation === "unpublish"
        ? { operation, id: existing!.id, revision: existing!.revision }
        : { operation, ...existing, domainId, design: designToSave };
      const saved = await api.saveUiLayout(change);
      setRecords((previous) => [saved, ...previous.filter(({ id }) => id !== saved.id)]);
      setLibrary((previous) => {
        const others = previous.filter((item) => item.id !== saved.id);
        return saved.published ? [{ ...saved.published, domainId: saved.domainId }, ...others] : others;
      });
      setEdits((previous) => {
        const next = { ...previous };
        if (operation !== "unpublish") delete next[selected];
        return next;
      });
      setSelected(saved.id);
      setNotice(operation === "publish" ? "Published to the shared design library." : operation === "unpublish" ? "Layout unpublished." : "Draft saved.");
    } catch (reason) {
      setError(toolSetupErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="ui-builder-width ui-builder-main ui-studio-simple">
      <header className="ui-studio-topbar">
        <div className="ui-studio-topbar-left">
          <h1>UI Studio</h1>
          {view === "widgets" && <span className="design-scope">{initial.tenantId} / {getDomainPack(domainId).label}</span>}
          {view === "editor" && (
            <div className="ui-layout-picker-row">
              <label className="design-scope">{initial.tenantId} <span aria-hidden="true">/</span>
                <select aria-label="Design domain" disabled={busy || Boolean(record)} value={domainId}
                  onChange={(event) => {
                    const next = event.target.value as DomainPackId;
                    setNewDomain(next);
                    edit({ ...activeDesign, recordIntent: undefined, targets: activeDesign.targets.filter((target) => layoutTargetDomain(target) === next),
                      ...(activeDesign.experience && next !== "wealth" && { experience: { ...activeDesign.experience, audience: "operator" } }) });
                  }}>
                  {initial.domains.map((id) => <option key={id} value={id}>{getDomainPack(id).label}</option>)}
                </select>
              </label>
              <select
                className="ui-layout-picker"
                aria-label="Select layout"
                value={selected}
                disabled={busy}
                onChange={(e) => select(e.target.value)}
              >
                {edits.new && (
                  <option value="new">{edits.new.name.trim() || "Untitled layout"} (Unsaved)</option>
                )}
                {records.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.draft.name} · {statusOf(item, edits[item.id] ?? item.draft)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ui-button ui-button-outline ui-compact-btn"
                disabled={busy || records.length >= maxLayouts}
                onClick={newLayout}
              >
                <Plus size={14} aria-hidden="true" /> New
              </button>
              <button type="button" className="ui-button ui-button-outline ui-compact-btn"
                disabled={busy || records.length >= maxLayouts || !tools.length} onClick={newInteractive}>
                <Plus size={14} aria-hidden="true" /> New experience
              </button>
              <div className="ui-popover-wrap">
                <button
                  type="button"
                  className="ui-button ui-button-outline ui-compact-btn"
                  disabled={busy || records.length >= maxLayouts}
                  onClick={() => setTemplatesOpen((o) => !o)}
                >
                  Templates <ChevronDown size={13} aria-hidden="true" />
                </button>
                {templatesOpen && (
                  <div className="ui-popover-menu" role="menu">
                    <button type="button" disabled={!initial.domains.includes("wealth") || !tools.some(({ ref }) => ref === "int.commerce_sandbox.lookup_order@1.0.0")}
                      onClick={() => {
                        setEdits((p) => ({ ...p, new: { ...blank(), name: "Order tracking",
                          description: "Check shipping progress and get an update when the delivery is confirmed.", experience: orderExperienceTemplate() } }));
                        setNewDomain("wealth"); select("new"); setTemplatesOpen(false);
                      }}>Wealth · Order tracking experience</button>
                    <button type="button" disabled={!initial.domains.includes("wealth")} onClick={() => { setEdits((p) => ({ ...p, new: starter() })); setNewDomain("wealth"); select("new"); setTemplatesOpen(false); }}>
                      Wealth · Balance Comparison
                    </button>
                    <button type="button" disabled={!initial.domains.includes("it_ops")} onClick={() => { setEdits((p) => ({ ...p, new: itOpsStarter() })); setNewDomain("it_ops"); select("new"); setTemplatesOpen(false); }}>
                      IT Ops · P1 Incident Card
                    </button>
                    <button type="button" disabled={!initial.domains.includes("sales_revops")} onClick={() => { setEdits((p) => ({ ...p, new: salesRevOpsStarter() })); setNewDomain("sales_revops"); select("new"); setTemplatesOpen(false); }}>
                      Sales RevOps · Deal Desk Card
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="ui-studio-topbar-right">
          <button type="button" className="ui-button ui-button-plain ui-compact-btn" aria-pressed={view === "surfaces"}
            onClick={() => setView(view === "surfaces" && initial.domains.length ? "editor" : "surfaces")}>
            <Sparkles size={14} aria-hidden="true" />
            {view === "surfaces" ? "Back to Studio" : "SurfaceBinder Lab"}
          </button>
          <button type="button" className="ui-button ui-button-plain ui-compact-btn" aria-pressed={view === "designs"}
            onClick={() => setView(view === "designs" && initial.domains.length ? "editor" : "designs")}>Design library</button>
          {initial.domains.length > 0 && <button
            type="button"
            className="ui-button ui-button-plain ui-compact-btn"
            onClick={() => setView(view === "widgets" ? (initial.domains.length ? "editor" : "designs") : "widgets")}
          >
            <LayoutTemplate size={14} aria-hidden="true" />
            {view === "widgets" ? "Back to Studio" : `Widget Library (${widgets.length})`}
          </button>}
          {view === "editor" && (
            <>
              <span className={"ui-layout-status" + (record?.published ? " is-published" : "")}>
                {record?.published && <Check size={12} aria-hidden="true" />}
                {record ? statusOf(record, activeDesign) : "Draft"}
              </span>
              <button
                type="button"
                className="ui-button ui-button-outline ui-compact-btn"
                disabled={busy || !activeDesign.name.trim() || !dirty || Boolean(experience && !validExperience)}
                onClick={() => void save("draft")}
              >
                Save draft
              </button>
              <button
                type="button"
                className="ui-button ui-button-primary ui-compact-btn"
                disabled={busy || !publishAllowed || !activeDesign.name.trim() || Boolean(record?.published && statusOf(record, activeDesign) === "Published")}
                onClick={() => void save("publish")}
              >
                Publish
              </button>
            </>
          )}
        </div>
      </header>

      {view !== "editor" && error && <p className="ui-builder-error" role="alert">{error}</p>}
      {view === "designs" ? (
        <DesignLibrary tenantId={initial.tenantId} library={library} records={records} targets={initial.targets} canCopy={initial.domains.length > 0}
          onOpen={(id) => { select(id); setView("editor"); }}
          onCopy={(item) => {
            setNewDomain(initial.domains.includes(item.domainId) ? item.domainId : initial.domains[0]);
            setEdits((prior) => ({ ...prior, new: { ...item.design, recordIntent: undefined, name: (item.design.name + " copy").slice(0, 72), targets: [] } }));
            select("new"); setShowDetails(true); setView("editor");
            setNotice(item.design.experience ? "Choose the domain and review your copy’s action phrases before publishing." : "Choose the domain and attach an intent or capability for your copy.");
          }} />
      ) : view === "widgets" ? (
        <WidgetStudio key={domainId} domainId={domainId} widgets={widgets} onWidgetsChange={setWidgets} onInsertIntoLayout={insertWidgetIntoLayout} />
      ) : view === "surfaces" ? (
        <SurfaceBinderLab />
      ) : experience ? (
        <>
          {notice && <p className="ui-builder-notice" role="status">{notice}</p>}
          {error && <p className="ui-builder-error" role="alert">{error}</p>}
          <div className="ui-studio-two-col ui-interactive-studio">
            <section className="ui-work-card ui-editor" aria-label="Interactive experience setup">
              <fieldset className="ui-editor-content ui-simple-editor" disabled={busy}>
                <div className="ui-identity-strip">
                  <input className="ui-name-inline-input" aria-label="Experience name" value={activeDesign.name} maxLength={72}
                    onChange={(e) => edit({ ...activeDesign, name: e.target.value })} />
                  {record?.published && <button type="button" className="ui-button ui-button-plain ui-compact-btn"
                    onClick={() => void save("unpublish")}>Unpublish</button>}
                </div>
                {record?.published && <p className="design-scope">Published revision {record.published.revision}</p>}
                <label className="ui-experience-description">Description<textarea rows={2} maxLength={maxLayoutDescription}
                  value={activeDesign.description} onChange={(e) => edit({ ...activeDesign, description: e.target.value })} /></label>
                <InteractiveExperienceEditor key={selected} value={experience} tools={tools} domain={domainId}
                  change={(next) => edit({ ...activeDesign, experience: next })} />
              </fieldset>
            </section>
            <section className="ui-work-card ui-preview" aria-label="Experience preview">
              <header className="ui-preview-head">
                <h2>Experience preview</h2>
                {record?.published && <a className="ui-chat-link" href={domainId === "wealth" && experience.audience === "operator" ? adminPaths.chat : getDomainPack(domainId).path}>Open chat <ArrowRight size={14} /></a>}
              </header>
              {domainId === "wealth" && experience.audience === "customer" && customers.length > 0 && <label className="ui-experience-persona">Preview as
                <select aria-label="Preview as customer" value={previewPersonaId} onChange={(e) => setPreviewPersonaId(e.target.value)}>
                  {customers.map(({ personaId, displayName }) => <option value={personaId} key={personaId}>{displayName}</option>)}
                </select></label>}
              <LayoutChatTest key={selected} domainId={domainId} design={activeDesign} personaId={domainId === "wealth" ? previewPersonaId || undefined : undefined} />
            </section>
          </div>
        </>
      ) : (
        <>
          <section className="ui-copilot-bar" aria-label="Generate data-bound UI with Copilot">
            <div className="ui-copilot-head">
              <div className="ui-copilot-title">
                <Sparkles size={16} aria-hidden="true" />
                <strong>Describe your UI — Copilot builds it and links live data</strong>
              </div>
              {aiSource && (
                <span className="ui-copilot-source-pill">
                  {aiSource === "copilot_llm" ? "Copilot ACP" : "Data-Bound Synthesizer"}
                </span>
              )}
            </div>
            <form
              className="ui-copilot-form"
              onSubmit={(e) => {
                e.preventDefault();
                void generateFromPrompt();
              }}
            >
              <input
                type="text"
                value={aiPrompt}
                disabled={aiGenerating || busy}
                placeholder="e.g. Wealth snapshot with live total portfolio, cash reserve, home goal progress bar, and beneficiary form..."
                aria-label="Prompt to generate data-bound UI layout"
                onChange={(e) => setAiPrompt(e.target.value)}
              />
              <button type="submit" className="ui-button ui-button-primary" disabled={aiGenerating || busy || aiPrompt.trim().length < 4}>
                <Sparkles size={14} aria-hidden="true" />
                {aiGenerating ? "Generating…" : "Generate & Link Data"}
              </button>
            </form>
            <div className="ui-copilot-examples">
              <span>Quick prompts:</span>
              {layoutPrompts.filter((example) => initial.domains.includes(example.domainId)).map((ex) => (
                <button
                  key={ex.label}
                  type="button"
                  className="ui-copilot-chip"
                  disabled={aiGenerating || busy}
                  onClick={() => void generateFromPrompt(ex.prompt)}
                >
                  {ex.label}
                </button>
              ))}
            </div>
            {aiBoundKeys.length > 0 && (
              <div className="ui-copilot-bindings">
                <span><Database size={13} aria-hidden="true" /> Linked live fields ({aiBoundKeys.length}):</span>
                {aiBoundKeys.map((key) => <code key={key}>{key}</code>)}
              </div>
            )}
          </section>

          {notice && <p className="ui-builder-notice" role="status">{notice}</p>}
          {error && <p className="ui-builder-error" role="alert">{error}</p>}

          <div className="ui-studio-two-col">
            <section className="ui-work-card ui-editor" aria-label="Layout blocks and settings">
              <fieldset className="ui-editor-content ui-simple-editor" disabled={busy}>
                <div className="ui-identity-strip">
                  <input
                    className="ui-name-inline-input"
                    aria-label="Layout name"
                    value={activeDesign.name}
                    maxLength={72}
                    placeholder="Name this layout..."
                    onChange={(e) => edit({ ...activeDesign, name: e.target.value })}
                  />
                  <button
                    type="button"
                    className={"ui-icon-pill" + (showDetails ? " is-active" : "")}
                    title="Edit description & unpublish options"
                    onClick={() => setShowDetails((v) => !v)}
                  >
                    <SlidersHorizontal size={14} aria-hidden="true" /> Details
                  </button>
                </div>

                {showDetails && (
                  <div className="ui-details-drawer">
                    <label htmlFor="ui-description">When should this layout appear?</label>
                    <textarea
                      id="ui-description"
                      value={activeDesign.description}
                      rows={2}
                      maxLength={maxLayoutDescription}
                      placeholder="Short description of when chat should render this layout..."
                      onChange={(e) => edit({ ...activeDesign, description: e.target.value })}
                    />
                    {record?.published && (
                      <div className="ui-details-actions">
                        <button type="button" className="ui-button ui-button-plain ui-compact-btn" disabled={busy} onClick={() => void save("unpublish")}>
                          Unpublish layout
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div className="ui-targets-strip">
                  <span className="ui-strip-label">Show on intent:</span>
                  {activeDesign.targets.map((target) => {
                    const key = targetKey(target);
                    const label = names.get(key)?.label ?? target.id;
                    return (
                      <span key={key} className="ui-target-chip">
                        {label}
                        <button
                          type="button"
                          aria-label={"Remove " + label}
                          onClick={() => edit({ ...activeDesign, recordIntent: activeDesign.recordIntent?.id === target.id ? undefined : activeDesign.recordIntent, targets: activeDesign.targets.filter((i) => targetKey(i) !== key) })}
                        >
                          <X size={12} />
                        </button>
                      </span>
                    );
                  })}
                  {attached.size < maxLayoutTargets && (
                    <select
                      className="ui-target-add-select"
                      aria-label="Attach intent or capability"
                      value={targetChoice}
                      onChange={(e) => {
                        const val = e.target.value;
                        const option = names.get(val);
                        if (option) edit({ ...activeDesign, targets: [...activeDesign.targets, option.target] });
                        setTargetChoice("");
                      }}
                    >
                      <option value="">+ Attach intent…</option>
                      <optgroup label="Chat intents">
                        {choices.filter(({ target }) => target.kind === "intent").map(({ target, label }) => (
                          <option value={targetKey(target)} key={targetKey(target)}>{label}</option>
                        ))}
                      </optgroup>
                      <optgroup label="Capabilities">
                        {choices.filter(({ target }) => target.kind === "capability").map(({ target, label }) => (
                          <option value={targetKey(target)} key={targetKey(target)}>{label}</option>
                        ))}
                      </optgroup>
                    </select>
                  )}
                </div>

                {domainId !== "wealth" && (activeDesign.recordIntent || activeDesign.targets.length < maxLayoutTargets) &&
                  <NamedIntentEditor key={selected + domainId + (activeDesign.recordIntent?.id ?? "")} domain={domainId} value={activeDesign.recordIntent}
                    attach={(intent) => edit({ ...activeDesign, recordIntent: intent,
                      targets: [...activeDesign.targets.filter((target) => target.id !== intent.id), { kind: "intent", id: intent.id }] })} />}

                <div className="ui-blocks-bar">
                  <h3>Blocks ({activeDesign.slots.length})</h3>
                  <div className="ui-blocks-bar-actions">
                    <div className="ui-layout-options" role="group" aria-label="Arrangement">
                      <button type="button" aria-pressed={activeDesign.layout === "stack"} onClick={() => edit({ ...activeDesign, layout: "stack" })}
                        aria-label="Stacked layout" title="Stacked layout"><List size={15} /></button>
                      <button type="button" aria-pressed={activeDesign.layout === "dashboard"} onClick={() => edit({ ...activeDesign, layout: "dashboard" })}
                        aria-label="Grid layout" title="Grid layout"><LayoutGrid size={15} /></button>
                    </div>
                    <div className="ui-popover-wrap">
                      <button
                        type="button"
                        className="ui-button ui-button-primary ui-compact-btn"
                        disabled={activeDesign.slots.length >= maxLayoutSlots}
                        onClick={() => setAddMenuOpen((o) => !o)}
                      >
                        <Plus size={14} aria-hidden="true" /> Add block
                      </button>
                      {addMenuOpen && (
                        <div className="ui-popover-menu ui-add-block-menu" role="menu">
                          <div className="ui-popover-group">Data-Bound &amp; Interactive</div>
                          <button type="button" onClick={() => insertSlotAt(buildSlot("widget"))}>
                            <Database size={14} aria-hidden="true" /> Data-bound widget
                          </button>
                          <button type="button" onClick={() => insertSlotAt(buildSlot("form"))}>
                            <FormInput size={14} aria-hidden="true" /> Interactive write-back form
                          </button>
                          <button type="button" onClick={() => insertSlotAt(buildSlot("text"))}>
                            <Type size={14} aria-hidden="true" /> Text / callout section
                          </button>
                          <div className="ui-popover-group">Built-In Wealth Blocks</div>
                          {layoutComponents.filter((comp) => activeDesign.targets.length ? activeDesign.targets.every((target) => names.get(targetKey(target))?.components?.includes(comp.id))
                            : domainId === "wealth" ? comp.id !== "PznDynamicCanvas" : comp.id === "PznDynamicCanvas").map((comp) => (
                            <button key={comp.id} type="button" onClick={() => insertSlotAt(buildSlot(comp.id))}>
                              <LayoutTemplate size={14} aria-hidden="true" /> {comp.label}
                            </button>
                          ))}
                          {widgets.length > 0 && (
                            <>
                              <div className="ui-popover-group">Saved Widgets ({widgets.length})</div>
                              {widgets.slice(0, 6).map((w) => (
                                <button key={w.id} type="button" onClick={() => insertWidgetIntoLayout(w)}>
                                  <Sparkles size={14} aria-hidden="true" /> {w.name}
                                </button>
                              ))}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <ul
                  className={"ui-slots ui-drop-canvas" + (dropTargetIndex === "end" ? " is-drop-active" : "")}
                  aria-label="Layout blocks"
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dropTargetIndex !== "end") setDropTargetIndex("end");
                  }}
                  onDragLeave={() => setDropTargetIndex((curr) => (curr === "end" ? null : curr))}
                  onDrop={(e) => handleDropAt(e)}
                >
                  {activeDesign.slots.length === 0 && (
                    <li className="ui-drop-empty">
                      No blocks yet. Prompt Copilot above or click <strong>+ Add block</strong>.
                    </li>
                  )}
                  {activeDesign.slots.map((slot, index) => (
                    <SlotAccordion
                      key={slot.id}
                      slot={slot}
                      widgets={widgetsById}
                      index={index}
                      count={activeDesign.slots.length}
                      expanded={expandedSlotId === slot.id}
                      onToggle={() => setExpandedSlotId((curr) => (curr === slot.id ? null : slot.id))}
                      domainId={domainId} customOptions={domainId === "wealth" ? customBindingOptions : []}
                      isDragging={dragIndex === index}
                      isDragOver={dropTargetIndex === index}
                      onDragStart={(e) => {
                        setDragIndex(index);
                        e.dataTransfer.setData("application/x-cep-builder", JSON.stringify({ source: "slot", index }));
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (dropTargetIndex !== index) setDropTargetIndex(index);
                      }}
                      onDrop={(e) => handleDropAt(e, index)}
                      onDragEnd={() => { setDragIndex(null); setDropTargetIndex(null); }}
                      move={(direction) => moveSlot(index, direction)}
                      remove={() => {
                        if (expandedSlotId === slot.id) setExpandedSlotId(null);
                        const slots = activeDesign.slots.filter(({ id }) => id !== slot.id).map((item) =>
                          item.kind === "widget" && item.nextWidgetId === slot.id ? { ...item, nextWidgetId: undefined } : item);
                        edit({ ...activeDesign, slots });
                      }}
                      change={(next) => edit({ ...activeDesign, slots: activeDesign.slots.map((item) => item.id === next.id ? next : item) })}
                    />
                  ))}
                </ul>
              </fieldset>
            </section>

            <LayoutPreview
              key={domainId}
              domainId={domainId}
              design={activeDesign}
              customers={domainId === "wealth" ? customers : []}
              previewPersonaId={previewPersonaId}
              onChangePreviewPersona={setPreviewPersonaId}
              published={Boolean(record?.published)}
            />
          </div>
        </>
      )}
    </main>
  );
}

export function UiBuilder() {
  const [catalog, setCatalog] = useState<UiLayoutCatalog>();
  const [customers, setCustomers] = useState<Customer360AdminRecord[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([
      api.uiLayouts(),
      api.customers().catch(() => ({ customers: [] as Customer360AdminRecord[] })),
    ]).then(([layoutCatalog, customerData]) => {
      if (active) {
        setCustomers(customerData.customers);
        setCatalog(layoutCatalog);
      }
    }, (reason: unknown) => { if (active) setError(toolSetupErrorMessage(reason)); });
    return () => { active = false; };
  }, []);
  return (
    <div className="ui-builder">
      {catalog ? <UiWorkspace initial={catalog} customers={customers} /> : (
        <main className="ui-builder-width ui-builder-main">
          <h1>UI Studio</h1>
          {error ? <p className="ui-builder-error" role="alert">{error}</p> : <p role="status">Loading layouts…</p>}
        </main>
      )}
    </div>
  );
}
