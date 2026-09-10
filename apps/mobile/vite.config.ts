import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(root, "../adapter/www");
const repo = path.resolve(root, "../..");

export default defineConfig({
  plugins: [
    react(),
    {
      // sql.js (browser-only driver) loads this wasm. The phone uses a native
      // SQLite file and never touches this.
      name: "floor-sqlite-wasm",
      buildStart() {
        const dest = path.resolve(root, "public/assets");
        mkdirSync(dest, { recursive: true });
        copyFileSync(
          path.resolve(repo, "node_modules/sql.js/dist/sql-wasm.wasm"),
          path.join(dest, "sql-wasm.wasm"),
        );
      },
    },
  ],
  base: "./",
  resolve: {
    // Longest prefix first: Vite matches these in order.
    alias: [
      {
        find: "@floor/store/capacitor",
        replacement: path.resolve(repo, "packages/store/src/driver-capacitor.ts"),
      },
      { find: "@floor/store", replacement: path.resolve(repo, "packages/store/src/index.ts") },
      {
        find: "sql.js/dist/sql-wasm.js",
        replacement: path.resolve(repo, "node_modules/sql.js/dist/sql-wasm.js"),
      },
    ],
  },
  build: {
    outDir,
    emptyOutDir: true,
    assetsDir: "assets",
    target: "es2020",
  },
  optimizeDeps: {
    include: ["sql.js", "sql.js/dist/sql-wasm.js"],
    needsInterop: ["sql.js", "sql.js/dist/sql-wasm.js"],
  },
});
