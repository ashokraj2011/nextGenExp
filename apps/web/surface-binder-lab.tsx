import { useEffect, useState } from "react";
import { CheckCircle2, Database, Lock, Play, RefreshCw, ShieldCheck, Sparkles, Terminal } from "lucide-react";

interface SurfaceSchemaField {
  path: string;
  type: string;
  description?: string;
}

interface SurfaceToolSchema {
  toolRef: string;
  description: string;
  effect: string;
  outputFields: SurfaceSchemaField[];
  inputFields: SurfaceSchemaField[];
}

interface SealedSurfaceAction {
  actionId: string;
  label: string;
  toolRef: string;
  preset: string;
  inputSlots: string[];
  seal: string;
}

interface StitchedSurfaceComponent {
  id: string;
  type: string;
  props: Record<string, unknown>;
}

interface StitchedSurfaceEnvelope {
  surfaceId: string;
  title?: string;
  components: StitchedSurfaceComponent[];
  actions: SealedSurfaceAction[];
  dataModel: Record<string, unknown>;
  sourceResults?: Record<string, { status: string; callId?: string; error?: string }>;
}

interface ActionDispatchResult {
  status: string;
  output?: unknown;
  approvalId?: string;
  callId?: string;
  elicitation?: unknown;
  error?: { code: string; message: string };
}

const DEFAULT_SOURCES = {
  empathy: {
    toolRef: "cep.empathy.assess@1.0.0",
    inputs: {
      message: "I was just laid off and I am worried about my emergency savings.",
      personaId: "demo-learner",
    },
  },
};

const DEFAULT_TEMPLATE = {
  surfaceId: "empathy-live-card",
  title: { $ref: "empathy.recommendedTone", fallback: "Customer Empathy Signal" },
  components: [
    {
      id: "tone_metric",
      type: "Metric",
      props: {
        label: "Detected Primary Emotion",
        value: { $ref: "empathy.primaryEmotion", format: "upper", fallback: "NEUTRAL" },
        subtext: { $ref: "empathy.recommendedTone", fallback: "Standard tone" },
      },
    },
    {
      id: "promo_guard",
      type: "Metric",
      props: {
        label: "Suppress Promotions",
        value: { $ref: "empathy.suppressPromotions", format: "string" },
        subtext: { $ref: "principal.identifiers.mid", fallback: "Principal MID" },
      },
    },
  ],
  actions: [
    {
      actionId: "reassess_empathy",
      label: "Re-run Empathy Assessment (Sealed)",
      toolRef: "cep.empathy.assess@1.0.0",
      preset: "read_only",
      inputs: {
        personaId: "demo-learner",
        message: { $input: "message" },
      },
    },
  ],
};

