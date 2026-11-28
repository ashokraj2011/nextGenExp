import { useMemo, useState } from "react";
import {
  ArrowLeft, ArrowRight, Check, CheckCircle2, Circle, Layers, MessageSquare, MousePointerClick, Plus, Sparkles, Wand2, X,
} from "lucide-react";
import type { InteractiveAction, InteractiveClick, InteractiveExperience, InteractiveScalar } from "../../packages/contracts/interactive-experience";
import type { UiExperienceTool } from "../../packages/contracts/ui-layout";
import type { DomainPackId } from "../../packages/contracts/domain-packs";

type OutputField = { path: string; type: string };
type WizardStep = 1 | 2 | 3 | 4;

const asObject = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

function resultFields(schema: Record<string, unknown>, prefix = "", depth = 0): OutputField[] {
  if (depth > 5) return [];
  return Object.entries(asObject(schema.properties)).flatMap(([key, value]) => {
    const path = prefix + key;
    const field = asObject(value);
    return field.type === "object" ? resultFields(field, path + ".", depth + 1) : [{ path, type: String(field.type) }];
  });
}

function resultSchemaAt(schema: Record<string, unknown>, path: string) {
  for (const key of path.split(".")) schema = asObject(asObject(schema.properties)[key]);
  return schema;
}

const scalarFields = (fields: OutputField[]) => fields.filter(({ type }) => ["string", "integer", "number", "boolean"].includes(type));
const makeLabel = (key: string) => key.split(".").at(-1)!.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2")
  .replace(/^./, (letter) => letter.toUpperCase()).slice(0, 40);

const friendlyToolName = (ref: string): string => {
  const withoutVersion = ref.split("@")[0] ?? ref;
  const parts = withoutVersion.split(".");
  const action = parts.at(-1) ?? withoutVersion;
  const scope = parts.length > 1 ? parts.at(-2) : "";
  const fmt = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return scope ? `${fmt(scope)} · ${fmt(action)}` : fmt(action);
};

const fieldsFor = (tool: UiExperienceTool | undefined, audience: InteractiveExperience["audience"]) =>
  (audience === "customer" ? tool?.customerInputs : tool?.inputs) ?? [];

const asValue = (value: string, type?: string): InteractiveScalar => {
  if (type === "boolean") return value === "true";
  if ((type === "integer" || type === "number") && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return value;
};

function suggestedPhrasesFor(tool: UiExperienceTool | undefined, audience: InteractiveExperience["audience"]): string[] {
  const inputs = fieldsFor(tool, audience);
  const firstInput = inputs[0]?.key;
  if (firstInput) {
    const noun = firstInput.replace(/Id$/i, "").replace(/_/g, " ").toLowerCase() || "record";
    return [
      `Check my ${noun} {{${firstInput}}}`,
      `Track ${noun} {{${firstInput}}}`,
      `Show details for {{${firstInput}}}`,
    ];
  }
  const label = tool ? friendlyToolName(tool.ref).split("·").at(-1)!.trim().toLowerCase() : "records";
  return [`Show my ${label}`, `Check ${label} status`];
}

function freshAction(id: string, tool: UiExperienceTool, audience: InteractiveExperience["audience"], title: string): InteractiveAction {
  const fields = scalarFields(resultFields(tool.outputSchema)).filter(({ path }) => audience !== "customer" || tool.customerFields?.includes(path));
  return {
    id, taskRef: tool.ref, title, phrases: [],
    metrics: fields.slice(0, 2).map(({ path }) => ({ label: makeLabel(path), path })),
  };
}

export function startInteractiveExperience(domain: DomainPackId, tools: UiExperienceTool[]): InteractiveExperience | undefined {
  const defaultTool = tools.find(({ customer }) => customer && domain === "wealth") ?? tools[0];
  if (!defaultTool) return;
  const audience = domain === "wealth" && defaultTool.customer ? "customer" : "operator";
  return { audience, actions: [freshAction("start", defaultTool, audience, "Summary card")] };
}

export function orderExperienceTemplate(): InteractiveExperience {
  const taskRef = "int.commerce_sandbox.lookup_order@1.0.0";
  const metrics = [
    { path: "orderId", label: "Order" }, { path: "status", label: "Status" },
    { path: "total", label: "Order total (USD)" },
  ];
  return { audience: "customer", actions: [
    {
      id: "order", title: "Order summary", taskRef, phrases: ["Track shipment {{orderId}}"], metrics,
      onClick: { action: "delivery", label: "Track delivery", prompt: "Show my delivery details", inputs: { orderId: "orderId" } },
    },
    {
      id: "delivery", title: "Delivery tracking", taskRef, phrases: ["Track delivery {{orderId}}", "Check delivery again"],
      reuseSelectedRecord: true, metrics, completion: { path: "status", equals: "delivered", label: "Delivery confirmed" },
    },
  ] };
}

function FieldSelect({ label, value, fields, onChange }: {
  label: string; value: string; fields: OutputField[]; onChange: (path: string) => void;
}) {
  return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}>
    <option value="">Choose a field</option>
    {value && !fields.some(({ path }) => path === value) && <option value={value}>{value} (unavailable)</option>}
    {fields.map(({ path, type }) => <option key={path} value={path}>{makeLabel(path)} ({path} · {type})</option>)}
  </select></label>;
}

