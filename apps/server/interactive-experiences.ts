import { digestJson } from "@sfield/core";
import {
  interactiveScalar, interactiveTokenPattern, interactiveTokens, interactiveValue,
  type InteractiveAction, type InteractiveClick, type InteractiveClickInvocation, type InteractiveExperience, type InteractiveInputs,
} from "../../packages/contracts/interactive-experience";
import type { UiPublication } from "../../packages/contracts/ui-layout";
import type { TaskContract } from "../../packages/contracts/integration-task";
import type { DomainPackId } from "../../packages/contracts/domain-packs";
import type { DynamicCanvasProps } from "../../packages/contracts/dynamic-canvas";
import { buildSurface, makeId, type IssuedAction } from "../../packages/experience/compile";
import { ApiError } from "./store";

export type InteractiveInvocation = InteractiveClickInvocation & {
  publication: UiPublication;
  source: "message" | "click";
  sourceTurnId?: string;
};

type Schema = Record<string, unknown>;
const record = (value: unknown): Schema => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Schema : {};
const properties = (schema: Schema) => record(schema.properties);
const fieldType = (schema: Schema) => record(schema).type;
const isScalarField = (schema: Schema) => ["string", "integer", "number", "boolean"].includes(String(fieldType(schema)));
const requiredFields = (schema: Schema) => Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
const inputFields = (task: TaskContract, audience: InteractiveExperience["audience"]) => {
  const member = audience === "customer" ? task.customerExperience?.memberField : undefined;
  const generated = task.idempotency.supported ? task.idempotency.keyField : undefined;
  return Object.entries(properties(task.inputSchema)).filter(([key]) => key !== member && key !== generated);
};
export function interactiveToolInputs(task: TaskContract, audience: InteractiveExperience["audience"]) {
  const required = requiredFields(task.inputSchema);
  return inputFields(task, audience).map(([key, field]) => ({
    key, required: required.includes(key) || (audience === "customer" && key === task.resourceIdField),
    type: String(fieldType(record(field)) ?? "unknown"),
  }));
}

