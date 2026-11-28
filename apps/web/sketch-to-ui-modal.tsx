import { useEffect, useRef, useState } from "react";
import { Eraser, ImagePlus, PenTool, Sparkles, Trash2, Upload, X } from "lucide-react";
import type { DomainPack } from "../../packages/contracts/domain-packs";
import "./immersive-ux.css";

type SketchTab = "draw" | "upload";

const PEN_COLORS = [
  { id: "ink", label: "Ink", hex: "#141414" },
  { id: "emerald", label: "Emerald", hex: "#2f7d32" },
  { id: "blue", label: "Blue", hex: "#1d4ed8" },
  { id: "amber", label: "Amber", hex: "#b45309" },
];

export function SketchToUiModal({
  open,
  domainPack,
  generating,
  error,
  onClose,
  onGenerate,
}: {
  open: boolean;
  domainPack: DomainPack;
  generating: boolean;
  error: string;
  onClose: () => void;
  onGenerate: (input: { imageDataUrl: string; imageName: string; prompt: string }) => Promise<void>;
}) {
  const [tab, setTab] = useState<SketchTab>("draw");
  const [penColor, setPenColor] = useState("#141414");
  const [erasing, setErasing] = useState(false);
  const [hasStrokes, setHasStrokes] = useState(false);
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);
  const [uploadedName, setUploadedName] = useState("picture.png");
  const [prompt, setPrompt] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const stampCountRef = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || tab !== "draw") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Subtle dot grid so sketching feels like a clean wireframe board
    ctx.fillStyle = "#e2e8f0";
    for (let x = 20; x < canvas.width; x += 24) {
      for (let y = 20; y < canvas.height; y += 24) {
        ctx.fillRect(x, y, 2, 2);
      }
    }
    setHasStrokes(false);
    stampCountRef.current = 0;
  }, [open, tab]);

  if (!open) return null;

  function pointFor(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    lastPointRef.current = pointFor(e);
    setHasStrokes(true);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current || !lastPointRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const next = pointFor(e);
    ctx.strokeStyle = erasing ? "#ffffff" : penColor;
    ctx.lineWidth = erasing ? 18 : 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();
    lastPointRef.current = next;
  }

  function onPointerUp() {
    drawingRef.current = false;
    lastPointRef.current = null;
  }

  function clearBoard() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#e2e8f0";
    for (let x = 20; x < canvas.width; x += 24) {
      for (let y = 20; y < canvas.height; y += 24) {
        ctx.fillRect(x, y, 2, 2);
      }
    }
    setHasStrokes(false);
    stampCountRef.current = 0;
  }

  function stampWireframe(kind: "kpi" | "chart" | "progress" | "checklist") {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const idx = stampCountRef.current++;
    const col = idx % 2;
    const row = Math.floor(idx / 2) % 2;
    const x = 26 + col * 268;
    const y = 22 + row * 142;
    const w = 246;
    const h = 122;

    ctx.save();
    ctx.fillStyle = "#f8faf8";
    ctx.strokeStyle = "#2f7d32";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#141414";
    ctx.font = "600 13px system-ui, sans-serif";
    if (kind === "kpi") {
      ctx.fillText("KPI METRICS", x + 14, y + 26);
      ctx.strokeStyle = "#cbd5e1";
      ctx.strokeRect(x + 14, y + 40, 100, 62);
      ctx.strokeRect(x + 128, y + 40, 100, 62);
      ctx.font = "700 18px system-ui, sans-serif";
      ctx.fillText("$245K", x + 24, y + 76);
      ctx.fillText("+12%", x + 142, y + 76);
    } else if (kind === "chart") {
      ctx.fillText("BAR CHART", x + 14, y + 26);
      const heights = [38, 62, 48, 76, 56];
      ctx.fillStyle = "#2f7d32";
      heights.forEach((bh, i) => {
        ctx.fillRect(x + 20 + i * 42, y + 108 - bh, 26, bh);
      });
    } else if (kind === "progress") {
      ctx.fillText("GOAL PROGRESS", x + 14, y + 28);
      ctx.fillStyle = "#e2e8f0";
      ctx.fillRect(x + 14, y + 54, w - 28, 16);
      ctx.fillStyle = "#2f7d32";
      ctx.fillRect(x + 14, y + 54, Math.round((w - 28) * 0.68), 16);
      ctx.fillStyle = "#475569";
      ctx.font = "500 12px system-ui, sans-serif";
      ctx.fillText("68% toward target", x + 14, y + 92);
    } else {
      ctx.fillText("ACTION CHECKLIST", x + 14, y + 26);
      ctx.font = "500 12px system-ui, sans-serif";
      ["[x] Sync live sfield data", "[ ] Review recommendation", "[ ] Pin live card"].forEach((line, i) => {
        ctx.fillText(line, x + 16, y + 54 + i * 22);
      });
    }
    ctx.restore();
    setHasStrokes(true);
  }

  function handleFile(file: File | undefined) {
    if (!file || !file.type.startsWith("image/")) return;
    setUploadedName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setUploadedUrl(reader.result);
    };
    reader.readAsDataURL(file);
  }

  async function submit() {
    if (generating) return;
    if (tab === "upload") {
      if (!uploadedUrl) return;
      await onGenerate({
        imageDataUrl: uploadedUrl,
        imageName: uploadedName,
        prompt: prompt.trim(),
      });
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL("image/png");
    await onGenerate({
      imageDataUrl: dataUrl,
      imageName: "hand-drawn-ui.png",
      prompt: prompt.trim() || `Turn my drawn ${domainPack.shortLabel} wireframe into a live interactive dashboard`,
    });
  }

  const canGenerate = !generating && (tab === "draw" ? hasStrokes || prompt.trim().length >= 2 : Boolean(uploadedUrl));

  return (
    <div className="sketch-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="sketch-modal-title">
      <div className="sketch-modal">
        <header className="sketch-modal-head">
          <div>
            <h2 id="sketch-modal-title">
              <PenTool size={17} aria-hidden="true" />
              Picture or Drawing → Live Dashboard
            </h2>
            <p>Sketch a wireframe or upload a photo/screenshot. Vision builds the layout and binds live <code>sfield</code> data for <strong>{domainPack.label}</strong>.</p>
          </div>
          <button type="button" className="icon-button" aria-label="Close sketch studio" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="sketch-modal-tabs" role="tablist" aria-label="Input mode">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "draw"}
            className={"sketch-tab-btn" + (tab === "draw" ? " is-active" : "")}
            onClick={() => setTab("draw")}
          >
            <PenTool size={14} aria-hidden="true" /> Draw a UI
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "upload"}
            className={"sketch-tab-btn" + (tab === "upload" ? " is-active" : "")}
            onClick={() => setTab("upload")}
          >
            <ImagePlus size={14} aria-hidden="true" /> Upload Picture / Screenshot
          </button>
        </div>

        {tab === "draw" ? (
          <div className="sketch-board-wrap">
            <div className="sketch-toolbar">
              <div className="sketch-colors" role="group" aria-label="Pen colors">
                {PEN_COLORS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    aria-label={c.label}
                    aria-pressed={!erasing && penColor === c.hex}
                    className={"sketch-swatch" + (!erasing && penColor === c.hex ? " is-active" : "")}
                    style={{ background: c.hex }}
                    onClick={() => { setErasing(false); setPenColor(c.hex); }}
                  />
                ))}
                <button
                  type="button"
                  className={"secondary-button sketch-mini-btn" + (erasing ? " is-active" : "")}
                  onClick={() => setErasing((v) => !v)}
                >
                  <Eraser size={13} aria-hidden="true" /> Eraser
                </button>
                <button type="button" className="secondary-button sketch-mini-btn" onClick={clearBoard}>
                  <Trash2 size={13} aria-hidden="true" /> Clear
                </button>
              </div>
              <div className="sketch-stamps" role="group" aria-label="Quick wireframe stamps">
                <span>Quick stamps:</span>
                <button type="button" className="secondary-button sketch-mini-btn" onClick={() => stampWireframe("kpi")}>+ KPI</button>
                <button type="button" className="secondary-button sketch-mini-btn" onClick={() => stampWireframe("chart")}>+ Chart</button>
                <button type="button" className="secondary-button sketch-mini-btn" onClick={() => stampWireframe("progress")}>+ Goal Bar</button>
                <button type="button" className="secondary-button sketch-mini-btn" onClick={() => stampWireframe("checklist")}>+ Checklist</button>
              </div>
            </div>
            <canvas
              ref={canvasRef}
              width={560}
              height={310}
              className="sketch-canvas"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          </div>
        ) : (
          <div
            className="sketch-upload-zone"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleFile(e.dataTransfer.files?.[0]);
            }}
          >
            <input
              ref={fileRef}
              type="file"
              className="sr-only"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(e) => {
                handleFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            {uploadedUrl ? (
              <div className="sketch-upload-preview">
                <img src={uploadedUrl} alt="Uploaded sketch or screenshot preview" />
                <div className="sketch-upload-preview-foot">
                  <span>{uploadedName}</span>
                  <button type="button" className="secondary-button sketch-mini-btn" onClick={() => fileRef.current?.click()}>
                    Choose another image
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="sketch-upload-trigger" onClick={() => fileRef.current?.click()}>
                <Upload size={24} aria-hidden="true" />
                <strong>Drop a whiteboard photo, napkin sketch, or screenshot</strong>
                <span>PNG, JPG, WebP, or GIF — Vision converts it into a live dashboard</span>
              </button>
            )}
          </div>
        )}

        <div className="sketch-prompt-row">
          <label htmlFor="sketch-caption">Optional note (what should this dashboard show?)</label>
          <input
            id="sketch-caption"
            value={prompt}
            placeholder={
              domainPack.id === "it_ops"
                ? "e.g. P1 incident metrics, service health, and rollback checklist"
                : domainPack.id === "sales_revops"
                  ? "e.g. Q4 deal ARR, discount simulator, and close-plan checklist"
                  : "e.g. Portfolio KPIs, home down-payment progress bar, and savings sliders"
            }
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        {error && <p className="admin-error" role="alert" style={{ margin: 0 }}>{error}</p>}

        <footer className="sketch-modal-foot">
          <button type="button" className="secondary-button" disabled={generating} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="send-button" disabled={!canGenerate} onClick={() => void submit()}>
            <Sparkles size={14} aria-hidden="true" />
            {generating ? "Generating live dashboard…" : "Generate Live Dashboard"}
          </button>
        </footer>
      </div>
    </div>
  );
}
