import { Activity, Blocks, Cpu, BookOpenText, Briefcase, Code2, FileText, GitBranch, Landmark, Layers, MessageSquare, Plug, PanelsTopLeft, Settings2, UsersRound } from "lucide-react";
import { adminPaths } from "../../packages/contracts/admin-paths";

export function diagnosticHref(path: typeof adminPaths.logs | typeof adminPaths.inspector, thread?: string, turn?: string) {
  const params = new URLSearchParams();
  if (thread) params.set("thread", thread);
  if (turn) params.set("turn", turn);
  return params.size ? path + "?" + params : path;
}

const destinations = [
  { label: "Tool setup", path: adminPaths.tools, Icon: Settings2 },
  { label: "Model gateway", path: adminPaths.gateway, Icon: Cpu },
  { label: "Recommendations", path: adminPaths.recommendations, Icon: Layers },
  { label: "Customer 360", path: adminPaths.customers, Icon: UsersRound },
  { label: "Intents & Catalog", path: adminPaths.intents, Icon: GitBranch },
  { label: "UI Builder", path: adminPaths.builder, Icon: PanelsTopLeft },
  { label: "Embed SDK", path: adminPaths.embed, Icon: Blocks },
  { label: "Logs", path: adminPaths.logs, Icon: FileText },
  { label: "Inspector", path: adminPaths.inspector, Icon: Code2 },
  { label: "Architecture", path: adminPaths.help, Icon: BookOpenText },
  { label: "Test chat", path: adminPaths.chat, Icon: MessageSquare },
] as const;

const workspaceDestinations = [
  { label: "Wealth (/wealth)", path: "/wealth", Icon: Landmark },
  { label: "IT Ops (/it-ops)", path: "/it-ops", Icon: Activity },
  { label: "RevOps (/revops)", path: "/revops", Icon: Briefcase },
  { label: "Recommendations (/recommendations)", path: "/recommendations", Icon: Layers },
  { label: "Integrations (/integrations)", path: "/integrations", Icon: Plug },
] as const;

export function AdminNavigation({ thread }: { thread?: string }) {
  return <nav className="admin-navigation" aria-label="Administration">
    {destinations.map(({ label, path, Icon }) => <a key={path} className="rail-link"
      href={path === adminPaths.logs || path === adminPaths.inspector ? diagnosticHref(path, thread) : path}
      aria-current={location.pathname === path ? "page" : undefined}>
      <Icon size={17} aria-hidden="true" />{label}
    </a>)}
    <div style={{ margin: "12px 10px 4px", fontSize: "0.68rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)" }}>
      Workspaces
    </div>
    {workspaceDestinations.map(({ label, path, Icon }) => <a key={path} className="rail-link" href={path}>
      <Icon size={16} aria-hidden="true" />{label}
    </a>)}
  </nav>;
}
