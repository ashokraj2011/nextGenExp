import { useEffect, useId, useState, type DragEvent, type ReactNode } from "react";
import { ArrowDown, ArrowRight, ArrowUp, Check, Database, FormInput, GripVertical, LayoutGrid, LayoutTemplate, List, Plus, Sparkles, Trash2, Type, X } from "lucide-react";
import { dataDictionary, type DataBindingKey } from "../../packages/contracts/data-bindings";
import type { Customer360AdminRecord } from "../../packages/contracts/customer-360";
import {
  layoutComponents, maxLayoutDescription, maxLayoutSlots, maxLayoutTargets, maxLayouts, targetKey,
  type BoundWidgetMetric, type CustomFormField, type CustomFormFieldType, type LayoutComponent, type LayoutSlot, type UiDesign, type UiLayoutCatalog, type UiLayoutChange, type UiLayoutRecord,
} from "../../packages/contracts/ui-layout";
import type { DisplayExperience } from "../../packages/contracts/surface";
import type { SavedWidget } from "../../packages/contracts/widget";
import { api, toolSetupErrorMessage } from "./api";
import { ExperienceLayoutPreview } from "./surface";
import { WidgetStudio } from "./widget-studio";
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

const quickPaletteItems: { kind: "widget" | "form" | "text" | "block"; component?: LayoutComponent; label: string }[] = [
  { kind: "widget", label: "Data-bound widget" },
  { kind: "form", label: "Interactive form" },
  { kind: "text", label: "Text section" },
  { kind: "block", component: "PznPortfolioSnapshot", label: "Portfolio snapshot" },
  { kind: "block", component: "PznMetricSummary", label: "Balance figures" },
  { kind: "block", component: "PznComparison", label: "Balance comparison" },
  { kind: "block", component: "PznGoalProgress", label: "Goal progress" },
  { kind: "block", component: "PznContentCard", label: "Information card" },
  { kind: "block", component: "PznStepList", label: "Step-by-step guide" },
];

const bindingGroups = [...new Set(dataDictionary.map((item) => item.group))];
const percentBindings = dataDictionary.filter((item) => item.kind === "percent");

type CustomBindingOption = { key: DataBindingKey; label: string; type: "text" | "currency" | "number" | "percent" };

