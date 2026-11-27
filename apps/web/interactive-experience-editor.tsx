import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { InteractiveAction, InteractiveClick, InteractiveExperience, InteractiveScalar } from "../../packages/contracts/interactive-experience";
import type { UiExperienceTool } from "../../packages/contracts/ui-layout";
import type { DomainPackId } from "../../packages/contracts/domain-packs";

type OutputField = { path: string; type: string };
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
const fieldsFor = (tool: UiExperienceTool | undefined, audience: InteractiveExperience["audience"]) =>
  (audience === "customer" ? tool?.customerInputs : tool?.inputs) ?? [];
const asValue = (value: string, type?: string): InteractiveScalar => {
  if (type === "boolean") return value === "true";
  if ((type === "integer" || type === "number") && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return value;
};

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
  return { audience, actions: [freshAction("start", defaultTool, audience, "Result")] };
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
    {fields.map(({ path, type }) => <option key={path} value={path}>{path} · {type}</option>)}
  </select></label>;
}

type Binding = InteractiveAction["metrics"][number];
function Bindings({ label, values, fields, max, change }: {
  label: string; values: Binding[]; fields: OutputField[]; max: number; change: (values: Binding[]) => void;
}) {
  const first = fields.find(({ path }) => !values.some((item) => item.path === path));
  return <div className="ui-experience-section">
    <h3>{label}</h3>
    {values.map((item, index) => {
      const changeItem = (next: Binding) => change(values.map((value, i) => i === index ? next : value));
      return <div className="ui-experience-binding" key={index}>
        <label>Display label<input value={item.label} maxLength={40} onChange={(e) => changeItem({ ...item, label: e.target.value })} /></label>
        <FieldSelect label="Result field" value={item.path} fields={fields} onChange={(path) => changeItem({ label: item.label, path })} />
        <button type="button" className="ui-button ui-button-plain" aria-label={`Remove ${item.label || "field"}`}
          onClick={() => change(values.filter((_, i) => i !== index))}><X size={16} /></button>
      </div>;
    })}
    <button type="button" className="ui-button ui-button-outline ui-compact-btn" disabled={values.length >= max || !first}
      onClick={() => first && change([...values, { label: makeLabel(first.path), path: first.path }])}><Plus size={14} /> Add field</button>
  </div>;
}

function ClickEditor({ label, click, actions, fields, tools, audience, change }: {
  label: string; click?: InteractiveClick; actions: InteractiveAction[]; fields: OutputField[]; tools: UiExperienceTool[];
  audience: InteractiveExperience["audience"]; change: (next: InteractiveClick | undefined) => void;
}) {
  const target = actions.find(({ id }) => id === click?.action);
  const inputs = fieldsFor(tools.find(({ ref }) => ref === target?.taskRef), audience);
  return <div className="ui-experience-section">
    <label>{label}<select value={click?.action ?? ""} onChange={(event) => {
      const action = event.target.value;
      if (!action) change(undefined);
      else {
        const match = actions.find(({ id }) => id === action)!;
        change({ action, label: "View details", prompt: match.title, inputs: {} });
      }
    }}>
      <option value="">No action</option>
      {actions.map(({ id, title }) => <option key={id} value={id}>{title} · {id}</option>)}
    </select></label>
    {click && <>
      <div className="ui-experience-grid">
        <label>Button label<input maxLength={40} value={click.label} onChange={(e) => change({ ...click, label: e.target.value })} /></label>
        <label>Message shown in chat<input maxLength={160} value={click.prompt} onChange={(e) => change({ ...click, prompt: e.target.value })} /></label>
      </div>
      {inputs.map(({ key, required, type }) => <FieldSelect key={key} label={`Bind ${key}${required ? " (required)" : ""}`}
        value={click.inputs[key] ?? ""} fields={fields.filter((field) => field.type === type || (type === "number" && field.type === "integer"))}
        onChange={(path) => {
          const bindings = { ...click.inputs };
          if (path) bindings[key] = path;
          else delete bindings[key];
          change({ ...click, inputs: bindings });
        }} />)}
      <p>Use <code>{"{{inputName}}"}</code> to show a bound value in the chat message. The action receives the selected data directly.</p>
    </>}
  </div>;
}