type Binding = InteractiveAction["metrics"][number];
function Bindings({ label, values, fields, max, change }: {
  label: string; values: Binding[]; fields: OutputField[]; max: number; change: (values: Binding[]) => void;
}) {
  const first = fields.find(({ path }) => !values.some((item) => item.path === path));
  return <div className="ui-experience-section">
    <div className="wiz-subhead">
      <h3>{label}</h3>
      <span className="wiz-count">{values.length} / {max} selected</span>
    </div>
    {fields.length > 0 && (
      <div className="wiz-field-chips" role="group" aria-label={`Quick toggle ${label.toLowerCase()}`}>
        {fields.map(({ path }) => {
          const active = values.some((item) => item.path === path);
          const disabled = !active && values.length >= max;
          return (
            <button
              key={path}
              type="button"
              className={"wiz-field-chip" + (active ? " is-selected" : "")}
              disabled={disabled}
              onClick={() => {
                if (active) change(values.filter((item) => item.path !== path));
                else change([...values, { label: makeLabel(path), path }]);
              }}
            >
              {active ? <Check size={12} aria-hidden="true" /> : <Plus size={12} aria-hidden="true" />}
              {makeLabel(path)}
            </button>
          );
        })}
      </div>
    )}
    {values.map((item, index) => {
      const changeItem = (next: Binding) => change(values.map((value, i) => i === index ? next : value));
      return <div className="ui-experience-binding" key={index}>
        <label>Display label<input value={item.label} maxLength={40} onChange={(e) => changeItem({ ...item, label: e.target.value })} /></label>
        <FieldSelect label="Result field" value={item.path} fields={fields} onChange={(path) => changeItem({ label: item.label, path })} />
        <button type="button" className="ui-button ui-button-plain" aria-label={`Remove ${item.label || "field"}`}
          onClick={() => change(values.filter((_, i) => i !== index))}><X size={16} /></button>
      </div>;
    })}
    {values.length < max && first && (
      <button type="button" className="ui-button ui-button-outline ui-compact-btn"
        onClick={() => change([...values, { label: makeLabel(first.path), path: first.path }])}><Plus size={14} /> Add field</button>
    )}
  </div>;
}

