/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_FUNCTIONS_URL: string;
  readonly VITE_EBAY_ENV?: string;
  readonly VITE_FLOOR_FLAVOR?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "sql.js/dist/sql-wasm.js" {
  export { default } from "sql.js";
  export * from "sql.js";
}
