"use client";

import { LinkProvider } from "@astryxdesign/core/Link";
import { ToastViewport } from "@astryxdesign/core/Toast";
import { Theme as AstryxTheme } from "@astryxdesign/core/theme";
import Link from "next/link";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { saveThemeMode, type ThemeMode } from "../components/theme/theme";
import { agentSmithTheme } from "../theme/generated/agent-smith";

type AppThemeContextValue = {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
};

const AppThemeContext = createContext<AppThemeContextValue | null>(null);

export function AppProviders({ children, initialThemeMode = "system" }: Readonly<{ children: React.ReactNode; initialThemeMode?: ThemeMode }>) {
  const [theme, setCurrentTheme] = useState<ThemeMode>(initialThemeMode);
  const setTheme = useCallback((nextTheme: ThemeMode) => {
    setCurrentTheme(nextTheme);
    saveThemeMode(nextTheme);
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [setTheme, theme]);
  return <AstryxTheme theme={agentSmithTheme} mode={theme}><LinkProvider component={Link}><ToastViewport><AppThemeContext value={value}>{children}</AppThemeContext></ToastViewport></LinkProvider></AstryxTheme>;
}

export function useAppTheme(): AppThemeContextValue {
  const context = useContext(AppThemeContext);
  if (!context) throw new Error("useAppTheme must be used within AppProviders");
  return context;
}