function ClickEditor({ label, click, actions, fields, tools, audience, onCreateLinkedScreen, change }: {
  label: string; click?: InteractiveClick; actions: InteractiveAction[]; fields: OutputField[]; tools: UiExperienceTool[];
  audience: InteractiveExperience["audience"]; onCreateLinkedScreen?: () => void; change: (next: InteractiveClick | undefined) => void;
}) {
  const target = actions.find(({ id }) => id === click?.action);
  const inputs = fieldsFor(tools.find(({ ref }) => ref === target?.taskRef), audience);

  function autoBindFor(actionId: string) {
    const match = actions.find(({ id }) => id === actionId);
    if (!match) return;
    const matchInputs = fieldsFor(tools.find(({ ref }) => ref === match.taskRef), audience);
    const autoInputs: Record<string, string> = {};
    for (const inp of matchInputs) {
      const exact = fields.find((f) => f.path === inp.key || f.path.endsWith("." + inp.key));
      if (exact) autoInputs[inp.key] = exact.path;
    }
    change({ action: actionId, label: `View ${match.title.toLowerCase()}`.slice(0, 40), prompt: `Show ${match.title.toLowerCase()}`, inputs: autoInputs });
  }

  return <div className="ui-experience-section">
    <div className="wiz-subhead">
      <label className="wiz-grow">{label}<select value={click?.action ?? ""} onChange={(event) => {
        const nextAction = event.target.value;
        if (!nextAction) change(undefined);
        else autoBindFor(nextAction);
      }}>
        <option value="">No button (display card only)</option>
        {actions.map(({ id, title }) => <option key={id} value={id}>Open screen: {title || id}</option>)}
      </select></label>
      {onCreateLinkedScreen && actions.length < 6 && (
        <button type="button" className="ui-button ui-button-outline ui-compact-btn wiz-create-link-btn" onClick={onCreateLinkedScreen}>
          <Plus size={13} aria-hidden="true" /> New linked screen
        </button>
      )}
    </div>
    {click && <>
      <div className="ui-experience-grid">
        <label>Button label<input maxLength={40} value={click.label} placeholder="e.g. Track delivery" onChange={(e) => change({ ...click, label: e.target.value })} /></label>
        <label>Message shown in chat<input maxLength={160} value={click.prompt} placeholder="e.g. Show my delivery details" onChange={(e) => change({ ...click, prompt: e.target.value })} /></label>
      </div>
      {inputs.map(({ key, required, type }) => <FieldSelect key={key} label={`Bind ${key}${required ? " (required)" : ""}`}
        value={click.inputs[key] ?? ""} fields={fields.filter((field) => field.type === type || (type === "number" && field.type === "integer"))}
        onChange={(path) => {
          const bindings = { ...click.inputs };
          if (path) bindings[key] = path;
          else delete bindings[key];
          change({ ...click, inputs: bindings });
        }} />)}
      <p className="wiz-hint">When the user clicks this button, chat automatically passes the selected record&rsquo;s data to the next screen.</p>
    </>}
  </div>;
}

