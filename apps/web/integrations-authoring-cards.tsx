import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FilePlus2, Pencil, Plug, Plus, Rocket, Save, Trash2, Wand2 } from "lucide-react";
import type {
  DraftCheck,
  DraftOrigin,
  Integration,
  McpImportCandidate,
  TaskContractInput,
  ViewContract,
} from "../../packages/contracts/integration-task";
import { api, isPublicationReview, toolSetupErrorMessage } from "./api";
import { approvalLabel, RouteBadge } from "./integrations-cards";
import "./integrations-authoring.css";

type Post = (text: string, opts?: { suggestions?: string[] }) => void;
type Json = Record<string, unknown>;

/* ============================================================================ schema ⇄ rows */

type FieldType = "string" | "integer" | "number" | "boolean";
type FieldRow = { name: string; type: FieldType; required: boolean; enumText: string; description: string; extra: Json };
const SIMPLE_TYPES: FieldType[] = ["string", "integer", "number", "boolean"];

/** Rows for a flat object schema; null when the schema needs the JSON editor (nested objects, arrays, combinators). */
function rowsFromSchema(schema: unknown): FieldRow[] | null {
  const s = (schema ?? {}) as { type?: unknown; properties?: Record<string, Json>; required?: string[] };
  if (s.type !== "object") return null;
  const required = new Set(s.required ?? []);
  const rows: FieldRow[] = [];
  for (const [name, def] of Object.entries(s.properties ?? {})) {
    const { type, enum: en, description, ...extra } = def as { type?: unknown; enum?: unknown[]; description?: string };
    if (typeof type !== "string" || !SIMPLE_TYPES.includes(type as FieldType)) return null;
    if (Object.keys(extra).some((k) => !["minLength", "maxLength", "minimum", "maximum", "pattern", "format"].includes(k))) return null;
    rows.push({ name, type: type as FieldType, required: required.has(name), enumText: Array.isArray(en) ? en.join(", ") : "", description: description ?? "", extra: extra as Json });
  }
  return rows;
}

function schemaFromRows(rows: FieldRow[]): Json {
  const properties: Json = {};
  for (const r of rows) {
    if (!r.name.trim()) continue;
    const def: Json = { type: r.type, ...r.extra };
    if (r.type !== "string") { delete def.minLength; delete def.maxLength; delete def.pattern; delete def.format; }
    if (r.type === "string" || r.type === "boolean") { delete def.minimum; delete def.maximum; }
    const values = r.enumText.split(",").map((v) => v.trim()).filter(Boolean);
    if (values.length && r.type !== "boolean") def.enum = r.type === "string" ? values : values.map(Number).filter((n) => !Number.isNaN(n));
    if (r.description.trim()) def.description = r.description.trim();
    properties[r.name.trim()] = def;
  }
  return { type: "object", additionalProperties: false, required: rows.filter((r) => r.required && r.name.trim()).map((r) => r.name.trim()), properties };
}

