import { useEffect, useState } from "react";
import { Database } from "lucide-react";
import { DOMAIN_PACKS, getDomainPack, type DomainPackId } from "../../packages/contracts/domain-packs";
import { DomainToolsAndModelPanel } from "./domain-tools-model";
import { setStoredDomainPack } from "./domain-pack-ui";

function readInitialDomain(): DomainPackId {
  const param = new URLSearchParams(location.search).get("domain");
  if (param === "wealth" || param === "it_ops" || param === "sales_revops") return param;
  return "wealth";
}

export function DataModelStudio() {
  const [domainId, setDomainId] = useState<DomainPackId>(readInitialDomain);
  const activePack = getDomainPack(domainId);

  useEffect(() => {
    document.title = `Data Models · ${activePack.shortLabel} · Administration`;
  }, [activePack.shortLabel]);

  function selectDomain(next: DomainPackId) {
    setDomainId(next);
    setStoredDomainPack(next);
    const params = new URLSearchParams(location.search);
    params.set("domain", next);
    history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
  }

  return (
    <main className="admin-page" style={{ maxWidth: "1440px" }}>
      <header className="admin-heading" style={{ marginBottom: "14px" }}>
        <div>
          <p className="eyebrow" style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <Database size={13} aria-hidden="true" />
            smass · Operational Virtual Data Model
          </p>
          <h1>Data Model Studio</h1>
          <p>
            Compose canonical virtual entities by dragging closed JSON Schema fields from registered <code>sfield</code> tools, renaming columns or models, adding aggregates and derived columns, and verifying live 1× snapshots.
          </p>
        </div>
      </header>

      <nav className="admin-domain-bar" aria-label="Domain workspace">
        <div className="admin-domain-tabs" role="tablist" aria-label="Domains">
          {DOMAIN_PACKS.map((pack) => (
            <button
              key={pack.id}
              type="button"
              role="tab"
              aria-selected={domainId === pack.id}
              className={`admin-domain-tab${domainId === pack.id ? " active" : ""}`}
              onClick={() => selectDomain(pack.id)}
            >
              {pack.shortLabel}
            </button>
          ))}
        </div>
        <div className="admin-domain-meta">
          <span><strong>{activePack.label}</strong> · {activePack.subtitle}</span>
          <span>Source: <code>{activePack.dataSourceLabel}</code></span>
        </div>
      </nav>

      <DomainToolsAndModelPanel domainId={domainId} defaultOpenBuilder />
    </main>
  );
}
