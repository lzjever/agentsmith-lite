import type { Metadata } from "next";
import { appFontVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentSmith",
  description: "AgentSmith project workspace"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const themeScript = "try { const saved = localStorage.getItem('agentsmith-theme'); const theme = saved === 'light' || saved === 'dark' ? saved : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; } catch { const theme = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; }";
  return <html lang="en" data-theme="light" suppressHydrationWarning><body className={appFontVariables}><script dangerouslySetInnerHTML={{ __html: themeScript }} />{children}</body></html>;
}
