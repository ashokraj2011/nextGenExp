import { lazy, Suspense, useEffect, useState } from "react";
import { ArrowLeft, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { adminPaths } from "../../packages/contracts/admin-paths";
import { AdminNavigation } from "./admin-navigation";
import { LabMark } from "./lab-mark";
import { ThemeToggle } from "./theme";
import "./admin.css";
import "./admin-workspace.css";

const SIDEBAR_STORAGE_KEY = "cep.adminSidebarCollapsed";

const Tools = lazy(() => import("./admin").then(({ AdminPage }) => ({ default: AdminPage })));
const DataModelStudio = lazy(() => import("./data-model-studio").then(({ DataModelStudio }) => ({ default: DataModelStudio })));
const PolicyStudio = lazy(() => import("./policy-studio").then(({ PolicyStudio }) => ({ default: PolicyStudio })));
const Customer360 = lazy(() => import("./customer-360-admin").then(({ Customer360Admin }) => ({ default: Customer360Admin })));
const Builder = lazy(() => import("./ui-builder").then(({ UiBuilder }) => ({ default: UiBuilder })));
const EmbedStudio = lazy(() => import("./embed-studio").then(({ EmbedStudio }) => ({ default: EmbedStudio })));
const Help = lazy(() => import("./help").then(({ Help }) => ({ default: Help })));
const DeveloperDocs = lazy(() => import("./developer-docs").then(({ DeveloperDocs }) => ({ default: DeveloperDocs })));
const GatewayAdmin = lazy(() => import("./gateway-admin").then(({ GatewayAdmin }) => ({ default: GatewayAdmin })));
const Diagnostics = lazy(() => import("./admin-diagnostics").then(({ AdminDiagnostics }) => ({ default: AdminDiagnostics })));

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function AdminWorkspace() {
  const path = location.pathname;
  const guide = new URLSearchParams(location.search).get("guide");
  const [thread, setThread] = useState(() => new URLSearchParams(location.search).get("thread") ?? "");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed));
    } catch {
      // ignore storage quota errors
    }
  }, [sidebarCollapsed]);

  const toggleSidebar = () => setSidebarCollapsed((prev) => !prev);

  return <div className={"app-layout administration-layout" + (sidebarCollapsed ? " is-sidebar-collapsed" : "")}>
    <aside className="administration-sidebar" aria-label="Admin workspace">
      <div className="admin-sidebar-head">
        <a className="rail-home" href={adminPaths.tools} title="Administration">
          <LabMark />
          <span className="rail-label">Administration</span>
        </a>
        {!sidebarCollapsed && (
          <button
            type="button"
            className="admin-sidebar-toggle"
            onClick={toggleSidebar}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
            aria-expanded={true}
          >
            <PanelLeftClose size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      {sidebarCollapsed && (
        <button
          type="button"
          className="admin-sidebar-toggle is-rail-expand"
          onClick={toggleSidebar}
          title="Expand sidebar"
          aria-label="Expand sidebar"
          aria-expanded={false}
        >
          <PanelLeftOpen size={16} aria-hidden="true" />
        </button>
      )}
      <AdminNavigation thread={thread} collapsed={sidebarCollapsed} />
    </aside>
    <div className="workspace">
      <header className="topbar administration-topbar">
        <div className="topbar-left">
          <button
            type="button"
            className="admin-topbar-sidebar-btn"
            onClick={toggleSidebar}
            title={sidebarCollapsed ? "Expand navigation panel" : "Collapse navigation panel"}
            aria-label={sidebarCollapsed ? "Expand navigation panel" : "Collapse navigation panel"}
            aria-expanded={!sidebarCollapsed}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}
          </button>
          <span className="workspace-page-title">CEP</span>
        </div>
        <div className="admin-topbar-right">
          <ThemeToggle />
          <a className="workspace-back" href="/chat"><ArrowLeft size={16} aria-hidden="true" />Customer view</a>
        </div>
      </header>
      <div className="workspace-page-scroll">
        <Suspense fallback={<p className="workspace-loading" role="status">Loading…</p>}>
          {path === adminPaths.tools && <Tools />}
          {path === adminPaths.dataModels && <DataModelStudio />}
          {path === adminPaths.recommendations && <PolicyStudio initialTab="pzn" />}
          {path === adminPaths.customers && <Customer360 />}
          {path === adminPaths.intents && <PolicyStudio initialTab="intents" />}
          {path === adminPaths.builder && <Builder />}
          {path === adminPaths.embed && <EmbedStudio />}
          {path === adminPaths.help && (guide ? <DeveloperDocs topic={guide} /> : <Help />)}
          {path === adminPaths.gateway && <GatewayAdmin />}
          {(path === adminPaths.logs || path === adminPaths.inspector) && <Diagnostics view={path === adminPaths.logs ? "logs" : "inspector"} selectThread={setThread} />}
        </Suspense>
      </div>
    </div>
  </div>;
}
