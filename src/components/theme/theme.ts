export type Theme = "light" | "dark";

const storageKey = "agentsmith-theme";

export function storedTheme(): Theme {
  return typeof window !== "undefined" && window.localStorage.getItem(storageKey) === "dark" ? "dark" : "light";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  window.localStorage.setItem(storageKey, theme);
}
