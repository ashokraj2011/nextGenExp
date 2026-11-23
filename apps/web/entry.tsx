import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import { readProfileSession } from "./conversation-storage";
import "./styles.css";

if ((location.pathname === "/" || location.pathname === "/chat") && readProfileSession() === "") {
  location.replace("/login" + location.search);
} else if (location.pathname === "/login") {
  document.title = "Sign in · PZN Lab";
  void import("./login").then(({ Login }) => createRoot(document.getElementById("root")!).render(<Login />));
} else if (location.pathname === "/planning") {
  document.title = "Financial planning · PZN Lab";
  void import("./landing").then(({ Landing }) => createRoot(document.getElementById("root")!).render(<Landing />));
} else if (location.pathname === "/help") {
  document.title = "Help · PZN Lab";
  void import("./help").then(({ Help }) => createRoot(document.getElementById("root")!).render(<Help />));
} else {
  void import("./main");
}
