import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        floor: {
          bg: "#0b0b0b",
          panel: "#121212",
          line: "rgba(255,255,255,0.08)",
          text: "#ededed",
          mute: "#8a8a8a",
          accent: "#f5c518",
          danger: "#ff4d4d",
          ok: "#5dcc7a",
        },
      },
      minHeight: {
        touch: "44px",
      },
      minWidth: {
        touch: "44px",
      },
      fontSize: {
        display: ["2.5rem", { lineHeight: "1.1", letterSpacing: "0.06em", fontWeight: "500" }],
        title: ["1.25rem", { lineHeight: "1.35", fontWeight: "400" }],
        body: ["0.9375rem", { lineHeight: "1.45", fontWeight: "400" }],
        quiet: ["0.8125rem", { lineHeight: "1.4", fontWeight: "400" }],
      },
    },
  },
  plugins: [],
};

export default config;
