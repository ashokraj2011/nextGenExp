import { useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import {
  ArrowUpRight, BookmarkPlus, Check, Copy, ImagePlus, LayoutGrid, Link2, Pencil, Search, Sparkles, Trash2, Wand2, X,
} from "lucide-react";
import {
  widgetKindLabels, widgetKinds, type SavedWidget, type WidgetDraft, type WidgetKind,
} from "../../packages/contracts/widget";
import { api, toolSetupErrorMessage } from "./api";

const examplePrompts = [
  "Create a net worth KPI card showing $145,000 total assets, $22,000 cash reserve, and +6.4% YTD growth",
  "Build a retirement contribution calculator with sliders for $1,500 monthly savings and 15 years",
  "Create an emergency fund goal tracker showing $18,000 saved toward $25,000",
  "Build an IT incident triage dashboard with P1 metrics, SLA breakdown, and verification checklist",
  "Create a Q4 sales pipeline KPI card showing $2.4M committed, 38% win rate, and 14 active enterprise deals",
  "Build an employee onboarding checklist with 4 launch steps and action button",
];

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function formatSliderValue(value: number, unit: "usd" | "percent" | "years" | "months") {
  if (unit === "usd") return usd.format(value);
  if (unit === "percent") return `${value}%`;
  if (unit === "years") return `${value} yr${value === 1 ? "" : "s"}`;
  return `${value} mo`;
}

export function LiveWidgetPreview({ widget, compact = false }: { widget: WidgetDraft; compact?: boolean }) {
  const [sliderValues, setSliderValues] = useState<Record<string, number>>(() => (
    Object.fromEntries((widget.sliders ?? []).map((s) => [s.id, s.value]))
  ));
  const [checkedSteps, setCheckedSteps] = useState<Record<number, boolean>>({});
  const [ctaClicked, setCtaClicked] = useState(false);

  const calcProjection = useMemo(() => {
    if (widget.kind !== "calculator" || !widget.sliders?.length) return null;
    const monthly = sliderValues.monthly ?? widget.sliders[0]?.value ?? 1000;
    const years = sliderValues.years ?? widget.sliders[1]?.value ?? 10;
    const rate = sliderValues.rate ?? widget.sliders[2]?.value ?? 6;
    const months = Math.max(1, Math.round(years * 12));
    const r = rate / 100 / 12;
    const fv = r > 0 ? monthly * ((Math.pow(1 + r, months) - 1) / r) : monthly * months;
    const contributed = monthly * months;
    return { projected: Math.round(fv), contributed: Math.round(contributed), growth: Math.round(Math.max(0, fv - contributed)) };
  }, [sliderValues, widget.kind, widget.sliders]);

  const goalPct = widget.goal ? Math.min(100, Math.round((widget.goal.saved / Math.max(widget.goal.target, 1)) * 100)) : 0;
  const completedCount = (widget.steps ?? []).filter((_, idx) => checkedSteps[idx]).length;

  return (
    <article className={"cep-widget-card" + (widget.accentTop ? " has-accent-top" : "") + (compact ? " is-compact" : "")}>
      <header className="cep-widget-head">
        {widget.badge && <span className="cep-widget-badge">{widget.badge}</span>}
        <h3>{widget.title}</h3>
        {widget.body && <p className="cep-widget-body">{widget.body}</p>}
      </header>

      {widget.kind === "kpi" && widget.metrics && widget.metrics.length > 0 && (
        <dl className="cep-widget-metrics">
          {widget.metrics.map((metric) => (
            <div key={metric.label}>
              <dt>{metric.label}</dt>
              <dd>
                <strong>{metric.value}</strong>
                {metric.delta && <span>{metric.delta}</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {widget.kind === "goal" && widget.goal && (
        <div className="cep-widget-goal">
          <div className="cep-widget-goal-row">
            <div>
              <strong>{usd.format(widget.goal.saved)}</strong>
              <span> of {usd.format(widget.goal.target)}</span>
            </div>
            <span className="cep-widget-pct">{goalPct}%</span>
          </div>
          <div className="cep-widget-progress-track" aria-hidden="true">
            <span style={{ width: `${goalPct}%` }} />
          </div>
          <p className="cep-widget-goal-meta">
            {usd.format(Math.max(0, widget.goal.target - widget.goal.saved))} remaining
          </p>
        </div>
      )}

      {widget.kind === "calculator" && widget.sliders && widget.sliders.length > 0 && (
        <div className="cep-widget-calc">
          {!compact && (
            <div className="cep-widget-sliders">
              {widget.sliders.map((slider) => {
                const current = sliderValues[slider.id] ?? slider.value;
                return (
                  <label key={slider.id} className="cep-widget-slider-row">
                    <span className="cep-widget-slider-head">
                      <span>{slider.label}</span>
                      <strong>{formatSliderValue(current, slider.unit)}</strong>
                    </span>
                    <input
                      type="range"
                      min={slider.min}
                      max={slider.max}
                      step={slider.step}
                      value={current}
                      onChange={(event) => setSliderValues((prev) => ({ ...prev, [slider.id]: Number(event.target.value) }))}
                    />
                  </label>
                );
              })}
            </div>
          )}
          {calcProjection && (
            <dl className="cep-widget-calc-output">
              <div><dt>Projected value</dt><dd>{usd.format(calcProjection.projected)}</dd></div>
              <div><dt>Contributions</dt><dd>{usd.format(calcProjection.contributed)}</dd></div>
              <div><dt>Est. growth</dt><dd className="is-growth">+{usd.format(calcProjection.growth)}</dd></div>
            </dl>
          )}
        </div>
      )}

      {widget.kind === "comparison" && widget.columns && widget.columns.length > 0 && (
        <div className="cep-widget-compare">
          {widget.columns.map((column) => (
            <div key={column.title} className="cep-widget-compare-col">
              <h4>{column.title}</h4>
              <ul>
                {column.points.slice(0, compact ? 2 : 5).map((point) => <li key={point}>{point}</li>)}
              </ul>
            </div>
          ))}
        </div>
      )}

      {widget.kind === "checklist" && widget.steps && widget.steps.length > 0 && (
        <div className="cep-widget-checklist">
          <ol>
            {widget.steps.slice(0, compact ? 3 : 6).map((step, index) => (
              <li key={index} className={checkedSteps[index] ? "is-checked" : ""}>
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(checkedSteps[index])}
                    onChange={(event) => setCheckedSteps((prev) => ({ ...prev, [index]: event.target.checked }))}
                  />
                  <span>{step}</span>
                </label>
              </li>
            ))}
          </ol>
          {!compact && <small>{completedCount} of {widget.steps.length} completed</small>}
        </div>
      )}

      {widget.ctaLabel && !compact && (
        <div className="cep-widget-footer">
          <button
            type="button"
            className="ui-button ui-button-primary"
            onClick={() => {
              setCtaClicked(true);
              window.setTimeout(() => setCtaClicked(false), 1800);
            }}
          >
            {ctaClicked ? <><Check size={14} aria-hidden="true" />Action triggered</> : <>{widget.ctaLabel} <ArrowUpRight size={14} aria-hidden="true" /></>}
          </button>
        </div>
      )}
    </article>
  );
}

async function fileToResizedDataUrl(file: File): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read screenshot file."));
    reader.readAsDataURL(file);
  });
  if (raw.length < 450_000) return raw;
  return await new Promise<string>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 1280;
      const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(raw); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => resolve(raw);
    img.src = raw;
  });
}

function createSampleDesignMockupPng(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 760;
  canvas.height = 420;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, 760, 420);
  // Card shell
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#cbd5e1";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(28, 28, 704, 364, 18);
  ctx.fill();
  ctx.stroke();
  // Accent bar
  ctx.fillStyle = "#2f7d22";
  ctx.fillRect(28, 28, 704, 8);
  // Badge
  ctx.fillStyle = "#dcfce7";
  ctx.beginPath();
  ctx.roundRect(56, 56, 170, 28, 14);
  ctx.fill();
  ctx.fillStyle = "#166534";
  ctx.font = "bold 13px sans-serif";
  ctx.fillText("QUARTERLY WEALTH PULSE", 70, 75);
  // Headline
  ctx.fillStyle = "#0f172a";
  ctx.font = "bold 28px sans-serif";
  ctx.fillText("Private Client Portfolio Snapshot", 56, 122);
  ctx.fillStyle = "#475569";
  ctx.font = "15px sans-serif";
  ctx.fillText("Q4 net worth performance, liquid cash reserve, and annual yield breakdown.", 56, 150);
  // 3 KPI tiles
  const tiles = [
    { label: "TOTAL NET WORTH", val: "$184,200", delta: "+7.8% YTD" },
    { label: "LIQUID CASH", val: "$42,000", delta: "4.65% APY" },
    { label: "TAX SAVINGS", val: "$3,450", delta: "Harvested" },
  ];
  tiles.forEach((t, idx) => {
    const x = 56 + idx * 224;
    ctx.fillStyle = "#f1f5f9";
    ctx.beginPath();
    ctx.roundRect(x, 180, 206, 110, 12);
    ctx.fill();
    ctx.fillStyle = "#64748b";
    ctx.font = "bold 11px sans-serif";
    ctx.fillText(t.label, x + 16, 208);
    ctx.fillStyle = "#0f172a";
    ctx.font = "bold 26px sans-serif";
    ctx.fillText(t.val, x + 16, 245);
    ctx.fillStyle = "#15803d";
    ctx.font = "bold 13px sans-serif";
    ctx.fillText(t.delta, x + 16, 272);
  });
  // CTA button
  ctx.fillStyle = "#2f7d22";
  ctx.beginPath();
  ctx.roundRect(56, 318, 220, 44, 22);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 14px sans-serif";
  ctx.fillText("Rebalance Portfolio  →", 84, 345);
  return canvas.toDataURL("image/png");
}

