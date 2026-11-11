/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./web/index.html", "./web/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: "#0d0e11", raised: "#131519", panel: "#16181d", hover: "#1c1f26", active: "#232730" },
        line: { DEFAULT: "#23262e", strong: "#30343f" },
        ink: { DEFAULT: "#e6e8ec", muted: "#9aa1ad", faint: "#6b7280", ghost: "#4b5160" },
        accent: { DEFAULT: "#7c8cff", soft: "#7c8cff22", strong: "#98a4ff" },
        ok: "#4ade80",
        warn: "#f5b94a",
        bad: "#f87171",
        info: "#60a5fa",
        wait: "#c084fc",
      },
      fontFamily: {
        sans: ['"Inter"', '"Segoe UI Variable Text"', '"Segoe UI"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', '"Cascadia Code"', '"Cascadia Mono"', "Consolas", "monospace"],
      },
      fontSize: {
        "2xs": ["10.5px", "14px"],
        xs: ["11.5px", "16px"],
        sm: ["12.5px", "18px"],
        base: ["13.5px", "20px"],
      },
    },
  },
  plugins: [],
};
