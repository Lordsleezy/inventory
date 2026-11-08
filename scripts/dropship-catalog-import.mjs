#!/usr/bin/env node
/**
 * GitHub Actions entry: import one CJ catalog chunk for the configured store.
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CONNECTIONS_KEY, DROPSHIP_STORE_ID.
 */
import { createClient } from "@supabase/supabase-js";

// Ensure server helpers see env before import of catalog-import (which pulls serviceClient).
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log(JSON.stringify({ ok: false, skipped: "missing_supabase_env" }));
  process.exit(0);
}

const storeId = process.env.DROPSHIP_STORE_ID;
if (!storeId) {
  console.log(JSON.stringify({ ok: false, skipped: "missing_DROPSHIP_STORE_ID" }));
  process.exit(0);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: settings } = await sb.from("dropship_settings").select("enabled").eq("store_id", storeId).maybeSingle();
if (!settings?.enabled) {
  console.log(JSON.stringify({ ok: true, skipped: "dropship_off" }));
  process.exit(0);
}

const { data: cred } = await sb
  .from("dropship_supplier_credentials")
  .select("status")
  .eq("store_id", storeId)
  .eq("supplier", "cj")
  .maybeSingle();
if (!cred || !["connected", "disconnected"].includes(cred.status)) {
  // disconnected still ok if api key present — import will auth. waiting_docs / disabled skip.
  if (cred?.status === "disabled" || cred?.status === "waiting_docs") {
    console.log(JSON.stringify({ ok: true, skipped: `cj_${cred.status}` }));
    process.exit(0);
  }
}

const { importCatalogChunk } = await import("../netlify/lib/dropship/catalog-import.mjs");
const maxPages = Math.min(40, Math.max(1, Number(process.env.MAX_PAGES) || 20));
const result = await importCatalogChunk(storeId, "cj", { maxPages, pageSize: 50 });
console.log(JSON.stringify(result));
if (!result.ok) process.exit(1);
