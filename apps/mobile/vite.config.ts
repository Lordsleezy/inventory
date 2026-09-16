import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(root, "../adapter/www");
const repo = path.resolve(root, "../..");

function viteDefine(mode: string): Record<string, string> {
  const fileEnv = {
    ...loadEnv(mode, repo, "VITE_"),
    ...loadEnv(mode, root, "VITE_"),
  };
  const keys = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_FUNCTIONS_URL"] as const;
  const define: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of keys) {
    const value = (process.env[key] || fileEnv[key] || "").trim();
    if (!value) missing.push(key);
    define[`import.meta.env.${key}`] = JSON.stringify(value);
  }
  if (mode === "production" && missing.length) {
    throw new Error(
      `Vite production build missing ${missing.join(", ")}. Set them in the Codemagic appstore group (values are inlined into www/).`,
    );
  }
  return define;
}

export default defineConfig(({ mode }) => ({
  envDir: repo,
  define: viteDefine(mode),
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
      { find: "@floor/cloud", replacement: path.resolve(repo, "packages/cloud/src/index.ts") },
      { find: "@floor/payments", replacement: path.resolve(repo, "packages/payments/src/index.ts") },
      { find: "@floor/channels", replacement: path.resolve(repo, "packages/channels/src/index.ts") },
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
}));
