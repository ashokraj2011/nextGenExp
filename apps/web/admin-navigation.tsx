import { BookOpenText, Code2, FileText, MessageSquare, PanelsTopLeft, Settings2 } from "lucide-react";
import { adminPaths } from "../../packages/contracts/admin-paths";

export function diagnosticHref(path: typeof adminPaths.logs | typeof adminPaths.inspector, thread?: string, turn?: string) {
  const params = new URLSearchParams();
  if (thread) params.set("thread", thread);
  if (turn) params.set("turn", turn);
  return params.size ? path + "?" + params : path;
}

const destinations = [
  { label: "Tool setup", path: adminPaths.tools, Icon: Settings2 },
  { label: "UI Builder", path: adminPaths.builder, Icon: PanelsTopLeft },
  { label: "Logs", path: adminPaths.logs, Icon: FileText },
  { label: "Inspector", path: adminPaths.inspector, Icon: Code2 },
  { label: "Architecture", path: adminPaths.help, Icon: BookOpenText },
  { label: "Test chat", path: adminPaths.chat, Icon: MessageSquare },
] as const;

export function AdminNavigation({ thread }: { thread?: string }) {
  return <nav className="admin-navigation" aria-label="Administration">
    {destinations.map(({ label, path, Icon }) => <a key={path} className="rail-link"
      href={path === adminPaths.logs || path === adminPaths.inspector ? diagnosticHref(path, thread) : path}
      aria-current={location.pathname === path ? "page" : undefined}>
      <Icon size={17} aria-hidden="true" />{label}
    </a>)}
  </nav>;
}
