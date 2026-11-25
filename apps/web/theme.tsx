import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

export type CepTheme = "light" | "dark";
const STORAGE_KEY = "cep-theme";
const EVENT_NAME = "cep-theme-change";

export function readStoredTheme(): CepTheme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: CepTheme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch { /* Storage may be restricted. */ }
  window.dispatchEvent(new CustomEvent<CepTheme>(EVENT_NAME, { detail: theme }));
}

export function initTheme() {
  const theme = readStoredTheme();
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<CepTheme>(() => readStoredTheme());

  useEffect(() => {
    const sync = (event: Event) => {
      const next = (event as CustomEvent<CepTheme>).detail;
      if (next === "light" || next === "dark") setTheme(next);
    };
    window.addEventListener(EVENT_NAME, sync);
    return () => window.removeEventListener(EVENT_NAME, sync);
  }, []);

  const nextTheme: CepTheme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className={"theme-toggle-btn" + (compact ? " is-compact" : "")}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      aria-pressed={theme === "dark"}
      onClick={() => {
        applyTheme(nextTheme);
        setTheme(nextTheme);
      }}
    >
      {theme === "dark" ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}
      {!compact && <span>{theme === "dark" ? "Light" : "Dark"}</span>}
    </button>
  );
}
