import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import { adminPaths, isAdminPath } from "../../packages/contracts/admin-paths";
import { readProfileSession } from "./conversation-storage";
import "./styles.css";

if (["/", "/chat"].includes(location.pathname) && readProfileSession() === "") {
  location.replace("/login" + location.search);
} else if (isAdminPath(location.pathname) && location.pathname !== adminPaths.chat) {
  document.title = "Administration · PZN Lab";
  void import("./admin-workspace").then(({ AdminWorkspace }) => createRoot(document.getElementById("root")!).render(<AdminWorkspace />));
} else if (location.pathname === "/login") {
  document.title = "Sign in · PZN Lab";
  void import("./login").then(({ Login }) => createRoot(document.getElementById("root")!).render(<Login />));
} else if (location.pathname === "/planning") {
  document.title = "Financial planning · PZN Lab";
  void import("./landing").then(({ Landing }) => createRoot(document.getElementById("root")!).render(<Landing />));
} else {
  void import("./main");
}