function schemaAt(root: Schema, path: string) {
  for (const key of path.split(".")) root = record(interactiveValue(properties(root), key));
  return root;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function phrasePattern(phrase: string) {
  const keys = interactiveTokens(phrase);
  const template = phrase.replace(/[.?!]+$/, "");
  const parts = template.split(interactiveTokenPattern).filter((_, index) => index % 2 === 0);
  const literals = parts.map((part) => escapeRegex(part).replace(/\s+/g, "\\s+"));
  return { keys, pattern: new RegExp("^" + literals.join("(.+?)") + "[.?!]*$", "iu") };
}

const protectedField = (task: TaskContract) => task.customerExperience?.memberField;
function ensure(test: unknown, error: string): asserts test {
  if (!test) throw new ApiError(400, "interactive_experience_invalid", error);
}
export function validateInteractiveExperience(def: InteractiveExperience, domain: DomainPackId, tool: (ref: string) => TaskContract | undefined) {
  ensure(def.audience !== "customer" || domain === "wealth", "Customer experiences must use the Wealth workspace.");
  const tasks = new Map<string, TaskContract>();
  for (const action of def.actions) {
    const task = tool(action.taskRef);
    ensure(task, `Choose a published read task for “${action.title}”.`);
    ensure(def.audience === "operator" || task.customerExperience, `“${action.title}” needs a task with a verified customer binding.`);
    tasks.set(action.id, task);
    const inputs = interactiveToolInputs(task, def.audience);
    ensure(inputs.every(({ type }) => ["string", "integer", "number", "boolean"].includes(type)), `“${action.title}” requires scalar task inputs.`);
    ensure(requiredFields(task.inputSchema).every((key) => inputs.some((input) => input.key === key)
      || (def.audience === "customer" && key === protectedField(task)) || (task.idempotency.supported && key === task.idempotency.keyField)),
    `“${action.title}” has an unsupported required field.`);
    ensure(action.metrics.length || action.table, `Add a result field or table for “${action.title}”.`);
    for (const phrase of action.phrases) {
      const keys = interactiveTokens(phrase);
      const literal = phrase.replace(interactiveTokenPattern, "");
      ensure(!/[{}]/.test(literal) && /[\p{L}\p{N}]/u.test(literal)
        && !/\}\}\s*\{\{/.test(phrase)
        && keys.length === new Set(keys).size
        && keys.every((key) => inputs.some((input) => input.key === key)), `Review the field names and words in “${phrase}”.`);
      ensure(action.reuseSelectedRecord || inputs.every(({ key, required }) => !required || keys.includes(key)),
        `Include each required input in “${phrase}” or enable the selected record.`);
    }
  }
  ensure(def.actions.some(({ phrases }) => phrases.length), "Add a chat phrase that starts this experience.");
  for (const action of def.actions) {
    const task = tasks.get(action.id)!;
    const output = task.outputSchema;
    const member = def.audience === "customer" ? protectedField(task) : undefined;
    const publicFields = task.customerExperience?.fields.map(({ key }) => key) ?? [];
    const exposedField = (source: Schema, path: string) =>
      isScalarField(schemaAt(source, path)) && (!member || (path !== member && (path === task.resourceIdField || publicFields.includes(path))));
    const validateClick = (click: InteractiveClick, source: Schema) => {
      const target = tasks.get(click.action);
      ensure(target, `Choose an action in this experience for “${click.label}”.`);
      const fields = interactiveToolInputs(target, def.audience);
      ensure(fields.every(({ required, key }) => !required || Object.hasOwn(click.inputs, key)),
        `Bind the required inputs for “${click.label}”.`);
      const keys = interactiveTokens(click.prompt);
      ensure(!/[{}]/.test(click.prompt.replace(interactiveTokenPattern, ""))
        && keys.every((key) => Object.hasOwn(click.inputs, key)), `“${click.label}” can only display values from its input bindings.`);
      for (const [key, path] of Object.entries(click.inputs)) {
        const type = fields.find((field) => field.key === key)?.type;
        const boundType = fieldType(schemaAt(source, path));
        ensure(type && (type === boundType || (type === "number" && boundType === "integer")) && exposedField(source, path),
          `“${click.label}” needs a matching result field for ${key}.`);
      }
    };
    for (const { path } of action.metrics) ensure(exposedField(output, path), `“${path}” is unavailable in the result for “${action.title}”.`);
    if (action.table) {
      ensure(!member, "Customer tasks can display the public fields declared by their task contract.");
      const array = schemaAt(output, action.table.rows);
      ensure(array.type === "array" && record(array.items).type === "object", `Bind the table for “${action.title}” to a list of objects.`);
      const row = record(array.items);
      for (const { path } of action.table.columns) ensure(exposedField(row, path), `“${path}” is unavailable in the table for “${action.title}”.`);
      if (action.table.onClick) validateClick(action.table.onClick, row);
    }
    if (action.onClick) validateClick(action.onClick, output);
    if (action.completion) {
      const { path, equals } = action.completion;
      const type = fieldType(schemaAt(output, path));
      ensure(exposedField(output, path) && (type === typeof equals || (type === "integer" && Number.isInteger(equals))),
        `Choose a result field and matching value for completion of “${action.title}”.`);
    }
  }
}

function coerce(value: string, type: string) {
  if (type === "string") return interactiveScalar(value);
  if (type === "boolean") return /^true$/i.test(value) ? true : /^false$/i.test(value) ? false : undefined;
  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) {
    const number = Number(value);
    if (type === "number" || (type === "integer" && Number.isSafeInteger(number))) return interactiveScalar(number);
  }
}

