import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  AlertTriangle,
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
  Rows3,
  ShieldCheck,
  Sigma,
  Sparkles,
  Split,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { adminPaths } from "../../packages/contracts/admin-paths";
import { getDomainPack, type DomainPackId } from "../../packages/contracts/domain-packs";
import type {
  SmassAggregateFilterOp,
  SmassAggregateFilterSpec,
  SmassAggregateOp,
  SmassClassification,
  SmassFieldFormat,
  SmassFieldType,
  SmassModelStatus,
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

type DraftAggregateField = {
  kind: "aggregate";
  uid: string;
  key: string;
  label: string;
  op: SmassAggregateOp;
  sourceField?: string;
  itemField?: string;
  sourceFields?: string[];
  targetModelId?: string;
  where?: SmassAggregateFilterSpec;
  type: SmassFieldType;
  format?: SmassFieldFormat;
  classification: SmassClassification;
  exposed: boolean;
};

type DraftField = DraftMappedField | DraftComputedField | DraftAggregateField;

type DragPayload =
  | { kind: "field"; toolRef: string; outputPath: string; type: string; label: string; format?: SmassFieldFormat }
  | {
      kind: "tool";
      toolRef: string;
      fields: Array<{ outputPath: string; type: string; label: string; format?: SmassFieldFormat }>;
    };

const DRAG_MIME = "application/x-smass-schema";
const AGGREGATE_OPS: Array<{ op: SmassAggregateOp; label: string }> = [
  { op: "sum", label: "SUM" },
  { op: "avg", label: "AVG" },
  { op: "min", label: "MIN" },
  { op: "max", label: "MAX" },
  { op: "count", label: "COUNT" },
  { op: "first", label: "FIRST" },
  { op: "last", label: "LAST" },
];
const AGGREGATE_FILTER_OPS: readonly SmassAggregateFilterOp[] = ["==", "!=", ">", ">=", "<", "<=", "contains"];
const WEALTH_PERSONAS = [
  { id: "demo-learner", label: "Alice Morgan (demo-learner)" },
  { id: "demo-returning", label: "Jordan Lee (demo-returning)" },
  { id: "demo-new-account", label: "Marcus Reed (demo-new-account)" },
] as const;

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
  if (type === "array") return "series";
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

function formatAggregateSummary(agg: {
  op: string;
  sourceField?: string;
  itemField?: string;
  sourceFields?: string[];
  targetModelId?: string;
  where?: SmassAggregateFilterSpec;
}): string {
  const target = agg.targetModelId
    ? `${agg.targetModelId}${agg.itemField ? `.${agg.itemField}` : ""}`
    : agg.sourceField
      ? `${agg.sourceField}${agg.itemField ? `.${agg.itemField}` : ""}`
      : (agg.sourceFields ?? []).join(", ");
  const whereStr = agg.where ? ` WHERE ${agg.where.field} ${agg.where.op} ${JSON.stringify(agg.where.value)}` : "";
  return `${agg.op.toUpperCase()}(${target}${whereStr})`;
}

function replaceIdentifier(expression: string, oldKey: string, newKey: string): string {
  if (!oldKey || !newKey || oldKey === newKey) return expression;
  const escaped = oldKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return expression.replace(new RegExp(`\\b${escaped}\\b`, "g"), newKey);
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

export function DomainToolsAndModelPanel({
  domainId,
  defaultOpenBuilder = false,
  initialEditModelId = null,
  onDataChanged,
}: {
  domainId: DomainPackId;
  defaultOpenBuilder?: boolean;
  initialEditModelId?: string | null;
  onDataChanged?: (next: DomainWorkbenchData) => void;
}) {
  const [data, setData] = useState<DomainWorkbenchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [viewMode, setViewMode] = useState<ModelViewMode>(defaultOpenBuilder ? "builder" : "entities");
  const [copied, setCopied] = useState(false);

  // Drag-and-drop Virtual Model Builder state
  const [editingPreviousId, setEditingPreviousId] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<SmassModelStatus>("published");
  const [draftLabel, setDraftLabel] = useState("Customer Summary VDM");
  const [draftId, setDraftId] = useState(() => slugifyModelId(domainId, "Customer Summary VDM"));
  const [idManuallyEdited, setIdManuallyEdited] = useState(false);
  const [draftDescription, setDraftDescription] = useState("Federated virtual model composed from tool JSON Schemas.");
  const [draftPrincipalKey, setDraftPrincipalKey] = useState(domainId === "wealth" ? "mid" : "");
  const [draftFields, setDraftFields] = useState<DraftField[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const activeDragRef = useRef<DragPayload | null>(null);

  // Derived (computed), Aggregate, Relation & Relational Normalization composer state
  const [activeComposer, setActiveComposer] = useState<"none" | "computed" | "aggregate" | "normalize" | "relation">("none");
  const [compKey, setCompKey] = useState("");
  const [compLabel, setCompLabel] = useState("");
  const [compExpr, setCompExpr] = useState("");
  const [compType, setCompType] = useState<SmassFieldType>("integer");

  // Relational normalization (extract nested array/object into 1:N or 1:1 child entity)
  const [normToolRef, setNormToolRef] = useState("");
  const [normPath, setNormPath] = useState("");
  const [normKind, setNormKind] = useState<"array" | "object">("array");
  const [normChildLabel, setNormChildLabel] = useState("");
  const [normChildId, setNormChildId] = useState("");
  const [normParentModelId, setNormParentModelId] = useState("");
  const [normParentJoinField, setNormParentJoinField] = useState("mid");
  const [normRelationName, setNormRelationName] = useState("");
  const [normSubfields, setNormSubfields] = useState<Array<{ subPath: string; key: string; label: string; type: string; selected: boolean }>>([]);
  const [normalizing, setNormalizing] = useState(false);

  // Explicit relation editor for current Virtual Builder draft
  const [draftRelations, setDraftRelations] = useState<
    Array<{ name: string; targetModelId: string; cardinality: SmassRelationCardinality; localField: string; foreignField: string }>
  >([]);
  const [relName, setRelName] = useState("belongs_to");
  const [relTargetModelId, setRelTargetModelId] = useState("");
  const [relCardinality, setRelCardinality] = useState<SmassRelationCardinality>("many_to_one");
  const [relLocalField, setRelLocalField] = useState("mid");
  const [relForeignField, setRelForeignField] = useState("customerId");

  // Aggregate column composer state (Array + WHERE, Across Columns, Cross-Entity Rollup)
  const [aggMode, setAggMode] = useState<"array" | "columns" | "rollup">("array");
  const [aggKey, setAggKey] = useState("");
  const [aggLabel, setAggLabel] = useState("");
  const [aggOp, setAggOp] = useState<SmassAggregateOp>("sum");
  const [aggSourceField, setAggSourceField] = useState("");
  const [aggItemField, setAggItemField] = useState("");
  const [aggTargetModelId, setAggTargetModelId] = useState("");
  const [aggWhereEnabled, setAggWhereEnabled] = useState(false);
  const [aggWhereField, setAggWhereField] = useState("");
  const [aggWhereOp, setAggWhereOp] = useState<SmassAggregateFilterOp>(">=");
  const [aggWhereValue, setAggWhereValue] = useState("");
  const [aggSelectedCols, setAggSelectedCols] = useState<string[]>([]);
  const [aggType, setAggType] = useState<SmassFieldType>("integer");

  // Live VDM snapshot test state (with Wealth persona selector)
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const [testCustomerId, setTestCustomerId] = useState<string>("demo-learner");
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
    setEditingPreviousId(null);
    setDraftFields([]);
    setDraftRelations([]);
    setDraftLabel(`${pack.shortLabel} Virtual View`);
    setDraftId(slugifyModelId(domainId, `${pack.shortLabel} Virtual View`));
    setIdManuallyEdited(false);
    setDraftPrincipalKey(domainId === "wealth" ? "mid" : "");
    setSnapshotResults({});
    setActiveComposer("none");
    void refresh();
  }, [domainId]);

  const appliedInitialRef = useRef<string | null>(null);
  useEffect(() => {
    if (!data || !initialEditModelId) return;
    if (appliedInitialRef.current === `${domainId}:${initialEditModelId}`) return;
    appliedInitialRef.current = `${domainId}:${initialEditModelId}`;
    if (data.customModels.some((m) => m.id === initialEditModelId)) {
      loadCustomModelIntoBuilder(initialEditModelId);
    }
  }, [data, domainId, initialEditModelId]);

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

  // Map array fields (e.g. `goal.progress.read@1.0.0::history`) to their JSON Schema item sub-fields (e.g. `month`, `savedCents`)
  const arrayItemSubfields = useMemo(() => {
    const map = new Map<string, Array<{ subPath: string; type: string }>>();
    for (const tool of data?.tools ?? []) {
      for (const field of tool.outputFields) {
        const marker = field.path.indexOf("[].");
        if (marker < 0) continue;
        const arrayPath = field.path.slice(0, marker);
        const subPath = field.path.slice(marker + 3);
        const key = `${tool.toolRef}::${arrayPath}`;
        const list = map.get(key) ?? [];
        list.push({ subPath, type: field.type });
        map.set(key, list);
      }
    }
    return map;
  }, [data?.tools]);

  // Map nested object fields (e.g. `demo.balance.read@1.0.0::values`) to their leaf sub-fields (e.g. `available`, `current`)
  const objectChildSubfields = useMemo(() => {
    const map = new Map<string, Array<{ subPath: string; fullPath: string; type: string }>>();
    for (const tool of data?.tools ?? []) {
      const objectPaths = tool.outputFields.filter((f) => f.type === "object" && !f.path.includes("[]"));
      for (const parent of objectPaths) {
        const prefix = `${parent.path}.`;
        const children = tool.outputFields
          .filter((f) => f.path.startsWith(prefix) && !f.path.includes("[]") && f.type !== "object")
          .map((f) => ({ subPath: f.path.slice(prefix.length), fullPath: f.path, type: f.type }));
        if (children.length > 0) {
          map.set(`${tool.toolRef}::${parent.path}`, children);
        }
      }
    }
    return map;
  }, [data?.tools]);

  function flattenHierarchicalField(toolRef: string, path: string, kind: "array" | "object", removeParentKey?: string) {
    setError("");
    if (removeParentKey) {
      setDraftFields((prev) => prev.filter((f) => f.key !== removeParentKey));
    }
    if (kind === "object") {
      const leaves = objectChildSubfields.get(`${toolRef}::${path}`) ?? [];
      if (leaves.length === 0) {
        setError(`No nested leaf properties found under "${path}".`);
        return;
      }
      addFieldsToDraft(
        leaves.map((leaf) => ({
          toolRef,
          outputPath: leaf.fullPath,
          type: leaf.type,
          label: `${prettifyFieldLabel(path)} ${prettifyFieldLabel(leaf.subPath)}`,
        })),
      );
      setNotice(`Flattened ${leaves.length} nested object fields from ${path} into flat scalar columns.`);
    } else {
      const subs = arrayItemSubfields.get(`${toolRef}::${path}`) ?? [];
      if (subs.length === 0) {
        setError(`No item properties found inside array "${path}".`);
        return;
      }
      addFieldsToDraft(
        subs.map((sub) => ({
          toolRef,
          outputPath: `${path}[-1].${sub.subPath}`,
          type: sub.type,
          label: `Latest ${prettifyFieldLabel(sub.subPath)}`,
        })),
      );
      setNotice(`Flattened latest element (${path}[-1].*) into ${subs.length} scalar columns for flat UI/rule bindings.`);
    }
  }

  function openNormalizeComposer(toolRef: string, path: string, kind: "array" | "object") {
    setError("");
    const subs =
      kind === "array"
        ? (arrayItemSubfields.get(`${toolRef}::${path}`) ?? []).map((s) => ({
            subPath: s.subPath,
            key: sanitizeFieldKey(s.subPath),
            label: prettifyFieldLabel(s.subPath),
            type: s.type,
            selected: true,
          }))
        : (objectChildSubfields.get(`${toolRef}::${path}`) ?? []).map((s) => ({
            subPath: s.subPath,
            key: sanitizeFieldKey(s.subPath),
            label: prettifyFieldLabel(s.subPath),
            type: s.type,
            selected: true,
          }));
    const leafSlug = sanitizeFieldKey(path);
    const parentCandidate =
      (editingPreviousId ?? (data?.models.find((m) => m.toolRefs.includes(toolRef))?.id)) ??
      data?.models[0]?.id ??
      "";
    const parentModel = data?.models.find((m) => m.id === parentCandidate);
    setNormToolRef(toolRef);
    setNormPath(path);
    setNormKind(kind);
    setNormChildLabel(`${prettifyFieldLabel(path)} ${kind === "array" ? "Records" : "Details"}`);
    setNormChildId(`${domainId}.${leafSlug}_${kind === "array" ? "items" : "details"}`);
    setNormParentModelId(parentCandidate);
    setNormParentJoinField(parentModel?.primaryKey ?? (domainId === "wealth" ? "customerId" : "id"));
    setNormRelationName(`belongs_to_${(parentCandidate.split(".").at(-1) ?? "parent").replace(/[^a-z0-9_]/gi, "_")}`);
    setNormSubfields(subs);
    setViewMode("builder");
    setActiveComposer("normalize");
  }

  async function createRelationalChildModel() {
    const selected = normSubfields.filter((s) => s.selected);
    if (selected.length === 0) {
      setError("Select at least one nested property to include in the normalized child entity.");
      return;
    }
    setNormalizing(true);
    setError("");
    setNotice("");
    try {
      const joinKey = draftPrincipalKey.trim() || (domainId === "wealth" ? "mid" : "");
      const next = await api.saveDomainModel(domainId, {
        id: normChildId.trim(),
        version: "1.0.0",
        label: normChildLabel.trim(),
        description: `Normalized ${normKind === "array" ? "1:N" : "1:1"} relational child entity unnested from ${normToolRef} → ${normPath}${normKind === "array" ? "[]" : ""}.`,
        primaryKey: normKind === "array" ? "rowIndex" : (joinKey || selected[0]!.key),
        ...(joinKey ? { principalKey: joinKey } : {}),
        unnest: {
          toolRef: normToolRef,
          path: normPath,
          ...(normParentModelId ? { parentModelId: normParentModelId, parentJoinField: normParentJoinField } : {}),
          ...(normKind === "array" ? { indexField: "rowIndex" } : {}),
        },
        fields: selected.map((sub) => ({
          kind: "mapped" as const,
          key: sanitizeFieldKey(sub.key),
          label: sub.label.trim() || prettifyFieldLabel(sub.subPath),
          toolRef: normToolRef,
          outputPath: normKind === "array" ? `${normPath}[].${sub.subPath}` : `${normPath}.${sub.subPath}`,
          format: inferFormat(sub.subPath, sub.type),
          classification: /email|ssn|phone|address|name/i.test(sub.subPath) ? ("pii" as const) : ("internal" as const),
          required: false,
          exposed: true,
        })),
        ...(normParentModelId && joinKey
          ? {
              relations: [
                {
                  name: normRelationName.trim() || "belongs_to_parent",
                  targetModelId: normParentModelId,
                  cardinality: normKind === "array" ? ("many_to_one" as const) : ("one_to_one" as const),
                  localField: joinKey,
                  foreignField: normParentJoinField,
                },
              ],
            }
          : {}),
      });
      setData(next);
      onDataChanged?.(next);
      setActiveComposer("none");
      setViewMode("entities");
      setNotice(
        `Normalized ${normPath}${normKind === "array" ? "[]" : ""} into relational child model "${normChildLabel.trim()}" (${normChildId.trim()}) — added to Mermaid ER, Draft 2020-12 JSON Schema & live 1× unnest runtime.`,
      );
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setNormalizing(false);
    }
  }

  const arrayDraftFields = useMemo(
    () => draftFields.filter((f): f is DraftMappedField => f.kind === "mapped" && f.type === "array"),
    [draftFields],
  );
  const scalarDraftFields = useMemo(
    () => draftFields.filter((f) => !(f.kind === "mapped" && f.type === "array")),
    [draftFields],
  );

  // Auto-select sensible default mode & field when opening Aggregate composer
  function openAggregateComposer() {
    setError("");
    if (arrayDraftFields.length > 0) {
      const firstArr = arrayDraftFields[0]!;
      const subs = arrayItemSubfields.get(`${firstArr.toolRef}::${firstArr.outputPath}`) ?? [];
      const firstNumericSub = subs.find((s) => s.type === "integer" || s.type === "number") ?? subs[0];
      setAggMode("array");
      setAggSourceField(firstArr.key);
      setAggItemField(firstNumericSub?.subPath ?? "");
      setAggOp("last");
      setAggKey(firstNumericSub ? `latest_${firstNumericSub.subPath}` : `${firstArr.key}_count`);
      setAggLabel(firstNumericSub ? `Latest ${prettifyFieldLabel(firstNumericSub.subPath)}` : `${firstArr.label} Count`);
      setAggType(firstNumericSub?.type === "integer" || firstNumericSub?.type === "number" ? firstNumericSub.type : "integer");
    } else {
      const numericScalars = scalarDraftFields
        .filter((f) => f.type === "integer" || f.type === "number")
        .map((f) => f.key);
      setAggMode("columns");
      setAggSelectedCols(numericScalars.slice(0, 3));
      setAggOp("sum");
      setAggKey("total_aggregate");
      setAggLabel("Combined Total");
      setAggType("integer");
    }
    setActiveComposer("aggregate");
  }

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

  /**
   * Renames a column's canonical key and automatically rewires any downstream
   * derived column expressions or aggregate references so renames never break dependencies.
   */
  function renameDraftFieldKey(index: number, nextKey: string) {
    setDraftFields((prev) => {
      const oldKey = prev[index]?.key ?? "";
      return prev.map((field, i) => {
        if (i === index) return { ...field, key: nextKey };
        if (!oldKey || !nextKey || oldKey === nextKey) return field;
        if (field.kind === "computed" && field.dependsOn.includes(oldKey)) {
          return {
            ...field,
            expression: replaceIdentifier(field.expression, oldKey, nextKey),
            dependsOn: field.dependsOn.map((d) => (d === oldKey ? nextKey : d)),
          };
        }
        if (field.kind === "aggregate") {
          const nextSourceField = field.sourceField === oldKey ? nextKey : field.sourceField;
          const nextSourceFields = field.sourceFields?.map((d) => (d === oldKey ? nextKey : d));
          if (nextSourceField !== field.sourceField || nextSourceFields?.some((d, j) => d !== field.sourceFields?.[j])) {
            return {
              ...field,
              ...(nextSourceField ? { sourceField: nextSourceField } : {}),
              ...(nextSourceFields ? { sourceFields: nextSourceFields } : {}),
            };
          }
        }
        return field;
      });
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
      setError("Provide both a column key and an arithmetic formula for the derived column.");
      return;
    }
    const existingKeys = draftFields.map((f) => f.key);
    const dependsOn = inferDependsOn(cleanExpr, existingKeys);
    if (dependsOn.length === 0) {
      setError(`Formula must reference at least one column key (${existingKeys.join(", ") || "drop fields first"}).`);
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
    setActiveComposer("none");
  }

  function parseFilterValue(raw: string): string | number | boolean {
    const trimmed = raw.trim();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (trimmed !== "" && !Number.isNaN(Number(trimmed))) return Number(trimmed);
    return trimmed;
  }

  function addAggregateFieldToDraft() {
    const cleanKey = sanitizeFieldKey(aggKey);
    if (!cleanKey) {
      setError("Provide a column key for the aggregate.");
      return;
    }
    const whereClause: SmassAggregateFilterSpec | undefined =
      aggWhereEnabled && aggWhereField.trim() && aggWhereValue.trim()
        ? { field: aggWhereField.trim(), op: aggWhereOp, value: parseFilterValue(aggWhereValue) }
        : undefined;

    if (aggMode === "rollup") {
      if (!aggTargetModelId) {
        setError("Select a related target entity for the cross-entity rollup.");
        return;
      }
      setError("");
      setDraftFields((prev) => [
        ...prev,
        {
          kind: "aggregate",
          uid: `agg:${cleanKey}:${Date.now()}`,
          key: cleanKey,
          label: aggLabel.trim() || prettifyFieldLabel(cleanKey),
          op: aggOp,
          targetModelId: aggTargetModelId,
          ...(aggItemField.trim() && aggOp !== "count" ? { itemField: aggItemField.trim() } : {}),
          ...(whereClause ? { where: whereClause } : {}),
          type: aggOp === "count" ? "integer" : aggType,
          format: aggOp === "count" ? "number" : inferFormat(aggItemField || cleanKey, aggType),
          classification: "internal",
          exposed: true,
        },
      ]);
    } else if (aggMode === "array") {
      if (!aggSourceField) {
        setError("Select an array column (such as history) to aggregate over, or switch to Across Columns / Rollup mode.");
        return;
      }
      setError("");
      setDraftFields((prev) => [
        ...prev,
        {
          kind: "aggregate",
          uid: `agg:${cleanKey}:${Date.now()}`,
          key: cleanKey,
          label: aggLabel.trim() || prettifyFieldLabel(cleanKey),
          op: aggOp,
          sourceField: aggSourceField,
          ...(aggItemField.trim() && aggOp !== "count" ? { itemField: aggItemField.trim() } : {}),
          ...(whereClause ? { where: whereClause } : {}),
          type: aggOp === "count" ? "integer" : aggType,
          format: aggOp === "count" ? "number" : inferFormat(aggItemField || cleanKey, aggType),
          classification: "internal",
          exposed: true,
        },
      ]);
    } else {
      if (aggSelectedCols.length < 1) {
        setError("Select at least one column to aggregate.");
        return;
      }
      setError("");
      setDraftFields((prev) => [
        ...prev,
        {
          kind: "aggregate",
          uid: `agg:${cleanKey}:${Date.now()}`,
          key: cleanKey,
          label: aggLabel.trim() || prettifyFieldLabel(cleanKey),
          op: aggOp,
          sourceFields: [...aggSelectedCols],
          type: aggOp === "count" ? "integer" : aggType,
          format: aggOp === "count" ? "number" : inferFormat(cleanKey, aggType),
          classification: "internal",
          exposed: true,
        },
      ]);
    }
    setAggKey("");
    setAggLabel("");
    setAggWhereEnabled(false);
    setAggWhereField("");
    setAggWhereValue("");
    setActiveComposer("none");
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
        ...(editingPreviousId ? { previousId: editingPreviousId } : {}),
        version: "1.0.0",
        status: draftStatus,
        label: draftLabel.trim(),
        ...(draftDescription.trim() ? { description: draftDescription.trim() } : {}),
        ...(draftPrincipalKey.trim() ? { principalKey: draftPrincipalKey.trim(), primaryKey: draftPrincipalKey.trim() } : {}),
        ...(draftRelations.length ? { relations: draftRelations } : {}),
        fields: draftFields.map((f) => {
          if (f.kind === "computed") {
            return {
              kind: "computed" as const,
              key: f.key,
              label: f.label,
              expression: f.expression,
              dependsOn: f.dependsOn,
              type: f.type,
              ...(f.format ? { format: f.format } : {}),
              classification: f.classification,
              exposed: f.exposed,
            };
          }
          if (f.kind === "aggregate") {
            return {
              kind: "aggregate" as const,
              key: f.key,
              label: f.label,
              op: f.op,
              ...(f.sourceField ? { sourceField: f.sourceField } : {}),
              ...(f.itemField ? { itemField: f.itemField } : {}),
              ...(f.sourceFields?.length ? { sourceFields: f.sourceFields } : {}),
              ...(f.targetModelId ? { targetModelId: f.targetModelId } : {}),
              ...(f.where ? { where: f.where } : {}),
              type: f.type,
              ...(f.format ? { format: f.format } : {}),
              classification: f.classification,
              exposed: f.exposed,
            };
          }
          return {
            kind: "mapped" as const,
            key: f.key,
            label: f.label,
            toolRef: f.toolRef,
            outputPath: f.outputPath,
            ...(f.format ? { format: f.format } : {}),
            classification: f.classification,
            required: f.required,
            exposed: f.exposed,
          };
        }),
      });
      const wasRenamed = editingPreviousId && editingPreviousId !== draftId.trim();
      setData(next);
      onDataChanged?.(next);
      setEditingPreviousId(null);
      setViewMode("entities");
      setNotice(
        wasRenamed
          ? `Renamed & saved Virtual Data Model "${draftLabel.trim()}" (${editingPreviousId} → ${draftId.trim()}) into smass & sphoton.`
          : `Saved Virtual Data Model "${draftLabel.trim()}" (${draftId.trim()}) — compiled into smass ER graph, Draft 2020-12 JSON Schema & sphoton catalog.`,
      );
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setSavingModel(false);
    }
  }

  function loadCustomModelIntoBuilder(modelId: string) {
    const found = data?.customModels?.find((m) => m.id === modelId);
    if (!found) return;
    const toolFieldTypes = new Map<string, string>();
    for (const tool of data?.tools ?? []) {
      for (const f of tool.outputFields) toolFieldTypes.set(`${tool.toolRef}::${f.path}`, f.type);
    }
    setEditingPreviousId(found.id);
    setDraftStatus(found.status ?? "published");
    setDraftId(found.id);
    setDraftLabel(found.label);
    setIdManuallyEdited(true);
    setDraftDescription(found.description ?? "");
    setDraftPrincipalKey(found.principalKey ?? "");
    setDraftRelations(found.relations ?? []);
    setDraftFields(
      found.fields.map((f, idx) => {
        if (f.kind === "computed") {
          return {
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
          };
        }
        if (f.kind === "aggregate") {
          return {
            kind: "aggregate",
            uid: `edit:${f.key}:${idx}`,
            key: f.key,
            label: f.label,
            op: f.op,
            sourceField: f.sourceField,
            itemField: f.itemField,
            sourceFields: f.sourceFields,
            targetModelId: f.targetModelId,
            where: f.where,
            type: f.type,
            format: f.format,
            classification: f.classification,
            exposed: f.exposed,
          };
        }
        return {
          kind: "mapped",
          uid: `edit:${f.toolRef}:${f.outputPath}:${idx}`,
          key: f.key,
          label: f.label,
          toolRef: f.toolRef,
          outputPath: f.outputPath,
          type: toolFieldTypes.get(`${f.toolRef}::${f.outputPath}`) ?? "string",
          format: f.format,
          classification: f.classification,
          required: f.required,
          exposed: f.exposed,
        };
      }),
    );
    setViewMode("builder");
    setNotice(`Loaded "${found.label}" into Virtual Model Builder. Rename the model or columns, drag more fields, or add aggregates & derived columns.`);
  }

  function startFreshVirtualModel() {
    setEditingPreviousId(null);
    setDraftStatus("published");
    setDraftFields([]);
    setDraftRelations([]);
    setDraftLabel(`${pack.shortLabel} Virtual View`);
    setDraftId(slugifyModelId(domainId, `${pack.shortLabel} Virtual View`));
    setIdManuallyEdited(false);
    setDraftDescription("Federated virtual model composed from tool JSON Schemas.");
    setDraftPrincipalKey(domainId === "wealth" ? "mid" : "");
    setActiveComposer("none");
    setViewMode("builder");
  }

  async function toggleModelStatus(modelId: string, nextStatus: SmassModelStatus) {
    setError("");
    setNotice("");
    try {
      const next = await api.setDomainModelStatus(domainId, { modelId, status: nextStatus });
      setData(next);
      onDataChanged?.(next);
      setNotice(
        nextStatus === "published"
          ? `Published "${modelId}" — compiled into live sfield read tool & sphoton UI catalog.`
          : `Moved "${modelId}" to Draft — hidden from sphoton UI catalog & agents while remaining editable in Studio.`,
      );
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    }
  }

  async function deleteCustomModel(modelId: string) {
    setError("");
    setNotice("");
    try {
      const next = await api.deleteDomainModel(domainId, modelId);
      setData(next);
      onDataChanged?.(next);
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

  async function runLiveSnapshotTest(modelId: string, redactPii = testRedactPii, customerId = testCustomerId) {
    setTestingModelId(modelId);
    setError("");
    try {
      const { snapshot } = await api.testDomainModelSnapshot(domainId, {
        modelId,
        ...(domainId === "wealth" ? { customerId } : {}),
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
  const selectedArrayField = arrayDraftFields.find((f) => f.key === aggSourceField);
  const selectedArraySubfields = selectedArrayField
    ? arrayItemSubfields.get(`${selectedArrayField.toolRef}::${selectedArrayField.outputPath}`) ?? []
    : [];

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
            {pack.label} · Tool JSON Schemas → Canonical <code>smass</code> Virtual Data Model
          </h2>
          <p style={{ margin: 0, fontSize: "0.88rem", color: "var(--muted)" }}>
            Drag closed JSON Schema fields from <code>sfield</code> tools on the left into the <strong>Virtual Builder</strong> — rename models &amp; columns, add <strong>aggregates</strong> and <strong>derived columns</strong>, and test live 1× snapshots.
          </p>
        </div>
        <div style={{ display: "inline-flex", gap: "8px", flexWrap: "wrap" }}>
          <button
            type="button"
            className="secondary-button"
            onClick={startFreshVirtualModel}
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
            + New Virtual Model
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
        <div style={{ display: "grid", gridTemplateColumns: "minmax(360px, 0.95fr) minmax(420px, 1.15fr)", gap: "16px", alignItems: "start" }}>
          {/* Column 1: Connected sfield Tools & Draggable Closed JSON Schemas */}
          <div style={{ display: "grid", gap: "10px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <h3 style={{ margin: 0, fontSize: "0.95rem", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                <Wrench size={15} aria-hidden="true" />
                1. Tool JSON Schemas ({data.tools.length})
              </h3>
              <span style={{ fontSize: "0.74rem", color: "var(--muted)" }}>
                Drag any field or whole tool → Builder
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
                          const arrSubs = field.type === "array" ? arrayItemSubfields.get(key) ?? [] : [];
                          const objSubs = field.type === "object" ? objectChildSubfields.get(key) ?? [] : [];
                          const isHierarchicalArray = arrSubs.length > 0;
                          const isHierarchicalObject = objSubs.length > 0;
                          const subPreview = isHierarchicalArray
                            ? arrSubs.map((s) => s.subPath).join(", ")
                            : isHierarchicalObject
                              ? objSubs.map((s) => s.subPath).join(", ")
                              : "";
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
                                <span style={{ fontSize: "0.71rem", color: "var(--muted)" }}>
                                  ({field.type}{subPreview ? ` · ${subPreview}` : ""})
                                </span>
                                {field.exposed && <strong style={{ fontSize: "0.75rem" }}>→ {field.label}</strong>}
                              </span>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", flexShrink: 0, flexWrap: "wrap" }}>
                                {(isHierarchicalArray || isHierarchicalObject) && (
                                  <>
                                    <button
                                      type="button"
                                      className="secondary-button"
                                      title={isHierarchicalObject ? "Flatten nested object keys into scalar columns" : "Flatten latest array element properties into scalar columns"}
                                      onClick={() => flattenHierarchicalField(tool.toolRef, field.path, isHierarchicalArray ? "array" : "object")}
                                      style={{ padding: "3px 7px", fontSize: "0.7rem", display: "inline-flex", alignItems: "center", gap: "3px", color: "#0369a1", borderColor: "#bae6fd" }}
                                    >
                                      <Rows3 size={11} aria-hidden="true" />
                                      Flatten
                                    </button>
                                    <button
                                      type="button"
                                      className="secondary-button"
                                      title={isHierarchicalArray ? "Normalize nested array into a 1:N relational child model" : "Normalize nested object into a 1:1 relational child model"}
                                      onClick={() => openNormalizeComposer(tool.toolRef, field.path, isHierarchicalArray ? "array" : "object")}
                                      style={{ padding: "3px 7px", fontSize: "0.7rem", display: "inline-flex", alignItems: "center", gap: "3px", color: "#4338ca", borderColor: "#c7d2fe" }}
                                    >
                                      <Split size={11} aria-hidden="true" />
                                      {isHierarchicalArray ? "1:N Table" : "1:1 Entity"}
                                    </button>
                                  </>
                                )}
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
                    ["builder", `Virtual Builder${draftFields.length ? ` (${draftFields.length})` : ""}`],
                    ["entities", `Entity Models (${entities.length})`],
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
                      {editingPreviousId ? `Editing & Renaming: ${editingPreviousId}` : "Drag-and-Drop Virtual Model Composer"}
                    </strong>
                    <p style={{ margin: "2px 0 0", fontSize: "0.78rem", color: "var(--muted)" }}>
                      Rename any column or model ID freely — derived formulas and aggregates automatically follow column renames.
                    </p>
                  </div>
                  {draftFields.length > 0 && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        setDraftFields([]);
                        setActiveComposer("none");
                      }}
                      style={{ padding: "4px 8px", fontSize: "0.73rem" }}
                    >
                      Clear fields
                    </button>
                  )}
                </div>

                {/* Model Metadata (Renameable Model Name & Model ID) */}
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
                    Model ID (renameable)
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

                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "8px" }}>
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
                    Principal Join Key
                    <input
                      type="text"
                      value={draftPrincipalKey}
                      onChange={(e) => setDraftPrincipalKey(e.target.value)}
                      placeholder="e.g. mid"
                      style={{ padding: "6px 8px", borderRadius: "7px", border: "1px solid var(--border, #cbd5e1)", fontSize: "0.82rem", fontFamily: "monospace" }}
                    />
                  </label>
                  <label style={{ display: "grid", gap: "3px", fontSize: "0.76rem", fontWeight: 600 }}>
                    Lifecycle Status
                    <select
                      aria-label="Model lifecycle status"
                      value={draftStatus}
                      onChange={(e) => setDraftStatus(e.target.value as SmassModelStatus)}
                      style={{ padding: "6px 8px", borderRadius: "7px", border: "1px solid var(--border, #cbd5e1)", fontSize: "0.82rem" }}
                    >
                      <option value="published">Published (live sfield tool)</option>
                      <option value="draft">Draft (studio preview only)</option>
                    </select>
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
                        Mix fields from multiple tools (including arrays like <code>history</code>), rename columns, then add <strong>aggregates</strong> and <strong>derived columns</strong>.
                      </span>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.74rem", color: "#155331", fontWeight: 600 }}>
                        <span>
                          Federates {federatedTools.length} tool{federatedTools.length === 1 ? "" : "s"} · {draftFields.length} virtual column{draftFields.length === 1 ? "" : "s"}
                        </span>
                        <span style={{ color: "var(--muted)", fontWeight: 500 }}>
                          {isDragOver ? "Drop to append column…" : "Drag more fields here to expand"}
                        </span>
                      </div>
                      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "6px" }}>
                        {draftFields.map((field, index) => {
                          const isRenamed = field.kind === "mapped" && field.key !== sanitizeFieldKey(field.outputPath);
                          return (
                            <li
                              key={field.uid}
                              style={{
                                padding: "8px 10px",
                                borderRadius: "8px",
                                background: "#fff",
                                border:
                                  field.kind === "computed"
                                    ? "1px solid #d8b4fe"
                                    : field.kind === "aggregate"
                                      ? "1px solid #fcd34d"
                                      : "1px solid var(--border, #d4e2da)",
                                display: "grid",
                                gap: "6px",
                                fontSize: "0.79rem",
                              }}
                            >
                              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto auto", gap: "6px", alignItems: "center" }}>
                                <input
                                  type="text"
                                  aria-label={`Canonical key for column ${index + 1}`}
                                  title="Rename canonical column key"
                                  value={field.key}
                                  onChange={(e) => renameDraftFieldKey(index, e.target.value)}
                                  style={{ padding: "4px 6px", borderRadius: "6px", border: "1px solid var(--border, #cbd5e1)", fontFamily: "monospace", fontSize: "0.78rem", fontWeight: 700 }}
                                />
                                <input
                                  type="text"
                                  aria-label={`Display label for column ${index + 1}`}
                                  title="Rename display label"
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
                                  <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", flexWrap: "wrap" }}>
                                    <span>
                                      Source: <code>{field.toolRef}</code> → <code>{field.outputPath}</code> ({field.type})
                                    </span>
                                    {isRenamed && (
                                      <span style={{ padding: "1px 5px", borderRadius: "4px", background: "#e0f2fe", color: "#0369a1", fontWeight: 700, fontSize: "0.67rem" }}>
                                        renamed from {field.outputPath}
                                      </span>
                                    )}
                                    {(field.type === "array" || field.type === "object") &&
                                      ((arrayItemSubfields.get(`${field.toolRef}::${field.outputPath}`)?.length ?? 0) > 0 ||
                                        (objectChildSubfields.get(`${field.toolRef}::${field.outputPath}`)?.length ?? 0) > 0) && (
                                        <>
                                          <button
                                            type="button"
                                            className="secondary-button"
                                            onClick={() =>
                                              flattenHierarchicalField(
                                                field.toolRef,
                                                field.outputPath,
                                                field.type === "array" ? "array" : "object",
                                                field.key,
                                              )
                                            }
                                            style={{ padding: "1px 6px", fontSize: "0.68rem", color: "#0369a1", borderColor: "#bae6fd" }}
                                          >
                                            Flatten into columns
                                          </button>
                                          <button
                                            type="button"
                                            className="secondary-button"
                                            onClick={() =>
                                              openNormalizeComposer(
                                                field.toolRef,
                                                field.outputPath,
                                                field.type === "array" ? "array" : "object",
                                              )
                                            }
                                            style={{ padding: "1px 6px", fontSize: "0.68rem", color: "#4338ca", borderColor: "#c7d2fe" }}
                                          >
                                            Extract {field.type === "array" ? "1:N Table" : "1:1 Entity"}
                                          </button>
                                        </>
                                      )}
                                  </span>
                                ) : field.kind === "aggregate" ? (
                                  <span style={{ color: "#92400e", display: "inline-flex", alignItems: "center", gap: "5px" }}>
                                    <Sigma size={12} aria-hidden="true" />
                                    <strong>Aggregate:</strong> <code>{formatAggregateSummary(field)}</code> ({field.type})
                                  </span>
                                ) : (
                                  <span style={{ color: "#6b21a8" }}>
                                    <strong>Derived:</strong> <code>{field.expression}</code> (deps: {field.dependsOn.join(", ")})
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
                          );
                        })}
                      </ul>
                    </>
                  )}
                </div>

                {/* Derived Column Composer */}
                {activeComposer === "computed" && (
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
                      <strong style={{ fontSize: "0.8rem", color: "#6b21a8" }}>Add Derived Column (Formula)</strong>
                      <button type="button" className="secondary-button" style={{ padding: "2px 6px", fontSize: "0.72rem" }} onClick={() => setActiveComposer("none")}>
                        Cancel
                      </button>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 110px", gap: "6px" }}>
                      <input
                        type="text"
                        value={compKey}
                        onChange={(e) => setCompKey(e.target.value)}
                        placeholder="Column key (e.g. remainingGapCents)"
                        style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #d8b4fe", fontFamily: "monospace", fontSize: "0.78rem" }}
                      />
                      <input
                        type="text"
                        value={compLabel}
                        onChange={(e) => setCompLabel(e.target.value)}
                        placeholder="Display label (e.g. Remaining Gap)"
                        style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #d8b4fe", fontSize: "0.78rem" }}
                      />
                      <select
                        aria-label="Derived column type"
                        value={compType}
                        onChange={(e) => setCompType(e.target.value as SmassFieldType)}
                        style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #d8b4fe", fontSize: "0.78rem" }}
                      >
                        <option value="integer">integer</option>
                        <option value="number">number</option>
                        <option value="string">string</option>
                        <option value="boolean">boolean</option>
                      </select>
                    </div>
                    {scalarDraftFields.length > 0 && (
                      <div style={{ display: "grid", gap: "5px" }}>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center", fontSize: "0.71rem", color: "#6b21a8" }}>
                          <span>Insert column:</span>
                          {scalarDraftFields.map((col) => (
                            <button
                              key={col.uid}
                              type="button"
                              onClick={() => setCompExpr((prev) => (prev ? `${prev} ${col.key}` : col.key))}
                              style={{
                                padding: "2px 6px",
                                borderRadius: "999px",
                                border: "1px solid #d8b4fe",
                                background: "#fff",
                                color: "#6b21a8",
                                fontFamily: "monospace",
                                fontSize: "0.71rem",
                                cursor: "pointer",
                              }}
                            >
                              + {col.key}
                            </button>
                          ))}
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center", fontSize: "0.7rem", color: "#6b21a8" }}>
                          <span>Templates:</span>
                          {[
                            {
                              label: "IF(cond, a, b)",
                              type: "string" as SmassFieldType,
                              expr: `IF(${scalarDraftFields[0]!.key} >= 1000000, "high", "standard")`,
                            },
                            {
                              label: "COALESCE(a, 0)",
                              type: "integer" as SmassFieldType,
                              expr: `COALESCE(${scalarDraftFields[0]!.key}, 0)`,
                            },
                            {
                              label: "CONCAT(...)",
                              type: "string" as SmassFieldType,
                              expr: `CONCAT("${pack.shortLabel}: ", ${scalarDraftFields[0]!.key})`,
                            },
                            {
                              label: "UPPER(...)",
                              type: "string" as SmassFieldType,
                              expr: `UPPER(${scalarDraftFields[0]!.key})`,
                            },
                          ].map((tpl) => (
                            <button
                              key={tpl.label}
                              type="button"
                              onClick={() => {
                                setCompExpr(tpl.expr);
                                setCompType(tpl.type);
                              }}
                              style={{
                                padding: "2px 6px",
                                borderRadius: "6px",
                                border: "1px dashed #c084fc",
                                background: "#fff",
                                color: "#7e22ce",
                                fontFamily: "monospace",
                                fontSize: "0.69rem",
                                cursor: "pointer",
                              }}
                            >
                              {tpl.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <div style={{ display: "flex", gap: "6px" }}>
                      <input
                        type="text"
                        value={compExpr}
                        onChange={(e) => setCompExpr(e.target.value)}
                        placeholder='Formula: IF(cash >= 1000000, "high", "standard"), COALESCE, CONCAT, UPPER, max, min, + - * /'
                        style={{ flex: 1, padding: "5px 7px", borderRadius: "6px", border: "1px solid #d8b4fe", fontFamily: "monospace", fontSize: "0.78rem" }}
                      />
                      <button type="button" className="secondary-button" onClick={addComputedFieldToDraft} style={{ padding: "5px 10px", fontSize: "0.76rem", background: "#7e22ce", color: "#fff", borderColor: "#7e22ce", fontWeight: 600 }}>
                        Add derived column
                      </button>
                    </div>
                  </div>
                )}

                {/* Aggregate Column Composer */}
                {activeComposer === "aggregate" && (
                  <div
                    style={{
                      border: "1px solid #fcd34d",
                      borderRadius: "8px",
                      padding: "10px",
                      background: "#fffbeb",
                      display: "grid",
                      gap: "8px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: "0.8rem", color: "#92400e", display: "inline-flex", alignItems: "center", gap: "5px" }}>
                        <Sigma size={14} aria-hidden="true" />
                        Add Aggregate Column
                      </strong>
                      <div style={{ display: "inline-flex", gap: "4px", flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => setAggMode("array")}
                          style={{
                            padding: "2px 8px",
                            fontSize: "0.71rem",
                            background: aggMode === "array" ? "#d97706" : undefined,
                            color: aggMode === "array" ? "#fff" : undefined,
                            borderColor: aggMode === "array" ? "#d97706" : undefined,
                          }}
                        >
                          Array / Series ({arrayDraftFields.length})
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => setAggMode("columns")}
                          style={{
                            padding: "2px 8px",
                            fontSize: "0.71rem",
                            background: aggMode === "columns" ? "#d97706" : undefined,
                            color: aggMode === "columns" ? "#fff" : undefined,
                            borderColor: aggMode === "columns" ? "#d97706" : undefined,
                          }}
                        >
                          Across Columns
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => {
                            setAggMode("rollup");
                            const candidate = entities.find((e) => e.id !== draftId) ?? entities[0];
                            if (candidate && !aggTargetModelId) {
                              setAggTargetModelId(candidate.id);
                              const numField = candidate.fields.find((f) => f.type === "integer" || f.type === "number") ?? candidate.fields[0];
                              setAggItemField(numField?.key ?? "");
                            }
                          }}
                          style={{
                            padding: "2px 8px",
                            fontSize: "0.71rem",
                            background: aggMode === "rollup" ? "#d97706" : undefined,
                            color: aggMode === "rollup" ? "#fff" : undefined,
                            borderColor: aggMode === "rollup" ? "#d97706" : undefined,
                          }}
                        >
                          Cross-Entity Rollup
                        </button>
                        <button type="button" className="secondary-button" style={{ padding: "2px 6px", fontSize: "0.71rem" }} onClick={() => setActiveComposer("none")}>
                          Cancel
                        </button>
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 95px 95px", gap: "6px" }}>
                      <input
                        type="text"
                        value={aggKey}
                        onChange={(e) => setAggKey(e.target.value)}
                        placeholder="Aggregate key"
                        style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #fcd34d", fontFamily: "monospace", fontSize: "0.78rem" }}
                      />
                      <input
                        type="text"
                        value={aggLabel}
                        onChange={(e) => setAggLabel(e.target.value)}
                        placeholder="Display label"
                        style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #fcd34d", fontSize: "0.78rem" }}
                      />
                      <select
                        aria-label="Aggregate function"
                        value={aggOp}
                        onChange={(e) => setAggOp(e.target.value as SmassAggregateOp)}
                        style={{ padding: "5px 6px", borderRadius: "6px", border: "1px solid #fcd34d", fontSize: "0.76rem", fontWeight: 700 }}
                      >
                        {AGGREGATE_OPS.map(({ op, label }) => (
                          <option key={op} value={op}>{label}</option>
                        ))}
                      </select>
                      <select
                        aria-label="Aggregate result type"
                        value={aggOp === "count" ? "integer" : aggType}
                        disabled={aggOp === "count"}
                        onChange={(e) => setAggType(e.target.value as SmassFieldType)}
                        style={{ padding: "5px 6px", borderRadius: "6px", border: "1px solid #fcd34d", fontSize: "0.76rem" }}
                      >
                        <option value="integer">integer</option>
                        <option value="number">number</option>
                        <option value="string">string</option>
                      </select>
                    </div>

                    {aggMode === "rollup" ? (
                      <div style={{ display: "grid", gap: "6px" }}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "6px", alignItems: "center" }}>
                          <select
                            aria-label="Related entity for rollup"
                            value={aggTargetModelId}
                            onChange={(e) => {
                              const nextTarget = e.target.value;
                              setAggTargetModelId(nextTarget);
                              const tgt = entities.find((m) => m.id === nextTarget);
                              const numField = tgt?.fields.find((f) => f.type === "integer" || f.type === "number") ?? tgt?.fields[0];
                              setAggItemField(numField?.key ?? "");
                            }}
                            style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #fcd34d", fontFamily: "monospace", fontSize: "0.78rem" }}
                          >
                            <option value="">Select target entity…</option>
                            {entities
                              .filter((e) => e.id !== draftId)
                              .map((e) => (
                                <option key={e.id} value={e.id}>{e.id} ({e.label})</option>
                              ))}
                          </select>
                          {aggOp !== "count" ? (
                            <select
                              aria-label="Target entity column"
                              value={aggItemField}
                              onChange={(e) => setAggItemField(e.target.value)}
                              style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #fcd34d", fontFamily: "monospace", fontSize: "0.78rem" }}
                            >
                              <option value="">Select column…</option>
                              {(entities.find((m) => m.id === aggTargetModelId)?.fields ?? []).map((f) => (
                                <option key={f.key} value={f.key}>.{f.key} ({f.type ?? "any"})</option>
                              ))}
                            </select>
                          ) : (
                            <span style={{ fontSize: "0.74rem", color: "#92400e" }}>Counts matching related rows</span>
                          )}
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={addAggregateFieldToDraft}
                            style={{ padding: "5px 10px", fontSize: "0.76rem", background: "#d97706", color: "#fff", borderColor: "#d97706", fontWeight: 600 }}
                          >
                            Add rollup
                          </button>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", fontSize: "0.74rem" }}>
                          <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontWeight: 600, color: "#92400e", cursor: "pointer" }}>
                            <input
                              type="checkbox"
                              checked={aggWhereEnabled}
                              onChange={(e) => {
                                setAggWhereEnabled(e.target.checked);
                                if (e.target.checked && !aggWhereField) {
                                  const tgt = entities.find((m) => m.id === aggTargetModelId);
                                  setAggWhereField(aggItemField || tgt?.fields[0]?.key || "");
                                }
                              }}
                            />
                            WHERE filter
                          </label>
                          {aggWhereEnabled && (
                            <>
                              <input
                                type="text"
                                aria-label="WHERE filter field"
                                value={aggWhereField}
                                onChange={(e) => setAggWhereField(e.target.value)}
                                placeholder="column (e.g. savedCents)"
                                style={{ width: "130px", padding: "3px 6px", borderRadius: "5px", border: "1px solid #fcd34d", fontFamily: "monospace", fontSize: "0.74rem" }}
                              />
                              <select
                                aria-label="WHERE filter operator"
                                value={aggWhereOp}
                                onChange={(e) => setAggWhereOp(e.target.value as SmassAggregateFilterOp)}
                                style={{ padding: "3px 5px", borderRadius: "5px", border: "1px solid #fcd34d", fontFamily: "monospace", fontSize: "0.74rem" }}
                              >
                                {AGGREGATE_FILTER_OPS.map((op) => (
                                  <option key={op} value={op}>{op}</option>
                                ))}
                              </select>
                              <input
                                type="text"
                                aria-label="WHERE filter value"
                                value={aggWhereValue}
                                onChange={(e) => setAggWhereValue(e.target.value)}
                                placeholder="value (e.g. 1500000)"
                                style={{ width: "120px", padding: "3px 6px", borderRadius: "5px", border: "1px solid #fcd34d", fontFamily: "monospace", fontSize: "0.74rem" }}
                              />
                            </>
                          )}
                        </div>
                      </div>
                    ) : aggMode === "array" ? (
                      arrayDraftFields.length === 0 ? (
                        <p style={{ margin: 0, fontSize: "0.74rem", color: "#92400e" }}>
                          Drop an array column (like <code>history</code> from <code>goal.progress.read@1.0.0</code>) into the canvas to aggregate over its entries, or switch to <strong>Across Columns</strong> or <strong>Cross-Entity Rollup</strong>.
                        </p>
                      ) : (
                        <div style={{ display: "grid", gap: "6px" }}>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "6px", alignItems: "center" }}>
                            <select
                              aria-label="Source array column"
                              value={aggSourceField}
                              onChange={(e) => {
                                const nextField = e.target.value;
                                setAggSourceField(nextField);
                                const arr = arrayDraftFields.find((f) => f.key === nextField);
                                const subs = arr ? arrayItemSubfields.get(`${arr.toolRef}::${arr.outputPath}`) ?? [] : [];
                                setAggItemField(subs.find((s) => s.type === "integer" || s.type === "number")?.subPath ?? subs[0]?.subPath ?? "");
                              }}
                              style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #fcd34d", fontFamily: "monospace", fontSize: "0.78rem" }}
                            >
                              {arrayDraftFields.map((f) => (
                                <option key={f.uid} value={f.key}>{f.key} (array)</option>
                              ))}
                            </select>
                            {aggOp !== "count" ? (
                              selectedArraySubfields.length > 0 ? (
                                <select
                                  aria-label="Array item property"
                                  value={aggItemField}
                                  onChange={(e) => setAggItemField(e.target.value)}
                                  style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #fcd34d", fontFamily: "monospace", fontSize: "0.78rem" }}
                                >
                                  <option value="">(whole element)</option>
                                  {selectedArraySubfields.map((sub) => (
                                    <option key={sub.subPath} value={sub.subPath}>
                                      .{sub.subPath} ({sub.type})
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  type="text"
                                  value={aggItemField}
                                  onChange={(e) => setAggItemField(e.target.value)}
                                  placeholder="Item property (optional)"
                                  style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #fcd34d", fontFamily: "monospace", fontSize: "0.78rem" }}
                                />
                              )
                            ) : (
                              <span style={{ fontSize: "0.74rem", color: "#92400e" }}>Counts matching array items</span>
                            )}
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={addAggregateFieldToDraft}
                              style={{ padding: "5px 10px", fontSize: "0.76rem", background: "#d97706", color: "#fff", borderColor: "#d97706", fontWeight: 600 }}
                            >
                              Add aggregate
                            </button>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", fontSize: "0.74rem" }}>
                            <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontWeight: 600, color: "#92400e", cursor: "pointer" }}>
                              <input
                                type="checkbox"
                                checked={aggWhereEnabled}
                                onChange={(e) => {
                                  setAggWhereEnabled(e.target.checked);
                                  if (e.target.checked && !aggWhereField) {
                                    setAggWhereField(aggItemField || selectedArraySubfields[0]?.subPath || "");
                                  }
                                }}
                              />
                              WHERE filter
                            </label>
                            {aggWhereEnabled && (
                              <>
                                <input
                                  type="text"
                                  aria-label="WHERE filter field"
                                  value={aggWhereField}
                                  onChange={(e) => setAggWhereField(e.target.value)}
                                  placeholder="item property (e.g. savedCents)"
                                  style={{ width: "140px", padding: "3px 6px", borderRadius: "5px", border: "1px solid #fcd34d", fontFamily: "monospace", fontSize: "0.74rem" }}
                                />
                                <select
                                  aria-label="WHERE filter operator"
                                  value={aggWhereOp}
                                  onChange={(e) => setAggWhereOp(e.target.value as SmassAggregateFilterOp)}
                                  style={{ padding: "3px 5px", borderRadius: "5px", border: "1px solid #fcd34d", fontFamily: "monospace", fontSize: "0.74rem" }}
                                >
                                  {AGGREGATE_FILTER_OPS.map((op) => (
                                    <option key={op} value={op}>{op}</option>
                                  ))}
                                </select>
                                <input
                                  type="text"
                                  aria-label="WHERE filter value"
                                  value={aggWhereValue}
                                  onChange={(e) => setAggWhereValue(e.target.value)}
                                  placeholder="value (e.g. 1500000)"
                                  style={{ width: "120px", padding: "3px 6px", borderRadius: "5px", border: "1px solid #fcd34d", fontFamily: "monospace", fontSize: "0.74rem" }}
                                />
                              </>
                            )}
                          </div>
                        </div>
                      )
                    ) : (
                      <div style={{ display: "grid", gap: "6px" }}>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
                          {scalarDraftFields.map((col) => {
                            const checked = aggSelectedCols.includes(col.key);
                            return (
                              <label
                                key={col.uid}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "4px",
                                  padding: "3px 8px",
                                  borderRadius: "999px",
                                  border: checked ? "1px solid #d97706" : "1px solid #fcd34d",
                                  background: checked ? "#fef3c7" : "#fff",
                                  fontSize: "0.73rem",
                                  fontFamily: "monospace",
                                  cursor: "pointer",
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) =>
                                    setAggSelectedCols((prev) =>
                                      e.target.checked ? [...prev, col.key] : prev.filter((k) => k !== col.key),
                                    )
                                  }
                                />
                                {col.key}
                              </label>
                            );
                          })}
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end" }}>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={addAggregateFieldToDraft}
                            style={{ padding: "5px 10px", fontSize: "0.76rem", background: "#d97706", color: "#fff", borderColor: "#d97706", fontWeight: 600 }}
                          >
                            Add aggregate
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Relational Normalization Extractor (Hierarchical JSON -> 1:N / 1:1 Child Entity) */}
                {activeComposer === "normalize" && (
                  <div
                    style={{
                      border: "1px solid #a5b4fc",
                      borderRadius: "8px",
                      padding: "10px",
                      background: "#eef2ff",
                      display: "grid",
                      gap: "8px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: "0.82rem", color: "#3730a3", display: "inline-flex", alignItems: "center", gap: "5px" }}>
                        <Split size={14} aria-hidden="true" />
                        Normalize Hierarchical JSON → Relational {normKind === "array" ? "1:N Child Table" : "1:1 Child Entity"}
                      </strong>
                      <button type="button" className="secondary-button" style={{ padding: "2px 6px", fontSize: "0.71rem" }} onClick={() => setActiveComposer("none")}>
                        Cancel
                      </button>
                    </div>
                    <p style={{ margin: 0, fontSize: "0.74rem", color: "#4338ca" }}>
                      Unnests <code>{normToolRef} → {normPath}{normKind === "array" ? "[]" : ""}</code> into a first-class relational <code>smass</code> entity linked via FK to its parent.
                    </p>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                      <label style={{ display: "grid", gap: "2px", fontSize: "0.72rem", fontWeight: 600, color: "#312e81" }}>
                        Child entity name
                        <input
                          type="text"
                          value={normChildLabel}
                          onChange={(e) => setNormChildLabel(e.target.value)}
                          style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #a5b4fc", fontSize: "0.78rem" }}
                        />
                      </label>
                      <label style={{ display: "grid", gap: "2px", fontSize: "0.72rem", fontWeight: 600, color: "#312e81" }}>
                        Child entity ID
                        <input
                          type="text"
                          value={normChildId}
                          onChange={(e) => setNormChildId(e.target.value)}
                          style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #a5b4fc", fontFamily: "monospace", fontSize: "0.78rem" }}
                        />
                      </label>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "6px" }}>
                      <label style={{ display: "grid", gap: "2px", fontSize: "0.72rem", fontWeight: 600, color: "#312e81" }}>
                        Parent entity (FK target)
                        <select
                          value={normParentModelId}
                          onChange={(e) => {
                            const nextParent = e.target.value;
                            setNormParentModelId(nextParent);
                            const pm = entities.find((m) => m.id === nextParent);
                            if (pm?.primaryKey) setNormParentJoinField(pm.primaryKey);
                          }}
                          style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #a5b4fc", fontSize: "0.76rem" }}
                        >
                          <option value="">(standalone unnested table)</option>
                          {entities.map((m) => (
                            <option key={m.id} value={m.id}>{m.id}</option>
                          ))}
                        </select>
                      </label>
                      <label style={{ display: "grid", gap: "2px", fontSize: "0.72rem", fontWeight: 600, color: "#312e81" }}>
                        Parent PK field
                        <input
                          type="text"
                          value={normParentJoinField}
                          onChange={(e) => setNormParentJoinField(e.target.value)}
                          style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #a5b4fc", fontFamily: "monospace", fontSize: "0.76rem" }}
                        />
                      </label>
                      <label style={{ display: "grid", gap: "2px", fontSize: "0.72rem", fontWeight: 600, color: "#312e81" }}>
                        Relation name
                        <input
                          type="text"
                          value={normRelationName}
                          onChange={(e) => setNormRelationName(e.target.value)}
                          style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #a5b4fc", fontFamily: "monospace", fontSize: "0.76rem" }}
                        />
                      </label>
                    </div>
                    <div style={{ display: "grid", gap: "4px" }}>
                      <span style={{ fontSize: "0.71rem", fontWeight: 700, color: "#312e81" }}>
                        Child table columns (renameable):
                      </span>
                      {normSubfields.map((sub, idx) => (
                        <div key={sub.subPath} style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr auto", gap: "6px", alignItems: "center", fontSize: "0.75rem" }}>
                          <input
                            type="checkbox"
                            checked={sub.selected}
                            onChange={(e) => {
                              const selected = e.target.checked;
                              setNormSubfields((prev) => prev.map((s, i) => (i === idx ? { ...s, selected } : s)));
                            }}
                          />
                          <input
                            type="text"
                            value={sub.key}
                            onChange={(e) => {
                              const key = e.target.value;
                              setNormSubfields((prev) => prev.map((s, i) => (i === idx ? { ...s, key } : s)));
                            }}
                            style={{ padding: "3px 6px", borderRadius: "5px", border: "1px solid #c7d2fe", fontFamily: "monospace", fontSize: "0.75rem" }}
                          />
                          <input
                            type="text"
                            value={sub.label}
                            onChange={(e) => {
                              const label = e.target.value;
                              setNormSubfields((prev) => prev.map((s, i) => (i === idx ? { ...s, label } : s)));
                            }}
                            style={{ padding: "3px 6px", borderRadius: "5px", border: "1px solid #c7d2fe", fontSize: "0.75rem" }}
                          />
                          <code style={{ fontSize: "0.7rem", color: "#4338ca" }}>{sub.type}</code>
                        </div>
                      ))}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                      <span style={{ fontSize: "0.71rem", color: "#4338ca" }}>
                        {normKind === "array" ? "Adds surrogate PK (rowIndex) + FK to parent." : "Links 1:1 to parent via principal FK."}
                      </span>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={normalizing}
                        onClick={() => void createRelationalChildModel()}
                        style={{ padding: "5px 12px", fontSize: "0.77rem", background: "#4338ca", color: "#fff", borderColor: "#4338ca", fontWeight: 600 }}
                      >
                        {normalizing ? "Creating…" : "Create Relational Entity"}
                      </button>
                    </div>
                  </div>
                )}

                {/* Manual Relation Composer */}
                {activeComposer === "relation" && (
                  <div
                    style={{
                      border: "1px solid #c7d2fe",
                      borderRadius: "8px",
                      padding: "10px",
                      background: "#f5f7ff",
                      display: "grid",
                      gap: "8px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <strong style={{ fontSize: "0.8rem", color: "#3730a3", display: "inline-flex", alignItems: "center", gap: "5px" }}>
                        <Link2 size={13} aria-hidden="true" />
                        Add Entity Relationship
                      </strong>
                      <button type="button" className="secondary-button" style={{ padding: "2px 6px", fontSize: "0.71rem" }} onClick={() => setActiveComposer("none")}>
                        Cancel
                      </button>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 90px", gap: "6px" }}>
                      <input
                        type="text"
                        value={relName}
                        onChange={(e) => setRelName(e.target.value)}
                        placeholder="Relation name (e.g. belongs_to_customer)"
                        style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #c7d2fe", fontFamily: "monospace", fontSize: "0.76rem" }}
                      />
                      <select
                        aria-label="Target entity"
                        value={relTargetModelId}
                        onChange={(e) => {
                          const target = e.target.value;
                          setRelTargetModelId(target);
                          const tm = entities.find((m) => m.id === target);
                          if (tm?.primaryKey) setRelForeignField(tm.primaryKey);
                        }}
                        style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #c7d2fe", fontSize: "0.76rem" }}
                      >
                        <option value="">Select target model…</option>
                        {entities.map((m) => (
                          <option key={m.id} value={m.id}>{m.id}</option>
                        ))}
                      </select>
                      <select
                        aria-label="Cardinality"
                        value={relCardinality}
                        onChange={(e) => setRelCardinality(e.target.value as SmassRelationCardinality)}
                        style={{ padding: "5px 6px", borderRadius: "6px", border: "1px solid #c7d2fe", fontSize: "0.74rem" }}
                      >
                        <option value="many_to_one">N : 1</option>
                        <option value="one_to_many">1 : N</option>
                        <option value="one_to_one">1 : 1</option>
                        <option value="many_to_many">N : M</option>
                      </select>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "6px", alignItems: "center" }}>
                      <input
                        type="text"
                        value={relLocalField}
                        onChange={(e) => setRelLocalField(e.target.value)}
                        placeholder="Local field (e.g. mid)"
                        style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #c7d2fe", fontFamily: "monospace", fontSize: "0.76rem" }}
                      />
                      <input
                        type="text"
                        value={relForeignField}
                        onChange={(e) => setRelForeignField(e.target.value)}
                        placeholder="Target field (e.g. customerId)"
                        style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid #c7d2fe", fontFamily: "monospace", fontSize: "0.76rem" }}
                      />
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          if (!relTargetModelId || !relName.trim()) {
                            setError("Choose a target entity and relation name.");
                            return;
                          }
                          setDraftRelations((prev) => [
                            ...prev,
                            {
                              name: relName.trim(),
                              targetModelId: relTargetModelId,
                              cardinality: relCardinality,
                              localField: relLocalField.trim() || "mid",
                              foreignField: relForeignField.trim() || "id",
                            },
                          ]);
                          setActiveComposer("none");
                        }}
                        style={{ padding: "5px 10px", fontSize: "0.75rem", background: "#4338ca", color: "#fff", borderColor: "#4338ca", fontWeight: 600 }}
                      >
                        Add relation
                      </button>
                    </div>
                  </div>
                )}

                {draftRelations.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", alignItems: "center", fontSize: "0.73rem" }}>
                    <strong style={{ color: "#3730a3" }}>Relations:</strong>
                    {draftRelations.map((r, idx) => (
                      <span
                        key={`${r.name}-${r.targetModelId}-${idx}`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "4px",
                          padding: "2px 7px",
                          borderRadius: "999px",
                          background: "#e0e7ff",
                          color: "#3730a3",
                        }}
                      >
                        {cardinalityLabel(r.cardinality)} {r.name} → <code>{r.targetModelId}</code> ({r.localField}={r.foreignField})
                        <button
                          type="button"
                          onClick={() => setDraftRelations((prev) => prev.filter((_, i) => i !== idx))}
                          style={{ background: "transparent", border: "none", color: "#3730a3", cursor: "pointer", padding: 0, display: "inline-flex" }}
                          aria-label={`Remove relation ${r.name}`}
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {/* Builder Footer Actions */}
                {activeComposer === "none" && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <div style={{ display: "inline-flex", gap: "6px", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={draftFields.length === 0}
                        onClick={() => setActiveComposer("computed")}
                        style={{ padding: "5px 10px", fontSize: "0.76rem", display: "inline-flex", alignItems: "center", gap: "5px" }}
                      >
                        <Sparkles size={13} aria-hidden="true" />
                        + Add derived column
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={draftFields.length === 0}
                        onClick={openAggregateComposer}
                        style={{ padding: "5px 10px", fontSize: "0.76rem", display: "inline-flex", alignItems: "center", gap: "5px" }}
                      >
                        <Sigma size={13} aria-hidden="true" />
                        + Add aggregate
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={draftFields.length === 0}
                        onClick={() => {
                          setRelTargetModelId(entities[0]?.id ?? "");
                          setRelForeignField(entities[0]?.primaryKey ?? "id");
                          setRelLocalField(draftPrincipalKey || draftFields[0]?.key || "mid");
                          setActiveComposer("relation");
                        }}
                        style={{ padding: "5px 10px", fontSize: "0.76rem", display: "inline-flex", alignItems: "center", gap: "5px" }}
                      >
                        <Link2 size={13} aria-hidden="true" />
                        + Add relation
                      </button>
                    </div>
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
                      {savingModel ? "Saving & Compiling…" : editingPreviousId ? "Update Virtual Model" : "Save Virtual Model"}
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
                  const isDraft = model.status === "draft";
                  const modelDrift = (data.driftIssues ?? []).filter((d) => d.modelId === model.id);
                  const liveSnap = snapshotResults[model.id];
                  return (
                    <article
                      key={model.id}
                      style={{
                        border: modelDrift.length > 0
                          ? "1px solid #fca5a5"
                          : isDraft
                            ? "1px dashed #d97706"
                            : isCustom
                              ? "1px solid #86efac"
                              : "1px solid var(--border, #d4e2da)",
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
                                background: isDraft ? "#fef3c7" : "#dcfce7",
                                color: isDraft ? "#92400e" : "#155331",
                                fontWeight: 700,
                              }}
                            >
                              {isDraft ? "Draft" : "Published VDM"}
                            </span>
                          )}
                          {model.virtualReadToolRef && !isDraft && (
                            <span
                              title="Live compiled sfield read tool — bindable in UI Studio, PZN, CCRE & Agents"
                              style={{
                                fontSize: "0.67rem",
                                padding: "2px 7px",
                                borderRadius: "999px",
                                background: "#ecfeff",
                                color: "#155e75",
                                border: "1px solid #a5f3fc",
                                fontFamily: "monospace",
                                fontWeight: 600,
                              }}
                            >
                              {model.virtualReadToolRef}
                            </span>
                          )}
                          {modelDrift.length > 0 && (
                            <span
                              title={modelDrift.map((d) => d.message).join("; ")}
                              style={{
                                fontSize: "0.67rem",
                                padding: "2px 7px",
                                borderRadius: "999px",
                                background: "#fee2e2",
                                color: "#991b1b",
                                fontWeight: 700,
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "3px",
                              }}
                            >
                              <AlertTriangle size={10} aria-hidden="true" />
                              Drift ({modelDrift.length})
                            </span>
                          )}
                          {model.unnest && (
                            <span
                              style={{
                                fontSize: "0.68rem",
                                padding: "2px 7px",
                                borderRadius: "999px",
                                background: "#e0e7ff",
                                color: "#3730a3",
                                fontWeight: 700,
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "3px",
                              }}
                            >
                              <Split size={10} aria-hidden="true" />
                              Normalized ({model.unnest.path})
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
                                onClick={() => void toggleModelStatus(model.id, isDraft ? "published" : "draft")}
                                style={{
                                  padding: "3px 7px",
                                  fontSize: "0.71rem",
                                  color: isDraft ? "#155331" : "#92400e",
                                  borderColor: isDraft ? "#86efac" : "#fcd34d",
                                }}
                              >
                                {isDraft ? "Publish" : "Set Draft"}
                              </button>
                              <button
                                type="button"
                                className="secondary-button"
                                onClick={() => loadCustomModelIntoBuilder(model.id)}
                                style={{ padding: "3px 7px", fontSize: "0.71rem", display: "inline-flex", alignItems: "center", gap: "3px" }}
                              >
                                <Pencil size={11} aria-hidden="true" />
                                Edit / Rename
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
                            <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                              {domainId === "wealth" && (
                                <select
                                  aria-label="Test customer persona"
                                  value={testCustomerId}
                                  onChange={(e) => {
                                    const nextCust = e.target.value;
                                    setTestCustomerId(nextCust);
                                    void runLiveSnapshotTest(model.id, testRedactPii, nextCust);
                                  }}
                                  style={{ padding: "2px 6px", borderRadius: "5px", background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", fontSize: "0.7rem" }}
                                >
                                  {WEALTH_PERSONAS.map((p) => (
                                    <option key={p.id} value={p.id}>{p.label}</option>
                                  ))}
                                </select>
                              )}
                              <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", cursor: "pointer", fontSize: "0.71rem" }}>
                                <input
                                  type="checkbox"
                                  checked={testRedactPii}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    setTestRedactPii(checked);
                                    void runLiveSnapshotTest(model.id, checked, testCustomerId);
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
                          {liveSnap.status === "ok" && liveSnap.rows && liveSnap.rows.length > 0 && (
                            <div style={{ overflowX: "auto", border: "1px solid #334155", borderRadius: "6px" }}>
                              <div style={{ padding: "4px 8px", background: "#1e293b", color: "#a5b4fc", fontSize: "0.7rem", fontWeight: 700 }}>
                                Normalized Relational Table ({liveSnap.rows.length} row{liveSnap.rows.length === 1 ? "" : "s"})
                              </div>
                              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.72rem" }}>
                                <thead>
                                  <tr style={{ background: "#1e293b", color: "#cbd5e1", textAlign: "left" }}>
                                    {Object.keys(liveSnap.rows[0]!).map((col) => (
                                      <th key={col} style={{ padding: "4px 8px", borderBottom: "1px solid #334155", fontFamily: "monospace" }}>
                                        {col}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {liveSnap.rows.map((row, rIdx) => (
                                    <tr key={rIdx} style={{ borderBottom: "1px solid #1e293b" }}>
                                      {Object.keys(liveSnap.rows![0]!).map((col) => (
                                        <td key={col} style={{ padding: "4px 8px", fontFamily: "monospace", color: "#e2e8f0" }}>
                                          {typeof row[col] === "object" && row[col] !== null ? JSON.stringify(row[col]) : String(row[col] ?? "")}
                                        </td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                          <pre style={{ margin: 0, overflowX: "auto", maxHeight: "240px", lineHeight: 1.45 }}>
                            {JSON.stringify(
                              liveSnap.status === "ok"
                                ? liveSnap.rows
                                  ? { rowCount: liveSnap.rowCount, dataVersions: liveSnap.dataVersions, rows: liveSnap.rows }
                                  : { dataVersions: liveSnap.dataVersions, data: liveSnap.data }
                                : { requiredVersions: liveSnap.requiredVersions, observedVersions: liveSnap.observedVersions },
                              null,
                              2,
                            )}
                          </pre>
                        </div>
                      )}

                      <div style={{ display: "grid", gap: "4px" }}>
                        <span style={{ fontSize: "0.73rem", fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                          Entity Schema ({model.fields.length} columns)
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
                                  {field.aggregate && (
                                    <span style={{ fontSize: "0.66rem", padding: "1px 5px", borderRadius: "4px", background: "#fef3c7", color: "#92400e", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: "3px" }}>
                                      <Sigma size={10} aria-hidden="true" />
                                      aggregate
                                    </span>
                                  )}
                                  {field.computed && (
                                    <span style={{ fontSize: "0.66rem", padding: "1px 5px", borderRadius: "4px", background: "#f3e8ff", color: "#6b21a8", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: "3px" }}>
                                      <Sparkles size={10} aria-hidden="true" />
                                      derived
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
                              {field.aggregate && (
                                <span style={{ fontSize: "0.71rem", color: "#92400e" }}>
                                  Aggregate: <code>{formatAggregateSummary(field.aggregate)}</code>
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
