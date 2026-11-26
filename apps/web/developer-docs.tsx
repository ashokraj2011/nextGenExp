import { ArrowUpRight, Download } from "lucide-react";
import { adminPaths } from "../../packages/contracts/admin-paths";
import { developerGuideHref } from "./admin-navigation";
import gettingStarted from "../../docs/developers/getting-started.md";
import chatUi from "../../docs/developers/chat-ui.md";
import runtime from "../../docs/developers/sfield-and-tools.md";
import workflows from "../../docs/developers/rules-and-workflows.md";
import readToolUrl from "../../docs/developers/examples/read-tool.mjs?url&no-inline";
import "./developer-docs.css";

const guides = [
  { id: "start", label: "Getting started", html: gettingStarted, related: "Interaction map", href: adminPaths.help + "#interactions" },
  { id: "ui", label: "Create a chat UI", html: chatUi, related: "UI Builder", href: adminPaths.builder },
  { id: "sfield", label: "sfield and tools", html: runtime, related: "Tool setup", href: adminPaths.tools },
  { id: "workflows", label: "Rules and workflows", html: workflows, related: "Logs", href: adminPaths.logs },
];

export function DeveloperDocs({ topic }: { topic: string }) {
  const guide = guides.find(({ id }) => id === topic) ?? guides[0];
  return <main className="developer-docs">
    <h1>Developer documentation</h1>
    <nav aria-label="Developer guides" className="developer-docs-nav">
      {guides.map(({ id, label }) => <a key={id} href={developerGuideHref(id)}
        aria-current={guide.id === id ? "page" : undefined}>{label}</a>)}
    </nav>
    <article className="developer-article" aria-label={guide.label}>
      <div className="developer-prose" dangerouslySetInnerHTML={{ __html: guide.html }} />
      <footer>
        <a href={guide.href}>{guide.related} <ArrowUpRight size={15} aria-hidden="true" /></a>
        <a href={adminPaths.help + "#contracts"}>Contract reference <ArrowUpRight size={15} aria-hidden="true" /></a>
        {guide.id === "sfield" && <a href={readToolUrl} download="read-tool.mjs">Download tool example <Download size={15} aria-hidden="true" /></a>}
      </footer>
    </article>
  </main>;
}
