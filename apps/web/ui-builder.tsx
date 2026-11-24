import { useEffect, useId, useState, type ReactNode } from "react";
import { ArrowDown, ArrowRight, ArrowUp, Check, LayoutGrid, LayoutTemplate, List, Plus, Type, X } from "lucide-react";
import {
  layoutComponents, maxLayoutDescription, maxLayoutSlots, maxLayoutTargets, maxLayouts, targetKey,
  type LayoutComponent, type LayoutSlot, type UiDesign, type UiLayoutCatalog, type UiLayoutChange, type UiLayoutRecord,
} from "../../packages/contracts/ui-layout";
import type { DisplayExperience } from "../../packages/contracts/surface";
import { api, toolSetupErrorMessage } from "./api";
import { ExperienceLayoutPreview } from "./surface";
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

function LayoutPreview({ design }: { design: UiDesign }) {
  const [preview, setPreview] = useState<DisplayExperience>();
  const [error, setError] = useState("");
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    if (!design.slots.length) return;
    let active = true;
    setUpdating(true);
    setError("");
    const timer = window.setTimeout(() => {
      void api.previewUiLayout({ ...design, name: design.name.trim() || "Untitled layout" }).then((result) => {
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
  }, [design]);

  return <section className="ui-work-card ui-preview" aria-label="Layout preview">
    <header className="ui-preview-head">
      <div><h2>Chat preview</h2><p>Sample data</p></div>
      <LayoutTemplate size={21} aria-hidden="true" />
    </header>
    <div className="ui-preview-canvas" aria-busy={design.slots.length > 0 && updating}>
      {!design.slots.length ? <p className="ui-preview-empty">Add a component to preview the layout.</p>
        : error ? <p className="ui-builder-error" role="alert">{error}</p>
        : preview ? <ExperienceLayoutPreview data={preview} /> : <p className="ui-preview-empty" role="status">Preparing preview…</p>}
    </div>
  </section>;
}

function SlotEditor({ slot, index, count, change, move, remove }: {
  slot: LayoutSlot; index: number; count: number;
  change: (slot: LayoutSlot) => void; move: (direction: number) => void; remove: () => void;
}) {
  const id = useId();
  const label = slot.kind === "block" ? componentLabel(slot.component) : "Text section";
  return <li className="ui-slot">
    <div className="ui-slot-top">
      <div className="ui-slot-title">
        {slot.kind === "text" ? <Type size={17} aria-hidden="true" /> : <LayoutTemplate size={17} aria-hidden="true" />}
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
  </li>;
}

function PanelHeading({ id, title, children }: { id: string; title: string; children?: ReactNode }) {
  return <header className="ui-panel-heading"><h2 id={id}>{title}</h2>{children}</header>;
}

function statusOf(record: UiLayoutRecord, design = record.draft) {
  if (!record.published) return "Draft";
  return normalized(record.published.design) === normalized(design) ? "Published" : "Draft changes";
}

function UiWorkspace({ initial }: { initial: UiLayoutCatalog }) {
  const [records, setRecords] = useState(initial.layouts);
  const [selected, setSelected] = useState(initial.layouts[0]?.id ?? "new");
  const [edits, setEdits] = useState<Partial<Record<string, UiDesign>>>(() => initial.layouts.length ? {} : { new: starter() });
  const [addition, setAddition] = useState<LayoutComponent | "text">("PznComparison");
  const [targetChoice, setTargetChoice] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const record = records.find(({ id }) => id === selected);
  const activeDesign = edits[selected] ?? record!.draft;
  const attached = new Set(activeDesign.targets.map(targetKey));
  const names = new Map(initial.targets.map((option) => [targetKey(option.target), option]));
  const choices = initial.targets.filter(({ target }) => !attached.has(targetKey(target)));
  const canPublish = Boolean(activeDesign.name.trim() && activeDesign.description.trim() && activeDesign.targets.length
    && activeDesign.slots.some(({ kind }) => kind === "block")
    && activeDesign.slots.every((slot) => slot.kind === "block" || slot.heading.trim() || slot.body.trim()));
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

  function addSlot() {
    if (activeDesign.slots.length >= maxLayoutSlots) return;
    const id = crypto.randomUUID();
    const slot: LayoutSlot = addition === "text"
      ? { id, kind: "text", heading: "", body: "", tone: "plain" }
      : { id, kind: "block", component: addition };
    edit({ ...activeDesign, slots: [...activeDesign.slots, slot] });
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
        <p>Create chat layouts and choose which intents use them.</p>
      </div>
      <div className="ui-editor-actions">
        <button type="button" className="ui-button ui-button-outline" disabled={busy || !activeDesign.name.trim() || !dirty} onClick={() => void save("draft")}>Save draft</button>
        <button type="button" className="ui-button ui-button-primary"
          disabled={busy || !canPublish || Boolean(record?.published && statusOf(record, activeDesign) === "Published")}
          onClick={() => void save("publish")}>Publish</button>
      </div>
    </div>
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
              <select aria-label="Component to add" value={addition} onChange={(event) => setAddition(event.target.value as LayoutComponent | "text")}>
                <option value="text">Text section</option>
                {layoutComponents.map(({ id, label }) => <option value={id} key={id}>{label}</option>)}
              </select>
              <button type="button" className="ui-button ui-button-outline" onClick={addSlot} disabled={activeDesign.slots.length >= maxLayoutSlots}>
                <Plus size={15} aria-hidden="true" /> Add
              </button>
            </div>
            {addition !== "text" && <p className="ui-control-hint">{layoutComponents.find(({ id }) => id === addition)?.description}</p>}
            <ul className="ui-slots" aria-label="Component order">
              {activeDesign.slots.map((slot, index) => <SlotEditor key={slot.id} slot={slot} index={index} count={activeDesign.slots.length}
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

      <LayoutPreview design={activeDesign} />
    </div>
  </main>;
}

export function UiBuilder() {
  const [catalog, setCatalog] = useState<UiLayoutCatalog>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api.uiLayouts().then((value) => { if (active) setCatalog(value); },
      (reason: unknown) => { if (active) setError(toolSetupErrorMessage(reason)); });
    return () => { active = false; };
  }, []);
  return <div className="ui-builder">
    {catalog ? <UiWorkspace initial={catalog} /> : <main className="ui-builder-width ui-builder-main">
      <h1>UI builder</h1>{error ? <p className="ui-builder-error" role="alert">{error}</p> : <p role="status">Loading layouts…</p>}
    </main>}
  </div>;
}
