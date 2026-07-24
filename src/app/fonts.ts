import localFont from "next/font/local";

export const cursorGothic = localFont({
  src: [
    { path: "./fonts/assets/CursorGothic-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/assets/CursorGothic-Italic.woff2", weight: "400", style: "italic" },
    { path: "./fonts/assets/CursorGothic-Bold.woff2", weight: "700", style: "normal" },
    { path: "./fonts/assets/CursorGothic-BoldItalic.woff2", weight: "700", style: "italic" },
  ],
  variable: "--font-cursor-gothic",
  display: "swap",
});

export const berkeleyMono = localFont({
  src: [
    { path: "./fonts/assets/BerkeleyMono-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/assets/BerkeleyMono-Oblique.woff2", weight: "400", style: "italic" },
  ],
  variable: "--font-berkeley-mono",
  display: "swap",
});

export const appFontVariables = [cursorGothic.variable, berkeleyMono.variable].join(" ");
