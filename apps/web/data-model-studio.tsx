import { useEffect, useState } from "react";
import { getDomainPack, type DomainPackId } from "../../packages/contracts/domain-packs";
import { setStoredDomainPack } from "./domain-pack-ui";
import { ErModelerStudio } from "./er-modeler-canvas";

function readInitialDomain(): DomainPackId {
  const param = new URLSearchParams(location.search).get("domain");
  if (param === "wealth" || param === "it_ops" || param === "sales_revops") return param;
  return "wealth";
}

export function DataModelStudio() {
  const [domainId, setDomainId] = useState<DomainPackId>(readInitialDomain);
  const activePack = getDomainPack(domainId);

  useEffect(() => {
    document.title = `ER Data Modeler · ${activePack.shortLabel} · Administration`;
  }, [activePack.shortLabel]);

  function selectDomain(next: DomainPackId) {
    setDomainId(next);
    setStoredDomainPack(next);
    const params = new URLSearchParams(location.search);
    params.set("domain", next);
    history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
  }

  return <ErModelerStudio domainId={domainId} onSelectDomain={selectDomain} />;
}
