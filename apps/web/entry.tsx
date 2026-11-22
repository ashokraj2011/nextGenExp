import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "./styles.css";

if (location.pathname === "/") {
  void import("./landing").then(({ Landing }) => createRoot(document.getElementById("root")!).render(<Landing />));
} else {
  void import("./main");
}
