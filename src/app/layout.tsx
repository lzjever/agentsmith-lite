import type { Metadata } from "next";
import { appFontVariables } from "./fonts";
import "./globals.css";
import { AppProviders } from "./providers";

export const metadata: Metadata = {
  title: "AgentSmith",
  description: "AgentSmith project workspace"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const themeScript = "try { const saved = localStorage.getItem('agentsmith-theme'); document.documentElement.dataset.theme = saved === 'light' || saved === 'dark' ? saved : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch { document.documentElement.dataset.theme = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }";
  return <html lang="en" data-theme="light" suppressHydrationWarning><body className={appFontVariables}><script dangerouslySetInnerHTML={{ __html: themeScript }} /><AppProviders>{children}</AppProviders></body></html>;
}
