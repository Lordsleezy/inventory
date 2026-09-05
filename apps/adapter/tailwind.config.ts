import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        floor: {
          bg: "#101010",
          panel: "#1a1a1a",
          line: "#3a3a3a",
          text: "#f4f0e6",
          mute: "#b7b09f",
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
    },
  },
  plugins: [],
};

export default config;
