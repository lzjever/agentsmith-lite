import type { ThemeMode } from "@astryxdesign/core/theme";

export const agentSmithThemeName = "agent-smith";
export const themeCookieName = "agentsmith-theme";

export function parseThemeMode(value: string | undefined): ThemeMode {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function serializeThemeModeCookie(themeMode: ThemeMode): string {
  if (themeMode === "system") {
    return `${themeCookieName}=; Path=/; Max-Age=0; SameSite=Lax`;
  }
  return `${themeCookieName}=${themeMode}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export function saveThemeMode(themeMode: ThemeMode): void {
  document.cookie = serializeThemeModeCookie(themeMode);
}

export function themeHtmlAttributes(themeMode: ThemeMode):
  | { "data-astryx-theme": typeof agentSmithThemeName }
  | { "data-astryx-theme": typeof agentSmithThemeName; "data-theme": "light" | "dark" } {
  if (themeMode === "system") {
    return { "data-astryx-theme": agentSmithThemeName };
  }
  return {
    "data-astryx-theme": agentSmithThemeName,
    "data-theme": themeMode,
  };
}

export type { ThemeMode };
