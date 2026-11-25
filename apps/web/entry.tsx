import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import { adminPaths, isAdminPath } from "../../packages/contracts/admin-paths";
import { readProfileSession, saveProfileSession } from "./conversation-storage";
import { setStoredDomainPack } from "./domain-pack-ui";
import { applyTheme, initTheme } from "./theme";
import "./styles.css";
import "./theme.css";

initTheme();

if (location.pathname === "/embed") {
  const params = new URLSearchParams(location.search);
  const themeParam = params.get("theme");
  if (themeParam === "dark" || themeParam === "light") applyTheme(themeParam);
  const domainParam = params.get("domain");
  if (domainParam === "wealth" || domainParam === "it_ops" || domainParam === "sales_revops") {
    setStoredDomainPack(domainParam);
  }
  const personaParam = params.get("personaId") || readProfileSession() || "persona_new_investor";
  saveProfileSession(personaParam);
  document.documentElement.dataset.embed = "true";
  void import("./main");
} else if (["/", "/chat"].includes(location.pathname) && readProfileSession() === "") {
  location.replace("/login" + location.search);
} else if (isAdminPath(location.pathname) && location.pathname !== adminPaths.chat) {
  document.title = "Administration · CEP";
  void import("./admin-workspace").then(({ AdminWorkspace }) => createRoot(document.getElementById("root")!).render(<AdminWorkspace />));
} else if (location.pathname === "/login") {
  document.title = "Sign in · CEP";
  void import("./login").then(({ Login }) => createRoot(document.getElementById("root")!).render(<Login />));
} else if (location.pathname === "/planning") {
  document.title = "Financial planning · CEP";
  void import("./landing").then(({ Landing }) => createRoot(document.getElementById("root")!).render(<Landing />));
} else {
  void import("./main");
}
