import { lazy, Suspense, useEffect, useState } from "react";
import { domainPackIds } from "../../packages/contracts/domain-packs";
import { uiDesignSchema } from "../../packages/contracts/ui-layout";
import { savedWidgetSchema, widgetDraftSchema } from "../../packages/contracts/widget";
import type { ApprovalRecord } from "../../packages/contracts/approval";
import type { DisplayExperience } from "../../packages/contracts/surface";
import { api, toolSetupErrorMessage } from "./api";
import { ExperienceLayoutPreview } from "./surface";
import "./publication-review.css";

const WidgetPreview = lazy(() => import("./widget-studio").then(({ LiveWidgetPreview }) => ({ default: LiveWidgetPreview })));

export function PublicationReviewDetails({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<ApprovalRecord>();
  const [preview, setPreview] = useState<DisplayExperience>();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError("");
    void api.approval(id).then(async (approval) => {
      if (!alive) return;
      setRecord(approval);
      if (approval.targetKind !== "publication" || approval.action !== "ui-layouts") return;
      const design = uiDesignSchema.safeParse(approval.payload.preview);
      const domain = domainPackIds.find((domain) => domain === approval.payload.scope);
      if (design.success && domain && !design.data.experience) {
        const sample = await api.previewUiLayout(design.data, undefined, domain);
        if (alive) setPreview(sample);
      }
    }).catch((reason: unknown) => {
      if (alive) setError(toolSetupErrorMessage(reason));
    });
    return () => { alive = false; };
  }, [id, open]);

  const widget = record?.action === "widgets" ? savedWidgetSchema.or(widgetDraftSchema).safeParse(record.payload.preview) : undefined;
  return <details className="publication-review-details" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Review prepared change</summary>
    {error && <p role="status">{error}</p>}
    {open && !record && !error && <p role="status">Loading change…</p>}
    {record && <>
      <p>Request status <strong>{record.status === "executed" ? "Published" : record.status}</strong></p>
      <Suspense fallback={<p role="status">Loading preview…</p>}>
        {preview && <ExperienceLayoutPreview data={preview} />}
        {widget?.success && <WidgetPreview widget={widget.data} compact />}
      </Suspense>
      <pre>{JSON.stringify(record.targetKind === "publication" ? {
        change: record.payload.candidate,
        ...(record.payload.preview !== undefined && { reviewedDesign: record.payload.preview }),
      } : record.payload, null, 2)}</pre>
    </>}
  </details>;
}