export function SurfaceBinderLab() {
  const [schemas, setSchemas] = useState<SurfaceToolSchema[]>([]);
  const [loadingSchemas, setLoadingSchemas] = useState(true);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [selectedToolRef, setSelectedToolRef] = useState<string>("");

  const [sourcesJson, setSourcesJson] = useState(() => JSON.stringify(DEFAULT_SOURCES, null, 2));
  const [templateJson, setTemplateJson] = useState(() => JSON.stringify(DEFAULT_TEMPLATE, null, 2));
  const [strictSchema, setStrictSchema] = useState(true);

  const [stitching, setStitching] = useState(false);
  const [stitchError, setStitchError] = useState<string | null>(null);
  const [envelope, setEnvelope] = useState<StitchedSurfaceEnvelope | null>(null);

  const [formInputs, setFormInputs] = useState<Record<string, Record<string, string>>>({});
  const [dispatchingId, setDispatchingId] = useState<string | null>(null);
  const [dispatchResult, setDispatchResult] = useState<{ actionId: string; result: ActionDispatchResult } | null>(null);

  async function loadSchemas() {
    setLoadingSchemas(true);
    setSchemaError(null);
    try {
      const res = await fetch("/api/surfaces/schemas");
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as { tools?: SurfaceToolSchema[] };
      const tools = data.tools ?? [];
      setSchemas(tools);
      if (tools.length && !selectedToolRef) {
        const empathy = tools.find((t) => t.toolRef === "cep.empathy.assess@1.0.0");
        setSelectedToolRef(empathy?.toolRef ?? tools[0].toolRef);
      }
    } catch (err) {
      setSchemaError(err instanceof Error ? err.message : "Could not load /api/surfaces/schemas.");
    } finally {
      setLoadingSchemas(false);
    }
  }

  useEffect(() => {
    void loadSchemas();
  }, []);

  async function runStitch() {
    setStitching(true);
    setStitchError(null);
    setDispatchResult(null);
    try {
      const sources = JSON.parse(sourcesJson);
      const template = JSON.parse(templateJson);
      const res = await fetch("/api/surfaces/stitch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sources, template, strictSchemaValidation: strictSchema }),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(payload?.message || payload?.error || `HTTP ${res.status}`);
      }
      setEnvelope(payload as StitchedSurfaceEnvelope);
    } catch (err) {
      setStitchError(err instanceof Error ? err.message : "Surface stitch failed.");
    } finally {
      setStitching(false);
    }
  }

  async function runSealedAction(action: SealedSurfaceAction) {
    setDispatchingId(action.actionId);
    setDispatchResult(null);
    try {
      const inputs = formInputs[action.actionId] ?? {};
      const res = await fetch("/api/surfaces/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, formInputs: inputs }),
      });
      const payload = await res.json();
      setDispatchResult({
        actionId: action.actionId,
        result: res.ok
          ? (payload as ActionDispatchResult)
          : { status: "failed", error: { code: payload?.code ?? `HTTP_${res.status}`, message: payload?.message ?? "Dispatch failed" } },
      });
    } catch (err) {
      setDispatchResult({
        actionId: action.actionId,
        result: { status: "failed", error: { code: "NETWORK_ERROR", message: err instanceof Error ? err.message : "Request failed" } },
      });
    } finally {
      setDispatchingId(null);
    }
  }

  const activeTool = schemas.find((t) => t.toolRef === selectedToolRef);

  return (
    <section aria-label="sfield SurfaceBinder Lab" style={{ display: "grid", gap: "16px", padding: "4px 0 24px" }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px",
        padding: "14px 16px", borderRadius: "12px", border: "1px solid var(--border, #d4e2da)", background: "var(--surface, #fff)",
      }}>
        <div>
          <h2 style={{ margin: "0 0 4px", fontSize: "1.05rem", display: "flex", alignItems: "center", gap: "8px" }}>
            <Sparkles size={16} aria-hidden="true" /> sfield SurfaceBinder Lab (<code>sf.surfaces</code>)
          </h2>
          <p style={{ margin: 0, fontSize: "0.86rem", color: "var(--muted, #4b6156)" }}>
            Blind pass-through demo: discovers closed tool schemas via <code>GET /api/surfaces/schemas</code>, stitches <code>$ref</code> / <code>$repeat</code> / <code>$input</code> via <code>POST /api/surfaces/stitch</code>, and dispatches HMAC-SHA256 sealed actions via <code>POST /api/surfaces/action</code>.
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button type="button" className="ui-button ui-button-outline ui-compact-btn" onClick={() => void loadSchemas()} disabled={loadingSchemas}>
            <RefreshCw size={13} aria-hidden="true" /> Refresh schemas
          </button>
          <button type="button" className="ui-button ui-button-primary ui-compact-btn" onClick={() => void runStitch()} disabled={stitching}>
            <Play size={13} aria-hidden="true" /> {stitching ? "Stitching…" : "Stitch via sf.surfaces"}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "14px", alignItems: "start" }}>
        {/* Column 1: Schema Auto-Discovery */}
        <div style={{ padding: "14px", borderRadius: "12px", border: "1px solid var(--border, #d4e2da)", background: "var(--surface, #fff)", display: "grid", gap: "10px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong style={{ fontSize: "0.9rem", display: "flex", alignItems: "center", gap: "6px" }}>
              <Database size={14} aria-hidden="true" /> 1. Registered Tool Schemas ({schemas.length})
            </strong>
          </div>
          {schemaError && <p className="ui-builder-error" role="alert">{schemaError}</p>}
          {loadingSchemas ? (
            <p style={{ margin: 0, fontSize: "0.84rem", color: "var(--muted)" }}>Loading schemas from <code>/api/surfaces/schemas</code>…</p>
          ) : (
            <>
              <select
                aria-label="Inspect registered sfield tool schema"
                value={selectedToolRef}
                onChange={(e) => setSelectedToolRef(e.target.value)}
                style={{ width: "100%", padding: "7px 9px", borderRadius: "8px", border: "1px solid var(--border, #d4e2da)" }}
              >
                {schemas.map((tool) => (
                  <option key={tool.toolRef} value={tool.toolRef}>
                    {tool.toolRef} ({tool.effect})
                  </option>
                ))}
              </select>
              {activeTool && (
                <div style={{ display: "grid", gap: "8px", fontSize: "0.82rem" }}>
                  <p style={{ margin: 0, color: "var(--muted)" }}>{activeTool.description}</p>
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: "4px" }}>Bindable Output Paths (<code>$ref</code>):</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                      {activeTool.outputFields.slice(0, 18).map((f) => (
                        <code key={f.path} title={f.description ?? f.type} style={{ fontSize: "0.75rem", padding: "2px 6px", borderRadius: "5px", background: "var(--surface-alt, #eef5f0)" }}>
                          {f.path}: {f.type}
                        </code>
                      ))}
                      {!activeTool.outputFields.length && <span style={{ color: "var(--muted)" }}>None declared</span>}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: "4px" }}>Input Parameters (<code>$input</code>):</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                      {activeTool.inputFields.slice(0, 12).map((f) => (
                        <code key={f.path} title={f.description ?? f.type} style={{ fontSize: "0.75rem", padding: "2px 6px", borderRadius: "5px", background: "var(--surface-alt, #eef5f0)" }}>
                          {f.path}: {f.type}
                        </code>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Column 2: Declarative Template + Read Sources */}
        <div style={{ padding: "14px", borderRadius: "12px", border: "1px solid var(--border, #d4e2da)", background: "var(--surface, #fff)", display: "grid", gap: "10px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
            <strong style={{ fontSize: "0.9rem", display: "flex", alignItems: "center", gap: "6px" }}>
              <Terminal size={14} aria-hidden="true" /> 2. Sources &amp; Declarative Template
            </strong>
            <label style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "0.78rem", cursor: "pointer" }}>
              <input type="checkbox" checked={strictSchema} onChange={(e) => setStrictSchema(e.target.checked)} />
              Strict schema check
            </label>
          </div>
          <label style={{ display: "grid", gap: "4px", fontSize: "0.8rem", fontWeight: 600 }}>
            Read Sources JSON
            <textarea
              aria-label="Read Sources JSON"
              rows={6}
              value={sourcesJson}
              onChange={(e) => setSourcesJson(e.target.value)}
              style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.76rem", padding: "8px", borderRadius: "8px", border: "1px solid var(--border, #d4e2da)" }}
            />
          </label>
          <label style={{ display: "grid", gap: "4px", fontSize: "0.8rem", fontWeight: 600 }}>
            Declarative Template JSON (<code>$ref</code> · <code>$repeat</code> · <code>$input</code>)
            <textarea
              aria-label="Declarative Template JSON"
              rows={11}
              value={templateJson}
              onChange={(e) => setTemplateJson(e.target.value)}
              style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.76rem", padding: "8px", borderRadius: "8px", border: "1px solid var(--border, #d4e2da)" }}
            />
          </label>
          {stitchError && <p className="ui-builder-error" role="alert">{stitchError}</p>}
        </div>

        {/* Column 3: Blindly Rendered Surface + Sealed Actions */}
        <div style={{ padding: "14px", borderRadius: "12px", border: "1px solid var(--border, #d4e2da)", background: "var(--surface, #fff)", display: "grid", gap: "12px" }}>
          <strong style={{ fontSize: "0.9rem", display: "flex", alignItems: "center", gap: "6px" }}>
            <ShieldCheck size={14} aria-hidden="true" /> 3. Blindly Rendered Surface &amp; Sealed Actions
          </strong>
          {!envelope ? (
            <p style={{ margin: 0, fontSize: "0.84rem", color: "var(--muted)" }}>
              Click <strong>Stitch via sf.surfaces</strong> to execute the read sources through <code>sfield</code> and render the stitched envelope here.
            </p>
          ) : (
            <>
              <div style={{ padding: "10px 12px", borderRadius: "10px", background: "var(--surface-alt, #eef5f0)", border: "1px solid var(--border, #d4e2da)" }}>
                <div style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--muted)" }}>
                  Surface · <code>{envelope.surfaceId}</code>
                </div>
                <div style={{ fontSize: "1rem", fontWeight: 700, marginTop: "2px" }}>
                  {envelope.title ?? envelope.surfaceId}
                </div>
              </div>

              <div style={{ display: "grid", gap: "8px" }}>
                {envelope.components.map((comp) => (
                  <div key={comp.id} style={{ padding: "10px 12px", borderRadius: "10px", border: "1px solid var(--border, #d4e2da)" }}>
                    <div style={{ fontSize: "0.74rem", color: "var(--muted)", display: "flex", justifyContent: "space-between" }}>
                      <span>{String(comp.props.label ?? comp.id)}</span>
                      <code>{comp.type}</code>
                    </div>
                    <div style={{ fontSize: "1.05rem", fontWeight: 700, marginTop: "3px" }}>
                      {String(comp.props.value ?? JSON.stringify(comp.props))}
                    </div>
                    {Boolean(comp.props.subtext) && (
                      <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: "2px" }}>
                        {String(comp.props.subtext)}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {envelope.actions.length > 0 && (
                <div style={{ display: "grid", gap: "10px", paddingTop: "6px", borderTop: "1px solid var(--border, #d4e2da)" }}>
                  <div style={{ fontSize: "0.8rem", fontWeight: 700, display: "flex", alignItems: "center", gap: "5px" }}>
                    <Lock size={13} aria-hidden="true" /> HMAC-SHA256 Sealed Actions
                  </div>
                  {envelope.actions.map((action) => (
                    <div key={action.actionId} style={{ padding: "10px", borderRadius: "10px", border: "1px solid var(--border, #d4e2da)", display: "grid", gap: "8px" }}>
                      <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                        <code>{action.toolRef}</code> · preset <code>{action.preset}</code> · seal <code>{action.seal.slice(0, 14)}…</code>
                      </div>
                      {action.inputSlots.map((slot) => (
                        <label key={slot} style={{ display: "grid", gap: "3px", fontSize: "0.78rem" }}>
                          <code>$input.{slot}</code>
                          <input
                            type="text"
                            placeholder={`Enter ${slot}…`}
                            value={formInputs[action.actionId]?.[slot] ?? ""}
                            onChange={(e) => setFormInputs((prev) => ({
                              ...prev,
                              [action.actionId]: { ...(prev[action.actionId] ?? {}), [slot]: e.target.value },
                            }))}
                            style={{ padding: "6px 8px", borderRadius: "6px", border: "1px solid var(--border, #d4e2da)" }}
                          />
                        </label>
                      ))}
                      <button
                        type="button"
                        className="ui-button ui-button-primary ui-compact-btn"
                        disabled={dispatchingId === action.actionId}
                        onClick={() => void runSealedAction(action)}
                      >
                        {dispatchingId === action.actionId ? "Dispatching…" : action.label}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {dispatchResult && (
                <div style={{ padding: "10px", borderRadius: "10px", background: "var(--surface-alt, #eef5f0)", border: "1px solid var(--border, #d4e2da)", fontSize: "0.78rem" }}>
                  <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: "5px", marginBottom: "6px" }}>
                    <CheckCircle2 size={14} aria-hidden="true" /> Action Outcome: <code>{dispatchResult.result.status}</code>
                  </div>
                  <pre style={{ margin: 0, overflowX: "auto", fontSize: "0.74rem" }}>
                    {JSON.stringify(dispatchResult.result, null, 2)}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