export function InteractiveExperienceEditor({ value, tools, domain, onApplyTemplate, change }: {
  value: InteractiveExperience;
  tools: UiExperienceTool[];
  domain: DomainPackId;
  onApplyTemplate?: (template: InteractiveExperience, meta: { name: string; description: string }) => void;
  change: (next: InteractiveExperience) => void;
}) {
  const [selected, select] = useState(value.actions[0].id);
  const startsPopulated = value.actions.some((a) => a.phrases.length > 0 || Boolean(a.onClick));
  const [step, setStep] = useState<WizardStep>(1);
  const [showAllSteps, setShowAllSteps] = useState(startsPopulated);

  const action = value.actions.find(({ id }) => id === selected) ?? value.actions[0];
  const tool = tools.find(({ ref }) => ref === action.taskRef);
  const allowed = tools.filter(({ customer }) => value.audience === "operator" || customer);
  const output = tool?.outputSchema ?? {};
  const fields = resultFields(output);
  const scalars = scalarFields(fields).filter(({ path }) => value.audience === "operator" || tool?.customerFields?.includes(path));
  const arrays = fields.filter(({ path, type }) => type === "array" && asObject(resultSchemaAt(output, path).items).type === "object");
  const table = action.table;
  const rowFields = table ? scalarFields(resultFields(asObject(resultSchemaAt(output, table.rows).items))) : [];
  const editAction = (next: InteractiveAction) => change({ ...value, actions: value.actions.map((item) => item.id === action.id ? next : item) });
  const clickProps = { actions: value.actions, tools, audience: value.audience };
  const requiredInputs = fieldsFor(tool, value.audience);
  const inputNames = requiredInputs.map(({ key, required }) => `{{${key}}}${required ? " (required)" : ""}`);
  const completionField = scalars.find(({ path }) => path === action.completion?.path);
  const suggestions = useMemo(() => suggestedPhrasesFor(tool, value.audience), [tool, value.audience]);

  const hasTriggerPhrase = value.actions.some((a) => a.phrases.length > 0);
  const step1Done = Boolean(action.taskRef && (action.phrases.length > 0 || hasTriggerPhrase));
  const step2Done = Boolean(action.title.trim() && (action.metrics.length > 0 || action.table));
  const step3Configured = Boolean(action.onClick || action.table?.onClick);
  const step4Configured = Boolean(action.completion);

  function addAction(linkFromCurrent = false) {
    const nextTool = tool ?? allowed[0];
    if (!nextTool) return;
    let number = value.actions.length + 1;
    while (value.actions.some(({ id }) => id === "screen_" + number)) number++;
    const newId = "screen_" + number;
    const newTitle = linkFromCurrent ? `${action.title || "Detail"} follow-up`.slice(0, 40) : `Screen ${number}`;
    const next = freshAction(newId, nextTool, value.audience, newTitle);
    if (linkFromCurrent) {
      next.reuseSelectedRecord = true;
      const autoInputs: Record<string, string> = {};
      for (const inp of fieldsFor(nextTool, value.audience)) {
        const match = scalars.find((f) => f.path === inp.key || f.path.endsWith("." + inp.key));
        if (match) autoInputs[inp.key] = match.path;
      }
      const updatedActions = value.actions.map((item) =>
        item.id === action.id
          ? { ...item, onClick: { action: newId, label: "View details", prompt: `Show ${newTitle.toLowerCase()}`, inputs: autoInputs } }
          : item,
      );
      change({ ...value, actions: [...updatedActions, next] });
    } else {
      change({ ...value, actions: [...value.actions, next] });
      select(newId);
    }
  }

  function removeAction() {
    const actions = value.actions.filter(({ id }) => id !== action.id).map((item) => ({
      ...item,
      ...(item.onClick?.action === action.id && { onClick: undefined }),
      ...(item.table?.onClick?.action === action.id && { table: { ...item.table, onClick: undefined } }),
    }));
    change({ ...value, actions });
    select(actions[0].id);
  }

  function appendPhrase(phrase: string) {
    if (action.phrases.includes(phrase)) return;
    editAction({ ...action, phrases: [...action.phrases, phrase] });
  }

  const stepsMeta: Array<{ id: WizardStep; shortTitle: string; title: string; subtitle: string; done: boolean; optional?: boolean }> = [
    { id: 1, shortTitle: "Trigger", title: "Trigger & Data", subtitle: "Who uses it, which tool runs, and what users say", done: step1Done },
    { id: 2, shortTitle: "Card", title: "Card Content", subtitle: "Title, intro text, and fields displayed on the card", done: step2Done },
    { id: 3, shortTitle: "Button", title: "Follow-up Button", subtitle: "Optional button to drill into a second screen", done: step3Configured, optional: true },
    { id: 4, shortTitle: "Review", title: "Completion & Check", subtitle: "Optional live status watch & readiness summary", done: step4Configured, optional: true },
  ];

  const isVisible = (s: WizardStep) => showAllSteps || step === s;

  return <div className="ui-experience-editor wiz-root">
    {/* Guided Header & Quick-Start Banner */}
    <div className="wiz-banner">
      <div className="wiz-banner-copy">
        <span className="wiz-kicker"><Wand2 size={13} aria-hidden="true" /> Guided Experience Builder</span>
        <p>Connect a live data tool to a chat card in 4 quick steps — pick what users ask, choose fields to display, then test live on the right.</p>
      </div>
      <div className="wiz-banner-actions">
        {onApplyTemplate && domain === "wealth" && tools.some(({ ref }) => ref === "int.commerce_sandbox.lookup_order@1.0.0") && (
          <button
            type="button"
            className="wiz-preset-btn"
            onClick={() => {
              onApplyTemplate(orderExperienceTemplate(), {
                name: "Order tracking",
                description: "Check shipping progress and get an update when the delivery is confirmed.",
              });
              setStep(1);
            }}
          >
            <Sparkles size={13} aria-hidden="true" /> Load Order Tracking example
          </button>
        )}
        <button
          type="button"
          className="wiz-mode-toggle"
          onClick={() => setShowAllSteps((v) => !v)}
        >
          {showAllSteps ? "Step-by-step view" : "Show all steps"}
        </button>
      </div>
    </div>

    {/* Screen Switcher (only prominent when >1 screen or clearly labeled) */}
    <div className="wiz-screens-bar">
      <div className="wiz-screens-label">
        <Layers size={14} aria-hidden="true" />
        <span>Screens in this flow ({value.actions.length}):</span>
      </div>
      <div className="ui-experience-actions" role="group" aria-label="Experience actions">
        {value.actions.map((item, idx) => (
          <button
            type="button"
            key={item.id}
            className={"wiz-screen-pill" + (item.id === action.id ? " is-active" : "")}
            aria-pressed={item.id === action.id}
            onClick={() => select(item.id)}
          >
            <span className="wiz-screen-num">{idx + 1}</span>
            {item.title || item.id}
          </button>
        ))}
        <button
          type="button"
          className="wiz-screen-add"
          disabled={value.actions.length >= 6 || !allowed.length}
          title="Add another card screen to this flow (e.g. a drill-down screen)"
          onClick={() => addAction(false)}
        >
          <Plus size={13} aria-hidden="true" /> Add screen
        </button>
      </div>
    </div>

    {/* Interactive 4-Step Progress Stepper */}
    {!showAllSteps && (
      <nav className="wiz-stepper" aria-label="Experience setup steps">
        {stepsMeta.map((s) => (
          <button
            key={s.id}
            type="button"
            className={"wiz-step-pill" + (step === s.id ? " is-current" : "") + (s.done ? " is-done" : "")}
            aria-current={step === s.id ? "step" : undefined}
            title={s.title + (s.optional ? " (Optional)" : "")}
            onClick={() => setStep(s.id)}
          >
            <span className="wiz-step-badge">
              {s.done ? <Check size={12} aria-hidden="true" /> : s.id}
            </span>
            <span className="wiz-step-text">
              <strong>{s.shortTitle}</strong>
            </span>
          </button>
        ))}
      </nav>
    )}

    {/* STEP 1: Trigger & Data Source */}
    {isVisible(1) && (
      <section className="wiz-card" aria-label="Step 1: Trigger and data source">
        <header className="wiz-card-head">
          <span className="wiz-card-num">1</span>
          <div>
            <h3>Trigger &amp; Data Source</h3>
            <p>Choose who sees this experience, which backend tool loads the data, and what phrases trigger it in chat.</p>
          </div>
        </header>

        <div className="wiz-field-stack">
          <label>
            Who can use this experience?
            <select value={value.audience} onChange={(e) => change({ ...value, audience: e.target.value as InteractiveExperience["audience"] })}>
              {domain === "wealth" && <option value="customer">Customer</option>}
              <option value="operator">Signed-in operators</option>
            </select>
          </label>

          <label>
            Read task
            <select value={action.taskRef} onChange={(event) => {
              const nextRef = event.target.value;
              const nextTool = allowed.find((t) => t.ref === nextRef);
              const nextFields = nextTool
                ? scalarFields(resultFields(nextTool.outputSchema)).filter(({ path }) => value.audience !== "customer" || nextTool.customerFields?.includes(path))
                : [];
              editAction({
                ...action,
                taskRef: nextRef,
                metrics: nextFields.length ? nextFields.slice(0, 3).map(({ path }) => ({ label: makeLabel(path), path })) : action.metrics,
              });
            }}>
              {!allowed.some(({ ref }) => ref === action.taskRef) && <option value={action.taskRef}>{action.taskRef} (unavailable)</option>}
              {allowed.map(({ ref }) => <option key={ref} value={ref}>{friendlyToolName(ref)}</option>)}
            </select>
          </label>
        </div>

        {tool && (
          <div className="wiz-tool-note">
            <span><strong>{friendlyToolName(tool.ref)}</strong> — {tool.description}</span>
            <span className="wiz-tool-inputs">
              <code>{tool.ref}</code>
              {requiredInputs.length > 0 && (
                <> · Needs {requiredInputs.map((i) => <code key={i.key}>{`{{${i.key}}}`}</code>)}</>
              )}
            </span>
          </div>
        )}

        <div className="wiz-phrases-box">
          <label>
            Chat phrases (what users type to open this card)
            <textarea
              rows={2}
              value={action.phrases.join("\n")}
              onChange={(e) => editAction({ ...action, phrases: e.target.value.split("\n").map((line) => line.trim()).filter(Boolean) })}
              placeholder={inputNames.length ? "e.g. " + suggestions[0] : "e.g. Show my records"}
            />
          </label>
          <div className="wiz-suggestions">
            <span><MessageSquare size={12} aria-hidden="true" /> Click to add phrase:</span>
            {suggestions.map((phrase) => (
              <button
                key={phrase}
                type="button"
                className={"wiz-suggestion-chip" + (action.phrases.includes(phrase) ? " is-added" : "")}
                onClick={() => appendPhrase(phrase)}
              >
                {action.phrases.includes(phrase) ? <Check size={11} aria-hidden="true" /> : <Plus size={11} aria-hidden="true" />}
                {phrase}
              </button>
            ))}
          </div>
          <p className="wiz-hint">
            {inputNames.length
              ? `Include ${inputNames.join(", ")} where the user's ID goes. Leave blank if this screen is only opened via a button click.`
              : "This tool needs no IDs from the user. Enter one phrase per line."}
          </p>
        </div>

        <label className="ui-experience-check">
          <input
            type="checkbox"
            checked={Boolean(action.reuseSelectedRecord)}
            onChange={(e) => editAction({ ...action, reuseSelectedRecord: e.target.checked })}
          />
          <span>Remember the selected record so follow-ups like &ldquo;check again&rdquo; work without re-typing the ID</span>
        </label>
      </section>
    )}

    {/* STEP 2: Card Content & Data Fields */}
    {isVisible(2) && (
      <section className="wiz-card" aria-label="Step 2: Card content and fields">
        <header className="wiz-card-head">
          <span className="wiz-card-num">2</span>
          <div>
            <h3>Card Content &amp; Live Data Fields</h3>
            <p>Set the headline and tap the data fields you want displayed on the customer card.</p>
          </div>
        </header>

        <div className="wiz-two-col">
          <label>
            Card title
            <input maxLength={90} value={action.title} placeholder="e.g. Order summary" onChange={(e) => editAction({ ...action, title: e.target.value })} />
          </label>
          <label>
            Message above the card
            <input maxLength={240} value={action.description ?? ""} placeholder="Optional friendly sentence shown above the card..."
              onChange={(e) => editAction({ ...action, description: e.target.value })} />
          </label>
        </div>

        <Bindings label="Result fields" values={action.metrics} fields={scalars} max={4} change={(metrics) => editAction({ ...action, metrics })} />

        {value.audience === "operator" && (arrays.length > 0 || table) && (
          <div className="ui-experience-section">
            <h3>Record table (optional)</h3>
            <FieldSelect label="Rows" value={table?.rows ?? ""} fields={arrays} onChange={(rows) => {
              const columns = scalarFields(resultFields(asObject(resultSchemaAt(output, rows).items))).slice(0, 2)
                .map(({ path }) => ({ label: makeLabel(path), path }));
              editAction({ ...action, table: rows ? { rows, columns } : undefined });
            }} />
            {table && <>
              <Bindings label="Columns" values={table.columns} fields={rowFields} max={5} change={(columns) => editAction({ ...action, table: { ...table, columns } })} />
              <ClickEditor {...clickProps} label="On row click" click={table.onClick} fields={rowFields} change={(onClick) => editAction({ ...action, table: { ...table, onClick } })} />
            </>}
          </div>
        )}
      </section>
    )}

    {/* STEP 3: Follow-up Button & Navigation */}
    {isVisible(3) && (
      <section className="wiz-card" aria-label="Step 3: Follow-up button">
        <header className="wiz-card-head">
          <span className="wiz-card-num">3</span>
          <div>
            <h3>Interactive Button <span className="wiz-optional-tag">Optional</span></h3>
            <p>Let the user click a button on this card to jump straight to a follow-up screen (e.g., Order Summary &rarr; Delivery Tracking).</p>
          </div>
        </header>

        <ClickEditor
          {...clickProps}
          label="On button click"
          click={action.onClick}
          fields={scalars}
          onCreateLinkedScreen={() => addAction(true)}
          change={(onClick) => editAction({ ...action, onClick })}
        />
      </section>
    )}

    {/* STEP 4: Completion Watcher & Readiness Checklist */}
    {isVisible(4) && (
      <section className="wiz-card" aria-label="Step 4: Completion and review">
        <header className="wiz-card-head">
          <span className="wiz-card-num">4</span>
          <div>
            <h3>Completion Watcher &amp; Readiness <span className="wiz-optional-tag">Optional</span></h3>
            <p>Optionally watch a field (like <code>status = delivered</code>) to show a live update pill when the record completes.</p>
          </div>
        </header>

        <div className="wiz-completion-box">
          <FieldSelect label="Field to watch" value={action.completion?.path ?? ""} fields={scalars} onChange={(path) =>
            editAction({ ...action, completion: path ? { path, equals: asValue("true", scalars.find((field) => field.path === path)?.type), label: "Result updated" } : undefined })} />
          {action.completion && <div className="ui-experience-grid">
            <label>Complete when the value is{completionField?.type === "boolean"
              ? <select value={String(action.completion.equals)} onChange={(e) =>
                editAction({ ...action, completion: { ...action.completion!, equals: e.target.value === "true" } })}>
                <option value="true">True</option><option value="false">False</option>
              </select>
              : <input maxLength={80} value={String(action.completion.equals)} placeholder="e.g. delivered" onChange={(e) =>
                editAction({ ...action, completion: { ...action.completion!, equals: e.target.value } })} />}</label>
            <label>Update label<input maxLength={40} value={action.completion.label} onChange={(e) =>
              editAction({ ...action, completion: { ...action.completion!, label: e.target.value } })} /></label>
          </div>}
        </div>

        <div className="wiz-checklist" role="region" aria-label="Experience readiness checklist">
          <h4>Readiness check</h4>
          <ul>
            <li className={step1Done ? "is-ok" : "is-missing"}>
              {step1Done ? <CheckCircle2 size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}
              <span>{step1Done ? `Trigger ready (${value.actions.reduce((n, a) => n + a.phrases.length, 0)} phrase(s) linked to ${friendlyToolName(action.taskRef)})` : "Add at least one chat phrase in Step 1 so chat knows when to open this experience"}</span>
            </li>
            <li className={step2Done ? "is-ok" : "is-missing"}>
              {step2Done ? <CheckCircle2 size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}
              <span>{step2Done ? `Card "${action.title}" displays ${action.metrics.length} live field(s)` : "Set a Card title and pick at least 1 Result field in Step 2"}</span>
            </li>
            <li className="is-ok">
              <MousePointerClick size={14} aria-hidden="true" />
              <span>{step3Configured ? `Interactive button "${action.onClick?.label || "Row click"}" wired` : "No follow-up button (single-card experience)"}</span>
            </li>
          </ul>
        </div>
      </section>
    )}

    {/* Footer Step Navigation */}
    <footer className="wiz-footer">
      <div className="wiz-footer-left">
        {!showAllSteps && step > 1 && (
          <button type="button" className="ui-button ui-button-outline ui-compact-btn" onClick={() => setStep((s) => (s - 1) as WizardStep)}>
            <ArrowLeft size={13} aria-hidden="true" /> Previous
          </button>
        )}
        {value.actions.length > 1 && (
          <button type="button" className="ui-button ui-button-plain ui-compact-btn" onClick={removeAction}>
            Remove screen
          </button>
        )}
      </div>
      {!showAllSteps && step < 4 && (
        <button type="button" className="ui-button ui-button-primary ui-compact-btn" onClick={() => setStep((s) => (s + 1) as WizardStep)}>
          Next: {stepsMeta[step].title} <ArrowRight size={13} aria-hidden="true" />
        </button>
      )}
    </footer>
  </div>;
}
