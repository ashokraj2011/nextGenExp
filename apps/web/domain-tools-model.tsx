import { useEffect, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Code2,
  Copy,
  Database,
  Eye,
  EyeOff,
  GitBranch,
  KeyRound,
  Layers,
  Link2,
  Plus,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import { adminPaths } from "../../packages/contracts/admin-paths";
import { getDomainPack, type DomainPackId } from "../../packages/contracts/domain-packs";
import type { SmassRelationCardinality } from "../../packages/smass";
import { api, toolSetupErrorMessage } from "./api";

type DomainWorkbenchData = Awaited<ReturnType<typeof api.domainModels>>;
type ModelViewMode = "entities" | "json_schema" | "mermaid_er";

function prettifyFieldLabel(path: string): string {
  const leaf = path.split(".").at(-1) ?? path;
  return leaf
    .replace(/Cents$/, "")
    .replace(/Pct$/, " (%)")
    .replace(/Ms$/, " (ms)")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (ch) => ch.toUpperCase());
}

function cardinalityLabel(cardinality: SmassRelationCardinality): string {
  switch (cardinality) {
    case "one_to_one":
      return "1 : 1";
    case "one_to_many":
      return "1 : N";
    case "many_to_one":
      return "N : 1";
    case "many_to_many":
      return "N : M";
  }
}

