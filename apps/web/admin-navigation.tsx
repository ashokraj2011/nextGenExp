import { Activity, Blocks, Cpu, BookOpenText, Briefcase, Code2, Database, FileText, GitBranch, HardDrive, Landmark, MessageSquare, Plug, PanelsTopLeft, Settings2, TerminalSquare, UsersRound } from "lucide-react";
import { adminPaths, approvalChatHref } from "../../packages/contracts/admin-paths";

export const developerGuideHref = (guide = "start") => adminPaths.help + "?guide=" + encodeURIComponent(guide);

export function diagnosticHref(path: typeof adminPaths.logs | typeof adminPaths.inspector, thread?: string, turn?: string) {
  const params = new URLSearchParams();
  if (thread) params.set("thread", thread);
  if (turn) params.set("turn", turn);
  return params.size ? path + "?" + params : path;
}

const destinations = [
  { label: "Tool setup", path: adminPaths.tools, Icon: Settings2 },
  { label: "Data Models", path: adminPaths.dataModels, Icon: Database },
  { label: "System Config", path: adminPaths.system, Icon: HardDrive },
  { label: "Model gateway", path: adminPaths.gateway, Icon: Cpu },
  { label: "Customer 360", path: adminPaths.customers, Icon: UsersRound },
  { label: "Policies & Rules", path: adminPaths.intents, Icon: GitBranch },
  { label: "sphoton UI Studio", path: adminPaths.builder, Icon: PanelsTopLeft },
  { label: "Embed SDK", path: adminPaths.embed, Icon: Blocks },
  { label: "Logs", path: adminPaths.logs, Icon: FileText },
  { label: "Inspector", path: adminPaths.inspector, Icon: Code2 },
  { label: "sfield Studio", path: adminPaths.sfieldStudio, Icon: TerminalSquare },
  { label: "Architecture", path: adminPaths.help, Icon: BookOpenText },
  { label: "Developer docs", path: developerGuideHref(), Icon: Code2 },
  { label: "Admin chat", path: adminPaths.chat, Icon: MessageSquare },
  { label: "Approvals chat", path: approvalChatHref(), Icon: FileText },
] as const;

const workspaceDestinations = [
  { label: "Wealth (/wealth)", path: "/wealth", Icon: Landmark },
  { label: "IT Ops (/it-ops)", path: "/it-ops", Icon: Activity },
  { label: "RevOps (/revops)", path: "/revops", Icon: Briefcase },
  { label: "Integrations (/integrations)", path: "/integrations", Icon: Plug },
] as const;

export function AdminNavigation({ thread, collapsed = false }: { thread?: string; collapsed?: boolean }) {
  const current = location.pathname === adminPaths.help && new URLSearchParams(location.search).get("guide")
    ? developerGuideHref()
    : location.pathname === adminPaths.recommendations
      ? adminPaths.intents
      : location.pathname;
  return <nav className="admin-navigation" aria-label="Administration">
    {destinations.map(({ label, path, Icon }) => <a key={path} className="rail-link"
      href={path === adminPaths.logs || path === adminPaths.inspector ? diagnosticHref(path, thread) : path}
      aria-current={current === path ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}>
      <Icon size={17} aria-hidden="true" />
      <span className="rail-label">{label}</span>
    </a>)}
    <div className="admin-nav-section-title" aria-hidden={collapsed || undefined}>
      Workspaces
    </div>
    {workspaceDestinations.map(({ label, path, Icon }) => <a key={path} className="rail-link" href={path}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}>
      <Icon size={16} aria-hidden="true" />
      <span className="rail-label">{label}</span>
    </a>)}
  </nav>;
}
