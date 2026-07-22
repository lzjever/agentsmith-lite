export type Theme = "light" | "dark";

export const themeCookieName = "agentsmith-theme";

export function themeFromCookie(value: string | undefined): Theme {
  return value === "dark" ? "dark" : "light";
}

export function saveThemeMode(theme: Theme): void {
  document.cookie = `${themeCookieName}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
