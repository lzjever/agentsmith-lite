"use client";

import { LinkProvider } from "@astryxdesign/core/Link";
import { Theme as AstryxTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { storedTheme, systemTheme, themeStorageKey, type Theme } from "../components/theme/theme";

type AppThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const AppThemeContext = createContext<AppThemeContextValue | null>(null);

function initialTheme(): Theme {
  return storedTheme() ?? systemTheme();
}

export function AppProviders({ children }: Readonly<{ children: React.ReactNode }>) {
  const [theme, setCurrentTheme] = useState<Theme>(initialTheme);
  const setTheme = useCallback((nextTheme: Theme) => {
    setCurrentTheme(nextTheme);
    try {
      window.localStorage.setItem(themeStorageKey, nextTheme);
    } catch {
      // The selected theme still applies when storage is unavailable.
    }
  }, []);

  useEffect(() => {
    if (storedTheme() || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const followSystem = () => {
      if (!storedTheme()) setCurrentTheme(media.matches ? "dark" : "light");
    };
    media.addEventListener("change", followSystem);
    return () => media.removeEventListener("change", followSystem);
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [setTheme, theme]);
  return <AstryxTheme theme={neutralTheme} mode={theme}><LinkProvider component={Link}><AppThemeContext value={value}>{children}</AppThemeContext></LinkProvider></AstryxTheme>;
}

export function useAppTheme(): AppThemeContextValue {
  const context = useContext(AppThemeContext);
  if (!context) throw new Error("useAppTheme must be used within AppProviders");
  return context;
}
