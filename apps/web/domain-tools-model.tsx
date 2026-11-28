import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Code2,
  Copy,
  Database,
  Eye,
  EyeOff,
  GitBranch,
  GripVertical,
  KeyRound,
  Layers,
  Link2,
  Pencil,
  Play,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { adminPaths } from "../../packages/contracts/admin-paths";
import { getDomainPack, type DomainPackId } from "../../packages/contracts/domain-packs";
import type {
  SmassClassification,
  SmassFieldFormat,
  SmassFieldType,
  SmassRelationCardinality,
  SmassVirtualSnapshotResult,
} from "../../packages/smass";
import { api, toolSetupErrorMessage } from "./api";

type DomainWorkbenchData = Awaited<ReturnType<typeof api.domainModels>>;
type ModelViewMode = "entities" | "builder" | "mermaid_er" | "json_schema";

type DraftMappedField = {
  kind: "mapped";
  uid: string;
  key: string;
  label: string;
  toolRef: string;
  outputPath: string;
  type: string;
  format?: SmassFieldFormat;
  classification: SmassClassification;
  required: boolean;
  exposed: boolean;
};

type DraftComputedField = {
  kind: "computed";
  uid: string;
  key: string;
  label: string;
  expression: string;
  dependsOn: string[];
  type: SmassFieldType;
  format?: SmassFieldFormat;
  classification: SmassClassification;
  exposed: boolean;
};

type DraftField = DraftMappedField | DraftComputedField;

type DragPayload =
  | { kind: "field"; toolRef: string; outputPath: string; type: string; label: string; format?: SmassFieldFormat }
  | {
      kind: "tool";
      toolRef: string;
      fields: Array<{ outputPath: string; type: string; label: string; format?: SmassFieldFormat }>;
    };

const DRAG_MIME = "application/x-smass-schema";

function prettifyFieldLabel(path: string): string {
  const leaf = path.split(".").at(-1) ?? path;
  return leaf
    .replace(/Cents$/, "")
    .replace(/Pct$/, " (%)")
    .replace(/Ms$/, " (ms)")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (ch) => ch.toUpperCase());
}

function sanitizeFieldKey(path: string): string {
  const leaf = path.split(".").at(-1) ?? path;
  const cleaned = leaf.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[^a-zA-Z_]+/, "");
  return cleaned || "field";
}

function slugifyModelId(domainId: DomainPackId, label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
  return `${domainId}.${slug || "virtual_model"}`;
}

function inferFormat(path: string, type: string): SmassFieldFormat | undefined {
  const lower = path.toLowerCase();
  if ((type === "integer" || type === "number") && lower.endsWith("cents")) return "currency_cents";
  if ((type === "integer" || type === "number") && (lower.includes("pct") || lower.includes("percent") || lower.includes("rate"))) return "percent";
  if (lower.includes("date") || lower === "asof") return "date";
  if (lower.includes("month")) return "month";
  return undefined;
}

