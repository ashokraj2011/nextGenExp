import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import { adminPaths, isAdminPath } from "../../packages/contracts/admin-paths";
import { accountPortalPath } from "../../packages/contracts/workspace";
import { domainPackFromPath, getDomainPack } from "../../packages/contracts/domain-packs";
import { readProfileSession, saveProfileSession } from "./conversation-storage";
import { setStoredDomainPack } from "./domain-pack-ui";
import { applyTheme, initTheme } from "./theme";
import { PublicationReviewNotice } from "./publication-review-notice";
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
  const personaParam = params.get("personaId") || readProfileSession() || "demo-learner";
  saveProfileSession(personaParam);
  document.documentElement.dataset.embed = "true";
  void import("./main");
} else if (["/", "/chat", "/wealth"].includes(location.pathname)) {
  const personaParam = new URLSearchParams(location.search).get("personaId")?.trim();
  if (personaParam) {
    saveProfileSession(personaParam);
    document.title = "Wealth Advisory";
    void fetch("/api/profile-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personaId: personaParam }),
    }).catch(() => undefined).finally(() => {
      void import("./main");
    });
  } else if (readProfileSession() === "") {
    location.replace("/login" + location.search);
  } else {
    document.title = "Wealth Advisory";
    void import("./main");
  }
} else if (isAdminPath(location.pathname) && location.pathname !== adminPaths.chat) {
  document.title = "Administration";
  void import("./admin-workspace").then(({ AdminWorkspace }) => createRoot(document.getElementById("root")!).render(<><AdminWorkspace /><PublicationReviewNotice /></>));
} else if (location.pathname === "/integrations") {
  document.title = "Integrations";
  void import("./integrations-workspace").then(({ IntegrationsWorkspace }) => createRoot(document.getElementById("root")!).render(<><IntegrationsWorkspace /><PublicationReviewNotice /></>));
} else if (location.pathname === "/recommendations") {
  document.title = "Recommendations Workspace";
  void import("./recommendation-workspace").then(({ RecommendationWorkspace }) => createRoot(document.getElementById("root")!).render(<><RecommendationWorkspace /><PublicationReviewNotice /></>));
} else if (location.pathname === "/advisor") {
  document.title = "Advisor Co-Pilot & Shared Card Room";
  void import("./advisor-workspace").then(({ AdvisorWorkspace }) => createRoot(document.getElementById("root")!).render(<AdvisorWorkspace />));
} else if (location.pathname === accountPortalPath) {
  document.title = "Account funding · Account portal";
  void import("./funding-portal").then(({ FundingPortal }) => createRoot(document.getElementById("root")!).render(<FundingPortal />));
} else if (location.pathname === "/login") {
  document.title = "Sign in";
  void import("./login").then(({ Login }) => createRoot(document.getElementById("root")!).render(<Login />));
} else if (location.pathname === "/planning") {
  document.title = "Financial planning";
  void import("./landing").then(({ Landing }) => createRoot(document.getElementById("root")!).render(<Landing />));
} else {
  const pathDomain = domainPackFromPath(location.pathname);
  if (pathDomain && pathDomain !== "wealth") {
    if (readProfileSession() === "") saveProfileSession("demo-learner");
    document.title = `${getDomainPack(pathDomain).label}`;
  } else if (pathDomain === "wealth") {
    document.title = "Wealth Advisory";
  }
  void import("./main");
}
