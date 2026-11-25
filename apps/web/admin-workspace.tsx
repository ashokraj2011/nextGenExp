import { lazy, Suspense, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { adminPaths } from "../../packages/contracts/admin-paths";
import { AdminNavigation } from "./admin-navigation";
import { LabMark } from "./lab-mark";
import { ThemeToggle } from "./theme";
import "./admin.css";
import "./admin-workspace.css";

const Tools = lazy(() => import("./admin").then(({ AdminPage }) => ({ default: AdminPage })));
const Customer360 = lazy(() => import("./customer-360-admin").then(({ Customer360Admin }) => ({ default: Customer360Admin })));
const ExperienceRegistry = lazy(() => import("./experience-registry-admin").then(({ ExperienceRegistryAdmin }) => ({ default: ExperienceRegistryAdmin })));
const Builder = lazy(() => import("./ui-builder").then(({ UiBuilder }) => ({ default: UiBuilder })));
const EmbedStudio = lazy(() => import("./embed-studio").then(({ EmbedStudio }) => ({ default: EmbedStudio })));
const Help = lazy(() => import("./help").then(({ Help }) => ({ default: Help })));
const Diagnostics = lazy(() => import("./admin-diagnostics").then(({ AdminDiagnostics }) => ({ default: AdminDiagnostics })));

export function AdminWorkspace() {
  const path = location.pathname;
  const [thread, setThread] = useState(() => new URLSearchParams(location.search).get("thread") ?? "");
  return <div className="app-layout administration-layout">
    <aside className="administration-sidebar" aria-label="Admin workspace">
      <a className="rail-home" href={adminPaths.tools}><LabMark />Administration</a>
      <AdminNavigation thread={thread} />
    </aside>
    <div className="workspace">
      <header className="topbar administration-topbar">
        <span className="workspace-page-title">CEP</span>
        <div className="admin-topbar-right">
          <ThemeToggle />
          <a className="workspace-back" href="/chat"><ArrowLeft size={16} aria-hidden="true" />Customer view</a>
        </div>
      </header>
      <div className="workspace-page-scroll">
        <Suspense fallback={<p className="workspace-loading" role="status">Loading…</p>}>
          {path === adminPaths.tools && <Tools />}
          {path === adminPaths.customers && <Customer360 />}
          {path === adminPaths.intents && <ExperienceRegistry />}
          {path === adminPaths.builder && <Builder />}
          {path === adminPaths.embed && <EmbedStudio />}
          {path === adminPaths.help && <Help />}
          {(path === adminPaths.logs || path === adminPaths.inspector) && <Diagnostics view={path === adminPaths.logs ? "logs" : "inspector"} selectThread={setThread} />}
        </Suspense>
      </div>
    </div>
  </div>;
}
