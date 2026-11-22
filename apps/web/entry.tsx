import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "./styles.css";

if (location.pathname === "/planning") {
  document.title = "Financial planning · PZN Lab";
  void import("./landing").then(({ Landing }) => createRoot(document.getElementById("root")!).render(<Landing />));
} else if (location.pathname === "/help") {
  document.title = "Help · PZN Lab";
  void import("./help").then(({ Help }) => createRoot(document.getElementById("root")!).render(<Help />));
} else {
  void import("./main");
}