export function WidgetStudio({
  widgets,
  onWidgetsChange,
  onInsertIntoLayout,
}: {
  widgets: SavedWidget[];
  onWidgetsChange: (next: SavedWidget[]) => void;
  onInsertIntoLayout: (widget: SavedWidget) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string>("");
  const [showFigmaPanel, setShowFigmaPanel] = useState(false);
  const [figmaUrl, setFigmaUrl] = useState("");
  const [figmaToken, setFigmaToken] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [genSource, setGenSource] = useState<string>("");
  const [draft, setDraft] = useState<WidgetDraft | null>(null);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filterKind, setFilterKind] = useState<WidgetKind | "all">("all");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function attachImageFile(file: File) {
    if (!file.type.startsWith("image/")) {
      setError("Please upload a PNG, JPG, or WebP screenshot.");
      return;
    }
    setError("");
    const dataUrl = await fileToResizedDataUrl(file);
    setImageDataUrl(dataUrl);
    setImageName(file.name || "pasted-screenshot.png");
    setNotice(`Attached "${file.name || "pasted screenshot"}" — click Generate widget to extract it with Vision.`);
  }

  function onPasteScreenshot(event: ClipboardEvent<HTMLTextAreaElement>) {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          void attachImageFile(file);
          return;
        }
      }
    }
  }

  function onDropScreenshot(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file && file.type.startsWith("image/")) {
      void attachImageFile(file);
    }
  }

  const canGenerate = !generating && (prompt.trim().length >= 2 || Boolean(imageDataUrl) || Boolean(figmaUrl.trim()));

  async function generate(override?: { prompt?: string; imageDataUrl?: string | null; imageName?: string }) {
    const cleanPrompt = (override?.prompt ?? prompt).trim();
    const activeImage = override?.imageDataUrl !== undefined ? override.imageDataUrl : imageDataUrl;
    const activeImageName = override?.imageName ?? imageName;
    const cleanFigma = figmaUrl.trim();
    if ((!cleanPrompt && !activeImage && !cleanFigma) || generating) return;
    setGenerating(true);
    setError("");
    setNotice("");
    try {
      const result = await api.generateWidget({
        ...(cleanPrompt ? { prompt: cleanPrompt } : {}),
        ...(activeImage ? { imageDataUrl: activeImage, imageName: activeImageName || "screenshot.png" } : {}),
        ...(cleanFigma ? { figmaUrl: cleanFigma, ...(figmaToken.trim() ? { figmaToken: figmaToken.trim() } : {}) } : {}),
      });
      if (override?.prompt !== undefined) setPrompt(override.prompt);
      setDraft(result.widget);
      setEditingId(undefined);
      setGenSource(result.source ?? "");
      setNotice(result.sourceSummary || "Widget generated. Fine-tune it or add it to your library.");
    } catch (reason) {
      setError(toolSetupErrorMessage(reason));
    } finally {
      setGenerating(false);
    }
  }

  async function saveToLibrary() {
    if (!draft || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await api.saveWidgetLibrary({ operation: "save", id: editingId, widget: draft });
      onWidgetsChange(result.widgets);
      setEditingId(result.widget?.id);
      setNotice(editingId ? `Updated "${draft.name}" in Widget Library.` : `Added "${draft.name}" to Widget Library.`);
    } catch (reason) {
      setError(toolSetupErrorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  async function toggleAvailability(item: SavedWidget) {
    if (saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    const nextValue = !item.availableForConsumption;
    try {
      const result = await api.saveWidgetLibrary({
        operation: "set_availability",
        id: item.id,
        availableForConsumption: nextValue,
      });
      onWidgetsChange(result.widgets);
      if (editingId === item.id && draft) {
        setDraft({ ...draft, availableForConsumption: nextValue });
      }
      setNotice(
        nextValue
          ? `"${item.name}" is now Live — available for chat consumption.`
          : `"${item.name}" is now Draft Only — hidden from live chat consumption.`,
      );
    } catch (reason) {
      setError(toolSetupErrorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  async function deleteFromLibrary(id: string, name: string) {
    if (saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await api.saveWidgetLibrary({ operation: "delete", id });
      onWidgetsChange(result.widgets);
      if (editingId === id) setEditingId(undefined);
      setNotice(`Removed "${name}" from Widget Library.`);
    } catch (reason) {
      setError(toolSetupErrorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return widgets.filter((item) => (filterKind === "all" || item.kind === filterKind)
      && (!q || item.name.toLowerCase().includes(q) || item.title.toLowerCase().includes(q) || item.body.toLowerCase().includes(q)));
  }, [widgets, filterKind, search]);

  return (
    <div className="widget-studio">
      <section
        className={"ui-work-card widget-generator-card" + (dragOver ? " is-drag-over" : "")}
        aria-labelledby="widget-generator-heading"
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDropScreenshot}
      >
        <div className="widget-generator-top">
          <div>
            <span className="widget-studio-kicker"><Sparkles size={13} aria-hidden="true" />Prompt, Screenshot &amp; Figma-to-Widget Builder</span>
            <h2 id="widget-generator-heading">Describe, paste a screenshot, or import a Figma frame</h2>
            <p>
              Type plain English, press <code>Cmd+V</code> / drag-and-drop any design screenshot (or Figma PNG), or paste a Figma frame URL — Copilot Vision turns it into a live interactive CEP widget.
            </p>
          </div>
          {genSource && (
            <span className="ui-copilot-source-pill">
              {genSource === "figma_api" ? "Figma API + Vision"
                : genSource === "copilot_vision" ? "Copilot Vision"
                : genSource === "copilot_llm" ? "Copilot ACP"
                : "Synthesizer"}
            </span>
          )}
        </div>

        <form className="widget-prompt-form" onSubmit={(event) => { event.preventDefault(); void generate(); }}>
          <label className="sr-only" htmlFor="widget-prompt-input">Describe the widget or paste a screenshot</label>
          <textarea
            id="widget-prompt-input"
            rows={2}
            maxLength={600}
            value={prompt}
            placeholder="Describe a widget, or paste a screenshot with Cmd+V (optional instructions like 'match this KPI card and add a Rebalance CTA')…"
            onPaste={onPasteScreenshot}
            onChange={(event) => setPrompt(event.target.value)}
          />

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void attachImageFile(file);
              e.target.value = "";
            }}
          />

          {imageDataUrl && (
            <div className="widget-design-preview-chip">
              <img src={imageDataUrl} alt="Uploaded design mockup preview" />
              <div>
                <strong>{imageName || "Design screenshot"}</strong>
                <small>Ready for Copilot Vision extraction</small>
              </div>
              <button
                type="button"
                className="ui-quiet-icon"
                aria-label="Remove screenshot"
                onClick={() => { setImageDataUrl(null); setImageName(""); }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          )}

          {showFigmaPanel && (
            <div className="widget-figma-strip">
              <label>
                <span>Figma Frame URL</span>
                <input
                  type="url"
                  value={figmaUrl}
                  placeholder="https://www.figma.com/design/AbCdEf123/Wealth-Card?node-id=12-34"
                  onChange={(e) => setFigmaUrl(e.target.value)}
                />
              </label>
              <label>
                <span>Figma Access Token (optional if FIGMA_ACCESS_TOKEN set in server env)</span>
                <input
                  type="password"
                  value={figmaToken}
                  placeholder="figd_... (or paste Figma frame PNG with Cmd+V above)"
                  onChange={(e) => setFigmaToken(e.target.value)}
                />
              </label>
            </div>
          )}

          <div className="widget-prompt-actions">
            <button type="submit" className="ui-button ui-button-primary" disabled={!canGenerate}>
              <Wand2 size={15} aria-hidden="true" />
              {generating ? "Generating…" : imageDataUrl ? "Generate from Screenshot" : figmaUrl.trim() ? "Import from Figma" : "Generate widget"}
            </button>
            <button
              type="button"
              className="ui-button ui-button-outline"
              disabled={generating}
              onClick={() => fileInputRef.current?.click()}
            >
              <ImagePlus size={15} aria-hidden="true" />
              Upload Screenshot
            </button>
            <button
              type="button"
              className={"ui-button ui-button-outline" + (showFigmaPanel || figmaUrl.trim() ? " is-active-tool" : "")}
              disabled={generating}
              onClick={() => setShowFigmaPanel((v) => !v)}
            >
              <Link2 size={15} aria-hidden="true" />
              {showFigmaPanel ? "Hide Figma URL" : "Import Figma URL"}
            </button>
            <button
              type="button"
              className="ui-button ui-button-plain"
              disabled={generating}
              onClick={() => {
                const samplePng = createSampleDesignMockupPng();
                if (!samplePng) return;
                setImageDataUrl(samplePng);
                setImageName("quarterly-wealth-pulse-mockup.png");
                setPrompt("Convert this design screenshot into a live KPI widget");
                void generate({
                  prompt: "Convert this design screenshot into a live KPI widget",
                  imageDataUrl: samplePng,
                  imageName: "quarterly-wealth-pulse-mockup.png",
                });
              }}
            >
              <Sparkles size={14} aria-hidden="true" />
              Try Sample Design Mockup
            </button>
          </div>
        </form>

        <div className="widget-example-chips" role="group" aria-label="Example widget prompts">
          {examplePrompts.map((sample) => (
            <button key={sample} type="button" className="widget-example-chip" disabled={generating} onClick={() => void generate({ prompt: sample, imageDataUrl: null })}>
              {sample.length > 52 ? sample.slice(0, 50) + "…" : sample}
            </button>
          ))}
        </div>

        {notice && <p className="ui-builder-notice" role="status">{notice}</p>}
        {error && <p className="ui-builder-error" role="alert">{error}</p>}
      </section>

      {draft && (
        <section className="widget-workbench-grid" aria-label="Generated widget editor and preview">
          <div className="ui-work-card widget-editor-panel">
            <header className="ui-panel-heading">
              <h3>Customize widget</h3>
              <span className="ui-layout-status">{widgetKindLabels[draft.kind]}</span>
            </header>
            <div className="widget-editor-fields">
              <div className="ui-field">
                <label htmlFor="wdg-name">Library name</label>
                <input id="wdg-name" value={draft.name} maxLength={72} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>
              <div className="widget-field-row">
                <div className="ui-field">
                  <label htmlFor="wdg-badge">Badge label</label>
                  <input id="wdg-badge" value={draft.badge} maxLength={40} onChange={(e) => setDraft({ ...draft, badge: e.target.value })} />
                </div>
                <div className="ui-field">
                  <label htmlFor="wdg-cta">Button label</label>
                  <input id="wdg-cta" value={draft.ctaLabel} maxLength={48} onChange={(e) => setDraft({ ...draft, ctaLabel: e.target.value })} />
                </div>
              </div>
              <div className="ui-field">
                <label htmlFor="wdg-title">Card headline</label>
                <input id="wdg-title" value={draft.title} maxLength={90} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </div>
              <div className="ui-field">
                <label htmlFor="wdg-body">Description</label>
                <textarea id="wdg-body" rows={2} value={draft.body} maxLength={320} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
              </div>
              <label className="ui-checkbox">
                <input type="checkbox" checked={draft.accentTop} onChange={(e) => setDraft({ ...draft, accentTop: e.target.checked })} />
                Top green accent border
              </label>
              <label className="ui-checkbox widget-consume-check">
                <input
                  type="checkbox"
                  checked={Boolean(draft.availableForConsumption)}
                  onChange={(e) => setDraft({ ...draft, availableForConsumption: e.target.checked })}
                />
                <span>
                  <strong>Available for consumption in chat</strong>
                  <small>When enabled, CEP automatically renders this widget when a customer&apos;s prompt matches.</small>
                </span>
              </label>
            </div>
            <div className="widget-editor-cta-row">
              <button type="button" className="ui-button ui-button-primary" disabled={saving || !draft.name.trim() || !draft.title.trim()} onClick={() => void saveToLibrary()}>
                <BookmarkPlus size={15} aria-hidden="true" />
                {saving ? "Saving…" : editingId ? "Update in library" : "Add to library"}
              </button>
              <button type="button" className="ui-button ui-button-outline" onClick={() => { setDraft(null); setEditingId(undefined); }}>
                Clear
              </button>
            </div>
          </div>

          <div className="ui-work-card widget-preview-panel">
            <header className="ui-preview-head">
              <div><h3>Live interactive preview</h3><p>Try controls directly before saving</p></div>
              <LayoutGrid size={18} aria-hidden="true" />
            </header>
            <div className="widget-preview-stage">
              <LiveWidgetPreview key={draft.kind + "-" + draft.title} widget={draft} />
            </div>
          </div>
        </section>
      )}

      <section className="ui-work-card widget-library-section" aria-labelledby="widget-library-heading">
        <div className="widget-library-header">
          <div>
            <h2 id="widget-library-heading">Widget Library ({widgets.length})</h2>
            <p>
              Toggle <strong>Available in chat</strong> to control which widgets can be consumed live ({widgets.filter((w) => w.availableForConsumption).length} live · {widgets.filter((w) => !w.availableForConsumption).length} draft).
            </p>
          </div>
          <label className="widget-library-search">
            <Search size={14} aria-hidden="true" />
            <input type="search" aria-label="Search widget library" placeholder="Search widgets…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
        </div>

        <div className="widget-library-filters" role="group" aria-label="Filter widgets by type">
          <button type="button" aria-pressed={filterKind === "all"} onClick={() => setFilterKind("all")}>All ({widgets.length})</button>
          {widgetKinds.map((kind) => (
            <button key={kind} type="button" aria-pressed={filterKind === kind} onClick={() => setFilterKind(kind)}>
              {widgetKindLabels[kind]}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <p className="ui-preview-empty">No matching widgets yet. Describe one above and click Generate widget.</p>
        ) : (
          <div className="widget-library-grid">
            {filtered.map((item) => (
              <div key={item.id} className="widget-library-tile">
                <div className="widget-tile-meta">
                  <div>
                    <strong>{item.name}</strong>
                    <span className="widget-tile-kind">{widgetKindLabels[item.kind]}</span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(item.availableForConsumption)}
                    disabled={saving}
                    className={"widget-avail-pill" + (item.availableForConsumption ? " is-live" : " is-draft")}
                    title={item.availableForConsumption ? "Click to mark unavailable for chat consumption" : "Click to mark available for live chat consumption"}
                    onClick={() => void toggleAvailability(item)}
                  >
                    <span className="widget-avail-dot" aria-hidden="true" />
                    {item.availableForConsumption ? "Available in chat" : "Not available (Draft)"}
                  </button>
                </div>
                <LiveWidgetPreview widget={item} compact />
                <div className="widget-tile-actions">
                  <button type="button" className="ui-button ui-button-primary" onClick={() => onInsertIntoLayout(item)}>
                    Use in layout
                  </button>
                  <button type="button" className="ui-button ui-button-outline" onClick={() => {
                    const { id, createdAt: _c, updatedAt: _u, ...rest } = item;
                    setDraft(rest);
                    setEditingId(id);
                    setPrompt(item.prompt);
                    setNotice(`Loaded "${item.name}" into editor.`);
                  }}>
                    <Pencil size={13} aria-hidden="true" />Edit
                  </button>
                  <button type="button" className="ui-quiet-icon" aria-label={`Copy JSON for ${item.name}`} title="Copy widget JSON" onClick={() => {
                    void navigator.clipboard?.writeText(JSON.stringify(item, null, 2));
                    setCopiedId(item.id);
                    window.setTimeout(() => setCopiedId(null), 1500);
                  }}>
                    {copiedId === item.id ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                  </button>
                  <button type="button" className="ui-quiet-icon" aria-label={`Delete ${item.name}`} title="Delete widget" onClick={() => void deleteFromLibrary(item.id, item.name)}>
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
