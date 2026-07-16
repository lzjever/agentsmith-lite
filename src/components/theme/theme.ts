export type Theme = "light" | "dark";

const storageKey = "agentsmith-theme";

export function storedTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(storageKey);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: Theme, persist = true): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  if (!persist) return;
  try {
    window.localStorage.setItem(storageKey, theme);
  } catch {
    // The selected theme still applies when storage is unavailable.
  }
}
