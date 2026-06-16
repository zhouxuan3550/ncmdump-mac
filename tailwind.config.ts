import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        accent: "rgb(var(--accent) / <alpha-value>)",
        "accent-2": "rgb(var(--accent-2) / <alpha-value>)",
        bad: "rgb(var(--bad) / <alpha-value>)",
        card: "rgb(var(--bg-surface) / <alpha-value>)",
        default: "rgb(var(--border-default) / <alpha-value>)",
        elevated: "rgb(var(--bg-elevated) / <alpha-value>)",
        faint: "rgb(var(--text-faint) / <alpha-value>)",
        good: "rgb(var(--good) / <alpha-value>)",
        ink: "#09090a",
        brand: "#ff1f2f",
        brandSoft: "#341115",
        inverse: "rgb(var(--bg-inverse) / <alpha-value>)",
        muted: "rgb(var(--text-muted) / <alpha-value>)",
        "on-accent": "rgb(var(--text-on-accent) / <alpha-value>)",
        overlay: "rgb(var(--bg-overlay) / <alpha-value>)",
        paper: "#f4f1ed",
        primary: "rgb(var(--text-primary) / <alpha-value>)",
        secondary: "rgb(var(--text-secondary) / <alpha-value>)",
        subtle: "rgb(var(--border-subtle) / <alpha-value>)",
        danger: "#ff6a4f",
        well: "rgb(var(--bg-surface-2) / <alpha-value>)"
      },
      ringColor: {
        accent: "rgb(var(--accent) / 0.28)",
        bad: "rgb(var(--bad) / 0.28)",
        default: "rgb(var(--border-default) / 0.34)",
        good: "rgb(var(--good) / 0.28)",
        subtle: "rgb(var(--border-subtle) / 0.24)"
      },
      boxShadow: {
        soft: "0 24px 70px rgba(0, 0, 0, 0.4)"
      }
    }
  },
  plugins: []
};

export default config;