export function InteractiveExperienceEditor({ value, tools, domain, change }: {
  value: InteractiveExperience; tools: UiExperienceTool[]; domain: DomainPackId; change: (next: InteractiveExperience) => void;
}) {
  const [selected, select] = useState(value.actions[0].id);
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
  const inputNames = fieldsFor(tool, value.audience).map(({ key, required }) => `{{${key}}}${required ? " (required)" : ""}`);
  const completionField = scalars.find(({ path }) => path === action.completion?.path);

  function addAction() {
    const nextTool = allowed[0];
    if (!nextTool) return;
    let number = value.actions.length + 1;
    while (value.actions.some(({ id }) => id === "action_" + number)) number++;
    const next = freshAction("action_" + number, nextTool, value.audience, "New action");
    change({ ...value, actions: [...value.actions, next] });
    select(next.id);
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

  return <div className="ui-experience-editor">
    <label>Who can use this experience?<select value={value.audience} onChange={(e) => change({ ...value, audience: e.target.value as InteractiveExperience["audience"] })}>
      {domain === "wealth" && <option value="customer">Customer</option>}
      <option value="operator">Signed-in operators</option>
    </select></label>
    <div className="ui-experience-actions" role="group" aria-label="Experience actions">
      {value.actions.map((item) => <button type="button" key={item.id} className="ui-button ui-compact-btn"
        aria-pressed={item.id === action.id} onClick={() => select(item.id)}>{item.title || item.id}</button>)}
      <button type="button" className="ui-button ui-button-outline ui-compact-btn" disabled={value.actions.length >= 6 || !allowed.length}
        onClick={addAction}><Plus size={14} /> Add action</button>
    </div>
    <label>Card title<input maxLength={90} value={action.title} onChange={(e) => editAction({ ...action, title: e.target.value })} /></label>
    <label>Read task<select value={action.taskRef} onChange={(event) => editAction({ ...action, taskRef: event.target.value })}>
      {!allowed.some(({ ref }) => ref === action.taskRef) && <option value={action.taskRef}>{action.taskRef} (unavailable)</option>}
      {allowed.map(({ ref }) => <option key={ref} value={ref}>{ref}</option>)}
    </select></label>
    {tool && <p>{tool.description}</p>}
    <label>Chat phrases<textarea rows={3} defaultValue={action.phrases.join("\n")} key={action.id}
      onChange={(e) => editAction({ ...action, phrases: e.target.value.split("\n").map((line) => line.trim()).filter(Boolean) })}
      placeholder={inputNames.length ? "Find record " + inputNames[0].split(" ")[0] : "Show my records"} /></label>
    <p>{inputNames.length ? "Task inputs " + inputNames.join(", ") : "This task has no customer-entered inputs."} Use one phrase per line. Leave this empty for click-only actions.</p>
    <label className="ui-experience-check"><input type="checkbox" checked={Boolean(action.reuseSelectedRecord)}
      onChange={(e) => editAction({ ...action, reuseSelectedRecord: e.target.checked })} /> Reuse this action’s last selected record for short follow-ups</label>
    <label>Message above the card <input maxLength={240} value={action.description ?? ""}
      onChange={(e) => editAction({ ...action, description: e.target.value })} /></label>
    <Bindings label="Result fields" values={action.metrics} fields={scalars} max={4} change={(metrics) => editAction({ ...action, metrics })} />
    {value.audience === "operator" && (arrays.length > 0 || table) && <div className="ui-experience-section">
      <h3>Record table</h3>
      <FieldSelect label="Rows" value={table?.rows ?? ""} fields={arrays} onChange={(rows) => {
        const columns = scalarFields(resultFields(asObject(resultSchemaAt(output, rows).items))).slice(0, 2)
          .map(({ path }) => ({ label: makeLabel(path), path }));
        editAction({ ...action, table: rows ? { rows, columns } : undefined });
      }} />
      {table && <>
        <Bindings label="Columns" values={table.columns} fields={rowFields} max={5} change={(columns) => editAction({ ...action, table: { ...table, columns } })} />
        <ClickEditor {...clickProps} label="On row click" click={table.onClick} fields={rowFields} change={(onClick) => editAction({ ...action, table: { ...table, onClick } })} />
      </>}
    </div>}
    <ClickEditor {...clickProps} label="On button click" click={action.onClick} fields={scalars} change={(onClick) => editAction({ ...action, onClick })} />
    <div className="ui-experience-section">
      <h3>Completion</h3>
      <FieldSelect label="Field to watch" value={action.completion?.path ?? ""} fields={scalars} onChange={(path) =>
        editAction({ ...action, completion: path ? { path, equals: asValue("true", scalars.find((field) => field.path === path)?.type), label: "Result updated" } : undefined })} />
      {action.completion && <div className="ui-experience-grid">
        <label>Complete when the value is{completionField?.type === "boolean"
          ? <select value={String(action.completion.equals)} onChange={(e) =>
            editAction({ ...action, completion: { ...action.completion!, equals: e.target.value === "true" } })}>
            <option value="true">True</option><option value="false">False</option>
          </select>
          : <input maxLength={80} value={String(action.completion.equals)} onChange={(e) =>
            editAction({ ...action, completion: { ...action.completion!, equals: asValue(e.target.value, completionField?.type) } })} />}</label>
        <label>Update label<input maxLength={40} value={action.completion.label} onChange={(e) =>
          editAction({ ...action, completion: { ...action.completion!, label: e.target.value } })} /></label>
      </div>}
    </div>
    {value.actions.length > 1 && <button type="button" className="ui-button ui-button-plain" onClick={removeAction}>Remove this action</button>}
  </div>;
}
