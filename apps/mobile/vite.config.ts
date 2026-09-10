import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(root, "../adapter/www");

export default defineConfig({
  plugins: [
    react(),
    {
      name: "floor-api-config",
      closeBundle() {
        const apiUrl = (process.env.FLOOR_API_URL || process.env.VITE_FLOOR_API_URL || "").replace(/\/$/, "");
        mkdirSync(outDir, { recursive: true });
        writeFileSync(path.join(outDir, "config.json"), `${JSON.stringify({ apiUrl }, null, 2)}\n`);
      },
    },
  ],
  base: "./",
  resolve: {
    alias: {
      "@floor/domain": path.resolve(root, "../../packages/domain/src/index.ts"),
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    assetsDir: "assets",
  },
});
