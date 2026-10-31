#!/usr/bin/env node
/**
 * One-time ledger repair after renumbering migrations that shipped 2026-10-31
 * but were mistakenly versioned 2026120512xxxx. New keys sit after
 * 20261126121000_stocked_sku_foundation so fresh replay order matches intent.
 *
 *   node scripts/repair-oct31-migration-version-keys.mjs
 */
import { spawnSync } from "node:child_process";
import { PROJECT_REF } from "./release/sites.mjs";

const RENAMES = [
  ["20261205120000", "20261126122000"],
  ["20261205130000", "20261126123000"],
  ["20261205140000", "20261126124000"],
  ["20261205150000", "20261126125000"],
];

function run(args) {
  const result = spawnSync("npx", ["supabase", ...args], { encoding: "utf8", shell: true });
  const out = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status !== 0) {
    throw new Error(`supabase ${args.join(" ")} failed:\n${out}`);
  }
  return out;
}

for (const [oldV, newV] of RENAMES) {
  console.log(`repair ${oldV} -> reverted`);
  run(["migration", "repair", oldV, "--status", "reverted", "--project-ref", PROJECT_REF]);
  console.log(`repair ${newV} -> applied`);
  run(["migration", "repair", newV, "--status", "applied", "--project-ref", PROJECT_REF]);
}
console.log("done — apply 20261205161000_delete_unit_listing_guard on next release");
