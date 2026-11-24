export const adminPaths = {
  tools: "/admin",
  builder: "/admin/ui",
  logs: "/admin/logs",
  inspector: "/admin/inspector",
  help: "/admin/help",
  chat: "/admin/chat",
} as const;

export const isAdminPath = (path: string) => path === adminPaths.tools || path.startsWith("/admin/");
