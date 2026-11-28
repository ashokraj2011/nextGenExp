import { useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  Database,
  Download,
  GitFork,
  GripVertical,
  KeyRound,
  LayoutGrid,
  Link2,
  Maximize2,
  Minus,
  PanelLeft,
  Pencil,
  Play,
  Plus,
  Search,
  Sigma,
  Sparkles,
  Split,
  Trash2,
  Wand2,
  Wrench,
  X,
} from "lucide-react";
import { DOMAIN_PACKS, getDomainPack, type DomainPackId } from "../../packages/contracts/domain-packs";
import type {
  SmassDataModelRelationEdge,
  SmassModelStatus,
  SmassModelSummary,
  SmassRelationCardinality,
  SmassVirtualSnapshotResult,
} from "../../packages/smass";
import { api, toolSetupErrorMessage } from "./api";
import { DomainToolsAndModelPanel } from "./domain-tools-model";
import "./er-modeler-canvas.css";

type DomainWorkbenchData = Awaited<ReturnType<typeof api.domainModels>>;
type StudioTab = "canvas" | "builder" | "mermaid" | "json_schema";

type NodePos = { x: number; y: number };

type SuggestedRelation = {
  key: string;
  sourceModelId: string;
  targetModelId: string;
  name: string;
  cardinality: SmassRelationCardinality;
  localField: string;
  foreignField: string;
  reason: string;
};

type ConnectDraft = {
  sourceModelId: string;
  localField: string;
  targetModelId: string;
  foreignField: string;
  cardinality: SmassRelationCardinality;
  name: string;
};

type DragToolPayload =
  | { kind: "tool"; toolRef: string }
  | { kind: "nested_array"; toolRef: string; path: string }
  | { kind: "field"; toolRef: string; path: string; type: string; label: string };

const NODE_WIDTH = 272;
const HEADER_HEIGHT = 48;
const COL_HEIGHT = 29;
const DRAG_MIME = "application/x-smass-er-item";
const WEALTH_PERSONAS = [
  { id: "demo-learner", label: "Alice Morgan" },
  { id: "demo-returning", label: "Jordan Lee" },
  { id: "demo-new-account", label: "Marcus Reed" },
] as const;

function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function posStorageKey(domainId: DomainPackId) {
  return `smass.er.positions.v1.${domainId}`;
}

