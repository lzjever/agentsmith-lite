import type { Metadata } from "next";
import { cookies } from "next/headers";
import { appFontVariables } from "./fonts";
import "./globals.css";
import { AppProviders } from "./providers";
import { themeCookieName, themeFromCookie } from "../components/theme/theme";

export const metadata: Metadata = {
  title: "AgentSmith",
  description: "AgentSmith project workspace"
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const initialThemeMode = themeFromCookie(cookieStore.get(themeCookieName)?.value);
  return <html lang="en" data-theme={initialThemeMode}><body className={appFontVariables}><AppProviders initialThemeMode={initialThemeMode}>{children}</AppProviders></body></html>;
}
