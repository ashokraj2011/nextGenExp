import { useEffect, useState } from "react";
import { getDomainPack } from "../../packages/contracts/domain-packs";
import type { CepCapabilityId } from "../../packages/contracts/capabilities-catalog";
import { applyFlowOverride, flowOverridesSchema, type FlowOverride, type FlowOverrides, type FlowScope } from "../../packages/contracts/routing-flows";
import { api, isPublicationReview, toolSetupErrorMessage } from "./api";

const scopeName = (scope: FlowScope) => scope === "tenant" ? "Tenant defaults" : getDomainPack(scope).shortLabel;

export function RoutingFlowSetup() {
  const [scope, setScope] = useState<FlowScope>();
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof api.routingFlows>>>();
  const [draft, setDraft] = useState<FlowOverrides>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    setLoaded(undefined);
    setError("");
    setNotice("");
    api.routingFlows(scope).then((result) => {
      if (active) { setLoaded(result); setDraft(result.data.overrides); }
    }, (err: unknown) => { if (active) setError(toolSetupErrorMessage(err)); });
    return () => { active = false; };
  }, [scope, reload]);
  const data = loaded?.data;
  const dirty = Boolean(data && JSON.stringify(draft) !== JSON.stringify(data.overrides));
  function edit(id: CepCapabilityId, changes: FlowOverride) {
    const next = { ...draft };
    if (Object.values(changes).every((item) => item === undefined)) delete next[id];
    else next[id] = changes;
    setDraft(next); setError(""); setNotice("");
  }
  async function save() {
    if (!loaded || !dirty || saving) return;
    const changes = Object.fromEntries(Object.entries(draft).map(([id, rule]) => [id, {
      ...rule, ...(rule.examples && { examples: rule.examples.map((value) => value.trim()).filter(Boolean) }),
    }]));
    const parsed = flowOverridesSchema.safeParse(changes);
    if (!parsed.success) {
      setError("Enter a description of up to 600 characters and at most 12 examples of up to 200 characters each.");
      return;
    }
    setSaving(true); setError("");
    try {
      const result = await api.saveRoutingFlows(loaded.data.scope, parsed.data, loaded.revision);
      if (isPublicationReview(result.data)) return;
      setLoaded({ data: result.data, revision: result.revision });
      setDraft(result.data.overrides); setNotice("Flow settings saved for " + scopeName(result.data.scope) + ".");
    } catch (err) { setError(toolSetupErrorMessage(err)); }
    finally { setSaving(false); }
  }
  const canLeave = () => !dirty || window.confirm("Discard unsaved flow changes?");
  return <section id="routing-flows" className="admin-card routing-flow-setup" aria-labelledby="routing-flows-title">
    <h2 id="routing-flows-title">Chat routing flows</h2>
    <p>Choose the flows the app can send to the model when it receives a message.</p>
    {error && <p role="alert" className="admin-error">{error}{" "}
      <button type="button" className="secondary-button" onClick={() => { if (canLeave()) setReload((n) => n + 1); }}>Reload flow settings</button></p>}
    {!data && !error && <p role="status">Loading flows…</p>}
    {data && <fieldset disabled={saving}>
      <div className="flow-scope-bar">
        <label>Settings scope
          <select value={data.scope} onChange={(event) => { if (canLeave()) setScope(event.target.value as FlowScope); }}>
            {data.editableScopes.map((item) => <option key={item} value={item}>{scopeName(item)}</option>)}
          </select>
        </label>
        <p>Tenant <strong>{data.tenantId}</strong></p>
      </div>
      <p>{data.scope === "tenant" ? "These defaults apply across this tenant’s domains." : "This domain inherits the tenant defaults. Turn off a flow or edit its wording for this domain."}</p>
      <ul className="flow-options">{data.inherited.map((parent) => {
        const change = draft[parent.id] ?? {};
        const flow = applyFlowOverride(parent, change);
        const operatorOnly = flow.domain === "platform" && flow.id !== "custom_dynamic_ui";
        return <li key={flow.id}>
          <label className="admin-tool">
            <span><strong>{flow.label}</strong><code>{flow.id}</code>{operatorOnly && <small>Operator chats only</small>}</span>
            <input type="checkbox" role="switch" aria-label={"Enable " + flow.id} disabled={!parent.enabled} checked={flow.enabled}
              onChange={(event) => edit(flow.id, { ...change, enabled: event.target.checked ? undefined : false })} />
          </label>
          {!parent.enabled && <p>Disabled in tenant defaults.</p>}
          <details><summary>Routing description and examples</summary>
            <label>Description for {flow.id}
              <textarea rows={2} maxLength={600} value={flow.description} onChange={(event) => edit(flow.id, {
                ...change, description: event.target.value === parent.description ? undefined : event.target.value,
              })} />
            </label>
            <label>Example messages for {flow.id} (one per line)
              <textarea rows={3} value={flow.examples.join("\n")} onChange={(event) => edit(flow.id, {
                ...change, examples: event.target.value === parent.examples.join("\n") ? undefined : event.target.value.split("\n"),
              })} />
            </label>
          </details>
          {draft[flow.id] && <button className="flow-reset" type="button" onClick={() => edit(flow.id, {})}>
            {data.scope === "tenant" ? "Use registered defaults" : "Use tenant defaults"} for {flow.id}</button>}
        </li>;
      })}</ul>
      <div className="flow-save">
        <button type="button" className="send-button" disabled={!dirty} onClick={() => void save()}>{saving ? "Saving…" : "Save flow settings"}</button>
        <p role="status">{notice || (dirty ? "Unsaved flow settings" : "")}</p>
      </div>
    </fieldset>}
  </section>;
}