export function DomainToolsAndModelPanel({ domainId }: { domainId: DomainPackId }) {
  const [data, setData] = useState<DomainWorkbenchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [viewMode, setViewMode] = useState<ModelViewMode>("entities");
  const [copied, setCopied] = useState(false);
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
    setCopied(false);
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
          ? `Removed ${outputPath} from ${pack.shortLabel} UI binding catalog (remains in closed tool schema).`
          : `Evolved "${label}" (${toolRef} → ${outputPath}) into ${pack.shortLabel} smass data model & UI Builder.`,
      );
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function copyExport(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard failures in restricted environments
    }
  }

  const entities = data?.dataModel?.entities ?? data?.models ?? [];
  const relations = data?.dataModel?.relations ?? [];

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
            {pack.label} · Tools → Schema → Canonical <code>smass</code> Data Model
          </h2>
          <p style={{ margin: 0, fontSize: "0.88rem", color: "var(--muted)" }}>
            Connect <code>sfield</code> tools to their closed JSON Schemas on the left — evolving fields updates the canonical <code>smass</code> entity-relationship data model, Draft 2020-12 JSON Schema, Mermaid ER graph, and <code>sphoton</code> UI catalog on the right.
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
        <p className="admin-muted">Loading {pack.shortLabel} tools and smass data model…</p>
      ) : data ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: "16px", alignItems: "start" }}>
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

          {/* Column 2: Canonical smass Data Model Representation */}
          <div style={{ display: "grid", gap: "10px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <h3 style={{ margin: 0, fontSize: "0.95rem", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                <ShieldCheck size={15} aria-hidden="true" />
                2. <code>smass</code> Data Model ({entities.length} entities · {relations.length} relations)
              </h3>
              <div role="tablist" aria-label="Data model representation" style={{ display: "inline-flex", gap: "4px" }}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === "entities"}
                  className="secondary-button"
                  onClick={() => setViewMode("entities")}
                  style={{
                    padding: "4px 9px",
                    fontSize: "0.74rem",
                    background: viewMode === "entities" ? "var(--teal)" : undefined,
                    color: viewMode === "entities" ? "#fff" : undefined,
                    borderColor: viewMode === "entities" ? "var(--teal)" : undefined,
                  }}
                >
                  Entity Model
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === "mermaid_er"}
                  className="secondary-button"
                  onClick={() => setViewMode("mermaid_er")}
                  style={{
                    padding: "4px 9px",
                    fontSize: "0.74rem",
                    background: viewMode === "mermaid_er" ? "var(--teal)" : undefined,
                    color: viewMode === "mermaid_er" ? "#fff" : undefined,
                    borderColor: viewMode === "mermaid_er" ? "var(--teal)" : undefined,
                  }}
                >
                  Mermaid ER
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === "json_schema"}
                  className="secondary-button"
                  onClick={() => setViewMode("json_schema")}
                  style={{
                    padding: "4px 9px",
                    fontSize: "0.74rem",
                    background: viewMode === "json_schema" ? "var(--teal)" : undefined,
                    color: viewMode === "json_schema" ? "#fff" : undefined,
                    borderColor: viewMode === "json_schema" ? "var(--teal)" : undefined,
                  }}
                >
                  JSON Schema
                </button>
              </div>
            </div>

            <div style={{ fontSize: "0.74rem", color: "var(--muted)" }}>
              <code>sphoton</code> catalog <code>{data.catalog.catalogFingerprint.slice(0, 10)}</code> · {data.catalog.fields.length} UI-bindable fields · {data.catalog.actions.length} bound actions
            </div>

            {viewMode === "entities" && (
              <>
                {relations.length > 0 && (
                  <div
                    style={{
                      border: "1px solid var(--border, #d4e2da)",
                      borderRadius: "10px",
                      padding: "10px 12px",
                      background: "var(--surface-alt, #f4f8f5)",
                      display: "grid",
                      gap: "6px",
                    }}
                  >
                    <span style={{ fontSize: "0.73rem", fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.03em", display: "inline-flex", alignItems: "center", gap: "5px" }}>
                      <Link2 size={13} aria-hidden="true" />
                      Entity Relationships
                    </span>
                    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "4px" }}>
                      {relations.map((rel, idx) => (
                        <li
                          key={`${rel.sourceModelId}:${rel.name}:${rel.targetModelId}:${idx}`}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            flexWrap: "wrap",
                            gap: "6px",
                            fontSize: "0.78rem",
                          }}
                        >
                          <code style={{ fontWeight: 600 }}>{rel.sourceModelId}</code>
                          <span
                            style={{
                              fontSize: "0.68rem",
                              padding: "1px 6px",
                              borderRadius: "999px",
                              background: "#e0e7ff",
                              color: "#3730a3",
                              fontWeight: 700,
                            }}
                          >
                            {cardinalityLabel(rel.cardinality)}
                          </span>
                          <span style={{ color: "var(--muted)" }}>{rel.name}</span>
                          <ArrowRight size={12} aria-hidden="true" />
                          <code style={{ fontWeight: 600 }}>{rel.targetModelId}</code>
                          <span style={{ fontSize: "0.72rem", color: "var(--muted)" }}>
                            ({rel.localField} = {rel.foreignField})
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {entities.map((model) => (
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
                      <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                        <strong style={{ fontSize: "0.92rem" }}>{model.label}</strong>
                        <code style={{ fontSize: "0.78rem" }}>{model.id}@{model.version}</code>
                        {model.primaryKey && (
                          <span
                            style={{
                              fontSize: "0.68rem",
                              padding: "1px 6px",
                              borderRadius: "6px",
                              background: "#fef3c7",
                              color: "#92400e",
                              fontWeight: 700,
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "3px",
                            }}
                          >
                            <KeyRound size={10} aria-hidden="true" />
                            PK: {model.primaryKey}
                          </span>
                        )}
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
                      <span style={{ fontSize: "0.73rem", fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                        Entity Schema ({model.fields.length} attributes)
                      </span>
                      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "4px" }}>
                        {model.fields.map((field) => (
                          <li
                            key={`${model.id}:${field.key}`}
                            style={{
                              display: "grid",
                              gap: "3px",
                              padding: "6px 8px",
                              borderRadius: "7px",
                              background: field.exposed ? "var(--surface-alt, #eef5f0)" : "var(--paper, #f9fbfa)",
                              border: "1px solid var(--border, #e2ebe6)",
                              fontSize: "0.79rem",
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", flexWrap: "wrap" }}>
                                {field.exposed ? (
                                  <CheckCircle2 size={12} color="#155331" aria-hidden="true" />
                                ) : (
                                  <Code2 size={12} color="#64748b" aria-hidden="true" />
                                )}
                                <code style={{ fontWeight: 700 }}>{field.key}</code>
                                {field.primaryKey && (
                                  <span style={{ fontSize: "0.66rem", padding: "1px 5px", borderRadius: "4px", background: "#fef3c7", color: "#92400e", fontWeight: 700 }}>
                                    PK
                                  </span>
                                )}
                                {field.foreignKey && (
                                  <span style={{ fontSize: "0.66rem", padding: "1px 5px", borderRadius: "4px", background: "#e0e7ff", color: "#3730a3", fontWeight: 700 }}>
                                    FK → {field.foreignKey.modelId}.{field.foreignKey.field}
                                  </span>
                                )}
                                {field.principalKey && (
                                  <span style={{ fontSize: "0.66rem", padding: "1px 5px", borderRadius: "4px", background: "#fce7f3", color: "#9d174d", fontWeight: 700 }}>
                                    principal.{field.principalKey}
                                  </span>
                                )}
                                {field.computed && (
                                  <span style={{ fontSize: "0.66rem", padding: "1px 5px", borderRadius: "4px", background: "#f3e8ff", color: "#6b21a8", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: "3px" }}>
                                    <Sparkles size={10} aria-hidden="true" />
                                    computed
                                  </span>
                                )}
                                <span style={{ color: "var(--muted)" }}>{field.label}</span>
                              </span>
                              <span style={{ display: "inline-flex", gap: "5px", alignItems: "center", fontSize: "0.71rem", color: "var(--muted)" }}>
                                {field.type && <code>{field.type}{field.required ? "" : "?"}</code>}
                                {field.format && <span>· {field.format}</span>}
                                <span>· {field.classification}</span>
                                <span>· {field.exposed ? "UI-bound" : "model-only"}</span>
                              </span>
                            </div>
                            {field.toolRef && (
                              <span style={{ fontSize: "0.71rem", color: "var(--muted)" }}>
                                Source: <code>{field.toolRef}</code> → <code>{field.outputPath}</code>
                              </span>
                            )}
                            {field.computed && (
                              <span style={{ fontSize: "0.71rem", color: "#6b21a8" }}>
                                Formula: <code>{field.computed.expression}</code>
                              </span>
                            )}
                            {field.enumValues && field.enumValues.length > 0 && (
                              <span style={{ fontSize: "0.71rem", color: "var(--muted)" }}>
                                Enum: {field.enumValues.map((val) => <code key={val} style={{ marginRight: "4px" }}>{val}</code>)}
                              </span>
                            )}
                            {field.items && (
                              <span style={{ fontSize: "0.71rem", color: "var(--muted)" }}>
                                Item schema:{" "}
                                <code>
                                  {"{ "}
                                  {Object.entries(field.items).map(([k, v]) => `${k}: ${v.type}`).join(", ")}
                                  {" }"}
                                </code>
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>

                    {model.lifecycle && (
                      <div style={{ display: "grid", gap: "4px" }}>
                        <span style={{ fontSize: "0.73rem", fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.03em", display: "inline-flex", alignItems: "center", gap: "5px" }}>
                          <GitBranch size={12} aria-hidden="true" />
                          Lifecycle ({model.lifecycle.stateField})
                        </span>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", alignItems: "center", fontSize: "0.74rem" }}>
                          {model.lifecycle.transitions.map((tr, idx) => (
                            <span
                              key={`${tr.from}-${tr.to}-${idx}`}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px",
                                padding: "3px 8px",
                                borderRadius: "7px",
                                border: "1px solid var(--border, #d4e2da)",
                                background: "var(--paper, #f8faf9)",
                              }}
                            >
                              <code>{tr.from}</code>
                              <ArrowRight size={11} aria-hidden="true" />
                              <code>{tr.to}</code>
                              {tr.actionId && <strong style={{ color: "var(--teal-dark)" }}>({tr.actionId})</strong>}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {model.actions.length > 0 && (
                      <div style={{ display: "grid", gap: "4px" }}>
                        <span style={{ fontSize: "0.73rem", fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.03em" }}>
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
              </>
            )}

            {viewMode === "mermaid_er" && data.dataModel && (
              <div style={{ border: "1px solid var(--border, #d4e2da)", borderRadius: "10px", padding: "12px", background: "var(--surface, #fff)", display: "grid", gap: "8px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong style={{ fontSize: "0.84rem" }}>Canonical Mermaid ER Diagram (compiled by <code>smass</code>)</strong>
                  <button type="button" className="secondary-button" style={{ padding: "3px 8px", fontSize: "0.74rem", display: "inline-flex", alignItems: "center", gap: "4px" }} onClick={() => void copyExport(data.dataModel.mermaidEr)}>
                    <Copy size={12} aria-hidden="true" />
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre style={{ margin: 0, padding: "10px", borderRadius: "8px", background: "#0f172a", color: "#e2e8f0", fontSize: "0.75rem", overflowX: "auto", lineHeight: 1.5 }}>
                  {data.dataModel.mermaidEr}
                </pre>
              </div>
            )}

            {viewMode === "json_schema" && data.dataModel && (
              <div style={{ border: "1px solid var(--border, #d4e2da)", borderRadius: "10px", padding: "12px", background: "var(--surface, #fff)", display: "grid", gap: "8px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong style={{ fontSize: "0.84rem" }}>Draft 2020-12 JSON Schema <code>$defs</code> (compiled by <code>smass</code>)</strong>
                  <button type="button" className="secondary-button" style={{ padding: "3px 8px", fontSize: "0.74rem", display: "inline-flex", alignItems: "center", gap: "4px" }} onClick={() => void copyExport(JSON.stringify(data.dataModel.jsonSchema, null, 2))}>
                    <Copy size={12} aria-hidden="true" />
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre style={{ margin: 0, padding: "10px", borderRadius: "8px", background: "#0f172a", color: "#e2e8f0", fontSize: "0.74rem", overflowX: "auto", maxHeight: "520px", lineHeight: 1.45 }}>
                  {JSON.stringify(data.dataModel.jsonSchema, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
