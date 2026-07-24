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

    "--color-background-body": ["#f6f7f8", "#121416"],
    "--color-background-surface": ["#ffffff", "#202429"],
    "--color-background-card": ["#ffffff", "#202429"],
    "--color-background-popover": ["#ffffff", "#292e34"],
    "--color-background-muted": ["#eef1f3", "#1a1e22"],

    "--color-text-primary": ["#20262c", "#edf1f4"],
    "--color-text-secondary": ["#58636d", "#aeb7be"],
    "--color-text-disabled": ["#88929b", "#747f88"],
    "--color-icon-primary": ["#343c44", "#d9e0e5"],
    "--color-icon-secondary": ["#66727c", "#9ea8b0"],
    "--color-icon-disabled": ["#9aa3aa", "#68737c"],

    "--color-border": ["#d6dce1", "#343a40"],
    "--color-border-emphasized": ["#b9c2c9", "#4b545c"],

    "--color-data-categorical-orange": ["#f47721", "#f47721"],
    "--color-accent": ["#1769aa", "#6bb6ff"],
    "--color-accent-muted": ["#1769aa1f", "#6bb6ff2b"],
    "--color-on-accent": ["#ffffff", "#102131"],
    "--color-text-accent": ["#145b95", "#8bc5ff"],
    "--color-icon-accent": ["#1769aa", "#6bb6ff"],
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