export function matchInteractiveExperience(
  message: string, publications: UiPublication[], audience: InteractiveExperience["audience"],
  tool: (ref: string) => TaskContract | undefined, previous?: InteractiveInvocation,
): InteractiveInvocation | { question: string } | undefined {
  if (message.length > 480) return;
  const matches: (InteractiveInvocation | { question: string })[] = [];
  for (const publication of publications) {
    const experience = publication.design.experience;
    if (experience?.audience !== audience) continue;
    for (const action of experience.actions) {
      for (const phrase of action.phrases) {
        const { keys, pattern } = phrasePattern(phrase);
        const match = message.trim().match(pattern);
        if (!match) continue;
        const task = tool(action.taskRef);
        if (!task) {
          matches.push({ question: `“${action.title}” is temporarily unavailable.` });
          break;
        }
        const fields = interactiveToolInputs(task, audience);
        const reusable = action.reuseSelectedRecord && previous?.publication.id === publication.id
          && previous.publication.revision === publication.revision && previous.actionId === action.id;
        const inputs: InteractiveInputs = reusable ? { ...previous.inputs } : {};
        for (const [i, key] of keys.entries()) {
          const value = coerce(match[i + 1].trim(), fields.find((field) => field.key === key)?.type ?? "");
          if (value === undefined) delete inputs[key];
          else inputs[key] = value;
        }
        const missing = fields.filter(({ key, required }) => required && !Object.hasOwn(inputs, key));
        matches.push(missing.length
          ? { question: `Include ${missing.map(({ key }) => key).join(", ")} for “${action.title}”. Try “${action.phrases.find((example) => interactiveTokens(example).length) ?? phrase}”.` }
          : { publication, actionId: action.id, inputs, source: "message" });
        break;
      }
    }
  }
  const usable = matches.filter((match): match is InteractiveInvocation => "actionId" in match);
  if (usable.length === 1) return usable[0];
  if (matches.length > 1) return { question: "That matches more than one request. Include the name of the record or try a more specific request." };
  return matches[0];
}

export function interactiveAction(invocation: InteractiveInvocation) {
  return invocation.publication.design.experience!.actions.find(({ id }) => id === invocation.actionId)!;
}
export function interactiveWatchId(invocation: InteractiveInvocation) {
  const { taskRef, completion } = interactiveAction(invocation);
  return digestJson([invocation.publication.id, invocation.actionId, taskRef, completion!, invocation.inputs]);
}
const display = (value: unknown, length: number) => {
  const primitive = interactiveScalar(value);
  return primitive === undefined ? "Unavailable" : String(primitive).slice(0, length);
};

export function compileInteractiveView(action: InteractiveAction, output: unknown, recordId: string | undefined, expiresAt: number) {
  const issued: IssuedAction[] = [];
  const bindClick = (click: InteractiveClick, source: unknown, inline: boolean) => {
    const inputs: InteractiveInputs = {};
    for (const [key, path] of Object.entries(click.inputs)) {
      const value = interactiveScalar(interactiveValue(source, path));
      if (value === undefined) return;
      inputs[key] = value;
    }
    const actionId = makeId("click");
    const userMessage = click.prompt.replace(interactiveTokenPattern, (_, key: string) => String(inputs[key])).slice(0, 480);
    issued.push({
      actionId, label: click.label, componentId: inline ? "block_1" : "action_1", followUpId: click.action,
      userMessage, interactive: { actionId: click.action, inputs }, inline,
    });
    return actionId;
  };
  const nodes: DynamicCanvasProps["nodes"] = [];
  if (action.metrics.length) nodes.push({
    type: "metrics", items: action.metrics.map(({ label, path }) => ({ label, value: display(interactiveValue(output, path), 36) })),
  });
  if (action.table) {
    const table = action.table;
    const value = interactiveValue(output, table.rows);
    const rows: unknown[] = Array.isArray(value) ? value.slice(0, 10) : [];
    if (rows.length) nodes.push({
      type: "table", columns: table.columns.map(({ label }) => label),
      rows: rows.map((row) => table.columns.map(({ path }) => display(interactiveValue(row, path), 80))),
      ...(table.onClick && {
        rowActionLabel: table.onClick.label,
        rowActionIds: rows.map((row) => bindClick(table.onClick!, row, true) ?? null),
      }),
    });
    else nodes.push({ type: "callout", title: "No records to show", body: "There are no records in this result.", tone: "info" });
  }
  if (action.onClick) bindClick(action.onClick, output, false);
  const canvas: DynamicCanvasProps = {
    title: action.title, badge: "Record", generatedBy: "authored", disclaimer: "Value supplied by the connected service.",
    ...(recordId && { recordId }), nodes,
  };
  return buildSurface({
    status: "ready", outcome: "ready", intro: action.description ?? "", question: null, partial: false, expiresAt,
  }, [{ component: "PznDynamicCanvas", props: canvas }], issued);
}
