/** @type {import("tailwindcss").Config} */
export default {
  content: ["./src/**/*.{ts,tsx}"],
  corePlugins: {
    preflight: false
  },
  theme: {
    colors: {
        primary: "var(--color-text-primary)",
        secondary: "var(--color-text-secondary)",
        disabled: "var(--color-text-disabled)",
        "icon-primary": "var(--color-icon-primary)",
        "icon-secondary": "var(--color-icon-secondary)",
        "icon-disabled": "var(--color-icon-disabled)",
        body: "var(--color-background-body)",
        surface: "var(--color-background-surface)",
        card: "var(--color-background-card)",
        popover: "var(--color-background-popover)",
        muted: "var(--color-background-muted)",
        accent: "var(--color-accent)",
        "accent-text": "var(--color-text-accent)",
        "accent-bg": "var(--color-accent)",
        "accent-muted": "var(--color-accent-muted)",
        "on-accent": "var(--color-on-accent)",
        success: "var(--color-success)",
        "success-muted": "var(--color-success-muted)",
        "on-success": "var(--color-on-success)",
        error: "var(--color-error)",
        "error-muted": "var(--color-error-muted)",
        "on-error": "var(--color-on-error)",
        warning: "var(--color-warning)",
        "warning-muted": "var(--color-warning-muted)",
        "on-warning": "var(--color-on-warning)",
        border: "var(--color-border)",
        "border-strong": "var(--color-border-emphasized)",
        "overlay-hover": "var(--color-overlay-hover)",
        "overlay-pressed": "var(--color-overlay-pressed)",
        blue: {
          subtle: "var(--color-background-blue)",
          ring: "var(--color-border-blue)",
          vivid: "var(--color-text-blue)"
        },
        cyan: {
          subtle: "var(--color-background-cyan)",
          ring: "var(--color-border-cyan)",
          vivid: "var(--color-text-cyan)"
        },
        gray: {
          subtle: "var(--color-background-gray)",
          ring: "var(--color-border-gray)",
          vivid: "var(--color-text-gray)"
        },
        green: {
          subtle: "var(--color-background-green)",
          ring: "var(--color-border-green)",
          vivid: "var(--color-text-green)"
        },
        orange: {
          subtle: "var(--color-background-orange)",
          ring: "var(--color-border-orange)",
          vivid: "var(--color-text-orange)"
        },
        pink: {
          subtle: "var(--color-background-pink)",
          ring: "var(--color-border-pink)",
          vivid: "var(--color-text-pink)"
        },
        purple: {
          subtle: "var(--color-background-purple)",
          ring: "var(--color-border-purple)",
          vivid: "var(--color-text-purple)"
        },
        red: {
          subtle: "var(--color-background-red)",
          ring: "var(--color-border-red)",
          vivid: "var(--color-text-red)"
        },
        teal: {
          subtle: "var(--color-background-teal)",
          ring: "var(--color-border-teal)",
          vivid: "var(--color-text-teal)"
        },
        yellow: {
          subtle: "var(--color-background-yellow)",
          ring: "var(--color-border-yellow)",
          vivid: "var(--color-text-yellow)"
        }
    },
    borderRadius: {
        none: "var(--radius-none)",
        xs: "var(--radius-inner)",
        sm: "var(--radius-inner)",
        md: "var(--radius-element)",
        lg: "var(--radius-container)",
        xl: "var(--radius-page)",
        full: "var(--radius-full)"
    },
    boxShadow: {
        sm: "var(--shadow-low)",
        md: "var(--shadow-med)",
        lg: "var(--shadow-high)"
    },
    fontFamily: {
        heading: ["var(--font-family-heading)"],
        sans: ["var(--font-family-body)"],
        mono: ["var(--font-family-code)"]
    },
    transitionDuration: {
        "fast-min": "var(--duration-fast-min)",
        fast: "var(--duration-fast)",
        "fast-max": "var(--duration-fast-max)",
        "medium-min": "var(--duration-medium-min)",
        medium: "var(--duration-medium)",
        "medium-max": "var(--duration-medium-max)",
        "slow-min": "var(--duration-slow-min)",
        slow: "var(--duration-slow)",
        "slow-max": "var(--duration-slow-max)"
    }
  },
  plugins: []
};
