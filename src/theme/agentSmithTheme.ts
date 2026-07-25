import { defineSyntaxTheme, defineTheme } from "@astryxdesign/core/theme";
import { neutralIconRegistry, neutralTheme } from "@astryxdesign/theme-neutral";

const agentSmithSyntax = defineSyntaxTheme({
  name: "agent-smith-syntax",
  tokens: {
    keyword: ["#6d28d9", "#c4b5fd"],
    string: ["#166534", "#86efac"],
    comment: ["#64748b", "#94a3b8"],
    number: ["#9a3412", "#fdba74"],
    function: ["#1d4ed8", "#93c5fd"],
    type: ["#0f766e", "#5eead4"],
    variable: ["#20262c", "#edf1f4"],
    operator: ["#475569", "#cbd5e1"],
    constant: ["#be123c", "#fda4af"],
    tag: ["#be123c", "#fda4af"],
    attribute: ["#7c2d12", "#fdba74"],
    property: ["#0f766e", "#5eead4"],
    punctuation: ["#64748b", "#94a3b8"],
    background: ["#f8fafc", "#171a1d"],
  },
});

export const agentSmithTheme = defineTheme({
  name: "agent-smith",
  extends: neutralTheme,
  icons: neutralIconRegistry,
  typography: {
    scale: { base: 15, ratio: 1.2 },
    body: {
      family: "var(--font-cursor-gothic)",
      fallbacks: "system-ui, sans-serif",
      weight: "normal",
    },
    heading: {
      family: "var(--font-cursor-gothic)",
      fallbacks: "system-ui, sans-serif",
      weight: "normal",
    },
    code: {
      family: "var(--font-berkeley-mono)",
      fallbacks: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      weight: "normal",
    },
  },
  motion: {
    fast: 120,
    medium: 240,
    ratio: 0.75,
  },
  syntax: agentSmithSyntax,
  tokens: {
    "--text-body-leading": "1.5333",
    "--text-code-size": "13px",
    "--text-code-leading": "20px",

    "--radius-none": "0px",
    "--radius-inner": "4px",
    "--radius-element": "6px",
    "--radius-container": "8px",
    "--radius-page": "8px",
    "--radius-chat": "8px",

    "--color-background-body": ["#f2f4f5", "#111315"],
    "--color-background-surface": ["#f8fafb", "#181b1e"],
    "--color-background-card": ["#ffffff", "#1e2226"],
    "--color-background-popover": ["#ffffff", "#252a2f"],
    "--color-background-muted": ["#e9edf0", "#16191c"],

    "--color-text-primary": ["#20262c", "#f0f3f5"],
    "--color-text-secondary": ["#58636d", "#b0b9c0"],
    "--color-text-disabled": ["#87919a", "#727d86"],
    "--color-icon-primary": ["#343c44", "#dce2e6"],
    "--color-icon-secondary": ["#66727c", "#a3adb5"],
    "--color-icon-disabled": ["#99a2aa", "#68737c"],

    "--color-border": ["#d5dce1", "#343a40"],
    "--color-border-emphasized": ["#7d8992", "#737e87"],

    "--color-data-categorical-orange": ["#f47721", "#f47721"],
    "--color-accent": ["#1769aa", "#78bdff"],
    "--color-accent-muted": ["#1769aa1f", "#78bdff29"],
    "--color-on-accent": ["#ffffff", "#102131"],
    "--color-text-accent": ["#145b95", "#94ccff"],
    "--color-icon-accent": ["#1769aa", "#78bdff"],

    "--color-neutral": ["#20262c0f", "#ffffff17"],
    "--color-overlay-hover": ["#20262c0d", "#ffffff0d"],
    "--color-overlay-pressed": ["#20262c1a", "#ffffff1a"],

    "--color-success": ["#176527", "#9ddb9a"],
    "--color-success-muted": ["#d9edda", "#84c9802e"],
    "--color-warning": ["#725700", "#f4cf62"],
    "--color-warning-muted": ["#f6e7bd", "#deb4332e"],
    "--color-error": ["#a32632", "#ffb2ad"],
    "--color-error-muted": ["#f5d8d6", "#ff7e752e"],
  },
  components: {
    dialog: {
      base: {
        animationName: "none",
      },
    },
    button: {
      "variant:primary": {
        backgroundColor: "var(--color-data-categorical-orange)",
        backgroundImage: "none",
        color: "var(--color-on-light)",
        ":hover": {
          backgroundColor: "var(--color-data-categorical-orange)",
          boxShadow: "inset 0 0 0 2px var(--color-on-light)",
        },
        ":active": {
          backgroundColor: "var(--color-data-categorical-orange)",
          boxShadow: "inset 0 0 0 3px var(--color-on-light)",
        },
        ":focus-visible": {
          outline: "2px solid var(--color-accent)",
          outlineOffset: "3px",
        },
        ":where(:disabled, [aria-disabled=\"true\"])": {
          backgroundColor: "var(--color-background-muted)",
          color: "var(--color-text-disabled)",
          boxShadow: "none",
          opacity: "1",
        },
      },
    },
  },
});
