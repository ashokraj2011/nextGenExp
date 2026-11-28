export const adminPaths = {
  tools: "/admin",
  dataModels: "/admin/data-models",
  system: "/admin/system",
  recommendations: "/admin/recommendations",
  customers: "/admin/customers",
  intents: "/admin/intents",
  builder: "/admin/ui",
  logs: "/admin/logs",
  inspector: "/admin/inspector",
  embed: "/admin/embed",
  help: "/admin/help",
  chat: "/admin/chat",
  gateway: "/admin/gateway",
  sfieldStudio: "/admin/sfield-studio",
} as const;

export const isAdminPath = (path: string) => path === adminPaths.tools || path.startsWith("/admin/");
export const approvalChatHref = (id?: string) =>
  adminPaths.chat + "?review=" + encodeURIComponent(id ?? "pending");