function BindingSelect({ value, onChange, ariaLabel, emptyLabel = "Static value (unbound)", customOptions = [] }: {
  value?: DataBindingKey;
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
          {dataDictionary.filter((d) => d.group === group).map((item) => (
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

function makeNewMetric(): BoundWidgetMetric {
  return {
    id: "m_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8),
    label: "New metric",
    binding: "portfolio.total",
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

function LayoutPreview({ design, customers, previewPersonaId, onChangePreviewPersona }: {
  design: UiDesign;
  customers: Customer360AdminRecord[];
  previewPersonaId: string;
  onChangePreviewPersona: (personaId: string) => void;
}) {
  const [preview, setPreview] = useState<DisplayExperience>();
  const [error, setError] = useState("");
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    if (!design.slots.length) return;
    let active = true;
    setUpdating(true);
    setError("");
    const timer = window.setTimeout(() => {
      void api.previewUiLayout({ ...design, name: design.name.trim() || "Untitled layout" }, previewPersonaId || undefined).then((result) => {
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
    }, 240);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [design, previewPersonaId]);

  const activeCustomerName = customers.find((c) => c.personaId === previewPersonaId)?.displayName;

  return <section className="ui-work-card ui-preview" aria-label="Layout preview">
    <header className="ui-preview-head">
      <div>
        <h2>Chat preview</h2>
        <p>{activeCustomerName ? `Live Customer 360 · ${activeCustomerName}` : "Sample data"}</p>
      </div>
      {customers.length > 0 ? (
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
      ) : (
        <LayoutTemplate size={21} aria-hidden="true" />
      )}
    </header>
    <div className="ui-preview-canvas" aria-busy={design.slots.length > 0 && updating}>
      {!design.slots.length ? <p className="ui-preview-empty">Add a component to preview the layout.</p>
        : error ? <p className="ui-builder-error" role="alert">{error}</p>
        : preview ? <ExperienceLayoutPreview data={preview} /> : <p className="ui-preview-empty" role="status">Preparing preview…</p>}
    </div>
  </section>;
}

function SlotEditor({ slot, index, count, change, move, remove, onDragStart, onDragOver, onDrop, onDragEnd, isDragging, isDragOver, customOptions }: {
  slot: LayoutSlot; index: number; count: number;
  change: (slot: LayoutSlot) => void; move: (direction: number) => void; remove: () => void;
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
    : "Text section";

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

  return <li
    className={"ui-slot" + (isDragging ? " is-dragging" : "") + (isDragOver ? " is-drag-over" : "")}
    draggable
    onDragStart={onDragStart}
    onDragOver={onDragOver}
    onDrop={onDrop}
    onDragEnd={onDragEnd}
  >
    <div className="ui-slot-top">
      <div className="ui-slot-title">
        <span className="ui-drag-handle" aria-hidden="true" title="Drag to reorder"><GripVertical size={15} /></span>
        {slot.kind === "text" ? <Type size={17} aria-hidden="true" />
          : slot.kind === "form" ? <FormInput size={17} aria-hidden="true" />
          : slot.kind === "widget" ? <Database size={17} aria-hidden="true" />
          : <LayoutTemplate size={17} aria-hidden="true" />}
        <strong>{label}</strong>
      </div>
      <div className="ui-slot-controls">
        <button type="button" aria-label={"Move " + label + " up"} disabled={index === 0} onClick={() => move(-1)}><ArrowUp size={15} /></button>
        <button type="button" aria-label={"Move " + label + " down"} disabled={index === count - 1} onClick={() => move(1)}><ArrowDown size={15} /></button>
        <button type="button" aria-label={"Remove " + label} onClick={remove}><X size={16} /></button>
      </div>
    </div>
    {slot.kind === "text" && <div className="ui-slot-fields">
      <label htmlFor={id + "-heading"}>Heading</label>
      <input id={id + "-heading"} value={slot.heading} maxLength={90} onChange={(event) => change({ ...slot, heading: event.target.value })} />
      <label htmlFor={id + "-body"}>Body text</label>
      <textarea id={id + "-body"} value={slot.body} maxLength={320} rows={2} onChange={(event) => change({ ...slot, body: event.target.value })} />
      <label className="ui-checkbox">
        <input type="checkbox" checked={slot.tone === "accent"} onChange={(event) => change({ ...slot, tone: event.target.checked ? "accent" : "plain" })} />
        Highlight this section
      </label>
    </div>}
    {slot.kind === "form" && <div className="ui-slot-fields ui-form-builder">
      <div className="ui-form-meta-grid">
        <div>
          <label htmlFor={id + "-ftitle"}>Form title</label>
          <input id={id + "-ftitle"} value={slot.title} maxLength={90} placeholder="e.g. Callback request"
            onChange={(event) => change({ ...slot, title: event.target.value })} />
        </div>
        <div>
          <label htmlFor={id + "-fsubmit"}>Submit button</label>
          <input id={id + "-fsubmit"} value={slot.submitLabel} maxLength={48} placeholder="Submit"
            onChange={(event) => change({ ...slot, submitLabel: event.target.value })} />
        </div>
      </div>
      <label htmlFor={id + "-fdesc"}>Form instructions</label>
      <input id={id + "-fdesc"} value={slot.description} maxLength={240} placeholder="Optional short instructions..."
        onChange={(event) => change({ ...slot, description: event.target.value })} />
      <label className="ui-checkbox">
        <input
          type="checkbox"
          checked={slot.writeBack !== false}
          onChange={(event) => change({ ...slot, writeBack: event.target.checked })}
        />
        Write bound fields back to Customer 360 on submit
      </label>
      <div className="ui-form-fields-head">
        <span>Form fields ({slot.fields.length}/10)</span>
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
            <div className="ui-form-field-sub">
              {field.type === "select" ? (
                <input
                  aria-label={`Field ${fIdx + 1} options`}
                  value={field.options.join(", ")}
                  placeholder="Comma-separated options (e.g. Growth, Balanced, Income)"
                  onChange={(e) => updateField(fIdx, { ...field, options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10) })}
                />
              ) : field.type !== "checkbox" && field.type !== "date" ? (
                <input
                  aria-label={`Field ${fIdx + 1} placeholder`}
                  value={field.placeholder}
                  maxLength={100}
                  placeholder="Placeholder hint..."
                  onChange={(e) => updateField(fIdx, { ...field, placeholder: e.target.value })}
                />
              ) : <span />}
              <label className="ui-checkbox ui-required-toggle">
                <input type="checkbox" checked={field.required} onChange={(e) => updateField(fIdx, { ...field, required: e.target.checked })} />
                Required
              </label>
            </div>
            <div className="ui-form-binding-row">
              <span>Pre-fill from Customer 360:</span>
              <BindingSelect
                ariaLabel={`Field ${fIdx + 1} Customer 360 pre-fill`}
                value={field.defaultBinding}
                emptyLabel="None (start blank)"
                customOptions={customOptions}
                onChange={(next) => updateField(fIdx, { ...field, defaultBinding: next })}
              />
            </div>
          </div>
        ))}
      </div>
    </div>}
    {slot.kind === "widget" && <div className="ui-slot-fields ui-form-builder">
      <div className="ui-form-meta-grid">
        <div>
          <label htmlFor={id + "-wbadge"}>Badge</label>
          <input id={id + "-wbadge"} value={slot.badge} maxLength={48} placeholder="e.g. Customer 360 Live"
            onChange={(e) => change({ ...slot, badge: e.target.value })} />
        </div>
        <label className="ui-checkbox ui-accent-inline">
          <input type="checkbox" checked={slot.accentTop} onChange={(e) => change({ ...slot, accentTop: e.target.checked })} />
          Green accent top border
        </label>
      </div>
      <label htmlFor={id + "-wtitle"}>Title (supports {"{{customer.displayName}}"}, {"{{portfolio.cash}}"})</label>
      <input id={id + "-wtitle"} value={slot.title} maxLength={110} placeholder="Widget title..."
        onChange={(e) => change({ ...slot, title: e.target.value })} />
      <label htmlFor={id + "-wbody"}>Body copy</label>
      <textarea id={id + "-wbody"} value={slot.body} maxLength={320} rows={2}
        onChange={(e) => change({ ...slot, body: e.target.value })} />
      <div className="ui-form-fields-head">
        <span>Data-bound metrics ({slot.metrics.length}/6)</span>
        <button
          type="button"
          className="ui-mini-add"
          disabled={slot.metrics.length >= 6}
          onClick={() => change({ ...slot, metrics: [...slot.metrics, makeNewMetric()] })}
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
              <BindingSelect
                ariaLabel={`Metric ${mIdx + 1} data binding`}
                value={metric.binding}
                customOptions={customOptions}
                onChange={(next) => change({ ...slot, metrics: slot.metrics.map((m, i) => (i === mIdx ? { ...m, binding: next } : m)) })}
              />
            </div>
            <div className="ui-form-meta-grid">
              {!metric.binding && (
                <input
                  aria-label={`Metric ${mIdx + 1} static value`}
                  value={metric.staticValue}
                  maxLength={60}
                  placeholder="Static value (e.g. $50,000)"
                  onChange={(e) => change({ ...slot, metrics: slot.metrics.map((m, i) => (i === mIdx ? { ...m, staticValue: e.target.value } : m)) })}
                />
              )}
              <input
                aria-label={`Metric ${mIdx + 1} subtext`}
                value={metric.subtext}
                maxLength={80}
                placeholder="Subtext (supports {{...}})"
                onChange={(e) => change({ ...slot, metrics: slot.metrics.map((m, i) => (i === mIdx ? { ...m, subtext: e.target.value } : m)) })}
              />
            </div>
          </div>
        ))}
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
            {percentBindings.map((item) => (
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
          <label htmlFor={id + "-wcta"}>CTA button label (optional)</label>
          <input
            id={id + "-wcta"}
            value={slot.ctaLabel ?? ""}
            maxLength={48}
            placeholder="e.g. Review portfolio"
            onChange={(e) => change({ ...slot, ctaLabel: e.target.value || undefined })}
          />
        </div>
        <div>
          <label htmlFor={id + "-wprompt"}>CTA chat prompt</label>
          <input
            id={id + "-wprompt"}
            value={slot.ctaPrompt ?? ""}
            maxLength={200}
            placeholder="Let me know my portfolio summary."
            onChange={(e) => change({ ...slot, ctaPrompt: e.target.value || undefined })}
          />
        </div>
      </div>
    </div>}
  </li>;
}

function PanelHeading({ id, title, children }: { id: string; title: string; children?: ReactNode }) {
  return <header className="ui-panel-heading"><h2 id={id}>{title}</h2>{children}</header>;
}

function statusOf(record: UiLayoutRecord, design = record.draft) {
  if (!record.published) return "Draft";
  return normalized(record.published.design) === normalized(design) ? "Published" : "Draft changes";
}

function safeCopy(text: string, fallback: string) {
  const cleaned = text.replace(/\$?\d[\d,.]*%?/g, "").replace(/\s{2,}/g, " ").trim();
  return cleaned.length >= 6 ? cleaned : fallback;
}

function UiWorkspace({ initial, initialWidgets, customers }: {
  initial: UiLayoutCatalog;
  initialWidgets: SavedWidget[];
  customers: Customer360AdminRecord[];
}) {
  const [mode, setMode] = useState<"layouts" | "widgets">("layouts");
  const [widgets, setWidgets] = useState<SavedWidget[]>(initialWidgets);
  const [records, setRecords] = useState(initial.layouts);
  const [selected, setSelected] = useState(initial.layouts[0]?.id ?? "new");
  const [edits, setEdits] = useState<Partial<Record<string, UiDesign>>>(() => initial.layouts.length ? {} : { new: starter() });
  const [addition, setAddition] = useState<LayoutComponent | "text" | "form" | "widget">("PznComparison");
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
  const [libraryChoice, setLibraryChoice] = useState("");
  const [targetChoice, setTargetChoice] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | "end" | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const record = records.find(({ id }) => id === selected);
  const activeDesign = edits[selected] ?? record!.draft;
  const attached = new Set(activeDesign.targets.map(targetKey));
  const names = new Map(initial.targets.map((option) => [targetKey(option.target), option]));
  const choices = initial.targets.filter(({ target }) => !attached.has(targetKey(target)));
  const canPublish = Boolean(activeDesign.name.trim() && activeDesign.description.trim() && activeDesign.targets.length
    && activeDesign.slots.some(({ kind }) => kind === "block" || kind === "form" || kind === "widget")
    && activeDesign.slots.every((slot) => (
      slot.kind === "block"
      || (slot.kind === "text" && Boolean(slot.heading.trim() || slot.body.trim()))
      || (slot.kind === "form" && Boolean(slot.title.trim()) && slot.fields.length > 0)
      || (slot.kind === "widget" && Boolean(slot.title.trim()))
    )));
  const dirty = record ? normalized(activeDesign) !== normalized(record.draft) : true;

  function edit(next: UiDesign) {
    setEdits((previous) => ({ ...previous, [selected]: next }));
    setNotice("");
    setError("");
  }

  function select(id: string) {
    setSelected(id);
    setTargetChoice("");
    setError("");
    setNotice("");
  }

  function newLayout() {
    setEdits((previous) => ({ ...previous, new: previous.new ?? blank() }));
    select("new");
  }

  function buildSlot(kind: LayoutComponent | "text" | "form" | "widget"): LayoutSlot {
    const id = crypto.randomUUID();
    if (kind === "text") return { id, kind: "text", heading: "", body: "", tone: "plain" };
    if (kind === "form") return makeStarterFormSlot(id);
    if (kind === "widget") return makeStarterWidgetSlot(id);
    return { id, kind: "block", component: kind };
  }

  function insertSlotAt(slot: LayoutSlot, index?: number) {
    if (activeDesign.slots.length >= maxLayoutSlots) return;
    const nextSlots = activeDesign.slots.slice();
    if (index === undefined || index < 0 || index > nextSlots.length) nextSlots.push(slot);
    else nextSlots.splice(index, 0, slot);
    edit({ ...activeDesign, slots: nextSlots });
  }

  function addSlot() {
    insertSlotAt(buildSlot(addition));
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
    setMode("layouts");
    setNotice(`Inserted "${widget.name}" as a data-bound widget — bind any metric to Customer 360 below.`);
  }

  function handleDropAt(event: DragEvent, targetIndex?: number) {
    event.preventDefault();
    event.stopPropagation();
    const payloadRaw = event.dataTransfer.getData("application/x-cep-builder");
    setDragIndex(null);
    setDropTargetIndex(null);
    if (!payloadRaw) return;
    try {
      const payload = JSON.parse(payloadRaw) as
        | { source: "slot"; index: number }
        | { source: "palette"; kind: LayoutComponent | "text" | "form" | "widget" }
        | { source: "widget"; widgetId: string };
      if (payload.source === "slot") {
        const from = payload.index;
        const to = targetIndex === undefined ? activeDesign.slots.length - 1 : targetIndex;
        if (from === to || from < 0 || from >= activeDesign.slots.length) return;
        const next = activeDesign.slots.slice();
        const [moved] = next.splice(from, 1);
        const dest = from < to ? Math.max(0, to - 1) : to;
        next.splice(dest, 0, moved);
        edit({ ...activeDesign, slots: next });
      } else if (payload.source === "palette") {
        insertSlotAt(buildSlot(payload.kind), targetIndex);
      } else if (payload.source === "widget") {
        const widget = widgets.find((w) => w.id === payload.widgetId);
        if (widget) insertWidgetIntoLayout(widget, targetIndex);
      }
    } catch { /* Ignore non-CEP drag payloads. */ }
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
      const change: UiLayoutChange = operation === "unpublish"
        ? { operation, id: existing!.id, revision: existing!.revision }
        : existing ? { operation, ...existing, design: activeDesign } : { operation, design: activeDesign };
      const saved = await api.saveUiLayout(change);
      setRecords((previous) => [saved, ...previous.filter(({ id }) => id !== saved.id)]);
      setEdits((previous) => {
        const next = { ...previous };
        if (operation !== "unpublish") delete next[selected];
        return next;
      });
      setSelected(saved.id);
      setNotice(operation === "publish" ? "Layout published." : operation === "unpublish" ? "Layout unpublished." : "Draft saved.");
    } catch (reason) {
      setError(toolSetupErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return <main className="ui-builder-width ui-builder-main">
    <div className="ui-builder-intro">
      <div>
        <h1>UI builder</h1>
        <p>Create chat layouts, generate custom widgets from text, and save them to your library.</p>
      </div>
      <div className="ui-builder-header-right">
        <div className="ui-mode-tabs" role="tablist" aria-label="UI builder sections">
          <button type="button" role="tab" aria-selected={mode === "layouts"} onClick={() => setMode("layouts")}>
            <LayoutTemplate size={15} aria-hidden="true" />Layouts
          </button>
          <button type="button" role="tab" aria-selected={mode === "widgets"} onClick={() => setMode("widgets")}>
            <Sparkles size={15} aria-hidden="true" />Widget Studio &amp; Library ({widgets.length})
          </button>
        </div>
        {mode === "layouts" && (
          <div className="ui-editor-actions">
            <button type="button" className="ui-button ui-button-outline" disabled={busy || !activeDesign.name.trim() || !dirty} onClick={() => void save("draft")}>Save draft</button>
            <button type="button" className="ui-button ui-button-primary"
              disabled={busy || !canPublish || Boolean(record?.published && statusOf(record, activeDesign) === "Published")}
              onClick={() => void save("publish")}>Publish</button>
          </div>
        )}
      </div>
    </div>
    {mode === "widgets" ? (
      <WidgetStudio widgets={widgets} onWidgetsChange={setWidgets} onInsertIntoLayout={insertWidgetIntoLayout} />
    ) : <>
    {notice && <p className="ui-builder-notice" role="status">{notice}</p>}
    {error && <p className="ui-builder-error" role="alert">{error}</p>}
    <div className="ui-builder-workspace">
      <aside className="ui-work-card ui-library" aria-label="Layout library">
        <PanelHeading id="layout-library-heading" title="Layouts">
          <button className="ui-quiet-icon" type="button" aria-label="New layout" title="New layout"
            disabled={busy || records.length >= maxLayouts} onClick={newLayout}><Plus size={19} /></button>
        </PanelHeading>
        <nav aria-labelledby="layout-library-heading">
          {edits.new && <button type="button" aria-current={selected === "new" ? "true" : undefined} disabled={busy}
            onClick={() => select("new")}><strong>{edits.new.name.trim() || "Untitled layout"}</strong><small>Unsaved layout</small></button>}
          {records.map((item) => <button key={item.id} type="button" aria-current={selected === item.id ? "true" : undefined} disabled={busy}
            onClick={() => select(item.id)}><strong>{item.draft.name}</strong><small>{statusOf(item, edits[item.id] ?? item.draft)}</small></button>)}
        </nav>
      </aside>

      <section className="ui-work-card ui-editor" aria-labelledby="layout-details-heading">
        <PanelHeading id="layout-details-heading" title="Layout details">
          <span className={"ui-layout-status" + (record?.published ? " is-published" : "")}>
            {record?.published && <Check size={13} aria-hidden="true" />}
            {record ? statusOf(record, activeDesign) : "Draft"}
          </span>
        </PanelHeading>
        <fieldset className="ui-editor-content" disabled={busy}>
          <div className="ui-field">
            <label htmlFor="ui-name">Layout name</label>
            <input id="ui-name" value={activeDesign.name} maxLength={72} placeholder="Name this layout"
              onChange={(event) => edit({ ...activeDesign, name: event.target.value })} />
          </div>
          <div className="ui-field">
            <label htmlFor="ui-description">Description</label>
            <textarea id="ui-description" value={activeDesign.description} rows={2} maxLength={maxLayoutDescription}
              placeholder="Describe when this layout should appear."
              onChange={(event) => edit({ ...activeDesign, description: event.target.value })} />
          </div>
          <section className="ui-editor-section" aria-labelledby="ui-attachments-title">
            <h3 id="ui-attachments-title">Attach to intents</h3>
            {activeDesign.targets.length > 0 && <ul className="ui-attachments" aria-label="Attached intents and capabilities">
              {activeDesign.targets.map((target) => {
                const key = targetKey(target);
                const label = names.get(key)?.label ?? target.id;
                return <li key={key} title={names.get(key)?.description}>{label}<button type="button" aria-label={"Remove attachment " + label} onClick={() => edit({
                  ...activeDesign, targets: activeDesign.targets.filter((item) => targetKey(item) !== key),
                })}><X size={14} /></button></li>;
              })}
            </ul>}
            <div className="ui-inline-field">
              <select aria-label="Intent or capability" value={targetChoice} onChange={(event) => setTargetChoice(event.target.value)}>
                <option value="">Choose an intent or capability</option>
                <optgroup label="Chat intents">{choices.filter(({ target }) => target.kind === "intent").map(({ target, label }) => (
                  <option value={targetKey(target)} key={targetKey(target)}>{label}</option>
                ))}</optgroup>
                <optgroup label="Capabilities">{choices.filter(({ target }) => target.kind === "capability").map(({ target, label }) => (
                  <option value={targetKey(target)} key={targetKey(target)}>{label}</option>
                ))}</optgroup>
              </select>
              <button type="button" className="ui-button ui-button-outline" disabled={!targetChoice || attached.size >= maxLayoutTargets}
                onClick={() => {
                  const option = names.get(targetChoice);
                  if (option) edit({ ...activeDesign, targets: [...activeDesign.targets, option.target] });
                  setTargetChoice("");
                }}>Attach</button>
            </div>
            {names.get(targetChoice)?.description && <p className="ui-control-hint">{names.get(targetChoice)!.description}</p>}
          </section>
          <section className="ui-editor-section" aria-labelledby="ui-components-title">
            <div className="ui-components-heading">
              <h3 id="ui-components-title">Components</h3>
              <div className="ui-layout-options" role="group" aria-label="Arrangement">
                <button type="button" aria-pressed={activeDesign.layout === "stack"} onClick={() => edit({ ...activeDesign, layout: "stack" })}
                  aria-label="Stacked layout" title="Stacked layout"><List size={16} /></button>
                <button type="button" aria-pressed={activeDesign.layout === "dashboard"} onClick={() => edit({ ...activeDesign, layout: "dashboard" })}
                  aria-label="Grid layout" title="Grid layout"><LayoutGrid size={16} /></button>
              </div>
            </div>
            <div className="ui-inline-field">
              <select aria-label="Component to add" value={addition} onChange={(event) => setAddition(event.target.value as LayoutComponent | "text" | "form" | "widget")}>
                <option value="text">Text section</option>
                <option value="widget">Data-bound widget</option>
                <option value="form">Interactive form</option>
                {layoutComponents.map(({ id, label }) => <option value={id} key={id}>{label}</option>)}
              </select>
              <button type="button" className="ui-button ui-button-outline" onClick={addSlot} disabled={activeDesign.slots.length >= maxLayoutSlots}>
                <Plus size={15} aria-hidden="true" /> Add
              </button>
            </div>
            {addition !== "text" && addition !== "form" && addition !== "widget" && <p className="ui-control-hint">{layoutComponents.find(({ id }) => id === addition)?.description}</p>}
            {addition === "form" && <p className="ui-control-hint">Create a custom form with Customer 360 pre-fill and required validation.</p>}
            {addition === "widget" && <p className="ui-control-hint">Bind live Customer 360 balances, portfolio metrics, and goal progress bars.</p>}
            <div className="ui-dnd-palette" aria-label="Drag and drop widget palette">
              <span className="ui-dnd-palette-label">Drag onto canvas (or click to add):</span>
              <div className="ui-dnd-chips">
                {quickPaletteItems.map((item) => {
                  const payloadKind = item.kind === "block" ? item.component! : item.kind;
                  return (
                    <button
                      key={item.label}
                      type="button"
                      className={"ui-dnd-chip" + (item.kind === "form" || item.kind === "widget" ? " is-form-chip" : "")}
                      draggable={activeDesign.slots.length < maxLayoutSlots}
                      disabled={activeDesign.slots.length >= maxLayoutSlots}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("application/x-cep-builder", JSON.stringify({ source: "palette", kind: payloadKind }));
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      onClick={() => insertSlotAt(buildSlot(payloadKind))}
                    >
                      <GripVertical size={12} aria-hidden="true" />
                      {item.kind === "widget" ? <Database size={13} aria-hidden="true" />
                        : item.kind === "form" ? <FormInput size={13} aria-hidden="true" />
                        : item.kind === "text" ? <Type size={13} aria-hidden="true" />
                        : <LayoutTemplate size={13} aria-hidden="true" />}
                      {item.label}
                    </button>
                  );
                })}
                {widgets.slice(0, 4).map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    className="ui-dnd-chip is-widget-chip"
                    draggable={activeDesign.slots.length < maxLayoutSlots}
                    disabled={activeDesign.slots.length >= maxLayoutSlots}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("application/x-cep-builder", JSON.stringify({ source: "widget", widgetId: w.id }));
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    onClick={() => insertWidgetIntoLayout(w)}
                  >
                    <GripVertical size={12} aria-hidden="true" />
                    <Sparkles size={12} aria-hidden="true" />
                    {w.name}
                  </button>
                ))}
              </div>
            </div>
            {widgets.length > 0 && (
              <div className="ui-inline-field ui-library-insert-row">
                <select aria-label="Insert saved widget" value={libraryChoice} onChange={(event) => setLibraryChoice(event.target.value)}>
                  <option value="">Insert from Widget Library ({widgets.length})</option>
                  {widgets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                <button type="button" className="ui-button ui-button-outline" disabled={!libraryChoice || activeDesign.slots.length >= maxLayoutSlots}
                  onClick={() => {
                    const picked = widgets.find((w) => w.id === libraryChoice);
                    if (picked) insertWidgetIntoLayout(picked);
                    setLibraryChoice("");
                  }}>Insert</button>
              </div>
            )}
            <ul
              className={"ui-slots ui-drop-canvas" + (dropTargetIndex === "end" ? " is-drop-active" : "")}
              aria-label="Component order"
              onDragOver={(e) => {
                e.preventDefault();
                if (dropTargetIndex !== "end") setDropTargetIndex("end");
              }}
              onDragLeave={() => setDropTargetIndex((curr) => (curr === "end" ? null : curr))}
              onDrop={(e) => handleDropAt(e)}
            >
              {activeDesign.slots.length === 0 && (
                <li className="ui-drop-empty">Drop a widget or form here to start building your layout.</li>
              )}
              {activeDesign.slots.map((slot, index) => <SlotEditor key={slot.id} slot={slot} index={index} count={activeDesign.slots.length}
                customOptions={customBindingOptions}
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
                move={(direction) => moveSlot(index, direction)} remove={() => edit({ ...activeDesign, slots: activeDesign.slots.filter(({ id }) => id !== slot.id) })}
                change={(next) => edit({ ...activeDesign, slots: activeDesign.slots.map((item) => item.id === next.id ? next : item) })} />)}
            </ul>
          </section>
        </fieldset>
        {record?.published && <footer className="ui-editor-footer">
          <a className="ui-chat-link" href="/chat">Open chat <ArrowRight size={15} aria-hidden="true" /></a>
          <button type="button" className="ui-button ui-button-plain" disabled={busy} onClick={() => void save("unpublish")}>Unpublish</button>
        </footer>}
      </section>

      <LayoutPreview
        design={activeDesign}
        customers={customers}
        previewPersonaId={previewPersonaId}
        onChangePreviewPersona={setPreviewPersonaId}
      />
    </div>
    </>}
  </main>;
}

export function UiBuilder() {
  const [catalog, setCatalog] = useState<UiLayoutCatalog>();
  const [widgets, setWidgets] = useState<SavedWidget[]>([]);
  const [customers, setCustomers] = useState<Customer360AdminRecord[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([
      api.uiLayouts(),
      api.widgets().catch(() => ({ widgets: [] as SavedWidget[] })),
      api.customers().catch(() => ({ customers: [] as Customer360AdminRecord[] })),
    ]).then(([layoutCatalog, widgetData, customerData]) => {
      if (active) {
        setWidgets(widgetData.widgets);
        setCustomers(customerData.customers);
        setCatalog(layoutCatalog);
      }
    }, (reason: unknown) => { if (active) setError(toolSetupErrorMessage(reason)); });
    return () => { active = false; };
  }, []);
  return <div className="ui-builder">
    {catalog ? <UiWorkspace initial={catalog} initialWidgets={widgets} customers={customers} /> : <main className="ui-builder-width ui-builder-main">
      <h1>UI builder</h1>{error ? <p className="ui-builder-error" role="alert">{error}</p> : <p role="status">Loading layouts…</p>}
    </main>}
  </div>;
}
