import type { Metadata } from "next";
import { appFontVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentSmith",
  description: "AgentSmith project workspace"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const themeScript = "try { document.documentElement.dataset.theme = localStorage.getItem('agentsmith-theme') === 'dark' ? 'dark' : 'light'; } catch { document.documentElement.dataset.theme = 'light'; }";
  return <html lang="en" data-theme="light" suppressHydrationWarning><body className={appFontVariables}><script dangerouslySetInnerHTML={{ __html: themeScript }} />{children}</body></html>;
}