function FieldsEditor({ label, schema, onChange, disabled }: { label: string; schema: unknown; onChange: (s: Json) => void; disabled?: boolean }) {
  const rows = useMemo(() => rowsFromSchema(schema), [schema]);
  const [raw, setRaw] = useState(rows === null);
  const [text, setText] = useState(() => JSON.stringify(schema, null, 2));
  const [error, setError] = useState("");
  useEffect(() => { if (!raw) setText(JSON.stringify(schema, null, 2)); }, [schema, raw]);
  const update = (next: FieldRow[]) => onChange(schemaFromRows(next));
  const set = (i: number, patch: Partial<FieldRow>) => rows && update(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="int-auth-section">
      <div className="int-auth-section-head">
        <span className="pzn-stage-kicker">{label}</span>
        <button type="button" className="pzn-btn pzn-btn-sm" disabled={disabled || (raw && rowsFromSchema(safeParse(text)) === null)} onClick={() => setRaw((r) => !r)}>
          {raw ? "Field table" : "JSON"}
        </button>
      </div>
      {raw || rows === null ? (
        <>
          <textarea
            className="int-auth-json" rows={8} value={text} disabled={disabled} aria-label={`${label} JSON schema`}
            onChange={(e) => {
              setText(e.target.value);
              const parsed = safeParse(e.target.value);
              if (parsed && typeof parsed === "object") { setError(""); onChange(parsed as Json); } else setError("Not valid JSON yet");
            }}
          />
          {error && <span className="pzn-subtitle" style={{ fontSize: "0.74rem" }}>{error}</span>}
        </>
      ) : (
        <div className="int-auth-table" role="table" aria-label={`${label} fields`}>
          <div className="int-auth-row int-auth-row-head" role="row"><span>Name</span><span>Type</span><span>Req.</span><span>Allowed values</span><span>Max len</span><span /></div>
          {rows.map((r, i) => (
            <div key={i} className="int-auth-row" role="row">
              <input aria-label={`${label} field ${i + 1} name`} value={r.name} disabled={disabled} onChange={(e) => set(i, { name: e.target.value.replace(/[^A-Za-z0-9_]/g, "") })} />
              <select aria-label={`${label} field ${i + 1} type`} value={r.type} disabled={disabled} onChange={(e) => set(i, { type: e.target.value as FieldType })}>
                {SIMPLE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <input type="checkbox" aria-label={`${label} field ${i + 1} required`} checked={r.required} disabled={disabled} onChange={(e) => set(i, { required: e.target.checked })} />
              <input aria-label={`${label} field ${i + 1} allowed values`} placeholder="any" value={r.enumText} disabled={disabled || r.type === "boolean"} onChange={(e) => set(i, { enumText: e.target.value })} />
              <input aria-label={`${label} field ${i + 1} max length`} type="number" min={1} placeholder="—" value={r.type === "string" ? String(r.extra.maxLength ?? "") : ""} disabled={disabled || r.type !== "string"}
                onChange={(e) => set(i, { extra: { ...r.extra, ...(e.target.value ? { maxLength: Number(e.target.value) } : { maxLength: undefined }) } })} />
              <button type="button" className="icon-button" aria-label={`Remove ${label} field ${r.name || i + 1}`} disabled={disabled} onClick={() => update(rows.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
            </div>
          ))}
          <button type="button" className="pzn-btn pzn-btn-sm" disabled={disabled} onClick={() => update([...rows, { name: "", type: "string", required: false, enumText: "", description: "", extra: { maxLength: 200 } }])}>
            <Plus size={12} /> Add field
          </button>
        </div>
      )}
    </div>
  );
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/* ============================================================================ validation panel */

function CheckPanel({ check, checking }: { check: DraftCheck | null; checking: boolean }) {
  if (!check) return null;
  return (
    <div className="int-auth-check" aria-live="polite">
      <div className="pzn-btn-row">
        {check.ok ? <span className="pzn-badge is-pass"><CheckCircle2 size={11} /> Valid draft</span> : <span className="pzn-badge is-fail"><AlertTriangle size={11} /> {check.issues.length} issue(s)</span>}
        {check.ref && <code className="pzn-code">{check.ref}</code>}
        {check.previousVersion && <span className="pzn-badge">replaces v{check.previousVersion} when published</span>}
        {checking && <span className="pzn-subtitle" style={{ fontSize: "0.74rem" }}>checking…</span>}
      </div>
      {check.issues.length > 0 && <ul className="int-auth-issues is-fail">{check.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
      {check.breaking.length > 0 && <ul className="int-auth-issues is-warn">{check.breaking.map((i) => <li key={i}>Breaking: {i}</li>)}</ul>}
      {check.publishBlockers.length > 0 && <ul className="int-auth-issues is-warn">{check.publishBlockers.map((i) => <li key={i}>Before publishing: {i}</li>)}</ul>}
    </div>
  );
}

function useLiveCheck(draft: TaskContractInput, initial: DraftCheck | null) {
  const [check, setCheck] = useState<DraftCheck | null>(initial);
  const [checking, setChecking] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; if (initial) return; }
    setChecking(true);
    const t = setTimeout(() => {
      void api.validateIntegrationDraft(draft).then(setCheck).catch(() => undefined).finally(() => setChecking(false));
    }, 350);
    return () => clearTimeout(t);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps
  return { check, checking };
}

/* ============================================================================ TASK DRAFT EDITOR */

const ORIGIN_LABEL: Record<DraftOrigin, string> = {
  assistant: "Drafted by the assistant — review every field",
  template: "Starting point from your message — review every field",
  new_version: "New version",
  existing_draft: "Draft",
  mcp_import: "Imported from MCP",
};

export function TaskDraftCard({
  draft: initialDraft, check: initialCheck, origin, note, onPrompt, post, compact, onSaved,
}: {
  draft: TaskContractInput; check: DraftCheck | null; origin: DraftOrigin; note?: string;
  onPrompt: (p: string) => void; post?: Post; compact?: boolean; onSaved?: (ref: string) => void;
}) {
  const [draft, setDraft] = useState<TaskContractInput>(initialDraft);
  const [view, setView] = useState<{ integrations: Integration[]; contracts: ViewContract[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedRef, setSavedRef] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const { check, checking } = useLiveCheck(draft, initialCheck);
  useEffect(() => { void api.integrations().then(setView).catch(() => undefined); }, []);
  const set = (patch: Partial<TaskContractInput>) => { setSavedRef(""); setDraft((d) => ({ ...d, ...patch })); };
  const inputProps = Object.entries(((draft.inputSchema as { properties?: Record<string, { type?: string }> }).properties) ?? {});
  const stringInputs = inputProps.filter(([, p]) => p.type === "string").map(([n]) => n);
  const readTasks = (view?.contracts ?? []).filter((c) => c.integrationId === draft.integrationId && c.effect === "read" && c.status === "published");
  const writes = draft.effect !== "read";
  const policy = draft.approvalPolicy;

  async function save() {
    setBusy(true);
    setError("");
    try {
      const out = await api.saveIntegrationDraft(draft);
      setSavedRef(out.contract.ref);
      onSaved?.(out.contract.ref);
      post?.(`Saved draft **${out.contract.ref}**. It can't run until it's published.`, { suggestions: [`Publish ${out.contract.ref}`, "Show drafts"] });
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={"content-card pzn-widget-card int-auth-card" + (compact ? " is-compact" : "")} aria-label="Task draft editor">
      <div className="pzn-widget-head">
        <div>
          <span className="pzn-stage-kicker"><FilePlus2 size={13} /> {ORIGIN_LABEL[origin].toUpperCase()}</span>
          <h3>{draft.integrationId}.{draft.taskId || "…"} <span className="pzn-badge">v{draft.version}</span></h3>
        </div>
        <span className={"pzn-badge " + (draft.effect === "read" ? "" : draft.effect === "write" ? "is-warn" : "is-fail")}>{draft.effect}</span>
      </div>
      {note && <p className="pzn-subtitle int-auth-note"><Wand2 size={12} /> {note}</p>}

      <div className="pzn-form-grid">
        <div className="pzn-field">
          <label>Integration</label>
          <select aria-label="Integration" value={draft.integrationId} onChange={(e) => set({ integrationId: e.target.value })}>
            {(view?.integrations ?? [{ id: draft.integrationId, name: draft.integrationId } as Integration]).map((i) => <option key={i.id} value={i.id}>{i.name} ({i.id})</option>)}
          </select>
        </div>
        <div className="pzn-field">
          <label>Task id</label>
          <input aria-label="Task id" value={draft.taskId} onChange={(e) => set({ taskId: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} />
        </div>
        <div className="pzn-field">
          <label>Version</label>
          <input aria-label="Version" value={draft.version} onChange={(e) => set({ version: e.target.value })} />
        </div>
        <div className="pzn-field">
          <label>Effect</label>
          <select aria-label="Effect" value={draft.effect} onChange={(e) => {
            const effect = e.target.value as TaskContractInput["effect"];
            set({ effect, ...(effect === "read" ? { approvalPolicy: { ...policy, mode: "none" } } : {}) });
          }}>
            <option value="read">read — no side effects</option>
            <option value="write">write — changes data</option>
            <option value="destructive">destructive — always needs approval</option>
          </select>
        </div>
        <div className="pzn-field is-full">
          <label>Description</label>
          <textarea aria-label="Description" rows={2} value={draft.description} onChange={(e) => set({ description: e.target.value })} />
        </div>
      </div>

      <FieldsEditor label="Input" schema={draft.inputSchema} onChange={(inputSchema) => set({ inputSchema })} />
      <FieldsEditor label="Output" schema={draft.outputSchema} onChange={(outputSchema) => set({ outputSchema })} />
      {draft.effect === "read" && <fieldset className="int-auth-section"><legend>Customer chat</legend>
        <label><input type="checkbox" checked={Boolean(draft.customerExperience)} onChange={(e) => set({ customerExperience: e.target.checked ? { topic: "order", idPrefix: "ORD", memberField: "memberId", fields: [{ key: "status", label: "Status" }] } : undefined })} /> Make this lookup available in chat</label>
        {draft.customerExperience && <div className="pzn-form-grid">
          <label>Topic<input value={draft.customerExperience.topic} onChange={(e) => set({ customerExperience: { ...draft.customerExperience!, topic: e.target.value } })} /></label>
          <label>Record prefix<input value={draft.customerExperience.idPrefix} onChange={(e) => set({ customerExperience: { ...draft.customerExperience!, idPrefix: e.target.value.toUpperCase() } })} /></label>
          <label>Record ID field<input value={draft.resourceIdField ?? ""} onChange={(e) => set({ resourceIdField: e.target.value })} /></label>
          <label>Member ID field<input value={draft.customerExperience.memberField} onChange={(e) => set({ customerExperience: { ...draft.customerExperience!, memberField: e.target.value } })} /></label>
          {draft.customerExperience.fields.map((field, index) => <div key={index}>
            <label>Output key<input value={field.key} onChange={(e) => set({ customerExperience: { ...draft.customerExperience!, fields: draft.customerExperience!.fields.map((f, i) => i === index ? { ...f, key: e.target.value } : f) } })} /></label>
            <label>Card label<input value={field.label} onChange={(e) => set({ customerExperience: { ...draft.customerExperience!, fields: draft.customerExperience!.fields.map((f, i) => i === index ? { ...f, label: e.target.value } : f) } })} /></label>
            <button type="button" onClick={() => set({ customerExperience: { ...draft.customerExperience!, fields: draft.customerExperience!.fields.filter((_, i) => i !== index) } })}>Remove field</button>
          </div>)}
          {draft.customerExperience.fields.length < 4 && <button type="button" onClick={() => set({ customerExperience: { ...draft.customerExperience!, fields: [...draft.customerExperience!.fields, { key: "", label: "" }] } })}>Add card field</button>}
          <label>Watch field<input value={draft.customerExperience.watch?.field ?? ""} onChange={(e) => set({ customerExperience: { ...draft.customerExperience!, watch: e.target.value ? { field: e.target.value, value: draft.customerExperience!.watch?.value ?? "" } : undefined } })} /></label>
          {draft.customerExperience.watch && <label>Notify on value<input value={draft.customerExperience.watch.value} onChange={(e) => set({ customerExperience: { ...draft.customerExperience!, watch: { ...draft.customerExperience!.watch!, value: e.target.value } } })} /></label>}
        </div>}
      </fieldset>}

      <div className="int-auth-section">
        <span className="pzn-stage-kicker">Approval</span>
        <div className="pzn-form-grid">
          <div className="pzn-field">
            <label>When</label>
            <select aria-label="Approval mode" value={draft.effect === "destructive" ? "always" : policy.mode} disabled={draft.effect !== "write"}
              onChange={(e) => set({ approvalPolicy: { ...policy, mode: e.target.value as typeof policy.mode, when: e.target.value === "conditional" && !(policy.when ?? []).length ? [{ field: inputProps[0]?.[0] ?? "", op: "eq", value: "" }] : policy.when } })}>
              <option value="none">never</option>
              <option value="always">every call</option>
              <option value="conditional">only when…</option>
            </select>
          </div>
          <div className="pzn-field">
            <label>Expires after (min)</label>
            <input aria-label="Approval expiry minutes" type="number" min={5} max={1440} value={policy.expiresInMinutes ?? 30} disabled={!writes} onChange={(e) => set({ approvalPolicy: { ...policy, expiresInMinutes: Number(e.target.value) } })} />
          </div>
          <label className="int-auth-check-label">
            <input type="checkbox" checked={Boolean(policy.dualControl)} disabled={!writes} onChange={(e) => set({ approvalPolicy: { ...policy, dualControl: e.target.checked } })} /> Second approver
          </label>
        </div>
        {policy.mode === "conditional" && draft.effect === "write" && (
          <div className="int-auth-table">
            {(policy.when ?? []).map((c, i) => (
              <div key={i} className="int-auth-row int-auth-row-cond">
                <select aria-label={`Condition ${i + 1} field`} value={c.field} onChange={(e) => set({ approvalPolicy: { ...policy, when: (policy.when ?? []).map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) } })}>
                  <option value="">field…</option>
                  {inputProps.map(([n]) => <option key={n} value={n}>{n}</option>)}
                </select>
                <select aria-label={`Condition ${i + 1} operator`} value={c.op} onChange={(e) => set({ approvalPolicy: { ...policy, when: (policy.when ?? []).map((x, j) => (j === i ? { ...x, op: e.target.value as typeof c.op } : x)) } })}>
                  {["eq", "ne", "gt", "gte", "lt", "lte", "in"].map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                <input aria-label={`Condition ${i + 1} value`} value={Array.isArray(c.value) ? c.value.join(", ") : String(c.value ?? "")}
                  onChange={(e) => {
                    const v = e.target.value;
                    const value = c.op === "in" ? v.split(",").map((s) => s.trim()).filter(Boolean) : /^-?\d+(\.\d+)?$/.test(v) && ["gt", "gte", "lt", "lte"].includes(c.op) ? Number(v) : v;
                    set({ approvalPolicy: { ...policy, when: (policy.when ?? []).map((x, j) => (j === i ? { ...x, value } : x)) } });
                  }} />
                <button type="button" className="icon-button" aria-label={`Remove condition ${i + 1}`} onClick={() => set({ approvalPolicy: { ...policy, when: (policy.when ?? []).filter((_, j) => j !== i) } })}><Trash2 size={13} /></button>
              </div>
            ))}
            <button type="button" className="pzn-btn pzn-btn-sm" onClick={() => set({ approvalPolicy: { ...policy, when: [...(policy.when ?? []), { field: inputProps[0]?.[0] ?? "", op: "eq", value: "" }] } })}><Plus size={12} /> Add condition</button>
          </div>
        )}
      </div>

      {writes && (
        <div className="int-auth-section">
          <span className="pzn-stage-kicker">If the outcome is uncertain</span>
          <div className="pzn-form-grid">
            <div className="pzn-field">
              <label>Idempotency key field</label>
              <select aria-label="Idempotency key field" value={draft.idempotency.supported ? draft.idempotency.keyField ?? "" : ""}
                onChange={(e) => set({ idempotency: e.target.value ? { supported: true, keyField: e.target.value } : { supported: false } })}>
                <option value="">none</option>
                {stringInputs.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div className="pzn-field">
              <label>Reconcile with (read task)</label>
              <select aria-label="Reconcile task" value={draft.reconcileTaskId ?? ""} onChange={(e) => set({ reconcileTaskId: e.target.value || undefined })}>
                <option value="">none</option>
                {[...new Set(readTasks.map((t) => t.taskId))].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <label className="int-auth-check-label">
              <input type="checkbox" checked={Boolean(draft.manualReconcile)} onChange={(e) => set({ manualReconcile: e.target.checked || undefined })} /> Someone checks uncertain outcomes by hand
            </label>
          </div>
        </div>
      )}

      <div className="int-auth-section">
        <span className="pzn-stage-kicker">Call &amp; responses</span>
        <div className="pzn-form-grid">
          <div className="pzn-field">
            <label>Target (path, MCP tool, or handler)</label>
            <input aria-label="Binding target" value={draft.binding.target} onChange={(e) => set({ binding: { ...draft.binding, target: e.target.value } })} />
          </div>
          <div className="pzn-field">
            <label>Method</label>
            <select aria-label="Binding method" value={draft.binding.method ?? "POST"} onChange={(e) => set({ binding: { ...draft.binding, method: e.target.value as "POST" } })}>
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div className="pzn-field">
            <label>Execution mode</label>
            <select aria-label="Execution mode" value={draft.executionMode ?? "sync"} onChange={(e) => {
              const mode = e.target.value as "sync" | "async";
              set({ executionMode: mode, ...(mode === "async" && !draft.asyncConfig ? { asyncConfig: { jobIdPath: "jobId", pollIntervalMs: 5000 } } : {}) });
            }}>
              <option value="sync">sync — single round-trip</option>
              <option value="async">async — 202 Accepted + poll/callback</option>
            </select>
          </div>
          {draft.executionMode === "async" && (
            <div className="pzn-field">
              <label>Async status poll task</label>
              <select aria-label="Async status poll task" value={draft.asyncConfig?.statusTaskId ?? ""} onChange={(e) => set({
                asyncConfig: { ...(draft.asyncConfig ?? { jobIdPath: "jobId", pollIntervalMs: 5000 }), statusTaskId: e.target.value || undefined },
              })}>
                <option value="">callback only (no poll task)</option>
                {[...new Set(readTasks.map((t) => t.taskId))].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          )}
        </div>
        <div className="int-auth-table">
          <div className="int-auth-row int-auth-row-outcome int-auth-row-head"><span>Outcome code</span><span>Meaning</span><span>Success</span><span>HTTP status</span><span /></div>
          {draft.outcomeCodes.map((o, i) => {
            const rule = draft.outcomeMapping.find((m) => m.code === o.code);
            const setCode = (patch: Partial<typeof o>, statusText?: string) => {
              const codes = draft.outcomeCodes.map((x, j) => (j === i ? { ...x, ...patch } : x));
              const code = codes[i]!.code;
              const statuses = (statusText ?? (rule?.statusIn ?? []).join(", ")).split(",").map((s) => Number(s.trim())).filter((n) => n >= 100 && n <= 599);
              const others = draft.outcomeMapping.filter((m) => m.code !== o.code);
              set({ outcomeCodes: codes, outcomeMapping: statuses.length ? [...others, { ...(rule ?? {}), statusIn: statuses, code }] : others });
            };
            return (
              <div key={i} className="int-auth-row int-auth-row-outcome">
                <input aria-label={`Outcome ${i + 1} code`} value={o.code} onChange={(e) => setCode({ code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") })} />
                <input aria-label={`Outcome ${i + 1} meaning`} value={o.meaning} onChange={(e) => setCode({ meaning: e.target.value })} />
                <input type="checkbox" aria-label={`Outcome ${i + 1} success`} checked={o.success} onChange={(e) => setCode({ success: e.target.checked })} />
                <input aria-label={`Outcome ${i + 1} statuses`} placeholder="e.g. 200, 201" defaultValue={(rule?.statusIn ?? []).join(", ")} onBlur={(e) => setCode({}, e.target.value)} />
                <button type="button" className="icon-button" aria-label={`Remove outcome ${o.code}`} onClick={() => set({ outcomeCodes: draft.outcomeCodes.filter((_, j) => j !== i), outcomeMapping: draft.outcomeMapping.filter((m) => m.code !== o.code) })}><Trash2 size={13} /></button>
              </div>
            );
          })}
          <button type="button" className="pzn-btn pzn-btn-sm" onClick={() => set({ outcomeCodes: [...draft.outcomeCodes, { code: `CODE_${draft.outcomeCodes.length + 1}`, meaning: "Describe it", success: false }] })}><Plus size={12} /> Add outcome</button>
        </div>
      </div>

      <button type="button" className="pzn-btn pzn-btn-sm int-auth-advanced" onClick={() => setAdvanced((a) => !a)}>{advanced ? "Hide" : "Show"} full contract JSON</button>
      {advanced && (
        <textarea className="int-auth-json" rows={12} aria-label="Full contract JSON" defaultValue={JSON.stringify(draft, null, 2)}
          onBlur={(e) => { const parsed = safeParse(e.target.value); if (parsed && typeof parsed === "object") set(parsed as TaskContractInput); }} />
      )}

      <CheckPanel check={check} checking={checking} />
      {error && <p className="pzn-error" role="alert">{error}</p>}
      <div className="pzn-btn-row">
        <button type="button" className="pzn-btn pzn-btn-primary pzn-btn-sm" disabled={busy || checking || !check?.ok} onClick={() => void save()}>
          <Save size={12} /> {busy ? "Saving…" : savedRef ? "Save again" : "Save draft"}
        </button>
        {savedRef && (
          <button type="button" className="pzn-btn pzn-btn-sm" onClick={() => onPrompt(`Publish ${savedRef}`)}><Rocket size={12} /> Review &amp; publish</button>
        )}
        {savedRef && <span className="pzn-badge is-pass">Saved {savedRef}</span>}
      </div>
    </section>
  );
}

/* ============================================================================ PUBLISH REVIEW */

export function PublishReviewCard({ contract, check, onPrompt, post }: { contract: ViewContract; check: DraftCheck; onPrompt: (p: string) => void; post?: Post }) {
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ route: string; note?: string; contract?: ViewContract; pendingApprovalId?: string } | null>(null);
  const props = Object.keys(((contract.inputSchema as { properties?: Json }).properties) ?? {});
  const blocked = !check.ok || check.publishBlockers.length > 0;

  async function publish() {
    setBusy(true);
    setError("");
    try {
      const out = await api.publishIntegrationTask(contract.ref);
      if (out.status === "pending_approval" && out.approval) {
        setResult({ route: "pending_approval", pendingApprovalId: out.approval.id, note: `Approval ${out.approval.id} queued in HITL.` });
        post?.(`Publishing **${contract.ref}** requires HITL approval (**${out.approval.id}**). Approve it in the Approvals queue to publish.`, { suggestions: ["Show pending approvals"] });
        return;
      }
      const published = out.view.contracts.find((c) => c.ref === contract.ref);
      const route = out.sfieldRoute ?? "unavailable";
      setResult({ route, ...(out.registrationNote ? { note: out.registrationNote } : {}), ...(published ? { contract: published } : {}) });
      post?.(
        `Published **${contract.ref}**. ${route === "dedicated" ? "It's registered as its own sfield tool and can run now." : route === "dispatcher" ? "It runs now through the sfield dispatcher." : "The sfield runtime isn't available, so it can't run yet."}`,
        { suggestions: [`Run ${contract.ref}`, "Show integrations and tasks"] },
      );
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="content-card pzn-widget-card int-auth-card" aria-label="Publish review">
      <div className="pzn-widget-head">
        <div>
          <span className="pzn-stage-kicker"><Rocket size={13} /> REVIEW BEFORE PUBLISHING</span>
          <h3>{contract.ref}</h3>
        </div>
        <span className={"pzn-badge " + (contract.effect === "read" ? "" : contract.effect === "write" ? "is-warn" : "is-fail")}>{contract.effect}</span>
      </div>
      <p className="pzn-subtitle" style={{ fontSize: "0.84rem", color: "var(--text)" }}>{contract.description}</p>
      <div className="pzn-list-meta" style={{ fontSize: "0.78rem" }}>
        <span>Inputs: {props.join(", ") || "none"}</span>
        <span>{approvalLabel(contract)}{contract.approvalPolicy.dualControl ? " · second approver" : ""}</span>
        <span>Idempotency: {contract.idempotency.supported ? contract.idempotency.keyField : contract.manualReconcile ? "manual reconcile" : contract.reconcileTaskId ? `reconcile via ${contract.reconcileTaskId}` : "n/a"}</span>
        <span>Calls: {contract.binding.method} {contract.binding.target}</span>
      </div>
      <CheckPanel check={check} checking={false} />
      <p className="pzn-subtitle" style={{ fontSize: "0.76rem" }}>
        Publishing makes this version immutable and runnable. It is registered as its own sfield tool right away (no restart); changes after this need a new version.
      </p>
      {error && <p className="pzn-error" role="alert">{error}</p>}
      {!result ? (
        <>
          <label className="int-auth-check-label">
            <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> I reviewed the inputs, approval rule and outcomes
          </label>
          <div className="pzn-btn-row">
            <button type="button" className="pzn-btn pzn-btn-primary pzn-btn-sm" disabled={busy || blocked || !reviewed} onClick={() => void publish()}>
              <Rocket size={12} /> {busy ? "Publishing…" : "Publish"}
            </button>
            <button type="button" className="pzn-btn pzn-btn-sm" onClick={() => onPrompt(`Edit ${contract.ref}`)}><Pencil size={12} /> Edit draft</button>
          </div>
        </>
      ) : (
        <div className="pzn-btn-row">
          <span className={"pzn-badge " + (result.pendingApprovalId ? "is-warn" : "is-pass")}>
            {result.pendingApprovalId ? `Pending approval (${result.pendingApprovalId})` : "Published"}
          </span>
          {result.contract && <RouteBadge contract={result.contract} />}
          {result.note && <span className="pzn-subtitle" style={{ fontSize: "0.74rem" }}>{result.note}</span>}
          {!result.pendingApprovalId && (
            <button type="button" className="pzn-btn pzn-btn-sm pzn-btn-primary" onClick={() => onPrompt(`Run ${contract.ref}`)}>Run it</button>
          )}
        </div>
      )}
    </section>
  );
}

/* ============================================================================ INTEGRATION FORM */

export function IntegrationFormCard({ prefill, existing, onPrompt, post }: { prefill: Partial<Integration>; existing: boolean; onPrompt: (p: string) => void; post?: Post }) {
  const [form, setForm] = useState({
    id: prefill.id ?? "", name: prefill.name ?? "", description: prefill.description ?? "",
    transport: prefill.transport ?? "mcp", baseUrl: prefill.baseUrl ?? "", secretRef: prefill.secretRef ?? "",
    timeoutMs: prefill.timeoutMs ?? 5000, enabled: prefill.enabled ?? true,
    rpm: prefill.rateLimit?.requestsPerMinute ? String(prefill.rateLimit.requestsPerMinute) : "",
    burst: prefill.rateLimit?.burst ? String(prefill.rateLimit.burst) : "",
    failureThreshold: prefill.circuitBreaker?.failureThreshold ? String(prefill.circuitBreaker.failureThreshold) : "5",
    resetTimeoutMs: prefill.circuitBreaker?.resetTimeoutMs ? String(prefill.circuitBreaker.resetTimeoutMs) : "30000",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<Integration | null>(null);
  const set = (patch: Partial<typeof form>) => { setSaved(null); setForm((f) => ({ ...f, ...patch })); };

  async function save() {
    setBusy(true);
    setError("");
    try {
      const rpmNum = Number(form.rpm);
      const burstNum = Number(form.burst);
      const threshNum = Number(form.failureThreshold);
      const resetNum = Number(form.resetTimeoutMs);
      const out = await api.saveIntegration({
        id: form.id, name: form.name || form.id, description: form.description, transport: form.transport,
        baseUrl: form.baseUrl, ...(form.secretRef ? { secretRef: form.secretRef } : {}), timeoutMs: Number(form.timeoutMs), enabled: form.enabled,
        ...(rpmNum >= 1 ? { rateLimit: { requestsPerMinute: rpmNum, ...(burstNum >= 1 ? { burst: burstNum } : {}) } } : {}),
        ...(threshNum >= 1 && resetNum >= 500 ? { circuitBreaker: { failureThreshold: threshNum, resetTimeoutMs: resetNum } } : {}),
      });
      if (isPublicationReview(out)) return;
      setSaved(out.integration);
      post?.(`Saved integration **${out.integration.name}** (\`${out.integration.id}\`).`, {
        suggestions: out.integration.transport === "mcp" ? [`Import tools from ${out.integration.id}`] : [`Create a task on ${out.integration.id}`],
      });
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="content-card pzn-widget-card int-auth-card" aria-label="Integration form">
      <div className="pzn-widget-head">
        <div>
          <span className="pzn-stage-kicker"><Plug size={13} /> {existing ? "EDIT INTEGRATION" : "CONNECT A SYSTEM"}</span>
          <h3>{form.name || form.id || "New integration"}</h3>
        </div>
        <span className="pzn-badge">{form.transport}</span>
      </div>
      <div className="pzn-form-grid">
        <div className="pzn-field"><label>Id</label><input aria-label="Integration id" value={form.id} disabled={existing} onChange={(e) => set({ id: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} /></div>
        <div className="pzn-field"><label>Name</label><input aria-label="Integration name" value={form.name} onChange={(e) => set({ name: e.target.value })} /></div>
        <div className="pzn-field">
          <label>Transport</label>
          <select aria-label="Transport" value={form.transport} onChange={(e) => set({ transport: e.target.value as Integration["transport"] })}>
            <option value="mcp">MCP server (JSON-RPC over HTTP)</option>
            <option value="http">HTTP API</option>
            <option value="sandbox">Sandbox (demo handlers)</option>
          </select>
        </div>
        <div className="pzn-field"><label>Timeout (ms)</label><input aria-label="Timeout" type="number" min={200} max={30000} value={form.timeoutMs} onChange={(e) => set({ timeoutMs: Number(e.target.value) })} /></div>
        <div className="pzn-field is-full">
          <label>URL</label>
          <input aria-label="Base URL" placeholder="https://…" value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
          {form.transport === "mcp" && (
            <button type="button" className="pzn-btn pzn-btn-sm" style={{ marginTop: 6, alignSelf: "flex-start" }}
              onClick={() => set({ baseUrl: `${window.location.origin}/api/integrations/demo-mcp`, ...(existing ? {} : { id: "demo_commerce", name: "Demo Commerce (MCP)", description: "Built-in demo MCP server: orders, refunds, subscriptions." }) })}>
              Use the built-in demo MCP server
            </button>
          )}
        </div>
        <div className="pzn-field"><label>Secret (env var name)</label><input aria-label="Secret env var" placeholder="e.g. ORDERS_API_TOKEN" value={form.secretRef} onChange={(e) => set({ secretRef: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") })} /></div>
        <div className="pzn-field"><label>Rate limit (req/min)</label><input aria-label="Rate limit req/min" type="number" min={1} placeholder="unlimited" value={form.rpm} onChange={(e) => set({ rpm: e.target.value })} /></div>
        <div className="pzn-field"><label>Rate burst</label><input aria-label="Rate burst" type="number" min={1} placeholder="same as req/min" value={form.burst} onChange={(e) => set({ burst: e.target.value })} /></div>
        <div className="pzn-field"><label>Circuit failure threshold</label><input aria-label="Circuit failure threshold" type="number" min={1} max={50} value={form.failureThreshold} onChange={(e) => set({ failureThreshold: e.target.value })} /></div>
        <div className="pzn-field"><label>Circuit reset (ms)</label><input aria-label="Circuit reset ms" type="number" min={500} max={600000} value={form.resetTimeoutMs} onChange={(e) => set({ resetTimeoutMs: e.target.value })} /></div>
        <div className="pzn-field is-full"><label>Description</label><input aria-label="Integration description" value={form.description} onChange={(e) => set({ description: e.target.value })} /></div>
      </div>
      <p className="pzn-subtitle" style={{ fontSize: "0.74rem" }}>Secrets are referenced by environment variable name; the value never leaves the server. Once tasks are published, the URL and transport are fixed.</p>
      {error && <p className="pzn-error" role="alert">{error}</p>}
      <div className="pzn-btn-row">
        <button type="button" className="pzn-btn pzn-btn-primary pzn-btn-sm" disabled={busy || !form.id || (form.transport !== "sandbox" && !form.baseUrl)} onClick={() => void save()}>
          <Save size={12} /> {busy ? "Saving…" : "Save integration"}
        </button>
        {saved?.transport === "mcp" && <button type="button" className="pzn-btn pzn-btn-sm" onClick={() => onPrompt(`Import tools from ${saved.id}`)}><Download size={12} /> Import tools</button>}
        {saved && saved.transport !== "mcp" && <button type="button" className="pzn-btn pzn-btn-sm" onClick={() => onPrompt(`Create a task on ${saved.id}`)}><FilePlus2 size={12} /> Add a task</button>}
        {saved && <span className="pzn-badge is-pass">Saved</span>}
      </div>
    </section>
  );
}

/* ============================================================================ MCP IMPORT */

export function McpImportCard({ integrationId, candidates, error, onPrompt, post }: {
  integrationId: string; candidates: McpImportCandidate[]; error?: string; onPrompt: (p: string) => void; post?: Post;
}) {
  const [selected, setSelected] = useState<Record<string, boolean>>(() => Object.fromEntries(candidates.map((c) => [c.toolName, c.check.ok && !c.alreadyImported])));
  const [editing, setEditing] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busy, setBusy] = useState(false);
  const drafts = useMemo<Record<string, TaskContractInput>>(() => Object.fromEntries(candidates.map((c) => [c.toolName, c.draft])), [candidates]);
  const chosen = candidates.filter((c) => selected[c.toolName] && !status[c.toolName]?.ok);

  async function createDrafts() {
    setBusy(true);
    const refs: string[] = [];
    for (const c of chosen) {
      try {
        const out = await api.saveIntegrationDraft(drafts[c.toolName]!);
        refs.push(out.contract.ref);
        setStatus((s) => ({ ...s, [c.toolName]: { ok: true, text: out.contract.ref } }));
      } catch (e) {
        setStatus((s) => ({ ...s, [c.toolName]: { ok: false, text: toolSetupErrorMessage(e) } }));
      }
    }
    setBusy(false);
    if (refs.length) post?.(`Created ${refs.length} draft(s): ${refs.map((r) => `**${r}**`).join(", ")}. Review and publish each one to make it runnable.`, { suggestions: [...refs.slice(0, 2).map((r) => `Publish ${r}`), "Show drafts"] });
  }

  return (
    <section className="content-card pzn-widget-card int-auth-card" aria-label="MCP import">
      <div className="pzn-widget-head">
        <div>
          <span className="pzn-stage-kicker"><Download size={13} /> IMPORT FROM MCP · {integrationId}</span>
          <h3>{error ? "Couldn't list tools" : `${candidates.length} tool(s) found`}</h3>
        </div>
      </div>
      {error && <p className="pzn-error" role="alert">{error}</p>}
      <div className="pzn-list">
        {candidates.map((c) => {
          const st = status[c.toolName];
          return (
            <div key={c.toolName} className="pzn-attr-card">
              <div className="pzn-attr-head">
                <label className="int-auth-check-label">
                  <input type="checkbox" aria-label={`Import ${c.toolName}`} checked={Boolean(selected[c.toolName])} disabled={busy || st?.ok} onChange={(e) => setSelected((s) => ({ ...s, [c.toolName]: e.target.checked }))} />
                  <strong>{c.toolName}</strong>
                </label>
                <div className="pzn-btn-row">
                  <span className={"pzn-badge " + (drafts[c.toolName]!.effect === "read" ? "" : drafts[c.toolName]!.effect === "write" ? "is-warn" : "is-fail")}>{drafts[c.toolName]!.effect}</span>
                  <span className="pzn-badge">v{drafts[c.toolName]!.version}</span>
                  {c.alreadyImported && <span className="pzn-badge">already imported</span>}
                  {!c.check.ok && <span className="pzn-badge is-fail">needs fixes</span>}
                  {st && <span className={"pzn-badge " + (st.ok ? "is-pass" : "is-fail")}>{st.ok ? `draft ${st.text}` : "failed"}</span>}
                  <button type="button" className="pzn-btn pzn-btn-sm" disabled={busy || st?.ok} onClick={() => setEditing(editing === c.toolName ? null : c.toolName)}><Pencil size={12} /> {editing === c.toolName ? "Done" : "Customize"}</button>
                </div>
              </div>
              <p className="pzn-subtitle" style={{ fontSize: "0.8rem" }}>{c.description}</p>
              <ul className="int-auth-notes">{c.notes.map((n) => <li key={n}>{n}</li>)}</ul>
              {!c.check.ok && <ul className="int-auth-issues is-fail">{c.check.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
              {st && !st.ok && <p className="pzn-error">{st.text}</p>}
              {editing === c.toolName && (
                <TaskDraftCard compact draft={drafts[c.toolName]!} check={c.check} origin="mcp_import" onPrompt={onPrompt}
                  onSaved={(ref) => { setStatus((s) => ({ ...s, [c.toolName]: { ok: true, text: ref } })); setEditing(null); }} />
              )}
            </div>
          );
        })}
      </div>
      {!error && (
        <div className="pzn-btn-row">
          <button type="button" className="pzn-btn pzn-btn-primary pzn-btn-sm" disabled={busy || chosen.length === 0} onClick={() => void createDrafts()}>
            <FilePlus2 size={12} /> {busy ? "Creating…" : `Create ${chosen.length} draft(s)`}
          </button>
          <span className="pzn-subtitle" style={{ fontSize: "0.74rem" }}>Drafts don't run until you publish them.</span>
        </div>
      )}
    </section>
  );
}

/* ============================================================================ DRAFTS */

export function DraftsCard({ drafts: initialDrafts, onPrompt }: { drafts: ViewContract[]; onPrompt: (p: string) => void }) {
  const [drafts, setDrafts] = useState(initialDrafts);
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { setDrafts(initialDrafts); }, [initialDrafts]);

  async function removeDraft(ref: string) {
    setBusyRef(ref);
    setError("");
    try {
      await api.deleteIntegrationDraft(ref);
      setDrafts((prev) => prev.filter((d) => d.ref !== ref));
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setBusyRef(null);
    }
  }

  return (
    <section className="content-card pzn-widget-card" aria-label="Drafts">
      <div className="pzn-widget-head">
        <div>
          <span className="pzn-stage-kicker"><FilePlus2 size={13} /> DRAFTS</span>
          <h3>{drafts.length} draft(s) waiting</h3>
        </div>
        <button type="button" className="pzn-btn pzn-btn-sm" onClick={() => onPrompt("Create a new task")}><Plus size={12} /> New task</button>
      </div>
      {error && <p className="pzn-error" role="alert">{error}</p>}
      <div className="pzn-list">
        {drafts.map((d) => (
          <div key={d.ref} className="pzn-attr-card">
            <div className="pzn-attr-head">
              <div className="pzn-btn-row">
                <strong>{d.taskId}</strong><span className="pzn-badge">v{d.version}</span>
                <span className={"pzn-badge " + (d.effect === "read" ? "" : d.effect === "write" ? "is-warn" : "is-fail")}>{d.effect}</span>
                <span className="pzn-code">{d.integrationId}</span>
              </div>
              <div className="pzn-btn-row">
                <button type="button" className="pzn-btn pzn-btn-sm" onClick={() => onPrompt(`Edit ${d.ref}`)}><Pencil size={12} /> Edit</button>
                <button type="button" className="pzn-btn pzn-btn-sm pzn-btn-primary" onClick={() => onPrompt(`Publish ${d.ref}`)}><Rocket size={12} /> Publish</button>
                <button type="button" className="pzn-btn pzn-btn-sm" disabled={busyRef === d.ref} aria-label={`Delete draft ${d.ref}`} onClick={() => void removeDraft(d.ref)}><Trash2 size={12} /></button>
              </div>
            </div>
            <p className="pzn-subtitle" style={{ fontSize: "0.8rem" }}>{d.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
