import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CreateSurfaceMessageSchema, type ActionMessage } from "@a2ui/web_core/v1_0";
import { installA2uiStyles, MountedSurface } from "../apps/web/surface";
import fixture from "../fixtures/a2ui-v1-basic-smoke.json";

const input = CreateSurfaceMessageSchema.parse(fixture);
function RendererProbe() {
  const [action, setAction] = useState<ActionMessage>();
  return <>
    <MountedSurface id={input.createSurface.surfaceId} input={input} basic onAction={setAction} />
    {action && <output data-testid="a2ui-action">{JSON.stringify(action)}</output>}
  </>;
}
installA2uiStyles();
createRoot(document.getElementById("root")!).render(<RendererProbe />);