function inferDependsOn(expression: string, knownKeys: readonly string[]): string[] {
  const keySet = new Set(knownKeys);
  const found = new Set<string>();
  for (const match of expression.matchAll(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g)) {
    const token = match[0];
    if (keySet.has(token)) found.add(token);
  }
  return [...found];
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

  // Drag-and-drop Virtual Model Builder state
  const [draftLabel, setDraftLabel] = useState("Customer Summary VDM");
  const [draftId, setDraftId] = useState(() => slugifyModelId(domainId, "Customer Summary VDM"));
  const [idManuallyEdited, setIdManuallyEdited] = useState(false);
  const [draftDescription, setDraftDescription] = useState("Federated virtual model composed from tool JSON Schemas.");
  const [draftPrincipalKey, setDraftPrincipalKey] = useState(domainId === "wealth" ? "mid" : "");
  const [draftFields, setDraftFields] = useState<DraftField[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const activeDragRef = useRef<DragPayload | null>(null);

  // Computed field inline composer state
  const [showComputedForm, setShowComputedForm] = useState(false);
  const [compKey, setCompKey] = useState("");
  const [compLabel, setCompLabel] = useState("");
  const [compExpr, setCompExpr] = useState("");
  const [compType, setCompType] = useState<SmassFieldType>("integer");

  // Live VDM snapshot test state
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const [testRedactPii, setTestRedactPii] = useState(false);
  const [snapshotResults, setSnapshotResults] = useState<Record<string, SmassVirtualSnapshotResult>>({});

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
    setDraftFields([]);
    setDraftLabel(`${pack.shortLabel} Virtual View`);
    setDraftId(slugifyModelId(domainId, `${pack.shortLabel} Virtual View`));
    setIdManuallyEdited(false);
    setDraftPrincipalKey(domainId === "wealth" ? "mid" : "");
    setSnapshotResults({});
    void refresh();
  }, [domainId]);

  const customModelIdSet = useMemo(() => new Set(data?.customModelIds ?? []), [data?.customModelIds]);
  const droppedSourceKeys = useMemo(
    () =>
      new Set(
        draftFields
          .filter((f): f is DraftMappedField => f.kind === "mapped")
          .map((f) => `${f.toolRef}::${f.outputPath}`),
      ),
    [draftFields],
  );
  const federatedTools = useMemo(
    () =>
      [...new Set(draftFields.filter((f): f is DraftMappedField => f.kind === "mapped").map((f) => f.toolRef))],
    [draftFields],
  );

  function addFieldsToDraft(
    items: Array<{ toolRef: string; outputPath: string; type: string; label?: string; format?: SmassFieldFormat }>,
  ) {
    setDraftFields((prev) => {
      const next = [...prev];
      const usedKeys = new Set(next.map((f) => f.key));
      const existingSources = new Set(
        next
          .filter((f): f is DraftMappedField => f.kind === "mapped")
          .map((f) => `${f.toolRef}::${f.outputPath}`),
      );
      let addedCount = 0;

      for (const item of items) {
        const sourceKey = `${item.toolRef}::${item.outputPath}`;
        if (existingSources.has(sourceKey)) continue;
        existingSources.add(sourceKey);

        const baseKey = sanitizeFieldKey(item.outputPath);
        let key = baseKey;
        let idx = 2;
        while (usedKeys.has(key)) key = `${baseKey}_${idx++}`;
        usedKeys.add(key);

        next.push({
          kind: "mapped",
          uid: `${sourceKey}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
          key,
          label: item.label && item.label !== item.outputPath ? item.label : prettifyFieldLabel(item.outputPath),
          toolRef: item.toolRef,
          outputPath: item.outputPath,
          type: item.type,
          format: item.format ?? inferFormat(item.outputPath, item.type),
          classification: /email|ssn|phone|address|name/i.test(item.outputPath) ? "pii" : "internal",
          required: false,
          exposed: true,
        });
        addedCount++;
      }

      if (addedCount > 0) {
        setViewMode("builder");
      }
      return next;
    });
  }

  function handleFieldDragStart(
    e: DragEvent<HTMLElement>,
    toolRef: string,
    field: { path: string; type: string; label: string; format?: SmassFieldFormat },
  ) {
    const payload: DragPayload = {
      kind: "field",
      toolRef,
      outputPath: field.path,
      type: field.type,
      label: field.label,
      format: field.format,
    };
    activeDragRef.current = payload;
    const serialized = JSON.stringify(payload);
    e.dataTransfer.setData(DRAG_MIME, serialized);
    e.dataTransfer.setData("text/plain", serialized);
    e.dataTransfer.effectAllowed = "copy";
  }

  function handleToolDragStart(
    e: DragEvent<HTMLElement>,
    toolRef: string,
    outputFields: Array<{ path: string; type: string; label: string; format?: SmassFieldFormat }>,
  ) {
    const payload: DragPayload = {
      kind: "tool",
      toolRef,
      fields: outputFields
        .filter((f) => !f.path.includes("[]"))
        .map((f) => ({ outputPath: f.path, type: f.type, label: f.label, format: f.format })),
    };
    activeDragRef.current = payload;
    const serialized = JSON.stringify(payload);
    e.dataTransfer.setData(DRAG_MIME, serialized);
    e.dataTransfer.setData("text/plain", serialized);
    e.dataTransfer.effectAllowed = "copy";
  }

  function handleCanvasDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!isDragOver) setIsDragOver(true);
  }

  function handleCanvasDragLeave(e: DragEvent<HTMLDivElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDragOver(false);
  }

  function handleCanvasDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    let parsed: DragPayload | null = null;
    const raw = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData("text/plain");
    if (raw) {
      try {
        parsed = JSON.parse(raw) as DragPayload;
      } catch {
        parsed = null;
      }
    }
    if (!parsed) parsed = activeDragRef.current;
    activeDragRef.current = null;
    if (!parsed) return;
    if (parsed.kind === "field") {
      addFieldsToDraft([
        {
          toolRef: parsed.toolRef,
          outputPath: parsed.outputPath,
          type: parsed.type,
          label: parsed.label,
          format: parsed.format,
        },
      ]);
    } else if (parsed.kind === "tool") {
      addFieldsToDraft(
        parsed.fields.map((f) => ({
          toolRef: parsed.toolRef,
          outputPath: f.outputPath,
          type: f.type,
          label: f.label,
          format: f.format,
        })),
      );
    }
  }

  function addComputedFieldToDraft() {
    const cleanKey = sanitizeFieldKey(compKey);
    const cleanExpr = compExpr.trim();
    if (!cleanKey || !cleanExpr) {
      setError("Provide both a field key and an arithmetic formula for the computed field.");
      return;
    }
    const existingKeys = draftFields.map((f) => f.key);
    const dependsOn = inferDependsOn(cleanExpr, existingKeys);
    if (dependsOn.length === 0) {
      setError(`Formula must reference at least one dropped field key (${existingKeys.join(", ") || "drop fields first"}).`);
      return;
    }
    setError("");
    setDraftFields((prev) => [
      ...prev,
      {
        kind: "computed",
        uid: `comp:${cleanKey}:${Date.now()}`,
        key: cleanKey,
        label: compLabel.trim() || prettifyFieldLabel(cleanKey),
        expression: cleanExpr,
        dependsOn,
        type: compType,
        format: inferFormat(cleanKey, compType),
        classification: "internal",
        exposed: true,
      },
    ]);
    setCompKey("");
    setCompLabel("");
    setCompExpr("");
    setShowComputedForm(false);
  }

  async function saveVirtualModel() {
    if (!draftFields.length) {
      setError("Drag and drop at least one field from the tool JSON Schemas on the left before saving.");
      return;
    }
    setSavingModel(true);
    setError("");
    setNotice("");
    try {
      const next = await api.saveDomainModel(domainId, {
        id: draftId.trim(),
        version: "1.0.0",
        label: draftLabel.trim(),
        ...(draftDescription.trim() ? { description: draftDescription.trim() } : {}),
        ...(draftPrincipalKey.trim() ? { principalKey: draftPrincipalKey.trim(), primaryKey: draftPrincipalKey.trim() } : {}),
        fields: draftFields.map((f) =>
          f.kind === "computed"
            ? {
                kind: "computed" as const,
                key: f.key,
                label: f.label,
                expression: f.expression,
                dependsOn: f.dependsOn,
                type: f.type,
                ...(f.format ? { format: f.format } : {}),
                classification: f.classification,
                exposed: f.exposed,
              }
            : {
                kind: "mapped" as const,
                key: f.key,
                label: f.label,
                toolRef: f.toolRef,
                outputPath: f.outputPath,
                ...(f.format ? { format: f.format } : {}),
                classification: f.classification,
                required: f.required,
                exposed: f.exposed,
              },
        ),
      });
      setData(next);
      setViewMode("entities");
      setNotice(`Saved Virtual Data Model "${draftLabel.trim()}" (${draftId.trim()}) — compiled into smass ER graph, Draft 2020-12 JSON Schema & sphoton catalog.`);
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setSavingModel(false);
    }
  }

  function loadCustomModelIntoBuilder(modelId: string) {
    const found = data?.customModels?.find((m) => m.id === modelId);
    if (!found) return;
    setDraftId(found.id);
    setDraftLabel(found.label);
    setIdManuallyEdited(true);
    setDraftDescription(found.description ?? "");
    setDraftPrincipalKey(found.principalKey ?? "");
    setDraftFields(
      found.fields.map((f, idx) =>
        f.kind === "computed"
          ? {
              kind: "computed",
              uid: `edit:${f.key}:${idx}`,
              key: f.key,
              label: f.label,
              expression: f.expression,
              dependsOn: f.dependsOn,
              type: f.type,
              format: f.format,
              classification: f.classification,
              exposed: f.exposed,
            }
          : {
              kind: "mapped",
              uid: `edit:${f.toolRef}:${f.outputPath}:${idx}`,
              key: f.key,
              label: f.label,
              toolRef: f.toolRef,
              outputPath: f.outputPath,
              type: "string",
              format: f.format,
              classification: f.classification,
              required: f.required,
              exposed: f.exposed,
            },
      ),
    );
    setViewMode("builder");
    setNotice(`Loaded "${found.label}" into Virtual Model Builder. Drag additional fields from the left or edit mappings.`);
  }

  async function deleteCustomModel(modelId: string) {
    setError("");
    setNotice("");
    try {
      const next = await api.deleteDomainModel(domainId, modelId);
      setData(next);
      setSnapshotResults((prev) => {
        const copy = { ...prev };
        delete copy[modelId];
        return copy;
      });
      setNotice(`Deleted custom virtual model "${modelId}".`);
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    }
  }

  async function runLiveSnapshotTest(modelId: string, redactPii = testRedactPii) {
    setTestingModelId(modelId);
    setError("");
    try {
      const { snapshot } = await api.testDomainModelSnapshot(domainId, {
        modelId,
        redactPii,
      });
      setSnapshotResults((prev) => ({ ...prev, [modelId]: snapshot }));
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setTestingModelId(null);
    }
  }

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
            {pack.label} · Tools → Schema → Canonical <code>smass</code> Virtual Data Model
          </h2>
          <p style={{ margin: 0, fontSize: "0.88rem", color: "var(--muted)" }}>
            Drag &amp; drop closed JSON Schema fields from any <code>sfield</code> tool on the left into the <strong>Virtual Builder</strong> on the right to compose federated <code>smass</code> virtual models, compute derived fields, and test live 1× snapshots.
          </p>
        </div>
        <div style={{ display: "inline-flex", gap: "8px", flexWrap: "wrap" }}>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setViewMode("builder")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "7px 14px",
              fontSize: "0.82rem",
              background: "var(--teal)",
              color: "#fff",
              borderColor: "var(--teal)",
              fontWeight: 600,
            }}
          >
            <Sparkles size={14} aria-hidden="true" />
            Build Virtual Model (Drag &amp; Drop)
          </button>
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
      </div>

      {error && <p className="admin-error" role="alert">{error}</p>}
      {notice && <p role="status" style={{ margin: 0, fontSize: "0.84rem", color: "var(--teal-dark)", fontWeight: 600 }}>{notice}</p>}

      {loading && !data ? (
        <p className="admin-muted">Loading {pack.shortLabel} tools and smass data model…</p>
      ) : data ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: "16px", alignItems: "start" }}>
          {/* Column 1: Connected sfield Tools & Draggable Closed JSON Schemas */}
          <div style={{ display: "grid", gap: "10px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <h3 style={{ margin: 0, fontSize: "0.95rem", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                <Wrench size={15} aria-hidden="true" />
                1. Tool JSON Schemas ({data.tools.length})
              </h3>
              <span style={{ fontSize: "0.74rem", color: "var(--muted)" }}>
                Drag any field or tool → Virtual Builder
              </span>
            </div>

            {data.tools.map((tool) => {
              const selectableFields = tool.outputFields.filter((f) => !f.path.includes("[]"));
              return (
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
                    <div
                      draggable={tool.role === "read" && selectableFields.length > 0}
                      onDragStart={(e) => handleToolDragStart(e, tool.toolRef, selectableFields)}
                      title={tool.role === "read" ? "Drag entire tool schema into Virtual Model Builder" : undefined}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        flexWrap: "wrap",
                        cursor: tool.role === "read" && selectableFields.length > 0 ? "grab" : "default",
                      }}
                    >
                      {tool.role === "read" && selectableFields.length > 0 && (
                        <GripVertical size={14} color="#64748b" aria-hidden="true" />
                      )}
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
                    <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      {tool.role === "read" && selectableFields.length > 0 && (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() =>
                            addFieldsToDraft(
                              selectableFields.map((f) => ({
                                toolRef: tool.toolRef,
                                outputPath: f.path,
                                type: f.type,
                                label: f.label,
                                format: f.format,
                              })),
                            )
                          }
                          style={{ padding: "2px 7px", fontSize: "0.7rem", display: "inline-flex", alignItems: "center", gap: "3px" }}
                        >
                          <Plus size={11} aria-hidden="true" />
                          Add all
                        </button>
                      )}
                      <span style={{ fontSize: "0.72rem", color: "var(--muted)" }} title={`Contract SHA-256: ${tool.contractFingerprint}`}>
                        <code>{tool.contractFingerprint.slice(0, 8)}</code>
                      </span>
                    </div>
                  </div>
                  {tool.description && <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)" }}>{tool.description}</p>}

                  {tool.role === "read" && selectableFields.length > 0 && (
                    <div style={{ display: "grid", gap: "4px" }}>
                      <span style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                        Closed Output JSON Schema (draggable)
                      </span>
                      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "5px" }}>
                        {selectableFields.map((field) => {
                          const key = `${tool.toolRef}::${field.path}`;
                          const isBusy = busyKey === key;
                          const inDraft = droppedSourceKeys.has(key);
                          return (
                            <li
                              key={field.path}
                              draggable
                              data-schema-drag={`${tool.toolRef}:${field.path}`}
                              onDragStart={(e) => handleFieldDragStart(e, tool.toolRef, field)}
                              title="Drag this JSON Schema field into the Virtual Model Builder"
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                gap: "8px",
                                padding: "5px 8px",
                                borderRadius: "7px",
                                cursor: "grab",
                                background: inDraft
                                  ? "#e8f5ee"
                                  : field.exposed
                                    ? "var(--surface-alt, #eef5f0)"
                                    : "transparent",
                                border: inDraft
                                  ? "1px solid #2e7d52"
                                  : "1px solid var(--border, #e2ebe6)",
                                fontSize: "0.8rem",
                              }}
                            >
                              <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap", minWidth: 0 }}>
                                <GripVertical size={13} color="#64748b" aria-hidden="true" />
                                <code>{field.path}</code>
                                <span style={{ fontSize: "0.71rem", color: "var(--muted)" }}>({field.type})</span>
                                {field.exposed && <strong style={{ fontSize: "0.75rem" }}>→ {field.label}</strong>}
                              </span>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
                                <button
                                  type="button"
                                  className="secondary-button"
                                  disabled={inDraft}
                                  onClick={() =>
                                    addFieldsToDraft([
                                      {
                                        toolRef: tool.toolRef,
                                        outputPath: field.path,
                                        type: field.type,
                                        label: field.label,
                                        format: field.format,
                                      },
                                    ])
                                  }
                                  style={{
                                    padding: "3px 7px",
                                    fontSize: "0.71rem",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "3px",
                                    color: inDraft ? "#155331" : undefined,
                                    borderColor: inDraft ? "#86efac" : undefined,
                                  }}
                                >
                                  {inDraft ? (
                                    <>
                                      <CheckCircle2 size={11} aria-hidden="true" />
                                      In model
                                    </>
                                  ) : (
                                    <>
                                      <Plus size={11} aria-hidden="true" />
                                      Map
                                    </>
                                  )}
                                </button>
                                <button
                                  type="button"
                                  className="secondary-button"
                                  disabled={isBusy}
                                  onClick={() => void toggleSchemaField(tool.toolRef, field.path, field.exposed, field.label)}
                                  style={{ padding: "3px 7px", fontSize: "0.71rem", display: "inline-flex", alignItems: "center", gap: "3px" }}
                                >
                                  {field.exposed ? (
                                    <>
                                      <EyeOff size={11} aria-hidden="true" />
                                      {isBusy ? "…" : "Hide"}
                                    </>
                                  ) : (
                                    <>
                                      <Plus size={11} aria-hidden="true" />
                                      {isBusy ? "…" : "Evolve"}
                                    </>
                                  )}
                                </button>
                              </span>
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
              );
            })}
          </div>

          {/* Column 2: Canonical smass Data Model & Drag-and-Drop Virtual Model Builder */}
          <div style={{ display: "grid", gap: "10px", position: viewMode === "builder" ? "sticky" : undefined, top: viewMode === "builder" ? "16px" : undefined }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <h3 style={{ margin: 0, fontSize: "0.95rem", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                <ShieldCheck size={15} aria-hidden="true" />
                2. <code>smass</code> Data Model ({entities.length} entities · {relations.length} relations)
              </h3>
              <div role="tablist" aria-label="Data model representation" style={{ display: "inline-flex", gap: "4px", flexWrap: "wrap" }}>
                {(
                  [
                    ["entities", "Entity Model"],
                    ["builder", `Virtual Builder${draftFields.length ? ` (${draftFields.length})` : ""}`],
                    ["mermaid_er", "Mermaid ER"],
                    ["json_schema", "JSON Schema"],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    role="tab"
                    aria-selected={viewMode === mode}
                    className="secondary-button"
                    onClick={() => setViewMode(mode)}
                    style={{
                      padding: "4px 9px",
                      fontSize: "0.74rem",
                      background: viewMode === mode ? "var(--teal)" : undefined,
                      color: viewMode === mode ? "#fff" : undefined,
                      borderColor: viewMode === mode ? "var(--teal)" : undefined,
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ fontSize: "0.74rem", color: "var(--muted)" }}>
              <code>sphoton</code> catalog <code>{data.catalog.catalogFingerprint.slice(0, 10)}</code> · {data.catalog.fields.length} UI-bindable fields · {data.catalog.actions.length} bound actions
            </div>

            {/* Virtual Model Drag-and-Drop Builder View */}
            {viewMode === "builder" && (
              <div
                style={{
                  border: "1px solid var(--border, #c7dfd0)",
                  borderRadius: "12px",
                  padding: "14px",
                  background: "var(--surface, #fff)",
                  display: "grid",
                  gap: "12px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <div>
                    <strong style={{ fontSize: "0.92rem", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <Sparkles size={15} color="#155331" aria-hidden="true" />
                      Drag-and-Drop Virtual Model Composer
                    </strong>
                    <p style={{ margin: "2px 0 0", fontSize: "0.78rem", color: "var(--muted)" }}>
                      Compose one federated <code>smass</code> entity across multiple tool JSON Schemas.
                    </p>
                  </div>
                  {draftFields.length > 0 && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setDraftFields([])}
                      style={{ padding: "4px 8px", fontSize: "0.73rem" }}
                    >
                      Clear fields
                    </button>
                  )}
                </div>

                {/* Model Metadata */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                  <label style={{ display: "grid", gap: "3px", fontSize: "0.76rem", fontWeight: 600 }}>
                    Model name
                    <input
                      type="text"
                      value={draftLabel}
                      onChange={(e) => {
                        const val = e.target.value;
                        setDraftLabel(val);
                        if (!idManuallyEdited) setDraftId(slugifyModelId(domainId, val));
                      }}
                      placeholder="e.g. Advisor Brief"
                      style={{ padding: "6px 8px", borderRadius: "7px", border: "1px solid var(--border, #cbd5e1)", fontSize: "0.82rem" }}
                    />
                  </label>
                  <label style={{ display: "grid", gap: "3px", fontSize: "0.76rem", fontWeight: 600 }}>
                    Model ID (smass)
                    <input
                      type="text"
                      value={draftId}
                      onChange={(e) => {
                        setDraftId(e.target.value);
                        setIdManuallyEdited(true);
                      }}
                      placeholder={`${domainId}.advisor_brief`}
                      style={{ padding: "6px 8px", borderRadius: "7px", border: "1px solid var(--border, #cbd5e1)", fontSize: "0.82rem", fontFamily: "monospace" }}
                    />
                  </label>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "8px" }}>
                  <label style={{ display: "grid", gap: "3px", fontSize: "0.76rem", fontWeight: 600 }}>
                    Description
                    <input
                      type="text"
                      value={draftDescription}
                      onChange={(e) => setDraftDescription(e.target.value)}
                      placeholder="What does this virtual entity represent?"
                      style={{ padding: "6px 8px", borderRadius: "7px", border: "1px solid var(--border, #cbd5e1)", fontSize: "0.82rem" }}
                    />
                  </label>
                  <label style={{ display: "grid", gap: "3px", fontSize: "0.76rem", fontWeight: 600 }}>
                    Principal Join Key (optional)
                    <input
                      type="text"
                      value={draftPrincipalKey}
                      onChange={(e) => setDraftPrincipalKey(e.target.value)}
                      placeholder="e.g. mid"
                      style={{ padding: "6px 8px", borderRadius: "7px", border: "1px solid var(--border, #cbd5e1)", fontSize: "0.82rem", fontFamily: "monospace" }}
                    />
                  </label>
                </div>

                {/* Interactive Drag-and-Drop Canvas */}
                <div
                  role="region"
                  aria-label="Virtual model schema drop zone"
                  data-testid="smass-vdm-dropzone"
                  onDragOver={handleCanvasDragOver}
                  onDragLeave={handleCanvasDragLeave}
                  onDrop={handleCanvasDrop}
                  style={{
                    border: isDragOver ? "2px dashed #15803d" : "2px dashed #94b8a4",
                    borderRadius: "10px",
                    padding: draftFields.length ? "10px" : "24px 14px",
                    background: isDragOver ? "#e6f6ec" : "var(--paper, #f7fbf8)",
                    transition: "background 120ms ease, border-color 120ms ease",
                    display: "grid",
                    gap: "8px",
                  }}
                >
                  {draftFields.length === 0 ? (
                    <div style={{ textAlign: "center", color: "var(--muted)", display: "grid", gap: "5px", justifyItems: "center" }}>
                      <Database size={22} color={isDragOver ? "#15803d" : "#64748b"} aria-hidden="true" />
                      <strong style={{ fontSize: "0.86rem", color: isDragOver ? "#155331" : "inherit" }}>
                        {isDragOver
                          ? "Release to map field into Virtual Model"
                          : "Drop JSON Schema fields (or an entire tool) from the left here"}
                      </strong>
                      <span style={{ fontSize: "0.76rem" }}>
                        You can mix fields from multiple tools — <code>smass</code> automatically federates them into one closed-schema 1× snapshot.
                      </span>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.74rem", color: "#155331", fontWeight: 600 }}>
                        <span>
                          Federates {federatedTools.length} tool{federatedTools.length === 1 ? "" : "s"} · {draftFields.length} virtual field{draftFields.length === 1 ? "" : "s"}
                        </span>
                        <span style={{ color: "var(--muted)", fontWeight: 500 }}>
                          {isDragOver ? "Drop to append field…" : "Drag more fields here to expand"}
                        </span>
                      </div>
                      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "6px" }}>
                        {draftFields.map((field, index) => (
                          <li
                            key={field.uid}
                            style={{
                              padding: "8px 10px",
                              borderRadius: "8px",
                              background: "#fff",
                              border: field.kind === "computed" ? "1px solid #d8b4fe" : "1px solid var(--border, #d4e2da)",
                              display: "grid",
                              gap: "6px",
                              fontSize: "0.79rem",
                            }}
                          >
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto auto", gap: "6px", alignItems: "center" }}>
                              <input
                                type="text"
                                aria-label={`Canonical key for field ${index + 1}`}
                                value={field.key}
                                onChange={(e) => {
                                  const key = e.target.value;
                                  setDraftFields((prev) => prev.map((f, i) => (i === index ? { ...f, key } : f)));
                                }}
                                style={{ padding: "4px 6px", borderRadius: "6px", border: "1px solid var(--border, #cbd5e1)", fontFamily: "monospace", fontSize: "0.78rem", fontWeight: 700 }}
                              />
                              <input
                                type="text"
                                aria-label={`Display label for field ${index + 1}`}
                                value={field.label}
                                onChange={(e) => {
                                  const label = e.target.value;
                                  setDraftFields((prev) => prev.map((f, i) => (i === index ? { ...f, label } : f)));
                                }}
                                style={{ padding: "4px 6px", borderRadius: "6px", border: "1px solid var(--border, #cbd5e1)", fontSize: "0.78rem" }}
                              />
                              <select
                                aria-label={`Classification for ${field.key}`}
                                value={field.classification}
                                onChange={(e) => {
                                  const classification = e.target.value as SmassClassification;
                                  setDraftFields((prev) => prev.map((f, i) => (i === index ? { ...f, classification } : f)));
                                }}
                                style={{ padding: "4px 6px", borderRadius: "6px", border: "1px solid var(--border, #cbd5e1)", fontSize: "0.74rem" }}
                              >
                                <option value="internal">internal</option>
                                <option value="confidential">confidential</option>
                                <option value="pii">pii</option>
                                <option value="public">public</option>
                              </select>
                              <button
                                type="button"
                                className="secondary-button"
                                aria-label={`Remove ${field.key}`}
                                onClick={() => setDraftFields((prev) => prev.filter((_, i) => i !== index))}
                                style={{ padding: "4px", display: "inline-flex" }}
                              >
                                <X size={13} aria-hidden="true" />
                              </button>
                            </div>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap", fontSize: "0.72rem", color: "var(--muted)" }}>
                              {field.kind === "mapped" ? (
                                <span>
                                  Source: <code>{field.toolRef}</code> → <code>{field.outputPath}</code> ({field.type})
                                </span>
                              ) : (
                                <span style={{ color: "#6b21a8" }}>
                                  Computed: <code>{field.expression}</code> (deps: {field.dependsOn.join(", ")})
                                </span>
                              )}
                              <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", cursor: "pointer" }}>
                                <input
                                  type="checkbox"
                                  checked={field.exposed}
                                  onChange={(e) => {
                                    const exposed = e.target.checked;
                                    setDraftFields((prev) => prev.map((f, i) => (i === index ? { ...f, exposed } : f)));
                                  }}
                                />
                                UI-bindable
                              </label>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>

                {/* Add Computed Field inline drawer */}
                {showComputedForm ? (
                  <div
                    style={{
                      border: "1px solid #d8b4fe",
                      borderRadius: "8px",
                      padding: "10px",
                      background: "#faf5ff",
                      display: "grid",
                      gap: "8px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <strong style={{ fontSize: "0.8rem", color: "#6b21a8" }}>Add Deterministic Computed Field</strong>
                      <button type="button" className="secondary-button" style={{ padding: "2px 6px", fontSize: "0.72rem" }} onClick={() => setShowComputedForm(false)}>
                        Cancel
                      </button>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 110px", gap: "6px" }}>
                      <input
                        type="text"
                        value={compKey}
                        onChange={(e) => setCompKey(e.target.value)}
                        placeholder="Field key (e.g. excessCashCents)"
                        style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #d8b4fe", fontFamily: "monospace", fontSize: "0.78rem" }}
                      />
                      <input
                        type="text"
                        value={compLabel}
                        onChange={(e) => setCompLabel(e.target.value)}
                        placeholder="Label (e.g. Excess Cash)"
                        style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #d8b4fe", fontSize: "0.78rem" }}
                      />
                      <select
                        value={compType}
                        onChange={(e) => setCompType(e.target.value as SmassFieldType)}
                        style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #d8b4fe", fontSize: "0.78rem" }}
                      >
                        <option value="integer">integer</option>
                        <option value="number">number</option>
                      </select>
                    </div>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <input
                        type="text"
                        value={compExpr}
                        onChange={(e) => setCompExpr(e.target.value)}
                        placeholder={`Formula using dropped keys (e.g. ${draftFields.slice(0, 2).map((f) => f.key).join(" - ") || "cashCents - availableCents"})`}
                        style={{ flex: 1, padding: "5px 7px", borderRadius: "6px", border: "1px solid #d8b4fe", fontFamily: "monospace", fontSize: "0.78rem" }}
                      />
                      <button type="button" className="primary-button" onClick={addComputedFieldToDraft} style={{ padding: "5px 10px", fontSize: "0.76rem" }}>
                        Add formula
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={draftFields.length === 0}
                      onClick={() => setShowComputedForm(true)}
                      style={{ padding: "5px 10px", fontSize: "0.76rem", display: "inline-flex", alignItems: "center", gap: "5px" }}
                    >
                      <Sparkles size={13} aria-hidden="true" />
                      + Add computed field
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={savingModel || draftFields.length === 0}
                      onClick={() => void saveVirtualModel()}
                      style={{
                        padding: "7px 14px",
                        fontSize: "0.82rem",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        background: draftFields.length > 0 ? "var(--teal)" : undefined,
                        color: draftFields.length > 0 ? "#fff" : undefined,
                        borderColor: draftFields.length > 0 ? "var(--teal)" : undefined,
                        fontWeight: 600,
                      }}
                    >
                      <CheckCircle2 size={14} aria-hidden="true" />
                      {savingModel ? "Saving & Compiling…" : "Save Virtual Model"}
                    </button>
                  </div>
                )}
              </div>
            )}

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

                {entities.map((model) => {
                  const isCustom = customModelIdSet.has(model.id);
                  const liveSnap = snapshotResults[model.id];
                  return (
                    <article
                      key={model.id}
                      style={{
                        border: isCustom ? "1px solid #86efac" : "1px solid var(--border, #d4e2da)",
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
                          {isCustom && (
                            <span
                              style={{
                                fontSize: "0.68rem",
                                padding: "2px 7px",
                                borderRadius: "999px",
                                background: "#dcfce7",
                                color: "#155331",
                                fontWeight: 700,
                              }}
                            >
                              Virtual VDM
                            </span>
                          )}
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
                        <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
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
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={testingModelId === model.id}
                            onClick={() => void runLiveSnapshotTest(model.id)}
                            style={{ padding: "3px 8px", fontSize: "0.71rem", display: "inline-flex", alignItems: "center", gap: "4px" }}
                          >
                            <Play size={11} aria-hidden="true" />
                            {testingModelId === model.id ? "Materializing…" : "Test 1× Snapshot"}
                          </button>
                          {isCustom && (
                            <>
                              <button
                                type="button"
                                className="secondary-button"
                                onClick={() => loadCustomModelIntoBuilder(model.id)}
                                style={{ padding: "3px 7px", fontSize: "0.71rem", display: "inline-flex", alignItems: "center", gap: "3px" }}
                              >
                                <Pencil size={11} aria-hidden="true" />
                                Edit
                              </button>
                              <button
                                type="button"
                                className="secondary-button"
                                onClick={() => void deleteCustomModel(model.id)}
                                style={{ padding: "3px 7px", fontSize: "0.71rem", color: "#b91c1c", display: "inline-flex", alignItems: "center", gap: "3px" }}
                              >
                                <Trash2 size={11} aria-hidden="true" />
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {model.description && <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)" }}>{model.description}</p>}

                      {liveSnap && (
                        <div
                          style={{
                            borderRadius: "8px",
                            padding: "10px",
                            background: "#0f172a",
                            color: "#e2e8f0",
                            display: "grid",
                            gap: "6px",
                            fontSize: "0.74rem",
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "6px" }}>
                            <strong style={{ color: "#86efac" }}>
                              {liveSnap.status === "ok"
                                ? `Live VDM Snapshot · ${liveSnap.snapshotId} (${liveSnap.sourceCalls} source call${liveSnap.sourceCalls === 1 ? "" : "s"})`
                                : `Stale Version Retry · ${liveSnap.message}`}
                            </strong>
                            <div style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                              <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", cursor: "pointer", fontSize: "0.71rem" }}>
                                <input
                                  type="checkbox"
                                  checked={testRedactPii}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    setTestRedactPii(checked);
                                    void runLiveSnapshotTest(model.id, checked);
                                  }}
                                />
                                Redact PII
                              </label>
                              <button
                                type="button"
                                onClick={() =>
                                  setSnapshotResults((prev) => {
                                    const copy = { ...prev };
                                    delete copy[model.id];
                                    return copy;
                                  })
                                }
                                style={{ background: "transparent", border: "none", color: "#94a3b8", cursor: "pointer", padding: 0 }}
                                aria-label="Close live snapshot preview"
                              >
                                <X size={13} />
                              </button>
                            </div>
                          </div>
                          {liveSnap.status === "ok" && (
                            <div style={{ color: "#cbd5e1", fontSize: "0.71rem" }}>
                              Sources queried: <code>{liveSnap.sourcesQueried.join(", ") || "none"}</code>
                              {liveSnap.sourcesSkipped.length > 0 && (
                                <> · Skipped (projection pushdown): <code>{liveSnap.sourcesSkipped.join(", ")}</code></>
                              )}
                              {liveSnap.redactedFields.length > 0 && (
                                <> · Redacted PII: <code>{liveSnap.redactedFields.join(", ")}</code></>
                              )}
                            </div>
                          )}
                          <pre style={{ margin: 0, overflowX: "auto", maxHeight: "220px", lineHeight: 1.45 }}>
                            {JSON.stringify(
                              liveSnap.status === "ok"
                                ? { dataVersions: liveSnap.dataVersions, data: liveSnap.data }
                                : { requiredVersions: liveSnap.requiredVersions, observedVersions: liveSnap.observedVersions },
                              null,
                              2,
                            )}
                          </pre>
                        </div>
                      )}

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
                  );
                })}
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
