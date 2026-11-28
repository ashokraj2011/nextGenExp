import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, Database, Eye, EyeOff, Layers, Plus, ShieldCheck, Wrench } from "lucide-react";
import { adminPaths } from "../../packages/contracts/admin-paths";
import { getDomainPack, type DomainPackId } from "../../packages/contracts/domain-packs";
import { api, toolSetupErrorMessage } from "./api";

type DomainWorkbenchData = Awaited<ReturnType<typeof api.domainModels>>;

function prettifyFieldLabel(path: string): string {
  const leaf = path.split(".").at(-1) ?? path;
  return leaf
    .replace(/Cents$/, "")
    .replace(/Pct$/, " (%)")
    .replace(/Ms$/, " (ms)")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (ch) => ch.toUpperCase());
}

export function DomainToolsAndModelPanel({ domainId }: { domainId: DomainPackId }) {
  const [data, setData] = useState<DomainWorkbenchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const pack = getDomainPack(domainId);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const next = await api.domainModels(domainId);
      setData(next);
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setNotice("");
    void refresh();
  }, [domainId]);

  async function toggleSchemaField(toolRef: string, outputPath: string, currentlyExposed: boolean, currentLabel: string) {
    const key = `${toolRef}::${outputPath}`;
    setBusyKey(key);
    setError("");
    setNotice("");
    try {
      const label = currentlyExposed ? currentLabel : prettifyFieldLabel(outputPath);
      await api.setBindingFieldExposure(domainId, {
        toolRef,
        outputPath,
        label,
        exposed: !currentlyExposed,
      });
      await refresh();
      setNotice(
        currentlyExposed
          ? `Removed ${outputPath} from ${pack.shortLabel} data model & UI binding catalog.`
          : `Evolved "${label}" (${toolRef} → ${outputPath}) into ${pack.shortLabel} data model & UI Builder.`,
      );
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <section
      className="admin-card"
      aria-labelledby="domain-tools-model-title"
      style={{ marginTop: "14px", display: "grid", gap: "14px" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "10px" }}>
        <div>
          <h2 id="domain-tools-model-title" style={{ margin: "0 0 4px", display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <Database size={18} aria-hidden="true" />
            {pack.label} · Tools → Schema → Evolved Data Model
          </h2>
          <p style={{ margin: 0, fontSize: "0.88rem", color: "var(--muted)" }}>
            Connect <code>sfield</code> tools to their closed JSON Schemas on the left — toggling fields evolves the canonical <code>smass</code> domain model and <code>sphoton</code> UI Builder catalog on the right.
          </p>
        </div>
        <a
          href={`${adminPaths.builder}?domain=${domainId}`}
          className="secondary-button"
          style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "6px" }}
        >
          <Layers size={14} aria-hidden="true" />
          Design cards in UI Builder
          <ArrowRight size={14} aria-hidden="true" />
        </a>
      </div>

      {error && <p className="admin-error" role="alert">{error}</p>}
      {notice && <p role="status" style={{ margin: 0, fontSize: "0.84rem", color: "var(--teal-dark)", fontWeight: 600 }}>{notice}</p>}

      {loading && !data ? (
        <p className="admin-muted">Loading {pack.shortLabel} tools and evolved data model…</p>
      ) : data ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "16px", alignItems: "start" }}>
          {/* Column 1: Connected sfield Tools & Closed Schemas */}
          <div style={{ display: "grid", gap: "10px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0, fontSize: "0.95rem", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                <Wrench size={15} aria-hidden="true" />
                1. Registered <code>sfield</code> Tools &amp; Schemas ({data.tools.length})
              </h3>
            </div>

            {data.tools.map((tool) => (
              <article
                key={tool.toolRef}
                style={{
                  border: "1px solid var(--border, #d4e2da)",
                  borderRadius: "10px",
                  padding: "12px",
                  background: "var(--surface, #fff)",
                  display: "grid",
                  gap: "8px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                    <code style={{ fontWeight: 700, fontSize: "0.82rem" }}>{tool.toolRef}</code>
                    <span
                      style={{
                        fontSize: "0.7rem",
                        padding: "2px 7px",
                        borderRadius: "999px",
                        fontWeight: 600,
                        background: tool.role === "action" ? "#fef3c7" : "#e4f3ea",
                        color: tool.role === "action" ? "#92400e" : "#155331",
                      }}
                    >
                      {tool.role === "action" ? "Action tool" : "Read tool"}
                    </span>
                  </div>
                  <span style={{ fontSize: "0.72rem", color: "var(--muted)" }} title={`Contract SHA-256: ${tool.contractFingerprint}`}>
                    schema <code>{tool.contractFingerprint.slice(0, 10)}</code>
                  </span>
                </div>
                {tool.description && <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)" }}>{tool.description}</p>}

                {tool.role === "read" && tool.outputFields.length > 0 && (
                  <div style={{ display: "grid", gap: "4px" }}>
                    <span style={{ fontSize: "0.74rem", fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                      Closed Output Schema → Evolve into Data Model
                    </span>
                    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "5px" }}>
                      {tool.outputFields.filter((f) => !f.path.includes("[]")).map((field) => {
                        const key = `${tool.toolRef}::${field.path}`;
                        const isBusy = busyKey === key;
                        return (
                          <li
                            key={field.path}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              gap: "8px",
                              padding: "5px 8px",
                              borderRadius: "7px",
                              background: field.exposed ? "var(--surface-alt, #eef5f0)" : "transparent",
                              border: "1px solid var(--border, #e2ebe6)",
                              fontSize: "0.8rem",
                            }}
                          >
                            <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                              <code>{field.path}</code>
                              <span style={{ fontSize: "0.72rem", color: "var(--muted)" }}>({field.type})</span>
                              {field.exposed && <strong style={{ fontSize: "0.76rem" }}>→ {field.label}</strong>}
                            </span>
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={isBusy}
                              onClick={() => void toggleSchemaField(tool.toolRef, field.path, field.exposed, field.label)}
                              style={{ padding: "3px 8px", fontSize: "0.73rem", display: "inline-flex", alignItems: "center", gap: "4px" }}
                            >
                              {field.exposed ? (
                                <>
                                  <EyeOff size={12} aria-hidden="true" />
                                  {isBusy ? "Updating…" : "Hide"}
                                </>
                              ) : (
                                <>
                                  <Plus size={12} aria-hidden="true" />
                                  {isBusy ? "Adding…" : "Evolve to model"}
                                </>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                {tool.role === "action" && tool.inputFields.length > 0 && (
                  <div style={{ fontSize: "0.78rem", color: "var(--muted)" }}>
                    Inputs:{" "}
                    {tool.inputFields.map((f) => (
                      <code key={f.path} style={{ marginRight: "6px" }}>{f.path}: {f.type}</code>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>

          {/* Column 2: Evolved smass Domain Data Model -> sphoton Catalog */}
          <div style={{ display: "grid", gap: "10px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <h3 style={{ margin: 0, fontSize: "0.95rem", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                <ShieldCheck size={15} aria-hidden="true" />
                2. Evolved <code>smass</code> Domain Data Model ({data.models.length})
              </h3>
              <span style={{ fontSize: "0.74rem", color: "var(--muted)" }}>
                <code>sphoton</code> catalog <code>{data.catalog.catalogFingerprint.slice(0, 10)}</code> · {data.catalog.fields.length} bindable fields
              </span>
            </div>

            {data.models.map((model) => (
              <article
                key={model.id}
                style={{
                  border: "1px solid var(--border, #d4e2da)",
                  borderRadius: "10px",
                  padding: "12px",
                  background: "var(--surface, #fff)",
                  display: "grid",
                  gap: "8px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <div>
                    <strong style={{ fontSize: "0.92rem" }}>{model.label}</strong>{" "}
                    <code style={{ fontSize: "0.78rem" }}>{model.id}@{model.version}</code>
                  </div>
                  <span
                    style={{
                      fontSize: "0.7rem",
                      padding: "2px 8px",
                      borderRadius: "999px",
                      fontWeight: 600,
                      background: model.mode === "tool_backed" ? "#e0f2fe" : "#ede9fe",
                      color: model.mode === "tool_backed" ? "#075985" : "#5b21b6",
                    }}
                  >
                    {model.mode === "tool_backed" ? "Tool-backed (federated)" : "Store-backed (emits tools)"}
                  </span>
                </div>
                {model.description && <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)" }}>{model.description}</p>}

                <div style={{ display: "grid", gap: "4px" }}>
                  <span style={{ fontSize: "0.74rem", fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                    Evolved Entity Fields
                  </span>
                  <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "4px" }}>
                    {model.fields.filter((f) => f.exposed).map((field) => (
                      <li
                        key={`${field.toolRef}:${field.outputPath}`}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: "8px",
                          padding: "5px 8px",
                          borderRadius: "7px",
                          background: "var(--surface-alt, #eef5f0)",
                          fontSize: "0.8rem",
                        }}
                      >
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                          <CheckCircle2 size={13} color="#155331" aria-hidden="true" />
                          <strong>{field.label}</strong>
                          <span style={{ fontSize: "0.74rem", color: "var(--muted)" }}>
                            ← <code>{field.toolRef}</code>.<code>{field.outputPath}</code>
                          </span>
                        </span>
                        <span style={{ display: "inline-flex", gap: "5px", alignItems: "center", fontSize: "0.72rem", color: "var(--muted)" }}>
                          {field.type && <code>{field.type}</code>}
                          {field.format && <span>· {field.format}</span>}
                          <span>· {field.classification}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>

                {model.actions.length > 0 && (
                  <div style={{ display: "grid", gap: "4px" }}>
                    <span style={{ fontSize: "0.74rem", fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                      Bound Domain Actions
                    </span>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                      {model.actions.map((action) => (
                        <span
                          key={action.id}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "5px",
                            fontSize: "0.76rem",
                            padding: "4px 9px",
                            borderRadius: "999px",
                            border: "1px solid var(--border, #d4e2da)",
                            background: "var(--surface, #fff)",
                          }}
                        >
                          <Eye size={12} aria-hidden="true" />
                          <strong>{action.label}</strong>
                          <code>{action.toolRef}</code>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
