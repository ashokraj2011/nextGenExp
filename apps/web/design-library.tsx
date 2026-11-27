import { useState } from "react";
import { getDomainPack } from "../../packages/contracts/domain-packs";
import type { LibraryDesign, UiLayoutCatalog, UiLayoutRecord } from "../../packages/contracts/ui-layout";

export function DesignLibrary({ tenantId, library, records, targets, canCopy, onOpen, onCopy }: {
  tenantId: string; library: LibraryDesign[]; records: UiLayoutRecord[]; targets: UiLayoutCatalog["targets"]; canCopy: boolean;
  onOpen(id: string): void; onCopy(item: LibraryDesign): void;
}) {
  const [domain, setDomain] = useState("");
  const domains = [...new Set(library.map((item) => item.domainId))];
  const visible = domain ? library.filter((item) => item.domainId === domain) : library;
  return <section className="ui-work-card shared-design-library" aria-label="Shared design library">
    <div className="widget-library-header">
      <div><h2>Shared design library</h2><p>Published designs for {tenantId}.</p></div>
      {domains.length > 1 && <label>Domain <select value={domain} onChange={(e) => setDomain(e.target.value)}>
        <option value="">All my domains</option>
        {domains.map((id) => <option key={id} value={id}>{getDomainPack(id).label}</option>)}
      </select></label>}
    </div>
    {!visible.length && <p>No published designs yet.</p>}
    <div className="widget-library-grid">{visible.map((item) => <article key={item.id} className="widget-library-tile">
      <small>{getDomainPack(item.domainId).label} · Revision {item.revision}</small>
      <h3>{item.design.name}</h3><p>{item.design.description}</p>
      {item.design.experience ? <p>{item.design.experience.audience === "customer" ? "Customer chat" : "Operator chat"} · {item.design.experience.actions.length} actions</p> : <p>{item.design.targets.map((target) => targets.find((option) => option.target.kind === target.kind && option.target.id === target.id)?.label ?? target.id).join(" · ")}</p>}
      <div className="design-library-actions">
        {records.some((record) => record.id === item.id) && <button className="ui-button ui-button-outline" type="button" onClick={() => onOpen(item.id)}>Edit my design</button>}
        {canCopy && <button className="ui-button ui-button-outline" type="button" onClick={() => onCopy(item)}>Use as template</button>}
      </div>
    </article>)}</div>
  </section>;
}