function loadSavedPositions(domainId: DomainPackId): Record<string, NodePos> {
  try {
    const raw = localStorage.getItem(posStorageKey(domainId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, NodePos>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function savePositions(domainId: DomainPackId, positions: Record<string, NodePos>) {
  try {
    localStorage.setItem(posStorageKey(domainId), JSON.stringify(positions));
  } catch {
    // ignore storage quota errors
  }
}

function prettifyName(raw: string): string {
  const leaf = raw.split(".").at(-1) ?? raw;
  return leaf
    .replace(/Cents$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function sanitizeIdentifier(raw: string): string {
  const leaf = raw.split(".").at(-1) ?? raw;
  return leaf.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[^a-zA-Z_]+/, "") || "field";
}

function cardinalityLabel(c: SmassRelationCardinality): string {
  switch (c) {
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

function computeAutoLayout(
  entities: readonly SmassModelSummary[],
  relations: readonly SmassDataModelRelationEdge[],
): Record<string, NodePos> {
  // Rank entities by connectivity so the hub entity (e.g. Wealth Customer) sits centered on the left
  // and child entities fan out in clean spacious columns with generous room for crow's-foot edge labels.
  const degree = new Map<string, number>();
  for (const e of entities) degree.set(e.id, 0);
  for (const r of relations) {
    degree.set(r.sourceModelId, (degree.get(r.sourceModelId) ?? 0) + 1);
    degree.set(r.targetModelId, (degree.get(r.targetModelId) ?? 0) + 2);
  }
  const sorted = [...entities].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));
  const out: Record<string, NodePos> = {};
  if (sorted.length === 0) return out;

  // Place hub entity in Column 0, remaining entities distributed across Column 1 (and Column 2 if >4 entities)
  const hub = sorted[0]!;
  const rest = sorted.slice(1);
  const rightCols = rest.length <= 3 ? 1 : 2;
  const colY = Array.from({ length: rightCols }, () => 44);

  rest.forEach((entity, i) => {
    const colIdx = i % rightCols;
    const x = 455 + colIdx * 435;
    const y = colY[colIdx]!;
    out[entity.id] = { x, y };
    const estH = HEADER_HEIGHT + entity.fields.length * COL_HEIGHT + 52;
    colY[colIdx] = y + Math.max(200, estH);
  });

  const maxRightH = Math.max(...colY, 260);
  const hubH = HEADER_HEIGHT + hub.fields.length * COL_HEIGHT + 30;
  out[hub.id] = { x: 36, y: Math.max(44, Math.round((maxRightH - hubH) / 2) - 24) };
  return out;
}

/**
 * Automatic ER relationship detector: inspects column names, PKs, principalKeys,
 * `<entity>Id` naming conventions, and `unnest` parent-child metadata across all entities.
 */
function detectSuggestedRelations(
  entities: readonly SmassModelSummary[],
  existingRelations: readonly SmassDataModelRelationEdge[],
): SuggestedRelation[] {
  const existingPairSet = new Set<string>();
  for (const r of existingRelations) {
    existingPairSet.add(`${r.sourceModelId}|${r.targetModelId}|${r.localField}|${r.foreignField}`);
    existingPairSet.add(`${r.targetModelId}|${r.sourceModelId}|${r.foreignField}|${r.localField}`);
    existingPairSet.add(`${r.sourceModelId}|${r.targetModelId}`);
    existingPairSet.add(`${r.targetModelId}|${r.sourceModelId}`);
  }

  const suggestions: SuggestedRelation[] = [];
  const seenPairs = new Set<string>();

  for (const source of entities) {
    for (const target of entities) {
      if (source.id === target.id) continue;
      const pairKey = [source.id, target.id].sort().join("::");
      if (seenPairs.has(pairKey) || existingPairSet.has(`${source.id}|${target.id}`)) continue;

      const targetSlug = (target.id.split(".").at(-1) ?? target.id).toLowerCase();
      const targetPk = target.fields.find((f) => f.primaryKey || f.key === target.primaryKey);

      let matched: { localField: string; foreignField: string; cardinality: SmassRelationCardinality; reason: string } | null = null;

      // 1. Explicit unnest parent match
      if (source.unnest?.parentModelId === target.id) {
        const localPrincipal = source.fields.find((f) => f.principalKey) ?? source.fields[0];
        const targetJoin = targetPk ?? target.fields.find((f) => f.principalKey) ?? target.fields[0];
        if (localPrincipal && targetJoin) {
          matched = {
            localField: localPrincipal.key,
            foreignField: targetJoin.key,
            cardinality: "many_to_one",
            reason: `Unnested child of ${target.label}`,
          };
        }
      }

      // 2. Exact PK/column name match (e.g. customerId = customerId, serviceId = serviceId, goalId = goalId)
      if (!matched && targetPk) {
        const sameNameField = source.fields.find(
          (f) => f.key.toLowerCase() === targetPk.key.toLowerCase() && f.key.toLowerCase() !== "id",
        );
        if (sameNameField) {
          matched = {
            localField: sameNameField.key,
            foreignField: targetPk.key,
            cardinality: sameNameField.primaryKey ? "one_to_one" : "many_to_one",
            reason: `Matching key "${sameNameField.key}"`,
          };
        }
      }

      // 3. Naming convention `<targetSlug>Id` or `<targetSlug>_id` -> target.pk
      if (!matched && targetPk) {
        const fkField = source.fields.find((f) => {
          const lower = f.key.toLowerCase();
          return lower === `${targetSlug}id` || lower === `${targetSlug}_id`;
        });
        if (fkField) {
          matched = {
            localField: fkField.key,
            foreignField: targetPk.key,
            cardinality: "many_to_one",
            reason: `Foreign key name "${fkField.key}" → ${target.id}.${targetPk.key}`,
          };
        }
      }

      // 4. Shared principalKey (e.g. `mid` on both entities -> join on principal identity)
      if (!matched) {
        const srcPrincipal = source.fields.find((f) => f.principalKey);
        const tgtPrincipal = target.fields.find((f) => f.principalKey && f.principalKey === srcPrincipal?.principalKey);
        if (srcPrincipal && tgtPrincipal && (tgtPrincipal.primaryKey || target.id.endsWith(".customer"))) {
          matched = {
            localField: srcPrincipal.key,
            foreignField: tgtPrincipal.key,
            cardinality: srcPrincipal.primaryKey && tgtPrincipal.primaryKey ? "one_to_one" : "many_to_one",
            reason: `Shared principal.${srcPrincipal.principalKey}`,
          };
        }
      }

      if (matched) {
        seenPairs.add(pairKey);
        suggestions.push({
          key: `${source.id}->${target.id}:${matched.localField}=${matched.foreignField}`,
          sourceModelId: source.id,
          targetModelId: target.id,
          name: `belongs_to_${targetSlug.replace(/[^a-z0-9_]/g, "_")}`,
          cardinality: matched.cardinality,
          localField: matched.localField,
          foreignField: matched.foreignField,
          reason: matched.reason,
        });
      }
    }
  }
  return suggestions;
}

function colYOffset(entity: SmassModelSummary, fieldKey: string): number {
  const idx = entity.fields.findIndex((f) => f.key === fieldKey);
  const clamped = idx >= 0 ? idx : 0;
  return HEADER_HEIGHT + 4 + clamped * COL_HEIGHT + COL_HEIGHT / 2;
}

function buildEdgeGeometry(
  srcPos: NodePos,
  srcEntity: SmassModelSummary,
  srcField: string,
  tgtPos: NodePos,
  tgtEntity: SmassModelSummary,
  tgtField: string,
) {
  const y1 = srcPos.y + colYOffset(srcEntity, srcField);
  const y2 = tgtPos.y + colYOffset(tgtEntity, tgtField);

  let x1: number;
  let x2: number;
  let c1x: number;
  let c2x: number;
  let dir1: 1 | -1;
  let dir2: 1 | -1;

  if (srcPos.x + NODE_WIDTH + 30 < tgtPos.x) {
    x1 = srcPos.x + NODE_WIDTH;
    x2 = tgtPos.x;
    const dx = Math.max(55, (x2 - x1) * 0.45);
    c1x = x1 + dx;
    c2x = x2 - dx;
    dir1 = 1;
    dir2 = -1;
  } else if (tgtPos.x + NODE_WIDTH + 30 < srcPos.x) {
    x1 = srcPos.x;
    x2 = tgtPos.x + NODE_WIDTH;
    const dx = Math.max(55, (x1 - x2) * 0.45);
    c1x = x1 - dx;
    c2x = x2 + dx;
    dir1 = -1;
    dir2 = 1;
  } else {
    // Stacked vertically: loop cleanly along the right side
    x1 = srcPos.x + NODE_WIDTH;
    x2 = tgtPos.x + NODE_WIDTH;
    const bulge = Math.max(x1, x2) + 75;
    c1x = bulge;
    c2x = bulge;
    dir1 = 1;
    dir2 = 1;
  }

  const d = `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`;
  // Cubic Bézier midpoint at t = 0.5
  const mx = 0.125 * x1 + 0.375 * c1x + 0.375 * c2x + 0.125 * x2;
  const my = 0.125 * y1 + 0.375 * y1 + 0.375 * y2 + 0.125 * y2;
  return { d, x1, y1, x2, y2, mx, my, dir1, dir2 };
}

function CrowsFootEnd({
  x,
  y,
  dir,
  many,
  color,
}: {
  x: number;
  y: number;
  dir: 1 | -1;
  many: boolean;
  color: string;
}) {
  // `dir` points AWAY from the entity border along the line
  if (many) {
    const base = x + dir * 13;
    return (
      <g stroke={color} strokeWidth={2} fill="none">
        <line x1={base} y1={y} x2={x} y2={y - 7} />
        <line x1={base} y1={y} x2={x} y2={y} />
        <line x1={base} y1={y} x2={x} y2={y + 7} />
        <circle cx={base + dir * 3} cy={y} r={3} fill="#fff" />
      </g>
    );
  }
  const t1 = x + dir * 6;
  const t2 = x + dir * 11;
  return (
    <g stroke={color} strokeWidth={2} fill="none">
      <line x1={t1} y1={y - 6} x2={t1} y2={y + 6} />
      <line x1={t2} y1={y - 6} x2={t2} y2={y + 6} />
    </g>
  );
}

export function ErModelerStudio({
  domainId,
  onSelectDomain,
}: {
  domainId: DomainPackId;
  onSelectDomain: (domainId: DomainPackId) => void;
}) {
  const [tab, setTab] = useState<StudioTab>("canvas");
  const [data, setData] = useState<DomainWorkbenchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [positions, setPositions] = useState<Record<string, NodePos>>({});
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [copied, setCopied] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [builderEditModelId, setBuilderEditModelId] = useState<string | null>(null);
  const [confirmDeleteModelId, setConfirmDeleteModelId] = useState<string | null>(null);
  const [isPanning, setIsPanning] = useState(false);

  // Selection state (either an Entity or a Relationship edge)
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [selectedRelation, setSelectedRelation] = useState<SmassDataModelRelationEdge | null>(null);

  // Canvas drag & drop state (from Tool Palette)
  const [canvasDragOver, setCanvasDragOver] = useState(false);
  const [dropTargetEntityId, setDropTargetEntityId] = useState<string | null>(null);
  const activeToolDragRef = useRef<DragToolPayload | null>(null);

  // Entity node pointer-drag & background canvas pan state
  const draggingNodeRef = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const panningRef = useRef<{ startX: number; startY: number; origScrollLeft: number; origScrollTop: number; moved: boolean } | null>(null);
  const suppressNextCanvasClickRef = useRef(false);

  // Manual column-to-column drag-to-connect state
  const [connecting, setConnecting] = useState<{
    sourceModelId: string;
    localField: string;
    x1: number;
    y1: number;
    curX: number;
    curY: number;
  } | null>(null);
  const connectingRef = useRef<{
    sourceModelId: string;
    localField: string;
    x1: number;
    y1: number;
    curX: number;
    curY: number;
  } | null>(null);
  const [connectDraft, setConnectDraft] = useState<ConnectDraft | null>(null);
  const [savingRelation, setSavingRelation] = useState(false);

  // Live 1x snapshot preview in inspector
  const [testingSnapshot, setTestingSnapshot] = useState(false);
  const [testCustomerId, setTestCustomerId] = useState<string>("demo-learner");
  const [redactPii, setRedactPii] = useState(false);
  const [liveSnap, setLiveSnap] = useState<SmassVirtualSnapshotResult | null>(null);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

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
    setSelectedEntityId(null);
    setSelectedRelation(null);
    setBuilderEditModelId(null);
    setConfirmDeleteModelId(null);
    setSearchQuery("");
    setLiveSnap(null);
    setNotice("");
    setError("");
    setPositions(loadSavedPositions(domainId));
    void refresh();
  }, [domainId]);

  const entities = data?.dataModel?.entities ?? data?.models ?? [];
  const rawRelations = data?.dataModel?.relations ?? [];
  // Deduplicate inverse bidirectional edges (e.g. customer -> goal AND goal -> customer on same keys) for clean ER display
  const relations = useMemo(() => {
    const out: SmassDataModelRelationEdge[] = [];
    const seenPairs = new Set<string>();
    for (const rel of rawRelations) {
      const pairKey = [
        `${rel.sourceModelId}.${rel.localField}`,
        `${rel.targetModelId}.${rel.foreignField}`,
      ].sort().join("<->");
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      out.push(rel);
    }
    return out;
  }, [rawRelations]);
  const customModelIdSet = useMemo(() => new Set(data?.customModelIds ?? []), [data?.customModelIds]);

  const driftByModel = useMemo(() => {
    const map = new Map<string, Array<{ fieldKey?: string; toolRef?: string; outputPath?: string; message: string }>>();
    for (const issue of data?.driftIssues ?? []) {
      const list = map.get(issue.modelId) ?? [];
      list.push(issue);
      map.set(issue.modelId, list);
    }
    return map;
  }, [data?.driftIssues]);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const matchedEntityIds = useMemo(() => {
    if (!normalizedSearch) return null;
    const set = new Set<string>();
    for (const e of entities) {
      if (
        e.id.toLowerCase().includes(normalizedSearch) ||
        e.label.toLowerCase().includes(normalizedSearch) ||
        e.fields.some(
          (f) =>
            f.key.toLowerCase().includes(normalizedSearch) ||
            f.label.toLowerCase().includes(normalizedSearch),
        )
      ) {
        set.add(e.id);
      }
    }
    return set;
  }, [entities, normalizedSearch]);

  // Ensure every entity has a layout coordinate
  const effectivePositions = useMemo(() => {
    const auto = computeAutoLayout(entities, relations);
    const merged: Record<string, NodePos> = {};
    for (const e of entities) {
      merged[e.id] = positions[e.id] ?? auto[e.id] ?? { x: 60, y: 60 };
    }
    return merged;
  }, [entities, relations, positions]);

  const suggestedRelations = useMemo(
    () => detectSuggestedRelations(entities, relations),
    [entities, relations],
  );

  // Array subfields map for palette 1:N nested drag items
  const arraySubfields = useMemo(() => {
    const map = new Map<string, Array<{ subPath: string; type: string }>>();
    for (const tool of data?.tools ?? []) {
      for (const f of tool.outputFields) {
        const idx = f.path.indexOf("[].");
        if (idx < 0) continue;
        const arrPath = f.path.slice(0, idx);
        const subPath = f.path.slice(idx + 3);
        const key = `${tool.toolRef}::${arrPath}`;
        const list = map.get(key) ?? [];
        list.push({ subPath, type: f.type });
        map.set(key, list);
      }
    }
    return map;
  }, [data?.tools]);

  const stageSize = useMemo(() => {
    let maxX = 1100;
    let maxY = 760;
    for (const e of entities) {
      const p = effectivePositions[e.id];
      if (!p) continue;
      maxX = Math.max(maxX, p.x + NODE_WIDTH + 180);
      maxY = Math.max(maxY, p.y + HEADER_HEIGHT + e.fields.length * COL_HEIGHT + 180);
    }
    return { width: maxX, height: maxY };
  }, [entities, effectivePositions]);

  // Window pointer handlers for smooth node dragging, background drag-to-pan, and drag-to-connect rubber band
  useEffect(() => {
    function handlePointerMove(e: PointerEvent) {
      if (draggingNodeRef.current) {
        const d = draggingNodeRef.current;
        const nx = Math.max(16, Math.round(d.origX + (e.clientX - d.startX) / zoom));
        const ny = Math.max(16, Math.round(d.origY + (e.clientY - d.startY) / zoom));
        setPositions((prev) => ({ ...prev, [d.id]: { x: nx, y: ny } }));
      } else if (panningRef.current && viewportRef.current) {
        const p = panningRef.current;
        const dx = e.clientX - p.startX;
        const dy = e.clientY - p.startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) p.moved = true;
        viewportRef.current.scrollLeft = Math.max(0, p.origScrollLeft - dx);
        viewportRef.current.scrollTop = Math.max(0, p.origScrollTop - dy);
      } else if (connectingRef.current && stageRef.current) {
        const rect = stageRef.current.getBoundingClientRect();
        const curX = (e.clientX - rect.left) / zoom;
        const curY = (e.clientY - rect.top) / zoom;
        const updated = { ...connectingRef.current, curX, curY };
        connectingRef.current = updated;
        setConnecting(updated);
      }
    }

    function handlePointerUp(e: PointerEvent) {
      if (draggingNodeRef.current) {
        draggingNodeRef.current = null;
        setPositions((latest) => {
          savePositions(domainId, latest);
          return latest;
        });
      }
      if (panningRef.current) {
        if (panningRef.current.moved) {
          suppressNextCanvasClickRef.current = true;
        }
        panningRef.current = null;
        setIsPanning(false);
      }
      const activeConn = connectingRef.current;
      if (activeConn) {
        connectingRef.current = null;
        setConnecting(null);
        // Check if released over another entity's column or card
        const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        const colEl = el?.closest("[data-er-col]") as HTMLElement | null;
        const nodeEl = el?.closest("[data-er-entity]") as HTMLElement | null;
        const targetModelId = colEl?.dataset.erEntity ?? nodeEl?.dataset.erEntity;
        if (targetModelId && targetModelId !== activeConn.sourceModelId) {
          const targetEntity = entities.find((m) => m.id === targetModelId);
          const sourceEntity = entities.find((m) => m.id === activeConn.sourceModelId);
          const foreignField =
            colEl?.dataset.erCol ??
            targetEntity?.primaryKey ??
            targetEntity?.fields[0]?.key ??
            "id";
          const srcFieldSpec = sourceEntity?.fields.find((f) => f.key === activeConn.localField);
          const tgtFieldSpec = targetEntity?.fields.find((f) => f.key === foreignField);
          const cardinality: SmassRelationCardinality =
            srcFieldSpec?.primaryKey && tgtFieldSpec?.primaryKey
              ? "one_to_one"
              : tgtFieldSpec?.primaryKey
                ? "many_to_one"
                : srcFieldSpec?.primaryKey
                  ? "one_to_many"
                  : "many_to_one";
          const tgtSlug = (targetModelId.split(".").at(-1) ?? "target").replace(/[^a-z0-9_]/gi, "_");
          setConnectDraft({
            sourceModelId: activeConn.sourceModelId,
            localField: activeConn.localField,
            targetModelId,
            foreignField,
            cardinality,
            name: `links_to_${tgtSlug}`,
          });
        }
      }
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [domainId, entities, zoom]);

  function startCanvasPan(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".er-entity-node, .er-edge-label, .er-floating-banner, .er-canvas-footer, button, input, select")) {
      return;
    }
    if (!viewportRef.current) return;
    panningRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origScrollLeft: viewportRef.current.scrollLeft,
      origScrollTop: viewportRef.current.scrollTop,
      moved: false,
    };
    setIsPanning(true);
  }

  function startNodeDrag(e: ReactPointerEvent<HTMLDivElement>, entityId: string) {
    if ((e.target as HTMLElement).closest("button")) return;
    e.stopPropagation();
    const cur = effectivePositions[entityId] ?? { x: 60, y: 60 };
    draggingNodeRef.current = { id: entityId, startX: e.clientX, startY: e.clientY, origX: cur.x, origY: cur.y };
    setSelectedEntityId(entityId);
    setSelectedRelation(null);
    setConfirmDeleteModelId(null);
    setLiveSnap(null);
  }

  function startPortConnect(e: ReactPointerEvent<HTMLSpanElement>, entity: SmassModelSummary, fieldKey: string, side: "left" | "right") {
    e.stopPropagation();
    e.preventDefault();
    const pos = effectivePositions[entity.id] ?? { x: 60, y: 60 };
    const x1 = side === "right" ? pos.x + NODE_WIDTH : pos.x;
    const y1 = pos.y + colYOffset(entity, fieldKey);
    const next = {
      sourceModelId: entity.id,
      localField: fieldKey,
      x1,
      y1,
      curX: x1,
      curY: y1,
    };
    connectingRef.current = next;
    setConnecting(next);
  }

  function startPaletteDrag(e: DragEvent<HTMLElement>, payload: DragToolPayload) {
    activeToolDragRef.current = payload;
    const raw = JSON.stringify(payload);
    e.dataTransfer.setData(DRAG_MIME, raw);
    e.dataTransfer.setData("text/plain", raw);
    e.dataTransfer.effectAllowed = "copy";
  }

  function parseDropPayload(e: DragEvent<HTMLElement>): DragToolPayload | null {
    const raw = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData("text/plain");
    if (raw) {
      try {
        return JSON.parse(raw) as DragToolPayload;
      } catch {
        // fallback below
      }
    }
    return activeToolDragRef.current;
  }

  /**
   * Drops a tool or nested array directly onto the ER Canvas:
   * 1. Auto-creates the Virtual Entity (or 1:N Normalized Child Table)
   * 2. Places it at the dropped (x, y) canvas position
   * 3. Automatically detects matching column names / PKs / principalKey and creates relationships!
   */
  async function spawnEntityFromPalette(payload: DragToolPayload, dropPos?: NodePos) {
    const tool = data?.tools.find((t) => t.toolRef === payload.toolRef);
    if (!tool) return;

    setError("");
    setNotice("");

    try {
      let newModelId = "";
      let nextData: DomainWorkbenchData;

      if (payload.kind === "nested_array") {
        const subs = arraySubfields.get(`${tool.toolRef}::${payload.path}`) ?? [];
        if (subs.length === 0) return;
        const baseSlug = `${sanitizeIdentifier(payload.path)}_table`;
        newModelId = `${domainId}.${baseSlug}`;
        let suffix = 2;
        while (entities.some((e) => e.id === newModelId)) {
          newModelId = `${domainId}.${baseSlug}_${suffix++}`;
        }
        const parentEntity = entities.find((m) => m.toolRefs.includes(tool.toolRef)) ?? entities[0];
        const joinKey = domainId === "wealth" ? "mid" : "";
        const parentPk = parentEntity?.primaryKey ?? "id";

        nextData = await api.saveDomainModel(domainId, {
          id: newModelId,
          version: "1.0.0",
          label: `${prettifyName(payload.path)} Table`,
          description: `Auto-normalized 1:N relational child entity from ${tool.toolRef} → ${payload.path}[].`,
          primaryKey: "rowIndex",
          ...(joinKey ? { principalKey: joinKey } : {}),
          unnest: {
            toolRef: tool.toolRef,
            path: payload.path,
            ...(parentEntity ? { parentModelId: parentEntity.id, parentJoinField: parentPk } : {}),
            indexField: "rowIndex",
          },
          fields: subs.map((s) => ({
            kind: "mapped" as const,
            key: sanitizeIdentifier(s.subPath),
            label: prettifyName(s.subPath),
            toolRef: tool.toolRef,
            outputPath: `${payload.path}[].${s.subPath}`,
            classification: "internal" as const,
            required: false,
            exposed: true,
          })),
          ...(parentEntity && joinKey
            ? {
                relations: [
                  {
                    name: `belongs_to_${(parentEntity.id.split(".").at(-1) ?? "parent").replace(/[^a-z0-9_]/gi, "_")}`,
                    targetModelId: parentEntity.id,
                    cardinality: "many_to_one" as const,
                    localField: joinKey,
                    foreignField: parentPk,
                  },
                ],
              }
            : {}),
        });
        setNotice(`Dropped 1:N entity "${newModelId}" and auto-linked to ${parentEntity?.id ?? "canvas"}!`);
      } else {
        const fieldsToMap =
          payload.kind === "field"
            ? tool.outputFields.filter((f) => f.path === payload.path)
            : tool.outputFields.filter((f) => !f.path.includes("[]"));
        if (fieldsToMap.length === 0) return;

        const baseSlug = tool.id.replace(/\.read$/, "").replace(/[^a-z0-9]+/gi, "_").toLowerCase();
        newModelId = `${domainId}.${baseSlug}_view`;
        let suffix = 2;
        while (entities.some((e) => e.id === newModelId)) {
          newModelId = `${domainId}.${baseSlug}_view_${suffix++}`;
        }

        const principalKey = domainId === "wealth" ? "mid" : undefined;
        const pkCandidate = fieldsToMap.find((f) => /Id$/.test(f.path) || f.path === "id")?.path;
        const mappedFields = fieldsToMap.map((f) => ({
          kind: "mapped" as const,
          key: sanitizeIdentifier(f.path),
          label: prettifyName(f.path),
          toolRef: tool.toolRef,
          outputPath: f.path,
          classification: /email|ssn|phone|name/i.test(f.path) ? ("pii" as const) : ("internal" as const),
          required: false,
          exposed: true,
        }));

        // Auto-detect matching relationships by column name / PK / principalKey BEFORE saving!
        const autoRelations: Array<{
          name: string;
          targetModelId: string;
          cardinality: SmassRelationCardinality;
          localField: string;
          foreignField: string;
        }> = [];
        const allLocalKeys = new Set([
          ...mappedFields.map((f) => f.key),
          ...(principalKey ? [principalKey] : []),
        ]);

        for (const existing of entities) {
          const targetPk = existing.fields.find((f) => f.primaryKey || f.key === existing.primaryKey);
          const targetSlug = (existing.id.split(".").at(-1) ?? existing.id).toLowerCase();
          if (targetPk && allLocalKeys.has(targetPk.key) && targetPk.key.toLowerCase() !== "id") {
            autoRelations.push({
              name: `belongs_to_${targetSlug.replace(/[^a-z0-9_]/g, "_")}`,
              targetModelId: existing.id,
              cardinality: "many_to_one",
              localField: targetPk.key,
              foreignField: targetPk.key,
            });
          } else if (principalKey) {
            const existingPrincipal = existing.fields.find((f) => f.principalKey === principalKey && f.primaryKey);
            if (existingPrincipal) {
              autoRelations.push({
                name: `belongs_to_${targetSlug.replace(/[^a-z0-9_]/g, "_")}`,
                targetModelId: existing.id,
                cardinality: "many_to_one",
                localField: principalKey,
                foreignField: existingPrincipal.key,
              });
            }
          }
        }

        nextData = await api.saveDomainModel(domainId, {
          id: newModelId,
          version: "1.0.0",
          label: prettifyName(baseSlug),
          description: `Virtual ER entity composed by dropping ${tool.toolRef} onto the canvas.`,
          primaryKey: pkCandidate ? sanitizeIdentifier(pkCandidate) : principalKey ?? mappedFields[0]!.key,
          ...(principalKey ? { principalKey } : {}),
          fields: mappedFields,
          ...(autoRelations.length ? { relations: autoRelations.slice(0, 3) } : {}),
        });

        setNotice(
          autoRelations.length > 0
            ? `Created "${newModelId}" & auto-detected ${autoRelations.slice(0, 3).length} relationship(s) (${autoRelations.slice(0, 3).map((r) => `${r.localField}=${r.foreignField}`).join(", ")})!`
            : `Created entity "${newModelId}" on canvas — drag any column port to link it to another entity.`,
        );
      }

      setData(nextData);
      if (dropPos && newModelId) {
        setPositions((prev) => {
          const next = { ...effectivePositions, ...prev, [newModelId]: dropPos };
          savePositions(domainId, next);
          return next;
        });
      }
      setSelectedEntityId(newModelId);
      setSelectedRelation(null);
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    }
  }

  async function appendFieldToCustomEntity(entityId: string, payload: DragToolPayload) {
    if (payload.kind !== "field") return;
    const custom = data?.customModels.find((m) => m.id === entityId);
    if (!custom) {
      setError(`"${entityId}" is a built-in canonical entity. Drop onto the empty canvas to create a new virtual entity.`);
      return;
    }
    const newKey = sanitizeIdentifier(payload.path);
    if (custom.fields.some((f) => f.key === newKey)) {
      setNotice(`Column "${newKey}" is already on ${entityId}.`);
      return;
    }
    try {
      const next = await api.saveDomainModel(domainId, {
        ...custom,
        fields: [
          ...custom.fields,
          {
            kind: "mapped",
            key: newKey,
            label: prettifyName(payload.path),
            toolRef: payload.toolRef,
            outputPath: payload.path,
            classification: "internal",
            required: false,
            exposed: true,
          },
        ],
      });
      setData(next);
      setNotice(`Added "${newKey}" (${payload.toolRef} → ${payload.path}) to ${entityId}.`);
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    }
  }

  function handleCanvasDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setCanvasDragOver(false);
    setDropTargetEntityId(null);
    const payload = parseDropPayload(e);
    activeToolDragRef.current = null;
    if (!payload) return;

    let dropPos: NodePos = { x: 420, y: 120 };
    if (stageRef.current) {
      const rect = stageRef.current.getBoundingClientRect();
      dropPos = {
        x: Math.max(24, Math.round((e.clientX - rect.left) / zoom - NODE_WIDTH / 2)),
        y: Math.max(24, Math.round((e.clientY - rect.top) / zoom - 24)),
      };
    }
    void spawnEntityFromPalette(payload, dropPos);
  }

  async function acceptSuggestedRelation(suggestion: SuggestedRelation) {
    setSavingRelation(true);
    setError("");
    try {
      const next = await api.saveDomainRelation(domainId, {
        sourceModelId: suggestion.sourceModelId,
        targetModelId: suggestion.targetModelId,
        name: suggestion.name,
        cardinality: suggestion.cardinality,
        localField: suggestion.localField,
        foreignField: suggestion.foreignField,
      });
      setData(next);
      setNotice(`Connected ${suggestion.sourceModelId}.${suggestion.localField} → ${suggestion.targetModelId}.${suggestion.foreignField} (${cardinalityLabel(suggestion.cardinality)}).`);
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setSavingRelation(false);
    }
  }

  async function acceptAllSuggestions() {
    if (!suggestedRelations.length) return;
    setSavingRelation(true);
    setError("");
    try {
      let latest = data;
      for (const s of suggestedRelations) {
        latest = await api.saveDomainRelation(domainId, {
          sourceModelId: s.sourceModelId,
          targetModelId: s.targetModelId,
          name: s.name,
          cardinality: s.cardinality,
          localField: s.localField,
          foreignField: s.foreignField,
        });
      }
      if (latest) setData(latest);
      setNotice(`Auto-linked ${suggestedRelations.length} relationship(s) across ${pack.shortLabel} entities!`);
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setSavingRelation(false);
    }
  }

  async function saveConnectDraft() {
    if (!connectDraft) return;
    setSavingRelation(true);
    setError("");
    try {
      const next = await api.saveDomainRelation(domainId, {
        sourceModelId: connectDraft.sourceModelId,
        targetModelId: connectDraft.targetModelId,
        name: connectDraft.name.trim() || "relates_to",
        cardinality: connectDraft.cardinality,
        localField: connectDraft.localField,
        foreignField: connectDraft.foreignField,
      });
      setData(next);
      setConnectDraft(null);
      setNotice(`Created relationship ${connectDraft.sourceModelId}.${connectDraft.localField} (${cardinalityLabel(connectDraft.cardinality)}) → ${connectDraft.targetModelId}.${connectDraft.foreignField}.`);
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setSavingRelation(false);
    }
  }

  async function removeSelectedRelation(rel: SmassDataModelRelationEdge) {
    setError("");
    try {
      const next = await api.deleteDomainRelation(domainId, {
        sourceModelId: rel.sourceModelId,
        targetModelId: rel.targetModelId,
        name: rel.name,
      });
      setData(next);
      setSelectedRelation(null);
      setNotice(`Removed relationship "${rel.name}" between ${rel.sourceModelId} and ${rel.targetModelId}.`);
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    }
  }

  async function toggleSelectedEntityStatus(modelId: string, nextStatus: SmassModelStatus) {
    setError("");
    setNotice("");
    try {
      const next = await api.setDomainModelStatus(domainId, { modelId, status: nextStatus });
      setData(next);
      setNotice(
        nextStatus === "published"
          ? `Published "${modelId}" — compiled into live sfield read tool & sphoton UI catalog.`
          : `Moved "${modelId}" to Draft — isolated from sphoton UI catalog & agents.`,
      );
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    }
  }

  async function deleteSelectedEntity(modelId: string) {
    setError("");
    try {
      const next = await api.deleteDomainModel(domainId, modelId);
      setData(next);
      setSelectedEntityId(null);
      setConfirmDeleteModelId(null);
      setLiveSnap(null);
      setNotice(`Deleted virtual entity "${modelId}".`);
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    }
  }

  async function testSelectedEntitySnapshot(
    modelId: string,
    nextRedact = redactPii,
    nextCustomerId = testCustomerId,
  ) {
    setTestingSnapshot(true);
    setError("");
    try {
      const { snapshot } = await api.testDomainModelSnapshot(domainId, {
        modelId,
        ...(domainId === "wealth" ? { customerId: nextCustomerId } : {}),
        redactPii: nextRedact,
      });
      setLiveSnap(snapshot);
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setTestingSnapshot(false);
    }
  }

  function autoArrangeCanvas() {
    const next = computeAutoLayout(entities, relations);
    setPositions(next);
    savePositions(domainId, next);
    setNotice("Auto-arranged entity diagram layout.");
  }

  function fitViewToCanvas() {
    if (!viewportRef.current || entities.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = 0;
    let maxY = 0;
    for (const e of entities) {
      const p = effectivePositions[e.id] ?? { x: 60, y: 60 };
      const h = HEADER_HEIGHT + e.fields.length * COL_HEIGHT + 16;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_WIDTH);
      maxY = Math.max(maxY, p.y + h);
    }
    const contentW = Math.max(300, maxX - minX + 80);
    const contentH = Math.max(240, maxY - minY + 80);
    const vw = Math.max(360, viewportRef.current.clientWidth - 24);
    const vh = Math.max(280, viewportRef.current.clientHeight - 48);
    const nextZoom = Math.max(0.55, Math.min(1.15, Number(Math.min(vw / contentW, vh / contentH).toFixed(2))));
    setZoom(nextZoom);
    requestAnimationFrame(() => {
      if (!viewportRef.current) return;
      viewportRef.current.scrollLeft = Math.max(0, Math.round((minX - 28) * nextZoom));
      viewportRef.current.scrollTop = Math.max(0, Math.round((minY - 28) * nextZoom));
    });
    setNotice(`Fit ${entities.length} entities to view (${Math.round(nextZoom * 100)}%).`);
  }

  function exportDiagramSvg() {
    if (entities.length === 0) return;
    const pad = 40;
    let maxX = 800;
    let maxY = 500;
    for (const e of entities) {
      const p = effectivePositions[e.id] ?? { x: 60, y: 60 };
      maxX = Math.max(maxX, p.x + NODE_WIDTH + pad);
      maxY = Math.max(maxY, p.y + HEADER_HEIGHT + e.fields.length * COL_HEIGHT + pad + 20);
    }
    const parts: string[] = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${maxX}" height="${maxY}" viewBox="0 0 ${maxX} ${maxY}">`,
      `<rect width="100%" height="100%" fill="#f6f8f6"/>`,
    ];

    // Relationships
    for (const rel of relations) {
      const src = entities.find((e) => e.id === rel.sourceModelId);
      const tgt = entities.find((e) => e.id === rel.targetModelId);
      if (!src || !tgt) continue;
      const srcPos = effectivePositions[src.id];
      const tgtPos = effectivePositions[tgt.id];
      if (!srcPos || !tgtPos) continue;
      const geom = buildEdgeGeometry(srcPos, src, rel.localField, tgtPos, tgt, rel.foreignField);
      const pillText = `${cardinalityLabel(rel.cardinality)} · ${rel.name}`;
      const pillW = Math.max(82, pillText.length * 6.3 + 16);
      parts.push(`<path d="${geom.d}" fill="none" stroke="#476855" stroke-width="2"/>`);
      parts.push(
        `<g transform="translate(${geom.mx - pillW / 2}, ${geom.my - 11})">` +
          `<rect width="${pillW}" height="22" rx="11" fill="#ffffff" stroke="#476855" stroke-width="1.2"/>` +
          `<text x="${pillW / 2}" y="14" text-anchor="middle" font-size="10.5" font-weight="600" fill="#1f3a29" font-family="Inter, system-ui, sans-serif">${escapeXml(pillText)}</text>` +
          `</g>`,
      );
    }

    // Entity cards
    for (const e of entities) {
      const p = effectivePositions[e.id] ?? { x: 60, y: 60 };
      const h = HEADER_HEIGHT + e.fields.length * COL_HEIGHT + 8;
      const isCustom = customModelIdSet.has(e.id);
      const isNormalized = Boolean(e.unnest);
      const headColor = isNormalized ? "#3730a3" : isCustom ? "#15663a" : "#1a4731";
      parts.push(`<g transform="translate(${p.x}, ${p.y})">`);
      parts.push(`<rect width="${NODE_WIDTH}" height="${h}" rx="10" fill="#ffffff" stroke="#cbd9d0" stroke-width="1.5"/>`);
      parts.push(`<rect width="${NODE_WIDTH}" height="${HEADER_HEIGHT}" rx="10" fill="${headColor}"/>`);
      parts.push(`<rect y="${HEADER_HEIGHT - 10}" width="${NODE_WIDTH}" height="10" fill="${headColor}"/>`);
      parts.push(`<text x="11" y="21" font-size="13" font-weight="700" fill="#ffffff" font-family="Inter, system-ui, sans-serif">${escapeXml(e.label)}</text>`);
      parts.push(`<text x="11" y="38" font-size="10.5" fill="rgba(255,255,255,0.85)" font-family="monospace">${escapeXml(e.id)}</text>`);
      e.fields.forEach((col, i) => {
        const cy = HEADER_HEIGHT + 4 + i * COL_HEIGHT;
        const prefix = col.primaryKey ? "PK " : col.foreignKey ? "FK " : col.aggregate ? "Σ " : col.computed ? "fx " : "";
        parts.push(`<line x1="0" y1="${cy + COL_HEIGHT}" x2="${NODE_WIDTH}" y2="${cy + COL_HEIGHT}" stroke="#eef2ef" stroke-width="1"/>`);
        parts.push(`<text x="12" y="${cy + 19}" font-size="11.5" font-weight="${col.primaryKey ? "700" : "500"}" fill="#142419" font-family="monospace">${escapeXml(prefix + col.key)}</text>`);
        parts.push(`<text x="${NODE_WIDTH - 12}" y="${cy + 19}" text-anchor="end" font-size="10.5" fill="#64748b" font-family="monospace">${escapeXml(col.type ?? "any")}</text>`);
      });
      parts.push(`</g>`);
    }
    parts.push(`</svg>`);

    const blob = new Blob([parts.join("\n")], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${domainId}-er-diagram.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setNotice(`Exported ${domainId}-er-diagram.svg (${entities.length} entities, ${relations.length} relations).`);
  }

  const selectedEntity = entities.find((e) => e.id === selectedEntityId) ?? null;
  const inspectorOpen = Boolean(selectedEntity || selectedRelation);

  return (
    <div className="er-studio-shell">
      {/* Compact Full-Width ER Studio Topbar */}
      <header className="er-topbar">
        <div className="er-topbar-group">
          <span className="er-title-chip">
            <Database size={17} color="var(--teal)" aria-hidden="true" />
            <span>Data Model Studio</span>
          </span>

          <div className="er-pill-group" role="tablist" aria-label="Domain workspace">
            {DOMAIN_PACKS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={domainId === p.id}
                className={`er-pill-btn${domainId === p.id ? " is-active" : ""}`}
                onClick={() => onSelectDomain(p.id)}
              >
                {p.shortLabel}
              </button>
            ))}
          </div>

          <div className="er-pill-group" role="tablist" aria-label="Modeling view">
            <button type="button" role="tab" aria-selected={tab === "canvas"} className={`er-pill-btn${tab === "canvas" ? " is-active" : ""}`} onClick={() => setTab("canvas")}>
              <LayoutGrid size={13} aria-hidden="true" />
              ER Canvas ({entities.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "builder"}
              className={`er-pill-btn${tab === "builder" ? " is-active" : ""}`}
              onClick={() => {
                setBuilderEditModelId(null);
                setTab("builder");
              }}
            >
              <Sparkles size={13} aria-hidden="true" />
              Virtual Builder
            </button>
            <button type="button" role="tab" aria-selected={tab === "mermaid"} className={`er-pill-btn${tab === "mermaid" ? " is-active" : ""}`} onClick={() => setTab("mermaid")}>
              <Code2 size={13} aria-hidden="true" />
              Mermaid ER
            </button>
            <button type="button" role="tab" aria-selected={tab === "json_schema"} className={`er-pill-btn${tab === "json_schema" ? " is-active" : ""}`} onClick={() => setTab("json_schema")}>
              JSON Schema
            </button>
          </div>
        </div>

        {tab === "canvas" && (
          <div className="er-topbar-group">
            <div className="er-search-box">
              <Search size={12} color="#64748b" aria-hidden="true" />
              <input
                type="search"
                aria-label="Search entities and columns"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search entities & columns…"
              />
              {searchQuery && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setSearchQuery("")}
                  style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", display: "inline-flex", color: "#64748b" }}
                >
                  <X size={11} />
                </button>
              )}
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setPaletteOpen((p) => !p)}
              style={{ padding: "4px 9px", fontSize: "0.75rem", display: "inline-flex", alignItems: "center", gap: "4px" }}
              title="Toggle Tool Schema palette"
            >
              <PanelLeft size={13} aria-hidden="true" />
              Schemas
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                if (suggestedRelations.length > 0 && !showSuggestions) {
                  setShowSuggestions(true);
                  setNotice(`Detected ${suggestedRelations.length} relationship suggestion(s) by matching key names — click any amber badge to link, or click Auto-Detect again to accept all.`);
                } else if (suggestedRelations.length > 0 && showSuggestions) {
                  void acceptAllSuggestions();
                } else {
                  setNotice("All matching key names & principal links are already connected!");
                }
              }}
              disabled={savingRelation}
              style={{
                padding: "4px 10px",
                fontSize: "0.75rem",
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                borderColor: suggestedRelations.length > 0 ? "#d97706" : undefined,
                color: suggestedRelations.length > 0 ? "#92400e" : undefined,
                background: suggestedRelations.length > 0 ? "#fffbeb" : undefined,
              }}
            >
              <Wand2 size={13} aria-hidden="true" />
              {showSuggestions && suggestedRelations.length > 0
                ? `Accept All (${suggestedRelations.length})`
                : `Auto-Detect Relations${suggestedRelations.length > 0 ? ` (${suggestedRelations.length})` : ""}`}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={entities.length < 2}
              onClick={() => {
                const src = selectedEntity ?? entities[0]!;
                const tgt = entities.find((e) => e.id !== src.id) ?? entities[1]!;
                setConnectDraft({
                  sourceModelId: src.id,
                  localField: src.primaryKey ?? src.fields[0]?.key ?? "id",
                  targetModelId: tgt.id,
                  foreignField: tgt.primaryKey ?? tgt.fields[0]?.key ?? "id",
                  cardinality: "many_to_one",
                  name: `relates_to_${(tgt.id.split(".").at(-1) ?? "entity").replace(/[^a-z0-9_]/gi, "_")}`,
                });
              }}
              style={{ padding: "4px 10px", fontSize: "0.75rem", display: "inline-flex", alignItems: "center", gap: "5px" }}
            >
              <Link2 size={13} aria-hidden="true" />
              + Link Entities
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={autoArrangeCanvas}
              style={{ padding: "4px 9px", fontSize: "0.75rem" }}
            >
              Auto-Arrange
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={fitViewToCanvas}
              style={{ padding: "4px 8px", fontSize: "0.75rem", display: "inline-flex", alignItems: "center", gap: "4px" }}
              title="Fit all entities to canvas viewport"
            >
              <Maximize2 size={12} aria-hidden="true" />
              Fit
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={exportDiagramSvg}
              style={{ padding: "4px 8px", fontSize: "0.75rem", display: "inline-flex", alignItems: "center", gap: "4px" }}
              title="Download ER diagram as standalone SVG"
            >
              <Download size={12} aria-hidden="true" />
              SVG
            </button>
            <div className="er-pill-group" aria-label="Canvas zoom">
              <button type="button" className="er-pill-btn" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.6, Number((z - 0.1).toFixed(2))))}>
                <Minus size={12} />
              </button>
              <span style={{ fontSize: "0.72rem", fontWeight: 600, padding: "0 4px" }}>{Math.round(zoom * 100)}%</span>
              <button type="button" className="er-pill-btn" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(1.4, Number((z + 0.1).toFixed(2))))}>
                <Plus size={12} />
              </button>
            </div>
          </div>
        )}
      </header>

      {/* Main Content Area */}
      {tab === "canvas" ? (
        <div className={`er-workspace-body${paletteOpen ? "" : " is-palette-collapsed"}${inspectorOpen ? " has-inspector" : ""}`}>
          {/* Left Palette: Draggable Tool JSON Schemas */}
          <aside className="er-palette" aria-label="Tool JSON Schema palette">
            <div style={{ display: "grid", gap: "2px" }}>
              <strong style={{ fontSize: "0.82rem", color: "var(--ink)" }}>Tool JSON Schemas</strong>
              <span style={{ fontSize: "0.72rem", color: "var(--muted)" }}>
                Drag a tool or nested array onto the canvas to spawn an entity &amp; auto-detect relationships.
              </span>
            </div>

            {loading && !data ? (
              <p className="admin-muted" style={{ fontSize: "0.78rem" }}>Loading schemas…</p>
            ) : (
              (data?.tools ?? [])
                .filter((t) => t.role === "read")
                .map((tool) => {
                  const fields = tool.outputFields.filter((f) => !f.path.includes("[]"));
                  return (
                    <div key={tool.toolRef} className="er-palette-tool">
                      <div
                        className="er-palette-tool-head"
                        draggable
                        data-er-palette-tool={tool.toolRef}
                        onDragStart={(e) => startPaletteDrag(e, { kind: "tool", toolRef: tool.toolRef })}
                        title="Drag entire tool onto ER Canvas to create an entity"
                      >
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", minWidth: 0 }}>
                          <GripVertical size={13} color="#64748b" aria-hidden="true" />
                          <code style={{ fontSize: "0.73rem", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis" }}>
                            {tool.id}
                          </code>
                        </span>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => void spawnEntityFromPalette({ kind: "tool", toolRef: tool.toolRef })}
                          style={{ padding: "2px 6px", fontSize: "0.68rem", flexShrink: 0 }}
                          title="Add entity to canvas"
                        >
                          + Entity
                        </button>
                      </div>
                      <ul className="er-palette-fields">
                        {fields.map((f) => {
                          const arrSubs = f.type === "array" ? arraySubfields.get(`${tool.toolRef}::${f.path}`) ?? [] : [];
                          const isNestedArray = arrSubs.length > 0;
                          return (
                            <li
                              key={f.path}
                              className={`er-palette-field${isNestedArray ? " is-nested" : ""}`}
                              draggable
                              data-er-palette-field={`${tool.toolRef}:${f.path}`}
                              onDragStart={(e) =>
                                startPaletteDrag(
                                  e,
                                  isNestedArray
                                    ? { kind: "nested_array", toolRef: tool.toolRef, path: f.path }
                                    : { kind: "field", toolRef: tool.toolRef, path: f.path, type: f.type, label: f.label },
                                )
                              }
                            >
                              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", minWidth: 0 }}>
                                <GripVertical size={11} color="#94a3b8" aria-hidden="true" />
                                <code style={{ fontSize: "0.72rem" }}>{f.path}</code>
                                <span style={{ fontSize: "0.67rem", color: "var(--muted)" }}>{f.type}</span>
                              </span>
                              {isNestedArray && (
                                <button
                                  type="button"
                                  className="secondary-button"
                                  onClick={() => void spawnEntityFromPalette({ kind: "nested_array", toolRef: tool.toolRef, path: f.path })}
                                  style={{ padding: "1px 5px", fontSize: "0.65rem", color: "#4338ca", borderColor: "#c7d2fe" }}
                                  title="Extract as 1:N relational child table on canvas"
                                >
                                  1:N
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })
            )}
          </aside>

          {/* Center Full-Page Interactive ER Canvas */}
          <div
            ref={viewportRef}
            className={`er-canvas-viewport${canvasDragOver ? " is-drag-over" : ""}${isPanning ? " is-panning" : ""}`}
            data-testid="smass-er-canvas"
            onPointerDown={startCanvasPan}
            onClick={() => {
              if (suppressNextCanvasClickRef.current) {
                suppressNextCanvasClickRef.current = false;
                return;
              }
              setSelectedEntityId(null);
              setSelectedRelation(null);
              setConfirmDeleteModelId(null);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              if (!canvasDragOver) setCanvasDragOver(true);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setCanvasDragOver(false);
            }}
            onDrop={handleCanvasDrop}
          >
            {(error || notice) && (
              <div className="er-floating-banner" role={error ? "alert" : "status"} style={error ? { background: "#991b1b" } : undefined}>
                <span>{error || notice}</span>
                <button
                  type="button"
                  onClick={() => {
                    setError("");
                    setNotice("");
                  }}
                  style={{ background: "transparent", border: "none", color: "#fff", cursor: "pointer", padding: 0, display: "inline-flex" }}
                  aria-label="Dismiss message"
                >
                  <X size={13} />
                </button>
              </div>
            )}

            <div
              ref={stageRef}
              className="er-canvas-stage"
              style={{
                width: `${stageSize.width}px`,
                height: `${stageSize.height}px`,
                transform: `scale(${zoom})`,
              }}
            >
              {/* SVG Layer: Crow's-Foot Relationships + Suggested Relations + Live Rubber-Band */}
              <svg className="er-svg-layer" width={stageSize.width} height={stageSize.height}>
                {/* Confirmed Relationships */}
                {relations.map((rel, idx) => {
                  const src = entities.find((e) => e.id === rel.sourceModelId);
                  const tgt = entities.find((e) => e.id === rel.targetModelId);
                  if (!src || !tgt) return null;
                  const srcPos = effectivePositions[src.id];
                  const tgtPos = effectivePositions[tgt.id];
                  if (!srcPos || !tgtPos) return null;
                  const geom = buildEdgeGeometry(srcPos, src, rel.localField, tgtPos, tgt, rel.foreignField);
                  const isSelected =
                    selectedRelation?.sourceModelId === rel.sourceModelId &&
                    selectedRelation?.targetModelId === rel.targetModelId &&
                    selectedRelation?.name === rel.name;
                  const isCustomRel = (data?.customRelations ?? []).some(
                    (c) => c.sourceModelId === rel.sourceModelId && c.targetModelId === rel.targetModelId && c.name === rel.name,
                  ) || customModelIdSet.has(rel.sourceModelId);
                  const strokeColor = isSelected ? "#0f766e" : isCustomRel ? "#1e6f1d" : "#476855";
                  const srcMany = rel.cardinality === "many_to_one" || rel.cardinality === "many_to_many";
                  const tgtMany = rel.cardinality === "one_to_many" || rel.cardinality === "many_to_many";
                  const pillText = `${cardinalityLabel(rel.cardinality)} · ${rel.name}`;
                  const pillW = Math.max(82, pillText.length * 6.3 + 16);

                  return (
                    <g key={`${rel.sourceModelId}:${rel.name}:${rel.targetModelId}:${idx}`}>
                      <path
                        d={geom.d}
                        className="er-edge-hit"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedRelation(rel);
                          setSelectedEntityId(null);
                        }}
                      />
                      <path
                        d={geom.d}
                        className={`er-edge-path${isCustomRel ? " is-custom" : ""}${isSelected ? " is-selected" : ""}`}
                      />
                      <CrowsFootEnd x={geom.x1} y={geom.y1} dir={geom.dir1} many={srcMany} color={strokeColor} />
                      <CrowsFootEnd x={geom.x2} y={geom.y2} dir={geom.dir2} many={tgtMany} color={strokeColor} />
                      <g
                        className="er-edge-label"
                        transform={`translate(${geom.mx - pillW / 2}, ${geom.my - 11})`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedRelation(rel);
                          setSelectedEntityId(null);
                        }}
                      >
                        <rect
                          width={pillW}
                          height={22}
                          rx={11}
                          fill={isSelected ? "#0f766e" : "#ffffff"}
                          stroke={strokeColor}
                          strokeWidth={1.2}
                        />
                        <text
                          x={pillW / 2}
                          y={14}
                          textAnchor="middle"
                          fontSize={10.5}
                          fontWeight={600}
                          fill={isSelected ? "#ffffff" : "#1f3a29"}
                          fontFamily="Inter, system-ui, sans-serif"
                        >
                          {pillText}
                        </text>
                      </g>
                    </g>
                  );
                })}

                {/* Auto-Detected Suggested Relationships (dashed amber preview lines) */}
                {showSuggestions &&
                  suggestedRelations.map((s) => {
                    const src = entities.find((e) => e.id === s.sourceModelId);
                    const tgt = entities.find((e) => e.id === s.targetModelId);
                    if (!src || !tgt) return null;
                    const srcPos = effectivePositions[src.id];
                    const tgtPos = effectivePositions[tgt.id];
                    if (!srcPos || !tgtPos) return null;
                    const geom = buildEdgeGeometry(srcPos, src, s.localField, tgtPos, tgt, s.foreignField);
                    const label = `+ Link ${cardinalityLabel(s.cardinality)} (${s.localField})`;
                    const pillW = Math.max(115, label.length * 6.3 + 16);
                    return (
                      <g key={s.key}>
                        <path d={geom.d} className="er-edge-path is-suggested" />
                        <g
                          className="er-edge-label"
                          transform={`translate(${geom.mx - pillW / 2}, ${geom.my - 11})`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void acceptSuggestedRelation(s);
                          }}
                        >
                          <rect width={pillW} height={22} rx={11} fill="#fffbeb" stroke="#d97706" strokeWidth={1.3} strokeDasharray="3 2" />
                          <text x={pillW / 2} y={14} textAnchor="middle" fontSize={10.5} fontWeight={700} fill="#92400e">
                            {label}
                          </text>
                        </g>
                      </g>
                    );
                  })}

                {/* Live Rubber-Band Connector while dragging from a column port */}
                {connecting && (
                  <path
                    d={`M ${connecting.x1} ${connecting.y1} C ${(connecting.x1 + connecting.curX) / 2} ${connecting.y1}, ${(connecting.x1 + connecting.curX) / 2} ${connecting.curY}, ${connecting.curX} ${connecting.curY}`}
                    fill="none"
                    stroke="#1e6f1d"
                    strokeWidth={2.5}
                    strokeDasharray="6 4"
                  />
                )}
              </svg>

              {/* Draggable Entity Table Nodes */}
              {entities.map((entity) => {
                const pos = effectivePositions[entity.id] ?? { x: 60, y: 60 };
                const isCustom = customModelIdSet.has(entity.id);
                const isNormalized = Boolean(entity.unnest);
                const isDraft = entity.status === "draft";
                const entityDrift = driftByModel.get(entity.id) ?? [];
                const isSelected = selectedEntityId === entity.id;
                const isDropTarget = dropTargetEntityId === entity.id;
                const isSearchMatch = matchedEntityIds ? matchedEntityIds.has(entity.id) : false;
                const isSearchDimmed = matchedEntityIds ? !matchedEntityIds.has(entity.id) : false;

                return (
                  <div
                    key={entity.id}
                    data-er-entity={entity.id}
                    className={`er-entity-node${isCustom ? " is-custom" : ""}${isNormalized ? " is-normalized" : ""}${isDraft ? " is-draft" : ""}${isSelected ? " is-selected" : ""}${isDropTarget ? " is-drop-target" : ""}${isSearchMatch ? " is-search-match" : ""}${isSearchDimmed ? " is-search-dimmed" : ""}`}
                    style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedEntityId(entity.id);
                      setSelectedRelation(null);
                      setConfirmDeleteModelId(null);
                      setLiveSnap(null);
                    }}
                    onDragOver={(e) => {
                      if (!isCustom) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setDropTargetEntityId(entity.id);
                    }}
                    onDragLeave={() => {
                      if (dropTargetEntityId === entity.id) setDropTargetEntityId(null);
                    }}
                    onDrop={(e) => {
                      const payload = parseDropPayload(e);
                      if (payload?.kind === "field" && isCustom) {
                        e.preventDefault();
                        e.stopPropagation();
                        setDropTargetEntityId(null);
                        setCanvasDragOver(false);
                        void appendFieldToCustomEntity(entity.id, payload);
                      }
                    }}
                  >
                    <div
                      className="er-entity-head"
                      onPointerDown={(e) => startNodeDrag(e, entity.id)}
                      title="Drag to move entity on ER canvas"
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: "0.84rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {entity.label}
                        </div>
                        <div style={{ fontSize: "0.68rem", opacity: 0.85, fontFamily: "monospace" }}>
                          {entity.id}
                        </div>
                      </div>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "3px", flexShrink: 0 }}>
                        {entityDrift.length > 0 && (
                          <span
                            title={entityDrift.map((d) => d.message).join("; ")}
                            style={{
                              fontSize: "0.6rem",
                              padding: "1px 5px",
                              borderRadius: "999px",
                              background: "#dc2626",
                              color: "#fff",
                              fontWeight: 700,
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "2px",
                            }}
                          >
                            <AlertTriangle size={9} aria-hidden="true" />
                            Drift {entityDrift.length}
                          </span>
                        )}
                        <span
                          style={{
                            fontSize: "0.62rem",
                            padding: "1px 5px",
                            borderRadius: "999px",
                            background: isDraft ? "#f59e0b" : "rgba(255,255,255,0.18)",
                            color: isDraft ? "#1f2937" : "#fff",
                            fontWeight: 700,
                          }}
                        >
                          {isDraft ? "Draft" : isNormalized ? "1:N" : isCustom ? "Virtual" : "Canonical"}
                        </span>
                      </span>
                    </div>

                    <ul className="er-entity-cols">
                      {entity.fields.map((col) => (
                        <li
                          key={col.key}
                          className={`er-entity-col${connecting && connecting.sourceModelId !== entity.id ? " is-connect-target" : ""}`}
                          data-er-entity={entity.id}
                          data-er-col={col.key}
                        >
                          <span
                            className="er-col-port is-left"
                            data-er-port={`${entity.id}:${col.key}:left`}
                            title={`Drag from ${entity.id}.${col.key} to connect to another entity`}
                            onPointerDown={(e) => startPortConnect(e, entity, col.key, "left")}
                          />
                          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", minWidth: 0, overflow: "hidden" }}>
                            {col.primaryKey && (
                              <span title="Primary Key" style={{ color: "#b45309", display: "inline-flex" }}>
                                <KeyRound size={11} aria-hidden="true" />
                              </span>
                            )}
                            {col.foreignKey && (
                              <span title={`FK → ${col.foreignKey.modelId}.${col.foreignKey.field}`} style={{ color: "#4338ca", display: "inline-flex" }}>
                                <Link2 size={11} aria-hidden="true" />
                              </span>
                            )}
                            {col.aggregate && (
                              <span title="Aggregate" style={{ color: "#b45309", display: "inline-flex" }}>
                                <Sigma size={11} aria-hidden="true" />
                              </span>
                            )}
                            {col.computed && (
                              <span title="Derived column" style={{ color: "#7e22ce", display: "inline-flex" }}>
                                <Sparkles size={11} aria-hidden="true" />
                              </span>
                            )}
                            <code style={{ fontWeight: col.primaryKey ? 700 : 600, fontSize: "0.74rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {col.key}
                            </code>
                          </span>
                          <span style={{ fontSize: "0.68rem", color: "var(--muted)", fontFamily: "monospace", flexShrink: 0 }}>
                            {col.type ?? "any"}
                          </span>
                          <span
                            className="er-col-port is-right"
                            data-er-port={`${entity.id}:${col.key}:right`}
                            title={`Drag from ${entity.id}.${col.key} to connect to another entity`}
                            onPointerDown={(e) => startPortConnect(e, entity, col.key, "right")}
                          />
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>

            <div className="er-canvas-footer">
              <span><strong>Tip:</strong> Drag empty canvas to pan · Drag tools from left to auto-link · Drag any column dot (●) to connect manually</span>
            </div>
          </div>

          {/* Right Contextual Inspector (Entity or Relationship details) */}
          {inspectorOpen && (
            <aside className="er-inspector" aria-label="ER Inspector">
              {selectedEntity && (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                    <div>
                      <strong style={{ fontSize: "0.95rem" }}>{selectedEntity.label}</strong>
                      <div style={{ fontSize: "0.75rem", fontFamily: "monospace", color: "var(--muted)" }}>
                        {selectedEntity.id}@{selectedEntity.version}
                      </div>
                    </div>
                    <button type="button" className="secondary-button" style={{ padding: "3px" }} onClick={() => setSelectedEntityId(null)} aria-label="Close inspector">
                      <X size={14} />
                    </button>
                  </div>

                  {selectedEntity.description && (
                    <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)" }}>{selectedEntity.description}</p>
                  )}

                  {selectedEntity.unnest && (
                    <div style={{ padding: "7px 9px", borderRadius: "8px", background: "#eef2ff", border: "1px solid #c7d2fe", fontSize: "0.75rem", color: "#3730a3", display: "flex", alignItems: "center", gap: "6px" }}>
                      <Split size={13} aria-hidden="true" />
                      Normalized from <code>{selectedEntity.unnest.slot}.{selectedEntity.unnest.path}</code>
                    </div>
                  )}

                  {/* Governance: Lifecycle Status + Live Compiled sfield Read Tool */}
                  {(customModelIdSet.has(selectedEntity.id) || selectedEntity.virtualReadToolRef) && (
                    <div style={{ padding: "8px 10px", borderRadius: "8px", background: "var(--paper)", border: "1px solid var(--border)", display: "grid", gap: "6px", fontSize: "0.74rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "6px" }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                          <span
                            style={{
                              fontSize: "0.68rem",
                              padding: "2px 7px",
                              borderRadius: "999px",
                              fontWeight: 700,
                              background: selectedEntity.status === "draft" ? "#fef3c7" : "#dcfce7",
                              color: selectedEntity.status === "draft" ? "#92400e" : "#155331",
                            }}
                          >
                            {selectedEntity.status === "draft" ? "Draft" : "Published"}
                          </span>
                          <span style={{ color: "var(--muted)", fontSize: "0.71rem" }}>
                            {selectedEntity.status === "draft" ? "Studio only" : "Live in sphoton & agents"}
                          </span>
                        </span>
                        {customModelIdSet.has(selectedEntity.id) && (
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() =>
                              void toggleSelectedEntityStatus(
                                selectedEntity.id,
                                selectedEntity.status === "draft" ? "published" : "draft",
                              )
                            }
                            style={{ padding: "2px 8px", fontSize: "0.7rem" }}
                          >
                            {selectedEntity.status === "draft" ? "Publish" : "Set Draft"}
                          </button>
                        )}
                      </div>
                      {selectedEntity.virtualReadToolRef && selectedEntity.status !== "draft" && (
                        <div style={{ display: "flex", alignItems: "center", gap: "5px", color: "#155e75", fontSize: "0.71rem" }}>
                          <Wrench size={11} aria-hidden="true" />
                          <span>Live <code>sfield</code> tool:</span>
                          <code style={{ fontWeight: 700 }}>{selectedEntity.virtualReadToolRef}</code>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Schema Drift Alerts */}
                  {(driftByModel.get(selectedEntity.id)?.length ?? 0) > 0 && (
                    <div style={{ padding: "8px 10px", borderRadius: "8px", background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", display: "grid", gap: "4px", fontSize: "0.73rem" }}>
                      <strong style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                        <AlertTriangle size={13} aria-hidden="true" />
                        Schema Drift Detected ({driftByModel.get(selectedEntity.id)!.length})
                      </strong>
                      {driftByModel.get(selectedEntity.id)!.map((issue, idx) => (
                        <span key={idx}>{issue.message}</span>
                      ))}
                    </div>
                  )}

                  {domainId === "wealth" && (
                    <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px", fontSize: "0.73rem", color: "var(--muted)" }}>
                      <span>Test Persona:</span>
                      <select
                        aria-label="Test customer persona"
                        value={testCustomerId}
                        onChange={(e) => {
                          const nextCust = e.target.value;
                          setTestCustomerId(nextCust);
                          if (liveSnap) void testSelectedEntitySnapshot(selectedEntity.id, redactPii, nextCust);
                        }}
                        style={{ padding: "3px 6px", borderRadius: "6px", border: "1px solid var(--border)", fontSize: "0.73rem" }}
                      >
                        {WEALTH_PERSONAS.map((p) => (
                          <option key={p.id} value={p.id}>{p.label}</option>
                        ))}
                      </select>
                    </label>
                  )}

                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={testingSnapshot}
                      onClick={() => void testSelectedEntitySnapshot(selectedEntity.id)}
                      style={{ padding: "5px 10px", fontSize: "0.75rem", display: "inline-flex", alignItems: "center", gap: "4px", background: "var(--teal)", color: "#fff", borderColor: "var(--teal)" }}
                    >
                      <Play size={12} aria-hidden="true" />
                      {testingSnapshot ? "Loading…" : "Test 1× Snapshot"}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        const tgt = entities.find((e) => e.id !== selectedEntity.id);
                        if (!tgt) return;
                        setConnectDraft({
                          sourceModelId: selectedEntity.id,
                          localField: selectedEntity.primaryKey ?? selectedEntity.fields[0]?.key ?? "id",
                          targetModelId: tgt.id,
                          foreignField: tgt.primaryKey ?? tgt.fields[0]?.key ?? "id",
                          cardinality: "many_to_one",
                          name: `links_to_${(tgt.id.split(".").at(-1) ?? "target").replace(/[^a-z0-9_]/gi, "_")}`,
                        });
                      }}
                      style={{ padding: "5px 9px", fontSize: "0.75rem", display: "inline-flex", alignItems: "center", gap: "4px" }}
                    >
                      <Link2 size={12} aria-hidden="true" />
                      Link
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        setBuilderEditModelId(selectedEntity.id);
                        setTab("builder");
                      }}
                      style={{ padding: "5px 9px", fontSize: "0.75rem", display: "inline-flex", alignItems: "center", gap: "4px" }}
                    >
                      <Pencil size={12} aria-hidden="true" />
                      Edit Columns
                    </button>
                    {customModelIdSet.has(selectedEntity.id) && (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          const lin = data?.lineage?.[selectedEntity.id];
                          const depCount = lin
                            ? lin.uiLayouts.length + lin.widgets.length + lin.ccreRules.length + lin.childModels.length
                            : 0;
                          if (depCount > 0 && confirmDeleteModelId !== selectedEntity.id) {
                            setConfirmDeleteModelId(selectedEntity.id);
                          } else {
                            void deleteSelectedEntity(selectedEntity.id);
                          }
                        }}
                        style={{ padding: "5px 9px", fontSize: "0.75rem", color: "#b91c1c", display: "inline-flex", alignItems: "center", gap: "4px" }}
                      >
                        <Trash2 size={12} aria-hidden="true" />
                        Delete
                      </button>
                    )}
                  </div>

                  {confirmDeleteModelId === selectedEntity.id && (
                    <div style={{ padding: "8px 10px", borderRadius: "8px", background: "#fef2f2", border: "1px solid #f87171", fontSize: "0.74rem", display: "grid", gap: "6px" }}>
                      <strong style={{ color: "#991b1b" }}>Downstream dependents detected!</strong>
                      <span style={{ color: "#7f1d1d" }}>
                        Deleting <code>{selectedEntity.id}</code> may impact bound UI layouts, widgets, CCRE rules, or child entities listed below.
                      </span>
                      <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
                        <button type="button" className="secondary-button" style={{ padding: "3px 8px", fontSize: "0.71rem" }} onClick={() => setConfirmDeleteModelId(null)}>
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          style={{ padding: "3px 8px", fontSize: "0.71rem", background: "#dc2626", color: "#fff", borderColor: "#dc2626" }}
                          onClick={() => void deleteSelectedEntity(selectedEntity.id)}
                        >
                          Confirm Delete
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Downstream Lineage & Impact */}
                  {data?.lineage?.[selectedEntity.id] && (() => {
                    const lin = data.lineage[selectedEntity.id]!;
                    const total = lin.uiLayouts.length + lin.widgets.length + lin.ccreRules.length + lin.childModels.length;
                    return (
                      <div style={{ padding: "8px 10px", borderRadius: "8px", background: "var(--paper)", border: "1px solid var(--border)", display: "grid", gap: "4px", fontSize: "0.72rem" }}>
                        <strong style={{ display: "inline-flex", alignItems: "center", gap: "5px", color: "var(--ink)" }}>
                          <GitFork size={12} aria-hidden="true" />
                          Downstream Lineage ({total})
                        </strong>
                        {total === 0 ? (
                          <span style={{ color: "var(--muted)" }}>No UI layouts, widgets, CCRE rules, or child tables depend on this entity yet.</span>
                        ) : (
                          <div style={{ display: "grid", gap: "3px", color: "var(--muted)" }}>
                            {lin.uiLayouts.length > 0 && <div><strong>UI Layouts ({lin.uiLayouts.length}):</strong> {lin.uiLayouts.join(", ")}</div>}
                            {lin.widgets.length > 0 && <div><strong>Widgets ({lin.widgets.length}):</strong> {lin.widgets.join(", ")}</div>}
                            {lin.ccreRules.length > 0 && <div><strong>CCRE Rules ({lin.ccreRules.length}):</strong> {lin.ccreRules.join(", ")}</div>}
                            {lin.childModels.length > 0 && <div><strong>Child Tables ({lin.childModels.length}):</strong> {lin.childModels.join(", ")}</div>}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {liveSnap && (
                    <div style={{ borderRadius: "8px", padding: "9px", background: "#0f172a", color: "#e2e8f0", display: "grid", gap: "6px", fontSize: "0.72rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <strong style={{ color: "#86efac" }}>
                          {liveSnap.status === "ok"
                            ? liveSnap.rows
                              ? `${liveSnap.rows.length} relational rows`
                              : `${liveSnap.sourceCalls} source call`
                            : "Stale retry"}
                        </strong>
                        <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "0.7rem" }}>
                          <input
                            type="checkbox"
                            checked={redactPii}
                            onChange={(e) => {
                              setRedactPii(e.target.checked);
                              void testSelectedEntitySnapshot(selectedEntity.id, e.target.checked);
                            }}
                          />
                          Redact PII
                        </label>
                      </div>
                      <pre style={{ margin: 0, maxHeight: "220px", overflow: "auto", lineHeight: 1.4 }}>
                        {JSON.stringify(liveSnap.status === "ok" ? (liveSnap.rows ?? liveSnap.data) : liveSnap, null, 2)}
                      </pre>
                    </div>
                  )}

                  <div style={{ display: "grid", gap: "5px" }}>
                    <span style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", color: "var(--muted)" }}>
                      Columns ({selectedEntity.fields.length})
                    </span>
                    {selectedEntity.fields.map((f) => (
                      <div key={f.key} style={{ padding: "6px 8px", borderRadius: "7px", background: "var(--paper)", border: "1px solid var(--border)", fontSize: "0.76rem", display: "grid", gap: "2px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: "6px" }}>
                          <strong><code>{f.key}</code></strong>
                          <span style={{ color: "var(--muted)", fontFamily: "monospace", fontSize: "0.7rem" }}>{f.type ?? "any"}</span>
                        </div>
                        <span style={{ fontSize: "0.71rem", color: "var(--muted)" }}>{f.label}</span>
                        {f.toolRef && <code style={{ fontSize: "0.68rem", color: "#475569" }}>{f.toolRef} → {f.outputPath}</code>}
                        {f.computed && <code style={{ fontSize: "0.68rem", color: "#7e22ce" }}>Derived: {f.computed.expression}</code>}
                        {f.aggregate && (
                          <code style={{ fontSize: "0.68rem", color: "#b45309" }}>
                            Agg: {f.aggregate.op.toUpperCase()}(
                            {f.aggregate.targetModelId
                              ? `${f.aggregate.targetModelId}${f.aggregate.itemField ? `.${f.aggregate.itemField}` : ""}`
                              : f.aggregate.sourceField
                                ? `${f.aggregate.sourceField}${f.aggregate.itemField ? `.${f.aggregate.itemField}` : ""}`
                                : f.aggregate.sourceFields?.join(", ")}
                            {f.aggregate.where ? ` WHERE ${f.aggregate.where.field} ${f.aggregate.where.op} ${JSON.stringify(f.aggregate.where.value)}` : ""})
                          </code>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}

              {selectedRelation && (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                    <div>
                      <strong style={{ fontSize: "0.95rem", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                        <Link2 size={15} color="var(--teal)" aria-hidden="true" />
                        Relationship
                      </strong>
                      <div style={{ fontSize: "0.76rem", color: "var(--muted)" }}>{selectedRelation.name}</div>
                    </div>
                    <button type="button" className="secondary-button" style={{ padding: "3px" }} onClick={() => setSelectedRelation(null)} aria-label="Close inspector">
                      <X size={14} />
                    </button>
                  </div>

                  <div style={{ padding: "10px", borderRadius: "8px", background: "var(--paper)", border: "1px solid var(--border)", display: "grid", gap: "6px", fontSize: "0.78rem" }}>
                    <div><strong>From:</strong> <code>{selectedRelation.sourceModelId}.{selectedRelation.localField}</code></div>
                    <div><strong>Cardinality:</strong> <span style={{ padding: "1px 6px", borderRadius: "999px", background: "#e0e7ff", color: "#3730a3", fontWeight: 700 }}>{cardinalityLabel(selectedRelation.cardinality)}</span></div>
                    <div><strong>To:</strong> <code>{selectedRelation.targetModelId}.{selectedRelation.foreignField}</code></div>
                  </div>

                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() =>
                        setConnectDraft({
                          sourceModelId: selectedRelation.sourceModelId,
                          localField: selectedRelation.localField,
                          targetModelId: selectedRelation.targetModelId,
                          foreignField: selectedRelation.foreignField,
                          cardinality: selectedRelation.cardinality,
                          name: selectedRelation.name,
                        })
                      }
                      style={{ padding: "5px 10px", fontSize: "0.75rem", display: "inline-flex", alignItems: "center", gap: "4px" }}
                    >
                      <Pencil size={12} aria-hidden="true" />
                      Edit Cardinality
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void removeSelectedRelation(selectedRelation)}
                      style={{ padding: "5px 10px", fontSize: "0.75rem", color: "#b91c1c", display: "inline-flex", alignItems: "center", gap: "4px" }}
                    >
                      <Trash2 size={12} aria-hidden="true" />
                      Remove
                    </button>
                  </div>
                </>
              )}
            </aside>
          )}
        </div>
      ) : tab === "builder" ? (
        <div style={{ overflowY: "auto", padding: "0 18px 24px" }}>
          <DomainToolsAndModelPanel
            domainId={domainId}
            defaultOpenBuilder
            initialEditModelId={builderEditModelId}
            onDataChanged={(next) => setData(next)}
          />
        </div>
      ) : tab === "mermaid" ? (
        <div style={{ overflowY: "auto", padding: "18px", maxWidth: "1100px", width: "100%", margin: "0 auto" }}>
          <div className="admin-card" style={{ display: "grid", gap: "10px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong>Compiled Mermaid ER Diagram ({entities.length} entities · {relations.length} relations)</strong>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void navigator.clipboard.writeText(data?.dataModel?.mermaidEr ?? "");
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                }}
                style={{ padding: "4px 10px", fontSize: "0.76rem", display: "inline-flex", alignItems: "center", gap: "5px" }}
              >
                <Copy size={13} />
                {copied ? "Copied" : "Copy Mermaid"}
              </button>
            </div>
            <pre style={{ margin: 0, padding: "14px", borderRadius: "10px", background: "#0f172a", color: "#e2e8f0", fontSize: "0.8rem", overflowX: "auto", lineHeight: 1.55 }}>
              {data?.dataModel?.mermaidEr ?? ""}
            </pre>
          </div>
        </div>
      ) : (
        <div style={{ overflowY: "auto", padding: "18px", maxWidth: "1100px", width: "100%", margin: "0 auto" }}>
          <div className="admin-card" style={{ display: "grid", gap: "10px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong>Compiled Draft 2020-12 JSON Schema <code>$defs</code></strong>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void navigator.clipboard.writeText(JSON.stringify(data?.dataModel?.jsonSchema ?? {}, null, 2));
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                }}
                style={{ padding: "4px 10px", fontSize: "0.76rem", display: "inline-flex", alignItems: "center", gap: "5px" }}
              >
                <Copy size={13} />
                {copied ? "Copied" : "Copy JSON Schema"}
              </button>
            </div>
            <pre style={{ margin: 0, padding: "14px", borderRadius: "10px", background: "#0f172a", color: "#e2e8f0", fontSize: "0.76rem", overflowX: "auto", lineHeight: 1.45 }}>
              {JSON.stringify(data?.dataModel?.jsonSchema ?? {}, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {/* Manual Connect Entities Modal (opened on port-to-port drag release or + Link Entities) */}
      {connectDraft && (
        <div className="er-connect-modal" role="dialog" aria-label="Connect Entities">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong style={{ fontSize: "0.92rem", display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <Link2 size={15} color="var(--teal)" aria-hidden="true" />
              Create Entity Relationship
            </strong>
            <button type="button" className="secondary-button" style={{ padding: "3px" }} onClick={() => setConnectDraft(null)} aria-label="Close">
              <X size={14} />
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
            <label style={{ display: "grid", gap: "3px", fontSize: "0.74rem", fontWeight: 600 }}>
              Source entity
              <select
                value={connectDraft.sourceModelId}
                onChange={(e) => {
                  const sourceModelId = e.target.value;
                  const src = entities.find((m) => m.id === sourceModelId);
                  setConnectDraft((prev) =>
                    prev ? { ...prev, sourceModelId, localField: src?.primaryKey ?? src?.fields[0]?.key ?? "id" } : null,
                  );
                }}
                style={{ padding: "5px 6px", borderRadius: "6px", border: "1px solid var(--border)", fontSize: "0.78rem" }}
              >
                {entities.map((e) => (
                  <option key={e.id} value={e.id}>{e.id}</option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: "3px", fontSize: "0.74rem", fontWeight: 600 }}>
              Source column
              <select
                value={connectDraft.localField}
                onChange={(e) => setConnectDraft((prev) => (prev ? { ...prev, localField: e.target.value } : null))}
                style={{ padding: "5px 6px", borderRadius: "6px", border: "1px solid var(--border)", fontFamily: "monospace", fontSize: "0.78rem" }}
              >
                {(entities.find((m) => m.id === connectDraft.sourceModelId)?.fields ?? []).map((f) => (
                  <option key={f.key} value={f.key}>{f.key}</option>
                ))}
              </select>
            </label>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
            <label style={{ display: "grid", gap: "3px", fontSize: "0.74rem", fontWeight: 600 }}>
              Target entity
              <select
                value={connectDraft.targetModelId}
                onChange={(e) => {
                  const targetModelId = e.target.value;
                  const tgt = entities.find((m) => m.id === targetModelId);
                  setConnectDraft((prev) =>
                    prev ? { ...prev, targetModelId, foreignField: tgt?.primaryKey ?? tgt?.fields[0]?.key ?? "id" } : null,
                  );
                }}
                style={{ padding: "5px 6px", borderRadius: "6px", border: "1px solid var(--border)", fontSize: "0.78rem" }}
              >
                {entities.filter((e) => e.id !== connectDraft.sourceModelId).map((e) => (
                  <option key={e.id} value={e.id}>{e.id}</option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: "3px", fontSize: "0.74rem", fontWeight: 600 }}>
              Target column
              <select
                value={connectDraft.foreignField}
                onChange={(e) => setConnectDraft((prev) => (prev ? { ...prev, foreignField: e.target.value } : null))}
                style={{ padding: "5px 6px", borderRadius: "6px", border: "1px solid var(--border)", fontFamily: "monospace", fontSize: "0.78rem" }}
              >
                {(entities.find((m) => m.id === connectDraft.targetModelId)?.fields ?? []).map((f) => (
                  <option key={f.key} value={f.key}>{f.key}</option>
                ))}
              </select>
            </label>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: "8px" }}>
            <label style={{ display: "grid", gap: "3px", fontSize: "0.74rem", fontWeight: 600 }}>
              Cardinality
              <select
                value={connectDraft.cardinality}
                onChange={(e) => setConnectDraft((prev) => (prev ? { ...prev, cardinality: e.target.value as SmassRelationCardinality } : null))}
                style={{ padding: "5px 6px", borderRadius: "6px", border: "1px solid var(--border)", fontSize: "0.78rem", fontWeight: 700 }}
              >
                <option value="one_to_one">1 : 1</option>
                <option value="one_to_many">1 : N</option>
                <option value="many_to_one">N : 1</option>
                <option value="many_to_many">N : M</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: "3px", fontSize: "0.74rem", fontWeight: 600 }}>
              Relationship name
              <input
                type="text"
                value={connectDraft.name}
                onChange={(e) => setConnectDraft((prev) => (prev ? { ...prev, name: e.target.value } : null))}
                style={{ padding: "5px 7px", borderRadius: "6px", border: "1px solid var(--border)", fontFamily: "monospace", fontSize: "0.78rem" }}
              />
            </label>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "6px" }}>
            <button type="button" className="secondary-button" onClick={() => setConnectDraft(null)} style={{ padding: "5px 10px", fontSize: "0.76rem" }}>
              Cancel
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={savingRelation}
              onClick={() => void saveConnectDraft()}
              style={{ padding: "5px 12px", fontSize: "0.78rem", background: "var(--teal)", color: "#fff", borderColor: "var(--teal)", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: "5px" }}
            >
              <Check size={13} aria-hidden="true" />
              {savingRelation ? "Connecting…" : "Create Relation"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
