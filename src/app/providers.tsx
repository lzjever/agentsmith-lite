"use client";

import { LayerProvider } from "@astryxdesign/core";
import { LinkProvider } from "@astryxdesign/core/Link";
import { Theme as AstryxTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import Link from "next/link";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { saveThemeMode, type Theme } from "../components/theme/theme";

type AppThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const AppThemeContext = createContext<AppThemeContextValue | null>(null);

export function AppProviders({ children, initialThemeMode = "light" }: Readonly<{ children: React.ReactNode; initialThemeMode?: Theme }>) {
  const [theme, setCurrentTheme] = useState<Theme>(initialThemeMode);
  const setTheme = useCallback((nextTheme: Theme) => {
    setCurrentTheme(nextTheme);
    saveThemeMode(nextTheme);
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [setTheme, theme]);
  return <AstryxTheme theme={neutralTheme} mode={theme}><LinkProvider component={Link}><LayerProvider><AppThemeContext value={value}>{children}</AppThemeContext></LayerProvider></LinkProvider></AstryxTheme>;
}

export function useAppTheme(): AppThemeContextValue {
  const context = useContext(AppThemeContext);
  if (!context) throw new Error("useAppTheme must be used within AppProviders");
  return context;
}
