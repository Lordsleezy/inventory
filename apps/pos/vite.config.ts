import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, "../..");

function viteDefine(mode: string): Record<string, string> {
  const fileEnv = {
    ...loadEnv(mode, repo, "VITE_"),
    ...loadEnv(mode, root, "VITE_"),
  };
  const keys = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_FUNCTIONS_URL"] as const;
  const define: Record<string, string> = {};
  for (const key of keys) {
    const value = (process.env[key] || fileEnv[key] || "").trim();
    define[`import.meta.env.${key}`] = JSON.stringify(value);
  }
  return define;
}

export default defineConfig(({ mode }) => ({
  envDir: repo,
  define: viteDefine(mode),
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  resolve: {
    alias: [
      { find: "@floor/cloud", replacement: path.resolve(repo, "packages/cloud/src/index.ts") },
      { find: "@floor/store", replacement: path.resolve(repo, "packages/store/src/index.ts") },
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
  },
}));
