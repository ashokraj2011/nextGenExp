import { z } from "zod";

const actionId = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const fieldName = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const field = z.string().regex(fieldName);
const bindingPath = z.string().max(160).refine((path) => path.split(".").every((key) =>
  fieldName.test(key) && key !== "constructor" && key !== "prototype"), "Enter a dotted field path.");
const scalar = z.union([z.string().min(1).max(240), z.number().finite(), z.boolean()]);
const label = z.string().trim().min(1).max(40);
const binding = z.object({ label, path: bindingPath }).strict();
const clickSchema = z.object({
  action: actionId,
  label,
  prompt: z.string().trim().min(1).max(160),
  inputs: z.record(field, bindingPath).refine((inputs) => Object.keys(inputs).length <= 10),
}).strict();

export const interactiveExperienceSchema = z.object({
  audience: z.enum(["customer", "operator"]),
  actions: z.array(z.object({
    id: actionId,
    taskRef: z.string().regex(/^int\.[a-z0-9_]+\.[a-z0-9_]+@\d+\.\d+\.\d+$/).max(128),
    phrases: z.array(z.string().trim().min(2).max(120)).max(8),
    title: z.string().trim().min(1).max(90),
    description: z.string().trim().max(240).optional(),
    reuseSelectedRecord: z.boolean().optional(),
    metrics: z.array(binding).max(4),
    table: z.object({
      rows: bindingPath,
      columns: z.array(binding).min(2).max(5),
      onClick: clickSchema.optional(),
    }).strict().optional(),
    onClick: clickSchema.optional(),
    completion: z.object({ path: bindingPath, equals: scalar, label }).strict().optional(),
  }).strict()).min(1).max(6).refine((actions) => new Set(actions.map(({ id }) => id)).size === actions.length, "Give each action a different ID."),
}).strict();

export type InteractiveExperience = z.infer<typeof interactiveExperienceSchema>;
export type InteractiveAction = InteractiveExperience["actions"][number];
export type InteractiveClick = z.infer<typeof clickSchema>;
export type InteractiveScalar = z.infer<typeof scalar>;
export type InteractiveInputs = Record<string, InteractiveScalar>;
export type InteractiveClickInvocation = { actionId: string; inputs: InteractiveInputs };

export type InteractiveTurnState = {
  publication: { id: string; revision: number; name: string };
  actionId: string;
  source: "message" | "click";
  sourceTurnId?: string;
  recordId?: string;
  runId?: string;
  sfieldRunId?: string;
  state: "running" | "ready" | "watching" | "reached" | "failed";
  completion?: { label: string; value?: string };
};

export function interactiveValue(value: unknown, path: string): unknown {
  for (const key of path.split(".")) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function interactiveScalar(value: unknown) {
  const parsed = scalar.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export const interactiveTokenPattern = /\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}/g;
export const interactiveTokens = (template: string) => [...template.matchAll(interactiveTokenPattern)].map((match) => match[1]);
export const interactivePhraseKey = (phrase: string) => phrase.trim().toLowerCase().replace(interactiveTokenPattern, "{{}}")
  .replace(/\s+/g, " ").replace(/[.?!]+$/, "");
