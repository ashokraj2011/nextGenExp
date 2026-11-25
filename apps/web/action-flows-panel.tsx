import { useEffect, useState } from "react";
import { Plug, Plus, Save, ShieldCheck, Trash2, Zap } from "lucide-react";
import type { ActionFlow, ActionFlowApprovalMode, ActionFlowTargetKind } from "../../packages/contracts/action-flow";
import type { ExternalConnector } from "../../packages/contracts/connector";
import type { RecommendationDomain } from "../../packages/contracts/recommendation-provider";
import { api } from "./api";

export function ActionFlowsPanel() {
  const [flows, setFlows] = useState<ActionFlow[]>([]);
  const [connectors, setConnectors] = useState<ExternalConnector[]>([]);
  const [selectedId, setSelectedId] = useState<string | "new">("");
  const [name, setName] = useState("");
  const [domain, setDomain] = useState<RecommendationDomain>("operations");
  const [description, setDescription] = useState("");
  const [phrasesText, setPhrasesText] = useState("");
  const [targetKind, setTargetKind] = useState<ActionFlowTargetKind>("external_connector");
  const [connectorId, setConnectorId] = useState("pagerduty_incident_webhook");
  const [connectorAction, setConnectorAction] = useState("escalate_p1_incident");
  const [approvalMode, setApprovalMode] = useState<ActionFlowApprovalMode>("hitl_inline");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  function loadIntoForm(flow: ActionFlow) {
    setSelectedId(flow.id);
    setName(flow.name);
    setDomain(flow.domain);
    setDescription(flow.description);
    setPhrasesText(flow.triggerPhrases.join("\n"));
    setTargetKind(flow.targetKind);
    setConnectorId(flow.connectorId ?? connectors[0]?.id ?? "pagerduty_incident_webhook");
    setConnectorAction(flow.connectorAction ?? "trigger_action_flow");
    setApprovalMode(flow.approvalMode);
    setEnabled(flow.enabled);
  }

  useEffect(() => {
    let active = true;
    void Promise.all([api.actionFlows(), api.connectors()]).then(([fRes, cRes]) => {
      if (!active) return;
      setFlows(fRes.flows);
      setConnectors(cRes.connectors);
      if (fRes.flows[0]) {
        const first = fRes.flows[0];
        setSelectedId(first.id);
        setName(first.name);
        setDomain(first.domain);
        setDescription(first.description);
        setPhrasesText(first.triggerPhrases.join("\n"));
        setTargetKind(first.targetKind);
        setConnectorId(first.connectorId ?? cRes.connectors[0]?.id ?? "pagerduty_incident_webhook");
        setConnectorAction(first.connectorAction ?? "trigger_action_flow");
        setApprovalMode(first.approvalMode);
        setEnabled(first.enabled);
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  function startNew() {
    setSelectedId("new");
    setName("");
    setDomain("operations");
    setDescription("");
    setPhrasesText("");
    setTargetKind("external_connector");
    setConnectorId(connectors[0]?.id ?? "pagerduty_incident_webhook");
    setConnectorAction("trigger_action_flow");
    setApprovalMode("hitl_inline");
    setEnabled(true);
    setNotice(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const triggerPhrases = phrasesText.split("\n").map((s) => s.trim()).filter((s) => s.length >= 2).slice(0, 8);
    if (!name.trim() || !description.trim() || triggerPhrases.length === 0) {
      setNotice({ tone: "error", text: "Provide a flow name, description, and at least one trigger phrase." });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const res = await api.saveActionFlow({
        ...(selectedId && selectedId !== "new" ? { id: selectedId } : {}),
        name: name.trim(),
        domain,
        description: description.trim(),
        triggerPhrases,
        targetKind,
        ...(targetKind === "external_connector" ? { connectorId, connectorAction: connectorAction.trim() || "invoke" } : {}),
        approvalMode,
        enabled,
      });
      setFlows(res.flows);
      loadIntoForm(res.flow);
      setNotice({ tone: "ok", text: `Saved No-Code Action Flow "${res.flow.name}". Ask "${res.flow.triggerPhrases[0]}" in Chat to trigger it immediately.` });
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not save action flow." });
    } finally {
      setSaving(false);
    }
  }

  async function removeFlow() {
    if (!selectedId || selectedId === "new") return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await api.deleteActionFlow(selectedId);
      setFlows(res.flows);
      if (res.flows[0]) loadIntoForm(res.flows[0]);
      else startNew();
      setNotice({ tone: "ok", text: "Deleted action flow." });
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not delete action flow." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="reg-grid">
      <section className="reg-rail" aria-label="No-Code Action Flows">
        <div className="reg-rail-head">
          <h2>Action Flows</h2>
          <button type="button" className="reg-mini-btn" onClick={startNew}>
            <Plus size={14} aria-hidden="true" />New
          </button>
        </div>
        <div className="reg-list">
          {flows.map((flow) => (
            <button
              key={flow.id}
              type="button"
              className={"reg-list-item" + (selectedId === flow.id ? " is-active" : "") + (!flow.enabled ? " is-muted" : "")}
              onClick={() => { loadIntoForm(flow); setNotice(null); }}
            >
              <div className="reg-item-top">
                <strong>{flow.name}</strong>
                <span className="reg-tag tag-custom">{flow.approvalMode === "hitl_4eyes" ? "4-Eyes" : flow.approvalMode === "hitl_inline" ? "HITL" : "Auto"}</span>
              </div>
              <div className="reg-item-flow">
                <code>{flow.domain}</code>
                <span className="reg-ctx-pill">{flow.connectorId ?? flow.targetKind}</span>
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="reg-editor">
        {notice && (
          <p className={"reg-notice " + (notice.tone === "error" ? "is-error" : "is-ok")} role="status">{notice.text}</p>
        )}
        <form onSubmit={(e) => void save(e)} style={{ display: "grid", gap: "14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
            <div>
              <h2 style={{ margin: 0, display: "inline-flex", alignItems: "center", gap: "8px" }}>
                <Zap size={18} aria-hidden="true" />
                {selectedId === "new" ? "New No-Code Action Flow" : name || "Edit Action Flow"}
              </h2>
              <p className="reg-hint" style={{ marginTop: "4px" }}>
                Declaratively bind trigger phrases → external connector / sfield tool → HITL approval policy with zero code deploys.
              </p>
            </div>
            <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "0.86rem", fontWeight: 600 }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Enabled live
            </label>
          </div>

          <div className="reg-form-row">
            <label className="reg-field">
              <span>Flow Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Emergency PagerDuty Escalation" required />
            </label>
            <label className="reg-field">
              <span>Domain</span>
              <select value={domain} onChange={(e) => setDomain(e.target.value as RecommendationDomain)}>
                <option value="operations">operations</option>
                <option value="wealth">wealth</option>
                <option value="sales">sales</option>
                <option value="general">general</option>
              </select>
            </label>
          </div>

          <label className="reg-field">
            <span>Description</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Explain what this flow executes in sfield" required />
          </label>

          <label className="reg-field">
            <span>Trigger Phrases (one per line — matched live in Chat)</span>
            <textarea rows={3} value={phrasesText} onChange={(e) => setPhrasesText(e.target.value)} placeholder={"escalate to pagerduty\npage SRE on-call"} required />
          </label>

          <div className="reg-form-row">
            <label className="reg-field">
              <span><Plug size={13} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: "4px" }} />Bound Target</span>
              <select value={targetKind} onChange={(e) => setTargetKind(e.target.value as ActionFlowTargetKind)}>
                <option value="external_connector">External Connector (cep.connector.invoke@1.0.0)</option>
                <option value="domain_write">Governed Domain Write (cep.domain.execute_write@1.0.0)</option>
              </select>
            </label>
            <label className="reg-field">
              <span><ShieldCheck size={13} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: "4px" }} />Approval Policy</span>
              <select value={approvalMode} onChange={(e) => setApprovalMode(e.target.value as ActionFlowApprovalMode)}>
                <option value="hitl_inline">Inline HITL Approval (Chat + Admin)</option>
                <option value="hitl_4eyes">4-Eyes Dual Control (Separate Approver Required)</option>
                <option value="auto_execute">Auto-Execute (No HITL Pause)</option>
              </select>
            </label>
          </div>

          {targetKind === "external_connector" && (
            <div className="reg-form-row">
              <label className="reg-field">
                <span>Registered Connector</span>
                <select value={connectorId} onChange={(e) => setConnectorId(e.target.value)}>
                  {connectors.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.kind})</option>
                  ))}
                </select>
              </label>
              <label className="reg-field">
                <span>Connector Action Name</span>
                <input value={connectorAction} onChange={(e) => setConnectorAction(e.target.value)} placeholder="e.g., escalate_p1_incident" />
              </label>
            </div>
          )}

          <div className="reg-actions">
            <button type="submit" className="send-button" disabled={saving}>
              <Save size={15} aria-hidden="true" />{saving ? "Saving…" : "Save Action Flow"}
            </button>
            {selectedId && selectedId !== "new" && (
              <button type="button" className="secondary-button" disabled={saving} onClick={() => void removeFlow()}>
                <Trash2 size={15} aria-hidden="true" />Delete flow
              </button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
