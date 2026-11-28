import { lazy, Suspense, useEffect, useState } from "react";
import { GitBranch, Layers, ShieldCheck } from "lucide-react";

const ExperienceRegistryAdmin = lazy(() =>
  import("./experience-registry-admin").then(({ ExperienceRegistryAdmin }) => ({ default: ExperienceRegistryAdmin })),
);
const RecommendationStudio = lazy(() =>
  import("./recommendation-studio").then(({ RecommendationStudio }) => ({ default: RecommendationStudio })),
);
const PznArchitectureDemo = lazy(() =>
  import("./pzn-architecture-demo").then(({ PznArchitectureDemo }) => ({ default: PznArchitectureDemo })),
);

export type PolicyStudioTab = "intents" | "pzn" | "sandbox";

function readRequestedTab(fallback: PolicyStudioTab): PolicyStudioTab {
  const param = new URLSearchParams(location.search).get("tab");
  if (param === "intents" || param === "pzn" || param === "sandbox") return param;
  return fallback;
}

export function PolicyStudio({ initialTab = "intents" }: { initialTab?: PolicyStudioTab }) {
  const [tab, setTab] = useState<PolicyStudioTab>(() => readRequestedTab(initialTab));

  useEffect(() => {
    setTab(readRequestedTab(initialTab));
  }, [initialTab]);

  function selectTab(next: PolicyStudioTab) {
    setTab(next);
    const url = new URL(location.href);
    url.searchParams.set("tab", next);
    history.replaceState(history.state, "", url);
  }

  return (
    <div className="policy-studio-shell">
      <div className="policy-studio-bar">
        <div className="policy-studio-bar-copy">
          <span className="policy-studio-eyebrow">Unified Policy Plane</span>
          <strong>Policies, Intents &amp; Pluggable PZN Tool</strong>
        </div>
        <div className="policy-studio-tabs" role="tablist" aria-label="Policy studio sections">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "intents"}
            className={"policy-studio-tab" + (tab === "intents" ? " is-active" : "")}
            onClick={() => selectTab("intents")}
          >
            <GitBranch size={14} aria-hidden="true" />
            Intents &amp; Catalog
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "pzn"}
            className={"policy-studio-tab" + (tab === "pzn" ? " is-active" : "")}
            onClick={() => selectTab("pzn")}
          >
            <Layers size={14} aria-hidden="true" />
            PZN Rules &amp; Treatments
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "sandbox"}
            className={"policy-studio-tab" + (tab === "sandbox" ? " is-active" : "")}
            onClick={() => selectTab("sandbox")}
          >
            <ShieldCheck size={14} aria-hidden="true" />
            PZN Tool Sandbox
          </button>
        </div>
      </div>

      <Suspense fallback={<p className="workspace-loading" role="status">Loading policy studio…</p>}>
        {tab === "intents" && <ExperienceRegistryAdmin />}
        {tab === "pzn" && <RecommendationStudio />}
        {tab === "sandbox" && <PznArchitectureDemo embedded />}
      </Suspense>
    </div>
  );
}
