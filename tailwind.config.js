/** @type {import("tailwindcss").Config} */
export default {
  darkMode: ["selector", '[data-theme="dark"]'],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "rgb(var(--bg-base) / <alpha-value>)",
        panel: "rgb(var(--bg-sidebar) / <alpha-value>)",
        surface: "rgb(var(--bg-surface) / <alpha-value>)",
        "surface-low": "rgb(var(--bg-surface-low) / <alpha-value>)",
        "surface-high": "rgb(var(--bg-surface-high) / <alpha-value>)",
        hover: "rgb(var(--bg-hover) / <alpha-value>)",
        foreground: "rgb(var(--text-strong) / <alpha-value>)",
        primary: "rgb(var(--text-primary) / <alpha-value>)",
        secondary: "rgb(var(--text-secondary) / <alpha-value>)",
        tertiary: "rgb(var(--text-tertiary) / <alpha-value>)",
        "icon-default": "rgb(var(--icon-default) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
        success: "rgb(var(--success) / <alpha-value>)",
        error: "rgb(var(--error) / <alpha-value>)",
        warning: "rgb(var(--warning) / <alpha-value>)",
        dialog: "rgb(var(--bg-dialog) / <alpha-value>)",
        input: "rgb(var(--bg-input) / <alpha-value>)",
        "border-input": "rgb(var(--border-input) / <alpha-value>)",
        border: "rgb(var(--border) / <alpha-value>)",
        subtle: "rgb(var(--border-subtle) / <alpha-value>)"
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        pill: "var(--radius-pill)"
      },
      boxShadow: {
        ambient: "var(--shadow-ambient)",
        card: "var(--shadow-card)",
        float: "var(--shadow-float)"
      },
      fontFamily: {
        display: ["var(--font-cursor-gothic)", "system-ui", "sans-serif"],
        body: ["var(--font-cursor-gothic)", "system-ui", "sans-serif"],
        serif: ["var(--font-jjannon)", "Georgia", "serif"],
        mono: ["var(--font-berkeley-mono)", "ui-monospace", "monospace"]
      }
    }
  },
  plugins: []
};
