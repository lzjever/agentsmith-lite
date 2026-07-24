import type { Metadata } from "next";
import { cookies } from "next/headers";
import { appFontVariables } from "./fonts";
import "./globals.css";
import { AppProviders } from "./providers";
import { parseThemeMode, themeCookieName, themeHtmlAttributes } from "../components/theme/theme";

export const metadata: Metadata = {
  title: "AgentSmith",
  description: "AgentSmith project workspace"
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const initialThemeMode = parseThemeMode(cookieStore.get(themeCookieName)?.value);
  return <html lang="en" className={appFontVariables} {...themeHtmlAttributes(initialThemeMode)}><body><AppProviders initialThemeMode={initialThemeMode}>{children}</AppProviders></body></html>;
}
